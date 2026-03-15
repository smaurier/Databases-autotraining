# Module 09 — Verrous & Locks

> **Objectif** : Maîtriser les mécanismes de verrouillage de PostgreSQL — row locks, table locks, advisory locks — pour controler finement la concurrence.
>
> **Difficulte** : ⭐⭐⭐

---

## 1. Pourquoi les verrous

On a vu dans le module précédent que MVCC evite les locks en lecture. Mais quand deux transactions veulent **modifier la même ligne**, il faut bien un arbitre.

> **Analogie** : La salle de bain d'un appartement partage. Plusieurs colocataires (transactions) peuvent lire le planning sur la porte en même temps (SELECT = pas de lock). Mais quand quelqu'un entre dans la salle de bain (UPDATE), il verrouille la porte. Les autres doivent attendre. Si deux personnes pouvaient modifier le thermostat de la douche en même temps, le résultat serait imprevisible.

### Le spectre des verrous PostgreSQL

```
         Leger                                      Lourd
           │                                          │
           ▼                                          ▼
    FOR KEY SHARE → FOR SHARE → FOR NO KEY UPDATE → FOR UPDATE
    (le plus          (lecture     (UPDATE sans       (le plus
     permissif)       partagee)    toucher PK/UK)     restrictif)

    ACCESS SHARE ──────────────────────────► ACCESS EXCLUSIVE
    (SELECT)                                  (DROP TABLE)
```

---

## 2. Deux familles de verrous

PostgreSQL utilise deux familles de verrous très différentes :

| Famille | Granularite | Cree par | Duree |
|---------|------------|----------|-------|
| **Row-level locks** | Une ligne | SELECT ... FOR UPDATE, UPDATE, DELETE | Jusqu'au COMMIT/ROLLBACK |
| **Table-level locks** | Une table entière | SELECT, INSERT, ALTER TABLE, DROP | Jusqu'au COMMIT/ROLLBACK |

> **Point clé** : Les **row-level locks** ne sont PAS stockes en mémoire partagee. Ils sont marques directement dans le tuple (via xmax). C'est pourquoi PostgreSQL peut verrouiller des millions de lignes sans surcharge mémoire.

### Différence avec d'autres SGBD

```
┌──────────────────────────────────────────────────────────────┐
│  MySQL InnoDB : Lock escalation possible                      │
│  (beaucoup de row locks → table lock automatique)            │
│                                                               │
│  PostgreSQL : JAMAIS de lock escalation !                     │
│  Meme 10 millions de row locks restent des row locks.        │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Row-level locks

### 3.1 Les 4 modes de verrouillage de ligne

| Mode | Cree par | Bloque | Cas d'usage |
|------|---------|--------|-------------|
| `FOR KEY SHARE` | FK check | Rien sauf FOR UPDATE sur PK | Vérification FK |
| `FOR SHARE` | Lecture protegee | FOR UPDATE, FOR NO KEY UPDATE | Lire et garantir que la ligne ne change pas |
| `FOR NO KEY UPDATE` | UPDATE sans PK | FOR UPDATE, FOR SHARE | UPDATE de colonnes non-PK |
| `FOR UPDATE` | Verrouillage exclusif | TOUT (sauf FOR KEY SHARE) | Modifier, supprimer |

### 3.2 Matrice de compatibilite (Row-level)

```
                    Lock existant sur la ligne
                    ┌────────────┬────────────┬─────────────────┬─────────────┐
                    │ FOR KEY    │ FOR SHARE  │ FOR NO KEY      │ FOR UPDATE  │
                    │ SHARE      │            │ UPDATE          │             │
┌───────────────────┼────────────┼────────────┼─────────────────┼─────────────┤
│ FOR KEY SHARE     │     ✅     │     ✅     │       ✅        │      ✅     │
│ FOR SHARE         │     ✅     │     ✅     │       ❌        │      ❌     │
│ FOR NO KEY UPDATE │     ✅     │     ❌     │       ❌        │      ❌     │
│ FOR UPDATE        │     ✅     │     ❌     │       ❌        │      ❌     │
└───────────────────┴────────────┴────────────┴─────────────────┴─────────────┘

✅ = Compatible (les deux peuvent coexister)
❌ = Conflit (le deuxieme doit attendre)
```

### 3.3 FOR UPDATE — Le plus courant

```sql
-- Scenario : transfert bancaire
BEGIN;

