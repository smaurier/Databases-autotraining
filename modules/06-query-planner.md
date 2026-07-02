---
titre: Query planner
cours: 10-postgresql
notions: [EXPLAIN et EXPLAIN ANALYZE, plan d'exécution, seq scan vs index scan, coût et estimation de lignes, statistiques et ANALYZE, lecture d'un plan, BUFFERS, nested loop hash join merge join]
outcomes: [lire un plan d'exécution EXPLAIN ANALYZE, distinguer seq scan et index scan, comprendre coûts et estimations, diagnostiquer pourquoi un index n'est pas utilisé]
prerequis: [05-index-fondamentaux]
next: 07-index-avances
libs: [{ name: postgresql, version: "17" }]
tribuzen: analyser le plan d'exécution de la requête du feed famille TribuZen
last-reviewed: 2026-07
---

# Query planner

> **Outcomes — tu sauras FAIRE :** lire et décoder un plan `EXPLAIN ANALYZE`, distinguer Seq Scan et Index Scan, interpréter les coûts et estimations de lignes, diagnostiquer pourquoi le planner n'utilise pas un index.
> **Difficulté :** :star::star::star:

## 1. Cas concret d'abord

Dans TribuZen, la page d'accueil charge le **feed famille** : les 20 derniers posts avec auteur, nom de famille et nombre de réactions. En développement (200 posts) la page s'affiche en 80 ms. En pré-prod avec 60 000 posts la même requête prend **1,8 s**. Comment diagnostiquer ?

```sql
-- Requête du feed famille TribuZen
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

```
Seq Scan on posts p  (cost=0.00..5823.00 rows=60000 width=120)
                     (actual time=0.012..1620.000 rows=60000 loops=1)
  Filter: (family_id = 1 AND created_at > ...)
  Rows Removed by Filter: 56785
  Buffers: shared read=5823
Planning Time: 0.9 ms
Execution Time: 1802.4 ms
```

PostgreSQL lit les **60 000** lignes pour en retourner 20 : Seq Scan sur `posts.family_id` sans index. La suite te donne les outils pour lire n'importe quel plan, puis corriger ce cas.

## 2. Théorie complète, concise

### EXPLAIN et EXPLAIN ANALYZE

`EXPLAIN` affiche le plan **estimé** sans exécuter la requête. `EXPLAIN ANALYZE` **exécute** la requête et ajoute les métriques réelles (temps, lignes réelles). `BUFFERS` ajoute les compteurs d'accès aux pages.

```sql
-- Estimation seulement (sûr sur DELETE/UPDATE)
EXPLAIN SELECT * FROM posts WHERE family_id = 1;

-- Exécution réelle + métriques d'I/O
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM posts WHERE family_id = 1;

-- Format JSON (parsing programmatique depuis Node.js)
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM posts WHERE family_id = 1;
```

### Lire les coûts et estimations

```
Index Scan using idx_posts_family_date on posts
  (cost=0.43..8.91 rows=12 width=120)
  (actual time=0.025..0.038 rows=14 loops=1)
       │          │       │        │
       │          │       │        └── largeur estimée d'une ligne (octets)
       │          │       └── lignes ESTIMÉES
       │          └── coût total (unités abstraites)
       └── startup cost (avant la 1ʳᵉ ligne)
```

- `cost` : unités **abstraites**, pas des millisecondes. Un plan à 50 est deux fois "moins cher" qu'un plan à 100.
- `rows` estimées ≠ `rows` réelles → écart > ×10 = statistiques obsolètes → `ANALYZE`.
- `loops` : nombre de fois que le nœud est exécuté. `actual time` × `loops` = temps réel total.
- `Execution Time` (en bas du plan) : durée totale mesurée en millisecondes.

### BUFFERS

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
-- Buffers: shared hit=4  read=5823
```

| Métrique | Signification |
|---|---|
| `shared hit` | pages lues depuis le cache (shared_buffers ou cache OS) — rapide |
| `shared read` | pages lues depuis le disque — lent |
| `shared dirtied` | pages modifiées en cache (écritures) |

Un `shared read` élevé désigne les nœuds I/O-intensifs. `shared hit` élevé = données bien en cache.

### Types de scans

**Seq Scan** : lit toutes les pages de la table séquentiellement. Optimal quand la requête ramène > 5-10 % des lignes ou que la table est petite. Coût proportionnel au volume total.

**Index Scan** : navigue dans l'index B-tree pour trouver les TID (Tuple IDs), puis accède aux pages heap correspondantes. Optimal pour les requêtes très sélectives (< 5 % des lignes). Génère des accès aléatoires à la heap.

**Index Only Scan** : toutes les colonnes nécessaires (SELECT + WHERE + ORDER BY) sont dans l'index — la heap n'est jamais lue. Le scan le plus rapide. Nécessite une visibility map à jour (VACUUM régulier).

