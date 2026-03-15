# Module 08 — Niveaux d'isolation & MVCC

> **Objectif** : Comprendre comment PostgreSQL gere la concurrence sans que les transactions ne se marchent sur les pieds, grace a MVCC et aux niveaux d'isolation.
>
> **Difficulte** : ⭐⭐⭐

---

> **⚠️ Les modules 08, 09 et 10 forment un bloc difficile** (isolation, locks, deadlocks). C'est le passage le plus abstrait du cours. Si tu galeres, c'est normal — la concurrence est un sujet difficile meme pour des devs seniors. Fais les labs, utilise les diagrammes, et ne reste pas bloque plus de 30 min sur un concept. Tu peux aussi les faire en mode "lecture + quiz" sans deep dive — tu y reviendras quand tu en auras besoin en production.

## 1. Le probleme de la concurrence

Imaginez une bibliotheque universitaire. Des dizaines d'etudiants lisent des livres en meme temps, certains annotent des exemplaires, d'autres en empruntent. Si chaque etudiant devait attendre que tous les autres aient fini avant de toucher un livre, la bibliotheque serait inutilisable.

> **Analogie** : Une base de donnees est cette bibliotheque. Les **lecteurs** (SELECT) veulent consulter des donnees, les **ecrivains** (INSERT, UPDATE, DELETE) veulent les modifier. Le defi : permettre a tout le monde de travailler simultanement sans corrompre les donnees.

Dans un systeme naif, on pourrait poser un **verrou global** : "personne ne lit tant que quelqu'un ecrit". Mais c'est catastrophique pour les performances.

PostgreSQL a choisi une approche radicalement differente : **MVCC** (Multi-Version Concurrency Control).

### Le principe fondamental

```
┌─────────────────────────────────────────────────────┐
│           REGLE D'OR DE POSTGRESQL                   │
│                                                       │
│   Les lecteurs ne bloquent JAMAIS les ecrivains.     │
│   Les ecrivains ne bloquent JAMAIS les lecteurs.     │
│                                                       │
│   Seuls les ecrivains peuvent bloquer               │
│   d'autres ecrivains (sur la MEME ligne).           │
└─────────────────────────────────────────────────────┘
```

C'est cette propriete qui rend PostgreSQL si performant en environnement concurrent.

---

## 2. MVCC — Multi-Version Concurrency Control

### 2.1 Le concept : des versions multiples

Au lieu de modifier une ligne "en place" (comme dans un fichier texte classique), PostgreSQL **cree une nouvelle version** de la ligne a chaque modification.

> **Analogie** : Imaginez un document Google Docs. Quand vous modifiez un paragraphe, Google conserve l'historique des versions. Vous pouvez toujours revenir a une version anterieure. PostgreSQL fait exactement la meme chose, mais au niveau de chaque ligne de chaque table.

```
Etat de la table "comptes" au fil du temps :

Version 1 (xmin=100, xmax=105)  ← ancienne version (morte)
┌──────────┬──────────┐
│ id = 1   │ solde=500│
└──────────┴──────────┘

Version 2 (xmin=105, xmax=∞)    ← version courante (vivante)
┌──────────┬──────────┐
│ id = 1   │ solde=700│
└──────────┴──────────┘

Les DEUX versions coexistent physiquement dans la table !
```

### 2.2 xmin et xmax : les colonnes cachees

Chaque ligne (tuple) dans PostgreSQL possede des **colonnes systeme invisibles** :

| Colonne | Signification | Valeur |
|---------|---------------|--------|
| `xmin` | Transaction qui a **cree** cette version | ID de transaction (XID) |
| `xmax` | Transaction qui a **supprime/remplace** cette version | XID ou 0 si vivante |
| `ctid` | Position physique dans la page | (page, offset) |
| `cmin` | Numero de commande dans la transaction (creation) | Entier |
| `cmax` | Numero de commande dans la transaction (suppression) | Entier |

```sql
-- Observer les colonnes systeme
SELECT xmin, xmax, ctid, * FROM comptes;

--  xmin  | xmax | ctid  | id | nom     | solde
-- -------+------+-------+----+---------+-------
--  12345 |    0 | (0,1) |  1 | Alice   |   500
--  12346 |    0 | (0,2) |  2 | Bob     |   300
--  12350 | 12355| (0,3) |  3 | Charlie |   100  ← en cours de modification
```

### 2.3 Le cycle de vie d'un tuple

