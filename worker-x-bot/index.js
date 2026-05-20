/**
 * gambeta-x-bot — Bot de publicación automática en X (@Gambeta_ai)
 * ------------------------------------------------------------------
 * Genera tweets desde los PICKS REALES de Gambeta (plantillas + datos,
 * cero texto inventado) y los publica en X vía API v2 con OAuth 1.0a.
 *
 * Estrategia: los 5 pilares del playbook de virality.
 * Modo de costo: NUNCA pone links en el cuerpo (post normal = ~$0.015;
 * post con link = ~$0.20). El link vive en la bio.
 *
 * Secrets (cargar en Cloudflare → Settings → Variables and Secrets):
 *   X_API_KEY         (Consumer Key / API Key)
 *   X_API_SECRET      (Consumer Secret / API Key Secret)
 *   X_ACCESS_TOKEN    (Access Token)
 *   X_ACCESS_SECRET   (Access Token Secret)
 *   TRIGGER_TOKEN     (token propio para disparar /run manualmente)
 * Variable de entorno:
 *   BOT_MODE = "off" | "dry" | "live"   (default "off")
 *     off  → no hace nada
 *     dry  → genera el tweet y lo devuelve/loguea, NO publica
 *     live → publica de verdad
 */

const HIST_URL = 'https://gambeta.ai/api/sb?type=historial';
const X_TWEETS_URL = 'https://api.x.com/2/tweets';
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

