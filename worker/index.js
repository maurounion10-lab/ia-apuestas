/**
 * gambeta.ai — Cloudflare Worker: apuestas-api v2.4
 * Fuente primaria: API-Football (api-sports.io) — con The Odds API como fallback
 *
 * Endpoints:
 *   GET /available           → lista de sport_keys soportados
 *   GET /odds?category=main  → fixtures + cuotas (formato compatible con frontend)
 *   GET /odds?category=europe
 *   GET /stats?team=ID&league=ID → estadísticas de equipo (🧠 Algorithm)
 *   GET /h2h?h2h=ID1-ID2     → historial H2H (🧠 Algorithm)
 *   GET /predictions?fixture=ID → predicciones de API-Football
 *   POST /notify-redeem         → notifica canje G$ al admin (vía Resend)
 *
 * Variables de entorno requeridas:
 *   API_FOOTBALL_KEY  → api-football.com key
 *   ODDS_API_KEY      → the-odds-api.com key (fallback)
 *   RESEND_API_KEY    → resend.com key (notificaciones de canje)
 *
 * KV Namespace:
 *   CACHE_KV → gambeta-cache (ID: 1d4b161e78db4de9a9b806f369c73ceb)
 */

const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';

// Temporadas por liga: europeas usan 2025 (= 2025/26), latinoamericanas usan 2026 (año calendario)
const LATAM_SPORT_KEYS = new Set([
  'soccer_argentina_primera_division',
  'soccer_argentina_primera_nacional',
  'soccer_conmebol_copa_libertadores',
  'soccer_conmebol_copa_sudamericana',
  'soccer_brazil_campeonato',
  'soccer_brazil_serie_b',
  'soccer_mexico_ligamx',
  'soccer_chile_campeonato',
  'soccer_uruguay_primera_division',
  'soccer_colombia_primera_a',
  'soccer_usa_mls',
]);

function getSeason(sportKey) {
  return LATAM_SPORT_KEYS.has(sportKey) ? 2026 : 2025;
}

// ── Mapeo: sport_key → ID de liga en API-Football ────────────────────────────
const LEAGUE_MAP = {
  'soccer_argentina_primera_division':    128,
  'soccer_argentina_primera_nacional':    131,
  'soccer_conmebol_copa_libertadores':     13,
  'soccer_conmebol_copa_sudamericana':     11,
  'soccer_brazil_campeonato':              71,
  'soccer_mexico_ligamx':                262,
  'soccer_usa_mls':                      253,
  'soccer_chile_campeonato':             265,
  'soccer_uruguay_primera_division':     268,
  'soccer_colombia_primera_a':           239,
  'soccer_uefa_champs_league':             2,
  'soccer_epl':                           39,
  'soccer_spain_la_liga':               140,
  'soccer_germany_bundesliga':            78,
  'soccer_italy_serie_a':               135,
  'soccer_france_ligue_one':              61,
  'soccer_uefa_europa_league':             3,
  'soccer_uefa_europa_conference_league': 848,
  'soccer_netherlands_eredivisie':         88,
  'soccer_turkey_super_league':          203,
  'soccer_portugal_primeira_liga':        94,
  'soccer_spain_segunda_division':       141,
  'soccer_brazil_serie_b':                72,
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=300'
};

// ── KV Cache helper ──────────────────────────────────────────────────────────
async function cached(env, key, ttl, fn) {
  try {
    const hit = await env.CACHE_KV?.get(key);
    if (hit) return JSON.parse(hit);
  } catch {}
  const data = await fn();
  try {
    if (data !== null && data !== undefined) {
      await env.CACHE_KV?.put(key, JSON.stringify(data), { expirationTtl: ttl });
    }
  } catch {}
  return data;
}

// ── API-Football fetch helper ────────────────────────────────────────────────
async function apf(path, env) {
  const key = env.API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY not configured');
  const r = await fetch(`${API_FOOTBALL_BASE}${path}`, {
    headers: { 'x-apisports-key': key }
  });
  if (!r.ok) throw new Error(`APF ${r.status}: ${path}`);
  const json = await r.json();
  // Check for rate limit errors
  if (json.errors?.requests) throw new Error(`APF rate limit: ${json.errors.requests}`);
  return json;
}

