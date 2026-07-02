# Lab 06 — Query Planner Deep Dive

> **Outcome :** à la fin, tu as analysé et optimisé la requête du feed famille TribuZen avec `EXPLAIN ANALYZE` — tu identifies les Seq Scan, tu crées les index composites, tu lis les métriques `Buffers` pour prouver chaque amélioration, et tu diagnostiques un index ignoré par un prédicat fonctionnel.
> **Vrai outil :** psql / SQL réel (PostgreSQL 17 local via Docker). Aucune simulation.
> **Feedback :** le coach valide en session.

## Prérequis · Durée

- Module 06 lu
- Docker + psql (ou DBeaver)
- Durée estimée : 45 min

## Setup

```sql
-- 1. Créer la base et le schéma
CREATE DATABASE tribuzen_lab06;
\c tribuzen_lab06

CREATE TABLE users (
  id           SERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,
  avatar_url   TEXT
);

CREATE TABLE families (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE posts (
  id         SERIAL PRIMARY KEY,
  author_id  INT  NOT NULL REFERENCES users(id),
  family_id  INT  NOT NULL REFERENCES families(id),
  content    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reactions (
  id      SERIAL PRIMARY KEY,
  post_id INT NOT NULL REFERENCES posts(id)
);

-- 2. Données de test réalistes
INSERT INTO users
  SELECT i, 'User '||i, 'https://cdn.tribu/'||i
  FROM generate_series(1, 200) i;

INSERT INTO families
  SELECT i, 'Famille '||i
  FROM generate_series(1, 20) i;

INSERT INTO posts
  SELECT
    i,
    (random()*199 + 1)::int,
    (random()*19  + 1)::int,
    repeat('Post TribuZen contenu ', 10),
    now() - (random()*180 || ' days')::interval
  FROM generate_series(1, 60000) i;

INSERT INTO reactions
  SELECT i, (random()*59999 + 1)::int
  FROM generate_series(1, 250000) i;

ANALYZE;
```

---

## Étape 1 — Lire le plan initial (Seq Scan)

La requête du feed famille charge les 20 derniers posts d'une famille avec auteur, nom de famille et compteur de réactions.

**TODO** : exécute `EXPLAIN` (sans ANALYZE) sur la requête ci-dessous. Quel type de scan apparaît sur `posts` ? Quel est le `cost` total estimé ?

```sql
EXPLAIN
SELECT
  p.id,
  p.content,
  p.created_at,
  u.display_name,
  f.name              AS family_name,
  COUNT(r.id)         AS reaction_count
FROM posts p
JOIN users u        ON p.author_id = u.id
JOIN families f     ON p.family_id = f.id
LEFT JOIN reactions r ON r.post_id = p.id
WHERE p.family_id = 1
  AND p.created_at > NOW() - INTERVAL '30 days'
GROUP BY p.id, u.display_name, u.avatar_url, f.name
ORDER BY p.created_at DESC
LIMIT 20;
```

**Corrigé** : tu vois un `Seq Scan on posts` avec un coût total élevé (~5 000+). PostgreSQL lit les 60 000 lignes pour filtrer les ~170 de la famille 1 dans les 30 derniers jours — il n'existe aucun index sur `family_id` ou `created_at`.

---

## Étape 2 — Ajouter un index et comparer

**TODO** : crée un index composite qui couvre à la fois le filtre `family_id` et le tri `created_at DESC`, puis relance le même `EXPLAIN`.

```sql
-- TODO : complète l'index (colonnes + ordre)
CREATE INDEX ??? ON posts(???, ???);
ANALYZE posts;

-- Puis relance EXPLAIN avec la même requête
```

**Corrigé** :

```sql
CREATE INDEX idx_posts_family_date ON posts(family_id, created_at DESC);
ANALYZE posts;
```

Le plan passe à `Index Scan using idx_posts_family_date`. Le nœud `Sort` sur `created_at DESC` **disparaît** — l'index livre les données dans l'ordre voulu. Le coût chute de ~5 000 à ~150.

> L'ordre des colonnes dans l'index est intentionnel : `family_id` en premier pour le filtre d'égalité, `created_at DESC` en second pour le tri sans Sort supplémentaire.

---

## Étape 3 — EXPLAIN ANALYZE + BUFFERS (métriques réelles)

**TODO** : ajoute `ANALYZE` et `BUFFERS` aux options d'`EXPLAIN`. Compare `shared read` avant et après l'index.

```sql
-- TODO : complète les options
EXPLAIN (???, ???)
SELECT
  p.id,
  p.content,
  p.created_at,
  u.display_name,
  f.name              AS family_name,
  COUNT(r.id)         AS reaction_count
FROM posts p
JOIN users u        ON p.author_id = u.id
JOIN families f     ON p.family_id = f.id
LEFT JOIN reactions r ON r.post_id = p.id
WHERE p.family_id = 1
  AND p.created_at > NOW() - INTERVAL '30 days'
GROUP BY p.id, u.display_name, u.avatar_url, f.name
ORDER BY p.created_at DESC
LIMIT 20;
```

