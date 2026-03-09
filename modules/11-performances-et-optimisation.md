# Module 11 — Performances & Optimisation

> **Objectif** : Identifier les goulots d'etranglement, optimiser les connexions, le bulk loading, le VACUUM, le partitionnement et les parametres cles de PostgreSQL.
>
> **Difficulte** : ⭐⭐⭐⭐

---

## 1. Les couches de performance

Avant d'optimiser, il faut comprendre **ou** se situe le probleme. Une requete traverse plusieurs couches :

```
┌─────────────────────────────────────────────────────────────┐
│                     APPLICATION (Node.js)                     │
├─────────────────────────────────────────────────────────────┤
│  1. RESEAU        │ Latence client → serveur (TCP, DNS)      │
├────────────────────┼────────────────────────────────────────┤
│  2. CONNEXION      │ Etablissement de connexion (handshake)  │
├────────────────────┼────────────────────────────────────────┤
│  3. PARSING        │ Analyse syntaxique du SQL               │
├────────────────────┼────────────────────────────────────────┤
│  4. PLANNING       │ Le planner choisit le meilleur plan     │
├────────────────────┼────────────────────────────────────────┤
│  5. EXECUTION      │ Execution du plan (scans, joins, sorts) │
├────────────────────┼────────────────────────────────────────┤
│  6. I/O            │ Lecture/ecriture sur disque (ou cache)   │
├─────────────────────────────────────────────────────────────┤
│                     STOCKAGE (SSD/HDD)                       │
└─────────────────────────────────────────────────────────────┘
```

> **Analogie** : Optimiser uniquement les requetes SQL, c'est comme acheter un moteur de Formule 1 pour une voiture avec des roues carrees. Il faut regarder la **chaine complete**.

| Couche | Temps typique | Optimisation |
|--------|--------------|-------------|
| Reseau | 1-50ms | Connection pooling, requetes en batch |
| Connexion | 50-100ms | Connection pooling (PgBouncer) |
| Parsing | < 1ms | Prepared statements |
| Planning | 1-10ms | Statistiques a jour, prepared statements |
| Execution | 1ms - minutes | Index, requetes optimisees |
| I/O | 0.1ms (SSD) - 10ms (HDD) | shared_buffers, cache OS |

---

## 2. Connection pooling

### 2.1 Le probleme

Chaque connexion a PostgreSQL cree un **nouveau processus** sur le serveur (fork). C'est couteux :

```
Sans pooling (100 requetes/s) :
┌──────────┐        ┌──────────────────┐
│ App      │───────►│ PostgreSQL       │
│          │  100   │  100 processus ! │
│          │  conn  │  ~10MB chacun    │
│          │        │  = 1GB RAM       │
└──────────┘        └──────────────────┘

Avec pooling (100 requetes/s) :
┌──────────┐  ┌──────────┐  ┌──────────────────┐
│ App      │─►│ Pool     │─►│ PostgreSQL       │
│          │  │ (10 conn)│  │  10 processus    │
│          │  │          │  │  = 100MB RAM     │
└──────────┘  └──────────┘  └──────────────────┘
                   │
            Reutilise les connexions
```

### 2.2 PgBouncer — Le standard de l'industrie

```
┌─────────────────────────────────────────────────────────────┐
│  PgBouncer : modes de pooling                                │
│                                                               │
│  Session pooling :    1 client = 1 connexion PG              │
│                       (utile pour les features de session)   │
│                                                               │
│  Transaction pooling : partage entre transactions            │
│                        (le plus courant et performant)       │
│                                                               │
│  Statement pooling :  partage entre requetes                 │
│                       (le plus agressif, limites)            │
└─────────────────────────────────────────────────────────────┘
```

### 2.3 Node.js pg.Pool : configuration optimale

