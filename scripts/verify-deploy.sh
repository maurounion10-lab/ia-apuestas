#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════
# verify-deploy.sh — verificación automática post-deploy de gambeta.ai
# ════════════════════════════════════════════════════════════════════════
#
# Uso: ./scripts/verify-deploy.sh
#
# Chequea:
#   1. HTML reachable (200 OK)
#   2. JS válido (no SyntaxError visible al curl-ear)
#   3. shortName() es UNA SOLA función (no duplicada)
#   4. Logos críticos están con URL correcta (Pumas, Raków, etc.)
#   5. Polish shortNames presentes (Raków → Raków, etc.)
#   6. /api/sb?type=historial responde y devuelve count razonable
#   7. shared_cache y acoin_users tienen counts cercanos (sync OK)
#   8. Picks pendientes "resolvables" (kick-off pasado) no quedan stuck
#
# Exit codes:
#   0  → todo OK
#   1  → al menos 1 check falló
#
# ════════════════════════════════════════════════════════════════════════

set +e  # NO fail-fast: corremos todos los checks y reportamos al final

HOST="${GAMBETA_HOST:-https://gambeta.ai}"
SB_URL="https://ixfrtjvhnpapyuphqfxp.supabase.co"
SB_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4ZnJ0anZobnBhcHl1cGhxZnhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDExOTMsImV4cCI6MjA4OTE3NzE5M30.Lc5cOfvXCrrMlm9Yup5GG6RgCxOB_GSNJnKLTb1-bZQ"

PASS=0
FAIL=0
WARN=0

check() {
  local name="$1"; local status="$2"; local detail="$3"
  case "$status" in
    pass) echo "  ✓ $name${detail:+ — $detail}"; PASS=$((PASS+1)) ;;
    fail) echo "  ✗ $name${detail:+ — $detail}"; FAIL=$((FAIL+1)) ;;
    warn) echo "  ⚠ $name${detail:+ — $detail}"; WARN=$((WARN+1)) ;;
  esac
}

echo "════════════════════════════════════════════════════"
echo "  gambeta.ai deploy verification"
echo "  Target: $HOST"
echo "  $(date)"
echo "════════════════════════════════════════════════════"
echo

# ─── 1. HTML reachable ──────────────────────────────────
echo "── HTML ──"
HTML="/tmp/gambeta_verify_$$.html"
HTTP_CODE=$(curl -s -A "Mozilla/5.0" -o "$HTML" -w "%{http_code}" "$HOST/")
if [ "$HTTP_CODE" = "200" ]; then
  SIZE=$(wc -c < "$HTML")
  check "HTML reachable" pass "HTTP $HTTP_CODE, ${SIZE} bytes"
else
  check "HTML reachable" fail "HTTP $HTTP_CODE"
  echo
  echo "Aborting — HTML not reachable."
  exit 1
fi

# ─── 2. Estructura JS ────────────────────────────────────
echo
echo "── Estructura JS ──"
SHORTNAME_COUNT=$(grep -c '^function shortName(' "$HTML")
if [ "$SHORTNAME_COUNT" = "1" ]; then
  check "shortName() unificada" pass "1 declaración"
else
  check "shortName() unificada" fail "$SHORTNAME_COUNT declaraciones (esperado 1)"
fi

# Validar JS sintácticamente extrayendo scripts y pasando por node --check
if command -v node >/dev/null 2>&1; then
  python3 -c "
import re, sys
with open('$HTML') as f: c = f.read()
blocks = re.findall(r'<script(?![^>]*\bsrc=)(?![^>]*type=\"application/ld\+json\")[^>]*>(.*?)</script>', c, flags=re.DOTALL)
with open('/tmp/verify_$$.js','w') as f: f.write('\n;\n'.join(blocks))
"
  if node --check "/tmp/verify_$$.js" >/dev/null 2>&1; then
    check "JS sintaxis válida" pass "node --check OK"
  else
    ERR=$(node --check "/tmp/verify_$$.js" 2>&1 | head -1)
    check "JS sintaxis válida" fail "$ERR"
  fi
  rm -f "/tmp/verify_$$.js"
else
  check "JS sintaxis válida" warn "node no disponible"
