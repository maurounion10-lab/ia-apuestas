# Setup del Cron Resolver — UN SOLO PASO

El Worker `apuestas-api` ahora tiene un **cron que corre cada hora** que resuelve picks pendientes automáticamente (sin necesidad de que nadie entre al site). Para activarlo necesita la **service-role key de Supabase** como secret.

## Setup (una sola vez, ~3 minutos)

### Paso 1: Obtener la service-role key de Supabase

1. Abrí https://supabase.com/dashboard/project/ixfrtjvhnpapyuphqfxp/settings/api
2. Buscá la sección **Project API keys** → `service_role` (NO el anon).
3. Click el ícono de copiar.

⚠️ **Importante**: esta key bypassea RLS. **No la pegues en ningún archivo del repo ni la commitees**. Solo va al Cloudflare Worker como secret.

### Paso 2: Setear el secret en el Worker

Abrí Terminal (Aplicaciones → Utilidades → Terminal) y pegá:

```bash
cd /Users/tatenguefull/Downloads/ia-apuestas/worker
npx wrangler@latest secret put SUPABASE_SERVICE_ROLE_KEY
```

Te va a pedir que pegues el valor. Pegá la key, Enter. Listo.

### Paso 3: Deploy

Doble click en `deploy-gambeta.command` (en tu Descargas).

Después del deploy, el cron se activa automáticamente. Corre **cada hora en el minuto 0** (00:00, 01:00, 02:00…). Cada ejecución:

1. Lee picks pending de `acoin_users.historial_full`.
2. Para cada pick con kick-off >2h pasado y <21 días: consulta ESPN y/o TheSportsDB.
3. Si encuentra el score: calcula win/loss/void y actualiza el pick.
4. Upsert a `acoin_users.historial_full`. El trigger Postgres replica a `shared_cache` automáticamente.

A partir de ese momento, **los picks se resuelven solos sin que nadie tenga que abrir gambeta.ai**.

## Trigger manual (para testear o forzar)

```bash
curl https://apuestas-api.mauro-union10.workers.dev/cron-resolve
```

Devuelve un JSON con:
```json
{
  "checked": 5,
  "resolved": 3,
  "espn": 2,
  "tsdb": 1,
  "errors": 0,
  "log": ["Luzern vs Zurich: 1-0 → loss", ...]
}
```

## Verificar que el cron está corriendo

Después de 1 hora desde el deploy, abrí:

```bash
curl https://apuestas-api.mauro-union10.workers.dev/status
```

Deberías ver `"sb_service_key": "configured"` si todo está bien.

Para ver los logs del cron en tiempo real:

```bash
cd /Users/tatenguefull/Downloads/ia-apuestas/worker
npx wrangler@latest tail
```

Buscá líneas que empiecen con `[cron-resolver]`.

## Cambiar la frecuencia

En `worker/wrangler.toml`:

```toml
[triggers]
crons = ["0 * * * *"]   # actualmente: cada hora
# crons = ["*/15 * * * *"]  # cada 15 min
# crons = ["0 */6 * * *"]   # cada 6 horas
```

Después de cambiar, re-deploy.
