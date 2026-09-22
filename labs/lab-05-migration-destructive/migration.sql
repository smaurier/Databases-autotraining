-- migration.sql — PR d'un collègue, prête à merger. Ticket : « on doit pouvoir trier et
-- rechercher les membres par nom de famille — il faut splitter `full_name` en `first_name`
-- et `last_name`. » Ce fichier est CE QUI EST PROPOSÉ. Relis-le avant de le lancer.
ALTER TABLE members ADD COLUMN first_name text;
ALTER TABLE members ADD COLUMN last_name text;
ALTER TABLE members DROP COLUMN full_name;