-- Verrouiller la ligne d'Alice AVANT de lire le solde
SELECT solde FROM comptes
  WHERE id = 1
  FOR UPDATE;
-- solde = 1000

-- Maintenant personne d'autre ne peut modifier cette ligne
UPDATE comptes
  SET solde = solde - 200
  WHERE id = 1;

COMMIT;
-- Lock libere
```

> **Analogie** : FOR UPDATE, c'est comme prendre un livre à la bibliotheque et le poser sur votre table avec un panneau "reserve". Les autres peuvent VOIR qu'il est la, mais personne ne peut le prendre.

### 3.4 FOR SHARE — Verrouillage partage

```sql
-- Scenario : verifier qu'un produit existe avant de creer une commande
BEGIN;

-- Verifier que le produit existe et ne sera pas supprime
SELECT * FROM produits
  WHERE id = 42
  FOR SHARE;
-- Personne ne peut DELETE ou UPDATE ce produit
-- mais d'autres peuvent aussi le FOR SHARE

INSERT INTO commandes (produit_id, quantite)
  VALUES (42, 3);

COMMIT;
```

### 3.5 FOR NO KEY UPDATE

Quand vous faites un UPDATE qui ne touche **pas** la clé primaire ni les colonnes avec UNIQUE, PostgreSQL utilise automatiquement `FOR NO KEY UPDATE` en interne.

```sql
-- Ceci acquiert FOR NO KEY UPDATE en interne :
UPDATE comptes SET solde = 500 WHERE id = 1;
-- Car 'solde' n'est pas une PK ni UNIQUE

-- Ceci acquiert FOR UPDATE en interne :
UPDATE comptes SET id = 999 WHERE id = 1;
-- Car 'id' est la PK
```

L'avantage : `FOR NO KEY UPDATE` ne bloque pas les verifications de FK.

### 3.6 FOR KEY SHARE

Le mode le plus leger. PostgreSQL l'utilise en interne pour les verifications de **foreign keys**.

```sql
-- Quand vous inserez dans une table enfant :
INSERT INTO commandes (produit_id, quantite) VALUES (42, 1);

-- PostgreSQL verifie que le produit 42 existe en acquierant
-- un FOR KEY SHARE sur produits WHERE id = 42
-- Cela ne bloque PAS les UPDATE sur cette ligne
-- (sauf si on modifie la PK du produit)
```

---

## 4. Table-level locks

### 4.1 Les 8 niveaux de locks

Du plus leger au plus lourd :

| # | Mode | Acquis par | Bloque |
|---|------|-----------|--------|
| 1 | `ACCESS SHARE` | `SELECT` | Seulement ACCESS EXCLUSIVE |
| 2 | `ROW SHARE` | `SELECT FOR UPDATE/SHARE` | EXCLUSIVE, ACCESS EXCLUSIVE |
| 3 | `ROW EXCLUSIVE` | `INSERT, UPDATE, DELETE` | SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, ACCESS EXCLUSIVE |
| 4 | `SHARE UPDATE EXCLUSIVE` | `VACUUM, ANALYZE, CREATE INDEX CONCURRENTLY` | Memes + SHARE UPDATE EXCLUSIVE |
| 5 | `SHARE` | `CREATE INDEX (non-concurrent)` | ROW EXCLUSIVE + plus lourds |
| 6 | `SHARE ROW EXCLUSIVE` | `CREATE TRIGGER` | ROW EXCLUSIVE + plus lourds |
| 7 | `EXCLUSIVE` | `REFRESH MATERIALIZED VIEW CONCURRENTLY` | ROW SHARE + plus lourds |
| 8 | `ACCESS EXCLUSIVE` | `ALTER TABLE, DROP TABLE, VACUUM FULL, LOCK TABLE` | **TOUT** |

### 4.2 Matrice de compatibilite (Table-level)

```
                      ACCESS  ROW    ROW     SHARE   SHARE  SHARE    EXCLU-  ACCESS
                      SHARE   SHARE  EXCL.   UPD.EX  .      ROW EX  SIVE    EXCL.
