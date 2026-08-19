// WG2 Team & Tasks — service worker
// Caches the app shell so it launches instantly and works offline.
// API calls (Apps Script) are always network-first and are never cached here —
// the app itself handles offline fallback for those via localStorage.

const CACHE_NAME = "wg2-team-app-v28";
const SHELL_FILES = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "config.js",
  "cluster_guide_2026.js",
  "manifest.webmanifest",
  "khs_logo_circle.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-512-maskable.png",
  "vendor/qrcode.js",
  "vendor/jsQR.js",
  "data/team.json",
  "data/tasks.json",
  "data/students.json",
  "data/attendance.json",
  "data/clusters.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never intercept calls to the Apps Script API — always go to the network.
  if (url.hostname.indexOf("script.google.com") !== -1) return;

  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((resp) => {
          if (resp && resp.status === 200 && url.origin === self.location.origin) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
