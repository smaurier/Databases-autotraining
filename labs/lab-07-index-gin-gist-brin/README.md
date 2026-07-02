# Lab 07 — Index avancés : GIN, BRIN et Index Only Scan

> **Vrai outil :** SQL + `EXPLAIN (ANALYZE, BUFFERS)` sur une base PostgreSQL locale (Docker).
> Mesure d'abord, index ensuite — chaque exercice suit le cycle **audit → fix → vérifie**.

## Pré-requis

- Module 06 terminé (lire et interpréter un plan EXPLAIN ANALYZE)
- Base Docker disponible : `docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17`

---

## Setup — schéma et données

Ouvrir `psql` et coller le bloc complet. Il prend ~10 s.

```sql
-- Nettoyer si le lab a déjà été joué
DROP TABLE IF EXISTS posts, users CASCADE;

-- Schéma TribuZen minimal
CREATE TABLE users (
  id           SERIAL PRIMARY KEY,
  display_name TEXT NOT NULL
);

CREATE TABLE posts (
  id         SERIAL PRIMARY KEY,
  author_id  INT NOT NULL REFERENCES users(id),
  family_id  INT NOT NULL,
  content    TEXT,
  tags       JSONB NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'published',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Données : 500 users, 80 000 posts
INSERT INTO users SELECT i, 'User '||i FROM generate_series(1, 500) i;

INSERT INTO posts
  SELECT
    i,
    (random()*499+1)::int,
    (random()*49+1)::int,
    repeat('Post TribuZen ', 8),
    (ARRAY[
      '{"voyage": true}',
      '{"sport": true}',
      '{"famille": true}',
      '{"voyage": true, "famille": true}',
      '{}'
    ]::jsonb[])[((random()*4)::int + 1)],
    CASE WHEN random() < 0.8 THEN 'published' ELSE 'draft' END,
    now() - (random()*180 || ' days')::interval
  FROM generate_series(1, 80000) i;

ANALYZE;
```

---

## Exercice 1 — Audit : recherche par tag sans index

**Objectif :** mesurer le coût de la recherche par tag sans index GIN.

```sql
-- Étape 1 : confirmer qu'il n'y a pas d'index sur tags
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'posts' AND indexdef ILIKE '%tags%';
-- Résultat attendu : aucune ligne

-- Étape 2 : observer le plan
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.tags @> '{"voyage": true}'
ORDER BY p.created_at DESC
LIMIT 20;
```

**Ce que tu dois voir :**

```
Seq Scan on posts p  (actual time=... rows=80000 loops=1)
  Filter: (tags @> '{"voyage": true}')
  Rows Removed by Filter: ~63000
  Buffers: shared read=6000+
Execution Time: 1200–1600 ms
```

**Questions d'audit :**
1. Combien de lignes PostgreSQL lit-il pour en retourner 20 ?
2. Pourquoi un B-tree standard ne peut-il pas servir l'opérateur `@>` ?
3. La colonne `tags` est de type JSONB — quel type d'index est nécessaire ?

---

## Exercice 1 — Fix : créer l'index GIN

```sql
-- Créer l'index GIN (jsonb_path_ops car seul @> est utilisé)
CREATE INDEX CONCURRENTLY idx_posts_tags_gin
  ON posts USING GIN (tags jsonb_path_ops);

ANALYZE posts;

-- Relancer la même requête et comparer
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.tags @> '{"voyage": true}'
ORDER BY p.created_at DESC
LIMIT 20;
```

**Ce que tu dois voir :**

```
Bitmap Index Scan on idx_posts_tags_gin
  Index Cond: (tags @> '{"voyage": true}')
  Buffers: shared hit=40–60
Execution Time: 2–5 ms
```

**Checkpoint :** le Seq Scan a disparu. `shared read` élevé → `shared hit` faible. Execution Time divisé par ~400.

---

## Exercice 2 — Audit : lecture du feed famille sans covering index

**Objectif :** montrer que l'Index Scan lit encore la heap pour les colonnes non indexées.

```sql
-- Créer l'index composite de base (sans INCLUDE)
CREATE INDEX idx_posts_fam_date
  ON posts (family_id, created_at DESC);

ANALYZE posts;

EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.author_id, p.content
FROM posts p
WHERE p.family_id = 2
ORDER BY p.created_at DESC
LIMIT 20;
```

**Ce que tu dois voir :**

```
Index Scan using idx_posts_fam_date on posts p
  Index Cond: (family_id = 2)
  Buffers: shared hit=4 read=10–20
```