**Corrigé** :

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT
  p.id,
  p.content,
  p.created_at,
  u.display_name,
  f.name              AS family_name,
  COUNT(r.id)         AS reaction_count
FROM posts p
JOIN users u        ON p.author_id = u.id
JOIN families f     ON p.family_id = f.id
LEFT JOIN reactions r ON r.post_id = p.id
WHERE p.family_id = 1
  AND p.created_at > NOW() - INTERVAL '30 days'
GROUP BY p.id, u.display_name, u.avatar_url, f.name
ORDER BY p.created_at DESC
LIMIT 20;
```

Observe dans le plan :

| Métrique | Sans index | Avec index |
|---|---|---|
| `Execution Time` | ~1 800 ms | < 5 ms |
| `Buffers: shared read` (posts) | ~5 823 pages | 0 |
| `Buffers: shared hit` (index) | — | 4 pages |
| Stratégie jointure | Hash Join | Nested Loop + Index Scan |

Les Hash Join laissent place à des Nested Loop car la table externe (posts filtrés) est maintenant minuscule — 20 lignes seulement.

---

## Étape 4 — Diagnostiquer un index ignoré

La table `users` a un index sur `display_name`, mais la recherche ci-dessous ne l'utilise pas.

**TODO** : exécute `EXPLAIN`, identifie pourquoi l'index est ignoré, puis crée l'index fonctionnel correct.

```sql
CREATE INDEX idx_users_display ON users(display_name);
ANALYZE users;

-- Cette requête utilise-t-elle l'index ?
EXPLAIN SELECT * FROM users WHERE LOWER(display_name) = 'user 42';
```

**Corrigé** : `LOWER()` appliqué à la colonne empêche l'utilisation de l'index sur `display_name` brut. L'index stocke les valeurs d'origine, pas leurs versions en minuscules. Solution — index fonctionnel :

```sql
CREATE INDEX idx_users_display_lower ON users(LOWER(display_name));
ANALYZE users;

EXPLAIN SELECT * FROM users WHERE LOWER(display_name) = 'user 42';
-- Index Scan using idx_users_display_lower on users
--   Index Cond: (lower(display_name) = 'user 42')
```

Le plan passe à Index Scan car l'expression de la condition correspond exactement à l'expression indexée.

---

## Étape 5 — Observer l'impact des statistiques

**TODO** : dégrades les statistiques de `posts.family_id` et observe l'estimation `rows` dans le plan.

```sql
-- Réduire la précision des statistiques (simule des stats obsolètes)
ALTER TABLE posts ALTER COLUMN family_id SET STATISTICS 0;
VACUUM ANALYZE posts;

EXPLAIN SELECT * FROM posts WHERE family_id = 1;
-- Observer : rows estimées vs réalité attendue (~3 000)

-- Restaurer la précision et relancer
ALTER TABLE posts ALTER COLUMN family_id SET STATISTICS -1;
ANALYZE posts;

EXPLAIN SELECT * FROM posts WHERE family_id = 1;
-- Les estimations sont maintenant précises
```

**Corrigé** : avec `STATISTICS 0`, le planner ne dispose d'aucun histogramme et estime grossièrement (souvent 30 lignes pour une table de 60 000). Avec `STATISTICS -1` (défaut = 100 buckets), l'estimation `rows` est proche de la réalité. Un écart `rows estimées / rows réelles` > ×10 dans `EXPLAIN ANALYZE` est le signal pour lancer `ANALYZE`.

---

## Variante J+30

- Crée un index sur `reactions(post_id)` et observe si la stratégie du LEFT JOIN change dans le plan.
- Teste `SET random_page_cost = 1.1;` avant `EXPLAIN` : le planner préfère-t-il davantage les Index Scan ?
- Tente un **covering index** `(family_id, created_at DESC, author_id, content)` et vérifie si un **Index Only Scan** apparaît pour les colonnes couvertes.
- Utilise `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` depuis Node.js (`pg.Pool`) et inspecte le champ `"Execution Time"` pour logguer automatiquement les plans lents.

---

## Application TribuZen

Porte ce lab dans le vrai repo `smaurier/tribuzen` :

1. Lance psql sur ta base de développement TribuZen. Exécute `EXPLAIN (ANALYZE, BUFFERS)` sur la requête de feed famille (20 derniers posts d'une famille avec auteur et compteur de réactions).
2. Identifie les Seq Scan. Crée l'index composite `@@index([familyId, createdAt(sort: Desc)])` sur le model `Post` dans `schema.prisma`. Lance `npx prisma migrate dev --name add-feed-index`. Relance `EXPLAIN ANALYZE` et confirme la disparition du Sort node.
3. Si ta table `users` a une recherche case-insensitive sur `displayName`, crée l'index fonctionnel `LOWER(display_name)` et vérifie qu'il est utilisé.
4. Commit `smaurier/tribuzen` : `perf(db): index composite feed family + index fonctionnel users`.

---

## Navigation

| | Lien |
|---|---|
| Module associé | [Module 06 — Query planner](../../modules/06-query-planner.md) |
| Module suivant | [Module 07 — Index avancés](../../modules/07-index-avances.md) |