```
       INSERT (tx 100)           UPDATE (tx 105)          VACUUM
            │                         │                      │
            ▼                         ▼                      ▼
     ┌─────────────┐          ┌─────────────┐        ┌─────────────┐
     │ xmin = 100  │          │ xmin = 100  │        │             │
     │ xmax = 0    │    ───►  │ xmax = 105  │  ───►  │  SUPPRIME   │
     │ solde = 500 │          │ solde = 500 │        │  (espace    │
     │ (VIVANTE)   │          │ (MORTE)     │        │   libere)   │
     └─────────────┘          └─────────────┘        └─────────────┘
                                     +
                              ┌─────────────┐
                              │ xmin = 105  │
                              │ xmax = 0    │
                              │ solde = 700 │
                              │ (VIVANTE)   │
                              └─────────────┘
```

Etapes :
1. **INSERT** : cree un tuple avec `xmin = tx_courante`, `xmax = 0`
2. **UPDATE** : marque l'ancien tuple (`xmax = tx_courante`), cree un **nouveau** tuple
3. **DELETE** : marque le tuple (`xmax = tx_courante`), pas de nouveau tuple
4. **VACUUM** : nettoie les tuples morts que plus aucune transaction ne peut voir

### 2.4 Snapshots et visibilite

Un **snapshot** est une "photographie" de l'etat de la base a un instant donne.

> **Analogie** : Photographier la base a un instant T. Quand vous prenez une photo d'un paysage, les voitures qui arrivent APRES le declenchement ne sont pas sur la photo. De meme, les modifications faites APRES la prise du snapshot sont invisibles.

Un snapshot contient :
- `xmin` : le plus petit XID encore en cours au moment du snapshot
- `xmax` : le prochain XID a etre attribue
- `xip_list` : la liste des transactions en cours

**Regle de visibilite d'un tuple** :

```
Un tuple est VISIBLE dans un snapshot si :
  1. xmin du tuple est committe ET avant le snapshot
  2. xmax du tuple est 0 (pas supprime)
     OU xmax n'est pas encore committe
     OU xmax est apres le snapshot
```

```sql
-- Visualiser le snapshot courant
SELECT txid_current_snapshot();
-- Resultat : '100:105:102,103'
--             │    │    └── transactions en cours : 102 et 103
--             │    └── prochain XID
--             └── plus ancien XID en cours
```

### 2.5 Quand le snapshot est-il pris ?

C'est LA question cruciale, et la reponse depend du **niveau d'isolation** :

| Niveau d'isolation | Moment du snapshot |
|---|---|
| Read Committed | A chaque **instruction** (SELECT, UPDATE...) |
| Repeatable Read | Au **debut de la transaction** (1er statement) |
| Serializable | Au **debut de la transaction** + detection SSI |

---

## 3. Les phenomenes de concurrence

Avant de comprendre les niveaux d'isolation, il faut connaitre les **problemes** qu'ils resolvent.

### 3.1 Dirty Read (lecture sale)

**Definition** : Lire des donnees modifiees par une transaction qui n'a **pas encore fait COMMIT**.

```
Transaction A                    Transaction B
─────────────                    ─────────────
BEGIN;
UPDATE comptes SET solde = 0
  WHERE id = 1;
                                 BEGIN;
                                 SELECT solde FROM comptes
                                   WHERE id = 1;
                                 -- Dirty Read : voit solde = 0
                                 -- alors que A n'a pas committe !
ROLLBACK;
-- Le solde est toujours 500
                                 -- B a pris une decision basee
                                 -- sur une donnee FANTOME
```

> **Piege classique** : Dans PostgreSQL, le Dirty Read est **IMPOSSIBLE**, quel que soit le niveau d'isolation. Meme si vous demandez `READ UNCOMMITTED`, PostgreSQL applique `READ COMMITTED`. C'est un choix de conception.

### 3.2 Non-Repeatable Read (lecture non-repetable)

**Definition** : Relire la meme ligne dans la meme transaction et obtenir un resultat **different**.

```
Transaction A                    Transaction B
─────────────                    ─────────────
BEGIN;
SELECT solde FROM comptes
  WHERE id = 1;
-- Resultat : 500
                                 BEGIN;
                                 UPDATE comptes SET solde = 300
                                   WHERE id = 1;
                                 COMMIT;

SELECT solde FROM comptes
  WHERE id = 1;
-- Resultat : 300  ← DIFFERENT !
-- Non-Repeatable Read
COMMIT;
```

### 3.3 Phantom Read (lecture fantome)

**Definition** : Une requete retourne des **lignes supplementaires** qui n'existaient pas lors de la premiere execution.

```
Transaction A                    Transaction B
─────────────                    ─────────────
BEGIN;
SELECT COUNT(*) FROM comptes
  WHERE solde > 200;
-- Resultat : 2
                                 BEGIN;
                                 INSERT INTO comptes (nom, solde)
                                   VALUES ('David', 400);
                                 COMMIT;

SELECT COUNT(*) FROM comptes
  WHERE solde > 200;
-- Resultat : 3  ← Un fantome est apparu !
COMMIT;
```

