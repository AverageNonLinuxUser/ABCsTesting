var CACHE = 'daily-budget-v1';
var ASSETS = [
  './',
  './daily-budget.html',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(
        ASSETS.map(function (url) {
          return cache.add(url).catch(function () { /* ignore missing (e.g. index.html not yet created) */ });
        })
      );
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  var url = new URL(event.request.url);
  // Only handle same-origin; let fonts / CDNs pass through (with runtime cache fallback).
  if (url.origin !== location.origin) {
    event.respondWith(
      caches.match(event.request).then(function (cached) {
        return cached || fetch(event.request).then(function (res) {
          return res;
        }).catch(function () { return cached; });
      })
    );
    return;
  }
  // Navigation: network first, fall back to cached app shell.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(event.request, copy); });
        return res;
      }).catch(function () {
        return caches.match('./daily-budget.html').then(function (r) {
          return r || caches.match('./index.html');
        });
      })
    );
    return;
  }
  // Static assets: cache first, update in background.
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      var network = fetch(event.request).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(event.request, copy); });
        }
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    })
  );
});
