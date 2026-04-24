/**
 * gambeta.ai — Cloudflare Worker: apuestas-api
 * Migrado de The Odds API → API-Football (api-sports.io)
 *
 * Endpoints:
 *   GET /available          → lista de sport_keys soportados
 *   GET /odds?category=main → fixtures + cuotas (formato compatible con frontend)
 *   GET /odds?category=europe
 *   GET /stats?team=ID&league=ID → estadísticas de equipo (🧠 Algorithm)
 *   GET /h2h?h2h=ID1-ID2    → historial H2H (🧠 Algorithm)
 *   GET /fixtures?league=ID → próximos partidos con IDs de equipos
 *
 * Variables de entorno requeridas (Cloudflare Worker Settings > Variables):
 *   API_FOOTBALL_KEY  → tu API key de api-football.com
 *   ODDS_API_KEY      → tu API key de the-odds-api.com (mantenida como fallback)
 *
 * KV Namespace:
 *   CACHE_KV → namespace de KV para cachear respuestas (evita requests repetidos)
 */

const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';
const CURRENT_SEASON = 2025;

// ── Mapeo: sport_key del frontend → ID de liga en API-Football ──────────────
const LEAGUE_MAP = {
  'soccer_argentina_primera_division':   128,
  'soccer_argentina_primera_nacional':   131,
  'soccer_conmebol_copa_libertadores':    13,
  'soccer_conmebol_copa_sudamericana':    11,
  'soccer_brazil_campeonato':             71,
  'soccer_mexico_ligamx':               262,
  'soccer_usa_mls':                     253,
  'soccer_chile_campeonato':            265,
  'soccer_uruguay_primera_division':    268,
  'soccer_basketball_nba':                1, // placeholder — NBA is different API
  'soccer_uefa_champs_league':             2,
  'soccer_epl':                           39,
  'soccer_spain_la_liga':               140,
  'soccer_germany_bundesliga':            78,
  'soccer_italy_serie_a':               135,
  'soccer_france_ligue_one':             61,
  'soccer_uefa_europa_league':             3,
  'soccer_uefa_europa_conference_league': 848,
  'soccer_netherlands_eredivisie':        88,
  'soccer_turkey_super_league':          203,
  'soccer_portugal_primeira_liga':        94,
  'soccer_spain_segunda_division':       141,
  'soccer_brazil_serie_b':               72,
  'soccer_colombia_primera_a':           239,
};

// Bookmakers prioritarios (IDs en API-Football)
// 8=Bet365, 6=Bwin, 4=Betfair, 3=Pinnacle, 11=William Hill
const PRIORITY_BOOKMAKERS = [3, 8, 11, 6, 4];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=300'
};

// ── Cache helper ─────────────────────────────────────────────────────────────
async function cached(env, key, ttl, fn) {
  try {
    const hit = await env.CACHE_KV?.get(key);
    if (hit) return JSON.parse(hit);
  } catch {}
  const data = await fn();
  try {
    await env.CACHE_KV?.put(key, JSON.stringify(data), { expirationTtl: ttl });
  } catch {}
  return data;
}

// ── API-Football helper ──────────────────────────────────────────────────────
async function apf(path, env) {
  const key = env.API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY not configured');
  const r = await fetch(`${API_FOOTBALL_BASE}${path}`, {
    headers: { 'x-apisports-key': key }
  });
  if (!r.ok) throw new Error(`API-Football ${r.status}: ${path}`);
  return r.json();
}

// ── Transformar fixture API-Football → formato The Odds API (compatible frontend) ──
function transformGame(fixture, oddsBookmakers, sportKey) {
  const f   = fixture.fixture;
  const hm  = fixture.teams?.home;
  const aw  = fixture.teams?.away;

  const bookmakers = [];

  (oddsBookmakers || []).forEach(bm => {
    const h2hBet  = bm.bets?.find(b => /match winner/i.test(b.name));
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

    // Totales (Over/Under)
    const totalsBet = bm.bets?.find(b => /goals over.under/i.test(b.name));
    if (totalsBet) {
      const byLine = {};
      totalsBet.values?.forEach(v => {
        const match = v.value.match(/(Over|Under)\s+([\d.]+)/i);
        if (!match) return;
        const line = match[2];
        if (!byLine[line]) byLine[line] = {};
        byLine[line][match[1].toLowerCase()] = parseFloat(v.odd);
      });
      const totalsOutcomes = [];
      Object.entries(byLine).forEach(([line, vals]) => {
        if (vals.over)  totalsOutcomes.push({ name: 'Over',  point: parseFloat(line), price: vals.over });
        if (vals.under) totalsOutcomes.push({ name: 'Under', point: parseFloat(line), price: vals.under });
      });
      if (totalsOutcomes.length) markets.push({ key: 'totals', outcomes: totalsOutcomes });
    }

    // BTTS (Ambos Marcan)
    const bttsBet = bm.bets?.find(b => /both teams.*score/i.test(b.name));
    if (bttsBet) {
      const bttsOutcomes = bttsBet.values?.map(v => ({
        name: v.value === 'Yes' ? 'Yes' : 'No',
        price: parseFloat(v.odd)
      })) || [];
      if (bttsOutcomes.length) markets.push({ key: 'btts', outcomes: bttsOutcomes });
    }

    bookmakers.push({
      key:    bm.bookmaker?.name?.toLowerCase().replace(/\s+/g,'_') || 'unknown',
      title:  bm.bookmaker?.name || 'Unknown',
      markets
    });
  });

  return {
    id:           String(f.id),
    sport_key:    sportKey,
    commence_time: f.date,
    home_team:    hm.name,
    away_team:    aw.name,
    bookmakers,
    // ── Campos extra para el algoritmo 🧠 ──────────────────────────────────
    _apf_fixture_id: f.id,
    _apf_home_id:    hm.id,
    _apf_away_id:    aw.id,
    _apf_league_id:  fixture.league?.id,
    _apf_status:     f.status?.short,
  };
}

