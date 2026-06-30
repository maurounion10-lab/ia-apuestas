// ═══ MY PICKS PANEL — extraído del HTML inline a archivo defer (#607) ═══

/* ── MY PICKS PANEL ─────────────────────────────────────────────────────── */
function renderMyPicks() {
  const panel   = document.getElementById('myPicksPanel');
  const divider = document.getElementById('myPicksDivider');
  if (!panel) return;

  // Solo visible para usuarios logueados
  const isLogged = !!localStorage.getItem('sb-auth-token') ||
                   !!localStorage.getItem('supabase.auth.token') ||
                   !!document.querySelector('.user-nav-controls')?.style?.display?.includes('flex') ||
                   window._currentUser;
  if (!isLogged) { panel.style.display = 'none'; if(divider) divider.style.display='none'; return; }

  const picks = acGetPicks();
  if (!picks || !picks.length) {
    panel.style.display = 'block';
    if(divider) divider.style.display = 'block';
    document.getElementById('myPicksStats').innerHTML = '';
    document.getElementById('myPicksList').innerHTML  = '';
    document.getElementById('myPicksEmpty').style.display = 'block';
    return;
  }

  panel.style.display = 'block';
  if(divider) divider.style.display = 'block';
  document.getElementById('myPicksEmpty').style.display = 'none';

  // ── Calcular stats ──
  const evaluated = picks.filter(p => p.evaluated);
  const pending   = picks.filter(p => !p.evaluated);
  const wins      = evaluated.filter(p => p.correct);
  const losses    = evaluated.filter(p => !p.correct);
  const winRate   = evaluated.length ? Math.round((wins.length / evaluated.length) * 100) : 0;

  // Ganancia neta en 
  const netCoins  = evaluated.reduce((acc, p) => acc + (p.coinsChange || 0), 0);
  const totalBet  = picks.reduce((acc, p) => acc + (p.betAmount || 1000), 0);
  const roi       = totalBet > 0 ? ((netCoins / totalBet) * 100).toFixed(1) : '0.0';

  // Racha actual (últimos evaluados)
  const lastEval = [...evaluated].sort((a,b) => (b.ts||0) - (a.ts||0));
  let streak = 0, streakType = '';
  for (const p of lastEval) {
    if (!streakType) { streakType = p.correct ? 'W' : 'L'; streak = 1; }
    else if ((p.correct && streakType==='W') || (!p.correct && streakType==='L')) streak++;
    else break;
  }
  const streakLabel = streak > 1
    ? (streakType === 'W' ? `🔥 Racha de ${streak} aciertos` : `❄️ Racha de ${streak} fallos`)
    : '';

  // ── Stats cards HTML ──
  const roiClass = parseFloat(roi) >= 0 ? 'roi-pos' : 'roi-neg';
  const roiColor = parseFloat(roi) >= 0 ? '#ffd600' : '#ef5350';
  const netColor = netCoins >= 0 ? '#00c853' : '#ef5350';
  const AC_ICON  = '';

  document.getElementById('myPicksStats').innerHTML = `
    <div class="mps-card">
      <div class="mps-val">${picks.length}</div>
      <div class="mps-label">Total picks</div>
    </div>
    <div class="mps-card win">
      <div class="mps-val" style="color:#00c853">${wins.length}</div>
      <div class="mps-label">Ganados</div>
    </div>
    <div class="mps-card loss">
      <div class="mps-val" style="color:#ef5350">${losses.length}</div>
      <div class="mps-label">Fallados</div>
    </div>
    <div class="mps-card">
      <div class="mps-val" style="color:${winRate>=50?'#00c853':'#ef5350'}">${winRate}%</div>
      <div class="mps-label">Acierto</div>
    </div>
    <div class="mps-card ${roiClass}">
      <div class="mps-val" style="color:${roiColor}">${parseFloat(roi)>=0?'+':''}${roi}%</div>
      <div class="mps-label">ROI</div>
    </div>
    <div class="mps-card">
      <div class="mps-val" style="color:${netColor};font-size:1.1rem">${netCoins>=0?'+':''}${acFmt(netCoins)}</div>
      <div class="mps-label">${AC_ICON} netos</div>
    </div>
  `;

  // ── Racha visual ──
  const last10 = [...evaluated].sort((a,b) => (b.ts||0) - (a.ts||0)).slice(0, 10).reverse();
  const streakHtml = last10.length ? `
    <div class="mypicks-streak">
      <span style="color:var(--texto-sec);font-size:0.68rem;margin-right:4px">Últimos ${last10.length}:</span>
      ${last10.map(p => `<div class="streak-dot ${p.correct?'w':'l'}">${p.correct?'✓':'✗'}</div>`).join('')}
      ${pending.length ? `<div class="streak-dot p">+${pending.length}</div>` : ''}
      ${streakLabel ? `<span style="color:var(--texto-sec);margin-left:6px">${streakLabel}</span>` : ''}
    </div>` : '';

  // ── Lista de picks ──
  const sortedPicks = [...picks].sort((a,b) => (b.ts||0) - (a.ts||0));
  const listHtml = sortedPicks.map(p => {
    const isWin  = p.evaluated && p.correct;
    const isLoss = p.evaluated && !p.correct;
    const isPend = !p.evaluated;
    const cls    = isWin ? 'mp-win' : isLoss ? 'mp-loss' : 'mp-pend';
    const badge  = isWin  ? `<span class="mp-badge win">✅ Ganado</span>`
                 : isLoss ? `<span class="mp-badge loss">❌ Fallado</span>`
                 :          `<span class="mp-badge pend">⏳ Pendiente</span>`;
    const labels = { home:'Local', draw:'Empate', away:'Visitante' };
    const pickLabel = labels[p.pick] || p.pick;
    const betAmt = p.betAmount || 1000;
    const chg = p.coinsChange;
    const coinsStr = isPend
      ? `<div class="mp-coins neu">${acFmt(betAmt)} ${AC_ICON}</div>`
      : chg > 0
        ? `<div class="mp-coins pos">+${acFmt(chg)} ${AC_ICON}</div>`
        : `<div class="mp-coins neg">-${acFmt(betAmt)} ${AC_ICON}</div>`;
    const dateStr = p.ts ? new Date(p.ts).toLocaleDateString('es-AR',{day:'2-digit',month:'2-digit'}) : '';
    return `<div class="mp-item ${cls}">
      <div>
        <div class="mp-match">${p.home} vs ${p.away}</div>
        <div class="mp-sub">${pickLabel}${p.odds ? ' · @'+parseFloat(p.odds).toFixed(2) : ''}${dateStr ? ' · '+dateStr : ''}</div>
      </div>
      ${badge}
      ${coinsStr}
    </div>`;
  }).join('');

  document.getElementById('myPicksList').innerHTML = streakHtml + listHtml;
}

