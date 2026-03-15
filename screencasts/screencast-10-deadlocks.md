# Screencast 10 — Deadlocks

## Informations
- **Durée estimée** : 15-18 min
- **Module** : `modules/10-deadlocks.md`
- **Lab associé** : `labs/lab-10-deadlocks/`
- **Prérequis** : Module 09 (verrous) terminé, PostgreSQL running, base `course_db`

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] **Deux terminaux** ouverts dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] **Deux sessions psql** connectées à `course_db`

## Script

### [00:00-01:30] Introduction

> Un deadlock, c'est quand deux transactions se bloquent mutuellement. Transaction A attend que B libère un verrou, et B attend que A libère un autre verrou. Ni l'une ni l'autre ne peut progresser — c'est un blocage circulaire.

**Action** : Afficher un schéma de deadlock (cercle avec deux transactions et deux ressources).

> PostgreSQL détecte automatiquement les deadlocks et tue l'une des deux transactions. Mais c'est une situation qu'on veut éviter. Voyons comment la provoquer et la prévenir.

**Action** : Créer la table de démonstration.

```sql
-- Table pour la démonstration
CREATE TABLE accounts (
    id      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name    VARCHAR(50) NOT NULL UNIQUE,
    balance NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0)
);

INSERT INTO accounts (name, balance) VALUES
    ('Alice', 1000.00),
    ('Bob', 1000.00);

SELECT * FROM accounts;
```

### [01:30-06:00] Provoquer un deadlock — Deux terminaux

> On va provoquer un deadlock en faisant deux virements croisés en même temps : Alice -> Bob et Bob -> Alice.

**Action** : Disposer les deux terminaux côte à côte. Exécuter les commandes dans l'ordre exact.

```sql
-- === ÉTAPE 1 : TERMINAL 1 ===
BEGIN;
-- Transaction 1 verrouille Alice
UPDATE accounts SET balance = balance - 100 WHERE name = 'Alice';
-- OK — verrou sur la ligne Alice
```

```sql
-- === ÉTAPE 2 : TERMINAL 2 ===
BEGIN;
-- Transaction 2 verrouille Bob
UPDATE accounts SET balance = balance - 100 WHERE name = 'Bob';
-- OK — verrou sur la ligne Bob
```

```sql
-- === ÉTAPE 3 : TERMINAL 1 ===
-- Transaction 1 essaie de verrouiller Bob
UPDATE accounts SET balance = balance + 100 WHERE name = 'Bob';
-- BLOQUÉ ! Terminal 1 attend que Terminal 2 libère Bob
```

```sql
-- === ÉTAPE 4 : TERMINAL 2 ===
-- Transaction 2 essaie de verrouiller Alice
UPDATE accounts SET balance = balance + 100 WHERE name = 'Alice';
-- DEADLOCK DÉTECTÉ !
-- ERROR: deadlock detected
-- DETAIL: Process X waits for ShareLock on transaction Y;
--         blocked by process Z.
--         Process Z waits for ShareLock on transaction W;
--         blocked by process X.
```

> PostgreSQL détecte le deadlock en environ 1 seconde (configurable avec `deadlock_timeout`). Il choisit l'une des deux transactions et la tue avec une erreur. L'autre transaction est débloquée et peut continuer.

**Action** : Montrer le message d'erreur détaillé du deadlock. Pointer le détail qui montre le cycle de dépendances.

```sql
-- === TERMINAL 2 ===
ROLLBACK;  -- La transaction a déjà échoué
```

```sql
-- === TERMINAL 1 ===
-- Terminal 1 est débloqué et peut continuer
-- Mais on fait un ROLLBACK pour repartir proprement
ROLLBACK;

-- Vérifier que les comptes sont intacts
SELECT * FROM accounts;
-- Alice: 1000, Bob: 1000 (rien n'a changé grâce aux rollbacks)
```

**Action** : Vérifier que les soldes n'ont pas changé — les deux transactions ont été annulées.

