/* Hard-gate Mundial 2026 — Gambeta
 * Inyecta modal bloqueante que obliga a entregar email antes de ver el contenido.
 * Se activa 1.2s despues de DOMReady para que el crawler de Meta vea contenido limpio.
 */
(function(){
  'use strict';

  // No mostrar gate si ya entrego email (cookie / localStorage)
  try {
    if (localStorage.getItem('gambeta_lead_ok') === '1') return;
  } catch(e){}

  // Determinar landing actual
  var path = location.pathname.replace(/\/$/, '');
  var landing = path.split('/').pop() || 'landing';
  var sourceMap = {
    'predicciones-ia': 'mundial-predicciones',
    'calendario-ia':   'mundial-calendario',
    'estadisticas-ia': 'mundial-estadisticas'
  };
  var source = sourceMap[landing] || 'mundial-otro';

  // Estilos del gate
  var css = '\
.gate-backdrop{position:fixed;inset:0;z-index:99998;background:rgba(8,8,14,0.92);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;animation:gateFadeIn .5s ease forwards}\
@keyframes gateFadeIn{to{opacity:1}}\
.gate-card{background:linear-gradient(135deg,#161620 0%,#1a1a28 100%);border:1px solid rgba(212,175,55,.4);border-radius:24px;max-width:520px;width:100%;padding:36px 32px;box-shadow:0 30px 80px rgba(0,0,0,.6),0 0 0 1px rgba(212,175,55,.15);position:relative;overflow:hidden;transform:translateY(20px);animation:gateSlide .5s .15s ease forwards;opacity:0}\
@keyframes gateSlide{to{transform:translateY(0);opacity:1}}\
.gate-card::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at top right,rgba(212,175,55,.18) 0%,transparent 60%);pointer-events:none}\
.gate-content{position:relative;z-index:1}\
.gate-badge{display:inline-block;background:rgba(212,175,55,.18);color:#f5cd47;border:1px solid rgba(212,175,55,.4);padding:6px 14px;border-radius:100px;font:600 11px/1 "Poppins",system-ui,sans-serif;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:16px}\
.gate-title{font-family:"Anton",sans-serif;font-size:clamp(28px,5vw,40px);line-height:1;color:#fff;text-transform:uppercase;letter-spacing:1px;margin-bottom:14px}\
.gate-title .g{background:linear-gradient(135deg,#f5cd47 0%,#d4af37 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}\
.gate-desc{font:500 15px/1.5 "Poppins",system-ui,sans-serif;color:rgba(255,255,255,.7);margin-bottom:24px}\
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
.gate-fineprint{font:500 11px/1.4 "Poppins",system-ui,sans-serif;color:rgba(255,255,255,.4);text-align:center;margin-top:16px}\
body.gate-locked{overflow:hidden!important}\
@media (max-width:480px){\
  .gate-card{padding:28px 22px;border-radius:20px}\
  .gate-features{gap:6px}\
  .gate-features span{padding:5px 10px;font-size:10px}\
}\
';

  function inject(){
    // Inyectar estilos
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    // Construir modal
    var backdrop = document.createElement('div');
    backdrop.className = 'gate-backdrop';
    backdrop.innerHTML = '\
      <div class="gate-card">\
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
    document.body.appendChild(backdrop);
    document.body.classList.add('gate-locked');

    var form = document.getElementById('gate-form');
    var input = document.getElementById('gate-email');
    var btn = document.getElementById('gate-btn');
    var err = document.getElementById('gate-error');

    function showErr(msg){
      err.textContent = msg;
      err.classList.add('show');
    }

    setTimeout(function(){ try{ input.focus(); }catch(e){} }, 600);

    form.addEventListener('submit', async function(e){
      e.preventDefault();
      err.classList.remove('show');
      var email = (input.value || '').trim().toLowerCase();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
        showErr('Email invalido — revisalo y volve a intentar.');
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
          // Redirigir a pagina de eleccion
          location.href = (data.redirect || '/mundial/eleccion');
        } else {
          showErr((data && data.error) ? 'Error: ' + data.error : 'No pudimos suscribirte. Probá de nuevo.');
          btn.disabled = false;
          btn.textContent = 'DESBLOQUEAR LAS 2 IAs →';
        }
      } catch (ex) {
        showErr('Error de conexion. Revisa tu internet y reintenta.');
        btn.disabled = false;
        btn.textContent = 'DESBLOQUEAR LAS 2 IAs →';
      }
    });
  }

  // Delay para que Meta crawler/SEO bot vea la pagina sin gate
  var delay = 1200;
  if (document.readyState === 'complete' || document.readyState === 'interactive'){
    setTimeout(inject, delay);
  } else {
    document.addEventListener('DOMContentLoaded', function(){ setTimeout(inject, delay); });
  }
})();