/* ── SHARE PICK ─────────────────────────────────────────────────────────── */
function sharePick(home, away, rec, bvr, league) {
  const stars = '⭐'.repeat(Math.min(bvr, 6));
  const text = `🤖 gambeta.ai · Pick IA\n⚽ ${home} vs ${away}\n🏆 ${league}\n✅ ${rec}\n${stars} Confianza ${bvr}/6\n\n📲 Probá gratis en gambeta.ai`;
  const url = 'https://gambeta.ai';

  if (navigator.share) {
    // Web Share API nativa (móvil)
    navigator.share({ title: 'Pick de gambeta.ai', text, url }).catch(() => {});
  } else {
    // Fallback: copiar al portapapeles + mostrar toast
    const full = text + '\n' + url;
    navigator.clipboard.writeText(full).then(() => {
      _showShareToast('✅ Pick copiado al portapapeles');
    }).catch(() => {
      // último fallback: WhatsApp web
      window.open('https://wa.me/?text=' + encodeURIComponent(text + '\n' + url), '_blank');
    });
  }
}

function _showShareToast(msg) {
  let t = document.getElementById('shareToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'shareToast';
    t.style.cssText = `
      position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
      background:#00e5a0;color:#000;font-weight:700;font-size:0.82rem;
      padding:10px 20px;border-radius:20px;z-index:9999;
      box-shadow:0 4px 20px rgba(0,229,160,0.4);
      pointer-events:none;opacity:0;transition:opacity .2s;
    `;
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.opacity = '1';
  setTimeout(() => { t.style.opacity = '0'; }, 2500);
}

/* ── PUSH NOTIFICATIONS ─────────────────────────────────────────────────── */
const PUSH_WORKER_URL = 'https://gambeta-push.mauro-union10.workers.dev';
const VAPID_PUBLIC_KEY = 'BDTVKzR-OhVN67PlC1Is8vviD88E5BW4y2Lwv1ce4-Bv3lRMsqr42QBfPuQdQt73p7Fnw7oSC32TiowArd3yHhg';

async function initPushUI() {
  const card = document.getElementById('pushNotifCard');
  if (!card) return;
  // Solo mostrar si el navegador soporta push
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  card.style.display = 'block';
  await updatePushButtonState();
}

async function updatePushButtonState() {
  const btn      = document.getElementById('pushToggleBtn');
  const statusEl = document.getElementById('pushStatusText');
  if (!btn || !statusEl) return;

  const perm = Notification.permission;
  const reg  = await navigator.serviceWorker.getRegistration('/');
  let sub = reg ? await reg.pushManager.getSubscription() : null;

  if (perm === 'denied') {
    btn.textContent = 'Bloqueadas';
    btn.disabled = true;
    btn.style.opacity = '.4';
    statusEl.textContent = 'Habilitá las notificaciones en la configuración del navegador.';
    return;
  }

  if (sub) {
    btn.textContent = '🔔 Activadas';
    btn.classList.add('subscribed');
    statusEl.textContent = '¡Listo! Te avisamos cuando salgan los picks del día.';
  } else {
    btn.textContent = 'Activar';
    btn.classList.remove('subscribed');
    statusEl.textContent = 'Te mandamos el mejor pick gratis como notificación todos los días.';
  }
}

async function subscribeFromEmptyState() {
  const btn      = document.getElementById('esPushBtn');
  const statusEl = document.getElementById('esPushStatus');
  if (btn) btn.disabled = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      await sub.unsubscribe();
      await fetch(`${PUSH_WORKER_URL}/push/unsubscribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      if (btn)      { btn.textContent = 'Activar notificaciones'; btn.style.background = 'var(--verde)'; btn.style.color = '#000'; btn.style.border = 'none'; btn.disabled = false; }
      if (statusEl) statusEl.textContent = 'Una notificación cuando la IA encuentre un pick de calidad.';
    } else {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { if (btn) btn.disabled = false; return; }
      const appServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey });
      await fetch(`${PUSH_WORKER_URL}/push/subscribe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), email: authUser?.email || '' }),
      }).catch(() => {});
      if (btn)      { btn.textContent = '🔔 Notificaciones activas'; btn.style.background = 'rgba(0,200,83,0.18)'; btn.style.color = 'var(--verde)'; btn.style.border = '1.5px solid rgba(0,200,83,0.5)'; btn.disabled = false; }
      if (statusEl) statusEl.textContent = '¡Listo! Te avisamos cuando salgan los picks del día.';
    }
  } catch(e) {
    console.warn('[subscribeFromEmptyState]', e);
    if (btn) btn.disabled = false;
  }
  updatePushButtonState().catch(() => {});
}

