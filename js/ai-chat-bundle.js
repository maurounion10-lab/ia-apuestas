// ═══ AI CHAT — extraído del HTML inline a archivo defer (#607) ═══

/* ═══════════════════════════════════════════════
   AI CHAT — gambeta.ai
   Worker: apuestas-ia-chat.mauro-union10.workers.dev
═══════════════════════════════════════════════ */
const AI_WORKER = 'https://apuestas-ia-chat.mauro-union10.workers.dev';

// ── Canales y tipsters de PronosticosLATAM ──
// Se inyectan en cada consulta para que la IA los recomiende cuando sea relevante
const LATAM_CHANNELS = {
  nota: "Cuando el usuario pregunte por tipsters, canales, picks gratis, apuestas gratis, dónde seguir pronósticos, grupos de Telegram, o similar, recomienda los siguientes canales y servicios de PronosticosLATAM:",
  gratis: [
    { nombre: "Canal Principal Pronósticos LATAM", url: "https://t.me/GrupoLatam" },
    { nombre: "Canal Apuestas Tenis", url: "https://t.me/TenisLATAM" },
    { nombre: "Canal Apuestas Fútbol", url: "https://t.me/elseleccionado" },
    { nombre: "Canal Apuestas Rugby", url: "https://t.me/apuestasrugby" },
    { nombre: "Canal PackBall Premium Gratis", url: "https://t.me/PackballGRATIS" },
    { nombre: "Canal Destraba-Bonos", url: "https://t.me/canaldestrababonos" },
    { nombre: "Canal Club de Ganadores", url: "https://t.me/clubdewinners" },
    { nombre: "Tipster Gastón LATAM", url: "https://t.me/gastonlatam" },
    { nombre: "Tipster Tomi LATAM (VIP Gratis)", url: "https://t.me/Tomiilatam" },
    { nombre: "Twitter/X Fútbol LATAM", url: "https://x.com/Grupo_LATAM" },
    { nombre: "Twitter/X Tenis LATAM", url: "https://x.com/TenisLATAM_" },
    { nombre: "Instagram (sorteos, apuestas, reels)", url: "https://www.instagram.com/pronosticos.latam" },
    { nombre: "TikTok Rugby LATAM", url: "https://www.tiktok.com/@rugbylatam" },
    { nombre: "Soporte y accesos", url: "https://t.me/Atencionvipproarg" },
    { nombre: "Chat Apuestas Rugby", url: "https://t.me/+clg2aAmJFn5lYzRh" },
  ],
  vip_pagos: [
    { nombre: "VIP de Temporada de Mauro", url: "https://t.me/atencionvipproarg" },
    { nombre: "Canal Progresión $1.000 → $50.000", url: "https://t.me/atencionvipproarg" },
    { nombre: "Canal Progresión $5.000 → $250.000", url: "https://t.me/atencionvipproarg" },
    { nombre: "VIP Fútbol + Lives (Ruso LATAM)", url: "https://t.me/rusolatam" },
    { nombre: "VIP USA (Benja LATAM)", url: "https://t.me/BenjaLatam" },
    { nombre: "Bot Alerta Equipos Ganadores", url: "https://t.me/Atencionvipproarg" },
  ]
};
let aiHistory   = [];
let aiOpen      = false;
let aiWorking   = false;
let aiGreeted   = false;
let _aiPromoReady = false; // true solo en la 1ra respuesta del bot tras el 1er msg del usuario
let aiImageB64  = null;   // base64 de la imagen adjunta (sin prefijo data:...)
let aiImageMime = null;   // mime type de la imagen
let _inactivityTimer = null;
let _inactivityFired = false; // se dispara una sola vez por sesión

function _resetInactivityTimer() {
  clearTimeout(_inactivityTimer);
  if (_inactivityFired) return;
  _inactivityTimer = setTimeout(_sendInactivityPromo, 420_000); // 7 minutos
}

function _sendInactivityPromo() {
  if (_inactivityFired) return;
  const wrap = document.getElementById('aiMessages');
  if (!wrap) return;
  _inactivityFired = true;

  const ctaHtml = getDailyPromoCta();
  if (!ctaHtml) return;

  const div = document.createElement('div');
  div.className = 'ai-msg bot';
  div.innerHTML = `¡Ey! 👋 Antes de irte — te dejo la oferta del día por si te sirve para tu próxima apuesta.${ctaHtml}`;
  const t = document.createElement('div');
  t.className = 'ai-msg-time';
  t.textContent = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  div.appendChild(t);
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
}

