# Module 18 — Partitioning avance & Scaling

> **Objectif** : Maitriser le partitionnement natif de PostgreSQL (RANGE, LIST, HASH, sous-partitions), la maintenance des partitions, et les strategies de scaling horizontal (Citus, FDW, sharding) pour gerer des tables de centaines de millions de lignes.
>
> **Difficulte** : ⭐⭐⭐⭐⭐

---

## 1. Pourquoi partitionner

Imaginez une armoire avec un seul tiroir geant contenant 10 millions de feuilles. Pour trouver une feuille, vous devez potentiellement fouiller dans tout le tiroir. Maintenant, imaginez cette meme armoire avec 12 tiroirs etiquetes "Janvier", "Fevrier", ..., "Decembre". Pour trouver une feuille de Mars, vous n'ouvrez qu'un seul tiroir.

> **Analogie** : Le partitionnement PostgreSQL, c'est cette armoire a tiroirs. Au lieu d'une seule table gigantesque, vous la decoupez en **sous-tables** (partitions) selon un critere logique. PostgreSQL sait automatiquement dans quel "tiroir" chercher grace au **partition pruning**.

```
Sans partitionnement :                Avec partitionnement (par mois) :

  ┌─────────────────────┐            ┌─────────────────────┐
  │                     │            │ events_2024_01      │ ← 850K lignes
  │                     │            ├─────────────────────┤
  │    events           │            │ events_2024_02      │ ← 920K lignes
  │    10M lignes       │            ├─────────────────────┤
  │                     │            │ events_2024_03      │ ← 780K lignes
  │  Seq Scan : 10M     │            ├─────────────────────┤
  │  lignes a parcourir │            │ ...                 │
  │                     │            ├─────────────────────┤
  │                     │            │ events_2024_12      │ ← 910K lignes
  └─────────────────────┘            └─────────────────────┘

  SELECT * FROM events               SELECT * FROM events
  WHERE created_at                    WHERE created_at
    BETWEEN '2024-03-01'                BETWEEN '2024-03-01'
    AND '2024-03-31';                   AND '2024-03-31';

  → Scan 10M lignes                  → Scan 780K lignes seulement
                                       (partition pruning)
```

### Quand partitionner ?

