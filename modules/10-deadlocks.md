# Module 10 — Deadlocks

> **Objectif** : Comprendre comment les deadlocks se produisent, comment PostgreSQL les detecte et les resout, et surtout comment les **prevenir** dans vos applications.
>
> **Difficulte** : ⭐⭐⭐⭐

---

## 1. Qu'est-ce qu'un deadlock

Un **deadlock** (verrou mortel, interblocage) survient quand deux ou plusieurs transactions s'attendent mutuellement, formant un cycle d'attente dont aucune ne peut sortir.

> **Analogie** : Le carrefour bloque. Quatre voitures arrivent en meme temps a un carrefour sans feux. Chacune attend que celle a sa droite passe. Personne ne bouge. C'est le blocage total. La seule solution : qu'une voiture recule (= ROLLBACK).

```
      ┌─────┐
      │  A  │──────► attend B
      └─────┘              │
         ▲                 ▼
         │            ┌─────┐
         └──── attend │  B  │
                      └─────┘

  A attend une ressource detenue par B.
  B attend une ressource detenue par A.
  AUCUNE des deux ne peut avancer.
  = DEADLOCK
```

### Deadlock vs Simple attente

| Situation | Issue | Probleme ? |
|---|---|---|
| A attend B | B finit → A continue | Non, normal |
| A attend B, B attend A | Personne ne finit | **OUI = Deadlock** |
| A attend B, B attend C, C attend A | Cycle a 3 | **OUI = Deadlock** |

> **Point cle** : Un deadlock implique toujours un **cycle** dans le graphe d'attente. Une simple attente (sans cycle) n'est PAS un deadlock.

---

## 2. Comment un deadlock se produit

### 2.1 Exemple classique : mise a jour croisee

```sql
-- Preparation
CREATE TABLE comptes (
    id    SERIAL PRIMARY KEY,
    nom   TEXT NOT NULL,
    solde NUMERIC(10,2) NOT NULL
);

INSERT INTO comptes (nom, solde) VALUES
    ('Alice', 1000),
    ('Bob', 500);
```

Voici la sequence exacte qui mene au deadlock :

```
Temps  Transaction A                      Transaction B
─────  ──────────────────────             ──────────────────────
t1     BEGIN;                             BEGIN;

t2     UPDATE comptes
         SET solde = solde - 100
         WHERE id = 1;
       -- Lock sur Alice (id=1)  ✅

t3                                        UPDATE comptes
                                            SET solde = solde - 50
                                            WHERE id = 2;
                                          -- Lock sur Bob (id=2)  ✅

t4     UPDATE comptes
         SET solde = solde + 100
         WHERE id = 2;
       -- Veut lock sur Bob (id=2)
       -- MAIS B detient ce lock
       -- → A ATTEND B  ⏳

t5                                        UPDATE comptes
                                            SET solde = solde + 50
                                            WHERE id = 1;
                                          -- Veut lock sur Alice (id=1)
                                          -- MAIS A detient ce lock
                                          -- → B ATTEND A  ⏳

       ════════════════════════════════════════════════════
                        DEADLOCK !
       A attend B et B attend A → cycle detecte
       ════════════════════════════════════════════════════

t6     -- PostgreSQL detecte le deadlock
       -- apres ~1 seconde (deadlock_timeout)
       -- et ROLLBACK une des deux transactions

       -- Transaction A continue :         -- Transaction B recoit :
       -- (ou B, selon le choix de PG)     ERROR: deadlock detected
                                           DETAIL: Process 1234 waits
                                           for ShareLock on transaction
                                           5678; blocked by process 9012.
                                           Process 9012 waits for
                                           ShareLock on transaction 1234;
                                           blocked by process 5678.
                                           HINT: See server log for
                                           query details.
```

### 2.2 Diagramme temporel

```
     Temps ──────────────────────────────────────────►

     Tx A:  ██ Lock(1) ██████████████ Attend(2) ████ Continue...
                                          │
     Tx B:  ████ Lock(2) ████████████████ Attend(1) ██ ROLLBACK!
                                          │    │
                                          └────┘
                                        DEADLOCK
                                       detecte ici
```

---

## 3. Le wait-for graph

### 3.1 Principe

