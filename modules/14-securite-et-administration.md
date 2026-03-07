# Module 14 — Securite & Administration

> **Objectif** : Securiser votre base PostgreSQL de bout en bout — authentification, roles, privileges, Row Level Security — et maitriser les taches d'administration essentielles.
>
> **Difficulte** : ⭐⭐⭐⭐

---

## 1. Modele de securite PostgreSQL

La securite dans PostgreSQL s'organise en **couches concentriques** :

```
┌───────────────────────────────────────────────────────┐
│  Couche 1 : RESEAU                                     │
│  Firewall, SSL/TLS, listen_addresses                   │
│  ┌───────────────────────────────────────────────────┐ │
│  │  Couche 2 : AUTHENTIFICATION (pg_hba.conf)         │ │
│  │  Qui peut se connecter ? Avec quelle methode ?     │ │
│  │  ┌───────────────────────────────────────────────┐ │ │
│  │  │  Couche 3 : AUTORISATION (GRANT/REVOKE)        │ │ │
│  │  │  Que peut faire l'utilisateur connecte ?       │ │ │
│  │  │  ┌───────────────────────────────────────────┐ │ │ │
│  │  │  │  Couche 4 : ROW LEVEL SECURITY (RLS)      │ │ │ │
│  │  │  │  Quelles LIGNES peut-il voir/modifier ?   │ │ │ │
│  │  │  └───────────────────────────────────────────┘ │ │ │
│  │  └───────────────────────────────────────────────┘ │ │
│  └───────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────┘
```

> **Analogie** : Imaginez un immeuble de bureaux. Le firewall est la grille exterieure. pg_hba.conf est le badge d'acces a la porte. GRANT/REVOKE est la cle de chaque bureau. RLS est le coffre-fort dans le bureau : meme si vous avez la cle, vous ne voyez que vos propres documents.

---

## 2. Authentification — pg_hba.conf

### 2.1 Le fichier pg_hba.conf

`pg_hba.conf` (Host-Based Authentication) est le **gardien** de PostgreSQL. Il definit qui peut se connecter, depuis ou, et comment.

```sql
-- Trouver l'emplacement du fichier
SHOW hba_file;
-- /etc/postgresql/16/main/pg_hba.conf (Linux)
-- C:/Program Files/PostgreSQL/16/data/pg_hba.conf (Windows)
```

### 2.2 Format du fichier

```
# TYPE    DATABASE    USER        ADDRESS         METHOD
local     all         postgres                    peer
host      all         all         127.0.0.1/32    scram-sha-256
host      all         all         ::1/128         scram-sha-256
host      mydb        myapp       10.0.0.0/24     scram-sha-256
host      all         all         0.0.0.0/0       reject
```

| Champ | Description | Exemples |
|-------|-------------|----------|
| TYPE | Type de connexion | local, host, hostssl, hostnossl |
| DATABASE | Base(s) cible(s) | all, mydb, "db1,db2" |
| USER | Utilisateur(s) | all, myuser, +mygroup |
| ADDRESS | Adresse IP / reseau | 127.0.0.1/32, 10.0.0.0/24 |
| METHOD | Methode d'authentification | trust, password, md5, scram-sha-256, peer, cert |

### 2.3 Methodes d'authentification

| Methode | Securite | Description |
|---------|----------|-------------|
| `trust` | **Aucune** | Pas de mot de passe (dev uniquement !) |
| `password` | Faible | Mot de passe en clair sur le reseau |
| `md5` | Moyenne | Hash MD5 (obsolete mais courant) |
| `scram-sha-256` | **Forte** | Standard actuel recommande |
| `peer` | Forte | Authentification OS (local uniquement) |
| `cert` | **Tres forte** | Certificat SSL client |
| `reject` | - | Refus systematique |

```
┌──────────────────────────────────────────────────────────────┐
│  RECOMMANDATION :                                             │
│                                                               │
│  1. Production : scram-sha-256 + SSL obligatoire             │
│  2. Developpement : scram-sha-256 ou trust (local)           │
│  3. JAMAIS de trust en production !                          │
│  4. JAMAIS de password (utiliser scram-sha-256)              │
└──────────────────────────────────────────────────────────────┘
```

