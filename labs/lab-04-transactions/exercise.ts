// =============================================================================
// Lab 04 — Transactions (Exercice)
// =============================================================================
// Objectifs :
//   - Utiliser BEGIN, COMMIT, ROLLBACK
//   - Gerer les SAVEPOINTs
//   - Gerer les transferts concurrents
//   - Recuperer apres une erreur
// =============================================================================

import pg from 'pg';
import { createTestRunner, createClient, query, sleep } from '../db-test-utils.ts';

const { test, assert, assertEqual, summary } = createTestRunner('Lab 04 — Transactions');

let client1: pg.Client | undefined;
let client2: pg.Client | undefined;

async function resetAccounts(c: pg.Client): Promise<void> {
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
    await resetAccounts(client1!);

    // TODO 1 : Effectuez un transfert de 200 EUR d'Alice vers Bob
    // 1. Demarrez une transaction (BEGIN)
    // 2. Debitez Alice de 200
    // 3. Creditez Bob de 200
    // 4. Validez (COMMIT)

    // Verification
    const alice = await query(client1!, "SELECT balance FROM accounts WHERE owner = 'Alice'");
    const bob = await query(client1!, "SELECT balance FROM accounts WHERE owner = 'Bob'");
    assertEqual(parseFloat(alice.rows[0].balance), 800, 'Alice devrait avoir 800');
    assertEqual(parseFloat(bob.rows[0].balance), 700, 'Bob devrait avoir 700');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2 : Rollback sur fonds insuffisants
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Rollback sur fonds insuffisants', async () => {
    await resetAccounts(client1!);

    // TODO 2 : Tentez un transfert de 5000 EUR d'Alice vers Bob
    // 1. BEGIN
    // 2. Debitez Alice de 5000
    // 3. Verifiez le solde d'Alice (SELECT)
    // 4. Si le solde est negatif, ROLLBACK
    // 5. Sinon, creditez Bob et COMMIT

    // Verification : les soldes sont inchanges
    const alice = await query(client1!, "SELECT balance FROM accounts WHERE owner = 'Alice'");
    const bob = await query(client1!, "SELECT balance FROM accounts WHERE owner = 'Bob'");
    assertEqual(parseFloat(alice.rows[0].balance), 1000, 'Alice devrait toujours avoir 1000');
    assertEqual(parseFloat(bob.rows[0].balance), 500, 'Bob devrait toujours avoir 500');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3 : SAVEPOINT avec rollback partiel
  // ─────────────────────────────────────────────────────────────────────────────
  await test('SAVEPOINT avec rollback partiel', async () => {
    await resetAccounts(client1!);

    // TODO 3 : Effectuez deux operations, annulez la seconde avec SAVEPOINT
    // 1. BEGIN
    // 2. Creditez Alice de 100 (bonus)
    // 3. SAVEPOINT avant_transfert
    // 4. Debitez Alice de 2000 (trop !)
    // 5. ROLLBACK TO SAVEPOINT avant_transfert
    // 6. COMMIT
    //
    // Resultat attendu : Alice a 1100 (1000 + 100 bonus, le debit est annule)

    // Verification
    const alice = await query(client1!, "SELECT balance FROM accounts WHERE owner = 'Alice'");
    assertEqual(parseFloat(alice.rows[0].balance), 1100, 'Alice devrait avoir 1100 (bonus conserve)');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4 : Transferts concurrents (2 clients)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Transferts concurrents (2 clients)', async () => {
    await resetAccounts(client1!);

    // TODO 4 : Deux transferts simultanes sur le meme compte
    // Client 1 : Alice -> Bob 100 EUR
    // Client 2 : Charlie -> Alice 200 EUR
    //
    // Les deux transactions doivent reussir sans conflit
    // Indice : commencez les deux BEGINs, puis faites les UPDATEs, puis COMMIT
    // Attention a l'ordre pour eviter les deadlocks :
    //   - Client 1 : debit Alice, credit Bob, COMMIT
    //   - Client 2 : debit Charlie, credit Alice, COMMIT

    // Verification : Alice = 1000 - 100 + 200 = 1100, Bob = 600, Charlie = 550
    const alice = await query(client1!, "SELECT balance FROM accounts WHERE owner = 'Alice'");
    const bob = await query(client1!, "SELECT balance FROM accounts WHERE owner = 'Bob'");
    const charlie = await query(client1!, "SELECT balance FROM accounts WHERE owner = 'Charlie'");
    assertEqual(parseFloat(alice.rows[0].balance), 1100, 'Alice devrait avoir 1100');
    assertEqual(parseFloat(bob.rows[0].balance), 600, 'Bob devrait avoir 600');
    assertEqual(parseFloat(charlie.rows[0].balance), 550, 'Charlie devrait avoir 550');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5 : Recuperation apres erreur (etat avorte)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Recuperation apres erreur (etat avorte)', async () => {
    await resetAccounts(client1!);

    // TODO 5 : Gerez une erreur SQL dans une transaction
    // 1. BEGIN
    // 2. Tentez une requete invalide (ex: SELECT * FROM table_inexistante)
    //    → Attrapez l'erreur avec try/catch
    // 3. La transaction est maintenant en etat "avorte" (aborted)
    // 4. Faites un ROLLBACK pour reinitialiser l'etat
    // 5. Verifiez que le client peut a nouveau executer des requetes

    // Verification : le client fonctionne toujours
    const result = await query(client1!, 'SELECT 1 AS ok');
    assertEqual(result.rows[0].ok, 1, 'Le client devrait fonctionner apres le rollback');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6 : Lecture du solde dans une transaction
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Lecture du solde dans une transaction', async () => {
    await resetAccounts(client1!);

    // TODO 6 : Lisez le solde d'Alice dans une transaction et verifiez sa coherence
    // 1. BEGIN
    // 2. SELECT le solde d'Alice
    // 3. Verifiez qu'il est de 1000
    // 4. COMMIT

    // La verification est dans le TODO ci-dessus
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