fi

# ─── 3. Logos críticos ───────────────────────────────────
echo
echo "── Logos críticos ──"
declare -a CRITICAL_LOGOS=(
  "Pumas UNAM|/2286.png"
  "Raków Częstochowa|/339.png"
  "Jagiellonia Białystok|/342.png"
  "Pogoń Szczecin|/340.png"
  "Real Madrid|/541.png"
)
for entry in "${CRITICAL_LOGOS[@]}"; do
  team="${entry%|*}"
  expected="${entry#*|}"
  # Buscar la línea con el equipo y verificar que contenga la URL esperada
  if python3 -c "
import re, sys
with open('$HTML') as f: c = f.read()
# Buscar todas las líneas con esta key en teamLogos
m = re.search(r'^\s*\'$team\':\s*\'([^\']+)\'', c, re.MULTILINE)
if not m: sys.exit(1)
url = m.group(1)
sys.exit(0 if '$expected' in url else 2)
" 2>/dev/null; then
    check "Logo '$team'" pass "$expected"
  elif [ $? = 1 ]; then
    check "Logo '$team'" fail "no encontrado en teamLogos"
  else
    check "Logo '$team'" fail "URL no contiene '$expected'"
  fi
done

# ─── 4. ShortNames polacos ───────────────────────────────
# Verificamos todos en un solo python para evitar pesadillas de quoting bash.
echo
echo "── ShortNames polacos ──"
python3 - "$HTML" <<'PYEOF'
import re, sys
html_path = sys.argv[1]
with open(html_path) as f:
    c = f.read()

# Extraer teamShortNames como dict
m = re.search(r'const teamShortNames = \{(.*?)\n\};', c, re.DOTALL)
ts_dict = {}
if m:
    for entry in re.finditer(r"'((?:[^'\\]|\\.)*)':\s*'((?:[^'\\]|\\.)*)'", m.group(1)):
        ts_dict[entry.group(1)] = entry.group(2).replace("\\'", "'")

# Tests
tests = [
    ('Raków Częstochowa',     'Raków'),
    ('Jagiellonia Białystok', 'Jagiellonia'),
    ('Pogoń Szczecin',        'Pogoń'),
    ('Zagłębie Lubin',        'Zagłębie'),
    ('Górnik Zabrze',         'Górnik'),
    ('Wisła Kraków',          'Wisła'),
    ('Legia Warszawa',        'Legia'),
]
for raw, expected in tests:
    actual = ts_dict.get(raw)
    if actual == expected:
        print(f"  ✓ ShortName '{raw}' → '{expected}'")
    else:
        print(f"  ✗ ShortName '{raw}' → '{actual}' (esperado '{expected}')")
PYEOF

