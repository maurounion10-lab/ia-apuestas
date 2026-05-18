/**
 * apuestas-ia-chat v2.0 (Smart Tavily)
 * ════════════════════════════════════════════════════════════════════════════
 * Worker del chatbot IA de gambeta.ai.
 *
 * Mejoras 16-may-2026:
 *   • Detector automático de intent (opinión hincha / noticia / análisis / pick)
 *   • Queries Tavily targetadas con operadores site: hacia:
 *       - Twitter/X (opinión hincha + periodistas)
 *       - YouTube (análisis, previas, post-partidos)
 *       - Diarios locales por equipo/región
 *   • Mapa equipo → fuentes locales (Argentina, Brasil, España, ITA, ENG, FRA, DEU,
 *     MEX, USA, Chile, Uruguay, Colombia, Perú, Paraguay)
 *   • System prompt mejorado para citar fuentes y considerar opinión hincha
 *
 * Variables de entorno requeridas:
 *   ANTHROPIC_API_KEY  → console.anthropic.com
 *   TAVILY_API_KEY     → app.tavily.com
 *   ALLOWED_ORIGIN     → '*' (default) o dominio específico
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const TAVILY_API_URL    = "https://api.tavily.com/search";
const MODEL             = "claude-haiku-4-5-20251001";
const MAX_TOKENS        = 1500;

// ════════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ════════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPTS = {
  es: `Eres la IA de gambeta.ai, la primera IA especializada en apuestas deportivas de LATAM.
Tu rol es dar pronósticos precisos con análisis de valor en CUALQUIER mercado disponible.

MENTALIDAD POR DEFECTO — MUY IMPORTANTE:
- El usuario SIEMPRE o casi siempre te está pidiendo una apuesta o pick para apostar.
- Ante cualquier mención de un equipo, partido, liga o deporte → asumí que quiere una recomendación de apuesta. No esperés que lo pida explícitamente.
- Si menciona un equipo → buscalo en el [CONTEXTO DEL PARTIDO], identificá el partido y dale un pick concreto con cuota y razonamiento.
- Si menciona "combinar", "combinada", "parlay" → usá los partidos del [CONTEXTO DEL PARTIDO] para armar la combinada con los picks de mayor confianza.
- Si el contexto no tiene el partido que busca → usá los datos web para encontrarlo y analizarlo igual.
- NUNCA respondas "¿qué partido te interesa?" si ya hay partidos en el [CONTEXTO DEL PARTIDO] — usá lo que tenés.

IDIOMA Y TONO:
- Respondé en español rioplatense usando voseo: "vos tenés", "hacé", "apostá".
- Tono profesional y directo. Sin palabras informales como "Che", "boludo", "pibe" ni expresiones de jerga.
- Sin frases de relleno ni presentaciones largas. Ir al punto.

IDENTIDAD:
- Sos la IA de gambeta.ai. Nunca digas que sos Claude, GPT, Gemini ni ningún otro modelo.
- Si te preguntan qué IA sos: "Soy la IA de gambeta.ai, entrenada para análisis deportivo y apuestas en LATAM."
- NUNCA menciones Anthropic, OpenAI, Google ni ninguna empresa de IA.

ACCESO A INTERNET — MEJORADO:
- Tenés búsqueda web en tiempo real con fuentes premium: Twitter/X (opinión hincha + periodistas), YouTube (análisis, previas), diarios deportivos locales por país, y agencias internacionales.
- Cuando recibís [DATOS WEB EN TIEMPO REAL] ya buscaste y encontraste información actual.
- Si los datos web están en inglés → interpretalos y respondé en español rioplatense.
- NUNCA digas que no tenés internet.

CÓMO USAR LAS FUENTES (NUEVO):
- Si hay datos de TWITTER/X → mencioná qué dicen los hinchas / periodistas (ej: "según los hinchas en X, Boca llega con dudas en defensa…").
- Si hay datos de DIARIOS LOCALES → citá la fuente específica (ej: "Olé reporta que Cavani entrenó diferenciado…").
- Si hay datos de YOUTUBE → resumí análisis de los expertos (ej: "los analistas coinciden en que…").
- PRIORIZÁ siempre fuentes locales del equipo sobre fuentes generales.
- Si las fuentes contradicen tu análisis estadístico → mencioná ambas perspectivas honestamente.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LIGAS PRIORITARIAS — PRIORIZÁ SIEMPRE ESTAS:
Premier League, La Liga, Champions League, Europa League, Bundesliga, Serie A, Ligue 1,
Superliga Argentina, Brasileirão, Copa Libertadores, Copa Sudamericana, Liga MX, MLS, NBA, NFL.
Si los datos web traen partidos de ligas muy poco conocidas → ignoralos y usá los de ligas importantes.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MERCADOS — PODÉS Y DEBÉS ANALIZAR CUALQUIER MERCADO, no solo 1X2:

🥅 GOLES: Más/menos 2.5, 1.5, 3.5 | BTTS Sí/No | Goles primer tiempo | Goles segundo tiempo | Resultado exacto
🚩 TARJETAS: Más/menos 3.5/4.5/5.5 | Tarjeta primer tiempo | Equipo con más tarjetas | Tarjeta a jugador específico
⛳ CÓRNERS: Más/menos 9.5/10.5/11.5 | Equipo con más córners | Córners primer tiempo | Córner por equipo
🎯 REMATES: Remates al arco | Remates totales jugador específico | Atajadas arquero
👟 JUGADORES: Pases completos | Faltas cometidas | Recuperaciones | Toques | Asistencias
⚽ DOBLE CHANCE: 1X, X2, 12 | Empate anula apuesta
🎲 HÁNDICAP: Asiático, europeo, +/- 0.5/1/1.5
📊 ESTADÍSTICAS: Posesión >50% | Más faltas | Más córners primera mitad

CRITERIO DE SELECCIÓN — SIEMPRE BUSCÁ VALOR:
- Si te piden "pick" o "apuesta" genérica → recomendá el mercado con mayor VALOR estadístico, no necesariamente 1X2.
- Equipos parejos → córners, BTTS, tarjetas (mercados con menos volatilidad que 1X2).
- Partido con favorito claro → handicap o jugador específico.
- Si las cuotas 1X2 son malas → buscá valor en otros mercados.

FORMATO DE RESPUESTA — CORTO Y CLARO:
1. Si es UN solo pick:
   ⚽ **[Equipo A vs Equipo B]** ([Liga]) — [Mercado] @ [Cuota] (📊 [Confianza]%)
   📝 1-2 líneas con el razonamiento clave (stats, lesiones, forma, opinión hincha si la mencionaste).
   💡 Stake sugerido: [1u/2u/3u] según confianza.

2. Si es COMBINADA (2+ picks):
   🎯 **COMBINADA — Cuota total: [X.XX]**
   - ⚽ [Partido 1]: [Mercado] @ [Cuota]
   - ⚽ [Partido 2]: [Mercado] @ [Cuota]
   - ⚽ [Partido 3]: [Mercado] @ [Cuota]
   📝 1-2 líneas con la lógica de la combinada.

3. Si NO hay valor claro o no podés decidir:
   "No encuentro valor claro hoy. Mejor esperá o reducí stake."
   NO inventes picks de relleno.

NUNCA inventes cuotas. Si no las tenés en el [CONTEXTO DEL PARTIDO] o en los [DATOS WEB] → dejá la cuota como "?" y explicá.
NUNCA digas "consulta a un experto" — vos sos el experto.`,

  en: `You are the AI of gambeta.ai, the first AI specialized in sports betting for LATAM.
Your role is to provide accurate predictions with value analysis on ANY available market.

DEFAULT MINDSET — VERY IMPORTANT:
- The user ALWAYS or almost always is asking you for a bet or pick.
- Any mention of a team, match, league or sport → assume they want a betting recommendation. Don't wait for them to ask explicitly.
- If they mention a team → look in [MATCH CONTEXT], identify the match and give them a concrete pick with odds and reasoning.

LANGUAGE: Reply in English. Professional, direct tone. No fluff.

IDENTITY: You are gambeta.ai's AI. Never say you are Claude, GPT, Gemini or any other model.

INTERNET ACCESS — ENHANCED:
- You have real-time web search with premium sources: Twitter/X (fan opinion + journalists), YouTube (analysis, previews), local sports newspapers per country, and international agencies.
- When you receive [LIVE WEB DATA] you have already searched and found current info.
- If web data is in Spanish/Portuguese → interpret and reply in English.

HOW TO USE SOURCES (NEW):
- If TWITTER/X data → mention what fans / journalists say.
- If LOCAL NEWSPAPERS data → cite the specific source.
- If YOUTUBE data → summarize expert analysis.
- PRIORITIZE local team sources over general sources.

PRIORITY LEAGUES: Premier League, La Liga, Champions League, Europa League, Bundesliga, Serie A, Ligue 1, Argentine Superliga, Brasileirão, Copa Libertadores, Copa Sudamericana, Liga MX, MLS, NBA, NFL.

MARKETS — you CAN and SHOULD analyze ANY market, not just 1X2:
🥅 Goals (over/under, BTTS, exact score, first/second half goals)
🚩 Cards (over/under 3.5/4.5/5.5, first half cards, team cards)
⛳ Corners (over/under 9.5/10.5/11.5, team corners, first half corners)
🎯 Shots (shots on target, player shots, keeper saves)
👟 Player props (passes, fouls, tackles, touches, assists)
⚽ Double chance (1X, X2, 12)
🎲 Asian handicap

ALWAYS LOOK FOR VALUE — not just 1X2.
SHORT, CLEAR FORMAT: pick with market + odds + 1-2 line reasoning + suggested stake.
NEVER invent odds. NEVER tell the user to "consult an expert" — you are the expert.`
};

// ════════════════════════════════════════════════════════════════════════════
// MAPA EQUIPO → FUENTES LOCALES (Smart Tavily v2.0)
// ════════════════════════════════════════════════════════════════════════════
// Match parcial: cuando el mensaje contiene cualquier clave de esta lista,
// las queries Tavily van a usar `site:` operators sobre las URLs asociadas.

const LOCAL_SOURCES = {
  // ── Argentina ──────────────────────────────────────────────
  'boca':              ['ole.com.ar', 'tycsports.com', 'clarin.com', 'mundoazulyoro.com', 'doblea.com'],
  'river':             ['ole.com.ar', 'tycsports.com', 'clarin.com', 'mundoriver.com'],
  'racing':            ['ole.com.ar', 'tycsports.com', 'clarin.com'],
  'independiente':     ['ole.com.ar', 'tycsports.com', 'clarin.com'],
  'san lorenzo':       ['ole.com.ar', 'tycsports.com'],
  'huracan':           ['ole.com.ar', 'tycsports.com'],
  'estudiantes':       ['ole.com.ar', 'tycsports.com'],
  'velez':             ['ole.com.ar', 'tycsports.com'],
  'newell':            ['ole.com.ar', 'tycsports.com', 'lacapital.com.ar'],
  'rosario central':   ['ole.com.ar', 'tycsports.com', 'lacapital.com.ar'],
  'union':             ['ole.com.ar', 'tycsports.com', 'unosantafe.com.ar'],
  'colon':             ['ole.com.ar', 'tycsports.com', 'unosantafe.com.ar'],
  'godoy cruz':        ['ole.com.ar', 'losandes.com.ar'],
  'talleres':          ['ole.com.ar', 'lavoz.com.ar'],
  'belgrano':          ['ole.com.ar', 'lavoz.com.ar'],
  'instituto':         ['ole.com.ar', 'lavoz.com.ar'],
  'argentinos':        ['ole.com.ar', 'tycsports.com'],
  'banfield':          ['ole.com.ar', 'tycsports.com'],
  'lanus':             ['ole.com.ar', 'tycsports.com'],

  // ── Brasil ─────────────────────────────────────────────────
  'flamengo':          ['globoesporte.globo.com', 'lance.com.br', 'oglobo.globo.com', 'extra.globo.com'],
  'palmeiras':         ['globoesporte.globo.com', 'lance.com.br', 'estadao.com.br'],
  'corinthians':       ['globoesporte.globo.com', 'lance.com.br', 'estadao.com.br'],
  'sao paulo':         ['globoesporte.globo.com', 'lance.com.br', 'estadao.com.br'],
  'santos':            ['globoesporte.globo.com', 'lance.com.br', 'atribuna.com.br'],
  'fluminense':        ['globoesporte.globo.com', 'lance.com.br'],
  'vasco':             ['globoesporte.globo.com', 'lance.com.br'],
  'botafogo':          ['globoesporte.globo.com', 'lance.com.br'],
  'gremio':            ['globoesporte.globo.com', 'gauchazh.clicrbs.com.br'],
  'internacional':     ['globoesporte.globo.com', 'gauchazh.clicrbs.com.br'],
  'atletico mineiro':  ['globoesporte.globo.com', 'em.com.br'],
  'cruzeiro':          ['globoesporte.globo.com', 'em.com.br'],
  'bahia':             ['globoesporte.globo.com', 'atarde.com.br'],
  'fortaleza':         ['globoesporte.globo.com', 'diariodonordeste.verdesmares.com.br'],
  'ceara':             ['globoesporte.globo.com', 'diariodonordeste.verdesmares.com.br'],

  // ── España ─────────────────────────────────────────────────
  'real madrid':       ['marca.com', 'as.com', 'sport.es', 'mundodeportivo.com', 'okdiario.com'],
  'barcelona':         ['mundodeportivo.com', 'sport.es', 'marca.com', 'as.com'],
  'atletico madrid':   ['marca.com', 'as.com', 'mundodeportivo.com'],
  'sevilla':           ['marca.com', 'estadiodeportivo.com', 'abcdesevilla.es'],
  'betis':             ['marca.com', 'estadiodeportivo.com', 'abcdesevilla.es'],
  'valencia':          ['marca.com', 'superdeporte.es', 'lasprovincias.es'],
  'villarreal':        ['marca.com', 'as.com'],
  'athletic':          ['marca.com', 'as.com', 'elcorreo.com'],
  'real sociedad':     ['marca.com', 'diariovasco.com'],
  'espanyol':          ['mundodeportivo.com', 'sport.es'],

  // ── Inglaterra ─────────────────────────────────────────────
  'manchester united': ['bbc.com/sport', 'skysports.com', 'manchestereveningnews.co.uk', 'theathletic.com'],
  'manchester city':   ['bbc.com/sport', 'skysports.com', 'manchestereveningnews.co.uk'],
  'liverpool':         ['bbc.com/sport', 'skysports.com', 'liverpoolecho.co.uk'],
  'arsenal':           ['bbc.com/sport', 'skysports.com', 'standard.co.uk'],
  'chelsea':           ['bbc.com/sport', 'skysports.com', 'standard.co.uk'],
  'tottenham':         ['bbc.com/sport', 'skysports.com', 'standard.co.uk'],
  'newcastle':         ['bbc.com/sport', 'skysports.com', 'chroniclelive.co.uk'],
  'aston villa':       ['bbc.com/sport', 'skysports.com', 'birminghammail.co.uk'],

  // ── Italia ─────────────────────────────────────────────────
  'juventus':          ['gazzetta.it', 'corrieredellosport.it', 'tuttosport.com'],
  'inter':             ['gazzetta.it', 'corrieredellosport.it'],
  'milan':             ['gazzetta.it', 'corrieredellosport.it'],
  'napoli':            ['gazzetta.it', 'corrieredellosport.it', 'ilmattino.it'],
  'roma':              ['gazzetta.it', 'corrieredellosport.it', 'romatoday.it'],
  'lazio':             ['gazzetta.it', 'corrieredellosport.it'],
  'fiorentina':        ['gazzetta.it', 'lanazione.it'],
  'atalanta':          ['gazzetta.it', 'ecodibergamo.it'],

  // ── Alemania ───────────────────────────────────────────────
  'bayern':            ['bild.de', 'kicker.de', 'sport1.de', 'tz.de'],
  'borussia dortmund': ['bild.de', 'kicker.de', 'sport1.de', 'ruhrnachrichten.de'],
  'leipzig':           ['bild.de', 'kicker.de', 'lvz.de'],
  'leverkusen':        ['bild.de', 'kicker.de'],
  'frankfurt':         ['bild.de', 'kicker.de', 'fr.de'],

  // ── Francia ────────────────────────────────────────────────
  'psg':               ['lequipe.fr', 'rmcsport.bfmtv.com', 'leparisien.fr'],
  'marseille':         ['lequipe.fr', 'rmcsport.bfmtv.com', 'laprovence.com'],
  'lyon':              ['lequipe.fr', 'leprogres.fr'],
  'monaco':            ['lequipe.fr', 'monacomatin.mc'],

  // ── México ─────────────────────────────────────────────────
  'club america':      ['record.com.mx', 'mediotiempo.com', 'esto.com.mx'],
  'chivas':            ['record.com.mx', 'mediotiempo.com', 'eloccidental.com.mx'],
  'cruz azul':         ['record.com.mx', 'mediotiempo.com'],
  'pumas':             ['record.com.mx', 'mediotiempo.com'],
  'monterrey':         ['record.com.mx', 'milenio.com'],
  'tigres':            ['record.com.mx', 'milenio.com'],

  // ── USA / MLS ──────────────────────────────────────────────
  'inter miami':       ['mlssoccer.com', 'theathletic.com', 'miamiherald.com'],
  'la galaxy':         ['mlssoccer.com', 'latimes.com'],
  'lafc':              ['mlssoccer.com', 'latimes.com'],
  'nycfc':             ['mlssoccer.com', 'nytimes.com'],

  // ── Chile ──────────────────────────────────────────────────
  'colo colo':         ['emol.com', 'latercera.com', 'biobiochile.cl'],
  'u de chile':        ['emol.com', 'latercera.com'],
  'universidad catolica': ['emol.com', 'latercera.com'],

  // ── Uruguay ────────────────────────────────────────────────
  'penarol':           ['ovaciondigital.com.uy', 'referi.com.uy', 'elpais.com.uy'],
  'nacional uruguay':  ['ovaciondigital.com.uy', 'referi.com.uy', 'elpais.com.uy'],

  // ── Colombia ───────────────────────────────────────────────
  'atletico nacional': ['elcolombiano.com', 'futbolred.com', 'antena2.com'],
  'millonarios':       ['eltiempo.com', 'futbolred.com', 'antena2.com'],
  'america de cali':   ['elpais.com.co', 'futbolred.com'],
  'junior':            ['elheraldo.co', 'futbolred.com'],

  // ── Perú ───────────────────────────────────────────────────
  'alianza lima':      ['depor.com', 'ovacion.pe', 'elcomercio.pe'],
  'universitario':     ['depor.com', 'ovacion.pe', 'elcomercio.pe'],
  'sporting cristal':  ['depor.com', 'ovacion.pe'],

  // ── Paraguay ───────────────────────────────────────────────
  'olimpia':           ['abc.com.py', 'ultimahora.com'],
  'cerro porteno':     ['abc.com.py', 'ultimahora.com'],
  'libertad':          ['abc.com.py', 'ultimahora.com'],
};

// Periodistas/cuentas X conocidas por región (sin @ — para usar en queries Tavily)
const REGION_JOURNALISTS = {
  argentina:     ['mariano_closs', 'arielsenosiain', 'gaboalonsoatp', 'martinarevalo'],
  brasil:        ['venecasagrande', 'jorgenicola', 'pedrobruno_rj'],
  espana:        ['ramonfuentes', 'romeagle', 'helenacondis'],
  inglaterra:    ['fabrizioromano', 'david_ornstein', 'thedebsters'],
  italia:        ['fabrizioromano', 'gianlucadimarzio'],
  alemania:      ['fabrizioromano', 'falkschmidt'],
  francia:       ['fabrizioromano', 'romainmolina'],
  mexico:        ['rubmarin', 'mediotiempo'],
  internacional: ['fabrizioromano', 'david_ornstein', 'fabriziorf'],
};

// ════════════════════════════════════════════════════════════════════════════
// DETECTOR DE INTENT
// ════════════════════════════════════════════════════════════════════════════

/**
 * Detecta el tipo de información que el usuario está pidiendo.
 * Devuelve uno de: 'fan_opinion' | 'news' | 'analysis' | 'pick' | 'general'
 */
