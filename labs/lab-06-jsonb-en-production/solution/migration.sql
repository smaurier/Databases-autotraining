-- migration.sql — SOLUTION DE RÉFÉRENCE (commentée). Ne l'ouvre pas avant ton GREEN.
-- `posts` est une table VIVANTE : tout DDL (`ALTER TABLE`) pose un verrou ACCESS EXCLUSIVE,
-- gardé jusqu'au COMMIT de SA transaction. Le piège n'est pas seulement l'index — c'est de
-- laisser un DDL et un gros UPDATE dans la MÊME transaction : le verrou de l'ALTER TABLE
-- resterait posé pendant tout le backfill. Quatre étapes, chacune sa propre transaction
-- implicite (le runner d'oracle les exécute séparément, jamais regroupées) :

-- @step
-- 1) Ajouter la colonne : verrou exclusif, mais quasi instantané — défaut constant, pas de
--    réécriture de table (comportement PG11+).
ALTER TABLE posts ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- @step
-- 2) Backfill : un simple UPDATE ne prend qu'un verrou ROW EXCLUSIVE — ne bloque PAS les
--    INSERT concurrents sur d'autres lignes. Volontairement SEUL dans son étape : s'il était
--    resté dans la transaction de l'ADD COLUMN ci-dessus, le verrou exclusif de celui-ci
--    serait resté posé pendant tout le backfill.
UPDATE posts SET metadata =
  jsonb_build_object('type', CASE WHEN is_event THEN 'event' WHEN is_pinned THEN 'pinned' ELSE 'simple' END)
  || CASE WHEN is_event THEN jsonb_build_object('event_date', event_date, 'event_location', event_location) ELSE '{}'::jsonb END
  || CASE WHEN is_pinned THEN jsonb_build_object('pinned_by', pinned_by) ELSE '{}'::jsonb END;

-- @step
-- 3) CONCURRENTLY : NE PEUT PAS s'exécuter dans un bloc de transaction — c'est justement ce
--    qui la rend possible en prod. Prend un verrou plus faible (SHARE UPDATE EXCLUSIVE),
--    laisse les écritures continuer pendant qu'elle construit l'index en tâche de fond.
CREATE INDEX CONCURRENTLY idx_posts_metadata ON posts USING GIN (metadata);

-- @step
-- 4) Nettoyage : verrou exclusif, mais bref — pas de gros travail dans cette transaction.
ALTER TABLE posts
  DROP COLUMN is_event,
  DROP COLUMN event_date,
  DROP COLUMN event_location,
  DROP COLUMN is_pinned,
  DROP COLUMN pinned_by;