┌────────────────────┬───────┬──────┬───────┬───────┬──────┬────────┬───────┬───────┐
│ ACCESS SHARE       │  ✅   │  ✅  │  ✅   │  ✅   │  ✅  │   ✅   │  ✅   │  ❌   │
│ ROW SHARE          │  ✅   │  ✅  │  ✅   │  ✅   │  ✅  │   ✅   │  ❌   │  ❌   │
│ ROW EXCLUSIVE      │  ✅   │  ✅  │  ✅   │  ✅   │  ❌  │   ❌   │  ❌   │  ❌   │
│ SHARE UPDATE EXCL. │  ✅   │  ✅  │  ✅   │  ❌   │  ❌  │   ❌   │  ❌   │  ❌   │
│ SHARE              │  ✅   │  ✅  │  ❌   │  ❌   │  ✅  │   ❌   │  ❌   │  ❌   │
│ SHARE ROW EXCL.    │  ✅   │  ✅  │  ❌   │  ❌   │  ❌  │   ❌   │  ❌   │  ❌   │
│ EXCLUSIVE          │  ✅   │  ❌  │  ❌   │  ❌   │  ❌  │   ❌   │  ❌   │  ❌   │
│ ACCESS EXCLUSIVE   │  ❌   │  ❌  │  ❌   │  ❌   │  ❌  │   ❌   │  ❌   │  ❌   │
└────────────────────┴───────┴──────┴───────┴───────┴──────┴────────┴───────┴───────┘
```

### 4.3 LOCK TABLE — Verrouillage explicite

```sql
-- Rarement necessaire, mais parfois utile
BEGIN;

LOCK TABLE comptes IN SHARE MODE;
-- Plus personne ne peut INSERT/UPDATE/DELETE
-- mais tout le monde peut SELECT

-- Calculer une somme coherente
SELECT SUM(solde) FROM comptes;

COMMIT;
```

> **Piege classique** : `LOCK TABLE` acquiert un **ACCESS EXCLUSIVE** lock par defaut, ce qui bloque TOUT, même les SELECT. Specifiez toujours le mode explicitement.

```sql
-- DANGEREUX : bloque tout
LOCK TABLE comptes;
-- Equivalent a : LOCK TABLE comptes IN ACCESS EXCLUSIVE MODE;

-- MIEUX : seulement bloquer les ecritures
LOCK TABLE comptes IN SHARE MODE;
```

### 4.4 Impact sur les migrations

```
┌──────────────────────────────────────────────────────────────┐
│  ATTENTION MIGRATION !                                        │
│                                                               │
│  ALTER TABLE ... ADD COLUMN → ACCESS EXCLUSIVE                │
│  = Bloque TOUS les SELECT pendant la migration !             │
│                                                               │
│  Sur une table de 100M de lignes, cela peut durer            │
│  des minutes = downtime !                                     │
│                                                               │
│  Solutions :                                                  │
│  - CREATE INDEX CONCURRENTLY (pas de lock)                   │
│  - ADD COLUMN sans DEFAULT (instantane en PG 11+)            │
│  - Utiliser pg_repack pour eviter VACUUM FULL                │
└──────────────────────────────────────────────────────────────┘
```

---

## 5. pg_locks — Observer les verrous en temps réel

### 5.1 La vue pg_locks

```sql
SELECT
    l.locktype,
    l.relation::regclass AS table_name,
    l.mode,
    l.granted,
    l.pid,
    a.usename,
    a.query,
    a.state,
    age(now(), a.query_start) AS duree
FROM pg_locks l
JOIN pg_stat_activity a ON l.pid = a.pid
WHERE l.relation IS NOT NULL
  AND a.datname = current_database()
ORDER BY a.query_start;
```

### 5.2 Colonnes clés de pg_locks

| Colonne | Description | Exemple |
|---------|-------------|---------|
| `locktype` | Type de verrou | relation, transactionid, advisory |
| `database` | OID de la database | 16384 |
| `relation` | OID de la table | 16389 (caster avec ::regclass) |
| `page` | Numero de page (pour row locks) | 0 |
| `tuple` | Numero de tuple | 1 |
| `virtualxid` | Virtual transaction ID | 3/45 |
| `transactionid` | Transaction ID réel | 12345 |
| `mode` | Mode du lock | RowExclusiveLock |
| `granted` | Lock accorde ? | true/false |
| `pid` | Process ID du backend | 1234 |

### 5.3 Trouver les transactions bloquantes

```sql
-- Requete pour trouver qui bloque qui
SELECT
    blocked.pid AS blocked_pid,
    blocked.usename AS blocked_user,
    blocked.query AS blocked_query,
    blocking.pid AS blocking_pid,
    blocking.usename AS blocking_user,
    blocking.query AS blocking_query,
    age(now(), blocked.query_start) AS blocked_since