function detectIntent(message) {
  const lower = message.toLowerCase();
  if (/(qu[eé] dicen|qu[eé] piensan|hincha|fan|aficionado|aficiones|tribuna|opinan|opini[oó]n|comentarios|red social|twitter|tuit)/i.test(lower)) {
    return 'fan_opinion';
  }
  if (/(lesion|herido|baja|titular|formaci[oó]n|alineaci[oó]n|convocad|expulsad|noticia|news|breaking|informe|reporte|prensa|diario)/i.test(lower)) {
    return 'news';
  }
  if (/(an[aá]lisis|previa|forma actual|rendimiento|preview|estad[ií]sticas|hist[oó]rico|t[aá]ctica)/i.test(lower)) {
    return 'analysis';
  }
  if (/(pick|apuesta|cuota|combinada|parlay|tip|fija|valor|qu[eé] apostar|recomendaci[oó]n|dame.*pick|mejor.*apuesta|mejor.*bet)/i.test(lower)) {
    return 'pick';
  }
  return 'general';
}

function getLocalSourcesForMessage(message) {
  const lower = message.toLowerCase();
  const sources = new Set();
  for (const [key, urls] of Object.entries(LOCAL_SOURCES)) {
    if (lower.includes(key)) urls.forEach(u => sources.add(u));
  }
  return [...sources];
}