```typescript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
    host: process.env.PGHOST || 'localhost',
    port: parseInt(process.env.PGPORT || '5432'),
    database: process.env.PGDATABASE || 'mydb',
    user: process.env.PGUSER || 'myuser',
    password: process.env.PGPASSWORD,

    // CONFIGURATION DU POOL
    max: 20,                      // Max 20 connexions simultanees
    min: 5,                       // Maintenir au minimum 5 connexions
    idleTimeoutMillis: 30_000,    // Fermer les connexions idle apres 30s
    connectionTimeoutMillis: 5_000, // Timeout de connexion 5s
    maxUses: 7500,                // Recycler apres 7500 requetes
    allowExitOnIdle: true,        // Laisser le process Node exit
});

// Gestion des erreurs du pool
pool.on('error', (err: Error) => {
    console.error('Erreur inattendue du pool :', err.message);
});

// Monitoring du pool
pool.on('connect', () => {
    console.log(`Pool: nouvelle connexion (total: ${pool.totalCount})`);
});

pool.on('remove', () => {
    console.log(`Pool: connexion fermee (total: ${pool.totalCount})`);
});
```

### 2.4 Choisir la valeur de `max`

```
Regle empirique :

  max_connections_pg = nombre_de_CPU * 2 + nombre_de_disques

  pool_max_par_instance = max_connections_pg / nombre_instances_app

Exemple :
  Serveur 8 CPU, 1 SSD : max_connections ≈ 17 → arrondi a 20
  3 instances Node.js : pool.max = 20 / 3 ≈ 7 par instance
```

| max | Situation | Consequence |
|-----|-----------|-------------|
| Trop petit (2-3) | Beaucoup de requetes | Attente dans le pool |
| Optimal (5-20) | Equilibre | Bonne utilisation des ressources |
| Trop grand (100+) | Peu de requetes | Gaspillage de RAM, context switching |

> **Piege classique** : Plus de connexions ne signifie PAS plus de performance. Au-dela d'un certain seuil, les context switches entre processus PostgreSQL **degradent** les performances.

---

## 3. Prepared statements

### 3.1 Le probleme du re-planning