function subscribeEmailNotif() {
  const input = document.getElementById('esEmailInput');
  if (!input) return;
  const email = input.value.trim();
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!ok) {
    input.style.borderColor = '#ef5350';
    input.style.boxShadow   = '0 0 0 2px rgba(239,83,80,0.2)';
    input.focus();
    return;
  }
  localStorage.setItem('gb_email_notif_v1', email);
  try {
    sbAnon.from('notif_subscribers')
      .upsert({ email, type: 'picks_alert', subscribed_at: new Date().toISOString() }, { onConflict: 'email' })
      .then(() => {}).catch(() => {});
  } catch(_) {}
  const card = document.getElementById('esEmailCard');
  if (card) card.innerHTML = `
    <div style="font-size:0.9rem;font-weight:700;color:var(--verde)">✅ ¡Anotado!</div>
    <div style="font-size:0.75rem;color:var(--texto-sec);margin-top:5px">Te avisamos por mail cuando haya pronósticos de calidad.</div>`;
}

async function togglePushSubscription() {
  const btn = document.getElementById('pushToggleBtn');
  btn.disabled = true;

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();

  if (sub) {
    // Desuscribir
    await sub.unsubscribe();
    await fetch(`${PUSH_WORKER_URL}/push/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
  } else {
    // Suscribir
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { btn.disabled = false; return updatePushButtonState(); }

    const appServerKey = urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: appServerKey,
    });
    const email = window._currentUser?.email || null;
    await fetch(`${PUSH_WORKER_URL}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), email }),
    }).catch(() => {});
  }

  btn.disabled = false;
  await updatePushButtonState();
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