function getJournalistsForMessage(message) {
  const lower = message.toLowerCase();
  if (/\b(boca|river|racing|independiente|argentin|superliga|copa argentina)\b/.test(lower)) return REGION_JOURNALISTS.argentina;
  if (/\b(flamengo|palmeiras|corinthians|brasil|brasileirao|libertadores|sudamericana)\b/.test(lower)) return REGION_JOURNALISTS.brasil;
  if (/\b(real madrid|barcelona|atletico|la liga|laliga|espan)\b/.test(lower)) return REGION_JOURNALISTS.espana;
  if (/\b(manchester|liverpool|arsenal|chelsea|tottenham|premier|england|epl)\b/.test(lower)) return REGION_JOURNALISTS.inglaterra;
  if (/\b(juventus|inter|milan|napoli|roma|serie a|italia)\b/.test(lower)) return REGION_JOURNALISTS.italia;
  if (/\b(bayern|dortmund|leipzig|bundesliga|alemania)\b/.test(lower)) return REGION_JOURNALISTS.alemania;
  if (/\b(psg|marseille|lyon|monaco|ligue|francia)\b/.test(lower)) return REGION_JOURNALISTS.francia;
  if (/\b(america|chivas|cruz azul|pumas|monterrey|tigres|liga mx|mexico)\b/.test(lower)) return REGION_JOURNALISTS.mexico;
  return REGION_JOURNALISTS.internacional;
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS originales (preservados de v1.x)
// ════════════════════════════════════════════════════════════════════════════

function needsWebSearch(message) {
  const lower = message.toLowerCase();
  const conceptPatterns = [
    "qué es ","que es ","what is ","cómo funciona","como funciona",
    "explícame qué","explicame que","define ","definición de","definition of",
    "qué significa","que significa","what does","cómo se calcula","como se calcula",
    "qué es el kelly","que es el kelly","qué es el bankroll","que es el bankroll",
    "qué es una cuota","que es una cuota","qué es value bet","que es value bet"
  ];
  const isConcept = conceptPatterns.some(c => lower.includes(c));
  if (isConcept && lower.length < 55) return false;
  return true;
}

function extractTeamsFromMessage(message) {
  const vsMatch = message.match(/([a-záéíóúüñ\s]+)\s+vs\.?\s+([a-záéíóúüñ\s]+)/i);
  if (vsMatch) return { home: vsMatch[1].trim(), away: vsMatch[2].trim() };
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// BUILD SEARCH QUERIES — MEJORADO con detección de intent
// ════════════════════════════════════════════════════════════════════════════

function buildSearchQueries(message, context) {
  const now = new Date();
  const year = now.getFullYear();
  const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const month = months[now.getMonth()];
  const day = now.getDate();
  const dateStr = `${day} ${month} ${year}`;

  const intent = detectIntent(message);
  const localSources = getLocalSourcesForMessage(message);
  const journalists = getJournalistsForMessage(message);

  // Subject (partido o tema)
  let subject;
  let teamsForLocal = null;
  if (context?.home && context?.away) {
    subject = `${context.home} vs ${context.away}`;
    teamsForLocal = `${context.home} ${context.away}`;
  } else {
    const teams = extractTeamsFromMessage(message);
    if (teams) {
      subject = `${teams.home} vs ${teams.away}`;
      teamsForLocal = `${teams.home} ${teams.away}`;
    } else {
      subject = message.trim().slice(0, 80);
    }
  }

  const siteOR           = (urls)    => urls.length    ? '(' + urls.map(u => `site:${u}`).join(' OR ') + ')' : '';
  const twitterFromList  = (handles) => handles.length ? '(' + handles.map(h => `from:${h}`).join(' OR ') + ')' : '';

  const queries = [];

  // Queries base (sólo si pick / analysis / general)
  if (intent === 'pick' || intent === 'analysis' || intent === 'general') {
    queries.push(`${subject} prediction ${month} ${year} injuries lineup form stats head to head`);
    queries.push(`${subject} ${month} ${year} estadisticas corners tarjetas goles BTTS`);
  }

  // Queries específicas según intent
  if (intent === 'fan_opinion' && teamsForLocal) {
    queries.push(`site:x.com OR site:twitter.com "${teamsForLocal}" pronóstico hinchas ${month} ${year}`);
    if (journalists.length) {
      queries.push(`site:x.com ${twitterFromList(journalists.slice(0, 4))} ${teamsForLocal}`);
    }
    queries.push(`site:reddit.com ${teamsForLocal} preview ${month} ${year}`);
  }

  if (intent === 'news' && (teamsForLocal || subject)) {
    if (localSources.length) {
      const sub = teamsForLocal || subject;
      queries.push(`${siteOR(localSources)} "${sub}" lesiones formación ${month} ${year}`);
    } else {
      queries.push(`${subject} lesiones formación titular convocados ${dateStr}`);
    }
    if (journalists.length) {
      queries.push(`site:x.com ${twitterFromList(journalists.slice(0, 4))} "${teamsForLocal || subject}" ${month} ${year}`);
    }
  }

  if (intent === 'analysis' && teamsForLocal) {
    queries.push(`site:youtube.com "${teamsForLocal}" previa análisis ${month} ${year}`);
    if (localSources.length) {
      queries.push(`${siteOR(localSources)} "${teamsForLocal}" previa análisis estadísticas`);
    }
  }

  if (intent === 'pick' && teamsForLocal && journalists.length) {
    queries.push(`site:x.com ${twitterFromList(journalists.slice(0, 3))} "${teamsForLocal}"`);
  }

  // Fallback para mercados específicos sin equipos
  if (queries.length === 0) {
    const lower = message.toLowerCase();
    if (/corner|córner|esquina/i.test(lower)) {
      queries.push(`best corner bets today ${dateStr} Premier La Liga Bundesliga Serie A`);
      queries.push(`corners statistics today matches ${month} ${year} over under 9.5 10.5`);
    } else if (/tarjeta|amarilla|roja|card/i.test(lower)) {
      queries.push(`most yellow cards today matches ${dateStr} football betting`);
      queries.push(`tarjetas amarillas partidos hoy ${dateStr} estadísticas apuestas`);
    } else if (/ambos anotan|btts|both teams/i.test(lower)) {
      queries.push(`both teams to score today ${dateStr} Premier La Liga Champions`);
      queries.push(`ambos anotan partidos hoy ${dateStr} btts estadísticas`);
    } else {
      queries.push(`best football betting tips today ${dateStr}`);
      queries.push(`today soccer predictions value bets corners BTTS over under ${dateStr}`);
    }
  }

  // Cap a máximo 5 queries para controlar costo Tavily (~5 credits/mensaje)
  return queries.slice(0, 5);
}

// ════════════════════════════════════════════════════════════════════════════
// TAVILY SEARCH
// ════════════════════════════════════════════════════════════════════════════

async function tavilySearch(query, apiKey) {
  try {
    const res = await fetch(TAVILY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'advanced',
        max_results: 8,
        include_answer: true,
        include_raw_content: false,
      }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchWebContext(message, context, apiKey) {
  try {
    const queries = buildSearchQueries(message, context);
    const results = await Promise.allSettled(queries.map(q => tavilySearch(q, apiKey)));
    const parts = [];
    const seen = new Set();
    for (let i = 0; i < results.length; i++) {
      if (results[i].status !== 'fulfilled' || !results[i].value) continue;
      const data = results[i].value;
      if (data.answer && !seen.has(data.answer)) {
        parts.push(`📌 RESPUESTA DIRECTA [query ${i + 1}]: ${data.answer}`);
        seen.add(data.answer);
      }
      if (Array.isArray(data.results)) {
        for (const r of data.results.slice(0, 6)) {
          const snippet = r.content?.slice(0, 500);
          if (snippet && !seen.has(snippet)) {
            // Identificar tipo de fuente para que el modelo cite mejor
            let prefix = `• [${r.title || 'Fuente'}]`;
            const url = r.url || '';
            if      (/twitter\.com|x\.com/.test(url))                       prefix = '🐦 [X/Twitter]';
            else if (/youtube\.com/.test(url))                              prefix = '🎥 [YouTube]';
            else if (/reddit\.com/.test(url))                               prefix = '💬 [Reddit]';
            else if (/ole\.com\.ar|tycsports|clarin/.test(url))             prefix = '📰 [Diario AR]';
            else if (/globoesporte|lance\.com\.br/.test(url))               prefix = '📰 [Diario BR]';
            else if (/marca|as\.com|sport\.es|mundodeportivo/.test(url))    prefix = '📰 [Diario ES]';
            else if (/gazzetta|corriere|tuttosport/.test(url))              prefix = '📰 [Diario IT]';
            else if (/bbc\.com|skysports|theathletic/.test(url))            prefix = '📰 [Diario UK]';
            else if (/bild|kicker|sport1/.test(url))                        prefix = '📰 [Diario DE]';
            else if (/lequipe|rmcsport/.test(url))                          prefix = '📰 [Diario FR]';
            else if (/record\.com\.mx|mediotiempo/.test(url))               prefix = '📰 [Diario MX]';
            parts.push(`${prefix} ${snippet}`);
            seen.add(snippet);
          }
        }
      }
    }
    return parts.length ? parts.join('\n') : null;
  } catch (err) {
    console.error('Tavily fetch error:', err);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// BUILD CONTEXT STRING
// ════════════════════════════════════════════════════════════════════════════

function buildContextString(ctx) {
  if (ctx.matches && Array.isArray(ctx.matches)) {
    if (ctx.matches.length === 0) return '';
    const lines = ['PARTIDOS DISPONIBLES EN LA PLATAFORMA HOY:'];
    const recLabel = (m) => {
      if (m.rec === 'home') return `Gana ${m.home}`;
      if (m.rec === 'away') return `Gana ${m.away}`;
      if (m.rec === 'draw') return 'Empate';
      return m.rec || '';
    };
    for (const m of ctx.matches) {
      lines.push(`\n⚽ ${m.home} vs ${m.away}${m.league ? ` (${m.league})` : ''}${m.time ? ` — ${m.time}` : ''}`);
      if (m.oddsH) lines.push(`  Cuotas: Local(${m.home}) ${m.oddsH} | Empate ${m.oddsD ?? '-'} | Visitante(${m.away}) ${m.oddsA}`);
      if (m.probH) lines.push(`  Prob. IA: ${m.home} ${m.probH}% | Empate ${m.probD ?? 0}% | ${m.away} ${m.probA}%`);
      if (m.rec)   lines.push(`  ✅ Recomendación IA: ${recLabel(m)} (confianza: ${m.confidence ?? '?'}%)`);
    }
    return lines.join('\n');
  }
  const parts = [];
  if (ctx.home && ctx.away) parts.push(`Partido: ${ctx.home} vs ${ctx.away}`);
  if (ctx.league)  parts.push(`Liga: ${ctx.league}`);
  if (ctx.oddsH)   parts.push(`Cuota Local (1): ${ctx.oddsH}`);
  if (ctx.oddsD)   parts.push(`Cuota Empate (X): ${ctx.oddsD}`);
  if (ctx.oddsA)   parts.push(`Cuota Visitante (2): ${ctx.oddsA}`);
  if (ctx.probH)   parts.push(`Prob. Local: ${ctx.probH}%`);
  if (ctx.probD)   parts.push(`Prob. Empate: ${ctx.probD}%`);
  if (ctx.probA)   parts.push(`Prob. Visitante: ${ctx.probA}%`);
  if (ctx.rec)     parts.push(`Recomendación IA: ${ctx.rec}`);
  if (ctx.confidence) parts.push(`Confianza: ${ctx.confidence}`);
  return parts.join('\n');
}

function corsResponse(body, status, env) {
  const origin = env?.ALLOWED_ORIGIN ?? '*';
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  return new Response(body, { status, headers });
}

// ════════════════════════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// RESEARCH ENDPOINT — pre-pick intel sobre cada partido
// ════════════════════════════════════════════════════════════════════════════

/**
 * Construye queries Tavily focalizadas en research de un match concreto.
 * No es chat — son queries para descubrir info aprovechable para apostar.
 */
function buildResearchQueries(home, away, league) {
  const q = [];
  const todayISO = new Date().toISOString().slice(0, 10);
  // Lesiones / bajas confirmadas
  q.push(`"${home}" lesiones bajas convocados ${todayISO}`);
  q.push(`"${away}" lesiones bajas convocados ${todayISO}`);
  // Formación probable (ambos equipos en una sola query)
  q.push(`"${home}" vs "${away}" formación probable alineación previa`);
  // Conflictos / virus / extra-deportivos
  q.push(`"${home}" OR "${away}" conflicto plantel virus huelga deudas ${todayISO}`);
  // Periodistas / opinión hincha sobre el partido
  q.push(`site:twitter.com OR site:x.com "${home}" "${away}" previa pronóstico`);
  return q;
}

/**
 * Pide a Claude que clasifique findings de Tavily en formato JSON estricto.
 * Devuelve {summary, severity, bias, stake_delta, key_findings}.
 */
async function analyzePickWithIA(home, away, league, rec, tavilyDigest, anthropicKey) {
  const systemPrompt = `Sos un analista de apuestas SENIOR Y CONSERVADOR. Tu única tarea es leer hallazgos de research web y clasificarlos en JSON estricto. NO escribas prosa fuera del JSON.

Devolvé EXACTAMENTE este shape:
{
  "summary": "1-2 frases en español rioplatense con lo más importante",
  "short_label": "3-5 palabras MUY breves para mostrar en una cinta angosta (ej: '3 bajas defensivas', 'Forma muy floja', 'Cancha mojada')",
  "severity": "none" | "info" | "warning" | "critical",
  "bias": "over" | "under" | "home" | "away" | "draw" | "none",
  "stake_delta": -1 | 0 | 1,
  "key_findings": [{"type": "...", "text": "...", "source_name": "..."}, ...]
}

REGLAS DE SEVERIDAD — SÉ CONSERVADOR, no alarmes al usuario sin motivo real:
- "none" → no hay info aprovechable, o el partido se ve normal sin novedades importantes. ESTE ES EL DEFAULT.
- "info"  → curioso pero NO crítico: 1-2 lesionados no estelares, rumor sin confirmar, rotación esperable. Cinta verde discreta.
- "warning" → 4+ titulares confirmados afuera (o 2 estelares MUY claves), o conflicto interno serio (huelga parcial, manager fired, pelea pública). Cinta amarilla. NO usar para "el rival tiene 1 jugador con molestia muscular".
- "critical" → 7+ bajas confirmadas O huelga total O virus masivo O partido amañado/manchado O sanción FIFA. RARÍSIMO. Cinta roja.

REGLAS BIAS:
- Solo asignar 'over'/'under'/'home'/'away' si hay EVIDENCIA FUERTE de los hallazgos. Si dudás → "none".

REGLAS STAKE_DELTA:
- 0 (DEFAULT) → la info no cambia significativamente el pick.
- -1 → bias claramente contradice el pick (ej: pick 'Más 2.5' pero ambos delanteros lesionados).
- +1 → bias confirma fuerte el pick con razón concreta (ej: pick 'Gana Local' y rival sin 4 titulares).

REGLAS SHORT_LABEL:
- DEBE ser pegadizo y entendible en menos de 1 segundo.
- 3-5 palabras MAX. Nunca más.
- Ejemplos buenos: "3 bajas defensivas", "Sin Mbappé ni Bellingham", "Forma muy floja", "Lluvia confirmada", "Sin cuatro titulares", "Manager interino", "Rival eliminado UCL"
- Ejemplos MALOS (no hacer): "Lazio sin portero titular Provedel (lesión de hombro, retorno..." (largo y técnico)

KEY_FINDINGS:
- Máximo 4 items, los más impactantes para apostar.
- type ∈ {"injury","tactical","conflict","weather","form","rotation","financial","other"}.

Si no hay información útil:
{"summary":"Sin novedades relevantes.","short_label":"","severity":"none","bias":"none","stake_delta":0,"key_findings":[]}

REGLAS ANTI-ALUCINACION (criticas, no negociables):
1. NUNCA atribuyas un jugador a un equipo sin que la fuente lo confirme. Si la nota dice "lesion de X en semifinal contra River", el jugador X puede ser de River O del rival. NO asumas — verifica.
2. Si las noticias hablan de partidos del rival contra un tercer equipo (ej: noticias de "Rival vs River" cuando vos analizas "Local vs Rival"), NO traslades esos eventos al partido actual. Los lesionados de River en su partido contra Rival son de RIVER, no del Local.
3. Si una fuente menciona jugadores sin aclarar a que equipo pertenecen, OMITELOS del finding. Mejor decir "sin info adicional" que inventar.
4. Para CADA finding tipo "injury" o "suspension", antes de incluirlo preguntate: "esta fuente confirma que ese jugador es de ${home} o ${away}, y no de un rival mencionado de paso?". Si no podes confirmarlo con la fuente, NO lo incluyas.
5. NO confundas partidos previos de la misma serie con el partido actual. El historial es informativo, pero las bajas/eventos deben ser ESPECIFICOS del partido a analizar.
6. Si las noticias parecen mezcladas o ambiguas, prefiere severity:"none" antes que arriesgar findings incorrectos.
`;

  const userPrompt = `Partido: ${home} vs ${away}${league ? ' ('+league+')' : ''}
Recomendación actual del algoritmo: ${rec}

HALLAZGOS DE RESEARCH WEB:
${tavilyDigest || '(sin resultados)'}

Devolvé el JSON.`;

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: 800,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) {
      console.error('Anthropic research error:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const text = data?.content?.[0]?.text || '';
    // Extraer JSON (Claude a veces lo wrappea con ```json)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    // Validar shape mínimo
    if (typeof parsed.summary !== 'string') return null;
    return {
      summary:      parsed.summary.slice(0, 500),
      short_label:  typeof parsed.short_label === 'string' ? parsed.short_label.trim().slice(0, 50) : '',
      severity:     ['none','info','warning','critical'].includes(parsed.severity) ? parsed.severity : 'none',
      bias:         ['over','under','home','away','draw','none'].includes(parsed.bias) ? parsed.bias : 'none',
      stake_delta:  [-1, 0, 1].includes(parsed.stake_delta) ? parsed.stake_delta : 0,
      key_findings: Array.isArray(parsed.key_findings) ? parsed.key_findings.slice(0, 4) : [],
    };
  } catch (err) {
    console.error('analyzePickWithIA error:', err);
    return null;
  }
}

/**
 * Construye un digest de los resultados Tavily para pasar a Claude.
 * Más conciso que el formato de chat — solo título + snippet + URL.
 */
async function fetchResearchDigest(home, away, league, tavilyKey) {
  const queries = buildResearchQueries(home, away, league);
  const results = await Promise.allSettled(queries.map(q => tavilySearch(q, tavilyKey)));
  const lines = [];
  const seen = new Set();
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const data = r.value;
    if (data.answer && !seen.has(data.answer)) {
      lines.push(`✶ ${data.answer}`);
      seen.add(data.answer);
    }
    if (Array.isArray(data.results)) {
      for (const item of data.results.slice(0, 5)) {
        const snippet = (item.content || '').slice(0, 350);
        const key = (item.url || '') + snippet.slice(0, 80);
        if (snippet && !seen.has(key)) {
          let source = 'Web';
          const url = item.url || '';
          if (/twitter\.com|x\.com/.test(url)) source = 'X/Twitter';
          else if (/youtube\.com/.test(url))   source = 'YouTube';
          else if (item.title) source = item.title.slice(0, 50);
          lines.push(`[${source}] ${snippet}`);
          seen.add(key);
        }
      }
    }
  }
  return lines.length ? lines.join('\n') : null;
}

/**
 * Cache en memoria del worker isolate.
 * Cloudflare puede correr múltiples isolates por región — esto no es global,
 * pero igual filtra muchas duplicaciones dentro de un mismo isolate. TTL 12h.
 * Combinado con localStorage del cliente (12h también), reduce calls Tavily ~95%.
 */
const RESEARCH_CACHE = new Map();           // matchKey → {data, expiresAt}
const RESEARCH_CACHE_TTL_MS = 12 * 3600 * 1000;
const RESEARCH_CACHE_MAX = 500;

function cacheGet(key) {
  const entry = RESEARCH_CACHE.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    RESEARCH_CACHE.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  // LRU básico: si pasa del max, borra el más viejo (primer key)
  if (RESEARCH_CACHE.size >= RESEARCH_CACHE_MAX) {
    const firstKey = RESEARCH_CACHE.keys().next().value;
    if (firstKey) RESEARCH_CACHE.delete(firstKey);
  }
  RESEARCH_CACHE.set(key, { data, expiresAt: Date.now() + RESEARCH_CACHE_TTL_MS });
}

/**
 * Handler del endpoint /research.
 * POST {home, away, league, commenceTs, rec, sport?} → research IA del partido.
 */
async function handleResearch(body, env) {
  const { home, away, league, commenceTs, rec } = body;
  if (!home || !away) {
    return corsResponse(JSON.stringify({ error: 'Faltan home/away' }), 400, env);
  }
  const matchKey = `${home}|||${away}|||${commenceTs || 0}`;

  // 1. Check cache in-memory
  const cached = cacheGet(matchKey);
  if (cached) {
    return corsResponse(JSON.stringify({ cached: true, ...cached }), 200, env);
  }

  // 2. Cache miss → corre research
  if (!env.TAVILY_API_KEY || !env.ANTHROPIC_API_KEY) {
    return corsResponse(JSON.stringify({ error: 'APIs no configuradas' }), 503, env);
  }

  const tavilyDigest = await fetchResearchDigest(home, away, league, env.TAVILY_API_KEY);
  if (!tavilyDigest) {
    const empty = { summary: 'Sin info adicional encontrada.', short_label: '', severity: 'none', bias: 'none', stake_delta: 0, key_findings: [] };
    cacheSet(matchKey, empty);
    return corsResponse(JSON.stringify({ cached: false, ...empty }), 200, env);
  }

  const analysis = await analyzePickWithIA(home, away, league, rec || 'sin pick', tavilyDigest, env.ANTHROPIC_API_KEY);
  if (!analysis) {
    return corsResponse(JSON.stringify({ error: 'Análisis IA falló' }), 502, env);
  }

  // 3. Guardar en cache in-memory
  cacheSet(matchKey, analysis);

  return corsResponse(JSON.stringify({ cached: false, ...analysis }), 200, env);
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER (router)
// ════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return corsResponse(null, 204, env);
    if (request.method !== 'POST')    return corsResponse(JSON.stringify({ error: 'Método no permitido' }), 405, env);

    // Routing por path
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');   // sin trailing slash

    let body;
    try { body = await request.json(); }
    catch { return corsResponse(JSON.stringify({ error: 'JSON inválido' }), 400, env); }

    // POST /research → endpoint nuevo
    if (path === '/research') {
      return handleResearch(body, env);
    }

    // POST / o /chat → comportamiento original (chat IA)
    const { message, context, history, lang, image } = body;
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return corsResponse(JSON.stringify({ error: 'Mensaje vacío' }), 400, env);
    }

    const intent = detectIntent(message);

    let webContext = null;
    if (env.TAVILY_API_KEY && needsWebSearch(message)) {
      webContext = await fetchWebContext(message, context, env.TAVILY_API_KEY);
    }

    const messages = [];
    if (Array.isArray(history) && history.length > 0) {
      for (const turn of history.slice(-10)) {
        if (turn.role && turn.content) {
          messages.push({ role: turn.role, content: turn.content });
        }
      }
    }
    let textContent = message.trim();
    if (context && typeof context === 'object') {
      const ctx = buildContextString(context);
      if (ctx) textContent = `[CONTEXTO DEL PARTIDO]\n${ctx}\n\n${textContent}`;
    }
    if (webContext) {
      textContent = `[DATOS WEB EN TIEMPO REAL — úsalos como base, no los ignores. Intent detectado: ${intent}]\n${webContext}\n\n${textContent}`;
    }

    if (image && image.data && image.mediaType) {
      messages.push({
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
          { type: 'text',  text: textContent || 'Analiza esta imagen de cuotas y dame tu recomendación de apuesta.' },
        ],
      });
    } else {
      messages.push({ role: 'user', content: textContent });
    }

    try {
      const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      MODEL,
          max_tokens: MAX_TOKENS,
          system:     SYSTEM_PROMPTS[lang] || SYSTEM_PROMPTS.es,
          messages,
        }),
      });
      if (!response.ok) {
        const errText = await response.text();
        console.error('Anthropic API error:', response.status, errText);
        return corsResponse(JSON.stringify({ error: 'Error en la IA, intenta de nuevo' }), 502, env);
      }
      const data = await response.json();
      const reply = data?.content?.[0]?.text ?? '';
      return corsResponse(JSON.stringify({ reply, webUsed: !!webContext, intent }), 200, env);
    } catch (err) {
      console.error('Worker error:', err);
      return corsResponse(JSON.stringify({ error: 'Error interno del servidor' }), 500, env);
    }
  },
};
