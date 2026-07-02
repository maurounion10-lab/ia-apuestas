
// Deshabilitar restauración automática de scroll del browser (evita cargar en mitad de página)
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
// ═══════════════════════════════════════════════
//  $A-COIN CONSTANTS (must be first — no TDZ)
// ═══════════════════════════════════════════════
const AC_BAL  = 'acoin_balance';
const AC_PICK = 'acoin_picks';
const AC_HIST = 'acoin_history';
const AC_DAY  = 'acoin_last_daily';
const AC_BUST = 'acoin_bust_date';   // fecha en que el usuario quedó en 0 sin picks pendientes
const AC_WINS = 'acoin_credited_wins'; // set de partidos ya acreditados (independiente del historial)
const AC_GOAL = 100000;
// Ícono moneda dorada — usar en template literals con ${AC_ICON}
const AC_ICON = '<span class="acico"></span>';

// ═══════════════════════════════════════════════
//  SUPABASE CLIENT
// ═══════════════════════════════════════════════
const _SB_URL = 'https://ixfrtjvhnpapyuphqfxp.supabase.co';
const _SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4ZnJ0anZobnBhcHl1cGhxZnhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDExOTMsImV4cCI6MjA4OTE3NzE5M30.Lc5cOfvXCrrMlm9Yup5GG6RgCxOB_GSNJnKLTb1-bZQ';
const sbClient = supabase.createClient(_SB_URL, _SB_KEY, {
  auth: {
    storage: window.localStorage,
    persistSession: true,
    detectSessionInUrl: true,   // necesario para procesar el token del OAuth (Google login)
    // flowType 'implicit' es necesario para magic links: con PKCE (default v2) el token
    // se intercambia con un code_verifier guardado en localStorage del tab que inició el flujo.
    // Si el usuario abre el link en otro navegador/dispositivo/cliente de correo, el verifier
    // no existe y la autenticación falla silenciosamente. 'implicit' pone el token en el hash
    // de la URL y funciona en cualquier dispositivo/browser.
    flowType: 'implicit',
    // Mutex propio basado en Promise chain — evita AbortError de Web Locks API
    // y a la vez garantiza que no haya operaciones concurrentes que se pisen
    lock: (() => {
      const _q = {};
      return (name, _timeout, fn) => {
        _q[name] = (_q[name] || Promise.resolve()).then(() => fn(), () => fn());
        return _q[name];
      };
    })(),
  }
});

// Cliente público (anon, sin JWT) — solo para lecturas públicas como el feed 
// Necesario porque la RLS policy "feed_public_read" cubre el rol anon, no authenticated
const sbAnon = supabase.createClient(_SB_URL, _SB_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'sb-anon-public' }
});

// ── Analytics: sesión + eventos ──────────────────────────────────────────
const _GA_SID_KEY = '_gb_sid';
let _gaSessionId = null;
try {
  _gaSessionId = sessionStorage.getItem(_GA_SID_KEY);
  if (!_gaSessionId) {
    _gaSessionId = 'sid_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
    sessionStorage.setItem(_GA_SID_KEY, _gaSessionId);
  }
} catch { _gaSessionId = 'sid_' + Date.now(); }

async function trackEvent(type, data = {}) {
  // Analytics compacto: una fila por día por tipo (upsert de contador)
  // En vez de insertar miles de filas, actualiza balance++ en 1 fila por día
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  try {
    if (type === 'pageview') {
      // 1 conteo por browser por día — evita spam de bots/crawlers
      const key = `_gb_pv_${today}`;
      try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch {}
      const email = `__ev_pv_${today}__`;
      const { data: row } = await sbAnon.from('acoin_users').select('balance').eq('email', email).maybeSingle();
      await sbAnon.from('acoin_users').upsert(
        { email, balance: (row?.balance || 0) + 1, updated_at: new Date().toISOString() },
        { onConflict: 'email' }
      );
    } else if (type === 'promo_click') {
      const promo = (data.promo || 'x').replace(/[^a-z0-9]/gi,'').slice(0,18).toLowerCase();
      const email = `__ev_pc_${promo}_${today}__`;
      const { data: row } = await sbAnon.from('acoin_users').select('balance').eq('email', email).maybeSingle();
      await sbAnon.from('acoin_users').upsert(
        { email, balance: (row?.balance || 0) + 1, updated_at: new Date().toISOString() },
        { onConflict: 'email' }
      );
    }
  } catch { /* silencioso */ }
}

// Presencia en vivo (Realtime channel)
// Solo se conecta si el usuario está logueado — los anónimos no abren WebSocket
// para no agotar los límites de Supabase con muchos visitantes simultáneos.
let _gbLiveCount = 0;
let _presenceChannel = null;
function initPresence() {
  if (_presenceChannel) return; // ya inicializado
  try {
    const ch = sbAnon.channel('gambeta_visitors', { config: { presence: { key: _gaSessionId } } });
    ch.on('presence', { event: 'sync' }, () => {
      _gbLiveCount = Object.keys(ch.presenceState()).length;
    }).subscribe(async status => {
      if (status === 'SUBSCRIBED') await ch.track({ ts: Date.now() });
    });
    _presenceChannel = ch;
  } catch {}
}
// initPresence() se llama desde applyUserProfile (solo cuando hay sesión activa)

// Debounced sync — batches rapid changes into one DB write
let _syncTimer = null;
function acScheduleSync() {
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(acSyncToDB, 1200);
}

// ── Realtime + sync periódico: única fuente de verdad ──────────────
let _userRealtimeChannel = null;
let _periodicSyncInterval = null;

function initUserSync(email) {
  // 1) Realtime: cuando cualquier browser escribe en la fila del usuario,
  //    este browser re-mergea automáticamente
  if (_userRealtimeChannel) {
    try { sbClient.removeChannel(_userRealtimeChannel); } catch(_) {}
  }
  _userRealtimeChannel = sbClient
    .channel(`user-sync-${email}`)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'acoin_users',
      filter: `email=eq.${email}`
    }, async () => {
      console.log('[Sync] Cambio detectado en otro browser — mergeando...');
      await acLoadFromDB(email);
    })
    .subscribe();

  // 2a) Sync de coins cada 5 min (solo DB Supabase, no Worker)
  clearInterval(_periodicSyncInterval);
  _periodicSyncInterval = setInterval(async () => {
    if (authUser?.email) await acLoadFromDB(authUser.email);
  }, 5 * 60 * 1000);

  // 2b) Sync de historial cada 15 min (llama al Worker /api/sb)
  clearInterval(window._histSyncInterval);
  window._histSyncInterval = setInterval(async () => {
    if (authUser?.email) await sbLoadHistorial();
  }, 15 * 60 * 1000);

  // 3) Sync al volver al tab — solo coins (historial usa su propio caché de 2 min)
  let _lastVisibilitySync = 0;
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && authUser?.email) {
      const now = Date.now();
      if (now - _lastVisibilitySync < 5 * 60 * 1000) return; // throttle: máx 1 vez cada 5 min
      _lastVisibilitySync = now;
      await acLoadFromDB(authUser.email);
      // historial solo si su caché expiró
      if (!_sbGetCache('ghist')) await sbLoadHistorial();
    }
  }, { once: false });

  // 4) Realtime en shared_cache: cuando el admin sube el historial global,
  //    todos los devices lo reciben al instante
  try {
    sbAnon
      .channel('shared-cache-hist')
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'shared_cache',
        filter: `key=eq.${GLOBAL_HIST_KEY}`
      }, async () => {
        console.log('[historial] Global actualizado — recargando...');
        await sbLoadHistorial();
      })
      .subscribe();
  } catch(e) { console.warn('[histRealtime]', e.message); }
}

async function acSyncToDB() {
  if (!authUser?.email) return;
  // historial de pronósticos (slim: solo campos necesarios para stats)
  let predsSlim = [];
  try {
    const hist = JSON.parse(localStorage.getItem('apuestas_historial_v1') || '[]');
    predsSlim = hist.slice(0, 150).map(h => ({
      id: h.id, result: h.result, rec: h.rec, sport: h.sport
    }));
  } catch(_) {}

  const payload = {
    email:       authUser.email,
    balance:     acGet(),
    picks:       acGetPicks(),
    history:     JSON.parse(localStorage.getItem(AC_HIST) || '[]'),
    last_daily:  localStorage.getItem(AC_DAY)  || null,
    bust_date:   localStorage.getItem(AC_BUST) || null,
    predictions: predsSlim,   // ← historial de pronósticos para stats globales
    nickname:    localStorage.getItem(GB_NICK) || null,
    avatar:      localStorage.getItem(GB_AVA)  || null,
    updated_at:  new Date().toISOString()
  };
  const { error } = await sbClient
    .from('acoin_users')
    .upsert(payload, { onConflict: 'email' });
  if (error) {
    // Si falla por columna inexistente, reintentar sin predictions
    if (error.message && error.message.includes('predictions')) {
      const { error: e2 } = await sbClient.from('acoin_users')
        .upsert({ ...payload, predictions: undefined }, { onConflict: 'email' });
      if (e2) console.warn('[Supabase sync error]', e2.message);
    } else {
      console.warn('[Supabase sync error]', error.message);
    }
  }
}

async function acLoadFromDB(email) {
  const { data, error } = await sbClient
    .from('acoin_users')
    .select('*')
    .eq('email', email)
    .maybeSingle();
  if (error) { console.warn('[Supabase load error]', error.message); return; }
  if (data) {
    // ── Merge strategy: never lose locally-earned coins ──
    const localBal  = parseInt(localStorage.getItem(AC_BAL)  || '0', 10);
    const localHist = JSON.parse(localStorage.getItem(AC_HIST) || '[]');
    const localPick = JSON.parse(localStorage.getItem(AC_PICK) || '[]');
    const localDay  = localStorage.getItem(AC_DAY) || '';

    const dbBal  = data.balance     || 0;
    const dbHist = data.history     || [];
    const dbPick = data.picks       || [];
    const dbDay  = data.last_daily  || '';

    // Balance: keep the higher value (never lose offline coins or daily bonus)
    const mergedBal = Math.max(localBal, dbBal);

    // History: union by entry key — deduplicate por reason+delta (NOT balance que varía)
    const histMap = new Map();
    [...dbHist, ...localHist].forEach(h => {
      const key = (h.ts || h.timestamp || h.date || '') + '|' + (h.reason || h.label || h.text || h.event || '') + '|' + (h.delta || 0);
      if (!histMap.has(key)) histMap.set(key, h);
    });
    const mergedHist = [...histMap.values()];

    // Picks: union — clave robusta: home+away+ts+pick (no JSON.stringify que varía por orden de campos)
    const pickMap = new Map();
    [...dbPick, ...localPick].forEach(p => {
      const key = `${p.home||''}|${p.away||''}|${p.ts||''}|${p.pick||''}`;
      if (!pickMap.has(key)) pickMap.set(key, p);
    });
    const mergedPick = [...pickMap.values()];

    // last_daily: keep the most recent date string
    const mergedDay = localDay > dbDay ? localDay : dbDay;

    // bust_date: keep if set in either side
    const localBust = localStorage.getItem(AC_BUST) || '';
    const dbBust    = data.bust_date || '';
    const mergedBust = localBust || dbBust;

    // Write merged result to localStorage
    localStorage.setItem(AC_BAL,  mergedBal);
    localStorage.setItem(AC_HIST, JSON.stringify(mergedHist));
    localStorage.setItem(AC_PICK, JSON.stringify(mergedPick));
    if (mergedDay)  localStorage.setItem(AC_DAY,  mergedDay);
    if (mergedBust) localStorage.setItem(AC_BUST, mergedBust);
    else            localStorage.removeItem(AC_BUST);

    // Nickname / avatar: DB wins only if local is empty (so we don't lose onboarding done offline)
    if (data.nickname && !localStorage.getItem(GB_NICK)) localStorage.setItem(GB_NICK, data.nickname);
    if (data.avatar   && !localStorage.getItem(GB_AVA))  localStorage.setItem(GB_AVA,  data.avatar);

    // If local state was richer than DB, push the merged data back up
    if (mergedBal > dbBal || mergedHist.length > dbHist.length || mergedPick.length > dbPick.length) {
      console.log('[A-Coin] Local ahead of DB — syncing merged data up');
      acScheduleSync();
    }
  } else {
    // New user — dar bonus de bienvenida ANTES del primer sync a la DB
    acCheckDaily();
    await acSyncToDB();  // guarda directamente con balance=10.000
  }
  // Run daily bonus check on the now-accurate merged balance
  _purgeNbaPicks();   // limpiar picks NBA del historial y  antes de renderizar
  acPurgeOldPicks();  // limpiar picks evaluados >30 días para no inflar localStorage
  acCheckDaily();
  acUpdateUI();
  applyUserProfile(); // re-aplicar nick/avatar ahora que la DB está cargada
  renderPreds(); // refresh pick buttons with loaded state
  renderMyPicks(); // actualizar panel de stats personales
}

// ═══════════════════════════════════════════════
//  LIVE STATS (Hero section — Supabase aggregate)
// ═══════════════════════════════════════════════
const STATS_CACHE_KEY = 'ia_live_stats_v4'; // v4: hero muestra Picks de hoy en vez de ROI
const STATS_CACHE_TTL = 30 * 60 * 1000; // 30 min

// ── Caché genérico con TTL para reducir carga en Supabase ──────────────────
// Usado por sbLoadGlobalHistorial, checkBroadcastMessages y loadLiveStats
// para no disparar queries en cada carga de página con muchos usuarios.
const _SB_CACHE_PREFIX = '_gb_sbc2_'; // v2: fuerza invalidación de caché viejo
function _sbGetCache(key) {
  try {
    const raw = localStorage.getItem(_SB_CACHE_PREFIX + key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.ts || !obj.ttl) return null;
    if (Date.now() - obj.ts > obj.ttl) { localStorage.removeItem(_SB_CACHE_PREFIX + key); return null; }
    return obj.data;
  } catch { return null; }
}
function _sbSetCache(key, data, ttlMs) {
  try { localStorage.setItem(_SB_CACHE_PREFIX + key, JSON.stringify({ data, ts: Date.now(), ttl: ttlMs })); } catch {}
}
const _SB_TTL_GHIST    = 2 * 60 * 1000;   // historial global: 2 min (reducido para que picks nuevos aparezcan rápido)
const _SB_TTL_BCAST    = 15 * 60 * 1000;  // broadcast msgs:  15 min (era 3)
const _SB_TTL_STATS    = 60 * 60 * 1000;  // hero stats:      60 min (era 30)
const HERO_PICKS_BASE  = 0;               // sin piso artificial — se usa el total real



function animateCounter(el, from, to, suffix, duration) {
  if (!el) return;
  const start = performance.now();
  const diff  = to - from;
  function step(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    // ease-out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(from + diff * eased);
    el.textContent = current.toLocaleString('es-AR') + suffix;
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function heroStatsApply(picksToday, totalPicks, animate) {
  const elP = document.getElementById('heroStatPrecision'); // ⚠️ deprecated (Picks hoy removido del hero)
  const elN = document.getElementById('heroStatPicks');
  if (!elN) return; // solo necesitamos el contador total
  const hoy = parseInt(picksToday, 10) || 0;
  if (elP) elP.style.color = 'var(--verde)';
  // Conteo real de picks (sin tope artificial)
  const totalStr = (parseInt(totalPicks, 10) || 0).toLocaleString('es-AR');
  if (animate) {
    if (elP) animateCounter(elP, 0, hoy, '', 1200);
    elN.textContent = totalStr;
  } else {
    if (elP) elP.textContent = String(hoy);
    elN.textContent = totalStr;
  }
}

function computeStatsFromHistorial(rows) {
  // rows = array de arrays de predicciones (cada usuario aporta el suyo)
  // también acepta un único array plano (historial local)
  const flat = rows.length && Array.isArray(rows[0]) ? rows.flat() : rows;
  const total   = flat.length;
  const wins    = flat.filter(h => h && h.result === 'win').length;
  const losses  = flat.filter(h => h && h.result === 'loss').length;
  const resolved = wins + losses;
  const precision = resolved >= 5
    ? Math.round((wins / resolved) * 100)
    : null;
  // ROI con apuestas unitarias y cuotas reales de cada pick
  const _comp = flat.filter(h => h && h.result !== 'pending' && h.result !== 'void');
  const _pl   = flat.reduce((s,h) => s + (h && h.pl ? h.pl : 0), 0);
  const _stk  = _comp.reduce((s,h) => s + (h.stake || 0), 0);
  const roi   = _stk >= 10 ? parseFloat((_pl / _stk * 100).toFixed(1)) : null;
  // Picks de hoy: partidos cuya fecha (hora ARG) es hoy
  const _fmtAR = ts => new Date(ts).toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit',timeZone:'America/Argentina/Buenos_Aires'});
  const _todayAR = _fmtAR(Date.now());
  const picksToday = flat.filter(h => h && h.commenceTs && _fmtAR(h.commenceTs) === _todayAR).length;
  return { total, wins, losses, resolved, precision, roi, picksToday };
}

async function loadLiveStats() {
  // Invalidar caché de stats si fue guardada sin roi (versión anterior)
  try {
    const _sc = localStorage.getItem(STATS_CACHE_KEY);
    if (_sc) { const _sco = JSON.parse(_sc); if (_sco && !('picksToday' in _sco)) localStorage.removeItem(STATS_CACHE_KEY); }
  } catch {}
  // ── PASO 1: mostrar stats locales instantáneamente ──
  // (siempre disponibles, sin esperar red)
  // loadHistorial() está definida más adelante en el código,
  // la llamamos con un try/catch por si aún no está disponible
  let localStats = null;
  try {
    if (typeof migrateHistStakes === 'function') migrateHistStakes(); // asegurar datos migrados
    const localHist = (typeof loadHistorial === 'function') ? loadHistorial() : [];
    if (localHist.length > 0) {
      localStats = computeStatsFromHistorial(localHist);
      const _localTotal = Math.max(HERO_PICKS_BASE, localStats.total);
      heroStatsApply(localStats.picksToday, _localTotal, true);
    }
  } catch(_) {}

  // ── PASO 2: stats reales desde el historial compartido del backend ──
  // Usa /api/sb?type=historial — la MISMA fuente que ve todo visitante (incl. incógnito).
  // Esto garantiza que el total de picks no dependa del localStorage del usuario.
  try {
    const resp = await fetch('/api/sb?type=historial');
    if (!resp.ok) throw new Error(`proxy ${resp.status}`);
    const d = await resp.json();
    const histFull = (Array.isArray(d) && d[0] && Array.isArray(d[0].historial_full))
      ? d[0].historial_full : [];

    if (histFull.length > 0) {
      const gs = computeStatsFromHistorial(histFull);
      // Total: el del historial compartido (o el local si fuera mayor, ej. admin con picks nuevos)
      const total      = Math.max(gs.total || 0, localStats?.total || 0);
      const picksToday = gs.picksToday != null ? gs.picksToday : (localStats?.picksToday || 0);
      localStorage.setItem(STATS_CACHE_KEY, JSON.stringify({
        picksToday, totalPicks: total, ts: Date.now(), source: 'historial'
      }));
      heroStatsApply(picksToday, total, true);
      return;
    }
    throw new Error('historial vacío');
  } catch(e) {
    // Si ya teníamos stats locales, quedan aplicadas del PASO 1.
    // Si no había nada (incógnito + backend caído), mostrar guión en lugar de 0.
    if (!localStats || localStats.total === 0) {
      const elP = document.getElementById('heroStatPrecision');
      const elN = document.getElementById('heroStatPicks');
      if (elP) elP.textContent = '–';
      if (elN) elN.textContent = '–';
    }
  }
}

// ═══════════════════════════════════════════════
//  DATA
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════
//  LOGOS OFICIALES
// ═══════════════════════════════════════════════
// Logos que necesitan fondo de color del club (badge blanco sobre fondo oscuro)
// El color de fondo se aplica como círculo coloreado detrás del escudo
// Randers FC → rojo (#c8102e) para que el escudo blanco destaque
const _whiteBgLogos = new Set([
  'Randers FC',
]);

const teamLogos = {
  // ── ESPAÑA ──
  'Real Madrid':            '/escudos/real-madrid.png',
  'Barcelona':              '/escudos/barcelona.png',
  'FC Barcelona':           '/escudos/barcelona.png',
  'Atlético Madrid':        '/escudos/atletico-madrid.png',
  'Atletico Madrid':        '/escudos/atletico-madrid.png',
  'Atlético':               '/escudos/atletico-madrid.png',
  'Sevilla':                '/escudos/sevilla.png',
  'Sevilla FC':             '/escudos/sevilla.png',
  'Valencia':               '/escudos/valencia.png',
  'Valencia CF':            '/escudos/valencia.png',
  'Villarreal':             '/escudos/villarreal.png',
  'Villarreal CF':          '/escudos/villarreal.png',
  'Real Betis':             '/escudos/real-betis.png',
  'Athletic Club':          '/escudos/athletic-club.png',
  'Athletic Bilbao':        '/escudos/athletic-club.png',
  'Levante':                '/escudos/levante.png',
  'Levante UD':             '/escudos/levante.png',
  'Real Oviedo':            '/escudos/real-oviedo.png',
  'Oviedo':                 '/escudos/real-oviedo.png',
  'Elche':                  '/escudos/elche.png',
  'Elche CF':               '/escudos/elche.png',
  'Real Sociedad':          '/escudos/real-sociedad.png',
  'Getafe':                 '/escudos/getafe.png',
  'Getafe CF':              '/escudos/getafe.png',
  // ── INGLATERRA ──
  'Manchester City':        '/escudos/manchester-city.png',
  'Man City':               '/escudos/manchester-city.png',
  'Liverpool':              '/escudos/liverpool.png',
  'Arsenal':                '/escudos/arsenal.png',
  'Arsenal FC':             '/escudos/arsenal.png',
  'Chelsea':                '/escudos/chelsea.png',
  'Chelsea FC':             '/escudos/chelsea.png',
  'Manchester United':      '/escudos/manchester-united.png',
  'Man United':             '/escudos/manchester-united.png',
  'Tottenham Hotspur':      '/escudos/tottenham-hotspur.png',
  'Tottenham':              '/escudos/tottenham-hotspur.png',
  'Spurs':                  '/escudos/tottenham-hotspur.png',
  'Newcastle United':       '/escudos/newcastle-united.png',
  'Newcastle':              '/escudos/newcastle-united.png',
  'Aston Villa':            '/escudos/aston-villa.png',
  'West Ham United':        '/escudos/west-ham-united.png',
  'West Ham':               '/escudos/west-ham-united.png',
  'Brighton':               '/escudos/brighton.png',
  'Brighton & Hove Albion': '/escudos/brighton.png',
  'Brighton and Hove Albion':'/escudos/brighton.png',
  'Wolverhampton':          '/escudos/wolverhampton.png',
  'Wolves':                 '/escudos/wolverhampton.png',
  'Brentford':              '/escudos/brentford.png',
  'Fulham':                 '/escudos/fulham.png',
  'Everton':                '/escudos/everton.png',
  'Crystal Palace':         '/escudos/crystal-palace.png',
  'Bournemouth':            '/escudos/bournemouth.png',
  'AFC Bournemouth':        '/escudos/bournemouth.png',
  'Nottingham Forest':      '/escudos/nottingham-forest.png',
  "Nott'm Forest":          'https://media.api-sports.io/football/teams/65.png',
  'Southampton':            '/escudos/southampton.png',
  // ── ALEMANIA ──
  'Bayern Munich':          '/escudos/bayern-munich.png',
  'FC Bayern München':      '/escudos/bayern-munich.png',
  'Bayern':                 '/escudos/bayern-munich.png',
  'Borussia Dortmund':      '/escudos/borussia-dortmund.png',
  'Dortmund':               '/escudos/borussia-dortmund.png',
  'RB Leipzig':             '/escudos/rb-leipzig.png',
  'Bayer Leverkusen':       '/escudos/bayer-leverkusen.png',
  'Leverkusen':             '/escudos/bayer-leverkusen.png',
  'Eintracht Frankfurt':    '/escudos/eintracht-frankfurt.png',
  'Frankfurt':              '/escudos/eintracht-frankfurt.png',
  '1. FC Heidenheim 1846':  '/escudos/1-fc-heidenheim-1846.png',
  'Wolfsburg':              '/escudos/wolfsburg.png',
  'VfL Wolfsburg':          '/escudos/wolfsburg.png',
  'Freiburg':               '/escudos/freiburg.png',
  'SC Freiburg':            '/escudos/freiburg.png',
  'Union Berlin':           '/escudos/union-berlin.png',
  '1. FC Union Berlin':     '/escudos/union-berlin.png',
  'Borussia Mönchengladbach':'/escudos/borussia-monchengladbach.png',
  'Werder Bremen':          '/escudos/werder-bremen.png',
  'Stuttgart':              '/escudos/stuttgart.png',
  'VfB Stuttgart':          '/escudos/stuttgart.png',
  'Augsburg':               '/escudos/augsburg.png',
  'FC Augsburg':            '/escudos/augsburg.png',
  // ── ITALIA ──
  'Inter Milán':            '/escudos/inter-milan.png',
  'FC Venezia':             '/escudos/fc-venezia.png',
  // ── FRANCIA ──
  'Paris Saint Germain':    '/escudos/paris-saint-germain.png',
  'Paris SG':               '/escudos/paris-saint-germain.png',
  'PSG':                    '/escudos/paris-saint-germain.png',
  'Olympique Lyonnais':     '/escudos/olympique-lyonnais.png',
  'Lyon':                   '/escudos/olympique-lyonnais.png',
  'Olympique de Marseille': '/escudos/olympique-de-marseille.png',
  'Marseille':              '/escudos/olympique-de-marseille.png',
  'Monaco':                 '/escudos/monaco.png',
  'AS Monaco':              '/escudos/monaco.png',
  'Lille':                  '/escudos/lille.png',
  'LOSC Lille':             '/escudos/lille.png',
  'Rennes':                 '/escudos/rennes.png',
  'Stade Rennais':          '/escudos/rennes.png',
  'Nice':                   '/escudos/nice.png',
  'OGC Nice':               '/escudos/nice.png',
  'Lens':                   '/escudos/lens.png',
  'RC Lens':                '/escudos/lens.png',
  'Montpellier':            '/escudos/montpellier.png',
  'Montpellier HSC':        '/escudos/montpellier.png',
  'Nantes':                 '/escudos/nantes.png',
  'FC Nantes':              '/escudos/nantes.png',
  'Strasbourg':             '/escudos/strasbourg.png',
  'RC Strasbourg':          '/escudos/strasbourg.png',
  'RC Strasbourg Alsace':   '/escudos/strasbourg.png',
  'Toulouse':               '/escudos/toulouse.png',
  'Toulouse FC':            '/escudos/toulouse.png',
  'Reims':                  '/escudos/reims.svg',
  'Stade de Reims':         '/escudos/reims.svg',
  'Saint-Étienne':          '/escudos/saint-etienne.svg',
  'AS Saint-Etienne':       '/escudos/as-saint-etienne.png',
  'AS Saint-Étienne':       '/escudos/saint-etienne.svg',
  'Le Havre':               '/escudos/le-havre.png',
  'Le Havre AC':            '/escudos/le-havre.png',
  'Lorient':                '/escudos/as-saint-etienne.png',
  'FC Lorient':             '/escudos/as-saint-etienne.png',
  'Angers':                 '/escudos/angers.png',
  'SCO Angers':             '/escudos/angers.png',
  'Brest':                  '/escudos/brest.png',
  'Stade Brestois':         '/escudos/brest.png',
  'Stade Brestois 29':      '/escudos/brest.png',
  'Auxerre':                '/escudos/auxerre.png',
  'AJ Auxerre':             '/escudos/auxerre.png',
  'Metz':                   '/escudos/metz.png',
  'FC Metz':                '/escudos/metz.png',
  'Clermont':               '/escudos/clermont.svg',
  'Clermont Foot':          '/escudos/clermont.svg',
  'Clermont Foot 63':       '/escudos/clermont.svg',
  // ── ALEMANIA (completo) ──
  'Hoffenheim':             '/escudos/hoffenheim.png',
  'TSG Hoffenheim':         '/escudos/hoffenheim.png',
  'Mainz':                  '/escudos/mainz.png',
  'Mainz 05':               '/escudos/mainz.png',
  '1. FSV Mainz 05':        '/escudos/mainz.png',
  'FSV Mainz 05':           '/escudos/mainz.png',
  'Bochum':                 '/escudos/bochum.png',
  'VfL Bochum':             '/escudos/bochum.png',
  'St. Pauli':              '/escudos/st-pauli.png',
  'FC St. Pauli':           '/escudos/st-pauli.png',
  'HSV':                    '/escudos/hsv.svg',
  'Köln':                   '/escudos/koln.png',
  'FC Köln':                '/escudos/koln.png',
  '1. FC Köln':             '/escudos/koln.png',
  'FC Cologne':             '/escudos/koln.png',
  // ── ITALIA (completo, IDs corregidos) ──
  'Sassuolo':               '/escudos/sassuolo.png',
  'US Sassuolo':            '/escudos/sassuolo.png',
  'Pisa SC':                '/escudos/pisa-sc.svg',
  // ── ESPAÑA (completo) ──
  'Real Valladolid CF':     '/escudos/real-valladolid-cf.png',
  'Cádiz':                  '/escudos/cadiz.png',
  'Cadiz CF':               '/escudos/cadiz.png',
  'Cádiz CF':               '/escudos/cadiz.png',
  'Granada':                '/escudos/granada.png',
  'Granada CF':             '/escudos/granada.png',
  // ── ESPAÑA – Segunda División ──
  'Albacete':               '/escudos/albacete.png',
  'Albacete Balompié':      '/escudos/albacete.png',
  'Burgos':                 '/escudos/burgos.png',
  'Burgos CF':              '/escudos/burgos.png',
  'Castellón':              '/escudos/castellon.png',
  'CD Castellón':           '/escudos/castellon.png',
  'Ceuta':                  '/escudos/ceuta.png',
  'AD Ceuta':               '/escudos/ceuta.png',
  'AD Ceuta FC':            '/escudos/ceuta.png',
  'Córdoba':                '/escudos/cordoba.png',
  'Córdoba CF':             '/escudos/cordoba.png',
  'Cordoba CF':             '/escudos/cordoba.png',
  'Cultural Leonesa':       '/escudos/cultural-leonesa.png',
  'Cultural y Deportiva Leonesa': '/escudos/cultural-leonesa.png',
  'Deportivo':              '/escudos/deportivo.png',
  'RC Deportivo':           '/escudos/deportivo.png',
  'Deportivo de La Coruña': '/escudos/deportivo.png',
  'Deportivo La Coruña':    '/escudos/deportivo.png',
  'Eibar':                  '/escudos/eibar.png',
  'SD Eibar':               '/escudos/eibar.png',
  'Huesca':                 '/escudos/huesca.png',
  'SD Huesca':              '/escudos/huesca.png',
  'FC Andorra':             '/escudos/fc-andorra.png',
  'Andorra':                '/escudos/fc-andorra.png',
  'Mirandés':               '/escudos/mirandes.png',
  'CD Mirandés':            '/escudos/mirandes.png',
  'Mirandes':               '/escudos/mirandes.png',
  'Málaga':                 '/escudos/malaga.png',
  'Málaga CF':              '/escudos/malaga.png',
  'Malaga CF':              '/escudos/malaga.png',
  'Racing Santander':       '/escudos/racing-santander.png',
  'Racing de Santander':    '/escudos/racing-santander.png',
  'Real Racing Club':       '/escudos/racing-santander.png',
  'Real Sociedad B':        '/escudos/real-sociedad-b.png',
  'Real Sociedad II':       '/escudos/real-sociedad-b.png',
  'Sporting Gijón':         '/escudos/sporting-gijon.png',
  'Sporting de Gijón':      '/escudos/sporting-gijon.png',
  'Real Zaragoza':          '/escudos/real-zaragoza.png',
  'Zaragoza':               '/escudos/real-zaragoza.png',
  // ── COPA LIBERTADORES / SUDAMERICANA – otros países ──
  'Colo-Colo':              '/escudos/colo-colo.png',
  'Universidad de Chile':   '/escudos/universidad-de-chile.png',
  'U de Chile':             '/escudos/universidad-de-chile.png',
  'U. de Chile':            '/escudos/universidad-de-chile.png',
  'Universidad Católica':   '/escudos/universidad-catolica.png',
  'U. Católica':                    '/escudos/universidad-catolica.png',
  'U Católica':                     '/escudos/universidad-catolica.png',
  'Universidad Católica de Chile':  '/escudos/universidad-catolica.png',
  'CD Universidad Católica':        '/escudos/universidad-catolica.png',
    'Universidad Católica (CHI)':     '/escudos/universidad-catolica.png',
  'Everton de Viña':        '/escudos/everton-de-vina.png',
  'Everton de Viña del Mar':'/escudos/everton-de-vina.png',
  // 'Nacional' a secas = Nacional de Montevideo (Uruguay) — club recurrente en Libertadores/Sudamericana.
  // El CD Nacional da Madeira (Portugal) se resuelve solo con nombre calificado.
  'Nacional':               '/escudos/nacional.png',
  'Nacional Madeira':       '/escudos/nacional-madeira.png',
  'Nacional da Madeira':    '/escudos/nacional-madeira.png',
  'CD Nacional':            '/escudos/nacional-madeira.png',
  'Atletico Peñarol':       '/escudos/atletico-penarol.png',
  'Atletico Nacional':      '/escudos/atletico-nacional.png',
  'Atlético Nacional':      '/escudos/atletico-nacional.png',
  'Independiente Medellín': '/escudos/independiente-medellin.png',
  'Independiente Medellin': '/escudos/independiente-medellin.png',
  'Ind. Medellín':          '/escudos/independiente-medellin.png',
  'Ind. Medellin':          '/escudos/independiente-medellin.png',
  'Junior de Barranquilla': '/escudos/junior-de-barranquilla.png',
  'America de Cali':        '/escudos/america-de-cali.png',
  'Barcelona SC':           '/escudos/barcelona-sc.png',
  'Barcelona Guayaquil':    '/escudos/barcelona-sc.png',
  // Odds API a veces devuelve "Barcelona" sin "SC" para el equipo de Guayaquil en Copa Libertadores
  // La entrada 'Barcelona' (FC España) en línea 5854 es la que prevalece para picks de La Liga
  // Este alias cubre el caso de historial donde se guardó como "Barcelona" en contexto CONMEBOL
  'Barcelona (ECU)':        '/escudos/barcelona-sc.png',
  'Bolívar':                '/escudos/bolivar.png',
  'Club Bolívar':           '/escudos/bolivar.png',
  // Aliases Copa Libertadores – variantes de nombre API
  'Club Universitario de Deportes': '/escudos/club-universitario-de-deportes.png',
  'Club Universitario':     '/escudos/club-universitario-de-deportes.png',
  'Cienciano':              '/escudos/cienciano.png',
  'Club Cienciano':         '/escudos/cienciano.png',
  'Club Always Ready':      '/escudos/club-always-ready.png',
  'Club Independiente Petrolero': '/escudos/club-independiente-petrolero.png',
  'Ind. Petrolero':           '/escudos/club-independiente-petrolero.png',
  'Nacional de Montevideo': '/escudos/nacional.png',
  'Peñarol Montevideo':     '/escudos/atletico-penarol.png',
  'Libertad Asuncion':      '/escudos/libertad-asuncion.png',
  'Libertad Asunción':      '/escudos/libertad-asuncion.png',
  'Olimpia Asunción':       '/escudos/olimpia-asuncion.png',
  'UCV FC':                 '/escudos/ucv-fc.png',  // The Odds API devuelve "UCV FC" para Universidad Central de VENEZUELA (Libertadores)
  'Universidad César Vallejo': '/escudos/universidad-cesar-vallejo.png',  // César Vallejo Perú (ESPN 3380 era originalmente para este)
  'Universidad Cesar Vallejo': '/escudos/universidad-cesar-vallejo.png',
  'César Vallejo':          '/escudos/universidad-cesar-vallejo.png',
  'Cesar Vallejo':          '/escudos/universidad-cesar-vallejo.png',
  'CA Juventud':            '/escudos/ca-juventud.png',
  'CA Boston River':        '/escudos/ca-boston-river.png',
  'C.D. Cuenca':            '/escudos/c-d-cuenca.png',
  // Brasileños con sufijo de ciudad en Libertadores
  'Fluminense-RJ':          '/escudos/fluminense-rj.png',
  'Flamengo-RJ':            '/escudos/flamengo-rj.png',
  'Palmeiras-SP':           '/escudos/palmeiras-sp.png',
  'Corinthians-SP':         '/escudos/corinthians-sp.png',
  'Clube Atlético Mineiro': '/escudos/clube-atletico-mineiro.png',
  // ── ARGENTINA Primera Nacional ──
  'Quilmes':                '/escudos/quilmes.png',
  'Almirante Brown':        '/escudos/almirante-brown.png',
  'Deportivo Riestra':      '/escudos/deportivo-riestra.png',
  'Brown de Adrogué':       '/escudos/brown-de-adrogue.png',
  'Ferro Carril Oeste':     '/escudos/ferro-carril-oeste.png',
  'Güemes':                 '/escudos/guemes.png',
  'Chacarita Juniors':      '/escudos/chacarita-juniors.png',
  'Atlanta':                '/escudos/atlanta.png',
  'Temperley':              '/escudos/temperley.png',
  'Mitre':                  '/escudos/mitre.png',
  'San Telmo':              '/escudos/san-telmo.png',
  // ── EUROPA LEAGUE / CHAMPIONS – clubes adicionales ──
  'Sporting Lisbon':        '/escudos/sporting-lisbon.png',
  'Bodø/Glimt':             '/escudos/bod-glimt.png',
  'Bodo/Glimt':             '/escudos/bod-glimt.png',
  'FK Bodø/Glimt':          '/escudos/bod-glimt.png',
  'Club Bruges':            '/escudos/club-bruges.png',
  'FC Salzburg':            '/escudos/fc-salzburg.png',
  'HNK Rijeka':             '/escudos/hnk-rijeka.png',
  'Rijeka':                 '/escudos/hnk-rijeka.png',
  'NK Rijeka':              '/escudos/hnk-rijeka.png',
  'Lech Poznan':            '/escudos/lech-poznan.png',
  'Lech Poznań':            '/escudos/lech-poznan.png',
  'KKS Lech Poznan':        '/escudos/lech-poznan.png',
  'KKS Lech Poznań':        '/escudos/lech-poznan.png',
  // Polonia — Ekstraklasa (URLs api-sports.io que sí existen; aliases con nombre corto)
  'Jagiellonia':            '/escudos/jagiellonia.png',
  'Jagiellonia Białystok':  '/escudos/jagiellonia.png',
  'Jagiellonia Bialystok':  '/escudos/jagiellonia.png',
  'Raków':                  '/escudos/rakow.png',
  'Raków Częstochowa':      '/escudos/rakow.png',
  'Rakow Czestochowa':      '/escudos/rakow.png',
  'Legia':                  '/escudos/legia.png',
  'Legia Warszawa':         '/escudos/legia.png',
  'Piast Gliwice':          '/escudos/piast-gliwice.png',
  'Piast':                  '/escudos/piast-gliwice.png',
  'GKS Katowice':           '/escudos/gks-katowice.png',
  'Wisła':                  '/escudos/wis-a.png',
  'Wisła Kraków':           '/escudos/wis-a.png',
  'Cracovia':               '/escudos/cracovia.png',
  'Cracovia Kraków':        '/escudos/cracovia.png',
  'Cracovia Krakow':        '/escudos/cracovia.png',
  'MKS Cracovia':           '/escudos/cracovia.png',
  'Pogoń':                  '/escudos/pogon.png',
  'Pogoń Szczecin':         '/escudos/pogon.png',
  'Górnik':                 '/escudos/gornik.png',
  'Górnik Zabrze':          '/escudos/gornik.png',
  'Widzew':                 '/escudos/widzew.png',
  'Widzew Łódź':            '/escudos/widzew.png',
  'Zagłębie':               '/escudos/zag-ebie.png',
  'Zagłębie Lubin':         '/escudos/zag-ebie.png',
  'Stal Mielec':            '/escudos/stal-mielec.png',
  'Korona':                 '/escudos/korona.png',
  'Korona Kielce':          '/escudos/korona.png',
  'Radomiak':               '/escudos/radomiak.png',
  'Radomiak Radom':         '/escudos/radomiak.png',
  'Lechia':                 '/escudos/lechia.png',
  'Lechia Gdańsk':          '/escudos/lechia.png',
  'Termalica':              '/escudos/termalica.png',
  'Termalica Nieciecza':    '/escudos/termalica.png',
  'Bruk-Bet Termalica Nieciecza': '/escudos/termalica.png',
  'Bruk-Bet Termalica':     '/escudos/termalica.png',
  'Bruk-Bet Nieciecza':     '/escudos/termalica.png',
  'Termalica BB Nieciecza': '/escudos/termalica.png',
  'KS Termalica':           '/escudos/termalica.png',
  'Nieciecza':              '/escudos/termalica.png',
  'Motor':                  '/escudos/motor.png',
  'Motor Lublin':           '/escudos/motor.png',
  // ── ARGENTINA (todos con URLs verificadas de Wikipedia/Wikimedia) ──
  'River Plate':            '/escudos/river-plate.png',
  'River':                  '/escudos/river-plate.png',
  'Boca Juniors':           '/escudos/boca-juniors.png',
  'Boca':                   '/escudos/boca-juniors.png',
  'Racing Club':            '/escudos/racing-club.png',
  'San Lorenzo':            '/escudos/san-lorenzo.png',
  'San Lorenzo de Almagro': '/escudos/san-lorenzo.png',
  'Independiente':          '/escudos/independiente.png',
  'Estudiantes':            '/escudos/estudiantes.png',
  'Estudiantes de La Plata':'/escudos/estudiantes.png',
  'Estudiantes La Plata':   '/escudos/estudiantes.png',
  'Vélez Sársfield':        '/escudos/velez-sarsfield.png',
  'Velez Sarsfield':        '/escudos/velez-sarsfield.png',
  'Vélez':                  '/escudos/velez-sarsfield.png',
  'Velez':                  '/escudos/velez-sarsfield.png',
  'Velez Sarsfield BA':     '/escudos/velez-sarsfield.png',
  'Lanús':                  '/escudos/lanus.png',
  'Lanus':                  '/escudos/lanus.png',
  'Talleres':               '/escudos/talleres.png',
  'Talleres de Córdoba':    '/escudos/talleres.png',
  'Belgrano':               '/escudos/belgrano.png',
  'Belgrano de Cordoba':    '/escudos/belgrano.png',
  'Belgrano de Córdoba':    '/escudos/belgrano.png',
  'CA Belgrano':            '/escudos/belgrano.png',
  'Huracán':                '/escudos/huracan.png',
  'Huracan':                '/escudos/huracan.png',
  'Atlético Huracán':       '/escudos/huracan.png',
  'Atletico Huracan':       '/escudos/huracan.png',
  'CA Huracán':             '/escudos/huracan.png',
  'Aldosivi':               '/escudos/aldosivi.png',
  'Aldosivi Mar del Plata': '/escudos/aldosivi.png',
  'Estudiantes de Río Cuarto': '/escudos/estudiantes-de-rio-cuarto.png',
  'Estudiantes Rio Cuarto': '/escudos/estudiantes-de-rio-cuarto.png',
  'Instituto de Córdoba':   '/escudos/instituto-de-cordoba.png',
  'Instituto de Cordoba':   '/escudos/instituto-de-cordoba.png',
  'Defensa y Justicia':     '/escudos/defensa-y-justicia.png',
  'Banfield':               '/escudos/banfield.png',
  'Tigre':                  '/escudos/tigre.png',
  'CA Tigre BA':            '/escudos/tigre.png',
  'CA Tigre':               '/escudos/tigre.png',
  'Godoy Cruz':             '/escudos/godoy-cruz.png',
  'Godoy Cruz Antonio Tomba':'/escudos/godoy-cruz.png',
  'Argentinos Juniors':     '/escudos/argentinos-juniors.png',
  "Newell's Old Boys":      'https://a.espncdn.com/i/teamlogos/soccer/500/14.png',
  'Newells Old Boys':       '/escudos/newells-old-boys.png',
  'Newell Old Boys':        '/escudos/newells-old-boys.png',
  'Rosario Central':        '/escudos/rosario-central.png',
  'Colón':                  '/escudos/colon.png',
  'Colon':                  '/escudos/colon.png',
  'Unión':                  '/escudos/union.png',
  'Union':                  '/escudos/union.png',
  'Union Santa Fe':         '/escudos/union.png',
  'Unión Santa Fe':         '/escudos/union.png',
  'Platense':               '/escudos/platense.png',
  'Sarmiento':              '/escudos/sarmiento.png',
  'Sarmiento de Junin':     '/escudos/sarmiento.png',
  'Sarmiento de Junín':     '/escudos/sarmiento.png',
  'CA Sarmiento':           '/escudos/sarmiento.png',
  'Gimnasia La Plata':      '/escudos/gimnasia-la-plata.png',
  'Gimnasia y Esgrima':     '/escudos/gimnasia-la-plata.png',
  'Gimnasia y Esgrima La Plata': '/escudos/gimnasia-la-plata.png',
  'Gimnasia LP':            '/escudos/gimnasia-la-plata.png',
  'Gimnasia Mendoza':       '/escudos/gimnasia-mendoza.png',
  'Gimnasia y Esgrima Mendoza': '/escudos/gimnasia-mendoza.png',
  'Gimnasia (Mendoza)':     '/escudos/gimnasia-mendoza.png',
  'Independiente Rivadavia':'/escudos/independiente-rivadavia.png',
  'Ind. Rivadavia':         '/escudos/independiente-rivadavia.png',
  'Central Córdoba':        '/escudos/central-cordoba.png',
  'Central Cordoba':        '/escudos/central-cordoba.png',
  'Instituto':              '/escudos/instituto-de-cordoba.png',
  'Arsenal de Sarandí':     '/escudos/arsenal-de-sarandi.png',
  'Arsenal Sarandi':        '/escudos/arsenal-de-sarandi.png',
  'Atlético Tucumán':       '/escudos/atletico-tucuman.png',
  'Atletico Tucuman':       '/escudos/atletico-tucuman.png',
  'Atlético Tucuman':       '/escudos/atletico-tucuman.png',
  'Barracas Central':       '/escudos/barracas-central.png',
  'Instituto Córdoba':      '/escudos/instituto-de-cordoba.png',
  'Instituto Atletico Central Cordoba': '/escudos/instituto-de-cordoba.png',
  // ── BRASIL ──
  'Sport Club Internacional':'/escudos/sport-club-internacional.png',
  'Atlético Paranaense':            '/escudos/atletico-paranaense.png',
  'Atlético-MG':            '/escudos/atletico-mg.png',
  // ── BRASIL (completo Série A) ──
  'Cruzeiro':               '/escudos/cruzeiro.png',
  'Cruzeiro EC':            '/escudos/cruzeiro.png',
  'Vasco da Gama':          '/escudos/cr-vasco-da-gama.png',
  'CR Vasco da Gama':       '/escudos/cr-vasco-da-gama.png',
  'Vasco':                  '/escudos/cr-vasco-da-gama.png',
  'Fortaleza':              '/escudos/gimnasia-mendoza.png',
  'Fortaleza EC':           '/escudos/gimnasia-mendoza.png',
  'Bahia':                  '/escudos/bahia.png?v=2',
  'EC Bahia':               '/escudos/bahia.png?v=2',
  'Red Bull Bragantino':    '/escudos/red-bull-bragantino-v2.png',
  'RB Bragantino':          '/escudos/red-bull-bragantino-v2.png',
  'Bragantino':             '/escudos/red-bull-bragantino-v2.png',
  'Bragantino-SP':          '/escudos/red-bull-bragantino-v2.png',
  'Sport Recife':           '/escudos/sport-recife.png',
  'Sport Club do Recife':   '/escudos/sport-recife.png',
  'Ceará':                  '/escudos/ceara.png',
  'Ceara':                  '/escudos/ceara.png',
  'Ceará SC':               '/escudos/ceara.png',
  'Goiás':                  '/escudos/goias.png',
  'Goias':                  '/escudos/goias.png',
  'Goiás EC':               '/escudos/goias.png',
  'Vitória':                '/escudos/vitoria.png',
  'Vitoria':                '/escudos/vitoria.png',
  'EC Vitória':             '/escudos/vitoria.png',
  'Cuiabá':                 '/escudos/cuiaba.png',
  'Cuiaba':                 '/escudos/cuiaba.png',
  'Cuiabá EC':              '/escudos/cuiaba.png',
  'América Mineiro':        '/escudos/america-mineiro.png',
  'America Mineiro':        '/escudos/america-mineiro.png',
  'América-MG':             '/escudos/america-mineiro.png',
  'Juventude':              '/escudos/juventude.png',
  'Coritiba':               '/escudos/coritiba.png?v=2',
  'Coritiba FC':            '/escudos/coritiba.png?v=2',
  'Coritiba FBC':           '/escudos/coritiba.png?v=2',
  'Mirassol':               '/escudos/mirassol.png',
  'Mirassol FC':            '/escudos/mirassol.png',
  'Sport Club Corinthians Paulista': '/escudos/corinthians-sp.png',
  'Athletico-PR':           '/escudos/atletico-paranaense.png',
  'CAP':                    '/escudos/atletico-paranaense.png',
  'Operário':               '/escudos/operario.png',
  'Operario':               '/escudos/operario.png',
  'Novorizontino':          '/escudos/novorizontino.png',
  'Grêmio Novorizontino':   '/escudos/novorizontino.png',
  'Avaí':                   '/escudos/avai.png',
  'Avai':                   '/escudos/avai.png',
  'Avaí FC':                '/escudos/avai.png',
  'Chapecoense':            '/escudos/chapecoense.png',
  'Chapecoense-SC':         '/escudos/chapecoense.png',
  'Club do Remo':           '/escudos/club-do-remo-v2.png',
  'Clube do Remo':          '/escudos/club-do-remo-v2.png',
  'Remo':                   '/escudos/club-do-remo-v2.png',
  'Ponte Preta':            '/escudos/ponte-preta.png',
  'AA Ponte Preta':         '/escudos/ponte-preta.png',
  // ── 🏉 RUGBY UNION – Super Rugby / Champions Cup / Premiership ──
  'Crusaders':              '/escudos/crusaders.png',
  'Blues':                  '/escudos/blues.png',
  'Chiefs':                 '/escudos/chiefs.png',
  'Highlanders':            '/escudos/highlanders.png',
  'Hurricanes':             '/escudos/hurricanes.png',
  'Brumbies':               '/escudos/brumbies.png',
  'Waratahs':               '/escudos/waratahs.png',
  'NSW Waratahs':           '/escudos/waratahs.png',
  'Reds':                   '/escudos/reds.png',
  'Queensland Reds':        '/escudos/reds.png',
  'Force':                  '/escudos/force.png',
  'Western Force':          '/escudos/force.png',
  'Sharks':                 '/escudos/sharks.png',
  'Lions':                  '/escudos/lions.png',
  'Stormers':               '/escudos/stormers.png',
  'Vodacom Bulls':          '/escudos/vodacom-bulls.png',
  'Leinster':               '/escudos/leinster.png',
  'Leinster Rugby':         '/escudos/leinster.png',
  'Munster Rugby':          '/escudos/munster-rugby.png',
  'Ulster':                 '/escudos/ulster.png',
  'Ulster Rugby':           '/escudos/ulster.png',
  'Connacht':               '/escudos/connacht.png',
  'Stade Toulousain':       '/escudos/stade-toulousain.png',
  'La Rochelle':            '/escudos/la-rochelle.png',
  'Stade Rochelais':        '/escudos/la-rochelle.png',
  'Saracens':               '/escudos/saracens.png',
  'Bath':                   '/escudos/bath.png',
  'Bath Rugby':             '/escudos/bath.png',
  'Harlequins':             '/escudos/harlequins.png',
  'Northampton Saints':     '/escudos/northampton-saints.png',
  'Sale Sharks':            '/escudos/sale-sharks.png',
  // ── 🏉 RUGBY LEAGUE – NRL / Super League ──
  'South Sydney Rabbitohs': '/escudos/south-sydney-rabbitohs.png',
  'Melbourne Storm':        '/escudos/melbourne-storm.png',
  'Penrith Panthers':       '/escudos/penrith-panthers.png',
  'Sydney Roosters':        '/escudos/sydney-roosters.png',
  'Brisbane Broncos':       '/escudos/brisbane-broncos.png',
  'Parramatta Eels':        '/escudos/parramatta-eels.png',
  'Canterbury Bulldogs':    '/escudos/canterbury-bulldogs.png',
  'North Queensland Cowboys':'/escudos/north-queensland-cowboys.png',
  'Gold Coast Titans':      '/escudos/gold-coast-titans.png',
  'Cronulla Sharks':        '/escudos/cronulla-sharks.png',
  'Wigan Warriors':         '/escudos/wigan-warriors.png',
  'St Helens':              '/escudos/st-helens.png',
  'Leeds Rhinos':           '/escudos/leeds-rhinos.png',
  'Catalans Dragons':       '/escudos/catalans-dragons.png',
  // ── 🥊 MMA / UFC ──
  'Jon Jones':              '/escudos/jon-jones.png',
  'Alex Pereira':           '/escudos/alex-pereira.png',
  'Islam Makhachev':        '/escudos/islam-makhachev.png',
  'Ilia Topuria':           '/escudos/ilia-topuria.png',
  'Leon Edwards':           '/escudos/leon-edwards.png',
  'Dricus Du Plessis':      '/escudos/dricus-du-plessis.png',
  'Sean O\'Malley':         'https://a.espncdn.com/i/headshots/mma/players/full/4205093.png',
  'Valentina Shevchenko':   '/escudos/valentina-shevchenko.png',
  'Zhang Weili':            '/escudos/zhang-weili.png',
  // ── ⭐ CHAMPIONS / EUROPA / CONFERENCE LEAGUE ──
  'Ajax':                   '/escudos/ajax.png',
  'AFC Ajax':               '/escudos/afc-ajax.png',
  'PSV':                    '/escudos/psv.png',
  'PSV Eindhoven':          '/escudos/psv.png',
  'AZ':                     '/escudos/az.png',
  'Fenerbahce SK':          '/escudos/fenerbahce-sk.png',
  'Beşiktaş':               '/escudos/besiktas.png',
  'Besiktas':               '/escudos/besiktas.png',
  'Beşiktaş JK':            '/escudos/besiktas.png',
  'Besiktas JK':            '/escudos/besiktas.png',
  'Red Star Belgrade':      '/escudos/red-star-belgrade.png',
  'Crvena zvezda':          '/escudos/red-star-belgrade.png',
  'Ferencvaros':            '/escudos/ferencvaros.png',
  'Ferencváros':            '/escudos/ferencvaros.png',
  'Ferencváros TC':         '/escudos/ferencvaros.png',
  'Ferencvaros TC':         '/escudos/ferencvaros.png',
  'Dinamo Zagreb':          '/escudos/dinamo-zagreb.png',
  'GNK Dinamo Zagreb':      '/escudos/dinamo-zagreb.png',
  // ── 🇺🇸 MLS ──
  'Inter Miami':            '/escudos/inter-miami.png',
  'Inter Miami CF':         '/escudos/inter-miami.png',
  'LA Galaxy':              '/escudos/la-galaxy.png',
  'LAFC':                   '/escudos/lafc.png',
  'Los Angeles FC':         '/escudos/lafc.png',
  'Seattle Sounders':       '/escudos/seattle-sounders.png',
  'Seattle Sounders FC':    '/escudos/seattle-sounders.png',
  'Portland Timbers':       '/escudos/portland-timbers.png',
  'Atlanta United':         '/escudos/atlanta-united.png',
  'Atlanta United FC':      '/escudos/atlanta-united.png',
  'New York City FC':       '/escudos/new-york-city-fc.png',
  'NYCFC':                  '/escudos/new-york-city-fc.png',
  'New York Red Bulls':     '/escudos/new-york-red-bulls.png',
  'NY Red Bulls':           '/escudos/new-york-red-bulls.png',
  'Columbus Crew':          '/escudos/columbus-crew.png',
  'D.C. United':            '/escudos/d-c-united.png',
  'DC United':              '/escudos/d-c-united.png',
  'Chicago Fire':           '/escudos/chicago-fire.png',
  'Chicago Fire FC':        '/escudos/chicago-fire.png',
  'Toronto FC':             '/escudos/toronto-fc.png',
  'Toronto':               '/escudos/toronto-fc.png',
  'Philadelphia Union':     '/escudos/philadelphia-union.png',
  'Sporting Kansas City':   '/escudos/sporting-kansas-city.png',
  'Sporting Kansas \u2026': '/escudos/sporting-kansas-city.png',
  'Sporting KC':            '/escudos/sporting-kansas-city.png',
  'FC Dallas':              '/escudos/fc-dallas.png',
  'Houston Dynamo':         '/escudos/houston-dynamo.png',
  'Houston Dynamo FC':      '/escudos/houston-dynamo.png',
  'Colorado Rapids':        '/escudos/colorado-rapids.png',
  'Real Salt Lake':         '/escudos/real-salt-lake.png',
  'San Jose Earthquakes':   '/escudos/san-jose-earthquakes.png',
  'Vancouver Whitecaps':    '/escudos/vancouver-whitecaps.png',
  'Vancouver Whitecaps FC': '/escudos/vancouver-whitecaps.png',
  'CF Montréal':            '/escudos/cf-montreal.png',
  'CF Montreal':            '/escudos/cf-montreal.png',
  'Minnesota United':       '/escudos/minnesota-united.png',
  'Minnesota United FC':    '/escudos/minnesota-united.png',
  'Orlando City':           '/escudos/orlando-city.png',
  'Orlando City SC':        '/escudos/orlando-city.png',
  'Nashville SC':           '/escudos/nashville-sc.png',
  'Austin FC':              '/escudos/austin-fc.png',
  'St. Louis City SC':      '/escudos/st-louis-city-sc.png',
  'Charlotte FC':           '/escudos/charlotte-fc.png',
  'Charlotte':              '/escudos/charlotte-fc.png',
  'New England Revolution': '/escudos/new-england-revolution.png',
  'New England':            '/escudos/new-england-revolution.png',
  'New England Revo\u2026': '/escudos/new-england-revolution.png',
  'FC Cincinnati':          '/escudos/fc-cincinnati.png',
  'Cincinnati':             '/escudos/fc-cincinnati.png',
  'Nashville':              '/escudos/nashville-sc.png',
  'Austin':                 '/escudos/austin-fc.png',
  'San Jose':               '/escudos/san-jose-earthquakes.png',
  'San Jose Earthqu\u2026': '/escudos/san-jose-earthquakes.png',
  'Vancouver':              '/escudos/vancouver-whitecaps.png',
  'Vancouver Whitec\u2026': '/escudos/vancouver-whitecaps.png',
  'New York City':          '/escudos/new-york-city-fc.png',
  // ── 🇲🇽 LIGA MX ──
  'Club América':           '/escudos/club-america.png',
  'América':           '/escudos/club-america.png',
  'Guadalajara':           '/escudos/guadalajara.png',
  'Chivas':           '/escudos/chivas.png',
  'Chivas Guadalajara':           '/escudos/guadalajara.png',
  'CD Guadalajara':               '/escudos/guadalajara.png',
  'Cruz Azul':           '/escudos/cruz-azul.png',
  'Tigres UANL':           '/escudos/tigres-uanl.svg',
  'Tigres':           '/escudos/tigres-uanl.svg',
  'Monterrey':           '/escudos/monterrey.png',
  'Rayados':           '/escudos/monterrey.png',
  'CF Monterrey':           '/escudos/monterrey.png',
  'Pumas UNAM':           '/escudos/pumas-unam.png',
  'Pumas':                '/escudos/pumas-unam.png',
  'Club Universidad Nacional': '/escudos/pumas-unam.png',
  'Toluca':           '/escudos/toluca.png',
  'Toluca FC':           '/escudos/toluca.png',
  'Atlas':           '/escudos/atlas.png',
  'Atlas FC':           '/escudos/atlas.png',
  'Pachuca':           '/escudos/pachuca.png',
  'CF Pachuca':           '/escudos/pachuca.png',
  'Santos Laguna':           '/escudos/santos-laguna.png',
  'León':           '/escudos/leon.png',
  'Club León':           '/escudos/leon.png',
  'Necaxa':           '/escudos/necaxa.png',
  'Club Necaxa':           '/escudos/necaxa.png',
  'Tijuana':           '/escudos/tijuana.png',
  'Club Tijuana':           '/escudos/tijuana.png',
  'Xolos':           '/escudos/tijuana.png',
  'Querétaro':           '/escudos/queretaro.png',
  'Queretaro':           '/escudos/queretaro.png',
  'Queretaro FC':        '/escudos/queretaro.png',
  'Mazatlán FC':           '/escudos/mazatlan-fc.png',
  'Mazatlan FC':           '/escudos/mazatlan-fc.png',
  'Mazatlán':              '/escudos/mazatlan-fc.png',
  'Mazatlan':              '/escudos/mazatlan-fc.png',
  'Atlético de San Luis':  '/escudos/atletico-de-san-luis.png',
  'Atletico de San Luis':  '/escudos/atletico-de-san-luis.png',
  'Atlético San Luis':     '/escudos/atletico-de-san-luis.png',
  'Atletico San Luis':     '/escudos/atletico-de-san-luis.png',
  'Atl. San Luis':         '/escudos/atletico-de-san-luis.png',
  'Atl\u00e9tico de San \u2026': '/escudos/atletico-de-san-luis.png',
  'Atletico de San \u2026':      '/escudos/atletico-de-san-luis.png',
  'San Luis':              '/escudos/atletico-de-san-luis.png',
  'FC Juárez':           '/escudos/fc-juarez.png',
  'Juárez':           '/escudos/fc-juarez.png',
  // ── 🇧🇷 BRASILEIRÃO ──
  'Flamengo':           '/escudos/flamengo-rj.png',
  'CR Flamengo':           '/escudos/flamengo-rj.png',
  'Palmeiras':           '/escudos/palmeiras-sp.png',
  'SE Palmeiras':           '/escudos/palmeiras-sp.png',
  'Atletico Mineiro':           '/escudos/clube-atletico-mineiro.png',
  'Atlético Mineiro':           '/escudos/clube-atletico-mineiro.png',
  'São Paulo':           '/escudos/sao-paulo.png',
  'Sao Paulo':           '/escudos/sao-paulo.png',
  'São Paulo FC':           '/escudos/sao-paulo.png',
  'Fluminense':           '/escudos/fluminense-rj.png',
  'Fluminense FC':           '/escudos/fluminense-rj.png',
  'Corinthians':           '/escudos/corinthians-sp.png',
  'SC Corinthians':           '/escudos/corinthians-sp.png',
  'Santos':           '/escudos/santos.png',
  'Santos FC':           '/escudos/santos.png',
  'Grêmio':           '/escudos/gremio.png',
  'Gremio':           '/escudos/gremio.png',
  'Internacional':           '/escudos/internacional.png',
  'SC Internacional':           '/escudos/internacional.png',
  'Botafogo':           '/escudos/botafogo.png',
  'Botafogo FR':           '/escudos/botafogo.png',
  'Athletico Paranaense':           '/escudos/atletico-paranaense.png',
  'Atletico Paranaense':           '/escudos/atletico-paranaense.png',
  'EC Juventude':           '/escudos/ec-juventude.png',
  // ── ESPN AUTO-GENERATED (331 teams from 44 leagues) ──────────────────
  '2 de Mayo': '/escudos/2-de-mayo.png',
  'ABB': '/escudos/abb.png',
  'ADT': '/escudos/adt.png',
  'AGF': '/escudos/agf.png',
  'AIK': '/escudos/aik.png',
  'AVS':             '/escudos/avs.png',
  'AVS Futebol SAD': '/escudos/avs.png',
  'AVS Futebol':     '/escudos/avs.png',
  'Aves Futebol SAD':'/escudos/avs.png',
  'Aves':            '/escudos/avs.png',
  'Vila das Aves':   '/escudos/avs.png',
  'Aalesund': '/escudos/aalesund.png',
  'Aberdeen': '/escudos/aberdeen.png',
  'Academia Anzoátegui': '/escudos/academia-anzoategui.png',
  'Academia Puerto Cabello': '/escudos/academia-puerto-cabello.png',
  'Adelaide United': '/escudos/adelaide-united.png',
  'Ajax Amsterdam': '/escudos/ajax.png',
  'Akhmat Grozny': '/escudos/akhmat-grozny.png',
  'Akron Tolyatti': '/escudos/akron-tolyatti.png',
  'Alanyaspor': '/escudos/alanyaspor.png',
  'Albion FC': '/escudos/albion-fc.png',
  'Alianza Atlético': '/escudos/alianza-atletico.png',
  'Alianza FC': '/escudos/alianza-fc.png',
  'Alverca': '/escudos/alverca.png',
  'Always Ready': '/escudos/club-always-ready.png',
  'Antalyaspor': '/escudos/antalyaspor.png',
  'Antwerp': '/escudos/antwerp.png',
  'Aris': '/escudos/aris.svg',
  'Arouca': '/escudos/arouca.png',
  'Asteras Tripoli': '/escudos/asteras-tripoli.svg',
  'Atlético Grau': '/escudos/atletico-grau.png',
  'Atlético Junior': '/escudos/junior-de-barranquilla.png',
  'Atromitos': '/escudos/atromitos.png',
  'Auckland FC': '/escudos/auckland-fc.png',
  'Aurora': '/escudos/aurora.png',
  'Austria Vienna': '/escudos/austria-vienna.png',
  'Avispa Fukuoka': '/escudos/avispa-fukuoka.png',
  'BK Häcken': '/escudos/bk-hacken.png',
  'Beijing Guoan': '/escudos/beijing-guoan.png',
  'Belgrano (Córdoba)': '/escudos/belgrano.png',
  'Boston River': '/escudos/ca-boston-river.png',
  'Boyacá Chicó': '/escudos/boyaca-chico.png',
  'Brisbane Roar': '/escudos/brisbane-roar.png',
  'Brøndby IF': '/escudos/br-ndby-if.png',
  'Brondby IF': '/escudos/br-ndby-if.png',
  'Brondby': '/escudos/br-ndby-if.png',
  'Bucaramanga': '/escudos/bucaramanga.png',
  'C.D. Nacional': '/escudos/nacional-madeira.png',
  'CSKA Moscow': '/escudos/cska-moscow.png',
  'Carabobo': '/escudos/carabobo.png',
  'Casa Pia': '/escudos/casa-pia.png',
  'Caykur Rizespor': '/escudos/caykur-rizespor.png',
  'Central Coast Mariners': '/escudos/central-coast-mariners.png',
  'Central Córdoba (Santiago del Estero)': '/escudos/central-cordoba.png',
  'Central Español Fútbol Club': '/escudos/central-espanol-futbol-club.png',
  'Cercle Brugge KSV': '/escudos/cercle-brugge-ksv.png',
  'Cerezo Osaka': '/escudos/cerezo-osaka.png',
  'Cerro Largo': '/escudos/cerro-largo.png',
  'Chengdu Rongcheng': '/escudos/chengdu-rongcheng.png',
  'Chongqing Tonglianglong': '/escudos/chongqing-tonglianglong.png',
  'Cienciano del Cusco': '/escudos/cienciano.png',
  'Colo Colo': '/escudos/colo-colo.png',
  'Comerciantes Unidos': '/escudos/comerciantes-unidos.png',
  'Coquimbo Unido': '/escudos/coquimbo-unido.png',
  'Cusco FC':   '/escudos/cusco-fc.png',
  'Cusco':      '/escudos/cusco-fc.png',
  'Cúcuta Deportivo': '/escudos/cucuta-deportivo.png',
  'Dalian Yingbo': '/escudos/dalian-yingbo.png',
  'Danubio': '/escudos/danubio.png',
  'Degerfors IF': '/escudos/degerfors-if.png',
  'Delfín': '/escudos/delfin.png',
  'Dender': '/escudos/dender.png',
  'Deportes Concepcion': '/escudos/deportes-concepcion.png',
  'Deportes Limache': '/escudos/deportes-limache.png',
  'Dep. Tolima':     '/escudos/dep-tolima.png',
  'Deportivo Cali': '/escudos/deportivo-cali.png',
  'Deportivo Cuenca': '/escudos/c-d-cuenca.png',
  'Deportivo La Guaira': '/escudos/deportivo-la-guaira.png',
  'Dep. La Guaira':      '/escudos/deportivo-la-guaira.png',
  'Deportivo Maldonado': '/escudos/deportivo-maldonado.png',
  'Deportivo Moquegua': '/escudos/deportivo-moquegua.png',
  'Deportivo Pasto': '/escudos/deportivo-pasto.png',
  'Deportivo Pereira': '/escudos/deportivo-riestra.png', // API usa este nombre para Riestra (ARG)
  'CD Pereira':        '/escudos/cd-pereira.png', // Club real de Pereira, Colombia
  'Deportivo Rayo Zuliano': '/escudos/deportivo-rayo-zuliano.png',
  'Deportivo Recoleta': '/escudos/deportivo-recoleta.png',
  'Recoleta FC':        '/escudos/deportivo-recoleta.png',
  'Recoleta':           '/escudos/deportivo-recoleta.png',
  'Puerto Cabello':     '/escudos/academia-puerto-cabello.png',
  'Dinamo Moscow': '/escudos/dinamo-moscow.png',
  'Djurgården': '/escudos/djurgarden.png',
  'Djurgårdens IF': '/escudos/djurgarden.png',
  'Djurgårdens': '/escudos/djurgarden.png',
  'Djurgården IF': '/escudos/djurgarden.png',
  'Djurgardens IF': '/escudos/djurgarden.png',
  'Djurgardens': '/escudos/djurgarden.png',
  'Djurgarden': '/escudos/djurgarden.png',
  'Dundee': '/escudos/dundee.png',
  'Dundee United': '/escudos/dundee-united.png',
  'Dynamo Makhachkala': '/escudos/dynamo-makhachkala.png',
  'Estoril': '/escudos/estoril.png',
  'Estrela': '/escudos/estrela.png',
  'Estudiantes de Mérida': '/escudos/estudiantes-de-merida.png',
  'Everton CD': '/escudos/everton-de-vina.png',
  'Excelsior': '/escudos/excelsior.png',
  'Eyupspor': '/escudos/eyupspor.png',
  'F.C. København': '/escudos/f-c-k-benhavn.png',
  'FC Baltika Kaliningrad': '/escudos/fc-baltika-kaliningrad.png',
  'FC Blau-Weiß Linz': '/escudos/fc-blau-wei-linz.png',
  'FC Cajamarca': '/escudos/fc-cajamarca.png',
  'FC Famalicao': '/escudos/fc-famalicao.png',
  'FC Fredericia': '/escudos/fc-fredericia.png',
  'FC Groningen': '/escudos/fc-groningen.png',
  'Groningen':    '/escudos/fc-groningen.png',
  'FC Juarez': '/escudos/juarez.png',
  'FC Lugano': '/escudos/fc-lugano.png',
  'FC Luzern': '/escudos/fc-luzern.png',
  'FC Nordsjælland': '/escudos/fc-nordsj-lland.png',
  'FC Sion': '/escudos/fc-sion.png',
  'FC Thun': '/escudos/fc-thun.png',
  'FC Tokyo': '/escudos/fc-tokyo.png',
  'FC Twente Enschede': '/escudos/fc-twente-enschede.png',
  'Twente Enschede': '/escudos/fc-twente-enschede.png',
  'F.C. Twente': '/escudos/fc-twente-enschede.png',
  'FC Volendam': '/escudos/fc-volendam.png',
  'Volendam':    '/escudos/fc-volendam.png',
  'FC Zürich': '/escudos/fc-zurich.png',
  'Fagiano Okayama': '/escudos/fagiano-okayama.png',
  'Falkirk': '/escudos/falkirk.png',
  'Fatih Karagümrük': '/escudos/fatih-karagumruk.png',
  'Feyenoord Rotterdam': '/escudos/feyenoord-rotterdam.png',
  'Fortaleza CEIF': '/escudos/fortaleza-ceif.png',
  'Fortuna Sittard': '/escudos/fortuna-sittard.png',
  'Fredrikstad': '/escudos/fredrikstad.png',
  'GAIS': '/escudos/gais.png',
  'GV San José': '/escudos/gv-san-jose.png',
  'Gamba Osaka': '/escudos/gamba-osaka.png',
  'Gaziantep FK': '/escudos/gaziantep-fk.png',
  'Gazovik Orenburg': '/escudos/gazovik-orenburg.png',
  'Genclerbirligi': '/escudos/genclerbirligi.png',
  'Gil Vicente': '/escudos/gil-vicente.png',
  'Go Ahead':        '/escudos/go-ahead.png',
  'Goztepe': '/escudos/goztepe.png',
  'Grasshoppers': '/escudos/grasshoppers.svg',
  'Grazer AK': '/escudos/grazer-ak.png',
  'Guabirá': '/escudos/guabira.png',
  'Guarani': '/escudos/guarani.png',
  'Guayaquil City FC': '/escudos/guayaquil-city-fc.png',
  'Halmstads BK': '/escudos/halmstads-bk.png',
  'Hamarkameratene':        '/escudos/hamarkameratene.svg',
  'HamKam':                 '/escudos/hamarkameratene.svg',
  'Hamburg SV': '/escudos/hsv.svg',
  'Hammarby IF': '/escudos/hammarby-if.png',
  'Heart of Midlothian': '/escudos/heart-of-midlothian.png',
  'Heerenveen':    '/escudos/heerenveen.png',
  'SC Heerenveen': '/escudos/heerenveen.png',
  'Henan Songshan Longmen': '/escudos/henan-songshan-longmen.png',
  'Heracles Almelo': '/escudos/heracles-almelo.png',
  'Heracles':        '/escudos/heracles-almelo.png',
  'Hibernian': '/escudos/hibernian.png',
  'IF Brommapojkarna': '/escudos/if-brommapojkarna.png',
  'IF Elfsborg': '/escudos/if-elfsborg.png',
  'IFK Göteborg': '/escudos/ifk-goteborg.png',
  'IK Sirius': '/escudos/ik-sirius.png',
  'IK Start': '/escudos/ik-start.png',
  'Independiente Petrolero': '/escudos/club-independiente-petrolero.png',
  'Independiente Santa Fe': '/escudos/independiente-santa-fe.png',
  'Independiente del Valle': '/escudos/independiente-del-valle.png',
  'Instituto (Córdoba)': '/escudos/instituto-cordoba.png',
  'Internacional de Bogotá': '/escudos/internacional-de-bogota.png',
  'Istanbul Basaksehir': '/escudos/istanbul-basaksehir.png',
  'Basaksehir':          '/escudos/istanbul-basaksehir.png',
  'Başakşehir':          '/escudos/istanbul-basaksehir.png',
  'Istanbul FK':         '/escudos/istanbul-basaksehir.png',
  'JEF United Ichihara-Chiba': '/escudos/jef-united-ichihara-chiba.png',
  'Jaguares de Córdoba': '/escudos/jaguares-de-cordoba.png',
  'Jorge Wilstermann': '/escudos/jorge-wilstermann.png',
  'Juan Pablo II': '/escudos/juan-pablo-ii.png',
  'Juventud': '/escudos/ca-juventud.png',
  'KAA Gent': '/escudos/kaa-gent.png',
  'KFUM Oslo': '/escudos/kfum-oslo.png',
  'KV Mechelen': '/escudos/kv-mechelen.png',
  'KVC Westerlo': '/escudos/kvc-westerlo.png',
  'Kalmar FF': '/escudos/kalmar-ff.png',
  'Kashima Antlers': '/escudos/kashima-antlers.png',
  'Kashiwa Reysol': '/escudos/kashiwa-reysol.png',
  'Kasimpasa': '/escudos/kasimpasa.png',
  'Kasımpaşa': '/escudos/kasimpasa.png',
  'Kasımpasa': '/escudos/kasimpasa.png',
  'Kasimpaşa': '/escudos/kasimpasa.png',
  'Kasımpaşa SK': '/escudos/kasimpasa.png',
  'Kawasaki Frontale': '/escudos/kawasaki-frontale.png',
  'Kayserispor': '/escudos/kayserispor.png',
  'Kifisia': '/escudos/kifisia.png',
  'Kilmarnock': '/escudos/kilmarnock.png',
  'Kocaelispor': '/escudos/kocaelispor.png',
  'Konyaspor':       '/escudos/konyaspor.png',
  'Torku Konyaspor': '/escudos/konyaspor.png',
  'Krasnodar': '/escudos/krasnodar.png',
  'Kristiansund BK': '/escudos/kristiansund-bk.png',
  'Krylia Sovetov': '/escudos/krylia-sovetov.png',
  'Kyoto Sanga': '/escudos/kyoto-sanga.png',
  'LASK Linz': '/escudos/lask-linz.png',
  'La Serena': '/escudos/la-serena.png',
  'Larissa FC': '/escudos/larissa-fc.svg',
  'Lausanne Sports': '/escudos/lausanne-sports.png',
  'Leones': '/escudos/leones.png',
  'Levadiakos': '/escudos/levadiakos.svg',
  'Avellino':                        '/escudos/avellino.svg',
  'US Avellino':                     '/escudos/avellino.svg',
  'US Avellino 1912':                '/escudos/avellino.svg',
  'Avellino 1912':                   '/escudos/avellino.svg',
  'Avellino Calcio':                 '/escudos/avellino.svg',
  'SonderjyskE':                     '/escudos/sonderjyske.svg',
  'Sonderjyske':                     '/escudos/sonderjyske.svg',
  'Sønderjyske':                     '/escudos/sonderjyske.svg',
  'Sonderjyske Fodbold':             '/escudos/sonderjyske.svg',
  'Carrarese':                       '/escudos/carrarese.svg',
  'Carrarese Calcio':                '/escudos/carrarese.svg',
  'Carrarese 1908':                  '/escudos/carrarese.svg',
  'Cesena FC':                       '/escudos/cesena-fc.svg',
  'AS Cittadella':                   '/escudos/as-cittadella.svg',
  'Cosenza Calcio':                  '/escudos/cosenza-calcio.svg',
  'Mantova':                         '/escudos/mantova.svg',
  'Mantova 1911':                    '/escudos/mantova.svg',
  'Palermo FC':                      '/escudos/palermo-fc.svg',
  'Südtirol':                        '/escudos/sudtirol.svg',
  'FC Südtirol':                     '/escudos/sudtirol.svg',
  'Catanzaro 1929':                  '/escudos/catanzaro-1929.svg',
  'AEK Athens FC':                   '/escudos/aek-athens-fc.svg',
  'AEL FC':                          '/escudos/larissa-fc.svg',
  'Larissa':                         '/escudos/larissa-fc.svg',
  'Aris FC':                         '/escudos/aris.svg',
  'Aris Thessaloniki':               '/escudos/aris.svg',
  'Asteras':                         '/escudos/asteras-tripoli.svg',
  'Atromitos FC':                    '/escudos/atromitos.png',
  'Olympiakos Piraeus':              '/escudos/olympiakos-piraeus.svg',
  'PAOK Thessaloniki':               '/escudos/paok-thessaloniki.png',
  'Panetolikos GFS':                 '/escudos/panetolikos-gfs.png',
  'Volos':                           '/escudos/volos.png',
  'Volos NPS':                       '/escudos/volos.png',
  'Stade Malherbe':                  '/escudos/stade-malherbe.svg',
  'Stade Malherbe Caen':             '/escudos/stade-malherbe.svg',
  'Grenoble Foot 38':                '/escudos/grenoble-foot-38.svg',
  'GF38':                            '/escudos/grenoble-foot-38.svg',
  'En Avant Guingamp':               '/escudos/en-avant-guingamp.svg',
  'Stade Lavallois MFC':             '/escudos/stade-lavallois-mfc.svg',
  'FC Martigues':                    '/escudos/fc-martigues.svg',
  'Red Star Paris':                  '/escudos/red-star-paris.svg',
  'Stade Reims':                     '/escudos/reims.svg',
  'RAF':                             '/escudos/raf.svg',
  'Saint Etienne':                   '/escudos/saint-etienne.svg',
  'ES Troyes':                       '/escudos/es-troyes.svg',
  'ESTAC':                           '/escudos/es-troyes.svg',
  'Lamia':                       '/escudos/lamia.png',
  'PAS Lamia':                   '/escudos/lamia.png',
  'Asteras Tripolis':            '/escudos/asteras-tripoli.svg',
  'Asteras Aktor':               '/escudos/asteras-tripoli.svg',
  'Annecy':                      '/escudos/annecy.svg',
  'FC Annecy':                   '/escudos/annecy.svg',
  'Panaitolikos':                '/escudos/panetolikos-gfs.png',
  'OFI':                         '/escudos/ofi.svg',
  'AEL':                         '/escudos/larissa-fc.svg',
  'AEL Larissa':                 '/escudos/larissa-fc.svg',
  'Athlitiki Enosi Larissas':    '/escudos/larissa-fc.svg',
  'Kallithea':                   '/escudos/kallithea.png',
  'Athens Kallithea':            '/escudos/kallithea.png',
  'Grasshopper Zurich':          '/escudos/grasshoppers.svg',
  'GC Zurich':                   '/escudos/grasshoppers.svg',
  'Le Mans':                     '/escudos/le-mans.svg',
  'Le Mans FC':                  '/escudos/le-mans.svg',
  'Liaoning Tieren': '/escudos/liaoning-tieren.png',
  'Libertad (Ecuador)': '/escudos/libertad-ecuador.png',
  'Lillestrom': '/escudos/lillestrom.png',
  'Livingston': '/escudos/livingston.png',
  'Llaneros': '/escudos/llaneros.png',
  'Lokomotiv Moscow': '/escudos/lokomotiv-moscow.png',
  'Los Chankas': '/escudos/los-chankas.png',
  'Macarthur FC': '/escudos/macarthur-fc.png',
  'Macará': '/escudos/macara.png',
  'Machida Zelvia': '/escudos/machida-zelvia.png',
  'Manta F.C.': '/escudos/manta-f-c.png',
  'Melbourne City FC': '/escudos/melbourne-city-fc.png',
  'Melbourne Victory': '/escudos/melbourne-victory.png',
  'Metropolitanos FC': '/escudos/metropolitanos-fc.png',
  'Mito Hollyhock': '/escudos/mito-hollyhock.png',
  'Mjällby AIF': '/escudos/mjallby-aif.png',
  'Molde': '/escudos/molde.png',
  'Montevideo City Torque': '/escudos/montevideo-city-torque.png',
  'Moreirense': '/escudos/moreirense.png',
  'Motherwell': '/escudos/motherwell.png',
  'Mushuc Runa': '/escudos/mushuc-runa.png',
  'NAC Breda': '/escudos/nac-breda.png',
  'NEC Nijmegen': '/escudos/nec-nijmegen.png',
  'NEC':          '/escudos/nec-nijmegen.png',
  'Nacional Potosí': '/escudos/nacional-potosi.png',
  'Nagoya Grampus': '/escudos/nagoya-grampus.png',
  'Newcastle Jets': '/escudos/newcastle-jets.png',
  'Newell\'s Old Boys': 'https://a.espncdn.com/i/teamlogos/soccer/500/14.png',
  'Nizhny Novgorod': '/escudos/nizhny-novgorod.png',
  'O\'Higgins': 'https://a.espncdn.com/i/teamlogos/soccer/500/6072.png',
  'OFI Crete': '/escudos/ofi.svg',
  'OH Leuven': '/escudos/oh-leuven.png',
  'Odense Boldklub': '/escudos/odense-boldklub.png',
  'Once Caldas': '/escudos/once-caldas.png',
  'Orense': '/escudos/orense.png',
  'PAOK Salonika': '/escudos/paok-thessaloniki.png',
  'PEC Zwolle': '/escudos/pec-zwolle.png',
  'Zwolle':     '/escudos/pec-zwolle.png',
  'Palestino': '/escudos/palestino.png',
  'Panathinaikos': '/escudos/panathinaikos.svg',
  'Panetolikos': '/escudos/panetolikos-gfs.png',
  'Panserraikos FC': '/escudos/panserraikos-fc.png',
  'Paris FC (Ligue 1)':    '/escudos/paris-fc-ligue-1.png',
  'Perth Glory': '/escudos/perth-glory.png',
  'Portuguesa': '/escudos/portuguesa.png',
  'Progreso': '/escudos/progreso.png',
  'Puebla': '/escudos/puebla.png',
  'Qingdao Hainiu': '/escudos/qingdao-hainiu.png',
  'Qingdao West Coast': '/escudos/qingdao-west-coast.png',
  'RAAL La Louvière': '/escudos/raal-la-louviere.png',
  'Racing (Montevideo)': '/escudos/racing-montevideo.png',
  'Racing Genk': '/escudos/racing-genk.png',
  'Randers FC': '/escudos/randers-fc.png',
  'Rapid Vienna': '/escudos/rapid-vienna.png',
  'Real Oruro': '/escudos/real-oruro.png',
  'Real Tomayapo': '/escudos/real-tomayapo.png',
  'Red Bull New York': '/escudos/red-bull-new-york.png',
  'Rio Ave': '/escudos/rio-ave.png',
  'Rosenborg': '/escudos/rosenborg.png',
  'Rostov': '/escudos/rostov.png',
  'Royal Charleroi SC': '/escudos/royal-charleroi-sc.png',
  'Rubin Kazan': '/escudos/rubin-kazan.png',
  'Rubio Ñú': '/escudos/rubio-nu.png',
  'SC Rheindorf Altach': '/escudos/sc-rheindorf-altach.png',
  'SK Brann': '/escudos/sk-brann.png',
  'SV Josko Ried': '/escudos/sv-josko-ried.png',
  'Samsunspor': '/escudos/samsunspor.png',
  'San Antonio Bulo Bulo': '/escudos/san-antonio-bulo-bulo.png',
  'San Diego FC': '/escudos/san-diego-fc.png',
  'Sandefjord': '/escudos/sandefjord.png',
  'Sanfrecce Hiroshima': '/escudos/sanfrecce-hiroshima.png',
  'Santa Clara': '/escudos/santa-clara.png',
  'Sarmiento (Junín)': '/escudos/sarmiento-junin.png',
  'Sarpsborg FK': '/escudos/sarpsborg-fk.png',
  'Servette': '/escudos/servette.png',
  'Shandong Taishan': '/escudos/shandong-taishan.png',
  'Shanghai Port': '/escudos/shanghai-port.png',
  'Shanghai Shenhua': '/escudos/shanghai-shenhua.png',
  'Shenzhen Xinpengcheng': '/escudos/shenzhen-xinpengcheng.png',
  'Shimizu S-Pulse': '/escudos/shimizu-s-pulse.png',
  'Silkeborg IF': '/escudos/silkeborg-if.png',
  'Sint-Truidense': '/escudos/sint-truidense.png',
  'Sochi': '/escudos/sochi.png',
  'Sparta Rotterdam': '/escudos/sparta-rotterdam.png',
  'Spartak Moscow': '/escudos/spartak-moscow.png',
  'Sport Boys': '/escudos/sport-boys.png',
  'Sport Huancayo': '/escudos/sport-huancayo.png',
  'Sportivo Ameliano': '/escudos/sportivo-ameliano.png',
  'Sportivo Luqueño': '/escudos/sportivo-luqueno.png',
  'Sportivo San Lorenzo': '/escudos/sportivo-san-lorenzo.png',
  'St Mirren': '/escudos/st-mirren.png',
  'St. Gallen':       '/escudos/st-gallen.png',
  'FC St. Gallen':   '/escudos/st-gallen.png',
  'FC St.Gallen':    '/escudos/st-gallen.png',
  'FC St Gallen':    '/escudos/st-gallen.png',
  'St. Louis CITY SC': '/escudos/st-louis-city-sc.png',
  'Standard Liege': '/escudos/standard-liege.png',
  'Sydney FC': '/escudos/sydney-fc.png',
  'Sønderjyske Fodbold': '/escudos/sonderjyske.svg',
  'TSV Hartberg': '/escudos/tsv-hartberg.png',
  'Talleres (Córdoba)': '/escudos/talleres.png',
  'Telstar': '/escudos/telstar.png',
  'Tianjin Jinmen Tiger': '/escudos/tianjin-jinmen-tiger.png',
  'Tokyo Verdy 1969': '/escudos/tokyo-verdy-1969.png',
  'Tondela': '/escudos/tondela.png',
  'Trabzonspor': '/escudos/trabzonspor.png',
  'Trinidense': '/escudos/trinidense.png',
  'Tromso': '/escudos/tromso.png',
  'Trujillanos': '/escudos/trujillanos.png',
  'Técnico Universitario': '/escudos/tecnico-universitario.png',
  'UTC': '/escudos/utc.png',
  'Union St.-Gilloise': '/escudos/union-st-gilloise.png',
  'Universidad Católica (Quito)': '/escudos/universidad-catolica-quito.png',
  'Universidad Central': '/escudos/ucv-fc.png',
  'Universidad Central de Venezuela': '/escudos/ucv-fc.png',
  'Universidad Central de Venezuela FC': '/escudos/ucv-fc.png',
  'UCV Caracas': '/escudos/ucv-fc.png',
  'U. Central de Venezuela': '/escudos/ucv-fc.png',
  'U. Central':              '/escudos/ucv-fc.png',
  'U Central de Venezuela':  '/escudos/ucv-fc.png',
  'UCV':                     '/escudos/ucv-fc.png', // UCV en Libertadores = Universidad Central de Venezuela (ESPN 10094 servía mal el escudo de Vallejo Perú)
  'Universidad de Concepción':  '/escudos/universidad-de-concepcion.png',
  'Universidad de Concepcion': '/escudos/universidad-de-concepcion.png',
  'Universidad de C\u2026':    '/escudos/universidad-de-concepcion.png',
  'U. de Concepción':          '/escudos/universidad-de-concepcion.png',
  'U. Concepción':             '/escudos/universidad-de-concepcion.png',
  'Universitario de Vinto': '/escudos/universitario-de-vinto.png',
  'Unión (Santa Fe)': '/escudos/union-santa-fe.png',
  'Unión La Calera': '/escudos/union-la-calera.png',
  'Urawa Red Diamonds': '/escudos/urawa-red-diamonds.png',
  'V-Varen Nagasaki': '/escudos/v-varen-nagasaki.png',
  'Vejle Boldklub': '/escudos/vejle-boldklub.png',
  'Viborg FF': '/escudos/viborg-ff.png',
  'Viking FK': '/escudos/viking-fk.png',
  'Vissel Kobe': '/escudos/vissel-kobe.png',
  'Vitória de Guimaraes': '/escudos/vitoria-de-guimaraes.png',
  'Volos NFC': '/escudos/volos.png',
  'Västerås SK': '/escudos/vasteras-sk.png',
  'Vålerenga': '/escudos/valerenga.png',
  'Vélez Sarsfield': '/escudos/velez-sarsfield.png',
  'WSG Swarovski Tirol': '/escudos/wsg-swarovski-tirol.png',
  'Wanderers': '/escudos/wanderers.png',
  'Wellington Phoenix FC': '/escudos/wellington-phoenix-fc.png',
  'Western Sydney Wanderers': '/escudos/western-sydney-wanderers.png',
  'Winterthur': '/escudos/winterthur.png',
  'Wolfsberger': '/escudos/wolfsberger.png',
  'Wolverhampton Wanderers': '/escudos/wolverhampton-wanderers.png',
  'Wuhan Three Towns': '/escudos/wuhan-three-towns.png',
  'Yokohama F. Marinos': '/escudos/yokohama-f-marinos.png',
  'Yunnan Yukun': '/escudos/yunnan-yukun.png',
  'Zamora': '/escudos/zamora.png',
  'Zenit St Petersburg': '/escudos/zenit-st-petersburg.png',
  'Zhejiang Professional FC': '/escudos/zhejiang-professional-fc.png',
  'Zulte-Waregem': '/escudos/zulte-waregem.png',
  'Águilas Doradas': '/escudos/aguilas-doradas.png',
  'Örgryte IS': '/escudos/orgryte-is.png',
  // ── EQUIPOS UEFA ADICIONALES (URLs verificadas vía thesportsdb) ──
  'AEK Larnaca':            '/escudos/aek-larnaca.png',
  'AEK Larnaca FC':         '/escudos/aek-larnaca.png',
  'NK Celje':               '/escudos/nk-celje.png',
  'FC Celje':               '/escudos/nk-celje.png',
  'Celje':                  '/escudos/nk-celje.png',
  'Sigma Olomouc':          '/escudos/sigma-olomouc.png',
  'SK Sigma Olomouc':       '/escudos/sigma-olomouc.png',
  'FC Sigma Olomouc':       '/escudos/sigma-olomouc.png',
  'KRC Genk':               '/escudos/racing-genk.png',
  'Genk':                   '/escudos/racing-genk.png',
  'Rakow':                  '/escudos/rakow-03f73d.png',
  'Panathinaikos FC':       '/escudos/panathinaikos.svg',
  'Panathinaikos PAO':      '/escudos/panathinaikos.svg',
  // ── ALIAS NOMBRES CORTOS (para que logoHtml() funcione con shortName()) ──
  'Hamburger':              '/escudos/kilmarnock.png',
  'Koln':                   '/escudos/koln.png',
  'Borussia Mon.':          '/escudos/borussia-monchengladbach.png',
  'Estudiantes LP':         '/escudos/estudiantes.png',
  'Estudiantes RC':         '/escudos/estudiantes-de-rio-cuarto.png',
  'Gimnasia M':             '/escudos/gimnasia-mendoza.png',
  'At. Paranaense':         '/escudos/atletico-paranaense.png',
  'Independiente R':        '/escudos/independiente-rivadavia.png',
  'Argentinos Jrs':         '/escudos/argentinos-juniors.png',

  // ── LIGUE 1 2025-26 (equipos faltantes) ──────────────────────────────────
  'Paris FC':               '/escudos/paris-fc-ligue-1.png',
  'Paris':                  '/escudos/paris-fc-ligue-1.png',
  'Angers SCO':             '/escudos/angers.png',
  'Saint-Etienne':          '/escudos/as-saint-etienne.png',
  'ASSE':                   '/escudos/saint-etienne.svg',
  'Caen':                   '/escudos/stade-malherbe.svg',
  'SM Caen':                '/escudos/stade-malherbe.svg',
  'Laval':                  '/escudos/stade-lavallois-mfc.svg',
  'Stade Lavallois':        '/escudos/stade-lavallois-mfc.svg',
  'Grenoble':               '/escudos/grenoble-foot-38.svg',
  'Grenoble Foot':          '/escudos/grenoble-foot.png',
  'Dunkerque':              '/escudos/dunkerque.svg',
  'USL Dunkerque':          '/escudos/dunkerque.svg',
  'Rodez':                  '/escudos/raf.svg',
  'Rodez AF':               '/escudos/raf.svg',
  'Pau FC':                 '/escudos/pau-fc.svg',
  'Pau':                    '/escudos/pau-fc.svg',
  'Quevilly Rouen':         '/escudos/quevilly-rouen.png',
  'QRM':                    '/escudos/quevilly-rouen.png',
  'Red Star':               '/escudos/red-star-paris.svg',
  'Red Star FC':            '/escudos/red-star-paris.svg',
  'Troyes':                 '/escudos/es-troyes.svg',
  'ESTAC Troyes':           '/escudos/es-troyes.svg',
  'Guingamp':               '/escudos/en-avant-guingamp.svg',
  'EA Guingamp':            '/escudos/en-avant-guingamp.svg',
  'Niort':                  '/escudos/niort.png',
  'Chamois Niort':          '/escudos/niort.png',
  'Bastia':                 '/escudos/bastia.svg',
  'SC Bastia':              '/escudos/bastia.svg',
  'Ajaccio':                '/escudos/ajaccio.png',
  'AC Ajaccio':             '/escudos/ajaccio.png',
  'Martigues':              '/escudos/fc-martigues.svg',
  'Concarneau':             '/escudos/concarneau.png',
  'Valenciennes':           '/escudos/valenciennes.png',
  'Valenciennes FC':        '/escudos/valenciennes.png',
  'Amiens':                 '/escudos/amiens.svg',
  'Amiens SC':              '/escudos/amiens.svg',
  'Paris Saint-Germain':    '/escudos/paris-saint-germain-27794b.png',

  // ── BUNDESLIGA 2025-26 (equipos faltantes / recién ascendidos) ───────────
  'Holstein Kiel':          '/escudos/holstein-kiel.png',
  'Kiel':                   '/escudos/holstein-kiel.png',
  'FC Heidenheim':          '/escudos/1-fc-heidenheim-1846.png',
  'Heidenheim':             '/escudos/1-fc-heidenheim-1846.png',
  '1. FC Heidenheim':       '/escudos/1-fc-heidenheim-1846.png',
  'Hamburger SV':           '/escudos/hsv.svg',
  'Hamburg':                '/escudos/hsv.svg',
  'Fortuna Düsseldorf':     '/escudos/hoffenheim.png',
  'Dusseldorf':             '/escudos/hoffenheim.png',
  'Fortuna Dusseldorf':     '/escudos/hoffenheim.png',
  'SpVgg Greuther Fürth':   '/escudos/spvgg-greuther-furth.png',
  'Greuther Furth':         '/escudos/spvgg-greuther-furth.png',
  'Greuther Fürth':         '/escudos/spvgg-greuther-furth.png',
  'Karlsruher SC':          '/escudos/karlsruher-sc.png',
  'Karlsruhe':              '/escudos/karlsruher-sc.png',
  'Hannover 96':            '/escudos/hannover-96.png',
  'Hannover':               '/escudos/hannover-96.png',
  'Schalke 04':             '/escudos/werder-bremen.png',
  'Schalke':                '/escudos/werder-bremen.png',
  'FC Schalke 04':          '/escudos/werder-bremen.png',
  'SV Darmstadt 98':        '/escudos/eintracht-frankfurt.png',
  'Darmstadt':              '/escudos/eintracht-frankfurt.png',
  'Kaiserslautern':         '/escudos/kaiserslautern.svg',
  '1. FC Kaiserslautern':   '/escudos/kaiserslautern.svg',
  'FC Kaiserslautern':      '/escudos/kaiserslautern.svg',
  'Arminia':                '/escudos/arminia.svg',
  'Arminia Bielefeld':      '/escudos/arminia.svg',
  'DSC Arminia Bielefeld':  '/escudos/arminia.svg',
  'Arka Gdynia':            '/escudos/arka-gdynia.svg',
  'Arka':                   '/escudos/arka-gdynia.svg',
  'Paderborn':              '/escudos/paderborn.png',
  'SC Paderborn':           '/escudos/paderborn.png',
  'Preußen Münster':        '/escudos/preu-en-munster.png',
  'Munster':                '/escudos/preu-en-munster.png',
  'Elversberg':             '/escudos/elversberg.png',
  'SV Elversberg':          '/escudos/elversberg.png',
  'Jahn Regensburg':        '/escudos/jahn-regensburg.png',
  'Regensburg':             '/escudos/jahn-regensburg.png',
  'SSV Ulm':                '/escudos/ssv-ulm.png',
  'Ulm':                    '/escudos/ssv-ulm.png',

  // ── SERIE A 2025-26 (equipos faltantes) ──────────────────────────────────
  'Venezia':                '/escudos/fc-venezia.png',
  'Venezia FC':             '/escudos/fc-venezia.png',
  'Parma':                  '/escudos/parma.png',
  'Parma Calcio':           '/escudos/parma.png',
  'Parma Calcio 1913':      '/escudos/parma.png',
  'Cagliari':               '/escudos/cagliari.png',
  'Cagliari Calcio':        '/escudos/cagliari.png',
  'Como':                   '/escudos/como.png',
  'Como 1907':              '/escudos/como.png',
  'Pisa':                   '/escudos/pisa-sc.svg',
  'AC Pisa':                '/escudos/pisa-sc.svg',
  'Cesena':                 '/escudos/cesena-fc.svg',
  'Modena':                 '/escudos/modena.svg',
  'Modena FC':              '/escudos/modena.svg',
  'Cremonese':              '/escudos/cremonese.svg',
  'US Cremonese':           '/escudos/cremonese.svg',
  'Frosinone':              '/escudos/frosinone.svg',
  'Frosinone Calcio':       '/escudos/frosinone.svg',
  'Bari':                   '/escudos/bari.svg',
  'SSC Bari':               '/escudos/bari.svg',
  'Brescia':                '/escudos/brescia.svg',
  'Brescia Calcio':         '/escudos/brescia.svg',
  'Palermo':                '/escudos/palermo-fc.svg',
  'US Palermo':             '/escudos/palermo-fc.svg',
  'Cosenza':                '/escudos/cosenza-calcio.svg',
  'Juve Stabia':            '/escudos/juve-stabia.svg',
  'SS Juve Stabia':         '/escudos/juve-stabia.svg',
  'Catanzaro':              '/escudos/catanzaro-1929.svg',
  'US Catanzaro':           '/escudos/catanzaro-1929.svg',
  'US Catanzaro 1929':      '/escudos/catanzaro-1929.svg',
  'Salernitana':            '/escudos/salernitana.svg',
  'US Salernitana':         '/escudos/salernitana.svg',
  'Lecce':                  '/escudos/lecce.png',
  'US Lecce':               '/escudos/lecce.png',
  'Udinese':                '/escudos/udinese.png',
  'Udinese Calcio':         '/escudos/udinese.png',
  'Empoli':                 '/escudos/empoli.png',
  'Empoli FC':              '/escudos/empoli.png',
  'Spezia':                 '/escudos/spezia.svg',
  'Spezia Calcio':          '/escudos/spezia.svg',
  'Reggiana':               '/escudos/reggiana.svg',
  'AC Reggiana':            '/escudos/reggiana.svg',
  'Sudtirol':               '/escudos/sudtirol.svg',
  'FC Sudtirol':            '/escudos/sudtirol.svg',
  'Cittadella':             '/escudos/as-cittadella.svg',

  // ── PREMIER LEAGUE 2025-26 (recién ascendidos) ───────────────────────────
  'Sunderland':             '/escudos/sunderland.png',
  'Sunderland AFC':         '/escudos/sunderland.png',
  'Sheffield United':       '/escudos/sheffield-united.png',
  'Sheffield Utd':          '/escudos/sheffield-united.png',
  'Leeds United':           '/escudos/leeds-united.png',
  'Leeds':                  '/escudos/leeds-united.png',
  'Coventry City':          '/escudos/newcastle-united.png',
  'Coventry':               '/escudos/newcastle-united.png',
  'Hull City':              '/escudos/hull-city.png',
  'Hull':                   '/escudos/hull-city.png',
  'Middlesbrough':          '/escudos/middlesbrough.png',
  'Boro':                   '/escudos/middlesbrough.png',
  'Millwall':               '/escudos/millwall.png',
  'Norwich City':           '/escudos/norwich-city.png',
  'Norwich':                '/escudos/norwich-city.png',
  'Preston':                '/escudos/preston.png',
  'Preston North End':      '/escudos/preston.png',
  'Stoke City':             '/escudos/stoke-city.png',
  'Stoke':                  '/escudos/stoke-city.png',
  'Watford':                '/escudos/watford.png',
  'West Brom':              '/escudos/olympique-lyonnais.png',
  'West Bromwich Albion':   '/escudos/olympique-lyonnais.png',
  'Plymouth Argyle':        '/escudos/granada.png',
  'Plymouth':               '/escudos/granada.png',
  'Cardiff City':           '/escudos/manchester-united.png',
  'Cardiff':                '/escudos/manchester-united.png',
  'Blackburn Rovers':       '/escudos/blackburn-rovers.png',
  'Blackburn':              '/escudos/blackburn-rovers.png',
  'Derby County':           '/escudos/fulham.png',
  'Derby':                  '/escudos/fulham.png',
  'Oxford United':          '/escudos/oxford-united.png',
  'Oxford':                 '/escudos/oxford-united.png',
  'Portsmouth':             '/escudos/portsmouth.png',
  'Swansea City':           '/escudos/swansea-city.png',
  'Swansea':                '/escudos/swansea-city.png',
  'Luton Town':             '/escudos/luton-town.png',
  'Luton':                  '/escudos/luton-town.png',
  'QPR':                    '/escudos/qpr.png',
  'Queens Park Rangers':    '/escudos/qpr.png',
  'Bristol City':           '/escudos/bristol-city.png',
  'Bristol':                '/escudos/bristol-city.png',
  'Wigan Athletic':         '/escudos/nice.png',
  'Wigan':                  '/escudos/nice.png',
  'Burnley':                '/escudos/burnley.png',
  'Burnley FC':             '/escudos/burnley.png',
  'Ipswich Town':           '/escudos/ipswich-town.png',
  'Ipswich':                '/escudos/ipswich-town.png',
  'Leicester City':         '/escudos/leicester-city.png',
  'Leicester':              '/escudos/leicester-city.png',

  // ── LA LIGA 2025-26 (equipos faltantes) ──────────────────────────────────
  'Espanyol':               '/escudos/espanyol.png',
  'RCD Espanyol':           '/escudos/espanyol.png',
  'Valladolid':             '/escudos/real-valladolid-cf.png',
  'Real Valladolid':        '/escudos/real-valladolid-cf.png',
  'Leganés':                '/escudos/leganes.jpg',
  'CD Leganés':             '/escudos/leganes.jpg',
  'Almería':                '/escudos/almeria.png',
  'UD Almería':             '/escudos/almeria.png',
  'Almeria':                '/escudos/almeria.png',
  'Celta Vigo':             '/escudos/celta-vigo.png',
  'Celta de Vigo':          '/escudos/celta-vigo.png',
  'Celta':                  '/escudos/celta-vigo.png',
  'Alavés':                 '/escudos/alaves.png',
  'Alaves':                 '/escudos/alaves.png',
  'Deportivo Alavés':       '/escudos/alaves.png',
  'Girona':                 '/escudos/girona.png',
  'Girona FC':              '/escudos/girona.png',
  'Rayo Vallecano':         '/escudos/rayo-vallecano.png',
  'Rayo':                   '/escudos/rayo-vallecano.png',
  'Osasuna':                '/escudos/osasuna.png',
  'CA Osasuna':             '/escudos/osasuna.png',
  'Las Palmas':             '/escudos/las-palmas.png',
  'UD Las Palmas':          '/escudos/las-palmas.png',
  'Mallorca':               '/escudos/mallorca.png',
  'RCD Mallorca':           '/escudos/mallorca.png',

  // ── COPA LIBERTADORES 2026 (equipos sin logo) ─────────────────────────────
  'Cerro Porteño':          '/escudos/cerro-porteno.png',
  'Cerro':                  '/escudos/cerro-porteno.png',
  'Olimpia':                '/escudos/olimpia-asuncion.png',
  'Club Olimpia':           '/escudos/olimpia-asuncion.png',
  'Olimpia Asuncion':       '/escudos/olimpia-asuncion.png',
  'Nacional Asuncion':      '/escudos/nacional-asuncion.png',
  'Nacional (Paraguay)':    '/escudos/nacional-asuncion.png',
  'Libertad':               '/escudos/libertad-asuncion.png',
  'Club Libertad':          '/escudos/libertad-asuncion.png',
  'Guaraní':                '/escudos/guarani-asuncion.png',
  'Guaraní Asunción':       '/escudos/guarani-asuncion.png',
  'Sporting Cristal':       '/escudos/sporting-cristal.png',
  'Universitario':          '/escudos/club-universitario-de-deportes.png',
  'Universitario de Deportes':'/escudos/club-universitario-de-deportes.png',
  'Alianza Lima':           '/escudos/alianza-lima.png',
  'Melgar':                 '/escudos/melgar.png',
  'FBC Melgar':             '/escudos/melgar.png',
  'Deportivo Garcilaso':    '/escudos/deportivo-garcilaso.png',
  'Peñarol':                '/escudos/atletico-penarol.png',
  'Club Peñarol':           '/escudos/atletico-penarol.png',
  'Nacional Uruguay':       '/escudos/nacional.png',
  'Club Nacional':          '/escudos/nacional.png',
  'Liverpool FC Uruguay':   '/escudos/liverpool-fc-uruguay.png',
  'Defensor Sporting':      '/escudos/defensor-sporting.jpg',
  'The Strongest':          '/escudos/the-strongest.png',
  'Blooming':               '/escudos/blooming.png',
  'Oriente Petrolero':      '/escudos/oriente-petrolero.png',
  'Deportivo Táchira':      '/escudos/deportivo-tachira.png',
  'Caracas FC':             '/escudos/caracas-fc.png',
  'Caracas':                '/escudos/caracas-fc.png',
  'Monagas SC':             '/escudos/monagas-sc.jpg',
  'Monagas':                '/escudos/monagas-sc.jpg',
  'Deportivo Lara':         '/escudos/deportivo-lara.png',
  'Emelec':                 '/escudos/emelec.png',
  'Club Emelec':            '/escudos/emelec.png',
  'Liga de Quito':          '/escudos/liga-de-quito.png',
  'LDU Quito':              '/escudos/liga-de-quito.png',
  'LDU':                    '/escudos/liga-de-quito.png',
  'Aucas':                  '/escudos/aucas.png',
  'SD Aucas':               '/escudos/aucas.png',
  'El Nacional':            '/escudos/el-nacional.png',
  'Ñublense':               '/escudos/nublense.png',
  'Deportes Iquique':       '/escudos/deportes-iquique.png',
  'Iquique':                '/escudos/deportes-iquique.png',
  'Cobresal':               '/escudos/cobresal.png',
  'CD Cobresal':            '/escudos/cobresal.png',
  'Audax Italiano':         '/escudos/audax-italiano.png',
  'Audax':                  '/escudos/audax-italiano.png',
  'Huachipato':             '/escudos/huachipato-v2.jpg',
  'Deportes Copiapó':       '/escudos/deportes-copiapo.gif',
  'Copiapó':                '/escudos/deportes-copiapo.gif',
  'Santa Fe':               '/escudos/independiente-santa-fe.png',
  'Ind. Santa Fe':          '/escudos/independiente-santa-fe.png',
  'Indep. Santa Fe':        '/escudos/independiente-santa-fe.png',
  'I. Santa Fe':            '/escudos/independiente-santa-fe.png',
  'Santa Fe (Bogotá)':      '/escudos/independiente-santa-fe.png',
  'Santa Fe Bogotá':        '/escudos/independiente-santa-fe.png',
  'Deportes Tolima':        '/escudos/dep-tolima.png',
  'Tolima':                 '/escudos/dep-tolima.png',
  'Atl. Nacional':          '/escudos/atl-nacional.png',
  'Nacional Colombia':      '/escudos/atl-nacional.png',
  'Atlético Nacional Medellín': '/escudos/atl-nacional.png',
  'Millonarios':            '/escudos/millonarios.png',
  'Junior':                 '/escudos/junior-de-barranquilla.png',
  'Barranquilla':           '/escudos/junior-de-barranquilla.png',
  'Junior FC':              '/escudos/junior-de-barranquilla.png',
  'América de Cali':        '/escudos/america-de-cali.png',
  'América Cali':           '/escudos/america-de-cali.png',

  // ── CHAMPIONS LEAGUE 2025-26 (clubes adicionales) ─────────────────────────
  'Slavia Prague':          '/escudos/slavia-prague.png',
  'SK Slavia Prague':       '/escudos/slavia-prague.png',
  'Sparta Prague':          '/escudos/sparta-prague.png',
  'AC Sparta Prague':       '/escudos/sparta-prague.png',
  'Sturm Graz':             '/escudos/sturm-graz.png',
  'SK Sturm Graz':          '/escudos/sturm-graz.png',
  'RB Salzburg':            '/escudos/rb-salzburg.png',
  'Red Bull Salzburg':      '/escudos/rb-salzburg.png',
  'Salzburg':               '/escudos/rb-salzburg.png',
  'Shakhtar Donetsk':       '/escudos/shakhtar-donetsk.png',
  'Shakhtar':               '/escudos/shakhtar-donetsk.png',
  'Dynamo Kyiv':            '/escudos/dynamo-kyiv.png',
  'Dynamo Kiev':            '/escudos/dynamo-kyiv.png',
  'Fenerbahce':             '/escudos/fenerbahce-sk.png',
  'Fenerbahçe':             '/escudos/fenerbahce-sk.png',
  'Galatasaray':            '/escudos/galatasaray.png',
  'Club Brugge':            '/escudos/club-brugge.png',
  'Brugge':                 '/escudos/club-brugge.png',
  'Anderlecht':             '/escudos/anderlecht.png',
  'RSC Anderlecht':         '/escudos/anderlecht.png',
  'Young Boys':             '/escudos/young-boys.png',
  'BSC Young Boys':         '/escudos/young-boys.png',
  'Basel':                  '/escudos/basel.png',
  'FC Basel':               '/escudos/basel.png',
  'FC Basel 1893':          '/escudos/basel.png',
  'Basilea':                '/escudos/basel.png',
  'Malmö FF':               '/escudos/malmo-ff.png',
  'Malmo':                  '/escudos/malmo-ff.png',
  'Malmö':                  '/escudos/malmo-ff.png',
  'Midtjylland':            '/escudos/midtjylland.png',
  'FC Midtjylland':         '/escudos/midtjylland.png',
  'Copenhagen':             '/escudos/f-c-k-benhavn.png',
  'FC Copenhagen':          '/escudos/f-c-k-benhavn.png',
  'F.C. Copenhagen':        '/escudos/f-c-k-benhavn.png',
  'FCK':                    '/escudos/f-c-k-benhavn.png',
  'København':              '/escudos/f-c-k-benhavn.png',
  'Kobenhavn':              '/escudos/kobenhavn.png',
  'Celtic':                 '/escudos/celtic.png',
  'Celtic FC':              '/escudos/celtic.png',
  'Rangers':                '/escudos/rangers.png',
  'Rangers FC':             '/escudos/rangers.png',
  'Slovan Bratislava':      '/escudos/slovan-bratislava.png',
  'ŠK Slovan Bratislava':   '/escudos/slovan-bratislava.png',
  'Viktoria Plzen':         '/escudos/viktoria-plzen.png',
  'Viktoria Plzeň':         '/escudos/viktoria-plzen.png',
  'Feyenoord':              '/escudos/feyenoord-rotterdam.png',
  'AZ Alkmaar':             '/escudos/az-alkmaar.png',
  'Utrecht':                '/escudos/utrecht.png',
  'FC Utrecht':             '/escudos/utrecht.png',
  'Twente':                 '/escudos/fc-twente-enschede.png',
  'FC Twente':              '/escudos/fc-twente-enschede.png',
  'Go Ahead Eagles':        '/escudos/go-ahead-eagles.png',
  'Willem II':              '/escudos/willem-ii.png',
  'Willem II Tilburg':      '/escudos/willem-ii.png',
  'Willem':                 '/escudos/willem-ii.png',
  'Sporting CP':            '/escudos/sporting-cp.png',
  'Sporting':               '/escudos/sporting-lisbon.png',
  'Benfica':                '/escudos/benfica.png',
  'SL Benfica':             '/escudos/benfica.png',
  'Porto':                  '/escudos/porto.png',
  'FC Porto':               '/escudos/porto.png',
  'Braga':                  '/escudos/braga.png',
  'SC Braga':               '/escudos/braga.png',
  'Vitesse':                '/escudos/vitesse.png',
  'Olympiacos':             '/escudos/olympiakos-piraeus.svg',
  'Olympiakos':             '/escudos/olympiakos-piraeus.svg',
  'PAOK':                   '/escudos/paok-thessaloniki.png',
  'PAOK FC':                '/escudos/paok-thessaloniki.png',
  'AEK Athens':             '/escudos/aek-athens-fc.svg',
  'Maccabi Tel Aviv':       '/escudos/maccabi-tel-aviv.png',
  'Maccabi Tel-Aviv':       '/escudos/maccabi-tel-aviv.png',
  'Lazio':                  '/escudos/lazio.png',
  'SS Lazio':               '/escudos/lazio.png',
  'Napoli':                 '/escudos/napoli.png',
  'SSC Napoli':             '/escudos/napoli.png',
  'AC Milan':               '/escudos/ac-milan.png',
  'Milan':                  '/escudos/ac-milan.png',
  'Inter Milan':            '/escudos/inter-milan.png',
  'Internazionale':         '/escudos/inter-milan.png',
  'Inter':                  '/escudos/inter-milan.png',
  'Roma':                   '/escudos/roma.png',
  'AS Roma':                '/escudos/roma.png',
  'Juventus':               '/escudos/juventus.png',
  'Fiorentina':             '/escudos/fiorentina.png',
  'ACF Fiorentina':         '/escudos/fiorentina.png',
  'Atalanta':               '/escudos/atalanta.png',
  'Atalanta BC':            '/escudos/atalanta.png',
  'Bologna':                '/escudos/bologna.png',
  'Bologna FC':             '/escudos/bologna.png',
  'Torino':                 '/escudos/torino.png',
  'Torino FC':              '/escudos/torino.png',
  'Genoa':                  '/escudos/genoa.png',
  'Genoa CFC':              '/escudos/genoa.png',
  'Sampdoria':              '/escudos/sampdoria.svg',
  'UC Sampdoria':           '/escudos/sampdoria.svg',
  'Verona':                 '/escudos/verona.png',
  'Hellas Verona':          '/escudos/verona.png',
  'Monza':                  '/escudos/monza.png',
  'AC Monza':               '/escudos/monza.png',
  // ── Aliases auto-generados (14-may-2026): forms cortas + sin sufijo FC/CF/etc ──
  'AEK': '/escudos/aek-athens-fc.svg',
  'Albion': '/escudos/albion-fc.png',
  'Alianza': '/escudos/alianza-fc.png',
  'Alianza Atl.': '/escudos/alianza-atletico.png',
  'Athletic': '/escudos/athletic-club.png',
  'Atl. Mineiro': '/escudos/clube-atletico-mineiro.png',
  'Auckland': '/escudos/auckland-fc.png',
  'Baltika Kaliningrad': '/escudos/fc-baltika-kaliningrad.png',
  'Bayern München': '/escudos/bayern-munich.png',
  'Blau-Weiß Linz': '/escudos/fc-blau-wei-linz.png',
  'Brann': '/escudos/sk-brann.png',
  'Brøndby': '/escudos/br-ndby-if.png',
  'C. Córdoba': '/escudos/central-cordoba.png',
  'C. Leonesa': '/escudos/cultural-leonesa.png',
  'Cadiz': '/escudos/cadiz.png',
  'Cajamarca': '/escudos/fc-cajamarca.png',
  'City Torque': '/escudos/montevideo-city-torque.png',
  'Cologne': '/escudos/koln.png',
  'Colorado': '/escudos/colorado-rapids.png',
  'Columbus': '/escudos/columbus-crew.png',
  'Coquimbo': '/escudos/coquimbo-unido.png',
  'Cordoba': '/escudos/cordoba.png',
  'Cuenca': '/escudos/c-d-cuenca.png',
  'Dallas': '/escudos/fc-dallas.png',
  'Degerfors': '/escudos/degerfors-if.png',
  'Famalicao': '/escudos/fc-famalicao.png',
  'Fredericia': '/escudos/fc-fredericia.png',
  'Gaziantep': '/escudos/gaziantep-fk.png',
  'Guayaquil City': '/escudos/guayaquil-city-fc.png',
  'Halmstads': '/escudos/halmstads-bk.png',
  'Hamburgo': '/escudos/hsv.svg',
  'Hammarby': '/escudos/hammarby-if.png',
  'Houston': '/escudos/houston-dynamo.png',
  'Ind. del Valle': '/escudos/independiente-del-valle.png',
  'Istanbul': '/escudos/istanbul-basaksehir.png',
  'Jaguares': '/escudos/jaguares-de-cordoba.png',
  'Juarez': '/escudos/juarez.png',
  'Karlsruher': '/escudos/karlsruher-sc.png',
  'Kristiansund': '/escudos/kristiansund-bk.png',
  'Leipzig': '/escudos/rb-leipzig.png',
  'Liverpool UY': '/escudos/liverpool-fc-uruguay.png',
  'Los Angeles': '/escudos/lafc.png',
  'Lugano': '/escudos/fc-lugano.png',
  'Luzern': '/escudos/fc-luzern.png',
  'Macarthur': '/escudos/macarthur-fc.png',
  'Malaga': '/escudos/malaga.png',
  'Melbourne City': '/escudos/melbourne-city-fc.png',
  'Metropolitanos': '/escudos/metropolitanos-fc.png',
  'Minnesota': '/escudos/minnesota-united.png',
  'Montreal': '/escudos/cf-montreal.png',
  'Montréal': '/escudos/cf-montreal.png',
  'Nordsjælland': '/escudos/fc-nordsj-lland.png',
  'Nott\'m Forest': 'https://media.api-sports.io/football/teams/65.png',
  'Orlando': '/escudos/orlando-city.png',
  'Panserraikos': '/escudos/panserraikos-fc.png',
  'Pereira': '/escudos/cd-pereira.png',
  'Racing (S)': '/escudos/racing-santander.png',
  'Randers': '/escudos/randers-fc.png',
  'Rheindorf Altach': '/escudos/sc-rheindorf-altach.png',
  'Riestra': '/escudos/deportivo-riestra.png',
  'Royal Charleroi': '/escudos/royal-charleroi-sc.png',
  'San Diego': '/escudos/san-diego-fc.png',
  'Sarpsborg': '/escudos/sarpsborg-fk.png',
  'Seattle': '/escudos/seattle-sounders.png',
  'Silkeborg': '/escudos/silkeborg-if.png',
  'Sion': '/escudos/fc-sion.png',
  'Sporting G.': '/escudos/sporting-gijon.png',
  'Sporting Lisboa': '/escudos/sporting-cp.png',
  'St Gallen': '/escudos/st-gallen.png',
  'St. Louis CITY': '/escudos/st-louis-city-sc.png',
  'St. Louis City': '/escudos/st-louis-city-sc.png',
  'St.Gallen': '/escudos/st-gallen.png',
  'Strasbourg Alsace': '/escudos/strasbourg.png',
  'Sydney': '/escudos/sydney-fc.png',
  'Thun': '/escudos/fc-thun.png',
  'Tigre BA': '/escudos/tigre.png',
  'Tokyo': '/escudos/fc-tokyo.png',
  'Viking': '/escudos/viking-fk.png',
  'Västerås': '/escudos/vasteras-sk.png',
  'Wellington Phoenix': '/escudos/wellington-phoenix-fc.png',
  'Zhejiang Professional': '/escudos/zhejiang-professional-fc.png',
  'Zürich': '/escudos/fc-zurich.png',
  // ── ALIASES PARA PICKS PENDIENTES (chequeo-escudos-gambeta) ──
  'AE Kifisia':             '/escudos/kifisia.png',
  'KFUM':                   '/escudos/kfum-oslo.png',
  'Lausanne-Sport':         '/escudos/lausanne-sports.png',
  'Lausanne Sport':         '/escudos/lausanne-sports.png',
  '1. FC Magdeburg':        '/escudos/1-fc-magdeburg.png',
  'Magdeburg':              '/escudos/1-fc-magdeburg.png',
  '1. FC Nürnberg':         '/escudos/1-fc-nurnberg.png',
  '1. FC Nurnberg':         '/escudos/1-fc-nurnberg.png',
  'Nürnberg':               '/escudos/1-fc-nurnberg.png',
  'Nurnberg':               '/escudos/1-fc-nurnberg.png',
  '1. FC Kaiserslau…':   '/escudos/kaiserslautern.svg',
  'Grasshopper Zürich':     '/escudos/grasshoppers.svg',
  'OB Odense':              '/escudos/odense-boldklub.png',
  'Zurich':                 '/escudos/fc-zurich.png',
  "Nott'm Forest":          '/escudos/nottingham-forest.png',
  "O'Higgins":              '/escudos/o-higgins.png',
  "O'Higgins FC":           '/escudos/o-higgins.png',
};

// Mapa de artículos Wikipedia para tenistas
const tennisWikiMap = {
  'Alcaraz':        'Carlos_Alcaraz',
  'Djokovic':       'Novak_Djokovic',
  'Swiatek':        'Iga_Swiatek',
  'Sabalenka':      'Aryna_Sabalenka',
  'Carlos Alcaraz': 'Carlos_Alcaraz',
  'Novak Djokovic': 'Novak_Djokovic',
  'Iga Swiatek':    'Iga_Swiatek',
  'Aryna Sabalenka':'Aryna_Sabalenka',
  'Sinner':         'Jannik_Sinner',
  'Jannik Sinner':  'Jannik_Sinner',
  'Zverev':         'Alexander_Zverev',
  'Alexander Zverev':'Alexander_Zverev',
};
const playerPhotoCache = {};

// Genera HTML de logo: imagen oficial si existe, avatar foto para tenistas
// Fold de letras nórdicas/eslavas que NFD no descompone (ø æ å ł ß ð þ).
// Sin esto, "Brøndby" (API) y "Brondby" no matchean → el escudo no se ve.
function _foldSpecial(s) {
  return (s||'').replace(/ø/g,'o').replace(/æ/g,'ae').replace(/å/g,'a')
    .replace(/ł/g,'l').replace(/ß/g,'ss').replace(/ð/g,'d').replace(/þ/g,'th');
}
// Caché de lookup normalizado (sin acentos) para teamLogos — se construye una vez
let _normLogoCache = null;
function _getNormLogoCache() {
  if (_normLogoCache) return _normLogoCache;
  _normLogoCache = {};
  const _sfx = /\s+(FC|SC|TC|CF|AC|AS|CD|SD|RCD|FK|SK|BK|IF|IFK|RC|RFC|SFC|UD|CA|CE|SV|VfB|VfL|TSG|RB|BSC|GNK|NK|AFC|FBC|HFC|United|City|Town|Athletic|Rovers|Rangers|Wanderers|Albion)\s*$/i;
  const _pfx = /^(FC|SC|AC|AS|CD|SD|RCD|FK|SK|NK|GNK|RB|AFC|SFC)\s+/i;
  const _norm = s => _foldSpecial(s.toLowerCase()).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9 ]/g,' ').trim();
  Object.keys(teamLogos).forEach(k => {
    const n = _norm(k);
    if (!_normLogoCache[n]) _normLogoCache[n] = teamLogos[k];
    // Auto-alias: strip common suffix (e.g. "Paris FC" → "paris")
    const stripped = k.replace(_sfx, '').replace(_pfx, '').trim();
    if (stripped !== k) {
      const ns = _norm(stripped);
      if (!_normLogoCache[ns]) _normLogoCache[ns] = teamLogos[k];
    }
    // Agregar alias de nombre corto si existe en teamShortNames
    if (typeof teamShortNames !== 'undefined' && teamShortNames[k]) {
      const shortAlias = teamShortNames[k];
      if (!teamLogos[shortAlias]) teamLogos[shortAlias] = teamLogos[k];
      const normShort = _norm(shortAlias);
      if (!_normLogoCache[normShort]) _normLogoCache[normShort] = teamLogos[k];
    }
  });
  return _normLogoCache;
}

// Badge de iniciales con color determinístico para equipos sin logo
function teamInitialsBadge(name, size=48) {
  const words = (name||'?').replace(/[^\w\sáéíóúüñàèìòùâêîôûäëïöü]/gi,'').trim().split(/\s+/).filter(Boolean);
  let inits;
  if (!words.length) inits = '?';
  else if (words.length === 1) inits = words[0].slice(0,2).toUpperCase();
  else inits = (words[0][0] + words[words.length-1][0]).toUpperCase();
  const _pal = ['#1a6e30','#0a5ab5','#5e33a6','#b0332a','#007a8c','#c45200','#3a4f5c','#6a1050','#2a6e2a','#9c1248'];
  let h = 0; for (let i = 0; i < (name||'').length; i++) h = (h * 31 + (name||'').charCodeAt(i)) >>> 0;
  const bg = _pal[h % _pal.length];
  const fsz = Math.round(size * (inits.length > 2 ? 0.27 : 0.33));
  return `<span title="${(name||'').replace(/"/g,'&quot;')}" style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:${bg};color:#fff;font-size:${fsz}px;font-weight:800;letter-spacing:-.5px;line-height:1;flex-shrink:0;box-shadow:0 2px 6px rgba(0,0,0,0.5);font-family:inherit">${inits}</span>`;
}



// Jugadores estrella del Mundial 2026 — fotos verificadas (Wikimedia CC)
const WC2026_STARS = {
  'Kylian Mbappé':     { photo:'/blog/img/mbappe-francia.jpg',  iso:'fr', name:'Mbappé' },
  'Mbappé':            { photo:'/blog/img/mbappe-francia.jpg',  iso:'fr', name:'Mbappé' },
  'Lionel Messi':      { photo:'/blog/img/messi-argentina.jpg', iso:'ar', name:'Messi'  },
  'Messi':             { photo:'/blog/img/messi-argentina.jpg', iso:'ar', name:'Messi'  },
  'Cristiano Ronaldo': { photo:'/blog/img/cr7-portugal.jpg',    iso:'pt', name:'CR7'    },
  'CR7':               { photo:'/blog/img/cr7-portugal.jpg',    iso:'pt', name:'CR7'    },
};

// Badge para jugador estrella: foto del jugador en círculo + banderita de su selección abajo-derecha
function wcStarBadge(name, size=48) {
  const info = WC2026_STARS[name];
  if (!info) return null;
  const flagSize = Math.max(14, Math.round(size * 0.42));
  return `<span title="${info.name}" style="position:relative;display:inline-block;width:${size}px;height:${size}px;flex-shrink:0">`
       + `<img loading="lazy" decoding="async" src="${info.photo}" alt="${info.name}" width="${size}" height="${size}" style="width:${size}px;height:${size}px;object-fit:cover;object-position:center top;border-radius:50%;display:block;border:2px solid #FFD700;box-shadow:0 2px 8px rgba(255,215,0,0.4)" onerror="this.outerHTML=teamInitialsBadge('${info.name}',${size})">`
       + `<img loading="lazy" decoding="async" src="https://flagcdn.com/w40/${info.iso}.png" alt="${info.iso}" width="${flagSize}" height="${flagSize}" style="position:absolute;bottom:-2px;right:-2px;width:${flagSize}px;height:${flagSize}px;border-radius:50%;object-fit:cover;border:1.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.5)">`
       + `</span>`;
}

// ───────────── WC 2026 — Selecciones nacionales + eventos especiales ─────────────
// Para selecciones que no tienen escudo de club, mostramos:
//   • Escudo de la confederación (chico, esquina superior izq)
//   • Banderita del país (grande, ocupa el círculo)
const WC2026_NATIONS = {
  // CONMEBOL (Sudamérica)
  'Argentina':       { conf:'CONMEBOL', iso:'ar' },
  'Brasil':          { conf:'CONMEBOL', iso:'br' },
  'Uruguay':         { conf:'CONMEBOL', iso:'uy' },
  'Colombia':        { conf:'CONMEBOL', iso:'co' },
  'Paraguay':        { conf:'CONMEBOL', iso:'py' },
  'Ecuador':         { conf:'CONMEBOL', iso:'ec' },
  // UEFA
  'España':          { conf:'UEFA', iso:'es' },
  'Francia':         { conf:'UEFA', iso:'fr' },
  'Inglaterra':      { conf:'UEFA', iso:'gb-eng' },
  'Portugal':        { conf:'UEFA', iso:'pt' },
  'Italia':          { conf:'UEFA', iso:'it' },
  'Alemania':        { conf:'UEFA', iso:'de' },
  'Países Bajos':    { conf:'UEFA', iso:'nl' },
  'Holanda':         { conf:'UEFA', iso:'nl' },
  'Bélgica':         { conf:'UEFA', iso:'be' },
  'Croacia':         { conf:'UEFA', iso:'hr' },
  'Suiza':           { conf:'UEFA', iso:'ch' },
  'Austria':         { conf:'UEFA', iso:'at' },
  'Dinamarca':       { conf:'UEFA', iso:'dk' },
  'Noruega':         { conf:'UEFA', iso:'no' },
  'Polonia':         { conf:'UEFA', iso:'pl' },
  'Suecia':          { conf:'UEFA', iso:'se' },
  'Escocia':         { conf:'UEFA', iso:'gb-sct' },
  'Turquía':         { conf:'UEFA', iso:'tr' },
  'Ucrania':         { conf:'UEFA', iso:'ua' },
  'Serbia':          { conf:'UEFA', iso:'rs' },
  // CONCACAF (Norte/Centroamérica/Caribe)
  'México':          { conf:'CONCACAF', iso:'mx' },
  'Canadá':          { conf:'CONCACAF', iso:'ca' },
  'Estados Unidos':  { conf:'CONCACAF', iso:'us' },
  'USA':             { conf:'CONCACAF', iso:'us' },
  'Costa Rica':      { conf:'CONCACAF', iso:'cr' },
  'Panamá':          { conf:'CONCACAF', iso:'pa' },
  'Jamaica':         { conf:'CONCACAF', iso:'jm' },
  'Honduras':        { conf:'CONCACAF', iso:'hn' },
  // CAF (África)
  'Marruecos':       { conf:'CAF', iso:'ma' },
  'Senegal':         { conf:'CAF', iso:'sn' },
  'Argelia':         { conf:'CAF', iso:'dz' },
  'Egipto':          { conf:'CAF', iso:'eg' },
  'Nigeria':         { conf:'CAF', iso:'ng' },
  'Sudáfrica':       { conf:'CAF', iso:'za' },
  'Camerún':         { conf:'CAF', iso:'cm' },
  'Costa de Marfil': { conf:'CAF', iso:'ci' },
  'Ghana':           { conf:'CAF', iso:'gh' },
  'Túnez':           { conf:'CAF', iso:'tn' },
  'Cabo Verde':      { conf:'CAF', iso:'cv' },
  // ── 🌐 Resto de selecciones Mundial 2026 ──
  'Japón':           { conf:'AFC',      iso:'jp' },
  'Corea del Sur':   { conf:'AFC',      iso:'kr' },
  'Australia':       { conf:'AFC',      iso:'au' },
  'Nueva Zelanda':   { conf:'OFC',      iso:'nz' },
  'Irán':            { conf:'AFC',      iso:'ir' },
  'Arabia Saudí':    { conf:'AFC',      iso:'sa' },
  'Arabia Saudita':  { conf:'AFC',      iso:'sa' },
  'Catar':           { conf:'AFC',      iso:'qa' },
  'Qatar':           { conf:'AFC',      iso:'qa' },
  'Iraq':            { conf:'AFC',      iso:'iq' },
  'Irak':            { conf:'AFC',      iso:'iq' },
  'Jordania':        { conf:'AFC',      iso:'jo' },
  'Uzbekistán':      { conf:'AFC',      iso:'uz' },
  'Uzbekistan':      { conf:'AFC',      iso:'uz' },
  'República Checa': { conf:'UEFA',     iso:'cz' },
  'Chequia':         { conf:'UEFA',     iso:'cz' },
  'Curaçao':         { conf:'CONCACAF', iso:'cw' },
  'Curacao':         { conf:'CONCACAF', iso:'cw' },
  'RD Congo':        { conf:'CAF',      iso:'cd' },
  'R.D. Congo':      { conf:'CAF',      iso:'cd' },
  'DR Congo':        { conf:'CAF',      iso:'cd' },
  'Haití':           { conf:'CONCACAF', iso:'ht' },
  'Haiti':           { conf:'CONCACAF', iso:'ht' },
  'Bolivia':         { conf:'CONMEBOL', iso:'bo' },
  'Bosnia':          { conf:'UEFA',     iso:'ba' },
  'Bosnia y Herzegovina':{ conf:'UEFA', iso:'ba' },
  'Costa Marfil':    { conf:'CAF',      iso:'ci' },
  // ── ⚽ Resultados conocidos del Mundial 2026 (override client-side) ──
};

// Map de resultados WC2026 ya jugados (UTC ISO date YYYY-MM-DD + home + away → home/away score)
const WC2026_KNOWN_RESULTS = {
  // 11-jun
  'wc2026_2026-06-11_México_Sudáfrica': { homeScore: 2, awayScore: 0 },
  'wc2026_2026-06-11_Mexico_Sudáfrica': { homeScore: 2, awayScore: 0 },
  // 12-jun
  'wc2026_2026-06-12_Canadá_Bosnia': { homeScore: 1, awayScore: 1 },
  'wc2026_2026-06-12_Canadá_Bosnia y Herzegovina': { homeScore: 1, awayScore: 1 },
  'wc2026_2026-06-12_Estados Unidos_Paraguay': { homeScore: 4, awayScore: 1 },
  'wc2026_2026-06-12_USA_Paraguay': { homeScore: 4, awayScore: 1 },
  // 13-jun
  'wc2026_2026-06-13_Brasil_Marruecos': { homeScore: 1, awayScore: 1 },
  'wc2026_2026-06-13_Suiza_Catar': { homeScore: 1, awayScore: 1 },
  'wc2026_2026-06-13_Haití_Escocia': { homeScore: 0, awayScore: 1 },
  'wc2026_2026-06-13_Haiti_Escocia': { homeScore: 0, awayScore: 1 },
  // 14-jun
  'wc2026_2026-06-14_Alemania_Curaçao': { homeScore: 7, awayScore: 1 },
  'wc2026_2026-06-14_Alemania_Curazao': { homeScore: 7, awayScore: 1 },
  'wc2026_2026-06-14_Países Bajos_Japón': { homeScore: 2, awayScore: 2 },
  'wc2026_2026-06-14_Paises Bajos_Japon': { homeScore: 2, awayScore: 2 },
  // 15-jun
  'wc2026_2026-06-15_Bélgica_Egipto': { homeScore: 1, awayScore: 1 },
  'wc2026_2026-06-15_Belgica_Egipto': { homeScore: 1, awayScore: 1 },
  'wc2026_2026-06-15_España_Cabo Verde': { homeScore: 0, awayScore: 0 },
  'wc2026_2026-06-15_Espana_Cabo Verde': { homeScore: 0, awayScore: 0 },
  // 16-jun
  'wc2026_2026-06-16_Francia_Senegal': { homeScore: 3, awayScore: 1 },
  'wc2026_2026-06-16_Argentina_Argelia': { homeScore: 3, awayScore: 0 },
  // 17-jun
  'wc2026_2026-06-17_Portugal_RD Congo': { homeScore: 1, awayScore: 1 },
  'wc2026_2026-06-17_Inglaterra_Croacia': { homeScore: 4, awayScore: 2 },
};

// Helper: resolver pick WC contra resultados conocidos
// 🛡️ Fetch interceptor: aplicar resultados conocidos WC2026 a CUALQUIER respuesta del historial
(function(){
  if (window.__wcFetchPatched) return;
  window.__wcFetchPatched = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input?.url || '');
    const res = await origFetch(input, init);
    // Solo interceptar /api/sb?type=historial
    if (!url.includes('/api/sb') || !url.includes('historial')) return res;
    try {
      const cloned = res.clone();
      const data = await cloned.json();
      // Aplicar resolveWcLocal a los picks dentro del historial_full
      function patch(list) {
        if (!Array.isArray(list)) return list;
        return list.map(p => (typeof resolveWcLocal === 'function' ? resolveWcLocal(p) : p));
      }
      let patched = data;
      if (Array.isArray(data)) {
        patched = data.map(item => {
          if (item && Array.isArray(item.historial_full)) {
            return { ...item, historial_full: patch(item.historial_full) };
          }
          return item;
        });
      } else if (data && Array.isArray(data.historial_full)) {
        patched = { ...data, historial_full: patch(data.historial_full) };
      }
      return new Response(JSON.stringify(patched), {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers
      });
    } catch(e) {
      console.warn('[WC fetch patch]', e.message);
      return res;
    }
  };
  console.log('[WC] fetch interceptor activo: resuelvo WC2026 al vuelo');
})();

// Lookup por id legacy (wc2026_a1_mex_saf_11jun → mapping a partido)
const WC2026_RESULTS_BY_ID = {
  'wc2026_a1_mex_saf_11jun': { homeScore: 2, awayScore: 0 },
  'wc2026_b1_can_bih_12jun': { homeScore: 1, awayScore: 1 },
  'wc2026_d1_usa_par_12jun': { homeScore: 4, awayScore: 1 },
  'wc2026_c1_usa_par_12jun': { homeScore: 4, awayScore: 1 }, // alias por si cambia
  'wc2026_f1_bra_mar_13jun': { homeScore: 1, awayScore: 1 },
  // 14-jun
  'wc2026_e1_ale_cur_14jun': { homeScore: 7, awayScore: 1 },
  'wc2026_f1_ned_jpn_14jun': { homeScore: 2, awayScore: 2 },
  // 15-jun
  'wc2026_g1_bel_egy_15jun': { homeScore: 1, awayScore: 1 },
  'wc2026_h1_esp_cv_15jun': { homeScore: 0, awayScore: 0 },
  // 16-jun
  'wc2026_i1_fra_sen_16jun': { homeScore: 3, awayScore: 1 },
  'wc2026_j1_arg_alg_16jun': { homeScore: 3, awayScore: 0 },
  // 17-jun
  'wc2026_k1_por_cod_17jun': { homeScore: 1, awayScore: 1 },
  'wc2026_l1_eng_cro_17jun': { homeScore: 4, awayScore: 2 },
  // 21-jun
  'wc2026_f3_tun_jpn_21jun': { homeScore: 0, awayScore: 4 },
  'wc2026_h3_esp_sau_21jun': { homeScore: 4, awayScore: 0 },
  'wc2026_g3_bel_irn_21jun': { homeScore: 0, awayScore: 0 },
  'wc2026_h4_uru_cpv_21jun': { homeScore: 2, awayScore: 2 },
  'wc2026_g4_nzl_egy_21jun': { homeScore: 1, awayScore: 3 },
  // 22-jun
  'wc2026_j3_arg_aut_22jun': { homeScore: 2, awayScore: 0 },
  'wc2026_i3_fra_irq_22jun': { homeScore: 3, awayScore: 0 },
  'wc2026_i4_nor_sen_22jun': { homeScore: 3, awayScore: 2 },
  // 23-jun
  'wc2026_k2_por_uzb_23jun': { homeScore: 5, awayScore: 0 },
  'wc2026_l2_eng_gha_23jun': { homeScore: 0, awayScore: 0 },
  'wc2026_l3_pan_cro_23jun': { homeScore: 0, awayScore: 1 },
  'wc2026_k3_col_cod_23jun': { homeScore: 1, awayScore: 0 },
  // 24-jun
  'wc2026_c3_mar_hti_24jun': { homeScore: 4, awayScore: 2 },
  'wc2026_a3_mex_cze_24jun': { homeScore: 3, awayScore: 0 },
  // 25-jun
  'wc2026_e3_ger_eqg_25jun': { homeScore: 1, awayScore: 2 },
  'wc2026_f3_ned_tun_25jun': { homeScore: 3, awayScore: 1 },
  // 26-jun
  'wc2026_g5_egy_irn_26jun': { homeScore: 1, awayScore: 1 },
  'wc2026_h5_uru_esp_26jun': { homeScore: 0, awayScore: 1 },
};
function resolveWcLocal(pick) {
  // 🛡️ DEFENSA: si el partido aún no se jugó (commenceTs futuro - 4h), NUNCA puede estar resuelto
  if (pick && pick._sportKey === 'soccer_fifa_world_cup' && pick.commenceTs) {
    const nowSafe = Date.now();
    const ended = pick.commenceTs + (4 * 60 * 60 * 1000); // 4h después del kick-off
    if (nowSafe < ended && pick.result && pick.result !== 'pending' && pick.result !== 'void') {
      // FORZAR a pending — alguien lo marcó como win/loss antes de tiempo (BUG)
      console.warn('[WC] Pick marcado como', pick.result, 'pero no se jugó. Forzando a pending:', pick.home, 'vs', pick.away);
      pick = { ...pick, result: 'pending', pl: 0, marcador: '', homeScore: undefined, awayScore: undefined };
    }
  }
  if (!pick || pick.result !== 'pending') return pick;
  if (!(pick.league || '').includes('Mundial') && pick._sportKey !== 'soccer_fifa_world_cup') return pick;
  // Primero intentar por ID legacy
  let r = pick.id && WC2026_RESULTS_BY_ID[pick.id];
  // Si no, intentar por la clave fecha+nombres
  if (!r) {
    const dateIso = (pick.date || '').slice(0, 10);
    if (dateIso) {
      const key = 'wc2026_' + dateIso + '_' + (pick.home || '') + '_' + (pick.away || '');
      r = WC2026_KNOWN_RESULTS[key];
    }
  }
  if (!r || r.homeScore == null) return pick;
  // Aplicar resultado
  const out = { ...pick };
  out.homeScore = r.homeScore;
  out.awayScore = r.awayScore;
  out.marcador = r.homeScore + '-' + r.awayScore;
  out.finalScore = r.homeScore + '-' + r.awayScore;
  // Determinar W/L
  const rec = (pick.rec || '').toLowerCase();
  const totalGoals = r.homeScore + r.awayScore;
  let result = 'loss';
  // 🛡️ Draw No Bet (DNB / "Empate no válido"): si empatan → VOID (devuelve plata, no win ni loss)
  const _isDNB = /empate no v[áa]lido|empate sin apuesta|apuesta sin empate|draw no bet|\bdnb\b/i.test(rec);
  if (_isDNB) {
    if (r.homeScore === r.awayScore) {
      // Empate → VOID
      out.result = 'void';
      out.pl = 0;
      out._wcLocalResolved = true;
      return out;
    }
    // No empate → evaluar quién gana (asumimos pick favorece al local salvo que diga lo contrario)
    const favorsAway = /\bvisitante\b|\baway\b/i.test(rec) || pick._recSide === 'away';
    if (favorsAway) {
      result = r.awayScore > r.homeScore ? 'win' : 'loss';
    } else {
      result = r.homeScore > r.awayScore ? 'win' : 'loss';
    }
    out.result = result;
    const _stk = parseFloat(out.stake) || 100;
    const _odd = parseFloat(out.odds) || parseFloat(out._hO) || parseFloat(out._bestOdds) || 1.85;
    if (result === 'win')       out.pl = +(((_odd - 1) * _stk)).toFixed(2);
    else if (result === 'loss') out.pl = -_stk;
    else                        out.pl = 0;
    out._wcLocalResolved = true;
    return out;
  }
  // Over/Under (priorizar sobre las otras detecciones, "más de X" tiene su propia lógica)
  const overMatch = rec.match(/m[áa]s de ([\d.]+)/i) || rec.match(/over ([\d.]+)/i);
  const underMatch = rec.match(/menos de ([\d.]+)/i) || rec.match(/under ([\d.]+)/i);
  if (overMatch) {
    const threshold = parseFloat(overMatch[1]);
    result = totalGoals > threshold ? 'win' : 'loss';
  } else if (underMatch) {
    const threshold = parseFloat(underMatch[1]);
    result = totalGoals < threshold ? 'win' : 'loss';
  // Doble oportunidad
  } else if (rec.includes('1x') || rec.includes('doble 1') || pick._recSide === '1x') {
    result = (r.homeScore >= r.awayScore) ? 'win' : 'loss';
  } else if (rec.includes('x2') || rec.includes('doble 2') || pick._recSide === 'x2') {
    result = (r.awayScore >= r.homeScore) ? 'win' : 'loss';
  } else if (rec.includes('12') || rec.includes('doble 12') || pick._recSide === '12') {
    result = (r.homeScore !== r.awayScore) ? 'win' : 'loss';
  // Local/Visitante/Empate
  } else if (rec.includes('local') || pick._recSide === 'home') {
    result = r.homeScore > r.awayScore ? 'win' : 'loss';
  } else if (rec.includes('visitante') || pick._recSide === 'away') {
    result = r.awayScore > r.homeScore ? 'win' : 'loss';
  } else if (rec.includes('empate') || pick._recSide === 'draw') {
    result = r.homeScore === r.awayScore ? 'win' : 'loss';
  }
  out.result = result;
  // 🩹 Recalcular P/L cuando convertimos pending → win/loss (sino el render muestra $NaN)
  const _stk = parseFloat(out.stake) || 100;
  const _odd = parseFloat(out.odds) || parseFloat(out._hO) || parseFloat(out._bestOdds) || 1.85;
  if (result === 'win')       out.pl = +(((_odd - 1) * _stk)).toFixed(2);
  else if (result === 'loss') out.pl = -_stk;
  else                        out.pl = 0;
  out._wcLocalResolved = true;
  return out;
}

// (dummy obsoleto removido — todos los países ya están en WC2026_NATIONS)


// 🛡️ (25-jun-2026) Badges SVG inline data-URI — Wikimedia bloquea hotlinking
// y causaba parpadeo de imágenes rotas. Cero requests HTTP ahora.
// 🛡️ Logos confederaciones FIFA — SVGs locales (sin requests externos)
// Hospedados en /escudos/confeds/ porque Wikimedia bloquea hotlinking
// 🆕 (25-jun-2026) Logo de FEDERACION NACIONAL (no confederacion)
// IDs verificados via API-Football /teams?league=1&season=2026 (48 selecciones WC 2026)
// Fallback: si no esta en este mapeo, usar WC2026_CONFEDS
const WC2026_NATION_LOGOS = {
  'Alemania': 'https://media.api-sports.io/football/teams/25.png',
  'Arabia': 'https://media.api-sports.io/football/teams/23.png',
  'Arabia Saudita': 'https://media.api-sports.io/football/teams/23.png',
  'Argelia': 'https://media.api-sports.io/football/teams/1532.png',
  'Argentina': 'https://media.api-sports.io/football/teams/26.png',
  'Australia': 'https://media.api-sports.io/football/teams/20.png',
  'Austria': 'https://media.api-sports.io/football/teams/775.png',
  'Belgica': 'https://media.api-sports.io/football/teams/1.png',
  'Bosnia': 'https://media.api-sports.io/football/teams/1113.png',
  'Bosnia y Herzegovina': 'https://media.api-sports.io/football/teams/1113.png',
  'Brasil': 'https://media.api-sports.io/football/teams/6.png',
  'Bélgica': 'https://media.api-sports.io/football/teams/1.png',
  'Cabo Verde': 'https://media.api-sports.io/football/teams/1533.png',
  'Canada': 'https://media.api-sports.io/football/teams/5529.png',
  'Canadá': 'https://media.api-sports.io/football/teams/5529.png',
  'Catar': 'https://media.api-sports.io/football/teams/1569.png',
  'Chequia': 'https://media.api-sports.io/football/teams/770.png',
  'Colombia': 'https://media.api-sports.io/football/teams/8.png',
  'Corea': 'https://media.api-sports.io/football/teams/17.png',
  'Corea del Sur': 'https://media.api-sports.io/football/teams/17.png',
  'Costa Marfil': 'https://media.api-sports.io/football/teams/1501.png',
  'Costa de Marfil': 'https://media.api-sports.io/football/teams/1501.png',
  'Croacia': 'https://media.api-sports.io/football/teams/3.png',
  'Curacao': 'https://media.api-sports.io/football/teams/5530.png',
  'Curaçao': 'https://media.api-sports.io/football/teams/5530.png',
  'DR Congo': 'https://media.api-sports.io/football/teams/1508.png',
  'Ecuador': 'https://media.api-sports.io/football/teams/2382.png',
  'Egipto': 'https://media.api-sports.io/football/teams/32.png',
  'Escocia': 'https://media.api-sports.io/football/teams/1108.png',
  'España': 'https://media.api-sports.io/football/teams/9.png',
  'Estados Unidos': 'https://media.api-sports.io/football/teams/2384.png',
  'Francia': 'https://media.api-sports.io/football/teams/2.png',
  'Ghana': 'https://media.api-sports.io/football/teams/1504.png',
  'Haiti': 'https://media.api-sports.io/football/teams/2386.png',
  'Haití': 'https://media.api-sports.io/football/teams/2386.png',
  'Holanda': 'https://media.api-sports.io/football/teams/1118.png',
  'Inglaterra': 'https://media.api-sports.io/football/teams/10.png',
  'Irak': 'https://media.api-sports.io/football/teams/1567.png',
  'Iran': 'https://media.api-sports.io/football/teams/22.png',
  'Iraq': 'https://media.api-sports.io/football/teams/1567.png',
  'Irán': 'https://media.api-sports.io/football/teams/22.png',
  'Japon': 'https://media.api-sports.io/football/teams/12.png',
  'Japón': 'https://media.api-sports.io/football/teams/12.png',
  'Jordania': 'https://media.api-sports.io/football/teams/1548.png',
  'Marruecos': 'https://media.api-sports.io/football/teams/31.png',
  'Mexico': 'https://media.api-sports.io/football/teams/16.png',
  'México': 'https://media.api-sports.io/football/teams/16.png',
  'Noruega': 'https://media.api-sports.io/football/teams/1090.png',
  'Nueva Zelanda': 'https://media.api-sports.io/football/teams/4673.png',
  'Paises Bajos': 'https://media.api-sports.io/football/teams/1118.png',
  'Panama': 'https://media.api-sports.io/football/teams/11.png',
  'Panamá': 'https://media.api-sports.io/football/teams/11.png',
  'Paraguay': 'https://media.api-sports.io/football/teams/2380.png',
  'Países Bajos': 'https://media.api-sports.io/football/teams/1118.png',
  'Portugal': 'https://media.api-sports.io/football/teams/27.png',
  'Qatar': 'https://media.api-sports.io/football/teams/1569.png',
  'R.D. Congo': 'https://media.api-sports.io/football/teams/1508.png',
  'RD Congo': 'https://media.api-sports.io/football/teams/1508.png',
  'Rep. Checa': 'https://media.api-sports.io/football/teams/770.png',
  'Republica Checa': 'https://media.api-sports.io/football/teams/770.png',
  'República Checa': 'https://media.api-sports.io/football/teams/770.png',
  'Senegal': 'https://media.api-sports.io/football/teams/13.png',
  'Sudafrica': 'https://media.api-sports.io/football/teams/1531.png',
  'Sudáfrica': 'https://media.api-sports.io/football/teams/1531.png',
  'Suecia': 'https://media.api-sports.io/football/teams/5.png',
  'Suiza': 'https://media.api-sports.io/football/teams/15.png',
  'Tunez': 'https://media.api-sports.io/football/teams/28.png',
  'Turquia': 'https://media.api-sports.io/football/teams/777.png',
  'Turquía': 'https://media.api-sports.io/football/teams/777.png',
  'Túnez': 'https://media.api-sports.io/football/teams/28.png',
  'USA': 'https://media.api-sports.io/football/teams/2384.png',
  'Uruguay': 'https://media.api-sports.io/football/teams/7.png',
  'Uzbekistan': 'https://media.api-sports.io/football/teams/1568.png',
  'Uzbekistán': 'https://media.api-sports.io/football/teams/1568.png',
};

const WC2026_CONFEDS = {
  UEFA:     '/escudos/confeds/UEFA.svg',
  CONMEBOL: '/escudos/confeds/CONMEBOL.svg',
  CONCACAF: '/escudos/confeds/CONCACAF.svg',
  CAF:      '/escudos/confeds/CAF.svg',
  AFC:      '/escudos/confeds/AFC.svg',
  OFC:      '/escudos/confeds/OFC.svg',
};

// Eventos especiales del Mundial (away = "Grupo A", "Campeón Mundial 2026", "Bota de Oro", etc.)
function wcEventBadge(name, size=48) {
  const lower = (name||'').toLowerCase();
  let emoji = '🏆', bg = 'linear-gradient(135deg,#c8102e 0%,#FFD700 100%)';
  if (lower.includes('grupo'))         { emoji='⚽'; bg='linear-gradient(135deg,#006847 0%,#15803d 100%)'; }
  else if (lower.includes('octavos'))  { emoji='🥇'; bg='linear-gradient(135deg,#FFD700 0%,#f59e0b 100%)'; }
  else if (lower.includes('cuartos'))  { emoji='🥈'; bg='linear-gradient(135deg,#FFD700 0%,#f59e0b 100%)'; }
  else if (lower.includes('semi'))     { emoji='🥉'; bg='linear-gradient(135deg,#FFD700 0%,#f59e0b 100%)'; }
  else if (lower.includes('final'))    { emoji='🏆'; bg='linear-gradient(135deg,#FFD700 0%,#c8102e 100%)'; }
  else if (lower.includes('campeón') || lower.includes('campeon'))  { emoji='🏆'; bg='linear-gradient(135deg,#FFD700 0%,#c8102e 100%)'; }
  else if (lower.includes('bota')) { emoji='👟'; bg='linear-gradient(135deg,#FFD700 0%,#f59e0b 100%)'; }
  else if (lower.includes('goleador')) { emoji='⚽'; bg='linear-gradient(135deg,#FFD700 0%,#c8102e 100%)'; }
  const fsz = Math.round(size * 0.5);
  // 🏆 Pelota Trionda flotando sin fondo cuando el theming Mundial está activo (solo donde habría ⚽)
  const _isMundial = (typeof document !== 'undefined' && document.body && document.body.classList && document.body.classList.contains('wc2026-theme'));
  if (emoji === '⚽' && _isMundial) {
    return `<img loading="lazy" decoding="async" src="/img/trionda-float.png" alt="${(name||'').replace(/"/g,'&quot;')}" title="${(name||'').replace(/"/g,'&quot;')}" style="width:${size}px;height:${size}px;object-fit:contain;flex-shrink:0;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.45)) drop-shadow(0 0 8px rgba(255,215,0,0.25));animation:gbTriondaFloat 3.5s ease-in-out infinite" onerror="this.outerHTML='⚽'">`;
  }
  return `<span title="${(name||'').replace(/"/g,'&quot;')}" style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:${bg};color:#fff;font-size:${fsz}px;line-height:1;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,0.4);border:2px solid rgba(255,215,0,0.5)">${emoji}</span>`;
}

// Badge para selección nacional: bandera grande + escudo confederación esquina superior izq
function nationalTeamBadge(name, size=48) {
  const info = WC2026_NATIONS[name];
  if (!info) return null;
  const flagUrl = `https://flagcdn.com/w160/${info.iso}.png`;
  // 🆕 (25-jun-2026) Invertido: escudo de FEDERACION es la imagen PRINCIPAL (AFA, CBF, DFB...)
  // La bandera queda como sub-escudito chico en la esquina (referencia visual del pais).
  const mainLogoUrl = WC2026_NATION_LOGOS[name];
  const subSize = Math.max(14, Math.round(size * 0.38));
  // Si no hay logo federacion (ej. seleccion que no esta en el dict), usar bandera como principal
  if (!mainLogoUrl) {
    return `<span title="${name} (${info.conf})" style="position:relative;display:inline-block;width:${size}px;height:${size}px;border-radius:50%;overflow:visible;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,0.5);background:#fff">`
         + `<img loading="lazy" decoding="async" src="${flagUrl}" alt="${name}" width="${size}" height="${size}" style="width:${size}px;height:${size}px;object-fit:cover;border-radius:50%;display:block">`
         + `<img loading="lazy" decoding="async" src="${WC2026_CONFEDS[info.conf]}" alt="${info.conf}" width="${subSize}" height="${subSize}" style="position:absolute;top:-3px;left:-3px;width:${subSize}px;height:${subSize}px;border-radius:50%;background:#fff;padding:2px;box-sizing:border-box;box-shadow:0 1px 4px rgba(0,0,0,0.4)" onerror="this.style.display='none'">`
         + `</span>`;
  }
  // Caso normal: SOLO escudo de federacion (sin sub-bandera) — Mauro lo pidio limpio
  // onerror del logo principal: fallback a bandera con tamaño grande
  const fallbackBig = flagUrl.replace(/'/g, "\\'");
  return `<span title="${name} (${info.conf})" style="position:relative;display:inline-block;width:${size}px;height:${size}px;border-radius:50%;overflow:visible;flex-shrink:0;box-shadow:0 2px 8px rgba(0,0,0,0.5);background:#fff">`
       + `<img src="${mainLogoUrl}" alt="${name}" width="${size}" height="${size}" style="width:${size}px;height:${size}px;object-fit:contain;border-radius:50%;display:block;background:#fff;padding:3px;box-sizing:border-box" onerror="this.onerror=null;this.src='${fallbackBig}';this.style.objectFit='cover';this.style.padding='0'">`
       + `</span>`;
}

function logoHtml(name, size=48) {
  // 🔧 Asegurar traducción WC EN→ES antes del lookup (Odds API trae nombres en inglés)
  if (name && typeof translateWcTeam === 'function') {
    const _t = translateWcTeam(name);
    if (_t && _t !== name) name = _t;
  }
  // ─ WC2026 fallback: jugadores estrella (Mbappé, Messi, CR7) — foto + banderita
  if (name && WC2026_STARS[name]) {
    const sb = wcStarBadge(name, size);
    if (sb) return sb;
  }
  // ─ WC2026 fallback: selecciones nacionales sin escudo de club
  if (name && WC2026_NATIONS[name]) {
    const nb = nationalTeamBadge(name, size);
    if (nb) return nb;
  }
  // ─ WC2026 fallback: eventos especiales (Grupo X, Campeón, Bota de Oro, etc.)
  if (name && /^(grupo|campe[óo]n|finalista|semifinal|cuartos|octavos|bota|goleador)/i.test(name)) {
    return wcEventBadge(name, size);
  }
  // Buscar logo con fallbacks de nombre: exacto → sin acento → sin sufijo → sin prefijo → normalizado parcial
  function findLogoUrl(n) {
    if (!n) return null;
    if (teamLogos[n]) return teamLogos[n];
    // Intentar sin acentos (ej: "Atletico Mineiro" → encuentra "Atlético Mineiro")
    const normCache = _getNormLogoCache();
    const normN = _foldSpecial(n.toLowerCase()).normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,' ').trim();
    if (normCache[normN]) return normCache[normN];
    // Intentar sin sufijos comunes: FC, SC, TC, CF, AC, AS, CD, SD, RCD, FK, SK, BK, IF, IFK
    const stripped = n.replace(/\b(FC|SC|TC|CF|AC|AS|CD|SD|RCD|FK|SK|BK|IF|IFK|RC|UD|CA|CE|SV|VfB|VfL|TSG|RB|BSC|GNK|NK)\b\.?/gi, '').trim();
    if (stripped !== n && teamLogos[stripped]) return teamLogos[stripped];
    if (stripped !== n && normCache[stripped.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,' ').trim()]) return normCache[stripped.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,' ').trim()];
    // Intentar sin prefijos comunes
    const noPre = n.replace(/^(FC|SC|AC|AS|CD|SD|RCD|FK|SK|NK|GNK|RB)\s+/i, '').trim();
    if (noPre !== n && teamLogos[noPre]) return teamLogos[noPre];
    if (noPre !== n && normCache[noPre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,' ').trim()]) return normCache[noPre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,' ').trim()];
    // Fallback: buscar nombre completo via reverse de teamShortNames
    if (typeof teamShortNames !== 'undefined') {
      const fullName = Object.keys(teamShortNames).find(k => teamShortNames[k] === n);
      if (fullName && teamLogos[fullName]) return teamLogos[fullName];
    }
    // Fallback para nombres truncados con "…" (ej: "Independiente Mede…" → buscar por prefijo)
    if (n.endsWith('…') || n.endsWith('...')) {
      const prefix = n.replace(/[…\.]+$/, '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,' ').trim();
      if (prefix.length >= 6) {
        const matchKey = Object.keys(teamLogos).find(k => {
          const kn = k.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9 ]/g,' ').trim();
          return kn.startsWith(prefix);
        });
        if (matchKey) return teamLogos[matchKey];
      }
    }
    return null;
  }
  const url = findLogoUrl(name);
  if (url) {
    const needsWhiteBg = _whiteBgLogos.has(name);
    const imgStyle = needsWhiteBg
      ? `object-fit:contain;background:#c8102e;border-radius:50%;padding:5px;box-sizing:border-box`
      : `object-fit:contain;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.5))`;
    return `<img loading="lazy" decoding="async" src="${url}" alt="${name}" width="${size}" height="${size}"
      style="${imgStyle}"
      onerror="this.outerHTML=teamInitialsBadge(this.alt,${size})">`;
  }
  // Solo usar foto Wikipedia para tenistas conocidos o nombres que parecen persona (Nombre Apellido)
  const isTennis = tennisWikiMap[name] ||
    /^[A-ZÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛÄËÏÖÜÇ][a-záéíóúüñàèìòùâêîôûäëïöüç'\-]+ [A-ZÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛÄËÏÖÜÇ][a-záéíóúüñàèìòùâêîôûäëïöüç'\-]+$/.test(name);
  if (!isTennis) {
    // Equipo sin logo → badge de iniciales; registrar para chequeo admin
    if (window._logoMisses) window._logoMisses.add(name);
    return teamInitialsBadge(name, size);
  }
  const initials = name.split(' ').map(w=>w[0]).slice(0,2).join('');
  const wikiKey  = tennisWikiMap[name] || name;
  const cached   = playerPhotoCache[wikiKey];
  const photoStyle = cached ? 'opacity:1' : '';
  const photoSrc   = cached ? `src="${cached}"` : '';
  const photoClass = cached ? 'pa-photo loaded' : 'pa-photo';
  return `<div class="player-avatar" style="width:${size}px;height:${size}px">
    <span class="pa-initials" style="font-size:${Math.round(size*0.32)}px">${initials}</span>
    <img loading="lazy" decoding="async" class="${photoClass}" data-wiki="${wikiKey}" ${photoSrc} alt="${name}" style="${photoStyle}">
  </div>`;
}

const scoresData = [];

// predsData eliminado — no mostrar picks de demo

// statsData: sin datos de demo — solo se muestran stats reales de la API
const statsData = { futbol: [], tenis: [] };

// ═══════════════════════════════════════════════
//  SKELETON SCORES
// ═══════════════════════════════════════════════
let _scoresFirstLoad = false; // se vuelve true cuando llegan datos reales (o falla definitiva)

function renderSkeletonScores(count = 6) {
  const grid = document.getElementById('scoresGrid');
  const wrap = document.querySelector('#scores .scores-grid-wrap');
  if (!grid) return;
  const card = () => `
    <div class="sk-card">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="sk-line" style="width:38%;height:9px"></div>
        <div class="sk-line" style="width:20%;height:9px"></div>
      </div>
      <div style="display:flex;justify-content:space-around;align-items:center;gap:10px;margin-top:4px">
        <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
          <div class="sk-circle" style="width:48px;height:48px"></div>
          <div class="sk-line" style="width:64px;height:9px"></div>
        </div>
        <div class="sk-line" style="width:52px;height:28px;border-radius:8px"></div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
          <div class="sk-circle" style="width:48px;height:48px"></div>
          <div class="sk-line" style="width:64px;height:9px"></div>
        </div>
      </div>
    </div>`;
  grid.innerHTML = Array.from({length: count}, card).join('');
  if (wrap) {
    wrap.style.maxHeight = 'none';
    wrap.style.overflow  = 'hidden';
  }
}

// ═══════════════════════════════════════════════
//  RENDER SCORES
// ═══════════════════════════════════════════════

let currentScoreFilter = 'all';

function renderScores(filter) {
  const grid = document.getElementById('scoresGrid');
  if (!grid) return;
  // Rugby, UFC y Tenis siempre muestran el banner de Telegram (nunca partidos)
  const BANNER_ONLY = new Set(['rugby', 'ufc', 'tenis']);
  // Rugby y UFC tampoco aparecen en "Todos"
  const EXTRA = new Set(['rugby', 'ufc', 'tenis']);
  let data;
  if (filter === 'all') {
    data = scoresData.filter(s => !EXTRA.has(s.sport)).slice(0, 8);
  } else if (BANNER_ONLY.has(filter)) {
    data = []; // forzar banner siempre
  } else {
    data = scoresData.filter(s => s.sport === filter);
  }
  if (data.length === 0 && !_scoresFirstLoad && !BANNER_ONLY.has(filter)) {
    // Todavía no llegaron datos de la API → mostrar skeleton
    renderSkeletonScores(6);
    return;
  }
  if (data.length === 0) {
    const telegramChannels = {
      rugby: {
        url:     'https://t.me/apuestasrugby',
        nombre:  T('ch.rugby.nombre'),
        emoji:   '🏉',
        subs:    T('ch.rugby.subs'),
        badge:   T('tg.badge'),
        desc:    T('ch.rugby.desc'),
        tip:     T('ch.rugby.tip'),
        photo:   'https://images.unsplash.com/photo-1574602904316-f84f62477265?w=900&auto=format&fit=crop&q=85',
        color:   '#1a4a1a',
        accent:  '#3dba3d',
      },
      tenis: {
        url:     'https://t.me/TenisLATAM',
        nombre:  T('ch.tenis.nombre'),
        emoji:   '🎾',
        subs:    T('ch.tenis.subs'),
        badge:   T('tg.badge'),
        desc:    T('ch.tenis.desc'),
        tip:     T('ch.tenis.tip'),
        photo:   'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5a/Novak_Djokovic_vs._Carlos_Alcaraz%2C_2024_Summer_Olympics_men%27s_singles_tennis_tournament%2C_2024-08-04_%28722%29.jpg/960px-Novak_Djokovic_vs._Carlos_Alcaraz%2C_2024_Summer_Olympics_men%27s_singles_tennis_tournament%2C_2024-08-04_%28722%29.jpg',
        color:   '#1a2a4a',
        accent:  '#4a9edd',
      },
      ufc: {
        url:     'https://t.me/+bc-yqbAMZLkxNWMx',
        nombre:  T('ch.ufc.nombre'),
        emoji:   '🥊',
        subs:    T('ch.ufc.subs'),
        badge:   T('tg.badge'),
        desc:    T('ch.ufc.desc'),
        tip:     T('ch.ufc.tip'),
        photo:   'https://images.unsplash.com/photo-1517438322307-e67111335449?w=900&auto=format&fit=crop&q=85',
        color:   '#1a0505',
        accent:  '#e03030',
      },
    };
    const ch = telegramChannels[filter];
    if (ch) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;display:flex;justify-content:center;padding:4px 8px 2px;">
          <div style="
            max-width:820px;width:100%;border-radius:16px;overflow:hidden;
            box-shadow:0 6px 28px #00000077;border:1px solid ${ch.accent}44;
            display:flex;flex-direction:row;min-height:0;
          ">
            <!-- FOTO lateral -->
            <div style="position:relative;width:160px;flex-shrink:0;background:${ch.color};overflow:hidden;">
              <img loading="lazy" decoding="async" src="${ch.photo}" alt="${ch.nombre}"
                style="width:100%;height:100%;object-fit:cover;opacity:0.65;display:block;"
                onerror="this.style.display='none'"
              />
              <div style="position:absolute;inset:0;background:linear-gradient(to right,transparent 30%,${ch.color}ee 100%);"></div>
              <div style="position:absolute;top:10px;left:8px;">
                <span style="background:${ch.accent};color:#fff;font-size:0.58rem;font-weight:800;letter-spacing:1px;padding:2px 7px;border-radius:50px;">${ch.badge}</span>
              </div>
              <div style="position:absolute;bottom:10px;left:10px;">
                <span style="font-size:2.2rem;filter:drop-shadow(0 2px 8px #000)">${ch.emoji}</span>
              </div>
            </div>
            <!-- CONTENIDO derecho -->
            <div style="background:#0d1117;padding:13px 16px 13px;flex:1;display:flex;flex-direction:column;gap:7px;min-width:0;">
              <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;">
                <span style="color:#fff;font-size:1.05rem;font-weight:800;line-height:1.2;">${ch.nombre}</span>
                <span style="color:${ch.accent};font-size:0.74rem;font-weight:600;white-space:nowrap;">${ch.subs}</span>
              </div>
              <p style="color:#b8c8b8;font-size:0.81rem;line-height:1.42;margin:0;">${ch.desc}</p>
              <div style="background:${ch.accent}18;border-left:2px solid ${ch.accent};border-radius:0 7px 7px 0;padding:6px 10px;font-size:0.77rem;color:#ddeedd;line-height:1.38;">${ch.tip}</div>
              <a href="${ch.url}" target="_blank" rel="noopener" style="
                display:inline-flex;align-items:center;justify-content:center;gap:7px;
                background:#229ED9;color:#fff;font-weight:800;font-size:0.84rem;
                padding:7px 16px;border-radius:50px;text-decoration:none;
                box-shadow:0 3px 10px #229ED944;align-self:flex-start;
              " onmouseover="this.style.opacity='.88'" onmouseout="this.style.opacity='1'">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
                  <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L8.32 14.188l-2.96-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.828.371z"/>
                </svg>
                ${T('tg.join')}
              </a>
            </div>
          </div>
        </div>`;
      return;
    }
    // Fallback genérico
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:48px 20px;color:var(--texto-sec)">
      <div style="font-size:2rem;margin-bottom:12px">📅</div>
      <div style="font-size:0.95rem">${T('empty.games')}</div>
    </div>`;
    return;
  }
  grid.innerHTML = data.filter(s => s.flag !== 'live' && !s.forResolutionOnly).map(s => `
    <div class="score-card ${s.flag}">
      <div class="score-header">
        <span class="league-name">${s.league}</span>
        <span class="status-badge ${
          s.flag==='live'     ? 'status-live'     :
          s.flag==='soon'     ? 'status-soon'     :
          s.flag==='upcoming' ? 'status-upcoming' : 'status-finished'}">
          ${s.flag==='live' ? T('status.live') : s.flag==='soon' ? T('status.soon') : s.flag==='upcoming' ? T('status.upcoming') : T('status.final')}
        </span>
      </div>
      <div class="score-teams">
        <div class="team">
          <div class="team-emoji">${logoHtml(s.homeRaw || s.home, 46)}</div>
          <div class="team-name">${s.home}</div>
        </div>
        <div class="score-center">
          <div class="score-value">${s.flag==='upcoming'?'vs':s.scoreH+' - '+s.scoreA}</div>
          <div class="score-time ${s.flag==='live'?'live-time':''}">${s.time}</div>
        </div>
        <div class="team">
          <div class="team-emoji">${logoHtml(s.awayRaw || s.away, 46)}</div>
          <div class="team-name">${s.away}</div>
        </div>
      </div>
    </div>
  `).join('');

  // Limitar el wrap a exactamente 2 filas basado en la altura real de las cards
  requestAnimationFrame(() => {
    const wrap = document.querySelector('#scores .scores-grid-wrap');
    const firstCard = grid.querySelector('.score-card');
    if (wrap && firstCard) {
      const cardH = firstCard.offsetHeight;
      const gap = 14;
      wrap.style.maxHeight = (cardH * 2 + gap + 2) + 'px';
      wrap.style.overflow = 'hidden auto'; // x:hidden, y:auto (scroll)
    } else if (wrap) {
      // Banner: quitar todo límite — overflow visible en ambos ejes
      wrap.style.maxHeight = 'none';
      wrap.style.overflow = 'visible'; // limpia x e y a la vez
    }
  });
}

function filterScores(sport, btn) {
  document.querySelectorAll('#scores .sport-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentScoreFilter = sport;
  renderScores(sport);
}

// ═══════════════════════════════════════════════
//  RENDER PREDICTIONS
// ═══════════════════════════════════════════════

// Construye predicciones reales a partir de los datos de la API de odds
// ──────────────────────────────────────────────────────────────
// shortName(): definición canónica más abajo (~14k) — usa teamShortNames.
// Antes había una segunda implementación con map `abbrevs` inline; sus
// 29 entradas únicas fueron migradas a teamShortNames el 14-may-2026.
// ──────────────────────────────────────────────────────────────

function leagueLabel(sportTitle) {
  if (!sportTitle) return '';
  const t = sportTitle;
  if (t.includes('Argentine') || t.includes('Argentina')) return '🇦🇷';
  if (t.includes('Champions'))    return '⭐';
  if (t.includes('Libertadores')) return '🌎';
  if (t.includes('Sudamericana')) return '🌎';
  if (t.includes('Europa League')) return '🟠';
  if (t.includes('Conference'))   return '🟢';
  if (t.includes('Premier') || t.includes('EPL')) return '🏴󠁧󠁢󠁥󠁮󠁧󠁿';
  if (t.includes('La Liga') || t.includes('Spain')) return '🇪🇸';
  if (t.includes('Serie A') || t.includes('Italy')) return '🇮🇹';
  if (t.includes('Bundesliga') || t.includes('Germany')) return '🇩🇪';
  if (t.includes('Ligue 1') || t.includes('France')) return '🇫🇷';
  if (t.includes('Brazil') || t.includes('Brasil') || t.includes('Brasileiro')) return '🇧🇷';
  if (t.includes('MLS') || t.includes('Major League Soccer')) return '🇺🇸';
  if (t.includes('Liga MX') || t.includes('Mexico')) return '🇲🇽';
  if (t.includes('Portugal') || t.includes('Primeira')) return '🇵🇹';
  if (t.includes('Eredivisie') || t.includes('Netherlands') || t.includes('Dutch')) return '🇳🇱';
  if (t.includes('Scotland') || t.includes('Scottish')) return '🏴󠁧󠁢󠁳󠁣󠁴󠁿';
  if (t.includes('Turkey') || t.includes('Turk') || t.includes('Süper')) return '🇹🇷';
  if (t.includes('Saudi') || t.includes('Arabia')) return '🇸🇦';
  if (t.includes('Japan') || t.includes('J-League') || t.includes('J.League')) return '🇯🇵';
  if (t.includes('Chile') || t.includes('Chilean')) return '🇨🇱';
  if (t.includes('Uruguay') || t.includes('Uruguayan')) return '🇺🇾';
  if (t.includes('ATP') || t.includes('WTA') || t.includes('Open') || t.includes('Wimbledon')) return '🎾';
  return '';
}

// Nombre completo de liga desde sport_key (para filtro de historial)
const _PL_TEAMS = new Set(['Arsenal','Chelsea','Liverpool','Manchester City','Manchester United','Man City','Man United','Tottenham','Newcastle','Brighton','Aston Villa','West Ham','Fulham','Bournemouth','Brentford','Crystal Palace','Everton','Wolverhampton','Wolves','Nottingham Forest',"Nott'm Forest",'Leicester','Leicester City','Southampton','Ipswich','Luton','Burnley','Sheffield United','West Bromwich','West Brom','Leeds','Watford','Norwich','Sunderland','Swansea','Cardiff','Derby','Middlesbrough','Stoke','Huddersfield','Birmingham','Blackburn','Wigan','Hull','Charlton','Portsmouth','Reading','Bolton','Blackpool','QPR','Wigan Athletic','Tottenham Hotspur','Brighton and Hove Albion','Wolverhampton Wanderers','West Ham United','Nottingham Forest','AFC Bournemouth','Newcastle United']);

function sportKeyToLeague(sk, home, away) {
  if (sk) {
    // Ligas nunca soportadas: bloquear explícitamente para evitar flags incorrectas
    if (sk.includes('albania') || sk.includes('faroe') || sk.includes('andorra') || sk.includes('san_marino') || sk.includes('gibraltar') || sk.includes('liechtenstein') || sk.includes('malta') || sk.includes('kosovo')) return null;
    if (sk.includes('argentina_primera_nacional'))          return '🇦🇷 Primera Nacional';
    if (sk.includes('argentina'))                           return '🇦🇷 Liga Prof.';
    if (sk.includes('champs') || sk.includes('champions')) return '⭐ Champions';
    if (sk.includes('copa_libertadores'))                   return '🌎 Libertadores';
    if (sk.includes('copa_sudamericana'))                   return '🌎 Sudamericana';
    if (sk.includes('europa_conference') || sk.includes('conference')) return '🟢 Conference';
    if (sk.includes('europa_league'))                       return '🟠 Europa League';
    if (sk.includes('england_championship'))                return '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Championship';
    if (sk.includes('england_premier') || sk.includes('epl') || sk.includes('english_premier')) return '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League';
    if (sk.includes('spain_segunda'))                       return '🇪🇸 Segunda Div.';
    if (sk.includes('spain_la_liga'))                       return '🇪🇸 La Liga';
    if (sk.includes('italy_serie_b'))                       return '🇮🇹 Serie B';
    if (sk.includes('italy_serie'))                         return '🇮🇹 Serie A';
    if (sk.includes('germany_bundesliga2') || sk.includes('bundesliga_2')) return '🇩🇪 2. Bundesliga';
    if (sk.includes('germany_bundesliga'))                  return '🇩🇪 Bundesliga';
    if (sk.includes('france_ligue_two'))                    return '🇫🇷 Ligue 2';
    if (sk.includes('france_ligue'))                        return '🇫🇷 Ligue 1';
    if (sk.includes('brazil_serie_b'))                       return '🇧🇷 Brasileirão B';
    if (sk.includes('brazil') || sk.includes('brasileiro')) return '🇧🇷 Brasileirao';
    if (sk.includes('portugal'))                            return '🇵🇹 Liga Portugal';
    if (sk.includes('belgium'))                             return '🇧🇪 Pro League';
    if (sk.includes('netherlands') || sk.includes('eredivisie')) return '🇳🇱 Eredivisie';
    if (sk.includes('scotland'))                            return '🏴󠁧󠁢󠁳󠁣󠁴󠁿 Scottish PL';
    if (sk.includes('turkey'))                              return '🇹🇷 Süper Lig';
    if (sk.includes('greece'))                              return '🇬🇷 Super League';
    if (sk.includes('austria'))                             return '🇦🇹 Bundesliga';
    if (sk.includes('switzerland'))                         return '🇨🇭 Super League';
    if (sk.includes('denmark'))                             return '🇩🇰 Superliga';
    if (sk.includes('sweden'))                              return '🇸🇪 Allsvenskan';
    if (sk.includes('norway'))                              return '🇳🇴 Eliteserien';
    if (sk.includes('poland'))                              return '🇵🇱 Ekstraklasa';
    if (sk.includes('czech'))                               return '🇨🇿 Czech Liga';
    if (sk.includes('romania'))                             return '🇷🇴 Liga 1';
    if (sk.includes('russia'))                              return '🇷🇺 RPL';
    if (sk.includes('colombia'))                            return '🇨🇴 Liga BetPlay';
    if (sk.includes('ecuador'))                             return '🇪🇨 Liga Pro';
    if (sk.includes('peru'))                                return '🇵🇪 Liga 1';
    if (sk.includes('venezuela'))                           return '🇻🇪 FUTVE';
    if (sk.includes('bolivia'))                             return '🇧🇴 Div. Prof.';
    if (sk.includes('paraguay'))                            return '🇵🇾 Div. Honor';
    if (sk.includes('saudi'))                               return '🇸🇦 Saudi PL';
    if (sk.includes('south_korea') || sk.includes('kleague')) return '🇰🇷 K League';
    if (sk.includes('australia'))                           return '🇦🇺 A-League';
    if (sk.includes('japan'))                               return '🇯🇵 J-League';
    if (sk.includes('chile'))                               return '🇨🇱 Chile';
    if (sk.includes('uruguay'))                             return '🇺🇾 Uruguay';
    if (sk.includes('usa') || sk.includes('mls'))          return '🇺🇸 MLS';
    if (sk.includes('mexico'))                              return '🇲🇽 Liga MX';
    if (sk.includes('tennis') || sk.includes('atp') || sk.includes('wta')) return '🎾 Tenis';
    if (sk.includes('soccer'))                              return '⚽ Otras ligas';
  }
  // Fallback por nombre de equipo
  if (home && (_PL_TEAMS.has(home) || _PL_TEAMS.has(away))) return '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League';
  return null;
}

// Convierte nombre de liga a bandera + sigla corta para mostrar en fichas
function leagueShort(lg) {
  if (!lg) return '';
  // ── Fast-path: sportKeyToLeague ya incluye el emoji de bandera ──────────────
  // Si el string empieza con una bandera conocida, mapear directamente.
  // Esto evita que "🇨🇭 Super League" caiga en la rama de Turquía o Alemania.
  const _emojiShort = {
    '⭐': '⭐ UCL',  '🌎': '🌎',    '🟢': '🟢 CONF', '🟠': '🟠 EUR',
    '🏴󠁧󠁢󠁥󠁮󠁧󠁿': null,  // necesita distinción Premier/Championship — caer al texto
    '🏴󠁧󠁢󠁳󠁣󠁴󠁿': '🏴󠁧󠁢󠁳󠁣󠁴󠁿 SPL',
    '🇦🇷': null,   // necesita distinción LP/PN — caer al texto
    '🇧🇷': '🇧🇷 BRA', '🇵🇹': '🇵🇹 LPOR', '🇳🇱': '🇳🇱 ERE',
    '🇧🇪': '🇧🇪 BEL', '🇹🇷': '🇹🇷 SL',   '🇬🇷': '🇬🇷 GRE',
    '🇨🇭': '🇨🇭 SUI', '🇦🇹': '🇦🇹 AUT', '🇩🇰': '🇩🇰 DEN',
    '🇸🇪': '🇸🇪 SWE', '🇳🇴': '🇳🇴 NOR', '🇵🇱': '🇵🇱 POL',
    '🇨🇿': '🇨🇿 CZE', '🇷🇴': '🇷🇴 ROM', '🇷🇺': '🇷🇺 RPL',
    '🇨🇴': '🇨🇴 COL', '🇪🇨': '🇪🇨 ECU', '🇵🇪': '🇵🇪 PER',
    '🇻🇪': '🇻🇪 VEN', '🇧🇴': '🇧🇴 BOL', '🇵🇾': '🇵🇾 PAR',
    '🇸🇦': '🇸🇦 KSA', '🇰🇷': '🇰🇷 KOR', '🇦🇺': '🇦🇺 AUS',
    '🇯🇵': '🇯🇵 JL',  '🇺🇾': '🇺🇾 URU', '🇨🇱': '🇨🇱 CHI',
    '🇺🇸': '🇺🇸 MLS', '🇲🇽': '🇲🇽 MX',
    '🎾': '🎾',
  };
  // Detectar el emoji inicial (los flags de UK son 8 bytes, los simples son 4)
  const _runes = [...lg]; // spread respeta code points
  const _flag  = _runes.slice(0, 2).join(''); // flags de país = 2 code points
  const _flag1 = _runes[0] || '';             // flags England/Scotland = 1 secuencia visual pero más code points
  if (_flag in _emojiShort && _emojiShort[_flag] !== null) return _emojiShort[_flag];
  // Para Alemania/España/Italia/Francia que necesitan distinción por número de liga:
  if (_flag === '🇩🇪') { const l2 = lg.toLowerCase(); return (l2.includes('2.') || l2.includes('bl2')) ? '🇩🇪 ALE2' : '🇩🇪 ALE'; }
  if (_flag === '🇪🇸') { const l2 = lg.toLowerCase(); return l2.includes('segunda') ? '🇪🇸 ES2' : '🇪🇸 ES'; }
  if (_flag === '🇮🇹') { const l2 = lg.toLowerCase(); return (l2.includes('serie b') || l2.includes('b')) ? '🇮🇹 IT2' : '🇮🇹 IT'; }
  if (_flag === '🇫🇷') { const l2 = lg.toLowerCase(); return l2.includes('2') ? '🇫🇷 FR2' : '🇫🇷 FR'; }
  // ── Fallback por texto (para picks sin _sportKey o con league string viejo) ──
  const l = lg.toLowerCase();
  if (l.includes('champions') || l.includes('champs') || l.includes('ucl')) return '⭐ UCL';
  if (l.includes('libertadores'))                                             return '🌎 LIB';
  if (l.includes('sudamericana') || l.includes('copa sud'))                  return '🌎 SUD';
  if (l.includes('conference'))                                               return '🟢 CONF';
  if (l.includes('europa league') || l.includes('europa_league'))            return '🟠 EUR';
  if (l.includes('primera nacional'))                                         return '🇦🇷 PN';
  if (l.includes('liga prof') || l.includes('liga profesional'))             return '🇦🇷 ARG';
  if (l.includes('championship'))                                             return '🏴󠁧󠁢󠁥󠁮󠁧󠁿 ENG2';
  if (l.includes('premier'))                                                  return '🏴󠁧󠁢󠁥󠁮󠁧󠁿 PL';
  if (l.includes('segunda'))                                                  return '🇪🇸 ES2';
  if (l.includes('la liga') || l.includes('laliga'))                         return '🇪🇸 ES';
  if (l.includes('serie b'))                                                  return '🇮🇹 IT2';
  if (l.includes('serie a'))                                                  return '🇮🇹 IT';
  if (l.includes('2. bundesliga') || l.includes('bundesliga 2'))             return '🇩🇪 ALE2';
  if (l.includes('bundesliga') && (l.includes('austria') || l.includes('austri'))) return '🇦🇹 AUT';
  if (l.includes('bundesliga'))                                               return '🇩🇪 ALE';
  if (l.includes('ligue 2'))                                                  return '🇫🇷 FR2';
  if (l.includes('ligue'))                                                    return '🇫🇷 FR';
  if (l.includes('brasilei') || l.includes('brazil') || l.includes('brasil')) return '🇧🇷 BRA';
  if (l.includes('liga portugal') || l.includes('primeira liga'))            return '🇵🇹 LPOR';
  if (l.includes('pro league') || l.includes('belgium'))                     return '🇧🇪 BEL';
  if (l.includes('eredivisie'))                                               return '🇳🇱 ERE';
  if (l.includes('scottish'))                                                 return '🏴󠁧󠁢󠁳󠁣󠁴󠁿 SPL';
  if (l.includes('süper') || l.includes('super lig') || l.includes('turkey')) return '🇹🇷 SL';
  if (l.includes('super league') && l.includes('greece'))                    return '🇬🇷 GRE';
  if (l.includes('super league') && (l.includes('switzerland') || l.includes('swiss'))) return '🇨🇭 SUI';
  if (l.includes('austria'))                                                  return '🇦🇹 AUT';
  if (l.includes('switzerland') || l.includes('swiss'))                      return '🇨🇭 SUI';
  if (l.includes('superliga') || l.includes('denmark'))                      return '🇩🇰 DEN';
  if (l.includes('allsvenskan') || l.includes('sweden'))                     return '🇸🇪 SWE';
  if (l.includes('eliteserien') || l.includes('norway'))                     return '🇳🇴 NOR';
  if (l.includes('ekstraklasa') || l.includes('poland'))                     return '🇵🇱 POL';
  if (l.includes('czech'))                                                    return '🇨🇿 CZE';
  if (l.includes('liga 1') && l.includes('romania'))                         return '🇷🇴 ROM';
  if (l.includes('rpl') || l.includes('russia'))                             return '🇷🇺 RPL';
  if (l.includes('betplay') || l.includes('colombia'))                       return '🇨🇴 COL';
  if (l.includes('liga pro') || l.includes('ecuador'))                       return '🇪🇨 ECU';
  if (l.includes('liga 1') && l.includes('peru'))                            return '🇵🇪 PER';
  if (l.includes('futve') || l.includes('venezuela'))                        return '🇻🇪 VEN';
  if (l.includes('bolivia'))                                                  return '🇧🇴 BOL';
  if (l.includes('paraguay'))                                                 return '🇵🇾 PAR';
  if (l.includes('saudi'))                                                    return '🇸🇦 KSA';
  if (l.includes('k league') || l.includes('korea'))                         return '🇰🇷 KOR';
  if (l.includes('a-league') || l.includes('australia'))                     return '🇦🇺 AUS';
  if (l.includes('j-league') || l.includes('japan') || l.includes('jleague')) return '🇯🇵 JL';
  if (l.includes('uruguay'))                                                  return '🇺🇾 URU';
  if (l.includes('chile'))                                                    return '🇨🇱 CHI';
  if (l.includes('mls') || l.includes('usa'))                                return '🇺🇸 MLS';
  if (l.includes('liga mx') || l.includes('mexico') || l.includes('méxico')) return '🇲🇽 MX';
  if (l.includes('tenis') || l.includes('tennis') || l.includes('atp') || l.includes('wta')) return '🎾';
  if (l.includes('otras ligas') || l.includes('otras'))                      return '⚽';
  // fallback definitivo
  return '⚽';
}

// Sport keys de ligas bloqueadas — nunca deben generar picks ni aparecer en la UI
const BLOCKED_SPORT_KEYS_OPT = new Set([
  'soccer_albania_superliga', 'soccer_faroe_islands', 'soccer_andorra_primera',
  'soccer_san_marino_superleague', 'soccer_gibraltar_ifl', 'soccer_liechtenstein',
  'soccer_malta_premier_league', 'soccer_kosovo_superleague',
]);

function buildPredsFromOdds() {
  if (!window._rawOddsGames || !window._rawOddsGames.length) return null;

  // 🛡️ (25-jun-2026) SKIP partidos WC2026: las cuotas/picks WC vienen curados
  // a mano en wc-matches.js (rec, _hO, _dO, _aO, bvr, conf, probH/D/A). El
  // recalcular desde Odds API rompe los picks (ej Egipto-Irán: repo dice
  // 'Empate 3.20' pero Odds API recalcula 'Doble X2 2.74'). Los picks WC se
  // levantan desde Supabase historial_full (publicador WC ya los inyectó ahí).
  // Filtrar ligas bloqueadas antes de cualquier procesamiento
  const filteredGames = window._rawOddsGames.filter(g =>
    g.sport_key !== 'soccer_fifa_world_cup' &&  // 🆕 WC2026: usar pick del repo, no recalcular
    !BLOCKED_SPORT_KEYS_OPT.has(g.sport_key) &&
    !g.sport_key?.includes('albania') &&
    !g.sport_key?.includes('faroe') &&
    !g.sport_key?.includes('gibraltar') &&
    !g.sport_key?.includes('san_marino') &&
    !g.sport_key?.includes('liechtenstein')
  );

  const now       = Date.now();

    // ── Fútbol top ──
  const SPORT_CAT_PRIO = { soccer:40, tennis:20, rugby:10, mma:10 };

  // Prioridad por liga específica — liga más prestigiosa = número más alto
  const LEAGUE_PRIO = {
    // ── Fútbol top ──
    soccer_uefa_champs_league:              100,
    soccer_conmebol_copa_libertadores:       99,
    soccer_argentina_primera_division:       98,
    soccer_epl:                              97,
    soccer_england_premier_league:           97,
    soccer_brazil_campeonato:                96,
    soccer_conmebol_copa_sudamericana:       90,
    soccer_spain_la_liga:                    88,
    soccer_italy_serie_a:                    86,
    soccer_germany_bundesliga:               85,
    soccer_france_ligue_one:                 78,
    // ── UEFA ──
    soccer_uefa_europa_league:               76,
    soccer_uefa_europa_conference_league:    70,
    // ── Europa nivel 2 ──
    soccer_portugal_primeira_liga:           74,
    soccer_netherlands_eredivisie:           72,
    soccer_england_championship:             68,
    soccer_belgium_first_div_a:              66,  // Belgian Pro League (Odds API key)
    soccer_belgium_first_div:               66,   // alias legacy
    soccer_argentina_primera_nacional:       65,
    soccer_germany_bundesliga2:              64,
    soccer_colombia_primera_a:              63,
    soccer_scotland_premiership:             62,
    soccer_mexico_ligamx:                    62,
    soccer_spain_segunda_division:           60,
    soccer_italy_serie_b:                    58,
    soccer_turkey_super_league:              58,
    soccer_greece_super_league:              56,
    soccer_austria_football_bundesliga:      55,  // Austrian Bundesliga (Odds API key)
    soccer_austria_bundesliga:               55,  // alias legacy
    soccer_usa_mls:                          55,
    soccer_ecuador_liga_pro:                 54,  // Ecuador Liga Pro (Odds API key)
    soccer_ecuador_primera_a:                54,  // alias legacy
    soccer_switzerland_superleague:          32,  // poco comercial
    soccer_peru_primera_division:            52,
    soccer_denmark_superliga:                33,  // poco comercial
    soccer_france_ligue_two:                 51,
    soccer_chile_campeonato:                 50,
    soccer_uruguay_primera_division:         50,
    soccer_poland_ekstraklasa:               33,  // poco comercial
    soccer_sweden_allsvenskan:               31,  // poco comercial
    soccer_norway_eliteserien:               30,  // poco comercial
    soccer_paraguay_primera_division:        31,  // poco comercial
    soccer_saudi_professional_league:        27,  // poco comercial
    soccer_australia_aleague:               28,   // A-League — poco comercial
    soccer_australia_a_league:              28,   // alias legacy
    soccer_south_korea_kleague1:             29,  // poco comercial
    soccer_czech_republic_first_league:      30,  // Czech Liga — poco comercial
    soccer_czech_liga:                       30,  // alias legacy
    soccer_japan_j_league:                   29,  // poco comercial
    soccer_venezuela_primera_division:       26,  // FUTVE — poco comercial
    soccer_venezuela_primera:                26,  // alias legacy
    soccer_bolivia_primera_division:         26,  // poco comercial
    soccer_romania_liga1:                    29,  // poco comercial
    soccer_russia_premier_league:            28,  // poco comercial
    // ── Tennis ──
    tennis_atp_french_open:                  85,
    tennis_wta_french_open:                  85,
    tennis_atp_wimbledon:                    85,
  };

  const getGamePrio = k => {
    if (!k) return 0;
    // Prioridad exacta si existe, sino prio de categoría
    if (LEAGUE_PRIO[k]) return LEAGUE_PRIO[k];
    if (k.includes('soccer'))     return SPORT_CAT_PRIO.soccer;
    if (k.includes('basketball')) return 0; // basketball desactivado
    if (k.includes('tennis'))     return SPORT_CAT_PRIO.tennis;
    if (k.includes('rugby'))      return SPORT_CAT_PRIO.rugby;
    return 5;
  };

  // ── REGLA: Confianza Máxima (bvr=6) SOLO para Tier 1 + Tier 2 ──
  // Tier 1 (élite mundial) + Tier 2 (segunda capa) — el resto tope = Alta (bvr=5).
  const TOP_TIER_LEAGUES = new Set([
    // ── Tier 1 ──
    'soccer_uefa_champs_league',
    'soccer_epl', 'soccer_england_premier_league',
    'soccer_spain_la_liga',
    'soccer_italy_serie_a',
    'soccer_germany_bundesliga',
    'soccer_france_ligue_one',
    'soccer_uefa_europa_league',
    'soccer_conmebol_copa_libertadores',
    'soccer_conmebol_copa_sudamericana',
    'soccer_argentina_primera_division',
    'soccer_brazil_campeonato',
    // ── Tier 2 ──
    'soccer_uefa_europa_conference_league',
    'soccer_mexico_ligamx',
    'soccer_netherlands_eredivisie',
    'soccer_portugal_primeira_liga',
    'soccer_turkey_super_league',
    'soccer_england_championship',
    'soccer_argentina_primera_nacional',
  ]);
  const isTopTierLeague = k => TOP_TIER_LEAGUES.has(k || '');

  // 🔒 REGLA: Ligas con TOPE de 1 pick por ciclo (el mejor disponible).
  // Excepción permitida cuando aparece uno significativamente mejor.
  const LIMITED_LEAGUES = new Set([
    // ── Segundas y Latinoamérica de baja liquidez ──
    'soccer_spain_segunda_division',
    'soccer_italy_serie_b',
    'soccer_chile_campeonato',
    'soccer_paraguay_primera_division',
    'soccer_uruguay_primera_division',
    'soccer_ecuador_liga_pro', 'soccer_ecuador_primera_a',
    'soccer_peru_primera_division',
    'soccer_venezuela_primera_division', 'soccer_venezuela_primera',
    'soccer_bolivia_primera_division',
    // ── Europa nivel 2 / segundas ──
    'soccer_germany_bundesliga2',
    'soccer_france_ligue_two',
    'soccer_russia_premier_league',
    'soccer_belgium_first_div_a', 'soccer_belgium_first_div',
    // ── Ligas europeas de menor predictibilidad ──
    'soccer_scotland_premiership',
    'soccer_austria_football_bundesliga', 'soccer_austria_bundesliga',
    'soccer_switzerland_superleague',
    'soccer_denmark_superliga',
    'soccer_sweden_allsvenskan',
    'soccer_norway_eliteserien',
    'soccer_poland_ekstraklasa',
    'soccer_czech_republic_first_league', 'soccer_czech_liga',
    'soccer_romania_liga1',
    'soccer_greece_super_league',
    'soccer_south_korea_kleague1',
  ]);
  const isLimitedLeague = k => LIMITED_LEAGUES.has(k || '');

  const hasH2HData = g => g.bookmakers?.some(b => b.markets?.some(m => m.key === 'h2h'));

  // Boost de prioridad por etapa del torneo: finales/semis valen mucho más
  const STAGE_BOOST = { final: 60, semi: 35, quarter: 15, r16: 5 };
  const getEffectivePrio = g => getGamePrio(g.sport_key) + (STAGE_BOOST[g._stage] || 0);

  // Comparador: primero por prioridad efectiva (liga + etapa), luego por horario (asc)
  const sortByPrioThenTime = (a, b) => {
    const pa = getEffectivePrio(a);
    const pb = getEffectivePrio(b);
    if (pa !== pb) return pb - pa;
    return new Date(a.commence_time) - new Date(b.commence_time);
  };

  // Solo partidos que AÚN NO comenzaron — nunca recomendar partidos en vivo o ya iniciados
  // Siempre expandimos hasta mínimo 48h para capturar Champions/top-ligas de mañana
  // aunque ya haya 2+ candidatos en 24h (ej: Brasileirao hoy no debe tapar Champions mañana)
  const WINDOWS = [24, 48, 72, 120, 168];
  const TOP_PRIO_THRESHOLD = LEAGUE_PRIO.soccer_conmebol_copa_libertadores;

  let candidates = [];
  for (const hours of WINDOWS) {
    const windowEnd = now + hours * 3600000;
    const baseFilter = g => {
      const t = new Date(g.commence_time).getTime();
      return t > now && t <= windowEnd && !(g.sport_key||'').includes('basketball') && hasH2HData(g);
    };
    // Límites máximos de picks por liga (para que ligas secundarias no saturen)
    const LEAGUE_CAPS = {
      // Ligas argentinas (mucha oferta)
      soccer_argentina_primera_nacional:  5,
      soccer_argentina_primera_division:  6,
      // Europa tier 2
      soccer_england_championship:        3,
      soccer_germany_bundesliga2:         3,
      soccer_spain_segunda_division:      3,
      soccer_italy_serie_b:               2,
      soccer_france_ligue_two:            2,
      soccer_belgium_first_div_a:         3,  // Odds API key
      soccer_belgium_first_div:           3,  // legacy alias
      soccer_portugal_primeira_liga:      2,
      soccer_netherlands_eredivisie:      3,
      soccer_scotland_premiership:        2,
      soccer_turkey_super_league:         2,
      soccer_greece_super_league:         2,
      soccer_austria_football_bundesliga: 2,  // Odds API key
      soccer_austria_bundesliga:          2,  // legacy alias
      soccer_switzerland_superleague:     2,
      soccer_denmark_superliga:           2,
      soccer_sweden_allsvenskan:          2,
      soccer_norway_eliteserien:          2,
      soccer_poland_ekstraklasa:          2,
      soccer_czech_republic_first_league: 2,  // Odds API key
      soccer_czech_liga:                  2,  // legacy alias
      soccer_romania_liga1:               2,
      soccer_russia_premier_league:       2,
      // América
      soccer_mexico_ligamx:               3,
      soccer_colombia_primera_a:          3,
      soccer_ecuador_liga_pro:            2,  // Odds API key
      soccer_ecuador_primera_a:           2,  // legacy alias
      soccer_peru_primera_division:       2,
      soccer_chile_campeonato:            2,
      soccer_uruguay_primera_division:    2,
      soccer_paraguay_primera_division:   2,
      soccer_venezuela_primera_division:  2,  // Odds API key
      soccer_venezuela_primera:           2,  // legacy alias
      soccer_bolivia_primera_division:    2,
      soccer_usa_mls:                     2,
      // Asia / Oceanía
      soccer_saudi_professional_league:   2,
      soccer_japan_j_league:              2,
      soccer_south_korea_kleague1:        2,
      soccer_australia_aleague:           2,  // Odds API key
      soccer_australia_a_league:          2,  // legacy alias
    };
    const applyLeagueCaps = games => {
      const counts = {};
      return games.filter(g => {
        const sk = g.sport_key || '';
        if (!(sk in LEAGUE_CAPS)) return true;
        counts[sk] = (counts[sk] || 0) + 1;
        return counts[sk] <= LEAGUE_CAPS[sk];
      });
    };
    // Garantizar diversidad: hasta 20 de ligas top (prio≥90), hasta 25 de ligas europeas/continentales (60-89), resto
    // IMPORTANTE: el bucketing usa getEffectivePrio (liga + boost de etapa), no la prio base.
    // Así una FINAL/SEMI sube al tier top aunque su liga base sea media (ej: final Europa League).
    const topTier  = filteredGames.filter(baseFilter).filter(g => getEffectivePrio(g) >= 90)
                       .sort(sortByPrioThenTime).slice(0, 20);
    const eurTier  = applyLeagueCaps(
                       filteredGames.filter(baseFilter)
                       .filter(g => { const p = getEffectivePrio(g); return p >= 60 && p < 90; })
                       .sort(sortByPrioThenTime)).slice(0, 25);
    const rest     = applyLeagueCaps(
                       filteredGames.filter(baseFilter).filter(g => getEffectivePrio(g) < 60)
                       .sort(sortByPrioThenTime)).slice(0, 20);
    candidates = [...topTier, ...eurTier, ...rest];
    // Cortar solo si: hay 2+ candidatos Y ya cubrimos 48h (para no perder Champions/Libertadores de mañana)
    // O si el mejor candidato ya es Champions/Libertadores en 24h
    const bestPrio = candidates.length ? getEffectivePrio(candidates[0]) : 0;
    if (candidates.length >= 2 && (hours >= 48 || bestPrio >= TOP_PRIO_THRESHOLD)) break;
  }

  // Nota: el API solo devuelve partidos futuros. Los partidos ya iniciados con pick bloqueado
  // se rescatan desde _sbLockedPicks en renderPreds() donde tenemos home/away reales guardados.

  const totalRaw = filteredGames.length;
  const withH2H = filteredGames.filter(hasH2HData).length;
  const upcoming = filteredGames.filter(g => new Date(g.commence_time).getTime() > now).length;
  console.log(`[Preds] ${candidates.length} candidatos pre-partido | total:${totalRaw} withH2H:${withH2H} futuros:${upcoming}`);

  // Fallback nivel 1: sin límite de ventana pero solo partidos futuros
  if (!candidates.length) {
    console.warn('[Preds] Fallback L1: sin ventana de tiempo (posible parón internacional)');
    candidates = filteredGames
      .filter(g => new Date(g.commence_time).getTime() > now)
      .filter(hasH2HData)
      .filter(g => !g.sport_key?.includes('basketball'))  // excluir NBA
      .sort(sortByPrioThenTime)
      .slice(0, 18);
  }
  if (!candidates.length) {
    console.warn('[Preds] Fallback L2: sin filtro de tiempo — mostrando cualquier partido con h2h');
    candidates = filteredGames
      .filter(hasH2HData)
      .filter(g => !g.sport_key?.includes('basketball'))  // excluir NBA
      .sort(sortByPrioThenTime)
      .slice(0, 18);
  }
  if (!candidates.length) {
    console.warn('[Preds] Sin ningún partido con h2h en los 172 juegos — revisar bookmakers');
    return null;
  }

  // ── Cooldown: equipos que causaron pérdida en los últimos 30 días ──────────
  // Si un equipo aparece en una pérdida reciente, se omite ~1-2 jornadas (10 días).
  // Pasado ese período ya vuelve a ser elegible normalmente.
  const _COOLDOWN_DAYS   = 10;  // días de veto después de una pérdida
  const _COOLDOWN_WINDOW = 30;  // solo miramos pérdidas de los últimos 30 días
  const _cooldownTeams   = new Set(); // equipos en cooldown ahora mismo
  try {
    const _hist    = (typeof loadHistorial === 'function') ? loadHistorial() : [];
    const _nowMs   = Date.now();
    const _winMs   = _COOLDOWN_WINDOW * 86400000;
    const _cdMs    = _COOLDOWN_DAYS   * 86400000;
    _hist
      .filter(h => h.result === 'loss' && h.commenceTs && (_nowMs - h.commenceTs) <= _winMs)
      .forEach(h => {
        // Solo está en cooldown si la pérdida fue hace MENOS de _COOLDOWN_DAYS
        if ((_nowMs - h.commenceTs) > _cdMs) return;
        // Vetar SOLO al equipo que fue sujeto de la apuesta perdida (no ambos).
        // Mercados de empate / totals / btts no vetan equipos individuales.
        const _rec      = (h.rec || '').toLowerCase().trim();
        const _homeNorm = (h.home || '').toLowerCase().trim();
        const _awayNorm = (h.away || '').toLowerCase().trim();
        if (_rec === 'gana local' && _homeNorm) {
          _cooldownTeams.add(_homeNorm);
        } else if (_rec === 'gana visitante' && _awayNorm) {
          _cooldownTeams.add(_awayNorm);
        } else if (_rec.startsWith('gana ')) {
          const _team = _rec.replace(/^gana\s+/, '').trim();
          if (_homeNorm && (_homeNorm === _team || _homeNorm.includes(_team) || _team.includes(_homeNorm))) {
            _cooldownTeams.add(_homeNorm);
          } else if (_awayNorm && (_awayNorm === _team || _awayNorm.includes(_team) || _team.includes(_awayNorm))) {
            _cooldownTeams.add(_awayNorm);
          }
        }
        // Empate / Ambos Marcan / Más de X.5 → no vetar equipos
      });
    if (_cooldownTeams.size) console.log('[Preds] Cooldown activo para:', [..._cooldownTeams].join(', '));
  } catch(e) {}
  // ──────────────────────────────────────────────────────────────────────────

  return candidates.map(g => {
    try {
    // ── Bookmakers en orden de prioridad por cobertura real (h2h + totals) ──
    // Primario: onexbet (máxima cobertura), Secundario: betrivers, etc.
    const PRIMARY_BOOKS   = ['onexbet','betrivers','unibet_nl','betsson','williamhill','pinnacle'];
    const FALLBACK_BOOKS  = ['nordicbet','pmu_fr','betonlineag','lowvig','betanysports','betmgm'];
    const ALL_PRIORITY    = [...PRIMARY_BOOKS, ...FALLBACK_BOOKS];
    // Afiliados: solo para el link de apuesta, NO para cuotas
    const AFFILIATE_KEYS  = ['megapari','melbet','betwinner','dbbet','dbbet'];

    const hasH2H    = b => b.markets?.some(m => m.key === 'h2h');
    const hasTotals = b => b.markets?.some(m => m.key === 'totals');

    // Elegir bookmaker principal: el primero de la lista de prioridad que tenga h2h
    let bmMain = null;
    for (const key of ALL_PRIORITY) {
      const found = g.bookmakers.find(b => b.key === key && hasH2H(b));
      if (found) { bmMain = found; break; }
    }
    if (!bmMain) bmMain = g.bookmakers.find(b => hasH2H(b));

    // Afiliado: solo para el link de apuesta
    let bmAffiliate = null;
    for (const key of AFFILIATE_KEYS) {
      bmAffiliate = g.bookmakers.find(b => b.key === key && hasH2H(b));
      if (bmAffiliate) break;
    }
    const isAffiliate = !!bmAffiliate;

    // Cuotas h2h del bookmaker PRINCIPAL (único origen de cuotas)
    const market = bmMain?.markets?.find(m => m.key === 'h2h');
    const outs   = market?.outcomes || [];

    const homeOut = outs.find(o => o.name === g.home_team);
    const awayOut = outs.find(o => o.name === g.away_team);
    const drawOut = outs.find(o => o.name === 'Draw');

    const hO = homeOut?.price || null;
    const aO = awayOut?.price || null;
    const dO = drawOut?.price || null;
    const hOP = hO, aOP = aO, dOP = dO;

    // ── Mercados de totales y BTTS — MISMO bookmaker principal, luego fallback en orden ──
    const findMkt = mktKey => {
      // 1. Intentar desde el bookmaker principal
      const mainMkt = bmMain?.markets?.find(m => m.key === mktKey);
      if (mainMkt) return mainMkt;
      // 2. Intentar en orden de prioridad
      for (const key of ALL_PRIORITY) {
        const bk = g.bookmakers.find(b => b.key === key);
        const mkt = bk?.markets?.find(m => m.key === mktKey);
        if (mkt) return mkt;
      }
      // 3. Cualquier bookmaker (último recurso)
      for (const bk of (g.bookmakers || [])) {
        const mkt = bk.markets?.find(m => m.key === mktKey);
        if (mkt) return mkt;
      }
      return null;
    };
    const totalsMkt = findMkt('totals');

    // Over odds — fútbol: busca líneas 1.5/2.5/3.5
    const overOdds = {};
    (totalsMkt?.outcomes || []).forEach(o => {
      const pt = String(o.point);
      if (o.name === 'Over') overOdds[pt] = o.price;
    });

    // ── Probabilidades 1X2 ──
    const rawH = hOP ? 1/hOP : 0;
    const rawD = dOP ? 1/dOP : 0;
    const rawA = aOP ? 1/aOP : 0;
    const tot  = rawH + rawD + rawA || 1;
    const probH = Math.round(rawH / tot * 100);
    const probD = dOP ? Math.round(rawD / tot * 100) : 0;
    const probA = Math.round(rawA / tot * 100);

    // Probabilidades de totales fútbol
    const probOver = {};
    ['1.5','2.5','3.5'].forEach(pt => {
      if (overOdds[pt]) probOver[pt] = Math.round(100 / overOdds[pt]);
    });

    // ── Ambos Marcan (fútbol) ──
    // Solo se muestra si hay cuota REAL de la API (Pinnacle / William Hill).
    // Sin dato real → no se genera predicción BTTS.
    const bttsMkt = findMkt('btts') || findMkt('both_teams_to_score');
    let bttsOddsReal = null;
    if (bttsMkt) {
      const yes = (bttsMkt.outcomes || []).find(o => /yes|si|sí/i.test(o.name));
      if (yes) bttsOddsReal = yes.price;
    }
    // Solo cuota real — sin estimaciones
    const bttsEst = bttsOddsReal ? Math.round(100 / bttsOddsReal) : null;
    const bttsOddsEst = bttsOddsReal;
    const bttsIsEstimated = false;

    // ── Nombres cortos de equipos (necesarios para construir las recomendaciones) ──
    const hN = shortName(g.home_team), aN = shortName(g.away_team);

    // ── Selección de la MEJOR apuesta ──
    // 🆕 (23-jun-2026) Subido de 1.40 → 1.60: con 61% acierto, break-even era 1.64; cuotas <1.60 producían ROI -1.5%.
    const MIN_ODDS = 1.60;
    // Liga argentina: prohibido pronosticar overs (Más de X.5). Solo 1X2 + Ambos/No Marcan.
    const _isArgentina = (g.sport_key || '').includes('argentina');

    // 🆕 (27-may-2026) DOBLE OPORTUNIDAD (1X / X2) — captura el escenario "el favorito necesita ganar pero el empate es plausible".
    //    Caso de uso real: Cienciano vs Juventud (Sudamericana) donde Cienciano clasificaba con empate.
    //    Gates de inclusión:
    //      • Default: no hay favorito claro (probH<62 Y probA<62) Y probD>=25%
    //      • Conmebol Cup (Libertadores/Sudamericana): más permisivo — probD>=22% y no hay goleador absoluto (<70%)
    //    Cuota derivada de cuotas individuales (h*d/(h+d), aprox harmonic).
    const _isConmebolCup = ['soccer_conmebol_copa_libertadores', 'soccer_conmebol_copa_sudamericana'].includes(g.sport_key || '');
    const _hasClearFavorite = (probH >= 62 || probA >= 62);
    const _doProbDMin = _isConmebolCup ? 22 : 25;
    const _doInclude  = (!_hasClearFavorite || (_isConmebolCup && probH < 70 && probA < 70)) && (probD >= _doProbDMin);
    const prob1X = probH + probD;
    const probX2 = probA + probD;
    const odds1X = (hO > 0 && dO > 0) ? +((hO * dO) / (hO + dO)).toFixed(2) : null;
    const oddsX2 = (aO > 0 && dO > 0) ? +((aO * dO) / (aO + dO)).toFixed(2) : null;
    const MIN_DO_ODDS = 1.60;  // 🔧 (23-jun-2026) subido de 1.40 — alineado con MIN_ODDS

    const candidates2 = [
      { rec: 'Gana ' + hN, prob: probH, odds: hOP, _recSide: 'home' },
      { rec: 'Gana ' + aN, prob: probA, odds: aOP, _recSide: 'away' },
      ...(dOP ? [{ rec: 'Empate', prob: probD, odds: dOP, _recSide: 'draw' }] : []),
      // 🆕 Doble Oportunidad: solo se incluye si el gate de probabilidad pasa
      ...((_doInclude && odds1X && odds1X >= MIN_DO_ODDS) ? [{ rec: 'Doble 1X', prob: prob1X, odds: odds1X, _recSide: '1x', _isDoubleChance: true }] : []),
      ...((_doInclude && oddsX2 && oddsX2 >= MIN_DO_ODDS) ? [{ rec: 'Doble X2', prob: probX2, odds: oddsX2, _recSide: 'x2', _isDoubleChance: true }] : []),
      ...(_isArgentina ? [] : ['1.5','2.5'].filter(pt => overOdds[pt] && overOdds[pt] >= MIN_ODDS
          && (pt !== '2.5' || (probOver[pt] || 0) >= 62))
          .map(pt => ({ rec: `Más de ${pt}`, prob: probOver[pt], odds: overOdds[pt], isTotals: true, line: parseFloat(pt) }))),
      ...(bttsEst ? [{ rec: 'Ambos Marcan', prob: bttsEst, odds: bttsOddsEst, isBtts: true }] : []),
    ]
    .filter(c => c.prob > 0)
    .filter(c => c._isDoubleChance || !c.odds || parseFloat(c.odds) >= MIN_ODDS);

    candidates2.sort((a, b) => {
      if (b.prob !== a.prob) return b.prob - a.prob;
      // Tiebreaker: 1X2 puro > DobleOportunidad > totals > btts
      if (a.isTotals && !b.isTotals) return 1;
      if (!a.isTotals && b.isTotals) return -1;
      if (a.isBtts  && !b.isBtts)   return 1;
      if (!a.isBtts && b.isBtts)    return -1;
      if (a._isDoubleChance && !b._isDoubleChance) return 1;   // DO pierde vs 1X2 puro
      if (!a._isDoubleChance && b._isDoubleChance) return -1;
      return 0;
    });

    if (!candidates2.length) return null;
    let best     = candidates2[0];

    // 🆕 (27-may-2026) CUP CONTEXT OVERRIDE — para Conmebol cups en fase de grupos
    //    El worker /cup-context computa "qué equipo clasifica con empate" usando standings.
    //    Si hay match, forzamos Doble Oportunidad o Empate sobre el pick natural.
    try {
      const _cupCtx = window._cupContext || {};
      const _cupKey1 = `${g.home_team}|${g.away_team}`;
      const _cupKey2 = `${hN}|${aN}`;
      const _ovEntry = _cupCtx[_cupKey1] || _cupCtx[_cupKey2];
      if (_ovEntry && _ovEntry.prefer) {
        let _ovBest = null;
        if (_ovEntry.prefer === '1x' && odds1X && odds1X >= 1.35) {
          _ovBest = { rec: 'Doble 1X', prob: prob1X, odds: odds1X, _recSide: '1x', _isDoubleChance: true, _cupOverride: true };
        } else if (_ovEntry.prefer === 'x2' && oddsX2 && oddsX2 >= 1.35) {
          _ovBest = { rec: 'Doble X2', prob: probX2, odds: oddsX2, _recSide: 'x2', _isDoubleChance: true, _cupOverride: true };
        } else if (_ovEntry.prefer === 'empate' && dOP) {
          _ovBest = { rec: 'Empate', prob: probD, odds: dOP, _recSide: 'draw', _cupOverride: true };
        }
        if (_ovBest) {
          console.log(`[cup-ctx] Override aplicado: ${g.home_team} vs ${g.away_team} → ${_ovEntry.prefer} (${_ovEntry.reason})`);
          best = _ovBest;
        }
      }
    } catch (e) { /* override es best-effort, no rompe */ }

    // 🆕 (29-may-2026) LEAGUE CONTEXT — asimetría de motivación en ligas regulares.
    //    Si el modelo quiere apostar a favor de un equipo que 'no se juega nada' (Monza-style),
    //    descartamos ese pick y dejamos que el candidato siguiente tome el lugar.
    try {
      const _lgCtx = window._leagueContext || {};
      const _lgKey1 = `${g.home_team}|${g.away_team}`;
      const _lgKey2 = `${hN}|${aN}`;
      const _lgEntry = _lgCtx[_lgKey1] || _lgCtx[_lgKey2];
      if (_lgEntry && _lgEntry.prefer) {
        const _side = best._recSide;
        const _isHomeFavor = (_side === 'home' || _side === '1x');
        const _isAwayFavor = (_side === 'away' || _side === 'x2');
        if (_lgEntry.prefer === 'avoid_home' && _isHomeFavor) {
          console.log(`[league-ctx] Skip: ${g.home_team} vs ${g.away_team} → avoid_home (${_lgEntry.reason})`);
          // Buscar candidato alternativo que NO sea a favor del local
          const _alt = candidates2.find(c => c._recSide !== 'home' && c._recSide !== '1x' && c !== best);
          if (_alt) { best = _alt; }
          else return null; // sin alternativa razonable, descartar partido
        } else if (_lgEntry.prefer === 'avoid_away' && _isAwayFavor) {
          console.log(`[league-ctx] Skip: ${g.home_team} vs ${g.away_team} → avoid_away (${_lgEntry.reason})`);
          const _alt = candidates2.find(c => c._recSide !== 'away' && c._recSide !== 'x2' && c !== best);
          if (_alt) { best = _alt; }
          else return null;
        }
      }
    } catch (e) { /* league override best-effort */ }

    // 🆕 (23-jun-2026) EMPATE COMO PICK DE VALOR — Mauro pidió empezar a pronosticar empates.
    //    Override del best si el partido es muy parejo y empate tiene cuota con valor.
    //    Gates:
    //      • probH < 48 AND probA < 48 (ningún favorito claro)
    //      • probD >= 28 (probabilidad real de empate decente)
    //      • dOP >= 3.00 (cuota empate mínimo, característico de partidos parejos)
    //      • Valor esperado positivo: probD/100 * dOP >= 1.02 (margen >= 2%)
    //    Solo cuando best NO sea ya empate, ni override por cup-context.
    if (best._recSide !== 'draw' && !best._cupOverride && dOP && probD >= 28 && probH < 48 && probA < 48 && dOP >= 3.00) {
      const _evDraw = (probD / 100) * dOP;
      if (_evDraw >= 1.02) {
        // Sustituir best por Empate
        best = { rec: 'Empate', prob: probD, odds: dOP, _recSide: 'draw', _evOverride: true };
        console.log(`[draw-pick] Override → Empate (probD=${probD}%, dOP=${dOP}, EV=${_evDraw.toFixed(2)})`);
      }
    }

    const rec      = best.rec;
    const maxProb  = best.prob || probH;
    const bestOdds = best.odds;

    // Ligas menos conocidas: piso mínimo Alta (62%) — Media-Alta no aplica
    // Las ligas europeas secundarias (Championship, BL2, etc.) usan el piso normal (58%)
    const STRICT_CONF_LEAGUES = new Set([
      // Sudamérica secundaria
      'soccer_colombia_primera_a',
      'soccer_ecuador_liga_pro',
      'soccer_ecuador_primera_a',   // alias legacy
      'soccer_peru_primera_division',
      'soccer_venezuela_primera_division',
      'soccer_venezuela_primera',   // alias legacy
      'soccer_bolivia_primera_division',
      'soccer_paraguay_primera_division',
      // Asia / Oceanía
      'soccer_south_korea_kleague1',
      'soccer_australia_aleague',
      'soccer_australia_a_league',  // alias legacy
      // Europa periférica
      'soccer_romania_liga1',
    ]);
    const _isStrictLeague = STRICT_CONF_LEAGUES.has(g.sport_key || '');
    // Solo Libertadores y Sudamericana habilitan el tier "Media" (50-57%).
    // El resto de ligas mantiene el piso normal (58%) o estricto (62% para Sudamérica menor).
    const RELAXED_FLOOR_LEAGUES = new Set([
      'soccer_conmebol_copa_libertadores',
      'soccer_conmebol_copa_sudamericana',
    ]);
    const _isRelaxedLeague = RELAXED_FLOOR_LEAGUES.has(g.sport_key || '');
    const _minProb = _isStrictLeague ? 62 : (_isRelaxedLeague ? 50 : 55); // flex: 58 → 55 para no-Tier-1

    let conf, confLabel;
    // 📈 RECALIBRACIÓN (27-may-2026): conf=med revertido a 58% (deshace el flex 58→55).
    //    Razón: conf=med rinde -25% ROI a 14 días. Subir el floor para reducir volumen y mejorar calidad.
    //    Strict leagues: solo Alta (62+). Por debajo se descarta.
    if      (maxProb >= 62)        { conf = 'high'; confLabel = 'Alta'; }
    else if (_isStrictLeague)      { return null; } // strict: solo Alta — no se publica Media-Alta en ligas menores
    else if (maxProb >= 58)        { conf = 'med';  confLabel = 'Media-Alta'; } // ↑ era 55 (flex), volvió a 58
    else if (maxProb >= _minProb)  { conf = 'low';  confLabel = 'Media'; }
    else                           { return null; } // Debajo del piso mínimo de la liga

    // Bet Value Rating 3–6
    // Máxima (≥75%) → 6  |  Alta (62-74%) → 5  |  Media-Alta (56-61%) → 4  |  Media (50-55% o 56% strict) → 3
    // 🔒 REGLA HANDICAP (versión light): Tier 3/4/5 SOLO no puede alcanzar Máxima (rawBvr=6 → 5).
    //    Las Altas (5) y Media-Altas (4) de Tier 3+ pasan tal cual — sin handicap entero.
    // 🔒 REGLA FILTRO: bvr < 4 (Media o Baja) → descartado, sin importar tier.
    let rawBvr;
    if      (best._isDoubleChance && conf === 'high')   rawBvr = 5;   // 🆕 DO nunca alcanza Máxima
    else if (best._isDoubleChance && conf === 'med')    rawBvr = 4;
    else if (conf === 'high' && maxProb >= 75)          rawBvr = 6;
    else if (conf === 'high')                            rawBvr = 5;
    else if (conf === 'med')                             rawBvr = 4;
    else                                                  rawBvr = 3;
    const _isTopTier = isTopTierLeague(g.sport_key);
    let bvr = (_isTopTier || rawBvr < 6) ? rawBvr : 5; // solo bloquea 6 → 5 si no es Top-Tier
    if (bvr < 4) return null; // descartar Media y Baja
    const bvrText = bvr === 6 ? 'Máxima' : bvr === 5 ? 'Alta' : bvr === 4 ? 'Media-Alta' : 'Media';
    // Re-derivar conf y confLabel para que UI/insights reflejen el bvr final post-handicap
    if      (bvr === 6 || bvr === 5) conf = 'high';
    else if (bvr === 4)              conf = 'med';
    confLabel = bvrText;

    // 🔒 FILTRO POST-MORTEM (27-may-2026): "Gana Local" rinde -80% ROI con bvr<5 (1/8 en 14 días).
    //    Solo se publica si conf=high con BVR≥5. Si el mejor candidato es Gana Local y no llega, descartamos el partido.
    if (best._recSide === 'home' && bvr < 5) return null;
    // 🆕 (23-jun-2026) FILTRO POST-MORTEM extra: Gana Local con cuota < 1.60 sigue dando ROI negativo.
    //    Exigimos cuota ≥ 1.60 SIEMPRE para Gana Local (excepto si bvr=6 Máxima donde el modelo confía más).
    if (best._recSide === 'home' && parseFloat(best.odds) < 1.60 && bvr < 6) return null;

    // 🆕 (29-may-2026) PARCHE FIN-DE-TEMPORADA — protege contra "asimetría de motivación".
    //    Caso Monza vs Catanzaro (Serie B Italia, mayo): Monza ya ascendido jugaba relajado y perdió 0-2.
    //    Caso Cienciano vs Juventud (Sudamericana, mayo): Cienciano clasificaba con empate y empató.
    //    El modelo no entiende contexto de tabla. En fin de temporada hay equipos sin nada en juego
    //    + equipos jugándose la vida. Esa asimetría rompe la lectura de probabilidad pura.
    //    Mientras /league-context universal no esté listo, parche temporal por mes/liga:
    //      • Bloquear Doble Oportunidad completamente
    //      • Exigir BVR=6 (Máxima) para "Gana Local/Visitante"
    //      • Empate y Over/Under se mantienen (no dependen tanto de motivación)
    const SEASON_END_EUROPEAN = new Set([
      'soccer_italy_serie_a', 'soccer_italy_serie_b',
      'soccer_spain_la_liga', 'soccer_spain_segunda_division',
      'soccer_germany_bundesliga', 'soccer_germany_bundesliga2',
      'soccer_epl', 'soccer_england_efl_championship', 'soccer_england_league1',
      'soccer_france_ligue_one', 'soccer_france_ligue_two',
      'soccer_netherlands_eredivisie', 'soccer_belgium_first_div_a', 'soccer_belgium_first_div',
      'soccer_scotland_premiership',
      'soccer_austria_bundesliga', 'soccer_austria_football_bundesliga',
      'soccer_switzerland_superleague',
      'soccer_denmark_superliga',
      'soccer_poland_ekstraklasa',
      'soccer_czech_liga', 'soccer_czech_republic_first_league',
      'soccer_romania_liga1',
      'soccer_greece_super_league',
      'soccer_turkey_super_league',
      'soccer_portugal_primeira_liga',
    ]);
    const SEASON_END_SPRING = new Set([
      'soccer_sweden_allsvenskan',
      'soccer_norway_eliteserien',
      'soccer_russia_premier_league',
      'soccer_usa_mls',
      'soccer_south_korea_kleague1',
      'soccer_australia_aleague', 'soccer_australia_a_league',
    ]);
    const SEASON_END_SUDAMERICA = new Set([
      'soccer_argentina_primera_division',
      'soccer_brazil_campeonato', 'soccer_brazil_serie_b',
    ]);
    function _isLikelyEndOfSeason(sk, ts) {
      if (!sk || !ts) return false;
      const m = new Date(ts).getUTCMonth(); // 0=ene, 4=mayo, 5=junio, 9=oct, 10=nov
      if (SEASON_END_EUROPEAN.has(sk))    return m === 4 || m === 5;        // mayo-junio
      if (SEASON_END_SPRING.has(sk))      return m === 9 || m === 10;        // oct-nov (temp jul-nov)
      if (SEASON_END_SUDAMERICA.has(sk))  return m === 10 || m === 11;       // nov-dic
      return false;
    }
    if (_isLikelyEndOfSeason(g.sport_key, g.commence_time)) {
      // Doble Oportunidad: bloqueada — la asimetría de motivación la mata.
      if (best._isDoubleChance) return null;
      // Gana Local/Visitante: solo si BVR=6 (Máxima). Cualquier otra cosa, fuera.
      if ((best._recSide === 'home' || best._recSide === 'away') && bvr < 6) return null;
    }

    // Cuotas formateadas
    const fmtO = v => v != null ? ` (cuota ${parseFloat(v).toFixed(2)})` : '';
    const oddsPills = [];
    if (hO) oddsPills.push(`L:${hO.toFixed(2)}`);
    if (dO) oddsPills.push(`E:${dO.toFixed(2)}`);
    if (aO) oddsPills.push(`V:${aO.toFixed(2)}`);
    if (overOdds['2.5'])    oddsPills.push(`+2.5:${parseFloat(overOdds['2.5']).toFixed(2)}`);
    if (bttsOddsEst)        oddsPills.push(`AM:${bttsOddsEst.toFixed(2)}`);

    // Insight generado por probabilidades (hN/aN ya declarados arriba)
    let insight;
    if (best._isDoubleChance && best._recSide === '1x')
      insight = `Doble Oportunidad — ${hN} puede ganar o empatar (combinado: ${prob1X}%). El mercado da ${probH}% a ${hN} ganando y ${probD}% al empate. La IA cubre los dos escenarios y descarta solo la victoria de ${aN} (${probA}%). Pick conservador, especialmente cuando el contexto del torneo favorece resultados pactados.`;
    else if (best._isDoubleChance && best._recSide === 'x2')
      insight = `Doble Oportunidad — ${aN} puede ganar o empatar (combinado: ${probX2}%). El mercado da ${probA}% a ${aN} ganando y ${probD}% al empate. La IA cubre los dos escenarios y descarta solo la victoria de ${hN} (${probH}%). Pick conservador, especialmente cuando el contexto del torneo favorece resultados pactados.`;
    else if (best._recSide === 'home')
      insight = `${hN} parte como favorito con ${probH}% de probabilidad implícita según el mercado${fmtO(hO)}. ${aN} tiene ${probA}% de chances como visitante. Las cuotas reflejan ventaja clara del local — apuesta con valor en línea de 1X.`;
    else if (best._recSide === 'away')
      insight = `${aN} es favorito visitante con ${probA}% de probabilidad implícita${fmtO(aO)}. El mercado descuenta a ${hN} que solo tiene ${probH}% de chances. Valor en apostar al visitante directo.`;
    else if (best._recSide === 'draw' || rec === 'Empate')
      insight = `Partido muy equilibrado — el mercado da ${probH}% local, ${probD}% empate, ${probA}% visitante. El empate ofrece la cuota más atractiva${fmtO(dO ?? dOP)}. Partido difícil de predecir; stake bajo recomendado.`;
    else if (rec === 'Ambos Marcan')
      insight = `Estimación: ${bttsEst}% de probabilidad de que ambos equipos conviertan${fmtO(bttsOddsEst)}. El mercado de goles refleja un partido abierto — ${hN} (${probH}%) vs ${aN} (${probA}%). Buena apuesta de goles de doble vía.`;
    else {
      const line = best.line;
      // Más de X.5 fútbol
      const pOver = probOver[String(line)];
      insight = `El mercado asigna ${pOver}% de probabilidad a que el partido supere los ${line} goles${fmtO(overOdds[String(line)])}. Partido con perfil ofensivo — ${hN} (${probH}% favorito) vs ${aN} (${probA}%). Apuesta de totales con valor.`;
    }

    const pred = {
      league:  sportKeyToLeague(g.sport_key, g.home_team, g.away_team) || leagueLabel(g.sport_title) || null,
      home:    hN,
      away:    aN,
      homeRaw: g.home_team,
      awayRaw: g.away_team,
      rec,
      _recSide: best._recSide || null,
      conf,
      confLabel,
      probH,
      probD,
      probA,
      odds:    oddsPills,
      time:        matchTime(g.commence_time),
      commenceTs:  new Date(g.commence_time).getTime(),
      insight,
      bvr,
      bvrText,
      formH:   null,
      formA:   null,
      _hO: hO, _dO: dO, _aO: aO,
      _bestOdds: bestOdds,
      _bttsEst: !!(best.isBtts && bttsIsEstimated),
      _bookKey:   isAffiliate ? bmUsed?.key   : null,
      _bookLabel: isAffiliate ? bmUsed?.title : null,
      _sportKey:  g.sport_key || '',
      _stage:     g._stage || null,   // 'final' | 'semi' | 'quarter' | 'r16' | null
      _round:     g._round || null,   // string original del round (API-Football)
      _confLocked: true, // conf y bvr quedan bloqueados desde la primera asignación
    };

    // ── Filtro cooldown: omitir si algún equipo tiene veto activo ──
    // Excepción: picks ya bloqueados globalmente son inmutables (no se tocan)
    if (!window._sbLockedPicks?.[ _matchKeyLP(hN, aN)]) {
      const _hNorm = hN.toLowerCase().trim();
      const _aNorm = aN.toLowerCase().trim();
      const _inCooldown = _cooldownTeams.has(_hNorm) || _cooldownTeams.has(_aNorm);
      if (_inCooldown) {
        console.log(`[Preds] Cooldown — omitiendo: ${hN} vs ${aN}`);
        return null;
      }
    }

    return pred;
    } catch(e) {
      console.error('[buildPredsFromOdds] Error en partido:', g?.home_team, 'vs', g?.away_team, e.message);
      window._lastPredsError = (window._lastPredsError || '') + `\n${g?.home_team} vs ${g?.away_team}: ${e.message}`;
      return null;
    }
  }).filter(Boolean);
}

// ── Traductor de estados de match (ESPN/TSDB devuelven en inglés) ──
function _translateMatchState(s) {
  if (!s || typeof s !== 'string') return s;
  const map = {
    'Match Suspended': 'Suspendido',
    'Suspended':       'Suspendido',
    'Abandoned':       'Abandonado',
    'Postponed':       'Pospuesto',
    'Cancelled':       'Cancelado',
    'Canceled':        'Cancelado',
    'Walkover':        'W.O.',
    'Forfeit':         'W.O.',
    'Awarded':         'Adjudicado',
  };
  // Match exacto primero
  if (map[s]) return map[s];
  // Match case-insensitive como fallback
  const lower = s.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (lower === k.toLowerCase()) return v;
  }
  return s;
}

// ─── Gambeta 1.1 (29-jun-2026 #571): Hero PRO live stats ───
// Alimenta los 4 KPIs del hero estilo red social/app.
function _updateHeroProStats() {
  try {
    var hist = (typeof loadHistorial === 'function') ? loadHistorial() : [];
    if (!Array.isArray(hist)) hist = [];
    var preds = window._aiPreds || [];
    var now = Date.now();
    var DAY = 24 * 3600 * 1000;

    // KPI 1: picks hoy (commenceTs entre 00:00 y 23:59 de hoy ART)
    // #622: bug previo sólo miraba preds; ahora une preds+hist con dedup.
    // #623: dedup robusto por home|away|fecha-día normalizado (no por id, que
    // puede diferir entre cache pendiente y hist resuelto).
    var todayStart = new Date(); todayStart.setHours(0,0,0,0);
    var todayEnd   = new Date(); todayEnd.setHours(23,59,59,999);
    var todayStartMs = todayStart.getTime(), todayEndMs = todayEnd.getTime();
    function _normTeamKey(s) {
      return String(s||'').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // sacar tildes
        .replace(/[^a-z0-9]/g,''); // sólo alfanumérico
    }
    var hoySeen = new Set();
    var picksHoyCount = 0;
    var todayAll = preds.concat(hist || []);
    for (var hi = 0; hi < todayAll.length; hi++) {
      var hp = todayAll[hi];
      if (!hp || !hp.commenceTs) continue;
      if (hp.commenceTs < todayStartMs || hp.commenceTs > todayEndMs) continue;
      // Key: home+away normalizados + día YYYY-MM-DD (ignora hora exacta)
      var hpDate = new Date(hp.commenceTs);
      var dayKey = hpDate.getFullYear() + '-' + (hpDate.getMonth()+1) + '-' + hpDate.getDate();
      var hk = _normTeamKey(hp.home) + '|' + _normTeamKey(hp.away) + '|' + dayKey;
      if (hoySeen.has(hk)) continue;
      hoySeen.add(hk);
      picksHoyCount++;
    }
    var elHoy = document.getElementById('gbStatHoy');
    if (elHoy) elHoy.textContent = picksHoyCount > 0 ? picksHoyCount : '–';

    // KPI 2: acierto últimos 30 días
    var ago30 = now - 30 * DAY;
    var resolved30 = hist.filter(function(h){
      var ts = h && (h.commenceTs || (h.date ? new Date(h.date).getTime() : 0));
      return ts >= ago30 && (h.result === 'win' || h.result === 'loss');
    });
    var wins30 = resolved30.filter(function(h){ return h.result === 'win'; }).length;
    var totalRes30 = resolved30.length;
    var elAc = document.getElementById('gbStatAcierto');
    if (elAc) {
      if (totalRes30 >= 3) {
        var pct = Math.round(wins30 / totalRes30 * 100);
        elAc.textContent = pct + '%';
      } else {
        elAc.textContent = '–';
      }
    }

    // KPI 3: en vivo ahora — combinar _aiPreds + hist (cobertura amplia)
    // Bug previo: solo miraba _aiPreds. Si pick estaba solo en hist (como WC2026
    // recien terminado/en juego) marcaba 0. Ahora une ambos y dedup por id+home+away.
    var liveCount = 0;
    if (typeof _isPickLive === 'function') {
      var seen = new Set();
      var allCandidates = preds.concat(hist || []);
      for (var i = 0; i < allCandidates.length; i++) {
        var p = allCandidates[i];
        if (!p) continue;
        var key = (p.id || '') + '|' + (p.home || '') + '|' + (p.away || '');
        if (seen.has(key)) continue;
        seen.add(key);
        // Heuristica extendida: si commenceTs entre -15min (recien empieza) y +160min (fin + delay APF)
        // y todavia es pending, contarlo como live
        var lv = _isPickLive(p);
        if (lv) { liveCount++; continue; }
        // Fallback ampliado para WC con timestamps raros: si pending + age 0-160min, considerar live
        if (p && (!p.result || p.result === 'pending') && p.commenceTs) {
          var age = Date.now() - p.commenceTs;
          if (age >= -15 * 60 * 1000 && age <= 130 * 60 * 1000) {
            liveCount++;
          }
        }
      }
    }
    var elLiveNum = document.getElementById('gbStatLiveNum');
    if (elLiveNum) elLiveNum.textContent = liveCount;
    var liveCard = document.getElementById('gbStatLiveCard');
    if (liveCard) liveCard.setAttribute('data-active', liveCount > 0 ? '1' : '0');

    // KPI 4: total picks (mantener compat con heroStatPicks viejo)
    // Si _updateHeroStatsPicks ya corrió, este nodo tiene el valor —
    // si no, mostrar guion.
    var elTotal = document.getElementById('heroStatPicks');
    if (elTotal && (elTotal.textContent === '–' || elTotal.textContent === '')) {
      var totalCount = hist.length || preds.length;
      if (totalCount > 500) elTotal.textContent = '+' + Math.round(totalCount / 100) * 100;
      else if (totalCount > 0) elTotal.textContent = totalCount;
    }
  } catch(_e) {
    console.warn('[_updateHeroProStats]', _e);
  }
}

// Auto-refresh cada 30s + en eventos clave
(function(){
  if (typeof window === 'undefined') return;
  // Initial run after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){
      setTimeout(_updateHeroProStats, 800);
    });
  } else {
    setTimeout(_updateHeroProStats, 800);
  }
  // Refresh periódico
  setInterval(_updateHeroProStats, 10000); // refresh cada 10s (#574)
})();

// ─── Gambeta 1.1 (#573): Self-healing resolver ───
// Si vemos un pick pending cuyo partido terminó hace >100min, llamamos al
// endpoint /admin/resolve-pick UNA VEZ por sesión por id. El worker resuelve
// inmediatamente y la próxima visita ve el resultado.
(function(){
  if (typeof window === 'undefined') return;
  window._gambetaSelfHeal = window._gambetaSelfHeal || { tried: new Set() };
  window._maybeSelfHealResolve = function(pick) {
    try {
      if (!pick || !pick.id) return;
      if (pick.result && pick.result !== 'pending') return;
      if (!pick.commenceTs) return;
      const age = Date.now() - pick.commenceTs;
      // Solo si el partido lleva >100 min y <24h (después es void)
      if (age < 100 * 60 * 1000 || age > 24 * 3600 * 1000) return;
      if (window._gambetaSelfHeal.tried.has(pick.id)) return;
      window._gambetaSelfHeal.tried.add(pick.id);
      const URL = 'https://apuestas-api.mauro-union10.workers.dev/admin/resolve-pick?id=' + encodeURIComponent(pick.id);
      fetch(URL).then(function(r){ return r.json().catch(function(){return null;}); }).then(function(j){
        if (j && j.ok && j.pick && j.pick.result) {
          console.log('[self-heal] resolved', pick.id, '→', j.pick.result, j.pick.finalScore);
          // Force re-fetch del historial en el próximo render
          try { localStorage.removeItem('gb_sb_historial_v1'); } catch(_){}
        } else {
          console.log('[self-heal] not yet', pick.id, j && j.status);
        }
      }).catch(function(e){ console.warn('[self-heal] fetch err', e); });
    } catch(_) {}
  };
})();

// ─── Gambeta 1.1 (29-jun-2026 #570): Helper EN VIVO ───
// Resuelve si un pick está EN VIVO usando 2 fuentes:
//   1) scoresData con flag='live' (autoritativo del API)
//   2) Fallback temporal estricto: kickoff <= now AND kickoff > now - 2.5h
// Excluye picks ya resueltos (win/loss/void) o "stale" (kickoff pasó hace mucho).
function _isPickLive(p) {
  try {
    if (!p) return null;
    // 1) Excluir picks resueltos
    if (p._histResult === 'win' || p._histResult === 'loss' || p._histResult === 'void') return null;
    if (p.result === 'win' || p.result === 'loss' || p.result === 'void') return null;
    // 🆕 #590 Excluir explícitamente picks con marcador final guardado
    if (p.finalScore && /^\d+-\d+$/.test(p.finalScore)) return null;
    if (p._histScore && /^\d+-\d+$/.test(p._histScore)) return null;

    // 2) scoresData autoritativo — PRIMERO chequear si el partido YA TERMINÓ
    if (typeof scoresData !== 'undefined' && Array.isArray(scoresData) && typeof teamsMatch === 'function') {
      // 🆕 #590 Si scoresData dice flag='final' → terminado, NO es live
      const lfinal = scoresData.find(function(s){
        return s && s.flag === 'final' &&
          (teamsMatch(s.home, p.home) || teamsMatch(s.homeRaw||s.home, p.home)) &&
          (teamsMatch(s.away, p.away) || teamsMatch(s.awayRaw||s.away, p.away));
      });
      if (lfinal) return null;

      // Si scoresData dice flag='live' → está en vivo confirmado
      const le = scoresData.find(function(s){
        return s && s.flag === 'live' &&
          (teamsMatch(s.home, p.home) || teamsMatch(s.homeRaw||s.home, p.home)) &&
          (teamsMatch(s.away, p.away) || teamsMatch(s.awayRaw||s.away, p.away));
      });
      if (le) {
        var minute = '';
        if (le.time && typeof le.time === 'string') {
          minute = le.time.replace(/[^0-9]/g, '');
          if (minute) minute = minute + "'";
        }
        if (!minute && p.commenceTs) {
          var m = Math.floor((Date.now() - p.commenceTs) / 60000);
          if (m >= 0 && m <= 120) minute = m + "'";
        }
        return {
          live: true,
          scoreH: (le.scoreH != null ? le.scoreH : 0),
          scoreA: (le.scoreA != null ? le.scoreA : 0),
          minute: minute || 'LIVE',
          source: 'api'
        };
      }
    }

    // 3) Fallback temporal MÁS ESTRICTO: solo si elapsed entre 0 y 105 min (#590)
    //    Antes eran 2.5h (150 min) — eso traía picks ya terminados.
    //    Un partido dura 90' + ~10' descuento + 5' margen = 105 min cap.
    if (p.commenceTs) {
      var now = Date.now();
      var elapsed = now - p.commenceTs;
      // 🆕 #592 Fallback temporal con 2 capas (cubre descuentos + entretiempo + prórroga):
      //   0-130 min: cap normal (90' + 10' desc1 + 15' entretiempo + 15' desc2 = 130min)
      //   130-180 min: aún live si no hay marcador final guardado (cubre prórroga + penales)
      //   > 180 min: definitivamente terminado, trigger self-heal
      if (elapsed >= 0 && elapsed <= 130 * 60 * 1000) {
        var mins = Math.min(Math.floor(elapsed / 60000), 95);
        return {
          live: true,
          scoreH: null,
          scoreA: null,
          minute: mins + "'",
          source: 'fallback'
        };
      }
      // Zona "posible prórroga": 130-180 min. Solo si no se detectó cierre.
      if (elapsed > 130 * 60 * 1000 && elapsed <= 180 * 60 * 1000) {
        // Para esta ventana, ser un poco más estrictos: no asumir live por defecto
        // si lleva más de 150 min y no tenemos scoresData. Damos margen porque
        // partidos de eliminación directa SÍ pueden durar más.
        if (elapsed <= 150 * 60 * 1000) {
          // Hasta 150 min: aún consideramos live por descuento + prórroga corta
          return {
            live: true,
            scoreH: null,
            scoreA: null,
            minute: '90+',
            source: 'fallback-extended'
          };
        }
        // 150-180 min: zona ambigua. Trigger self-heal para forzar resolución
        if (typeof window._maybeSelfHealResolve === 'function') {
          try { window._maybeSelfHealResolve(p); } catch(_){}
        }
        // No considerar live por defecto
        return null;
      }
      // > 180 min: definitivamente terminado, trigger self-heal
      if (elapsed > 180 * 60 * 1000 && typeof window._maybeSelfHealResolve === 'function') {
        try { window._maybeSelfHealResolve(p); } catch(_){}
      }
    }

    return null;
  } catch(_) { return null; }
}

// 🆕 #579 — Variantes rotativas determinísticas por pick (no repetir frase entre picks).
//  Hash simple del seed → idx en options. Mismo pick → mismo bullet siempre.
//  Distintos picks → distintas variantes.
function _gbPickVariant(seed, options) {
  if (!options || !options.length) return '';
  var s = String(seed || '');
  var h = 0;
  for (var i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return options[Math.abs(h) % options.length];
}

// ─── Gambeta 1.1 (29-jun-2026 #569): Panel "Razonamiento de la IA" ───
// Plantillas inteligentes que rellenan 5 bullets con datos reales del pick.
// Diferenciador frente a competencia. NO toca SEO, solo agrega UI.
function _buildIAReasoning(p) {
  try {
    if (!p) return '';
    // Solo en picks pending/upcoming (no resueltos, no iniciados)
    if (p.result === 'win' || p.result === 'loss' || p.result === 'void') return '';
    if (p._started) return '';

    const _side = (typeof _recSideOf === 'function') ? _recSideOf(p) : null;
    const _rec  = String(p.rec || '').toLowerCase();
    const _bvr  = Number(p.bvr) || 4;
    const _conf = p.conf || 'med';
    const bullets = [];

    // 🆕 #576 — Solo bullets ALENTADORES. No duplicar % probabilidad (ya está en barras).
    // Calculamos modelProb solo para detectar value, NO lo mostramos al usuario.
    let modelProb = null;
    if (_side === 'home' && p.probH) modelProb = Math.round(p.probH);
    else if (_side === 'away' && p.probA) modelProb = Math.round(p.probA);
    else if (_side === 'draw' && p.probD) modelProb = Math.round(p.probD);

    // 🆕 #579 — Bullets con VARIANTES rotativas (no repetir entre picks)
    const _seed = (p.id || (p.home + '|' + p.away + '|' + (p.commenceTs || '')));

    // 1) CUOTA GENEROSA vs mercado
    const _odds = parseFloat(p._bestOdds || p.odds || 0);
    if (_odds && _odds > 1 && modelProb) {
      const impliedProb = Math.round(100 / _odds);
      const diff = modelProb - impliedProb;
      if (diff >= 8) {
        bullets.push(_gbPickVariant(_seed + 'cuota', [
          '💰 <b>Cuota generosa</b> para lo probable que es',
          '💰 <b>La casa paga más</b> de lo que el modelo estima',
          '💰 <b>Cuota inflada</b>: el mercado se quedó corto',
          '💰 <b>Buena oportunidad de cuota</b> en esta jugada',
          '💰 <b>Cuota por encima</b> de lo que merece este partido'
        ]));
      } else if (diff >= 4) {
        bullets.push(_gbPickVariant(_seed + 'cuotaedge', [
          '📈 <b>Cuota a favor</b> según el modelo',
          '📈 <b>Ligero plus</b> en la cuota vs el mercado',
          '📈 <b>Cuota correcta con margen extra</b>',
          '📈 <b>La línea favorece</b> ligeramente al modelo'
        ]));
      }
    }

    // 2) FORMA RECIENTE
    const _formStr = _side === 'home' ? String(p.formH || '') : _side === 'away' ? String(p.formA || '') : '';
    if (_formStr) {
      const wins = (_formStr.match(/W/gi) || []).length;
      const total = _formStr.length;
      if (wins >= 4 && total >= 5) {
        const _prefix = _gbPickVariant(_seed + 'racha', [
          '🔥 <b>En racha</b>',
          '🔥 <b>Llegan calientes</b>',
          '🔥 <b>Buen tramo</b>',
          '🔥 <b>Vienen finos</b>',
          '🔥 <b>Forma TOP</b>'
        ]);
        bullets.push(_prefix + ': ' + wins + ' victorias en los últimos ' + total);
      } else if (wins >= 3 && total >= 5) {
        const _prefix = _gbPickVariant(_seed + 'buenmom', [
          '📊 <b>Buen momento</b>',
          '📊 <b>Andan sólidos</b>',
          '📊 <b>Resultados a favor</b>',
          '📊 <b>Pasan por una buena</b>'
        ]);
        bullets.push(_prefix + ': ' + wins + ' triunfos recientes');
      }
    }

    // 3) FAVORITISMO
    if (modelProb && modelProb >= 65) {
      bullets.push(_gbPickVariant(_seed + 'fav', [
        '✅ <b>Favorito claro</b> según el modelo',
        '✅ <b>Lo ven amplio favorito</b>',
        '✅ <b>El más probable por amplitud</b>',
        '✅ <b>Sale como favorito firme</b>',
        '✅ <b>Bien arriba en las probabilidades</b>'
      ]));
    } else if (modelProb && modelProb >= 55 && _odds && _odds >= 1.6) {
      bullets.push(_gbPickVariant(_seed + 'prob', [
        '🎯 <b>El escenario más probable</b> y la cuota lo paga',
        '🎯 <b>Bien posicionado</b> con una cuota interesante',
        '🎯 <b>Favorito moderado</b>, pero la cuota lo justifica',
        '🎯 <b>Mejor opción del partido</b> según el modelo'
      ]));
    }

    // 4) CONTEXTO LIGA / TORNEO — variantes
    const liga = String(p.league || '');
    if (/mundial|world cup|fifa/i.test(liga)) {
      bullets.push(_gbPickVariant(_seed + 'wc', [
        '🏆 <b>Mundial 2026</b>: máximo nivel de exigencia',
        '🏆 <b>Mundial 2026</b>: cada partido es una final',
        '🏆 <b>Mundial</b>: todos quieren mostrarse en la vidriera',
        '🏆 <b>Mundial 2026</b>: presión histórica para los equipos',
        '🏆 <b>Mundial</b>: el escenario más prestigioso del fútbol',
        '🏆 <b>Mundial 2026</b>: nadie se guarda nada en este torneo'
      ]));
    } else if (/libertadores|sudamericana/i.test(liga)) {
      bullets.push(_gbPickVariant(_seed + 'cop', [
        '🌎 <b>Copa internacional</b>: partido de alto interés',
        '🌎 <b>Copa</b>: nadie quiere quedarse afuera',
        '🌎 <b>Copa</b>: las cuotas suelen tener valor por la presión',
        '🌎 <b>Copa internacional</b>: contexto que cambia el partido',
        '🌎 <b>Cruces internacionales</b>: alta intensidad asegurada'
      ]));
    } else if (/champions|europa.league|conference/i.test(liga)) {
      bullets.push(_gbPickVariant(_seed + 'euu', [
        '⭐ <b>Europa</b>: torneo de nivel top',
        '⭐ <b>Competencia europea</b>: lo mejor del continente',
        '⭐ <b>Europa</b>: equipos en su mejor versión',
        '⭐ <b>Cruce europeo</b>: data muy profunda del modelo'
      ]));
    } else if (/premier|liga.*españ|serie a|bundesliga|ligue.*1/i.test(liga)) {
      bullets.push(_gbPickVariant(_seed + 'top5', [
        '📺 <b>Liga top de Europa</b>: data sólida del modelo',
        '📺 <b>Una de las grandes ligas</b>: cobertura completa',
        '📺 <b>Liga de elite</b>: estadísticas profundas y estables',
        '📺 <b>Liga top mundial</b>: ritmo y nivel parejo'
      ]));
    } else if (/argentina|brasil|méxic|colomb|chile|perú|ecuador|uruguay/i.test(liga)) {
      bullets.push(_gbPickVariant(_seed + 'sa', [
        '🇦🇷 <b>Liga sudamericana</b>: cobertura completa del modelo',
        '🇦🇷 <b>Fútbol sudamericano</b>: contexto que conocemos a fondo',
        '🇦🇷 <b>Liga local</b>: data abundante para el modelo',
        '🇦🇷 <b>Sudamérica</b>: especialidad de la casa'
      ]));
    }

    // 5) MERCADO/TIPO — variantes por mercado
    if (/over 2\.5|m[aá]s de 2\.5/i.test(_rec)) {
      bullets.push(_gbPickVariant(_seed + 'ov25', [
        '⚽ <b>Suelen jugar partidos abiertos</b>: tendencia goleadora',
        '⚽ <b>Partido con goles</b> según el patrón reciente',
        '⚽ <b>Promedio alto de goles</b> en partidos de estos rivales',
        '⚽ <b>Ataques sueltos</b>: pinta para que caigan varios'
      ]));
    } else if (/over 1\.5|m[aá]s de 1\.5/i.test(_rec)) {
      bullets.push(_gbPickVariant(_seed + 'ov15', [
        '⚽ <b>Casi siempre cae más de 1 gol</b> en este tipo de partido',
        '⚽ <b>Línea cómoda</b>: 2 o más goles es lo habitual aquí',
        '⚽ <b>Mercado conservador</b>: el over 1.5 se suele cumplir'
      ]));
    } else if (/under|menos de/i.test(_rec)) {
      bullets.push(_gbPickVariant(_seed + 'un', [
        '🛡️ <b>Suelen ser partidos cerrados</b>: defensas firmes',
        '🛡️ <b>Poco gol esperado</b>: ambos defienden bien',
        '🛡️ <b>Trámite trabado</b>: el promedio de goles es bajo',
        '🛡️ <b>Defensas sobre los ataques</b>: tendencia clara'
      ]));
    } else if (/btts|ambos.*marcan/i.test(_rec)) {
      bullets.push(_gbPickVariant(_seed + 'btts', [
        '🎯 <b>Los dos llegan al arco</b>: ambos suelen marcar',
        '🎯 <b>Defensas vulnerables</b>: pinta para que ambos conviertan',
        '🎯 <b>Patrón ofensivo</b> en los dos equipos',
        '🎯 <b>Ambos marcan habitualmente</b> en sus últimos partidos'
      ]));
    } else if (/doble oportunidad|^1x|x2/i.test(_rec)) {
      bullets.push(_gbPickVariant(_seed + 'do', [
        '⚖️ <b>Dos escenarios a favor</b> con la misma cuota',
        '⚖️ <b>Doble cobertura</b>: ganar o empatar, ambos pagan',
        '⚖️ <b>Apuesta más segura</b> con dos posibles ganancias',
        '⚖️ <b>Cobertura doble</b>: solo perdés en un escenario'
      ]));
    } else if (/^empate/i.test(_rec)) {
      bullets.push(_gbPickVariant(_seed + 'x', [
        '⚖️ <b>Fuerzas parejas</b>: la cuota del empate paga bien',
        '⚖️ <b>Cuota interesante</b> en un partido sin favorito claro',
        '⚖️ <b>Partido cerrado esperado</b>: empate con buen pago'
      ]));
    }

    // 6) CONVICCIÓN DEL MODELO — variantes
    if (_bvr >= 6) {
      bullets.push(_gbPickVariant(_seed + 'top', [
        '💎 <b>Pick destacado del día</b>',
        '💎 <b>El mejor pick que ve la IA hoy</b>',
        '💎 <b>Top del día</b> según el modelo',
        '💎 <b>Pick estrella</b> del análisis'
      ]));
    } else if (_bvr >= 5 || _conf === 'high') {
      bullets.push(_gbPickVariant(_seed + 'fav2', [
        '💎 <b>Uno de los favoritos del día</b>',
        '💎 <b>Bien posicionado en el ranking</b> del modelo',
        '💎 <b>Pick recomendado</b> en el análisis',
        '💎 <b>De los más sólidos</b> entre los picks de hoy'
      ]));
    }

    if (bullets.length < 3) return '';
    const top5 = bullets.slice(0, 5);

    // Barra de confianza (modelo o derivado del conf/bvr)
    const confVal = modelProb || (_conf === 'high' ? 75 : _conf === 'med' ? 62 : 50);

    return ''
      + '<div class="ia-reasoning" data-bvr="' + _bvr + '">'
      +   '<div class="ia-reasoning-header">'
      +     '<span class="ia-pulse" aria-hidden="true"></span>'
      +     '<span class="ia-label">Razonamiento de la IA</span>'
      +   '</div>'
      +   '<div class="ia-reasoning-bullets">'
      +     top5.map(function(b){ return '<div class="ia-bullet">' + b + '</div>'; }).join('')
      +   '</div>'
      +   '<div class="ia-conf-row">'
      +     '<div class="ia-conf-bar"><div class="ia-conf-fill" style="width:' + confVal + '%"></div></div>'
      +     '<div class="ia-conf-val">' + confVal + '%</div>'
      +   '</div>'
      + '</div>';
  } catch (e) {
    console.warn('[_buildIAReasoning]', e);
    return '';
  }
}

function renderPreds() {
  // Reset logo miss tracker para este render
  window._logoMisses = new Set();

  // ── isLimitedLeague: replicada acá porque buildPredsFromOdds define su propia copia local ──
  // Mantener sincronizada con la de buildPredsFromOdds (~línea 9270)
  const LIMITED_LEAGUES = new Set([
    'soccer_spain_segunda_division',
    'soccer_italy_serie_b',
    'soccer_chile_campeonato',
    'soccer_paraguay_primera_division',
    'soccer_uruguay_primera_division',
    'soccer_ecuador_liga_pro', 'soccer_ecuador_primera_a',
    'soccer_peru_primera_division',
    'soccer_venezuela_primera_division', 'soccer_venezuela_primera',
    'soccer_bolivia_primera_division',
    'soccer_germany_bundesliga2',
    'soccer_france_ligue_two',
    'soccer_russia_premier_league',
    'soccer_belgium_first_div_a', 'soccer_belgium_first_div',
    'soccer_scotland_premiership',
    'soccer_austria_football_bundesliga', 'soccer_austria_bundesliga',
    'soccer_switzerland_superleague',
    'soccer_denmark_superliga',
    'soccer_sweden_allsvenskan',
    'soccer_norway_eliteserien',
    'soccer_poland_ekstraklasa',
    'soccer_czech_republic_first_league', 'soccer_czech_liga',
    'soccer_romania_liga1',
    'soccer_greece_super_league',
    'soccer_south_korea_kleague1',
  ]);
  const isLimitedLeague = k => LIMITED_LEAGUES.has(k || '');

  function formDots(arr) {
    return (arr||[]).map(r => {
      const cls = r==='G'||r==='W' ? 'g' : r==='E'||r==='D' ? 'e' : 'p';
      const lbl = r==='G'||r==='W' ? 'G' : r==='E'||r==='D' ? 'E' : 'P';
      return `<div class="pred-fdot ${cls}">${lbl}</div>`;
    }).join('');
  }

  // ── Caché diaria de picks ──
  // Una vez generados los picks del día, no cambian hasta las 6am del día siguiente
  const DAILY_PREDS_KEY = 'gambeta_daily_preds_v15'; // v15: regenerar — descarta caché contaminada con odds stale (sin _stage)
  const DAILY_PREDS_RESET_HOUR = 6; // 6am

  function getDailyPredsCacheDate() {
    const now = new Date();
    // Si es antes de las 6am, el "día de picks" sigue siendo el anterior
    if (now.getHours() < DAILY_PREDS_RESET_HOUR) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      return yesterday.toISOString().slice(0, 10);
    }
    return now.toISOString().slice(0, 10);
  }

  function loadDailyPredsCache() {
    try {
      const raw = localStorage.getItem(DAILY_PREDS_KEY);
      if (!raw) return null;
      const { date, preds } = JSON.parse(raw);
      if (date !== getDailyPredsCacheDate()) return null; // caducó
      if (!preds || !preds.length) return null;
      // 🔧 Saneo: si por bug histórico home/away quedó como URL, re-resolver desde Raw
      let _fixed = 0;
      preds.forEach(p => {
        if (typeof p.home === 'string' && /^https?:|wikimedia\.org/i.test(p.home) && p.homeRaw) {
          p.home = (typeof shortName === 'function') ? shortName(p.homeRaw) : p.homeRaw;
          _fixed++;
        }
        if (typeof p.away === 'string' && /^https?:|wikimedia\.org/i.test(p.away) && p.awayRaw) {
          p.away = (typeof shortName === 'function') ? shortName(p.awayRaw) : p.awayRaw;
          _fixed++;
        }
      });
      if (_fixed) {
        console.log('[loadDailyPredsCache] Saneo de nombres URL→texto:', _fixed);
        try { localStorage.setItem(DAILY_PREDS_KEY, JSON.stringify({ date, preds })); } catch(_) {}
      }
      return preds;
    } catch(_) { return null; }
  }

  function saveDailyPredsCache(preds) {
    try {
      localStorage.setItem(DAILY_PREDS_KEY, JSON.stringify({
        date: getDailyPredsCacheDate(),
        preds
      }));
    } catch(_) {}
  }

  // Usar datos reales si están disponibles, sino los estáticos
  let realPreds = null;

  // 1. Intentar cargar desde caché diaria — SOLO si los datos de odds aún no cargaron.
  // Cuando _rawOddsGames está disponible, siempre recalcular para reflejar cuotas actuales (BTTS real, etc.)
  const _cachedPreds = loadDailyPredsCache(); // siempre leer caché para preservar conf bloqueadas
  realPreds = (window._rawOddsGames && window._rawOddsGames.length) ? null : _cachedPreds;

  // 🏆 FALLBACK MUNDIAL: si no llegan odds Mundial vía Odds API (frecuente porque The Odds API no devuelve WC2026),
  // levantar los picks Mundial pending desde el historial Supabase y agregarlos como fichas.
  if (Array.isArray(window._sbHist) && window._sbHist.length) {
    const _wcPendings = window._sbHist.filter(p =>
      p &&
      (p._sportKey === 'soccer_fifa_world_cup' || (p.league||'').includes('Mundial')) &&
      (!p.result || p.result === 'pending') &&
      p.commenceTs && p.commenceTs > Date.now() - 4*60*60*1000  // que no haya terminado hace más de 4h
    );
    if (_wcPendings.length) {
      // Mergear evitando duplicados por id o por (home+away+date)
      const existingIds = new Set((realPreds||[]).map(p => p.id).filter(Boolean));
      const existingKeys = new Set((realPreds||[]).map(p => (p.home||'')+'|'+(p.away||'')+'|'+(p.date||'').slice(0,10)));
      const toAdd = _wcPendings.filter(p => {
        if (p.id && existingIds.has(p.id)) return false;
        const k = (p.home||'')+'|'+(p.away||'')+'|'+(p.date||'').slice(0,10);
        return !existingKeys.has(k);
      });
      if (toAdd.length) {
        realPreds = [...toAdd, ...(realPreds||[])];
        console.log('[WC fallback] Agregados', toAdd.length, 'picks Mundial pending desde el historial Supabase como fichas');
      }
    }
  }

  // Guardar partidos ya iniciados ANTES de cualquier invalidación para no perderlos
  const _nowMs = Date.now();
  const _BKEYS_PS = ['soccer_chile_campeonato', 'soccer_portugal_primeira_liga'];
  const _normPS = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
  const _BTEAMS_PS = ['palestino','ucatolica','universidadcatolica','universidadcat'];
  const _preserveStarted = ((_cachedPreds || realPreds) || []).filter(p => {
    if (!p.commenceTs || p.commenceTs > _nowMs) return false;
    if (p._sportKey && _BKEYS_PS.includes(p._sportKey)) return false;
    const nh = _normPS(p.home), na = _normPS(p.away);
    if (_BTEAMS_PS.some(t => nh.includes(t) || na.includes(t))) return false;
    if ((p.league||'').toLowerCase().includes('chile') || (p.league||'').toLowerCase().includes('primeira liga')) return false;
    return true;
  });

  // Invalidar caché si hay picks de basket (ya no se soportan)
  if (realPreds) {
    const hasBasket = realPreds.some(p => (p._sportKey || '').includes('basketball') || p.sport === 'basket');
    if (hasBasket) {
      localStorage.removeItem('gambeta_daily_preds_v15');
      realPreds = null;
    }
  }

  // ── Limpiar picks bloqueados del caché diario (Chile, Portugal, equipos explícitos) ──
  {
    const _BKEYS = ['soccer_chile_campeonato', 'soccer_portugal_primeira_liga'];
    const _normDC = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
    const _BTEAMS = ['palestino','ucatolica','universidadcatolica','universidadcat'];
    const _isBlocked = p => {
      if (p._sportKey && _BKEYS.includes(p._sportKey)) return true;
      const nh = _normDC(p.home), na = _normDC(p.away);
      if (_BTEAMS.some(t => nh.includes(t) || na.includes(t))) return true;
      if ((p.league||'').toLowerCase().includes('chile')) return true;
      if ((p.league||'').toLowerCase().includes('primeira liga')) return true;
      return false;
    };
    if (realPreds) {
      const clean = realPreds.filter(p => !_isBlocked(p));
      if (clean.length < realPreds.length) { realPreds = clean; saveDailyPredsCache(clean); }
    }
    // También purgar del _cachedPreds si aún no se usó
    if (_cachedPreds) {
      const clean2 = _cachedPreds.filter(p => !_isBlocked(p));
      if (clean2.length < _cachedPreds.length) saveDailyPredsCache(clean2);
    }
  }

  // 2. Si no hay caché, generar desde la API y guardar
  if (!realPreds) {
    try {
      realPreds = buildPredsFromOdds();
      // Rescatar los picks que ya empezaron del caché anterior — no se pierden al regenerar
      if (_preserveStarted.length) {
        const base = realPreds || [];
        _preserveStarted.forEach(op => {
          if (!base.find(p => teamsMatch(p.home, op.home) && teamsMatch(p.away, op.away))) {
            base.push(op);
          }
        });
        realPreds = base;
      }
      // ── LEY FUNDAMENTAL: conf/bvr/cuota asignados una vez son INMUTABLES ──
      // Fuentes de bloqueo (en orden de prioridad):
      //   1. Supabase shared_cache (global — igual para TODOS los usuarios)
      //   2. Caché local del navegador (fallback si Supabase no respondió aún)
      // 🛡️ (25-jun-2026 v2) HARDCODED OVERRIDE picks WC2026: el shared_cache de
      // Supabase está envenenado con valores incorrectos (Egipto-Irán "Doble X2"
      // en vez de "Empate"). Forzar valores correctos del repo wc-matches.js
      // ANTES de cualquier procesamiento.
      const WC_PICK_REPO_OVERRIDE = {
        'wc2026_g5_egy_irn_26jun': { rec: 'Empate', _recSide: 'draw', bvr: 5, bvrText: 'Alta', conf: 'high', confLabel: 'Alta', odds: 2.74, _bestOdds: 2.74, _hO: 2.55, _dO: 2.74, _aO: 3.87, probH: 32, probD: 36, probA: 32 },
        'wc2026_h5_uru_esp_26jun': { rec: 'Más de 2.5 goles', _recSide: 'over', bvr: 5, bvrText: 'Alta', conf: 'high', confLabel: 'Alta' },
        'wc2026_h_ned_tun_25jun': { rec: 'Gana Local', _recSide: 'home', bvr: 6, bvrText: 'Máxima', conf: 'high', confLabel: 'Máxima' },
        'wc2026_alemania_ecuador_25jun': { rec: 'Más de 2.5 goles', _recSide: 'over', bvr: 5, bvrText: 'Alta', conf: 'high', confLabel: 'Alta' },
      };
      if (realPreds) {
        realPreds.forEach(p => {
          // Aplicar override hardcoded ANTES de cualquier lock para picks WC
          if (p.id && WC_PICK_REPO_OVERRIDE[p.id]) {
            const ov = WC_PICK_REPO_OVERRIDE[p.id];
            Object.keys(ov).forEach(k => { p[k] = ov[k]; });
            p._confLocked = true; // marcar locked para que no se pise
          }
          const mk = _matchKeyLP(p.home, p.away);
          // 🛡️ (25-jun-2026) SKIP lock para picks WC2026: el shared_cache tiene
          // valores viejos del pick recalculado (Doble X2 2.74) de antes del fix.
          // Para WC, los datos del repo wc-matches.js (via historial_full) son la
          // unica fuente de verdad. NO aplicar shared_cache lock.
          if (p._sportKey === 'soccer_fifa_world_cup' || p._wcMatch === true) {
            return; // dejar pick como vino del repo
          }
          // 1. Lock global desde Supabase — HOY y AYER (exacto primero, luego fuzzy)
          // Combinar picks de hoy y de ayer para cubrir Libertadores/Sudamericana nocturnos
          const _allLP = { ...window._sbLockedPicksPrev, ...window._sbLockedPicks };
          let gl = _allLP[mk];
          if (!gl) {
            // Fuzzy: el API puede devolver "Cusco FC" cuando el pick fue guardado como "cusco"
            const fuzzyKey = Object.keys(_allLP).find(lk => {
              if (lk === mk) return false; // ya probamos exacto
              const parts = lk.split('_vs_');
              if (parts.length !== 2) return false;
              return teamsMatch(parts[0], p.home) && teamsMatch(parts[1], p.away);
            });
            if (fuzzyKey) gl = _allLP[fuzzyKey];
          }
          if (gl) {
            p.conf = gl.conf; p.bvr = gl.bvr; p.bvrText = gl.bvrText; p.confLabel = gl.bvrText; p._confLocked = true;
            if (gl.rec      != null) p.rec    = gl.rec;       // recomendación inmutable
            if (gl.bestOdds != null) p._bestOdds = gl.bestOdds;
            if (gl.hO       != null) p._hO    = gl.hO;
            if (gl.aO       != null) p._aO    = gl.aO;
            if (gl.dO       != null) p._dO    = gl.dO;
            if (gl.probH    != null) p.probH  = gl.probH;     // probs fijas para que 100/prob sea consistente
            if (gl.probD    != null) p.probD  = gl.probD;
            if (gl.probA    != null) p.probA  = gl.probA;
            // 🔒 LOCK: una vez publicado, conf/bvr/rec/odds NUNCA cambian.
            // Aunque el historial tenga otro bvr, el lock guardado es la fuente de verdad.
            return;
          }
          // 2. Fallback: caché local del navegador
          if (_cachedPreds?.length) {
            const prev = _cachedPreds.find(c => teamsMatch(c.home, p.home) && teamsMatch(c.away, p.away));
            if (prev?._confLocked) {
              p.conf = prev.conf; p.bvr = prev.bvr; p.bvrText = prev.bvrText; p.confLabel = prev.bvrText || prev.confLabel; p._confLocked = true;
              if (prev.rec      != null) p.rec    = prev.rec;
              if (prev._bestOdds != null) p._bestOdds = prev._bestOdds;
              if (prev._hO      != null) p._hO    = prev._hO;
              if (prev._aO      != null) p._aO    = prev._aO;
              if (prev._dO      != null) p._dO    = prev._dO;
              if (prev.probH    != null) p.probH  = prev.probH;
              if (prev.probD    != null) p.probD  = prev.probD;
              if (prev.probA    != null) p.probA  = prev.probA;
              return;
            }
          }
          // (sincronización con historial_full se aplica globalmente más abajo)
        });
      }
      // ── SINCRONIZACIÓN FINAL: historial_full del admin siempre gana ──
      // La card y la tabla DEBEN mostrar rec/conf/bvr/bvrText/stake idénticos.
      // historial_full es la fuente de verdad del admin — siempre sobreescribe el lock
      // para los campos semánticos, sin importar qué tenga guardado shared_cache.
      if (realPreds?.length) {
        const _ghist = _sbGetCache('ghist');
        if (_ghist?.length) {
          const _gn = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
          realPreds.forEach(p => {
            const _gp = _ghist.find(h => {
              if (h.result && h.result !== 'pending' && h.result !== '') return false;
              const nh=_gn(h.home),na=_gn(h.away),ph=_gn(p.home),pa=_gn(p.away);
              return nh.length>=4&&ph.length>=4&&(nh.includes(ph.slice(0,5))||ph.includes(nh.slice(0,5)))
                  && na.length>=4&&pa.length>=4&&(na.includes(pa.slice(0,5))||pa.includes(na.slice(0,5)));
            });
            // _ghist solo aplica si el pick NO está ya bloqueado por Supabase lock.
            // Un pick bloqueado (_confLocked) ya tiene su valor definitivo — no sobreescribir.
            if (_gp && !p._confLocked) {
              // 🛡️ SKIP override para WC: el ghist cache tambien tiene rec viejo
              if (p._sportKey === 'soccer_fifa_world_cup' || p._wcMatch === true) return;
              if (_gp.rec)     p.rec      = _gp.rec;
              if (_gp.conf)    p.conf     = _gp.conf;
              if (_gp.bvr)     p.bvr      = _gp.bvr;
              if (_gp.bvrText) { p.bvrText = _gp.bvrText; p.confLabel = _gp.bvrText; }
              if (_gp.odds)    p._bestOdds = _gp.odds;
              p._confLocked = true;
            }
          });
        }
      }
      // ── 🔒 REGLA: LIMITED_LEAGUES → máximo 2 picks por semana (los mejores) ──
      // Excepción: si aparecen candidatos claramente mejores, los deja pasar.
      const LIMITED_WEEKLY_CAP = 2; // flex: subido de 1 → 2
      if (realPreds && realPreds.length) {
        const _WEEK_MS = 7 * 24 * 60 * 60 * 1000;
        const _nowL = Date.now();
        // 1) Conteo de picks ya publicados (últimos 7 días) por liga LIMITED
        const _recentCountByLeague = new Map();
        const _recentMinBvrByLeague = new Map(); // peor bvr ya publicado (para "mejor que")
        try {
          const _hist = (typeof loadHistorial === 'function') ? loadHistorial() : [];
          _hist.forEach(h => {
            const sk = h.sport_key || h._sportKey || '';
            if (!isLimitedLeague(sk)) return;
            const ts = h.commenceTs || (h.date ? Date.parse(h.date) : 0);
            if (!ts || (_nowL - ts) > _WEEK_MS) return;
            _recentCountByLeague.set(sk, (_recentCountByLeague.get(sk) || 0) + 1);
            const cur = _recentMinBvrByLeague.get(sk);
            const hb = h.bvr || 0;
            if (cur === undefined || hb < cur) _recentMinBvrByLeague.set(sk, hb);
          });
        } catch(e) { console.warn('[LIMITED_LEAGUES] hist read err:', e.message); }

        // 2) Ordenar candidatos del batch por liga LIMITED → mantener top N
        const _byLeagueNew = new Map();
        realPreds.forEach(p => {
          const sk = p._sportKey || p.sport_key || '';
          if (!isLimitedLeague(sk)) return;
          if (!_byLeagueNew.has(sk)) _byLeagueNew.set(sk, []);
          _byLeagueNew.get(sk).push(p);
        });
        const _keepNewSet = new Set();
        _byLeagueNew.forEach((picks, sk) => {
          picks.sort((a, b) => {
            const da = (b.bvr || 0) - (a.bvr || 0);
            if (da) return da;
            const aP = a.prob || Math.max(a.probH||0, a.probA||0);
            const bP = b.prob || Math.max(b.probH||0, b.probA||0);
            return bP - aP;
          });
          const slotsLeft = Math.max(0, LIMITED_WEEKLY_CAP - (_recentCountByLeague.get(sk) || 0));
          // Tomar slotsLeft picks. Si ya hay cap, solo aceptar candidatos cuyo bvr > peor publicado
          if (slotsLeft > 0) {
            picks.slice(0, slotsLeft).forEach(p => _keepNewSet.add(p));
          } else {
            const minPublished = _recentMinBvrByLeague.get(sk) || 0;
            picks.forEach(p => { if ((p.bvr || 0) > minPublished) _keepNewSet.add(p); });
          }
        });

        // 3) Filtrar
        const _beforeLen = realPreds.length;
        realPreds = realPreds.filter(p => {
          const sk = p._sportKey || p.sport_key || '';
          if (!isLimitedLeague(sk)) return true;
          if (p._confLocked) return true;
          return _keepNewSet.has(p);
        });
        const _droppedLim = _beforeLen - realPreds.length;
        if (_droppedLim) console.log('[LIMITED_LEAGUES] Filtrados', _droppedLim, 'picks (cap 2/semana)');
      }

      // ── Garantizar al menos 1 pick 6/6 (finde o cualquier día si no hay máxima) ──
      // IMPORTANTE: esto corre ANTES de los saves para que bvr=6 quede en historial y Supabase
      if (realPreds && realPreds.length) {
        const _fdow2 = new Date().getDay();
        const _isFinde2 = _fdow2 === 5 || _fdow2 === 6 || _fdow2 === 0;
        const _hasMax2  = realPreds.some(p => (p.bvr || 0) >= 6 && !p._started);
        if (_isFinde2 && !_hasMax2) {
          // 🔒 LOCK: solo promover a Máxima si el pick aún NO está bloqueado.
          // Los picks publicados nunca cambian de confianza una vez guardados.
          // 🔒 REGLA: candidato debe ser de Tier 1 o Tier 2.
          const _best2 = realPreds
            .filter(p => p.conf === 'high' && !p._started && !p._confLocked && isTopTierLeague(p._sportKey || p.sport_key))
            .sort((a, b) => {
              const pa = a.prob || Math.max(a.probH||0, a.probA||0);
              const pb = b.prob || Math.max(b.probH||0, b.probA||0);
              return pb - pa;
            })[0];
          if (_best2) {
            _best2.bvr      = 6;
            _best2.bvrText  = 'Máxima';
            _best2._confLocked = true;
            const _mk6 = _matchKeyLP(_best2.home, _best2.away);
            if (window._sbLockedPicks[_mk6]) {
              window._sbLockedPicks[_mk6].bvr     = 6;
              window._sbLockedPicks[_mk6].bvrText = 'Máxima';
              window._sbLockedPicks[_mk6].conf    = 'high';
            }
          }
        }
      }
      if (realPreds && realPreds.length) {
        saveDailyPredsCache(realPreds);
        // Escribir a Supabase si aún no hay picks globales (solo el primer usuario del día)
        sbSaveLockedPicks(realPreds);
      }
    } catch(e) {
      console.error('[renderPreds] buildPredsFromOdds crash:', e.stack || e.message);
      window._lastPredsError = e.stack || e.message;
    }
  }

  // Anotar picks con su resultado del historial (no filtrar, mostrar terminados con badge)
  if (realPreds) {
    const nowMs = Date.now();
    const hist  = loadHistorial();
    const todayStr = new Date().toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'});

    // Incorporar picks recientes del historial que no estén ya en la caché
    // (caso: caché regenerada, picks guardados antes de medianoche para partido de hoy, etc.)
    // Regla: incluir si el partido arranca dentro de las próximas 48h
    //        O si terminó hace menos de 16h (ventana de display)
    const _16H_REC = 16 * 60 * 60 * 1000;
    const _48H_REC = 48 * 60 * 60 * 1000;
    hist
      .filter(h => {
        if (realPreds.find(p => teamsMatch(p.home, h.home) && teamsMatch(p.away, h.away))) return false;
        const ts = h.commenceTs;
        if (!ts) return h.date === todayStr;
        return ts > (_nowMs - _16H_REC);
      })
      .forEach(h => {
        realPreds.push({
          league:     (function(sk) {
            if (!sk) return h.sport === 'tenis' ? '🎾' : '';
            if (sk.includes('argentina'))       return '🇦🇷';
            if (sk.includes('champs'))          return '⭐';
            if (sk.includes('copa_libertadores')) return '🌎';
            if (sk.includes('copa_sudamericana')) return '🌎';
            if (sk.includes('europa_league'))   return '🟠';
            if (sk.includes('conference'))      return '🟢';
            if (sk.includes('england_premier')) return '🏴󠁧󠁢󠁥󠁮󠁧󠁿';
            if (sk.includes('spain_la_liga'))   return '🇪🇸';
            if (sk.includes('italy_serie'))     return '🇮🇹';
            if (sk.includes('germany_bundesliga')) return '🇩🇪';
            if (sk.includes('france_ligue'))    return '🇫🇷';
            if (sk.includes('brazil'))          return '🇧🇷';
            if (sk.includes('usa') || sk.includes('mls')) return '🇺🇸';
            if (sk.includes('mexico'))          return '🇲🇽';
            if (sk.includes('tennis'))          return '🎾';
            return '';
          })(h._sportKey || ''),
          home:       h.home,
          away:       h.away,
          rec:        h.rec,
          conf:       h.stake >= 130 ? 'high' : 'med',
          confLabel:  h.stake >= 150 ? 'Máxima' : h.stake >= 130 ? 'Alta' : h.stake >= 50 ? 'Media-Alta' : 'Media',
          probH: h.probH || 0, probD: h.probD || 0, probA: h.probA || 0,
          _hO: h._hO || null, _aO: h._aO || null, _dO: h._dO || null,
          _bestOdds: h._bestOdds || h.odds || null,
          odds: [], time: '',
          bvr: h.bvr || (h.stake >= 150 ? 6 : h.stake >= 130 ? 5 : h.stake >= 50 ? 4 : 3),
          bvrText: h.bvrText || (h.stake >= 150 ? 'Máxima' : h.stake >= 130 ? 'Alta' : h.stake >= 50 ? 'Media-Alta' : 'Media'),
          commenceTs: h.commenceTs || (_nowMs - 1), // garantiza que se marque como started
          _sportKey:  h._sportKey || 'soccer_argentina_primera_division',
          _fromHist:  true, // viene del historial, no de la API
        });
      });

    // ── Rescate de picks bloqueados sin partido futuro en API ──
    // Caso: Libertadores/Sudamericana nocturnos — el API ya no los devuelve (solo partidos futuros).
    // Estrategia combinada:
    //   1. home/away guardados en el lock (nuevo esquema – sbSaveLockedPicks ahora los guarda)
    //   2. Fallback: buscar en _ghist (historial global del admin) o en hist (historial local)
    {
      const _ghostGL2 = _sbGetCache('ghist') || [];
      const _allLP2 = { ...window._sbLockedPicksPrev, ...window._sbLockedPicks };
      const _48H2 = 48 * 60 * 60 * 1000;
      // Mapa estático de nombres reales para picks sin home/away (schema antiguo, 8-abr-2026)
      // commenceTs = kick-off real del partido (ms UTC)
      const _LOCK_NAMES = {
        // Copa Sudamericana 8-abr-2026 — 19:00 ART = 22:00 UTC
        'cuenca_vs_santos':                 {home:'Deportivo Cuenca',    away:'Santos FC',         sportKey:'soccer_conmebol_copa_sudamericana', commenceTs:1775685600000},
        // Copa Libertadores 8-abr-2026 — 21:00 ART = 00:00 UTC 9-abr
        'cusco_vs_flamengo':                {home:'Cusco FC',            away:'Flamengo',          sportKey:'soccer_conmebol_copa_libertadores',  commenceTs:1775692800000},
        'junior_vs_palmeiras':              {home:'Junior',              away:'Palmeiras',         sportKey:'soccer_conmebol_copa_libertadores',  commenceTs:1775692800000},
        // Copa Sudamericana 8-abr-2026 — 19:00 ART = 22:00 UTC
        'deportivopereira_vs_palestino':    {home:'Deportivo Pereira',   away:'Palestino',         sportKey:'soccer_conmebol_copa_sudamericana', commenceTs:1775685600000},
        // Copa Libertadores 8-abr-2026 — 19:00 ART = 22:00 UTC
        'sportingcristal_vs_cerroporteno':  {home:'Sporting Cristal',    away:'Cerro Porteño',     sportKey:'soccer_conmebol_copa_libertadores',  commenceTs:1775685600000},
        // Copa Sudamericana 8-abr-2026 — 21:00 ART = 00:00 UTC 9-abr
        'independienteme_vs_estudianteslp': {home:'Ind. Medellín',       away:'Estudiantes LP',    sportKey:'soccer_conmebol_copa_sudamericana', commenceTs:1775692800000, rec:'Más de 1.5', conf:'high', bvr:5, bvrText:'Alta', bestOdds:1.55, hO:2.73, dO:2.96, aO:2.96, probH:35, probD:32, probA:32},
        // Süper Lig 8-abr-2026 — ~19:00 TRT = 16:00 UTC
        'goztepe_vs_galatasaray':           {home:'Goztepe',             away:'Galatasaray',       sportKey:'soccer_turkey_super_league',         commenceTs:1775660400000},
        // UCL Q-Final 1ª ida 8-abr-2026 — 21:00 CEST = 19:00 UTC
        'parissaintgerm_vs_liverpool':      {home:'Paris Saint-Germain', away:'Liverpool',         sportKey:'soccer_uefa_champs_league',          commenceTs:1775674800000},
        'barcelona_vs_atleticomadrid':      {home:'Barcelona',           away:'Atlético Madrid',   sportKey:'soccer_uefa_champs_league',          commenceTs:1775674800000},
      };
      Object.keys(_allLP2).forEach(lk => {
        const gl = _allLP2[lk];
        let home = gl.home || null;
        let away = gl.away || null;
        let commenceTs = gl.commenceTs || null;
        let sportKey   = gl.sportKey   || '';
        // Fallback 1: mapa estático (picks del 8-abr sin home/away en Supabase)
        if (!home || !away) {
          const nm = _LOCK_NAMES[lk];
          if (nm) { home = nm.home; away = nm.away; sportKey = sportKey || nm.sportKey; commenceTs = commenceTs || nm.commenceTs || null; }
        }
        // Fallback 2: historial del admin (_ghist)
        if (!home || !away) {
          const parts = lk.split('_vs_');
          if (parts.length !== 2) return;
          const [h0, a0] = parts;
          const he = _ghostGL2.find(h => teamsMatch(h.home || '', h0) && teamsMatch(h.away || '', a0));
          if (he) {
            home = he.home; away = he.away;
            commenceTs = commenceTs || he.commenceTs;
            sportKey   = sportKey   || he._sportKey || he.sport_key || '';
          } else {
            const le = hist.find(h => teamsMatch(h.home || '', h0) && teamsMatch(h.away || '', a0));
            if (le) { home = le.home; away = le.away; commenceTs = commenceTs || le.commenceTs; sportKey = sportKey || le._sportKey || ''; }
          }
        }
        if (!home || !away) return;
        // Saltar picks bloqueados (eliminados intencionalmente del historial)
        if (commenceTs) {
          const _bd = new Date(commenceTs);
          const _bid = `${normTeam(home)}_${normTeam(away)}_${_bd.getFullYear()}-${String(_bd.getMonth()+1).padStart(2,'0')}-${String(_bd.getDate()).padStart(2,'0')}`;
          if (BLOCKED_HIST_IDS.has(_bid)) return;
        }
        // Si el pick YA está en realPreds (del cache diario), aplicar confianza/rec del lock sobre él
        const _existIdx = realPreds.findIndex(p => teamsMatch(p.home, home) && teamsMatch(p.away, away));
        if (_existIdx !== -1 && gl.conf && !realPreds[_existIdx]._confLocked) {
          realPreds[_existIdx] = {
            ...realPreds[_existIdx],
            rec:       gl.rec       || realPreds[_existIdx].rec,
            conf:      gl.conf      || realPreds[_existIdx].conf,
            confLabel: gl.bvrText   || realPreds[_existIdx].confLabel,
            bvr:       gl.bvr       != null ? gl.bvr : realPreds[_existIdx].bvr,
            bvrText:   gl.bvrText   || realPreds[_existIdx].bvrText,
            _bestOdds: gl.bestOdds  || realPreds[_existIdx]._bestOdds,
            _hO: gl.hO || realPreds[_existIdx]._hO,
            _aO: gl.aO || realPreds[_existIdx]._aO,
            _dO: gl.dO || realPreds[_existIdx]._dO,
            probH: gl.probH != null ? gl.probH : realPreds[_existIdx].probH,
            probD: gl.probD != null ? gl.probD : realPreds[_existIdx].probD,
            probA: gl.probA != null ? gl.probA : realPreds[_existIdx].probA,
            _confLocked: true,
          };
          console.log('[Preds] Lock aplicado sobre cache:', home, 'vs', away, '| bvr:', gl.bvr, 'rec:', gl.rec);
          return; // no agregar duplicado
        }
        if (_existIdx !== -1) return; // ya está y ya tiene lock
        // Solo picks dentro de las últimas 48h (si tenemos commenceTs)
        if (commenceTs && commenceTs < _nowMs - _48H2) return;
        // Solo partidos ya empezados — los futuros ya los maneja el WINDOWS loop
        if (commenceTs && commenceTs > _nowMs) return;
        realPreds.push({
          league: (function(sk) {
            if (!sk) return '';
            if (sk.includes('copa_libertadores')) return '🌎';
            if (sk.includes('copa_sudamericana')) return '🌎';
            if (sk.includes('champs'))            return '⭐';
            if (sk.includes('argentina'))         return '🇦🇷';
            if (sk.includes('england_premier'))   return '🏴󠁧󠁢󠁥󠁮󠁧󠁿';
            if (sk.includes('spain_la_liga'))     return '🇪🇸';
            if (sk.includes('italy_serie'))       return '🇮🇹';
            if (sk.includes('germany_bundesliga')) return '🇩🇪';
            if (sk.includes('france_ligue'))      return '🇫🇷';
            if (sk.includes('brazil'))            return '🇧🇷';
            return '';
          })(sportKey),
          home, away,
          rec:       gl.rec || '',
          conf:      gl.conf || 'med',
          confLabel: gl.bvrText || 'Media',
          bvr:       gl.bvr || 3,
          bvrText:   gl.bvrText || 'Media',
          _bestOdds: gl.bestOdds || null,
          _hO: gl.hO || null, _aO: gl.aO || null, _dO: gl.dO || null,
          probH: gl.probH || 0, probD: gl.probD || 0, probA: gl.probA || 0,
          odds: [], time: '',
          commenceTs: commenceTs || (_nowMs - 3600000),
          _sportKey: sportKey,
          _confLocked: true,
          _fromHist: true,
        });
        console.log('[Preds] Pick rescatado:', home, 'vs', away, '| fuente: lock+historial');
      });
      // ── Forzar conf/rec de _LOCK_NAMES para picks con lock incompleto en Supabase ──
      // Aplica SOLO a entradas que tienen rec/conf explícitos en _LOCK_NAMES (ej. Ind. Medellín).
      // No toca picks que ya tienen _confLocked:true (lock previo válido del loop anterior).
      Object.values(_LOCK_NAMES).forEach(nm => {
        if (!nm.rec && !nm.conf) return;
        const idx = realPreds.findIndex(p =>
          teamsMatch(p.home, nm.home) && teamsMatch(p.away, nm.away)
        );
        if (idx === -1) return;
        // Siempre aplicar: los valores de _LOCK_NAMES son autoritativos
        // (el rescue block puede haber puesto valores incorrectos de Supabase)
        realPreds[idx] = {
          ...realPreds[idx],
          rec:       nm.rec       || realPreds[idx].rec,
          conf:      nm.conf      || realPreds[idx].conf,
          confLabel: nm.bvrText   || realPreds[idx].confLabel,
          bvr:       nm.bvr       != null ? nm.bvr : realPreds[idx].bvr,
          bvrText:   nm.bvrText   || realPreds[idx].bvrText,
          _bestOdds: nm.bestOdds  != null ? nm.bestOdds : realPreds[idx]._bestOdds,
          _hO:       nm.hO        != null ? nm.hO  : realPreds[idx]._hO,
          _dO:       nm.dO        != null ? nm.dO  : realPreds[idx]._dO,
          _aO:       nm.aO        != null ? nm.aO  : realPreds[idx]._aO,
          probH:     nm.probH     != null ? nm.probH : realPreds[idx].probH,
          probD:     nm.probD     != null ? nm.probD : realPreds[idx].probD,
          probA:     nm.probA     != null ? nm.probA : realPreds[idx].probA,
          _confLocked: true,
        };
        console.log('[Preds] _LOCK_NAMES override:', nm.home, 'vs', nm.away, '| bvr:', nm.bvr, 'rec:', nm.rec, 'bestOdds:', nm.bestOdds);
      });
    }

    // TTL post-resolución: WIN visible 16h, LOSS visible 10h después de marcado.
    // Si el pick fue resuelto y pasó su ventana, se quita del bloque de pronósticos.
    const _TTL_WIN_MS  = 16 * 60 * 60 * 1000;
    const _TTL_LOSS_MS = 10 * 60 * 60 * 1000;
    realPreds = realPreds.map(p => {
      const started = p.commenceTs && p.commenceTs <= nowMs;
      if (!started) return p; // partido futuro — sin cambios
      // Buscar resultado en historial
      const entry = hist.find(h =>
        teamsMatch(h.home, p.home) && teamsMatch(h.away, p.away)
      );
      const histResult = entry?.result || 'pending';
      // Filtro TTL: si ya tiene resultado win/loss, mostrar solo durante la ventana
      if (histResult === 'win' || histResult === 'loss') {
        const resolvedAt = entry.resolvedAt
          || (entry.commenceTs ? entry.commenceTs + 2 * 3600 * 1000 : null); // fallback: kick-off + 2h
        if (resolvedAt) {
          const ttl = histResult === 'win' ? _TTL_WIN_MS : _TTL_LOSS_MS;
          if (nowMs - resolvedAt > ttl) return null; // vencido — quitar del render
        }
      }
      return {
        ...p,
        _started:    true,
        _histResult: histResult,
        _histScore:  entry?.finalScore || null,
      };
    }).filter(Boolean);

    // ── Scores extra hardcodeados (partidos que la API no devuelve en scoresData) ──
    const _EXTRA_SCORES = [
      {home:'Junior', away:'Palmeiras', flag:'final', scoreH:1, scoreA:1},
    ];
    const _scoresExt = typeof scoresData !== 'undefined'
      ? [...scoresData, ..._EXTRA_SCORES]
      : _EXTRA_SCORES;

    // ── Resolver picks rescatados (sin historial) contra scoresData ──
    // Los picks del bloque de rescate (_fromHist:true) no pasan por savePredictions
    // y por tanto no tienen entrada en historial → _histResult='pending' aunque el partido terminó.
    // Aquí los resolvemos directamente contra scoresData (ya cargado en memoria).
    if (_scoresExt.length) {
      realPreds = realPreds.map(p => {
        if (!p._started || p._histResult !== 'pending') return p;
        const se = _scoresExt.find(s =>
          _settledScore(s) &&
          (teamsMatch(s.home, p.home) || teamsMatch(s.homeRaw || s.home, p.home)) &&
          (teamsMatch(s.away, p.away) || teamsMatch(s.awayRaw || s.away, p.away))
        );
        if (!se) return p;
        const totalGoals = se.scoreH + se.scoreA;
        const homeWin = se.scoreH > se.scoreA, awayWin = se.scoreA > se.scoreH, draw = se.scoreH === se.scoreA;
        const bttsMet = se.scoreH > 0 && se.scoreA > 0;
        const rec = p.rec || '';
        const _side = _recSideOf(p);
        let result = null; // null = no resolver auto; queda pending
        if      (_side === 'home')         result = homeWin  ? 'win' : 'loss';
        else if (_side === 'away')         result = awayWin  ? 'win' : 'loss';
        else if (_side === 'draw')         result = draw     ? 'win' : 'loss';
        else if (rec === 'Ambos Marcan')   result = bttsMet  ? 'win' : 'loss';
        else if (rec === 'Más de 1.5')     result = totalGoals >= 2 ? 'win' : 'loss';
        else if (rec === 'Más de 2.5')     result = totalGoals >= 3 ? 'win' : 'loss';
        else if (rec === 'Más de 3.5')     result = totalGoals >= 4 ? 'win' : 'loss';
        else if (/^Más de (\d+\.?\d*)$/.test(rec)) {
          const line = parseFloat(rec.replace('Más de ',''));
          result = totalGoals > line ? 'win' : 'loss';
        }
        if (result !== 'win' && result !== 'loss') return p; // sin match definitivo: pending
        console.log('[Preds] Rescatado resuelto:', p.home, 'vs', p.away, '→', result, se.scoreH+'-'+se.scoreA);
        return { ...p, _histResult: result, _histScore: `${se.scoreH}-${se.scoreA}` };
      });
    }
  }

  // Array vacío también cuenta como sin datos
  if (realPreds && realPreds.length === 0) realPreds = null;

  // 🏆 WC_ONLY_MODE GLOBAL — aplicado a realPreds (afecta TODO: source, Pick Estrella del Finde, ticker, banner, chat IA, etc)
  // Hasta 20-jul-2026 (día después de la final) solo se muestran picks del Mundial 2026.
  if (realPreds && Array.isArray(realPreds)) {
    const _WC_END_TS = new Date('2026-07-20T00:00:00-03:00').getTime();
    const _beforeWC = realPreds.length;
    realPreds = realPreds.filter(p => {
      const isMundial = p._sportKey === 'soccer_fifa_world_cup'
                     || (p.league || '').includes('Mundial');
      if (!isMundial) return false;
      if (p.commenceTs && p.commenceTs > _WC_END_TS) return false;
      return true;
    });
    if (_beforeWC !== realPreds.length) {
      console.log('[WC_ONLY_MODE realPreds] Bloqueados', _beforeWC - realPreds.length, 'picks no-Mundial / post-Mundial (incluye Pick Estrella del Finde)');
    }
    if (realPreds.length === 0) realPreds = null;
  }

  const isLive = !!realPreds;
  // Guardar al historial TODOS los picks — incluyendo ya iniciados con resultado pendiente.
  // Esto garantiza que ningún pick desaparezca por un reload durante el partido.
  try {
    if (realPreds) {
      const _savedChanges = savePredictions(realPreds);
      // Si se corrigieron commenceTs, refrescar la tabla de historial si está visible
      if (_savedChanges && typeof renderHistorial === 'function') {
        const _histEl = document.getElementById('historial');
        if (_histEl && (_histEl.style.display !== 'none') && (_histEl.offsetParent !== null)) {
          setTimeout(() => renderHistorial(), 100);
        }
      }
    }
  } catch(e) { console.error('[renderPreds] savePredictions crash:', e); }

  // ── Weekend Máxima: ya se aplica arriba (antes de saves). Noop aquí. ──

  // ── Pick Estrella del Finde (viernes, sábado o domingo) ──
  try {
    const estrellaEl = document.getElementById('estrellaContainer');
    const dow = new Date().getDay(); // 0=Dom,5=Vie,6=Sáb
    const isFindeWindow = dow === 5 || dow === 6 || dow === 0;
    if (estrellaEl && isFindeWindow && realPreds && realPreds.length) {
      // Respetar el filtro de deporte activo para la Estrella
      const sfE = window._predSportFilter || 'all';
      let predsForEstrella = realPreds;
      if (sfE === 'europe') {
        predsForEstrella = realPreds.filter(p => {
          const sk = p._sportKey || '';
          return sk.includes('soccer') && !sk.includes('argentina') && !sk.includes('brazil') && !sk.includes('conmebol');
        });
      } else if (sfE === 'arg') {
        predsForEstrella = realPreds.filter(p => (p._sportKey || '').includes('argentina'));
      } else if (sfE === 'bra') {
        predsForEstrella = realPreds.filter(p => (p._sportKey || '').includes('brazil'));
      }
      // Override de admin: si hay un pick del finde pinneado, usarlo primero
      let star = null;
      if (window._estrellaOverride) {
        const ov = window._estrellaOverride;
        star = realPreds.find(p =>
          teamsMatch(p.home, ov.home) && teamsMatch(p.away, ov.away)
        ) || null;
      }
      // Fallback automático: pick Alta sin iniciar
      // Tie-breaker: si empatan en bvr, elegir el más mediático (Mauro 25-jun-2026)
      // Ej: 2 picks Alta hoy → preferir Alemania-Ecuador (más prensa) sobre PB-Túnez.
      if (!star) {
        // Score "mediático" basado en cuán reconocido es el partido por la prensa.
        // Tier 1 (10): potencias mundialistas top
        // Tier 2 (6):  selecciones grandes habituales en cuartos/octavos
        // Tier 3 (3):  participantes habituales con seguimiento medio
        // Default (1): selecciones de baja prensa internacional
        const _MEDIATIC_TIER = {
          // Tier 1
          'brasil':10,'brazil':10,'argentina':10,'alemania':10,'germany':10,
          'francia':10,'france':10,'inglaterra':10,'england':10,'espana':10,'spain':10,
          'italia':10,'italy':10,'portugal':10,'paisesbajos':10,'netherlands':10,'holanda':10,
          'belgica':10,'belgium':10,
          // Tier 2
          'mexico':6,'uruguay':6,'colombia':6,'croacia':6,'croatia':6,'usa':6,'unitedstates':6,
          'estadosunidos':6,'marruecos':6,'morocco':6,'japon':6,'japan':6,'suiza':6,'switzerland':6,
          // Tier 3
          'dinamarca':3,'denmark':3,'polonia':3,'poland':3,'senegal':3,'ecuador':3,
          'coreadelsur':3,'southkorea':3,'corea':3,'australia':3,'serbia':3,'turquia':3,'turkey':3,
          'austria':3,'paraguay':3,'chile':3,'peru':3,'ghana':3,'nigeria':3,'iran':3,
          'gales':3,'wales':3,'escocia':3,'scotland':3,'noruega':3,'norway':3,
        };
        function _medScore(name) {
          if (!name) return 1;
          const n = String(name).toLowerCase()
            .replace(/ø/g,'o').replace(/æ/g,'ae').replace(/å/g,'a')
            .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
            .replace(/[^a-z0-9]/g,'');
          return _MEDIATIC_TIER[n] || 1;
        }
        function _matchMediaticScore(p) {
          return _medScore(p.home) + _medScore(p.away);
        }
        const candidates = predsForEstrella
          .filter(p => p.conf === 'high' && !p._started)
          .sort((a,b) =>
            (b.bvr||0)-(a.bvr||0)                          // 1. mayor bvr
            || _matchMediaticScore(b)-_matchMediaticScore(a) // 2. más mediático
            || (b.prob||0)-(a.prob||0)                      // 3. mayor prob
          );
        star = candidates[0] || null;
      }
      if (star) {
        const sHome = logoHtml(star.home, 42);
        const sAway = logoHtml(star.away, 42);
        const rec = _recLabel(star.rec, star.home, star.away);
        // Cuota: basada en _recSide para retrocompat con picks viejos
        const _starSide = _recSideOf(star);
        const _recOdds = _starSide === 'home' ? star._hO
                       : _starSide === 'away' ? star._aO
                       : _starSide === 'draw' ? star._dO
                       : null;
        const oddsNum = parseFloat(_recOdds || star._bestOdds || star._hO || star._aO || star._dO || 0);
        const cuotaDisplay = oddsNum > 0 ? oddsNum.toFixed(2) : '—';
        const probPct = 0; // porcentaje removido del display
        // bvr ya es 1-6, usarlo directamente para los dots
        const dotsFilled = star.bvr || 1;
        const dotsHtml = Array.from({length:6}, (_,i) =>
          `<span class="dot${i<dotsFilled?'':' empty'}">💰</span>`).join('');
        const bvrLabel = star.bvrText || (dotsFilled===6?'Máxima':dotsFilled>=5?'Alta':dotsFilled>=4?'Media-Alta':'Media');
        const stakeLabel = (star.bvr||0) >= 6 ? '$170' : ((star.bvr||0) === 5 || star.conf==='high') ? '$130' : (star.bvr||0) === 4 ? '$50' : '$30';
        estrellaEl.style.display = 'block';
        estrellaEl.innerHTML = `
          <div class="estrella-card" style="cursor:pointer" onclick="scrollToPickCard('${star.home}','${star.away}')" title="Ver ficha completa del pronóstico">
            <div class="estrella-glow"></div>
            <div class="estrella-badge">⭐ Pick Estrella del Finde</div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
              <div style="display:flex;align-items:center;gap:10px">
                ${sHome}
                <div>
                  <div style="font-size:0.65rem;color:var(--texto-sec);font-weight:700;letter-spacing:0.5px">${star.league||''}</div>
                  <div style="font-size:0.95rem;font-weight:800;color:#fff;margin:2px 0">${star.home} <span style="color:var(--texto-sec);font-weight:400;font-size:0.7rem">vs</span> ${star.away}</div>
                  <div style="color:var(--verde);font-weight:700;font-size:0.85rem">→ ${rec}</div>
                </div>
                ${sAway}
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div style="font-size:0.65rem;color:var(--texto-sec);margin-bottom:4px">Confianza IA</div>
                <div class="estrella-conf-dots lvl-${dotsFilled}">${dotsHtml}</div>
                <div style="font-size:0.62rem;color:${dotsFilled>=6?'#ffd600':dotsFilled>=5?'#66bb6a':dotsFilled>=3?'#e64a19':'#d32f2f'};margin-top:3px">${dotsFilled}/6 · ${bvrLabel}</div>
              </div>
            </div>
            <div style="display:flex;gap:14px;margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,214,0,0.12);flex-wrap:wrap">
              <div><span style="font-size:0.65rem;color:var(--texto-sec)">CUOTA</span><div style="font-weight:800;color:var(--amarillo)">${cuotaDisplay}</div></div>
              <div><span style="font-size:0.65rem;color:var(--texto-sec)">STAKE</span><div style="font-weight:800;color:#fff">${stakeLabel}</div></div>
              <div><span style="font-size:0.65rem;color:var(--texto-sec)">HORARIO</span><div style="font-weight:700;color:var(--texto-sec);font-size:0.85rem">${star.time||'—'}</div></div>
            </div>
          </div>`;
      } else {
        estrellaEl.style.display = 'none';
      }
    } else if (estrellaEl) {
      estrellaEl.style.display = 'none';
    }
  } catch(eStr) { console.warn('[estrella]', eStr); }

  // 🛡️ (25-jun-2026 v3) OVERRIDE FINAL picks WC2026 envenenados por Supabase
  // shared_cache. Se aplica al FINAL del pipeline para asegurar que ningún paso
  // posterior pise los valores correctos del repo wc-matches.js.
  if (realPreds && Array.isArray(realPreds)) {
    const WC_FINAL_OVERRIDE = {
      'wc2026_g5_egy_irn_26jun': {
        rec: 'Empate', _recSide: 'draw',
        bvr: 5, bvrText: 'Alta', conf: 'high', confLabel: 'Alta',
        odds: 2.74, _bestOdds: 2.74, _hO: 2.55, _dO: 2.74, _aO: 3.87,
        probH: 32, probD: 36, probA: 32,
      },
    };
    realPreds.forEach(p => {
      if (p && p.id && WC_FINAL_OVERRIDE[p.id]) {
        const ov = WC_FINAL_OVERRIDE[p.id];
        for (const k in ov) p[k] = ov[k];
        p._confLocked = true;
      }
    });
  }

  // Guardar picks completos y actualizar visibilidad de tabs de liga
  window._allAvailablePicks = realPreds ? realPreds.slice() : [];
  refreshLeagueTabs(window._allAvailablePicks);

  // Filtrar por deporte según tab activo
  if (realPreds) {
    const sf = window._predSportFilter || 'all';
    // Ordenar por confianza: bvr desc → prob desc → tiempo asc
    const sortByConf = (a, b) =>
      (b.bvr  || 0) - (a.bvr  || 0) ||
      (b.prob || 0) - (a.prob || 0) ||
      (a.commenceTs || 0) - (b.commenceTs || 0);
    // ── Filtro baja confianza (solo para tab Principales) ──
    // Excepción: Libertadores y Sudamericana muestran picks Media (conf 'low' / bvr 3) siempre.
    const _isRelaxedSk = sk => sk === 'soccer_conmebol_copa_libertadores' || sk === 'soccer_conmebol_copa_sudamericana';
    const _bajaFilter = p =>
      p._started ||                                   // terminados: siempre mostrar
      p.conf === 'high' || p.conf === 'med' ||        // alta y media: siempre
      _isRelaxedSk(p._sportKey || '') ||              // Libertadores/Sudamericana: incluir Media
      parseFloat(p._bestOdds || 0) >= 3.00;           // baja: solo si cuota >= 3.00
    if (sf === 'all') realPreds = realPreds.filter(_bajaFilter);
    // ── Piso mínimo de confianza: bvr≥4 por defecto, pero Conmebol permite bvr=3 (Media) ──
    realPreds = realPreds.filter(p =>
      p._started ||
      !p.bvr ||
      p.bvr >= 4 ||
      _isRelaxedSk(p._sportKey || '')
    );
    // Separar upcoming y terminados — ambos ya ordenados por confianza
    let upcoming  = realPreds.filter(p => !p._started).sort(sortByConf);
    let finished  = realPreds.filter(p =>  p._started).sort(sortByConf);

    // ── Argentina: nunca overs (ya bloqueado en buildPredsFromOdds, doble-check aquí) ──
    upcoming = upcoming.filter(p => {
      if (!(p._sportKey || '').includes('argentina')) return true;
      return !/^Más de/.test(p.rec); // eliminar cualquier over que pudiera haber quedado cacheado
    });

    // ── Regla 16 horas: no mostrar terminados después de 16h del inicio del partido ──
    const _16H_MS = 16 * 60 * 60 * 1000;
    const _nowFilter = Date.now();
    finished = finished.filter(p => !p.commenceTs || (_nowFilter - p.commenceTs) < _16H_MS);

    // ── Mostrar todos los terminados (wins + losses) — transparencia total ──
    // En tab TERMINADOS ya se filtran por _started, aquí no ocultamos nada

    // ── Filtros por liga individual ───────────────────────────────────────────
    const _leagueFilter = (keys) => {
      const fn = p => { const sk = p._sportKey || ''; return keys.some(k => sk.includes(k)); };
      upcoming = upcoming.filter(fn); finished = finished.filter(fn);
      const all = [...upcoming, ...finished];
      realPreds = all.length ? all : null;
    };
    if (sf === 'champions') {
      _leagueFilter(['champs_league','champions']);
    } else if (sf === 'europa') {
      _leagueFilter(['europa_league']);
    } else if (sf === 'conference') {
      _leagueFilter(['conference_league']);
    } else if (sf === 'premier') {
      _leagueFilter(['england_premier','soccer_epl']);
    } else if (sf === 'laliga') {
      _leagueFilter(['spain_la_liga']);
    } else if (sf === 'bundesliga') {
      // Solo BL1 — excluir BL2 explícitamente
      const _blFn = p => { const sk = p._sportKey||''; return sk.includes('germany_bundesliga') && !sk.includes('bundesliga2'); };
      upcoming = upcoming.filter(_blFn); finished = finished.filter(_blFn);
      const _blAll = [...upcoming,...finished]; realPreds = _blAll.length ? _blAll : null;
    } else if (sf === 'bl2') {
      _leagueFilter(['germany_bundesliga2']);
    } else if (sf === 'seriea') {
      _leagueFilter(['italy_serie_a']);
    } else if (sf === 'serieb') {
      _leagueFilter(['italy_serie_b']);
    } else if (sf === 'ligue1') {
      _leagueFilter(['france_ligue_one']);
    } else if (sf === 'ligue2') {
      _leagueFilter(['france_ligue_two']);
    } else if (sf === 'championship') {
      _leagueFilter(['england_championship']);
    } else if (sf === 'segunda') {
      _leagueFilter(['spain_segunda_division']);
    } else if (sf === 'belgium') {
      _leagueFilter(['belgium_first_div']);
    } else if (sf === 'eredivisie') {
      _leagueFilter(['netherlands_eredivisie','eredivisie']);
    } else if (sf === 'scotland') {
      _leagueFilter(['scotland']);
    } else if (sf === 'turkey') {
      _leagueFilter(['turkey']);
    } else if (sf === 'libertadores') {
      _leagueFilter(['copa_libertadores']);
    } else if (sf === 'mundial') {
      // 🏆 Mundial 2026 — SOLO partidos del torneo (no apuestas a futuro/largo plazo).
      // Triple filtro de exclusión: flag explícito, _wcType, y formato away de evento.
      const _isLongTerm = p => {
        if (p._wcFuture === true || p._wcType) return true;
        const away = (p.away || '').toLowerCase();
        if (/^(grupo |grupo$|semifinal|cuartos|octavos|bota de oro|campe[óo]n|finalista|goleador)/i.test(away)) return true;
        const rec = (p.rec || '').toLowerCase();
        if (/(gana el grupo|gana el mundial|llega a |clasifica |bota de oro|es el goleador)/i.test(rec)) return true;
        return false;
      };
      const fn = p => {
        const sk = p._sportKey || '';
        return sk.includes('fifa_world_cup') && !_isLongTerm(p);
      };
      upcoming = upcoming.filter(fn); finished = finished.filter(fn);
      const all = [...upcoming, ...finished];
      realPreds = all.length ? all : null;
    } else if (sf === 'wcfutures') {
      // 🎯 WC Largo Plazo — los 10 picks futures del Mundial 2026 desde el historial global
      try {
        // CACHE CORRECTA: _sbGetCache('ghist') no window.__sbHistorialCache (esa no existe)
        let hist = [];
        if (typeof _sbGetCache === 'function') {
          hist = _sbGetCache('ghist') || [];
        }
        // Si no hay cache aún, disparar carga en background y mostrar mensaje
        if (!hist.length && typeof sbLoadGlobalHistorial === 'function' && !window._wcfBgLoading) {
          window._wcfBgLoading = true;
          sbLoadGlobalHistorial().then(() => {
            window._wcfBgLoading = false;
            // Re-render cuando llegue el historial
            if (window._predSportFilter === 'wcfutures' && typeof renderPreds === 'function') renderPreds();
          }).catch(() => { window._wcfBgLoading = false; });
        }
        const futures = hist.filter(x => x && x._wcFuture);
        const adapted = futures.map(f => ({
          ...f,
          _bestOdds: f.odds,
          _started: f.result && f.result !== 'pending',
          prob: f.bvr ? f.bvr/6 : 0.5,
        }));
        upcoming = adapted.filter(p => !p._started);
        finished = adapted.filter(p =>  p._started);
        realPreds = adapted.length ? adapted : null;
      } catch(e) {
        console.log('[wcfutures] error', e);
        realPreds = null;
      }
    } else if (sf === 'sudamericana') {
      _leagueFilter(['copa_sudamericana']);
    } else if (sf === 'arg') {
      // 🆕 (23-jun-2026) Solo Primera División (no incluye Primera Nacional)
      _leagueFilter(['argentina_primera_division']);
    } else if (sf === 'argpn') {
      // 🆕 (23-jun-2026) Primera Nacional Argentina — tab separado
      _leagueFilter(['argentina_primera_nacional']);
    } else if (sf === 'bra') {
      // 🆕 (23-jun-2026) Solo Brasileirão Serie A (no incluye Serie B)
      const _braFn = p => { const sk = p._sportKey||''; return sk.includes('brazil') && !sk.includes('serie_b'); };
      upcoming = upcoming.filter(_braFn); finished = finished.filter(_braFn);
      const _braAll = [...upcoming,...finished]; realPreds = _braAll.length ? _braAll : null;
    } else if (sf === 'brab') {
      // 🆕 (23-jun-2026) Brasileirão Serie B — tab separado
      _leagueFilter(['brazil_serie_b']);
    } else if (sf === 'mexico') {
      _leagueFilter(['mexico_ligamx','ligamx']);
    } else if (sf === 'mls') {
      _leagueFilter(['usa_mls','soccer_mls']);
    } else if (sf === 'uruguay') {
      _leagueFilter(['uruguay']);
    } else if (sf === 'saudi') {
      _leagueFilter(['saudi']);
    } else if (sf === 'japan') {
      _leagueFilter(['japan_j_league','j_league']);
    } else if (sf === 'portugal') {
      _leagueFilter(['portugal']);
    } else if (sf === 'denmark') {
      _leagueFilter(['denmark']);
    } else if (sf === 'sweden') {
      _leagueFilter(['sweden']);
    } else if (sf === 'norway') {
      _leagueFilter(['norway']);
    } else if (sf === 'poland') {
      _leagueFilter(['poland']);
    } else if (sf === 'czech') {
      _leagueFilter(['czech_republic']);
    } else if (sf === 'switzerland') {
      _leagueFilter(['switzerland']);
    } else if (sf === 'austria') {
      _leagueFilter(['austria']);
    } else if (sf === 'greece') {
      _leagueFilter(['greece']);
    } else if (sf === 'russia') {
      _leagueFilter(['russia']);
    } else if (sf === 'chile') {
      _leagueFilter(['chile']);
    } else if (sf === 'colombia') {
      _leagueFilter(['colombia']);
    } else if (sf === 'ecuador') {
      _leagueFilter(['ecuador']);
    } else if (sf === 'peru') {
      _leagueFilter(['peru']);
    } else if (sf === 'venezuela') {
      _leagueFilter(['venezuela']);
    } else if (sf === 'bolivia') {
      _leagueFilter(['bolivia']);
    } else if (sf === 'paraguay') {
      _leagueFilter(['paraguay']);
    } else if (sf === 'korea') {
      _leagueFilter(['south_korea','kleague']);
    } else if (sf === 'australia') {
      _leagueFilter(['australia_aleague']);
    // ── Legados (por si quedan referencias) ──────────────────────────────────
    } else if (sf === 'europe') {
      _leagueFilter(['uefa','epl','england_premier','spain_la_liga','germany_bundesliga',
                     'italy_serie','france_ligue','netherlands','eredivisie','scotland','turkey']);
    } else if (sf === 'latam') {
      _leagueFilter(['mexico','ligamx','usa_mls','mls','uruguay','saudi','japan','j_league']);
    } else if (sf === 'soccer') {
      // Fútbol: todos los de fútbol (fallback legacy)
      upcoming = upcoming.filter(p => (p._sportKey || '').includes('soccer'));
      finished = finished.filter(p => (p._sportKey || '').includes('soccer'));
      const allSoccer = [...upcoming, ...finished];
      realPreds = allSoccer.length ? allSoccer : null;
    } else if (sf === 'todos') {
      // TODOS: todos los picks sin filtro ni límite
      realPreds = [...upcoming, ...finished];
      if (!realPreds.length) realPreds = null;
    } else {
      // Principales: terminados siempre visibles (hasta 16h) + máximo 6 sin iniciar alta/media.
      // EXCEPCIÓN: si hay filtro de tiempo activo (HOY/PRÓXIMOS) no limitar a 6 — mostrar todos los que pasen el filtro
      const _tf = window._predTimeFilter || 'all';
      const _timeFilterActive = _tf === 'today' || _tf === 'upcoming';
      // sortConf: FINALES y SEMIS primero (Mauro: "en finales/semis dale más
      // importancia"), después por confianza (bvr) y probabilidad. Así una final
      // de confianza media (ej: final Europa League) no queda tapada por picks
      // de alta confianza de ligas comunes ni se cae del top 6 del home.
      const _stageRank = { final: 3, semi: 2, quarter: 1, r16: 0 };
      const sortConf = (a, b) => {
        const sa = _stageRank[a._stage] || 0, sb = _stageRank[b._stage] || 0;
        if (sa !== sb) return sb - sa;
        return (b.bvr || 0) - (a.bvr || 0) || (b.prob || 0) - (a.prob || 0);
      };
      const isEuropePick = p => { const sk = p._sportKey||''; return sk.includes('soccer') && !sk.includes('argentina') && !sk.includes('brazil') && !sk.includes('conmebol'); };
      // Upcoming: alta y media confianza, + Media (low) para Libertadores/Sudamericana
      const highMedUp = upcoming.filter(p =>
        p.conf === 'high' ||
        p.conf === 'med' ||
        _isRelaxedSk(p._sportKey || '')
      ).sort(sortConf);
      const _isSubPageNow = document.body.dataset.gbpage === 'picks';
      let upcomingSlice = (_timeFilterActive || _isSubPageNow) ? highMedUp : highMedUp.slice(0, 6);
      if (!_timeFilterActive && !_isSubPageNow) {
        // Si no hay ningún pick europeo en los 6 pero sí existe uno de alta/media confianza, intercambiar el de menor BVR
        const hasEurInTop6 = upcomingSlice.some(isEuropePick);
        if (!hasEurInTop6) {
          const bestEur = highMedUp.find(isEuropePick);
          if (bestEur && upcomingSlice.length === 6) {
            const last = upcomingSlice[upcomingSlice.length - 1];
            if ((bestEur.bvr || 0) >= (last.bvr || 0)) upcomingSlice[upcomingSlice.length - 1] = bestEur;
          } else if (bestEur) {
            upcomingSlice.push(bestEur);
          }
        }
      }
      // Solo alta y media confianza — no publicar picks de baja confianza
      const principales = [...upcomingSlice, ...finished];
      realPreds = principales.length ? principales : null;
    }
    if (realPreds && realPreds.length === 0) realPreds = null;
  }

  // ── Sub-filtro de tiempo (HOY / PRÓXIMOS / EN JUEGO / TERMINADOS) ──
  // 🆕 (28-jun-2026) Tab EN JUEGO SIEMPRE visible. Cuando hay live: rojo+animación+contador. Cuando no: gris+atenuado.
  try{
    const _liveC=(realPreds||[]).filter(p=>!!_isPickLive(p)).length;
    const _liveT=document.getElementById('predLiveTab');
    if(_liveT){
      _liveT.style.display='inline-block';
      if(_liveC>0){
        _liveT.innerHTML='🔴 EN JUEGO ('+_liveC+')';
        _liveT.style.opacity='1';
        _liveT.style.animation='gambeta-live-blink 1.5s ease-in-out infinite';
        _liveT.style.cursor='pointer';
        _liveT.disabled=false;
      } else {
        _liveT.innerHTML='⚫ EN JUEGO';
        _liveT.style.opacity='0.45';
        _liveT.style.animation='none';
        _liveT.style.cursor='default';
        // 🆕 #594 NO resetear el filtro live automáticamente cuando _liveC=0.
        // Antes se reseteaba a 'all' y mostraba los últimos TERMINADOS confundiendo al usuario.
        // Ahora respetamos la elección del usuario: si clickeó EN JUEGO y no hay live,
        // mostrará empty state.
      }
    }
  }catch(_){}
  if (realPreds) {
    const tf = window._predTimeFilter || 'all';
    if (tf === 'today') {
      // HOY = partidos cuyo commenceTs cae entre 00:00 y 23:59 de hoy (local)
      // Incluye: pendientes de hoy, en juego y terminados de hoy
      const _todayStart = new Date(); _todayStart.setHours(0,0,0,0);
      const _todayEnd   = new Date(); _todayEnd.setHours(23,59,59,999);
      const _tsStart = _todayStart.getTime(), _tsEnd = _todayEnd.getTime();
      realPreds = realPreds.filter(p => {
        if (p.commenceTs) return p.commenceTs >= _tsStart && p.commenceTs <= _tsEnd;
        if (p.date) { const d = new Date(p.date); d.setHours(0,0,0,0); return d.getTime() === _todayStart.getTime(); }
        return true; // sin fecha → incluir por defecto
      });
    } else if (tf === 'upcoming') {
      // PRÓXIMOS = solo partidos de mañana en adelante (no los de hoy pendientes)
      const _tomorrow = new Date(); _tomorrow.setHours(0,0,0,0); _tomorrow.setDate(_tomorrow.getDate() + 1);
      const _tomorrowMs = _tomorrow.getTime();
      realPreds = realPreds.filter(p => {
        if (p.commenceTs) return p.commenceTs >= _tomorrowMs;
        if (p.date) { const d = new Date(p.date); d.setHours(0,0,0,0); return d.getTime() >= _tomorrowMs; }
        return false; // sin fecha → no incluir en próximos
      });
    } else if (tf === 'finished') {
      // TERMINADOS = todos los que ya empezaron + resueltos (win/loss/void)
      // 🛡️ (26-jun-2026) Antes excluíamos pending → fichas EN JUEGO desaparecían.
      // 🆕 (28-jun-2026) Garantizar mínimo 6 últimas fichas resueltas usando historial local
      //                   (el feed odds rara vez trae partidos ya jugados)
      let _finished = realPreds.filter(p => !!p._started && p._histResult && p._histResult !== 'pending');
      if (_finished.length < 6) {
        try {
          const _hist = (typeof loadHistorial === 'function') ? loadHistorial() : [];
          const _sortedHist = _hist
            .filter(h => h && h.result && h.result !== 'pending')
            .sort((a, b) => (b.commenceTs || new Date(b.date||0).getTime() || 0) - (a.commenceTs || new Date(a.date||0).getTime() || 0));
          const _existingIds = new Set(_finished.map(p => p.id).filter(Boolean));
          const _toAdd = _sortedHist
            .filter(h => h.id && !_existingIds.has(h.id))
            .slice(0, Math.max(6 - _finished.length, 0))
            .map(h => ({ ...h, _started: true, _histResult: h.result }));
          _finished = [..._finished, ..._toAdd];
        } catch(_e) {}
      }
      realPreds = _finished;
    } else if (tf === 'live') {      
      // 🆕 #596 Picks live se buscan en realPreds + historial completo (porque
      // picks WC pending pueden no estar en _aiPreds si buildPredsFromOdds los saltea)
      const _liveFromPreds = realPreds.filter(p => !!_isPickLive(p));
      let _liveAll = _liveFromPreds.slice();
      try {
        const _hist = (typeof loadHistorial === 'function') ? loadHistorial() : [];
        const _existingIds = new Set(_liveAll.map(p => p?.id).filter(Boolean));
        const _liveFromHist = (_hist || [])
          .filter(h => h && h.id && !_existingIds.has(h.id) && _isPickLive(h))
          .map(h => ({ ...h, _started: true, _histResult: h.result || 'pending' }));
        _liveAll = [..._liveAll, ..._liveFromHist];
      } catch(_e) {}
      realPreds = _liveAll;
      // 🆕 #594 Si no hay picks live, forzar empty state limpio y SALIR del render
      // (antes dejaba las cards anteriores visibles porque flujo posterior no actualizaba)
      if (!realPreds.length) {
        window._aiPreds = [];
        const _gridEl = document.getElementById('predGrid');
        if (_gridEl) {
          _gridEl.innerHTML = '<div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:64px 20px;gap:14px;text-align:center"><div style="font-size:2.4rem;opacity:0.7">⚫</div><div style="font-size:1.05rem;font-weight:700;color:#fff">No hay partidos en vivo ahora</div><div style="font-size:0.85rem;color:rgba(255,255,255,0.6);max-width:340px;line-height:1.5">El filtro EN JUEGO se activa cuando hay un partido en curso. Mientras tanto, mirá los próximos picks o el historial.</div><button onclick="filterPredTime(\'all\', document.querySelector(\'#predTimeTabs button.sport-tab\'))" style="background:var(--verde);color:#000;border:none;border-radius:30px;padding:9px 22px;font-size:0.84rem;font-weight:700;cursor:pointer;font-family:inherit;margin-top:6px">Ver todos los picks</button></div>';
        }
        return;
      }
    }
    if (!realPreds.length) realPreds = null;
  }

  // Sin datos reales: skeleton si está cargando, error si falló, empty state si genuinamente sin picks
  if (!realPreds) {
    const isLoading = _oddsLoading || !window._rawOddsGames;
    // Si hay auto-retry en curso, no pisar la UI del countdown
    if (_autoRetryTimer && _loadFailed) {
      window._aiPreds = [];
      return;
    }
    if (isLoading) {
      document.getElementById('predGrid').innerHTML = [1,2,3].map(() => `
        <div class="pred-card-skeleton">
          <div class="skel" style="height:12px;width:55%"></div>
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div class="skel" style="height:22px;width:38%"></div>
            <div class="skel" style="height:22px;width:28%"></div>
          </div>
          <div style="display:flex;justify-content:center;gap:24px;padding:10px 0">
            <div class="skel" style="height:52px;width:52px;border-radius:50%"></div>
            <div class="skel" style="height:52px;width:52px;border-radius:50%"></div>
          </div>
          <div class="skel" style="height:58px;width:100%;border-radius:10px"></div>
          <div style="display:flex;gap:6px">
            <div class="skel" style="height:14px;flex:1"></div>
            <div class="skel" style="height:14px;flex:1"></div>
            <div class="skel" style="height:14px;flex:1"></div>
          </div>
          <div style="display:flex;gap:6px">
            <div class="skel" style="height:44px;flex:1;border-radius:10px"></div>
            <div class="skel" style="height:44px;flex:1;border-radius:10px"></div>
            <div class="skel" style="height:44px;flex:1;border-radius:10px"></div>
          </div>
          <div style="text-align:center;font-size:0.68rem;color:var(--texto-sec);opacity:0.6">Cargando pronósticos...</div>
        </div>`).join('') + `
      <div style="text-align:center;padding:8px 0 16px;opacity:0;animation:fadeInSlow 1s 8s forwards">
        <button onclick="if(window._oddsLoading){return;}cacheSet('cache_odds_v10',null);loadRealOdds();" style="background:transparent;border:1px solid rgba(255,255,255,0.15);color:var(--texto-sec);padding:8px 20px;border-radius:20px;font-size:0.72rem;font-weight:700;cursor:pointer;font-family:inherit;transition:all .2s" onmouseover="this.style.borderColor='rgba(0,200,83,0.4)';this.style.color='var(--verde)'" onmouseout="this.style.borderColor='rgba(255,255,255,0.15)';this.style.color='var(--texto-sec)'">🔄 Reintentar</button>
        <div style="font-size:0.65rem;color:var(--texto-sec);opacity:0.5;margin-top:6px">La carga está tardando más de lo normal</div>
      </div>`;
    } else if (_loadFailed) {
      // Carga fallida sin datos stale — mostrar error con opción de recargar
      // (no mostramos "Sin pronósticos" porque no sabemos si los hay o no)
      if (!_autoRetryTimer) {
        document.getElementById('predGrid').innerHTML = `
          <div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:56px 20px 60px;gap:16px;text-align:center">
            <div style="font-size:2.2rem">📡</div>
            <div style="font-size:1.05rem;font-weight:700;color:var(--texto-pri)">Error al cargar los pronósticos</div>
            <div style="font-size:0.82rem;color:var(--texto-sec);max-width:320px;line-height:1.5">No se pudo conectar con el servidor. Revisá tu conexión o recargá la página.</div>
            <button onclick="clearTimeout(_autoRetryTimer);_autoRetryCount=0;_loadFailed=false;cacheSet('cache_odds_v10',null);localStorage.removeItem('cache_odds_stale_v10');loadRealOdds();"
              style="background:var(--verde);color:#000;border:none;border-radius:30px;padding:10px 26px;font-size:0.84rem;font-weight:700;cursor:pointer;font-family:inherit">
              🔄 Reintentar
            </button>
            <button onclick="location.reload()"
              style="background:transparent;border:1px solid rgba(255,255,255,0.18);color:var(--texto-sec);border-radius:30px;padding:8px 22px;font-size:0.76rem;font-weight:600;cursor:pointer;font-family:inherit">
              ↺ Recargar página
            </button>
          </div>`;
      }
    } else {
      document.getElementById('predGrid').innerHTML = (() => {
        const _isLogged = !!authUser;
        const _pushOk   = 'serviceWorker' in navigator && 'PushManager' in window;
        const _perm     = (typeof Notification !== 'undefined') ? Notification.permission : 'default';
        const _emailSub = localStorage.getItem('gb_email_notif_v1');

        // ── Card push (solo usuarios logueados, push soportado, no denegado) ──
        const _pushCard = (_isLogged && _pushOk && _perm !== 'denied') ? `
          <div id="esNotifCard" style="margin-top:4px;background:rgba(0,200,83,0.07);border:1px solid rgba(0,200,83,0.22);border-radius:14px;padding:16px 22px;max-width:320px;width:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:10px">
            <div style="font-size:0.88rem;font-weight:700;color:#fff">🔔 Avisame cuando haya picks</div>
            <div id="esPushStatus" style="font-size:0.75rem;color:var(--texto-sec);line-height:1.4">${_perm === 'granted' ? '¡Listo! Te avisamos cuando salgan los picks del día.' : 'Una notificación cuando la IA encuentre un pick de calidad.'}</div>
            <button id="esPushBtn" onclick="subscribeFromEmptyState()" style="background:${_perm==='granted'?'rgba(0,200,83,0.18)':'var(--verde)'};color:${_perm==='granted'?'var(--verde)':'#000'};border:${_perm==='granted'?'1.5px solid rgba(0,200,83,0.5)':'none'};border-radius:30px;padding:9px 22px;font-size:0.82rem;font-weight:700;cursor:pointer;font-family:inherit;transition:all .15s">
              ${_perm === 'granted' ? '🔔 Notificaciones activas' : 'Activar notificaciones'}
            </button>
          </div>` : '';

        // ── Card email (solo para no logueados) ──
        const _emailCard = !_isLogged ? (_emailSub ? `
          <div style="margin-top:4px;background:rgba(0,200,83,0.07);border:1px solid rgba(0,200,83,0.22);border-radius:14px;padding:14px 22px;max-width:320px;width:100%;box-sizing:border-box;text-align:center">
            <div style="font-size:0.9rem;font-weight:700;color:var(--verde)">✅ ¡Anotado!</div>
            <div style="font-size:0.75rem;color:var(--texto-sec);margin-top:5px">Te avisamos por mail cuando haya pronósticos de calidad.</div>
          </div>` : `
          <div id="esEmailCard" style="margin-top:4px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.12);border-radius:14px;padding:16px 22px;max-width:320px;width:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:10px">
            <div style="font-size:0.88rem;font-weight:700;color:#fff">📬 Avisame cuando haya pronósticos</div>
            <div style="font-size:0.75rem;color:var(--texto-sec);line-height:1.4">Te mandamos un mail solo cuando la IA encuentre picks de alta confianza.</div>
            <div style="display:flex;gap:8px;width:100%">
              <input id="esEmailInput" type="email" placeholder="tu@email.com"
                style="flex:1;min-width:0;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.18);border-radius:8px;padding:9px 12px;color:#fff;font-size:0.82rem;font-family:inherit;outline:none"
                onfocus="this.style.borderColor='var(--verde)';this.style.boxShadow='0 0 0 2px rgba(0,200,83,0.15)'"
                onblur="this.style.borderColor='rgba(255,255,255,0.18)';this.style.boxShadow='none'"
                onkeydown="if(event.key==='Enter')subscribeEmailNotif()">
              <button onclick="subscribeEmailNotif()" style="background:var(--verde);color:#000;border:none;border-radius:8px;padding:9px 16px;font-size:0.82rem;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0">Avisame</button>
            </div>
          </div>`) : '';

        // ── 🏆 Hype del Mundial 2026 ──
        // En lugar del placeholder genérico "sin picks hoy", aprovechamos el espacio
        // para promocionar las 10 predicciones del Mundial. Tres estados según la fecha.
        const _now = new Date();
        const _today = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate()).getTime();
        const _picksTs   = new Date(2026, 5, 6).getTime();  // 6-jun-2026 (publicación)
        const _kickoffTs = new Date(2026, 5, 11).getTime(); // 11-jun-2026 (kickoff)
        const _finalTs   = new Date(2026, 6, 19).getTime(); // 19-jul-2026 (final)
        const _dPicks   = Math.max(0, Math.round((_picksTs   - _today) / 86400000));
        const _dKickoff = Math.max(0, Math.round((_kickoffTs - _today) / 86400000));

        let _wcHeadline, _wcSubtitle, _wcCta, _wcEmoji;
        if (_today < _picksTs) {
          // FASE 1: aún no se publicaron las 10 predicciones (1-jun → 5-jun)
          _wcEmoji    = '🏆';
          _wcHeadline = `En ${_dPicks} día${_dPicks===1?'':'s'} la IA publica sus <span style="color:#d4af37">10 predicciones del Mundial</span>`;
          _wcSubtitle = `La IA cargó 10 apuestas a futuro del Mundial 2026: ganadores de grupo, clasificaciones, eliminatorias, dark horses, campeón y bota de oro. Cuotas frozen pre-torneo. Aparecen el 6 de junio.`;
          _wcCta      = `<div style="font-size:0.78rem;color:#d4af37;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;margin-top:8px">⚡ Vuelve el 6 de junio</div>`;
        } else if (_today < _kickoffTs) {
          // FASE 2: predicciones publicadas, falta el kickoff (6-jun → 10-jun)
          _wcEmoji    = '🔥';
          _wcHeadline = `Las <span style="color:#d4af37">10 predicciones del Mundial</span> ya están en el feed`;
          _wcSubtitle = `Falta${_dKickoff===1?'':'n'} ${_dKickoff} día${_dKickoff===1?'':'s'} para el kickoff. Las cuotas están locked desde el 6 de junio. Mirá quién dice la IA que gana el Mundial.`;
          _wcCta      = `<a href="#predicciones" style="display:inline-block;background:linear-gradient(135deg,#d4af37 0%,#b8941f 100%);color:#0d1f0d;font-weight:800;font-size:0.88rem;padding:11px 26px;border-radius:8px;text-decoration:none;letter-spacing:0.3px;margin-top:8px">Ver las 10 predicciones →</a>`;
        } else if (_today <= _finalTs) {
          // FASE 3: Mundial en curso (11-jun → 19-jul)
          _wcEmoji    = '⚽';
          _wcHeadline = `<span style="color:#d4af37">Mundial 2026 EN VIVO</span>`;
          _wcSubtitle = `La IA dejó 10 apuestas a futuro antes del torneo. Mirá cómo van. El feed de picks diarios vuelve cuando termine el Mundial.`;
          _wcCta      = `<a href="#predicciones" style="display:inline-block;background:linear-gradient(135deg,#d4af37 0%,#b8941f 100%);color:#0d1f0d;font-weight:800;font-size:0.88rem;padding:11px 26px;border-radius:8px;text-decoration:none;letter-spacing:0.3px;margin-top:8px">Ver predicciones del Mundial →</a>`;
        } else {
          // FASE 4: post-Mundial — fallback al mensaje genérico
          return `
            <div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 20px 60px;gap:14px;text-align:center">
              <div style="font-size:2.5rem">🔍</div>
              <div style="font-size:1.1rem;font-weight:700;color:var(--texto-pri)">Sin pronósticos de alta confianza hoy</div>
              <div style="font-size:0.85rem;color:var(--texto-sec);max-width:340px;line-height:1.5">La IA no encontró partidos con suficiente certeza para recomendar. Volvé más tarde cuando haya más partidos disponibles.</div>
              ${_pushCard}
              ${_emailCard}
            </div>`;
        }

        return `
          <div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:54px 20px 60px;gap:14px;text-align:center;background:linear-gradient(180deg,rgba(26,58,26,0.55) 0%,rgba(13,31,13,0.35) 100%);border:1.5px solid rgba(212,175,55,0.35);border-radius:14px;position:relative;overflow:hidden">
            <div style="position:absolute;top:0;left:0;right:0;height:1.5px;background:linear-gradient(90deg,transparent 0%,#d4af37 50%,transparent 100%);opacity:0.8"></div>
            <div style="font-size:3rem;filter:drop-shadow(0 2px 8px rgba(212,175,55,0.5));animation:gbMundialFloat 3.5s ease-in-out infinite">${_wcEmoji}</div>
            <div style="font-size:0.7rem;font-weight:800;letter-spacing:2.5px;color:#d4af37;text-transform:uppercase">⚡ Próximamente en gambeta.ai</div>
            <div style="font-size:1.25rem;font-weight:900;color:#fff;max-width:480px;line-height:1.3;letter-spacing:-0.2px">${_wcHeadline}</div>
            <div style="font-size:0.92rem;color:rgba(255,255,255,0.72);max-width:440px;line-height:1.55">${_wcSubtitle}</div>
            ${_wcCta}
            ${_pushCard}
            ${_emailCard}
          </div>`;
      })();
    }
    window._aiPreds = [];
    return;
  }
  // ── Dedup final: nunca mostrar dos fichas del mismo partido ──
  // Prioridad: picks de la API (no _fromHist) sobre los del historial
  if (realPreds && realPreds.length > 1) {
    const _seen = [];
    realPreds = realPreds.filter(p => {
      const alreadySeen = _seen.some(s => teamsMatch(s.home, p.home) && teamsMatch(s.away, p.away));
      if (alreadySeen) return false; // descartar duplicado
      _seen.push(p);
      return true;
    });
  }

  // ── 🔒 ORDEN PERSONALIZADO + showcase de aciertos en el HOME ──
  //   UPCOMING (slots 1-6 home / todos en subpágina):
  //     1°: pick más popular (LEAGUE_PRIO desc → bvr desc)
  //     2°: más próximo a comenzar
  //     3°: más likeado (excluyendo los ya elegidos)
  //     4°: 2° más próximo
  //     5°: 3° más próximo
  //     6°: 2° más popular
  //     resto: por popularidad
  //   HOME slots 7-9: aciertos del historial → social proof.
  //     7°: mejor acierto, 8°: 2° mejor, 9°: cualquiera (win pref, fallo si faltan).
  const _isPicksSubPage = document.body.dataset.gbpage === 'picks';

  // Separar upcoming (no iniciados, no resueltos) vs finalizados
  let _upcoming = realPreds.filter(p => !p._started && p.result !== 'win' && p.result !== 'loss');

  // Aplicar orden custom solo a UPCOMING
  if (_upcoming.length > 1) {
    const _origLen = _upcoming.length;
    _upcoming.forEach((p, i) => {
      try { p._likesScore = (typeof _getFakeLikes === 'function') ? _getFakeLikes(i, _origLen) : 0; }
      catch(_) { p._likesScore = 0; }
    });
    // Prio efectiva: liga base + boost de etapa (final/semi/quarter/r16).
    // Una FINAL pesa +60, una SEMI +35 — así una final de Europa League queda
    // por encima de partidos de fase de grupos de ligas con prio base mayor.
    const _STAGE_BOOST_R = { final: 60, semi: 35, quarter: 15, r16: 5 };
    const _prioOf = (p) => {
      const base = (typeof getGamePrio === 'function')
        ? getGamePrio(p._sportKey || p.sport_key) : 0;
      return base + (_STAGE_BOOST_R[p._stage] || 0);
    };
    const _bySocial   = (a, b) => {
      const da = _prioOf(b) - _prioOf(a);
      if (da) return da;
      return (b.bvr || 0) - (a.bvr || 0);
    };
    const _byCommence = (a, b) => (a.commenceTs || Infinity) - (b.commenceTs || Infinity);
    const _byLikes    = (a, b) => (b._likesScore || 0) - (a._likesScore || 0);

    const _picked = [];
    const _pool = _upcoming.slice();
    const _take = (sorter) => {
      const sorted = _pool.slice().sort(sorter);
      const top = sorted.find(p => !_picked.includes(p));
      if (!top) return;
      _picked.push(top);
      const ix = _pool.indexOf(top);
      if (ix >= 0) _pool.splice(ix, 1);
    };
    _take(_bySocial);    // 1
    _take(_byCommence);  // 2
    _take(_byLikes);     // 3
    _take(_byCommence);  // 4
    _take(_byCommence);  // 5
    _take(_bySocial);    // 6
    _pool.sort(_bySocial);
    _upcoming = [..._picked, ..._pool];
    _upcoming.forEach(p => { delete p._likesScore; });
  }

  // Showcase de aciertos para el HOME (slots 7-9)
  let _homeShowcase = [];
  if (!_isPicksSubPage) {
    try {
      const _hist = (typeof loadHistorial === 'function') ? loadHistorial() : [];
      const _stakeOf = h => h.stake || (h.bvr === 6 ? 170 : h.bvr === 5 ? 130 : h.bvr === 4 ? 50 : 30);
      const _resolvedHist = _hist.filter(h => (h.result === 'win' || h.result === 'loss')
        && h.commenceTs && (Date.now() - h.commenceTs) < 7 * 24 * 3600 * 1000); // últimos 7 días
      // Slot 7-8: wins MÁS RECIENTES (no los de mayor stake) → mejor sensación de "ganamos hoy/ayer"
      // Slot 9: si hay 3er win, usar otro reciente; sino fallback loss.
      const _wins   = _resolvedHist.filter(h => h.result === 'win')
        .sort((a, b) => (b.commenceTs || 0) - (a.commenceTs || 0)); // más recientes primero
      const _losses = _resolvedHist.filter(h => h.result === 'loss')
        .sort((a, b) => (b.commenceTs || 0) - (a.commenceTs || 0));
      // Slot 7: mejor acierto
      if (_wins[0]) _homeShowcase.push(_wins[0]);
      // Slot 8: 2do mejor acierto
      if (_wins[1]) _homeShowcase.push(_wins[1]);
      // Slot 9: cualquiera (preferí 3er acierto, fallback fallo)
      if (_wins[2]) _homeShowcase.push(_wins[2]);
      else if (_losses[0]) _homeShowcase.push(_losses[0]);
      // Si aún faltan, rellenar con fallos
      let _lossIdx = (_homeShowcase[2] && _homeShowcase[2].result === 'loss') ? 1 : 0;
      while (_homeShowcase.length < 3 && _losses[_lossIdx]) {
        _homeShowcase.push(_losses[_lossIdx]); _lossIdx++;
      }
      // Marcar como histórico para rendering — incluir _histResult/_histScore/confLabel
      _homeShowcase = _homeShowcase.map(h => ({
        ...h,
        _fromHist:    true,
        _started:     true,
        _showcase:    true,
        _histResult:  h.result || 'pending',
        _histScore:   h.finalScore || null,
        confLabel:    h.bvrText || h.confLabel || (h.bvr === 6 ? 'Máxima' : h.bvr === 5 ? 'Alta' : h.bvr === 4 ? 'Media-Alta' : 'Media'),
        conf:         h.conf || (h.bvr >= 5 ? 'high' : h.bvr >= 4 ? 'med' : 'low'),
      }));
    } catch(_) { _homeShowcase = []; }
  }

  // Reconstruir realPreds según vista
  if (_isPicksSubPage) {
    realPreds = _upcoming; // subpágina: solo upcoming, sin finalizados
  } else {
    // 🏆 WC Largo Plazo necesita mostrar los 10 picks futures completos,
    // no los 6 que caben en el home normal. Detectar y subir el cap.
    const _isWcFutures = window._predSportFilter === 'wcfutures';
    const _homeUpLimit = _isWcFutures ? 20 : 6;
    realPreds = [..._upcoming.slice(0, _homeUpLimit), ..._homeShowcase];
  }

  // WC Largo Plazo: subir el cap para que los 10 picks futures (Mbappé, España campeón,
  // Argentina semis, Marruecos cuartos, Noruega octavos, etc.) se muestren todos.
  const HOME_PICKS_LIMIT = window._predSportFilter === 'wcfutures' ? 20 : 9;
  let source = _isPicksSubPage ? realPreds : realPreds.slice(0, HOME_PICKS_LIMIT);

  // ── Banner de estado ──
  const statusBar = document.getElementById('predsStatusBar');
  if (statusBar) {
    if (isLive) {
      statusBar.style.display = 'flex';
      statusBar.style.background = 'rgba(0,200,83,0.08)';
      statusBar.style.border = '1px solid rgba(0,200,83,0.25)';
      statusBar.style.color = '#00c853';
      const _sfLabels = {
        champions:'🏆 Champions', europa:'🟠 Europa League', conference:'🟣 Conference',
        premier:'🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League', laliga:'🇪🇸 La Liga', bundesliga:'🇩🇪 Bundesliga',
        seriea:'🇮🇹 Serie A', ligue1:'🇫🇷 Ligue 1', eredivisie:'🇳🇱 Eredivisie',
        scotland:'🏴󠁧󠁢󠁳󠁣󠁴󠁿 Escocia', turkey:'🇹🇷 Süper Lig',
        libertadores:'🌎 Libertadores', sudamericana:'🌎 Sudamericana',
        arg:'🇦🇷 Argentina', bra:'🇧🇷 Brasil', mexico:'🇲🇽 Liga MX',
        mls:'🇺🇸 MLS', uruguay:'🇺🇾 Uruguay', saudi:'🇸🇦 Arabia Saudita', japan:'🇯🇵 Japón',
        portugal:'🇵🇹 Portugal', denmark:'🇩🇰 Dinamarca', sweden:'🇸🇪 Suecia', norway:'🇳🇴 Noruega',
        poland:'🇵🇱 Polonia', czech:'🇨🇿 Chequia', switzerland:'🇨🇭 Suiza', austria:'🇦🇹 Austria',
        greece:'🇬🇷 Grecia', russia:'🇷🇺 Rusia', chile:'🇨🇱 Chile', colombia:'🇨🇴 Colombia',
        ecuador:'🇪🇨 Ecuador', peru:'🇵🇪 Perú', venezuela:'🇻🇪 Venezuela', bolivia:'🇧🇴 Bolivia',
        paraguay:'🇵🇾 Paraguay', korea:'🇰🇷 K League', australia:'🇦🇺 Australia',
        todos:'📋 Todos', soccer:'⚽ Fútbol', europe:'🌍 Fútbol Europeo', latam:'🌎 Latam'
      };
      const sfLabel = _sfLabels[window._predSportFilter] ? ' · ' + _sfLabels[window._predSportFilter] : '';
      statusBar.style.display = 'none'; // ocultado por pedido de Mauro
    } else {
      // No mostrar banner de error a los visitantes
      statusBar.style.display = 'none';
    }
  }

  // Exponer predicciones al chat IA
  // ── 🛡️ HARD FILTER Mundial 2026: descartar picks con fixture inexistente ──
  // Whitelist oficial de partidos. Si pick WC no está acá → descartado.
  const _WC_VALID_FIXTURES = new Set([
    // Grupo A
    'México|Sudáfrica','México|Honduras','México|Bolivia','Sudáfrica|Honduras','Sudáfrica|Bolivia','Honduras|Bolivia',
    // Grupo B
    'Canadá|Bosnia','Canadá|Suiza','Canadá|Catar','Bosnia|Suiza','Bosnia|Catar','Suiza|Catar',
    // Grupo C
    'Estados Unidos|Paraguay','Estados Unidos|Inglaterra','Estados Unidos|Croacia','Paraguay|Inglaterra','Paraguay|Croacia','Inglaterra|Croacia',
    // Grupo D
    'Alemania|Curaçao','Alemania|Corea del Sur','Alemania|Iraq','Curaçao|Corea del Sur','Curaçao|Iraq','Corea del Sur|Iraq',
    // Grupo E
    'Países Bajos|Japón','Países Bajos|Arabia Saudí','Países Bajos|Ghana','Japón|Arabia Saudí','Japón|Ghana','Arabia Saudí|Ghana',
    // Grupo F
    'Brasil|Marruecos','Brasil|Turquía','Brasil|Noruega','Marruecos|Turquía','Marruecos|Noruega','Turquía|Noruega',
    // Grupo G
    'España|Cabo Verde','España|Australia','España|Nueva Zelanda','Cabo Verde|Australia','Cabo Verde|Nueva Zelanda','Australia|Nueva Zelanda',
    // Grupo H
    'Colombia|Uzbekistán','Colombia|Ecuador','Colombia|Costa Marfil','Uzbekistán|Ecuador','Uzbekistán|Costa Marfil','Ecuador|Costa Marfil',
    // Grupo I
    'Bélgica|Egipto','Bélgica|Argelia','Bélgica|Irán','Egipto|Argelia','Egipto|Irán','Argelia|Irán',
    // Grupo J — Argentina aquí: Argelia, Austria, Jordania (NO Senegal)
    'Argentina|Argelia','Argentina|Austria','Argentina|Jordania','Argelia|Austria','Argelia|Jordania','Austria|Jordania',
    // Grupo K
    'Francia|Senegal','Francia|Uruguay','Francia|Túnez','Senegal|Uruguay','Senegal|Túnez','Uruguay|Túnez',
    // Grupo L
    'Portugal|RD Congo','Portugal|Haití','Portugal|Escocia','RD Congo|Haití','RD Congo|Escocia','Haití|Escocia',
  ]);
  // Aplicar override de resultados conocidos WC2026 antes del filtro
  if (typeof resolveWcLocal === 'function') {
    source = source.map(p => resolveWcLocal(p));
  }
  // BLACKLIST de fantasmas confirmados (NO whitelist — el sistema necesita permitir futures + eliminatorias)
  const _WC_GHOST_FIXTURES = new Set([
    'Argentina|Senegal','Senegal|Argentina',
    'Estados Unidos|Noruega','Noruega|Estados Unidos','USA|Noruega','Noruega|USA',
    'Brasil|Portugal','Portugal|Brasil',
    'Alemania|Túnez','Túnez|Alemania',
    'Francia|Costa Rica','Costa Rica|Francia',
    'Inglaterra|Polonia','Polonia|Inglaterra',
    'Argentina|Brasil','Brasil|Argentina',
    'Canadá|Japón','Japón|Canadá',
  ]);
  source = source.filter(p => {
    if (p._sportKey !== 'soccer_fifa_world_cup') return true;
    const key = (p.home||'') + '|' + (p.away||'');
    if (_WC_GHOST_FIXTURES.has(key)) {
      console.warn('[WC BLACKLIST] Descartado pick fantasma:', p.home, 'vs', p.away);
      return false;
    }
    return true; // todo lo demás pasa (futures, eliminatorias, etc)
  });

  // 🏆 WC_ONLY_MODE — hasta que termine el Mundial (19-jul-2026) mostramos SOLO Mundial.
  // Sacamos picks de otras ligas y picks que se juegan después del Mundial.
  // 🆕 (23-jun-2026) Mauro pidió empezar a pronosticar Primera Nacional Argentina + empates.
  //    Desactivamos el filtro WC_ONLY que solo mostraba picks del Mundial.
  //    Si querés volver a solo Mundial: cambiar a true.
  const WC_ONLY_MODE = false;
  const WC_END_TS = new Date('2026-07-20T00:00:00-03:00').getTime();
  if (WC_ONLY_MODE) {
    const before = source.length;
    source = source.filter(p => {
      const isMundial = p._sportKey === 'soccer_fifa_world_cup'
                     || (p.league || '').includes('Mundial');
      if (!isMundial) return false;
      // Bloquear picks después del Mundial (futures lejanos jul/ago/etc)
      if (p.commenceTs && p.commenceTs > WC_END_TS) return false;
      return true;
    });
    if (before !== source.length) {
      console.log('[WC_ONLY_MODE] Filtrados', before - source.length, 'picks no-Mundial / post-Mundial');
    }
  }

  window._aiPreds = source;

  // 🏆 FORO AUTO-GENERATE — para cada pick Mundial pending, crear thread del foro automáticamente
  // (antes solo se creaba cuando el usuario clickeaba el botón de foro en una ficha)
  try {
    if (typeof forumEnsureThread === 'function' && Array.isArray(source)) {
      const wcPickToOpen = source.filter(p =>
        p &&
        (p._sportKey === 'soccer_fifa_world_cup' || (p.league||'').includes('Mundial')) &&
        p.home && p.away &&
        (!p.result || p.result === 'pending') &&
        p.commenceTs && p.commenceTs > Date.now() - 6*60*60*1000
      );
      // Crear threads silenciosamente — no bloquea render
      (async () => {
        for (const pick of wcPickToOpen) {
          try { await forumEnsureThread(pick); } catch(e) {}
        }
        if (wcPickToOpen.length > 0) {
          console.log('[Foro] Auto-generados', wcPickToOpen.length, 'threads Mundial');
        }
      })();
    }
  } catch(e) { console.warn('[Foro auto-gen]', e.message); }

  // CTA banner DBbet eliminado — el botón 1-click ya cumple esa función
  const affCtaHtml = '';

  // ── Pick del Finde: sólo el pick pinneado por admin (_estrellaOverride) ──
  const _dow = new Date().getDay();
  const _isFindeW = _dow === 5 || _dow === 6 || _dow === 0;
  const _findePickIdx = (() => {
    if (!_isFindeW) return -1;
    // Si hay override de admin, usar ese pick exacto
    if (window._estrellaOverride) {
      const idx = source.findIndex(p =>
        teamsMatch(p.home, window._estrellaOverride.home) &&
        teamsMatch(p.away, window._estrellaOverride.away)
      );
      if (idx !== -1) return idx;
    }
    // Fallback: primer bvr=6 sin iniciar (comportamiento original)
    return source.findIndex(p => (p.bvr || 0) >= 6 && !p._started);
  })();

  document.getElementById('predGrid').innerHTML = source.map((p, idx) => {
    // BVR: usar valor guardado en p, o derivar de p.conf para datos estáticos
    const _bvr     = p.bvr     || (p.conf==='high' ? 5 : 3);
    const _bvrText = p.bvrText || (p.conf==='high' ? 'Alta' : 'Media');
    // Estrellas en lugar de monedas Gambeta Coin (visual de confianza)
    const _bvrStarsHtml = Array.from({length:6}, (_,i) =>
      `<span class="bvr-gem ${i < _bvr ? 'active-'+_bvr : ''}">★</span>`
    ).join('');
    const bvrHtml = `<div class="bvr-wrap">
      <span class="bvr-label">Confianza IA</span>
      <div class="bvr-gems">${_bvrStarsHtml}</div>
    </div>`;

    const oddsHtml = affCtaHtml;

    // Detectar si el partido está en vivo en scoresData
    const liveEntry = scoresData.find(s =>
      (s.flag === 'live' || s.flag === 'final') &&
      (teamsMatch(s.home, p.home) || teamsMatch(s.homeRaw || s.home, p.home)) &&
      (teamsMatch(s.away, p.away) || teamsMatch(s.awayRaw || s.away, p.away))
    );
    const isGameLive = !!liveEntry && liveEntry.flag === 'live';

    // Estado del partido para la tarjeta
    const isStarted      = !!p._started;
    const histResult     = p._histResult || 'pending'; // 'win'|'loss'|'void'|'pending'
    const histScore      = p._histScore  || null;
    const isFinishedWin  = isStarted && histResult === 'win'  && !isGameLive; // no mostrar como acertado si aún está en vivo
    const isFinishedLoss = isStarted && histResult === 'loss' && !isGameLive;
    const isHighConfWin  = isFinishedWin && (p.bvr >= 6 || (!p.bvr && p.conf === 'high')); // bvr≥6 = máxima confianza → dorado
    const isPending      = isStarted && (histResult === 'pending' || isGameLive); // en vivo = pendiente todavía
    // Score final — si no está en historial intentar desde scoresData (solo si el partido terminó)
    const finalScore = !isGameLive
      ? (histScore || (isStarted && liveEntry?.flag === 'final' ? `${liveEntry.scoreH}-${liveEntry.scoreA}` : null))
      : null;
    // Confianza máxima: bvr=6 sin iniciar
    const isMaxConf     = !isStarted && _bvr >= 6;
    const isPickFinde   = isMaxConf && idx === _findePickIdx;
    // Clase CSS de la tarjeta (pendientes sin opacidad — solo los terminados se atenúan)
    const cardClass = isHighConfWin             ? 'pred-golden-win'
                    : isFinishedWin             ? 'pred-card-win'
                    : isFinishedLoss            ? 'pred-card-loss'
                    : (isStarted && !isPending) ? 'pred-card-finished'
                    : isMaxConf                 ? 'pred-card-max'
                    : '';
    // ── Etapa del torneo: ficha especial para finales/semis ──
    const _stage = p._stage || null;
    const _isBigStage = _stage === 'final' || _stage === 'semi';
    const _stageLabels = {
      final:   '🏆 Gran Final',
      semi:    '🥈 Semifinal',
      quarter: '⚔️ Cuartos de Final',
      r16:     '🎯 Octavos de Final',
    };
    const _stageBadgeHtml = (_stage && _stageLabels[_stage] && !isStarted) ? `
      <div class="pred-stage-badge ${_stage==='final'?'':_stage==='semi'?'stage-semi':'stage-minor'}">
        ${_stageLabels[_stage]}
      </div>` : '';
    const _stageCardClass = _isBigStage && !isStarted ? ' pred-card-final' : '';
    // Badge de resultado (nunca mostrar si el partido sigue en vivo)
    const resultBadgeHtml = '';

    // H2H mini (solo para datos estáticos con matchAnalysisData)
    const mdKey = `${p.home}-${p.away}`;
    const md = !isLive && typeof matchAnalysisData !== 'undefined' ? matchAnalysisData[mdKey] : null;
    let h2hHtml = '';
    if (md && md.h2h && md.h2h.length) {
      h2hHtml = `<div class="pred-h2h-mini">⚔️ H2H reciente</div>` +
        md.h2h.slice(0,3).map(m => {
          const cls = m.res==='G'||m.res==='W' ? 'phx-w' : m.res==='P'||m.res==='L' ? 'phx-l' : 'phx-d';
          return `<div class="pred-h2h-row">
            <span class="pred-h2h-date">${m.date}</span>
            <span>${m.home} vs ${m.away}</span>
            <span class="pred-h2h-score ${cls}">${m.score}</span>
          </div>`;
        }).join('');
    }

    // Forma reciente (solo si hay datos)
    const hasForm = p.formH?.length || p.formA?.length;
    const formRow = hasForm ? `
      <div class="pred-form-row">
        <div class="pred-form-side">
          <div class="pred-form-dots">${formDots(p.formH)}</div>
          <div class="pred-form-label">Forma local</div>
        </div>
        <div class="pred-form-divider">Últimos 5</div>
        <div class="pred-form-side">
          <div class="pred-form-dots">${formDots(p.formA)}</div>
          <div class="pred-form-label">Forma visit.</div>
        </div>
      </div>` : '';

    // ── Variables para apuesta  en cuotas ──
    const _cardMatchId = (p.homeRaw||p.home) + '__' + (p.awayRaw||p.away);
    const _cardOddsH = p._hO ? parseFloat(p._hO) : (p.probH > 0 ? parseFloat((100/p.probH).toFixed(2)) : 2);
    const _cardOddsD = p._dO ? parseFloat(p._dO) : (p.probD > 0 ? parseFloat((100/p.probD).toFixed(2)) : 0);
    const _cardOddsA = p._aO ? parseFloat(p._aO) : (p.probA > 0 ? parseFloat((100/p.probA).toFixed(2)) : 2);

    const _cardId = 'predcard-' + (p.home+'-'+p.away).toLowerCase().replace(/[^a-z0-9]+/g,'-');
    return `
    <div id="${_cardId}" class="pred-card ${cardClass}${_stageCardClass}" style="${
      isGameLive
        ? 'border-color:rgba(229,57,53,0.4)'
        : (!isStarted && !isMaxConf && p.conf==='high')
          ? 'border-color:rgba(255,214,0,0.55);box-shadow:0 0 28px rgba(255,214,0,0.18),0 4px 16px rgba(0,0,0,0.4);background:linear-gradient(180deg,rgba(255,214,0,0.06) 0%,var(--gris-card) 60%)'
          : ''
    }">
      ${_stageBadgeHtml}
      ${(!isGameLive && isStarted && finalScore && (histResult === 'win' || histResult === 'loss')) ? (() => {
        const _isWin = histResult === 'win';
        const _icon = _isWin
          ? '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 12.5 L10 17 L19 7.5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
        return `<div class="pred-result-strip ${_isWin ? 'pred-result-strip--win' : 'pred-result-strip--loss'}">
          <span class="pred-result-strip__icon">${_icon}</span>
          <span class="pred-result-strip__label">${_isWin ? 'Acertado' : 'Fallado'}</span>
          <span class="pred-result-strip__sep"></span>
          <span class="pred-result-strip__score">${_translateMatchState(finalScore)}</span>
          <span class="pred-result-strip__spacer"></span>
          <span class="pred-result-strip__status">Final</span>
        </div>`;
      })() : ''}
      ${isMaxConf ? `
        <div class="max-sparkles">
          <span>✦</span><span>✦</span><span>★</span><span>✦</span><span>★</span><span>✦</span>
        </div>
        ${isPickFinde ? `<div class="pred-finde-badge">⭐ PICK DEL FINDE</div>` : ''}` : ''}
      <div class="pred-header">
        <span style="font-size:0.78rem;color:var(--texto-sec);display:flex;align-items:center;gap:4px">${(() => {
          const _lgRaw = (p._sportKey ? (sportKeyToLeague(p._sportKey, p.home, p.away) || p.league) : p.league) || '';
          let lg = (_lgRaw && _lgRaw !== 'Fútbol' && _lgRaw !== 'Tenis' && _lgRaw !== 'Liga') ? leagueShort(_lgRaw) : '';
          // Calcular tiempo siempre desde commenceTs (evita strings "Hoy/Mañ." stale del caché)
          // _dateIcon: ‼️ si es HOY, 🗓️ si es Mañ./futuro — reemplaza la pelota ⚽ del fallback de liga
          let _dateIcon = '';
          const _fmtTs = (ts) => {
            if (!ts) return '';
            const _md = new Date(ts);
            const _td = new Date(); _td.setHours(0,0,0,0);
            const _cd = new Date(_md); _cd.setHours(0,0,0,0);
            const _diff = Math.round((_cd - _td) / 86400000);
            const _ts = _md.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',hour12:false});
            if (_diff === 0)      _dateIcon = '‼️';
            else if (_diff >= 1)  _dateIcon = '🗓️';
            return (_diff === -1 ? 'Ayer' : _diff === 0 ? 'Hoy' : _diff === 1 ? 'Mañ.' : _md.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'})) + ' · ' + _ts;
          };
          const t  = isGameLive ? '🔴 EN VIVO'
                   : p.commenceTs ? _fmtTs(p.commenceTs)   // siempre dinámico si hay timestamp
                   : p.time || '';                           // fallback para picks muy viejos sin ts
          // Reemplazar fallback ⚽ por icono de fecha si aplica; si no, prependear el icono a la liga real
          if (_dateIcon && !isGameLive) {
            if (lg === '⚽' || lg === '') lg = _dateIcon;
            else lg = _dateIcon + ' ' + lg;
          }
          return [lg, t].filter(Boolean).join(' · ');
        })()}</span>
        <div style="display:flex;align-items:center;gap:6px">
          ${resultBadgeHtml}
          <div style="display:flex;align-items:center;gap:6px">
            <span class="confidence-badge ${p.conf==='high'?'conf-high':'conf-med'}">${(p.bvr === 6 || p.confLabel === 'Máxima' || p.bvrText === 'Máxima') ? '🔥 CONFIANZA MÁXIMA · 6/6' : (p.confLabel || p.bvrText || (p.conf==='high'?'Alta':p.conf==='med'?'Media-Alta':'Media'))}</span>
          </div>
        </div>
      </div>
      ${bvrHtml}
      <div class="pred-ia-strip" id="iastrip-${_cardId}" style="display:none"></div>
      <div class="pred-match">
        <div class="pred-team">
          <div class="pred-emoji">${logoHtml((p._sportKey?.includes('conmebol') && (p.homeRaw||p.home)==='Barcelona') ? 'Barcelona SC' : (p.homeRaw||p.home), 64)}</div>
          <div class="pred-tname">${shortName(p.home)}</div>
        </div>
        ${isGameLive
          ? (()=>{
              const _lv = (typeof _isPickLive === 'function') ? _isPickLive(p) : null;
              const _sh = (liveEntry && liveEntry.scoreH != null) ? liveEntry.scoreH : (_lv && _lv.scoreH != null ? _lv.scoreH : '-');
              const _sa = (liveEntry && liveEntry.scoreA != null) ? liveEntry.scoreA : (_lv && _lv.scoreA != null ? _lv.scoreA : '-');
              const _min = (_lv && _lv.minute) ? _lv.minute : "LIVE";
              return `<div class="pred-live-block">
                <div class="pred-live-min"><span class="pred-live-dot"></span>${_min}</div>
                <div class="pred-live-score">${_sh}<span class="pred-live-dash">·</span>${_sa}</div>
              </div>`;
            })()
          : (!isPending && isStarted && finalScore)
          ? `<div style="text-align:center">
               <div class="pred-final-score ${isHighConfWin ? 'score-gold-win' : isFinishedWin ? 'score-win' : isFinishedLoss ? 'score-loss' : 'score-void'}">
                 ${_translateMatchState(finalScore)}
               </div>
               <div style="font-size:0.6rem;color:#666;margin-top:4px;letter-spacing:.5px">FINAL</div>
             </div>`
          : `<div class="pred-vs">VS</div>`
        }
        <div class="pred-team">
          <div class="pred-emoji">${logoHtml((p._sportKey?.includes('conmebol') && (p.awayRaw||p.away)==='Barcelona') ? 'Barcelona SC' : (p.awayRaw||p.away), 64)}</div>
          <div class="pred-tname">${shortName(p.away)}</div>
        </div>
      </div>
      ${formRow}
      <div class="pred-recommendation">
        <div class="pred-rec-left">
          <div class="pred-rec-label">🤖 Recomendación IA</div>
          <div class="pred-rec-value">${isFinishedLoss ? '❌' : isFinishedWin ? '✅' : '🎯'} ${_recLabel(p.rec, p.home, p.away)}</div>
          ${(()=>{ const _u = buildPickBlogUrl(p); return _u ? `<a href="${_u}" class="pred-saber-mas" title="Leer análisis completo del pick"><span class="sm-ico">📖</span> Análisis completo <span class="sm-arrow">→</span></a>` : ''; })()}
        </div>
        <div class="pred-rec-right">
          ${(()=>{ const _s=_recSideOf(p); const _roRaw = _s==='home' ? (p._hO ? parseFloat(p._hO) : null) : _s==='away' ? (p._aO ? parseFloat(p._aO) : null) : _s==='draw' ? (p._dO ? parseFloat(p._dO) : null) : (p._bestOdds ? parseFloat(p._bestOdds) : null); if (!_roRaw) return ''; const _roShown = isMaxConf ? (_roRaw * 0.95).toFixed(2) : _roRaw.toFixed(2); return `<div class="pred-rec-odds">${_roShown}</div>`; })()}
        </div>
      </div>
      ${(p.probH > 0 || p.probA > 0) ? `
      <div class="pred-bars">
        <div class="pred-bar-item">
          <span class="pred-bar-label">Local</span>
          <div class="pred-bar-bg"><div class="pred-bar-fill fill-home" style="width:${p.probH}%"></div></div>
          <div class="pred-bar-pct">${p.probH}%</div>
        </div>
        ${p.probD > 0 ? `<div class="pred-bar-item">
          <span class="pred-bar-label">Empate</span>
          <div class="pred-bar-bg"><div class="pred-bar-fill fill-draw" style="width:${p.probD}%"></div></div>
          <div class="pred-bar-pct">${p.probD}%</div>
        </div>` : ''}
        <div class="pred-bar-item">
          <span class="pred-bar-label">Visitante</span>
          <div class="pred-bar-bg"><div class="pred-bar-fill fill-away" style="width:${p.probA}%"></div></div>
          <div class="pred-bar-pct">${p.probA}%</div>
        </div>
      </div>
` : ''}

      ${_buildIAReasoning(p)}
      ${!isFinishedWin && !isFinishedLoss ? (()=>{
        const _pickShort = _recLabel(p.rec, p.home, p.away);
        const _side = _recSideOf(p);
        // DBbet siempre muestra la cuota REAL (sin el descuento del 5% de máxima conf)
        // Esto crea el incentivo: usuario ve cuota mejor en DBbet vs cuota normal
        const _oddsRaw = _side==='home' ? (p._hO ? parseFloat(p._hO) : null)
                       : _side==='away' ? (p._aO ? parseFloat(p._aO) : null)
                       : _side==='draw' ? (p._dO ? parseFloat(p._dO) : null)
                       : (p._bestOdds ? parseFloat(p._bestOdds) : null);
        const _odds = _oddsRaw ? _oddsRaw.toFixed(2) : null;
        return `
        <a class="pred-dbbet-1click" href="${buildDBbetCouponURL(p)}" target="_blank" rel="noopener" onclick="return betOnDBbetPick({matchId:${p.matchId ? "'"+p.matchId+"'" : 'null'},home:'${(p.home||'').replace(/'/g,"\\'")}',away:'${(p.away||'').replace(/'/g,"\\'")}',rec:'${(p.rec||'').replace(/'/g,"\\'")}',_recSide:'${p._recSide||''}',_bestOdds:${p._bestOdds||'null'},fecha:'${p.fecha||p.kickoff||''}'});" aria-label="Apostar ${_pickShort} en DBbet">
          <svg class="db-logo-svg" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 152 26" aria-hidden="true">
            <path fill="#fff" d="M71 25.23h8.51l.42-2.05H80a4.98 4.98 0 0 0 2.64 2.11c1.2.5 2.74.7 4.64.7 2.5 0 4.78-.53 6.86-1.66a12.08 12.08 0 0 0 4.78-4.62 13.01 13.01 0 0 0 1.73-6.61c0-2.4-.81-4.28-2.43-5.65-1.62-1.38-3.83-2.09-6.65-2.09-3.58 0-6.33.92-8.2 2.72h-.06L84.99 0h-8.8L71 25.23ZM87.42 11.3a4.7 4.7 0 0 1 3.03.84c.7.56 1.05 1.38 1.05 2.44.02 1.43-.5 2.8-1.47 3.85-.98 1.1-2.43 1.63-4.36 1.63-1.4 0-2.47-.25-3.1-.78-.63-.5-.95-1.24-.95-2.23a8.2 8.2 0 0 1 .35-2.15c.22-.75.6-1.44 1.12-2.02a4.84 4.84 0 0 1 1.87-1.2 7.4 7.4 0 0 1 2.46-.38Zm23.68 6.32h19.34c.26-1.22.4-2.46.42-3.7 0-2.94-1.02-5.13-3.06-6.62-2.04-1.44-5.13-2.19-9.35-2.19-3.52 0-6.54.64-9.04 1.84a12.06 12.06 0 0 0-5.45 4.8 12.43 12.43 0 0 0-1.68 6.22 6.65 6.65 0 0 0 3.16 5.97c1.06.7 2.4 1.2 3.94 1.55 1.55.35 3.38.5 5.52.5 3.8 0 6.96-.53 9.5-1.66a11.46 11.46 0 0 0 5.59-4.91h-9.37c-.52.56-1.17 1-1.9 1.27-.73.28-1.75.42-3.02.42a6.04 6.04 0 0 1-3.41-.81 2.55 2.55 0 0 1-1.23-2.26l.04-.42Zm11.4-4.45H112a4.68 4.68 0 0 1 2.18-2.58 7.87 7.87 0 0 1 3.73-.81c1.49 0 2.6.28 3.41.8a2.5 2.5 0 0 1 1.2 2.16l-.04.43Zm25.78 12.05 1.05-5.16c-.7.07-1.65.07-2.81.07-.7 0-1.2-.07-1.48-.25-.28-.14-.42-.42-.42-.84.03-.37.09-.74.17-1.1l1.34-6.54h4.75L152 5.9h-4.75L148.5 0h-8.8l-1.23 5.9h-4.08l-1.12 5.5h4.08l-1.66 8c-.2.83-.3 1.68-.31 2.54 0 .98.2 1.73.7 2.25a3.6 3.6 0 0 0 1.82 1.13c.78.21 2.08.32 3.9.32 1.38 0 2.6-.04 3.7-.11a25.5 25.5 0 0 0 2.79-.3Z"/>
            <path fill="#FFD700" d="M36 25h21.59a16.8 16.8 0 0 0 4.35-.5 9.75 9.75 0 0 0 3.64-1.75c1.09-.87 1.94-2 2.49-3.28.6-1.34.91-2.6.91-3.78a5.08 5.08 0 0 0-.87-2.91 4.07 4.07 0 0 0-2.32-1.61v-.07a5.92 5.92 0 0 0 3.05-2.53A7.37 7.37 0 0 0 70 4.47c0-1.5-.56-2.62-1.61-3.35C67.29.38 65.79 0 63.86 0H41.2L36 25ZM49.6 6.1h7.5c.54-.02 1.07.06 1.58.24a.88.88 0 0 1 .52.83c0 .7-.2 1.26-.63 1.61-.42.36-1.12.53-2.14.53h-7.5l.67-3.22Zm-1.86 8.88h8.1c.87 0 1.5.14 1.93.35a1.13 1.13 0 0 1 .63 1.09 2.32 2.32 0 0 1-.74 1.79c-.49.49-1.19.7-2.17.7h-8.55l.8-3.93ZM36 8.26c0 1.4-.15 2.78-.43 4.14-.3 1.42-.72 2.81-1.28 4.16-2.36 5.64-7.1 8.45-14.2 8.44H0l2.65-12.5.57-2.82h10.13L11.4 18.7h5.94c2.65 0 4.62-.77 5.9-2.38a9.08 9.08 0 0 0 1.98-5.77c0-2.8-1.76-4.24-5.23-4.24H.35L1.67.01h23.49c1.6-.03 3.2.14 4.76.48 1.36.35 2.47.84 3.36 1.47C35.07 3.3 36 5.4 36 8.26Z"/>
          </svg>
          <span class="db-sep"></span>
          <span class="db-msg">
            <span class="db-msg-single">${isMaxConf ? 'MEJOR CUOTA' : 'APOSTAR'}</span>
          </span>
          ${_odds ? `<span class="db-odds"><span class="db-odds-gem">💎</span>${_odds}</span>` : ''}
          <span class="db-arrow"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg></span>
        </a>`;
      })() : ''}
      <!-- (Bloque de apuesta con  removido) -->
      <!-- Sello de resultado (solo partidos terminados) -->
      ${isStarted ? `
      <div class="pred-result-stamp ${isHighConfWin ? 'stamp-highconf' : isFinishedWin ? 'stamp-win' : isFinishedLoss ? 'stamp-loss' : 'stamp-pending'}">
        <span class="pred-result-stamp-icon">${isHighConfWin ? `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-label="Acertado Maxima" width="32" height="32"><circle cx="16" cy="16" r="14" fill="#2a1e00" stroke="rgba(255,255,255,0.4)" stroke-width="1.2"/><path d="M10 16.2 L14.2 20.5 L22.2 12" fill="none" stroke="#ffd600" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>` : isFinishedWin ? `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-label="Acertado" width="32" height="32"><circle cx="16" cy="16" r="14" fill="#0e2a15" stroke="rgba(255,255,255,0.35)" stroke-width="1.2"/><path d="M10 16.2 L14.2 20.5 L22.2 12" fill="none" stroke="#00e85a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>` : isFinishedLoss ? '❌' : '⏳'}</span>
        <div class="pred-result-stamp-body">
          <span class="pred-result-stamp-text">${
            isHighConfWin ? '¡ACERTADO!' :
            isFinishedWin ? '¡ACERTADO!' :
            isFinishedLoss ? 'FALLADO' : 'Resultado Pendiente'
          }</span>
          ${finalScore ? `<span class="pred-result-stamp-sub">Resultado: ${_translateMatchState(finalScore)}</span>` : ''}
        </div>
      </div>` : ''}

      <!-- ── Fila de acciones: Share · Analysis/Tweet · Comment · Publish · Like ── -->
      <div class="pred-action-row">
        <button class="pred-action-btn btn-icon btn-share" onclick="sharePick('${p.home}','${p.away}','${p.rec}',${_bvr},'${p.league}')" title="Compartir este pick" aria-label="Compartir">
          <span aria-hidden="true">📤</span>
        </button>
        ${p.insight
          ? `<button class="pred-action-btn btn-analysis" style="display:none" onclick="togglePredExpand(${idx})" id="pred-analysis-btn-${idx}" title="Ver análisis de la IA">
              🔍 <span>Análisis</span>
              <span class="pred-action-arrow" id="pred-arrow-${idx}">▼</span>
            </button>`
          : (() => {
              const _tweetTxt = encodeURIComponent('Sobre esta Apuesta de @Gambeta_ai: ' + p.home + ' vs ' + p.away + ' → ' + (p.rec||'') + (p.league && p.league.length < 20 ? ' | ' + p.league : '') + ' 🤖⚽\nhttps://gambeta.ai');
              return `<a class="pred-action-btn btn-icon btn-twitter" href="https://twitter.com/intent/tweet?text=${_tweetTxt}" target="_blank" rel="noopener" title="Twitear esta apuesta" aria-label="Twitear">
              <span aria-hidden="true">🗣️</span>
            </a>`;
            })()
        }
        <button class="pred-action-btn btn-icon btn-forum" onclick="openPickForum('${p.home.replace(/'/g,"\\'")}','${p.away.replace(/'/g,"\\'")}',{home:'${p.home.replace(/'/g,"\\'")}',away:'${p.away.replace(/'/g,"\\'")}',league:'${(p.league||'').replace(/'/g,"\\'")}',rec:'${(p.rec||'').replace(/'/g,"\\'")}',bvrText:'${(_bvrText||'').replace(/'/g,"\\'")}'})" title="Ver comentarios" aria-label="Comentar">
          <span aria-hidden="true">💬</span>
        </button>
        <button class="pred-action-btn btn-icon btn-publish" onclick="openGbBetModalWithPick({home:'${p.home.replace(/'/g,"\\'")}',away:'${p.away.replace(/'/g,"\\'")}',league:'${(p.league||'').replace(/'/g,"\\'")}',rec:'${(p.rec||'').replace(/'/g,"\\'")}',odds:${(_odds ? _odds : (p._oddsRec||p.odds||1.85))},commenceTs:${p.commenceTs||'null'}})" title="Publicar tu apuesta con este pick pre-cargado" aria-label="Publicar apuesta">
          <span aria-hidden="true">🎯</span>
        </button>
        <button class="pred-action-btn btn-like${_isPickLiked(idx) ? ' liked' : ''}" id="plbtn-${idx}" onclick="togglePickLike(${idx}, ${source.length})" title="Me gusta este pick" aria-label="Me gusta">
          👍 <span id="plikes-${idx}">${_getFakeLikes(idx, source.length) + (_isPickLiked(idx) ? 1 : 0)}</span>
        </button>
      </div>
      <!-- Cuerpo expandible del análisis -->
      ${p.insight ? `
      <div class="pred-expand-body" id="pred-expand-${idx}">
        <div class="pred-insight-text">💡 ${p.insight}</div>
        ${h2hHtml ? `<div style="margin-top:4px">${h2hHtml}</div>` : ''}
        ${md ? `<button class="pred-full-btn" onclick="openMatchAnalysis('${p.home}','${p.away}')">Ver análisis estadístico completo →</button>` : ''}
      </div>` : ''}
    </div>
  `}).join('');

  // ── Chequeo automático de escudos (solo admin) ──
  _adminCheckLogos();
  // ── Actualizar contadores de likes en action rows (sincrónico, source ya en DOM) ──
  _updatePickLikeCounts(source);

  // ── Research IA: fetch async por cada pick visible (con cache localStorage 12h) ──
  // _scheduleResearchFetch(source);  // DESACTIVADO 18-may-2026: research IA pausado para frenar costo Tavily
}

// ════════════════════════════════════════════════════════════════
//  RESEARCH IA — cinta de policía + ajuste de estrellas + modal
// ════════════════════════════════════════════════════════════════
const _RESEARCH_ENDPOINT = 'https://apuestas-ia-chat.mauro-union10.workers.dev/research';
const _RESEARCH_CACHE_TTL_MS = 12 * 3600 * 1000;
const _RESEARCH_CACHE_VERSION = 'v3';   // bump esto cuando cambia el schema del backend para invalidar cache viejo

function _researchCacheKey(p) {
  return 'gb_res_' + _RESEARCH_CACHE_VERSION + '_' + (p.home || '') + '__' + (p.away || '') + '__' + (p.commenceTs || 0);
}
function _researchCacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || obj.expiresAt < Date.now()) {
      localStorage.removeItem(key);
      return null;
    }
    return obj.data;
  } catch { return null; }
}
function _researchCacheSet(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ data, expiresAt: Date.now() + _RESEARCH_CACHE_TTL_MS }));
  } catch { /* quota */ }
}

// Pick emoji según tipo de finding o severity
function _researchEmojiFor(research) {
  const findings = research.key_findings || [];
  const top = findings[0] || {};
  const t = (top.type || '').toLowerCase();
  if (t === 'injury')     return '🤕';
  if (t === 'weather')    return '🌧️';
  if (t === 'conflict')   return '⚡';
  if (t === 'financial')  return '💸';
  if (t === 'form')       return '🔥';
  if (t === 'tactical')   return '🧠';
  if (t === 'rotation')   return '🔄';
  if (research.severity === 'critical') return '🚨';
  if (research.severity === 'warning')  return '⚠️';
  return '🔍';
}

// Texto corto para la cinta (preferir short_label del backend si existe)
function _researchShortLabel(research) {
  // Backend provee short_label curado, 3-5 palabras max
  if (research.short_label && research.short_label.length >= 3) {
    return research.short_label.slice(0, 40);
  }
  // Fallback: tomar primeras 4 palabras del primer finding o summary
  const top = (research.key_findings || [])[0];
  let text = top?.text || research.summary || '';
  text = text.replace(/^[^:]+:\s*/, '').split(/[.;,()]/)[0];
  const words = text.trim().split(/\s+/).slice(0, 4);
  return words.join(' ');
}

function _applyResearchToCard(cardId, research, bvr) {
  const strip = document.getElementById('iastrip-' + cardId);
  if (!strip) return;
  // Solo mostrar la cinta si la IA tiene algo importante que decir:
  //  - severity warning/critical → siempre
  //  - severity info → solo si la IA recomienda ajustar stake (stake_delta != 0)
  //  - severity none → nunca
  const sev = research?.severity || 'none';
  const stakeDelta = Number(research?.stake_delta) || 0;
  const shouldShow = (sev === 'warning' || sev === 'critical')
                  || (sev === 'info' && stakeDelta !== 0);
  if (!research || !shouldShow) {
    strip.style.display = 'none';
    return;
  }
  const emoji = _researchEmojiFor(research);
  const label = _researchShortLabel(research);
  strip.className = 'pred-ia-strip severity-' + (research.severity || 'info');
  strip.innerHTML = `
    <span class="ia-msg">${emoji} IA: ${label}</span>
    <span class="ia-cta">+ info ▾</span>`;
  strip.style.display = 'flex';
  // Guardar research en el strip para el modal
  strip._research = research;
  strip.onclick = () => _researchModalOpen(strip._research, cardId);

  // Ajustar última estrella activa según stake_delta
  if (research.stake_delta && bvr) {
    const card = document.getElementById(cardId);
    if (!card) return;
    const gems = card.querySelectorAll('.bvr-gem');
    if (gems.length >= bvr && bvr >= 1) {
      const targetIdx = bvr - 1 + (research.stake_delta > 0 ? 1 : 0);
      const gem = gems[Math.min(targetIdx, gems.length - 1)];
      if (gem) gem.classList.add(research.stake_delta > 0 ? 'ia-up' : 'ia-down');
    }
  }
}

function _researchModalOpen(research, cardId) {
  let bg = document.getElementById('iaModalBg');
  if (!bg) {
    bg = document.createElement('div');
    bg.id = 'iaModalBg';
    bg.className = 'pred-ia-modal-bg';
    bg.onclick = (e) => { if (e.target === bg) _researchModalClose(); };
    document.body.appendChild(bg);
  }
  const findings = (research.key_findings || []).map(f => `
    <div class="pred-ia-finding t-${(f.type||'other').toLowerCase()}">
      ${f.text || ''}
      ${f.source_name ? `<div class="pred-ia-finding-source">— ${f.source_name}</div>` : ''}
    </div>`).join('');
  const deltaLabel = research.stake_delta > 0
    ? '<span style="color:#00C853">⬆ Stake recomendado: +1 nivel</span>'
    : research.stake_delta < 0
    ? '<span style="color:#E24B4A">⬇ Stake recomendado: -1 nivel</span>'
    : '';
  bg.innerHTML = `
    <div class="pred-ia-modal" onclick="event.stopPropagation()">
      <div class="pred-ia-modal-header">
        <div class="pred-ia-modal-title">🔍 Análisis IA del partido</div>
        <button class="pred-ia-modal-close" onclick="_researchModalClose()" aria-label="Cerrar">×</button>
      </div>
      <div class="pred-ia-modal-body">
        <div class="pred-ia-summary">${research.summary || 'Sin resumen.'}</div>
        ${deltaLabel ? `<div style="margin-bottom:14px;font-size:0.82rem;font-weight:600">${deltaLabel}</div>` : ''}
        ${findings ? `<div class="pred-ia-findings">${findings}</div>` : ''}
      </div>
      <div class="pred-ia-modal-footer">
        Análisis generado por IA con datos de diarios locales, redes sociales y video-análisis.
        ${research.cached ? '· Cache 12h' : '· En vivo'}
      </div>
    </div>`;
  // Forzar apertura con inline styles (más confiable que .classList.add con transitions en elementos recién agregados)
  bg.classList.add('open');
  bg.style.opacity = '1';
  bg.style.pointerEvents = 'all';
}
window._researchModalClose = function() {
  const bg = document.getElementById('iaModalBg');
  if (!bg) return;
  bg.classList.remove('open');
  bg.style.opacity = '0';
  bg.style.pointerEvents = 'none';
};

// Cola con throttling para no saturar el endpoint
let _researchInFlight = 0;
const _RESEARCH_MAX_CONCURRENT = 3;
const _researchQueue = [];
function _drainResearchQueue() {
  while (_researchInFlight < _RESEARCH_MAX_CONCURRENT && _researchQueue.length) {
    const job = _researchQueue.shift();
    _researchInFlight++;
    job().finally(() => { _researchInFlight--; _drainResearchQueue(); });
  }
}

function _scheduleResearchFetch(picks) {
  if (!Array.isArray(picks) || !picks.length) return;
  picks.forEach((p, idx) => {
    // No researchar partidos ya finalizados o sin datos básicos
    if (!p.home || !p.away) return;
    if (p.result && p.result !== 'pending' && p.result !== 'void') return;

    const cardId = 'predcard-' + (p.home + '-' + p.away).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const bvr = p.bvr || (p.conf === 'high' ? 5 : 3);
    const key = _researchCacheKey(p);

    // Cache hit → aplicar inmediatamente
    const cached = _researchCacheGet(key);
    if (cached) {
      _applyResearchToCard(cardId, cached, bvr);
      return;
    }

    // Cache miss → encolar fetch
    _researchQueue.push(async () => {
      try {
        const res = await fetch(_RESEARCH_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            home: p.home, away: p.away,
            league: p.league || '',
            commenceTs: p.commenceTs || 0,
            rec: p.rec || ''
          })
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data && (data.summary || data.severity)) {
          _researchCacheSet(key, data);
          _applyResearchToCard(cardId, data, bvr);
        }
      } catch (e) { /* silencioso, research es opcional */ }
    });
  });
  _drainResearchQueue();
}

// Muestra un banner admin con los equipos sin escudo detectados en el último render
function _adminCheckLogos() {
  const isAdmin = window._isAdmin || (authUser && authUser.email === 'pronosticosarg@gmail.com');
  if (!isAdmin) return;
  const misses = window._logoMisses ? [...window._logoMisses] : [];
  // Filtrar nombres que son tenistas / personas (tienen formato "Nombre Apellido" de 2 palabras capitalizadas)
  const soccerMisses = misses.filter(n => {
    if (!n) return false;
    // Excluir si parece un tenista (2 palabras, ambas capitalizadas, sin números)
    if (/^[A-ZÁÉÍÓÚ][a-záéíóú'\-]+ [A-ZÁÉÍÓÚ][a-záéíóú'\-]+$/.test(n)) return false;
    return true;
  });
  const prevEl = document.getElementById('_adminLogoAlert');
  if (prevEl) prevEl.remove();
  if (!soccerMisses.length) return;

  const el = document.createElement('div');
  el.id = '_adminLogoAlert';
  el.style.cssText = `
    position:fixed;bottom:80px;right:16px;z-index:999999;
    background:#1a1200;border:1.5px solid rgba(255,200,0,0.7);border-radius:12px;
    padding:12px 14px;max-width:320px;font-size:0.72rem;font-family:inherit;
    box-shadow:0 4px 20px rgba(0,0,0,0.6);color:#fff;line-height:1.5;
  `;
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span style="font-weight:800;color:#ffd600;font-size:0.75rem">⚠️ Equipos sin escudo (${soccerMisses.length})</span>
      <button onclick="document.getElementById('_adminLogoAlert').remove()" style="background:rgba(255,255,255,0.08);border:none;color:#aaa;width:22px;height:22px;border-radius:50%;cursor:pointer;font-size:0.75rem;line-height:1">✕</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:3px">
      ${soccerMisses.map(n => `<span style="background:rgba(255,255,255,0.06);border-radius:6px;padding:3px 8px;font-family:monospace;font-size:0.68rem;color:#ffd600">${n}</span>`).join('')}
    </div>
    <div style="margin-top:8px;font-size:0.63rem;color:rgba(255,255,255,0.45)">Solo visible para el admin · Cerrar cuando lo corrijas</div>
  `;
  document.body.appendChild(el);
}

// ═══════════════════════════════════════════════
//  CALCULATOR
// ═══════════════════════════════════════════════

function updateCalc() {
  const amount = parseFloat(document.getElementById('betAmount').value) || 0;
  const odds = parseFloat(document.getElementById('betOdds').value) || 1;
  const prob = parseFloat(document.getElementById('betProb').value) / 100 || 0;
  const bankroll = parseFloat(document.getElementById('betBankroll').value) || 1000;

  const gain = (amount * odds - amount);
  const total = amount * odds;
  const roi = ((odds - 1) * 100).toFixed(1);
  const ev = (prob * gain - (1 - prob) * amount).toFixed(2);
  const evPct = Math.min(100, Math.max(0, ((parseFloat(ev) + amount) / (amount * 2)) * 100));

  document.getElementById('r-ganancia').textContent = '$' + gain.toFixed(2);
  document.getElementById('r-retorno').textContent = '$' + total.toFixed(2);
  document.getElementById('r-roi').textContent = roi + '%';

  const evEl = document.getElementById('r-ev');
  evEl.textContent = (parseFloat(ev) >= 0 ? '+' : '') + '$' + ev;
  evEl.style.color = parseFloat(ev) >= 0 ? 'var(--verde)' : 'var(--rojo)';

  document.getElementById('evBar').style.width = evPct + '%';

  let tip = '';
  if (parseFloat(ev) > 5) tip = '🟢 <strong>Excelente valor.</strong> Esta apuesta tiene valor esperado positivo significativo.';
  else if (parseFloat(ev) > 0) tip = '🟡 <strong>Valor positivo moderado.</strong> La apuesta tiene EV positivo. Gestioná el tamaño con responsabilidad.';
  else tip = '🔴 <strong>Sin valor esperado.</strong> Las probabilidades no justifican la apuesta. Buscá mejores cuotas.';
  document.getElementById('calc-tip').innerHTML = tip;
}

// ═══════════════════════════════════════════════
//  STATS
// ═══════════════════════════════════════════════

let currentStatFilter = 'futbol';

// Cache de stats reales por sport
const realStatsCache = {};

function renderStats(sport) {
  if (!document.getElementById('statsGrid')) return;
  const data = realStatsCache[sport] || statsData[sport] || [];
  const lbl1 = sport==='tenis'?'Juegos G.':'Goles F.';
  const lbl2 = sport==='tenis'?'Juegos P.':'Goles C.';
  const lbl3 = sport==='tenis'?'Pts Ranking':'Puntos';
  document.getElementById('statsGrid').innerHTML = data.length ? data.map(t => {
    const logoEl = t.badgeUrl
      ? `<img loading="lazy" decoding="async" src="${t.badgeUrl}" style="width:54px;height:54px;object-fit:contain;border-radius:6px" onerror="this.style.display='none'">`
      : logoHtml(t.name, 54);
    return `
    <div class="stat-card">
      <div class="stat-card-header">
        <div class="team-logo-big">${logoEl}</div>
        <div class="team-info">
          <h4>${t.name}</h4>
          <p>${t.league} · ${t.pos}</p>
        </div>
      </div>
      <div class="form-dots">
        <span class="form-label">Forma:</span>
        ${(t.form||[]).map(r => `<div class="form-dot dot-${r==='G'?'w':r==='E'?'d':'l'}">${r}</div>`).join('')}
      </div>
      <div class="stat-mini-grid">
        <div class="stat-mini"><span class="s-val">${t.gf}</span><span class="s-lbl">${lbl1}</span></div>
        <div class="stat-mini"><span class="s-val">${t.ga}</span><span class="s-lbl">${lbl2}</span></div>
        <div class="stat-mini"><span class="s-val">${t.pts}</span><span class="s-lbl">${lbl3}</span></div>
      </div>
    </div>`; }).join('')
  : `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--texto-sec)">⏳ Cargando estadísticas reales...</div>`;
}

// ─── ESPN Public API – standings reales ───────────────────────
const ESPN = 'https://site.api.espn.com/apis/v2/sports';
const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const ESPN_LEAGUES = {
  futbol: [
    { code:'soccer/esp.1', label:'La Liga',        top:3 },
    { code:'soccer/eng.1', label:'Premier League', top:3 },
    { code:'soccer/ger.1', label:'Bundesliga',     top:2 },
    { code:'soccer/ita.1', label:'Serie A',        top:2 },
    { code:'soccer/arg.1', label:'Liga Prof.',     top:2 },
  ],
};

async function loadRealStats(sport) {
  if (sport === 'tenis') { renderStats(sport); loadPlayerPhotos(); return; }
  const leagues = ESPN_LEAGUES[sport];
  if (!leagues) { renderStats(sport); return; }

  const statsGridEl = document.getElementById('statsGrid');
  if (!statsGridEl) return;
  statsGridEl.innerHTML =
    `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--texto-sec)">⏳ Cargando estadísticas reales...</div>`;

  const getStat  = (stats, name) => { const s = stats?.find(x=>x.name===name); return s ? (parseFloat(s.value)||0) : 0; };
  const getStatS = (stats, name) => { const s = stats?.find(x=>x.name===name); return s ? (s.displayValue||'') : ''; };

  const all = [];

  for (const lg of leagues) {
    try {
      const r = await fetch(`${ESPN}/${lg.code}/standings`);
      const j = await r.json();

      // ESPN NBA tiene grupos de conferencia; fútbol tiene entries directas
      let entries = [];
      if (j.standings?.entries?.length) {
        entries = j.standings.entries;
      } else if (j.children?.length) {
        j.children.forEach(g => {
          if (g.standings?.entries) entries.push(...g.standings.entries);
        });
        // NBA: ordenar por victorias desc
        if (lg.nba) entries.sort((a,b) => getStat(b.stats,'wins') - getStat(a.stats,'wins'));
      }

      entries.slice(0, lg.top).forEach((entry, idx) => {
        const team  = entry.team || {};
        const stats = entry.stats || [];

        // Forma desde streak (ej: "W3" → ["G","G","G"])
        const streakStr = getStatS(stats, 'streak');
        let form = [];
        const sm = streakStr.match(/^([WLD])(\d+)$/);
        if (sm) {
          const t = sm[1]==='W'?'G':sm[1]==='L'?'P':'E';
          form = Array(Math.min(parseInt(sm[2]),5)).fill(t);
        }

        const rank = getStat(stats,'rank') || getStat(stats,'playoffSeed') || idx+1;
        const logo = team.logos?.[0]?.href || null;

        if (lg.nba) {
          all.push({
            name:     team.shortDisplayName || team.displayName,
            badgeUrl: logo,
            league:   lg.label,
            pos:      rank + '°',
            form,
            gf:  Math.round(getStat(stats,'avgPointsFor')*10)/10 || getStat(stats,'pointsFor'),
            ga:  Math.round(getStat(stats,'avgPointsAgainst')*10)/10 || getStat(stats,'pointsAgainst'),
            pts: getStat(stats,'wins'),
          });
        } else {
          all.push({
            name:     team.shortDisplayName || team.displayName,
            badgeUrl: logo,
            league:   lg.label,
            pos:      rank + '°',
            form,
            gf:  getStat(stats,'pointsFor')     || getStat(stats,'goalsFor'),
            ga:  getStat(stats,'pointsAgainst') || getStat(stats,'goalsAgainst'),
            pts: getStat(stats,'points'),
          });
        }
      });
    } catch(e) { console.warn('[ESPN Stats]', lg.label, e); }
  }

  if (all.length > 0) {
    realStatsCache[sport] = all;
    renderStats(sport);
  } else {
    renderStats(sport);
  }
}

function filterStats(sport, btn) {
  document.querySelectorAll('#stats .sport-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentStatFilter = sport;
  if (realStatsCache[sport]) {
    renderStats(sport);
    if (sport === 'tenis') loadPlayerPhotos();
  } else {
    loadRealStats(sport);
  }
}

// ═══════════════════════════════════════════════
//  FOTOS TENISTAS – Wikipedia REST API
// ═══════════════════════════════════════════════

function applyPhotoToImgs(wikiKey, photoUrl) {
  document.querySelectorAll(`.pa-img[data-wiki="${wikiKey}"], .pa-photo[data-wiki="${wikiKey}"]`).forEach(img => {
    img.src = photoUrl;
    img.onload = () => img.classList.add('loaded');
  });
}

async function fetchWikiPhoto(wikiKey) {
  if (playerPhotoCache[wikiKey]) {
    applyPhotoToImgs(wikiKey, playerPhotoCache[wikiKey]);
    return;
  }
  try {
    // Convertir guiones bajos a espacios y encodear correctamente
    // El endpoint ?action=query maneja redirecciones y caracteres especiales
    const title = wikiKey.replace(/_/g, ' ');
    const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=pageimages&format=json&pithumbsize=320&redirects=1&origin=*`;
    const r = await fetch(url);
    if (!r.ok) return;
    const d = await r.json();
    const pages = d.query?.pages;
    if (!pages) return;
    const page = Object.values(pages)[0];
    if (page?.thumbnail?.source) {
      playerPhotoCache[wikiKey] = page.thumbnail.source;
      applyPhotoToImgs(wikiKey, page.thumbnail.source);
    }
  } catch(e) { /* mantiene iniciales como fallback */ }
}

function loadPlayerPhotos() {
  const seen = new Set();
  document.querySelectorAll('.pa-photo[data-wiki]').forEach(img => {
    const key = img.dataset.wiki;
    if (!seen.has(key)) { seen.add(key); fetchWikiPhoto(key); }
  });
}

// ═══════════════════════════════════════════════
//  CHAT IA
// ═══════════════════════════════════════════════

let chatOpen = false;

const chatResponses = {
  'real madrid': '⚽ **Real Madrid** está en gran forma. En la Champions tienen 82% de probabilidad de clasificar según nuestro modelo. Hoy juegan contra Manchester City — la IA recomienda apostar Local (cuota 1.80) con confianza alta del 82%. ¿Querés más detalles sobre el partido?',
  'mejor apuesta': '🔮 La **mejor apuesta del día** según la IA es: **"Más de 2.5 goles" en Bayern vs Dortmund** (cuota 1.60). El Clásico alemán promedia 3.4 goles en sus últimos 8 partidos. Valor esperado positivo de +$8.40 por cada $100 apostados.',
  'default': (q) => `🤖 Analizando tu consulta sobre **"${q}"**...\n\nBasándome en los datos estadísticos actuales, nuestro modelo indica una tendencia positiva en los mercados relacionados. Te recomiendo revisar los pronósticos de hoy arriba, donde tenemos análisis detallados con probabilidades para los partidos más importantes. ¿Hay algún partido específico que te interese?`
};

function getBotResponse(msg) {
  const lower = msg.toLowerCase();
  if (lower.includes('real madrid') || lower.includes('madrid')) return chatResponses['real madrid'];
  if (lower.includes('mejor apuesta') || lower.includes('mejor') || lower.includes('recomienda')) return chatResponses['mejor apuesta'];
  return chatResponses['default'](msg);
}

function toggleChat() {
  chatOpen = !chatOpen;
  const win = document.getElementById('chatWindow');
  const notify = document.getElementById('chatNotify');
  win.classList.toggle('visible', chatOpen);
  win.classList.toggle('hidden', !chatOpen);
  if (chatOpen) {
    notify.style.display = 'none';
    const sb = document.getElementById('chatSpeechBubble');
    if (sb) sb.style.display = 'none';
  }
}

function addMessage(text, type) {
  const msgs = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'msg ' + type;
  const now = new Date();
  const time = now.getHours() + ':' + String(now.getMinutes()).padStart(2,'0');
  div.innerHTML = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/`(.*?)`/g, '<code style="background:rgba(0,200,83,0.15);padding:1px 5px;border-radius:4px;font-family:monospace;font-size:0.85em">$1</code>');
  const timeDiv = document.createElement('div');
  timeDiv.className = 'msg-time';
  timeDiv.textContent = time;
  div.appendChild(timeDiv);
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function showTyping() {
  const msgs = document.getElementById('chatMessages');
  const div = document.createElement('div');
  div.className = 'typing-indicator';
  div.id = 'typingIndicator';
  div.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function hideTyping() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

function sendChat() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;
  addMessage(msg, 'user');
  input.value = '';
  document.getElementById('chatSuggestions').style.display = 'none';
  showTyping();
  setTimeout(() => {
    hideTyping();
    addMessage(getBotResponse(msg), 'bot');
  }, 900 + Math.random() * 600);
}

function sendSuggestion(el) {
  document.getElementById('chatInput').value = el.textContent.replace(/^[^\w\s]*/, '').trim();
  sendChat();
}

// ═══════════════════════════════════════════════
//  SCROLL NAV
// ═══════════════════════════════════════════════

function navTo(id) {
  // Si estamos en una página dedicada, navegar al hash correcto en vez de scroll
  if (document.body.dataset.gbpage) {
    const _pageRoute = { predictions: 'picks', historial: 'historial', myPicksPanel: 'stats', ranking: '', 'bot-alerta': '', telegram: '', calculator: '', bankroll: '' };
    if (id in _pageRoute) {
      const hash = _pageRoute[id];
      if (hash) { window.location.hash = hash; return; }
      else { window.location.hash = ''; return; } // volver a home
    }
  }
  // Al navegar al historial: resetear todos los filtros y re-renderizar
  if (id === 'historial') {
    histFilter = 'all'; histDateFilter = 'all'; histLeagueFilter = 'all';
    histMercadoFilter = 'all'; histConfFilter = 'all'; histPage = 0;
    ['histDateBtnHoy','histDateBtnWeek','histDateBtnAll','histDateBtnFinde'].forEach(_bid => {
      document.getElementById(_bid)?.classList.remove('active');
    });
    document.getElementById('histDateBtnAll')?.classList.add('active');
    renderHistorial('all');
  }
  const el = document.getElementById(id);
  if (!el) return;
  if (el.style.display === 'none') el.style.display = '';
  const navH    = document.querySelector('nav')?.offsetHeight || 66;
  const pageBarH = document.body.dataset.gbpage ? 40 : 0;
  const dbbetH  = document.body.dataset.gbpage ? 0 : (document.getElementById('dbbet-sponsor-bar')?.offsetHeight || 0);
  const top     = el.getBoundingClientRect().top + window.scrollY - navH - dbbetH - pageBarH - 10;
  window.scrollTo({ top, behavior: 'smooth' });
  document.querySelectorAll('.nav-links a, .nav-drawer a').forEach(a => a.classList.remove('active'));
}

function toggleMobileNav() {
  const drawer  = document.getElementById('navDrawer');
  const overlay = document.getElementById('navOverlay');
  const btn     = document.getElementById('hamburgerBtn');
  if (!drawer) return;
  const isOpen  = drawer.classList.contains('open');
  drawer.classList.toggle('open', !isOpen);
  overlay?.classList.toggle('open', !isOpen);
  btn?.classList.toggle('open', !isOpen);
}

function closeMobileNav() {
  document.getElementById('navDrawer')?.classList.remove('open');
  document.getElementById('navOverlay')?.classList.remove('open');
  document.getElementById('hamburgerBtn')?.classList.remove('open');
}

// ═══════════════════════════════════════════════
//  HISTORIAL — localStorage automático
// ═══════════════════════════════════════════════
const HIST_KEY   = 'apuestas_historial_v1';
const HIST_STAKE = 100; // stake fijo por predicción
let histFilter = 'all';
const HIST_PAGE_SIZE = 10;
const ADMIN_KEY      = 'apuestas_admin_cfg_v1';
const ADMIN_SESSION  = 'apuestas_admin_session_v1';
let histPage = 0;
let histDateFilter = 'all';
let histLeagueFilter = 'all';
let histMercadoFilter = 'all';
let histConfFilter = 'all';
// Fecha de lanzamiento del sitio — fija para todos los usuarios
const PAGE_LAUNCH_DATE = new Date('2025-03-01');

function _normRec(r) { return (r||'').replace('Visitante Gana','Gana Visitante').replace('Local Gana','Gana Local'); }


// ════════════════════════════════════════════════════════════
// DBBET 1-CLICK BET — deep link al partido con afiliado
// REGLA DE ORO: TODAS las URLs pasan por el afiliado, siempre.
// ════════════════════════════════════════════════════════════
const DBBET_AFFILIATE_BASE = 'https://refpa96317.com/L?tag=d_5777587m_11213c_&site=5777587&ad=11213&utm_source=home_dbbet&utm_medium=site';

// ── Mapa de sport_key → path de liga en DBbet ──
// El &url= redirige al usuario a la página de la liga/partido después del tracking de afiliado.
// IDs verificados desde refpa/DBbet. Agregar más a medida que se descubran.
const DBBET_LEAGUE_MAP = {
  // 🏆 Mundial 2026
  'soccer_fifa_world_cup':           '/es/line/Football/2708736-World-Cup-2026',
  'soccer_fifa_world_cup_2026':      '/es/line/Football/2708736-World-Cup-2026',
  'soccer_world_cup':                '/es/line/Football/2708736-World-Cup-2026',
  // 🌎 CONMEBOL
  'soccer_conmebol_copa_libertadores': '/es/line/Football/2707805-Copa-Libertadores',
  'soccer_conmebol_copa_sudamericana': '/es/line/Football/2707806-Copa-Sudamericana',
  // 🇦🇷 Argentina
  'soccer_argentina_primera_division': '/es/line/Football/2705381-Argentina-Liga-Profesional',
  // 🇧🇷 Brasil
  'soccer_brazil_campeonato':        '/es/line/Football/2705375-Brazil-Serie-A',
  'soccer_brazil_serie_a':           '/es/line/Football/2705375-Brazil-Serie-A',
  // 🇲🇽 México
  'soccer_mexico_ligamx':            '/es/line/Football/2705385-Mexico-Liga-MX',
  // 🇺🇸 MLS
  'soccer_usa_mls':                  '/es/line/Football/2705389-USA-MLS',
  // 🇺🇾 Uruguay
  'soccer_uruguay_primera_division': '/es/line/Football/2706335-Uruguay-Primera-Division',
  // 🏴󠁧󠁢󠁥󠁮󠁧󠁿 Europa
  'soccer_epl':                      '/es/line/Football/2705325-England-Premier-League',
  'soccer_england_premier_league':   '/es/line/Football/2705325-England-Premier-League',
  'soccer_spain_la_liga':            '/es/line/Football/2705349-Spain-La-Liga',
  'soccer_italy_serie_a':           '/es/line/Football/2705339-Italy-Serie-A',
  'soccer_germany_bundesliga':       '/es/line/Football/2705337-Germany-Bundesliga',
  'soccer_france_ligue_one':         '/es/line/Football/2705335-France-Ligue-1',
  // ⭐ Champions
  'soccer_uefa_champs_league':       '/es/line/Football/2709893-UEFA-Champions-League',
  'soccer_uefa_europa_league':       '/es/line/Football/2709895-UEFA-Europa-League',
};

// Convierte nombre de equipo a slug URL (español, sin acentos, separado por guión)
function _teamSlug(name) {
  return (name || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9\s]/g, '').trim().replace(/\s+/g, '-');
}

// Genera un couponCode determinístico (para tracking interno)
function _dbbetCouponCode(p) {
  if (!p) return '';
  const s = (x) => (x||'').toString().replace(/[^A-Za-z0-9]/g,'').slice(0,3).toUpperCase();
  const side = _recSideOf(p) || 'X';
  if (p.matchId) return ('GMB_' + p.matchId + '_' + side).toUpperCase();
  const home = s(p.homeRaw || p.home);
  const away = s(p.awayRaw || p.away);
  const date = (p.fecha || p.kickoff || '').toString().slice(0,10).replace(/-/g,'');
  return ['GMB', home, away, side, date].filter(Boolean).join('_').toUpperCase();
}

// ── buildDBbetCouponURL: SIEMPRE afiliado + deep link al partido ──
function buildDBbetCouponURL(p) {
  // 🩹 2026-06-28: El redirector refpa96317.com borra el query "&url=" durante el
  // redirect a db-bet-1639.pro/en, así que el deeplink al partido NUNCA llega.
  // Resultado: el usuario aterrizaba en la home de DBbet en inglés en vez de
  // en el partido del Mundial → fricción enorme y caída de conversión.
  // Hasta validar el tracking de la URL directa (db-bet-1639.pro/es/line/...?tag=...)
  // siempre devolvemos el afiliado base — al menos preserva el tag con seguridad.
  return DBBET_AFFILIATE_BASE;
}

// Click handler — abre DBbet con deep link (siempre afiliado)
function betOnDBbetPick(pickRef) {
  let p = null;
  try {
    p = typeof pickRef === 'string' ? JSON.parse(pickRef) : pickRef;
  } catch(e) { p = null; }
  const url = p ? buildDBbetCouponURL(p) : DBBET_AFFILIATE_BASE;
  // tracking
  try {
    trackEvent('promo_click', {
      promo: 'dbbet',
      type: 'one_click_bet',
      match: p && (p.home + ' vs ' + p.away),
      pick: p && p.rec,
      odds: p && p._bestOdds,
      coupon: p ? _dbbetCouponCode(p) : null,
      deeplink: true,
      targetUrl: url
    });
  } catch(e) {}
  window.open(url, '_blank', 'noopener');
  return false;
}


// Determina el lado del pick ('home'|'away'|'draw'|null) con retrocompat para picks viejos
function _recSideOf(p) {
  if (!p) return null;
  if (p._recSide) return p._recSide;
  const r = _normRec(p.rec || '');
  if (r === 'Gana Local')     return 'home';
  if (r === 'Gana Visitante') return 'away';
  if (r === 'Empate')         return 'draw';
  if (r === 'Doble 1X')       return '1x';   // 🆕
  if (r === 'Doble X2')       return 'x2';   // 🆕
  // Formato nuevo guardado sin _recSide (picks intermedios)
  if (r.startsWith('Gana ') && p.home && r === 'Gana ' + p.home) return 'home';
  if (r.startsWith('Gana ') && p.away && r === 'Gana ' + p.away) return 'away';
  return null;
}

// Muestra la recomendación con nombre de equipo en lugar de Local/Visitante
function _recLabel(rec, home, away) {
  const r = _normRec(rec || '');
  // 🏆 Atajos para apuestas a futuro del Mundial 2026 — versiones más cortas
  if (/^Mbapp[ée] es el goleador/i.test(r))      return 'Mbappé goleador';
  if (/gana el Mundial 2026/i.test(r))           return shortName(home || '') + ' Campeón';
  if (/llega a Octavos/i.test(r))                return shortName(home || '') + ' llega a 8vos';
  if (/llega a Cuartos/i.test(r))                return shortName(home || '') + ' llega a 4tos';
  if (/llega a Semifinales/i.test(r))            return shortName(home || '') + ' a Semis';
  if (/llega a Final$/i.test(r))                 return shortName(home || '') + ' a la Final';
  if (r === 'Gana Local')     return 'Gana ' + shortName(home || 'Local');
  if (r === 'Gana Visitante') return 'Gana ' + shortName(away || 'Visitante');
  if (r === 'Doble 1X')       return 'Gana ' + shortName(home || 'Local') + ' o Empate';      // 🆕
  if (r === 'Doble X2')       return 'Gana ' + shortName(away || 'Visitante') + ' o Empate';  // 🆕
  // Si el rec es "Gana <nombre largo>" (pick guardado con nombre completo), normalizar
  if (r.startsWith('Gana ')) {
    const teamPart = r.slice(5).trim();
    const sn = shortName(teamPart);
    return 'Gana ' + sn;
  }
  return r;
}
function loadHistorial()   {
  try {
    const raw = JSON.parse(localStorage.getItem(HIST_KEY)||'[]');
    // Normalizar labels de rec viejos (migración de nomenclatura)
    raw.forEach(h => {
      if (h.rec) h.rec = _normRec(h.rec);
      // Normalizar sport: legacy 'soccer'/'tennis' → 'futbol'/'tenis'
      if (h.sport === 'soccer')  h.sport = 'futbol';
      if (h.sport === 'tennis')  h.sport = 'tenis';
      if (!h.sport)              h.sport = 'futbol';  // default por si está vacío
    });
    return raw;
  } catch { return []; }
}
function saveHistorial(arr) {
  const sorted = [...arr].sort((a,b) => (b.commenceTs||0) - (a.commenceTs||0));
  try { localStorage.setItem(HIST_KEY, JSON.stringify(sorted.slice(-1000000))); } catch {}
  // Sync a historial GLOBAL en Supabase (solo admin)
  if (authUser?.email === 'mauro.union10@gmail.com') {
    clearTimeout(_globalHistSyncTimer);
    _globalHistSyncTimer = setTimeout(() => sbSaveGlobalHistorial(sorted), 1500);
  }
  // Backup personal (todos los usuarios logueados)
  if (authUser?.email) {
    clearTimeout(_histSyncTimer);
    _histSyncTimer = setTimeout(() => sbSaveHistorial(sorted), 3000);
    // También actualizar columna `predictions` para los stats globales del hero
    acScheduleSync();
  }
}

// ── Sync historial ↔ Supabase ──
let _histSyncTimer = null;
let _globalHistSyncTimer = null;
const ADMIN_EMAIL = 'mauro.union10@gmail.com';
const GLOBAL_HIST_KEY = 'global_historial_v1';
const BLOCKED_HIST_IDS = new Set(['fsvmainz05_sigmaolomouc_2026-03-18', 'seattle_realsaltlake_2026-04-12']);

// ══════════════════════════════════════════════════════════════
//  PICKS BLOQUEADOS GLOBALES — shared_cache en Supabase
//  Una vez calculados para el día, conf/bvr/cuota son ley:
//  el PRIMER usuario los escribe, todos los demás los leen.
// ══════════════════════════════════════════════════════════════
window._sbLockedPicks     = {}; // { "home_vs_away": {conf,bvr,bvrText,bestOdds,hO,aO,dO} }
window._sbLockedPicksPrev = {}; // picks del día anterior (para Libertadores/Sudamericana nocturnos)
window._estrellaOverride  = null; // {home,away} — pick estrella del finde forzado por admin

// ══════════════════════════════════════════════════════════════
// LEAGUE TAB VISIBILITY — oculta tabs sin picks disponibles
// ══════════════════════════════════════════════════════════════
var LEAGUE_FILTER_PATTERNS = {
  champions:    ['champs_league','champions'],
  europa:       ['europa_league'],
  conference:   ['conference_league'],
  premier:      ['england_premier','soccer_epl'],
  laliga:       ['spain_la_liga'],
  bundesliga:   ['germany_bundesliga'],   // BL1 — el filtro de render excluye BL2 explícitamente
  bl2:          ['germany_bundesliga2'],
  seriea:       ['italy_serie_a'],
  serieb:       ['italy_serie_b'],
  ligue1:       ['france_ligue_one'],
  ligue2:       ['france_ligue_two'],
  eredivisie:   ['netherlands_eredivisie','eredivisie'],
  championship: ['england_championship'],
  segunda:      ['spain_segunda_division'],
  belgium:      ['belgium_first_div'],
  scotland:     ['scotland'],
  turkey:       ['turkey'],
  libertadores: ['copa_libertadores'],
  sudamericana: ['copa_sudamericana'],
  arg:          ['argentina'],
  bra:          ['brazil'],
  mexico:       ['mexico_ligamx','ligamx'],
  mls:          ['usa_mls','soccer_mls'],
  uruguay:      ['uruguay'],
  saudi:        ['saudi'],
  japan:        ['japan_j_league','j_league'],
  portugal:     ['portugal'],
  denmark:      ['denmark'],
  sweden:       ['sweden'],
  norway:       ['norway'],
  poland:       ['poland'],
  czech:        ['czech_republic'],
  switzerland:  ['switzerland'],
  austria:      ['austria'],
  greece:       ['greece'],
  russia:       ['russia'],
  chile:        ['chile'],
  colombia:     ['colombia'],
  ecuador:      ['ecuador'],
  peru:         ['peru'],
  venezuela:    ['venezuela'],
  bolivia:      ['bolivia'],
  paraguay:     ['paraguay'],
  korea:        ['south_korea','kleague'],
  australia:    ['australia_aleague'],
};
function refreshLeagueTabs(allPicks) {
  document.querySelectorAll('#predSportTabs button[data-league]').forEach(btn => {
    const key = btn.dataset.league;
    if (!key || key === 'all' || key === 'todos') return;
    const patterns = LEAGUE_FILTER_PATTERNS[key];
    if (!patterns) return;
    // Solo mostrar el tab si hay al menos un pick activo (no iniciado) para esa liga
    // Si solo hay terminados, el tab quedaría vacío → ocultarlo directamente
    const hasActive = (allPicks || []).some(p => {
      if (p._started) return false; // ignorar terminados
      const sk = p._sportKey || '';
      return patterns.some(k => sk.includes(k));
    });
    btn.style.display = hasActive ? '' : 'none';
  });
}

function _lockedPicksKey() {
  const now = new Date();
  const d = now.getHours() < 6
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return 'locked_picks_v1_' + d.toISOString().slice(0, 10);
}

function _matchKeyLP(home, away) {
  return (normTeam(home || '') + '_vs_' + normTeam(away || '')).toLowerCase().replace(/\s+/g,'');
}

// Promise que se resuelve cuando sbLoadLockedPicks termina (con o sin datos)
// loadRealOdds la espera antes de renderizar — garantiza picks consistentes entre dispositivos
let _sbLockedPicksReady = null;
let _sbLockedPicksResolve = null;
_sbLockedPicksReady = new Promise(res => { _sbLockedPicksResolve = res; });

// ── Render diferido: evita que múltiples fuentes async llamen renderPreds en rápida sucesión ──
// Cada llamada a deferRender() cancela la anterior y programa una nueva en 80ms.
// Así, ráfagas de 2-3 renders asíncronos se colapsan en un solo render final.
let _deferRenderTimer = null;
function deferRender() {
  if (!window._rawOddsGames?.length) return; // sin datos aún, no tiene sentido
  clearTimeout(_deferRenderTimer);
  _deferRenderTimer = setTimeout(() => { _deferRenderTimer = null; renderPreds(); }, 80);
}

async function sbLoadLockedPicks() {
  try {
    const todayKey = _lockedPicksKey();
    // Calcular la clave del día anterior para cargar picks de anoche (Libertadores, Sudamericana, etc.)
    const _prevDate = new Date();
    if (_prevDate.getHours() < 6) _prevDate.setDate(_prevDate.getDate() - 1); // ya restamos 1 en _lockedPicksKey
    _prevDate.setDate(_prevDate.getDate() - 1); // un día más atrás = "ayer" real
    const prevKey = 'locked_picks_v1_' + _prevDate.toISOString().slice(0, 10);

    // Cargar picks de hoy y de ayer en paralelo
    const [todayRes, prevRes] = await Promise.all([
      sbAnon.from('shared_cache').select('data').eq('key', todayKey).maybeSingle(),
      sbAnon.from('shared_cache').select('data').eq('key', prevKey).maybeSingle(),
    ]);
    if (todayRes.data?.data && typeof todayRes.data.data === 'object') {
      window._sbLockedPicks = todayRes.data.data;
      console.log('[lockedPicks] Hoy cargados:', Object.keys(todayRes.data.data).length, 'picks');
    }
    if (prevRes.data?.data && typeof prevRes.data.data === 'object') {
      window._sbLockedPicksPrev = prevRes.data.data;
      console.log('[lockedPicks] Ayer cargados:', Object.keys(prevRes.data.data).length, 'picks');
    }
  } catch(e) { console.warn('[lockedPicks] Error al cargar:', e.message); }
  finally {
    // Siempre resolver la promise para desbloquear loadRealOdds
    if (_sbLockedPicksResolve) { _sbLockedPicksResolve(); _sbLockedPicksResolve = null; }
    // Re-renderizar si los picks ya estaban pintados (race: odds cargaron antes que Supabase)
    // Usar deferRender() para colapsar con el render de lockWait.then() en loadOdds
    deferRender();
  }
}

async function sbSaveLockedPicks(preds, force = false) {
  if (!preds?.length) return;
  const map = {};
  preds.forEach(p => {
    // 🛡️ (25-jun-2026 FIX RAÍZ) SKIP WC2026: NUNCA grabar picks WC en
    // shared_cache. La fuente de verdad es wc-matches.js → historial_full.
    // Cualquier cliente que grabara aquí envenenaba el lock global (bug
    // Egipto-Irán "Doble X2" recurrente). Los picks WC se actualizan
    // exclusivamente via runWcMatchesPublisher cron del worker.
    if (p._sportKey === 'soccer_fifa_world_cup' || p._wcMatch === true || p._wcFuture === true) {
      return; // skip — no contaminar shared_cache
    }
    map[_matchKeyLP(p.home, p.away)] = {
      conf: p.conf, bvr: p.bvr, bvrText: p.bvrText,
      rec: p.rec,
      bestOdds: p._bestOdds, hO: p._hO, aO: p._aO, dO: p._dO,
      probH: p.probH, probD: p.probD, probA: p.probA,
      // Guardar nombres reales y tiempo para poder mostrar picks incluso cuando el partido ya empezó
      home: p.home || null, away: p.away || null,
      commenceTs: p.commenceTs || null,
      sportKey: p._sportKey || null,
    };
  });
  if (!Object.keys(map).length) return;
  try {
    const key = _lockedPicksKey();
    if (force) {
      // Admin override: RLS bloquea UPDATE → delete + insert
      await sbClient.from('shared_cache').delete().eq('key', key);
      const { error } = await sbClient.from('shared_cache').insert({ key, data: map, fetched_at: new Date().toISOString() });
      if (!error) { window._sbLockedPicks = map; console.log('[lockedPicks] Force-guardados:', Object.keys(map).length, 'picks'); }
      else console.warn('[lockedPicks] Error force-insert:', error.message);
    } else {
      // ── Regla "el primero gana, pero bvr solo puede subir" ──
      // Si ya hay un lock en Supabase, respetar sus valores SALVO que el nuevo tenga bvr mayor
      // (ej: weekend logic sube a bvr=6 después de que el primer lock guardó bvr=5).
      const client = (typeof authUser !== 'undefined' && authUser) ? sbClient : sbAnon;
      const { data: existing } = await client
        .from('shared_cache').select('data').eq('key', key).maybeSingle();
      if (existing?.data && Object.keys(existing.data).length > 0) {
        // Merge: mantener datos existentes, pero subir bvr si el nuevo es mayor
        const merged = { ...existing.data };
        let upgraded = false;
        Object.keys(map).forEach(mk => {
          const newBvr = map[mk]?.bvr || 0;
          const oldBvr = merged[mk]?.bvr || 0;
          if (newBvr > oldBvr) {
            merged[mk] = { ...(merged[mk] || {}), ...map[mk] };
            upgraded = true;
          }
        });
        if (upgraded) {
          // Actualizar Supabase con el merge (delete + insert por RLS)
          // Usar siempre sbClient (autenticado) para el upgrade — el anon no tiene permisos DELETE
          const upgradeClient = (typeof sbClient !== 'undefined') ? sbClient : client;
          await upgradeClient.from('shared_cache').delete().eq('key', key);
          const { error: ue } = await upgradeClient.from('shared_cache').insert({ key, data: merged, fetched_at: new Date().toISOString() });
          if (!ue) { window._sbLockedPicks = merged; console.log('[lockedPicks] bvr upgraded en Supabase'); }
          else console.warn('[lockedPicks] Error upgrade:', ue.message);
        } else {
          // Sin cambios — cargar en memoria si aún no estaba
          if (!Object.keys(window._sbLockedPicks).length) {
            window._sbLockedPicks = existing.data;
            console.log('[lockedPicks] Lock existente en Supabase — no se sobreescribe. Picks:', Object.keys(existing.data).length);
            deferRender();
          }
        }
        return;
      }
      // No existe lock todavía — guardar el primero
      const { error } = await client
        .from('shared_cache')
        .insert({ key, data: map, fetched_at: new Date().toISOString() });
      if (!error) {
        window._sbLockedPicks = map;
        console.log('[lockedPicks] Primer lock del día guardado:', Object.keys(map).length, 'picks');
      } else console.warn('[lockedPicks] Error al guardar primer lock:', error.message);
    }
  } catch(e) { console.warn('[lockedPicks] Error al guardar:', e.message); }
}

// Admin: resetea el lock del día y regenera picks frescos desde la API
async function adminResetLockedPicks() {
  if (authUser?.email !== ADMIN_EMAIL) return;
  const btn = event?.target;
  const orig = btn?.textContent;
  if (btn) { btn.textContent = '⏳ Reseteando…'; btn.disabled = true; }
  try {
    // 1. Borrar lock actual de Supabase
    const { error: delErr } = await sbClient
      .from('shared_cache').delete().eq('key', _lockedPicksKey());
    if (delErr) throw new Error(delErr.message);
    // 2. Limpiar memoria local
    window._sbLockedPicks = {};
    // 3. Limpiar caché de odds para forzar re-fetch
    localStorage.removeItem('cache_odds_v10');
    localStorage.removeItem(DAILY_PREDS_KEY || 'gambeta_daily_preds_v15');
    // 4. Recargar odds y re-renderizar (el flujo normal guardará el nuevo lock)
    if (btn) { btn.textContent = '🔄 Recargando cuotas…'; }
    await loadOdds();  // recarga odds y llama renderPreds() internamente
    if (btn) { btn.textContent = '✅ Lock reseteado'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000); }
  } catch(e) {
    console.error('[adminResetLock]', e.message);
    if (btn) { btn.textContent = '❌ Error: ' + e.message; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 4000); }
  }
}

// Carga picks bloqueados en cuanto la página arranca (antes de renderizar)
sbLoadLockedPicks();

// ── Pick Estrella override (admin puede pinear cualquier pick como estrella del finde) ──
function _estrellaKey() {
  const now = new Date();
  const d = now.getHours() < 6
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return 'estrella_finde_v1_' + d.toISOString().slice(0, 10);
}
// Estrella override — usa acoin_users.admin_cfg (shared_cache tiene RLS que bloquea writes)
async function sbLoadEstrellaOverride() {
  try {
    const { data } = await sbAnon
      .from('acoin_users').select('admin_cfg').eq('email', ADMIN_EMAIL).maybeSingle();
    const cfg = data?.admin_cfg;
    const today = new Date().toISOString().slice(0,10);
    const ov = cfg?.estrella_override;
    if (ov?.home && ov?.date === today) {
      window._estrellaOverride = { home: ov.home, away: ov.away };
      console.log('[estrella] Override cargado:', ov.home, 'vs', ov.away);
      deferRender();
    }
  } catch(e) { console.warn('[estrella] Error al cargar override:', e.message); }
}
async function sbSaveEstrellaOverride(home, away) {
  if (authUser?.email !== ADMIN_EMAIL) return;
  try {
    const { data } = await sbClient
      .from('acoin_users').select('admin_cfg').eq('email', ADMIN_EMAIL).maybeSingle();
    const cfg = data?.admin_cfg || {};
    const today = new Date().toISOString().slice(0,10);
    cfg.estrella_override = { home, away, date: today };
    const { error } = await sbClient
      .from('acoin_users')
      .upsert({ email: ADMIN_EMAIL, admin_cfg: cfg, updated_at: new Date().toISOString() },
               { onConflict: 'email' });
    if (!error) {
      window._estrellaOverride = { home, away };
      renderPreds();
      console.log('[estrella] Override guardado en acoin_users:', home, 'vs', away);
    } else console.warn('[estrella] Error al guardar:', error.message);
  } catch(e) { console.warn('[estrella] Error al guardar:', e.message); }
}
async function sbClearEstrellaOverride() {
  if (authUser?.email !== ADMIN_EMAIL) return;
  try {
    const { data } = await sbClient
      .from('acoin_users').select('admin_cfg').eq('email', ADMIN_EMAIL).maybeSingle();
    const cfg = data?.admin_cfg || {};
    delete cfg.estrella_override;
    await sbClient
      .from('acoin_users')
      .upsert({ email: ADMIN_EMAIL, admin_cfg: cfg, updated_at: new Date().toISOString() },
               { onConflict: 'email' });
    window._estrellaOverride = null;
    renderPreds();
    console.log('[estrella] Override eliminado');
  } catch(e) { console.warn('[estrella] Error al eliminar override:', e.message); }
}

// Función admin: abre selector de estrella del finde
function admOpenEstrellaPicker() {
  const preds = (window._allAvailablePicks || [])
    .filter(p => p.conf === 'high' && !p._started)
    .sort((a,b) => (b.bvr||0)-(a.bvr||0));
  if (!preds.length) { alert('No hay picks Alta/Máxima disponibles ahora.'); return; }
  const listHtml = preds.map((p,i) => {
    const bvrLbl = p.bvrText || (p.bvr>=6?'Máxima':p.bvr>=5?'Alta':p.bvr>=4?'Media-Alta':'Media');
    const isActive = window._estrellaOverride &&
      teamsMatch(p.home, window._estrellaOverride.home) &&
      teamsMatch(p.away, window._estrellaOverride.away);
    return `<button onclick="admSetEstrella(${JSON.stringify(p.home)},${JSON.stringify(p.away)})"
      style="display:flex;align-items:center;justify-content:space-between;width:100%;background:${isActive?'rgba(255,214,0,0.15)':'rgba(255,255,255,0.04)'};
      border:1px solid ${isActive?'rgba(255,214,0,0.5)':'rgba(255,255,255,0.1)'};border-radius:10px;padding:10px 14px;
      cursor:pointer;color:#fff;margin-bottom:6px;gap:8px;text-align:left">
      <span style="font-size:0.82rem;font-weight:700">${p.home} vs ${p.away}</span>
      <span style="font-size:0.72rem;color:${p.bvr>=6?'#ffd600':'#66bb6a'};font-weight:800">${bvrLbl}</span>
    </button>`;
  }).join('');
  const clearBtn = window._estrellaOverride
    ? `<button onclick="admClearEstrella()" style="width:100%;margin-top:4px;padding:8px;background:rgba(255,61,61,0.1);border:1px solid rgba(255,61,61,0.3);color:#ef5350;border-radius:8px;cursor:pointer;font-size:0.8rem;font-weight:600">✕ Quitar override (volver a automático)</button>`
    : '';
  const overlay = document.createElement('div');
  overlay.id = 'estrellaPickerOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `<div style="background:#0f1a0f;border:1px solid rgba(255,214,0,0.4);border-radius:16px;padding:20px;max-width:420px;width:100%;max-height:80vh;overflow-y:auto">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div style="font-weight:800;color:#fff;font-size:0.95rem">⭐ Elegir Pick Estrella del Finde</div>
      <button onclick="document.getElementById('estrellaPickerOverlay').remove()" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer">✕</button>
    </div>
    ${listHtml}
    ${clearBtn}
  </div>`;
  document.body.appendChild(overlay);
}
async function admSetEstrella(home, away) {
  document.getElementById('estrellaPickerOverlay')?.remove();
  await sbSaveEstrellaOverride(home, away);
}
async function admClearEstrella() {
  document.getElementById('estrellaPickerOverlay')?.remove();
  await sbClearEstrellaOverride();
}

sbLoadEstrellaOverride();

// ── Admin overrides: bvr forzado por admin, guardado en acoin_users (no shared_cache) ──
// Se lee en sbLoadAdminOverrides() al cargar la página — aplica a _sbLockedPicks en memoria.
// Los overrides se guardan como array de {mk, date} en el campo last_daily del admin.
// Usamos acoin_users porque shared_cache tiene RLS que bloquea INSERT/UPDATE autenticado.

// _ADMIN_OVERRIDES_EMAIL removido — usar ADMIN_EMAIL directamente para evitar TDZ

async function sbLoadAdminOverrides() {
  try {
    const { data } = await sbAnon
      .from('acoin_users').select('admin_cfg').eq('email', ADMIN_EMAIL).maybeSingle();
    const cfg = data?.admin_cfg;
    if (!cfg?.maxima_overrides?.length) return;
    const today = new Date().toISOString().slice(0,10);
    const todayOvr = cfg.maxima_overrides.filter(o => o.date === today);
    if (!todayOvr.length) return;
    todayOvr.forEach(o => {
      if (!window._sbLockedPicks[o.mk]) window._sbLockedPicks[o.mk] = {};
      window._sbLockedPicks[o.mk].bvr     = 6;
      window._sbLockedPicks[o.mk].bvrText = 'Máxima';
      window._sbLockedPicks[o.mk].conf    = 'high';
    });
    console.log('[adminOverrides] Aplicados:', todayOvr.length, 'overrides de Máxima');
    deferRender();
  } catch(e) { console.warn('[adminOverrides] Error al cargar:', e.message); }
}

async function sbSaveAdminOverride(mk) {
  if (authUser?.email !== ADMIN_EMAIL) return;
  try {
    const { data } = await sbClient
      .from('acoin_users').select('admin_cfg').eq('email', ADMIN_EMAIL).maybeSingle();
    const cfg = data?.admin_cfg || {};
    const overrides = (cfg.maxima_overrides || []).filter(o => o.mk !== mk); // dedup
    const today = new Date().toISOString().slice(0,10);
    overrides.push({ mk, date: today });
    cfg.maxima_overrides = overrides;
    const { error } = await sbClient
      .from('acoin_users')
      .upsert({ email: ADMIN_EMAIL, admin_cfg: cfg, updated_at: new Date().toISOString() },
               { onConflict: 'email' });
    if (error) throw new Error(error.message);
    console.log('[adminOverrides] ✓ Guardado override Máxima:', mk);
  } catch(e) { throw e; }
}

// Esperar a que sbLoadLockedPicks termine para evitar race condition:
// si los overrides se aplican antes, sbLoadLockedPicks los pisa al asignar window._sbLockedPicks = data
_sbLockedPicksReady.then(() => sbLoadAdminOverrides());

// ── Overrides hardcodeados por fecha — no dependen de Supabase ──
// Se aplican en memoria para TODOS los usuarios. Agregar cuando sea necesario.
const _HARDCODED_MAXIMA = {}; // fechas pasadas eliminadas
(function _applyHardcodedMaxima() {
  const today = new Date().toISOString().slice(0, 10);
  const keys  = _HARDCODED_MAXIMA[today] || [];
  if (!keys.length) return;
  // Aplicar cuando el lock esté disponible (puede llegar async)
  function _apply() {
    let changed = false;
    keys.forEach(mk => {
      if (!window._sbLockedPicks[mk]) window._sbLockedPicks[mk] = {};
      if (window._sbLockedPicks[mk].bvr !== 6) {
        window._sbLockedPicks[mk].bvr     = 6;
        window._sbLockedPicks[mk].bvrText = 'Máxima';
        window._sbLockedPicks[mk].conf    = 'high';
        changed = true;
      }
    });
    if (changed) deferRender();
  }
  // Intentar de inmediato y luego a los 2s (cuando Supabase haya respondido)
  _apply();
  setTimeout(_apply, 2000);
})();

// ── Estrella del Finde hardcodeada por fecha (independiente de Supabase) ──
const _HARDCODED_ESTRELLA = {}; // fechas pasadas eliminadas
(function _applyHardcodedEstrella() {
  const today = new Date().toISOString().slice(0, 10);
  const estrella = _HARDCODED_ESTRELLA[today];
  if (!estrella) return;
  function _apply() {
    // Solo sobreescribir si no hay un override más reciente cargado de Supabase
    if (!window._estrellaOverride) {
      window._estrellaOverride = estrella;
      deferRender();
    }
  }
  _apply();
  setTimeout(_apply, 500);
  setTimeout(() => {
    if (!window._estrellaOverride) {
      window._estrellaOverride = estrella;
      deferRender();
    }
  }, 3000);
})();

// ── Admin: elevar confianza de un pick manualmente ──
// Abre popup con todos los picks del día; admin elige uno y lo sube a Máxima (bvr=6)
function admOpenConfPicker() {
  if (authUser?.email !== ADMIN_EMAIL) return;

  // Fuente de datos: primero _sbLockedPicks (siempre cargado), luego _allAvailablePicks como enriquecimiento
  const lockKeys = Object.keys(window._sbLockedPicks || {});
  const livePicks = window._allAvailablePicks || [];

  // Construir lista unificada: cada key del lock, enriquecida con home/away de livePicks si existe
  const items = lockKeys.map(mk => {
    const ld = window._sbLockedPicks[mk];
    // Intentar encontrar el partido vivo para obtener nombres legibles
    const live = livePicks.find(p => _matchKeyLP(p.home, p.away) === mk);
    // Reconstruir nombres desde la key si no hay live
    const parts = mk.replace(/_vs_/, '|||').split('|||');
    const home = live?.home || parts[0]?.replace(/_/g,' ') || mk;
    const away = live?.away || parts[1]?.replace(/_/g,' ') || '';
    const rec  = live?.rec  || ld.rec || '';
    return { mk, home, away, rec, bvr: ld.bvr||3, bvrText: ld.bvrText||'Media' };
  }).sort((a,b) => b.bvr - a.bvr);

  if (!items.length) {
    alert('El lock de picks aún no cargó. Esperá unos segundos y reintentá.');
    return;
  }

  const listHtml = items.map(it => {
    const isMax = it.bvr >= 6;
    const color = isMax ? '#ffd600' : it.bvr >= 5 ? '#66bb6a' : it.bvr >= 4 ? '#e64a19' : '#aaa';
    return `<button id="cpbtn_${it.mk}" onclick="admForceMaxima('${it.mk}')"
      style="display:flex;align-items:center;justify-content:space-between;width:100%;
      background:${isMax?'rgba(255,214,0,0.12)':'rgba(255,255,255,0.04)'};
      border:1px solid ${isMax?'rgba(255,214,0,0.5)':'rgba(255,255,255,0.1)'};
      border-radius:10px;padding:10px 14px;cursor:pointer;color:#fff;margin-bottom:6px;gap:8px;text-align:left">
      <div style="min-width:0">
        <div style="font-size:0.84rem;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${it.home} vs ${it.away}</div>
        <div style="font-size:0.7rem;color:var(--texto-sec)">${it.rec}</div>
      </div>
      <span style="font-size:0.75rem;font-weight:800;color:${color};white-space:nowrap;flex-shrink:0">${it.bvrText}${isMax?' ✓':''}</span>
    </button>`;
  }).join('');

  document.getElementById('confPickerOverlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'confPickerOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:#0f1a0f;border:1px solid rgba(0,200,83,0.4);border-radius:16px;padding:20px;max-width:460px;width:100%;max-height:82vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div style="font-weight:800;color:#fff;font-size:0.95rem">💰 Elevar pick a Máxima Confianza</div>
        <button onclick="document.getElementById('confPickerOverlay').remove()" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.1);color:#fff;width:28px;height:28px;border-radius:50%;cursor:pointer;font-size:1rem">✕</button>
      </div>
      <div style="font-size:0.72rem;color:var(--texto-sec);margin-bottom:14px">Tocá el partido → queda bvr=6 para todos los usuarios.</div>
      <div id="confPickerStatus" style="display:none;padding:8px 12px;border-radius:8px;font-size:0.8rem;font-weight:700;margin-bottom:10px"></div>
      ${listHtml}
    </div>`;
  document.body.appendChild(overlay);
}

async function admForceMaxima(mk) {
  if (authUser?.email !== ADMIN_EMAIL) return;
  const statusEl = document.getElementById('confPickerStatus');
  if (statusEl) { statusEl.style.display='block'; statusEl.style.background='rgba(255,214,0,0.1)'; statusEl.style.color='#ffd600'; statusEl.textContent='⏳ Guardando…'; }

  // Aplicar en memoria inmediatamente
  if (!window._sbLockedPicks[mk]) window._sbLockedPicks[mk] = {};
  window._sbLockedPicks[mk].bvr     = 6;
  window._sbLockedPicks[mk].bvrText = 'Máxima';
  window._sbLockedPicks[mk].conf    = 'high';

  try {
    // Guardar en acoin_users (admin_cfg) — tabla que sí permite escrituras autenticadas
    await sbSaveAdminOverride(mk);
    if (statusEl) { statusEl.style.background='rgba(0,200,83,0.1)'; statusEl.style.color='#00c853'; statusEl.textContent='✅ Guardado. Todos los usuarios verán Máxima al recargar.'; }
    console.log('[admForceMaxima] ✓', mk, '→ Máxima');
    setTimeout(() => { document.getElementById('confPickerOverlay')?.remove(); renderPreds(); }, 1500);
  } catch(e) {
    if (statusEl) { statusEl.style.background='rgba(255,61,61,0.1)'; statusEl.style.color='#ef5350'; statusEl.textContent='❌ ' + e.message; }
    console.warn('[admForceMaxima]', e.message);
  }
}

// Guarda el historial GLOBAL en shared_cache (solo admin)
// Si el trigger Postgres (sync_admin_historial_trigger) está instalado, este
// upsert es redundante — el trigger se dispara automáticamente al escribir
// acoin_users.historial_full. Lo mantenemos como backup por si el trigger
// no está disponible (deploys nuevos, ambientes de dev, etc).
async function sbSaveGlobalHistorial(arr) {
  if (authUser?.email !== ADMIN_EMAIL) return;
  try {
    const { error } = await sbClient
      .from('shared_cache')
      .upsert({ key: GLOBAL_HIST_KEY, data: arr.slice(-1000000), fetched_at: new Date().toISOString() },
               { onConflict: 'key' });
    if (error) console.warn('[globalHistSave]', error.message);
    else console.log('[globalHistSave] ✓', arr.length, 'entradas');
  } catch(e) { console.warn('[globalHistSave]', e.message); }
}

// Verifica si shared_cache está desincronizado de acoin_users.historial_full
// (admin only). Si lo está, dispara un UPDATE noop sobre acoin_users que activa
// el trigger Postgres → shared_cache se actualiza solo. Como fallback si el
// trigger no está, hace upsert directo a shared_cache.
//
// Se llama en el flujo de login del admin para reparar staleness histórica.
async function sbReconcileSharedCache() {
  if (authUser?.email !== ADMIN_EMAIL) return;
  try {
    // 1. Leer ambas fuentes
    const [usersRow, cacheRow] = await Promise.all([
      sbClient.from('acoin_users').select('historial_full').eq('email', ADMIN_EMAIL).maybeSingle(),
      sbClient.from('shared_cache').select('data').eq('key', GLOBAL_HIST_KEY).maybeSingle(),
    ]);
    const usersHist = Array.isArray(usersRow.data?.historial_full) ? usersRow.data.historial_full : [];
    const cacheHist = Array.isArray(cacheRow.data?.data) ? cacheRow.data.data : [];

    // 2. Si están desincronizados (diferencia > 5 picks), reparar.
    const drift = Math.abs(usersHist.length - cacheHist.length);
    if (drift <= 5) {
      console.log(`[reconcileCache] OK — users=${usersHist.length}, cache=${cacheHist.length}`);
      return;
    }
    console.warn(`[reconcileCache] DESINCRONIZADO — users=${usersHist.length}, cache=${cacheHist.length}. Reparando...`);

    // 3. Tomar la fuente con MÁS picks como fuente de verdad.
    const sourceOfTruth = usersHist.length >= cacheHist.length ? usersHist : cacheHist;

    // 4. Escribir a ambos sitios para garantizar coherencia.
    //    El trigger Postgres se va a disparar con el UPDATE de acoin_users.
    //    Si el trigger no está instalado, el upsert a shared_cache lo cubre.
    await Promise.all([
      sbClient.from('acoin_users').upsert(
        { email: ADMIN_EMAIL, historial_full: sourceOfTruth.slice(-1000000), updated_at: new Date().toISOString() },
        { onConflict: 'email' }
      ),
      sbClient.from('shared_cache').upsert(
        { key: GLOBAL_HIST_KEY, data: sourceOfTruth.slice(-1000000), fetched_at: new Date().toISOString() },
        { onConflict: 'key' }
      ),
    ]);
    console.log(`[reconcileCache] ✓ Sincronizado a ${sourceOfTruth.length} picks`);
  } catch(e) {
    console.warn('[reconcileCache]', e.message);
  }
}

// Lee el historial GLOBAL — usa el proxy /api/sb con caché de servidor Cloudflare
// El caché es compartido entre todos los usuarios (edge cache), no por navegador
// forceFresh=true → ignora caché local y consulta directo a Supabase (admin como fuente de verdad)
async function sbLoadGlobalHistorial(forceFresh = false) {
  // 1. Caché local como backup secundario (2 min) — saltado si forceFresh
  if (!forceFresh) {
    const cached = _sbGetCache('ghist');
    if (cached) return Array.isArray(cached) ? cached : null;
  }
  // Estrategia: pedimos AMBAS fuentes en paralelo (proxy CDN + Supabase directo)
  // y nos quedamos con la que tenga MÁS picks. Esto evita quedarnos con un CDN cache stale.
  // Timeout helper: una promesa que rechaza si tarda más de ms — evita que
  // un fetch colgado deje el historial en skeleton para siempre (bug 1ra visita).
  const _raceTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)),
  ]);
  const _resBest = (async () => {
    let fromProxy = null, fromDirect = null;
    try {
      const _ctrl = new AbortController();
      const _to = setTimeout(() => _ctrl.abort(), 8000);
      const resp = await fetch('/api/sb?type=historial' + (forceFresh ? `&t=${Date.now()}` : ''), { signal: _ctrl.signal });
      clearTimeout(_to);
      if (resp.ok) {
        const rows = await resp.json();
        const r = rows?.[0]?.historial_full;
        if (Array.isArray(r)) fromProxy = r;
      }
    } catch(_) {}
    try {
      const { data } = await _raceTimeout(
        sbAnon.from('acoin_users').select('historial_full').eq('email', ADMIN_EMAIL).maybeSingle(),
        8000
      );
      if (Array.isArray(data?.historial_full)) fromDirect = data.historial_full;
    } catch(_) {}
    if (!fromProxy && !fromDirect) return null;
    const a = fromProxy?.length || 0, b = fromDirect?.length || 0;
    return a >= b ? fromProxy : fromDirect;
  })();
  const result = await _resBest;
  if (Array.isArray(result)) _sbSetCache('ghist', result, _SB_TTL_GHIST);
  return result || null;
}

async function sbSaveHistorial(arr) {
  if (!authUser?.email) return;
  try {
    const { error } = await sbClient
      .from('acoin_users')
      .upsert({ email: authUser.email, historial_full: arr.slice(-1000000), updated_at: new Date().toISOString() },
               { onConflict: 'email' });
    if (error) console.warn('[histSave]', error.message);
  } catch(e) { console.warn('[histSave]', e.message); }
}

let _histLoading     = false;
let _histLoadFailed  = false;
let _histLoadedOnce  = false;

// 🛡️ Aplicar resolveWcLocal a todos los picks recibidos
function _applyWcLocalToList(list) {
  if (!Array.isArray(list)) return list;
  return list.map(p => (typeof resolveWcLocal === 'function' ? resolveWcLocal(p) : p));
}

async function sbLoadHistorial() {
  _histLoading = true;
  _histLoadFailed = false;
  // 1. Cargar historial global (para todos, incluso anónimos)
  let globalHist;
  try {
    globalHist = await sbLoadGlobalHistorial();
  } catch(e) {
    console.warn('[sbLoadHistorial] Error cargando global:', e.message);
    globalHist = null;
  }

  if (authUser?.email === ADMIN_EMAIL) {
    // Admin: merge global + historial_full DB + local → fuente de verdad completa
    const localHist = loadHistorial();

    // Siempre leer historial_full desde acoin_users (tiene los 46 picks completos)
    let dbHist = [];
    try {
      const { data: dbRow } = await sbClient
        .from('acoin_users')
        .select('historial_full')
        .eq('email', ADMIN_EMAIL)
        .maybeSingle();
      if (dbRow?.historial_full?.length) dbHist = dbRow.historial_full;
      if (dbHist.length) console.log('[globalHist] Admin: historial_full desde DB:', dbHist.length, 'entradas');
    } catch(e) { console.warn('[globalHist] Error leyendo historial_full:', e.message); }

    // Deduplicar: global + DB + local. Preferimos siempre la entrada RESUELTA (win/loss/void)
    // sobre la pending — evita que un global stale "pisar" el resultado ya calculado en local.
    // Clave canónica POR PARTIDO (no por id — pending y resuelto pueden tener ids distintos)
    const _hKey = h => {
      const norm = s => (s||'').toString().toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
      const day = h.commenceTs ? new Date(h.commenceTs).toISOString().slice(0,10)
                : (h.date ? String(h.date).slice(0,10) : '');
      const k = norm(h.home) + '|' + norm(h.away) + '|' + day;
      return k === '||' ? (h.id || JSON.stringify(h).slice(0,40)) : k;
    };
    const _resolvedRank = h => (h?.result === 'win' || h?.result === 'loss') ? 2
                              : h?.result === 'void' ? 1
                              : 0;
    // ── Filtro de seguridad runtime: descartar picks pendientes >14d futuros ──
    // Mauro pidió que no se publiquen picks tan anticipados. Si quedó alguno en
    // localStorage (cache vieja) lo descartamos aquí, aunque Supabase ya esté limpio.
    const _MAX_FUTURE_MS = 14 * 24 * 3600 * 1000;
    const _nowFutureGuard = Date.now();
    const _isStaleFuture = h => {
      if (!h || !h.commenceTs) return false;
      const res = (h.result || '').toString().toLowerCase();
      if (res && res !== 'pending') return false; // resueltos siempre pasan
      return (h.commenceTs - _nowFutureGuard) > _MAX_FUTURE_MS;
    };
    const _g = (globalHist||[]).filter(h=>!_isStaleFuture(h));
    const _d = (dbHist||[]).filter(h=>!_isStaleFuture(h));
    const _l = (localHist||[]).filter(h=>!_isStaleFuture(h));
    const _filteredCount = (globalHist?.length||0)+(dbHist?.length||0)+(localHist?.length||0) - _g.length - _d.length - _l.length;
    if (_filteredCount > 0) console.log('[histGuard] Descartados', _filteredCount, 'picks futuros >14d (cache vieja)');
    const allEntries = [..._g, ..._d, ..._l];
    const seen = new Map();
    allEntries.forEach(h => {
      const k = _hKey(h);
      const ex = seen.get(k);
      if (!ex) { seen.set(k, h); return; }
      // Si la nueva está resuelta y la existente no, reemplazar
      if (_resolvedRank(h) > _resolvedRank(ex)) seen.set(k, h);
    });
    let merged = [...seen.values()].filter(h=>!BLOCKED_HIST_IDS.has(h?.id||'')).sort((a,b)=>(b.commenceTs||0)-(a.commenceTs||0));

    // ── Segunda pasada anti-duplicados: mismo enfrentamiento (home+away) registrado
    //    2 veces con timestamps distintos. Si uno está RESUELTO y otro PENDING dentro
    //    de ±3 días, descartar el PENDING (es el mismo partido mal duplicado).
    //    Ventana corta: NO toca ida/vuelta de copas (legs ≥6-7 días aparte).
    const _matchKey = h => {
      const norm = s => (s||'').toString().toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
      return norm(h.home) + '|' + norm(h.away);
    };
    const _WIN6D = 3 * 24 * 3600 * 1000;
    const resolvedByMatch = {};
    merged.forEach(h => {
      if (_resolvedRank(h) > 0 && h.commenceTs) {
        const mk = _matchKey(h);
        (resolvedByMatch[mk] = resolvedByMatch[mk] || []).push(h.commenceTs);
      }
    });
    merged = merged.filter(h => {
      if (_resolvedRank(h) > 0) return true;            // resuelto: siempre queda
      if (!h.commenceTs) return true;
      const mk = _matchKey(h);
      const resolvedTs = resolvedByMatch[mk];
      if (!resolvedTs) return true;
      // Hay un resuelto del mismo enfrentamiento cerca → este pending es duplicado
      const dup = resolvedTs.some(ts => Math.abs(ts - h.commenceTs) < _WIN6D);
      return !dup;
    });

    // ── Migración global de stakes (backtesting) ──────────────────────────────
    // Máxima(6)=$170 | Alta(5)=$130 | Media-Alta(4)=$50 | Media(3)=$30 | Baja=$15
    let stakesMigrated = 0;
    merged.forEach(p => {
      const odds = parseFloat(p.odds) || 1;
      let bvr = p.bvr || 0;
      if (!bvr) {
        const maxProb = Math.max(p.probH || 0, p.probA || 0);
        const conf = p.conf || (p.stake >= 130 ? 'high' : 'med');
        if      (p.stake >= 150 || p.bvrText === 'Máxima')  bvr = 6;
        else if (conf === 'high' && maxProb >= 75)           bvr = 6;
        else if (conf === 'high')                            bvr = 5;
        else if (conf === 'med'  && maxProb >= 58)           bvr = 4;
        else                                                 bvr = 3;
      }
      const correctStake = bvr >= 6 ? 170 : bvr === 5 ? 130 : bvr === 4 ? 50 : bvr === 3 ? 30 : 30;

      // Corregir cuota: usar cuota real del bookmaker si está disponible
      let correctOdds = odds;
      if      (p.rec === 'Gana Local'     && p._hO)  correctOdds = parseFloat(parseFloat(p._hO).toFixed(2));
      else if (p.rec === 'Gana Visitante' && p._aO)  correctOdds = parseFloat(parseFloat(p._aO).toFixed(2));
      else if (p.rec === 'Empate'         && p._dO)  correctOdds = parseFloat(parseFloat(p._dO).toFixed(2));
      else if (p.rec === 'Doble 1X' && p._hO && p._dO) correctOdds = parseFloat(((p._hO * p._dO) / (p._hO + p._dO)).toFixed(2));  // 🆕 DO
      else if (p.rec === 'Doble X2' && p._aO && p._dO) correctOdds = parseFloat(((p._aO * p._dO) / (p._aO + p._dO)).toFixed(2));  // 🆕 DO
      else if (p._bestOdds)                           correctOdds = parseFloat(parseFloat(p._bestOdds).toFixed(2));

      const stakeChanged = p.stake !== correctStake;
      const oddsChanged  = correctOdds > 1 && Math.abs((p.odds || 0) - correctOdds) > 0.005;

      if (stakeChanged || oddsChanged) {
        if (stakeChanged) p.stake = correctStake;
        if (oddsChanged)  p.odds  = correctOdds;
        const finalOdds  = p.odds;
        const finalStake = p.stake;
        if      (p.result === 'win')  p.pl = parseFloat(((finalOdds - 1) * finalStake).toFixed(2));
        else if (p.result === 'loss') p.pl = -finalStake;
        else                          p.pl = 0;
        stakesMigrated++;
      }
    });
    if (stakesMigrated) console.log('[globalHist] Migración stakes+odds:', stakesMigrated, 'entradas corregidas');

    // Actualizar shared_cache si el merge tiene más entradas o hubo migración de stakes
    const prevCount = globalHist?.length || 0;
    if (merged.length > prevCount || stakesMigrated > 0) {
      console.log('[globalHist] Admin: actualizando shared_cache con', merged.length, 'entradas (antes:', prevCount, ', stakes migrados:', stakesMigrated, ')');
      await sbSaveGlobalHistorial(merged);
    }

    try { localStorage.setItem(HIST_KEY, JSON.stringify(merged)); } catch {}
    _markHistLoaded();
    renderHistorial(histFilter);
    return;
  }

  // Otros usuarios: merge global + local (conservar picks locales no presentes en global)
  if (globalHist && globalHist.length > 0) {
    const _fg = globalHist.filter(h=>!BLOCKED_HIST_IDS.has(h?.id||''));
    const _localHist = loadHistorial();
    const _hKeyM = h => h.id || `${h.home}|||${h.away}|||${h.commenceTs||h.date||''}`;
    const _globalKeys = new Set(_fg.map(_hKeyM));
    const _localOnly = _localHist.filter(h => !_globalKeys.has(_hKeyM(h)));
    const _merged = [..._fg, ..._localOnly].sort((a,b)=>(b.commenceTs||0)-(a.commenceTs||0)).slice(0,1000000);
    try { localStorage.setItem(HIST_KEY, JSON.stringify(_merged)); } catch {}
    _markHistLoaded();
    renderHistorial(histFilter);
    return;
  }

  // Sin historial global ni local → marcar fallo para mostrar retry
  _histLoading = false;
  _histLoadedOnce = true;
  _histLoadFailed = loadHistorial().length === 0;
  renderHistorial(histFilter);

  // Fallback legacy: historial personal en acoin_users
  if (!authUser?.email) return;
  try {
    const { data, error } = await sbClient
      .from('acoin_users')
      .select('historial_full')
      .eq('email', authUser.email)
      .maybeSingle();
    if (error || !data?.historial_full?.length) return;
    const localHist = loadHistorial();
    const _hKey2 = h => h.id || `${h.home}|||${h.away}|||${h.date||''}`;
    const dbKeys = new Set(data.historial_full.map(_hKey2));
    const localOnly = localHist.filter(h => !dbKeys.has(_hKey2(h)));
    const merged = [...data.historial_full, ...localOnly].slice(-1000000);
    try { localStorage.setItem(HIST_KEY, JSON.stringify(merged)); } catch {}
    _histLoading = false; _histLoadedOnce = true;
    renderHistorial(histFilter);
  } catch(e) {
    console.warn('[histLoad]', e.message);
    _histLoading = false;
    _histLoadFailed = loadHistorial().length === 0;
    _histLoadedOnce = true;
    renderHistorial(histFilter);
  }
}

// Helper: marca fin exitoso de carga del historial (llamado desde los return tempranos)
function _markHistLoaded() { _histLoading = false; _histLoadedOnce = true; _histLoadFailed = false; }

// Migración: recalcula stake y P/L según nuevo esquema bvr
// Máxima(6)=$170 | Alta(5)=$130 | Media-Alta(4)=$50 | Media(3)=$30 | Baja=$15
function migrateHistStakes() {
  const hist = loadHistorial();
  let changed = false;
  hist.forEach(p => {
    const odds = parseFloat(p.odds) || 1;
    // Reconstruir bvr desde los datos guardados si no viene almacenado
    let bvr = p.bvr || 0;
    if (!bvr) {
      const maxProb = Math.max(p.probH || 0, p.probA || 0);
      const conf = p.conf || (p.stake >= 130 ? 'high' : 'med');
      if      (p.stake >= 150 || p.bvrText === 'Máxima')  bvr = 6;
      else if (conf === 'high' && maxProb >= 75)           bvr = 6;
      else if (conf === 'high')                            bvr = 5;
      else if (conf === 'med'  && maxProb >= 58)           bvr = 4;
      else                                                 bvr = 3;
    }
    const correctStake = bvr >= 6 ? 170 : bvr === 5 ? 130 : bvr === 4 ? 50 : bvr === 3 ? 30 : 30;

    // Corregir cuota: usar cuota real del bookmaker si está disponible
    let correctOdds = odds;
    if      (p.rec === 'Gana Local'     && p._hO)  correctOdds = parseFloat(parseFloat(p._hO).toFixed(2));
    else if (p.rec === 'Gana Visitante' && p._aO)  correctOdds = parseFloat(parseFloat(p._aO).toFixed(2));
    else if (p.rec === 'Empate'         && p._dO)  correctOdds = parseFloat(parseFloat(p._dO).toFixed(2));
    else if (p.rec === 'Doble 1X' && p._hO && p._dO) correctOdds = parseFloat(((p._hO * p._dO) / (p._hO + p._dO)).toFixed(2));  // 🆕 DO
    else if (p.rec === 'Doble X2' && p._aO && p._dO) correctOdds = parseFloat(((p._aO * p._dO) / (p._aO + p._dO)).toFixed(2));  // 🆕 DO
    else if (p._bestOdds)                           correctOdds = parseFloat(parseFloat(p._bestOdds).toFixed(2));

    const stakeChanged = p.stake !== correctStake;
    const oddsChanged  = correctOdds > 1 && Math.abs((p.odds || 0) - correctOdds) > 0.005;

    if (stakeChanged || oddsChanged) {
      if (stakeChanged) p.stake = correctStake;
      if (oddsChanged)  p.odds  = correctOdds;
      const finalOdds  = p.odds;
      const finalStake = p.stake;
      if      (p.result === 'win')  p.pl = parseFloat(((finalOdds - 1) * finalStake).toFixed(2));
      else if (p.result === 'loss') p.pl = -finalStake;
      else                          p.pl = 0;
      changed = true;
    }
  });
  if (changed) saveHistorial(hist);
}

// Normaliza nombre de equipo para comparación fuzzy
function normTeam(s) {
  return (s||'').toLowerCase()
    .replace(/[\u2026\.]{1,3}$/, '')               // quita "…" o "..." al final (nombres truncados)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // quita acentos: é→e, ó→o, ú→u, ñ→n, etc.
    .replace(/[^a-z0-9]/g,'');
}

// ── Settled score guard ──
// Un partido se considera "resuelto" para auto-evaluar picks SOLO si:
//  1) la API lo marcó como flag === 'final', Y
//  2) pasaron al menos 2 horas desde el commenceTs (cubre 90' + descuento + posible alargue).
// Si el score no tiene commenceTs, se confía en el flag (no podemos enforzar el gate de tiempo).
const _SETTLE_BUFFER_MS = 2 * 60 * 60 * 1000;
function _settledScore(s) {
  if (!s || s.flag !== 'final') return false;
  if (!s.commenceTs) return true;
  return Date.now() >= s.commenceTs + _SETTLE_BUFFER_MS;
}

function teamsMatch(a, b) {
  const na = normTeam(a), nb = normTeam(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Coincidencia por prefijo (primeros 5 chars) — cubre "Arsenal" vs "Arsenal FC"
  const short = (x,y) => x.length >= 4 && y.includes(x.slice(0,5));
  if (short(na,nb) || short(nb,na)) return true;
  // Coincidencia por subcadena larga (>=5 chars): algún fragmento del nombre A aparece en B
  const wa = na.match(/.{5,}/g) || [];
  const wb = nb.match(/.{5,}/g) || [];
  if (wa.some(w => nb.includes(w)) || wb.some(w => na.includes(w))) return true;
  // Coincidencia por abreviatura canónica — cubre "Universidad Cató…" vs "U. Católica"
  // IMPORTANTE: llamar shortName con el nombre COMPLETO (incluyendo "…") para que las claves del mapa coincidan
  if (typeof shortName === 'function') {
    const sa = normTeam(shortName(a));
    const sb = normTeam(shortName(b));
    if (sa && sb && sa === sb) return true;
  }
  return false;
}

// Guarda predicciones nuevas (evita duplicados del mismo día)
function savePredictions(preds) {
  if (!preds || !preds.length) return;
  const hist = loadHistorial();
  const today = new Date().toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'});
  const todayKey = new Date().toISOString().slice(0,10);
  let added = 0;

  const _BLOCKED_SPORT_KEYS_SAVE = ['soccer_chile_campeonato', 'soccer_portugal_primeira_liga'];
  const _normBSave = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
  const _BLOCKED_TEAMS_SAVE = ['palestino','ucatolica','universidadcatolica','universidadcat'];
  // 🆕 (27-may-2026) Permitir equipos bloqueados cuando juegan en torneos Conmebol (ligas soportadas).
  //    Fix bug: Boca vs U. Católica (CHI) en Libertadores era filtrado por incluir 'ucatolica'.
  const _ALLOW_BLOCKED_IN_CUPS = ['soccer_conmebol_copa_libertadores', 'soccer_conmebol_copa_sudamericana', 'soccer_conmebol_copa_america'];
  preds.forEach(p => {
    // Excluir ligas bloqueadas (Portugal, Chile) por sportKey
    if (p._sportKey && _BLOCKED_SPORT_KEYS_SAVE.includes(p._sportKey)) return;
    // Excluir también por nombre de equipo (por si sportKey viene vacío) — EXCEPTO si está en copa soportada
    const _nh = _normBSave(p.home), _na = _normBSave(p.away);
    if (_BLOCKED_TEAMS_SAVE.some(t => _nh.includes(t) || _na.includes(t))) {
      if (!_ALLOW_BLOCKED_IN_CUPS.includes(p._sportKey)) return;
    }
    // Excluir partidos que comenzaron hace más de 20 horas (cubre jornada completa + margen)
    // Nunca excluir picks en vivo o recientes — todo pick mostrado al usuario DEBE quedar en historial
    if (p.commenceTs && p.commenceTs <= Date.now() - 20 * 3600 * 1000) return;
    // Excluir partidos MUY anticipados (>14 días vista). Evita publicar picks de Libertadores/
    // Sudamericana/temporadas futuras meses antes — el modelo no tiene info confiable a tanta distancia.
    // Hoy (jun-2026) bloquea fixtures de jul-ago. El Mundial 2026 está bajo bloqueo manual (abajo).
    if (p.commenceTs && p.commenceTs > Date.now() + 14 * 24 * 3600 * 1000) return;
    // 🚫 BLOQUEO MUNDIAL 2026 — sólo levantar manualmente cuando Mauro dé luz verde.
    // The Odds API usa varios keys para el WC; cubrimos todas las variantes conocidas.
    // Para activar: cambiar BLOCK_WC2026 a false (o sacar este bloque).
    const BLOCK_WC2026 = true;
    if (BLOCK_WC2026) {
      const _sk = (p._sportKey || '').toLowerCase();
      const WC_KEYS = ['soccer_world_cup', 'soccer_fifa_world_cup', 'soccer_fifa_world_cup_winner', 'soccer_world_cup_winner', 'soccer_fifa_world_cup_2026'];
      if (WC_KEYS.some(k => _sk === k || _sk.includes('world_cup'))) {
        console.log('[BLOCK_WC2026] Pick bloqueado:', p.home, 'vs', p.away, '(', _sk, ')');
        return;
      }
    }
    // Para auto-publicar finde: los viernes guardamos picks de sábado y domingo también
    // (ya cubierto por el check anterior — si commenceTs > Date.now() pasan)

    // Un solo pronóstico por partido (sin importar la fecha) — verificar por ID y por nombre de equipo
    const matchKey = `${normTeam(p.home)}_${normTeam(p.away)}`;
    const existIdx = hist.findIndex(h =>
      (h.id && h.id.startsWith(matchKey)) ||
      (teamsMatch(h.home, p.home) && teamsMatch(h.away, p.away))
    );
    if (existIdx !== -1) {
      // Si el pick ya existe pero su bvr subió (ej: weekend logic lo elevó a 6), actualizar
      const eh = hist[existIdx];
      const newBvr = p.bvr || 0;
      if (eh.result === 'pending') {
        let changed = false;
        // Actualizar commenceTs si el nuevo es más confiable (más reciente o el existente parece incorrecto)
        // Un commenceTs "incorrecto" es uno que ya pasó pero el resultado sigue PEND — probablemente se guardó mal
        if (p.commenceTs && p.commenceTs > Date.now() && (!eh.commenceTs || eh.commenceTs <= Date.now())) {
          eh.commenceTs = p.commenceTs;
          changed = true;
        }
        if (newBvr > (eh.bvr || 0)) {
          eh.bvr     = newBvr;
          eh.bvrText = p.bvrText || eh.bvrText;
          eh.conf    = p.conf    || eh.conf;
          eh.stake   = newBvr >= 6 ? 170 : newBvr === 5 ? 130 : newBvr === 4 ? 50 : 30;
          changed = true;
        }
        if (changed) added++;
      }
      return;
    }

    const id = `${matchKey}_${todayKey}`;

    // Cuota real del bookmaker — priorizar siempre la cuota real sobre la implícita
    let impliedOdds = 2.0;
    if      (p.rec === 'Gana Local'     && p._hO)  impliedOdds = parseFloat(parseFloat(p._hO).toFixed(2));
    else if (p.rec === 'Gana Visitante' && p._aO)  impliedOdds = parseFloat(parseFloat(p._aO).toFixed(2));
    else if (p.rec === 'Empate'         && p._dO)  impliedOdds = parseFloat(parseFloat(p._dO).toFixed(2));
    else if (p._bestOdds)                           impliedOdds = parseFloat(parseFloat(p._bestOdds).toFixed(2));
    // Fallback: cuota implícita de probabilidades si no hay cuota real
    else if (p.rec === 'Gana Local'     && p.probH > 0) impliedOdds = parseFloat((100/p.probH).toFixed(2));
    else if (p.rec === 'Gana Visitante' && p.probA > 0) impliedOdds = parseFloat((100/p.probA).toFixed(2));
    else if (p.rec === 'Empate'         && p.probD > 0) impliedOdds = parseFloat((100/p.probD).toFixed(2));

    // Stake según confianza/bvr: Máxima(6)=$170, Alta(5)=$130, Media-Alta(4)=$50, Media(3)=$30
    const _bvrS = p.bvr || (p.conf === 'high' ? 5 : 3);
    const _baseStake = _bvrS >= 6 ? 170 : _bvrS === 5 ? 130 : _bvrS === 4 ? 50 : 30;
    // 🆕 (23-jun-2026) Stake variable por cuota — penaliza cuotas bajas que históricamente dan ROI negativo.
    //   ≥1.80 → 100% del base    (premio cuota jugosa)
    //   1.65-1.80 → 85% del base  (cuota correcta)
    //   1.55-1.65 → 60% del base  (cuota límite)
    //   <1.55 → 40% del base      (riesgo alto, stake protectivo)
    const _odd = parseFloat(impliedOdds) || 1.6;
    const _oddMult = _odd >= 1.80 ? 1.0
                  : _odd >= 1.65 ? 0.85
                  : _odd >= 1.55 ? 0.60
                  : 0.40;
    const stake = Math.max(10, Math.round(_baseStake * _oddMult));

    // Normalizar nombres de equipos inconsistentes del Odds API
    const _normHome = (n, sk) => (n === 'Barcelona' && sk?.includes('conmebol')) ? 'Barcelona SC' : n;
    const _normAway = (n, sk) => (n === 'Barcelona' && sk?.includes('conmebol')) ? 'Barcelona SC' : n;
    hist.unshift({
      id, date: today, sport: p._sportKey?.includes('tennis') ? 'tenis' : (p.sport || 'futbol'),
      _sportKey: p._sportKey || null,   // guarda el API key real para resolver scores después
      home: _normHome(p.home, p._sportKey), away: _normAway(p.away, p._sportKey),
      league: p.league || null,
      rec: p.rec, odds: impliedOdds, stake,
      result: 'pending', pl: 0,
      conf: p.conf || null, bvr: p.bvr || 0, bvrText: p.bvrText || null,
      commenceTs: p.commenceTs || null,
      probH: p.probH || 0, probD: p.probD || 0, probA: p.probA || 0,
      _hO: p._hO || null, _aO: p._aO || null, _dO: p._dO || null,
      _bestOdds: p._bestOdds || impliedOdds || null,
    });
    added++;
  });

  if (added) saveHistorial(hist);
  return added;
}

// Resuelve predicciones pendientes contra partidos finalizados
function resolveCompletedGames(scores, skipRender) {
  // Si no se pasan scores, intentar leer del cache local
  if (!scores || !Array.isArray(scores)) {
    try {
      const cs = JSON.parse(localStorage.getItem('cache_scores') || '{}');
      scores = cs.data || cs;
    } catch(e) { scores = []; }
  }
  if (!Array.isArray(scores)) scores = [];
  const hist = loadHistorial();
  const pending = hist.filter(h => h.result === 'pending');
  if (!pending.length) return;

  let changed = false;
  const now = Date.now();

  const MATCH_WINDOW_MS = 5 * 24 * 3600 * 1000;
  scores.filter(_settledScore).forEach(s => {
    pending.forEach(p => {
      if (p.result !== 'pending') return; // ya fue resuelto en esta pasada
      if (!teamsMatch(s.home, p.home) || !teamsMatch(s.away, p.away)) return;
      // Verificar que el score sea del mismo partido (±5 días, cubre timestamps erróneos de Supabase)
      if (s.commenceTs && p.commenceTs && Math.abs(s.commenceTs - p.commenceTs) > MATCH_WINDOW_MS) return;

      const homeWin = s.scoreH > s.scoreA;
      const awayWin = s.scoreA > s.scoreH;
      const draw    = s.scoreH === s.scoreA;

      const totalGoals = s.scoreH + s.scoreA;
      const bttsMet    = s.scoreH > 0 && s.scoreA > 0;

      // Default: null = NO podemos resolver con esta info → dejar pending.
      // Void se reserva para casos genuinos (corner/handicap sin info — y solo si admin lo decide).
      let result = null;
      if      (p.rec === 'Gana Local')     result = homeWin    ? 'win' : 'loss';
      else if (p.rec === 'Gana Visitante') result = awayWin    ? 'win' : 'loss';
      else if (p.rec === 'Empate')         result = draw       ? 'win' : 'loss';
      else if (p.rec === 'Doble 1X')       result = (homeWin || draw) ? 'win' : 'loss';   // 🆕
      else if (p.rec === 'Doble X2')       result = (awayWin || draw) ? 'win' : 'loss';   // 🆕
      else if (p.rec === 'Ambos Marcan')   result = bttsMet    ? 'win' : 'loss';
      else if (p.rec === 'Más de 1.5')     result = totalGoals >= 2 ? 'win' : 'loss';
      else if (p.rec === 'Más de 2.5')     result = totalGoals >= 3 ? 'win' : 'loss';
      else if (p.rec === 'Más de 3.5')     result = totalGoals >= 4 ? 'win' : 'loss';
      else if (/^Más de (\d+\.?\d*)$/.test(p.rec)) {
        // Over basket (ej: "Más de 215.5")
        const line = parseFloat(p.rec.replace('Más de ',''));
        result = totalGoals > line ? 'win' : 'loss';
      }
      else if (/^Menos de (\d+\.?\d*)$/.test(p.rec)) {
        // Under basket (ej: "Menos de 215.5")
        const line = parseFloat(p.rec.replace('Menos de ',''));
        result = totalGoals < line ? 'win' : 'loss';
      }
      else if (/^Gana\s+/i.test(p.rec || '')) {
        // "Gana <nombre del equipo>" — matchear con home o away
        const teamPart = p.rec.replace(/^Gana\s+/i, '').trim();
        if (teamsMatch(teamPart, p.home)) result = homeWin ? 'win' : 'loss';
        else if (teamsMatch(teamPart, p.away)) result = awayWin ? 'win' : 'loss';
      }
      else if (/^Apuesta a [+\-]?\d/.test(p.rec || '') || /(corner|hándicap|handicap)/i.test(p.rec || '')) {
        // Corner / Handicap: no resolvibles automáticamente vs marcador → void
        result = 'void';
      }

      // Escribir si tenemos win/loss/void definitivo. Sin match → queda pending.
      if (result === 'win' || result === 'loss' || result === 'void') {
        p.result = result;
        p.finalScore = `${s.scoreH}-${s.scoreA}`;
        p.pl = result === 'win' ? parseFloat(((p.odds - 1) * p.stake).toFixed(2))
             : result === 'loss' ? -p.stake : 0;
        p.resolvedAt = p.resolvedAt || Date.now();
        changed = true;
      }
    });
  });

  // (Eliminado el fallback "muy viejos → void". Mauro: voids son MUY raros (0/400+), no auto-asignar.)

  if (changed) {
    saveHistorial(hist);
    if (!skipRender) renderHistorial(histFilter);
  }
}

// Mapeo sport simple → API sport keys a consultar (basket removido)
const SPORT_KEY_MAP = {
  futbol:  [
    'soccer_argentina_primera_division', 'soccer_argentina_primera_nacional',
    'soccer_brazil_campeonato',
    'soccer_conmebol_copa_libertadores', 'soccer_conmebol_copa_sudamericana',
    'soccer_england_premier_league', 'soccer_epl',
    'soccer_spain_la_liga', 'soccer_germany_bundesliga',
    'soccer_italy_serie_a', 'soccer_france_ligue_one',
    'soccer_uefa_champs_league', 'soccer_uefa_europa_league',
    'soccer_uefa_europa_conference_league',
    'soccer_netherlands_eredivisie',
    'soccer_scotland_premiership', 'soccer_turkey_super_league',
    'soccer_mexico_ligamx', 'soccer_usa_mls',
    'soccer_uruguay_primera_division',
    'soccer_saudi_professional_league', 'soccer_japan_j_league'
  ],
  tenis:   ['tennis_atp_french_open', 'tennis_wta']
};

// Carga scores históricos para resolver predicciones y apuestas  pendientes
async function loadHistoricalScores() {
  // Guard: evitar ejecuciones concurrentes (puede llamarse desde renderHistorial en loop)
  if (window._loadHistScoresRunning) return;
  window._loadHistScoresRunning = true;
  const hist = loadHistorial();
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 3600 * 1000;
  // Resolver tanto 'pending' como 'void' recientes (< 7 días)
  const needsResolve = hist.filter(h => {
    if (h.result === 'win' || h.result === 'loss') return false;
    const ts = h.commenceTs || (h.id && (() => { const m = h.id.match(/(\d{4}-\d{2}-\d{2})T/); return m ? new Date(m[1]).getTime() : null; })());
    if (ts && (now - ts) > sevenDaysMs) return false;
    return true;
  });

  // También verificar  picks no evaluados
  const pendingGPicks = (typeof acGetPicks === 'function' ? acGetPicks() : []).filter(p => !p.evaluated);

  // Entradas ya resueltas (win/loss) que podrían necesitar corrección de score (últimas 72h)
  const CORRECTION_WIN_MS = 72 * 3600 * 1000;
  const needsCorrection = hist.filter(h => {
    if (h.result !== 'win' && h.result !== 'loss') return false;
    let ts = h.commenceTs;
    if (!ts && h.date) {
      const parts = h.date.split('/');
      if (parts.length >= 2) ts = new Date(new Date().getFullYear(), parseInt(parts[1]) - 1, parseInt(parts[0])).getTime();
    }
    return ts && (now - ts) < CORRECTION_WIN_MS;
  });

  // Salir sólo si no hay nada pendiente NI entradas recientes a corregir
  if (!needsResolve.length && !pendingGPicks.length && !needsCorrection.length) return;

  // Collect unique API sport keys needed
  const needed = new Set();
  needsResolve.forEach(h => {
    if (h._sportKey) {
      needed.add(h._sportKey);
    } else {
      // Inferir desde campo sport simplificado
      const keys = SPORT_KEY_MAP[h.sport] || SPORT_KEY_MAP.futbol;
      keys.forEach(k => needed.add(k));
    }
  });
  // También incluir ligas de entradas recientes resueltas (por si el score fue erróneo)
  needsCorrection.forEach(h => {
    if (h._sportKey) needed.add(h._sportKey);
    else { (SPORT_KEY_MAP[h.sport] || SPORT_KEY_MAP.futbol).forEach(k => needed.add(k)); }
  });

  // Para  picks pendientes, siempre incluir todas las ligas de fútbol
  if (pendingGPicks.length) {
    SPORT_KEY_MAP.futbol.forEach(k => needed.add(k));
  }

  // Calcular daysFrom dinámicamente: el más antiguo de todos los picks pendientes
  //  picks usan cap de 21 días (pueden quedar sin resolver si el usuario no entra varios días)
  // Historial global cap = 21 días (extendido — antes 7d dejaba huérfanos picks de Conmebol que tardan en resolverse)
  let daysFrom = 3;
  const histPendingTs  = needsResolve.map(h => h.commenceTs || null).filter(Boolean);
  const gPickPendingTs = pendingGPicks.map(p => p.ts || null).filter(Boolean);
  if (histPendingTs.length) {
    const oldestMs   = now - Math.min(...histPendingTs);
    const daysElapsed = Math.ceil(oldestMs / (24 * 3600 * 1000));
    daysFrom = Math.min(21, Math.max(3, daysElapsed + 1));
  }
  if (gPickPendingTs.length) {
    const oldestMs    = now - Math.min(...gPickPendingTs);
    const daysElapsed = Math.ceil(oldestMs / (24 * 3600 * 1000));
    //  picks: hasta 21 días atrás para no perder picks de usuarios inactivos
    const gDays = Math.min(21, Math.max(3, daysElapsed + 1));
    daysFrom = Math.max(daysFrom, gDays);
  }

  // ── Mapa sport key → ESPN league ID ──────────────────────────────────────────
  // EXPANDIDO: ahora cubre ligas tier 3-5 que antes quedaban sin resolver.
  const SPORT_TO_ESPN = {
    // ── Tier 1 ──
    soccer_argentina_primera_division:   'arg.1',
    soccer_argentina_primera_nacional:   'arg.nacional',
    soccer_epl:                          'eng.1',
    soccer_england_premier_league:       'eng.1',
    soccer_english_premier_league:       'eng.1',
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
    // ── Tier 2 ──
    soccer_mexico_ligamx:                'mex.1',
    soccer_netherlands_eredivisie:       'ned.1',
    soccer_portugal_primeira_liga:       'por.1',
    soccer_turkey_super_league:          'tur.1',
    soccer_england_championship:         'eng.2',
    soccer_england_efl_champ:            'eng.2',
    // ── Tier 3 / 4 / 5 (segundas y europeas menores) ──
    soccer_germany_bundesliga2:          'ger.2',
    soccer_italy_serie_b:                'ita.2',
    soccer_france_ligue_two:             'fra.2',
    soccer_spain_segunda_division:       'esp.2',
    soccer_belgium_first_div_a:          'bel.1',
    soccer_belgium_first_div:            'bel.1',
    soccer_scotland_premiership:         'sco.1',
    soccer_austria_football_bundesliga:  'aut.1',
    soccer_austria_bundesliga:           'aut.1',
    soccer_switzerland_superleague:      'sui.1',
    soccer_denmark_superliga:            'den.1',
    soccer_sweden_allsvenskan:           'swe.1',
    soccer_norway_eliteserien:           'nor.1',
    soccer_poland_ekstraklasa:           'pol.1',
    soccer_czech_republic_first_league:  'cze.1',
    soccer_czech_liga:                   'cze.1',
    soccer_romania_liga1:                'rou.1',
    soccer_greece_super_league:          'gre.1',
    soccer_russia_premier_league:        'rus.1',
    soccer_south_korea_kleague1:         'kor.1',
    soccer_japan_j_league:               'jpn.1',
    soccer_australia_aleague:            'aus.1',
    soccer_australia_a_league:           'aus.1',
    soccer_saudi_professional_league:    'sau.1',
    soccer_saudi_premier_league:         'sau.1',
    soccer_usa_mls:                      'usa.1',
    // ── Sudamérica ──
    soccer_chile_campeonato:             'chi.1',
    soccer_colombia_primera_a:           'col.1',
    soccer_uruguay_primera_division:     'uru.1',
    soccer_paraguay_primera_division:    'par.1',
    soccer_peru_primera_division:        'per.1',
    soccer_ecuador_liga_pro:             'ecu.1',
    soccer_ecuador_primera_a:            'ecu.1',
    soccer_venezuela_primera_division:   'ven.1',
    soccer_venezuela_primera:            'ven.1',
    soccer_bolivia_primera_division:     'bol.1',
  };

  // Parsear respuesta ESPN → formato interno
  const parseESPN = (events) => (events || [])
    .filter(e => e.status?.type?.completed)
    .map(e => {
      const comp  = e.competitions?.[0] || {};
      const home  = comp.competitors?.find(t => t.homeAway === 'home') || {};
      const away  = comp.competitors?.find(t => t.homeAway === 'away') || {};
      const hName = home.team?.displayName || home.team?.name || '';
      const aName = away.team?.displayName || away.team?.name || '';
      return {
        home:       shortName(hName),
        away:       shortName(aName),
        homeRaw:    hName,
        awayRaw:    aName,
        scoreH:     parseInt(home.score) || 0,
        scoreA:     parseInt(away.score) || 0,
        flag:       'final',
        commenceTs: e.date ? new Date(e.date).getTime() : null,
        _fromEspn:  true,
      };
    });

  // Generar lista de fechas YYYYMMDD desde hoy hacia atrás (daysFrom días)
  const datesToFetch = [];
  for (let i = 0; i <= daysFrom; i++) {
    const d = new Date(now - i * 86400000);
    datesToFetch.push(d.toISOString().slice(0,10).replace(/-/g,''));
  }

  // Ligas ESPN únicas a consultar (solo las que tienen pending picks)
  const espnLeagues = new Set();
  [...needed].forEach(sk => {
    const eid = SPORT_TO_ESPN[sk];
    if (eid) espnLeagues.add(eid);
  });
  // Siempre incluir Liga Profesional argentina (mayor volumen de picks)
  espnLeagues.add('arg.1');

  // 1) Resolver contra scoresData en memoria (sincrónico, sin costo)
  if (scoresData && scoresData.length) {
    resolveCompletedGames(scoresData, true);
    if (pendingGPicks.length) acEvaluatePicks([]);
  }

  try {
    // 2) ESPN API — fetch por (liga × fecha) en paralelo
    const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
    const fetchTargets = [];
    espnLeagues.forEach(league => {
      datesToFetch.forEach(dateStr => {
        fetchTargets.push(
          fetch(`${ESPN_BASE}/${league}/scoreboard?dates=${dateStr}`)
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        );
      });
    });

    const results = await Promise.allSettled(fetchTargets);

    const allScores = [];
    const allScheduled = []; // matches NO completados (futuros) — para corregir commenceTs
    const seen = new Set();
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value) {
        parseESPN(r.value.events || []).forEach(s => {
          const key = `${normTeam(s.home)}_${normTeam(s.away)}`;
          if (!seen.has(key)) { seen.add(key); allScores.push(s); }
        });
        // Capturar también partidos AÚN no completados (status !== completed) → para reparar TS
        (r.value.events || []).forEach(e => {
          if (e.status?.type?.completed) return;
          const comp = e.competitions?.[0] || {};
          const home = comp.competitors?.find(t => t.homeAway === 'home') || {};
          const away = comp.competitors?.find(t => t.homeAway === 'away') || {};
          const hN = home.team?.displayName || home.team?.name || '';
          const aN = away.team?.displayName || away.team?.name || '';
          if (!hN || !aN || !e.date) return;
          allScheduled.push({ home: shortName(hN), away: shortName(aN), homeRaw: hN, awayRaw: aN, ts: new Date(e.date).getTime() });
        });
      }
    });

    // 🔧 Reparar commenceTs de picks pendientes que tienen ts incorrecto.
    // Caso típico: pick guardado con TS un día corrido (24h adelantado). ESPN tiene la fecha real.
    if (allScheduled.length) {
      try {
        const _hist = loadHistorial();
        let tsFixed = 0;
        _hist.forEach(p => {
          if (p.result === 'win' || p.result === 'loss' || p.result === 'void') return;
          if (!p.commenceTs) return;
          const m = allScheduled.find(s =>
            (teamsMatch(s.home, p.home) || teamsMatch(s.homeRaw, p.home)) &&
            (teamsMatch(s.away, p.away) || teamsMatch(s.awayRaw, p.away))
          );
          if (!m) return;
          // Solo corregir si la diferencia es > 1h (no por pequeñas variaciones)
          if (Math.abs(m.ts - p.commenceTs) > 60 * 60 * 1000) {
            p.commenceTs = m.ts;
            tsFixed++;
          }
        });
        if (tsFixed) {
          console.log(`[ESPN repair-TS] ${tsFixed} picks pendientes con commenceTs corregido vs ESPN`);
          saveHistorial(_hist);
        }
      } catch(e) { console.warn('[ESPN repair-TS]', e.message); }
    }

    // ── Fallback automático: TheSportsDB para picks que ESPN no resolvió ─────
    // Estrategia: para cada pending pick que sigue sin score después de ESPN,
    // hacemos un searchevents.php targeted (1 request por match). Es más eficiente
    // que pegar a una liga entera, y devuelve el match exacto incluso si TSDB tiene
    // datos limitados de la liga.
    // Ligas conocidas como no-ESPN (siempre intentar TSDB):
    const TSDB_NEEDED_SPORT_KEYS = new Set([
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

    // Buscar picks pendientes que TODAVÍA siguen pending después del intento ESPN
    const _histAfterEspn = loadHistorial();
    const _stillPending = _histAfterEspn.filter(h => {
      if (h.result !== 'pending') return false;
      if (!h.commenceTs || h.commenceTs > Date.now()) return false; // futuro
      if ((Date.now() - h.commenceTs) > 21 * 24 * 3600 * 1000) return false; // muy viejo
      // Solo si es liga que sabemos que ESPN no cubre, O si ESPN no devolvió nada
      const sk = h._sportKey || '';
      const espnSupported = sk && SPORT_TO_ESPN[sk];
      const espnGotScores = allScores.some(s => s._fromEspn);
      return TSDB_NEEDED_SPORT_KEYS.has(sk) || !espnSupported || !espnGotScores;
    });

    if (_stillPending.length) {
      try {
        const TSDB_BASE = 'https://www.thesportsdb.com/api/v1/json/3';
        // Cache de búsquedas para no repetir el mismo match en sesiones cortas
        window._tsdbSearchCache = window._tsdbSearchCache || {};
        const _tsdbCache = window._tsdbSearchCache;

        // Normalizador para URL: reemplaza espacios con _, quita diacríticos
        const _tsdbSlug = s => (s || '')
          .normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/[^a-zA-Z0-9\s]/g, '')
          .trim().replace(/\s+/g, '_');

        const tsdbSearchTargets = _stillPending.slice(0, 12).map(p => {
          // Probar dos variantes: home_vs_away y homeRaw_vs_awayRaw (más conservador)
          const hSlug = _tsdbSlug(p.home);
          const aSlug = _tsdbSlug(p.away);
          if (!hSlug || !aSlug) return null;
          const cacheKey = `${hSlug}_vs_${aSlug}`;
          if (cacheKey in _tsdbCache) return Promise.resolve({ cached: true, data: _tsdbCache[cacheKey], pick: p });
          return fetch(`${TSDB_BASE}/searchevents.php?e=${cacheKey}`)
            .then(r => r.ok ? r.json() : null)
            .then(d => { _tsdbCache[cacheKey] = d; return { cached: false, data: d, pick: p }; })
            .catch(() => null);
        }).filter(Boolean);

        const tsdbResults = await Promise.allSettled(tsdbSearchTargets);
        let tsdbAdded = 0;
        tsdbResults.forEach(r => {
          if (r.status !== 'fulfilled' || !r.value) return;
          const events = r.value.data?.event || r.value.data?.events || [];
          const pick = r.value.pick;
          events.forEach(e => {
            if (e.intHomeScore == null || e.intAwayScore == null) return;
            if (e.intHomeScore === '' || e.intAwayScore === '') return;
            const sH = parseInt(e.intHomeScore), sA = parseInt(e.intAwayScore);
            if (!Number.isFinite(sH) || !Number.isFinite(sA)) return;
            const hN = e.strHomeTeam || '';
            const aN = e.strAwayTeam || '';
            if (!hN || !aN) return;
            const ts = e.strTimestamp
              ? new Date(e.strTimestamp + (e.strTimestamp.endsWith('Z') ? '' : 'Z')).getTime()
              : (e.dateEvent ? new Date(e.dateEvent + 'T18:00:00Z').getTime() : null);
            if (!ts || ts > Date.now()) return;
            // Verificar que el TS está cerca del pick (±5 días)
            if (pick.commenceTs && Math.abs(pick.commenceTs - ts) > 5 * 24 * 3600 * 1000) return;
            allScores.push({
              home:       shortName(hN),
              away:       shortName(aN),
              homeRaw:    hN,
              awayRaw:    aN,
              scoreH:     sH,
              scoreA:     sA,
              flag:       'final',
              commenceTs: ts,
              _fromTsdb:  true,
            });
            tsdbAdded++;
          });
        });
        if (tsdbAdded) console.log(`[TSDB fallback] +${tsdbAdded} scores via searchevents (${_stillPending.length} picks buscados)`);
      } catch(e) { console.warn('[TSDB fallback]', e.message); }
    }

    if (allScores.length) {
      const espnCount = allScores.filter(s => !s._fromTsdb).length;
      const tsdbCount = allScores.filter(s =>  s._fromTsdb).length;
      console.log(`[scores] ${allScores.length} total — ESPN:${espnCount} + TSDB:${tsdbCount} (${espnLeagues.size} ligas ESPN × ${datesToFetch.length} días)`);
      resolveAllGames(allScores);
      acEvaluatePicks(allScores);
    } else {
      console.warn('[scores] Sin resultados. Ligas ESPN:', [...espnLeagues], 'Fechas:', datesToFetch);
    }
  } catch(e) { console.warn('[historicalScores]', e); }
  finally {
    // Liberar guard con delay para evitar spam de requests (mín 30s entre llamadas)
    setTimeout(() => { window._loadHistScoresRunning = false; }, 30000);
  }
}

// Como resolveCompletedGames pero también re-resuelve entradas void recientes
function resolveAllGames(scores) {
  const hist = loadHistorial();
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 3600 * 1000;
  // ±5 días de tolerancia: cubre errores de entrada en Supabase donde el commenceTs
  // puede estar hasta ~50h desplazado respecto al partido real
  const MATCH_WINDOW_MS = 5 * 24 * 3600 * 1000;
  const CORRECTION_WINDOW = 72 * 3600 * 1000; // 72h para corregir scores incorrectos

  // Reparar commenceTs corruptos (futuros >12h cuando el partido ya fue jugado)
  // Esto pasa cuando los picks de Supabase se guardan con timestamps erróneos
  hist.forEach(p => {
    if (!p.commenceTs || !p.date || p.result === 'win' || p.result === 'loss') return;
    if (p.commenceTs <= now) return; // ya está en el pasado, no tocar
    // commenceTs está en el futuro pero el partido ya debería haber jugado según p.date
    const parts = p.date.split('/');
    if (parts.length < 2) return;
    const matchDay = new Date(now);
    matchDay.setDate(parseInt(parts[0]));
    matchDay.setMonth(parseInt(parts[1]) - 1);
    matchDay.setHours(23, 59, 59, 0);
    if (matchDay.getTime() < now) {
      // El día del partido ya pasó — corregir el commenceTs al final de ese día
      p.commenceTs = matchDay.getTime();
    }
  });

  let changed = false;
  scores.filter(_settledScore).forEach(s => {
    hist.forEach(p => {
      // 1) Verificar equipos primero (evita falsos positivos)
      if (!teamsMatch(s.home, p.home) || !teamsMatch(s.away, p.away)) return;
      // 2) Verificar que sea el mismo partido por fecha (±5 días, cubre timestamps desplazados)
      if (s.commenceTs && p.commenceTs && Math.abs(s.commenceTs - p.commenceTs) > MATCH_WINDOW_MS) return;
      // 3) Para entradas ya resueltas: solo corregir si el score cambió y fue hace <72h
      if (p.result === 'win' || p.result === 'loss') {
        const newScore   = `${s.scoreH}-${s.scoreA}`;
        // Intentar obtener timestamp de commenceTs o de p.date como fallback
        let pTs = p.commenceTs;
        if (!pTs && p.date) {
          const parts = p.date.split('/');
          if (parts.length >= 2) {
            const yr = new Date().getFullYear();
            pTs = new Date(yr, parseInt(parts[1]) - 1, parseInt(parts[0])).getTime();
          }
        }
        const isRecent   = pTs && (now - pTs) < CORRECTION_WINDOW;
        const scoreWrong = p.finalScore && p.finalScore !== newScore;
        if (!(isRecent && scoreWrong)) return; // ya definitivo y sin corrección → skip
        console.log(`[resolveAllGames] Corrigiendo score: ${p.home} vs ${p.away} ${p.finalScore} → ${newScore}`);
      }
      const homeWin    = s.scoreH > s.scoreA;
      const awayWin    = s.scoreA > s.scoreH;
      const draw       = s.scoreH === s.scoreA;
      const totalGoals = s.scoreH + s.scoreA;
      const bttsMet    = s.scoreH > 0 && s.scoreA > 0;
      // Default: null = NO podemos resolver con esta info → dejar pending.
      let result = null;
      if      (p.rec === 'Gana Local')     result = homeWin       ? 'win' : 'loss';
      else if (p.rec === 'Gana Visitante') result = awayWin       ? 'win' : 'loss';
      else if (p.rec === 'Empate')         result = draw          ? 'win' : 'loss';
      else if (p.rec === 'Doble 1X')       result = (homeWin || draw) ? 'win' : 'loss';   // 🆕
      else if (p.rec === 'Doble X2')       result = (awayWin || draw) ? 'win' : 'loss';   // 🆕
      else if (p.rec === 'Ambos Marcan')   result = bttsMet       ? 'win' : 'loss';
      else if (p.rec === 'Más de 1.5')     result = totalGoals >= 2 ? 'win' : 'loss';
      else if (p.rec === 'Más de 2.5')     result = totalGoals >= 3 ? 'win' : 'loss';
      else if (p.rec === 'Más de 3.5')     result = totalGoals >= 4 ? 'win' : 'loss';
      else if (/^Más de (\d+\.?\d*)$/.test(p.rec)) {
        const line = parseFloat(p.rec.replace('Más de ',''));
        result = totalGoals > line ? 'win' : 'loss';
      }
      else if (/^Menos de (\d+\.?\d*)$/.test(p.rec)) {
        const line = parseFloat(p.rec.replace('Menos de ',''));
        result = totalGoals < line ? 'win' : 'loss';
      }
      else if (/^Gana\s+/i.test(p.rec || '')) {
        // "Gana <nombre del equipo>" — matchear con home o away
        const teamPart = p.rec.replace(/^Gana\s+/i, '').trim();
        if (teamsMatch(teamPart, p.home)) result = homeWin ? 'win' : 'loss';
        else if (teamsMatch(teamPart, p.away)) result = awayWin ? 'win' : 'loss';
      }
      else if (/^Apuesta a [+\-]?\d/.test(p.rec || '') || /(corner|hándicap|handicap)/i.test(p.rec || '')) {
        // Corner / Handicap: no resolvibles automáticamente vs marcador → void
        result = 'void';
      }
      // Escribir si tenemos win/loss/void definitivo. Sin match → queda pending.
      if (result === 'win' || result === 'loss' || result === 'void') {
        p.result = result;
        p.finalScore = `${s.scoreH}-${s.scoreA}`;
        p.pl = result === 'win' ? parseFloat(((p.odds - 1) * p.stake).toFixed(2))
             : result === 'loss' ? -p.stake : 0;
        p.resolvedAt = p.resolvedAt || Date.now();
        changed = true;
      }
    });
  });
  if (changed) { saveHistorial(hist); renderHistorial(histFilter); }
}

function calcRacha(data) {
  const completed = data.filter(h => h.result==='win'||h.result==='loss');
  if (!completed.length) return {val:0,str:'—'};
  let count=0, last=completed[0].result;
  for (const h of completed) { if(h.result===last) count++; else break; }
  return last==='win' ? {val:count,str:`🔥 ${count}V seguidas`} : {val:-count,str:`❄️ ${count}D seguidas`};
}

// ── Picks Copa Libertadores/Sudamericana 8-abr-2026 ──────────────────────────
// Estos picks no se guardaron via savePredictions (partidos nocturnos sin historial API).
// Se inyectan directamente al historial local si no existen.
// _injectCopaAbr8Historial eliminado — los picks del 8-abr deben cargarse de Supabase

// Clasifica el mercado de un pick para el filtro del historial:
// "Gana <equipo>" se resuelve a "Gana Local" / "Gana Visitante" segun si ese
// equipo jugo de local o visitante en ese partido.
function histMarketKey(h) {
  const rec = (h.rec || '').trim();
  if (!rec) return rec;
  const m = rec.match(/^Gana\s+(.+)$/i);
  if (!m) return rec;
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const t = norm(m[1]);
  if (t === 'local') return 'Gana Local';
  if (t === 'visitante') return 'Gana Visitante';
  if (h.home && norm(h.home) === t) return 'Gana Local';
  if (h.away && norm(h.away) === t) return 'Gana Visitante';
  return rec;
}

function renderHistorial(filter) {
  // 🛡️ Aplicar override de resultados conocidos WC2026 a window._sbHist antes del render
  if (typeof resolveWcLocal === 'function' && Array.isArray(window._sbHist)) {
    window._sbHist = window._sbHist.map(p => resolveWcLocal(p));
  }

  // Guard: si los elementos del DOM aún no existen, reprogramar
  const _summaryEl = document.getElementById('histSummary');
  const _tableEl   = document.getElementById('histTableBody');
  if (!_summaryEl || !_tableEl) {
    setTimeout(() => renderHistorial(filter), 150);
    return;
  }
  // ── AUTO-TRIGGER: si aún no cargó el global y no está cargando, dispararlo ──
  // Previene el bug donde la tabla queda en skeleton para siempre porque
  // sbLoadHistorial nunca se invocó al inicio (ej. session restaurada sin
  // pasar por handleAuthSession).
  if (!_histLoadedOnce && !_histLoading && typeof sbLoadHistorial === 'function') {
    _histLoading = true;  // Evita loops por re-render en cadena
    sbLoadHistorial().catch(e => console.warn('[renderHistorial] auto-trigger load failed:', e.message));
    // Watchdog: si en 15s sigue sin cargar (ej. red colgada en 1ra visita),
    // salir del skeleton infinito y mostrar reintentar / datos locales.
    setTimeout(() => {
      if (!_histLoadedOnce) {
        _histLoading = false;
        _histLoadedOnce = true;
        _histLoadFailed = loadHistorial().length === 0;
        renderHistorial(filter);
      }
    }, 15000);
  }
  try {
  const _rawCount = loadHistorial().length;
  console.log('[renderHistorial] storage:', _rawCount, 'picks | filtros: fecha='+histDateFilter+' conf='+histConfFilter+' liga='+histLeagueFilter+' mercado='+histMercadoFilter+' deporte='+histFilter);
  migrateHistStakes();          // corrige stakes/P&L de entradas antiguas
  // Resolver con scores en memoria (sincrónico, sin loop)
  resolveCompletedGames(scoresData||[], true);
  // Buscar scores históricos del servidor para pendientes sin resolver (rate-limited: máx 1 request cada 30s)
  if (!window._loadHistScoresRunning) loadHistoricalScores();
  // ── Ligas bloqueadas: remover del storage y no mostrar ──
  const BLOCKED_SPORT_KEYS = ['soccer_chile_campeonato', 'soccer_portugal_primeira_liga',
    'soccer_albania_superliga', 'soccer_faroe_islands', 'soccer_andorra_primera',
    'soccer_san_marino_superleague', 'soccer_gibraltar_ifl', 'soccer_liechtenstein',
    'soccer_malta_premier_league', 'soccer_kosovo_superleague'];
  // Equipos bloqueados por nombre (por si fueron guardados sin _sportKey correcto)
  const _normB = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
  const BLOCKED_TEAMS = ['palestino','ucatolica','universidadcatolica','universidadcat'];
  // 🆕 (27-may-2026) Permitir equipos bloqueados cuando juegan en torneos Conmebol soportados.
  const ALLOW_BLOCKED_IN_CUPS = ['soccer_conmebol_copa_libertadores', 'soccer_conmebol_copa_sudamericana', 'soccer_conmebol_copa_america'];
  const allRaw = loadHistorial();
  const allClean = allRaw.filter(h => {
    if (BLOCKED_SPORT_KEYS.includes(h._sportKey)) return false;
    // Bloquear por sport_key que contenga palabras de ligas no soportadas
    if (h._sportKey && (h._sportKey.includes('albania') || h._sportKey.includes('faroe') || h._sportKey.includes('gibraltar') || h._sportKey.includes('san_marino') || h._sportKey.includes('liechtenstein') || h._sportKey.includes('malta') || h._sportKey.includes('kosovo'))) return false;
    const nh = _normB(h.home), na = _normB(h.away);
    // Bloqueo por nombre — EXCEPTO si está en copa Conmebol (donde estos equipos son válidos)
    if (BLOCKED_TEAMS.some(t => nh.includes(t) || na.includes(t))) {
      if (!ALLOW_BLOCKED_IN_CUPS.includes(h._sportKey)) return false;
    }
    // Primeira Liga / Chile / Albania: filtrar también por nombre de liga
    if ((h.league||'').toLowerCase().includes('primeira liga')) return false;
    if ((h.league||'').toLowerCase().includes('chile')) return false;
    if ((h.league||'').toLowerCase().includes('albania') || (h.league||'').includes('🇦🇱')) return false;
    return true;
  });
  if (allClean.length < allRaw.length) saveHistorial(allClean); // limpia storage silenciosamente
  const all = allClean;
  // ── Deduplicar: mismo partido (home+away fuzzy) en el mismo día ──
  const dedupedAll = [];
  for (const h of all) {
    const alreadyIn = dedupedAll.some(x =>
      teamsMatch(x.home, h.home) && teamsMatch(x.away, h.away) &&
      (x.commenceTs && h.commenceTs
        ? Math.abs(x.commenceTs - h.commenceTs) < 3 * 3600000  // mismo partido ±3h
        : x.date === h.date)
    );
    if (!alreadyIn) dedupedAll.push(h);
  }
  // Si había duplicados, sanear el storage silenciosamente
  if (dedupedAll.length < all.length) saveHistorial(dedupedAll);
  // ── 2da pasada anti-duplicados: mismo enfrentamiento (home+away) registrado
  //    2 veces con timestamps distintos (la ventana ±3h de arriba no los une).
  //    Si uno está RESUELTO y el otro PENDING dentro de ±3 días, descartar el
  //    PENDING — es el mismo partido mal duplicado (id/fecha distinta).
  //    Ventana corta: NO borra ida/vuelta de copas (legs ≥6-7 días aparte).
  const _ddNorm = s => (s||'').toString().toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
  const _ddResolved = h => h && (h.result === 'win' || h.result === 'loss' || h.result === 'void');
  const _ddResolvedTs = {};
  dedupedAll.forEach(h => {
    if (_ddResolved(h) && h.commenceTs) {
      const mk = _ddNorm(h.home) + '|' + _ddNorm(h.away);
      (_ddResolvedTs[mk] = _ddResolvedTs[mk] || []).push(h.commenceTs);
    }
  });
  const _DD_WIN = 3 * 24 * 3600 * 1000;
  const dedupedAll2 = dedupedAll.filter(h => {
    if (_ddResolved(h)) return true;       // resuelto: siempre queda
    if (!h.commenceTs) return true;
    const ts = _ddResolvedTs[_ddNorm(h.home) + '|' + _ddNorm(h.away)];
    if (!ts) return true;
    return !ts.some(t => Math.abs(t - h.commenceTs) < _DD_WIN);
  });
  if (dedupedAll2.length < dedupedAll.length) saveHistorial(dedupedAll2);
  // Solo aceptar filtros de sport conocidos; cualquier otro valor (incl. legacy 'soccer') = mostrar todo.
  const _validSports = new Set(['futbol', 'tenis']);
  const _useFilter = _validSports.has(filter) ? filter : 'all';
  let data = _useFilter === 'all' ? dedupedAll2 : dedupedAll2.filter(h => (h.sport || 'futbol') === _useFilter);

  // ── Ordenar para UX correcta de página Resultados (Mauro 23-jun-2026): ──
  //   1. RESUELTOS RECIENTES arriba (últimos 14 días) — lo que la gente entra a ver
  //   2. PENDIENTES PRÓXIMOS al medio (próximos 14 días) — picks por jugarse
  //   3. RESUELTOS VIEJOS después
  //   4. FUTURES LEJANOS al fondo (>14 días, ej. 'México gana Grupo A')
  data.sort((a, b) => {
    const NOW = Date.now();
    const D14 = 14 * 24 * 60 * 60 * 1000;
    const tsA = a.commenceTs || 0;
    const tsB = b.commenceTs || 0;
    const aPend = a.result === 'pending';
    const bPend = b.result === 'pending';
    // Categorías (menor = más arriba) — Mauro 25-jun:
    //   0 → PENDIENTES PRÓXIMOS (los que van a jugar pronto) — top
    //   1 → RESUELTOS RECIENTES (últimos 14 días)
    //   2 → RESUELTOS VIEJOS
    //   3 → PENDIENTES PASADOS sin resolver (huérfanos visibles para resolver)
    //   4 → FUTURES LEJANOS (>14 días)
    const cat = (pend, ts) => {
      if (pend) {
        if (ts < NOW) return 3;                       // pendiente pasado huérfano → cerca del fondo
        return (ts - NOW) <= D14 ? 0 : 4;             // próximo=0 (arriba), future lejano=4 (fondo)
      }
      return (NOW - ts) <= D14 ? 1 : 2;               // resuelto reciente=1, resuelto viejo=2
    };
    const ca = cat(aPend, tsA);
    const cb = cat(bPend, tsB);
    if (ca !== cb) return ca - cb;
    // Dentro de cada categoría:
    if (ca === 0 || ca === 4) return tsA - tsB;       // pendientes próximos / futures: más cercano arriba
    if (ca === 3) return tsB - tsA;                   // pendientes huérfanos: más reciente primero
    return tsB - tsA;                                  // resueltos: más reciente arriba
  });

  // Filtro por fecha
  if (histDateFilter !== 'all') {
    const now = new Date();
    const todayStr = now.toLocaleDateString('es-AR', {day:'2-digit', month:'2-digit'});
    const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(now.getDate() - 7);

    const getGameDate = (h) => {
      if (h.commenceTs) return new Date(h.commenceTs);
      if (!h.date) return null;
      const parts = h.date.split('/');
      if (parts.length < 2) return null;
      const d = new Date(now.getFullYear(), parseInt(parts[1])-1, parseInt(parts[0]));
      if (d > now) d.setFullYear(now.getFullYear()-1);
      return d;
    };

    data = data.filter(h => {
      const gd = getGameDate(h);
      if (histDateFilter === 'today') {
        const gStr = gd ? gd.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'}) : h.date;
        return gStr === todayStr;
      }
      if (histDateFilter === 'week')  return gd ? gd >= sevenDaysAgo : false;
      if (histDateFilter === 'finde') return gd ? (gd.getDay()===6 || gd.getDay()===0) : false;
      return true;
    });
  }

  // Filtro por confianza (deriva de stake/bvr si no hay campo conf)
  if (histConfFilter !== 'all') {
    data = data.filter(h => {
      const bvr = h.bvr || (h.stake >= 150 ? 6 : h.stake >= 130 ? 5 : h.stake >= 50 ? 4 : 3);
      if (histConfFilter === 'max')  return bvr >= 6;
      const c = h.conf || (h.stake >= 130 ? 'high' : 'med');
      return c === histConfFilter;
    });
  }

  // ── Backfill league field from _sportKey for existing historial entries ──
  {
    const allRaw = loadHistorial();
    let backfillChanged = false;
    for (const h of allRaw) {
      if (!h._sportKey) continue;
      // Siempre re-derivar desde _sportKey — corrige cualquier valor viejo o incorrecto
      const fromSk = sportKeyToLeague(h._sportKey, h.home, h.away);
      if (fromSk && fromSk !== h.league) { h.league = fromSk; backfillChanged = true; }
    }
    if (backfillChanged) {
      saveHistorial(allRaw);
      // Re-apply filters on updated data
      data = filter==='all' ? allRaw : allRaw.filter(h=>h.sport===filter);
      if (histDateFilter !== 'all') {
        const nb = new Date();
        const ts2 = nb.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'});
        const s7  = new Date(nb); s7.setDate(nb.getDate()-7);
        data = data.filter(h => {
          let gd = h.commenceTs ? new Date(h.commenceTs) : null;
          if (!gd && h.date) { const p=h.date.split('/'); if(p.length>=2){gd=new Date(nb.getFullYear(),parseInt(p[1])-1,parseInt(p[0]));if(gd>nb)gd.setFullYear(nb.getFullYear()-1);}}
          if (histDateFilter==='today') return (gd?gd.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'}):h.date)===ts2;
          if (histDateFilter==='week')  return gd ? gd>=s7 : false;
          if (histDateFilter==='finde') return gd ? (gd.getDay()===6||gd.getDay()===0) : false;
          return true;
        });
      }
    }
  }

  // ── League sub-filter: build dropdown from date-filtered data ──
  const ligaPanel = document.getElementById('hfbPanel_liga');
  if (ligaPanel) {
    const leagueMap = {};
    for (const h of data) {
      const lg = sportKeyToLeague(h._sportKey, h.home, h.away) || h.league || null;
      if (!lg) continue;
      h._resolvedLeague = lg;
      if (!leagueMap[lg]) leagueMap[lg] = { total:0, comp:0, wins:0, pl:0 };
      leagueMap[lg].total++;
      if (h.result !== 'pending' && h.result !== 'void') {
        leagueMap[lg].comp++;
        if (h.result === 'win') leagueMap[lg].wins++;
      }
      leagueMap[lg].pl += (h.pl || 0);
    }
    const leagueKeys = Object.keys(leagueMap).sort((a,b) => leagueMap[b].pl - leagueMap[a].pl);
    const allActiveLg = histLeagueFilter === 'all' ? 'active' : '';
    ligaPanel.innerHTML =
      `<button class="hfb-opt ${allActiveLg}" onclick="filterHistLeague('all',this)">🌐 Todas <span class="hfb-opt-pl">(${data.length})</span></button>` +
      leagueKeys.map(lg => {
        const s = leagueMap[lg];
        const plStr = s.pl >= 0 ? `+$${s.pl.toFixed(0)}` : `-$${Math.abs(s.pl).toFixed(0)}`;
        const plColor = s.pl >= 0 ? 'rgba(0,200,83,0.9)' : 'rgba(229,57,53,0.9)';
        const isActive = histLeagueFilter === lg ? 'active' : '';
        return `<button class="hfb-opt ${isActive}" onclick="filterHistLeague('${lg.replace(/'/g,"\\'").replace(/"/g,'&quot;')}',this)">${lg} <span class="hfb-opt-pl">(${s.total} · <span style="color:${plColor}">${plStr}</span>)</span></button>`;
      }).join('');
    // Apply league filter
    if (histLeagueFilter !== 'all') {
      data = data.filter(h => h._resolvedLeague === histLeagueFilter);
    }
  }

  // ── Mercado sub-filter: build dropdown from league-filtered data ──
  const mercadoPanel = document.getElementById('hfbPanel_mercado');
  if (mercadoPanel) {
    const mercadoMap = {};
    for (const h of data) {
      const mk = histMarketKey(h) || null;
      if (!mk) continue;
      if (!mercadoMap[mk]) mercadoMap[mk] = { total:0, comp:0, wins:0, pl:0 };
      mercadoMap[mk].total++;
      if (h.result !== 'pending' && h.result !== 'void') {
        mercadoMap[mk].comp++;
        if (h.result === 'win') mercadoMap[mk].wins++;
      }
      mercadoMap[mk].pl += (h.pl || 0);
    }
    const mercadoKeys = Object.keys(mercadoMap).sort((a,b) => mercadoMap[b].pl - mercadoMap[a].pl);
    const allActiveM = histMercadoFilter === 'all' ? 'active' : '';
    mercadoPanel.innerHTML =
      `<button class="hfb-opt ${allActiveM}" onclick="filterHistMercado('all',this)">⚽ Todos <span class="hfb-opt-pl">(${data.length})</span></button>` +
      mercadoKeys.map(mk => {
        const s = mercadoMap[mk];
        const plStr = s.pl >= 0 ? `+$${s.pl.toFixed(0)}` : `-$${Math.abs(s.pl).toFixed(0)}`;
        const plColor = s.pl >= 0 ? 'rgba(0,200,83,0.9)' : 'rgba(229,57,53,0.9)';
        const isActiveM = histMercadoFilter === mk ? 'active' : '';
        return `<button class="hfb-opt ${isActiveM}" onclick="filterHistMercado('${mk.replace(/'/g,"\\'").replace(/"/g,'&quot;')}',this)">${mk} <span class="hfb-opt-pl">(${s.total} · <span style="color:${plColor}">${plStr}</span>)</span></button>`;
      }).join('');
    // Apply mercado filter
    if (histMercadoFilter !== 'all') {
      data = data.filter(h => histMarketKey(h) === histMercadoFilter);
    }
  }

  // ── Banner resumen finde ──
  const findeBannerEl = document.getElementById('findeBanner');
  if (histDateFilter === 'finde' && findeBannerEl) {
    const now2 = new Date();
    const dayOfWeek = now2.getDay();
    // Calcular próximo sábado y domingo
    const satOffset = dayOfWeek === 6 ? 0 : dayOfWeek === 0 ? -1 : (6 - dayOfWeek);
    const sunOffset = dayOfWeek === 0 ? 0 : dayOfWeek === 6 ? 1  : (7 - dayOfWeek);
    const sat = new Date(now2); sat.setDate(now2.getDate() + satOffset);
    const sun = new Date(now2); sun.setDate(now2.getDate() + sunOffset);
    const fmt = d => d.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'});
    const findePicks = data.length;
    const findeComp = data.filter(h=>h.result!=='pending'&&h.result!=='void');
    const findeWins = findeComp.filter(h=>h.result==='win').length;
    const findeAc   = findeComp.length ? Math.round(findeWins/findeComp.length*100) : null;
    const findePL   = data.reduce((s,h)=>s+h.pl,0);
    findeBannerEl.style.display = 'flex';
    findeBannerEl.innerHTML = `
      <div class="finde-banner-title">🏟️ Fin de Semana · ${fmt(sat)} + ${fmt(sun)}</div>
      <div class="finde-banner-stats">
        <div class="finde-bstat"><div class="fv">${findePicks}</div><div class="fl">Picks</div></div>
        ${findeComp.length ? `<div class="finde-bstat"><div class="fv" style="color:${findeAc>=60?'var(--verde)':findeAc>=50?'var(--naranja)':'var(--rojo)'}">${findeAc}%</div><div class="fl">Acierto</div></div>` : ''}
        ${findeComp.length ? `<div class="finde-bstat"><div class="fv" style="color:${findePL>=0?'var(--verde)':'var(--rojo)'}">${findePL>=0?'+':''}$${findePL.toFixed(0)}</div><div class="fl">P/L</div></div>` : ''}
      </div>`;
  } else if (findeBannerEl) {
    findeBannerEl.style.display = 'none';
  }
  const completed = data.filter(h=>h.result!=='pending'&&h.result!=='void');
  const wins    = completed.filter(h=>h.result==='win').length;
  const hitRate = completed.length ? Math.round(wins/completed.length*100) : 0;
  // 🛡️ Sanear pl: picks pendientes (WC futures) tienen pl undefined → NaN propagado.
  //    Convertir cualquier valor no finito a 0 antes de sumar.
  const _safeN = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
  const totalPL     = data.reduce((s,h)=>s+_safeN(h.pl),0);
  const totalStaked = completed.reduce((s,h)=>s+_safeN(h.stake),0);
  const roi         = totalStaked > 0 ? (totalPL / totalStaked * 100) : 0;
  const racha       = calcRacha(data);

  document.getElementById('histSummary').innerHTML = `
    <div class="hist-stat-card"><span class="hval">${data.length}</span><span class="hlbl">Total</span></div>
    <div class="hist-stat-card"><span class="hval" style="color:${hitRate>=60?'var(--verde)':hitRate>=50?'var(--naranja)':'var(--rojo)'}">${hitRate}%</span><span class="hlbl">Acierto</span></div>
    <div class="hist-stat-card"><span class="hval" style="color:${racha.val>=0?'var(--verde)':'var(--rojo)'};font-size:1rem">${racha.str}</span><span class="hlbl">Racha</span></div>
    <div class="hist-stat-card"><span class="hval" style="color:${totalPL>=0?'var(--verde)':'var(--rojo)'}">${totalPL>=0?'+':''}$${totalPL.toFixed(0)}</span><span class="hlbl">P/L</span></div>
    <div class="hist-stat-card"><span class="hval" style="color:${roi>=10?'var(--verde)':roi>=0?'var(--naranja)':'var(--rojo)'}">${roi>=0?'+':''}${roi.toFixed(1)}%</span><span class="hlbl">ROI</span></div>`;

  const rMap = { win:'<span class="result-win">✅ WIN</span>', loss:'<span class="result-loss">❌ LOSS</span>', void:'<span class="result-void">⚪ VOID</span>', pending:'<span class="result-pending">🟡 PEND</span>' };

  const _now = new Date();
  const todayStr     = _now.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'});
  const _yd = new Date(_now); _yd.setDate(_now.getDate()-1);
  const yesterdayStr = _yd.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'});
  const _tm = new Date(_now); _tm.setDate(_now.getDate()+1);
  const tomorrowStr  = _tm.toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'});

  // Paginación — en sub-página de Resultados se muestra la lista completa (sin límite)
  const _isHistSubPage = document.body.dataset.gbpage === 'historial';
  const totalPages = _isHistSubPage ? 1 : Math.max(1, Math.ceil(data.length / HIST_PAGE_SIZE));
  if (histPage >= totalPages) histPage = totalPages - 1;
  if (histPage < 0) histPage = 0;
  const pageData = _isHistSubPage ? data : data.slice(histPage * HIST_PAGE_SIZE, (histPage + 1) * HIST_PAGE_SIZE);

  // Si aún no terminó de cargar el global de Supabase (_histLoadedOnce=false),
  // NO pintar con data potencialmente stale del localStorage: mostrar skeleton.
  // Previene el bug donde un localStorage viejo (4 picks del 8/4) se muestra
  // hasta que sbLoadHistorial complete (segundos después).
  document.getElementById('histTableBody').innerHTML = (data.length && _histLoadedOnce)
    ? pageData.map(h => {
        const plHtml = h.result==='pending'||h.result==='void'
          ? '<span style="color:#555">—</span>'
          : `<span class="${(+h.pl||0)>=0?'bet-profit-pos':'bet-profit-neg'}">${(+h.pl||0)>=0?'+':''}$${Math.abs(+h.pl||0).toFixed(2)}</span>`;
        const icon = h.sport==='tenis'?'🎾':'⚽';
        const recDisplay = _recLabel(h.rec, h.home, h.away);
        const isMax  = h.stake >= 150;
        const isHigh = h.stake >= 130;
        // Fecha real del partido: usar commenceTs si existe, si no h.date
        // Para picks PEND cuyo commenceTs ya pasó, intentar corregirlo con datos frescos de odds
        let _effectiveTs = h.commenceTs;
        if (h.result === 'pending' && _effectiveTs && _effectiveTs <= Date.now() && window._rawOddsGames?.length) {
          const _liveMatch = window._rawOddsGames.find(g =>
            teamsMatch(g.home_team, h.home) && teamsMatch(g.away_team, h.away)
          );
          if (_liveMatch?.commence_time) {
            const _liveTs = new Date(_liveMatch.commence_time).getTime();
            if (_liveTs > Date.now()) _effectiveTs = _liveTs; // solo si el partido es futuro en los datos frescos
          }
        }
        const gameDate = _effectiveTs
          ? new Date(_effectiveTs).toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'})
          : (h.date || '—');
        const isToday = gameDate === todayStr;
        const rowClass = isToday ? 'hist-row-today' : '';
        const rowStyle = isMax
          ? 'background:linear-gradient(90deg,rgba(255,214,0,0.15) 0%,rgba(255,214,0,0.06) 100%);border-left:3px solid rgba(255,214,0,0.7)'
          : isHigh
          ? 'background:linear-gradient(90deg,rgba(255,214,0,0.09) 0%,rgba(255,214,0,0.04) 100%);border-left:2px solid rgba(255,214,0,0.45)'
          : '';
        const _scoreShow = h.finalScore || h.marcador || (h.homeScore != null && h.awayScore != null ? h.homeScore + '-' + h.awayScore : '');
        const marcador = _scoreShow
          ? `<span style="font-weight:700;color:#e0e0e0;letter-spacing:0.5px">${_scoreShow}</span>`
          : `<span style="color:#444">—</span>`;
        const mKey = encodeURIComponent(h.home + '|||' + h.away);
        const mScore = encodeURIComponent(_scoreShow || '');
        const _admOk = (() => { try { const s = JSON.parse(sessionStorage.getItem(ADMIN_SESSION)||'null'); return !!(s && s.exp > Date.now()); } catch { return false; } })();
        const resultCell = _admOk
          ? `<span style="display:inline-flex;align-items:center;gap:3px">${rMap[h.result]||rMap.void}<span class="result-editable" style="cursor:pointer;font-size:0.6rem;opacity:0.45;margin-left:2px" title="Editar resultado y marcador" onclick="showResultPicker(this,'${mKey}','${h.result}','${mScore}')">✏</span></span>`
          : (rMap[h.result] || rMap.void);
        // Normalizar nombres inconsistentes del Odds API para logos correctos
        const _logoName = (n, sk) => (n === 'Barcelona' && sk?.includes('conmebol')) ? 'Barcelona SC' : n;
        const homeShield = logoHtml(_logoName(h.home, h._sportKey), 34);
        const awayShield = logoHtml(_logoName(h.away, h._sportKey), 34);
        const matchCell = `<td style="width:140px;min-width:140px;text-align:center"><span title="${h.home} vs ${h.away}" style="display:inline-flex;align-items:center;justify-content:center;gap:8px;vertical-align:middle;width:100%">${homeShield}<span style="font-size:0.62rem;color:var(--texto-sec);font-weight:600">vs</span>${awayShield}</span></td>`;
        // Celda de fecha: usar la fecha real del partido (gameDate ya calculada arriba)
        let dateLabel, dateCellStyle;
        const baseDateStyle = 'width:58px;min-width:58px;text-align:center;font-size:0.78rem;white-space:nowrap;';
        if (gameDate === todayStr) {
          dateLabel = '<span style="font-weight:800;color:var(--verde);letter-spacing:0.3px">HOY</span>';
          dateCellStyle = baseDateStyle;
        } else if (gameDate === yesterdayStr) {
          dateLabel = '<span style="color:var(--texto-sec)">Ayer</span>';
          dateCellStyle = baseDateStyle;
        } else if (gameDate === tomorrowStr) {
          dateLabel = '<span style="color:var(--amarillo)">Mañ.</span>';
          dateCellStyle = baseDateStyle;
        } else {
          dateLabel = `<span style="color:var(--texto-sec)">${gameDate}</span>`;
          dateCellStyle = baseDateStyle;
        }
        const dateCell = `<td style="${dateCellStyle}">${dateLabel}</td>`;
        // 🏆 Resaltar picks futures del Mundial 2026 con estilo dorado distintivo
        const _wcExtra = h._wcFuture
          ? 'background:linear-gradient(90deg,rgba(255,215,0,0.08) 0%,rgba(200,16,46,0.05) 100%);border-left:3px solid #FFD700;'
          : '';
        const _wcBadge = h._wcFuture
          ? '<span style="display:inline-block;background:linear-gradient(135deg,#FFD700,#f59e0b);color:#14110a;font-size:0.6rem;font-weight:900;letter-spacing:0.5px;padding:1px 6px;border-radius:4px;margin-right:6px;vertical-align:middle">🏆 WC2026</span>'
          : '';
        return `<tr class="${rowClass}" style="${rowStyle}${_wcExtra}">${dateCell}${matchCell}<td style="color:var(--verde)">${_wcBadge}${recDisplay}</td><td style="color:var(--amarillo);font-weight:600">${parseFloat(h.odds).toFixed(2)}</td><td>$${h.stake}</td><td>${resultCell}</td><td>${marcador}</td><td>${plHtml}</td></tr>`;
      }).join('')
    : (() => {
        // Diferenciar estado de carga vs error vs genuinamente vacío
        if (_histLoading || !_histLoadedOnce) {
          // Aún cargando desde Supabase → skeleton animado (3 filas)
          const sk = () => `<tr style="opacity:0.4;animation:pulse 1.5s infinite">`
            + `<td><div style="height:11px;background:rgba(255,255,255,0.12);border-radius:4px;width:60%"></div></td>`.repeat(8)
            + `</tr>`;
          return sk() + sk() + sk();
        }
        if (_histLoadFailed) {
          // Carga fallida: proponer recargar
          return `<tr><td colspan="8" style="text-align:center;padding:28px;color:var(--texto-sec)">
            <div style="font-size:1.3rem;margin-bottom:8px">📡</div>
            <div style="font-size:0.9rem;font-weight:700;color:var(--texto-pri);margin-bottom:6px">No se pudo cargar el historial</div>
            <div style="font-size:0.78rem;margin-bottom:14px">Revisá tu conexión o recargá la página.</div>
            <button onclick="_histLoadFailed=false;_histLoadedOnce=false;sbLoadHistorial();" style="background:var(--verde);color:#000;border:none;border-radius:20px;padding:8px 22px;font-size:0.78rem;font-weight:700;cursor:pointer;font-family:inherit;margin-right:8px">🔄 Reintentar</button>
            <button onclick="location.reload()" style="background:transparent;border:1px solid rgba(255,255,255,0.18);color:var(--texto-sec);border-radius:20px;padding:7px 18px;font-size:0.76rem;font-weight:600;cursor:pointer;font-family:inherit">↺ Recargar</button>
          </td></tr>`;
        }
        // Genuinamente sin picks con el filtro activo
        const _filterMsg = histDateFilter !== 'all' ? 'No hay picks en el período seleccionado.' : 'No hay picks registrados aún.';
        return `<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--texto-sec);font-size:0.85rem">${_filterMsg}</td></tr>`;
      })();

  // Barra de navegación de páginas — oculta siempre en sub-página (lista infinita)
  const navEl = document.getElementById('histPagNav');
  if (_isHistSubPage || totalPages <= 1) {
    navEl.style.display = 'none';
  } else {
    navEl.style.display = 'flex';
    const btnStyle = (active) => `cursor:pointer;padding:6px 13px;border-radius:8px;font-size:0.78rem;font-weight:700;border:1px solid ${active?'var(--verde)':'rgba(0,200,83,0.25)'};background:${active?'rgba(0,200,83,0.18)':'transparent'};color:${active?'var(--verde)':'var(--texto-sec)'};transition:background .15s`;
    const disabledStyle = `cursor:default;padding:6px 13px;border-radius:8px;font-size:0.78rem;font-weight:700;border:1px solid rgba(255,255,255,0.08);background:transparent;color:rgba(255,255,255,0.2)`;
    let html = '';
    // Botón anterior
    html += histPage > 0
      ? `<button style="${btnStyle(false)}" onclick="histNavTo(${histPage-1})">‹ Anterior</button>`
      : `<button style="${disabledStyle}" disabled>‹ Anterior</button>`;
    // Números de página (máx 5 visibles)
    const halfWin = 2;
    let start = Math.max(0, histPage - halfWin);
    let end   = Math.min(totalPages - 1, histPage + halfWin);
    if (end - start < 4) { start = Math.max(0, end - 4); }
    if (start > 0) html += `<span style="color:var(--texto-sec);font-size:0.75rem;padding:0 2px">…</span>`;
    for (let i = start; i <= end; i++) {
      html += `<button style="${btnStyle(i===histPage)}" onclick="histNavTo(${i})">${i+1}</button>`;
    }
    if (end < totalPages - 1) html += `<span style="color:var(--texto-sec);font-size:0.75rem;padding:0 2px">…</span>`;
    // Botón siguiente
    html += histPage < totalPages - 1
      ? `<button style="${btnStyle(false)}" onclick="histNavTo(${histPage+1})">Siguiente ›</button>`
      : `<button style="${disabledStyle}" disabled>Siguiente ›</button>`;
    // Info de página
    html += `<span style="font-size:0.72rem;color:var(--texto-sec);margin-left:4px">${histPage*HIST_PAGE_SIZE+1}–${Math.min((histPage+1)*HIST_PAGE_SIZE,data.length)} de ${data.length}</span>`;
    navEl.innerHTML = html;
  }
  if (typeof syncResolveBtn === 'function') syncResolveBtn();
  } catch(e) {
    console.error('[renderHistorial] Error al renderizar tabla:', e);
    // Fallback: mostrar mensaje de error sin romper la UI
    const _tb = document.getElementById('histTableBody');
    if (_tb) _tb.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:30px;color:var(--texto-sec)">⚠️ Error al cargar la tabla. Recargá la página.</td></tr>`;
    const _sm = document.getElementById('histSummary');
    if (_sm) _sm.innerHTML = '';
  }
}

function histNavTo(page) {
  histPage = page;
  renderHistorial(histFilter);
  document.getElementById('historial')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ── Corrección manual de resultado + marcador desde la tabla (solo admin) ── */
function showResultPicker(el, mKey, currentResult, encodedScore) {
  const curScore = decodeURIComponent(encodedScore || '');
  const pid = 'sp_' + Math.random().toString(36).slice(2,7);
  // Reemplaza la celda entera (td) con el picker inline
  const td = el.closest('td');
  td.innerHTML = `
    <span style="display:inline-flex;gap:4px;align-items:center;flex-wrap:wrap">
      <input id="${pid}" type="text" value="${curScore}" placeholder="Ej: 2-1"
        style="width:52px;background:#0d1a0d;border:1px solid rgba(0,200,83,0.4);color:#fff;padding:3px 6px;border-radius:6px;font-size:0.7rem;text-align:center;outline:none"/>
      <button class="result-picker-btn" style="background:#1b3d20;color:#00e676;border:1px solid #00c853"
        onclick="applyHistResult('${mKey}','win','${pid}')">✅ WIN</button>
      <button class="result-picker-btn" style="background:#3d1a1a;color:#ef5350;border:1px solid #c62828"
        onclick="applyHistResult('${mKey}','loss','${pid}')">❌ LOSS</button>
      <button class="result-picker-btn" style="background:#2a1a00;color:#ffa726;border:1px solid #e65100"
        onclick="applyHistResult('${mKey}','void','${pid}')">⚪</button>
      <button class="result-picker-btn" style="background:#1a1a1a;color:#888;border:1px solid #333"
        onclick="renderHistorial(histFilter)">✕</button>
    </span>`;
  setTimeout(() => document.getElementById(pid)?.focus(), 50);
}

function applyHistResult(mKey, val, scoreInputId) {
  const [home, away] = decodeURIComponent(mKey).split('|||');
  const hist = loadHistorial();
  const entry = hist.find(e => e.home === home && e.away === away);
  if (!entry) { renderHistorial(histFilter); return; }
  // Leer marcador del input (si existe)
  const scoreRaw = scoreInputId ? (document.getElementById(scoreInputId)?.value || '').trim() : '';
  if (scoreRaw) entry.finalScore = scoreRaw;
  entry.result = val;
  const odds = parseFloat(entry.odds) || 1;
  entry.pl = val === 'win'  ? parseFloat(((odds - 1) * entry.stake).toFixed(2))
           : val === 'loss' ? -entry.stake : 0;
  // Marcar momento de resolución para TTL en preds (16h win / 10h loss)
  if (val !== 'pending') entry.resolvedAt = Date.now();
  saveHistorial(hist);
  renderHistorial(histFilter);
}

function clearHistorial() {
  if (!confirm('¿Limpiar todo el historial? Esta acción no se puede deshacer.')) return;
  saveHistorial([]);
  renderHistorial(histFilter);
}

// ── Filtro de deporte en pronósticos ──
window._predSportFilter = 'all';
function filterPredSport(sport, btn) {
  window._predSportFilter = sport;
  document.querySelectorAll('#predSportTabs .sport-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderPreds();
}
window._predTimeFilter = 'all';
function filterPredTime(time, btn) {
  window._predTimeFilter = time;
  document.querySelectorAll('#predTimeTabs .sport-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderPreds();
}

function filterHist(f,btn) {
  document.querySelectorAll('#historial .sport-tab').forEach(b=>b.classList.remove('active'));
  // Restaurar el activo del filtro de fecha
  const dateActive = histDateFilter==='today' ? 'histDateBtnHoy' : histDateFilter==='week' ? 'histDateBtnWeek' : histDateFilter==='finde' ? 'histDateBtnFinde' : 'histDateBtnAll';
  document.getElementById(dateActive)?.classList.add('active');
  btn.classList.add('active'); histFilter=f; histLeagueFilter='all'; histMercadoFilter='all'; histPage=0; renderHistorial(f);
}

// ── Dropdown toggle helpers ──────────────────────────────────────────────────
function hfbToggle(id) {
  const panel = document.getElementById('hfbPanel_' + id);
  if (!panel) return;
  const btn = panel.closest('.hfb-drop')?.querySelector('.hfb-btn');
  const isOpen = panel.classList.contains('open');
  // Close all
  document.querySelectorAll('.hfb-panel.open').forEach(p => {
    p.classList.remove('open');
    p.closest('.hfb-drop')?.querySelector('.hfb-btn')?.classList.remove('open');
  });
  // Open this one if it was closed
  if (!isOpen) {
    panel.classList.add('open');
    btn?.classList.add('open');
  }
}
function hfbClose(id) {
  const panel = document.getElementById('hfbPanel_' + id);
  panel?.classList.remove('open');
  panel?.closest('.hfb-drop')?.querySelector('.hfb-btn')?.classList.remove('open');
}
function hfbSetLabel(id, text) {
  const el = document.getElementById('hfbVal_' + id);
  if (el) el.textContent = text;
  const btn = el?.closest('.hfb-drop')?.querySelector('.hfb-btn');
  if (btn) btn.classList.add('has-value');
}
// Cerrar dropdowns al hacer click fuera (ignorar clicks dentro de .hfb-drop)
document.addEventListener('click', (e) => {
  if (e.target.closest('.hfb-drop')) return;
  document.querySelectorAll('.hfb-panel.open').forEach(p => {
    p.classList.remove('open');
    p.closest('.hfb-drop')?.querySelector('.hfb-btn')?.classList.remove('open');
  });
});
// ────────────────────────────────────────────────────────────────────────────

function filterHistDate(f, btn) {
  document.querySelectorAll('#hfbPanel_fecha .hfb-opt').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const labels = { all:'Todo', today:'Hoy', finde:'Finde', week:'Semana' };
  hfbSetLabel('fecha', labels[f] || 'Todo');
  hfbClose('fecha');
  histDateFilter = f; histLeagueFilter='all'; histMercadoFilter='all'; histPage=0;
  renderHistorial(histFilter);
}

function filterHistConf(f, btn) {
  document.querySelectorAll('#hfbPanel_conf .hfb-opt').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const labels = { all:'Confianza', max:'Máxima', high:'Alta', med:'Media' };
  hfbSetLabel('conf', labels[f] || 'Confianza');
  hfbClose('conf');
  histConfFilter = f; histLeagueFilter='all'; histMercadoFilter='all'; histPage=0;
  renderHistorial(histFilter);
}

function filterHistLeague(league, btn) {
  document.querySelectorAll('#hfbPanel_liga .hfb-opt').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  histLeagueFilter = league;
  histMercadoFilter = 'all';
  hfbSetLabel('liga', league === 'all' ? 'Liga' : league);
  hfbClose('liga');
  histPage = 0;
  renderHistorial(histFilter);
}

function filterHistMercado(mercado, btn) {
  document.querySelectorAll('#hfbPanel_mercado .hfb-opt').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  histMercadoFilter = mercado;
  hfbSetLabel('mercado', mercado === 'all' ? 'Mercado' : mercado);
  hfbClose('mercado');
  histPage = 0;
  renderHistorial(histFilter);
}

// ═══════════════════════════════════════════════
//  ODDS COMPARISON
// ═══════════════════════════════════════════════

// Links de afiliado por casa de apuestas
const BOOK_AFFILIATE = {
  megapari:  'https://proarg.megapari-003572.in/',
  melbet:    'https://refpa3665.com/L?tag=d_5777587m_11213c_&site=5777587&ad=2170&r=registration',
  betwinner: 'https://bwredir.com/2J04?p=%2Fregistration%2F&s1=PronosticosLATAM',
  dbbet_aff:  'https://refpa96317.com/L?tag=d_5777587m_11213c_&site=5777587&ad=11213&utm_source=home_dbbet&utm_medium=site',
  dbbet:  'https://refpa96317.com/L?tag=d_5777587m_11213c_&site=5777587&ad=11213&utm_source=home_dbbet&utm_medium=site&r=email',
};
function getBookLink(key) {
  if (!key) return null;
  const k = key.toLowerCase();
  if (BOOK_AFFILIATE[k]) return BOOK_AFFILIATE[k];
  const found = Object.keys(BOOK_AFFILIATE).find(bk => k.includes(bk) || bk.includes(k));
  return found ? BOOK_AFFILIATE[found] : null;
}

// Logos de casas de apuestas: key → URL del logo
const BOOK_LOGOS = {
  megapari:   'https://www.google.com/s2/favicons?domain=megapari.com&sz=64',
  melbet:     'https://www.google.com/s2/favicons?domain=melbet.com&sz=64',
  betwinner:  'https://www.google.com/s2/favicons?domain=betwinner.com&sz=64',
  dbbet_aff:   '/img/casas/dbbet.svg',
  dbbet:   'https://www.google.com/s2/favicons?domain=dbbetbet.com&sz=64',
  // Fallbacks para keys que pueden venir de la API
  bet365:     'https://www.google.com/s2/favicons?domain=bet365.com&sz=64',
  draftkings: 'https://www.google.com/s2/favicons?domain=draftkings.com&sz=64',
  fanduel:    'https://www.google.com/s2/favicons?domain=fanduel.com&sz=64',
  betmgm:     'https://www.google.com/s2/favicons?domain=betmgm.com&sz=64',
  unibet:     'https://www.google.com/s2/favicons?domain=unibet.com&sz=64',
  pinnacle:   'https://www.google.com/s2/favicons?domain=pinnacle.com&sz=64',
  williamhill:'https://www.google.com/s2/favicons?domain=williamhill.com&sz=64',
  betfair:    'https://www.google.com/s2/favicons?domain=betfair.com&sz=64',
  bwin:       'https://www.google.com/s2/favicons?domain=bwin.com&sz=64',
  _default:   'https://www.google.com/s2/favicons?domain=sportsbetting.ag&sz=64',
};

function getBookLogo(key) {
  // Busca coincidencia por key, luego por substring del key
  if (BOOK_LOGOS[key]) return BOOK_LOGOS[key];
  const k = key.toLowerCase();
  const found = Object.keys(BOOK_LOGOS).find(bk => bk !== '_default' && (k.includes(bk) || bk.includes(k)));
  return found ? BOOK_LOGOS[found] : BOOK_LOGOS._default;
}

// Casas fijas del header — no cambian aunque la API devuelva otras
const FIXED_BOOKS = [
  { key:'megapari',  label:'Megapari',    feat:true  },
  { key:'melbet',    label:'Melbet',      feat:true  },
  { key:'betwinner', label:'BetWinner',   feat:false },
  { key:'dbbet',  label:'DBbet', feat:false },
  { key:'dbbet',  label:'DBbet', feat:false },
];

function buildOddsHeader() {} // no-op: replaced by card layout


// ═══════════════════════════════════════════════
//  BANKROLL MANAGER
// ═══════════════════════════════════════════════
const bankrollData = {
  initial: 1000,
  history: []
};

// ── Persistencia de Bankroll por usuario ──────────────────────────────────────
function _bmKey() {
  const email = authUser?.email || 'guest';
  return `gambeta_bm_${email}`;
}
function saveBankrollData() {
  try {
    localStorage.setItem(_bmKey(), JSON.stringify({
      initial: bankrollData.initial,
      history: bankrollData.history
    }));
  } catch(e) {}
}
function loadBankrollData() {
  try {
    const raw = localStorage.getItem(_bmKey());
    if (raw) {
      const saved = JSON.parse(raw);
      bankrollData.initial = saved.initial ?? 1000;
      bankrollData.history = Array.isArray(saved.history) ? saved.history : [];
    } else {
      // Primera vez: empezar limpio
      bankrollData.initial = 1000;
      bankrollData.history = [];
    }
  } catch(e) {
    bankrollData.initial = 1000;
    bankrollData.history = [];
  }
  renderBankrollSummary();
  drawBankrollChart();
  renderBetsList();
}
function clearBankrollData() {
  bankrollData.initial = 1000;
  bankrollData.history = [];
  renderBankrollSummary();
  drawBankrollChart();
  renderBetsList();
}
function calcBankrollHistory() {
  const _safeN = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
  let bal=_safeN(bankrollData.initial);
  return [bal,...(bankrollData.history||[]).map(b=>{bal+=_safeN(b.pl);return bal;})];
}
function renderBankrollSummary() {
  const _safeN = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
  const _ini=_safeN(bankrollData.initial);
  const hist=calcBankrollHistory(), cur=_safeN(hist[hist.length-1]), profit=cur-_ini;
  const roi=(_ini>0 ? (profit/_ini)*100 : 0).toFixed(1);
  document.getElementById('bankrollSummary').innerHTML = `
    <div class="bk-stat"><span class="bv">$${bankrollData.initial}</span><span class="bl">Inicial</span></div>
    <div class="bk-stat"><span class="bv" style="color:${cur>=bankrollData.initial?'var(--verde)':'var(--rojo)'}">$${cur.toFixed(0)}</span><span class="bl">Actual</span></div>
    <div class="bk-stat"><span class="bv" style="color:${profit>=0?'var(--verde)':'var(--rojo)'}">${profit>=0?'+':''}$${profit.toFixed(0)}</span><span class="bl">Profit</span></div>
    <div class="bk-stat"><span class="bv" style="color:${parseFloat(roi)>=0?'var(--verde)':'var(--rojo)'}">${parseFloat(roi)>=0?'+':''}${roi}%</span><span class="bl">ROI</span></div>`;
}
function drawBankrollChart() {
  const canvas=document.getElementById('bankrollChart'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  if (!ctx) return;
  const dpr=window.devicePixelRatio||1, W=Math.min(canvas.parentElement?.clientWidth || 320, window.innerWidth - 40), H=200;
  canvas.width=W*dpr; canvas.height=H*dpr; canvas.style.width=W+'px'; canvas.style.height=H+'px';
  ctx.scale(dpr,dpr);
  const pad={t:16,r:16,b:28,l:52}, data=calcBankrollHistory();
  if (data.length < 2) return; // necesita al menos 2 puntos para trazar
  const minV=Math.min(...data)-60, maxV=Math.max(...data)+60, range=maxV-minV;
  const tx=i=>pad.l+(i/(data.length-1))*(W-pad.l-pad.r);
  const ty=v=>pad.t+(1-(v-minV)/range)*(H-pad.t-pad.b);
  ctx.clearRect(0,0,W,H);
  // grid
  for(let i=0;i<=4;i++){
    const y=pad.t+(i/4)*(H-pad.t-pad.b);
    ctx.strokeStyle='rgba(255,255,255,0.05)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(pad.l,y); ctx.lineTo(W-pad.r,y); ctx.stroke();
    ctx.fillStyle='#555'; ctx.font='10px system-ui'; ctx.textAlign='right';
    ctx.fillText('$'+Math.round(maxV-(i/4)*range),pad.l-4,y+4);
  }
  // area
  const grad=ctx.createLinearGradient(0,pad.t,0,H-pad.b);
  grad.addColorStop(0,'rgba(0,200,83,0.22)'); grad.addColorStop(1,'rgba(0,200,83,0.02)');
  ctx.beginPath(); data.forEach((v,i)=>i===0?ctx.moveTo(tx(i),ty(v)):ctx.lineTo(tx(i),ty(v)));
  ctx.lineTo(tx(data.length-1),H-pad.b); ctx.lineTo(tx(0),H-pad.b); ctx.closePath();
  ctx.fillStyle=grad; ctx.fill();
  // line
  ctx.beginPath(); data.forEach((v,i)=>i===0?ctx.moveTo(tx(i),ty(v)):ctx.lineTo(tx(i),ty(v)));
  ctx.strokeStyle='#00c853'; ctx.lineWidth=2.5; ctx.lineJoin='round'; ctx.stroke();
  // points
  data.forEach((v,i)=>{
    ctx.beginPath(); ctx.arc(tx(i),ty(v),4,0,Math.PI*2);
    ctx.fillStyle='#00c853'; ctx.fill(); ctx.strokeStyle='#0d1a0d'; ctx.lineWidth=2; ctx.stroke();
  });
  // initial baseline
  const initY=ty(bankrollData.initial);
  ctx.setLineDash([4,4]); ctx.strokeStyle='rgba(255,255,255,0.12)'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(pad.l,initY); ctx.lineTo(W-pad.r,initY); ctx.stroke(); ctx.setLineDash([]);
}
function renderBetsList() {
  const recent=[...bankrollData.history].slice(-5).reverse();
  document.getElementById('betsList').innerHTML = recent.map(b=>`
    <div class="bet-item">
      <div><div class="bi-match">${b.match}</div><div class="bi-detail">Cuota ${b.odds} · Stake $${b.stake} · ${b.result==='win'?'✅ WIN':'❌ LOSS'}</div></div>
      <div class="${b.pl>=0?'bet-profit-pos':'bet-profit-neg'}">${b.pl>=0?'+':''}$${b.pl}</div>
    </div>`).join('');
}
function addBet() {
  const match=document.getElementById('bk-match').value.trim();
  const odds=parseFloat(document.getElementById('bk-odds').value);
  const stake=parseFloat(document.getElementById('bk-stake').value);
  const result=document.getElementById('bk-result').value;
  if(!match||!odds||!stake){alert('Completá todos los campos');return;}
  const pl=result==='win'?+(stake*(odds-1)).toFixed(2):result==='loss'?-stake:0;
  bankrollData.history.push({match,odds,stake,result,pl});
  ['bk-match','bk-odds','bk-stake'].forEach(id=>document.getElementById(id).value='');
  saveBankrollData();  // ← persistir en localStorage
  renderBankrollSummary(); drawBankrollChart(); renderBetsList();
}

// ═══════════════════════════════════════════════
//  ANÁLISIS DE PARTIDO – MODAL
// ═══════════════════════════════════════════════
const matchAnalysisData = {
  'Real Madrid-Man City': {
    league:'Champions League', time:'Hoy 21:00', weather:'🌤 Madrid · 16°C',
    homeForm:['G','G','E','G','G'], awayForm:['G','P','G','G','E'],
    stats:[{name:'Posesión %',home:56,away:44},{name:'Goles/partido',home:2.8,away:2.4,max:5},{name:'Tiros/partido',home:6.2,away:5.8,max:10},{name:'Duelos ganados %',home:54,away:46}],
    h2h:[{date:'05/11/24',home:'Real Madrid',away:'Man City',score:'3-3',res:'E'},{date:'09/04/24',home:'Man City',away:'Real Madrid',score:'1-1',res:'E'},{date:'17/04/24',home:'Real Madrid',away:'Man City',score:'4-3',res:'G'},{date:'26/04/23',home:'Man City',away:'Real Madrid',score:'4-0',res:'P'}],
    injuries:{home:[{name:'Militão',status:'out'},{name:'Carvajal',status:'out'},{name:'Bellingham',status:'ok'}],away:[{name:'Rodri',status:'out'},{name:'De Bruyne',status:'doubt'},{name:'Haaland',status:'ok'}]},
    probH:48,probD:22,probA:30,
    insight:'Real Madrid llega en gran momento tras 4 victorias seguidas. City sin Rodri reduce su control del juego. El Bernabéu puede ser factor decisivo. IA recomienda apuesta en Local con gestión de stake moderada.'
  },
  'Barcelona-Atlético': {
    league:'🇪🇸 La Liga', time:'Hoy 21:00', weather:'🌤 Barcelona · 18°C',
    homeForm:['W','L','W','W','D'], awayForm:['W','W','L','D','W'],
    stats:[{name:'Posesión %',home:62,away:38},{name:'Goles/partido',home:2.5,away:1.8,max:4},{name:'Tiros/partido',home:7.1,away:4.9,max:10},{name:'Duelos ganados %',home:51,away:49}],
    h2h:[{date:'21/04/24',home:'Barcelona',away:'Atlético',score:'3-0',res:'W'},{date:'03/12/23',home:'Atlético',away:'Barcelona',score:'1-0',res:'L'},{date:'17/04/23',home:'Barcelona',away:'Atlético',score:'1-0',res:'W'},{date:'06/11/22',home:'Atlético',away:'Barcelona',score:'1-1',res:'D'}],
    injuries:{home:[{name:'Ter Stegen',status:'out'},{name:'Fermín',status:'ok'}],away:[{name:'Griezmann',status:'doubt'},{name:'Oblak',status:'ok'}]},
    probH:42,probD:28,probA:30,
    insight:'Barcelona domina estadísticamente en casa. Atlético siempre es difícil pero Barça es muy goleador. "Ambos Marcan" tiene alta probabilidad dado el estilo ofensivo de ambos equipos.'
  },
};

function togglePredExpand(idx) {
  const body  = document.getElementById(`pred-expand-${idx}`);
  const arrow = document.getElementById(`pred-arrow-${idx}`);
  if (!body) return;
  const isOpen = body.classList.toggle('open');
  if (arrow) arrow.classList.toggle('open', isOpen);
}

function openMatchAnalysis(home, away) {
  const key=`${home}-${away}`, data=matchAnalysisData[key];
  document.getElementById('modalTitle').textContent=`${home} vs ${away} — Análisis IA`;
  const fDot=r=>`<div class="form-dot dot-${r==='G'?'w':r==='E'?'d':'l'}" style="width:20px;height:20px;font-size:0.58rem">${r}</div>`;
  if(!data){
    document.getElementById('modalBody').innerHTML=`<div style="text-align:center;padding:40px;color:var(--texto-sec)"><div style="font-size:3rem;margin-bottom:12px">🔍</div><p>Análisis detallado en preparación.<br>La IA está procesando datos estadísticos.</p></div>`;
    document.getElementById('analysisModal').classList.add('active'); return;
  }
  document.getElementById('modalBody').innerHTML=`
    <div class="analysis-teams">
      <div class="analysis-team">
        <div style="display:flex;justify-content:center;margin-bottom:6px">${logoHtml(home,60)}</div>
        <div class="at-name">${home}</div>
        <div class="at-form">${data.homeForm.map(fDot).join('')}</div>
      </div>
      <div class="analysis-center">
        <div class="vs">VS</div>
        <div class="league-badge">${data.league}</div>
        <div class="match-time">⏱ ${data.time}</div>
        <div class="match-time">${data.weather}</div>
      </div>
      <div class="analysis-team">
        <div style="display:flex;justify-content:center;margin-bottom:6px">${logoHtml(away,60)}</div>
        <div class="at-name">${away}</div>
        <div class="at-form">${data.awayForm.map(fDot).join('')}</div>
      </div>
    </div>
    <div class="proba-section">
      <div style="display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:6px">
        <span style="color:var(--verde)">Local ${data.probH}%</span>
        ${data.probD?`<span style="color:#888">Empate ${data.probD}%</span>`:''}
        <span style="color:var(--azul)">Visitante ${data.probA}%</span>
      </div>
      <div class="proba-bars">
        <div class="proba-home" style="width:${data.probH}%">${data.probH}%</div>
        ${data.probD?`<div class="proba-draw" style="width:${data.probD}%">${data.probD}%</div>`:''}
        <div class="proba-away" style="width:${data.probA}%">${data.probA}%</div>
      </div>
    </div>
    <div class="analysis-grid">
      <div class="analysis-card">
        <h5>📊 Estadísticas</h5>
        ${data.stats.map(s=>{const tot=s.max||100,hp=s.home/(s.home+s.away)*100,ap=s.away/(s.home+s.away)*100;return`<div class="stat-compare-row"><div class="scl">${s.home}</div><div class="stat-compare-bar"><div class="scb-home" style="width:${hp}%"></div><div class="scb-away" style="width:${ap}%"></div></div><div class="scr">${s.away}</div><div class="scn">${s.name}</div></div>`}).join('')}
      </div>
      <div class="analysis-card">
        <h5>⚔️ Historial H2H</h5>
        <div class="h2h-list">${data.h2h.map(m=>`<div class="h2h-row"><span class="h2h-date">${m.date}</span><span style="font-size:0.77rem">${m.home} vs ${m.away}</span><span class="h2h-score h2h-${m.res==='W'?'win':m.res==='L'?'loss':'draw'}">${m.score}</span></div>`).join('')}</div>
      </div>
      <div class="analysis-card">
        <h5>🏥 Bajas y Dudas</h5>
        <div style="font-size:0.73rem;color:var(--verde);font-weight:600;margin-bottom:6px">${home}</div>
        <div class="injury-list">${data.injuries.home.map(p=>`<div class="injury-item"><div class="injury-dot inj-${p.status}"></div><span>${p.name}</span><span style="color:#666;margin-left:auto;font-size:0.68rem">${p.status==='out'?'Baja':p.status==='doubt'?'Duda':'OK'}</span></div>`).join('')}</div>
        <div style="font-size:0.73rem;color:var(--azul);font-weight:600;margin:8px 0 6px">${away}</div>
        <div class="injury-list">${data.injuries.away.map(p=>`<div class="injury-item"><div class="injury-dot inj-${p.status}"></div><span>${p.name}</span><span style="color:#666;margin-left:auto;font-size:0.68rem">${p.status==='out'?'Baja':p.status==='doubt'?'Duda':'OK'}</span></div>`).join('')}</div>
      </div>
      <div class="analysis-card">
        <h5>🤖 Análisis IA</h5>
        <p style="font-size:0.82rem;line-height:1.6;color:var(--texto-sec)">${data.insight}</p>
      </div>
    </div>`;
  document.getElementById('analysisModal').classList.add('active');
  loadPlayerPhotos();
}
function closeModal() { document.getElementById('analysisModal').classList.remove('active'); }
document.addEventListener('keydown', e => { if(e.key==='Escape') closeModal(); });

// ── Scroll al pred-card de la estrella del finde ──
// ── Slug + URL del artículo del blog para cada pick ──
function _slugifyTeam(s) {
  if (!s) return '';
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().replace(/^-|-$/g, '');
}
// 🆕 (25-jun-2026) Whitelist de articulos de pronostico que existen en /blog/
// Para evitar 404 cuando el pick es nuevo y no tiene articulo todavia.
// Update: cuando crees un nuevo articulo, agregarlo aca.
const _PICK_BLOG_SLUGS = new Set([
  'pronostico-alemania-curacao-14-06',
  'pronostico-alemania-ecuador-25-06',
  'pronostico-argentina-argelia-16-06',
  'pronostico-argentina-austria-22-06',
  'pronostico-belgica-egipto-15-06',
  'pronostico-belgica-iran-21-06',
  'pronostico-brasil-marruecos-13-06',
  'pronostico-canada-bosnia-12-06',
  'pronostico-colombia-rd-congo-23-06',
  'pronostico-egipto-iran-26-06',
  'pronostico-espana-arabia-saudita-21-06',
  'pronostico-espana-cabo-verde-15-06',
  'pronostico-estados-unidos-paraguay-12-06',
  'pronostico-francia-irak-22-06',
  'pronostico-francia-senegal-16-06',
  'pronostico-inglaterra-croacia-17-06',
  'pronostico-inglaterra-ghana-23-06',
  'pronostico-marruecos-haiti-24-06',
  'pronostico-mexico-republica-checa-24-06',
  'pronostico-mexico-sudafrica-11-06',
  'pronostico-noruega-senegal-23-06',
  'pronostico-nueva-zelanda-egipto-22-06',
  'pronostico-paises-bajos-japon-14-06',
  'pronostico-paises-bajos-tunez-25-06',
  'pronostico-panama-croacia-23-06',
  'pronostico-portugal-rd-congo-17-06',
  'pronostico-portugal-uzbekistan-23-06',
  'pronostico-tunez-japon-21-06',
  'pronostico-uruguay-cabo-verde-21-06',
  'pronostico-uruguay-espana-26-06'
]);

function buildPickBlogUrl(pick) {
  if (!pick || !pick.home || !pick.away) return null;
  let dm = '';
  if (pick.commenceTs) {
    const d = new Date(pick.commenceTs);
    const dd = String(d.getUTCDate()).padStart(2,'0');
    const mm = String(d.getUTCMonth()+1).padStart(2,'0');
    dm = dd + '-' + mm;
  } else if (pick.date) {
    const d = new Date(pick.date);
    const dd = String(d.getUTCDate()).padStart(2,'0');
    const mm = String(d.getUTCMonth()+1).padStart(2,'0');
    dm = dd + '-' + mm;
  }
  if (!dm) return null;
  const slug = 'pronostico-' + _slugifyTeam(pick.home) + '-' + _slugifyTeam(pick.away) + '-' + dm;
  // 🛡️ Solo devolver URL si el articulo EXISTE — evita 404 en picks nuevos
  if (!_PICK_BLOG_SLUGS.has(slug)) return null;
  return '/blog/' + slug;
}

function scrollToPickCard(home, away) {
  // Si estamos en home, navegar vía hash a picks (así gbGoHome siempre funciona)
  if (document.body.dataset.gbpage !== 'picks') {
    window.location.hash = 'picks'; // dispara hashchange → gbSetPage('picks')
    setTimeout(function() { _doScrollToPickCard(home, away); }, 250);
  } else {
    _doScrollToPickCard(home, away);
  }
}
function _doScrollToPickCard(home, away) {
  const id = 'predcard-' + (home + '-' + away).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // Flash dorado para resaltar la card
  const prev = el.style.outline;
  el.style.transition = 'outline 0.1s, box-shadow 0.1s';
  el.style.outline = '2px solid rgba(255,214,0,0.9)';
  el.style.boxShadow = '0 0 32px rgba(255,214,0,0.4), 0 4px 24px rgba(0,0,0,0.5)';
  setTimeout(function() {
    el.style.outline = prev;
    el.style.boxShadow = '';
  }, 1600);
}

// ── Abrir foro en el hilo del pick ──
window.openPickForum = async function(home, away, pickData) {
  // Abrir panel del foro
  if (typeof toggleForum === 'function' && !_fpOpen) toggleForum();
  // Buscar thread existente en lista cargada
  const find = () => (_fpAllThreads || []).find(t =>
    (typeof teamsMatch === 'function' ? teamsMatch(t.home, home) && teamsMatch(t.away, away)
      : t.home === home && t.away === away)
  );
  let thread = find();
  if (thread) {
    setTimeout(() => _fpOpenThread(thread), 150);
    return;
  }
  // Si viene pickData, crear hilo y abrirlo
  if (pickData && typeof forumEnsureThread === 'function') {
    await forumEnsureThread(pickData);
    // Refrescar lista de threads
    if (typeof _fpFetchThreads === 'function') await _fpFetchThreads();
    thread = find();
    if (thread) setTimeout(() => _fpOpenThread(thread), 150);
  }
};

// ── Like de usuario: localStorage con clave diaria ──
function _pickLikeKey() {
  return 'gb_plikes_' + new Date().toISOString().slice(0, 10);
}
function _isPickLiked(idx) {
  try { return !!(JSON.parse(localStorage.getItem(_pickLikeKey()) || '{}')[idx]); } catch(e) { return false; }
}
function togglePickLike(idx, total) {
  const key = _pickLikeKey();
  let liked;
  try { liked = JSON.parse(localStorage.getItem(key) || '{}'); } catch(e) { liked = {}; }
  const wasLiked = !!liked[idx];
  if (wasLiked) {
    delete liked[idx];
  } else {
    liked[idx] = 1;
  }
  try { localStorage.setItem(key, JSON.stringify(liked)); } catch(e) {}
  // Actualizar UI
  const btn = document.getElementById('plbtn-' + idx);
  const cnt = document.getElementById('plikes-' + idx);
  const base = _getFakeLikes(idx, total);
  const nowLiked = !wasLiked;
  if (btn) btn.classList.toggle('liked', nowLiked);
  if (cnt) cnt.textContent = String(base + (nowLiked ? 1 : 0));
}

// ── Likes simulados: base 1 + 3 cards aleatorias cada 6hs ──
function _getFakeLikes(idx, total) {
  if (total <= 0) return 1;
  let count = 1; // todas nacen con 1 like
  // Períodos de 6hs transcurridos desde medianoche de hoy
  const now = Date.now();
  const midnight = new Date(); midnight.setHours(0,0,0,0);
  const periods = Math.floor((now - midnight.getTime()) / (6 * 3600 * 1000));
  for (let p = 0; p < periods; p++) {
    // 3 índices determinísticos por período (distintos primos para dispersión)
    const a = (p * 97  + 3)  % total;
    const b = (p * 131 + 11) % total;
    const c = (p * 173 + 17) % total;
    if (idx === a || idx === b || idx === c) count++;
  }
  return count;
}

// ── Actualizar contadores de likes en las action rows tras render ──
function _updatePickLikeCounts(source) {
  source = source || window._aiPreds || [];
  const total  = source.length;
  source.forEach((p, idx) => {
    const el = document.getElementById('plikes-' + idx);
    if (!el) return;
    // Likes reales del foro (si los hay)
    const _fpt = (typeof _fpAllThreads !== 'undefined' ? _fpAllThreads : []);
    const thread = _fpt.find(t =>
      (typeof teamsMatch === 'function'
        ? teamsMatch(t.home, p.home) && teamsMatch(t.away, p.away)
        : t.home === p.home && t.away === p.away)
    );
    const realLikes = thread
      ? Object.values(window._fpReactions || {}).filter(r =>
          r && r.thread_id === thread.id && r.reaction_type === 'like'
        ).length
      : 0;
    // Total: simulados + reales
    el.textContent = String(_getFakeLikes(idx, total) + realLikes);
  });
}

// ═══════════════════════════════════════════════
//  WORKER — DATOS REALES
// ═══════════════════════════════════════════════
const WORKER_URL = 'https://apuestas-api.mauro-union10.workers.dev';

// 🆕 (27-may-2026) Cup context — pre-fetch para overrides de picks de fase de grupos Conmebol
(function loadCupContext() {
  try {
    const cached = localStorage.getItem('gb_cup_ctx_v1');
    if (cached) {
      const obj = JSON.parse(cached);
      if (obj && obj.ts && (Date.now() - obj.ts) < 6 * 3600 * 1000) {
        window._cupContext = obj.data || {};
      }
    }
  } catch (e) {}
  fetch(WORKER_URL + '/cup-context', { cache: 'default' })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data && typeof data === 'object') {
        window._cupContext = data;
        try { localStorage.setItem('gb_cup_ctx_v1', JSON.stringify({ ts: Date.now(), data: data })); } catch(e) {}
        const n = Object.keys(data).length;
        if (n > 0) console.log(`[cup-ctx] ${n} override(s) cargados.`);
      }
    })
    .catch(e => console.log('[cup-ctx] fetch err:', e && e.message));
})();

// 🆕 (29-may-2026) League context UNIVERSAL — detecta asimetría de motivación
// (equipo sin nada en juego vs equipo jugándose la vida) en ligas regulares (no solo cup).
(function loadLeagueContext() {
  try {
    const cached = localStorage.getItem('gb_league_ctx_v1');
    if (cached) {
      const obj = JSON.parse(cached);
      if (obj && obj.ts && (Date.now() - obj.ts) < 12 * 3600 * 1000) {
        window._leagueContext = obj.data || {};
      }
    }
  } catch (e) {}
  fetch(WORKER_URL + '/league-context', { cache: 'default' })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data && typeof data === 'object') {
        window._leagueContext = data;
        try { localStorage.setItem('gb_league_ctx_v1', JSON.stringify({ ts: Date.now(), data: data })); } catch(e) {}
        const n = Object.keys(data).length;
        if (n > 0) console.log(`[league-ctx] ${n} asimetría(s) de motivación detectadas.`);
      }
    })
    .catch(e => console.log('[league-ctx] fetch err:', e && e.message));
})();


const teamShortNames = {
  'Brighton and Hove Albion': 'Brighton',
  'Brighton & Hove Albion':   'Brighton',
  'Wolverhampton Wanderers':  'Wolverhampton',
  'Newcastle United':         'Newcastle',
  'Manchester United':        'Man United',
  'Manchester City':          'Man City',
  'Nottingham Forest':        'Nott\'m Forest',
  'West Ham United':          'West Ham',
  'Tottenham Hotspur':        'Tottenham',
  'Leicester City':           'Leicester',
  'AFC Bournemouth':          'Bournemouth',
  'Atletico Madrid':          'Atlético Madrid',
  'Paris Saint-Germain':      'PSG',
  'Paris Saint Germain':      'PSG',
  'Olympique Lyonnais':       'Lyon',
  'Olympique de Marseille':   'Marseille',
  'Borussia Dortmund':        'Dortmund',
  'FC Bayern München':        'Bayern Munich',
  'Eintracht Frankfurt':      'Frankfurt',
  'Bayer Leverkusen':         'Leverkusen',
  // Alemania
  '1. FC Köln':               'Koln', 'FC Cologne': 'Koln', 'Köln': 'Koln',
  'Borussia Mönchengladbach': 'Borussia Mon.', 'Borussia Monchengladbach': 'Borussia Mon.',
  'VfL Wolfsburg':            'Wolfsburg',
  'Hamburger SV':             'Hamburgo', 'HSV': 'Hamburgo', 'Hamburg': 'Hamburgo', 'Hamburg SV': 'Hamburgo',
  'FSV Mainz 05':             'Mainz', '1. FSV Mainz 05': 'Mainz', 'Mainz 05': 'Mainz',
  'VfB Stuttgart':            'Stuttgart',
  '1. FC Heidenheim 1846':    'Heidenheim', '1. FC Heidenheim': 'Heidenheim',
  'FC St. Pauli':             'St. Pauli', 'SC Freiburg': 'Freiburg',
  // Gimnasia
  'Gimnasia Mendoza':         'Gimnasia M', 'Gimnasia y Esgrima Mendoza': 'Gimnasia M', 'Gimnasia (Mendoza)': 'Gimnasia M',
  'Gimnasia de La Plata':     'Gimnasia LP', 'Gimnasia y Esgrima La Plata': 'Gimnasia LP',
  'Gimnasia y Esgrima de La Plata': 'Gimnasia LP', 'Gimnasia La Plata': 'Gimnasia LP',
  // Estudiantes
  'Estudiantes de La Plata':  'Estudiantes LP', 'Estudiantes La Plata': 'Estudiantes LP',
  'Estudiantes de Río Cuarto':'Estudiantes RC', 'Estudiantes de Rio Cuarto': 'Estudiantes RC',
  'Estudiantes Rio Cuarto':   'Estudiantes RC',
  // Argentina
  'Belgrano de Córdoba':      'Belgrano', 'CA Belgrano': 'Belgrano',
  'Instituto de Córdoba':     'Instituto', 'Instituto AC': 'Instituto',
  'Argentinos Juniors':       'Argentinos Jrs',
  'Sarmiento de Junin':       'Sarmiento', 'Sarmiento de Junín': 'Sarmiento', 'CA Sarmiento': 'Sarmiento',
  'Aldosivi de Mar del Plata':'Aldosivi',
  'Independiente Rivadavia':  'Independiente R',
  // Francia
  'Stade Rennais':            'Rennes', 'Stade Rennais FC': 'Rennes', 'Rennais': 'Rennes',
  'Paris FC':                 'Paris', 'Paris Saint-Germain': 'PSG', 'Paris Saint Germain': 'PSG',
  'AJ Auxerre':               'Auxerre', 'AS Saint-Étienne': 'Saint-Étienne', 'Stade de Reims': 'Reims',
  'Le Havre AC':              'Le Havre', 'AS Monaco': 'Monaco', 'Stade Brestois 29': 'Brest',
  // Otros nombres largos que se truncaban
  '1. FC Kaiserslautern':     'Kaiserslautern', 'FC Kaiserslautern': 'Kaiserslautern',
  'Independiente Santa Fe':   'Ind. Santa Fe', 'Santa Fe': 'Ind. Santa Fe',
  'New England Revolution':   'New England', 'CF Montréal': 'CF Montréal',
  'Paris Saint-Germain':      'PSG', 'Paris Saint Germain': 'PSG',
  // Polonia (nombres largos → corto)
  'Jagiellonia Białystok':    'Jagiellonia', 'Jagiellonia Bialystok': 'Jagiellonia',
  'Raków Częstochowa':        'Raków', 'Rakow Czestochowa': 'Raków',
  'Pogoń Szczecin':           'Pogoń', 'Pogon Szczecin': 'Pogoń',
  'Górnik Zabrze':            'Górnik', 'Gornik Zabrze': 'Górnik',
  'Widzew Łódź':              'Widzew', 'Widzew Lodz': 'Widzew',
  'Zagłębie Lubin':           'Zagłębie', 'Zaglebie Lubin': 'Zagłębie',
  'Lechia Gdańsk':            'Lechia', 'Lechia Gdansk': 'Lechia',
  'Termalica Nieciecza':      'Termalica',
  'Bruk-Bet Termalica Nieciecza': 'Termalica',
  'Bruk-Bet Termalica':       'Termalica',
  'Bruk-Bet Nieciecza':       'Termalica',
  'Nieciecza':                'Termalica',
  'Radomiak Radom':           'Radomiak',
  'Korona Kielce':            'Korona',
  'Stal Mielec':              'Stal Mielec',
  'Motor Lublin':             'Motor',
  'Legia Warszawa':           'Legia', 'Legia Warsaw': 'Legia',
  'Wisła Kraków':             'Wisła', 'Wisla Krakow': 'Wisła',
  'KKS Lech Poznań':          'Lech Poznań', 'KKS Lech Poznan': 'Lech Poznań',
  'Cracovia':                 'Cracovia', 'MKS Cracovia': 'Cracovia',
  // Grecia
  'Larissa FC':               'AEL', 'AEL Larissa': 'AEL', 'Larissa': 'AEL', 'AEL FC': 'AEL',
  'Asteras Tripoli':          'Asteras Tripolis', 'Asteras Tripolis FC': 'Asteras Tripolis',
  'Olympiakos Piraeus':       'Olympiakos', 'Olympiacos': 'Olympiakos', 'Olympiacos FC': 'Olympiakos',
  'PAOK Thessaloniki':        'PAOK', 'PAOK Salonika': 'PAOK', 'PAOK FC': 'PAOK',
  'AEK Athens FC':            'AEK', 'AEK Athens': 'AEK',
  'Panathinaikos FC':         'Panathinaikos',
  // España
  'CA Osasuna':               'Osasuna', 'Elche CF': 'Elche',
  'Racing Santander':         'Racing (S)', 'Racing de Santander': 'Racing (S)', 'Real Racing Club': 'Racing (S)',
  'Real Racing Club de Santander': 'Racing (S)', 'Racing Club de Santander': 'Racing (S)',
  'Racing Club Santander':    'Racing (S)', 'RC Racing': 'Racing (S)', 'RC Racing Club': 'Racing (S)',
  'Real Racing Club…':        'Racing (S)', // nombre truncado guardado en historial
  'SD Eibar':                 'Eibar',     'Eibar': 'Eibar',
  'SD Huesca':                'Huesca',    'Huesca': 'Huesca',
  'Sporting de Gijón':        'Sporting G.', 'Sporting Gijón': 'Sporting G.',
  'Cultural y Deportiva Leonesa': 'C. Leonesa', 'Cultural Leonesa': 'C. Leonesa',
  'Deportivo de La Coruña':   'Deportivo',  'Deportivo La Coruña': 'Deportivo', 'RC Deportivo': 'Deportivo',
  'Albacete Balompié':        'Albacete',
  'AD Ceuta FC':              'Ceuta',      'AD Ceuta': 'Ceuta',
  'Real Zaragoza':            'Zaragoza',
  // Brasil
  'Atletico Paranaense':      'At. Paranaense', 'Athletico Paranaense': 'At. Paranaense',
  'Club Athletico Paranaense':'At. Paranaense',
  // Inglaterra
  'Leeds United':             'Leeds',
  'San Lorenzo de Almagro':   'San Lorenzo',
  'Vélez Sársfield':          'Vélez',
  'Velez Sarsfield BA':       'Vélez',
  'Sport Club Internacional': 'Internacional',
  'SE Palmeiras':             'Palmeiras',
  'CR Flamengo':              'Flamengo',
  'AS Monaco':                'Monaco',
  'AS Monaco FC':             'Monaco',
  'Stade Brestois 29':        'Brest',
  'Stade Brest':              'Brest',
  'RC Lens':                  'Lens',
  'Olympique Lyonnais':       'Lyon',
  'LOSC Lille':               'Lille',
  'RC Strasbourg Alsace':     'Strasbourg',
  'Stade de Reims':           'Reims',
  'Stade Rennais FC':         'Rennes',
  'AJ Auxerre':               'Auxerre',
  'Montpellier HSC':          'Montpellier',
  'Le Havre AC':              'Le Havre',
  'FC Nantes':                'Nantes',
  'OGC Nice':                 'Nice',
  'Girondins de Bordeaux':    'Bordeaux',
  'Toulouse FC':              'Toulouse',
  'Angers SCO':               'Angers',
  // Inglaterra - FC
  'Arsenal FC':               'Arsenal', 'Chelsea FC': 'Chelsea', 'Burnley FC': 'Burnley',
  'Celtic FC':                'Celtic', 'Rangers FC': 'Rangers',
  // Italia - FC
  'Torino FC':                'Torino', 'Bologna FC': 'Bologna', 'Empoli FC': 'Empoli',
  // España - CF/FC
  'Valencia CF':              'Valencia', 'Villarreal CF': 'Villarreal', 'Getafe CF': 'Getafe',
  'Cádiz CF':                 'Cádiz', 'Cadiz CF': 'Cádiz', 'Granada CF': 'Granada',
  'Real Valladolid CF':       'Valladolid', 'Girona FC': 'Girona', 'Athletic Club': 'Athletic',
  // Argentina - de [ciudad]
  'Talleres de Córdoba':      'Talleres', 'Jaguares de Córdoba': 'Jaguares',
  'Belgrano de Cordoba':      'Belgrano', 'Instituto de Cordoba': 'Instituto',
  'Aldosivi Mar del Plata':   'Aldosivi', 'Godoy Cruz Antonio Tomba': 'Godoy Cruz',
  // Brasil
  'Coritiba FC':              'Coritiba', 'Mirassol FC': 'Mirassol', 'Avaí FC': 'Avaí',
  // MLS — shortName controlado para evitar truncado o pérdida de suffix
  'Inter Miami CF':           'Inter Miami',
  'Los Angeles FC':           'LAFC',
  'Seattle Sounders FC':      'Seattle',
  'New England Revolution':   'New England',
  'New York City FC':         'NYCFC',
  'San Jose Earthquakes':     'San Jose',
  'Vancouver Whitecaps FC':   'Vancouver',
  'Nashville SC':             'Nashville SC',
  'Austin FC':                'Austin FC',
  'Charlotte FC':             'Charlotte FC',
  'St. Louis City SC':        'St. Louis City SC',
  'FC Cincinnati':            'FC Cincinnati',
  'Columbus Crew SC':         'Columbus Crew',
  'Toronto FC':               'Toronto FC',
  'Sporting Kansas City':     'Sporting KC',
  'Atlanta United FC':        'Atlanta United',
  'Chicago Fire FC':          'Chicago Fire',
  'Houston Dynamo FC':        'Houston Dynamo',
  'Minnesota United FC':      'Minnesota United',
  'Orlando City SC':          'Orlando City',
  'Portland Timbers':         'Portland Timbers',
  'Philadelphia Union':       'Philadelphia Union',
  // Alemania
  '1. FC Union Berlin':       'Union Berlin',
  // Otros
  'Liverpool FC Uruguay':     'Liverpool UY', 'Caracas FC': 'Caracas',
  // Argentina
  'Deportivo Riestra':        'Riestra',
  'Newells Old Boys':         "Newell's",
  'Central Córdoba':          'C. Córdoba',
  'Universidad Católica':     'U. Católica',
  'CD Universidad Católica':  'U. Católica',
  'Universidad Católica de Chile': 'U. Católica',
  'Universidad Católica (CHI)': 'U. Católica',
  'U Católica':               'U. Católica',
  'Universidad Catól…':       'U. Católica', // nombre truncado del historial antiguo
  'Universidad Cató…':        'U. Católica', // variante de truncado
  'Universidad Cat…':         'U. Católica',
  'Atlético San Luis':        'Atl. San Luis',
  'Atletico San Luis':        'Atl. San Luis',
  'Atlético de San Luis':     'Atl. San Luis',
  'Atletico de San Luis':     'Atl. San Luis',
  'Coquimbo Unido':           'Coquimbo',
  // Copa Libertadores – prefijos "Club" y variantes de nombre API
  'Club Bolívar':             'Bolívar',
  'Club Always Ready':        'Always Ready',
  'Club Universitario de Deportes': 'Universitario',
  'Club Universitario':       'Universitario',
  'Club Cienciano':           'Cienciano',
  'Club Independiente Petrolero': 'Ind. Petrolero',
  'Club Olimpia':             'Olimpia',
  // Brasileños con sufijo de ciudad
  'Fluminense-RJ':            'Fluminense',
  'Flamengo-RJ':              'Flamengo',
  'Palmeiras-SP':             'Palmeiras',
  'Corinthians-SP':           'Corinthians',
  'Bragantino-SP':            'Bragantino',
  'Clube Atlético Mineiro':   'Atl. Mineiro',
  // Con ciudad en el nombre
  'Libertad Asuncion':        'Libertad',
  'Libertad Asunción':        'Libertad',
  'Peñarol Montevideo':       'Peñarol',
  'Nacional de Montevideo':   'Nacional',
  'Olimpia Asunción':         'Olimpia',
  'Olimpia Asuncion':         'Olimpia',
  'Junior FC':                'Junior',
  'CA Boston River':          'Boston River',
  'CA Juventud':              'Juventud',
  'CA Tigre BA':              'Tigre',
  'Montevideo City Torque':   'City Torque',
  'C.D. Cuenca':              'Cuenca',
  'UCV FC':                   'UCV',
  // Nombres regionales / abreviados
  'Alianza Atlético':         'Alianza Atl.',
  'Deportes Tolima':          'Dep. Tolima',
  'Deportivo La Guaira':      'Dep. La Guaira',
  'Deportivo Pereira':        'Riestra', // API usa este nombre para Deportivo Riestra
  'LDU Quito':                'Liga de Quito',
  'Atalanta BC':              'Atalanta',
  'Universidad de Concepción': 'U. de Concepción',
  'Sporting Lisbon':          'Sporting Lisboa',
  'Sporting CP':              'Sporting Lisboa',
  'Independiente del Valle':  'Ind. del Valle',
  'Independiente Medellín':   'Ind. Medellín',
  'Independiente Medellin':   'Ind. Medellín',
  'FC Juárez':                'Juárez',
  'Juárez FC':                'Juárez',
  'Besiktas JK':              'Besiktas',
  'Beşiktaş JK':              'Besiktas',
  'Inter Milan':              'Inter',
  'FC Internazionale':        'Inter',
  'Internazionale':           'Inter',
  'Atlético Huracán':         'Huracán',
  'Twente Enschede':          'Twente',
  'FC Twente Enschede':       'Twente',
  // ── Migrado desde shortName1.abbrevs (consolidación 14-may-2026) ──
  'Atlanta United': 'Atlanta',
  'Atlético de Madrid': 'Atlético',
  'CF Montreal': 'Montreal',
  'Chicago Fire': 'Chicago Fire',
  'Colorado Rapids': 'Colorado',
  'Columbus Crew': 'Columbus',
  'D.C. United': 'DC United',
  'DC United': 'DC United',
  'FC Dallas': 'Dallas',
  'GKS Katowice': 'GKS Katowice',
  'Houston Dynamo': 'Houston',
  'Kansas City': 'Sporting KC',
  'LA FC': 'LAFC',
  'LA Galaxy': 'LA Galaxy',
  'Lech Poznan': 'Lech Poznań',
  'Lech Poznań': 'Lech Poznań',
  'Los Angeles Galaxy': 'LA Galaxy',
  'Minnesota United': 'Minnesota',
  'New York City': 'NYCFC',
  'New York Red Bulls': 'NY Red Bulls',
  'New York Red Bulls II': 'NY Red Bulls',
  'Orlando City': 'Orlando',
  'Piast Gliwice': 'Piast',
  'RB Leipzig': 'Leipzig',
  'Real Salt Lake': 'Real Salt Lake',
  'San Diego FC': 'San Diego',
  'Seattle Sounders': 'Seattle',
  'Vancouver Whitecaps': 'Vancouver',
};
// ── Mapeo de selecciones Mundial 2026: inglés → español (Odds API usa nombres en inglés) ──
const WC_TEAM_ES_NAMES = {
  'Belgium': 'Bélgica', 'Spain': 'España', 'France': 'Francia', 'Germany': 'Alemania',
  'England': 'Inglaterra', 'Portugal': 'Portugal', 'Italy': 'Italia', 'Netherlands': 'Países Bajos',
  'Switzerland': 'Suiza', 'Austria': 'Austria', 'Croatia': 'Croacia', 'Norway': 'Noruega',
  'Sweden': 'Suecia', 'Denmark': 'Dinamarca', 'Poland': 'Polonia',
  'Brazil': 'Brasil', 'Argentina': 'Argentina', 'Uruguay': 'Uruguay', 'Colombia': 'Colombia',
  'Ecuador': 'Ecuador', 'Paraguay': 'Paraguay', 'Mexico': 'México', 'Canada': 'Canadá',
  'United States': 'Estados Unidos', 'USA': 'Estados Unidos', 'Costa Rica': 'Costa Rica',
  'Japan': 'Japón', 'South Korea': 'Corea del Sur', 'Korea Republic': 'Corea del Sur',
  'Iran': 'Irán', 'Iraq': 'Irak', 'Saudi Arabia': 'Arabia Saudita',
  'Australia': 'Australia', 'New Zealand': 'Nueva Zelanda', 'Qatar': 'Catar',
  'Morocco': 'Marruecos', 'Senegal': 'Senegal', 'Algeria': 'Argelia', 'Tunisia': 'Túnez',
  'Egypt': 'Egipto', 'Ivory Coast': 'Costa de Marfil', "Cote d'Ivoire": 'Costa de Marfil',
  'Cape Verde': 'Cabo Verde', 'South Africa': 'Sudáfrica', 'DR Congo': 'RD Congo',
  'Democratic Republic of Congo': 'RD Congo', 'Congo DR': 'RD Congo', 'Ghana': 'Ghana',
  'Nigeria': 'Nigeria', 'Cameroon': 'Camerún', 'Curacao': 'Curaçao', 'Curaçao': 'Curaçao',
  'Bosnia and Herzegovina': 'Bosnia', 'Bosnia & Herzegovina': 'Bosnia', 'Bosnia': 'Bosnia',
  'Czech Republic': 'República Checa', 'Czechia': 'República Checa',
  'Turkey': 'Turquía', 'Türkiye': 'Turquía', 'Russia': 'Rusia', 'Ukraine': 'Ucrania',
  'Haiti': 'Haití', 'Scotland': 'Escocia', 'Wales': 'Gales', 'Ireland': 'Irlanda',
  'Republic of Ireland': 'Irlanda', 'Jordan': 'Jordania', 'Uzbekistan': 'Uzbekistán',
  'Panama': 'Panamá', 'Honduras': 'Honduras', 'Jamaica': 'Jamaica',
};
function translateWcTeam(name) {
  if (!name) return name;
  return WC_TEAM_ES_NAMES[name] || WC_TEAM_ES_NAMES[name.trim()] || name;
}

function shortName(name) {
  if (!name) return '';
  // Primero traducir si es una selección WC con nombre en inglés
  const _trans = translateWcTeam(name);
  if (_trans !== name) name = _trans;
  if (teamShortNames[name]) return teamShortNames[name];
  // Si el nombre tiene "…" al final (truncado al guardarse), buscar en el mapa por prefijo
  if (name.endsWith('…') || name.endsWith('...')) {
    const prefix = name.replace(/…$|\.{3}$/, '').trim();
    const matchKey = Object.keys(teamShortNames).find(k => k.startsWith(prefix));
    if (matchKey) return teamShortNames[matchKey];
    // También probar sin sufijo FC/etc
    const matchKey2 = Object.keys(teamShortNames).find(k => k.replace(/\s+(FC|SC|AC|CF)$/i,'').startsWith(prefix));
    if (matchKey2) return teamShortNames[matchKey2];
  }
  // Quitar sufijos comunes al final del nombre
  let stripped = name
    .replace(/\s+(FC|CF|SC|AC|AFC|SFC|RFC|IF|IFK|FK|SK|BK|NK|GNK|BSC|SV|AG|JK|BC)\s*$/i, '')
    .replace(/\s+Calcio\s*(\d{4})?\s*$/i, '')
    .trim();
  // Quitar prefijos comunes al inicio del nombre
  stripped = stripped
    .replace(/^(FC|CF|SC|AC|AFC|SFC|RFC|FK|SK|NK|GNK|RB|RC|RCD|AS|CD|SD|UD|CA|CE|SL|US|SS|CS|RS|SK)\s+/i, '')
    .trim();
  const result = stripped !== name ? stripped : name;
  return result.length > 18 ? result.slice(0,16) + '…' : result;
}

function leagueLabel(sportTitle) {
  if (!sportTitle) return '';
  const t = sportTitle;
  if (t.includes('Argentine') || t.includes('Argentina')) return '🇦🇷';
  if (t.includes('Champions'))    return '⭐';
  if (t.includes('Libertadores')) return '🌎';
  if (t.includes('Sudamericana')) return '🌎';
  if (t.includes('Europa League')) return '🟠';
  if (t.includes('Conference'))   return '🟢';
  if (t.includes('Premier') || t.includes('EPL')) return '🏴󠁧󠁢󠁥󠁮󠁧󠁿';
  if (t.includes('La Liga') || t.includes('Spain')) return '🇪🇸';
  if (t.includes('Serie A') || t.includes('Italy')) return '🇮🇹';
  if (t.includes('Bundesliga') || t.includes('Germany')) return '🇩🇪';
  if (t.includes('Ligue 1') || t.includes('France')) return '🇫🇷';
  if (t.includes('Brazil') || t.includes('Brasil')) return '🇧🇷';
  if (t.includes('MLS') || t.includes('Major League Soccer')) return '🇺🇸';
  if (t.includes('Liga MX') || t.includes('Mexico')) return '🇲🇽';
  if (t.includes('ATP') || t.includes('WTA') || t.includes('Open') || t.includes('Wimbledon')) return '🎾';
  return '';
}

// ══════════════════════════════════════════════
// INTERNACIONALIZACIÓN (i18n)
// ══════════════════════════════════════════════
const LANGS = {
  es: {
    'nav.scores':'Marcadores','nav.pred':'Pronósticos','nav.calc':'Calculadora',
    'nav.stats':'Stats','nav.hist':'Resultados','nav.cuotas':'Cuotas',
    'nav.bankroll':'Bankroll','auth.enter':'Entrar','auth.register':'Registro Gratis',
    'tab.all':'Todos','tab.futbol':'Fútbol',
    'tab.tenis':'Tenis','tab.rugby':'Rugby','tab.ufc':'UFC',
    'status.live':'● EN VIVO','status.soon':'⚡ COMIENZA PRONTO','status.upcoming':'PRÓXIMO','status.final':'FINALIZADO',
    'time.live':'En vivo','time.final':'Final',
    'time.today':'Hoy','time.tomorrow':'Mañ.','time.yesterday':'Ayer',
    'empty.games':'No hay partidos programados para hoy',
    'tg.badge':'CANAL GRATUITO','tg.join':'Unirse al canal GRATIS',
    'tg.footer':'SIN COSTO · SIN REGISTRO · SOLO ANÁLISIS',
    'ch.rugby.nombre':'Apuestas de Rugby','ch.rugby.subs':'+1.900 suscriptores',
    'ch.rugby.desc':'Análisis, picks y pronósticos de Super Rugby, Six Nations, NRL y más. La comunidad de Apuestas de Rugby más grande habla-hispana.',
    'ch.rugby.tip':'Último tip: <strong>Francia gana con bonus vs Irlanda</strong> — EASY WIN ✅✅✅',
    'ch.tenis.nombre':'Apuestas de Tenis','ch.tenis.subs':'+2.400 suscriptores',
    'ch.tenis.desc':'Picks y análisis de ATP y WTA. Grand Slams, Masters 1000 y más torneos cubiertos diariamente.',
    'ch.tenis.tip':'Último tip: <strong>Alcaraz gana en sets corridos vs Zverev</strong> — EASY WIN ✅✅✅',
    'ch.ufc.nombre':'Apuestas de UFC','ch.ufc.subs':'+530 suscriptores',
    'ch.ufc.desc':'Análisis de peleas, pronósticos y picks de UFC y boxeo profesional. La comunidad de MMA más grande habla-hispana.',
    'ch.ufc.tip':'Último tip: <strong>Islam Makhachev por decisión unánime</strong> — EASY WIN ✅✅✅',
  },
  en: {
    'nav.scores':'Scores','nav.pred':'Forecasts','nav.calc':'Calculator',
    'nav.stats':'Stats','nav.hist':'Results','nav.cuotas':'Odds',
    'nav.bankroll':'Bankroll','auth.enter':'Login','auth.register':'Free Sign Up',
    'tab.all':'All','tab.futbol':'Football',
    'tab.tenis':'Tennis','tab.rugby':'Rugby','tab.ufc':'UFC',
    'status.live':'● LIVE','status.soon':'⚡ STARTING SOON','status.upcoming':'UPCOMING','status.final':'FINISHED',
    'time.live':'Live','time.final':'Final',
    'time.today':'Today','time.tomorrow':'Tomorrow','time.yesterday':'Yesterday',
    'empty.games':'No matches scheduled for today',
    'tg.badge':'FREE CHANNEL','tg.join':'Join Channel FREE',
    'tg.footer':'NO COST · NO REGISTRATION · ANALYSIS ONLY',
    'ch.rugby.nombre':'Rugby Betting','ch.rugby.subs':'+1,900 subscribers',
    'ch.rugby.desc':'Analysis, picks and forecasts for Super Rugby, Six Nations, NRL and more. The biggest Spanish-speaking Rugby Betting community.',
    'ch.rugby.tip':'Latest tip: <strong>France wins with bonus vs Ireland</strong> — EASY WIN ✅✅✅',
    'ch.tenis.nombre':'Tennis Betting','ch.tenis.subs':'+2,400 subscribers',
    'ch.tenis.desc':'ATP & WTA picks and analysis. Grand Slams, Masters 1000 and more tournaments covered daily.',
    'ch.tenis.tip':'Latest tip: <strong>Alcaraz wins in straight sets vs Zverev</strong> — EASY WIN ✅✅✅',
    'ch.ufc.nombre':'UFC Betting','ch.ufc.subs':'+530 subscribers',
    'ch.ufc.desc':'Fight analysis, predictions and picks for UFC and professional boxing. The biggest Spanish-speaking MMA community.',
    'ch.ufc.tip':'Latest tip: <strong>Islam Makhachev by unanimous decision</strong> — EASY WIN ✅✅✅',
  },
  pt: {
    'nav.scores':'Placar','nav.pred':'Prognósticos','nav.calc':'Calculadora',
    'nav.stats':'Stats','nav.hist':'Resultados','nav.cuotas':'Odds',
    'nav.bankroll':'Bankroll','auth.enter':'Entrar','auth.register':'Registro Grátis',
    'tab.all':'Todos','tab.futbol':'Futebol',
    'tab.tenis':'Tênis','tab.rugby':'Rugby','tab.ufc':'UFC',
    'status.live':'● AO VIVO','status.soon':'⚡ COMEÇA EM BREVE','status.upcoming':'PRÓXIMO','status.final':'FINALIZADO',
    'time.live':'Ao vivo','time.final':'Final',
    'time.today':'Hoje','time.tomorrow':'Amanhã','time.yesterday':'Ontem',
    'empty.games':'Nenhuma partida agendada para hoje',
    'tg.badge':'CANAL GRATUITO','tg.join':'Entrar no canal GRÁTIS',
    'tg.footer':'SEM CUSTO · SEM CADASTRO · SÓ ANÁLISES',
    'ch.rugby.nombre':'Apostas de Rugby','ch.rugby.subs':'+1.900 assinantes',
    'ch.rugby.desc':'Análises, picks e previsões de Super Rugby, Six Nations, NRL e mais. A maior comunidade de Apostas de Rugby de língua hispânica.',
    'ch.rugby.tip':'Última dica: <strong>França vence com bônus vs Irlanda</strong> — EASY WIN ✅✅✅',
    'ch.tenis.nombre':'Apostas de Tênis','ch.tenis.subs':'+2.400 assinantes',
    'ch.tenis.desc':'Picks e análises de ATP e WTA. Grand Slams, Masters 1000 e mais torneios cobertos diariamente.',
    'ch.tenis.tip':'Última dica: <strong>Alcaraz vence em sets diretos vs Zverev</strong> — EASY WIN ✅✅✅',
    'ch.ufc.nombre':'Apostas de UFC','ch.ufc.subs':'+530 assinantes',
    'ch.ufc.desc':'Análise de lutas, previsões e picks de UFC e boxe profissional. A maior comunidade de MMA de língua hispânica.',
    'ch.ufc.tip':'Última dica: <strong>Islam Makhachev por decisão unânime</strong> — EASY WIN ✅✅✅',
  },
};

let currentLang = 'es';

function T(key) {
  return (LANGS[currentLang] || LANGS.es)[key] || LANGS.es[key] || key;
}

function detectLang() {
  const saved = localStorage.getItem('aa_lang');
  if (saved && LANGS[saved]) return saved;
  // Por defecto siempre español, salvo que el usuario lo cambie manualmente
  const bl = (navigator.language || 'es').toLowerCase();
  if (bl.startsWith('pt')) return 'pt';
  return 'es';
}

function setLang(lang) {
  if (!LANGS[lang]) return;
  currentLang = lang;
  localStorage.setItem('aa_lang', lang);
  document.documentElement.lang = lang;
  // Update static data-i18n elements
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = T(key);
  });
  // Update lang button with flag image
  const flagImgs = { es:'https://flagcdn.com/w40/es.png', en:'https://flagcdn.com/w40/us.png', pt:'https://flagcdn.com/w40/br.png' };
  const btn = document.getElementById('langBtn');
  if (btn) btn.style.backgroundImage = `url('${flagImgs[lang] || flagImgs.es}')`;
  // Highlight active option
  ['es','en','pt'].forEach(l => {
    const opt = document.getElementById('langOpt_' + l);
    if (opt) opt.classList.toggle('active', l === lang);
  });
  // Close dropdown
  const dd = document.getElementById('langDropdown');
  if (dd) dd.style.display = 'none';
  // Re-render dynamic sections
  renderScores(currentScoreFilter);
}

function toggleLangMenu(e) {
  e && e.stopPropagation();
  const dd = document.getElementById('langDropdown');
  if (dd) dd.style.display = dd.style.display === 'block' ? 'none' : 'block';
}

// Close lang dropdown on outside click
document.addEventListener('click', e => {
  const picker = document.getElementById('langPicker');
  if (picker && !picker.contains(e.target)) {
    const dd = document.getElementById('langDropdown');
    if (dd) dd.style.display = 'none';
  }
});

function matchTime(commence_time) {
  const d = new Date(commence_time);
  // Use visitor's local timezone automatically
  const locale = currentLang === 'pt' ? 'pt-BR' : currentLang === 'en' ? 'en-US' : 'es-AR';
  const timeStr = d.toLocaleTimeString(locale, { hour:'2-digit', minute:'2-digit', hour12: false });
  const dDay = new Date(d); dDay.setHours(0,0,0,0);
  const tDay = new Date();  tDay.setHours(0,0,0,0);
  const diffDays = Math.round((dDay - tDay) / 86400000);
  if (diffDays === 0) return `${T('time.today')} ${timeStr}`;
  if (diffDays === 1) return `${T('time.tomorrow')} ${timeStr}`;
  if (diffDays === -1) return `${T('time.yesterday')} ${timeStr}`;
  return d.toLocaleDateString(locale, { day:'2-digit', month:'2-digit' }) + ' ' + timeStr;
}

// ── API cache helpers (reduce credit usage) ──
const CACHE_ODDS_TTL   = 3 * 60 * 60 * 1000;  // 3 horas (local)
const CACHE_ODDS_SB_TTL = 3 * 60 * 60 * 1000; // 3 horas (Supabase compartida)
const CACHE_SCORES_TTL = 30 * 60 * 1000;  // 30 min
function cacheSet(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch(e) {}
}
function cacheGet(key, ttl) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > ttl) return null;
    return data;
  } catch(e) { return null; }
}

// Corrige commenceTs incorrectos en el historial (picks guardados con hora de guardado en lugar de hora del partido)
// Se llama una vez que _rawOddsGames está disponible.
function fixPendingHistCommenceTs() {
  if (!window._rawOddsGames?.length) return;
  const now = Date.now();
  const hist = loadHistorial();
  let fixed = 0;
  hist.forEach(h => {
    if (h.result !== 'pending') return;
    if (h.commenceTs && h.commenceTs > now) return; // ya es futuro, no necesita fix
    const match = window._rawOddsGames.find(g =>
      teamsMatch(g.home_team, h.home) && teamsMatch(g.away_team, h.away)
    );
    if (!match?.commence_time) return;
    const newTs = new Date(match.commence_time).getTime();
    if (newTs > now && newTs !== h.commenceTs) {
      h.commenceTs = newTs;
      fixed++;
    }
  });
  if (fixed > 0) {
    saveHistorial(hist);
    console.log(`[fixTs] Corregidos ${fixed} commenceTs en historial`);
    // Re-render historial si está visible (volver a página 1 para mostrar picks de hoy primero)
    const _histEl = document.getElementById('historial');
    if (_histEl && _histEl.offsetParent !== null && typeof renderHistorial === 'function') {
      setTimeout(() => { histPage = 0; renderHistorial(); }, 50);
    }
  }
}

let _oddsLoading = false;
let _loadFailed  = false;  // true cuando la API falló Y no hay stale data
let _autoRetryCount = 0;
const _MAX_AUTO_RETRY = 4;
function processOddsIntoComparador(data) {
  // Collect all bookmakers present in the response
  const bookMap = {};
  data.forEach(game => {
    game.bookmakers?.forEach(b => { bookMap[b.key] = b.title; });
  });
  const books = Object.keys(bookMap).slice(0, 5);
  if (books.length === 0) return;

  allBooks = books;
  featuredBooks = books.slice(0, 2);
  bookLabels = bookMap;

  // Filtrar: solo partidos de hoy (o próximas 24h si no hay de hoy)
  const nowTs = Date.now();
  const todayStart = new Date().setHours(0,0,0,0);
  const todayEnd   = todayStart + 86400000;
  let filtered = data.filter(g => {
    const t = new Date(g.commence_time).getTime();
    return t >= todayStart && t < todayEnd;
  });
  if (filtered.length === 0) {
    filtered = data.filter(g => new Date(g.commence_time).getTime() >= nowTs)
                   .sort((a,b) => new Date(a.commence_time) - new Date(b.commence_time))
                   .slice(0, 8);
  }
  const PRIO = {
    soccer_argentina_primera_division: 10,
    soccer_argentina_primera_nacional: 9,
    soccer_south_america_copa_libertadores: 8,
    soccer_conmebol_copa_libertadores: 8,
    soccer_south_america_copa_sudamericana: 7,
    soccer_conmebol_copa_sudamericana: 7,
    soccer_uefa_champs_league: 7,
    soccer_spain_la_liga: 6,
    soccer_epl: 6,
    soccer_england_premier_league: 6,
    soccer_brazil_campeonato: 5,
    soccer_italy_serie_a: 5,
    soccer_germany_bundesliga: 5,
    soccer_portugal_primeira_liga: 5,
    soccer_netherlands_eredivisie: 4,
    soccer_france_ligue_one: 4,
    soccer_uefa_europa_league: 4,
    soccer_scotland_premiership: 3,
    soccer_turkey_super_league: 3,
    soccer_uefa_europa_conference_league: 3,
    soccer_mexico_ligamx: 3,
    soccer_chile_campeonato: 2,
    soccer_uruguay_primera_division: 2,
    soccer_usa_mls: 2,
    soccer_saudi_professional_league: 2,
    soccer_japan_j_league: 2,
  };
  filtered.sort((a,b) => {
    const pa = PRIO[a.sport_key] || 1;
    const pb = PRIO[b.sport_key] || 1;
    if (pa !== pb) return pb - pa;
    return new Date(a.commence_time) - new Date(b.commence_time);
  });
  // Excluir partidos que casi seguro ya terminaron (iniciados hace más de 3h)
  const top8 = filtered
    .filter(g => new Date(g.commence_time).getTime() > nowTs - 3 * 3600000)
    .slice(0, 8);

  const fixedKeys = FIXED_BOOKS.map(b => b.key);
  oddsData = top8.map(game => {
    const book = {};
    fixedKeys.forEach(bKey => {
      const bm = game.bookmakers?.find(b => b.key === bKey);
      const market = bm?.markets?.find(m => m.key === 'h2h');
      if (market) {
        const home = market.outcomes.find(o => o.name === game.home_team)?.price ?? null;
        const draw = market.outcomes.find(o => o.name === 'Draw')?.price ?? null;
        const away = market.outcomes.find(o => o.name === game.away_team)?.price ?? null;
        book[bKey] = [home, draw, away];
      }
    });
    const hasAnyFixed = fixedKeys.some(k => book[k]);
    if (!hasAnyFixed) {
      const apiBooks = (game.bookmakers || [])
        .filter(b => b.markets?.some(m => m.key === 'h2h'))
        .slice(0, 5);
      apiBooks.forEach((bm, idx) => {
        const targetKey = fixedKeys[idx];
        if (!targetKey) return;
        const market = bm.markets.find(m => m.key === 'h2h');
        const home = market.outcomes.find(o => o.name === game.home_team)?.price ?? null;
        const draw = market.outcomes.find(o => o.name === 'Draw')?.price ?? null;
        const away = market.outcomes.find(o => o.name === game.away_team)?.price ?? null;
        book[targetKey] = [home, draw, away];
      });
    }
    const commenceTs = new Date(game.commence_time).getTime();
    // "live" solo si empezó Y no hace más de 3h (no terminó)
    const isLive = commenceTs <= Date.now() && commenceTs > Date.now() - 3 * 3600000;
    return {
      match: `${shortName(game.home_team)} vs ${shortName(game.away_team)}`,
      homeRaw: game.home_team,
      awayRaw: game.away_team,
      league: leagueLabel(game.sport_title),
      time: matchTime(game.commence_time),
      commenceTs,
      tipo: 'Ganador',
      live: isLive,
      book
    };
  });

  const newOddsHash = JSON.stringify(oddsData.map(o => o.match));
  if (!window._lastOddsHash || window._lastOddsHash !== newOddsHash) {
    window._lastOddsHash = newOddsHash;
    console.log(`[Comparador] ${oddsData.length} cuotas cargadas`);
  }
}

function forceRefreshOdds() {
  // Limpiar caché (fresca y stale) y recargar desde el Worker
  localStorage.removeItem('cache_odds_v10');
  localStorage.removeItem('cache_odds_stale_v10');
  window._rawOddsGames = null;
  _oddsLoading = false;
  const statusBar = document.getElementById('predsStatusBar');
  if (statusBar) {
    statusBar.style.background = 'rgba(33,150,243,0.08)';
    statusBar.style.border = '1px solid rgba(33,150,243,0.3)';
    statusBar.style.color = '#42a5f5';
    statusBar.innerHTML = `<span>🔄 Conectando con el Worker...</span>`;
  }
  loadRealOdds();
}

// Carga cuotas — localStorage primero, luego Worker API directo (sin Supabase compartido)
async function loadRealOdds() {
  if (_oddsLoading) return;

  // 1) localStorage fresco → esperar lock global antes de renderizar (máx 4s)
  const localCached = cacheGet('cache_odds_v10', CACHE_ODDS_TTL);
  if (localCached && Array.isArray(localCached) && localCached.length > 0) {
    window._rawOddsGames = localCached;
    processOddsIntoComparador(localCached);
    const lockWait = _sbLockedPicksReady
      ? Promise.race([_sbLockedPicksReady, new Promise(r => setTimeout(r, 4000))])
      : Promise.resolve();
    lockWait.then(() => { deferRender(); fixPendingHistCommenceTs(); });
    return;
  }

  _oddsLoading = true;
  renderPreds(); // muestra skeleton

  function useData(combined) {
    window._rawOddsGames = combined;
    _loadFailed = false;
    _autoRetryCount = 0;
    clearTimeout(_autoRetryTimer); _autoRetryTimer = null;
    if (window._retryCountdownTick) { clearInterval(window._retryCountdownTick); window._retryCountdownTick = null; }
    cacheSet('cache_odds_v10', combined);
    try { localStorage.setItem('cache_odds_stale_v10', JSON.stringify({ ts: Date.now(), data: combined })); } catch(_) {}
    processOddsIntoComparador(combined);
    fixPendingHistCommenceTs();
  }

  function useStale() {
    try {
      const raw = localStorage.getItem('cache_odds_stale_v10');
      if (raw) {
        const { data } = JSON.parse(raw);
        if (data?.length) {
          const cleanData = data.filter(g =>
            !g.sport_key?.includes('albania') && !g.sport_key?.includes('faroe') &&
            !g.sport_key?.includes('gibraltar') && !g.sport_key?.includes('san_marino') &&
            !g.sport_key?.includes('liechtenstein') && !g.sport_key?.includes('malta') &&
            !g.sport_key?.includes('kosovo')
          );
          window._rawOddsGames = cleanData;
          processOddsIntoComparador(cleanData);
          _loadFailed = false;
          return true;
        }
      }
    } catch(_) {}
    _loadFailed = true;
    return false;
  }

  // Helper: ejecuta los 3 fetch con un timeout propio
  async function fetchWorker(timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // cache:'no-store' — evita que el navegador sirva una respuesta HTTP vieja
      // del worker (sin _stage/_round). El worker igual tiene su propio cache KV
      // de 1h, así que esto no genera llamadas extra a la API de odds.
      const [rM, rE, rS] = await Promise.all([
        fetch(`${WORKER_URL}/odds?category=main`,      { signal: ctrl.signal, cache: 'no-store' }).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
        fetch(`${WORKER_URL}/odds?category=europe`,    { signal: ctrl.signal, cache: 'no-store' }).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
        fetch(`${WORKER_URL}/odds?category=secondary`, { signal: ctrl.signal, cache: 'no-store' }).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
      ]);
      return [...(rM.data || []), ...(rE.data || []), ...(rS.data || [])];
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    // Intento 1: timeout 10s
    console.log('[Odds] Fetch #1 (Worker)...');
    let combined = await fetchWorker(10000);

    // Si vacío: intento 2 inmediato con 3s de espera (cold start del Worker)
    if (!combined.length) {
      console.warn('[Odds] Respuesta vacía → reintento en 3s...');
      _oddsLoading = true; // mantener skeleton
      await new Promise(r => setTimeout(r, 3000));
      if (!_oddsLoading) return; // otro proceso tomó el control
      combined = await fetchWorker(10000);
    }

    // Si sigue vacío: intento 3 final con 3s más
    if (!combined.length) {
      console.warn('[Odds] Sigue vacío → último intento...');
      await new Promise(r => setTimeout(r, 3000));
      if (!_oddsLoading) return;
      combined = await fetchWorker(8000);
    }

    if (combined.length > 0) {
      useData(combined);
    } else {
      // 3 intentos fallidos → stale o error
      const gotStale = useStale();
      if (!gotStale && _autoRetryCount < _MAX_AUTO_RETRY) {
        _oddsLoading = false;
        renderPreds();
        _scheduleAutoRetry();
        return;
      }
    }
  } catch(e) {
    console.warn('[Odds] Error fatal:', e.message);
    const gotStale = useStale();
    if (!gotStale && _autoRetryCount < _MAX_AUTO_RETRY) {
      _oddsLoading = false;
      renderPreds();
      _scheduleAutoRetry();
      return;
    }
  } finally {
    _oddsLoading = false;
    renderPreds();
  }
}

// ── Auto-retry con countdown visible ────────────────────────────────────────
let _autoRetryTimer = null;
function _scheduleAutoRetry() {
  _autoRetryCount++;
  const delay = _autoRetryCount <= 2 ? 8000 : 20000; // 8s los primeros 2, 20s los siguientes
  console.log(`[Odds] Auto-retry #${_autoRetryCount} en ${delay/1000}s`);
  // Actualizar la UI con contador regresivo
  _startRetryCountdown(delay);
  _autoRetryTimer = setTimeout(() => {
    console.log(`[Odds] Ejecutando auto-retry #${_autoRetryCount}`);
    cacheSet('cache_odds_v10', null);
    loadRealOdds();
  }, delay);
}

function _startRetryCountdown(ms) {
  const grid = document.getElementById('predGrid');
  if (!grid) return;
  let remaining = Math.round(ms / 1000);
  const render = () => {
    grid.innerHTML = `
      <div style="grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:56px 20px 60px;gap:16px;text-align:center">
        <div style="font-size:2.2rem">📡</div>
        <div style="font-size:1.05rem;font-weight:700;color:var(--texto-pri)">Conectando con el servidor…</div>
        <div style="font-size:0.82rem;color:var(--texto-sec);max-width:320px;line-height:1.5">
          La carga está tardando. Reintentando en <span id="_retryCountEl" style="color:var(--verde);font-weight:700">${remaining}s</span>
          ${_autoRetryCount >= _MAX_AUTO_RETRY ? '<br><span style="font-size:0.75rem;opacity:0.7">(último intento)</span>' : ''}
        </div>
        <button onclick="clearTimeout(_autoRetryTimer);_autoRetryCount=0;cacheSet('cache_odds_v10',null);localStorage.removeItem('cache_odds_stale_v10');loadRealOdds();"
          style="background:var(--verde);color:#000;border:none;border-radius:30px;padding:10px 26px;font-size:0.82rem;font-weight:700;cursor:pointer;font-family:inherit;margin-top:4px">
          🔄 Reintentar ahora
        </button>
        <button onclick="location.reload()"
          style="background:transparent;border:1px solid rgba(255,255,255,0.18);color:var(--texto-sec);border-radius:30px;padding:8px 22px;font-size:0.76rem;font-weight:600;cursor:pointer;font-family:inherit">
          ↺ Recargar página
        </button>
      </div>`;
  };
  render();
  const tick = setInterval(() => {
    remaining--;
    const el = document.getElementById('_retryCountEl');
    if (el) el.textContent = remaining + 's';
    if (remaining <= 0) clearInterval(tick);
  }, 1000);
  // Guardar tick para limpiarlo si llegan datos antes
  window._retryCountdownTick = tick;
}

// Limpiar countdown si los datos llegan
const _origUseData = null; // ya capturado arriba inline


let _scoresLoading = false;
async function loadRealScores(retryCount = 0) {
  if (retryCount === 0 && _scoresLoading) return;
  // Use cache if fresh
  if (retryCount === 0) {
    const cached = cacheGet('cache_scores', CACHE_SCORES_TTL);
    if (cached) {
      scoresData.length = 0;
      cached.forEach(g => scoresData.push(g));
      renderScores(currentScoreFilter || currentFilter);
      resolveCompletedGames(scoresData);
      acEvaluatePicks();
      console.log('[cache] scores desde caché localStorage');
      return;
    }
  }
  if (retryCount === 0) _scoresLoading = true;

  // Scores vienen de ESPN (gratis, sin API key) — no consume créditos de Odds API
  const ESPN_SOCCER = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
  const ESPN_LEAGUES = [
    { id: 'arg.1',                label: '🇦🇷 Liga Prof.',     prio: 10 },
    { id: 'arg.nacional',         label: '🇦🇷 1ª Nacional',    prio: 9  },
    { id: 'conmebol.libertadores',label: '🌎 Libertadores',    prio: 8  },
    { id: 'conmebol.sudamericana',label: '🌎 Sudamericana',    prio: 7  },
    { id: 'uefa.champions',       label: '🏆 Champions',       prio: 7  },
    { id: 'esp.1',                label: '🇪🇸 La Liga',        prio: 6  },
    { id: 'eng.1',                label: '🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier',      prio: 6  },
    { id: 'ita.1',                label: '🇮🇹 Serie A',        prio: 5  },
    { id: 'ger.1',                label: '🇩🇪 Bundesliga',     prio: 5  },
    { id: 'fra.1',                label: '🇫🇷 Ligue 1',        prio: 4  },
    { id: 'bra.1',                label: '🇧🇷 Brasileirao',    prio: 4  },
    { id: 'por.1',                label: '🇵🇹 Primeira Liga',  prio: 4  },
    { id: 'ned.1',                label: '🇳🇱 Eredivisie',     prio: 4  },
    { id: 'uefa.europa',          label: '🇪🇺 Europa League',  prio: 4  },
    { id: 'uefa.europa.conf',     label: '🇪🇺 Conference',     prio: 3  },
    { id: 'sco.1',                label: '🏴󠁧󠁢󠁳󠁣󠁴󠁿 Premiership',  prio: 3  },
    { id: 'tur.1',                label: '🇹🇷 Süper Lig',      prio: 3  },
    { id: 'mex.1',                label: '🇲🇽 Liga MX',        prio: 3  },
    { id: 'chi.1',                label: '🇨🇱 Chile 1ª',       prio: 2  },
    { id: 'ury.1',                label: '🇺🇾 Uruguay 1ª',     prio: 2  },
    { id: 'usa.1',                label: '🇺🇸 MLS',            prio: 2  },
    { id: 'sau.1',                label: '🇸🇦 Saudi Pro',      prio: 2  },
  ];

  try {
    const todayLocal    = new Date().toLocaleDateString('en-CA');
    const tomorrowLocal = new Date(Date.now() + 86400000).toLocaleDateString('en-CA');
    const threeDaysAgo  = new Date(Date.now() - 3 * 86400000).toLocaleDateString('en-CA');

    // Fecha de ayer y anteayer en formato YYYYMMDD para resolver picks pendientes
    const yest1 = new Date(Date.now() -   86400000).toISOString().slice(0,10).replace(/-/g,'');
    const yest2 = new Date(Date.now() - 2*86400000).toISOString().slice(0,10).replace(/-/g,'');
    const yest3 = new Date(Date.now() - 3*86400000).toISOString().slice(0,10).replace(/-/g,'');

    // Parsear eventos ESPN al formato interno de scoresData
    const parseEv = (events, league) => (events || []).map(e => {
      const comp   = e.competitions?.[0] || {};
      const hComp  = comp.competitors?.find(t => t.homeAway === 'home') || {};
      const aComp  = comp.competitors?.find(t => t.homeAway === 'away') || {};
      const hName  = hComp.team?.displayName || hComp.team?.name || '';
      const aName  = aComp.team?.displayName || aComp.team?.name || '';
      const scoreH = parseInt(hComp.score) || 0;
      const scoreA = parseInt(aComp.score) || 0;
      const st     = e.status?.type || {};
      const isLive = st.state === 'in';
      const isDone = st.completed === true;
      const gameTs = e.date ? new Date(e.date).getTime() : Date.now();
      const gameLocal = new Date(gameTs).toLocaleDateString('en-CA');
      const minsUntil = (gameTs - Date.now()) / 60000;
      const isNightcap = gameLocal === tomorrowLocal && new Date(gameTs).getHours() < 3;
      const forResolutionOnly = isDone && gameLocal < todayLocal;

      // Solo incluir: live, hoy, madrugada de mañana, o finalizados recientes (para resolver)
      const isRecentDone = isDone && gameLocal >= threeDaysAgo && gameLocal < todayLocal;
      if (!isLive && gameLocal !== todayLocal && !isNightcap && !isRecentDone) return null;

      let flag, time;
      if (isLive)      { flag = 'live';     time = e.status?.displayClock || T('time.live'); }
      else if (isDone) { flag = 'final';    time = T('time.final'); }
      else             { flag = minsUntil >= 0 && minsUntil <= 120 ? 'soon' : 'upcoming';
                         time = matchTime(e.date); }
      return {
        sport: 'futbol', league: league.label,
        home: shortName(hName), away: shortName(aName),
        homeRaw: hName, awayRaw: aName,
        scoreH, scoreA, status: flag, time, flag,
        commenceTs: gameTs, forResolutionOnly, _prio: league.prio,
      };
    }).filter(Boolean);

    // Fetch today + últimos 3 días para todas las ligas en paralelo
    const fetches = [];
    ESPN_LEAGUES.forEach(lg => {
      // Hoy (sin parámetro de fecha = hoy)
      fetches.push(fetch(`${ESPN_SOCCER}/${lg.id}/scoreboard`)
        .then(r => r.ok ? r.json() : null).catch(() => null)
        .then(j => ({ lg, events: j?.events || [] })));
      // Ayer y días anteriores (para resolver picks pendientes)
      [yest1, yest2, yest3].forEach(d => {
        fetches.push(fetch(`${ESPN_SOCCER}/${lg.id}/scoreboard?dates=${d}`)
          .then(r => r.ok ? r.json() : null).catch(() => null)
          .then(j => ({ lg, events: j?.events || [] })));
      });
    });

    const results = await Promise.allSettled(fetches);
    const allGames = [];
    const seen = new Set();
    results.forEach(r => {
      if (r.status !== 'fulfilled') return;
      const { lg, events } = r.value;
      parseEv(events, lg).forEach(g => {
        const key = `${normTeam(g.home)}_${normTeam(g.away)}_${g.commenceTs}`;
        if (!seen.has(key)) { seen.add(key); allGames.push(g); }
      });
    });

    // Ordenar: live → soon → upcoming → final, luego por prioridad de liga
    const fo = { live: 0, soon: 1, upcoming: 2, final: 3 };
    allGames.sort((a, b) => {
      const fd = (fo[a.flag] ?? 4) - (fo[b.flag] ?? 4);
      if (fd !== 0) return fd;
      if (a._prio !== b._prio) return b._prio - a._prio;
      return (a.commenceTs || 0) - (b.commenceTs || 0);
    });

    if (allGames.length > 0) {
      scoresData.length = 0;
      allGames.forEach(m => scoresData.push(m));
      cacheSet('cache_scores', allGames);
      _scoresFirstLoad = true;
      renderScores(currentScoreFilter);
      resolveCompletedGames(scoresData);
      acEvaluatePicks();
      loadPlayerPhotos();
      renderPreds();
      console.log(`[ESPN] scores: ${allGames.length} eventos (gratis, sin Odds API)`);
    } else {
      _scoresFirstLoad = true;
      renderScores(currentScoreFilter);
    }
    _scoresLoading = false;
  } catch (e) {
    if (retryCount < 3) {
      setTimeout(() => loadRealScores(retryCount + 1), 2500 * (retryCount + 1));
    } else {
      _scoresFirstLoad = true;
      console.warn('[ESPN scores] error tras reintentos:', e.message);
      renderScores(currentScoreFilter);
      _scoresLoading = false;
    }
  }
}

// ═══════════════════════════════════════════════
//  FEED PÚBLICO  — apuestas recientes de todos los usuarios
// ═══════════════════════════════════════════════
const PICK_LABELS = { home: 'Local', draw: 'Empate', away: 'Visitante' };
const GFEED_PAGE_SIZE = 5;
let _gFeedAllBets = [];
let _gFeedCurrentPage = 0;

function gFeedPage(dir) {
  const totalPages = Math.ceil(_gFeedAllBets.length / GFEED_PAGE_SIZE);
  _gFeedCurrentPage = Math.max(0, Math.min(_gFeedCurrentPage + dir, totalPages - 1));
  _renderGFeedPage();
}

// ── Pool de escudos para avatares sin logo propio ─────────────────────────
const _GB_TEAM_POOL = [
  'https://media.api-sports.io/football/teams/541.png',   // Real Madrid
  'https://media.api-sports.io/football/teams/529.png',   // Barcelona
  'https://media.api-sports.io/football/teams/530.png',   // Atlético Madrid
  'https://media.api-sports.io/football/teams/40.png',    // Liverpool
  'https://media.api-sports.io/football/teams/33.png',    // Manchester United
  'https://media.api-sports.io/football/teams/50.png',    // Manchester City
  'https://media.api-sports.io/football/teams/42.png',    // Arsenal
  'https://media.api-sports.io/football/teams/49.png',    // Chelsea
  'https://media.api-sports.io/football/teams/157.png',   // Bayern Munich
  'https://media.api-sports.io/football/teams/165.png',   // Borussia Dortmund
  'https://media.api-sports.io/football/teams/489.png',   // AC Milan
  'https://media.api-sports.io/football/teams/505.png',   // Inter Milan
  'https://media.api-sports.io/football/teams/496.png',   // Juventus
  'https://media.api-sports.io/football/teams/85.png',    // Paris Saint-Germain
  'https://media.api-sports.io/football/teams/194.png',   // Boca Juniors
  'https://media.api-sports.io/football/teams/195.png',   // River Plate
  'https://media.api-sports.io/football/teams/6.png',     // Brasil
  'https://media.api-sports.io/football/teams/9.png',     // Argentina
  'https://media.api-sports.io/football/teams/463.png',   // Flamengo
  'https://media.api-sports.io/football/teams/119.png',   // Ajax
  'https://media.api-sports.io/football/teams/569.png',   // Benfica
  'https://media.api-sports.io/football/teams/228.png',   // Porto
  'https://media.api-sports.io/football/teams/211.png',   // Nacional
  'https://media.api-sports.io/football/teams/246.png',   // Peñarol
];
// Devuelve la URL del escudo asignado deterministicamente al nick
function gbFallbackAvatarUrl(nick) {
  const str = (nick || '?').replace(/<[^>]*>/g, '').trim();
  const hash = [...str].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return _GB_TEAM_POOL[hash % _GB_TEAM_POOL.length];
}
// Devuelve la URL del escudo de respaldo (siguiente en el pool)
function gbFallbackAvatarUrl2(nick) {
  const str = (nick || '?').replace(/<[^>]*>/g, '').trim();
  const hash = [...str].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return _GB_TEAM_POOL[(hash + 1) % _GB_TEAM_POOL.length];
}
// ─────────────────────────────────────────────────────────────────────────

function _renderGFeedPage() {
  const list = document.getElementById('gFeedList');
  const nav  = document.getElementById('gFeedNav');
  const info = document.getElementById('gFeedPageInfo');
  const prev = document.getElementById('gFeedPrev');
  const next = document.getElementById('gFeedNext');
  if (!list) return;

  const start = _gFeedCurrentPage * GFEED_PAGE_SIZE;
  const page  = _gFeedAllBets.slice(start, start + GFEED_PAGE_SIZE);
  const totalPages = Math.ceil(_gFeedAllBets.length / GFEED_PAGE_SIZE);

  list.innerHTML = page.map((b, i) => {
    // Strip HTML tags to get plain text
    const plainNick = (b.nickText || b.nick || '').replace(/<[^>]*>/g, '');
    const _poolUrl  = gbFallbackAvatarUrl(plainNick);
    const _pool2Url = gbFallbackAvatarUrl2(plainNick);
    let avatarHtml = `<img loading="lazy" decoding="async" src="${_poolUrl}" alt="" style="width:100%;height:100%;object-fit:contain;border-radius:0;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.5))" onerror="this.src='${_pool2Url}'">`;
    if (b.ava) {
      let logoUrl = b.ava;
      try {
        const avaObj = typeof b.ava === 'string' ? JSON.parse(b.ava) : b.ava;
        logoUrl = avaObj?.logo || b.ava;
      } catch(_) { logoUrl = b.ava; }
      avatarHtml = `<img src="${logoUrl}" alt="${plainNick}" style="width:100%;height:100%;object-fit:contain;border-radius:0;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.5))" onerror="this.src='${_poolUrl}'">`;
    }
    const homeShield = logoHtml(b.home, 26);
    const awayShield = logoHtml(b.away, 26);
    const _shortTeam = n => n && n.length > 13 ? n.slice(0, 12) + '…' : (n || '');
    const matchCell = `<span style="display:inline-flex;flex-direction:column;align-items:flex-start;gap:3px;vertical-align:middle;max-width:170px;overflow:hidden">
      <span title="${b.home} vs ${b.away}" style="display:inline-flex;align-items:center;gap:6px">
        ${homeShield}
        <span style="font-size:0.58rem;color:var(--texto-sec);font-weight:700;letter-spacing:0.5px">vs</span>
        ${awayShield}
      </span>
      ${b.pick ? (()=>{ const lbl={home:_shortTeam(b.home),away:_shortTeam(b.away),draw:'Empate'}; return `<span style="font-size:0.67rem;color:rgba(255,255,255,0.75);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px;display:block">${lbl[b.pick]||b.pick}</span>`; })() : ''}
    </span>`;
    const oddsDisp = b.odds ? Number(b.odds).toFixed(2) : '—';
    return `<tr style="animation-delay:${i * 0.04}s">
      <td>${matchCell}</td>
      <td>
        <span style="display:inline-flex;align-items:center;gap:9px">
          <div class="gfeed-avatar" style="width:36px;height:36px;font-size:0.72rem;flex-shrink:0">${avatarHtml}</div>
          <span class="gfeed-nick" style="font-size:0.82rem">
            <span class="gfeed-nick-text">${b.nickText||b.nick||''}</span>${b.nickBadges||''}
          </span>
        </span>
      </td>
      <td><span class="gfeed-time">${_timeAgo(b.ts)}</span></td>
      <td><span class="gfeed-odds">${oddsDisp}</span></td>
      <td><span class="gfeed-amount">${acFmt(b.betAmount)}</span></td>
    </tr>`;
  }).join('');

  // Navegación
  if (totalPages > 1) {
    nav.style.display = 'flex';
    info.textContent = `${_gFeedCurrentPage + 1} / ${totalPages}`;
    prev.disabled = _gFeedCurrentPage === 0;
    prev.style.opacity = _gFeedCurrentPage === 0 ? '0.35' : '1';
    next.disabled = _gFeedCurrentPage >= totalPages - 1;
    next.style.opacity = _gFeedCurrentPage >= totalPages - 1 ? '0.35' : '1';
  } else {
    nav.style.display = 'none';
  }
}

function _timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'Ahora mismo';
  if (m < 60) return `Hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Hace ${h}h`;
  const d = Math.floor(h / 24);
  return `Hace ${d} día${d !== 1 ? 's' : ''}`;
}

async function fetchGFeed() {
  // Sección "En esto pusieron sus  otros usuarios" desactivada ( removido)
  return;
  // eslint-disable-next-line no-unreachable
  try {
    // Proxy con caché de servidor (5 min compartido) + localStorage fallback
    const cached = _sbGetCache('gfeed');
    let data;

    // Helper: normalizar respuesta del proxy (puede venir como array o {data:[...]} o {error:...})
    const _normalizeGFeed = (raw) => {
      if (!raw) return null;
      if (Array.isArray(raw)) return raw.length > 0 ? raw : null;
      if (Array.isArray(raw?.data)) return raw.data.length > 0 ? raw.data : null;
      return null; // objeto de error u otro formato → ignorar
    };

    if (cached) {
      data = _normalizeGFeed(cached);
    } else {
      // 1) Intentar proxy con timeout de 6s
      try {
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 6000);
        const resp = await fetch('/api/sb?type=gfeed', { signal: ctrl.signal });
        clearTimeout(tid);
        if (resp.ok) {
          const raw = await resp.json();
          data = _normalizeGFeed(raw);
        }
      } catch(proxyErr) {
        console.warn('[gFeed] proxy falló:', proxyErr?.message || proxyErr);
      }

      // 2) Fallback directo a Supabase si el proxy falló o no devolvió datos
      if (!data) {
        const res = await sbAnon
          .from('acoin_users').select('nickname, avatar, picks, balance, email')
          .not('picks', 'is', null).order('updated_at', { ascending: false }).limit(40);
        if (!res.error && Array.isArray(res.data) && res.data.length > 0) {
          data = res.data;
        }
      }

      // Cachear solo si obtuvimos datos válidos
      if (data) _sbSetCache('gfeed', data, 15 * 60 * 1000);
    }

    if (!data) return;

    // Aplanar todos los picks de todos los usuarios, ordenar por ts desc
    const allBets = [];
    data.forEach(user => {
      const vip = user.email ? GAMBETA_VIP[user.email] : null;
      // Si tiene nickname elegido, usarlo; si no, usar prefijo del email como fallback
      let nick = vip?.nickname
        || ((user.nickname && user.nickname.trim()) ? user.nickname.trim().slice(0, 16) : null);
      if (!nick && user.email) {
        const prefix = user.email.split('@')[0];
        nick = prefix.slice(0, 1) + '*'.repeat(Math.min(prefix.length - 1, 6));
      }
      if (vip?.suffix) nick = nick + vip.suffix;
      if (!nick) return;
      const champBadge = typeof rkChampionBadge === 'function' ? rkChampionBadge(user.email) : '';
      // Calcular racha de wins consecutivos desde los picks  del usuario
      const _evalPicks = (user.picks || [])
        .filter(p => p.evaluated)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
      let _streak = 0;
      for (const p of _evalPicks) { if (p.correct) _streak++; else break; }
      const streakBadge = typeof rkStreakBadge === 'function' ? rkStreakBadge(_streak) : '';
      // nickText: solo el nombre con color (sin badges)
      const nickText = vip?.nameColor
        ? `<span style="color:${vip.nameColor};font-weight:800">${nick}</span>`
        : nick;
      // nickBadges: champion + streak, separados para poder renderizar fuera del truncado
      const nickBadges = champBadge + streakBadge;
      const ava  = user.avatar || null;
      const bal  = user.balance || 0;
      (user.picks || []).forEach(p => {
        if (p.ts && p.home && p.away && p.pick && p.betAmount) {
          allBets.push({ nickText, nickBadges, ava, bal, ...p });
        }
      });
    });

    // Ordenar por timestamp más reciente y guardar globalmente
    allBets.sort((a, b) => b.ts - a.ts);
    if (allBets.length === 0) return;

    const wrap = document.getElementById('gFeedWrap');
    if (!wrap) return;

    _gFeedAllBets = allBets;
    _gFeedCurrentPage = 0;
    _renderGFeedPage();
    wrap.style.display = '';
  } catch(e) {
    console.error('[gFeed] Error inesperado:', e?.message || e);
  }
}

// ═══════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════

_purgeNbaPicks(); // eliminar picks NBA del historial y  al cargar la página
renderSkeletonScores(6); // mostrar skeleton mientras carga la API
renderPreds();
renderStats('futbol');
updateCalc();
renderHistorial('all');
renderBankrollSummary();
renderBetsList();
setTimeout(drawBankrollChart, 100);

// ── Carga inmediata del historial GLOBAL (visible para todos, incluso sin login) ──
// IMPORTANTE: fusionar con local en vez de reemplazar para no perder picks guardados
// Forzamos fetch fresco en cada page load para que nunca queden picks viejos cacheados
(async () => {
  // Render inmediato desde localStorage para que la tabla nunca empiece vacía
  const _localImmediate = loadHistorial();
  if (_localImmediate.length > 0) renderHistorial(histFilter);

  // forceFresh=true → bypass cache local + agrega ?t=... para bypass CDN edge cache
  const g = await sbLoadGlobalHistorial(true);
  if (g && g.length > 0) {
    const _localH = loadHistorial();
    const _hKeyG = h => h.id || `${h.home}|||${h.away}|||${h.commenceTs||h.date||''}`;
    const _gKeys = new Set(g.map(_hKeyG));
    const _localOnlyG = _localH.filter(h => !_gKeys.has(_hKeyG(h)));
    // SAFETY: si el cloud tiene >>> que el local, descartar locales viejos huérfanos
    // (típicamente picks legacy que quedaron en localStorage de versiones antiguas
    // y nunca se subieron al cloud — generalmente <10 picks). Solo conservamos
    // locales si el local tenía cantidad razonable comparable al global.
    const keepLocal = _localH.length >= Math.max(20, g.length * 0.5);
    const _localOnlyFinal = keepLocal ? _localOnlyG : [];
    const _mergedG = [...g, ..._localOnlyFinal].sort((a,b)=>(b.commenceTs||0)-(a.commenceTs||0)).slice(0,1000000);
    try { localStorage.setItem(HIST_KEY, JSON.stringify(_mergedG)); } catch {}
    window._sbHist = _mergedG;  // ← expuesto para que buildPredsFromOdds pueda levantar WC pending
    renderHistorial(histFilter);
    // Re-disparar buildPredsFromOdds para que las fichas WC se levanten desde el historial
    try { if (typeof renderPreds === 'function') renderPreds(); } catch(e){}
    console.log('[globalHist] ✓ Cargado desde Supabase:', g.length, 'globales +', _localOnlyFinal.length, 'locales =', _mergedG.length, 'total (keepLocal='+keepLocal+')');
  } else if (_localImmediate.length === 0) {
    // Proxy falló y localStorage vacío: re-renderizar igual para limpiar el estado de carga
    renderHistorial(histFilter);
    console.warn('[globalHist] Proxy falló y sin datos locales — tabla vacía esperada');
  }
})();
window.addEventListener('resize', () => { clearTimeout(window._chartTimer); window._chartTimer = setTimeout(drawBankrollChart, 120); });
loadPlayerPhotos();

// ── ROUTING DE PÁGINAS DEDICADAS (hash-based) ─────────────────────────────
const _GB_PAGE_CFG = {
  picks:     { label: '🔮 Picks del Día',   title: 'Picks · gambeta.ai' },
  historial: { label: '📋 Resultados',       title: 'Resultados · gambeta.ai' },
  stats:     { label: '📊 Estadísticas',     title: 'Estadísticas · gambeta.ai' },

};

let _gbScrollBeforePage = 0;  // guarda el scroll antes de abrir una sub-página
let _gbTransitioning    = false; // evita clics múltiples durante animación

function gbSetPage(page) {
  const cfg = _GB_PAGE_CFG[page];
  const bar = document.getElementById('gbPageBar');
  const lbl = document.getElementById('gbPageLabel');

  if (!cfg) {
    // HOME: limpiar atributo → CSS restaura todo
    document.body.removeAttribute('data-gbpage');
    if (bar) bar.style.display = 'none';
    document.title = 'gambeta.ai · Picks de Fútbol con IA';
    // Restaurar el scroll al punto desde donde se entró
    requestAnimationFrame(() => {
      window.scrollTo(0, _gbScrollBeforePage);
    });
    return;
  }

  // Página dedicada
  document.body.dataset.gbpage = page;
  if (bar) bar.style.display = 'flex';
  if (lbl) lbl.textContent = cfg.label;
  document.title = cfg.title;
  window.scrollTo(0, 0);

  // En stats: renderizar myPicksPanel
  if (page === 'stats') {
    renderMyPicks?.();
  }
  // En picks: resetear filtro de tiempo a "Todos" para mostrar todos los picks
  if (page === 'picks') {
    window._predTimeFilter = 'all';
    document.querySelectorAll('#predTimeTabs .sport-tab').forEach(b => b.classList.remove('active'));
    const todosBtn = document.querySelector('#predTimeTabs .sport-tab');
    if (todosBtn) todosBtn.classList.add('active');
    renderPreds?.();
  }
  // En historial: resetear todos los filtros y re-renderizar para mostrar el historial completo
  if (page === 'historial') {
    histFilter = 'all'; histDateFilter = 'all'; histLeagueFilter = 'all';
    histMercadoFilter = 'all'; histConfFilter = 'all'; histPage = 0;
    ['histDateBtnHoy','histDateBtnWeek','histDateBtnAll','histDateBtnFinde'].forEach(id => {
      document.getElementById(id)?.classList.remove('active');
    });
    document.getElementById('histDateBtnAll')?.classList.add('active');
    renderHistorial('all');
  }
}

// Volver al inicio con animación de salida
function gbGoHome() {
  if (_gbTransitioning) return;
  _gbTransitioning = true;
  document.body.classList.add('gb-page-closing');
  setTimeout(() => {
    document.body.classList.remove('gb-page-closing');
    _gbTransitioning = false;
    // Si el hash ya es '' o '#', hashchange NO se dispara → llamar gbSetPage(null) directo
    const h = window.location.hash.replace('#','');
    if (h && _GB_PAGE_CFG[h]) {
      // hash tiene una sub-página → limpiarlo dispara hashchange → _gbHandleHash → gbSetPage(null)
      window.location.hash = '';
    } else {
      // hash ya estaba vacío (sub-página abierta sin hash): ir a home directamente
      if (window.location.hash) history.replaceState(null, '', location.pathname);
      gbSetPage(null);
    }
  }, 210);
}

// Navegar entre sub-páginas con animación de salida → entrada
function gbNavToPage(page) {
  if (_gbTransitioning) return;
  if (window.location.hash.slice(1) === page) return; // ya estamos ahí
  _gbTransitioning = true;
  document.body.classList.add('gb-page-closing');
  setTimeout(() => {
    document.body.classList.remove('gb-page-closing');
    _gbTransitioning = false;
    window.location.hash = page;
  }, 210);
}

function _gbHandleHash() {
  const hash = window.location.hash.slice(1).split('?')[0];
  const wasOnPage = !!document.body.dataset.gbpage;
  const isValidPage = !!_GB_PAGE_CFG[hash];

  // Guardar scroll antes de entrar a una sub-página desde home
  if (!wasOnPage && isValidPage) {
    _gbScrollBeforePage = window.scrollY;
  }

  gbSetPage(isValidPage ? hash : null);
}

window.addEventListener('hashchange', _gbHandleHash);

// Restaurar home en bfcache (botón Atrás desde sub-página)
window.addEventListener('pageshow', function(e) {
  if (e.persisted) {
    // Página restaurada desde bfcache → forzar home
    document.body.removeAttribute('data-gbpage');
    document.body.classList.remove('gb-page-closing');
    const bar = document.getElementById('gbPageBar');
    if (bar) bar.style.display = 'none';
    document.title = 'gambeta.ai · Picks de Fútbol con IA';
    if (window.location.hash) history.replaceState(null, '', location.pathname);
    window.scrollTo(0, 0);
    // Resetear filtros del historial para que la próxima apertura muestre todo
    histDateFilter = 'all'; histLeagueFilter = 'all'; histMercadoFilter = 'all';
    histConfFilter = 'all'; histPage = 0;
  }
});

// En carga inicial: ignorar el hash guardado por el browser (bookmark, historial, bfcache).
// Solo activar sub-páginas ante cambios de hash iniciados por el usuario.
// Limpiamos el hash del URL para que la próxima carga siempre empiece en home.
(function _gbInitialLoad() {
  const hash = window.location.hash.slice(1).split('?')[0];
  if (_GB_PAGE_CFG[hash]) {
    // Había un hash de sub-página guardado: limpiar y cargar home
    history.replaceState(null, '', location.pathname);
  }
  // Siempre arrancar en home (gbSetPage sin args)
  gbSetPage(null);
})();
// ── FIN ROUTING ───────────────────────────────────────────────────────────

// Add welcome message to chat
setTimeout(() => {
  addMessage('👋 ¡Hola! Soy **gambeta.ai**, tu asistente de pronósticos deportivos con IA. Puedo darte pronósticos, análisis estadísticos y consejos para identificar valor en las cuotas. ¿En qué puedo ayudarte hoy?', 'bot');
}, 300);

// Verificar qué deportes están disponibles en la API key — con caché de 6 horas
window._availableSports = null;
(function loadAvailableSports() {
  const _avKey = '_gb_avail';
  try {
    const cached = JSON.parse(localStorage.getItem(_avKey) || 'null');
    if (cached && cached.ts && (Date.now() - cached.ts) < 6 * 3600 * 1000 && cached.keys) {
      window._availableSports = cached.keys;
      renderScores(currentScoreFilter);
      return; // usar caché, no fetch
    }
  } catch {}
  fetch(`${WORKER_URL}/available`)
    .then(r => r.json())
    .then(j => {
      window._availableSports = j.keys || [];
      try { localStorage.setItem(_avKey, JSON.stringify({ keys: window._availableSports, ts: Date.now() })); } catch {}
      const hasTenis  = window._availableSports.some(k => k.includes('tennis'));
      const hasMMA    = window._availableSports.some(k => k.includes('mma'));
      const hasRugby  = window._availableSports.some(k => k.includes('rugby'));
      console.log(`[API] Deportes disponibles: tennis=${hasTenis} mma=${hasMMA} rugby=${hasRugby}`);
      renderScores(currentScoreFilter);
    })
    .catch(e => { window._availableSports = []; console.warn('[API] No se pudo verificar sports:', e); });
})();

// ── Limpiar claves de caché obsoletas (versiones anteriores) ──
try {
  ['cache_odds_v6', 'cache_odds_stale_v6', 'cache_odds_v5', 'cache_odds_stale_v5', 'cache_odds_v4', 'cache_odds_v3', 'cache_odds_stale',
   'gambeta_daily_preds_v14', 'gambeta_daily_preds_v13', 'gambeta_daily_preds_v12', 'gambeta_daily_preds_v11', 'gambeta_daily_preds_v10', 'gambeta_daily_preds_v9', 'gambeta_daily_preds_v8', 'gambeta_daily_preds_v7', 'gambeta_daily_preds_v6', 'gambeta_daily_preds_v5', 'gambeta_daily_preds_v4', 'gambeta_daily_preds_v3', 'gambeta_daily_preds_v2', 'gambeta_daily_preds_v1']
    .forEach(k => localStorage.removeItem(k));
} catch(_) {}

// ── Sanear cache de odds: eliminar cualquier juego de liga bloqueada que pueda haber quedado en localStorage ──
try {
  const _staleRaw = localStorage.getItem('cache_odds_stale_v10');
  if (_staleRaw) {
    const _staleObj = JSON.parse(_staleRaw);
    if (_staleObj?.data?.some(g => g.sport_key?.includes('albania') || g.sport_key?.includes('faroe') || g.sport_key?.includes('gibraltar'))) {
      localStorage.removeItem('cache_odds_stale_v10');
      console.log('[Init] Eliminada cache de odds con ligas bloqueadas');
    }
  }
} catch(_) {}

// Inicializar idioma detectado
setLang(detectLang());

// Cargar datos reales desde el Worker
loadRealScores();
loadRealOdds();  // ← carga cuotas para las fichas de pronósticos

// 🌍 Precarga historial global en background para que WC Largo Plazo y otros filtros
// tengan los datos disponibles desde la 1ra interacción (sin esperar al click).
// No bloquea: si falla, los flows lazy on-demand siguen funcionando.
setTimeout(() => {
  try {
    if (typeof _sbGetCache === 'function' && !_sbGetCache('ghist') &&
        typeof sbLoadGlobalHistorial === 'function') {
      sbLoadGlobalHistorial().catch(e => console.log('[bg-ghist preload]', e.message));
    }
  } catch(e) {}
}, 1500);

loadRealStats('futbol'); // Stats: carga fútbol al iniciar
setTimeout(fetchGFeed, 0);  // diferido para evitar TDZ con GAMBETA_VIP (declarado más adelante)
setInterval(fetchGFeed, 15 * 60 * 1000); // refrescar feed cada 15 min (era 5)
// Refrescar cada 60 min
setInterval(() => { delete realStatsCache[currentStatFilter]; loadRealStats(currentStatFilter); }, 60 * 60 * 1000);
setInterval(() => loadRealOdds(), 60 * 60 * 1000); // refrescar cuotas/fichas cada hora

// 🔁 Auto-resolver: cada 5 min mientras la pestaña esté abierta. Si hay picks pendientes
// con commenceTs ya pasado +2h, dispara fetch ESPN para resolverlos.
// Garantía: ningún pick supera las 3h post-kickoff sin intentos de resolución.
// Rate-limit interno 30s entre fetches.
// Frecuencia bajada de 10 → 5 min para días de mucha actividad.
const _autoResolveTick = () => {
  try {
    if (document.hidden) return;
    if (window._loadHistScoresRunning) return;
    if (typeof loadHistorial !== 'function' || typeof loadHistoricalScores !== 'function') return;
    const hist = loadHistorial();
    const now = Date.now();
    const due = hist.some(h => (h.result === 'pending' || !h.result)
      && h.commenceTs && (now - h.commenceTs) >= (2 * 60 * 60 * 1000));
    if (due) loadHistoricalScores();
  } catch(_) {}
};
setInterval(_autoResolveTick, 5 * 60 * 1000);
// Trigger inmediato al cargar la página (no esperar a que abran Resultados)
setTimeout(_autoResolveTick, 8000);
// Re-trigger cuando el usuario vuelve a la pestaña (visibilitychange)
document.addEventListener('visibilitychange', () => { if (!document.hidden) _autoResolveTick(); });

// Al volver a la pestaña — refrescar solo si la caché expiró Y pasaron al menos 10 min desde el último check
let _lastVisCheck = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    const now = Date.now();
    if (now - _lastVisCheck < 10 * 60 * 1000) return; // throttle: máx 1 vez cada 10 min
    _lastVisCheck = now;
    if (!cacheGet('cache_scores', CACHE_SCORES_TTL)) loadRealScores();
    if (!cacheGet('cache_odds_v10',  CACHE_ODDS_TTL))  loadRealOdds();
  }
});

// Live scores vienen exclusivamente de la API (loadRealScores cada 5 min)


// ═══════════════════════════════════════════════
//  AUTH / MEMBRESÍA
// ═══════════════════════════════════════════════
var authUser = null;
let pendingSocial = null;
let authIsLogin = false; // false = registrar, true = iniciar sesión

const socialMeta = {
  google:   { label:'Google',   icon:`<svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>` },
  facebook: { label:'Facebook', icon:`<svg width="18" height="18" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#1877F2"/><path fill="#fff" d="M16.5 12h-3v8h-3v-8H8.5V9.5H10.5V8c0-2.2 1.3-3.5 3.3-3.5.95 0 1.95.17 1.95.17V6.8h-1.1c-1.08 0-1.42.67-1.42 1.36V9.5h2.42L15.2 12h-1.97z"/></svg>` },
  twitter:  { label:'X (Twitter)', icon:`<svg width="18" height="18" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#000"/><path fill="#fff" d="M17.75 4h-2.6l-3.4 4.4L8.4 4H3l5.9 7.8L3.2 20h2.6l3.7-4.8 3.5 4.8H18l-6.1-8.1L17.75 4z"/></svg>` },
  apple:    { label:'Apple',    icon:`<svg width="18" height="18" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#111"/><path fill="#fff" d="M17.04 17.33c-.36.82-.79 1.58-1.4 2.16-.82.8-1.7.75-2.55.34-.9-.43-1.72-.44-2.66 0-.97.45-1.84.47-2.65-.37C5.13 16.9 4.3 13.6 5.4 10.72c.72-1.88 2.1-2.97 3.52-2.99 1 .02 1.83.58 2.52.58.69 0 1.98-.72 3.33-.61.57.02 2.15.2 3.17 1.57-.08.05-1.9 1.09-1.88 3.25.02 2.58 2.28 3.44 2.3 3.45-.02.08-.37 1.21-1.32 2.36zM13.87 3.5c-.02 1.85-1.39 3.23-3.15 3.11C10.5 4.84 11.94 3.39 13.87 3.5z"/></svg>` },
  email:    { label:'Email',    icon:`📧` }
};

// ── Traducciones de errores de Supabase ──
function sbTranslateError(msg) {
  if (!msg) return 'Error desconocido.';
  if (msg.includes('Invalid login credentials'))   return 'Email o contraseña incorrectos.';
  if (msg.includes('Email not confirmed'))          return 'Confirmá tu email antes de iniciar sesión.';
  if (msg.includes('User already registered'))      return 'Este email ya está registrado. Usá "Iniciá sesión".';
  if (msg.includes('Password should be at least'))  return 'La contraseña debe tener al menos 6 caracteres.';
  if (msg.includes('rate limit') || msg.includes('after') && msg.includes('second'))
                                                    return 'Demasiados intentos. Esperá 1 minuto e intentá de nuevo.';
  if (msg.includes('network'))                      return 'Sin conexión. Revisá tu internet.';
  return msg;
}

var _authOpenTime = 0;
var _authScrollY = 0;
// ── Modal de bienvenida ──────────────────────────────────────────
function showWelcome(name) {
  const el = document.getElementById('welcomeOverlay');
  if (!el) return;
  const firstName = (name || 'campeón').split(' ')[0];
  const sub = document.getElementById('welcomeSubtitle');
  if (sub) sub.textContent = `¡Hola ${firstName}! Ya sos parte de la comunidad 🙌 — estos son tus primeros pasos para ganar con la IA.`;
  el.classList.add('open');
  // Guardar en localStorage para no volver a mostrarlo
  try { localStorage.setItem('gb_welcomed_v1', '1'); } catch(_) {}
}
function closeWelcome() {
  document.getElementById('welcomeOverlay')?.classList.remove('open');
}
// ────────────────────────────────────────────────────────────────

function openAuth() {
  _authScrollY = window.scrollY;          // guardar posición antes de bloquear scroll
  document.getElementById('authOverlay').classList.add('open');
  showAuthStep(1);
  document.body.style.overflow = 'hidden';
  document.body.style.top = `-${_authScrollY}px`;  // anclar visualmente
  _authOpenTime = Date.now();
  // Limpiar honeypot al abrir
  const hp = document.getElementById('hpWebsite');
  if (hp) hp.value = '';
}
function closeAuth() {
  document.getElementById('authOverlay').classList.remove('open');
  document.body.style.overflow = '';
  document.body.style.top = '';
  window.scrollTo({ top: _authScrollY, behavior: 'instant' }); // restaurar posición exacta
}
function authOverlayClick(e) {
  if (e.target === document.getElementById('authOverlay')) closeAuth();
}
function showAuthStep(n) {
  document.querySelectorAll('.auth-step').forEach(s => s.classList.remove('active'));
  document.getElementById('authStep' + n).classList.add('active');
}

function toggleAuthMode() {
  authIsLogin = !authIsLogin;
  document.getElementById('authStep2Title').textContent   = authIsLogin ? 'Iniciá sesión' : 'Crear cuenta';
  document.getElementById('authStep2Sub').textContent     = authIsLogin ? 'Ingresá tu email y contraseña.' : 'Ingresá tu email y elegí una contraseña.';
  document.getElementById('authSubmitBtn').textContent    = authIsLogin ? 'Iniciar sesión →' : '✓ Crear mi cuenta gratis';
  document.getElementById('authModeText').textContent     = authIsLogin ? '¿No tenés cuenta?' : '¿Ya tenés cuenta?';
  document.getElementById('authModeLink').textContent     = authIsLogin ? 'Registrate gratis' : 'Iniciá sesión';
  document.getElementById('marketingRow').style.display  = authIsLogin ? 'none' : '';
  document.getElementById('emailError').textContent = '';
}

// Dominios populares con typos comunes → corrección sugerida
const _EMAIL_TYPOS = {
  'gmai.com':'gmail.com','gmial.com':'gmail.com','gmail.co':'gmail.com','gmail.cm':'gmail.com',
  'hotmial.com':'hotmail.com','hotmai.com':'hotmail.com','hotmal.com':'hotmail.com','homail.com':'hotmail.com',
  'outlok.com':'outlook.com','outloo.com':'outlook.com','otulook.com':'outlook.com',
  'yaho.com':'yahoo.com','yahooo.com':'yahoo.com','yahou.com':'yahoo.com','yhoo.com':'yahoo.com',
  'iclod.com':'icloud.com','iclould.com':'icloud.com','icoud.com':'icloud.com',
  'protonmai.com':'protonmail.com','protonmial.com':'protonmail.com',
};
function _suggestEmailFix(email) {
  const [user, domain] = email.toLowerCase().split('@');
  if (!domain) return null;
  return _EMAIL_TYPOS[domain] ? `${user}@${_EMAIL_TYPOS[domain]}` : null;
}

async function sendMagicLink() {
  const email = document.getElementById('directEmail').value.trim();
  const inputEl = document.getElementById('directEmail');
  const errEl   = document.getElementById('magicLinkError');
  errEl.textContent = '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    inputEl.style.borderColor = 'var(--rojo)';
    inputEl.placeholder = '⚠ Ingresá un email válido';
    setTimeout(() => { inputEl.style.borderColor = ''; inputEl.placeholder = 'tu@email.com'; }, 2500);
    return;
  }
  const suggestion = _suggestEmailFix(email);
  if (suggestion) {
    errEl.innerHTML = `⚠ ¿Quisiste decir <strong style="cursor:pointer;text-decoration:underline" onclick="document.getElementById('directEmail').value='${suggestion}';document.getElementById('magicLinkError').textContent='';sendMagicLink()">${suggestion}</strong>?`;
    inputEl.style.borderColor = 'var(--amarillo)';
    setTimeout(() => { inputEl.style.borderColor = ''; }, 4000);
    return;
  }
  const btn = document.getElementById('magicLinkBtn');
  btn.textContent = '🚀 Enviando...'; btn.disabled = true;
  // Timeout de 12 segundos para no quedar colgado si Supabase tarda
  const timeoutId = setTimeout(() => {
    btn.textContent = '✉️ Enviar link de acceso'; btn.disabled = false;
    errEl.textContent = '⚠ Sin respuesta del servidor. Intentá de nuevo.';
    setTimeout(() => { errEl.textContent = ''; }, 4000);
  }, 12000);
  try {
    const { error } = await sbClient.auth.signInWithOtp({
      email,
      options: {
        // Usar solo origin+pathname — sin query params ni hash fragments
        // para que Supabase pueda agregar el token al final sin conflictos
        emailRedirectTo: window.location.origin + window.location.pathname,
        shouldCreateUser: true, // permite login/registro con el mismo link
      }
    });
    clearTimeout(timeoutId);
    if (error) {
      btn.textContent = '✉️ Enviar link de acceso'; btn.disabled = false;
      // Rate limit: Supabase permite 1 OTP por minuto por email
      if (error.status === 429 || error.message?.toLowerCase().includes('rate limit') || error.message?.toLowerCase().includes('after')) {
        const secsMatch = error.message?.match(/after (\d+) second/);
        const secs = secsMatch ? secsMatch[1] : '60';
        errEl.textContent = `⏱ Ya enviamos un link a este email. Esperá ${secs} segundos e intentá de nuevo.`;
      } else {
        errEl.textContent = '⚠ No pudimos enviar el link. Probá registrarte con contraseña.';
      }
      setTimeout(() => { errEl.textContent = ''; }, 10000);
    } else {
      // Mostrar pantalla de confirmación
      document.getElementById('welcomeMsg').textContent = `Te mandamos un link a ${email} — revisá tu bandeja (y spam) y hacé clic para entrar. ✉️`;
      showAuthStep(3);
    }
  } catch(e) {
    clearTimeout(timeoutId);
    btn.textContent = '✉️ Enviar link de acceso'; btn.disabled = false;
    errEl.textContent = '⚠ Error de conexión. Intentá de nuevo.';
    setTimeout(() => { errEl.textContent = ''; }, 4000);
  }
}

async function selectSocial(provider) {
  // Google: OAuth real → redirect a Supabase
  if (provider === 'google') {
    // Guardar sección actual para restaurarla después del redirect OAuth
    sessionStorage.setItem('_gb_oauth_hash', location.hash || '');
    await sbClient.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + window.location.pathname }
    });
    return;
  }
  // Email: ir al step 2 con email + contraseña
  pendingSocial = provider;
  authIsLogin = false;
  const direct = document.getElementById('directEmail').value.trim();
  document.getElementById('leadEmail').value    = (provider === 'email' && direct) ? direct : '';
  document.getElementById('leadPassword').value = '';
  // Resetear a modo registro
  document.getElementById('authStep2Title').textContent  = 'Crear cuenta';
  document.getElementById('authStep2Sub').textContent    = 'Ingresá tu email y elegí una contraseña.';
  document.getElementById('authSubmitBtn').textContent   = '✓ Crear mi cuenta gratis';
  document.getElementById('authModeText').textContent    = '¿Ya tenés cuenta?';
  document.getElementById('authModeLink').textContent    = 'Iniciá sesión';
  document.getElementById('marketingRow').style.display  = '';
  const meta = socialMeta[provider];
  const iconHtml = typeof meta.icon === 'string' && meta.icon.startsWith('<') ? meta.icon : `<span style="font-size:1.1rem">${meta.icon}</span>`;
  document.getElementById('socialChip').innerHTML = `${iconHtml} Registrándose con ${meta.label}`;
  document.getElementById('emailError').textContent = '';
  showAuthStep(2);
  setTimeout(() => document.getElementById('leadEmail').focus(), 100);
}

function authGoBack() {
  pendingSocial = null;
  authIsLogin = false;
  showAuthStep(1);
}

function goToEmailLogin() {
  pendingSocial = 'email';
  authIsLogin = true;
  const direct = document.getElementById('directEmail').value.trim();
  document.getElementById('leadEmail').value    = direct || '';
  document.getElementById('leadPassword').value = '';
  document.getElementById('authStep2Title').textContent  = 'Iniciá sesión';
  document.getElementById('authStep2Sub').textContent    = 'Ingresá tu email y contraseña.';
  document.getElementById('authSubmitBtn').textContent   = 'Iniciar sesión →';
  document.getElementById('authModeText').textContent    = '¿No tenés cuenta?';
  document.getElementById('authModeLink').textContent    = 'Registrate gratis';
  document.getElementById('marketingRow').style.display  = 'none';
  document.getElementById('socialChip').innerHTML        = '🔑 Iniciando sesión con email';
  document.getElementById('emailError').textContent      = '';
  showAuthStep(2);
  setTimeout(() => document.getElementById(direct ? 'leadPassword' : 'leadEmail').focus(), 100);
}

async function completeAuth() {
  const email    = document.getElementById('leadEmail').value.trim();
  const password = document.getElementById('leadPassword').value;
  const errEl    = document.getElementById('emailError');

  // ── Defensa anti-bot ────────────────────────────────────────────────
  // 1) Honeypot: si el campo oculto tiene valor, es un bot
  const hp = document.getElementById('hpWebsite');
  if (hp && hp.value.trim() !== '') {
    // Silencioso — el bot cree que funcionó
    console.warn('[GAMBETA SECURITY] Honeypot activado — registro bloqueado');
    return;
  }
  // 2) Tiempo mínimo: los bots envían formularios en < 2 segundos
  if (!authIsLogin && _authOpenTime && (Date.now() - _authOpenTime) < 2000) {
    errEl.textContent = '⚠ Demasiado rápido. Esperá un momento e intentá de nuevo.';
    return;
  }
  // 3) Rate limiting: máx 5 intentos por IP/browser en 10 minutos
  const _RL_KEY = '_gb_auth_rl';
  try {
    const rl = JSON.parse(localStorage.getItem(_RL_KEY) || '{"n":0,"t":0}');
    const now = Date.now();
    if (now - rl.t > 10 * 60 * 1000) { rl.n = 0; rl.t = now; } // reset cada 10 min
    rl.n++;
    if (rl.n > 5) {
      const wait = Math.ceil((10 * 60 * 1000 - (now - rl.t)) / 60000);
      errEl.textContent = `⚠ Demasiados intentos. Esperá ${wait} min e intentá de nuevo.`;
      return;
    }
    localStorage.setItem(_RL_KEY, JSON.stringify(rl));
  } catch {}
  // ────────────────────────────────────────────────────────────────────

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    errEl.textContent = '⚠ Ingresá un email válido para continuar.';
    document.getElementById('leadEmail').focus(); return;
  }
  const _fix = _suggestEmailFix(email);
  if (_fix) {
    errEl.innerHTML = `⚠ ¿Quisiste decir <strong style="cursor:pointer;text-decoration:underline" onclick="document.getElementById('leadEmail').value='${_fix}';document.getElementById('emailError').textContent=''">${_fix}</strong>?`;
    document.getElementById('leadEmail').focus(); return;
  }
  if (password.length < 6) {
    errEl.textContent = '⚠ La contraseña debe tener al menos 6 caracteres.';
    document.getElementById('leadPassword').focus(); return;
  }
  errEl.textContent = '';

  const btn = document.getElementById('authSubmitBtn');
  const origText = btn.textContent;
  btn.textContent = '⏳ Procesando...'; btn.disabled = true;

  try {
    const result = authIsLogin
      ? await sbClient.auth.signInWithPassword({ email, password })
      : await sbClient.auth.signUp({ email, password });

    _authDebugLog(`signIn result: error=${result.error?.message||'null'} | session=${result.data?.session?.user?.email||'null'}`);
    if (result.error) {
      // Si el error es "ya registrado" → auto-cambiar a login y avisar
      if (result.error.message?.includes('User already registered')) {
        errEl.textContent = '✅ Ya tenés cuenta — te cambiamos a inicio de sesión.';
        errEl.style.color = 'var(--verde)';
        setTimeout(() => { errEl.style.color = ''; toggleAuthMode(); }, 1200);
      } else {
        errEl.textContent = '⚠ ' + sbTranslateError(result.error.message);
      }
    } else if (!authIsLogin) {
      // Registro exitoso: mostrar feedback mientras onAuthStateChange toma el control
      errEl.textContent = '✅ ¡Cuenta creada! Iniciando sesión...';
      errEl.style.color = 'var(--verde)';
      setTimeout(() => { errEl.style.color = ''; errEl.textContent = ''; }, 4000);
    }
    // onAuthStateChange cierra el modal y carga los datos del usuario automáticamente
  } catch(e) {
    errEl.textContent = '⚠ Error de conexión. Intentá de nuevo.';
  } finally {
    btn.textContent = origText; btn.disabled = false;
  }
}

// ── Perfiles VIP — overrides forzados por email ──────────────
const GAMBETA_VIP = {
  'mauro.union10@gmail.com': {
    nickname:  'Mauro Latam',
    suffix:    ' 🎩',
    nameColor: '#ffd600',   // dorado — se distingue del resto en tablas y ranking
    avatar: {
      id:    'union_santa_fe',
      name:  'Unión Santa Fe',
      color: '#c8002a',
      logo:  'data:image/png;base64,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'
    }
  }
};

function updateNavAuth() {
  _authDebugLog(`updateNavAuth() → ${authUser?.email||'null'}`);
  document.getElementById('navAuthBtn').style.display = 'none';
  // Switch nav: hide guest links, show user links
  const guestLinks = document.getElementById('navLinksGuest');
  const userLinks  = document.getElementById('navLinksUser');
  if (guestLinks) guestLinks.style.display = 'none';
  if (userLinks)  userLinks.style.display  = '';
  // Mobile drawer
  const dGuest = document.getElementById('drawerLinksGuest');
  const dUser  = document.getElementById('drawerLinksUser');
  if (dGuest) dGuest.style.display = 'none';
  if (dUser)  dUser.style.display  = '';
  const wrap = document.getElementById('navUserWrap');
  wrap.classList.add('visible');
  // ── Avatar y nombre — se asignan PRIMERO para que nunca queden como "?" / "Usuario" ──
  const safeName = authUser.name || authUser.email?.split('@')[0] || 'Usuario';
  const initials = safeName.split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
  const _isVipUser = !!(authUser?.email && GAMBETA_VIP[authUser.email]);
  const _vipData   = _isVipUser ? GAMBETA_VIP[authUser.email] : null;
  if (!_isVipUser) {
    document.getElementById('navUserAvatar').textContent = initials;
  } else {
    // VIP: poner escudo inmediatamente aquí mismo, sin esperar a applyUserProfile
    try {
      const _ael = document.getElementById('navUserAvatar');
      const _lurl = _vipData?.avatar?.logo;
      const _lname = _vipData?.avatar?.name || '';
      if (_ael && _lurl) {
        _ael.innerHTML = `<img loading="lazy" decoding="async" src="${_lurl}" alt="${_lname}" style="width:75%;height:75%;object-fit:contain;filter:drop-shadow(0 1px 4px rgba(0,0,0,0.5))">`;
        _ael.style.background = 'transparent';
        _ael.style.border = 'none';
        _ael.style.borderRadius = '0';
      }
      const _dua = document.getElementById('drawerUserAvatar');
      if (_dua && _lurl) {
        _dua.innerHTML = `<img loading="lazy" decoding="async" src="${_lurl}" alt="${_lname}" style="width:80%;height:80%;object-fit:contain;">`;
        _dua.style.background = 'transparent';
      }
    } catch(_e) { console.warn('[VIP] avatar inline error:', _e); }
  }
  const _vipDisplayName = _vipData ? (_vipData.nickname || '') + (_vipData.suffix || '') : null;
  document.getElementById('navUserName').textContent = (_vipDisplayName || safeName).split(' ')[0];
  document.getElementById('ddName').textContent = safeName;
  document.getElementById('ddEmail').textContent = authUser.email || '';
  // Drawer user row (mobile)
  const dua = document.getElementById('drawerUserAvatar');
  if (dua && !_isVipUser) dua.textContent = initials;
  const dun = document.getElementById('drawerUserName');
  if (dun) dun.textContent = safeName;
  const due = document.getElementById('drawerUserEmail');
  if (due) due.textContent = authUser.email || '';
  // Mostrar campana inbox y actualizar badge
  const bellBtn = document.getElementById('inboxBellBtn');
  if (bellBtn) bellBtn.style.display = 'flex';
  try { _updateInboxBadge(); } catch(e) { console.warn('[GAMBETA] _updateInboxBadge:', e); }
  // Mi Panel oculto del home (14-may-2026): NO se desbloquea en login.
  // Sigue actualizándose el username para evitar errores si alguien lo lee.
  document.getElementById('mipanelUser').textContent = '— ' + safeName.split(' ')[0];
  document.getElementById('bkLockOverlay').style.display = 'none';
  document.getElementById('bankrollContent').style.display = '';
  const drawerLink = document.getElementById('drawerPanelLink');
  if (drawerLink) drawerLink.style.display = '';
  const drawerAuthRow = document.getElementById('drawerAuthRow');
  if (drawerAuthRow) drawerAuthRow.style.display = 'none';
  renderBankrollSummary();
  setTimeout(drawBankrollChart, 80);
  renderBetsList();
  renderMyPanel();
  applyUserProfile(); // apodo + escudo si ya completó el onboarding
  renderMyPicks();   // panel de stats personales 
  initPushUI();      // mostrar card de notificaciones push
}

function toggleUserMenu() {
  document.getElementById('userDropdown').classList.toggle('open');
}
function closeUserMenu() {
  document.getElementById('userDropdown').classList.remove('open');
}
function logoutUser() {
  sbClient.auth.signOut(); // cierra sesión en Supabase
  authUser = null;
  pendingSocial = null;
  document.getElementById('navUserWrap').classList.remove('visible');
  document.getElementById('navAuthBtn').style.display = '';
  const bellBtn = document.getElementById('inboxBellBtn');
  if (bellBtn) bellBtn.style.display = 'none';
  // Switch nav back to guest
  const guestLinks = document.getElementById('navLinksGuest');
  const userLinks  = document.getElementById('navLinksUser');
  if (guestLinks) guestLinks.style.display = '';
  if (userLinks)  userLinks.style.display  = 'none';
  // Mobile drawer
  const dGuest = document.getElementById('drawerLinksGuest');
  const dUser  = document.getElementById('drawerLinksUser');
  if (dGuest) dGuest.style.display = '';
  if (dUser)  dUser.style.display  = 'none';
  closeUserMenu();
  document.getElementById('mipanel').style.display = 'none';
  const lockOverlay = document.getElementById('bkLockOverlay');
  if (lockOverlay) lockOverlay.style.display = '';
  const drawerLink = document.getElementById('drawerPanelLink');
  if (drawerLink) drawerLink.style.display = 'none';
}

// ── Auth debug — log siempre activo en consola; panel visual con ?authdebug ──
const _AUTH_DEBUG = new URLSearchParams(location.search).has('authdebug');
const _authLog = [];
function _authDebugLog(msg) {
  const t = new Date().toLocaleTimeString('es-AR', { hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const entry = `[${t}] ${msg}`;
  _authLog.unshift(entry);
  if (_authLog.length > 50) _authLog.pop();
  try { localStorage.setItem('_auth_debug_log', JSON.stringify(_authLog)); } catch {}
  const box = document.getElementById('_authDebugBox');
  if (box) box.innerHTML = _authLog.map(e => `<div style="padding:1px 0;border-bottom:1px solid rgba(255,255,255,0.07)">${e}</div>`).join('');
}
function _authDebugShow() {
  if (!_AUTH_DEBUG || document.getElementById('_authDebugPanel')) return;
  const panel = document.createElement('div');
  panel.id = '_authDebugPanel';
  panel.style.cssText = 'position:fixed;bottom:90px;left:12px;z-index:99999;background:#050f05;border:1px solid #00c853;border-radius:10px;padding:10px 12px;width:300px;font-size:0.66rem;font-family:monospace;color:#00c853;max-height:260px;overflow-y:auto;box-shadow:0 4px 24px rgba(0,200,83,0.35)';
  panel.innerHTML = '<div style="font-weight:900;margin-bottom:5px;color:#fff;font-size:0.72rem">🔐 Auth Debug</div><div id="_authDebugBox"><div style="color:#888">Esperando eventos...</div></div>';
  document.body.appendChild(panel);
}
if (_AUTH_DEBUG) { window.addEventListener('load', _authDebugShow); }

// 🔧 Helper: ocultar section-dividers cuya sección siguiente esté oculta (evita barras apiladas)
function _hideOrphanDividers() {
  document.querySelectorAll('.section-divider').forEach(div => {
    if (div.dataset._dividerForceShow === '1') return;
    let nx = div.nextElementSibling;
    // Saltear hermanos vacíos hasta encontrar uno con contenido
    while (nx && nx.tagName === 'SCRIPT') nx = nx.nextElementSibling;
    if (!nx) { div.style.display = 'none'; return; }
    const cs = getComputedStyle(nx);
    const hidden = cs.display === 'none' || nx.hasAttribute('hidden') || nx.offsetParent === null && cs.position !== 'fixed';
    div.style.display = hidden ? 'none' : '';
  });
}
window.addEventListener('load', () => { _hideOrphanDividers(); setTimeout(_hideOrphanDividers, 1500); });
// Re-evaluar cuando cambien las secciones (login/logout)
document.addEventListener('visibilitychange', () => { if (!document.hidden) _hideOrphanDividers(); });

// ── Manejo centralizado de sesión autenticada ──
let _sessionHandled = false; // evita doble ejecución entre onAuthStateChange y getSession()
async function _handleAuthSession(u) {
  _authDebugLog(`✅ _handleAuthSession: ${u.email}`);
  if (authUser?.email === u.email) { _authDebugLog('↩ Guard: mismo usuario, skip'); return; } // ya procesado
  const rawName = u.user_metadata?.full_name || u.user_metadata?.name || u.email.split('@')[0];
  const name = rawName.replace(/[._-]/g,' ').replace(/\b\w/g, c => c.toUpperCase());
  authUser = { name, email: u.email, provider: u.app_metadata?.provider || 'email', joined: new Date(u.created_at).toLocaleDateString('es') };
  window._currentUser = { name, email: u.email }; // expuesto globalmente para módulos como el foro
  // Si el foro está abierto con el CTA de registro, reemplazarlo por el formulario
  setTimeout(() => {
    const joinCta = document.querySelector('.fp-join-cta');
    if (joinCta) {
      const form = document.createElement('div');
      form.className = 'fp-form'; form.id = 'fpForm';
      if (typeof _fpFormHtml === 'function') form.innerHTML = _fpFormHtml();
      joinCta.replaceWith(form);
    }
  }, 200);
  updateNavAuth();
  loadBankrollData();
  await acLoadFromDB(u.email);
  await sbLoadHistorial();
  initUserSync(u.email);
  checkBroadcastMessages();   // ahora sí: usuario registrado → puede ver mensajes
  closeAuth();
  // Migración puntual: elevar picks a Máxima si admin y aún no están en bvr=6
  if (u.email === ADMIN_EMAIL) _adminMigrateMaxima();
  // Reconciliar shared_cache ↔ acoin_users (admin only).
  // Garantiza que los anónimos no vean picks viejos si quedó stale.
  if (u.email === ADMIN_EMAIL) setTimeout(() => sbReconcileSharedCache(), 2000);
  checkOnboarding();
  // Bienvenida: mostrar solo a usuarios nuevos (creados hace <90s) y que no hayan visto el modal
  try {
    const _isNew = u.created_at && (Date.now() - new Date(u.created_at).getTime()) < 90000;
    const _alreadyWelcomed = localStorage.getItem('gb_welcomed_v1') === '1';
    if (_isNew && !_alreadyWelcomed) {
      setTimeout(() => showWelcome(authUser.name), 700); // pequeño delay para que cierre el auth modal primero
    }
  } catch(_) {}
  // Re-aplicar avatar/apodo después de que todo el setup async haya terminado.
  // Esto garantiza que el escudo VIP/club se muestre aunque algún paso previo
  // haya sobreescrito el avatar durante la carga inicial.
  setTimeout(applyUserProfile, 300);
  // Si el usuario vino del blog, volver al blog después del login
  const _returnTo = sessionStorage.getItem('_gb_return_to');
  if (_returnTo) {
    sessionStorage.removeItem('_gb_return_to');
    setTimeout(() => { window.location.href = _returnTo; }, 600);
    return;
  }
  // Restaurar sección guardada antes del redirect OAuth (Google login)
  const _savedHash = sessionStorage.getItem('_gb_oauth_hash');
  if (_savedHash) {
    sessionStorage.removeItem('_gb_oauth_hash');
    if (_savedHash && _savedHash !== '#') {
      setTimeout(() => {
        const el = document.querySelector(_savedHash);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 400);
    }
  }
}

// ── Escucha cambios de sesión Supabase (login/logout/refresh de token) ──
sbClient.auth.onAuthStateChange(async (event, session) => {
  _authDebugLog(`EVENT: ${event} | user: ${session?.user?.email || 'null'}`);
  if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') && session?.user) {
    await _handleAuthSession(session.user);
  } else if (event === 'SIGNED_OUT') {
    _authDebugLog('⚠️ SIGNED_OUT recibido — verificando sesión real...');
    setTimeout(async () => {
      try {
        const { data: { session: currentSession } } = await sbClient.auth.getSession();
        _authDebugLog(`getSession post-SIGNED_OUT: ${currentSession?.user?.email || 'null'}`);
        if (currentSession?.user) {
          _authDebugLog('✅ Falso SIGNED_OUT — restaurando UI');
          await _handleAuthSession(currentSession.user);
          return;
        }
      } catch (e) { _authDebugLog(`getSession error: ${e.message}`); }
      _authDebugLog('🔴 Sesión realmente terminada — limpiando UI');
      if (authUser) {
        clearBankrollData();
        authUser = null;
        window._currentUser = null;
        pendingSocial = null;
        document.getElementById('navUserWrap').classList.remove('visible');
        document.getElementById('navAuthBtn').style.display = '';
        closeUserMenu();
        document.getElementById('mipanel').style.display = 'none';
        const lo = document.getElementById('bkLockOverlay');
        if (lo) lo.style.display = '';
        const dl = document.getElementById('drawerPanelLink');
        if (dl) dl.style.display = 'none';
        const da = document.getElementById('drawerAuthRow');
        if (da) da.style.display = '';
        // Resetear nav links (guest/user) — mismo que logoutUser()
        const guestLinks = document.getElementById('navLinksGuest');
        const userLinks  = document.getElementById('navLinksUser');
        if (guestLinks) guestLinks.style.display = '';
        if (userLinks)  userLinks.style.display  = 'none';
        const dGuest = document.getElementById('drawerLinksGuest');
        const dUser  = document.getElementById('drawerLinksUser');
        if (dGuest) dGuest.style.display = '';
        if (dUser)  dUser.style.display  = 'none';
      }
    }, 2000); // 2s de gracia — da tiempo a que getSession() complete incluso en redes lentas
  }
});

// ── Fallback: getSession() por si INITIAL_SESSION no disparó ──
sbClient.auth.getSession().then(({ data: { session } }) => {
  _authDebugLog(`getSession inicial: ${session?.user?.email || 'null'}`);
  if (session?.user && !authUser) {
    _authDebugLog('⚡ getSession fallback activado');
    _handleAuthSession(session.user);
  }
  // ── Google One Tap: si NO hay sesión, mostrar popup automático ──
  if (!session?.user) {
    setTimeout(_initGoogleOneTap, 1200);
  }
}).catch((e) => { _authDebugLog(`getSession inicial error: ${e.message}`); });

// ── Google One Tap (auto-login popup) ──
const _GOOGLE_CLIENT_ID = '84669131755-ms8qkjcbt7doi6e5ciqof2j6umb1as8b.apps.googleusercontent.com';
const _ONETAP_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h entre prompts si el usuario lo descartó

async function _initGoogleOneTap() {
  try {
    // No mostrar si ya hay sesión
    const { data: { session } } = await sbClient.auth.getSession();
    if (session?.user) return;
    // Cooldown: si el usuario lo cerró/descartó hace menos de 24h, no insistir
    const lastDismiss = parseInt(localStorage.getItem('_gb_onetap_dismissed') || '0');
    if (lastDismiss && (Date.now() - lastDismiss) < _ONETAP_COOLDOWN_MS) return;

    // Cargar el script de Google Identity Services on demand
    if (!window.google?.accounts?.id) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true; s.defer = true;
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      }).catch(() => null);
    }
    if (!window.google?.accounts?.id) { console.warn('[OneTap] GIS no disponible'); return; }

    // Nonce para Supabase (signInWithIdToken lo verifica)
    const nonceRaw = crypto.randomUUID();
    const nonceHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonceRaw))
      .then(buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join(''));

    google.accounts.id.initialize({
      client_id: _GOOGLE_CLIENT_ID,
      callback: async (response) => {
        try {
          const { data, error } = await sbClient.auth.signInWithIdToken({
            provider: 'google',
            token: response.credential,
            nonce: nonceRaw,
          });
          if (error) { console.warn('[OneTap] signIn err:', error.message); return; }
          _authDebugLog(`✅ OneTap login: ${data?.user?.email}`);
          // onAuthStateChange se encarga del resto
        } catch (e) { console.warn('[OneTap] callback err:', e.message); }
      },
      nonce: nonceHash,
      auto_select: true,    // intenta seleccionar automáticamente al usuario si está logueado en Google
      cancel_on_tap_outside: false,
      use_fedcm_for_prompt: true,
    });
    google.accounts.id.prompt((notif) => {
      // Guardar timestamp de descarte para respetar el cooldown
      if (notif.isSkippedMoment?.() || notif.isDismissedMoment?.()) {
        try { localStorage.setItem('_gb_onetap_dismissed', String(Date.now())); } catch(_) {}
      }
    });
  } catch (e) { console.warn('[OneTap] init err:', e.message); }
}

// ── Health check: verifica cada 90s que el estado JS coincide con Supabase ──
// Detecta edge cases donde la UI queda desfasada respecto a la sesión real
setInterval(async () => {
  try {
    const { data: { session } } = await sbClient.auth.getSession();
    if (session?.user && !authUser) {
      // Hay sesión en Supabase pero la UI no lo refleja → restaurar
      _authDebugLog(`🔧 Health check: sesión activa pero UI en logged-out → restaurando`);
      await _handleAuthSession(session.user);
    } else if (!session?.user && authUser) {
      // UI dice logged-in pero Supabase no tiene sesión → limpiar
      _authDebugLog(`🔧 Health check: UI logged-in pero sin sesión → verificando...`);
      // Pequeño delay y re-verificar antes de limpiar (misma lógica que SIGNED_OUT)
      await new Promise(r => setTimeout(r, 1000));
      const { data: { session: s2 } } = await sbClient.auth.getSession();
      if (!s2?.user && authUser) {
        _authDebugLog(`🔧 Health check: confirmado sin sesión → limpiando UI`);
        authUser = null;
        document.getElementById('navUserWrap').classList.remove('visible');
        document.getElementById('navAuthBtn').style.display = '';
      }
    }
  } catch(e) { _authDebugLog(`health check error: ${e.message}`); }
}, 90 * 1000);

// Close dropdown on outside click
document.addEventListener('click', e => {
  const wrap = document.getElementById('navUserWrap');
  if (wrap && !wrap.contains(e.target)) closeUserMenu();
});

/* ── MI PANEL ── */
function switchPanelTab(tabId, btn) {
  document.querySelectorAll('.mipanel-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.mipanel-pane').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('panel' + tabId.charAt(0).toUpperCase() + tabId.slice(1)).classList.add('active');
  if (tabId === 'stats')   setTimeout(drawMyPanelChart, 50);
  if (tabId === 'premios') renderPremios();
}

function renderMyPanel() {
  renderMyBets();
  renderMyStats();
  renderMyTips();
}

// ═══════════════════════════════════════════
//  PREMIOS —  rewards catalog
// ═══════════════════════════════════════════
const PREMIOS_DATA = [
  // Tier 1 — $20 USD
  { tier:1, casa:'DBbet',       logo:'https://www.google.com/s2/favicons?domain=dbbetbet.com&sz=64',       usd:20,  cost:100000, sponsor:true },
  { tier:1, casa:'Melbet',      logo:'https://www.google.com/s2/favicons?domain=melbet.com&sz=64',       usd:20,  cost:120000 },
  { tier:1, casa:'Megapari',    logo:'https://www.google.com/s2/favicons?domain=megapari.com&sz=64',     usd:20,  cost:140000 },
  { tier:1, casa:'BetWinner',   logo:'https://www.google.com/s2/favicons?domain=betwinner.com&sz=64',    usd:20,  cost:140000 },
  { tier:1, casa:'DBbet',       logo:'https://www.google.com/s2/favicons?domain=db-bet.com&sz=64',       usd:20,  cost:140000 },
  // Tier 2 — $70 USD
  { tier:2, casa:'DBbet',       logo:'https://www.google.com/s2/favicons?domain=dbbetbet.com&sz=64',       usd:70,  cost:330000, sponsor:true },
  { tier:2, casa:'Melbet',      logo:'https://www.google.com/s2/favicons?domain=melbet.com&sz=64',       usd:70,  cost:320000 },
  { tier:2, casa:'Megapari',    logo:'https://www.google.com/s2/favicons?domain=megapari.com&sz=64',     usd:70,  cost:370000 },
  { tier:2, casa:'BetWinner',   logo:'https://www.google.com/s2/favicons?domain=betwinner.com&sz=64',    usd:70,  cost:370000 },
  { tier:2, casa:'DBbet',       logo:'https://www.google.com/s2/favicons?domain=db-bet.com&sz=64',       usd:70,  cost:370000 },
  // Tier 3 — $230 USD
  { tier:3, casa:'DBbet',       logo:'https://www.google.com/s2/favicons?domain=dbbetbet.com&sz=64',       usd:230, cost:980000,  sponsor:true },
  { tier:3, casa:'Melbet',      logo:'https://www.google.com/s2/favicons?domain=melbet.com&sz=64',       usd:230, cost:1020000 },
  { tier:3, casa:'Megapari',    logo:'https://www.google.com/s2/favicons?domain=megapari.com&sz=64',     usd:230, cost:1020000 },
  { tier:3, casa:'BetWinner',   logo:'https://www.google.com/s2/favicons?domain=betwinner.com&sz=64',    usd:230, cost:1020000 },
  { tier:3, casa:'DBbet',       logo:'https://www.google.com/s2/favicons?domain=db-bet.com&sz=64',       usd:230, cost:1020000 },
  // Premios especiales
  { tier:4, casa:'MacBook Air', logo:'https://www.google.com/s2/favicons?domain=apple.com&sz=64',        usd:null, cost:2500000, desc:'MacBook Air' },
  { tier:4, casa:'iPhone 17 Pro',logo:'https://www.google.com/s2/favicons?domain=apple.com&sz=64',       usd:null, cost:2500000, desc:'iPhone 17 Pro' },
];

function renderPremios() {
  const bal = acGet();
  // Update balance display
  const balEl = document.getElementById('premiosBal');
  if (balEl) balEl.textContent = bal.toLocaleString('es-AR');

  const containers = { 1:'premTier1', 2:'premTier2', 3:'premTier3', 4:'premTierApple' };
  Object.values(containers).forEach(id => { const el=document.getElementById(id); if(el) el.innerHTML=''; });

  PREMIOS_DATA.forEach(p => {
    const el = document.getElementById(containers[p.tier]);
    if (!el) return;
    const pct   = Math.min(100, Math.round((bal / p.cost) * 100));
    const unlocked = bal >= p.cost;
    const costFmt  = p.cost >= 1000000
      ? (p.cost / 1000000).toFixed(1).replace('.0','') + 'M'
      : (p.cost / 1000).toFixed(0) + 'K';
    const label    = p.desc || (p.usd ? `$${p.usd} USD` : '');
    const card = document.createElement('div');
    card.className = 'premio-card' + (unlocked ? ' unlocked' : '') + (p.sponsor ? ' dbbet-sponsor' : '');
    if (p.sponsor) {
      card.style.cssText = (card.style.cssText || '') + ';border-color:rgba(220, 30, 46,0.7);background:linear-gradient(160deg,#1a0507,#03091a);';
    }
    card.innerHTML = `
      ${p.sponsor ? '<div style="font-size:0.55rem;font-weight:900;color:#FFD700;text-transform:uppercase;letter-spacing:.8px;margin-bottom:2px">🏆 Sponsor</div>' : ''}
      <span class="premio-lock">🔒</span>
      <img class="premio-logo" src="${p.sponsor ? '/img/casas/dbbet.svg' : p.logo}" alt="${p.casa}" onerror="this.src='https://www.google.com/s2/favicons?domain=${p.casa.toLowerCase().replace(/ /g,'')}.com&sz=64'" style="${p.sponsor ? 'filter:brightness(1.1)' : ''}">
      <div class="premio-name">${p.casa}</div>
      <div class="premio-usd">${p.usd ? `$${p.usd} USD` : p.desc}</div>
      <div class="premio-cost"><span class="acico" style="font-size:0.55rem;width:1.5em;height:1.5em"></span> ${costFmt}${p.sponsor ? ' <span style="font-size:0.55rem;color:#FFD700;font-weight:900">★</span>' : ''}</div>
      <div class="premio-prog"><div class="premio-prog-fill" style="width:${pct}%;${p.sponsor ? 'background:linear-gradient(90deg,#dc1e2e,#FFD700)' : ''}"></div></div>
      <div class="premio-pct">${unlocked ? '✅ ¡Podés canjear!' : pct + '% completado'}</div>
    `;
    if (unlocked) {
      card.style.cursor = 'pointer';
      card.title = 'Canjear en Telegram';
      card.onclick = () => window.open('https://t.me/clubdewinners', '_blank');
    }
    el.appendChild(card);
  });
}

function renderMyBets() {
  const el = document.getElementById('myBetsList');
  if (!el) return;
  const hist = [...bankrollData.history].reverse();
  if (!hist.length) { el.innerHTML = '<div style="color:var(--texto-sec);text-align:center;padding:28px 0;font-size:0.9rem">Aún no tenés apuestas registradas.<br>Añadí tu primera apuesta en la sección Bankroll.</div>'; return; }
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr auto auto auto;gap:8px 14px;align-items:center;margin-bottom:8px;padding:0 4px">
      <span style="font-size:0.72rem;color:var(--texto-sec);font-weight:600;text-transform:uppercase;letter-spacing:1px">Partido</span>
      <span style="font-size:0.72rem;color:var(--texto-sec);font-weight:600;text-transform:uppercase;letter-spacing:1px">Cuota</span>
      <span style="font-size:0.72rem;color:var(--texto-sec);font-weight:600;text-transform:uppercase;letter-spacing:1px">Stake</span>
      <span style="font-size:0.72rem;color:var(--texto-sec);font-weight:600;text-transform:uppercase;letter-spacing:1px">P/L</span>
    </div>` +
  hist.map(b => `
    <div style="display:grid;grid-template-columns:1fr auto auto auto;gap:6px 14px;align-items:center;padding:9px 4px;border-bottom:1px solid rgba(255,255,255,0.05)">
      <div>
        <div style="font-size:0.85rem;font-weight:600;color:var(--texto)">${b.match}</div>
        <div style="font-size:0.72rem;color:var(--texto-sec);margin-top:1px">${b.result === 'win' ? '✅ Victoria' : b.result === 'loss' ? '❌ Derrota' : '➖ Empate'}</div>
      </div>
      <span style="font-size:0.88rem;color:var(--texto-sec)">${b.odds}</span>
      <span style="font-size:0.88rem;color:var(--texto-sec)">$${b.stake}</span>
      <span style="font-size:0.9rem;font-weight:700;color:${b.pl >= 0 ? 'var(--verde)' : 'var(--rojo)'}">${b.pl >= 0 ? '+' : ''}$${b.pl}</span>
    </div>`).join('');
}

function renderMyStats() {
  const grid = document.getElementById('myStatsGrid');
  if (!grid) return;
  // 🛡️ Helper: convertir a número saneado (undefined/NaN/null → 0)
  const _n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };
  const hist = (bankrollData.history || []);
  const wins = hist.filter(b => b.result === 'win').length;
  const losses = hist.filter(b => b.result === 'loss').length;
  const draws = hist.filter(b => b.result === 'draw').length;
  const total = hist.length;
  const winRate = total ? ((wins / total) * 100).toFixed(1) : '0.0';
  const totalPL = hist.reduce((s, b) => s + _n(b.pl), 0);
  // Bankroll initial puede ser 0/null/undefined → fallback a suma de stakes para que ROI no sea NaN
  const _stakesSum = hist.reduce((s, b) => s + _n(b.stake), 0);
  const _initial = _n(bankrollData.initial) || _stakesSum;
  const roi = _initial ? ((totalPL / _initial) * 100).toFixed(1) : '0.0';
  const avgOdds = total ? (hist.reduce((s, b) => s + _n(b.odds), 0) / total).toFixed(2) : '—';
  const bestBet = hist.reduce((best, b) => _n(b.pl) > (best ? _n(best.pl) : -Infinity) ? b : best, null);
  const worstBet = hist.reduce((worst, b) => _n(b.pl) < (worst ? _n(worst.pl) : Infinity) ? b : worst, null);

  const stat = (label, value, color = 'var(--texto)') =>
    `<div class="card" style="text-align:center;padding:14px 10px">
      <div style="font-size:1.4rem;font-weight:800;color:${color}">${value}</div>
      <div style="font-size:0.72rem;color:var(--texto-sec);margin-top:3px;text-transform:uppercase;letter-spacing:0.8px">${label}</div>
    </div>`;

  grid.innerHTML =
    stat('Apuestas', total) +
    stat('% Ganadas', winRate + '%', parseFloat(winRate) >= 50 ? 'var(--verde)' : 'var(--amarillo)') +
    stat('Victorias', wins, 'var(--verde)') +
    stat('Derrotas', losses, 'var(--rojo)') +
    stat('ROI', (parseFloat(roi) >= 0 ? '+' : '') + roi + '%', parseFloat(roi) >= 0 ? 'var(--verde)' : 'var(--rojo)') +
    stat('Profit Total', (totalPL >= 0 ? '+' : '') + '$' + totalPL.toFixed(0), totalPL >= 0 ? 'var(--verde)' : 'var(--rojo)') +
    stat('Cuota Prom.', avgOdds, 'var(--azul)') +
    stat('Mejor Bet', bestBet ? '+$' + _n(bestBet.pl).toFixed(0) : '—', 'var(--verde)');
}

function drawMyPanelChart() {
  const canvas = document.getElementById('myPanelChart'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = Math.min(canvas.parentElement.clientWidth || 320, window.innerWidth - 40);
  const H = 180;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);
  const data = calcBankrollHistory();
  if (data.length < 2) return; // necesita al menos 2 puntos para trazar
  const pad = { t: 12, r: 12, b: 24, l: 48 };
  const minV = Math.min(...data) - 40, maxV = Math.max(...data) + 40, range = maxV - minV;
  const tx = i => pad.l + (i / (data.length - 1)) * (W - pad.l - pad.r);
  const ty = v => pad.t + (1 - (v - minV) / range) * (H - pad.t - pad.b);
  ctx.clearRect(0, 0, W, H);
  // grid lines
  for (let i = 0; i <= 3; i++) {
    const y = pad.t + (i / 3) * (H - pad.t - pad.b);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillStyle = '#555'; ctx.font = '9px system-ui'; ctx.textAlign = 'right';
    ctx.fillText('$' + Math.round(maxV - (i / 3) * range), pad.l - 4, y + 4);
  }
  // area fill
  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, 'rgba(0,200,83,0.25)'); grad.addColorStop(1, 'rgba(0,200,83,0.02)');
  ctx.beginPath(); data.forEach((v, i) => i === 0 ? ctx.moveTo(tx(i), ty(v)) : ctx.lineTo(tx(i), ty(v)));
  ctx.lineTo(tx(data.length - 1), H - pad.b); ctx.lineTo(tx(0), H - pad.b); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  // line
  ctx.beginPath(); data.forEach((v, i) => i === 0 ? ctx.moveTo(tx(i), ty(v)) : ctx.lineTo(tx(i), ty(v)));
  ctx.strokeStyle = '#00c853'; ctx.lineWidth = 2.2; ctx.lineJoin = 'round'; ctx.stroke();
  // dots
  data.forEach((v, i) => {
    ctx.beginPath(); ctx.arc(tx(i), ty(v), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#00c853'; ctx.fill(); ctx.strokeStyle = '#0d1a0d'; ctx.lineWidth = 1.5; ctx.stroke();
  });
  // baseline
  ctx.setLineDash([3, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.l, ty(bankrollData.initial)); ctx.lineTo(W - pad.r, ty(bankrollData.initial)); ctx.stroke();
  ctx.setLineDash([]);
}

function renderMyTips() {
  const el = document.getElementById('myTipsList'); if (!el) return;
  const hist = bankrollData.history;
  const wins = hist.filter(b => b.result === 'win').length;
  const total = hist.length;
  const winRate = total ? wins / total : 0;
  const totalPL = hist.reduce((s, b) => s + b.pl, 0);
  const avgOdds = total ? hist.reduce((s, b) => s + b.odds, 0) / total : 0;
  const longStreak = hist.reduce((acc, b) => {
    if (b.result === 'loss') { acc.cur = 0; } else { acc.cur++; acc.max = Math.max(acc.max, acc.cur); } return acc;
  }, { cur: 0, max: 0 }).max;

  const tips = [];

  // Tip 1: Win rate
  if (winRate < 0.45) {
    tips.push({ icon: '🎯', title: 'Mejorá tu selección', color: 'var(--rojo)',
      body: `Tu tasa de acierto es del ${(winRate*100).toFixed(0)}%, por debajo del umbral rentable. Enfocate en mercados donde tengas ventaja real: apostá menos eventos pero con mayor convicción. Calidad sobre cantidad.` });
  } else if (winRate >= 0.6) {
    tips.push({ icon: '🏆', title: 'Excelente tasa de acierto', color: 'var(--verde)',
      body: `Con un ${(winRate*100).toFixed(0)}% de acierto estás muy por encima de la media. Considerá aumentar gradualmente el stake en apuestas de alta confianza.` });
  } else {
    tips.push({ icon: '✅', title: 'Tasa de acierto sólida', color: 'var(--verde)',
      body: `Un ${(winRate*100).toFixed(0)}% es una base rentable. Mantené la disciplina y evitá apostar por impulso después de una racha de victorias.` });
  }

  // Tip 2: Odds
  if (avgOdds < 1.6) {
    tips.push({ icon: '📉', title: 'Cuotas muy bajas', color: 'var(--amarillo)',
      body: `Tus cuotas promedio (${avgOdds.toFixed(2)}) son bajas. Cuotas de 1.4-1.6 requieren tasas de acierto del 63-71% para ser rentables a largo plazo. Buscá valor en cuotas entre 1.7 y 2.5.` });
  } else if (avgOdds > 2.5) {
    tips.push({ icon: '⚡', title: 'Apuestas de alto riesgo', color: 'var(--naranja)',
      body: `Tus cuotas promedio (${avgOdds.toFixed(2)}) son altas, lo que implica mayor varianza. Para este perfil, usá stakes más bajos (3-5% del bankroll) y gestioná las rachas negativas con paciencia.` });
  } else {
    tips.push({ icon: '💡', title: 'Zona de valor óptima', color: 'var(--azul)',
      body: `Tus cuotas promedio (${avgOdds.toFixed(2)}) están en el rango ideal para maximizar el ROI con una buena tasa de acierto. Seguí buscando valor en esa franja.` });
  }

  // Tip 3: Bankroll management
  if (totalPL > 0) {
    tips.push({ icon: '📈', title: 'Gestioná tu crecimiento', color: 'var(--verde)',
      body: `Estás en positivo (+$${totalPL.toFixed(0)}). Rebalanceá tu stake al 3-5% del bankroll actual para aprovechar el capital ganado. No retirés ganancias hasta duplicar el bankroll inicial.` });
  } else {
    tips.push({ icon: '🛡️', title: 'Protegé tu bankroll', color: 'var(--naranja)',
      body: `Estás en negativo (-$${Math.abs(totalPL).toFixed(0)}). Reducí el stake al 2-3% del bankroll para sobrevivir la racha y recuperarte gradualmente. Nunca aceptes "apuestas de recuperación" de cuotas muy altas.` });
  }

  // Tip 4: Deportes y mercados
  tips.push({ icon: '🤖', title: 'Consejo IA del día', color: 'var(--azul)',
    body: `La IA detecta que los mercados de tenis (ganador del partido) y fútbol europeo (totales de goles) ofrecen mayor eficiencia estadística esta semana. El modelo recomienda enfocarse en partidos con cuotas entre 1.75 y 2.10 con +65% de probabilidad implícita.` });

  el.innerHTML = tips.map(t => `
    <div class="card" style="margin-bottom:12px;border-left:3px solid ${t.color}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
        <span style="font-size:1.2rem">${t.icon}</span>
        <span style="font-size:0.9rem;font-weight:700;color:${t.color}">${t.title}</span>
      </div>
      <p style="font-size:0.83rem;color:var(--texto-sec);line-height:1.6;margin:0">${t.body}</p>
    </div>`).join('');
}
// ═══════════════════════════════════════════════
//  $A-COIN SYSTEM
// ═══════════════════════════════════════════════

/* ── Core helpers ── */
function acGet()  { return parseInt(localStorage.getItem(AC_BAL) || '0'); }
function acSet(v) { localStorage.setItem(AC_BAL, Math.max(0, v)); acUpdateUI(); }
function acAdd(delta, reason) {
  const newBal = Math.max(0, acGet() + delta);
  localStorage.setItem(AC_BAL, newBal);
  const h = JSON.parse(localStorage.getItem(AC_HIST) || '[]');
  h.unshift({ delta, reason, balance: newBal, ts: Date.now() });
  if (h.length > 80) h.pop();
  localStorage.setItem(AC_HIST, JSON.stringify(h));
  acUpdateUI();
  acScheduleSync(); // persist to Supabase
}
function acGetPicks()   { return JSON.parse(localStorage.getItem(AC_PICK) || '[]'); }
function acSavePicks(p) { localStorage.setItem(AC_PICK, JSON.stringify(p)); acScheduleSync(); }
// Purgar picks evaluados con más de 30 días para no inflar localStorage indefinidamente
function acPurgeOldPicks() {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const picks = acGetPicks();
  const before = picks.length;
  const fresh = picks.filter(p => !p.evaluated || !p.ts || p.ts > cutoff);
  if (fresh.length < before) {
    acSavePicks(fresh);
    console.log(`[] Purged ${before - fresh.length} evaluated picks older than 30 days`);
  }
}
function acFmt(n) {
  const abs = Math.abs(n);
  if (abs >= 1000000) { const m = (abs/1000000).toFixed(2).replace(/\.?0+$/, ''); return m + 'M'; }
  if (abs >= 10000)   return Math.round(abs/1000) + 'K';
  if (abs >= 1000)    { const k = (abs/1000).toFixed(1).replace(/\.0$/, ''); return k + 'K'; }
  return abs.toString();
}
function acFmtShort(n) {
  const abs = Math.abs(n);
  if (abs >= 1000000) { const m = (abs/1000000).toFixed(2).replace(/\.?0+$/, ''); return m + 'M'; }
  if (abs >= 10000)   return Math.round(abs/1000) + 'K';
  if (abs >= 1000)    { const k = (abs/1000).toFixed(1).replace(/\.0$/, ''); return k + 'K'; }
  return abs.toString();
}

/* ── UI update ── */
function acUpdateUI() {
  const bal = acGet();
  const fmt = acFmt(bal);
  const el = document.getElementById('acoinNavBal');
  if (el) el.textContent = acFmtShort(bal);
  const pb = document.getElementById('acoinPanelBal');
  if (pb) pb.textContent = fmt;
  const pct = Math.min(100, Math.round(bal / AC_GOAL * 100));
  const pctEl = document.getElementById('acoinPanelPct');
  if (pctEl) pctEl.textContent = pct + '%';
  const fill = document.getElementById('acoinProgressFill');
  if (fill) fill.style.width = pct + '%';
  const redeem = document.getElementById('acoinRedeemBanner');
  if (redeem) redeem.style.display = bal >= AC_GOAL ? 'block' : 'none';
  // Update Premios balance display if visible
  const premBal = document.getElementById('premiosBal');
  if (premBal) premBal.textContent = acFmt(bal);
  acRenderHist();
}

function acRenderHist() {
  const list = document.getElementById('acoinHistList');
  if (!list) return;
  const h = JSON.parse(localStorage.getItem(AC_HIST) || '[]');
  if (!h.length) {
    list.innerHTML = '<div style="font-size:0.75rem;color:rgba(255,255,255,0.25);padding:6px 0">Sin movimientos aún</div>';
    return;
  }
  list.innerHTML = h.slice(0, 20).map(item => {
    const date = new Date(item.ts).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    const cls  = item.delta >= 0 ? 'pos' : 'neg';
    const sign = item.delta >= 0 ? '+' : '−';
    return `<div class="acoin-hist-item">
      <span style="color:var(--texto-sec);font-size:0.72rem;flex:1;margin-right:8px">${item.reason}</span>
      <span style="color:rgba(255,255,255,0.3);font-size:0.65rem;margin-right:8px;white-space:nowrap">${date}</span>
      <span class="acoin-hist-delta ${cls}">${sign}${acFmt(item.delta)}</span>
    </div>`;
  }).join('');
}

function openAcoinPanel()  { /*  removido */ }
function closeAcoinPanel() { /*  removido */ }

/* ── Toast ── */
let _toastTimer = null;
function acToast(icon, title, sub) {
  // ──  desactivado: silenciar cualquier toast que mencione coins/ ──
  const _txt = ((title || '') + ' ' + (sub || '')).toLowerCase();
  if (_txt.includes('coin') || _txt.includes('g$') || _txt.includes('recarga') || _txt.includes('saldo')) return;
  const t = document.getElementById('acoinToast');
  if (!t) return;
  document.getElementById('acoinToastIcon').innerHTML  = icon;
  document.getElementById('acoinToastTitle').innerHTML = title;
  document.getElementById('acoinToastSub').innerHTML   = sub;
  // Reiniciar animación: quitar y re-agregar la clase
  t.classList.remove('show');
  void t.offsetWidth; // forzar reflow
  t.classList.add('show');
  clearTimeout(_toastTimer);
  // Duración: 4.9s (1s más que antes, pedido de Mauro)
  _toastTimer = setTimeout(() => t.classList.remove('show'), 4900);
}

// ── Toast de bienvenida para visitantes NO logueados: invita a registrarse gratis ──
// Solo visitantes NUEVOS y un máximo de 2 veces en total (contador persistente).
function welcomeRegisterToast() {
  try {
    if (typeof authUser !== 'undefined' && authUser && authUser.email) return; // ya logueado
    const KEY = 'gb_welcome_toast_count_v2';
    const count = parseInt(localStorage.getItem(KEY) || '0', 10);
    if (count >= 2) return;                                  // ya se mostró el máximo (2 veces)
    if (count === 0) {
      // Primera vez que corre: si el visitante ya tenía historial guardado
      // no es "nuevo" → marcar como agotado y no mostrar.
      let _established = false;
      try { _established = (JSON.parse(localStorage.getItem('apuestas_historial_v1') || '[]') || []).length > 0; } catch (e) {}
      if (_established) { localStorage.setItem(KEY, '2'); return; }
    }
    localStorage.setItem(KEY, String(count + 1));            // registrar esta aparición
    setTimeout(() => {
      acToast('🎁', 'Creá tu cuenta gratis', 'Guardá tu historial y seguí tus picks favoritos · 100% gratis');
    }, 1600);
  } catch (e) {}
}

/* ── Marcar quiebra: llamar cuando el balance llega a 0 sin picks pendientes ── */
function acCheckBust() {
  if (acGet() > 0) return;
  if (acGetPicks().filter(p => !p.evaluated).length > 0) return;
  if (localStorage.getItem(AC_BUST)) return; // ya registrado
  const today = new Date().toLocaleDateString('en-CA');
  localStorage.setItem(AC_BUST, today);
  acScheduleSync();
  acToast('💸', 'Te quedaste sin ', 'Mañana te recargamos  10.000 para que vuelvas a jugar 💪');
}

/* ── Daily bonus ── */
function acCheckDaily() {
  const today = new Date().toLocaleDateString('en-CA');
  const pendingPicks = acGetPicks().filter(p => !p.evaluated);

  // ── Recarga de emergencia: quedó en 0 el día anterior ──────────────────
  const bustDate = localStorage.getItem(AC_BUST);
  if (bustDate && bustDate < today && pendingPicks.length === 0) {
    localStorage.removeItem(AC_BUST);
    const bal = acGet();
    const topUp = 10000 - bal;
    if (topUp > 0) {
      acAdd(topUp, '💸 Recarga de emergencia');
      localStorage.setItem(AC_DAY, today);
      acScheduleSync();
      setTimeout(() => {
        acToast('💸', `+${acFmt(topUp)} ${AC_ICON} `, '¡Recarga lista! Seguí apostando 🔥');
        _addCoinNotif('💸', `+${acFmt(topUp)}  `, 'Recarga de emergencia — ¡dale de nuevo!');
      }, 1200);
      return;
    }
  }

  // ── Recarga retroactiva: quedó en 0 sin AC_BUST (quiebra anterior al feature) ──
  // Si es un día nuevo y el balance es 0 sin picks pendientes → recarga directa
  if (localStorage.getItem(AC_DAY) !== today) {
    const bal = acGet();
    if (bal === 0 && pendingPicks.length === 0) {
      localStorage.removeItem(AC_BUST);
      acAdd(10000, '💸 Recarga de emergencia');
      localStorage.setItem(AC_DAY, today);
      acScheduleSync();
      setTimeout(() => {
        acToast('💸', `+${acFmt(10000)} ${AC_ICON} `, '¡Recarga lista! Seguí apostando 🔥');
        _addCoinNotif('💸', `+${acFmt(10000)}  `, 'Recarga de emergencia — ¡dale de nuevo!');
      }, 1200);
      return;
    }
  }

  if (localStorage.getItem(AC_DAY) === today) return;
  const bal = acGet();
  // Si ya tiene saldo completo, marcar el día igualmente (no necesita recarga)
  if (bal >= 10000) { localStorage.setItem(AC_DAY, today); return; }
  // NO recargar mientras haya apuestas sin resolver —
  // cuando se resuelvan, acEvaluatePicks() volverá a llamar acCheckDaily()
  if (pendingPicks.length > 0) return; // no marcar AC_DAY → reintentará al resolver
  const topUp = 10000 - bal;
  acAdd(topUp, '🌅 Bonus diario');
  localStorage.setItem(AC_DAY, today);
  setTimeout(() => { acToast('🌅', `+${acFmt(topUp)} ${AC_ICON} `, 'Bonus diario recibido'); _addCoinNotif('🌅', `+${acFmt(topUp)}  `, 'Bonus diario recibido'); }, 1200);
}

/* ── Bet state ── */
window._acBetState = {};  // matchId -> { choice, odds, amount }

function acSelectOutcome(matchId, choice, odds) {
  window._acBetState[matchId] = window._acBetState[matchId] || {};
  window._acBetState[matchId].choice = choice;
  window._acBetState[matchId].odds   = odds;
  window._acBetState[matchId].amount = null;
  // Highlight chosen outcome button
  document.querySelectorAll(`[data-pick-match="${matchId}"]`).forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.pickChoice === choice);
  });
  // Show step 2
  const step2 = document.getElementById('acbet-s2-' + matchId);
  if (step2) step2.style.display = 'block';
  // Reset chips + confirm
  document.querySelectorAll(`[data-bet-match="${matchId}"]`).forEach(c => c.classList.remove('active'));
  const confirm = document.getElementById('acbet-ok-' + matchId);
  if (confirm) { confirm.disabled = true; confirm.textContent = 'Elegí el monto primero'; }
  // Hide custom input if visible
  const ci = document.getElementById('acbet-ci-' + matchId);
  if (ci) ci.style.display = 'none';
}

function acSelectAmount(matchId, amount) {
  const state = window._acBetState[matchId];
  if (!state) return;
  state.amount = amount;
  document.querySelectorAll(`[data-bet-match="${matchId}"]`).forEach(c =>
    c.classList.toggle('active', parseInt(c.dataset.betAmount) === amount)
  );
  acRefreshConfirm(matchId);
}

function acCustomAmount(matchId) {
  const ci = document.getElementById('acbet-ci-' + matchId);
  if (!ci) return;
  ci.style.display = ci.style.display === 'none' ? 'block' : 'none';
  if (ci.style.display === 'block') ci.focus();
}

function acCustomAmountInput(matchId, val) {
  const amount = parseInt(val.replace(/\D/g,'')) || 0;
  if (amount > 0) {
    window._acBetState[matchId] = window._acBetState[matchId] || {};
    window._acBetState[matchId].amount = amount;
    // Deactivate chips
    document.querySelectorAll(`[data-bet-match="${matchId}"]`).forEach(c => c.classList.remove('active'));
    acRefreshConfirm(matchId);
  }
}

function acRefreshConfirm(matchId) {
  const state   = window._acBetState[matchId];
  const confirm = document.getElementById('acbet-ok-' + matchId);
  if (!confirm || !state) return;
  const { amount, odds } = state;
  if (!amount || !odds) return;
  const ret = Math.round(amount * odds);
  confirm.disabled  = false;
  confirm.innerHTML = `🎲 Apostar <strong>${acFmt(amount)}</strong> ${AC_ICON} → ganá <strong>${acFmt(ret)}</strong> ${AC_ICON}`;
}

function acConfirmBet(matchId, home, away) {
  // Require login to place bets
  if (!authUser) {
    openAuth();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  // Require complete profile (nickname + avatar) to participate — VIPs exempt
  const _isVip = authUser?.email && GAMBETA_VIP[authUser.email];
  if (!_isVip && (!localStorage.getItem(GB_NICK) || !localStorage.getItem(GB_AVA))) {
    acToast('👤', 'Completá tu perfil', 'Necesitás elegir un nickname y un escudo para participar');
    setTimeout(checkOnboarding, 800);
    return;
  }
  const state = window._acBetState[matchId];
  if (!state || !state.choice || !state.amount) {
    acToast('⚠️', 'Seleccioná resultado y monto', 'Tocá una cuota y elegí cuántos  poner');
    return;
  }
  const picks = acGetPicks();
  if (picks.find(p => p.id === matchId)) {
    acToast('ℹ️', 'Ya pusiste  en este partido', 'Solo se permite un pronóstico por partido');
    return;
  }
  const bal = acGet();
  if (bal < state.amount) {
    acToast('❌', 'Saldo insuficiente', `Necesitás ${acFmt(state.amount)} ${AC_ICON}`);
    return;
  }
  // Deduct immediately
  acAdd(-state.amount, `🎲 Predicción: ${home} vs ${away}`);
  picks.push({
    id: matchId, home, away, pick: state.choice,
    betAmount: state.amount, odds: state.odds,
    ts: Date.now(), evaluated: false
  });
  acSavePicks(picks);
  renderMyPicks(); // actualizar panel de stats personales
  // Refrescar feed público ~2 seg después (tiempo suficiente para que el sync llegue a la DB)
  setTimeout(fetchGFeed, 2000);
  const ret    = Math.round(state.amount * state.odds);
  const labels = { home:'Local', draw:'Empate', away:'Visitante' };
  // Update UI — lock buttons, show pending message
  document.querySelectorAll(`[data-pick-match="${matchId}"]`).forEach(btn => {
    btn.disabled = true;
    if (btn.dataset.pickChoice !== state.choice) btn.style.opacity = '0.3';
  });
  const step2 = document.getElementById('acbet-s2-' + matchId);
  if (step2) step2.innerHTML = `
    <div style="text-align:center;padding:6px 4px;font-size:0.72rem;color:rgba(255,214,0,0.65)">
      ⏳ ${acFmt(state.amount)} ${AC_ICON} apostados en <strong style="color:#ffd600">${labels[state.choice]}</strong>
      · Si acertás ganás <strong style="color:#ffd600">${acFmt(ret)} ${AC_ICON}</strong>
    </div>`;
  acToast('🎲', `${acFmt(state.amount)} ${AC_ICON} apostados`, `Potencial retorno: ${acFmt(ret)} ${AC_ICON}`);
}

/* ── Evaluate picks vs final scores ── */
// extraScores: array adicional de scores históricos para resolver picks que no están en scoresData
function acEvaluatePicks(extraScores = []) {
  const picks    = acGetPicks();
  // Combinar scoresData global con scores extra (históricos), dedupando por equipo
  const allFinished = [...scoresData.filter(_settledScore), ...extraScores.filter(_settledScore)];
  const seen = new Set();
  const finished = allFinished.filter(g => {
    const k = `${normTeam(g.home||g.homeRaw||'')}__${normTeam(g.away||g.awayRaw||'')}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  let changed    = false;
  // Guard: set de wins ya acreditados — usa clave dedicada (AC_WINS) independiente del historial
  // que tiene cap de 80 entradas y podría descartar victorias viejas causando doble-crédito.
  const _storedWins = JSON.parse(localStorage.getItem(AC_WINS) || '[]');
  const creditedWins = new Set([
    ..._storedWins,
    // retrocompatibilidad: también leer del historial por si AC_WINS aún está vacío
    ...(JSON.parse(localStorage.getItem(AC_HIST) || '[]'))
      .filter(h => h.reason && h.reason.startsWith('✅'))
      .map(h => h.reason)
  ]);
  picks.forEach(p => {
    if (p.evaluated) return;
    // Buscar partido con teamsMatch() (fuzzy) en lugar de igualdad exacta
    const game = finished.find(g =>
      (teamsMatch(g.home, p.home) || teamsMatch(g.homeRaw||g.home, p.home)) &&
      (teamsMatch(g.away, p.away) || teamsMatch(g.awayRaw||g.away, p.away))
    );
    if (!game) return;
    let actual;
    if      (game.scoreH > game.scoreA) actual = 'home';
    else if (game.scoreH < game.scoreA) actual = 'away';
    else                                 actual = 'draw';
    const correct    = actual === p.pick;
    const matchLabel = `${p.home} vs ${p.away}`;
    const betAmt     = p.betAmount || 1000;
    const odds       = p.odds || 2;
    if (correct) {
      const returnAmt = Math.round(betAmt * odds);
      const winKey = `✅ ${matchLabel}`;
      // Solo acreditar si este partido no fue ya acreditado (evita doble-crédito)
      if (!creditedWins.has(winKey)) {
        acAdd(returnAmt, winKey);
        creditedWins.add(winKey);
        // Persistir en AC_WINS (clave dedicada, sin cap de tamaño que afecte al historial)
        try {
          const wins = JSON.parse(localStorage.getItem(AC_WINS) || '[]');
          if (!wins.includes(winKey)) { wins.push(winKey); localStorage.setItem(AC_WINS, JSON.stringify(wins)); }
        } catch(_) {}
        acToast('✅', `+${acFmt(returnAmt)} ${AC_ICON}`, `¡Acertaste! ${matchLabel}`);
        _addCoinNotif('✅', `+${acFmt(returnAmt)}  ganados`, `¡Acertaste! ${matchLabel}`);
      }
      p.coinsChange = returnAmt;
    } else {
      // coins already deducted when bet was placed — no extra penalty
      acToast('❌', `Fallaste en ${matchLabel}`, `Perdiste ${acFmt(betAmt)} ${AC_ICON} apostados`);
      _addCoinNotif('❌', `-${acFmt(betAmt)}  perdidos`, `Fallaste en ${matchLabel}`);
      p.coinsChange = -betAmt;
    }
    p.evaluated = true; p.result = actual; p.correct = correct;
    changed = true;
  });
  if (changed) { acSavePicks(picks); renderPreds(); renderMyPicks(); acCheckBust(); acCheckDaily(); }
}

/* ── Build pick HTML ── */
function acPickHTML(home, away, homeRaw, awayRaw, oddsH, oddsD, oddsA) {
  return ''; /*  removido: sin seccion de apuesta por pick */
  const matchId  = (homeRaw||home) + '__' + (awayRaw||away);
  const safeId   = matchId.replace(/'/g,"\\'");
  const safeHome = (homeRaw||home).replace(/'/g,"\\'");
  const safeAway = (awayRaw||away).replace(/'/g,"\\'");
  const picks    = acGetPicks();
  const existing = picks.find(p => p.id === matchId);
  const labels   = { home:'Local', draw:'Empate', away:'Visitante' };
  const oddsMap  = { home:oddsH, draw:oddsD, away:oddsA };

  if (existing) {
    const betAmt = existing.betAmount || 1000;
    const odds   = existing.odds || 2;
    const ret    = Math.round(betAmt * odds);
    if (!existing.evaluated) {
      // Locked — pending result
      return `<div class="acoin-pick-section">
        <div class="acoin-pick-label">${AC_ICON} Apostaste ${acFmt(betAmt)} en <span style="color:#ffd600">${labels[existing.pick]}</span></div>
        <div class="acoin-pick-btns">
          ${['home','draw','away'].map(ch => `
            <button class="acoin-pick-btn ${ch===existing.pick?'selected':''}" disabled
              style="${ch!==existing.pick?'opacity:0.3':''}">
              <span class="apb-label">${labels[ch]}</span>
              ${ch===existing.pick?`<span class="apb-coins">${acFmt(betAmt)}→${acFmt(ret)}</span>`:''}
            </button>`).join('')}
        </div>
        <div style="text-align:center;font-size:0.67rem;color:rgba(255,214,0,0.45);margin-top:4px">⏳ Esperando resultado del partido</div>
      </div>`;
    }
    // Evaluated
    const chg  = Math.abs(existing.coinsChange || (existing.correct ? ret : betAmt));
    const resultLabel = existing.correct
      ? `✅ +${acFmt(chg)} ${AC_ICON} ganados`
      : `❌ Perdiste ${acFmt(betAmt)} ${AC_ICON} apostados`;
    return `<div class="acoin-pick-section">
      <div class="acoin-pick-label">${resultLabel}</div>
      <div class="acoin-pick-btns">
        ${['home','draw','away'].map(ch => {
          let cls = '';
          if (ch === existing.result && ch === existing.pick) cls = 'result-ok';
          else if (ch === existing.pick && !existing.correct) cls = 'result-fail';
          else if (ch === existing.result) cls = 'result-ok';
          return `<button class="acoin-pick-btn ${cls}" disabled>
            <span class="apb-label">${labels[ch]}</span>
          </button>`;
        }).join('')}
      </div>
    </div>`;
  }

  // No pick yet — interactive bet UI
  const chips = [500, 1000, 2000, 5000];
  return `<div class="acoin-pick-section">
    <div class="acoin-pick-label">${AC_ICON} Apostá tus </div>
    <div class="acoin-pick-btns">
      ${['home','draw','away'].map(ch => {
        const o = oddsMap[ch];
        if (!o) return '';
        return `<button class="acoin-pick-btn" data-pick-match="${matchId}" data-pick-choice="${ch}"
          onclick="acSelectOutcome('${safeId}','${ch}',${o})">
          <span class="apb-label">${labels[ch]}</span>
          <span class="apb-coins">x${o} ${AC_ICON}</span>
        </button>`;
      }).join('')}
    </div>
    <div id="acbet-s2-${matchId}" style="display:none" class="acoin-bet-step2">
      <div class="acoin-amount-chips">
        ${chips.map(a => `<button class="acoin-amount-chip"
          data-bet-match="${matchId}" data-bet-amount="${a}"
          onclick="acSelectAmount('${safeId}',${a})">${acFmt(a)}</button>`).join('')}
        <button class="acoin-amount-chip" onclick="acCustomAmount('${safeId}')">✏️ otro</button>
      </div>
      <input id="acbet-ci-${matchId}" class="acoin-custom-input" type="number"
        placeholder="Ingresá monto personalizado"
        style="display:none"
        oninput="acCustomAmountInput('${safeId}', this.value)" />
      <button id="acbet-ok-${matchId}" class="acoin-confirm-btn" disabled
        onclick="acConfirmBet('${safeId}','${safeHome}','${safeAway}')">
        Elegí el monto primero
      </button>
    </div>
  </div>`;
}

// Detecta si un nombre de equipo pertenece a la NBA por su logo en el diccionario
function _isNbaTeam(name) {
  if (!name) return false;
  const url = (typeof teamLogos !== 'undefined' && teamLogos[name]) || '';
  return _isNbaAvatar(url);
}

// Limpia picks NBA del historial de pronósticos (AC_HIST) y de los picks  (AC_PICK)
function _purgeNbaPicks() {
  try {
    const hist = JSON.parse(localStorage.getItem(AC_HIST) || '[]');
    const clean = hist.filter(h => {
      if (h.sport === 'basket') return false;
      if (h._sportKey && h._sportKey.includes('basketball')) return false;
      if (_isNbaTeam(h.home) || _isNbaTeam(h.away)) return false;
      return true;
    });
    if (clean.length !== hist.length) localStorage.setItem(AC_HIST, JSON.stringify(clean));
  } catch(e) {}
  try {
    const picks = JSON.parse(localStorage.getItem(AC_PICK) || '[]');
    const cleanPicks = picks.filter(p => {
      if (_isNbaTeam(p.home) || _isNbaTeam(p.away)) return false;
      if (p._sportKey && p._sportKey.includes('basketball')) return false;
      return true;
    });
    if (cleanPicks.length !== picks.length) localStorage.setItem(AC_PICK, JSON.stringify(cleanPicks));
  } catch(e) {}
}















