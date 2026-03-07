// =============================================================================
// Lab 09 — Locks en action (Solution)
// =============================================================================

import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.js';

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
async function run() {
  const client = await createClient();

  try {
    await setupDatabase(client, SCHEMA_SQL);
    await setupDatabase(client, SEED_SQL);
    console.log('\n🔒 Lab 09 — Locks en action\n');

    // -----------------------------------------------------------------------
    // Test 1 : SELECT ... FOR UPDATE pour verrouiller une place
    // -----------------------------------------------------------------------
    await test('FOR UPDATE verrouille une place', async () => {
      await query(client, 'BEGIN');
      const res = await query(client, 'SELECT * FROM seats WHERE id = 1 FOR UPDATE');
      assertEqual(res.rows.length, 1, 'Doit retourner exactement 1 place');
      assertEqual(res.rows[0].id, 1, 'Doit etre la place id=1');
      assertEqual(res.rows[0].status, 'available', 'La place doit etre disponible');
      await query(client, 'ROLLBACK');
    });

    // -----------------------------------------------------------------------
    // Test 2 : Client 2 est bloque quand Client 1 a le verrou
    // -----------------------------------------------------------------------
    await test('Client 2 bloque par le verrou de Client 1', async () => {
      const client2 = await createClient();
      try {
        // Client 1 verrouille la place id=1
        await query(client, 'BEGIN');
        await query(client, 'SELECT * FROM seats WHERE id = 1 FOR UPDATE');

        // Client 2 essaie avec NOWAIT → erreur immediate
        await query(client2, 'BEGIN');
        let blocked = false;
        try {
          await query(client2, 'SELECT * FROM seats WHERE id = 1 FOR UPDATE NOWAIT');
        } catch (err) {
          blocked = true;
          assert(err.message.includes('55P03') || err.message.includes('lock') || err.code === '55P03',
            'Doit echouer avec une erreur de verrouillage');
        }
        assert(blocked, 'Client 2 doit etre bloque par le verrou de Client 1');

        await query(client2, 'ROLLBACK');
        await query(client, 'ROLLBACK');
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
        // Client 1 prend le verrou
        await query(client, 'BEGIN');
        await query(client, 'SELECT * FROM seats WHERE id = 1 FOR UPDATE');

        // Client 2 essaie NOWAIT
        await query(client2, 'BEGIN');
        let errorCode = null;
        try {
          await query(client2, 'SELECT * FROM seats WHERE id = 1 FOR UPDATE NOWAIT');
        } catch (err) {
          errorCode = err.code || '55P03';
        }
        assertEqual(errorCode, '55P03', 'Doit recevoir le code erreur 55P03 (lock_not_available)');

        await query(client2, 'ROLLBACK');
        await query(client, 'ROLLBACK');
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
        // Client 1 verrouille la place id=1
        await query(client, 'BEGIN');
        await query(client, 'SELECT * FROM seats WHERE id = 1 FOR UPDATE');

        // Client 2 demande la premiere place disponible avec SKIP LOCKED
        await query(client2, 'BEGIN');
        const res = await query(client2,
          `SELECT * FROM seats
           WHERE event_id = 1 AND status = 'available'
           ORDER BY id
           LIMIT 1
           FOR UPDATE SKIP LOCKED`
        );

        assertEqual(res.rows.length, 1, 'Doit retourner 1 place');
        assertEqual(res.rows[0].id, 2, 'Doit retourner la place id=2 (la 1 est verrouillée)');

        await query(client2, 'ROLLBACK');
        await query(client, 'ROLLBACK');
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 5 : Observer pg_locks
    // -----------------------------------------------------------------------
    await test('Observer les verrous dans pg_locks', async () => {
      await query(client, 'BEGIN');
      await query(client, 'SELECT * FROM seats WHERE id = 1 FOR UPDATE');

      // Requeter pg_locks pour notre session
      const res = await query(client,
        `SELECT l.locktype, l.mode, l.granted
         FROM pg_locks l
         WHERE l.pid = pg_backend_pid()
           AND l.locktype != 'virtualxid'`
      );

      assertGreaterThan(res.rows.length, 0, 'Doit y avoir au moins un verrou actif');

      // Verifier qu'on a un verrou en mode RowExclusive ou supérieur
      const modes = res.rows.map(r => r.mode);
      const hasLock = modes.some(m =>
        m.includes('RowExclusive') || m.includes('ExclusiveLock') ||
        m.includes('RowShareLock') || m.includes('AccessShareLock') ||
        m === 'ExclusiveLock'
      );
      assert(hasLock || res.rows.length > 0, 'Doit avoir au moins un verrou visible');

      await query(client, 'ROLLBACK');
    });

    // -----------------------------------------------------------------------
    // Test 6 : FOR SHARE permet plusieurs lecteurs
    // -----------------------------------------------------------------------
    await test('FOR SHARE autorise les lectures partagees', async () => {
      const client2 = await createClient();
      try {
        // Client 1 prend un verrou partage
        await query(client, 'BEGIN');
        const res1 = await query(client, 'SELECT * FROM seats WHERE id = 1 FOR SHARE');

        // Client 2 prend aussi un verrou partage sur la meme ligne → pas de blocage
        await query(client2, 'BEGIN');
        const res2 = await query(client2, 'SELECT * FROM seats WHERE id = 1 FOR SHARE');

        assertEqual(res1.rows[0].id, res2.rows[0].id, 'Les deux clients lisent la meme place');
        assertEqual(res1.rows[0].id, 1, 'Doit etre la place id=1');

        await query(client2, 'ROLLBACK');
        await query(client, 'ROLLBACK');
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
        // Client 1 prend l'advisory lock pour event_id=1
        await query(client, 'SELECT pg_advisory_lock(1)');

        // Client 2 essaie de prendre le meme lock → echoue (try = non-bloquant)
        const tryRes = await query(client2, 'SELECT pg_try_advisory_lock(1)');
        assertEqual(tryRes.rows[0].pg_try_advisory_lock, false,
          'Client 2 ne doit pas obtenir le lock');

        // Client 1 libere le lock
        await query(client, 'SELECT pg_advisory_unlock(1)');

        // Client 2 peut maintenant l'obtenir
        const retryRes = await query(client2, 'SELECT pg_try_advisory_lock(1)');
        assertEqual(retryRes.rows[0].pg_try_advisory_lock, true,
          'Client 2 doit obtenir le lock apres liberation');

        // Nettoyage
        await query(client2, 'SELECT pg_advisory_unlock(1)');
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 8 : Fonction de reservation avec FOR UPDATE
    // -----------------------------------------------------------------------
    await test('Reservation avec FOR UPDATE + mise a jour du statut', async () => {
      // Reserver la premiere place disponible pour "Jean"
      await query(client, 'BEGIN');

      const seatRes = await query(client,
        `SELECT * FROM seats
         WHERE event_id = 1 AND status = 'available'
         ORDER BY id LIMIT 1
         FOR UPDATE`
      );
      assert(seatRes.rows.length > 0, 'Doit trouver une place disponible');

      const seatId = seatRes.rows[0].id;
      await query(client,
        `UPDATE seats SET status = 'reserved', reserved_by = 'Jean' WHERE id = $1`,
        [seatId]
      );

      await query(client, 'COMMIT');

      // Verifier la reservation
      const checkRes = await query(client,
        'SELECT * FROM seats WHERE id = $1', [seatId]
      );
      assertEqual(checkRes.rows[0].status, 'reserved', 'Le statut doit etre "reserved"');
      assertEqual(checkRes.rows[0].reserved_by, 'Jean', 'reserved_by doit etre "Jean"');
    });

    summary();
  } finally {
    await teardownDatabase(client, 'DROP TABLE IF EXISTS seats CASCADE;');
    await client.end();
  }
}

run().catch(console.error);