### 3.4 Serialization Anomaly (anomalie de serialisation)

**Definition** : Le resultat de l'execution concurrente est **impossible** a obtenir par une execution serie (l'un apres l'autre) des transactions.

```
Table: compteurs (id, valeur)
Initialement : (1, 10), (2, 20)

Transaction A                    Transaction B
─────────────                    ─────────────
BEGIN;                           BEGIN;
SELECT valeur FROM compteurs     SELECT valeur FROM compteurs
  WHERE id = 1;  -- 10            WHERE id = 2;  -- 20

UPDATE compteurs                 UPDATE compteurs
  SET valeur = 20 + 1              SET valeur = 10 + 1
  WHERE id = 2;                    WHERE id = 1;

COMMIT;                          COMMIT;

-- Resultat : (1, 11), (2, 21)
-- IMPOSSIBLE en execution serie !
-- Si A puis B : (1, 11), (2, 11)
-- Si B puis A : (1, 21), (2, 21)
```

### 3.5 Tableau recapitulatif des phenomenes

```
┌─────────────────────────┬───────────────────────────────────────┐
│ Phenomene               │ Description courte                    │
├─────────────────────────┼───────────────────────────────────────┤
│ Dirty Read              │ Lire du non-committe                  │
│ Non-Repeatable Read     │ Relire ≠ resultat                     │
│ Phantom Read            │ Nouvelles lignes apparaissent         │
│ Serialization Anomaly   │ Resultat impossible en serie          │
└─────────────────────────┴───────────────────────────────────────┘
```

---

## 4. Les 3 niveaux d'isolation de PostgreSQL

Le standard SQL definit 4 niveaux d'isolation. PostgreSQL en implemente **3** (car Read Uncommitted est traite comme Read Committed).

### 4.1 Table comparative

| Phenomene | Read Uncommitted | Read Committed | Repeatable Read | Serializable |
|---|---|---|---|---|
| Dirty Read | ~~Possible~~ **Non (PG)** | Non | Non | Non |
| Non-Repeatable Read | ~~Possible~~ **Non (PG)** | **Possible** | Non | Non |
| Phantom Read | ~~Possible~~ **Non (PG)** | **Possible** | Non* | Non |
| Serialization Anomaly | ~~Possible~~ **Non (PG)** | **Possible** | **Possible** | Non |

> \* PostgreSQL previent aussi les Phantom Reads en Repeatable Read, ce qui va au-dela du standard SQL.

### 4.2 Comparaison rapide

| Critere | Read Committed | Repeatable Read | Serializable |
|---|---|---|---|
| Snapshot | Par statement | Par transaction | Par transaction + SSI |
| Performance | Excellente | Tres bonne | Bonne (overhead SSI) |
| Risque d'erreur | Aucun retry | Retry serialization | Retry serialization |
| Cas d'usage | 90% des cas | Rapports coherents | Integrite critique |
| Defaut PG ? | **Oui** | Non | Non |

---

## 5. SET TRANSACTION ISOLATION LEVEL — Syntaxe

```sql
-- Methode 1 : Au debut de la transaction
BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
-- ... vos requetes ...
COMMIT;

-- Methode 2 : Dans le BEGIN
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
-- ... vos requetes ...
COMMIT;

-- Methode 3 : Par defaut pour la session
SET default_transaction_isolation = 'serializable';

-- Methode 4 : Par defaut pour le serveur (postgresql.conf)
-- default_transaction_isolation = 'read committed'
```

> **Piege classique** : `SET TRANSACTION` doit etre la **premiere** commande apres `BEGIN`. Si vous executez une requete avant, PostgreSQL refuse le changement d'isolation.

```sql
-- ERREUR : trop tard !
BEGIN;
SELECT 1;  -- Une requete a deja ete executee
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
-- ERROR: SET TRANSACTION ISOLATION LEVEL must be called
-- before any query
```

### Verifier le niveau courant

```sql
SHOW transaction_isolation;
-- read committed  (par defaut)

-- Ou dans une transaction
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SHOW transaction_isolation;
-- repeatable read
```

---

## 6. Read Committed en profondeur

### 6.1 Principe

En **Read Committed**, chaque instruction SQL prend un **nouveau snapshot**. Cela signifie qu'entre deux SELECTs dans la meme transaction, vous pouvez voir des modifications committees par d'autres transactions.