/* ── SERVICE WORKER ─────────────────────────────────────────────────────── */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    // Desregistrar el SW viejo (sw.js) si sigue activo — fue reemplazado por sw2.js
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const reg of regs) {
        const swUrl = (reg.active || reg.installing || reg.waiting)?.scriptURL || '';
        if (swUrl.includes('/sw.js') && !swUrl.includes('/sw2.js')) {
          await reg.unregister();
          console.log('[SW] Desregistrado SW viejo:', swUrl);
        }
      }
    } catch(e) { console.warn('[SW] Error desregistrando viejo:', e); }

    // Registrar SW nuevo
    navigator.serviceWorker.register('/sw2.js', { updateViaCache: 'none' })
      .then(reg => {
        console.log('[SW] Registrado:', reg.scope);
        reg.update();
      })
      .catch(err => console.warn('[SW] Error:', err));

    // Recibir mensajes del SW (push in-page cuando la app está abierta)
    navigator.serviceWorker.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'push-in-page') {
        _showInPagePushToast(e.data.data || {});
      }
    });
  });
}

function _showInPagePushToast(data) {
  const toast = document.getElementById('inPagePushToast');
  if (!toast) return;
  document.getElementById('ipptTitle').textContent = data.title || 'gambeta.ai';
  document.getElementById('ipptBody').textContent  = data.body  || '';
  const url = data.url || '/';
  toast.onclick = function(e) {
    if (e.target.classList.contains('ippt-close')) return;
    window.location.href = url;
  };

  // ── Calcular top dinámicamente para nunca pisar ningún header fijo ──
  const _getBottom = id => {
    const el = typeof id === 'string' ? document.getElementById(id) : id;
    if (!el) return 0;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return 0;
    return el.getBoundingClientRect().bottom;
  };
  const navBottom     = _getBottom(document.querySelector('nav'));
  const sponsorBottom = _getBottom('dbbet-sponsor-bar');
  const pageBarBottom = _getBottom('gbPageBar');
  const toastTop      = Math.max(navBottom, sponsorBottom, pageBarBottom) + 10;
  toast.style.top = toastTop + 'px';
  // ─────────────────────────────────────────────────────────────────────

  toast.classList.add('ippt-show');
  // Auto-ocultar a los 6 segundos
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => toast.classList.remove('ippt-show'), 6000);
}

/// ═══ ADMIN: VER PICKS DE USUARIO ═══
let _admPicksEmail = '';
let _admPicksData  = null; // { historial_full, picks, balance, nickname }

async function admVerPicks(email) {
  _admPicksEmail = email;
  const modal   = document.getElementById('admUserPicksModal');
  const emailEl = document.getElementById('admPicksUserEmail');
  emailEl.textContent = email;
  modal.style.display = 'block';
  // Arrancar en pestaña  Picks (más relevante para soporte)
  admPicksTab('gpicks');
  await _admLoadPicksData(email);
}