function aiToggleChat() {
  const box = document.getElementById('aiChatBox');
  if (aiOpen) {
    // Cerrar: animación de minimizar hacia el globo
    aiOpen = false;
    box.classList.add('minimizing');
    setTimeout(() => {
      box.classList.remove('open', 'minimizing', 'active');
    }, 260);
  } else {
    // Abrir: quitar cualquier estado de cierre y animar apertura
    aiOpen = true;
    box.classList.remove('minimizing');
    // Forzar reflow para que la transición de apertura funcione limpia
    void box.offsetWidth;
    box.classList.add('open');
    // puntito rojo siempre visible — no se oculta al abrir
    if (!aiGreeted) aiGreet();
    setTimeout(() => document.getElementById('aiInput').focus(), 300);
  }
}

function aiGreet() {
  aiGreeted = true;
  const lang = (typeof currentLang !== 'undefined' ? currentLang : 'es');
  const greetings = {
    es: `👋 ¡Hola! Soy la <strong>IA de Pronósticos Deportivos</strong> de gambeta.ai. Puedo darte pronósticos, análisis estadísticos y análisis de valor en cuotas.\n¿En qué te puedo ayudar?`,
    en: `👋 Hi! I'm the <strong>First AI for Sports Betting</strong>. I can give you predictions, statistical analysis and value betting tips.\nHow can I help you?`,
    pt: `👋 Olá! Sou a <strong>IA de Prognósticos Esportivos</strong> da gambeta.ai. Posso fornecer prognósticos, análises estatísticas e análise de valor nas odds.\nComo posso ajudar você?`,
  };
  aiAddMsg('bot', greetings[lang] || greetings['es']);
}

function aiParseMarkdown(text) {
  return text
    // bloques ```...``` (multilinea) — ANTES del inline para no conflictuar
    .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) =>
      `<pre style="background:rgba(0,200,83,0.08);border:1px solid rgba(0,200,83,0.2);border-radius:8px;padding:10px 14px;margin:8px 0;font-family:monospace;font-size:0.82rem;line-height:1.5;white-space:pre-wrap;overflow-x:auto;color:#e0ffe8">${code.trim()}</pre>`)
    // ### h3
    .replace(/^###\s+(.+)$/gm, '<div style="font-size:0.82rem;font-weight:700;color:#00c853;margin:6px 0 2px">$1</div>')
    // ## h2
    .replace(/^##\s+(.+)$/gm, '<div style="font-size:0.86rem;font-weight:700;color:#00e564;margin:8px 0 3px">$1</div>')
    // # h1
    .replace(/^#\s+(.+)$/gm, '<div style="font-size:0.9rem;font-weight:800;color:#00e564;margin:8px 0 4px">$1</div>')
    // **negrita**
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    // *cursiva*
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    // `código inline`
    .replace(/`(.*?)`/g, '<code style="background:rgba(0,200,83,0.15);padding:1px 5px;border-radius:4px;font-family:monospace;font-size:0.85em">$1</code>')
    // listas con - o •
    .replace(/^[\-•]\s+(.+)$/gm, '<li>$1</li>')
    // saltos de línea
    .replace(/\n/g, '<br>')
    // envolver <li> sueltos en <ul>
    .replace(/(<li>.*?<\/li>)(<br>)*/gs, (m) => {
      const items = m.replace(/<br>/g, '');
      return `<ul style="margin:6px 0 6px 16px;padding:0;list-style:disc">${items}</ul>`;
    });
}

function aiAddMsg(role, text, withTime = true) {
  const wrap = document.getElementById('aiMessages');
  const div  = document.createElement('div');
  div.className = `ai-msg ${role}`;
  // Para respuestas del bot, agregar CTA de promo diaria solo en la 1ra respuesta real
  let ctaHtml = '';
  if (role === 'bot' && withTime && _aiPromoReady) {
    ctaHtml = getDailyPromoCta();
    _aiPromoReady = false; // mostrar solo una vez por conversación
  }
  div.innerHTML = aiParseMarkdown(text) + ctaHtml;
  if (withTime) {
    const t = document.createElement('div');
    t.className = 'ai-msg-time';
    t.textContent = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    div.appendChild(t);
  }
  wrap.appendChild(div);
  if (role === 'bot') {
    // Scroll para mostrar la pregunta del usuario + la respuesta juntas
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const userMsgs = wrap.querySelectorAll('.ai-msg.user');
        const lastQ = userMsgs.length ? userMsgs[userMsgs.length - 1] : div;
        // getBoundingClientRect es confiable sin importar el offsetParent
        const wrapRect = wrap.getBoundingClientRect();
        const msgRect  = lastQ.getBoundingClientRect();
        wrap.scrollTop += (msgRect.top - wrapRect.top) - 8;
      });
    });
  } else {
    wrap.scrollTop = wrap.scrollHeight;
  }
  return div;
}

