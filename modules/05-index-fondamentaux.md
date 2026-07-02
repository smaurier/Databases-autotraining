---
titre: Index fondamentaux
cours: 10-postgresql
notions: [index B-tree, pourquoi indexer, CREATE INDEX, index sur clés étrangères, index composite et ordre des colonnes, index unique, quand ne pas indexer, coût des index en écriture]
outcomes: [créer un index B-tree adapté à une requête, indexer les clés étrangères, concevoir un index composite, arbitrer le coût lecture/écriture d'un index]
prerequis: [04-transactions-et-acid]
next: 06-query-planner
libs: [{ name: postgresql, version: "17" }]
tribuzen: indexer family_id sur posts pour accélérer le feed TribuZen
last-reviewed: 2026-07
---

# Index fondamentaux

> **Outcomes — tu sauras FAIRE :** créer un index B-tree adapté à une requête, indexer les clés étrangères, concevoir un index composite en choisissant l'ordre de colonnes correct, et arbitrer le coût lecture/écriture d'un index.
> **Difficulté :** :star::star:

## 1. Cas concret d'abord

Dans TribuZen, le feed familial charge les derniers posts d'une famille :

```sql
SELECT id, content, created_at
FROM posts
WHERE family_id = 'fam-1'
ORDER BY created_at DESC
LIMIT 20;
```

Sur 5 000 posts en base, la requête est instantanée. À 500 000 posts (une famille active 3 ans), elle prend 800 ms — PostgreSQL lit les 500 000 lignes une par une pour en sortir 20. C'est un **Seq Scan**, et il est fatal pour un feed temps réel.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content, created_at
FROM posts
WHERE family_id = 'fam-1'
ORDER BY created_at DESC
LIMIT 20;

-- Seq Scan on posts  (cost=0.00..9823.00 rows=20 width=96)
--                    (actual time=0.043..812.7 rows=20 loops=1)
--   Filter: (family_id = 'fam-1')
--   Rows Removed by Filter: 499980
-- Execution Time: 812.9 ms   ← inacceptable en prod
```

Un seul index résout le problème :

```sql
CREATE INDEX idx_posts_family_created ON posts(family_id, created_at DESC);
```

```sql
-- Après l'index :
-- Index Scan Backward using idx_posts_family_created on posts
--   (cost=0.42..8.64 rows=20 width=96) (actual time=0.031..0.089 rows=20 loops=1)
-- Execution Time: 0.11 ms   ← x7 000
```

Ce module explique pourquoi cet index fonctionne, comment le créer correctement, et quand ne pas en créer.

## 2. Théorie complète, concise

### Pourquoi indexer — Seq Scan vs Index Scan

Sans index, PostgreSQL parcourt **toutes** les pages de la table : le **Seq Scan**, en O(n). Sur 1 million de lignes il lit tout même pour retourner 1 résultat. Le B-tree réduit la recherche à **O(log n)**.

| Lignes | Seq Scan | Index Scan B-tree | Accélération |
|---|---|---|---|
| 10 000 | ~10 ms | ~0.1 ms | ×100 |
| 100 000 | ~100 ms | ~0.1 ms | ×1 000 |
| 1 000 000 | ~1 000 ms | ~0.2 ms | ×5 000 |

Le Seq Scan n'est pas toujours mauvais : sur une petite table (< 1 000 lignes) ou quand la requête retourne plus de 5-10 % des lignes, le planner préfère souvent le Seq Scan car la navigation dans l'arbre coûte plus que la lecture directe.

### B-tree — la structure par défaut

Le **B-tree (Balanced Tree)** est le type d'index créé par défaut par PostgreSQL. Il maintient les valeurs **triées** dans une structure arborescente équilibrée :

```
               [250 | 500 | 750]           ← Root page
              /       |        \
  [50|100|200]   [300|400|450]   [600|700]  ← Internal pages
   /   |    \
[1-49][50-99][100-199]                      ← Leaf pages (doubly linked list)
```

Les feuilles sont chaînées entre elles : PostgreSQL peut parcourir une **plage de valeurs** (`BETWEEN`, `ORDER BY`, `>`) sans remonter à la racine — c'est le Range Scan.

Recherche de `family_id = 'fam-1'` : 3-4 sauts de pages au lieu de lire toutes les pages de la table.

Opérations supportées par le B-tree : égalité (`=`), plages (`<`, `>`, `BETWEEN`), `IN`, `IS NULL`, `LIKE 'prefix%'`, `ORDER BY`, `MIN()`/`MAX()`. **Ne supporte pas** `LIKE '%suffix'` ni la recherche full-text.

### CREATE INDEX — syntaxe essentielle

```sql
-- Index simple (B-tree par défaut)
CREATE INDEX idx_posts_family_id ON posts(family_id);

-- Idempotent
CREATE INDEX IF NOT EXISTS idx_posts_family_id ON posts(family_id);

-- En production : ne bloque pas les écritures
CREATE INDEX CONCURRENTLY idx_posts_family_id ON posts(family_id);

-- Supprimer
DROP INDEX IF EXISTS idx_posts_family_id;
```

En développement `CREATE INDEX` suffit. En **production**, toujours `CREATE INDEX CONCURRENTLY` : sans ce mot-clé, PostgreSQL pose un verrou `ShareLock` qui bloque tous les INSERT/UPDATE/DELETE pendant la construction — potentiellement plusieurs minutes sur une grosse table. `CONCURRENTLY` est plus lent (deux passes) mais les écritures continuent. Contrainte : ne peut pas s'exécuter dans une transaction `BEGIN`.

Convention de nommage : `idx_<table>_<colonnes>`. Ex : `idx_posts_family_id`, `idx_posts_family_created`.

### Index sur clés étrangères

PostgreSQL **ne crée pas automatiquement d'index sur les FK** (contrairement à MySQL). Sans index sur la colonne FK, chaque `DELETE` dans la table parente déclenche un Seq Scan sur la table enfant pour vérifier l'intégrité référentielle.

```sql
-- FK déclarée sur posts.family_id
ALTER TABLE posts
  ADD CONSTRAINT fk_posts_family
  FOREIGN KEY (family_id) REFERENCES families(id);

-- Sans cet index, DELETE FROM families WHERE id = 'x'
-- déclenche un Seq Scan sur TOUS les posts pour vérifier qu'aucun ne référence 'x'.
CREATE INDEX idx_posts_family_id ON posts(family_id);
```

Règle simple : après tout `ADD CONSTRAINT ... FOREIGN KEY`, ajouter immédiatement un `CREATE INDEX` sur la colonne FK.

### Index composite et ordre des colonnes

Un index composite couvre plusieurs colonnes. L'ordre est déterminant.

```sql
CREATE INDEX idx_posts_family_created ON posts(family_id, created_at DESC);
```

**Leftmost Prefix Rule** : l'index `(A, B)` est utilisable si la requête filtre sur `A` seul, ou sur `A + B`. Il n'est **pas** utilisable si la requête filtre sur `B` seul.

| Requête | Utilise idx_posts_family_created ? |
|---|---|
| `WHERE family_id = 'x'` | Oui (préfixe A) |
| `WHERE family_id = 'x' AND created_at > now() - interval '7 days'` | Oui (A + B) |
| `WHERE created_at > now() - interval '7 days'` | Non (B seul, sans A) |

Règle d'ordre dans un composite : **colonnes d'égalité d'abord**, colonnes de plage ou de tri ensuite.

```sql
-- Requête : WHERE statut = 'publié' ORDER BY created_at DESC
-- Bon ordre : égalité (statut) avant tri (created_at)
CREATE INDEX idx_posts_statut_created ON posts(statut, created_at DESC);
```

L'index `(A, B)` rend un index séparé `(A)` **redondant** — il couvre déjà le préfixe A. En revanche, si des requêtes filtrent sur B seul, un index séparé `(B)` reste nécessaire.

### Index unique

```sql
-- Garantit l'unicité ET accélère les recherches par égalité
CREATE UNIQUE INDEX idx_users_email ON users(email);

-- Équivalent : PostgreSQL crée aussi un index unique en arrière-plan
ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);
```

Un index unique composite garantit l'unicité sur la combinaison de colonnes :

```sql
-- Un user ne peut appartenir qu'une fois à une famille
CREATE UNIQUE INDEX idx_family_member_uniq
  ON family_members(family_id, user_id);