`read > 0` : PostgreSQL lit des pages heap pour obtenir `author_id` et `content`, qui ne sont pas dans l'index.

---

## Exercice 2 — Fix : covering index avec INCLUDE

```sql
-- Remplacer par un covering index
DROP INDEX idx_posts_fam_date;

CREATE INDEX idx_posts_fam_date_cov
  ON posts (family_id, created_at DESC)
  INCLUDE (author_id, content);

ANALYZE posts;

EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.author_id, p.content
FROM posts p
WHERE p.family_id = 2
ORDER BY p.created_at DESC
LIMIT 20;
```

**Ce que tu dois voir :**

```
Index Only Scan using idx_posts_fam_date_cov on posts p
  Index Cond: (family_id = 2)
  Heap Fetches: 0
  Buffers: shared hit=4
```

**Checkpoint :** `Index Only Scan` + `Heap Fetches: 0` + `shared read=0`. La heap n'est plus lue. `author_id` et `content` sont lus directement dans les feuilles de l'index.

---

## Exercice 3 — Audit : taille d'un B-tree vs BRIN sur created_at

**Objectif :** comparer la taille des deux types d'index sur une colonne temporelle corrélée.

```sql
-- Vérifier la corrélation physique de created_at
-- (données insérées avec random() → corrélation variable, pas idéale,
--  mais l'exercice illustre la commande et la lecture)
SELECT attname, round(correlation::numeric, 4) AS correlation
FROM pg_stats
WHERE tablename = 'posts' AND attname = 'created_at';

-- Créer un B-tree et un BRIN sur created_at pour comparaison
CREATE INDEX idx_posts_created_btree ON posts (created_at DESC);
CREATE INDEX idx_posts_created_brin  ON posts USING BRIN (created_at);

ANALYZE posts;

-- Comparer les tailles
SELECT
  indexrelname,
  pg_size_pretty(pg_relation_size(indexrelid)) AS taille
FROM pg_stat_user_indexes
WHERE relname = 'posts'
  AND indexrelname IN ('idx_posts_created_btree', 'idx_posts_created_brin')
ORDER BY indexrelname;
```

**Ce que tu dois voir (ordre de grandeur) :**

```
idx_posts_created_brin  |  48 KB
idx_posts_created_btree |  1800 KB
```

Le BRIN est ~37× plus petit. Sur 10M de lignes, l'écart atteint typiquement ×4 000.

```sql
-- Comparer les plans sur une requête de plage temporelle
EXPLAIN (ANALYZE, BUFFERS)
SELECT COUNT(*) FROM posts
WHERE created_at >= now() - INTERVAL '30 days';
-- Avec B-tree : Index Scan ou Bitmap Index Scan
-- Avec BRIN   : Bitmap Index Scan (moins précis mais compact)
```

---

## Exercice 4 — Index partiel sur les posts publiés

**Objectif :** créer un index partiel plus compact et plus rapide à maintenir.

```sql
-- Mesurer la proportion de posts publiés vs brouillons
SELECT status, COUNT(*) FROM posts GROUP BY status;

-- Créer un index partiel sur les posts publiés uniquement
CREATE INDEX idx_posts_pub_date
  ON posts (created_at DESC)
  WHERE status = 'published';

ANALYZE posts;

-- Requête qui matche la condition de l'index
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content, created_at
FROM posts
WHERE status = 'published'
  AND created_at > now() - INTERVAL '7 days'
ORDER BY created_at DESC
LIMIT 20;
-- → Index Scan using idx_posts_pub_date

-- Requête qui ne matche PAS (condition différente)
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content, created_at
FROM posts
WHERE status IN ('published', 'draft')
  AND created_at > now() - INTERVAL '7 days'
ORDER BY created_at DESC
LIMIT 20;
-- → Seq Scan (l'index partiel ne peut pas servir cette condition élargie)
```

---

## Récapitulatif des index créés

```sql
-- Voir tous les index créés pendant le lab
SELECT
  indexname,
  pg_size_pretty(pg_relation_size(indexrelid)) AS taille,
  indexdef
FROM pg_indexes
JOIN pg_stat_user_indexes USING (indexrelname)
WHERE tablename = 'posts'
ORDER BY pg_relation_size(indexrelid) DESC;
```

---

## Corrigé complet — commandes dans l'ordre

