# Screencast 11 — Performances et optimisation

## Informations
- **Durée estimée** : 22-25 min
- **Module** : `modules/11-performances-et-optimisation.md`
- **Lab associé** : `labs/lab-11-performances/`
- **Prérequis** : Modules 05-06 (index, query planner) terminés, PostgreSQL running, base `course_db`

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] Terminal ouvert dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] `psql` connecté à `course_db`
- [ ] Fichier CSV prêt pour la démo COPY

## Script

### [00:00-03:30] Connection pooling

> Ouvrir une connexion PostgreSQL coûte cher : authentification, allocation mémoire, fork d'un processus. En production, on ne crée pas une connexion par requête — on utilise un pool de connexions.

**Action** : Montrer le coût d'une connexion.

```sql
-- Voir les connexions actives
SELECT count(*) FROM pg_stat_activity;

-- Paramètres de connexion
SHOW max_connections;  -- Par défaut : 100
```

**Action** : Montrer le code Node.js avec et sans pool.

```javascript
// demo-pool.js
const { Pool, Client } = require('pg');

const config = {
  host: 'localhost', port: 5432,
  user: 'postgres', password: 'secret', database: 'course_db',
};

// MAUVAISE PRATIQUE : une nouvelle connexion par requête
async function withoutPool() {
  console.time('Sans pool (100 requêtes)');
  for (let i = 0; i < 100; i++) {
    const client = new Client(config);
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
  }
  console.timeEnd('Sans pool (100 requêtes)');
}

// BONNE PRATIQUE : réutiliser les connexions via un pool
async function withPool() {
  const pool = new Pool({ ...config, max: 10 });
  console.time('Avec pool (100 requêtes)');
  for (let i = 0; i < 100; i++) {
    await pool.query('SELECT 1');
  }
  console.timeEnd('Avec pool (100 requêtes)');
  await pool.end();
}

async function main() {
  await withoutPool();
  await withPool();
}

main();
```

**Action** : Exécuter le script et comparer les temps.

```bash
node demo-pool.js
# Sans pool (100 requêtes): ~2000ms
# Avec pool (100 requêtes): ~50ms
```

> La différence est massive. Le pool réutilise les connexions existantes au lieu d'en ouvrir une nouvelle à chaque requête. En production, on utilise souvent PgBouncer comme pool externe devant PostgreSQL.

**Action** : Montrer la différence de temps et souligner le ratio ~40x.

### [03:30-07:30] INSERT vs COPY — Benchmark

> Pour les insertions en masse, `INSERT` ligne par ligne est très lent. PostgreSQL offre `COPY`, qui est optimisé pour le chargement massif de données.

**Action** : Créer une table de test et comparer les méthodes.

```sql
-- Table pour le benchmark
CREATE TABLE bench_data (
    id      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    value   TEXT NOT NULL,
    score   NUMERIC(10, 2) NOT NULL,
    ts      TIMESTAMPTZ DEFAULT NOW()
);

-- Méthode 1 : INSERT ligne par ligne (lent)
\timing on

INSERT INTO bench_data (value, score)
SELECT 'item_' || i, (random() * 100)::numeric(10,2)
FROM generate_series(1, 100000) AS s(i);
-- Temps : ~1-3 secondes

TRUNCATE bench_data;

-- Méthode 2 : COPY depuis un fichier (rapide)
-- D'abord, générer un fichier CSV
\copy (SELECT 'item_' || i, round((random() * 100)::numeric, 2) FROM generate_series(1, 100000) AS s(i)) TO '/tmp/bench_data.csv' CSV

-- Charger avec COPY
\copy bench_data (value, score) FROM '/tmp/bench_data.csv' CSV
-- Temps : ~0.3-0.5 secondes

\timing off

-- Vérifier
SELECT COUNT(*) FROM bench_data;
```

> COPY est 3 à 10 fois plus rapide que INSERT pour les gros volumes. Il utilise un protocole binaire optimisé et évite le parsing SQL répétitif. Pour les imports quotidiens de données, c'est la solution.

**Action** : Comparer les temps d'insertion et les afficher côte à côte.

```sql
-- Astuce : désactiver les index et contraintes pendant un COPY massif
-- puis les recréer après (encore plus rapide pour les très gros volumes)
```

### [07:30-12:00] VACUUM et AUTOVACUUM

> Souvenez-vous du MVCC : quand on fait un UPDATE, PostgreSQL crée une nouvelle version de la ligne. L'ancienne version reste sur le disque — c'est un "tuple mort". VACUUM est le processus qui nettoie ces tuples morts.