```
┌──────────────────────────────────────────────────────────────┐
│          DECISION : FAUT-IL PARTITIONNER ?                    │
│                                                               │
│  OUI si :                                                    │
│  ✓ Table > 100M de lignes (ou > 10 GB)                      │
│  ✓ Requetes filtrent TOUJOURS sur le meme critere            │
│    (date, tenant_id, region...)                              │
│  ✓ Besoin de purger rapidement les anciennes donnees         │
│    (DROP PARTITION vs DELETE massif)                          │
│  ✓ Performances de VACUUM degradees sur grosse table         │
│                                                               │
│  NON si :                                                    │
│  ✗ Table < 10M de lignes (le surcoat ne vaut pas le coup)   │
│  ✗ Pas de critere de partition evident                       │
│  ✗ Les requetes ne filtrent pas sur la cle de partition      │
│  ✗ Besoin de FK vers cette table (limitees avec partitions)  │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Partition BY RANGE en profondeur

### 2.1 Cas d'usage

Le partitionnement par RANGE est le plus courant. Il est ideal pour :
- **Time-series** : logs, evenements, metriques (par jour, semaine, mois)
- **Donnees historiques** : commandes, transactions (par mois, trimestre)
- **Donnees avec cycle de vie** : garder N mois, archiver/supprimer le reste

### 2.2 Creation complete

```sql
-- ============================================================
-- Table partitionnee par RANGE sur la date
-- ============================================================
CREATE TABLE events (
    id          BIGINT GENERATED ALWAYS AS IDENTITY,
    tenant_id   INTEGER NOT NULL,
    event_type  TEXT NOT NULL,
    payload     JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- La PRIMARY KEY doit inclure la cle de partition !
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- ============================================================
-- Creer les partitions pour 2024
-- ============================================================
CREATE TABLE events_2024_01 PARTITION OF events
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE events_2024_02 PARTITION OF events
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

CREATE TABLE events_2024_03 PARTITION OF events
    FOR VALUES FROM ('2024-03-01') TO ('2024-04-01');

CREATE TABLE events_2024_04 PARTITION OF events
    FOR VALUES FROM ('2024-04-01') TO ('2024-05-01');

CREATE TABLE events_2024_05 PARTITION OF events
    FOR VALUES FROM ('2024-05-01') TO ('2024-06-01');

CREATE TABLE events_2024_06 PARTITION OF events
    FOR VALUES FROM ('2024-06-01') TO ('2024-07-01');

CREATE TABLE events_2024_07 PARTITION OF events
    FOR VALUES FROM ('2024-07-01') TO ('2024-08-01');

CREATE TABLE events_2024_08 PARTITION OF events
    FOR VALUES FROM ('2024-08-01') TO ('2024-09-01');

CREATE TABLE events_2024_09 PARTITION OF events
    FOR VALUES FROM ('2024-09-01') TO ('2024-10-01');

CREATE TABLE events_2024_10 PARTITION OF events
    FOR VALUES FROM ('2024-10-01') TO ('2024-11-01');

CREATE TABLE events_2024_11 PARTITION OF events
    FOR VALUES FROM ('2024-11-01') TO ('2024-12-01');

CREATE TABLE events_2024_12 PARTITION OF events
    FOR VALUES FROM ('2024-12-01') TO ('2025-01-01');

-- ============================================================
-- Partition par defaut (attrape tout ce qui n'a pas de partition)
-- ============================================================
CREATE TABLE events_default PARTITION OF events DEFAULT;
```

> **Piege classique** : Les bornes de RANGE sont **[FROM, TO)** — borne inferieure incluse, borne superieure **exclue**. `FROM ('2024-01-01') TO ('2024-02-01')` couvre du 1er janvier 00:00:00 au 31 janvier 23:59:59.999..., **sans** inclure le 1er fevrier.

### 2.3 Partition pruning

```sql
-- Le partition pruning est la magie du partitionnement
EXPLAIN (ANALYZE) SELECT *
FROM events
WHERE created_at BETWEEN '2024-03-01' AND '2024-03-31';

-- Resultat :
-- Append (actual time=0.012..45.678 rows=78000)
--   Subplans Removed: 11          ← 11 partitions ignorees !
--   -> Seq Scan on events_2024_03 (actual time=0.010..45.670 rows=78000)
--        Filter: (created_at >= '2024-03-01' AND created_at <= '2024-03-31')
```

```
Partition pruning — ce que PostgreSQL fait :

  Requete : WHERE created_at BETWEEN '2024-03-01' AND '2024-03-31'

  events_2024_01  ──► IGNORE (hors plage)
  events_2024_02  ──► IGNORE (hors plage)
  events_2024_03  ──► SCAN (dans la plage !)    ← seule partition scannee
  events_2024_04  ──► IGNORE (hors plage)
  ...
  events_2024_12  ──► IGNORE (hors plage)
  events_default  ──► IGNORE (hors plage)

  "Subplans Removed: 11" = 11 partitions eliminees
```

### 2.4 Default partition

```sql
-- La partition DEFAULT attrape les lignes sans partition correspondante
INSERT INTO events (tenant_id, event_type, created_at)
VALUES (1, 'test', '2025-06-15');
-- → va dans events_default (pas de partition 2025)

-- ATTENTION : si events_default contient des donnees,
-- la creation d'une nouvelle partition qui couvre ces donnees
-- necessite de les deplacer !

-- Bonne pratique : creer les partitions futures a l'avance
-- et garder la default partition VIDE (ou presque)
```

---

## 3. Partition BY LIST

### 3.1 Cas d'usage

Le partitionnement par LIST est ideal quand on partitionne sur un ensemble **fini** de valeurs discretes :
- **Multi-tenant** : par tenant_id (chaque client dans sa partition)
- **Par statut** : active, archived, deleted
- **Par region** : EU, US, ASIA

### 3.2 Exemple complet

```sql
-- ============================================================
-- Table multi-tenant partitionnee par region
-- ============================================================
CREATE TABLE orders (
    id          BIGINT GENERATED ALWAYS AS IDENTITY,
    customer_id INTEGER NOT NULL,
    total       NUMERIC(12,2) NOT NULL,
    region      TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, region)
) PARTITION BY LIST (region);

-- Partitions par region
CREATE TABLE orders_europe PARTITION OF orders
    FOR VALUES IN ('FR', 'DE', 'ES', 'IT', 'NL', 'BE', 'PT', 'AT', 'CH');

CREATE TABLE orders_north_america PARTITION OF orders
    FOR VALUES IN ('US', 'CA', 'MX');

CREATE TABLE orders_asia PARTITION OF orders
    FOR VALUES IN ('JP', 'CN', 'KR', 'IN', 'SG', 'AU');

CREATE TABLE orders_rest PARTITION OF orders DEFAULT;

-- Insertion — PostgreSQL route automatiquement
INSERT INTO orders (customer_id, total, region) VALUES
    (1, 99.99, 'FR'),      -- → orders_europe
    (2, 149.99, 'US'),     -- → orders_north_america
    (3, 79.99, 'JP'),      -- → orders_asia
    (4, 59.99, 'BR');      -- → orders_rest (default)

-- Requete avec pruning
EXPLAIN SELECT * FROM orders WHERE region = 'FR';
-- → ne scanne QUE orders_europe

EXPLAIN SELECT * FROM orders WHERE region IN ('US', 'CA');
-- → ne scanne QUE orders_north_america
```

### 3.3 Multi-tenant avec LIST

```sql
-- Pour un systeme SaaS avec quelques gros tenants
CREATE TABLE tenant_data (
    id          BIGINT GENERATED ALWAYS AS IDENTITY,
    tenant_id   INTEGER NOT NULL,
    data        JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, tenant_id)
) PARTITION BY LIST (tenant_id);

-- Les plus gros tenants ont leur propre partition
CREATE TABLE tenant_data_1 PARTITION OF tenant_data
    FOR VALUES IN (1);      -- Client Premium A

CREATE TABLE tenant_data_2 PARTITION OF tenant_data
    FOR VALUES IN (2);      -- Client Premium B

CREATE TABLE tenant_data_3 PARTITION OF tenant_data
    FOR VALUES IN (3);      -- Client Premium C

-- Les petits tenants partagent une partition
CREATE TABLE tenant_data_others PARTITION OF tenant_data DEFAULT;
```

---

## 4. Partition BY HASH

### 4.1 Cas d'usage

Le partitionnement par HASH distribue les lignes **uniformement** entre les partitions. Il est utile quand :
- Il n'y a **pas de critere naturel** de partition (pas de date, pas de region)
- On veut une **distribution uniforme** pour paralleliser les requetes
- La cle est un UUID ou un ID numerique sans ordre significatif

### 4.2 Exemple

```sql
-- ============================================================
-- Partitionnement par HASH sur user_id (4 partitions)
-- ============================================================
CREATE TABLE user_sessions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY,
    user_id     INTEGER NOT NULL,
    session_data JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, user_id)
) PARTITION BY HASH (user_id);

-- 4 partitions (MODULUS = nombre total, REMAINDER = index)
CREATE TABLE user_sessions_0 PARTITION OF user_sessions
    FOR VALUES WITH (MODULUS 4, REMAINDER 0);

CREATE TABLE user_sessions_1 PARTITION OF user_sessions
    FOR VALUES WITH (MODULUS 4, REMAINDER 1);

CREATE TABLE user_sessions_2 PARTITION OF user_sessions
    FOR VALUES WITH (MODULUS 4, REMAINDER 2);

CREATE TABLE user_sessions_3 PARTITION OF user_sessions
    FOR VALUES WITH (MODULUS 4, REMAINDER 3);

-- PostgreSQL utilise un hash interne pour distribuer :
-- hash(user_id) % 4 = 0 → user_sessions_0
-- hash(user_id) % 4 = 1 → user_sessions_1
-- etc.

