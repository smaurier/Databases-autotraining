// =============================================================================
// Lab 04 — Transactions (Solution)
// =============================================================================
// Objectifs :
//   - Utiliser BEGIN, COMMIT, ROLLBACK
//   - Gerer les SAVEPOINTs
//   - Gerer les transferts concurrents
//   - Recuperer apres une erreur
// =============================================================================

import { createTestRunner, createClient, query, sleep } from '../db-test-utils.js';

const { test, assert, assertEqual, summary } = createTestRunner('Lab 04 — Transactions');

let client1;
let client2;

async function resetAccounts(c) {
  await query(c, 'DROP TABLE IF EXISTS accounts');
  await query(c, `
    CREATE TABLE accounts (
      id      SERIAL PRIMARY KEY,
      owner   TEXT NOT NULL,
      balance NUMERIC(12,2) NOT NULL DEFAULT 0
    )
  `);
  await query(c, `
    INSERT INTO accounts (owner, balance) VALUES
      ('Alice', 1000.00),
      ('Bob', 500.00),
      ('Charlie', 750.00)
  `);
}

try {
  client1 = await createClient();
  client2 = await createClient();

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 1 : Transfert basique (debit + credit atomique)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Transfert basique atomique', async () => {
    await resetAccounts(client1);

    await query(client1, 'BEGIN');
    await query(client1, "UPDATE accounts SET balance = balance - 200 WHERE owner = 'Alice'");
    await query(client1, "UPDATE accounts SET balance = balance + 200 WHERE owner = 'Bob'");
    await query(client1, 'COMMIT');

    const alice = await query(client1, "SELECT balance FROM accounts WHERE owner = 'Alice'");
    const bob = await query(client1, "SELECT balance FROM accounts WHERE owner = 'Bob'");
    assertEqual(parseFloat(alice.rows[0].balance), 800, 'Alice devrait avoir 800');
    assertEqual(parseFloat(bob.rows[0].balance), 700, 'Bob devrait avoir 700');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2 : Rollback sur fonds insuffisants
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Rollback sur fonds insuffisants', async () => {
    await resetAccounts(client1);

    await query(client1, 'BEGIN');
    await query(client1, "UPDATE accounts SET balance = balance - 5000 WHERE owner = 'Alice'");

    // Verification du solde dans la transaction
    const check = await query(client1, "SELECT balance FROM accounts WHERE owner = 'Alice'");
    const balance = parseFloat(check.rows[0].balance);

    if (balance < 0) {
      // Fonds insuffisants : on annule
      await query(client1, 'ROLLBACK');
    } else {
      await query(client1, "UPDATE accounts SET balance = balance + 5000 WHERE owner = 'Bob'");
      await query(client1, 'COMMIT');
    }

    // Verification : les soldes sont inchanges
    const alice = await query(client1, "SELECT balance FROM accounts WHERE owner = 'Alice'");
    const bob = await query(client1, "SELECT balance FROM accounts WHERE owner = 'Bob'");
    assertEqual(parseFloat(alice.rows[0].balance), 1000, 'Alice devrait toujours avoir 1000');
    assertEqual(parseFloat(bob.rows[0].balance), 500, 'Bob devrait toujours avoir 500');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3 : SAVEPOINT avec rollback partiel
  // ─────────────────────────────────────────────────────────────────────────────
  await test('SAVEPOINT avec rollback partiel', async () => {
    await resetAccounts(client1);

    await query(client1, 'BEGIN');

    // Operation 1 : bonus de 100 pour Alice
    await query(client1, "UPDATE accounts SET balance = balance + 100 WHERE owner = 'Alice'");

    // Point de sauvegarde avant l'operation risquee
    await query(client1, 'SAVEPOINT avant_transfert');

    // Operation 2 : debit de 2000 (trop !)
    await query(client1, "UPDATE accounts SET balance = balance - 2000 WHERE owner = 'Alice'");

    // Annulation de l'operation 2 seulement
    await query(client1, 'ROLLBACK TO SAVEPOINT avant_transfert');

    // Validation : le bonus est conserve
    await query(client1, 'COMMIT');

    const alice = await query(client1, "SELECT balance FROM accounts WHERE owner = 'Alice'");
    assertEqual(parseFloat(alice.rows[0].balance), 1100, 'Alice devrait avoir 1100 (bonus conserve)');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4 : Transferts concurrents (2 clients)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Transferts concurrents (2 clients)', async () => {
    await resetAccounts(client1);

    // Client 1 : Alice -> Bob 100 EUR
    await query(client1, 'BEGIN');
    await query(client1, "UPDATE accounts SET balance = balance - 100 WHERE owner = 'Alice'");
    await query(client1, "UPDATE accounts SET balance = balance + 100 WHERE owner = 'Bob'");
    await query(client1, 'COMMIT');

    // Client 2 : Charlie -> Alice 200 EUR
    await query(client2, 'BEGIN');
    await query(client2, "UPDATE accounts SET balance = balance - 200 WHERE owner = 'Charlie'");
    await query(client2, "UPDATE accounts SET balance = balance + 200 WHERE owner = 'Alice'");
    await query(client2, 'COMMIT');

    // Verification : Alice = 1000 - 100 + 200 = 1100, Bob = 600, Charlie = 550
    const alice = await query(client1, "SELECT balance FROM accounts WHERE owner = 'Alice'");
    const bob = await query(client1, "SELECT balance FROM accounts WHERE owner = 'Bob'");
    const charlie = await query(client1, "SELECT balance FROM accounts WHERE owner = 'Charlie'");
    assertEqual(parseFloat(alice.rows[0].balance), 1100, 'Alice devrait avoir 1100');
    assertEqual(parseFloat(bob.rows[0].balance), 600, 'Bob devrait avoir 600');
    assertEqual(parseFloat(charlie.rows[0].balance), 550, 'Charlie devrait avoir 550');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5 : Recuperation apres erreur (etat avorte)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Recuperation apres erreur (etat avorte)', async () => {
    await resetAccounts(client1);

    await query(client1, 'BEGIN');

    // Requete invalide qui provoque une erreur
    try {
      await query(client1, 'SELECT * FROM table_qui_nexiste_pas');
    } catch (err) {
      // Erreur attendue : la table n'existe pas
      // La transaction est maintenant en etat "avorte"
    }

    // On ne peut plus executer de requetes dans cette transaction
    // Il faut faire un ROLLBACK pour reinitialiser l'etat
    await query(client1, 'ROLLBACK');

    // Le client fonctionne a nouveau
    const result = await query(client1, 'SELECT 1 AS ok');
    assertEqual(result.rows[0].ok, 1, 'Le client devrait fonctionner apres le rollback');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6 : Lecture du solde dans une transaction
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Lecture du solde dans une transaction', async () => {
    await resetAccounts(client1);

    await query(client1, 'BEGIN');

    const result = await query(client1, "SELECT balance FROM accounts WHERE owner = 'Alice'");
    const balance = parseFloat(result.rows[0].balance);
    assertEqual(balance, 1000, 'Le solde d\'Alice devrait etre 1000 dans la transaction');

    await query(client1, 'COMMIT');
  });

} finally {
  if (client1) {
    await query(client1, 'DROP TABLE IF EXISTS accounts');
    await client1.end();
  }
  if (client2) {
    await client2.end();
  }
  summary();
}
