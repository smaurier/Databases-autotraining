---
titre: Monitoring et observabilité
cours: 10-postgresql
notions: [vues pg_stat, extension pg_stat_statements, journal des requêtes lentes, suivi des connexions, détection du bloat, métriques et exporter Prometheus, alerting, diagnostic en production]
outcomes: [suivre l'activité avec les vues pg_stat, repérer les requêtes lentes avec pg_stat_statements, détecter le bloat, exposer des métriques pour l'alerting]
prerequis: [16-replication]
next: 18-partitioning-et-scaling
libs: [{ name: postgresql, version: "17" }]
tribuzen: monitorer la base TribuZen (requêtes lentes du feed, connexions, bloat) en production
last-reviewed: 2026-07
---

# Monitoring et observabilité

> **Outcomes — tu sauras FAIRE :** suivre l'activité en temps réel avec `pg_stat_activity`, repérer les requêtes lentes avec `pg_stat_statements`, détecter le bloat sur `posts` et `reactions` avec `pg_stat_user_tables`, et exposer des métriques pour l'alerting.
> **Difficulté :** :star::star::star::star:

## 1. Cas concret d'abord

TribuZen est en production depuis une semaine. Les utilisateurs signalent que le feed famille prend parfois 4-5 secondes. En développement avec 200 lignes, c'est instantané — aucune alerte ne s'est déclenchée pendant les tests. Sans tableau de bord, on vole à l'aveugle.

On lance `pg_stat_statements` pour voir ce que la base exécute réellement :

```sql
-- Top 5 des requêtes les plus coûteuses en temps total
SELECT LEFT(query, 80) AS query,
       calls,
       ROUND(mean_exec_time::numeric, 2) AS mean_ms,
       ROUND(total_exec_time::numeric, 0) AS total_ms
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 5;
```

```
 query                                               | calls | mean_ms | total_ms
-----------------------------------------------------+-------+---------+---------
 SELECT p.id, p.content, p.created_at, u.display... |  4821 |  312.40 |  1506793
 INSERT INTO reactions (post_id, user_id, type) ...  |  9204 |    0.83 |     7640
 SELECT id FROM users WHERE email = $1               |  2301 |    1.20 |     2761
```

La requête feed représente 99 % du temps total. En parallèle, `pg_stat_activity` révèle deux sessions en état `idle in transaction` depuis plus de 10 minutes — elles bloquent VACUUM et accumulent des dead tuples sur `posts`.

La suite explique ces deux vues, le journal des requêtes lentes, la détection du bloat et comment brancher Prometheus pour que l'alerte arrive *avant* le prochain incident.

## 2. Théorie complète, concise

### pg_stat_activity — qui fait quoi en ce moment

`pg_stat_activity` expose une ligne par session connectée. Colonnes clés : `state` (active / idle / idle in transaction), `query_start`, `xact_start`, `wait_event_type`, `query`.

```sql
-- Sessions actives, hors la session courante
SELECT pid,
       usename,
       state,
       now() - query_start AS duration,
       wait_event_type,
       LEFT(query, 80) AS query
FROM pg_stat_activity
WHERE state = 'active'
  AND pid <> pg_backend_pid()
ORDER BY query_start;
```

L'état `idle in transaction` est le plus dangereux : une transaction `BEGIN` a été ouverte, rien ne s'exécute. VACUUM ne peut pas libérer les tuples morts antérieurs au `xact_start` de cette session — dans **toutes** les tables du serveur, même celles que la session n'a jamais touchées.

```sql
-- Sessions idle in transaction depuis plus de 5 min
SELECT pid,
       usename,
       now() - xact_start AS idle_tx_duration,
       LEFT(query, 80) AS last_query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND now() - xact_start > interval '5 minutes'
ORDER BY xact_start;
```

Compter les connexions par état pour anticiper la saturation de `max_connections` :

```sql
SELECT state,
       COUNT(*) AS n,
       ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY state
ORDER BY n DESC;
```