async function _admLoadPicksData(email) {
  document.getElementById('admPicksStats').innerHTML =
    '<div style="font-size:0.78rem;color:var(--texto-sec)">⏳ Cargando...</div>';
  document.getElementById('admPicksList').innerHTML = '';
  try {
    const { data, error } = await sbAnon
      .from('acoin_users')
      .select('historial_full, picks, balance, nickname')
      .eq('email', email)
      .maybeSingle();
    if (error) throw error;
    if (!data) { document.getElementById('admPicksStats').innerHTML = '<div style="color:#ef5350">Usuario no encontrado</div>'; return; }
    _admPicksData = data;
    // Renderizar la pestaña activa
    const activeTab = document.querySelector('#admPicksTabs button.adm-tab-active');
    const tab = activeTab ? activeTab.dataset.tab : 'gpicks';
    _admRenderPicksTab(tab);
  } catch(e) {
    document.getElementById('admPicksStats').innerHTML = `<div style="color:#ef5350">Error: ${e.message}</div>`;
  }
}

function admPicksTab(tab) {
  document.querySelectorAll('#admPicksTabs button').forEach(b => {
    b.classList.toggle('adm-tab-active', b.dataset.tab === tab);
    b.style.borderBottom = b.dataset.tab === tab ? '2px solid var(--verde)' : '2px solid transparent';
    b.style.color = b.dataset.tab === tab ? '#fff' : 'var(--texto-sec)';
  });
  if (_admPicksData) _admRenderPicksTab(tab);
}