> **Analogie** : Vous etes un photographe qui prend une nouvelle photo a chaque clic. Entre deux photos, le paysage peut changer : des voitures passent, des gens bougent. Chaque photo est coherente en elle-meme, mais deux photos successives peuvent montrer des etats differents.

### 6.2 Exemple concret : deux transactions

```sql
-- Preparation
CREATE TABLE comptes (
    id    SERIAL PRIMARY KEY,
    nom   TEXT NOT NULL,
    solde NUMERIC(10,2) NOT NULL
);

INSERT INTO comptes (nom, solde) VALUES
    ('Alice', 1000.00),
    ('Bob', 500.00);
```

```
Terminal 1 (Tx A)                    Terminal 2 (Tx B)
─────────────────                    ─────────────────
BEGIN;
                                     BEGIN;
SELECT solde FROM comptes
  WHERE nom = 'Alice';
-- 1000.00
                                     UPDATE comptes
                                       SET solde = solde - 200
                                       WHERE nom = 'Alice';
                                     COMMIT;

SELECT solde FROM comptes
  WHERE nom = 'Alice';
-- 800.00 ← a change !
-- (Nouveau snapshot = voit le COMMIT de B)
COMMIT;
```

### 6.3 Le piege de l'UPDATE conditionnel

```
Terminal 1 (Tx A)                    Terminal 2 (Tx B)
─────────────────                    ─────────────────
BEGIN;                               BEGIN;

                                     UPDATE comptes
                                       SET solde = solde + 100
                                       WHERE nom = 'Alice'
                                       AND solde >= 500;
                                     -- OK, solde etait 1000

UPDATE comptes
  SET solde = solde - 600
  WHERE nom = 'Alice'
  AND solde >= 600;
-- Bloque ! Attend le COMMIT de B

                                     COMMIT;

-- Debloque !
-- PostgreSQL RE-EVALUE la condition WHERE
-- avec les nouvelles valeurs.
-- solde est maintenant 1100, >= 600 → OK
-- solde = 1100 - 600 = 500
COMMIT;
```

> **Point cle** : En Read Committed, quand un UPDATE est debloque apres avoir attendu un lock, PostgreSQL **reevalue** la clause WHERE avec la version a jour de la ligne. C'est subtil et important.

### 6.4 Quand Read Committed suffit

- Applications CRUD classiques
- Operations qui ne dependent pas de la coherence inter-requetes
- Quand chaque requete est independante
- La grande majorite des applications web

---

## 7. Repeatable Read en profondeur

### 7.1 Principe

En **Repeatable Read**, le snapshot est pris au debut de la transaction (plus precisement, au moment de la premiere instruction). Toutes les requetes de la transaction voient **le meme etat** de la base.

> **Analogie** : Vous etes un photographe qui prend UNE seule photo au debut, puis travaille uniquement a partir de cette photo. Peu importe ce qui change dans le monde reel, vous ne le voyez pas.

### 7.2 Exemple concret

```
Terminal 1 (Tx A)                    Terminal 2 (Tx B)
─────────────────                    ─────────────────
BEGIN TRANSACTION ISOLATION
  LEVEL REPEATABLE READ;

SELECT solde FROM comptes
  WHERE nom = 'Alice';
-- 1000.00 (snapshot fige ici)

                                     BEGIN;
                                     UPDATE comptes
                                       SET solde = 800
                                       WHERE nom = 'Alice';
                                     COMMIT;

SELECT solde FROM comptes
  WHERE nom = 'Alice';
-- 1000.00 ← TOUJOURS le meme !
-- (Le snapshot est fige)

COMMIT;
```

### 7.3 L'erreur de serialisation

Que se passe-t-il si la transaction essaie de **modifier** une ligne qui a change ?

```
Terminal 1 (Tx A)                    Terminal 2 (Tx B)
─────────────────                    ─────────────────
BEGIN TRANSACTION ISOLATION
  LEVEL REPEATABLE READ;

SELECT solde FROM comptes
  WHERE nom = 'Alice';
-- 1000.00

                                     BEGIN;
                                     UPDATE comptes
                                       SET solde = 800
                                       WHERE nom = 'Alice';
                                     COMMIT;

UPDATE comptes
  SET solde = 900
  WHERE nom = 'Alice';
-- ERROR: could not serialize access
-- due to concurrent update
-- La transaction est ANNULEE !

ROLLBACK;  -- Obligatoire
```

> **Piege classique** : Apres une erreur de serialisation, la transaction est dans un etat "aborted". Vous DEVEZ faire ROLLBACK. Tout autre commande retournera : `ERROR: current transaction is aborted, commands ignored until end of transaction block`.

### 7.4 Le retry pattern