-- Avec une clause WHERE sur user_id, le pruning fonctionne
EXPLAIN SELECT * FROM user_sessions WHERE user_id = 42;
-- → ne scanne qu'UNE partition
```

| Type de partition | Pruning avec = | Pruning avec RANGE | Pruning avec IN | Default partition |
|-------------------|----------------|---------------------|-----------------|-------------------|
| RANGE | Oui | **Oui** | Oui | Oui |
| LIST | **Oui** | Non | **Oui** | Oui |
| HASH | **Oui** | Non | Oui | **Non** |

---

## 5. Sous-partitions (multi-level)

### 5.1 RANGE puis LIST

On peut combiner les strategies de partitionnement sur plusieurs niveaux.

```sql
-- ============================================================
-- Sous-partitions : RANGE (par mois) → LIST (par region)
-- ============================================================
CREATE TABLE sales (
    id          BIGINT GENERATED ALWAYS AS IDENTITY,
    region      TEXT NOT NULL,
    amount      NUMERIC(12,2) NOT NULL,
    sold_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, sold_at, region)
) PARTITION BY RANGE (sold_at);

-- Partition de premier niveau : par mois
CREATE TABLE sales_2024_01 PARTITION OF sales
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')
    PARTITION BY LIST (region);    -- sous-partitionne !

CREATE TABLE sales_2024_02 PARTITION OF sales
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01')
    PARTITION BY LIST (region);

-- Sous-partitions de second niveau : par region
CREATE TABLE sales_2024_01_eu PARTITION OF sales_2024_01
    FOR VALUES IN ('EU');

CREATE TABLE sales_2024_01_us PARTITION OF sales_2024_01
    FOR VALUES IN ('US');

CREATE TABLE sales_2024_01_asia PARTITION OF sales_2024_01
    FOR VALUES IN ('ASIA');

CREATE TABLE sales_2024_01_default PARTITION OF sales_2024_01 DEFAULT;

CREATE TABLE sales_2024_02_eu PARTITION OF sales_2024_02
    FOR VALUES IN ('EU');

CREATE TABLE sales_2024_02_us PARTITION OF sales_2024_02
    FOR VALUES IN ('US');

CREATE TABLE sales_2024_02_asia PARTITION OF sales_2024_02
    FOR VALUES IN ('ASIA');

CREATE TABLE sales_2024_02_default PARTITION OF sales_2024_02 DEFAULT;
```

```
Arbre des partitions :

  sales
  ├── sales_2024_01  (Jan 2024)     ← RANGE
  │   ├── sales_2024_01_eu           ← LIST
  │   ├── sales_2024_01_us
  │   ├── sales_2024_01_asia
  │   └── sales_2024_01_default
  ├── sales_2024_02  (Fev 2024)     ← RANGE
  │   ├── sales_2024_02_eu           ← LIST
  │   ├── sales_2024_02_us
  │   ├── sales_2024_02_asia
  │   └── sales_2024_02_default
  └── ...

  Requete : WHERE sold_at = '2024-01-15' AND region = 'EU'
  → Ne scanne QUE sales_2024_01_eu (double pruning !)
```

> **Piege classique** : Avec 12 mois x 4 regions = 48 sous-partitions par an. Sur 5 ans, c'est 240 partitions. Au-dela de quelques centaines, le planificateur de requetes ralentit. Gardez le nombre total de partitions sous controle (< 1000 idealement).

---

## 6. Maintenance des partitions

### 6.1 Creer automatiquement les nouvelles partitions

```sql
-- ============================================================
-- Fonction pour creer les partitions du mois suivant
-- ============================================================
CREATE OR REPLACE FUNCTION create_next_month_partition()
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    next_month_start DATE;
    next_month_end DATE;
    partition_name TEXT;
BEGIN
    -- Calculer le premier jour du mois suivant
    next_month_start := date_trunc('month', now() + interval '1 month')::date;
    next_month_end := (next_month_start + interval '1 month')::date;
    partition_name := 'events_' || to_char(next_month_start, 'YYYY_MM');

    -- Verifier si la partition existe deja
    IF NOT EXISTS (
        SELECT 1 FROM pg_class
        WHERE relname = partition_name
          AND relkind = 'r'
    ) THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF events
             FOR VALUES FROM (%L) TO (%L)',
            partition_name,
            next_month_start,
            next_month_end
        );
        RAISE NOTICE 'Partition creee : %', partition_name;
    ELSE
        RAISE NOTICE 'Partition deja existante : %', partition_name;
    END IF;
END;
$$;

-- Executer manuellement
SELECT create_next_month_partition();

-- Ou planifier avec pg_cron
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
    'create-monthly-partition',
    '0 0 25 * *',              -- Le 25 de chaque mois
    'SELECT create_next_month_partition()'
);
```

### 6.2 DETACH PARTITION pour archiver

```sql
-- DETACH retire une partition de la table parent
-- sans supprimer les donnees
ALTER TABLE events DETACH PARTITION events_2023_01;

-- La table events_2023_01 existe toujours comme table independante
-- On peut la consulter directement
SELECT count(*) FROM events_2023_01;

-- Ou l'exporter pour archivage
-- pg_dump -t events_2023_01 mydb > events_2023_01_backup.sql

-- PostgreSQL 14+ : DETACH CONCURRENTLY (sans bloquer les requetes)
ALTER TABLE events DETACH PARTITION events_2023_02 CONCURRENTLY;
```

### 6.3 DROP partition (plus rapide que DELETE)

```sql
-- Supprimer une partition entiere est INSTANTANE
-- (pas de VACUUM necessaire, pas de dead tuples)
DROP TABLE events_2023_01;

-- Comparaison :
-- DELETE FROM events WHERE created_at < '2023-02-01';
-- → Scan de toute la table, genere des dead tuples, VACUUM necessaire
-- → Peut prendre des heures sur une grosse table