### 2.4 Exemple de pg_hba.conf securise

```
# Connexions locales : authentification OS
local   all     postgres                peer

# Connexions locales pour l'application
local   mydb    myapp                   scram-sha-256

# Connexions TCP depuis le serveur lui-meme
host    all     all     127.0.0.1/32    scram-sha-256
host    all     all     ::1/128         scram-sha-256

# Application depuis le reseau interne (SSL obligatoire)
hostssl mydb    myapp   10.0.0.0/24     scram-sha-256

# Replication depuis le standby
hostssl replication replicator 10.0.1.5/32 scram-sha-256

# Refuser tout le reste
host    all     all     0.0.0.0/0       reject
```

### 2.5 Recharger la configuration

```sql
-- Apres modification de pg_hba.conf
SELECT pg_reload_conf();
-- Ou depuis le shell : pg_ctl reload
```

> **Piege classique** : Les regles sont evaluees de **haut en bas**. La premiere regle qui correspond est utilisee. Si vous mettez `reject` en premier, plus personne ne peut se connecter !

---

## 3. Roles

### 3.1 Concept

Dans PostgreSQL, il n'y a pas de distinction entre "utilisateur" et "groupe". Tout est un **role**. Un role peut avoir l'attribut `LOGIN` (ce qui en fait un utilisateur) ou non (ce qui en fait un groupe).

```sql
-- Creer un role (groupe, pas de login)
CREATE ROLE app_readers;
CREATE ROLE app_writers;
CREATE ROLE app_admins;

-- Creer un utilisateur (role avec LOGIN)
CREATE ROLE myapp WITH LOGIN PASSWORD 'secret_password';

-- Equivalent :
CREATE USER myapp WITH PASSWORD 'secret_password';
-- CREATE USER est juste un alias pour CREATE ROLE ... WITH LOGIN
```

### 3.2 Attributs des roles

```sql
CREATE ROLE admin_user WITH
    LOGIN                  -- Peut se connecter
    SUPERUSER              -- Tous les droits (DANGEREUX)
    CREATEDB               -- Peut creer des bases
    CREATEROLE             -- Peut creer des roles
    REPLICATION            -- Peut initier la replication
    INHERIT                -- Herite des privileges des roles parents
    CONNECTION LIMIT 5     -- Max 5 connexions simultanees
    VALID UNTIL '2026-01-01'  -- Expiration
    PASSWORD 'strong_password';
```

| Attribut | Description | Defaut |
|----------|-------------|--------|
| LOGIN | Peut se connecter | Non (NOLOGIN) |
| SUPERUSER | Ignore toutes les verifications | Non |
| CREATEDB | Peut creer des bases | Non |
| CREATEROLE | Peut creer d'autres roles | Non |
| REPLICATION | Peut se connecter en mode replication | Non |
| INHERIT | Herite des privileges des roles membres | Oui |

### 3.3 Heritage de roles

```sql
-- Creer une hierarchie de roles
CREATE ROLE readers;
CREATE ROLE writers;
CREATE ROLE admins;

-- Les writers heritent des droits readers
GRANT readers TO writers;
-- Les admins heritent des droits writers (donc aussi readers)
GRANT writers TO admins;

-- Creer des utilisateurs
CREATE USER alice WITH PASSWORD 'pwd_alice' IN ROLE readers;
CREATE USER bob WITH PASSWORD 'pwd_bob' IN ROLE writers;
CREATE USER charlie WITH PASSWORD 'pwd_charlie' IN ROLE admins;
```

```
Hierarchie :
                admins
                  │
                  ▼ (herite de)
               writers
                  │
                  ▼ (herite de)
               readers

Charlie (admin) a les droits de : admins + writers + readers
Bob (writer) a les droits de : writers + readers
Alice (reader) a les droits de : readers
```

### 3.4 SET ROLE — Changer de role temporairement

```sql
-- Connecte en tant que charlie (admin)
SELECT current_user;  -- charlie

-- Se "transformer" en alice pour tester ses droits
SET ROLE alice;
SELECT current_user;  -- alice

-- Revenir a charlie
RESET ROLE;
SELECT current_user;  -- charlie
```

