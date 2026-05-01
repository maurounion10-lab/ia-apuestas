// gambeta.ai — Service Worker v1.8
const CACHE_NAME = 'gambeta-v9';
// NO cacheamos HTML — siempre se pide a la red para que los deploys sean inmediatos
const STATIC_ASSETS = [
  '/manifest.json',
  '/og-image.png'
];

// ─── Install: pre-cachear assets estáticos ───────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// ─── Activate: limpiar TODOS los caches viejos y tomar control inmediato ─────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => caches.delete(k))) // borra TODO, no solo los viejos
    ).then(() => self.clients.claim())
     .then(() => {
       // Forzar recarga de todos los clientes para que carguen el HTML fresco
       return self.clients.matchAll({ type: 'window' }).then(clients => {
         clients.forEach(client => client.navigate(client.url));
       });
     })
  );
});

// ─── Fetch: estrategia network-first para API, cache-first para estáticos ───
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Bypass service worker para peticiones de API, Supabase y Cloudflare Workers
  const isBypass =
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('workers.dev') ||
    url.hostname.includes('api-sports.io') ||
    url.hostname.includes('thesportsdb.com') ||
    url.hostname.includes('espncdn.com') ||
    url.pathname.startsWith('/api/');

  if (isBypass) {
    return; // deja que el navegador lo maneje normalmente
  }

  // Para navegación (HTML): NUNCA cachear — siempre red para que deploys sean instantáneos
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request));
    return;
  }

  // Para assets estáticos (imágenes, etc.): cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      });
    })
  );
});

// ─── Push notifications ──────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = { title: 'gambeta.ai', body: '¡Los picks de hoy ya están disponibles!', url: '/' };
  try { data = { ...data, ...event.data.json() }; } catch(e) {}

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // Si hay alguna pestaña visible con la app abierta, enviamos mensaje
      // para mostrar notificación in-page (no se superpone con el sponsor bar)
      const visible = clientList.filter(c => c.visibilityState === 'visible');
      if (visible.length > 0) {
        visible.forEach(c => c.postMessage({ type: 'push-in-page', data }));
        return Promise.resolve(); // no mostrar notificación nativa del browser
      }
      // Sin pestaña abierta → notificación nativa del OS
      return self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/og-image.png',
        badge: '/og-image.png',
        vibrate: [200, 100, 200],
        data: { url: data.url },
        actions: [
          { action: 'open', title: 'Ver picks' },
          { action: 'dismiss', title: 'Cerrar' }
        ]
      });
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes(self.location.origin));
      if (existing) { existing.focus(); existing.navigate(url); }
      else clients.openWindow(url);
    })
  );
});