-- DROP TABLE events_2023_01;
-- → Instantane (supprime le fichier sur disque)
-- → Pas de dead tuples, pas de VACUUM
```

```
Comparaison DELETE vs DROP PARTITION :

  DELETE 50M lignes :            DROP PARTITION :
  ┌──────────────────┐           ┌──────────────────┐
  │ Duree : 45 min   │           │ Duree : 0.05s    │
  │ WAL generes : 8GB│           │ WAL generes : 0  │
  │ Dead tuples : 50M│           │ Dead tuples : 0  │
  │ VACUUM : 20 min  │           │ VACUUM : inutile │
  │ Lock : aucun     │           │ Lock : ACCESS    │
  │ mais I/O massif  │           │ EXCLUSIVE (bref) │
  └──────────────────┘           └──────────────────┘
```

### 6.4 pg_partman extension

`pg_partman` automatise entierement la gestion des partitions.

```sql
-- Installation
CREATE EXTENSION pg_partman;

-- Configurer la gestion automatique d'une table
SELECT partman.create_parent(
    p_parent_table := 'public.events',
    p_control := 'created_at',
    p_type := 'range',
    p_interval := '1 month',
    p_premake := 3              -- creer 3 mois a l'avance
);

-- pg_partman va :
-- 1. Creer les partitions pour les 3 prochains mois
-- 2. Via un job cron (ou pg_cron), creer les futures partitions
-- 3. Optionnellement, retenir ou supprimer les anciennes

-- Configuration de la retention
UPDATE partman.part_config
SET retention = '12 months',            -- garder 12 mois
    retention_keep_table = false         -- DROP les anciennes
WHERE parent_table = 'public.events';

-- Execution de la maintenance (a planifier)
SELECT partman.run_maintenance();
```

---

## 7. Index sur tables partitionnees

### 7.1 Index globaux vs index par partition

```sql
-- Un index cree sur la table parent est automatiquement
-- cree sur CHAQUE partition existante et future
CREATE INDEX idx_events_tenant ON events (tenant_id);

-- Cela cree :
-- idx_events_tenant       (sur la table parent — virtuel)
-- events_2024_01_tenant_id_idx   (sur events_2024_01)
-- events_2024_02_tenant_id_idx   (sur events_2024_02)
-- ... etc.

-- Verifier les index
SELECT
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_indexes
JOIN pg_stat_user_indexes USING (indexrelname)
WHERE tablename LIKE 'events_%'
ORDER BY tablename, indexname;
```

### 7.2 Contraintes UNIQUE sur partitions

```sql
-- REGLE CRITIQUE : une contrainte UNIQUE (ou PK) sur une table
-- partitionnee DOIT inclure la cle de partition

-- ERREUR :
CREATE TABLE events (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL
) PARTITION BY RANGE (created_at);
-- ERROR: unique constraint on partitioned table must include
--        all partitioning columns

-- CORRECT :
CREATE TABLE events (
    id         BIGINT GENERATED ALWAYS AS IDENTITY,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (id, created_at)   -- inclut la cle de partition
) PARTITION BY RANGE (created_at);
```

> **Piege classique** : Cette contrainte signifie qu'un `id` n'est unique que **dans une partition**. Le meme `id` peut theoriquement exister dans deux partitions differentes (avec des `created_at` differents). En pratique, avec un IDENTITY ou une SEQUENCE, c'est peu probable mais pas impossible. Utilisez un UUID si l'unicite globale est requise.

### 7.3 Probleme des FK vers une table partitionnee

```sql
-- PostgreSQL 12+ : les FK VERS une table partitionnee sont supportees
-- mais avec des limitations

CREATE TABLE order_items (
    id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id BIGINT NOT NULL,
    region   TEXT NOT NULL,
    product  TEXT NOT NULL,
    -- FK vers la table partitionnee : doit inclure la cle de partition
    FOREIGN KEY (order_id, region) REFERENCES orders (id, region)
);

-- La FK doit referencer la PK complete (incluant la cle de partition)
-- Cela signifie que order_items doit aussi stocker la region
```

```
┌──────────────────────────────────────────────────────────────┐
│  PROBLEMES DES FK AVEC LES PARTITIONS :                       │
│                                                               │
│  1. La FK doit inclure la cle de partition                   │
│     → Denormalisation (stocker la cle dans la table fille)   │
│                                                               │
│  2. Performance : chaque INSERT dans order_items doit        │
│     verifier la FK sur TOUTES les partitions de orders       │
│                                                               │
│  3. Alternative : gerer l'integrite cote application         │
│     (pas de FK, verification programmatique)                 │
└──────────────────────────────────────────────────────────────┘
```

---

## 8. Performance

### 8.1 Partition pruning dynamique

```sql
-- Le pruning dynamique fonctionne meme avec des parametres
-- (pas seulement des constantes)

-- Activer le pruning (actif par defaut)
SET enable_partition_pruning = on;

-- Pruning statique (a la planification)
EXPLAIN SELECT * FROM events WHERE created_at = '2024-03-15';
-- Les partitions sont eliminees au moment de EXPLAIN

