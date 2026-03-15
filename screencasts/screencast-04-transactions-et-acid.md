# Screencast 04 — Transactions et ACID

## Informations
- **Durée estimée** : 15-18 min
- **Module** : `modules/04-transactions-et-acid.md`
- **Lab associé** : `labs/lab-04-transactions/`
- **Prérequis** : Modules 01-03 terminés, PostgreSQL running, base `course_db`

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] Deux terminaux ouverts dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] Deux sessions `psql` connectées à `course_db`

## Script

### [00:00-03:00] ACID expliqué

> Les transactions sont le mécanisme qui protège vos données. ACID — Atomicité, Cohérence, Isolation, Durabilité — ce sont les quatre propriétés qui garantissent que vos données restent fiables, même en cas de crash ou d'accès concurrent.

**Action** : Afficher un slide ou schéma avec les 4 propriétés ACID.

> Atomicité : une transaction s'exécute entièrement ou pas du tout. Si un virement bancaire débite un compte mais échoue au moment du crédit, tout est annulé. Cohérence : les contraintes de la base sont toujours respectées. Isolation : les transactions concurrentes ne se voient pas mutuellement. Durabilité : une fois validée, la transaction survit à un crash.

**Action** : Créer la table de démonstration.

```sql
-- Table pour les démonstrations
CREATE TABLE accounts (
    id      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name    VARCHAR(50) NOT NULL UNIQUE,
    balance NUMERIC(12, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0)
);

-- Insérer des comptes
INSERT INTO accounts (name, balance) VALUES
    ('Alice', 1000.00),
    ('Bob', 500.00),
    ('Charlie', 250.00);

SELECT * FROM accounts;
```

### [03:00-07:00] BEGIN / COMMIT / ROLLBACK en démo

> Voyons les transactions en action. Par défaut, chaque requête SQL est une transaction implicite. Mais on peut regrouper plusieurs requêtes dans une transaction explicite.

**Action** : Démontrer BEGIN/COMMIT dans le terminal 1.

```sql
-- Transaction réussie : virement Alice -> Bob
BEGIN;

UPDATE accounts SET balance = balance - 200 WHERE name = 'Alice';
UPDATE accounts SET balance = balance + 200 WHERE name = 'Bob';

-- Vérifier avant de valider
SELECT * FROM accounts;
-- Alice: 800, Bob: 700

COMMIT;

-- Vérifier après commit
SELECT * FROM accounts;
```

> Tout s'est bien passé. Maintenant, voyons ce qui se passe quand on annule une transaction.

**Action** : Démontrer ROLLBACK.

```sql
-- Transaction annulée : virement Alice -> Charlie
BEGIN;

UPDATE accounts SET balance = balance - 300 WHERE name = 'Alice';
UPDATE accounts SET balance = balance + 300 WHERE name = 'Charlie';

-- Vérifier dans la transaction
SELECT * FROM accounts;
-- Alice: 500, Charlie: 550

-- Oups, on change d'avis !
ROLLBACK;

-- Vérifier après rollback : les soldes sont inchangés
SELECT * FROM accounts;
-- Alice: 800, Charlie: 250
```

> Avec ROLLBACK, tout est annulé. C'est comme si les deux UPDATE n'avaient jamais eu lieu. C'est l'atomicité en action.

**Action** : Comparer les soldes avant et après ROLLBACK pour bien montrer l'annulation.

### [07:00-09:30] SAVEPOINT

> Les SAVEPOINTs permettent de créer des points de restauration à l'intérieur d'une transaction. On peut annuler partiellement sans tout perdre.

**Action** : Démontrer SAVEPOINT dans psql.

```sql
BEGIN;

-- Première opération
UPDATE accounts SET balance = balance - 100 WHERE name = 'Alice';
SELECT balance FROM accounts WHERE name = 'Alice';
-- Alice: 700

-- Créer un point de sauvegarde
SAVEPOINT sp1;

-- Deuxième opération
UPDATE accounts SET balance = balance - 500 WHERE name = 'Alice';
SELECT balance FROM accounts WHERE name = 'Alice';
-- Alice: 200

-- On revient au savepoint : on annule la deuxième opération seulement
ROLLBACK TO SAVEPOINT sp1;
SELECT balance FROM accounts WHERE name = 'Alice';
-- Alice: 700 (la première opération est conservée)

-- Troisième opération (après le rollback partiel)
UPDATE accounts SET balance = balance + 100 WHERE name = 'Charlie';

COMMIT;

SELECT * FROM accounts;
-- Alice: 700, Charlie: 350
```

> Le SAVEPOINT est utile quand on à une longue transaction et qu'une opération optionnelle peut échouer sans devoir tout recommencer.

**Action** : Montrer le solde d'Alice à chaque étape pour visualiser l'effet du SAVEPOINT.

### [09:30-12:00] WAL — Visualisation

> Comment PostgreSQL garantit-il la durabilité ? Grâce au WAL — Write-Ahead Log. Avant d'écrire dans les fichiers de données, PostgreSQL écrit d'abord dans un journal. En cas de crash, il rejoue le journal pour retrouver un état cohérent.

