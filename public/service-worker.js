// A.P.S. Checklist — permet d'ouvrir l'app sans réseau.
// Dès la 1re ouverture avec du réseau, l'app est mémorisée sur le téléphone.
// Pages : réseau d'abord (toujours la dernière version quand il y a du réseau,
// avec une limite d'attente pour ne pas rester bloqué sur un réseau très faible),
// copie gardée en secours. Fichiers /static (noms uniques) : copie d'abord.
// Les données (Firebase) ne passent pas ici : elles ont leur propre cache hors ligne.
const CACHE = "aps-checklist-v2";
const PAGE_TIMEOUT_MS = 4000;

// Mémorise l'app complète dès l'installation.
async function precache() {
  const cache = await caches.open(CACHE);
  const urls = new Set(["/index.html", "/manifest.json", "/favicon-64.png", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png"]);
  try {
    const res = await fetch("/asset-manifest.json", { cache: "no-store" });
    const manifest = await res.json();
    Object.values(manifest.files || {}).forEach((u) => { if (typeof u === "string" && !u.endsWith(".map")) urls.add(u); });
    (manifest.entrypoints || []).forEach((u) => urls.add("/" + u));
  } catch (e) { /* on continue avec les fichiers de base */ }
  await Promise.all([...urls].map(async (u) => {
    try {
      const r = await fetch(u, { cache: "no-store" });
      if (r.ok) await cache.put(u, r);
    } catch (e) { /* un fichier manquant ne bloque pas les autres */ }
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    fetch(req).then((res) => { clearTimeout(timer); resolve(res); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Firebase, EmailJS, polices : on ne touche pas

  if (req.mode === "navigate") {
    event.respondWith(
      fetchWithTimeout(req, PAGE_TIMEOUT_MS)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("/index.html", copy)); }
          return res;
        })
        .catch(() => caches.match("/index.html").then((hit) => hit || fetch(req)))
    );
    return;
  }

  if (url.pathname.startsWith("/static/")) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res;
      }))
    );
    return;
  }

  event.respondWith(
    fetch(req)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
      .catch(() => caches.match(req))
  );
});
