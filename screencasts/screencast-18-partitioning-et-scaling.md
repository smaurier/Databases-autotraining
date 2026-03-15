# Screencast 18 — Partitioning et Scaling PostgreSQL

## Informations
- **Durée estimée** : 22-25 min
- **Module** : `modules/18-partitioning-et-scaling.md`
- **Lab associé** : `labs/lab-18-partitioning/`
- **Prérequis** : Modules 1-17 terminés, PostgreSQL running, base `course_db`

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] **Deux terminaux** ouverts dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] `psql` connecté à `course_db`
- [ ] Node.js prêt pour les scripts

## Script

### [00:00-05:00] RANGE partition — time-series

> Bienvenue dans le module partitioning. Quand une table atteint des millions de lignes, même les index deviennent lents. Le partitionnement découpe une table logique en plusieurs tables physiques — chaque partition contient un sous-ensemble des données. PostgreSQL redirige automatiquement les requêtes vers les bonnes partitions.

**Action** : Créer une table partitionnée par RANGE sur la date.

```sql
-- Table de logs partitionnée par mois
CREATE TABLE logs (
    id BIGSERIAL,
    created_at DATE NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    source TEXT
) PARTITION BY RANGE (created_at);

-- Vérifier que c'est bien une table partitionnée
SELECT relname, relkind
FROM pg_class
WHERE relname = 'logs';
-- relkind = 'p' → partitioned table
```

> Le `relkind = 'p'` confirme que c'est une table partitionnée. Pour l'instant elle est vide — pas de partition, pas de stockage. Il faut créer les partitions.

**Action** : Créer les 12 partitions mensuelles de 2024.

```sql
-- Créer les partitions mensuelles
CREATE TABLE logs_2024_01 PARTITION OF logs
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
CREATE TABLE logs_2024_02 PARTITION OF logs
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');
CREATE TABLE logs_2024_03 PARTITION OF logs
    FOR VALUES FROM ('2024-03-01') TO ('2024-04-01');
CREATE TABLE logs_2024_04 PARTITION OF logs
    FOR VALUES FROM ('2024-04-01') TO ('2024-05-01');
CREATE TABLE logs_2024_05 PARTITION OF logs
    FOR VALUES FROM ('2024-05-01') TO ('2024-06-01');
CREATE TABLE logs_2024_06 PARTITION OF logs
    FOR VALUES FROM ('2024-06-01') TO ('2024-07-01');
CREATE TABLE logs_2024_07 PARTITION OF logs
    FOR VALUES FROM ('2024-07-01') TO ('2024-08-01');
CREATE TABLE logs_2024_08 PARTITION OF logs
    FOR VALUES FROM ('2024-08-01') TO ('2024-09-01');
CREATE TABLE logs_2024_09 PARTITION OF logs
    FOR VALUES FROM ('2024-09-01') TO ('2024-10-01');
CREATE TABLE logs_2024_10 PARTITION OF logs
    FOR VALUES FROM ('2024-10-01') TO ('2024-11-01');
CREATE TABLE logs_2024_11 PARTITION OF logs
    FOR VALUES FROM ('2024-11-01') TO ('2024-12-01');
CREATE TABLE logs_2024_12 PARTITION OF logs
    FOR VALUES FROM ('2024-12-01') TO ('2025-01-01');

-- Vérifier les partitions
SELECT inhrelid::regclass AS partition
FROM pg_inherits
WHERE inhparent = 'logs'::regclass
ORDER BY inhrelid::regclass::text;
```

> 12 partitions, une par mois. Les bornes sont exclusives à droite : `FROM ('2024-01-01') TO ('2024-02-01')` inclut janvier mais pas le 1er février.

**Action** : Insérer des données et vérifier la distribution.

