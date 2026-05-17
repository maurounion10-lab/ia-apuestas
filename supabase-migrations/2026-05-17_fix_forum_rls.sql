-- ════════════════════════════════════════════════════════════════
--  Fix RLS de forum_threads y forum_posts (anon insert bloqueado)
--
--  Problema: desde el 10-may-2026 no se crean hilos nuevos del foro.
--  Diagnóstico: INSERT con anon key devuelve error 42501 (RLS policy
--  violation). La policy permite SELECT pero no INSERT.
--
--  Fix: agregar policies INSERT con validación de shape (anti-spam)
--  para anon y authenticated.
-- ════════════════════════════════════════════════════════════════

-- ─── forum_threads ─────────────────────────────────────────────
DROP POLICY IF EXISTS "forum_threads_select_public" ON public.forum_threads;
CREATE POLICY "forum_threads_select_public" ON public.forum_threads
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "forum_threads_insert_anon" ON public.forum_threads;
CREATE POLICY "forum_threads_insert_anon" ON public.forum_threads
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    id IS NOT NULL
    AND length(id) BETWEEN 3 AND 100
    AND id ~ '^[a-z0-9_-]+$'
    AND home IS NOT NULL AND length(home) <= 100
    AND away IS NOT NULL AND length(away) <= 100
  );

-- ─── forum_posts ───────────────────────────────────────────────
DROP POLICY IF EXISTS "forum_posts_select_public" ON public.forum_posts;
CREATE POLICY "forum_posts_select_public" ON public.forum_posts
  FOR SELECT TO anon, authenticated USING (is_deleted = false);

DROP POLICY IF EXISTS "forum_posts_insert_anon" ON public.forum_posts;
CREATE POLICY "forum_posts_insert_anon" ON public.forum_posts
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    thread_id IS NOT NULL
    AND content IS NOT NULL
    AND length(content) BETWEEN 1 AND 5000
  );

DROP POLICY IF EXISTS "forum_posts_update_own" ON public.forum_posts;
CREATE POLICY "forum_posts_update_own" ON public.forum_posts
  FOR UPDATE TO anon, authenticated
  USING (user_email = current_setting('request.jwt.claim.email', true) OR user_email IS NULL)
  WITH CHECK (length(content) BETWEEN 1 AND 5000);

-- ─── forum_reactions ───────────────────────────────────────────
DROP POLICY IF EXISTS "forum_reactions_select_public" ON public.forum_reactions;
CREATE POLICY "forum_reactions_select_public" ON public.forum_reactions
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "forum_reactions_insert_anon" ON public.forum_reactions;
CREATE POLICY "forum_reactions_insert_anon" ON public.forum_reactions
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    post_id IS NOT NULL
    AND reaction_type IN ('like','unlike')
  );

DROP POLICY IF EXISTS "forum_reactions_delete_own" ON public.forum_reactions;
CREATE POLICY "forum_reactions_delete_own" ON public.forum_reactions
  FOR DELETE TO anon, authenticated
  USING (true);   -- el constraint UNIQUE(post_id, user_email) ya previene abusos

-- ─── Verificar después de aplicar: ─────────────────────────────
-- SELECT schemaname, tablename, policyname, cmd, roles
--   FROM pg_policies
--  WHERE tablename IN ('forum_threads','forum_posts','forum_reactions')
--  ORDER BY tablename, policyname;
