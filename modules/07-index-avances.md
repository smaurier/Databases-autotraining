---
titre: Index avancés
cours: 10-postgresql
notions: [index GIN pour jsonb et tableaux, index GiST, index BRIN pour gros volumes ordonnés, index partiel, index sur expression, index couvrant et index-only scan, index multicolonne, création CONCURRENTLY]
outcomes: [choisir GIN GiST ou BRIN selon le cas, créer un index partiel ou sur expression, obtenir un index-only scan, créer un index sans bloquer la table]
prerequis: [06-query-planner]
next: 08-niveaux-isolation
libs: [{ name: postgresql, version: "17" }]
tribuzen: index GIN sur les tags jsonb des posts TribuZen pour la recherche
last-reviewed: 2026-07
---

# Index avancés

> **Outcomes — tu sauras FAIRE :** choisir GIN, GiST ou BRIN selon la nature des données, créer un index partiel ou sur expression, obtenir un Index Only Scan avec INCLUDE, créer un index sans bloquer la table avec CONCURRENTLY.
> **Difficulté :** :star::star::star:

## 1. Cas concret d'abord

Dans TribuZen, chaque post peut porter des **tags JSONB** : `{"voyage": true, "famille": true}`. La page de recherche filtre les posts par tag — en production avec 80 000 posts, la requête prend **1,4 s** sans index.

```sql
-- Requête de recherche de posts par tag TribuZen
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.tags @> '{"voyage": true}'
ORDER BY p.created_at DESC
LIMIT 20;
```

```
Seq Scan on posts p  (cost=0.00..6420.00 rows=80000 width=200)
                     (actual time=0.015..1380.000 rows=80000 loops=1)
  Filter: (tags @> '{"voyage": true}')
  Rows Removed by Filter: 63260
  Buffers: shared read=6420
Planning Time: 1.1 ms
Execution Time: 1412.7 ms
```

PostgreSQL lit les **80 000** lignes pour en retourner ~16 740 : l'opérateur `@>` sur JSONB ne peut pas utiliser un index B-tree — il lui faut un **GIN**. Après `CREATE INDEX idx_posts_tags ON posts USING GIN (tags)`, la même requête tombe à **3 ms**. La suite donne les règles pour choisir le bon index dans chaque cas.

## 2. Théorie complète, concise

### GIN — Generalized Inverted Index

Le GIN est un **index inversé** : au lieu de stocker *ligne → valeur*, il stocke *valeur → liste de lignes*. Idéal pour les types **composites** qui contiennent plusieurs éléments indexables (JSONB, tableaux, `tsvector`).

```sql
-- GIN sur colonne JSONB
CREATE INDEX idx_posts_tags ON posts USING GIN (tags);

-- @> containment : le document contient-il cette sous-structure ?
SELECT * FROM posts WHERE tags @> '{"voyage": true}';   -- utilise GIN

-- ? existence de clé
SELECT * FROM posts WHERE tags ? 'voyage';               -- utilise GIN

-- ?| au moins une clé présente
SELECT * FROM posts WHERE tags ?| ARRAY['voyage', 'sport'];

-- ?& toutes les clés présentes
SELECT * FROM posts WHERE tags ?& ARRAY['voyage', 'famille'];
```

**Classe d'opérateurs** — choisir selon les opérateurs réellement utilisés :

| Classe | Opérateurs | Taille index |
|---|---|---|
| `jsonb_ops` (défaut) | `@>`, `?`, `?|`, `?&` | Plus grande |
| `jsonb_path_ops` | `@>` uniquement | Plus petite (~30 %) |

```sql
-- Si seul @> est utilisé, path_ops est plus compact
CREATE INDEX idx_posts_tags_path ON posts USING GIN (tags jsonb_path_ops);
```

**GIN sur tableau** — mêmes opérateurs (`@>`, `&&`, `<@`) :

```sql
-- Colonne TEXT[] au lieu de JSONB
CREATE INDEX idx_posts_tag_arr ON posts USING GIN (tag_list);
SELECT * FROM posts WHERE tag_list @> ARRAY['voyage'];
SELECT * FROM posts WHERE tag_list && ARRAY['voyage', 'sport'];
```

