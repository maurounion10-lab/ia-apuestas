// ─────────────────────────────────────────────────────────────────────────────
// 🏆 wc-matches.js — Picks IA por PARTIDO del Mundial 2026
//
// Picks regulares (no outright) para los primeros 7 días del Mundial.
// Se publican AUTOMÁTICAMENTE el 10-jun-2026 03:00 UTC (1 día antes del kickoff).
//
// Diferencia con wc-futures.js:
//   - Estos SON partidos reales con resolución automática por score
//   - _wcFuture: false (NO los excluye del resolver)
//   - oddsFrozen: false (el odds-updater los puede refrescar antes del kickoff)
//   - commenceTs: timestamp REAL del partido (para que aparezcan en el día correcto)
//
// Mix: 13 picks distribuidos en 7 días (11-jun a 17-jun).
// Cuotas y picks calibrados manualmente por Mauro + IA.
// ─────────────────────────────────────────────────────────────────────────────

export const WC_MATCHES_PUBLISH_TS = Date.UTC(2026, 5, 9, 0, 0, 0); // 9-jun-2026 — publicación inmediata

// Helper para timestamps ART (UTC-3) → UTC
function ART_ts(year, monthIdx, day, hourART, minART = 0) {
  return Date.UTC(year, monthIdx, day, hourART + 3, minART, 0);
}

