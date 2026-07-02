---
titre: Performances et optimisation
cours: 10-postgresql
notions: [optimisation guidée par EXPLAIN, tuning d'index, VACUUM et ANALYZE, autovacuum, pagination keyset vs OFFSET, éviter le N plus 1, work_mem et mémoire, connection pooling, dénormalisation raisonnée]
outcomes: [optimiser une requête lente via EXPLAIN ANALYZE, choisir la pagination keyset, entretenir la base avec VACUUM ANALYZE, arbitrer normalisation et perf]
prerequis: [10-deadlocks]
next: 12-fonctions-avancees-sql
libs: [{ name: postgresql, version: "17" }]
tribuzen: optimiser le feed TribuZen (pagination keyset, index adaptés, requête sous 10ms)
last-reviewed: 2026-07
---

# Performances et optimisation

> **Outcomes — tu sauras FAIRE :** optimiser une requête lente via `EXPLAIN ANALYZE`, remplacer `OFFSET` par la pagination keyset, entretenir la base avec `VACUUM ANALYZE`, et arbitrer entre normalisation et performance.
> **Difficulté :** :star::star::star::star:

## 1. Cas concret d'abord

Le feed TribuZen charge les 20 derniers posts d'une famille. En développement avec 200 lignes, c'est instantané. En pré-prod avec 150 000 posts, la **page 26** — `OFFSET 500 LIMIT 20` — prend 820 ms. La page 100 prend 3 s. La cible est 10 ms.

```sql
-- Page 26 du feed famille 1
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.family_id = 1
ORDER BY p.created_at DESC
OFFSET 500 LIMIT 20;
```

```
Sort  (cost=22000.10..22375.10 rows=150000 width=80)
      (actual time=815.120..815.180 rows=20 loops=1)
  Sort Key: p.created_at DESC
  Buffers: shared read=14820
  ->  Hash Join  (actual time=12.820..420.000 rows=5000 loops=1)
        ->  Seq Scan on posts p  (actual time=0.012..250.000 rows=5000 loops=1)
              Filter: (family_id = 1)
              Buffers: shared read=14820
        ->  Hash on users u  (rows=500 loops=1)
Execution Time: 820.3 ms
```

PostgreSQL lit 14 820 pages de `posts`, trie les 5 000 lignes de la famille 1, puis **jette** les 500 premières pour rendre les 20 suivantes. Changer d'OFFSET ne réduit pas ce travail : c'est O(N). La suite donne la démarche pour diagnostiquer via `EXPLAIN`, corriger le plan avec un index, puis éliminer `OFFSET` avec la pagination keyset — qui reste sous 2 ms à toute profondeur.

## 2. Théorie complète, concise

### Démarche EXPLAIN-first : mesurer avant d'optimiser

Ne jamais ajouter un index ou réécrire une requête au feeling. La boucle est toujours :

1. `EXPLAIN (ANALYZE, BUFFERS)` — identifier le nœud lent (Seq Scan, Sort, Hash Join avec batches disque)
2. Intervenir (index, réécriture, paramètre)
3. Re-mesurer avec les mêmes données et la même taille

`EXPLAIN` sans `ANALYZE` affiche le plan estimé sans exécuter (sûr sur DELETE/UPDATE). `EXPLAIN ANALYZE` exécute réellement et mesure. `BUFFERS` révèle les pages lues sur disque (`shared read`) vs en cache (`shared hit`).

### Tuning d'index

Un index composite `(col_égalité, col_tri DESC)` élimine à la fois le Seq Scan et le nœud Sort dans le plan. L'ordre des colonnes compte : la colonne d'égalité en premier, la colonne de tri en second.

```sql
-- Filtre WHERE family_id = ? ORDER BY created_at DESC, id DESC
CREATE INDEX idx_posts_family_date ON posts(family_id, created_at DESC, id DESC);
ANALYZE posts;
```

Un **index partiel** réduit la taille de l'index quand seul un sous-ensemble est interrogé :

```sql
-- Seulement les posts non supprimés — index plus petit et plus rapide
CREATE INDEX idx_posts_active ON posts(family_id, created_at DESC, id DESC)
WHERE deleted_at IS NULL;
```

Un **covering index** inclut les colonnes du SELECT pour éviter tout accès à la heap (Index Only Scan) :

```sql
CREATE INDEX idx_posts_feed_covering
  ON posts(family_id, created_at DESC, id DESC)
  INCLUDE (content, author_id);
```

Après tout `CREATE INDEX`, lancer `ANALYZE` pour que le planner intègre les nouvelles statistiques.

### Pagination keyset vs OFFSET

`OFFSET N` force PostgreSQL à lire et jeter N lignes avant de rendre le résultat — coût O(N). La page 500 est 500× plus lente que la page 1.

La **pagination keyset** (cursor-based) passe les valeurs de la dernière ligne vue. Le moteur saute directement au bon endroit via l'index — coût O(log N), constant quelle que soit la profondeur.

```sql
-- OFFSET : coût O(N), dégrade linéairement
SELECT id, content, created_at
FROM posts
WHERE family_id = 1
ORDER BY created_at DESC, id DESC
OFFSET 500 LIMIT 20;

-- Keyset : coût O(log N), constant
-- last_ts et last_id = valeurs de la dernière ligne de la page précédente
SELECT id, content, created_at
FROM posts
WHERE family_id = 1
  AND (created_at, id) < ($last_ts, $last_id)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

La condition `(created_at, id) < (...)` est une comparaison de tuple : si `created_at` est strictement inférieur c'est valide ; si `created_at` est égal, `id` sert de départage — cela évite les doublons quand deux posts ont le même timestamp. L'index `(family_id, created_at DESC, id DESC)` sert directement l'`Index Cond` — aucun Sort externe.

Contrainte : on ne peut pas sauter à la page N sans suivre le curseur. La keyset convient aux feeds infinis et au scroll continu, pas aux interfaces paginées numérotées.

### Éviter le N+1

Le problème N+1 apparaît quand une boucle charge N entités puis exécute une requête par entité pour une relation. Résultat : 1 + N allers-retours base de données.

```sql
-- N+1 : 1 requête pour les posts, puis 1 par post pour l'auteur
SELECT id, author_id FROM posts WHERE family_id = 1 ORDER BY created_at DESC LIMIT 20;
-- puis, pour chaque post :
SELECT display_name FROM users WHERE id = $1;   -- répété 20 fois
```

Solution : un JOIN unique couvre les deux en un seul aller-retour :

```sql
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.family_id = 1
ORDER BY p.created_at DESC
LIMIT 20;
```

Pour détecter un N+1, activer `log_min_duration_statement = 0` en développement et repérer les rafales de requêtes similaires dans les logs, ou utiliser `pg_stat_statements` en production.

### VACUUM, ANALYZE et autovacuum

PostgreSQL ne modifie pas les lignes en place : un `UPDATE` écrit une nouvelle version (tuple) et laisse l'ancienne comme **tuple mort**. Un `DELETE` laisse aussi le tuple mort en place. Ces tuples morts gonflent la table (**bloat**) et allongent les Seq Scan.

`VACUUM` marque l'espace des tuples morts comme réutilisable (sans réduire le fichier sur disque, sans lock exclusif). `ANALYZE` met à jour les statistiques du planner. `VACUUM ANALYZE table` fait les deux en un seul passage.

```sql
-- Diagnostiquer le bloat et le statut vacuum
SELECT relname, n_live_tup, n_dead_tup,
       ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
FROM pg_stat_user_tables
WHERE relname IN ('posts', 'reactions', 'users')
ORDER BY n_dead_tup DESC;

-- Nettoyer et mettre à jour les stats (sans lock exclusif)
VACUUM ANALYZE posts;
```

**Autovacuum** déclenche VACUUM + ANALYZE automatiquement quand le nombre de dead tuples dépasse un seuil :

```
seuil = autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor × n_live_tup
défaut   50                            0.20 (20 %)
```

Pour une table de 150 000 lignes, cela donne un seuil à 30 050 dead tuples — trop tardif pour un feed actif. Tuning par table (sans toucher `postgresql.conf`) :

```sql
ALTER TABLE posts SET (
  autovacuum_vacuum_scale_factor    = 0.02,   -- 2 % au lieu de 20 %
  autovacuum_analyze_scale_factor   = 0.01,
  autovacuum_vacuum_threshold       = 100,
  autovacuum_analyze_threshold      = 100
);
```

Ne jamais utiliser `VACUUM FULL` en production : il prend un lock `ACCESS EXCLUSIVE` qui bloque toutes les requêtes (lectures incluses) pendant la réécriture complète. Si le bloat est sévère, préférer `pg_repack`.

### work_mem et mémoire

`work_mem` est alloué **par opération** de tri ou de hachage — pas par requête, pas par connexion. Une requête avec un Hash Join et deux sorts peut consommer `3 × work_mem`. Avec 100 connexions actives, le pic est `connexions × opérations × work_mem`.

```sql
SHOW work_mem;   -- 4MB par défaut (souvent insuffisant)

-- Augmenter pour la session courante avant une requête lourde
SET work_mem = '64MB';
EXPLAIN (ANALYZE, BUFFERS) SELECT ...;
-- Observer : Hash Join doit afficher  Batches: 1  (tout en mémoire)
-- Si Batches: N (N > 1) → débordement disque, augmenter work_mem
```

Ne jamais modifier `work_mem` globalement sans calculer le budget : `50 connexions × 3 ops × 64 MB = 9,6 GB` de pic possible.

### Connection pooling

Chaque connexion PostgreSQL crée un processus OS (~5-10 MB de RAM, latence de fork ~50 ms). Une application multi-instances peut saturer `max_connections` rapidement.

`pg.Pool` (driver `node-postgres`) maintient un pool de connexions réutilisables dans le même process Node.js. Pour les architectures multi-instances, un proxy externe comme **PgBouncer** en mode transaction pooling partage un petit nombre de connexions PG entre des centaines de clients.

```sql
-- Voir les connexions actives et les requêtes en attente de slot
SELECT state, wait_event_type, wait_event, COUNT(*)
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state, wait_event_type, wait_event
ORDER BY COUNT(*) DESC;
```

Règle empirique : `max_connections` PostgreSQL ≤ `(CPUs × 2) + disques`. Pool par instance Node = `max_connections / nb_instances`.

### Dénormalisation raisonnée

La normalisation élimine la redondance mais force des jointures coûteuses sur les tables très consultées. La **dénormalisation raisonnée** accepte une redondance contrôlée quand la jointure est mesurée comme goulot et quand les mises à jour sont peu fréquentes.

Exemples courants :
- **Compteur dénormalisé** : stocker `families.members_count` plutôt que `COUNT(*)` sur `family_members` à chaque affichage.
- **Colonne calculée** : stocker `posts.reaction_count` mis à jour par trigger ou côté applicatif.

Règle : dénormaliser **seulement** après que `EXPLAIN ANALYZE` montre que la jointure ou l'agrégat est le nœud lent, et seulement si les mises à jour sont peu fréquentes. Pas l'inverse.

## 3. Worked examples

### Exemple A — OFFSET → keyset sur le feed TribuZen

```sql
-- Schéma et données de test
CREATE TABLE users    (id SERIAL PRIMARY KEY, display_name TEXT NOT NULL);
CREATE TABLE families (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE posts (
  id         SERIAL PRIMARY KEY,
  family_id  INT NOT NULL REFERENCES families(id),
  author_id  INT NOT NULL REFERENCES users(id),
  content    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO users    SELECT i, 'User '||i FROM generate_series(1, 500) i;
INSERT INTO families SELECT i, 'Famille '||i FROM generate_series(1, 30) i;
INSERT INTO posts
  SELECT i,
         (random()*29  + 1)::int,
         (random()*499 + 1)::int,
         repeat('Post TribuZen contenu ', 8),
         now() - (random()*365 || ' days')::interval
  FROM generate_series(1, 150000) i;
ANALYZE;
```

Plan avec `OFFSET 500` sans index :

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.family_id = 1
ORDER BY p.created_at DESC
OFFSET 500 LIMIT 20;
```

```
Sort  (cost=22000.10..22375.10 rows=150000 width=80)
      (actual time=815.120..815.180 rows=20 loops=1)
  Sort Key: p.created_at DESC
  Buffers: shared read=14820
  ->  Seq Scan on posts p  (actual time=0.012..250.000 rows=5000 loops=1)
        Filter: (family_id = 1)
        Buffers: shared read=14820
Execution Time: 820.3 ms
```

Création de l'index et bascule keyset :

```sql
CREATE INDEX idx_posts_family_date ON posts(family_id, created_at DESC, id DESC);
ANALYZE posts;

-- Récupérer d'abord le curseur de la dernière ligne de la page précédente
-- (la valeur ci-dessous est illustrative — prendre la vraie dernière ligne de page 25)
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.family_id = 1
  AND (p.created_at, p.id) < ('2026-05-15 14:22:10+00', 74320)
ORDER BY p.created_at DESC, p.id DESC
LIMIT 20;
```

```
Limit  (actual time=0.260..0.490 rows=20 loops=1)
  ->  Nested Loop  (actual time=0.255..0.475 rows=20 loops=1)
        ->  Index Scan using idx_posts_family_date on posts p
              (actual time=0.028..0.082 rows=20 loops=1)
              Index Cond: ((family_id = 1) AND ((created_at, id) < (...)))
              Buffers: shared hit=5
        ->  Index Scan using users_pkey on users u  (loops=20)
Execution Time: 0.6 ms
```

Pas-à-pas : (1) sans index, le planner fait un Seq Scan sur 14 820 pages suivi d'un Sort coûteux — PostgreSQL trie les 5 000 lignes de `family_id=1` pour en jeter 500, quel que soit l'OFFSET demandé ; (2) l'index `(family_id, created_at DESC, id DESC)` livre les lignes dans l'ordre exact du `ORDER BY` — le nœud `Sort` disparaît du plan car les données arrivent déjà triées ; (3) la condition keyset `(created_at, id) < (...)` est évaluée directement dans l'`Index Cond` — le planner ne lit que 5 pages d'index (`shared hit=5`) sans aucun accès à la heap ; (4) le temps reste 0,6 ms à toute profondeur du feed, même à la page 10 000.

### Exemple B — Diagnostic VACUUM et tuning autovacuum

```sql
-- Simuler de l'activité : UPDATE génère des dead tuples
UPDATE posts SET content = content || ' (edit)' WHERE id % 4 = 0;
UPDATE posts SET content = content || ' (v2)'   WHERE id % 6 = 0;

-- Diagnostic avant VACUUM
SELECT relname, n_live_tup, n_dead_tup,
       ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_vacuum, last_autovacuum
FROM pg_stat_user_tables
WHERE relname = 'posts';
```

```
 relname | n_live_tup | n_dead_tup | dead_pct | last_vacuum | last_autovacuum
---------+------------+------------+----------+-------------+------------------
 posts   |    150000  |     47142  |    23.9  | (null)      | (null)
```

L'autovacuum n'a pas encore tourné (le daemon se réveille par naptime, ~1 min). Forcer le nettoyage manuellement :

```sql
VACUUM ANALYZE posts;

-- Revérifier : n_dead_tup doit être proche de 0
SELECT relname, n_live_tup, n_dead_tup, last_vacuum
FROM pg_stat_user_tables
WHERE relname = 'posts';
```

Tuning autovacuum pour éviter que le bloat atteigne 20 % :

```sql
ALTER TABLE posts SET (
  autovacuum_vacuum_scale_factor    = 0.02,   -- déclenche à 2 % au lieu de 20 %
  autovacuum_analyze_scale_factor   = 0.01,
  autovacuum_vacuum_threshold       = 100,
  autovacuum_analyze_threshold      = 100
);

-- Vérifier la config stockée dans le catalogue
SELECT relname, reloptions
FROM pg_class
WHERE relname = 'posts';
-- → reloptions = {autovacuum_vacuum_scale_factor=0.02,...}
```

Pas-à-pas : (1) `pg_stat_user_tables` est la première source de diagnostic — `n_dead_tup` et `dead_pct` indiquent le bloat instantané, `last_autovacuum` confirme si le daemon a tourné ; (2) `VACUUM ANALYZE posts` nettoie les dead tuples **et** rafraîchit les stats du planner en un seul passage non bloquant — les requêtes SELECT et INSERT continuent pendant l'opération ; (3) le tuning par table via `ALTER TABLE ... SET (...)` cible la table active sans perturber les petites tables qui n'ont pas besoin de vacuum fréquent ; (4) avec `scale_factor = 0.02` sur 150 000 lignes, le seuil passe de 30 050 à 3 100 dead tuples — le bloat reste sous 2 % en permanence et les stats restent fraîches pour des plans optimaux.

## 4. Pièges & misconceptions

- **`OFFSET` semblait rapide en développement.** Avec 200 lignes, tout est rapide. Avec 150 000 lignes et `OFFSET 500`, PostgreSQL trie et jette 500 lignes à chaque appel — coût O(N). *Correct* : adopter la pagination keyset dès le départ sur tout feed à volume croissant.

- **Ajouter un index résout tout.** Un index inutilisé consomme de la RAM, ralentit les INSERT/UPDATE/DELETE et grossit après chaque commit. Chaque index doit être justifié par un `EXPLAIN ANALYZE` montrant un Seq Scan sur une grande table sélective. *Correct* : mesurer d'abord, créer l'index, re-mesurer — si le plan n'en profite pas, le supprimer.

- **`work_mem` est par requête.** Non : c'est par **opération** (sort, hash). Une requête avec un Hash Join et deux ORDER BY peut consommer `3 × work_mem`. Multiplié par toutes les connexions actives, une valeur mal calibrée cause des OOM. *Correct* : calculer `max_connexions × ops_max × work_mem` avant d'augmenter globalement ; préférer `SET work_mem = '...'` par session pour les requêtes lourdes.

- **`VACUUM FULL` règle le bloat en production.** Il prend un lock `ACCESS EXCLUSIVE` qui bloque 100 % des requêtes (lectures incluses) pendant la réécriture. *Correct* : `VACUUM` standard ou `pg_repack` pour le bloat sans downtime ; `VACUUM FULL` uniquement en maintenance window planifiée.

- **Dénormaliser d'abord, mesurer ensuite.** La dénormalisation complique les mises à jour, risque les incohérences et ne s'annule pas facilement. *Correct* : normaliser d'abord, mesurer le coût de la jointure avec `EXPLAIN ANALYZE`, dénormaliser seulement si c'est le goulot prouvé et si les écritures sont peu fréquentes.

- **Le N+1 est invisible en développement.** Sur une base de 200 lignes tout en cache, 20 requêtes supplémentaires passent inaperçues. En production sur 10 000 posts, c'est 10 000 allers-retours. *Correct* : activer `log_min_duration_statement = 0` en développement et repérer les rafales de requêtes similaires dans les logs.

## 5. Ancrage TribuZen

Couche fil-rouge : **optimiser le feed TribuZen** dans `smaurier/tribuzen` — feed = liste des posts récents d'une famille, chargée à chaque ouverture de l'app.

- La pagination keyset `(created_at, id) < (curseur)` remplace `OFFSET` dans l'API `/feed` : le premier curseur est `null` (page 1) ; chaque réponse renvoie `id` et `created_at` de la dernière ligne pour que le client puisse demander la page suivante. Le client React Native mémorise ce curseur dans son état local.
- L'index `(family_id, created_at DESC, id DESC)` couvre exactement le pattern d'accès du feed — filtrer par `family_id`, trier par date décroissante. Ajouter `INCLUDE (content, author_id)` permet un Index Only Scan qui évite entièrement la heap pour les colonnes couvertes.
- `families.members_count` est maintenu dans la transaction d'acceptation d'invitation (module 04) — évite un `COUNT(*)` sur `family_members` à chaque rendu de la carte famille. C'est le cas de dénormalisation validé par `EXPLAIN ANALYZE` qui montrait le `COUNT(*)` en goulot.
- L'autovacuum de `posts` et `reactions` (les deux tables les plus écrites) est tuné à 2 % pour que les stats restent fraîches et que le bloat n'impacte pas les plans.
- `pg_stat_statements` surveille `mean_exec_time` sur la requête feed en continu : une régression au-delà de 10 ms déclenche une alerte — signal que l'index a peut-être été supprimé accidentellement ou que les statistiques sont obsolètes.

## 6. Points clés

1. Toujours mesurer avant d'agir : `EXPLAIN (ANALYZE, BUFFERS)` identifie le nœud lent — Seq Scan, Sort coûteux, Hash Join avec `Batches > 1`.
2. L'index composite `(col_égalité, col_tri DESC)` élimine à la fois le Seq Scan et le Sort — l'ordre des colonnes est intentionnel et déterminant.
3. `OFFSET N` coûte O(N) : la page 500 est 500× plus lente que la page 1. La pagination keyset `(col, id) < (curseur)` reste constante à toute profondeur.
4. `VACUUM ANALYZE table` nettoie les dead tuples et rafraîchit les stats en un seul passage non bloquant — ne jamais utiliser `VACUUM FULL` en production (lock ACCESS EXCLUSIVE).
5. Tuner l'autovacuum par table active : `autovacuum_vacuum_scale_factor = 0.02` déclenche le nettoyage à 2 % de dead tuples au lieu de 20 %.
6. `work_mem` est par opération, pas par requête — calculer le budget mémoire total avant d'augmenter globalement.
7. Chaque connexion PostgreSQL crée un processus OS ; `pg.Pool` et PgBouncer partagent les connexions pour maintenir `max_connections` bas.
8. Dénormaliser uniquement après que `EXPLAIN ANALYZE` prouve que la jointure est le goulot, et seulement si les mises à jour sont peu fréquentes.

## 7. Seeds Anki

```
Pourquoi OFFSET 500 LIMIT 20 est-il lent sur une grande table ?|PostgreSQL lit et jette les 500 premières lignes avant de rendre les 20 suivantes — coût O(N), la page 500 est 500× plus lente que la page 1
Comment fonctionne la pagination keyset ?|Passer les valeurs de la dernière ligne vue : WHERE (created_at, id) < ($last_ts, $last_id) ORDER BY created_at DESC, id DESC LIMIT 20 — le planner saute directement via l'index, coût O(log N) constant
Quel index convient au pattern WHERE family_id = ? ORDER BY created_at DESC, id DESC ?|CREATE INDEX ON posts(family_id, created_at DESC, id DESC) — family_id pour le filtre d'égalité, created_at DESC et id DESC pour le tri sans Sort supplémentaire
Que fait VACUUM ANALYZE table ?|Marque l'espace des dead tuples comme réutilisable (VACUUM) ET met à jour les statistiques du planner (ANALYZE) en un seul passage sans lock exclusif
Pourquoi éviter VACUUM FULL en production ?|Il prend un lock ACCESS EXCLUSIVE qui bloque toutes les requêtes (lectures et écritures) pendant la réécriture complète — utiliser pg_repack à la place
Comment tuner l'autovacuum pour une table très active ?|ALTER TABLE t SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01) — déclenche à 2 % de dead tuples au lieu de 20 %
Qu'est-ce que le problème N+1 ?|Charger N entités puis une requête par entité pour une relation — 1 + N allers-retours. Résoudre avec un JOIN unique ou un IN groupé
Pourquoi work_mem doit-il être calibré avec précaution ?|C'est alloué par opération (sort, hash), pas par requête — une requête peut en utiliser plusieurs ; 100 connexions × 3 ops × 64 MB = 19 GB de pic mémoire possible
Que signifie Batches: N dans un plan Hash Join ?|La hash table a débordé sur disque (N passes au lieu de 1) — augmenter work_mem localement peut l'éliminer et réduire le temps de la jointure
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-11-performances/`. Tu y mesures le coût réel d'`OFFSET` vs keyset sur le feed TribuZen, tu ajoutes l'index composite et vérifies la chute du plan, tu diagnostiques le bloat sur `posts` avec `pg_stat_user_tables` et lances `VACUUM ANALYZE`, et tu tunes l'autovacuum. Corrigé SQL inline dans le README, aucun fichier séparé.
