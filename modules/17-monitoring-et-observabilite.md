# Module 17 — Monitoring & Observabilite

> **Objectif** : Maitriser les outils de monitoring internes et externes de PostgreSQL — vues pg_stat_*, analyse de locks, logs, Prometheus/Grafana — pour diagnostiquer les problemes avant qu'ils ne deviennent des incidents.
>
> **Difficulte** : ⭐⭐⭐⭐

---

## 1. Pourquoi le monitoring

Imaginez que vous conduisez une voiture sans tableau de bord. Pas de compteur de vitesse, pas de jauge d'essence, pas de temoin moteur. Vous roulez a l'aveugle jusqu'a la panne. La plupart des equipes font exactement cela avec leur base de donnees.

> **Analogie** : Le monitoring PostgreSQL, c'est le tableau de bord de votre voiture. Le tachymetre, c'est le nombre de transactions par seconde. La jauge d'essence, c'est l'espace disque. Le temoin de temperature, c'est le CPU. Le temoin d'huile, c'est le ratio de cache hit. Et le voyant moteur ? C'est une alerte sur les deadlocks ou les requetes de plus de 5 minutes.

```
┌──────────────────────────────────────────────────────────────┐
│          LE TABLEAU DE BORD POSTGRESQL                        │
│                                                               │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐          │
│  │ TPS  │  │ Cache│  │ Conn │  │ Disk │  │ Lag  │          │
│  │ 1.2k │  │99.2% │  │47/100│  │ 62%  │  │ 0.1s │          │
│  │  OK   │  │  OK   │  │ WARN │  │  OK   │  │  OK   │          │
│  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘          │
│                                                               │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐          │
│  │ Dead │  │Locks │  │ Slow │  │ Temp │  │ WAL  │          │
│  │Tuples│  │  2   │  │Queries│  │Files │  │/sec  │          │
│  │  5%  │  │  OK   │  │  3   │  │  0   │  │ 8MB  │          │
│  │  OK   │  │  OK   │  │ WARN │  │  OK   │  │  OK   │          │
│  └──────┘  └──────┘  └──────┘  └──────┘  └──────┘          │
└──────────────────────────────────────────────────────────────┘
```

### Les trois piliers de l'observabilite

| Pilier | Description | Outils PostgreSQL |
|--------|-------------|-------------------|
| **Metriques** | Valeurs numeriques dans le temps (TPS, latence, cache) | pg_stat_*, Prometheus |
| **Logs** | Evenements textuels horodates (erreurs, slow queries) | postgresql.log, pgBadger |
| **Traces** | Suivi d'une requete de bout en bout | EXPLAIN ANALYZE, auto_explain |

---

## 2. Les vues pg_stat_* en profondeur

PostgreSQL expose des dizaines de vues systeme qui fournissent des metriques en temps reel. Ce sont vos capteurs.

### 2.1 pg_stat_activity — anatomie complete

`pg_stat_activity` est la vue la plus utilisee. Elle montre **toutes les sessions actives** et ce qu'elles font en ce moment.

```sql
-- Anatomie complete d'une ligne de pg_stat_activity
SELECT
    pid,                    -- PID du processus backend
    datname,                -- Base de donnees
    usename,                -- Utilisateur
    application_name,       -- Nom de l'application (configurable)
    client_addr,            -- Adresse IP du client
    client_port,            -- Port du client
    backend_start,          -- Quand la session a demarre
    xact_start,             -- Quand la transaction a demarre
    query_start,            -- Quand la requete courante a demarre
    state_change,           -- Quand l'etat a change
    wait_event_type,        -- Type d'attente (Lock, IO, LWLock...)
    wait_event,             -- Evenement d'attente specifique
    state,                  -- Etat de la session
    backend_type,           -- Type de backend
    query                   -- Texte de la requete
FROM pg_stat_activity;
```

Les etats possibles :

```
┌──────────────────────┬──────────────────────────────────────────┐
│ State                │ Signification                            │
├──────────────────────┼──────────────────────────────────────────┤
│ active               │ Execute une requete en ce moment         │
│ idle                 │ Connecte, attend une commande            │
│ idle in transaction  │ Dans une transaction ouverte, rien ne    │
│                      │ s'execute (DANGER si prolonge !)         │
│ idle in transaction  │ Idem + la transaction a ete annulee      │
│   (aborted)          │ (ROLLBACK necessaire)                    │
│ fastpath function    │ Execute une fonction fast-path           │
│ disabled             │ track_activities = off                   │
└──────────────────────┴──────────────────────────────────────────┘
```

### 2.2 Requetes utiles sur pg_stat_activity

```sql
-- ============================================================
-- 1. Sessions actives (qui travaille en ce moment ?)
-- ============================================================
SELECT
    pid,
    usename,
    datname,
    state,
    now() - query_start AS query_duration,
    wait_event_type,
    wait_event,
    LEFT(query, 100) AS query_preview
FROM pg_stat_activity
WHERE state = 'active'
  AND pid != pg_backend_pid()  -- exclure cette requete
ORDER BY query_start;

-- ============================================================
-- 2. Requetes longues (> 1 minute)
-- ============================================================
SELECT
    pid,
    usename,
    now() - query_start AS duration,
    state,
    LEFT(query, 200) AS query
FROM pg_stat_activity
WHERE state = 'active'
  AND now() - query_start > interval '1 minute'
ORDER BY query_start;

-- ============================================================
-- 3. Sessions "idle in transaction" (les plus dangereuses)
-- ============================================================
SELECT
    pid,
    usename,
    now() - xact_start AS transaction_duration,
    now() - state_change AS idle_duration,
    LEFT(query, 200) AS last_query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND now() - xact_start > interval '5 minutes'
ORDER BY xact_start;
-- DANGER : ces sessions bloquent VACUUM et peuvent
-- accumuler des dead tuples

-- ============================================================
-- 4. Sessions bloquantes (qui bloque qui ?)
-- ============================================================
SELECT
    blocked.pid AS blocked_pid,
    blocked.usename AS blocked_user,
    LEFT(blocked.query, 100) AS blocked_query,
    blocking.pid AS blocking_pid,
    blocking.usename AS blocking_user,
    LEFT(blocking.query, 100) AS blocking_query,
    now() - blocked.query_start AS blocked_duration
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking
    ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE blocked.state = 'active'
ORDER BY blocked_duration DESC;

-- ============================================================
-- 5. Nombre de connexions par etat
-- ============================================================
SELECT
    state,
    count(*) AS count,
    round(100.0 * count(*) / sum(count(*)) OVER(), 1) AS pct
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY state
ORDER BY count DESC;
```