**Bitmap Index Scan + Bitmap Heap Scan** : compromis pour un volume intermédiaire de lignes. Phase 1 construit un bitmap des pages concernées via l'index ; phase 2 lit ces pages dans l'ordre physique (accès semi-séquentiels). Peut combiner deux index avec `BitmapAnd` / `BitmapOr`.

### Stratégies de jointure

| Stratégie | Mécanisme | Optimal quand |
|---|---|---|
| **Nested Loop** | pour chaque ligne externe, chercher dans la table interne (via index) | table externe petite + bon index sur la table interne |
| **Hash Join** | construire une hash table sur la petite table, sonder avec la grande | jointure par égalité sur grands ensembles ; hash table tient en `work_mem` |
| **Merge Join** | trier les deux entrées, fusionner séquentiellement | données déjà triées (index) ou très grands ensembles |

Un Hash Join qui dépasse `work_mem` bascule en **batches disque** (`Batches: N` dans le plan) — augmenter `work_mem` peut l'éviter.

### Statistiques et ANALYZE

Le planner base ses estimations sur `pg_stats` : histogramme, valeurs les plus fréquentes, cardinalité. Des statistiques obsolètes → mauvaises estimations → mauvais choix de plan.

```sql
-- Mettre à jour les statistiques d'une table après un import massif
ANALYZE posts;

-- Voir les statistiques d'une colonne
SELECT attname, n_distinct, most_common_vals, correlation
FROM pg_stats
WHERE tablename = 'posts' AND attname = 'family_id';
```

L'**autovacuum** lance `ANALYZE` automatiquement après ~10 % de modifications. Après un import massif (COPY, migration), lancer `ANALYZE` manuellement — autovacuum ne se déclenche pas assez vite.

## 3. Worked examples

### Exemple A — plan du feed TribuZen avant et après index

```sql
-- Schéma + données de test
CREATE TABLE users    (id SERIAL PRIMARY KEY, display_name TEXT, avatar_url TEXT);
CREATE TABLE families (id SERIAL PRIMARY KEY, name TEXT);
CREATE TABLE posts (
  id         SERIAL PRIMARY KEY,
  author_id  INT NOT NULL REFERENCES users(id),
  family_id  INT NOT NULL REFERENCES families(id),
  content    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE reactions (id SERIAL PRIMARY KEY, post_id INT NOT NULL REFERENCES posts(id));

INSERT INTO users    SELECT i, 'User '||i, 'https://cdn.tribu/'||i FROM generate_series(1,200) i;
INSERT INTO families SELECT i, 'Famille '||i FROM generate_series(1,20) i;
INSERT INTO posts    SELECT i, (random()*199+1)::int, (random()*19+1)::int,
                           repeat('Post TribuZen ', 10),
                           now() - (random()*180 || ' days')::interval
                    FROM generate_series(1,60000) i;
INSERT INTO reactions SELECT i, (random()*59999+1)::int FROM generate_series(1,250000) i;
ANALYZE;
```

Plan **avant index** :

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.content, p.created_at, u.display_name, f.name, COUNT(r.id)
FROM posts p
JOIN users u ON p.author_id = u.id
JOIN families f ON p.family_id = f.id
LEFT JOIN reactions r ON r.post_id = p.id
WHERE p.family_id = 1 AND p.created_at > NOW() - INTERVAL '30 days'
GROUP BY p.id, u.display_name, u.avatar_url, f.name
ORDER BY p.created_at DESC LIMIT 20;
```

```
Limit  (actual time=1820.430..1820.440 rows=20 loops=1)
  ->  Sort  (actual time=1820.428..1820.430 rows=20 loops=1)
        Sort Key: p.created_at DESC
        ->  HashAggregate  (actual time=1815.200..1817.800 rows=556 loops=1)
              ->  Hash Join  (actual time=0.820..1810.000 rows=250000 loops=1)
                    ->  Hash Join  (actual time=0.350..1200.000 rows=60000 loops=1)
                          ->  Seq Scan on posts p
                                (actual time=0.012..620.000 rows=60000 loops=1)
                                Filter: (family_id = 1 AND ...)
                                Rows Removed by Filter: 56785
                                Buffers: shared read=5823
                          ->  Hash on users u  (rows=200 loops=1)
                    ->  Hash on families f  (rows=20 loops=1)
              ->  Seq Scan on reactions r  (rows=250000 loops=1)