```sql
-- Insérer 50 000 lignes réparties sur 2024
INSERT INTO logs (created_at, level, message, source)
SELECT
    '2024-01-01'::date + (random() * 365)::int,
    (ARRAY['info','warn','error'])[1 + (random()*2)::int],
    'Log entry ' || i,
    'service-' || (i % 10)
FROM generate_series(1, 50000) AS i;

-- Vérifier la répartition
SELECT tableoid::regclass AS partition, count(*) AS rows
FROM logs
GROUP BY tableoid
ORDER BY partition;
```

> Les données sont automatiquement routées vers la bonne partition en fonction de la date. Chaque mois contient environ 4000 lignes (50000 / 12).

### [05:00-09:00] Partition pruning — EXPLAIN

> Le vrai pouvoir du partitionnement, c'est le partition pruning. Le planner exclut les partitions qui ne peuvent pas contenir les données recherchées.

**Action** : Démontrer le partition pruning avec EXPLAIN.

```sql
-- ANALYZE pour des stats à jour
ANALYZE logs;

-- Requête filtrée sur une date précise
EXPLAIN (FORMAT TEXT)
SELECT * FROM logs WHERE created_at = '2024-06-15';
```

> Regardez le plan : seule `logs_2024_06` est scannée. Les 11 autres partitions sont complètement ignorées. C'est comme avoir un index gratuit sur la colonne de partition.

**Action** : Montrer le plan et pointer la partition unique.

```sql
-- Requête sur un mois complet
EXPLAIN (VERBOSE, FORMAT TEXT)
SELECT count(*) FROM logs
WHERE created_at BETWEEN '2024-03-01' AND '2024-03-31';
```

> Avec un range sur mars, seule la partition de mars apparaît dans le plan. Les 11 autres partitions ont été pruned — elles n'apparaissent même pas.

```sql
-- Sans filtre : toutes les partitions sont scannées
EXPLAIN (FORMAT TEXT)
SELECT count(*) FROM logs;
```

> Sans filtre sur la clé de partition, PostgreSQL doit scanner toutes les partitions. Le pruning ne fonctionne que si la condition WHERE utilise la colonne de partition.

### [09:00-12:00] LIST partition — multi-tenant

> Le partitionnement par LISTE est idéal pour les données catégorisées : statuts, régions, tenants.

**Action** : Créer une table LIST partitionnée par statut.

```sql
-- Tickets par statut
CREATE TABLE tickets (
    id BIGSERIAL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    priority INT DEFAULT 3,
    created_at TIMESTAMPTZ DEFAULT now()
) PARTITION BY LIST (status);

-- Partitions par statut
CREATE TABLE tickets_active PARTITION OF tickets
    FOR VALUES IN ('active');
CREATE TABLE tickets_archived PARTITION OF tickets
    FOR VALUES IN ('archived');
CREATE TABLE tickets_deleted PARTITION OF tickets
    FOR VALUES IN ('deleted');

-- Insérer des données
INSERT INTO tickets (title, status, priority)
SELECT
    'Ticket #' || i,
    (ARRAY['active','archived','deleted'])[1 + (random()*2)::int],
    1 + (random() * 4)::int
FROM generate_series(1, 10000) AS i;

-- Vérifier la distribution
SELECT tableoid::regclass AS partition, count(*)
FROM tickets GROUP BY tableoid;

-- Pruning sur le statut
EXPLAIN (FORMAT TEXT)
SELECT * FROM tickets WHERE status = 'active';
```

> Le partitionnement LIST est aussi utile pour le multi-tenant : une partition par client. La requête `WHERE tenant_id = 'client_a'` ne scanne que la partition de ce client.

### [12:00-15:00] DETACH pour archivage

> L'un des usages les plus puissants du partitionnement : le DETACH pour archiver ou purger des données.

**Action** : Détacher une partition et montrer qu'elle survit comme table indépendante.