async function postTweet(text, env, replyToId) {
  const body = { text };
  if (replyToId) body.reply = { in_reply_to_tweet_id: replyToId };
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

// ───────────────────────── Datos reales ─────────────────────────
async function fetchHistorial() {
  const r = await fetch(HIST_URL, { cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error('historial HTTP ' + r.status);
  const d = await r.json();
  const hist = (Array.isArray(d) && d[0] && d[0].historial_full) ? d[0].historial_full : [];
  return Array.isArray(hist) ? hist : [];
}

function artDate(ts) {
  return new Date(ts + ART_OFFSET).toISOString().slice(0, 10);
}
function todayART() {
  return new Date(Date.now() + ART_OFFSET).toISOString().slice(0, 10);
}
function dayOfYearART() {
  const d = new Date(Date.now() + ART_OFFSET);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((d.getTime() - start) / 86400000);
}
// limpia el emoji-bandera de la liga ("🇳🇴 Eliteserien" → "Eliteserien")
function cleanLeague(l) {
  return (l || '').replace(/[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}☀-➿]/gu, '').trim();
}

// ───────────────────────── Generadores por pilar ─────────────────────────
// Pilar 1 — Picks del día
function genPicks(hist) {
  const today = todayART();
  const picks = hist
    .filter(h => h.result === 'pending' && h.commenceTs && artDate(h.commenceTs) === today)
    .sort((a, b) => (b.bvr || 0) - (a.bvr || 0));
  if (!picks.length) return null;
  const top = picks[0];
  const rest = picks.slice(1, 4);
  let t = '🎯 Los picks de la IA para hoy\n\n';
  t += `⭐ Destacado: ${top.home} vs ${top.away} → ${top.rec}\n`;
  rest.forEach(p => { t += `▪️ ${p.home} vs ${p.away} → ${p.rec}\n`; });
  t += '\nAnálisis completo y picks gratis en el perfil 👇\n\n¿Le entran? 🟢';
  return clamp(t);
}

// Pilar 2 — Resultados (transparencia)
function genResultados(hist) {
  const today = todayART();
  const yest = new Date(Date.now() + ART_OFFSET - 86400000).toISOString().slice(0, 10);
  const done = hist
    .filter(h => (h.result === 'win' || h.result === 'loss')
      && h.commenceTs && (artDate(h.commenceTs) === yest || artDate(h.commenceTs) === today))
    .sort((a, b) => (b.commenceTs || 0) - (a.commenceTs || 0));
  if (!done.length) return null;
  const wins = done.filter(h => h.result === 'win').length;
  const show = done.slice(0, 5);
  let t = '📊 Cómo le fue a la IA\n\n';
  show.forEach(h => {
    t += `${h.result === 'win' ? '✅' : '❌'} ${h.home} vs ${h.away}` +
         (h.finalScore ? ` (${h.finalScore})` : '') + '\n';
  });
  t += `\n${wins} de ${done.length}. Sin maquillar nada: el historial completo, ` +
       'aciertos y fallos, está público. 🟢';
  return clamp(t);
}

// Pilar 3 — Educación (pool rotativo, evergreen)
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

// Pilar 5 — Comunidad (pool rotativo)
const COM_POOL = [
  'Buen día 🟢⚽\n\n¿A qué partido le tenés más fe hoy?\n\n' +
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

function genEducacion() { return clamp(EDU_POOL[dayOfYearART() % EDU_POOL.length]); }
function genComunidad() { return clamp(COM_POOL[dayOfYearART() % COM_POOL.length]); }

// Pilar 4 — Hot take (del pick de mayor confianza del día)
function genHotTake(hist) {
  const today = todayART();
  const picks = hist
    .filter(h => h.result === 'pending' && h.commenceTs && artDate(h.commenceTs) === today)
    .sort((a, b) => (b.bvr || 0) - (a.bvr || 0));
  if (!picks.length) return null;
  const p = picks[0];
  const prob = Math.max(p.probH || 0, p.probA || 0, p.probD || 0);
  let t = `🔥 ${p.home} vs ${p.away}\n\n`;
  t += `La IA dice: ${p.rec}`;
  if (prob) t += ` — le da ${prob}% de probabilidad`;
  t += '.\n\n';
  if (p.league) t += `(${cleanLeague(p.league)})\n\n`;
  t += '¿Vos qué ves? Dejá tu pronóstico abajo 👇';
  return clamp(t);
}

function clamp(t) {
  // límite de X: 280 caracteres
  if (t.length <= 280) return t;
  return t.slice(0, 277).replace(/\s+\S*$/, '') + '…';
}

// ───────────────────────── Router de slot → pilar ─────────────────────────
// Cada cron dispara un pilar. event.cron identifica el slot.
const SLOT_BY_CRON = {
  '30 12 * * *': 'resultados',  // 09:30 ART
  '0 15 * * *':  'picks',       // 12:00 ART
  '30 17 * * *': 'educacion',   // 14:30 ART
  '0 21 * * *':  'hottake',     // 18:00 ART
  '0 23 * * *':  'comunidad',   // 20:00 ART
};

async function generateFor(slot, hist) {
  switch (slot) {
    case 'picks':      return genPicks(hist);
    case 'resultados': return genResultados(hist);
    case 'educacion':  return genEducacion();
    case 'hottake':    return genHotTake(hist);
    case 'comunidad':  return genComunidad();
    default:           return null;
  }
}

// ───────────────────────── Handlers ─────────────────────────
async function runSlot(slot, env, mode) {
  const hist = await fetchHistorial();
  const text = await generateFor(slot, hist);
  if (!text) {
    return { slot, status: 'skipped', reason: 'sin datos reales para este pilar' };
  }
  if (mode !== 'live') {
    return { slot, status: 'dry-run', chars: text.length, text };
  }
  const id = await postTweet(text, env);
  return { slot, status: 'posted', tweetId: id, chars: text.length, text };
}

export default {
  // ── Cron ──
  async scheduled(event, env, ctx) {
    const mode = (env.BOT_MODE || 'off').toLowerCase();
    if (mode === 'off') {
      console.log('[x-bot] BOT_MODE=off — sin acción');
      return;
    }
    const slot = SLOT_BY_CRON[event.cron];
    if (!slot) { console.log('[x-bot] cron no mapeado:', event.cron); return; }
    try {
      const res = await runSlot(slot, env, mode);
      console.log('[x-bot]', JSON.stringify(res));
    } catch (e) {
      console.error('[x-bot] ERROR', slot, e.message);
    }
  },

  // ── HTTP: status / preview / run manual ──
  async fetch(request, env) {
    const url = new URL(request.url);
    const mode = (env.BOT_MODE || 'off').toLowerCase();
    const J = (o, s = 200) => new Response(JSON.stringify(o, null, 2),
      { status: s, headers: { 'Content-Type': 'application/json' } });

    // Estado
    if (url.pathname === '/' || url.pathname === '/status') {
      return J({
        bot: 'gambeta-x-bot', mode,
        crons: Object.keys(SLOT_BY_CRON),
        slots: SLOT_BY_CRON,
        keysConfigured: !!(env.X_API_KEY && env.X_API_SECRET &&
                           env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET),
        nota: 'mode=off no hace nada · dry = genera sin publicar · live = publica',
      });
    }

    // Preview: genera los 5 tweets de hoy SIN publicar (para revisar)
    if (url.pathname === '/preview') {
      try {
        const hist = await fetchHistorial();
        const out = {};
        for (const slot of Object.values(SLOT_BY_CRON)) {
          const t = await generateFor(slot, hist);
          out[slot] = t ? { chars: t.length, text: t }
                        : { status: 'skipped (sin datos)' };
        }
        return J({ fecha: todayART(), preview: out });
      } catch (e) { return J({ error: e.message }, 500); }
    }

    // Run manual de un slot (protegido por token)
    if (url.pathname === '/run') {
      if (!env.TRIGGER_TOKEN || url.searchParams.get('token') !== env.TRIGGER_TOKEN) {
        return J({ error: 'token inválido' }, 403);
      }
      const slot = url.searchParams.get('slot');
      if (!Object.values(SLOT_BY_CRON).includes(slot)) {
        return J({ error: 'slot inválido', validos: Object.values(SLOT_BY_CRON) }, 400);
      }
      // forzar dry si BOT_MODE no es live, salvo override explícito ?force=live
      const runMode = url.searchParams.get('force') === 'live' ? 'live' : mode;
      try {
        const res = await runSlot(slot, env, runMode === 'off' ? 'dry' : runMode);
        return J(res);
      } catch (e) { return J({ error: e.message }, 500); }
    }

    return J({ error: 'ruta desconocida', rutas: ['/status', '/preview', '/run'] }, 404);
  },
};
