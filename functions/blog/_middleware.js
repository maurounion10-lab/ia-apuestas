// Inyecta el widget de promo SOLO en páginas HTML de /blog/.
// Defensivo: ante cualquier error o si no es HTML, devuelve la respuesta original sin tocar.
export async function onRequest(context) {
  const res = await context.next();
  try {
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) return res;            // imágenes, JS, etc: sin cambios
    const tag = '<script src="/blog/promo-widget.js?v=2" defer></script>';
    return new HTMLRewriter()
      .on("body", { element(el) { el.append(tag, { html: true }); } })
      .transform(res);
  } catch (e) {
    return res;                                           // cualquier fallo -> página intacta
  }
}