**Coût en écriture** — chaque INSERT d'une valeur composite produit *N* entrées d'index (une par clé). Le GIN utilise une **pending list** pour amortir le coût :

```sql
-- fastupdate=on (défaut) : entrées tamponnées, flush lors du VACUUM
CREATE INDEX idx_tags_gin ON posts USING GIN (tags) WITH (fastupdate = on);
```

### GiST — Generalized Search Tree

GiST est un framework d'arbre **multi-dimensionnel** pour les types qui ne s'ordonnent pas linéairement : ranges, géométrie, `tsvector`.

```sql
-- GiST sur un type range (réservations de créneaux)
CREATE TABLE reservations (
  id      SERIAL PRIMARY KEY,
  salle   TEXT NOT NULL,
  creneau tstzrange NOT NULL
);
CREATE INDEX idx_res_creneau ON reservations USING GIST (creneau);

-- Opérateur && = chevauchement : trouve les conflits de créneau
SELECT * FROM reservations
WHERE creneau && '[2026-07-10 14:00, 2026-07-10 16:00)'::tstzrange;

-- Contrainte d'exclusion — empêche deux réservations qui se chevauchent sur la même salle
ALTER TABLE reservations
ADD CONSTRAINT pas_overlap
EXCLUDE USING GIST (salle WITH =, creneau WITH &&);
```

**GiST vs GIN pour `tsvector`** :

| Critère | GIN | GiST |
|---|---|---|
| Vitesse SELECT | Rapide (index inversé) | Plus lent (recheck possible) |
| Taille | Plus grande | Plus petite |
| INSERT | Plus lent | Plus rapide |
| Recommandation | Tables stables | Tables à forte écriture |

### BRIN — Block Range INdex

BRIN stocke seulement le **min/max par groupe de pages** (128 pages par défaut). Extrêmement compact — efficace uniquement si les données sont **physiquement ordonnées** sur disque.

```sql
-- Vérifier la corrélation physique AVANT de créer un BRIN
SELECT attname, correlation
FROM pg_stats
WHERE tablename = 'posts' AND attname = 'created_at';
-- correlation ~1.0 → BRIN efficace | correlation ~0.0 → BRIN inutile

-- BRIN sur un timestamp (posts insérés chronologiquement)
CREATE INDEX idx_posts_created_brin ON posts USING BRIN (created_at);
-- Résultat : quelques dizaines de KB pour 80 000 lignes vs ~3 MB en B-tree

-- Régler la granularité
CREATE INDEX idx_posts_created_brin ON posts USING BRIN (created_at)
WITH (pages_per_range = 32);   -- plus précis, index un peu plus grand
```

### Index partiel

Un index partiel n'indexe que les lignes satisfaisant une clause `WHERE`. Plus petit, plus rapide à maintenir.

```sql
-- Indexer uniquement les posts publiés (pas les brouillons ni les archivés)
CREATE INDEX idx_posts_published ON posts (created_at DESC)
WHERE status = 'published';

-- La requête DOIT inclure la même condition pour utiliser l'index
SELECT id, content FROM posts
WHERE status = 'published'
  AND created_at > NOW() - INTERVAL '7 days'
ORDER BY created_at DESC;
-- → Index Scan using idx_posts_published (condition matche)

-- N'utilise PAS l'index (condition différente)
SELECT id, content FROM posts
WHERE status IN ('published', 'pinned')
ORDER BY created_at DESC;
```

### Index sur expression (fonctionnel)

Un index sur une expression stocke le résultat de la fonction, pas la valeur brute.

```sql
-- Recherche insensible à la casse sur le display_name
CREATE INDEX idx_users_name_lower ON users (LOWER(display_name));

-- La condition DOIT reproduire l'expression exacte
SELECT * FROM users WHERE LOWER(display_name) = 'alice';
-- → Index Scan using idx_users_name_lower

-- Sans cet index, LOWER(display_name) = 'alice' force un Seq Scan
-- même si un B-tree standard existe sur display_name
EXPLAIN SELECT * FROM users WHERE LOWER(display_name) = 'alice';
-- Seq Scan on users  Filter: (lower(display_name) = 'alice')
```