PostgreSQL maintient un **graphe d'attente** (wait-for graph) qui represente quelles transactions attendent quelles autres.

```
     Wait-for graph SANS deadlock        Wait-for graph AVEC deadlock
     (graphe acyclique = OK)             (cycle = DEADLOCK)

         A → B → C                           A → B
                                             ↑   ↓
         D → E                               D ← C

     Personne n'attend en boucle.        A→B→C→D→A = cycle !
```

### 3.2 Detection de cycle

PostgreSQL utilise un algorithme de **detection de cycle** dans ce graphe :

```
┌──────────────────────────────────────────────────────────────┐
│  ALGORITHME DE DETECTION DE DEADLOCK                          │
│                                                               │
│  1. Un process est bloque → il attend un lock                │
│  2. Apres deadlock_timeout (defaut 1s), PostgreSQL           │
│     lance la detection                                        │
│  3. Construction du wait-for graph                           │
│  4. Recherche de cycle (DFS)                                 │
│  5. Si cycle trouve → choisir une victime → ROLLBACK         │
│  6. Si pas de cycle → continuer a attendre                   │
└──────────────────────────────────────────────────────────────┘
```

### 3.3 Pourquoi attendre avant de detecter ?

| Approche | Avantage | Inconvenient |
|---|---|---|
| Detecter immediatement | Deadlocks resolus vite | Surcout CPU constant |
| Attendre deadlock_timeout | Pas de surcout si pas de deadlock | Delai de detection |

> **Point cle** : La plupart des attentes ne sont PAS des deadlocks (juste une transaction qui attend un lock normal). Attendre `deadlock_timeout` evite de lancer la detection couteuse a chaque attente.

---

## 4. Resolution par PostgreSQL

### 4.1 Choix de la victime