// CTA diario: qué casa bonifica hoy y link de registro
function getDailyPromoCta() {
  const day = new Date().getDay(); // 0=Dom…6=Sáb
  const promos = {
    0: { texto: '🎁 Mañana <strong>Melbet duplica tu depósito</strong> — aprovechalo antes de las 23:59.',  casa: 'Melbet',      link: 'https://refpa3665.com/L?tag=d_5377076m_2170c_&site=5377076&ad=2170&r=registration' },
    1: { texto: '🎁 Hoy <strong>Melbet duplica tu depósito</strong> — el bono se activa solo los lunes.',   casa: 'Melbet',      link: 'https://refpa3665.com/L?tag=d_5377076m_2170c_&site=5377076&ad=2170&r=registration' },
    2: { texto: '🎁 Hoy <strong>DBbet duplica tu primer depósito</strong> — bonos de bienvenida activos.', casa: 'DBbet',  link: 'https://refpa96317.com/L?tag=d_5777587m_11213c_&site=5777587&ad=11213&utm_source=home_dbbet&utm_medium=site', link2: 'https://refpa96317.com/L?tag=d_5777587m_11213c_&site=5777587&ad=11213&utm_source=home_dbbet&utm_medium=site&r=email', casa2: 'DBbet' },
    3: { texto: '🎁 Mañana <strong>BetWinner duplica tu depósito</strong> — preparate hoy para el bono del jueves.', casa: 'BetWinner', link: 'https://bwredir.com/2J04?p=%2Fregistration%2F&s1=PronosticosLATAM' },
    4: { texto: '🎁 Hoy <strong>BetWinner duplica tu depósito</strong> — el bono del jueves está activo ahora.', casa: 'BetWinner',   link: 'https://bwredir.com/2J04?p=%2Fregistration%2F&s1=PronosticosLATAM' },
    5: { texto: '🎁 Mañana <strong>Megapari duplica tu depósito</strong> — depositá hoy para tenerlo listo.',  casa: 'Megapari',   link: 'https://proarg.megapari-003572.in/' },
    6: { texto: '🎁 Hoy <strong>Megapari duplica tu depósito</strong> — el bono de sábado está activo.',      casa: 'Megapari',   link: 'https://proarg.megapari-003572.in/' },
  };
  const BOOK_FAVICONS = {
    'Melbet':      'https://www.google.com/s2/favicons?domain=melbet.com&sz=64',
    'BetWinner':   'https://www.google.com/s2/favicons?domain=betwinner.com&sz=64',
    'Megapari':    'https://www.google.com/s2/favicons?domain=megapari.com&sz=64',
    'DBbet':       'https://www.google.com/s2/favicons?domain=dbbetbet.com&sz=64',
    'DBbet': 'https://www.google.com/s2/favicons?domain=dbbetbet.com&sz=64',
  };
  const faviconImg = (nombre) => {
    const src = BOOK_FAVICONS[nombre];
    return src ? `<img loading="lazy" decoding="async" src="${src}" style="width:16px;height:16px;border-radius:3px;vertical-align:middle;margin-right:5px;background:#fff;padding:1px" onerror="this.style.display='none'">` : '';
  };
  const p = promos[day] || promos[1];
  const btns = p.link2
    ? `<a href="${p.link}" target="_blank" rel="noopener"
         style="flex-shrink:0;display:inline-flex;align-items:center;background:var(--verde);color:#000;font-size:0.75rem;font-weight:800;padding:6px 14px;border-radius:20px;text-decoration:none;white-space:nowrap">
         ${faviconImg(p.casa)}${p.casa} →
       </a>
       <a href="${p.link2}" target="_blank" rel="noopener"
         style="flex-shrink:0;display:inline-flex;align-items:center;background:rgba(0,200,83,0.2);color:var(--verde);border:1px solid var(--verde);font-size:0.75rem;font-weight:800;padding:6px 14px;border-radius:20px;text-decoration:none;white-space:nowrap">
         ${faviconImg(p.casa2)}${p.casa2} →
       </a>`
    : `<a href="${p.link}" target="_blank" rel="noopener"
         style="flex-shrink:0;display:inline-flex;align-items:center;background:var(--verde);color:#000;font-size:0.75rem;font-weight:800;padding:6px 14px;border-radius:20px;text-decoration:none;white-space:nowrap">
         🐝 Registrarse →
       </a>`;
  return `<div style="margin-top:12px;padding:10px 13px;background:rgba(0,200,83,0.08);border:1px solid rgba(0,200,83,0.25);border-radius:10px;font-size:0.8rem;line-height:1.5;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
    <span style="color:#ccc">${p.texto}</span>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${btns}</div>
  </div>`;
}

// Detecta si la respuesta del bot menciona cuotas/odds para mostrar ad Melbet
function aiReplyMentionsOdds(text) {
  const lower = text.toLowerCase();
  const keywords = [
    'cuota','cuotas','odds','odd ','apuesta','apuestas','apostar',
    'bet ','betting','stake','retorno','pago','ganancia',
    'local gana','visitante gana','empate','1x2',
    'over','under','handicap','asian','spread'
  ];
  // También detecta números con punto decimal tipo "1.85" o "2.10" (formato de cuotas)
  const hasOddsNumber = /\b[1-9]\d?\.\d{1,2}\b/.test(text);
  return hasOddsNumber || keywords.some(k => lower.includes(k));
}

