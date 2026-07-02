# Lab 09 — Locks en action

> Module associé : [09 — Verrous et locks](../../modules/09-verrous-et-locks.md)

## Objectifs

Reproduire les scénarios de verrouillage TribuZen en deux sessions psql concurrentes : réservation d'une place avec `FOR UPDATE`, observation de la contention dans `pg_locks`, `NOWAIT`, `SKIP LOCKED` sur une file de notifications, et advisory lock sur un événement.

## Prérequis

- PostgreSQL 17 : `docker run --rm -e POSTGRES_PASSWORD=pass -p 5432:5432 --name pg17 postgres:17`
- 2 ou 3 terminaux psql : `psql -h localhost -U postgres`
- Convention : **Session A** = terminal 1, **Session B** = terminal 2, **Session obs** = terminal 3 (pg_locks uniquement)

---

## Setup — schéma et données

Exécute dans un terminal unique avant de commencer les exercices.

```sql
CREATE TABLE evenements (
    id               SERIAL PRIMARY KEY,
    titre            TEXT NOT NULL,
    places_totales   INT NOT NULL,
    places_restantes INT NOT NULL CHECK (places_restantes >= 0)
);

CREATE TABLE reservations (
    id            SERIAL PRIMARY KEY,
    evenement_id  INT NOT NULL REFERENCES evenements(id),
    membre_id     TEXT NOT NULL,
    reservee_le   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE notifications (
    id         SERIAL PRIMARY KEY,
    membre_id  TEXT NOT NULL,
    contenu    TEXT NOT NULL,
    statut     TEXT NOT NULL DEFAULT 'pending'
);

INSERT INTO evenements (titre, places_totales, places_restantes) VALUES
    ('Pique-nique famille Martin', 8, 1),
    ('Réunion de rentrée TribuZen', 20, 20);

INSERT INTO notifications (membre_id, contenu)
SELECT 'u-' || i, 'Rappel : événement demain'
FROM generate_series(1, 12) i;
```

---

## Exercice 1 — FOR UPDATE : contention sur la dernière place

**Contexte** : l'événement 1 n'a plus qu'une place. Sessions A et B tentent de la réserver simultanément.

### TODO

Exécute les étapes dans l'ordre en alternant les terminaux.

| Étape | Session A | Session B |
|-------|-----------|-----------|
| 1 | `BEGIN;` | |
| 2 | `SELECT places_restantes FROM evenements WHERE id = 1 FOR UPDATE;` | |
| 3 | | `BEGIN;` |
| 4 | | `SELECT places_restantes FROM evenements WHERE id = 1 FOR UPDATE;` → que se passe-t-il ? |
| 5 | `UPDATE evenements SET places_restantes = places_restantes - 1 WHERE id = 1;` | |
| 6 | `INSERT INTO reservations (evenement_id, membre_id) VALUES (1, 'u-1');` | |
| 7 | `COMMIT;` | (Session B se débloque → quel est `places_restantes` ?) |
| 8 | | `ROLLBACK;` (plus de place disponible) |

### Corrigé

```sql
-- Session A
BEGIN;
SELECT places_restantes FROM evenements WHERE id = 1 FOR UPDATE;
-- → places_restantes = 1 ; verrou exclusif acquis sur la ligne id=1
-- Session B est maintenant BLOQUÉE sur son SELECT FOR UPDATE (prompt gelé)

UPDATE evenements SET places_restantes = places_restantes - 1 WHERE id = 1;
INSERT INTO reservations (evenement_id, membre_id) VALUES (1, 'u-1');
COMMIT;
-- Session B se débloque automatiquement, relit la ligne : places_restantes = 0

-- Session B (après déblocage)
-- La valeur lue après déblocage est 0 → la garde métier annule
ROLLBACK;

-- Vérification
SELECT COUNT(*) FROM reservations WHERE evenement_id = 1;
-- → 1 (une seule réservation, pas de surbooking)
```

**Ce que tu dois observer** : Session B reste bloquée (prompt gelé) jusqu'au `COMMIT` de A. Après déblocage, B lit `places_restantes = 0` — la contrainte `CHECK` bloquerait le décrément, mais la garde applicative doit l'anticiper en retournant un message clair à l'utilisateur.

---

## Exercice 2 — Observer pg_locks en live

Refais l'exercice 1 en gardant la transaction A ouverte (ne pas encore COMMIT). Ouvre un troisième terminal.

### TODO

Dans **Session obs** (terminal 3), pendant que Session A tient le `FOR UPDATE` et Session B est bloquée :

```sql
-- Tous les locks actifs avec contexte
SELECT
    l.locktype,
    l.relation::regclass AS table_name,
    l.mode,
    l.granted,
    l.pid,
    left(a.query, 60) AS query
FROM pg_locks l
JOIN pg_stat_activity a ON l.pid = a.pid
WHERE l.relation IS NOT NULL
  AND a.datname = current_database()
ORDER BY l.granted DESC, a.query_start;
```