### 2.3 pg_stat_statements — top SQL

`pg_stat_statements` est l'extension la plus importante pour le monitoring. Elle enregistre des statistiques sur **chaque requete distincte** executee.

```sql
-- Prerequis : activer l'extension
-- postgresql.conf :
-- shared_preload_libraries = 'pg_stat_statements'
-- pg_stat_statements.max = 10000
-- pg_stat_statements.track = all

CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

```sql
-- ============================================================
-- Top 10 des requetes les plus couteuses en temps total
-- ============================================================
SELECT
    LEFT(query, 100) AS query,
    calls,
    round(total_exec_time::numeric, 2) AS total_time_ms,
    round(mean_exec_time::numeric, 2) AS mean_time_ms,
    round((100.0 * total_exec_time /
        nullif(sum(total_exec_time) OVER(), 0))::numeric, 2
    ) AS pct_total,
    rows,
    round(
        (shared_blks_hit::numeric /
         nullif(shared_blks_hit + shared_blks_read, 0)) * 100, 2
    ) AS cache_hit_pct
FROM pg_stat_statements
WHERE userid != (SELECT usesysid FROM pg_user WHERE usename = 'postgres')
ORDER BY total_exec_time DESC
LIMIT 10;

-- ============================================================
-- Top 10 requetes les plus frequentes (appels)
-- ============================================================
SELECT
    LEFT(query, 100) AS query,
    calls,
    round(mean_exec_time::numeric, 2) AS mean_time_ms,
    rows / nullif(calls, 0) AS rows_per_call
FROM pg_stat_statements
ORDER BY calls DESC
LIMIT 10;

-- ============================================================
-- Requetes avec le pire cache hit ratio (> 100 appels)
-- ============================================================
SELECT
    LEFT(query, 100) AS query,
    calls,
    shared_blks_hit,
    shared_blks_read,
    round(
        (shared_blks_hit::numeric /
         nullif(shared_blks_hit + shared_blks_read, 0)) * 100, 2
    ) AS hit_pct
FROM pg_stat_statements
WHERE calls > 100
  AND shared_blks_read > 0
ORDER BY hit_pct ASC
LIMIT 10;
```

```sql
-- Reinitialiser les statistiques (apres un deploiement par ex.)
SELECT pg_stat_statements_reset();
```

> **Piege classique** : Les valeurs de `pg_stat_statements` sont **cumulatives** depuis le dernier reset ou redemarrage. Pour obtenir des metriques par intervalle, il faut snapshotter regulierement et calculer les deltas. C'est exactement ce que font Prometheus + postgres_exporter.

### 2.4 pg_stat_user_tables

```sql
-- Sante des tables : ratio seq_scan vs idx_scan, dead tuples, vacuum
SELECT
    schemaname,
    relname AS table_name,
    seq_scan,
    idx_scan,
    CASE
        WHEN seq_scan + idx_scan = 0 THEN 'jamais lue'
        ELSE round(
            100.0 * idx_scan / (seq_scan + idx_scan), 1
        )::text || '%'
    END AS idx_scan_ratio,
    n_live_tup,
    n_dead_tup,
    CASE
        WHEN n_live_tup = 0 THEN '0%'
        ELSE round(
            100.0 * n_dead_tup / (n_live_tup + n_dead_tup), 1
        )::text || '%'
    END AS dead_ratio,
    last_autovacuum,
    last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 20;
```

| Metrique | Sain | Alerte |
|----------|------|--------|
| `idx_scan_ratio` | > 95% | < 80% (index manquant ?) |
| `dead_ratio` (dead / total) | < 5% | > 20% (vacuum bloque ?) |
| `last_autovacuum` | < 1 jour | > 7 jours |
| `seq_scan` sur grosse table | Rare | Frequent (index manquant) |

### 2.5 pg_stat_user_indexes

```sql
-- Detecter les index inutilises
SELECT
    schemaname,
    relname AS table_name,
    indexrelname AS index_name,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE idx_scan = 0                          -- jamais utilise
  AND indexrelname NOT LIKE '%_pkey'        -- garder les PK
  AND indexrelname NOT LIKE '%_unique%'     -- garder les contraintes uniques
ORDER BY pg_relation_size(indexrelid) DESC;

-- Un index inutilise :
-- - Consomme de l'espace disque
-- - Ralentit les INSERT/UPDATE/DELETE
-- - Doit etre supprime (apres verification !)
```

> **Piege classique** : Apres un redemarrage de PostgreSQL, les compteurs `idx_scan` sont remis a zero. Attendez au moins un cycle complet de votre application (1 semaine minimum, idealement 1 mois) avant de decider qu'un index est inutilise.

### 2.6 pg_stat_bgwriter

```sql
-- Monitoring de l'activite d'arriere-plan (checkpoints, buffers)
SELECT
    checkpoints_timed,          -- Checkpoints declenches par le timer
    checkpoints_req,            -- Checkpoints forces (par ex. pg_start_backup)
    CASE
        WHEN checkpoints_timed + checkpoints_req = 0 THEN '0%'
        ELSE round(
            100.0 * checkpoints_timed /
            (checkpoints_timed + checkpoints_req), 1
        )::text || '%'
    END AS timed_pct,           -- Devrait etre > 90%
    buffers_checkpoint,         -- Pages ecrites pendant les checkpoints
    buffers_backend,            -- Pages ecrites par les backends (MAUVAIS si eleve)
    buffers_alloc,              -- Nouvelles pages allouees
    pg_size_pretty(
        buffers_checkpoint * current_setting('block_size')::bigint
    ) AS checkpoint_write_total
