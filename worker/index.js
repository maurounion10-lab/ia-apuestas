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
  if (rec === 'Más de 1.5')      return total >= 2 ? 'win' : 'loss';
  if (rec === 'Más de 2.5')      return total >= 3 ? 'win' : 'loss';
  if (rec === 'Más de 3.5')      return total >= 4 ? 'win' : 'loss';
  const mO = rec.match(/^Más de (\d+\.?\d*)$/);
  if (mO) {
    const line = parseFloat(mO[1]);
    return total > line ? 'win' : 'loss';
  }
  const mU = rec.match(/^Menos de (\d+\.?\d*)$/);
  if (mU) {
    const line = parseFloat(mU[1]);
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
        const cacheKey = `odds9_${cat}_${new Date().toISOString().slice(0, 13)}`;
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
      if ((teamsMatch(fxHome, pick.home) && teamsMatch(fxAway, pick.away)) ||
          (teamsMatch(fxHome, pick.away) && teamsMatch(fxAway, pick.home))) {
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
        return {
          home: pick.home,
          away: pick.away,
          scoreH: parseInt(goalsH),
          scoreA: parseInt(goalsA),
          src: 'apf'
        };
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function runScheduledResolver(env) {
  const stats = { checked: 0, resolved: 0, espn: 0, tsdb: 0, apf: 0, errors: 0, log: [] };
  try {
    const hist = await fetchAdminHistorial(env);
    if (!hist.length) {
      stats.log.push('historial vacío');
      return stats;
    }

    const now = Date.now();
    const TWO_H = 2 * 3600 * 1000;
    const TWENTY_ONE_D = 21 * 24 * 3600 * 1000;

    // Picks resolvables: pendientes + "a medio resolver" — picks con result
    // win/loss pero sin marcador o con P/L en 0. El resolver los re-procesa y
    // los deja consistentes (result + finalScore + pl), auto-sanando ese estado roto.
    const pending = hist.filter(p => {
      if (!p.commenceTs) return false;
      const age = now - p.commenceTs;
      if (age < TWO_H || age > TWENTY_ONE_D) return false;
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
      await saveAdminHistorial(env, hist);
      stats.log.push(`historial actualizado: ${stats.resolved} picks resueltos`);
    }
  } catch (e) {
    stats.errors++;
    stats.log.push(`fatal: ${e.message}`);
  }
  return stats;
}

// ── Router principal ─────────────────────────────────────────────────────────
export default {
  async scheduled(controller, env, ctx) {
    // Cron handler — multiple crons distinguished by controller.cron string
    const cronExpr = controller.cron;
    if (cronExpr === '0 */6 * * *') {
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
    }
  },
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── /available ───────────────────────────────────────────────────────────
    if (path === '/available') {
      const keys = [...LEAGUES_MAIN, ...LEAGUES_EUROPE, ...LEAGUES_SECONDARY].map(([k]) => k);
      return new Response(JSON.stringify({ keys }), { headers: CORS });
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
      const cacheKey = `odds9_${category}_${hourKey}`;  // v9: incluye _round/_stage para detectar finales

      const leagues = category === 'europe'    ? LEAGUES_EUROPE
                    : category === 'secondary' ? LEAGUES_SECONDARY
                    : LEAGUES_MAIN;

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

    // ── /cron-resolve ────────────────────────────────────────────────────────
    // Trigger manual del resolver (mismo código que corre en el cron cada hora).
    // Útil para testear / forzar resolución sin esperar al cron.
    if (path === '/cron-resolve') {
      const stats = await runScheduledResolver(env);
      return new Response(JSON.stringify(stats, null, 2), { headers: CORS });
    }

    return new Response(JSON.stringify({ error: 'Not found', path }), { status: 404, headers: CORS });
  }
};
