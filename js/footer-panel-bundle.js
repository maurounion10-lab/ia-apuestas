// ═══ FOOTER PANEL — extraído del HTML inline a archivo defer (#607) ═══

(function(){
'use strict';

/* ── STATE ── */
let _fpOpen       = false;
let _fpTab        = 'hoy';     // hoy | semana | todos
let _fpView       = 'list';    // list | thread
let _fpThreadId   = null;
let _fpThreadMeta = null;
let _fpRealtime   = null;      // supabase channel (per-thread)
let _fpGlobalRt   = null;      // global channel for badge increments
let _fpUnread     = 0;         // current unread count
let _fpPosts      = [];
let _fpAccOpen    = null;      // currently expanded accordion thread ID
let _fpAllThreads = [];        // all fetched threads (for metadata lookup)
let _fpMyReacts   = {};        // postId → reaction_type | null
let _fpEmojiOpen  = false;
let _fpEmojiTarget= null;      // target textarea ref

const EMOJIS = ['⚽','🔥','💯','🎯','😂','👀','🤔','💪','😤','🙌',
                '❤️','😍','🤩','😎','🥶','😭','🤯','💀','👏','🤝',
                '✅','❌','⚡','🚀','🎉','🏆','💰','🎲','📊','🧠'];

/* ── DOM helpers ── */
const $  = id => document.getElementById(id);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

/* ── Time helper ── */
function _fTimeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)  return 'ahora';
  if (diff < 3600) return Math.floor(diff/60) + 'm';
  if (diff < 86400) return Math.floor(diff/3600) + 'h';
  return Math.floor(diff/86400) + 'd';
}

/* ── Avatar color ── */
function _fAvatarColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h<<5)-h);
  const hue = Math.abs(h) % 360;
  return `hsl(${hue},55%,42%)`;
}

/* ── Date formatter for matches ── */
function _fpFormatDate(ts) {
  if (!ts) return '';
  // ts may be in ms (13 digits) or seconds (10 digits)
  let ms = Number(ts);
  if (ms < 1e12) ms *= 1000; // convert seconds → ms
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const today    = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const matchDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  const time = `${hh}:${mm}`;
  const diff = Math.round((matchDay - today) / 86400000);
  if (diff === 0)  return `Hoy ${time}`;
  if (diff === 1)  return `Mañana ${time}`;
  if (diff === -1) return `Ayer ${time}`;
  const days = ['dom','lun','mar','mié','jue','vie','sáb'];
  return `${days[d.getDay()]} ${d.getDate()} ${time}`;
}