```sql
-- 0. SETUP
DROP TABLE IF EXISTS posts, users CASCADE;
CREATE TABLE users (id SERIAL PRIMARY KEY, display_name TEXT NOT NULL);
CREATE TABLE posts (
  id SERIAL PRIMARY KEY, author_id INT NOT NULL REFERENCES users(id),
  family_id INT NOT NULL, content TEXT,
  tags JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'published',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO users SELECT i, 'User '||i FROM generate_series(1,500) i;
INSERT INTO posts SELECT i, (random()*499+1)::int, (random()*49+1)::int,
  repeat('Post TribuZen ',8),
  (ARRAY['{"voyage":true}','{"sport":true}','{"famille":true}',
         '{"voyage":true,"famille":true}','{}']::jsonb[])[((random()*4)::int+1)],
  CASE WHEN random()<0.8 THEN 'published' ELSE 'draft' END,
  now()-(random()*180||' days')::interval
  FROM generate_series(1,80000) i;
ANALYZE;

-- 1. GIN sur tags JSONB
CREATE INDEX CONCURRENTLY idx_posts_tags_gin ON posts USING GIN (tags jsonb_path_ops);
ANALYZE posts;
-- Vérifier : EXPLAIN sur WHERE tags @> '{"voyage": true}' → Bitmap Index Scan

-- 2. Covering index pour Index Only Scan
CREATE INDEX idx_posts_fam_date_cov
  ON posts (family_id, created_at DESC) INCLUDE (author_id, content);
ANALYZE posts;
-- Vérifier : EXPLAIN sur SELECT author_id, content WHERE family_id=2 → Index Only Scan, Heap Fetches: 0

-- 3. BRIN vs B-tree sur created_at
CREATE INDEX idx_posts_created_btree ON posts (created_at DESC);
CREATE INDEX idx_posts_created_brin  ON posts USING BRIN (created_at);
-- Comparer tailles via pg_stat_user_indexes

-- 4. Index partiel
CREATE INDEX idx_posts_pub_date ON posts (created_at DESC) WHERE status = 'published';
-- Vérifier : EXPLAIN sur WHERE status='published' AND created_at > ... → Index Scan using idx_posts_pub_date
-- Vérifier : EXPLAIN sur WHERE status IN ('published','draft') → Seq Scan (partiel ignoré)
```

---

## Variante J+30 (fading)

> Refais sans regarder tes notes ni le corrigé ci-dessus. Ferme ce README, ouvre un terminal psql frais.

**Nouveau cas : table `comments` avec tags JSONB et horodatage.**

```sql
-- Setup du nouveau cas (coller tel quel)
DROP TABLE IF EXISTS comments CASCADE;
CREATE TABLE comments (
  id         SERIAL PRIMARY KEY,
  post_id    INT NOT NULL,
  author_id  INT NOT NULL,
  body       TEXT,
  tags       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO comments
  SELECT i,
    (random()*999+1)::int,
    (random()*199+1)::int,
    repeat('Commentaire TribuZen ', 5),
    (ARRAY[
      '{"humour": true}',
      '{"question": true}',
      '{"humour": true, "question": true}',
      '{}'
    ]::jsonb[])[((random()*3)::int + 1)],
    now() - (random()*365 || ' days')::interval
  FROM generate_series(1, 120000) i;
ANALYZE;
```

**Sans regarder le lab, réponds à ces trois cas de requête et choisis l'index adapté :**

1. Recherche par tag : `WHERE tags @> '{"humour": true}'` — quel type d'index ? Pourquoi pas B-tree ?
2. Plage temporelle récente : `WHERE created_at >= now() - INTERVAL '14 days'` sur 120 000 lignes — BRIN ou B-tree ? Quand BRIN est-il préférable ?
3. Feed par auteur trié par date : `WHERE author_id = $1 ORDER BY created_at DESC LIMIT 20` — index composite ou covering ? Quelles colonnes dans `INCLUDE` ?

**Pour chaque cas :**

```sql
-- a. Mesurer sans index (Seq Scan)
EXPLAIN (ANALYZE, BUFFERS)
<ta requête>;

-- b. Créer l'index que tu as choisi (de mémoire)
CREATE INDEX ...;
ANALYZE comments;

-- c. Relancer et vérifier : Seq Scan disparu, Execution Time divisé par au moins ×50
EXPLAIN (ANALYZE, BUFFERS)
<ta requête>;
```

**Critère de réussite :** les trois EXPLAIN après index montrent un plan différent du Seq Scan initial, et tu as correctement justifié avant de regarder pourquoi B-tree ne sert pas `@>`.

---

## Navigation

| | Lien |
|---|---|
| Module | [07 — Index avancés](../../modules/07-index-avances.md) |
| Module précédent | [06 — Query planner](../../modules/06-query-planner.md) |
| Module suivant | [08 — Niveaux d'isolation](../../modules/08-niveaux-isolation.md) |
