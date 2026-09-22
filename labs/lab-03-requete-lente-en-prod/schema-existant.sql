-- schema-existant.sql — L'ÉTAT ACTUEL DE LA PROD. Donné, NE SE MODIFIE PAS : c'est le point
-- de départ, pas ce que tu corriges (ta correction vit dans fix.sql, à côté).
CREATE TABLE families (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES families(id),
  author_id   uuid NOT NULL,
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Un index existe déjà — posé il y a longtemps, jamais remis en question depuis.
CREATE INDEX idx_posts_family_id ON posts (family_id);