function _admRenderPicksTab(tab) {
  const statsEl = document.getElementById('admPicksStats');
  const listEl  = document.getElementById('admPicksList');
  const data    = _admPicksData;
  const statCard = (label, value, color) =>
    `<div style="flex:1;min-width:80px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:8px 10px;text-align:center">
      <div style="font-size:0.95rem;font-weight:800;color:${color}">${value}</div>
      <div style="font-size:0.62rem;color:var(--texto-sec);margin-top:2px">${label}</div>
    </div>`;

  if (tab === 'gpicks') {
    // ──  Picks (campo `picks` de acoin_users) ──
    const gpicks = (data.picks || []).slice().sort((a,b) => (b.ts||0)-(a.ts||0));
    const pend   = gpicks.filter(p => !p.evaluated);
    const wins   = gpicks.filter(p => p.evaluated && p.correct);
    const losses = gpicks.filter(p => p.evaluated && !p.correct);
    statsEl.innerHTML =
      statCard('Total ', gpicks.length, '#fff') +
      statCard('Pendientes', pend.length, pend.length > 0 ? '#ffd600' : 'var(--texto-sec)') +
      statCard('Ganados', wins.length, 'var(--verde)') +
      statCard('Perdidos', losses.length, 'var(--rojo)') +
      statCard('Saldo', (data.balance||0).toLocaleString('es-AR'), '#ffd600');
    if (!gpicks.length) {
      listEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--texto-sec);font-size:0.82rem">Sin pronósticos  registrados</div>';
      return;
    }
    const pickLabels = { home:'Local', draw:'Empate', away:'Visitante' };
    listEl.innerHTML = gpicks.map((p, idx) => {
      const fecha    = p.ts ? new Date(p.ts).toLocaleDateString('es-AR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '–';
      const partido  = `${p.home||'?'} vs ${p.away||'?'}`;
      const eleccion = pickLabels[p.pick] || p.pick || '–';
      const apuesta  = p.betAmount ? ` ${Number(p.betAmount).toLocaleString('es-AR')}` : '–';
      const retorno  = p.betAmount && p.odds ? ` ${Math.round(p.betAmount * p.odds).toLocaleString('es-AR')}` : '–';
      const cuota    = p.odds ? `x${Number(p.odds).toFixed(2)}` : '–';
      if (!p.evaluated) {
        // Pendiente — mostrar botón de resolución manual
        return `
        <div style="background:rgba(255,214,0,0.06);border:1px solid rgba(255,214,0,0.3);border-radius:10px;padding:10px 12px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
            <div style="min-width:0">
              <div style="font-size:0.78rem;font-weight:700;color:#ffd600">⏳ PENDIENTE</div>
              <div style="font-size:0.82rem;font-weight:600;color:#fff;margin-top:2px">⚽ ${partido}</div>
              <div style="font-size:0.68rem;color:var(--texto-sec);margin-top:3px">
                Puso <strong style="color:#ffd600">${apuesta}</strong> en <strong style="color:#fff">${eleccion}</strong> · ${cuota} · Retorno potencial: <strong style="color:var(--verde)">${retorno}</strong>
              </div>
              <div style="font-size:0.62rem;color:var(--texto-sec);margin-top:2px">${fecha}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
              <button onclick="admForceGPick('${_admPicksEmail}',${idx},'win')"
                style="background:rgba(0,200,83,0.2);border:1px solid rgba(0,200,83,0.5);color:var(--verde);padding:7px 12px;border-radius:8px;cursor:pointer;font-size:0.75rem;font-weight:800">
                ✅ GANÓ
              </button>
              <button onclick="admForceGPick('${_admPicksEmail}',${idx},'loss')"
                style="background:rgba(239,83,80,0.15);border:1px solid rgba(239,83,80,0.4);color:#ef5350;padding:7px 12px;border-radius:8px;cursor:pointer;font-size:0.75rem;font-weight:800">
                ❌ PERDIÓ
              </button>
            </div>
          </div>
        </div>`;
      }
      const icon  = p.correct ? '✅' : '❌';
      const color = p.correct ? 'var(--verde)' : 'var(--rojo)';
      const chg   = p.coinsChange != null ? p.coinsChange : (p.correct ? Math.round(p.betAmount * p.odds) : -(p.betAmount||0));
      return `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px">
        <div style="font-size:1.1rem;flex-shrink:0">${icon}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:0.78rem;font-weight:600;color:#fff">⚽ ${partido}</div>
          <div style="font-size:0.68rem;color:var(--texto-sec);margin-top:3px">
            ${eleccion} · ${cuota} · ${apuesta}
            <span style="color:${color};font-weight:700;margin-left:4px">${chg >= 0 ? '+' : ''} ${Number(chg).toLocaleString('es-AR')}</span>
          </div>
          <div style="font-size:0.62rem;color:var(--texto-sec);margin-top:1px">${fecha}</div>
        </div>
        <div style="font-size:0.72rem;font-weight:800;color:${color}">${p.correct ? 'GANÓ' : 'PERDIÓ'}</div>
      </div>`;
    }).join('');

  } else {
    // ── Historial pronósticos (historial_full) ──
    const hist = (data.historial_full || []).slice().reverse();
    const ganados = hist.filter(p => p.result === 'win').length;
    const perdidos= hist.filter(p => p.result === 'loss').length;
    const pend    = hist.filter(p => !p.result || p.result === 'pending').length;
    const wr      = (ganados + perdidos) > 0 ? Math.round(ganados/(ganados+perdidos)*100) : 0;
    statsEl.innerHTML =
      statCard('Total', hist.length, '#fff') +
      statCard('Ganados', ganados, 'var(--verde)') +
      statCard('Perdidos', perdidos, 'var(--rojo)') +
      statCard('Pendientes', pend, '#ffd600') +
      statCard('Win%', wr+'%', wr>=55?'var(--verde)':wr>=40?'#ffd600':'var(--rojo)');
    if (!hist.length) {
      listEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--texto-sec);font-size:0.82rem">Sin historial de pronósticos</div>';
      return;
    }
    const rIcon = r => r==='win'?'✅':r==='loss'?'❌':'⏳';
    const rColor= r => r==='win'?'var(--verde)':r==='loss'?'var(--rojo)':'#ffd600';
    listEl.innerHTML = hist.map(p => {
      const fecha = p.date ? new Date(p.date).toLocaleDateString('es-AR',{day:'2-digit',month:'short'}) : '–';
      const isWin = p.result==='win', isLoss = p.result==='loss';
      return `
      <div style="display:flex;align-items:center;gap:10px;padding:9px 12px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:10px">
        <div style="font-size:1rem;flex-shrink:0">${rIcon(p.result)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:0.77rem;font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">⚽ ${p.home||'?'} vs ${p.away||'?'}</div>
          <div style="font-size:0.67rem;color:var(--texto-sec);margin-top:2px">
            <span style="background:rgba(255,255,255,0.07);border-radius:4px;padding:1px 5px;color:#fff">${p.rec||'–'}</span>
            ${p.odds?`x${parseFloat(p.odds).toFixed(2)}`:''}
            ${p.stake?`·  ${Number(p.stake).toLocaleString('es-AR')}`:''}
            ${(isWin||isLoss)&&p.pl!=null?`<span style="color:${rColor(p.result)};font-weight:700;margin-left:3px">${isWin?'+':''} ${Number(p.pl).toLocaleString('es-AR')}</span>`:''}
            · ${fecha}
          </div>
        </div>
        <div style="font-size:0.72rem;font-weight:800;color:${rColor(p.result)}">${isWin?'GANÓ':isLoss?'PERDIÓ':'PEND.'}</div>
      </div>`;
    }).join('');
  }
}

