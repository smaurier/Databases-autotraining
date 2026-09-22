-- 001_init.sql — SOLUTION DE RÉFÉRENCE (commentée). Ne l'ouvre pas avant ton GREEN.
CREATE TABLE families (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES families(id),
  email       text NOT NULL,
  role        text NOT NULL CHECK (role IN ('admin', 'parent', 'enfant')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Composite, pas sur email seul : la même personne peut appartenir à plusieurs familles.
  UNIQUE (family_id, email)
);

-- Sert la requête "membres récemment arrivés, toutes familles" (ORDER BY created_at DESC
-- LIMIT 20) : sans lui, Postgres doit lire et trier les 100 000 lignes à chaque appel.
CREATE INDEX idx_members_created_at ON members (created_at);
