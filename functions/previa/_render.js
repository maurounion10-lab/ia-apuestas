// HTML renderer for a previa page

import { escapeHtml, formatDateAR, pickSlug } from './_shared.js';

function impProb(odds) {
  if (!odds || odds <= 1) return null;
  return (100 / odds);
}

function explainMarket(rec) {
  if (!rec) return '';
  const m = rec.match(/^Más de (\d+\.?\d*)$/);
  if (m) return `Es una apuesta a que en este partido se metan más de ${m[1]} goles entre los dos equipos.`;
  const g = rec.match(/^Gana\s+(.+)$/i);
  if (g) return `Es una apuesta a que ${g[1]} gane el partido. Si el resultado es empate o pierde, el pick pierde.`;
  if (rec === 'Empate') return 'Es una apuesta a que el partido termine empatado en el tiempo reglamentario.';
  if (rec === 'Ambos Marcan') return 'Es una apuesta a que ambos equipos marquen al menos un gol.';
  return '';
}

function confExplanation(conf, bvrText) {
  const t = bvrText || conf || 'Media';
  if (t === 'Máxima' || conf === 'high') return 'La IA marcó este pick como Máxima — es uno de los niveles más altos de convicción que entrega el modelo.';
  if (t === 'Alta' || conf === 'high') return 'La IA marcó este pick con Alta confianza — el modelo identificó valor claro frente a la cuota del mercado.';
  if (t === 'Media-Alta') return 'La IA marcó este pick como Media-Alta — convicción decente, valor visible pero no extremo.';
  return 'La IA marcó este pick como Media — convicción suficiente para apostar con stake estándar.';
}

function resultBlock(pick) {
  if (!pick.result || pick.result === 'pending') return '';
  const r = pick.result;
  const score = escapeHtml(pick.finalScore || '');
  const pl = pick.pl || 0;
  const stake = pick.stake || 50;
  if (r === 'win') {
    return `<h2>Resultado del partido</h2>
<p>Final: <strong>${score}</strong>. El pick <strong style="color:#00c853">ganó</strong> con un PL de <strong>+${pl}</strong> unidades sobre un stake de ${stake}.</p>`;
  }
  if (r === 'loss') {
    return `<h2>Resultado del partido</h2>
<p>Final: <strong>${score}</strong>. El pick <strong style="color:#e57373">no ganó</strong> esta vez. PL: ${pl} unidades. <em>Todos los picks de la IA quedan en el historial público — incluyendo los que pierden — porque el ROI a largo plazo es lo que importa.</em></p>`;
  }
  if (r === 'void') {
    return `<h2>Resultado del partido</h2>
<p>El partido fue <strong>anulado</strong> (${score || 'pospuesto o cancelado'}). El stake se considera devuelto: PL ${pl}.</p>`;
  }
  return '';
}