L'erreur de serialisation n'est **pas un bug** mais un comportement attendu. Il faut **reessayer** la transaction.

```sql
-- Pattern de retry en PL/pgSQL
DO $$
DECLARE
    retries INT := 0;
    max_retries CONSTANT INT := 5;
BEGIN
    LOOP
        BEGIN
            -- Debut de la transaction (implicite dans DO)
            PERFORM pg_sleep(0); -- Reset du snapshot

            UPDATE comptes
              SET solde = solde - 100
              WHERE nom = 'Alice'
              AND solde >= 100;

            -- Si on arrive ici, c'est OK
            EXIT; -- Sort de la boucle

        EXCEPTION
            WHEN serialization_failure OR deadlock_detected THEN
                retries := retries + 1;
                IF retries >= max_retries THEN
                    RAISE EXCEPTION 'Trop de retries (%)', retries;
                END IF;
                RAISE NOTICE 'Retry % / %', retries, max_retries;
        END;
    END LOOP;
END $$;
```

### 7.5 Cas d'usage pour Repeatable Read

- Rapports financiers (coherence des lectures)
- Calculs qui lisent plusieurs tables et doivent voir un etat coherent
- Exports de donnees
- Verifications de coherence

---

## 8. Serializable en profondeur

### 8.1 Principe

Le niveau **Serializable** garantit que le resultat de l'execution concurrente est **identique** a une execution serie des transactions (dans un certain ordre).

> **Analogie** : Imaginez un guichet de banque ou les clients passent un par un. Le resultat est toujours coherent car il n'y a pas de concurrence. Serializable donne la meme garantie, mais SANS forcer les transactions a passer une par une.

### 8.2 SSI — Serializable Snapshot Isolation

PostgreSQL utilise l'algorithme **SSI** (Serializable Snapshot Isolation) :

```
┌──────────────────────────────────────────────────────────────┐
│                         SSI                                   │
│                                                               │
│  1. Chaque transaction voit un snapshot (comme Repeatable     │
│     Read)                                                     │
│  2. PostgreSQL DETECTE les dependances entre transactions     │
│  3. Si un cycle de dependances apparait → anomalie possible   │
│  4. PostgreSQL ANNULE une des transactions (rollback)         │
│                                                               │
│  Pas de locks supplementaires ! Seulement de la detection.   │
└──────────────────────────────────────────────────────────────┘
```

### 8.3 Exemple : detection d'anomalie

```sql
-- Table initiale
CREATE TABLE compteurs (
    id     INT PRIMARY KEY,
    valeur INT NOT NULL
);
INSERT INTO compteurs VALUES (1, 10), (2, 20);
```

```
Terminal 1 (Tx A)                    Terminal 2 (Tx B)
─────────────────                    ─────────────────
BEGIN TRANSACTION ISOLATION
  LEVEL SERIALIZABLE;
                                     BEGIN TRANSACTION ISOLATION
                                       LEVEL SERIALIZABLE;

SELECT valeur FROM compteurs
  WHERE id = 1;
-- 10
                                     SELECT valeur FROM compteurs
                                       WHERE id = 2;
                                     -- 20

UPDATE compteurs
  SET valeur = 21   -- basé sur lecture de B
  WHERE id = 2;

                                     UPDATE compteurs
                                       SET valeur = 11  -- basé sur lecture de A
                                       WHERE id = 1;

COMMIT;
-- OK (le premier a committer gagne)

                                     COMMIT;
                                     -- ERROR: could not serialize access
                                     -- due to read/write dependencies
                                     -- among transactions
```

### 8.4 Performance de Serializable

| Aspect | Impact |
|---|---|
| Memoire | Legere augmentation (tracking des dependances) |
| CPU | Legere augmentation (detection de cycles) |
| Taux de rollback | Augmente (faux positifs possibles) |
| Throughput | Depend du workload (souvent < 10% de perte) |
| Lock contention | **Pas de locks supplementaires** |

> **Point cle** : SSI peut generer des **faux positifs** — PostgreSQL annule parfois une transaction qui n'aurait pas cause d'anomalie. C'est le prix de la detection sans locks.

### 8.5 Configuration pour Serializable

```sql
-- Parametres importants
SHOW max_pred_locks_per_transaction;  -- defaut : 64
SHOW max_pred_locks_per_relation;     -- defaut : -2 (auto)
SHOW max_pred_locks_per_page;         -- defaut : 2

-- Augmenter si beaucoup de serialization failures
ALTER SYSTEM SET max_pred_locks_per_transaction = 128;
SELECT pg_reload_conf();
```

---

## 9. Predicate Locks (SIReadLock) — le mecanisme interne de SSI

### 9.1 Ce que sont les Predicate Locks

