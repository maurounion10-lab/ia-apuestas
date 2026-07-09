// ════════════════════════════════════════════════════════════════════════
// Gate de acceso al Cerebro online — gambeta.ai/secreto/*
// Verificación de clave 100% del lado del servidor: el contenido NO se sirve
// sin la clave correcta (no es un ocultar-con-JS). noindex + no-store.
// ════════════════════════════════════════════════════════════════════════
const PASS = 'Mauro123';
const COOKIE = 'cerebro_key';

const LOGIN_HTML = (err) => `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Cerebro Gambeta · Acceso privado</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(ellipse at top,rgba(0,200,83,.12),transparent 60%),#0a100d;
    color:#f0f0f0;font-family:'Inter',-apple-system,system-ui,sans-serif;padding:24px}
  .box{width:100%;max-width:360px;background:#152a20;border:1px solid #2e5240;border-radius:18px;
    padding:32px 28px;box-shadow:0 20px 60px rgba(0,0,0,.5);text-align:center}
  .logo{font-size:1.5rem;font-weight:900;margin-bottom:6px;letter-spacing:-.02em}
  .logo b{color:#3ec46d}.logo span{color:#f5c542}
  .sub{color:#8a9891;font-size:.82rem;margin-bottom:22px}
  input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid #2e5240;background:#0a100d;
    color:#fff;font-size:1rem;font-family:inherit;margin-bottom:12px}
  input:focus{outline:none;border-color:#3ec46d}
  button{width:100%;padding:12px;border:none;border-radius:10px;
    background:linear-gradient(135deg,#3ec46d,#2a9450);color:#04160c;font-weight:800;
    font-size:.95rem;cursor:pointer;font-family:inherit}
  button:hover{box-shadow:0 4px 16px rgba(62,196,109,.4)}
  .err{color:#e07272;font-size:.8rem;margin-bottom:12px;font-weight:600}
</style></head>
<body>
  <form class="box" method="GET" autocomplete="off">
    <div class="logo">gam<b>beta</b><span>.ai</span></div>
    <div class="sub">🧠 Cerebro del proyecto · acceso privado</div>
    ${err ? '<div class="err">Clave incorrecta. Probá de nuevo.</div>' : ''}
    <input type="password" name="key" placeholder="Clave de acceso" autofocus required>
    <button type="submit">Entrar</button>
  </form>
</body></html>`;

const denyHeaders = {
  'Content-Type': 'text/html; charset=UTF-8',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cache-Control': 'no-store'
};

export const onRequest = async (context) => {
  const { request, next } = context;
  const url = new URL(request.url);
  const cookies = request.headers.get('Cookie') || '';
  const hasCookie = cookies.split(';').some(c => c.trim() === COOKIE + '=' + PASS);
  const qKey = url.searchParams.get('key');

  // Envío del formulario con la clave
  if (qKey !== null) {
    if (qKey === PASS) {
      url.searchParams.delete('key');
      return new Response(null, {
        status: 302,
        headers: {
          'Location': url.pathname + (url.search || ''),
          'Set-Cookie': `${COOKIE}=${PASS}; Path=/secreto/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
          'X-Robots-Tag': 'noindex, nofollow',
          'Cache-Control': 'no-store'
        }
      });
    }
    return new Response(LOGIN_HTML(true), { status: 401, headers: denyHeaders });
  }

  // Ya autenticado → servir el contenido real
  if (hasCookie) {
    const res = await next();
    const r = new Response(res.body, res);
    r.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return r;
  }

  // Sin clave → página de acceso
  return new Response(LOGIN_HTML(false), { status: 401, headers: denyHeaders });
};
