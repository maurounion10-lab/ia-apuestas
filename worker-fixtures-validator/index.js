/**
 * Worker: wc-fixtures-validator
 * 
 * Cron: cada día 07:00 ART (10:00 UTC)
 * Trabajo:
 *  1. Carga el archivo wc-fixtures.json (single source of truth, en R2 o KV)
 *  2. Filtra los partidos del día actual
 *  3. Fetcha las páginas críticas:
 *     - https://accesoia.app/pick-del-dia
 *     - https://accesoia.app/combinada-del-dia
 *     - https://gambeta.ai/ (ticker)
 *  4. Verifica que mencionen partidos del día actual
 *  5. Si hay mismatch → envía alerta por email a mauro@gambeta.ai
 *  6. Si todo OK → silencio (no spam)
 */

// Fixtures completos Mundial 2026 fase de grupos
// IMPORTANTE: actualizar cuando salgan más resultados (jornadas 2 y 3)
const WC_FIXTURES = [
  { date: '2026-06-11', dayName: 'Jue', home: 'México',         away: 'Sudáfrica',     time: '19:00' },
  { date: '2026-06-12', dayName: 'Vie', home: 'Canadá',         away: 'Bosnia',        time: '16:00' },
  { date: '2026-06-12', dayName: 'Vie', home: 'Estados Unidos', away: 'Paraguay',      time: '20:00' },
  { date: '2026-06-13', dayName: 'Sáb', home: 'Suiza',          away: 'Catar',         time: '13:00' },
  { date: '2026-06-13', dayName: 'Sáb', home: 'Brasil',         away: 'Marruecos',     time: '16:00' },
  { date: '2026-06-13', dayName: 'Sáb', home: 'Haití',          away: 'Escocia',       time: '19:00' },
  { date: '2026-06-14', dayName: 'Dom', home: 'Alemania',       away: 'Curaçao',       time: '13:00' },
  { date: '2026-06-14', dayName: 'Dom', home: 'Colombia',       away: 'Uzbekistán',    time: '16:00' },
  { date: '2026-06-14', dayName: 'Dom', home: 'Países Bajos',   away: 'Japón',         time: '19:00' },
  { date: '2026-06-15', dayName: 'Lun', home: 'Bélgica',        away: 'Egipto',        time: '13:00' },
  { date: '2026-06-15', dayName: 'Lun', home: 'Ecuador',        away: 'Costa Marfil',  time: '16:00' },
  { date: '2026-06-15', dayName: 'Lun', home: 'España',         away: 'Cabo Verde',    time: '19:00' },
  { date: '2026-06-16', dayName: 'Mar', home: 'Francia',        away: 'Senegal',       time: '13:00' },
  { date: '2026-06-16', dayName: 'Mar', home: 'Austria',        away: 'Jordania',      time: '16:00' },
  { date: '2026-06-16', dayName: 'Mar', home: 'Argentina',      away: 'Argelia',       time: '19:00' },
  { date: '2026-06-17', dayName: 'Mié', home: 'Portugal',       away: 'RD Congo',      time: '13:00' },
  { date: '2026-06-17', dayName: 'Mié', home: 'Turquía',        away: 'Noruega',       time: '16:00' },
  { date: '2026-06-17', dayName: 'Mié', home: 'Inglaterra',     away: 'Croacia',       time: '19:00' },
  { date: '2026-06-18', dayName: 'Jue', home: 'Uruguay',        away: 'Túnez',         time: '13:00' },
  { date: '2026-06-18', dayName: 'Jue', home: 'Corea del Sur',  away: 'Iraq',          time: '19:00' },
];

// Páginas críticas a validar
const CRITICAL_PAGES = [
  { url: 'https://accesoia.app/pick-del-dia',       label: 'Pick del día (accesoia.app)' },
  { url: 'https://accesoia.app/combinada-del-dia',  label: 'Combinada del día (accesoia.app)' },
  { url: 'https://gambeta.ai/',                     label: 'Home + Ticker (gambeta.ai)' },
];

function todayARTString() {
  // ART = UTC-3
  const now = new Date();
  const art = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return art.toISOString().slice(0, 10); // YYYY-MM-DD
}

function fixturesForToday() {
  const today = todayARTString();
  return WC_FIXTURES.filter(f => f.date === today);
}