Pour detecter les anomalies de serialisation, PostgreSQL utilise des **Predicate Locks** (aussi appeles **SIReadLock**). Contrairement aux verrous classiques (`RowExclusiveLock`, `AccessShareLock`...), les Predicate Locks **ne bloquent personne**. Ils ne font que **tracer les dependances** entre transactions.

> **Point cle** : Un Predicate Lock ne signifie pas "cette ligne est verrouillee". Il signifie "cette transaction a **lu** ces donnees et depend de leur etat". C'est un **traceur de dependances**, pas un mecanisme de blocage.

### 9.2 Les trois niveaux d'escalation

Les Predicate Locks existent a trois niveaux de granularite :

| Niveau | Granularite | Quand ? |
|---|---|---|
| **Tuple-level** | Une ligne specifique | Lecture d'un petit nombre de lignes via index |
| **Page-level** | Une page entiere (8 Ko) | Escalation quand trop de tuples sont verrouilles sur une page |
| **Relation-level** | La table entiere | Escalation quand trop de pages sont verrouillees, ou Seq Scan |

L'escalation est controlee par les parametres :
- `max_pred_locks_per_transaction` (defaut : 64)
- `max_pred_locks_per_relation` (defaut : -2, auto)
- `max_pred_locks_per_page` (defaut : 2)

### 9.3 Le graphe de dependances rw (Read-Write)

SSI construit un graphe de **dependances rw** (read-write) entre transactions :

```
 Graphe de dependances rw :

 Tx A lit X → Tx B ecrit X   =  dependance rw de A vers B
 Tx B lit Y → Tx A ecrit Y   =  dependance rw de B vers A

       ┌─── rw ───▶ Tx B
  Tx A │              │
       ◀─── rw ──────┘

  Cycle detecte ! → "dangerous structure"
  PostgreSQL annule une des deux transactions.
```

La detection se fait lors du COMMIT : si une **dangerous structure** (deux dependances rw consecutives formant un cycle potentiel) est detectee, PostgreSQL annule la transaction.

### 9.4 Faux positifs

PostgreSQL est **conservateur** dans sa detection. Il peut annuler une transaction qui n'aurait pas cause d'anomalie reelle. C'est un compromis delibere :

- **Pas de faux negatifs** : toute vraie anomalie est detectee
- **Faux positifs possibles** : certaines transactions valides sont annulees par precaution
- L'escalation (tuple → page → relation) augmente le risque de faux positifs

C'est pourquoi le **retry pattern** est indispensable en Serializable.

### 9.5 Observer les Predicate Locks

```sql
-- Observer les predicate locks actifs pendant une transaction Serializable
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT * FROM compteurs WHERE id = 1;

-- Dans un autre terminal :
SELECT locktype, relation::regclass, page, tuple, pid, mode
FROM pg_locks
WHERE mode = 'SIReadLock';

--  locktype  | relation  | page | tuple | pid  |    mode
-- -----------+-----------+------+-------+------+------------
--  tuple     | compteurs |    0 |     1 | 1234 | SIReadLock
```

### 9.6 Impact sur la performance

| Aspect | Impact en Serializable |
|---|---|
| Memoire supplementaire | Stockage des predicate locks (shared memory) |
| CPU supplementaire | Detection des dangerous structures a chaque COMMIT |
| Taux de rollback | Plus eleve qu'en Repeatable Read (faux positifs) |
| Debit global | Generalement < 10% de perte si peu de conflits |
| Transactions longues | Penalisantes : maintiennent les predicate locks plus longtemps |

> **Ce qu'il faut retenir** : Les Predicate Locks sont la brique interne qui rend Serializable possible sans verrous bloquants. Ils tracent les dependances de lecture, et PostgreSQL annule une transaction si un cycle est detecte. Le cout est un leger overhead en memoire/CPU et un taux de retry plus eleve. Pour minimiser les faux positifs : garder les transactions courtes et eviter les Seq Scans en Serializable.

---

## 10. xmin/xmax en pratique

### 10.1 Observer les versions

```sql
-- Creer une table de test
CREATE TABLE test_mvcc (
    id   SERIAL PRIMARY KEY,
    data TEXT
);

-- Inserer une ligne
INSERT INTO test_mvcc (data) VALUES ('version 1');

-- Observer
SELECT xmin, xmax, ctid, * FROM test_mvcc;
--  xmin  | xmax | ctid  | id |   data
-- -------+------+-------+----+-----------
--  1001  |    0 | (0,1) |  1 | version 1
```

### 10.2 Apres un UPDATE

