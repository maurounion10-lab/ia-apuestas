// 10 apuestas a futuro (outrights) Mundial 2026 — pre-torneo.
//
// PUBLICACIÓN AUTOMÁTICA: 6-jun-2026, 03:00 UTC (00:00 hora ART, 5 días antes del kickoff).
// Antes de esa fecha, runWcFuturesPublisher() no hace nada.
// Después, inserta los picks una sola vez en historial_full del admin.
//
// RESOLUCIÓN: manual. Cada pick se resuelve cuando termina su grupo/fase.
// El `commenceTs` apunta al kickoff del Mundial; el resolver normal NO los va a tocar
// porque el flag _wcFuture: true los excluye de la lógica automática (ver worker/index.js).
//
// Mix calibrado por Mauro: 3 ganadores de grupo + 2 clasifica + 2 stage + 1 dark horse
//                          + 1 outright winner + 1 top scorer.

export const WC_FUTURES_PUBLISH_TS = Date.UTC(2026, 5, 6, 3, 0, 0); // 6-jun-2026 03:00 UTC = 00:00 ART
export const WC_KICKOFF_TS         = Date.UTC(2026, 5, 11, 20, 0, 0); // 11-jun-2026 (referencia)
export const WC_FINAL_TS           = Date.UTC(2026, 6, 19, 20, 0, 0); // 19-jul-2026 (final)