-- Pruning dynamique (a l'execution)
PREPARE q AS SELECT * FROM events WHERE created_at = $1;
EXPLAIN ANALYZE EXECUTE q('2024-03-15');
-- Les partitions sont eliminees au moment de l'execution
-- grace au parametre fourni
```

### 8.2 Join pruning

```sql
-- PostgreSQL peut aussi eliminer des partitions lors des jointures
EXPLAIN (ANALYZE)
SELECT e.*, u.name
FROM events e
JOIN users u ON u.id = e.tenant_id
WHERE e.created_at BETWEEN '2024-03-01' AND '2024-03-31';

-- Le join ne sera execute QUE sur events_2024_03
-- Les autres partitions sont prunees avant la jointure
```

### 8.3 Aggregate pushdown (PostgreSQL 14+)

```sql
-- Avant PG14 : PostgreSQL scanne toutes les partitions,
-- puis calcule l'aggregat sur le resultat combine

-- PG14+ : l'aggregat est calcule DANS chaque partition,
-- puis les resultats partiels sont combines
EXPLAIN (ANALYZE)
SELECT date_trunc('month', created_at) AS mois,
       count(*) AS nb_events
FROM events
WHERE created_at >= '2024-01-01'
  AND created_at < '2025-01-01'
GROUP BY 1;

-- Avec aggregate pushdown :
-- Append
--   -> Partial Aggregate (on events_2024_01)
--   -> Partial Aggregate (on events_2024_02)
--   -> ...
-- Finalize Aggregate
```

### 8.4 Quand partitionner nuit a la performance

```
┌──────────────────────────────────────────────────────────────┐
│  ATTENTION : LE PARTITIONNEMENT PEUT DEGRADER LES PERFS !    │
│                                                               │
│  1. TROP DE PARTITIONS                                       │
│     > 1000 partitions → le planificateur ralentit            │
│     Chaque requete doit evaluer le pruning sur toutes        │
│                                                               │
│  2. TABLE TROP PETITE                                        │
│     < 1M de lignes → l'overhead de gestion des partitions    │
│     est superieur au gain du pruning                         │
│                                                               │
│  3. REQUETES SANS FILTRE SUR LA CLE DE PARTITION             │
│     SELECT * FROM events WHERE tenant_id = 42;               │
│     → TOUTES les partitions sont scannees (pas de pruning)   │
│                                                               │
│  4. INSERT UNITAIRE LENT                                     │
│     Le routage vers la bonne partition a un petit cout       │
│     Negligeable pour les batches, mesurable pour les         │
│     insertions individuelles a haut debit                    │
│                                                               │
│  5. JOINTURES ENTRE TABLES PARTITIONNEES                     │
│     Le planificateur peut generer des plans tres complexes   │
│     (partition-wise join aide, mais pas toujours)            │
└──────────────────────────────────────────────────────────────┘
```

```sql
-- Activer le partition-wise join (PG11+, desactive par defaut)
SET enable_partitionwise_join = on;

-- Et le partition-wise aggregate (PG11+)
SET enable_partitionwise_aggregate = on;
```

---

## 9. Scaling horizontal

### 9.1 Citus extension (distributed PostgreSQL)

Citus transforme PostgreSQL en base de donnees **distribuee**. Les tables sont shardees sur plusieurs noeuds PostgreSQL.

```
Architecture Citus :

  ┌────────────┐
  │  Coordinator │ ← point d'entree unique
  │  (noeud)    │    routage des requetes
  └──────┬─────┘
         │
    ┌────┴────────────────┐
    │         │           │
  ┌─▼──┐   ┌─▼──┐   ┌───▼─┐
  │ W1 │   │ W2 │   │ W3  │  ← Workers (noeuds de donnees)
  │    │   │    │   │     │
  │shard│   │shard│   │shard│  ← Chaque noeud stocke un sous-ensemble
  │1,4 │   │2,5 │   │3,6 │     des donnees
  └────┘   └────┘   └─────┘
```

```sql
-- Installer Citus
CREATE EXTENSION citus;

-- Ajouter les workers
SELECT citus_add_node('worker1.example.com', 5432);
SELECT citus_add_node('worker2.example.com', 5432);
SELECT citus_add_node('worker3.example.com', 5432);

-- Distribuer une table (sharding sur tenant_id)
SELECT create_distributed_table('events', 'tenant_id');

-- Les requetes sont automatiquement routees
SELECT * FROM events WHERE tenant_id = 42;
-- → execute sur le worker qui contient le shard du tenant 42

-- Requetes cross-shard (plus lentes, mais fonctionnelles)
SELECT count(*) FROM events;
-- → execute sur TOUS les workers, resultats agreges
```

### 9.2 Foreign Data Wrappers (postgres_fdw)

`postgres_fdw` permet de requeter des tables sur des serveurs PostgreSQL distants comme si elles etaient locales.

```sql
-- ============================================================
-- Serveur principal : acceder aux donnees d'un serveur distant
-- ============================================================
CREATE EXTENSION postgres_fdw;

-- Declarer le serveur distant
CREATE SERVER remote_server
    FOREIGN DATA WRAPPER postgres_fdw
    OPTIONS (host 'remote.example.com', port '5432', dbname 'analytics');

-- Mapper l'utilisateur local vers l'utilisateur distant
CREATE USER MAPPING FOR app
    SERVER remote_server
    OPTIONS (user 'remote_user', password 'secret');

-- Importer les tables distantes
IMPORT FOREIGN SCHEMA public
    LIMIT TO (analytics_events, analytics_users)
    FROM SERVER remote_server
    INTO remote_analytics;

-- Ou creer une table foreign manuellement
CREATE FOREIGN TABLE remote_events (
    id          BIGINT,
    event_type  TEXT,
    created_at  TIMESTAMPTZ
) SERVER remote_server
OPTIONS (schema_name 'public', table_name 'events');

-- Requeter comme une table locale
SELECT * FROM remote_analytics.analytics_events
WHERE created_at > now() - interval '1 day';

-- Jointure locale/distante
SELECT u.name, count(e.id)
FROM users u
JOIN remote_analytics.analytics_events e ON e.user_id = u.id
GROUP BY u.name;
```

> **Piege classique** : `postgres_fdw` envoie les filtres (WHERE) au serveur distant quand c'est possible (pushdown). Mais les jointures complexes et les agregats sont souvent executes localement apres avoir ramene toutes les donnees. Verifiez avec `EXPLAIN VERBOSE` que le pushdown fonctionne.

### 9.3 Sharding patterns

```
┌──────────────────────────────────────────────────────────────┐
│         PATTERNS DE SHARDING                                  │
│                                                               │
│  1. Application-level sharding                               │
│     L'application decide sur quel shard envoyer la requete   │
│     shard = hash(tenant_id) % nb_shards                      │
│     + Simple, controle total                                  │
│     - Logique dans le code, cross-shard queries difficiles   │
│                                                               │
│  2. Proxy-level sharding                                     │
│     Un proxy (ex: ProxySQL, custom) route les requetes       │
│     + Transparent pour l'application                          │
│     - Complexite du proxy, point de failure supplementaire   │
│                                                               │
│  3. Extension-level sharding (Citus)                         │
│     PostgreSQL lui-meme gere le sharding                     │
│     + SQL standard, transactions distribuees                  │
│     - Extension a maintenir, overhead de coordination         │
│                                                               │
│  4. Partitioning + FDW                                       │
│     Tables partitionnees dont certaines partitions sont      │
│     des foreign tables vers d'autres serveurs                │
│     + Natif PostgreSQL, pas d'extension                       │
│     - Performance limitee pour les cross-partition queries   │
└──────────────────────────────────────────────────────────────┘
```

### 9.4 Comparaison : partitioning local vs sharding distribue

| Critere | Partitioning local | Sharding distribue (Citus) |
|---------|-------------------|---------------------------|
| Complexite | Faible | Elevee |
| Scalabilite ecriture | Non (1 seul serveur) | **Oui** (N serveurs) |
| Scalabilite lecture | Avec replicas | **Native** |
| Transactions | Locales (rapides) | Distribuees (plus lentes) |
| Jointures | Normales | Limitees (colocation requise) |
| Maintenance | Simple | Complexe (N serveurs) |
| Cas d'usage | 1 serveur suffit mais table enorme | 1 serveur ne suffit plus |
| Seuil typique | < 1 TB | > 1 TB |

---

## 10. Read replicas + partitioning = architecture complete

```
Architecture production complete :

                          ┌──────────────┐
                          │  Application │
                          │  (Node.js)   │
                          └──────┬───────┘
                                 │
                    ┌────────────┴────────────┐
                    │                         │
              Write (INSERT/                Read (SELECT)
              UPDATE/DELETE)
                    │                         │
              ┌─────▼──────┐           ┌──────▼──────┐
              │  PRIMARY   │           │  HAProxy /  │
              │            │           │  pgpool     │
              │ events     │           └──┬───────┬──┘
              │ ├─2024_01  │              │       │
              │ ├─2024_02  │         ┌────▼──┐ ┌──▼────┐
              │ ├─...      │         │Replica│ │Replica│
              │ └─2024_12  │         │  1    │ │  2    │
              │            │         │       │ │       │
              │ orders     │         │(memes │ │(memes │
              │ ├─europe   │         │tables │ │tables │
              │ ├─na       │         │parti- │ │parti- │
              │ └─asia     │         │tionnee│ │tionnee│
              └──────┬─────┘         │s)     │ │s)     │
                     │               └───────┘ └───────┘
               WAL stream
                     │
              ┌──────▼──────┐
              │ WAL Archive │
              │ (pour PITR) │
              └─────────────┘
```

Les avantages combines :
1. **Partitioning** : requetes rapides grace au pruning, maintenance simple (DROP/DETACH)
2. **Read replicas** : scalabilite en lecture, les replicas ont les memes partitions
3. **WAL archiving** : PITR pour la protection contre les erreurs humaines

---

## 11. Migration vers un schema partitionne

### 11.1 La methode classique (avec downtime)

```sql
-- Etape 1 : Creer la nouvelle table partitionnee
CREATE TABLE events_new (
    id          BIGINT GENERATED ALWAYS AS IDENTITY,
    tenant_id   INTEGER NOT NULL,
    event_type  TEXT NOT NULL,
    payload     JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Creer les partitions
CREATE TABLE events_new_2024_01 PARTITION OF events_new
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
-- ... (toutes les partitions necessaires)
CREATE TABLE events_new_default PARTITION OF events_new DEFAULT;

-- Etape 2 : Copier les donnees (peut etre TRES long)
INSERT INTO events_new (id, tenant_id, event_type, payload, created_at)
    OVERRIDING SYSTEM VALUE
    SELECT id, tenant_id, event_type, payload, created_at
    FROM events_old;

-- Etape 3 : Recreer les index
CREATE INDEX ON events_new (tenant_id);

-- Etape 4 : Swap (necessite un court downtime)
BEGIN;
ALTER TABLE events_old RENAME TO events_archive;
ALTER TABLE events_new RENAME TO events;
COMMIT;

-- Etape 5 : Resynchroniser la sequence
SELECT setval(
    pg_get_serial_sequence('events', 'id'),
    (SELECT max(id) FROM events)
);
```

### 11.2 La methode zero-downtime (avec replication logique)

```sql
-- Etape 1 : Sur le MEME serveur, creer la nouvelle table partitionnee
-- (comme ci-dessus)

-- Etape 2 : Publier l'ancienne table
CREATE PUBLICATION migration_pub FOR TABLE events_old;

-- Etape 3 : S'abonner avec la nouvelle table
-- (necessite des astuces car on est sur le meme serveur)
-- Alternative : utiliser pg_rewrite ou un trigger

-- Methode avec trigger :
-- Creer un trigger AFTER INSERT/UPDATE/DELETE sur events_old
-- qui insere/modifie dans events_new

CREATE OR REPLACE FUNCTION sync_to_partitioned()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO events_new VALUES (NEW.*);
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        DELETE FROM events_new
        WHERE id = OLD.id AND created_at = OLD.created_at;
        INSERT INTO events_new VALUES (NEW.*);
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        DELETE FROM events_new
        WHERE id = OLD.id AND created_at = OLD.created_at;
        RETURN OLD;
    END IF;
END;
$$;

CREATE TRIGGER sync_partition_trigger
AFTER INSERT OR UPDATE OR DELETE ON events_old
FOR EACH ROW EXECUTE FUNCTION sync_to_partitioned();

-- Etape 4 : Copier les donnees historiques (en background)
INSERT INTO events_new
    SELECT * FROM events_old
    WHERE id NOT IN (SELECT id FROM events_new);

-- Etape 5 : Swap atomique
BEGIN;
DROP TRIGGER sync_partition_trigger ON events_old;
ALTER TABLE events_old RENAME TO events_deprecated;
ALTER TABLE events_new RENAME TO events;
COMMIT;

-- Etape 6 : Supprimer l'ancienne table quand tout est OK
-- DROP TABLE events_deprecated;
```

---

## 12. Node.js : requetes sur tables partitionnees, routing multi-shard

```typescript
// ============================================================
// Module Node.js pour tables partitionnees et sharding
// ============================================================

import pg from 'pg';
import type { PoolClient, PoolConfig, QueryResult } from 'pg';
const { Pool } = pg;

// ────────────────────────────────────────────────────────────
// 1. Requetes sur tables partitionnees (transparent !)
// ────────────────────────────────────────────────────────────
const pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'mydb',
    user: 'app',
    password: 'secret',
});

