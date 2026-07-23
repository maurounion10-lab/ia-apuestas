/* gambeta.ai — widget de promo SOLO en /blog/.
   Diseño SEO-safe: tarjeta anclada en esquina, NO tapa el contenido, NO bloquea scroll,
   sin backdrop. Solo se minimiza (no se cierra). Secuencia de 3 tarjetas.
   Avance: al CAMBIAR de página dispara la siguiente al instante; si el visitante se queda
   en la misma nota, igual avanza 2 min después de minimizar (respaldo).
   Cualquier error es silencioso y no afecta la página. */
(function () {
  try {
    if (!/^\/blog(\/|$)/.test(location.pathname)) return;      // SOLO blog
    if (location.pathname.indexOf('/blog/img/') === 0) return;  // no en imágenes
    if (window.__gbPromo) return; window.__gbPromo = true;

    var GAP = 15000;             // 🆕 (23-jul) secuencia por tiempo: 15s entre tarjetas
                                 // (2da = +15s de la 1ra, 3ra = +30s de la 1ra)
    var FIRST_DELAY = 4000;      // 4s antes del primero
    var NAV_DELAY = 1200;        // al cambiar de página, casi inmediato
    var KEY = 'gbPromoV2';
    var ORDER = ['picks', 'tg', 'db'];
    var DATA = {
      picks: {
        icon: '🤖', accent: '#00c853',
        title: 'Picks del Mundial con IA — gratis',
        body: 'Llegaste por una nota, pero lo que mueve la aguja son los pronósticos. La IA de Gambeta publica picks con valor (EV+) todos los días, sin registro.',
        cta: 'Ver los picks gratis', href: 'https://gambeta.ai/?ref=blog-promo-picks', note: ''
      },
      tg: {
        icon: '📲', accent: '#229ED9',
        title: 'Sumate a nuestro Telegram',
        body: 'Recibí los picks del Mundial y las alertas de valor directo en tu celular, gratis, en nuestro canal principal.',
        cta: 'Unirme al canal', href: 'https://t.me/GrupoLatam', note: ''
      },
      db: {
        icon: '🎁', accent: '#ffd700',
        title: '¿Vas a apostar el Mundial?',
        body: 'Si vas a jugar igual, que al menos te regalen el primer depósito. Mirá cómo funciona el bono de bienvenida de DBbet.',
        cta: 'Ver el bono de DBbet', href: '/blog/bonos-mundial-2026-dbbet', note: '+18 · Jugá con responsabilidad'
      }
    };

    function read() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
    function write(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
    var st = read();
    st.stage = st.stage || 0;    // cuántas tarjetas se mostraron (0..3)
    st.state = st.state || {};   // key -> 'open' | 'min'
    st.minAt = st.minAt || {};   // key -> ts de minimizado
    ORDER.forEach(function (k) { if (!st.state[k]) st.state[k] = 'hidden'; });

    var changedPage = !!(st.lastPath && st.lastPath !== location.pathname);
    st.lastPath = location.pathname;
    write(st);

    // ---- estilos ----
    var css = document.createElement('style');
    css.textContent =
      '#gbPromo{position:fixed;right:16px;bottom:16px;z-index:99990;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;display:flex;flex-direction:column;align-items:flex-end;gap:8px;max-width:330px;pointer-events:none}' +
      '#gbPromo *{box-sizing:border-box}' +
      '#gbPromo .gb-card{pointer-events:auto;width:330px;max-width:86vw;background:#10151a;border:1px solid rgba(255,255,255,.12);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.45);overflow:hidden;animation:gbIn .25s ease}' +
      '#gbPromo .gb-top{display:flex;align-items:center;gap:8px;padding:11px 12px;border-bottom:1px solid rgba(255,255,255,.07)}' +
      '#gbPromo .gb-ic{font-size:1.1rem}' +
      '#gbPromo .gb-ti{flex:1;font-size:.86rem;font-weight:800;color:#fff;line-height:1.2}' +
      '#gbPromo .gb-min{cursor:pointer;border:0;background:rgba(255,255,255,.08);color:#cfd8dc;width:26px;height:26px;border-radius:7px;font-size:1rem;line-height:1;flex:none}' +
      '#gbPromo .gb-min:hover{background:rgba(255,255,255,.16)}' +
      '#gbPromo .gb-bd{padding:12px 14px}' +
      '#gbPromo .gb-bd p{margin:0 0 12px;font-size:.84rem;color:rgba(255,255,255,.72);line-height:1.5}' +
      '#gbPromo .gb-cta{display:block;text-align:center;text-decoration:none;font-weight:800;font-size:.85rem;color:#06140a;padding:11px 14px;border-radius:10px}' +
      '#gbPromo .gb-note{margin:8px 0 0;font-size:.68rem;color:rgba(255,255,255,.4);text-align:center}' +
      '#gbPromo .gb-pills{pointer-events:auto;display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}' +
      '#gbPromo .gb-pill{cursor:pointer;display:flex;align-items:center;gap:6px;background:#10151a;border:1px solid rgba(255,255,255,.14);color:#fff;border-radius:30px;padding:7px 12px;font-size:.76rem;font-weight:700;box-shadow:0 6px 18px rgba(0,0,0,.35)}' +
      '#gbPromo .gb-pill:hover{border-color:rgba(255,255,255,.35)}' +
      '#gbPromo .gb-dot{width:7px;height:7px;border-radius:50%}' +
      '@keyframes gbIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}' +
      '@media(max-width:520px){#gbPromo{right:8px;left:8px;bottom:8px;max-width:none;align-items:stretch}#gbPromo .gb-card{width:100%;max-width:none}}';
    (document.head || document.documentElement).appendChild(css);

    var wrap = document.createElement('div');
    wrap.id = 'gbPromo';
    wrap.setAttribute('aria-label', 'Novedades de Gambeta');
    document.body.appendChild(wrap);

    var timer = null;
    function setTimer(fn, ms) { if (timer) clearTimeout(timer); timer = setTimeout(fn, ms); }

    function render() {
      wrap.innerHTML = '';
      var openKey = ORDER.filter(function (k) { return st.state[k] === 'open'; }).pop();
      if (openKey) {
        var d = DATA[openKey];
        var card = document.createElement('div'); card.className = 'gb-card';
        card.innerHTML =
          '<div class="gb-top"><span class="gb-ic">' + d.icon + '</span>' +
          '<span class="gb-ti">' + d.title + '</span>' +
          '<button class="gb-min" aria-label="Minimizar" title="Minimizar">—</button></div>' +
          '<div class="gb-bd"><p>' + d.body + '</p>' +
          '<a class="gb-cta" href="' + d.href + '" rel="noopener" style="background:' + d.accent + '">' + d.cta + '</a>' +
          (d.note ? '<p class="gb-note">' + d.note + '</p>' : '') + '</div>';
        card.querySelector('.gb-min').addEventListener('click', function () { minimize(openKey); });
        card.querySelector('.gb-cta').addEventListener('click', function () {
          if (d.href.charAt(0) === '/') return;            // navegación interna normal
          window.open(d.href, '_blank', 'noopener');
          setTimeout(function () { minimize(openKey); }, 50);
        });
        wrap.appendChild(card);
      }
      var mins = ORDER.filter(function (k) { return st.state[k] === 'min'; });
      if (mins.length) {
        var pills = document.createElement('div'); pills.className = 'gb-pills';
        mins.forEach(function (k) {
          var d = DATA[k];
          var p = document.createElement('button'); p.className = 'gb-pill';
          p.innerHTML = '<span class="gb-dot" style="background:' + d.accent + '"></span>' + d.icon + ' ' + label(k);
          p.addEventListener('click', function () { reopen(k); });
          pills.appendChild(p);
        });
        wrap.appendChild(pills);
      }
    }
    function label(k) { return k === 'picks' ? 'Picks IA' : k === 'tg' ? 'Telegram' : 'Bono'; }

    // abre una tarjeta minimizando (en silencio) cualquier otra abierta
    function openCard(k) {
      ORDER.forEach(function (o) {
        if (o !== k && st.state[o] === 'open') { st.state[o] = 'min'; if (!st.minAt[o]) st.minAt[o] = Date.now(); }
      });
      st.state[k] = 'open'; write(st); render();
    }
    // muestra la próxima tarjeta de la secuencia
    function showNext() {
      var key = ORDER[st.stage];
      if (!key) return;
      openCard(key);
      st.stage++; write(st);
      // 🆕 (23-jul) encadenar la próxima por tiempo (15s), sin requerir minimizar
      if (st.stage < ORDER.length) setTimer(showNext, GAP);
    }
    // click del usuario en "—" : colapsa y arma el respaldo de 2 min para la siguiente
    function minimize(k) {
      st.state[k] = 'min'; st.minAt[k] = Date.now(); write(st); render();
    }
    // reabrir desde un pill
    function reopen(k) { openCard(k); }

    render();

    // ---- decidir cuándo aparece la próxima ----
    if (st.stage === 0) {
      setTimer(showNext, FIRST_DELAY);                 // primera vez: tarjeta 1
    } else if (st.stage < ORDER.length) {
      if (changedPage) {
        setTimer(showNext, NAV_DELAY);                 // cambió de página -> dispara ya
      } else {
        // misma página (recarga a mitad de secuencia): continuar por tiempo
        setTimer(showNext, GAP);
      }
    }
  } catch (e) { /* silencioso */ }
})();
