# Screencast 17 — Monitoring et Observabilité PostgreSQL

## Informations
- **Durée estimée** : 20-22 min
- **Module** : `modules/17-monitoring-et-observabilite.md`
- **Lab associé** : `labs/lab-17-monitoring/`
- **Prérequis** : Modules 1-16 terminés, PostgreSQL running, base `course_db`

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] **Deux terminaux** ouverts dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] `psql` connecté à `course_db`
- [ ] Node.js prêt pour les scripts
- [ ] Extension pg_stat_statements chargée (optionnel mais recommandé)

## Script

### [00:00-03:30] pg_stat_activity — sessions en direct

> Bienvenue dans le module monitoring. Savoir diagnostiquer les problèmes de performance est aussi important que savoir écrire du SQL performant. PostgreSQL fournit un ensemble de vues statistiques `pg_stat_*` qui sont votre tableau de bord en production.

**Action** : Ouvrir psql et interroger pg_stat_activity.

```sql
-- Voir toutes les sessions sur la base courante
SELECT
    pid,
    usename,
    application_name,
    client_addr,
    state,
    wait_event_type,
    wait_event,
    left(query, 60) AS query_preview,
    now() - query_start AS query_duration,
    now() - xact_start AS xact_duration
FROM pg_stat_activity
WHERE datname = current_database()
ORDER BY query_start ASC NULLS LAST;
```

> `pg_stat_activity` est la première vue à consulter en cas de problème. Elle montre toutes les sessions connectées : qui est connecté, dans quel état (active, idle, idle in transaction), quelle requête est en cours, et depuis combien de temps.

**Action** : Expliquer les colonnes clés et les états possibles.

```sql
-- Compter les sessions par état
SELECT state, count(*) AS sessions
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state
ORDER BY sessions DESC;

-- Attention aux sessions "idle in transaction"
-- Elles maintiennent des verrous et empêchent le VACUUM
SELECT pid, now() - xact_start AS idle_duration, query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND now() - xact_start > INTERVAL '5 minutes';
```

> Les sessions `idle in transaction` sont un problème courant : elles bloquent le VACUUM et peuvent causer du bloat. Le paramètre `idle_in_transaction_session_timeout` permet de les tuer automatiquement.

### [03:30-07:00] pg_stat_statements — top requêtes

> `pg_stat_statements` est l'outil numéro un pour identifier les requêtes les plus coûteuses en production.

**Action** : Activer et interroger pg_stat_statements.

```sql
-- Vérifier si l'extension est disponible
SELECT * FROM pg_available_extensions WHERE name = 'pg_stat_statements';

-- Activer l'extension
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Top 10 requêtes par temps total
SELECT
    left(query, 80) AS query,
    calls,
    round(total_exec_time::numeric, 2) AS total_ms,
    round(mean_exec_time::numeric, 2) AS mean_ms,
    rows,
    round((100 * total_exec_time / sum(total_exec_time) OVER ())::numeric, 2) AS pct_time
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY total_exec_time DESC
LIMIT 10;
```

> On voit les requêtes normalisées (les valeurs sont remplacées par $1, $2...) avec le nombre d'appels, le temps total et moyen, et le pourcentage du temps global. La colonne `pct_time` montre l'impact relatif de chaque requête.

**Action** : Identifier la requête la plus coûteuse et proposer une optimisation.

```sql
-- Top requêtes par nombre d'appels (requêtes les plus fréquentes)
SELECT
    left(query, 80) AS query,
    calls,
    rows,
    round(mean_exec_time::numeric, 2) AS mean_ms
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY calls DESC
LIMIT 5;

-- Reset des stats (à faire avec précaution en production)
-- SELECT pg_stat_statements_reset();
```

### [07:00-10:30] Cache hit ratio et stats de base

> Le cache hit ratio est LA métrique de santé numéro un d'une base PostgreSQL.

**Action** : Calculer le cache hit ratio.

```sql
-- Cache hit ratio global de la base
SELECT
    datname,
    blks_hit,
    blks_read,
    CASE WHEN (blks_hit + blks_read) > 0
        THEN round(100.0 * blks_hit / (blks_hit + blks_read), 2)
        ELSE 0
    END AS cache_hit_ratio
FROM pg_stat_database
WHERE datname = current_database();
```

> Un cache hit ratio > 99% est excellent. Entre 95% et 99% c'est acceptable. En dessous de 90%, il faut augmenter `shared_buffers` ou analyser les requêtes qui balaient trop de données.