export const WC_FUTURES = [
  // ─── 3 GANADORES DE GRUPO ─────────────────────────────────────────────
  {
    id: 'wc2026_groupwin_a_mex',
    home: 'México', away: 'Grupo A',
    rec: 'México gana el Grupo A',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.65, oddsFrozen: true,
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-24T00:00:00.000Z',
    commenceTs: WC_KICKOFF_TS,
    _sportKey: 'soccer_fifa_world_cup',
    _wcFuture: true, _wcType: 'group_winner', _wcGroup: 'A',
    insight: 'México llega como anfitrión con el ranking FIFA más alto del grupo (#15). Aguirre tiene plantel rodado, factor Azteca y un grupo accesible: Sudáfrica (#61), Corea del Sur (#22) y República Checa (#44). Riesgo principal: tropezón inaugural vs Sudáfrica como en 2010.',
  },
  {
    id: 'wc2026_groupwin_h_esp',
    home: 'España', away: 'Grupo H',
    rec: 'España gana el Grupo H',
    conf: 'high', bvr: 6, bvrText: 'Máxima',
    stake: 170, odds: 1.30, oddsFrozen: true,
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-25T00:00:00.000Z',
    commenceTs: WC_KICKOFF_TS,
    _sportKey: 'soccer_fifa_world_cup',
    _wcFuture: true, _wcType: 'group_winner', _wcGroup: 'H',
    insight: 'Campeona de la Euro 2024, racha invicta extendida y generación dorada (Yamal, Pedri, Rodri). Uruguay (#17) es 2do natural pero está dos escalones abajo en plantel actual. Cabo Verde y Arabia Saudita son aforo. Cuota baja pero es de las apuestas más sólidas del mercado.',
  },
  {
    id: 'wc2026_groupwin_j_arg',
    home: 'Argentina', away: 'Grupo J',
    rec: 'Argentina gana el Grupo J',
    conf: 'high', bvr: 6, bvrText: 'Máxima',
    stake: 170, odds: 1.40, oddsFrozen: true,
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-25T00:00:00.000Z',
    commenceTs: WC_KICKOFF_TS,
    _sportKey: 'soccer_fifa_world_cup',
    _wcFuture: true, _wcType: 'group_winner', _wcGroup: 'J',
    insight: 'Defensora del título con núcleo 2022 intacto + Messi en última danza. Argelia, Austria y Jordania son rivales muy por debajo en ranking y plantel. Scaloni rota pero Argentina barre el grupo. Es de los picks más previsibles del torneo.',
  },

  // ─── 2 CLASIFICA DE GRUPO ─────────────────────────────────────────────
  {
    id: 'wc2026_qualify_b_can',
    home: 'Canadá', away: 'Grupo B',
    rec: 'Canadá clasifica del Grupo B',
    conf: 'med', bvr: 4, bvrText: 'Media-Alta',
    stake: 50, odds: 1.80, oddsFrozen: true,
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-25T00:00:00.000Z',
    commenceTs: WC_KICKOFF_TS,
    _sportKey: 'soccer_fifa_world_cup',
    _wcFuture: true, _wcType: 'qualify', _wcGroup: 'B',
    insight: 'Co-anfitrión jugando en casa. Davies, Jonathan David y Buchanan son nivel Europa top. Grupo accesible con Suiza (#19) como única amenaza real; Bosnia (#65) y Qatar (#55) son trámite. Pasar de grupo es escenario muy probable; cuota 1.80 ofrece value para el sentimiento norteamericano.',
  },
  {
    id: 'wc2026_qualify_h_uru',
    home: 'Uruguay', away: 'Grupo H',
    rec: 'Uruguay clasifica del Grupo H',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.30, oddsFrozen: true,
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-25T00:00:00.000Z',
    commenceTs: WC_KICKOFF_TS,
    _sportKey: 'soccer_fifa_world_cup',
    _wcFuture: true, _wcType: 'qualify', _wcGroup: 'H',
    insight: 'Bielsa tiene una generación brillante: Núñez, Valverde, Araújo, Bentancur, Pellistri. España es inalcanzable como #1 pero el #2 está prácticamente firmado: Cabo Verde y Arabia Saudita están años atrás. Cuota baja porque es casi un trámite.',
  },

  // ─── 2 STAGE OF ELIMINATION ───────────────────────────────────────────
  {
    id: 'wc2026_stage_arg_semis',
    home: 'Argentina', away: 'Semifinales',
    rec: 'Argentina llega a Semifinales',
    conf: 'med', bvr: 4, bvrText: 'Media-Alta',
    stake: 50, odds: 2.50, oddsFrozen: true,
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-07-15T00:00:00.000Z',
    commenceTs: WC_KICKOFF_TS,
    _sportKey: 'soccer_fifa_world_cup',
    _wcFuture: true, _wcType: 'stage_reach', _wcStage: 'semis',
    insight: 'Campeona vigente con bracket favorable: gana Grupo J y evita cruces top hasta cuartos. Tiene el plantel, el DT (Scaloni) y la confianza. Riesgo real recién en cuartos contra una potencia europea, pero llegar a semis es escenario probable con probabilidad ~40%.',
  },
  {
    id: 'wc2026_stage_mar_qf',
    home: 'Marruecos', away: 'Cuartos de Final',
    rec: 'Marruecos llega a Cuartos de Final',
    conf: 'med', bvr: 4, bvrText: 'Media-Alta',
    stake: 50, odds: 4.50, oddsFrozen: true,
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-07-10T00:00:00.000Z',
    commenceTs: WC_KICKOFF_TS,
    _sportKey: 'soccer_fifa_world_cup',
    _wcFuture: true, _wcType: 'stage_reach', _wcStage: 'quarters',
    insight: 'Semifinalista en Qatar 2022 con el MISMO núcleo: Hakimi, Ziyech, En-Nesyri, Bounou. Está en grupo difícil (Brasil, Escocia, Haití) pero su DT Regragui mantiene la estructura defensiva que ya dio resultado. Cuota 4.50 es generosa para un equipo con experiencia de eliminatoria FIFA.',
  },

  // ─── 1 DARK HORSE ─────────────────────────────────────────────────────
  {
    id: 'wc2026_stage_nor_r16',
    home: 'Noruega', away: 'Octavos de Final',
    rec: 'Noruega llega a Octavos de Final',
    conf: 'med', bvr: 4, bvrText: 'Media-Alta',
    stake: 50, odds: 2.20, oddsFrozen: true,
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-07-04T00:00:00.000Z',
    commenceTs: WC_KICKOFF_TS,
    _sportKey: 'soccer_fifa_world_cup',
    _wcFuture: true, _wcType: 'stage_reach', _wcStage: 'r16',
    insight: 'Primer Mundial con Haaland + Odegaard juntos en su pico. Grupo I es top-heavy (Francia favorita) pero el segundo puesto está abierto: Noruega pelea de igual a igual con Senegal y Irak es trámite. Si pasa de grupo, está en octavos. Hot take con base sólida: este Haaland en cita FIFA es novedad histórica.',
  },

  // ─── 1 OUTRIGHT WINNER ─────────────────────────────────────────────────
  {
    id: 'wc2026_champion_esp',
    home: 'España', away: 'Campeón Mundial 2026',
    rec: 'España gana el Mundial 2026',
    conf: 'med', bvr: 4, bvrText: 'Media-Alta',
    stake: 50, odds: 5.50, oddsFrozen: true,
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-07-19T20:00:00.000Z',
    commenceTs: WC_KICKOFF_TS,
    _sportKey: 'soccer_fifa_world_cup',
    _wcFuture: true, _wcType: 'tournament_winner',
    insight: 'Favorita del mercado. Campeona de Euro 2024 con racha invicta récord, generación dorada en pico (Yamal 18, Pedri 23, Rodri 29) y plantilla balanceada en todas las posiciones. De la Fuente tiene equipo, sistema y zaga sólida. Cuota 5.50 paga bien para el favorito real.',
  },

  // ─── 1 TOP SCORER ──────────────────────────────────────────────────────
  {
    id: 'wc2026_topscorer_mbappe',
    home: 'Kylian Mbappé', away: 'Bota de Oro',
    rec: 'Mbappé es el goleador del Mundial 2026',
    conf: 'med', bvr: 4, bvrText: 'Media-Alta',
    stake: 50, odds: 5.00, oddsFrozen: true,
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-07-19T20:00:00.000Z',
    commenceTs: WC_KICKOFF_TS,
    _sportKey: 'soccer_fifa_world_cup',
    _wcFuture: true, _wcType: 'top_scorer',
    insight: 'Francia es candidata real al título y Mbappé es el cobrador de penales y el referente ofensivo. En 2022 hizo 8 goles y ganó el botín. A los 27 años sigue en pico físico y técnico. Riesgos: Haaland, Vinicius y Harry Kane también pelean, pero ninguno tiene la combinación Mbappé = "selección favorita + cobrador de penales + bracket largo".',
  },
];

// Sanity check
if (WC_FUTURES.length !== 10) {
  throw new Error(`Expected 10 WC futures, got ${WC_FUTURES.length}`);
}