### Index couvrant et Index Only Scan

Un **covering index** avec `INCLUDE` ajoute des colonnes dans les **feuilles** de l'index sans les inclure dans l'arbre de tri. Le planner peut alors lire toutes les colonnes du `SELECT` depuis l'index seul — **Index Only Scan** — sans toucher la heap.

```sql
-- Index composite seul → Index Scan (doit lire la heap pour author_id et content)
CREATE INDEX idx_posts_fam_date ON posts (family_id, created_at DESC);

-- Covering index → Index Only Scan (heap non lue)
CREATE INDEX idx_posts_fam_date_cov ON posts (family_id, created_at DESC)
INCLUDE (author_id, content);

-- Vérifier que le plan utilise bien Index Only Scan
EXPLAIN (ANALYZE, BUFFERS)
SELECT author_id, content
FROM posts
WHERE family_id = 1
ORDER BY created_at DESC
LIMIT 20;
-- Index Only Scan using idx_posts_fam_date_cov  Heap Fetches: 0
```

**Différence INCLUDE vs colonnes dans l'arbre** :

| Aspect | `(a, b, c)` | `(a, b) INCLUDE (c)` |
|---|---|---|
| Filtre sur c via l'index | Oui | Non |
| Tri sur c via l'index | Oui | Non |
| Index Only Scan sur SELECT a, b, c | Oui | Oui |
| Taille de l'arbre | Plus grand | Plus compact |

### Index multicolonne

L'ordre des colonnes est déterminant. Le planner peut utiliser l'index pour le **préfixe gauche** des colonnes.

```sql
CREATE INDEX idx_posts_fam_date ON posts (family_id, created_at DESC);

-- Utilise l'index (family_id est le préfixe)
SELECT * FROM posts WHERE family_id = 1;
SELECT * FROM posts WHERE family_id = 1 AND created_at > '2026-01-01';

-- N'utilise PAS l'index (created_at seul — pas le préfixe gauche)
SELECT * FROM posts WHERE created_at > '2026-01-01';
```

### Création CONCURRENTLY

`CREATE INDEX CONCURRENTLY` construit l'index sans poser de verrou exclusif sur la table — les lectures et écritures continuent pendant la construction.

```sql
-- Sans CONCURRENTLY : verrou exclusif, toutes les écritures bloquées pendant la construction
CREATE INDEX idx_posts_tags ON posts USING GIN (tags);

-- Avec CONCURRENTLY : pas de verrou, la table reste accessible en lecture et écriture
CREATE INDEX CONCURRENTLY idx_posts_tags ON posts USING GIN (tags);
```

Contraintes : interdit dans une transaction (`BEGIN`/`COMMIT`) ; deux passes sur la table → construction plus longue ; si interrompue, l'index reste en état `INVALID`.

```sql
-- Vérifier les index invalides après une interruption
SELECT indexrelid::regclass AS index_name, indisvalid
FROM pg_index
WHERE NOT indisvalid;
-- → supprimer l'index INVALID et recommencer
```

## 3. Worked examples

### Exemple A — GIN sur les tags JSONB des posts TribuZen

Schéma + données de test :

```sql
CREATE TABLE users (id SERIAL PRIMARY KEY, display_name TEXT);
CREATE TABLE posts (
  id         SERIAL PRIMARY KEY,
  author_id  INT NOT NULL REFERENCES users(id),
  family_id  INT NOT NULL,
  content    TEXT,
  tags       JSONB NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'published',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
    'published',
    now() - (random()*180 || ' days')::interval
  FROM generate_series(1, 80000) i;
ANALYZE;
```

Plan **avant index GIN** :

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.tags @> '{"voyage": true}'
ORDER BY p.created_at DESC
LIMIT 20;
```

```
Limit  (actual time=1412.780..1412.790 rows=20 loops=1)
  ->  Sort  (actual time=1412.778..1412.780 rows=20 loops=1)
        Sort Key: p.created_at DESC
        ->  Hash Join  (actual time=0.920..1409.100 rows=16740 loops=1)
              ->  Seq Scan on posts p
                    (actual time=0.018..1380.000 rows=80000 loops=1)
                    Filter: (tags @> '{"voyage": true}')
                    Rows Removed by Filter: 63260
                    Buffers: shared read=6420
              ->  Hash on users u  (rows=500 loops=1)
