-- migration.sql — PR d'un collègue, prête à merger. Ticket : « consolider is_event/
-- event_date/event_location/is_pinned/pinned_by en une seule colonne `metadata` JSONB,
-- indexée pour les recherches par type de post. » La table `posts` est EN PRODUCTION, avec
-- du trafic d'écriture continu (nouveaux posts à toute heure).
BEGIN;

ALTER TABLE posts ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE posts SET metadata =
  jsonb_build_object('type', CASE WHEN is_event THEN 'event' WHEN is_pinned THEN 'pinned' ELSE 'simple' END)
  || CASE WHEN is_event THEN jsonb_build_object('event_date', event_date, 'event_location', event_location) ELSE '{}'::jsonb END
  || CASE WHEN is_pinned THEN jsonb_build_object('pinned_by', pinned_by) ELSE '{}'::jsonb END;

CREATE INDEX idx_posts_metadata ON posts USING GIN (metadata);

ALTER TABLE posts
  DROP COLUMN is_event,
  DROP COLUMN event_date,
  DROP COLUMN event_location,
  DROP COLUMN is_pinned,
  DROP COLUMN pinned_by;

COMMIT;