**Action** : Montrer le ratio et expliquer les seuils.

```sql
-- Stats par table : seq_scan vs idx_scan
SELECT
    relname,
    seq_scan,
    seq_tup_read,
    idx_scan,
    idx_tup_fetch,
    CASE WHEN (seq_scan + idx_scan) > 0
        THEN round(100.0 * idx_scan / (seq_scan + idx_scan), 1)
        ELSE 0
    END AS idx_scan_pct,
    n_live_tup,
    n_dead_tup
FROM pg_stat_user_tables
ORDER BY seq_scan DESC
LIMIT 10;
```

> Les tables avec beaucoup de seq_scan et peu d'idx_scan sont des candidates pour de nouveaux index. Attention : certaines petites tables sont normalement scannées séquentiellement — c'est plus efficace qu'un index pour les petites tables.

```sql
-- Index inutilisés (candidats à la suppression)
SELECT
    indexrelname,
    relname AS table_name,
    idx_scan,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND indexrelname NOT LIKE '%_pkey'
ORDER BY pg_relation_size(indexrelid) DESC;
```

> Les index avec `idx_scan = 0` ne sont jamais utilisés. Ils consomment de l'espace disque et ralentissent les écritures (chaque INSERT/UPDATE doit maintenir l'index). Avant de les supprimer, vérifiez que les stats n'ont pas été réinitialisées récemment.

### [10:30-14:00] Diagnostic des slow queries

> Passons au workflow complet de diagnostic d'une requête lente.

**Action** : Créer une table de test et lancer une requête lente.

```sql
-- Créer une table avec des données
CREATE TABLE mon_demo (
    id SERIAL PRIMARY KEY,
    category TEXT,
    value NUMERIC,
    created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO mon_demo (category, value)
SELECT
    'cat_' || (i % 20),
    random() * 1000
FROM generate_series(1, 100000) AS i;

-- Pas d'index sur category → seq scan lent
EXPLAIN ANALYZE
SELECT category, avg(value), count(*)
FROM mon_demo
WHERE category = 'cat_5'
GROUP BY category;
```

> Sans index, PostgreSQL fait un Seq Scan sur 100K lignes pour en trouver ~5000. Ajoutons un index et comparons.

**Action** : Ajouter un index et refaire le EXPLAIN ANALYZE.

```sql
CREATE INDEX idx_mon_demo_cat ON mon_demo (category);
ANALYZE mon_demo;

EXPLAIN ANALYZE
SELECT category, avg(value), count(*)
FROM mon_demo
WHERE category = 'cat_5'
GROUP BY category;

-- Nettoyage
DROP TABLE mon_demo;
```

> Le temps d'exécution devrait baisser significativement. En production, ce workflow est : (1) identifier la requête lente via pg_stat_statements, (2) EXPLAIN ANALYZE pour comprendre le plan, (3) optimiser (index, réécriture, stats).

### [14:00-17:30] Dead tuples et VACUUM

> Les dead tuples sont un concept fondamental de MVCC. Quand vous faites un UPDATE ou DELETE, l'ancienne version du tuple reste sur le disque. VACUUM les nettoie.

**Action** : Démontrer le cycle dead tuples → VACUUM.

```sql
-- Créer une table de démo
CREATE TABLE vacuum_demo (
    id SERIAL PRIMARY KEY,
    data TEXT
);

INSERT INTO vacuum_demo (data)
SELECT 'Ligne ' || i FROM generate_series(1, 10000) AS i;

-- Mettre à jour toutes les lignes → 10000 dead tuples
UPDATE vacuum_demo SET data = 'Modifiee ' || id;

-- Vérifier les dead tuples
SELECT
    relname,
    n_live_tup,
    n_dead_tup,
    last_vacuum,
    last_autovacuum,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
WHERE relname = 'vacuum_demo';
```

> 10000 dead tuples ! La table prend environ le double d'espace qu'elle devrait. En production, l'autovacuum s'en occupe automatiquement, mais vérifions.

**Action** : Exécuter VACUUM et montrer la différence.