```sql
-- Compter les lignes avant
SELECT count(*) AS total FROM logs;
SELECT count(*) AS jan_count
FROM logs WHERE created_at >= '2024-01-01' AND created_at < '2024-02-01';

-- Détacher la partition de janvier
ALTER TABLE logs DETACH PARTITION logs_2024_01;

-- La table existe toujours comme table indépendante
SELECT count(*) FROM logs_2024_01;
-- Les données sont toujours là !

-- Mais elles ne sont plus dans la table parente
SELECT count(*) AS total_after_detach FROM logs;
```

> Les données de janvier sont intactes dans `logs_2024_01`, mais elles ne sont plus accessibles via `logs`. C'est le pattern d'archivage : détacher, compresser/sauvegarder la partition, et éventuellement la supprimer quand elle n'est plus nécessaire.

**Action** : Re-attacher la partition pour la suite.

```sql
-- Re-attacher
ALTER TABLE logs ATTACH PARTITION logs_2024_01
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

-- PostgreSQL vérifie la contrainte lors du ATTACH !
-- Si des données violent les bornes, le ATTACH échoue

-- Vérifier le total
SELECT count(*) FROM logs;
```

> Lors du ATTACH, PostgreSQL valide que toutes les lignes respectent les bornes. Si une ligne de `logs_2024_01` à une date en mars, le ATTACH échoue. C'est une garantie d'intégrité.

### [15:00-18:00] Partition par défaut et contrainte UNIQUE

> Que se passe-t-il si on insère une donnée hors des bornes définies ?

**Action** : Tester l'insertion hors range et ajouter une partition par défaut.

```sql
-- Sans partition par défaut, l'insertion échoue
INSERT INTO logs (created_at, level, message)
VALUES ('2025-06-15', 'info', 'Donnée 2025');
-- ERROR: no partition of relation "logs" found for row

-- Créer une partition par défaut
CREATE TABLE logs_default PARTITION OF logs DEFAULT;

-- Maintenant ça passe
INSERT INTO logs (created_at, level, message) VALUES
    ('2025-06-15', 'info', 'Donnée 2025'),
    ('2023-12-01', 'warn', 'Donnée 2023');

-- Vérifier
SELECT tableoid::regclass AS partition, count(*)
FROM logs GROUP BY tableoid ORDER BY partition;
```

> La partition DEFAULT attrape toutes les lignes qui ne correspondent à aucune partition existante. Attention : si la partition par défaut grossit, c'est un signe qu'il faut créer de nouvelles partitions.

```sql
-- Contrainte UNIQUE sur table partitionnée
-- DOIT inclure la clé de partition !

-- Ceci échoue :
-- ALTER TABLE logs ADD CONSTRAINT uq_logs UNIQUE (id);
-- ERROR: unique constraint must include all partitioning columns

-- Ceci fonctionne :
ALTER TABLE logs ADD CONSTRAINT uq_logs UNIQUE (id, created_at);
```

> C'est une contrainte importante du partitionnement : les UNIQUE et PRIMARY KEY doivent inclure la clé de partition. C'est parce que l'unicité est vérifiée par partition, pas globalement.

### [18:00-22:00] Performance — partitionnée vs non-partitionnée

> Comparons les performances sur un volume réaliste.

**Action** : Créer une table non-partitionnée et comparer.

```sql
-- Table non-partitionnée avec les mêmes données
CREATE TABLE logs_flat (
    id BIGSERIAL PRIMARY KEY,
    created_at DATE NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    source TEXT
);

-- Insérer 500K lignes dans les deux tables
INSERT INTO logs_flat (created_at, level, message, source)
SELECT
    '2024-01-01'::date + (random() * 365)::int,
    (ARRAY['info','warn','error'])[1 + (random()*2)::int],
    'Log entry ' || i,
    'service-' || (i % 100)
FROM generate_series(1, 500000) AS i;

-- Index sur la table non-partitionnée
CREATE INDEX idx_logs_flat_date ON logs_flat (created_at);

-- Ajouter des données à la table partitionnée aussi
INSERT INTO logs (created_at, level, message, source)
SELECT
    '2024-01-01'::date + (random() * 365)::int,
    (ARRAY['info','warn','error'])[1 + (random()*2)::int],
    'Log entry ' || i,
    'service-' || (i % 100)
FROM generate_series(1, 450000) AS i;

-- ANALYZE les deux
ANALYZE logs;
ANALYZE logs_flat;
```