FROM pg_stat_bgwriter;
```

```
┌──────────────────────────────────────────────────────────────┐
│  REGLE : checkpoints_timed >> checkpoints_req                 │
│                                                               │
│  Si checkpoints_req est eleve :                              │
│  → max_wal_size est trop petit                               │
│  → Les checkpoints sont forces trop souvent                  │
│  → Augmenter max_wal_size (ex: 2GB → 4GB)                   │
│                                                               │
│  Si buffers_backend est eleve :                              │
│  → Les backends doivent ecrire eux-memes sur disque          │
│  → shared_buffers est trop petit                             │
│  → Ou bgwriter est trop lent                                 │
└──────────────────────────────────────────────────────────────┘
```

### 2.7 pg_stat_wal (PostgreSQL 14+)

```sql
-- Volume de WAL genere
SELECT
    wal_records,
    wal_fpi,                -- Full-page images (apres un checkpoint)
    wal_bytes,
    pg_size_pretty(wal_bytes) AS wal_bytes_pretty,
    wal_write,              -- Nombre d'ecritures WAL
    wal_sync,               -- Nombre de syncs WAL
    stats_reset             -- Dernier reset des statistiques
FROM pg_stat_wal;
```

### 2.8 pg_stat_database

```sql
-- Vue d'ensemble par base de donnees
SELECT
    datname,
    numbackends AS connections,
    xact_commit AS commits,
    xact_rollback AS rollbacks,
    CASE
        WHEN xact_commit + xact_rollback = 0 THEN '0%'
        ELSE round(
            100.0 * xact_commit / (xact_commit + xact_rollback), 2
        )::text || '%'
    END AS commit_ratio,
    blks_hit,
    blks_read,
    CASE
        WHEN blks_hit + blks_read = 0 THEN '100%'
        ELSE round(
            100.0 * blks_hit / (blks_hit + blks_read), 2
        )::text || '%'
    END AS cache_hit_ratio,     -- Doit etre > 99%
    deadlocks,
    temp_files,
    pg_size_pretty(temp_bytes) AS temp_bytes,
    conflicts                    -- Conflits avec recovery (standby)
FROM pg_stat_database
WHERE datname = current_database();
```

| Metrique | Seuil sain | Action si depasse |
|----------|-----------|-------------------|
| `cache_hit_ratio` | > 99% | Augmenter `shared_buffers` |
| `commit_ratio` | > 95% | Investiguer les erreurs applicatives |
| `deadlocks` | 0 | Revoir l'ordre d'acces aux tables |
| `temp_files` | Rare | Augmenter `work_mem` |
| `conflicts` | 0 (sur standby) | Augmenter `max_standby_streaming_delay` |

---

## 3. pg_locks avance

### 3.1 Requete pour identifier les sessions bloquantes

```sql
-- Sessions bloquantes avec detail des locks
SELECT
    blocked_locks.pid AS blocked_pid,
    blocked_activity.usename AS blocked_user,
    blocked_activity.application_name AS blocked_app,
    blocked_locks.locktype AS blocked_locktype,
    blocked_locks.mode AS blocked_mode,
    blocking_locks.pid AS blocking_pid,
    blocking_activity.usename AS blocking_user,
    blocking_activity.application_name AS blocking_app,
    blocking_locks.mode AS blocking_mode,
    LEFT(blocked_activity.query, 150) AS blocked_query,
    LEFT(blocking_activity.query, 150) AS blocking_query,
    now() - blocked_activity.query_start AS blocked_duration
FROM pg_locks blocked_locks
JOIN pg_stat_activity blocked_activity
    ON blocked_activity.pid = blocked_locks.pid
JOIN pg_locks blocking_locks
    ON blocking_locks.locktype = blocked_locks.locktype
    AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
    AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
    AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
    AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
    AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
    AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
    AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
    AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
    AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
    AND blocking_locks.pid != blocked_locks.pid
JOIN pg_stat_activity blocking_activity
    ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted
ORDER BY blocked_duration DESC;
```

### 3.2 pg_blocking_pids()

```sql
-- Version simplifiee avec pg_blocking_pids() (PG 9.6+)
SELECT
    pid,
    usename,
    pg_blocking_pids(pid) AS blocked_by,
    LEFT(query, 100) AS query,
    now() - query_start AS waiting_since
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0
ORDER BY query_start;
```

### 3.3 Arbre des attentes (recursive CTE)

```sql
-- Arbre complet des attentes de locks (qui bloque qui, en cascade)
WITH RECURSIVE lock_tree AS (
    -- Racine : sessions qui bloquent d'autres sessions
    -- mais ne sont pas elles-memes bloquees
    SELECT
        pid,
        usename,
        LEFT(query, 80) AS query,
        state,
        0 AS depth,
        ARRAY[pid] AS path,
        pid::text AS tree
    FROM pg_stat_activity
    WHERE pid IN (
        SELECT unnest(pg_blocking_pids(pid))
        FROM pg_stat_activity
        WHERE cardinality(pg_blocking_pids(pid)) > 0
    )
    AND cardinality(pg_blocking_pids(pid)) = 0

    UNION ALL

    -- Recursion : sessions bloquees par les precedentes
    SELECT
        sa.pid,
        sa.usename,
        LEFT(sa.query, 80) AS query,
        sa.state,
        lt.depth + 1,
        lt.path || sa.pid,
        lt.tree || ' -> ' || sa.pid::text
    FROM pg_stat_activity sa
    JOIN lock_tree lt
        ON lt.pid = ANY(pg_blocking_pids(sa.pid))
    WHERE sa.pid != ALL(lt.path)  -- eviter les cycles
)
SELECT
    repeat('  ', depth) || '|- PID ' || pid AS tree_display,
    usename,
    state,
    query
FROM lock_tree
ORDER BY path;

-- Resultat exemple :
-- tree_display      | usename | state  | query
-- ──────────────────+─────────+────────+──────────────────────────
-- |- PID 1234       | admin   | active | ALTER TABLE orders ADD ...
--   |- PID 5678     | app     | active | UPDATE orders SET ...
--     |- PID 9012   | app     | active | SELECT * FROM orders ...
```

> **Piege classique** : Un `ALTER TABLE` prend un `ACCESS EXCLUSIVE` lock. Si une transaction longue tient un `ACCESS SHARE` lock (simple SELECT), l'`ALTER TABLE` attend. Et **toutes les requetes suivantes** attendent aussi derriere l'`ALTER TABLE`, meme les simples SELECTs ! C'est l'effet "cascade de locks".

---

## 4. Logs PostgreSQL

### 4.1 Configuration des logs

```
# postgresql.conf — configuration de logging

