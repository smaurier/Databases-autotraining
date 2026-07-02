# Lab 18 — Partitioning et scaling

> Partitionner la table `posts` de TribuZen par mois, vérifier le partition pruning avec `EXPLAIN ANALYZE`, inspecter les partitions via le catalogue, et simuler un cycle de vie complet (DETACH + DROP).

## Prérequis · Durée

- Module 18 lu
- Docker + psql (ou DBeaver)
- Durée estimée : 60 min

## Setup

```sql
-- 1. Créer la base de travail
CREATE DATABASE tribuzen_lab18;
\c tribuzen_lab18

-- 2. Schéma TribuZen (simplifié)
CREATE TABLE users (
  id           SERIAL PRIMARY KEY,
  display_name TEXT NOT NULL
);

CREATE TABLE families (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

-- 3. Table posts partitionnée (PK inclut la colonne de partition)
CREATE TABLE posts (
  id         BIGINT GENERATED ALWAYS AS IDENTITY,
  family_id  INT NOT NULL REFERENCES families(id),
  author_id  INT NOT NULL REFERENCES users(id),
  content    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- 4. Partitions mensuelles (3 mois de données de test)
CREATE TABLE posts_2026_05 PARTITION OF posts
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE posts_2026_06 PARTITION OF posts
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE posts_2026_07 PARTITION OF posts
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE posts_default PARTITION OF posts DEFAULT;

-- 5. Index composite propagé à toutes les partitions
CREATE INDEX ON posts (family_id, created_at DESC);

-- 6. Données réalistes (500 000 posts, 20 familles, 200 utilisateurs)
INSERT INTO users    SELECT i, 'User '||i FROM generate_series(1, 200) i;
INSERT INTO families SELECT i, 'Famille '||i FROM generate_series(1, 20) i;
INSERT INTO posts (family_id, author_id, content, created_at)
  SELECT
    (random()*19 + 1)::int,
    (random()*199 + 1)::int,
    repeat('contenu tribuzen ', 8),
    now() - (random()*89 || ' days')::interval
  FROM generate_series(1, 500000);
ANALYZE;
```

---

## Étape 1 — Confirmer la structure des partitions

**TODO** : requête sur `pg_inherits` pour lister les partitions de `posts` avec leur taille et leur nombre de lignes vivantes.

```sql
-- TODO : compléter la requête
SELECT
  inhrelid::regclass AS partition,
  ???               AS taille,
  ???               AS lignes_vivantes
FROM pg_inherits
WHERE inhparent = ???
ORDER BY partition;
```

**Corrigé** :

```sql
SELECT
  inhrelid::regclass                               AS partition,
  pg_size_pretty(pg_total_relation_size(inhrelid)) AS taille,
  pg_stat_get_live_tuples(inhrelid)                AS lignes_vivantes
FROM pg_inherits
WHERE inhparent = 'posts'::regclass
ORDER BY partition;
```

Résultat attendu : 4 partitions (`posts_2026_05`, `posts_2026_06`, `posts_2026_07`, `posts_default`) avec des tailles et des lignes vivantes réparties sur les 3 mois. La table parent `posts` elle-même est **vide** — elle ne contient que la définition de routage.

> `pg_total_relation_size` inclut les index de la partition. Comparer avec `pg_relation_size` (données seules) pour estimer le poids des index.

---

## Étape 2 — Observer le pruning avec EXPLAIN

**TODO** : exécute deux variantes de `EXPLAIN (ANALYZE, BUFFERS)` et compare les plans.

```sql
-- Variante A : filtre sur la colonne de partition (created_at) — pruning attendu
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content, created_at
FROM posts
WHERE family_id = 5
  AND created_at >= '2026-07-01'
  AND created_at <  '2026-08-01'
ORDER BY created_at DESC
LIMIT 20;

-- Variante B : filtre uniquement sur family_id — pas de pruning
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content, created_at
FROM posts
WHERE family_id = 5
ORDER BY created_at DESC
LIMIT 20;
```

Note dans chaque plan :
- Le ou les nœuds sur les partitions scannées
- La valeur `Subplans Removed` (variante A)
- Le `Execution Time`

**Corrigé — lecture des plans** :

Variante A — pruning actif :

