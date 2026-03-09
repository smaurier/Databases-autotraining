// =============================================================================
// Lab 09 — Locks en action (Exercice)
// =============================================================================

import pg from 'pg';
import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.ts';

const { test, assert, assertEqual, assertIncludes, assertGreaterThan, assertLessThan, summary } = createTestRunner('Lab 09 — Locks en action');

// ---------------------------------------------------------------------------
// Schema et donnees de test
// ---------------------------------------------------------------------------
const SCHEMA_SQL = `
  DROP TABLE IF EXISTS seats CASCADE;
  CREATE TABLE seats (
    id SERIAL PRIMARY KEY,
    row_letter CHAR(1) NOT NULL,
    seat_number INT NOT NULL,
    event_id INT NOT NULL,
    status TEXT DEFAULT 'available',
    reserved_by TEXT
  );
`;

const SEED_SQL = `
  INSERT INTO seats (row_letter, seat_number, event_id)
  SELECT
    chr(65 + (s / 10)),   -- A-J
    (s % 10) + 1,         -- 1-10
    1
  FROM generate_series(0, 99) AS s;
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function run(): Promise<void> {
  const client = await createClient();

  try {
    await setupDatabase(client, SCHEMA_SQL);
    await setupDatabase(client, SEED_SQL);
    console.log('\n🔒 Lab 09 — Locks en action\n');

    // -----------------------------------------------------------------------
    // Test 1 : SELECT ... FOR UPDATE pour verrouiller une place
    // -----------------------------------------------------------------------
    await test('FOR UPDATE verrouille une place', async () => {
      // TODO:
      // 1. Demarrer une transaction avec BEGIN
      // 2. Executer SELECT * FROM seats WHERE id = 1 FOR UPDATE
      // 3. Verifier que la place est bien retournee
      // 4. Faire ROLLBACK pour liberer le verrou
    });

    // -----------------------------------------------------------------------
    // Test 2 : Client 2 est bloque quand Client 1 a le verrou
    // -----------------------------------------------------------------------
    await test('Client 2 bloque par le verrou de Client 1', async () => {
      const client2 = await createClient();
      try {
        // TODO:
        // 1. Client 1 : BEGIN + SELECT ... FOR UPDATE sur la place id=1
        // 2. Client 2 : BEGIN, puis tenter SELECT ... FOR UPDATE NOWAIT sur la meme place
        //    (utiliser NOWAIT pour ne pas bloquer indefiniment)
        // 3. Verifier que client2 recoit une erreur (code 55P03 = lock_not_available)
        // 4. ROLLBACK les deux transactions
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 3 : FOR UPDATE NOWAIT leve une erreur si verrouille
    // -----------------------------------------------------------------------
    await test('FOR UPDATE NOWAIT echoue immediatement', async () => {
      const client2 = await createClient();
      try {
        // TODO:
        // 1. Client 1 : BEGIN + FOR UPDATE sur id=1
        // 2. Client 2 : BEGIN + FOR UPDATE NOWAIT sur id=1 dans un try/catch
        // 3. Verifier que l'erreur contient le code '55P03'
        // 4. ROLLBACK les deux transactions
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 4 : SKIP LOCKED saute les places verrouillees
    // -----------------------------------------------------------------------
    await test('SKIP LOCKED retourne la prochaine place disponible', async () => {
      const client2 = await createClient();
      try {
        // TODO:
        // 1. Client 1 : BEGIN + FOR UPDATE sur id=1
        // 2. Client 2 : BEGIN + SELECT ... FROM seats WHERE event_id=1 AND status='available'
        //    ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED
        // 3. Verifier que client2 obtient la place id=2 (pas id=1)
        // 4. ROLLBACK les deux transactions
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 5 : Observer pg_locks
    // -----------------------------------------------------------------------
    await test('Observer les verrous dans pg_locks', async () => {
      // TODO:
      // 1. BEGIN + FOR UPDATE sur une place
      // 2. Requeter pg_locks JOIN pg_stat_activity pour voir les verrous actifs
      //    SELECT l.locktype, l.mode, a.query
      //    FROM pg_locks l JOIN pg_stat_activity a ON l.pid = a.pid
      //    WHERE a.pid = pg_backend_pid()
      // 3. Verifier qu'on trouve au moins un verrou de type 'tuple' ou 'transactionid'
      // 4. ROLLBACK
    });

    // -----------------------------------------------------------------------
    // Test 6 : FOR SHARE permet plusieurs lecteurs
    // -----------------------------------------------------------------------
    await test('FOR SHARE autorise les lectures partagees', async () => {
      const client2 = await createClient();
      try {
        // TODO:
        // 1. Client 1 : BEGIN + SELECT ... FOR SHARE sur id=1
        // 2. Client 2 : BEGIN + SELECT ... FOR SHARE sur id=1 (ne doit PAS bloquer)
        // 3. Verifier que les deux clients ont obtenu la meme place
        // 4. ROLLBACK les deux transactions
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 7 : Advisory locks pour verrou au niveau evenement
    // -----------------------------------------------------------------------
    await test('Advisory lock pour mutex au niveau evenement', async () => {
      const client2 = await createClient();
      try {
        // TODO:
        // 1. Client 1 : SELECT pg_advisory_lock(1) (verrouille event_id=1)
        // 2. Client 2 : SELECT pg_try_advisory_lock(1) → doit retourner false
        // 3. Client 1 : SELECT pg_advisory_unlock(1) (libere le verrou)
        // 4. Client 2 : SELECT pg_try_advisory_lock(1) → doit retourner true maintenant
        // 5. Client 2 : SELECT pg_advisory_unlock(1) (nettoyage)
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 8 : Fonction de reservation avec FOR UPDATE
    // -----------------------------------------------------------------------
    await test('Reservation avec FOR UPDATE + mise a jour du statut', async () => {
      // TODO:
      // 1. BEGIN
      // 2. SELECT * FROM seats WHERE event_id = 1 AND status = 'available'
      //    ORDER BY id LIMIT 1 FOR UPDATE
      // 3. UPDATE seats SET status = 'reserved', reserved_by = 'Jean' WHERE id = <place_trouvee>
      // 4. COMMIT
      // 5. Verifier que la place est bien reservee (status='reserved', reserved_by='Jean')
    });

    summary();
  } finally {
    await teardownDatabase(client, 'DROP TABLE IF EXISTS seats CASCADE;');
    await client.end();
  }
}

run().catch(console.error);