**Action** : Montrer l'impact des tuples morts.

```sql
-- Créer une table et la mettre à jour massivement
CREATE TABLE vacuum_demo (
    id  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    val INTEGER NOT NULL
);

INSERT INTO vacuum_demo (val)
SELECT i FROM generate_series(1, 100000) AS s(i);

-- Taille initiale
SELECT pg_size_pretty(pg_total_relation_size('vacuum_demo')) AS size_before;

-- Mettre à jour toutes les lignes (crée 100k tuples morts)
UPDATE vacuum_demo SET val = val + 1;

-- Taille après UPDATE (a presque doublé !)
SELECT pg_size_pretty(pg_total_relation_size('vacuum_demo')) AS size_after;

-- Voir les tuples morts
SELECT
    relname,
    n_live_tup,
    n_dead_tup,
    last_vacuum,
    last_autovacuum
FROM pg_stat_user_tables
WHERE relname = 'vacuum_demo';
```

> On voit `n_dead_tup = 100000`. Ces tuples morts occupent de l'espace disque et ralentissent les scans.

**Action** : Pointer les statistiques n_live_tup et n_dead_tup.

```sql
-- Lancer VACUUM manuellement
VACUUM VERBOSE vacuum_demo;

-- Vérifier : les tuples morts sont nettoyés
SELECT
    relname,
    n_live_tup,
    n_dead_tup,
    last_vacuum
FROM pg_stat_user_tables
WHERE relname = 'vacuum_demo';

-- VACUUM FULL : compacte aussi la table (mais verrouille la table !)
-- À utiliser rarement, car bloquant
-- VACUUM FULL vacuum_demo;

-- Voir la configuration autovacuum
SHOW autovacuum;
SHOW autovacuum_vacuum_threshold;
SHOW autovacuum_vacuum_scale_factor;
```

> AUTOVACUUM se déclenche quand le nombre de tuples morts dépasse un seuil : `threshold + scale_factor * nb_tuples`. Par défaut, c'est 50 + 20% du nombre de lignes. PostgreSQL lance automatiquement VACUUM en arrière-plan.

**Action** : Montrer les paramètres autovacuum et expliquer le calcul du seuil.

### [12:00-14:30] Table bloat

> Si AUTOVACUUM ne suit pas le rythme des mises à jour, la table "gonfle" — c'est le table bloat. L'espace libéré par VACUUM peut être réutilisé pour de nouvelles insertions, mais il n'est pas rendu au système de fichiers.

**Action** : Diagnostiquer le bloat.

```sql
-- Estimation du bloat avec pgstattuple (extension)
CREATE EXTENSION IF NOT EXISTS pgstattuple;

SELECT * FROM pgstattuple('vacuum_demo');
-- dead_tuple_count, dead_tuple_len, free_space, free_percent

-- Rapport bloat simplifié
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS total_size,
    n_dead_tup,
    n_live_tup,
    CASE WHEN n_live_tup > 0
         THEN round(100.0 * n_dead_tup / n_live_tup, 1)
         ELSE 0
    END AS dead_pct
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC;
```

> Si `dead_pct` dépasse 20-30%, c'est le signe que l'autovacuum ne suit pas. Il faut alors ajuster ses paramètres ou lancer un VACUUM FULL (en maintenance).

**Action** : Montrer le rapport de bloat et commenter les valeurs.

### [14:30-17:30] Partitioning

> Le partitionnement divise une grande table en sous-tables plus petites. C'est essentiel pour les tables qui dépassent les dizaines de millions de lignes, surtout les time-series.

**Action** : Créer une table partitionnée.

```sql
-- Table partitionnée par range de dates
CREATE TABLE metrics (
    id          BIGINT GENERATED ALWAYS AS IDENTITY,
    sensor_id   INTEGER NOT NULL,
    value       NUMERIC(10, 4) NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (recorded_at);

-- Créer les partitions mensuelles
CREATE TABLE metrics_2025_01 PARTITION OF metrics
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
CREATE TABLE metrics_2025_02 PARTITION OF metrics
    FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');
CREATE TABLE metrics_2025_03 PARTITION OF metrics
    FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');
CREATE TABLE metrics_2025_04 PARTITION OF metrics
    FOR VALUES FROM ('2025-04-01') TO ('2025-05-01');

-- Insérer des données (PostgreSQL route automatiquement vers la bonne partition)
INSERT INTO metrics (sensor_id, value, recorded_at)
SELECT
    (random() * 100)::int + 1,
    (random() * 1000)::numeric(10,4),
    '2025-01-01'::timestamptz + (random() * 120)::int * INTERVAL '1 day'
FROM generate_series(1, 500000) AS s(i);

-- Vérifier le routage
SELECT
    tableoid::regclass AS partition,
    COUNT(*) AS nb_rows
FROM metrics
GROUP BY tableoid
ORDER BY partition;

-- Le planificateur élimine les partitions inutiles (partition pruning)
EXPLAIN ANALYZE
SELECT AVG(value) FROM metrics
WHERE recorded_at BETWEEN '2025-02-01' AND '2025-02-28';
-- Seule la partition metrics_2025_02 est scannée !
```

