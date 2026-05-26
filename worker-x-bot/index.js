/**
 * gambeta-x-bot — Bot de publicación automática en X (@Gambeta_ai)
 * ------------------------------------------------------------------
 * Genera tweets desde los PICKS REALES de Gambeta (plantillas + datos,
 * cero texto inventado) y los publica en X vía API v2 con OAuth 1.0a.
 *
 * v1.1: el slot "picks" adjunta una PLACA de imagen branded generada
 * en el propio worker (@cf-wasm/og). Si la imagen falla por lo que sea,
 * el post sale igual en modo texto (degradación segura).
 *
 * Secrets en Cloudflare → Settings → Variables and Secrets:
 *   X_API_KEY  X_API_SECRET  X_ACCESS_TOKEN  X_ACCESS_SECRET  TRIGGER_TOKEN
 * Variable BOT_MODE = "off" | "dry" | "live"
 */

import { ImageResponse } from '@cf-wasm/og';

const HIST_URL = 'https://gambeta.ai/api/sb?type=historial';
const X_TWEETS_URL = 'https://api.x.com/2/tweets';
const X_MEDIA_URL = 'https://upload.twitter.com/1.1/media/upload.json';
const ART_OFFSET = -3 * 3600 * 1000; // Argentina = UTC-3

// ───────────────────── Dedup de tweets (KV) ─────────────────────
// Hashea el contenido del tweet y lo guarda en KV. Antes de generar
// un nuevo tweet, el bot chequea que el hash NO esté ya marcado.
// Así jamás repite un mismo texto, incluso si el pool rota cada N días.
async function hashTweet(text) {
  const norm = (text || '').trim().replace(/\s+/g, ' ');
  const data = new TextEncoder().encode(norm);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).slice(0, 16)
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
async function wasPosted(text, env) {
  if (!env || !env.CACHE_KV || !text) return false;
  try { return (await env.CACHE_KV.get('xpost:' + (await hashTweet(text)))) !== null; }
  catch (e) { console.log('[dedup] read err:', e.message); return false; }
}
async function markPosted(text, env) {
  if (!env || !env.CACHE_KV || !text) return;
  try { await env.CACHE_KV.put('xpost:' + (await hashTweet(text)), '1'); }
  catch (e) { console.log('[dedup] write err:', e.message); }
}

// Recorre un pool empezando por el indice deterministico del dia y devuelve
// el primer texto que NO se haya posteado todavia. Si todos estan usados,
// devuelve null (el slot se salta — mejor saltar que repetir).
async function pickFreshFromPool(pool, env) {
  const start = dayOfYearART() % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const idx = (start + i) % pool.length;
    const text = pool[idx];
    if (!text) continue;
    if (!(await wasPosted(text, env))) return text;
  }
  return null;
}

