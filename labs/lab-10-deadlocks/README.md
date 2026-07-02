# Lab 10 — Deadlocks

> **Vrai outil :** deux sessions `psql` contre une base PostgreSQL 17 Docker locale. SQL réel, résultats réels. Aucun fichier séparé — corrigé inline ci-dessous.

## Objectifs

1. Reproduire un deadlock intentionnellement en deux sessions psql
2. Lire le message `ERROR: deadlock detected` et identifier le SQLSTATE `40P01`
3. Consulter `pg_stat_database.deadlocks` et `pg_stat_activity` pour le diagnostic
4. Corriger avec `SELECT … FOR UPDATE ORDER BY id`
5. Implémenter une boucle de retry sur `40P01` en SQL pur (`DO $$`)

## Prérequis

- PostgreSQL 17 local (Docker ou natif) sur `localhost:5432`
- Base `tribuzen_dev` accessible

```bash
# Créer la base si besoin
createdb tribuzen_dev

# Ouvrir deux terminaux sur la même base
psql -d tribuzen_dev   # Terminal 1
psql -d tribuzen_dev   # Terminal 2
```

## Schéma

```sql
-- Coller dans les DEUX terminaux avant de commencer
DROP TABLE IF EXISTS family_members CASCADE;
DROP TABLE IF EXISTS families CASCADE;

CREATE TABLE families (
  id            SERIAL      PRIMARY KEY,
  name          TEXT        NOT NULL,
  members_count INT         NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO families (name, members_count) VALUES
  ('Martin',  3),
  ('Dupont',  5),
  ('Lambert', 2);

SELECT * FROM families;
```

---

## Exercice 1 — Reproduire le deadlock

Deux admins TribuZen transfèrent simultanément un membre entre les familles 1 et 2, mais dans l'ordre inverse. Exécuter chaque étape dans l'ordre exact — ne pas passer à la suivante sans avoir terminé la précédente.

### Terminal 1 — étape A

```sql
BEGIN;
UPDATE families SET members_count = members_count - 1 WHERE id = 1;
-- Résultat attendu : UPDATE 1
-- Lock RowExclusive acquis sur id=1
```

### Terminal 2 — étape B (après l'étape A)

```sql
BEGIN;
UPDATE families SET members_count = members_count - 1 WHERE id = 2;
-- Résultat attendu : UPDATE 1
-- Lock RowExclusive acquis sur id=2
```

### Terminal 1 — étape C (après l'étape B)

```sql
UPDATE families SET members_count = members_count + 1 WHERE id = 2;
-- ⏳ Se bloque — attend que terminal 2 libère id=2
-- Ne pas taper COMMIT : laisser en attente et passer au terminal 2
```

### Terminal 2 — étape D (immédiatement après l'étape C)

```sql
UPDATE families SET members_count = members_count + 1 WHERE id = 1;
-- ⏳ Deadlock imminent : terminal 2 attend id=1 (tenu par terminal 1)
--                        terminal 1 attend id=2 (tenu par terminal 2)
-- Cycle détecté par PostgreSQL après deadlock_timeout (~1 s)
```

### Résultat attendu

L'un des deux terminaux reçoit (~1 s après l'étape D) :

```
ERROR:  deadlock detected
DETAIL: Process 12345 waits for ShareLock on transaction 67890;
        blocked by process 11111.
        Process 11111 waits for ShareLock on transaction 12345;
        blocked by process 12345.
HINT:   See server log for query details.
CONTEXT: while updating tuple (0,2) in relation "families"
```

L'autre terminal reçoit `UPDATE 1` et peut continuer.

### Nettoyage après l'exercice

```sql
-- Dans les deux terminaux (la victime a déjà rollbacké automatiquement)
ROLLBACK;

-- Remettre les données à l'état initial
UPDATE families SET members_count = 3 WHERE id = 1;
UPDATE families SET members_count = 5 WHERE id = 2;
```

---

## Exercice 2 — Diagnostic

### Compter les deadlocks enregistrés