**Action** : Montrer le répertoire WAL dans le conteneur Docker.

```bash
# Voir les fichiers WAL dans le conteneur PostgreSQL
docker exec -it pg-course ls -la /var/lib/postgresql/data/pg_wal/

# Taille du répertoire WAL
docker exec -it pg-course du -sh /var/lib/postgresql/data/pg_wal/
```

```sql
-- Voir la position actuelle dans le WAL
SELECT pg_current_wal_lsn();

-- Faire une opération
UPDATE accounts SET balance = balance + 1 WHERE name = 'Alice';

-- Nouvelle position WAL (a avancé)
SELECT pg_current_wal_lsn();

-- Voir les statistiques WAL
SELECT * FROM pg_stat_wal;
```

> Chaque transaction écrite génère des enregistrements WAL. Le LSN (Log Sequence Number) avance à chaque écriture. C'est ce mécanisme qui permet aussi la réplication — on envoie le WAL à un serveur secondaire.

**Action** : Comparer les deux positions LSN pour montrer que le WAL a progressé.

### [12:00-15:30] Gestion d'erreurs en Node.js

> En Node.js, il faut gérer les transactions explicitement. Et surtout, il faut s'assurer qu'on fait ROLLBACK en cas d'erreur.

**Action** : Ouvrir l'éditeur et montrer le code.

```javascript
// demo-transaction.js
const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'secret',
  database: 'course_db',
});

async function transfer(from, to, amount) {
  // Récupérer un client depuis le pool (important pour les transactions)
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Débiter le compte source
    const debit = await client.query(
      'UPDATE accounts SET balance = balance - $1 WHERE name = $2 AND balance >= $1 RETURNING balance',
      [amount, from]
    );

    if (debit.rowCount === 0) {
      throw new Error(`Solde insuffisant pour ${from}`);
    }

    // Créditer le compte destination
    const credit = await client.query(
      'UPDATE accounts SET balance = balance + $1 WHERE name = $2 RETURNING balance',
      [amount, to]
    );

    if (credit.rowCount === 0) {
      throw new Error(`Compte ${to} introuvable`);
    }

    await client.query('COMMIT');
    console.log(`Virement de ${amount}€ : ${from} -> ${to} OK`);
    console.log(`  ${from}: ${debit.rows[0].balance}€`);
    console.log(`  ${to}: ${credit.rows[0].balance}€`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Transaction annulée :', err.message);
  } finally {
    // TOUJOURS relâcher le client dans le pool
    client.release();
  }
}

async function main() {
  await transfer('Alice', 'Bob', 100);  // OK
  await transfer('Charlie', 'Alice', 9999);  // Erreur : solde insuffisant
  await pool.end();
}

main();
```

**Action** : Exécuter le script et montrer les deux cas : succès et échec.

```bash
node demo-transaction.js
# Sortie :
# Virement de 100€ : Alice -> Bob OK
#   Alice: 600.00€
#   Bob: 800.00€
# Transaction annulée : Solde insuffisant pour Charlie
```

> Le pattern try/catch/finally est essentiel. Le `finally` garantit que le client est relâché dans le pool, même en cas d'erreur. Sans ça, vous finissez par épuiser les connexions disponibles.

**Action** : Pointer le `client.release()` dans le finally et expliquer son importance.

### [15:30-17:00] Walkthrough Lab-04

> Le lab 04 vous fait implémenter des transactions complètes avec gestion d'erreurs. Voici un aperçu.

**Action** : Ouvrir `labs/lab-04-transactions/` dans l'éditeur et parcourir le README.

```sql
-- Aperçu lab-04 : transactions avec contraintes
-- Vous devrez gérer un scénario de virement bancaire complet
-- avec vérification de solde, gestion d'erreurs et SAVEPOINT.

-- Vérifier l'état final
SELECT name, balance FROM accounts ORDER BY name;
```

**Action** : Montrer les fichiers du lab et les tests de validation.

### [17:00-17:45] Conclusion

> Les transactions sont un pilier fondamental de PostgreSQL. On a vu BEGIN/COMMIT/ROLLBACK, les SAVEPOINTs, le WAL qui garantit la durabilité, et le pattern de gestion d'erreurs en Node.js. Dans le prochain module, on attaque les index — comment accélérer vos requêtes.

**Action** : Nettoyage.

```sql
DROP TABLE IF EXISTS accounts;
```

## Points d'attention pour l'enregistrement
- Avoir deux terminaux/sessions psql visibles simultanément pour certaines démos
- Bien montrer l'état des comptes avant et après chaque transaction
- Accentuer le moment du ROLLBACK et montrer que les données sont inchangées
- Pour le WAL, ne pas passer trop de temps — c'est un aperçu
- Le code Node.js doit être testé et fonctionnel avant l'enregistrement
- Parler lentement lors de l'explication ACID — ce sont des concepts importants