---

## 4. GRANT / REVOKE

### 4.1 Privileges sur les tables

```sql
-- Donner les droits de lecture aux readers
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readers;

-- Donner les droits d'ecriture aux writers
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO writers;

-- Donner tous les droits aux admins
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO admins;

-- Droits sur les sequences (necessaire pour INSERT avec SERIAL)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO writers;
```

### 4.2 Privileges disponibles

| Privilege | Table | Sequence | Schema | Function |
|-----------|-------|----------|--------|----------|
| SELECT | Lire | Lire la valeur | - | - |
| INSERT | Inserer | - | - | - |
| UPDATE | Modifier | Incrementer | - | - |
| DELETE | Supprimer | - | - | - |
| TRUNCATE | Vider | - | - | - |
| REFERENCES | Creer FK | - | - | - |
| TRIGGER | Creer trigger | - | - | - |
| CREATE | - | - | Creer objets | - |
| USAGE | - | Utiliser | Acceder | - |
| EXECUTE | - | - | - | Executer |
| ALL | Tout | Tout | Tout | Tout |

### 4.3 Default privileges

```sql
-- Appliquer automatiquement les privileges aux FUTURS objets
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO readers;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO writers;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO writers;
```

> **Piege classique** : `GRANT ... ON ALL TABLES` s'applique aux tables **existantes**. Les tables creees APRES le GRANT ne sont PAS couvertes. Utilisez `ALTER DEFAULT PRIVILEGES` pour les futures tables.

### 4.4 REVOKE — Retirer des privileges

```sql
-- Retirer le droit DELETE aux writers
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM writers;

-- Retirer tous les droits a un role
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM some_role;

-- Retirer le droit de connexion
REVOKE CONNECT ON DATABASE mydb FROM some_role;
```

### 4.5 Principe du moindre privilege

```
┌──────────────────────────────────────────────────────────────┐
│  PRINCIPE DU MOINDRE PRIVILEGE                                │
│                                                               │
│  Chaque role ne doit avoir QUE les droits necessaires        │
│  a sa fonction. Rien de plus.                                │
│                                                               │
│  Application web → SELECT, INSERT, UPDATE, DELETE            │
│  Rapports       → SELECT uniquement                          │
│  Monitoring     → CONNECT + pg_monitor role                  │
│  Migrations     → DDL (CREATE, ALTER, DROP)                  │
│  Replication    → REPLICATION attribute                      │
│                                                               │
│  JAMAIS de SUPERUSER pour l'application !                    │
└──────────────────────────────────────────────────────────────┘
```

### 4.6 Node.js : configuration par role

```javascript
import pg from 'pg';
const { Pool } = pg;

// Pool pour l'application (droits limites)
const appPool = new Pool({
    user: 'myapp',          // Role avec SELECT, INSERT, UPDATE, DELETE
    password: process.env.DB_APP_PASSWORD,
    database: 'mydb',
    max: 20,
});

// Pool pour les rapports (lecture seule)
const reportPool = new Pool({
    user: 'report_reader',  // Role avec SELECT uniquement
    password: process.env.DB_REPORT_PASSWORD,
    database: 'mydb',
    max: 5,
});

// Pool pour les migrations (DDL)
const migrationPool = new Pool({
    user: 'migrator',       // Role avec CREATE, ALTER, DROP
    password: process.env.DB_MIGRATION_PASSWORD,
    database: 'mydb',
    max: 1,
});
```

---

## 5. Row Level Security (RLS)

### 5.1 Le concept

RLS permet de filtrer les lignes **au niveau de la base de donnees**. Chaque utilisateur ne voit que les lignes qui le concernent.

> **Analogie** : Imaginez un classeur partage dans une entreprise. Sans RLS, tout le monde voit tous les documents. Avec RLS, chaque employe ouvre le meme classeur mais ne voit que SES documents. Le filtrage est transparent et impossible a contourner.

### 5.2 Activer RLS