```sql
SELECT datname, deadlocks
FROM pg_stat_database
WHERE datname = current_database();
-- La colonne deadlocks doit être >= 1 après l'exercice 1
```

### Observer les attentes de verrou en temps réel

Ouvrir un troisième terminal et lancer cette requête **pendant** l'exercice 1 (entre les étapes C et D) :

```sql
SELECT
  pid,
  usename,
  pg_blocking_pids(pid)  AS blocked_by,
  wait_event_type,
  wait_event,
  left(query, 70)        AS query_short
FROM pg_stat_activity
WHERE wait_event_type = 'Lock'
ORDER BY query_start;
```

Résultat attendu : une ligne montrant le terminal bloqué, son PID bloquant, et la requête UPDATE en attente.

### Activer les logs d'attente de verrou

```sql
-- À exécuter une fois (superuser requis)
ALTER SYSTEM SET log_lock_waits = on;
SELECT pg_reload_conf();

-- Vérifier
SHOW log_lock_waits;
-- on
```

Après activation, chaque attente dépassant `deadlock_timeout` apparaît dans les logs PostgreSQL — signal précoce de contention avant qu'un vrai deadlock ne survienne en production.

---

## Exercice 3 — Prévenir avec SELECT … FOR UPDATE ORDER BY

Même opération que l'exercice 1, mais les deux terminaux pré-verrouillent dans l'**ordre croissant** dès le début.

### Terminal 1

```sql
BEGIN;
-- Pré-verrouillage dans l'ordre croissant, quelle que soit la direction du transfert
SELECT id FROM families
  WHERE id IN (1, 2)
  ORDER BY id
  FOR UPDATE;
-- UPDATE 2 (2 lignes sélectionnées et verrouillées : id=1 puis id=2)

UPDATE families SET members_count = members_count - 1 WHERE id = 1;
UPDATE families SET members_count = members_count + 1 WHERE id = 2;
COMMIT;
```

### Terminal 2 (en parallèle de terminal 1 — lancer après le SELECT de terminal 1)

```sql
BEGIN;
-- Même ordre croissant (même si l'on transfère dans l'autre sens)
SELECT id FROM families
  WHERE id IN (1, 2)
  ORDER BY id
  FOR UPDATE;
-- ⏳ Bloqué sur id=1 (tenu par terminal 1) — attente simple, pas de cycle
-- Dès que terminal 1 commite, terminal 2 obtient ses locks et continue

UPDATE families SET members_count = members_count + 1 WHERE id = 1;
UPDATE families SET members_count = members_count - 1 WHERE id = 2;
COMMIT;
-- COMMIT — aucun deadlock
```

**Observation :** terminal 2 attend, mais sans cycle. Quand terminal 1 commite, terminal 2 obtient ses locks et termine normalement. Relancer `SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()` — le compteur n'a pas augmenté.

---

## Exercice 4 — Observer deadlock_timeout

Mesurer l'effet de `deadlock_timeout` sur le délai de détection.

```sql
-- Réduire dans les deux sessions pour l'exercice (valeur session uniquement)
SET deadlock_timeout = '200ms';
SHOW deadlock_timeout;
-- 200ms

-- Refaire l'exercice 1 : l'erreur deadlock detected apparaît en ~200 ms au lieu de ~1 s

-- Restaurer après l'exercice
RESET deadlock_timeout;
SHOW deadlock_timeout;
-- 1s
```

---

## Exercice 5 — Retry applicatif en SQL (DO $$)

Simuler la logique de retry dans PostgreSQL pur avec un bloc `DO $$`. Reproduit le comportement de la boucle TypeScript `withRetry` du module.