```sql
UPDATE test_mvcc SET data = 'version 2' WHERE id = 1;

SELECT xmin, xmax, ctid, * FROM test_mvcc;
--  xmin  | xmax | ctid  | id |   data
-- -------+------+-------+----+-----------
--  1002  |    0 | (0,2) |  1 | version 2
--                  ^^^^
--  Notez : ctid a change ! (0,1) → (0,2)
--  L'ancienne version est en (0,1) mais invisible
```

### 10.3 Pendant un UPDATE (dans une autre transaction)

```sql
-- Terminal 1
BEGIN;
UPDATE test_mvcc SET data = 'version 3' WHERE id = 1;
-- NE PAS COMMIT

-- Terminal 2
SELECT xmin, xmax, ctid, * FROM test_mvcc;
--  xmin  | xmax | ctid  | id |   data
-- -------+------+-------+----+-----------
--  1002  | 1003 | (0,2) |  1 | version 2
--          ^^^^
--  xmax = 1003 signifie : la transaction 1003 a marque
--  cette version comme morte, mais n'a pas encore committe
```

### 10.4 La fonction txid_current()

```sql
-- Connaitre l'ID de la transaction courante
SELECT txid_current();
-- 1004

-- Connaitre le snapshot courant
SELECT txid_current_snapshot();
-- '1003:1005:1003'
-- Signifie : transactions 1003 encore en cours,
-- prochain XID = 1005
```

### 10.5 Compter les tuples morts

```sql
-- Apres plusieurs UPDATE sans VACUUM
SELECT
    relname,
    n_live_tup,    -- tuples vivants
    n_dead_tup,    -- tuples morts (a nettoyer)
    last_vacuum,
    last_autovacuum
FROM pg_stat_user_tables
WHERE relname = 'test_mvcc';
```

---

## 11. Le retry pattern en Node.js

### 11.1 Implementation de base

```typescript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'mydb',
    user: 'myuser',
    password: 'mypassword',
    max: 20,
});

/**
 * Execute une transaction avec retry automatique
 * en cas de serialization failure.
 *
 * @param {Function} txFn - Fonction recevant le client
 * @param {Object} options - Options
 * @param {string} options.isolationLevel - Niveau d'isolation
 * @param {number} options.maxRetries - Nombre max de retries
 * @returns {Promise<any>} - Resultat de la transaction
 */
async function withTransaction(txFn, options = {}) {
    const {
        isolationLevel = 'SERIALIZABLE',
        maxRetries = 5,
    } = options;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const client = await pool.connect();

        try {
            await client.query(
                `BEGIN TRANSACTION ISOLATION LEVEL ${isolationLevel}`
            );

            const result = await txFn(client);

            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');

            // Code '40001' = serialization_failure
            // Code '40P01' = deadlock_detected
            const isRetryable =
                error.code === '40001' || error.code === '40P01';

            if (isRetryable && attempt < maxRetries) {
                console.warn(
                    `Serialization failure, retry ${attempt}/${maxRetries}`
                );
                // Backoff exponentiel avec jitter
                const delay = Math.min(
                    100 * Math.pow(2, attempt) + Math.random() * 100,
                    5000
                );
                await new Promise((r) => setTimeout(r, delay));
                continue;
            }

            throw error;
        } finally {
            client.release();
        }
    }
}
```

### 11.2 Utilisation

```typescript
// Transfert d'argent avec isolation Serializable
async function transfert(fromId, toId, montant) {
    return withTransaction(async (client) => {
        // Verifier le solde
        const { rows } = await client.query(
            'SELECT solde FROM comptes WHERE id = $1',
            [fromId]
        );

        if (rows.length === 0) {
            throw new Error(`Compte ${fromId} introuvable`);
        }

        if (rows[0].solde < montant) {
            throw new Error('Solde insuffisant');
        }

        // Debiter
        await client.query(
            'UPDATE comptes SET solde = solde - $1 WHERE id = $2',
            [montant, fromId]
        );

        // Crediter
        await client.query(
            'UPDATE comptes SET solde = solde + $1 WHERE id = $2',
            [montant, toId]
        );

        return { success: true, montant };
    });
}

// Appel
try {
    const result = await transfert(1, 2, 100);
    console.log('Transfert reussi :', result);
} catch (error) {
    console.error('Transfert echoue :', error.message);
}
```

### 11.3 Pont vers TypeORM

Si vous utilisez TypeORM (cf. NestJS module 14), vous pouvez specifier le niveau d'isolation directement dans une transaction :

```typescript
// TypeORM : isolation dans une transaction
await dataSource.transaction('SERIALIZABLE', async (manager) => {
  const user = await manager.findOne(User, { where: { id: 1 } });
  user.solde -= montant;
  await manager.save(user);
});
```