// Detecta si la respuesta menciona tipsters/canales para mostrar botones
function aiReplyMentionsChannels(text) {
  const lower = text.toLowerCase();
  return /tipster|canal|telegram|pick.{0,6}grati|apuesta.{0,6}grati|grupo|comunidad|latam|vip|@\w/.test(lower);
}

// Genera tarjeta de canales para el chat (estilo Melbet ad)
function aiChannelsCard(msgEl) {
  const tg = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="white" d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L8.32 13.617l-2.96-.924c-.643-.204-.657-.643.136-.953l11.57-4.461c.537-.194 1.006.131.828.942z"/></svg>';
  const card = document.createElement('div');
  card.style.cssText = 'margin-top:10px;background:linear-gradient(135deg,rgba(34,158,217,0.12),rgba(0,200,83,0.06));border:1px solid rgba(34,158,217,0.35);border-radius:12px;padding:10px 12px;';
  card.innerHTML = `
    <div style="font-size:0.68rem;font-weight:800;color:#229ED9;letter-spacing:0.6px;margin-bottom:8px">📲 CANALES PRONOSTICOSLATAM — GRATIS</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
      ${[
        ['🌐 Principal',   'https://t.me/GrupoLatam'],
        ['⚽ Fútbol',       'https://t.me/elseleccionado'],
        ['🎾 Tenis',        'https://t.me/TenisLATAM'],
        ['🏉 Rugby',        'https://t.me/apuestasrugby'],
        ['🎁 Destraba',     'https://t.me/canaldestrababonos'],
        ['🏆 Club Winners', 'https://t.me/clubdewinners'],
        ['📦 PackBall',     'https://t.me/PackballGRATIS'],
      ].map(([label, url]) =>
        `<a href="${url}" target="_blank" rel="noopener"
           style="display:inline-flex;align-items:center;gap:5px;background:rgba(34,158,217,0.15);border:1px solid rgba(34,158,217,0.3);
                  color:#fff;font-size:0.65rem;font-weight:700;padding:4px 10px;border-radius:20px;text-decoration:none;white-space:nowrap">${label}</a>`
      ).join('')}
    </div>
    <div style="font-size:0.68rem;font-weight:800;color:#ffd600;letter-spacing:0.6px;margin-bottom:6px">👑 VIP</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      ${[
        ['👑 VIP Mauro',      'https://t.me/atencionvipproarg'],
        ['⚽ Fútbol+Lives',   'https://t.me/rusolatam'],
        ['🛟 Soporte/Info',   'https://t.me/Atencionvipproarg'],
      ].map(([label, url]) =>
        `<a href="${url}" target="_blank" rel="noopener"
           style="display:inline-flex;align-items:center;gap:5px;background:rgba(255,214,0,0.08);border:1px solid rgba(255,214,0,0.25);
                  color:#ffd600;font-size:0.65rem;font-weight:700;padding:4px 10px;border-radius:20px;text-decoration:none;white-space:nowrap">${label}</a>`
      ).join('')}
    </div>`;
  msgEl.appendChild(card);
}

// Busca por defecto siempre, salvo preguntas conceptuales cortas
function aiNeedsWeb(msg) {
  const lower = msg.toLowerCase();
  const conceptOnly = [
    'qué es ','que es ','what is ','o que é ',
    'cómo se calcula','como se calcula','how to calculate',
    'explícame','explicame','explain ',
    'define ','definición','definition',
    'qué significa','que significa','what does',
  ];
  const isConcept = conceptOnly.some(c => lower.includes(c));
  if (isConcept && lower.length < 60) return false;
  return true;
}

function _aiDetectSport(msg) {
  const t = (msg || '').toLowerCase();
  if (/\b(tenis|tennis|atp|wta|wimbledon|roland.?garros|us.?open|australian.?open|djokovic|alcaraz|nadal|federer|sinner|swiatek|raqueta|set|game|match.?point)\b/.test(t)) return '🎾';
  if (/\b(nfl|american.?football|superbowl|super.?bowl|touchdown|quarterback|patriots|cowboys|chiefs|eagles|49ers|packers|ravens|broncos|chargers|raiders|bears|giants|jets|dolphins|bills|colts|titans|jaguars|texans|lions|vikings|falcons|saints|bucs|buccaneers|panthers|cardinals|seahawks|rams)\b/.test(t)) return '🏈';
  if (/\b(baseball|béisbol|beisbol|mlb|yankees|dodgers|red.?sox|cubs|mets|giants|cardinals|braves|astros|padres|phillies|mariners|rangers|orioles|tigers|twins|rays|guardians|royals|white.?sox|pirates|brewers|diamondbacks|rockies|athletics|nationals|marlins|reds|angels)\b/.test(t)) return '⚾';
  if (/\b(rugby|six.?nations|all.?blacks|springboks|wallabies|premiership.?rugby|top.?14|rugby.?world.?cup|tries|scrum|lineout)\b/.test(t)) return '🏉';
  // Default: fútbol
  return '⚽';
}

function aiShowTyping(searching = false, msg = '') {
  const wrap = document.getElementById('aiMessages');
  // Indicador de búsqueda con pelota animada según el deporte
  if (searching) {
    const ball = _aiDetectSport(msg);
    const s = document.createElement('div');
    s.id = 'aiSearching';
    s.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:0.78rem;color:rgba(165,214,167,0.75);padding:5px 2px;';
    s.innerHTML = `<span style="display:inline-block;animation:aiBounce 0.75s infinite;transform-origin:bottom center;font-size:1.05rem;line-height:1">${ball}</span><span style="letter-spacing:0.2px">Investigando mis fuentes...</span>`;
    wrap.appendChild(s);
    wrap.scrollTop = wrap.scrollHeight;
  }
  // Puntos de escritura
  const dot = document.createElement('div');
  dot.className = 'ai-typing';
  dot.id = 'aiTyping';
  dot.innerHTML = '<span></span><span></span><span></span>';
  wrap.appendChild(dot);
  wrap.scrollTop = wrap.scrollHeight;
}

function aiHideTyping() {
  document.getElementById('aiTyping')?.remove();
  document.getElementById('aiSearching')?.remove();
}

// ── Manejo de imagen ─────────────────────────────────────────────────────────
function aiHandleImage(input) {
  const file = input.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    // Separar mime y base64
    const [header, b64] = dataUrl.split(',');
    aiImageMime = header.match(/:(.*?);/)[1];
    aiImageB64  = b64;
    // Mostrar preview
    document.getElementById('aiImgThumb').src = dataUrl;
    document.getElementById('aiImgPreview').style.display = 'block';
    // Actualizar placeholder
    document.getElementById('aiInput').placeholder = 'Describí qué querés saber de esta imagen...';
  };
  reader.readAsDataURL(file);
  input.value = ''; // reset para poder subir la misma imagen otra vez
}

function aiClearImage() {
  aiImageB64  = null;
  aiImageMime = null;
  document.getElementById('aiImgPreview').style.display = 'none';
  document.getElementById('aiImgThumb').src = '';
  document.getElementById('aiInput').placeholder = 'Preguntá a la IA...';
}

function _showPromoDirecta() {
  const wrap = document.getElementById('aiMessages');
  if (!wrap) return;

  const day = new Date().getDay();
  const dailyPromo = {
    0: '🔴 <strong>DBbet</strong>, nuestro Main Sponsor, te da el <strong>100% de bono en tu primer depósito</strong> — registrate hoy y empezá con el doble. Gracias a ellos gambeta.ai es gratis.',
    1: '💎 HOY <strong>DBbet duplica tu primer depósito al 100%</strong> — depositás $50 y apostás con $100. Activalo en "Mis Bonos" antes de apostar. Son nuestros sponsors, apoyalos.',
    2: '🔴 <strong>DBbet</strong> te está esperando: <strong>100% de bono en tu primer depósito</strong>, plataforma moderna y cuotas competitivas. Registrate ahora y bancarlos — hacen posible este proyecto.',
    3: '🔴 ¿Todavía no te registraste en <strong>DBbet</strong>? Es nuestro Main Sponsor: te dan el <strong>doble de tu primer depósito</strong> y vos bancás que gambeta.ai siga siendo gratis.',
    4: '🔴 <strong>DBbet</strong> — nuestro sponsor — duplica tu primer depósito. <strong>Creá tu cuenta hoy</strong> y apostá con más plata. Sin DBbet no hay gambeta.ai.',
    5: '💎 Finde de fútbol y <strong>DBbet con el 100% de bono activo</strong> — la combinación perfecta. Registrate, depositá y doblá tu saldo antes de los partidos de hoy.',
    6: '💎 Último día del finde: <strong>DBbet sigue con el bono del 100%</strong> para nuevos usuarios. Registrate ahora y apostá con el doble en los cierres de jornada.'
  };

  // DBbet hero banner
  const dbbetHero =
    `<a href="https://refpa96317.com/L?tag=d_5777587m_11213c_&site=5777587&ad=11213&utm_source=home_dbbet&utm_medium=site" target="_blank" rel="noopener" onclick="trackEvent('promo_click',{promo:'dbbet',type:'ai_promo'})" style="display:flex;align-items:center;gap:12px;padding:14px 16px;background:linear-gradient(135deg,#1a0507,#1a0408);border:1px solid rgba(220,30,46,0.5);border-radius:12px;text-decoration:none;margin-bottom:10px;position:relative;overflow:hidden">` +
    `<div style="position:absolute;inset:0;background:linear-gradient(135deg,rgba(220,30,46,0.08),transparent);pointer-events:none"></div>` +
    `<img loading="lazy" decoding="async" src="/img/casas/dbbet.svg" style="height:32px;object-fit:contain;flex-shrink:0;filter:brightness(1.1)" onerror="this.outerHTML='<span style=\\'font-weight:900;font-size:1.1rem;color:#FFD700\\'>DB<span style=\\'color:#fff\\'>bet</span></span>'">` +
    `<div style="flex:1;min-width:0">` +
    `<div style="font-size:0.85rem;font-weight:900;color:#fff;margin-bottom:2px">Main Sponsor de gambeta.ai</div>` +
    `<div style="font-size:0.7rem;color:rgba(255,255,255,0.6)">100% bono en tu primer depósito · Hacés posible que esto sea gratis</div>` +
    `</div>` +
    `<span style="background:linear-gradient(135deg,#C9A227,#F0CC5A 45%,#B8860B);color:#fff;font-size:0.68rem;font-weight:900;padding:8px 13px;border-radius:8px;white-space:nowrap;flex-shrink:0">Registrarme →</span>` +
    `</a>`;

  const otrosCasas = [
    { nombre: 'Melbet',      logo: 'https://www.google.com/s2/favicons?domain=melbet.com&sz=64',       link: 'https://refpa3665.com/L?tag=d_5377076m_2170c_&site=5377076&ad=2170&r=registration', color: '#ffa000' },
    { nombre: 'BetWinner',   logo: 'https://www.google.com/s2/favicons?domain=betwinner.com&sz=64',    link: 'https://bwredir.com/2J04?p=%2Fregistration%2F&s1=PronosticosLATAM',                 color: '#2196f3' },
    { nombre: 'Megapari',    logo: 'https://www.google.com/s2/favicons?domain=megapari.com&sz=64',     link: 'https://proarg.megapari-003572.in/',                                                color: '#9c27b0' },
    { nombre: 'DBbetbet', logo: 'https://www.google.com/s2/favicons?domain=dbbetbet.com&sz=64',  link: 'https://refpa96317.com/L?tag=d_5777587m_11213c_&site=5777587&ad=11213&utm_source=home_dbbet&utm_medium=site&r=email',   color: '#00acc1' },
  ];

  const otrosCasasHtml = otrosCasas.map(c =>
    `<a href="${c.link}" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:10px;padding:9px 12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;text-decoration:none">` +
    `<img src="${c.logo}" style="width:26px;height:26px;border-radius:6px;object-fit:contain;background:#fff;padding:2px;flex-shrink:0" onerror="this.style.display='none'">` +
    `<div style="flex:1;min-width:0"><div style="font-size:0.78rem;font-weight:700;color:#fff">${c.nombre}</div>` +
    `<div style="font-size:0.65rem;color:rgba(255,255,255,0.4)">100% bono primer depósito</div></div>` +
    `<span style="background:${c.color};color:#000;font-size:0.62rem;font-weight:800;padding:3px 8px;border-radius:5px;white-space:nowrap">Registrarme →</span></a>`
  ).join('');

  const html =
    `<div style="font-size:0.88rem;line-height:1.55;margin-bottom:12px">${dailyPromo[day]}</div>` +
    dbbetHero +
    `<div style="font-size:0.68rem;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:.7px;margin-bottom:7px;margin-top:4px">Otros sponsors</div>` +
    `<div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">${otrosCasasHtml}</div>` +
    `<div style="background:rgba(227,28,61,0.07);border:1px solid rgba(227,28,61,0.2);border-radius:10px;padding:10px 13px;font-size:0.75rem;color:rgba(255,255,255,0.7);line-height:1.55">` +
    `⚠️ <strong>Recordá:</strong> debés confirmar tu mail y número por SMS para activar el bono.<br>` +
    `🚫 No hagas más de 1 cuenta bajo la misma identidad o el mismo WIFI (IP). Está prohibido y pueden cerrarte la cuenta.</div>`;

  aiAddMsg('user', '🎁 Promo para hoy');
  document.getElementById('aiChatBox').classList.add('active');

  const div = document.createElement('div');
  div.className = 'ai-msg bot';
  div.innerHTML = html;
  const t = document.createElement('div');
  t.className = 'ai-msg-time';
  t.textContent = new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  div.appendChild(t);
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
  _resetInactivityTimer();
}