```sql
-- Remettre les données à l'état connu avant l'exercice
UPDATE families SET members_count = 3 WHERE id = 1;
UPDATE families SET members_count = 5 WHERE id = 2;

-- Bloc de retry sur deadlock_detected (SQLSTATE 40P01)
DO $$
DECLARE
  attempts      INT := 0;
  max_attempts  CONSTANT INT := 3;
BEGIN
  LOOP
    attempts := attempts + 1;
    BEGIN
      -- Transfert dans l'ordre croissant (exercice 3 — sans risque de deadlock ici)
      -- Remplacer par l'ordre inverse pour déclencher 40P01 si un concurrent tourne
      SELECT id FROM families WHERE id IN (1, 2) ORDER BY id FOR UPDATE;
      UPDATE families SET members_count = members_count - 1 WHERE id = 1;
      UPDATE families SET members_count = members_count + 1 WHERE id = 2;
      RAISE NOTICE 'Transfert réussi à la tentative %', attempts;
      EXIT;   -- succès : sortir de la boucle
    EXCEPTION
      WHEN deadlock_detected THEN
        IF attempts >= max_attempts THEN
          RAISE EXCEPTION 'Transfert échoué après % tentatives (deadlock persistant)', attempts;
        END IF;
        RAISE NOTICE 'Deadlock 40P01 — tentative % — retry...', attempts;
        PERFORM pg_sleep(0.1 * attempts);  -- backoff linéaire simple
    END;
  END LOOP;
END;
$$;
-- NOTICE: Transfert réussi à la tentative 1
```

---

## Corrigé — récapitulatif des requêtes clés

### Reproduire le deadlock (ordre inverse — NE PAS utiliser en production)

```sql
-- Session A : lock id=1 puis tente id=2
BEGIN;
UPDATE families SET members_count = members_count - 1 WHERE id = 1;
UPDATE families SET members_count = members_count + 1 WHERE id = 2;
COMMIT;

-- Session B : lock id=2 puis tente id=1 (concurrent)
BEGIN;
UPDATE families SET members_count = members_count - 1 WHERE id = 2;
UPDATE families SET members_count = members_count + 1 WHERE id = 1;
COMMIT;
-- → DEADLOCK après ~1 s sur la deuxième UPDATE de la session victime
```

### Prévenir (ordre cohérent — patron à utiliser en production)

```sql
-- Les deux sessions utilisent ce patron, quelle que soit la direction
BEGIN;
SELECT id FROM families
  WHERE id IN (:id_source, :id_destination)
  ORDER BY id
  FOR UPDATE;
-- UPDATE dans n'importe quel ordre (les locks sont déjà pris dans l'ordre)
UPDATE families SET members_count = members_count - 1 WHERE id = :id_source;
UPDATE families SET members_count = members_count + 1 WHERE id = :id_destination;
COMMIT;
```

### Diagnostic

```sql
-- Compteur total de deadlocks sur la base courante
SELECT deadlocks
FROM pg_stat_database
WHERE datname = current_database();

-- Attentes de verrou actives en temps réel
SELECT pid, pg_blocking_pids(pid) AS blocked_by, wait_event, left(query, 80) AS q
FROM pg_stat_activity
WHERE wait_event_type = 'Lock'
ORDER BY query_start;

-- Activer les logs d'attente (à faire une fois en dev)
ALTER SYSTEM SET log_lock_waits = on;
SELECT pg_reload_conf();

-- Voir deadlock_timeout courant
SHOW deadlock_timeout;
```

---

## Variante J+30

Revenir sur ce lab dans 30 jours avec ce scénario à 3 participants.

```sql
-- Deadlock à 3 participants : cycle A → B → C → A
-- Session 1 : BEGIN; UPDATE id=1; UPDATE id=2; (lock 1 puis tente 2)
-- Session 2 : BEGIN; UPDATE id=2; UPDATE id=3; (lock 2 puis tente 3)
-- Session 3 : BEGIN; UPDATE id=3; UPDATE id=1; (lock 3 puis tente 1)
-- Exécuter les trois premiers UPDATE simultanément, puis les trois seconds.
-- PostgreSQL détecte le cycle à 3 et annule une victime.
-- Vérifier que pg_stat_database.deadlocks a incrémenté de 1.

-- Correction : toutes les sessions trient leurs IDs en ordre croissant
SELECT id FROM families WHERE id IN (1, 2, 3) ORDER BY id FOR UPDATE;
-- Résultat : plus de cycle possible, attentes simples seulement.
```

---

> Module associé : `10-postgresql/modules/10-deadlocks.md`
