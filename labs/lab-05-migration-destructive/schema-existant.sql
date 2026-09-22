-- schema-existant.sql — DONNÉ, l'état de prod pour ce lab. Ne se modifie pas.
-- Décision historique (an 1 du produit) : un seul champ `full_name` en texte libre. Le
-- produit a maintenant besoin de trier/rechercher les membres par nom de famille.
CREATE TABLE families (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES families(id),
  email       text NOT NULL,
  full_name   text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin', 'parent', 'enfant')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, email)
);