interface EventRow {
    id: number;
    event_type: string;
    payload: Record<string, unknown>;
    created_at: string;
}

// Les requetes sur une table partitionnee sont identiques
// a celles sur une table normale — PostgreSQL gere le pruning
async function getRecentEvents(tenantId: number, days: number = 7): Promise<EventRow[]> {
    const { rows } = await pool.query<EventRow>(`
        SELECT id, event_type, payload, created_at
        FROM events
        WHERE tenant_id = $1
          AND created_at > now() - $2::interval
        ORDER BY created_at DESC
        LIMIT 100
    `, [tenantId, `${days} days`]);
    // → PostgreSQL ne scanne que les partitions du dernier mois
    return rows;
}

// L'insertion est aussi transparente
interface InsertedEvent {
    id: number;
    created_at: string;
}

async function insertEvent(
    tenantId: number,
    eventType: string,
    payload: Record<string, unknown>
): Promise<InsertedEvent> {
    const { rows } = await pool.query<InsertedEvent>(`
        INSERT INTO events (tenant_id, event_type, payload)
        VALUES ($1, $2, $3)
        RETURNING id, created_at
    `, [tenantId, eventType, JSON.stringify(payload)]);
    // → PostgreSQL route automatiquement vers la bonne partition
    return rows[0];
}