```sql
-- VACUUM nettoie les dead tuples
VACUUM VERBOSE vacuum_demo;

-- Re-vérifier
SELECT
    relname,
    n_live_tup,
    n_dead_tup,
    last_vacuum,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size
FROM pg_stat_user_tables
WHERE relname = 'vacuum_demo';

-- L'espace n'est pas rendu à l'OS (seulement réutilisable)
-- Pour vraiment compacter : VACUUM FULL (mais ça verrouille la table !)
-- VACUUM FULL vacuum_demo;

-- Nettoyage
DROP TABLE vacuum_demo;
```

> VACUUM marque l'espace comme réutilisable mais ne le rend pas à l'OS. VACUUM FULL compacte vraiment la table mais prend un ACCESS EXCLUSIVE lock — à éviter en production sauf maintenance planifiée.

### [17:30-20:00] Health check dashboard

> Combinons tout dans une fonction de health check réutilisable.

**Action** : Créer et exécuter la fonction health_check.

```sql
CREATE OR REPLACE FUNCTION health_check() RETURNS JSONB AS $$
DECLARE
    result JSONB;
    v_active INT;
    v_cache NUMERIC;
    v_dead BIGINT;
    v_size TEXT;
    v_uptime INTERVAL;
    v_longest NUMERIC;
BEGIN
    SELECT count(*) INTO v_active FROM pg_stat_activity
    WHERE datname = current_database() AND state = 'active';

    SELECT CASE WHEN (blks_hit + blks_read) > 0
        THEN round(100.0 * blks_hit / (blks_hit + blks_read), 2)
        ELSE 0 END INTO v_cache
    FROM pg_stat_database WHERE datname = current_database();

    SELECT coalesce(sum(n_dead_tup), 0) INTO v_dead
    FROM pg_stat_user_tables;

    SELECT pg_size_pretty(pg_database_size(current_database())) INTO v_size;
    SELECT now() - pg_postmaster_start_time() INTO v_uptime;
    SELECT coalesce(extract(epoch FROM max(now() - query_start)), 0)
    INTO v_longest FROM pg_stat_activity
    WHERE state = 'active' AND query NOT LIKE '%health_check%';

    RETURN jsonb_build_object(
        'active_connections', v_active,
        'cache_hit_ratio', v_cache,
        'total_dead_tuples', v_dead,
        'database_size', v_size,
        'uptime', v_uptime::text,
        'longest_running_query_seconds', round(v_longest, 2)
    );
END;
$$ LANGUAGE plpgsql;

-- Appeler le health check
SELECT jsonb_pretty(health_check());
```

> Cette fonction retourne un JSON avec les métriques clés. En production, vous pouvez l'appeler depuis un outil de monitoring (Prometheus, Datadog, Grafana) pour construire un dashboard.

**Action** : Montrer le JSON formaté et expliquer chaque métrique.

```sql
-- Nettoyage
DROP FUNCTION health_check();
```

### [20:00-22:00] Démo Lab-17 et récapitulatif

> Le lab 17 vous fait pratiquer tous ces concepts en 10 exercices progressifs.

**Action** : Ouvrir le lab et parcourir la structure.

```bash
ls labs/lab-17-monitoring/
# README.md  exercise.js  solution.js
```

> Pour résumer : `pg_stat_activity` pour les sessions, `pg_stat_statements` pour les top queries, le cache hit ratio pour la santé globale, les dead tuples pour le VACUUM, et `pg_blocking_pids()` pour les blocages. Le monitoring n'est pas optionnel — c'est la base d'une exploitation sereine de PostgreSQL.

**Action** : Afficher un résumé des vues et métriques clés.

```sql
-- Aide-mémoire monitoring :
-- pg_stat_activity      → sessions en cours
-- pg_stat_statements    → top requêtes (extension)
-- pg_stat_user_tables   → stats par table (seq_scan, dead tuples)
-- pg_stat_user_indexes  → usage des index
-- pg_stat_database      → cache hit ratio
-- pg_stat_bgwriter      → checkpoints
-- pg_blocking_pids()    → détection de blocages
```

## Points d'attention pour l'enregistrement
- Vérifier que pg_stat_statements est disponible avant la démo (shared_preload_libraries)
- Si pg_stat_statements n'est pas chargé, adapter la section avec pg_available_extensions
- La démo dead tuples doit être claire : UPDATE massif → vérifier n_dead_tup → VACUUM → re-vérifier
- La démo slow query avec deux terminaux doit être fluide
- Le health check JSON est le point culminant — le formater joliment avec jsonb_pretty
- Insister sur les seuils : cache hit > 99%, dead tuples faible, pas de idle in transaction longue
