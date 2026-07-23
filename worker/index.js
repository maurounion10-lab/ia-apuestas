/**
 * gambeta.ai — Cloudflare Worker: apuestas-api v3.4
 * Fuente primaria: API-Football (api-sports.io) — con The Odds API como fallback
 *
 * Endpoints:
 *   GET /available           → lista de sport_keys soportados
 *   GET /odds?category=main       → fixtures + cuotas (formato compatible con frontend)
 *   GET /odds?category=europe
 *   GET /odds?category=secondary  → 21 ligas secundarias (2ª divisiones, ligas regionales)
 *   GET /stats?team=ID&league=ID → estadísticas de equipo (🧠 Algorithm)
 *   GET /h2h?h2h=ID1-ID2     → historial H2H (🧠 Algorithm)
 *   GET /predictions?fixture=ID → predicciones de API-Football
 *
 * Variables de entorno requeridas:
 *   API_FOOTBALL_KEY  → api-football.com key
 *   ODDS_API_KEY      → the-odds-api.com key (fallback)
 *   RESEND_API_KEY    → resend.com key (notificaciones de canje)
 *
 * KV Namespace:
 *   CACHE_KV → gambeta-cache (ID: 1d4b161e78db4de9a9b806f369c73ceb)
 */

import { WC_FUTURES, WC_FUTURES_PUBLISH_TS } from './wc-futures.js';
import { WC_MATCHES, WC_MATCHES_PUBLISH_TS } from './wc-matches.js';

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