/* ── League slug → display name ── */
function _fpFormatLeague(slug) {
  if (!slug) return '';
  const MAP = {
    // UEFA
    'soccer_uefa_champions_league':           'Champions League',
    'soccer_uefa_europa_league':              'Europa League',
    'soccer_uefa_europa_conference_league':   'Conference League',
    'soccer_uefa_nations_league':             'Nations League',
    // England
    'soccer_epl':                             'Premier League',
    'soccer_england_efl_cup':                 'Carabao Cup',
    'soccer_england_efl_champ':               'Championship',
    'soccer_england_league1':                 'League One',
    'soccer_england_fa_cup':                  'FA Cup',
    // Spain
    'soccer_spain_la_liga':                   'La Liga',
    'soccer_spain_segunda_division':          'Segunda División',
    'soccer_spain_copa_del_rey':              'Copa del Rey',
    // Germany
    'soccer_germany_bundesliga':              'Bundesliga',
    'soccer_germany_bundesliga2':             '2. Bundesliga',
    // Italy
    'soccer_italy_serie_a':                   'Serie A',
    'soccer_italy_serie_b':                   'Serie B',
    // France
    'soccer_france_ligue_one':                'Ligue 1',
    'soccer_france_ligue_two':                'Ligue 2',
    // Netherlands
    'soccer_netherlands_eredivisie':          'Eredivisie',
    // Portugal
    'soccer_portugal_primeira_liga':          'Primeira Liga',
    // Turkey
    'soccer_turkey_super_league':             'Süper Lig',
    // Scotland
    'soccer_scotland_premiership':            'Premiership',
    // CONMEBOL
    'soccer_conmebol_libertadores':           'Copa Libertadores',
    'soccer_conmebol_sudamericana':           'Copa Sudamericana',
    // South America
    'soccer_argentina_primera_division':      'Liga Profesional',
    'soccer_argentina_segunda_division':      'Primera Nacional',
    'soccer_brazil_campeonato':               'Brasileirão',
    'soccer_brazil_serie_b':                  'Série B',
    'soccer_chile_campeonato':                'Primera División Chile',
    'soccer_colombia_primera_a':              'Liga BetPlay',
    'soccer_ecuador_liga_pro':                'LigaPro Ecuador',
    'soccer_peru_primera_division':           'Liga 1 Perú',
    'soccer_uruguay_primera_division':        'Primera División Uruguay',
    // CONCACAF
    'soccer_mexico_ligamx':                   'Liga MX',
    'soccer_usa_mls':                         'MLS',
    'soccer_concacaf_champions_cup':          'Champions Cup',
    // Others
    'soccer_saudi_pro_league':                'Pro League Arabia',
    'soccer_japan_j_league':                  'J1 League',
    'soccer_australia_aleague':               'A-League',
    'soccer_world_cup':                       'Mundial',
    'soccer_copa_america':                    'Copa América',
  };
  const lower = slug.toLowerCase();
  if (MAP[lower]) return MAP[lower];
  // Fallback: strip sport prefix and clean underscores
  return lower
    .replace(/^soccer_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/* ── Team shield: usa logoHtml() global (mismos escudos que las fichas) ── */
function _fpShield(name, size = 32) {
  if (typeof logoHtml === 'function') {
    return `<div class="fp-shield-wrap" title="${name}">${logoHtml(name, size)}</div>`;
  }
  // fallback initials si logoHtml no está disponible aún
  const parts = (name || '?').split(/[\s\.\-\_]+/).filter(w => w.length > 0);
  const inits = parts.length === 1 ? parts[0].slice(0,2).toUpperCase()
              : (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
  const color = _fAvatarColor(name);
  return `<div class="fp-shield" style="background:${color}" title="${name}">${inits}</div>`;
}

/* ── Toggle panel ── */
window.toggleForum = function() {
  _fpOpen = !_fpOpen;
  const panel    = $('forum-panel');
  const backdrop = $('forum-backdrop');
  const badge    = $('forumBadge');
  if (_fpOpen) {
    panel.classList.add('fp-open');
    if (backdrop) backdrop.classList.add('fp-open');
    // Clear unread badge + persist last-seen total
    _fpUnread = 0;
    if (badge) badge.style.display = 'none';
    _fpFetchAndSaveLastSeen();
    // Lock body scroll when modal is open
    document.body.style.overflow = 'hidden';
    if (_fpView === 'list') _fpRenderList();
    // Botón atrás de Android/iOS
    history.pushState({ fp: 'forum' }, '');
    _fpUpdateMobileBar();
  } else {
    panel.classList.remove('fp-open');
    if (backdrop) backdrop.classList.remove('fp-open');
    document.body.style.overflow = '';
    _fpUnsubscribe();
  }
};

window.closeForum = function() {
  _fpOpen = false;
  const panel    = $('forum-panel');
  const backdrop = $('forum-backdrop');
  if (panel)    panel.classList.remove('fp-open');
  if (backdrop) backdrop.classList.remove('fp-open');
  document.body.style.overflow = '';
  _fpUnsubscribe();
  _fpView = 'list';
  _fpThreadId = null;
};

/* ── Helpers barra mobile ── */
function _fpUpdateMobileBar() {
  const backBtn = $('fpMobileBack');
  if (!backBtn) return;
  backBtn.style.display = (_fpView === 'thread') ? '' : 'none';
}
window._fpMobileBack = function() {
  if (_fpView === 'thread') {
    fpBackToList();
  } else {
    closeForum();
  }
};

/* ── Botón atrás Android/iOS (popstate) ── */
window.addEventListener('popstate', function(e) {
  if (_fpOpen) {
    if (_fpView === 'thread') {
      fpBackToList();
      history.pushState({ fp: 'forum' }, ''); // mantiene el state para próximo back
    } else {
      closeForum();
    }
  }
});

/* ── Tab switch ── */
window.fpSetTab = function(tab, btn) {
  _fpTab = tab;
  _fpView = 'list';
  _fpThreadId = null;
  document.querySelectorAll('.fp-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  _fpRenderList();
  _fpUpdateMobileBar();
};

/* ── Render thread list ── */
async function _fpRenderList() {
  const body = $('fpBody');
  if (!body) return;
  body.innerHTML = '<div class="fp-loading">⏳ Cargando hilos...</div>';

  const now = new Date();
  const nowMs = now.getTime();
  const fiveDaysAgoMs = nowMs - 5 * 86400000;

  // Tab date filter (para pestaña "hoy" no filtramos por created_at sino por commenceTs)
  let fromDate = null;
  if (_fpTab === 'semana') {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    fromDate = d.toISOString();
  }

  try {
    const db = typeof sbAnon !== 'undefined' ? sbAnon : sbClient;

    // Fetch threads
    let q = db.from('forum_threads').select('*').order('created_at', { ascending: false });
    if (fromDate) q = q.gte('created_at', fromDate);
    const { data: threads, error } = await q.limit(100);
    if (error) throw error;

    if (!threads || threads.length === 0) {
      body.innerHTML = '<div class="fp-empty">Sin hilos por ahora 🏜️<br><small>Los hilos se crean automáticamente cuando hay pronósticos de IA.</small></div>';
      return;
    }

    // Fetch post counts per thread (trending)
    const threadIds = threads.map(t => t.id);
    const { data: postRows } = await db.from('forum_posts')
      .select('thread_id').in('thread_id', threadIds).eq('is_deleted', false);
    const postCounts = {};
    (postRows || []).forEach(p => { postCounts[p.thread_id] = (postCounts[p.thread_id] || 0) + 1; });

    // Fetch like counts (via reactions join to posts)
    const { data: likeRows } = await db.from('forum_reactions')
      .select('post_id, forum_posts!inner(thread_id)')
      .in('forum_posts.thread_id', threadIds)
      .eq('reaction_type', 'like');
    const likeCounts = {};
    (likeRows || []).forEach(r => {
      const tid = r.forum_posts?.thread_id;
      if (tid) likeCounts[tid] = (likeCounts[tid] || 0) + 1;
    });

    _fpAllThreads = threads;
    _fpAccOpen = null;
    _fpView = 'list';

    // Separate into POR JUGARSE / JUGADOS
    const upcoming = [], played = [];
    threads.forEach(t => {
      const pd = t.pick_data || {};
      let ts = Number(pd.commenceTs || 0);
      if (ts > 0 && ts < 1e12) ts *= 1000;
      const score = (postCounts[t.id] || 0) + (likeCounts[t.id] || 0);
      const enriched = { ...t, _ts: ts, _score: score };

      if (_fpTab === 'hoy') {
        // Solo partidos cuyo día es hoy (tanto jugados como no jugados)
        const matchDay = ts ? new Date(ts) : null;
        const todayStr = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
        const matchStr = matchDay ? `${matchDay.getFullYear()}-${matchDay.getMonth()}-${matchDay.getDate()}` : null;
        if (!matchStr || matchStr !== todayStr) return;
      }

      if (ts === 0 || ts > nowMs) {
        upcoming.push(enriched);
      } else if (ts > fiveDaysAgoMs) {
        played.push(enriched);
      }
      // Más de 5 días: se omite
    });

    // Ordenar por trending (score desc), luego por hora (asc para upcoming, desc para played)
    upcoming.sort((a, b) => (b._score - a._score) || (a._ts || 9e15) - (b._ts || 9e15));
    played.sort((a, b)   => (b._score - a._score) || (b._ts - a._ts));

    body.innerHTML = '';

    const renderSection = (label, cssClass, items) => {
      if (items.length === 0) return;
      const sHdr = el('div', 'fp-section-hdr ' + cssClass, `
        <span class="fp-section-dot"></span>
        <span class="fp-section-label">${label}</span>
        <span class="fp-section-count">${items.length}</span>
      `);
      body.appendChild(sHdr);
      // Group by league within section
      const byLeague = {};
      items.forEach(t => {
        const l = t.league || 'General';
        if (!byLeague[l]) byLeague[l] = [];
        byLeague[l].push(t);
      });
      Object.entries(byLeague).forEach(([league, leagueItems]) => {
        const hdr = el('div','fp-liga-hdr', `<span>${_fpFormatLeague(league)}</span>`);
        body.appendChild(hdr);
        leagueItems.forEach(t => body.appendChild(_fpThreadCard(t)));
      });
    };

    renderSection('POR JUGARSE', 'fp-section-upcoming', upcoming);
    renderSection('JUGADOS', 'fp-section-played', played);

    if (upcoming.length === 0 && played.length === 0) {
      body.innerHTML = '<div class="fp-empty">Sin partidos para mostrar 🏜️</div>';
    }

    const oc = $('fpOnlineCount');
    if (oc) oc.textContent = threads.length + ' hilo' + (threads.length !== 1 ? 's' : '');

  } catch(e) {
    console.error('Forum list error', e);
    body.innerHTML = '<div class="fp-empty">⚠️ Error cargando el foro.<br><small>' + (e.message||'') + '</small></div>';
  }
}

/* ── Thread card (accordion) ── */
function _fpThreadCard(t) {
  const pd   = t.pick_data || {};
  const home = t.home || pd.home || '?';
  const away = t.away || pd.away || '?';
  const pick = pd.rec  || pd.pick || pd.prediction || '';
  const conf = pd.bvrText || pd.conf || '';
  const dateStr = _fpFormatDate(pd.commenceTs);
  const score = t._score || 0;
  const isTrending = score >= 3; // 3+ interacciones = trending

  const tid = t.id.replace(/'/g,"\\'");

  const wrap = el('div', 'fp-acc');
  wrap.id = 'fpa-' + t.id;
  wrap.innerHTML = `
    <div class="fp-acc-hdr" onclick="fpAccToggle('${tid}')" role="button" aria-expanded="false">
      <div class="fp-acc-shields">
        ${_fpShield(home, 32)}
        <span class="fp-shield-vs">vs</span>
        ${_fpShield(away, 32)}
      </div>
      <div class="fp-acc-info">
        <div class="fp-acc-sub">
          ${pick ? `<span class="fp-pick-badge">🤖 ${pick}</span>` : ''}
          ${conf ? `<span class="fp-conf-tag">${conf}</span>` : ''}
          ${dateStr ? `<span class="fp-date-tag">📅 ${dateStr}</span>` : ''}
          ${isTrending ? `<span class="fp-trending-badge">🔥 ${score}</span>` : ''}
        </div>
      </div>
      <div class="fp-acc-right">
        <span id="tc-${t.id}">💬 —</span>
        <span class="fp-acc-chevron">▼</span>
      </div>
    </div>
    <div class="fp-acc-body" id="fpab-${t.id}"></div>
  `;

  _fpLoadCommentCount(t.id, wrap.querySelector(`#tc-${t.id}`));
  return wrap;
}

/* ── Accordion toggle ── */
window.fpAccToggle = async function(threadId) {
  const wrap   = document.getElementById('fpa-' + threadId);
  const isOpen = wrap && wrap.classList.contains('fp-acc-open');

  // Same card clicked while open → close it
  if (isOpen) {
    wrap.classList.remove('fp-acc-open');
    wrap.querySelector('[aria-expanded]')?.setAttribute('aria-expanded','false');
    _fpAccOpen = null;
    _fpView = 'list';
    _fpUnsubscribe();
    return;
  }

  // Close any other open accordion
  if (_fpAccOpen && _fpAccOpen !== threadId) {
    const prev = document.getElementById('fpa-' + _fpAccOpen);
    if (prev) {
      prev.classList.remove('fp-acc-open');
      prev.querySelector('[aria-expanded]')?.setAttribute('aria-expanded','false');
    }
    _fpUnsubscribe();
  }
  _fpAccOpen = null;
  _fpView = 'list';

  // Open this one
  if (!wrap) return;
  _fpAccOpen  = threadId;
  _fpThreadId = threadId;
  _fpView     = 'thread';
  wrap.classList.add('fp-acc-open');
  wrap.querySelector('[aria-expanded]') && wrap.querySelector('[aria-expanded]').setAttribute('aria-expanded','true');

  const body = document.getElementById('fpab-' + threadId);
  if (!body) return;

  // Find thread metadata for banner
  const threadMeta = _fpAllThreads.find(t => t.id === threadId) || {};

  body.innerHTML = `
    ${_fpMatchBanner(threadMeta)}
    <div id="fpPostsList"></div>
    ${_fpIsLoggedIn()
      ? `<div class="fp-form" id="fpForm" style="margin:0 14px;">${_fpFormHtml()}</div>`
      : _fpJoinCtaHtml()
    }
  `;

  // scroll the opened card into view
  setTimeout(() => wrap.scrollIntoView({ behavior:'smooth', block:'nearest' }), 60);

  await _fpLoadPosts();
  _fpSubscribeToThread(threadId);
};

/* ── Match banner (aparece al abrir un hilo) ── */
function _fpMatchBanner(thread) {
  if (!thread || !thread.id) return '';
  const pd = thread.pick_data || {};
  const home = thread.home || pd.home || '?';
  const away = thread.away || pd.away || '?';
  const pick = pd.rec || pd.pick || pd.prediction || '';
  const conf = pd.bvrText || pd.conf || '';
  const league = thread.league || '';
  const dateStr = _fpFormatDate(pd.commenceTs);

  let ts = Number(pd.commenceTs || 0);
  if (ts > 0 && ts < 1e12) ts *= 1000;
  const isPlayed = ts > 0 && ts < Date.now();
  const statusBadge = isPlayed
    ? `<span class="fp-mb-status played">⚫ Jugado</span>`
    : `<span class="fp-mb-status upcoming">🟢 Por jugarse</span>`;

  const confColors = { 'alta':'#00e676','media-alta':'#69f0ae','media':'#ffd600','baja':'#ff9100','media-baja':'#ff9100' };
  const confColor = confColors[(conf||'').toLowerCase()] || '#29b6f6';

  return `<div class="fp-match-banner">
    <div class="fp-mb-top">
      <span class="fp-mb-league">${_fpFormatLeague(league)}</span>
      ${statusBadge}
    </div>
    <div class="fp-mb-teams">
      <div class="fp-mb-team">
        ${_fpShield(home, 44)}
        <span class="fp-mb-name">${home}</span>
      </div>
      <div class="fp-mb-center">
        <span class="fp-mb-vs">VS</span>
        ${dateStr ? `<span class="fp-mb-time">${dateStr}</span>` : ''}
      </div>
      <div class="fp-mb-team">
        ${_fpShield(away, 44)}
        <span class="fp-mb-name">${away}</span>
      </div>
    </div>
    ${pick ? `<div class="fp-mb-pick-row">
      <span class="fp-mb-pick-lbl">🤖 Pronóstico IA:</span>
      <span class="fp-mb-pick-val">${pick}</span>
      ${conf ? `<span class="fp-mb-conf" style="color:${confColor}">${conf}</span>` : ''}
    </div>` : ''}
  </div>`;
}

async function _fpLoadCommentCount(threadId, el) {
  try {
    const { count } = await (typeof sbAnon !== 'undefined' ? sbAnon : sbClient)
      .from('forum_posts')
      .select('*', { count: 'exact', head: true })
      .eq('thread_id', threadId)
      .eq('is_deleted', false);
    if (el) el.textContent = `💬 ${count || 0}`;
  } catch(e) {}
}

/* ── Open thread ── */
async function _fpOpenThread(t) {
  _fpView = 'thread';
  _fpThreadId = t.id;
  _fpThreadMeta = t;
  _fpUnsubscribe();

  const body = $('fpBody');
  body.innerHTML = `
    <div class="fp-back-row">
      <button class="fp-back" onclick="fpBackToList()">← Volver</button>
      <div class="fp-thread-title">${t.home||'?'} vs ${t.away||'?'}</div>
    </div>
    <div id="fpPostsList"></div>
    ${_fpIsLoggedIn()
      ? `<div class="fp-form" id="fpForm">${_fpFormHtml()}</div>`
      : _fpJoinCtaHtml()
    }
  `;

  _fpUpdateMobileBar();
  await _fpLoadPosts();
  _fpSubscribeToThread(t.id);
}

window.fpBackToList = function() {
  if (_fpAccOpen) {
    const wrap = document.getElementById('fpa-' + _fpAccOpen);
    if (wrap) wrap.classList.remove('fp-acc-open');
    _fpAccOpen = null;
  }
  _fpView = 'list';
  _fpThreadId = null;
  _fpUnsubscribe();
  _fpRenderList();
  _fpUpdateMobileBar();
};

/* ── Load posts ── */
async function _fpLoadPosts() {
  const list = $('fpPostsList');
  if (!list) return;
  list.innerHTML = '<div class="fp-loading">⏳</div>';

  try {
    const { data: posts, error } = await (typeof sbAnon !== 'undefined' ? sbAnon : sbClient)
      .from('forum_posts')
      .select('*')
      .eq('thread_id', _fpThreadId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: true });
    if (error) throw error;

    _fpPosts = posts || [];

    // load my reactions if logged in
    if (_fpIsLoggedIn()) {
      const email = _fpMyEmail();
      const ids = _fpPosts.map(p => p.id);
      if (ids.length) {
        const { data: reacts } = await (sbClient || sbAnon)
          .from('forum_reactions')
          .select('post_id, reaction_type')
          .eq('user_email', email)
          .in('post_id', ids);
        _fpMyReacts = {};
        (reacts||[]).forEach(r => { _fpMyReacts[r.post_id] = r.reaction_type; });
      }
    }

    // render top-level posts + their replies
    const topLevel = _fpPosts.filter(p => !p.parent_id);
    const replies   = _fpPosts.filter(p =>  p.parent_id);

    list.innerHTML = '';
    if (topLevel.length === 0) {
      list.innerHTML = '<div class="fp-empty" style="padding:16px 0">Sin comentarios aún. ¡Sé el primero! 🗣️</div>';
      return;
    }

    // AI pick post first
    const aiPost = topLevel.find(p => p.is_ai_post);
    const userPosts = topLevel.filter(p => !p.is_ai_post);
    const ordered = aiPost ? [aiPost, ...userPosts] : userPosts;

    ordered.forEach(p => {
      list.appendChild(_fpPostEl(p));
      const childReplies = replies.filter(r => r.parent_id === p.id);
      if (childReplies.length) {
        const repliesWrap = el('div','fp-replies');
        childReplies.forEach(r => repliesWrap.appendChild(_fpPostEl(r, true)));
        list.appendChild(repliesWrap);
      }
    });

    // scroll to bottom
    list.scrollTop = list.scrollHeight;

  } catch(e) {
    console.error('Forum posts error', e);
    list.innerHTML = '<div class="fp-empty">⚠️ Error: ' + (e.message||'') + '</div>';
  }
}

/* ── Post element ── */
function _fpPostEl(p, isReply) {
  const isAI    = p.is_ai_post;
  const myEmail = _fpMyEmail();
  const isMe    = myEmail && p.user_email === myEmail;
  const isAdm   = _fpIsAdmin();
  const likes   = _fpCountReacts(p.id, 'like');
  const unlikes = _fpCountReacts(p.id, 'unlike');
  const myR     = _fpMyReacts[p.id];

  const wrap = el('div', 'fp-post' + (isAI ? ' fp-post-ai' : '') + (isReply ? ' fp-post-reply' : ''));

  // avatar
  const avColor  = _fAvatarColor(p.user_email || 'bot');
  const avLetter = (p.user_name || p.user_email || '?')[0].toUpperCase();
  const avHtml   = isAI
    ? `<div class="fp-avatar fp-avatar-ai">🤖</div>`
    : `<div class="fp-avatar" style="background:${avColor}">${avLetter}</div>`;

  // display name
  const nameHtml = isAI
    ? `<span class="fp-post-name ai-name">gambeta IA</span>`
    : `<span class="fp-post-name">${_fpSanitize(p.user_name || p.user_email || 'Anónimo')}</span>`;

  // content
  let contentHtml = '';
  if (isAI) {
    // Render AI post as a styled pick card using thread pick_data
    const thread = _fpAllThreads.find(t => t.id === p.thread_id) || {};
    const pd = thread.pick_data || {};
    const pick = pd.rec || pd.pick || pd.prediction || '';
    const conf = pd.bvrText || pd.conf || '';
    const confColors = { 'alta':'#00e676','media-alta':'#69f0ae','media':'#ffd600','baja':'#ff9100','media-baja':'#ff9100' };
    const confColor = confColors[(conf||'').toLowerCase()] || '#29b6f6';
    contentHtml = `
      <div class="fp-ai-pick-card">
        <div class="fp-ai-pick-rec">
          <span class="fp-ai-pick-icon">⚽</span>
          <span class="fp-ai-pick-main">${pick || 'Sin pronóstico'}</span>
        </div>
        ${conf ? `<div class="fp-ai-conf" style="color:${confColor}">Confianza: <strong>${conf}</strong></div>` : ''}
      </div>
      <div class="fp-ai-cta">¿Qué opinás del partido? ¿Y de esta apuesta?<br>Comentá la tuya 👇</div>
    `;
  } else {
    if (p.content)   contentHtml += `<div class="fp-post-text">${_fpSanitize(p.content)}</div>`;
    if (p.image_url) contentHtml += `<div class="fp-post-img"><img src="${p.image_url}" alt="img" loading="lazy" onclick="window.open('${p.image_url}','_blank')"></div>`;
    if (p.bet_data) {
      const bd = p.bet_data;
    }
  }

  // reactions / actions
  const alreadyLiked = _fpIsLoggedIn() ? (myR === 'like') : _fpHasLiked(p.id);
  const likeClass    = alreadyLiked ? ' fp-react-active fp-react-liked' : '';
  const likeHandler  = alreadyLiked ? '' : `onclick="forumReact('${p.id}','like')"`;
  const likeCursor   = alreadyLiked ? 'cursor:default;opacity:0.7;' : '';
  const actionsHtml = !isAI ? `
    <div class="fp-reactions">
      <button class="fp-react${likeClass}" ${likeHandler} style="${likeCursor}" title="${alreadyLiked ? 'Ya le diste like' : 'Me gusta'}">👍 <span id="rl-${p.id}">${likes}</span></button>
      ${_fpIsLoggedIn() && !isReply ? `<button class="fp-reply-btn" onclick="fpShowReply('${p.id}')">↩ Responder</button>` : ''}
      <button class="fp-react" onclick="fpShowEmoji('${p.id}')" title="Emoji">😊</button>
      ${isMe||isAdm ? `<button class="fp-del-btn" onclick="forumDeletePost('${p.id}')">🗑</button>` : ''}
    </div>` : `<div class="fp-reactions">
      <button class="fp-react${likeClass}" ${likeHandler} style="${likeCursor}" title="${alreadyLiked ? 'Ya le diste like' : 'Me gusta'}">👍 <span id="rl-${p.id}">${likes}</span></button>
    </div>`;

  wrap.innerHTML = `
    ${avHtml}
    <div class="fp-post-body">
      <div class="fp-post-meta">
        ${nameHtml}
        <span class="fp-post-time">${_fTimeAgo(p.created_at)}</span>
      </div>
      ${contentHtml}
      ${actionsHtml}
      <div id="rf-${p.id}" style="display:none"></div>
    </div>
  `;
  return wrap;
}

function _fpCountReacts(postId, type) {
  // We'll count from _fpPosts reactions — but reactions are in a separate table.
  // We'll update counts when we have the data; default 0.
  // Actual counts are fetched via forumReact's realtime update.
  return 0;
}

/* ── Reply form ── */
window.fpShowReply = function(parentId) {
  // toggle
  const rf = $('rf-' + parentId);
  if (!rf) return;
  if (rf.style.display === 'block') { rf.style.display = 'none'; return; }
  rf.innerHTML = `
    <div style="display:flex;gap:6px;margin-top:8px">
      <textarea class="fp-input" placeholder="Responder..." rows="2" id="rfi-${parentId}" style="resize:none"></textarea>
      <button class="fp-send-btn" onclick="forumSubmitPost(null,'${parentId}')">➤</button>
    </div>
  `;
  rf.style.display = 'block';
  const ta = $('rfi-' + parentId);
  if (ta) ta.focus();
};

/* ── Emoji picker ── */
window.fpShowEmoji = function(postId) {
  const picker = $('fpEmojiPicker');
  if (!picker) return;
  const grid = $('fpEmojiGrid');
  grid.innerHTML = EMOJIS.map(e =>
    `<button class="fp-emoji-btn" onclick="fpInsertEmoji('${postId}','${e}')">${e}</button>`
  ).join('');
  _fpEmojiTarget = postId;
  _fpEmojiOpen = true;

  // position near post
  picker.style.display = 'block';
  const btn = document.querySelector(`[onclick="fpShowEmoji('${postId}')"]`);
  if (btn) {
    const r = btn.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.bottom = (window.innerHeight - r.top + 4) + 'px';
    picker.style.right = (window.innerWidth - r.right) + 'px';
    picker.style.zIndex = '11000';
  }

  // close on outside click
  setTimeout(() => {
    document.addEventListener('click', _fpCloseEmojiOutside, { once: true });
  }, 0);
};

function _fpCloseEmojiOutside(e) {
  const picker = $('fpEmojiPicker');
  if (picker && !picker.contains(e.target)) {
    picker.style.display = 'none';
    _fpEmojiOpen = false;
  }
}

window.fpInsertEmoji = function(postId, emoji) {
  // Insert emoji into the relevant textarea
  const mainTa  = $('fpTextarea');
  const replyTa = $('rfi-' + postId);
  const ta = replyTa || mainTa;
  if (ta) {
    const start = ta.selectionStart, end = ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + emoji + ta.value.slice(end);
    ta.focus();
  }
  const picker = $('fpEmojiPicker');
  if (picker) picker.style.display = 'none';
  _fpEmojiOpen = false;
};

/* ── Join / Register CTA (para no logueados) ── */
function _fpJoinCtaHtml() {
  return `
    <div class="fp-join-cta">
      <span class="fp-join-cta-ico">⚡️</span>
      <div class="fp-join-cta-title">¡Sumate al debate!</div>
      <div class="fp-join-cta-sub">
        Registrate gratis y comentá tus picks,<br>
        compartí apuestas y debatí con la comunidad.
      </div>
      <div class="fp-join-cta-btns">
        <button class="fp-join-btn-primary" onclick="openAuth()">✦ Registro Gratis</button>
        <button class="fp-join-btn-sec" onclick="openAuth()">Ya tengo cuenta</button>
      </div>
    </div>
  `;
}

/* ── Form HTML ── */
function _fpFormHtml() {
  return `
    <div class="fp-form-inner">
      <textarea class="fp-input" id="fpTextarea" placeholder="Comentar... (podés usar emojis 🎯)" rows="2"></textarea>
      <div class="fp-form-actions">
        <button class="fp-act-btn" onclick="forumUploadImage()" title="Adjuntar imagen">📷</button>
        <button class="fp-act-btn" onclick="forumShareBet()" title="Compartir pronóstico ">🪙</button>
        <button class="fp-act-btn" onclick="fpShowEmoji(null)" title="Emojis">😊</button>
        <button class="fp-send-btn" style="margin-left:auto" onclick="forumSubmitPost()">Enviar ➤</button>
      </div>
      <input type="file" id="fpImgInput" accept="image/*" style="display:none" onchange="fpHandleImgUpload(event)">
      <div id="fpImgPreview" style="display:none;margin-top:6px">
        <img loading="lazy" decoding="async" id="fpImgPreviewImg" style="max-height:80px;border-radius:8px">
        <button onclick="fpClearImg()" style="background:rgba(255,50,50,0.15);border:none;color:#ff5555;cursor:pointer;border-radius:50%;width:22px;height:22px;margin-left:4px">✕</button>
      </div>
    </div>
  `;
}

/* ── Submit post ── */
window.forumSubmitPost = async function(threadId, parentId) {
  if (!_fpIsLoggedIn()) { alert('Iniciá sesión para comentar'); return; }
  const tid = threadId || _fpThreadId;
  if (!tid) return;

  const mainTa  = $('fpTextarea');
  const replyTa = parentId ? $('rfi-' + parentId) : null;
  const ta = replyTa || mainTa;
  const content = ta ? ta.value.trim() : '';
  const imageUrl = window._fpPendingImgUrl || null;

  if (!content && !imageUrl) return;

  const user = window._currentUser || {};
  const post = {
    thread_id:  tid,
    user_email: user.email || 'anon',
    user_name:  user.name  || user.email || 'Anónimo',
    content:    content,
    image_url:  imageUrl || null,
    bet_data:   window._fpPendingBet || null,
    parent_id:  parentId || null,
    is_ai_post: false,
    is_deleted: false
  };

  try {
    const { error } = await sbClient
      .from('forum_posts')
      .insert([post]);
    if (error) throw error;

    if (ta) ta.value = '';
    window._fpPendingImgUrl = null;
    window._fpPendingBet    = null;
    fpClearImg();

    // If no realtime, reload manually
    if (!_fpRealtime) await _fpLoadPosts();

  } catch(e) {
    console.error('Forum submit error', e);
    alert('Error al enviar: ' + (e.message||''));
  }
};

/* ── Like anónimo — helpers localStorage ── */
function _fpGetAnonId() {
  try {
    let id = localStorage.getItem('fp_anon_id');
    if (!id) {
      id = 'anon_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
      localStorage.setItem('fp_anon_id', id);
    }
    return id;
  } catch(e) { return 'anon_' + Date.now(); }
}
function _fpHasLiked(postId) {
  try { return !!(JSON.parse(localStorage.getItem('fp_liked') || '{}')[postId]); } catch(e) { return false; }
}
function _fpMarkLiked(postId) {
  try {
    const liked = JSON.parse(localStorage.getItem('fp_liked') || '{}');
    liked[postId] = true;
    localStorage.setItem('fp_liked', JSON.stringify(liked));
  } catch(e) {}
}

/* ── React (solo like, sin toggle, sin login requerido) ── */
window.forumReact = async function(postId, type) {
  if (type !== 'like') return; // dislike deshabilitado

  // Verificar si ya dio like
  const alreadyLiked = _fpIsLoggedIn() ? (_fpMyReacts[postId] === 'like') : _fpHasLiked(postId);
  if (alreadyLiked) return;

  const email = _fpIsLoggedIn() ? _fpMyEmail() : (_fpGetAnonId() + '@fp.local');
  const db    = (typeof sbAnon !== 'undefined') ? sbAnon : sbClient;

  try {
    await db.from('forum_reactions')
      .upsert({ post_id: postId, user_email: email, reaction_type: 'like' },
               { onConflict: 'post_id,user_email' });

    if (_fpIsLoggedIn()) {
      _fpMyReacts[postId] = 'like';
    } else {
      _fpMarkLiked(postId);
    }
    await _fpRefreshReactCounts(postId);

    // Bloquear el botón visualmente (sin re-render completo)
    document.querySelectorAll(`[onclick="forumReact('${postId}','like')"]`).forEach(b => {
      b.classList.add('fp-react-active', 'fp-react-liked');
      b.removeAttribute('onclick');
      b.style.cursor = 'default';
      b.style.opacity = '0.7';
      b.title = 'Ya le diste like';
    });
  } catch(e) {
    console.error('Like error', e);
  }
};

async function _fpRefreshReactCounts(postId) {
  const { data } = await (typeof sbAnon !== 'undefined' ? sbAnon : sbClient)
    .from('forum_reactions')
    .select('reaction_type')
    .eq('post_id', postId);
  const likes = (data||[]).filter(r => r.reaction_type === 'like').length;
  const rl = $('rl-' + postId); if (rl) rl.textContent = likes;
}

/* ── Delete post ── */
window.forumDeletePost = async function(postId) {
  if (!confirm('¿Eliminar este comentario?')) return;
  try {
    await sbClient.from('forum_posts')
      .update({ is_deleted: true })
      .eq('id', postId);
    if (!_fpRealtime) await _fpLoadPosts();
  } catch(e) {
    alert('Error: ' + (e.message||''));
  }
};

/* ── Image upload ── */
window.forumUploadImage = function() {
  const inp = $('fpImgInput');
  if (inp) inp.click();
};

window.fpHandleImgUpload = async function(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { alert('Imagen demasiado grande (máx 5MB)'); return; }

  // preview
  const reader = new FileReader();
  reader.onload = e => {
    const prev = $('fpImgPreview');
    const img  = $('fpImgPreviewImg');
    if (prev && img) { img.src = e.target.result; prev.style.display = 'flex'; }
  };
  reader.readAsDataURL(file);

  // upload to supabase storage
  try {
    const ext  = file.name.split('.').pop();
    const path = `forum/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const { data, error } = await sbClient.storage
      .from('forum-images')
      .upload(path, file, { upsert: false, contentType: file.type });
    if (error) throw error;
    const { data: pub } = sbClient.storage.from('forum-images').getPublicUrl(path);
    window._fpPendingImgUrl = pub.publicUrl;
  } catch(e) {
    console.error('Image upload error', e);
    alert('Error subiendo imagen: ' + (e.message||''));
  }
};

window.fpClearImg = function() {
  window._fpPendingImgUrl = null;
  const prev = $('fpImgPreview');
  if (prev) prev.style.display = 'none';
  const inp = $('fpImgInput');
  if (inp) inp.value = '';
};

/* ── Share bet ── */
window.forumShareBet = function() {
  if (!_fpIsLoggedIn()) { alert('Iniciá sesión para compartir pronósticos'); return; }
  // Look for user's last bet in localStorage
  const histKey = 'acoin_history';
  let hist = [];
  try { hist = JSON.parse(localStorage.getItem(histKey)||'[]'); } catch(e) {}
  const lastBet = hist.find(h => h.home && h.away && h.pick);
  if (!lastBet) { alert('No encontramos pronósticos recientes para compartir.'); return; }
  window._fpPendingBet = lastBet;
  const ta = $('fpTextarea');
  if (ta) ta.value = (ta.value ? ta.value + ' ' : '') +
    `🪙 Aposté ${lastBet.betAmount||'?'}  en "${lastBet.pick||'?'}"`;
};

/* ── Realtime subscription ── */
function _fpSubscribeToThread(threadId) {
  if (!sbClient || !sbClient.channel) return;
  _fpRealtime = sbClient
    .channel('forum-posts-' + threadId)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'forum_posts',
      filter: `thread_id=eq.${threadId}`
    }, () => {
      if (_fpView === 'thread' && _fpThreadId === threadId) _fpLoadPosts();
    })
    .subscribe();
}

function _fpUnsubscribe() {
  if (_fpRealtime && sbClient && sbClient.removeChannel) {
    sbClient.removeChannel(_fpRealtime);
    _fpRealtime = null;
  }
}

/* ── Helper: compute thread id from home/away (matches existing pattern: lowercased, no spaces, _vs_) ── */
function _fpThreadIdFor(home, away) {
  const norm = s => String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
    .replace(/[^a-z0-9]/g, '');                          // alphanumeric only
  return `${norm(home)}_vs_${norm(away)}`;
}

/* ── Auto-create thread for a pick (called by pick renderer) ── */
window.forumEnsureThread = async function(pick) {
  // pick = { id?, home, away, league, match_date, prediction/pick, confidence/conf, ... }
  if (!pick || !pick.home || !pick.away) return;
  const tid = String(pick.id || _fpThreadIdFor(pick.home, pick.away));
  try {
    const sb = typeof sbAnon !== 'undefined' ? sbAnon : sbClient;
    const { data: existing } = await sb
      .from('forum_threads')
      .select('id')
      .eq('id', tid)
      .maybeSingle();
    if (existing) return;

    // create thread + AI post
    const { error: insErr } = await sbClient.from('forum_threads').insert([{
      id:         tid,
      pick_data:  pick,
      league:     pick.league || '',
      home:       pick.home   || '',
      away:       pick.away   || '',
      match_date: pick.match_date || pick.date || ''
    }]);
    if (insErr) {
      console.warn('[forum] No se pudo crear thread (RLS?):', insErr.message);
      return;
    }

    const rec  = pick.rec || pick.prediction || pick.pick || 'Sin pick';
    const conf = pick.bvrText || pick.confidence || pick.conf || '';
    const aiContent = [
      `🤖 Pronóstico: ${rec}`,
      conf ? `Confianza: ${conf}` : '',
      '',
      '¿Qué opinás del partido? ¿Y de esta apuesta? Comentá la tuya 👇'
    ].filter((x, i) => i >= 2 || x !== '').join('\n');

    await sbClient.from('forum_posts').insert([{
      thread_id:  String(pick.id),
      user_email: 'ia@gambeta.ai',
      user_name:  'gambeta IA',
      content:    aiContent,
      is_ai_post: true,
      is_deleted: false
    }]);
  } catch(e) {
    console.warn('forumEnsureThread error', e.message);
  }
};

/* ── Badge: unread notification system ── */

function _fpShowBadge(count) {
  const badge = $('forumBadge');
  if (!badge) return;
  if (count > 0 && !_fpOpen) {
    const label = count > 99 ? '99+' : String(count);
    // Replay pop animation on each increment
    badge.style.animation = 'none';
    badge.offsetHeight; // reflow
    badge.style.animation = '';
    badge.textContent    = label;
    badge.style.display  = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function _fpSaveLastSeen(total) {
  try { localStorage.setItem('fp_last_seen', String(total)); } catch(e) {}
}
function _fpGetLastSeen() {
  try { return parseInt(localStorage.getItem('fp_last_seen') || '0', 10); } catch(e) { return 0; }
}

async function _fpBadgeInit() {
  try {
    const db = window.sbAnon || window.sbClient;
    if (!db) return;
    const { count } = await db
      .from('forum_posts')
      .select('id', { count: 'exact', head: true });
    const total = count || 0;
    const seen  = _fpGetLastSeen();
    _fpUnread   = Math.max(0, total - seen);
    _fpShowBadge(_fpUnread);
    _fpGlobalSubscribe();
  } catch(e) {
    console.warn('fpBadgeInit error', e);
  }
}

async function _fpFetchAndSaveLastSeen() {
  try {
    const db = window.sbAnon || window.sbClient;
    if (!db) return;
    const { count } = await db
      .from('forum_posts')
      .select('id', { count: 'exact', head: true });
    _fpSaveLastSeen(count || 0);
  } catch(e) {}
}

function _fpGlobalSubscribe() {
  const db = window.sbClient || window.sbAnon;
  if (!db || !db.channel) return;
  if (_fpGlobalRt) { try { db.removeChannel(_fpGlobalRt); } catch(e){} }
  _fpGlobalRt = db
    .channel('fp-global-badge')
    .on('postgres_changes', {
      event:  'INSERT',
      schema: 'public',
      table:  'forum_posts'
    }, () => {
      if (!_fpOpen) {
        _fpUnread++;
        _fpShowBadge(_fpUnread);
      }
    })
    .subscribe();
}

/* ── Sanitize (basic XSS prevention) ── */
function _fpSanitize(str) {
  return (str||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/\n/g,'<br>');
}

/* ── Auth helpers ── */
function _fpIsLoggedIn() {
  return !!(window._currentUser && window._currentUser.email);
}
function _fpIsAdmin() {
  return typeof isAdminUser === 'function' ? isAdminUser() : false;
}
function _fpMyEmail() {
  return (window._currentUser && window._currentUser.email) || '';
}

/* ── Emoji picker null-target fallback ── */
const _origFpShowEmoji = window.fpShowEmoji;
window.fpShowEmoji = function(postId) {
  const target = postId || 'main';
  const picker = $('fpEmojiPicker');
  if (!picker) return;
  const grid = $('fpEmojiGrid');
  grid.innerHTML = EMOJIS.map(e =>
    `<button class="fp-emoji-btn" onclick="fpInsertEmoji('${target}','${e}')">${e}</button>`
  ).join('');

  picker.style.display = 'block';
  picker.style.position = 'fixed';
  picker.style.bottom   = '220px';
  picker.style.right    = '28px';
  picker.style.zIndex   = '11000';

  setTimeout(() => {
    document.addEventListener('click', _fpCloseEmojiOutside, { once: true });
  }, 0);
};

/* ── Boot badge system after short delay (ensures sbAnon ready) ── */
setTimeout(_fpBadgeInit, 1200);

})(); // end IIFE
