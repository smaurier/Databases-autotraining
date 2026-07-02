# Lab 14 — Sécurité et Row-Level Security

> **Vrai outil :** SQL sur une base PostgreSQL locale (Docker).
> Audit-first : chaque exercice part d'un état non sécurisé, puis installe la protection couche par couche et vérifie.

## Pré-requis

- Module 14 terminé
- Base Docker disponible :

```bash
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17
```

---

## Setup — schéma TribuZen et données

Ouvrir `psql` et coller le bloc complet. Il crée les tables, insère les données et crée le rôle applicatif.

```sql
-- Nettoyer si le lab a déjà été joué
DROP TABLE IF EXISTS posts, families CASCADE;
DROP ROLE IF EXISTS tribuzen_api;

-- Schéma TribuZen minimal
CREATE TABLE families (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE posts (
  id         SERIAL PRIMARY KEY,
  family_id  INT NOT NULL REFERENCES families(id),
  author_id  INT NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2 familles, 3 posts chacune
INSERT INTO families (name) VALUES ('Famille Dupont'), ('Famille Martin');

INSERT INTO posts (family_id, author_id, content) VALUES
  (1, 1, 'Vacances Dupont — côte bretonne'),
  (1, 2, 'Réunion Dupont — dimanche'),
  (1, 1, 'Photo Dupont — plage'),
  (2, 3, 'Vacances Martin — montagne'),
  (2, 4, 'Anniversaire Martin — mercredi'),
  (2, 3, 'Photo Martin — neige');

-- Rôle applicatif — pas de DDL, pas de TRUNCATE
CREATE ROLE tribuzen_api WITH LOGIN PASSWORD 'mdp_fort_1234';
GRANT SELECT, INSERT, UPDATE, DELETE ON posts    TO tribuzen_api;
GRANT SELECT                          ON families TO tribuzen_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tribuzen_api;

ANALYZE;
```

---

## Exercice 1 — Audit : droits excessifs

**Objectif :** mesurer ce que le rôle applicatif peut faire au-delà de ce qui est nécessaire.

```sql
-- Tester en se plaçant dans le rôle applicatif
SET ROLE tribuzen_api;

-- Peut-il lire les posts ? (attendu : oui)
SELECT COUNT(*) FROM posts;

-- Peut-il faire DROP TABLE ? (attendu : non — mais le vérifie-t-on vraiment ?)
DROP TABLE posts;
-- Résultat observé : ?

-- Peut-il TRUNCATE ?
TRUNCATE posts;
-- Résultat observé : ?

-- Peut-il créer un nouveau rôle ?
CREATE ROLE role_pirate WITH LOGIN PASSWORD 'pwd';
-- Résultat observé : ?

RESET ROLE;
```

**Questions d'audit :**
1. `DROP TABLE` échoue-t-il ? Pourquoi (quel droit manque-t-il) ?
2. `TRUNCATE` échoue-t-il ? TRUNCATE est-il couvert par `DELETE` ?
3. Que se passe-t-il si l'application est compromise et exécute une commande DDL ?

---

## Exercice 1 — Fix : vérifier les droits accordés

```sql
-- Lister les privilèges accordés à tribuzen_api sur la table posts
SELECT grantee, privilege_type, is_grantable
FROM information_schema.role_table_grants
WHERE table_name = 'posts'
  AND grantee = 'tribuzen_api'
ORDER BY privilege_type;

-- Attendu : SELECT, INSERT, UPDATE, DELETE — pas TRUNCATE, pas CREATE
```

**Checkpoint :** `TRUNCATE` n'est pas dans la liste. PostgreSQL distingue `DELETE` (ligne par ligne, avec policies RLS et triggers) de `TRUNCATE` (vidage total, bypass RLS) — l'API ne doit avoir que `DELETE`.

---

## Exercice 2 — Audit : absence de RLS (fuite de données)

**Objectif :** observer qu'un rôle applicatif sans filtre voit toutes les familles.