```sql
-- Table multi-tenant
CREATE TABLE documents (
    id         SERIAL PRIMARY KEY,
    tenant_id  INT NOT NULL,
    titre      TEXT NOT NULL,
    contenu    TEXT,
    created_by TEXT NOT NULL DEFAULT current_user,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Activer RLS sur la table
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- IMPORTANT : par defaut, RLS est RESTRICTIF
-- Apres activation, PERSONNE ne voit rien (sauf les SUPERUSERS)
```

### 5.3 Creer des policies

```sql
-- Policy pour SELECT : chaque tenant voit ses documents
CREATE POLICY tenant_select ON documents
    FOR SELECT
    USING (tenant_id = current_setting('app.tenant_id')::int);

-- Policy pour INSERT : peut inserer uniquement pour son tenant
CREATE POLICY tenant_insert ON documents
    FOR INSERT
    WITH CHECK (tenant_id = current_setting('app.tenant_id')::int);

-- Policy pour UPDATE : peut modifier uniquement ses documents
CREATE POLICY tenant_update ON documents
    FOR UPDATE
    USING (tenant_id = current_setting('app.tenant_id')::int)
    WITH CHECK (tenant_id = current_setting('app.tenant_id')::int);

-- Policy pour DELETE : peut supprimer uniquement ses documents
CREATE POLICY tenant_delete ON documents
    FOR DELETE
    USING (tenant_id = current_setting('app.tenant_id')::int);
```

### 5.4 USING vs WITH CHECK

| Clause | Appliquee a | Effet |
|--------|-------------|-------|
| `USING` | SELECT, UPDATE (lecture), DELETE | Filtre les lignes **visibles** |
| `WITH CHECK` | INSERT, UPDATE (ecriture) | Verifie les lignes **ecrites** |

```
┌─────────────────────────────────────────────────────────────┐
│  SELECT : USING filtre ce qui est retourne                   │
│                                                               │
│  INSERT : WITH CHECK verifie la nouvelle ligne              │
│                                                               │
│  UPDATE : USING filtre les lignes modifiables               │
│           WITH CHECK verifie la ligne apres modification    │
│                                                               │
│  DELETE : USING filtre les lignes supprimables              │
└─────────────────────────────────────────────────────────────┘
```

### 5.5 Utiliser RLS avec Node.js

```javascript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
    user: 'myapp',
    database: 'mydb',
    max: 20,
});

/**
 * Execute une requete dans le contexte d'un tenant.
 * RLS filtre automatiquement les lignes.
 */
async function queryAsTenant(tenantId, sql, params = []) {
    const client = await pool.connect();

    try {
        // Definir le tenant pour cette session
        await client.query(
            "SELECT set_config('app.tenant_id', $1::text, true)",
            [tenantId.toString()]
        );
        // Le 3eme parametre `true` = local a la transaction

        const result = await client.query(sql, params);
        return result.rows;
    } finally {
        client.release();
    }
}

// Utilisation : chaque requete est automatiquement filtree
const docs = await queryAsTenant(42, 'SELECT * FROM documents');
// Retourne UNIQUEMENT les documents du tenant 42

// Meme si l'application a un bug et ne filtre pas par tenant_id,
// RLS empeche de voir les documents des autres tenants
const allDocs = await queryAsTenant(42, 'SELECT * FROM documents');
// Retourne toujours UNIQUEMENT les documents du tenant 42 !
```

### 5.6 Policies multiples et roles

```sql
-- Policy pour les admins : voir TOUT
CREATE POLICY admin_all ON documents
    FOR ALL
    TO admins
    USING (true)
    WITH CHECK (true);

-- Policy pour les managers : voir leur equipe
CREATE POLICY manager_view ON documents
    FOR SELECT
    TO managers
    USING (
        tenant_id IN (
            SELECT tenant_id FROM team_members
            WHERE manager_user = current_user
        )
    );
```

> **Point cle** : Quand plusieurs policies existent pour le meme role et la meme operation, elles sont combinees avec **OR** (mode PERMISSIVE par defaut). Avec `CREATE POLICY ... AS RESTRICTIVE`, elles sont combinees avec **AND**.

### 5.7 Bypass RLS