FROM pg_stat_activity blocked
JOIN pg_locks bl ON bl.pid = blocked.pid AND NOT bl.granted
JOIN pg_locks gl ON gl.relation = bl.relation
    AND gl.locktype = bl.locktype
    AND gl.pid != bl.pid
    AND gl.granted
JOIN pg_stat_activity blocking ON blocking.pid = gl.pid
WHERE blocked.state = 'active';
```

### 5.4 Vue simplifiee (PostgreSQL 14+)

```sql
-- pg_blocking_pids() : retourne les PIDs bloquants
SELECT
    pid,
    usename,
    pg_blocking_pids(pid) AS blocked_by,
    query,
    state,
    wait_event_type,
    wait_event
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0;
```

---

## 6. pg_stat_activity

La vue `pg_stat_activity` est votre **tableau de bord** pour la concurrence.

### 6.1 Colonnes essentielles

| Colonne | Description | Valeurs courantes |
|---------|-------------|-------------------|
| `pid` | Process ID | 1234 |
| `usename` | Utilisateur | 'myapp' |
| `datname` | Base de donnees | 'production' |
| `state` | État du backend | active, idle, idle in transaction |
| `query` | Derniere requête | 'SELECT ...' |
| `query_start` | Debut de la requête | timestamp |
| `xact_start` | Debut de la transaction | timestamp |
| `wait_event_type` | Type d'attente | Lock, IO, Client |
| `wait_event` | Événement d'attente | relation, transactionid |
| `backend_type` | Type de processus | client backend |

### 6.2 Requetes utiles

```sql
-- Transactions "idle in transaction" (danger !)
SELECT pid, usename, state, query,
       age(now(), xact_start) AS tx_duration
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND age(now(), xact_start) > interval '5 minutes'
ORDER BY xact_start;
```

> **Piege classique** : Une transaction "idle in transaction" maintient ses locks ET empeche VACUUM de nettoyer les tuples morts. C'est un des problèmes les plus courants en production.

```sql
-- Tuer une session bloquante (en dernier recours)
SELECT pg_terminate_backend(1234);

-- Plus doux : annuler seulement la requete
SELECT pg_cancel_backend(1234);
```

### 6.3 Les états d'un backend

```
                 Connexion
                     │
                     ▼
              ┌─────────────┐
              │    idle      │ ← Connecte, ne fait rien
              └──────┬──────┘
                     │ Debut de requete
                     ▼
              ┌─────────────┐
              │   active     │ ← Execute une requete
              └──────┬──────┘
                     │ Requete terminee
                     ├──────────────────┐
                     │                  │
                     ▼                  ▼
              ┌─────────────┐   ┌──────────────────┐
              │    idle      │   │ idle in           │
              │              │   │ transaction       │ ← DANGER
              └─────────────┘   └──────────────────┘
                                        │ Trop longtemps
                                        ▼
                                ┌──────────────────┐
                                │ idle in           │
                                │ transaction       │
                                │ (aborted)         │ ← Erreur non-geree
                                └──────────────────┘
```

---

## 7. NOWAIT et lock_timeout

### 7.1 NOWAIT — Echouer immediatement

```sql
-- Sans NOWAIT : attend indefiniment
BEGIN;
SELECT * FROM comptes WHERE id = 1 FOR UPDATE;
-- Si la ligne est verrouillee, attend... attend... attend...

-- Avec NOWAIT : echoue immediatement
BEGIN;
SELECT * FROM comptes WHERE id = 1 FOR UPDATE NOWAIT;
-- Si la ligne est verrouillee :
-- ERROR: could not obtain lock on row in relation "comptes"
```

### 7.2 lock_timeout — Timeout configurable

```sql
-- Attendre maximum 5 secondes pour un lock
SET lock_timeout = '5s';

BEGIN;
SELECT * FROM comptes WHERE id = 1 FOR UPDATE;
-- Si la ligne est verrouillee et pas liberee en 5s :
-- ERROR: canceling statement due to lock timeout
```

```sql
-- Combiner avec statement_timeout
SET lock_timeout = '5s';       -- Max 5s pour obtenir le lock
SET statement_timeout = '30s'; -- Max 30s pour la requete entiere
```

### 7.3 Node.js : gérer NOWAIT

```typescript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ /* ... */ });