```sql
SET ROLE tribuzen_api;

-- Simuler un bug : handler qui oublie le WHERE family_id
SELECT id, family_id, content FROM posts ORDER BY id;
-- Résultat attendu : 6 lignes — Dupont ET Martin — fuite complète

-- Même avec un "bon" filtre, RLS n'existe pas encore :
-- un attaquant qui injecte ' OR 1=1 --' dans family_id voit tout
SELECT COUNT(*) FROM posts;   -- → 6

RESET ROLE;
```

**Questions d'audit :**
1. Combien de familles différentes apparaissent dans le résultat ?
2. Si l'application plante entre deux requêtes et ne pose pas de filtre, qui voit quoi ?
3. Quelle couche peut garantir le filtrage même si le code applicatif est buggé ?

---

## Exercice 2 — Fix : activer RLS et créer les policies

```sql
-- Activer RLS (deny-by-default après activation)
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
-- Soumettre également le propriétaire aux policies
ALTER TABLE posts FORCE ROW LEVEL SECURITY;

-- Policy SELECT : chaque famille ne voit que ses posts
CREATE POLICY posts_family_select ON posts
  FOR SELECT
  USING (family_id = current_setting('app.family_id', true)::int);

-- Policy INSERT : ne peut insérer que dans son propre espace
CREATE POLICY posts_family_insert ON posts
  FOR INSERT
  WITH CHECK (family_id = current_setting('app.family_id', true)::int);

-- Policy UPDATE : USING filtre les lignes modifiables ; WITH CHECK valide la nouvelle ligne
CREATE POLICY posts_family_update ON posts
  FOR UPDATE
  USING  (family_id = current_setting('app.family_id', true)::int)
  WITH CHECK (family_id = current_setting('app.family_id', true)::int);

-- Policy DELETE : filtre les lignes supprimables
CREATE POLICY posts_family_delete ON posts
  FOR DELETE
  USING (family_id = current_setting('app.family_id', true)::int);

-- Vérifier les policies créées
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE tablename = 'posts';
```

---

## Exercice 2 — Vérifie : isolation famille

```sql
SET ROLE tribuzen_api;

-- 1. Sans contexte : deny-by-default
SELECT COUNT(*) FROM posts;
-- → 0  (missing_ok → NULL → aucune comparaison ne passe)

-- 2. Contexte famille 1 (is_local=true : LOCAL à la transaction)
BEGIN;
SELECT set_config('app.family_id', '1', true);
SELECT id, family_id, content FROM posts ORDER BY id;
-- → 3 lignes (Dupont uniquement)
COMMIT;

-- 3. Contexte famille 2
BEGIN;
SELECT set_config('app.family_id', '2', true);
SELECT id, family_id, content FROM posts ORDER BY id;
-- → 3 lignes (Martin uniquement)
COMMIT;

-- 4. INSERT cross-famille : bloqué par WITH CHECK
BEGIN;
SELECT set_config('app.family_id', '1', true);
INSERT INTO posts (family_id, author_id, content)
  VALUES (2, 1, 'Post frauduleux dans Martin');
-- ERROR: new row violates row-level security policy for table "posts"
ROLLBACK;

-- 5. UPDATE qui tente de changer le family_id (déplacement cross-famille) : bloqué
BEGIN;
SELECT set_config('app.family_id', '1', true);
UPDATE posts SET family_id = 2 WHERE id = 1;
-- ERROR: new row violates row-level security policy for table "posts"
ROLLBACK;

-- 6. UPDATE sur un post d'une autre famille : invisible → 0 lignes affectées
BEGIN;
SELECT set_config('app.family_id', '1', true);
UPDATE posts SET content = 'Modifié' WHERE family_id = 2;
-- UPDATE 0  (silencieux — les lignes sont invisibles)
COMMIT;

RESET ROLE;
```

**Checkpoints :**
- Sans contexte : `COUNT(*) = 0` (deny-by-default).
- Famille 1 voit exactement 3 posts, famille 2 voit exactement 3 posts.
- INSERT cross-famille → erreur explicite.
- UPDATE qui modifie `family_id` → erreur explicite (WITH CHECK).
- UPDATE sur post invisible → `UPDATE 0` silencieux.