export function renderPrevia(pick) {
  const slug = pickSlug(pick);
  const url = `https://gambeta.ai/previa/${slug}`;
  const home = escapeHtml(pick.home);
  const away = escapeHtml(pick.away);
  const league = escapeHtml(pick.league || '');
  const rec = escapeHtml(pick.rec || '');
  const odds = pick.odds;
  const conf = pick.bvrText || 'Media';
  const probH = Math.round(pick.probH || 0);
  const probD = Math.round(pick.probD || 0);
  const probA = Math.round(pick.probA || 0);
  const probPick = Math.max(probH, probD, probA);
  const stake = pick.stake || 50;
  const dateFormatted = formatDateAR(pick.commenceTs);
  const dateISO = new Date(pick.commenceTs).toISOString();

  const resolved = pick.result && pick.result !== 'pending';
  const finalScore = pick.finalScore ? escapeHtml(pick.finalScore) : '';

  const title = resolved
    ? `${pick.home} vs ${pick.away} — pronóstico IA y resultado | gambeta.ai`
    : `Pronóstico ${pick.home} vs ${pick.away} (${pick.date || ''}) — la IA recomienda ${pick.rec} | gambeta.ai`;
  const desc = (resolved
    ? `${pick.home} vs ${pick.away} (${league.replace(/[^\w\s.\-]/g, '')}): la IA pronosticó "${pick.rec}" a cuota ${odds}. Mirá el análisis completo y el resultado.`
    : `Pronóstico IA para ${pick.home} vs ${pick.away}: la IA recomienda "${pick.rec}" a cuota ${odds} con confianza ${conf}. Probabilidades del modelo y stake sugerido.`
  ).slice(0, 160);

  const ogTitle = resolved
    ? `${pick.home} vs ${pick.away}: ${pick.rec} (${pick.date}) — pronóstico IA`
    : `${pick.home} vs ${pick.away}: la IA dice ${pick.rec}`;

  const market = explainMarket(pick.rec);
  const confExp = confExplanation(pick.conf, pick.bvrText);

  // Compute "valor" — model probability vs implicit probability
  let valueHint = '';
  const impH = pick._hO ? impProb(pick._hO) : null;
  const impD = pick._dO ? impProb(pick._dO) : null;
  const impA = pick._aO ? impProb(pick._aO) : null;
  if (probPick && pick.odds) {
    const impPick = impProb(pick.odds);
    if (impPick && probPick > impPick + 3) {
      valueHint = `<p>Acá apareció el <strong>valor esperado positivo</strong>: la IA estima ${probPick}% de probabilidad para "${rec}", mientras que la cuota implícita del mercado (${odds}) representa solo ~${impPick.toFixed(1)}%. Esa diferencia de ${(probPick - impPick).toFixed(1)} puntos porcentuales es el "valor" que el modelo detecta y que justifica la apuesta.</p>`;
    }
  }

  const probTable = `<table class="feature-table">
<thead><tr><th>Resultado</th><th>Prob. IA</th><th>Cuota mercado</th><th>Prob. implícita</th></tr></thead>
<tbody>
<tr><td>Gana ${home}</td><td>${probH}%</td><td>${pick._hO || '—'}</td><td>${impH ? impH.toFixed(1) + '%' : '—'}</td></tr>
<tr><td>Empate</td><td>${probD}%</td><td>${pick._dO || '—'}</td><td>${impD ? impD.toFixed(1) + '%' : '—'}</td></tr>
<tr><td>Gana ${away}</td><td>${probA}%</td><td>${pick._aO || '—'}</td><td>${impA ? impA.toFixed(1) + '%' : '—'}</td></tr>
</tbody>
</table>`;

  const schemaArticle = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": ogTitle,
    "description": desc,
    "url": url,
    "datePublished": dateISO,
    "publisher": {
      "@type": "Organization",
      "name": "gambeta.ai",
      "url": "https://gambeta.ai"
    },
    "mainEntityOfPage": url
  });

  const schemaBreadcrumb = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Inicio", "item": "https://gambeta.ai/" },
      { "@type": "ListItem", "position": 2, "name": "Previas", "item": "https://gambeta.ai/previas" },
      { "@type": "ListItem", "position": 3, "name": `${pick.home} vs ${pick.away}`, "item": url }
    ]
  });

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta content="width=device-width, initial-scale=1.0" name="viewport"/>
<title>${escapeHtml(title)}</title>
<meta content="${escapeHtml(desc)}" name="description"/>
<meta content="gambeta.ai" name="author"/>
<meta content="${(pick.commenceTs && (Date.now() - pick.commenceTs) > 7*24*60*60*1000) ? 'noindex, follow' : 'index, follow'}" name="robots"/>
<link href="${url}" rel="canonical"/>
<meta content="article" property="og:type"/>
<meta content="${url}" property="og:url"/>
<meta content="${escapeHtml(ogTitle)} | gambeta.ai" property="og:title"/>
<meta content="${escapeHtml(desc)}" property="og:description"/>
<meta content="https://gambeta.ai/og-image.png" property="og:image"/>
<meta content="es_AR" property="og:locale"/>
<meta content="gambeta.ai" property="og:site_name"/>
<meta content="summary_large_image" name="twitter:card"/>
<meta content="@gambetaia" name="twitter:site"/>
<meta content="${escapeHtml(ogTitle)} | gambeta.ai" name="twitter:title"/>
<meta content="${escapeHtml(desc)}" name="twitter:description"/>
<script type="application/ld+json">${schemaArticle}</script>
<script type="application/ld+json">${schemaBreadcrumb}</script>
<link href="/favicon.png" rel="icon" sizes="32x32" type="image/png"/>
<style>
  :root { --verde: #00c853; --fondo: #0f0f0f; --texto: #e8e8e8; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { padding-top:66px; background:var(--fondo); color:var(--texto); font-family:'Segoe UI',system-ui,sans-serif; line-height:1.7; }
  a { text-decoration:none; color:inherit; }
  nav.nav { background:#060d06; border-bottom:1px solid rgba(0,200,83,0.2); padding:0 28px; height:66px; display:flex; align-items:center; justify-content:space-between; position:fixed; top:0; left:0; right:0; z-index:10000; gap:16px; }
  .nav-logo-wrap { display:flex; align-items:center; gap:11px; }
  .nav-logo-text { font-size:1.08rem; font-weight:900; color:#fff; }
  .nav-logo-text span { color:#00c853; }
  .nav-links { display:flex; gap:2px; flex:1; justify-content:center; }
  .nav-links a { color:rgba(165,214,167,0.65); padding:7px 12px; border-radius:8px; font-size:.82rem; }
  .nav-cta-btn { background:linear-gradient(135deg,#00c853,#00a846); color:#000; font-weight:700; padding:8px 18px; border-radius:8px; font-size:.82rem; }
  @media(max-width:640px){.nav-links{display:none}}
  .hero { background:linear-gradient(180deg,#071007 0%,#0c180c 100%); border-bottom:1px solid rgba(0,200,83,0.15); padding:52px 24px 44px; text-align:center; }
  .badge { display:inline-block; background:rgba(0,200,83,0.12); border:1px solid rgba(0,200,83,0.3); color:var(--verde); font-size:0.7rem; font-weight:800; letter-spacing:1.5px; text-transform:uppercase; padding:4px 14px; border-radius:20px; margin-bottom:18px; }
  .hero h1 { font-size:clamp(1.5rem,4vw,2.2rem); font-weight:900; color:#fff; max-width:760px; margin:0 auto 14px; }
  .hero p { font-size:1rem; color:rgba(255,255,255,0.5); max-width:620px; margin:0 auto; }
  .container { max-width:760px; margin:0 auto; padding:48px 24px; }
  .article h2 { font-size:1.25rem; font-weight:800; color:#fff; margin:36px 0 12px; }
  .article p { font-size:0.97rem; color:rgba(255,255,255,0.68); margin-bottom:18px; }
  .article ul,.article ol { padding-left:22px; margin-bottom:18px; }
  .article li { font-size:0.95rem; color:rgba(255,255,255,0.65); margin-bottom:6px; }
  .article strong { color:rgba(255,255,255,0.9); }
  .article a { color:var(--verde); text-decoration:underline; text-underline-offset:3px; }
  .pick-box { background:linear-gradient(135deg,rgba(0,200,83,0.18),rgba(0,200,83,0.06)); border:1px solid rgba(0,200,83,0.4); border-radius:14px; padding:22px 24px; margin:24px 0 28px; }
  .pick-box .pick-label { font-size:0.72rem; color:#00c853; font-weight:800; letter-spacing:1.5px; text-transform:uppercase; margin-bottom:6px; }
  .pick-box .pick-rec { font-size:1.5rem; font-weight:900; color:#fff; margin-bottom:10px; }
  .pick-box .pick-meta { display:flex; flex-wrap:wrap; gap:18px; margin-top:14px; }
  .pick-box .pick-meta div { font-size:0.85rem; color:rgba(255,255,255,0.7); }
  .pick-box .pick-meta strong { color:#fff; font-size:1rem; }
  .feature-table { width:100%; border-collapse:collapse; margin:24px 0; }
  .feature-table th { background:rgba(0,200,83,0.12); color:#00c853; font-size:0.78rem; font-weight:700; padding:10px 14px; text-align:left; }
  .feature-table td { padding:10px 14px; font-size:0.9rem; color:rgba(255,255,255,0.65); border-bottom:1px solid rgba(255,255,255,0.06); }
  .feature-table tr:last-child td { border-bottom:none; }
  .info-box { background:rgba(255,255,255,0.03); border-left:3px solid var(--verde); padding:16px 20px; margin:24px 0; }
  .info-box p { margin:0; font-size:0.9rem; color:rgba(255,255,255,0.55); }
  .cta-box { background:linear-gradient(135deg,rgba(0,200,83,0.12),rgba(0,200,83,0.04)); border:1px solid rgba(0,200,83,0.3); border-radius:18px; padding:32px 28px; text-align:center; margin:40px 0; }
  .cta-box h3 { color:#fff; margin-bottom:8px; }
  .cta-box p { color:rgba(255,255,255,0.5); margin-bottom:20px; }
  .btn-cta { display:inline-block; background:var(--verde); color:#000; font-weight:800; padding:13px 30px; border-radius:10px; }
  .related { border-top:1px solid rgba(255,255,255,0.06); padding-top:28px; margin-top:12px; }
  .related h4 { font-size:0.85rem; color:rgba(255,255,255,0.35); letter-spacing:1px; text-transform:uppercase; margin-bottom:14px; }
  .related-links { display:flex; flex-wrap:wrap; gap:10px; }
  .related-links a { background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08); color:rgba(255,255,255,0.6); font-size:0.82rem; padding:7px 14px; border-radius:8px; }
  .footer { background:#060d06; border-top:1px solid rgba(0,200,83,0.12); padding:24px; text-align:center; font-size:0.82rem; color:rgba(255,255,255,0.3); }
  .footer a { color:var(--verde); }
</style>
</head>
<body>
<nav class="nav">
  <a class="nav-logo-wrap" href="https://gambeta.ai">
    <span class="nav-logo-text">gambeta<span>.ai</span></span>
  </a>
  <div class="nav-links">
    <a href="https://gambeta.ai/#pronosticos">🔮 Pronósticos</a>
    <a href="https://gambeta.ai/#historial">📋 Resultados</a>
    <a href="/blog/">📰 Blog</a>
  </div>
  <a class="nav-cta-btn" href="https://gambeta.ai">✦ Ver más picks</a>
</nav>
<header class="hero">
  <div class="badge">${league}</div>
  <h1>${home} vs ${away}${resolved ? '' : ': pronóstico IA'}</h1>
  <p>${escapeHtml(dateFormatted)}. Análisis con probabilidades del modelo, cuotas y nivel de confianza.</p>
</header>
<main class="container">
  <article class="article">
    <h2>El partido</h2>
    <p><strong>${home}</strong> enfrenta a <strong>${away}</strong> el ${escapeHtml(dateFormatted)} por ${league}. La IA de gambeta procesó los datos del enfrentamiento (cuotas en vivo del mercado, historial reciente de ambos equipos, contexto de la liga) y armó un pronóstico cuantitativo.</p>

    <div class="pick-box">
      <div class="pick-label">🎯 Pick de la IA</div>
      <div class="pick-rec">${rec}</div>
      <div class="pick-meta">
        <div>Cuota<br/><strong>${odds}</strong></div>
        <div>Confianza<br/><strong>${escapeHtml(conf)}</strong></div>
        <div>Prob. modelo<br/><strong>${probPick}%</strong></div>
        <div>Stake sugerido<br/><strong>${stake}</strong></div>
      </div>
    </div>

    <h2>¿Cómo llegó la IA a este pronóstico?</h2>
    <p>${confExp}</p>
    ${probTable}
    ${valueHint}

    ${market ? `<h2>¿Qué significa "${rec}"?</h2><p>${market}</p>` : ''}

    <h2>Cómo apostar este pick</h2>
    <ul>
      <li><strong>Cuota mínima recomendada:</strong> ${(odds * 0.92).toFixed(2)} — si la cuota cae más abajo, el valor esperado se diluye.</li>
      <li><strong>Stake sugerido:</strong> ${stake} unidades sobre tu bankroll de referencia (ajustá a tu propia gestión).</li>
      <li><strong>Antes de apostar leé:</strong> <a href="/blog/gestion-bankroll">gestión de banca</a> y <a href="/blog/cuotas-y-probabilidades">cuotas y valor esperado</a>.</li>
    </ul>

    ${resultBlock(pick)}

    <div class="info-box">
      <p>🤖 Este pick fue generado por la IA de gambeta.ai. El historial completo de todos los pronósticos (ganadores y perdedores) es <a href="https://gambeta.ai/#historial">público y se actualiza en vivo</a>.</p>
    </div>

    <h2>Más pronósticos como este</h2>
    <p>La IA de gambeta publica picks gratis todos los días con varios niveles de confianza. Si querés ver los pronósticos activos para hoy, <a href="https://gambeta.ai/#pronosticos">están acá</a>.</p>
  </article>

  <div class="cta-box">
    <h3>🧠 Más pronósticos de la IA — gratis y con historial público</h3>
    <p>Cobertura de Libertadores, Sudamericana, ligas europeas y argentinas. Niveles de confianza por pick. Sin VIP ni suscripción.</p>
    <a class="btn-cta" href="https://gambeta.ai/#pronosticos">Ver pronósticos de hoy →</a>
  </div>

  <div class="related">
    <h4>Dónde apostar</h4>
    <div class="related-links">
      <a href="/blog/mejor-casa-apuestas-mundial-2026-argentina">🏆 Mejor casa de apuestas</a>
      <a href="/blog/bonos-mundial-2026-bet365">🎁 Bonos Bet365</a>
      <a href="/blog/bonos-mundial-2026-betano">🎁 Bonos Betano</a>
      <a href="/blog/calculadora-valor-ev">🧮 Calculadora de valor</a>
    </div>
    <h4 style="margin-top:20px">Más artículos</h4>
    <div class="related-links">
      <a href="https://gambeta.ai/#pronosticos">🔮 Pronósticos de hoy</a>
      <a href="https://gambeta.ai/#historial">📋 Historial completo</a>
      <a href="/blog/ia-para-apostar">🧠 IA para apostar</a>
      <a href="/blog/gestion-bankroll">💰 Gestión de banca</a>
      <a href="/blog/cuotas-y-probabilidades">📊 Cuotas en apuestas</a>
      <a href="/previas">📁 Más previas</a>
    </div>
  </div>
</main>
<footer class="footer">
  <p>© 2026 <a href="https://gambeta.ai">gambeta.ai</a> · Inteligencia Artificial para Apostar · 18+</p>
</footer>
</body>
</html>`;
}