```
Limit  (actual time=0.140..0.370 rows=20 loops=1)
  ->  Index Scan using posts_2026_07_family_id_created_at_idx on posts_2026_07
        Index Cond: ((family_id = 5) AND (created_at >= '2026-07-01') AND ...)
        Buffers: shared hit=6
Execution Time: 0.4 ms
```

Une seule partition scannée (`posts_2026_07`), les 3 autres élaguées (`Subplans Removed: 3`). Quelques pages seulement lues via l'index.

Variante B — pas de pruning :

```
Append  (actual time=0.230..85.720 rows=25340 loops=1)
  ->  Index Scan on posts_2026_05  (actual time=0.080..22.100 rows=8410 loops=1)
  ->  Index Scan on posts_2026_06  (actual time=0.050..31.200 rows=9230 loops=1)
  ->  Index Scan on posts_2026_07  (actual time=0.040..28.100 rows=7680 loops=1)
  ->  Index Scan on posts_default  (actual time=0.010..0.020 rows=20 loops=1)
Execution Time: 85.9 ms
```

Les 4 partitions sont scannées car il n'y a aucun filtre sur `created_at`. L'index aide pour `family_id`, mais le moteur doit parcourir tous les mois. **Conclusion** : sans filtre sur la colonne de partition, le partitionnement n'apporte aucun gain de pruning.

---

## Étape 3 — Créer la partition du mois suivant

**TODO** : crée la partition de août 2026 sans la pré-créer dans le setup. Puis vérifie qu'elle apparaît dans `pg_inherits` et qu'un INSERT avec `created_at = '2026-08-15'` y est routé.

```sql
-- TODO : CREATE TABLE pour août 2026
CREATE TABLE ??? PARTITION OF posts
  FOR VALUES FROM (???) TO (???);

-- Vérifier l'apparition dans le catalogue
SELECT inhrelid::regclass AS partition
FROM pg_inherits
WHERE inhparent = 'posts'::regclass;

-- Test de routage : insérer un post d'août 2026
INSERT INTO posts (family_id, author_id, content, created_at)
VALUES (1, 1, 'post de test août', '2026-08-15 10:00:00+00');

-- Vérifier que la ligne est dans la bonne partition
SELECT count(*) FROM posts_2026_08;
```

**Corrigé** :

```sql
CREATE TABLE posts_2026_08 PARTITION OF posts
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- Vérification
SELECT inhrelid::regclass AS partition
FROM pg_inherits
WHERE inhparent = 'posts'::regclass;
-- → 5 partitions dont posts_2026_08

INSERT INTO posts (family_id, author_id, content, created_at)
VALUES (1, 1, 'post de test août', '2026-08-15 10:00:00+00');

SELECT count(*) FROM posts_2026_08;
-- → 1 ligne
```

> L'index `(family_id, created_at DESC)` est automatiquement créé sur `posts_2026_08` lors du `CREATE TABLE ... PARTITION OF` — aucune action manuelle requise.

---

## Étape 4 — Tester la partition DEFAULT

**TODO** : insère un post avec une date hors de toutes les partitions définies (par exemple 2025-03-01), puis localise-le dans `posts_default`.

```sql
-- TODO : insérer un post avec une date hors plage
INSERT INTO posts (family_id, author_id, content, created_at)
VALUES (1, 1, 'post hors plage', '2025-03-01 12:00:00+00');

-- Vérifier qu'il atterrit dans posts_default
SELECT count(*) FROM posts_default;
SELECT id, created_at FROM posts_default;
```

**Corrigé** :

```sql
INSERT INTO posts (family_id, author_id, content, created_at)
VALUES (1, 1, 'post hors plage', '2025-03-01 12:00:00+00');

SELECT count(*) FROM posts_default;
-- → 1 ligne (plus le post d'août si posts_2026_08 n'était pas créée à l'étape 3)

SELECT id, created_at FROM posts_default;
-- → la ligne avec created_at = 2025-03-01 apparaît ici
```

**Piège** : essaie maintenant de créer une partition qui couvre mars 2025 :

```sql
-- Cette commande ÉCHOUE car posts_default contient déjà des lignes pour cette plage
CREATE TABLE posts_2025_03 PARTITION OF posts
  FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');
-- ERROR: updated partition constraint for default partition "posts_default"
--        would be violated by some row
```

Solution : vider d'abord la partition DEFAULT des lignes conflictuelles, puis créer la partition.

