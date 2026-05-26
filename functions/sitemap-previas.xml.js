// /sitemap-previas.xml — sitemap dinámico de todas las previas

import { fetchHistorial, pickSlug } from './previa/_shared.js';

export async function onRequest(context) {
  try {
    const picks = await fetchHistorial();
    const valid = picks.filter(p => p.commenceTs && pickSlug(p));
    // Sort by commenceTs desc, dedupe by slug
    const seen = new Set();
    const unique = [];
    for (const p of valid.sort((a, b) => (b.commenceTs || 0) - (a.commenceTs || 0))) {
      const s = pickSlug(p);
      if (!seen.has(s)) { seen.add(s); unique.push(p); }
    }
    // Sitemap max 50,000 URLs per file — we have at most a few thousand for years
    const top = unique.slice(0, 49000);
    const today = new Date().toISOString().slice(0, 10);
    const items = top.map(p => {
      const slug = pickSlug(p);
      const lastmod = new Date(p.resolvedAt || p.commenceTs || Date.now()).toISOString().slice(0, 10);
      const resolved = p.result && p.result !== 'pending';
      const priority = resolved ? '0.5' : '0.7';
      const changefreq = resolved ? 'yearly' : 'daily';
      return `  <url>
    <loc>https://gambeta.ai/previa/${slug}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`;
    }).join('\n');

    // Add the /previas index URL too
    const indexEntry = `  <url>
    <loc>https://gambeta.ai/previas</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.6</priority>
  </url>`;

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${indexEntry}
${items}
</urlset>`;

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300, s-maxage=600, stale-while-revalidate=300'
      }
    });
  } catch (e) {
    return new Response(`<error>${e.message}</error>`, { status: 500, headers: { 'Content-Type': 'application/xml' } });
  }
}