# ============================================================
# Slow queries
# ============================================================
log_min_duration_statement = 200   # Loguer les requetes > 200ms
# Ou : -1 = desactive, 0 = tout loguer

# ============================================================
# Locks
# ============================================================
log_lock_waits = on               # Loguer les attentes de lock
deadlock_timeout = 1s             # Temps avant de checker les deadlocks

# ============================================================
# Checkpoints
# ============================================================
log_checkpoints = on              # Loguer chaque checkpoint
                                  # (duree, buffers ecrits, distance)

# ============================================================
# Autovacuum
# ============================================================
log_autovacuum_min_duration = 0   # Loguer toutes les executions d'autovacuum
# Ou : 250 pour ne loguer que celles > 250ms

# ============================================================
# Connexions
# ============================================================
log_connections = on              # Loguer chaque connexion
log_disconnections = on           # Loguer chaque deconnexion

# ============================================================
# Format
# ============================================================
log_line_prefix = '%m [%p] %u@%d '
#                  │   │    │  └── base de donnees
#                  │   │    └── utilisateur
#                  │   └── PID
#                  └── timestamp avec millisecondes

# Sortie CSV pour analyse automatisee
log_destination = 'csvlog'
logging_collector = on
log_directory = 'log'
log_filename = 'postgresql-%Y-%m-%d.log'
log_rotation_age = 1d
log_rotation_size = 100MB
```

### 4.2 Exemples de log entries

```
# Slow query
2024-06-15 14:23:45.123 CEST [12345] app@mydb LOG:  duration: 3456.789 ms
    statement: SELECT * FROM orders o JOIN order_items oi ON o.id = oi.order_id
    WHERE o.created_at > '2024-01-01' ORDER BY o.total DESC

# Lock wait
2024-06-15 14:25:12.456 CEST [23456] app@mydb LOG:  process 23456 still waiting
    for ShareLock on transaction 987654 after 1000.234 ms

# Checkpoint
2024-06-15 15:00:00.789 CEST [1] LOG:  checkpoint complete:
    wrote 12345 buffers (75.2%); 0 WAL file(s) added, 2 removed, 3 recycled;
    write=29.876 s, sync=0.123 s, total=30.456 s;
    sync files=234, longest=0.045 s, average=0.001 s; distance=256789 kB,
    estimate=300000 kB

# Autovacuum
2024-06-15 15:05:23.012 CEST [34567] LOG:  automatic vacuum of table
    "mydb.public.orders": index scans: 1
    pages: 0 removed, 54321 remain, 0 skipped due to pins, 0 skipped frozen
    tuples: 98765 removed, 1234567 remain, 0 are dead but not yet removable
```

### 4.3 pgBadger pour l'analyse de logs

```bash
# Installation
# apt-get install pgbadger  (ou depuis CPAN/GitHub)

# Analyser les logs et generer un rapport HTML
pgbadger /var/log/postgresql/postgresql-2024-06-15.log \
    -o /var/www/html/pgbadger/report.html

# Avec des logs CSV
pgbadger --format csv /var/log/postgresql/postgresql-2024-06-15.csv \
    -o report.html

# Rapport incremental (pour cron quotidien)
pgbadger --incremental \
    /var/log/postgresql/postgresql-*.log \
    -O /var/www/html/pgbadger/
```

```
pgBadger genere un rapport avec :

┌──────────────────────────────────────────────────────────────┐
│  pgBadger Report — 2024-06-15                                 │
│                                                               │
│  ■ Vue globale                                               │
│    - Requetes totales : 2,456,789                            │
│    - Erreurs : 123 (0.005%)                                  │
│    - Slow queries : 456                                      │
│                                                               │
│  ■ Top slow queries (avec plan type et frequence)            │
│  ■ Requetes les plus frequentes                              │
│  ■ Distribution temporelle (graphiques)                      │
│  ■ Locks et deadlocks                                        │
│  ■ Connexions / deconnexions                                 │
│  ■ Checkpoints timeline                                      │
│  ■ Autovacuum activity                                       │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. Outils externes

### 5.1 Prometheus + postgres_exporter

```
Architecture Prometheus + Grafana :

  ┌──────────┐         ┌──────────────────┐
  │PostgreSQL│◄────────│postgres_exporter  │
  │          │  SQL    │ (port 9187)       │
  └──────────┘         └────────┬─────────┘
                                │ /metrics (HTTP)
                       ┌────────▼─────────┐
                       │   Prometheus      │
                       │   (scrape toutes  │
                       │    les N secondes)│
                       └────────┬─────────┘
                                │ PromQL
                       ┌────────▼─────────┐
                       │   Grafana         │
                       │   (dashboards)    │
                       └──────────────────┘
```

```yaml
# docker-compose.yml — stack de monitoring
version: '3.8'
services:
  postgres_exporter:
    image: quay.io/prometheuscommunity/postgres-exporter
    environment:
      DATA_SOURCE_NAME: "postgresql://monitor:secret@postgres:5432/mydb?sslmode=disable"
    ports:
      - "9187:9187"

  prometheus:
    image: prom/prometheus
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana
    ports:
      - "3000:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
```

```yaml
# prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'postgres'
    static_configs:
      - targets: ['postgres_exporter:9187']
```

### 5.2 Metriques cles a monitorer

| Metrique Prometheus | Description | Alerte si |
|---------------------|-------------|-----------|
| `pg_up` | PostgreSQL est accessible | = 0 |
| `pg_stat_activity_count` | Connexions actives par etat | `idle_in_transaction` > 5 |
| `pg_stat_database_xact_commit` | Commits/sec (delta) | Drop soudain |
| `pg_stat_database_blks_hit` / `_read` | Cache hit ratio | < 99% |
| `pg_stat_database_deadlocks` | Nombre de deadlocks (delta) | > 0/min |
| `pg_stat_user_tables_n_dead_tup` | Dead tuples | > 20% de n_live_tup |
| `pg_replication_lag` | Lag de replication en secondes | > 1s |
| `pg_stat_database_temp_files` | Fichiers temporaires (delta) | > 10/min |
| `pg_settings_max_connections` | max_connections | utilisation > 80% |

### 5.3 Grafana dashboards PostgreSQL