```

### Quand NE PAS créer un index

| Situation | Raison |
|---|---|
| Table < 1 000 lignes | Seq Scan déjà rapide ; overhead de navigation dans l'arbre dépasse le gain |
| Colonne à faible sélectivité (boolean, statut à 2 valeurs) | Planner préfère Seq Scan si plus de 5-10 % des lignes sont retournées |
| Colonne rarement utilisée en filtre | Index coûte en écriture mais n'est jamais utilisé |
| Table à très forte volumétrie d'INSERT (logs, IoT) | Chaque index ralentit chaque insertion |
| Colonne souvent modifiée | Chaque UPDATE sur la colonne modifie l'entrée d'index |

### Coût des index en écriture

Chaque index est une structure supplémentaire à maintenir. Chaque `INSERT` écrit dans la table **et** dans chacun de ses index :

```
INSERT INTO posts (...) VALUES (...);

Sans index :  1 écriture  (table)
Avec 4 index: 5 écritures (table + 4 index)
```

Chaque `UPDATE` sur une colonne indexée oblige PostgreSQL à modifier l'index. Chaque `DELETE` marque les entrées d'index comme obsolètes (nettoyées par VACUUM).

**Règle :** créer un index uniquement si une requête est prouvée lente par `EXPLAIN ANALYZE`. `pg_stat_user_indexes` (couvert dans le module 11) permet d'identifier les index jamais utilisés à supprimer.

## 3. Worked examples

### Exemple A — feed TribuZen (index composite + EXPLAIN pas-à-pas)

Objectif : prouver que l'index `(family_id, created_at DESC)` couvre la requête de feed et élimine le nœud Sort.

```sql
-- Données de démo
CREATE TABLE families (id TEXT PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE posts (
  id         BIGSERIAL PRIMARY KEY,
  family_id  TEXT NOT NULL REFERENCES families(id),
  content    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO families VALUES ('fam-1', 'Famille Dupont');
INSERT INTO posts (family_id, content, created_at)
SELECT 'fam-1', 'Post ' || i, now() - (random() * interval '365 days')
FROM generate_series(1, 200000) i;

ANALYZE posts;

-- Plan SANS index
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content, created_at
FROM posts
WHERE family_id = 'fam-1'
ORDER BY created_at DESC
LIMIT 20;
-- → Seq Scan on posts  (... Rows Removed by Filter: ~100 000)
--   + Sort node (tri des 100 000 lignes filtrées)
-- Execution Time: ~300-800 ms selon disque

-- Créer l'index composite
CREATE INDEX idx_posts_family_created ON posts(family_id, created_at DESC);

-- Plan AVEC index
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content, created_at
FROM posts
WHERE family_id = 'fam-1'
ORDER BY created_at DESC
LIMIT 20;
-- → Index Scan Backward using idx_posts_family_created on posts
--   Index Cond: (family_id = 'fam-1')
--   Buffers: shared hit=5
-- Execution Time: ~0.1 ms
-- Pas de Sort node : l'index fournit déjà les lignes dans l'ordre DESC.
```

Pas-à-pas : (1) `family_id = 'fam-1'` est un filtre d'égalité — première colonne du composite, sert de point d'entrée dans le B-tree ; (2) `ORDER BY created_at DESC` correspond à l'ordre physique de l'index (deuxième colonne, `DESC`) — PostgreSQL parcourt les feuilles de droite à gauche sans Sort node supplémentaire ; (3) `LIMIT 20` arrête la lecture après 20 entrées, aucune page de table supplémentaire n'est lue.

### Exemple B — FK non indexée : impact silencieux sur DELETE

Objectif : voir pourquoi l'oubli d'index sur FK est un bug de performance qui ne se voit pas au développement mais explose en production.

```sql
-- Setup : table enfant sans index sur FK
CREATE TABLE family_members (
  id        BIGSERIAL PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  user_id   TEXT NOT NULL
);

INSERT INTO family_members (family_id, user_id)
SELECT 'fam-1', 'user-' || i FROM generate_series(1, 50000) i;

ANALYZE family_members;

-- DELETE sur la table parente SANS index sur la FK
EXPLAIN (ANALYZE, BUFFERS)
DELETE FROM families WHERE id = 'fam-1';
-- → Seq Scan on family_members
--   Filter: (family_id = 'fam-1')
--   Rows Removed by Filter: 0  (mais les 50 000 lignes ont été lues)
-- PostgreSQL doit vérifier qu'aucun member ne référence fam-1 → scan complet.

-- Créer l'index manquant
CREATE INDEX idx_members_family_id ON family_members(family_id);

-- Réinsérer pour re-tester
INSERT INTO families VALUES ('fam-1', 'Famille Dupont');

EXPLAIN (ANALYZE, BUFFERS)
DELETE FROM families WHERE id = 'fam-1';
-- → Index Scan using idx_members_family_id on family_members
--   Index Cond: (family_id = 'fam-1')
-- Saut direct aux lignes concernées, pas de lecture des 50 000 autres.
```

Pas-à-pas : (1) sans index, PostgreSQL lit `family_members` en entier à chaque DELETE sur `families` — coût O(n_members) par DELETE de famille, quelle que soit la taille de la famille supprimée ; (2) avec l'index, il saute directement aux lignes référençant `fam-1` ; (3) sur un produit avec des milliers de familles, l'absence d'index FK se transforme en blocage lors des suppressions ou des migrations.

## 4. Pièges & misconceptions

- **« PostgreSQL indexe automatiquement les clés étrangères. »** Faux — seules les colonnes `PRIMARY KEY` et les contraintes `UNIQUE` génèrent un index automatique. Une FK sans index provoque un Seq Scan sur la table enfant à chaque DELETE sur la table parente. *Correct :* ajouter `CREATE INDEX` manuellement après chaque `ADD CONSTRAINT ... FOREIGN KEY`.

- **« Plus d'index = meilleures performances. »** Faux — chaque index ralentit les écritures et consomme de l'espace disque. Un INSERT sur une table à 8 index exécute 9 écritures au lieu d'une. Sur une table de logs à 10 000 inserts/seconde, 4 index inutiles peuvent diviser le débit par 2. *Correct :* indexer uniquement les colonnes prouvées lentes par `EXPLAIN ANALYZE`.

- **« L'index `(A, B)` couvre aussi la requête `WHERE B = …`. »** Faux — la Leftmost Prefix Rule impose de commencer par A. Si la requête filtre sur B seul, l'index n'est pas utilisé. *Correct :* créer un index séparé `(B)` si la requête sur B seule est fréquente.

- **« `CREATE INDEX` est sans danger en production. »** Faux — sans `CONCURRENTLY`, PostgreSQL pose un verrou `ShareLock` qui bloque tous les INSERT/UPDATE/DELETE pendant la construction, potentiellement plusieurs minutes. *Correct :* toujours `CREATE INDEX CONCURRENTLY` sur les tables en production ; impossible dans une transaction `BEGIN`.

- **« Un index sur une colonne boolean `is_active` est toujours utile. »** Faux — si 90 % des lignes ont `is_active = true`, un `WHERE is_active = true` retourne 90 % de la table : le planner choisira le Seq Scan car il est plus efficace que l'accès aléatoire via l'index. L'index n'aide que si la valeur filtrée est rare (< 5-10 % des lignes). *Correct :* vérifier la sélectivité avant d'indexer.

- **« Un index composite `(A, B)` remplace deux index séparés `(A)` et `(B)`. »** Partiellement faux — `(A, B)` couvre `WHERE A` (préfixe) mais pas `WHERE B` seul. L'index composite rend seulement l'index `(A)` redondant. Si des requêtes filtrent sur B seul, un index séparé `(B)` reste nécessaire.

## 5. Ancrage TribuZen

Couche fil-rouge : **base PostgreSQL locale (Docker)** dans `smaurier/tribuzen`. L'indexation du feed est le cas d'usage central de ce module :

- `posts.family_id` est la FK vers `families.id`. Sans `idx_posts_family_id`, chaque `DELETE FROM families` scanne tous les posts — catastrophique dès que le feed grossit au-delà de quelques dizaines de milliers de lignes.
- L'index composite `(family_id, created_at DESC)` couvre la requête de feed **sans Sort node** : le gain en latence est directement perçu par l'utilisateur à l'ouverture du fil familial.
- En production TribuZen, cet index se crée via une migration Prisma : `@@index([familyId, createdAt(sort: Desc)])` dans `schema.prisma` — Prisma génère le DDL et l'applique lors du `prisma migrate dev`.
- L'index unique `(family_id, user_id)` sur `family_members` empêche un user d'apparaître deux fois dans la même famille, même en cas de double-clic concurrent sur "rejoindre" — complément à la transaction ACID du module 04.
- En session, on exécute `EXPLAIN ANALYZE` sur la base Docker réelle **avant** et **après** chaque index, et on lit les plans côte à côte pour ancrer la différence O(n) → O(log n) sur des chiffres réels.

## 6. Points clés

1. Sans index, PostgreSQL parcourt toute la table (Seq Scan, O(n)) ; le B-tree réduit à O(log n).
2. `CREATE INDEX [IF NOT EXISTS] idx_<table>_<col> ON <table>(<col>)` crée un index B-tree par défaut.
3. En production, toujours `CREATE INDEX CONCURRENTLY` pour ne pas bloquer les écritures ; impossible dans une transaction.
4. PostgreSQL n'indexe **pas** automatiquement les FK — ajouter un index manuellement après chaque `ADD CONSTRAINT ... FOREIGN KEY`.
5. L'index composite `(A, B)` respecte la **Leftmost Prefix Rule** : utilisable pour `WHERE A`, `WHERE A AND B`, mais pas `WHERE B` seul.
6. Ordre dans un composite : colonnes d'égalité d'abord, colonnes de plage ou de tri ensuite.
7. L'index unique garantit l'unicité et accélère les recherches par égalité ; équivalent à une contrainte `UNIQUE` déclarée dans la table.
8. Chaque index ralentit les écritures — ne créer un index que si une requête est prouvée lente par `EXPLAIN ANALYZE`.

## 7. Seeds Anki

```
Qu'est-ce qu'un Seq Scan et pourquoi est-il problématique sur une grande table ?|PostgreSQL lit toutes les lignes une par une (O(n)). Sur 500 000 posts, il parcourt tout pour en retourner 20. Un index B-tree ramène ça à O(log n) : 3-4 sauts de pages au lieu de 500 000 lectures.
PostgreSQL indexe-t-il automatiquement les clés étrangères ?|Non. Seules les colonnes PRIMARY KEY et UNIQUE ont un index automatique. Une FK sans index provoque un Seq Scan sur la table enfant à chaque DELETE sur la table parente.
Qu'est-ce que la Leftmost Prefix Rule pour un index composite (A, B) ?|L'index est utilisable pour WHERE A seul ou WHERE A AND B, mais pas pour WHERE B seul. La requête doit commencer par la première colonne déclarée dans l'index.
Pourquoi utiliser CREATE INDEX CONCURRENTLY en production ?|Sans CONCURRENTLY, PostgreSQL pose un verrou ShareLock qui bloque tous les INSERT/UPDATE/DELETE le temps de la construction (plusieurs minutes sur une grosse table). CONCURRENTLY évite ce blocage au prix de deux passes.
Comment choisir l'ordre des colonnes dans un index composite ?|Colonnes d'égalité (=) en premier, colonnes de plage (BETWEEN, >, <) ou de tri (ORDER BY) ensuite. Ex : (family_id, created_at DESC) pour WHERE family_id = 'x' ORDER BY created_at DESC.
Quel est le coût caché d'un index pour les écritures ?|Chaque INSERT/UPDATE/DELETE maintient tous les index de la table. Une table avec 4 index exécute 5 écritures par INSERT. Sur une table à forte insertion, trop d'index dégradent le débit d'écriture.
Un index unique est-il différent d'une contrainte UNIQUE ?|Fonctionnellement non : PostgreSQL crée un index B-tree unique dans les deux cas. UNIQUE dans CREATE TABLE est du sucre syntaxique — il génère exactement le même index qu'un CREATE UNIQUE INDEX explicite.
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-05-index-et-explain/`. Tu crées les index du feed TribuZen sur une base Docker réelle, tu lis les plans `EXPLAIN ANALYZE` avant et après, tu observes la FK non indexée sur DELETE, et tu testes la contrainte unique. Corrigé SQL commenté + variante J+30 dans le README du lab.

## Navigation

| | Lien |
|---|---|
| Module précédent | [Module 04 — Transactions et ACID](./04-transactions-et-acid.md) |
| Module suivant | [Module 06 — Query Planner](./06-query-planner.md) |
| Lab associé | [Lab 05 — Index et EXPLAIN](../labs/lab-05-index-et-explain/README.md) |
