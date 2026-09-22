-- schema.sql — DONNÉ, l'état de prod pour ce lab. Ne se modifie pas.
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
  bio         text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, email)
);
