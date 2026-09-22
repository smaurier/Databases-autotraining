-- schema-existant.sql — DONNÉ, l'état de prod pour ce lab. Ne se modifie pas.
-- Trois migrations successives ont ajouté une colonne par nouveau type de post. Résultat :
-- la grande majorité des lignes ont la plupart de ces colonnes à NULL.
CREATE TABLE families (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES families(id),
  author_id       uuid NOT NULL,
  content         text NOT NULL,
  is_event        boolean NOT NULL DEFAULT false,
  event_date      date,
  event_location  text,
  is_pinned       boolean NOT NULL DEFAULT false,
  pinned_by       uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