```sql
-- Les SUPERUSERS ignorent toujours RLS

-- Les proprietaires de tables aussi (par defaut)
-- Pour forcer RLS meme sur le proprietaire :
ALTER TABLE documents FORCE ROW LEVEL SECURITY;

-- Role avec BYPASSRLS
CREATE ROLE admin_bypass WITH LOGIN BYPASSRLS PASSWORD 'secure';
```

### 5.8 Tester RLS

```sql
-- Se connecter en tant que l'utilisateur de l'app
SET ROLE myapp;

-- Definir le tenant
SET app.tenant_id = '42';

-- Tester
SELECT * FROM documents;
-- Ne voit que les documents du tenant 42

-- Essayer d'inserer pour un autre tenant
INSERT INTO documents (tenant_id, titre) VALUES (99, 'Pirate !');
-- ERROR: new row violates row-level security policy for table "documents"

RESET ROLE;
```

---

## 6. Schemas

### 6.1 Le concept

Un **schema** est un namespace (espace de noms) a l'interieur d'une base de donnees.

```
Base de donnees "mydb"
├── Schema "public" (defaut)
│   ├── Table users
│   ├── Table orders
│   └── Table products
├── Schema "reporting"
│   ├── Table daily_stats
│   └── Table monthly_reports
└── Schema "tenant_42"
    ├── Table users
    └── Table orders   (memes noms, donnees differentes)
```

### 6.2 Creer et utiliser des schemas

```sql
-- Creer un schema
CREATE SCHEMA reporting;
CREATE SCHEMA IF NOT EXISTS analytics;

-- Creer une table dans un schema specifique
CREATE TABLE reporting.daily_stats (
    date_stat  DATE PRIMARY KEY,
    total_orders INT,
    total_revenue NUMERIC(12,2)
);

-- Acceder avec le nom qualifie
SELECT * FROM reporting.daily_stats;

-- Changer le search_path
SET search_path TO reporting, public;
-- Maintenant, "daily_stats" est trouve sans prefixe
SELECT * FROM daily_stats;
```

### 6.3 search_path

```sql
-- Voir le search_path courant
SHOW search_path;
-- "$user", public

-- L'ordre compte : le premier schema est prioritaire
SET search_path TO myschema, public;

-- Par utilisateur
ALTER ROLE myapp SET search_path TO myapp_schema, public;
```

### 6.4 Schema-based multi-tenancy

```sql
-- Creer un schema par tenant
CREATE SCHEMA tenant_1;
CREATE SCHEMA tenant_2;

-- Tables identiques dans chaque schema
CREATE TABLE tenant_1.users (id SERIAL PRIMARY KEY, nom TEXT);
CREATE TABLE tenant_2.users (id SERIAL PRIMARY KEY, nom TEXT);

-- L'application definit le search_path selon le tenant
SET search_path TO tenant_1, public;
SELECT * FROM users;  -- Retourne les users du tenant 1
```

---

## 7. pg_dump / pg_restore

### 7.1 Backup logique

```bash
# Backup complet (format plain SQL)
pg_dump -U postgres -d mydb > backup.sql

# Backup complet (format custom, compresse)
pg_dump -U postgres -d mydb -Fc -f backup.dump

# Backup complet (format directory, parallele)
pg_dump -U postgres -d mydb -Fd -j 4 -f backup_dir/

# Schema uniquement (structure sans donnees)
pg_dump -U postgres -d mydb --schema-only -f schema.sql

# Donnees uniquement
pg_dump -U postgres -d mydb --data-only -f data.sql

# Une seule table
pg_dump -U postgres -d mydb -t users -f users.sql

# Exclure une table
pg_dump -U postgres -d mydb --exclude-table=logs -f backup.sql
```

### 7.2 Formats de dump

| Format | Option | Compresse | Parallele | Restauration selective |
|--------|--------|-----------|-----------|----------------------|
| Plain SQL | `-Fp` (defaut) | Non | Non | Non (fichier texte) |
| Custom | `-Fc` | Oui | Non | **Oui** |
| Directory | `-Fd` | Oui | **Oui** | **Oui** |
| Tar | `-Ft` | Non | Non | Oui |