Execution Time: 1820.9 ms
```

Ajout des index :

```sql
CREATE INDEX idx_posts_family_date ON posts(family_id, created_at DESC);
CREATE INDEX idx_reactions_post    ON reactions(post_id);
ANALYZE posts, reactions;
```

Plan **après index** (même requête) :

```
Limit  (actual time=0.380..1.210 rows=20 loops=1)
  ->  GroupAggregate  (actual time=0.378..1.205 rows=20 loops=1)
        ->  Nested Loop Left Join  (actual time=0.120..0.980 rows=80 loops=1)
              ->  Nested Loop  (actual time=0.090..0.220 rows=20 loops=1)
                    ->  Index Scan using idx_posts_family_date on posts p
                          (actual time=0.025..0.080 rows=20 loops=1)
                          Index Cond: (family_id = 1 AND created_at > ...)
                          Buffers: shared hit=4
                    ->  Index Scan using users_pkey on users u  (loops=20)
              ->  Index Scan using idx_reactions_post on reactions r  (loops=20)
Execution Time: 1.3 ms
```

Pas-à-pas : (1) le Seq Scan lisait les 60 000 lignes pour en filtrer ~3 215 — coût O(N) ; (2) l'index composite `(family_id, created_at DESC)` permet un Index Scan qui livre directement les 20 lignes **déjà triées** — le nœud `Sort` disparaît du plan ; (3) `shared hit=4` au lieu de `shared read=5823` : tout vient du cache, 4 pages d'index seulement ; (4) les Hash Join sont remplacés par des Nested Loop avec Index Scan car la table externe est maintenant minuscule (20 lignes).

### Exemple B — diagnostiquer un index ignoré

```sql
-- Index existant sur display_name
CREATE INDEX idx_users_display ON users(display_name);
ANALYZE users;

-- Cette requête utilise-t-elle l'index ?
EXPLAIN SELECT * FROM users WHERE LOWER(display_name) = 'user 42';
```

```
Seq Scan on users  (cost=0.00..4.50 rows=1 width=48)
  Filter: (lower(display_name) = 'user 42')
```

L'index est ignoré : la condition applique `LOWER()` sur la colonne. L'index stocke les valeurs brutes, pas `lower(valeur)` — il ne peut donc pas servir cette recherche.

```sql
-- Correction : index fonctionnel
CREATE INDEX idx_users_display_lower ON users(LOWER(display_name));
ANALYZE users;

