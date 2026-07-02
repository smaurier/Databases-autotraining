# Lab 17 — Monitoring et observabilité

> Activer `pg_stat_statements`, identifier la requête feed lente, corriger avec l'index composite, surveiller le bloat sur `posts` et détecter une session `idle in transaction` simulée.

## Prérequis · Durée

- Module 17 lu
- Docker + psql (ou DBeaver)
- Durée estimée : 60 min

## Setup

```sql
-- 1. Créer la base de test
CREATE DATABASE tribuzen_lab17;
\c tribuzen_lab17

-- 2. Activer pg_stat_statements
--    (shared_preload_libraries doit déjà contenir 'pg_stat_statements'
--     dans postgresql.conf — sur Docker l'image officielle l'inclut)
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- 3. Schéma minimal TribuZen
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

-- 4. Données réalistes (150 000 posts, 30 familles, 500 utilisateurs)
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

-- 5. Simuler du trafic pour alimenter pg_stat_statements
--    (exécuter plusieurs fois dans psql ou via un outil)
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.family_id = 1
ORDER BY p.created_at DESC
LIMIT 20;
```

---

## Étape 1 — Observer le top SQL avec pg_stat_statements

**TODO** : identifie quelle requête consomme le plus de temps total. Classe par `total_exec_time` et relève `mean_exec_time` et `cache_pct` (ratio `shared_blks_hit / (shared_blks_hit + shared_blks_read)`).

```sql
-- TODO : compléter la requête
SELECT LEFT(query, ???) AS query,
       calls,
       ROUND(???, 2) AS mean_ms,
       ROUND(???, 0) AS total_ms,
       ROUND(100.0 * shared_blks_hit
             / NULLIF(???, 0), 1) AS cache_pct
FROM pg_stat_statements
ORDER BY ??? DESC
LIMIT 10;
```

**Corrigé** :

```sql
SELECT LEFT(query, 100) AS query,
       calls,
       ROUND(mean_exec_time::numeric, 2)  AS mean_ms,
       ROUND(total_exec_time::numeric, 0) AS total_ms,
       ROUND(100.0 * shared_blks_hit
             / NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS cache_pct
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

La requête feed (`WHERE p.family_id = ?`) doit apparaître en tête. Si le `cache_pct` est inférieur à 80 %, cela confirme qu'elle lit massivement sur disque. Note les valeurs `mean_ms` et `total_ms` avant de passer à l'étape suivante — tu les compareras après le fix.

---

## Étape 2 — Mesurer le plan de la requête feed sans index

**TODO** : lance `EXPLAIN (ANALYZE, BUFFERS)` sur la requête feed. Relève le nœud responsable de la lenteur (`Sort`, `Seq Scan`), la valeur de `shared read`, et l'`Execution Time`.

```sql
-- TODO : lance EXPLAIN ANALYZE BUFFERS sur la requête feed
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.family_id = 1
ORDER BY p.created_at DESC
LIMIT 20;
```

**Corrigé — lecture du plan** :

Le plan sans index doit ressembler à :

```
Sort  (cost=22000..22375 rows=150000 width=80)
      (actual time=815.12..815.18 rows=20 loops=1)
  Sort Key: p.created_at DESC
  Buffers: shared read=14820
  ->  Seq Scan on posts p  (actual time=0.01..250.00 rows=5000 loops=1)
        Filter: (family_id = 1)
        Buffers: shared read=14820
Execution Time: 820.3 ms
```

Observations :
- Le nœud `Seq Scan on posts` lit **toutes** les pages de la table (14 820 pages) pour filtrer par `family_id`.
- Le nœud `Sort` trie les 5 000 lignes de la famille avant de couper à `LIMIT 20` — travail en O(N).
- Tout `shared read` (pages sur disque) et rien en `shared hit` (cache) : le filtre ne profite d'aucun index.

---

## Étape 3 — Corriger avec l'index composite et vérifier le plan

**TODO** : crée un index qui couvre le filtre `family_id = ?` et le tri `ORDER BY created_at DESC, id DESC`. Relance `EXPLAIN ANALYZE BUFFERS` et compare avec l'étape 2.

```sql
-- TODO : complète le CREATE INDEX (colonnes + ordres)
CREATE INDEX idx_posts_family_date ON posts(???, ???, ???);
ANALYZE posts;

-- Relancer EXPLAIN ANALYZE BUFFERS
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.family_id = 1
ORDER BY p.created_at DESC, p.id DESC
LIMIT 20;
```

**Corrigé** :

```sql
CREATE INDEX idx_posts_family_date ON posts(family_id, created_at DESC, id DESC);
ANALYZE posts;
```

Plan attendu après l'index :

```
Limit  (actual time=0.26..0.49 rows=20 loops=1)
  ->  Nested Loop  (actual time=0.25..0.47 rows=20 loops=1)
        ->  Index Scan using idx_posts_family_date on posts p
              Index Cond: (family_id = 1)
              Buffers: shared hit=5
        ->  Index Scan using users_pkey on users u  (loops=20)
