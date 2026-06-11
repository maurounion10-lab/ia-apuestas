/* Hard-gate Mundial 2026 - Gambeta v2
 * - Aparece al 75% del scroll (no por delay)
 * - Cruz X visible para cerrar
 * - Si cierra, scroll queda capped al 75% (no puede llegar al final sin email)
 * - Si scrollea mas alla, re-abre el modal
 */
(function(){
  'use strict';
  try { if (localStorage.getItem('gambeta_lead_ok') === '1') return; } catch(e){}

  var path = location.pathname.replace(/\/$/, '');
  var landing = path.split('/').pop() || 'landing';
  var sourceMap = {
    'predicciones-ia': 'mundial-predicciones',
    'calendario-ia':   'mundial-calendario',
    'estadisticas-ia': 'mundial-estadisticas'
  };
  var source = sourceMap[landing] || 'mundial-otro';

  var gateInjected = false;
  var gateVisible = false;
  var capActive = false;
  var THRESHOLD_PCT = 0.75;

  var css = '\
.gate-backdrop{position:fixed;inset:0;z-index:99998;background:rgba(8,8,14,0.92);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;padding:20px;opacity:0;transition:opacity .35s ease}\
.gate-backdrop.show{display:flex;opacity:1}\
.gate-card{background:linear-gradient(135deg,#161620 0%,#1a1a28 100%);border:1px solid rgba(212,175,55,.4);border-radius:24px;max-width:520px;width:100%;padding:36px 32px 30px;box-shadow:0 30px 80px rgba(0,0,0,.6);position:relative;overflow:hidden;transform:translateY(20px);opacity:0;transition:transform .4s ease,opacity .4s ease}\
.gate-backdrop.show .gate-card{transform:translateY(0);opacity:1}\
.gate-card::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at top right,rgba(212,175,55,.18) 0%,transparent 60%);pointer-events:none}\
.gate-content{position:relative;z-index:1}\
.gate-close{position:absolute;top:14px;right:14px;width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.18);color:rgba(255,255,255,.8);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:20px;line-height:1;font-weight:300;z-index:99999;transition:background .15s,color .15s,transform .15s}\
.gate-close:hover{background:rgba(255,255,255,.20);color:#fff;transform:scale(1.08)}\
.gate-badge{display:inline-block;background:rgba(212,175,55,.18);color:#f5cd47;border:1px solid rgba(212,175,55,.4);padding:6px 14px;border-radius:100px;font:600 11px/1 "Poppins",system-ui,sans-serif;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:16px}\
.gate-title{font-family:"Anton",sans-serif;font-size:clamp(28px,5vw,40px);line-height:1.05;color:#fff;text-transform:uppercase;letter-spacing:1px;margin-bottom:14px}\
.gate-title .g{background:linear-gradient(135deg,#f5cd47 0%,#d4af37 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}\
.gate-desc{font:500 15px/1.5 "Poppins",system-ui,sans-serif;color:rgba(255,255,255,.7);margin-bottom:22px}\
.gate-form{display:flex;flex-direction:column;gap:12px}\
.gate-input{background:rgba(255,255,255,.06);border:1.5px solid rgba(255,255,255,.15);color:#fff;padding:16px 18px;border-radius:12px;font:600 16px/1 "Poppins",system-ui,sans-serif;width:100%;outline:none;transition:border-color .2s}\
.gate-input:focus{border-color:#f5cd47}\
.gate-input::placeholder{color:rgba(255,255,255,.4)}\
.gate-btn{background:linear-gradient(135deg,#f5cd47 0%,#d4af37 100%);color:#0a0a0f;border:none;padding:18px 24px;border-radius:12px;font:900 17px/1 "Anton",sans-serif;letter-spacing:1.5px;text-transform:uppercase;cursor:pointer;transition:transform .15s;width:100%}\
.gate-btn:hover{transform:translateY(-1px)}\
.gate-btn:disabled{opacity:.6;cursor:wait}\
.gate-features{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 22px}\
.gate-features span{font:600 11px/1 "Poppins",system-ui,sans-serif;color:rgba(255,255,255,.55);background:rgba(255,255,255,.04);padding:6px 12px;border-radius:100px;border:1px solid rgba(255,255,255,.08)}\
.gate-error{background:rgba(200,16,46,.15);border:1px solid rgba(200,16,46,.4);color:#ff8a99;padding:12px 14px;border-radius:10px;font:600 13px/1.4 "Poppins",system-ui,sans-serif;margin-top:10px;display:none}\
.gate-error.show{display:block}\
.gate-fineprint{font:500 11px/1.4 "Poppins",system-ui,sans-serif;color:rgba(255,255,255,.4);text-align:center;margin-top:14px}\
.gate-locked{overflow:hidden!important}\
@media (max-width:480px){\
  .gate-card{padding:30px 22px 26px;border-radius:20px}\
  .gate-features{gap:6px}\
  .gate-features span{padding:5px 10px;font-size:10px}\
  .gate-close{top:10px;right:10px;width:34px;height:34px;font-size:18px}\
}\
';

  function getMaxScrollAllowed(){
    var docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    var winH = window.innerHeight;
    var scrollable = docH - winH;
    return Math.floor(scrollable * THRESHOLD_PCT);
  }

  function buildGate(){
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    var bd = document.createElement('div');
    bd.id = 'gambeta-gate';
    bd.className = 'gate-backdrop';
    bd.innerHTML = '\
      <div class="gate-card">\
        <button type="button" class="gate-close" id="gate-close" aria-label="Cerrar">×</button>\
        <div class="gate-content">\
          <span class="gate-badge">⚡ ACCESO GRATIS · 2 IAS</span>\
          <h2 class="gate-title">DESBLOQUEÁ <span class="g">2 IAs GRATIS</span> DEL MUNDIAL</h2>\
          <p class="gate-desc">Dejá tu mail y desbloqueá <strong>2 herramientas IA distintas</strong>: predicciones partido a partido + combinadas premium. 100% gratis.</p>\
          <div class="gate-features">\
            <span>🏆 IA #1: Predicciones</span>\
            <span>💰 IA #2: Combinadas</span>\
            <span>⚡ Sin spam</span>\
          </div>\
          <form class="gate-form" id="gate-form" novalidate>\
            <input type="email" class="gate-input" id="gate-email" placeholder="tu@email.com" autocomplete="email" required>\
            <button type="submit" class="gate-btn" id="gate-btn">DESBLOQUEAR LAS 2 IAs →</button>\
            <div class="gate-error" id="gate-error"></div>\
          </form>\
          <p class="gate-fineprint">Sin spam. Podés darte de baja cuando quieras.</p>\
        </div>\
      </div>\
    ';
    document.body.appendChild(bd);
    document.getElementById('gate-close').addEventListener('click', closeGate);
    document.getElementById('gate-form').addEventListener('submit', submitGate);
    gateInjected = true;
  }

  function showGate(){
    if (!gateInjected) buildGate();
    var bd = document.getElementById('gambeta-gate');
    bd.style.display = 'flex';
    requestAnimationFrame(function(){ bd.classList.add('show'); });
    document.body.classList.add('gate-locked');
    gateVisible = true;
    setTimeout(function(){ try{ document.getElementById('gate-email').focus(); }catch(e){} }, 400);
  }

  function hideGate(){
    var bd = document.getElementById('gambeta-gate');
    if (!bd) return;
    bd.classList.remove('show');
    setTimeout(function(){
      bd.style.display = 'none';
      document.body.classList.remove('gate-locked');
    }, 350);
    gateVisible = false;
  }

  function closeGate(){
    hideGate();
    capActive = true;
    var cap = getMaxScrollAllowed();
    if (window.scrollY > cap) {
      window.scrollTo({ top: cap, behavior: 'smooth' });
    }
    if (window.gtag) gtag('event','gate_close',{event_category:'mundial-gate', event_label: source});
  }

  function onScroll(){
    var cap = getMaxScrollAllowed();
    var currentY = window.scrollY;
    if (!gateVisible && !capActive && currentY >= cap){
      showGate();
      if (window.gtag) gtag('event','gate_show',{event_category:'mundial-gate', event_label: source});
      return;
    }
    if (!gateVisible && capActive && currentY > cap){
      showGate();
      window.scrollTo({ top: cap, behavior: 'auto' });
      if (window.gtag) gtag('event','gate_reopen',{event_category:'mundial-gate', event_label: source});
    }
  }

  var scrollPending = false;
  function onScrollThrottled(){
    if (!scrollPending){
      scrollPending = true;
      requestAnimationFrame(function(){
        onScroll();
        scrollPending = false;
      });
    }
  }

  async function submitGate(e){
    e.preventDefault();
    var err = document.getElementById('gate-error');
    var input = document.getElementById('gate-email');
    var btn = document.getElementById('gate-btn');
    err.classList.remove('show');
    var email = (input.value || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
      err.textContent = 'Email invalido — revisalo y volve a intentar.';
      err.classList.add('show');
      return;
    }
    btn.disabled = true;
    btn.textContent = 'ENVIANDO…';
    try {
      var res = await fetch('https://apuestas-api.mauro-union10.workers.dev/api/lead-signup', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email: email, source: source, landing: landing })
      });
      var data = await res.json();
      if (data && data.ok){
        try { localStorage.setItem('gambeta_lead_ok', '1'); } catch(e){}
        if (window.gtag) gtag('event','lead_capture',{event_category:'mundial-gate', event_label: source});
        location.href = (data.redirect || '/mundial/eleccion');
      } else {
        err.textContent = (data && data.error) ? 'Error: ' + data.error : 'No pudimos suscribirte. Probá de nuevo.';
        err.classList.add('show');
        btn.disabled = false;
        btn.textContent = 'DESBLOQUEAR LAS 2 IAs →';
      }
    } catch (ex) {
      err.textContent = 'Error de conexion. Revisa tu internet y reintenta.';
      err.classList.add('show');
      btn.disabled = false;
      btn.textContent = 'DESBLOQUEAR LAS 2 IAs →';
    }
  }

  function init(){
    window.addEventListener('scroll', onScrollThrottled, { passive: true });
    onScroll();
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive'){
    setTimeout(init, 300);
  } else {
    document.addEventListener('DOMContentLoaded', function(){ setTimeout(init, 300); });
  }

  // Exponer API pública para abrir el gate desde otros elementos (banner sticky, CTAs, etc)
  window.gambetaOpenGate = function(){
    // Si ya entrego email, no abrir gate
    try { if (localStorage.getItem('gambeta_lead_ok') === '1') return false; } catch(e){}
    showGate();
    if (window.gtag) gtag('event','gate_manual_open',{event_category:'mundial-gate', event_label: source});
    return true;
  };
})();