### [06:00-08:30] Wait-for graph

> PostgreSQL utilise un wait-for graph pour détecter les deadlocks. C'est un graphe dirigé : chaque noeud est une transaction, chaque arc signifie "attend le verrou de". Un cycle dans ce graphe = deadlock.

**Action** : Dessiner le wait-for graph de notre exemple.

```
Transaction 1 ──attend Bob──> Transaction 2
     ^                              |
     └──────attend Alice────────────┘

     Cycle détecté = DEADLOCK
```

> La détection se fait périodiquement (toutes les `deadlock_timeout` millisecondes, par défaut 1 seconde). PostgreSQL parcourt le graphe et si un cycle est trouvé, il annule la transaction la moins coûteuse.

**Action** : Montrer le paramètre deadlock_timeout.

```sql
-- Voir le timeout de détection (défaut: 1s)
SHOW deadlock_timeout;

-- Voir les logs de deadlock
-- Dans les logs PostgreSQL :
-- LOG: process X detected deadlock while waiting for ShareLock
-- DETAIL: Process X waits for ShareLock on transaction Y; ...
-- HINT: See server log for query details.

-- On peut aussi voir la configuration des logs
SHOW log_lock_waits;
```

### [08:30-12:00] Résolution et prévention — Lock ordering

> La technique numéro un pour éviter les deadlocks : toujours verrouiller les ressources dans le même ordre. Si toutes les transactions verrouillent Alice avant Bob, le deadlock est impossible.

**Action** : Montrer le virement correct sans deadlock.

```sql
-- Remettre à zéro
UPDATE accounts SET balance = 1000 WHERE name IN ('Alice', 'Bob');
```

```sql
-- === SOLUTION : toujours verrouiller dans l'ordre alphabétique (ou par id) ===

-- Virement Alice -> Bob : verrouille Alice (id 1) PUIS Bob (id 2)
-- === TERMINAL 1 ===
BEGIN;
SELECT * FROM accounts WHERE name IN ('Alice', 'Bob') ORDER BY id FOR UPDATE;
-- Verrouille les deux lignes dans l'ordre id ASC
UPDATE accounts SET balance = balance - 100 WHERE name = 'Alice';
UPDATE accounts SET balance = balance + 100 WHERE name = 'Bob';
COMMIT;
```

```sql
-- Virement Bob -> Alice : verrouille AUSSI Alice (id 1) PUIS Bob (id 2)
-- Même ordre, pas de deadlock !
-- === TERMINAL 2 ===
BEGIN;
SELECT * FROM accounts WHERE name IN ('Alice', 'Bob') ORDER BY id FOR UPDATE;
UPDATE accounts SET balance = balance - 50 WHERE name = 'Bob';
UPDATE accounts SET balance = balance + 50 WHERE name = 'Alice';
COMMIT;
```

> En verrouillant toujours par `ORDER BY id`, on garantit un ordre global. Terminal 2 attend que Terminal 1 libère les verrous, mais il n'y a pas de cycle — pas de deadlock.

**Action** : Montrer que cette fois Terminal 2 attend (sans deadlock) puis s'exécute normalement.

```javascript
// demo-safe-transfer.js
const { Pool } = require('pg');
const pool = new Pool({
  host: 'localhost', port: 5432,
  user: 'postgres', password: 'secret', database: 'course_db',
});

async function safeTransfer(from, to, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verrouiller dans l'ordre des IDs (prévention deadlock)
    const ids = [from, to].sort();
    await client.query(
      'SELECT id FROM accounts WHERE name = ANY($1) ORDER BY id FOR UPDATE',
      [ids]
    );

    // Effectuer le virement
    await client.query(
      'UPDATE accounts SET balance = balance - $1 WHERE name = $2',
      [amount, from]
    );
    await client.query(
      'UPDATE accounts SET balance = balance + $1 WHERE name = $2',
      [amount, to]
    );

    await client.query('COMMIT');
    console.log(`Virement ${amount}€ : ${from} -> ${to} OK`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erreur :', err.message);
  } finally {
    client.release();
  }
}

async function main() {
  // Deux virements concurrents — pas de deadlock grâce au lock ordering
  await Promise.all([
    safeTransfer('Alice', 'Bob', 100),
    safeTransfer('Bob', 'Alice', 50),
  ]);

  const { rows } = await pool.query('SELECT * FROM accounts ORDER BY name');
  console.log('Soldes finaux :', rows);
  await pool.end();
}

main();
```

