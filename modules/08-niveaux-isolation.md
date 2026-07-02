---
titre: Niveaux d'isolation
cours: 10-postgresql
notions: [isolation dans ACID, Read Committed, Repeatable Read, Serializable, anomalies dirty read non-repeatable read phantom, erreurs de sérialisation, MVCC, SET TRANSACTION ISOLATION LEVEL, défauts PostgreSQL]
outcomes: [expliquer les niveaux d'isolation et leurs anomalies, choisir le bon niveau selon le besoin, gérer une erreur de sérialisation, comprendre MVCC]
prerequis: [07-index-avances]
next: 09-verrous-et-locks
libs: [{ name: postgresql, version: "17" }]
tribuzen: isolation d'une invitation concurrente TribuZen (deux parents invitent en même temps)
last-reviewed: 2026-07
---

# Niveaux d'isolation

> **Outcomes — tu sauras FAIRE :** expliquer les quatre niveaux d'isolation et les anomalies qu'ils préviennent, choisir le bon niveau selon ton besoin, gérer une erreur de sérialisation avec un retry, et comprendre comment MVCC rend tout ça possible sans verrou de lecture.
> **Difficulté :** :star::star::star:

## 1. Cas concret d'abord

Dans TribuZen, un enfant reçoit une invitation (`status = 'pending'`) à rejoindre la famille Dupont. **Deux parents** ouvrent l'app simultanément et appuient tous les deux sur "Accepter". Chacun lit `status = 'pending'`, décide que l'invitation est valide, et procède. Sans isolation suffisante, les deux transactions passent : deux lignes `family_member` sont insérées pour le même enfant, et `members_count` est incrémenté deux fois.

```sql
-- Session A (Parent 1)                  -- Session B (Parent 2)
BEGIN;                                    BEGIN;
SELECT status FROM invitation             SELECT status FROM invitation
  WHERE id = 'inv-42';                      WHERE id = 'inv-42';
-- 'pending'                              -- 'pending'  (vue identique)

UPDATE invitation                         -- bloquée : attend le COMMIT de A
  SET status = 'accepted'
  WHERE id = 'inv-42';
COMMIT;   -- A committe en premier
                                          -- débloquée
                                          UPDATE invitation
                                            SET status = 'accepted'
                                            WHERE id = 'inv-42';
                                          COMMIT;   -- B committe aussi !
-- Résultat : deux family_member pour le même enfant, members_count +2
```

Le niveau d'isolation décide si la session B peut voir la modification de A avant son propre commit, et si un conflit d'écriture est détecté et refusé. La suite explique MVCC (le mécanisme sous-jacent), les trois niveaux utilisables dans PostgreSQL, leurs anomalies respectives, et comment réagir à une erreur de sérialisation.

## 2. Théorie complète, concise

### MVCC — pourquoi les lecteurs ne bloquent jamais

PostgreSQL ne modifie pas une ligne « en place ». À chaque `UPDATE` ou `DELETE`, il **crée une nouvelle version** du tuple et marque l'ancienne comme expirée. Deux colonnes système invisibles pilotent cette visibilité :

| Colonne | Rôle |
|---|---|
| `xmin` | XID de la transaction qui a **créé** cette version du tuple |
| `xmax` | XID de la transaction qui l'a **supprimée/remplacée** (0 = encore vivante) |

```sql
-- Observer les versions système en direct
SELECT xmin, xmax, ctid, id, status FROM invitation WHERE id = 'inv-42';
--  xmin  | xmax | ctid  |   id   | status
-- -------+------+-------+--------+---------
--  1001  |    0 | (0,1) | inv-42 | pending
```

Un `UPDATE` marque `xmax = tx_courante` sur l'ancien tuple et insère un nouveau tuple avec `xmin = tx_courante`. Les deux versions coexistent physiquement jusqu'au prochain `VACUUM`. Chaque transaction choisit quelle version elle voit grâce à son **snapshot** — une photo de l'ensemble des XIDs commitées au moment où le snapshot est pris.

Conséquence clé : les `SELECT` ne posent aucun verrou de lecture. **Les lecteurs ne bloquent jamais les écrivains, et vice-versa.** Seuls deux écrivains sur la **même ligne** se bloquent mutuellement.

### Quand le snapshot est-il pris ?

C'est la définition exacte du niveau d'isolation :

| Niveau | Snapshot pris | Anomalies restantes |
|---|---|---|
| Read Committed (défaut PG) | À chaque **statement** | non-repeatable read, phantom, write skew |
| Repeatable Read | Au **premier statement** de la transaction | write skew (phantom protégé aussi par PG) |
| Serializable | Au premier statement + **détection SSI** | aucune |

PostgreSQL n'implémente pas Read Uncommitted de façon distincte : il se comporte exactement comme Read Committed. Les dirty reads sont **impossibles** dans PostgreSQL quel que soit le niveau déclaré.

### Les anomalies de concurrence

**Dirty read** : lire une donnée écrite par une transaction non encore commitée (qui pourrait rollback). Impossible dans PostgreSQL — MVCC ne rend visibles que les tuples commitées.

**Non-repeatable read** : relire la **même ligne** dans la même transaction et obtenir une valeur différente (une autre tx a commité entre les deux lectures). Possible en Read Committed (snapshot par statement) ; impossible en Repeatable Read et Serializable.

**Phantom read** : réexécuter la **même requête multi-lignes** et voir apparaître ou disparaître des lignes (insertions/suppressions commitées entre les deux). Possible en Read Committed ; bloqué aussi par Repeatable Read dans PostgreSQL (au-delà du minimum du standard SQL).

**Write skew / anomalie de sérialisation** : deux transactions lisent un état cohérent, écrivent chacune de leur côté, et le résultat combiné viole une règle métier qu'aucune n'aurait violée seule. Seul Serializable l'interdit.

Tableau — comportement **réel de PostgreSQL 17** :

| Anomalie | Read Committed | Repeatable Read | Serializable |
|---|:---:|:---:|:---:|
| Dirty read | impossible | impossible | impossible |
| Non-repeatable read | possible | impossible | impossible |
| Phantom read | possible | impossible\* | impossible |
| Write skew | possible | possible | impossible |

\* PostgreSQL Repeatable Read utilise le snapshot isolation : toutes les requêtes de la transaction partagent le même snapshot figé — les insertions commitées après le premier statement sont invisibles, ce qui protège des phantoms au-delà du minimum du standard SQL.

### Erreurs de sérialisation et retry obligatoire

En Repeatable Read et Serializable, PostgreSQL peut lever :

```
ERROR: could not serialize access due to concurrent update
SQLSTATE: 40001
```

Ce n'est pas un bug — c'est le signal que le résultat aurait été incohérent. La réponse correcte est **`ROLLBACK` immédiat puis retry**. Après toute erreur dans une transaction PostgreSQL, toutes les commandes suivantes sont rejetées (`current transaction is aborted, commands ignored until end of transaction block`) jusqu'au `ROLLBACK`.

### SET TRANSACTION ISOLATION LEVEL

```sql
-- Méthode 1 : directement dans BEGIN
BEGIN ISOLATION LEVEL REPEATABLE READ;

-- Méthode 2 : premier statement après BEGIN (avant toute requête)
BEGIN;
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;

-- Méthode 3 : défaut de session
SET default_transaction_isolation = 'repeatable read';

-- Vérifier le niveau actif
SHOW transaction_isolation;
```

Piège : `SET TRANSACTION ISOLATION LEVEL` doit être la **première commande** après `BEGIN`, avant toute requête. Une requête préalable provoque `ERROR: SET TRANSACTION ISOLATION LEVEL must be called before any query`.

## 3. Worked examples

### Exemple A — Read Committed : non-repeatable read (deux sessions psql)

Objectif : voir concrètement qu'en Read Committed la session A obtient deux valeurs différentes pour la même ligne dans la même transaction.

```sql
-- Setup (une seule fois)
CREATE TABLE invitation (
  id         TEXT PRIMARY KEY,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','accepted','declined')),
  family_id  TEXT NOT NULL,
  invitee_id TEXT NOT NULL
);
INSERT INTO invitation VALUES ('inv-42', 'pending', 'fam-1', 'user-9');
```

```sql
-- Session A (terminal 1)               -- Session B (terminal 2)
BEGIN;
SELECT status FROM invitation
  WHERE id = 'inv-42';
-- 'pending'
                                         BEGIN;
                                         UPDATE invitation
                                           SET status = 'accepted'
                                           WHERE id = 'inv-42';
                                         COMMIT;

SELECT status FROM invitation
  WHERE id = 'inv-42';
-- 'accepted'  ← snapshot frais, voit le COMMIT de B
--   c'est un non-repeatable read
COMMIT;
```

Pas-à-pas : (1) la session A ouvre une transaction en Read Committed (défaut) ; (2) la session B committe une modification sur la même ligne ; (3) le **deuxième SELECT de A** prend un nouveau snapshot et voit le commit de B — le statut a changé dans la même transaction. Si A avait décidé d'accepter l'invitation sur la base du premier SELECT, elle aurait agi sur une donnée devenue obsolète.

### Exemple B — Repeatable Read : snapshot stable et erreur 40001

Objectif : montrer que Repeatable Read fige le snapshot **et** lève une erreur 40001 si la ligne a été modifiée concurremment avant l'UPDATE.

```sql
-- Remettre l'invitation à 'pending'
UPDATE invitation SET status = 'pending' WHERE id = 'inv-42';
```

```sql
-- Session A                             -- Session B
BEGIN ISOLATION LEVEL REPEATABLE READ;

SELECT status FROM invitation
  WHERE id = 'inv-42';
-- 'pending'  (snapshot figé ici)
                                         BEGIN;
                                         UPDATE invitation
                                           SET status = 'accepted'
                                           WHERE id = 'inv-42';
                                         COMMIT;

SELECT status FROM invitation
  WHERE id = 'inv-42';
-- 'pending'  ← snapshot figé, ne voit pas le COMMIT de B

UPDATE invitation
  SET status = 'accepted'
  WHERE id = 'inv-42';
-- ERROR: could not serialize access due to concurrent update
-- SQLSTATE 40001 — transaction abortée
ROLLBACK;  -- obligatoire avant toute nouvelle commande
```

Pas-à-pas : (1) le snapshot de A est pris au premier statement — `status = 'pending'` ; (2) B committe ; (3) le second SELECT de A voit toujours `'pending'` (snapshot stable, c'est la garantie Repeatable Read) ; (4) quand A tente l'UPDATE sur une ligne que B a déjà modifiée et commitée, PostgreSQL détecte le conflit et annule A avec SQLSTATE 40001 ; (5) A doit `ROLLBACK` et relancer la transaction complète — au retry, son snapshot sera postérieur au commit de B, elle verra `status = 'accepted'` et sa garde métier (`IF status != 'pending'`) stoppera proprement.

### Exemple C — Observer MVCC avec xmin/xmax

```sql
-- État initial
SELECT xmin, xmax, ctid, id, status FROM invitation WHERE id = 'inv-42';
--  xmin  | xmax | ctid  |   id   | status
-- -------+------+-------+--------+---------
--  1001  |    0 | (0,1) | inv-42 | pending
-- xmax = 0 → tuple vivant

-- Terminal 2 : BEGIN; UPDATE ... ; (ne pas committer)
-- Depuis ce terminal, observer pendant l'update :
SELECT xmin, xmax, ctid, id, status FROM invitation WHERE id = 'inv-42';
--  xmin  | xmax | ctid  |   id   | status
-- -------+------+-------+--------+---------
--  1001  | 1003 | (0,1) | inv-42 | pending
-- xmax = 1003 : la tx 1003 a marqué ce tuple comme expiré mais n'a pas encore commité
-- Ce terminal voit toujours 'pending' : le nouveau tuple non commité reste invisible

-- Après COMMIT du terminal 2 :
SELECT xmin, xmax, ctid, id, status FROM invitation WHERE id = 'inv-42';
--  xmin  | xmax | ctid  |   id   |  status
-- -------+------+-------+--------+----------
--  1003  |    0 | (0,2) | inv-42 | accepted
-- Nouveau tuple à l'emplacement (0,2) — le ctid a changé
-- L'ancien (0,1) avec xmax=1003 est mort, en attente de VACUUM
```

## 4. Pièges & misconceptions

- **« En Read Committed, ma transaction voit un snapshot fixe. »** Faux : le snapshot est pris à **chaque statement**. Deux SELECT successifs dans la même transaction peuvent retourner des valeurs différentes si une autre transaction a commité entre les deux. *Correct* : pour une vue stable sur toute la transaction, utiliser **Repeatable Read**.

- **« PostgreSQL autorise les dirty reads si on demande Read Uncommitted. »** Faux : PostgreSQL traite Read Uncommitted exactement comme Read Committed. Les dirty reads sont impossibles dans PostgreSQL, quel que soit le niveau déclaré.

- **« Une erreur 40001 est un bug à corriger dans le code. »** Faux : c'est le comportement attendu de Repeatable Read et Serializable. *Correct* : implémenter une **boucle de retry** (3 à 5 tentatives, backoff exponentiel) sur SQLSTATE 40001.

- **« Après une erreur 40001, je peux continuer mes requêtes. »** Faux : après toute erreur dans une transaction PostgreSQL, le moteur rejette toutes les commandes suivantes jusqu'au `ROLLBACK` (`current transaction is aborted`). *Correct* : toujours `ROLLBACK` immédiatement, puis relancer la transaction complète.

- **« Serializable est le niveau à utiliser partout pour plus de sécurité. »** Vrai pour la cohérence, faux pour les performances : Serializable génère davantage d'erreurs 40001 (faux positifs SSI), augmente la charge mémoire (predicate locks), et exige un retry systématique. *Correct* : utiliser Read Committed (défaut) pour les CRUD courants, Repeatable Read pour les rapports cohérents ou les lectures longues, Serializable pour les opérations financières ou les systèmes de réservation.

- **« VACUUM est optionnel si la base est petite. »** Faux : MVCC accumule des tuples morts à chaque UPDATE/DELETE — sans VACUUM, la table gonfle (bloat), les index grossissent, et les performances se dégradent. PostgreSQL lance autovacuum automatiquement, mais les tables très actives nécessitent un réglage du seuil ou un VACUUM manuel après des imports massifs.

## 5. Ancrage TribuZen

Couche fil-rouge : **isolation d'une invitation concurrente** dans `smaurier/tribuzen`.

Le cas des deux parents qui acceptent simultanément la même invitation est le scénario de concurrence le plus probable dans TribuZen — une famille multi-appareils où les parents reçoivent tous deux la même notification push et appuient quasi-simultanément.

```sql
-- Structure TribuZen (extrait)
CREATE TABLE invitation (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','accepted','declined')),
  family_id   UUID NOT NULL REFERENCES family(id),
  invitee_id  UUID NOT NULL REFERENCES app_user(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE family_member (
  family_id  UUID NOT NULL REFERENCES family(id),
  user_id    UUID NOT NULL REFERENCES app_user(id),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (family_id, user_id)   -- UNIQUE implicite = filet de sécurité
);
```

Sans isolation suffisante (Read Committed) : les deux transactions passent, deux `family_member` sont insérées pour le même `invitee_id` — la contrainte `PRIMARY KEY (family_id, user_id)` sur `family_member` sauve la mise avec une erreur `23505` (unique violation), mais c'est une erreur logique non retriable qui doit être gérée en amont.

Avec **Repeatable Read** : la deuxième transaction reçoit SQLSTATE 40001 quand elle tente l'UPDATE sur `invitation`. Au retry, son snapshot est postérieur au commit de la première — elle voit `status = 'accepted'` et sa garde métier lève une erreur propre (`ALREADY_ACCEPTED`) sans donnée corrompue.

Décision d'architecture TribuZen : la transaction d'acceptation d'invitation tourne en **Repeatable Read** avec retry sur 40001. La contrainte `PRIMARY KEY` sur `family_member` reste comme filet de sécurité de dernier recours.

## 6. Points clés

1. MVCC : PostgreSQL crée une nouvelle version du tuple à chaque modification. `xmin`/`xmax` contrôlent la visibilité par snapshot. Les lecteurs ne bloquent jamais les écrivains.
2. Dirty reads impossibles dans PostgreSQL : Read Uncommitted se comporte comme Read Committed.
3. **Read Committed** (défaut PG) : snapshot par statement → non-repeatable read et phantom possibles. Convient à 90 % des cas CRUD.
4. **Repeatable Read** : snapshot par transaction → vue stable, phantom protégé par PostgreSQL. Peut lever SQLSTATE 40001 sur conflit d'écriture → retry obligatoire.
5. **Serializable** : SSI détecte les cycles de dépendances read/write → interdit le write skew. Plus d'erreurs 40001, exige retry systématique.
6. `BEGIN ISOLATION LEVEL ...` ou `SET TRANSACTION ISOLATION LEVEL ...` avant toute requête dans la transaction.
7. Après erreur 40001 : `ROLLBACK` immédiat, puis relancer la transaction complète — jamais continuer dans la transaction abortée.
8. VACUUM nettoie les tuples morts accumulés par MVCC : indispensable pour éviter le bloat et que les vieux snapshots bloquent l'autovacuum.

## 7. Seeds Anki

```
Qu'est-ce que MVCC dans PostgreSQL ?|Multi-Version Concurrency Control : chaque UPDATE crée une nouvelle version du tuple (xmin/xmax). Les lecteurs voient leur snapshot sans bloquer les écrivains.
Quel niveau d'isolation est le défaut de PostgreSQL et que garantit-il ?|Read Committed : chaque statement prend un snapshot frais des données commitées. Deux SELECT dans la même transaction peuvent retourner des valeurs différentes.
Quelle anomalie Read Committed ne prévient-il pas ?|Non-repeatable read (relire la même ligne donne un résultat différent) et phantom read (nouvelles lignes apparaissent) et write skew.
PostgreSQL autorise-t-il les dirty reads en Read Uncommitted ?|Non. PostgreSQL traite Read Uncommitted exactement comme Read Committed. Les dirty reads sont impossibles quel que soit le niveau.
Que signifie SQLSTATE 40001 et que faire ?|could not serialize access — conflit de sérialisation en Repeatable Read ou Serializable. Faire ROLLBACK immédiatement puis relancer toute la transaction (retry).
Quelle anomalie Serializable empêche-t-il que Repeatable Read ne bloque pas ?|Write skew : deux transactions lisent un état cohérent et écrivent chacune de leur côté, donnant un résultat impossible en exécution série.
Comment déclarer le niveau d'isolation d'une transaction ?|BEGIN ISOLATION LEVEL REPEATABLE READ ou BEGIN; SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; — avant toute requête dans la transaction.
Que stockent xmin et xmax dans un tuple PostgreSQL ?|xmin = XID de la transaction qui a créé cette version ; xmax = XID de celle qui l'a supprimée/remplacée (0 si le tuple est encore vivant).
Pourquoi Repeatable Read protège-t-il aussi des phantom reads dans PostgreSQL ?|PostgreSQL utilise le snapshot isolation : toutes les requêtes partagent le même snapshot figé — les insertions commitées après ne sont pas visibles, au-delà du minimum du standard SQL.
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-08-isolation-levels/`. Tu reproduis en deux sessions psql le scénario des deux parents TribuZen — tu observes le non-repeatable read en Read Committed, tu provoques l'erreur 40001 en Repeatable Read, tu inspectes xmin/xmax en direct, et tu écris le retry pattern. Corrigé SQL inline dans le README, aucun fichier séparé.