```sql
-- Déplacer les lignes hors de posts_default avant de créer la partition
CREATE TEMP TABLE tmp_posts_2025_03 AS
  SELECT * FROM posts_default
  WHERE created_at >= '2025-03-01' AND created_at < '2025-04-01';

DELETE FROM posts_default
  WHERE created_at >= '2025-03-01' AND created_at < '2025-04-01';

CREATE TABLE posts_2025_03 PARTITION OF posts
  FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');

INSERT INTO posts (id, family_id, author_id, content, created_at)
  OVERRIDING SYSTEM VALUE
  SELECT id, family_id, author_id, content, created_at FROM tmp_posts_2025_03;
```

---

## Étape 5 — Cycle de vie : DETACH CONCURRENTLY + DROP

Simuler la purge mensuelle : archiver `posts_2026_05` puis la supprimer.

**TODO** : détache `posts_2026_05` de manière non bloquante, inspecte son contenu en tant que table autonome, puis supprime-la.

```sql
-- TODO : DETACH CONCURRENTLY (PG 14+)
ALTER TABLE posts ??? PARTITION posts_2026_05 CONCURRENTLY;

-- Vérifier que posts_2026_05 n'est plus dans l'arbre des partitions
SELECT inhrelid::regclass AS partition
FROM pg_inherits
WHERE inhparent = 'posts'::regclass;

-- Vérifier que posts_2026_05 existe toujours comme table autonome
SELECT count(*) FROM posts_2026_05;

-- Supprimer définitivement
DROP TABLE posts_2026_05;
```

**Corrigé** :

```sql
ALTER TABLE posts DETACH PARTITION posts_2026_05 CONCURRENTLY;

-- Vérification : posts_2026_05 n'apparaît plus dans pg_inherits
SELECT inhrelid::regclass AS partition
FROM pg_inherits
WHERE inhparent = 'posts'::regclass;
-- → posts_2026_06, posts_2026_07, posts_2026_08, posts_2025_03, posts_default

-- posts_2026_05 existe toujours comme table standlone
SELECT count(*) FROM posts_2026_05;
-- → N lignes toujours accessibles

-- Suppression définitive (quasi-instantanée)
DROP TABLE posts_2026_05;

-- Confirmer la disparition
SELECT count(*) FROM posts_2026_05;
-- ERROR: relation "posts_2026_05" does not exist
```

Mesure comparative pour ancrer l'avantage :

```sql
-- Simuler ce qu'aurait coûté un DELETE équivalent (NE PAS faire sur les vraies données)
EXPLAIN (ANALYZE, BUFFERS)
DELETE FROM posts_2026_06
WHERE created_at >= '2026-06-01' AND created_at < '2026-07-01';
-- → Seq Scan sur toute la partition, dead tuples, VACUUM nécessaire
-- Execution Time : plusieurs secondes même sur cette taille

-- Vs DROP TABLE posts_2026_06 : ~50 ms, zéro dead tuple
```

---

## Variante J+30

- Crée un index **covering** `(family_id, created_at DESC) INCLUDE (content)` sur `posts` et vérifie si `EXPLAIN` affiche `Index Only Scan` sur les requêtes feed (la heap n'est plus lue).
- Simule l'**ATTACH** d'une table existante : crée `posts_2026_09` via `CREATE TABLE posts_2026_09 (LIKE posts INCLUDING ALL)`, ajoute une `CHECK constraint` sur `created_at`, puis l'attache avec `ALTER TABLE posts ATTACH PARTITION posts_2026_09 FOR VALUES FROM ('2026-09-01') TO ('2026-10-01')`.
- Active `enable_partition_pruning = off` puis relance les plans de l'étape 2 pour observer ce qui se passe sans pruning — puis réactive-le.
- Écris une fonction `PL/pgSQL` `create_next_month_partition()` qui calcule le premier et dernier jour du mois suivant et crée la partition si elle n'existe pas encore (vérification via `pg_class`).

---

## Navigation

| | Lien |
|---|---|
| Module associé | [Module 18 — Partitioning et scaling](../../modules/18-partitioning-et-scaling.md) |
| Module précédent | [Module 17 — Monitoring et observabilité](../../modules/17-monitoring-et-observabilite.md) |
| Module suivant | [Module 19 — pgvector et embeddings](../../modules/19-pgvector-embeddings.md) |