Puis utilise la forme courte pour trouver directement le bloquant :

```sql
SELECT
    blocked.pid           AS pid_bloque,
    left(blocked.query, 50)  AS requete_bloquee,
    blocking.pid          AS pid_bloquant,
    left(blocking.query, 50) AS requete_bloquante
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking
    ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0;
```

Questions : quelles lignes montrent `granted = false` ? Quel `mode` vois-tu sur la table `evenements` ? Où est le verrou de ligne lui-même ?

### Corrigé

```sql
-- Résultat attendu dans pg_locks (extrait) :
--  locktype | table_name  | mode            | granted | pid  | query
-- ----------+-------------+-----------------+---------+------+----------------------------------------
--  relation | evenements  | RowShareLock    | t       | 1234 | SELECT places_restantes FROM evenements...
--  relation | evenements  | RowShareLock    | f       | 5678 | SELECT places_restantes FROM evenements...
--  relation | reservations| RowExclusiveLock| t       | 1234 | INSERT INTO reservations...
-- (plus des entrées locktype=transactionid pour chaque transaction)

-- pg_blocking_pids :
--  pid_bloque=5678 (Session B) bloquée par pid_bloquant=1234 (Session A)
```

**Clés de lecture** : `granted = true` = verrou détenu ; `granted = false` = verrou en attente (session bloquée). Le `RowShareLock` sur la table est le table lock posé automatiquement par `SELECT FOR UPDATE`. Le verrou de ligne lui-même est stocké dans le tuple (`xmax`) — il n'apparaît pas dans `pg_locks` comme entrée séparée, mais son effet (blocage) est visible via le `transactionid` lock en attente.

---

## Exercice 3 — NOWAIT : réponse immédiate si verrou impossible

### TODO

```sql
-- Session A : ouvrir une transaction et verrouiller l'événement 1 (ne pas COMMIT)
BEGIN;
SELECT places_restantes FROM evenements WHERE id = 1 FOR UPDATE;

-- Session B : tenter NOWAIT pendant que A est ouvert
BEGIN;
SELECT places_restantes FROM evenements WHERE id = 1 FOR UPDATE NOWAIT;
-- Que reçois-tu ?
ROLLBACK;

-- Session A : libérer
ROLLBACK;
```

Ensuite, teste le délai configurable :

```sql
-- Session A
BEGIN;
SELECT places_restantes FROM evenements WHERE id = 1 FOR UPDATE;

-- Session B : attendre 2 secondes puis échouer
BEGIN;
SET LOCAL lock_timeout = '2s';
SELECT places_restantes FROM evenements WHERE id = 1 FOR UPDATE;
-- Que se passe-t-il après 2 secondes ?
ROLLBACK;

-- Session A
ROLLBACK;
```

### Corrigé

```sql
-- Session B avec NOWAIT reçoit immédiatement :
-- ERROR:  could not obtain lock on row in relation "evenements"
-- SQLSTATE: 55P03 (lock_not_available)
-- Aucune attente. L'API peut retourner HTTP 409 immédiatement.

-- Session B avec lock_timeout = '2s' reçoit après ~2 s :
-- ERROR:  canceling statement due to lock timeout
-- SQLSTATE: 55P03 — même code, même traitement côté application
```

