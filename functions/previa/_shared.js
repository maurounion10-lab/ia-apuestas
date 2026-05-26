// Shared helpers for previa rendering and sitemap generation

export const SUPABASE_URL = 'https://ixfrtjvhnpapyuphqfxp.supabase.co';
export const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4ZnJ0anZobnBhcHl1cGhxZnhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDExOTMsImV4cCI6MjA4OTE3NzE5M30.Lc5cOfvXCrrMlm9Yup5GG6RgCxOB_GSNJnKLTb1-bZQ';
export const ADMIN_EMAIL = 'mauro.union10@gmail.com';

export function slugify(s) {
  return (s || '').toString().toLowerCase()
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a')
    .replace(/ł/g, 'l').replace(/ß/g, 'ss').replace(/ð/g, 'd').replace(/þ/g, 'th')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function pickSlug(p) {
  if (!p?.commenceTs) return null;
  const d = new Date(p.commenceTs);
  const dateStr = d.toISOString().slice(0, 10);
  const h = slugify(p.home);
  const a = slugify(p.away);
  if (!h || !a) return null;
  return `${h}-vs-${a}-${dateStr}`;
}

export async function fetchHistorial() {
  // Try shared_cache first, fall back to acoin_users
  const headers = {
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Accept': 'application/json',
  };
  const [r1, r2] = await Promise.allSettled([
    fetch(`${SUPABASE_URL}/rest/v1/shared_cache?key=eq.global_historial_v1&select=data&limit=1`, { headers, cf: { cacheTtl: 300, cacheEverything: true } }),
    fetch(`${SUPABASE_URL}/rest/v1/acoin_users?email=eq.${encodeURIComponent(ADMIN_EMAIL)}&select=historial_full&limit=1`, { headers, cf: { cacheTtl: 300, cacheEverything: true } }),
  ]);
  let fromCache = [], fromUsers = [];
  if (r1.status === 'fulfilled' && r1.value.ok) {
    const rows = await r1.value.json();
    fromCache = rows?.[0]?.data?.historial_full || [];
  }
  if (r2.status === 'fulfilled' && r2.value.ok) {
    const rows = await r2.value.json();
    fromUsers = rows?.[0]?.historial_full || [];
  }
  return fromUsers.length >= fromCache.length ? fromUsers : fromCache;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function formatDateAR(ts) {
  const d = new Date(ts);
  const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const parts = new Intl.DateTimeFormat('es-AR', {
    day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'America/Argentina/Buenos_Aires'
  }).formatToParts(d);
  const get = (t) => parts.find(p => p.type === t)?.value || '';
  return `${get('day')} de ${get('month')} ${get('year')} a las ${get('hour')}:${get('minute')} hs (ART)`;
}