EXPLAIN SELECT * FROM users WHERE LOWER(display_name) = 'user 42';
-- Index Scan using idx_users_display_lower on users
--   Index Cond: (lower(display_name) = 'user 42')
```

Pas-à-pas : (1) `EXPLAIN` révèle un `Filter: (lower(...) = ...)` sur un Seq Scan — signal que la condition n'utilise aucun index ; (2) l'index B-tree standard sur `display_name` ne peut pas servir `LOWER(display_name)` car les entrées indexées diffèrent ; (3) l'**index fonctionnel** sur `LOWER(display_name)` résout le problème — PostgreSQL l'utilise car l'expression correspond exactement ; (4) `ANALYZE` après la création est indispensable pour que le planner intègre les nouvelles statistiques.

## 4. Pièges & misconceptions

- **`EXPLAIN ANALYZE` exécute vraiment la requête.** Sur un `DELETE`, les lignes sont supprimées. *Correct* : envelopper dans `BEGIN; EXPLAIN ANALYZE DELETE ...; ROLLBACK;` pour inspecter sans impact.

- **Les coûts ne sont pas des millisecondes.** `cost=9421` n'est pas 9 421 ms — c'est une unité abstraite relative. Deux plans se comparent entre eux. Pour la durée réelle, lire `Execution Time` affiché en bas du plan `ANALYZE`.

- **Seq Scan ≠ problème systématique.** Sur une table de 200 lignes, un Seq Scan est souvent plus rapide qu'un Index Scan (pas d'accès aléatoire à la heap). Le planner le choisit délibérément. Ne créer un index que si la table est grande **et** la condition sélective.

- **Statistiques obsolètes → mauvais plan.** Si `rows` estimé = 10 et `rows` réel = 80 000 dans EXPLAIN ANALYZE, le planner a sélectionné un plan inadapté. *Correct* : `ANALYZE nom_table`. Après un import massif, autovacuum ne se déclenche pas assez rapidement — lancer manuellement.

- **`random_page_cost = 4.0` sur SSD est trop élevé.** Ce paramètre (défaut) suppose que les accès aléatoires coûtent 4× les accès séquentiels — vrai sur HDD, faux sur SSD. *Correct* : `SET random_page_cost = 1.1;` sur un serveur SSD pour que le planner favorise davantage les Index Scan.

- **`enable_seqscan = off` n'est pas une solution de production.** C'est un outil de **diagnostic** pour forcer un plan alternatif et mesurer. En production, cette interdiction perturbe tous les plans, y compris ceux où le Seq Scan était optimal. *Correct* : corriger la cause (index manquant, statistiques, `random_page_cost`).

## 5. Ancrage TribuZen

Couche fil-rouge : **analyser le plan d'exécution de la requête du feed famille** dans `smaurier/tribuzen`.

- La requête du feed (posts + users + families + reactions) est la plus sollicitée du produit — chargée à chaque ouverture de l'app par n'importe quel membre de la famille. C'est le bon candidat à optimiser en premier.
- L'index composite `(family_id, created_at DESC)` reflète exactement le pattern d'accès : toujours filtrer sur une famille, toujours trier par date décroissante. L'ordre des colonnes dans l'index est intentionnel — inverser `created_at` et `family_id` rendrait l'index inutilisable pour ce tri.
- `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` est appelable depuis Node.js (`pg.Pool`) pour logger automatiquement les plans des requêtes lentes (> 100 ms) — signal de régression détectable en CI ou en développement.
- En session, le `EXPLAIN ANALYZE` est exécuté sur une base Docker locale avec les vraies données de seed TribuZen, pas un sandbox. Le plan est réel, les timings sont réels.
- En module 07 (index avancés), un **covering index** sur `(family_id, created_at DESC, author_id, content)` permettra un Index Only Scan qui évite entièrement la heap pour les posts récents — étape suivante naturelle après ce module.

## 6. Points clés

1. `EXPLAIN` estime sans exécuter (sûr) ; `EXPLAIN ANALYZE` exécute et mesure — piège sur DELETE/UPDATE : envelopper dans `BEGIN; ... ROLLBACK;`.
2. `cost=startup..total` en unités abstraites relatives ; `actual time=startup..total` en millisecondes ; `loops` multiplie les temps par nœud.
3. `BUFFERS: shared hit` = cache (rapide) ; `shared read` = disque (lent) — identifier les nœuds I/O-intensifs.
4. Seq Scan = toutes les pages séquentiellement ; optimal > 5-10 % des lignes ou petite table.
5. Index Scan = accès sélectif B-tree + heap ; optimal < 5 % des lignes ; Index Only Scan = pas de heap, colonnes toutes dans l'index.
6. Nested Loop + index = petite table externe ; Hash Join = grands ensembles par égalité ; Merge Join = données déjà triées.
7. Estimations très différentes du réel (> ×10) → `ANALYZE` ; `random_page_cost = 1.1` sur SSD ; index fonctionnel si la condition applique une fonction à la colonne.
8. Jamais `enable_seqscan = off` en production — c'est un outil de diagnostic, pas un réglage de performance.

## 7. Seeds Anki

```
Différence entre EXPLAIN et EXPLAIN ANALYZE ?|EXPLAIN affiche le plan estimé sans exécuter la requête ; EXPLAIN ANALYZE exécute réellement et ajoute les métriques réelles (temps, lignes, buffers)
Que signifie cost=0.43..8.91 dans un plan EXPLAIN ?|Startup cost (avant la 1ʳᵉ ligne) = 0.43 ; total cost (toutes les lignes) = 8.91 — en unités abstraites, pas des millisecondes
Comment voir les lectures disque dans un plan d'exécution ?|EXPLAIN (ANALYZE, BUFFERS) : shared hit = pages depuis le cache, shared read = pages lues depuis le disque
Quand le planner choisit-il un Seq Scan plutôt qu'un Index Scan ?|Quand la requête retourne > 5-10 % des lignes, quand la table est petite, ou quand il n'y a pas d'index utilisable sur la condition WHERE
Pourquoi un index B-tree standard est-il ignoré avec LOWER(col) = 'x' ?|L'index stocke les valeurs brutes — LOWER(col) produit des valeurs différentes. Solution : index fonctionnel CREATE INDEX ON t(LOWER(col))
Comment diagnostiquer des statistiques obsolètes dans un plan ?|Écart > ×10 entre rows estimées et rows réelles dans EXPLAIN ANALYZE → lancer ANALYZE nom_table pour mettre à jour les statistiques
Quel paramètre ajuster sur un serveur SSD pour favoriser les Index Scan ?|SET random_page_cost = 1.1 (défaut 4.0 supposant HDD — sur SSD les accès aléatoires sont presque aussi rapides que les séquentiels)
Différences Nested Loop / Hash Join / Merge Join ?|Nested Loop = petite table externe + index sur la table interne ; Hash Join = jointure égalité sur grands ensembles (hash table en work_mem) ; Merge Join = entrées déjà triées
Quand un Index Only Scan est-il possible ?|Quand toutes les colonnes du SELECT + WHERE + ORDER BY sont dans l'index — la heap n'est pas lue ; nécessite une visibility map à jour (VACUUM)
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-06-query-planner-deep-dive/`. Tu y analyses le plan du feed TribuZen étape par étape — Seq Scan → Index Scan → BUFFERS → JOIN → index ignoré — et tu mesures le gain à chaque étape. Corrigé SQL inline dans le README, aucun fichier séparé.