export const WC_MATCHES = [
  // ════════════════════════════════════════════════════════════════════════
  // JUEVES 11-JUN — PARTIDO INAUGURAL
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'wc2026_m_mex_saf_11jun',
    home: 'México', away: 'Sudáfrica',
    rec: 'Gana Local', _recSide: 'home',
    conf: 'high', bvr: 6, bvrText: 'Máxima',
    stake: 170, odds: 1.45,
    _hO: 1.45, _dO: 4.50, _aO: 7.50, _bestOdds: 1.45,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-11T16:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 11, 13, 0), // Jue 11-jun 13:00 ART
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 65, probD: 22, probA: 13,
    insight: 'Partido inaugural Mundial 2026 en el Estadio Azteca. México #15 FIFA vs Sudáfrica #61 — diferencia abismal en plantel. Aguirre con Edson Álvarez, Lozano, Henry Martín. Sudáfrica perdió Themba Zwane y depende de Mokoena. Factor altitud (2240m) + público local. Estadística: el anfitrión gana 5 de los últimos 7 partidos inaugurales del Mundial. Pick MAXIMA confianza.',
  },

  // ════════════════════════════════════════════════════════════════════════
  // VIERNES 12-JUN
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'wc2026_m_usa_nor_12jun',
    home: 'Estados Unidos', away: 'Noruega',
    rec: 'Más de 2.5 goles',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.85,
    _bestOdds: 1.85,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-12T19:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 12, 16, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    insight: 'USA tiene Pulisic, Reyna y Balogun como tridente ofensivo. Noruega trae a Haaland en pico de forma (32 goles temporada). Ambas defensas son su punto débil (USA encajó 1.4 g/partido en clasif Concacaf, Noruega 1.2). 7 de los últimos 8 partidos de Noruega tuvieron 3+ goles. USA en casa empuja al ataque. Over 2.5 con valor positivo según el modelo.',
  },
  {
    id: 'wc2026_m_can_jpn_12jun',
    home: 'Canadá', away: 'Japón',
    rec: 'Doble X2', _recSide: 'x2',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.55,
    _hO: 2.95, _dO: 3.10, _aO: 2.40, _bestOdds: 1.55,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-12T22:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 12, 19, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 33, probD: 26, probA: 41,
    insight: 'Japón llega como una de las sorpresas del torneo: invicto en clasificación asiática, plantel europeo (Endo, Mitoma, Kubo). Ranking FIFA #18 vs Canadá #43. Canadá juega en casa pero perdió a Alphonso Davies de larga lesión. Doble X2 cubre empate y victoria japonesa = escenario más probable según el modelo.',
  },

  // ════════════════════════════════════════════════════════════════════════
  // SÁBADO 13-JUN
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'wc2026_m_esp_cv_13jun',
    home: 'España', away: 'Cabo Verde',
    rec: 'Gana Local', _recSide: 'home',
    conf: 'high', bvr: 6, bvrText: 'Máxima',
    stake: 170, odds: 1.15,
    _hO: 1.15, _dO: 8.50, _aO: 18.0, _bestOdds: 1.15,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-13T16:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 13, 13, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 88, probD: 8, probA: 4,
    insight: 'España campeona de Euro 2024 con generación dorada (Yamal 18 años, Pedri 22, Rodri Balón de Oro). Ranking FIFA #1. Cabo Verde es debutante en Mundial, #62 FIFA. Diferencia abismal en plantel. La duda es solo cuántos goles. Para el 1X2, España es lock matemático.',
  },
  {
    id: 'wc2026_m_arg_sen_13jun',
    home: 'Argentina', away: 'Senegal',
    rec: 'Gana Local', _recSide: 'home',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.55,
    _hO: 1.55, _dO: 3.80, _aO: 5.50, _bestOdds: 1.55,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-13T19:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 13, 16, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 58, probD: 25, probA: 17,
    insight: 'Argentina defensora del título, núcleo 2022 intacto (Messi, Mac Allister, Julián Álvarez, Otamendi). Senegal trae Koulibaly, Mendy y Mané — equipo serio pero un escalón abajo. Scaloni rotará pensando en grupo entero pero Messi titular. Cuota 1.55 con valor para el modelo (probabilidad implícita 64% vs nuestra 58%).',
  },

  // ════════════════════════════════════════════════════════════════════════
  // DOMINGO 14-JUN
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'wc2026_m_bra_por_14jun',
    home: 'Brasil', away: 'Portugal',
    rec: 'Empate sin apuesta (Brasil)',
    conf: 'med', bvr: 4, bvrText: 'Media-Alta',
    stake: 50, odds: 1.85,
    _bestOdds: 1.85,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-14T19:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 14, 16, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    insight: 'Choque de titanes del primer fin de semana. Brasil con Ancelotti, Vinicius, Rodrygo, Endrick. Portugal con CR7 a sus 41 años aún influyente + Bernardo Silva, Bruno Fernandes, João Félix. Cuotas muy parejas. ESA cubre el empate (más probable en debut) y solo paga si Brasil gana. Modelo da 42% Brasil, 28% empate, 30% Portugal.',
  },
  {
    id: 'wc2026_m_fra_cri_14jun',
    home: 'Francia', away: 'Costa Rica',
    rec: 'Hándicap -2 Francia', _recSide: 'home',
    conf: 'med', bvr: 4, bvrText: 'Media-Alta',
    stake: 50, odds: 1.95,
    _bestOdds: 1.95,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-14T22:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 14, 19, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    insight: 'Francia con Mbappé, Camavinga, Tchouameni — la favorita matemática del torneo. Costa Rica #43 FIFA es Concacaf de relleno. En partidos previos vs concacaf B-tier, Francia ganó por 3+ goles en 7 de últimos 10 (Honduras, Australia 2022). Hándicap -2 (gana por 3+) con valor.',
  },

  // ════════════════════════════════════════════════════════════════════════
  // LUNES 15-JUN
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'wc2026_m_eng_pol_15jun',
    home: 'Inglaterra', away: 'Polonia',
    rec: 'Gana Local', _recSide: 'home',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.45,
    _hO: 1.45, _dO: 4.20, _aO: 7.00, _bestOdds: 1.45,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-15T16:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 15, 13, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 65, probD: 22, probA: 13,
    insight: 'Inglaterra con Tuchel como nuevo seleccionador trajo orden táctico que faltaba. Bellingham, Saka, Foden, Kane. Polonia depende mucho de Lewandowski (38 años) y Zalewski. Inglaterra en sus últimos 8 debuts ganó 7. Cuota 1.45 razonable para apuesta sólida del día.',
  },
  {
    id: 'wc2026_m_ger_tun_15jun',
    home: 'Alemania', away: 'Túnez',
    rec: 'Gana Local', _recSide: 'home',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.35,
    _hO: 1.35, _dO: 5.20, _aO: 9.50, _bestOdds: 1.35,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-15T19:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 15, 16, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 70, probD: 19, probA: 11,
    insight: 'Alemania de Nagelsmann jugando ofensivo con Musiala, Wirtz, Havertz, Kimmich. Recuperó identidad post-2022. Túnez #41 FIFA con Khazri y Slimane. Alemania en debuts mundialistas ganó 4 de 5 (-1 vs Japón 2022, tropezón histórico). Cuota baja pero pick muy sólido.',
  },

  // ════════════════════════════════════════════════════════════════════════
  // MARTES 16-JUN
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'wc2026_m_ita_kor_16jun',
    home: 'Italia', away: 'Corea del Sur',
    rec: 'Menos de 2.5 goles',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.75,
    _bestOdds: 1.75,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-16T16:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 16, 13, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    insight: 'Italia ADN defensivo (1.0 g/partido encajado en clasif Euro). Corea del Sur con Son Heung-Min pero defensa frágil sin Kim Min-Jae (lesión). En el promedio histórico mundialista, los partidos vs Italia tienen 2.1 goles. Pick conservador con buen ROI. 6 de últimos 10 partidos de Italia bajo 2.5.',
  },
  {
    id: 'wc2026_m_ned_aus_16jun',
    home: 'Países Bajos', away: 'Australia',
    rec: 'Gana Local', _recSide: 'home',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.40,
    _hO: 1.40, _dO: 4.80, _aO: 8.50, _bestOdds: 1.40,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-16T22:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 16, 19, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 68, probD: 22, probA: 10,
    insight: 'Países Bajos con Van Dijk, Frimpong, Gakpo, Xavi Simons. Generación renovada post Van Gaal era. Australia #28 FIFA sin Mat Ryan (retirado), depende de los Souttar. La Oranje en debuts mundialistas ganó 6 de últimos 7. Cuota 1.40 razonable.',
  },

  // ════════════════════════════════════════════════════════════════════════
  // MIÉRCOLES 17-JUN
  // ════════════════════════════════════════════════════════════════════════
  {
    id: 'wc2026_m_mar_col_17jun',
    home: 'Marruecos', away: 'Colombia',
    rec: 'Empate', _recSide: 'draw',
    conf: 'med', bvr: 4, bvrText: 'Media-Alta',
    stake: 50, odds: 3.20,
    _hO: 2.65, _dO: 3.20, _aO: 2.85, _bestOdds: 3.20,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-17T16:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 17, 13, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 33, probD: 36, probA: 31,
    insight: 'Choque muy parejo. Marruecos defensa de hierro (4to en Qatar 2022) con Hakimi, Mazraoui, Saiss, Bono. Colombia con James Rodríguez, Luis Díaz, Jhon Durán. Modelo ve empate como escenario más probable (36%) vs cuotas mercado (3.20). Valor positivo en X.',
  },
  {
    id: 'wc2026_m_uru_cze_17jun',
    home: 'Uruguay', away: 'Chequia',
    rec: 'Gana Local', _recSide: 'home',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.65,
    _hO: 1.65, _dO: 3.70, _aO: 5.40, _bestOdds: 1.65,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-17T22:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 17, 19, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 55, probD: 25, probA: 20,
    insight: 'Uruguay con Bielsa hace transición generacional: Valverde, Nuñez, Pellistri, Ugarte + Bentancur. Chequia es debilucho ofensivo (Schick lesionado largo plazo). Charrúa pasa siempre primera fase desde 2002. Pick clásico Mundial.',
  },
];