```
Dashboard Grafana recommande : ID 9628 (PostgreSQL Database)

  ┌──────────────────────────────────────────────────────────┐
  │  PostgreSQL Overview                            [24h ▼]  │
  │                                                          │
  │  TPS ████████████████████ 1,234/s                       │
  │  Active connections ████████░░░░ 47/100                 │
  │  Cache hit ratio 99.3%  ████████████████████████████    │
  │                                                          │
  │  ┌──────────────────┐  ┌──────────────────┐             │
  │  │ Transactions/sec │  │ Rows returned/s  │             │
  │  │    /\    /\      │  │      /\          │             │
  │  │   /  \  /  \     │  │  /\/  \/\        │             │
  │  │  /    \/    \    │  │ /        \       │             │
  │  └──────────────────┘  └──────────────────┘             │
  │                                                          │
  │  ┌──────────────────┐  ┌──────────────────┐             │
  │  │  Temp files       │  │  Dead tuples    │             │
  │  │  0 files          │  │  orders: 5.2%   │             │
  │  │  (OK)             │  │  users: 0.3%    │             │
  │  └──────────────────┘  └──────────────────┘             │
  └──────────────────────────────────────────────────────────┘
```

### 5.4 pgwatch2

pgwatch2 est une solution de monitoring tout-en-un pour PostgreSQL (collecte, stockage, dashboards).

```bash
# Demarrage rapide avec Docker
docker run -d --name pgwatch2 \
    -p 3000:3000 -p 8080:8080 \
    -e PW2_PG_HOST=my-postgres-host \
    -e PW2_PG_PORT=5432 \
    -e PW2_PG_DBNAME=mydb \
    -e PW2_PG_USER=monitor \
    -e PW2_PG_PASSWORD=secret \
    cybertec/pgwatch2-postgres
```

### 5.5 check_postgres (Nagios)

```bash
# Verifier la replication lag
check_postgres --action=hot_standby_delay \
    --host=replica1 --warning='1s' --critical='5s'

# Verifier l'espace disque de la base
check_postgres --action=database_size \
    --host=primary --warning='50GB' --critical='80GB'

# Verifier les connexions
check_postgres --action=backends \
    --host=primary --warning=80 --critical=95

# Verifier les locks
check_postgres --action=locks \
    --host=primary --warning=10 --critical=20
```

---

## 6. Alerting — quand declencher une alerte

### 6.1 Seuils recommandes

```
┌───────────────────────────────────────────────────────────────┐
│              MATRICE D'ALERTING                                │
│                                                                │
│  Metrique                    │ WARNING      │ CRITICAL         │
│  ────────────────────────────┼──────────────┼─────────────     │
│  Replication lag             │ > 1s         │ > 10s            │
│  Dead tuples ratio           │ > 10%        │ > 20%            │
│  Cache hit ratio             │ < 99%        │ < 95%            │
│  Long-running transactions   │ > 5 min      │ > 30 min         │
│  Connexions actives          │ > 80% max    │ > 95% max        │
│  Espace disque               │ > 80%        │ > 90%            │
│  idle in transaction         │ > 5 sessions │ > 10 sessions    │
│  Deadlocks / min             │ > 0          │ > 5              │
│  Temp files / min            │ > 5          │ > 50             │
│  WAL generation rate         │ > 100 MB/s   │ > 500 MB/s       │
│  Checkpoint duration         │ > 30s        │ > 120s           │
│  Replication slot inactive   │ > 1h         │ > 4h             │
└───────────────────────────────────────────────────────────────┘
```

### 6.2 Requetes d'alerte

```sql
-- ============================================================
-- ALERTE : Replication lag > 1 seconde
-- ============================================================
SELECT
    client_addr,
    replay_lag,
    CASE
        WHEN replay_lag > interval '10 seconds' THEN 'CRITICAL'
        WHEN replay_lag > interval '1 second' THEN 'WARNING'
        ELSE 'OK'
    END AS status
FROM pg_stat_replication;

-- ============================================================
-- ALERTE : Dead tuples ratio > 20%
-- ============================================================
SELECT
    schemaname || '.' || relname AS table_name,
    n_live_tup,
    n_dead_tup,
    round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
    last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 0
  AND round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) > 20
ORDER BY dead_pct DESC;

-- ============================================================
-- ALERTE : Cache hit ratio < 99%
-- ============================================================
SELECT
    datname,
    round(
        100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2
    ) AS cache_hit_ratio
FROM pg_stat_database
WHERE datname = current_database()
  AND round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) < 99;

-- ============================================================
-- ALERTE : Long-running transactions > 5 minutes
-- ============================================================
SELECT
    pid,
    usename,
    now() - xact_start AS transaction_duration,
    state,
    LEFT(query, 100) AS query
FROM pg_stat_activity
WHERE state IN ('active', 'idle in transaction')
  AND now() - xact_start > interval '5 minutes'
  AND pid != pg_backend_pid();

-- ============================================================
-- ALERTE : Connexions > 80% de max_connections
-- ============================================================
SELECT
    count(*) AS current_connections,
    current_setting('max_connections')::int AS max_connections,
    round(
        100.0 * count(*) / current_setting('max_connections')::int, 1
    ) AS usage_pct
FROM pg_stat_activity
HAVING round(
    100.0 * count(*) / current_setting('max_connections')::int, 1
) > 80;

-- ============================================================
-- ALERTE : Espace disque (taille des bases)
-- ============================================================
SELECT
    datname,
    pg_size_pretty(pg_database_size(datname)) AS size
FROM pg_database
WHERE datname NOT IN ('template0', 'template1')
ORDER BY pg_database_size(datname) DESC;
```

---

## 7. Diagnostic d'une slow query en production

### 7.1 Workflow complet

```
Workflow de diagnostic :

  ┌──────────────────────────┐
  │ 1. IDENTIFIER            │
  │    pg_stat_statements    │
  │    → Top queries par     │
  │      total_exec_time     │
  └──────────┬───────────────┘
             │
  ┌──────────▼───────────────┐
  │ 2. ANALYSER              │
  │    EXPLAIN (ANALYZE,     │
  │    BUFFERS, FORMAT TEXT)  │
  │    → Trouver le          │
  │      bottleneck          │
  └──────────┬───────────────┘
             │
  ┌──────────▼───────────────┐
  │ 3. OPTIMISER             │
  │    - Ajouter un index    │
  │    - Reecrire la requete │
  │    - Ajuster les params  │
  └──────────┬───────────────┘
             │
  ┌──────────▼───────────────┐
  │ 4. VERIFIER              │
  │    EXPLAIN ANALYZE apres │
  │    le fix                │
  │    → Confirmer           │
  │      l'amelioration      │
  └──────────┬───────────────┘
             │
  ┌──────────▼───────────────┐
  │ 5. MONITORER             │
  │    pg_stat_statements    │
  │    → Verifier que le     │
  │      total_exec_time     │
  │      a baisse            │
  └──────────────────────────┘
```

