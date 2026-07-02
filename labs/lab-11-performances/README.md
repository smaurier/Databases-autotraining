# Lab 11 — Performances et optimisation

> Mesurer, diagnostiquer et corriger les goulots du feed TribuZen : pagination keyset, index adapté, VACUUM et autovacuum tuning.

## Prérequis · Durée

- Module 11 lu
- Docker + psql (ou DBeaver)
- Durée estimée : 60 min

## Setup

```sql
-- 1. Créer la base et le schéma
CREATE DATABASE tribuzen_lab11;
\c tribuzen_lab11

CREATE TABLE users (
  id           SERIAL PRIMARY KEY,
  display_name TEXT NOT NULL
);

CREATE TABLE families (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE posts (
  id         SERIAL PRIMARY KEY,
  family_id  INT  NOT NULL REFERENCES families(id),
  author_id  INT  NOT NULL REFERENCES users(id),
  content    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Données réalistes (150 000 posts, 30 familles, 500 utilisateurs)
INSERT INTO users
  SELECT i, 'User '||i
  FROM generate_series(1, 500) i;

INSERT INTO families
  SELECT i, 'Famille '||i
  FROM generate_series(1, 30) i;

INSERT INTO posts
  SELECT
    i,
    (random()*29  + 1)::int,
    (random()*499 + 1)::int,
    repeat('Post TribuZen contenu ', 8),
    now() - (random()*365 || ' days')::interval
  FROM generate_series(1, 150000) i;

ANALYZE;
```

---

## Étape 1 — Mesurer le coût d'OFFSET (sans index)

La page 1 du feed charge les 20 derniers posts de la famille 1 (`LIMIT 20`). La page 26 est à `OFFSET 500`.

**TODO** : exécute `EXPLAIN (ANALYZE, BUFFERS)` sur les deux requêtes ci-dessous. Note l'`Execution Time` et la valeur de `shared read` pour chacune. Observe si le coût est identique ou différent selon l'OFFSET.

```sql
-- Page 1 (OFFSET 0)
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.family_id = 1
ORDER BY p.created_at DESC
LIMIT 20;

-- Page 26 (OFFSET 500)
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.family_id = 1
ORDER BY p.created_at DESC
OFFSET 500 LIMIT 20;
```

**Corrigé** : les deux requêtes affichent un `Seq Scan on posts` suivi d'un `Sort` sur `created_at DESC`. Le `shared read` est identique (~14 000 pages) quelle que soit la valeur d'OFFSET — PostgreSQL trie **toutes** les lignes de `family_id=1` avant de couper à l'OFFSET. La page 1 et la page 26 coûtent le même travail car le Sort précède la coupe. L'OFFSET dégrade seulement quand PostgreSQL doit trier davantage de lignes (volume croissant) — la page 500 sur une table de 1 million de lignes sera bien plus lente.

---

## Étape 2 — Ajouter l'index composite et observer le plan

**TODO** : crée un index qui couvre à la fois le filtre `family_id = 1` et le tri `ORDER BY created_at DESC, id DESC`, puis relance les deux requêtes de l'étape 1.

```sql
-- TODO : complète le CREATE INDEX (colonnes + ordres)
CREATE INDEX ??? ON posts(???, ???, ???);
ANALYZE posts;
```

**Corrigé** :

```sql
CREATE INDEX idx_posts_family_date ON posts(family_id, created_at DESC, id DESC);
ANALYZE posts;
```

Relance `EXPLAIN (ANALYZE, BUFFERS)` sur les deux requêtes de l'étape 1. Observe le tableau suivant dans ton plan :

| Métrique | Sans index | Avec index |
|---|---|---|
| Nœud sur `posts` | Seq Scan | Index Scan |
| Nœud `Sort` | présent | absent |
| `shared read` (posts) | ~14 000 pages | 0 |
| `shared hit` (index) | — | 3-6 pages |
| `Execution Time` | 300-800 ms | < 5 ms |

Le nœud `Sort` disparaît du plan car l'index livre les données dans l'ordre exact de l'`ORDER BY (family_id, created_at DESC, id DESC)`. Le Hash Join laisse place à un Nested Loop car la table externe (`posts` filtrée) ne contient plus que 20 lignes.

> L'ordre des colonnes dans l'index est intentionnel : `family_id` en premier pour le filtre d'égalité, `created_at DESC` et `id DESC` pour le tri correspondant à l'`ORDER BY` — inverser l'ordre rendrait l'élimination du Sort impossible.

---

## Étape 3 — Remplacer OFFSET par la pagination keyset

**TODO** : récupère les valeurs `created_at` et `id` de la dernière ligne de la page 1, puis écris la requête keyset pour la page 2.

```sql
-- Récupérer le curseur de la page 1
SELECT id, created_at
FROM posts
WHERE family_id = 1
ORDER BY created_at DESC, id DESC
LIMIT 20;
-- → noter la dernière ligne, par exemple :
--   id = 74320, created_at = '2026-05-15 14:22:10+00'

-- TODO : écrire la requête keyset pour la page 2 avec ces valeurs
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.family_id = 1
  AND ???   -- condition keyset (created_at, id) < (valeur_curseur)
ORDER BY p.created_at DESC, p.id DESC
LIMIT 20;
```

**Corrigé** :

```sql
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.family_id = 1
  AND (p.created_at, p.id) < ('2026-05-15 14:22:10+00', 74320)
ORDER BY p.created_at DESC, p.id DESC
LIMIT 20;
```

