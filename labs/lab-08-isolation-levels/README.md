# Lab 08 — Niveaux d'isolation

> Reproduire en deux sessions psql les anomalies de concurrence sur l'invitation TribuZen, provoquer et gérer l'erreur de sérialisation, inspecter MVCC avec xmin/xmax.

## Prérequis · Durée

- Module 08 lu
- psql disponible (Docker `postgres:17` ou installation locale)
- Ouvrir **deux terminaux** côte à côte (Terminal 1 = session A, Terminal 2 = session B)
- Durée estimée : 50 min

## Setup

```sql
-- Exécuter dans le terminal 1
CREATE DATABASE tribuzen_lab08;
\c tribuzen_lab08

CREATE TABLE family (
  id            TEXT PRIMARY KEY,
  members_count INT NOT NULL DEFAULT 0
);

CREATE TABLE invitation (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','accepted','declined')),
  family_id  TEXT NOT NULL REFERENCES family(id),
  invitee_id TEXT NOT NULL
);

CREATE TABLE family_member (
  family_id TEXT NOT NULL REFERENCES family(id),
  user_id   TEXT NOT NULL,
  PRIMARY KEY (family_id, user_id)
);

INSERT INTO family VALUES ('fam-1', 2);
INSERT INTO invitation VALUES ('inv-42', 'pending', 'fam-1', 'user-9');
```

```sql
-- Dans le terminal 2, connecter à la même base
\c tribuzen_lab08
```

---

## Étape 1 — Read Committed : observer le non-repeatable read

Le terminal 1 ouvre une transaction (Read Committed, le défaut). Il lit `status`. Le terminal 2 accepte l'invitation et committe. Le terminal 1 relit `status` **sans clore sa transaction**.

**TODO** : quel résultat obtiens-tu au deuxième SELECT du terminal 1 ?

```sql
-- Terminal 1
BEGIN;
SELECT status FROM invitation WHERE id = 'inv-42';
-- ?
```

```sql
-- Terminal 2 (pendant que terminal 1 est dans BEGIN)
BEGIN;
UPDATE invitation SET status = 'accepted' WHERE id = 'inv-42';
COMMIT;
```

```sql
-- Terminal 1 (toujours dans la même transaction)
SELECT status FROM invitation WHERE id = 'inv-42';
-- ?
COMMIT;
```

**Corrigé** :

```sql
-- Terminal 1 — premier SELECT : 'pending'
-- Terminal 2 — COMMIT

-- Terminal 1 — deuxième SELECT : 'accepted'
-- → non-repeatable read : nouveau snapshot par statement en Read Committed
COMMIT;
```

En Read Committed, chaque statement prend un snapshot frais des données commitées. La valeur a changé entre les deux SELECT dans la même transaction. Si le code avait décidé d'accepter l'invitation sur la base du premier SELECT, il aurait procédé sur une donnée devenue obsolète.

---

## Étape 2 — Repeatable Read : snapshot stable

**TODO** : réinitialise l'invitation, puis refais le même scénario avec Repeatable Read. Que voit le terminal 1 au deuxième SELECT ?

```sql
-- Remettre l'invitation à 'pending'
UPDATE invitation SET status = 'pending' WHERE id = 'inv-42';
```

```sql
-- Terminal 1
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT status FROM invitation WHERE id = 'inv-42';
-- ?
```

```sql
-- Terminal 2 (pendant que terminal 1 est ouvert)
BEGIN;
UPDATE invitation SET status = 'accepted' WHERE id = 'inv-42';
COMMIT;
```

```sql
-- Terminal 1 (toujours dans la même transaction)
SELECT status FROM invitation WHERE id = 'inv-42';
-- ?
COMMIT;
```

**Corrigé** :

```sql
-- Terminal 1 — premier SELECT : 'pending'  (snapshot figé ici)
-- Terminal 2 — COMMIT accepté

-- Terminal 1 — deuxième SELECT : 'pending'
-- → snapshot figé au premier statement : le COMMIT de B est invisible
COMMIT;
```

En Repeatable Read, tous les SELECT de la transaction partagent le même snapshot pris au premier statement. Le commit du terminal 2 est invisible pour le terminal 1 — vue stable garantie.

---

## Étape 3 — Repeatable Read : provoquer l'erreur 40001

**TODO** : même scénario, mais le terminal 1 tente un UPDATE après que le terminal 2 a commité. Que se passe-t-il ?

```sql
-- Reset
UPDATE invitation SET status = 'pending' WHERE id = 'inv-42';
```

```sql
-- Terminal 1
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT status FROM invitation WHERE id = 'inv-42';
-- 'pending'
```

```sql
-- Terminal 2
BEGIN;
UPDATE invitation SET status = 'accepted' WHERE id = 'inv-42';
COMMIT;
```

```sql
-- Terminal 1 : tenter l'UPDATE après le COMMIT de B
UPDATE invitation SET status = 'accepted' WHERE id = 'inv-42';
-- ?
```

**Corrigé** :

```sql
-- Terminal 1 — UPDATE
-- ERROR: could not serialize access due to concurrent update
-- SQLSTATE: 40001
-- La transaction est abortée — toute commande suivante sera rejetée

ROLLBACK;  -- obligatoire avant de repartir
```

PostgreSQL détecte que la ligne a été modifiée et commitée par une autre transaction après le snapshot de A. Il refuse l'UPDATE et annule la transaction. Au retry, A prend un snapshot postérieur au commit de B, voit `status = 'accepted'`, et sa garde métier stoppe proprement.

---

## Étape 4 — Retry pattern en PL/pgSQL