---

## Exercice 3 — Audit : injection SQL sans requête paramétrée

**Objectif :** comprendre pourquoi la concaténation est dangereuse, même avec RLS.

RLS filtre les lignes visibles mais ne protège pas contre la modification de la **structure** de la requête SQL elle-même. Si une valeur externe est concaténée, elle peut modifier la logique de la requête.

```sql
-- Simuler ce qu'un code applicatif défectueux ferait :
-- family_id = '1 OR 1=1 --' (injection classique)

-- Avec DO/EXECUTE pour simuler la concaténation dynamique
DO $$
DECLARE
  family_id_param TEXT := '1 OR 1=1 --';  -- valeur malveillante
  requete TEXT;
BEGIN
  -- Construction DANGEREUSE : concaténation directe
  requete := 'SELECT id, content FROM posts WHERE family_id = ' || family_id_param;
  RAISE NOTICE 'Requête construite : %', requete;
  -- La requête devient : SELECT ... WHERE family_id = 1 OR 1=1 --
  -- → retournerait TOUTES les lignes si exécutée
END;
$$;

-- La sortie NOTICE montre la requête injectée.
-- Avec EXECUTE, elle retournerait toutes les familles malgré RLS
-- (RLS filtre par session ; OR 1=1 contourne le WHERE mais pas les policies).
-- Mais : une injection plus sophistiquée peut exécuter du DDL ou extraire le schéma.
```

**Questions d'audit :**
1. Quelle est la requête SQL résultante avec `family_id = '1 OR 1=1 --'` ?
2. RLS bloquerait-il cette injection (rappel : le contexte `app.family_id` est `'1'`) ?
3. Qu'est-ce qu'une requête paramétrée empêche que RLS ne peut pas empêcher ?

---

## Exercice 3 — Fix : requête paramétrée

```sql
-- SÛR : utiliser EXECUTE ... USING $1 (requête paramétrée dans PL/pgSQL)
DO $$
DECLARE
  family_id_param INT := 1;  -- valeur validée (INT, pas TEXT)
  nb_posts INT;
BEGIN
  EXECUTE 'SELECT COUNT(*) FROM posts WHERE family_id = $1'
    INTO nb_posts
    USING family_id_param;
  RAISE NOTICE 'Posts famille % : %', family_id_param, nb_posts;
  -- $1 est toujours traité comme entier, jamais comme SQL
  -- Impossible d'injecter via $1
END;
$$;

-- Tester avec une valeur hostile : le cast INT empêche même la construction
DO $$
DECLARE
  -- Ceci lèverait une erreur avant même la requête :
  -- family_id_param INT := '1 OR 1=1'::INT;
  -- → ERROR: invalid input syntax for type integer: "1 OR 1=1"
  family_id_param INT := 1;
BEGIN
  RAISE NOTICE 'family_id_param = %', family_id_param;
END;
$$;
```

**Checkpoint :** `$1` dans `EXECUTE ... USING` est traité comme donnée scalaire — la chaîne `'1 OR 1=1'` ne peut pas être castée en `INT`, l'injection est impossible structurellement.

---

## Exercice 4 — Sauvegarde pg_dump et restauration

**Objectif :** sauvegarder la base TribuZen et vérifier que la restauration est complète.

```bash
# Depuis le terminal (hors psql)

# 1. Dump en format custom (compressé, restauration sélective)
pg_dump -U postgres -d postgres -Fc -f tribuzen_lab14.dump

# 2. Vérifier la taille du dump
ls -lh tribuzen_lab14.dump

# 3. Lister le contenu du dump sans restaurer
pg_restore --list tribuzen_lab14.dump

# 4. Créer une base de test pour la restauration
psql -U postgres -c "CREATE DATABASE tribuzen_restore;"

# 5. Restaurer
pg_restore -U postgres -d tribuzen_restore tribuzen_lab14.dump

# 6. Vérifier la restauration
psql -U postgres -d tribuzen_restore -c "SELECT COUNT(*) FROM posts;"
# → 6 (toutes les lignes restaurées)

psql -U postgres -d tribuzen_restore -c "
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;"
# → families, posts

# 7. Restaurer une seule table (utile pour récupération ponctuelle)
pg_restore -U postgres -d tribuzen_restore -t posts --data-only tribuzen_lab14.dump

# 8. Nettoyage
psql -U postgres -c "DROP DATABASE tribuzen_restore;"
rm tribuzen_lab14.dump
```