Execution Time: 1412.9 ms
```

Ajout de l'index GIN :

```sql
CREATE INDEX CONCURRENTLY idx_posts_tags_gin ON posts USING GIN (tags jsonb_path_ops);
ANALYZE posts;
```

Plan **après index GIN** :

```
Limit  (actual time=2.840..3.010 rows=20 loops=1)
  ->  Sort  (actual time=2.838..2.840 rows=20 loops=1)
        Sort Key: p.created_at DESC
        ->  Nested Loop  (actual time=0.480..2.720 rows=16740 loops=1)
              ->  Bitmap Index Scan on idx_posts_tags_gin
                    (actual time=0.320..0.580 rows=16740 loops=1)
                    Index Cond: (tags @> '{"voyage": true}')
                    Buffers: shared hit=48
              ->  Index Scan using users_pkey on users u  (loops=16740)
                    Buffers: shared hit=52
Execution Time: 3.1 ms
```

Pas-à-pas : (1) sans GIN, l'opérateur `@>` ne peut pas utiliser un B-tree — toutes les lignes sont évaluées (Seq Scan, 6 420 pages lues depuis le disque) ; (2) `jsonb_path_ops` est choisi car seul `@>` est utilisé — l'index est ~30 % plus compact que `jsonb_ops` ; (3) PostgreSQL utilise un **Bitmap Index Scan** : il construit d'abord un bitmap des 16 740 TIDs, puis accède aux pages heap dans l'ordre physique — semi-séquentiel au lieu d'aléatoire ; (4) `shared read=6420` → `shared hit=100` ; (5) le gain est ×456 (1 412 ms → 3 ms) ; (6) `CONCURRENTLY` est indispensable en production — la table est écrite en continu.

### Exemple B — Index Only Scan avec INCLUDE

```sql
-- Requête : 20 derniers posts d'une famille avec author_id et content
SELECT p.id, p.author_id, p.content
FROM posts p
WHERE p.family_id = 2
ORDER BY p.created_at DESC
LIMIT 20;
```

Avec l'index composite seul `(family_id, created_at DESC)` :

```
Index Scan using idx_posts_fam_date on posts p
  (cost=0.43..18.90 rows=20 width=148)
  (actual time=0.031..0.095 rows=20 loops=1)
  Index Cond: (family_id = 2)
  Buffers: shared hit=4 read=17
```

`author_id` et `content` ne sont pas dans l'index — 17 pages heap lues. Remplacement par un covering index :

```sql
DROP INDEX idx_posts_fam_date;
CREATE INDEX idx_posts_fam_date_cov
  ON posts (family_id, created_at DESC)
  INCLUDE (author_id, content);
ANALYZE posts;
```

Après covering index :

```
Index Only Scan using idx_posts_fam_date_cov on posts p
  (cost=0.43..10.22 rows=20 width=148)
  (actual time=0.019..0.028 rows=20 loops=1)
  Index Cond: (family_id = 2)
  Heap Fetches: 0
  Buffers: shared hit=4