// ── The Odds API fallback helper ─────────────────────────────────────────────
async function fetchOddsAPI(sportKey, env) {
  const key = env.ODDS_API_KEY;
  if (!key) return [];
  try {
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${key}&regions=eu,uk&markets=h2h,totals&oddsFormat=decimal&dateFormat=iso`;
    const r = await fetch(url);
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

// ── Transformar fixture API-Football → formato frontend ─────────────────────
function transformAPFGame(fixture, oddsBookmakers, sportKey) {
  const f  = fixture.fixture;
  const hm = fixture.teams?.home;
  const aw = fixture.teams?.away;

  const bookmakers = [];
  (oddsBookmakers || []).forEach(bm => {
    const h2hBet = bm.bets?.find(b => /match winner/i.test(b.name));
    if (!h2hBet) return;
    const hOut = h2hBet.values?.find(v => v.value === 'Home');
    const dOut = h2hBet.values?.find(v => v.value === 'Draw');
    const aOut = h2hBet.values?.find(v => v.value === 'Away');
    if (!hOut || !aOut) return;

    const markets = [{
      key: 'h2h',
      outcomes: [
        { name: hm.name, price: parseFloat(hOut.odd) },
        ...(dOut ? [{ name: 'Draw', price: parseFloat(dOut.odd) }] : []),
        { name: aw.name, price: parseFloat(aOut.odd) },
      ]
    }];

    const totalsBet = bm.bets?.find(b => /goals over.under/i.test(b.name));
    if (totalsBet) {
      const byLine = {};
      totalsBet.values?.forEach(v => {
        const m = v.value.match(/(Over|Under)\s+([\d.]+)/i);
        if (!m) return;
        if (!byLine[m[2]]) byLine[m[2]] = {};
        byLine[m[2]][m[1].toLowerCase()] = parseFloat(v.odd);
      });
      const tots = [];
      Object.entries(byLine).forEach(([line, vals]) => {
        if (vals.over)  tots.push({ name: 'Over',  point: parseFloat(line), price: vals.over });
        if (vals.under) tots.push({ name: 'Under', point: parseFloat(line), price: vals.under });
      });
      if (tots.length) markets.push({ key: 'totals', outcomes: tots });
    }

    const bttsBet = bm.bets?.find(b => /both teams.*score/i.test(b.name));
    if (bttsBet) {
      const bttsOutcomes = bttsBet.values?.map(v => ({ name: v.value === 'Yes' ? 'Yes' : 'No', price: parseFloat(v.odd) })) || [];
      if (bttsOutcomes.length) markets.push({ key: 'btts', outcomes: bttsOutcomes });
    }

    bookmakers.push({
      key:   bm.bookmaker?.name?.toLowerCase().replace(/\s+/g,'_') || 'unknown',
      title: bm.bookmaker?.name || 'Unknown',
      markets
    });
  });

  return {
    id:            String(f.id),
    sport_key:     sportKey,
    sport_title:   sportKey,
    commence_time: f.date,
    home_team:     hm.name,
    away_team:     aw.name,
    bookmakers,
    _apf_fixture_id: f.id,
    _apf_home_id:    hm.id,
    _apf_away_id:    aw.id,
    _apf_league_id:  fixture.league?.id,
    _apf_status:     f.status?.short,
  };
}

// ── Transformar juego de The Odds API → formato frontend ────────────────────
function transformOddsAPIGame(g) {
  return {
    id:            g.id,
    sport_key:     g.sport_key,
    sport_title:   g.sport_title || g.sport_key,
    commence_time: g.commence_time,
    home_team:     g.home_team,
    away_team:     g.away_team,
    bookmakers:    (g.bookmakers || []).map(bm => ({
      key:   bm.key,
      title: bm.title,
      markets: (bm.markets || []).map(m => ({
        key:      m.key,
        outcomes: (m.outcomes || []).map(o => ({
          name:  o.name,
          price: o.price,
          ...(o.point !== undefined ? { point: o.point } : {})
        }))
      }))
    }))
    // No _apf_ fields (brain algorithm uses graceful degradation)
  };
}

// ── Cargar fixtures + odds de API-Football para una lista de ligas ───────────
async function buildAPFData(env, leagueEntries) {
  const games = [];

  for (const [sportKey, leagueId] of leagueEntries) {
    const season = getSeason(sportKey);
    try {
      const [fixResp, oddsResp] = await Promise.all([
        apf(`/fixtures?league=${leagueId}&season=${season}&next=15`, env),
        apf(`/odds?league=${leagueId}&season=${season}&bookmaker=8&next=15`, env).catch(() => ({ response: [] }))
      ]);

      const fixtures = fixResp.response || [];
      if (!fixtures.length) continue;

      // También pedir Pinnacle como segunda bookmaker
      const pinnResp = await apf(`/odds?league=${leagueId}&season=${season}&bookmaker=3&next=15`, env).catch(() => ({ response: [] }));

      const oddsMap = {};
      const mergeOdds = (resp) => {
        (resp.response || []).forEach(o => {
          const fid = o.fixture?.id;
          if (!fid) return;
          if (!oddsMap[fid]) oddsMap[fid] = [];
          (o.bookmakers || []).forEach(bm => {
            if (!oddsMap[fid].find(b => b.bookmaker?.id === bm.bookmaker?.id)) {
              oddsMap[fid].push(bm);
            }
          });
        });
      };
      mergeOdds(oddsResp);
      mergeOdds(pinnResp);

      fixtures.forEach(fixture => {
        const bookmakers = oddsMap[fixture.fixture?.id] || [];
        const game = transformAPFGame(fixture, bookmakers, sportKey);
        games.push(game);
      });

    } catch (e) {
      console.error(`[Worker] APF Liga ${leagueId} (${sportKey}) error:`, e.message);
    }
  }
  return games;
}

// ── Cargar cuotas de The Odds API para una lista de sport_keys ───────────────
async function buildOddsAPIData(env, sportKeys) {
  const games = [];
  // Fetch en paralelo (máx 6 a la vez para no saturar)
  const batchSize = 6;
  for (let i = 0; i < sportKeys.length; i += batchSize) {
    const batch = sportKeys.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(sk => fetchOddsAPI(sk, env)));
    results.forEach(arr => {
      (arr || []).forEach(g => games.push(transformOddsAPIGame(g)));
    });
  }
  return games;
}

// ── Obtener datos con fallback APF → Odds API (por liga) ─────────────────────
async function getLeagueData(env, leagueEntries) {
  let apfData = [];
  let apfError = false;

  // Intentar API-Football primero
  try {
    apfData = await buildAPFData(env, leagueEntries);
    console.log(`[Worker] APF: ${apfData.length} juegos`);
  } catch (e) {
    console.warn('[Worker] APF error total, usando Odds API fallback completo:', e.message);
    apfError = true;
  }

  if (apfError) {
    // Error total → fallback completo a Odds API
    const sportKeys = leagueEntries.map(([sk]) => sk);
    const data = await buildOddsAPIData(env, sportKeys);
    console.log(`[Worker] OddsAPI fallback total: ${data.length} juegos`);
    return { data, source: 'odds-api' };
  }

  // Fallback por liga — dos casos:
  //   1. sport_key sin ningún juego de APF → suplementar desde Odds API
  //   2. sport_key con juegos APF pero SIN cuotas h2h → reemplazar con Odds API
  //      (APF devuelve fixtures antes de que los bookmakers publiquen odds)
  const apfKeyStats = {};
  apfData.forEach(g => {
    const sk = g.sport_key;
    if (!apfKeyStats[sk]) apfKeyStats[sk] = { total: 0, withOdds: 0 };
    apfKeyStats[sk].total++;
    if (g.bookmakers && g.bookmakers.length > 0) apfKeyStats[sk].withOdds++;
  });

  const needsOddsAPI = leagueEntries.filter(([sk]) => {
    if (!apfKeyStats[sk]) return true;                           // caso 1: sin juegos
    const { total, withOdds } = apfKeyStats[sk];
    return total > 0 && withOdds === 0;                         // caso 2: juegos sin odds
  });

  if (needsOddsAPI.length === 0) {
    return { data: apfData, source: 'api-football' };
  }

  const needsSet = new Set(needsOddsAPI.map(([sk]) => sk));
  console.log(`[Worker] APF sin odds: ${[...needsSet].join(', ')} — fallback a Odds API`);
  const supplementData = await buildOddsAPIData(env, [...needsSet]);
  console.log(`[Worker] OddsAPI supplement: ${supplementData.length} juegos (${needsSet.size} ligas)`);

  // ── Enriquecer Odds API games con _apf_ IDs (para brain algorithm) ──────────
  // APF devuelve fixtures sin odds pero CON IDs de equipos/fixture.
  // Los cruzamos por nombre de equipo (normalizado) para que el brain algorithm
  // pueda luego pedir stats/H2H usando los IDs de API-Football.
  const apfFallbackGames = apfData.filter(g => needsSet.has(g.sport_key));
  if (apfFallbackGames.length > 0) {
    const normName = s => (s || '').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')    // quitar acentos
      .replace(/\(.*?\)/g, ' ')                             // quitar "(CHI)", "(ARG)" etc.
      .replace(/[-_\/]/g, ' ')                              // guiones → espacio
      // quitar prefijos comunes
      .replace(/\b(club|ca|cr|cf|as|sd|rcd|red bull|atletico|deportivo|sp|bsc)\b/g, '')
      // quitar sufijos de ciudad/país
      .replace(/\b(fc|sc|cf|ac|cd|rj|ba|chi|uru|arg|bol|per|ecu|ven|col|bra|par|sa)\b/g, '')
      // quitar "de montevideo", "de cali", "de deportes" etc.
      .replace(/\bde\s+(montevideo|cali|deportes|quito|asuncion|lima)\b/g, '')
      .replace(/\b(montevideo|asuncion)\b/g, '')           // ciudad suelta al final
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ').trim();

    const apfMap = {};
    apfFallbackGames.forEach(g => {
      const key = normName(g.home_team) + '||' + normName(g.away_team);
      apfMap[key] = g;
    });

    // Índice por home+away para match exacto, y por home solo para fallback parcial
    const apfMapByHome = {};
    apfFallbackGames.forEach(g => {
      const hk = normName(g.home_team);
      if (!apfMapByHome[hk]) apfMapByHome[hk] = [];
      apfMapByHome[hk].push(g);
    });

    const applyApf = (g, src) => {
      g._apf_fixture_id = src._apf_fixture_id;
      g._apf_home_id    = src._apf_home_id;
      g._apf_away_id    = src._apf_away_id;
      g._apf_league_id  = src._apf_league_id;
      g._apf_status     = src._apf_status;
    };

    // Fuzzy match por substring: "bragantino" ⊂ "red bull bragantino"
    const fuzzyMatch = (a, b) => {
      if (!a || !b) return false;
      const [s, l] = a.length <= b.length ? [a, b] : [b, a];
      return s.length >= 4 && l.includes(s);
    };

    let enriched = 0;
    supplementData.forEach(g => {
      if (g._apf_fixture_id) return; // ya enriquecido
      const key = normName(g.home_team) + '||' + normName(g.away_team);
      let apfGame = apfMap[key];

      // Fallback: match parcial — buscar partido cuyo equipo local tenga substring overlap
      if (!apfGame) {
        const nh = normName(g.home_team);
        const na = normName(g.away_team);
        const candidates = apfFallbackGames.filter(af =>
          fuzzyMatch(nh, normName(af.home_team)) &&
          fuzzyMatch(na, normName(af.away_team))
        );
        if (candidates.length === 1) apfGame = candidates[0];
      }

      if (apfGame) { applyApf(g, apfGame); enriched++; }
    });
    if (enriched) console.log(`[Worker] _apf_ enriched: ${enriched}/${supplementData.length} Odds API games`);
  }

  // Descartar juegos APF sin odds y reemplazar con Odds API para esas ligas
  const filteredApf = apfData.filter(g => !needsSet.has(g.sport_key));
  const combined = [...filteredApf, ...supplementData];
  const source = filteredApf.length > 0 ? 'api-football+odds-api' : 'odds-api';
  return { data: combined, source };
}

// ── Definición de categorías de ligas ────────────────────────────────────────
const LEAGUES_MAIN = [
  ['soccer_argentina_primera_division',  128],
  ['soccer_conmebol_copa_libertadores',   13],
  ['soccer_conmebol_copa_sudamericana',   11],
  ['soccer_brazil_campeonato',            71],
  ['soccer_mexico_ligamx',              262],
  ['soccer_epl',                          39],
  ['soccer_spain_la_liga',              140],
  ['soccer_germany_bundesliga',           78],
  ['soccer_italy_serie_a',              135],
  ['soccer_france_ligue_one',             61],
  ['soccer_uefa_champs_league',            2],
];

const LEAGUES_EUROPE = [
  ['soccer_uefa_europa_league',            3],
  ['soccer_uefa_europa_conference_league', 848],
  ['soccer_netherlands_eredivisie',        88],
  ['soccer_turkey_super_league',          203],
  ['soccer_portugal_primeira_liga',        94],
  ['soccer_uruguay_primera_division',     268],
  ['soccer_chile_campeonato',             265],
  ['soccer_argentina_primera_nacional',   131],
  ['soccer_colombia_primera_a',          239],
  ['soccer_usa_mls',                     253],
];

// ── Router principal ─────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── /available ───────────────────────────────────────────────────────────
    if (path === '/available') {
      const keys = [...LEAGUES_MAIN, ...LEAGUES_EUROPE].map(([k]) => k);
      return new Response(JSON.stringify({ keys }), { headers: CORS });
    }

    // ── /odds ────────────────────────────────────────────────────────────────
    if (path === '/odds') {
      const category = url.searchParams.get('category') || 'main';
      const hourKey  = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
      const cacheKey = `odds6_${category}_${hourKey}`;

      const leagues = category === 'europe' ? LEAGUES_EUROPE : LEAGUES_MAIN;

      const result = await cached(env, cacheKey, 3600, () => getLeagueData(env, leagues));

      return new Response(JSON.stringify({
        data:    result.data,
        meta:    { total: result.data.length, source: result.source, category },
        _source: result.source
      }), { headers: CORS });
    }

    // ── /stats (🧠 Algorithm) ────────────────────────────────────────────────
    if (path === '/stats') {
      const teamId   = url.searchParams.get('team');
      const leagueId = url.searchParams.get('league');
      if (!teamId || !leagueId) {
        return new Response(JSON.stringify({ error: 'team and league params required' }), { status: 400, headers: CORS });
      }
      // Determinar la temporada correcta: buscar la liga en nuestro mapeo
      const entry = [...LEAGUES_MAIN, ...LEAGUES_EUROPE].find(([, lid]) => String(lid) === String(leagueId));
      const sportKey = entry ? entry[0] : '';
      const season = getSeason(sportKey);
      const cacheKey = `stats_${teamId}_${leagueId}_${season}`;
      const data = await cached(env, cacheKey, 86400, async () => {
        const resp = await apf(`/teams/statistics?team=${teamId}&league=${leagueId}&season=${season}`, env);
        return resp.response;
      });
      return new Response(JSON.stringify({ data }), { headers: CORS });
    }

    // ── /h2h (🧠 Algorithm) ──────────────────────────────────────────────────
    if (path === '/h2h') {
      const h2h = url.searchParams.get('h2h');
      if (!h2h) {
        return new Response(JSON.stringify({ error: 'h2h param required (format: teamA-teamB)' }), { status: 400, headers: CORS });
      }
      const cacheKey = `h2h_${h2h}_10`;
      const data = await cached(env, cacheKey, 86400, async () => {
        const resp = await apf(`/fixtures/headtohead?h2h=${h2h}&last=10`, env);
        return resp.response;
      });
      return new Response(JSON.stringify({ data }), { headers: CORS });
    }

    // ── /predictions ─────────────────────────────────────────────────────────
    if (path === '/predictions') {
      const fixtureId = url.searchParams.get('fixture');
      if (!fixtureId) {
        return new Response(JSON.stringify({ error: 'fixture param required' }), { status: 400, headers: CORS });
      }
      const cacheKey = `pred_${fixtureId}`;
      const data = await cached(env, cacheKey, 3600, async () => {
        const resp = await apf(`/predictions?fixture=${fixtureId}`, env);
        return resp.response?.[0];
      });
      return new Response(JSON.stringify({ data }), { headers: CORS });
    }

    // ── /notify-redeem (POST) ────────────────────────────────────────────────
    if (path === '/notify-redeem' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { casa, usd, costFmt, telegramUser, bettingId, userEmail } = body;

        if (!casa || !telegramUser || !bettingId) {
          return new Response(JSON.stringify({ ok: false, error: 'Faltan campos requeridos' }), { status: 400, headers: CORS });
        }

        const resendKey = env.RESEND_API_KEY;
        if (!resendKey) {
          return new Response(JSON.stringify({ ok: false, error: 'RESEND_API_KEY no configurada' }), { status: 500, headers: CORS });
        }

        const now = new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });

        const htmlBody = `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#0f0f1a;color:#f0f0f0;border-radius:12px;">
            <h2 style="color:#facc15;margin-top:0;">🎁 Nuevo Canje G$ — gambeta.ai</h2>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr><td style="padding:8px 12px;color:#aaa;width:40%;">Casa</td><td style="padding:8px 12px;font-weight:bold;">${casa}</td></tr>
              <tr style="background:#1a1a2e;"><td style="padding:8px 12px;color:#aaa;">Premio</td><td style="padding:8px 12px;font-weight:bold;color:#4ade80;">$${usd} USD</td></tr>
              <tr><td style="padding:8px 12px;color:#aaa;">Costo G$</td><td style="padding:8px 12px;">${costFmt} G$</td></tr>
              <tr style="background:#1a1a2e;"><td style="padding:8px 12px;color:#aaa;">Telegram</td><td style="padding:8px 12px;color:#38bdf8;">@${telegramUser}</td></tr>
              <tr><td style="padding:8px 12px;color:#aaa;">ID en ${casa}</td><td style="padding:8px 12px;font-family:monospace;font-size:15px;color:#facc15;">${bettingId}</td></tr>
              <tr style="background:#1a1a2e;"><td style="padding:8px 12px;color:#aaa;">Email usuario</td><td style="padding:8px 12px;">${userEmail || '—'}</td></tr>
              <tr><td style="padding:8px 12px;color:#aaa;">Fecha</td><td style="padding:8px 12px;">${now}</td></tr>
            </table>
            <p style="font-size:13px;color:#666;margin-top:20px;">Este canje fue procesado automáticamente por gambeta.ai. El usuario ya fue debitado sus G$.</p>
          </div>
        `;

        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'gambeta.ai <no-reply@gambeta.ai>',
            to: ['pronosticosarg@gmail.com'],
            subject: `🎁 Canje G$ — ${casa} $${usd} USD — @${telegramUser}`,
            html: htmlBody
          })
        });

        if (!emailRes.ok) {
          const errText = await emailRes.text();
          console.error('Resend error:', errText);
          return new Response(JSON.stringify({ ok: false, error: `Resend: ${emailRes.status}` }), { status: 502, headers: CORS });
        }

        return new Response(JSON.stringify({ ok: true }), { headers: CORS });
      } catch (e) {
        console.error('notify-redeem error:', e);
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── /status ──────────────────────────────────────────────────────────────
    if (path === '/status') {
      return new Response(JSON.stringify({
        worker: 'apuestas-api v2.4',
        time: new Date().toISOString(),
        apf_key: env.API_FOOTBALL_KEY ? 'configured' : 'MISSING',
        odds_key: env.ODDS_API_KEY ? 'configured' : 'MISSING',
        resend_key: env.RESEND_API_KEY ? 'configured' : 'MISSING',
        kv: env.CACHE_KV ? 'connected' : 'NOT connected'
      }), { headers: CORS });
    }

    return new Response(JSON.stringify({ error: 'Not found', path }), { status: 404, headers: CORS });
  }
};