async function reserverProduit(produitId, quantite) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Essayer de verrouiller le produit immediatement
        const { rows } = await client.query(
            `SELECT stock FROM produits
             WHERE id = $1
             FOR UPDATE NOWAIT`,
            [produitId]
        );

        if (rows.length === 0) {
            throw new Error('Produit introuvable');
        }

        if (rows[0].stock < quantite) {
            throw new Error('Stock insuffisant');
        }

        await client.query(
            `UPDATE produits
             SET stock = stock - $1
             WHERE id = $2`,
            [quantite, produitId]
        );

        await client.query('COMMIT');
        return { success: true };
    } catch (error) {
        await client.query('ROLLBACK');

        // Code 55P03 = lock_not_available (NOWAIT)
        if (error.code === '55P03') {
            return {
                success: false,
                reason: 'Le produit est en cours de modification, reessayez.',
            };
        }

        throw error;
    } finally {
        client.release();
    }
}
```

---

## 8. SKIP LOCKED — Le pattern de file d'attente

### 8.1 Principe

`SKIP LOCKED` saute les lignes déjà verrouillees au lieu d'attendre. C'est **parfait** pour implementer une file d'attente (queue).

> **Analogie** : Imaginez un supermarche avec plusieurs caisses. Au lieu de faire la queue derriere quelqu'un, vous allez directement à la caisse libre. `SKIP LOCKED` fait exactement ça : il prend les lignes "libres" et ignore les "occupees".

### 8.2 Exemple : Job queue

```sql
-- Table de jobs
CREATE TABLE jobs (
    id        SERIAL PRIMARY KEY,
    payload   JSONB NOT NULL,
    status    TEXT NOT NULL DEFAULT 'pending',
    locked_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Worker 1 : prendre le prochain job disponible
BEGIN;
SELECT id, payload
FROM jobs
WHERE status = 'pending'
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;

-- Si un job est retourne, le traiter
UPDATE jobs SET status = 'processing', locked_by = 'worker-1'
WHERE id = 42;
COMMIT;

-- Worker 2 (en meme temps) : prend le SUIVANT automatiquement !
BEGIN;
SELECT id, payload
FROM jobs
WHERE status = 'pending'
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;
-- Retourne le job SUIVANT (pas le meme que worker 1)
```

### 8.3 Pattern complet de job queue

```sql
-- Prendre et traiter un batch de jobs
WITH next_jobs AS (
    SELECT id
    FROM jobs
    WHERE status = 'pending'
    ORDER BY created_at
    LIMIT 10
    FOR UPDATE SKIP LOCKED
)
UPDATE jobs
SET status = 'processing',
    locked_by = 'worker-' || pg_backend_pid()
FROM next_jobs
WHERE jobs.id = next_jobs.id
RETURNING jobs.*;
```

### 8.4 Node.js : Worker de jobs

```typescript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ max: 5 });

async function processNextJob() {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Prendre le prochain job disponible
        const { rows } = await client.query(`
            SELECT id, payload
            FROM jobs
            WHERE status = 'pending'
            ORDER BY created_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        `);

        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return null; // Pas de job disponible
        }

        const job = rows[0];

        try {
            // Traiter le job
            await executeJob(job.payload);

            // Marquer comme termine
            await client.query(
                `UPDATE jobs SET status = 'done' WHERE id = $1`,
                [job.id]
            );
        } catch (jobError) {
            // Marquer comme echoue
            await client.query(
                `UPDATE jobs
                 SET status = 'failed',
                     payload = payload || $1::jsonb
                 WHERE id = $2`,
                [JSON.stringify({ error: jobError.message }), job.id]
            );
        }

        await client.query('COMMIT');
        return job;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// Boucle de traitement