**Action** : Exécuter le script et montrer que les deux virements s'exécutent sans deadlock.

### [12:00-14:30] NOWAIT et SKIP LOCKED comme alternatives

> En plus du lock ordering, `NOWAIT` et `SKIP LOCKED` sont des alternatives pour éviter les deadlocks dans certains scénarios.

**Action** : Montrer les alternatives.

```sql
-- NOWAIT : échouer immédiatement au lieu de créer un deadlock
BEGIN;
SELECT * FROM accounts WHERE name = 'Alice'
FOR UPDATE NOWAIT;
-- Si le verrou est déjà pris, on échoue immédiatement
-- L'application peut retenter avec une stratégie différente
ROLLBACK;

-- SKIP LOCKED : ignorer les lignes verrouillées
-- Parfait pour les job queues ou l'ordre n'est pas critique
SELECT * FROM accounts
WHERE balance > 0
FOR UPDATE SKIP LOCKED
LIMIT 1;

-- Configurer un timeout pour les locks
SET lock_timeout = '5s';
-- Si un lock n'est pas obtenu en 5 secondes, la requête échoue
-- Meilleur que d'attendre indéfiniment

-- Remettre la valeur par défaut
RESET lock_timeout;
```

> `lock_timeout` est un excellent filet de sécurité en production. Plutôt que d'attendre indéfiniment, la requête échoue après un délai configurable. Combiné avec un retry côté application, c'est très robuste.

**Action** : Montrer le paramètre `lock_timeout` et expliquer son utilité.

### [14:30-16:00] Démo Lab-10

> Le lab 10 vous fait provoquer des deadlocks, les diagnostiquer, et implémenter les solutions de prévention.

**Action** : Ouvrir `labs/lab-10-deadlocks/` et parcourir les exercices.

```sql
-- Aperçu lab-10
-- Exercice 1 : Reproduire le deadlock classique (2 comptes)
-- Exercice 2 : Analyser les logs PostgreSQL du deadlock
-- Exercice 3 : Implémenter le lock ordering
-- Exercice 4 : Utiliser NOWAIT et SKIP LOCKED comme alternatives
-- Exercice 5 : Tester avec des virements concurrents en Node.js
```

**Action** : Montrer les fichiers du lab et le script de test concurrent.

### [16:00-17:00] Conclusion

> Les deadlocks sont un problème classique de concurrence. PostgreSQL les détecte et les résout automatiquement, mais il vaut mieux les prévenir. La technique principale est le lock ordering : toujours verrouiller les ressources dans le même ordre. Et en complément, `NOWAIT`, `SKIP LOCKED` et `lock_timeout` sont des outils précieux. Dans le prochain module, on change de sujet pour aborder les performances et l'optimisation.

**Action** : Nettoyage.

```sql
DROP TABLE IF EXISTS accounts;
```

## Points d'attention pour l'enregistrement
- Le timing entre les deux terminaux est crucial pour provoquer le deadlock
- Pratiquer la séquence avant l'enregistrement — il faut que les 4 étapes soient dans le bon ordre
- Bien montrer le message d'erreur détaillé du deadlock
- Prendre le temps de dessiner le wait-for graph (même un schéma simple)
- Le code Node.js doit être pré-testé avec des virements concurrents
- Garder un rythme pédagogique : deadlock -> diagnostic -> prévention