### 7.2 Exemple reel 1 : index manquant

```sql
-- Etape 1 : pg_stat_statements revele cette requete
-- total_exec_time: 450,000 ms, calls: 15,000, mean: 30 ms
SELECT o.*, u.name
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status = 'pending'
  AND o.created_at > now() - interval '7 days';

-- Etape 2 : EXPLAIN ANALYZE
EXPLAIN (ANALYZE, BUFFERS) SELECT o.*, u.name
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status = 'pending'
  AND o.created_at > now() - interval '7 days';

-- Resultat :
-- Nested Loop (cost=0.72..89234.56 rows=1234 width=89)
--             (actual time=0.123..28.456 rows=1200 loops=1)
--   -> Seq Scan on orders o         ← PROBLEME !
--        Filter: (status = 'pending' AND created_at > ...)
--        Rows Removed by Filter: 498800
--        Buffers: shared read=12345   ← beaucoup de lectures disque
--   -> Index Scan using users_pkey on users u
--        Buffers: shared hit=2400

-- Etape 3 : Creer un index composite
CREATE INDEX CONCURRENTLY idx_orders_status_created
    ON orders (status, created_at DESC);

-- Etape 4 : Re-verifier
EXPLAIN (ANALYZE, BUFFERS) SELECT o.*, u.name
FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.status = 'pending'
  AND o.created_at > now() - interval '7 days';

-- Resultat apres :
-- Nested Loop (cost=0.72..234.56 rows=1234 width=89)
--             (actual time=0.045..1.234 rows=1200 loops=1)
--   -> Index Scan using idx_orders_status_created on orders o
--        Index Cond: (status = 'pending' AND created_at > ...)
--        Buffers: shared hit=45       ← 12345 → 45 !
--   -> Index Scan using users_pkey on users u
--        Buffers: shared hit=2400

-- Amelioration : 28ms → 1.2ms (x23 plus rapide)
```

### 7.3 Exemple reel 2 : N+1 queries

```sql
-- pg_stat_statements revele :
-- query: SELECT * FROM order_items WHERE order_id = $1
-- calls: 150,000, total_exec_time: 75,000 ms

-- Le probleme : l'application fait 1 requete par order
-- pour recuperer les items (boucle N+1)

-- AVANT (dans l'application) :
-- for each order: SELECT * FROM order_items WHERE order_id = ?
-- → 10,000 requetes separees !

-- APRES : une seule requete
SELECT oi.*
FROM order_items oi
WHERE oi.order_id = ANY($1::int[]);
-- $1 = tableau de tous les order_ids
-- → 1 seule requete au lieu de 10,000
```

### 7.4 Exemple reel 3 : scan sequentiel sur une grosse table

```sql
-- pg_stat_statements :
-- query: SELECT count(*) FROM events WHERE tenant_id = $1 AND type = $2
-- calls: 50,000, mean_exec_time: 200 ms

-- EXPLAIN ANALYZE revele un Seq Scan sur 50M de lignes
-- car il n'y a pas d'index sur (tenant_id, type)

-- Fix : index partiel si certains types sont rares
CREATE INDEX CONCURRENTLY idx_events_tenant_type
    ON events (tenant_id, type)
    WHERE type IN ('error', 'warning');

-- Ou index complet si tous les types sont cherches
CREATE INDEX CONCURRENTLY idx_events_tenant_type_full
    ON events (tenant_id, type);
```

---

## 8. Health check queries (collection prete a l'emploi)

```sql
-- ============================================================
-- HEALTH CHECK COMPLET — a executer periodiquement
-- ============================================================

-- 1. Etat general
SELECT
    current_database() AS database,
    pg_postmaster_start_time() AS server_started,
    now() - pg_postmaster_start_time() AS uptime,
    current_setting('server_version') AS version;

-- 2. Connexions
SELECT
    count(*) FILTER (WHERE state = 'active') AS active,
    count(*) FILTER (WHERE state = 'idle') AS idle,
    count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_tx,
    count(*) AS total,
    current_setting('max_connections')::int AS max_conn,
    round(100.0 * count(*) /
        current_setting('max_connections')::int, 1) AS usage_pct
FROM pg_stat_activity
WHERE backend_type = 'client backend';

-- 3. Cache hit ratio
SELECT
    round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2)
        AS cache_hit_ratio
FROM pg_stat_database
WHERE datname = current_database();

-- 4. Taille de la base
SELECT
    pg_size_pretty(pg_database_size(current_database())) AS db_size;

-- 5. Tables les plus volumineuses
SELECT
    relname,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
    pg_size_pretty(pg_relation_size(relid)) AS table_size,
    pg_size_pretty(pg_indexes_size(relid)) AS indexes_size,
    n_live_tup AS live_rows,
    n_dead_tup AS dead_rows
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 10;

-- 6. Index inutilises (> 1MB, 0 scans)
SELECT
    relname AS table,
    indexrelname AS index,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size,
    idx_scan AS scans
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND pg_relation_size(indexrelid) > 1024 * 1024
ORDER BY pg_relation_size(indexrelid) DESC
LIMIT 10;

-- 7. Tables necessitant un VACUUM
SELECT
    relname,
    n_dead_tup,
    n_live_tup,
    round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1)
        AS dead_pct,
    last_autovacuum,
    last_autoanalyze
FROM pg_stat_user_tables
WHERE n_dead_tup > 1000
ORDER BY n_dead_tup DESC
LIMIT 10;

-- 8. Replication status (si applicable)
SELECT
    client_addr,
    state,
    sync_state,
    pg_size_pretty(
        pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)
    ) AS replay_lag,
    replay_lag AS lag_time
FROM pg_stat_replication;

-- 9. Locks actifs
SELECT
    count(*) FILTER (WHERE granted) AS granted_locks,
    count(*) FILTER (WHERE NOT granted) AS waiting_locks
FROM pg_locks
WHERE pid != pg_backend_pid();

-- 10. Requetes longues en cours
SELECT
    pid,
    now() - query_start AS duration,
    LEFT(query, 80) AS query
FROM pg_stat_activity
WHERE state = 'active'
  AND now() - query_start > interval '30 seconds'
  AND pid != pg_backend_pid()
ORDER BY query_start;
```