TypeORM gere le `BEGIN TRANSACTION ISOLATION LEVEL ...` et le `COMMIT`/`ROLLBACK` pour vous. En revanche, le **retry** en cas de `serialization_failure` reste a votre charge — TypeORM ne reessaie pas automatiquement.

### 11.4 Les codes d'erreur importants

| Code | Nom | Signification | Retryable ? |
|------|-----|---------------|-------------|
| `40001` | serialization_failure | Conflit de serialisation | **Oui** |
| `40P01` | deadlock_detected | Deadlock detecte | **Oui** |
| `23505` | unique_violation | Doublon sur contrainte unique | **Non** (logique) |
| `23503` | foreign_key_violation | FK inexistante | **Non** (logique) |
| `57014` | query_canceled | Timeout ou annulation | Peut-etre |

---

## 12. Choisir le bon niveau d'isolation

### 12.1 Arbre de decision

```
                    Votre cas d'usage
                          │
                ┌─────────┴──────────┐
                │                    │
        Chaque requete          Coherence entre
        est independante        plusieurs requetes
                │                    │
                ▼                    │
         READ COMMITTED      ┌──────┴──────┐
         (defaut, 90%        │             │
          des cas)      Seulement      Ecritures
                        lectures       concurrentes
                             │         critiques
                             ▼              │
                       REPEATABLE          ▼
                       READ           SERIALIZABLE
                       (rapports)     (finance,
                                       reservations)
```

### 12.2 Guide par cas d'usage

| Cas d'usage | Niveau recommande | Raison |
|---|---|---|
| API REST CRUD basique | Read Committed | Chaque requete est independante |
| Dashboard temps reel | Read Committed | Donnees approximatives OK |
| Rapport financier mensuel | Repeatable Read | Coherence sur toute la lecture |
| Export de donnees | Repeatable Read | Snapshot fige pendant l'export |
| Transfert bancaire | Serializable | Integrite absolue requise |
| Systeme de reservation | Serializable | Pas de double booking |
| Gestion de stock | Serializable | Pas de survente |
| Compteur de likes | Read Committed | Approximation acceptable |

### 12.3 Matrice performance / securite

```
  Securite ▲
           │
           │   ★ Serializable
           │
           │         ★ Repeatable Read
           │
           │                    ★ Read Committed
           │
           └──────────────────────────────────► Performance
```

---

## 13. Exercice mental

> **Exercice mental** : Deux utilisateurs ajoutent simultanement un article au meme panier e-commerce. L'un ajoute 3 unites, l'autre 2 unites. En Read Committed, que se passe-t-il si les deux font `UPDATE paniers SET quantite = quantite + N WHERE id = 42` ?

<details>
<summary>Reponse</summary>

En **Read Committed** :
1. La premiere transaction acquiert le lock sur la ligne et fait `quantite = quantite + 3`
2. La deuxieme transaction attend le lock
3. Quand la premiere committe, la deuxieme est debloquee
4. PostgreSQL **reevalue** la condition : `quantite` est maintenant la valeur committee
5. La deuxieme fait `quantite = (nouvelle_valeur) + 2`

Resultat : **quantite initiale + 3 + 2 = correct !**

C'est parce que PostgreSQL reevalue la clause apres deblocage en Read Committed.
</details>

---

## Ce qu'il faut retenir

```
┌──────────────────────────────────────────────────────────────┐
│                    A RETENIR                                  │
│                                                               │
│  1. MVCC = pas de locks en lecture, versions multiples        │
│                                                               │
│  2. Dirty Read est IMPOSSIBLE dans PostgreSQL                 │
│                                                               │
│  3. Read Committed = snapshot par statement (defaut)          │
│                                                               │
│  4. Repeatable Read = snapshot par transaction                │
│                                                               │
│  5. Serializable = SSI, detecte les anomalies                │
│                                                               │
│  6. Les erreurs de serialisation sont NORMALES                │
│     → implementer un retry pattern                           │
│                                                               │
│  7. xmin/xmax permettent de voir les versions en live        │
│                                                               │
│  8. VACUUM nettoie les tuples morts (indispensable)          │
└──────────────────────────────────────────────────────────────┘
```

---

## Navigation

| Precedent | Suivant |
|---|---|
| [Module 07 — Index avancés](./07-index-avances) | [Module 09 — Verrous & Locks](./09-verrous-et-locks) |

**Travaux pratiques** : [Lab 08 — Expérimenter les niveaux d'isolation](/labs/lab-08-isolation-levels/README)

---

> *"La concurrence n'est pas un probleme a eviter, c'est une realite a gerer. MVCC est l'outil qui transforme le chaos en harmonie."*
