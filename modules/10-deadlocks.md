---
titre: Deadlocks
cours: 10-postgresql
notions: [définition d'un deadlock, détection automatique par PostgreSQL, ordre d'acquisition des verrous, deadlock_timeout, prévention par ordre cohérent, logique de retry applicative, diagnostic depuis les logs]
outcomes: [reproduire et diagnostiquer un deadlock, prévenir les deadlocks par un ordre de verrouillage cohérent, implémenter une logique de retry, lire un message de deadlock]
prerequis: [09-verrous-et-locks]
next: 11-performances-et-optimisation
libs: [{ name: postgresql, version: "17" }]
tribuzen: éviter les deadlocks sur des mises à jour concurrentes de familles TribuZen
last-reviewed: 2026-07
---

# Deadlocks

> **Outcomes — tu sauras FAIRE :** reproduire et diagnostiquer un deadlock en deux sessions psql, prévenir les deadlocks par un ordre de verrouillage cohérent, implémenter une logique de retry sur l'erreur `40P01`, et lire un message de deadlock dans les logs PostgreSQL.
> **Difficulté :** :star::star::star:

## 1. Cas concret d'abord

Dans TribuZen, deux admins exécutent simultanément un **transfert de membre** entre familles. L'admin 1 déplace un utilisateur de la famille A vers B (il met à jour `members_count` sur A puis sur B). L'admin 2 fait l'inverse, de B vers A. Les deux transactions verrouillent les mêmes lignes dans l'**ordre inverse**.

```sql
-- Admin 1 : A → B — lock famille 1 en premier, puis famille 2
BEGIN;
UPDATE families SET members_count = members_count - 1 WHERE id = 1;  -- lock id=1 ✅
UPDATE families SET members_count = members_count + 1 WHERE id = 2;  -- attend id=2 ⏳
COMMIT;

-- Admin 2 : B → A — lock famille 2 en premier, puis famille 1 (en parallèle)
BEGIN;
UPDATE families SET members_count = members_count - 1 WHERE id = 2;  -- lock id=2 ✅
UPDATE families SET members_count = members_count + 1 WHERE id = 1;  -- attend id=1 ⏳
COMMIT;

-- Résultat : admin 1 attend id=2 (tenu par admin 2), admin 2 attend id=1 (tenu par admin 1).
-- Cycle → DEADLOCK détecté par PostgreSQL après deadlock_timeout (~1 s).
-- ERROR:  deadlock detected  (SQLSTATE 40P01)
-- Une transaction est annulée ; l'autre continue normalement.
```

La transaction annulée doit être **retentée** par l'application — sans cela, le transfert est silencieusement perdu. La suite explique le mécanisme de détection, le message de diagnostic, et comment structurer le code pour éviter la situation.

## 2. Théorie complète, concise

### Définition — cycle dans le graphe d'attente

Un deadlock survient quand deux transactions (ou plus) s'attendent mutuellement en formant un **cycle** : A attend que B libère son verrou, et B attend que A libère le sien. Ni l'une ni l'autre ne peut avancer.

```
Transaction A détient : verrou sur ligne 1
Transaction A attend  : verrou sur ligne 2  ──► détenu par B
Transaction B détient : verrou sur ligne 2
Transaction B attend  : verrou sur ligne 1  ──► détenu par A
                                              = cycle → DEADLOCK
```

