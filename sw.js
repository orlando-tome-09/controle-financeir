// Guarda os arquivos do app e a biblioteca do Firebase para ele abrir mesmo sem internet.
var CACHE = "consultorio-v2";
var FILES = [
  "./", "./index.html", "./app.js", "./crypto.js", "./firebase-config.js",
  "./manifest.webmanifest", "./icon-180.png", "./icon-192.png", "./icon-512.png"
];
var FIREBASE_SDK = "https://www.gstatic.com/firebasejs/";

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(FILES); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

// Rede primeiro, para receber atualizações; o cache entra quando estiver sem internet.
// Chamadas ao banco (firestore.googleapis.com) passam direto: o próprio Firebase cuida delas.
self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  var sameOrigin = new URL(request.url).origin === self.location.origin;
  if (!sameOrigin && request.url.indexOf(FIREBASE_SDK) !== 0) return;
  event.respondWith(
    fetch(request)
      .then(function (response) {
        if (response.ok) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      })
      .catch(function () {
        return caches.match(request, { ignoreSearch: true }).then(function (hit) {
          if (hit) return hit;
          if (request.mode === "navigate") return caches.match("./");
          return Response.error();
        });
      })
  );
});