// ────────────────────────────────────────────────────────────
// 2. Maintenance : creer les partitions futures
// ────────────────────────────────────────────────────────────
async function ensureFuturePartitions(monthsAhead: number = 3): Promise<void> {
    const client: PoolClient = await pool.connect();
    try {
        for (let i = 1; i <= monthsAhead; i++) {
            const startDate = new Date();
            startDate.setMonth(startDate.getMonth() + i, 1);
            startDate.setHours(0, 0, 0, 0);

            const endDate = new Date(startDate);
            endDate.setMonth(endDate.getMonth() + 1);

            const partName: string = `events_${startDate.getFullYear()}_${
                String(startDate.getMonth() + 1).padStart(2, '0')
            }`;

            const startStr: string = startDate.toISOString().split('T')[0];
            const endStr: string = endDate.toISOString().split('T')[0];

            try {
                await client.query(`
                    CREATE TABLE IF NOT EXISTS ${partName}
                    PARTITION OF events
                    FOR VALUES FROM ('${startStr}') TO ('${endStr}')
                `);
                console.log(`Partition ${partName} creee ou existante`);
            } catch (err) {
                if ((err as { code?: string }).code === '42P07') {
                    // relation already exists — OK
                    console.log(`Partition ${partName} existe deja`);
                } else {
                    throw err;
                }
            }
        }
    } finally {
        client.release();
    }
}

// ────────────────────────────────────────────────────────────
// 3. Sharding applicatif (multi-database)
// ────────────────────────────────────────────────────────────
class ShardRouter {
    shards: InstanceType<typeof Pool>[];
    numShards: number;

    constructor(shardConfigs: PoolConfig[]) {
        // shardConfigs = [{ host, port, database, ... }, ...]
        this.shards = shardConfigs.map(config => new Pool({
            ...config,
            max: 10,
        }));
        this.numShards = shardConfigs.length;
    }

    // Determiner le shard pour un tenant
    private _getShardIndex(tenantId: number): number {
        // Hash simple pour distribuer uniformement
        return tenantId % this.numShards;
    }

    private _getPool(tenantId: number): InstanceType<typeof Pool> {
        return this.shards[this._getShardIndex(tenantId)];
    }

    // Requete sur UN shard (tenant-scoped)
    async queryTenant(tenantId: number, sql: string, params: unknown[]): Promise<QueryResult> {
        const shardPool = this._getPool(tenantId);
        return shardPool.query(sql, params);
    }

    // Requete sur TOUS les shards (scatter-gather)
    async queryAll(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
        const results: QueryResult[] = await Promise.all(
            this.shards.map(shardPool => shardPool.query(sql, params))
        );
        // Combiner les resultats
        return results.flatMap(r => r.rows);
    }

    // Aggregation sur tous les shards
    async countAll(table: string, where: string = '', params: unknown[] = []): Promise<number> {
        const sql: string = `SELECT count(*) AS cnt FROM ${table} ${
            where ? 'WHERE ' + where : ''
        }`;
        const results: QueryResult[] = await Promise.all(
            this.shards.map(shardPool => shardPool.query(sql, params))
        );
        return results.reduce(
            (sum: number, r: QueryResult) => sum + parseInt(r.rows[0].cnt),
            0
        );
    }

    async close(): Promise<void> {
        await Promise.all(this.shards.map(s => s.end()));
    }
}

// Utilisation
const router = new ShardRouter([
    { host: 'shard1.example.com', port: 5432, database: 'app',
      user: 'app', password: 'secret' },
    { host: 'shard2.example.com', port: 5432, database: 'app',
      user: 'app', password: 'secret' },
    { host: 'shard3.example.com', port: 5432, database: 'app',
      user: 'app', password: 'secret' },
]);

// Requete pour un tenant specifique → 1 seul shard
const orders: QueryResult = await router.queryTenant(42,
    'SELECT * FROM orders WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10',
    [42]
);

// Comptage global → tous les shards en parallele
const totalOrders: number = await router.countAll('orders');
console.log(`Total commandes sur tous les shards : ${totalOrders}`);

// ────────────────────────────────────────────────────────────
// 4. Monitoring des partitions
// ────────────────────────────────────────────────────────────
interface PartitionRow {
    partition_name: string;
    total_size: string;
    live_rows: number;
    dead_rows: number;
}