Une attente simple (A attend B, mais B n'attend pas A) n'est **pas** un deadlock : B finira par libérer son verrou et A poursuivra normalement.

### Détection automatique par PostgreSQL

PostgreSQL ne vérifie pas le cycle en continu pour éviter la surcharge CPU. Quand une transaction se bloque sur un verrou, PostgreSQL attend la durée `deadlock_timeout` (1 s par défaut), puis lance une détection de cycle dans le **wait-for graph** (parcours en profondeur, DFS). Si un cycle est trouvé, une transaction victime est choisie et son travail est annulé (`ROLLBACK` automatique, code d'erreur `40P01`).

La victime n'est pas déterministe — PostgreSQL choisit selon des critères internes. Les **deux** transactions doivent donc implémenter un retry.

### deadlock_timeout

```sql
-- Voir la valeur courante
SHOW deadlock_timeout;
-- 1s

-- Changer pour la session courante (diagnostic, tests)
SET deadlock_timeout = '200ms';

-- Changer globalement (nécessite reload)
ALTER SYSTEM SET deadlock_timeout = '500ms';
SELECT pg_reload_conf();
```

La valeur par défaut (1 s) est un bon compromis : assez longue pour ne pas déclencher la détection sur des attentes brèves normales, assez courte pour ne pas bloquer l'application plusieurs secondes. Ne pas descendre en dessous de 100 ms sans mesurer l'impact CPU.

### Le message de deadlock

```
ERROR:  deadlock detected
DETAIL: Process 12345 waits for ShareLock on transaction 67890;
        blocked by process 11111.
        Process 11111 waits for ShareLock on transaction 12345;
        blocked by process 12345.
HINT:   See server log for query details.
CONTEXT: while updating tuple (0,2) in relation "families"
```

- `SQLSTATE 40P01` — code dédié aux deadlocks (à distinguer de `40001` qui est une failure de sérialisation SSI).
- `DETAIL` liste les PIDs et transactions qui forment le cycle.
- `CONTEXT` indique la relation et le tuple en cours de modification au moment de la détection.

Dans les logs PostgreSQL (avec `log_lock_waits = on`) :

```
LOG:  process 12345 detected deadlock while waiting for ShareLock
      on transaction 67890 after 1001.472 ms
DETAIL: Process holding the lock: 11111. Wait queue: .
CONTEXT: while updating tuple (0,2) in relation "families"
STATEMENT: UPDATE families SET members_count = members_count + 1 WHERE id = 2
```

### Prévention par ordre cohérent

La règle fondamentale : **toujours acquérir les verrous dans le même ordre**. Si toutes les transactions verrouillent les lignes dans l'ordre croissant des IDs, aucun cycle ne peut se former.

```sql
-- Pré-verrouillage explicite dans l'ordre croissant
BEGIN;
SELECT id FROM families
  WHERE id IN (1, 2)
  ORDER BY id
  FOR UPDATE;
-- Locks sur id=1 puis id=2 acquis dans l'ordre, quelle que soit la direction du transfert

UPDATE families SET members_count = members_count - 1 WHERE id = 1;
UPDATE families SET members_count = members_count + 1 WHERE id = 2;
COMMIT;
```

Si l'autre transaction respecte le même ordre, elle sera simplement **bloquée** en attente sur le premier lock (attente simple, pas de cycle), puis continuera dès que la première transaction commite.

### Logique de retry applicative

Même avec un ordre cohérent, d'autres scénarios (contraintes UNIQUE, clés étrangères, DDL concurrent) peuvent générer un deadlock. L'application doit **toujours** être prête à retenter la transaction victime :

```typescript
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err.code === '40P01' && attempt < maxAttempts) {
        // Jitter exponentiel : évite que toutes les tentatives refrappent en même temps
        const delay = Math.random() * 80 * 2 ** attempt;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}
```

Toujours utiliser un **jitter** (délai aléatoire) entre les tentatives pour éviter une tempête de retry synchronisés qui recréerait immédiatement la contention.

## 3. Worked examples

### Exemple A — reproduire un deadlock en deux sessions psql

Schéma minimal TribuZen pour le lab :

```sql
CREATE TABLE families (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  members_count INT  NOT NULL DEFAULT 0
);
INSERT INTO families (name, members_count) VALUES ('Martin', 3), ('Dupont', 5);
```

Deux sessions psql côte à côte — exécuter chaque étape dans l'ordre exact :

```sql
-- SESSION 1
BEGIN;
UPDATE families SET members_count = members_count - 1 WHERE id = 1;
-- ✅ UPDATE 1 — lock RowExclusive acquis sur id=1

-- (exécuter l'étape B dans session 2, puis continuer ici)

UPDATE families SET members_count = members_count + 1 WHERE id = 2;
-- ⏳ bloqué — attend que session 2 libère id=2
-- Après ~1 s : soit COMMIT (survivant), soit ERROR: deadlock detected (victime)
```

```sql
-- SESSION 2 (après l'étape A de session 1)
BEGIN;
UPDATE families SET members_count = members_count - 1 WHERE id = 2;
-- ✅ UPDATE 1 — lock RowExclusive acquis sur id=2

UPDATE families SET members_count = members_count + 1 WHERE id = 1;
-- ⏳ bloqué — attend id=1 → DEADLOCK : session 1 attend id=2, session 2 attend id=1
-- ERROR:  deadlock detected
-- DETAIL: Process … waits for ShareLock on transaction …
ROLLBACK;  -- automatique si victime ; sinon relancer manuellement
```

Pas-à-pas : (1) session 1 prend le lock sur `id=1` ; (2) session 2 prend le lock sur `id=2` ; (3) session 1 tente `id=2` — bloquée ; (4) session 2 tente `id=1` — cycle détecté ; (5) PostgreSQL annule une victime après `deadlock_timeout` ; (6) l'autre session continue et peut commiter.

### Exemple B — prévenir avec SELECT … FOR UPDATE ORDER BY

La correction : pré-verrouiller toutes les lignes dans l'**ordre croissant** dès le début de la transaction, avant les UPDATE.

```sql
-- SESSION 1 — transfert famille 1 → 2
BEGIN;
SELECT id FROM families
  WHERE id IN (1, 2)
  ORDER BY id
  FOR UPDATE;
-- ✅ locks acquis : id=1 puis id=2

UPDATE families SET members_count = members_count - 1 WHERE id = 1;
UPDATE families SET members_count = members_count + 1 WHERE id = 2;
COMMIT;
```

```sql
-- SESSION 2 — transfert famille 2 → 1 (concurrent)
BEGIN;
SELECT id FROM families
  WHERE id IN (1, 2)
  ORDER BY id
  FOR UPDATE;
-- ⏳ bloquée sur id=1 (tenu par session 1) — attente simple, pas de cycle
-- Dès que session 1 commite, session 2 obtient ses locks et continue

UPDATE families SET members_count = members_count + 1 WHERE id = 1;
UPDATE families SET members_count = members_count - 1 WHERE id = 2;
COMMIT;
```

Pas-à-pas : (1) les deux sessions tentent de verrouiller dans l'ordre `1` puis `2` ; (2) session 2 est **bloquée** sur `id=1`, elle attend — pas de cycle car session 1 n'attend rien ; (3) session 1 commite, session 2 obtient ses locks, les UPDATE s'exécutent, session 2 commite. Aucun `deadlock detected`.

## 4. Pièges & misconceptions

- **Confondre deadlock et simple attente.** Un verrou bloqué n'est pas forcément un deadlock. Le deadlock exige un **cycle** : A attend B **et** B attend A (ou cycle plus long). Une attente simple se résout quand l'autre transaction termine. *Correct* : consulter `pg_stat_activity` (`wait_event_type = 'Lock'`) pour voir les attentes ; `40P01` n'est levé qu'en cas de cycle réel.

- **Ignorer l'erreur 40P01 et ne pas retenter.** La transaction victime est entièrement annulée. Si l'application ne la relance pas, l'opération est **silencieusement perdue** — pas d'exception visible pour l'utilisateur si l'erreur est avalée. *Correct* : toujours envelopper les transactions critiques dans une boucle de retry sur `40P01` (et `40001` pour SSI).

- **Croire que deadlock_timeout est le délai avant ROLLBACK.** `deadlock_timeout` est le délai **avant que la détection de cycle commence**, pas avant la résolution. Si le cycle est confirmé, le ROLLBACK suit immédiatement. Si pas de cycle, l'attente continue jusqu'à `lock_timeout` ou libération du verrou. *Correct* : `deadlock_timeout` ≠ délai garanti de résolution.

- **Ne trier les IDs que dans un seul code path.** L'ordre cohérent ne fonctionne que si **toutes** les transactions qui touchent ces lignes respectent la même convention. Un seul endroit qui verrouille dans l'ordre inverse suffit à recréer le cycle. *Correct* : encapsuler la logique de pré-verrouillage (`SELECT … FOR UPDATE ORDER BY id`) dans une fonction partagée plutôt que de répliquer la convention dans plusieurs modules.

- **Mettre deadlock_timeout très bas pour « détecter vite ».** Une valeur trop basse (< 100 ms) déclenche la détection sur des attentes courtes normales, augmentant la charge CPU sans bénéfice. *Correct* : garder 1 s par défaut ou descendre à 500 ms si les transactions sont très brèves ; mesurer `pg_stat_database.deadlocks` avant et après tout changement.

- **Supposer que c'est toujours la deuxième transaction qui est victime.** PostgreSQL choisit la victime selon des critères internes non documentés — ce n'est pas déterministe. *Correct* : les **deux** côtés doivent implémenter le retry ; ne jamais écrire un code qui suppose qu'une transaction survivra toujours.

## 5. Ancrage TribuZen

Couche fil-rouge : **éviter les deadlocks sur des mises à jour concurrentes de familles** dans `smaurier/tribuzen`.

- Le transfert de membre (`transferMember(fromFamilyId, toFamilyId, userId)`) touche deux lignes `families` dans une transaction. Sans ordre cohérent, deux transferts croisés simultanés — fréquents dans une app multi-appareils multi-admin — provoquent un deadlock.
- La correction canonique — `SELECT … FOR UPDATE ORDER BY id` avant les UPDATE — est encapsulée dans une fonction `transferMember` partagée, garantissant l'ordre quelle que soit la direction du transfert (A→B ou B→A).
- La boucle de retry sur `40P01` est nécessaire même avec l'ordre cohérent : des deadlocks peuvent encore survenir lors d'INSERTs avec contrainte UNIQUE sur l'email de famille, ou via des FK sur `family_members`.
- `pg_stat_database.deadlocks` est intégré au dashboard de monitoring TribuZen : un pic signale une régression dans l'ordre d'acquisition des verrous, souvent après un refactor d'un code path de mise à jour.
- `log_lock_waits = on` est activé en développement pour voir dans les logs toute attente dépassant `deadlock_timeout` — signal précoce d'une contention avant qu'un vrai deadlock ne survienne en production.

## 6. Points clés

1. Un deadlock est un **cycle** dans le graphe d'attente ; une simple attente sans cycle n'est pas un deadlock et se résout naturellement.
2. PostgreSQL détecte les cycles automatiquement après `deadlock_timeout` (défaut 1 s) et annule la transaction victime avec `SQLSTATE 40P01`.
3. Le message `ERROR: deadlock detected` précise les PIDs et transactions du cycle ; `CONTEXT` indique la relation et le tuple concerné.
4. `deadlock_timeout` est le délai avant que la **détection commence**, pas le délai avant résolution — si pas de cycle, l'attente continue.
5. Prévention fondamentale : acquérir les verrous dans le **même ordre** dans toutes les transactions — `SELECT … FOR UPDATE ORDER BY id` en début de transaction.
6. L'application **doit** retenter la transaction victime sur `40P01` ; sans retry, l'opération est silencieusement perdue.
7. Utiliser un **jitter** (délai aléatoire exponentiel) entre les tentatives pour éviter une tempête de retry synchronisés.
8. Monitorer `pg_stat_database.deadlocks` et activer `log_lock_waits = on` pour détecter une régression avant la production.

## 7. Seeds Anki

```
Qu'est-ce qu'un deadlock en PostgreSQL ?|Un cycle dans le graphe d'attente : transaction A attend un verrou détenu par B, et B attend un verrou détenu par A. Aucune ne peut avancer.
Quel SQLSTATE PostgreSQL lève-t-il pour un deadlock ?|40P01 (ERROR: deadlock detected). À distinguer de 40001 qui est une failure de sérialisation SSI.
À quoi sert deadlock_timeout ?|Délai d'attente avant que PostgreSQL lance la détection de cycle (DFS sur le wait-for graph). Défaut 1 s. Ce n'est pas le délai avant ROLLBACK.
Comment prévenir un deadlock par l'ordre des verrous ?|Toujours acquérir les verrous dans le même ordre. Utiliser SELECT … FOR UPDATE ORDER BY id en début de transaction pour pré-verrouiller dans l'ordre croissant.
Que doit faire l'application quand elle reçoit l'erreur 40P01 ?|Retenter la transaction avec un jitter (délai aléatoire exponentiel) — sans retry, l'opération est silencieusement perdue. Viser 3 à 5 tentatives.
Comment compter les deadlocks survenus sur une base PostgreSQL ?|SELECT deadlocks FROM pg_stat_database WHERE datname = current_database();
Quel paramètre activer pour loguer les attentes de verrou longues ?|log_lock_waits = on — PostgreSQL logue toute attente dépassant deadlock_timeout, même sans deadlock réel.
Différence entre deadlock 40P01 et serialization failure 40001 ?|40P01 = cycle d'attente de verrous entre transactions. 40001 = conflit détecté par SSI sans blocage physique. Les deux nécessitent un retry.
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-10-deadlocks/`. Tu reproduis un deadlock en deux sessions psql sur le schéma TribuZen, tu observes le message d'erreur et les compteurs de monitoring, tu corriges par `SELECT … FOR UPDATE ORDER BY id`, et tu implémentes la boucle de retry en SQL. Corrigé SQL inline dans le README, aucun fichier séparé.