// ── Normalización de nombres de equipos ──────────────────────────────────────
// Mapea nombres largos/oficiales del API a nombres cortos para el frontend
const TEAM_NAME_MAP = {
  'Real Racing Club de Santander': 'Racing (S)',
  'Racing Club de Santander':      'Racing (S)',
  'Real Racing Club':              'Racing (S)',
  'Racing Santander':              'Racing (S)',
  'Racing de Santander':           'Racing (S)',
};
function normTeamName(name) {
  return TEAM_NAME_MAP[name] || name;
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
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization',
  'Access-Control-Max-Age': '86400',
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

// ── 🆕 (27-may-2026) Cup context: computa "qué equipo clasifica con empate" ──
//    Sirve para que el frontend prefiera Doble Oportunidad / Empate sobre Gana Local/Visitante
//    cuando el contexto del torneo (fase de grupos de Conmebol) lo amerita.
//    Output format: { "home_team|away_team": { prefer: '1x'|'x2'|'empate', reason: string, league: string } }
const CUP_SEASONS = [
  { id: 13, name: 'Libertadores',  season: 2026 },
  { id: 11, name: 'Sudamericana', season: 2026 },
];

async function computeCupContext(env) {
  const result = {};
  for (const cup of CUP_SEASONS) {
    let standings, fixtures;
    try {
      const stReq = await apf(`/standings?league=${cup.id}&season=${cup.season}`, env);
      const leagues = stReq.response;
      if (!leagues || !leagues[0]) continue;
      standings = leagues[0].league.standings; // array of groups
    } catch (e) {
      console.error(`[cup-ctx] standings ${cup.name} error:`, e.message);
      continue;
    }
    try {
      const fxReq = await apf(`/fixtures?league=${cup.id}&season=${cup.season}&next=30`, env);
      fixtures = fxReq.response || [];
    } catch (e) {
      console.error(`[cup-ctx] fixtures ${cup.name} error:`, e.message);
      continue;
    }

    for (const fx of fixtures) {
      const homeId = fx.teams?.home?.id;
      const awayId = fx.teams?.away?.id;
      const homeName = fx.teams?.home?.name;
      const awayName = fx.teams?.away?.name;
      if (!homeId || !awayId || !homeName || !awayName) continue;

      // Find the group containing both teams
      let group = null;
      for (const g of standings) {
        const hasHome = g.some(t => t.team.id === homeId);
        const hasAway = g.some(t => t.team.id === awayId);
        if (hasHome && hasAway) { group = g; break; }
      }
      if (!group) continue;

      const homeStand = group.find(t => t.team.id === homeId);
      const awayStand = group.find(t => t.team.id === awayId);
      if (!homeStand || !awayStand) continue;

      const homePts  = homeStand.points;
      const awayPts  = awayStand.points;
      const homeRank = homeStand.rank;
      const awayRank = awayStand.rank;
      const played   = group[0].all?.played || 0;

      // Heurística simple: suponer 1 partido restante (típico para el contexto que nos interesa).
      // Esto es conservador — si quedan más partidos, el override no se activa (volvemos al modelo regular).
      const remaining = 1;
      const ptsAfterDraw_home = homePts + 1;
      const ptsAfterDraw_away = awayPts + 1;

      // Mejor puntuación posible del 3ro y abajo después de los partidos restantes
      const thirdAndBelow = group.filter(t => t.rank > 2);
      if (!thirdAndBelow.length) continue;
      const maxThirdPts = Math.max(...thirdAndBelow.map(t => t.points + 3 * remaining));

      let prefer = null;
      let reason = null;

      // Home necesita empate para mantenerse en top 2 (clasificación)
      if (homeRank <= 2 && ptsAfterDraw_home > maxThirdPts) {
        prefer = '1x';
        reason = `${homeName} clasifica con empate (rank ${homeRank} del grupo, ${homePts}pts vs max ${maxThirdPts} del 3ro)`;
      }
      // Away necesita empate para mantenerse en top 2
      else if (awayRank <= 2 && ptsAfterDraw_away > maxThirdPts) {
        prefer = 'x2';
        reason = `${awayName} clasifica con empate (rank ${awayRank} del grupo, ${awayPts}pts vs max ${maxThirdPts} del 3ro)`;
      }

      if (prefer) {
        result[`${homeName}|${awayName}`] = { prefer, reason, league: cup.name, fixtureId: fx.fixture.id };
      }
    }
  }
  return result;
}

// ── 🆕 (29-may-2026) /league-context UNIVERSAL — extiende cup-context a ligas regulares ──
//    Detecta asimetría de motivación: equipo sin nada en juego (clasificado/descendido/medio sin riesgo)
//    vs equipo jugándose la vida. Cuando la asimetría existe, el modelo debería evitar apostar
//    a favor del 'sin motivación' (puede perder relajado, ejemplo Monza 0-2 ante Catanzaro).
//    Output igual que cup-context: { 'home|away': { prefer: '1x'|'x2'|'empate'|'avoid_home'|'avoid_away', reason, league } }

const LEAGUE_CONTEXT_CONFIG = [
  // Ligas europeas grandes — temporada 2025-26 (API season=2025), termina mayo-jun
  { id: 39,  name: 'Premier League',     season: 2025, topZone: 5, dropZone: 3, sportKey: 'soccer_epl' },
  { id: 140, name: 'La Liga',            season: 2025, topZone: 5, dropZone: 3, sportKey: 'soccer_spain_la_liga' },
  { id: 135, name: 'Serie A',            season: 2025, topZone: 5, dropZone: 3, sportKey: 'soccer_italy_serie_a' },
  { id: 78,  name: 'Bundesliga',         season: 2025, topZone: 5, dropZone: 3, sportKey: 'soccer_germany_bundesliga' },
  { id: 61,  name: 'Ligue 1',            season: 2025, topZone: 4, dropZone: 3, sportKey: 'soccer_france_ligue_one' },
  { id: 88,  name: 'Eredivisie',         season: 2025, topZone: 4, dropZone: 2, sportKey: 'soccer_netherlands_eredivisie' },
  { id: 94,  name: 'Primeira Liga',      season: 2025, topZone: 4, dropZone: 2, sportKey: 'soccer_portugal_primeira_liga' },
  { id: 203, name: 'Süper Lig',          season: 2025, topZone: 4, dropZone: 3, sportKey: 'soccer_turkey_super_league' },
  // 2ª divisiones europeas (top zone = promoción)
  { id: 40,  name: 'Championship',       season: 2025, topZone: 2, dropZone: 3, sportKey: 'soccer_england_championship' },
  { id: 79,  name: '2. Bundesliga',      season: 2025, topZone: 2, dropZone: 3, sportKey: 'soccer_germany_bundesliga2' },
  { id: 136, name: 'Serie B',            season: 2025, topZone: 2, dropZone: 3, sportKey: 'soccer_italy_serie_b' },
  { id: 141, name: 'Segunda División',   season: 2025, topZone: 2, dropZone: 3, sportKey: 'soccer_spain_segunda_division' },
  { id: 62,  name: 'Ligue 2',            season: 2025, topZone: 2, dropZone: 3, sportKey: 'soccer_france_ligue_two' },
  // Sudamerica (calendar year season=2026)
  { id: 128, name: 'Liga Argentina',     season: 2026, topZone: 4, dropZone: 4, sportKey: 'soccer_argentina_primera_division' },
  { id: 71,  name: 'Brasileirão',        season: 2026, topZone: 6, dropZone: 4, sportKey: 'soccer_brazil_campeonato' },
];

// Clasifica el estado de motivación de un equipo dado standings
function classifyMotivation(team, totalTeams, remaining, topZone, dropZone) {
  const pts = team.points;
  const rank = team.rank;
  const maxFuture = pts + 3 * remaining; // si gana todos los restantes
  const minFuture = pts;                  // si pierde todos
  // Aprox: posición final si gana todo / si pierde todo. Heurística — no es exacta porque
  // depende de qué hacen los demás, pero captura el caso "asegurado" en la mayoría.
  // 'CLINCHED_TOP' — incluso si pierde todo, queda en zona top
  // 'CLINCHED_BOTTOM' — incluso si gana todo, no escapa la zona descenso
  // 'FIGHTING_TOP' — gana todo y entra a top
  // 'FIGHTING_BOTTOM' — pierde todo y cae a zona descenso
  // 'MID_NO_STAKES' — entre top y descenso, sin chance arriba ni riesgo abajo
  if (rank <= topZone && remaining === 0) return 'CLINCHED_TOP';
  if (rank > totalTeams - dropZone && remaining === 0) return 'CLINCHED_BOTTOM';
  // Estimación post-jornada actual
  if (rank <= topZone && remaining <= 3) {
    // Si lidera con margen
    return 'FIGHTING_TOP'; // siempre tiene motivación
  }
  if (rank > totalTeams - dropZone - 2 && remaining <= 5) return 'FIGHTING_BOTTOM';
  if (rank > topZone + 1 && rank <= totalTeams - dropZone - 1 && remaining <= 3) return 'MID_NO_STAKES';
  return 'MOTIVATED'; // default: hay motivación normal
}

async function computeLeagueContext(env) {
  const result = {};
  for (const lg of LEAGUE_CONTEXT_CONFIG) {
    let standings = null, fixtures = null, totalTeams = 0;
    try {
      const stReq = await apf(`/standings?league=${lg.id}&season=${lg.season}`, env);
      const leagues = stReq.response;
      if (!leagues || !leagues[0]) { console.log(`[league-ctx] ${lg.name}: sin standings`); continue; }
      const groups = leagues[0].league.standings;
      if (!groups || !groups[0]) continue;
      standings = groups[0]; // liga regular: 1 sola tabla
      totalTeams = standings.length;
    } catch (e) { console.error(`[league-ctx] standings ${lg.name}:`, e.message); continue; }

    try {
      const fxReq = await apf(`/fixtures?league=${lg.id}&season=${lg.season}&next=20`, env);
      fixtures = fxReq.response || [];
    } catch (e) { console.error(`[league-ctx] fixtures ${lg.name}:`, e.message); continue; }

    if (!fixtures.length) continue;

    // Estimar fechas restantes: promedio de played en todos los equipos
    const playedAvg = standings.reduce((s, t) => s + (t.all?.played || 0), 0) / standings.length;
    // En liga regular cada equipo juega (totalTeams-1)*2 partidos
    const totalMatches = (totalTeams - 1) * 2;
    const remainingMatches = Math.max(0, Math.round(totalMatches - playedAvg));

    for (const fx of fixtures) {
      const homeId = fx.teams?.home?.id;
      const awayId = fx.teams?.away?.id;
      const homeName = fx.teams?.home?.name;
      const awayName = fx.teams?.away?.name;
      if (!homeId || !awayId || !homeName || !awayName) continue;

      const homeStand = standings.find(t => t.team.id === homeId);
      const awayStand = standings.find(t => t.team.id === awayId);
      if (!homeStand || !awayStand) continue;

      const homeMot = classifyMotivation(homeStand, totalTeams, remainingMatches, lg.topZone, lg.dropZone);
      const awayMot = classifyMotivation(awayStand, totalTeams, remainingMatches, lg.topZone, lg.dropZone);

      // ASIMETRÍA: uno juega por algo, el otro no
      const motivated = new Set(['FIGHTING_TOP', 'FIGHTING_BOTTOM']);
      const noStakes  = new Set(['MID_NO_STAKES', 'CLINCHED_TOP', 'CLINCHED_BOTTOM']);

      let prefer = null, reason = null;

      if (noStakes.has(homeMot) && motivated.has(awayMot)) {
        // Home sin motivación, away se juega la vida → el modelo no debería apostar a favor de home
        prefer = 'avoid_home';
        reason = `${homeName} no se juega nada (${homeMot}); ${awayName} sí (${awayMot}). Evitar pick a favor del local relajado.`;
      } else if (noStakes.has(awayMot) && motivated.has(homeMot)) {
        prefer = 'avoid_away';
        reason = `${awayName} no se juega nada (${awayMot}); ${homeName} sí (${homeMot}). Evitar pick a favor del visitante relajado.`;
      }

      if (prefer) {
        result[`${homeName}|${awayName}`] = {
          prefer, reason, league: lg.name, sportKey: lg.sportKey,
          fixtureId: fx.fixture.id,
          homeMot, awayMot, remainingMatches
        };
      }
    }
  }
  return result;
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
  // 🆕 (13-jul) throw ante cualquier error de APF (rateLimit por minuto, plan, etc)
  // para que cached() NUNCA almacene respuestas vacías por error.
  if (json.errors && !Array.isArray(json.errors) && Object.keys(json.errors).length) {
    throw new Error('APF error: ' + JSON.stringify(json.errors));
  }
  return json;
}

// ── The Odds API fallback helper ─────────────────────────────────────────────
async function fetchOddsAPI(sportKey, env) {
  const key = env.ODDS_API_KEY;
  if (!key) return [];
  try {
    // ⚠️ (18-jul) NO agregar btts acá: el endpoint masivo /odds NO lo soporta (422
    // INVALID_MARKET) y el error silencioso dejó el feed VACÍO todo un finde.
    // BTTS solo existe en el endpoint por-evento /events/{id}/odds.
    const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/odds/?apiKey=${key}&regions=eu,uk&markets=h2h,totals&oddsFormat=decimal&dateFormat=iso`;
    const r = await fetch(url);
    if (!r.ok) return [];
    return await r.json();
  } catch {
    return [];
  }
}

// ── Transformar fixture API-Football → formato frontend ─────────────────────
// ── Detecta etapa del torneo desde el round de API-Football ──
// Valores típicos de API-Football: "Final", "Semi-finals", "Quarter-finals",
// "8th Finals", "Round of 16", "Regular Season - 12", "Group Stage - 3"
function _parseStage(round) {
  if (!round || typeof round !== 'string') return null;
  const r = round.toLowerCase().trim();
  if (r === 'final' || /\bgrand final\b/.test(r)) return 'final';
  if (r.includes('semi')) return 'semi';
  if (r.includes('quarter') || r.includes('1/4')) return 'quarter';
  if (r.includes('round of 16') || r.includes('8th final') || r.includes('1/8')) return 'r16';
  return null;
}

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
    home_team:     normTeamName(hm.name),
    away_team:     normTeamName(aw.name),
    bookmakers,
    _apf_fixture_id: f.id,
    _apf_home_id:    hm.id,
    _apf_away_id:    aw.id,
    _apf_league_id:  fixture.league?.id,
    _apf_status:     f.status?.short,
    _round:          fixture.league?.round || null,
    _stage:          _parseStage(fixture.league?.round),
  };
}

// ── Transformar juego de The Odds API → formato frontend ────────────────────
function transformOddsAPIGame(g) {
  return {
    id:            g.id,
    sport_key:     g.sport_key,
    sport_title:   g.sport_title || g.sport_key,
    commence_time: g.commence_time,
    home_team:     normTeamName(g.home_team),
    away_team:     normTeamName(g.away_team),
    bookmakers:    (g.bookmakers || []).map(bm => ({
      key:   bm.key,
      title: bm.title,
      markets: (bm.markets || []).map(m => ({
        key:      m.key,
        outcomes: (m.outcomes || []).map(o => ({
          name:  normTeamName(o.name),
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
    if (!leagueId) continue; // leagueId null/0 → solo Odds API, sin llamada APF
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
      g._round          = src._round || null;
      g._stage          = src._stage || null;
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

  // 🆕 (31-may-2026) Filtrar equipos B / reservas / filiales — esos partidos
  // se categorizan mal por The Odds API (ej. Real Sociedad B aparece en
  // soccer_spain_segunda_division pero juega en Primera RFEF que no tiene
  // cobertura en ESPN/TSDB/APF). Si bloqueamos en la fuente, nunca se genera
  // pick y nunca queda stuck en pending.
  const filteredBReserves = combined.filter(g => {
    if (isReserveTeam(g.home_team) || isReserveTeam(g.away_team)) {
      console.log(`[filter-B] descartado: ${g.home_team} vs ${g.away_team} (${g.sport_key})`);
      return false;
    }
    return true;
  });

  const source = filteredApf.length > 0 ? 'api-football+odds-api' : 'odds-api';
  return { data: filteredBReserves, source };
}

// ── 🆕 isReserveTeam: detecta equipos B/filiales que no tienen cobertura en
//     ninguna fuente de scores (Primera RFEF, regional leagues, etc).
//     Si un partido tiene alguno de estos equipos, descartamos antes de que
//     genere pick para evitar que quede stuck pending para siempre.
function isReserveTeam(name) {
  if (!name) return false;
  const n = name.trim();
  // Sufijos típicos de equipos filiales
  // 'B' al final: Real Sociedad B, Atletico Madrid B, Barcelona B
  // 'II' al final: Bayern Munich II, Borussia Dortmund II
  // 'U23' / 'U-23' / 'Sub-23' / 'Sub23': equipos juveniles
  // 'Reserves' / 'Reserve' al final
  // 'Castilla' (Real Madrid B se llama Castilla)
  if (/\s+(B|II|U-?23|U23|Sub-?23|Reserves?)$/i.test(n)) return true;
  if (/^Castilla$/i.test(n) || /Real Madrid Castilla/i.test(n)) return true;
  // 'C. Leonesa' = Cultural Leonesa, juega en Primera RFEF, sin cobertura
  if (/^C\.\s?Leonesa$/i.test(n) || /Cultural Leonesa/i.test(n)) return true;
  return false;
}

// ── Definición de categorías de ligas ────────────────────────────────────────
const LEAGUES_MAIN = [
  ['soccer_fifa_world_cup',                1],   // 🏆 Mundial 2026 — APF leagueId=1 (FIFA World Cup), calendar year
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

// ── Ligas secundarias: 2ª divisiones + ligas regionales ─────────────────────
// leagueId=null → solo Odds API (sin llamada APF — ligas sin datos de stats/H2H)
// Todas las ligas secundarias van directo a The Odds API (null leagueId).
// Motivo: APF tiene cupo diario limitado; las secundarias no necesitan H2H/stats.
const LEAGUES_SECONDARY = [
  // ── Migración 14-may-2026: leagueIds mapeados a API-Football PRO ($19) ──────
  // Antes: null en todas → cada request gastaba ~21 credits de The Odds API ($119/mes).
  // Después: APF maneja todo → Odds API solo se llama si APF falla globalmente.
  // Ahorro objetivo: bajar uso Odds API de 527k/mes a <2k/mes → plan 20K ($30).
  //
  // Europa: 2ª divisiones y ligas medianas
  ['soccer_england_championship',              40],   // Championship
  ['soccer_belgium_first_div_a',               144],  // Belgian Pro League
  ['soccer_germany_bundesliga2',               79],   // 2. Bundesliga
  ['soccer_spain_segunda_division',            141],  // Segunda División
  ['soccer_italy_serie_b',                     136],  // Serie B
  ['soccer_france_ligue_two',                  62],   // Ligue 2
  ['soccer_austria_football_bundesliga',       218],  // Austrian Bundesliga
  ['soccer_switzerland_superleague',           207],  // Swiss Super League
  ['soccer_denmark_superliga',                 119],  // Danish Superliga
  ['soccer_sweden_allsvenskan',                113],  // Allsvenskan
  ['soccer_norway_eliteserien',                103],  // Eliteserien
  ['soccer_poland_ekstraklasa',                106],  // Ekstraklasa
  ['soccer_czech_republic_first_league',       345],  // Czech Liga
  // Europa del Este / Otros
  ['soccer_russia_premier_league',             235],  // RPL
  // Latinoamérica extra
  ['soccer_ecuador_liga_pro',                  240],  // Liga Pro
  ['soccer_peru_primera_division',             281],  // Liga 1 Peru
  ['soccer_venezuela_primera_division',        299],  // FUTVE
  ['soccer_bolivia_primera_division',          344],  // Div. Prof. Bolivia
  ['soccer_paraguay_primera_division',         271],  // Div. Honor Paraguay
  // Asia / Oceanía
  ['soccer_south_korea_kleague1',              292],  // K League 1
  ['soccer_australia_aleague',                 188],  // A-League
];

// ════════════════════════════════════════════════════════════════════════════
// SCHEDULED RESOLVER (cron) — server-side, corre cada hora sin browser
// ════════════════════════════════════════════════════════════════════════════
//
// Replica lo que loadHistoricalScores() hace en el client:
//   1. Lee acoin_users.historial_full del admin (via service_role)
//   2. Para cada pending pick con kick-off >2h pasado y <21 días:
//      a. Fetch ESPN scoreboard de su liga + fecha
//      b. Si ESPN no devolvió match, fetch TheSportsDB searchevents
//   3. Match scores → calcula win/loss/void
//   4. Upsert historial_full (el trigger Postgres replica a shared_cache)
//
// Requiere env.SUPABASE_SERVICE_ROLE_KEY como secret.

const SUPABASE_URL  = 'https://ixfrtjvhnpapyuphqfxp.supabase.co';
const ADMIN_EMAIL   = 'mauro.union10@gmail.com';
const ESPN_BASE     = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const TSDB_BASE     = 'https://www.thesportsdb.com/api/v1/json/3';

// Mapa sport_key → ESPN league code (mirrors index.html line ~12990)
const SPORT_TO_ESPN_RESOLVER = {
  soccer_argentina_primera_division:   'arg.1',
  soccer_argentina_primera_nacional:   'arg.nacional',
  soccer_epl:                          'eng.1',
  soccer_england_premier_league:       'eng.1',
  soccer_spain_la_liga:                'esp.1',
  soccer_germany_bundesliga:           'ger.1',
  soccer_italy_serie_a:                'ita.1',
  soccer_france_ligue_one:             'fra.1',
  soccer_brazil_campeonato:            'bra.1',
  soccer_uefa_champs_league:           'uefa.champions',
  soccer_uefa_europa_league:           'uefa.europa',
  soccer_uefa_conference_league:       'uefa.europa.conf',
  soccer_uefa_europa_conference_league:'uefa.europa.conf',
  soccer_conmebol_copa_libertadores:   'conmebol.libertadores',
  soccer_conmebol_copa_sudamericana:   'conmebol.sudamericana',
  soccer_mexico_ligamx:                'mex.1',
  soccer_netherlands_eredivisie:       'ned.1',
  soccer_portugal_primeira_liga:       'por.1',
  soccer_turkey_super_league:          'tur.1',
  soccer_england_championship:         'eng.2',
  soccer_germany_bundesliga2:          'ger.2',
  soccer_italy_serie_b:                'ita.2',
  soccer_france_ligue_two:             'fra.2',
  soccer_spain_segunda_division:       'esp.2',
  soccer_scotland_premiership:         'sco.1',
  soccer_greece_super_league:          'gre.1',
  soccer_usa_mls:                      'usa.1',
  soccer_colombia_primera_a:           'col.1',
  soccer_uruguay_primera_division:     'uru.1',
  soccer_paraguay_primera_division:    'par.1',
  soccer_peru_primera_division:        'per.1',
  soccer_ecuador_liga_pro:             'ecu.1',
  soccer_chile_campeonato:             'chi.1',
  soccer_australia_aleague:            'aus.1',
  soccer_australia_a_league:           'aus.1',
};

// Ligas que ESPN no cubre — ir directo a TSDB
const TSDB_ONLY_LEAGUES = new Set([
  'soccer_poland_ekstraklasa',
  'soccer_switzerland_superleague',
  'soccer_belgium_first_div_a',
  'soccer_belgium_first_div',
  'soccer_austria_football_bundesliga',
  'soccer_austria_bundesliga',
  'soccer_denmark_superliga',
  'soccer_sweden_allsvenskan',
  'soccer_norway_eliteserien',
]);

// Mapeo sport_key → TSDB league ID (para fallback por fecha cuando search por nombre falla)
const SPORT_TO_TSDB_LEAGUE = {
  'soccer_poland_ekstraklasa':      '4422',
  'soccer_switzerland_superleague': '4675',
  'soccer_denmark_superliga':       '4340',
  'soccer_sweden_allsvenskan':      '4347',
  'soccer_norway_eliteserien':      '4404',
  'soccer_belgium_first_div':       '4403',
  'soccer_belgium_first_div_a':     '4403',
  'soccer_austria_bundesliga':      '4406',
  'soccer_austria_football_bundesliga': '4406',
  'soccer_france_ligue_two':        '4334',  // TSDB tiene Ligue 2 bajo "French Ligue 1"
  'soccer_france_ligue_one':        '4334',
};

// Normalizador de nombres de equipos (sin diacríticos, sin espacios, minúsculas)
// Aliases de equipos: siglas/nombres alternativos → forma canónica normalizada
const TEAM_ALIASES = {
  'ucv':                          'universidadcentral',
  'ucvfc':                        'universidadcentral',
  'universidadcentraldevenezuela':'universidadcentral',
  'ucvcaracas':                   'universidadcentral',
};
function normTeam(s) {
  if (!s) return '';
  // Fold de letras nórdicas/eslavas que NFD no descompone (ø æ å ł ß ð þ).
  // Sin esto "Bodø/Glimt" (API) y "Bodo/Glimt" (ESPN) no matchean → pick stuck.
  const n = s.toLowerCase()
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a')
    .replace(/ł/g, 'l').replace(/ß/g, 'ss').replace(/ð/g, 'd').replace(/þ/g, 'th')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
  return TEAM_ALIASES[n] || n;
}

// ── Scores manuales: picks que el auto-resolver no puede matchear (ej:
//    partidos de playoff que no están en la liga ESPN esperada). Clave:
//    normTeam(home) + '|' + normTeam(away). El resolver los chequea PRIMERO.
const MANUAL_SCORES = {
  'ikstart|bodoglimt': { h: 1, a: 4 },  // Eliteserien 20-may-2026
  'willemii|volendam': { h: 1, a: 2 },  // Playoff Eredivisie 20-may-2026
  'rakow|arkagdynia':  { h: 3, a: 0 },  // Ekstraklasa 23-may-2026
  'volendam|willemii': { h: 1, a: 2 },  // Playoff Eredivisie 23-may-2026 (vuelta)
  'bodoglimt|brann':   { h: 3, a: 1 },  // Eliteserien 24-may-2026
};

// Match fuzzy entre dos nombres de equipo (mismo equipo, distintas variantes)
// Aliases para resolver matches API-Football vs nombres del Odds API.
// IMPORTANTE: las keys y values están en la forma normalizada de normTeam()
// (sin espacios, lowercase, sin caracteres especiales).
const TEAM_ALIASES_RESOLVER = {
  'psg':                'parissaintgermain',
  'parissg':            'parissaintgermain',
  'parissaintgermain':  'psg',
  'manutd':             'manchesterunited',
  'manunited':          'manchesterunited',
  'mancity':            'manchestercity',
  'atm':                'atleticomadrid',
  'atleticodemadrid':   'atleticomadrid',
  'inter':              'intermilan',
  'intermilano':        'intermilan',
  'milan':              'acmilan',
  'realbetis':          'betis',
  'om':                 'marseille',
  'olympiquemarseille': 'marseille',
  'ol':                 'lyon',
  'olympiquelyon':      'lyon',
  'olympiquelyonnais':  'lyon',
  // 🏆 Selecciones Mundial 2026: ES (repo) <-> EN (API-Football)
  // CONMEBOL
  'argentina':          'argentina',  // mismo
  'brasil':             'brazil',
  'brazil':             'brasil',
  'colombia':           'colombia',
  'uruguay':            'uruguay',
  'paraguay':           'paraguay',
  'ecuador':            'ecuador',
  'venezuela':          'venezuela',
  'chile':              'chile',
  'peru':               'peru',
  'bolivia':            'bolivia',
  // UEFA
  'alemania':           'germany',
  'germany':            'alemania',
  'inglaterra':         'england',
  'england':            'inglaterra',
  'paisesbajos':        'netherlands',
  'netherlands':        'paisesbajos',
  'holanda':            'netherlands',
  'espana':             'spain',
  'spain':              'espana',
  'italia':             'italy',
  'italy':              'italia',
  'francia':            'france',
  'france':             'francia',
  'belgica':            'belgium',
  'belgium':            'belgica',
  'portugal':           'portugal',  // mismo
  'croacia':            'croatia',
  'croatia':            'croacia',
  'suiza':              'switzerland',
  'switzerland':        'suiza',
  'austria':            'austria',  // mismo
  'dinamarca':          'denmark',
  'denmark':            'dinamarca',
  'noruega':            'norway',
  'norway':             'noruega',
  'suecia':             'sweden',
  'sweden':             'suecia',
  'polonia':            'poland',
  'poland':             'polonia',
  'turquia':            'turkey',
  'turkey':             'turquia',
  'rumania':            'romania',
  'romania':            'rumania',
  'gales':              'wales',
  'wales':              'gales',
  'escocia':            'scotland',
  'scotland':           'escocia',
  'serbia':             'serbia',  // mismo
  'ucrania':            'ukraine',
  'ukraine':            'ucrania',
  'rusia':              'russia',
  'russia':             'rusia',
  'bosnia':             'bosniaherzegovina',
  'bosniayherzegovina': 'bosniaherzegovina',
  'republicacheca':     'czechrepublic',
  'czechrepublic':      'republicacheca',
  'repcheca':           'czechrepublic',
  'czechia':            'republicacheca',
  // CONCACAF
  'mexico':             'mexico',  // mismo
  'usa':                'unitedstates',
  'estadosunidos':      'unitedstates',
  'unitedstates':       'usa',
  'canada':             'canada',  // mismo
  'costarica':          'costarica',  // mismo
  'panama':             'panama',  // mismo
  'jamaica':            'jamaica',  // mismo
  'honduras':           'honduras',  // mismo
  'haiti':              'haiti',  // mismo
  'curacao':            'curacao',  // mismo
  // CAF
  'marruecos':          'morocco',
  'morocco':            'marruecos',
  'egipto':             'egypt',
  'egypt':              'egipto',
  'argelia':            'algeria',
  'algeria':            'argelia',
  'tunez':              'tunisia',
  'tunisia':            'tunez',
  'senegal':            'senegal',  // mismo
  'nigeria':            'nigeria',  // mismo
  'ghana':              'ghana',    // mismo
  'camerun':            'cameroon',
  'cameroon':           'camerun',
  'costademarfil':      'ivorycoast',
  'ivorycoast':         'costademarfil',
  'costadivoire':       'ivorycoast',
  'sudafrica':          'southafrica',
  'southafrica':        'sudafrica',
  'cabovere':           'capeverde',
  'capeverde':          'cabovere',
  'rdcongo':            'drcongo',
  'drcongo':            'rdcongo',
  'congodemocratico':   'drcongo',
  // AFC
  'japon':              'japan',
  'japan':              'japon',
  'coreadelsur':        'southkorea',
  'southkorea':         'coreadelsur',
  'corea':              'southkorea',
  'australia':          'australia',  // mismo
  'iran':               'iran',  // mismo
  'iraq':               'iraq',  // mismo
  'arabiasaudita':      'saudiarabia',
  'saudiarabia':        'arabiasaudita',
  'arabia':             'saudiarabia',
  'qatar':              'qatar',  // mismo
  'catar':              'qatar',
  'jordania':           'jordan',
  'jordan':             'jordania',
  'uzbekistan':         'uzbekistan',  // mismo
  // OFC
  'nuevazelanda':       'newzealand',
  'newzealand':         'nuevazelanda',
};

function teamsMatch(a, b) {
  if (!a || !b) return false;
  const na = normTeam(a), nb = normTeam(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Aliases resolver: si na o nb es key del dict y su value matchea el otro
  if (TEAM_ALIASES_RESOLVER[na] === nb || TEAM_ALIASES_RESOLVER[nb] === na) return true;
  if (TEAM_ALIASES_RESOLVER[na] && (TEAM_ALIASES_RESOLVER[na] === nb || nb.includes(TEAM_ALIASES_RESOLVER[na]))) return true;
  if (TEAM_ALIASES_RESOLVER[nb] && (TEAM_ALIASES_RESOLVER[nb] === na || na.includes(TEAM_ALIASES_RESOLVER[nb]))) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  // Strip suffixes comunes (fc, sc, etc, plural 's') y prefijo 'st' vs 'saint' / 'ac' etc
  const expand = s => s.replace(/^st(?=[a-z])/, 'saint').replace(/^saint(?=[a-z])/, 'saint');
  const stripped = s => s
    .replace(/(fc|cf|sc|ac|afc|sfc|rfc|fk|sk|bk|nk|gnk|ks|sk|if)$/, '')
    .replace(/s$/, '');  // plurales tipo "Grasshoppers" ↔ "Grasshopper"
  const sa = stripped(expand(na));
  const sb = stripped(expand(nb));
  if (sa === sb) return true;
  if (sa && sb && (sa.includes(sb) || sb.includes(sa))) return true;
  // Match por primera palabra significativa (≥4 chars): "Lausanne-Sport" ↔ "Lausanne"
  const firstWord = s => {
    const m = (s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z]+/g) || [])
      .filter(w => w.length >= 4);
    return m[0] || '';
  };
  const fa = firstWord(a), fb = firstWord(b);
  if (fa && fb && fa === fb) return true;
  return false;
}

// Fetch ESPN scoreboard para una liga × fecha (YYYYMMDD)
// Status names ESPN que indican partido NO completado regularmente → void
const ESPN_VOID_STATUSES = new Set([
  'STATUS_ABANDONED', 'STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_CANCELLED',
  'STATUS_SUSPENDED', 'STATUS_FORFEIT', 'STATUS_AWARDED',
]);

async function fetchEspnScoreboard(leagueCode, dateStr) {
  try {
    const r = await fetch(`${ESPN_BASE}/${leagueCode}/scoreboard?dates=${dateStr}`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.events || [])
      .filter(e => {
        const st = e.status?.type;
        // Incluir partidos completados normalmente O abandonados/postpuestos (para marcar void)
        return st?.completed || ESPN_VOID_STATUSES.has(st?.name || '');
      })
      .map(e => {
        const comp  = e.competitions?.[0] || {};
        const home  = comp.competitors?.find(t => t.homeAway === 'home') || {};
        const away  = comp.competitors?.find(t => t.homeAway === 'away') || {};
        const st = e.status?.type;
        const voidReason = ESPN_VOID_STATUSES.has(st?.name || '') ? (st.description || st.name) : null;
        return {
          home:       home.team?.displayName || home.team?.name || '',
          away:       away.team?.displayName || away.team?.name || '',
          scoreH:     parseInt(home.score) || 0,
          scoreA:     parseInt(away.score) || 0,
          commenceTs: e.date ? new Date(e.date).getTime() : null,
          src: 'espn',
          voidReason,
        };
      });
  } catch { return []; }
}

// Fetch TheSportsDB searchevents para un match específico (Home_vs_Away)
// Aliases legibles para búsqueda en TSDB (siglas → nombre completo que usa TSDB)
const TEAM_ALIAS_READABLE = {
  'UCV': 'Universidad Central',
  'UCV FC': 'Universidad Central',
  // 🆕 (1-jul-2026 #636) Mundial 2026 — 48 equipos ES→EN para TSDB match
  'México': 'Mexico',
  'Sudáfrica': 'South Africa',
  'Canadá': 'Canada',
  'Bosnia': 'Bosnia and Herzegovina',
  'Estados Unidos': 'USA',
  'Paraguay': 'Paraguay',
  'Brasil': 'Brazil',
  'Marruecos': 'Morocco',
  'Suiza': 'Switzerland',
  'Catar': 'Qatar',
  'Haití': 'Haiti',
  'Escocia': 'Scotland',
  'Alemania': 'Germany',
  'Curaçao': 'Curacao',
  'Países Bajos': 'Netherlands',
  'Japón': 'Japan',
  'Colombia': 'Colombia',
  'Uzbekistán': 'Uzbekistan',
  'Bélgica': 'Belgium',
  'Egipto': 'Egypt',
  'España': 'Spain',
  'Cabo Verde': 'Cape Verde',
  'Ecuador': 'Ecuador',
  'Costa de Marfil': 'Ivory Coast',
  'Costa Marfil': 'Ivory Coast',
  'Francia': 'France',
  'Senegal': 'Senegal',
  'Argentina': 'Argentina',
  'Argelia': 'Algeria',
  'Austria': 'Austria',
  'Jordania': 'Jordan',
  'Portugal': 'Portugal',
  'RD Congo': 'DR Congo',
  'República Democrática del Congo': 'DR Congo',
  'Inglaterra': 'England',
  'Croacia': 'Croatia',
  'Turquía': 'Turkey',
  'Noruega': 'Norway',
  'Uruguay': 'Uruguay',
  'Túnez': 'Tunisia',
  'Irán': 'Iran',
  'Corea del Sur': 'South Korea',
  'Iraq': 'Iraq',
  'Arabia Saudí': 'Saudi Arabia',
  'Arabia Saudita': 'Saudi Arabia',
  'Ghana': 'Ghana',
  'Australia': 'Australia',
  'Nueva Zelanda': 'New Zealand',
  'Panamá': 'Panama',
};
async function fetchTsdbEvent(homeName, awayName) {
  try {
    const slug = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
    // Probar varias combinaciones de nombres (original + alias)
    const homeVariants = [homeName, TEAM_ALIAS_READABLE[homeName]].filter(Boolean);
    const awayVariants = [awayName, TEAM_ALIAS_READABLE[awayName]].filter(Boolean);
    const queries = [];
    for (const h of homeVariants) for (const a of awayVariants) {
      const q = `${slug(h)}_vs_${slug(a)}`;
      if (q && q !== '_vs_' && !queries.includes(q)) queries.push(q);
    }
    let events = [];
    for (const q of queries) {
      const r = await fetch(`${TSDB_BASE}/searchevents.php?e=${q}`);
      if (!r.ok) continue;
      const j = await r.json();
      const ev = j.event || j.events || [];
      if (ev && ev.length) { events = ev; break; }
    }
    for (const e of events) {
      if (e.intHomeScore == null || e.intAwayScore == null) continue;
      if (e.intHomeScore === '' || e.intAwayScore === '') continue;
      const sH = parseInt(e.intHomeScore), sA = parseInt(e.intAwayScore);
      if (!Number.isFinite(sH) || !Number.isFinite(sA)) continue;
      const ts = e.strTimestamp
        ? new Date(e.strTimestamp + (e.strTimestamp.endsWith('Z') ? '' : 'Z')).getTime()
        : (e.dateEvent ? new Date(e.dateEvent + 'T18:00:00Z').getTime() : null);
      return {
        home: e.strHomeTeam || homeName,
        away: e.strAwayTeam || awayName,
        scoreH: sH, scoreA: sA,
        commenceTs: ts,
        src: 'tsdb',
      };
    }
    return null;
  } catch { return null; }
}

// Fallback: TSDB por league+date — más robusto que searchevents.php?e= cuando los nombres no matchean
async function fetchTsdbByLeagueDate(leagueId, kickoffTs, pickHome, pickAway) {
  if (!leagueId || !kickoffTs) return null;
  try {
    // Probar el día del kickoff y ±1 día (timezones)
    for (const dayOffset of [0, -1, 1]) {
      const dateStr = new Date(kickoffTs + dayOffset * 86400000).toISOString().substring(0, 10);
      const r = await fetch(`${TSDB_BASE}/eventsday.php?d=${dateStr}&l=${leagueId}`);
      if (!r.ok) continue;
      const j = await r.json();
      const events = j.events || [];
      for (const e of events) {
        if (!teamsMatch(e.strHomeTeam, pickHome) || !teamsMatch(e.strAwayTeam, pickAway)) continue;
        if (e.intHomeScore == null || e.intAwayScore == null) continue;
        if (e.intHomeScore === '' || e.intAwayScore === '') continue;
        const sH = parseInt(e.intHomeScore), sA = parseInt(e.intAwayScore);
        if (!Number.isFinite(sH) || !Number.isFinite(sA)) continue;
        const status = (e.strStatus || '').toLowerCase();
        const voidReasonTsdb = ['abandon', 'postpon', 'cancel', 'suspend'].find(k => status.includes(k));
        // Aceptar 'Match Finished' o status vacío O void-statuses (para marcar void)
        const isFinished = status.includes('finish') || status.includes('final') || status === 'ft' || !status;
        if (!isFinished && !voidReasonTsdb) continue;
        const ts = e.strTimestamp
          ? new Date(e.strTimestamp + (e.strTimestamp.endsWith('Z') ? '' : 'Z')).getTime()
          : (e.dateEvent ? new Date(e.dateEvent + 'T18:00:00Z').getTime() : null);
        return {
          home: e.strHomeTeam || pickHome,
          away: e.strAwayTeam || pickAway,
          scoreH: sH, scoreA: sA,
          commenceTs: ts,
          src: 'tsdb-ld',
          voidReason: voidReasonTsdb ? (e.strStatus || voidReasonTsdb) : null,
        };
      }
    }
    return null;
  } catch { return null; }
}

// Resuelve un pick contra un score: devuelve 'win'/'loss'/'void' o null
function calcResult(pick, score) {
  const sH = score.scoreH, sA = score.scoreA;
  const homeWin = sH > sA;
  const awayWin = sA > sH;
  const draw    = sH === sA;
  const total   = sH + sA;
  const btts    = sH > 0 && sA > 0;
  const rec = pick.rec || '';

  if (rec === 'Gana Local')      return homeWin ? 'win' : 'loss';
  if (rec === 'Gana Visitante')  return awayWin ? 'win' : 'loss';
  if (rec === 'Empate')          return draw    ? 'win' : 'loss';
  if (rec === 'Doble 1X')        return (homeWin || draw) ? 'win' : 'loss';   // 🆕 (27-may-2026) DO local o empate
  if (rec === 'Doble X2')        return (awayWin || draw) ? 'win' : 'loss';   // 🆕 (27-may-2026) DO visitante o empate
  if (rec === 'Ambos Marcan')    return btts    ? 'win' : 'loss';
  if (rec === 'Ambos No Marcan') return !btts   ? 'win' : 'loss';   // 🆕 (14-jul) BTTS No
  if (rec === 'Más de 1.5')      return total >= 2 ? 'win' : 'loss';
  if (rec === 'Más de 2.5')      return total >= 3 ? 'win' : 'loss';
  if (rec === 'Más de 3.5')      return total >= 4 ? 'win' : 'loss';
  const mO = rec.match(/^Más de (\d+[.,]?\d*)(?:\s*goles)?$/i);
  if (mO) {
    const line = parseFloat(mO[1].replace(',','.'));
    return total > line ? 'win' : 'loss';
  }
  const mU = rec.match(/^Menos de (\d+[.,]?\d*)(?:\s*goles)?$/i);
  if (mU) {
    const line = parseFloat(mU[1].replace(',','.'));
    return total < line ? 'win' : 'loss';
  }
  const mG = rec.match(/^Gana\s+(.+)$/i);
  if (mG) {
    const team = mG[1].trim();
    if (teamsMatch(team, pick.home)) return homeWin ? 'win' : 'loss';
    if (teamsMatch(team, pick.away)) return awayWin ? 'win' : 'loss';
  }
  if (/(corner|hándicap|handicap)/i.test(rec) || /^Apuesta a [+\-]?\d/.test(rec)) {
    return 'void';
  }
  return null; // no resoluble → dejar pending
}

// Fetch del historial admin desde acoin_users
async function fetchAdminHistorial(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no configurado');
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/acoin_users?email=eq.${encodeURIComponent(ADMIN_EMAIL)}&select=historial_full`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!r.ok) throw new Error(`Supabase fetch ${r.status}`);
  const rows = await r.json();
  return Array.isArray(rows?.[0]?.historial_full) ? rows[0].historial_full : [];
}

// Upsert el historial admin actualizado
async function saveAdminHistorial(env, hist) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY no configurado (necesario para escribir)');
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/acoin_users?email=eq.${encodeURIComponent(ADMIN_EMAIL)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        historial_full: hist.slice(-1000000),  // destopado: contar picks reales (era -500)
        updated_at: new Date().toISOString(),
      }),
    }
  );
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Supabase update ${r.status}: ${t}`);
  }
}

// Función principal del cron: revisa picks pendientes y los resuelve


// ── 🆕 (31-may-2026) Cron: chequeo de escudos faltantes ─────────────────────
// Migra la tarea Cowork 'chequeo-escudos-gambeta'. Detecta equipos nuevos
// en picks pendientes que NO tienen escudo en el repo local. Para cada
// equipo NO ambiguo, busca el logo en API-Football y lo almacena en KV.
// Cron '0 0,12 * * *' (cada 12h). Endpoint /escudos-discovered devuelve
// el map para que el frontend pueda usar como fallback (lookup runtime).
//
// NOTA: NO hace commit al repo. Eso queda como tarea manual de Mauro:
// cuando KV tiene N equipos descubiertos, los baja a /escudos/ y comitea.

// Nombres ambiguos que NUNCA autodescubrimos (varios clubes con mismo nombre)
const AMBIGUOUS_NAMES = new Set([
  'nacional', 'universitario', 'independiente', 'san lorenzo', 'america',
  'cerro', 'olimpia', 'universidad', 'atletico', 'racing', 'river',
  'river plate', 'sporting', 'deportivo'
]);

function isAmbiguous(name) {
  const n = (name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (AMBIGUOUS_NAMES.has(n)) return true;
  // Single-word ambiguous variants
  const words = n.split(/\s+/);
  if (words.length === 1 && AMBIGUOUS_NAMES.has(words[0])) return true;
  return false;
}

async function fetchTeamLogo(teamName, env) {
  try {
    const q = encodeURIComponent(teamName);
    const r = await apf(`/teams?search=${q}`, env);
    const teams = r.response || [];
    if (!teams.length) return null;
    // Tomar el primer match (API-Football ordena por relevancia)
    const t = teams[0];
    return {
      teamId: t.team?.id,
      teamName: t.team?.name,
      country: t.team?.country,
      logoUrl: t.team?.logo
    };
  } catch (e) {
    return null;
  }
}

async function runEscudosChecker(env) {
  const stats = { teamsFromPicks: 0, alreadyKnown: 0, newDiscovered: 0, skippedAmbiguous: 0, notFoundInAPF: 0, errors: 0, log: [] };
  try {
    // 1. Lee historial admin (Supabase service or anon)
    const hist = await fetchAdminHistorial(env);
    if (!hist.length) { stats.log.push('historial vacío'); return stats; }

    // 2. Extrae equipos únicos de picks pendientes (próximos 7 días)
    const now = Date.now();
    const SEVEN_D = 7 * 24 * 3600 * 1000;
    const teamSet = new Set();
    for (const p of hist) {
      if (p.result && p.result !== 'pending') continue;
      if (p.commenceTs && (p.commenceTs - now) > SEVEN_D) continue;
      if (p.home) teamSet.add(p.home);
      if (p.away) teamSet.add(p.away);
    }
    stats.teamsFromPicks = teamSet.size;
    if (!teamSet.size) { stats.log.push('sin equipos en picks recientes'); return stats; }

    // 3. Lee KV con equipos ya conocidos
    const knownRaw = await env.CACHE_KV.get('escudos_known_v1');
    const known = knownRaw ? new Set(JSON.parse(knownRaw)) : new Set();
    const discoveredRaw = await env.CACHE_KV.get('escudos_discovered_v1');
    const discovered = discoveredRaw ? JSON.parse(discoveredRaw) : {};

    // 4. Para cada equipo nuevo: validar con API-Football
    const newOnes = [];
    for (const teamName of teamSet) {
      if (known.has(teamName) || discovered[teamName]) {
        stats.alreadyKnown++;
        continue;
      }
      if (isAmbiguous(teamName)) {
        stats.skippedAmbiguous++;
        stats.log.push(`ambiguous (skip): ${teamName}`);
        continue;
      }
      const teamInfo = await fetchTeamLogo(teamName, env);
      if (!teamInfo || !teamInfo.logoUrl) {
        stats.notFoundInAPF++;
        stats.log.push(`not found in APF: ${teamName}`);
        continue;
      }
      discovered[teamName] = {
        url: teamInfo.logoUrl,
        teamId: teamInfo.teamId,
        country: teamInfo.country,
        discoveredAt: new Date().toISOString()
      };
      newOnes.push(teamName);
      stats.newDiscovered++;
    }

    if (newOnes.length) {
      await env.CACHE_KV.put('escudos_discovered_v1', JSON.stringify(discovered));
      stats.log.push(`new: ${newOnes.join(', ')}`);
    }
  } catch (e) {
    stats.errors++;
    stats.log.push(`fatal: ${e.message}`);
  }
  return stats;
}

// ── 🆕 (31-may-2026) Cron: actualizar cuotas de picks pendientes ─────────────
// Migra la tarea Cowork 'actualizar-cuotas-pronosticos'. Corre cada 6h via
// cron trigger '0 */6 * * *'. Lee picks pendientes del admin, busca cuotas
// frescas en /odds, actualiza SOLO el campo `odds` (y `oddsFrozen` para
// partidos < 2h).
//
// REGLA INVIOLABLE: solo modifica `odds` y `oddsFrozen`. Cualquier otro
// campo intacto. Si detecta modificación de campo prohibido, aborta.
const ODDS_READONLY_FIELDS = ['rec','conf','bvr','bvrText','stake','home','away','date','result','league','commenceTs'];

function _normCuota(s) { return (s || '').toLowerCase().trim(); }

function getPriceForPick(game, rec) {
  if (!game) return null;
  const recL = _normCuota(rec);

  // Más de X.X / Menos de X.X (totals)
  const overM = recL.match(/m[áa]s de\s*([\d.]+)/);
  const underM = recL.match(/menos de\s*([\d.]+)/);
  if (overM || underM) {
    const lineTarget = parseFloat((overM || underM)[1]);
    const direction = overM ? 'Over' : 'Under';
    for (const bk of (game.bookmakers || [])) {
      for (const mkt of (bk.markets || [])) {
        if (mkt.key === 'totals') {
          for (const o of (mkt.outcomes || [])) {
            if (o.name === direction && o.point != null && Math.abs(parseFloat(o.point) - lineTarget) < 0.01) {
              return parseFloat(parseFloat(o.price).toFixed(2));
            }
          }
        }
      }
    }
    return null;
  }

  // Ambos Marcan / BTTS
  if (recL.includes('ambos') || recL.includes('btts') || recL.includes('marcan')) {
    for (const bk of (game.bookmakers || [])) {
      for (const mkt of (bk.markets || [])) {
        const k = (mkt.key || '').toLowerCase();
        if (k.includes('btts') || k.includes('both')) {
          for (const o of (mkt.outcomes || [])) {
            const name = _normCuota(o.name);
            if (name === 'yes' || name === 'sí' || name === 'si') {
              return parseFloat(parseFloat(o.price).toFixed(2));
            }
          }
        }
      }
    }
    return null;
  }

  // H2H: Local / Visitante / Empate / Gana <equipo>
  let target = null;
  if (recL.includes('local') || recL === 'home') target = game.home_team;
  else if (recL.includes('visita') || recL === 'away') target = game.away_team;
  else if (recL.includes('empate') || recL.includes('draw')) target = 'Draw';
  else {
    const ganaM = recL.match(/gana\s+(.+)/);
    if (ganaM) {
      const who = ganaM[1].trim();
      if (_normCuota(game.home_team || '') === who) target = game.home_team;
      else if (_normCuota(game.away_team || '') === who) target = game.away_team;
    }
  }
  if (!target) return null;

  for (const bk of (game.bookmakers || [])) {
    for (const mkt of (bk.markets || [])) {
      if (mkt.key === 'h2h') {
        for (const o of (mkt.outcomes || [])) {
          if (_normCuota(o.name) === _normCuota(target)) {
            return parseFloat(parseFloat(o.price).toFixed(2));
          }
        }
      }
    }
  }
  return null;
}

async function runOddsUpdater(env) {
  const stats = { checked: 0, updated: 0, frozen: 0, errors: 0, log: [] };
  try {
    const hist = await fetchAdminHistorial(env);
    if (!hist.length) { stats.log.push('historial vacío'); return stats; }

    // Pull all odds (main + europe + secondary)
    const cats = ['main', 'europe', 'secondary'];
    const allOdds = [];
    for (const cat of cats) {
      try {
        const leagues = cat === 'main' ? LEAGUES_MAIN : cat === 'europe' ? LEAGUES_EUROPE : LEAGUES_SECONDARY;
        const cacheKey = `odds10_${cat}_${new Date().toISOString().slice(0, 13)}`;
        const r = await cached(env, cacheKey, 3600, () => getLeagueData(env, leagues));
        allOdds.push(...(r.data || []));
      } catch (e) {
        stats.log.push(`odds ${cat} error: ${e.message}`);
      }
    }
    if (!allOdds.length) { stats.log.push('sin odds frescas'); return stats; }

    const oddsIndex = new Map();
    for (const g of allOdds) {
      const k = `${_normCuota(g.home_team)}|${_normCuota(g.away_team)}`;
      oddsIndex.set(k, g);
    }
    function findGame(home, away) {
      const k1 = `${_normCuota(home)}|${_normCuota(away)}`;
      const k2 = `${_normCuota(away)}|${_normCuota(home)}`;
      return oddsIndex.get(k1) || oddsIndex.get(k2);
    }

    const NOW_MS = Date.now();
    const TWO_H_MS = 2 * 3600 * 1000;
    let changed = false;

    for (const pick of hist) {
      const result = (pick.result || '').toLowerCase();
      if (result && result !== 'pending') continue;
      if (pick.oddsFrozen) continue;

      // 🛡️ (25-jun-2026) Skip picks WC2026: las cuotas vienen del repo wc-matches.js
      // (cuotas DBbet curadas a mano). Odds API es promedio de bookies UE/UK y NO
      // refleja DBbet — pisaba rec, _hO, _dO, _aO y rompía picks (ej Egipto-Irán).
      // Cuando tengamos API DBbet, sacar este skip y poblar desde DBbet feed.
      if (pick._sportKey === 'soccer_fifa_world_cup' || pick._wcMatch === true || pick._wcFuture === true) {
        continue;
      }

      stats.checked++;

      // Freeze odds if match starts in < 2h
      if (pick.commenceTs && (pick.commenceTs - NOW_MS) <= TWO_H_MS) {
        pick.oddsFrozen = true;
        stats.frozen++;
        changed = true;
        continue;
      }

      const game = findGame(pick.home, pick.away);
      const price = getPriceForPick(game, pick.rec);
      if (price == null || price === pick.odds) continue;

      // Safety check: snapshot read-only fields
      const before = {};
      for (const f of ODDS_READONLY_FIELDS) before[f] = pick[f];

      pick.odds = price;

      // Verify nothing else changed
      for (const f of ODDS_READONLY_FIELDS) {
        if (pick[f] !== before[f]) {
          stats.log.push(`ERROR: field '${f}' modified on ${pick.home} vs ${pick.away}, aborting`);
          stats.errors++;
          return stats;
        }
      }
      stats.updated++;
      changed = true;
    }

    if (changed) {
      await saveAdminHistorial(env, hist);
      stats.log.push(`saved: ${stats.updated} updated, ${stats.frozen} frozen`);
    } else {
      stats.log.push('no changes');
    }
  } catch (e) {
    stats.errors++;
    stats.log.push(`fatal: ${e.message}`);
  }
  return stats;
}


// ── 🆕 (31-may-2026) API-Football fallback para resolver scores ──────────────
// El resolver actual usa ESPN + TheSportsDB. Falla en ligas chicas (Eliteserien,
// Segunda B España, etc). Agregamos APF PRO como último fallback antes de skip.
function _getApfLeagueIdForSportKey(sportKey) {
  const all = [...LEAGUES_MAIN, ...LEAGUES_EUROPE, ...LEAGUES_SECONDARY];
  const entry = all.find(([k]) => k === sportKey);
  return entry ? entry[1] : null;
}

// ── 🆕 (13-jul-2026) PICK INTEL: bajas + H2H + forma REALES desde API-Football ──
// Alimenta la decisión del motor y el "Razonamiento de la IA" del frontend.
// Cacheado agresivamente en KV para cuidar el cupo diario de APF.
function _apfSeasonFor(leagueId, dt) {
  const year = dt.getUTCFullYear();
  const month = dt.getUTCMonth();
  const euroIds = new Set([39,40,140,141,135,136,78,79,61,62,88,94,203,2,3,848,235,144,207,218,106,345,197]);
  return euroIds.has(leagueId) ? (month >= 7 ? year : year - 1) : year;
}

// ── 🆕 (18-jul-2026) VALOR DE PLANTEL vía Transfermarkt (best-effort) ──
// "Neuronita" de poder económico: cuánto vale cada plantel según TM.
// Si TM no responde o cambia el HTML devuelve null y el intel sigue sin este dato.
const TM_BASE = 'https://www.transfermarkt.com';
const TM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml',
};

function _tmParseVal(s) {
  // "€41.85m" | "€1.05bn" | "€850k" | "€850th." → millones de EUR (Number) o null
  const m = String(s || '').replace(/\s/g, '').match(/€([\d.,]+)(bn|m|k|th\.?)/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  if (isNaN(n)) return null;
  const u = m[2].toLowerCase();
  return u === 'bn' ? n * 1000 : (u === 'k' || u.startsWith('th')) ? n / 1000 : n;
}

// Variantes de búsqueda para nombres abreviados/con tilde que TM no encuentra:
// "Ind. Medellín" → ["Ind. Medellín", "Ind. Medellin", "Independiente Medellin", "Medellin"]
function _tmQueryVariants(name) {
  const base = String(name || '').trim();
  const noDia = base.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const expanded = noDia
    .replace(/\bInd\.?\s+/i, 'Independiente ')
    .replace(/\bAtl\.?\s+/i, 'Atletico ')
    .replace(/\bDep\.?\s+/i, 'Deportivo ')
    .replace(/\bUniv\.?\s+/i, 'Universidad ')
    .replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
  const words = expanded.split(' ').filter(w => w.length >= 4 && !/^(club|city|united|town)$/i.test(w));
  const longest = words.sort((a, b) => b.length - a.length)[0] || expanded;
  return [...new Set([base, noDia, expanded, longest])].slice(0, 3);
}

// Elegir el club correcto entre los resultados de búsqueda: el slug tiene que
// parecerse al nombre buscado (evita agarrar el primer verein random de la página).
function _tmPickClub(sh, name) {
  const nn = normTeam(name);
  const re = /href="\/([a-z0-9\-]+)\/startseite\/verein\/(\d+)/gi;
  let m, first = null, best = null;
  while ((m = re.exec(sh))) {
    if (!first) first = m;
    const slug = m[1].replace(/-/g, '');
    if (!best && nn && (slug.includes(nn) || nn.includes(slug))) best = m;
  }
  return best || first;
}

async function _tmTeamValue(name, env) {
  // caché KV 7 días (los valores cambian poco); errores devuelven null y NO se cachean
  return cached(env, 'tmval_v2_' + normTeam(name), 7 * 24 * 3600, async () => {
    try {
      // 🆕 (18-jul) Probar variantes: nombre tal cual, sin tildes, abreviaturas expandidas
      let m = null, qUsed = null;
      for (const qv of _tmQueryVariants(name)) {
        const sr = await fetch(TM_BASE + '/schnellsuche/ergebnis/schnellsuche?query=' + encodeURIComponent(qv), { headers: TM_HEADERS });
        if (!sr.ok) continue;
        const sh = await sr.text();
        m = _tmPickClub(sh, qv);
        if (m) { qUsed = qv; break; }
      }
      if (!m) return null;
      const cr = await fetch(TM_BASE + '/' + m[1] + '/startseite/verein/' + m[2], { headers: TM_HEADERS });
      if (!cr.ok) return null;
      const ch = await cr.text();
      let val = null;
      // El valor viene partido por tags: <span>€</span>36.20<span>m</span> → strip tags y parsear
      const vm = ch.match(/data-header__market-value-wrapper[\s\S]{0,500}?<\/a>/i);
      if (vm) val = _tmParseVal(vm[0].replace(/<[^>]*>/g, ''));
      if (val == null) {
        const ti = ch.search(/otal market value/i);
        if (ti > 0) val = _tmParseVal(ch.slice(Math.max(0, ti - 400), ti + 100).replace(/<[^>]*>/g, ''));
      }
      if (val == null) return null;
      return { name, tmId: m[2], valM: Math.round(val * 100) / 100, _q: qUsed };
    } catch (_) { return null; }
  });
}

async function fetchSquadValues(homeNm, awayNm, env) {
  // Secuencial a propósito (2 requests suaves a TM, no en paralelo)
  const svH = await _tmTeamValue(homeNm, env).catch(() => null);
  const svA = await _tmTeamValue(awayNm, env).catch(() => null);
  if (!svH || !svH.valM || !svA || !svA.valM) return null;
  return { home: svH.valM, away: svA.valM, ratio: Math.round((svH.valM / svA.valM) * 100) / 100, _src: 'tm' };
}

async function fetchPickIntel(q, env) {
  const leagueId = _getApfLeagueIdForSportKey(q.sportKey);
  if (!leagueId) return { error: 'league-not-mapped' };
  const dt = q.ts ? new Date(Number(q.ts)) : new Date();
  const season = _apfSeasonFor(leagueId, dt);
  const dateStr = dt.toISOString().slice(0, 10);

  // 1) Fixture del día (cacheado 3h por liga+fecha — compartido entre picks de la misma liga)
  const fxData = await cached(env, `apx3_fx_${leagueId}_${dateStr}`, 3 * 3600,
    () => apf(`/fixtures?league=${leagueId}&season=${season}&date=${dateStr}`, env));
  const fixtures = fxData?.response || [];
  let fx = null;
  for (const f of fixtures) {
    const fh = f.teams?.home?.name || '', fa = f.teams?.away?.name || '';
    if ((teamsMatch(fh, q.home) && teamsMatch(fa, q.away)) ||
        (teamsMatch(fh, q.away) && teamsMatch(fa, q.home))) { fx = f; break; }
  }
  // Fallback: buscar en los próximos fixtures de la liga (kickoff en otra fecha UTC)
  if (!fx) {
    const fxNext = await cached(env, `apx3_fxnext_${leagueId}`, 3 * 3600,
      () => apf(`/fixtures?league=${leagueId}&season=${season}&next=30`, env));
    for (const f of (fxNext?.response || [])) {
      const fh = f.teams?.home?.name || '', fa = f.teams?.away?.name || '';
      if ((teamsMatch(fh, q.home) && teamsMatch(fa, q.away)) ||
          (teamsMatch(fh, q.away) && teamsMatch(fa, q.home))) { fx = f; break; }
    }
  }
  if (!fx) {
    if (q.debug) {
      const fxNext2 = await cached(env, `apx3_fxnext_${leagueId}`, 3 * 3600,
        () => apf(`/fixtures?league=${leagueId}&season=${season}&next=30`, env)).catch(e => ({ _err: String(e) }));
      // raw APF sin wrapper para ver errors/results
      let raw = null;
      try {
        const key = env.API_FOOTBALL_KEY;
        const rr = await fetch(`${API_FOOTBALL_BASE}/fixtures?league=${leagueId}&season=${season}&next=5`, { headers: { 'x-apisports-key': key } });
        const jj = await rr.json();
        raw = { status: rr.status, errors: jj.errors || null, results: jj.results, paging: jj.paging || null, sample: (jj.response || []).slice(0,3).map(f => (f.teams?.home?.name||'?') + ' vs ' + (f.teams?.away?.name||'?')) };
      } catch(e) { raw = { fetchErr: String(e) }; }
      return { error: 'fixture-not-found', debug: { leagueId, season, dateStr,
        dayCount: fixtures.length,
        nextCount: (fxNext2 && fxNext2.response || []).length,
        nextErr: fxNext2 && fxNext2._err || null,
        raw } };
    }
    return { error: 'fixture-not-found' };
  }

  const fxId    = fx.fixture?.id;
  const homeId  = fx.teams?.home?.id, awayId = fx.teams?.away?.id;
  const homeNm  = fx.teams?.home?.name, awayNm = fx.teams?.away?.name;
  if (!homeId || !awayId) return { error: 'teams-not-found' };

  // 2) En paralelo: lesiones del fixture + H2H últimos 10 + forma últimos 5 de cada uno
  // 🆕 Secuencial (no Promise.all): el plan de APF limita requests POR MINUTO.
  const injData = await cached(env, `apx3_inj_${fxId}`, 3 * 3600, () => apf(`/injuries?fixture=${fxId}`, env)).catch(() => null);
  const h2hData = await cached(env, `apx3_h2h_${Math.min(homeId,awayId)}_${Math.max(homeId,awayId)}`, 24 * 3600,
    () => apf(`/fixtures/headtohead?h2h=${homeId}-${awayId}&last=10&status=FT`, env)).catch(() => null);
  const formHData = await cached(env, `apx4_form_${homeId}`, 6 * 3600, () => apf(`/fixtures?team=${homeId}&last=7`, env)).catch(() => null);
  const formAData = await cached(env, `apx4_form_${awayId}`, 6 * 3600, () => apf(`/fixtures?team=${awayId}&last=7`, env)).catch(() => null);

  // Lesiones: agrupar por equipo, solo tipos que restan (Missing Fixture / Questionable)
  const injuries = { home: { count: 0, players: [] }, away: { count: 0, players: [] } };
  for (const it of (injData?.response || [])) {
    const side = it.team?.id === homeId ? 'home' : it.team?.id === awayId ? 'away' : null;
    if (!side) continue;
    injuries[side].count++;
    if (injuries[side].players.length < 5) {
      injuries[side].players.push({ name: it.player?.name || '?', reason: it.player?.reason || '' });
    }
  }

  // H2H desde la perspectiva del local ACTUAL: total y "el local jugando en casa"
  const h2h = { n: 0, homeW: 0, draw: 0, awayW: 0, homeAtHome: { n: 0, w: 0, d: 0, l: 0 }, last: [] };
  for (const f of (h2hData?.response || [])) {
    const gh = f.goals?.home, ga = f.goals?.away;
    if (gh == null || ga == null) continue;
    const fHomeId = f.teams?.home?.id;
    const homeWasLocal = fHomeId === homeId;
    h2h.n++;
    const localWin = gh > ga, visitWin = ga > gh;
    if ((homeWasLocal && localWin) || (!homeWasLocal && visitWin)) h2h.homeW++;
    else if (gh === ga) h2h.draw++;
    else h2h.awayW++;
    if (homeWasLocal) {
      h2h.homeAtHome.n++;
      if (localWin) h2h.homeAtHome.w++; else if (gh === ga) h2h.homeAtHome.d++; else h2h.homeAtHome.l++;
    }
    if (h2h.last.length < 5) {
      h2h.last.push({ date: (f.fixture?.date || '').slice(0, 10), home: f.teams?.home?.name, away: f.teams?.away?.name, score: gh + '-' + ga });
    }
  }

  // Forma: string tipo "WDLWW" (más reciente primero) desde la perspectiva de cada equipo
  function formOf(data, teamId) {
    const out = [];
    for (const f of (data?.response || [])) {
      const gh = f.goals?.home, ga = f.goals?.away;
      if (gh == null || ga == null) continue;
      const isHome = f.teams?.home?.id === teamId;
      const gf = isHome ? gh : ga, gc = isHome ? ga : gh;
      out.push(gf > gc ? 'W' : gf === gc ? 'D' : 'L');
    }
    return out.slice(0, 5).join('');
  }

  // 🆕 (18-jul) Valor de plantel (Transfermarkt, best-effort — nunca bloquea el intel)
  const squadValue = await fetchSquadValues(homeNm, awayNm, env).catch(() => null);

  return {
    fixtureId: fxId,
    teams: { home: homeNm, away: awayNm },
    kickoff: fx.fixture?.date || null,
    injuries,
    h2h,
    form: { home: formOf(formHData, homeId), away: formOf(formAData, awayId) },
    squadValue,
    _src: 'apf',
  };
}

// ── 🆕 (13-jul) PICK INTEL vía TheSportsDB — fallback gratis cuando APF no tiene la temporada.
// Da H2H + forma reales. Lesiones: solo con APF pago.
async function fetchPickIntelTsdb(q, env) {
  const slug = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
  async function tsdbJson(path) {
    const r = await fetch(`${TSDB_BASE}/${path}`);
    if (!r.ok) throw new Error('TSDB ' + r.status);
    return r.json();
  }
  // 1) H2H: searchevents devuelve el historial completo del cruce
  const evs = [];
  for (const qq of [`${slug(q.home)}_vs_${slug(q.away)}`, `${slug(q.away)}_vs_${slug(q.home)}`]) {
    try {
      const j = await cached(env, `tsx_h2h_${qq}`, 24 * 3600, () => tsdbJson(`searchevents.php?e=${qq}`));
      const list = (j && (j.event || j.events)) || [];
      for (const e of list) if (e && e.intHomeScore != null && e.intAwayScore != null) evs.push(e);
    } catch(_) {}
  }
  evs.sort((a, b) => String(b.dateEvent || '').localeCompare(String(a.dateEvent || '')));
  const h2h = { n: 0, homeW: 0, draw: 0, awayW: 0, homeAtHome: { n: 0, w: 0, d: 0, l: 0 }, last: [] };
  const _isHomeTeam = nm => teamsMatch(nm, q.home);
  for (const e of evs.slice(0, 10)) {
    const gh = Number(e.intHomeScore), ga = Number(e.intAwayScore);
    const homeWasLocal = _isHomeTeam(e.strHomeTeam || '');
    h2h.n++;
    const localWin = gh > ga, visitWin = ga > gh;
    if ((homeWasLocal && localWin) || (!homeWasLocal && visitWin)) h2h.homeW++;
    else if (gh === ga) h2h.draw++;
    else h2h.awayW++;
    if (homeWasLocal) {
      h2h.homeAtHome.n++;
      if (localWin) h2h.homeAtHome.w++; else if (gh === ga) h2h.homeAtHome.d++; else h2h.homeAtHome.l++;
    }
    if (h2h.last.length < 5) h2h.last.push({ date: e.dateEvent || '', home: e.strHomeTeam, away: e.strAwayTeam, score: gh + '-' + ga });
  }
  // 2) Forma: searchteams → idTeam → eventslast (últimos 5)
  async function formOf(name) {
    try {
      const t = await cached(env, `tsx_team_${slug(name)}`, 7 * 24 * 3600, () => tsdbJson(`searchteams.php?t=${slug(name).replace(/_/g, '%20')}`));
      const team = ((t && t.teams) || []).find(x => x && x.strSport === 'Soccer' && teamsMatch(x.strTeam, name));
      if (!team) return '';
      const le = await cached(env, `tsx_last_${team.idTeam}`, 6 * 3600, () => tsdbJson(`eventslast.php?id=${team.idTeam}`));
      const out = [];
      for (const e of ((le && le.results) || [])) {
        if (e.intHomeScore == null || e.intAwayScore == null) continue;
        const isHome = teamsMatch(e.strHomeTeam || '', name);
        const gf = Number(isHome ? e.intHomeScore : e.intAwayScore);
        const gc = Number(isHome ? e.intAwayScore : e.intHomeScore);
        out.push(gf > gc ? 'W' : gf === gc ? 'D' : 'L');
      }
      return out.slice(0, 5).join('');
    } catch(_) { return ''; }
  }
  const formHome = await formOf(q.home);
  const formAway = await formOf(q.away);
  if (!h2h.n && !formHome && !formAway) return { error: 'no-data-tsdb' };
  // 🆕 (18-jul) Valor de plantel también en el fallback TSDB
  const squadValue = await fetchSquadValues(q.home, q.away, env).catch(() => null);
  return {
    teams: { home: q.home, away: q.away },
    injuries: { home: { count: 0, players: [] }, away: { count: 0, players: [] } },
    injuriesUnavailable: true, // APF free: sin data de lesiones
    h2h,
    form: { home: formHome, away: formAway },
    squadValue,
    _src: 'tsdb',
  };
}

async function fetchApfScore(pick, env) {
  if (!pick._sportKey || !pick.commenceTs) return null;
  const leagueId = _getApfLeagueIdForSportKey(pick._sportKey);
  if (!leagueId) return null;
  // APF season number: para ligas europeas (jun-mayo) = año de inicio.
  // Para liga argentina/brasil = año calendario.
  const dt = new Date(pick.commenceTs);
  const year = dt.getUTCFullYear();
  const month = dt.getUTCMonth(); // 0-11
  let season;
  // Euro leagues: season starts in Aug (month 7)
  // Ligas con calendario europeo (agosto-mayo):
  // Premier(39), Championship(40), La Liga(140), Segunda(141), Serie A(135),
  // Serie B(136), Bundesliga(78), 2.Bundes(79), Ligue 1(61), Ligue 2(62),
  // Eredivisie(88), Primeira Liga(94), Süper Lig(203), UCL(2), UEL(3),
  // Conf League(848), RPL(235), Belgian Pro(144), Swiss(207), Austrian(218),
  // Polish(106), Czech(345), Greek(197)
  const euroLeagueIds = new Set([39,40,140,141,135,136,78,79,61,62,88,94,203,2,3,848,235,144,207,218,106,345,197]);
  // Resto (Noruega Eliteserien 103, Suecia 113, Dinamarca 119, MLS 253,
  // K-League 292, Conmebol, Liga Arg 128, Brasileirão 71, Mexico 262,
  // Colombia 239, Chile 265, Uruguay 268, Ecuador 240, Argentina B 131,
  // etc) = calendar year
  if (euroLeagueIds.has(leagueId)) {
    // si estamos en ago-dic => season es year. Si estamos en ene-jul => season es year-1.
    season = month >= 7 ? year : year - 1;
  } else {
    // Calendar year (Conmebol, Argentina, Brasil, MLS, etc)
    season = year;
  }
  const dateStr = dt.toISOString().slice(0, 10);
  try {
    const r = await apf(`/fixtures?league=${leagueId}&season=${season}&date=${dateStr}`, env);
    const fixtures = r.response || [];
    if (!fixtures.length) return null;
    // Find matching fixture by team names
    const nHome = normTeam(pick.home), nAway = normTeam(pick.away);
    for (const fx of fixtures) {
      const fxHome = fx.teams?.home?.name || '';
      const fxAway = fx.teams?.away?.name || '';
      const directMatch  = teamsMatch(fxHome, pick.home) && teamsMatch(fxAway, pick.away);
      const swappedMatch = teamsMatch(fxHome, pick.away) && teamsMatch(fxAway, pick.home);
      if (directMatch || swappedMatch) {
        const status = fx.fixture?.status?.short || '';
        const finished = ['FT', 'AET', 'PEN'].includes(status);
        const voidLike = ['PST', 'CANC', 'ABD', 'AWD'].includes(status);
        if (voidLike) {
          return { home: pick.home, away: pick.away, voidReason: status, src: 'apf' };
        }
        if (!finished) return null;
        const goalsH = fx.goals?.home;
        const goalsA = fx.goals?.away;
        if (goalsH == null || goalsA == null) return null;
        // 🛡️ Si los equipos vienen al reves en APF respecto al pick, invertir scores
        // para que scoreH siempre corresponda a pick.home (lo que la rec espera).
        const sH = swappedMatch ? parseInt(goalsA) : parseInt(goalsH);
        const sA = swappedMatch ? parseInt(goalsH) : parseInt(goalsA);
        return {
          home: pick.home,
          away: pick.away,
          scoreH: sH,
          scoreA: sA,
          src: 'apf'
        };
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}


// ══════════════════════════════════════════════════════════════════════
// 🆕 (1-jul-2026 #637) UNIFIED PICKS PIPELINE
// runScheduledResolver antes solo leía acoin_users.historial_full. Los
// picks WC auto-generados (_autoGenerated:true) viven en shared_cache
// key=global_historial_v1 y NO se resolvian solos — quedaban pending
// para siempre. Estos helpers unifican el pipeline.
// ══════════════════════════════════════════════════════════════════════

async function fetchAllPicks(env) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  if (!key) return [];
  // 1) acoin_users.historial_full (picks manuales)
  let adminPicks = [];
  try {
    adminPicks = await fetchAdminHistorial(env) || [];
  } catch(_) {}
  adminPicks = adminPicks.map(p => ({ ...p, _source: 'admin' }));
  // 2) global_historial_v1 (picks auto-generados WC)
  let globalPicks = [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/shared_cache?key=eq.global_historial_v1&select=data`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (r.ok) {
      const rows = await r.json();
      const data = rows[0]?.data;
      const arr = Array.isArray(data) ? data : (data?.picks || []);
      globalPicks = arr.map(p => ({ ...p, _source: 'global_v1' }));
    }
  } catch(_) {}
  // Merge: si el mismo id aparece en ambos, admin gana (el admin es la source of truth)
  const adminIds = new Set(adminPicks.map(p => p.id));
  const merged = [...adminPicks, ...globalPicks.filter(p => !adminIds.has(p.id))];
  return merged;
}

