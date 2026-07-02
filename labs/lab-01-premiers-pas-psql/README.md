# Lab 01 — Premiers pas avec psql

> **Outcome :** à la fin, tu sais démarrer PostgreSQL 17 avec Docker, te connecter avec psql, créer les premières tables de TribuZen, insérer et interroger des données — en **SQL et psql réels**.
> **Vrai outil :** psql (méta-commandes `\d`, `\dt`, `\timing`, `\x`) et SQL natif PostgreSQL 17. Aucun simulateur, aucun framework.
> **Feedback :** le coach valide en session (pas de test-runner auto-correcteur).

## Énoncé

Tu initialises la base de données locale de TribuZen. PostgreSQL 17 est ton moteur cible, psql ton client. L'objectif est de mettre en place le schéma minimal (`family`, `member_user`), de vérifier que les contraintes déclarées fonctionnent comme prévu, et de te sentir à l'aise avec les méta-commandes d'exploration.

**Contexte de départ :** machine avec Docker installé, pas encore de conteneur PostgreSQL.

## Étapes (en friction)

1. **Démarrer PostgreSQL.** Lance un conteneur Docker `postgres:17` nommé `tribuzen-pg`, base `tribuzen`, utilisateur `postgres`, mot de passe `postgres`, port `5432` exposé, volume nommé `tribuzen-pgdata`. Vérifie avec `docker ps` que le conteneur est en état `Up`.

2. **Se connecter avec psql.** Entre dans psql via `docker exec`. Le prompt doit afficher `tribuzen=#`. Lance `\conninfo` pour confirmer la base et l'utilisateur.

3. **Explorer la base vide.** Lance `\dt` — tu dois voir `Did not find any relations.`. Lance `\l` pour lister toutes les bases du serveur. Lance `SELECT version();` pour afficher la version PostgreSQL.

4. **Créer la table `family`.** Colonnes requises : `id TEXT PRIMARY KEY`, `name TEXT NOT NULL`, `max_size INTEGER DEFAULT 10`, `created_at TIMESTAMPTZ DEFAULT now()`. Vérifie avec `\d family` que les contraintes sont présentes.

5. **Créer la table `member_user`.** Colonnes requises : `id TEXT NOT NULL PRIMARY KEY`, `email TEXT NOT NULL UNIQUE`, `display_name TEXT NOT NULL`, `created_at TIMESTAMPTZ DEFAULT now()`. Vérifie avec `\d member_user` — l'index unique sur `email` doit apparaître.

6. **Insérer des données.** Insère deux familles (`fam-1` / `Les Dupont`, `fam-2` / `Les Martin`) et deux utilisateurs (`u-1` / `alice@tribu.fr` / `Alice Dupont`, `u-2` / `bob@tribu.fr` / `Bob Martin`). Vérifie avec `SELECT * FROM family;` et `SELECT * FROM member_user;`.

7. **Tester la contrainte UNIQUE.** Tente d'insérer un troisième utilisateur avec l'email `alice@tribu.fr` (déjà existant). Note le message d'erreur exact retourné par PostgreSQL.

8. **Méta-commandes psql.** Active `\timing`, exécute `SELECT COUNT(*) FROM family`, note le temps en ms. Bascule en mode vertical avec `\x`, exécute `SELECT * FROM member_user`, observe le format. Désactive `\x`. Quitte psql avec `\q`.

## Corrigé complet commenté

```bash
# Étape 1 — Démarrer PostgreSQL 17
docker run \
  --name tribuzen-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=tribuzen \
  -p 5432:5432 \
  -v tribuzen-pgdata:/var/lib/postgresql/data \
  -d \
  postgres:17

# Vérifier que le conteneur tourne
docker ps
# Attendu : tribuzen-pg  ...  Up X seconds  0.0.0.0:5432->5432/tcp

# Étape 2 — Se connecter avec psql
docker exec -it tribuzen-pg psql -U postgres -d tribuzen
# Prompt : tribuzen=#
```

```sql
-- Étape 3 — Explorer la base vide

\conninfo
-- You are connected to database "tribuzen" as user "postgres" via socket...

\dt
-- Did not find any relations.

\l
-- Liste toutes les bases : postgres, template0, template1, tribuzen

SELECT version();
-- PostgreSQL 17.x on x86_64-pc-linux-gnu, compiled by gcc...
```

```sql
-- Étape 4 — Créer la table family
CREATE TABLE family (
    id         TEXT        PRIMARY KEY,   -- clé primaire texte (UUID côté appli en prod)
    name       TEXT        NOT NULL,      -- nom obligatoire, NULL refusé
    max_size   INTEGER     DEFAULT 10,    -- capacité max du groupe
    created_at TIMESTAMPTZ DEFAULT now() -- horodatage UTC automatique
);

\d family
-- Colonne    | Type                          | Nullable | Défaut
-- -----------+-------------------------------+----------+--------
-- id         | text                          | not null |
-- name       | text                          | not null |
-- max_size   | integer                       |          | 10
-- created_at | timestamp with time zone      |          | now()
-- Index : "family_pkey" PRIMARY KEY, btree (id)
```