Identifier qui bloque qui avec `pg_blocking_pids()` :

```sql
SELECT pid,
       usename,
       pg_blocking_pids(pid) AS blocked_by,
       LEFT(query, 80) AS query,
       now() - query_start AS waiting_since
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0
ORDER BY query_start;
```

### pg_stat_statements — le top SQL historique

`pg_stat_statements` est une **extension** (pas une vue système native) : elle doit être listée dans `shared_preload_libraries` avant le démarrage du serveur, puis activée par base.

```sql
-- shared_preload_libraries = 'pg_stat_statements'    (postgresql.conf, redémarrage)
-- pg_stat_statements.max = 10000
-- pg_stat_statements.track = all

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

Colonnes essentielles de `pg_stat_statements` en PG 17 :

| Colonne | Signification |
|---|---|
| `query` | Texte normalisé — littéraux remplacés par `$1`, `$2`… |
| `calls` | Nombre d'exécutions depuis le dernier reset |
| `total_exec_time` | Temps d'exécution cumulé (ms) |
| `mean_exec_time` | Moyenne par appel (ms) |
| `shared_blks_hit` | Pages servies depuis `shared_buffers` |
| `shared_blks_read` | Pages lues sur disque |
| `rows` | Lignes retournées cumulées |

```sql
-- Requêtes les plus coûteuses en temps total (top 10)
SELECT LEFT(query, 100) AS query,
       calls,
       ROUND(total_exec_time::numeric, 0)  AS total_ms,
       ROUND(mean_exec_time::numeric, 2)   AS mean_ms,
       ROUND(100.0 * total_exec_time
             / NULLIF(SUM(total_exec_time) OVER (), 0), 1) AS pct_total,
       ROUND(100.0 * shared_blks_hit
             / NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS cache_pct
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;

-- Requêtes avec le pire cache hit ratio (lectures disque dominantes)
SELECT LEFT(query, 80) AS query,
       calls,
       shared_blks_read,
       ROUND(100.0 * shared_blks_hit
             / NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS cache_pct
FROM pg_stat_statements
WHERE calls > 50
  AND shared_blks_read > 0
ORDER BY cache_pct ASC
LIMIT 10;
```

Les statistiques sont **cumulatives** depuis le dernier reset ou redémarrage. Pour obtenir des métriques sur un intervalle, prendre un snapshot et calculer les deltas — c'est ce que fait `postgres_exporter` automatiquement.

```sql
-- Remettre à zéro après un déploiement
SELECT pg_stat_statements_reset();
```

### Journal des requêtes lentes — log_min_duration_statement

`pg_stat_statements` donne les statistiques agrégées. Pour capturer une requête lente **en temps réel** avec ses paramètres exacts, configurer le journal :

```
# postgresql.conf
log_min_duration_statement = 200    # ms — loguer toute requête > 200 ms
log_line_prefix = '%m [%p] %u@%d '  # timestamp ms, PID, user@db
log_lock_waits = on                 # loguer les attentes de lock > deadlock_timeout
```

Entrée de log avec ce réglage :

```
2026-07-02 14:23:45.312 CEST [4521] app@tribuzen LOG:  duration: 312.4 ms
    statement: SELECT p.id, p.content, p.created_at, u.display_name
               FROM posts p JOIN users u ON p.author_id = u.id
               WHERE p.family_id = $1 ORDER BY p.created_at DESC LIMIT 20
```

### Détection du bloat — pg_stat_user_tables

Un `UPDATE` ou `DELETE` ne modifie pas les lignes en place : il écrit une nouvelle version et laisse l'ancienne (tuple mort) jusqu'à ce que VACUUM passe. Sur `posts` (table très écrite), le bloat s'accumule rapidement si une session `idle in transaction` bloque VACUUM.

```sql
-- Bloat et statut VACUUM sur les tables TribuZen
SELECT relname,
       n_live_tup,
       n_dead_tup,
       ROUND(100.0 * n_dead_tup
             / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_autovacuum,
       last_autoanalyze
FROM pg_stat_user_tables
WHERE relname IN ('posts', 'reactions', 'users', 'families', 'family_members')
ORDER BY n_dead_tup DESC;
```

Seuils : `dead_pct < 5 %` sain, `> 10 %` surveiller, `> 20 %` agir — VACUUM manuel + investigation des sessions `idle in transaction` dans `pg_stat_activity`.

### Cache hit ratio — pg_stat_database

```sql
SELECT datname,
       ROUND(100.0 * blks_hit
             / NULLIF(blks_hit + blks_read, 0), 2) AS cache_hit_pct,
       deadlocks,
       temp_files,
       numbackends AS connexions
FROM pg_stat_database
WHERE datname = current_database();
```

`cache_hit_pct < 99 %` est le premier signal que `shared_buffers` est trop petit ou que la base de données ne tient plus en mémoire. Cible : 25 % de la RAM pour `shared_buffers`.

### Prometheus + postgres_exporter — métriques en continu

Les vues `pg_stat_*` sont des instantanés. Pour suivre l'évolution dans le temps et déclencher des alertes, `postgres_exporter` scrappe ces vues toutes les 15 secondes et les expose au format Prometheus sur le port 9187.

```yaml
# docker-compose.yml (extrait)
services:
  postgres_exporter:
    image: quay.io/prometheuscommunity/postgres-exporter
    environment:
      DATA_SOURCE_NAME: "postgresql://monitor:secret@postgres:5432/tribuzen?sslmode=disable"
    ports:
      - "9187:9187"
```

Métriques Prometheus clés pour TribuZen :

| Métrique | Alerte si |
|---|---|
| `pg_stat_activity_count{state="idle in transaction"}` | > 3 |
| cache hit ratio (blks_hit / blks_hit + blks_read) | < 99 % |
| `pg_stat_user_tables_n_dead_tup` (posts) | > 10 % de n_live_tup |
| `pg_stat_statements_mean_exec_time_seconds` (feed) | > 200 ms |
| `pg_stat_database_deadlocks` delta | > 0 / min |

## 3. Worked examples

### Exemple A — identifier et corriger la requête feed lente

Objectif : passer de « le feed est lent » à « cette requête précise, ce plan, ce montant » — et confirmer le fix dans `pg_stat_statements`.

```sql
-- Étape 1 : activer pg_stat_statements (une seule fois par base)
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Étape 2 : trouver la requête feed dans le top coûteux
SELECT LEFT(query, 100) AS query,
       calls,
       ROUND(mean_exec_time::numeric, 2) AS mean_ms,
       ROUND(total_exec_time::numeric, 0) AS total_ms,
       ROUND(100.0 * shared_blks_hit
             / NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS cache_pct
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 5;
```

```
 query                                               | calls | mean_ms | total_ms | cache_pct
-----------------------------------------------------+-------+---------+----------+----------
 SELECT p.id, p.content, p.created_at, u.display... |  4821 |  312.40 |  1506793 |      54.2
```

Le `cache_pct` à 54 % indique que la moitié des pages est lue sur disque — signal fort d'un Seq Scan sans index.

```sql
-- Étape 3 : EXPLAIN ANALYZE pour identifier le nœud lent
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.family_id = 1
ORDER BY p.created_at DESC
LIMIT 20;
```

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

```sql
-- Étape 4 : corriger avec l'index composite
CREATE INDEX idx_posts_family_date ON posts(family_id, created_at DESC, id DESC);
ANALYZE posts;

-- Étape 5 : vérifier le nouveau plan
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.content, p.created_at, u.display_name
FROM posts p
JOIN users u ON p.author_id = u.id
WHERE p.family_id = 1
ORDER BY p.created_at DESC, p.id DESC
LIMIT 20;
```

```
Limit  (actual time=0.26..0.49 rows=20 loops=1)
  ->  Nested Loop  (actual time=0.25..0.47 rows=20 loops=1)
        ->  Index Scan using idx_posts_family_date on posts p
              Index Cond: (family_id = 1)
              Buffers: shared hit=5
        ->  Index Scan using users_pkey on users u  (loops=20)
Execution Time: 0.6 ms
```

```sql
-- Étape 6 : confirmer la régression dans pg_stat_statements
-- (après un volume suffisant de nouveaux appels)
SELECT LEFT(query, 80) AS query,
       calls,
       ROUND(mean_exec_time::numeric, 2) AS mean_ms
FROM pg_stat_statements
WHERE query LIKE '%posts p%family_id%'
ORDER BY total_exec_time DESC
LIMIT 3;
-- mean_ms doit être descendu de 312 ms à < 5 ms sur les nouveaux appels
```

Pas-à-pas : (1) `pg_stat_statements` identifie la requête feed comme responsable de 99 % du temps total — aucune recherche dans les logs nécessaire ; (2) le `cache_pct` à 54 % confirme un Seq Scan intensif avant même de lancer `EXPLAIN` ; (3) `EXPLAIN ANALYZE BUFFERS` localise le nœud lent — Sort sur Seq Scan, 14 820 pages lues sur disque ; (4) l'index composite `(family_id, created_at DESC, id DESC)` élimine à la fois le Seq Scan et le Sort : le plan passe à Nested Loop + Index Scan en 0,6 ms ; (5) `pg_stat_statements` confirme le fix sur les nouveaux appels — `mean_ms` de 312 ms à < 5 ms.

### Exemple B — détecter le bloat et les connexions dangereuses

Objectif : identifier une session `idle in transaction` qui bloque VACUUM, mesurer le bloat résultant, et nettoyer.

```sql
-- Simuler de l'activité : UPDATE génère des dead tuples
UPDATE posts SET content = content || ' (edit)' WHERE id % 4 = 0;
UPDATE posts SET content = content || ' (v2)'   WHERE id % 6 = 0;

-- Vérifier le bloat avant VACUUM
SELECT relname,
       n_live_tup,
       n_dead_tup,
       ROUND(100.0 * n_dead_tup
             / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_vacuum,
       last_autovacuum
FROM pg_stat_user_tables
WHERE relname IN ('posts', 'reactions')
ORDER BY n_dead_tup DESC;
```

```
 relname  | n_live_tup | n_dead_tup | dead_pct | last_vacuum | last_autovacuum
----------+------------+------------+----------+-------------+-----------------
 posts    |    150000  |     47142  |     23.9 | (null)      | (null)
 reactions|     82400  |         0  |      0.0 | (null)      | (null)
```

```sql
-- Détecter la session qui bloque VACUUM
SELECT pid,
       usename,
       now() - xact_start AS idle_since,
       LEFT(query, 80) AS last_query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY xact_start;
```

```
  pid  | usename |   idle_since    | last_query
-------+---------+-----------------+----------------------------
 18432 | app     | 00:12:43.512890 | UPDATE posts SET content ...
```

```sql
-- Fermer la session bloquante
SELECT pg_terminate_backend(18432);

-- Lancer VACUUM manuellement (non bloquant)
VACUUM ANALYZE posts;

-- Revérifier : n_dead_tup doit revenir à 0
SELECT relname, n_live_tup, n_dead_tup, last_vacuum
FROM pg_stat_user_tables
WHERE relname = 'posts';
```

Pas-à-pas : (1) `pg_stat_user_tables` montre 23,9 % de dead tuples et `last_autovacuum` à NULL — l'autovacuum n'a pas tourné parce qu'une session `idle in transaction` depuis 12 minutes empêche VACUUM de libérer les tuples antérieurs à son `xact_start` ; (2) `pg_stat_activity` révèle le PID 18432 comme coupable ; (3) `pg_terminate_backend()` ferme proprement la session ; (4) `VACUUM ANALYZE posts` nettoie les dead tuples et rafraîchit les statistiques du planner en un seul passage sans lock exclusif — `SELECT`, `INSERT` et `UPDATE` continuent pendant l'opération ; (5) après le VACUUM, `n_dead_tup` revient à 0 et les plans du planner bénéficient de statistiques fraîches.

## 4. Pièges & misconceptions

- **« pg_stat_statements montre les sessions actives. »** Non : c'est un historique agrégé depuis le dernier reset. Pour les sessions en cours en ce moment, utiliser `pg_stat_activity` filtrée sur `state = 'active'`. *Correct* : les deux vues sont complémentaires — `pg_stat_statements` pour le diagnostic long terme, `pg_stat_activity` pour l'instantané.

- **« idle in transaction est inoffensif si aucune écriture n'est en cours. »** Faux : la session maintient un `xact_start` ancien. VACUUM ne peut pas libérer les tuples morts antérieurs à ce snapshot dans **toutes** les tables du serveur, même celles que la session n'a jamais touchées. *Correct* : configurer `idle_in_transaction_session_timeout = '5min'` pour terminer automatiquement ces sessions.

- **« Un cache_hit_ratio de 97 % est bon. »** La cible PostgreSQL est **99 %**. À 97 %, sur 10 000 lectures par seconde, 300 accès disque/s alourdissent la latence. *Correct* : vérifier si `shared_buffers` est à 25 % de la RAM ; si la base ne tient pas en mémoire, augmenter `shared_buffers` ou la RAM.

- **« pg_stat_statements montre les vraies valeurs SQL. »** Les requêtes sont **normalisées** : `WHERE id = 42` et `WHERE id = 99` deviennent la même ligne avec `$1`. *Correct* : combiner avec `log_min_duration_statement` pour capturer les exécutions individuelles avec leurs paramètres réels.

- **« Les statistiques de pg_stat_statements sont propres après un déploiement. »** Elles sont **cumulatives** depuis le dernier reset. Les chiffres d'avant le déploiement polluent la lecture. *Correct* : lancer `pg_stat_statements_reset()` juste avant le déploiement pour repartir de statistiques propres et détecter rapidement une régression.

- **« VACUUM ne peut pas tourner si une transaction longue est ouverte sur une autre table. »** VACUUM peut s'exécuter, mais il ne peut pas **libérer** les tuples morts antérieurs au `xact_start` de la transaction ouverte, quelle que soit la table concernée. *Correct* : surveiller régulièrement `pg_stat_activity` pour les sessions `idle in transaction` longues — leur impact est global sur tout le serveur.

## 5. Ancrage TribuZen

Couche fil-rouge : **monitorer la base TribuZen en production** dans `smaurier/tribuzen` — feed, connexions, bloat.

- `pg_stat_statements` surveille la requête feed `(family_id, created_at DESC LIMIT 20)` en continu : `mean_exec_time` doit rester sous 10 ms. Si elle remonte au-delà de 200 ms, une alerte Prometheus se déclenche avant que les utilisateurs signalent des lenteurs.
- `pg_stat_activity` filtrée sur `idle in transaction` est la première requête à lancer en cas d'alerte sur le bloat de `posts` ou `reactions` — c'est souvent une connexion Node.js dont le callback n'a pas appelé `COMMIT` ou `ROLLBACK` après un timeout HTTP.
- `pg_stat_user_tables` surveille `dead_pct` sur `posts` (table la plus écrite : réactions, éditions) et `family_members` (insertions à chaque acceptation d'invitation du module 04). L'autovacuum est tuné à 2 % (module 11) mais `pg_stat_user_tables` permet de vérifier qu'il tourne effectivement via `last_autovacuum`.
- `pg_stat_database` vérifie le cache hit ratio sur `tribuzen` : si le feed charge 5 000 posts par famille_id et que la base grandit, `shared_buffers` devra être revu.
- `pg_stat_statements_reset()` est lancé après chaque migration en production : les statistiques repartent à zéro et une régression introduite par la nouvelle version apparaît dans le top `mean_exec_time` en quelques minutes de trafic réel.

## 6. Points clés

1. `pg_stat_activity` = instantané des sessions actives ; filtrer sur `state = 'idle in transaction'` pour trouver les sessions qui bloquent VACUUM à l'échelle du serveur.
2. `pg_stat_statements` = historique agrégé ; colonnes clés : `total_exec_time`, `mean_exec_time`, `calls`, `shared_blks_read` et `cache_pct` calculé.
3. Workflow diagnostic : `pg_stat_statements` (top total_exec_time) → `EXPLAIN ANALYZE BUFFERS` (nœud lent) → fix (index / réécriture) → re-mesurer dans `pg_stat_statements`.
4. `log_min_duration_statement` capture les exécutions individuelles avec leurs valeurs réelles — complémentaire à `pg_stat_statements` qui normalise les paramètres.
5. `pg_stat_user_tables` : `dead_pct > 10 %` = surveiller, `> 20 %` = VACUUM manuel + investigation dans `pg_stat_activity`.
6. `pg_stat_database` : `cache_hit_pct` doit dépasser 99 % ; en dessous, augmenter `shared_buffers` (cible 25 % de la RAM).
7. `pg_stat_statements` est cumulatif : lancer `pg_stat_statements_reset()` après un déploiement pour mesurer uniquement le nouveau code.
8. `postgres_exporter` + Prometheus transforme ces instantanés en séries temporelles — condition nécessaire pour l'alerting sur `mean_exec_time`, `dead_pct` et `idle in transaction`.

## 7. Seeds Anki

```
Quelle vue PostgreSQL montre les sessions actives en temps réel ?|pg_stat_activity — filtrer state = 'active' et pid != pg_backend_pid() pour exclure la session courante
Pourquoi idle in transaction bloque VACUUM même sur les tables non touchées ?|La session maintient un xact_start ancien : VACUUM ne peut pas libérer les tuples morts antérieurs à ce snapshot dans toutes les tables du serveur
Comment identifier la requête la plus coûteuse en temps total ?|SELECT LEFT(query,80), calls, ROUND(total_exec_time::numeric,0) FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10
Quelle est la cible de cache_hit_ratio dans pg_stat_database ?|> 99 % — en dessous augmenter shared_buffers (cible 25 % de la RAM) ; < 95 % est critique
Comment détecter le bloat sur les tables TribuZen ?|SELECT relname, n_dead_tup, ROUND(100.0*n_dead_tup/NULLIF(n_live_tup+n_dead_tup,0),1) AS dead_pct FROM pg_stat_user_tables ORDER BY n_dead_tup DESC
Workflow complet de diagnostic d'une requête lente en production ?|pg_stat_statements (top total_exec_time) → EXPLAIN ANALYZE BUFFERS (nœud lent) → fix (index/réécriture) → re-mesurer dans pg_stat_statements
pg_stat_statements montre-t-il les valeurs SQL exactes ?|Non — les littéraux sont normalisés en $1, $2… Combiner avec log_min_duration_statement pour capturer les valeurs réelles par exécution
Que fait pg_stat_statements_reset() ?|Remet à zéro tous les compteurs cumulatifs — lancer après un déploiement pour mesurer uniquement le nouveau code
Comment configurer PostgreSQL pour loguer les requêtes lentes ?|log_min_duration_statement = 200 dans postgresql.conf — loguer toute requête > 200 ms avec timestamp, PID, user, database et texte de la requête
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-17-monitoring/`. Tu actives `pg_stat_statements` sur une base TribuZen de test, identifies la requête feed la plus coûteuse, corriges avec l'index composite, surveilles le bloat sur `posts` après une série d'UPDATEs, et détectes une session `idle in transaction` simulée. Corrigé SQL inline dans le README, aucun fichier séparé.
