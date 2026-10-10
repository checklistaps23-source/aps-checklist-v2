import { useState, useEffect, useRef, useContext, createContext } from "react";
import { dbChecklists } from "./firebase";
import { dbDispatch } from "./firebaseDispatch";
import { doc, onSnapshot, setDoc, getDoc, getDocs, deleteDoc, collection, writeBatch, query, where } from "firebase/firestore";
import emailjs from "@emailjs/browser";

// ═══════════════════════════════════════════════════════════════
// A.P.S. CHECKLIST — app séparée de DispatchAI
// Toutes les données sont dans des collections "stockapp_*" (projet
// Firebase check-list-peremption), indépendantes de DispatchAI.
// ═══════════════════════════════════════════════════════════════

// Hook réglages : un document Firestore par clé (stockapp_settings/<clé>),
// synchronisé en temps réel entre tous les appareils.
function useSettings(key, initialValue) {
  const [value, setValue] = useState(initialValue);
  const firstSnapshot = useRef(true);
  useEffect(() => {
    const ref = doc(dbChecklists, "stockapp_settings", key);
    const unsub = onSnapshot(ref, (snap) => {
      if (snap.exists()) {
        setValue(snap.data().data);
      } else if (firstSnapshot.current) {
        setDoc(ref, { data: sanitizeUndefined(initialValue) }).catch(()=>{});
      }
      firstSnapshot.current = false;
    }, (err)=>{ console.error("Firestore sync error ("+key+"):", err); });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const update = (newValOrFn) => {
    setValue(prev => {
      const next = typeof newValOrFn === "function" ? newValOrFn(prev) : newValOrFn;
      setDoc(doc(dbChecklists, "stockapp_settings", key), { data: sanitizeUndefined(next) }).catch((err)=>console.error("Firestore write error ("+key+"):", err));
      return next;
    });
  };
  return [value, update];
}

function getStoredThemeMode(){
  try{ return localStorage.getItem("aps_checklist_theme")||"dark"; }catch(e){ return "dark"; }
}

function sanitizeUndefined(obj) {
  if (obj === undefined) return null;
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeUndefined);
  const clean = {};
  for (const k in obj) clean[k] = sanitizeUndefined(obj[k]);
  return clean;
}

function useChecklistDoc(docId, initialValue) {
  const [value, setValue] = useState(initialValue);
  const [loaded, setLoaded] = useState(false);
  const firstSnapshot = useRef(true);

  useEffect(() => {
    setLoaded(false);
    const ref = doc(dbChecklists, "stockapp_checklists", docId);
    const unsub = onSnapshot(ref, (snap) => {
      if (snap.exists()) {
        setValue({ ...initialValue, ...snap.data() });
      } else if (firstSnapshot.current) {
        setValue(initialValue);
      }
      firstSnapshot.current = false;
      setLoaded(true);
    }, (err)=>{ console.error("Firestore checklist sync error ("+docId+"):", err); setLoaded(true); });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const update = (patch) => {
    setValue(prev => {
      const next = { ...prev, ...(typeof patch === "function" ? patch(prev) : patch) };
      setDoc(doc(dbChecklists, "stockapp_checklists", docId), sanitizeUndefined(next), { merge: true }).catch((err)=>console.error("Firestore checklist write error ("+docId+"):", err));
      return next;
    });
  };

  return [value, update, loaded];
}

const MOIS_FR=["Janvier","Février","Mars","Avril","Mai","Juin","Juillet","Août","Septembre","Octobre","Novembre","Décembre"];

const CK_DARK = {
  bg:"#0b1120",panel:"#111827",panel2:"#1a2540",border:"#1f2f4a",
  accent:"#f97316",accentSoft:"rgba(249,115,22,0.1)",
  text:"#f0f4ff",muted:"#4d6a8a",
  success:"#22c55e",successSoft:"rgba(34,197,94,0.12)",
  danger:"#ef4444",dangerSoft:"rgba(239,68,68,0.1)",
  warning:"#f59e0b",blue:"#38bdf8",
  red:"#dc2626",darkBlue:"#1d4ed8",
};
const CK_LIGHT = {
  bg:"#f5f7fb",panel:"#ffffff",panel2:"#f0f3f9",border:"#dbe3f0",
  accent:"#f97316",accentSoft:"rgba(249,115,22,0.10)",
  text:"#101828",muted:"#8a96ab",
  success:"#16a34a",successSoft:"rgba(22,163,74,0.10)",
  danger:"#dc2626",dangerSoft:"rgba(220,38,38,0.08)",
  warning:"#d97706",blue:"#0284c7",
  red:"#dc2626",darkBlue:"#0284c7",
};
const CK_C = { ...CK_DARK };
function applyCkThemeMode(mode){ Object.assign(CK_C, mode==="light"?CK_LIGHT:CK_DARK); }
applyCkThemeMode(getStoredThemeMode());

const CK_GS=`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap'); *{box-sizing:border-box;} button{cursor:pointer;font-family:inherit;} input,textarea{font-family:inherit;} input::placeholder{color:#4d6a8a;}`;

// ═══════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════
const TPMR_VSL_VEHICLES=["TPMR 1","TPMR 2","TPMR 3","TPMR 4","TPMR 5","TPMR 6","TPMR 7","TPMR 8","VSL 1","VSL 2"];

// Clé mensuelle (la checklist se fait une fois par mois, reset automatique).
function getChecklistMonthKey(){
  const d=new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}
// Statut mensuel (envoyée / complète / en cours / pas commencée) d'un groupe de checklists.
function useChecklistsMonthStatus(checklistsData){
  const monthKey=getChecklistMonthKey();
  const vehicleNames=Object.keys(checklistsData);
  const [statuses,setStatuses]=useState({});
  useEffect(()=>{
    const unsubs=vehicleNames.map(name=>{
      const ref=doc(dbChecklists,"stockapp_checklists",`${name}_${monthKey}`);
      return onSnapshot(ref, snap=>{
        const checks=snap.exists()?(snap.data().checks||{}):{};
        const sent=snap.exists()&&!!snap.data().submittedAt; // envoyée au responsable
        setStatuses(prev=>({...prev, [name]: { ...checklistStatus(checklistsData, name, checks), sent }}));
      }, ()=>{});
    });
    return ()=>unsubs.forEach(u=>u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey, JSON.stringify(vehicleNames)]);
  return statuses;
}
// Boutons d'en-tête communs
function TopButton({ onClick, children, title }){
  return <button onClick={onClick} title={title} style={{background:CK_C.panel2,border:`1px solid ${CK_C.border}`,borderRadius:8,color:CK_C.muted,padding:"6px 11px",fontSize:12,fontWeight:700,cursor:"pointer"}}>{children}</button>;
}
// Barre du haut : retour, titre, puis clair/sombre + Paramètres + Historique
function TopBar({ title, subtitle, onBack, themeMode, toggleTheme, onBureau, onSettings, onHistory }){
  return(
    <div style={{ background:CK_C.panel, borderBottom:`1px solid ${CK_C.border}`, padding:"12px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10, position:"sticky", top:0, zIndex:20 }}>
      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
        {onBack&&<button onClick={onBack} style={{ background:"transparent", border:`1px solid ${CK_C.border}`, borderRadius:8, color:CK_C.muted, padding:"6px 12px", fontSize:14, cursor:"pointer" }}>←</button>}
        <div>
          <div style={{ fontWeight:800, fontSize:16 }}>{title}</div>
          {subtitle&&<div style={{ fontSize:10, color:CK_C.muted, textTransform:"uppercase", letterSpacing:"1px" }}>{subtitle}</div>}
        </div>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
        <TopButton onClick={toggleTheme} title="Clair / sombre">{themeMode==="light"?"🌙":"☀️"}</TopButton>
        {onBureau&&<TopButton onClick={onBureau} title="Bureau">🏢 Bureau</TopButton>}
        {onSettings&&<TopButton onClick={onSettings} title="Paramètres">⚙️ Paramètres</TopButton>}
        {onHistory&&<TopButton onClick={onHistory} title="Historique">📅 Historique</TopButton>}
      </div>
    </div>
  );
}
function Page({ children }){
  return <div style={{ minHeight:"100vh", background:CK_C.bg, fontFamily:"'DM Sans',sans-serif", color:CK_C.text, display:"flex", flexDirection:"column" }}><style>{CK_GS}</style>{children}</div>;
}
function Badge({ n, color }){
  if(!n) return null;
  return <span style={{ background:color||CK_C.danger, color:"white", borderRadius:20, padding:"2px 8px", fontSize:11, fontWeight:800 }}>{n}</span>;
}

// Noms récemment utilisés sur cet appareil (suggestions rapides — le nom reste
// OBLIGATOIRE à chaque mouvement, jamais pré-rempli).
const RECENT_NAMES_KEY="aps_ck_recent_names";
function getRecentNames(){
  try{ return JSON.parse(localStorage.getItem(RECENT_NAMES_KEY)||"[]"); }catch(e){ return []; }
}
function rememberName(name){
  try{
    const n=name.trim();
    const list=[n,...getRecentNames().filter(x=>x.toLowerCase()!==n.toLowerCase())].slice(0,8);
    localStorage.setItem(RECENT_NAMES_KEY,JSON.stringify(list));
  }catch(e){}
}
function NameField({ value, onChange, label }){
  const recents=getRecentNames();
  const ok=value.trim().length>0;
  return(
    <div style={{ marginBottom:12 }}>
      <div style={{ fontSize:10, color:CK_C.muted, marginBottom:5, textTransform:"uppercase", fontWeight:700 }}>{label||"Ton nom"}*</div>
      <input value={value} onChange={e=>onChange(e.target.value)} placeholder="Nom (obligatoire)" style={{ width:"100%", background:CK_C.bg, border:`1px solid ${ok?CK_C.border:CK_C.danger}`, borderRadius:8, padding:"10px 12px", color:CK_C.text, fontSize:14 }}/>
      {recents.length>0&&(
        <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:8 }}>
          {recents.map(n=>(<button key={n} onClick={()=>onChange(n)} style={{ background:value===n?CK_C.accentSoft:"transparent", border:`1px solid ${value===n?CK_C.accent:CK_C.border}`, borderRadius:20, color:value===n?CK_C.accent:CK_C.muted, padding:"4px 10px", fontSize:11, fontWeight:600 }}>{n}</button>))}
        </div>
      )}
    </div>
  );
}

const O2_SIZES=["B2","B5","B10"];
const O2_EMPTY_RESERVE={ pleines:{B2:0,B5:0,B10:0}, vides:{B2:0,B5:0,B10:0} };

// ═══════════════════════════════════════════════════════════════
// STOCK PAR VÉHICULE — lots (quantité + date de péremption éventuelle),
// entrées / sorties, seuils minimum, journal des mouvements.
// Un document par véhicule + article : stockapp_stock/<clé>
//   { vehicle, itemName, lots:[{id,quantite,date}], min, alertSentForDate }
// Un article sans péremption a un seul lot sans date (date:"").
// ═══════════════════════════════════════════════════════════════
const STOCK_COL="stockapp_stock";
const MOVES_COL="stockapp_mouvements";

function peremptionKey(vehicle,itemName){ return (vehicle+"__"+itemName).replace(/[^a-zA-Z0-9_]/g,"_"); }
function sortLots(lots){ return [...(lots||[])].sort((a,b)=>(a.date||"9999-99").localeCompare(b.date||"9999-99")); }
// Date de péremption la plus proche (seulement parmi les lots datés).
function getSoonestDate(lots){ const s=sortLots((lots||[]).filter(l=>l.date)); return s.length?s[0].date:""; }
function lotsTotal(lots){ return (lots||[]).reduce((sum,l)=>sum+(l.quantite||0),0); }

// Une seule écoute Firestore partagée par tous les écrans.
const StockContext=createContext({});
function StockProvider({ children }){
  const [map,setMap]=useState({});
  useEffect(()=>{
    const unsub=onSnapshot(collection(dbChecklists,STOCK_COL), snap=>{
      const next={};
      snap.forEach(d=>{ next[d.id]=d.data(); });
      setMap(next);
    }, err=>console.error("Erreur lecture stock:", err));
    return ()=>unsub();
  },[]);
  return <StockContext.Provider value={map}>{children}</StockContext.Provider>;
}
function useStockMap(){ return useContext(StockContext); }
const usePeremptionMap=useStockMap;

// Liste des produits d'un véhicule, reprise des checklists (mêmes articles,
// mêmes quantités requises). Les bouteilles O² (suivies dans "O₂ Réserve")
// et les lignes "OK seul" ne sont pas des produits en stock.
function buildCatalogue(vehicleName, checklists, tpmrTemplate){
  const isTpmr=TPMR_VSL_VEHICLES.includes(vehicleName);
  const sections=isTpmr?((tpmrTemplate&&tpmrTemplate.sections)||[]):(((checklists[vehicleName]||{}).sections)||[]);
  const byName={};
  const list=[];
  const add=(name,q,p,section,shelf)=>{
    if(!name) return;
    if(byName[name]){ byName[name].q+=q; return; }
    const entry={ name, q, p:!!p, section, shelf, key:peremptionKey(vehicleName,name) };
    byName[name]=entry;
    list.push(entry);
  };
  sections.forEach(sec=>(sec.shelves||[]).forEach(sh=>(sh.items||[]).forEach(item=>{
    if(item.okOnly||item.bar) return;
    add(item.n, item.q||1, item.p, sec.label, sh.label);
    if(item.container) (item.subItems||[]).forEach(sub=>{ if(sub.n) add(`${item.n} — ${sub.n}`, sub.q||1, true, sec.label, sh.label); });
  })));
  return list;
}
function allVehicleNames(checklists){
  return [...Object.keys(checklists).sort((a,b)=>a.localeCompare(b)), ...TPMR_VSL_VEHICLES];
}

// Seuil effectif : valeur propre au produit si définie, sinon pourcentage par
// défaut de la quantité requise (réglable dans Paramètres → Seuils).
function effectiveMin(d, q, pct){
  if(d && d.min!=null && d.min!=="") return Number(d.min)||0;
  if(!pct) return 0;
  return Math.ceil(q*pct/100);
}
function isLow(stockMap, entry, pct){
  const d=stockMap[entry.key];
  const m=effectiveMin(d,entry.q,pct);
  return m>0 && lotsTotal(d&&d.lots)<m;
}

function nowFields(){
  const d=new Date();
  return { date:d.toLocaleDateString("fr-FR"), dateISO:d.toISOString(), timestamp:d.getTime() };
}
async function logMovement(m){
  const id=`mv_${Date.now()}_${Math.floor(Math.random()*1000)}`;
  await setDoc(doc(dbChecklists,MOVES_COL,id), sanitizeUndefined({ id, ...nowFields(), ...m }));
}

// Entrée / sortie d'un produit. Sortie : on retire d'abord le lot qui périme
// le plus tôt (FEFO), ou le lot précis demandé (lotId). Le stock ne descend
// jamais sous 0 ; si on demande plus que le stock affiché, l'écart est noté.
async function applyStockMovement({ vehicle, itemName, type, qty, date, by, lotId, minValue, emails }){
  const ref=doc(dbChecklists,STOCK_COL,peremptionKey(vehicle,itemName));
  const snap=await getDoc(ref);
  const cur=snap.exists()?snap.data():{ vehicle, itemName, lots:[] };
  let lots=sortLots(cur.lots).map(l=>({...l}));
  const before=lotsTotal(lots);
  let shortfall=0;
  if(type==="entree"){
    const d=date||"";
    const existing=lots.find(l=>(l.date||"")===d);
    if(existing) existing.quantite=(existing.quantite||0)+qty;
    else lots.push({ id:"lot"+Date.now(), quantite:qty, date:d });
  }else{
    let remaining=qty;
    if(lotId){
      lots=lots.map(l=>{
        if(l.id!==lotId||remaining<=0) return l;
        const take=Math.min(l.quantite||0,remaining);
        remaining-=take;
        return {...l, quantite:(l.quantite||0)-take};
      });
    }else{
      lots=lots.map(l=>{
        if(remaining<=0) return l;
        const take=Math.min(l.quantite||0,remaining);
        remaining-=take;
        return {...l, quantite:(l.quantite||0)-take};
      });
    }
    shortfall=remaining;
    lots=lots.filter(l=>(l.quantite||0)>0);
  }
  const after=lotsTotal(lots);
  await setDoc(ref, sanitizeUndefined({ ...cur, vehicle, itemName, lots }));
  await logMovement({ type, vehicle, itemName, qty, lotDate:date||"", by, stockBefore:before, stockAfter:after, shortfall });
  // Alerte stock bas : uniquement au moment où le seuil est franchi (pas de doublon).
  if(type==="sortie" && minValue>0 && before>=minValue && after<minValue && emails && emails.length>0){
    try{
      for(const to of emails){
        await emailjs.send("service_mrs8v2l","template_2sxsq4j",{
          to_email:to, title:`Alerte stock bas — ${vehicle}`,
          content:`⚠ Stock bas\n\nVéhicule : ${vehicle}\nProduit : ${itemName}\nStock restant : ${after} (seuil minimum : ${minValue})\nDernière sortie par : ${by}`,
        },"Fhdx1kTE7vFmh4z07");
      }
    }catch(e){ console.error("Erreur alerte stock bas:", e); }
  }
  return { before, after, shortfall };
}

// Correction manuelle : remplace la liste des lots d'un produit.
async function applyStockCorrection({ vehicle, itemName, lots, by }){
  const ref=doc(dbChecklists,STOCK_COL,peremptionKey(vehicle,itemName));
  const snap=await getDoc(ref);
  const cur=snap.exists()?snap.data():{ vehicle, itemName, lots:[] };
  const before=lotsTotal(cur.lots);
  const clean=lots.filter(l=>(l.quantite||0)>0).map(l=>({ id:l.id||("lot"+Date.now()+Math.floor(Math.random()*1000)), quantite:l.quantite, date:l.date||"" }));
  const after=lotsTotal(clean);
  await setDoc(ref, sanitizeUndefined({ ...cur, vehicle, itemName, lots:clean }));
  await logMovement({ type:"correction", vehicle, itemName, qty:after-before, by, stockBefore:before, stockAfter:after });
}

async function setStockMin(vehicle, itemName, value){
  const ref=doc(dbChecklists,STOCK_COL,peremptionKey(vehicle,itemName));
  const snap=await getDoc(ref);
  const cur=snap.exists()?snap.data():{ vehicle, itemName, lots:[] };
  await setDoc(ref, sanitizeUndefined({ ...cur, vehicle, itemName, min: value===""||value==null?null:Number(value) }));
}

// Initialisation du stock d'un véhicule : chaque produit sans stock démarre à
// sa quantité standard (celle de la checklist). Les lots déjà présents (ex :
// dates de péremption importées) sont conservés.
async function initVehicleStock(vehicle, catalogue, stockMap, by){
  const batch=writeBatch(dbChecklists);
  let count=0;
  catalogue.forEach(e=>{
    const existing=stockMap[e.key];
    if(existing && lotsTotal(existing.lots)>0) return;
    batch.set(doc(dbChecklists,STOCK_COL,e.key), sanitizeUndefined({ ...(existing||{}), vehicle, itemName:e.name, lots:[{ id:"init"+Date.now()+count, quantite:e.q, date:"" }] }));
    count++;
  });
  await batch.commit();
  await logMovement({ type:"init", vehicle, itemName:`${count} produit(s) initialisé(s)`, qty:count, by });
  return count;
}

async function cleanOldMouvements(){
  try{
    const snap=await getDocs(collection(dbChecklists,MOVES_COL));
    const now=new Date();
    const toDelete=[];
    snap.forEach(d=>{
      const data=d.data();
      const entryDate=new Date(data.dateISO||data.timestamp);
      const monthsDiff=(now.getFullYear()-entryDate.getFullYear())*12+(now.getMonth()-entryDate.getMonth());
      if(monthsDiff>=24) toDelete.push(deleteDoc(doc(dbChecklists,MOVES_COL,d.id)));
    });
    if(toDelete.length>0) await Promise.all(toDelete);
  }catch(e){ console.error("Erreur nettoyage mouvements:", e); }
}

// Après une checklist : le comptage de l'équipage fait foi. Pour chaque produit,
// le stock est ramené à la quantité comptée. Si on a compté moins : on retire la
// différence en commençant par le lot qui périme le plus tôt (les pastilles sont
// sur ces boîtes-là). Si on a compté plus : la différence est ajoutée dans un lot
// "date à renseigner". Chaque correction est notée dans les mouvements.
async function syncStockFromChecklist({ vehicle, counts, by }){
  let changed=0;
  for(const name of Object.keys(counts)){
    const counted=counts[name];
    const ref=doc(dbChecklists,STOCK_COL,peremptionKey(vehicle,name));
    const snap=await getDoc(ref);
    const cur=snap.exists()?snap.data():{ vehicle, itemName:name, lots:[] };
    let lots=sortLots(cur.lots).map(l=>({...l}));
    const before=lotsTotal(lots);
    if(before===counted) continue;
    if(counted<before){
      let remove=before-counted;
      lots=lots.map(l=>{
        if(remove<=0) return l;
        const take=Math.min(l.quantite||0,remove);
        remove-=take;
        return {...l, quantite:(l.quantite||0)-take};
      }).filter(l=>(l.quantite||0)>0);
    }else{
      const add=counted-before;
      const undated=lots.find(l=>!l.date);
      if(undated) undated.quantite=(undated.quantite||0)+add;
      else lots.push({ id:"lot"+Date.now()+Math.floor(Math.random()*1000), quantite:add, date:"" });
    }
    const after=lotsTotal(lots);
    await setDoc(ref, sanitizeUndefined({ ...cur, vehicle, itemName:name, lots }));
    await logMovement({ type:"correction", vehicle, itemName:name, qty:after-before, by:(by||"—")+" (checklist)", stockBefore:before, stockAfter:after });
    changed++;
  }
  return changed;
}

// Sac / armoire scellé : on enregistre la date de péremption saisie pour chaque
// produit daté, sous le nom du sac ("Sac pédiatrique — ALPHA 3"). Ces lots entrent
// ainsi dans l'alerte de péremption (mail groupé) et dans l'écran Péremption.
async function recordSealedExpiry({ label, perish, names }){
  for(const name of names){
    const ref=doc(dbChecklists,STOCK_COL,peremptionKey(label,name));
    const e=perish[name];
    if(e) await setDoc(ref, sanitizeUndefined({ vehicle:label, itemName:name, sealed:true, lots:[{ id:"sl"+Date.now()+Math.floor(Math.random()*1000), quantite:e.q, date:e.date }] }));
    else await deleteDoc(ref);
  }
}

// ═══ CHECKLISTS (données de départ + écrans repris de DispatchAI) ═══
const INIT_CHECKLISTS = {
"ALPHA 1":{edition:"12/2025",norme:"ATNUP",sections:[
{id:1,label:"Soins et oxygénothérapie",color:"#dc2626",shelves:[
{id:"A",label:"Étagère A",items:[{n:"Set de pansement",q:1,p:true},{n:"Rouleau de sparadrap",q:2},{n:"Couverture Isotherme",q:5},{n:"Bandage triangulaire + épingle",q:4},{n:"Esculape",q:1}]},
{id:"B",label:"Étagère B",items:[{n:"Compresse 5x5cm",q:10,p:true},{n:"Compresse 7,5x7,5cm",q:10,p:true},{n:"Compresse 10x10cm",q:10,p:true},{n:"Compresse absorbante 20x10cm",q:5,p:true},{n:"Solution désinfectante Hibidil®",q:10,p:true},{n:"Sérum physiologique unidose",q:10,p:true},{n:"Iso-Bétadine® dermique 10%",q:5,p:true},{n:"Champ stérile 90x70",q:4,p:true},{n:"Kit pansement autocollant",q:1}]},
{id:"C",label:"Étagère C",items:[{n:"Bandage élastique 5 ou 7cm",q:5,p:true},{n:"Bandage élastique 10cm",q:5,p:true},{n:"Bandage élastique 15cm",q:4,p:true},{n:"Cool Pack",q:5}]},
{id:"D",label:"Oxygénothérapie Adulte",items:[{n:"Masque O² 100% Adulte",q:1,p:true},{n:"Lunette O² Adulte",q:2,p:true},{n:"Masque aérosol Adulte",q:1,p:true},{n:"Tubulure + Raccord Biconique",q:1,p:true}]},
{id:"E",label:"Oxygénothérapie Enfant",items:[{n:"Masque O² 100% Enfant",q:1,p:true},{n:"Lunette O² Enfant",q:2,p:true},{n:"Masque aérosol Enfant",q:1,p:true}]},
{id:"F",label:"Aspiration",items:[{n:"Sac récupérateur de mucosité",q:1},{n:"Tubulure aspirateur de mucosité",q:1},{n:"Bassin réniforme UU",q:10},{n:"Sac vomitoire",q:5}]},
]},
{id:2,label:"Paramétrage",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Tensiomètre manuel",q:1,t:true},{n:"Stéthoscope",q:1,t:true},{n:"Pulsoxymètre filaire",q:1,t:true},{n:"Thermomètre auriculaire",q:1,t:true},{n:"Recharge d'embouts jetable",q:1},{n:"Thermomètre digitale",q:1,t:true},{n:"Glucomètre",q:1,t:true},{n:"Lancettes",q:10},{n:"Tigettes",q:10,p:true},{n:"Compresse 5x5cm",q:2,p:true},{n:"Pile AA / AAA",q:8},{n:"Lampe diagnostique",q:1},{n:"Marqueur indélébile",q:1}]}]},
{id:3,label:"Divers",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Couverture anti feu",q:1}]}]},
{id:4,label:"Eau potable",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Bouteille d'eau potable 50cl",q:6,p:true}]}]},
{id:5,label:"Hygiène — Spray",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Spray désinfectant surface",q:2,p:true}]}]},
{id:7,label:"Hygiène",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Spray désodorisant citron",q:1},{n:"Rouleau sac poubelle ambulance",q:1},{n:"Sac à linge jaune",q:2},{n:"Sac à linge blanc",q:2},{n:"Alèze UU",q:2},{n:"Lange adulte",q:3},{n:"Paquet de lingette désinfectante",q:1,p:true},{n:"Microfibres",q:4}]}]},
{id:8,label:"Ballon REA et canules",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Ballon REA adulte complet UU",q:1,p:true},{n:"Masque pour ballon N°4",q:1,p:true},{n:"Masque pour ballon N°5",q:1,p:true},{n:"Filtre antibactérien ballon REA",q:1,p:true},{n:"Set de 9 canules de T000 à T5",q:1}]}]},
{id:9,label:"RDOH",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Pane",q:1},{n:"Urinal",q:1}]}]},
{id:10,label:"Kits Burning",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Kit Burning",q:1,s:true,p:true}]}]},
{id:11,label:"Kit de protection individuel",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Salopette UU",q:2},{n:"Blouse UU",q:2},{n:"Lunette de protection",q:2},{n:"Charlotte",q:2},{n:"Masque chirurgical",q:5},{n:"Masque KN95/FFP2",q:5}]}]},
{id:12,label:"Kit de rechange brancard",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Kit de linge brancard",q:3}]}]},
{id:13,label:"Cabine sanitaire",color:"#dc2626",shelves:[
{id:"A",label:"Cabine sanitaire",items:[{n:"Brancard avec sangles",q:1},{n:"Toile de glisse",q:1},{n:"Distributeur de papier UU",q:1},{n:"Gel hydroalcoolique",q:2,p:true},{n:"Sonde d'aspiration CH 8",q:3,p:true},{n:"Sonde d'aspiration CH 12",q:3,p:true},{n:"Sonde d'aspiration CH 14",q:3,p:true},{n:"Aspirateur de mucosité",q:1,t:true},{n:"Appareil multi paramétrage",q:1,t:true},{n:"Oxylog",q:1,t:true},{n:"Gant nitrile taille M (boite)",q:1},{n:"Gant nitrile taille L (boite)",q:1},{n:"Gant nitrile taille XL (boite)",q:1},{n:"Sac d'Intervention",q:1,s:true,p:true},{n:"DEA + Electrode",q:1,t:true,p:true},{n:"Electrode de réserve",q:1,p:true},{n:"Collier cervical adulte",q:1},{n:"Collier cervical pédiatrique",q:1}]},
{id:"B",label:"Cabine sanitaire suite",items:[{n:"Bouteille O² 2L",q:1,bar:true},{n:"Extincteur 6Kg",q:1,p:true},{n:"Planche Rollboard",q:1},{n:"Tarif TMS",q:1},{n:"Tablette support monitoring",q:1}]},
]},
{id:14,label:"Porte Extérieur — Traumatologie",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Matelas à dépression",q:1,t:true},{n:"Pompe pour matelas",q:1},{n:"Scoop",q:1,t:true},{n:"Planche d'Olivier",q:1},{n:"Chaise d'évacuation",q:1,t:true},{n:"KED",q:1},{n:"Head block complet",q:1},{n:"Sac d'atèle",q:1},{n:"Atèle grande",q:1,t:true},{n:"Atèle moyenne",q:1,t:true},{n:"Atèle petite",q:1,t:true},{n:"Pompe pour atèle",q:1},{n:"Marche pieds",q:1,t:true},{n:"Bouteille O² 2L",q:1,bar:true},{n:"Bouteille O² 10L",q:1,bar:true},{n:"Bouteille O² 10L (2)",q:1,bar:true}]}]},
{id:15,label:"Cabine chauffeur",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Lampe de pré signalisation",q:2,t:true},{n:"Coupe ceinture / Brise glace",q:1},{n:"Carte ADR",q:1},{n:"Carte Hainaut",q:1}]}]},
]},
"ALPHA 2":{edition:"12/2024",norme:"112/ATNUP",sections:[
{id:1,label:"Soin et Oxygénothérapie",color:"#dc2626",shelves:[
{id:"A",label:"Étagère A",items:[{n:"Compresse 5x5cm",q:10,p:true},{n:"Compresse 7,5x7,5cm",q:10,p:true},{n:"Compresse 10x10cm",q:10,p:true},{n:"Compresse absorbante 20x10cm",q:5,p:true},{n:"Bandage élastique 15cm",q:2,p:true},{n:"Bandage élastique 20cm",q:2,p:true},{n:"Rouleau de sparadrap 2cm",q:2}]},
{id:"B",label:"Étagère B",items:[{n:"Bandage triangulaire + épingle",q:4},{n:"Couverture Isotherme",q:5},{n:"Esculape",q:1},{n:"Kit pansement autocollant",q:1},{n:"Bandage élastique 5 ou 7cm",q:5,p:true},{n:"Bandage élastique 10cm",q:5,p:true},{n:"Champ stérile 90x71",q:4,p:true},{n:"Bande pansement autocollant",q:1}]},
{id:"C",label:"Étagère C",items:[{n:"Set de pansement",q:1,p:true},{n:"Rouleau Urgoderme",q:1},{n:"Bouchon fermeture robinet 3 voies",q:1,p:true},{n:"Solution désinfectante Hibidil®",q:10,p:true},{n:"Sérum physiologique unidose",q:10,p:true},{n:"Bétadine® dermique 10%",q:5,p:true},{n:"Cold Pack",q:5}]},
{id:"D",label:"Oxygénothérapie Adulte",items:[{n:"Masque O² 100% Adulte",q:1,p:true},{n:"Lunette O² Adulte",q:2,p:true},{n:"Masque aérosol Adulte",q:1,p:true},{n:"Tubulure + Raccord Biconique",q:1,p:true}]},
{id:"E",label:"Oxygénothérapie Enfant",items:[{n:"Masque O² 100% Enfant",q:1,p:true},{n:"Lunette O² Enfant",q:2,p:true},{n:"Masque aérosol Enfant",q:1,p:true}]},
{id:"F",label:"Divers",items:[{n:"Bassin réniforme UU",q:10},{n:"Sac vomitoire",q:5},{n:"Sac récupérateur de mucosité",q:1},{n:"Tubulure aspirateur de mucosité",q:1},{n:"Bouteille d'eau potable 50cl",q:6,p:true}]},
]},
{id:2,label:"Oxygénothérapie — Ballons",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Ballon REA adulte complet UU",q:1,p:true},{n:"Filtre antibactérien ballon REA",q:1,p:true},{n:"Set de 9 canules de T000 à T6",q:1}]}]},
{id:3,label:"Electrode DEA + Divers",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Electrode DEA réserve",q:1,p:true}]}]},
{id:4,label:"Kits: Linge brancard / Padding",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Kit de linge brancard",q:3},{n:"Kit Padding",q:1},{n:"Oreiller de réserve (lavable)",q:1}]}]},
{id:5,label:"Pochette paramétrage",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Tensiomètre manuel",q:1,t:true},{n:"Stéthoscope",q:1,t:true},{n:"Pulsoxymètre filaire",q:1,t:true},{n:"Thermomètre auriculaire",q:1,t:true},{n:"Recharge d'embouts jetable",q:1},{n:"Thermomètre digitale",q:1,t:true},{n:"Glucomètre",q:1,t:true},{n:"Lancette",q:10},{n:"Tigette",q:10,p:true},{n:"Compresse 5x5cm",q:2,p:true},{n:"Pile AA / AAA",q:8},{n:"Lampe diagnostique",q:1},{n:"Marqueur indélébile",q:1},{n:"Détecteur CO",q:1,p:true}]}]},
{id:9,label:"Kits: Burning",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Kit Burning",q:1,s:true,p:true}]}]},
{id:10,label:"Set de perfusions",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Poche Sérum Physiologique 500ml",q:4,p:true},{n:"Trousse à perfusion",q:2,p:true},{n:"Cathéter 16G",q:2,p:true},{n:"Cathéter 18G",q:2,p:true},{n:"Cathéter 20G",q:2,p:true},{n:"Cathéter 22G",q:2,p:true},{n:"Tégaderme",q:2,p:true},{n:"Garrot",q:1},{n:"Gants stériles 6,5",q:2,p:true},{n:"Gants stériles 7,5",q:2,p:true},{n:"Gants stériles 8,5",q:2,p:true}]}]},
{id:13,label:"Hygiène",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Spray désinfectant surface",q:2,p:true},{n:"Spray désodorisant citron",q:1},{n:"Rouleau sac poubelle ambulance",q:1},{n:"Sac à linge blanc",q:2},{n:"Sac à linge jaune",q:2},{n:"Alèze UU",q:3},{n:"Lange adulte",q:3},{n:"Paquet de lingette désinfectante",q:1,p:true},{n:"Microfibres",q:4},{n:"Mouchoir UU (boite)",q:1},{n:"Blouse d'opéré",q:1}]}]},
{id:15,label:"Aspirateur de mucosité",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Aspirateur de mucosité",q:1,t:true}]}]},
{id:16,label:"Sac: KATA et Pédiatrique",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Sac KATA (Rouge)",q:1,s:true,p:true},{n:"Sac Pédia./Accou.(bleu)",q:1,s:true,p:true}]}]},
{id:17,label:"Matelas à dépression",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Matelas à dépression",q:1,t:true},{n:"Pompe pour matelas",q:1}]}]},
{id:18,label:"RDOH / Kit protection / Speed Block",color:"#dc2626",shelves:[
{id:"A",label:"RDOH",items:[{n:"Pane",q:1},{n:"Urinal",q:1}]},
{id:"B",label:"Kit de protection individuelle",items:[{n:"Salopette UU",q:2},{n:"Blouse UU",q:2},{n:"Lunette de protection",q:2},{n:"Charlotte",q:2},{n:"Masque chirurgical",q:5},{n:"Masque KN95 / FFP3",q:5}]},
{id:"C",label:"Kit Speed Block",items:[{n:"Kit Speed Block",q:1}]},
]},
{id:19,label:"Oxygène",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Bouteille O² 10L",q:1,bar:true},{n:"Bouteille O² 10L (2)",q:1,bar:true},{n:"Bouteille O² 2L",q:1,bar:true}]}]},
{id:20,label:"Cabine sanitaire",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Brancard avec sangles",q:1},{n:"Toile de glisse",q:1},{n:"Distributeur de papier UU",q:1},{n:"Gel hydroalcoolique",q:1,p:true},{n:"Sonde d'aspiration CH 6 ou 8",q:3,p:true},{n:"Sonde d'aspiration CH 10 ou 12",q:2,p:true},{n:"Sonde d'aspiration CH 14 ou 16",q:2,p:true},{n:"Appareil multi paramétrage",q:1,t:true},{n:"Tarif ATNUP",q:1},{n:"Couverture anti feu",q:1},{n:"Planche d'Olivier + base Speed Block",q:1},{n:"Collier cervical adulte",q:1},{n:"Collier cervical pédiatrique",q:1},{n:"Gant nitrile taille S (boite)",q:1},{n:"Gant nitrile taille M (boite)",q:1},{n:"Gant nitrile taille L (boite)",q:1},{n:"Gant nitrile taille XL (boite)",q:1},{n:"Container à aiguille",q:1},{n:"Tensiomètre mural",q:1},{n:"Ciseau multifonctions d'urgence",q:1},{n:"Sac Intervention + DEA",q:1,t:true,p:true}]}]},
{id:21,label:"Porte Ext. Arrière — Traumatologie",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Scoop",q:1,t:true},{n:"Chaise d'évacuation",q:1,t:true},{n:"Sac d'atèle",q:1},{n:"Atèle grande",q:1,t:true},{n:"Atèle moyenne",q:1,t:true},{n:"Atèle petite",q:1,t:true},{n:"Pompe (pour atèle)",q:1,t:true},{n:"Bouteille O² 2L",q:1,bar:true},{n:"Sangle araignée",q:1},{n:"KED",q:1,t:true},{n:"Marche pieds",q:1,t:true},{n:"Extincteur 6Kg",q:1,p:true},{n:"Corde semi statique",q:1},{n:"Pelle pliable (US)",q:1},{n:"Gant de sécurité",q:1},{n:"Pied de biche",q:1}]}]},
{id:22,label:"Cabine chauffeur",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Casque",q:2},{n:"Lampe pour casque",q:2,t:true},{n:"Coupe ceinture",q:1},{n:"Brise vitre",q:1},{n:"Carte routière Hainaut",q:1},{n:"Carte ADR",q:1}]}]},
]},
"ALPHA 3":{edition:"07/2025",norme:"112/ATNUP",sections:[
{id:1,label:"Soin et Oxygénothérapie",color:"#dc2626",shelves:[
{id:"A",label:"Étagère A",items:[{n:"Set de pansement",q:1,p:true},{n:"Rouleau de sparadrap",q:2},{n:"Couverture Isotherme",q:5},{n:"Bandage triangulaire + épingle",q:4},{n:"Compresse 5x5cm",q:10,p:true},{n:"Compresse 7,5x7,5cm",q:10,p:true},{n:"Compresse 10x10cm",q:10,p:true},{n:"Compresse absorbante 20x10cm",q:5,p:true},{n:"Bandage élastique 5 ou 7cm",q:5,p:true}]},
{id:"B",label:"Étagère B",items:[{n:"Bandage élastique 10cm",q:5,p:true},{n:"Bandage élastique 15cm ou 20cm",q:5},{n:"Rouleau Urgoderme",q:1},{n:"Solution désinfectante Hibidil®",q:10,p:true},{n:"Sérum physiologique unidose",q:10,p:true},{n:"Iso-Bétadine® dermique 10%",q:5,p:true},{n:"Champ stérile 90x69",q:4,p:true},{n:"Kit pansement autocollant",q:1},{n:"Bande pansement autocollant",q:1}]},
{id:"C",label:"Oxygénothérapie Adulte",items:[{n:"Masque O² 100% Adulte",q:1,p:true},{n:"Lunette O² Adulte",q:2,p:true},{n:"Masque aérosol Adulte",q:1,p:true},{n:"Tubulure + Raccord Biconique",q:1,p:true}]},
{id:"D",label:"Oxygénothérapie Enfant",items:[{n:"Masque O² 100% Enfant",q:1,p:true},{n:"Lunette O² Enfant",q:2,p:true},{n:"Masque aérosol Enfant",q:1,p:true},{n:"Bouchon fermeture robinet 3 voies",q:3,p:true},{n:"Bassin réniforme UU",q:10},{n:"Sac vomitoire",q:5},{n:"Container à aiguille",q:1}]},
{id:"E",label:"Ballons REA",items:[{n:"Ballon REA adulte complet UU",q:1,p:true},{n:"Masque pour ballon N°4",q:1,p:true},{n:"Masque pour ballon N°5",q:1,p:true},{n:"Filtre antibactérien ballon REA",q:1,p:true},{n:"Set de 9 canules de T000 à T5",q:1}]},
{id:"F",label:"Divers",items:[{n:"Sac récupérateur de mucosité",q:1},{n:"Tubulure aspirateur de mucosité",q:1},{n:"Cool Pack",q:5}]},
]},
{id:2,label:"Divers",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Manchette à pression",q:1},{n:"Bouteille d'eau potable 50cl",q:6,p:true}]}]},
{id:3,label:"Pochette paramétrage",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Tensiomètre manuel",q:1,t:true},{n:"Stéthoscope",q:1,t:true},{n:"Pulsoxymètre filaire",q:1,t:true},{n:"Thermomètre auriculaire",q:1,t:true},{n:"Recharge d'embouts jetable",q:1},{n:"Thermomètre digitale",q:1,t:true},{n:"Glucomètre",q:1,t:true},{n:"Lancette",q:10},{n:"Tigettes",q:10,p:true},{n:"Compresse 5x5cm",q:2,p:true},{n:"Pile AA / AAA",q:8},{n:"Lampe diagnostique",q:1},{n:"Marqueur indélébile",q:1},{n:"Détecteur CO",q:1,p:true}]}]},
{id:4,label:"Set de perfusions",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Poche Sérum Physiologique 500ml",q:4,p:true},{n:"Trousse à perfusion",q:2,p:true},{n:"Cathéter 16G",q:2,p:true},{n:"Cathéter 18G",q:2,p:true},{n:"Cathéter 20G",q:2,p:true},{n:"Cathéter 22G",q:2,p:true},{n:"Tégaderme",q:2,p:true},{n:"Garrot",q:1},{n:"Gants stériles 6,5",q:2,p:true},{n:"Gants stériles 7,5",q:2,p:true},{n:"Gants stériles 8,5",q:2,p:true}]}]},
{id:5,label:"Kit de protection individuelle",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Salopette UU",q:2},{n:"Blouse UU",q:2},{n:"Lunette de protection",q:2},{n:"Charlotte",q:2},{n:"Masque chirurgical",q:5},{n:"Masque KN95 / FFP2",q:5}]}]},
{id:6,label:"Kits Burning",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Kit Burning",q:1,s:true,p:true}]}]},
{id:"7-8",label:"Kits: Linge brancard / Padding",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Kit de linge brancard",q:3},{n:"Kit Padding",q:1}]}]},
{id:11,label:"Sac KATA / Oreiller",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Oreiller lavable",q:1},{n:"Sac KATA",q:1,s:true,p:true}]}]},
{id:12,label:"Gant nitrile / Mouchoir UU",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Gant nitrile taille S (boite)",q:1},{n:"Gant nitrile taille M (boite)",q:1},{n:"Gant nitrile taille L (boite)",q:1},{n:"Gant nitrile taille XL (boite)",q:1},{n:"Mouchoir UU (boite)",q:1}]}]},
{id:13,label:"Kit COVID Colliers cervicaux",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Kit COVID",q:1},{n:"Collier cervical adulte",q:1},{n:"Collier cervical pédiatrique",q:1}]}]},
{id:14,label:"Sac Intervention + DEA / Pédiatrique",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Sac d'Intervention",q:1,s:true,p:true},{n:"DEA + Electrode",q:1,t:true,p:true},{n:"Electrode de réserve",q:1,p:true},{n:"Sac Pédiatrique",q:2,s:true,p:true}]}]},
{id:15,label:"Hygiène",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Spray désinfectant surface",q:2,p:true},{n:"Spray désodorisant citron",q:2},{n:"Rouleau sac poubelle ambulance",q:1},{n:"Sac à linge blanc",q:2},{n:"Sac à linge jaune",q:2},{n:"Alèze UU",q:3},{n:"Lange adulte",q:3},{n:"Paquet de lingette désinfectante",q:1,p:true},{n:"Microfibres",q:4}]}]},
{id:16,label:"RDOH",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Pane",q:1},{n:"Urinal",q:1}]}]},
{id:17,label:"Oxygène",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Bouteille O² 10L",q:1,bar:true},{n:"Bouteille O² 10L (2)",q:1,bar:true},{n:"Bouteille O² 2L",q:1,bar:true}]}]},
{id:18,label:"Cabine sanitaire",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Brancard avec sangles",q:1},{n:"Toile de glisse",q:1},{n:"Distributeur de papier UU",q:1},{n:"Gel hydroalcoolique",q:1,p:true},{n:"Sonde d'aspiration CH 8",q:3,p:true},{n:"Sonde d'aspiration CH 12",q:3,p:true},{n:"Sonde d'aspiration CH 14",q:3,p:true},{n:"Aspirateur de mucosité",q:1,t:true},{n:"Appareil multi paramétrage",q:1,t:true},{n:"Tarif TMS",q:1},{n:"Couverture anti feu",q:1}]}]},
{id:19,label:"Porte Ext. — Traumatologie",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Matelas à dépression",q:1,t:true},{n:"Pompe pour matelas",q:1},{n:"Scoop",q:1,t:true},{n:"Planche d'Olivier",q:1},{n:"Chaise d'évacuation",q:1,t:true},{n:"KED",q:1},{n:"Speed block complet",q:1},{n:"Sac d'atèle",q:1},{n:"Atèle grande",q:1,t:true},{n:"Atèle moyenne",q:1,t:true},{n:"Atèle petite",q:1,t:true},{n:"Pompe (pour atèle)",q:1,t:true},{n:"Sangle araignée",q:1},{n:"Marche pieds",q:1,t:true}]}]},
{id:20,label:"Porte Ext. Avant — Matériels divers",color:"#1d4ed8",shelves:[
{id:"A",label:"Planche A",items:[{n:"Corde semi statique",q:1},{n:"Pelle pliable (US)",q:1},{n:"Casque",q:2},{n:"Lampe pour casque",q:2,t:true},{n:"Gant de sécurité",q:1},{n:"Pied de biche",q:1}]},
{id:"C",label:"Planche C + Extincteur",items:[{n:"Extincteur 6Kg",q:1,p:true},{n:"Bouteille O² 2L",q:1,bar:true}]},
]},
{id:"CC",label:"Cabine chauffeur",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Lampe de présignalisation",q:2,t:true},{n:"Coupe ceinture / Brise glace",q:1}]}]},
]},
"ALPHA 4":{edition:"09/2025",norme:"112/ATNUP",sections:[
{id:1,label:"Soin",color:"#dc2626",shelves:[
{id:"A",label:"Étagère A",items:[{n:"Bandage triangulaire + épingle",q:4},{n:"Couverture Isotherme",q:5},{n:"Esculape",q:1},{n:"Rouleau Urgoderme",q:1},{n:"Rouleau de sparadrap 2cm",q:2},{n:"Solution désinfectante Hibidil®",q:10,p:true},{n:"Sérum physiologique unidose",q:10,p:true},{n:"Iso-Bétadine® dermique 10%",q:5,p:true},{n:"Cold Pack",q:5},{n:"Kit pansement autocollant",q:1}]},
{id:"B",label:"Étagère B",items:[{n:"Compresse 10x10cm",q:10,p:true},{n:"Compresse absorbante 20x10cm",q:5,p:true},{n:"Compresse 5x5cm",q:10,p:true},{n:"Compresse 7,5x7,5cm",q:10,p:true},{n:"Bandage élastique 5 ou 7cm",q:5,p:true},{n:"Bandage élastique 10cm",q:5,p:true}]},
{id:"C",label:"Étagère C",items:[{n:"Bandage élastique 15cm",q:2,p:true},{n:"Bandage élastique 20cm",q:2,p:true},{n:"Champ stérile 75x90cm",q:4,p:true}]},
]},
{id:2,label:"Oxygénothérapie",color:"#1d4ed8",shelves:[
{id:"A",label:"Adulte",items:[{n:"Masque O² 100% Adulte",q:1,p:true},{n:"Lunette O² Adulte",q:2,p:true},{n:"Masque aérosol Adulte",q:1,p:true},{n:"Tubulure + Raccord Biconique",q:1,p:true}]},
{id:"B",label:"Enfant",items:[{n:"Masque O² 100% Enfant",q:1,p:true},{n:"Lunette O² Enfant",q:2,p:true},{n:"Masque aérosol Enfant",q:1,p:true}]},
]},
{id:3,label:"BR, Sac vomitoir, Mouchoir UU",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Bassin réniforme UU",q:10},{n:"Sac vomitoire",q:5},{n:"Mouchoir UU (boite)",q:1}]}]},
{id:4,label:"Bouteille eau",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Bouteille d'eau potable 50cl",q:6,p:true}]}]},
{id:5,label:"Kit paramétrage / Kit Burning",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Tensiomètre manuel",q:1,t:true},{n:"Stéthoscope",q:1,t:true},{n:"Pulsoxymètre filaire",q:1,t:true},{n:"Thermomètre auriculaire",q:1,t:true},{n:"Recharge d'embouts jetable",q:1},{n:"Thermomètre digitale",q:1,t:true},{n:"Glucomètre",q:1,t:true},{n:"Lancette",q:10},{n:"Tigette",q:2,p:true},{n:"Compresse 5x5cm",q:2,p:true},{n:"Pile AA / AAA",q:8},{n:"Lampe diagnostique",q:1},{n:"Marqueur indélébile",q:1},{n:"Kit Burning",q:1,s:true,p:true}]}]},
{id:7,label:"Kits Padding / Divers",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Kit Padding",q:1},{n:"Spray désinfectant surface",q:2,p:true},{n:"Oreiller de réserve (lavable)",q:1},{n:"Blouse d'opéré",q:1}]}]},
{id:8,label:"Set de perfusions",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Poche Sérum Physiologique 500ml",q:4,p:true},{n:"Trousse à perfusion",q:2,p:true},{n:"Cathéter 16G",q:2,p:true},{n:"Cathéter 18G",q:2,p:true},{n:"Cathéter 20G",q:2,p:true},{n:"Cathéter 22G",q:2,p:true},{n:"Tégaderme",q:2,p:true},{n:"Garrot",q:1},{n:"Gants stériles 6,5",q:2,p:true},{n:"Gants stériles 7,5",q:2,p:true},{n:"Gants stériles 8,5",q:2,p:true},{n:"Bouchon robinet 3 voies",q:3,p:true}]}]},
{id:9,label:"Kits: Linge brancard / Jeu d'Atèle",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Kit de linge brancard",q:3},{n:"Sac d'atèle",q:1},{n:"Atèle grande",q:1,t:true},{n:"Atèle moyenne",q:1,t:true},{n:"Atèle petite",q:1,t:true},{n:"Pompe (pour atèle)",q:1,t:true}]}]},
{id:10,label:"Hygiène",color:"#dc2626",shelves:[
{id:"A",label:"Étagère A",items:[{n:"Spray désodorisant citron",q:1},{n:"Rouleau sac poubelle ambulance",q:1},{n:"Sac à linge blanc",q:2},{n:"Sac à linge jaune",q:2},{n:"Alèze UU",q:3},{n:"Lange adulte",q:3},{n:"Paquet de lingette désinfectante",q:1,p:true},{n:"Microfibres",q:4}]},
{id:"B",label:"Étagère B",items:[{n:"Ballon REA adulte complet UU",q:1,p:true},{n:"Masque ballon N°4",q:1,p:true},{n:"Masque ballon N°5",q:1,p:true},{n:"Filtre antibactérien ballon REA",q:1,p:true},{n:"Set de 8 canules de T000 à T5",q:1},{n:"Sac récupérateur de mucosité",q:1},{n:"Tubulure aspirateur de mucosité",q:1}]},
]},
{id:11,label:"Kit de protection individuel",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Salopette UU",q:2},{n:"Blouse UU",q:2},{n:"Lunette de protection",q:2},{n:"Charlotte",q:2},{n:"Masque chirurgical",q:5},{n:"Masque KN95 / FFP3",q:5}]}]},
{id:12,label:"Matelas à dépression",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Matelas à dépression",q:1,t:true},{n:"Pompe pour matelas",q:1}]}]},
{id:13,label:"RDOH",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Pane",q:1},{n:"Urinal",q:1}]}]},
{id:14,label:"Sac Intervention",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Sac Intervention",q:1,p:true},{n:"DEA + Electrodes",q:1,t:true,p:true},{n:"Electrodes de réserve",q:1,p:true},{n:"Détecteur CO",q:1,p:true},{n:"Ciseau multifonction d'URGENCE",q:1}]}]},
{id:15,label:"Sac: KATA et Pédiatrique",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Sac KATA (rouge)",q:1,s:true,p:true},{n:"Sac Pédia./Accou.(bleu)",q:1,s:true,p:true}]}]},
{id:16,label:"Scoop",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Scoop + 3 sangles velcro",q:1,t:true}]}]},
{id:17,label:"Porte Ext. Traumatologie / O²",color:"#1d4ed8",shelves:[
{id:"A",label:"Étagère A",items:[{n:"Planche d'Olivier",q:1},{n:"Chaise d'évacuation",q:1,t:true},{n:"Extincteur 6kg",q:1,t:true},{n:"Sangle araignée",q:1},{n:"KED",q:1,t:true}]},
{id:"B",label:"Étagère B",items:[{n:"Corde semi statique",q:1},{n:"Pelle pliable (US)",q:1},{n:"Pied de sécurité",q:1},{n:"Casque",q:2},{n:"Lampe pour casque",q:2,t:true},{n:"Kit Speed Block",q:1,t:true},{n:"Bouteille O² 10L",q:1,bar:true},{n:"Bouteille O² 10L (2)",q:1,bar:true},{n:"Bouteille O² 2L",q:1,bar:true},{n:"Marche pieds",q:1,t:true}]},
]},
{id:18,label:"Cabine sanitaire",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Brancard avec sangles",q:1},{n:"Toile de glisse",q:1},{n:"Distributeur de papier UU",q:1},{n:"Gel hydroalcoolique",q:1,p:true},{n:"Sonde d'aspiration CH 8",q:3,p:true},{n:"Sonde d'aspiration CH 12",q:3,p:true},{n:"Sonde d'aspiration CH 14",q:3,p:true},{n:"Appareil multi paramétrage",q:1,t:true},{n:"Aspirateur de mucosité",q:1,t:true},{n:"Gant nitrile taille S (boite)",q:1},{n:"Gant nitrile taille M (boite)",q:1},{n:"Gant nitrile taille L (boite)",q:1},{n:"Gant nitrile taille XL (boite)",q:1},{n:"Container à aiguille",q:1},{n:"Poubelle",q:1},{n:"Tarif ATNUP",q:1},{n:"Couverture anti feu",q:1},{n:"Bouteille O² 2L",q:1,bar:true}]}]},
{id:19,label:"Cabine chauffeur",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Lampe de présignalisation",q:2,t:true},{n:"Coupe ceinture",q:1},{n:"Brise vitre",q:1},{n:"Carte routière Hainaut",q:1},{n:"Carte ADR",q:1}]}]},
]},
"ALPHA 5":{edition:"09/2025",norme:"112/ATNUP",sections:[
{id:1,label:"Container à aiguille",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Container à aiguille",q:1}]}]},
{id:2,label:"Bouteilles d'eau potable",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Bouteille d'eau potable 50cl",q:6,p:true}]}]},
{id:4,label:"Kits de linge brancard",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Kit de linge brancard",q:3}]}]},
{id:6,label:"Appareil multi paramétrage",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Appareil multi paramétrage",q:1,t:true}]}]},
{id:9,label:"Soin",color:"#1d4ed8",shelves:[{id:"A",label:"Étagère A",items:[{n:"Solution désinfectante Hibidil®",q:10,p:true},{n:"Sérum physiologique unidose",q:10,p:true},{n:"Iso-Bétadine® dermique 10%",q:5,p:true},{n:"Compresse 5x5cm",q:10,p:true},{n:"Compresse 7,5x7,5cm",q:10,p:true},{n:"Compresse 10x10cm",q:10,p:true},{n:"Esculape",q:1},{n:"Rouleau Urgoderme",q:1},{n:"Rouleau de sparadrap 2cm",q:2},{n:"Bandage élastique 5cm",q:5,p:true},{n:"Bandage élastique 7cm",q:5,p:true},{n:"Bandage élastique 10cm",q:5,p:true},{n:"Bandage élastique 15cm",q:4,p:true},{n:"Bandage triangulaire + épingle",q:4},{n:"Couverture Isotherme",q:5},{n:"Sac vomitoir",q:5},{n:"Cold Pack",q:5},{n:"Kit pansement autocollant",q:1},{n:"Compresse absorbante 20x10cm",q:5,p:true},{n:"Champ stérile 40x45cm",q:4,p:true}]}]},
{id:10,label:"Oxygénothérapie / Ballons",color:"#dc2626",shelves:[
{id:"A",label:"Adulte",items:[{n:"Masque O² 100% Adulte",q:1,p:true},{n:"Lunette O² Adulte",q:2,p:true},{n:"Masque aérosol Adulte",q:1,p:true},{n:"Tubulure + Raccord Biconique",q:1,p:true}]},
{id:"B",label:"Enfant",items:[{n:"Masque O² 100% Enfant",q:1,p:true},{n:"Lunette O² Enfant",q:2,p:true},{n:"Masque aérosol Enfant",q:1,p:true}]},
{id:"C",label:"Ballons REA",items:[{n:"Ballon REA adulte complet UU",q:1,p:true},{n:"Masque REA N°4 Rouge",q:1,p:true},{n:"Masque REA N°5 Bleu",q:1,p:true},{n:"Filtre antibactérien ballon REA",q:1,p:true},{n:"Set de 8 canules de T000 à T5",q:1}]},
]},
{id:11,label:"Set de perfusions",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Poche Sérum Physiologique 500ml",q:4,p:true},{n:"Trousse à perfusion",q:2,p:true},{n:"Cathéter 16G",q:2,p:true},{n:"Cathéter 18G",q:2,p:true},{n:"Cathéter 20G",q:2,p:true},{n:"Cathéter 22G",q:2,p:true},{n:"Tégaderme",q:2,p:true},{n:"Garrot",q:1},{n:"Gants stériles 6,5",q:2,p:true},{n:"Gants stériles 7,5",q:2,p:true},{n:"Gants stériles 8,5",q:2,p:true},{n:"Bouchon robinet 3 voies",q:4}]}]},
{id:12,label:"Kit padding",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Kit Padding 3 pièces",q:1}]}]},
{id:13,label:"Divers",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Bassin réniforme UU",q:10},{n:"Sac récupérateur de mucosité",q:1},{n:"Tubulure aspirateur de mucosité",q:1}]}]},
{id:14,label:"Kit d'atèles / Pochette paramétrage",color:"#dc2626",shelves:[
{id:"A",label:"Atèles",items:[{n:"Sac d'attelle + pompe",q:1},{n:"Attelle grande",q:1,t:true},{n:"Attelle moyenne",q:1,t:true},{n:"Attelle petite",q:1,t:true}]},
{id:"B",label:"Paramétrage",items:[{n:"Tensiomètre manuel",q:1,t:true},{n:"Stéthoscope",q:1,t:true},{n:"Pulsoxymètre filaire",q:1,t:true},{n:"Thermomètre auriculaire",q:1,t:true},{n:"Recharge d'embouts jetable",q:1},{n:"Thermomètre digitale",q:1,t:true},{n:"Glucomètre",q:1,t:true},{n:"Lancette",q:5},{n:"Tigette minimum",q:10,p:true},{n:"Compresse 5x5cm",q:2,p:true},{n:"Sérum physiologique unidose",q:1,p:true},{n:"Pile AA / AAA",q:8},{n:"Lampe diagnostique",q:1},{n:"Marqueur indélébile",q:1}]},
]},
{id:16,label:"Hygiène",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Spray désinfectant surface",q:2,p:true},{n:"Paquet de lingette désinfectante",q:1,p:true},{n:"Spray désodorisant citron",q:1},{n:"Rouleau sac poubelle ambulance",q:2},{n:"Sac à linge blanc",q:2},{n:"Sac à linge jaune",q:2},{n:"Alèze UU",q:4},{n:"Lange adulte",q:3},{n:"Microfibres",q:4},{n:"Mouchoir UU (boite)",q:1},{n:"Blouse d'opéré",q:1}]}]},
{id:17,label:"Kit de protection individuel",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Salopette UU",q:2},{n:"Blouse UU",q:2},{n:"Lunette de protection",q:2},{n:"Charlotte",q:2},{n:"Masque chirurgical",q:5},{n:"Masque KN95 / FFP3",q:5}]}]},
{id:18,label:"RDOH",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Pane + 2 sacs récupérateurs UU",q:1},{n:"Urinal + 2 sacs récupérateurs UU",q:1},{n:"Oreiller de réserve (lavable)",q:1}]}]},
{id:19,label:"Cabine sanitaire",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Brancard avec sangles",q:1},{n:"Toile de glisse",q:1},{n:"Distributeur de papier UU",q:1},{n:"Gel hydroalcoolique",q:2,p:true},{n:"Sonde d'aspiration CH 8",q:3,p:true},{n:"Sonde d'aspiration CH 12",q:3,p:true},{n:"Sonde d'aspiration CH 14",q:3,p:true},{n:"Aspirateur de mucosité",q:1,t:true},{n:"Gant nitrile taille S (boite)",q:1},{n:"Gant nitrile taille M (boite)",q:1},{n:"Gant nitrile taille L (boite)",q:1},{n:"Gant nitrile taille XL (boite)",q:1},{n:"Tarif ATNUP",q:1},{n:"Couverture anti feu",q:1},{n:"Brise vitre et coupe ceinture",q:1},{n:"Ciseau multifonction d'URGENCE",q:1},{n:"Sac Intervention",q:1,s:true,p:true},{n:"DEA + Electrodes",q:1,t:true,p:true},{n:"Electrodes de réserve",q:1,p:true},{n:"Détecteur CO",q:1,p:true}]}]},
{id:20,label:"Face arrière portes ouvertes",color:"#1d4ed8",shelves:[
{id:"B",label:"",items:[{n:"Chaise d'évacuation",q:1,t:true}]},
{id:"C",label:"",items:[{n:"Sac Pédia. / Accou. (bleu)",q:1,s:true,p:true}]},
{id:"E",label:"",items:[{n:"Sac KATA (rouge)",q:1,s:true,p:true}]},
{id:"F",label:"",items:[{n:"Bouteille O² 2L",q:1,bar:true},{n:"Bouteille O² 2L (2)",q:1,bar:true}]},
]},
{id:21,label:"Porte Ext. Traumatologie / O²",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Scoop + 3 sangles velcro",q:1},{n:"Planche d'Olivier",q:1},{n:"KED",q:1,t:true},{n:"Matelas à dépression",q:1,t:true},{n:"Pompe pour matelas",q:1,t:true},{n:"Sangle araignée",q:1},{n:"Corde semi statique",q:1},{n:"Pelle pliable (US)",q:1},{n:"Gant de sécurité",q:1},{n:"Pied de biche",q:1},{n:"Kit HEAD Block",q:1},{n:"Bouteille O² 5L",q:1,bar:true},{n:"Bouteille O² 5L (2)",q:1,bar:true},{n:"Extincteur 6Kg",q:1,p:true},{n:"Marche pieds",q:1,t:true},{n:"Planche de transfert Rollbord®",q:1}]}]},
{id:22,label:"Cabine chauffeur",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Casque",q:2},{n:"Lampe pour casque",q:2,t:true},{n:"Lampe de présignalisation",q:2,t:true},{n:"Brise vitre / Coupe ceinture",q:1},{n:"Carte routière Hainaut",q:1},{n:"Carte ADR",q:1}]}]},
]},
"ALPHA 6":{edition:"09/2025",norme:"112/ATNUP",sections:[
{id:2,label:"Soins et Oxygénothérapie",color:"#1d4ed8",shelves:[
{id:"A",label:"Étagère A",items:[{n:"Bandage élastique 5cm",q:5,p:true},{n:"Bandage élastique 7cm",q:5,p:true},{n:"Bandage élastique 10cm",q:5,p:true},{n:"Bandage élastique 15cm",q:5,p:true},{n:"Bandage élastique 20cm",q:2,p:true},{n:"Cold Pack",q:5},{n:"Pansement autocollant",q:1}]},
{id:"B",label:"Étagère B",items:[{n:"Solution désinfectante Hibidil®",q:10,p:true},{n:"Sérum physiologique unidose",q:10,p:true},{n:"Iso-Bétadine® dermique 10%",q:5,p:true},{n:"Compresse 5x5cm",q:10,p:true},{n:"Compresse 7,5x7,5cm",q:10,p:true},{n:"Compresse 10x10cm",q:10,p:true},{n:"Esculape",q:1},{n:"Compresse absorbante 20x10cm",q:5,p:true},{n:"Rouleau Urgoderme",q:1},{n:"Rouleau de sparadrap 2cm",q:2},{n:"Bandage triangulaire + épingle",q:4},{n:"Couverture Isotherme",q:5}]},
{id:"C",label:"Étagère C",items:[{n:"Bassin réniforme UU",q:10},{n:"Sac vomitoire",q:5},{n:"Champ stérile 75x90cm",q:4,p:true}]},
{id:"D",label:"Oxygénothérapie Adulte",items:[{n:"Masque O² 100% Adulte",q:1,p:true},{n:"Lunette O² Adulte",q:2,p:true},{n:"Masque aérosol Adulte",q:1,p:true},{n:"Tubulure + Raccord Biconique",q:1,p:true}]},
{id:"EE",label:"Oxygénothérapie Enfant + Ballons REA",items:[{n:"Masque O² 100% Enfant",q:1,p:true},{n:"Lunette O² Enfant",q:2,p:true},{n:"Masque aérosol Enfant",q:1,p:true},{n:"Ballon REA adulte complet UU",q:1,p:true},{n:"Masque REA N°4 rouge",q:1,p:true},{n:"Masque REA N°5 bleu",q:1,p:true},{n:"Filtre antibactérien ballon REA",q:1,p:true}]},
{id:"F",label:"Étagère F",items:[{n:"Bouteille d'eau potable 50cl",q:6,p:true},{n:"Sac récupérateur de mucosité",q:1},{n:"Tubulure aspirateur de mucosité",q:1}]},
]},
{id:3,label:"Kits de linge brancard / Padding",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Kit de linge brancard",q:3},{n:"Kit Padding 3 pièces",q:1},{n:"Oreiller de réserve (lavable)",q:1}]}]},
{id:4,label:"Kit paramétrage",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Tensiomètre manuel",q:1,t:true},{n:"Stéthoscope",q:1,t:true},{n:"Pulsoxymètre filaire",q:1,t:true},{n:"Thermomètre auriculaire",q:1,t:true},{n:"Recharge d'embouts jetable",q:1},{n:"Thermomètre digitale",q:1,t:true},{n:"Glucomètre",q:1,t:true},{n:"Lancette",q:10},{n:"Tigette",q:10,p:true},{n:"Compresse 5x5cm",q:2,p:true},{n:"Sérum physiologique unidose",q:1,p:true},{n:"Lampe diagnostique",q:1},{n:"Marqueur indélébile",q:1},{n:"Pile AA / AAA",q:8}]}]},
{id:5,label:"Set de perfusions",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Poche Sérum Physiologique 500ml",q:4,p:true},{n:"Trousse à perfusion",q:2,p:true},{n:"Cathéter 16G",q:2,p:true},{n:"Cathéter 18G",q:2,p:true},{n:"Cathéter 20G",q:2,p:true},{n:"Cathéter 22G",q:2,p:true},{n:"Tégaderme",q:2,p:true},{n:"Garrot",q:1},{n:"Gants stériles 6,5 ou S",q:2,p:true},{n:"Gants stériles 7,5 ou M",q:2,p:true},{n:"Gants stériles 8,5 ou L",q:2,p:true},{n:"Bouchon robinet 3 voies",q:3,p:true}]}]},
{id:6,label:"Kit de protection individuelle",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Salopette UU",q:2},{n:"Blouse UU",q:2},{n:"Lunette de protection",q:2},{n:"Charlotte",q:2},{n:"Masque chirurgical",q:5},{n:"Masque KN95 / FFP3",q:5}]}]},
{id:7,label:"Kit Burning",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Kit Burning",q:1,s:true,p:true}]}]},
{id:8,label:"RDOH",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Pane + 2 sacs UU",q:1},{n:"Urinal + 2 sacs UU",q:1}]}]},
{id:9,label:"Hygiène",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Spray désodorisant citron",q:1},{n:"Rouleau sac poubelle ambulance",q:1},{n:"Sac à linge blanc",q:2},{n:"Sac à linge jaune",q:2},{n:"Alèze UU",q:3},{n:"Lange adulte",q:3},{n:"Paquet de lingette désinfectante",q:1,p:true},{n:"Microfibres",q:4},{n:"Spray désinfectant surface",q:2,p:true},{n:"Blouse d'opéré",q:1}]}]},
{id:13,label:"Gant nitrile / Mouchoir UU",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Gant nitrile taille S (boite)",q:1},{n:"Gant nitrile taille M (boite)",q:1},{n:"Gant nitrile taille L (boite)",q:1},{n:"Gant nitrile taille XL (boite)",q:1},{n:"Mouchoir UU (boite)",q:1}]}]},
{id:15,label:"Sac Pédia. / Accou.",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Sac Pédia./Accou.(bleu)",q:1,s:true,p:true}]}]},
{id:16,label:"Sac Intervention + DEA / Sac KATA",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Sac Intervention",q:1,s:true,p:true},{n:"Détecteur CO",q:1,p:true},{n:"DEA + Electrodes",q:1,t:true,p:true},{n:"Electrodes de réserve",q:1,p:true},{n:"Ciseau multifonction d'URGENCE",q:1},{n:"Sac KATA (rouge)",q:1,s:true,p:true},{n:"Bouteille O² 2L",q:1,bar:true}]}]},
{id:17,label:"Cabine sanitaire",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Brancard avec sangles",q:1},{n:"Toile de glisse",q:1},{n:"Distributeur de papier UU",q:1},{n:"Gel hydroalcoolique",q:1,p:true},{n:"Sonde d'aspiration CH 8",q:3,p:true},{n:"Sonde d'aspiration CH 12",q:3,p:true},{n:"Sonde d'aspiration CH 14",q:3,p:true},{n:"Container à aiguille",q:1},{n:"Poubelle",q:1},{n:"Tarif ATNUP",q:1},{n:"Couverture anti feu",q:1},{n:"Appareil multi paramétrage",q:1,t:true},{n:"Aspirateur de mucosité",q:1,t:true}]}]},
{id:19,label:"O² / Extincteur 6Kg",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Bouteille O² 10L",q:1,bar:true},{n:"Bouteille O² 10L (2)",q:1,bar:true},{n:"Bouteille O² 2L",q:1,bar:true},{n:"Extincteur 6Kg",q:1,p:true}]}]},
{id:20,label:"Porte Ext. Traumatologie",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Chaise d'évacuation",q:1,t:true},{n:"Matelas à dépression",q:1,t:true},{n:"Pompe pour matelas",q:1},{n:"KED",q:1},{n:"Sac d'atèle",q:1},{n:"Atèle grande",q:1,t:true},{n:"Atèle moyenne",q:1,t:true},{n:"Atèle petite",q:1,t:true},{n:"Pompe (pour atèle)",q:1,t:true},{n:"Scoop + 3 sangles velcro",q:1,t:true},{n:"Pied de biche",q:1}]}]},
{id:21,label:"Porte arrière",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Planche d'Olivier",q:1}]}]},
{id:22,label:"Cabine chauffeur",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Lampe de présignalisation",q:2,t:true},{n:"Brise vitre / Coupe ceinture",q:1},{n:"Carte routière Hainaut",q:1},{n:"Carte ADR",q:1},{n:"Casque",q:2},{n:"Lampe pour casque F2",q:2,t:true}]}]},
]},
"ALPHA 7":{edition:"Nov/2025",norme:"112/ATNUP",sections:[
{id:1,label:"Oxygénothérapie / Divers",color:"#dc2626",shelves:[
{id:"A",label:"Étagère A — Ballons REA",items:[{n:"Ballon REA adulte complet UU4",q:1},{n:"Masque REA N°5",q:1},{n:"Filtre antibactérien ballon REA",q:1,p:true},{n:"Set de 8 canules de T000 à T5",q:1}]},
{id:"B",label:"Étagère B — Oxygénothérapie Adulte",items:[{n:"Masque O² 100% Adulte",q:1,p:true},{n:"Lunette O² Adulte",q:2,p:true},{n:"Masque aérosol Adulte",q:1,p:true},{n:"Tubulure + Raccord Biconique",q:1,p:true}]},
{id:"C",label:"Étagère C — Eau + Divers",items:[{n:"Bouteille d'eau potable 50cl",q:6,p:true},{n:"Sac récupérateur de mucosité",q:1},{n:"Tubulure aspirateur de mucosité",q:1}]},
{id:"D",label:"Étagère D — Oxygénothérapie Enfant",items:[{n:"Masque O² 100% Enfant",q:1,p:true},{n:"Lunette O² Enfant",q:2,p:true},{n:"Masque aérosol Enfant",q:1,p:true}]},
{id:"E",label:"Divers",items:[{n:"Bassin réniforme UU",q:10},{n:"Sac vomitoire",q:5}]},
]},
{id:2,label:"Soins",color:"#1d4ed8",shelves:[
{id:"A",label:"Étagère A",items:[{n:"Solution désinfectante Hibidil®",q:10,p:true},{n:"Sérum physiologique unidose",q:10,p:true},{n:"Iso-Bétadine® dermique 10%",q:5,p:true},{n:"Compresse 5x5cm",q:10,p:true},{n:"Compresse 7,5x7,5cm",q:10,p:true},{n:"Compresse 10x10cm",q:10,p:true},{n:"Compresse absorbante 20x10cm",q:5,p:true}]},
{id:"B",label:"Étagère B",items:[{n:"Rouleau Urgoderme",q:1},{n:"Rouleau de sparadrap 2cm",q:2},{n:"Kit pansement autocollant",q:1},{n:"Bandage élastique 5cm",q:5,p:true},{n:"Esculape",q:1},{n:"Bandage élastique 7cm",q:5,p:true},{n:"Bandage élastique 10cm",q:5,p:true}]},
{id:"C",label:"Étagère C",items:[{n:"Bandage élastique 15cm",q:2,p:true},{n:"Bandage élastique 20cm",q:2,p:true},{n:"Champ stérile 75x90cm",q:4,p:true}]},
{id:"D",label:"Étagère D",items:[{n:"Bandage triangulaire + épingle",q:4},{n:"Couverture Isotherme",q:5},{n:"Cold Pack",q:5}]},
]},
{id:3,label:"Kits de linge brancard / Padding",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Kit de linge brancard",q:3},{n:"Kit Padding 3 pièces",q:1},{n:"Oreiller de réserve (lavable)",q:1}]}]},
{id:4,label:"Kit paramétrage",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Tensiomètre manuel",q:1,t:true},{n:"Stéthoscope",q:1,t:true},{n:"Pulsoxymètre filaire",q:1,t:true},{n:"Thermomètre auriculaire",q:1,t:true},{n:"Recharge d'embouts jetable",q:1},{n:"Thermomètre digitale",q:1,t:true},{n:"Glucomètre",q:1,t:true},{n:"Lancette",q:10},{n:"Tigette",q:10,p:true},{n:"Compresse 5x5cm",q:2,p:true},{n:"Sérum physiologique unidose",q:1,p:true},{n:"Lampe diagnostique",q:1},{n:"Marqueur indélébile",q:1},{n:"Pile AA / AAA",q:8}]}]},
{id:5,label:"Set de perfusions",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Poche Sérum Physiologique 500ml",q:4,p:true},{n:"Trousse à perfusion",q:2,p:true},{n:"Cathéter 16G",q:2,p:true},{n:"Cathéter 18G",q:2,p:true},{n:"Cathéter 20G",q:2,p:true},{n:"Cathéter 22G",q:2,p:true},{n:"Tégaderme",q:2,p:true},{n:"Garrot",q:1},{n:"Gants stériles 6,5 ou S",q:2,p:true},{n:"Gants stériles 7,5 ou M",q:2,p:true},{n:"Gants stériles 8,5 ou L",q:2,p:true},{n:"Bouchon robinet 3 voies",q:3,p:true}]}]},
{id:8,label:"Sac d'atèles",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Atèle grande",q:1,t:true},{n:"Atèle moyenne",q:1,t:true},{n:"Atèle petite",q:1,t:true},{n:"Pompe (pour atèle)",q:1,t:true}]}]},
{id:9,label:"Hygiène",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Spray désodorisant citron",q:1},{n:"Rouleau sac poubelle ambulance",q:1},{n:"Sac à linge blanc",q:2},{n:"Sac à linge jaune",q:2},{n:"Alèze UU",q:3},{n:"Lange adulte",q:3},{n:"Paquet de lingette désinfectante",q:1,p:true},{n:"Microfibres",q:1},{n:"Mouchoir UU (boite)",q:1},{n:"Blouse d'opéré",q:1},{n:"Spray désinfectant surface",q:2,p:true}]}]},
{id:10,label:"Sacs Pédia. / Accou. / KATA",color:"#1d4ed8",shelves:[
{id:"A",label:"",items:[{n:"Sac KATA (rouge)",q:1,s:true,p:true},{n:"Sac Pédia./Accou.(bleu)",q:1,s:true,p:true}]},
{id:"B",label:"Boite",items:[{n:"Corde semi statique",q:1},{n:"Pelle pliable (US)",q:1},{n:"Gant de sécurité",q:1},{n:"Sangle araignée",q:1}]},
]},
{id:11,label:"Sac Intervention / O²",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Sac Intervention avec DEA",q:1,s:true,p:true},{n:"DEA",q:1,t:true,p:true},{n:"Electrode DEA réserve",q:1,p:true},{n:"Détecteur CO",q:1,p:true},{n:"Ciseau multifonction d'URGENCE",q:1},{n:"Bouteille O² 2L",q:1,bar:true},{n:"Pied de biche",q:1}]}]},
{id:12,label:"Cabine sanitaire",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Brancard avec sangles",q:1},{n:"Toile de glisse",q:1},{n:"Distributeur de papier UU",q:1},{n:"Gel hydroalcoolique",q:1,p:true},{n:"Sonde d'aspiration CH 8",q:3,p:true},{n:"Sonde d'aspiration CH 12",q:3,p:true},{n:"Sonde d'aspiration CH 14",q:3,p:true},{n:"Appareil multi paramétrage",q:1,t:true},{n:"Aspirateur de mucosité",q:1,t:true},{n:"Gant nitrile taille S (boite)",q:1},{n:"Gant nitrile taille M (boite)",q:1},{n:"Gant nitrile taille L (boite)",q:1},{n:"Gant nitrile taille XL (boite)",q:1},{n:"Container à aiguille",q:1},{n:"Poubelle",q:1},{n:"Tarif ATNUP",q:1},{n:"Couverture anti feu",q:1},{n:"Ciseau multifonction d'URGENCE",q:1}]}]},
{id:13,label:"Kit protec. Indiv. / HEAD B-LOCK",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Salopette UU",q:2},{n:"Blouse UU",q:2},{n:"Lunette de protection",q:2},{n:"Charlotte",q:2},{n:"Masque chirurgical",q:5},{n:"Masque KN95 / FFP3",q:5},{n:"HEAD B-LOCK",q:1}]}]},
{id:14,label:"RDOH / Kit Burning",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Pane + 2 sacs UU",q:1},{n:"Urinal + 2 sacs UU",q:1},{n:"Kit Burning",q:1,s:true,p:true}]}]},
{id:15,label:"O²",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Bouteille O² 2L",q:1,bar:true},{n:"Pompe à matelas à dépression",q:1}]}]},
{id:16,label:"Divers",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Matelas à dépression",q:1,t:true}]}]},
{id:17,label:"Porte Ext. Traumatologie",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Planche d'Olivier",q:1},{n:"Chaise d'évacuation",q:1,t:true},{n:"KED",q:1,t:true},{n:"Bouteille O² 5L",q:1,bar:true},{n:"Bouteille O² 5L (2)",q:1,bar:true},{n:"Extincteur 6Kg",q:1,p:true},{n:"Scoop + 3 sangles velcro",q:1,t:true},{n:"Pied de biche",q:1}]}]},
{id:18,label:"Cabine chauffeur",color:"#1d4ed8",shelves:[{id:"A",label:"",items:[{n:"Lampe de présignalisation",q:2,t:true},{n:"Brise vitre / Coupe ceinture",q:1},{n:"Carte routière Hainaut",q:1},{n:"Carte ADR",q:1},{n:"Casque F2",q:2},{n:"Lampe pour casque F2",q:2,t:true}]}]},
{id:20,label:"Couverture",color:"#dc2626",shelves:[{id:"A",label:"",items:[{n:"Couverture",q:0,okOnly:true}]}]},
]},
};

function monthYearLabel(ym){
  if(!ym) return "";
  const [y,m]=ym.split("-");
  const idx=parseInt(m,10)-1;
  return (MOIS_FR[idx]||m)+" "+y;
}
function MonthYearPicker({ value, onChange, danger }){
  const now=new Date();
  const [y,m]=value?value.split("-"):["",""];
  const years=Array.from({length:8},(_,i)=>now.getFullYear()-1+i);
  const months=[["01","Jan"],["02","Fév"],["03","Mar"],["04","Avr"],["05","Mai"],["06","Jun"],["07","Jul"],["08","Aoû"],["09","Sep"],["10","Oct"],["11","Nov"],["12","Déc"]];
  const selStyle={ background:danger?CK_C.dangerSoft:CK_C.bg, border:`1px solid ${danger?CK_C.danger:CK_C.border}`, borderRadius:6, padding:"5px 6px", color:danger?CK_C.danger:CK_C.text, fontSize:11, fontWeight:danger?700:400 };
  return(
    <div style={{ display:"flex", gap:5 }}>
      <select value={m} onChange={e=>onChange(`${y||now.getFullYear()}-${e.target.value}`)} style={selStyle}>
        <option value="">Mois</option>
        {months.map(([mm,lbl])=>(<option key={mm} value={mm}>{lbl}</option>))}
      </select>
      <select value={y} onChange={e=>onChange(`${e.target.value}-${m||String(now.getMonth()+1).padStart(2,"0")}`)} style={selStyle}>
        <option value="">Année</option>
        {years.map(yy=>(<option key={yy} value={yy}>{yy}</option>))}
      </select>
    </div>
  );
}

// ═══════════════════════════════════════
// SAC TPMR/VSL — checklist mensuelle, modèle unique partagé par tous les véhicules TPMR/VSL
// ═══════════════════════════════════════
function ChecklistView({ vehicleName, onBack, checklists, emails, stockInit, sealedTask, onSealedDone, themeMode, toggleTheme }) {
  const data = checklists[vehicleName];
  const weekKey = sealedTask ? sealedTask.id : getChecklistMonthKey();
  const docId = `${vehicleName}_${weekKey}`;
  const [doc_, updateDoc_, loaded] = useChecklistDoc(docId, { checks:{}, amb1:"", amb2:"", semaine:"", remarks:"" });
  const checks = doc_.checks || {};
  const amb1 = doc_.amb1 || "";
  const amb2 = doc_.amb2 || "";
  const semaine = doc_.semaine || monthYearLabel(getChecklistMonthKey());
  const remarks = doc_.remarks || "";
  const [expanded, setExpanded] = useState({ [data.sections[0]?.id]: true });
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const peremptionMap = usePeremptionMap();
  const [stockFixed, setStockFixed] = useState(null);

  // "YYYY-MM" <= mois actuel ? (périmé ou en cours = à considérer comme expiré)
  const isMonthExpired = (ym) => {
    if(!ym) return false;
    const now=new Date();
    const cur=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
    return ym<=cur;
  };

  const gk = (sId, shId, name) => `${sId}__${shId}__${name}`;
  // Présence : si le nombre trouvé < requis, on considère l'article "NOK" et
  // on bascule automatiquement test/scellé sur NOK (impossible à vérifier
  // si l'article n'est pas là).
  const setCF = (key, found, required, item) => updateDoc_(prev=>{
    const isMissing = found!=null && found<required;
    const next = { ...prev.checks?.[key], found, required };
    if(isMissing){
      if(item?.t) next.testOk=false;
      if(item?.s) next.sealOk=false;
    }
    return { checks:{ ...prev.checks, [key]: next } };
  });
  const setC = (key, field, value) => updateDoc_(prev=>({ checks:{ ...prev.checks, [key]:{ ...prev.checks?.[key], [field]:value } } }));
  const setTest = (key, val) => updateDoc_(prev=>({ checks:{ ...prev.checks, [key]:{ ...prev.checks?.[key], testOk:val } } }));
  const setSeal = (key, val) => updateDoc_(prev=>({ checks:{ ...prev.checks, [key]:{ ...prev.checks?.[key], sealOk:val } } }));
  // Date de péremption ou de scellé : si le mois saisi est dépassé/actuel,
  // l'article passe direct en NOK au chiffre max (found=0), modifiable ensuite.
  const setDateField = (key, field, value, item) => updateDoc_(prev=>{
    const next = { ...prev.checks?.[key], [field]: value };
    if(isMonthExpired(value)){ next.found=0; next.required=item.q; }
    return { checks:{ ...prev.checks, [key]: next } };
  });
  const toggle = (id) => setExpanded(p => ({ ...p, [id]: !p[id] }));

  const firstWeek = !!sealedTask; // mensuelle : péremptions via le stock ; sacs scellés : date saisie

  // Nombre de "cases" à valider pour un article : présence (+1), test (+1 si
  // TEST), scellé (+1 si SCELLÉ), péremption (+1 si PÉREMPTION, seulement
  // pendant la 1ère semaine du mois).
  const itemSlots = (item) => {
    if(item.okOnly) return 1;
    let n=1;
    if(item.t) n++;
    if(item.s) n++;
    if(item.p && firstWeek) n++;
    return n;
  };
  const itemCheckedSlots = (item, state) => {
    if(item.okOnly) return state?.found!=null?1:0;
    let n=0;
    if(state?.found!=null) n++;
    if(item.t && state?.testOk!=null) n++;
    if(item.s && state?.sealOk!=null) n++;
    if(item.p && firstWeek && state?.date) n++;
    return n;
  };

  let totalItems=0, checkedItems=0;
  data.sections.forEach(sec=>sec.shelves.forEach(sh=>sh.items.forEach(item=>{
    const key=gk(sec.id,sh.id,item.n);
    const state=checks[key]||{};
    totalItems += itemSlots(item);
    checkedItems += itemCheckedSlots(item,state);
  })));
  const progress = totalItems > 0 ? Math.round((checkedItems / totalItems) * 100) : 0;

  // Toutes les validations requises pour pouvoir envoyer : présence de
  // chaque article, test/scellé (toujours), niveau bar (toujours), date de
  // péremption/scellé (1ère semaine du mois uniquement, et seulement si
  // l'article est bien présent — sinon impossible à vérifier).
  const getMissingValidations = () => {
    const missing = [];
    data.sections.forEach(sec => sec.shelves.forEach(sh => sh.items.forEach(item => {
      if (item.okOnly) return;
      const key = gk(sec.id, sh.id, item.n);
      const state = checks[key] || {};
      if (state.found == null) { missing.push(item.n + " (Présence)"); return; }
      const isMissing = state.found < item.q;
      if (item.t && state.testOk == null) missing.push(item.n + " (Fonctionnel)");
      if (item.s && state.sealOk == null) missing.push(item.n + " (Scellé)");
      if (item.bar && state.bar==null) missing.push(item.n + " (Niveau bar)");
      if (!isMissing) {
        if (item.p && firstWeek && !state.date) missing.push(item.n + " (Date péremption)");
        if (item.s && !item.p && firstWeek && state.sealOk!==false && !state.sealDate) missing.push(item.n + " (Date scellé)");
      }
    })));
    return missing;
  };
  const missingValidations = getMissingValidations();
  const hasAmbulancier = amb1.trim().length>0 || amb2.trim().length>0;
  const canSubmit = missingValidations.length===0 && hasAmbulancier;

  // Fait défiler jusqu'au premier oubli (en dépliant sa section si besoin).
  const scrollToFirstMissing = () => {
    if(!hasAmbulancier){
      const el=document.getElementById("ckitem-ambulancier");
      if(el) el.scrollIntoView({behavior:"smooth", block:"center"});
      return;
    }
    if(missingValidations.length===0) return;
    const firstName = missingValidations[0].split(" (")[0];
    let targetSectionId=null;
    for(const sec of data.sections){
      if(sec.shelves.some(sh=>sh.items.some(it=>it.n===firstName))){ targetSectionId=sec.id; break; }
    }
    if(targetSectionId!==null && !expanded[targetSectionId]) setExpanded(p=>({...p,[targetSectionId]:true}));
    setTimeout(()=>{
      const el=document.getElementById("ckitem-"+firstName.replace(/[^a-zA-Z0-9]/g,"-"));
      if(el) el.scrollIntoView({behavior:"smooth", block:"center"});
    }, targetSectionId!==null?150:0);
  };

  // Liste des problèmes réels (manques, test/scellé NOK) — utilisée pour
  // l'écran récap et pour le contenu de l'email envoyé au responsable.
  const buildIssues = () => {
    const issues=[];
    data.sections.forEach(sec=>sec.shelves.forEach(sh=>sh.items.forEach(item=>{
      const key=gk(sec.id,sh.id,item.n);
      const state=checks[key]||{};
      if(state.found!=null && state.found<item.q){
        const dueToExpiry=(item.p&&isMonthExpired(state.date))||(item.s&&state.sealOk!==false&&isMonthExpired(state.sealDate));
        issues.push({name:item.n, type:"missing", missing:item.q-state.found, required:item.q, expired:dueToExpiry});
      }
      if(item.t && state.testOk===false) issues.push({name:item.n, type:"nok_test"});
      if(item.s && state.sealOk===false) issues.push({name:item.n, type:"nok_seal"});
      if(item.bar && state.bar!=null && state.bar<50) issues.push({name:item.n, type:"low_bar", bar:state.bar});
    })));
    return issues;
  };
  const issues = buildIssues();
  const nokItems = issues.filter(i=>i.type==="missing").map(i=>[i.name,{found:i.required-i.missing,required:i.required}]);

  const sendMissingReport = async () => {
    if(!emails || emails.length===0) return;
    setSending(true);
    let missingLines;
    if(issues.length===0){
      missingLines = "✅ Aucun manque — véhicule complet.";
    }else{
      missingLines = issues.map(iss=>{
        if(iss.type==="missing") return `- ${iss.name} : manque ${iss.missing}/${iss.required}${iss.expired?" (périmé — retiré du véhicule)":""}`;
        if(iss.type==="nok_test") return `- ${iss.name} : test NOK (non fonctionnel)`;
        if(iss.type==="nok_seal") return `- ${iss.name} : scellé NOK (rompu)`;
        if(iss.type==="low_bar") return `- ${iss.name} : niveau bas (${iss.bar} bar, < 50)`;
        return `- ${iss.name}`;
      }).join("\n");
    }
    missingLines = `Rempli par : ${[amb1,amb2].filter(Boolean).join(" / ")||"—"}\n\n` + missingLines;
    if(remarks.trim()) missingLines += `\n\nRemarques : ${remarks.trim()}`;
    try{
      for(const to of emails){
        await emailjs.send("service_mrs8v2l","template_2sxsq4j",{
          to_email: to,
          title: `Checklist ${vehicleName} — Matériel manquant`,
          content: missingLines,
        }, "Fhdx1kTE7vFmh4z07");
      }
    }catch(e){ console.error("Erreur envoi email checklist:", e); }
    setSending(false);
  };

  if (!loaded) return (
    <div style={{ minHeight:"100vh", background:CK_C.bg, display:"flex", alignItems:"center", justifyContent:"center", color:CK_C.muted, fontFamily:"'DM Sans',sans-serif" }}>Chargement…</div>
  );

  if (submitted) return (
    <div style={{ minHeight:"100vh", background:CK_C.bg, fontFamily:"'DM Sans',sans-serif", color:CK_C.text }}>
      <div style={{ background:CK_C.panel, borderBottom:`1px solid ${CK_C.border}`, padding:"14px 18px", display:"flex", alignItems:"center", gap:12 }}>
        <button onClick={onBack} style={{ background:"transparent", border:`1px solid ${CK_C.border}`, borderRadius:8, color:CK_C.muted, padding:"6px 12px", fontSize:14 }}>←</button>
        <div style={{ fontWeight:800, fontSize:16 }}>📋 Rapport {vehicleName}</div>
      </div>
      <div style={{ padding:"20px", maxWidth:560, margin:"0 auto" }}>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:20 }}>
          {[{val:`${checkedItems}/${totalItems}`,label:"Vérifié",color:CK_C.accent},{val:checkedItems-nokItems.length,label:"OK",color:CK_C.success},{val:nokItems.length,label:"Manques",color:nokItems.length>0?CK_C.danger:CK_C.muted}].map(s=>(
            <div key={s.label} style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:10, padding:"12px", textAlign:"center" }}>
              <div style={{ fontSize:22, fontWeight:800, color:s.color }}>{s.val}</div>
              <div style={{ fontSize:10, color:CK_C.muted, textTransform:"uppercase" }}>{s.label}</div>
            </div>
          ))}
        </div>
        <div style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:12, padding:"16px", marginBottom:14 }}>
          {[["Véhicule",vehicleName],["Ambulancier 1",amb1||"—"],["Ambulancier 2",amb2||"—"],["Mois",semaine||"—"],["Date",new Date().toLocaleDateString("fr-FR")]].map(([k,v])=>(
            <div key={k} style={{ display:"flex", justifyContent:"space-between", fontSize:13, marginBottom:7, paddingBottom:7, borderBottom:`1px solid ${CK_C.border}` }}>
              <span style={{ color:CK_C.muted }}>{k}</span><span style={{ fontWeight:600 }}>{v}</span>
            </div>
          ))}
        </div>
        {issues.length>0&&(
          <div style={{ background:CK_C.dangerSoft, border:`1px solid ${CK_C.danger}`, borderRadius:12, padding:"16px", marginBottom:14 }}>
            <div style={{ fontWeight:800, color:CK_C.danger, marginBottom:12, fontSize:14 }}>⚠ Problèmes signalés ({issues.length})</div>
            {issues.map((iss,i)=>(
              <div key={i} style={{ borderLeft:`2px solid ${CK_C.danger}`, paddingLeft:10, marginBottom:8 }}>
                <div style={{ display:"flex", justifyContent:"space-between" }}>
                  <span style={{ fontSize:13, fontWeight:600 }}>{iss.name}</span>
                  <span style={{ color:CK_C.danger, fontWeight:700, fontSize:12 }}>
                    {iss.type==="missing"?`Manque ${iss.missing}/${iss.required}`:iss.type==="nok_test"?"Test NOK":iss.type==="nok_seal"?"Scellé NOK":`Niveau bas (${iss.bar} bar)`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        {remarks&&<div style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:12, padding:"16px", marginBottom:14 }}><div style={{ fontSize:11, fontWeight:700, color:CK_C.muted, textTransform:"uppercase", marginBottom:8 }}>Remarques</div><div style={{ fontSize:13 }}>{remarks}</div></div>}
        <div style={{ background:CK_C.successSoft, border:`1px solid ${CK_C.success}`, borderRadius:10, padding:"14px", textAlign:"center", fontWeight:700, color:CK_C.success }}>
          {issues.length>0?(emails&&emails.length>0?`✅ Email de manquants envoyé (${emails.length} destinataire${emails.length>1?"s":""})`:"⚠️ Aucun email destinataire configuré (Paramètres)"):"✅ Checklist complète, rien à signaler"}
        </div>
        {stockFixed!=null&&(
          <div style={{ marginTop:12, background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:10, padding:"12px", textAlign:"center", fontSize:13, color:CK_C.muted }}>
            📦 Stock mis à jour d'après ta checklist : {stockFixed===0?"aucune différence":`${stockFixed} produit${stockFixed>1?"s":""} corrigé${stockFixed>1?"s":""}`}
          </div>
        )}
        <button onClick={onBack} style={{ width:"100%", marginTop:12, background:"transparent", border:`1px solid ${CK_C.border}`, borderRadius:10, color:CK_C.muted, padding:"12px", fontWeight:700, fontSize:14 }}>← Retour à la liste</button>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight:"100vh", background:CK_C.bg, fontFamily:"'DM Sans',sans-serif", color:CK_C.text, display:"flex", flexDirection:"column" }}>
      <div style={{ background:CK_C.panel, borderBottom:`1px solid ${CK_C.border}`, padding:"13px 16px", position:"sticky", top:0, zIndex:10 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <button onClick={onBack} style={{ background:"transparent", border:`1px solid ${CK_C.border}`, borderRadius:8, color:CK_C.muted, padding:"5px 10px", fontSize:14 }}>←</button>
            <div style={{ width:34, height:34, background:CK_C.red, borderRadius:8, display:"flex", alignItems:"center", justifyContent:"center", fontSize:17 }}>🚑</div>
            <div>
              <div style={{ fontWeight:800, fontSize:15 }}>{vehicleName} — Checklist</div>
              <div style={{ fontSize:10, color:CK_C.muted, textTransform:"uppercase", letterSpacing:"0.8px" }}>Norme {data.norme}</div>
            </div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:20, fontWeight:800, color:progress===100?CK_C.success:CK_C.accent }}>{progress}%</div>
              <div style={{ fontSize:10, color:CK_C.muted }}>{checkedItems}/{totalItems}</div>
            </div>
            <button onClick={toggleTheme} style={{background:CK_C.panel2,border:`1px solid ${CK_C.border}`,borderRadius:8,color:CK_C.muted,padding:"6px 10px",fontSize:11,fontWeight:600,cursor:"pointer"}}>{themeMode==="light"?"🌙":"☀️"}</button>
          </div>
        </div>
        <div style={{ height:4, background:CK_C.border, borderRadius:4, overflow:"hidden" }}>
          <div style={{ height:"100%", width:`${progress}%`, background:progress===100?CK_C.success:CK_C.accent, borderRadius:4, transition:"width 0.3s" }}/>
        </div>
      </div>

      {firstWeek&&(()=>{ const permCount=missingValidations.filter(m=>m.includes("Date péremption")).length; return(
        <div style={{ background:"#f59e0b20", borderBottom:`1px solid #f59e0b`, padding:"9px 16px", fontSize:12, fontWeight:700, color:"#fbbf24" }}>
          📅 Sac scellé — les dates de péremption sont obligatoires ({permCount} restante{permCount!==1?"s":""})
        </div>
      );})()}

      <div id="ckitem-ambulancier" style={{ background:CK_C.panel, borderBottom:`1px solid ${CK_C.border}`, padding:"12px 16px", display:"flex", gap:8 }}>
        <input value={amb1} onChange={e=>updateDoc_({amb1:e.target.value})} placeholder="Ambulancier 1" style={{ flex:1, background:CK_C.bg, border:`1px solid ${hasAmbulancier?CK_C.border:CK_C.danger}`, borderRadius:8, padding:"8px 12px", color:CK_C.text, fontSize:13 }}/>
        <input value={amb2} onChange={e=>updateDoc_({amb2:e.target.value})} placeholder="Ambulancier 2" style={{ flex:1, background:CK_C.bg, border:`1px solid ${hasAmbulancier?CK_C.border:CK_C.danger}`, borderRadius:8, padding:"8px 12px", color:CK_C.text, fontSize:13 }}/>
        <input value={semaine} onChange={e=>updateDoc_({semaine:e.target.value})} style={{ width:140, background:CK_C.bg, border:`1px solid ${CK_C.border}`, borderRadius:8, padding:"8px 10px", color:CK_C.text, fontSize:13 }}/>
      </div>

      <div style={{ flex:1, padding:"12px 12px 100px" }}>
        {data.sections.filter(s=>s.shelves.some(sh=>sh.items.length>0)).map(section=>{
          const sectionItems=section.shelves.flatMap(sh=>sh.items.map(item=>({item,key:gk(section.id,sh.id,item.n)})));
          const sTotal=sectionItems.reduce((sum,{item})=>sum+itemSlots(item),0);
          const sChecked=sectionItems.reduce((sum,{item,key})=>sum+itemCheckedSlots(item,checks[key]||{}),0);
          const sNOK=sectionItems.filter(({item,key})=>{
            const c=checks[key];
            if(!c) return false;
            if(c.found!=null&&c.found<c.required) return true;
            if(c.testOk===false) return true;
            if(c.sealOk===false) return true;
            return false;
          }).length;
          const isExp=expanded[section.id];
          return(
            <div key={section.id} style={{ marginBottom:8, border:`1px solid ${CK_C.border}`, borderRadius:12, overflow:"hidden" }}>
              <button onClick={()=>toggle(section.id)} style={{ width:"100%", background:section.color, border:"none", padding:"12px 14px", display:"flex", alignItems:"center", justifyContent:"space-between", color:"white" }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ background:"rgba(0,0,0,0.25)", borderRadius:6, padding:"2px 7px", fontSize:11, fontWeight:700 }}>{section.id}</span>
                  <span style={{ fontWeight:700, fontSize:13 }}>{section.label}</span>
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  {sNOK>0&&<span style={{ background:CK_C.danger, borderRadius:20, padding:"2px 7px", fontSize:10, fontWeight:700 }}>⚠{sNOK}</span>}
                  <span style={{ fontSize:11, opacity:0.8 }}>{sChecked}/{sTotal}</span>
                  <span style={{ fontSize:14, opacity:0.7 }}>{isExp?"▲":"▼"}</span>
                </div>
              </button>
              {isExp&&section.shelves.map(shelf=>(
                <div key={shelf.id}>
                  {shelf.label&&shelf.items.length>0&&<div style={{ background:"#1a1f2e", padding:"7px 14px", fontSize:10, fontWeight:700, color:section.color, textTransform:"uppercase", letterSpacing:"1px", borderTop:`1px solid ${CK_C.border}` }}>{shelf.label}</div>}
                  {shelf.items.map((item,idx)=>{
                    const key=gk(section.id,shelf.id,item.n);
                    const state=checks[key]||{};
                    const found=state.found;
                    const isChecked=found!=null;
                    const isMissing=isChecked&&found<item.q;
                    const isOk=isChecked&&found>=item.q;
                    const isBinary=item.t||item.s||item.okOnly;
                    const centralPeremptionDate=item.p?getSoonestDate(peremptionMap[peremptionKey(vehicleName,item.n)]?.lots):"";
                    const peremptionExpired=item.p&&isMonthExpired(centralPeremptionDate);
                    const sealDateMissingHere=item.s&&firstWeek&&!isMissing&&state.sealOk!==false&&!state.sealDate;
                    const sealDateExpired=item.s&&state.sealOk!==false&&isMonthExpired(state.sealDate);
                    const barMissingHere=item.bar&&state.bar==null;
                    return(
                      <div key={idx} id={"ckitem-"+item.n.replace(/[^a-zA-Z0-9]/g,"-")} style={{ background:isMissing?"rgba(239,68,68,0.06)":isOk?"rgba(34,197,94,0.04)":CK_C.panel, borderTop:`1px solid ${CK_C.border}`, padding:"11px 14px" }}>
                        <div style={{ fontSize:13, fontWeight:600, color:CK_C.text, display:"flex", alignItems:"center", gap:5, flexWrap:"wrap", marginBottom:8 }}>
                          {item.n}
                          {item.t&&<span style={{ background:"#1d4ed820", border:"1px solid #1d4ed8", color:"#60a5fa", borderRadius:4, padding:"1px 5px", fontSize:9, fontWeight:700 }}>TEST</span>}
                          {item.s&&<span style={{ background:"#7c3aed20", border:"1px solid #7c3aed", color:"#a78bfa", borderRadius:4, padding:"1px 5px", fontSize:9, fontWeight:700 }}>SCELLÉ</span>}
                          {item.p&&<span style={{ background:peremptionExpired?"#ef444420":"#f59e0b20", border:`1px solid ${peremptionExpired?"#ef4444":"#f59e0b"}`, color:peremptionExpired?"#f87171":"#fbbf24", borderRadius:4, padding:"1px 5px", fontSize:9, fontWeight:700 }}>PÉREMPTION{peremptionExpired?" ⚠":""}</span>}
                        </div>
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, marginBottom:(item.t||item.s||item.bar)?6:0 }}>
                          <div style={{ fontSize:11, color:CK_C.muted, minWidth:80 }}>{item.okOnly?"État":"Présence"+(!isBinary?" (requis: "+item.q+")":"")}</div>
                          <div style={{ display:"flex", gap:5, alignItems:"center" }}>
                            <button onClick={()=>setCF(key,state.found===item.q?undefined:item.q,item.q,item)} style={{ padding:"6px 12px", borderRadius:8, border:isOk?`2px solid ${CK_C.success}`:`1px solid ${CK_C.border}`, background:isOk?CK_C.successSoft:"transparent", color:isOk?CK_C.success:CK_C.muted, fontWeight:700, fontSize:12 }}>OK</button>
                            {!item.okOnly&&<button onClick={()=>setCF(key,state.found===0?undefined:0,item.q,item)} style={{ padding:"6px 10px", borderRadius:8, border:(isChecked&&!isOk)?`2px solid ${CK_C.danger}`:`1px solid ${CK_C.border}`, background:(isChecked&&!isOk)?CK_C.dangerSoft:"transparent", color:(isChecked&&!isOk)?CK_C.danger:CK_C.muted, fontWeight:700, fontSize:12 }}>NOK</button>}
                            {!isBinary&&!item.bar&&<div style={{ display:"flex", alignItems:"center", background:CK_C.bg, border:`1px solid ${isMissing?CK_C.danger:isOk?CK_C.success:CK_C.border}`, borderRadius:10, overflow:"hidden" }}>
                              <button onClick={()=>setCF(key,Math.max(0,(found!=null?found:item.q)-1),item.q,item)} style={{ width:30, height:32, background:"transparent", border:"none", color:CK_C.muted, fontSize:16 }}>−</button>
                              <div style={{ minWidth:28, textAlign:"center", fontSize:13, fontWeight:800, color:isMissing?CK_C.danger:isOk?CK_C.success:CK_C.text, borderLeft:`1px solid ${CK_C.border}`, borderRight:`1px solid ${CK_C.border}`, height:32, display:"flex", alignItems:"center", justifyContent:"center" }}>{found!=null?found:"?"}</div>
                              <button onClick={()=>setCF(key,(found!=null?found:0)+1,item.q,item)} style={{ width:30, height:32, background:"transparent", border:"none", color:CK_C.muted, fontSize:16 }}>+</button>
                            </div>}
                          </div>
                        </div>
                        {item.bar&&(
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, marginBottom:6, paddingTop:5, borderTop:`1px dashed ${CK_C.border}` }}>
                          <div style={{ fontSize:11, color:barMissingHere?CK_C.danger:(state.bar<50?CK_C.danger:CK_C.blue), minWidth:80, fontWeight:(barMissingHere||state.bar<50)?700:400 }}>Niveau (bar){(barMissingHere||state.bar<50)?" ⚠":""}</div>
                          <select value={state.bar!=null?state.bar:""} onChange={e=>setC(key,"bar",e.target.value===""?undefined:parseInt(e.target.value))} style={{ background:barMissingHere?CK_C.dangerSoft:(state.bar<50?CK_C.dangerSoft:CK_C.bg), border:`1px solid ${(barMissingHere||state.bar<50)?CK_C.danger:CK_C.border}`, borderRadius:8, padding:"6px 10px", color:(barMissingHere||state.bar<50)?CK_C.danger:CK_C.text, fontSize:13, fontWeight:(barMissingHere||state.bar<50)?700:400 }}>
                            <option value="">— bar —</option>
                            {Array.from({length:31},(_,i)=>i*10).map(v=>(<option key={v} value={v}>{v} bar</option>))}
                          </select>
                        </div>
                        )}
                        {item.t&&(<div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, marginBottom:item.s?6:0, paddingTop:5, borderTop:`1px dashed ${CK_C.border}` }}>
                          <div style={{ fontSize:11, color:CK_C.blue, minWidth:80 }}>Fonctionnel</div>
                          <div style={{ display:"flex", gap:5 }}>
                            <button onClick={()=>setTest(key,state.testOk===true?undefined:true)} style={{ padding:"6px 12px", borderRadius:8, border:state.testOk===true?`2px solid ${CK_C.success}`:`1px solid ${CK_C.border}`, background:state.testOk===true?CK_C.successSoft:"transparent", color:state.testOk===true?CK_C.success:CK_C.muted, fontWeight:700, fontSize:12 }}>OK</button>
                            <button onClick={()=>setTest(key,state.testOk===false?undefined:false)} style={{ padding:"6px 10px", borderRadius:8, border:state.testOk===false?`2px solid ${CK_C.danger}`:`1px solid ${CK_C.border}`, background:state.testOk===false?CK_C.dangerSoft:"transparent", color:state.testOk===false?CK_C.danger:CK_C.muted, fontWeight:700, fontSize:12 }}>NOK</button>
                          </div>
                        </div>)}
                        {item.s&&(<div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, marginBottom:6, paddingTop:5, borderTop:`1px dashed ${CK_C.border}` }}>
                          <div style={{ fontSize:11, color:"#a78bfa", minWidth:80 }}>Scellé intact</div>
                          <div style={{ display:"flex", gap:5 }}>
                            <button onClick={()=>setSeal(key,state.sealOk===true?undefined:true)} style={{ padding:"6px 12px", borderRadius:8, border:state.sealOk===true?`2px solid ${CK_C.success}`:`1px solid ${CK_C.border}`, background:state.sealOk===true?CK_C.successSoft:"transparent", color:state.sealOk===true?CK_C.success:CK_C.muted, fontWeight:700, fontSize:12 }}>OK</button>
                            <button onClick={()=>setSeal(key,state.sealOk===false?undefined:false)} style={{ padding:"6px 10px", borderRadius:8, border:state.sealOk===false?`2px solid ${CK_C.danger}`:`1px solid ${CK_C.border}`, background:state.sealOk===false?CK_C.dangerSoft:"transparent", color:state.sealOk===false?CK_C.danger:CK_C.muted, fontWeight:700, fontSize:12 }}>NOK</button>
                          </div>
                        </div>)}
                        {item.s&&!item.p&&state.sealOk!==false&&(
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, paddingTop:2 }}>
                          <div style={{ fontSize:11, color:sealDateExpired?CK_C.danger:"#a78bfa", minWidth:80 }}>Date scellé</div>
                          <MonthYearPicker value={state.sealDate||""} onChange={v=>setDateField(key,"sealDate",v,item)} danger={sealDateMissingHere||sealDateExpired}/>
                        </div>
                        )}
                        {item.p&&(
                        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, marginTop:6 }}>
                          <div style={{ fontSize:11, color:peremptionExpired?CK_C.danger:"#fbbf24", minWidth:80 }}>Péremption</div>
                          {sealedTask
                            ? <MonthYearPicker value={state.date||""} onChange={v=>setDateField(key,"date",v,item)} danger={isChecked&&!isMissing&&!state.date}/>
                            : <div style={{ fontSize:12, fontWeight:700, color:peremptionExpired?CK_C.danger:CK_C.text, background:CK_C.bg, border:`1px solid ${peremptionExpired?CK_C.danger:CK_C.border}`, borderRadius:8, padding:"6px 12px" }}>
                            {centralPeremptionDate?monthYearLabel(centralPeremptionDate):"Non renseignée (bureau)"}
                          </div>}
                        </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          );
        })}
        <div style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:12, padding:"14px", marginTop:6 }}>
          <div style={{ fontSize:11, fontWeight:700, color:CK_C.muted, textTransform:"uppercase", letterSpacing:"1px", marginBottom:8 }}>📝 Remarques</div>
          <textarea value={remarks} onChange={e=>updateDoc_({remarks:e.target.value})} placeholder="Matériel manquant, observations..." rows={3} style={{ width:"100%", background:CK_C.bg, border:`1px solid ${CK_C.border}`, borderRadius:8, padding:"10px 12px", color:CK_C.text, fontSize:13, resize:"none" }}/>
        </div>
      </div>
      <div style={{ position:"fixed", bottom:0, left:0, right:0, background:CK_C.panel, borderTop:`1px solid ${CK_C.border}`, padding:"13px 16px" }}>
        {!canSubmit&&(
          <div style={{ background:CK_C.dangerSoft, border:`1px solid ${CK_C.danger}`, borderRadius:8, padding:"8px 12px", marginBottom:8, fontSize:11, color:CK_C.danger, fontWeight:600 }}>
            {!hasAmbulancier?"⚠ Indique au moins un ambulancier":`⚠ ${missingValidations.length} validation(s) manquante(s)`}
          </div>
        )}
        <button disabled={sending} onClick={()=>{
          if(!canSubmit){ scrollToFirstMissing(); return; }
          sendMissingReport();
          updateDoc_({ submittedAt:Date.now() });
          if(sealedTask){
            const perish={}; const names=[];
            data.sections.forEach(sec=>sec.shelves.forEach(sh=>sh.items.forEach(item=>{
              if(!item.p) return;
              if(!names.includes(item.n)) names.push(item.n);
              const st=checks[gk(sec.id,sh.id,item.n)];
              if(st&&st.found>0&&st.date){
                const e=perish[item.n]||{ q:0, date:st.date };
                e.q+=st.found;
                if(st.date<e.date) e.date=st.date;
                perish[item.n]=e;
              }
            })));
            recordSealedExpiry({ label:vehicleName, perish, names })
              .catch(e=>console.error("Erreur péremptions du sac:", e))
              .then(()=>{ if(onSealedDone) onSealedDone(); });
          }
          if(stockInit&&stockInit[vehicleName]){
            const counts={};
            data.sections.forEach(sec=>sec.shelves.forEach(sh=>sh.items.forEach(item=>{
              if(item.okOnly||item.bar) return;
              const st=checks[gk(sec.id,sh.id,item.n)];
              if(st&&st.found!=null) counts[item.n]=(counts[item.n]||0)+st.found;
            })));
            syncStockFromChecklist({ vehicle:vehicleName, counts, by:[amb1,amb2].filter(Boolean).join(" / ") })
              .then(n=>setStockFixed(n)).catch(e=>console.error("Erreur mise à jour du stock:", e));
          }
          saveChecklistHistorique({

            id:`${vehicleName}_${weekKey}_${Date.now()}`, v2:true, sealed:!!sealedTask,
            vehicle:vehicleName, date:new Date().toLocaleDateString("fr-FR"), dateISO:new Date().toISOString(),
            semaine:semaine||monthYearLabel(getChecklistMonthKey()),
            amb1, amb2, remarks:remarks||"", complete:progress===100, timestamp:Date.now(),
            issues:issues.map(iss=>({
              ...iss,
              remaining: iss.type==="missing"?iss.missing:(iss.type==="low_bar"?(iss.bar===0?1:0):1),
              resupplied:0,
            })),
          });
          setSubmitted(true);
        }} style={{ width:"100%", background:!canSubmit?CK_C.border:progress===100?CK_C.success:CK_C.accent, border:"none", borderRadius:10, color:"white", padding:"14px", fontWeight:800, fontSize:15, opacity:canSubmit?1:0.85, cursor:sending?"not-allowed":"pointer" }}>
          {canSubmit?"✅ Envoyer au responsable":`⚠ ${!hasAmbulancier?"Ambulancier requis — toucher pour y aller":missingValidations.length+" oubli(s) — toucher pour y aller"}`}
        </button>
      </div>
    </div>
  );
}

async function saveChecklistHistorique(entry){
  try{
    await setDoc(doc(dbChecklists,"stockapp_historique",entry.id), sanitizeUndefined(entry));
  }catch(e){ console.error("Erreur sauvegarde historique:", e); }
}
// Purge les entrées de plus de 24 mois (écart de mois calendaires, pas de
// jours — ex: en janvier 2028, tout ce qui date de janvier 2026 ou avant
// est supprimé).
async function cleanOldHistorique(){
  try{
    const snap=await getDocs(collection(dbChecklists,"stockapp_historique"));
    const now=new Date();
    const toDelete=[];
    snap.forEach(d=>{
      const data=d.data();
      const entryDate=new Date(data.dateISO||data.timestamp);
      const monthsDiff=(now.getFullYear()-entryDate.getFullYear())*12+(now.getMonth()-entryDate.getMonth());
      if(monthsDiff>=24) toDelete.push(deleteDoc(doc(dbChecklists,"stockapp_historique",d.id)));
    });
    if(toDelete.length>0) await Promise.all(toDelete);
  }catch(e){ console.error("Erreur nettoyage historique:", e); }
}

function checklistTotalItems(checklistsData, vehicleName){
  const data=checklistsData[vehicleName];
  if(!data) return 0;
  return data.sections.flatMap(s=>s.shelves.flatMap(sh=>sh.items)).length;
}
// Calcule l'état d'une checklist (progression, complète ou non) à partir
// des coches actuelles. "Complète" exige aussi, la 1ère semaine du mois,
// que toutes les dates de péremption soient renseignées.
function checklistStatus(checklistsData, vehicleName, checks){
  const data=checklistsData[vehicleName];
  const total=checklistTotalItems(checklistsData, vehicleName);
  const checkedCount=Object.values(checks||{}).filter(c=>c.found!=null).length;
  const progress=total>0?Math.round((checkedCount/total)*100):0;
  let allValidated=!!data;
  if(data){
    outer:
    for(const sec of data.sections){
      for(const sh of sec.shelves){
        for(const item of sh.items){
          if(item.okOnly) continue;
          const key=`${sec.id}__${sh.id}__${item.n}`;
          const state=(checks||{})[key];
          if(!state||state.found==null){ allValidated=false; break outer; }
          if(item.t&&state.testOk==null){ allValidated=false; break outer; }
          if(item.s&&state.sealOk==null){ allValidated=false; break outer; }
        }
      }
    }
  }
  const complete=progress===100&&allValidated;
  const started=checkedCount>0;
  return { progress, checkedCount, total, complete, started };
}

function ChecklistHistoriqueSubView({ onBack, themeMode, toggleTheme }){
  const [entries,setEntries]=useState([]);
  const [loaded,setLoaded]=useState(false);

  useEffect(()=>{
    cleanOldHistorique();
    const unsub=onSnapshot(collection(dbChecklists,"stockapp_historique"), snap=>{
      const docs=snap.docs.map(d=>d.data());
      docs.sort((a,b)=>b.timestamp-a.timestamp);
      setEntries(docs);
      setLoaded(true);
    }, ()=>setLoaded(true));
    return ()=>unsub();
  },[]);

  return(
    <div style={{ minHeight:"100vh", background:CK_C.bg, fontFamily:"'DM Sans',sans-serif", color:CK_C.text, display:"flex", flexDirection:"column" }}>
      <style>{CK_GS}</style>
      <div style={{ background:CK_C.panel, borderBottom:`1px solid ${CK_C.border}`, padding:"14px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10, position:"sticky", top:0, zIndex:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <button onClick={onBack} style={{ background:"transparent", border:`1px solid ${CK_C.border}`, borderRadius:8, color:CK_C.muted, padding:"6px 12px", fontSize:14, cursor:"pointer" }}>←</button>
          <div style={{ fontWeight:800, fontSize:16 }}>📋 Historique checklists</div>
        </div>
        <button onClick={toggleTheme} style={{background:CK_C.panel2,border:`1px solid ${CK_C.border}`,borderRadius:8,color:CK_C.muted,padding:"6px 12px",fontSize:11,fontWeight:600,cursor:"pointer"}}>{themeMode==="light"?"🌙":"☀️"}</button>
      </div>
      <div style={{ flex:1, padding:"14px", overflowY:"auto" }}>
        {!loaded&&<div style={{ textAlign:"center", color:CK_C.muted, padding:"40px" }}>Chargement…</div>}
        {loaded&&entries.length===0&&<div style={{ textAlign:"center", color:CK_C.muted, padding:"40px" }}>Aucune checklist envoyée pour l'instant</div>}
        {entries.map(entry=>{
          const allIssues=entry.issues||[];
          const openIssues=allIssues.filter(i=>i.remaining>0);
          const color=openIssues.length===0?CK_C.success:CK_C.danger;
          return(
            <div key={entry.id} style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderLeft:`4px solid ${color}`, borderRadius:12, padding:"14px", marginBottom:10 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div>
                  <div style={{ fontWeight:800, fontSize:14 }}>🚑 {entry.vehicle}</div>
                  <div style={{ fontSize:11, color:CK_C.muted, marginTop:2 }}>{entry.date} · {entry.semaine||("Sem. "+entry.weekNumber)} · {entry.amb1||"—"} / {entry.amb2||"—"}</div>
                </div>
                <div style={{ textAlign:"right" }}>
                  <div style={{ fontSize:18 }}>{openIssues.length===0?"✅":"🔴"}</div>
                  <div style={{ fontSize:10, color, fontWeight:700 }}>{allIssues.length===0?"Tout OK":openIssues.length===0?"Réappro OK":`${openIssues.length} en attente`}</div>
                </div>
              </div>
              {allIssues.length>0&&(
                <div style={{ marginTop:10, paddingTop:10, borderTop:`1px solid ${CK_C.border}` }}>
                  {allIssues.map((iss,i)=>(
                    <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", fontSize:12, padding:"4px 0" }}>
                      <span style={{ color:CK_C.text }}>{iss.name}</span>
                      <span style={{ display:"flex", gap:6, alignItems:"center" }}>
                        {iss.remaining>0&&<span style={{ color:CK_C.danger, fontWeight:700 }}>{iss.type==="missing"?`reste ${iss.remaining}`:"en attente"}</span>}
                        {iss.remaining===0&&<span style={{ color:CK_C.success, fontWeight:700 }}>✓ résolu</span>}
                        {iss.resupplied>0&&<span style={{ background:CK_C.successSoft, border:`1px solid ${CK_C.success}`, color:CK_C.success, borderRadius:5, padding:"1px 6px", fontSize:10, fontWeight:700 }}>+{iss.resupplied}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {entry.remarks&&<div style={{ marginTop:8, paddingTop:8, borderTop:`1px solid ${CK_C.border}`, fontSize:11, color:CK_C.muted }}><strong style={{ color:CK_C.text }}>Remarques :</strong> {entry.remarks}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function O2HistoriqueSubView({ onBack, themeMode, toggleTheme }){
  const [entries,setEntries]=useState([]);
  const [loaded,setLoaded]=useState(false);
  const [reserve,setReserve]=useState(O2_EMPTY_RESERVE);
  const [confirmDelete,setConfirmDelete]=useState(null);

  useEffect(()=>{
    cleanOldO2Historique();
    const unsub=onSnapshot(collection(dbChecklists,"stockapp_o2_historique"), snap=>{
      const docs=snap.docs.map(d=>d.data());
      docs.sort((a,b)=>b.timestamp-a.timestamp); // plus récent en haut
      setEntries(docs);
      setLoaded(true);
    }, ()=>setLoaded(true));
    return ()=>unsub();
  },[]);

  useEffect(()=>{
    const unsub=onSnapshot(doc(dbChecklists,"stockapp_o2","reserve"), snap=>{
      const d=snap.exists()?snap.data():O2_EMPTY_RESERVE;
      setReserve({ pleines:{...O2_EMPTY_RESERVE.pleines,...d.pleines}, vides:{...O2_EMPTY_RESERVE.vides,...d.vides} });
    });
    return ()=>unsub();
  },[]);

  return(
    <div style={{ minHeight:"100vh", background:CK_C.bg, fontFamily:"'DM Sans',sans-serif", color:CK_C.text, display:"flex", flexDirection:"column" }}>
      <style>{CK_GS}</style>
      <div style={{ background:CK_C.panel, borderBottom:`1px solid ${CK_C.border}`, padding:"14px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10, position:"sticky", top:0, zIndex:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <button onClick={onBack} style={{ background:"transparent", border:`1px solid ${CK_C.border}`, borderRadius:8, color:CK_C.muted, padding:"6px 12px", fontSize:14, cursor:"pointer" }}>←</button>
          <div style={{ fontWeight:800, fontSize:16 }}><span style={{color:"#3b82f6"}}>O₂</span> Historique bouteilles</div>
        </div>
        <button onClick={toggleTheme} style={{background:CK_C.panel2,border:`1px solid ${CK_C.border}`,borderRadius:8,color:CK_C.muted,padding:"6px 12px",fontSize:11,fontWeight:600,cursor:"pointer"}}>{themeMode==="light"?"🌙":"☀️"}</button>
      </div>
      <div style={{ display:"flex", gap:8, padding:"14px 14px 0" }}>
        {O2_SIZES.map(s=>{
          const low=(reserve.pleines[s]||0)<=2;
          return(
            <div key={s} style={{ flex:1, background:low?CK_C.dangerSoft:CK_C.panel, border:`1px solid ${low?CK_C.danger:CK_C.border}`, borderRadius:12, padding:"10px", textAlign:"center" }}>
              <div style={{ fontSize:18, fontWeight:900, color:low?CK_C.danger:"#3b82f6" }}>{reserve.pleines[s]||0}</div>
              <div style={{ fontSize:9, color:low?CK_C.danger:CK_C.muted, fontWeight:700 }}>{s} pleines</div>
              <div style={{ fontSize:14, fontWeight:800, color:CK_C.muted, marginTop:4 }}>{reserve.vides[s]||0}</div>
              <div style={{ fontSize:9, color:CK_C.muted, fontWeight:700 }}>{s} vides</div>
            </div>
          );
        })}
      </div>
      <div style={{ flex:1, padding:"14px", overflowY:"auto" }}>
        {!loaded&&<div style={{ textAlign:"center", color:CK_C.muted, padding:"40px" }}>Chargement…</div>}
        {loaded&&entries.length===0&&<div style={{ textAlign:"center", color:CK_C.muted, padding:"40px" }}>Aucun mouvement pour l'instant</div>}
        {entries.map(entry=>{
          if(entry.type==="correction") return <O2CorrectionCard key={entry.id} entry={entry} onDelete={()=>setConfirmDelete(entry)}/>;
          const isFournisseur=entry.type==="fournisseur";
          const sortieLines=O2_SIZES.filter(s=>(entry.sortie?.[s]||0)>0);
          const entreeLines=O2_SIZES.filter(s=>(entry.entree?.[s]||0)>0);
          return(
            <div key={entry.id} style={{ background:CK_C.panel, border:`1px solid ${isFournisseur?"#3b82f6":CK_C.border}`, borderLeft:`4px solid ${isFournisseur?"#3b82f6":CK_C.muted}`, borderRadius:12, padding:"14px", marginBottom:10 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
                <div style={{ fontWeight:isFournisseur?900:800, fontSize:isFournisseur?15:14, color:isFournisseur?"#3b82f6":CK_C.text, textTransform:isFournisseur?"uppercase":"none", letterSpacing:isFournisseur?"0.5px":"normal" }}>
                  {isFournisseur?"🚚 Livraison fournisseur":(entry.vehicle==="Préventif"?"🧰 Préventif":`🚑 ${entry.vehicle}`)}
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <div style={{ fontSize:11, color:CK_C.muted }}>{entry.date}</div>
                  <button onClick={()=>setConfirmDelete(entry)} style={{ background:CK_C.dangerSoft, border:`1px solid ${CK_C.danger}`, borderRadius:6, color:CK_C.danger, padding:"4px 8px", fontSize:11, cursor:"pointer" }}>🗑</button>
                </div>
              </div>
              <div style={{ marginTop:8, fontSize:12 }}>
                <div style={{ color:CK_C.danger, fontWeight:700, marginBottom:2 }}>Sortie :</div>
                {sortieLines.length===0?<div style={{color:CK_C.muted,marginLeft:6}}>—</div>:sortieLines.map(s=>(<div key={s} style={{marginLeft:6}}>{s} : {entry.sortie[s]}</div>))}
                <div style={{ color:CK_C.success, fontWeight:700, marginTop:6, marginBottom:2 }}>Entrée :</div>
                {entreeLines.length===0?<div style={{color:CK_C.muted,marginLeft:6}}>—</div>:entreeLines.map(s=>(<div key={s} style={{marginLeft:6}}>{s} : {entry.entree[s]}</div>))}
              </div>
              {entry.name&&<div style={{ marginTop:8, paddingTop:8, borderTop:`1px solid ${CK_C.border}`, fontSize:11, color:CK_C.muted }}>Par : <strong style={{color:CK_C.text}}>{entry.name}</strong></div>}
            </div>
          );
        })}
      </div>

      {confirmDelete&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:400}}>
          <div style={{background:CK_C.panel,border:`1px solid ${CK_C.danger}`,borderRadius:16,padding:"24px",width:360,maxWidth:"92vw"}}>
            <div style={{fontWeight:800,fontSize:16,marginBottom:10}}>🗑 Supprimer ce mouvement ?</div>
            <div style={{fontSize:13,color:CK_C.muted,marginBottom:20}}>
              Cette action supprime définitivement l'entrée et <strong style={{color:CK_C.text}}>annule son effet</strong> sur les compteurs de réserve (les quantités seront recalculées comme si ce mouvement n'avait jamais eu lieu).
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setConfirmDelete(null)} style={{flex:1,background:CK_C.panel2,border:`1px solid ${CK_C.border}`,borderRadius:9,color:CK_C.muted,padding:"11px",fontWeight:700,fontSize:13,cursor:"pointer"}}>Annuler</button>
              <button onClick={async()=>{await deleteO2HistoriqueEntry(confirmDelete);setConfirmDelete(null);}} style={{flex:1,background:CK_C.danger,border:"none",borderRadius:9,color:"white",padding:"11px",fontWeight:700,fontSize:13,cursor:"pointer"}}>🗑 Supprimer</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

async function checkAndSendO2LowStock(currentPleines, nextPleines, emails){
  const justDropped = O2_SIZES.some(s => (nextPleines[s]||0) < (currentPleines[s]||0) && (nextPleines[s]||0)<=2);
  if(!justDropped) return;
  if(!emails || emails.length===0) return;
  const lowSizes = O2_SIZES.filter(s => (nextPleines[s]||0)<=2);
  if(lowSizes.length===0) return;
  const stockText = lowSizes.map(s=>`${s} : ${nextPleines[s]} restante(s)`).join("\n");
  try{
    for(const to of emails){
      await emailjs.send("service_mrs8v2l","template_2sxsq4j",{
        to_email: to,
        title: "Alerte Stock O²",
        content: `⚠ Stock bas\n\n${stockText}`,
      }, "Fhdx1kTE7vFmh4z07");
    }
  }catch(e){ console.error("Erreur alerte stock O2:", e); }
}
// Purge les entrées O2 de plus de 24 mois (même règle que l'historique checklists).
async function cleanOldO2Historique(){
  try{
    const snap=await getDocs(collection(dbChecklists,"stockapp_o2_historique"));
    const now=new Date();
    const toDelete=[];
    snap.forEach(d=>{
      const data=d.data();
      const entryDate=new Date(data.dateISO||data.timestamp);
      const monthsDiff=(now.getFullYear()-entryDate.getFullYear())*12+(now.getMonth()-entryDate.getMonth());
      if(monthsDiff>=24) toDelete.push(deleteDoc(doc(dbChecklists,"stockapp_o2_historique",d.id)));
    });
    if(toDelete.length>0) await Promise.all(toDelete);
  }catch(e){ console.error("Erreur nettoyage historique O2:", e); }
}

// ═══════════════════════════════════════════════════════════════
// O₂ — logique : réserve (pleines/vides) + contenu de chaque ambulance.
// Doc `stockapp_o2/reserve` = { pleines:{B2,B5,B10}, vides:{...}, vehicules:{ "ALPHA 1":{B2,B5,B10}, ... } }
// ═══════════════════════════════════════════════════════════════
const O2_ZERO=()=>({B2:0,B5:0,B10:0});
function normO2Reserve(d){
  const base=d||{};
  const vehicules={};
  O2_VEHICLES.forEach(v=>{ vehicules[v]={ ...O2_ZERO(), ...((base.vehicules||{})[v]||{}) }; });
  return { pleines:{ ...O2_EMPTY_RESERVE.pleines, ...base.pleines }, vides:{ ...O2_EMPTY_RESERVE.vides, ...base.vides }, vehicules };
}
function o2ContentText(c){
  const parts=O2_SIZES.filter(s=>(c?.[s]||0)>0).map(s=>`${s} ×${c[s]}`);
  return parts.length?parts.join(", "):"aucune bouteille";
}

// type "vehicule" : sortie (retirée du véhicule) → -contenu véhicule, +vides ; entrée (installée) → +contenu véhicule, -pleines.
// type "fournisseur" : sortie (vides reprises) → -vides ; entrée (pleines livrées) → +pleines.
async function applyO2Movement(type, sortie, entree, extra){
  try{
    const ref=doc(dbChecklists,"stockapp_o2","reserve");
    const snap=await getDoc(ref);
    const next=normO2Reserve(snap.exists()?snap.data():null);
    const currentPleines={ ...next.pleines };
    O2_SIZES.forEach(s=>{
      if(type==="vehicule"){
        const v=extra&&extra.vehicle;
        next.vides[s]=(next.vides[s]||0)+(sortie[s]||0);
        next.pleines[s]=Math.max(0,(next.pleines[s]||0)-(entree[s]||0));
        if(v&&next.vehicules[v]) next.vehicules[v][s]=Math.max(0,(next.vehicules[v][s]||0)-(sortie[s]||0)+(entree[s]||0));
      }else{
        next.vides[s]=Math.max(0,(next.vides[s]||0)-(sortie[s]||0));
        next.pleines[s]=(next.pleines[s]||0)+(entree[s]||0);
      }
    });
    await setDoc(ref,next);
    const logId=`${type}_${Date.now()}`;
    await setDoc(doc(dbChecklists,"stockapp_o2_historique",logId),{
      id:logId, type, sortie, entree,
      date:new Date().toLocaleDateString("fr-FR"), dateISO:new Date().toISOString(), timestamp:Date.now(),
      ...extra,
    });
    return { current:currentPleines, next:next.pleines };
  }catch(e){ console.error("Erreur mouvement O2:", e); return { current:{}, next:{} }; }
}

// Correction manuelle : on encode ce qui est réellement là (stock + ambulances).
async function applyO2Correction(values, by){
  try{
    const ref=doc(dbChecklists,"stockapp_o2","reserve");
    const snap=await getDoc(ref);
    const before=normO2Reserve(snap.exists()?snap.data():null);
    const after=normO2Reserve(values);
    await setDoc(ref,after);
    const logId=`correction_${Date.now()}`;
    await setDoc(doc(dbChecklists,"stockapp_o2_historique",logId),{
      id:logId, type:"correction", name:by, before, after,
      date:new Date().toLocaleDateString("fr-FR"), dateISO:new Date().toISOString(), timestamp:Date.now(),
    });
  }catch(e){ console.error("Erreur correction O2:", e); }
}

// Supprime une entrée de l'historique O2 et annule son effet (une correction est seulement retirée du journal).
async function deleteO2HistoriqueEntry(entry){
  try{
    if(entry.type!=="correction"){
      const ref=doc(dbChecklists,"stockapp_o2","reserve");
      const snap=await getDoc(ref);
      const next=normO2Reserve(snap.exists()?snap.data():null);
      const sortie=entry.sortie||{}, entree=entry.entree||{};
      O2_SIZES.forEach(s=>{
        if(entry.type==="vehicule"){
          next.vides[s]=Math.max(0,(next.vides[s]||0)-(sortie[s]||0));
          next.pleines[s]=(next.pleines[s]||0)+(entree[s]||0);
          if(entry.vehicle&&next.vehicules[entry.vehicle]) next.vehicules[entry.vehicle][s]=Math.max(0,(next.vehicules[entry.vehicle][s]||0)+(sortie[s]||0)-(entree[s]||0));
        }else{
          next.vides[s]=(next.vides[s]||0)+(sortie[s]||0);
          next.pleines[s]=Math.max(0,(next.pleines[s]||0)-(entree[s]||0));
        }
      });
      await setDoc(ref,next);
    }
    await deleteDoc(doc(dbChecklists,"stockapp_o2_historique",entry.id));
  }catch(e){ console.error("Erreur suppression historique O2:", e); }
}

// Carte d'une correction dans l'historique O₂
function O2CorrectionCard({ entry, onDelete }){
  const b=entry.before||normO2Reserve(null), a=entry.after||normO2Reserve(null);
  const lines=[];
  O2_SIZES.forEach(s=>{
    if((b.pleines?.[s]||0)!==(a.pleines?.[s]||0)) lines.push(`Pleines ${s} : ${b.pleines?.[s]||0} → ${a.pleines?.[s]||0}`);
    if((b.vides?.[s]||0)!==(a.vides?.[s]||0)) lines.push(`Vides ${s} : ${b.vides?.[s]||0} → ${a.vides?.[s]||0}`);
  });
  O2_VEHICLES.forEach(v=>{
    const x=(b.vehicules||{})[v]||{}, y=(a.vehicules||{})[v]||{};
    if(O2_SIZES.some(s=>(x[s]||0)!==(y[s]||0))) lines.push(`${v} : ${o2ContentText(x)} → ${o2ContentText(y)}`);
  });
  return(
    <div style={{ background:CK_C.panel, border:`1px solid #f59e0b`, borderLeft:`4px solid #f59e0b`, borderRadius:12, padding:"14px", marginBottom:10 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
        <div style={{ fontWeight:800, fontSize:14, color:"#f59e0b" }}>✏️ Correction manuelle</div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <div style={{ fontSize:11, color:CK_C.muted }}>{entry.date}</div>
          <button onClick={onDelete} style={{ background:CK_C.dangerSoft, border:`1px solid ${CK_C.danger}`, borderRadius:6, color:CK_C.danger, padding:"4px 8px", fontSize:11, cursor:"pointer" }}>🗑</button>
        </div>
      </div>
      <div style={{ marginTop:8, fontSize:12 }}>
        {lines.length===0?<div style={{ color:CK_C.muted }}>Aucun changement</div>:lines.map((l,i)=>(<div key={i} style={{ marginBottom:2 }}>{l}</div>))}
      </div>
      {entry.name&&<div style={{ marginTop:8, paddingTop:8, borderTop:`1px solid ${CK_C.border}`, fontSize:11, color:CK_C.muted }}>Par : <strong style={{color:CK_C.text}}>{entry.name}</strong></div>}
    </div>
  );
}
const O2_VEHICLES=["ALPHA 1","ALPHA 2","ALPHA 3","ALPHA 4","ALPHA 5","ALPHA 6","ALPHA 7","Préventif"];

function BottleStepper({label,value,onChange,max=2}){
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 0"}}>
      <div style={{fontSize:13,fontWeight:700}}>{label}</div>
      <div style={{display:"flex",alignItems:"center",background:CK_C.bg,border:`1px solid ${CK_C.border}`,borderRadius:10,overflow:"hidden"}}>
        <button onClick={()=>onChange(Math.max(0,value-1))} style={{width:34,height:36,background:"transparent",border:"none",color:CK_C.muted,fontSize:18}}>−</button>
        <div style={{minWidth:32,textAlign:"center",fontWeight:800,fontSize:15,color:value>0?"#3b82f6":CK_C.text}}>{value}</div>
        <button onClick={()=>onChange(Math.min(max,value+1))} style={{width:34,height:36,background:"transparent",border:"none",color:CK_C.muted,fontSize:18}}>+</button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════
// RÉSERVE OXYGÈNE — compteurs, échanges véhicules, livraison fournisseur
// ═══════════════════════════════════════
function O2ReserveView({ onBack, themeMode, toggleTheme, emails }){
  const [reserve,setReserve]=useState(normO2Reserve(null));
  const [screen,setScreen]=useState("home"); // home | vehicle | fournisseur | historique | corriger
  const [selectedVehicle,setSelectedVehicle]=useState(null);
  const [sortie,setSortie]=useState({B2:0,B5:0,B10:0});
  const [entree,setEntree]=useState({B2:0,B5:0,B10:0});
  const [vName,setVName]=useState("");
  const [saving,setSaving]=useState(false);
  const [savedMsg,setSavedMsg]=useState(null);
  const [fSortie,setFSortie]=useState({B2:0,B5:0,B10:0});
  const [fEntree,setFEntree]=useState({B2:0,B5:0,B10:0});
  const [fSaving,setFSaving]=useState(false);

  const [cDraft,setCDraft]=useState(null);
  const [cName,setCName]=useState("");

  useEffect(()=>{
    const unsub=onSnapshot(doc(dbChecklists,"stockapp_o2","reserve"), snap=>{
      const d=snap.exists()?snap.data():O2_EMPTY_RESERVE;
      setReserve(normO2Reserve(d));
    });
    return ()=>unsub();
  },[]);

  const resetVehicleForm=()=>{ setSortie({B2:0,B5:0,B10:0}); setEntree({B2:0,B5:0,B10:0}); setVName(""); };
  const canSendVehicle = vName.trim().length>0 && (Object.values(sortie).some(v=>v>0)||Object.values(entree).some(v=>v>0)) && !saving;

  const handleSendVehicle=async()=>{
    if(!canSendVehicle) return;
    setSaving(true);
    const {current,next}=await applyO2Movement("vehicule", sortie, entree, { vehicle:selectedVehicle, name:vName.trim() });
    await checkAndSendO2LowStock(current,next,emails);
    setSaving(false);
    setSavedMsg("✅ Mouvement enregistré");
    resetVehicleForm();
    setTimeout(()=>{ setSavedMsg(null); setScreen("home"); setSelectedVehicle(null); }, 1200);
  };

  const canSendFournisseur = (Object.values(fSortie).some(v=>v>0)||Object.values(fEntree).some(v=>v>0)) && !fSaving;
  const handleSendFournisseur=async()=>{
    if(!canSendFournisseur) return;
    setFSaving(true);
    const {current,next}=await applyO2Movement("fournisseur", fSortie, fEntree, {});
    await checkAndSendO2LowStock(current,next,emails);
    setFSaving(false);
    setFSortie({B2:0,B5:0,B10:0});
    setFEntree({B2:0,B5:0,B10:0});
    setScreen("home");
  };

  const headerBar = (title) => (
    <div style={{ background:CK_C.panel, borderBottom:`1px solid ${CK_C.border}`, padding:"14px 16px", display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10, position:"sticky", top:0, zIndex:10 }}>
      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
        <button onClick={()=>{ if(screen==="home"){onBack();}else{setScreen("home");setSelectedVehicle(null);resetVehicleForm();} }} style={{ background:"transparent", border:`1px solid ${CK_C.border}`, borderRadius:8, color:CK_C.muted, padding:"6px 12px", fontSize:14, cursor:"pointer" }}>←</button>
        <div style={{ fontWeight:800, fontSize:16 }}>{title}</div>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        {screen==="home"&&<button onClick={()=>{ setCDraft(JSON.parse(JSON.stringify(reserve))); setCName(""); setScreen("corriger"); }} style={{background:CK_C.panel2,border:`1px solid ${CK_C.border}`,borderRadius:8,color:CK_C.muted,padding:"6px 12px",fontSize:11,fontWeight:600,cursor:"pointer"}}>✏️ Corriger</button>}
        {screen==="home"&&<button onClick={()=>setScreen("historique")} style={{background:CK_C.panel2,border:`1px solid ${CK_C.border}`,borderRadius:8,color:CK_C.muted,padding:"6px 12px",fontSize:11,fontWeight:600,cursor:"pointer"}}>📅 Historique</button>}
        {screen==="home"&&<button onClick={()=>setScreen("fournisseur")} style={{background:CK_C.panel2,border:`1px solid ${CK_C.border}`,borderRadius:8,color:CK_C.muted,padding:"6px 12px",fontSize:11,fontWeight:600,cursor:"pointer"}}>🚚 Livraison fournisseur</button>}
        <button onClick={toggleTheme} style={{background:CK_C.panel2,border:`1px solid ${CK_C.border}`,borderRadius:8,color:CK_C.muted,padding:"6px 12px",fontSize:11,fontWeight:600,cursor:"pointer"}}>{themeMode==="light"?"🌙":"☀️"}</button>
      </div>
    </div>
  );

  if(screen==="corriger"&&cDraft){
    const setP=(k,s,v)=>setCDraft(p=>({ ...p, [k]:{ ...p[k], [s]:v } }));
    const setV=(veh,s,v)=>setCDraft(p=>({ ...p, vehicules:{ ...p.vehicules, [veh]:{ ...p.vehicules[veh], [s]:v } } }));
    const canSave=cName.trim().length>0;
    const save=()=>{
      if(!canSave) return;
      applyO2Correction(cDraft,cName.trim()).catch(e=>console.error(e));
      rememberName(cName);
      setCDraft(null); setScreen("home");
    };
    const box={ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:12, padding:"16px", marginBottom:14 };
    return(
      <div style={{ minHeight:"100vh", background:CK_C.bg, fontFamily:"'DM Sans',sans-serif", color:CK_C.text, display:"flex", flexDirection:"column" }}>
        <style>{CK_GS}</style>
        {headerBar("✏️ Corriger l'O₂")}
        <div style={{ flex:1, padding:"18px", maxWidth:420, margin:"0 auto", width:"100%" }}>
          <div style={{ fontSize:12, color:CK_C.muted, marginBottom:14 }}>Encode ce qui est réellement là. Les chiffres remplacent les anciens.</div>
          <div style={box}>
            <div style={{ fontSize:11, fontWeight:700, color:"#3b82f6", textTransform:"uppercase", marginBottom:4 }}>Stock — bouteilles pleines</div>
            {O2_SIZES.map(s=>(<BottleStepper key={s} label={s} value={cDraft.pleines[s]||0} onChange={v=>setP("pleines",s,v)} max={99}/>))}
          </div>
          <div style={box}>
            <div style={{ fontSize:11, fontWeight:700, color:CK_C.muted, textTransform:"uppercase", marginBottom:4 }}>Stock — bouteilles vides</div>
            {O2_SIZES.map(s=>(<BottleStepper key={s} label={s} value={cDraft.vides[s]||0} onChange={v=>setP("vides",s,v)} max={99}/>))}
          </div>
          {O2_VEHICLES.map(veh=>(
            <div key={veh} style={box}>
              <div style={{ fontSize:11, fontWeight:700, color:CK_C.success, textTransform:"uppercase", marginBottom:4 }}>{veh==="Préventif"?"🧰 Préventif":`🚑 ${veh}`} — bouteilles dedans</div>
              {O2_SIZES.map(s=>(<BottleStepper key={s} label={s} value={cDraft.vehicules[veh][s]||0} onChange={v=>setV(veh,s,v)} max={9}/>))}
            </div>
          ))}
          <input value={cName} onChange={e=>setCName(e.target.value)} placeholder="Ton nom (obligatoire)*" style={{ width:"100%", background:CK_C.bg, border:`1px solid ${cName.trim()?CK_C.border:CK_C.danger}`, borderRadius:8, padding:"10px 12px", color:CK_C.text, fontSize:13, marginBottom:14, boxSizing:"border-box" }}/>
          <button disabled={!canSave} onClick={save} style={{ width:"100%", background:canSave?CK_C.success:CK_C.border, border:"none", borderRadius:10, color:"white", padding:"14px", fontWeight:800, fontSize:15, marginBottom:30 }}>✅ Enregistrer la correction</button>
        </div>
      </div>
    );
  }

  if(screen==="historique"){
    return <O2HistoriqueSubView onBack={()=>setScreen("home")} themeMode={themeMode} toggleTheme={toggleTheme}/>;
  }

  if(screen==="fournisseur"){
    return(
      <div style={{ minHeight:"100vh", background:CK_C.bg, fontFamily:"'DM Sans',sans-serif", color:CK_C.text, display:"flex", flexDirection:"column" }}>
        <style>{CK_GS}</style>
        {headerBar("🚚 Livraison fournisseur")}
        <div style={{ flex:1, padding:"18px", maxWidth:420, margin:"0 auto", width:"100%" }}>
          <div style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:12, padding:"16px", marginBottom:14 }}>
            <div style={{ fontSize:11, fontWeight:700, color:CK_C.danger, textTransform:"uppercase", marginBottom:4 }}>Sortie</div>
            <div style={{ fontSize:10, color:CK_C.muted, marginBottom:6 }}>Vides reprises par le fournisseur</div>
            {O2_SIZES.map(s=>(<BottleStepper key={s} label={s} value={fSortie[s]} onChange={v=>setFSortie(p=>({...p,[s]:v}))} max={99}/>))}
          </div>
          <div style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:12, padding:"16px", marginBottom:16 }}>
            <div style={{ fontSize:11, fontWeight:700, color:CK_C.success, textTransform:"uppercase", marginBottom:4 }}>Entrée</div>
            <div style={{ fontSize:10, color:CK_C.muted, marginBottom:6 }}>Pleines livrées par le fournisseur</div>
            {O2_SIZES.map(s=>(<BottleStepper key={s} label={s} value={fEntree[s]} onChange={v=>setFEntree(p=>({...p,[s]:v}))} max={99}/>))}
          </div>
          <button disabled={!canSendFournisseur} onClick={handleSendFournisseur} style={{ width:"100%", background:canSendFournisseur?CK_C.success:CK_C.border, border:"none", borderRadius:10, color:"white", padding:"14px", fontWeight:800, fontSize:15, cursor:canSendFournisseur?"pointer":"not-allowed", opacity:canSendFournisseur?1:0.6 }}>
            {fSaving?"Envoi…":"✅ Enregistrer"}
          </button>
        </div>
      </div>
    );
  }

  if(screen==="vehicle"&&selectedVehicle){
    return(
      <div style={{ minHeight:"100vh", background:CK_C.bg, fontFamily:"'DM Sans',sans-serif", color:CK_C.text, display:"flex", flexDirection:"column" }}>
        <style>{CK_GS}</style>
        {headerBar(selectedVehicle==="Préventif"?"🧰 Préventif":`🚑 ${selectedVehicle}`)}
        <div style={{ flex:1, padding:"18px", maxWidth:420, margin:"0 auto", width:"100%" }}>
          {savedMsg?(
            <div style={{ background:CK_C.successSoft, border:`1px solid ${CK_C.success}`, borderRadius:10, padding:"16px", textAlign:"center", fontWeight:700, color:CK_C.success }}>{savedMsg}</div>
          ):(
            <>
              <div style={{ background:CK_C.panel2, border:`1px solid ${CK_C.border}`, borderRadius:12, padding:"12px 16px", marginBottom:14, fontSize:13, fontWeight:700 }}>
                Dans {selectedVehicle} : <span style={{ color:"#3b82f6" }}>{o2ContentText(reserve.vehicules[selectedVehicle])}</span>
              </div>
              <div style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:12, padding:"16px", marginBottom:14 }}>
                <div style={{ fontSize:11, fontWeight:700, color:CK_C.danger, textTransform:"uppercase", marginBottom:4 }}>Sortie</div>
                <div style={{ fontSize:10, color:CK_C.muted, marginBottom:6 }}>Bouteille(s) retirée(s) du véhicule</div>
                {O2_SIZES.map(s=>(<BottleStepper key={s} label={s} value={sortie[s]} onChange={v=>setSortie(p=>({...p,[s]:v}))}/>))}
              </div>
              <div style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:12, padding:"16px", marginBottom:14 }}>
                <div style={{ fontSize:11, fontWeight:700, color:CK_C.success, textTransform:"uppercase", marginBottom:4 }}>Entrée</div>
                <div style={{ fontSize:10, color:CK_C.muted, marginBottom:6 }}>Bouteille(s) installée(s) dans le véhicule</div>
                {O2_SIZES.map(s=>(<BottleStepper key={s} label={s} value={entree[s]} onChange={v=>setEntree(p=>({...p,[s]:v}))}/>))}
              </div>
              <input value={vName} onChange={e=>setVName(e.target.value)} placeholder="Ton nom (obligatoire)*" style={{ width:"100%", background:CK_C.bg, border:`1px solid ${vName.trim()?CK_C.border:CK_C.danger}`, borderRadius:8, padding:"10px 12px", color:CK_C.text, fontSize:13, marginBottom:14, boxSizing:"border-box" }}/>
              <button disabled={!canSendVehicle} onClick={handleSendVehicle} style={{ width:"100%", background:canSendVehicle?CK_C.success:CK_C.border, border:"none", borderRadius:10, color:"white", padding:"14px", fontWeight:800, fontSize:15, cursor:canSendVehicle?"pointer":"not-allowed", opacity:canSendVehicle?1:0.6 }}>
                {saving?"Envoi…":"✅ Enregistrer"}
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  return(
    <div style={{ minHeight:"100vh", background:CK_C.bg, fontFamily:"'DM Sans',sans-serif", color:CK_C.text, display:"flex", flexDirection:"column" }}>
      <style>{CK_GS}</style>
      {headerBar("O₂ Réserve")}
      <div style={{ display:"flex", gap:8, padding:"16px 18px 0" }}>
        {O2_SIZES.map(s=>{
          const low=(reserve.pleines[s]||0)<=2;
          return(
            <div key={s} style={{ flex:1, background:low?CK_C.dangerSoft:CK_C.panel, border:`1px solid ${low?CK_C.danger:CK_C.border}`, borderRadius:12, padding:"12px", textAlign:"center" }}>
              <div style={{ fontSize:22, fontWeight:900, color:low?CK_C.danger:"#3b82f6" }}>{reserve.pleines[s]||0}</div>
              <div style={{ fontSize:10, color:low?CK_C.danger:CK_C.muted, fontWeight:700, marginTop:2 }}>{s} pleines</div>
            </div>
          );
        })}
      </div>
      <div style={{ flex:1, padding:"18px", maxWidth:480, margin:"0 auto", width:"100%" }}>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
          {O2_VEHICLES.map(v=>(
            <button key={v} onClick={()=>{setSelectedVehicle(v);setScreen("vehicle");}} style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:12, padding:"18px 10px", color:CK_C.text, fontWeight:700, fontSize:14, cursor:"pointer" }}>
              {v==="Préventif"?"🧰 Préventif":`🚑 ${v}`}
              <div style={{ fontSize:10, fontWeight:600, color:CK_C.muted, marginTop:4 }}>{o2ContentText(reserve.vehicules[v])}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ALERTE PÉREMPTION — 1 seul mail regroupant tous les produits périmés,
// classés par véhicule. Un lot est considéré périmé dès le 1er jour du mois
// indiqué sur sa date. Chaque lot n'est signalé qu'une seule fois.
// ═══════════════════════════════════════════════════════════════
async function checkAndSendPeremptionAlerts(checklistsData, peremptionEmails){
  if(!peremptionEmails||peremptionEmails.length===0) return;
  try{
    const cur=getChecklistMonthKey(); // "YYYY-MM" du mois en cours
    const snap=await getDocs(collection(dbChecklists,"stockapp_stock"));
    const found=[]; // { vehicle, itemName, quantite, date }
    const toMark=[]; // docs à marquer comme signalés
    for(const d of snap.docs){
      const data=d.data();
      const already=new Set(data.expiredNotified||[]);
      const fresh=(data.lots||[]).filter(l=>l.date&&l.date<=cur&&(l.quantite||0)>0&&!already.has(l.id));
      if(fresh.length===0) continue;
      fresh.forEach(l=>found.push({ vehicle:data.vehicle, itemName:data.itemName, quantite:l.quantite, date:l.date }));
      toMark.push({ id:d.id, data, ids:fresh.map(l=>l.id) });
    }
    if(found.length===0) return;

    // On marque d'abord (pour éviter un doublon si l'app est ouverte sur 2 appareils)
    for(const m of toMark){
      const prev=m.data.expiredNotified||[];
      await setDoc(doc(dbChecklists,"stockapp_stock",m.id), {...m.data, expiredNotified:[...prev,...m.ids]});
    }

    const byVehicle={};
    found.forEach(f=>{ (byVehicle[f.vehicle]=byVehicle[f.vehicle]||[]).push(f); });
    const lines=Object.keys(byVehicle).sort((a,b)=>a.localeCompare(b,"fr",{numeric:true})).map(v=>{
      const items=byVehicle[v].sort((a,b)=>a.date.localeCompare(b.date)||a.itemName.localeCompare(b.itemName,"fr"))
        .map(f=>`   • ${f.itemName} — ${f.quantite}× (péremption ${monthYearLabel(f.date)})`).join("\n");
      return `🚑 ${v}\n${items}`;
    }).join("\n\n");
    const content=`Produits périmés à remplacer (${found.length} lot${found.length>1?"s":""}) :\n\n${lines}`;

    for(const to of peremptionEmails){
      try{
        await emailjs.send("service_mrs8v2l","template_2sxsq4j",{ to_email:to, title:"Alerte Péremption — produits périmés à remplacer", content },"Fhdx1kTE7vFmh4z07");
      }catch(e){ console.error("Erreur envoi email péremption:", e); }
    }
  }catch(e){ console.error("Erreur vérification alertes péremption:", e); }
}

// ═══════════════════════════════════════════════════════════════
// RÉAPPRO VÉHICULES — Ambu / TPMR → liste des véhicules → produits → entrée / sortie
// ═══════════════════════════════════════════════════════════════
function Stepper({ value, onChange, min=1, max=999 }){
  return(
    <div style={{ display:"flex", alignItems:"center", background:CK_C.bg, border:`1px solid ${CK_C.border}`, borderRadius:12, overflow:"hidden" }}>
      <button onClick={()=>onChange(Math.max(min,value-1))} style={{ width:52, height:48, background:"transparent", border:"none", color:CK_C.text, fontSize:24 }}>−</button>
      <div style={{ minWidth:56, textAlign:"center", fontSize:22, fontWeight:900, borderLeft:`1px solid ${CK_C.border}`, borderRight:`1px solid ${CK_C.border}`, height:48, display:"flex", alignItems:"center", justifyContent:"center" }}>{value}</div>
      <button onClick={()=>onChange(Math.min(max,value+1))} style={{ width:52, height:48, background:"transparent", border:"none", color:CK_C.text, fontSize:24 }}>+</button>
    </div>
  );
}

// Fiche produit : entrée / sortie (nom obligatoire), seuil, correction du stock.
function ProductSheet({ vehicle, entry, stockDoc, pct, initialised, stockEmails, onClose, onSaved }){
  const [mode,setMode]=useState("sortie"); // sortie | entree | correction
  const [qty,setQty]=useState(1);
  const [date,setDate]=useState("");
  const [name,setName]=useState("");
  const [saving,setSaving]=useState(false);
  const [minInput,setMinInput]=useState(stockDoc&&stockDoc.min!=null?String(stockDoc.min):"");
  const [corrLots,setCorrLots]=useState(()=>sortLots(stockDoc&&stockDoc.lots).map(l=>({...l})));

  const lots=sortLots(stockDoc&&stockDoc.lots);
  const total=lotsTotal(lots);
  const minEff=effectiveMin(stockDoc,entry.q,pct);
  const low=initialised && minEff>0 && total<minEff;
  const nameOk=name.trim().length>0;
  const dateOk=mode!=="entree"||!entry.p||date.length>0;
  const qtyOk=mode==="correction"?true:qty>0;
  const canSave=nameOk&&dateOk&&qtyOk&&!saving;

  const save=async()=>{
    if(!canSave) return;
    setSaving(true);
    try{
      if(mode==="correction"){
        await applyStockCorrection({ vehicle, itemName:entry.name, lots:corrLots, by:name.trim() });
        onSaved(`✅ Stock corrigé : ${entry.name}`);
      }else{
        const r=await applyStockMovement({ vehicle, itemName:entry.name, type:mode, qty, date:mode==="entree"?date:"", by:name.trim(), minValue:initialised?minEff:0, emails:stockEmails });
        onSaved(`✅ ${mode==="entree"?"Entrée":"Sortie"} enregistrée : ${qty} × ${entry.name} (stock ${r.after})`);
      }
      rememberName(name);
      onClose();
    }catch(e){ console.error("Erreur mouvement stock:", e); setSaving(false); }
  };
  const saveMin=async()=>{ try{ await setStockMin(vehicle, entry.name, minInput); }catch(e){ console.error(e); } };

  const tabBtn=(id,label,color)=>(
    <button onClick={()=>setMode(id)} style={{ flex:1, padding:"13px 6px", borderRadius:10, border:`2px solid ${mode===id?color:CK_C.border}`, background:mode===id?color:"transparent", color:mode===id?"white":CK_C.muted, fontWeight:800, fontSize:14 }}>{label}</button>
  );

  return(
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.75)", display:"flex", alignItems:"flex-end", justifyContent:"center", zIndex:500 }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:"18px 18px 0 0", width:"100%", maxWidth:520, maxHeight:"92vh", overflowY:"auto", padding:"18px 18px 28px" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
          <div>
            <div style={{ fontWeight:800, fontSize:17 }}>{entry.name}</div>
            <div style={{ fontSize:11, color:CK_C.muted, marginTop:2 }}>{vehicle} · requis : {entry.q}{entry.p?" · péremption":""}</div>
          </div>
          <button onClick={onClose} style={{ background:"transparent", border:"none", color:CK_C.muted, fontSize:26, lineHeight:1 }}>×</button>
        </div>

        <div style={{ background:low?CK_C.dangerSoft:CK_C.bg, border:`1px solid ${low?CK_C.danger:CK_C.border}`, borderRadius:12, padding:"12px 14px", marginBottom:14 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div style={{ fontSize:12, color:CK_C.muted, fontWeight:700, textTransform:"uppercase" }}>Stock actuel</div>
            <div style={{ fontSize:26, fontWeight:900, color:low?CK_C.danger:CK_C.text }}>{total}{low&&<span style={{ fontSize:12, marginLeft:8 }}>⚠ sous le seuil ({minEff})</span>}</div>
          </div>
          {lots.length>0&&entry.p&&(
            <div style={{ marginTop:8, paddingTop:8, borderTop:`1px dashed ${CK_C.border}` }}>
              {lots.map(l=>(
                <div key={l.id} style={{ display:"flex", justifyContent:"space-between", fontSize:12, padding:"2px 0" }}>
                  <span style={{ fontWeight:700 }}>{l.quantite}×</span>
                  <span style={{ color:l.date?CK_C.text:CK_C.warning, fontWeight:600 }}>{l.date?monthYearLabel(l.date):"date à renseigner"}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display:"flex", gap:8, marginBottom:14 }}>
          {tabBtn("sortie","➖ Sortie",CK_C.danger)}
          {tabBtn("entree","➕ Entrée",CK_C.success)}
          {tabBtn("correction","✏️ Corriger",CK_C.accent)}
        </div>

        <NameField value={name} onChange={setName} label="Ton nom"/>

        {mode!=="correction"&&(
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, marginBottom:12 }}>
            <div style={{ fontSize:13, fontWeight:700 }}>{mode==="sortie"?"Quantité utilisée":"Quantité ajoutée"}</div>
            <Stepper value={qty} onChange={setQty}/>
          </div>
        )}
        {mode==="sortie"&&qty>total&&(
          <div style={{ background:CK_C.warning+"22", border:`1px solid ${CK_C.warning}`, borderRadius:8, padding:"8px 10px", fontSize:11, color:CK_C.warning, fontWeight:600, marginBottom:12 }}>
            Le stock affiché est {total} : il tombera à 0 (l'écart sera noté dans l'historique).
          </div>
        )}
        {mode==="entree"&&entry.p&&(
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, marginBottom:12 }}>
            <div style={{ fontSize:13, fontWeight:700, color:date?CK_C.text:CK_C.danger }}>Date de péremption*</div>
            <MonthYearPicker value={date} onChange={setDate} danger={!date}/>
          </div>
        )}

        {mode==="correction"&&(
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:11, color:CK_C.muted, marginBottom:8 }}>Remplace le stock de ce produit (inventaire / erreur de saisie).</div>
            {corrLots.map((l,i)=>(
              <div key={l.id||i} style={{ display:"flex", gap:6, alignItems:"center", marginBottom:6 }}>
                <input type="number" min="0" value={l.quantite} onChange={e=>setCorrLots(p=>p.map((x,j)=>j===i?{...x,quantite:Math.max(0,parseInt(e.target.value)||0)}:x))} style={{ width:70, background:CK_C.bg, border:`1px solid ${CK_C.border}`, borderRadius:8, padding:"9px", color:CK_C.text, fontSize:14 }}/>
                {entry.p?<div style={{ flex:1 }}><MonthYearPicker value={l.date||""} onChange={v=>setCorrLots(p=>p.map((x,j)=>j===i?{...x,date:v}:x))}/></div>:<div style={{ flex:1 }}/>}
                <button onClick={()=>setCorrLots(p=>p.filter((_,j)=>j!==i))} style={{ background:CK_C.dangerSoft, border:`1px solid ${CK_C.danger}`, borderRadius:6, color:CK_C.danger, padding:"7px 9px", fontSize:12 }}>🗑</button>
              </div>
            ))}
            {(entry.p||corrLots.length===0)&&<button onClick={()=>setCorrLots(p=>[...p,{ id:"lot"+Date.now()+p.length, quantite:1, date:"" }])} style={{ background:"transparent", border:`1px dashed ${CK_C.border}`, borderRadius:8, color:CK_C.muted, padding:"8px 12px", fontSize:12 }}>+ {entry.p?"Lot":"Quantité"}</button>}
          </div>
        )}

        <button disabled={!canSave} onClick={save} style={{ width:"100%", background:canSave?(mode==="sortie"?CK_C.danger:mode==="entree"?CK_C.success:CK_C.accent):CK_C.border, border:"none", borderRadius:12, color:"white", padding:"15px", fontWeight:800, fontSize:16, opacity:canSave?1:0.6, cursor:canSave?"pointer":"not-allowed" }}>
          {saving?"Enregistrement…":!nameOk?"Indique ton nom":!dateOk?"Date de péremption requise":"✅ Enregistrer"}
        </button>

        <div style={{ marginTop:16, paddingTop:12, borderTop:`1px solid ${CK_C.border}`, display:"flex", alignItems:"center", justifyContent:"space-between", gap:10 }}>
          <div style={{ fontSize:12, color:CK_C.muted }}>Seuil minimum<div style={{ fontSize:10 }}>vide = seuil par défaut ({pct||0}% → {Math.ceil(entry.q*(pct||0)/100)})</div></div>
          <input type="number" min="0" value={minInput} onChange={e=>setMinInput(e.target.value)} onBlur={saveMin} placeholder="défaut" style={{ width:90, background:CK_C.bg, border:`1px solid ${CK_C.border}`, borderRadius:8, padding:"9px", color:CK_C.text, fontSize:14, textAlign:"center" }}/>
        </div>
      </div>
    </div>
  );
}

// Liste des produits d'un véhicule
function VehicleProducts({ vehicle, catalogue, stockInit, setStockInit, pct, stockEmails, onBack, themeMode, toggleTheme }){
  const stockMap=useStockMap();
  const [search,setSearch]=useState("");
  const [sel,setSel]=useState(null);
  const [toast,setToast]=useState(null);
  const [initName,setInitName]=useState("");
  const [showInit,setShowInit]=useState(false);
  const [initBusy,setInitBusy]=useState(false);
  const initialised=!!(stockInit&&stockInit[vehicle]);

  const showToast=(msg)=>{ setToast(msg); setTimeout(()=>setToast(null),3500); };
  const filtered=catalogue.filter(e=>!search.trim()||e.name.toLowerCase().includes(search.trim().toLowerCase()));
  const groups=[];
  filtered.forEach(e=>{
    const label=e.section+(e.shelf?` — ${e.shelf}`:"");
    let g=groups[groups.length-1];
    if(!g||g.label!==label){ g={label,items:[]}; groups.push(g); }
    g.items.push(e);
  });
  const lowCount=initialised?catalogue.filter(e=>isLow(stockMap,e,pct)).length:0;

  const doInit=async()=>{
    if(!initName.trim()||initBusy) return;
    setInitBusy(true);
    try{
      await initVehicleStock(vehicle, catalogue, stockMap, initName.trim());
      rememberName(initName);
      setStockInit(p=>({...p,[vehicle]:Date.now()}));
      setShowInit(false);
      showToast("✅ Stock initialisé avec les quantités standard");
    }catch(e){ console.error("Erreur initialisation stock:", e); }
    setInitBusy(false);
  };

  return(
    <Page>
      <TopBar title={`🚑 ${vehicle}`} subtitle={`${catalogue.length} produits${lowCount>0?` · ${lowCount} sous le seuil`:""}`} onBack={onBack} themeMode={themeMode} toggleTheme={toggleTheme}/>
      <div style={{ padding:"12px 14px 0", maxWidth:640, margin:"0 auto", width:"100%" }}>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Rechercher un produit…" style={{ width:"100%", background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:10, padding:"11px 14px", color:CK_C.text, fontSize:14 }}/>
        {!initialised&&(
          <div style={{ background:CK_C.warning+"22", border:`1px solid ${CK_C.warning}`, borderRadius:12, padding:"12px 14px", marginTop:12 }}>
            <div style={{ fontSize:13, fontWeight:800, color:CK_C.warning }}>Stock de ce véhicule non initialisé</div>
            <div style={{ fontSize:11, color:CK_C.muted, margin:"4px 0 10px" }}>Démarre chaque produit à sa quantité standard (celle de la checklist). Ensuite, tu corriges produit par produit si besoin avec « Corriger ».</div>
            <button onClick={()=>setShowInit(true)} style={{ background:CK_C.warning, border:"none", borderRadius:9, color:"white", padding:"10px 16px", fontWeight:800, fontSize:13 }}>Initialiser le stock</button>
          </div>
        )}
        {toast&&<div style={{ background:CK_C.successSoft, border:`1px solid ${CK_C.success}`, borderRadius:10, padding:"10px 12px", marginTop:12, fontSize:12, color:CK_C.success, fontWeight:700 }}>{toast}</div>}
      </div>
      <div style={{ flex:1, padding:"12px 14px 40px", maxWidth:640, margin:"0 auto", width:"100%" }}>
        {catalogue.length===0&&<div style={{ textAlign:"center", color:CK_C.muted, padding:40 }}>Aucun produit défini pour ce véhicule (Paramètres → Checklists)</div>}
        {groups.map(g=>(
          <div key={g.label} style={{ marginBottom:14 }}>
            <div style={{ fontSize:11, fontWeight:800, color:CK_C.muted, textTransform:"uppercase", letterSpacing:"1px", margin:"6px 2px 6px" }}>{g.label}</div>
            {g.items.map(e=>{
              const d=stockMap[e.key];
              const total=lotsTotal(d&&d.lots);
              const low=initialised&&isLow(stockMap,e,pct);
              const soon=getSoonestDate(d&&d.lots);
              const nowYM=getChecklistMonthKey();
              const expired=e.p&&soon&&soon<=nowYM;
              return(
                <button key={e.key} onClick={()=>setSel(e)} style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, background:low?CK_C.dangerSoft:CK_C.panel, border:`1px solid ${low||expired?CK_C.danger:CK_C.border}`, borderRadius:12, padding:"12px 14px", marginBottom:7, color:CK_C.text, textAlign:"left" }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, fontWeight:700 }}>{e.name}</div>
                    {e.p&&<div style={{ fontSize:11, marginTop:2, color:expired?CK_C.danger:CK_C.muted }}>{soon?`Péremption : ${monthYearLabel(soon)}${expired?" ⚠":""}`:"Péremption : à renseigner"}</div>}
                  </div>
                  <div style={{ textAlign:"right" }}>
                    <div style={{ fontSize:20, fontWeight:900, color:low?CK_C.danger:CK_C.text }}>{total}</div>
                    <div style={{ fontSize:10, color:CK_C.muted }}>requis {e.q}</div>
                  </div>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {sel&&<ProductSheet key={sel.key} vehicle={vehicle} entry={sel} stockDoc={stockMap[sel.key]} pct={pct} initialised={initialised} stockEmails={stockEmails} onClose={()=>setSel(null)} onSaved={showToast}/>}

      {showInit&&(
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600 }}>
          <div style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:16, padding:"22px", width:380, maxWidth:"92vw" }}>
            <div style={{ fontWeight:800, fontSize:16, marginBottom:8 }}>Initialiser le stock de {vehicle}</div>
            <div style={{ fontSize:12, color:CK_C.muted, marginBottom:14 }}>Les produits sans stock démarrent à leur quantité requise. Les lots déjà enregistrés sont conservés.</div>
            <NameField value={initName} onChange={setInitName} label="Ton nom"/>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={()=>setShowInit(false)} style={{ flex:1, background:CK_C.panel2, border:`1px solid ${CK_C.border}`, borderRadius:9, color:CK_C.muted, padding:"11px", fontWeight:700 }}>Annuler</button>
              <button disabled={!initName.trim()||initBusy} onClick={doInit} style={{ flex:1, background:initName.trim()?CK_C.success:CK_C.border, border:"none", borderRadius:9, color:"white", padding:"11px", fontWeight:800, opacity:initName.trim()?1:0.6 }}>{initBusy?"…":"✅ Initialiser"}</button>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

// Réappro véhicules : choix Ambu / TPMR → véhicules → produits
function ReapproVehicules({ checklists, tpmrVslTemplate, stockInit, setStockInit, pct, stockEmails, onBack, themeMode, toggleTheme }){
  const stockMap=useStockMap();
  const [kind,setKind]=useState(null); // "AMB" | "TPMR"
  const [vehicle,setVehicle]=useState(null);

  const ambNames=Object.keys(checklists).sort((a,b)=>a.localeCompare(b));
  const lowFor=(v)=>{
    if(!(stockInit&&stockInit[v])) return 0;
    return buildCatalogue(v,checklists,tpmrVslTemplate).filter(e=>isLow(stockMap,e,pct)).length;
  };

  if(vehicle){
    return <VehicleProducts vehicle={vehicle} catalogue={buildCatalogue(vehicle,checklists,tpmrVslTemplate)} stockInit={stockInit} setStockInit={setStockInit} pct={pct} stockEmails={stockEmails} onBack={()=>setVehicle(null)} themeMode={themeMode} toggleTheme={toggleTheme}/>;
  }
  const bigBtn=(icon,label,sub,onClick,badge)=>(
    <button onClick={onClick} style={{ width:"100%", background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:16, padding:"22px 20px", color:CK_C.text, display:"flex", alignItems:"center", gap:16, textAlign:"left", marginBottom:12 }}>
      <div style={{ fontSize:34 }}>{icon}</div>
      <div style={{ flex:1 }}><div style={{ fontWeight:800, fontSize:17 }}>{label}</div><div style={{ fontSize:12, color:CK_C.muted, marginTop:2 }}>{sub}</div></div>
      <Badge n={badge}/>
      <span style={{ color:CK_C.muted, fontSize:20 }}>→</span>
    </button>
  );

  if(!kind){
    const lowAmb=ambNames.reduce((s,v)=>s+lowFor(v),0);
    const lowTpmr=TPMR_VSL_VEHICLES.reduce((s,v)=>s+lowFor(v),0);
    return(
      <Page>
        <TopBar title="📦 Réappro véhicules" subtitle="Choisis le type de véhicule" onBack={onBack} themeMode={themeMode} toggleTheme={toggleTheme}/>
        <div style={{ padding:20, maxWidth:480, margin:"0 auto", width:"100%" }}>
          {bigBtn("🚑","Ambu",`${ambNames.length} ambulances`,()=>setKind("AMB"),lowAmb)}
          {bigBtn("♿","TPMR / VSL",`${TPMR_VSL_VEHICLES.length} véhicules`,()=>setKind("TPMR"),lowTpmr)}
        </div>
      </Page>
    );
  }
  const names=kind==="AMB"?ambNames:TPMR_VSL_VEHICLES;
  return(
    <Page>
      <TopBar title={kind==="AMB"?"🚑 Ambulances":"♿ TPMR / VSL"} subtitle="Choisis le véhicule" onBack={()=>setKind(null)} themeMode={themeMode} toggleTheme={toggleTheme}/>
      <div style={{ padding:20, maxWidth:480, margin:"0 auto", width:"100%", display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
        {names.map(v=>{
          const low=lowFor(v);
          const init=!!(stockInit&&stockInit[v]);
          return(
            <button key={v} onClick={()=>setVehicle(v)} style={{ background:CK_C.panel, border:`1px solid ${low?CK_C.danger:CK_C.border}`, borderRadius:14, padding:"20px 10px", color:CK_C.text, fontWeight:800, fontSize:16, display:"flex", flexDirection:"column", alignItems:"center", gap:6 }}>
              <span>{kind==="AMB"?"🚑":"♿"} {v}</span>
              {!init?<span style={{ fontSize:10, color:CK_C.warning, fontWeight:700 }}>à initialiser</span>:low>0?<Badge n={`${low} sous le seuil`}/>:<span style={{ fontSize:10, color:CK_C.success, fontWeight:700 }}>✓ stock OK</span>}
            </button>
          );
        })}
      </div>
    </Page>
  );
}

// Remarque : message libre envoyé par email aux destinataires des checklists (repris tel quel).
function RemarqueModal({ emails, onClose }){
  const [text,setText]=useState("");
  const [author,setAuthor]=useState("");
  const [sending,setSending]=useState(false);
  const [sent,setSent]=useState(false);
  const canSend=author.trim().length>0 && text.trim().length>0 && !sending;
  const send=async()=>{
    if(!canSend) return;
    setSending(true);
    try{
      if(emails&&emails.length>0){
        for(const to of emails){
          await emailjs.send("service_mrs8v2l","template_2sxsq4j",{
            to_email: to,
            title: "Checklist Remarque",
            content: `${text.trim()}\n\n${author.trim()}`,
          }, "Fhdx1kTE7vFmh4z07");
        }
      }
    }catch(e){ console.error("Erreur envoi email remarque:", e); }
    setSending(false);
    setSent(true);
    setTimeout(()=>onClose(), 1800);
  };
  return(
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:400 }}>
      <div style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:16, padding:"24px", width:400, maxWidth:"92vw" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ fontWeight:800, fontSize:16 }}>📝 Remarque</div>
          <button onClick={onClose} style={{ background:"transparent", border:"none", color:CK_C.muted, fontSize:22, cursor:"pointer" }}>×</button>
        </div>
        {sent?(
          <div style={{ background:CK_C.successSoft, border:`1px solid ${CK_C.success}`, borderRadius:10, padding:"14px", textAlign:"center", fontWeight:700, color:CK_C.success }}>✅ Remarque envoyée !</div>
        ):(
          <>
            <div style={{ marginBottom:10 }}>
              <div style={{ fontSize:10, color:CK_C.muted, marginBottom:5, textTransform:"uppercase" }}>Ton nom*</div>
              <input value={author} onChange={e=>setAuthor(e.target.value)} placeholder="Nom (obligatoire)" style={{ width:"100%", background:CK_C.bg, border:`1px solid ${author.trim()?CK_C.border:CK_C.danger}`, borderRadius:8, padding:"9px 12px", color:CK_C.text, fontSize:13 }}/>
            </div>
            <div style={{ marginBottom:16 }}>
              <div style={{ fontSize:10, color:CK_C.muted, marginBottom:5, textTransform:"uppercase" }}>Remarque*</div>
              <textarea value={text} onChange={e=>setText(e.target.value)} placeholder="Une remarque sur le matériel, une checklist..." rows={4} style={{ width:"100%", background:CK_C.bg, border:`1px solid ${text.trim()?CK_C.border:CK_C.danger}`, borderRadius:8, padding:"9px 12px", color:CK_C.text, fontSize:13, resize:"none" }}/>
            </div>
            <button disabled={!canSend} onClick={send} style={{ width:"100%", background:canSend?CK_C.success:CK_C.border, border:"none", borderRadius:10, color:"white", padding:"12px", fontWeight:800, fontSize:14, cursor:canSend?"pointer":"not-allowed", opacity:canSend?1:0.6 }}>
              {sending?"Envoi…":"✅ Envoyer"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// Accueil Réappro : 3 icônes — O₂, Réappro véhicules, Remarque
function ReapproHome({ checklists, tpmrVslTemplate, stockInit, setStockInit, pct, stockEmails, remarqueEmails, o2Emails, onBack, onSettings, onHistory, themeMode, toggleTheme }){
  const stockMap=useStockMap();
  const [screen,setScreen]=useState("home"); // home | o2 | veh
  const [showRemarque,setShowRemarque]=useState(false);

  if(screen==="o2") return <O2ReserveView onBack={()=>setScreen("home")} themeMode={themeMode} toggleTheme={toggleTheme} emails={o2Emails}/>;
  if(screen==="veh") return <ReapproVehicules checklists={checklists} tpmrVslTemplate={tpmrVslTemplate} stockInit={stockInit} setStockInit={setStockInit} pct={pct} stockEmails={stockEmails} onBack={()=>setScreen("home")} themeMode={themeMode} toggleTheme={toggleTheme}/>;

  const lowTotal=allVehicleNames(checklists).reduce((s,v)=>{
    if(!(stockInit&&stockInit[v])) return s;
    return s+buildCatalogue(v,checklists,tpmrVslTemplate).filter(e=>isLow(stockMap,e,pct)).length;
  },0);
  const tile=(icon,label,sub,onClick,badge)=>(
    <button onClick={onClick} style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:20, padding:"26px 14px", color:CK_C.text, display:"flex", flexDirection:"column", alignItems:"center", gap:8, position:"relative", minHeight:150, justifyContent:"center" }}>
      <div style={{ fontSize:44, lineHeight:1 }}>{icon}</div>
      <div style={{ fontWeight:800, fontSize:16 }}>{label}</div>
      <div style={{ fontSize:11, color:CK_C.muted, textAlign:"center" }}>{sub}</div>
      {badge>0&&<div style={{ position:"absolute", top:10, right:10 }}><Badge n={badge}/></div>}
    </button>
  );
  return(
    <Page>
      <TopBar title="📦 Réappro" subtitle="Réserve · véhicules · remarques" onBack={onBack} themeMode={themeMode} toggleTheme={toggleTheme} onSettings={onSettings} onHistory={onHistory}/>
      <div style={{ padding:20, maxWidth:560, margin:"0 auto", width:"100%", display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:14 }}>
        {tile(<span style={{ color:"#3b82f6", fontWeight:900 }}>O₂</span>,"O₂","Réserve de bouteilles",()=>setScreen("o2"),0)}
        {tile("🚑","Réappro véhicules","Entrées et sorties de produits",()=>setScreen("veh"),lowTotal)}
        {tile("📝","Remarque","Message au responsable",()=>setShowRemarque(true),0)}
      </div>
      <ManquementsList checklists={checklists} tpmrVslTemplate={tpmrVslTemplate} stockInit={stockInit}/>
      {showRemarque&&<RemarqueModal emails={remarqueEmails} onClose={()=>setShowRemarque(false)}/>}
    </Page>
  );
}

// ═══════════════════════════════════════════════════════════════
// SCELLÉS — sacs / armoires scellés
//  • Modèles créés dans Paramètres → Scellés (cible : Ambu ou TPMR/VSL)
//  • Le Bureau déclenche une checklist pour un véhicule (tâche Firestore)
//  • La tâche apparaît dans Checklist → Scellé jusqu'à ce qu'elle soit envoyée
// Une tâche contient une copie du modèle : elle reste valable même si le
// modèle est modifié ou supprimé ensuite.
// ═══════════════════════════════════════════════════════════════
const SEALED_COL="stockapp_sealed_tasks";

function normalizeTemplateSections(sections){
  return (sections||[]).map(sec=>({
    ...sec,
    shelves:(sec.shelves||[]).map(sh=>({
      ...sh,
      items:(sh.items||[]).filter(it=>it.n&&it.n.trim()).map(it=>({ ...it, q:it.q||1 })),
    })),
  }));
}
// Sac TPMR/VSL : le modèle unique devient une vraie checklist avec comptage,
// identique à celle des ambulances, pour chacun des véhicules TPMR/VSL.
function buildTpmrChecklists(template){
  const sections=normalizeTemplateSections(template&&template.sections);
  const out={};
  if(sections.length===0) return out;
  TPMR_VSL_VEHICLES.forEach(v=>{ out[v]={ edition:"", norme:"TPMR / VSL", sections }; });
  return out;
}

function useSealedTasks(){
  const [tasks,setTasks]=useState([]);
  useEffect(()=>{
    const unsub=onSnapshot(collection(dbChecklists,SEALED_COL), snap=>{
      const list=[];
      snap.forEach(d=>list.push(d.data()));
      setTasks(list.filter(t=>t.status!=="done").sort((a,b)=>(a.createdAt||0)-(b.createdAt||0)));
    }, err=>console.error("Erreur lecture checklists scellées:", err));
    return ()=>unsub();
  },[]);
  return tasks;
}
// Avancement de chaque tâche (non commencée / en cours / complète).
function useSealedStatuses(tasks){
  const [statuses,setStatuses]=useState({});
  const sig=JSON.stringify(tasks.map(t=>t.id));
  useEffect(()=>{
    const unsubs=tasks.map(t=>{
      const ref=doc(dbChecklists,"stockapp_checklists",`${t.label}_${t.id}`);
      return onSnapshot(ref, snap=>{
        const checks=snap.exists()?(snap.data().checks||{}):{};
        setStatuses(prev=>({...prev, [t.id]: checklistStatus({ [t.label]:{ sections:t.sections } }, t.label, checks)}));
      }, ()=>{});
    });
    return ()=>unsubs.forEach(u=>u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[sig]);
  return statuses;
}

async function createSealedTasks(template, vehicles){
  for(const v of vehicles){
    const id="sc"+Date.now()+Math.floor(Math.random()*1000);
    // Pas de "await" : hors connexion l'écriture est mise en file et part toute seule au retour du réseau.
    setDoc(doc(dbChecklists,SEALED_COL,id), sanitizeUndefined({
      id, templateId:template.id, templateName:template.name, target:template.target, vehicle:v,
      label:`${template.name} — ${v}`.replace(/\//g,"-"),
      sections:normalizeTemplateSections(template.sections),
      createdAt:Date.now(), status:"open",
    })).catch(e=>console.error("Erreur création checklist scellée:", e));
  }
}
async function finishSealedTask(task){
  await setDoc(doc(dbChecklists,SEALED_COL,task.id), { status:"done", doneAt:Date.now() }, { merge:true });
}
async function cancelSealedTask(task){
  await deleteDoc(doc(dbChecklists,SEALED_COL,task.id));
}

// ── Checklist → Scellé : les checklists à faire ──
function SealedList({ onBack, emails, themeMode, toggleTheme }){
  const tasks=useSealedTasks();
  const statuses=useSealedStatuses(tasks);
  const [open,setOpen]=useState(null);
  if(open) return <ChecklistView vehicleName={open.label} onBack={()=>setOpen(null)} checklists={{ [open.label]:{ edition:"", norme:"scellé", sections:open.sections } }} emails={emails} sealedTask={open} onSealedDone={()=>finishSealedTask(open)} themeMode={themeMode} toggleTheme={toggleTheme}/>;
  return(
    <Page>
      <TopBar title="🔒 Scellé" subtitle="Sacs et armoires scellés" onBack={onBack} themeMode={themeMode} toggleTheme={toggleTheme}/>
      <div style={{ flex:1, padding:"20px", maxWidth:480, margin:"0 auto", width:"100%" }}>
        {tasks.length===0&&(
          <div style={{ textAlign:"center", color:CK_C.muted, padding:"50px 10px", fontSize:14 }}>
            Aucune checklist scellée à faire.<br/><span style={{ fontSize:11 }}>Le bureau en déclenche une quand un sac ou une armoire a été ouvert.</span>
          </div>
        )}
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {tasks.map(t=>{
            const st=statuses[t.id];
            const dotColor=st?.complete?CK_C.success:st?.started?"#f59e0b":CK_C.muted;
            const dotLabel=st?.complete?"✅ Prête à envoyer":st?.started?`🟠 En cours (${st.progress}%)`:"Non commencée";
            return(
              <button key={t.id} onClick={()=>setOpen(t)} style={{ background:CK_C.panel, border:`1px solid ${st?.complete?CK_C.success:st?.started?"#f59e0b":CK_C.border}`, borderRadius:13, padding:"16px 20px", color:CK_C.text, textAlign:"left", display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer" }}>
                <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                  <div style={{ width:42, height:42, background:CK_C.red, borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>🔒</div>
                  <div>
                    <div style={{ fontWeight:800, fontSize:15 }}>{t.label}</div>
                    <div style={{ fontSize:11, fontWeight:700, color:dotColor, marginTop:2 }}>{dotLabel}</div>
                  </div>
                </div>
                <span style={{ color:CK_C.muted, fontSize:20 }}>→</span>
              </button>
            );
          })}
        </div>
      </div>
    </Page>
  );
}

// ── Bureau : déclencher une checklist scellée pour un ou plusieurs véhicules ──
function BureauView({ onBack, checklists, sealedTemplates, themeMode, toggleTheme }){
  const tasks=useSealedTasks();
  const [tpl,setTpl]=useState(null);
  const [picked,setPicked]=useState([]);
  const [busy,setBusy]=useState(false);
  const [msg,setMsg]=useState("");

  const vehiclesFor=(t)=>t.target==="TPMR"
    ? TPMR_VSL_VEHICLES
    : Object.keys(checklists).sort((a,b)=>a.localeCompare(b,"fr",{numeric:true}));
  const alreadyOpen=(t,v)=>tasks.some(x=>x.templateId===t.id&&x.vehicle===v);
  const toggle=(v)=>setPicked(p=>p.includes(v)?p.filter(x=>x!==v):[...p,v]);

  const send=async()=>{
    if(!tpl||picked.length===0||busy) return;
    setBusy(true);
    try{
      await createSealedTasks(tpl, picked);
      setMsg(`✅ ${tpl.name} envoyé pour : ${picked.join(", ")}`);
      setTpl(null); setPicked([]);
    }catch(e){ console.error(e); setMsg("✗ Erreur lors de l'envoi, réessaie."); }
    setBusy(false);
  };
  const cancel=async(t)=>{
    if(!window.confirm(`Annuler la checklist « ${t.label} » ?`)) return;
    try{ await cancelSealedTask(t); }catch(e){ console.error(e); }
  };

  // Étape 2 : choix des véhicules
  if(tpl) return(
    <Page>
      <TopBar title={`🏢 ${tpl.name}`} subtitle={tpl.target==="TPMR"?"Choisis les TPMR / VSL":"Choisis les ambulances"} onBack={()=>{ setTpl(null); setPicked([]); }} themeMode={themeMode} toggleTheme={toggleTheme}/>
      <div style={{ flex:1, padding:"20px", maxWidth:480, margin:"0 auto", width:"100%" }}>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {vehiclesFor(tpl).map(v=>{
            const dejaDemande=alreadyOpen(tpl,v);
            const on=picked.includes(v);
            return(
              <button key={v} disabled={dejaDemande} onClick={()=>toggle(v)} style={{ background:on?CK_C.accentSoft:CK_C.panel, border:`1px solid ${on?CK_C.accent:CK_C.border}`, borderRadius:13, padding:"14px 18px", color:CK_C.text, textAlign:"left", display:"flex", alignItems:"center", justifyContent:"space-between", opacity:dejaDemande?0.5:1, cursor:dejaDemande?"not-allowed":"pointer" }}>
                <div style={{ fontWeight:800, fontSize:15 }}>{tpl.target==="TPMR"?"♿":"🚑"} {v}</div>
                <div style={{ fontSize:12, fontWeight:700, color:dejaDemande?"#f59e0b":on?CK_C.accent:CK_C.muted }}>{dejaDemande?"Déjà demandée":on?"✓ Choisi":""}</div>
              </button>
            );
          })}
        </div>
        <button disabled={picked.length===0||busy} onClick={send} style={{ width:"100%", marginTop:18, background:picked.length===0?CK_C.border:CK_C.success, border:"none", borderRadius:10, color:"white", padding:"14px", fontWeight:800, fontSize:15, opacity:busy?0.6:1 }}>
          {busy?"Envoi…":picked.length===0?"Choisis au moins un véhicule":`✅ Envoyer (${picked.length})`}
        </button>
      </div>
    </Page>
  );

  // Étape 1 : choix du modèle
  return(
    <Page>
      <TopBar title="🏢 Bureau" subtitle="Checklists des sacs / armoires scellés" onBack={onBack} themeMode={themeMode} toggleTheme={toggleTheme}/>
      <div style={{ flex:1, padding:"20px", maxWidth:480, margin:"0 auto", width:"100%" }}>
        {msg&&<div style={{ background:CK_C.successSoft, border:`1px solid ${CK_C.success}`, borderRadius:10, padding:"11px 14px", marginBottom:14, fontSize:13, fontWeight:700, color:CK_C.success }}>{msg}</div>}
        {sealedTemplates.length===0&&(
          <div style={{ textAlign:"center", color:CK_C.muted, padding:"40px 10px", fontSize:14 }}>
            Aucun modèle de sac / armoire.<br/><span style={{ fontSize:11 }}>Crée-en un dans Paramètres → Scellés.</span>
          </div>
        )}
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          {sealedTemplates.map(t=>(
            <button key={t.id} onClick={()=>{ setMsg(""); setTpl(t); setPicked([]); }} style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:13, padding:"16px 20px", color:CK_C.text, textAlign:"left", display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer" }}>
              <div>
                <div style={{ fontWeight:800, fontSize:16 }}>{t.name}</div>
                <div style={{ fontSize:11, color:CK_C.muted }}>{t.target==="TPMR"?"TPMR / VSL":"Ambulances"}</div>
              </div>
              <span style={{ color:CK_C.muted, fontSize:20 }}>→</span>
            </button>
          ))}
        </div>
        {tasks.length>0&&(
          <div style={{ marginTop:26 }}>
            <div style={{ fontSize:11, fontWeight:700, color:CK_C.muted, textTransform:"uppercase", letterSpacing:"1px", marginBottom:8 }}>Déjà envoyées, pas encore terminées ({tasks.length})</div>
            {tasks.map(t=>(
              <div key={t.id} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:10, padding:"10px 14px", marginBottom:6 }}>
                <span style={{ fontSize:13, fontWeight:600 }}>🔒 {t.label}</span>
                <button onClick={()=>cancel(t)} title="Annuler cette checklist" style={{ background:CK_C.dangerSoft, border:`1px solid ${CK_C.danger}`, borderRadius:6, color:CK_C.danger, padding:"5px 9px", fontSize:11, fontWeight:700 }}>Annuler</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Page>
  );
}

// ═══════════════════════════════════════════════════════════════
// MANQUEMENTS — tout ce que les checklists ont signalé et qui n'est pas encore
// réglé. Affiché dans Réappro, avec un bouton "Résolu" (nom obligatoire).
// Pour un produit manquant : la quantité remise est ajoutée au stock du véhicule.
// ═══════════════════════════════════════════════════════════════
function useOpenIssues(){
  const [issues,setIssues]=useState([]);
  useEffect(()=>{
    const q=query(collection(dbChecklists,"stockapp_historique"), where("v2","==",true));
    const unsub=onSnapshot(q, snap=>{
      const list=[];
      snap.forEach(d=>{
        const e=d.data();
        (e.issues||[]).forEach((it,idx)=>{
          if(!(it.remaining>0)) return;
          list.push({ entryId:e.id||d.id, idx, vehicle:e.vehicle, sealed:!!e.sealed, date:e.date, timestamp:e.timestamp||0, name:it.name, type:it.type, remaining:it.remaining, required:it.required, bar:it.bar });
        });
      });
      list.sort((a,b)=>a.vehicle.localeCompare(b.vehicle,"fr",{numeric:true})||a.name.localeCompare(b.name,"fr"));
      setIssues(list);
    }, err=>console.error("Erreur lecture manquements:", err));
    return ()=>unsub();
  },[]);
  return issues;
}

function issueText(i){
  if(i.type==="missing") return `manque ${i.remaining}${i.required?` / ${i.required}`:""}`;
  if(i.type==="nok_test") return "test NOK (non fonctionnel)";
  if(i.type==="nok_seal") return "scellé NOK (rompu)";
  if(i.type==="low_bar") return `niveau bas (${i.bar} bar)`;
  return "à traiter";
}

// Marque le manquement comme résolu (+ entrée en stock si demandé).
async function resolveIssue({ issue, by, qty, date, addToStock }){
  const ref=doc(dbChecklists,"stockapp_historique",issue.entryId);
  const snap=await getDoc(ref);
  if(!snap.exists()) return;
  const entry=snap.data();
  const issues=(entry.issues||[]).map((it,i)=>{
    if(i!==issue.idx) return it;
    if(it.type==="missing"){
      return { ...it, remaining:Math.max(0,(it.remaining||0)-qty), resupplied:(it.resupplied||0)+qty, resolvedBy:by, resolvedAt:Date.now() };
    }
    return { ...it, remaining:0, resolvedBy:by, resolvedAt:Date.now() };
  });
  const writes=[ setDoc(ref, sanitizeUndefined({ ...entry, issues })) ];
  if(addToStock&&issue.type==="missing"&&qty>0){
    writes.push(applyStockMovement({ vehicle:issue.vehicle, itemName:issue.name, type:"entree", qty, date:date||"", by:`${by} (manquement résolu)`, minValue:0, emails:[] }));
  }
  await Promise.all(writes);
}

function ResolveSheet({ issue, checklists, tpmrVslTemplate, stockInit, onClose }){
  const isMissing=issue.type==="missing";
  const canAddStock=isMissing&&!issue.sealed&&!!(stockInit&&stockInit[issue.vehicle]);
  const entry=canAddStock?buildCatalogue(issue.vehicle,checklists,tpmrVslTemplate).find(e=>e.name===issue.name):null;
  const perishable=!!(entry&&entry.p);
  const [name,setName]=useState("");
  const [qty,setQty]=useState(Math.max(1,issue.remaining||1));
  const [date,setDate]=useState("");
  const ok=name.trim().length>0&&(!perishable||qty<=0||!!date);

  const confirm=()=>{
    if(!ok) return;
    // Fermeture immédiate : l'écriture part toute seule, même sans réseau.
    resolveIssue({ issue, by:name.trim(), qty:isMissing?qty:0, date, addToStock:canAddStock })
      .catch(e=>console.error("Erreur résolution manquement:", e));
    rememberName(name);
    onClose();
  };

  return(
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:700, padding:16 }}>
      <div style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:16, padding:22, width:400, maxWidth:"100%", maxHeight:"92vh", overflowY:"auto" }}>
        <div style={{ fontWeight:800, fontSize:16, marginBottom:2 }}>✅ Résolu</div>
        <div style={{ fontSize:13, fontWeight:700 }}>{issue.name}</div>
        <div style={{ fontSize:11, color:CK_C.muted, marginBottom:14 }}>{issue.vehicle} · {issueText(issue)}</div>
        <NameField value={name} onChange={setName} label="Ton nom"/>
        {isMissing&&(
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:10, color:CK_C.muted, marginBottom:5, textTransform:"uppercase", fontWeight:700 }}>Quantité remise</div>
            <Stepper value={qty} onChange={setQty}/>
          </div>
        )}
        {perishable&&(
          <div style={{ marginBottom:12 }}>
            <div style={{ fontSize:10, color:CK_C.muted, marginBottom:5, textTransform:"uppercase", fontWeight:700 }}>Date de péremption*</div>
            <MonthYearPicker value={date} onChange={setDate} danger={!date}/>
          </div>
        )}
        <div style={{ fontSize:11, color:CK_C.muted, marginBottom:16 }}>
          {canAddStock?`Cette quantité sera ajoutée au stock de ${issue.vehicle}.`:isMissing?"Le stock de ce véhicule n'est pas suivi : le manquement sera seulement clôturé.":"Le problème sera clôturé."}
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={onClose} style={{ flex:1, background:CK_C.panel2, border:`1px solid ${CK_C.border}`, borderRadius:9, color:CK_C.muted, padding:"12px", fontWeight:700, fontSize:13 }}>Annuler</button>
          <button onClick={confirm} disabled={!ok} style={{ flex:1, background:ok?CK_C.success:CK_C.border, border:"none", borderRadius:9, color:"white", padding:"12px", fontWeight:800, fontSize:13 }}>Résolu</button>
        </div>
      </div>
    </div>
  );
}

function ManquementsList({ checklists, tpmrVslTemplate, stockInit }){
  const issues=useOpenIssues();
  const [resolving,setResolving]=useState(null);
  const vehicles=[...new Set(issues.map(i=>i.vehicle))];
  return(
    <div style={{ padding:"4px 20px 40px", maxWidth:560, margin:"0 auto", width:"100%" }}>
      <div style={{ fontSize:11, fontWeight:700, color:CK_C.muted, textTransform:"uppercase", letterSpacing:"1px", margin:"10px 0 10px" }}>⚠ Manquements des checklists ({issues.length})</div>
      {issues.length===0&&<div style={{ background:CK_C.successSoft, border:`1px solid ${CK_C.success}`, borderRadius:12, padding:"14px", textAlign:"center", fontWeight:700, fontSize:13, color:CK_C.success }}>Aucun manquement à traiter ✅</div>}
      {vehicles.map(v=>(
        <div key={v} style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:12, padding:"12px 14px", marginBottom:10 }}>
          <div style={{ fontWeight:800, fontSize:14, marginBottom:8 }}>{v}</div>
          {issues.filter(i=>i.vehicle===v).map(i=>(
            <div key={i.entryId+"_"+i.idx} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, padding:"7px 0", borderTop:`1px solid ${CK_C.border}` }}>
              <div style={{ minWidth:0 }}>
                <div style={{ fontSize:13, fontWeight:600 }}>{i.name}</div>
                <div style={{ fontSize:11, color:CK_C.danger, fontWeight:700 }}>{issueText(i)} <span style={{ color:CK_C.muted, fontWeight:400 }}>· checklist du {i.date}</span></div>
              </div>
              <button onClick={()=>setResolving(i)} style={{ background:CK_C.successSoft, border:`1px solid ${CK_C.success}`, borderRadius:8, color:CK_C.success, padding:"8px 12px", fontSize:12, fontWeight:800, flexShrink:0 }}>Résolu</button>
            </div>
          ))}
        </div>
      ))}
      {resolving&&<ResolveSheet issue={resolving} checklists={checklists} tpmrVslTemplate={tpmrVslTemplate} stockInit={stockInit} onClose={()=>setResolving(null)}/>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// CHECKLIST (mensuelle) — Scellé, ambulances, puis TPMR / VSL.
// Une checklist envoyée disparaît de la liste ; elle revient vierge le
// 1er du mois suivant (la clé du document change avec le mois).
// ═══════════════════════════════════════════════════════════════
function ChecklistHome({ onBack, onSettings, onHistory, checklists, emails, tpmrVslTemplate, sealedTemplates, stockInit, themeMode, toggleTheme }) {
  const [selected, setSelected] = useState(null);
  const [selectedTpmrVsl, setSelectedTpmrVsl] = useState(null);
  const [screen, setScreen] = useState("home"); // home | scelle | bureau
  const tpmrChecklists = buildTpmrChecklists(tpmrVslTemplate);
  const hasTpmr = Object.keys(tpmrChecklists).length > 0;
  const statuses = useChecklistsMonthStatus(checklists);
  const tpmrVslStatuses = useChecklistsMonthStatus(tpmrChecklists);
  const sealedTasks = useSealedTasks();
  const sealedStatuses = useSealedStatuses(sealedTasks);
  const monthKey = getChecklistMonthKey();

  if (selected) return <ChecklistView vehicleName={selected} onBack={() => setSelected(null)} checklists={checklists} emails={emails} stockInit={stockInit} themeMode={themeMode} toggleTheme={toggleTheme}/>;
  if (selectedTpmrVsl && tpmrChecklists[selectedTpmrVsl]) return <ChecklistView vehicleName={selectedTpmrVsl} onBack={()=>setSelectedTpmrVsl(null)} checklists={tpmrChecklists} emails={emails} stockInit={stockInit} themeMode={themeMode} toggleTheme={toggleTheme}/>;
  if (screen==="scelle") return <SealedList onBack={()=>setScreen("home")} emails={emails} themeMode={themeMode} toggleTheme={toggleTheme}/>;
  if (screen==="bureau") return <BureauView onBack={()=>setScreen("home")} checklists={checklists} sealedTemplates={sealedTemplates} themeMode={themeMode} toggleTheme={toggleTheme}/>;

  const sealedStarted = sealedTasks.some(t=>sealedStatuses[t.id]?.started);
  const byName=(a,b)=>a.localeCompare(b,"fr",{numeric:true});
  const ambTodo = Object.keys(checklists).filter(n=>!statuses[n]?.sent).sort(byName);
  const tpmrTodo = TPMR_VSL_VEHICLES.filter(n=>tpmrChecklists[n]&&!tpmrVslStatuses[n]?.sent);

  const groupTitle=(label)=>(
    <div style={{ fontSize:11, fontWeight:800, color:CK_C.muted, textTransform:"uppercase", letterSpacing:"1.2px", margin:"14px 0 2px" }}>{label}</div>
  );
  const allDone=(
    <div style={{ background:CK_C.successSoft, border:`1px solid ${CK_C.success}`, borderRadius:12, padding:"14px", textAlign:"center", fontWeight:700, fontSize:13, color:CK_C.success }}>Toutes les checklists sont faites ✅</div>
  );
  const row=(name, st, icon, onClick, sub)=>{
    const dotColor = st?.complete ? CK_C.success : st?.started ? "#f59e0b" : CK_C.muted;
    const dotLabel = st?.complete ? "✅ Complète — à envoyer" : st?.started ? `🟠 En cours (${st.progress}%)` : "Non commencée";
    return(
      <button key={name} onClick={onClick}
        style={{ background:CK_C.panel, border:`1px solid ${st?.complete?CK_C.success:st?.started?"#f59e0b":CK_C.border}`, borderRadius:13, padding:"16px 20px", color:CK_C.text, textAlign:"left", display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <div style={{ width:42, height:42, background:CK_C.red, borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, position:"relative" }}>
            {icon}
            <div style={{ position:"absolute", bottom:-2, right:-2, width:14, height:14, borderRadius:"50%", background:dotColor, border:`2px solid ${CK_C.panel}` }}/>
          </div>
          <div>
            <div style={{ fontWeight:800, fontSize:16 }}>{name}</div>
            {sub&&<div style={{ fontSize:11, color:CK_C.muted }}>{sub}</div>}
            <div style={{ fontSize:11, fontWeight:700, color:dotColor, marginTop:2 }}>{dotLabel}</div>
          </div>
        </div>
        <span style={{ color:CK_C.muted, fontSize:20 }}>→</span>
      </button>
    );
  };

  return (
    <Page>
      <TopBar title="📋 Checklist" subtitle="Sélectionnez votre véhicule" onBack={onBack} themeMode={themeMode} toggleTheme={toggleTheme} onBureau={()=>setScreen("bureau")} onSettings={onSettings} onHistory={onHistory}/>
      <div style={{ textAlign:"center", padding:"10px 20px 0", fontSize:12, color:CK_C.muted, fontWeight:600, textTransform:"capitalize" }}>Checklist mensuelle — {monthYearLabel(monthKey)}</div>
      <div style={{ flex:1, padding:"20px", maxWidth:480, margin:"0 auto", width:"100%" }}>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <button onClick={()=>setScreen("scelle")} style={{ background:CK_C.panel, border:`1px solid ${sealedTasks.length>0?"#f59e0b":CK_C.border}`, borderRadius:13, padding:"16px 20px", color:CK_C.text, textAlign:"left", display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer" }}>
            <div style={{ display:"flex", alignItems:"center", gap:12 }}>
              <div style={{ width:42, height:42, background:CK_C.panel2, border:`1px solid ${CK_C.border}`, borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", fontSize:22 }}>🔒</div>
              <div>
                <div style={{ fontWeight:800, fontSize:16 }}>Scellé</div>
                <div style={{ fontSize:11, fontWeight:700, color:sealedTasks.length>0?"#f59e0b":CK_C.muted }}>
                  {sealedTasks.length===0?"Rien à faire":sealedStarted?`🟠 ${sealedTasks.length} checklist${sealedTasks.length>1?"s":""} à faire (en cours)`:`${sealedTasks.length} checklist${sealedTasks.length>1?"s":""} à faire`}
                </div>
              </div>
            </div>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <Badge n={sealedTasks.length} color="#f59e0b"/>
              <span style={{ color:CK_C.muted, fontSize:20 }}>→</span>
            </div>
          </button>

          {groupTitle("Ambulances")}
          {ambTodo.length===0&&allDone}
          {ambTodo.map(name=>row(name, statuses[name], "🚑", ()=>setSelected(name), `Norme ${checklists[name].norme}`))}

          {groupTitle("TPMR / VSL")}
          {!hasTpmr&&<div style={{ textAlign:"center", color:CK_C.muted, padding:"14px 6px", fontSize:12 }}>Aucun modèle défini — configure-le dans Paramètres → Checklists → Sac TPMR/VSL</div>}
          {hasTpmr&&tpmrTodo.length===0&&allDone}
          {tpmrTodo.map(name=>row(name, tpmrVslStatuses[name], "♿", ()=>setSelectedTpmrVsl(name), null))}
        </div>
      </div>
    </Page>
  );
}

// ═══════════════════════════════════════════════════════════════
// PÉREMPTION — vue d'ensemble de tous les lots datés, tous véhicules
// (les entrées se font dans Réappro → Réappro véhicules)
// ═══════════════════════════════════════════════════════════════
function PeremptionView({ onBack, checklists, tpmrVslTemplate, peremptionEmails, themeMode, toggleTheme }){
  const stockMap=useStockMap();
  const [filter,setFilter]=useState("");
  const [removing,setRemoving]=useState(null); // { vehicle, itemName, lot }
  const [rmQty,setRmQty]=useState(1);
  const [rmName,setRmName]=useState("");
  const [rmBusy,setRmBusy]=useState(false);

  useEffect(()=>{ checkAndSendPeremptionAlerts(checklists, peremptionEmails); },[]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows=[];
  allVehicleNames(checklists).forEach(v=>{
    buildCatalogue(v,checklists,tpmrVslTemplate).filter(e=>e.p).forEach(e=>{
      const d=stockMap[e.key];
      rows.push({ vehicleName:v, itemName:e.name, key:e.key, lots:sortLots(d&&d.lots) });
    });
  });
  Object.keys(stockMap).forEach(k=>{ const d=stockMap[k]; if(d&&d.sealed&&(d.lots||[]).length>0) rows.push({ vehicleName:d.vehicle, itemName:d.itemName, key:k, lots:sortLots(d.lots) }); });
  const vehicleNames=[...new Set(rows.map(r=>r.vehicleName))];
  const cur=getChecklistMonthKey();
  const isExpired=(ym)=>!!ym && ym<=cur;
  const rowExpired=(r)=>r.lots.some(l=>l.date&&isExpired(l.date));
  const shown=(filter?rows.filter(r=>r.vehicleName===filter):rows)
    .filter(r=>r.lots.length>0)
    .sort((a,b)=>{
      const expDiff=(rowExpired(b)?1:0)-(rowExpired(a)?1:0);
      if(expDiff!==0) return expDiff;
      const sa=getSoonestDate(a.lots)||"9999-99", sb=getSoonestDate(b.lots)||"9999-99";
      return sa.localeCompare(sb)||a.itemName.localeCompare(b.itemName,"fr");
    });

  const confirmRemove=async()=>{
    if(!removing||!rmName.trim()||rmBusy) return;
    setRmBusy(true);
    try{
      await applyStockMovement({ vehicle:removing.vehicle, itemName:removing.itemName, type:"sortie", qty:rmQty, date:removing.lot.date, by:rmName.trim(), lotId:removing.lot.id, minValue:0, emails:[] });
      rememberName(rmName);
      setRemoving(null);
    }catch(e){ console.error("Erreur retrait lot:", e); }
    setRmBusy(false);
  };

  return(
    <Page>
      <TopBar title="🗓️ Péremption" subtitle="Vue d'ensemble" onBack={onBack} themeMode={themeMode} toggleTheme={toggleTheme}/>
      <div style={{ flex:1, padding:16, maxWidth:700, margin:"0 auto", width:"100%" }}>
        <div style={{ display:"flex", gap:8, marginBottom:16, overflowX:"auto" }}>
          <button onClick={()=>setFilter("")} style={{ padding:"7px 14px", borderRadius:20, border:`1px solid ${!filter?CK_C.red:CK_C.border}`, background:!filter?CK_C.red:"transparent", color:!filter?"white":CK_C.muted, fontSize:12, fontWeight:600, whiteSpace:"nowrap" }}>Tous</button>
          {vehicleNames.map(v=>(
            <button key={v} onClick={()=>setFilter(v)} style={{ padding:"7px 14px", borderRadius:20, border:`1px solid ${filter===v?CK_C.red:CK_C.border}`, background:filter===v?CK_C.red:"transparent", color:filter===v?"white":CK_C.muted, fontSize:12, fontWeight:600, whiteSpace:"nowrap" }}>{v}</button>
          ))}
        </div>
        {shown.length===0&&<div style={{ textAlign:"center", color:CK_C.muted, padding:40 }}>Aucun lot de produit à péremption en stock.<br/><span style={{ fontSize:11 }}>Les lots sont créés par les entrées dans Réappro → Réappro véhicules.</span></div>}
        {shown.map(r=>{
          const soonest=r.lots.find(l=>l.date);
          return(
            <div key={r.key} style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:12, padding:"13px 15px", marginBottom:10 }}>
              <div style={{ fontWeight:700, fontSize:14, marginBottom:2 }}>{r.itemName}</div>
              <div style={{ fontSize:11, color:CK_C.muted, marginBottom:10 }}>{r.vehicleName}</div>
              {r.lots.map(lot=>{
                const isSoonest=soonest&&lot.id===soonest.id;
                const exp=isExpired(lot.date);
                return(
                  <div key={lot.id} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, background:exp?"#ef444412":isSoonest?"#f59e0b12":CK_C.bg, border:`1px solid ${exp?"#ef4444":isSoonest?"#f59e0b":CK_C.border}`, borderRadius:8, padding:"7px 10px", marginBottom:6 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      {isSoonest&&<span title="À utiliser en premier" style={{ width:9, height:9, borderRadius:"50%", background:exp?"#ef4444":"#f59e0b", flexShrink:0 }}/>}
                      <span style={{ fontSize:12, fontWeight:700 }}>{lot.quantite}×</span>
                      <span style={{ fontSize:12, color:!lot.date?CK_C.warning:exp?"#ef4444":isSoonest?"#f59e0b":CK_C.muted, fontWeight:isSoonest?700:400 }}>{lot.date?monthYearLabel(lot.date):"date à renseigner"}</span>
                      {isSoonest&&<span style={{ fontSize:9, fontWeight:700, color:exp?"#ef4444":"#f59e0b", textTransform:"uppercase" }}>{exp?"Périmé":"À utiliser en 1er"}</span>}
                    </div>
                    <button onClick={()=>{ setRemoving({ vehicle:r.vehicleName, itemName:r.itemName, lot }); setRmQty(lot.quantite||1); setRmName(""); }} style={{ background:"transparent", border:`1px solid ${CK_C.danger}`, borderRadius:6, color:CK_C.danger, padding:"4px 9px", fontSize:11, fontWeight:700 }}>Retirer</button>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
      {removing&&(
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.85)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:600 }}>
          <div style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:16, padding:"22px", width:380, maxWidth:"92vw" }}>
            <div style={{ fontWeight:800, fontSize:16, marginBottom:4 }}>Retirer du stock</div>
            <div style={{ fontSize:12, color:CK_C.muted, marginBottom:14 }}>{removing.itemName} · {removing.vehicle} · lot {removing.lot.date?monthYearLabel(removing.lot.date):"sans date"} ({removing.lot.quantite}×)</div>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
              <div style={{ fontSize:13, fontWeight:700 }}>Quantité retirée</div>
              <Stepper value={rmQty} onChange={setRmQty} max={removing.lot.quantite||1}/>
            </div>
            <NameField value={rmName} onChange={setRmName} label="Ton nom"/>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={()=>setRemoving(null)} style={{ flex:1, background:CK_C.panel2, border:`1px solid ${CK_C.border}`, borderRadius:9, color:CK_C.muted, padding:"11px", fontWeight:700 }}>Annuler</button>
              <button disabled={!rmName.trim()||rmBusy} onClick={confirmRemove} style={{ flex:1, background:rmName.trim()?CK_C.danger:CK_C.border, border:"none", borderRadius:9, color:"white", padding:"11px", fontWeight:800, opacity:rmName.trim()?1:0.6 }}>{rmBusy?"…":"Retirer"}</button>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

// ═══════════════════════════════════════════════════════════════
// MOUVEMENTS — journal de tout ce qui est entré / sorti des produits
// ═══════════════════════════════════════════════════════════════
const MOVE_META={
  entree:{ label:"Entrée", color:"#22c55e", sign:"+" },
  sortie:{ label:"Sortie", color:"#ef4444", sign:"−" },
  correction:{ label:"Correction", color:"#f59e0b", sign:"" },
  init:{ label:"Initialisation", color:"#38bdf8", sign:"" },
};
function MouvementsView({ onBack, vehicles, themeMode, toggleTheme }){
  const [entries,setEntries]=useState([]);
  const [loaded,setLoaded]=useState(false);
  const [vFilter,setVFilter]=useState("");
  const [typeFilter,setTypeFilter]=useState("");
  const [search,setSearch]=useState("");
  const [limit,setLimit]=useState(100);

  useEffect(()=>{
    cleanOldMouvements();
    const unsub=onSnapshot(collection(dbChecklists,MOVES_COL), snap=>{
      const docs=snap.docs.map(d=>d.data());
      docs.sort((a,b)=>b.timestamp-a.timestamp);
      setEntries(docs);
      setLoaded(true);
    }, ()=>setLoaded(true));
    return ()=>unsub();
  },[]);

  const q=search.trim().toLowerCase();
  const filtered=entries.filter(e=>
    (!vFilter||e.vehicle===vFilter) && (!typeFilter||e.type===typeFilter) &&
    (!q||(e.itemName||"").toLowerCase().includes(q)||(e.by||"").toLowerCase().includes(q))
  );
  const selStyle={ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:8, padding:"8px 10px", color:CK_C.text, fontSize:12 };
  return(
    <Page>
      <TopBar title="🔁 Mouvements" subtitle="Entrées et sorties de produits" onBack={onBack} themeMode={themeMode} toggleTheme={toggleTheme}/>
      <div style={{ padding:"12px 14px 0", maxWidth:700, margin:"0 auto", width:"100%" }}>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          <select value={vFilter} onChange={e=>setVFilter(e.target.value)} style={selStyle}>
            <option value="">Tous les véhicules</option>
            {vehicles.map(v=>(<option key={v} value={v}>{v}</option>))}
          </select>
          <select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)} style={selStyle}>
            <option value="">Tous les types</option>
            {Object.entries(MOVE_META).map(([k,m])=>(<option key={k} value={k}>{m.label}</option>))}
          </select>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Produit ou nom…" style={{ ...selStyle, flex:1, minWidth:140 }}/>
        </div>
      </div>
      <div style={{ flex:1, padding:"12px 14px 40px", maxWidth:700, margin:"0 auto", width:"100%" }}>
        {!loaded&&<div style={{ textAlign:"center", color:CK_C.muted, padding:40 }}>Chargement…</div>}
        {loaded&&filtered.length===0&&<div style={{ textAlign:"center", color:CK_C.muted, padding:40 }}>Aucun mouvement</div>}
        {filtered.slice(0,limit).map(e=>{
          const m=MOVE_META[e.type]||{ label:e.type, color:CK_C.muted, sign:"" };
          const time=e.timestamp?new Date(e.timestamp).toLocaleTimeString("fr-FR",{hour:"2-digit",minute:"2-digit"}):"";
          return(
            <div key={e.id} style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderLeft:`4px solid ${m.color}`, borderRadius:12, padding:"12px 14px", marginBottom:8 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
                <div style={{ minWidth:0 }}>
                  <div style={{ fontWeight:800, fontSize:14 }}>{e.itemName}</div>
                  <div style={{ fontSize:11, color:CK_C.muted, marginTop:2 }}>🚑 {e.vehicle} · {e.date} {time}</div>
                </div>
                <div style={{ textAlign:"right", flexShrink:0 }}>
                  <div style={{ fontSize:16, fontWeight:900, color:m.color }}>{e.type==="correction"?`${e.qty>0?"+":""}${e.qty}`:e.type==="init"?"":`${m.sign}${e.qty}`}</div>
                  <div style={{ fontSize:10, fontWeight:700, color:m.color, textTransform:"uppercase" }}>{m.label}</div>
                </div>
              </div>
              <div style={{ marginTop:8, paddingTop:8, borderTop:`1px solid ${CK_C.border}`, display:"flex", justifyContent:"space-between", flexWrap:"wrap", gap:6, fontSize:11, color:CK_C.muted }}>
                <span>Par : <strong style={{ color:CK_C.text }}>{e.by||"—"}</strong></span>
                {e.lotDate&&<span>Péremption : {monthYearLabel(e.lotDate)}</span>}
                {e.stockBefore!=null&&e.type!=="init"&&<span>Stock : {e.stockBefore} → <strong style={{ color:CK_C.text }}>{e.stockAfter}</strong></span>}
                {e.shortfall>0&&<span style={{ color:CK_C.warning, fontWeight:700 }}>⚠ écart : {e.shortfall} de moins que demandé</span>}
              </div>
            </div>
          );
        })}
        {filtered.length>limit&&<button onClick={()=>setLimit(l=>l+100)} style={{ width:"100%", background:CK_C.panel2, border:`1px solid ${CK_C.border}`, borderRadius:10, color:CK_C.muted, padding:"11px", fontWeight:700 }}>Afficher plus</button>}
      </div>
    </Page>
  );
}

// ═══════════════════════════════════════════════════════════════
// HISTORIQUE — Péremption, Bouteilles O², Mouvements, Checklists
// ═══════════════════════════════════════════════════════════════
function HistoriqueHome({ onBack, checklists, tpmrVslTemplate, peremptionEmails, themeMode, toggleTheme }){
  const stockMap=useStockMap();
  const [screen,setScreen]=useState("home"); // home | peremption | o2 | mouvements | checklists

  if(screen==="peremption") return <PeremptionView onBack={()=>setScreen("home")} checklists={checklists} tpmrVslTemplate={tpmrVslTemplate} peremptionEmails={peremptionEmails} themeMode={themeMode} toggleTheme={toggleTheme}/>;
  if(screen==="o2") return <O2HistoriqueSubView onBack={()=>setScreen("home")} themeMode={themeMode} toggleTheme={toggleTheme}/>;
  if(screen==="mouvements") return <MouvementsView onBack={()=>setScreen("home")} vehicles={allVehicleNames(checklists)} themeMode={themeMode} toggleTheme={toggleTheme}/>;
  if(screen==="checklists") return <ChecklistHistoriqueSubView onBack={()=>setScreen("home")} themeMode={themeMode} toggleTheme={toggleTheme}/>;

  // Badge Péremption : nombre de produits dont un lot est périmé ou expire ce mois-ci.
  const cur=getChecklistMonthKey();
  const expiredCount=Object.values(stockMap).filter(d=>(d.lots||[]).some(l=>l.date&&l.date<=cur)).length;

  const btn=(icon,label,sub,target,badge)=>(
    <button onClick={()=>setScreen(target)} style={{ background:CK_C.panel, border:`1px solid ${badge>0?CK_C.danger:CK_C.border}`, borderRadius:14, padding:"20px", color:CK_C.text, display:"flex", alignItems:"center", gap:14, cursor:"pointer", textAlign:"left" }}>
      <div style={{ fontSize:28, color:"#3b82f6", fontWeight:900 }}>{icon}</div>
      <div style={{ flex:1 }}><div style={{ fontWeight:800, fontSize:15 }}>{label}</div><div style={{ fontSize:11, color:CK_C.muted, marginTop:2 }}>{sub}</div></div>
      <Badge n={badge}/>
    </button>
  );
  return(
    <Page>
      <TopBar title="📅 Historique" onBack={onBack} themeMode={themeMode} toggleTheme={toggleTheme}/>
      <div style={{ flex:1, padding:"20px", maxWidth:420, margin:"0 auto", width:"100%", display:"flex", flexDirection:"column", gap:12 }}>
        {btn("🗓️","Péremption","Vue d'ensemble des dates de péremption","peremption",expiredCount)}
        {btn("O₂","Bouteilles O²","Échanges véhicules et livraisons fournisseur","o2",0)}
        {btn("🔁","Mouvements","Tout ce qui est entré et sorti des produits","mouvements",0)}
        {btn("📋","Checklists","Toutes les checklists envoyées","checklists",0)}
      </div>
    </Page>
  );
}

// ═══════════════════════════════════════════════════════════════
// PARAMÈTRES → SCELLÉS : créer / modifier les modèles de sacs et armoires
// ═══════════════════════════════════════════════════════════════
function SealedTemplatesEditor({ templates, setTemplates }){
  const C=CK_C;
  const [editId,setEditId]=useState(null);
  const [newName,setNewName]=useState("");
  const [newTarget,setNewTarget]=useState("AMB");
  const tpl=templates.find(t=>t.id===editId);
  const inp={ background:C.bg, color:C.text, fontSize:13, border:`1px solid ${C.border}`, borderRadius:8, padding:"8px 10px" };
  const noSlash=(s)=>s.replace(/\//g,"-");

  const upd=(fn)=>setTemplates(p=>p.map(t=>t.id===editId?fn(t):t));
  const updSection=(sid,fn)=>upd(t=>({ ...t, sections:t.sections.map(s=>s.id===sid?fn(s):s) }));
  const updItems=(sid,fn)=>updSection(sid,s=>({ ...s, shelves:[{ ...s.shelves[0], items:fn(s.shelves[0].items) }] }));

  const addTemplate=()=>{
    const name=noSlash(newName.trim());
    if(!name) return;
    const id="t"+Date.now();
    setTemplates(p=>[...p,{ id, name, target:newTarget, sections:[] }]);
    setNewName("");
    setEditId(id);
  };
  const deleteTemplate=(t)=>{
    if(!window.confirm(`Supprimer le modèle « ${t.name} » ? Les checklists déjà envoyées ne sont pas touchées.`)) return;
    setTemplates(p=>p.filter(x=>x.id!==t.id));
  };

  if(!tpl) return(
    <div>
      <SectionTitle icon="🔒" title="Sacs et armoires scellés"/>
      <div style={{ fontSize:12, color:C.muted, marginBottom:14 }}>Crée ici la checklist de chaque sac ou armoire scellé. Quand l'un d'eux est ouvert, le bureau déclenche sa checklist pour le véhicule concerné (bouton Bureau dans Checklist).</div>
      <div style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:12, padding:14, marginBottom:18 }}>
        <div style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:"uppercase", marginBottom:8 }}>Nouveau modèle</div>
        <input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Ex : Sac pédiatrique, Sac Kata…" style={{ ...inp, width:"100%", marginBottom:10, boxSizing:"border-box" }}/>
        <div style={{ display:"flex", gap:8, marginBottom:12 }}>
          {[["AMB","🚑 Ambulances"],["TPMR","♿ TPMR / VSL"]].map(([v,lbl])=>(
            <button key={v} onClick={()=>setNewTarget(v)} style={{ flex:1, padding:"10px", borderRadius:9, border:`1px solid ${newTarget===v?C.accent:C.border}`, background:newTarget===v?C.accentSoft:"transparent", color:newTarget===v?C.accent:C.muted, fontWeight:700, fontSize:13 }}>{lbl}</button>
          ))}
        </div>
        <button onClick={addTemplate} disabled={!newName.trim()} style={{ width:"100%", background:newName.trim()?C.accent:C.border, border:"none", borderRadius:9, color:"white", padding:"11px", fontWeight:800, fontSize:14 }}>+ Créer le modèle</button>
      </div>
      {templates.length===0&&<div style={{ textAlign:"center", color:C.muted, fontSize:13, padding:"10px 0" }}>Aucun modèle pour l'instant.</div>}
      {templates.map(t=>{
        const nbItems=(t.sections||[]).reduce((s,sec)=>s+sec.shelves.reduce((a,sh)=>a+sh.items.length,0),0);
        return(
          <div key={t.id} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, background:C.panel, border:`1px solid ${C.border}`, borderRadius:10, padding:"12px 14px", marginBottom:8 }}>
            <div>
              <div style={{ fontWeight:800, fontSize:14 }}>{t.name}</div>
              <div style={{ fontSize:11, color:C.muted }}>{t.target==="TPMR"?"TPMR / VSL":"Ambulances"} · {nbItems} produit{nbItems>1?"s":""}</div>
            </div>
            <div style={{ display:"flex", gap:6 }}>
              <button onClick={()=>setEditId(t.id)} style={{ background:C.accentSoft, border:`1px solid ${C.accent}`, borderRadius:7, color:C.accent, padding:"7px 12px", fontSize:12, fontWeight:700 }}>Modifier</button>
              <button onClick={()=>deleteTemplate(t)} style={{ background:C.dangerSoft, border:`1px solid ${C.danger}`, borderRadius:7, color:C.danger, padding:"7px 10px", fontSize:12 }}>🗑</button>
            </div>
          </div>
        );
      })}
    </div>
  );

  return(
    <div>
      <button onClick={()=>setEditId(null)} style={{ background:"transparent", border:`1px solid ${C.border}`, borderRadius:8, color:C.muted, padding:"6px 12px", fontSize:13, marginBottom:14 }}>← Tous les modèles</button>
      <div style={{ display:"flex", gap:8, marginBottom:10 }}>
        <input value={tpl.name} onChange={e=>upd(t=>({ ...t, name:noSlash(e.target.value) }))} style={{ ...inp, flex:1, fontWeight:800, fontSize:15 }}/>
      </div>
      <div style={{ display:"flex", gap:8, marginBottom:16 }}>
        {[["AMB","🚑 Ambulances"],["TPMR","♿ TPMR / VSL"]].map(([v,lbl])=>(
          <button key={v} onClick={()=>upd(t=>({ ...t, target:v }))} style={{ flex:1, padding:"9px", borderRadius:9, border:`1px solid ${tpl.target===v?C.accent:C.border}`, background:tpl.target===v?C.accentSoft:"transparent", color:tpl.target===v?C.accent:C.muted, fontWeight:700, fontSize:12 }}>{lbl}</button>
        ))}
      </div>
      <div style={{ fontSize:11, color:C.muted, marginBottom:14 }}>🗓 = produit à date de péremption (la date est demandée à chaque checklist) · 🔧 = produit à tester (fonctionnel OK / NOK)</div>
      {tpl.sections.map(sec=>(
        <div key={sec.id} style={{ background:C.panel, border:`1px solid ${C.border}`, borderRadius:12, padding:12, marginBottom:12 }}>
          <div style={{ display:"flex", gap:6, marginBottom:10 }}>
            <input value={sec.label} onChange={e=>updSection(sec.id,s=>({ ...s, label:e.target.value }))} placeholder="Nom de la section" style={{ ...inp, flex:1, fontWeight:700 }}/>
            <button onClick={()=>{ if(window.confirm(`Supprimer la section « ${sec.label} » ?`)) upd(t=>({ ...t, sections:t.sections.filter(s=>s.id!==sec.id) })); }} style={{ background:C.dangerSoft, border:`1px solid ${C.danger}`, borderRadius:7, color:C.danger, padding:"7px 10px", fontSize:12 }}>🗑</button>
          </div>
          {sec.shelves[0].items.map((it,i)=>(
            <div key={i} style={{ display:"flex", gap:5, alignItems:"center", marginBottom:6 }}>
              <input value={it.n} onChange={e=>updItems(sec.id,items=>items.map((x,j)=>j===i?{ ...x, n:e.target.value }:x))} placeholder="Nom du produit" style={{ ...inp, flex:1, minWidth:0 }}/>
              <input type="number" min="1" value={it.q||1} onChange={e=>updItems(sec.id,items=>items.map((x,j)=>j===i?{ ...x, q:Math.max(1,parseInt(e.target.value)||1) }:x))} title="Quantité" style={{ ...inp, width:54, textAlign:"center" }}/>
              <button onClick={()=>updItems(sec.id,items=>items.map((x,j)=>j===i?{ ...x, p:!x.p }:x))} title="Date de péremption" style={{ padding:"7px 8px", borderRadius:7, border:`1px solid ${it.p?"#f59e0b":C.border}`, background:it.p?"#f59e0b20":"transparent", opacity:it.p?1:0.5, fontSize:13 }}>🗓</button>
              <button onClick={()=>updItems(sec.id,items=>items.map((x,j)=>j===i?{ ...x, t:!x.t }:x))} title="À tester" style={{ padding:"7px 8px", borderRadius:7, border:`1px solid ${it.t?"#60a5fa":C.border}`, background:it.t?"#1d4ed820":"transparent", opacity:it.t?1:0.5, fontSize:13 }}>🔧</button>
              <button onClick={()=>updItems(sec.id,items=>items.filter((_,j)=>j!==i))} style={{ background:C.dangerSoft, border:`1px solid ${C.danger}`, borderRadius:7, color:C.danger, padding:"7px 8px", fontSize:11 }}>🗑</button>
            </div>
          ))}
          <button onClick={()=>updItems(sec.id,items=>[...items,{ n:"", q:1 }])} style={{ background:"transparent", border:`1px dashed ${C.border}`, borderRadius:8, color:C.muted, padding:"7px 12px", fontSize:12, width:"100%" }}>+ Produit</button>
        </div>
      ))}
      <button onClick={()=>upd(t=>({ ...t, sections:[...t.sections,{ id:Math.max(0,...t.sections.map(x=>Number(x.id)||0))+1, label:"Nouvelle section", color:"#dc2626", shelves:[{ id:"A", label:"", items:[] }] }] }))} style={{ width:"100%", background:C.accentSoft, border:`1px solid ${C.accent}`, borderRadius:10, color:C.accent, padding:"11px", fontWeight:800, fontSize:13 }}>+ Section</button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// IMPORT depuis DispatchAI (one shot, au lancement officiel de DispatchAI :
// on récupère l'historique ici puis on supprime cette app)
// ═══════════════════════════════════════════════════════════════
async function copyCollection(fromName, toName, log){
  const snap=await getDocs(collection(dbChecklists,fromName));
  let n=0;
  let batch=writeBatch(dbChecklists);
  let inBatch=0;
  for(const d of snap.docs){
    batch.set(doc(dbChecklists,toName,d.id), sanitizeUndefined(d.data()));
    inBatch++; n++;
    if(inBatch>=400){ await batch.commit(); batch=writeBatch(dbChecklists); inBatch=0; }
  }
  if(inBatch>0) await batch.commit();
  log(`✓ ${toName} : ${n} document(s)`);
}
async function importFromDispatchAI(log){
  const readD=async(key)=>{ const s=await getDoc(doc(dbDispatch,"dispatchai",key)); return s.exists()?s.data().data:null; };
  for(const key of ["checklistsData","tpmrVslChecklistTemplate","checklistEmails","o2Emails","peremptionEmails"]){
    try{
      const val=await readD(key);
      if(val==null){ log(`⚠ ${key} : introuvable dans DispatchAI`); continue; }
      await setDoc(doc(dbChecklists,"stockapp_settings",key),{ data:sanitizeUndefined(val) });
      log(`✓ ${key}`);
    }catch(e){ console.error(e); log(`✗ ${key} : erreur (${e.message||e})`); }
  }
  const cols=[["stockapp_stock",STOCK_COL],["stockapp_o2","stockapp_o2"],["stockapp_o2_historique","stockapp_o2_historique"],["stockapp_historique","stockapp_historique"]];
  for(const [from,to] of cols){
    try{ await copyCollection(from,to,log); }catch(e){ console.error(e); log(`✗ ${to} : erreur (${e.message||e})`); }
  }
  log("Terminé.");
}

// ═══════════════════════════════════════════════════════════════
// PARAMÈTRES — Emails, Checklists (produits), Seuils, Import
// ═══════════════════════════════════════════════════════════════
function SectionTitle({ icon, title }){
  return <div style={{ fontSize:15, fontWeight:800, marginBottom:12 }}>{icon} {title}</div>;
}
function EmailList({ icon, title, hint, list, setList }){
  const [val,setVal]=useState("");
  return(
    <div style={{ marginBottom:30 }}>
      <SectionTitle icon={icon} title={title}/>
      <div style={{ fontSize:11, color:CK_C.muted, marginBottom:12 }}>{hint}</div>
      <div style={{ display:"flex", gap:8, marginBottom:12 }}>
        <input value={val} onChange={e=>setVal(e.target.value)} placeholder="adresse@email.be" style={{ flex:1, background:CK_C.bg, color:CK_C.text, fontSize:13, border:`1px solid ${CK_C.border}`, borderRadius:9, padding:"10px 12px" }}/>
        <button onClick={()=>{ if(val.trim()&&val.includes("@")){ setList(p=>[...p,val.trim()]); setVal(""); } }} style={{ background:CK_C.accentSoft, border:`1px solid ${CK_C.accent}`, borderRadius:9, color:CK_C.accent, padding:"10px 16px", fontSize:13, fontWeight:700 }}>+ Ajouter</button>
      </div>
      {list.length===0&&<div style={{ fontSize:12, color:CK_C.muted, textAlign:"center", padding:"14px 0" }}>Aucun destinataire configuré</div>}
      {list.map((em,i)=>(
        <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:9, padding:"10px 14px", marginBottom:6 }}>
          <span style={{ fontSize:13 }}>{em}</span>
          <button onClick={()=>setList(p=>p.filter((_,j)=>j!==i))} style={{ background:CK_C.dangerSoft, border:`1px solid ${CK_C.danger}`, borderRadius:6, color:CK_C.danger, padding:"5px 9px", fontSize:11 }}>🗑</button>
        </div>
      ))}
    </div>
  );
}

function ParametresView({ checklistsData, setChecklistsData, tpmrVslTemplate, setTpmrVslTemplate, checklistEmails, setChecklistEmails, o2Emails, setO2Emails, peremptionEmails, setPeremptionEmails, stockEmails, setStockEmails, stockPct, setStockPct, sealedTemplates, setSealedTemplates, onBack, themeMode, toggleTheme }){
  const [tab,setTab]=useState("emails");
  const [editingChecklist,setEditingChecklist]=useState(null); // {key, origKey, isNew, norme, edition, sections}
  const [confirmDeleteChecklist,setConfirmDeleteChecklist]=useState(null);
  const [importLog,setImportLog]=useState([]);
  const [importBusy,setImportBusy]=useState(false);
  const [confirmImport,setConfirmImport]=useState(false);
  const C=CK_C;

  const openNewChecklist=()=>{
    setEditingChecklist({key:"",origKey:null,isNew:true,norme:"",edition:"",sections:[]});
  };
  const openEditChecklist=(name)=>{
    const d=checklistsData[name];
    setEditingChecklist({key:name,origKey:name,isNew:false,norme:d.norme||"",edition:d.edition||"",sections:JSON.parse(JSON.stringify(d.sections||[]))});
  };
  const saveChecklist=()=>{
    if(!editingChecklist||!editingChecklist.key.trim()) return;
    const {key,origKey,norme,edition,sections}=editingChecklist;
    setChecklistsData(prev=>{
      const next={...prev};
      if(origKey&&origKey!==key) delete next[origKey];
      next[key]={norme,edition,sections};
      return next;
    });
    setEditingChecklist(null);
  };
  const addSection=()=>setEditingChecklist(p=>({...p,sections:[...p.sections,{id:String.fromCharCode(65+p.sections.length),label:"Nouvelle section",color:"#f97316",shelves:[]}]}));
  const removeSection=(sIdx)=>setEditingChecklist(p=>({...p,sections:p.sections.filter((_,i)=>i!==sIdx)}));
  const updateSection=(sIdx,field,val)=>setEditingChecklist(p=>({...p,sections:p.sections.map((s,i)=>i===sIdx?{...s,[field]:val}:s)}));
  const addShelf=(sIdx)=>setEditingChecklist(p=>({...p,sections:p.sections.map((s,i)=>i===sIdx?{...s,shelves:[...s.shelves,{id:`sh${s.shelves.length+1}`,label:"",items:[]}]}:s)}));
  const removeShelf=(sIdx,shIdx)=>setEditingChecklist(p=>({...p,sections:p.sections.map((s,i)=>i===sIdx?{...s,shelves:s.shelves.filter((_,j)=>j!==shIdx)}:s)}));
  const updateShelf=(sIdx,shIdx,field,val)=>setEditingChecklist(p=>({...p,sections:p.sections.map((s,i)=>i===sIdx?{...s,shelves:s.shelves.map((sh,j)=>j===shIdx?{...sh,[field]:val}:sh)}:s)}));
  const addItem=(sIdx,shIdx)=>setEditingChecklist(p=>({...p,sections:p.sections.map((s,i)=>i===sIdx?{...s,shelves:s.shelves.map((sh,j)=>j===shIdx?{...sh,items:[...sh.items,{n:"Nouvel article",q:1}]}:sh)}:s)}));
  const removeItem=(sIdx,shIdx,itIdx)=>setEditingChecklist(p=>({...p,sections:p.sections.map((s,i)=>i===sIdx?{...s,shelves:s.shelves.map((sh,j)=>j===shIdx?{...sh,items:sh.items.filter((_,k)=>k!==itIdx)}:sh)}:s)}));
  const updateItem=(sIdx,shIdx,itIdx,field,val)=>setEditingChecklist(p=>({...p,sections:p.sections.map((s,i)=>i===sIdx?{...s,shelves:s.shelves.map((sh,j)=>j===shIdx?{...sh,items:sh.items.map((it,k)=>k===itIdx?{...it,[field]:val}:it)}:sh)}:s)}));

  const TABS=[{id:"emails",icon:"✉️",label:"Emails"},{id:"checklists",icon:"📋",label:"Checklists"},{id:"scelles",icon:"🔒",label:"Scellés"},{id:"seuils",icon:"📉",label:"Seuils"},{id:"import",icon:"⬇️",label:"Importer"}];
  const runImport=async()=>{
    setConfirmImport(false);
    setImportBusy(true);
    setImportLog([]);
    try{ await importFromDispatchAI((m)=>setImportLog(p=>[...p,m])); }
    catch(e){ console.error(e); setImportLog(p=>[...p,`✗ Erreur : ${e.message||e}`]); }
    setImportBusy(false);
  };
  return(
    <Page>
      <TopBar title="⚙️ Paramètres" subtitle="Configuration" onBack={()=>{ if(editingChecklist){ setEditingChecklist(null); }else{ onBack(); } }} themeMode={themeMode} toggleTheme={toggleTheme}/>
      <div style={{ display:"flex", gap:6, padding:"10px 14px", overflowX:"auto", background:CK_C.panel, borderBottom:`1px solid ${CK_C.border}` }}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>{ setTab(t.id); setEditingChecklist(null); }} style={{ padding:"8px 14px", borderRadius:20, border:`1px solid ${tab===t.id?CK_C.accent:CK_C.border}`, background:tab===t.id?CK_C.accentSoft:"transparent", color:tab===t.id?CK_C.accent:CK_C.muted, fontSize:12, fontWeight:700, whiteSpace:"nowrap" }}>{t.icon} {t.label}</button>
        ))}
      </div>
      <div style={{ flex:1, padding:"18px 16px 60px", maxWidth:760, margin:"0 auto", width:"100%" }}>
        {tab==="emails"&&(
          <div>
            <EmailList icon="📋" title="Emails — Checklists et remarques" hint="Reçoivent les checklists envoyées (matériel manquant) et les remarques." list={checklistEmails} setList={setChecklistEmails}/>
            <EmailList icon="🅾️" title="Emails — Alerte stock oxygène" hint="Reçoivent un email dès qu'une taille de bouteille (B2/B5/B10) tombe à 2, 1 ou 0 pleines en réserve." list={o2Emails} setList={setO2Emails}/>
            <EmailList icon="🗓️" title="Emails — Alerte Péremption" hint="Reçoivent 1 seul email, le 1er du mois de péremption, qui liste les produits périmés à remplacer, classés par véhicule." list={peremptionEmails} setList={setPeremptionEmails}/>
            <EmailList icon="📉" title="Emails — Alerte stock bas" hint="Reçoivent un email quand un produit passe sous son seuil minimum dans un véhicule (une seule fois au franchissement du seuil)." list={stockEmails} setList={setStockEmails}/>
          </div>
        )}
                  {tab==="checklists"&&(
            <div>
              <SectionTitle icon="📋" title="Checklists véhicules"/>
              {!editingChecklist?(
                <>
                  <div style={{fontSize:11,color:C.muted,marginBottom:16}}>Ajoute, modifie ou supprime les checklists de contrôle matériel par véhicule.</div>
                  <button onClick={openNewChecklist} style={{background:C.accentSoft,border:`1px solid ${C.accent}`,borderRadius:9,color:C.accent,padding:"10px 16px",fontSize:13,fontWeight:700,cursor:"pointer",marginBottom:16}}>+ Nouvelle checklist</button>
                  {Object.keys(checklistsData).sort((a,b)=>a.localeCompare(b)).map(name=>(
                    <div key={name} style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:C.panel,border:`1px solid ${C.border}`,borderRadius:9,padding:"11px 14px",marginBottom:7}}>
                      <div>
                        <div style={{fontSize:13,fontWeight:700}}>🚑 {name}</div>
                        <div style={{fontSize:10,color:C.muted}}>Norme {checklistsData[name].norme} · {(checklistsData[name].sections||[]).length} section(s)</div>
                      </div>
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={()=>openEditChecklist(name)} style={{background:"transparent",border:`1px solid ${C.border}`,borderRadius:6,color:C.muted,padding:"6px 10px",fontSize:12,cursor:"pointer"}}>✏️</button>
                        <button onClick={()=>setConfirmDeleteChecklist(name)} style={{background:C.dangerSoft,border:`1px solid ${C.danger}`,borderRadius:6,color:C.danger,padding:"6px 10px",fontSize:12,cursor:"pointer"}}>🗑</button>
                      </div>
                    </div>
                  ))}

                  <div style={{marginTop:28,paddingTop:20,borderTop:`1px solid ${C.border}`}}>
                    <div style={{fontSize:13,fontWeight:800,color:C.text,marginBottom:6}}>♿ Sac TPMR/VSL</div>
                    <div style={{fontSize:11,color:C.muted,marginBottom:16}}>Modèle unique, partagé par les 10 véhicules TPMR/VSL — une seule modification s'applique à tous. Check mensuelle.</div>
                    {tpmrVslTemplate.sections.map((section,sIdx)=>(
                      <div key={sIdx} style={{border:`1px solid ${C.border}`,borderRadius:10,padding:"12px",marginBottom:10,background:C.panel}}>
                        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10}}>
                          <input value={section.label} onChange={e=>setTpmrVslTemplate(p=>({...p,sections:p.sections.map((s,i)=>i===sIdx?{...s,label:e.target.value}:s)}))} placeholder="Nom de la section" style={{flex:1,background:C.bg,color:C.text,fontSize:12,border:`1px solid ${C.border}`,borderRadius:7,padding:"7px 10px"}}/>
                          <button onClick={()=>setTpmrVslTemplate(p=>({...p,sections:p.sections.filter((_,i)=>i!==sIdx)}))} style={{background:C.dangerSoft,border:`1px solid ${C.danger}`,borderRadius:6,color:C.danger,padding:"6px 9px",fontSize:11,cursor:"pointer"}}>🗑</button>
                        </div>
                        {(section.shelves[0]?.items||[]).map((item,itIdx)=>(
                          <div key={itIdx} style={{marginBottom:8,paddingBottom:8,borderBottom:`1px solid ${C.border}`}}>
                            <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:5,flexWrap:"wrap"}}>
                              <input value={item.n} onChange={e=>setTpmrVslTemplate(p=>({...p,sections:p.sections.map((s,i)=>i!==sIdx?s:{...s,shelves:[{...s.shelves[0],items:s.shelves[0].items.map((it,j)=>j!==itIdx?it:{...it,n:e.target.value})}]})}))} placeholder="Nom de l'article" style={{flex:2,minWidth:120,background:C.bg,color:C.text,fontSize:11,border:`1px solid ${C.border}`,borderRadius:6,padding:"6px 9px"}}/>
                              <input type="number" min="1" value={item.q||1} onChange={e=>setTpmrVslTemplate(p=>({...p,sections:p.sections.map((s,i)=>i!==sIdx?s:{...s,shelves:[{...s.shelves[0],items:s.shelves[0].items.map((it,j)=>j!==itIdx?it:{...it,q:parseInt(e.target.value)||1})}]})}))} title="Quantité requise" style={{width:50,background:C.bg,color:C.text,fontSize:11,border:`1px solid ${C.border}`,borderRadius:6,padding:"6px"}}/>
                              {[["t","TEST"],["s","SCELLÉ"],["p","PÉREMPT."],["container","CONTENANT"]].map(([f,l])=>(
                                <button key={f} onClick={()=>setTpmrVslTemplate(p=>({...p,sections:p.sections.map((s,i)=>i!==sIdx?s:{...s,shelves:[{...s.shelves[0],items:s.shelves[0].items.map((it,j)=>j!==itIdx?it:{...it,[f]:!it[f]})}]})}))} style={{padding:"4px 7px",borderRadius:5,border:`1px solid ${item[f]?C.accent:C.border}`,background:item[f]?C.accentSoft:"transparent",color:item[f]?C.accent:C.muted,fontSize:9,fontWeight:700,cursor:"pointer"}}>{l}</button>
                              ))}
                              <button onClick={()=>setTpmrVslTemplate(p=>({...p,sections:p.sections.map((s,i)=>i!==sIdx?s:{...s,shelves:[{...s.shelves[0],items:s.shelves[0].items.filter((_,j)=>j!==itIdx)}]})}))} style={{background:C.dangerSoft,border:`1px solid ${C.danger}`,borderRadius:5,color:C.danger,padding:"4px 8px",fontSize:10,cursor:"pointer"}}>🗑</button>
                            </div>
                            {item.container&&(
                              <div style={{marginLeft:14,paddingLeft:10,borderLeft:`2px solid ${C.border}`}}>
                                <div style={{fontSize:9,color:C.muted,textTransform:"uppercase",marginBottom:5}}>Contenu (articles à l'intérieur, avec péremption individuelle)</div>
                                {(item.subItems||[]).map((sub,subIdx)=>(
                                  <div key={subIdx} style={{display:"flex",gap:6,marginBottom:4}}>
                                    <input value={sub.n} onChange={e=>setTpmrVslTemplate(p=>({...p,sections:p.sections.map((s,i)=>i!==sIdx?s:{...s,shelves:[{...s.shelves[0],items:s.shelves[0].items.map((it,j)=>j!==itIdx?it:{...it,subItems:it.subItems.map((su,k)=>k!==subIdx?su:{...su,n:e.target.value})})}]})}))} placeholder="Nom de l'article intérieur" style={{flex:1,background:C.bg,color:C.text,fontSize:11,border:`1px solid ${C.border}`,borderRadius:6,padding:"5px 8px"}}/>
                                    <button onClick={()=>setTpmrVslTemplate(p=>({...p,sections:p.sections.map((s,i)=>i!==sIdx?s:{...s,shelves:[{...s.shelves[0],items:s.shelves[0].items.map((it,j)=>j!==itIdx?it:{...it,subItems:it.subItems.filter((_,k)=>k!==subIdx)})}]})}))} style={{background:C.dangerSoft,border:`1px solid ${C.danger}`,borderRadius:5,color:C.danger,padding:"4px 8px",fontSize:10,cursor:"pointer"}}>🗑</button>
                                  </div>
                                ))}
                                <button onClick={()=>setTpmrVslTemplate(p=>({...p,sections:p.sections.map((s,i)=>i!==sIdx?s:{...s,shelves:[{...s.shelves[0],items:s.shelves[0].items.map((it,j)=>j!==itIdx?it:{...it,subItems:[...(it.subItems||[]),{n:""}]})}]})}))} style={{background:"transparent",border:`1px dashed ${C.border}`,borderRadius:6,color:C.muted,padding:"5px 10px",fontSize:10,cursor:"pointer"}}>+ Article dans la trousse</button>
                              </div>
                            )}
                          </div>
                        ))}
                        <button onClick={()=>setTpmrVslTemplate(p=>({...p,sections:p.sections.map((s,i)=>i!==sIdx?s:{...s,shelves:[{...s.shelves[0],items:[...s.shelves[0].items,{n:"",p:false}]}]})}))} style={{background:"transparent",border:`1px dashed ${C.border}`,borderRadius:7,color:C.muted,padding:"7px 12px",fontSize:11,cursor:"pointer"}}>+ Article</button>
                      </div>
                    ))}
                    <button onClick={()=>setTpmrVslTemplate(p=>({...p,sections:[...p.sections,{id:"s"+Date.now(),label:"",color:"#dc2626",shelves:[{id:"A",label:"",items:[]}]}]}))} style={{width:"100%",background:C.accentSoft,border:`1px solid ${C.accent}`,borderRadius:9,color:C.accent,padding:"10px 16px",fontSize:13,fontWeight:700,cursor:"pointer"}}>+ Nouvelle section</button>
                  </div>
                </>
              ):(
                <div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:16}}>
                    <div>
                      <div style={{fontSize:10,color:C.muted,marginBottom:5,textTransform:"uppercase"}}>Nom du véhicule</div>
                      <input value={editingChecklist.key} onChange={e=>setEditingChecklist(p=>({...p,key:e.target.value}))} placeholder="ex: ALPHA 8" style={{width:"100%",background:C.bg,color:C.text,fontSize:13,border:`1.5px solid ${C.border}`,borderRadius:9,padding:"9px 12px",outline:"none"}}/>
                    </div>
                    <div>
                      <div style={{fontSize:10,color:C.muted,marginBottom:5,textTransform:"uppercase"}}>Norme</div>
                      <input value={editingChecklist.norme} onChange={e=>setEditingChecklist(p=>({...p,norme:e.target.value}))} placeholder="ATNUP" style={{width:"100%",background:C.bg,color:C.text,fontSize:13,border:`1.5px solid ${C.border}`,borderRadius:9,padding:"9px 12px",outline:"none"}}/>
                    </div>
                    <div>
                      <div style={{fontSize:10,color:C.muted,marginBottom:5,textTransform:"uppercase"}}>Édition</div>
                      <input value={editingChecklist.edition} onChange={e=>setEditingChecklist(p=>({...p,edition:e.target.value}))} placeholder="01/2026" style={{width:"100%",background:C.bg,color:C.text,fontSize:13,border:`1.5px solid ${C.border}`,borderRadius:9,padding:"9px 12px",outline:"none"}}/>
                    </div>
                  </div>

                  {editingChecklist.sections.map((section,sIdx)=>(
                    <div key={sIdx} style={{border:`1px solid ${C.border}`,borderRadius:10,padding:"12px",marginBottom:10,background:C.panel}}>
                      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10}}>
                        <input value={section.id} onChange={e=>updateSection(sIdx,"id",e.target.value)} placeholder="ID" style={{width:44,background:C.bg,color:C.text,fontSize:12,border:`1px solid ${C.border}`,borderRadius:7,padding:"7px",textAlign:"center"}}/>
                        <input value={section.label} onChange={e=>updateSection(sIdx,"label",e.target.value)} placeholder="Nom de la section" style={{flex:1,background:C.bg,color:C.text,fontSize:12,border:`1px solid ${C.border}`,borderRadius:7,padding:"7px 10px"}}/>
                        <button onClick={()=>removeSection(sIdx)} style={{background:C.dangerSoft,border:`1px solid ${C.danger}`,borderRadius:6,color:C.danger,padding:"6px 9px",fontSize:11,cursor:"pointer"}}>🗑</button>
                      </div>
                      {section.shelves.map((shelf,shIdx)=>(
                        <div key={shIdx} style={{marginLeft:10,marginBottom:8,paddingLeft:10,borderLeft:`2px solid ${C.border}`}}>
                          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:6}}>
                            <input value={shelf.label} onChange={e=>updateShelf(sIdx,shIdx,"label",e.target.value)} placeholder="Nom de l'étagère (optionnel)" style={{flex:1,background:C.bg,color:C.text,fontSize:11,border:`1px solid ${C.border}`,borderRadius:6,padding:"6px 9px"}}/>
                            <button onClick={()=>removeShelf(sIdx,shIdx)} style={{background:C.dangerSoft,border:`1px solid ${C.danger}`,borderRadius:6,color:C.danger,padding:"5px 8px",fontSize:10,cursor:"pointer"}}>🗑</button>
                          </div>
                          {shelf.items.map((item,itIdx)=>(
                            <div key={itIdx} style={{display:"flex",gap:6,alignItems:"center",marginBottom:5,flexWrap:"wrap"}}>
                              <input value={item.n} onChange={e=>updateItem(sIdx,shIdx,itIdx,"n",e.target.value)} placeholder="Nom de l'article" style={{flex:2,minWidth:120,background:C.bg,color:C.text,fontSize:11,border:`1px solid ${C.border}`,borderRadius:6,padding:"6px 9px"}}/>
                              <input type="number" value={item.q||1} onChange={e=>updateItem(sIdx,shIdx,itIdx,"q",parseInt(e.target.value)||1)} style={{width:50,background:C.bg,color:C.text,fontSize:11,border:`1px solid ${C.border}`,borderRadius:6,padding:"6px"}}/>
                              {[["t","TEST"],["s","SCELLÉ"],["p","PÉREMPT."],["okOnly","OK SEUL"]].map(([f,l])=>(
                                <button key={f} onClick={()=>updateItem(sIdx,shIdx,itIdx,f,!item[f])} style={{padding:"4px 7px",borderRadius:5,border:`1px solid ${item[f]?C.accent:C.border}`,background:item[f]?C.accentSoft:"transparent",color:item[f]?C.accent:C.muted,fontSize:9,fontWeight:700,cursor:"pointer"}}>{l}</button>
                              ))}
                              <button onClick={()=>removeItem(sIdx,shIdx,itIdx)} style={{background:C.dangerSoft,border:`1px solid ${C.danger}`,borderRadius:5,color:C.danger,padding:"4px 7px",fontSize:10,cursor:"pointer"}}>✕</button>
                            </div>
                          ))}
                          <button onClick={()=>addItem(sIdx,shIdx)} style={{background:"transparent",border:`1px dashed ${C.border}`,borderRadius:6,color:C.muted,padding:"5px 10px",fontSize:10,cursor:"pointer",marginTop:4}}>+ Article</button>
                        </div>
                      ))}
                      <button onClick={()=>addShelf(sIdx)} style={{background:"transparent",border:`1px dashed ${C.border}`,borderRadius:6,color:C.muted,padding:"6px 10px",fontSize:11,cursor:"pointer",marginLeft:10}}>+ Étagère</button>
                    </div>
                  ))}
                  <button onClick={addSection} style={{background:C.panel2,border:`1px dashed ${C.border}`,borderRadius:9,color:C.muted,padding:"9px 14px",fontSize:12,fontWeight:700,cursor:"pointer",marginBottom:20}}>+ Section</button>

                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>setEditingChecklist(null)} style={{flex:1,background:C.panel2,border:`1px solid ${C.border}`,borderRadius:9,color:C.muted,padding:"11px",fontWeight:700,fontSize:13,cursor:"pointer"}}>Annuler</button>
                    <button onClick={saveChecklist} disabled={!editingChecklist.key.trim()} style={{flex:1,background:editingChecklist.key.trim()?C.success:C.panel2,border:"none",borderRadius:9,color:editingChecklist.key.trim()?"white":C.muted,padding:"11px",fontWeight:700,fontSize:13,cursor:editingChecklist.key.trim()?"pointer":"not-allowed"}}>✅ Enregistrer</button>
                  </div>
                </div>
              )}

              {confirmDeleteChecklist&&(
                <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:350}}>
                  <div style={{background:C.panel,border:`1px solid ${C.danger}`,borderRadius:16,padding:"24px",width:360,maxWidth:"92vw"}}>
                    <div style={{fontWeight:800,fontSize:16,marginBottom:10}}>🗑 Supprimer la checklist ?</div>
                    <div style={{fontSize:13,color:C.muted,marginBottom:20}}>Es-tu sûr de vouloir supprimer définitivement la checklist de <strong style={{color:C.text}}>{confirmDeleteChecklist}</strong> ? Cette action est irréversible.</div>
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={()=>setConfirmDeleteChecklist(null)} style={{flex:1,background:C.panel2,border:`1px solid ${C.border}`,borderRadius:9,color:C.muted,padding:"11px",fontWeight:700,fontSize:13,cursor:"pointer"}}>Annuler</button>
                      <button onClick={()=>{setChecklistsData(prev=>{const next={...prev};delete next[confirmDeleteChecklist];return next;});setConfirmDeleteChecklist(null);}} style={{flex:1,background:C.danger,border:"none",borderRadius:9,color:"white",padding:"11px",fontWeight:700,fontSize:13,cursor:"pointer"}}>🗑 Supprimer</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        {tab==="scelles"&&<SealedTemplatesEditor templates={sealedTemplates} setTemplates={setSealedTemplates}/>}
        {tab==="seuils"&&(
          <div>
            <SectionTitle icon="📉" title="Seuil minimum par défaut"/>
            <div style={{ fontSize:12, color:CK_C.muted, marginBottom:14 }}>Un produit est « sous le seuil » quand son stock est inférieur à ce pourcentage de sa quantité requise (arrondi à l'unité supérieure). Tu peux fixer un seuil précis pour un produit depuis sa fiche (Réappro véhicules). 0 = pas d'alerte par défaut.</div>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <input type="number" min="0" max="100" value={stockPct} onChange={e=>setStockPct(Math.max(0,Math.min(100,parseInt(e.target.value)||0)))} style={{ width:90, background:CK_C.bg, color:CK_C.text, fontSize:18, fontWeight:800, border:`1px solid ${CK_C.border}`, borderRadius:9, padding:"10px", textAlign:"center" }}/>
              <span style={{ fontSize:14, fontWeight:700 }}>% de la quantité requise</span>
            </div>
            <div style={{ fontSize:11, color:CK_C.muted, marginTop:12 }}>Exemples avec {stockPct}% : requis 10 → seuil {Math.ceil(10*stockPct/100)} · requis 4 → seuil {Math.ceil(4*stockPct/100)} · requis 1 → seuil {Math.ceil(1*stockPct/100)}</div>
          </div>
        )}
        {tab==="import"&&(
          <div>
            <SectionTitle icon="⬇️" title="Importer depuis DispatchAI"/>
            <div style={{ fontSize:12, color:CK_C.muted, marginBottom:14 }}>Copie dans cette app : les modèles de checklists (Alpha et sac TPMR/VSL), les listes d'emails, les lots de péremption, la réserve O₂ et son historique, et l'historique des checklists. À faire une seule fois, au moment où DispatchAI devient l'app officielle.</div>
            <div style={{ background:CK_C.dangerSoft, border:`1px solid ${CK_C.danger}`, borderRadius:10, padding:"10px 12px", fontSize:12, color:CK_C.danger, fontWeight:600, marginBottom:14 }}>⚠ L'import remplace les réglages, les lots de péremption, la réserve O₂ et les historiques déjà présents dans cette app.</div>
            <button disabled={importBusy} onClick={()=>setConfirmImport(true)} style={{ background:C.accent, border:"none", borderRadius:10, color:"white", padding:"13px 20px", fontWeight:800, fontSize:14, opacity:importBusy?0.6:1 }}>{importBusy?"Import en cours…":"⬇️ Importer depuis DispatchAI"}</button>
            {importLog.length>0&&(
              <div style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:10, padding:"12px 14px", marginTop:14, fontSize:12, lineHeight:1.7 }}>
                {importLog.map((l,i)=>(<div key={i}>{l}</div>))}
              </div>
            )}
          </div>
        )}
      </div>
      {confirmImport&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:700}}>
          <div style={{background:CK_C.panel,border:`1px solid ${CK_C.danger}`,borderRadius:16,padding:"24px",width:380,maxWidth:"92vw"}}>
            <div style={{fontWeight:800,fontSize:16,marginBottom:10}}>⬇️ Importer depuis DispatchAI ?</div>
            <div style={{fontSize:13,color:CK_C.muted,marginBottom:20}}>Les données actuelles de cette app seront <strong style={{color:CK_C.text}}>écrasées</strong> par celles de DispatchAI. Continuer ?</div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setConfirmImport(false)} style={{flex:1,background:CK_C.panel2,border:`1px solid ${CK_C.border}`,borderRadius:9,color:CK_C.muted,padding:"11px",fontWeight:700,fontSize:13}}>Annuler</button>
              <button onClick={runImport} style={{flex:1,background:CK_C.danger,border:"none",borderRadius:9,color:"white",padding:"11px",fontWeight:700,fontSize:13}}>Importer</button>
            </div>
          </div>
        </div>
      )}
    </Page>
  );
}

// ═══════════════════════════════════════════════════════════════
// ACCUEIL — 2 icônes : Checklist et Réappro
// ═══════════════════════════════════════════════════════════════
function HomeView({ onGo, onSettings, onHistory, checklistsData, tpmrVslTemplate, stockInit, stockPct, themeMode, toggleTheme }){
  const stockMap=useStockMap();
  const ambStatuses=useChecklistsMonthStatus(checklistsData);
  const tpmrChecklists=buildTpmrChecklists(tpmrVslTemplate);
  const tpmrStatuses=useChecklistsMonthStatus(tpmrChecklists);
  const sealedTasks=useSealedTasks();
  const openIssues=useOpenIssues();
  const pending=Object.keys(checklistsData).filter(n=>!ambStatuses[n]?.sent).length
    +Object.keys(tpmrChecklists).filter(n=>!tpmrStatuses[n]?.sent).length
    +sealedTasks.length;
  const lowTotal=allVehicleNames(checklistsData).reduce((s,v)=>{
    if(!(stockInit&&stockInit[v])) return s;
    return s+buildCatalogue(v,checklistsData,tpmrVslTemplate).filter(e=>isLow(stockMap,e,stockPct)).length;
  },0);
  const tile=(icon,label,sub,target,badge,badgeColor)=>(
    <button onClick={()=>onGo(target)} style={{ background:CK_C.panel, border:`1px solid ${CK_C.border}`, borderRadius:22, padding:"34px 16px", color:CK_C.text, display:"flex", flexDirection:"column", alignItems:"center", gap:10, position:"relative", minHeight:210, justifyContent:"center" }}>
      <div style={{ fontSize:64, lineHeight:1 }}>{icon}</div>
      <div style={{ fontWeight:900, fontSize:22 }}>{label}</div>
      <div style={{ fontSize:12, color:CK_C.muted, textAlign:"center" }}>{sub}</div>
      {badge>0&&<div style={{ position:"absolute", top:14, right:14 }}><Badge n={badge} color={badgeColor}/></div>}
    </button>
  );
  return(
    <Page>
      <TopBar title="A.P.S." subtitle="Checklist & Réappro" themeMode={themeMode} toggleTheme={toggleTheme} onSettings={onSettings} onHistory={onHistory}/>
      <div style={{ flex:1, padding:"24px 18px", maxWidth:720, margin:"0 auto", width:"100%", display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))", gap:18, alignContent:"center" }}>
        {tile("📋","Checklist","Contrôle mensuel des véhicules","checklist",pending,"#f59e0b")}
        {tile("📦","Réappro","O₂ · produits des véhicules · remarques","reappro",lowTotal+openIssues.length)}
      </div>
    </Page>
  );
}

export default function App(){
  const [themeMode,setThemeMode]=useState(getStoredThemeMode());
  const toggleTheme=()=>{
    const next=themeMode==="light"?"dark":"light";
    applyCkThemeMode(next);
    try{ localStorage.setItem("aps_checklist_theme",next); }catch(e){}
    setThemeMode(next);
  };
  const [view,setView]=useState("home"); // home | checklist | reappro | historique | parametres

  const [checklistsData,setChecklistsData]=useSettings("checklistsData",INIT_CHECKLISTS);
  const [tpmrVslTemplate,setTpmrVslTemplate]=useSettings("tpmrVslChecklistTemplate",{ sections:[] });
  const [checklistEmails,setChecklistEmails]=useSettings("checklistEmails",[]);
  const [o2Emails,setO2Emails]=useSettings("o2Emails",[]);
  const [peremptionEmails,setPeremptionEmails]=useSettings("peremptionEmails",[]);
  const [stockEmails,setStockEmails]=useSettings("stockEmails",[]);
  const [stockInit,setStockInit]=useSettings("stockInit",{});
  const [stockPct,setStockPct]=useSettings("stockPct",30);
  const [sealedTemplates,setSealedTemplates]=useSettings("sealedTemplates",[]);

  // Alertes de péremption : vérifiées une fois au démarrage (dès que les
  // destinataires sont chargés), pas seulement à l'ouverture de l'écran Péremption.
  useEffect(()=>{
    if(!peremptionEmails||peremptionEmails.length===0) return;
    checkAndSendPeremptionAlerts(checklistsData, peremptionEmails);
    // La tablette murale reste ouverte : on revérifie toutes les 6 h
    const t=setInterval(()=>checkAndSendPeremptionAlerts(checklistsData, peremptionEmails), 6*60*60*1000);
    return ()=>clearInterval(t);
  },[peremptionEmails]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(()=>{ cleanOldHistorique(); },[]);

  const goHome=()=>setView("home");
  const common={ themeMode, toggleTheme };
  const openSettings=()=>setView("parametres");
  const openHistory=()=>setView("historique");

  let content;
  if(view==="checklist") content=<ChecklistHome onBack={goHome} onSettings={openSettings} onHistory={openHistory} checklists={checklistsData} emails={checklistEmails} tpmrVslTemplate={tpmrVslTemplate} sealedTemplates={sealedTemplates} stockInit={stockInit} {...common}/>;
  else if(view==="reappro") content=<ReapproHome checklists={checklistsData} tpmrVslTemplate={tpmrVslTemplate} stockInit={stockInit} setStockInit={setStockInit} pct={stockPct} stockEmails={stockEmails} remarqueEmails={checklistEmails} o2Emails={o2Emails} onBack={goHome} onSettings={openSettings} onHistory={openHistory} {...common}/>;
  else if(view==="historique") content=<HistoriqueHome onBack={goHome} checklists={checklistsData} tpmrVslTemplate={tpmrVslTemplate} peremptionEmails={peremptionEmails} {...common}/>;
  else if(view==="parametres") content=<ParametresView checklistsData={checklistsData} setChecklistsData={setChecklistsData} tpmrVslTemplate={tpmrVslTemplate} setTpmrVslTemplate={setTpmrVslTemplate} checklistEmails={checklistEmails} setChecklistEmails={setChecklistEmails} o2Emails={o2Emails} setO2Emails={setO2Emails} peremptionEmails={peremptionEmails} setPeremptionEmails={setPeremptionEmails} stockEmails={stockEmails} setStockEmails={setStockEmails} stockPct={stockPct} setStockPct={setStockPct} sealedTemplates={sealedTemplates} setSealedTemplates={setSealedTemplates} onBack={goHome} {...common}/>;
  else content=<HomeView onGo={setView} onSettings={openSettings} onHistory={openHistory} checklistsData={checklistsData} tpmrVslTemplate={tpmrVslTemplate} stockInit={stockInit} stockPct={stockPct} {...common}/>;

  return <StockProvider>{content}</StockProvider>;
}
