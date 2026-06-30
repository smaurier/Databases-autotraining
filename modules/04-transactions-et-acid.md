---
titre: Transactions et ACID
cours: 10-postgresql
notions: [transaction, ACID, atomicity, consistency, isolation, durability, BEGIN, COMMIT, ROLLBACK, savepoint, niveaux-isolation, read-committed, repeatable-read, serializable, dirty-read, non-repeatable-read, phantom-read, write-skew, prisma-transaction-interactive, prisma-transaction-sequential, transaction-longue, lock-contention]
outcomes: [délimiter une unité de travail atomique en SQL et avec Prisma, expliquer chaque lettre d'ACID sur un cas réel, choisir le niveau d'isolation selon l'anomalie à éviter, écrire une transaction interactive et séquentielle avec Prisma, éviter une transaction trop longue qui tient les locks]
prerequis: [crud-et-requetes, relations-et-jointures, contraintes]
next: 05-index-fondamentaux
libs: [{ name: prisma, version: ^6 }, { name: "@prisma/client", version: ^6 }, { name: postgresql, version: "16" }]
tribuzen: schéma + requêtes (PostgreSQL + Prisma) — acceptation d'invitation famille atomique
last-reviewed: 2026-06
---

# Transactions et ACID

> **Outcomes — tu sauras FAIRE :** délimiter une unité de travail atomique (SQL + Prisma), expliquer ACID sur un cas réel, choisir le niveau d'isolation selon l'anomalie à éviter, écrire une transaction Prisma interactive et séquentielle, et éviter la transaction trop longue qui tient les locks.
> **Difficulté :** :star::star::star:

## 1. Cas concret d'abord

Dans TribuZen, accepter une invitation famille doit faire **trois écritures liées** : passer l'invitation à `accepted`, créer la ligne `family_member`, et incrémenter le compteur `members_count` de la famille. Si le serveur tombe entre la 1ʳᵉ et la 3ᵉ, tu te retrouves avec une invitation acceptée **sans** membre créé : données incohérentes, bug de production.

```sql
-- Sans transaction : 3 écritures indépendantes, chacune auto-commitée
UPDATE invitation SET status = 'accepted' WHERE id = 'inv-1';   -- ✅ commité
INSERT INTO family_member (family_id, user_id) VALUES ('fam-1', 'u-9'); -- 💥 crash ici
UPDATE family SET members_count = members_count + 1 WHERE id = 'fam-1'; -- jamais exécuté
-- Résultat : invitation 'accepted' mais aucun membre. Incohérence permanente.
```

La transaction résout ça : **tout ou rien**. Soit les trois réussissent ensemble (`COMMIT`), soit aucune ne s'applique (`ROLLBACK`). La suite donne ACID, la syntaxe SQL, les niveaux d'isolation, et l'écriture en Prisma.

## 2. Théorie complète, concise

### Transaction = unité logique de travail

Un groupe d'opérations traité comme **indivisible**. En PostgreSQL, **toute** instruction s'exécute dans une transaction : hors `BEGIN`…`COMMIT`, chaque statement est enveloppé dans sa propre mini-transaction (autocommit). `BEGIN` ouvre une transaction explicite englobant plusieurs statements.

### ACID

- **Atomicity (atomicité).** Tout ou rien. Si une opération échoue, toute la transaction est annulée. Mécanisme : journal de transaction + `ROLLBACK`.
- **Consistency (cohérence).** La base passe d'un état **valide** à un autre état valide : les contraintes (`NOT NULL`, `CHECK`, `FK`, `UNIQUE`) sont vraies après chaque `COMMIT`. C'est ta responsabilité (déclarer les contraintes) + celle du moteur (les faire respecter).
- **Isolation.** Les transactions concurrentes ne se marchent pas dessus ; chacune travaille comme si elle était seule (degré réglable, cf. niveaux). Mécanisme PostgreSQL : **MVCC** (Multi-Version Concurrency Control) — les lecteurs ne bloquent pas les écrivains.
- **Durability (durabilité).** Une fois `COMMIT`, les données survivent à un crash. Mécanisme : **WAL** (Write-Ahead Log) — la modification est écrite dans le journal sur disque **avant** d'être confirmée au client ; au redémarrage, PostgreSQL rejoue le WAL.

### BEGIN / COMMIT / ROLLBACK

```sql
BEGIN;                                              -- ouvre la transaction
UPDATE account SET balance = balance - 100 WHERE id = 1;  -- débit
UPDATE account SET balance = balance + 100 WHERE id = 2;  -- crédit
COMMIT;                                             -- applique atomiquement
-- ou ROLLBACK; pour tout annuler
```

Piège PostgreSQL : après une **erreur** dans une transaction, toutes les commandes suivantes sont **rejetées** (`current transaction is aborted`) jusqu'à `ROLLBACK`. Plus strict que MySQL. Il faut `ROLLBACK` pour repartir.

### SAVEPOINT

Point de reprise interne ; `ROLLBACK TO` annule jusqu'au savepoint sans tuer toute la transaction.

```sql
BEGIN;
INSERT INTO family_member (family_id, user_id) VALUES ('fam-1', 'u-9');
SAVEPOINT after_member;
UPDATE family SET members_count = members_count + 1 WHERE id = 'fam-1';
-- en cas de souci sur l'UPDATE seulement :
ROLLBACK TO after_member;   -- l'INSERT reste, l'UPDATE est annulé
COMMIT;
```

### Niveaux d'isolation et anomalies

Le degré d'isolation décide quelles **anomalies de concurrence** sont possibles. Les trois anomalies du standard SQL :

- **Dirty read** : lire une donnée écrite par une transaction **non encore commitée** (qui pourrait rollback).
- **Non-repeatable read** : relire la **même ligne** dans la même transaction et obtenir une valeur différente (une autre transaction l'a modifiée + commitée entre les deux lectures).
- **Phantom read** : réexécuter la **même requête à plusieurs lignes** et voir apparaître/disparaître des lignes (insertions/suppressions commitées entre les deux).

Et une 4ᵉ, hors standard mais cruciale :

- **Write skew / serialization anomaly** : deux transactions lisent un état cohérent, écrivent chacune de leur côté, et le résultat combiné viole une règle métier qu'aucune n'aurait violée seule.

Les 4 niveaux SQL et leur comportement **réel dans PostgreSQL** :

| Niveau | Dirty read | Non-repeatable | Phantom | Write skew |
|--------|:---:|:---:|:---:|:---:|
| Read Uncommitted | impossible* | possible | possible | possible |
| **Read Committed** (défaut PG) | impossible | possible | possible | possible |
| Repeatable Read | impossible | impossible | impossible** | possible |
| Serializable | impossible | impossible | impossible | impossible |

\* PostgreSQL n'autorise **jamais** les dirty reads : Read Uncommitted s'y comporte exactement comme Read Committed.
\** Le Repeatable Read de PostgreSQL (snapshot isolation) interdit aussi les phantoms, contrairement au minimum du standard. Mais il peut échouer avec `could not serialize access` (`SQLSTATE 40001`) sur écritures conflictuelles → il faut **réessayer** la transaction.

Points décisifs :

- **Read Committed (défaut)** : chaque **statement** voit un snapshot frais des données commitées. Donc deux `SELECT` successifs dans la même transaction peuvent différer. Beaucoup croient à tort qu'une transaction « gèle » sa vue — faux en Read Committed.
- **Repeatable Read** : tous les statements voient le **même** snapshot (celui du premier statement). Vue stable, mais conflits d'écriture → erreur 40001.
- **Serializable** : garantit que le résultat concurrent équivaut à **une** exécution séquentielle (SSI) ; empêche le write skew, au prix de possibles 40001 à retenter.

Régler le niveau :

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ;
-- ...
COMMIT;
-- ou par session : SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
```

### Transactions en Prisma

Deux formes.

**Séquentielle (batch / array)** — une liste d'opérations indépendantes exécutées dans **une seule** transaction, sans logique entre elles :

```typescript
const [updated, member] = await prisma.$transaction([
  prisma.invitation.update({ where: { id: 'inv-1' }, data: { status: 'accepted' } }),
  prisma.familyMember.create({ data: { familyId: 'fam-1', userId: 'u-9' } }),
]);
// Tout commit ensemble ; si une échoue, tout rollback. Pas d'accès aux résultats intermédiaires.
```

**Interactive (callback)** — un client transactionnel `tx` ; tu peux **lire, brancher, calculer** entre les écritures. Le rollback se déclenche en **lançant une erreur** dans le callback :

```typescript
await prisma.$transaction(async (tx) => {
  const inv = await tx.invitation.findUniqueOrThrow({ where: { id: 'inv-1' } });
  if (inv.status !== 'pending') throw new Error('NOT_PENDING'); // → ROLLBACK automatique
  await tx.invitation.update({ where: { id: inv.id }, data: { status: 'accepted' } });
  await tx.familyMember.create({ data: { familyId: inv.familyId, userId: 'u-9' } });
  await tx.family.update({ where: { id: inv.familyId }, data: { membersCount: { increment: 1 } } });
}, {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable, // optionnel
  timeout: 10_000, // ms max d'exécution du callback (défaut 5000) ; sinon erreur P2028
  maxWait: 2_000,  // ms max d'attente d'une connexion du pool (défaut 2000)
});
```

Toujours utiliser `tx` (pas `prisma`) dans le callback : une requête via `prisma` partirait **hors** transaction, sur une autre connexion.

## 3. Worked examples

### Exemple A — acceptation d'invitation atomique (Prisma interactive)

Objectif : les trois écritures TribuZen réussissent ensemble ou pas du tout, avec garde métier.

```typescript
// src/family/accept-invitation.ts
import { PrismaClient, Prisma } from '@prisma/client';
const prisma = new PrismaClient();

export async function acceptInvitation(invitationId: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    // 1. Lire l'invitation DANS la transaction (verrou de cohérence via le snapshot)
    const inv = await tx.invitation.findUniqueOrThrow({ where: { id: invitationId } });

    // 2. Garde métier : une invitation déjà traitée ne se réaccepte pas.
    //    throw => Prisma ROLLBACK tout ce qui précède, rien n'est persisté.
    if (inv.status !== 'pending') throw new Error('NOT_PENDING');

    // 3. Trois écritures liées
    await tx.invitation.update({ where: { id: inv.id }, data: { status: 'accepted' } });
    const member = await tx.familyMember.create({
      data: { familyId: inv.familyId, userId },
    });
    await tx.family.update({
      where: { id: inv.familyId },
      data: { membersCount: { increment: 1 } },
    });

    // 4. La valeur retournée par le callback = valeur résolue de $transaction (après COMMIT)
    return member;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
```

Pas-à-pas : (1) on lit via `tx` pour rester dans le même snapshot ; (2) la garde métier `throw` provoque le `ROLLBACK` — pas besoin d'appeler explicitement rollback ; (3) les trois écritures sont atomiques ; (4) Serializable protège contre deux acceptations concurrentes du **même** `userId` qui doubleraient le compteur (write skew) — en cas de conflit, Prisma propage l'erreur 40001 et l'appelant **réessaie**.

### Exemple B — Read Committed vs Repeatable Read (anomalie observée en SQL)

Objectif : voir concrètement le **non-repeatable read** et comment Repeatable Read l'élimine. Deux sessions psql en parallèle sur `family(members_count)`.

```sql
-- Session 1 (Read Committed, défaut)        | -- Session 2
BEGIN;                                        |
SELECT members_count FROM family             |
  WHERE id = 'fam-1';   -- → 3               |
                                              | UPDATE family SET members_count = 4
                                              |   WHERE id = 'fam-1';
                                              | COMMIT;
SELECT members_count FROM family             |
  WHERE id = 'fam-1';   -- → 4 (a changé !)  |   <-- non-repeatable read
COMMIT;                                       |
```

Même scénario en **Repeatable Read** :

```sql
-- Session 1
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT members_count FROM family WHERE id = 'fam-1';  -- → 3
-- (Session 2 fait UPDATE ... = 4 ; COMMIT)
SELECT members_count FROM family WHERE id = 'fam-1';  -- → 3 (snapshot figé, stable)
COMMIT;
```

Pas-à-pas : en Read Committed, chaque `SELECT` prend un snapshot frais → la 2ᵉ lecture voit le commit de la session 2. En Repeatable Read, tous les `SELECT` partagent le snapshot du **premier** statement → lecture stable. Si la session 1 avait **écrit** sur cette ligne après l'update concurrent, Repeatable Read aurait renvoyé `could not serialize access` (40001) à retenter.

## 4. Pièges & misconceptions

- **« Une transaction gèle ma vue des données. »** Faux en **Read Committed** (le défaut PostgreSQL) : chaque statement voit un snapshot frais, donc deux lectures de la même ligne peuvent différer. *Correct* : pour une vue stable sur toute la transaction, passer en **Repeatable Read**.
- **Transaction trop longue qui tient les locks et bloque VACUUM.** Garder une transaction ouverte (attente utilisateur, appel HTTP, boucle lente) maintient un vieux snapshot : VACUUM ne peut pas nettoyer les tuples morts → **table/index bloat**, **lock contention**, risque de wraparound des transaction IDs. *Correct* : transactions **courtes** ; calculer/appeler les services **hors** transaction, ouvrir la transaction juste pour les écritures ; régler `idle_in_transaction_session_timeout`.
- **Mettre des I/O externes dans le callback `$transaction`.** Un `fetch`/email dans une transaction interactive allonge sa durée (locks tenus) et risque le **timeout** Prisma (`P2028`, défaut 5 s). *Correct* : faire les I/O avant/après ; la transaction ne contient que des requêtes DB.
- **Utiliser `prisma` au lieu de `tx` dans le callback.** Une requête via le client global part sur une **autre** connexion, hors de la transaction → elle commit indépendamment et casse l'atomicité. *Correct* : n'utiliser **que** `tx` à l'intérieur du callback.
- **Croire que Serializable « ne plante jamais ».** Au contraire : Serializable (et Repeatable Read) peuvent échouer avec `40001 could not serialize access` sur conflit. *Correct* : envelopper la transaction d'une **boucle de retry** (3-5 tentatives) sur l'erreur de sérialisation.
- **Compter sur l'ordre du tableau séquentiel pour brancher.** La forme `$transaction([...])` n'expose **pas** les résultats intermédiaires : impossible de lire la ligne A puis décider d'écrire B. *Correct* : dès qu'il y a de la logique/lecture conditionnelle, utiliser la forme **interactive** `async (tx) => {}`.

## 5. Ancrage TribuZen

Couche fil-rouge : **schéma + requêtes (PostgreSQL + Prisma)** dans `smaurier/tribuzen`. L'acceptation d'invitation famille est le cas d'usage transactionnel canonique du produit :

- `acceptInvitation()` (Exemple A) part du `schema.prisma` réel (`Invitation`, `FamilyMember`, `Family`) et garantit l'atomicité des trois écritures via `$transaction` interactive.
- Isolation **Serializable** + retry sur `40001` empêchent qu'un double-clic ou deux requêtes concurrentes créent deux `family_member` et incrémentent deux fois `membersCount` (write skew réel sur un produit familial multi-appareils).
- La même brique servira pour d'autres opérations atomiques TribuZen (transfert de propriété de famille, suppression en cascade contrôlée).
- En session, on écrit la transaction Prisma sur une vraie base Postgres locale (Docker), pas un sandbox — et on la teste avec Vitest (couche du cours 06) en injectant un client Prisma de test.

## 6. Points clés

1. Une transaction est une unité tout-ou-rien ; hors `BEGIN`, PostgreSQL auto-commite chaque statement.
2. ACID : Atomicité (rollback), Cohérence (contraintes), Isolation (MVCC), Durabilité (WAL).
3. `BEGIN`/`COMMIT`/`ROLLBACK` ; après une erreur, PostgreSQL rejette tout jusqu'au `ROLLBACK` ; `SAVEPOINT` permet un rollback partiel.
4. Anomalies : dirty read, non-repeatable read, phantom read, write skew — chacune éliminée à un certain niveau d'isolation.
5. Défaut PostgreSQL = **Read Committed** (snapshot par statement) ; Repeatable Read = snapshot par transaction ; Serializable = équivalent série (SSI).
6. PostgreSQL n'a jamais de dirty read ; Repeatable Read et Serializable peuvent lever `40001` → prévoir un retry.
7. Prisma : `$transaction([...])` séquentielle (pas de logique intermédiaire) vs `$transaction(async (tx) => {})` interactive (lire/brancher, rollback en `throw`).
8. Transactions **courtes**, `tx` uniquement dans le callback, aucune I/O externe dedans, sinon locks tenus et timeout `P2028`.

## 7. Seeds Anki

```
Que signifie ACID ?|Atomicity (tout ou rien), Consistency (état valide → état valide), Isolation (transactions concurrentes ne se voient pas), Durability (COMMIT survit au crash)
Quel mécanisme PostgreSQL assure la durabilité ?|Le WAL (Write-Ahead Log) : la modification est écrite dans le journal sur disque avant de confirmer le COMMIT
Niveau d'isolation par défaut de PostgreSQL ?|Read Committed : chaque statement voit un snapshot frais des données commitées (deux lectures peuvent différer)
Qu'est-ce qu'un non-repeatable read ?|Relire la même ligne dans une transaction et obtenir une valeur différente, car une autre transaction l'a modifiée et commitée entre les deux lectures
Différence dirty read vs non-repeatable read ?|Dirty read = lire une donnée NON commitée ; non-repeatable read = relire une donnée commitée modifiée entre-temps. PostgreSQL n'autorise jamais les dirty reads
Forme interactive vs séquentielle de prisma.$transaction ?|Interactive: async (tx) => {} permet de lire/brancher, rollback en throw ; séquentielle: $transaction([...]) exécute une liste sans logique intermédiaire
Comment déclencher un ROLLBACK dans une transaction interactive Prisma ?|Lancer (throw) une erreur dans le callback ; Prisma annule alors toutes les écritures
Pourquoi éviter les transactions longues ?|Elles tiennent les locks et un vieux snapshot, empêchant VACUUM de nettoyer les tuples morts → table bloat, lock contention, risque de wraparound
Que faut-il prévoir avec l'isolation Serializable ou Repeatable Read ?|Une boucle de retry, car PostgreSQL peut lever 40001 (could not serialize access) sur conflit d'écriture
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-04-transactions/`. Tu écris une transaction Prisma interactive d'acceptation d'invitation TribuZen (atomicité des 3 écritures + garde métier), tu observes un non-repeatable read en deux sessions psql, et tu ajoutes une boucle de retry sur l'erreur 40001. Corrigé complet commenté + variante J+30 dans le README du lab.
