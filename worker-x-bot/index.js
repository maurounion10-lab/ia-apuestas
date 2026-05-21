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
    const r = await fetch('https://gambeta.ai/', { cf: { cacheTtl: 3600, cacheEverything: true } });
    const html = await r.text();
    const m = html.match(/const teamLogos = \{([\s\S]*?)\n\};/);
    if (m) {
      const re = /'([^']+)'\s*:\s*'(https?:\/\/[^']+)'/g;
      let mm;
      while ((mm = re.exec(m[1]))) { const k = normTeam(mm[1]); if (!map[k]) map[k] = mm[2]; }
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
function escudoEl(name, url, size) {
  if (url) return { type: 'img', props: { src: url, width: size, height: size,
    style: { width: size + 'px', height: size + 'px', objectFit: 'contain' } } };
  return initialsBadge(name, size);
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
    const [r4, r8, r9] = await Promise.all([
      fetch('https://gambeta.ai/font-400.woff', { cf: { cacheTtl: 86400, cacheEverything: true } }),
      fetch('https://gambeta.ai/font-800.woff', { cf: { cacheTtl: 86400, cacheEverything: true } }),
      fetch('https://gambeta.ai/font-900.woff', { cf: { cacheTtl: 86400, cacheEverything: true } }),
    ]);
    if (!r4.ok || !r8.ok || !r9.ok) return null;
    const [d4, d8, d9] = await Promise.all([r4.arrayBuffer(), r8.arrayBuffer(), r9.arrayBuffer()]);
    _fonts = [
      { name: 'Gambeta', data: d4, weight: 400, style: 'normal' },
      { name: 'Gambeta', data: d8, weight: 800, style: 'normal' },
      { name: 'Gambeta', data: d9, weight: 900, style: 'normal' },
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
      // pie
      el('div', { display: 'flex', fontSize: 21, color: '#8fc0a0', marginTop: 'auto' },
        'Pronósticos de fútbol con IA · gratis todos los días en el perfil'),
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
  // escudos sin disco de fondo — directo sobre la foto del estadio
  const shield = (name, url) => escudoEl(name, url, escSize);
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
      shield(p.home, hUrl),
      el('div', { display: 'flex', fontSize: opts.centerSize, color: opts.centerColor,
        fontWeight: 800, padding: '0 40px',
        textShadow: '0 5px 20px rgba(0,0,0,0.95)' }, opts.center),
      shield(p.away, aUrl),
    ]),
    // capa 4 — logo + "Pick: ..." arriba a la izquierda
    el('div', { display: 'flex', flexDirection: 'row', position: 'absolute',
      top: 44, left: 56, alignItems: 'center', fontSize: 46, fontWeight: 800 }, [
      { type: 'img', props: { src: LOGO_URL, width: 84, height: 84,
        style: { width: '84px', height: '84px', marginRight: 20 } } },
      el('div', { display: 'flex', color: GREEN, marginRight: 16, fontWeight: 900,
        textShadow: '0 3px 14px rgba(0,0,0,0.95)' }, 'Pick'),
      el('div', { display: 'flex', color: '#ffffff', fontWeight: 900,
        textShadow: '0 3px 14px rgba(0,0,0,0.95)' }, (p.rec || '').toUpperCase()),
    ]),
    // capa 5 — check de acierto, abajo y centrado
    ...(opts.check ? [{ type: 'img', props: { src: CHECK_URI, width: 178, height: 178,
      style: { position: 'absolute', bottom: 24, left: 511,
        width: '178px', height: '178px' } } }] : []),
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
function buildHotTakeCardElement(p, hUrl, aUrl) {
  return buildMatchCardElement(p, hUrl, aUrl, {
    escudo: 290, center: 'VS', centerColor: 'rgba(255,255,255,0.96)', centerSize: 96,
    confLabel: confLabel(p),
  });
}
async function renderHotTakeCardPng(p, hUrl, aUrl) {
  return pngFromElement(buildHotTakeCardElement(p, hUrl, aUrl));
}
async function renderGenericCardPng(kicker, body) {
  return pngFromElement(buildGenericCardElement(kicker, body));
}

// Placa de FESTEJO — escudos enfrentados, marcador grande sobre el estadio.
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
async function renderCardForSlot(slot, hist, text) {
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
    const w = celebracionWin(hist);
    if (!w) return null;
    const map = await fetchLogoMap();
    const [hU, aU] = await Promise.all([
      resolveEscudo(w.pick.home, map), resolveEscudo(w.pick.away, map)]);
    return renderCelebracionCardPng(w.pick, hU, aU);
  }
  if (slot === 'hottake') {
    const picks = todayPendingPicks(hist);
    if (!picks.length) return null;
    const p = picks[0];
    const map = await fetchLogoMap();
    const [hU, aU] = await Promise.all([
      resolveEscudo(p.home, map), resolveEscudo(p.away, map)]);
    return renderHotTakeCardPng(p, hU, aU);
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
];

function genEducacion() { return EDU_POOL[dayOfYearART() % EDU_POOL.length]; }
function genComunidad() { return COM_POOL[dayOfYearART() % COM_POOL.length]; }

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

function genCelebracion(hist) {
  const w = celebracionWin(hist);
  if (!w) return null;
  const p = w.pick;
  let t = CELEBRA[dayOfYearART() % CELEBRA.length](p).replace(/  +/g, ' ');
  if (w.total > 1) {
    const extra = `\n\n+${w.total - 1} acierto${w.total > 2 ? 's' : ''} más en esta tanda`;
    if ((t + extra).length <= 280) t += extra;
  }
  return t;
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
  const now = Date.now();
  const yest = new Date(now + ART_OFFSET - 86400000).toISOString().slice(0, 10);
  const ayer = fmtRate(resolved.filter(h => artDate(h.commenceTs) === yest));
  const sem  = fmtRate(resolved.filter(h => h.commenceTs >= now - 7 * 86400000));
  const mes  = fmtRate(resolved.filter(h => h.commenceTs >= now - 30 * 86400000));
  const lines = [];
  if (ayer) lines.push('⏱️ Ayer— ' + ayer.txt);
  if (sem)  lines.push('📆 Semana— ' + sem.txt);
  if (mes)  lines.push('📅 Mes— ' + mes.txt);
  const mk = classifyMarket(pick && pick.rec);
  if (mk.label) {
    const inMk = resolved.filter(h => classifyMarket(h.rec).key === mk.key);
    const mkR = fmtRate(inMk);
    const lgR = fmtRate(inMk.filter(h => cleanLeague(h.league) === cleanLeague(pick.league)));
    const mkLines = [];
    if (mkR) mkLines.push('🎯 Mercado ' + mk.label + ' en gral— ' + mkR.txt);
    if (lgR && lgR.n >= 3) mkLines.push('🏆 Mercado ' + mk.label + ' en esta liga— ' + lgR.txt);
    if (mkLines.length) lines.push('', ...mkLines);
  }
  return lines.join('\n');
}

function genHotTake(hist) {
  const picks = todayPendingPicks(hist);
  if (!picks.length) return null;
  const p = picks[0];
  const head = `🔥 En ${p.home} vs ${p.away} la IA dice que ${p.rec} — ` +
               `Confianza ${confLabel(p)} (${leagueLabel(p.league)})`;
  const stats = buildStatsBlock(hist, p);
  const full = stats ? head + '\n\n' + stats : head;
  return full.length <= 280 ? full : head;   // si no entra, solo el titular
}

// ───────────────────────── Router de slot → pilar ─────────────────────────
const SLOT_BY_CRON = {
  '0 * * * *':   'celebracion', // cada hora: festeja aciertos recién resueltos
  '30 12 * * *': 'resultados',
  '0 15 * * *':  'picks',
  '30 17 * * *': 'educacion',
  '0 21 * * *':  'hottake',
  '0 23 * * *':  'comunidad',
};

function generateText(slot, hist) {
  switch (slot) {
    case 'picks':      return genPicks(hist);
    case 'resultados': return genResultados(hist);
    case 'educacion':  return genEducacion();
    case 'hottake':    return genHotTake(hist);
    case 'comunidad':  return genComunidad();
    case 'celebracion':return genCelebracion(hist);
    default:           return null;
  }
}

// Corre un slot: genera texto + la placa de imagen (+ respuesta de stats en festejo).
async function runSlot(slot, env, mode) {
  const hist = await fetchHistorial();
  const text = generateText(slot, hist);
  if (!text) return { slot, status: 'skipped', reason: 'sin datos reales' };

  // Placa de imagen — todos los slots la llevan
  let cardErr = null, pngBytes = null;
  try { pngBytes = await renderCardForSlot(slot, hist, text); }
  catch (e) { cardErr = e.message; }
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
        bot: 'gambeta-x-bot', version: '1.24', mode,
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
          const t = generateText(slot, hist);
          out[slot] = t ? { chars: t.length, text: t } : { status: 'skipped' };
        }
        return J({ fecha: todayART(), preview: out });
      } catch (e) { return J({ error: e.message }, 500); }
    }

    // Vista previa de la placa de imagen — ?slot=picks (default) o ?slot=resultados
    if (url.pathname === '/card') {
      try {
        const slot = url.searchParams.get('slot') || 'picks';
        const hist = await fetchHistorial();
        const t = generateText(slot, hist);
        let png = await renderCardForSlot(slot, hist, t);
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
      try {
        return J(await runSlot(slot, env, runMode));
      } catch (e) { return J({ error: e.message }, 500); }
    }

    return J({ error: 'ruta desconocida', rutas: ['/status', '/preview', '/card', '/run'] }, 404);
  },
};