Execution Time: 0.6 ms
```

| Métrique | Sans index | Avec index |
|---|---|---|
| Nœud sur `posts` | Seq Scan | Index Scan |
| Nœud `Sort` | présent | absent |
| `shared read` | ~14 800 pages | 0 |
| `shared hit` (index) | — | 5 pages |
| `Execution Time` | ~820 ms | ~0,6 ms |

Le nœud `Sort` disparaît car l'index livre les lignes dans l'ordre exact de l'`ORDER BY (created_at DESC, id DESC)`. Le planner passe de Hash Join à Nested Loop car la table externe (`posts` filtrée) ne contient plus que 20 lignes.

> L'ordre des colonnes est intentionnel : `family_id` en premier pour le filtre d'égalité, `created_at DESC` et `id DESC` pour correspondre exactement à l'`ORDER BY`. Inverser l'ordre rendrait l'élimination du Sort impossible.

---

## Étape 4 — Confirmer le fix dans pg_stat_statements

Après quelques exécutions de la requête feed avec le nouvel index :

**TODO** : requête `pg_stat_statements` pour vérifier que `mean_ms` a chuté par rapport aux valeurs notées à l'étape 1. Si les statistiques mélangent ancien et nouveau code, fais `pg_stat_statements_reset()` et relance le trafic.

```sql
-- Option A : lire les stats cumulées (mélange avant/après fix)
SELECT LEFT(query, 80) AS query,
       calls,
       ROUND(mean_exec_time::numeric, 2) AS mean_ms
FROM pg_stat_statements
WHERE query LIKE '%posts p%family_id%'
ORDER BY total_exec_time DESC
LIMIT 3;

-- Option B : repartir de statistiques propres
SELECT pg_stat_statements_reset();
-- → relancer la requête feed plusieurs fois, puis relire pg_stat_statements
```

**Corrigé** : après le reset et 10+ exécutions de la requête avec l'index, `mean_ms` doit afficher < 5 ms (contre ~300 ms avant). C'est le retour sur investissement du monitoring : on mesure l'amélioration avec le même outil qui a révélé le problème.

---

## Étape 5 — Détecter le bloat et les connexions idle in transaction

**TODO** : génère des dead tuples sur `posts`, surveille le bloat dans `pg_stat_user_tables`, puis simule une session `idle in transaction` et observe son impact.

```sql
-- 1. Générer des dead tuples
UPDATE posts SET content = content || ' (edit)' WHERE id % 4 = 0;
UPDATE posts SET content = content || ' (v2)'   WHERE id % 6 = 0;

-- 2. TODO : requête sur pg_stat_user_tables pour voir dead_pct et last_autovacuum
SELECT ???
FROM pg_stat_user_tables
WHERE relname = 'posts';
```

**Corrigé — diagnostic** :

```sql
SELECT relname,
       n_live_tup,
       n_dead_tup,
       ROUND(100.0 * n_dead_tup
             / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_vacuum,
       last_autovacuum
FROM pg_stat_user_tables
WHERE relname = 'posts';
```

`dead_pct` doit être autour de 20-25 %. `last_autovacuum` peut être NULL (autovacuum n'a pas encore tourné ou est bloqué).

```sql
-- 3. Simuler une session idle in transaction
--    Ouvre une 2e connexion psql et exécute :
BEGIN;
UPDATE posts SET content = content || ' (hold)' WHERE id = 1;
-- Ne pas commiter — laisser la connexion ouverte

-- 4. Dans ta connexion principale : détecter la session bloquante
SELECT pid,
       usename,
       now() - xact_start AS idle_since,
       LEFT(query, 80) AS last_query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY xact_start;

-- 5. Lancer VACUUM (il tourne mais ne peut pas libérer les tuples antérieurs
--    au xact_start de la session ouverte)
VACUUM ANALYZE posts;

-- 6. Fermer la 2e connexion (ROLLBACK dans psql2) puis VACUUM à nouveau
VACUUM ANALYZE posts;

-- 7. Revérifier : n_dead_tup doit revenir à 0
SELECT relname, n_live_tup, n_dead_tup, last_vacuum
FROM pg_stat_user_tables
WHERE relname = 'posts';
```

Observation attendue : après l'étape 5, VACUUM s'exécute mais `n_dead_tup` reste élevé — les tuples antérieurs au `xact_start` de la session ouverte ne peuvent pas être libérés. Après la fermeture de la 2e connexion (étape 6), VACUUM nettoie complètement.

---

## Variante J+30

- Active `log_min_duration_statement = 0` (tout loguer), lance quelques requêtes, puis lis les logs PostgreSQL. Compare avec ce que `pg_stat_statements` affiche pour les mêmes requêtes : observe la différence entre valeurs normalisées (`$1`) dans `pg_stat_statements` et valeurs réelles dans les logs.
- Mesure le cache hit ratio avec `pg_stat_database` avant et après avoir exécuté 1 000 fois la requête feed sur une famille différente à chaque fois — observe si le ratio évolue selon la taille de `shared_buffers`.
- Identifie les index inutilisés via `pg_stat_user_indexes` (après un restart, tous les compteurs `idx_scan` sont à zéro — attends un cycle avant de décider qu'un index est mort) :

```sql
SELECT relname, indexrelname, idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND indexrelname NOT LIKE '%_pkey'
ORDER BY pg_relation_size(indexrelid) DESC;
```

- Configure `idle_in_transaction_session_timeout = '2min'` via `ALTER SYSTEM SET idle_in_transaction_session_timeout = '2min'; SELECT pg_reload_conf();` et vérifie qu'une session `BEGIN` sans `COMMIT` est bien terminée automatiquement après 2 minutes.

---

## Navigation

| | Lien |
|---|---|
| Module associé | [Module 17 — Monitoring et observabilité](../../modules/17-monitoring-et-observabilite.md) |
| Module suivant | [Module 18 — Partitioning et scaling](../../modules/18-partitioning-et-scaling.md) |