**TODO** : complète le bloc `DO $$` pour qu'il tente l'acceptation en Repeatable Read avec `FOR UPDATE` sur la lecture, réessaie jusqu'à 3 fois sur SQLSTATE 40001, et lève une exception métier si `status != 'pending'`.

```sql
-- Reset
UPDATE invitation SET status = 'pending' WHERE id = 'inv-42';

DO $$
DECLARE
  retries INT := 0;
  s       TEXT;
BEGIN
  LOOP
    BEGIN
      SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

      -- TODO 1 : lire status avec FOR UPDATE (verrou dès la lecture)
      SELECT ??? INTO s FROM invitation WHERE id = 'inv-42' ???;

      -- TODO 2 : garde métier
      IF s != 'pending' THEN
        RAISE EXCEPTION 'ALREADY_ACCEPTED';
      END IF;

      -- TODO 3 : accepter
      UPDATE invitation SET status = 'accepted' WHERE id = 'inv-42';
      EXIT;  -- succès → sortir de la boucle

    EXCEPTION
      WHEN serialization_failure THEN
        retries := retries + 1;
        IF retries >= 3 THEN RAISE; END IF;
        RAISE NOTICE 'retry % / 3', retries;
    END;
  END LOOP;
END $$;
```

**Corrigé** :

```sql
UPDATE invitation SET status = 'pending' WHERE id = 'inv-42';

DO $$
DECLARE
  retries INT := 0;
  s       TEXT;
BEGIN
  LOOP
    BEGIN
      SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

      SELECT status INTO s FROM invitation WHERE id = 'inv-42' FOR UPDATE;

      IF s != 'pending' THEN
        RAISE EXCEPTION 'ALREADY_ACCEPTED';
      END IF;

      UPDATE invitation SET status = 'accepted' WHERE id = 'inv-42';
      EXIT;

    EXCEPTION
      WHEN serialization_failure THEN
        retries := retries + 1;
        IF retries >= 3 THEN RAISE; END IF;
        RAISE NOTICE 'retry % / 3', retries;
    END;
  END LOOP;
END $$;
```

`FOR UPDATE` pose un verrou d'écriture sur la ligne dès la lecture. Si deux sessions arrivent simultanément, la deuxième bloque jusqu'au commit de la première, puis relit avec un snapshot à jour et voit `status = 'accepted'` → garde métier → erreur propre, pas de doublon.

---

## Étape 5 — Observer MVCC avec xmin/xmax

**TODO** : inspecte les colonnes système avant, pendant, et après une modification concurrente.

```sql
-- Terminal 1 : état initial
SELECT xmin, xmax, ctid, id, status FROM invitation WHERE id = 'inv-42';
-- noter les valeurs de xmin, xmax et ctid
```

```sql
-- Terminal 2 : modifier sans committer
BEGIN;
UPDATE invitation SET status = 'processing' WHERE id = 'inv-42';
-- NE PAS committer
```

```sql
-- Terminal 1 : observer pendant l'update non commité
SELECT xmin, xmax, ctid, id, status FROM invitation WHERE id = 'inv-42';
-- que vois-tu dans xmax ? quelle valeur de status ?
```

```sql
-- Terminal 2 : committer
COMMIT;

-- Terminal 1 : observer après le commit
SELECT xmin, xmax, ctid, id, status FROM invitation WHERE id = 'inv-42';
-- le ctid a-t-il changé ?
```

**Corrigé** :

```sql
-- Avant l'update (exemple avec XID 1001) :
--  xmin  | xmax | ctid  |   id   | status
-- -------+------+-------+--------+---------
--  1001  |    0 | (0,1) | inv-42 | pending
-- xmax = 0 → tuple vivant, aucune transaction ne l'a marqué comme expiré

-- Pendant l'update non commité (XID 1003) :
--  xmin  | xmax | ctid  |   id   | status
-- -------+------+-------+--------+---------
--  1001  | 1003 | (0,1) | inv-42 | pending
-- xmax = 1003 : la tx 1003 a marqué ce tuple comme expiré mais n'a pas encore commité
-- Terminal 1 voit toujours 'pending' : le nouveau tuple non commité est invisible (MVCC)

-- Après COMMIT de terminal 2 :
--  xmin  | xmax | ctid  |   id   |  status
-- -------+------+-------+--------+------------
--  1003  |    0 | (0,2) | inv-42 | processing
-- Nouveau tuple à l'emplacement physique (0,2) — ctid a changé
-- L'ancien tuple (0,1) avec xmax=1003 est mort, en attente de VACUUM
```

---

## Variante J+30

- Refais l'étape 3 avec `BEGIN ISOLATION LEVEL SERIALIZABLE` : le comportement est-il identique à Repeatable Read sur cet exemple ?
- Depuis un troisième terminal, consulte `pg_stat_user_tables` : fais plusieurs UPDATE sans VACUUM et observe `n_dead_tup` croître, puis lance `VACUUM ANALYZE invitation` et vérifie que le compteur repasse à 0.
- Ajoute `SET lock_timeout = '2s'` avant l'UPDATE concurrent de l'étape 3 : que se passe-t-il si la deuxième session attend plus de 2 secondes sur un verrou ?
- Observe les predicate locks en Serializable : `SELECT locktype, mode FROM pg_locks WHERE mode = 'SIReadLock'` depuis un terminal pendant une transaction Serializable active.

---

## Navigation

| | Lien |
|---|---|
| Module associé | [Module 08 — Niveaux d'isolation](../../modules/08-niveaux-isolation.md) |
| Module suivant | [Module 09 — Verrous et locks](../../modules/09-verrous-et-locks.md) |