```sql
-- Étape 5 — Créer la table member_user
-- Attention : USER est un mot réservé SQL — ne jamais nommer une table "user"
CREATE TABLE member_user (
    id           TEXT NOT NULL PRIMARY KEY,
    email        TEXT NOT NULL UNIQUE,      -- UNIQUE crée un index automatique
    display_name TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT now()
);

\d member_user
-- Index : "member_user_pkey" PRIMARY KEY, btree (id)
--         "member_user_email_key" UNIQUE CONSTRAINT, btree (email)
-- L'index unique est créé automatiquement par la contrainte UNIQUE.
```

```sql
-- Étape 6 — Insérer des données
INSERT INTO family (id, name) VALUES
    ('fam-1', 'Les Dupont'),
    ('fam-2', 'Les Martin');

INSERT INTO member_user (id, email, display_name) VALUES
    ('u-1', 'alice@tribu.fr', 'Alice Dupont'),
    ('u-2', 'bob@tribu.fr',   'Bob Martin');

-- Vérifier
SELECT * FROM family;
--  id    |   name     | max_size |       created_at
-- -------+------------+----------+------------------------
--  fam-1 | Les Dupont |       10 | 2026-07-01 14:00:00+02
--  fam-2 | Les Martin |       10 | 2026-07-01 14:00:00+02

SELECT id, email, display_name FROM member_user;
--  id  |      email      | display_name
-- -----+-----------------+--------------
--  u-1 | alice@tribu.fr  | Alice Dupont
--  u-2 | bob@tribu.fr    | Bob Martin
```

```sql
-- Étape 7 — Tester la contrainte UNIQUE
INSERT INTO member_user (id, email, display_name)
VALUES ('u-3', 'alice@tribu.fr', 'Alice Bis');
-- ERROR:  duplicate key value violates unique constraint "member_user_email_key"
-- DETAIL: Key (email)=(alice@tribu.fr) already exists.
--
-- PostgreSQL refuse l'insertion sans code applicatif.
-- L'erreur vient du moteur, pas d'un IF dans le backend.
```

```sql
-- Étape 8 — Méta-commandes psql
\timing
-- Timing is on.

SELECT COUNT(*) AS total FROM family;
--  total
-- -------
--      2
-- Time: 0.543 ms

\x
-- Expanded display is on.

SELECT * FROM member_user;
-- -[ RECORD 1 ]---------------
-- id           | u-1
-- email        | alice@tribu.fr
-- display_name | Alice Dupont
-- created_at   | 2026-07-01 14:00:00+02
-- -[ RECORD 2 ]---------------
-- id           | u-2
-- email        | bob@tribu.fr
-- display_name | Bob Martin
-- created_at   | 2026-07-01 14:00:00+02

\x
-- Expanded display is off.

\timing
-- Timing is off.

\q
-- Retour au terminal
```

Points de validation par le coach : (a) prompt `tribuzen=#` sans erreur de connexion ; (b) `\d family` affiche `TIMESTAMPTZ DEFAULT now()` et la contrainte `family_pkey` ; (c) `\d member_user` affiche l'index `member_user_email_key` créé automatiquement par `UNIQUE` ; (d) l'INSERT avec email dupliqué produit `duplicate key value violates unique constraint` — erreur moteur, pas applicative ; (e) `\timing` affiche un temps en ms après chaque requête ; (f) `\x` change le format d'affichage sans modifier les données.

## Variante J+30 (fading)

Reprends sans relire le corrigé, **en 15 minutes**, et ajoute la table suivante à la base TribuZen :

```sql
-- Table invitation
-- Colonnes attendues :
--   id         TEXT PRIMARY KEY
--   family_id  TEXT NOT NULL
--   email      TEXT NOT NULL
--   status     TEXT NOT NULL DEFAULT 'pending'
--   created_at TIMESTAMPTZ DEFAULT now()
-- Contrainte : status doit être 'pending', 'accepted' ou 'declined'
--              (utilise une contrainte CHECK inline)
```

Justifie à voix haute : pourquoi `CHECK` et pas un `BOOLEAN` pour `status` ? Quel type PostgreSQL utiliserais-tu à la place pour un ensemble fini de valeurs (`ENUM`, `TEXT` avec `CHECK`, ou `SMALLINT`) et quels sont les compromis de chaque choix ?

## Application TribuZen

Porte ce lab dans le vrai repo `smaurier/tribuzen` :

1. Si le conteneur est stoppé, le relancer avec `docker start tribuzen-pg` (pas `docker run` — les données seraient perdues).
2. Crée un fichier `db/schema/00-init.sql` contenant les deux `CREATE TABLE` de ce lab.
3. Charge-le dans psql : `docker exec -i tribuzen-pg psql -U postgres -d tribuzen < db/schema/00-init.sql`.
4. Vérifie avec `\dt` que les deux tables sont présentes, et avec `\d family` que les contraintes sont correctes.
5. Commit `smaurier/tribuzen` : `feat(db): schema initial — tables family et member_user (lab-01)`.