---

## 9. Node.js : monitoring des connexions et query timing

```typescript
// ============================================================
// Middleware de monitoring PostgreSQL pour Node.js
// ============================================================

import pg from 'pg';
import type { PoolClient, QueryResult } from 'pg';
import express from 'express';
import type { Request, Response } from 'express';
const { Pool } = pg;

// ────────────────────────────────────────────────────────────
// 1. Pool avec monitoring des connexions
// ────────────────────────────────────────────────────────────
const pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'mydb',
    user: 'app',
    password: 'secret',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

// Compteurs
interface DbMetrics {
    totalQueries: number;
    totalErrors: number;
    totalDuration: number;
    slowQueries: number;
    poolWaiting: number;
    poolActive: number;
    poolIdle: number;
}

const metrics: DbMetrics = {
    totalQueries: 0,
    totalErrors: 0,
    totalDuration: 0,
    slowQueries: 0,          // > 200ms
    poolWaiting: 0,
    poolActive: 0,
    poolIdle: 0,
};

// Evenements du pool
pool.on('connect', () => {
    console.log('Nouvelle connexion au pool');
});

pool.on('acquire', () => {
    metrics.poolActive++;
    metrics.poolIdle = pool.idleCount;
    metrics.poolWaiting = pool.waitingCount;
});

pool.on('release', () => {
    metrics.poolActive--;
    metrics.poolIdle = pool.idleCount;
});

pool.on('error', (err: Error) => {
    console.error('Erreur inattendue du pool :', err.message);
    metrics.totalErrors++;
});

// ────────────────────────────────────────────────────────────
// 2. Wrapper de query avec timing
// ────────────────────────────────────────────────────────────
const SLOW_QUERY_THRESHOLD_MS = 200;

async function monitoredQuery(sql: string, params: unknown[], label: string = 'query'): Promise<QueryResult> {
    const start: bigint = process.hrtime.bigint();
    try {
        const result: QueryResult = await pool.query(sql, params);
        const durationMs: number = Number(
            (process.hrtime.bigint() - start) / 1_000_000n
        );

        metrics.totalQueries++;
        metrics.totalDuration += durationMs;

        if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
            metrics.slowQueries++;
            console.warn(
                `[SLOW QUERY] ${label} — ${durationMs}ms — ` +
                `${sql.substring(0, 100)}`
            );
        }

        return result;
    } catch (err) {
        const durationMs: number = Number(
            (process.hrtime.bigint() - start) / 1_000_000n
        );
        metrics.totalErrors++;
        console.error(
            `[QUERY ERROR] ${label} — ${durationMs}ms — ` +
            `${(err as Error).message} — ${sql.substring(0, 100)}`
        );
        throw err;
    }
}

// ────────────────────────────────────────────────────────────
// 3. Endpoint de metriques (Express)
// ────────────────────────────────────────────────────────────
const app = express();

app.get('/metrics/db', (_req: Request, res: Response) => {
    res.json({
        pool: {
            total: pool.totalCount,
            idle: pool.idleCount,
            waiting: pool.waitingCount,
            active: pool.totalCount - pool.idleCount,
        },
        queries: {
            total: metrics.totalQueries,
            errors: metrics.totalErrors,
            slow: metrics.slowQueries,
            avgDurationMs: metrics.totalQueries > 0
                ? Math.round(metrics.totalDuration / metrics.totalQueries)
                : 0,
        },
    });
});

// ────────────────────────────────────────────────────────────
// 4. Health check endpoint
// ────────────────────────────────────────────────────────────
interface ConnRow { current: string; max: string; }
interface CacheRow { hit_ratio: string; }

app.get('/health/db', async (_req: Request, res: Response) => {
    const start: number = Date.now();
    try {
        // Verifier la connexion
        const { rows: ping } = await pool.query('SELECT 1 AS ok');

        // Verifier le nombre de connexions
        const { rows: conn } = await pool.query<ConnRow>(`
            SELECT
                count(*) AS current,
                current_setting('max_connections')::int AS max
            FROM pg_stat_activity
        `);

        // Verifier le cache hit ratio
        const { rows: cache } = await pool.query<CacheRow>(`
            SELECT
                round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2)
                    AS hit_ratio
            FROM pg_stat_database
            WHERE datname = current_database()
        `);

        const durationMs: number = Date.now() - start;
        const connectionUsage: string = (
            100 * parseInt(conn[0].current) / parseInt(conn[0].max)
        ).toFixed(1);

        const status: string =
            durationMs > 1000 || parseFloat(connectionUsage) > 90
                ? 'degraded'
                : 'healthy';

        res.status(status === 'healthy' ? 200 : 503).json({
            status,
            responseTimeMs: durationMs,
            connections: {
                current: parseInt(conn[0].current),
                max: parseInt(conn[0].max),
                usagePct: parseFloat(connectionUsage),
            },
            cacheHitRatio: parseFloat(cache[0].hit_ratio),
            pool: {
                total: pool.totalCount,
                idle: pool.idleCount,
                waiting: pool.waitingCount,
            },
        });
    } catch (err) {
        res.status(503).json({
            status: 'unhealthy',
            error: (err as Error).message,
            responseTimeMs: Date.now() - start,
        });
    }
});

// ────────────────────────────────────────────────────────────
// 5. Surveillance periodique automatique
// ────────────────────────────────────────────────────────────
async function periodicHealthCheck(): Promise<void> {
    try {
        // Requetes longues
        const { rows: longQueries } = await pool.query(`
            SELECT pid, now() - query_start AS duration,
                   LEFT(query, 100) AS query
            FROM pg_stat_activity
            WHERE state = 'active'
              AND now() - query_start > interval '2 minutes'
              AND pid != pg_backend_pid()
        `);

        if (longQueries.length > 0) {
            console.warn(
                `[ALERT] ${longQueries.length} requete(s) longue(s) :`,
                longQueries
            );
        }

        // Idle in transaction
        const { rows: idleTx } = await pool.query(`
            SELECT pid, now() - xact_start AS duration,
                   LEFT(query, 100) AS last_query
            FROM pg_stat_activity
            WHERE state = 'idle in transaction'
              AND now() - xact_start > interval '5 minutes'
        `);

        if (idleTx.length > 0) {
            console.warn(
                `[ALERT] ${idleTx.length} session(s) idle in transaction :`,
                idleTx
            );
        }

        // Pool health
        if (pool.waitingCount > 5) {
            console.warn(
                `[ALERT] ${pool.waitingCount} clients en attente de connexion`
            );
        }
    } catch (err) {
        console.error('[HEALTH CHECK ERROR]', (err as Error).message);
    }
}

// Executer toutes les 30 secondes
setInterval(periodicHealthCheck, 30_000);

// ────────────────────────────────────────────────────────────
// Utilisation dans l'application
// ────────────────────────────────────────────────────────────
app.get('/api/users', async (_req: Request, res: Response) => {
    try {
        const result: QueryResult = await monitoredQuery(
            'SELECT id, name, email FROM users WHERE active = true',
            [],
            'get-active-users'
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.listen(3000, () => {
    console.log('Server running on port 3000');
});
```

