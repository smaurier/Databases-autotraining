// =============================================================================
// Lab 10 — Deadlocks (Exercice)
// =============================================================================

import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.js';

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
// Tests
// ---------------------------------------------------------------------------
async function run() {
  const client = await createClient();

  try {
    await setupDatabase(client, SCHEMA_SQL);
    await setupDatabase(client, SEED_SQL);
    console.log('\n💀 Lab 10 — Deadlocks\n');

    // -----------------------------------------------------------------------
    // Test 1 : Provoquer un deadlock
    // -----------------------------------------------------------------------
    await test('Provoquer un deadlock entre deux clients', async () => {
      const client2 = await createClient();
      try {
        // TODO:
        // 1. Reinitialiser les soldes (Alice=1000, Bob=1000)
        // 2. Client 1 : BEGIN + SELECT ... FOR UPDATE sur Alice (id=1)
        // 3. Client 2 : BEGIN + SELECT ... FOR UPDATE sur Bob (id=2)
        // 4. Client 1 : tenter SELECT ... FOR UPDATE sur Bob (id=2) → en attente
        //    (lancer en parallele avec Promise, sans await immediat)
        // 5. Client 2 : tenter SELECT ... FOR UPDATE sur Alice (id=1) → deadlock !
        // 6. Un des deux clients doit recevoir l'erreur 40P01
        // 7. ROLLBACK les deux transactions
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 2 : Catcher l'erreur de deadlock
    // -----------------------------------------------------------------------
    await test('Catcher erreur de deadlock (code 40P01)', async () => {
      const client2 = await createClient();
      try {
        // TODO:
        // 1. Reproduire le meme scenario de deadlock que le test 1
        // 2. Dans le catch, verifier que err.code === '40P01'
        // 3. Verifier que le message contient "deadlock"
        // 4. ROLLBACK les deux transactions
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 3 : Prevenir le deadlock avec lock ordering
    // -----------------------------------------------------------------------
    await test('Prevenir le deadlock par ordonnancement des verrous', async () => {
      const client2 = await createClient();
      try {
        // TODO:
        // 1. Reinitialiser les soldes
        // 2. Fonction safeTransfer(client, fromId, toId, amount) qui :
        //    - Determine le plus petit ID (firstId) et le plus grand (secondId)
        //    - BEGIN
        //    - SELECT ... FOR UPDATE WHERE id = firstId
        //    - SELECT ... FOR UPDATE WHERE id = secondId
        //    - UPDATE les deux soldes
        //    - COMMIT
        // 3. Lancer 2 transferts en parallele : Alice→Bob et Bob→Alice
        // 4. Verifier qu'aucun deadlock ne se produit
        // 5. Verifier que les soldes sont correctes
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 4 : NOWAIT pour echouer rapidement
    // -----------------------------------------------------------------------
    await test('NOWAIT evite le deadlock en echouant rapidement', async () => {
      const client2 = await createClient();
      try {
        // TODO:
        // 1. Client 1 : BEGIN + FOR UPDATE sur Alice
        // 2. Client 2 : BEGIN + FOR UPDATE NOWAIT sur Alice → erreur 55P03
        // 3. Verifier l'erreur (pas de deadlock, mais echec rapide)
        // 4. ROLLBACK les deux
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 5 : SKIP LOCKED pour le traitement de file
    // -----------------------------------------------------------------------
    await test('SKIP LOCKED pour traitement de file sans deadlock', async () => {
      const client2 = await createClient();
      try {
        // TODO:
        // 1. Client 1 : BEGIN + SELECT ... FOR UPDATE sur le premier compte disponible
        // 2. Client 2 : BEGIN + SELECT ... FOR UPDATE SKIP LOCKED → obtient le 2eme compte
        // 3. Verifier que les deux clients traitent des comptes differents
        // 4. ROLLBACK les deux
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 6 : Verifier pg_stat_database pour le compteur de deadlocks
    // -----------------------------------------------------------------------
    await test('Compteur de deadlocks dans pg_stat_database', async () => {
      // TODO:
      // 1. Lire le compteur actuel : SELECT deadlocks FROM pg_stat_database
      //    WHERE datname = current_database()
      // 2. Verifier que c'est un nombre >= 0
      //    (les deadlocks des tests precedents ont incrementé le compteur)
    });

    // -----------------------------------------------------------------------
    // Test 7 : Transfert securise avec ordonnancement
    // -----------------------------------------------------------------------
    await test('Fonction de transfert securisee', async () => {
      // TODO:
      // 1. Reinitialiser les soldes (Alice=1000, Bob=1000)
      // 2. Implementer safeTransfer(client, fromId, toId, amount) :
      //    - Ordonner les IDs pour eviter les deadlocks
      //    - Verifier le solde suffisant
      //    - Effectuer le transfert
      // 3. Executer safeTransfer(client, 1, 2, 200) → Alice donne 200 a Bob
      // 4. Verifier : Alice = 800, Bob = 1200
    });

    // -----------------------------------------------------------------------
    // Test 8 : Traitement par lots avec ORDER BY
    // -----------------------------------------------------------------------
    await test('Traitement par lots avec ORDER BY pour eviter les deadlocks', async () => {
      const client2 = await createClient();
      try {
        // TODO:
        // 1. Reinitialiser les soldes
        // 2. Client 1 : BEGIN, puis UPDATE accounts SET balance = balance + 10
        //    WHERE id IN (1, 2) avec ORDER BY id (sous-requete)
        //    → UPDATE accounts SET balance = balance + 10
        //       WHERE id IN (SELECT id FROM accounts WHERE id IN (1,2) ORDER BY id FOR UPDATE)
        // 3. Client 2 : pareil mais balance + 20, en parallele
        // 4. Verifier qu'il n'y a pas de deadlock
        // 5. Verifier les soldes finales
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
