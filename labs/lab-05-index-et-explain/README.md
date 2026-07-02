# Lab 05 — Index et EXPLAIN

> **Outcome :** à la fin, tu as créé des index B-tree sur une base TribuZen Docker réelle avec **psql + SQL**, observé le changement de plan avec `EXPLAIN ANALYZE`, indexé les clés étrangères, et mesuré le coût écriture/lecture.
> **Vrai outil :** PostgreSQL 17 (psql) + EXPLAIN ANALYZE. Aucune simulation.
> **Feedback :** le coach valide en session (pas de test-runner auto-correcteur).

## Énoncé

Base TribuZen locale (Docker Postgres 17), schéma de départ :

```sql
-- Connexion : psql -U postgres -d tribuzen
-- (ou psql -U postgres puis \c tribuzen)

CREATE TABLE families (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE posts (
  id         BIGSERIAL PRIMARY KEY,
  family_id  TEXT NOT NULL REFERENCES families(id),
  content    TEXT,
  statut     TEXT NOT NULL DEFAULT 'publié',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE family_members (
  id        BIGSERIAL PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  user_id   TEXT NOT NULL
);

-- Données de test
INSERT INTO families VALUES ('fam-1', 'Famille Dupont'), ('fam-2', 'Famille Martin');

INSERT INTO posts (family_id, content, created_at)
SELECT
  'fam-1',
  'Post numéro ' || i,
  now() - (random() * interval '365 days')
FROM generate_series(1, 200000) i;
-- Tous les posts sont dans fam-1 : fam-2 reste sans posts (nécessaire pour l'étape 5).

INSERT INTO family_members (family_id, user_id)
SELECT 'fam-1', 'user-' || i FROM generate_series(1, 5000) i;

ANALYZE;
```

Mission : appliquer les bons index pour que le feed TribuZen et les opérations de maintenance passent de Seq Scan à Index Scan — en prouvant chaque amélioration avec `EXPLAIN ANALYZE`.

## Étapes (en friction)

1. **Lire le plan de base.** Active `\timing on` dans psql. Lance la requête de feed (ci-dessous) sans aucun index. Copie le plan complet et repère : type de scan, coût estimé (`cost=`), temps d'exécution réel (`actual time=`), `Rows Removed by Filter`.

   ```sql
   EXPLAIN (ANALYZE, BUFFERS)
   SELECT id, content, created_at
   FROM posts
   WHERE family_id = 'fam-1'
   ORDER BY created_at DESC
   LIMIT 20;
   ```

2. **Indexer la FK `family_id`.** Crée `idx_posts_family_id ON posts(family_id)`. Relance `EXPLAIN ANALYZE` sur le feed. Le plan a-t-il changé ? Y a-t-il encore un Sort node ? Pourquoi ?

3. **Index composite pour le feed.** Crée `idx_posts_family_created ON posts(family_id, created_at DESC)`. Relance. Vérifie : y a-t-il encore un nœud `Sort` dans le plan ? L'exécution est-elle plus rapide qu'avec l'index simple de l'étape 2 ?

4. **Leftmost Prefix Rule.** Teste la requête suivante sans ajouter d'index :

   ```sql
   EXPLAIN (ANALYZE, BUFFERS)
   SELECT id, content, created_at
   FROM posts
   WHERE created_at > now() - interval '30 days'
   ORDER BY created_at DESC
   LIMIT 20;
   ```

   Est-ce que `idx_posts_family_created` est utilisé ? Pourquoi ? Quel index faudrait-il créer pour couvrir cette requête ?

5. **FK non indexée — DELETE.** Lance `EXPLAIN ANALYZE DELETE FROM families WHERE id = 'fam-2'` (fam-2 n'a pas de posts — le seed cible uniquement fam-1 — mais PostgreSQL vérifie quand même toutes les FK pointant vers `families`). Le check sur `posts` est rapide grâce à `idx_posts_family_id` (étape 2) ; observe en revanche le Seq Scan sur `family_members` (pas d'index). Crée `idx_members_family_id ON family_members(family_id)`. Réinsère `fam-2` et relance le DELETE. Le plan change-t-il ?

6. **Index unique.** Crée `UNIQUE INDEX idx_family_member_uniq ON family_members(family_id, user_id)`. Tente d'insérer deux fois `('fam-1', 'user-1')` et note l'erreur exacte retournée par PostgreSQL.

