// ─────────────────────────────────────────────────────────────────────────────
// 🏆 wc-matches.js — Picks IA por PARTIDO del Mundial 2026
//
// Calendario oficial Mundial 2026 (sorteo FIFA 5-dic-2025, Washington DC).
// Picks regulares (no outright) para los primeros 7 días del Mundial.
// ─────────────────────────────────────────────────────────────────────────────

export const WC_MATCHES_PUBLISH_TS = Date.UTC(2026, 5, 9, 0, 0, 0); // publicación inmediata

function ART_ts(year, monthIdx, day, hourART, minART = 0) {
  return Date.UTC(year, monthIdx, day, hourART + 3, minART, 0);
}

// GRUPOS OFICIALES:
// A: México, Sudáfrica, Corea del Sur, República Checa
// B: Canadá, Bosnia, Catar, Suiza
// C: Brasil, Marruecos, Haití, Escocia
// D: Estados Unidos, Paraguay, Australia, Turquía
// E: Alemania, Curaçao, Costa de Marfil, Ecuador
// F: Países Bajos, Japón, Suecia, Túnez
// G: Bélgica, Egipto, Irán, Nueva Zelanda
// H: España, Cabo Verde, Arabia Saudita, Uruguay
// I: Francia, Senegal, Irak, Noruega
// J: Argentina, Argelia, Austria, Jordania
// K: Portugal, RD Congo, Uzbekistán, Colombia
// L: Inglaterra, Croacia, Ghana, Panamá