**Checkpoints :**
- Le dump existe sur le disque et sa taille est non nulle.
- Après restauration, `SELECT COUNT(*) FROM posts` retourne 6.
- Les deux tables `families` et `posts` sont présentes dans la base restaurée.
- La restauration d'une seule table avec `-t posts` fonctionne (format `-Fc` requis).

---

## Récapitulatif des commandes SQL du lab

```sql
-- Vérifier les droits du rôle
SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_name = 'posts' AND grantee = 'tribuzen_api';

-- Vérifier l'état RLS sur la table
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class WHERE relname = 'posts';
-- relrowsecurity = true : ENABLE ROW LEVEL SECURITY actif
-- relforcerowsecurity = true : FORCE actif (propriétaire soumis)

-- Lister les policies actives
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies WHERE tablename = 'posts';
```

---

## Corrigé complet — commandes dans l'ordre

```sql
-- 0. SETUP
DROP TABLE IF EXISTS posts, families CASCADE;
DROP ROLE IF EXISTS tribuzen_api;
CREATE TABLE families (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  family_id INT NOT NULL REFERENCES families(id),
  author_id INT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO families (name) VALUES ('Famille Dupont'), ('Famille Martin');
INSERT INTO posts (family_id, author_id, content) VALUES
  (1, 1, 'Vacances Dupont — côte bretonne'),
  (1, 2, 'Réunion Dupont — dimanche'),
  (1, 1, 'Photo Dupont — plage'),
  (2, 3, 'Vacances Martin — montagne'),
  (2, 4, 'Anniversaire Martin — mercredi'),
  (2, 3, 'Photo Martin — neige');
CREATE ROLE tribuzen_api WITH LOGIN PASSWORD 'mdp_fort_1234';
GRANT SELECT, INSERT, UPDATE, DELETE ON posts    TO tribuzen_api;
GRANT SELECT                          ON families TO tribuzen_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tribuzen_api;
ANALYZE;

-- 1. AUDIT droits (SET ROLE tribuzen_api)
-- DROP TABLE posts; → ERROR: must be owner
-- TRUNCATE posts;   → ERROR: permission denied (TRUNCATE ≠ DELETE)
-- CREATE ROLE ...;  → ERROR: permission denied

-- 2. FIX RLS
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts FORCE ROW LEVEL SECURITY;
CREATE POLICY posts_family_select ON posts
  FOR SELECT USING (family_id = current_setting('app.family_id', true)::int);
CREATE POLICY posts_family_insert ON posts
  FOR INSERT WITH CHECK (family_id = current_setting('app.family_id', true)::int);
CREATE POLICY posts_family_update ON posts
  FOR UPDATE
  USING  (family_id = current_setting('app.family_id', true)::int)
  WITH CHECK (family_id = current_setting('app.family_id', true)::int);
CREATE POLICY posts_family_delete ON posts
  FOR DELETE USING (family_id = current_setting('app.family_id', true)::int);

-- 3. VÉRIFICATION isolation (SET ROLE tribuzen_api)
-- Sans contexte : COUNT(*) = 0
-- BEGIN; SELECT set_config('app.family_id','1',true); SELECT COUNT(*) FROM posts; COMMIT; → 3
-- BEGIN; SELECT set_config('app.family_id','2',true); SELECT COUNT(*) FROM posts; COMMIT; → 3
-- INSERT cross-famille → ERROR new row violates row-level security policy
-- UPDATE family_id cross-famille → ERROR new row violates row-level security policy
-- UPDATE post invisible → UPDATE 0

-- 4. AUDIT injection (en PL/pgSQL avec DO)
-- EXECUTE 'SELECT ... WHERE family_id = ' || '1 OR 1=1 --' → requête injectée visible via RAISE NOTICE

-- 5. FIX requête paramétrée
-- EXECUTE 'SELECT COUNT(*) FROM posts WHERE family_id = $1' USING 1; → 3 (safe)

-- 6. BACKUP/RESTORE (depuis le terminal OS)
-- pg_dump -U postgres -d postgres -Fc -f tribuzen_lab14.dump
-- pg_restore -U postgres -d tribuzen_restore tribuzen_lab14.dump
-- psql -U postgres -d tribuzen_restore -c "SELECT COUNT(*) FROM posts;"  → 6
```

