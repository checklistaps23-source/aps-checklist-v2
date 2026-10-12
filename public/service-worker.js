// A.P.S. Checklist — permet d'ouvrir l'app sans réseau.
// Pages : réseau d'abord (toujours la dernière version quand il y a du réseau),
// copie gardée en secours. Fichiers /static (noms uniques) : copie d'abord.
// Les données (Firebase) ne passent pas ici : elles ont leur propre cache hors ligne.
const CACHE = "aps-checklist-v1";

self.addEventListener("install", () => { self.skipWaiting(); });

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Firebase, EmailJS, polices : on ne touche pas

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put("/index.html", copy)); return res; })
        .catch(() => caches.match("/index.html"))
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