### 7.3 Restauration

```bash
# Restaurer un dump plain SQL
psql -U postgres -d mydb < backup.sql

# Restaurer un dump custom
pg_restore -U postgres -d mydb backup.dump

# Restaurer en parallele (format directory)
pg_restore -U postgres -d mydb -j 4 backup_dir/

# Restaurer une seule table
pg_restore -U postgres -d mydb -t users backup.dump

# Restaurer en creant la base
pg_restore -U postgres -C -d postgres backup.dump
```

### 7.4 Bonnes pratiques de backup

```
┌──────────────────────────────────────────────────────────────┐
│  STRATEGIE DE BACKUP RECOMMANDEE                              │
│                                                               │
│  1. pg_dump quotidien (backup logique complet)               │
│  2. WAL archiving continu (Point-in-Time Recovery)           │
│  3. Tester la restauration regulierement !                   │
│  4. Stocker les backups sur un autre serveur/region          │
│  5. Chiffrer les backups (gpg, age)                          │
│  6. Retention : 7 jours quotidiens + 4 hebdomadaires         │
│     + 12 mensuels                                            │
└──────────────────────────────────────────────────────────────┘
```

### 7.5 Point-in-Time Recovery (PITR)

```
                 Backup        Probleme
                 de base       (DROP TABLE)
                    │              │
Timeline:  ─────────┼──────────────┼──────────────── temps
                    │              │
                    │    WAL 1   WAL 2   WAL 3
                    │    ──────►──────►──────►
                    │
                    └── Restaurer le backup
                        + rejouer les WAL
                        jusqu'a JUSTE AVANT le DROP TABLE
                        = PITR
```

```sql
-- Configurer l'archivage WAL
ALTER SYSTEM SET wal_level = 'replica';
ALTER SYSTEM SET archive_mode = 'on';
ALTER SYSTEM SET archive_command = 'cp %p /backup/wal/%f';
-- Necessite un RESTART
```

---

## 8. Monitoring

### 8.1 pg_stat_activity — Sessions actives

```sql
-- Vue complete des sessions
SELECT
    pid,
    usename,
    datname,
    state,
    query,
    age(now(), query_start) AS query_duration,
    age(now(), xact_start) AS tx_duration,
    wait_event_type,
    wait_event,
    client_addr
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid != pg_backend_pid()
ORDER BY query_start;
```

### 8.2 Requetes longues

```sql
-- Requetes actives depuis plus de 5 secondes
SELECT
    pid,
    usename,
    query,
    age(now(), query_start) AS duration,
    state
FROM pg_stat_activity
WHERE state = 'active'
  AND age(now(), query_start) > interval '5 seconds'
  AND pid != pg_backend_pid()
ORDER BY query_start;
```

### 8.3 pg_stat_statements — Top SQL

```sql
-- Installer si pas fait
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Top 10 par temps total
SELECT
    LEFT(query, 100) AS query,
    calls,
    ROUND(total_exec_time::numeric, 2) AS total_ms,
    ROUND(mean_exec_time::numeric, 2) AS avg_ms,
    ROUND(stddev_exec_time::numeric, 2) AS stddev_ms,
    rows,
    ROUND(100.0 * shared_blks_hit /
        NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS cache_hit_pct
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
ORDER BY total_exec_time DESC
LIMIT 10;
```

### 8.4 Sante des tables

```sql
-- Vue de sante des tables
SELECT
    schemaname || '.' || relname AS table_name,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
    n_live_tup AS live_rows,
    n_dead_tup AS dead_rows,
    ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
    last_autovacuum,
    last_autoanalyze,
    seq_scan,
    idx_scan,
    ROUND(100.0 * idx_scan / NULLIF(seq_scan + idx_scan, 0), 1) AS idx_usage_pct
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 20;
```

### 8.5 Dashboard Node.js de monitoring

