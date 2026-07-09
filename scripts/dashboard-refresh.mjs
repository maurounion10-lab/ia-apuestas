// ════════════════════════════════════════════════════════════════════════
// dashboard-refresh.mjs — alimenta el Centro de Control de Gambeta
//
// Baja GA4 (Data API) + Microsoft Clarity (Data Export) + gambeta /api/sb,
// calcula métricas derivadas y un análisis con IA (Claude), y escribe
// code/secreto/analytics/data.json (queda tras el gate de clave).
//
// Credenciales: lee de variables de entorno (para CI/GitHub Actions) y si no
// existen, del .env local + google-service-account.json (para correr a mano).
//
// Uso local:  node scripts/dashboard-refresh.mjs
// Luego:      cd code && git add secreto/analytics && git commit && git push
//
// ⚠️ Clarity: 10 llamadas/día por proyecto → máx ~4 refresh/día.
// ════════════════════════════════════════════════════════════════════════
import { createSign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Este script vive en code/scripts/ y escribe en code/secreto/analytics/.
//   · CI (GitHub Action): credenciales por env var (Secrets del repo).
//   · Local (dev): credenciales del .env + google-service-account.json del
//     workspace padre (gambeta-ai/), un nivel arriba del repo code/.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');   // .../code
const OUT_DIR = join(REPO, 'secreto', 'analytics');
const OUT_FILE = join(OUT_DIR, 'data.json');
const LOCAL_ENV = join(REPO, '..', '.env');
const LOCAL_SA = join(REPO, '..', 'google-service-account.json');

// ── credenciales (env var primero, luego .env local del workspace padre) ──
const fileEnv = existsSync(LOCAL_ENV)
  ? Object.fromEntries(readFileSync(LOCAL_ENV, 'utf8').split('\n')
      .filter(l => /^[A-Z0-9_]+=/.test(l))
      .map(l => {
        const eq = l.indexOf('=');
        let v = l.slice(eq + 1);
        const c = v.indexOf(' #');            // strip inline comment " # ..."
        if (c >= 0) v = v.slice(0, c);
        return [l.slice(0, eq), v.trim()];
      }))
  : {};
const E = (k) => process.env[k] || fileEnv[k] || '';
const PROP = E('GA4_PROPERTY_ID');
const SA = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  : JSON.parse(readFileSync(LOCAL_SA, 'utf8'));

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

// ── GA4 ──
async function ga4Token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const body = b64url({ iss: SA.client_email, scope: 'https://www.googleapis.com/auth/analytics.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const s = createSign('RSA-SHA256'); s.update(`${head}.${body}`);
  const jwt = `${head}.${body}.${s.sign(SA.private_key, 'base64url')}`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('GA4 auth: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}
let TOKEN;
async function report(body) {
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROP}:runReport`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (j.error) throw new Error('runReport: ' + j.error.message);
  return j;
}
const rows = (rep, fn) => (rep.rows || []).map(fn);
const mv = (row, i) => Number(row.metricValues?.[i]?.value || 0);
const dv = (row, i) => row.dimensionValues?.[i]?.value || '';
const R28 = [{ startDate: '28daysAgo', endDate: 'today' }];

// ── Clarity ──
async function clarity(token) {
  const r = await fetch('https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3', { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const arr = await r.json();
  const get = (name) => (Array.isArray(arr) ? arr : []).find(m => m.metricName === name)?.information || [];
  const first = (name) => get(name)[0] || {};
  const N = (v) => Number(v || 0);
  const traffic = first('Traffic');
  const clicks = (name) => ({ sessions: N(first(name).subTotal), pct: +N(first(name).sessionsWithMetricPercentage).toFixed(2) });
  const breakdown = (name, key) => get(name).map(x => ({ name: x.name || x[key] || '—', sessions: N(x.sessionsCount) })).sort((a, b) => b.sessions - a.sessions).slice(0, 8);
  return {
    totalSessions: N(traffic.totalSessionCount),
    uniqueUsers: N(traffic.distinctUserCount),
    botSessions: N(traffic.totalBotSessionCount),
    pagesPerSession: +N(traffic.pagesPerSessionPercentage).toFixed(2),
    rageClicks: clicks('RageClickCount'),
    deadClicks: clicks('DeadClickCount'),
    errorClicks: clicks('ErrorClickCount'),
    quickback: clicks('QuickbackClick'),
    excessiveScroll: clicks('ExcessiveScroll'),
    scriptErrors: clicks('ScriptErrorCount'),
    scrollDepth: +N(first('ScrollDepth').averageScrollDepth).toFixed(1),
    engagementTime: { total: N(first('EngagementTime').totalTime), active: N(first('EngagementTime').activeTime) },
    popularPages: get('PopularPages').slice(0, 8).map(p => ({ url: p.url || p.Url || p.name, visits: N(p.visitsCount || p.sessionsCount) })),
    devices: breakdown('Device', 'device'),
    browsers: breakdown('Browser', 'browser'),
    os: breakdown('OS', 'os'),
    countries: breakdown('Country', 'country'),
  };
}

// ── IA (Claude) ──
async function iaAnalysis(summary) {
  const key = E('ANTHROPIC_API_KEY');
  if (!key) return { error: 'no_key', text: 'Cargá ANTHROPIC_API_KEY en el .env para encender el análisis IA.' };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 900,
        messages: [{
          role: 'user',
          content: `Sos un analista de growth de Gambeta AI. accesoia.app es una landing "Meta-Ads safe" cuyo objetivo es capturar emails y llevar tráfico a gambeta.ai (picks de fútbol con IA). Analizá estos datos de los últimos 28 días y devolvé un diagnóstico BREVE en español rioplatense, accionable, sin relleno. Estructura: (1) 🟢 Qué funciona (1-2 líneas). (2) 🔴 El principal cuello de botella (con el número que lo prueba). (3) 🎯 Las 3 acciones concretas de mayor impacto, ordenadas. Máximo 180 palabras. Datos:\n${JSON.stringify(summary)}`
        }],
      }),
    });
    const j = await r.json();
    if (j.error) return { error: j.error.type || 'api_error', text: `El análisis IA no corrió: ${j.error.message}. (Suele ser falta de saldo — cargá crédito en console.anthropic.com y el próximo refresh lo genera.)`, at: new Date().toISOString() };
    return { text: (j.content?.[0]?.text || '').trim(), model: j.model, at: new Date().toISOString() };
  } catch (e) {
    return { error: 'exception', text: 'El análisis IA no corrió: ' + e.message, at: new Date().toISOString() };
  }
}

// ═══ main ═══
const prev = existsSync(OUT_FILE) ? JSON.parse(readFileSync(OUT_FILE, 'utf8')) : {};
TOKEN = await ga4Token();
console.log('✓ GA4 autenticado');

const [daily, hourly, sources, pages, landing, events, devices, countries, cities, newRet, durations] = await Promise.all([
  report({ dateRanges: R28, dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }, { name: 'averageSessionDuration' }, { name: 'engagementRate' }], orderBys: [{ dimension: { dimensionName: 'date' } }] }),
  report({ dateRanges: R28, dimensions: [{ name: 'hour' }], metrics: [{ name: 'sessions' }], orderBys: [{ dimension: { dimensionName: 'hour' } }] }),
  report({ dateRanges: R28, dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }], metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'engagementRate' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 12 }),
  report({ dateRanges: R28, dimensions: [{ name: 'hostName' }, { name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }, { name: 'averageSessionDuration' }], orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 15 }),
  report({ dateRanges: R28, dimensions: [{ name: 'landingPagePlusQueryString' }], metrics: [{ name: 'sessions' }, { name: 'bounceRate' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 10 }),
  report({ dateRanges: R28, dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }], orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 30 }),
  report({ dateRanges: R28, dimensions: [{ name: 'deviceCategory' }], metrics: [{ name: 'sessions' }, { name: 'engagementRate' }] }),
  report({ dateRanges: R28, dimensions: [{ name: 'country' }], metrics: [{ name: 'sessions' }, { name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 10 }),
  report({ dateRanges: R28, dimensions: [{ name: 'city' }], metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 8 }),
  report({ dateRanges: R28, dimensions: [{ name: 'newVsReturning' }], metrics: [{ name: 'sessions' }] }),
  report({ dateRanges: R28, dimensions: [{ name: 'deviceCategory' }], metrics: [{ name: 'sessions' }] }),
]);
console.log('✓ GA4 reportes (11)');

// Clarity (tolerante a fallos / cuota)
let cA = prev.clarity?.accesoia || null, cG = prev.clarity?.gambeta || null;
try { cA = await clarity(E('CLARITY_EXPORT_TOKEN_ACCESOIA')); console.log('✓ Clarity accesoia'); } catch (e) { console.log('⚠ Clarity accesoia: ' + e.message + ' (conservo previo)'); }
try { cG = await clarity(E('CLARITY_EXPORT_TOKEN_GAMBETA')); console.log('✓ Clarity gambeta'); } catch (e) { console.log('⚠ Clarity gambeta: ' + e.message + ' (conservo previo)'); }

// gambeta /api/sb
let picks = prev.picks || null;
try {
  const j = await (await fetch('https://gambeta.ai/api/sb?type=historial')).json();
  const arr = j?.[0]?.historial_full || [];
  const res = arr.filter(p => p.result === 'win' || p.result === 'loss');
  const now = Date.now(), DAY = 864e5, tsOf = p => p.commenceTs || (p.date ? Date.parse(p.date) : 0) || 0;
  const l30 = res.filter(p => { const t = tsOf(p); return t && (now - t) <= 30 * DAY; });
  const w = a => a.filter(p => p.result === 'win').length;
  picks = { total: arr.length, resueltos: res.length, accAllTime: res.length ? Math.round(100 * w(res) / res.length) : null, acc30d: l30.length ? Math.round(100 * w(l30) / l30.length) : null, pendientes: arr.filter(p => p.result === 'pending').length };
  console.log('✓ /api/sb');
} catch (e) { console.log('⚠ /api/sb: ' + e.message); }

// ── derivadas ──
const dailySeries = rows(daily, r => ({ date: dv(r, 0), users: mv(r, 0), sessions: mv(r, 1), pageviews: mv(r, 2), avgDur: Math.round(mv(r, 3)), engagement: +(mv(r, 4) * 100).toFixed(1) }));
const hourSeries = Array.from({ length: 24 }, (_, h) => ({ hour: h, sessions: 0 }));
rows(hourly, r => hourSeries[+dv(r, 0)] && (hourSeries[+dv(r, 0)].sessions = mv(r, 0)));
const eventMap = Object.fromEntries(rows(events, r => [dv(r, 0), mv(r, 0)]));
const totSessions = dailySeries.reduce((a, d) => a + d.sessions, 0);
const totUsers = dailySeries.reduce((a, d) => a + d.users, 0);
const totPV = dailySeries.reduce((a, d) => a + d.pageviews, 0);
const avgEng = dailySeries.length ? +(dailySeries.reduce((a, d) => a + d.engagement, 0) / dailySeries.filter(d => d.sessions).length || 0).toFixed(1) : 0;

const gateOpens = Object.entries(eventMap).filter(([k]) => /open_gate$/.test(k) || k === 'gate_manual_open').reduce((a, [, v]) => a + v, 0);
const gateShows = eventMap.gate_show || 0, formStarts = eventMap.form_start || 0, leads = eventMap.lead_capture || 0;
const tgClicks = eventMap.telegram_click || 0, gotoGambeta = eventMap.goto_gambeta || 0, eleccion = eventMap.eleccion_jugada || 0;
const funnel = {
  sessions: totSessions, gateShows, gateOpens, formStarts, leads, tgClicks, gotoGambeta, eleccion,
  gateOpenRate: totSessions ? +(100 * gateOpens / totSessions).toFixed(1) : 0,
  leadConvRate: totSessions ? +(100 * leads / totSessions).toFixed(2) : 0,
  gateToLeadRate: gateOpens ? +(100 * leads / gateOpens).toFixed(1) : 0,
  leadToGambetaRate: leads ? +(100 * gotoGambeta / leads).toFixed(1) : 0,
  formToLeadRate: formStarts ? +(100 * leads / formStarts).toFixed(1) : 0,
};
// conversión por fuente (leads no atribuibles por fuente en GA4 sin config, se usa engagementRate como proxy de calidad)
const sourcesData = rows(sources, r => ({ source: dv(r, 0), medium: dv(r, 1), sessions: mv(r, 0), users: mv(r, 1), engagement: +(mv(r, 2) * 100).toFixed(1) }));

const last = dailySeries[dailySeries.length - 1] || {}, prevD = dailySeries[dailySeries.length - 2] || {};
const delta = (a, b) => (b ? Math.round(100 * (a - b) / b) : null);

const summaryForIA = {
  periodo: '28 dias', usuarios: totUsers, sesiones: totSessions, conversion_pct: funnel.leadConvRate, leads: leads,
  embudo: funnel, fuentes: sourcesData.slice(0, 5), dispositivos: rows(devices, r => ({ d: dv(r, 0), s: mv(r, 0) })),
  paises: rows(countries, r => ({ c: dv(r, 0), s: mv(r, 0) })).slice(0, 4),
  scroll_accesoia_pct: cA?.scrollDepth, rage_clicks: cA?.rageClicks?.sessions, dead_clicks: cA?.deadClicks?.sessions,
  paginas_top: rows(pages, r => ({ p: dv(r, 0) + dv(r, 1), v: mv(r, 0) })).slice(0, 5), acierto_producto_30d: picks?.acc30d,
};
const ia = await iaAnalysis(summaryForIA);
console.log(ia.error ? `⚠ IA: ${ia.error}` : '✓ IA análisis generado');

const data = {
  generatedAt: new Date().toISOString(), propertyId: PROP, window: '28d',
  today: { ...last, dUsers: delta(last.users, prevD.users), dSessions: delta(last.sessions, prevD.sessions), dPageviews: delta(last.pageviews, prevD.pageviews) },
  totals: { sessions: totSessions, users: totUsers, pageviews: totPV, avgEngagement: avgEng, pagesPerSession: totSessions ? +(totPV / totSessions).toFixed(2) : 0 },
  daily: dailySeries, hourly: hourSeries,
  sources: sourcesData,
  pages: rows(pages, r => ({ host: dv(r, 0), path: dv(r, 1), views: mv(r, 0), users: mv(r, 1), avgDur: Math.round(mv(r, 2)) })),
  landing: rows(landing, r => ({ path: dv(r, 0), sessions: mv(r, 0), bounce: +(mv(r, 1) * 100).toFixed(1) })),
  events: eventMap,
  devices: rows(devices, r => ({ device: dv(r, 0), sessions: mv(r, 0), engagement: +(mv(r, 1) * 100).toFixed(1) })),
  countries: rows(countries, r => ({ country: dv(r, 0), sessions: mv(r, 0), users: mv(r, 1) })),
  cities: rows(cities, r => ({ city: dv(r, 0), sessions: mv(r, 0) })),
  newVsReturning: rows(newRet, r => ({ type: dv(r, 0), sessions: mv(r, 0) })),
  funnel,
  clarity: { accesoia: cA, gambeta: cG, note: 'ventana 3 días · cuota 10 req/día por proyecto · el heatmap visual está en clarity.microsoft.com' },
  picks, ia,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(data, null, 1));
console.log(`\n✅ data.json (${(JSON.stringify(data).length / 1024).toFixed(1)} KB) → ${totUsers} usuarios · ${totSessions} sesiones · ${leads} leads · conv ${funnel.leadConvRate}%`);