async function workerLoop() {
    while (true) {
        const job = await processNextJob();
        if (!job) {
            // Pas de job, attendre un peu
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
}

workerLoop().catch(console.error);
```

---

## 9. Advisory locks — Verrous applicatifs

### 9.1 Concept

Les **advisory locks** sont des verrous "virtuels" qui ne protegent aucune ligne ni table. C'est votre application qui decide de leur signification.

> **Analogie** : Imaginez un panneau "Occupe/Libre" sur une porte. Le panneau n'empeche pas physiquement d'ouvrir la porte — c'est un signal que tout le monde respecte par convention. Les advisory locks fonctionnent de la même façon.

### 9.2 Types d'advisory locks

| Fonction | Type | Bloquant ? | Liberation |
|----------|------|-----------|------------|
| `pg_advisory_lock(key)` | Session | Oui (attend) | `pg_advisory_unlock(key)` ou fin de session |
| `pg_try_advisory_lock(key)` | Session | Non (retourne false) | Idem |
| `pg_advisory_xact_lock(key)` | Transaction | Oui (attend) | Automatique au COMMIT/ROLLBACK |
| `pg_try_advisory_xact_lock(key)` | Transaction | Non (retourne false) | Idem |

### 9.3 Cas d'usage : mutex applicatif

```sql
-- Empêcher deux instances de lancer le même batch
SELECT pg_advisory_lock(hashtext('batch_facturation'));
-- Ici, un seul processus peut executer ce code a la fois

-- ... traitement du batch ...

SELECT pg_advisory_unlock(hashtext('batch_facturation'));
```

### 9.4 Cas d'usage : singleton par entite

```sql
-- Verrouiller le traitement d'un utilisateur specifique
-- (cle composee : type + id)
SELECT pg_advisory_xact_lock(1, 42);
-- 1 = "type: user processing", 42 = user_id

-- Un seul processus traite l'utilisateur 42 a la fois
-- Le lock est libere automatiquement au COMMIT
```

### 9.5 Node.js : advisory lock pattern

```typescript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ max: 10 });

/**
 * Execute une fonction avec un advisory lock.
 * Un seul processus peut executer la fonction pour cette cle.
 */
async function withAdvisoryLock(lockKey, fn) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Essayer d'obtenir le lock (non-bloquant)
        const { rows } = await client.query(
            'SELECT pg_try_advisory_xact_lock($1) AS acquired',
            [lockKey]
        );

        if (!rows[0].acquired) {
            await client.query('ROLLBACK');
            return { skipped: true, reason: 'Lock deja pris' };
        }

        // Lock obtenu — executer la fonction
        const result = await fn(client);

        await client.query('COMMIT');
        // Lock libere automatiquement (xact_lock)

        return { skipped: false, result };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

// Utilisation : un seul worker traite chaque facture
async function genererFacture(factureId) {
    const lockKey = 100000 + factureId; // Namespace pour les factures

    const outcome = await withAdvisoryLock(lockKey, async (client) => {
        // Ce code est garanti de s'executer par un seul process
        const { rows } = await client.query(
            'SELECT * FROM factures WHERE id = $1 AND status = $2',
            [factureId, 'pending']
        );

        if (rows.length === 0) return null;

        // Generer le PDF, envoyer l'email, etc.
        await client.query(
            `UPDATE factures SET status = 'sent' WHERE id = $1`,
            [factureId]
        );

        return rows[0];
    });

    if (outcome.skipped) {
        console.log(`Facture ${factureId} deja en cours de traitement`);
    }
}
```

### 9.6 Observer les advisory locks

```sql
SELECT
    l.classid,
    l.objid,
    l.mode,
    l.granted,
    a.pid,
    a.usename,
    a.query
FROM pg_locks l
JOIN pg_stat_activity a ON l.pid = a.pid
WHERE l.locktype = 'advisory';
```

---

## 10. Deadlock preview

Quand deux transactions se bloquent mutuellement, c'est un **deadlock**. Un apercu rapide avant le module 10 :

```
Transaction A                    Transaction B
─────────────                    ─────────────
BEGIN;                           BEGIN;

UPDATE comptes SET solde = 100   UPDATE comptes SET solde = 200
  WHERE id = 1;                    WHERE id = 2;
-- Lock sur id=1                 -- Lock sur id=2

UPDATE comptes SET solde = 300   UPDATE comptes SET solde = 400
  WHERE id = 2;                    WHERE id = 1;
-- ATTEND le lock sur id=2      -- ATTEND le lock sur id=1
-- (detenu par B)                -- (detenu par A)

-- DEADLOCK !
-- PostgreSQL detecte le cycle apres ~1s (deadlock_timeout)
-- et tue une des deux transactions
```

```
     ┌──────────┐    attend    ┌──────────┐
     │    Tx A   │ ──────────► │  Lock 2   │
     │          │              │ (par B)   │
     └──────────┘              └──────────┘
          ▲                         │
          │                         │
     ┌──────────┐    attend    ┌──────────┐
     │  Lock 1   │ ◄────────── │    Tx B   │
     │ (par A)   │              │          │
     └──────────┘              └──────────┘

     CYCLE = DEADLOCK