Lance `EXPLAIN (ANALYZE, BUFFERS)` sur cette requête. Le plan doit montrer :

```
Limit  (actual time=0.2..0.5 rows=20 loops=1)
  ->  Nested Loop
        ->  Index Scan using idx_posts_family_date on posts p
              Index Cond: ((family_id = 1) AND ((created_at, id) < (...)))
              Buffers: shared hit=5
        ->  Index Scan using users_pkey on users u  (loops=20)
Execution Time: 0.6 ms
```

La condition `(created_at, id) < (...)` est évaluée dans l'`Index Cond` directement — pas de filtre post-scan, pas de Sort, pas de Seq Scan. Ce plan reste identique à n'importe quelle profondeur du feed.

> La comparaison de tuple `(created_at, id) < (ts, id)` gère les timestamps identiques : si deux posts ont le même `created_at`, l'`id` sert de départage pour éviter les doublons entre pages.

---

## Étape 4 — Diagnostiquer le bloat et lancer VACUUM ANALYZE

**TODO** : génère des dead tuples sur `posts`, mesure le bloat, puis nettoie.

```sql
-- Simuler de l'activité (UPDATE génère des dead tuples)
UPDATE posts SET content = content || ' (edit)'  WHERE id % 4 = 0;
UPDATE posts SET content = content || ' (v2)'    WHERE id % 6 = 0;

-- TODO : requête sur pg_stat_user_tables pour voir n_dead_tup, dead_pct et last_autovacuum
SELECT ???
FROM pg_stat_user_tables
WHERE relname = 'posts';
```

**Corrigé — diagnostic** :

```sql
SELECT relname, n_live_tup, n_dead_tup,
       ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_vacuum, last_autovacuum
FROM pg_stat_user_tables
WHERE relname = 'posts';
```

Tu dois voir `dead_pct` autour de 20-25 %. L'autovacuum n'a pas encore tourné (le daemon tourne en arrière-plan, mais il faut attendre le `naptime` d'une minute). Lance le nettoyage maintenant :

```sql
VACUUM ANALYZE posts;

-- Revérifier : n_dead_tup doit être proche de 0
SELECT relname, n_live_tup, n_dead_tup, last_vacuum
FROM pg_stat_user_tables
WHERE relname = 'posts';
```

`VACUUM ANALYZE` est non bloquant — les requêtes `SELECT`, `INSERT` et `UPDATE` continuent pendant l'opération. Après le VACUUM, les plans qui s'appuient sur les statistiques de `posts` bénéficient de chiffres frais.

---

## Étape 5 — Tuner l'autovacuum pour posts

Avec les réglages par défaut (20 %), l'autovacuum se déclenche à `50 + 0.20 × 150000 = 30 050` dead tuples — trop tardif pour une table aussi écrite.

**TODO** : ajuste l'autovacuum de `posts` pour qu'il se déclenche à 2 % de dead tuples (environ 3 000 au lieu de 30 000).

```sql
-- TODO : ALTER TABLE posts SET (...)
```

**Corrigé** :

```sql
ALTER TABLE posts SET (
  autovacuum_vacuum_scale_factor    = 0.02,
  autovacuum_analyze_scale_factor   = 0.01,
  autovacuum_vacuum_threshold       = 100,
  autovacuum_analyze_threshold      = 100
);

-- Vérifier que la config est bien stockée dans le catalogue
SELECT relname, reloptions
FROM pg_class
WHERE relname = 'posts';
-- → reloptions = {autovacuum_vacuum_scale_factor=0.02,
--                 autovacuum_analyze_scale_factor=0.01, ...}
```

Avec ce réglage, l'autovacuum démarre à `100 + 0.02 × 150000 = 3 100` dead tuples au lieu de 30 050 — le bloat reste sous 2 % en permanence et les statistiques du planner sont toujours fraîches pour produire des plans optimaux.

---

## Variante J+30

- Ajoute un **covering index** `(family_id, created_at DESC, id DESC) INCLUDE (content, author_id)` et vérifie si un `Index Only Scan` apparaît pour les colonnes couvertes — la heap n'est alors jamais lue.
- Mesure l'impact de `SET work_mem = '64MB'` avant `EXPLAIN` sur une requête `GROUP BY` + `ORDER BY` — observe si `Batches: 1` apparaît dans le Hash Join (tout en mémoire, plus de débordement disque).
- Active `pg_stat_statements` (`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`) et identifie la requête la plus appelée via `SELECT LEFT(query, 60), calls, ROUND(mean_exec_time::numeric, 2) FROM pg_stat_statements ORDER BY calls DESC LIMIT 5`.
- Implémente le compteur dénormalisé `families.posts_count` : ajoute la colonne (`ALTER TABLE families ADD COLUMN posts_count INT DEFAULT 0`), calcule la valeur initiale avec un `UPDATE ... FROM (SELECT family_id, COUNT(*) ...)`, puis écris un trigger `AFTER INSERT OR DELETE ON posts` qui l'incrémente/décrémente.

---

## Navigation

| | Lien |
|---|---|
| Module associé | [Module 11 — Performances et optimisation](../../modules/11-performances-et-optimisation.md) |
| Module suivant | [Module 12 — Fonctions avancées SQL](../../modules/12-fonctions-avancees-sql.md) |