> Le partition pruning est la clé : si votre requête filtre sur `recorded_at`, PostgreSQL ne lit que les partitions pertinentes. Pour une table de 12 mois, ça divise le travail par 12.

**Action** : Montrer dans l'EXPLAIN ANALYZE que seule la partition février est scannée.

### [17:30-20:30] pg_stat_statements

> `pg_stat_statements` est l'extension indispensable pour le monitoring. Elle enregistre les statistiques de toutes les requêtes exécutées : nombre d'appels, temps moyen, lignes retournées.

**Action** : Activer et utiliser pg_stat_statements.

```sql
-- Activer l'extension
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Réinitialiser les statistiques
SELECT pg_stat_statements_reset();

-- Exécuter quelques requêtes
SELECT * FROM metrics WHERE sensor_id = 42 AND recorded_at > '2025-02-01';
SELECT AVG(value) FROM metrics WHERE recorded_at BETWEEN '2025-03-01' AND '2025-03-31';
SELECT COUNT(*) FROM metrics GROUP BY sensor_id ORDER BY count DESC LIMIT 5;

-- Voir les requêtes les plus lentes
SELECT
    query,
    calls,
    round(total_exec_time::numeric, 2) AS total_ms,
    round(mean_exec_time::numeric, 2) AS avg_ms,
    rows
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'course_db')
ORDER BY mean_exec_time DESC
LIMIT 10;

-- Requêtes les plus appelées
SELECT
    query,
    calls,
    round(mean_exec_time::numeric, 2) AS avg_ms
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = 'course_db')
ORDER BY calls DESC
LIMIT 10;
```

> `pg_stat_statements` est le premier outil à consulter quand la base est lente. Les requêtes sont normalisées (les valeurs sont remplacées par $1, $2), ce qui regroupe les appels identiques. Cherchez les requêtes avec un temps moyen élevé ou un nombre d'appels anormalement haut.

**Action** : Montrer le top 10 des requêtes les plus lentes et commenter.

### [20:30-23:00] Démo Lab-11

> Le lab 11 couvre tous ces sujets : pooling, COPY, VACUUM, partitioning et monitoring.

**Action** : Ouvrir `labs/lab-11-performances/` et parcourir les exercices.

```sql
-- Aperçu lab-11
-- Exercice 1 : Benchmark connection pool vs sans pool
-- Exercice 2 : INSERT vs COPY — charger 1M de lignes
-- Exercice 3 : Provoquer du bloat, diagnostiquer, VACUUM
-- Exercice 4 : Partitionner une table de logs
-- Exercice 5 : Analyser les requêtes lentes avec pg_stat_statements
```

**Action** : Montrer les fichiers du lab et les scripts de benchmark.

### [23:00-24:00] Conclusion

> L'optimisation de PostgreSQL passe par le pooling de connexions, le chargement efficace avec COPY, la maintenance avec VACUUM, le partitionnement pour les grandes tables, et le monitoring avec pg_stat_statements. Dans le prochain module, on aborde les fonctions SQL avancées : window functions, CTEs et requêtes récursives.

**Action** : Nettoyage.

```sql
DROP TABLE IF EXISTS bench_data, vacuum_demo, metrics, metrics_2025_01, metrics_2025_02, metrics_2025_03, metrics_2025_04;
```

## Points d'attention pour l'enregistrement
- Préparer le fichier CSV pour la démo COPY à l'avance
- Les benchmarks varient selon la machine — tester avant et noter les ordres de grandeur
- Le VACUUM VERBOSE produit beaucoup de sortie — bien zoomer sur les lignes importantes
- S'assurer que pg_stat_statements est disponible (peut nécessiter un restart PostgreSQL)
- Le partitionnement nécessite de créer les partitions avant d'insérer — ne pas oublier
- Ce module est dense : garder un bon rythme et ne pas s'attarder sur les détails