function aiSendChip(chipId) {
  let displayText, sendText;

  if (chipId === 'mejor-apuesta') {
    displayText = '⚽ Mejor apuesta hoy';
    // Build rich message using live predictions context
    const preds = window._aiPreds || [];
    if (preds.length >= 2) {
      const p1 = preds[0], p2 = preds[1];
      const fmt = p => `${p.home} vs ${p.away} — pick: ${p.rec}, confianza ${p.conf}%`;
      sendText = `⚽ Mejor apuesta hoy\n\nTengo estos picks disponibles:\n1ª opción: ${fmt(p1)}\n2ª opción: ${fmt(p2)}\n\n¿Cuál es la mejor apuesta para apostar hoy y cuál sería la segunda mejor como alternativa? Dame un análisis breve de cada una.`;
    } else if (preds.length === 1) {
      const p1 = preds[0];
      sendText = `⚽ Mejor apuesta hoy\n\nTengo este pick disponible: ${p1.home} vs ${p1.away} — pick: ${p1.rec}, confianza ${p1.conf}%.\n\n¿Es una buena apuesta? Dame tu análisis.`;
    } else {
      sendText = '⚽ ¿Cuál es la mejor apuesta del día según los pronósticos actuales? Dime la de mayor confianza y luego la segunda mejor como alternativa.';
    }

  } else if (chipId === 'equipos-racha') {
    displayText = '🔥 Equipos en Racha';
    sendText = '🔥 ¿Cuáles son los equipos en racha ganadora esta semana en Champions League, Copa Libertadores, Premier League y La Liga? Dame los 3 o 4 más destacados con su racha actual.';

  } else if (chipId === 'gestion-banca') {
    displayText = '💰 Gestión de Banca';
    sendText = '💰 Dame consejos prácticos de gestión de banca (bankroll management) para apostar en deportes: criterio Kelly, qué porcentaje del bankroll apostar por pick, cómo manejar rachas negativas y cuándo parar. Sé concreto y directo.';

  } else if (chipId === 'promo-hoy') {
    // Respuesta hardcodeada — NO pasa por el Worker para evitar rechazos del modelo
    _showPromoDirecta();
    return; // No llamar a aiSend()

  } else {
    // fallback: send as-is
    displayText = chipId;
    sendText = chipId;
  }

  // Store override so aiSend() shows short label but sends full context
  window._aiChipOverride = (sendText !== displayText) ? sendText : null;
  document.getElementById('aiInput').value = displayText;
  aiSend();
}