async function getPartitionStats(): Promise<PartitionRow[]> {
    const { rows } = await pool.query<PartitionRow>(`
        SELECT
            inhrelid::regclass AS partition_name,
            pg_size_pretty(
                pg_total_relation_size(inhrelid)
            ) AS total_size,
            pg_stat_get_live_tuples(inhrelid) AS live_rows,
            pg_stat_get_dead_tuples(inhrelid) AS dead_rows
        FROM pg_inherits
        WHERE inhparent = 'events'::regclass
        ORDER BY inhrelid::regclass::text
    `);

    console.log('\n=== Partition Stats ===');
    for (const row of rows) {
        const deadPct: string = row.live_rows > 0
            ? (100 * row.dead_rows / (row.live_rows + row.dead_rows)).toFixed(1)
            : '0.0';
        console.log(
            `  ${row.partition_name.padEnd(25)} ` +
            `${row.total_size.padStart(10)} ` +
            `${row.live_rows.toString().padStart(12)} rows ` +
            `(${deadPct}% dead)`
        );
    }

    return rows;
}

// Exemple de sortie :
// === Partition Stats ===
//   events_2024_01             1.2 GB      8500000 rows (2.3% dead)
//   events_2024_02             1.1 GB      7800000 rows (1.8% dead)
//   events_2024_03             1.3 GB      9200000 rows (0.5% dead)
```

---

## 13. Exercice mental

> **Exercice mental 1** : Vous avez une table `logs` de 500 millions de lignes partitionnee par mois (24 partitions sur 2 ans). Un developpeur execute `SELECT count(*) FROM logs WHERE user_id = 42`. Pourquoi cette requete est-elle lente malgre le partitionnement ?

<details>
<summary>Reponse</summary>

La requete filtre sur `user_id`, mais la table est partitionnee par **date** (`created_at`). Il n'y a **aucun filtre sur la cle de partition**, donc PostgreSQL doit scanner les **24 partitions**. Le partition pruning ne s'applique pas.

Solutions :
1. Ajouter un index sur `user_id` (sera cree sur chaque partition)
2. Si les requetes par user_id sont tres frequentes, envisager de re-partitionner par user_id (HASH) ou d'ajouter un sous-partitionnement
3. Ajouter un filtre sur la date : `WHERE user_id = 42 AND created_at > now() - interval '30 days'` pour limiter a 1 partition
</details>

> **Exercice mental 2** : Vous voulez une contrainte `UNIQUE (email)` sur une table partitionnee par `tenant_id` (LIST). Comment faire ?

<details>
<summary>Reponse</summary>

Impossible directement. Une contrainte UNIQUE sur une table partitionnee doit inclure la cle de partition. Il faudrait `UNIQUE (email, tenant_id)`, ce qui n'empeche **pas** deux tenants d'avoir le meme email (c'est peut-etre acceptable).

Si l'unicite globale de l'email est requise, les alternatives sont :
1. **UNIQUE (email, tenant_id)** + verification applicative cross-tenant
2. **Table de reference separee** (non partitionnee) avec `UNIQUE (email)` et une FK
3. **Trigger BEFORE INSERT** qui verifie l'unicite manuellement sur toutes les partitions

La solution 2 est generalement la meilleure.
</details>

> **Exercice mental 3** : Votre table partitionnee par mois a une partition `events_default` qui contient 5 millions de lignes avec des dates de 2025. Vous voulez creer `events_2025_01`. Que se passe-t-il ?

<details>
<summary>Reponse</summary>

PostgreSQL refuse de creer la partition car la partition DEFAULT contient des lignes dont le `created_at` tombe dans la plage `[2025-01-01, 2025-02-01)`. L'erreur sera :

```
ERROR: updated partition constraint for default partition "events_default"
would be violated by some row
```

Pour resoudre :
1. Creer une table temporaire : `CREATE TABLE temp AS SELECT * FROM events_default WHERE created_at >= '2025-01-01' AND created_at < '2025-02-01'`
2. Supprimer ces lignes de la default : `DELETE FROM events_default WHERE created_at >= '2025-01-01' AND created_at < '2025-02-01'`
3. Creer la partition : `CREATE TABLE events_2025_01 PARTITION OF events FOR VALUES FROM ('2025-01-01') TO ('2025-02-01')`
4. Reinserer : `INSERT INTO events SELECT * FROM temp`
5. Drop temp : `DROP TABLE temp`

C'est pourquoi il faut creer les partitions **a l'avance** et garder la default vide.
</details>

---

## Ce qu'il faut retenir

```
┌──────────────────────────────────────────────────────────────┐
│                    A RETENIR                                  │
│                                                               │
│  1. RANGE : ideal pour les time-series et donnees            │
│     historiques. Le cas d'usage le plus frequent.            │
│                                                               │
│  2. LIST : parfait pour le multi-tenant ou les categorisations│
│     finies (region, statut).                                 │
│                                                               │
│  3. HASH : distribution uniforme quand pas de critere        │
│     naturel.                                                 │
│                                                               │
│  4. Partition pruning = la cle de la performance.            │
│     TOUJOURS filtrer sur la cle de partition !               │
│                                                               │
│  5. DROP PARTITION >> DELETE pour la purge de donnees.        │
│     Instantane, sans dead tuples.                            │
│                                                               │
│  6. PK et UNIQUE doivent inclure la cle de partition.        │
│     C'est la contrainte la plus genante du partitionnement.  │
│                                                               │
│  7. pg_partman simplifie la gestion automatique des          │
│     partitions (creation, retention, maintenance).           │
│                                                               │
│  8. Scaling horizontal : Citus pour le sharding natif,       │
│     postgres_fdw pour le federation, ou sharding applicatif. │
│                                                               │
│  9. Combiner partitioning + read replicas + WAL archiving    │
│     pour une architecture production complete.               │
└──────────────────────────────────────────────────────────────┘
```

---

## Navigation

| Precedent | Suivant |
|---|---|
| [Module 17 — Monitoring & Observabilite](./17-monitoring-et-observabilite.md) | Fin du cours avance |

---

> *"Le partitionnement n'est pas une optimisation prematuree — c'est une decision d'architecture. Comme pour un immeuble, il vaut mieux prevoir les etages avant de couler les fondations que d'essayer de les ajouter apres."*