Quand PostgreSQL detecte un deadlock, il doit choisir **quelle transaction tuer**. Le choix est base sur des criteres internes (generalement la transaction qui a declenche la detection, c'est-a-dire celle qui a attendu le plus longtemps sans succes).

> **Piege classique** : Vous ne pouvez PAS controler quelle transaction sera tuee. Ne comptez jamais sur un comportement specifique du choix de victime.

### 4.2 Le message d'erreur

```
ERROR: deadlock detected
DETAIL: Process 12345 waits for ShareLock on transaction 67890;
        blocked by process 11111.
        Process 11111 waits for ShareLock on transaction 12345;
        blocked by process 12345.
HINT: See server log for query details.
CONTEXT: while updating tuple (0,1) in relation "comptes"
```

### 4.3 Dans les logs PostgreSQL

```
LOG: process 12345 detected deadlock while waiting for ShareLock
     on transaction 67890 after 1000.123 ms
DETAIL: Process holding the lock: 11111. Wait queue: .
CONTEXT: while updating tuple (0,1) in relation "comptes"
STATEMENT: UPDATE comptes SET solde = solde + 50 WHERE id = 1
LOG: process 12345 still waiting for ShareLock on transaction 67890
     after 1000.123 ms
```

### 4.4 Que se passe-t-il apres ?

```
                     Deadlock detecte
                           │
                ┌──────────┴──────────┐
                │                     │
         Transaction A           Transaction B
         (survivante)            (victime)
                │                     │
                ▼                     ▼
         Debloquee,            ROLLBACK force
         continue              (code erreur 40P01)
         normalement                  │
                │                     ▼
                ▼              L'application doit
          COMMIT ok            REESSAYER la transaction
```

---

## 5. Reproduire un deadlock en SQL

Voici un script pas-a-pas pour reproduire un deadlock. Vous aurez besoin de **deux terminaux** connectes a la meme base.

### Terminal 1

```sql
-- Etape 1 : Commencer la transaction
BEGIN;

-- Etape 2 : Verrouiller la ligne id=1
UPDATE comptes SET solde = 900 WHERE id = 1;
-- OK, lock acquis sur id=1

-- Etape 4 : (APRES que Terminal 2 a fait l'etape 3)
-- Essayer de verrouiller la ligne id=2
UPDATE comptes SET solde = 600 WHERE id = 2;
-- BLOQUE ! Attend le lock de Terminal 2 sur id=2

-- (Attendre le resultat...)
-- Si c'est la victime : ERROR: deadlock detected
-- Si c'est le survivant : la requete aboutit
```

### Terminal 2

```sql
-- Etape 3 : (APRES que Terminal 1 a fait l'etape 2)
BEGIN;

-- Verrouiller la ligne id=2
UPDATE comptes SET solde = 400 WHERE id = 2;
-- OK, lock acquis sur id=2

-- Etape 5 : (APRES que Terminal 1 a fait l'etape 4)
-- Essayer de verrouiller la ligne id=1
UPDATE comptes SET solde = 1100 WHERE id = 1;
-- BLOQUE ! Attend le lock de Terminal 1 sur id=1

-- DEADLOCK ! Un des deux terminaux recoit l'erreur.
```

### Sequence temporelle

```
T1: BEGIN ──► UPDATE id=1 ──────────────────► UPDATE id=2 (BLOQUE)
                                                      │
T2: ─────────────────── BEGIN ──► UPDATE id=2 ──► UPDATE id=1 (BLOQUE)
                                                      │
                                                DEADLOCK apres ~1s
```

---

## 6. Reproduire un deadlock en Node.js

```javascript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
    host: 'localhost',
    database: 'testdb',
    max: 10,
});

/**
 * Demonstration d'un deadlock avec deux clients concurrents.
 */
async function provoquerDeadlock() {
    const clientA = await pool.connect();
    const clientB = await pool.connect();

    try {
        // Les deux transactions commencent
        await clientA.query('BEGIN');
        await clientB.query('BEGIN');

        console.log('A: Lock sur id=1...');
        await clientA.query(
            'UPDATE comptes SET solde = 900 WHERE id = 1'
        );
        console.log('A: Lock sur id=1 obtenu');

        console.log('B: Lock sur id=2...');
        await clientB.query(
            'UPDATE comptes SET solde = 400 WHERE id = 2'
        );
        console.log('B: Lock sur id=2 obtenu');

        // Maintenant les deux essaient de verrouiller la ligne de l'autre
        // → DEADLOCK imminent

        console.log('A: Essaie de lock id=2 (detenu par B)...');
        console.log('B: Essaie de lock id=1 (detenu par A)...');

        // Lancer les deux en parallele
        const results = await Promise.allSettled([
            clientA.query('UPDATE comptes SET solde = 600 WHERE id = 2'),
            clientB.query('UPDATE comptes SET solde = 1100 WHERE id = 1'),
        ]);

        for (const [index, result] of results.entries()) {
            const name = index === 0 ? 'A' : 'B';
            if (result.status === 'fulfilled') {
                console.log(`${name}: UPDATE reussi`);
            } else {
                console.log(`${name}: ERREUR - ${result.reason.message}`);
                // "deadlock detected"
            }
        }
    } finally {
        // Nettoyer
        await clientA.query('ROLLBACK').catch(() => {});
        await clientB.query('ROLLBACK').catch(() => {});
        clientA.release();
        clientB.release();
    }
}

provoquerDeadlock()
    .then(() => console.log('Demo terminee'))
    .catch(console.error)
    .finally(() => pool.end());
```

Sortie attendue :

```
A: Lock sur id=1...
A: Lock sur id=1 obtenu
B: Lock sur id=2...
B: Lock sur id=2 obtenu
A: Essaie de lock id=2 (detenu par B)...
B: Essaie de lock id=1 (detenu par A)...
B: ERREUR - deadlock detected
A: UPDATE reussi
Demo terminee
```

---

## 7. Strategies de prevention

### 7.1 Lock ordering — La regle d'or

> **Regle d'or** : Toujours acquérir les locks dans le **meme ordre**. Si tout le monde verrouille d'abord id=1, puis id=2, il n'y a JAMAIS de cycle.

```sql
-- MAUVAIS : ordre different selon la transaction
-- Tx A : lock 1 puis 2
-- Tx B : lock 2 puis 1
-- → DEADLOCK possible !

-- BON : toujours le meme ordre (par id croissant)
-- Tx A : lock 1 puis 2
-- Tx B : lock 1 puis 2
-- → Jamais de deadlock !
```

> **Analogie** : Dans un escalier etroit, si tout le monde monte a droite et descend a gauche, personne ne se bloque. Les deadlocks arrivent quand les gens montent et descendent du meme cote.

```javascript
// Node.js : trier les IDs avant de les verrouiller
async function transfert(fromId, toId, montant) {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // LOCK ORDERING : toujours du plus petit au plus grand ID
        const [firstId, secondId] = [fromId, toId].sort((a, b) => a - b);

        // Verrouiller dans l'ordre
        await client.query(
            'SELECT 1 FROM comptes WHERE id = $1 FOR UPDATE',
            [firstId]
        );
        await client.query(
            'SELECT 1 FROM comptes WHERE id = $1 FOR UPDATE',
            [secondId]
        );

        // Maintenant faire le transfert
        await client.query(
            'UPDATE comptes SET solde = solde - $1 WHERE id = $2',
            [montant, fromId]
        );
        await client.query(
            'UPDATE comptes SET solde = solde + $1 WHERE id = $2',
            [montant, toId]
        );

        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
```

### 7.2 Reduire la duree des transactions

Plus une transaction est longue, plus elle a de chances de croiser le chemin d'une autre.

```
┌──────────────────────────────────────────────────────────────┐
│  TRANSACTION COURTE (ms)         TRANSACTION LONGUE (min)    │
│                                                               │
│  ██ BEGIN ██ WORK ██ COMMIT     ██ BEGIN ██████████████████   │
│                                  │  attente réseau...         │
│  Fenetre de conflit :            │  traitement JS...          │
│  tres petite                     │  autre query...            │
│                                  ██████████████████ COMMIT    │
│                                                               │
│                                  Fenetre de conflit :         │
│                                  ENORME                       │
└──────────────────────────────────────────────────────────────┘
```

**Regles pratiques** :

| Faire | Ne pas faire |
|-------|-------------|
| Preparer les donnees AVANT BEGIN | Calculer en JS dans une transaction |
| Minimiser les operations dans la tx | Appeler des APIs externes dans une tx |
| COMMIT des que possible | Laisser une tx "idle in transaction" |
| Utiliser des timeouts | Attendre une action utilisateur dans une tx |

### 7.3 NOWAIT pour echouer vite

```sql
-- Au lieu d'attendre indefiniment (risque de deadlock)
SELECT * FROM comptes WHERE id = 1 FOR UPDATE;

-- Echouer immediatement si la ligne est verrouillee
SELECT * FROM comptes WHERE id = 1 FOR UPDATE NOWAIT;
-- ERROR: could not obtain lock on row (si verrouille)
```

### 7.4 SKIP LOCKED pour eviter l'attente

```sql
-- Au lieu de verrouiller une ligne specifique
-- prendre la premiere ligne DISPONIBLE
SELECT * FROM jobs
WHERE status = 'pending'
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;
-- Pas de deadlock possible ! (pas d'attente)
```

### 7.5 Advisory locks comme alternative

```sql
-- Au lieu de :
BEGIN;
SELECT * FROM comptes WHERE id = 1 FOR UPDATE; -- peut deadlock
-- ... operations ...
COMMIT;

-- Utiliser un advisory lock :
SELECT pg_advisory_lock(1); -- lock sur la "ressource 1"
BEGIN;
-- ... operations sur le compte 1 ...
COMMIT;
SELECT pg_advisory_unlock(1);
-- Pas de deadlock si l'ordre est respecte
```

### 7.6 Utiliser une seule requete au lieu de deux

```sql
-- RISQUE DE DEADLOCK : deux operations separees
BEGIN;
UPDATE comptes SET solde = solde - 100 WHERE id = 1;
UPDATE comptes SET solde = solde + 100 WHERE id = 2;
COMMIT;

-- SANS RISQUE : une seule requete (PostgreSQL gere l'ordre interne)
UPDATE comptes
SET solde = CASE
    WHEN id = 1 THEN solde - 100
    WHEN id = 2 THEN solde + 100
END
WHERE id IN (1, 2);
```

> **Piege classique** : Cette astuce ne garantit PAS l'absence de deadlock si d'autres transactions font des UPDATE sur les memes lignes. Mais elle reduit considerablement le risque.

---

## 8. deadlock_timeout — Configuration

### 8.1 Le parametre

```sql
-- Voir la valeur actuelle
SHOW deadlock_timeout;
-- 1s (defaut)

-- Modifier pour la session
SET deadlock_timeout = '500ms';

-- Modifier globalement (necessite reload)
ALTER SYSTEM SET deadlock_timeout = '2s';
SELECT pg_reload_conf();
```

### 8.2 Comment choisir la valeur

| Valeur | Avantage | Inconvenient |
|--------|----------|-------------|
| 100ms | Detection rapide | CPU utilise pour des attentes normales |
| 1s (defaut) | Bon compromis | 1s d'attente avant detection |
| 5s | Moins de fausses alertes | 5s de blocage avant resolution |

> **Recommandation** : Gardez la valeur par defaut (1s) sauf si vous avez des benchmarks prouvant qu'une autre valeur est meilleure pour votre workload.

### 8.3 Ce qui se passe chronologiquement

```
t=0      Transaction A bloquee (attend un lock)
         │
         │ PostgreSQL attend deadlock_timeout
         │ avant de lancer la detection
         │
t=1s     Lancement de la detection de deadlock
         │
         ├── Pas de cycle ? → Continuer a attendre
         │
         └── Cycle detecte ? → ROLLBACK de la victime
                               (ERROR: deadlock detected)
```

---

## 9. Monitoring des deadlocks

### 9.1 pg_stat_database

```sql
-- Nombre de deadlocks par base de donnees
SELECT
    datname,
    deadlocks,
    conflicts,
    temp_files,
    blk_read_time,
    blk_write_time
FROM pg_stat_database
WHERE datname = current_database();
```

| Colonne | Description |
|---------|-------------|
| `deadlocks` | Nombre total de deadlocks detectes depuis le dernier reset |
| `conflicts` | Conflits de recovery (standby) |

```sql
-- Resetr les compteurs
SELECT pg_stat_reset();
```

### 9.2 Configuration des logs

```sql
-- Dans postgresql.conf
-- log_lock_waits = on
-- (logue les attentes > deadlock_timeout, meme sans deadlock)

-- Activer dynamiquement
ALTER SYSTEM SET log_lock_waits = on;
SELECT pg_reload_conf();
```

Avec `log_lock_waits = on`, vous verrez dans les logs :

```
LOG: process 12345 still waiting for ShareLock on transaction 67890
     after 1000.123 ms
DETAIL: Process holding the lock: 11111. Wait queue: .
CONTEXT: while updating tuple (0,1) in relation "comptes"
STATEMENT: UPDATE comptes SET solde = solde + 50 WHERE id = 1
```

### 9.3 Requete de monitoring en temps reel

```sql
-- Voir les processus en attente de lock
SELECT
    pid,
    usename,
    pg_blocking_pids(pid) AS blocked_by,
    wait_event_type,
    wait_event,
    state,
    query,
    age(now(), query_start) AS waiting_since
FROM pg_stat_activity
WHERE wait_event_type = 'Lock'
ORDER BY query_start;
```

### 9.4 Alerting sur les deadlocks

```javascript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ /* ... */ });

// Verifier periodiquement les deadlocks
async function checkDeadlocks() {
    const { rows } = await pool.query(`
        SELECT deadlocks
        FROM pg_stat_database
        WHERE datname = current_database()
    `);

    const count = rows[0].deadlocks;
    console.log(`Deadlocks detectes : ${count}`);

    // Alerter si > seuil
    if (count > 10) {
        console.warn(`ALERTE : ${count} deadlocks detectes !`);
        // Envoyer une notification...
    }
}

// Verifier toutes les 30 secondes
setInterval(checkDeadlocks, 30_000);
```

---

## 10. Deadlocks avec INSERT

### 10.1 Unique constraints

```sql
CREATE TABLE users (
    id    SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL
);
```

Un deadlock peut survenir quand deux transactions inserent des valeurs qui violent une contrainte UNIQUE :

```
Transaction A                          Transaction B
─────────────                          ─────────────
BEGIN;                                 BEGIN;

INSERT INTO users (email)              INSERT INTO users (email)
  VALUES ('alice@test.com');             VALUES ('bob@test.com');
-- OK                                  -- OK

INSERT INTO users (email)              INSERT INTO users (email)
  VALUES ('bob@test.com');               VALUES ('alice@test.com');
-- ATTEND (unique check                -- ATTEND (unique check
-- sur bob@test.com,                    -- sur alice@test.com,
-- B detient le lock)                   -- A detient le lock)

-- DEADLOCK !
```

### 10.2 Foreign keys

```sql
CREATE TABLE parents (id SERIAL PRIMARY KEY);
CREATE TABLE enfants (
    id        SERIAL PRIMARY KEY,
    parent_id INT REFERENCES parents(id)
);
```

L'INSERT dans `enfants` acquiert un `FOR KEY SHARE` sur la ligne parente. Si deux transactions inserent des enfants pour des parents differents et que les parents sont aussi modifies, un deadlock est possible.

### 10.3 Prevention pour les INSERTs

```sql
-- 1. Inserer dans un ordre deterministe
-- (trier les valeurs avant l'insert batch)

-- 2. Utiliser ON CONFLICT pour eviter les locks sur unique
INSERT INTO users (email, name)
VALUES ('alice@test.com', 'Alice')
ON CONFLICT (email) DO UPDATE
SET name = EXCLUDED.name;
-- Pas de deadlock car ON CONFLICT gere le conflit atomiquement
```

---

## 11. Deadlocks avec DDL

### 11.1 ALTER TABLE concurrent

```
Transaction A                         Transaction B
─────────────                         ─────────────
BEGIN;                                BEGIN;

SELECT * FROM orders                  ALTER TABLE orders
  WHERE id = 1;                         ADD COLUMN notes TEXT;
-- ACCESS SHARE lock                  -- Attend ACCESS EXCLUSIVE lock
                                      -- (bloque par A)

ALTER TABLE customers                 SELECT * FROM customers
  ADD COLUMN notes TEXT;                WHERE id = 1;
-- Attend ACCESS EXCLUSIVE lock       -- Veut ACCESS SHARE lock
-- (bloque si B detient un            -- (bloque par A si...)
-- lock sur customers)

-- Potentiel DEADLOCK selon le timing
```

### 11.2 Prevention pour les DDL

```
┌──────────────────────────────────────────────────────────────┐
│  REGLES POUR LES MIGRATIONS DDL                              │
│                                                               │
│  1. TOUJOURS utiliser un lock_timeout pour les DDL           │
│     SET lock_timeout = '5s';                                 │
│     ALTER TABLE ...;                                         │
│                                                               │
│  2. Eviter les transactions longues qui melangent            │
│     DDL et DML                                               │
│                                                               │
│  3. Utiliser CREATE INDEX CONCURRENTLY                       │
│     (pas de lock exclusif)                                   │
│                                                               │
│  4. Planifier les grosses migrations pendant les             │
│     periodes creuses                                         │
└──────────────────────────────────────────────────────────────┘
```

---

## 12. Patterns avances : batch processing sans deadlocks

### 12.1 Le probleme du batch

Quand vous traitez des lots de lignes, les deadlocks sont frequents si les lots se chevauchent.

```javascript
// MAUVAIS : deadlock probable entre workers
async function processBatch(ids) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const id of ids) {
            await client.query(
                'UPDATE items SET processed = true WHERE id = $1',
                [id]
            );
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

// Worker 1 : processBatch([1, 2, 3, 4, 5])
// Worker 2 : processBatch([3, 7, 1, 9, 2])
// → Deadlock probable ! (ordres differents pour les memes IDs)
```

### 12.2 Solution 1 : Trier les IDs

```javascript
// BON : trier les IDs pour un lock ordering coherent
async function processBatchSafe(ids) {
    const sortedIds = [...ids].sort((a, b) => a - b);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const id of sortedIds) {
            await client.query(
                'UPDATE items SET processed = true WHERE id = $1',
                [id]
            );
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}
```

### 12.3 Solution 2 : Une seule requete

```javascript
async function processBatchOneQuery(ids) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Une seule requete pour tout le batch
        await client.query(
            `UPDATE items
             SET processed = true
             WHERE id = ANY($1::int[])`,
            [ids]
        );

        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}
```

### 12.4 Solution 3 : SKIP LOCKED pour le partitionnement

```javascript
async function processNextBatch(batchSize) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Chaque worker prend un lot NON-VERROUILLE
        const { rows } = await client.query(
            `WITH batch AS (
                SELECT id
                FROM items
                WHERE processed = false
                ORDER BY id
                LIMIT $1
                FOR UPDATE SKIP LOCKED
            )
            UPDATE items
            SET processed = true
            FROM batch
            WHERE items.id = batch.id
            RETURNING items.*`,
            [batchSize]
        );

        await client.query('COMMIT');
        return rows;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}
```

### 12.5 Solution 4 : Retry pattern avec backoff

```javascript
async function withDeadlockRetry(fn, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            const isDeadlock = error.code === '40P01';
            const isSerializationFailure = error.code === '40001';

            if ((isDeadlock || isSerializationFailure) && attempt < maxRetries) {
                const delay = Math.random() * 100 * Math.pow(2, attempt);
                console.warn(
                    `Deadlock/serialization failure, attempt ${attempt}/${maxRetries}, ` +
                    `retrying in ${Math.round(delay)}ms`
                );
                await new Promise((r) => setTimeout(r, delay));
                continue;
            }

            throw error;
        }
    }
}

// Utilisation
await withDeadlockRetry(() => processBatch([1, 2, 3]));
```

### 12.6 Comparaison des solutions

| Solution | Complexite | Performance | Garantie no-deadlock |
|----------|-----------|-------------|---------------------|
| Lock ordering (tri) | Faible | Bonne | Oui (si tout le monde trie) |
| Single query | Faible | Tres bonne | Ameliore mais pas garanti |
| SKIP LOCKED | Moyenne | Excellente | Oui |
| Retry pattern | Faible | Variable | Non (mais resilient) |
| Advisory locks | Moyenne | Bonne | Oui |

---

## 13. Exercice mental

> **Exercice mental** : Trois transactions A, B et C operent sur les lignes 1, 2 et 3. A verrouille 1 puis veut 2. B verrouille 2 puis veut 3. C verrouille 3 puis veut 1. Y a-t-il un deadlock ? PostgreSQL peut-il le detecter ?

<details>
<summary>Reponse</summary>

**Oui, c'est un deadlock a 3 participants** :
- A attend B (pour la ligne 2)
- B attend C (pour la ligne 3)
- C attend A (pour la ligne 1)
- Cycle : A → B → C → A

PostgreSQL **detecte** les cycles de toute longueur dans le wait-for graph. Il choisira une victime parmi les trois et fera ROLLBACK de cette transaction. Les deux autres pourront continuer.

**Prevention** : Si les trois transactions triaient leurs IDs (1, 2, 3), elles essaieraient toutes de verrouiller 1 en premier. Seule une y parviendrait, les autres attendraient. Pas de cycle possible.
</details>

---

## Ce qu'il faut retenir

```
┌──────────────────────────────────────────────────────────────┐
│                    A RETENIR                                  │
│                                                               │
│  1. Deadlock = cycle dans le graphe d'attente                │
│                                                               │
│  2. PostgreSQL detecte et resout automatiquement             │
│     (ROLLBACK de la victime)                                 │
│                                                               │
│  3. PREVENTION > DETECTION :                                 │
│     - Lock ordering (regle d'or)                             │
│     - Transactions courtes                                   │
│     - NOWAIT / SKIP LOCKED                                   │
│     - Single query quand possible                            │
│                                                               │
│  4. deadlock_timeout = 1s par defaut                         │
│                                                               │
│  5. Toujours implementer un retry pattern                    │
│     pour les erreurs 40P01 et 40001                          │
│                                                               │
│  6. Monitorer via pg_stat_database.deadlocks                 │
│     et log_lock_waits = on                                   │
└──────────────────────────────────────────────────────────────┘
```

---

## Navigation

| Precedent | Suivant |
|---|---|
| [Module 09 — Verrous & Locks](./09-verrous-et-locks.md) | [Module 11 — Performances & Optimisation](./11-performances-et-optimisation.md) |

**Travaux pratiques** : [Lab 10 — Provoquer et resoudre des deadlocks](../labs/lab-10-deadlocks.md)

---

> *"Le meilleur deadlock est celui qui ne se produit jamais. Le deuxieme meilleur est celui qui est detecte et retente automatiquement."*