export const WC_MATCHES = [
  // ════ JUE 11-JUN — GRUPO A (INAUGURAL) ════
  {
    id: 'wc2026_a1_mex_saf_11jun',
    home: 'México', away: 'Sudáfrica',
    rec: 'Gana Local', _recSide: 'home',
    conf: 'high', bvr: 6, bvrText: 'Máxima',
    stake: 170, odds: 1.45,
    _hO: 1.45, _dO: 4.50, _aO: 7.50, _bestOdds: 1.45,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-11T16:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 11, 13, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 65, probD: 22, probA: 13,
    insight: 'Partido INAUGURAL del Mundial 2026 en el Estadio Azteca. México (#15 FIFA) anfitrión vs Sudáfrica (#61), debutante tras 16 años de ausencia. Aguirre con Edson Álvarez, Hirving Lozano y Henry Martín. Sudáfrica depende de Mokoena y Foster. Factor altitud (2240m) + público local + estadística: el anfitrión gana 5 de los últimos 7 partidos inaugurales del Mundial. Pick MÁXIMA confianza.',
  },

  // ════ VIE 12-JUN — GRUPO B + GRUPO D (debut anfitriones Canadá y USA) ════
  {
    id: 'wc2026_b1_can_bih_12jun',
    home: 'Canadá', away: 'Bosnia',
    rec: 'Doble 1X', _recSide: '1x',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.55,
    _hO: 2.20, _dO: 3.10, _aO: 3.30, _bestOdds: 1.55,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-12T19:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 12, 16, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 42, probD: 31, probA: 27,
    insight: 'Canadá co-anfitrión hace debut en casa (BMO Field Toronto). Sin Alphonso Davies (lesión larga) pero con Jonathan David, Buchanan y Larin. Bosnia clasificó tras 12 años eliminando a Italia en repechaje — equipo en racha y con Edin Džeko aún influyente. Doble 1X cubre victoria local o empate = escenario más probable.',
  },
  {
    id: 'wc2026_d1_usa_par_12jun',
    home: 'Estados Unidos', away: 'Paraguay',
    rec: 'Más de 2.5 goles',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.85,
    _bestOdds: 1.85,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-12T23:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 12, 20, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    insight: 'USA co-anfitrión debuta en casa (SoFi Stadium LA). Trío Pulisic-Reyna-Balogun garantiza ataque. Paraguay regresa al Mundial tras 16 años con Almirón, Antony Silva y Sosa — equipo ofensivo. Defensas medias en ambos lados. Over 2.5 con valor positivo: 7 de últimos 10 partidos de Paraguay tuvieron 3+ goles.',
  },

  // ════ SÁB 13-JUN — GRUPO C ════
  {
    id: 'wc2026_c1_bra_mar_13jun',
    home: 'Brasil', away: 'Marruecos',
    rec: 'Empate sin apuesta (Brasil)',
    conf: 'med', bvr: 4, bvrText: 'Media-Alta',
    stake: 50, odds: 1.80,
    _bestOdds: 1.80,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-13T19:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 13, 16, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    insight: 'CHOQUE TITÁNICO. Brasil con Ancelotti, Vinicius, Rodrygo, Endrick — renovación generacional. Marruecos viene de 4to puesto en Qatar 2022 (Hakimi, Mazraoui, Saiss, Bono). Cuotas parejas en debut. ESA cubre el empate (escenario muy probable en debuts) y solo paga si Brasil gana. Modelo da 42% Brasil, 30% empate, 28% Marruecos.',
  },

  // ════ DOM 14-JUN — GRUPO E + GRUPO F ════
  {
    id: 'wc2026_e1_ger_cur_14jun',
    home: 'Alemania', away: 'Curaçao',
    rec: 'Gana Local', _recSide: 'home',
    conf: 'high', bvr: 6, bvrText: 'Máxima',
    stake: 170, odds: 1.18,
    _hO: 1.18, _dO: 7.50, _aO: 15.0, _bestOdds: 1.18,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-14T16:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 14, 13, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 86, probD: 9, probA: 5,
    insight: 'Alemania de Nagelsmann recuperó identidad ofensiva con Musiala, Wirtz, Havertz, Kimmich. Vs Curaçao (#82 FIFA), debutante absoluto del Caribe, jugando ¡su primer partido Mundial de la historia! Diferencia abismal en plantel y experiencia. Cuota baja pero lock matemático.',
  },
  {
    id: 'wc2026_f1_ned_jpn_14jun',
    home: 'Países Bajos', away: 'Japón',
    rec: 'Doble 1X', _recSide: '1x',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.40,
    _hO: 1.85, _dO: 3.50, _aO: 4.20, _bestOdds: 1.40,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-14T22:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 14, 19, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 50, probD: 28, probA: 22,
    insight: 'Países Bajos con Van Dijk, Frimpong, Gakpo, Xavi Simons — generación renovada post Van Gaal. Japón #18 FIFA con plantel europeo elite (Endo, Mitoma, Kubo, Mt Itakura) — recordemos que ganó a Alemania y España en Qatar. Doble 1X cubre empate y victoria Oranje = escenario más probable según modelo.',
  },

  // ════ LUN 15-JUN — GRUPO G + GRUPO H ════
  {
    id: 'wc2026_g1_bel_egy_15jun',
    home: 'Bélgica', away: 'Egipto',
    rec: 'Gana Local', _recSide: 'home',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.55,
    _hO: 1.55, _dO: 3.70, _aO: 5.80, _bestOdds: 1.55,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-15T16:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 15, 13, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 56, probD: 25, probA: 19,
    insight: 'Bélgica con relevo generacional: De Bruyne capitán, Lukaku, Doku, Tielemans, Onana. Egipto regresa al Mundial tras ausencia 2022 con Salah, Trezeguet, Mohamed. Bélgica favorito claro pero Egipto siempre incómodo. Pick sólido sin sorpresas.',
  },
  {
    id: 'wc2026_h1_esp_cv_15jun',
    home: 'España', away: 'Cabo Verde',
    rec: 'Gana Local', _recSide: 'home',
    conf: 'high', bvr: 6, bvrText: 'Máxima',
    stake: 170, odds: 1.15,
    _hO: 1.15, _dO: 8.50, _aO: 18.0, _bestOdds: 1.15,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-15T22:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 15, 19, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 88, probD: 8, probA: 4,
    insight: 'España campeona Euro 2024 con generación dorada: Lamine Yamal (18 años), Pedri (22), Rodri (Balón de Oro), Nico Williams. Ranking FIFA #1. Cabo Verde debutante absoluto #68 FIFA. Diferencia abismal. La única duda: cuántos goles. Lock matemático.',
  },

  // ════ MAR 16-JUN — GRUPO I + GRUPO J ════
  {
    id: 'wc2026_i1_fra_sen_16jun',
    home: 'Francia', away: 'Senegal',
    rec: 'Gana Local', _recSide: 'home',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.55,
    _hO: 1.55, _dO: 4.10, _aO: 5.50, _bestOdds: 1.55,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-16T16:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 16, 13, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 60, probD: 23, probA: 17,
    insight: 'Francia favorita matemática al título con Mbappé, Camavinga, Tchouameni — equipo más completo del torneo. Senegal trae Koulibaly, Mendy, Mané — campeón de África 2022. Senegal incómodo pero Francia un escalón arriba. Cuota 1.55 con valor positivo.',
  },
  {
    id: 'wc2026_j1_arg_alg_16jun',
    home: 'Argentina', away: 'Argelia',
    rec: 'Gana Local', _recSide: 'home',
    conf: 'high', bvr: 6, bvrText: 'Máxima',
    stake: 170, odds: 1.32,
    _hO: 1.32, _dO: 5.20, _aO: 8.50, _bestOdds: 1.32,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-16T22:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 16, 19, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 76, probD: 16, probA: 8,
    insight: 'Argentina DEFENSORA DEL TÍTULO con núcleo 2022 intacto: Messi, Mac Allister, Julián Álvarez, Otamendi, Dibu Martínez. Argelia #41 FIFA con Mahrez como única estrella. Diferencia clara de nivel y experiencia. Scaloni rotará pero pondrá a Messi. Pick MÁXIMA confianza para la apertura del Grupo J.',
  },

  // ════ MIÉ 17-JUN — GRUPO K + GRUPO L ════
  {
    id: 'wc2026_k1_por_drc_17jun',
    home: 'Portugal', away: 'RD Congo',
    rec: 'Gana Local', _recSide: 'home',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.40,
    _hO: 1.40, _dO: 4.80, _aO: 7.50, _bestOdds: 1.40,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-17T16:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 17, 13, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    probH: 68, probD: 20, probA: 12,
    insight: 'Portugal con Cristiano (41 años, última danza), Bernardo Silva, Bruno Fernandes, Rúben Dias, Vitinha. Roberto Martínez como técnico. RD Congo regresa al Mundial tras 50 años de ausencia — equipo histórico pero plantel mucho menor. Diferencia clara.',
  },
  {
    id: 'wc2026_l1_eng_cro_17jun',
    home: 'Inglaterra', away: 'Croacia',
    rec: 'Más de 2.5 goles',
    conf: 'high', bvr: 5, bvrText: 'Alta',
    stake: 130, odds: 1.95,
    _bestOdds: 1.95,
    _bookKey: 'dbbet', _bookLabel: 'DBbet',
    result: 'pending',
    league: '🏆 Mundial 2026',
    date: '2026-06-17T22:00:00.000Z',
    commenceTs: ART_ts(2026, 5, 17, 19, 0),
    _sportKey: 'soccer_fifa_world_cup',
    _wcMatch: true,
    insight: 'CHOQUE DE TITANES. Inglaterra con Tuchel: Bellingham, Saka, Foden, Kane, Rice — talento ofensivo brutal. Croacia con Modrić retirado pero con Sucic, Kovacic, Petković. Repetición de la semifinal Rusia 2018. Ambos juegan ofensivo. 6 de últimos 10 partidos entre ambos tuvieron 3+ goles. Over 2.5 con valor.',
  },
];