// Si el mensaje es sobre tipsters/canales/picks gratis, inyecta la info directamente
function aiEnrichWithChannels(msg) {
  if (!msg) return msg;
  const keywords = /tipster|canal|canales|telegram|picks?\s*gratis|apuestas?\s*gratis|grupo|comunidad|seguir|d[oó]nde\s*(ver|seguir|conseguir)|pronósticos?\s*gratis|suscri|vip|premium|free\s*pick/i;
  if (!keywords.test(msg)) return msg;
  const gratis = LATAM_CHANNELS.gratis.map(c => `• ${c.nombre}: ${c.url}`).join('\n');
  const vip    = LATAM_CHANNELS.vip_pagos.map(c => `• ${c.nombre}: ${c.url}`).join('\n');
  return `${msg}\n\n[CONTEXTO - canales de PronosticosLATAM para recomendar]\nGRATIS:\n${gratis}\n\nSERVICIOS VIP:\n${vip}`;
}

async function aiSend() {
  if (aiWorking) return;
  const input   = document.getElementById('aiInput');
  const displayLabel = input.value.trim();
  const hasImg  = !!aiImageB64;
  if (!displayLabel && !hasImg) return;

  // Consume chip override (long context msg) or fall back to display label
  const apiMsg = window._aiChipOverride || displayLabel;
  window._aiChipOverride = null;

  // Capturar y limpiar imagen antes de resetear
  const sendB64  = aiImageB64;
  const sendMime = aiImageMime;

  input.value = '';
  input.style.height = 'auto';
  document.getElementById('aiSendBtn').disabled = true;
  aiWorking = true;
  if (hasImg) aiClearImage();

  // Agrandar ventana al primer mensaje
  document.getElementById('aiChatBox').classList.add('active');

  // Mostrar mensaje del usuario — siempre la etiqueta corta (displayLabel)
  const displayMsg = hasImg
    ? `${displayLabel ? displayLabel + '<br>' : ''}<img loading="lazy" decoding="async" src="data:${sendMime};base64,${sendB64}" style="max-height:120px;border-radius:8px;margin-top:4px;display:block">`
    : displayLabel;
  // Activar promo para la próxima respuesta del bot (1ra vez)
  if (!_aiPromoReady && aiHistory.filter(h => h.role === 'user').length === 0) {
    _aiPromoReady = true;
  }
  // Resetear el timer de inactividad al mandar un mensaje
  _resetInactivityTimer();
  aiAddMsg('user', displayMsg);
  aiHistory.push({ role: 'user', content: apiMsg || '(imagen adjunta)' });

  // Contexto del partido activo (si lo hay)
  const ctx = aiGetMatchContext();

  // Typing indicator (imágenes no buscan web)
  const willSearch = !hasImg && aiNeedsWeb(apiMsg);
  aiShowTyping(willSearch, apiMsg);

  try {
    const res = await fetch(AI_WORKER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: aiEnrichWithChannels(apiMsg) || 'Analiza esta imagen de cuotas y dame tu recomendación.',
        context: ctx,
        channels: LATAM_CHANNELS,
        history: aiHistory.slice(-8),
        lang: (typeof currentLang !== 'undefined' ? currentLang : 'es'),
        image: hasImg ? { data: sendB64, mediaType: sendMime } : null
      })
    });

    aiHideTyping();

    if (!res.ok) throw new Error('HTTP ' + res.status);

    const data = await res.json();
    const reply = data.reply || 'No pude procesar la respuesta.';
    const webUsed = data.webUsed === true;

    const msgEl = aiAddMsg('bot', reply);
    // Badge "🌐 Web" si Tavily buscó info real
    if (webUsed) {
      const badge = document.createElement('div');
      badge.style.cssText = 'display:inline-flex;align-items:center;gap:3px;margin-top:5px;font-size:0.67rem;color:rgba(0,200,83,0.8);border:1px solid rgba(0,200,83,0.3);border-radius:10px;padding:2px 7px;width:fit-content';
      badge.innerHTML = '🌐 Información en tiempo real';
      msgEl.appendChild(badge);
    }
    // Mini-publicidad DBbet cuando la respuesta menciona cuotas / odds
    if (aiReplyMentionsOdds(reply)) {
      const ad = document.createElement('div');
      ad.style.cssText = 'margin-top:9px;background:linear-gradient(135deg,rgba(220,30,46,0.13),rgba(60,8,12,0.18));border:1px solid rgba(220,30,46,0.4);border-radius:10px;padding:8px 11px;display:flex;align-items:center;gap:9px;';
      ad.innerHTML = `
        <img loading="lazy" decoding="async" src="/img/casas/dbbet.svg"
             style="height:22px;object-fit:contain;flex-shrink:0;filter:brightness(1.1)"
             onerror="this.outerHTML='<span style=\\'font-weight:900;font-size:1rem;color:#FFD700;letter-spacing:-0.5px\\'>DB<span style=\\'color:#fff\\'>bet</span></span>'">
        <div style="flex:1;min-width:0">
          <div style="font-size:0.7rem;font-weight:900;color:#FFD700;letter-spacing:0.5px;line-height:1.2">💎 MAIN SPONSOR</div>
          <div style="font-size:0.65rem;color:rgba(255,255,255,0.65);line-height:1.3">Apostá estas cuotas en DBbet y bancá el proyecto</div>
        </div>
        <a href="https://refpa96317.com/L?tag=d_5777587m_11213c_&site=5777587&ad=11213&utm_source=home_dbbet&utm_medium=site" target="_blank" rel="noopener"
           onclick="trackEvent('promo_click',{promo:'dbbet',type:'ai_odds_ad'})"
           style="background:linear-gradient(135deg,#C9A227,#F0CC5A 45%,#B8860B);color:#fff;font-size:0.63rem;font-weight:800;padding:5px 10px;border-radius:7px;text-decoration:none;white-space:nowrap;letter-spacing:0.3px;flex-shrink:0">
          APOSTAR →
        </a>`;
      msgEl.appendChild(ad);
    }
    // Tarjeta de canales cuando la respuesta habla de tipsters/canales/gratis
    if (aiReplyMentionsChannels(reply)) {
      aiChannelsCard(msgEl);
    }
    aiHistory.push({ role: 'assistant', content: reply });

    // Limitar historial a 20 mensajes
    if (aiHistory.length > 20) aiHistory = aiHistory.slice(-20);

  } catch (err) {
    aiHideTyping();
    aiAddMsg('bot', '⚠️ Hubo un error conectando con la IA. Intentá de nuevo en un momento.');
    console.error('AI Chat error:', err);
  } finally {
    aiWorking = false;
    document.getElementById('aiSendBtn').disabled = false;
    document.getElementById('aiInput').focus();
    // Arrancar el timer de inactividad cuando el bot termina de responder
    _resetInactivityTimer();
  }
}

// Captura contexto del partido visible en pantalla (si el usuario tiene uno abierto)
function aiGetMatchContext() {
  try {
    const preds = window._aiPreds;
    if (!Array.isArray(preds) || preds.length === 0) return null;

    // Devolver resumen de TODOS los partidos disponibles
    const matches = preds.map(p => {
      const oddsH = p.probH > 0 ? parseFloat((100 / p.probH).toFixed(2)) : null;
      const oddsD = p.probD > 0 ? parseFloat((100 / p.probD).toFixed(2)) : null;
      const oddsA = p.probA > 0 ? parseFloat((100 / p.probA).toFixed(2)) : null;
      return {
        home:       p.home,
        away:       p.away,
        league:     p.league  || null,
        time:       p.time    || null,
        rec:        p.rec     || null,
        confidence: p.conf    || null,
        probH:      p.probH   || null,
        probD:      p.probD   || null,
        probA:      p.probA   || null,
        oddsH,
        oddsD,
        oddsA,
      };
    });

    return { matches };
  } catch(e) {}
  return null;
}