// ── Cargar fixtures + odds de una lista de ligas ─────────────────────────────
async function buildOddsData(env, leagueEntries) {
  const games = [];

  for (const [sportKey, leagueId] of leagueEntries) {
    try {
      // Fixtures próximos (hasta 15 por liga)
      const fixResp = await apf(
        `/fixtures?league=${leagueId}&season=${CURRENT_SEASON}&next=15`, env
      );
      const fixtures = fixResp.response || [];
      if (!fixtures.length) continue;

      // Odds batch por liga — usamos bookmaker 8 (Bet365) como principal
      // API-Football permite filtrar por bookmaker para ahorrar requests
      const oddsResp = await apf(
        `/odds?league=${leagueId}&season=${CURRENT_SEASON}&bookmaker=8&next=15`, env
      );

      // También intentar Pinnacle (3) si Bet365 no tiene
      const oddsPinnResp = await apf(
        `/odds?league=${leagueId}&season=${CURRENT_SEASON}&bookmaker=3&next=15`, env
      );

      // Crear mapa fixture_id → bookmakers de ambas fuentes
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
      mergeOdds(oddsPinnResp);

      // Transformar
      fixtures.forEach(fixture => {
        const bookmakers = oddsMap[fixture.fixture?.id] || [];
        const game = transformGame(fixture, bookmakers, sportKey);
        if (game.bookmakers.length > 0 || bookmakers.length === 0) {
          // Incluir siempre — el frontend maneja picks sin cuotas con estimación
          games.push(game);
        }
      });

    } catch (e) {
      console.error(`[Worker] League ${leagueId} (${sportKey}) error:`, e.message);
    }
  }

  return games;
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
      const cacheKey = `odds_${category}_${hourKey}`;

      const leagues = category === 'europe' ? LEAGUES_EUROPE : LEAGUES_MAIN;

      const data = await cached(env, cacheKey, 3600, () => buildOddsData(env, leagues));

      return new Response(JSON.stringify({
        data,
        meta:    { total: data.length, source: 'api-football', category },
        _source: 'api-football'
      }), { headers: CORS });
    }

    // ── /stats (🧠 Algorithm — estadísticas de equipo) ───────────────────────
    if (path === '/stats') {
      const teamId   = url.searchParams.get('team');
      const leagueId = url.searchParams.get('league');
      if (!teamId || !leagueId) {
        return new Response(JSON.stringify({ error: 'team and league params required' }), { status: 400, headers: CORS });
      }
      const cacheKey = `stats_${teamId}_${leagueId}_${CURRENT_SEASON}`;
      const data = await cached(env, cacheKey, 86400, async () => {
        const resp = await apf(`/teams/statistics?team=${teamId}&league=${leagueId}&season=${CURRENT_SEASON}`, env);
        return resp.response;
      });
      return new Response(JSON.stringify({ data }), { headers: CORS });
    }

    // ── /h2h (🧠 Algorithm — historial entre dos equipos) ────────────────────
    if (path === '/h2h') {
      const h2h = url.searchParams.get('h2h'); // formato: "ID1-ID2"
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

    // ── /injuries (🧠 Algorithm — lesionados) ────────────────────────────────
    if (path === '/injuries') {
      const fixtureId = url.searchParams.get('fixture');
      if (!fixtureId) {
        return new Response(JSON.stringify({ error: 'fixture param required' }), { status: 400, headers: CORS });
      }
      const cacheKey = `injuries_${fixtureId}`;
      const data = await cached(env, cacheKey, 7200, async () => {
        const resp = await apf(`/injuries?fixture=${fixtureId}`, env);
        return resp.response;
      });
      return new Response(JSON.stringify({ data }), { headers: CORS });
    }

    // ── /predictions (predicciones propias de API-Football) ──────────────────
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

    return new Response(JSON.stringify({ error: 'Not found', path }), { status: 404, headers: CORS });
  }
};