# ─── 5. /api/sb endpoint ────────────────────────────────
echo
echo "── /api/sb endpoint ──"
API_RESP=$(curl -s "$HOST/api/sb?type=historial&t=$(date +%s)")
API_COUNT=$(echo "$API_RESP" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    h = d[0].get('historial_full', [])
    print(len(h))
except: print(0)
" 2>/dev/null)
if [ "$API_COUNT" -gt 100 ]; then
  check "/api/sb historial count" pass "$API_COUNT picks"
elif [ "$API_COUNT" -gt 30 ]; then
  check "/api/sb historial count" warn "$API_COUNT picks (esperado >100)"
else
  check "/api/sb historial count" fail "$API_COUNT picks"
fi

# ─── 6. shared_cache vs acoin_users sync ────────────────
echo
echo "── Supabase sync ──"
CACHE_COUNT=$(curl -s "$SB_URL/rest/v1/shared_cache?key=eq.global_historial_v1&select=data" \
  -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" | \
  python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    if d and d[0].get('data'): print(len(d[0]['data']))
    else: print(0)
except: print(0)
")
USERS_COUNT=$(curl -s "$SB_URL/rest/v1/acoin_users?email=eq.mauro.union10%40gmail.com&select=historial_full" \
  -H "apikey: $SB_KEY" -H "Authorization: Bearer $SB_KEY" | \
  python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    if d and d[0].get('historial_full'): print(len(d[0]['historial_full']))
    else: print(0)
except: print(0)
")
DRIFT=$((USERS_COUNT > CACHE_COUNT ? USERS_COUNT - CACHE_COUNT : CACHE_COUNT - USERS_COUNT))
if [ "$DRIFT" -le 5 ]; then
  check "shared_cache ↔ acoin_users sync" pass "cache=$CACHE_COUNT, users=$USERS_COUNT (drift=$DRIFT)"
elif [ "$DRIFT" -le 50 ]; then
  check "shared_cache ↔ acoin_users sync" warn "cache=$CACHE_COUNT, users=$USERS_COUNT (drift=$DRIFT)"
else
  check "shared_cache ↔ acoin_users sync" fail "cache=$CACHE_COUNT, users=$USERS_COUNT (drift=$DRIFT) — trigger Postgres no instalado o reconciler no corrió"
fi

# ─── 7. Worker cron resolver ─────────────────────────────
echo
echo "── Worker cron resolver ──"
WORKER_STATUS=$(curl -s "https://apuestas-api.mauro-union10.workers.dev/status")
WORKER_VERSION=$(echo "$WORKER_STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('worker','?'))" 2>/dev/null)
SB_KEY_OK=$(echo "$WORKER_STATUS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('sb_service_key','?'))" 2>/dev/null)
if [[ "$WORKER_VERSION" == *"v2.5"* || "$WORKER_VERSION" == *"v2.6"* || "$WORKER_VERSION" == *"v2.7"* ]]; then
  check "Worker actualizado" pass "$WORKER_VERSION"
else
  check "Worker actualizado" warn "$WORKER_VERSION (esperado v2.5+)"
fi
if [ "$SB_KEY_OK" = "configured" ]; then
  check "SUPABASE_SERVICE_ROLE_KEY seteado" pass ""
else
  check "SUPABASE_SERVICE_ROLE_KEY seteado" fail "secret no configurado — corré 'wrangler secret put SUPABASE_SERVICE_ROLE_KEY' en /worker"
fi

# ─── 8. Picks stuck (kick-off > 12h pasado, sigue pending) ──
echo
echo "── Picks stuck ──"
STUCK_COUNT=$(echo "$API_RESP" | python3 -c "
import json, sys, time
try:
    d = json.load(sys.stdin)
    h = d[0].get('historial_full', [])
    now = time.time() * 1000
    stuck = [p for p in h
             if p.get('result') == 'pending'
             and p.get('commenceTs')
             and (now - p['commenceTs']) > 12 * 3600 * 1000
             and (now - p['commenceTs']) < 7 * 24 * 3600 * 1000]
    print(len(stuck))
    for p in stuck[:5]:
        import datetime
        ts = datetime.datetime.fromtimestamp(p['commenceTs']/1000).strftime('%m-%d %H:%M')
        print(f'  - {ts} | {p.get(\"home\",\"\")[:18]} vs {p.get(\"away\",\"\")[:18]} | {p.get(\"rec\",\"\")[:15]}', file=sys.stderr)
except Exception as e:
    print(0)
    print(f'  parse error: {e}', file=sys.stderr)
" 2>/tmp/stuck_$$.txt)
STUCK_DETAIL=$(cat /tmp/stuck_$$.txt 2>/dev/null | head -5)
rm -f /tmp/stuck_$$.txt
if [ "$STUCK_COUNT" = "0" ]; then
  check "Sin picks stuck" pass "0 picks pendientes con kick-off > 12h"
elif [ "$STUCK_COUNT" -le 2 ]; then
  check "Sin picks stuck" warn "$STUCK_COUNT picks stuck"
  [ -n "$STUCK_DETAIL" ] && echo "$STUCK_DETAIL"
else
  check "Sin picks stuck" fail "$STUCK_COUNT picks stuck — auto-resolver no funcionando"
  [ -n "$STUCK_DETAIL" ] && echo "$STUCK_DETAIL"
fi

# ─── Cleanup y resumen ───────────────────────────────────
rm -f "$HTML"
echo
echo "════════════════════════════════════════════════════"
echo "  Resumen: $PASS pass, $WARN warn, $FAIL fail"
echo "════════════════════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then
  exit 1
else
  exit 0
fi
