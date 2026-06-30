// ═══════════════════════════════════════════════════════════════════════════
// inline-bundle.js — código extraído del HTML inline (admin + init)
// Antes era 117 KB de <script> inline que bloqueaba el parser.
// Movido a archivo externo con `defer` para mejorar INP (#607).
// ═══════════════════════════════════════════════════════════════════════════

// ═══ ADMIN PANEL ═══
// Hash SHA-256 de la contraseña admin
const ADMIN_HASH     = '2e2133580c1ac2aeda8147b4ed1162ba3696c87207b5aa0bdbcd12a08d5dd62a';
let   ADMIN_HASH_RUNTIME = ADMIN_HASH;

let adminClickCount = 0, adminClickTimer = null;
let adminUnlocked   = false;

async function hashPin(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}

// Triple clic en el logo abre el panel
document.addEventListener('DOMContentLoaded', () => {
  // $A-Coin: init balance display + daily bonus
  acUpdateUI();
  acCheckDaily();
  // Toast de bienvenida: invitar a registrarse (visitantes no logueados)
  welcomeRegisterToast();
  // Live stats in hero (async, non-blocking)
  loadLiveStats();
  // Broadcast mensajes del admin
  setTimeout(() => { checkBroadcastMessages(); initBroadcastRealtime(); }, 2000);
  // Pageview analytics (una sola vez por sesión)
  if (!sessionStorage.getItem('_gb_pv')) {
    try { sessionStorage.setItem('_gb_pv', '1'); } catch {}
    trackEvent('pageview', { ref: document.referrer ? document.referrer.split('/')[2] : 'direct' });
  }
  // Abrir modal de login automáticamente si viene del blog (/?openauth=1&returnTo=/blog/...)
  const _oaParams = new URLSearchParams(location.search);
  if (_oaParams.get('openauth') === '1') {
    const _returnTo = _oaParams.get('returnTo') || '';
    if (_returnTo) sessionStorage.setItem('_gb_return_to', _returnTo);
    // Limpiar los parámetros de la URL sin recargar la página
    history.replaceState(null, '', location.pathname + location.hash);
    // Esperar a que Supabase verifique la sesión
    setTimeout(() => {
      const _rt = sessionStorage.getItem('_gb_return_to');
      if (authUser) {
        // Ya logueado → volver al blog directamente
        if (_rt) { sessionStorage.removeItem('_gb_return_to'); window.location.href = _rt; }
      } else {
        // No logueado → abrir modal
        openAuth();
      }
    }, 900);
  }
});

// Cargar ranking al inicio (la sección es siempre visible)
document.addEventListener('DOMContentLoaded', () => {
  loadRanking();
});

document.addEventListener('DOMContentLoaded', () => {
  const logo = document.querySelector('.logo');
  if (logo) logo.addEventListener('click', () => {
    adminClickCount++;
    clearTimeout(adminClickTimer);
    adminClickTimer = setTimeout(() => adminClickCount = 0, 700);
    if (adminClickCount >= 3) { adminClickCount = 0; triggerAdmin(); }
  });
});
// Atajo de teclado Ctrl+Shift+A
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.shiftKey && e.key === 'A') { e.preventDefault(); triggerAdmin(); }
});

function triggerAdmin() {
  // Verificar sesión activa (válida por 4 horas)
  try {
    const s = JSON.parse(sessionStorage.getItem(ADMIN_SESSION)||'null');
    if (s && s.exp > Date.now()) { openAdmin(); return; }
  } catch {}
  // Pedir contraseña
  document.getElementById('adminPinOverlay').style.display = 'flex';
  setTimeout(() => document.getElementById('adminPinInput').focus(), 100);
}

async function submitAdminPin() {
  const pin   = document.getElementById('adminPinInput').value;
  const err   = document.getElementById('adminPinError');
  if (!pin) return;
  const hash  = await hashPin(pin);
  // Comparar con hash almacenado en localStorage (o el default)
  const stored = ADMIN_HASH_RUNTIME;
  if (hash === stored) {
    sessionStorage.setItem(ADMIN_SESSION, JSON.stringify({ exp: Date.now() + 4*3600000 }));
    document.getElementById('adminPinOverlay').style.display = 'none';
    document.getElementById('adminPinInput').value = '';
    err.style.display = 'none';
    openAdmin();
  } else {
    err.style.display = 'block';
    document.getElementById('adminPinInput').value = '';
    document.getElementById('adminPinInput').focus();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('adminPinInput');
  if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') submitAdminPin(); });
});

function closeAdminPin() {
  document.getElementById('adminPinOverlay').style.display = 'none';
  document.getElementById('adminPinInput').value = '';
  document.getElementById('adminPinError').style.display = 'none';
}

function openAdmin() {
  const p = document.getElementById('adminPanel');
  p.style.display = 'flex';
  admRefreshStatus();
  admRenderHistTable();
  try {
    const cfg = JSON.parse(localStorage.getItem(ADMIN_KEY)||'{}');
    if (cfg.threshHigh) document.getElementById('admThreshHigh').value = cfg.threshHigh;
    if (cfg.threshMed)  document.getElementById('admThreshMed').value  = cfg.threshMed;
    if (cfg.maxCards)   document.getElementById('admMaxCards').value   = cfg.maxCards;
    if (cfg.bankrollInit) document.getElementById('admBankrollVal').value = cfg.bankrollInit;
  } catch {}
}
function closeAdmin() {
  document.getElementById('adminPanel').style.display = 'none';
}

// ══════════════════════════════════════════════
//  ONBOARDING — Primera vez en la cuenta
// ══════════════════════════════════════════════
const GB_NICK = 'gambeta_nickname';
const GB_AVA  = 'gambeta_avatar';


// ── Apellidos de jugadores para asignación automática ──────────
const PLAYER_SURNAMES = [
  'Messi','Mbappé','Haaland','Vinicius','Salah','Kane','Lewandowski',
  'De Bruyne','Rodri','Bellingham','Pedri','Yamal','Dembélé','Saka',
  'Rashford','Son','Firmino','Modric','Benzema','Cavani','Suárez',
  'Falcao','Dybala','Lautaro','Álvarez','De Paul','Mac Allister',
  'Fernández','Paredes','Correa','Griezmann','Hernández','Gnabry',
  'Müller','Neuer','Alisson','Ederson','Courtois','Ter Stegen',
  'Zubimendi','Olmo','Williams','Wirtz','Guirassy','Morata','Vlahović',
  'Osimhen','Lukaku','Pulisic','Reijnders','Theo','Leão','Giroud',
  'Camavinga','Tchouaméni','Valverde','Carvajal','Militão','Rüdiger',
];

// Detecta si un avatar es de equipo de basket (NBA, etc.)
function _isNbaAvatar(logo) {
  return logo && (logo.includes('espncdn.com/i/teamlogos/nba') || logo.includes('/nba/500/'));
}
// Detecta avatares de dominios que bloquean hotlinking (espncdn soccer, CDNs desactualizadas)
function _isBlockedAvatarDomain(logo) {
  if (!logo) return true;
  const blocked = ['espncdn.com/i/teamlogos/soccer', 'a.espncdn.com/i/teamlogos/nfl',
                   'a.espncdn.com/i/teamlogos/nhl', 'a.espncdn.com/i/teamlogos/mlb'];
  return blocked.some(d => logo.includes(d));
}

// ── Pool generado dinámicamente desde teamLogos ──────────────
// Se construye en tiempo de ejecución: deduplica por URL (1 entrada por logo único)
// y asigna un color de acento consistente por nombre de equipo.
const _OB_COLOR_PALETTE = [
  '#e10600','#003f8f','#c8aa6e','#00529b','#dc052d','#6cabdd',
  '#f7941d','#a50044','#00944a','#ffd600','#9c27b0','#00acc1',
  '#ff7043','#43a047','#dc1e2e','#6d4c41','#546e7a','#e91e63'
];
function _obColorFromName(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = Math.imul(31, h) + name.charCodeAt(i) | 0;
  return _OB_COLOR_PALETTE[Math.abs(h) % _OB_COLOR_PALETTE.length];
}
function _buildObPool() {
  const seen = new Set();
  const pool = [];
  for (const [name, url] of Object.entries(teamLogos)) {
    if (seen.has(url)) continue; // mismo logo bajo nombre alternativo → skip
    if (_isNbaAvatar(url)) continue; // excluir escudos de básquet/NBA
    seen.add(url);
    pool.push({
      id:    name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
      name,
      logo:  url,
      color: _obColorFromName(name)
    });
  }
  return pool;
}

// Elige un club de fútbol al azar del pool (sin NBA)
function _randomFootballClub() {
  const pool = _buildObPool();
  return pool[Math.floor(Math.random() * pool.length)];
}

let _obSelectedClub  = null;
let _obCurrentClubs  = [];   // los 3 clubs sorteados para esta sesión

// Sorteo ponderado: los menos elegidos tienen más peso
function _obWeightedSample(items, n) {
  const result = [], pool = [...items];
  for (let i = 0; i < n && pool.length; i++) {
    const total = pool.reduce((s, c) => s + c._w, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) { r -= pool[idx]._w; if (r <= 0) break; }
    result.push(pool[idx]);
    pool.splice(idx, 1);
  }
  return result;
}

// Consulta Supabase, cuenta cuántos usuarios usan cada club y sortea 3 con peso inverso
async function _obPickClubs() {
  const pool = _buildObPool(); // todos los equipos cargados en la página

  // Contar uso de cada logo en la DB (comparamos por URL, que es la clave única real)
  const countsByUrl = {};
  try {
    const { data } = await sbClient
      .from('acoin_users')
      .select('avatar')
      .not('avatar', 'is', null);
    (data || []).forEach(row => {
      try {
        const a = JSON.parse(row.avatar);
        if (a?.logo) countsByUrl[a.logo] = (countsByUrl[a.logo] || 0) + 1;
      } catch(_) {}
    });
  } catch(_) { /* sin conexión → todos pesan igual */ }

  const maxCount = Math.max(...Object.values(countsByUrl), 1);
  const weighted = pool.map(c => ({
    ...c,
    _w: maxCount - (countsByUrl[c.logo] || 0) + 1  // +1 para que nadie tenga peso 0
  }));
  return _obWeightedSample(weighted, 3);
}

async function checkOnboarding() {
  if (!authUser) return;
  // VIPs siempre tienen perfil completo — no mostrar onboarding
  if (GAMBETA_VIP[authUser.email]) return;

  const hasNick = !!localStorage.getItem(GB_NICK);
  const avaRaw  = localStorage.getItem(GB_AVA);
  let ava = null;
  try { ava = avaRaw ? JSON.parse(avaRaw) : null; } catch(_) {}

  // ── Caso 1: Sin perfil en absoluto → asignar automáticamente ──────────────
  if (!hasNick && !ava) {
    const surname = PLAYER_SURNAMES[Math.floor(Math.random() * PLAYER_SURNAMES.length)];
    const club    = _randomFootballClub();
    localStorage.setItem(GB_NICK, surname);
    localStorage.setItem(GB_AVA, JSON.stringify({ id: club.id, logo: club.logo, name: club.name, color: club.color }));
    applyUserProfile();
    acScheduleSync();
    return;
  }

  // ── Caso 1b: Tiene avatar pero sin nick (estado roto) → asignar apellido automático ──
  if (!hasNick && ava && !_isNbaAvatar(ava.logo)) {
    const surname = PLAYER_SURNAMES[Math.floor(Math.random() * PLAYER_SURNAMES.length)];
    localStorage.setItem(GB_NICK, surname);
    applyUserProfile();
    acScheduleSync();
    return;
  }

  // ── Caso 2: Avatar bloqueado (básquet, ESPN soccer u otro CDN no permitido) → reemplazar ──
  if (ava && (_isNbaAvatar(ava.logo) || _isBlockedAvatarDomain(ava.logo))) {
    const club = _randomFootballClub();
    localStorage.setItem(GB_AVA, JSON.stringify({ id: club.id, logo: club.logo, name: club.name, color: club.color }));
    applyUserProfile();
    if (_isNbaAvatar(ava.logo)) await _showAvatarMigration();
    return;
  }

  // ── Caso 3: Tiene todo → no hacer nada ────────────────────────────────────
  if (hasNick && ava) return;

  // ── Caso 4: Tiene nick pero sin avatar → asignar club automáticamente ────────
  const club = _randomFootballClub();
  localStorage.setItem(GB_AVA, JSON.stringify({ id: club.id, logo: club.logo, name: club.name, color: club.color }));
  applyUserProfile();
  acScheduleSync();
}

async function obNext() {
  const inp  = document.getElementById('obNickInput');
  const nick = (inp.value || '').trim();
  const err  = document.getElementById('obNickErr');
  if (nick.length < 2) { err.textContent = '⚠ Mínimo 2 caracteres'; inp.focus(); return; }
  if (nick.length > 20) { err.textContent = '⚠ Máximo 20 caracteres'; inp.focus(); return; }
  localStorage.setItem(GB_NICK, nick);
  // Si por alguna razón los clubs aún no cargaron (red lenta), esperamos
  if (!_obCurrentClubs.length) _obCurrentClubs = await _obPickClubs();
  document.getElementById('obStep1').style.display = 'none';
  document.getElementById('obStep2').style.display = 'block';
  _obSelectedClub = null;
  renderObClubs();
}