Chaque fois que PostgreSQL recoit une requete, il doit :
1. **Parser** le SQL (syntaxe)
2. **Analyser** (semantique, permissions)
3. **Planifier** (choisir le meilleur plan d'execution)
4. **Executer** le plan

Les etapes 1-3 sont couteuses. Si vous executez la meme requete 10 000 fois avec des parametres differents, c'est du gaspillage.

### 3.2 PREPARE / EXECUTE en SQL

```sql
-- Preparer une fois
PREPARE get_user (INT) AS
    SELECT id, nom, email
    FROM users
    WHERE id = $1;

-- Executer N fois (pas de re-planning)
EXECUTE get_user(1);
EXECUTE get_user(42);
EXECUTE get_user(100);

-- Liberer
DEALLOCATE get_user;
```

### 3.3 Node.js : prepared statements avec pg

```typescript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ max: 10 });

interface User {
    id: number;
    nom: string;
    email: string;
}

// SANS prepared statement (re-planning a chaque fois)
async function getUserSlow(id: number): Promise<User | undefined> {
    const { rows } = await pool.query<User>(
        'SELECT id, nom, email FROM users WHERE id = $1',
        [id]
    );
    return rows[0];
}

// AVEC prepared statement (plan reutilise)
async function getUserFast(id: number): Promise<User | undefined> {
    const { rows } = await pool.query<User>({
        name: 'get-user-by-id',  // ← Nom du prepared statement
        text: 'SELECT id, nom, email FROM users WHERE id = $1',
        values: [id],
    });
    return rows[0];
}
```

### 3.4 Quand utiliser les prepared statements

| Scenario | Prepared ? | Raison |
|---|---|---|
| Requete executee > 100 fois | **Oui** | Gain de planning significatif |
| Requete ad-hoc unique | Non | Pas de reutilisation |
| Requete avec parametres dynamiques (colonnes, tables) | Non | Impossible a preparer |
| Batch processing en boucle | **Oui** | Gros gain |

---

## 4. Batch operations

### 4.1 INSERT multi-valeurs vs INSERT en boucle

```typescript
interface UserInput {
    nom: string;
    email: string;
}

// LENT : 1000 INSERTs individuels (1000 allers-retours reseau)
for (const user of users) {
    await pool.query(
        'INSERT INTO users (nom, email) VALUES ($1, $2)',
        [user.nom, user.email]
    );
}
// Temps : ~5 secondes pour 1000 lignes

// RAPIDE : 1 INSERT multi-valeurs
const values: string = users.map((u: UserInput, i: number) =>
    `($${i * 2 + 1}, $${i * 2 + 2})`
).join(', ');

const params: string[] = users.flatMap((u: UserInput) => [u.nom, u.email]);

await pool.query(
    `INSERT INTO users (nom, email) VALUES ${values}`,
    params
);
// Temps : ~50ms pour 1000 lignes (100x plus rapide)
```

### 4.2 unnest() pour les batch inserts parametres

```typescript
// ENCORE MIEUX : unnest() avec arrays
const noms: string[] = users.map((u: UserInput) => u.nom);
const emails: string[] = users.map((u: UserInput) => u.email);

await pool.query(
    `INSERT INTO users (nom, email)
     SELECT * FROM unnest($1::text[], $2::text[])`,
    [noms, emails]
);
// Propre, parametrise, et tres performant
```

### 4.3 COPY pour le bulk loading

```sql
-- 10-100x plus rapide que INSERT
-- Format CSV
COPY users (nom, email) FROM '/tmp/users.csv' WITH (FORMAT csv, HEADER);

-- Format texte (separateur tabulation)
COPY users (nom, email) FROM '/tmp/users.tsv';

-- Depuis STDIN (utile en script)
COPY users (nom, email) FROM STDIN WITH (FORMAT csv);
Alice,alice@test.com
Bob,bob@test.com
\.
```

### 4.4 COPY depuis Node.js

```typescript
import pg from 'pg';
import type { PoolClient } from 'pg';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import copyFrom from 'pg-copy-streams';

const { Pool } = pg;
const pool = new Pool({ max: 5 });

async function bulkInsertUsers(users: UserInput[]): Promise<void> {
    const client: PoolClient = await pool.connect();

    try {
        const stream = client.query(
            copyFrom.from('COPY users (nom, email) FROM STDIN WITH (FORMAT csv)')
        );

        const data: string = users.map((u: UserInput) => `${u.nom},${u.email}\n`).join('');
        const readable = Readable.from(data);

        await pipeline(readable, stream);
        console.log(`${users.length} utilisateurs inseres par COPY`);
    } finally {
        client.release();
    }
}
```

### 4.5 Comparaison des methodes

| Methode | 1000 lignes | 100K lignes | 1M lignes |
|---------|------------|------------|----------|
| INSERT en boucle | 5s | 8min | 80min |
| INSERT multi-valeurs | 50ms | 5s | 50s |
| unnest() | 40ms | 4s | 40s |
| COPY | 10ms | 1s | 10s |

---

## 5. VACUUM et AUTOVACUUM

### 5.1 Dead tuples et table bloat

> **Analogie** : Imaginez un immeuble de 100 appartements. Quand un locataire demenage (DELETE), l'appartement reste vide mais occupe toujours de l'espace dans l'immeuble. Quand un locataire change de numero de telephone (UPDATE), PostgreSQL "demenage" le locataire dans un nouvel appartement et laisse l'ancien vide. Apres des milliers de demenagements, l'immeuble est plein d'appartements vides. C'est le **bloat**.

```
Table "comptes" apres beaucoup d'UPDATEs :

Page 0 : [Alice v1 MORTE] [Bob v1 MORT] [Alice v2 VIVANTE] [vide]
Page 1 : [Bob v2 MORT] [Charlie VIVANT] [Bob v3 VIVANT] [vide]
Page 2 : [Alice v3 MORTE] [Alice v4 VIVANTE] [vide] [vide]

                 Tuples vivants : 4
                 Tuples morts   : 4  (50% de bloat !)
                 Espace gaspille : 50%
```

### 5.2 VACUUM — Le nettoyeur

```sql
-- VACUUM standard : marque l'espace des dead tuples comme reutilisable
-- MAIS ne reduit PAS la taille du fichier sur disque
VACUUM comptes;

-- VACUUM VERBOSE : affiche les details
VACUUM VERBOSE comptes;
-- INFO: vacuuming "public.comptes"
-- INFO: "comptes": removed 1000 dead row versions in 5 pages
-- INFO: "comptes": found 1000 removable, 500 nonremovable row versions
--        in 20 out of 50 pages
```

### 5.3 VACUUM vs VACUUM FULL

| Caracteristique | VACUUM | VACUUM FULL |
|----------------|--------|-------------|
| Lock | Aucun (concurrent !) | **ACCESS EXCLUSIVE** (bloque tout) |
| Espace libere | Marque comme reutilisable | **Retourne a l'OS** |
| Taille fichier | Inchangee | Reduite |
| Vitesse | Rapide | Lent (reecrit toute la table) |
| Utilisation | Regulier (automatique) | Exceptionnel |

```sql
-- VACUUM FULL : reecrit toute la table (compacte)
-- ATTENTION : ACCESS EXCLUSIVE lock !
VACUUM FULL comptes;
-- La table est reecrite, taille reduite
-- Mais la table etait INACCESSIBLE pendant l'operation
```

> **Piege classique** : Ne faites JAMAIS `VACUUM FULL` en production sur une grosse table sans maintenance window. Utilisez `pg_repack` a la place (pas de lock exclusif).

### 5.4 Autovacuum — Le pilote automatique

PostgreSQL lance automatiquement VACUUM grace a l'**autovacuum daemon**.

```sql
-- Voir la configuration
SHOW autovacuum;                          -- on (defaut)
SHOW autovacuum_vacuum_threshold;         -- 50 (defaut)
SHOW autovacuum_vacuum_scale_factor;      -- 0.2 (defaut)
SHOW autovacuum_naptime;                  -- 1min (defaut)
```

**Formule de declenchement** :

```
VACUUM se declenche quand :

  dead_tuples > autovacuum_vacuum_threshold
                + autovacuum_vacuum_scale_factor * n_live_tup

Exemple avec les defauts :
  Table de 10 000 lignes :
  seuil = 50 + 0.2 * 10000 = 2050 dead tuples

  Table de 1 000 000 lignes :
  seuil = 50 + 0.2 * 1000000 = 200 050 dead tuples (!)
```

### 5.5 Tuner l'autovacuum pour les grosses tables

```sql
-- Pour une table tres active : lancer le VACUUM plus souvent
ALTER TABLE orders SET (
    autovacuum_vacuum_threshold = 100,
    autovacuum_vacuum_scale_factor = 0.01,  -- 1% au lieu de 20%
    autovacuum_analyze_threshold = 100,
    autovacuum_analyze_scale_factor = 0.01
);
```

### 5.6 Monitorer l'autovacuum

```sql
SELECT
    relname,
    n_live_tup,
    n_dead_tup,
    ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1)
        AS dead_pct,
    last_vacuum,
    last_autovacuum,
    last_analyze,
    last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 20;
```

---

## 6. ANALYZE — Mettre a jour les statistiques

### 6.1 Pourquoi c'est crucial

Le **query planner** de PostgreSQL choisit le meilleur plan d'execution en se basant sur des **statistiques** : nombre de lignes, distribution des valeurs, valeurs les plus frequentes, etc.

Si les statistiques sont obsoletes, le planner prend de mauvaises decisions :

```
Statistiques obsoletes :           Statistiques a jour :
"La table a 100 lignes"           "La table a 10 millions de lignes"
→ Seq Scan (parcourt tout)        → Index Scan (utilise l'index)
→ 10M lignes lues !               → 1 ligne lue
→ 30 secondes                     → 1 milliseconde
```

### 6.2 Quand lancer ANALYZE

```sql
-- Analyser une table specifique
ANALYZE users;

-- Analyser toute la base
ANALYZE;

-- L'autovacuum lance aussi ANALYZE automatiquement
-- (avec autovacuum_analyze_threshold et autovacuum_analyze_scale_factor)
```

| Situation | Action |
|-----------|--------|
| Apres un bulk COPY/INSERT | `ANALYZE table_name;` |
| Apres une migration (ALTER TABLE) | `ANALYZE table_name;` |
| Requete soudainement lente | Verifier `last_autoanalyze`, puis `ANALYZE` |
| En continu | L'autovacuum s'en charge |

### 6.3 Voir les statistiques

```sql
-- Statistiques du planner pour une colonne
SELECT
    attname,
    n_distinct,     -- Nombre de valeurs distinctes
    null_frac,      -- Fraction de NULLs
    avg_width,      -- Taille moyenne en octets
    most_common_vals,
    most_common_freqs
FROM pg_stats
WHERE tablename = 'users'
  AND attname = 'status';
```

---

## 7. Table bloat

### 7.1 Detecter le bloat

```sql
-- Methode simple : comparer taille reelle vs taille estimee
SELECT
    relname,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
    pg_size_pretty(pg_relation_size(relid)) AS table_size,
    pg_size_pretty(pg_indexes_size(relid)) AS index_size,
    n_live_tup,
    n_dead_tup,
    ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup, 0), 1) AS dead_ratio
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 10;
```

### 7.2 Extension pgstattuple (plus precis)

```sql
-- Installer l'extension
CREATE EXTENSION IF NOT EXISTS pgstattuple;

-- Analyser le bloat d'une table
SELECT * FROM pgstattuple('comptes');
-- table_len          | 8192
-- tuple_count        | 100
-- tuple_len          | 3200
-- tuple_percent      | 39.06   ← seulement 39% utilise
-- dead_tuple_count   | 50
-- dead_tuple_len     | 1600
-- dead_tuple_percent | 19.53   ← 20% de dead tuples
-- free_space         | 3392
-- free_percent       | 41.41   ← 41% d'espace libre
```

### 7.3 Resoudre le bloat

| Methode | Lock | Vitesse | Production ? |
|---------|------|---------|-------------|
| VACUUM | Aucun | Rapide | Oui (regulier) |
| VACUUM FULL | ACCESS EXCLUSIVE | Lent | Non (downtime) |
| pg_repack | Tres leger | Moyen | **Oui** (recommande) |
| CLUSTER | ACCESS EXCLUSIVE | Lent | Non (downtime) |

```sql
-- pg_repack : reorganiser sans lock exclusif
-- (extension a installer)
CREATE EXTENSION pg_repack;

-- Depuis la ligne de commande
-- pg_repack -t comptes -d mydb
```

---

## 8. Partitioning

### 8.1 Le concept

> **Analogie** : Imaginez une bibliotheque avec un seul rayonnage de 10 millions de livres. Trouver un livre prend du temps car il faut tout parcourir. Maintenant, divisez les livres par annee : rayonnage 2023, rayonnage 2024, rayonnage 2025. Pour trouver un livre de 2024, vous allez directement au bon rayonnage. C'est le **partitionnement**.

### 8.2 PARTITION BY RANGE

```sql
-- Table principale (declarative partitioning, PG 10+)
CREATE TABLE events (
    id          BIGSERIAL,
    event_type  TEXT NOT NULL,
    payload     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

-- Partitions par mois
CREATE TABLE events_2025_01 PARTITION OF events
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

CREATE TABLE events_2025_02 PARTITION OF events
    FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');

CREATE TABLE events_2025_03 PARTITION OF events
    FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');

-- Index sur chaque partition (PG 11+ : cree automatiquement)
CREATE INDEX idx_events_created ON events (created_at);
```

### 8.3 PARTITION BY LIST

```sql
-- Partitionnement par region (multi-tenant)
CREATE TABLE orders (
    id        BIGSERIAL,
    region    TEXT NOT NULL,
    amount    NUMERIC(10,2),
    order_date DATE
) PARTITION BY LIST (region);

CREATE TABLE orders_europe PARTITION OF orders
    FOR VALUES IN ('FR', 'DE', 'ES', 'IT', 'UK');

CREATE TABLE orders_americas PARTITION OF orders
    FOR VALUES IN ('US', 'CA', 'BR', 'MX');

CREATE TABLE orders_asia PARTITION OF orders
    FOR VALUES IN ('JP', 'CN', 'KR', 'IN');

-- Partition par defaut (attrape-tout)
CREATE TABLE orders_other PARTITION OF orders DEFAULT;
```

### 8.4 PARTITION BY HASH

```sql
-- Partitionnement par hash (distribution uniforme)
CREATE TABLE sessions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    INT NOT NULL,
    data       JSONB,
    expires_at TIMESTAMPTZ
) PARTITION BY HASH (id);

CREATE TABLE sessions_0 PARTITION OF sessions
    FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE sessions_1 PARTITION OF sessions
    FOR VALUES WITH (MODULUS 4, REMAINDER 1);
CREATE TABLE sessions_2 PARTITION OF sessions
    FOR VALUES WITH (MODULUS 4, REMAINDER 2);
CREATE TABLE sessions_3 PARTITION OF sessions
    FOR VALUES WITH (MODULUS 4, REMAINDER 3);
```

### 8.5 Partition pruning

```sql
-- PostgreSQL elimine automatiquement les partitions inutiles
EXPLAIN SELECT * FROM events
WHERE created_at >= '2025-02-01' AND created_at < '2025-03-01';

-- Scan UNIQUEMENT events_2025_02 !
-- Les autres partitions sont ignorees (pruned)

-- Verifier que le pruning est active
SHOW enable_partition_pruning;  -- on (defaut)
```

### 8.6 Maintenance des partitions

```sql
-- Ajouter une nouvelle partition (mensuelle)
CREATE TABLE events_2025_04 PARTITION OF events
    FOR VALUES FROM ('2025-04-01') TO ('2025-05-01');

-- Supprimer une vieille partition (INSTANTANE, pas de DELETE lent)
DROP TABLE events_2024_01;

-- Detacher une partition (la garder comme table independante)
ALTER TABLE events DETACH PARTITION events_2024_01;
-- Maintenant events_2024_01 est une table normale
-- (utile pour archivage)
```

### 8.7 Quand partitionner

| Critere | Partitionner | Ne pas partitionner |
|---------|-------------|-------------------|
| Taille table | > 10 GB | < 1 GB |
| Pattern de requetes | Toujours filtre sur la cle | Requetes variees |
| Purge de donnees | Frequente (DROP vs DELETE) | Rare |
| Nombre de partitions | < 100 | > 1000 (overhead) |

---

## 9. Monitoring

### 9.1 pg_stat_statements — Top queries

```sql
-- Installer l'extension
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
-- Necessite shared_preload_libraries = 'pg_stat_statements'
-- dans postgresql.conf (puis restart)
```

```sql
-- Top 10 requetes les plus lentes (temps total)
SELECT
    LEFT(query, 80) AS query_preview,
    calls,
    ROUND(total_exec_time::numeric, 2) AS total_ms,
    ROUND(mean_exec_time::numeric, 2) AS avg_ms,
    ROUND(max_exec_time::numeric, 2) AS max_ms,
    rows
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

```sql
-- Top 10 requetes les plus appelees
SELECT
    LEFT(query, 80) AS query_preview,
    calls,
    ROUND(total_exec_time::numeric, 2) AS total_ms,
    ROUND((total_exec_time / calls)::numeric, 2) AS avg_ms
FROM pg_stat_statements
ORDER BY calls DESC
LIMIT 10;
```

```sql
-- Requetes qui font le plus de I/O
SELECT
    LEFT(query, 80) AS query_preview,
    calls,
    shared_blks_read + shared_blks_hit AS total_blocks,
    ROUND(100.0 * shared_blks_hit /
        NULLIF(shared_blks_read + shared_blks_hit, 0), 1) AS cache_hit_pct
FROM pg_stat_statements
ORDER BY shared_blks_read DESC
LIMIT 10;
```

### 9.2 pg_stat_user_tables — Sante des tables

```sql
SELECT
    schemaname,
    relname,
    seq_scan,          -- Nombre de seq scans (full table scans)
    seq_tup_read,      -- Tuples lus par seq scan
    idx_scan,          -- Nombre d'index scans
    idx_tup_fetch,     -- Tuples lus par index scan
    n_live_tup,
    n_dead_tup,
    ROUND(100.0 * idx_scan / NULLIF(seq_scan + idx_scan, 0), 1)
        AS idx_scan_pct
FROM pg_stat_user_tables
ORDER BY seq_scan DESC
LIMIT 20;
```

> **Regle** : Si `idx_scan_pct` est inferieur a 95% pour une grosse table, il manque probablement un index.

### 9.3 Cache hit ratio

```sql
-- Ratio de cache global (objectif : > 99%)
SELECT
    SUM(blks_hit) AS cache_hits,
    SUM(blks_read) AS disk_reads,
    ROUND(100.0 * SUM(blks_hit) /
        NULLIF(SUM(blks_hit) + SUM(blks_read), 0), 2) AS cache_hit_ratio
FROM pg_stat_database
WHERE datname = current_database();
```

```
Cache hit ratio :
  > 99%   : Excellent (presque tout en RAM)
  95-99%  : Bon
  < 95%   : Augmenter shared_buffers ou RAM
  < 80%   : Probleme serieux de dimensionnement
```

### 9.4 pg_stat_bgwriter

```sql
SELECT
    checkpoints_timed,      -- Checkpoints planifies
    checkpoints_req,        -- Checkpoints forces (mauvais si > timed)
    buffers_checkpoint,     -- Buffers ecrits par checkpoints
    buffers_clean,          -- Buffers ecrits par bgwriter
    maxwritten_clean,       -- Fois ou bgwriter a arrete (limite)
    buffers_backend,        -- Buffers ecrits par backends (mauvais si eleve)
    buffers_alloc
FROM pg_stat_bgwriter;
```

---

## 10. Tuning des parametres cles

### 10.1 shared_buffers

Le cache de pages en memoire partagee. C'est le parametre **le plus important**.

```sql
SHOW shared_buffers;  -- 128MB (defaut, beaucoup trop bas !)

-- Recommandation : 25% de la RAM totale
-- Serveur 16 GB RAM → shared_buffers = 4GB
ALTER SYSTEM SET shared_buffers = '4GB';
-- Necessite un RESTART
```

### 10.2 work_mem

Memoire allouee par **operation de tri/hash** (par requete, pas global).

```sql
SHOW work_mem;  -- 4MB (defaut)

-- Augmenter pour les requetes avec ORDER BY, GROUP BY, DISTINCT, joins
-- ATTENTION : c'est par operation ! Une requete peut en utiliser plusieurs
-- 100 connexions * 3 sorts * 64MB = 19 GB !
ALTER SYSTEM SET work_mem = '64MB';
SELECT pg_reload_conf();
```

### 10.3 maintenance_work_mem

Memoire pour les operations de maintenance (VACUUM, CREATE INDEX, etc.).

```sql
SHOW maintenance_work_mem;  -- 64MB (defaut)

-- Augmenter pour accelerer VACUUM et CREATE INDEX
ALTER SYSTEM SET maintenance_work_mem = '1GB';
SELECT pg_reload_conf();
```

### 10.4 effective_cache_size

Estimation de la memoire totale disponible pour le cache (shared_buffers + cache OS).

```sql
SHOW effective_cache_size;  -- 4GB (defaut)

-- Recommandation : 50-75% de la RAM totale
-- Serveur 16 GB → effective_cache_size = 12GB
ALTER SYSTEM SET effective_cache_size = '12GB';
SELECT pg_reload_conf();
```

### 10.5 random_page_cost

Cout relatif d'une lecture aleatoire (vs sequentielle).

```sql
SHOW random_page_cost;  -- 4.0 (defaut, calibre pour HDD)

-- Pour SSD : baisser a 1.1-1.5
ALTER SYSTEM SET random_page_cost = 1.1;
SELECT pg_reload_conf();
```

> **Point cle** : Sur SSD, les lectures aleatoires sont presque aussi rapides que les lectures sequentielles. Baisser `random_page_cost` pousse le planner a utiliser **plus d'index scans**.

### 10.6 max_connections

```sql
SHOW max_connections;  -- 100 (defaut)

-- MOINS est souvent MIEUX (utiliser un pool !)
-- Regle : 2-5x le nombre de CPUs
ALTER SYSTEM SET max_connections = 50;
-- Necessite un RESTART
```

### 10.7 Tableau recapitulatif

| Parametre | Defaut | SSD 16GB RAM | SSD 64GB RAM | Restart ? |
|-----------|--------|-------------|-------------|-----------|
| shared_buffers | 128MB | 4GB | 16GB | **Oui** |
| work_mem | 4MB | 64MB | 256MB | Non |
| maintenance_work_mem | 64MB | 1GB | 2GB | Non |
| effective_cache_size | 4GB | 12GB | 48GB | Non |
| random_page_cost | 4.0 | 1.1 | 1.1 | Non |
| max_connections | 100 | 50 | 100 | **Oui** |
| wal_buffers | -1 (auto) | 64MB | 128MB | **Oui** |
| checkpoint_completion_target | 0.9 | 0.9 | 0.9 | Non |

---

## 11. Exercice mental

> **Exercice mental** : Votre application fait 10 000 INSERTs/seconde dans une table de logs. Apres quelques jours, les SELECTs deviennent de plus en plus lents. Que diagnostiqueriez-vous et comment resoudriez-vous le probleme ?

<details>
<summary>Reponse</summary>

**Diagnostic** :
1. **Table bloat** : 10K inserts/s = beaucoup d'activite. Si des UPDATE/DELETE accompagnent, le bloat augmente
2. **Autovacuum depasse** : Avec le seuil par defaut (20%), sur 100M de lignes, il faut 20M dead tuples pour declencher VACUUM
3. **Statistiques obsoletes** : ANALYZE peut ne pas suivre le rythme
4. **Index bloat** : Les index aussi peuvent etre bloates

**Solutions** :
1. **Tuner l'autovacuum** pour cette table : `scale_factor = 0.01`
2. **Partitionner** par date : DROP les vieilles partitions (instantane)
3. **COPY** au lieu de INSERT individuel pour le bulk
4. Verifier `pg_stat_user_tables` pour le ratio dead_tup
5. Lancer `ANALYZE` manuellement si necessaire
</details>

---

## Ce qu'il faut retenir

```
┌──────────────────────────────────────────────────────────────┐
│                    A RETENIR                                  │
│                                                               │
│  1. Connection pooling est INDISPENSABLE en production       │
│     (pg.Pool ou PgBouncer)                                   │
│                                                               │
│  2. COPY est 10-100x plus rapide que INSERT en boucle        │
│                                                               │
│  3. VACUUM garde la table saine, AUTOVACUUM le fait          │
│     automatiquement (mais tunez-le pour les grosses tables)  │
│                                                               │
│  4. ANALYZE maintient les statistiques du planner a jour     │
│                                                               │
│  5. Partitionnement : ideal pour time-series et purge        │
│                                                               │
│  6. shared_buffers = 25% RAM, work_mem selon workload        │
│                                                               │
│  7. pg_stat_statements est votre meilleur ami en prod        │
│                                                               │
│  8. Cache hit ratio > 99% = tout va bien                     │
└──────────────────────────────────────────────────────────────┘
```

---

## Navigation

| Precedent | Suivant |
|---|---|
| [Module 10 — Deadlocks](./10-deadlocks.md) | [Module 12 — Fonctions avancees SQL](./12-fonctions-avancees-sql.md) |

**Travaux pratiques** : [Lab 11 — Optimiser une base lente](../labs/lab-11-performances.md)

---

> *"La performance n'est pas une feature qu'on ajoute a la fin. C'est une propriete emergente d'une architecture bien pensee."*