7. **Coût en écriture.** Supprime temporairement les index créés aux étapes 2 et 3, insère 1 000 lignes dans `posts` avec `\timing on` et note le temps. Recrée les index et refais l'insertion. Mesure la différence.

## Corrigé complet commenté

```sql
-- ── Connexion ───────────────────────────────────────────────────────────────
-- psql -U postgres -d tribuzen
\timing on

-- ── Étape 1 : plan de base ──────────────────────────────────────────────────
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content, created_at
FROM posts
WHERE family_id = 'fam-1'
ORDER BY created_at DESC
LIMIT 20;
-- Attendu :
--   Limit  (cost=... rows=20 ...)
--     -> Sort  (cost=... sort key: created_at DESC)
--         -> Seq Scan on posts
--              Filter: (family_id = 'fam-1')
--              Rows Removed by Filter: ~100 000
-- Execution Time: plusieurs centaines de ms.
-- Diagnostic : Seq Scan + Sort = deux opérations coûteuses sur 100 000 lignes.

-- ── Étape 2 : index simple sur FK ───────────────────────────────────────────
CREATE INDEX idx_posts_family_id ON posts(family_id);

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content, created_at
FROM posts
WHERE family_id = 'fam-1'
ORDER BY created_at DESC
LIMIT 20;
-- Attendu :
--   Limit
--     -> Sort (created_at DESC)
--         -> Index Scan using idx_posts_family_id on posts
--              Index Cond: (family_id = 'fam-1')
-- Amélioration : plus de Seq Scan, mais le Sort node subsiste.
-- L'index élimine le filtre sur 100 000 lignes mais ne connaît pas l'ordre created_at.

-- ── Étape 3 : index composite ───────────────────────────────────────────────
CREATE INDEX idx_posts_family_created ON posts(family_id, created_at DESC);

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content, created_at
FROM posts
WHERE family_id = 'fam-1'
ORDER BY created_at DESC
LIMIT 20;
-- Attendu :
--   Limit
--     -> Index Scan Backward using idx_posts_family_created on posts
--          Index Cond: (family_id = 'fam-1')
--          Buffers: shared hit=5
-- Execution Time: ~0.1 ms
-- Le Sort node a disparu : l'index fournit les lignes dans l'ordre DESC.
-- "Backward" = PostgreSQL parcourt les feuilles de droite à gauche (DESC).
-- Le planner peut ignorer idx_posts_family_id désormais (son préfixe est couvert).

-- ── Étape 4 : Leftmost Prefix Rule ──────────────────────────────────────────
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content, created_at
FROM posts
WHERE created_at > now() - interval '30 days'
ORDER BY created_at DESC
LIMIT 20;
-- Attendu : Seq Scan (ou Index Scan sur la PK) — PAS idx_posts_family_created.
-- Raison : created_at n'est pas le préfixe de gauche. L'index commence par family_id.
-- Pour couvrir cette requête :
CREATE INDEX idx_posts_created ON posts(created_at DESC);
-- Relance EXPLAIN : Index Scan using idx_posts_created.

-- ── Étape 5 : FK non indexée — DELETE ───────────────────────────────────────
-- fam-2 n'a pas de posts (seed = fam-1 uniquement). PostgreSQL vérifie quand
-- même toutes les FK qui référencent families(id) : posts ET family_members.
-- idx_posts_family_id (étape 2) couvre déjà la FK sur posts.
-- Avant index sur family_members.family_id :
EXPLAIN (ANALYZE, BUFFERS)
DELETE FROM families WHERE id = 'fam-2';
-- Attendu :
--   Delete on families
--     -> Index Scan using families_pkey on families
--   Trigger for constraint posts_family_id_fkey:
--     -> Index Scan using idx_posts_family_id on posts    ← rapide (étape 2)
--          Index Cond: (family_id = 'fam-2')
--          Rows Removed by Filter: 0
--   Trigger for constraint family_members_family_id_fkey:
--     -> Seq Scan on family_members                       ← lent, pas d'index
--          Filter: (family_id = 'fam-2')
--          Rows Removed by Filter: 0 (mais les 5 000 lignes ont été lues)
-- Diagnostic : la FK sur posts est couverte ; celle sur family_members ne l'est pas.

CREATE INDEX idx_members_family_id ON family_members(family_id);

-- Réinsérer fam-2 supprimée
INSERT INTO families VALUES ('fam-2', 'Famille Martin');

EXPLAIN (ANALYZE, BUFFERS)
DELETE FROM families WHERE id = 'fam-2';
-- Attendu : Index Scan using idx_members_family_id on family_members
--   Index Cond: (family_id = 'fam-2')
-- Plus de Seq Scan sur 5 000 lignes — les deux FK sont maintenant couvertes par un index.

-- ── Étape 6 : index unique ───────────────────────────────────────────────────
CREATE UNIQUE INDEX idx_family_member_uniq
  ON family_members(family_id, user_id);

-- Test doublon
INSERT INTO family_members (family_id, user_id) VALUES ('fam-1', 'user-1');
-- Ligne existante (insérée lors du setup) → erreur :
-- ERROR: duplicate key value violates unique constraint "idx_family_member_uniq"
-- DETAIL: Key (family_id, user_id)=('fam-1', 'user-1') already exists.

INSERT INTO family_members (family_id, user_id) VALUES ('fam-1', 'user-99999');
-- Réussit : cette combinaison n'existe pas encore.

-- ── Étape 7 : coût en écriture ───────────────────────────────────────────────
-- Retirer les index du feed pour mesurer la différence
DROP INDEX IF EXISTS idx_posts_family_id;
DROP INDEX IF EXISTS idx_posts_family_created;

\timing on
INSERT INTO posts (family_id, content)
SELECT 'fam-1', 'sans-index-' || i FROM generate_series(1, 1000) i;
-- Ex : Time: 12.000 ms

-- Recréer les index
CREATE INDEX idx_posts_family_id ON posts(family_id);
CREATE INDEX idx_posts_family_created ON posts(family_id, created_at DESC);

INSERT INTO posts (family_id, content)
SELECT 'fam-1', 'avec-index-' || i FROM generate_series(1, 1000) i;
-- Ex : Time: 18.000 ms  (~50 % plus lent sur un petit jeu de données)
-- Sur des millions de lignes et des tables à forte insertion, l'écart est plus marqué.
-- Règle : chaque index non utilisé est une taxe pure sur les écritures.
```