function renderObClubs() {
  const grid = document.getElementById('obClubsGrid');
  const fallback = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🛡️</text></svg>`;
  grid.innerHTML = _obCurrentClubs.map(c => `
    <div class="ob-club-card" onclick="obSelectClub('${c.id}')" id="obClub_${c.id}">
      <img src="${c.logo}" alt="${c.name}"
           onerror="if(!this.dataset.fb){this.dataset.fb=1;this.src='${fallback}';this.style.opacity='0.5';}">
      <div class="ob-club-name">${c.name}</div>
    </div>
  `).join('');
}

function obSelectClub(id) {
  _obSelectedClub = id;
  document.querySelectorAll('.ob-club-card').forEach(el => el.classList.remove('selected'));
  const card = document.getElementById('obClub_' + id);
  if (card) card.classList.add('selected');
  const btn = document.getElementById('obFinishBtn');
  if (btn) btn.disabled = false;
}

function obFinish() {
  if (!_obSelectedClub) return;
  const club = _obCurrentClubs.find(c => c.id === _obSelectedClub);
  if (!club) return;
  localStorage.setItem(GB_AVA, JSON.stringify({ id: club.id, logo: club.logo, name: club.name, color: club.color }));
  document.getElementById('onboardingOverlay').style.display = 'none';
  document.body.style.overflow = '';
  applyUserProfile();
  acScheduleSync();
}

// ── Migración de escudo de básquet → fútbol ────────────────────────────────
let _obMigrateClubs = [];   // [auto-asignado, opción2, opción3]
let _obMigrateSelected = null;

async function _showAvatarMigration() {
  // El auto-asignado ya está en localStorage; lo leemos para mostrarlo primero
  let currentAva = null;
  try { currentAva = JSON.parse(localStorage.getItem(GB_AVA)); } catch(_) {}

  // Sorteamos 2 clubs extra (distintos del auto-asignado)
  const pool = _buildObPool().filter(c => c.logo !== currentAva?.logo);
  const extra = [];
  const used  = new Set();
  while (extra.length < 2 && used.size < pool.length) {
    const idx = Math.floor(Math.random() * pool.length);
    if (!used.has(idx)) { used.add(idx); extra.push(pool[idx]); }
  }

  // El auto-asignado va primero (pre-seleccionado)
  _obMigrateClubs    = [currentAva ? { id: currentAva.id, logo: currentAva.logo, name: currentAva.name, color: currentAva.color } : extra[0], ...extra];
  _obMigrateSelected = _obMigrateClubs[0]?.id || null;

  const fallback = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🛡️</text></svg>`;
  const grid = document.getElementById('obMigrateGrid');
  grid.innerHTML = _obMigrateClubs.map((c, i) => `
    <div class="ob-club-card${i === 0 ? ' selected' : ''}" onclick="obMigrateSelect('${c.id}')" id="obMig_${c.id}">
      <img src="${c.logo}" alt="${c.name}"
           onerror="if(!this.dataset.fb){this.dataset.fb=1;this.src='${fallback}';this.style.opacity='0.5';}">
      <div class="ob-club-name">${c.name}</div>
      ${i === 0 ? '<div style="font-size:0.6rem;color:var(--verde);font-weight:700;letter-spacing:.5px;margin-top:2px">AUTO</div>' : ''}
    </div>
  `).join('');

  const btn = document.getElementById('obMigrateBtn');
  if (btn) btn.disabled = false;

  // Mostrar overlay en paso 3
  const overlay = document.getElementById('onboardingOverlay');
  ['obStep1','obStep2'].forEach(id => { const el = document.getElementById(id); if(el) el.style.display = 'none'; });
  document.getElementById('obStep3').style.display = 'block';
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function obMigrateSelect(id) {
  _obMigrateSelected = id;
  document.querySelectorAll('#obMigrateGrid .ob-club-card').forEach(el => el.classList.remove('selected'));
  const card = document.getElementById('obMig_' + id);
  if (card) card.classList.add('selected');
  const btn = document.getElementById('obMigrateBtn');
  if (btn) btn.disabled = false;
}

function obMigrateFinish() {
  const club = _obMigrateClubs.find(c => c.id === _obMigrateSelected) || _obMigrateClubs[0];
  if (!club) return;
  localStorage.setItem(GB_AVA, JSON.stringify({ id: club.id, logo: club.logo, name: club.name, color: club.color }));
  document.getElementById('onboardingOverlay').style.display = 'none';
  document.getElementById('obStep3').style.display = 'none';
  document.body.style.overflow = '';
  applyUserProfile();
  acScheduleSync();
}

function applyUserProfile() {
  let nick   = localStorage.getItem(GB_NICK);
  let avaRaw = localStorage.getItem(GB_AVA);
  let ava    = avaRaw ? (() => { try { return JSON.parse(avaRaw); } catch(_) { return null; } })() : null;

  // ── VIP override ──────────────────────────────────────────────
  const vip = authUser?.email ? GAMBETA_VIP[authUser.email] : null;
  if (vip) {
    // Forzar avatar VIP siempre (ignora lo que haya en localStorage)
    ava = vip.avatar;
    try { localStorage.setItem(GB_AVA, JSON.stringify(ava)); } catch(_) {}   // puede fallar si storage lleno
    // Guardar nickname VIP en localStorage para que los checks de perfil lo vean
    if (vip.nickname) {
      nick = vip.nickname;  // también actualizar la variable local
      try { localStorage.setItem(GB_NICK, vip.nickname); } catch(_) {}
    }
  }
  // Sufijo especial al apodo (ej: "Mauro 🎩")
  const displayNick = nick ? nick + (vip?.suffix || '') : null;

  if (displayNick) {
    const navName = document.getElementById('navUserName');
    if (navName) navName.textContent = displayNick;
    const ddName = document.getElementById('ddName');
    if (ddName) ddName.textContent = displayNick;
    const miEl = document.getElementById('mipanelUser');
    if (miEl) miEl.textContent = '— ' + displayNick;
    const dun = document.getElementById('drawerUserName');
    if (dun) dun.textContent = displayNick;
  }
  if (ava) {
    const logoUrl = ava.logo;
    const logoName = ava.name || '';
    const imgStyle = 'width:75%;height:75%;object-fit:contain;filter:drop-shadow(0 1px 4px rgba(0,0,0,0.5))';
    const imgStyleSm = 'width:26px;height:26px;object-fit:contain;filter:drop-shadow(0 1px 4px rgba(0,0,0,0.6))';
    const imgStyleMob = 'width:80%;height:80%;object-fit:contain;filter:drop-shadow(0 1px 4px rgba(0,0,0,0.5))';

    function _setAvatarImg() {
      const avatarEl = document.getElementById('navUserAvatar');
      if (avatarEl) {
        avatarEl.innerHTML = `<img src="${logoUrl}" alt="${logoName}" style="${imgStyle}">`;
        avatarEl.style.background = 'transparent';
        avatarEl.style.border = 'none';
        avatarEl.style.borderRadius = '0';

        // ── VIP guard: MutationObserver + setInterval que restauran el logo ──
        if (vip) {
          const _vipRestore = () => {
            if (!avatarEl.querySelector('img')) {
              avatarEl.innerHTML = `<img src="${logoUrl}" alt="${logoName}" style="${imgStyle}">`;
              avatarEl.style.background = 'transparent';
              avatarEl.style.border = 'none';
              avatarEl.style.borderRadius = '0';
            }
          };
          // MutationObserver — instantáneo
          if (avatarEl._vipObserver) avatarEl._vipObserver.disconnect();
          const obs = new MutationObserver(_vipRestore);
          obs.observe(avatarEl, { childList: true, characterData: true, subtree: true });
          avatarEl._vipObserver = obs;
          // setInterval — respaldo cada 300ms por 30 segundos
          if (avatarEl._vipInterval) clearInterval(avatarEl._vipInterval);
          let _vipChecks = 0;
          avatarEl._vipInterval = setInterval(() => {
            _vipRestore();
            if (++_vipChecks >= 100) { clearInterval(avatarEl._vipInterval); obs.disconnect(); }
          }, 300);
        }
      }
      const badge = document.getElementById('ddAvatarBadge');
      if (badge) {
        badge.style.display = 'block';
        badge.innerHTML = `<img src="${logoUrl}" alt="${logoName}" style="${imgStyleSm}">`;
      }
      const dua = document.getElementById('drawerUserAvatar');
      if (dua) {
        dua.innerHTML = `<img src="${logoUrl}" alt="${logoName}" style="${imgStyleMob}">`;
        dua.style.background = 'transparent';
      }
    }

    if (logoUrl && logoUrl.startsWith('data:')) {
      // Base64 data URL — no hay red, siempre carga. Aplicar sincrónicamente.
      _setAvatarImg();
    } else {
      // URL externa — precargar antes de mostrar para no sobreescribir las iniciales si falla
      const testImg = new Image();
      testImg.onload = _setAvatarImg;
      testImg.onerror = () => {};
      testImg.referrerPolicy = 'no-referrer-when-downgrade';
      testImg.src = logoUrl;
    }
  } else if (!vip && authUser) {
    // Sin avatar propio ni VIP → asignar escudo del pool basado en el email/nick
    const _fbNick = nick || authUser.email || '?';
    const _fbUrl  = gbFallbackAvatarUrl(_fbNick);
    const _fbUrl2 = gbFallbackAvatarUrl2(_fbNick);
    const _imgStyle = 'width:75%;height:75%;object-fit:contain;filter:drop-shadow(0 1px 4px rgba(0,0,0,0.5))';
    const _fbImg = new Image();
    _fbImg.onload = () => {
      const avatarEl = document.getElementById('navUserAvatar');
      if (avatarEl) {
        avatarEl.innerHTML = `<img loading="lazy" decoding="async" src="${_fbUrl}" alt="" style="${_imgStyle}">`;
        avatarEl.style.background = 'transparent';
        avatarEl.style.border = 'none';
        avatarEl.style.borderRadius = '0';
      }
      const dua = document.getElementById('drawerUserAvatar');
      if (dua) {
        dua.innerHTML = `<img loading="lazy" decoding="async" src="${_fbUrl}" alt="" style="width:80%;height:80%;object-fit:contain;">`;
        dua.style.background = 'transparent';
      }
    };
    _fbImg.onerror = () => {
      // segundo intento con el siguiente escudo del pool
      const avatarEl = document.getElementById('navUserAvatar');
      if (avatarEl) {
        avatarEl.innerHTML = `<img loading="lazy" decoding="async" src="${_fbUrl2}" alt="" style="${_imgStyle}">`;
        avatarEl.style.background = 'transparent';
        avatarEl.style.border = 'none';
        avatarEl.style.borderRadius = '0';
      }
    };
    _fbImg.src = _fbUrl;
  }
  // Conectar Realtime Presence solo si hay sesión activa (no para visitantes anónimos)
  if (authUser) initPresence();
}

// ══════════════════════════════════════════════
//  RANKING MENSUAL  COINS
// ══════════════════════════════════════════════
let _rkLoaded    = false;
let _rkCountdownTimer = null;

function rkMaskEmail(email) {
  if (!email) return 'Jugador';
  const [user, domain] = email.split('@');
  return user.slice(0, 2) + '***@' + domain;
}

function rkDisplayName(u, html = false, streak = 0) {
  const vip  = u.email ? GAMBETA_VIP[u.email] : null;
  const base = vip?.nickname || u.nickname || rkMaskEmail(u.email);
  const full = base + (vip?.suffix || '');
  const badge = html ? rkChampionBadge(u.email) : '';
  const fire  = html ? rkStreakBadge(streak) : '';
  if (html && vip?.nameColor) {
    return `<span style="color:${vip.nameColor};font-weight:800;text-shadow:0 0 8px ${vip.nameColor}40">${full}</span>${badge}${fire}`;
  }
  return html ? full + badge + fire : full;
}

function rkAvatarHTML(u, size = 38, textClass = '') {
  const displayName = rkDisplayName(u);
  const nick = displayName || u.email || '?';
  const fallbackUrl  = gbFallbackAvatarUrl(nick);
  const fallbackUrl2 = gbFallbackAvatarUrl2(nick);
  const fallbackImg  = `<img loading="lazy" decoding="async" src='${fallbackUrl}' data-fb='${fallbackUrl2}' style='width:${size}px;height:${size}px;object-fit:contain;border-radius:0;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.5));flex-shrink:0' onerror='this.src=this.dataset.fb'>`;
  try {
    const vip = u.email ? GAMBETA_VIP[u.email] : null;
    const ava = vip?.avatar || (u.avatar ? JSON.parse(u.avatar) : null);
    if (ava?.logo) {
      return `<img src="${ava.logo}" class="${textClass || 'rk-row-avatar'}"
        style="width:${size}px;height:${size}px;object-fit:contain;border-radius:0"
        onerror="this.outerHTML=\`${fallbackImg.replace(/`/g,"'")}\`">`;
    }
  } catch(_) {}
  // Sin avatar propio → escudo del pool basado en el nick
  return fallbackImg;
}