// Forzar resolución de un  pick pendiente (admin)
async function admForceGPick(email, pickIdx, outcome) {
  if (!_admPicksData) return;
  const picks = [...(_admPicksData.picks || [])].sort((a,b)=>(b.ts||0)-(a.ts||0));
  const p = picks[pickIdx];
  if (!p || p.evaluated) return;

  const correct   = outcome === 'win';
  const betAmount = p.betAmount || 0;
  const returnAmt = correct ? Math.round(betAmount * (p.odds || 2)) : 0;
  const coinsChg  = correct ? returnAmt : -betAmount;

  // Marcar pick como evaluado
  p.evaluated  = true;
  p.correct    = correct;
  p.result     = outcome === 'win' ? 'home' : 'away'; // placeholder result
  p.coinsChange = coinsChg;

  // Calcular nuevo balance
  const currentBal = parseFloat(_admPicksData.balance) || 0;
  const newBal     = Math.max(0, currentBal + (correct ? returnAmt : 0));
  // (si perdió, la apuesta ya fue descontada al apostar — no descontar de nuevo)

  // Agregar entrada al historial de coins
  const { data: uData } = await sbAnon.from('acoin_users').select('history').eq('email', email).maybeSingle();
  const prevHistory = Array.isArray(uData?.history) ? uData.history : [];
  const histEntry = {
    delta: coinsChg,
    reason: correct ? `✅ ${p.home} vs ${p.away} (admin)` : `❌ ${p.home} vs ${p.away} (admin)`,
    ts: Date.now(), admin: true
  };

  try {
    // Guardar en la DB — actualizar picks y balance
    // Necesitamos todas las picks del usuario en orden original para guardar
    const allPicks = (_admPicksData.picks || []).map(q => {
      if (q.ts === p.ts && q.home === p.home && q.away === p.away && !q.evaluated) {
        return { ...q, evaluated:true, correct, result: p.result, coinsChange: coinsChg };
      }
      return q;
    });

    const { error } = await sbAnon.from('acoin_users').upsert(
      { email, picks: allPicks, balance: newBal,
        history: [histEntry, ...prevHistory].slice(0, 100),
        updated_at: new Date().toISOString() },
      { onConflict: 'email' }
    );
    if (error) throw error;

    // Actualizar datos en memoria y re-renderizar
    _admPicksData.picks   = allPicks;
    _admPicksData.balance = newBal;
    const u = _admAllUsers.find(u => u.email === email);
    if (u) u.balance = newBal;

    // Toast de confirmación
    const msg = correct
      ? `✅ Acreditados  ${returnAmt.toLocaleString('es-AR')} a ${email}`
      : `❌ Pick marcado como perdido para ${email}`;
    document.getElementById('admPicksStats').insertAdjacentHTML('beforebegin',
      `<div id="_admForceMsg" style="background:rgba(0,200,83,0.15);border:1px solid rgba(0,200,83,0.4);color:var(--verde);padding:10px 14px;border-radius:10px;font-size:0.82rem;font-weight:700;margin-bottom:12px">${msg}</div>`);
    setTimeout(() => document.getElementById('_admForceMsg')?.remove(), 4000);

    _admRenderPicksTab('gpicks');
    admRenderUserList(_admAllUsers);
  } catch(e) {
    alert('Error al guardar: ' + e.message);
  }
}