---

## 10. Exercice mental

> **Exercice mental 1** : Votre `cache_hit_ratio` est de 94%. Votre serveur a 8 GB de RAM et `shared_buffers = 256MB`. Votre base de donnees fait 20 GB. Que recommandez-vous ?

<details>
<summary>Reponse</summary>

`shared_buffers = 256MB` est bien trop petit pour une base de 20 GB sur un serveur de 8 GB de RAM. La recommandation standard est **25% de la RAM** soit **2 GB**.

Actions :
1. Augmenter `shared_buffers` a `2GB`
2. Ajuster `effective_cache_size` a `6GB` (75% de la RAM)
3. Redemarrer PostgreSQL (shared_buffers necessite un redemarrage)
4. Monitorer : le cache_hit_ratio devrait monter au-dessus de 99%

Si la base fait 20 GB et que la RAM ne fait que 8 GB, toute la base ne tiendra pas en cache. Il faudra aussi verifier que les index les plus utilises tiennent dans shared_buffers, et eventuellement ajouter de la RAM.
</details>

> **Exercice mental 2** : `pg_stat_user_tables` montre que la table `events` a 2 millions de `n_dead_tup` et que `last_autovacuum` est NULL. Que se passe-t-il ?

<details>
<summary>Reponse</summary>

L'autovacuum ne s'est **jamais execute** sur cette table. Causes possibles :

1. **autovacuum = off** : verifie avec `SHOW autovacuum;`
2. **Le seuil n'est pas atteint** : `autovacuum_vacuum_threshold` (defaut 50) + `autovacuum_vacuum_scale_factor` (defaut 0.2) * n_live_tup. Si la table a 100M de lignes, le seuil est 20M de dead tuples — 2M ne suffit pas.
3. **Une transaction longue bloque VACUUM** : verifier `pg_stat_activity` pour des transactions `idle in transaction` depuis longtemps.
4. **L'autovacuum est sature** : `autovacuum_max_workers` (defaut 3) sont tous occupes sur d'autres tables.

Solution immediate : `VACUUM ANALYZE events;` manuellement. Puis ajuster les parametres de l'autovacuum pour cette table specifique :

```sql
ALTER TABLE events SET (
    autovacuum_vacuum_scale_factor = 0.01,
    autovacuum_vacuum_threshold = 1000
);
```
</details>

> **Exercice mental 3** : Votre application signale des timeouts intermittents. `pg_stat_activity` montre 95 connexions sur un `max_connections = 100`. La plupart sont `idle`. Quel est le probleme et la solution ?

<details>
<summary>Reponse</summary>

Le probleme est un **epuisement du pool de connexions**. 95 connexions ouvertes dont la plupart sont idle signifie que l'application ouvre des connexions mais ne les referme pas (ou les garde trop longtemps).

Solutions :
1. **Utiliser un connection pooler** (PgBouncer) en amont de PostgreSQL avec un mode `transaction` : chaque connexion applicative est multiplexee.
2. **Reduire `max` dans le pool Node.js** : si 5 serveurs ont chacun un pool de `max=20`, ca fait 100 connexions.
3. **Identifier les connexions idle longues** et ajouter un `idle_timeout` dans le pool applicatif.
4. **Configurer `idle_in_transaction_session_timeout`** pour tuer automatiquement les sessions idle in transaction.

```sql
-- Tuer les sessions idle depuis plus de 10 minutes
ALTER SYSTEM SET idle_session_timeout = '10min';  -- PG14+
SELECT pg_reload_conf();
```
</details>

---

## Ce qu'il faut retenir

```
┌──────────────────────────────────────────────────────────────┐
│                    A RETENIR                                  │
│                                                               │
│  1. pg_stat_activity = qui fait quoi en ce moment            │
│     Surveiller les idle in transaction et les requetes       │
│     longues.                                                 │
│                                                               │
│  2. pg_stat_statements = le top SQL historique                │
│     Identifier les requetes les plus couteuses.              │
│                                                               │
│  3. Cache hit ratio > 99% ou ajuster shared_buffers          │
│                                                               │
│  4. Dead tuples ratio < 10% ou investiguer l'autovacuum      │
│                                                               │
│  5. log_min_duration_statement = votre filet de securite     │
│     pour attraper les slow queries.                          │
│                                                               │
│  6. Prometheus + Grafana = la stack standard pour les        │
│     metriques en continu.                                    │
│                                                               │
│  7. Diagnostic : pg_stat_statements → EXPLAIN ANALYZE        │
│     → index/rewrite → re-mesurer.                            │
│                                                               │
│  8. Monitorer le pool de connexions Node.js est aussi        │
│     important que monitorer PostgreSQL.                       │
└──────────────────────────────────────────────────────────────┘
```

---

## Navigation

| Precedent | Suivant |
|---|---|
| [Module 16 — Replication](./16-replication.md) | [Module 18 — Partitioning & Scaling](./18-partitioning-et-scaling.md) |

---

> *"On ne peut pas optimiser ce qu'on ne mesure pas. Le monitoring n'est pas un luxe d'operations, c'est une competence de developpeur."*
