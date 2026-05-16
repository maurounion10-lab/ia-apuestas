# CLAUDE.md — Notas para mí (Claude) sobre este proyecto

Este archivo lo lee Claude (yo) al empezar cada sesión sobre gambeta.ai.
No es para el usuario — son recordatorios y reglas operativas que descubrí.

---

## Workflow obligatorio cuando edito código

Cuando Mauro me pide cambios al código:

1. **Localizo el cambio puntualmente** (Grep, Read con offset, no leer archivo entero).
2. **Edito con Edit tool** (no Write a menos que sea archivo nuevo).
3. **Valido sintaxis JS** antes de declarar listo:
   ```bash
   python3 -c "
   import re
   with open('/Users/tatenguefull/Downloads/ia-apuestas/index.html') as f: c = f.read()
   blocks = re.findall(r'<script(?![^>]*\bsrc=)(?![^>]*type=\"application/ld\+json\")[^>]*>(.*?)</script>', c, flags=re.DOTALL)
   with open('/tmp/check.js','w') as f: f.write('\n;\n'.join(blocks))
   "
   node --check /tmp/check.js
   ```
4. **Le pido a Mauro que ejecute `deploy-gambeta.command`** — no puedo deployar yo.
5. **Después del deploy, corro `bash scripts/verify-deploy.sh`** — esto es OBLIGATORIO antes de decir "listo".
6. Si el verify falla, **lo arreglo antes de devolver control a Mauro**.

**Nunca declarar "listo" sin haber corrido verify-deploy.sh contra producción.**

---

## Estructura del proyecto

- `index.html` (~22k líneas) — toda la app (HTML + CSS + JS inline).
- `functions/api/sb.js` — Cloudflare Pages function, proxy a Supabase con caché edge.
- `sw2.js` — service worker, bypassea `/api/*` y `*supabase.co`.
- `scripts/verify-deploy.sh` — checks automáticos post-deploy.
- `supabase-migrations/*.sql` — SQL para correr manualmente en Supabase Dashboard.
- `deploy-gambeta.command` — script bash que Mauro ejecuta con doble click para deploy.

---

## Maps consolidados (no romper esto)

**Antes**: había DOS funciones `shortName` (líneas 8975 y 14502) y `teamLogos` tenía 220 keys duplicadas.

**Después de la consolidación del 14-may-2026**:
- UNA sola función `shortName` (~línea 14490) que usa `teamShortNames` (~línea 14233).
- `teamLogos` deduplicada con preferencia api-sports.io > espncdn > wikipedia > thesportsdb.
- ~82 aliases auto-generados para que formas cortas encuentren su logo.

**Regla**: nunca volver a duplicar. Si encuentro un equipo que necesita short name o logo nuevo, agrego al map único, no creo nuevos maps.

---

## Sincronización de historial (3 capas)

El historial admin existe en 3 lugares que deben mantenerse iguales:

1. **localStorage** (cliente) — escrito por `saveHistorial(arr)`.
2. **acoin_users.historial_full** (Supabase) — escrito por `sbSaveHistorial`.
3. **shared_cache.global_historial_v1** (Supabase) — leído por el `/api/sb` proxy. Es lo que ven los usuarios anónimos.

**Antes**: el sync de #3 dependía del browser del admin. Si Mauro no se logueaba, #3 quedaba stuck. Pasó: stuck en 38 picks desde marzo mientras #2 tenía 466.

**Después**:
- **Trigger Postgres** (`supabase-migrations/2026-05-14_sync_admin_historial_trigger.sql`) replica #2 → #3 automáticamente. Server-side, no depende del browser.
- **`sbReconcileSharedCache()`** corre al login del admin como red de seguridad.

**Si verify-deploy.sh reporta drift > 50**: el trigger no está instalado. Hay que correr el SQL en Supabase Dashboard.

---

## Auto-resolver de scores

Hay DOS resolvers en paralelo:

**A. Client-side** (en `index.html`)
1. `loadHistoricalScores()` se llama desde `renderHistorial()` (max 1×/30s).
2. Fetch a **ESPN API** (`site.api.espn.com/.../scoreboard?dates=YYYYMMDD`) por cada liga × fecha.
3. Si quedan picks pendientes de ligas no-ESPN, **fallback a TheSportsDB** (`searchevents.php?e=Home_vs_Away`).
4. `resolveAllGames(allScores)` matchea y calcula win/loss/void.

**B. Server-side cron** (en `worker/index.js`, función `runScheduledResolver`)
1. **Corre cada hora automáticamente** sin importar si alguien entra al site.
2. Misma lógica que A, pero replicada en el Worker.
3. Requiere `SUPABASE_SERVICE_ROLE_KEY` como secret en Cloudflare (ver `SETUP-CRON-RESOLVER.md`).
4. Escribe a `acoin_users.historial_full` con service_role; el trigger Postgres replica a `shared_cache`.
5. Endpoint manual: `GET https://apuestas-api.mauro-union10.workers.dev/cron-resolve` (devuelve JSON con stats).

**Ligas que ESPN NO cubre** (siempre necesitan TSDB — listadas en `TSDB_ONLY_LEAGUES` del Worker):
- Polish Ekstraklasa, Swiss Super League, Belgian Pro League, Austrian Bundesliga, Danish/Swedish/Norwegian top divisions.

**Si verify-deploy.sh reporta "picks stuck"**: chequear que el cron del Worker esté activo (`/status` → `sb_service_key: configured`) y que el secret esté seteado. Si TSDB tampoco tiene el match → agregar a `_MANUAL_SCORES` como último recurso.

---

## Cosas que NUNCA hacer

1. **Nunca deployar yo** — no tengo ese permiso. Siempre pedirle a Mauro que ejecute `deploy-gambeta.command`.
2. **Nunca leer `index.html` completo** (22k líneas, exhaust context). Usar Grep + Read con offset/limit.
3. **Nunca cambiar `display:none` del `#mipanel`** — decisión de UX del 14-may-2026, queda oculto del home.
4. **Nunca borrar `BLOCKED_HIST_IDS`** — son picks contaminados por el attack del admin@gambeta.ai.
5. **Nunca crear nuevos maps de equipos** — agregar al existente `teamLogos` / `teamShortNames`.
6. **Nunca declarar "listo" sin haber corrido verify-deploy.sh** — incluso si yo creo que está bien.

---

## Comandos útiles

```bash
# Validar sintaxis JS
node --check /tmp/extracted.js

# Estado actual de Supabase (sin auth)
curl -s "https://gambeta.ai/api/sb?type=historial" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'historial: {len(d[0][\"historial_full\"])} picks')"

# Verify deploy completo
bash /Users/tatenguefull/Downloads/ia-apuestas/scripts/verify-deploy.sh

# Buscar deploy actual del cloud
curl -s --compressed https://gambeta.ai/ | head -100
```

---

## Mauro

- Email admin: **mauro.union10@gmail.com**.
- Está en Argentina, habla español rioplatense (vos, "querés", etc.). Le respondo así.
- Tiene un bookmaker site con picks de fútbol. No es dev — prefiere instrucciones simples ("doble click en X", "copy-paste esto").
- Suele frustrarse cuando los mismos bugs vuelven. **Por eso verify-deploy.sh existe**: para que yo detecte regresiones antes que él.
