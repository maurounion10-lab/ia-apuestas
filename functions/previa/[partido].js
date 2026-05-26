// Cloudflare Pages Function: /previa/[partido]
// Renderiza una previa SEO por cada pick existente en el historial.

import { fetchHistorial, pickSlug } from './_shared.js';
import { renderPrevia } from './_render.js';

export async function onRequest(context) {
  const { params } = context;
  const slug = (params.partido || '').toString();

  try {
    const picks = await fetchHistorial();
    // Find pick whose slug matches; prefer first match (newest in array)
    const pick = picks.find(p => pickSlug(p) === slug);

    if (!pick) {
      return new Response(notFoundHtml(slug), {
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    const html = renderPrevia(pick);
    const resolved = pick.result && pick.result !== 'pending';
    // Past resolved picks: cache 1 day. Pending/upcoming: 10 min.
    const sMaxAge = resolved ? 86400 : 600;

    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': `public, max-age=180, s-maxage=${sMaxAge}, stale-while-revalidate=120`
      }
    });
  } catch (e) {
    return new Response(`Error generating previa: ${e.message}`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

function notFoundHtml(slug) {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><title>Previa no encontrada | gambeta.ai</title>
<meta name="robots" content="noindex,follow"/>
<style>body{background:#0f0f0f;color:#fff;font-family:system-ui;text-align:center;padding:80px 24px;line-height:1.7}a{color:#00c853}</style>
</head><body>
<h1>Previa no encontrada</h1>
<p>No tenemos pronóstico para "<code>${slug.replace(/[<>"']/g, '')}</code>".</p>
<p><a href="/previas">Ver todas las previas disponibles →</a><br><a href="https://gambeta.ai">Volver al inicio</a></p>
</body></html>`;
}