```javascript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
    user: 'monitoring',  // Role avec pg_monitor
    database: 'mydb',
    max: 2,
});

async function getDatabaseHealth() {
    const results = {};

    // 1. Connexions actives
    const { rows: connections } = await pool.query(`
        SELECT
            state,
            COUNT(*) AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
        GROUP BY state
    `);
    results.connections = connections;

    // 2. Cache hit ratio
    const { rows: cache } = await pool.query(`
        SELECT
            ROUND(100.0 * SUM(blks_hit) /
                NULLIF(SUM(blks_hit) + SUM(blks_read), 0), 2) AS hit_ratio
        FROM pg_stat_database
        WHERE datname = current_database()
    `);
    results.cacheHitRatio = cache[0].hit_ratio;

    // 3. Transactions par seconde
    const { rows: txn } = await pool.query(`
        SELECT
            xact_commit + xact_rollback AS total_txn,
            xact_commit AS commits,
            xact_rollback AS rollbacks,
            deadlocks
        FROM pg_stat_database
        WHERE datname = current_database()
    `);
    results.transactions = txn[0];

    // 4. Tables les plus volumineuses
    const { rows: tables } = await pool.query(`
        SELECT
            relname,
            pg_size_pretty(pg_total_relation_size(relid)) AS size,
            n_dead_tup AS dead_tuples
        FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(relid) DESC
        LIMIT 5
    `);
    results.topTables = tables;

    return results;
}

// Appel periodique
setInterval(async () => {
    const health = await getDatabaseHealth();
    console.log(JSON.stringify(health, null, 2));
}, 60_000); // Toutes les minutes
```

---

## 9. Extensions populaires

### 9.1 pg_stat_statements

Deja couvert en detail — indispensable pour le monitoring.

### 9.2 pgcrypto

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Hasher un mot de passe
SELECT crypt('mon_mot_de_passe', gen_salt('bf', 10)) AS hash;
-- $2a$10$xxxxx...

-- Verifier un mot de passe
SELECT (crypt('mon_mot_de_passe', hash) = hash) AS valid
FROM users WHERE email = 'alice@test.com';

-- Chiffrement symetrique
SELECT encrypt('donnee sensible'::bytea, 'cle_secrete'::bytea, 'aes');
SELECT convert_from(
    decrypt(encrypted_data, 'cle_secrete'::bytea, 'aes'),
    'UTF8'
);