```

Pas-à-pas : (1) `Index Only Scan` apparaît à la place de `Index Scan` — la heap n'est jamais lue (`Heap Fetches: 0`) ; (2) le coût estimé passe de 18,90 à 10,22 ; (3) `shared read=17` → `shared read=0` : zéro page heap, tout vient du cache ; (4) `author_id` et `content` sont dans les feuilles de l'index mais **pas** dans l'arbre — ils ne servent pas pour un `WHERE author_id = x` ; (5) pour en plus filtrer sur `status = 'published'`, ajouter un **index partiel** `WHERE status = 'published'` : réduit la taille de l'index en excluant les brouillons.

## 4. Pièges & misconceptions

- **GIN avec beaucoup d'INSERT.** Un document JSONB à 15 clés génère 15 entrées d'index par INSERT. Sur une table très écrite, les INSERT peuvent devenir lents. *Correct* : `fastupdate = on` (défaut) tamponne les entrées ; regrouper les INSERT en batch ; envisager `jsonb_path_ops` pour un index plus compact.

- **BRIN sur des données non ordonnées.** Un BRIN sur un UUID ou une colonne mise à jour fréquemment (correlation ≈ 0) ne peut pas éliminer de blocs → Seq Scan systématique malgré l'index. *Correct* : consulter `pg_stats.correlation` avant de créer un BRIN. Si `correlation < 0.5`, utiliser un B-tree.

- **Index multicolonne — préfixe gauche ignoré.** `(family_id, created_at DESC)` n'aide pas `WHERE created_at > '2026-01-01'` seul. *Correct* : créer un index séparé sur `created_at` si les requêtes sur cette colonne seule sont fréquentes.

- **CONCURRENTLY dans une transaction.** `BEGIN; CREATE INDEX CONCURRENTLY ...; COMMIT;` échoue avec une erreur. *Correct* : exécuter `CREATE INDEX CONCURRENTLY` hors de tout bloc `BEGIN`/`COMMIT`, directement dans psql ou via une migration non-transactionnelle.

- **Index partiel dont la condition ne matche pas exactement.** `WHERE status = 'published'` dans l'index n'est pas utilisé pour `WHERE status IN ('published', 'pinned')`. *Correct* : la condition WHERE de la requête doit être un **sous-ensemble logique** de la condition de l'index.

- **Index sur expression avec expression différente.** Un index sur `LOWER(email)` n'aide pas `WHERE email = 'Alice@...'` (sans `LOWER`). *Correct* : la requête doit reproduire l'expression exacte : `WHERE LOWER(email) = 'alice@...'`.

- **INCLUDE pour le filtrage ou le tri.** Les colonnes dans `INCLUDE` sont dans les feuilles mais **pas** dans l'arbre — elles ne peuvent pas servir de condition `WHERE` ni de `ORDER BY`. *Correct* : placer dans l'arbre les colonnes utilisées pour filtrer ou trier ; mettre dans `INCLUDE` uniquement les colonnes à lire.

## 5. Ancrage TribuZen

Couche fil-rouge : **index GIN sur les tags jsonb des posts TribuZen** dans `smaurier/tribuzen`.

- La table `posts` stocke les thèmes dans une colonne `tags JSONB` (`{"voyage": true, "sport": true}`) — structure flexible, extensible sans migration de schéma pour chaque nouveau tag.
- L'index `CREATE INDEX CONCURRENTLY idx_posts_tags_gin ON posts USING GIN (tags jsonb_path_ops)` sert la recherche par tag sur la page d'accueil et le filtre de recherche avancée — les deux requêtes les plus sollicitées après le feed famille.
- `CONCURRENTLY` est indispensable en production : la table `posts` est écrite en continu et ne peut pas être verrouillée le temps de la construction de l'index.
- Le covering index `(family_id, created_at DESC) INCLUDE (author_id, content)` complète le module 06 : il pousse le feed famille vers un Index Only Scan complet, supprimant les accès heap pour chaque ligne de résultat.
- L'index partiel `WHERE status = 'published'` réduit l'espace GIN aux seuls posts visibles — les brouillons (~20 % des lignes) sont exclus de l'index, ce qui réduit sa taille et accélère le VACUUM.
- En session, tous les `EXPLAIN ANALYZE` sont exécutés sur une base Docker locale avec les données de seed TribuZen (80 000 posts, 500 users, 50 familles) — les timings sont réels, pas estimés.

## 6. Points clés

1. GIN = index inversé pour les types composites (JSONB, tableaux, `tsvector`) — opérateurs `@>`, `?`, `&&` ; choisir `jsonb_path_ops` si seul `@>` est utilisé, l'index est ~30 % plus compact.
2. GiST = arbre multi-dimensionnel pour les ranges (opérateur `&&` chevauchement) et la géométrie ; seul type supporté pour les contraintes `EXCLUDE USING GIST`.
3. BRIN = min/max par groupe de pages — quelques KB seulement, mais efficace **uniquement** si `pg_stats.correlation ≈ 1` (données physiquement ordonnées comme les timestamps d'insertion).
4. Index partiel (`WHERE condition`) : plus petit, plus rapide à maintenir ; la requête doit inclure la même condition ou un sous-ensemble plus restrictif.
5. Index sur expression : indexe `LOWER(col)`, `EXTRACT(...)`, etc. — la requête doit reproduire l'expression exacte pour que l'index soit utilisé.
6. `INCLUDE` ajoute des colonnes en feuilles pour permettre l'**Index Only Scan** (`Heap Fetches: 0`) sans alourdir l'arbre de tri ; les colonnes `INCLUDE` ne servent pas pour `WHERE` ni `ORDER BY`.
7. Index multicolonne : le planner utilise le **préfixe gauche** — `(a, b)` aide `WHERE a = x` mais pas `WHERE b = y` seul ; mettre la colonne la plus sélective en tête.
8. `CREATE INDEX CONCURRENTLY` : aucun verrou exclusif, la table reste accessible ; interdit dans une transaction ; en cas d'interruption, l'index reste `INVALID` — le supprimer et recommencer.

## 7. Seeds Anki

```
Pourquoi le B-tree ne peut pas servir l'opérateur @> sur JSONB ?|Le B-tree trie des valeurs scalaires dans un ordre linéaire — @> est un test de contenance sur une valeur composite. GIN stocke une entrée par clé et supporte directement @>, ?, ?|, &&
Différence entre jsonb_ops et jsonb_path_ops pour un index GIN ?|jsonb_ops (défaut) supporte @>, ?, ?|, ?& — index plus grand ; jsonb_path_ops supporte uniquement @> — index ~30 % plus compact. Choisir path_ops si seul @> est utilisé
Quand BRIN est-il efficace, et comment le vérifier ?|Quand les données sont physiquement ordonnées sur disque (time-series, IDs séquentiels). Vérifier pg_stats.correlation — proche de 1.0 : BRIN efficace, proche de 0.0 : BRIN inutile
Qu'est-ce qu'un index partiel et quand l'utiliser ?|Un index avec une clause WHERE qui n'indexe qu'un sous-ensemble de lignes. Utile pour exclure les lignes rarement requêtées (brouillons, supprimés) — index plus petit, maintenance plus rapide
Comment obtenir un Index Only Scan avec un covering index ?|CREATE INDEX ON table (col_filtre) INCLUDE (col1, col2) — les colonnes INCLUDE sont dans les feuilles. Le planner lit col1/col2 sans accéder à la heap (Heap Fetches: 0). Nécessite une visibility map à jour (VACUUM)
Pourquoi CREATE INDEX CONCURRENTLY ne peut pas s'exécuter dans BEGIN...COMMIT ?|CONCURRENTLY nécessite deux passes sur la table avec des snapshots différents — incompatible avec le snapshot unique d'une transaction ouverte. PostgreSQL lève une erreur
Règle du préfixe gauche pour un index multicolonne (a, b) ?|Le planner peut utiliser l'index pour WHERE a = x ou WHERE a = x AND b = y, mais pas pour WHERE b = y seul. La colonne du filtre = le plus fréquent va en tête
Que se passe-t-il si CREATE INDEX CONCURRENTLY est interrompu ?|L'index reste en état INVALID (indisvalid = false dans pg_index). Il n'est pas utilisé par le planner mais consomme de l'espace. Corriger : DROP INDEX nom_index puis recréer
Différence entre EXCLUDE USING GIST et une contrainte UNIQUE ?|UNIQUE empêche deux lignes avec la même valeur scalaire. EXCLUDE empêche deux lignes où une expression relationnelle est vraie (ex: chevauchement de ranges avec &&). Seul GiST peut implémenter EXCLUDE
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-07-index-gin-gist-brin/`. Tu mesures le coût réel d'une recherche par tag sans index (EXPLAIN ANALYZE, Seq Scan), tu crées l'index GIN approprié et vérifies le gain, tu répètes pour un BRIN sur les timestamps et un covering index pour l'Index Only Scan. Corrigé SQL complet inline dans le README.