// ───────────────────────── OAuth 1.0a ─────────────────────────
function pctEncode(s) {
  return encodeURIComponent(s).replace(/[!*'()]/g,
    c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function hmacSha1(keyStr, baseStr) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(keyStr), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(baseStr));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function oauthHeader(method, url, env) {
  const oauth = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  const paramStr = Object.keys(oauth).sort()
    .map(k => pctEncode(k) + '=' + pctEncode(oauth[k])).join('&');
  const base = method.toUpperCase() + '&' + pctEncode(url) + '&' + pctEncode(paramStr);
  const signingKey = pctEncode(env.X_API_SECRET) + '&' + pctEncode(env.X_ACCESS_SECRET);
  oauth.oauth_signature = await hmacSha1(signingKey, base);
  return 'OAuth ' + Object.keys(oauth).sort()
    .map(k => pctEncode(k) + '="' + pctEncode(oauth[k]) + '"').join(', ');
}

// Sube una imagen a X (v1.1 media/upload, multipart → la firma OAuth no
// incluye el body). Devuelve media_id_string.
async function uploadMediaToX(pngBytes, env) {
  const fd = new FormData();
  fd.append('media', new Blob([pngBytes], { type: 'image/png' }), 'card.png');
  const auth = await oauthHeader('POST', X_MEDIA_URL, env);
  const r = await fetch(X_MEDIA_URL, {
    method: 'POST', headers: { 'Authorization': auth }, body: fd,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('media/upload ' + r.status + ': ' + JSON.stringify(j));
  return j.media_id_string;
}

async function postTweet(text, env, opts = {}) {
  const body = { text };
  if (opts.replyToId) body.reply = { in_reply_to_tweet_id: opts.replyToId };
  if (opts.mediaId) body.media = { media_ids: [opts.mediaId] };
  const auth = await oauthHeader('POST', X_TWEETS_URL, env);
  const r = await fetch(X_TWEETS_URL, {
    method: 'POST',
    headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('X API ' + r.status + ': ' + JSON.stringify(j));
  return j.data && j.data.id;
}

// ───────────────────────── Escudos de equipos ─────────────────────────
function normTeam(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ø/g, 'o').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
let _logoMap = null;
async function fetchLogoMap() {
  if (_logoMap) return _logoMap;
  const map = {};
  try {
    const r = await fetch('https://gambeta.ai/?lm=2', { cf: { cacheTtl: 600 } });
    const html = await r.text();
    const m = html.match(/const teamLogos = \{([\s\S]*?)\n\};/);
    if (m) {
      // Acepta claves con apostrofos escapados ('O\'Higgins') y URLs tanto
      // absolutas (https://...) como relativas (/escudos/...). A las
      // relativas las prefija con https://gambeta.ai para que el worker
      // las pueda fetchear desde el edge.
      const re = /'((?:\\.|[^'\\])+)'\s*:\s*'((?:\/escudos\/|https?:\/\/)[^']+)'/g;
      let mm;
      while ((mm = re.exec(m[1]))) {
        const rawKey = mm[1].replace(/\\'/g, "'");
        const k = normTeam(rawKey);
        let url = mm[2];
        if (url.startsWith('/escudos/')) url = 'https://gambeta.ai' + url;
        if (!map[k]) map[k] = url;
      }
    }
  } catch (e) {}
  _logoMap = map;
  return map;
}
async function resolveEscudo(name, map) {
  const u = map[normTeam(name)];
  if (!u) return null;
  try { const r = await fetch(u, { cf: { cacheTtl: 86400 } }); return r.ok ? u : null; }
  catch (e) { return null; }
}
function initialsBadge(name, size) {
  const w = (name || '?').replace(/[^\wáéíóúñ ]/gi, '').trim().split(/\s+/).filter(Boolean);
  const ini = !w.length ? '?'
    : w.length === 1 ? w[0].slice(0, 2).toUpperCase()
    : (w[0][0] + w[w.length - 1][0]).toUpperCase();
  return el('div', {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: size + 'px', height: size + 'px', borderRadius: size + 'px',
    background: '#16331f', color: '#cfe9d8', fontSize: Math.round(size * 0.34) + 'px',
    fontWeight: 800,
  }, ini);
}
// Tracker global de escudos faltantes durante el render actual.
// runSlot lo chequea antes de postear para decidir si saltea la placa.
let _missingShields = [];
function escudoEl(name, url, size) {
  if (url) return { type: 'img', props: { src: url, width: size, height: size,
    style: { width: size + 'px', height: size + 'px', objectFit: 'contain' } } };
  _missingShields.push(name);
  console.log('[x-bot] sin escudo para:', name);
  return initialsBadge(name, size);
}

// ───────────────────────── Forma reciente (ESPN) ─────────────────────────
// _sportKey del pick → slug de liga en ESPN.
const ESPN_LEAGUE = {
  soccer_epl: 'eng.1', soccer_spain_la_liga: 'esp.1', soccer_germany_bundesliga: 'ger.1',
  soccer_italy_serie_a: 'ita.1', soccer_france_ligue_one: 'fra.1',
  soccer_netherlands_eredivisie: 'ned.1', soccer_usa_mls: 'usa.1',
  soccer_mexico_ligamx: 'mex.1', soccer_turkey_super_league: 'tur.1',
  soccer_switzerland_superleague: 'sui.1', soccer_greece_super_league: 'gre.1',
  soccer_russia_premier_league: 'rus.1', soccer_australia_aleague: 'aus.1',
  soccer_norway_eliteserien: 'nor.1', soccer_sweden_allsvenskan: 'swe.1',
  soccer_denmark_superliga: 'den.1', soccer_brazil_campeonato: 'bra.1',
  soccer_argentina_primera_division: 'arg.1', soccer_spain_segunda_division: 'esp.2',
  soccer_italy_serie_b: 'ita.2', soccer_germany_bundesliga2: 'ger.2',
  soccer_france_ligue_two: 'fra.2',
  soccer_conmebol_copa_libertadores: 'conmebol.libertadores',
  soccer_conmebol_copa_sudamericana: 'conmebol.sudamericana',
  soccer_uefa_champs_league: 'uefa.champions', soccer_uefa_europa_league: 'uefa.europa',
  soccer_uefa_europa_conference_league: 'uefa.europa.conf',
};
function espnIdFromUrl(u) {
  const m = (u || '').match(/teamlogos\/soccer\/500\/(\d+)\.png/);
  return m ? m[1] : null;
}
// Últimos 5 resultados del equipo (G/E/P) vía el calendario público de ESPN.
async function fetchTeamForm(espnId, slug) {
  try {
    const r = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/teams/${espnId}/schedule`,
      { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!r.ok) return null;
    const j = await r.json();
    const ev = Array.isArray(j.events) ? j.events : [];
    const done = ev.filter(e => {
      const c = e.competitions && e.competitions[0];
      return c && c.status && c.status.type && c.status.type.completed;
    }).sort((a, b) => new Date(a.date) - new Date(b.date));
    const form = [];
    let lastDate = '';
    for (const e of done) {
      const cs = e.competitions[0].competitors || [];
      const me = cs.find(x => String((x.team && x.team.id) || x.id) === String(espnId));
      const opp = cs.find(x => x !== me);
      if (!me || !opp) continue;
      const ms = parseInt((me.score && me.score.displayValue) || me.score, 10);
      const os = parseInt((opp.score && opp.score.displayValue) || opp.score, 10);
      if (Number.isNaN(ms) || Number.isNaN(os)) continue;
      form.push(ms > os ? 'G' : ms === os ? 'E' : 'P');
      const d = new Date(e.date);
      lastDate = String(d.getUTCDate()).padStart(2, '0') + '/' +
                 String(d.getUTCMonth() + 1).padStart(2, '0');
    }
    return form.length ? { list: form.slice(-5), lastDate } : null;
  } catch (e) { return null; }
}
// Forma de los dos equipos del pick — [formH, formA] (cada uno array o null).
async function teamFormPair(p, hUrl, aUrl) {
  const slug = ESPN_LEAGUE[p && p._sportKey];
  if (!slug) return [null, null];
  const hId = espnIdFromUrl(hUrl), aId = espnIdFromUrl(aUrl);
  return Promise.all([
    hId ? fetchTeamForm(hId, slug) : Promise.resolve(null),
    aId ? fetchTeamForm(aId, slug) : Promise.resolve(null),
  ]);
}
// Cuadrito de resultado — verde G, ámbar E, rojo P. El más reciente va destacado.
function formSquare(r, big) {
  const bg = r === 'G' ? '#00c853' : r === 'E' ? '#f5a623' : '#e5484d';
  const s = big ? 54 : 40;
  const st = { display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: s + 'px', height: s + 'px', borderRadius: big ? 12 : 8,
    marginTop: 4, marginBottom: 4, background: bg, color: '#ffffff',
    fontSize: big ? 31 : 23, fontWeight: 800 };
  if (big) st.border = '3px solid #ffffff';
  return el('div', st, r);
}
// Tira de forma vertical: fecha arriba, cuadrito más reciente destacado (grande, con borde).
function formColumn(form) {
  const sq = form.list.slice().reverse();   // más reciente arriba
  const children = [];
  if (form.lastDate) children.push(el('div', { display: 'flex', fontSize: 20,
    fontWeight: 800, color: '#dfeee5', marginBottom: 8,
    textShadow: '0 2px 8px rgba(0,0,0,0.95)' }, form.lastDate));
  sq.forEach((r, i) => children.push(formSquare(r, i === 0)));
  return el('div', { display: 'flex', flexDirection: 'column', alignItems: 'center' },
    children);
}

// ───────────────────────── Placa de imagen ─────────────────────────
function el(type, style, children) {
  return { type, props: { style, children } };
}

// Fuente de marca (Montserrat) — servida desde gambeta.ai, cacheada por instancia.
let _fonts = null;
async function loadFonts() {
  if (_fonts) return _fonts;
  try {
    const [r8, r9] = await Promise.all([
      fetch('https://gambeta.ai/font-800.woff', { cf: { cacheTtl: 86400, cacheEverything: true } }),
      fetch('https://gambeta.ai/font-900.woff', { cf: { cacheTtl: 86400, cacheEverything: true } }),
    ]);
    if (!r8.ok || !r9.ok) return null;
    const [d8, d9] = await Promise.all([r8.arrayBuffer(), r9.arrayBuffer()]);
    // Satori no matchea bien por weight → familias por nombre:
    // 'Gambeta' = negrita por defecto (Montserrat 800), 'GambetaBlack' = negrita máxima (900).
    _fonts = [
      { name: 'Gambeta', data: d8, weight: 400, style: 'normal' },
      { name: 'GambetaBlack', data: d9, weight: 400, style: 'normal' },
    ];
    return _fonts;
  } catch (e) { return null; }
}
// Render del árbol Satori a PNG, con la fuente de marca si está disponible.
async function pngFromElement(element) {
  const opts = { width: 1200, height: 720, format: 'png' };
  const fonts = await loadFonts();
  if (fonts) opts.fonts = fonts;
  const resp = new ImageResponse(element, opts);
  return new Uint8Array(await resp.arrayBuffer());
}

// Placa de PICKS — lista de pronósticos del día con escudos sobre el estadio.
// Una fila por pick: escudos, partido y la recomendación de la IA en píldora.
function pickRowEl(r) {
  const GREEN = '#00c853';
  return el('div', { display: 'flex', flexDirection: 'row', alignItems: 'center',
    background: 'rgba(6,14,10,0.60)', borderRadius: 14, padding: '0 22px',
    height: '88px', marginBottom: 12, borderLeft: `8px solid ${GREEN}` }, [
    escudoEl(r.home, r.hU, 56),
    el('div', { display: 'flex', width: '12px' }, ''),
    escudoEl(r.away, r.aU, 56),
    el('div', { display: 'flex', flexGrow: 1, fontSize: 31, color: '#ffffff',
      fontWeight: 700, marginLeft: 22,
      textShadow: '0 2px 8px rgba(0,0,0,0.9)' }, `${r.home}  vs  ${r.away}`),
    el('div', { display: 'flex', alignItems: 'center',
      background: 'rgba(0,200,83,0.20)', border: `2px solid ${GREEN}`,
      borderRadius: '9999px', padding: '9px 26px', fontSize: 27,
      color: '#00e676', fontWeight: 800, marginLeft: 16 }, (r.rec || '').toUpperCase()),
  ]);
}
function buildPicksCardElement(rows, dateLabel) {
  const GREEN = '#00c853';
  const scene = stadiumScene(null);
  return el('div', { display: 'flex', position: 'relative',
    width: '1200px', height: '720px', background: '#06120a' }, [
    { type: 'img', props: { src: scene.url, width: 1200, height: 720,
      style: { position: 'absolute', top: 0, left: 0,
        width: '1200px', height: '720px', objectFit: 'cover' } } },
    el('div', { display: 'flex', position: 'absolute', top: 0, left: 0,
      width: '1200px', height: '720px',
      backgroundImage: 'linear-gradient(180deg,rgba(4,9,7,0.88) 0%,rgba(4,9,7,0.80) 100%)' }, ''),
    el('div', { display: 'flex', flexDirection: 'column', position: 'absolute',
      top: 0, left: 0, width: '1200px', height: '720px', padding: '40px 52px' }, [
      // cabecera — logo + título + cantidad de picks
      el('div', { display: 'flex', flexDirection: 'row', alignItems: 'center',
        marginBottom: 22 }, [
        { type: 'img', props: { src: LOGO_URL, width: 86, height: 86,
          style: { width: '86px', height: '86px', marginRight: 22 } } },
        el('div', { display: 'flex', flexDirection: 'column', flexGrow: 1 }, [
          el('div', { display: 'flex', fontSize: 46, color: '#ffffff', fontWeight: 800 },
            'Picks de la IA'),
          el('div', { display: 'flex', fontSize: 24, color: '#9fc7ad', marginTop: 2 },
            'Pronósticos para hoy · ' + dateLabel),
        ]),
        el('div', { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }, [
          el('div', { display: 'flex', fontSize: 82, color: GREEN, fontWeight: 800 },
            String(rows.length)),
          el('div', { display: 'flex', fontSize: 22, color: '#9fc7ad' }, 'picks'),
        ]),
      ]),
      // filas de picks
      el('div', { display: 'flex', flexDirection: 'column' }, rows.map(pickRowEl)),
    ]),
  ]);
}

async function renderPicksCardPng(rows, dateLabel) {
  return pngFromElement(buildPicksCardElement(rows, dateLabel));
}

// Placa de RESULTADOS — lista con escudos sobre fondo de estadio.
// Una fila por partido: escudos, partido, marcador y check/cruz.
function resultadoRowEl(r) {
  const GREEN = '#00c853', RED = '#ff5a5f';
  const win = r.result === 'win';
  const score = (r.finalScore || '').toString().replace(/[-–]/, ' - ').trim();
  return el('div', { display: 'flex', flexDirection: 'row', alignItems: 'center',
    background: 'rgba(6,14,10,0.60)', borderRadius: 14, padding: '0 24px',
    height: '86px', marginBottom: 12,
    borderLeft: `8px solid ${win ? GREEN : RED}` }, [
    escudoEl(r.home, r.hU, 54),
    el('div', { display: 'flex', width: '12px' }, ''),
    escudoEl(r.away, r.aU, 54),
    el('div', { display: 'flex', flexGrow: 1, fontSize: 31, color: '#ffffff',
      fontWeight: 700, marginLeft: 22,
      textShadow: '0 2px 8px rgba(0,0,0,0.9)' }, `${r.home}  vs  ${r.away}`),
    el('div', { display: 'flex', fontSize: 37, color: '#ffffff', fontWeight: 800,
      marginLeft: 16, marginRight: 22,
      textShadow: '0 2px 8px rgba(0,0,0,0.9)' }, score),
    { type: 'img', props: { src: win ? CHECK_URI : CROSS_URI, width: 62, height: 62,
      style: { width: '62px', height: '62px' } } },
  ]);
}
function buildResultadosCardElement(rows, wins, total, dateLabel) {
  const GREEN = '#00c853';
  const scene = stadiumScene(null);
  return el('div', { display: 'flex', position: 'relative',
    width: '1200px', height: '720px', background: '#06120a' }, [
    { type: 'img', props: { src: scene.url, width: 1200, height: 720,
      style: { position: 'absolute', top: 0, left: 0,
        width: '1200px', height: '720px', objectFit: 'cover' } } },
    el('div', { display: 'flex', position: 'absolute', top: 0, left: 0,
      width: '1200px', height: '720px',
      backgroundImage: 'linear-gradient(180deg,rgba(4,9,7,0.88) 0%,rgba(4,9,7,0.80) 100%)' }, ''),
    el('div', { display: 'flex', flexDirection: 'column', position: 'absolute',
      top: 0, left: 0, width: '1200px', height: '720px', padding: '40px 52px' }, [
      // cabecera — logo + título + el stat grande
      el('div', { display: 'flex', flexDirection: 'row', alignItems: 'center',
        marginBottom: 22 }, [
        { type: 'img', props: { src: LOGO_URL, width: 86, height: 86,
          style: { width: '86px', height: '86px', marginRight: 22 } } },
        el('div', { display: 'flex', flexDirection: 'column', flexGrow: 1 }, [
          el('div', { display: 'flex', fontSize: 46, color: '#ffffff', fontWeight: 800 },
            'Resultados de la IA'),
          el('div', { display: 'flex', fontSize: 24, color: '#9fc7ad', marginTop: 2 },
            dateLabel),
        ]),
        el('div', { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }, [
          el('div', { display: 'flex', fontSize: 82, color: GREEN, fontWeight: 800 },
            `${wins}/${total}`),
          el('div', { display: 'flex', fontSize: 22, color: '#9fc7ad' }, 'aciertos'),
        ]),
      ]),
      // filas de partidos
      el('div', { display: 'flex', flexDirection: 'column' }, rows.map(resultadoRowEl)),
      // pie
      el('div', { display: 'flex', fontSize: 21, color: '#8fc0a0', marginTop: 'auto' },
        'Historial completo y público — aciertos y fallos, sin maquillar nada'),
    ]),
  ]);
}

async function renderResultadosCardPng(rows, wins, total, dateLabel) {
  return pngFromElement(buildResultadosCardElement(rows, wins, total, dateLabel));
}

// Placa GENERICA branded — para educacion, hot take, comunidad y festejo.
function stripEmoji(t) {
  return (t || '').replace(
    /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu, '');
}
function cardBody(text) {
  let t = stripEmoji(text).replace(/\s*\n\s*/g, '  ').replace(/\s{2,}/g, ' ').trim();
  if (t.length > 240) t = t.slice(0, 237).trim() + '\u2026';
  return t;
}
// Titular para la placa: solo el gancho (primer parrafo), sin emojis.
function cardHeadline(text) {
  let t = stripEmoji((text || '').split('\n\n')[0])
    .replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (t.length > 140) t = t.slice(0, 137).trim() + '\u2026';
  return t;
}
function buildGenericCardElement(kicker, headline) {
  const GREEN = '#00c853', DARK = '#0c1a12';
  return el('div', {
    display: 'flex', flexDirection: 'row', width: '1200px', height: '720px',
    background: DARK,
  }, [
    el('div', { display: 'flex', width: '16px', height: '720px', background: GREEN }, ''),
    el('div', {
      display: 'flex', flexDirection: 'column', flexGrow: 1,
      padding: '58px 64px', justifyContent: 'space-between',
    }, [
      el('div', { display: 'flex', flexDirection: 'column' }, [
        el('div', { display: 'flex', fontSize: 26, color: GREEN, fontWeight: 800,
          letterSpacing: 2 }, 'GAMBETA.AI'),
        el('div', { display: 'flex', alignSelf: 'flex-start',
          background: 'rgba(0,200,83,0.14)', border: `1px solid ${GREEN}`,
          borderRadius: 30, padding: '8px 22px', fontSize: 24, color: GREEN,
          fontWeight: 800, letterSpacing: 1, marginTop: 16 }, kicker),
      ]),
      el('div', { display: 'flex', fontSize: 52, color: '#ffffff', fontWeight: 800,
        lineHeight: 1.24 }, headline),
      el('div', { display: 'flex', fontSize: 22, color: '#7fae8f' },
        'Pron\u00f3sticos de f\u00fatbol con IA \u00b7 gratis todos los d\u00edas'),
    ]),
  ]);
}

// ───────── Fondo de estadio según la hora ART del partido ─────────
// 3 fotos HD (Unsplash, licencia libre): noche / día / luz dorada.
// El overlay se ajusta por franja horaria para dar sensación de "cantidad de sol".
const STADIUM_IMG = {
  night:  'https://images.unsplash.com/photo-1745997645080-941f962f1392?fm=jpg&q=70&w=1400&h=840&fit=crop',
  day:    'https://images.unsplash.com/photo-1620923090109-30f2e2b2e84c?fm=jpg&q=70&w=1400&h=840&fit=crop',
  golden: 'https://images.unsplash.com/photo-1748150572481-13ce492e1b2b?fm=jpg&q=70&w=1400&h=840&fit=crop',
};
// Logo de Gambeta — servido desde el propio dominio (estático, estable).
const LOGO_URL = 'https://gambeta.ai/logo-x.png';

function stadiumScene(ts) {
  const h = new Date((ts || Date.now()) + ART_OFFSET).getUTCHours();
  if (h >= 20 || h < 6)              // noche cerrada
    return { url: STADIUM_IMG.night,
      overlay: 'linear-gradient(180deg,rgba(4,9,15,0.80) 0%,rgba(4,9,15,0.50) 44%,rgba(3,7,12,0.88) 100%)' };
  if (h < 9 || h >= 17)              // amanecer / atardecer — luz dorada
    return { url: STADIUM_IMG.golden,
      overlay: 'linear-gradient(180deg,rgba(22,13,4,0.76) 0%,rgba(22,13,4,0.44) 46%,rgba(12,8,4,0.86) 100%)' };
  const midday = h >= 11 && h <= 15; // pleno día — mediodía más luminoso
  return { url: STADIUM_IMG.day,
    overlay: midday
      ? 'linear-gradient(180deg,rgba(6,14,10,0.66) 0%,rgba(6,14,10,0.30) 50%,rgba(6,14,10,0.82) 100%)'
      : 'linear-gradient(180deg,rgba(6,14,10,0.74) 0%,rgba(6,14,10,0.42) 46%,rgba(6,14,10,0.85) 100%)' };
}

// Check de acierto — SVG vectorial propio (nítido a cualquier tamaño),
// círculo verde con degradé, anillo blanco y sombra. Mejor que el emoji ✅.
const CHECK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">' +
  '<defs>' +
  '<linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#2bed74"/><stop offset="1" stop-color="#00a844"/>' +
  '</linearGradient>' +
  '<filter id="cs" x="-60%" y="-60%" width="220%" height="220%">' +
  '<feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000000" flood-opacity="0.62"/>' +
  '</filter>' +
  '</defs>' +
  '<circle cx="120" cy="120" r="103" fill="#ffffff" fill-opacity="0.16"/>' +
  '<circle cx="120" cy="120" r="85" fill="url(#cg)" stroke="#ffffff" stroke-width="8" filter="url(#cs)"/>' +
  '<path d="M76 124 l30 31 l60 -67" fill="none" stroke="#ffffff" ' +
  'stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';
const CHECK_URI = 'data:image/svg+xml;base64,' + btoa(CHECK_SVG);
// Cruz de fallo — mismo estilo que el check, en rojo.
const CROSS_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">' +
  '<defs>' +
  '<linearGradient id="xg" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#ff6b6f"/><stop offset="1" stop-color="#d32f2f"/>' +
  '</linearGradient>' +
  '<filter id="xs" x="-60%" y="-60%" width="220%" height="220%">' +
  '<feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000000" flood-opacity="0.62"/>' +
  '</filter>' +
  '</defs>' +
  '<circle cx="120" cy="120" r="103" fill="#ffffff" fill-opacity="0.16"/>' +
  '<circle cx="120" cy="120" r="85" fill="url(#xg)" stroke="#ffffff" stroke-width="8" filter="url(#xs)"/>' +
  '<path d="M86 86 L154 154 M154 86 L86 154" fill="none" stroke="#ffffff" ' +
  'stroke-width="20" stroke-linecap="round"/>' +
  '</svg>';
const CROSS_URI = 'data:image/svg+xml;base64,' + btoa(CROSS_SVG);

// Placa de partido con fondo de estadio — base de festejo y hot take.
function buildMatchCardElement(p, hUrl, aUrl, opts) {
  const GREEN = '#00c853';
  const scene = stadiumScene(p.commenceTs);
  const escSize = opts.escudo;
  const hasForm = f => !!(f && f.list && f.list.length);
  // escudo directo sobre la foto, con la tira de forma vertical al costado externo
  const teamBlock = (name, url, form, side) => {
    const esc = escudoEl(name, url, escSize);
    if (!hasForm(form)) return esc;
    const col = formColumn(form);
    const gap = el('div', { display: 'flex', width: '18px' }, '');
    return el('div', { display: 'flex', flexDirection: 'row', alignItems: 'center' },
      side === 'L' ? [col, gap, esc] : [esc, gap, col]);
  };
  return el('div', {
    display: 'flex', position: 'relative',
    width: '1200px', height: '720px', background: '#06120a',
  }, [
    // capa 1 — foto HD del estadio
    { type: 'img', props: { src: scene.url, width: 1200, height: 720,
      style: { position: 'absolute', top: 0, left: 0,
        width: '1200px', height: '720px', objectFit: 'cover' } } },
    // capa 2 — overlay oscuro para legibilidad del texto
    el('div', { display: 'flex', position: 'absolute', top: 0, left: 0,
      width: '1200px', height: '720px', backgroundImage: scene.overlay }, ''),
    // capa 3 — escudos + resultado: centrados en el MEDIO EXACTO de la placa
    // (el guión del marcador queda en el centro literal y todo nace hacia los lados)
    el('div', { display: 'flex', flexDirection: 'row', position: 'absolute',
      top: 0, left: 0, width: '1200px', height: '720px',
      alignItems: 'center', justifyContent: 'center' }, [
      teamBlock(p.home, hUrl, opts.formH, 'L'),
      el('div', { display: 'flex', fontSize: opts.centerSize, color: opts.centerColor,
        fontWeight: 800, padding: '0 40px',
        textShadow: '0 5px 20px rgba(0,0,0,0.95)' }, opts.center),
      teamBlock(p.away, aUrl, opts.formA, 'R'),
    ]),
    // capa 4 — logo + "Pick: ..." arriba a la izquierda
    el('div', { display: 'flex', flexDirection: 'row', position: 'absolute',
      top: 44, left: 56, alignItems: 'center', fontSize: 46, fontWeight: 800 }, [
      { type: 'img', props: { src: LOGO_URL, width: 84, height: 84,
        style: { width: '84px', height: '84px', marginRight: 20 } } },
      el('div', { display: 'flex', color: GREEN, marginRight: 16,
        fontFamily: 'GambetaBlack', fontWeight: 900,
        textShadow: '0 3px 14px rgba(0,0,0,0.95)' }, 'Pick'),
      el('div', { display: 'flex', color: '#ffffff',
        fontFamily: 'GambetaBlack', fontWeight: 900,
        textShadow: '0 3px 14px rgba(0,0,0,0.95)' }, (p.rec || '').toUpperCase()),
    ]),
    // capa 5 — check + "ACERTADO", abajo y centrado
    ...(opts.check ? [el('div', { display: 'flex', flexDirection: 'row',
      alignItems: 'center', position: 'absolute', bottom: 30, left: 0,
      width: '1200px', justifyContent: 'center' }, [
      { type: 'img', props: { src: CHECK_URI, width: 152, height: 152,
        style: { width: '152px', height: '152px' } } },
      el('div', { display: 'flex', marginLeft: 26, fontFamily: 'GambetaBlack',
        fontWeight: 900, fontSize: 80, color: '#00e676',
        textShadow: '0 4px 16px rgba(0,0,0,0.92)' }, 'ACERTADO'),
    ])] : []),
    // capa 6 — pastilla de confianza del pronóstico, abajo y centrada
    ...(opts.confLabel ? [el('div', { display: 'flex', position: 'absolute',
      bottom: 46, left: 0, width: '1200px', justifyContent: 'center' }, [
      el('div', { display: 'flex', background: '#00e676',
        borderRadius: '9999px', padding: '20px 56px',
        fontSize: 48, color: '#08130b', fontWeight: 800, letterSpacing: 1 },
        'CONFIANZA ' + opts.confLabel.toUpperCase())])] : []),
  ]);
}

// Placa de HOT TAKE — partido del día sobre el estadio, con "VS".
function buildHotTakeCardElement(p, hUrl, aUrl, formH, formA) {
  return buildMatchCardElement(p, hUrl, aUrl, {
    escudo: 270, center: 'VS', centerColor: 'rgba(255,255,255,0.96)', centerSize: 96,
    confLabel: confLabel(p), formH, formA,
  });
}
async function renderHotTakeCardPng(p, hUrl, aUrl, formH, formA) {
  return pngFromElement(buildHotTakeCardElement(p, hUrl, aUrl, formH, formA));
}
async function renderGenericCardPng(kicker, body) {
  return pngFromElement(buildGenericCardElement(kicker, body));
}

// Placa de FESTEJO — escudos enfrentados, marcador grande sobre el estadio.
// Sin forma de equipos: la forma va sólo en la previa del pick.
function buildCelebracionCardElement(p, hUrl, aUrl) {
  const score = (p.finalScore || '').toString().replace(/[-–]/, ' - ').trim() || 'WIN';
  return buildMatchCardElement(p, hUrl, aUrl, {
    escudo: 282, center: score, centerColor: '#00e676', centerSize: 124, check: true,
  });
}
async function renderCelebracionCardPng(p, hUrl, aUrl) {
  return pngFromElement(buildCelebracionCardElement(p, hUrl, aUrl));
}

// Genera la placa que corresponde al slot. Todos los slots llevan imagen.
async function renderCardForSlot(slot, hist, text, pickOverride) {
  if (slot === 'picks') {
    const picks = todayPendingPicks(hist);
    if (!picks.length) return null;
    const map = await fetchLogoMap();
    const rows = await Promise.all(picks.slice(0, 5).map(async (p) => ({
      home: p.home, away: p.away, rec: p.rec,
      hU: await resolveEscudo(p.home, map), aU: await resolveEscudo(p.away, map),
    })));
    return renderPicksCardPng(rows, dateLabelART());
  }
  if (slot === 'resultados') {
    const done = yesterdayResults(hist);
    if (!done.length) return null;
    const wins = done.filter(h => h.result === 'win').length;
    const map = await fetchLogoMap();
    const rows = await Promise.all(done.slice(0, 5).map(async (r) => ({
      home: r.home, away: r.away, finalScore: r.finalScore, result: r.result,
      hU: await resolveEscudo(r.home, map), aU: await resolveEscudo(r.away, map),
    })));
    return renderResultadosCardPng(rows, wins, done.length, dateLabelART());
  }
  if (slot === 'celebracion') {
    const p = pickOverride || ((celebracionWin(hist) || {}).pick);
    if (!p) return null;
    const map = await fetchLogoMap();
    const [hU, aU] = await Promise.all([
      resolveEscudo(p.home, map), resolveEscudo(p.away, map)]);
    return renderCelebracionCardPng(p, hU, aU);
  }
  if (slot === 'hottake') {
    const p = pickOverride || todayPendingPicks(hist)[0];
    if (!p) return null;
    const map = await fetchLogoMap();
    const [hU, aU] = await Promise.all([
      resolveEscudo(p.home, map), resolveEscudo(p.away, map)]);
    const [fH, fA] = await teamFormPair(p, hU, aU);
    return renderHotTakeCardPng(p, hU, aU, fH, fA);
  }
  // educacion / comunidad: sin placa — el tweet ya es texto, una placa de texto no aporta.
  return null;
}

// ───────────────────────── Datos reales ─────────────────────────
async function fetchHistorial() {
  const r = await fetch(HIST_URL, { cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error('historial HTTP ' + r.status);
  const d = await r.json();
  const hist = (Array.isArray(d) && d[0] && d[0].historial_full) ? d[0].historial_full : [];
  return Array.isArray(hist) ? hist : [];
}

function artDate(ts) { return new Date(ts + ART_OFFSET).toISOString().slice(0, 10); }
function todayART() { return new Date(Date.now() + ART_OFFSET).toISOString().slice(0, 10); }
function dayOfYearART() {
  const d = new Date(Date.now() + ART_OFFSET);
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
}
function dateLabelART() {
  const M = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  const d = new Date(Date.now() + ART_OFFSET);
  return `${d.getUTCDate()} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function cleanLeague(l) {
  return (l || '').replace(/[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}☀-➿]/gu, '').trim();
}

// ───────────────────────── Generadores por pilar ─────────────────────────
function todayPendingPicks(hist) {
  const today = todayART();
  return hist
    .filter(h => h.result === 'pending' && h.commenceTs && artDate(h.commenceTs) === today)
    .sort((a, b) => (b.bvr || 0) - (a.bvr || 0));
}

// Busca un pick por nombre de equipo (para /run y /card con &match=).
// Primero entre los de hoy; si no, entre TODOS los pendientes (la fecha de
// algunos picks viene mal seteada y quedarían fuera de "hoy").
function findPickByMatch(hist, matchStr) {
  const m = String(matchStr || '').toLowerCase().trim();
  if (!m) return null;
  const hit = arr => arr.find(p =>
    ((p.home || '') + ' ' + (p.away || '')).toLowerCase().includes(m));
  return hit(todayPendingPicks(hist))
      || hit(hist.filter(h => h.result === 'pending')) || null;
}

// Busca un acierto (pick ganado) por nombre de equipo — para festejar un pick puntual.
function findWinByMatch(hist, matchStr) {
  const m = String(matchStr || '').toLowerCase().trim();
  if (!m) return null;
  return hist
    .filter(h => h.result === 'win' && h.commenceTs &&
      ((h.home || '') + ' ' + (h.away || '')).toLowerCase().includes(m))
    .sort((a, b) => (b.commenceTs || 0) - (a.commenceTs || 0))[0] || null;
}

// Pilar 1 — Picks del día (texto)
function genPicks(hist) {
  const picks = todayPendingPicks(hist);
  if (!picks.length) return null;
  const head = '🎯 Los picks de la IA para hoy\n\n';
  const tail = '\n\nMás picks gratis en el perfil 👇  ¿Le entran? 🟢';
  const lines = [`⭐ ${picks[0].home} vs ${picks[0].away} → ${picks[0].rec}`];
  for (let i = 1; i < picks.length && i < 4; i++) {
    lines.push(`▪️ ${picks[i].home} vs ${picks[i].away} → ${picks[i].rec}`);
  }
  while (lines.length > 1 && (head + lines.join('\n') + tail).length > 258) lines.pop();
  return head + lines.join('\n') + tail;
}

// Resultados resueltos de ayer/hoy (compartido entre el texto y la placa)
function yesterdayResults(hist) {
  const today = todayART();
  const yest = new Date(Date.now() + ART_OFFSET - 86400000).toISOString().slice(0, 10);
  return hist
    .filter(h => (h.result === 'win' || h.result === 'loss')
      && h.commenceTs && (artDate(h.commenceTs) === yest || artDate(h.commenceTs) === today))
    .sort((a, b) => (b.commenceTs || 0) - (a.commenceTs || 0));
}

// Pilar 2 — Resultados
function genResultados(hist) {
  const done = yesterdayResults(hist);
  if (!done.length) return null;
  const wins = done.filter(h => h.result === 'win').length;
  const head = '📊 Cómo le fue a la IA\n\n';
  const tail = `\n\n${wins} de ${done.length}. Sin maquillar nada: el historial ` +
               'completo, aciertos y fallos, está público. 🟢';
  const lines = done.slice(0, 5).map(h =>
    `${h.result === 'win' ? '✅' : '❌'} ${h.home} vs ${h.away}` +
    (h.finalScore ? ` (${h.finalScore})` : ''));
  while (lines.length > 1 && (head + lines.join('\n') + tail).length > 258) lines.pop();
  return head + lines.join('\n') + tail;
}

const EDU_POOL = [
  '🧵 "Apostá al que va a ganar" es el peor consejo del mundo.\n\n' +
  'La cuota ya tiene metido quién es favorito. No buscás al que gana: ' +
  'buscás al que PAGA más de lo que debería.\n\nEso se llama valor. ' +
  'Es lo único que importa a largo plazo.',
  '📚 Regla que la IA nunca rompe: jamás arriesgar más del 2-5% del capital ' +
  'en un solo pick.\n\nEl que mete todo a "la fija" no está apostando, ' +
  'está jugando a la ruleta.\n\nA largo plazo gana la gestión, no la corazonada.',
  '🤖 ¿Cómo arma los picks la IA de Gambeta?\n\n' +
  '1. Levanta cuotas reales de decenas de casas\n' +
  '2. Cruza forma, historial, localía y bajas\n' +
  '3. Calcula la probabilidad real\n' +
  '4. Si la cuota paga más que esa probabilidad → es pick\n\n' +
  'Cero corazonadas. Solo números.',
  '🧠 3 señales de una cuenta de pronósticos que es humo:\n\n' +
  '1. No te muestra los fallos\n' +
  '2. Te promete "fijas" o "ganá seguro"\n' +
  '3. Te quiere meter en un grupo VIP pago\n\n' +
  'La IA de Gambeta no hace ninguna de las tres. Gratis y con historial público.',
  '💡 Apostar con cabeza es aburrido y funciona. Apostar con el corazón ' +
  'es divertido y funde.\n\nLa IA elige lo primero, siempre. ' +
  'Y solo se apuesta lo que uno se puede permitir perder.',


  '🎯 El % de aciertos no te dice si ganas plata.\n\n' +
  'Podes acertar 70% y perder. Podes acertar 40% y ganar. Lo que decide ' +
  'es si la CUOTA paga mas que tu probabilidad real.\n\n' +
  'Acertar es facil. Acertar donde el mercado se equivoca es lo que importa.',

  '📉 Apostar despues de perder con stake mas alto = martingala.\n\n' +
  'Es la forma matematicamente mas rapida de quebrar.\n\n' +
  'La IA no levanta stake cuando viene golpeada. La regla es la regla, ' +
  'gane o pierda. Disciplina.',

  '🔥 No existen las rachas en las apuestas.\n\n' +
  'Sentirte "encendido" o "frio" es sesgo cognitivo, no estadistica. ' +
  'Cada apuesta es independiente.\n\n' +
  'La IA no se siente caliente ni fria. Eso es su ventaja.',

  '🎰 In-play es donde mas se pierde.\n\n' +
  'Las cuotas se mueven mas rapido de lo que cualquier humano (o IA pre-partido) ' +
  'puede procesar. Los casinos lo saben.\n\n' +
  'Pre-partido tenes tiempo, info y calma. Apostar en vivo es para casos puntuales, ' +
  'no rutina.',

  '⚖️ "Cuota baja = seguro". Mentira.\n\n' +
  'Una cuota 1.20 implica 83% de probabilidad. Si la real es 80%, perdes plata ' +
  'a largo plazo aunque "acierte casi siempre".\n\n' +
  'No hay favoritos seguros, solo cuotas mal calibradas.',

  '🧮 Las combinadas multiplican el margen del casino.\n\n' +
  'Cada pata tiene su vig (5-8%). En una combinada de 4 patas, el casino se ' +
  'queda con ~25% del valor antes de empezar.\n\n' +
  'Por eso la IA no recomienda combinadas. Picks simples, con valor real.',

  '📊 CLV (Closing Line Value) es lo que separa apostadores serios de los demas.\n\n' +
  'Si tu cuota cuando apostaste era mejor que la cuota de cierre del partido, ' +
  'tenias ventaja. CLV positivo predice ROI positivo mejor que el % de aciertos.',

  '👀 3 sesgos que arruinan apostadores buenos:\n\n' +
  '1. Recency bias (los ultimos 3 partidos pesan demasiado)\n' +
  '2. Sunk cost (recuperar la racha mala doblando stake)\n' +
  '3. Confirmation bias (buscar datos que respalden lo que ya decidiste)\n\n' +
  'La IA no tiene ninguno.',

  '🎓 Especializarse > diversificar (apostando).\n\n' +
  'Un apostador que conoce profundamente UNA liga gana mas que el que mira 20. ' +
  'Mas info por partido, menos ruido.\n\n' +
  'Si recien empezas: elegi un torneo, dominalo, despues expandi.',

  '🧠 Probabilidad real vs probabilidad implicita en la cuota.\n\n' +
  'Cuota 2.50 = implicita 40%. Si vos pensas que la real es 50%, hay valor. ' +
  'Si pensas 35%, no apuestes.\n\n' +
  'Es la matematica mas importante. La IA la corre en cada pick automatico.',

  '🚪 Los picks que NO apostas pesan mas que los que apostas.\n\n' +
  'Pasar partidos donde no hay valor es lo que define la disciplina. ' +
  'El instinto pide accion; el bankroll pide paciencia.\n\n' +
  'La IA pasa el 80% de los partidos. Apuesta solo donde encontro valor.',

  '🃏 "Esta vez es distinto" — la frase mas cara del apostador.\n\n' +
  'El partido nunca es distinto. Las cuotas son distintas, vos sos el mismo. ' +
  'La unica pregunta valida: ¿hay valor o no?\n\n' +
  'Lo demas es ruido mental.',

  '🎲 Apostar con dinero que necesitas para vivir = no estas apostando, estas en problemas.\n\n' +
  'El bankroll tiene que ser plata que podes perder al 100% sin que te afecte. ' +
  'Cualquier otro enfoque es jugar con fuego.',

  '🔬 Por que la IA no se enamora de equipos.\n\n' +
  'No tiene un equipo del corazon. No le duele perder con un equipo. No se le ' +
  'gana facil cuando juega "el clasico". Solo procesa numeros.\n\n' +
  'Esa frialdad es ventaja, no defecto.',

  '💧 Apostar es 80% gestion y 20% pick.\n\n' +
  'El error mas comun: obsesionarse con elegir bien y descuidar cuanto se apuesta. ' +
  'Stake mal dimensionado destruye buenos picks.\n\n' +
  'Antes del pick: definir stake. Despues: respetar el stake.',

  '🎯 Mercado con menos margen del casino: 1X2 en ligas grandes.\n\n' +
  'Vig tipico: 4-6%. Lo que te paga es muy cerca de la probabilidad real.\n\n' +
  'Mercado con mas margen: player props, exoticas, en vivo. Vig 8-12%. Eviltalos ' +
  'si recien empezas.',

  '⏱️ La cuota se mueve cada minuto.\n\n' +
  'La cuota que ves a las 10 AM no es la que vas a apostar a las 3 PM. ' +
  'El movimiento (line movement) tiene informacion: te dice lo que el mercado ' +
  'esta aprendiendo.\n\n' +
  'La IA monitorea esos movimientos en tiempo real.',

  '🤐 Por que el historial publico importa.\n\n' +
  'Cualquier tipster puede inventar aciertos cuando borra los fallos. La unica ' +
  'forma honesta de evaluar a alguien es ver TODO su track record.\n\n' +
  'La IA de gambeta tiene cada pick guardado, incluidos los que pierden. ' +
  'Asi se construye confianza.',
];

const COM_POOL = [
  '⚽ ¿A qué partido le tenés más fe hoy?\n\n' +
  'Tirámelo abajo y te paso lo que dice la IA. 👇',
  '¿Cómo apostás vos?\n\n' +
  '— Siempre al favorito\n— Busco valor en las cuotas\n— Puro corazón ❤️\n— Solo miro\n\n' +
  'Sin juzgar a nadie 😅 — pero la IA tiene una favorita.',
  'Decime un equipo 👇 y te digo qué piensa la IA de su próximo partido.\n\n' +
  'Respondo a todos.',
  '🤖 ¿Soy un bot? Sí. Pero configurado por un experto en apuestas de ' +
  'carne y hueso.\n\nYo proceso los números a una velocidad que ningún ' +
  'humano puede. Él me enseñó qué mirar. Buen equipo. ⚽',
  '¿Qué te gustaría que la IA analice esta semana?\n\n' +
  'Tirá liga, equipo o partido abajo 👇 y lo metemos en el radar.',


  '🎉 ¿Cual es la mayor ganada que recordas?\n\nDecimela abajo 👇 — bonus si ' +
  'pones la cuota.',

  '🤔 ¿Equipo del que dejaste de apostar y por que?\n\nTodos tenemos uno. ' +
  'Hablen 👇',

  '📊 ¿Que mercado te funciona mejor?\n\n— 1X2\n— BTTS\n— Over/Under\n— Otro\n\n' +
  'Curiosidad genuina, no hay respuesta correcta.',

  '🎢 ¿Como manejas una racha mala?\n\n— Bajo stake\n— Pauso 1 semana\n— Sigo igual\n— Triplico (no hagan esto)\n\nHonestamente 👇',

  '🏆 Tu mejor consejo para alguien que recien arranca a apostar:\n\n' +
  'En una linea 👇. Los junto y los pongo en un post.',

  '⚽ ¿Liga que mas te gusta apostar? (no la mas mirada, la que mas te FUNCIONA)\n\n' +
  'Contala abajo 👇',

  '📱 ¿Que herramientas de stats usas?\n\nUna o dos, sin marca personal. ' +
  'Armamos un mapa entre todos 👇',

  '🧘 ¿Cuanto del bankroll arriesgas por pick? Honestamente.\n\n' +
  '— Menos de 1%\n— 1-3%\n— 3-5%\n— Mas de 5%\n— No lo se 😅',

  '💸 Cuota mas alta que te entro:\n\nDecila abajo + el partido si lo recordas 👇',

  '🚪 Pick que dejaste pasar y despues entro perfecto.\n\nA todos nos paso. ' +
  'Contala 👇',

  '🤖 Pregunta seria: ¿confias en una IA para apostar?\n\n— Si, ya uso\n— Tal vez\n— No, prefiero tipster humano\n— Solo confio en mi mismo\n\nSin juicios.',

  '⏱️ ¿En que momento del dia apostas?\n\n— Maniana (planificado)\n— Tarde (despues de leer)\n— Minuto antes del partido\n— En vivo\n\nCurioso.',

  '🎲 Apuesta mas rara que hiciste y entro:\n\nLa mia: un corner exacto. Y vos 👇',

  '👀 ¿Que liga subestimaste y termino dandote ganancia?\n\nLa mia: Liga Polaca. ' +
  'Cuotas mal calibradas por meses. Vos?',

  '🧠 ¿Como elegis a quien seguir? (tipsters / herramientas / IAs)\n\n' +
  '— Historial publico\n— Seguidores\n— Que te recomendaron\n— Otro\n\nMe interesa.',

  '💬 ¿Te pasa que despues de leer un analisis igual apostas otra cosa?\n\n' +
  'Es muy comun. La pregunta es: ¿por que? Cuentenmelo 👇',

  '🏟️ ¿Mejor recuerdo de un partido apostando?\n\nUno corto, contame 👇',
];

async function genEducacion(env) {
  const t = await pickFreshFromPool(EDU_POOL, env);
  if (!t) console.log('[x-bot] EDU pool exhausted — slot skipped');
  return t;
}
async function genComunidad(env) {
  const t = await pickFreshFromPool(COM_POOL, env);
  if (!t) console.log('[x-bot] COM pool exhausted — slot skipped');
  return t;
}

// Festejo de aciertos — se dispara apenas un pick gana.
const CELEBRA = [
  (p) => `💥 BOOOM. La IA LA CLAVÓ.\n\n${p.home} ${p.finalScore || ''} ${p.away} ✅\n` +
         `El pick: ${p.rec}\n\nPicks gratis todos los días en el perfil 🟢`,
  (p) => `🚨 ¡ACERTADO!\n\nLa IA dijo "${p.rec}" en ${p.home} vs ${p.away}.\n` +
         `Final: ${p.finalScore || '—'}. ADENTRO ✅\n\n¿La tenías? 🟢`,
  (p) => `✅ OTRA QUE ENTRA\n\n${p.home} ${p.finalScore || ''} ${p.away}\n` +
         `La IA lo dio: ${p.rec} 🎯\n\nDatos, no corazonadas. 🟢`,
  (p) => `🔥 LA IA NO FALLA TANTO...\n\n${p.home} ${p.finalScore || ''} ${p.away} — ` +
         `pick ACERTADO: ${p.rec} ✅\n\nMás picks gratis en el perfil 🟢`,
];
// Selecciona el acierto a festejar.
// HORARIO DE SILENCIO: entre las 0 y las 9 ART el bot NO postea nada.
// Los aciertos de la madrugada se acumulan y salen en la corrida de las 9 AM.
// La corrida normal (10-23) festeja partidos que arrancaron hace 3-4 h.
function celebracionWin(hist) {
  const h = new Date(Date.now() + ART_OFFSET).getUTCHours();
  if (h < 9) return null;                       // madrugada → silencio
  const now = Date.now();
  const hi = now - 2.5 * 3600 * 1000;
  const lo = (h === 9) ? now - 12.5 * 3600 * 1000 // 9 AM: barre toda la noche
                       : now - 3.5 * 3600 * 1000; // resto del dia: ventana 2.5-3.5 h
  const wins = hist
    .filter(w => w.result === 'win' && w.commenceTs
      && w.commenceTs >= lo && w.commenceTs < hi)
    .sort((a, b) => (b.bvr || 0) - (a.bvr || 0));
  return wins.length ? { pick: wins[0], total: wins.length } : null;
}

async function genCelebracion(hist, pickOverride, env) {
  let p, total;
  if (pickOverride) { p = pickOverride; total = 1; }
  else {
    const w = celebracionWin(hist);
    if (!w) return null;
    p = w.pick; total = w.total;
  }
  // Recorre CELEBRA buscando una variante cuyo render no este ya posteado.
  const start = dayOfYearART() % CELEBRA.length;
  for (let i = 0; i < CELEBRA.length; i++) {
    const idx = (start + i) % CELEBRA.length;
    let t = CELEBRA[idx](p).replace(/  +/g, ' ');
    if (total > 1) {
      const extra = `\n\n+${total - 1} acierto${total > 2 ? 's' : ''} más en esta tanda`;
      if ((t + extra).length <= 280) t += extra;
    }
    if (!(await wasPosted(t, env))) return t;
  }
  console.log('[x-bot] CELEBRA exhausted para', p?.home, 'vs', p?.away);
  return null;
}

// ───────── Stats de rendimiento para la previa ─────────
// Calcula el rendimiento real desde el historial.
function fmtRate(picks) {
  const v = picks.filter(p => p.result === 'win').length;
  const d = picks.filter(p => p.result === 'loss').length;
  const n = v + d;
  if (!n) return null;
  const pct = Math.round(v / n * 100);
  return { n, v, d, pct, txt: pct + '% (' + v + 'V-' + d + 'D)' };
}
// Clasifica el mercado del pick a partir del texto de la recomendación.
function classifyMarket(rec) {
  const r = (rec || '').toLowerCase();
  let m = r.match(/m[áa]s de\s+([\d.]+)/);
  if (m) return { key: 'o' + m[1], label: 'Más de ' + m[1] };
  m = r.match(/menos de\s+([\d.]+)/);
  if (m) return { key: 'u' + m[1], label: 'Menos de ' + m[1] };
  if (/ambos marcan/.test(r)) return { key: 'btts', label: 'Ambos Marcan' };
  if (/^gana |^empate|doble oportunidad/.test(r)) return { key: '1x2', label: 'Ganador' };
  return { key: 'x', label: null };
}
// Nivel de confianza legible del pick.
function confLabel(p) {
  const t = ((p && p.bvrText) || '').trim();
  if (/^(Máxima|Alta|Media-Alta|Media|Baja)$/i.test(t)) return t;
  const c = ((p && p.conf) || '').toLowerCase();
  return c === 'high' ? 'Alta' : c === 'low' ? 'Baja' : 'Media';
}
// Nombre de liga + bandera del país (o 🏆 si es competición internacional).
function leagueLabel(raw) {
  const s = (raw || '').trim();
  const m = s.match(/^(\S+)\s+(.+)$/);
  let icon = '', name = s;
  if (m) { icon = m[1]; name = m[2]; }
  // bandera de país = pares de indicadores regionales (🇲🇽) o bandera negra con tags (🏴 ENG)
  const isCountryFlag = /[\u{1F1E6}-\u{1F1FF}]/u.test(icon) || /\u{1F3F4}/u.test(icon);
  if (/^sudamericana$/i.test(name)) name = 'Copa Sudamericana';
  else if (/^libertadores$/i.test(name)) name = 'Copa Libertadores';
  return name + ' ' + (isCountryFlag ? icon : '🏆');
}
function buildStatsBlock(hist, pick) {
  const resolved = hist.filter(h => (h.result === 'win' || h.result === 'loss') && h.commenceTs);
  if (resolved.length < 10) return '';
  // TODAS las stats son del MERCADO del pick — nada genérico.
  const mk = classifyMarket(pick && pick.rec);
  if (!mk.label) return '';
  const inMk = resolved.filter(h => classifyMarket(h.rec).key === mk.key);
  if (!inMk.length) return '';
  const now = Date.now();
  const yest = new Date(now + ART_OFFSET - 86400000).toISOString().slice(0, 10);
  // Ayer / Semana / Mes — rendimiento de la IA EN ESE MERCADO en cada ventana.
  const ayer = fmtRate(inMk.filter(h => artDate(h.commenceTs) === yest));
  const sem  = fmtRate(inMk.filter(h => h.commenceTs >= now - 7 * 86400000));
  const mes  = fmtRate(inMk.filter(h => h.commenceTs >= now - 30 * 86400000));
  const lines = [];
  if (ayer) lines.push('⏱️ Ayer— ' + ayer.txt);
  if (sem)  lines.push('📆 Semana— ' + sem.txt);
  if (mes)  lines.push('📅 Mes— ' + mes.txt);
  // Mercado: histórico total y histórico en esta misma liga.
  const mkR = fmtRate(inMk);
  const lgR = fmtRate(inMk.filter(h => cleanLeague(h.league) === cleanLeague(pick.league)));
  const mkLines = [];
  if (mkR) mkLines.push('🎯 Mercado ' + mk.label + ' en gral— ' + mkR.txt);
  if (lgR && lgR.n >= 3) mkLines.push('🏆 Mercado ' + mk.label + ' en esta liga— ' + lgR.txt);
  if (mkLines.length) { if (lines.length) lines.push(''); lines.push(...mkLines); }
  return lines.join('\n');
}

function genHotTake(hist, pickOverride) {
  const p = pickOverride || todayPendingPicks(hist)[0];
  if (!p) return null;
  const head = `🔥 En ${p.home} vs ${p.away} la IA dice que ${p.rec} — ` +
               `Confianza ${confLabel(p)} (${leagueLabel(p.league)})`;
  const stats = buildStatsBlock(hist, p);
  const full = stats ? head + '\n\n' + stats : head;
  return full.length <= 280 ? full : head;   // si no entra, solo el titular
}

// ───────────────────────── Router de slot → pilar ─────────────────────────
const SLOT_BY_CRON = {
  '17 * * * *':  'celebracion', // cada hora :17 — aciertos resueltos
  '23 12 * * *': 'resultados',  // 09:23 ART
  '7 15 * * *':  'picks',       // 12:07 ART
  '47 17 * * *': 'educacion',   // 14:47 ART
  '13 21 * * *': 'hottake',     // 18:13 ART
  '23 23 * * *': 'comunidad',   // 20:23 ART
};

async function generateText(slot, hist, pickOverride, env) {
  switch (slot) {
    case 'picks':      return genPicks(hist);
    case 'resultados': return genResultados(hist);
    case 'educacion':  return await genEducacion(env);
    case 'hottake':    return genHotTake(hist, pickOverride);
    case 'comunidad':  return await genComunidad(env);
    case 'celebracion':return await genCelebracion(hist, pickOverride, env);
    default:           return null;
  }
}

// Corre un slot: genera texto + la placa de imagen (+ respuesta de stats en festejo).
async function runSlot(slot, env, mode, matchStr) {
  const hist = await fetchHistorial();
  // matchStr (opcional, sólo hot take): elige un pick puntual por nombre de equipo
  let pickOverride = null;
  if (slot === 'hottake' && matchStr) {
    pickOverride = findPickByMatch(hist, matchStr);
    if (!pickOverride) {
      return { slot, status: 'skipped', reason: 'sin pick que coincida con "' + matchStr + '"' };
    }
  }
  if (slot === 'celebracion' && matchStr) {
    pickOverride = findWinByMatch(hist, matchStr);
    if (!pickOverride) {
      return { slot, status: 'skipped', reason: 'sin acierto que coincida con "' + matchStr + '"' };
    }
  }
  const text = await generateText(slot, hist, pickOverride, env);
  if (!text) return { slot, status: 'skipped', reason: 'sin datos reales' };

  // Placa de imagen — todos los slots la llevan.
  // Reseteamos el tracker de escudos faltantes antes de renderizar.
  _missingShields = [];
  let cardErr = null, pngBytes = null;
  try { pngBytes = await renderCardForSlot(slot, hist, text, pickOverride); }
  catch (e) { cardErr = e.message; }
  // Si la placa es de partido (hottake/celebracion) y falta CUALQUIER
  // escudo, descartamos la placa: queda muy mal con iniciales.
  // Para 'picks' y 'resultados' (listas) toleramos uno o dos faltantes,
  // pero si faltan 3+ tambien descartamos.
  const isMatchCard = slot === 'hottake' || slot === 'celebracion';
  const tooManyMissing = _missingShields.length > 0 && (isMatchCard || _missingShields.length >= 3);
  if (tooManyMissing) {
    cardErr = (cardErr ? cardErr + ' / ' : '') + 'placa descartada — sin escudo para: ' + _missingShields.join(', ');
    pngBytes = null;
  }
  const hasCard = !!pngBytes;

  if (mode !== 'live') {
    return { slot, status: 'dry-run', chars: text.length, text,
             card: hasCard ? 'generada (' + pngBytes.length + ' bytes)' : null,
             cardError: cardErr };
  }

  // Modo live: subir imagen (si hay) y postear
  let mediaId = null;
  if (hasCard) {
    try { mediaId = await uploadMediaToX(pngBytes, env); }
    catch (e) { cardErr = 'upload: ' + e.message; }  // degrada a texto
  }
  const id = await postTweet(text, env, { mediaId });
  // Dedup: marcar este texto como ya posteado para que nunca se repita.
  await markPosted(text, env);
  return { slot, status: 'posted', tweetId: id, chars: text.length,
           withImage: !!mediaId, cardError: cardErr, text };
}

// ───────────────────────── Handlers ─────────────────────────
export default {
  async scheduled(event, env, ctx) {
    const mode = (env.BOT_MODE || 'off').toLowerCase();
    if (mode === 'off') { console.log('[x-bot] BOT_MODE=off'); return; }
    const slot = SLOT_BY_CRON[event.cron];
    if (!slot) { console.log('[x-bot] cron no mapeado:', event.cron); return; }
    try {
      const res = await runSlot(slot, env, mode);
      console.log('[x-bot]', JSON.stringify(res));
    } catch (e) {
      console.error('[x-bot] ERROR', slot, e.message);
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const mode = (env.BOT_MODE || 'off').toLowerCase();
    const J = (o, s = 200) => new Response(JSON.stringify(o, null, 2),
      { status: s, headers: { 'Content-Type': 'application/json' } });

    if (url.pathname === '/' || url.pathname === '/status') {
      return J({
        bot: 'gambeta-x-bot', version: '1.35', mode,
        slots: SLOT_BY_CRON,
        keysConfigured: !!(env.X_API_KEY && env.X_API_SECRET &&
                           env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET),
      });
    }

    if (url.pathname === '/preview') {
      try {
        const hist = await fetchHistorial();
        const out = {};
        for (const slot of Object.values(SLOT_BY_CRON)) {
          const t = await generateText(slot, hist, null, env);
          out[slot] = t ? { chars: t.length, text: t } : { status: 'skipped' };
        }
        return J({ fecha: todayART(), preview: out });
      } catch (e) { return J({ error: e.message }, 500); }
    }

    // Vista previa de la placa de imagen — ?slot=picks (default) o ?slot=resultados
    if (url.pathname === '/card') {
      try {
        const slot = url.searchParams.get('slot') || 'picks';
        const matchStr = url.searchParams.get('match');
        const hist = await fetchHistorial();
        let pickOverride = null;
        if (slot === 'hottake' && matchStr) {
          pickOverride = findPickByMatch(hist, matchStr);
        } else if (slot === 'celebracion' && matchStr) {
          pickOverride = findWinByMatch(hist, matchStr);
        }
        const t = await generateText(slot, hist, pickOverride, env);
        let png = await renderCardForSlot(slot, hist, t, pickOverride);
        // Preview de la placa de festejo: si el horario/ventana no aplica,
        // usar el acierto más reciente para poder verla en cualquier momento.
        if (!png && slot === 'celebracion') {
          const lw = hist.filter(w => w.result === 'win' && w.commenceTs)
            .sort((a, b) => b.commenceTs - a.commenceTs)[0];
          if (lw) {
            const map = await fetchLogoMap();
            const [hU, aU] = await Promise.all([
              resolveEscudo(lw.home, map), resolveEscudo(lw.away, map)]);
            png = await renderCelebracionCardPng(lw, hU, aU);
          }
        }
        if (!png) return J({ error: 'sin datos para la placa de ' + slot }, 404);
        return new Response(png, { headers: { 'Content-Type': 'image/png' } });
      } catch (e) { return J({ error: 'card: ' + e.message }, 500); }
    }

    if (url.pathname === '/clear-dedup') {
      if (!env.TRIGGER_TOKEN || url.searchParams.get('token') !== env.TRIGGER_TOKEN) {
        return J({ error: 'token inválido' }, 403);
      }
      if (!env.CACHE_KV) return J({ error: 'KV no configurado' }, 500);
      const cleared = { count: 0, errors: [] };
      let cursor = undefined;
      try {
        do {
          const list = await env.CACHE_KV.list({ prefix: 'xpost:', cursor });
          for (const k of list.keys) {
            try { await env.CACHE_KV.delete(k.name); cleared.count++; }
            catch (e) { cleared.errors.push(k.name + ':' + e.message); }
          }
          cursor = list.list_complete ? null : list.cursor;
        } while (cursor);
        return J({ status: 'ok', cleared });
      } catch (e) { return J({ error: e.message }, 500); }
    }

    if (url.pathname === '/seed-dedup') {
      if (!env.TRIGGER_TOKEN || url.searchParams.get('token') !== env.TRIGGER_TOKEN) {
        return J({ error: 'token inválido' }, 403);
      }
      const marked = { edu: 0, com: 0, celebra: 0, errors: [] };
      try {
        const firstN = parseInt(url.searchParams.get('firstN') || '0', 10);
        const eduList = firstN > 0 ? EDU_POOL.slice(0, firstN) : EDU_POOL;
        const comList = firstN > 0 ? COM_POOL.slice(0, firstN) : COM_POOL;
        for (const t of eduList) { try { await markPosted(t, env); marked.edu++; } catch (e) { marked.errors.push('edu:' + e.message); } }
        for (const t of comList) { try { await markPosted(t, env); marked.com++; } catch (e) { marked.errors.push('com:' + e.message); } }
        const hist = await fetchHistorial();
        const lastWin = hist.filter(w => w.result === 'win' && w.commenceTs)
          .sort((a, b) => b.commenceTs - a.commenceTs)[0];
        if (lastWin) {
          for (const tplFn of CELEBRA) {
            const t = tplFn(lastWin).replace(/  +/g, ' ');
            try { await markPosted(t, env); marked.celebra++; } catch (e) { marked.errors.push('celebra:' + e.message); }
          }
        }
        return J({ status: 'ok', marked });
      } catch (e) { return J({ error: e.message }, 500); }
    }

    if (url.pathname === '/run') {
      if (!env.TRIGGER_TOKEN || url.searchParams.get('token') !== env.TRIGGER_TOKEN) {
        return J({ error: 'token inválido' }, 403);
      }
      const slot = url.searchParams.get('slot');
      if (!Object.values(SLOT_BY_CRON).includes(slot)) {
        return J({ error: 'slot inválido', validos: Object.values(SLOT_BY_CRON) }, 400);
      }
      const runMode = url.searchParams.get('force') === 'live' ? 'live'
                     : (mode === 'off' ? 'dry' : mode);
      const match = url.searchParams.get('match') || null;
      try {
        return J(await runSlot(slot, env, runMode, match));
      } catch (e) { return J({ error: e.message }, 500); }
    }

    return J({ error: 'ruta desconocida', rutas: ['/status', '/preview', '/card', '/run', '/seed-dedup', '/clear-dedup'] }, 404);
  },
};