function rkStartCountdown() {
  clearInterval(_rkCountdownTimer);
  const el = document.getElementById('rkCountdown');
  if (!el) return;
  function tick() {
    const now  = new Date();
    const end  = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0); // 1º del mes siguiente
    const diff = end - now;
    if (diff <= 0) { el.textContent = '¡Cierra hoy!'; return; }
    const d = Math.floor(diff / 86400000);
    const h = Math.floor((diff % 86400000) / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    el.textContent = d > 0
      ? `${d}d ${String(h).padStart(2,'0')}h ${String(m).padStart(2,'0')}m`
      : `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  tick();
  _rkCountdownTimer = setInterval(tick, 1000);
}

// ── User stats popup ─────────────────────────────────────────────────────────
let _rkupData = { historial: [], picks: [] };
let _rkupTab  = 'wins';

function rkClosePopup() {
  document.getElementById('rkUserPopup').classList.remove('open');
}

function rkupShowTab(tab, btn) {
  _rkupTab = tab;
  document.querySelectorAll('.rkup-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  _rkupRenderPicks();
}

function _rkupRenderPicks() {
  const list = document.getElementById('rkupPicksList');
  const { historial, picks } = _rkupData;

  // Combinar pronósticos +  picks normalizados
  const allPicks = [
    ...historial.map(h => ({
      type: 'prono',
      result: h.result,
      match: (h.home && h.away) ? `${h.home} vs ${h.away}` : (h.id || '—'),
      rec: h.rec || '—',
      betAmount: null,
      coinsChange: h.coinsChange || null,
      ts: h.commenceTs || h.ts || 0,
    })),
    ...picks.map(p => ({
      type: 'gpick',
      result: !p.evaluated ? 'pending' : p.correct ? 'win' : 'loss',
      match: (p.home && p.away) ? `${p.home} vs ${p.away}` : '—',
      rec: p.pick === 'home' ? 'Gana Local' : p.pick === 'away' ? 'Gana Visitante' : p.pick === 'draw' ? 'Empate' : (p.pick || '—'),
      betAmount: p.betAmount || null,
      coinsChange: p.coinsChange || null,
      ts: p.ts || 0,
    })),
  ].sort((a, b) => (b.ts || 0) - (a.ts || 0));

  const filtered = allPicks.filter(p =>
    _rkupTab === 'wins'    ? p.result === 'win' :
    _rkupTab === 'losses'  ? p.result === 'loss' :
    /* pending */             p.result !== 'win' && p.result !== 'loss'
  ).slice(0, 25);

  if (!filtered.length) {
    const total = allPicks.length;
    list.innerHTML = `<div class="rkup-empty">${total === 0 ? 'Sin actividad registrada aún' : 'Sin picks en esta categoría'}</div>`;
    return;
  }

  list.innerHTML = filtered.map(p => {
    const icon = p.result === 'win' ? '✅' : p.result === 'loss' ? '❌' : '⏳';
    const typeTag = p.type === 'gpick' ? ' <span style="font-size:0.6rem;color:rgba(255,214,0,0.5);font-weight:700"></span>' : '';
    const coinsHtml = p.coinsChange != null
      ? `<div class="rkup-pick-coins">${p.coinsChange >= 0 ? '+' : ''}${acFmt(p.coinsChange)}</div>`
      : (p.betAmount ? `<div class="rkup-pick-coins" style="color:rgba(255,255,255,0.3)">${acFmt(p.betAmount)}</div>` : '');
    return `<div class="rkup-pick">
      <div class="rkup-pick-icon">${icon}</div>
      <div class="rkup-pick-info">
        <div class="rkup-pick-match">${p.match}${typeTag}</div>
        <div class="rkup-pick-rec">${_recLabel(p.rec, p.home, p.away)}</div>
      </div>
      ${coinsHtml}
    </div>`;
  }).join('');
}

async function rkShowUserPopup(email, nickname, avatarUrl, balance) {
  const popup = document.getElementById('rkUserPopup');

  // Header
  const avatarEl = document.getElementById('rkupAvatar');
  if (avatarUrl) {
    avatarEl.innerHTML = `<img loading="lazy" decoding="async" src="${avatarUrl}" class="rkup-avatar" onerror="this.outerHTML='<div class=\\'rkup-avatar-text\\'>${(nickname||'?')[0].toUpperCase()}</div>'">`;
  } else {
    avatarEl.innerHTML = `<div class="rkup-avatar-text">${(nickname||'?')[0].toUpperCase()}</div>`;
  }
  document.getElementById('rkupName').textContent = nickname || email?.split('@')[0] || '—';
  document.getElementById('rkupBal').textContent = balance != null ? `${acFmt(balance)} ` : '—';

  // Reset stats
  ['rkupWins','rkupLosses','rkupPending','rkupPct'].forEach(id => document.getElementById(id).textContent = '—');
  document.getElementById('rkupPicksList').innerHTML = '<div class="rkup-loading">Cargando...</div>';

  // Reset tab to wins
  _rkupTab = 'wins';
  document.querySelectorAll('.rkup-tab').forEach((b,i) => b.classList.toggle('active', i===0));

  popup.classList.add('open');

  // Fetch data — primer intento: endpoint público /api/picks (service role, bypassa RLS)
  // Fallback: sbClient autenticado si el usuario está logueado
  try {
    let historial = [], gPicks = [];

    // Intentar proxy público primero
    let usedProxy = false;
    try {
      const resp = await fetch(`/api/picks?email=${encodeURIComponent(email)}`);
      if (resp.ok) {
        const d = await resp.json();
        if (!d.error) {
          historial  = Array.isArray(d.historial_full) ? d.historial_full : [];
          gPicks     = Array.isArray(d.picks)          ? d.picks          : [];
          usedProxy  = true;
        }
      }
    } catch {}

    // Fallback: sbClient con sesión del usuario logueado
    if (!usedProxy && authUser) {
      const { data, error } = await sbClient
        .from('acoin_users')
        .select('historial_full, picks')
        .eq('email', email)
        .maybeSingle();
      if (!error) {
        historial = Array.isArray(data?.historial_full) ? data.historial_full : [];
        gPicks    = Array.isArray(data?.picks)          ? data.picks          : [];
      }
    }

    _rkupData = { historial, picks: gPicks };

    // Compute stats
    const resolved  = historial.filter(h => h.result === 'win' || h.result === 'loss');
    const gResolved = gPicks.filter(p => p.evaluated);
    const wins    = resolved.filter(h => h.result === 'win').length   + gResolved.filter(p => p.correct).length;
    const losses  = resolved.filter(h => h.result === 'loss').length  + gResolved.filter(p => !p.correct).length;
    const pending = historial.filter(h => h.result !== 'win' && h.result !== 'loss').length
                  + gPicks.filter(p => !p.evaluated).length;
    const total   = wins + losses;
    const pct     = total > 0 ? Math.round(wins / total * 100) : 0;

    document.getElementById('rkupWins').textContent    = wins    || '0';
    document.getElementById('rkupLosses').textContent  = losses  || '0';
    document.getElementById('rkupPending').textContent = pending || '0';
    document.getElementById('rkupPct').textContent     = total > 0 ? `${pct}%` : '—';

    _rkupRenderPicks();
  } catch(e) {
    document.getElementById('rkupPicksList').innerHTML =
      `<div class="rkup-empty">Error al cargar picks</div>`;
    console.warn('[rkPopup]', e);
  }
}

// Calcula racha de victorias consecutivas desde historial_full
function _rkCalcWinStreak(historial) {
  if (!Array.isArray(historial) || !historial.length) return 0;
  // Ordenar por fecha desc (más reciente primero)
  const sorted = [...historial]
    .filter(h => h.result === 'win' || h.result === 'loss')
    .sort((a, b) => {
      const tsA = a.commenceTs || a.ts || 0;
      const tsB = b.commenceTs || b.ts || 0;
      return tsB - tsA;
    });
  if (!sorted.length || sorted[0].result !== 'win') return 0;
  let streak = 0;
  for (const h of sorted) {
    if (h.result === 'win') streak++;
    else break;
  }
  return streak;
}

// Carga historial_full de los top10 y aplica badges de racha al ranking ya renderizado
async function _loadRkStreaks(emails) {
  if (!emails?.length) return;
  try {
    const { data, error } = await sbAnon
      .from('acoin_users')
      .select('email, historial_full')
      .in('email', emails);
    if (error || !data?.length) return;
    data.forEach(row => {
      const streak = _rkCalcWinStreak(row.historial_full);
      if (streak < 2) return; // solo fuego si hay 2+ seguidas
      const badge = rkStreakBadge(streak);
      // Actualizar todos los elementos con data-rk-email
      document.querySelectorAll(`[data-rk-email="${CSS.escape(row.email)}"]`).forEach(el => {
        const nickEl = el.querySelector('.rk-pod-nick, .rk-row-nick');
        if (nickEl && !nickEl.querySelector('.rk-streak-badge')) {
          nickEl.insertAdjacentHTML('beforeend', badge);
        }
      });
    });
  } catch(e) { console.warn('[rkStreaks]', e.message); }
}

async function loadRanking(force = false) {
  return; /* /Ranking removido */
  if (_rkLoaded && !force) return;
  _rkLoaded = true;

  // Month label → "Abr '26 — En curso"
  const now = new Date();
  const mm2 = String(now.getMonth() + 1).padStart(2, '0');
  const yy2 = String(now.getFullYear()).slice(2);
  const monthLabel = document.getElementById('rkMonthLabel');
  if (monthLabel) {
    monthLabel.textContent = `${RK_MONTH_NAMES[mm2] || ''} '${yy2} — En curso`;
  }
  // Botón "Cerrar mes" solo visible para el admin
  const cerrarBtn = document.getElementById('rkCerrarMesBtn');
  if (cerrarBtn) cerrarBtn.style.display = (authUser?.email === ADMIN_EMAIL) ? 'block' : 'none';
  rkStartCountdown();
  // Cargar hall of fame inmediatamente (render estático) y enriquecer con Supabase
  loadPastWinners();
  // Sincronizar a shared_cache solo si es admin
  if (authUser?.email === ADMIN_EMAIL) rkSyncStaticWinners();

  // Show loading, hide others
  ['rkLoading','rkPodium','rkList','rkMyPos','rkEmpty'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === 'rkLoading' ? 'block' : 'none';
  });

  try {
    // Proxy con caché 5 min — ranking no necesita ser en tiempo real
    let data;
    try {
      const resp = await fetch('/api/sb?type=ranking');
      if (resp.ok) data = await resp.json();
    } catch {}
    if (!data) {
      const res = await sbClient.from('acoin_users').select('email, balance, nickname, avatar').order('balance', { ascending: false }).limit(50);
      if (res.error) throw res.error;
      data = res.data;
    }
    const error = null;
    const rows = (data || []).filter(u => (parseFloat(u.balance) || 0) > 0);

    document.getElementById('rkLoading').style.display = 'none';

    if (!rows.length) {
      document.getElementById('rkEmpty').style.display = 'block';
      return;
    }

    const top10  = rows.slice(0, 10);
    const top3   = top10.slice(0, 3);
    const rest   = top10.slice(3);
    const podiumEl = document.getElementById('rkPodium');
    const listEl   = document.getElementById('rkList');

    // Guardar top10 para el tab "mes actual" en la historia
    _rkCurrentTop10 = top10;
    if (_rkHistoryActiveTab === '__current__' || !_rkHistoryActiveTab) {
      rkHistoryTab('__current__');
    }

    // ── Podium ───────────────────────────────────────
    const RANKS   = ['1','2','3'];
    const CLASSES = ['rk-pod-1','rk-pod-2','rk-pod-3'];
    // Order: 1st | 2nd | 3rd (left to right, descending size)
    const podOrder    = top3;
    const podClsOrder = CLASSES;
    const podRankOrder = RANKS;

    podiumEl.innerHTML = `<div class="rk-podium">${
      podOrder.map((u, i) => {
        const bal = parseFloat(u.balance) || 0;
        const name = rkDisplayName(u, true);
        const ava  = rkAvatarHTML(u, 48, 'rk-pod-avatar');
        const esc = (u.email||'').replace(/'/g,"\\'");
        const nick = (u.nickname||u.email?.split('@')[0]||'').replace(/'/g,"\\'");
        const avUrl = (u.avatar||'').replace(/'/g,"\\'");
        return `
        <div class="rk-pod-card ${podClsOrder[i]}" data-rk-email="${u.email||''}" style="cursor:pointer" onclick="rkShowUserPopup('${esc}','${nick}','${avUrl}',${bal})">
          <div class="rk-pod-rank">${podRankOrder[i]}</div>
          ${ava}
          <div class="rk-pod-nick">${name}</div>
          <div class="rk-pod-bal">${acFmt(bal)} </div>
          <div class="rk-pod-prize">🎁 $20 USD gratis</div>
        </div>`;
      }).join('')
    }</div>`;
    podiumEl.style.display = 'block';

    // ── Lista 4–10 ────────────────────────────────────
    const meEmail = authUser?.email || null;
    listEl.innerHTML = rest.map((u, i) => {
      const rank   = i + 4;
      const bal    = parseFloat(u.balance) || 0;
      const name   = rkDisplayName(u, true);
      const ava    = rkAvatarHTML(u, 30, 'rk-row-avatar');
      const isMe   = meEmail && u.email === meEmail;
      const resc   = (u.email||'').replace(/'/g,"\\'");
      const rnick  = (u.nickname||u.email?.split('@')[0]||'').replace(/'/g,"\\'");
      const ravUrl = (u.avatar||'').replace(/'/g,"\\'");
      return `
      <div class="rk-row${isMe ? ' rk-row-me' : ''}" data-rk-email="${u.email||''}" style="cursor:pointer" onclick="rkShowUserPopup('${resc}','${rnick}','${ravUrl}',${bal})">
        <div class="rk-row-num">${rank}</div>
        ${ava}
        <div class="rk-row-nick">${name}${isMe ? ' <span style="font-size:0.65rem;color:var(--verde);margin-left:4px">(vos)</span>' : ''}</div>
        <div class="rk-row-bal">${acFmt(bal)} </div>
        <div class="rk-row-prize">🎁 $20 USD</div>
      </div>`;
    }).join('');
    listEl.style.display = 'flex';

    // ── Cargar rachas en paralelo (sin bloquear render) ────────────
    const top10emails = top10.map(u => u.email).filter(Boolean);
    _loadRkStreaks(top10emails);

    // ── Mi posición ───────────────────────────────────
    const myPosEl = document.getElementById('rkMyPos');
    if (meEmail) {
      const myIdx = rows.findIndex(u => u.email === meEmail);
      if (myIdx >= 10) {
        const me = rows[myIdx];
        const bal = parseFloat(me.balance) || 0;
        const missing = (parseFloat(rows[9]?.balance) || 0) - bal;
        myPosEl.innerHTML = `
          <div class="rk-mypos">
            ${rkAvatarHTML(me, 36, 'rk-row-avatar')}
            <div style="flex:1;min-width:0">
              <div style="font-size:0.78rem;font-weight:700;color:var(--verde)">Tu posición: #${myIdx + 1}</div>
              <div style="font-size:0.72rem;color:rgba(255,255,255,0.45);margin-top:2px">
                Te faltan <strong style="color:#ffd600">${missing.toLocaleString('es-AR')} </strong> para entrar al top 10
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-size:0.85rem;font-weight:800;color:#ffd600">${bal.toLocaleString('es-AR')}</div>
              <div style="font-size:0.65rem;color:rgba(255,255,255,0.3)"></div>
            </div>
          </div>`;
        myPosEl.style.display = 'block';
      } else if (myIdx >= 0) {
        // Está en top 10 — ya destacado en la lista
        myPosEl.innerHTML = `
          <div class="rk-mypos">
            <div style="font-size:1.1rem">🎉</div>
            <div style="flex:1;font-size:0.82rem;color:var(--verde);font-weight:700">
              ¡Estás en el Top 10! Si mantenés tu posición al final del mes ganás <strong>$20 USD gratis</strong>.
            </div>
          </div>`;
        myPosEl.style.display = 'block';
      }
    }

    // Dot en la nav (si el usuario está en top 10)
    const navDot = document.getElementById('rankingNavDot');
    if (navDot && meEmail) {
      const myRank = rows.findIndex(u => u.email === meEmail);
      navDot.style.display = myRank >= 0 && myRank < 10 ? 'block' : 'none';
    }

  } catch(e) {
    document.getElementById('rkLoading').innerHTML = `<div style="color:rgba(255,80,80,0.7);font-size:0.82rem">Error cargando el ranking: ${e.message || e}</div>`;
    console.error('[Ranking]', e);
  }
}

// ══════════════════════════════════════════════════════════════
// HALL OF FAME — Ganadores de meses anteriores
// Clave en shared_cache: winners_YYYY_MM  (ej: winners_2026_03)
// ══════════════════════════════════════════════════════════════

const RK_MONTH_NAMES = {
  '01':'Ene','02':'Feb','03':'Mar','04':'Abr','05':'May','06':'Jun',
  '07':'Jul','08':'Ago','09':'Sep','10':'Oct','11':'Nov','12':'Dic'
};

// ── Ganadores históricos hardcodeados (se sincronizan a shared_cache al iniciar) ──
const RK_STATIC_WINNERS = {
  'winners_2026_03': [
    { nickname:'Ederson',  balance: 97000,  email:'sshisa98@gmail.com' },
    { nickname:'Pavl',     balance: 78770,  email:'paulybritney@gmail.com' },
    { nickname:'Salah',    balance: 39007,  email:'matii_fernandez11@hotmail.com' },
    { nickname:'Paredes',  balance: 31050,  email:'bocapasion98santi@gmail.com' },
    { nickname:'Olmo',     balance: 24300,  email:'crisclark22@gmail.com' },
    { nickname:'Dembélé',  balance: 24050,  email:'maximartin303@gmail.com' },
    { nickname:'Benzema',  balance: 23470,  email:'federiconicocozzani@gmail.com' },
    { nickname:'Joaco',    balance: 22660,  email:'joaquinantelo1@gmail.com' },
    { nickname:'alejo',    balance: 20920,  email:'emaaanuel2020@gmail.com' },
    { nickname:'PITI',     balance: 20628,  email:'rhapsody_piti75@hotmail.com' },
  ]
};

// ── Set de emails que alguna vez estuvieron en Top 10 ──────────────────────
const RK_CHAMPIONS_SET = new Set(
  Object.values(RK_STATIC_WINNERS).flatMap(arr => arr.map(u => u.email))
);

// Badge dorado para ex-campeones (inline, sin romper layout)
function rkChampionBadge(email) {
  if (!email || !RK_CHAMPIONS_SET.has(email)) return '';
  const entries = Object.entries(RK_STATIC_WINNERS)
    .filter(([, arr]) => arr.some(u => u.email === email));
  const months = entries.map(([key]) => { const [,yyyy,mm] = key.split('_'); return `${RK_MONTH_NAMES[mm]||mm} '${(yyyy||'').slice(2)}`; });
  const tip = months.join(', ');
  const count = months.length;
  const trophies = count >= 2 ? '🏆🏆' : '🏆';
  const label   = count >= 2
    ? `${trophies} TOP10x${count}`
    : `${months[0]} ${trophies} TOP10`;
  return `<span title="Top 10 — ${tip}" style="display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(255,214,0,0.22),rgba(255,160,0,0.12));border:1px solid rgba(255,214,0,0.5);border-radius:5px;padding:1px 5px;font-size:0.62em;font-weight:900;color:#ffd600;letter-spacing:0.3px;vertical-align:middle;margin-left:5px;line-height:1.4;white-space:nowrap;flex-shrink:0">${label}</span>`;
}

// Badge de racha de victorias (🔥 + número)
function rkStreakBadge(streak) {
  if (!streak || streak < 2) return '';
  return `<span class="rk-streak-badge" style="display:inline-flex;align-items:center;gap:2px;background:linear-gradient(135deg,rgba(255,100,0,0.25),rgba(255,60,0,0.12));border:1px solid rgba(255,120,0,0.5);border-radius:5px;padding:1px 5px;font-size:0.62em;font-weight:900;color:#ff7a00;letter-spacing:0.3px;vertical-align:middle;margin-left:4px;line-height:1.4;white-space:nowrap;flex-shrink:0">🔥${streak}</span>`;
}

// Guarda los winners estáticos en shared_cache si todavía no existen
async function rkSyncStaticWinners() {
  if (authUser?.email !== ADMIN_EMAIL) return;
  for (const [key, data] of Object.entries(RK_STATIC_WINNERS)) {
    try {
      const { data: existing } = await sbClient
        .from('shared_cache').select('key').eq('key', key).maybeSingle();
      if (!existing) {
        await sbClient.from('shared_cache')
          .upsert({ key, data, fetched_at: new Date().toISOString() }, { onConflict: 'key' });
        console.log('[HallOfFame] Guardado:', key);
      }
    } catch(e) { console.warn('[HallOfFame] Error sync:', key, e.message); }
  }
}

// Puntos por posición mensual para tabla anual
const RK_ANNUAL_PTS = [10, 7, 5, 4, 3, 2, 1, 1, 1, 1];

// ── Historia navegable ────────────────────────────────────────────
let _rkHistoryAllRows   = [];   // past months { key, winners[] }
let _rkCurrentTop10     = [];   // current month live top-10
let _rkHistoryActiveTab = null;

function _rkMonthLabel(key) {
  const [, yyyy, mm] = key.split('_');
  return `${RK_MONTH_NAMES[mm]||mm} '${yyyy?.slice(2)}`;
}

function _renderCurrentMonthCard() {
  const now = new Date();
  const mm2 = String(now.getMonth()+1).padStart(2,'0');
  const yy2 = now.getFullYear();
  const label = `${RK_MONTH_NAMES[mm2]||mm2} '${String(yy2).slice(2)}`;
  const MEDALS = ['🥇','🥈','🥉'];
  if (!_rkCurrentTop10.length) {
    return `<div style="background:rgba(255,214,0,0.04);border:1px solid rgba(255,214,0,0.18);border-radius:14px;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:rgba(255,214,0,0.08);border-bottom:1px solid rgba(255,214,0,0.12)">
        <div style="font-size:0.82rem;font-weight:800;color:#ffd600;letter-spacing:0.5px">📅 ${label} — En curso</div>
        <div style="font-size:0.7rem;color:rgba(255,255,255,0.35)">$20 USD c/u</div>
      </div>
      <div style="padding:20px 16px;text-align:center;color:rgba(255,255,255,0.3);font-size:0.8rem">Cargando ranking...</div>
    </div>`;
  }
  return `<div style="background:rgba(255,214,0,0.04);border:1px solid rgba(255,214,0,0.18);border-radius:14px;overflow:hidden">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:rgba(255,214,0,0.08);border-bottom:1px solid rgba(255,214,0,0.12)">
      <div style="font-size:0.82rem;font-weight:800;color:#ffd600;letter-spacing:0.5px">📅 ${label} — En curso</div>
      <div style="font-size:0.7rem;color:rgba(255,255,255,0.35)">$20 USD c/u</div>
    </div>
    <div style="padding:10px 12px;display:flex;flex-direction:column;gap:5px">
      ${_rkCurrentTop10.map((u, i) => {
        const bal  = parseFloat(u.balance) || 0;
        const name = u.nickname || rkMaskEmail(u.email);
        const medal = MEDALS[i] || `${i+1}.`;
        return `<div style="display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:8px;${i<3?'background:rgba(255,214,0,0.06)':''}">
          <span style="font-size:0.85rem;min-width:22px;text-align:center">${medal}</span>
          <div style="flex:1;font-size:0.82rem;font-weight:600;color:${i===0?'#ffd600':i<3?'rgba(255,214,0,0.75)':'rgba(255,255,255,0.7)'};">${name}</div>
          <div style="font-size:0.75rem;color:rgba(255,255,255,0.35)">${acFmt(bal)} </div>
          <div style="font-size:0.68rem;background:rgba(0,200,83,0.12);border:1px solid rgba(0,200,83,0.25);color:var(--verde);border-radius:6px;padding:2px 7px;white-space:nowrap">$20 USD</div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function rkHistoryTab(key) {
  _rkHistoryActiveTab = key;
  document.querySelectorAll('.rk-hist-tab').forEach(btn => {
    const active = btn.dataset.tab === key;
    btn.style.background   = active ? 'rgba(255,214,0,0.2)'  : 'rgba(255,255,255,0.05)';
    btn.style.borderColor  = active ? 'rgba(255,214,0,0.5)'  : 'rgba(255,255,255,0.1)';
    btn.style.color        = active ? '#ffd600'               : 'rgba(255,255,255,0.5)';
    btn.style.fontWeight   = active ? '800'                   : '600';
  });
  const content = document.getElementById('rkHistoryContent');
  if (!content) return;
  if (key === '__annual__') {
    content.innerHTML = _renderAnnualTable(_rkHistoryAllRows);
  } else if (key === '__current__') {
    content.innerHTML = _renderCurrentMonthCard();
  } else {
    const row = _rkHistoryAllRows.find(r => r.key === key);
    content.innerHTML = row ? _renderMonthCard(row.key, row.winners) : '';
  }
}

function _rkBuildHistoryTabs() {
  const tabsEl = document.getElementById('rkHistoryTabs');
  if (!tabsEl) return;
  const now = new Date();
  const mm2 = String(now.getMonth()+1).padStart(2,'0');
  const yy2 = now.getFullYear();
  const currentLabel = `${RK_MONTH_NAMES[mm2]||mm2} '${String(yy2).slice(2)}`;
  const tabs = [
    { key: '__current__', label: currentLabel },
    ..._rkHistoryAllRows.map(r => ({ key: r.key, label: _rkMonthLabel(r.key) })),
    ...(_rkHistoryAllRows.length ? [{ key: '__annual__', label: '📊 Anual 2026' }] : [])
  ];
  tabsEl.innerHTML = tabs.map(t => {
    const isActive = t.key === (_rkHistoryActiveTab || '__current__');
    return `<button class="rk-hist-tab" data-tab="${t.key}" onclick="rkHistoryTab('${t.key}')"
      style="background:${isActive?'rgba(255,214,0,0.2)':'rgba(255,255,255,0.05)'};border:1px solid ${isActive?'rgba(255,214,0,0.5)':'rgba(255,255,255,0.1)'};color:${isActive?'#ffd600':'rgba(255,255,255,0.5)'};font-size:0.72rem;font-weight:${isActive?'800':'600'};padding:6px 14px;border-radius:20px;cursor:pointer;font-family:inherit;white-space:nowrap;transition:all 0.15s">${t.label}</button>`;
  }).join('');
}

function _renderMonthCard(key, winners) {
  const [, yyyy, mm] = key.split('_');
  const label = `${RK_MONTH_NAMES[mm] || mm} '${yyyy?.slice(2)}`;
  const MEDALS = ['🥇','🥈','🥉'];
  return `
    <div style="background:rgba(255,214,0,0.04);border:1px solid rgba(255,214,0,0.18);border-radius:14px;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:rgba(255,214,0,0.08);border-bottom:1px solid rgba(255,214,0,0.12)">
        <div style="font-size:0.82rem;font-weight:800;color:#ffd600;letter-spacing:0.5px">🏁 ${label} — Ganadores</div>
        <div style="font-size:0.7rem;color:rgba(255,255,255,0.35)">$20 USD c/u</div>
      </div>
      <div style="padding:10px 12px;display:flex;flex-direction:column;gap:5px">
        ${winners.slice(0,10).map((u, i) => {
          const bal  = parseFloat(u.balance) || 0;
          const name = u.nickname || rkMaskEmail(u.email);
          const medal = MEDALS[i] || `${i+1}.`;
          const hofBadge = rkChampionBadge(u.email);
          return `<div style="display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:8px;${i<3?'background:rgba(255,214,0,0.06)':''}">
            <span style="font-size:0.85rem;min-width:22px;text-align:center">${medal}</span>
            <div style="flex:1;font-size:0.82rem;font-weight:600;color:${i===0?'#ffd600':i<3?'rgba(255,214,0,0.75)':'rgba(255,255,255,0.7)'};">${name}${hofBadge}</div>
            <div style="font-size:0.75rem;color:rgba(255,255,255,0.35)">${acFmt(bal)} </div>
            <div style="font-size:0.68rem;background:rgba(0,200,83,0.12);border:1px solid rgba(0,200,83,0.25);color:var(--verde);border-radius:6px;padding:2px 7px;white-space:nowrap">$20 USD</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

function _renderAnnualTable(allRows) {
  // allRows: array de { key, winners[] }
  // Acumular  totales por email (suma de balances en todos los meses)
  const gMap = {}, names = {}, monthTags = {};
  for (const { key, winners } of allRows) {
    const [, , mm] = key.split('_');
    const tag = `${RK_MONTH_NAMES[mm]||mm}`;
    winners.forEach((u, i) => {
      const e = u.email;
      const bal = parseFloat(u.balance) || 0;
      gMap[e]      = (gMap[e] || 0) + bal;
      names[e]     = u.nickname || rkMaskEmail(e);
      monthTags[e] = monthTags[e] || [];
      monthTags[e].push({ tag, pos: i });
    });
  }
  const sorted = Object.entries(gMap).sort((a,b) => b[1]-a[1]);
  if (!sorted.length) return '';

  const MEDALS = ['🥇','🥈','🥉'];
  const totalMonths = allRows.length;
  return `
    <div style="background:rgba(255,214,0,0.04);border:1px solid rgba(255,214,0,0.25);border-radius:14px;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:rgba(255,214,0,0.1);border-bottom:1px solid rgba(255,214,0,0.15)">
        <div style="font-size:0.82rem;font-weight:800;color:#ffd600">🏆 Ranking Anual 2026</div>
        <div style="font-size:0.68rem;color:rgba(255,255,255,0.4)">${totalMonths} mes${totalMonths!==1?'es':''} ·  acumulados</div>
      </div>
      <div style="padding:10px 12px;display:flex;flex-direction:column;gap:5px">
        ${sorted.map(([email, total], i) => {
          const name = names[email];
          const tags = (monthTags[email]||[]).map(({tag,pos}) =>
            `<span style="font-size:0.6rem;background:rgba(255,214,0,${pos===0?'0.22':'0.1'});border:1px solid rgba(255,214,0,${pos===0?'0.4':'0.2'});border-radius:4px;padding:1px 4px;color:${pos===0?'#ffd600':'rgba(255,214,0,0.65)'};white-space:nowrap">${pos===0?'🥇':pos===1?'🥈':pos===2?'🥉':''}${tag}</span>`
          ).join(' ');
          const medal = MEDALS[i] || `${i+1}.`;
          return `<div style="display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:8px;${i<3?'background:rgba(255,214,0,0.06)':''}">
            <span style="font-size:0.85rem;min-width:22px;text-align:center">${medal}</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:0.82rem;font-weight:700;color:${i===0?'#ffd600':i<3?'rgba(255,214,0,0.8)':'rgba(255,255,255,0.75)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
              <div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:2px">${tags}</div>
            </div>
            <div style="font-size:0.82rem;font-weight:800;color:#ffd600;white-space:nowrap">${acFmt(total)} </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

async function loadPastWinners() {
  if (!document.getElementById('rkHistoryTabs')) return;

  // 1. Render inmediato desde datos estáticos
  _rkHistoryAllRows = Object.entries(RK_STATIC_WINNERS)
    .sort((a,b) => b[0].localeCompare(a[0]))
    .map(([key, winners]) => ({ key, winners }));

  _rkBuildHistoryTabs();
  rkHistoryTab(_rkHistoryActiveTab || '__current__');

  // 2. Enriquecer con Supabase
  try {
    const { data, error } = await sbAnon
      .from('shared_cache')
      .select('key,data')
      .like('key', 'winners_%')
      .order('key', { ascending: false });
    if (error || !data?.length) return;

    const staticKeys = new Set(Object.keys(RK_STATIC_WINNERS));
    _rkHistoryAllRows = [
      ...data.filter(r => !staticKeys.has(r.key)).map(r => ({ key: r.key, winners: Array.isArray(r.data)?r.data:[] })),
      ..._rkHistoryAllRows,
    ].sort((a,b) => b.key.localeCompare(a.key));

    _rkBuildHistoryTabs();
    rkHistoryTab(_rkHistoryActiveTab || '__current__');
  } catch(e) { console.warn('[HallOfFame]', e.message); }
}

// ── Cerrar mes (solo admin): congela top10, resetea balances a $10.000 ──
async function rkCerrarMes() {
  if (authUser?.email !== ADMIN_EMAIL) return;
  const now  = new Date();
  // "Cerrar" el mes anterior (ej: ejecutado en Abril → cierra Marzo)
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const yyyy = String(prev.getFullYear());
  const mm   = String(prev.getMonth() + 1).padStart(2, '0');
  const key  = `winners_${yyyy}_${mm}`;
  const label = `${RK_MONTH_NAMES[mm]} '${yyyy.slice(2)}`;

  if (!confirm(`¿Cerrar ${label}?\n\nEsto guardará el Top 10 actual como ganadores de ${label} y reseteará TODAS las fichas a $10.000.\n\n¡Esta acción no se puede deshacer!`)) return;

  try {
    // 1. Leer top 10 actual
    const { data: top, error: errTop } = await sbClient
      .from('acoin_users')
      .select('email, balance, nickname, avatar')
      .order('balance', { ascending: false })
      .limit(10);
    if (errTop) throw errTop;

    // 2. Guardar ganadores en shared_cache
    const { error: errSave } = await sbClient
      .from('shared_cache')
      .upsert({ key, data: top, fetched_at: new Date().toISOString() }, { onConflict: 'key' });
    if (errSave) throw errSave;

    // 3. Resetear todos los balances a $10.000
    const { error: errReset } = await sbClient
      .from('acoin_users')
      .update({ balance: 10000 })
      .not('email', 'is', null);
    if (errReset) throw errReset;

    alert(`✅ ${label} cerrado correctamente.\nTop 10 guardado y fichas reseteadas a $10.000.`);
    // Recargar ranking y hall of fame
    _rkLoaded = false;
    await loadRanking(true);
    await loadPastWinners();
  } catch(e) {
    alert('❌ Error al cerrar el mes: ' + (e.message || e));
    console.error('[rkCerrarMes]', e);
  }
}

// ── Reset Abril: deja 10.000 base + ganancias desde el 1 de Abril ──
async function rkResetConGananciasAbril() {
  if (authUser?.email !== ADMIN_EMAIL) return;

  if (!confirm(
    '¿Resetear fichas a $10.000 preservando ganancias de Abril?\n\n' +
    '• Los Top 10 de Marzo empezaron Abril con sus balances conocidos.\n' +
    '• Todos los demás empezaron con $10.000.\n' +
    '• Fórmula: nuevo = $10.000 + max(0, actual − inicio_abril)\n\n' +
    '¡Esta acción no se puede deshacer!'
  )) return;

  try {
    // Mapa de balances al inicio de Abril (= cierre de Marzo) para los Top 10 conocidos
    const march31Map = {};
    (RK_STATIC_WINNERS['winners_2026_03'] || []).forEach(w => {
      if (w.email) march31Map[w.email.toLowerCase()] = w.balance;
    });

    // Leer TODOS los usuarios (paginamos de a 1000 por si hay muchos)
    let allUsers = [];
    let from = 0;
    const PAGE = 1000;
    while (true) {
      const { data, error } = await sbClient
        .from('acoin_users')
        .select('email, balance')
        .not('email', 'is', null)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allUsers = allUsers.concat(data);
      if (data.length < PAGE) break;
      from += PAGE;
    }

    // Filtrar internos (eventos, broadcast, etc.)
    const realUsers = allUsers.filter(u => u.email && !u.email.startsWith('__'));

    let updated = 0;
    let errors = 0;
    for (const u of realUsers) {
      const emailLow  = u.email.toLowerCase();
      const abrilStart = march31Map[emailLow] ?? 10000; // inicio de Abril para este user
      const aprilGains = Math.max(0, (u.balance || 0) - abrilStart);
      const newBalance = 10000 + aprilGains;

      if (Math.abs((u.balance || 0) - newBalance) < 0.01) continue; // ya está bien

      const { error: e } = await sbClient
        .from('acoin_users')
        .update({ balance: newBalance })
        .eq('email', u.email);
      if (e) { errors++; console.warn('[Reset] Error en', u.email, e.message); }
      else updated++;
    }

    alert(
      `✅ Reset completado.\n` +
      `• ${updated} fichas actualizadas\n` +
      `• ${errors} errores\n` +
      `• ${realUsers.length - updated - errors} sin cambios (ya tenían el valor correcto)`
    );

    _rkLoaded = false;
    await loadRanking(true);
  } catch(e) {
    alert('❌ Error en Reset Abril: ' + (e.message || e));
    console.error('[rkResetConGananciasAbril]', e);
  }
}

// ── Admin Stats (usa acoin_users con emails __ev_TYPE_...__ — sin tabla nueva) ──
async function admLoadStats() {
  const grid      = document.getElementById('admStatsGrid');
  const liveEl    = document.getElementById('admStatsLiveNum');
  const promosBox  = document.getElementById('admStatsPromos');
  const promosList = document.getElementById('admStatsPromosList');
  if (!grid) return;

  if (liveEl) liveEl.textContent = _gbLiveCount || '0';
  grid.innerHTML = '<div style="text-align:center;color:var(--texto-sec);font-size:0.8rem;grid-column:1/-1;padding:20px">Cargando...</div>';

  try {
    const now   = new Date();
    const fmtD  = d => d.toISOString().slice(0, 10); // YYYY-MM-DD
    const todayStr     = fmtD(now);
    const yesterdayStr = fmtD(new Date(now.getFullYear(), now.getMonth(), now.getDate()-1));
    const last7        = Array.from({length:7}, (_,i) => fmtD(new Date(now.getFullYear(), now.getMonth(), now.getDate()-i)));

    // Nuevo formato: una fila por día (balance = contador de visitas/clicks)
    // __ev_pv_YYYY-MM-DD__  y  __ev_pc_PROMO_YYYY-MM-DD__
    const [pvAll, pcAll, usersCount] = await Promise.all([
      sbClient.from('acoin_users').select('email,balance').like('email','__ev_pv_%'),
      sbClient.from('acoin_users').select('email,balance').like('email','__ev_pc_%'),
      sbClient.from('acoin_users').select('*',{count:'exact',head:true}).not('email','like','__%__'),
    ]);

    // Sumar page views por día
    const pvByDay = {};
    (pvAll.data||[]).forEach(r => {
      const m = r.email.match(/^__ev_pv_(\d{4}-\d{2}-\d{2})__$/);
      if (m) pvByDay[m[1]] = (r.balance || 0);
    });
    const pvHoy   = pvByDay[todayStr] || 0;
    const pvAyer  = pvByDay[yesterdayStr] || 0;
    const pv7d    = last7.reduce((s, d) => s + (pvByDay[d] || 0), 0);
    const pvTotal = Object.values(pvByDay).reduce((s, v) => s + v, 0);

    // Sumar promo clicks por día y por promo
    const pcByDay = {}; const pcByPromo = {};
    (pcAll.data||[]).forEach(r => {
      const m = r.email.match(/^__ev_pc_([a-z0-9]+)_(\d{4}-\d{2}-\d{2})__$/);
      if (m) {
        const [,promo,day] = m; const n = r.balance || 0;
        pcByDay[day] = (pcByDay[day]||0) + n;
        pcByPromo[promo] = (pcByPromo[promo]||0) + n;
      }
    });
    const pcHoy = pcByDay[todayStr] || 0;
    const pc7d  = last7.reduce((s, d) => s + (pcByDay[d]||0), 0);

    const statN = (n, label, icon) => `
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px;text-align:center">
        <div style="font-size:1.5rem;margin-bottom:2px">${icon}</div>
        <div style="font-size:1.4rem;font-weight:800;color:#fff;line-height:1.1">${n}</div>
        <div style="font-size:0.7rem;font-weight:700;color:var(--texto-sec);margin-top:3px">${label}</div>
      </div>`;

    grid.innerHTML =
      statN(pvHoy,             'VISITAS HOY',          '📅') +
      statN(pvAyer,            'VISITAS AYER',         '📆') +
      statN(pv7d,              'VISITAS 7 DÍAS',       '📊') +
      statN(pvTotal,           'VISITAS TOTAL',        '🌐') +
      `<div style="background:rgba(0,200,83,0.06);border:1px solid rgba(0,200,83,0.25);border-radius:12px;padding:14px;text-align:center">
        <div style="font-size:1.5rem;margin-bottom:2px">🟢</div>
        <div style="font-size:1.4rem;font-weight:800;color:#00c853;line-height:1.1">${_gbLiveCount || 0}</div>
        <div style="font-size:0.7rem;font-weight:700;color:var(--texto-sec);margin-top:3px">EN VIVO AHORA</div>
      </div>` +
      statN(usersCount?.count ?? '–', 'USUARIOS REGISTRADOS', '👥') +
      statN(pcHoy,             'CLICKS PROMOS HOY',    '🔗') +
      statN(pc7d,              'CLICKS PROMOS 7D',     '📈');

    // Breakdown de clicks por sponsor
    const sorted = Object.entries(pcByPromo).sort((a,b) => b[1]-a[1]);
    if (sorted.length) {
      const maxVal = sorted[0][1] || 1;
      promosList.innerHTML = sorted.map(([name, n]) => `
        <div style="display:flex;align-items:center;gap:8px">
          <div style="font-size:0.78rem;color:#fff;width:130px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
          <div style="flex:1;background:rgba(255,255,255,0.06);border-radius:4px;height:8px;overflow:hidden">
            <div style="height:100%;background:var(--verde);border-radius:4px;width:${Math.round(n/maxVal*100)}%"></div>
          </div>
          <div style="font-size:0.78rem;font-weight:700;color:var(--verde);min-width:24px;text-align:right">${n}</div>
        </div>`).join('');
      promosBox.style.display = '';
    }

  } catch(e) {
    grid.innerHTML = `<div style="color:#ef5350;font-size:0.78rem;grid-column:1/-1;padding:12px">Error: ${e.message}</div>`;
  }
}

function admTab(name, btn) {
  document.querySelectorAll('.adm-pane').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.adm-tab').forEach(b => {
    b.style.color = 'var(--texto-sec)';
    b.style.borderBottom = '2px solid transparent';
  });
  document.getElementById('adm-' + name).style.display = 'flex';
  btn.style.color = '#fff';
  btn.style.borderBottom = '2px solid var(--verde)';
}

// ── USUARIOS (Supabase) ──
let _admAllUsers = [];

async function admLoadUsers() {
  const statusEl = document.getElementById('admUserStatus');
  const listEl   = document.getElementById('admUserList');
  statusEl.textContent = '⏳ Cargando desde Supabase...';
  listEl.innerHTML = '';

  try {
    // Paginar para traer TODOS los usuarios — Supabase corta de a 1000 por
    // request, así que el total quedaba topado en 1000. Recorremos páginas.
    let _allUsers = [];
    for (let _from = 0; _from < 200000; _from += 1000) {
      const { data, error } = await sbAnon
        .from('acoin_users')
        .select('email, balance, nickname, updated_at, history')
        .order('updated_at', { ascending: false })
        .range(_from, _from + 999);
      if (error) throw error;
      _allUsers = _allUsers.concat(data || []);
      if (!data || data.length < 1000) break;
    }

    // 🧹 Filtrar contadores internos de analytics (__ev_pv_YYYY-MM-DD__, __ev_pc_promo_YYYY-MM-DD__).
    //    No son usuarios reales — son filas fantasma que usamos para llevar page views/clicks.
    //    Sin esto, el export CSV, copy emails y stats se mezclaban con estas filas.
    _admAllUsers = _allUsers.filter(u => {
      const e = u && u.email || '';
      return e && !/^__(ev_pv|ev_pc)_/.test(e) && !/^__.*__$/.test(e);
    });
    const total = _admAllUsers.length;

    // Stats
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    const semanaAtras = new Date(hoy); semanaAtras.setDate(semanaAtras.getDate() - 7);
    const nuevosHoy    = _admAllUsers.filter(u => u.updated_at && new Date(u.updated_at) >= hoy).length;
    const nuevosSemana = _admAllUsers.filter(u => u.updated_at && new Date(u.updated_at) >= semanaAtras).length;

    document.getElementById('admUserTotal').textContent   = total;
    document.getElementById('admUserHoy').textContent     = nuevosHoy;
    document.getElementById('admUserSemana').textContent  = nuevosSemana;

    statusEl.textContent = total > 0 ? `✅ ${total} usuario${total !== 1 ? 's' : ''} registrado${total !== 1 ? 's' : ''}` : '📭 Sin usuarios todavía';
    admRenderUserList(_admAllUsers);
  } catch(e) {
    statusEl.textContent = '❌ Error: ' + (e.message || e);
    console.error('[admLoadUsers]', e);
  }
}

function admRenderUserList(users) {
  const listEl = document.getElementById('admUserList');
  if (!users.length) {
    listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--texto-sec);font-size:0.82rem">Sin resultados</div>';
    return;
  }
  listEl.innerHTML = users.map((u, i) => {
    const fecha = u.updated_at ? new Date(u.updated_at).toLocaleDateString('es-AR', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '–';
    const bal   = typeof u.balance === 'number' ? u.balance : (parseFloat(u.balance) || 0);
    // Recargas admin: entradas del historial marcadas con admin:true
    const adminBadge = "";
    return `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px">
      <div style="width:28px;height:28px;border-radius:50%;background:rgba(0,200,83,0.15);border:1px solid rgba(0,200,83,0.25);display:flex;align-items:center;justify-content:center;font-size:0.72rem;font-weight:700;color:var(--verde);flex-shrink:0">${i+1}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:0.82rem;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${u.nickname ? `<span style="color:#ffd600">${u.nickname}</span> — ` : ''}${u.email} ${adminBadge}</div>
        <div style="font-size:0.68rem;color:var(--texto-sec);margin-top:1px">${fecha}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <button onclick="admVerPicks('${u.email}')" title="Ver historial de picks" style="background:rgba(0,200,83,0.12);border:1px solid rgba(0,200,83,0.25);color:var(--verde);width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:0.85rem;display:flex;align-items:center;justify-content:center;flex-shrink:0">📋</button>
      </div>
    </div>`;
  }).join('');
}

function admFilterUsers() {
  const q = (document.getElementById('admUserSearch').value || '').toLowerCase();
  const filtered = q ? _admAllUsers.filter(u => u.email && u.email.toLowerCase().includes(q)) : _admAllUsers;
  admRenderUserList(filtered);
}

// ── Modal dar  a usuario ──────────────────────────────────────────────────
function admOpenAddCoins(email, currentBal) { return; /* coins discontinuado */
  // Eliminar modal previo si existe
  const prev = document.getElementById('admAddCoinsModal');
  if (prev) prev.remove();

  const overlay = document.createElement('div');
  overlay.id = 'admAddCoinsModal';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)';
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  overlay.innerHTML = `
    <div style="background:#0f1a0f;border:1px solid rgba(255,214,0,0.4);border-radius:16px;padding:24px;width:100%;max-width:360px;box-shadow:0 0 40px rgba(255,214,0,0.15)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <div>
          <div style="font-weight:800;font-size:1rem;color:#fff">🪙 Dar  Coins</div>
          <div style="font-size:0.72rem;color:var(--texto-sec);margin-top:2px;word-break:break-all">${email}</div>
        </div>
        <button onclick="document.getElementById('admAddCoinsModal').remove()" style="background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.1);color:#fff;width:30px;height:30px;border-radius:50%;cursor:pointer;font-size:1rem">✕</button>
      </div>
      <div style="background:rgba(255,214,0,0.06);border:1px solid rgba(255,214,0,0.2);border-radius:10px;padding:10px 14px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between">
        <span style="font-size:0.78rem;color:var(--texto-sec)">Balance actual</span>
        <span style="font-weight:800;color:#ffd600;font-size:1rem"> ${currentBal.toLocaleString('es-AR')}</span>
      </div>
      <div style="margin-bottom:8px">
        <label style="font-size:0.75rem;font-weight:700;color:var(--texto-sec);text-transform:uppercase;letter-spacing:.8px">Monto a agregar (puede ser negativo para quitar)</label>
        <input id="admCoinsAmount" type="number" placeholder="Ej: 5000" autofocus
          style="margin-top:6px;width:100%;box-sizing:border-box;background:rgba(255,255,255,0.06);border:1px solid rgba(255,214,0,0.35);color:#fff;padding:10px 14px;border-radius:10px;font-size:1.1rem;font-weight:700;outline:none;text-align:center"
          onkeydown="if(event.key==='Enter')admConfirmAddCoins('${email}',${currentBal})"/>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
          ${[1000,2000,5000,10000,-1000,-5000].map(v =>
            `<button onclick="document.getElementById('admCoinsAmount').value='${v}'"
              style="flex:1;min-width:60px;background:rgba(${v>0?'0,200,83':'239,83,80'},0.1);border:1px solid rgba(${v>0?'0,200,83':'239,83,80'},0.25);color:${v>0?'var(--verde)':'#ef5350'};padding:6px 4px;border-radius:8px;cursor:pointer;font-size:0.78rem;font-weight:700">
              ${v>0?'+':''}${v.toLocaleString('es-AR')}
            </button>`
          ).join('')}
        </div>
      </div>
      <div id="admCoinsMsg" style="font-size:0.78rem;min-height:18px;margin-bottom:10px;text-align:center"></div>
      <button onclick="admConfirmAddCoins('${email}',${currentBal})"
        style="width:100%;background:linear-gradient(135deg,#ffd600,#ffab00);color:#000;font-weight:800;padding:12px;border-radius:10px;cursor:pointer;font-size:0.95rem;border:none">
        ✅ Confirmar y guardar
      </button>
    </div>`;

  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('admCoinsAmount')?.focus(), 100);
}

async function admConfirmAddCoins(email, currentBal) {
  const input = document.getElementById('admCoinsAmount');
  const msgEl = document.getElementById('admCoinsMsg');
  const amount = parseFloat(input?.value);

  if (!amount || isNaN(amount)) {
    msgEl.style.color = '#ef5350';
    msgEl.textContent = '⚠️ Ingresá un monto válido';
    return;
  }

  const newBal = Math.max(0, currentBal + amount);
  msgEl.style.color = 'var(--texto-sec)';
  msgEl.textContent = '⏳ Guardando...';

  try {
    // Leer historial actual del usuario para agregar la entrada de recarga admin
    const { data: uData } = await sbAnon.from('acoin_users').select('history').eq('email', email).maybeSingle();
    const prevHistory = Array.isArray(uData?.history) ? uData.history : [];
    const adminEntry  = { delta: amount, reason: '🪙 Recarga admin', ts: Date.now(), admin: true };
    const newHistory  = [adminEntry, ...prevHistory].slice(0, 100);

    const { error } = await sbAnon.from('acoin_users').upsert(
      { email, balance: newBal, history: newHistory, updated_at: new Date().toISOString() },
      { onConflict: 'email' }
    );
    if (error) throw error;

    msgEl.style.color = 'var(--verde)';
    msgEl.textContent = `✅ Balance actualizado:  ${newBal.toLocaleString('es-AR')}`;

    // Actualizar lista en memoria (balance + historial para que el badge se refresque)
    const u = _admAllUsers.find(u => u.email === email);
    if (u) { u.balance = newBal; u.history = newHistory; }

    setTimeout(() => {
      document.getElementById('admAddCoinsModal')?.remove();
      admRenderUserList(_admAllUsers);
      // Actualizar stats 
      const totalG = _admAllUsers.reduce((s, u) => s + (parseFloat(u.balance) || 0), 0);
      const avgG   = _admAllUsers.length > 0 ? Math.round(totalG / _admAllUsers.length) : 0;
      document.getElementById('admGTotal').textContent = totalG.toLocaleString('es-AR');
      document.getElementById('admGAvg').textContent   = avgG.toLocaleString('es-AR');
    }, 1200);

  } catch(e) {
    msgEl.style.color = '#ef5350';
    msgEl.textContent = '❌ Error: ' + (e.message || e);
  }
}

let _admSortMode = 'date';
function admSortUsers(mode) {
  _admSortMode = mode;
  // Highlight active button
  ['admSortDate','admSortBalD','admSortBalA'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.background = 'rgba(255,255,255,0.05)';
    el.style.borderColor = 'rgba(255,255,255,0.12)';
    el.style.color = '#fff';
  });
  const activeMap = { date:'admSortDate', bal_desc:'admSortBalD', bal_asc:'admSortBalA' };
  const activeEl = document.getElementById(activeMap[mode]);
  if (activeEl) {
    activeEl.style.background = 'rgba(255,214,0,0.15)';
    activeEl.style.borderColor = 'rgba(255,214,0,0.4)';
    activeEl.style.color = '#ffd600';
  }
  const sorted = [..._admAllUsers].sort((a, b) => {
    const balA = parseFloat(a.balance) || 0;
    const balB = parseFloat(b.balance) || 0;
    if (mode === 'bal_desc') return balB - balA;
    if (mode === 'bal_asc')  return balA - balB;
    // date: más reciente primero
    return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
  });
  admRenderUserList(sorted);
}

function admCopyEmails() {
  if (!_admAllUsers.length) { alert('Primero cargá los usuarios.'); return; }
  const txt = _admAllUsers.map(u => u.email).join('\n');
  navigator.clipboard.writeText(txt).then(() => {
    document.getElementById('admUserStatus').textContent = `✅ ${_admAllUsers.length} emails copiados al portapapeles`;
    setTimeout(() => { if(document.getElementById('admUserStatus')) document.getElementById('admUserStatus').textContent = ''; }, 3000);
  }).catch(() => {
    prompt('Copiá manualmente:', txt);
  });
}

function admExportCSV() {
  if (!_admAllUsers.length) { alert('Primero cargá los usuarios.'); return; }
  const header = 'Email, (),Última actividad';
  const rows = _admAllUsers.map(u => {
    const bal  = typeof u.balance === 'number' ? u.balance : (parseFloat(u.balance) || 0);
    const fecha = u.updated_at ? new Date(u.updated_at).toLocaleString('es-AR') : '';
    return `${u.email},${bal.toFixed(0)},"${fecha}"`;
  });
  const csv  = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `gambeta-ia_usuarios_${new Date().toISOString().slice(0,10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

// ── Historial ──
function admRenderHistTable() {
  const hist = loadHistorial();
  const el = document.getElementById('admHistTable');
  if (!hist.length) { el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--texto-sec);font-size:0.82rem">Sin entradas</div>'; return; }
  el.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:0.78rem">
    <thead><tr style="background:rgba(0,200,83,0.07)">
      <th style="padding:8px 12px;text-align:left;color:var(--texto-sec);font-size:0.7rem;text-transform:uppercase">Fecha</th>
      <th style="padding:8px 12px;text-align:left;color:var(--texto-sec);font-size:0.7rem;text-transform:uppercase">Partido</th>
      <th style="padding:8px 12px;text-align:left;color:var(--texto-sec);font-size:0.7rem;text-transform:uppercase">Rec.</th>
      <th style="padding:8px 12px;text-align:left;color:var(--texto-sec);font-size:0.7rem;text-transform:uppercase">Stake</th>
      <th style="padding:8px 12px;text-align:left;color:var(--texto-sec);font-size:0.7rem;text-transform:uppercase">Resultado</th>
      <th style="padding:8px 12px;text-align:left;color:var(--texto-sec);font-size:0.7rem;text-transform:uppercase">P/L</th>
      <th style="padding:8px 12px;"></th>
    </tr></thead>
    <tbody>${hist.map((h,i) => `
      <tr style="border-top:1px solid rgba(255,255,255,0.04)">
        <td style="padding:8px 12px;color:var(--texto-sec)">${h.date||'—'}</td>
        <td style="padding:8px 12px;color:#fff;font-weight:600">${h.home} vs ${h.away}</td>
        <td style="padding:8px 12px;color:var(--verde)">${_recLabel(h.rec, h.home, h.away)}</td>
        <td style="padding:8px 12px">$${h.stake||0}</td>
        <td style="padding:8px 12px">
          <select onchange="admSetResult(${i},this.value)" style="background:#1a2a1a;border:1px solid rgba(255,255,255,0.15);color:#fff;padding:3px 6px;border-radius:6px;font-size:0.75rem">
            <option value="pending" ${h.result==='pending'?'selected':''}>🟡 Pendiente</option>
            <option value="win"     ${h.result==='win'?'selected':''}>✅ WIN</option>
            <option value="loss"    ${h.result==='loss'?'selected':''}>❌ LOSS</option>
            <option value="void"    ${h.result==='void'?'selected':''}>⚪ VOID</option>
          </select>
        </td>
        <td style="padding:8px 12px;color:${h.pl>0?'var(--verde)':h.pl<0?'var(--rojo)':'#888'};font-weight:600">${h.pl>0?'+':''}${h.pl!==undefined?'$'+Math.abs(h.pl):'—'}</td>
        <td style="padding:8px 12px"><button onclick="admDeleteEntry(${i})" style="background:rgba(255,61,61,0.15);border:1px solid rgba(255,61,61,0.3);color:#ef5350;padding:3px 8px;border-radius:6px;cursor:pointer;font-size:0.72rem">✕</button></td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}
function admDeleteEntry(idx) {
  const hist = loadHistorial();
  hist.splice(idx,1);
  saveHistorial(hist);
  admRenderHistTable();
  renderHistorial(histFilter);
  document.getElementById('admHistMsg').textContent = '✓ Entrada eliminada';
  setTimeout(()=>document.getElementById('admHistMsg').textContent='',2500);
}
function admSetResult(idx, val) {
  const hist = loadHistorial();
  const h = hist[idx];
  h.result = val;
  const odds = parseFloat(h.odds)||1;
  h.pl = val==='win' ? parseFloat(((odds-1)*h.stake).toFixed(2)) : val==='loss' ? -h.stake : 0;
  if (val !== 'pending') h.resolvedAt = Date.now();
  saveHistorial(hist);
  renderHistorial(histFilter);
  document.getElementById('admHistMsg').textContent = '✓ Resultado actualizado';
  setTimeout(()=>document.getElementById('admHistMsg').textContent='',2500);
}
function admClearHist() {
  if (!confirm('¿Borrar TODO el historial?')) return;
  saveHistorial([]);
  admRenderHistTable();
  renderHistorial(histFilter);
  document.getElementById('admHistMsg').textContent = '✓ Historial limpiado';
  setTimeout(()=>document.getElementById('admHistMsg').textContent='',2500);
}
function admDeduplicateHist() {
  const hist = loadHistorial();
  const seen = new Set();
  const deduped = hist.filter(h => {
    const key = normTeam(h.home)+'_'+normTeam(h.away);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  saveHistorial(deduped);
  admRenderHistTable();
  renderHistorial(histFilter);
  document.getElementById('admHistMsg').textContent = `✓ Deduplicado: ${hist.length - deduped.length} entrada(s) eliminada(s)`;
  setTimeout(()=>document.getElementById('admHistMsg').textContent='',3000);
}
function admExportHist() {
  const hist = loadHistorial();
  const csv = ['Fecha,Local,Visitante,Recomendación,Cuota,Stake,Resultado,P/L',
    ...hist.map(h=>`${h.date||''},${h.home},${h.away},${h.rec||''},${h.odds||''},${h.stake||''},${h.result||''},${h.pl||0}`)
  ].join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'historial-apuestas.csv';
  a.click();
}

// ── Datos ──
function admRefreshStatus() {
  document.getElementById('admOddsCount').textContent  = (window._rawOddsGames||[]).length + ' partidos';
  document.getElementById('admScoresCount').textContent = (window.scoresData||[]).length + ' partidos';
  const preds = typeof buildPredsFromOdds === 'function' ? (buildPredsFromOdds()||[]) : [];
  document.getElementById('admPredsCount').textContent  = preds.length + ' pronósticos';
  // Mostrar alerta si los créditos de Odds API están agotados
  const creditAlert = document.getElementById('admOddsApiCreditAlert');
  if (creditAlert) creditAlert.style.display = window._oddsApiOutOfCredits ? 'block' : 'none';
}
async function admDiagWorker() {
  const box = document.getElementById('admWorkerDiag');
  box.style.display = 'block';
  box.textContent = '🔄 Testeando Worker...\n';
  const t0 = Date.now();
  const log = s => { box.textContent += s + '\n'; box.scrollTop = box.scrollHeight; };
  const testUrl = async (label, url) => {
    try {
      const r = await Promise.race([
        fetch(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT 10s')), 10000))
      ]);
      const ms = Date.now() - t0;
      if (!r.ok) {
        log(`❌ ${label} → HTTP ${r.status} (${ms}ms)`);
        try { const txt = await r.text(); log(`   Body: ${txt.slice(0,200)}`); } catch(e) {}
        return null;
      }
      const j = await r.json();
      const count = j.data ? j.data.length : (Array.isArray(j) ? j.length : '?');
      log(`✅ ${label} → ${count} partidos (${ms}ms)`);
      if (j.meta) {
        const failed = j.meta.filter(m => !m.ok);
        if (failed.length) log(`   ⚠️ Sports fallidos: ${failed.map(m=>m.sport+' HTTP'+m.status).join(', ')}`);
      }
      return j;
    } catch(e) {
      log(`❌ ${label} → ${e.message}`);
      return null;
    }
  };
  log(`Worker URL: ${WORKER_URL}\n`);
  await testUrl('/odds?category=main', `${WORKER_URL}/odds?category=main`);
  await testUrl('/odds?category=europe', `${WORKER_URL}/odds?category=europe`);
  await testUrl('/available', `${WORKER_URL}/available`);
  const stale = localStorage.getItem('cache_odds_stale_v10');
  log(`\n💾 Stale cache: ${stale ? JSON.parse(stale).length + ' partidos guardados' : 'vacía (nunca hubo conexión exitosa)'}`);
  const fresh = localStorage.getItem('cache_odds_v10');
  log(`💾 Fresh cache: ${fresh ? 'activa' : 'expirada/vacía'}`);
  const raw = window._rawOddsGames || [];
  log(`\n🔍 _rawOddsGames en memoria: ${raw.length} partidos`);
  if (raw.length) {
    const now2 = Date.now();
    const withH2H2 = raw.filter(g => g.bookmakers?.some(b => b.markets?.some(m => m.key==='h2h'))).length;
    const future2h = raw.filter(g => new Date(g.commence_time).getTime() > now2 - 7200000).length;
    const future7d = raw.filter(g => { const t=new Date(g.commence_time).getTime(); return t>(now2-7200000)&&t<=(now2+168*3600000); }).length;
    const sample = raw.slice(0,3).map(g=>`${g.home_team} vs ${g.away_team} @ ${g.commence_time}`).join('\n   ');
    log(`   con h2h: ${withH2H2} | futuros±2h: ${future2h} | dentro de 7d: ${future7d}`);
    log(`   Muestra:\n   ${sample}`);
  }
  if (window._lastPredsError) log(`\n❌ Error en buildPredsFromOdds:\n   ${window._lastPredsError}`);
  else log(`\n✅ Sin errores JS en buildPredsFromOdds`);
  log(`\nListo. Revisá los ❌ arriba para saber qué arreglar.`);
}

function admRefreshScores() { loadRealScores(); document.getElementById('admDatosMsg').textContent='🔄 Recargando marcadores...'; setTimeout(()=>{ admRefreshStatus(); document.getElementById('admDatosMsg').textContent='✓ Marcadores recargados'; },3000); }
function admRefreshPreds()  {
  // Borrar caché diaria para forzar regeneración desde la API
  try { localStorage.removeItem('gambeta_daily_preds_v15'); } catch(_) {}
  renderPreds();
  document.getElementById('admDatosMsg').textContent='✓ Pronósticos regenerados (caché limpiada)';
  setTimeout(()=>document.getElementById('admDatosMsg').textContent='',3000);
}
function admResolveNow()    { loadHistoricalScores().then(()=>{ resolveCompletedGames(scoresData); renderHistorial(histFilter); admRenderHistTable(); document.getElementById('admDatosMsg').textContent='✓ Pendientes resueltos'; setTimeout(()=>document.getElementById('admDatosMsg').textContent='',2500); }); }

async function manualResolveResults() {
  const btn = document.getElementById('btnResolveManual');
  if (!btn || btn.dataset.loading === '1') return;
  btn.dataset.loading = '1';
  btn.textContent = '⏳ Consultando...';
  btn.style.opacity = '0.7';
  btn.style.cursor = 'not-allowed';
  try {
    const histBefore = loadHistorial().filter(h => h.result === 'pending').length;
    await loadHistoricalScores();
    resolveCompletedGames(scoresData || [], false);
    const histAfter = loadHistorial().filter(h => h.result === 'pending').length;
    const resolved = histBefore - histAfter;
    renderHistorial(histFilter);
    // Actualizar también las fichas de pronósticos si están visibles
    if (typeof renderPreds === 'function') renderPreds();
    btn.textContent = resolved > 0 ? `✅ ${resolved} resultado${resolved > 1 ? 's' : ''} actualizado${resolved > 1 ? 's' : ''}` : '✓ Sin cambios por ahora';
    btn.style.opacity = '1';
    setTimeout(() => {
      btn.dataset.loading = '0';
      // Volver a mostrar/ocultar según pendientes
      const stillPending = loadHistorial().some(h => h.result === 'pending');
      btn.style.display = stillPending ? 'flex' : 'none';
      if (stillPending) btn.textContent = '🔄 Actualizar resultados';
    }, 3000);
  } catch(e) {
    btn.textContent = '⚠️ Error al consultar';
    btn.style.opacity = '1';
    setTimeout(() => { btn.dataset.loading = '0'; btn.textContent = '🔄 Actualizar resultados'; btn.style.cursor = 'pointer'; }, 2500);
  }
}

// Mostrar/ocultar botón solo para admin y solo si hay pendientes
function syncResolveBtn() {
  const btn = document.getElementById('btnResolveManual');
  if (!btn) return;
  const isAdmin = authUser?.email === ADMIN_EMAIL;
  const hasPending = loadHistorial().some(h => h.result === 'pending');
  btn.style.display = (isAdmin && hasPending) ? 'flex' : 'none';
  btn.style.cursor = 'pointer';
}

// ── Bankroll ──
function admSetBankroll() {
  const val = parseFloat(document.getElementById('admBankrollVal').value);
  if (isNaN(val)||val<=0) return;
  try {
    const cfg = JSON.parse(localStorage.getItem(ADMIN_KEY)||'{}');
    cfg.bankrollInit = val;
    localStorage.setItem(ADMIN_KEY, JSON.stringify(cfg));
  } catch {}
  if (typeof bankrollData !== 'undefined') {
    bankrollData.initial = val;
    saveBankrollData();
    renderBankrollSummary(); drawBankrollChart(); renderBetsList();
  }
  document.getElementById('admBankrollMsg').textContent = `✓ Balance inicial actualizado a $${val}`;
  setTimeout(()=>document.getElementById('admBankrollMsg').textContent='',2500);
}
function admResetBankroll() {
  if (!confirm('¿Resetear el bankroll al valor inicial?')) return;
  if (typeof bankrollData !== 'undefined') {
    bankrollData.history = [];
    saveBankrollData();
    renderBankrollSummary(); drawBankrollChart(); renderBetsList();
  }
  document.getElementById('admBankrollMsg').textContent = '✓ Bankroll reseteado';
  setTimeout(()=>document.getElementById('admBankrollMsg').textContent='',2500);
}

// ── Config ──
async function admChangePin() {
  const p1 = document.getElementById('admNewPin1').value;
  const p2 = document.getElementById('admNewPin2').value;
  const msg = document.getElementById('admConfigMsg');
  if (!p1 || p1.length < 6) { msg.style.color='#ef5350'; msg.textContent='⛔ Mínimo 6 caracteres'; setTimeout(()=>{msg.textContent='';msg.style.color='var(--verde)'},3000); return; }
  if (p1 !== p2)             { msg.style.color='#ef5350'; msg.textContent='⛔ Las contraseñas no coinciden'; setTimeout(()=>{msg.textContent='';msg.style.color='var(--verde)'},3000); return; }
  const hash = await hashPin(p1);
  ADMIN_HASH_RUNTIME = hash; localStorage.setItem('apuestas_admin_hash_bk', hash);
  document.getElementById('admNewPin1').value = '';
  document.getElementById('admNewPin2').value = '';
  msg.style.color = 'var(--verde)';
  msg.textContent = '✓ Contraseña actualizada correctamente';
  setTimeout(()=>msg.textContent='', 3000);
}

function admSaveConfig() {
  const cfg = {
    threshHigh: parseInt(document.getElementById('admThreshHigh').value)||62,
    threshMed:  parseInt(document.getElementById('admThreshMed').value)||52,
    maxCards:   parseInt(document.getElementById('admMaxCards').value)||6,
  };
  try { const s=JSON.parse(localStorage.getItem(ADMIN_KEY)||'{}'); Object.assign(s,cfg); localStorage.setItem(ADMIN_KEY,JSON.stringify(s)); } catch {}
  document.getElementById('admConfigMsg').textContent = '✓ Configuración guardada (se aplica en el próximo reload)';
  setTimeout(()=>document.getElementById('admConfigMsg').textContent='',3000);
}

// ═══════════════════════════════════════════════════
//  BROADCAST CHAT — Admin → Todos los usuarios
// ═══════════════════════════════════════════════════
const BROADCAST_EMAIL   = '__broadcast__';
const BROADCAST_SEEN_KEY = 'gambeta_bcast_seen'; // localStorage: array de msg IDs vistos
const COIN_NOTIFS_KEY    = 'gambeta_coin_notifs'; // localStorage: notificaciones  personales

// Agrega una notificación  al inbox (sin popup, solo badge + inbox)
function _addCoinNotif(icon, title, sub) {
  return; /*  removido: sin notificaciones de coins */
  try {
    const notifs = JSON.parse('[]');
    notifs.unshift({ id: `cn_${Date.now()}`, icon, title, sub, ts: Date.now(), read: false });
    localStorage.setItem(COIN_NOTIFS_KEY, JSON.stringify(notifs.slice(0, 50)));
  } catch {}
  _updateInboxBadge();
}

function _bcastTimeAgo(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1)  return 'Ahora mismo';
  if (m < 60) return `Hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `Hace ${h}h`;
  const d = Math.floor(h / 24);
  return `Hace ${d} día${d !== 1 ? 's' : ''}`;
}

// ── Cargar mensajes del historial en el panel admin ──
async function admLoadBroadcastHistory() {
  const box = document.getElementById('admBroadcastHistory');
  if (!box) return;
  box.innerHTML = '<div style="text-align:center;color:var(--texto-sec);font-size:0.78rem;margin:auto">Cargando...</div>';
  try {
    const { data, error } = await sbAnon
      .from('acoin_users')
      .select('picks')
      .eq('email', BROADCAST_EMAIL)
      .maybeSingle();
    const msgs = (data?.picks || []).sort((a,b) => b.ts - a.ts);
    if (!msgs.length) {
      box.innerHTML = '<div style="text-align:center;color:var(--texto-sec);font-size:0.78rem;margin:auto">Sin mensajes enviados aún</div>';
      return;
    }
    box.innerHTML = msgs.map(m => {
      const imgThumb = m.imageUrl
        ? `<img loading="lazy" decoding="async" src="${m.imageUrl}" style="width:100%;max-height:90px;object-fit:cover;border-radius:7px;margin-top:7px;display:block" onerror="this.style.display='none'">`
        : '';
      const pickBvr = m.pick?.bvr ? '💰'.repeat(Math.min(6, m.pick.bvr)) : '';
      const pickThumb = (m.pick?.home && m.pick?.away)
        ? `<div style="margin-top:7px;padding:7px 10px;background:rgba(0,200,83,0.08);border:1px solid rgba(0,200,83,0.2);border-radius:8px;font-size:0.75rem">
             <span style="color:#fff;font-weight:700">⚽ ${m.pick.home} vs ${m.pick.away}</span>
             ${m.pick.label ? `<span style="color:var(--verde);margin-left:6px">${m.pick.label}</span>` : ''}
             ${m.pick.odds  ? `<span style="color:#ffd600;margin-left:6px">@ ${m.pick.odds}</span>` : ''}
             ${pickBvr      ? `<span style="margin-left:6px">${pickBvr}</span>` : ''}
           </div>`
        : '';
      return `
      <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:10px 12px;position:relative">
        <div style="font-size:0.88rem;color:#fff;line-height:1.5;padding-right:28px">${_linkify(m.text)}</div>
        ${imgThumb}${pickThumb}
        <div style="font-size:0.7rem;color:var(--texto-sec);margin-top:6px;display:flex;justify-content:space-between;align-items:center">
          <span>📢 Admin${m.sticky ? ' 📌' : ''}${m.imageUrl ? ' 🖼️' : ''}${m.pick ? ' ⚽' : ''}</span>
          <span>${_bcastTimeAgo(m.ts)} · ${new Date(m.ts).toLocaleString('es-AR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
        </div>
        <button onclick="admDeleteBroadcast('${m.id}')" title="Eliminar mensaje" style="position:absolute;top:8px;right:8px;background:rgba(239,83,80,0.12);border:1px solid rgba(239,83,80,0.3);color:#ef5350;border-radius:6px;width:26px;height:26px;cursor:pointer;font-size:0.85rem;display:flex;align-items:center;justify-content:center;transition:background .15s" onmouseover="this.style.background='rgba(239,83,80,0.3)'" onmouseout="this.style.background='rgba(239,83,80,0.12)'">🗑️</button>
      </div>`;
    }).join('');
  } catch(e) {
    box.innerHTML = `<div style="color:#ff6b6b;font-size:0.78rem">Error: ${e.message}</div>`;
  }
}

// ── Admin elimina un mensaje permanentemente ──
// 🆕 (29-jun-2026) Fix #568: bypass RLS via worker /admin/delete-broadcast
//  El upsert directo cliente fallaba silenciosamente por RLS. Ahora vamos al
//  worker que usa SUPABASE_SERVICE_ROLE_KEY (bypassa RLS).
async function admDeleteBroadcast(msgId) {
  // 🔒 SEGURIDAD: solo admin puede borrar broadcasts.
  if (!authUser || authUser.email !== ADMIN_EMAIL) {
    console.warn('[admDeleteBroadcast] Bloqueado: no admin');
    return;
  }
  if (!msgId) { alert('Error: msgId vacío'); return; }
  if (!confirm('¿Eliminás este mensaje para todos los usuarios?')) return;
  try {
    const WORKER = 'https://apuestas-api.mauro-union10.workers.dev';
    const TOKEN  = 'gambeta_wc_2026_trigger';
    const r = await fetch(WORKER + '/admin/delete-broadcast?token=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgId })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      console.error('[admDeleteBroadcast] worker error:', r.status, j);
      alert('Error al eliminar: ' + (j.error || ('HTTP ' + r.status)));
      return;
    }
    console.log('[admDeleteBroadcast] ✅ Eliminado vía worker:', j);
    // Invalidar caché local + re-render
    try { localStorage.removeItem(_SB_CACHE_PREFIX + 'bcast'); } catch {}
    if (Array.isArray(window._broadcastMsgs)) {
      window._broadcastMsgs = window._broadcastMsgs.filter(m => m && m.id !== msgId);
    }
    admLoadBroadcastHistory();
    if (typeof _renderBcastStack === 'function') _renderBcastStack();
    if (typeof _updateInboxBadge === 'function') _updateInboxBadge();
  } catch(e) {
    console.error('[admDeleteBroadcast] exception:', e);
    alert('Error al eliminar: ' + (e?.message || e));
  }
}

// ── Admin envía un mensaje ──
function admBcastPreviewImage() {
  const url = (document.getElementById('admBroadcastImageUrl')?.value || '').trim();
  const wrap = document.getElementById('admBcastImagePreview');
  const img  = document.getElementById('admBcastImagePreviewImg');
  if (!url || !wrap || !img) return;
  img.src = url;
  wrap.style.display = 'block';
}

async function admSendBroadcast() {
  // 🔒 SEGURIDAD: solo el admin puede postear broadcasts.
  // Bug histórico: la UI escondía el panel pero el endpoint usaba sbAnon → cualquier visitante
  // podía postear vía consola. Ahora se chequea ADMIN_EMAIL y se usa sbClient (auth).
  if (!authUser || authUser.email !== ADMIN_EMAIL) {
    console.warn('[admSendBroadcast] Bloqueado: no admin');
    return;
  }
  const input = document.getElementById('admBroadcastInput');
  const msgEl = document.getElementById('admBroadcastMsg');
  const text  = (input?.value || '').trim();
  if (!text) { if (msgEl) { msgEl.style.color='#ef5350'; msgEl.textContent='Escribí un mensaje'; setTimeout(()=>msgEl.textContent='',2000); } return; }

  const sticky   = document.getElementById('admBroadcastSticky')?.checked || false;
  const imageUrl = (document.getElementById('admBroadcastImageUrl')?.value || '').trim() || null;

  // Pick adjunto (solo si tiene home + away como mínimo)
  const pickHome  = (document.getElementById('admBcastPickHome')?.value  || '').trim();
  const pickAway  = (document.getElementById('admBcastPickAway')?.value  || '').trim();
  const pickLabel = (document.getElementById('admBcastPickLabel')?.value || '').trim();
  const pickOdds  = parseFloat(document.getElementById('admBcastPickOdds')?.value) || null;
  const pickBvr   = parseInt(document.getElementById('admBcastPickBvr')?.value)   || null;
  const pick = (pickHome && pickAway)
    ? { home: pickHome, away: pickAway, label: pickLabel || null, odds: pickOdds, bvr: pickBvr }
    : null;

  const newMsg = { id: `bcast_${Date.now()}`, text, ts: Date.now(), sticky, imageUrl, pick };

  // Leer mensajes existentes (sbClient con auth — sbAnon ya no debe escribir aquí)
  let existing = [];
  try {
    const { data } = await sbClient.from('acoin_users').select('picks').eq('email', BROADCAST_EMAIL).maybeSingle();
    existing = data?.picks || [];
  } catch {}

  const updated = [newMsg, ...existing].slice(0, 50); // max 50 mensajes

  const { error } = await sbClient
    .from('acoin_users')
    .upsert({ email: BROADCAST_EMAIL, picks: updated, updated_at: new Date().toISOString() }, { onConflict: 'email' });

  if (error) {
    if (msgEl) { msgEl.style.color='#ef5350'; msgEl.textContent = '✗ Error al enviar'; setTimeout(()=>msgEl.textContent='',3000); }
    return;
  }

  input.value = '';
  // Limpiar campos extra
  ['admBroadcastImageUrl','admBcastPickHome','admBcastPickAway','admBcastPickLabel','admBcastPickOdds'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const bvrSel = document.getElementById('admBcastPickBvr'); if (bvrSel) bvrSel.value = '';
  const prevWrap = document.getElementById('admBcastImagePreview'); if (prevWrap) prevWrap.style.display = 'none';
  // Invalidar caché de broadcast para que todos los usuarios vean el nuevo mensaje
  try { localStorage.removeItem(_SB_CACHE_PREFIX + 'bcast'); } catch {}
  if (msgEl) { msgEl.style.color='var(--verde)'; msgEl.textContent = '✓ Mensaje enviado'; setTimeout(()=>msgEl.textContent='',3000); }
  admLoadBroadcastHistory();

  // Actualizar badge en tab
  const badge = document.getElementById('admMsgBadge');
  if (badge) { badge.style.display='block'; badge.textContent='●'; }

  // ── Mostrar la tarjeta en el stack izquierdo para el admin al instante ──
  // Actualizar _broadcastMsgs con el mensaje recién enviado y renderizar
  window._broadcastMsgs = updated;
  // Asegurarse de que el nuevo mensaje NO esté en la lista de descartados
  try {
    const dismissed = JSON.parse(localStorage.getItem(BROADCAST_DISMISS_KEY) || '[]');
    const cleaned = dismissed.filter(id => id !== newMsg.id);
    localStorage.setItem(BROADCAST_DISMISS_KEY, JSON.stringify(cleaned));
  } catch {}
  _renderBcastStack();
}

// ── Verificar mensajes no leídos al cargar la app ──
// Usa proxy /api/sb con caché de servidor Cloudflare (3 min compartido entre todos)
async function checkBroadcastMessages() {
  // Los mensajes broadcast (inbox de gambeta.ai) son SOLO para usuarios
  // registrados — no se muestran a visitantes anónimos.
  if (!authUser?.email) return;
  try {
    let picks = _sbGetCache('bcast');
    if (!picks) {
      try {
        const resp = await fetch('/api/sb?type=broadcast');
        if (resp.ok) {
          const rows = await resp.json();
          picks = rows?.[0]?.picks;
        }
      } catch {}
      // Fallback directo si el proxy falla
      if (!picks) {
        const { data, error } = await sbAnon
          .from('acoin_users').select('picks').eq('email', BROADCAST_EMAIL).maybeSingle();
        if (error || !data?.picks?.length) return;
        picks = data.picks;
      }
      if (picks?.length) _sbSetCache('bcast', picks, _SB_TTL_BCAST);
    }

    const msgs = picks;
    const seen = JSON.parse(localStorage.getItem(BROADCAST_SEEN_KEY) || '[]');
    const unread = msgs.filter(m => !seen.includes(m.id));

    if (!unread.length) return;
    _storeBroadcastMsgs(msgs);
    _showBroadcastNotif(unread.length);
  } catch(e) { console.warn('[broadcast]', e.message); }
}

function _storeBroadcastMsgs(msgs) {
  try { window._broadcastMsgs = msgs; } catch {}
  _updateInboxBadge();
}

const BROADCAST_DISMISS_KEY = 'gambeta_bcast_dismissed'; // IDs permanentemente eliminados
const BCAST_TTL_MS     = 24 * 60 * 60 * 1000; // 24 horas
const BCAST_MAX_VISIBLE = 3;

// Filtra mensajes expirados (no-sticky >24h) y descartados
function _bcastFilterVisible(msgs) {
  const dismissed = JSON.parse(localStorage.getItem(BROADCAST_DISMISS_KEY) || '[]');
  const now = Date.now();
  return (msgs || []).filter(m => {
    if (dismissed.includes(m.id)) return false;
    if (!m.sticky && (now - (m.ts || 0)) > BCAST_TTL_MS) return false;
    return true;
  });
}
function _linkify(text) {
  return (text || '').replace(/\n/g, '<br>').replace(
    /(https?:\/\/[^\s<"]+)/g,
    '<a href="$1" target="_blank" rel="noopener" style="color:#00c853;text-decoration:underline;word-break:break-all;">$1</a>'
  );
}

// Render cascade stack (máx 3 tarjetas + pill "+N más")
function _renderBcastStack() {
  const stack = document.getElementById('bcastStack');
  if (!stack) return;
  const visible = _bcastFilterVisible(window._broadcastMsgs || []);
  if (!visible.length) {
    stack.classList.remove('visible');
    stack.innerHTML = '';
    return;
  }
  const shown   = visible.slice(0, BCAST_MAX_VISIBLE);
  const overflow = visible.length - shown.length;
  stack.innerHTML = shown.map((m, i) => {
    const delay   = `${i * 60}ms`;
    const preview = (m.text || '').replace(/\n/g, ' ');
    const short   = preview.length > 58 ? preview.slice(0, 58) + '…' : preview;
    const hasImg  = !!m.imageUrl;
    const hasPick = !!(m.pick?.home && m.pick?.away);
    const extras  = [hasImg ? '🖼️' : '', hasPick ? '⚽' : ''].filter(Boolean).join(' ');
    return `
    <div class="bcast-card${m.sticky ? ' is-sticky' : ''}"
         style="animation-delay:${delay}"
         onclick="showBroadcastModal()">
      <button class="bcast-card-dismiss"
              onclick="event.stopPropagation();bcastDismissCard('${m.id}')"
              title="Cerrar">✕</button>
      <div class="bcast-card-icon">📢</div>
      <div class="bcast-card-body">
        <div class="bcast-card-label">gambeta.ai${m.sticky ? ' <span title="Mensaje fijo">📌</span>' : ''}${extras ? ` <span style="opacity:.7;font-size:.7rem">${extras}</span>` : ''}</div>
        <div class="bcast-card-text">${short}</div>
      </div>
    </div>`;
  }).join('');
  if (overflow > 0) {
    stack.innerHTML += `<div class="bcast-overflow-pill" onclick="showBroadcastModal()">+${overflow} más</div>`;
  }
  stack.classList.add('visible');
}

// Descarta (hide) una tarjeta individual
function bcastDismissCard(id) {
  const existing = JSON.parse(localStorage.getItem(BROADCAST_DISMISS_KEY) || '[]');
  const merged   = [...new Set([...existing, id])];
  try { localStorage.setItem(BROADCAST_DISMISS_KEY, JSON.stringify(merged)); } catch {}
  _renderBcastStack();
}

function _showBroadcastNotif(count) {
  _renderBcastStack();
}

// ── Abrir panel de chat de mensajes ──
function showBroadcastModal() {
  const panel   = document.getElementById('broadcastModal');
  const content = document.getElementById('broadcastModalContent');
  if (!panel || !content) return;

  const dismissed = JSON.parse(localStorage.getItem(BROADCAST_DISMISS_KEY) || '[]');
  const seen      = JSON.parse(localStorage.getItem(BROADCAST_SEEN_KEY) || '[]');
  const msgs      = (window._broadcastMsgs || [])
                    .filter(m => !dismissed.includes(m.id))
                    .sort((a,b) => b.ts - a.ts);

  if (!msgs.length) {
    _renderBcastStack();
    return;
  }

  content.innerHTML = msgs.map(m => {
    const isNew   = !seen.includes(m.id);
    const imgHtml = m.imageUrl
      ? `<img loading="lazy" decoding="async" src="${m.imageUrl}" class="bcast-msg-image" onerror="this.style.display='none'" alt="imagen">`
      : '';
    const pickBvr  = m.pick?.bvr ? '💰'.repeat(Math.min(6, m.pick.bvr)) : '';
    const pickHtml = (m.pick?.home && m.pick?.away) ? `
      <div class="bcast-pick-card">
        <div class="bcast-pick-teams">⚽ ${m.pick.home} vs ${m.pick.away}</div>
        <div class="bcast-pick-row">
          ${m.pick.label ? `<span class="bcast-pick-label">${m.pick.label}</span>` : ''}
          ${m.pick.odds  ? `<span class="bcast-pick-odds">@ ${m.pick.odds}</span>` : ''}
          ${pickBvr      ? `<span class="bcast-pick-bvr">${pickBvr}</span>` : ''}
        </div>
      </div>` : '';
    return `
    <div class="bcast-msg-item${isNew?' is-new':''}">
      ${isNew ? '<span class="bcast-msg-new-tag">NUEVO</span>' : ''}
      <div class="bcast-msg-text">${_linkify(m.text)}</div>
      ${imgHtml}
      ${pickHtml}
      <div class="bcast-msg-time">${_bcastTimeAgo(m.ts)} · ${new Date(m.ts).toLocaleString('es-AR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</div>
    </div>`;
  }).join('');

  panel.style.display = 'flex';
  _renderBcastStack(); // actualiza/oculta stack al abrir modal
}

// ── Cerrar panel (✓ Entendido) — marca como leídos ──
function bcastMarkRead() {
  const msgs   = (window._broadcastMsgs || []);
  const allIds = msgs.map(m => m.id);
  try { localStorage.setItem(BROADCAST_SEEN_KEY, JSON.stringify(allIds)); } catch {}
  closeBroadcastModal();
}

// ── Eliminar permanentemente — nunca volver a mostrar estos mensajes ──
function bcastDismissPermanent(e) {
  if (e) e.stopPropagation();
  const msgs = (window._broadcastMsgs || []);
  const ids  = msgs.map(m => m.id);
  const existing = JSON.parse(localStorage.getItem(BROADCAST_DISMISS_KEY) || '[]');
  const merged   = [...new Set([...existing, ...ids])];
  try { localStorage.setItem(BROADCAST_DISMISS_KEY, JSON.stringify(merged)); } catch {}
  // Marcar también como vistos
  try { localStorage.setItem(BROADCAST_SEEN_KEY, JSON.stringify(merged)); } catch {}
  closeBroadcastModal();
  _renderBcastStack();
}

function closeBroadcastModal() {
  const panel = document.getElementById('broadcastModal');
  if (panel) panel.style.display = 'none';
}

// ══════════════════════════════════════════════
//  INBOX — Bandeja de entrada del usuario
// ══════════════════════════════════════════════

// Actualiza el badge de la campana con los mensajes no leídos
function _updateInboxBadge() {
  const bell  = document.getElementById('inboxBellBtn');
  const badge = document.getElementById('inboxBadge');
  if (!bell || !badge) return;

  // La campana solo se muestra si hay usuario logueado
  const isLogged = !!(typeof authUser !== 'undefined' && authUser);
  bell.style.display = isLogged ? 'flex' : 'none';
  if (!isLogged) return;

  const msgs      = window._broadcastMsgs || [];
  let seen = []; try { seen = JSON.parse(localStorage.getItem(BROADCAST_SEEN_KEY) || '[]'); } catch(_) {}
  const unreadBC  = msgs.filter(m => !seen.includes(m.id)).length;

  let coinNotifs = []; try { coinNotifs = JSON.parse('[]'); } catch(_) {}
  const unreadCN   = coinNotifs.filter(n => !n.read).length;

  const unread = unreadBC + unreadCN;

  if (unread > 0) {
    badge.style.display = 'flex';
    badge.textContent   = unread > 9 ? '9+' : String(unread);
  } else {
    badge.style.display = 'none';
  }

  // Actualizar subtítulo del inbox si está abierto
  const sub = document.getElementById('inboxSubtitle');
  if (sub) sub.textContent = unread > 0 ? `${unread} sin leer` : 'Todo leído';
}

// Abre el modal inbox y renderiza los mensajes
function openInbox() {
  const modal = document.getElementById('inboxModal');
  if (!modal) return;
  modal.style.display = 'flex';
  _renderInboxList();
}

function closeInbox() {
  const modal = document.getElementById('inboxModal');
  if (modal) modal.style.display = 'none';
}

function _renderInboxList() {
  const list = document.getElementById('inboxList');
  if (!list) return;

  const msgs      = (window._broadcastMsgs || []).slice().sort((a,b) => b.ts - a.ts);
  const seen      = JSON.parse(localStorage.getItem(BROADCAST_SEEN_KEY) || '[]');
  const coinNotifs = JSON.parse('[]');

  // Combinar y ordenar por ts descendente
  const allItems = [
    ...msgs.map(m => ({ ...m, _type: 'broadcast', _unread: !seen.includes(m.id) })),
    ...coinNotifs.map(n => ({ ...n, _type: 'coin', _unread: !n.read }))
  ].sort((a, b) => b.ts - a.ts);

  if (!allItems.length) {
    list.innerHTML = `<div style="text-align:center;padding:40px 0;color:var(--texto-sec);font-size:0.82rem">
      <div style="font-size:2rem;margin-bottom:8px">📭</div>
      No hay mensajes aún
    </div>`;
    return;
  }

  list.innerHTML = allItems.map(item => {
    const isUnread = item._unread;
    const dateStr  = new Date(item.ts).toLocaleString('es-AR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});

    if (item._type === 'coin') {
      // Notificación  — acento dorado
      const bg     = isUnread ? 'rgba(255,214,0,0.06)' : 'rgba(255,255,255,0.03)';
      const border = isUnread ? 'rgba(255,214,0,0.25)' : 'rgba(255,255,255,0.07)';
      const dot    = isUnread ? `<span style="position:absolute;top:10px;right:12px;width:8px;height:8px;background:#ffd600;border-radius:50%;box-shadow:0 0 6px #ffd600"></span>` : '';
      return `
      <div onclick="inboxMarkCoinRead('${item.id}')" style="background:${bg};border:1px solid ${border};border-radius:12px;padding:12px 14px;cursor:pointer;transition:background .15s;position:relative">
        ${dot}
        <div style="display:flex;align-items:center;gap:8px;padding-right:${isUnread ? '18px' : '0'}">
          <span style="font-size:1.3rem;flex-shrink:0">${item.icon}</span>
          <div>
            <div style="font-size:0.85rem;font-weight:${isUnread ? '700' : '500'};color:${isUnread ? '#ffd600' : 'rgba(255,214,0,0.6)'}">${item.title}</div>
            <div style="font-size:0.76rem;color:var(--texto-sec);margin-top:1px">${item.sub}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;gap:6px">
          <span style="font-size:0.65rem;color:var(--texto-sec)">  · ${_bcastTimeAgo(item.ts)} · ${dateStr}</span>
          ${isUnread ? `<span style="font-size:0.6rem;font-weight:800;color:#ffd600;background:rgba(255,214,0,0.1);border:1px solid rgba(255,214,0,0.25);border-radius:6px;padding:1px 6px">NUEVO</span>` : ''}
        </div>
      </div>`;
    } else {
      // Broadcast — acento verde
      const bg     = isUnread ? 'rgba(0,200,83,0.06)' : 'rgba(255,255,255,0.03)';
      const border = isUnread ? 'rgba(0,200,83,0.2)' : 'rgba(255,255,255,0.07)';
      const dot    = isUnread ? `<span style="position:absolute;top:10px;right:12px;width:8px;height:8px;background:var(--verde);border-radius:50%;box-shadow:0 0 6px var(--verde)"></span>` : '';
      return `
      <div onclick="inboxMarkRead('${item.id}')" style="background:${bg};border:1px solid ${border};border-radius:12px;padding:12px 14px;cursor:pointer;transition:background .15s;position:relative">
        ${dot}
        <div style="font-size:0.83rem;color:${isUnread ? '#fff' : 'rgba(255,255,255,0.7)'};line-height:1.55;font-weight:${isUnread ? '600' : '400'};padding-right:${isUnread ? '18px' : '0'}">${_linkify(item.text)}</div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;gap:6px">
          <span style="font-size:0.65rem;color:var(--texto-sec)">📢 gambeta.ai${item.sticky ? ' 📌' : ''} · ${_bcastTimeAgo(item.ts)} · ${dateStr}</span>
          ${isUnread ? `<span style="font-size:0.6rem;font-weight:800;color:var(--verde);background:rgba(0,200,83,0.1);border:1px solid rgba(0,200,83,0.25);border-radius:6px;padding:1px 6px">NUEVO</span>` : ''}
        </div>
      </div>`;
    }
  }).join('');
}

// Marca una notificación  como leída
function inboxMarkCoinRead(notifId) {
  try {
    const notifs = JSON.parse('[]');
    const updated = notifs.map(n => n.id === notifId ? { ...n, read: true } : n);
    localStorage.setItem(COIN_NOTIFS_KEY, JSON.stringify(updated));
  } catch {}
  _updateInboxBadge();
  _renderInboxList();
}

// Marca un mensaje individual como leído al hacer clic
function inboxMarkRead(msgId) {
  const seen   = JSON.parse(localStorage.getItem(BROADCAST_SEEN_KEY) || '[]');
  if (!seen.includes(msgId)) {
    seen.push(msgId);
    try { localStorage.setItem(BROADCAST_SEEN_KEY, JSON.stringify(seen)); } catch {}
  }
  _updateInboxBadge();
  _renderInboxList();
}

// Marca todos como leídos (broadcasts + notifs )
function inboxMarkAllRead() {
  const msgs   = window._broadcastMsgs || [];
  const allIds = msgs.map(m => m.id);
  try { localStorage.setItem(BROADCAST_SEEN_KEY, JSON.stringify(allIds)); } catch {}
  try {
    const notifs  = JSON.parse('[]');
    const updated = notifs.map(n => ({ ...n, read: true }));
    localStorage.setItem(COIN_NOTIFS_KEY, JSON.stringify(updated));
  } catch {}
  _updateInboxBadge();
  _renderInboxList();
}

// ── Suscripción Realtime — entrega instantánea a usuarios online ──
function initBroadcastRealtime() {
  try {
    sbAnon
      .channel('db-broadcast')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'acoin_users',
        filter: `email=eq.${BROADCAST_EMAIL}`
      }, payload => {
        if (!authUser?.email) return;   // solo usuarios registrados
        const msgs = payload.new?.picks || [];
        if (!msgs.length) return;
        const seen   = JSON.parse(localStorage.getItem(BROADCAST_SEEN_KEY) || '[]');
        const unread = msgs.filter(m => !seen.includes(m.id));
        if (!unread.length) return;
        _storeBroadcastMsgs(msgs);
        _showBroadcastNotif(unread.length);
        // Toast rápido para el primer mensaje nuevo
        const first = unread[0];
        if (typeof showAcoinToast === 'function') {
          showAcoinToast('📢 Nuevo mensaje de Gambeta.ai', first.text.slice(0,60) + (first.text.length > 60 ? '…' : ''));
        }
      })
      .subscribe();
  } catch(e) { console.warn('[broadcast/realtime]', e.message); }
}

/* ── Banderas de pais como imagenes ───────────────────────────────────────
   Windows y muchos navegadores de escritorio NO renderizan los emojis de
   bandera (muestran "AR", "BR"...). Este modulo reemplaza, solo a nivel
   visual del DOM, cada emoji de bandera por una miniatura de flagcdn.com.
   No toca ningun string de datos: los emojis siguen intactos en memoria,
   asi que filtros, claves y comparaciones de texto no se ven afectados. */
(function(){
  // Pareja de regional indicators (paises) o secuencia tag de bandera negra
  // (Inglaterra / Escocia / Gales).
  var FLAG_RE = /(?:\uD83C[\uDDE6-\uDDFF]){2}|🏴(?:\uDB40[\uDC61-\uDC7A])+󠁿/g;
  function toCC(flag){
    var cps = Array.from(flag).map(function(c){ return c.codePointAt(0); });
    if (cps.length === 2 && cps[0] >= 0x1F1E6 && cps[0] <= 0x1F1FF){
      var a = cps[0] - 0x1F1E6, b = cps[1] - 0x1F1E6;
      if (a < 0 || a > 25 || b < 0 || b > 25) return null;
      return String.fromCharCode(97 + a) + String.fromCharCode(97 + b);
    }
    if (cps[0] === 0x1F3F4){
      var letters = '';
      for (var i = 1; i < cps.length; i++){
        var t = cps[i];
        if (t >= 0xE0061 && t <= 0xE007A) letters += String.fromCharCode(t - 0xE0061 + 97);
      }
      if (letters.length > 2) return letters.slice(0,2) + '-' + letters.slice(2);
      return null;
    }
    return null;
  }
  function flagImgHtml(cc){
    return '<img class="gb-flagimg" src="https://flagcdn.com/' + cc + '.svg" alt="" '
         + 'loading="lazy" decoding="async" style="display:inline-block;width:1.12em;'
         + 'height:0.82em;vertical-align:-0.13em;border-radius:2px;object-fit:cover;'
         + 'box-shadow:0 0 0 1px rgba(0,0,0,0.18);margin:0 0.06em">';
  }
  function processTextNode(tn){
    var txt = tn.nodeValue;
    if (!txt) return;
    FLAG_RE.lastIndex = 0;
    if (!FLAG_RE.test(txt)) return;
    FLAG_RE.lastIndex = 0;
    var frag = document.createDocumentFragment();
    var last = 0, m;
    while ((m = FLAG_RE.exec(txt))){
      if (m.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m.index)));
      var cc = toCC(m[0]);
      if (cc){
        var holder = document.createElement('span');
        holder.innerHTML = flagImgHtml(cc);
        if (holder.firstChild) frag.appendChild(holder.firstChild);
        else frag.appendChild(document.createTextNode(m[0]));
      } else {
        frag.appendChild(document.createTextNode(m[0]));
      }
      last = m.index + m[0].length;
    }
    if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
    if (tn.parentNode) tn.parentNode.replaceChild(frag, tn);
  }
  function flagify(root){
    if (!root) return;
    if (root.nodeType === 3){ processTextNode(root); return; }
    if (!root.querySelectorAll) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function(n){
        var p = n.parentNode;
        if (!p) return NodeFilter.FILTER_REJECT;
        var tag = p.nodeName;
        if (tag==='SCRIPT'||tag==='STYLE'||tag==='TEXTAREA'||tag==='OPTION'||tag==='NOSCRIPT')
          return NodeFilter.FILTER_REJECT;
        return /\uD83C[\uDDE6-\uDDFF]|🏴/.test(n.nodeValue || '')
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(processTextNode);
  }
  var _t = null;
  function scheduleFlagify(){
    if (_t) return;
    _t = setTimeout(function(){ _t = null; try { flagify(document.body); } catch(e){} }, 260);
  }
  function initFlagify(){
    try { flagify(document.body); } catch(e){}
    try {
      var obs = new MutationObserver(function(muts){
        for (var i = 0; i < muts.length; i++){
          if (muts[i].addedNodes && muts[i].addedNodes.length){ scheduleFlagify(); break; }
        }
      });
      obs.observe(document.body, { childList:true, subtree:true });
    } catch(e){}
  }
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', initFlagify);
  else initFlagify();
})();

