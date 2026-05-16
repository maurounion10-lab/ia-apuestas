-- ════════════════════════════════════════════════════════════════════════
-- Trigger: sync automático acoin_users.historial_full → shared_cache
-- ════════════════════════════════════════════════════════════════════════
--
-- PROBLEMA:
--   El sync de shared_cache.global_historial_v1 dependía de que el admin
--   estuviera logueado en el browser (el client llamaba a sbSaveGlobalHistorial).
--   Si admin no se logueaba durante días, shared_cache quedaba stuck con datos
--   viejos mientras acoin_users.historial_full seguía recibiendo updates.
--   Eso pasó: shared_cache stuck en 38 picks desde 19-mar-2026 mientras
--   acoin_users tenía 466 picks al 14-may-2026.
--
-- SOLUCIÓN:
--   Un trigger Postgres que detecta UPDATE/INSERT en acoin_users.historial_full
--   para email = admin, y replica ese array a shared_cache automáticamente.
--   Independiente del browser. Imposible que queden desincronizados.
--
-- INSTALACIÓN:
--   Copiar este archivo entero al SQL Editor de Supabase Dashboard
--   (https://supabase.com/dashboard/project/ixfrtjvhnpapyuphqfxp/sql)
--   y hacer click en "Run".
--
-- ════════════════════════════════════════════════════════════════════════

-- 1) Función que ejecuta el sync.
-- SECURITY DEFINER → corre con permisos del owner, bypassea RLS de shared_cache.
CREATE OR REPLACE FUNCTION public.sync_admin_historial_to_cache()
RETURNS TRIGGER AS $$
BEGIN
  -- Solo cuando admin actualiza su historial con un array no-vacío.
  IF NEW.email = 'mauro.union10@gmail.com'
     AND NEW.historial_full IS NOT NULL
     AND jsonb_array_length(NEW.historial_full::jsonb) > 0 THEN

    INSERT INTO public.shared_cache (key, data, fetched_at)
    VALUES (
      'global_historial_v1',
      NEW.historial_full,
      NOW()
    )
    ON CONFLICT (key) DO UPDATE
      SET data = EXCLUDED.data,
          fetched_at = EXCLUDED.fetched_at;

  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 2) Drop trigger si ya existe (idempotencia)
DROP TRIGGER IF EXISTS sync_admin_historial_trigger ON public.acoin_users;

-- 3) Trigger que se dispara solo cuando historial_full cambia
CREATE TRIGGER sync_admin_historial_trigger
  AFTER INSERT OR UPDATE OF historial_full
  ON public.acoin_users
  FOR EACH ROW
  WHEN (NEW.email = 'mauro.union10@gmail.com')
  EXECUTE FUNCTION public.sync_admin_historial_to_cache();

-- 4) FORZAR SYNC INICIAL — copiar los 466 picks actuales de acoin_users a shared_cache
-- Esto resuelve el lag actual (shared_cache stuck en 38 picks desde marzo).
-- IMPORTANTE: hay que re-asignar historial_full (no solo updated_at) para que el trigger
-- "AFTER UPDATE OF historial_full" se dispare. SET col = col toca la columna pero no cambia datos.
UPDATE public.acoin_users
SET historial_full = historial_full,
    updated_at = NOW()
WHERE email = 'mauro.union10@gmail.com'
  AND historial_full IS NOT NULL;

-- 5) Verificación
SELECT
  'shared_cache' AS source,
  jsonb_array_length(data::jsonb) AS count,
  fetched_at
FROM public.shared_cache
WHERE key = 'global_historial_v1'

UNION ALL

SELECT
  'acoin_users.historial_full' AS source,
  jsonb_array_length(historial_full::jsonb) AS count,
  updated_at AS fetched_at
FROM public.acoin_users
WHERE email = 'mauro.union10@gmail.com';

-- Después de instalar, ambas filas deben tener el MISMO count.
-- A partir de este momento, todo UPDATE a acoin_users.historial_full
-- replicará automáticamente a shared_cache, sin importar quién esté logueado.
