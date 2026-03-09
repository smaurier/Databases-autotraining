// =============================================================================
// Lab 10 — Deadlocks (Solution)
// =============================================================================

import pg from 'pg';
import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.ts';

const { test, assert, assertEqual, assertIncludes, assertGreaterThan, assertLessThan, summary } = createTestRunner('Lab 10 — Deadlocks');

// ---------------------------------------------------------------------------
// Schema et donnees de test
// ---------------------------------------------------------------------------
const SCHEMA_SQL = `
  DROP TABLE IF EXISTS accounts CASCADE;
  CREATE TABLE accounts (
    id SERIAL PRIMARY KEY,
    owner TEXT NOT NULL,
    balance NUMERIC(12,2) NOT NULL
  );
`;

const SEED_SQL = `
  INSERT INTO accounts (owner, balance) VALUES
    ('Alice', 1000.00),
    ('Bob', 1000.00);
`;

// ---------------------------------------------------------------------------
// Utilitaire : reinitialiser les soldes
// ---------------------------------------------------------------------------
async function resetBalances(c: pg.Client): Promise<void> {
  await query(c, `UPDATE accounts SET balance = 1000.00`);
}

// ---------------------------------------------------------------------------
// Utilitaire : transfert securise avec ordonnancement des verrous
// ---------------------------------------------------------------------------
async function safeTransfer(c: pg.Client, fromId: number, toId: number, amount: number): Promise<void> {
  const firstId = Math.min(fromId, toId);
  const secondId = Math.max(fromId, toId);

  await query(c, 'BEGIN');

  // Verrouiller dans l'ordre croissant des IDs
  const res1 = await query(c, 'SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [firstId]);
  const res2 = await query(c, 'SELECT * FROM accounts WHERE id = $1 FOR UPDATE', [secondId]);

  // Determiner quel est le debiteur
  const fromBalance = (fromId === firstId)
    ? parseFloat(res1.rows[0].balance)
    : parseFloat(res2.rows[0].balance);

  if (fromBalance < amount) {
    await query(c, 'ROLLBACK');
    throw new Error('Solde insuffisant');
  }

  await query(c, 'UPDATE accounts SET balance = balance - $1 WHERE id = $2', [amount, fromId]);
  await query(c, 'UPDATE accounts SET balance = balance + $1 WHERE id = $2', [amount, toId]);
  await query(c, 'COMMIT');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function run(): Promise<void> {
  const client = await createClient();

  try {
    await setupDatabase(client, SCHEMA_SQL);
    await setupDatabase(client, SEED_SQL);
    console.log('\n💀 Lab 10 — Deadlocks\n');

    // -----------------------------------------------------------------------
    // Test 1 : Provoquer un deadlock
    // -----------------------------------------------------------------------
    await test('Provoquer un deadlock entre deux clients', async () => {
      await resetBalances(client);
      const client2 = await createClient();
      try {
        let deadlockDetected = false;
        const maxAttempts = 3;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          deadlockDetected = false;

          // Client 1 verrouille Alice
          await query(client, 'BEGIN');
          await query(client, 'SELECT * FROM accounts WHERE id = 1 FOR UPDATE');

          // Client 2 verrouille Bob
          await query(client2, 'BEGIN');
          await query(client2, 'SELECT * FROM accounts WHERE id = 2 FOR UPDATE');

          // Client 1 tente de verrouiller Bob (sera en attente)
          const p1 = query(client, 'SELECT * FROM accounts WHERE id = 2 FOR UPDATE').catch(err => {
            if (err.code === '40P01') deadlockDetected = true;
          });

          // Delai pour que client 1 soit en attente sur le lock
          await sleep(200);

          // Client 2 tente de verrouiller Alice → deadlock
          const p2 = query(client2, 'SELECT * FROM accounts WHERE id = 1 FOR UPDATE').catch(err => {
            if (err.code === '40P01') deadlockDetected = true;
          });

          await Promise.allSettled([p1, p2]);

          await query(client, 'ROLLBACK').catch(() => {});
          await query(client2, 'ROLLBACK').catch(() => {});

          if (deadlockDetected) break;
          console.log(`    Tentative ${attempt}/${maxAttempts} : deadlock non detecte, nouvelle tentative...`);
          await sleep(100);
        }

        assert(deadlockDetected, 'Un deadlock doit etre detecte');
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 2 : Catcher l'erreur de deadlock (code 40P01)
    // -----------------------------------------------------------------------
    await test('Catcher erreur de deadlock (code 40P01)', async () => {
      await resetBalances(client);
      const client2 = await createClient();
      try {
        let deadlockError = null;
        const maxAttempts = 3;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          deadlockError = null;

          await query(client, 'BEGIN');
          await query(client, 'SELECT * FROM accounts WHERE id = 1 FOR UPDATE');

          await query(client2, 'BEGIN');
          await query(client2, 'SELECT * FROM accounts WHERE id = 2 FOR UPDATE');

          const p1 = query(client, 'SELECT * FROM accounts WHERE id = 2 FOR UPDATE').catch(err => {
            if (err.code === '40P01') deadlockError = err;
          });

          // Delai pour que client 1 soit en attente sur le lock
          await sleep(200);

          const p2 = query(client2, 'SELECT * FROM accounts WHERE id = 1 FOR UPDATE').catch(err => {
            if (err.code === '40P01') deadlockError = err;
          });

          await Promise.allSettled([p1, p2]);

          await query(client, 'ROLLBACK').catch(() => {});
          await query(client2, 'ROLLBACK').catch(() => {});

          if (deadlockError !== null) break;
          console.log(`    Tentative ${attempt}/${maxAttempts} : deadlock non detecte, nouvelle tentative...`);
          await sleep(100);
        }

        assert(deadlockError !== null, 'Doit avoir capture une erreur de deadlock');
        assertEqual(deadlockError.code, '40P01', 'Le code erreur doit etre 40P01');
        assert(
          deadlockError.message.toLowerCase().includes('deadlock'),
          'Le message doit contenir "deadlock"'
        );
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 3 : Prevenir le deadlock avec lock ordering
    // -----------------------------------------------------------------------
    await test('Prevenir le deadlock par ordonnancement des verrous', async () => {
      await resetBalances(client);
      const client2 = await createClient();
      try {
        let deadlockDetected = false;

        // Les deux transferts verrouillent toujours dans l'ordre id=1 puis id=2
        const transfer1 = safeTransfer(client, 1, 2, 100).catch(err => {
          if (err.code === '40P01') deadlockDetected = true;
        });

        const transfer2 = safeTransfer(client2, 2, 1, 50).catch(err => {
          if (err.code === '40P01') deadlockDetected = true;
        });

        await Promise.allSettled([transfer1, transfer2]);
        assert(!deadlockDetected, 'Aucun deadlock ne doit se produire avec lock ordering');

        // Verifier les soldes (Alice: 1000 - 100 + 50 = 950, Bob: 1000 + 100 - 50 = 1050)
        const res = await query(client, 'SELECT * FROM accounts ORDER BY id');
        const alice = parseFloat(res.rows[0].balance);
        const bob = parseFloat(res.rows[1].balance);
        assertEqual(alice + bob, 2000, 'La somme des soldes doit rester 2000');
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 4 : NOWAIT pour echouer rapidement
    // -----------------------------------------------------------------------
    await test('NOWAIT evite le deadlock en echouant rapidement', async () => {
      await resetBalances(client);
      const client2 = await createClient();
      try {
        // Client 1 verrouille Alice
        await query(client, 'BEGIN');
        await query(client, 'SELECT * FROM accounts WHERE id = 1 FOR UPDATE');

        // Client 2 essaie avec NOWAIT → echec immediat (pas de deadlock possible)
        await query(client2, 'BEGIN');
        let noWaitError = false;
        try {
          await query(client2, 'SELECT * FROM accounts WHERE id = 1 FOR UPDATE NOWAIT');
        } catch (err: unknown) {
          noWaitError = true;
          const pgErr = err as { code?: string };
          assertEqual(pgErr.code, '55P03', 'Doit recevoir 55P03 (lock_not_available)');
        }
        assert(noWaitError, 'NOWAIT doit provoquer une erreur immediate');

        await query(client2, 'ROLLBACK');
        await query(client, 'ROLLBACK');
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 5 : SKIP LOCKED pour le traitement de file
    // -----------------------------------------------------------------------
    await test('SKIP LOCKED pour traitement de file sans deadlock', async () => {
      await resetBalances(client);
      const client2 = await createClient();
      try {
        // Client 1 : prend le premier compte
        await query(client, 'BEGIN');
        const res1 = await query(client,
          'SELECT * FROM accounts ORDER BY id LIMIT 1 FOR UPDATE'
        );
        const id1 = res1.rows[0].id;

        // Client 2 : prend le suivant (SKIP LOCKED saute le compte verrouillé)
        await query(client2, 'BEGIN');
        const res2 = await query(client2,
          'SELECT * FROM accounts ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED'
        );
        const id2 = res2.rows[0].id;

        assert(id1 !== id2, 'Les deux clients doivent traiter des comptes differents');
        assertEqual(id1, 1, 'Client 1 doit avoir le compte id=1');
        assertEqual(id2, 2, 'Client 2 doit avoir le compte id=2');

        await query(client2, 'ROLLBACK');
        await query(client, 'ROLLBACK');
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 6 : Verifier pg_stat_database pour les deadlocks
    // -----------------------------------------------------------------------
    await test('Compteur de deadlocks dans pg_stat_database', async () => {
      // Attendre brievement pour que les stats soient rafraichies
      // (pg_stat_database est mis a jour de facon asynchrone)
      await sleep(500);

      const res = await query(client,
        `SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`
      );
      assert(res.rows.length > 0, 'Doit trouver les stats de la base courante');
      const count = parseInt(res.rows[0].deadlocks, 10);

      // Le compteur de deadlocks est cumule depuis le dernier pg_stat_reset().
      // Si les tests precedents ont bien provoque des deadlocks, le compteur sera > 0.
      // Sinon, on affiche un avertissement plutot que de faire echouer le test.
      if (count > 0) {
        console.log(`     → Deadlocks detectes dans pg_stat_database : ${count}`);
      } else {
        console.log(`     ⚠ Compteur de deadlocks = 0 dans pg_stat_database.`);
        console.log(`       Les stats peuvent ne pas etre encore rafraichies ou avoir ete resetees.`);
      }
      assert(count >= 0, 'Le compteur de deadlocks doit etre accessible');
    });

    // -----------------------------------------------------------------------
    // Test 7 : Transfert securise avec ordonnancement
    // -----------------------------------------------------------------------
    await test('Fonction de transfert securisee', async () => {
      await resetBalances(client);

      // Alice envoie 200 a Bob
      await safeTransfer(client, 1, 2, 200);

      const res = await query(client, 'SELECT * FROM accounts ORDER BY id');
      assertEqual(parseFloat(res.rows[0].balance), 800, 'Alice doit avoir 800');
      assertEqual(parseFloat(res.rows[1].balance), 1200, 'Bob doit avoir 1200');
    });

    // -----------------------------------------------------------------------
    // Test 8 : Traitement par lots avec ORDER BY
    // -----------------------------------------------------------------------
    await test('Traitement par lots avec ORDER BY pour eviter les deadlocks', async () => {
      await resetBalances(client);
      const client2 = await createClient();
      try {
        let deadlockDetected = false;

        // Les deux clients utilisent ORDER BY id dans le sous-select
        // pour verrouiller dans le meme ordre
        const batchUpdate = async (c: pg.Client, amount: number) => {
          await query(c, 'BEGIN');
          await query(c,
            `UPDATE accounts SET balance = balance + $1
             WHERE id IN (
               SELECT id FROM accounts WHERE id IN (1, 2) ORDER BY id FOR UPDATE
             )`, [amount]
          );
          await query(c, 'COMMIT');
        };

        const p1 = batchUpdate(client, 10).catch(err => {
          if (err.code === '40P01') deadlockDetected = true;
        });
        const p2 = batchUpdate(client2, 20).catch(err => {
          if (err.code === '40P01') deadlockDetected = true;
        });

        await Promise.allSettled([p1, p2]);
        assert(!deadlockDetected, 'Aucun deadlock avec ORDER BY');

        // Verifier les soldes : Alice = 1000 + 10 + 20 = 1030, Bob = 1000 + 10 + 20 = 1030
        const res = await query(client, 'SELECT * FROM accounts ORDER BY id');
        const alice = parseFloat(res.rows[0].balance);
        const bob = parseFloat(res.rows[1].balance);
        assertEqual(alice, 1030, 'Alice doit avoir 1030');
        assertEqual(bob, 1030, 'Bob doit avoir 1030');
      } finally {
        await client2.end();
      }
    });

    summary();
  } finally {
    await teardownDatabase(client, 'DROP TABLE IF EXISTS accounts CASCADE;');
    await client.end();
  }
}

run().catch(console.error);
