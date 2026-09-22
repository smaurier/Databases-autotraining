-- migration.sql — SOLUTION DE RÉFÉRENCE (commentée). Ne l'ouvre pas avant ton GREEN.
-- Le split doit être RÉVERSIBLE avant de droper `full_name` : on backfill first_name/
-- last_name à partir des données existantes, on vérifie qu'on peut reconstruire l'original,
-- et seulement ensuite on droppe la colonne source — le tout dans UNE transaction, pour ne
-- jamais laisser la table dans un état à moitié migré si quelque chose échoue en route.
BEGIN;

ALTER TABLE members ADD COLUMN first_name text;
ALTER TABLE members ADD COLUMN last_name text;

-- Split sur le PREMIER espace : "Jean-Paul De La Fontaine" -> "Jean-Paul" / "De La Fontaine".
-- Un nom sans espace ("Cher") devient first_name="Cher", last_name="" — trim(first || ' ' ||
-- last) redonne alors exactement l'original, sans espace parasite.
UPDATE members
SET
  first_name = CASE
    WHEN position(' ' in full_name) > 0
      THEN substring(full_name from 1 for position(' ' in full_name) - 1)
    ELSE full_name
  END,
  last_name = CASE
    WHEN position(' ' in full_name) > 0
      THEN substring(full_name from position(' ' in full_name) + 1)
    ELSE ''
  END;

ALTER TABLE members ALTER COLUMN first_name SET NOT NULL;
ALTER TABLE members ALTER COLUMN last_name SET NOT NULL;

ALTER TABLE members DROP COLUMN full_name;

COMMIT;