-- Generation de donnees aleatoires
SELECT gen_random_bytes(32);  -- 32 octets aleatoires
```

### 9.3 uuid-ossp et gen_random_uuid()

```sql
-- PostgreSQL 13+ : gen_random_uuid() est integre (pas besoin d'extension)
SELECT gen_random_uuid();
-- a81bc81b-dead-4e5d-abff-90865d1e13b1

-- Pour les autres fonctions UUID :
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
SELECT uuid_generate_v4();  -- UUID v4 (aleatoire)
SELECT uuid_generate_v1();  -- UUID v1 (basee sur le temps + MAC)
```

### 9.4 PostGIS (introduction)

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

-- Stocker des coordonnees geographiques
CREATE TABLE magasins (
    id       SERIAL PRIMARY KEY,
    nom      TEXT NOT NULL,
    position GEOGRAPHY(POINT, 4326)  -- WGS84 (GPS)
);

INSERT INTO magasins (nom, position) VALUES
    ('Magasin Paris', ST_MakePoint(2.3522, 48.8566)),
    ('Magasin Lyon', ST_MakePoint(4.8357, 45.7640)),
    ('Magasin Marseille', ST_MakePoint(5.3698, 43.2965));

-- Trouver les magasins dans un rayon de 300km de Paris
SELECT nom,
       ST_Distance(position, ST_MakePoint(2.3522, 48.8566)::geography) / 1000
       AS distance_km
FROM magasins
WHERE ST_DWithin(position, ST_MakePoint(2.3522, 48.8566)::geography, 300000)
ORDER BY distance_km;
```

### 9.5 pg_trgm — Trigrams et similarite

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Recherche floue (tolere les fautes de frappe)
SELECT nom, similarity(nom, 'Postgrés') AS sim
FROM produits
WHERE similarity(nom, 'Postgrés') > 0.3
ORDER BY sim DESC;

-- Index GIN pour la recherche floue
CREATE INDEX idx_produits_nom_trgm ON produits USING GIN (nom gin_trgm_ops);

-- LIKE et ILIKE optimises avec pg_trgm
SELECT * FROM produits WHERE nom ILIKE '%laptop%';
-- Utilise l'index GIN trgm !
```

---

## 10. Maintenance

### 10.1 REINDEX

```sql
-- Reconstruire un index corrompu ou bloate
REINDEX INDEX idx_users_email;

-- Reconstruire tous les index d'une table
REINDEX TABLE users;

-- PostgreSQL 12+ : REINDEX CONCURRENTLY (sans bloquer les requetes)
REINDEX INDEX CONCURRENTLY idx_users_email;
```

### 10.2 CLUSTER

```sql
-- Reorganiser physiquement la table selon un index
-- (les lignes sont reordonnees sur disque)
CLUSTER users USING idx_users_created_at;
-- ATTENTION : ACCESS EXCLUSIVE lock !

-- Utile pour les requetes de range sur une colonne
-- (les donnees adjacentes sont sur les memes pages disque)
```

### 10.3 pg_repack

```bash
# Reorganiser une table sans lock exclusif (alternative a VACUUM FULL)
pg_repack -U postgres -d mydb -t users

# Reorganiser tous les index d'une table
pg_repack -U postgres -d mydb -t users --only-indexes
```

---

## 11. Exercice mental

> **Exercice mental** : Vous construisez une application SaaS multi-tenant. 500 clients partagent la meme base de donnees. Comment organiseriez-vous la securite ? Quelles sont les options et leurs trade-offs ?

<details>
<summary>Reponse</summary>

**Option 1 : RLS (Row Level Security)**
- Une seule table `users`, chaque ligne a un `tenant_id`
- Policies RLS filtrent par tenant
- Avantages : simple, un seul schema, maintenance facile
- Inconvenients : risque de fuite si mauvaise config, index plus gros

**Option 2 : Schema par tenant**
- Un schema par client (`tenant_1.users`, `tenant_2.users`)
- search_path dynamique
- Avantages : isolation forte, backup par tenant possible
- Inconvenients : 500 schemas = 500 x chaque table, migration complexe

**Option 3 : Base par tenant**
- Une base PostgreSQL par client
- Avantages : isolation maximale, backup/restore independant
- Inconvenients : 500 connexions, maintenance tres lourde

**Recommandation** : RLS pour la majorite des cas. Schema par tenant pour les gros clients qui demandent une isolation forte.
</details>

---

## Ce qu'il faut retenir

```
┌──────────────────────────────────────────────────────────────┐
│                    A RETENIR                                  │
│                                                               │
│  1. pg_hba.conf controle QUI peut se connecter               │
│     → scram-sha-256 en production                            │
│                                                               │
│  2. Roles = users + groups. Principe du moindre privilege    │
│                                                               │
│  3. GRANT/REVOKE pour les permissions. N'oubliez pas         │
│     ALTER DEFAULT PRIVILEGES pour les futurs objets          │
│                                                               │
│  4. RLS : securite au niveau des lignes, ideal pour          │
│     le multi-tenant. Transparent pour l'application.         │
│                                                               │
│  5. pg_dump -Fc pour les backups, pg_restore pour la         │
│     restauration. TESTEZ vos restaurations !                 │
│                                                               │
│  6. pg_stat_activity + pg_stat_statements = monitoring       │
│                                                               │
│  7. Extensions : pgcrypto, pg_trgm, PostGIS, uuid-ossp      │
│                                                               │
│  8. JAMAIS de SUPERUSER pour l'application !                 │
└──────────────────────────────────────────────────────────────┘
```

---

## Navigation

| Precedent | Suivant |
|---|---|
| [Module 13 — JSONB & Types avances](./13-jsonb-et-types-avances.md) | [Module 15 — Projet final](./15-projet-final.md) |

**Travaux pratiques** : [Lab 14 — Securiser une base multi-tenant](../labs/lab-14-securite.md)

---

> *"La securite n'est pas un produit, c'est un processus. Chaque couche que vous ajoutez reduit la surface d'attaque."*