**Action** : Comparer les plans et temps d'exécution.

```sql
-- Requête sur un mois : table partitionnée
EXPLAIN ANALYZE
SELECT count(*), avg(length(message))
FROM logs
WHERE created_at BETWEEN '2024-06-01' AND '2024-06-30';

-- Même requête : table non-partitionnée
EXPLAIN ANALYZE
SELECT count(*), avg(length(message))
FROM logs_flat
WHERE created_at BETWEEN '2024-06-01' AND '2024-06-30';
```

> La table partitionnée ne scanne qu'une partition (~42K lignes). La table non-partitionnée utilise un Index Scan ou Bitmap Scan sur 500K lignes. Le partitionnement brille surtout quand le volume augmente (millions de lignes) et quand les requêtes filtrent sur la clé de partition.

**Action** : Comparer les plans côte à côte.

### [22:00-24:00] Citus et sharding — aperçu

> Pour aller au-delà d'un seul serveur, il y a le sharding. Citus est l'extension de référence pour le sharding natif PostgreSQL.

**Action** : Expliquer le concept de sharding avec un schéma.

```sql
-- Citus (si installé) distribue les tables sur plusieurs nœuds
-- SELECT create_distributed_table('orders', 'customer_id');

-- postgres_fdw : alternative légère pour la fédération
-- CREATE SERVER remote FOREIGN DATA WRAPPER postgres_fdw
--     OPTIONS (host 'remote_host', dbname 'remote_db');
-- CREATE FOREIGN TABLE remote_orders (...) SERVER remote;

-- Différences clés :
-- Citus : sharding natif, requêtes distribuées, colocation
-- postgres_fdw : tables distantes, push-down limité
-- Partitioning : découpage sur un seul serveur
```

> Citus distribue les données sur plusieurs workers via une clé de distribution. Les requêtes sont automatiquement parallélisées. `postgres_fdw` est plus simple mais moins performant — il pousse certains filtres vers le serveur distant, mais les JOIN complexes sont rapatriés localement.

### [24:00-25:00] Démo Lab-18 et récapitulatif

> Le lab 18 couvre les 3 types de partitionnement, le pruning, le DETACH, la partition par défaut, et la comparaison de performances.

**Action** : Ouvrir le lab et montrer la structure.

```bash
ls labs/lab-18-partitioning/
# README.md  exercise.js  solution.js
```

> Pour résumer : RANGE pour les données temporelles, LIST pour les catégories, HASH pour la distribution uniforme. Le partition pruning est automatique si la condition WHERE utilise la clé de partition. DETACH pour l'archivage. Et n'oubliez pas : ne partitionnez que si la table est assez grande et que les requêtes filtrent sur la clé de partition.

**Action** : Nettoyage.

```sql
-- Nettoyage
DROP TABLE IF EXISTS logs CASCADE;
DROP TABLE IF EXISTS logs_flat CASCADE;
DROP TABLE IF EXISTS tickets CASCADE;
```

## Points d'attention pour l'enregistrement
- Ce screencast est le plus technique — bien préparer les données à l'avance
- L'insertion de 500K lignes prend quelques secondes — prévoir le temps
- Le partition pruning doit être clairement visible dans le EXPLAIN
- La démo DETACH / ATTACH est le moment clé — bien montrer les counts avant/après
- L'erreur "no partition found" sans partition par défaut doit être capturée
- La comparaison de performance doit utiliser EXPLAIN ANALYZE pour des chiffres réels
- La section Citus est conceptuelle — pas besoin de l'installer
- Terminer en rappelant les cas où NE PAS partitionner