Points de validation par le coach : (a) tu montres deux plans `EXPLAIN ANALYZE` côte à côte (avant/après index) et tu identifies les nœuds `Seq Scan`, `Sort`, `Index Scan` ; (b) tu expliques pourquoi le Sort node disparaît avec le composite ; (c) tu constates le Seq Scan sur FK avant l'index sur `family_members` ; (d) tu lis l'erreur de contrainte unique ; (e) tu articules le trade-off lecture/écriture avec des chiffres mesurés.

## Variante J+30 (fading)

Reprends sans relire le corrigé, **en 20 min**. Nouveau contexte : `posts` a une colonne `statut TEXT` (`'publié'`, `'brouillon'`, `'archivé'`). Le feed ne charge que les posts publiés d'une famille :

```sql
SELECT id, content, created_at
FROM posts
WHERE family_id = 'fam-1'
  AND statut = 'publié'
ORDER BY created_at DESC
LIMIT 20;
```

Questions : quel index créer ? Dans quel ordre de colonnes ? Justifie avec `EXPLAIN ANALYZE` avant et après. Ensuite, explique à voix haute pourquoi `(family_id, statut, created_at DESC)` est meilleur que `(statut, family_id, created_at DESC)` pour cette requête. Enfin, estime dans quel cas un index sur `statut` seul serait inutile.

## Application TribuZen

Porte ce lab dans le vrai repo `smaurier/tribuzen` :

1. Dans `schema.prisma`, ajoute `@@index([familyId, createdAt(sort: Desc)])` sur le model `Post` et `@@unique([familyId, userId])` sur `FamilyMember`. Lance `npx prisma migrate dev --name add-feed-indexes`.
2. Ouvre psql sur la base migrée (`npx prisma db pull` si besoin) et exécute `EXPLAIN ANALYZE` sur la requête de feed réelle.
3. Vérifie avec `\d posts` que les index sont présents et que la FK `family_id` est couverte.
4. Commit `smaurier/tribuzen` : `perf(posts): index composite feed + index FK family_id`.
