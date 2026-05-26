// /previas — listado HTML de las previas disponibles (discreto, sin promoción agresiva)

import { fetchHistorial, pickSlug, escapeHtml } from '../previa/_shared.js';

export async function onRequest(context) {
  try {
    const picks = await fetchHistorial();
    // Filter to picks with valid commenceTs and slug; sort by commenceTs desc; limit 200 most recent
    const valid = picks
      .filter(p => p.commenceTs && pickSlug(p))
      .sort((a, b) => (b.commenceTs || 0) - (a.commenceTs || 0))
      .slice(0, 200);

    const now = Date.now();
    const upcoming = valid.filter(p => p.commenceTs > now - 3 * 3600 * 1000 && !p.result?.match(/win|loss|void/));
    const recent = valid.filter(p => p.result && p.result !== 'pending');

    const cardsHtml = (arr) => arr.map(p => {
      const slug = pickSlug(p);
      const d = new Date(p.commenceTs);
      const dateStr = d.toLocaleDateString('es-AR', { day: '2-digit', month: 'short', timeZone: 'America/Argentina/Buenos_Aires' });
      const tag = p.result === 'win' ? '✅ Ganado' : p.result === 'loss' ? '❌ Perdido' : p.result === 'void' ? '↩️ Anulado' : '🔮 Próximo';
      return `<a href="/previa/${slug}" class="pcard">
  <div class="pcard-tag">${tag} · ${escapeHtml(p.league || '')}</div>
  <div class="pcard-title">${escapeHtml(p.home)} <span class="vs">vs</span> ${escapeHtml(p.away)}</div>
  <div class="pcard-meta">${escapeHtml(p.rec || '')} · ${dateStr}</div>
</a>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="utf-8"/>
<meta content="width=device-width, initial-scale=1.0" name="viewport"/>
<title>Previas IA — pronósticos de partidos | gambeta.ai</title>
<meta content="Listado de previas y pronósticos de partidos generados por la IA de gambeta.ai. Análisis cuantitativo con probabilidades, cuotas y resultados verificables." name="description"/>
<link href="https://gambeta.ai/previas" rel="canonical"/>
<meta content="index, follow" name="robots"/>
<link href="/favicon.png" rel="icon" sizes="32x32" type="image/png"/>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0f0f0f;color:#e8e8e8;font-family:'Segoe UI',system-ui,sans-serif;line-height:1.6;padding-top:66px}
  a{text-decoration:none;color:inherit}
  nav.nav{background:#060d06;border-bottom:1px solid rgba(0,200,83,0.2);padding:0 28px;height:66px;display:flex;align-items:center;justify-content:space-between;position:fixed;top:0;left:0;right:0;z-index:10000}
  .nav-logo-text{font-size:1.08rem;font-weight:900;color:#fff}
  .nav-logo-text span{color:#00c853}
  .nav-cta-btn{background:linear-gradient(135deg,#00c853,#00a846);color:#000;font-weight:700;padding:8px 18px;border-radius:8px;font-size:.82rem}
  .hero{background:linear-gradient(180deg,#071007 0%,#0c180c 100%);border-bottom:1px solid rgba(0,200,83,0.15);padding:48px 24px 40px;text-align:center}
  .hero h1{font-size:clamp(1.7rem,4vw,2.4rem);font-weight:900;color:#fff;margin-bottom:10px}
  .hero p{color:rgba(255,255,255,0.5);max-width:620px;margin:0 auto}
  .container{max-width:1100px;margin:0 auto;padding:40px 24px 80px}
  .section-title{font-size:0.78rem;color:#00c853;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;margin:24px 0 14px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;margin-bottom:36px}
  .pcard{background:rgba(255,255,255,0.04);border:1px solid rgba(0,200,83,0.15);border-radius:12px;padding:16px 18px;transition:border-color .2s,background .2s}
  .pcard:hover{border-color:rgba(0,200,83,0.4);background:rgba(0,200,83,0.05)}
  .pcard-tag{font-size:0.7rem;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.8px;margin-bottom:8px}
  .pcard-title{font-size:1rem;font-weight:700;color:#fff;line-height:1.35;margin-bottom:6px}
  .pcard-title .vs{color:rgba(255,255,255,0.4);font-weight:500;margin:0 4px}
  .pcard-meta{font-size:0.82rem;color:rgba(255,255,255,0.55)}
  .footer{background:#060d06;border-top:1px solid rgba(0,200,83,0.12);padding:24px;text-align:center;font-size:0.82rem;color:rgba(255,255,255,0.3)}
  .footer a{color:#00c853}
  .empty{text-align:center;color:rgba(255,255,255,0.4);padding:30px 0}
</style>
</head><body>
<nav class="nav">
  <a class="nav-logo-text" href="https://gambeta.ai">gambeta<span>.ai</span></a>
  <a class="nav-cta-btn" href="https://gambeta.ai">✦ Ver pronósticos</a>
</nav>
<header class="hero">
  <h1>Previas y pronósticos de la IA</h1>
  <p>Análisis cuantitativo de partidos con probabilidades del modelo, cuotas del mercado y resultados verificables.</p>
</header>
<main class="container">
  ${upcoming.length ? `<div class="section-title">Próximos partidos</div><div class="grid">${cardsHtml(upcoming)}</div>` : ''}
  <div class="section-title">Previas recientes</div>
  ${recent.length ? `<div class="grid">${cardsHtml(recent.slice(0, 60))}</div>` : '<div class="empty">No hay previas disponibles todavía.</div>'}
</main>
<footer class="footer">
  <p>© 2026 <a href="https://gambeta.ai">gambeta.ai</a> · Inteligencia Artificial para Apostar · 18+</p>
</footer>
</body></html>`;

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=120, s-maxage=300, stale-while-revalidate=60'
      }
    });
  } catch (e) {
    return new Response('Error: ' + e.message, { status: 500 });
  }
}