**Quand utiliser lequel** : `NOWAIT` pour les APIs temps réel (réservation interactive — l'utilisateur ne doit pas attendre) ; `lock_timeout` pour les traitements batch qui peuvent tolérer quelques secondes d'attente avant de retenter.

---

## Exercice 4 — SKIP LOCKED : file de notifications sans contention

**Contexte** : deux workers envoient des notifications TribuZen en parallèle. Sans `SKIP LOCKED`, les deux prendraient la même notification. Avec `SKIP LOCKED`, chacun prend son propre lot.

### TODO

```sql
-- Session A (Worker 1) : prendre les 5 premières notifications disponibles
BEGIN;
-- TODO : écrire une requête qui sélectionne et marque atomiquement 5 notifications
--        statut 'pending' → 'en_cours' avec SKIP LOCKED
--        (ne pas COMMIT encore)

-- Session B (Worker 2) — pendant que A est ouvert :
BEGIN;
-- TODO : même requête → quels ids obtient-on ?
COMMIT;

-- Session A
COMMIT;

-- Vérification
SELECT id, statut FROM notifications ORDER BY id;
```

### Corrigé

```sql
-- Session A (Worker 1)
BEGIN;

WITH batch AS (
    SELECT id
    FROM notifications
    WHERE statut = 'pending'
    ORDER BY id
    LIMIT 5
    FOR UPDATE SKIP LOCKED
)
UPDATE notifications
SET statut = 'en_cours'
FROM batch
WHERE notifications.id = batch.id
RETURNING notifications.id, notifications.membre_id;
-- → ids 1, 2, 3, 4, 5 — verrouillés et passés à 'en_cours' atomiquement
-- (ne pas COMMIT encore)

-- Session B (Worker 2) — pendant que A est ouvert
BEGIN;

WITH batch AS (
    SELECT id
    FROM notifications
    WHERE statut = 'pending'
    ORDER BY id
    LIMIT 5
    FOR UPDATE SKIP LOCKED
)
UPDATE notifications
SET statut = 'en_cours'
FROM batch
WHERE notifications.id = batch.id
RETURNING notifications.id, notifications.membre_id;
-- → ids 6, 7, 8, 9, 10 (ids 1-5 de A sont verrouillés → skippés automatiquement)
COMMIT;

-- Session A
COMMIT;

-- Vérification
SELECT id, statut FROM notifications ORDER BY id;
-- ids 1-10 : 'en_cours' | ids 11-12 : 'pending'
-- Aucun doublon, aucune attente, 10 notifications traitées en parallèle.
```

**Pattern clé** : le CTE `WITH … AS (SELECT … SKIP LOCKED)` suivi d'un `UPDATE … FROM` est atomique — sélectionner et marquer se font en une seule opération. `RETURNING` donne directement les données à traiter sans second `SELECT`.

---

## Exercice 5 — Advisory lock : mutex sur un événement TribuZen

**Contexte** : un cron génère le récapitulatif hebdomadaire de l'événement 1. En déploiement multi-instances, deux crons peuvent démarrer simultanément — un advisory lock garantit qu'un seul s'exécute.

### TODO

```sql
-- Session A : acquérir l'advisory lock sur l'événement 1 (clé = 1)
BEGIN;
-- TODO : SELECT pg_try_advisory_xact_lock(1) AS acquired;
-- Si acquired = true → continuer ; simuler le traitement
SELECT id, titre, places_restantes FROM evenements WHERE id = 1;
-- garder ouvert (ne pas COMMIT encore)

-- Session B — pendant que A est ouvert :
BEGIN;
-- TODO : même SELECT pg_try_advisory_xact_lock(1) → que retourne-t-il ?
ROLLBACK;

-- Session A
COMMIT;
```

Puis observe les advisory locks actifs pendant que A est ouvert :

```sql
-- Session obs
SELECT l.locktype, l.classid, l.objid, l.mode, l.granted, a.pid, a.usename
FROM pg_locks l
JOIN pg_stat_activity a ON l.pid = a.pid
WHERE l.locktype = 'advisory';
```

### Corrigé

```sql
-- Session A
BEGIN;
SELECT pg_try_advisory_xact_lock(1) AS acquired;
-- → acquired = true (lock obtenu sur la clé 1)
-- Traitement du récapitulatif...
SELECT id, titre, places_restantes FROM evenements WHERE id = 1;
-- (ne pas COMMIT encore)

-- Session B — pendant que A est ouvert
BEGIN;
SELECT pg_try_advisory_xact_lock(1) AS acquired;
-- → acquired = false (lock déjà pris par A)
-- Un autre process traite déjà cet événement → skip, log, sortie propre
ROLLBACK;

-- Session obs (pendant que A est ouvert)
SELECT l.locktype, l.classid, l.objid, l.mode, l.granted, a.pid, a.usename
FROM pg_locks l
JOIN pg_stat_activity a ON l.pid = a.pid
WHERE l.locktype = 'advisory';
-- → locktype='advisory', objid=1, mode='ExclusiveLock', granted=true, pid=<PID de A>

-- Session A
COMMIT;
-- Lock libéré automatiquement (xact_lock). pg_locks : plus aucune entrée advisory.
```

**Observation** : `pg_try_advisory_xact_lock` est non-bloquant — Session B ne s'arrête pas, elle sait immédiatement que le lock est pris et peut sortir proprement. Le lock disparaît de `pg_locks` dès le `COMMIT` de A.

---

## Récapitulatif des patterns

| Besoin | Solution SQL |
|--------|-------------|
| Réservation (check + update atomique) | `SELECT … FOR UPDATE` |
| Réponse immédiate si verrou impossible | `FOR UPDATE NOWAIT` (SQLSTATE 55P03) |
| Attente bornée | `SET LOCAL lock_timeout = 'Ns'` |
| File de tâches sans contention | `FOR UPDATE SKIP LOCKED` |
| Rapport cohérent sur plusieurs tables | `LOCK TABLE … IN SHARE MODE` |
| Mutex applicatif non-bloquant (cron) | `pg_try_advisory_xact_lock(key)` |
| Diagnostiquer un blocage | `pg_blocking_pids(pid)` sur `pg_stat_activity` |