async function validatePage(url, todayFixtures) {
  const issues = [];
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'GambetaFixturesValidator/1.0' } });
    if (!res.ok) {
      issues.push(`HTTP ${res.status}`);
      return { url, ok: false, issues };
    }
    const html = await res.text();
    
    // Check 1: La página debe mencionar al menos UNO de los partidos del día
    let mentionsAny = false;
    for (const f of todayFixtures) {
      // Buscar "Brasil vs Marruecos" / "Brasil - Marruecos" / "Brasil vs. Marruecos"
      const pattern = new RegExp(f.home + '.{0,8}vs.{0,8}' + f.away, 'i');
      const reverse = new RegExp(f.away + '.{0,8}vs.{0,8}' + f.home, 'i');
      if (pattern.test(html) || reverse.test(html)) {
        mentionsAny = true;
        break;
      }
    }
    if (!mentionsAny && todayFixtures.length > 0) {
      issues.push('No menciona ningún partido del día');
    }
    
    // Check 2: La página NO debe mencionar partidos VIEJOS (pasados) como si fueran hoy
    const now = todayARTString();
    const oldFixtures = WC_FIXTURES.filter(f => f.date < now);
    const recentOld = oldFixtures.slice(-6); // últimos 6 partidos pasados
    
    for (const f of recentOld) {
      // Si menciona pista de "HOY" + un partido pasado → alerta
      const matchPattern = new RegExp(`${f.home}.{0,30}vs.{0,30}${f.away}`, 'i');
      if (matchPattern.test(html)) {
        // ¿está cerca de "hoy" / "del día"?
        const idx = html.search(matchPattern);
        const ctx = html.substring(Math.max(0, idx - 200), idx + 200).toLowerCase();
        if (ctx.includes('del día') || ctx.includes('hoy') || ctx.includes('del dia')) {
          issues.push(`Menciona partido pasado ${f.home}-${f.away} (jugó ${f.date}) como si fuera de hoy`);
        }
      }
    }
    
  } catch (e) {
    issues.push('Error fetch: ' + e.message);
  }
  return { url, ok: issues.length === 0, issues };
}

async function sendAlert(env, results) {
  const failures = results.filter(r => !r.ok);
  if (failures.length === 0) return; // silencio si todo OK
  
  const today = todayARTString();
  const todayFixtures = fixturesForToday();
  
  let html = `<div style="font-family:sans-serif">
    <h2 style="color:#c0392b">🚨 Mismatch en partidos Mundial 2026 — ${today}</h2>
    <h3>Partidos REALES de hoy</h3>
    <ul>
      ${todayFixtures.map(f => `<li><b>${f.home} vs ${f.away}</b> · ${f.dayName} ${f.date} · ${f.time}</li>`).join('')}
    </ul>
    <h3>Problemas detectados</h3>
    <ul>`;
  for (const f of failures) {
    html += `<li><b>${f.url}</b><br>`;
    f.issues.forEach(i => { html += ` &nbsp;⚠️ ${i}<br>`; });
    html += '</li>';
  }
  html += `</ul>
    <p style="color:#999;font-size:11px">Worker: wc-fixtures-validator · Cron diario 07:00 ART</p>
  </div>`;
  
  if (!env.RESEND_API_KEY) {
    console.log('RESEND_API_KEY no configurada, alerta NO enviada:', failures);
    return;
  }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'alertas@gambeta.ai',
      to: ['mauro@gambeta.ai', 'pronosticosarg@gmail.com'],
      subject: `🚨 Mismatch fixtures Mundial — ${today}`,
      html
    })
  });
}

export default {
  async scheduled(event, env, ctx) {
    const todayFixtures = fixturesForToday();
    const results = await Promise.all(
      CRITICAL_PAGES.map(p => validatePage(p.url, todayFixtures))
    );
    await sendAlert(env, results);
    console.log('Validation results:', results);
  },
  
  // Endpoint manual de debug — GET /check
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/check') {
      const todayFixtures = fixturesForToday();
      const results = await Promise.all(
        CRITICAL_PAGES.map(p => validatePage(p.url, todayFixtures))
      );
      return new Response(JSON.stringify({
        today: todayARTString(),
        todayFixtures,
        results
      }, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('Use /check for manual validation', { status: 200 });
  }
};