async function saveResolvedPick(env, updatedPick, allPicks) {
  const source = updatedPick._source;
  const skey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!skey) return false;
  const clean = { ...updatedPick };
  delete clean._source;
  if (source === 'admin') {
    // Rewrite acoin_users.historial_full
    const adminPicks = allPicks.filter(p => p._source === 'admin').map(p => {
      const c = { ...p }; delete c._source;
      return c.id === clean.id ? clean : c;
    });
    try { await saveAdminHistorial(env, adminPicks); return true; } catch(_) { return false; }
  } else if (source === 'global_v1') {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/shared_cache?key=eq.global_historial_v1&select=data`, {
        headers: { apikey: skey, Authorization: `Bearer ${skey}` }
      });
      const rows = await r.json();
      if (!rows || !rows[0]) return false;
      const data = rows[0].data;
      const arr = Array.isArray(data) ? data : (data?.picks || []);
      const idx = arr.findIndex(p => p.id === clean.id);
      if (idx < 0) return false;
      arr[idx] = clean;
      const newData = Array.isArray(data) ? arr : { ...data, picks: arr };
      const patch = await fetch(`${SUPABASE_URL}/rest/v1/shared_cache?key=eq.global_historial_v1`, {
        method: 'PATCH',
        headers: { apikey: skey, Authorization: `Bearer ${skey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ data: newData }),
      });
      return patch.ok;
    } catch(_) { return false; }
  }
  return false;
}

async function runScheduledResolver(env) {
  const stats = { checked: 0, resolved: 0, espn: 0, tsdb: 0, apf: 0, errors: 0, log: [], sources: { admin: 0, global_v1: 0 } };
  try {
    // 🆕 (1-jul-2026 #637) Leer AMBAS fuentes (admin + global_v1) para que los
    // picks WC auto-generados se resuelvan solos por el cron.
    const hist = await fetchAllPicks(env);
    if (!hist.length) {
      stats.log.push('historial vacío');
      return stats;
    }
    // trackear source counts
    for (const p of hist) stats.sources[p._source || 'unknown'] = (stats.sources[p._source || 'unknown'] || 0) + 1;

    const now = Date.now();
    // 🆕 (29-jun-2026 #573) Bajado a 90 min para resolver picks ni bien terminan.
    // Antes 2h causaba que picks recién terminados esperaran 1h+ extra.
    const NINETY_MIN = 90 * 60 * 1000;
    const TWENTY_ONE_D = 21 * 24 * 3600 * 1000;

    // Picks resolvables: pendientes + "a medio resolver" — picks con result
    // win/loss pero sin marcador o con P/L en 0. El resolver los re-procesa y
    // los deja consistentes (result + finalScore + pl), auto-sanando ese estado roto.
    const pending = hist.filter(p => {
      // Skip apuestas de futuro WC2026 — se resuelven manual
      if (p._wcFuture) return false;
      if (!p.commenceTs) return false;
      const age = now - p.commenceTs;
      if (age < NINETY_MIN || age > TWENTY_ONE_D) return false;
      const halfResolved = (p.result === 'win' || p.result === 'loss')
        && (!p.finalScore || p.pl === 0);
      return p.result === 'pending' || halfResolved;
    });
    stats.checked = pending.length;
    if (!pending.length) {
      stats.log.push('sin picks pendientes resolvables');
      return stats;
    }

    // Agrupar por liga × fecha para minimizar requests ESPN
    const espnCalls = new Map();  // key = "leagueCode_YYYYMMDD" → Promise<scores[]>
    function getEspnScores(leagueCode, ts) {
      const dateStr = new Date(ts).toISOString().slice(0,10).replace(/-/g,'');
      const key = `${leagueCode}_${dateStr}`;
      if (!espnCalls.has(key)) espnCalls.set(key, fetchEspnScoreboard(leagueCode, dateStr));
      return espnCalls.get(key);
    }

    let changed = false;
    for (const pick of pending) {
      try {
        let matched = null;

        // Override manual primero — para picks que el auto-resolver no matchea
        const _mk = normTeam(pick.home) + '|' + normTeam(pick.away);
        if (MANUAL_SCORES[_mk]) {
          const ms = MANUAL_SCORES[_mk];
          matched = { home: pick.home, away: pick.away,
                      scoreH: ms.h, scoreA: ms.a, src: 'manual' };
        }

        // Si la liga es ESPN-supported, intentar ESPN
        const espnId = SPORT_TO_ESPN_RESOLVER[pick._sportKey || ''];
        if (!matched && espnId && !TSDB_ONLY_LEAGUES.has(pick._sportKey)) {
          // Probar el día del kick-off y el día siguiente (timezones)
          for (const dayOffset of [0, 1, -1]) {
            const scores = await getEspnScores(espnId, pick.commenceTs + dayOffset * 86400000);
            matched = scores.find(s => teamsMatch(s.home, pick.home) && teamsMatch(s.away, pick.away));
            if (matched) break;
          }
          if (matched) stats.espn++;
        }

        // Fallback: TheSportsDB searchevents
        if (!matched) {
          const tsdbScore = await fetchTsdbEvent(pick.home, pick.away);
          if (tsdbScore) {
            // Verificar que el TS está cerca (±5 días)
            if (!pick.commenceTs || !tsdbScore.commenceTs ||
                Math.abs(pick.commenceTs - tsdbScore.commenceTs) < 5 * 24 * 3600 * 1000) {
              matched = tsdbScore;
              stats.tsdb++;
            }
          }
        }

        // Fallback 2: TSDB por league+date (más robusto cuando los nombres no matchean exacto)
        if (!matched) {
          const tsdbLid = SPORT_TO_TSDB_LEAGUE[pick._sportKey || ''];
          if (tsdbLid) {
            const tsdbScore2 = await fetchTsdbByLeagueDate(tsdbLid, pick.commenceTs, pick.home, pick.away);
            if (tsdbScore2) {
              matched = tsdbScore2;
              stats.tsdb++;
            }
          }
        }

        // 🆕 Fallback 3: API-Football PRO — cubre ligas que ESPN/TSDB no tienen
        if (!matched) {
          const apfMatch = await fetchApfScore(pick, env);
          if (apfMatch) {
            matched = apfMatch;
            stats.apf = (stats.apf || 0) + 1;
          }
        }

        // 🆕 (31-may-2026) Auto-void: si el pick lleva >14 días pending y NO
        // pudimos resolverlo con ninguna fuente, y además los equipos son de
        // reserva/no-resolvable, marcamos como 'void' (cuota devuelta).
        // Esto limpia el historial de picks que nunca se van a resolver.
        if (!matched && pick.commenceTs && (now - pick.commenceTs) > 14 * 24 * 3600 * 1000) {
          if (isReserveTeam(pick.home) || isReserveTeam(pick.away)) {
            pick.result = 'void';
        pick._justResolved = true;
            pick.finalScore = '';
            pick.pl = 0;
            stats.resolved++;
            stats.log.push(`${pick.home} vs ${pick.away}: VOID (equipo reserva/sin cobertura)`);
            changed = true;
          }
          continue;
        }
        if (!matched) continue;

        let result, finalScoreStr;
        if (matched.voidReason) {
          // Partido abandonado/pospuesto/cancelado → void (stake devuelta)
          result = 'void';
          finalScoreStr = matched.voidReason;
        } else {
          result = calcResult(pick, matched);
          if (!result) continue;
          finalScoreStr = `${matched.scoreH}-${matched.scoreA}`;
        }

        pick.result = result;
        pick._justResolved = true;
        pick.finalScore = finalScoreStr;
        pick.pl = result === 'win'
          ? parseFloat(((pick.odds - 1) * pick.stake).toFixed(2))
          : result === 'loss' ? -pick.stake : 0;
        pick.resolvedAt = Date.now();
        pick._resolvedBy = `cron-${matched.src}`;
        stats.resolved++;
        stats.log.push(`${pick.home} vs ${pick.away}: ${finalScoreStr} → ${result}`);
        changed = true;
      } catch (e) {
        stats.errors++;
        stats.log.push(`error en ${pick.home} vs ${pick.away}: ${e.message}`);
      }
    }

    if (changed) {
      let savedAdmin = 0, savedGlobal = 0;
      for (const p of hist) {
        if (!p._justResolved) continue;
        const ok = await saveResolvedPick(env, p, hist);
        if (ok && p._source === 'admin') savedAdmin++;
        else if (ok && p._source === 'global_v1') savedGlobal++;
        delete p._justResolved;
      }
      stats.log.push(`resueltos: ${stats.resolved} · guardados admin=${savedAdmin} global_v1=${savedGlobal}`);
    }
  } catch (e) {
    stats.errors++;
    stats.log.push(`fatal: ${e.message}`);
  }
  return stats;
}

// ── Router principal ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 🏆 WC2026 Futures Publisher
// Inserta los 10 outright picks en historial_full del admin EL DÍA programado
// (WC_FUTURES_PUBLISH_TS = 6-jun-2026 03:00 UTC). Solo lo hace una vez —
// usa los IDs de los picks para detectar si ya están publicados.
// ─────────────────────────────────────────────────────────────────────────────
async function runWcFuturesPublisher(env) {
  const stats = { skip: null, published: 0, alreadyPublished: 0 };
  try {
    const now = Date.now();
    if (now < WC_FUTURES_PUBLISH_TS) {
      stats.skip = `aún no llegó la fecha de publicación (${new Date(WC_FUTURES_PUBLISH_TS).toISOString()})`;
      return stats;
    }

    const hist = await fetchAdminHistorial(env);
    if (!Array.isArray(hist)) {
      stats.skip = 'historial no disponible';
      return stats;
    }

    const existingIds = new Set(hist.map(p => p && p.id).filter(Boolean));
    const toAdd = WC_FUTURES.filter(p => !existingIds.has(p.id));

    stats.alreadyPublished = WC_FUTURES.length - toAdd.length;
    if (toAdd.length === 0) {
      stats.skip = 'los 10 picks WC2026 ya están en el historial';
      return stats;
    }

    // Insertar al inicio del historial (más nuevos primero, como el resto del feed)
    const newHist = [...toAdd, ...hist];

    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) {
      stats.skip = 'SUPABASE_SERVICE_ROLE_KEY no configurado';
      return stats;
    }
    const r = await fetch(`${SUPABASE_URL}/rest/v1/acoin_users?email=eq.${encodeURIComponent(ADMIN_EMAIL)}&select=email`, {
      method: 'PATCH',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        historial_full: newHist,
        updated_at: new Date().toISOString(),
      }),
    });

    if (!r.ok) {
      stats.skip = `PATCH HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
      return stats;
    }
    const body = await r.text();
    if (body.trim() === '[]' || !body.trim()) {
      stats.skip = 'PATCH no afectó ninguna fila';
      return stats;
    }
    stats.published = toAdd.length;
  } catch (e) {
    stats.skip = `error: ${e.message}`;
  }
  return stats;
}

// 🏆 WC2026 Matches Publisher
// Inserta los picks REGULARES por partido del Mundial en historial_full del admin.
// Solo lo hace una vez — usa los IDs de los picks para detectar si ya están publicados.
async function runWcMatchesPublisher(env) {
  const stats = { skip: null, published: 0, alreadyPublished: 0 };
  try {
    const now = Date.now();
    if (now < WC_MATCHES_PUBLISH_TS) {
      stats.skip = `aún no llegó la fecha de publicación (${new Date(WC_MATCHES_PUBLISH_TS).toISOString()})`;
      return stats;
    }
    const hist = await fetchAdminHistorial(env);
    if (!Array.isArray(hist)) {
      stats.skip = 'historial no disponible';
      return stats;
    }
    const existingIds = new Set(hist.map(p => p && p.id).filter(Boolean));
    // 🆕 (28-jun-2026 — Mauro) Cuota mínima NUEVA: 1.30. JAMÁS bajar de eso.
    //    Los ya publicados (en existingIds) quedan intactos por la condición !existingIds.has(p.id).
    const MIN_PICK_ODDS = 1.30;
    const toAdd = WC_MATCHES.filter(p => {
      if (existingIds.has(p.id)) return false;
      const o = parseFloat(p.odds);
      if (Number.isFinite(o) && o < MIN_PICK_ODDS) {
        console.warn(`[wc-publisher] SKIP ${p.id} — cuota ${o} < ${MIN_PICK_ODDS} (regla NUEVA)`);
        return false;
      }
      return true;
    });
    stats.alreadyPublished = WC_MATCHES.length - toAdd.length;
    if (toAdd.length === 0) {
      stats.skip = 'todos los WC matches ya están en el historial';
      return stats;
    }
    const newHist = [...toAdd, ...hist];
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) {
      stats.skip = 'SUPABASE_SERVICE_ROLE_KEY no configurado';
      return stats;
    }
    const r = await fetch(`${SUPABASE_URL}/rest/v1/acoin_users?email=eq.${encodeURIComponent(ADMIN_EMAIL)}&select=email`, {
      method: 'PATCH',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({
        historial_full: newHist,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!r.ok) {
      stats.skip = `PATCH HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
      return stats;
    }
    const body = await r.text();
    if (body.trim() === '[]' || !body.trim()) {
      stats.skip = 'PATCH no afectó ninguna fila';
      return stats;
    }
    stats.published = toAdd.length;
  } catch (e) {
    stats.skip = `error: ${e.message}`;
  }
  return stats;
}


// ─── 🤖 AUTO-GENERADOR DE PICKS WC2026 ───────────────────────────────────────
// Tabla de traducción EN→ES para nombres de equipos (Mundial 2026)
const TEAM_ES_MAP = {
  'Brazil': 'Brasil', 'Argentina': 'Argentina',
  'England': 'Inglaterra', 'France': 'Francia', 'Germany': 'Alemania',
  'Spain': 'España', 'Italy': 'Italia', 'Portugal': 'Portugal',
  'Netherlands': 'Países Bajos', 'Belgium': 'Bélgica',
  'Croatia': 'Croacia', 'Switzerland': 'Suiza', 'Sweden': 'Suecia',
  'Norway': 'Noruega', 'Denmark': 'Dinamarca', 'Poland': 'Polonia',
  'Czech Republic': 'República Checa', 'Austria': 'Austria',
  'Turkey': 'Turquía', 'Türkiye': 'Turquía', 'Hungary': 'Hungría',
  'Mexico': 'México', 'United States': 'Estados Unidos', 'USA': 'Estados Unidos',
  'Canada': 'Canadá', 'Costa Rica': 'Costa Rica', 'Panama': 'Panamá',
  'Honduras': 'Honduras', 'Jamaica': 'Jamaica', 'Cuba': 'Cuba',
  'Colombia': 'Colombia', 'Uruguay': 'Uruguay', 'Paraguay': 'Paraguay',
  'Peru': 'Perú', 'Ecuador': 'Ecuador', 'Chile': 'Chile', 'Bolivia': 'Bolivia',
  'Venezuela': 'Venezuela',
  'Japan': 'Japón', 'South Korea': 'Corea del Sur', 'Korea Republic': 'Corea del Sur',
  'Australia': 'Australia', 'New Zealand': 'Nueva Zelanda',
  'Iran': 'Irán', 'Iraq': 'Irak', 'Saudi Arabia': 'Arabia Saudita',
  'Qatar': 'Catar', 'United Arab Emirates': 'EAU', 'Jordan': 'Jordania',
  'Uzbekistan': 'Uzbekistán',
  'Senegal': 'Senegal', 'Morocco': 'Marruecos', 'Egypt': 'Egipto',
  'Tunisia': 'Túnez', 'Algeria': 'Argelia', 'Cameroon': 'Camerún',
  'Ivory Coast': 'Costa de Marfil', "Côte d'Ivoire": 'Costa de Marfil',
  'Nigeria': 'Nigeria', 'Ghana': 'Ghana', 'South Africa': 'Sudáfrica',
  'DR Congo': 'RD Congo', 'Democratic Republic of Congo': 'RD Congo',
  'Cape Verde': 'Cabo Verde', 'Curacao': 'Curaçao', 'Curaçao': 'Curaçao',
  'Haiti': 'Haití', 'Scotland': 'Escocia', 'Bosnia & Herzegovina': 'Bosnia',
  'Bosnia and Herzegovina': 'Bosnia',
};
function normWcTeam(name) {
  if (!name) return '';
  return TEAM_ES_MAP[name] || name;
}

