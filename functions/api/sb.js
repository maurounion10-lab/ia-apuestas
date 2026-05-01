/**
 * Cloudflare Pages Function: /api/sb
 * Proxy con caché edge para datos de Supabase.
 *
 * GET /api/sb?type=historial
 *   → Lee shared_cache (key=global_historial_v1) y devuelve [{ historial_full: [...] }]
 *   → Fallback: acoin_users.historial_full del admin si shared_cache está vacío
 *   → Cache de CDN: 5 min (s-maxage=300), stale-while-revalidate=120s
 */

const SB_URL = 'https://ixfrtjvhnpapyuphqfxp.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4ZnJ0anZobnBhcHl1cGhxZnhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDExOTMsImV4cCI6MjA4OTE3NzE5M30.Lc5cOfvXCrrMlm9Yup5GG6RgCxOB_GSNJnKLTb1-bZQ';
const ADMIN_EMAIL = 'mauro.union10@gmail.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

const CACHE_HEADERS = {
  ...CORS_HEADERS,
  'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=120',
};

function sbFetch(path) {
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Accept': 'application/json',
    },
  });
}

export async function onRequest(context) {
  const { request } = context;

  // Preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  if (type === 'historial') {
    try {
      // Leer ambas fuentes en paralelo y usar la que tenga MÁS picks
      const [r1, r2] = await Promise.allSettled([
        sbFetch(`shared_cache?key=eq.global_historial_v1&select=data&limit=1`),
        sbFetch(`acoin_users?email=eq.${encodeURIComponent(ADMIN_EMAIL)}&select=historial_full&limit=1`),
      ]);

      let fromCache = [];
      let fromUsers = [];

      if (r1.status === 'fulfilled' && r1.value.ok) {
        const rows = await r1.value.json();
        const d = rows?.[0]?.data;
        if (Array.isArray(d)) fromCache = d;
      }
      if (r2.status === 'fulfilled' && r2.value.ok) {
        const rows = await r2.value.json();
        const d = rows?.[0]?.historial_full;
        if (Array.isArray(d)) fromUsers = d;
      }

      // Usar la fuente con más picks
      const best = fromCache.length >= fromUsers.length ? fromCache : fromUsers;

      return new Response(
        JSON.stringify(best.length > 0 ? [{ historial_full: best }] : []),
        { headers: CACHE_HEADERS }
      );

    } catch (e) {
      return new Response(
        JSON.stringify({ error: e.message }),
        { status: 500, headers: CORS_HEADERS }
      );
    }
  }

  return new Response(
    JSON.stringify({ error: `unknown type: ${type}` }),
    { status: 400, headers: CORS_HEADERS }
  );
}