---

## Variante J+30 (fading)

> Refais sans regarder le corrigé. Crée le rôle, la policy et les tests de mémoire.

**Nouveau cas : rôle `tribuzen_guest` — lecture seule, toutes familles visibles (pas de filtrage inter-famille).**

Scénario : un visiteur invité peut lire **tous** les posts publiés de **n'importe quelle famille**, mais ne peut pas INSERT, UPDATE ni DELETE. Il n'a pas de contexte `app.family_id` — sa policy doit autoriser SELECT sans condition sur `family_id`.

**Sans regarder les exercices 2 et 3 ci-dessus, reproduis de mémoire :**

```sql
-- 1. Créer le rôle invité avec SELECT uniquement
-- (DROP IF EXISTS pour pouvoir rejouer)
DROP ROLE IF EXISTS tribuzen_guest;
-- CREATE ROLE ... ;
-- GRANT SELECT ON posts TO ... ;
-- GRANT SELECT ON families TO ... ;

-- 2. Ajouter la policy RLS pour tribuzen_guest
--    Contrainte : la policy doit cibler ce rôle spécifiquement (clause TO)
--    et autoriser SELECT sans filtre sur family_id
-- CREATE POLICY ... ON posts
--   FOR SELECT
--   TO tribuzen_guest
--   USING ( ??? );

-- 3. Tester l'isolation depuis le rôle invité
SET ROLE tribuzen_guest;

-- 3a. Peut-il lire tous les posts ? (attendu : oui, toutes familles)
SELECT family_id, COUNT(*) FROM posts GROUP BY family_id ORDER BY family_id;
-- → 2 lignes (famille 1 et famille 2)

-- 3b. Peut-il insérer ? (attendu : non)
INSERT INTO posts (family_id, author_id, content) VALUES (1, 99, 'test invité');
-- → ERROR: permission denied ?

-- 3c. Les policies tribuzen_api sont-elles toujours actives pour ce rôle ?
-- (indice : tribuzen_guest n'a pas de contexte app.family_id — est-ce que la policy
--  posts_family_select s'applique à lui ? Pourquoi ou pourquoi pas ?)

RESET ROLE;

-- 4. Vérifier via pg_policies que les deux policies coexistent
SELECT policyname, cmd, roles, qual
FROM pg_policies
WHERE tablename = 'posts'
ORDER BY policyname;
-- Attendu : 5 lignes (4 policies tribuzen_api + 1 policy tribuzen_guest)
```

**Critère de réussite :**
- `tribuzen_guest` voit les posts des 2 familles sans filtre (pas de `deny-by-default` pour lui).
- `tribuzen_guest` ne peut pas INSERT (permission denied au niveau GRANT, avant même RLS).
- `tribuzen_api` sans contexte voit toujours 0 posts (ses policies restent actives).
- Tu as expliqué pourquoi `TO tribuzen_guest` dans la policy empêche qu'elle s'applique à `tribuzen_api` et vice-versa.

---

## Navigation

| | Lien |
|---|---|
| Module | [14 — Sécurité et administration](../../modules/14-securite-et-administration.md) |
| Module précédent | [13 — JSONB et types avancés](../../modules/13-jsonb-et-types-avances.md) |
| Module suivant | [15 — Projet final](../../modules/15-projet-final.md) |