```

Nous verrons les details et les stratégies de prevention dans le module 10.

---

## 11. Node.js patterns : FOR UPDATE avec pg

### 11.1 Pattern check-then-act

```typescript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ max: 20 });

// Pattern : verifier + modifier atomiquement
async function decrementerStock(produitId, quantite) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Verifier avec lock
        const { rows } = await client.query(
            `SELECT stock FROM produits
             WHERE id = $1
             FOR UPDATE`,
            [produitId]
        );

        if (rows.length === 0) {
            throw new Error('Produit introuvable');
        }

        const stockActuel = rows[0].stock;

        if (stockActuel < quantite) {
            throw new Error(
                `Stock insuffisant (${stockActuel} < ${quantite})`
            );
        }

        // 2. Modifier (le lock est deja acquis)
        await client.query(
            `UPDATE produits
             SET stock = stock - $1
             WHERE id = $2`,
            [quantite, produitId]
        );

        await client.query('COMMIT');
        return { success: true, nouveauStock: stockActuel - quantite };
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
```

### 11.2 Pattern avec lock_timeout

```typescript
async function modificationAvecTimeout(userId, data) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '3s'");

        const { rows } = await client.query(
            `SELECT * FROM users WHERE id = $1 FOR UPDATE`,
            [userId]
        );

        // ... modification ...

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');

        if (error.code === '55P03') {
            // lock_timeout depasse
            console.warn(`User ${userId} verrouille, retry plus tard`);
        }
        throw error;
    } finally {
        client.release();
    }
}
```

---

## 12. Exercice mental

> **Exercice mental** : Vous avez 100 workers qui traitent des jobs en parallele. Chaque worker fait `SELECT ... FROM jobs WHERE status = 'pending' LIMIT 1 FOR UPDATE`. Que se passe-t-il ? Est-ce performant ? Quelle alternative proposeriez-vous ?

<details>
<summary>Reponse</summary>

**Problème** : Tous les 100 workers vont essayer de verrouiller **la même ligne** (le premier job pending). 99 d'entre eux vont attendre. Quand le premier libere le lock, le 2eme le prend, les 98 autres attendent... C'est un **goulot d'etranglement** (lock contention).

**Solution** : `FOR UPDATE SKIP LOCKED`. Chaque worker prend le prochain job **disponible** (non verrouille). Pas d'attente, pas de contention. Les 100 workers traitent 100 jobs différents en parallele.
</details>

---

## Ce qu'il faut retenir

```
┌──────────────────────────────────────────────────────────────┐
│                    A RETENIR                                  │
│                                                               │
│  1. Row locks : FOR UPDATE > FOR NO KEY UPDATE >             │
│     FOR SHARE > FOR KEY SHARE                                │
│                                                               │
│  2. Table locks : 8 niveaux, ACCESS EXCLUSIVE bloque tout    │
│                                                               │
│  3. NOWAIT : echouer immediatement si verrouille             │
│                                                               │
│  4. SKIP LOCKED : ignorer les lignes verrouillees            │
│     → pattern job queue tres performant                      │
│                                                               │
│  5. Advisory locks : verrous applicatifs personnalises        │
│     → mutex, singleton, rate limiting                        │
│                                                               │
│  6. pg_locks + pg_stat_activity = monitoring des locks        │
│                                                               │
│  7. Attention aux "idle in transaction" !                     │
│                                                               │
│  8. JAMAIS de lock escalation dans PostgreSQL                │
└──────────────────────────────────────────────────────────────┘
```

---

## Navigation

| Précédent | Suivant |
|---|---|
| [Module 08 — Niveaux d'isolation & MVCC](./08-niveaux-isolation.md) | [Module 10 — Deadlocks](./10-deadlocks.md) |

**Travaux pratiques** : [Lab 09 — Manipuler les verrous](../labs/lab-09-locks.md)

---

> *"Un verrou bien place vaut mieux qu'un bug en production. Mais un verrou inutile est un ralentisseur sur une autoroute."*

---

<!-- parcours-recommande -->

::: tip Parcours recommandé
1. **Screencast** : [screencast 09 verrous et locks](../screencasts/screencast-09-verrous-et-locks.md)
2. **Lab** : [lab-09-locks-en-action](../labs/lab-09-locks-en-action/README)
3. **Visualisation** : [Lock Matrix](../visualizations/lock-matrix.html)
4. **Quiz** : [quiz 09 verrous et locks](../quizzes/quiz-09-verrous-et-locks.html)
:::