async function runWcAutoGenerate(env) {
  const stats = { generated: 0, skippedCount: 0, errors: [], reasons: [] };
  try {
    const oddsKey = env.ODDS_API_KEY;
    if (!oddsKey) { stats.errors.push('ODDS_API_KEY no configurado'); return stats; }

    // Probar con fallback: algunos markets no están disponibles para todos los sports
    // 422 = market no soportado por este sport → retry con menos markets
    const marketCombos = ['h2h,totals,btts', 'h2h,totals', 'h2h'];
    let matches = null;
    let lastErr = null;
    for (const markets of marketCombos) {
      const url = `https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds/?apiKey=${oddsKey}&regions=us,eu,uk&markets=${markets}&oddsFormat=decimal`;
      const res = await fetch(url);
      if (res.ok) {
        matches = await res.json();
        stats.reasons.push(`✓ markets usados: ${markets}`);
        break;
      } else {
        lastErr = `HTTP ${res.status} con markets=${markets}`;
      }
    }
    if (!matches) { stats.errors.push(`Odds API: ${lastErr}`); return stats; }
    if (!Array.isArray(matches)) { stats.errors.push('Odds API: respuesta inválida'); return stats; }

    const now = Date.now();
    const minLead = now + 12 * 60 * 60 * 1000;
    const maxLead = now + 96 * 60 * 60 * 1000;

    const upcoming = matches.filter(m => {
      const ct = new Date(m.commence_time).getTime();
      return ct > minLead && ct < maxLead;
    });

    const hist = await fetchAdminHistorial(env);
    if (!Array.isArray(hist)) { stats.errors.push('historial no disponible'); return stats; }

    const newPicks = [];
    for (const m of upcoming) {
      try {
        const home = m.home_team;
        const away = m.away_team;
        const ct = new Date(m.commence_time).getTime();
        const dateStr = new Date(ct).toISOString().slice(0, 10).replace(/-/g, '');
        const slug = (home + '_' + away).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
        const pickId = `wc2026_auto_${slug}_${dateStr}`;

        const homeEs = normWcTeam(home);
        const awayEs = normWcTeam(away);
        const exists = hist.some(p => {
          if (!p || !p._wcMatch) return false;
          if (p.id === pickId) return true;
          const ph = p.home || '';
          const pa = p.away || '';
          const sameMatch =
            (ph === home || ph === homeEs || ph === away || ph === awayEs) &&
            (pa === home || pa === homeEs || pa === away || pa === awayEs);
          if (!sameMatch) return false;
          return Math.abs((p.commenceTs || 0) - ct) < 12 * 60 * 60 * 1000;
        });
        if (exists) { stats.skippedCount++; continue; }

        const bookmaker = (m.bookmakers || [])[0];
        if (!bookmaker) { stats.skippedCount++; continue; }
        const h2h = (bookmaker.markets || []).find(mk => mk.key === 'h2h');
        if (!h2h || !h2h.outcomes) { stats.skippedCount++; continue; }
        const hO = h2h.outcomes.find(o => o.name === home)?.price;
        const aO = h2h.outcomes.find(o => o.name === away)?.price;
        const dO = h2h.outcomes.find(o => o.name === 'Draw')?.price;
        if (!hO || !aO) { stats.skippedCount++; continue; }

        const MIN_ODDS = 1.30;  // 🔧 (28-jun-2026 Mauro) JAMÁS bajar de 1.30
        let rec, recSide, odds;

        // Paso 1: probar 1X2 (Gana X o Doble) — lógica original
        if (hO < 1.50 && hO >= MIN_ODDS) { rec = `Gana ${home}`; recSide = 'home'; odds = hO; }
        else if (aO < 1.50 && aO >= MIN_ODDS) { rec = `Gana ${away}`; recSide = 'away'; odds = aO; }
        else if (hO < aO && hO < 1.85 && hO >= MIN_ODDS) {
          rec = `Doble 1X`; recSide = '1x';
          const dp = 1/hO + 1/(dO || 5);
          const rawOdds = Math.round((1 / dp) * 0.95 * 100) / 100;
          if (rawOdds >= MIN_ODDS) { odds = rawOdds; }
          else { rec = null; }  // no califica, probar siguientes mercados
        }
        else if (aO < hO && aO < 1.85 && aO >= MIN_ODDS) {
          rec = `Doble X2`; recSide = 'x2';
          const dp = 1/aO + 1/(dO || 5);
          const rawOdds = Math.round((1 / dp) * 0.95 * 100) / 100;
          if (rawOdds >= MIN_ODDS) { odds = rawOdds; }
          else { rec = null; }  // no califica, probar siguientes mercados
        }

        // Paso 2: si 1X2 no dio pick, probar Over 2.5 goles
        if (!rec) {
          const totals = (bookmaker.markets || []).find(mk => mk.key === 'totals');
          if (totals && Array.isArray(totals.outcomes)) {
            // Buscar línea 2.5 exactamente
            const over25 = totals.outcomes.find(o => o.name === 'Over' && Number(o.point) === 2.5);
            if (over25 && over25.price && over25.price >= 1.45 && over25.price <= 1.85) {
              rec = 'Más de 2.5 goles';
              recSide = 'over25';
              odds = over25.price;
            }
          }
        }

        // Paso 3: si nada calificó, probar BTTS (Ambos Equipos Marcan)
        if (!rec) {
          const btts = (bookmaker.markets || []).find(mk => mk.key === 'btts');
          if (btts && Array.isArray(btts.outcomes)) {
            const yes = btts.outcomes.find(o => o.name === 'Yes');
            if (yes && yes.price && yes.price >= 1.50 && yes.price <= 1.85) {
              rec = 'Ambos Equipos Marcan';
              recSide = 'btts';
              odds = yes.price;
            }
          }
        }

        // Sin pick válido → skip
        if (!rec) { stats.skippedCount++; continue; }

        let conf, bvr, bvrText, stake;
        if (odds <= 1.50) { conf='high'; bvr=6; bvrText='Máxima'; stake=170; }
        else if (odds <= 1.75) { conf='high'; bvr=5; bvrText='Alta'; stake=130; }
        else if (odds <= 2.00) { conf='high'; bvr=4; bvrText='Media-Alta'; stake=110; }
        else { conf='med'; bvr=3; bvrText='Media'; stake=80; }

        const tp = (1/hO + 1/(dO||5) + 1/aO);
        const probH = Math.round((1/hO/tp)*100);
        const probD = Math.round((1/(dO||5)/tp)*100);
        const probA = Math.round((1/aO/tp)*100);

        newPicks.push({
          id: pickId,
          home: homeEs, away: awayEs,
          rec: rec.replace(home, homeEs).replace(away, awayEs),
          _recSide: recSide,
          conf, bvr, bvrText,
          stake, odds: Math.round(odds*100)/100,
          _hO: hO, _dO: dO, _aO: aO, _bestOdds: odds,
          _bookKey: 'dbbet', _bookLabel: 'DBbet',
          result: 'pending',
          league: '🏆 Mundial 2026',
          date: m.commence_time,
          commenceTs: ct,
          _sportKey: 'soccer_fifa_world_cup',
          _wcMatch: true,
          probH, probD, probA,
          insight: `Pick generado automáticamente desde cuotas reales. Recomendación: ${rec} a cuota ${odds.toFixed(2)}. Probabilidades implícitas: ${probH}% local · ${probD}% empate · ${probA}% visitante.`,
          _autoGenerated: true,
          _autoGeneratedAt: new Date().toISOString(),
        });
        stats.generated++;
        stats.reasons.push(`✓ ${home} vs ${away}: ${rec} @ ${odds.toFixed(2)}`);
      } catch (e) {
        stats.errors.push(`${m.home_team} vs ${m.away_team}: ${e.message}`);
      }
    }

    if (newPicks.length > 0) {
      const newHist = [...newPicks, ...hist];
      const key = env.SUPABASE_SERVICE_ROLE_KEY;
      if (!key) { stats.errors.push('SUPABASE_SERVICE_ROLE_KEY no configurado'); return stats; }
      const r = await fetch(`${SUPABASE_URL}/rest/v1/acoin_users?email=eq.${encodeURIComponent(ADMIN_EMAIL)}`, {
        method: 'PATCH',
        headers: { 'apikey': key, 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ historial_full: newHist, updated_at: new Date().toISOString() }),
      });
      if (!r.ok) stats.errors.push(`PATCH HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
  } catch (e) {
    stats.errors.push(`fatal: ${e.message}`);
  }
  return stats;
}


// ═══════════════════════════════════════════════════════════════════════════
// SCHEMA MONITOR — auditoría anti-regresión schema.org JSON-LD
// Corre semanalmente vía cron (lunes 06:00 UTC = 03:00 ART)
// 3 controles independientes (grep + HTTP + semántico) sobre muestra del sitio.
// Resultado guardado en KV. Endpoints /admin/schema-monitor/status (GET) y /run (POST).
// ═══════════════════════════════════════════════════════════════════════════

// ── Schema Monitor: notificación email cuando hay críticos nuevos ──
async function _sendSchemaMonitorAlert(env, result) {
  if (!env.RESEND_API_KEY) {
    console.log('[schema-monitor] RESEND_API_KEY no configurada, skip email');
    return false;
  }
  const criticals = result.new_vs_baseline.filter(b => b.severity === 'critical');
  if (criticals.length === 0) return false;

  // Agrupar por issue para no repetir
  const byIssue = {};
  for (const b of result.new_vs_baseline) {
    const k = `${b.severity}|${b.issue}`;
    if (!byIssue[k]) byIssue[k] = { severity: b.severity, issue: b.issue, urls: [] };
    byIssue[k].urls.push(b.url);
  }
  const groups = Object.values(byIssue).sort((a, b) => {
    const ord = { critical: 0, medium: 1, low: 2 };
    return ord[a.severity] - ord[b.severity];
  });

  const rows = groups.map(g => {
    const sevEmoji = { critical: '🔴', medium: '🟡', low: '🟢' }[g.severity];
    const sevColor = { critical: '#c81030', medium: '#d9a800', low: '#0a8a3a' }[g.severity];
    const urlList = g.urls.slice(0, 5).map(u => `<li style="font-size:12px;color:#666">${u.replace('https://gambeta.ai', '')}</li>`).join('');
    const more = g.urls.length > 5 ? `<li style="font-size:12px;color:#999">+${g.urls.length - 5} más</li>` : '';
    return `<tr>
      <td style="padding:10px;border-bottom:1px solid #eee;vertical-align:top">
        <div style="font-weight:bold;color:${sevColor}">${sevEmoji} ${g.severity.toUpperCase()}</div>
        <div style="font-family:monospace;font-size:13px;color:#222;margin-top:4px">${g.issue}</div>
        <ul style="margin:8px 0 0 0;padding-left:20px">${urlList}${more}</ul>
      </td>
    </tr>`;
  }).join('');

  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
    <h2 style="color:#c81030">⚠️ Schema Monitor — bugs nuevos detectados</h2>
    <p style="color:#444">El audit semanal del <b>${result.ts.slice(0, 10)}</b> encontró <b>${result.new_count} bug(s) nuevos</b> vs el baseline anterior, de los cuales <b>${criticals.length} son críticos</b> que Google Search Console probablemente reporte como errores.</p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0;background:#fafafa;border-radius:8px;overflow:hidden">
      ${rows}
    </table>
    <p style="font-size:13px;color:#666">
      Ver audit completo:<br>
      <a href="https://apuestas-api.mauro-union10.workers.dev/admin/schema-monitor/status" style="color:#0066cc">apuestas-api.mauro-union10.workers.dev/admin/schema-monitor/status</a>
    </p>
    <p style="font-size:12px;color:#999;border-top:1px solid #eee;padding-top:14px;margin-top:24px">
      Auto-generado por gambeta-schema-monitor cron (lunes 06:00 UTC).<br>
      Baseline NO se actualiza mientras haya críticos abiertos, así que si no fixeás, no llega otro mail por el mismo bug.
    </p>
  </div>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Schema Monitor <no-reply@gambeta.ai>',
        to: ['pronosticosarg@gmail.com'],
        subject: `⚠️ Schema Monitor: ${criticals.length} bug${criticals.length > 1 ? 's' : ''} crítico${criticals.length > 1 ? 's' : ''} nuevo${criticals.length > 1 ? 's' : ''} en gambeta.ai`,
        html
      })
    });
    const ok = r.ok;
    if (!ok) {
      const text = await r.text().catch(() => '');
      console.error('[schema-monitor] resend error', r.status, text.slice(0, 200));
    }
    return ok;
  } catch (e) {
    console.error('[schema-monitor] resend exception', e.message);
    return false;
  }
}

async function runSchemaMonitor(env) {
  const SAMPLES = [
    'https://gambeta.ai/',
    'https://gambeta.ai/como-funciona',
    'https://gambeta.ai/herramientas',
    'https://gambeta.ai/mundial-2026',
    'https://gambeta.ai/blog/ia-para-apostar',
    'https://gambeta.ai/blog/que-es-scores24',
    'https://gambeta.ai/blog/1x2-mercado-simple',
    'https://gambeta.ai/blog/adamchoi-mas-ia-futbol',
    'https://gambeta.ai/blog/pronostico-argentina-jordania-27-06',
    'https://gambeta.ai/previa/final-sf-w1-vs-sf-w2-mundial-2026',
    'https://gambeta.ai/previa/semifinal-qf1-vs-qf2-mundial-2026',
    'https://gambeta.ai/bonos',
  ];

  // Patrones inventados/mockup/genéricos — NO deben aparecer nunca
  const BAD_PATTERNS = [
    { name: 'logo.png 404',        pattern: 'gambeta.ai/logo.png',    severity: 'critical' },
    { name: 'twitter @ inventado', pattern: '@gambetaia',             severity: 'critical' },
    { name: 'twitter.com inventado', pattern: 'twitter.com/gambetaia', severity: 'critical' },
    { name: 'telegram canal inventado', pattern: '+gambeta_canal',     severity: 'critical' },
    { name: 'lorem residual',      pattern: 'lorem ipsum',            severity: 'critical' },
    { name: 'placeholder test',    pattern: 'test@example.com',       severity: 'medium' },
    { name: 'XXXXXX placeholder',  pattern: 'XXXXXX',                 severity: 'medium' },
    { name: 'replace-me',          pattern: 'replace-me',             severity: 'medium' },
  ];

  // URLs que el sitio referencia en JSON-LD y deben responder 200
  const REQUIRED_URLS = [
    'https://gambeta.ai/favicon-512.png',
    'https://x.com/Gambeta_ai',
    'https://t.me/GrupoLatam',
    'https://www.youtube.com/@apuestaslatam',
    'https://www.fifa.com',
  ];

  // sameAs whitelist (Organization schema)
  const ALLOWED_SAMEAS = ['x.com/Gambeta_ai', 't.me/GrupoLatam', 'youtube.com/@apuestaslatam', 'www.fifa.com'];

  const findings = [];
  const ua = 'Mozilla/5.0 (GambetaSchemaMonitor/1.0)';
  const sampleHtmls = {};

  // ── Control #1: grep patterns en HTML live ──
  for (const url of SAMPLES) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': ua }, redirect: 'follow' });
      if (!r.ok) {
        findings.push({ control: 1, severity: 'medium', url, issue: `http_${r.status}` });
        continue;
      }
      const html = await r.text();
      sampleHtmls[url] = html;
      for (const bp of BAD_PATTERNS) {
        if (html.includes(bp.pattern)) {
          findings.push({ control: 1, severity: bp.severity, url, issue: `bad_pattern: ${bp.name}` });
        }
      }
    } catch (e) {
      findings.push({ control: 1, severity: 'medium', url, issue: `fetch_error: ${e.message}` });
    }
  }

  // ── Control #2: HEAD a URLs requeridas ──
  for (const url of REQUIRED_URLS) {
    try {
      const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': ua }, redirect: 'follow' });
      if (r.status >= 400) {
        findings.push({ control: 2, severity: 'critical', url, issue: `required_url_returns_${r.status}` });
      }
    } catch (e) {
      findings.push({ control: 2, severity: 'medium', url, issue: `head_error: ${e.message}` });
    }
  }

  // ── Control #3: parsear JSON-LD y validar schema.org compliance ──
  for (const url of SAMPLES) {
    const html = sampleHtmls[url];
    if (!html) continue;
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    for (const m of blocks) {
      let d;
      try { d = JSON.parse(m[1].trim()); }
      catch (e) {
        findings.push({ control: 3, severity: 'critical', url, issue: 'json_parse_error' });
        continue;
      }
      function walk(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(walk); return; }
        if (obj['@graph']) obj['@graph'].forEach(walk);
        const t = obj['@type'];
        if (t === 'SportsEvent') {
          if (!obj.description) findings.push({ control: 3, severity: 'medium', url, issue: 'SportsEvent_no_description' });
          if (!obj.organizer) findings.push({ control: 3, severity: 'medium', url, issue: 'SportsEvent_no_organizer' });
          else if (typeof obj.organizer === 'object' && !obj.organizer.url) findings.push({ control: 3, severity: 'medium', url, issue: 'SportsEvent_organizer_no_url' });
        }
        if (t === 'Article') {
          if (!obj.image) findings.push({ control: 3, severity: 'critical', url, issue: 'Article_no_image' });
          if (!obj.author) findings.push({ control: 3, severity: 'critical', url, issue: 'Article_no_author' });
          if (!obj.datePublished) findings.push({ control: 3, severity: 'critical', url, issue: 'Article_no_datePublished' });
          const pub = obj.publisher;
          if (!pub || typeof pub !== 'object') findings.push({ control: 3, severity: 'critical', url, issue: 'Article_no_publisher' });
          else if (!pub.logo || typeof pub.logo !== 'object' || !pub.logo.url) findings.push({ control: 3, severity: 'critical', url, issue: 'Article_no_publisher_logo' });
          else if (!pub.logo.url.includes('favicon-512')) findings.push({ control: 3, severity: 'medium', url, issue: 'Article_publisher_logo_wrong_url' });
        }
        if (t === 'Organization' && Array.isArray(obj.sameAs)) {
          for (const s of obj.sameAs) {
            if (!ALLOWED_SAMEAS.some(a => s.includes(a))) {
              findings.push({ control: 3, severity: 'critical', url, issue: `Organization_sameAs_off_whitelist: ${s.slice(0,80)}` });
            }
          }
        }
        for (const k in obj) {
          if (typeof obj[k] === 'object' && k !== '@graph') walk(obj[k]);
        }
      }
      walk(d);
    }
  }

  // ── Comparar contra baseline ──
  let prev = null;
  try { prev = await env.CACHE_KV.get('schema_monitor:baseline', { type: 'json' }); } catch(e) {}
  const prevKeys = new Set((prev?.findings || []).map(f => `${f.severity}|${f.issue}|${f.url}`));
  const newBugs = findings.filter(f => !prevKeys.has(`${f.severity}|${f.issue}|${f.url}`));

  const bySev = {
    critical: findings.filter(f => f.severity === 'critical').length,
    medium:   findings.filter(f => f.severity === 'medium').length,
    low:      findings.filter(f => f.severity === 'low').length,
  };
  const result = {
    ts: new Date().toISOString(),
    samples_audited: SAMPLES.length,
    findings_count: findings.length,
    findings_by_severity: bySev,
    findings,
    new_vs_baseline: newBugs,
    new_count: newBugs.length,
    alert: newBugs.filter(b => b.severity === 'critical').length > 0,
  };

  await env.CACHE_KV.put('schema_monitor:latest', JSON.stringify(result), { expirationTtl: 86400 * 60 });
  // Solo actualizar baseline si NO hay críticos nuevos (baseline = último estado limpio)
  if (!result.alert) {
    await env.CACHE_KV.put('schema_monitor:baseline', JSON.stringify(result), { expirationTtl: 86400 * 90 });
  }
  if (result.alert) {
    console.log('[SCHEMA_MONITOR_ALERT]', JSON.stringify({ count: newBugs.length, sample: newBugs.slice(0,5) }));
    // Cierra el loop: email proactivo a Mauro solo si hay crítico nuevo
    const mailSent = await _sendSchemaMonitorAlert(env, result);
    result.email_sent = mailSent;
  }
  return result;
}



// ═══════════════════════════════════════════════════════════════════════════
// BILLING MONITOR — alerta pre-vencimiento de suscripciones pagas
// Corre diariamente vía cron (09:00 ART = 12:00 UTC).
// Lee lista de KV billing:subscriptions, alerta si algún cobro está a ≤7 días.
// ═══════════════════════════════════════════════════════════════════════════

// Lista PROVISIONAL pre-cargada — basada en sesiones #155/#158/#364
// Mauro debe confirmar/corregir billing_day exactos en cada uno
const BILLING_DEFAULTS = [
  { name: 'Odds API', amount: 119, currency: 'USD', billing_day: 1,  payment_method: 'Stripe', dashboard_url: 'https://the-odds-api.com/account/', notes: 'Plan 5M req/mo — decisión #156' },
  { name: 'API-Football', amount: 19, currency: 'USD', billing_day: 1, payment_method: 'Stripe', dashboard_url: 'https://dashboard.api-football.com/billing', notes: 'Plan PRO — decisión #154' },
  { name: 'Cloudflare Workers Paid', amount: 5, currency: 'USD', billing_day: 1, payment_method: 'Card', dashboard_url: 'https://dash.cloudflare.com/?to=/:account/billing', notes: 'Workers + Pages — observado #364' },
  { name: 'Supabase', amount: 25, currency: 'USD', billing_day: 1, payment_method: 'Card', dashboard_url: 'https://supabase.com/dashboard/org/_/billing', notes: 'Plan Pro (asumido)' },
  { name: 'SendX', amount: 15, currency: 'USD', billing_day: 1, payment_method: 'Card', dashboard_url: 'https://app.sendx.io/billing', notes: 'Plan starter (asumido — confirmar)' },
  { name: 'Resend', amount: 0, currency: 'USD', billing_day: 1, payment_method: 'Card', dashboard_url: 'https://resend.com/settings/billing', notes: 'Free tier asumido — confirmar' },
  { name: 'Dominio gambeta.ai', amount: 50, currency: 'USD', billing_day: 1, payment_method: 'Card', dashboard_url: 'https://dash.cloudflare.com', notes: 'Anual — confirmar mes' },
  { name: 'Dominio accesoia.app', amount: 30, currency: 'USD', billing_day: 1, payment_method: 'Card', dashboard_url: 'https://dash.cloudflare.com', notes: 'Anual — confirmar mes' },
];

function _nextChargeDate(billing_day, todayUTC) {
  // Próximo billing_day del mes actual; si ya pasó, mes siguiente
  const d = new Date(todayUTC);
  const day = Math.min(billing_day, 28); // safe-cap para meses cortos
  const candidate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day));
  if (candidate < d) {
    candidate.setUTCMonth(candidate.getUTCMonth() + 1);
  }
  return candidate;
}

async function runBillingMonitor(env) {
  let subs = null;
  try { subs = await env.CACHE_KV.get('billing:subscriptions', { type: 'json' }); } catch(e) {}
  if (!subs || !Array.isArray(subs) || subs.length === 0) {
    // Primera vez: cargar defaults
    subs = BILLING_DEFAULTS;
    await env.CACHE_KV.put('billing:subscriptions', JSON.stringify(subs));
  }

  const now = new Date();
  const upcoming = [];
  let totalMonthly = 0;
  for (const s of subs) {
    if (!s.amount) continue;
    totalMonthly += s.amount;
    if (!s.billing_day) continue;
    const next = _nextChargeDate(s.billing_day, now);
    const daysUntil = Math.ceil((next - now) / 86400000);
    if (daysUntil <= 7 && daysUntil >= 0) {
      upcoming.push({ ...s, next_charge: next.toISOString().slice(0, 10), days_until: daysUntil });
    }
  }
  upcoming.sort((a, b) => a.days_until - b.days_until);

  const result = {
    ts: now.toISOString(),
    subscriptions_count: subs.length,
    monthly_total: totalMonthly,
    upcoming_in_7d: upcoming,
    alert: upcoming.length > 0,
  };

  // Email solo si hay upcoming
  if (result.alert && env.RESEND_API_KEY) {
    const sent = await _sendBillingAlert(env, result);
    result.email_sent = sent;
  }

  await env.CACHE_KV.put('billing:latest', JSON.stringify(result), { expirationTtl: 86400 * 60 });
  return result;
}

async function _sendBillingAlert(env, result) {
  const rows = result.upcoming_in_7d.map(s => {
    const urgencyColor = s.days_until <= 2 ? '#c81030' : s.days_until <= 4 ? '#d9a800' : '#0a8a3a';
    const urgencyEmoji = s.days_until <= 2 ? '🔴' : s.days_until <= 4 ? '🟡' : '🟢';
    return `<tr>
      <td style="padding:14px;border-bottom:1px solid #eee">
        <div style="font-weight:700;color:#222;font-size:15px">${urgencyEmoji} ${s.name}</div>
        <div style="font-size:13px;color:#666;margin-top:4px">${s.notes || ''}</div>
      </td>
      <td style="padding:14px;border-bottom:1px solid #eee;text-align:right;vertical-align:top">
        <div style="font-weight:700;font-size:16px;color:#222">${s.currency} ${s.amount}</div>
        <div style="font-size:12px;color:${urgencyColor};margin-top:4px">en ${s.days_until} día${s.days_until !== 1 ? 's' : ''}</div>
        <div style="font-size:11px;color:#999;margin-top:2px">${s.next_charge}</div>
      </td>
    </tr>`;
  }).join('');

  const totalUpcoming = result.upcoming_in_7d.reduce((sum, s) => sum + s.amount, 0);

  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
    <h2 style="color:#0066cc">💳 Billing Monitor — cobros próximos</h2>
    <p style="color:#444">Detecté <b>${result.upcoming_in_7d.length} cobro(s) en los próximos 7 días</b> por un total de <b>USD ${totalUpcoming}</b>.</p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0;background:#fafafa;border-radius:8px;overflow:hidden">
      ${rows}
    </table>
    <div style="background:#f0f8ff;border:1px solid #b3d9ff;border-radius:8px;padding:14px;margin:20px 0">
      <div style="font-size:13px;color:#444"><b>Total mensual estimado:</b> USD ${result.monthly_total}</div>
      <div style="font-size:13px;color:#444;margin-top:6px"><b>Suscripciones activas:</b> ${result.subscriptions_count}</div>
    </div>
    <p style="font-size:13px;color:#666">
      Gestionar lista:<br>
      <a href="https://apuestas-api.mauro-union10.workers.dev/admin/billing/list" style="color:#0066cc">apuestas-api.mauro-union10.workers.dev/admin/billing/list</a>
    </p>
    <p style="font-size:12px;color:#999;border-top:1px solid #eee;padding-top:14px;margin-top:24px">
      Auto-generado por billing-monitor cron (diario 09:00 ART). Solo recibís mail si hay cobros próximos.
    </p>
  </div>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Billing Monitor <no-reply@gambeta.ai>',
        to: ['pronosticosarg@gmail.com'],
        subject: `💳 ${result.upcoming_in_7d.length} cobro${result.upcoming_in_7d.length > 1 ? 's' : ''} en próximos 7 días (USD ${totalUpcoming})`,
        html
      })
    });
    return r.ok;
  } catch (e) {
    console.error('[billing-monitor] resend exception', e.message);
    return false;
  }
}



// ═══════════════════════════════════════════════════════════════════════════
// UPTIME MONITOR — chequea targets críticos cada 15min. Anti-flap (2 fails).
// ═══════════════════════════════════════════════════════════════════════════
const UPTIME_DEFAULTS = [
  { name: 'gambeta.ai',         url: 'https://gambeta.ai/' },
  { name: 'accesoia.app',       url: 'https://accesoia.app/' },
  { name: 'masterprops (GH Pages)', url: 'https://maurounion10-lab.github.io/masterprops/' },
  { name: 'worker apuestas-api', url: 'https://apuestas-api.mauro-union10.workers.dev/admin/schema-monitor/status' },
];

async function runUptimeMonitor(env) {
  let targets = null;
  try { targets = await env.CACHE_KV.get('uptime:targets', { type: 'json' }); } catch(e) {}
  if (!targets || !Array.isArray(targets) || targets.length === 0) {
    targets = UPTIME_DEFAULTS;
    await env.CACHE_KV.put('uptime:targets', JSON.stringify(targets));
  }

  let previous = null;
  try { previous = await env.CACHE_KV.get('uptime:state', { type: 'json' }) || {}; } catch(e) { previous = {}; }

  const current = {};
  const events = []; // [{name, url, type: OUTAGE_CONFIRMED|RECOVERY, code, ms, consecutive}]
  const ts = new Date().toISOString();

  for (const t of targets) {
    const start = Date.now();
    let code = 0, status = 'UP', error = null;
    try {
      // GET en lugar de HEAD porque algunos servidores no soportan HEAD bien
      const r = await fetch(t.url, {
        method: 'GET',
        headers: { 'User-Agent': 'GambetaUptimeMonitor/1.0' },
        redirect: 'follow',
        cf: { cacheTtl: 0 },
      });
      code = r.status;
      status = (code >= 200 && code < 400) ? 'UP' : 'DOWN';
      // Drain body para no contar como response time vacío
      await r.text().catch(() => '');
    } catch (e) {
      status = 'DOWN';
      error = e.message.slice(0, 100);
    }
    const ms = Date.now() - start;

    const prev = previous[t.url] || { status: 'UP', consecutive_down: 0, since: ts };
    const newState = {
      status,
      code,
      ms,
      ts,
      consecutive_down: status === 'DOWN' ? (prev.consecutive_down || 0) + 1 : 0,
      since: (prev.status !== status) ? ts : prev.since,
      error,
    };
    current[t.url] = newState;

    // Anti-flap: solo alertar cuando consecutive_down == 2 (segunda confirmación)
    if (status === 'DOWN' && newState.consecutive_down === 2) {
      events.push({ name: t.name, url: t.url, type: 'OUTAGE_CONFIRMED', code, ms, error, consecutive: 2 });
    }
    // Recovery: si estaba con >=2 fallas y ahora UP
    if (status === 'UP' && (prev.consecutive_down || 0) >= 2) {
      const downSince = prev.since || prev.ts;
      events.push({ name: t.name, url: t.url, type: 'RECOVERY', code, ms, down_since: downSince });
    }
  }

  await env.CACHE_KV.put('uptime:state', JSON.stringify(current));

  const result = {
    ts,
    targets_count: targets.length,
    current,
    events,
    alert: events.length > 0,
  };
  if (result.alert && env.RESEND_API_KEY) {
    const sent = await _sendUptimeAlert(env, result);
    result.email_sent = sent;
  }
  return result;
}

async function _sendUptimeAlert(env, result) {
  const outages = result.events.filter(e => e.type === 'OUTAGE_CONFIRMED');
  const recoveries = result.events.filter(e => e.type === 'RECOVERY');

  const buildRow = (e) => {
    const isOutage = e.type === 'OUTAGE_CONFIRMED';
    const color = isOutage ? '#c81030' : '#0a8a3a';
    const emoji = isOutage ? '🔴' : '🟢';
    const label = isOutage ? 'CAÍDO (confirmado)' : 'RECUPERADO';
    return `<tr>
      <td style="padding:14px;border-bottom:1px solid #eee;vertical-align:top">
        <div style="font-weight:700;color:#222;font-size:15px">${emoji} ${e.name}</div>
        <div style="font-size:12px;color:#666;margin-top:4px;font-family:monospace">${e.url}</div>
        ${e.error ? `<div style="font-size:12px;color:#c81030;margin-top:6px">Error: ${e.error}</div>` : ''}
        ${e.down_since ? `<div style="font-size:12px;color:#0a8a3a;margin-top:6px">Estuvo caído desde: ${e.down_since}</div>` : ''}
      </td>
      <td style="padding:14px;border-bottom:1px solid #eee;text-align:right;vertical-align:top">
        <div style="font-weight:700;font-size:14px;color:${color}">${label}</div>
        <div style="font-size:12px;color:#666;margin-top:4px">HTTP ${e.code || 'err'} · ${e.ms}ms</div>
      </td>
    </tr>`;
  };

  let subject = '';
  if (outages.length > 0 && recoveries.length > 0) {
    subject = `🚨 ${outages.length} caída(s) + ${recoveries.length} recuperación(es)`;
  } else if (outages.length > 0) {
    subject = `🚨 CAÍDA confirmada: ${outages.map(o => o.name).join(', ')}`;
  } else {
    subject = `🟢 RECUPERADO: ${recoveries.map(o => o.name).join(', ')}`;
  }

  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
    <h2 style="color:${outages.length > 0 ? '#c81030' : '#0a8a3a'}">${outages.length > 0 ? '🚨' : '🟢'} Uptime Monitor</h2>
    <p style="color:#444">Eventos detectados a las <b>${result.ts.slice(11, 19)} UTC</b>:</p>
    <table style="width:100%;border-collapse:collapse;margin:20px 0;background:#fafafa;border-radius:8px;overflow:hidden">
      ${result.events.map(buildRow).join('')}
    </table>
    <p style="font-size:13px;color:#666">
      Estado completo:<br>
      <a href="https://apuestas-api.mauro-union10.workers.dev/admin/uptime/status" style="color:#0066cc">apuestas-api.mauro-union10.workers.dev/admin/uptime/status</a>
    </p>
    <p style="font-size:12px;color:#999;border-top:1px solid #eee;padding-top:14px;margin-top:24px">
      Auto-generado por uptime-monitor cron (cada 15min). Anti-flap: confirmación tras 2 fallas seguidas para evitar falsos positivos.
    </p>
  </div>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Uptime Monitor <no-reply@gambeta.ai>',
        to: ['pronosticosarg@gmail.com'],
        subject,
        html,
      })
    });
    return r.ok;
  } catch (e) {
    console.error('[uptime-monitor] resend exception', e.message);
    return false;
  }
}



// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD HTML — vista unificada de los 3 monitores (Schema + Uptime + Billing)
// GET /admin/dashboard?token=... → HTML mobile-friendly, auto-refresh 60s.
// ═══════════════════════════════════════════════════════════════════════════
function _renderDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0a0a0f">
<title>Gambeta Monitors</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  :root { --bg:#0a0a0f; --card:#111118; --border:rgba(255,255,255,0.08); --text:#f0ece0; --mute:rgba(255,255,255,0.55); --green:#0a8a3a; --yellow:#d9a800; --red:#c81030; }
  body { background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; line-height:1.5; min-height:100vh; padding:16px; }
  header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; padding-bottom:14px; border-bottom:1px solid var(--border); }
  h1 { font-size:1.25rem; font-weight:800; letter-spacing:-0.3px; }
  .updated { font-size:.75rem; color:var(--mute); font-family:"SF Mono",Menlo,monospace; }
  .grid { display:grid; gap:14px; max-width:780px; margin:0 auto; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:14px; padding:18px; }
  .card-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
  .card-title { font-size:.7rem; font-weight:800; letter-spacing:2px; text-transform:uppercase; color:var(--mute); }
  .card-status { display:flex; align-items:center; gap:6px; font-size:.78rem; font-weight:700; padding:4px 10px; border-radius:999px; }
  .status-green { background:rgba(10,138,58,0.15); color:var(--green); border:1px solid rgba(10,138,58,0.4); }
  .status-yellow { background:rgba(217,168,0,0.15); color:var(--yellow); border:1px solid rgba(217,168,0,0.4); }
  .status-red { background:rgba(200,16,48,0.15); color:var(--red); border:1px solid rgba(200,16,48,0.4); }
  .dot { width:8px; height:8px; border-radius:50%; }
  .dot-green { background:var(--green); box-shadow:0 0 8px rgba(10,138,58,0.6); }
  .dot-yellow { background:var(--yellow); box-shadow:0 0 8px rgba(217,168,0,0.6); }
  .dot-red { background:var(--red); box-shadow:0 0 8px rgba(200,16,48,0.6); animation:pulse 1.6s infinite; }
  @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.5 } }
  .metric-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:12px; margin-bottom:14px; }
  .metric { background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.04); border-radius:8px; padding:10px; }
  .metric-label { font-size:.65rem; color:var(--mute); text-transform:uppercase; letter-spacing:1.2px; margin-bottom:4px; }
  .metric-value { font-size:1.4rem; font-weight:800; font-family:"SF Mono",Menlo,monospace; }
  .row { display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.04); font-size:.85rem; }
  .row:last-child { border-bottom:0; }
  .row-name { font-weight:600; }
  .row-detail { color:var(--mute); font-size:.78rem; font-family:"SF Mono",Menlo,monospace; }
  .row-value { font-weight:700; }
  .row-value.up { color:var(--green); }
  .row-value.down { color:var(--red); }
  .row-value.warn { color:var(--yellow); }
  footer { text-align:center; margin-top:24px; padding-top:14px; font-size:.7rem; color:var(--mute); }
  .err { padding:14px; background:rgba(200,16,48,0.1); border:1px solid rgba(200,16,48,0.3); border-radius:8px; color:var(--red); font-size:.85rem; }
  .empty { padding:14px; color:var(--mute); font-size:.85rem; text-align:center; font-style:italic; }
</style>
</head>
<body>
<div class="grid">
  <header>
    <h1>🛡️ Gambeta Monitors</h1>
    <span class="updated" id="updated">cargando...</span>
  </header>

  <div class="card" id="card-uptime">
    <div class="card-head"><span class="card-title">Uptime</span><span class="card-status" id="uptime-status">—</span></div>
    <div id="uptime-body">cargando...</div>
  </div>

  <div class="card" id="card-schema">
    <div class="card-head"><span class="card-title">Schema Monitor</span><span class="card-status" id="schema-status">—</span></div>
    <div id="schema-body">cargando...</div>
  </div>

  <div class="card" id="card-billing">
    <div class="card-head"><span class="card-title">Billing</span><span class="card-status" id="billing-status">—</span></div>
    <div id="billing-body">cargando...</div>
  </div>

  <footer>Auto-refresh cada 60s · Datos directos de los endpoints /status</footer>
</div>

<script>
const BASE = 'https://apuestas-api.mauro-union10.workers.dev';
const fmt = (ms) => ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(1) + 's';
const setStatus = (id, color, txt) => {
  const el = document.getElementById(id);
  el.className = 'card-status status-' + color;
  el.innerHTML = '<span class="dot dot-' + color + '"></span>' + txt;
};

async function loadUptime() {
  try {
    const r = await fetch(BASE + '/admin/uptime/status', {cache:'no-store'});
    const d = await r.json();
    const state = d.current_state || {};
    const downCount = Object.values(state).filter(s => s.status === 'DOWN').length;
    const targetUrls = (d.targets || []).map(t => t.url);
    const cleanState = Object.fromEntries(Object.entries(state).filter(([url]) => targetUrls.includes(url)));
    const totalTargets = d.targets_count;
    const upCount = totalTargets - downCount;

    if (downCount === 0) setStatus('uptime-status', 'green', upCount + '/' + totalTargets + ' UP');
    else setStatus('uptime-status', 'red', downCount + ' CAÍDO');

    const rows = (d.targets || []).map(t => {
      const s = state[t.url];
      if (!s) return '<div class="row"><span class="row-name">' + t.name + '</span><span class="row-value warn">SIN DATO</span></div>';
      const color = s.status === 'UP' ? 'up' : 'down';
      return '<div class="row"><div><div class="row-name">' + t.name + '</div><div class="row-detail">' + s.code + ' · ' + fmt(s.ms) + '</div></div><span class="row-value ' + color + '">' + s.status + '</span></div>';
    }).join('');
    document.getElementById('uptime-body').innerHTML = rows || '<div class="empty">Sin targets</div>';
  } catch(e) {
    setStatus('uptime-status', 'red', 'ERROR');
    document.getElementById('uptime-body').innerHTML = '<div class="err">' + e.message + '</div>';
  }
}

async function loadSchema() {
  try {
    const r = await fetch(BASE + '/admin/schema-monitor/status', {cache:'no-store'});
    const d = await r.json();
    if (d.ok === false) {
      setStatus('schema-status', 'yellow', 'SIN DATA');
      document.getElementById('schema-body').innerHTML = '<div class="empty">Esperando primera corrida del cron</div>';
      return;
    }
    const sev = d.findings_by_severity || {critical:0, medium:0, low:0};
    if (d.alert) setStatus('schema-status', 'red', sev.critical + ' críticos');
    else if (sev.medium > 0) setStatus('schema-status', 'yellow', sev.medium + ' medium');
    else setStatus('schema-status', 'green', '0 bugs');

    const tsDate = new Date(d.ts);
    const ago = Math.floor((Date.now() - tsDate.getTime()) / 60000);
    document.getElementById('schema-body').innerHTML =
      '<div class="metric-grid"><div class="metric"><div class="metric-label">Páginas</div><div class="metric-value">' + d.samples_audited + '</div></div>' +
      '<div class="metric"><div class="metric-label">Críticos</div><div class="metric-value" style="color:' + (sev.critical > 0 ? 'var(--red)' : 'var(--green)') + '">' + sev.critical + '</div></div>' +
      '<div class="metric"><div class="metric-label">Medium</div><div class="metric-value" style="color:' + (sev.medium > 0 ? 'var(--yellow)' : 'var(--green)') + '">' + sev.medium + '</div></div>' +
      '<div class="metric"><div class="metric-label">Total</div><div class="metric-value">' + d.findings_count + '</div></div></div>' +
      '<div class="row-detail">Último audit: hace ' + (ago < 60 ? ago + 'm' : Math.floor(ago/60) + 'h ' + (ago%60) + 'm') + ' · Próximo: lunes 03:00 ART</div>';
  } catch(e) {
    setStatus('schema-status', 'red', 'ERROR');
    document.getElementById('schema-body').innerHTML = '<div class="err">' + e.message + '</div>';
  }
}

async function loadBilling() {
  try {
    const r = await fetch(BASE + '/admin/billing/list', {cache:'no-store'});
    const d = await r.json();
    const subs = d.subscriptions || [];
    const latest = d.last_run;
    const upcoming = latest?.upcoming_in_7d || [];
    const monthlyTotal = subs.reduce((s,x) => s + (x.amount || 0), 0);

    if (upcoming.length === 0) setStatus('billing-status', 'green', 'OK');
    else if (upcoming.some(u => u.days_until <= 2)) setStatus('billing-status', 'red', upcoming.length + ' próximos');
    else setStatus('billing-status', 'yellow', upcoming.length + ' próximos');

    const upcomingTotal = upcoming.reduce((s,x) => s + x.amount, 0);
    let body = '<div class="metric-grid"><div class="metric"><div class="metric-label">Suscripciones</div><div class="metric-value">' + subs.length + '</div></div>' +
      '<div class="metric"><div class="metric-label">Total mensual</div><div class="metric-value">$' + monthlyTotal + '</div></div>' +
      '<div class="metric"><div class="metric-label">Próximos 7d</div><div class="metric-value" style="color:' + (upcoming.length > 0 ? 'var(--yellow)' : 'var(--green)') + '">' + upcoming.length + '</div></div>' +
      '<div class="metric"><div class="metric-label">A pagar 7d</div><div class="metric-value">$' + upcomingTotal + '</div></div></div>';

    if (upcoming.length > 0) {
      body += upcoming.map(u => {
        const color = u.days_until <= 2 ? 'down' : u.days_until <= 4 ? 'warn' : 'up';
        return '<div class="row"><div><div class="row-name">' + u.name + '</div><div class="row-detail">' + u.next_charge + '</div></div><span class="row-value ' + color + '">$' + u.amount + ' · ' + u.days_until + 'd</span></div>';
      }).join('');
    } else {
      body += '<div class="empty">Sin cobros en próximos 7 días</div>';
    }
    document.getElementById('billing-body').innerHTML = body;
  } catch(e) {
    setStatus('billing-status', 'red', 'ERROR');
    document.getElementById('billing-body').innerHTML = '<div class="err">' + e.message + '</div>';
  }
}

async function refresh() {
  await Promise.all([loadUptime(), loadSchema(), loadBilling()]);
  const now = new Date();
  document.getElementById('updated').textContent = 'Actualizado: ' + now.toLocaleTimeString('es-AR', {timeZone:'America/Argentina/Buenos_Aires', hour:'2-digit', minute:'2-digit', second:'2-digit'});
}

refresh();
setInterval(refresh, 60000);
</script>
</body>
</html>`;
}




// ════════════════════════════════════════════════════════════════════════
// 🆕 (30-jun-2026 #437) FORUM BET RESOLVER
// Resuelve apuestas publicadas en /foro (forum_posts.bet_data) leyendo
// scores de TheSportsDB (universal, no requiere league mapping).
// Reglas soportadas: Gana Local/Visitante/Empate, Doble 1X/X2/12,
// Más/Menos de N goles, Ambos marcan SÍ/NO.
// "Otro pick personalizado" queda en pending (resolución manual).
// ════════════════════════════════════════════════════════════════════════

const FORUM_PICK_RULES = {
  resolve(scoreH, scoreA, pickText) {
    if (typeof scoreH !== 'number' || typeof scoreA !== 'number') return null;
    const p = String(pickText || '').toLowerCase().trim();
    if (!p) return null;

    // Resultado 1X2
    if (p === 'gana local')                  return scoreH >  scoreA ? 'win' : 'loss';
    if (p === 'gana visitante')              return scoreA >  scoreH ? 'win' : 'loss';
    if (p === 'empate')                      return scoreH === scoreA ? 'win' : 'loss';

    // Doble oportunidad
    if (p === 'doble 1x')                    return scoreH >= scoreA ? 'win' : 'loss';
    if (p === 'doble 12')                    return scoreH !== scoreA ? 'win' : 'loss';
    if (p === 'doble x2')                    return scoreA >= scoreH ? 'win' : 'loss';

    // Goles totales
    const totales = scoreH + scoreA;
    let m;
    if ((m = p.match(/^m[áa]s de (\d+(?:\.\d+)?)\s*goles?$/))) {
      const N = parseFloat(m[1]);
      return totales > N ? 'win' : 'loss';
    }
    if ((m = p.match(/^menos de (\d+(?:\.\d+)?)\s*goles?$/))) {
      const N = parseFloat(m[1]);
      return totales < N ? 'win' : 'loss';
    }

    // BTTS
    if (p === 'ambos marcan sí' || p === 'ambos marcan si')
      return (scoreH >= 1 && scoreA >= 1) ? 'win' : 'loss';
    if (p === 'ambos marcan no')
      return (scoreH === 0 || scoreA === 0) ? 'win' : 'loss';

    // Custom u otros — no resolver auto
    return null;
  }
};

// ── Buscar score en TheSportsDB por nombres de equipos ──
async function _searchScoreTheSportsDB(home, away) {
  if (!home || !away) return null;
  const key = '3'; // public free key
  const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]/g,'');
  const nH = norm(home), nA = norm(away);
  // Tres queries: "home vs away", "away vs home", "home_vs_away"
  const queries = [
    `${home} vs ${away}`,
    `${away} vs ${home}`,
    `${home.replace(/\s+/g,'_')}_vs_${away.replace(/\s+/g,'_')}`,
  ];
  for (const q of queries) {
    try {
      const url = `https://www.thesportsdb.com/api/v1/json/${key}/searchevents.php?e=${encodeURIComponent(q)}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Gambeta-Worker/1.0' } });
      if (!r.ok) continue;
      const data = await r.json().catch(() => ({}));
      const events = data.event || [];
      // Buscar match más reciente con scores finalizados
      for (const ev of events) {
        if (ev.strSport && ev.strSport !== 'Soccer') continue;
        const evH = ev.strHomeTeam || '', evA = ev.strAwayTeam || '';
        const directMatch  = norm(evH) === nH && norm(evA) === nA;
        const swappedMatch = norm(evH) === nA && norm(evA) === nH;
        if (!directMatch && !swappedMatch) continue;
        const sH = parseInt(ev.intHomeScore, 10);
        const sA = parseInt(ev.intAwayScore, 10);
        if (Number.isNaN(sH) || Number.isNaN(sA)) continue;
        const status = (ev.strStatus || '').toLowerCase();
        const isFinished = ['ft','match finished','finished','aet','pen'].some(s => status.includes(s)) || status === '';
        if (!isFinished) continue;
        const out = {
          home: directMatch ? evH : evA,
          away: directMatch ? evA : evH,
          scoreH: directMatch ? sH : sA,
          scoreA: directMatch ? sA : sH,
          src: 'tsdb',
          date: ev.dateEvent || null,
        };
        return out;
      }
    } catch (e) { /* try next query */ }
  }
  return null;
}

async function runForumBetResolver(env) {
  const stats = { ts: new Date().toISOString(), checked: 0, resolved: 0, void: 0, no_score: 0, custom_skipped: 0, errors: [] };
  const skey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!skey) { stats.errors.push('SUPABASE_SERVICE_ROLE_KEY missing'); return stats; }

  // 1) Fetch posts con bet_data.is_bet=true && result=pending, posteados hace >2h y <30d
  const cutoffMin = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(); // máx 30 días atrás
  const cutoffMax = new Date(Date.now() - 2 * 3600 * 1000).toISOString(); // mínimo 2h atrás
  try {
    const q = `${SUPABASE_URL}/rest/v1/forum_posts?bet_data->>is_bet=eq.true&bet_data->>result=eq.pending&created_at=gte.${cutoffMin}&created_at=lte.${cutoffMax}&select=id,thread_id,user_name,bet_data,created_at&limit=200`;
    const r = await fetch(q, { headers: { apikey: skey, Authorization: `Bearer ${skey}` } });
    if (!r.ok) {
      stats.errors.push(`fetch ${r.status}`);
      return stats;
    }
    const posts = await r.json();
    stats.checked = posts.length;

    for (const post of posts) {
      const bd = post.bet_data || {};
      const { home, away, pick } = bd;
      if (!home || !away || !pick) { stats.errors.push(`post ${post.id} missing fields`); continue; }

      // Custom picks: no se resuelven auto
      // Custom: solo skip si es marker __custom__
      if (pick === '__custom__') { stats.custom_skipped++; continue; }

      const score = await _searchScoreTheSportsDB(home, away);
      if (!score) { stats.no_score++; continue; }

      const result = FORUM_PICK_RULES.resolve(score.scoreH, score.scoreA, pick);
      if (result === null) { stats.custom_skipped++; continue; }

      // PATCH forum_posts: actualizar bet_data.result
      const newBetData = {
        ...bd,
        result,
        score_home: score.scoreH,
        score_away: score.scoreA,
        resolved_at: new Date().toISOString(),
        resolved_src: score.src,
      };
      const patch = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?id=eq.${post.id}`, {
        method: 'PATCH',
        headers: { apikey: skey, Authorization: `Bearer ${skey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ bet_data: newBetData }),
      });
      if (patch.ok) {
        stats.resolved++;
      } else {
        stats.errors.push(`patch ${post.id} ${patch.status}`);
      }
    }
  } catch (e) {
    stats.errors.push(`exception: ${e.message}`);
  }
  return stats;
}

// ═══════════════════════════════════════════════════════════════════════════
// 🆕 (18-jul-2026) PICK GENERATOR CRON — genera y lockea los picks del día
// server-side (08:00 ART) sin depender de ningún navegador.
// Réplica FIEL del motor del cliente (buildPredsFromOdds en js/app-core.js).
// ⚠️ Si se cambia la lógica del motor en el cliente, replicar acá (y viceversa).
// Regla de lock: "el primero gana" — solo agrega keys nuevas y sube bvr.
// ═══════════════════════════════════════════════════════════════════════════

const GEN_SPORT_CAT_PRIO = { soccer: 40, tennis: 20, rugby: 10, mma: 10 };
const GEN_LEAGUE_PRIO = {
  soccer_uefa_champs_league: 100, soccer_conmebol_copa_libertadores: 99,
  soccer_argentina_primera_division: 98, soccer_epl: 97, soccer_england_premier_league: 97,
  soccer_brazil_campeonato: 96, soccer_conmebol_copa_sudamericana: 90,
  soccer_spain_la_liga: 88, soccer_italy_serie_a: 86, soccer_germany_bundesliga: 85,
  soccer_france_ligue_one: 78, soccer_uefa_europa_league: 76, soccer_uefa_europa_conference_league: 70,
  soccer_portugal_primeira_liga: 74, soccer_netherlands_eredivisie: 72, soccer_england_championship: 68,
  soccer_belgium_first_div_a: 66, soccer_belgium_first_div: 66, soccer_argentina_primera_nacional: 65,
  soccer_germany_bundesliga2: 64, soccer_colombia_primera_a: 63, soccer_scotland_premiership: 62,
  soccer_mexico_ligamx: 62, soccer_spain_segunda_division: 60, soccer_italy_serie_b: 58,
  soccer_turkey_super_league: 58, soccer_greece_super_league: 56,
  soccer_austria_football_bundesliga: 55, soccer_austria_bundesliga: 55, soccer_usa_mls: 55,
  soccer_ecuador_liga_pro: 54, soccer_ecuador_primera_a: 54, soccer_switzerland_superleague: 32,
  soccer_peru_primera_division: 52, soccer_denmark_superliga: 33, soccer_france_ligue_two: 51,
  soccer_chile_campeonato: 50, soccer_uruguay_primera_division: 50, soccer_poland_ekstraklasa: 33,
  soccer_sweden_allsvenskan: 31, soccer_norway_eliteserien: 30, soccer_paraguay_primera_division: 31,
  soccer_saudi_professional_league: 27, soccer_australia_aleague: 28, soccer_australia_a_league: 28,
  soccer_south_korea_kleague1: 29, soccer_czech_republic_first_league: 30, soccer_czech_liga: 30,
  soccer_japan_j_league: 29, soccer_venezuela_primera_division: 26, soccer_venezuela_primera: 26,
  soccer_bolivia_primera_division: 26, soccer_romania_liga1: 29, soccer_russia_premier_league: 28,
  tennis_atp_french_open: 85, tennis_wta_french_open: 85, tennis_atp_wimbledon: 85,
};
const GEN_TOP_TIER = new Set([
  'soccer_uefa_champs_league', 'soccer_epl', 'soccer_england_premier_league', 'soccer_spain_la_liga',
  'soccer_italy_serie_a', 'soccer_germany_bundesliga', 'soccer_france_ligue_one', 'soccer_uefa_europa_league',
  'soccer_conmebol_copa_libertadores', 'soccer_conmebol_copa_sudamericana', 'soccer_argentina_primera_division',
  'soccer_brazil_campeonato', 'soccer_uefa_europa_conference_league', 'soccer_mexico_ligamx',
  'soccer_netherlands_eredivisie', 'soccer_portugal_primeira_liga', 'soccer_turkey_super_league',
  'soccer_england_championship', 'soccer_argentina_primera_nacional',
]);
const GEN_LEAGUE_CAPS = {
  soccer_argentina_primera_nacional: 5, soccer_argentina_primera_division: 6,
  soccer_england_championship: 3, soccer_germany_bundesliga2: 3, soccer_spain_segunda_division: 3,
  soccer_italy_serie_b: 2, soccer_france_ligue_two: 2, soccer_belgium_first_div_a: 3, soccer_belgium_first_div: 3,
  soccer_portugal_primeira_liga: 2, soccer_netherlands_eredivisie: 3, soccer_scotland_premiership: 2,
  soccer_turkey_super_league: 2, soccer_greece_super_league: 2,
  soccer_austria_football_bundesliga: 2, soccer_austria_bundesliga: 2, soccer_switzerland_superleague: 2,
  soccer_denmark_superliga: 2, soccer_sweden_allsvenskan: 2, soccer_norway_eliteserien: 2,
  soccer_poland_ekstraklasa: 2, soccer_czech_republic_first_league: 2, soccer_czech_liga: 2,
  soccer_romania_liga1: 2, soccer_russia_premier_league: 2,
  soccer_saudi_professional_league: 2, soccer_japan_j_league: 2, soccer_south_korea_kleague1: 2,
  soccer_australia_aleague: 2, soccer_australia_a_league: 2,
};
const GEN_STRICT_CONF = new Set([
  'soccer_colombia_primera_a', 'soccer_ecuador_liga_pro', 'soccer_ecuador_primera_a',
  'soccer_peru_primera_division', 'soccer_venezuela_primera_division', 'soccer_venezuela_primera',
  'soccer_bolivia_primera_division', 'soccer_paraguay_primera_division',
  'soccer_south_korea_kleague1', 'soccer_australia_aleague', 'soccer_australia_a_league', 'soccer_romania_liga1',
]);
const GEN_RELAXED_FLOOR = new Set(['soccer_conmebol_copa_libertadores', 'soccer_conmebol_copa_sudamericana']);
const GEN_SEASON_END_EU = new Set([
  'soccer_italy_serie_a', 'soccer_italy_serie_b', 'soccer_spain_la_liga', 'soccer_spain_segunda_division',
  'soccer_germany_bundesliga', 'soccer_germany_bundesliga2', 'soccer_epl', 'soccer_england_efl_championship',
  'soccer_england_league1', 'soccer_france_ligue_one', 'soccer_france_ligue_two', 'soccer_netherlands_eredivisie',
  'soccer_belgium_first_div_a', 'soccer_belgium_first_div', 'soccer_scotland_premiership',
  'soccer_austria_bundesliga', 'soccer_austria_football_bundesliga', 'soccer_switzerland_superleague',
  'soccer_denmark_superliga', 'soccer_poland_ekstraklasa', 'soccer_czech_liga', 'soccer_czech_republic_first_league',
  'soccer_romania_liga1', 'soccer_greece_super_league', 'soccer_turkey_super_league', 'soccer_portugal_primeira_liga',
]);
const GEN_SEASON_END_SPRING = new Set([
  'soccer_sweden_allsvenskan', 'soccer_norway_eliteserien', 'soccer_russia_premier_league',
  'soccer_usa_mls', 'soccer_south_korea_kleague1', 'soccer_australia_aleague', 'soccer_australia_a_league',
]);
const GEN_SEASON_END_SUD = new Set(['soccer_argentina_primera_division', 'soccer_brazil_campeonato', 'soccer_brazil_serie_b']);

const genGamePrio = k => {
  if (!k) return 0;
  if (GEN_LEAGUE_PRIO[k]) return GEN_LEAGUE_PRIO[k];
  if (k.includes('soccer')) return GEN_SPORT_CAT_PRIO.soccer;
  if (k.includes('basketball')) return 0;
  if (k.includes('tennis')) return GEN_SPORT_CAT_PRIO.tennis;
  if (k.includes('rugby')) return GEN_SPORT_CAT_PRIO.rugby;
  return 5;
};
const GEN_STAGE_BOOST = { final: 60, semi: 35, quarter: 15, r16: 5 };
const genEffPrio = g => genGamePrio(g.sport_key) + (GEN_STAGE_BOOST[g._stage] || 0);

// ── shortNames: UNA sola fuente de verdad (el mapa del cliente), fetcheado y cacheado ──
// Regla CLAUDE.md: nunca duplicar maps de equipos. Se parsea desde el app-core deployado.
async function genShortNamesMap(env) {
  return cached(env, 'gen_shortnames_v2', 24 * 3600, async () => {
    try {
      const html = await (await fetch('https://gambeta.ai/?nc=' + Date.now())).text();
      const mv = html.match(/js\/app-core\.js\?v=\d+/);
      const js = await (await fetch('https://gambeta.ai/' + (mv ? mv[0] : 'js/app-core.js'))).text();
      const mm = js.match(/const teamShortNames = \{([\s\S]*?)\n\};/);
      if (!mm) return {};
      const map = {};
      const re = /'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
      let e;
      while ((e = re.exec(mm[1]))) map[e[1].replace(/\\'/g, "'")] = e[2].replace(/\\'/g, "'");
      return Object.keys(map).length > 50 ? map : {};
    } catch (_) { return {}; }
  });
}
function genShortName(map, name) {
  if (!name) return '';
  if (map && map[name]) return map[name];
  let s = String(name)
    .replace(/\s+(FC|CF|SC|AC|AFC|SFC|RFC|IF|IFK|FK|SK|BK|NK|GNK|BSC|SV|AG|JK|BC)\s*$/i, '')
    .replace(/\s+Calcio\s*(\d{4})?\s*$/i, '').trim();
  s = s.replace(/^(FC|CF|SC|AC|AFC|SFC|RFC|FK|SK|NK|GNK|RB|RC|RCD|AS|CD|SD|UD|CA|CE|SL|US|SS|CS|RS|SK)\s+/i, '').trim();
  const r = s || String(name);
  return r.length > 18 ? r.slice(0, 16) + '…' : r;
}

// Cooldown: equipos con pérdida en los últimos 10 días (ventana 30) — desde historial admin
async function genCooldownTeams(env) {
  const out = new Set();
  try {
    const hist = await fetchAdminHistorial(env);
    const nowMs = Date.now();
    hist.filter(h => h.result === 'loss' && h.commenceTs && (nowMs - h.commenceTs) <= 30 * 86400000)
      .forEach(h => {
        if ((nowMs - h.commenceTs) > 10 * 86400000) return;
        const rec = (h.rec || '').toLowerCase().trim();
        const hN = (h.home || '').toLowerCase().trim();
        const aN = (h.away || '').toLowerCase().trim();
        if (rec === 'gana local' && hN) out.add(hN);
        else if (rec === 'gana visitante' && aN) out.add(aN);
        else if (rec.startsWith('gana ')) {
          const t = rec.replace(/^gana\s+/, '').trim();
          if (hN && (hN === t || hN.includes(t) || t.includes(hN))) out.add(hN);
          else if (aN && (aN === t || aN.includes(t) || t.includes(aN))) out.add(aN);
        }
      });
  } catch (_) {}
  return out;
}

function genLockedKey() {
  const art = new Date(Date.now() - 3 * 3600e3); // hora Argentina
  const d = art.getUTCHours() < 6 ? new Date(art.getTime() - 86400e3) : art;
  return 'locked_picks_v1_' + d.toISOString().slice(0, 10);
}
const genMatchKey = (h, a) => (normTeam(h || '') + '_vs_' + normTeam(a || '')).toLowerCase().replace(/\s+/g, '');

// ── Núcleo del motor (réplica de buildPredsFromOdds) ──
function genEvaluateGame(g, ctx) {
  const { cooldown, cupCtx, lgCtx, relaxed, shortMap, log } = ctx;
  try {
    if ((g.sport_key || '') === 'soccer_fifa_world_cup') return null; // WC: lo maneja wc-matches
    const PRIMARY = ['onexbet', 'betrivers', 'unibet_nl', 'betsson', 'williamhill', 'pinnacle'];
    const FALLBACK = ['nordicbet', 'pmu_fr', 'betonlineag', 'lowvig', 'betanysports', 'betmgm'];
    const ALL_P = [...PRIMARY, ...FALLBACK];
    const hasH2H = b => b.markets && b.markets.some(m => m.key === 'h2h');
    let bmMain = null;
    for (const k of ALL_P) { const f = (g.bookmakers || []).find(b => b.key === k && hasH2H(b)); if (f) { bmMain = f; break; } }
    if (!bmMain) bmMain = (g.bookmakers || []).find(hasH2H);
    const mkt = bmMain && bmMain.markets.find(m => m.key === 'h2h');
    const outs = (mkt && mkt.outcomes) || [];
    const hO = (outs.find(o => o.name === g.home_team) || {}).price || null;
    const aO = (outs.find(o => o.name === g.away_team) || {}).price || null;
    const dO = (outs.find(o => o.name === 'Draw') || {}).price || null;
    const findMkt = key => {
      const mm = bmMain && bmMain.markets.find(m => m.key === key);
      if (mm) return mm;
      for (const k of ALL_P) { const bk = (g.bookmakers || []).find(b => b.key === k); const m2 = bk && bk.markets && bk.markets.find(m => m.key === key); if (m2) return m2; }
      for (const bk of (g.bookmakers || [])) { const m2 = bk.markets && bk.markets.find(m => m.key === key); if (m2) return m2; }
      return null;
    };
    const totalsMkt = findMkt('totals');
    const overOdds = {};
    ((totalsMkt && totalsMkt.outcomes) || []).forEach(o => { if (o.name === 'Over') overOdds[String(o.point)] = o.price; });
    const rawH = hO ? 1 / hO : 0, rawD = dO ? 1 / dO : 0, rawA = aO ? 1 / aO : 0;
    const tot = rawH + rawD + rawA || 1;
    const probH = Math.round(rawH / tot * 100);
    const probD = dO ? Math.round(rawD / tot * 100) : 0;
    const probA = Math.round(rawA / tot * 100);
    const probOver = {};
    ['1.5', '2.5', '3.5'].forEach(pt => { if (overOdds[pt]) probOver[pt] = Math.round(100 / overOdds[pt]); });
    const bttsMkt = findMkt('btts') || findMkt('both_teams_to_score');
    let bttsOddsReal = null, bttsNoOddsReal = null;
    if (bttsMkt) {
      const yes = (bttsMkt.outcomes || []).find(o => /yes|si|sí/i.test(o.name));
      if (yes) bttsOddsReal = yes.price;
      const noO = (bttsMkt.outcomes || []).find(o => /^no$/i.test(String(o.name || '').trim()));
      if (noO) bttsNoOddsReal = noO.price;
    }
    const bttsEst = bttsOddsReal ? Math.round(100 / bttsOddsReal) : null;
    const bttsNoEst = bttsNoOddsReal ? Math.round(100 / bttsNoOddsReal) : null;
    const hN = genShortName(shortMap, g.home_team), aN = genShortName(shortMap, g.away_team);
    const MIN_ODDS = 1.60;
    const isArg = (g.sport_key || '').includes('argentina');
    const isCup = GEN_RELAXED_FLOOR.has(g.sport_key || '');
    const hasFav = (probH >= 62 || probA >= 62);
    const doMin = isCup ? 22 : 25;
    const doInc = (!hasFav || (isCup && probH < 70 && probA < 70)) && (probD >= doMin);
    const prob1X = probH + probD, probX2 = probA + probD;
    const odds1X = (hO > 0 && dO > 0) ? +((hO * dO) / (hO + dO)).toFixed(2) : null;
    const oddsX2 = (aO > 0 && dO > 0) ? +((aO * dO) / (aO + dO)).toFixed(2) : null;
    const cands = [
      { rec: 'Gana ' + hN, prob: probH, odds: hO, _recSide: 'home' },
      { rec: 'Gana ' + aN, prob: probA, odds: aO, _recSide: 'away' },
      ...(dO ? [{ rec: 'Empate', prob: probD, odds: dO, _recSide: 'draw' }] : []),
      ...((doInc && odds1X && odds1X >= 1.60) ? [{ rec: 'Doble 1X', prob: prob1X, odds: odds1X, _recSide: '1x', _isDoubleChance: true }] : []),
      ...((doInc && oddsX2 && oddsX2 >= 1.60) ? [{ rec: 'Doble X2', prob: probX2, odds: oddsX2, _recSide: 'x2', _isDoubleChance: true }] : []),
      ...(isArg ? [] : ['1.5', '2.5'].filter(pt => overOdds[pt] && overOdds[pt] >= MIN_ODDS && (pt !== '2.5' || (probOver[pt] || 0) >= 62))
        .map(pt => ({ rec: 'Más de ' + pt, prob: probOver[pt], odds: overOdds[pt], isTotals: true, line: parseFloat(pt) }))),
      ...(bttsEst ? [{ rec: 'Ambos Marcan', prob: bttsEst, odds: bttsOddsReal, isBtts: true }] : []),
      ...(bttsNoEst ? [{ rec: 'Ambos No Marcan', prob: bttsNoEst, odds: bttsNoOddsReal, isBtts: true, isBttsNo: true }] : []),
    ].filter(c => c.prob > 0).filter(c => c._isDoubleChance || !c.odds || parseFloat(c.odds) >= MIN_ODDS);
    cands.sort((a, b) => {
      if (b.prob !== a.prob) return b.prob - a.prob;
      if (a.isTotals && !b.isTotals) return 1;
      if (!a.isTotals && b.isTotals) return -1;
      if (a.isBtts && !b.isBtts) return 1;
      if (!a.isBtts && b.isBtts) return -1;
      if (a._isDoubleChance && !b._isDoubleChance) return 1;
      if (!a._isDoubleChance && b._isDoubleChance) return -1;
      return 0;
    });
    if (!cands.length) return null;
    let best = cands[0];
    // Franja de cuota 1.70-2.10
    try {
      const inBand = c => { const o = parseFloat(c.odds || 0); return o >= 1.70 && o <= 2.10; };
      const ev = c => (Number(c.prob) / 100) * parseFloat(c.odds || 0);
      if (!inBand(best)) {
        const alt = cands.find(c => c !== best && inBand(c) && Number(c.prob) >= 52 && ev(c) >= Math.max(ev(best) * 0.97, 0.98));
        if (alt) best = alt;
      }
    } catch (_) {}
    // Cup context override
    try {
      const ov = (cupCtx || {})[g.home_team + '|' + g.away_team] || (cupCtx || {})[hN + '|' + aN];
      if (ov && ov.prefer) {
        if (ov.prefer === '1x' && odds1X && odds1X >= 1.35) best = { rec: 'Doble 1X', prob: prob1X, odds: odds1X, _recSide: '1x', _isDoubleChance: true, _cupOverride: true };
        else if (ov.prefer === 'x2' && oddsX2 && oddsX2 >= 1.35) best = { rec: 'Doble X2', prob: probX2, odds: oddsX2, _recSide: 'x2', _isDoubleChance: true, _cupOverride: true };
        else if (ov.prefer === 'empate' && dO) best = { rec: 'Empate', prob: probD, odds: dO, _recSide: 'draw', _cupOverride: true };
      }
    } catch (_) {}
    // League context (motivación asimétrica)
    try {
      const lg = (lgCtx || {})[g.home_team + '|' + g.away_team] || (lgCtx || {})[hN + '|' + aN];
      if (lg && lg.prefer) {
        const s = best._recSide;
        if (lg.prefer === 'avoid_home' && (s === 'home' || s === '1x')) {
          const alt = cands.find(c => c._recSide !== 'home' && c._recSide !== '1x' && c !== best);
          if (alt) best = alt; else return null;
        } else if (lg.prefer === 'avoid_away' && (s === 'away' || s === 'x2')) {
          const alt = cands.find(c => c._recSide !== 'away' && c._recSide !== 'x2' && c !== best);
          if (alt) best = alt; else return null;
        }
      }
    } catch (_) {}
    // Empate como pick de valor
    if (best._recSide !== 'draw' && !best._cupOverride && dO && probD >= 28 && probH < 48 && probA < 48 && dO >= 3.00) {
      if ((probD / 100) * dO >= 1.02) best = { rec: 'Empate', prob: probD, odds: dO, _recSide: 'draw', _evOverride: true };
    }
    const maxProb = best.prob || probH;
    const isStrict = GEN_STRICT_CONF.has(g.sport_key || '');
    const minProb = isStrict ? 62 : (isCup ? 50 : 55);
    let conf;
    if (maxProb >= 62) conf = 'high';
    else if (isStrict) { log.push('reject liga-estricta: ' + g.home_team + ' vs ' + g.away_team + ' prob ' + maxProb); return null; }
    else if (maxProb >= 58) conf = 'med';
    else if (maxProb >= minProb) conf = 'low';
    else { log.push('reject piso-prob: ' + g.home_team + ' vs ' + g.away_team + ' | ' + best.rec + ' prob ' + maxProb + ' piso ' + minProb); return null; }
    let rawBvr;
    if (best._isDoubleChance && conf === 'high') rawBvr = 5;
    else if (best._isDoubleChance && conf === 'med') rawBvr = 4;
    else if (conf === 'high' && maxProb >= 75) rawBvr = 6;
    else if (conf === 'high') rawBvr = 5;
    else if (conf === 'med') rawBvr = 4;
    else rawBvr = 3;
    let bvr = (GEN_TOP_TIER.has(g.sport_key || '') || rawBvr < 6) ? rawBvr : 5;
    if (bvr < 4) { log.push('reject bvr<4: ' + g.home_team + ' vs ' + g.away_team); return null; }
    { const bo = parseFloat(best.odds || 0);
      if (bo && bo < 1.50 && bvr < 6 && !relaxed) { log.push('reject franja-muerta: ' + g.home_team + ' vs ' + g.away_team + ' @' + bo); return null; } }
    const bvrText = bvr === 6 ? 'Máxima' : bvr === 5 ? 'Alta' : bvr === 4 ? 'Media-Alta' : 'Media';
    if (bvr === 6 || bvr === 5) conf = 'high'; else if (bvr === 4) conf = 'med';
    if (best._recSide === 'home' && bvr < 5) return null;
    if (best._recSide === 'home' && parseFloat(best.odds) < 1.60 && bvr < 6) return null;
    // Fin de temporada (asimetría de motivación)
    const m = new Date(g.commence_time).getUTCMonth();
    const sk = g.sport_key || '';
    const isEOS = (GEN_SEASON_END_EU.has(sk) && (m === 4 || m === 5)) ||
                  (GEN_SEASON_END_SPRING.has(sk) && (m === 9 || m === 10)) ||
                  (GEN_SEASON_END_SUD.has(sk) && (m === 10 || m === 11));
    if (isEOS) {
      if (best._isDoubleChance) return null;
      if ((best._recSide === 'home' || best._recSide === 'away') && bvr < 6) return null;
    }
    // Cooldown
    if (cooldown.has(hN.toLowerCase().trim()) || cooldown.has(aN.toLowerCase().trim())) {
      log.push('cooldown: ' + hN + ' vs ' + aN); return null;
    }
    return {
      home: hN, away: aN, homeRaw: g.home_team, awayRaw: g.away_team,
      rec: best.rec, _recSide: best._recSide || null, conf, bvr, bvrText,
      probH, probD, probA, _hO: hO, _dO: dO, _aO: aO, _bestOdds: best.odds,
      commenceTs: new Date(g.commence_time).getTime(), _sportKey: sk,
    };
  } catch (e) { ctx.log.push('error ' + (g && g.home_team) + ': ' + e.message); return null; }
}

function genSelectCandidates(games, relaxed) {
  const now = Date.now();
  const hasH2HData = g => g.bookmakers && g.bookmakers.some(b => b.markets && b.markets.some(m => m.key === 'h2h'));
  const sortP = (a, b) => { const pa = genEffPrio(a), pb = genEffPrio(b); if (pa !== pb) return pb - pa; return new Date(a.commence_time) - new Date(b.commence_time); };
  const applyCaps = gs => { const c = {}; return gs.filter(g => { const sk = g.sport_key || ''; if (!(sk in GEN_LEAGUE_CAPS)) return true; c[sk] = (c[sk] || 0) + 1; return c[sk] <= GEN_LEAGUE_CAPS[sk]; }); };
  const TOP_PRIO = GEN_LEAGUE_PRIO.soccer_conmebol_copa_libertadores;
  let candidates = [];
  for (const hours of [24, 48, 72, 120, 168]) {
    const end = now + hours * 3600000;
    const base = g => { const t = new Date(g.commence_time).getTime(); return t > now && t <= end && !(g.sport_key || '').includes('basketball') && hasH2HData(g); };
    const top = games.filter(base).filter(g => genEffPrio(g) >= 90).sort(sortP).slice(0, 20);
    const eur = applyCaps(games.filter(base).filter(g => { const p = genEffPrio(g); return p >= 60 && p < 90; }).sort(sortP)).slice(0, 25);
    const rest = applyCaps(games.filter(base).filter(g => genEffPrio(g) < 60).sort(sortP)).slice(0, 20);
    candidates = [...top, ...eur, ...rest];
    const bestPrio = candidates.length ? genEffPrio(candidates[0]) : 0;
    const minC = relaxed ? 12 : 2;
    if (candidates.length >= minC && (hours >= 48 || bestPrio >= TOP_PRIO)) break;
  }
  if (!candidates.length) {
    candidates = games.filter(g => new Date(g.commence_time).getTime() > now).filter(hasH2HData)
      .filter(g => !(g.sport_key || '').includes('basketball')).sort(sortP).slice(0, 18);
  }
  return candidates;
}

// Intel + ajuste de confianza (réplica de _adjust del cliente, con valor de plantel)
async function genApplyIntel(p, env) {
  const q = { home: p.homeRaw, away: p.awayRaw, sportKey: p._sportKey, ts: String(p.commenceTs || '') };
  const leagueOk = _getApfLeagueIdForSportKey(q.sportKey);
  if (!leagueOk) return;
  const cacheKey = `pickintel_v7_${normTeam(q.home)}_${normTeam(q.away)}_${String(p.commenceTs || '').slice(0, 8)}`;
  const intel = await cached(env, cacheKey, 6 * 3600, async () => {
    let d = await fetchPickIntel(q, env).catch(e => ({ error: String(e && e.message || e) }));
    if (d && d.error) { const t = await fetchPickIntelTsdb(q, env).catch(() => null); if (t && !t.error) d = t; }
    return d;
  }).catch(() => null);
  if (!intel || intel.error) return;
  const side = p._recSide;
  let score = 0;
  const injH = (intel.injuries && intel.injuries.home && intel.injuries.home.count) || 0;
  const injA = (intel.injuries && intel.injuries.away && intel.injuries.away.count) || 0;
  if (side === 'home') score += (injA - injH) * 0.5;
  if (side === 'away') score += (injH - injA) * 0.5;
  const hh = intel.h2h || {};
  if (hh.n >= 4) {
    const wr = side === 'home' ? hh.homeW / hh.n : side === 'away' ? hh.awayW / hh.n : hh.draw / hh.n;
    if (wr >= 0.6) score += 1; else if (wr <= 0.2) score -= 1;
    if (side === 'home' && hh.homeAtHome && hh.homeAtHome.n >= 3) {
      const wrl = hh.homeAtHome.w / hh.homeAtHome.n;
      if (wrl >= 0.65) score += 1; else if (wrl <= 0.2) score -= 1;
    }
  }
  const fp = f => (String(f || '').match(/W/g) || []).length;
  if ((side === 'home' || side === 'away') && intel.form) {
    const own = fp(side === 'home' ? intel.form.home : intel.form.away);
    const riv = fp(side === 'home' ? intel.form.away : intel.form.home);
    if (own - riv >= 3) score += 1; else if (riv - own >= 3) score -= 1;
  }
  const sv = intel.squadValue || null;
  const vSide = (side === 'home' || side === '1x') ? 'home' : (side === 'away' || side === 'x2') ? 'away' : null;
  if (sv && sv.home && sv.away && vSide) {
    const rOwn = vSide === 'home' ? (sv.home / sv.away) : (sv.away / sv.home);
    if (rOwn >= 1.8) score += 1; else if (rOwn <= 0.55) score -= 1;
  }
  if (score <= -2 && p.bvr > 3) {
    p.bvr = p.bvr - 1;
    p.bvrText = p.bvr >= 6 ? 'Máxima' : p.bvr === 5 ? 'Alta' : p.bvr === 4 ? 'Media-Alta' : 'Media';
    p.conf = (p.bvr >= 5) ? 'high' : (p.bvr === 4) ? 'med' : 'low';
  }
}

async function genSaveLockedPicks(env, picks) {
  const skey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!skey) throw new Error('sin SUPABASE_SERVICE_ROLE_KEY');
  const key = genLockedKey();
  const H = { apikey: skey, Authorization: 'Bearer ' + skey, 'Content-Type': 'application/json' };
  const getR = await fetch(SUPABASE_URL + '/rest/v1/shared_cache?key=eq.' + encodeURIComponent(key) + '&select=data', { headers: H });
  const rows = await getR.json().catch(() => []);
  const existing = (Array.isArray(rows) && rows[0] && rows[0].data) || {};
  const merged = { ...existing };
  let added = 0, upgraded = 0;
  for (const p of picks) {
    if (p._sportKey === 'soccer_fifa_world_cup') continue;
    const mk = genMatchKey(p.home, p.away);
    const entry = {
      conf: p.conf, bvr: p.bvr, bvrText: p.bvrText, rec: p.rec,
      bestOdds: p._bestOdds, hO: p._hO, aO: p._aO, dO: p._dO,
      probH: p.probH, probD: p.probD, probA: p.probA,
      home: p.home || null, away: p.away || null,
      commenceTs: p.commenceTs || null, sportKey: p._sportKey || null,
    };
    if (!merged[mk]) { merged[mk] = entry; added++; }
    else if ((p.bvr || 0) > (merged[mk].bvr || 0)) { merged[mk] = { ...merged[mk], ...entry }; upgraded++; }
  }
  if (!added && !upgraded) return { key, added, upgraded, total: Object.keys(merged).length };
  if (Array.isArray(rows) && rows.length > 0) {
    const pr = await fetch(SUPABASE_URL + '/rest/v1/shared_cache?key=eq.' + encodeURIComponent(key), {
      method: 'PATCH', headers: H, body: JSON.stringify({ data: merged, fetched_at: new Date().toISOString() }),
    });
    if (!pr.ok) throw new Error('PATCH shared_cache ' + pr.status);
  } else {
    const po = await fetch(SUPABASE_URL + '/rest/v1/shared_cache', {
      method: 'POST', headers: { ...H, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ key, data: merged, fetched_at: new Date().toISOString() }),
    });
    if (!po.ok) throw new Error('POST shared_cache ' + po.status);
  }
  return { key, added, upgraded, total: Object.keys(merged).length };
}

async function genAlertEmail(env, stats, severity) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Gambeta Motor <no-reply@gambeta.ai>',
        to: ['pronosticosarg@gmail.com'],
        subject: severity === 'error' ? '🔴 Generador de picks: FALLÓ' : '🟡 Generador de picks: aviso',
        html: '<div style="font-family:sans-serif;max-width:560px"><h2>Generador de picks (cron 08:00 ART)</h2>' +
          '<pre style="background:#f5f5f5;padding:12px;border-radius:8px;font-size:12px">' +
          JSON.stringify(stats, null, 2).replace(/</g, '&lt;') + '</pre>' +
          '<p style="font-size:12px;color:#999">Auto-generado. Solo recibís mail si algo requiere tu atención.</p></div>',
      }),
    });
    return r.ok;
  } catch (_) { return false; }
}

async function runScheduledPickGenerator(env) {
  const stats = { ts: new Date().toISOString(), lockKey: genLockedKey(), odds: 0, candidates: 0, generated: 0, relaxed: false, saved: null, rejects: [], errors: [] };
  try {
    // 1) Cuotas (misma caché horaria que /odds, sin confiar en vacíos)
    const hourKey = new Date().toISOString().slice(0, 13);
    const cats = [['main', LEAGUES_MAIN], ['europe', LEAGUES_EUROPE], ['secondary', LEAGUES_SECONDARY]];
    let games = [];
    for (const [cat, leagues] of cats) {
      let res = await cached(env, `odds10_${cat}_${hourKey}`, 3600, () => getLeagueData(env, leagues)).catch(() => null);
      if (!res || !res.data || !res.data.length) {
        try { const fresh = await getLeagueData(env, leagues); if (fresh && fresh.data && fresh.data.length) res = fresh; } catch (_) {}
      }
      if (res && res.data) games = games.concat(res.data);
    }
    // dedupe partidos por equipos+kickoff
    { const seen = new Set(); games = games.filter(g => { const k = (g.home_team || '') + '|' + (g.away_team || '') + '|' + (g.commence_time || ''); if (seen.has(k)) return false; seen.add(k); return true; }); }
    stats.odds = games.length;
    if (!games.length) { stats.errors.push('feed de cuotas VACÍO (las 3 categorías)'); throw new Error('odds vacías'); }

    // 2) Contexto
    const shortMap = await genShortNamesMap(env);
    const cooldown = await genCooldownTeams(env);
    const dayKey = new Date().toISOString().slice(0, 10);
    const cupCtx = await cached(env, `cup_context_v2_${dayKey}`, 21600, () => computeCupContext(env)).catch(() => ({}));
    const lgCtx = await cached(env, `league_context_v2_${dayKey}`, 43200, () => computeLeagueContext(env)).catch(() => ({}));

    // 3) Motor: pase estricto → relajado si 0
    const runPass = relaxed => {
      const cList = genSelectCandidates(games, relaxed);
      if (relaxed === false) stats.candidates = cList.length;
      const ctx = { cooldown, cupCtx, lgCtx, relaxed, shortMap, log: stats.rejects };
      return cList.map(g => genEvaluateGame(g, ctx)).filter(Boolean);
    };
    let picks = runPass(false);
    if (!picks.length) { stats.relaxed = true; picks = runPass(true); }
    stats.generated = picks.length;

    // 4) Intel: ajusta confianza (secuencial, máx 8 por el rate de APF)
    for (const p of picks.slice(0, 8)) { try { await genApplyIntel(p, env); } catch (_) {} }

    // 5) Lock en Supabase ("el primero gana")
    if (picks.length) stats.saved = await genSaveLockedPicks(env, picks);

    // 6) Registro para inspección posterior
    try { await env.CACHE_KV?.put('gen_last_run', JSON.stringify(stats), { expirationTtl: 7 * 86400 }); } catch (_) {}
  } catch (e) {
    stats.errors.push(String(e && e.message || e));
  }
  stats.rejects = stats.rejects.slice(0, 25);
  // Alerta: error duro siempre; aviso si con 5+ candidatos no salió ningún pick
  if (stats.errors.length) await genAlertEmail(env, stats, 'error');
  else if (!stats.generated && stats.candidates >= 5) await genAlertEmail(env, stats, 'warn');
  return stats;
}


// ═══════════════════════════════════════════════════════════════════════════
// 🆕 (22-jul-2026) MAIL DIARIO DE RESULTADOS DE LA IA
// Resumen de las últimas 24h: aciertos/fallos, balance stake $100, winrate 7d
// y picks pendientes. Corre en el cron de 12:00 UTC (09:00 ART) junto al billing.
// Solo manda mail si hubo al menos 1 resultado (no spamea días muertos).
// Test manual: GET /email-results (preview JSON) · /email-results?send=1 (envía)
// ═══════════════════════════════════════════════════════════════════════════
async function buildResultsEmailData(env) {
  const hist = await fetchAdminHistorial(env);
  const now = Date.now();
  const resolvedRecent = hist.filter(h => {
    if (!h || !['win', 'loss', 'void'].includes(h.result)) return false;
    const rAt = h.resolvedAt || (h.commenceTs ? h.commenceTs + 2 * 3600e3 : 0);
    return rAt && (now - rAt) <= 24 * 3600e3;
  });
  const pendingSoon = hist.filter(h => h && (!h.result || h.result === 'pending')
    && h.commenceTs && h.commenceTs > now - 6 * 3600e3 && h.commenceTs < now + 36 * 3600e3);
  const _odds = h => parseFloat(h._bestOdds || h.bestOdds || (typeof h.odds === 'number' ? h.odds : 0)) || null;
  let profit = 0, w = 0, l = 0, v = 0;
  const rows = resolvedRecent.map(h => {
    const o = _odds(h);
    let p = 0;
    if (h.result === 'win') { w++; p = o ? Math.round((o - 1) * 100) : 0; }
    else if (h.result === 'loss') { l++; p = -100; }
    else v++;
    profit += p;
    return {
      emoji: h.result === 'win' ? '✅' : h.result === 'loss' ? '❌' : '⚪',
      match: (h.home || '?') + (h.finalScore ? ' ' + h.finalScore + ' ' : ' vs ') + (h.away || '?'),
      rec: h.rec || '', odds: o, delta: p,
    };
  });
  const res7 = hist.filter(h => h && ['win', 'loss'].includes(h.result) && h.commenceTs && (now - h.commenceTs) <= 7 * 86400e3);
  const w7 = res7.filter(h => h.result === 'win').length;
  return {
    rows, w, l, v, profit, w7, n7: res7.length,
    pct7: res7.length ? Math.round(w7 / res7.length * 100) : null,
    pending: pendingSoon.map(h => ({ match: (h.home || '?') + ' vs ' + (h.away || '?'), rec: h.rec || '', ts: h.commenceTs || null })),
  };
}

async function runResultsEmail(env, force) {
  const d = await buildResultsEmailData(env);
  if (!d.rows.length && !force) return { sent: false, reason: 'sin resultados en 24h' };
  if (!env.RESEND_API_KEY) return { sent: false, reason: 'sin RESEND_API_KEY' };
  const fmtART = ts => { const dt = new Date(ts - 3 * 3600e3); return dt.toISOString().slice(11, 16); };
  const rowsHtml = d.rows.map(r =>
    '<tr><td style="padding:7px 8px;font-size:16px">' + r.emoji + '</td>' +
    '<td style="padding:7px 8px"><b>' + r.match + '</b><br><span style="color:#777;font-size:12px">' + r.rec + (r.odds ? ' @' + r.odds : '') + '</span></td>' +
    '<td style="padding:7px 8px;text-align:right;font-weight:700;color:' + (r.delta >= 0 ? '#0a8f3c' : '#c62828') + '">' + (r.delta >= 0 ? '+' : '') + '$' + r.delta + '</td></tr>'
  ).join('');
  const pendHtml = d.pending.length
    ? '<p style="margin:18px 0 6px;font-weight:700">⏳ Picks en juego / próximos</p>' +
      d.pending.map(p => '<div style="font-size:13px;color:#444;padding:2px 0">• ' + p.match + ' — ' + p.rec + (p.ts ? ' (' + fmtART(p.ts) + ' ART)' : '') + '</div>').join('')
    : '';
  const html = '<div style="font-family:sans-serif;max-width:560px;margin:auto">' +
    '<h2 style="margin-bottom:4px">⚽ Resultados de la IA</h2>' +
    '<p style="color:#666;margin-top:0">Últimas 24 horas · gambeta.ai</p>' +
    '<div style="background:#f6f8f6;border-radius:10px;padding:12px 16px;margin:12px 0;font-size:14px">' +
    '<b>' + d.w + '</b> acierto' + (d.w === 1 ? '' : 's') + ' · <b>' + d.l + '</b> fallo' + (d.l === 1 ? '' : 's') + (d.v ? ' · ' + d.v + ' anulado' + (d.v === 1 ? '' : 's') : '') +
    ' — balance <b style="color:' + (d.profit >= 0 ? '#0a8f3c' : '#c62828') + '">' + (d.profit >= 0 ? '+' : '') + '$' + d.profit + '</b> <span style="color:#888">(stake $100)</span>' +
    (d.pct7 != null ? '<br>Últimos 7 días: <b>' + d.pct7 + '%</b> de acierto (' + d.w7 + '/' + d.n7 + ')' : '') +
    '</div>' +
    '<table style="width:100%;border-collapse:collapse;font-size:14px">' + rowsHtml + '</table>' +
    pendHtml +
    '<p style="font-size:12px;color:#999;border-top:1px solid #eee;padding-top:12px;margin-top:20px">Auto-generado 09:00 ART · <a href="https://gambeta.ai/#resultados" style="color:#0a8f3c">Ver historial completo</a></p>' +
    '</div>';
  const subject = '⚽ IA: ' + d.w + '✅ ' + d.l + '❌ · ' + (d.profit >= 0 ? '+' : '') + '$' + d.profit;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Gambeta IA <no-reply@gambeta.ai>', to: ['pronosticosarg@gmail.com'], subject, html }),
    });
    return { sent: r.ok, status: r.status, w: d.w, l: d.l, profit: d.profit };
  } catch (e) { return { sent: false, reason: String(e && e.message || e) }; }
}


export default {
  async scheduled(controller, env, ctx) {
    // Cron handler — multiple crons distinguished by controller.cron string
    const cronExpr = controller.cron;
    if (cronExpr === '*/15 * * * *') {
      // ── Cada 15min: Uptime Monitor (anti-flap, 2 fallas confirma OUTAGE) ──
      const stats = await runUptimeMonitor(env);
      console.log('[cron-uptime-monitor]', JSON.stringify({
        ts: stats.ts,
        targets: stats.targets_count,
        events: stats.events.length,
        alert: stats.alert,
      }));
    } else if (cronExpr === '0 12 * * *') {
      // ── Diario 12:00 UTC (09:00 ART): Billing Monitor pre-vencimiento ──
      // 🆕 (22-jul) + Mail de resultados de la IA (últimas 24h)
      try {
        const mail = await runResultsEmail(env);
        console.log('[cron-results-email]', JSON.stringify(mail));
      } catch (e) { console.error('[cron-results-email] error', e.message); }
      const stats = await runBillingMonitor(env);
      console.log('[cron-billing-monitor]', JSON.stringify({
        ts: stats.ts,
        upcoming: stats.upcoming_in_7d.length,
        monthly_total: stats.monthly_total,
        alert: stats.alert,
      }));
    } else if (cronExpr === '0 6 * * 1') {
      // ── Lunes 06:00 UTC (03:00 ART): Schema Monitor anti-regresión ──
      const stats = await runSchemaMonitor(env);
      console.log('[cron-schema-monitor]', JSON.stringify({
        ts: stats.ts,
        critical: stats.findings_by_severity.critical,
        medium: stats.findings_by_severity.medium,
        new_bugs: stats.new_count,
        alert: stats.alert,
      }));
    } else if (cronExpr === '0 11 * * *') {
      // ── 🆕 (18-jul) Diario 11:00 UTC (08:00 ART): GENERADOR DE PICKS server-side ──
      // Genera y lockea los picks del día sin depender de ningún navegador.
      const stats = await runScheduledPickGenerator(env);
      console.log('[cron-pick-generator]', JSON.stringify({
        ts: stats.ts, odds: stats.odds, candidates: stats.candidates,
        generated: stats.generated, relaxed: stats.relaxed, saved: stats.saved, errors: stats.errors,
      }));
    } else if (cronExpr === '0 */6 * * *') {
      // Every 6h: update odds for pending picks
      const stats = await runOddsUpdater(env);
      console.log('[cron-odds]', JSON.stringify(stats));
    } else if (cronExpr === '0 0,12 * * *') {
      // 0:00 + 12:00: chequeo de escudos faltantes
      const stats = await runEscudosChecker(env);
      console.log('[cron-escudos]', JSON.stringify(stats));
    } else {
      // Default (0 * * * * — hourly): resolve completed picks
      const stats = await runScheduledResolver(env);
      console.log('[cron-resolver]', JSON.stringify(stats));
      // Publicar WC2026 futures el 6-jun (sólo se inserta una vez)
      const wcStats = await runWcFuturesPublisher(env);
      console.log('[cron-wc-futures]', JSON.stringify(wcStats));
      const wcMatchesStats = await runWcMatchesPublisher(env);
      console.log('[cron-wc-matches]', JSON.stringify(wcMatchesStats));
      const wcAutoGenStats = await runWcAutoGenerate(env);
      console.log('[cron-wc-auto-gen]', JSON.stringify(wcAutoGenStats));
      // 🆕 (30-jun-2026 #437) Forum bet resolver
      const fbStats = await runForumBetResolver(env);
      console.log('[cron-forum-bets]', JSON.stringify(fbStats));
    }
  },
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── 🆕 (9-jul-2026) /api/sb?type=historial — mirror del Pages Function /api/sb
    // Fallback anti-adblock para accesoia.app (api.accesoia.app apunta a este worker,
    // los adblockers bloquean gambeta.ai pero no el dominio propio). Usado por live.js.
    if (path === '/api/sb' && request.method === 'GET') {
      const sbType = url.searchParams.get('type');
      if (sbType !== 'historial') {
        return new Response(JSON.stringify({ error: `unknown type: ${sbType}` }), { status: 400, headers: CORS });
      }
      try {
        const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
        const sbFetch = (p) => fetch(`${SUPABASE_URL}/rest/v1/${p}`, {
          headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
        });
        const [r1, r2] = await Promise.allSettled([
          sbFetch(`shared_cache?key=eq.global_historial_v1&select=data&limit=1`),
          sbFetch(`acoin_users?email=eq.${encodeURIComponent(ADMIN_EMAIL)}&select=historial_full&limit=1`),
        ]);
        let fromCache = [], fromUsers = [];
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
        const merged = new Map();
        const rankResult = (p) => (p && p.result && p.result !== 'pending') ? 1 : 0;
        const addPick = (p) => {
          if (!p || !p.id) return;
          const existing = merged.get(p.id);
          if (!existing || rankResult(p) > rankResult(existing)) merged.set(p.id, p);
        };
        fromCache.forEach(addPick);
        fromUsers.forEach(addPick);
        const merged_all = Array.from(merged.values());
        return new Response(
          JSON.stringify(merged_all.length > 0 ? [{ historial_full: merged_all }] : []),
          { headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30, s-maxage=60' } }
        );
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── 🆕 /api/lead-signup — captura de leads desde landings Mundial ──
    if (path === '/api/lead-signup' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        const email = (body.email || '').trim().toLowerCase();
        const source = (body.source || 'mundial-landing').toString().slice(0, 80);
        const landing = (body.landing || '').toString().slice(0, 80);

        // Validación básica de email
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return new Response(JSON.stringify({ ok: false, error: 'email_invalido' }),
            { status: 400, headers: CORS });
        }

        let sendxOk = false;
        let sendxError = null;

        // Intentar SendX si está configurado (header correcto: X-Team-ApiKey)
        if (env.SENDX_API_TOKEN) {
          try {
            const sendxRes = await fetch('https://api.sendx.io/api/v1/rest/contact', {
              method: 'POST',
              headers: {
                'X-Team-ApiKey': env.SENDX_API_TOKEN,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                email: email,
                firstName: landing || 'mundial-lead',
                tags: ['mundial-2026', source, landing].filter(Boolean),
                lists: ['list_vy9qvGKzQrWLzSAv5dC434']
              })
            });
            sendxOk = sendxRes.ok;
            if (!sendxOk) {
              const errText = await sendxRes.text().catch(() => '');
              sendxError = `sendx_${sendxRes.status}: ${errText.slice(0, 200)}`;
            }
          } catch (e) {
            sendxError = `sendx_exception: ${e.message}`;
          }
        } else {
          sendxError = 'sendx_no_config';
        }

        // Backup: mandar email a Mauro con el lead vía Resend
        if (env.RESEND_API_KEY) {
          try {
            await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${env.RESEND_API_KEY}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                from: 'gambeta.ai <no-reply@gambeta.ai>',
                to: ['pronosticosarg@gmail.com'],
                subject: `🎯 Nuevo lead Mundial: ${email}`,
                html: `<div style="font-family:Arial,sans-serif">
                  <h2>🎯 Nuevo lead desde landing Mundial</h2>
                  <p><b>Email:</b> ${email}</p>
                  <p><b>Landing:</b> ${landing || 'desconocida'}</p>
                  <p><b>Source:</b> ${source}</p>
                  <p><b>SendX status:</b> ${sendxOk ? '✅ agregado' : '⚠️ ' + (sendxError || 'fallo')}</p>
                  <p style="color:#666;font-size:12px;margin-top:20px">Cargalo manualmente si SendX falló.</p>
                </div>`
              })
            });
          } catch (e) {
            console.error('Resend backup error:', e);
          }
        }

        return new Response(JSON.stringify({
          ok: true,
          sendx: sendxOk ? 'subscribed' : 'fallback_email_sent',
          redirect: '/eleccion'
        }), { headers: CORS });
      } catch (e) {
        console.error('lead-signup error:', e);
        return new Response(JSON.stringify({ ok: false, error: e.message }),
          { status: 500, headers: CORS });
      }
    }

    // ── 🆕 /api/leads-stats — conteo agregado de leads Mundial por landing ──
    if (path === '/api/leads-stats' && request.method === 'GET') {
      if (!env.SENDX_API_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: 'sendx_no_config' }),
          { status: 503, headers: CORS });
      }
      const LIST_ID = 'list_vy9qvGKzQrWLzSAv5dC434';
      try {
        // Pedir hasta 1000 contactos
        const res = await fetch('https://api.sendx.io/api/v1/rest/contact?limit=1000', {
          headers: { 'X-Team-ApiKey': env.SENDX_API_TOKEN }
        });
        if (!res.ok) {
          return new Response(JSON.stringify({ ok: false, error: 'sendx_' + res.status }),
            { status: 502, headers: CORS });
        }
        const contacts = await res.json();
        // Filtrar solo los que están en la lista Mundial
        const mundial = contacts.filter(c => Array.isArray(c.lists) && c.lists.includes(LIST_ID));
        // Contar por tag de landing
        const byLanding = { 'predicciones-ia': 0, 'calendario-ia': 0, 'estadisticas-ia': 0, otros: 0 };
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        const last7Days = [0,0,0,0,0,0,0];  // dia 0 = hoy
        let total = mundial.length;
        for (const c of mundial) {
          // Por landing: leer de tags array (preferido) o firstName fallback
          let lan = null;
          if (Array.isArray(c.tags)) {
            for (const t of c.tags) {
              if (byLanding[t] !== undefined && t !== 'otros') { lan = t; break; }
            }
          }
          if (!lan && c.firstName && byLanding[c.firstName] !== undefined) lan = c.firstName;
          if (!lan && c.pageSource && byLanding[c.pageSource] !== undefined) lan = c.pageSource;
          if (lan) byLanding[lan]++;
          else byLanding.otros++;
          // Por fecha
          if (c.created) {
            const t = new Date(c.created).getTime();
            const dayDiff = Math.floor((now - t) / oneDay);
            if (dayDiff >= 0 && dayDiff < 7) last7Days[dayDiff]++;
          }
        }
        return new Response(JSON.stringify({
          ok: true,
          total: total,
          today: last7Days[0],
          last7Days: last7Days,
          byLanding: byLanding,
          generated_at: new Date().toISOString()
        }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }),
          { status: 500, headers: CORS });
      }
    }

    // ── /available ───────────────────────────────────────────────────────────
    if (path === '/available') {
      const keys = [...LEAGUES_MAIN, ...LEAGUES_EUROPE, ...LEAGUES_SECONDARY].map(([k]) => k);
      return new Response(JSON.stringify({ keys }), { headers: CORS });
    }

    // ── 🆕 (18-jul) GET /tm-value?team=X — debug del fetch de valor de plantel TM ──
    if (path === '/tm-value') {
      const team = url.searchParams.get('team') || '';
      if (!team) return new Response(JSON.stringify({ error: 'missing team' }), { status: 400, headers: CORS });
      const dbg = { team, variants: _tmQueryVariants(team) };
      dbg.result = await _tmTeamValue(team, env).catch(e => ({ err: String(e && e.message || e) }));
      dbg.parsed = dbg.result && dbg.result.valM || null;
      dbg.clubMatch = dbg.result && dbg.result.tmId || null;
      return new Response(JSON.stringify(dbg), { headers: CORS });
    }

    // ── 🆕 (13-jul-2026) GET /pick-intel?home=&away=&sportKey=&ts= ──
    // Bajas + H2H + forma reales (API-Football) para el motor de picks y el razonamiento.
    if (path === '/pick-intel') {
      const q = {
        home:     url.searchParams.get('home') || '',
        away:     url.searchParams.get('away') || '',
        sportKey: url.searchParams.get('sportKey') || '',
        ts:       url.searchParams.get('ts') || '',
        debug:    url.searchParams.get('debug') === '1',
      };
      if (!q.home || !q.away || !q.sportKey) {
        return new Response(JSON.stringify({ error: 'missing params (home, away, sportKey)' }), { status: 400, headers: CORS });
      }
      const cacheKey = `pickintel_v7_${normTeam(q.home)}_${normTeam(q.away)}_${(q.ts || '').slice(0, 8)}`;
      const _getIntel = async () => {
        let d = await fetchPickIntel(q, env).catch(e => ({ error: String(e && e.message || e) }));
        if (d && d.error) {
          // APF sin acceso (plan free / rate limit / sin fixture) → fallback TSDB
          const t = await fetchPickIntelTsdb(q, env).catch(e => ({ error: String(e && e.message || e) }));
          if (t && !t.error) { t._apfError = d.error; d = t; }
        }
        return d;
      };
      const data = q.debug ? await _getIntel() : await cached(env, cacheKey, 6 * 3600, _getIntel);
      return new Response(JSON.stringify(data || { error: 'no-data' }), { headers: CORS });
    }

    // ── 🆕 (25-jun-2026) GET /wc-pick?id=X ──
    // Endpoint público que devuelve el pick actual del wc-matches.js para que
    // los blogs lo lean en tiempo real (anti-desync). CORS habilitado.
    if (path === '/wc-pick') {
      const id = url.searchParams.get('id');
      if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: CORS });
      const pick = WC_MATCHES.find(p => p && p.id === id);
      if (!pick) return new Response(JSON.stringify({ error: 'pick not found', id }), { status: 404, headers: CORS });
      // Sólo los campos públicos relevantes para el blog (no exponemos stake/_recSide/etc internos)
      const out = {
        id: pick.id,
        home: pick.home,
        away: pick.away,
        rec: pick.rec,
        odds: pick.odds,
        bvr: pick.bvr,
        bvrText: pick.bvrText,
        conf: pick.conf,
        insight: pick.insight,
        commenceTs: pick.commenceTs,
      };
      return new Response(JSON.stringify(out), { headers: { ...CORS, 'Cache-Control': 'public, max-age=300' } });
    }

    // ── 🆕 (25-jun-2026 ETAPA 3 MP v2) POST /mp/subscribe — lead capture MP a SendX ──
    // Usa MISMO formato que Gambeta (X-Team-ApiKey + /rest/contact + tags + lists)
    if (path === '/mp/subscribe' && request.method === 'POST') {
      try {
        const body = await request.json();
        const email = (body.email || '').toLowerCase().trim();
        const source = (body.source || 'home').slice(0, 40);
        if (!email || !email.includes('@') || email.length < 5) {
          return new Response(JSON.stringify({ ok: false, error: 'email invalido' }), { status: 400, headers: CORS });
        }
        if (!env.SENDX_API_TOKEN) {
          return new Response(JSON.stringify({ ok: false, error: 'sendx_no_config' }), { status: 500, headers: CORS });
        }
        const tags = ['masterprops-leads', 'mp-source-' + source.replace(/[^a-z0-9-]/gi, '')];
        const sendxRes = await fetch('https://api.sendx.io/api/v1/rest/contact', {
          method: 'POST',
          headers: {
            'X-Team-ApiKey': env.SENDX_API_TOKEN,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: email,
            firstName: 'masterprops-lead',
            tags: tags,
          }),
        });
        if (!sendxRes.ok) {
          const errText = await sendxRes.text().catch(() => '');
          return new Response(JSON.stringify({ ok: false, error: 'sendx_' + sendxRes.status, detail: errText.slice(0, 200) }), { status: 502, headers: CORS });
        }
        return new Response(JSON.stringify({ ok: true, email: email }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── 🆕 (25-jun-2026 ETAPA 3 MP) POST /mp/push/subscribe — push notif MP ──
    if (path === '/mp/push/subscribe' && request.method === 'POST') {
      try {
        const sub = await request.json();
        if (!sub || !sub.endpoint) {
          return new Response(JSON.stringify({ ok: false, error: 'subscription invalida' }), { status: 400, headers: CORS });
        }
        // SHA-256 corto del endpoint para key estable
        const encoder = new TextEncoder();
        const buf = await crypto.subtle.digest('SHA-256', encoder.encode(sub.endpoint));
        const hash = Array.from(new Uint8Array(buf)).slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
        const key = 'mp_push_sub_' + hash;
        await env.CACHE_KV.put(key, JSON.stringify({ ...sub, registered_at: Date.now() }), { expirationTtl: 365 * 24 * 3600 });
        return new Response(JSON.stringify({ ok: true, id: hash }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── 🆕 (25-jun-2026 ETAPA 3 MP) GET /mp/push/list — count suscriptores MP ──
    if (path === '/mp/push/list') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS });
      }
      try {
        const list = await env.CACHE_KV.list({ prefix: 'mp_push_sub_' });
        return new Response(JSON.stringify({ count: list.keys.length, complete: list.list_complete }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── 🆕 (25-jun-2026 FIX RAÍZ #3) /admin/clear-wc-locks ──
    // Borra entries WC envenenadas del shared_cache locked_picks de hoy y ayer.
    if (path === '/admin/clear-wc-locks') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS });
      }
      const skey = env.SUPABASE_SERVICE_ROLE_KEY;
      if (!skey) {
        return new Response(JSON.stringify({ error: 'no service key' }), { status: 500, headers: CORS });
      }
      const today = new Date();
      const prev = new Date();
      prev.setDate(prev.getDate() - 1);
      const cacheKeys = [
        'locked_picks_v1_' + today.toISOString().slice(0, 10),
        'locked_picks_v1_' + prev.toISOString().slice(0, 10),
      ];
      const log = [];
      for (const ck of cacheKeys) {
        try {
          const getRes = await fetch(SUPABASE_URL + '/rest/v1/shared_cache?key=eq.' + encodeURIComponent(ck) + '&select=data', {
            headers: { 'apikey': skey, 'Authorization': 'Bearer ' + skey }
          });
          const arr = await getRes.json();
          if (!Array.isArray(arr) || arr.length === 0 || !arr[0].data) {
            log.push(ck + ': empty');
            continue;
          }
          const data = arr[0].data;
          const before = Object.keys(data).length;
          const cleaned = {};
          let removed = 0;
          for (const mk in data) {
            const v = data[mk];
            if (v && v.sportKey === 'soccer_fifa_world_cup') {
              removed++;
            } else {
              cleaned[mk] = v;
            }
          }
          if (removed > 0) {
            const patchRes = await fetch(SUPABASE_URL + '/rest/v1/shared_cache?key=eq.' + encodeURIComponent(ck), {
              method: 'PATCH',
              headers: {
                'apikey': skey,
                'Authorization': 'Bearer ' + skey,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ data: cleaned, fetched_at: new Date().toISOString() }),
            });
            log.push(ck + ': removed ' + removed + ' de ' + before + ' (' + (patchRes.ok ? 'OK' : 'FAIL ' + patchRes.status) + ')');
          } else {
            log.push(ck + ': clean (' + before + ' entries non-WC)');
          }
        } catch (e) {
          log.push(ck + ': ERROR ' + e.message);
        }
      }
      return new Response(JSON.stringify({ ok: true, ts: new Date().toISOString(), log }, null, 2), { headers: CORS });
    }

    // ── 🆕 (29-jun-2026 #568) /admin/delete-broadcast — borra msg del broadcast (bypass RLS) ──
    // Causa raíz fix #567: el upsert directo de cliente fallaba silenciosamente
    // (probable RLS). Este endpoint usa service_role, que bypassa RLS.
    if (path === '/admin/delete-broadcast') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS });
      }
      const skey = env.SUPABASE_SERVICE_ROLE_KEY;
      if (!skey) {
        return new Response(JSON.stringify({ error: 'no service key' }), { status: 500, headers: CORS });
      }
      let body;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: CORS }); }
      const msgId = body?.msgId;
      if (!msgId) return new Response(JSON.stringify({ error: 'msgId required' }), { status: 400, headers: CORS });
      const BCAST_EMAIL = '__broadcast__';
      try {
        // 1) Read current picks
        const getRes = await fetch(SUPABASE_URL + '/rest/v1/acoin_users?email=eq.' + encodeURIComponent(BCAST_EMAIL) + '&select=picks', {
          headers: { 'apikey': skey, 'Authorization': 'Bearer ' + skey }
        });
        if (!getRes.ok) {
          const t = await getRes.text();
          return new Response(JSON.stringify({ error: 'SELECT failed', status: getRes.status, body: t }), { status: 500, headers: CORS });
        }
        const rows = await getRes.json();
        if (!Array.isArray(rows) || rows.length === 0) {
          return new Response(JSON.stringify({ error: 'broadcast row not found' }), { status: 404, headers: CORS });
        }
        const existing = rows[0]?.picks || [];
        const before = existing.length;
        const updated = existing.filter(m => m && m.id !== msgId);
        if (updated.length === before) {
          return new Response(JSON.stringify({ error: 'msgId not found in list', existing_ids: existing.map(m => m?.id).filter(Boolean) }), { status: 404, headers: CORS });
        }
        // 2) PATCH (UPDATE) — service_role bypassa RLS
        const patchRes = await fetch(SUPABASE_URL + '/rest/v1/acoin_users?email=eq.' + encodeURIComponent(BCAST_EMAIL), {
          method: 'PATCH',
          headers: {
            'apikey': skey,
            'Authorization': 'Bearer ' + skey,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({ picks: updated, updated_at: new Date().toISOString() })
        });
        if (!patchRes.ok) {
          const t = await patchRes.text();
          return new Response(JSON.stringify({ error: 'PATCH failed', status: patchRes.status, body: t }), { status: 500, headers: CORS });
        }
        return new Response(JSON.stringify({ ok: true, msgId, before, after: updated.length, removed: before - updated.length }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 500) }), { status: 500, headers: CORS });
      }
    }

    // ── 🆕 (30-jun-2026 #602) /admin/schema-monitor — auditoría anti-regresión schema.org ──
    if (path === '/admin/schema-monitor/status' && request.method === 'GET') {
      try {
        const latest = await env.CACHE_KV.get('schema_monitor:latest', { type: 'json' });
        if (!latest) {
          return new Response(JSON.stringify({ ok: false, error: 'no_data_yet', hint: 'POST /admin/schema-monitor/run?token=... para correr la primera vez' }, null, 2), {
            status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify(latest, null, 2), {
          status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (path === '/admin/schema-monitor/test-alert' && request.method === 'POST') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: CORS });
      }
      // Mock result con 1 critico FAKE para probar email
      const mockResult = {
        ts: new Date().toISOString(),
        samples_audited: 12,
        findings_count: 2,
        findings_by_severity: { critical: 1, medium: 1, low: 0 },
        new_count: 2,
        new_vs_baseline: [
          { control: 3, severity: 'critical', url: 'https://gambeta.ai/blog/test-mock', issue: 'TEST_FAKE_critico_para_probar_email' },
          { control: 2, severity: 'medium', url: 'https://gambeta.ai/test-mock-2', issue: 'TEST_FAKE_medium' }
        ],
        alert: true,
      };
      const sent = await _sendSchemaMonitorAlert(env, mockResult);
      return new Response(JSON.stringify({ ok: true, email_sent: sent, mock_used: true, hint: 'Si email_sent=true, revisa pronosticosarg@gmail.com' }, null, 2), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

        if (path === '/admin/schema-monitor/run' && request.method === 'POST') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: CORS });
      }
      try {
        const result = await runSchemaMonitor(env);
        return new Response(JSON.stringify({
          ok: true,
          ts: result.ts,
          findings_count: result.findings_count,
          by_severity: result.findings_by_severity,
          new_vs_baseline: result.new_count,
          alert: result.alert,
          findings: result.findings,
        }, null, 2), {
          status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }


    // ── 🆕 (30-jun-2026 #437) /admin/forum-resolver/* — bet auto-resolver ──
    if (path === '/admin/forum-resolver/status' && request.method === 'GET') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: CORS });
      }
      const skey = env.SUPABASE_SERVICE_ROLE_KEY;
      if (!skey) {
        return new Response(JSON.stringify({ ok: false, error: 'no_service_key' }), { status: 500, headers: CORS });
      }
      try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/forum_posts?bet_data->>is_bet=eq.true&select=id,user_name,bet_data,created_at&order=created_at.desc&limit=50`, {
          headers: { apikey: skey, Authorization: `Bearer ${skey}` }
        });
        const posts = await r.json();
        const totals = { pending: 0, win: 0, loss: 0, custom: 0 };
        for (const p of posts) {
          const res = p.bet_data?.result || 'pending';
          if (res === 'win') totals.win++;
          else if (res === 'loss') totals.loss++;
          else totals.pending++;
        }
        return new Response(JSON.stringify({ ok: true, sample_size: posts.length, totals, recent: posts.slice(0, 10).map(p => ({
          id: p.id, user: p.user_name, pick: p.bet_data?.pick, match: `${p.bet_data?.home} vs ${p.bet_data?.away}`, result: p.bet_data?.result || 'pending', created_at: p.created_at
        })) }, null, 2), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (path === '/admin/forum-resolver/run' && request.method === 'POST') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: CORS });
      }
      try {
        const result = await runForumBetResolver(env);
        return new Response(JSON.stringify({ ok: true, ...result }, null, 2), {
          status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // Test sin tocar BD: ?home=X&away=Y&pick=Z (URL-encoded)
    if (path === '/admin/forum-resolver/test' && request.method === 'GET') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) {
        return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: CORS });
      }
      const home = url.searchParams.get('home') || '';
      const away = url.searchParams.get('away') || '';
      const pick = url.searchParams.get('pick') || '';
      if (!home || !away) {
        return new Response(JSON.stringify({ ok: false, error: 'home y away requeridos' }), { status: 400, headers: CORS });
      }
      try {
        const score = await _searchScoreTheSportsDB(home, away);
        if (!score) {
          return new Response(JSON.stringify({ ok: true, score: null, hint: 'TheSportsDB no encontró el partido' }, null, 2), {
            status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }
          });
        }
        const result = pick ? FORUM_PICK_RULES.resolve(score.scoreH, score.scoreA, pick) : null;
        return new Response(JSON.stringify({ ok: true, score, pick, result, hint: result === null && pick ? 'pick custom o no reconocido' : 'OK' }, null, 2), {
          status: 200, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── 🆕 (30-jun-2026 #606) /admin/dashboard — vista unificada HTML ──
    if (path === '/admin/dashboard' && request.method === 'GET') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) {
        return new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/plain' } });
      }
      return new Response(_renderDashboardHTML(), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

        // ── 🆕 (30-jun-2026 #605) /admin/uptime/* — uptime monitor ──
    if (path === '/admin/uptime/status' && request.method === 'GET') {
      try {
        const targets = await env.CACHE_KV.get('uptime:targets', { type: 'json' }) || [];
        const state = await env.CACHE_KV.get('uptime:state', { type: 'json' }) || {};
        return new Response(JSON.stringify({
          targets_count: targets.length,
          targets,
          current_state: state,
        }, null, 2), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (path === '/admin/uptime/upsert-target' && request.method === 'POST') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: CORS });
      try {
        const body = await request.json().catch(() => ({}));
        if (!body.name || !body.url) return new Response(JSON.stringify({ ok: false, error: 'name_url_required' }), { status: 400, headers: CORS });
        let targets = await env.CACHE_KV.get('uptime:targets', { type: 'json' }) || [];
        const i = targets.findIndex(t => t.url === body.url);
        if (i >= 0) targets[i] = { ...targets[i], ...body };
        else targets.push(body);
        await env.CACHE_KV.put('uptime:targets', JSON.stringify(targets));
        return new Response(JSON.stringify({ ok: true, action: i >= 0 ? 'updated' : 'added', total: targets.length }, null, 2),
          { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (path === '/admin/uptime/delete-target' && request.method === 'POST') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: CORS });
      try {
        const body = await request.json().catch(() => ({}));
        let targets = await env.CACHE_KV.get('uptime:targets', { type: 'json' }) || [];
        const before = targets.length;
        targets = targets.filter(t => t.url !== body.url);
        await env.CACHE_KV.put('uptime:targets', JSON.stringify(targets));
        return new Response(JSON.stringify({ ok: true, removed: before - targets.length, total: targets.length }, null, 2),
          { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (path === '/admin/uptime/run' && request.method === 'POST') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: CORS });
      try {
        const result = await runUptimeMonitor(env);
        return new Response(JSON.stringify(result, null, 2), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

        // ── 🆕 (30-jun-2026 #604) /admin/billing/* — billing monitor ──
    if (path === '/admin/billing/list' && request.method === 'GET') {
      try {
        const subs = await env.CACHE_KV.get('billing:subscriptions', { type: 'json' }) || [];
        const latest = await env.CACHE_KV.get('billing:latest', { type: 'json' });
        return new Response(JSON.stringify({
          subscriptions_count: subs.length,
          subscriptions: subs,
          last_run: latest,
        }, null, 2), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (path === '/admin/billing/upsert' && request.method === 'POST') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: CORS });
      try {
        const body = await request.json().catch(() => ({}));
        if (!body.name) return new Response(JSON.stringify({ ok: false, error: 'name_required' }), { status: 400, headers: CORS });
        let subs = await env.CACHE_KV.get('billing:subscriptions', { type: 'json' }) || [];
        const i = subs.findIndex(s => s.name === body.name);
        if (i >= 0) subs[i] = { ...subs[i], ...body };
        else subs.push(body);
        await env.CACHE_KV.put('billing:subscriptions', JSON.stringify(subs));
        return new Response(JSON.stringify({ ok: true, action: i >= 0 ? 'updated' : 'added', total: subs.length, item: body }, null, 2),
          { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (path === '/admin/billing/delete' && request.method === 'POST') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: CORS });
      try {
        const body = await request.json().catch(() => ({}));
        let subs = await env.CACHE_KV.get('billing:subscriptions', { type: 'json' }) || [];
        const before = subs.length;
        subs = subs.filter(s => s.name !== body.name);
        await env.CACHE_KV.put('billing:subscriptions', JSON.stringify(subs));
        return new Response(JSON.stringify({ ok: true, removed: before - subs.length, total: subs.length }, null, 2),
          { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    if (path === '/admin/billing/run' && request.method === 'POST') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: CORS });
      try {
        const result = await runBillingMonitor(env);
        return new Response(JSON.stringify(result, null, 2), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

        // ── 🆕 /admin/replace-wc-matches — limpia todos los _wcMatch y reinserta los actuales ──
    if (path === '/admin/replace-wc-matches') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS });
      }
      const stats = { removed: 0, published: 0, skip: null };
      try {
        const hist = await fetchAdminHistorial(env);
        if (!Array.isArray(hist)) {
          stats.skip = 'historial no disponible';
          return new Response(JSON.stringify(stats), { headers: CORS });
        }
        // Eliminar todos los picks con _wcMatch: true
        const remaining = hist.filter(p => !p || !p._wcMatch);
        stats.removed = hist.length - remaining.length;
        // Reinsertar los WC_MATCHES actuales al inicio
        const newHist = [...WC_MATCHES, ...remaining];
        const key = env.SUPABASE_SERVICE_ROLE_KEY;
        if (!key) {
          stats.skip = 'SUPABASE_SERVICE_ROLE_KEY no configurado';
          return new Response(JSON.stringify(stats), { headers: CORS });
        }
        const r = await fetch(`${SUPABASE_URL}/rest/v1/acoin_users?email=eq.${encodeURIComponent(ADMIN_EMAIL)}&select=email`, {
          method: 'PATCH',
          headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify({
            historial_full: newHist,
            updated_at: new Date().toISOString(),
          }),
        });
        if (!r.ok) {
          stats.skip = `PATCH HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
          return new Response(JSON.stringify(stats), { headers: CORS });
        }
        stats.published = WC_MATCHES.length;
      } catch (e) {
        stats.skip = `error: ${e.message}`;
      }
      return new Response(JSON.stringify({ ok: true, ts: new Date().toISOString(), stats }, null, 2), { headers: CORS });
    }

// ── 🆕 (28-jun-2026) /admin/purge-low-odds-pending — borra picks pending con cuota < 1.30 ──
    // Mauro: "JAMÁS bajar de 1.30". Excepción única autorizada para limpiar picks viejos.
    // Solo afecta picks con result='pending' (no toca resueltos).
    if (path === '/admin/purge-low-odds-pending') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS });
      }
      const stats = { removed: 0, kept: 0, removedDetail: [], skip: null };
      try {
        const hist = await fetchAdminHistorial(env);
        if (!Array.isArray(hist)) {
          stats.skip = 'historial no disponible';
          return new Response(JSON.stringify(stats), { headers: CORS });
        }
        const MIN = 1.30;
        const newHist = hist.filter(p => {
          if (!p) return false;
          const o = parseFloat(p.odds || p._bestOdds || 0);
          const isPending = !p.result || p.result === 'pending';
          if (isPending && o > 0 && o < MIN) {
            stats.removed++;
            stats.removedDetail.push({ id: p.id, home: p.home, away: p.away, rec: p.rec, odds: o });
            return false;
          }
          return true;
        });
        stats.kept = newHist.length;
        if (stats.removed === 0) {
          return new Response(JSON.stringify({ ok: true, ts: new Date().toISOString(), stats }, null, 2), { headers: CORS });
        }
        const key = env.SUPABASE_SERVICE_ROLE_KEY;
        if (!key) {
          stats.skip = 'SUPABASE_SERVICE_ROLE_KEY no configurado';
          return new Response(JSON.stringify(stats), { headers: CORS });
        }
        const r = await fetch(`${SUPABASE_URL}/rest/v1/acoin_users?email=eq.${encodeURIComponent(ADMIN_EMAIL)}`, {
          method: 'PATCH',
          headers: {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify({ historial_full: newHist, updated_at: new Date().toISOString() }),
        });
        if (!r.ok) {
          stats.skip = `PATCH HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
        }
      } catch (e) {
        stats.skip = `error: ${e.message}`;
      }
      return new Response(JSON.stringify({ ok: true, ts: new Date().toISOString(), stats }, null, 2), { headers: CORS });
    }

    // ── 🆕 /admin/publish-wc-matches — fuerza la publicación manual de los WC matches ──
    // Requiere ?token={ADMIN_TRIGGER_TOKEN} para evitar abuso público
    if (path === '/admin/publish-wc-matches') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS });
      }
      const stats = await runWcMatchesPublisher(env);
      return new Response(JSON.stringify({
        ok: true,
        ts: new Date().toISOString(),
        publish_ts: new Date(WC_MATCHES_PUBLISH_TS).toISOString(),
        now: new Date().toISOString(),
        wc_matches_count: WC_MATCHES.length,
        stats,
      }, null, 2), { headers: CORS });
    }

    // ── 🆕 /admin/publish-wc-futures — fuerza la publicación manual de los WC futures ──
    
    if (path === '/admin/run-wc-auto-generate') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS });
      }
      const stats = await runWcAutoGenerate(env);
      return new Response(JSON.stringify({ ok: true, ts: new Date().toISOString(), stats }), { headers: CORS });
    }

    if (path === '/admin/publish-wc-futures') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS });
      }
      const stats = await runWcFuturesPublisher(env);
      return new Response(JSON.stringify({
        ok: true,
        ts: new Date().toISOString(),
        publish_ts: new Date(WC_FUTURES_PUBLISH_TS).toISOString(),
        wc_futures_count: WC_FUTURES.length,
        stats,
      }, null, 2), { headers: CORS });
    }

    // ── 🆕 /cup-context (Conmebol cups standings-aware preferences) ──────────
    if (path === '/cup-context') {
      const cacheKey = `cup_context_v2_${new Date().toISOString().slice(0,10)}`; // refresh daily
      const force = url.searchParams.get('force') === '1';
      const ctx = force ? await computeCupContext(env) : await cached(env, cacheKey, 21600, () => computeCupContext(env));
      return new Response(JSON.stringify(ctx || {}), { headers: CORS });
    }

    // ── 🆕 /league-context (universal — detecta asimetría de motivación en ligas regulares) ──
    if (path === '/league-context') {
      const cacheKey = `league_context_v2_${new Date().toISOString().slice(0,10)}`;
      const force = url.searchParams.get('force') === '1';
      const ctx = force ? await computeLeagueContext(env) : await cached(env, cacheKey, 43200, () => computeLeagueContext(env));
      return new Response(JSON.stringify(ctx || {}), { headers: CORS });
    }

    // ── Raw passthrough debug ──
    if (path === '/apf-raw') {
      const apfPath = url.searchParams.get('path') || '/standings?league=136&season=2025';
      try {
        const r = await apf(apfPath, env);
        return new Response(JSON.stringify(r, null, 2).slice(0, 5000), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { headers: CORS });
      }
    }

    // ── Debug: pull raw standings + motivacion classification para 1 liga ──
    if (path === '/league-context-debug') {
      const leagueIdParam = url.searchParams.get('league') || '136'; // Serie B Italia default
      const seasonParam   = url.searchParams.get('season') || '2025';
      const cfg = LEAGUE_CONTEXT_CONFIG.find(c => String(c.id) === String(leagueIdParam))
                  || { id: parseInt(leagueIdParam), name: 'Custom', season: parseInt(seasonParam), topZone: 4, dropZone: 3 };
      try {
        const stReq = await apf(`/standings?league=${cfg.id}&season=${cfg.season}`, env);
        const fxReq = await apf(`/fixtures?league=${cfg.id}&season=${cfg.season}&next=10`, env);
        const standings = stReq.response?.[0]?.league?.standings?.[0] || [];
        const fixtures = fxReq.response || [];
        const totalTeams = standings.length;
        const playedAvg = standings.reduce((s, t) => s + (t.all?.played || 0), 0) / Math.max(1, standings.length);
        const totalMatches = (totalTeams - 1) * 2;
        const remainingMatches = Math.max(0, Math.round(totalMatches - playedAvg));
        const teamsWithMot = standings.map(t => ({
          rank: t.rank, name: t.team?.name, pts: t.points, played: t.all?.played,
          motivation: classifyMotivation(t, totalTeams, remainingMatches, cfg.topZone, cfg.dropZone)
        }));
        const sampleFx = fixtures.slice(0, 5).map(fx => ({
          date: fx.fixture?.date,
          home: fx.teams?.home?.name,
          away: fx.teams?.away?.name,
          homeStandingFound: !!standings.find(t => t.team.id === fx.teams?.home?.id),
          awayStandingFound: !!standings.find(t => t.team.id === fx.teams?.away?.id)
        }));
        return new Response(JSON.stringify({
          config: cfg, totalTeams, playedAvg, remainingMatches,
          standings_count: standings.length, fixtures_count: fixtures.length,
          standings: teamsWithMot, sample_fixtures: sampleFx
        }, null, 2), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message, config: cfg }), { headers: CORS });
      }
    }

    // ── /odds ────────────────────────────────────────────────────────────────
    if (path === '/odds') {
      const category = url.searchParams.get('category') || 'main';
      const hourKey  = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
      const cacheKey = `odds10_${category}_${hourKey}`;  // v9: incluye _round/_stage para detectar finales

      const leagues = category === 'europe'    ? LEAGUES_EUROPE
                    : category === 'secondary' ? LEAGUES_SECONDARY
                    : LEAGUES_MAIN;

      let result = await cached(env, cacheKey, 3600, () => getLeagueData(env, leagues));

      // 🆕 (18-jul) NUNCA confiar en un vacío cacheado: si una pasada falló y quedó
      // [] en KV, reintentar en vivo y sobreescribir el caché si ahora hay data.
      if (!result || !result.data || !result.data.length) {
        try {
          const fresh = await getLeagueData(env, leagues);
          if (fresh && fresh.data && fresh.data.length) {
            result = fresh;
            try { await env.CACHE_KV?.put(cacheKey, JSON.stringify(fresh), { expirationTtl: 3600 }); } catch {}
          }
        } catch {}
      }

      return new Response(JSON.stringify({
        data:    result.data,
        meta:    { total: result.data.length, source: result.source, category },
        _source: result.source
      }), { headers: CORS });
    }

    // ── 🆕 (18-jul) GET /odds-debug — estado real de The Odds API (cuota) ──
    if (path === '/odds-debug') {
      const sk = url.searchParams.get('sport') || 'soccer_sweden_allsvenskan';
      const key = env.ODDS_API_KEY;
      if (!key) return new Response(JSON.stringify({ error: 'no key' }), { headers: CORS });
      const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sk}/odds/?apiKey=${key}&regions=eu,uk&markets=h2h,totals&oddsFormat=decimal&dateFormat=iso`);
      const body = await r.text();
      let games = null; try { const j = JSON.parse(body); games = Array.isArray(j) ? j.length : null; } catch {}
      return new Response(JSON.stringify({
        sport: sk, status: r.status,
        remaining: r.headers.get('x-requests-remaining'),
        used: r.headers.get('x-requests-used'),
        games, sample: games === null ? body.slice(0, 200) : undefined,
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

    // (endpoint de canje de monedas eliminado — función discontinuada)

    // ── /status ──────────────────────────────────────────────────────────────
    if (path === '/status') {
      return new Response(JSON.stringify({
        worker: 'apuestas-api v3.4',
        time: new Date().toISOString(),
        apf_key: env.API_FOOTBALL_KEY ? 'configured' : 'MISSING',
        odds_key: env.ODDS_API_KEY ? 'configured' : 'MISSING',
        resend_key: env.RESEND_API_KEY ? 'configured' : 'MISSING',
        sb_service_key: env.SUPABASE_SERVICE_ROLE_KEY ? 'configured' : 'MISSING',
        kv: env.CACHE_KV ? 'connected' : 'NOT connected'
      }), { headers: CORS });
    }

    // ── 🆕 /escudos-known-init — inicializa KV con lista de equipos conocidos ──
    if (path === '/escudos-known-init' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (!Array.isArray(body)) {
          return new Response(JSON.stringify({ error: 'body debe ser array' }), { status: 400, headers: CORS });
        }
        await env.CACHE_KV.put('escudos_known_v1', JSON.stringify(body));
        return new Response(JSON.stringify({ ok: true, count: body.length }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── 🆕 /check-escudos — manual trigger del checker de escudos ────────────
    if (path === '/check-escudos') {
      const stats = await runEscudosChecker(env);
      return new Response(JSON.stringify(stats, null, 2), { headers: CORS });
    }

    // ── 🆕 /escudos-discovered — map para fallback del frontend ──────────────
    if (path === '/escudos-discovered') {
      const raw = await env.CACHE_KV.get('escudos_discovered_v1');
      return new Response(raw || '{}', { headers: CORS });
    }

    // ── 🆕 /cron-update-odds — manual trigger del update de cuotas ───────────
    if (path === '/cron-update-odds') {
      const stats = await runOddsUpdater(env);
      return new Response(JSON.stringify(stats), { headers: CORS });
    }


    // ── 🆕 (1-jul-2026 #636) /admin/force-resolve — resolver manualmente un pick sin score external ──
    // Sirve para picks de futures (stage, groupwin, qualify, champion, topscorer) que no tienen commenceTs.
    // 🆕 (1-jul-2026) Proxy temporal para explorar la doc de la API DBbet
    // ?token=gambeta_wc_2026_trigger&path=/sitemap.xml
    if (path === '/admin/dbbet-probe') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) return new Response(JSON.stringify({ ok:false, error:'unauthorized' }), { status:401, headers:CORS });
      const targetPath = url.searchParams.get('path') || '/';
      const targetUrl = 'https://docs-marketing-sport.com' + targetPath;
      const auth = 'Basic ' + btoa('marketingsport:9ihnsG4jkKSZjDTh');
      try {
        const r = await fetch(targetUrl, {
          headers: {
            'Authorization': auth,
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
          },
          redirect: 'follow',
        });
        const text = await r.text();
        const ctype = r.headers.get('content-type') || '';
        // Devolver como texto crudo para que se lea directo
        return new Response(text, {
          status: r.status,
          headers: { ...CORS, 'content-type': ctype || 'text/plain; charset=utf-8', 'x-target': targetUrl }
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok:false, error: String(e) }), { status:500, headers:CORS });
      }
    }

    // Body: { id, result: 'win'|'loss'|'void', pl?: number, finalScore?: string }
    if (path === '/admin/force-resolve' && request.method === 'POST') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: CORS });
      try {
        const body = await request.json().catch(() => ({}));
        const { id, result, finalScore } = body;
        let { pl } = body;
        if (!id || !['win','loss','void'].includes(result)) {
          return new Response(JSON.stringify({ ok: false, error: 'id y result (win/loss/void) requeridos' }), { status: 400, headers: CORS });
        }
        const skey = env.SUPABASE_SERVICE_ROLE_KEY;
        if (!skey) return new Response(JSON.stringify({ ok: false, error: 'no_service_key' }), { status: 500, headers: CORS });
        // Leer AMBAS fuentes: acoin_users.historial_full Y global_historial_v1
        // (picks auto-generados WC viven solo en el segundo)
        let updatedIn = [];
        // 1) Admin (acoin_users)
        try {
          const hist = await fetchAdminHistorial(env);
          const idx = hist.findIndex(p => p.id === id);
          if (idx >= 0) {
            const pick = hist[idx];
            if (typeof pl !== 'number') {
              const stake = parseFloat(pick.stake) || 50;
              const odds = parseFloat(pick.odds) || 1.5;
              if (result === 'win') pl = +(stake * (odds - 1)).toFixed(2);
              else if (result === 'loss') pl = -stake;
              else pl = 0;
            }
            hist[idx] = { ...pick, result, pl, finalScore: finalScore || pick.finalScore || null, _resolvedAt: new Date().toISOString(), _resolvedManual: true };
            await saveAdminHistorial(env, hist);
            updatedIn.push('admin');
          }
        } catch(_) {}
        // 2) global_historial_v1 (cache pública que el cliente lee)
        let resolvedPick = null;
        try {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/shared_cache?key=eq.global_historial_v1&select=data`, { headers: { apikey: skey, Authorization: `Bearer ${skey}` } });
          const rows = await r.json();
          if (rows && rows[0]) {
            const data = rows[0].data;
            const arr = Array.isArray(data) ? data : (data?.picks || []);
            const gi = arr.findIndex(p => p.id === id);
            if (gi >= 0) {
              const pick = arr[gi];
              if (typeof pl !== 'number') {
                const stake = parseFloat(pick.stake) || 50;
                const odds = parseFloat(pick.odds) || 1.5;
                if (result === 'win') pl = +(stake * (odds - 1)).toFixed(2);
                else if (result === 'loss') pl = -stake;
                else pl = 0;
              }
              arr[gi] = { ...pick, result, pl, finalScore: finalScore || pick.finalScore || null, _resolvedAt: new Date().toISOString(), _resolvedManual: true };
              resolvedPick = arr[gi];
              const newData = Array.isArray(data) ? arr : { ...data, picks: arr };
              const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/shared_cache?key=eq.global_historial_v1`, {
                method: 'PATCH',
                headers: { apikey: skey, Authorization: `Bearer ${skey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                body: JSON.stringify({ data: newData }),
              });
              if (patchRes.ok) updatedIn.push('global_v1');
            }
          }
        } catch(_) {}
        if (updatedIn.length === 0) return new Response(JSON.stringify({ ok: false, error: 'pick not found in admin nor global_v1', id }), { status: 404, headers: CORS });
        return new Response(JSON.stringify({ ok: true, updated_in: updatedIn, resolved: resolvedPick }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── 🆕 (29-jun-2026 #573) /admin/resolve-pick?id=X ────────────────────────
    // Resuelve UN pick específico sin esperar al cron. Usa fetchApfScore +
    // fetchTsdbEvent + ESPN. Sin gate de tiempo (90min) — el caller decide.
    // Usado por el cliente self-healing (Gambeta 1.1 madurez).
    if (path === '/admin/wc-futures-resolve') {
      const token = url.searchParams.get('token');
      if (token !== 'gambeta_wc_2026_trigger') return new Response('unauthorized', { status: 401, headers: CORS });
      const targetId = url.searchParams.get('id');
      const targetResult = url.searchParams.get('result');
      const targetPl = parseFloat(url.searchParams.get('pl') || '0');
      if (!targetId || !targetResult) return new Response(JSON.stringify({error:'id+result required'}), {status:400, headers:CORS});
      try {
        const key = env.SUPABASE_SERVICE_ROLE_KEY;
        if (!key) return new Response(JSON.stringify({error:'no service_role'}), {status:500, headers:CORS});
        const r = await fetch(`${SUPABASE_URL}/rest/v1/shared_cache?key=eq.global_historial_v1&select=data`, { headers:{apikey:key, Authorization:`Bearer ${key}`}});
        const rows = await r.json();
        const picks = rows?.[0]?.data;
        if (!Array.isArray(picks)) return new Response(JSON.stringify({error:'no picks'}), {status:404, headers:CORS});
        let modified = false;
        for (const p of picks) {
          if (p && p.id === targetId) {
            p.result = targetResult;
            p.pl = targetPl;
            p._manuallyResolved = true;
            p._resolvedAt = new Date().toISOString();
            modified = true;
            break;
          }
        }
        if (!modified) return new Response(JSON.stringify({error:'pick id not found', id:targetId}), {status:404, headers:CORS});
        const pr = await fetch(`${SUPABASE_URL}/rest/v1/shared_cache?key=eq.global_historial_v1`, {
          method:'PATCH', headers:{apikey:key, Authorization:`Bearer ${key}`, 'Content-Type':'application/json'},
          body: JSON.stringify({ data: picks, fetched_at: new Date().toISOString() })
        });
        return new Response(JSON.stringify({ok: pr.ok, id:targetId, result:targetResult, pl:targetPl, status:pr.status}), {headers:CORS});
      } catch(e) {
        return new Response(JSON.stringify({error:e.message}), {status:500, headers:CORS});
      }
    }

    if (path === '/admin/resolve-pick') {
      const pickId = url.searchParams.get('id');
      if (!pickId) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: CORS });
      try {
        const hist = await fetchAdminHistorial(env);
        const pick = hist.find(p => p.id === pickId);
        if (!pick) return new Response(JSON.stringify({ error: 'pick not found', id: pickId }), { status: 404, headers: CORS });
        if (pick.result && pick.result !== 'pending') {
          return new Response(JSON.stringify({ ok: true, status: 'already resolved', pick: { id: pick.id, result: pick.result, finalScore: pick.finalScore, pl: pick.pl } }), { headers: CORS });
        }
        if (!pick.commenceTs) return new Response(JSON.stringify({ error: 'no commenceTs' }), { status: 400, headers: CORS });

        // Probar APF (fixtures por liga + fecha)
        let matched = null;
        try {
          const apfMatch = await fetchApfScore(pick, env);
          if (apfMatch) { matched = apfMatch; }
        } catch(_) {}

        // Fallback TSDB
        if (!matched) {
          try {
            const tsdb = await fetchTsdbEvent(pick.home, pick.away);
            if (tsdb) matched = tsdb;
          } catch(_) {}
        }

        if (!matched) {
          return new Response(JSON.stringify({ ok: false, status: 'no score available yet', sources_tried: ['apf','tsdb'] }), { headers: CORS });
        }
        if (matched.voidReason) {
          return new Response(JSON.stringify({ ok: false, status: 'void detected', reason: matched.voidReason }), { headers: CORS });
        }

        // Resolver según rec (lógica simplificada igual a runScheduledResolver)
        const scoreH = matched.scoreH, scoreA = matched.scoreA;
        const totalGoals = scoreH + scoreA;
        const homeWin = scoreH > scoreA, awayWin = scoreA > scoreH, draw = scoreH === scoreA;
        const bttsMet = scoreH > 0 && scoreA > 0;
        const rec = pick.rec || '';
        const side = pick._recSide || '';
        let result = null;
        if (side === 'home' || /gana local|gana.*home/i.test(rec)) result = homeWin ? 'win' : 'loss';
        else if (side === 'away' || /gana visitante|gana.*away/i.test(rec)) result = awayWin ? 'win' : 'loss';
        else if (side === 'draw' || /^empate/i.test(rec)) result = draw ? 'win' : 'loss';
        else if (/over 2\.5|m[aá]s de 2\.5/i.test(rec)) result = totalGoals > 2.5 ? 'win' : 'loss';
        else if (/over 1\.5|m[aá]s de 1\.5/i.test(rec)) result = totalGoals > 1.5 ? 'win' : 'loss';
        else if (/under 2\.5|menos de 2\.5/i.test(rec)) result = totalGoals < 2.5 ? 'win' : 'loss';
        else if (/btts|ambos.*marcan/i.test(rec)) result = bttsMet ? 'win' : 'loss';
        // Doble oportunidad
        else if (/(1x|local.*empate|gana local o empate)/i.test(rec)) result = (homeWin || draw) ? 'win' : 'loss';
        else if (/(x2|empate.*visitante|empate o gana visitante)/i.test(rec)) result = (draw || awayWin) ? 'win' : 'loss';
        else if (/^gana brasil|^gana argentina|^gana alemania|^gana francia|^gana espa/i.test(rec)) {
          // Pick por nombre de equipo en home → home win
          result = homeWin ? 'win' : 'loss';
        }

        if (!result) {
          return new Response(JSON.stringify({ ok: false, status: 'cannot determine result from rec', rec, score: scoreH + '-' + scoreA }), { headers: CORS });
        }

        // Llamar al endpoint de UPDATE existente para escribir
        const stake = Number(pick.stake) || 100;
        const odds = Number(pick.odds) || 1.5;
        const pl = result === 'win' ? Number(((odds - 1) * stake).toFixed(2))
                 : result === 'loss' ? -stake : 0;

        // Update directo en Supabase via service_role
        const skey = env.SUPABASE_SERVICE_ROLE_KEY;
        if (!skey) return new Response(JSON.stringify({ error: 'no service key' }), { status: 500, headers: CORS });

        // Persistir update — usar el mismo path que runScheduledResolver al final
        pick.result = result;
        pick.finalScore = scoreH + '-' + scoreA;
        pick.pl = pl;
        pick.scoreH = scoreH;
        pick.scoreA = scoreA;
        pick.resolvedAt = Date.now();
        pick._resolvedBy = 'resolve-pick-endpoint';

        // Write back: usar writeAdminHistorial helper si existe
        if (typeof writeAdminHistorial === 'function') {
          await writeAdminHistorial(hist, env);
        } else {
          // Fallback: PATCH directo
          const newHistorial = hist;
          await fetch(SUPABASE_URL + '/rest/v1/acoin_users?email=eq.__historial_full__', {
            method: 'PATCH',
            headers: { 'apikey': skey, 'Authorization': 'Bearer ' + skey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ picks: newHistorial, updated_at: new Date().toISOString() })
          });
        }

        return new Response(JSON.stringify({ ok: true, status: 'resolved', pick: { id: pick.id, result, finalScore: pick.finalScore, pl, source: matched.src } }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message, stack: e.stack?.slice(0, 400) }), { status: 500, headers: CORS });
      }
    }

        // ── /cron-resolve ────────────────────────────────────────────────────────
    // Trigger manual del resolver (mismo código que corre en el cron cada hora).
    // Útil para testear / forzar resolución sin esperar al cron.
    if (path === '/cron-resolve') {
      const stats = await runScheduledResolver(env);
      return new Response(JSON.stringify(stats, null, 2), { headers: CORS });
    }

    // ── 🆕 (18-jul) /cron-generate — generador de picks server-side (trigger manual) ──
    if (path === '/cron-generate') {
      const stats = await runScheduledPickGenerator(env);
      return new Response(JSON.stringify(stats, null, 2), { headers: CORS });
    }

    // ── 🆕 (18-jul) /cron-generate-status — última corrida del generador ──
    // ── 🆕 (22-jul) /email-results — mail de resultados (preview / ?send=1) ──
    if (path === '/email-results') {
      const doSend = url.searchParams.get('send') === '1';
      const out = doSend ? await runResultsEmail(env, true) : await buildResultsEmailData(env);
      return new Response(JSON.stringify(out, null, 2), { headers: CORS });
    }

    // ── 🆕 (23-jul) /dbbet-test — explorador de la Marketing API de DBbet ──
    // Requiere el secret DBBET_API_TOKEN (Cloudflare → Settings → Variables).
    // Uso: /dbbet-test                     → lista de deportes (directorio)
    //      /dbbet-test?path=<ruta-y-query> → passthrough a cualquier endpoint del datafeed
    if (path === '/dbbet-test') {
      const tok = env.DBBET_API_TOKEN;
      if (!tok) return new Response(JSON.stringify({ error: 'DBBET_API_TOKEN no configurado. Cloudflare dashboard → Workers → apuestas-api → Settings → Variables → Add secret.' }), { status: 503, headers: CORS });
      const sub = url.searchParams.get('path') || 'datafeed/directories/api/v2/sports';
      try {
        const r = await fetch('https://cpservm.com/gateway/marketing/' + sub, { headers: { Authorization: 'Bearer ' + tok } });
        const body = await r.text();
        return new Response(JSON.stringify({ status: r.status, len: body.length, body: body.slice(0, 4000) }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e && e.message || e) }), { status: 502, headers: CORS });
      }
    }

    if (path === '/cron-generate-status') {
      const last = await env.CACHE_KV?.get('gen_last_run');
      return new Response(last || '{"error":"sin corridas registradas"}', { headers: CORS });
    }

    // ── 🆕 (25-jun-2026) /wc-teams — devuelve team_ids + logos de TODAS las selecciones del WC 2026
    // Cachea en KV 30 dias. Usado por cliente para sub-escudito federacion en nationalTeamBadge.
    if (path === '/wc-teams') {
      const cacheKey = 'wc_teams_2026_v1';
      const cached = await env.CACHE_KV.get(cacheKey);
      if (cached) return new Response(cached, { headers: CORS });
      try {
        const r = await apf('/teams?league=1&season=2026', env);
        const teams = r.response || [];
        const dict = {};
        for (const t of teams) {
          const name = t.team?.name;
          const logo = t.team?.logo;
          const id = t.team?.id;
          if (name && logo) dict[name] = { id, logo };
        }
        const body = JSON.stringify({ count: Object.keys(dict).length, teams: dict, fetchedAt: new Date().toISOString() });
        await env.CACHE_KV.put(cacheKey, body, { expirationTtl: 30 * 24 * 3600 });
        return new Response(body, { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── 🆕 (25-jun-2026) /push/subscribe — guardar subscription en KV
    if (path === '/push/subscribe' && request.method === 'POST') {
      try {
        const body = await request.json();
        const sub = body.subscription;
        if (!sub || !sub.endpoint) return new Response(JSON.stringify({ error: 'missing subscription' }), { status: 400, headers: CORS });
        // Key = hash del endpoint (corto, único)
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.endpoint));
        const id = [...new Uint8Array(hash)].slice(0, 12).map(b => b.toString(16).padStart(2,'0')).join('');
        const record = {
          subscription: sub,
          userAgent: (body.userAgent || '').slice(0, 200),
          lang: body.lang || 'es',
          createdAt: new Date().toISOString()
        };
        await env.CACHE_KV.put(`push_sub_${id}`, JSON.stringify(record), { expirationTtl: 365 * 24 * 3600 });
        return new Response(JSON.stringify({ ok: true, id }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
      }
    }

    // ── /push/list — admin: ver cuántas subs hay (no devuelve datos)
    if (path === '/push/list') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS });
      const list = await env.CACHE_KV.list({ prefix: 'push_sub_' });
      return new Response(JSON.stringify({ count: list.keys.length, complete: list.list_complete }), { headers: CORS });
    }

    // ── /push/send — admin: enviar notif a todas las subs activas
    // Body: { title, body, url, image? }
    if (path === '/push/send' && request.method === 'POST') {
      const token = url.searchParams.get('token');
      const expected = env.ADMIN_TRIGGER_TOKEN || env.TRIGGER_TOKEN || 'gambeta_wc_2026_trigger';
      if (token !== expected) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: CORS });
      try {
        const payload = await request.json();
        if (!payload.title || !payload.body) return new Response(JSON.stringify({ error: 'title and body required' }), { status: 400, headers: CORS });
        const list = await env.CACHE_KV.list({ prefix: 'push_sub_' });
        const stats = { total: list.keys.length, sent: 0, failed: 0, expired: 0 };
        const payloadStr = JSON.stringify(payload);

        // Para firma VAPID JWT (P-256 ECDSA SHA-256)
        const VAPID_PRIVATE = env.VAPID_PRIVATE_KEY || '1EkL2cZSb4bxMamAJF5QgYpEB22eHsseGPFMt0BlhKg';
        const VAPID_PUBLIC = env.VAPID_PUBLIC_KEY || 'BEFve5dHpprXm4_8XprLJsyFz6yOHDAGPrEUtfMeuho9NPv_mxlgX6oKepYb0omlDprkieAH8lBRe91HRVkRN1s';
        const VAPID_SUBJECT = 'mailto:mauro@gambeta.ai';

        // Helpers Base64URL
        const b64uEncode = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/, '');
        const b64uDecode = (str) => {
          const pad = '='.repeat((4 - str.length % 4) % 4);
          const s = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
          return Uint8Array.from(atob(s), c => c.charCodeAt(0));
        };

        // Importar VAPID private key (raw 32 bytes → JWK)
        const privBytes = b64uDecode(VAPID_PRIVATE);
        const pubBytes = b64uDecode(VAPID_PUBLIC);
        const jwk = {
          kty: 'EC', crv: 'P-256',
          d: VAPID_PRIVATE,
          x: b64uEncode(pubBytes.slice(1, 33)),
          y: b64uEncode(pubBytes.slice(33, 65))
        };
        const cryptoKey = await crypto.subtle.importKey('jwk', jwk, { name:'ECDSA', namedCurve:'P-256' }, false, ['sign']);

        async function buildVapidJwt(audience) {
          const header = { typ: 'JWT', alg: 'ES256' };
          const claims = { aud: audience, exp: Math.floor(Date.now()/1000) + 12*3600, sub: VAPID_SUBJECT };
          const signedInput = b64uEncode(new TextEncoder().encode(JSON.stringify(header))) + '.' + b64uEncode(new TextEncoder().encode(JSON.stringify(claims)));
          const sig = await crypto.subtle.sign({ name:'ECDSA', hash:'SHA-256' }, cryptoKey, new TextEncoder().encode(signedInput));
          return signedInput + '.' + b64uEncode(sig);
        }

        for (const k of list.keys) {
          try {
            const rec = JSON.parse(await env.CACHE_KV.get(k.name));
            const endpoint = rec.subscription.endpoint;
            const audOrigin = new URL(endpoint).origin;
            const jwt = await buildVapidJwt(audOrigin);
            // Header VAPID format. NO encryption (mvp) → payload se manda sin cifrar
            // Si el push service rechaza por payload sin cifrar, hay que implementar AES-128-GCM (más trabajo).
            // Workaround MVP: notification SIN payload — el SW usa contenido por defecto
            const resp = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'TTL': '86400',
                'Authorization': `vapid t=${jwt}, k=${VAPID_PUBLIC}`,
                'Content-Length': '0'
              }
            });
            if (resp.status === 201 || resp.status === 200) stats.sent++;
            else if (resp.status === 404 || resp.status === 410) {
              // Subscription expirada → borrar
              await env.CACHE_KV.delete(k.name);
              stats.expired++;
            } else stats.failed++;
          } catch (e) { stats.failed++; }
        }
        return new Response(JSON.stringify({ ok: true, stats, payload }), { headers: CORS });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message, stack: e.stack }), { status: 500, headers: CORS });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found', path }), { status: 404, headers: CORS });
  }
};


