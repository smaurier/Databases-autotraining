// =============================================================================
// Lab 16 — Replication PostgreSQL (Solution)
// =============================================================================

import pg from 'pg';
import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.ts';

const { test, assert, assertEqual, assertIncludes, assertGreaterThan, assertLessThan, summary } = createTestRunner('Lab 16 — Replication');

// ---------------------------------------------------------------------------
// Nettoyage initial
// ---------------------------------------------------------------------------
const CLEANUP_SQL = `
  DROP TABLE IF EXISTS repl_demo CASCADE;
  DROP TABLE IF EXISTS repl_orders CASCADE;
  DROP TABLE IF EXISTS repl_products CASCADE;
  SELECT pg_drop_replication_slot(slot_name)
    FROM pg_replication_slots
    WHERE slot_name = 'test_slot_lab16'
      AND active = false;
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function run(): Promise<void> {
  const client = await createClient();

  try {
    // Nettoyage securise (ignorer les erreurs si le slot n'existe pas)
    try { await setupDatabase(client, CLEANUP_SQL); } catch (_e) { /* ignore */ }

    console.log('\n📡 Lab 16 — Replication PostgreSQL\n');

    // -----------------------------------------------------------------------
    // Test 1 : Verifier le parametre wal_level
    // -----------------------------------------------------------------------
    await test('Verifier le parametre wal_level', async () => {
      const res = await query(client, 'SHOW wal_level');
      const walLevel = res.rows[0].wal_level;

      console.log(`     → wal_level = ${walLevel}`);

      // wal_level doit etre 'replica' ou 'logical'
      assert(
        walLevel === 'replica' || walLevel === 'logical',
        `wal_level doit etre 'replica' ou 'logical', obtenu : '${walLevel}'`
      );

      // Ne doit pas etre 'minimal' (pas de replication possible)
      assert(
        walLevel !== 'minimal',
        'wal_level ne doit pas etre minimal pour la replication'
      );
    });

    // -----------------------------------------------------------------------
    // Test 2 : Creer une publication (replication logique)
    // -----------------------------------------------------------------------
    await test('Creer une publication pour replication logique', async () => {
      // Creer la table de demo
      await query(client, `
        CREATE TABLE IF NOT EXISTS repl_demo (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          value INT DEFAULT 0
        )
      `);

      // Verifier le wal_level avant de creer la publication
      const walRes = await query(client, 'SHOW wal_level');
      const walLevel = walRes.rows[0].wal_level;

      if (walLevel !== 'logical') {
        console.log(`     → wal_level = '${walLevel}', publication necessite 'logical'`);
        console.log(`     → Test adapte : verification de la structure uniquement`);
        // On verifie que la vue pg_publication existe
        const pgPubRes = await query(client, `
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'pg_publication'
          ORDER BY ordinal_position
        `);
        assertGreaterThan(pgPubRes.rows.length, 0, 'pg_publication doit exister');
        return;
      }

      // Creer la publication
      await query(client, 'DROP PUBLICATION IF EXISTS lab16_pub');
      await query(client, 'CREATE PUBLICATION lab16_pub FOR TABLE repl_demo');

      // Verifier que la publication existe
      const pubRes = await query(client, `
        SELECT pubname, puballtables, pubinsert, pubupdate, pubdelete
        FROM pg_publication
        WHERE pubname = 'lab16_pub'
      `);
      assertEqual(pubRes.rows.length, 1, 'La publication doit exister');
      assertEqual(pubRes.rows[0].pubname, 'lab16_pub', 'Nom de publication correct');

      // Verifier que la table est dans la publication
      const tabRes = await query(client, `
        SELECT schemaname, tablename
        FROM pg_publication_tables
        WHERE pubname = 'lab16_pub'
      `);
      assertEqual(tabRes.rows.length, 1, 'La table doit etre dans la publication');
      assertEqual(tabRes.rows[0].tablename, 'repl_demo', 'Table repl_demo publiee');

      console.log(`     → Publication lab16_pub creee avec la table repl_demo`);

      // Nettoyage
      await query(client, 'DROP PUBLICATION lab16_pub');
    });

    // -----------------------------------------------------------------------
    // Test 3 : Verifier la structure de pg_stat_replication
    // -----------------------------------------------------------------------
    await test('Verifier la structure de pg_stat_replication', async () => {
      // Interroger les colonnes de pg_stat_replication
      const res = await query(client, `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'pg_catalog'
          AND table_name = 'pg_stat_replication'
        ORDER BY ordinal_position
      `);

      const columns = res.rows.map(r => r.column_name);

      // Verifier les colonnes essentielles pour le monitoring
      const requiredColumns = [
        'pid', 'usename', 'application_name',
        'client_addr', 'state',
        'sent_lsn', 'write_lsn', 'flush_lsn', 'replay_lsn'
      ];

      for (const col of requiredColumns) {
        assertIncludes(columns, col,
          `pg_stat_replication doit contenir la colonne '${col}'`);
      }

      console.log(`     → pg_stat_replication contient ${columns.length} colonnes`);
      console.log(`     → Colonnes cles : ${requiredColumns.join(', ')}`);

      // Verifier combien de standbys sont connectes (probablement 0)
      const statRes = await query(client, 'SELECT count(*) FROM pg_stat_replication');
      console.log(`     → Standbys connectes : ${statRes.rows[0].count}`);
    });

    // -----------------------------------------------------------------------
    // Test 4 : Decodage logique — slot de replication
    // -----------------------------------------------------------------------
    await test('Decodage logique — slot et lecture des changements', async () => {
      // Verifier que wal_level est 'logical'
      const walRes = await query(client, 'SHOW wal_level');
      const walLevel = walRes.rows[0].wal_level;

      if (walLevel !== 'logical') {
        console.log(`     → wal_level = '${walLevel}', decodage logique necessite 'logical'`);
        console.log(`     → Pour activer : modifier wal_level = 'logical' dans postgresql.conf et redemarrer`);
        // Test de structure alternative
        const slotCols = await query(client, `
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'pg_replication_slots'
          ORDER BY ordinal_position
        `);
        assertGreaterThan(slotCols.rows.length, 0, 'pg_replication_slots doit exister');
        console.log(`     → pg_replication_slots disponible (${slotCols.rows.length} colonnes)`);
        return;
      }

      // S'assurer que la table existe
      await query(client, `
        CREATE TABLE IF NOT EXISTS repl_demo (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          value INT DEFAULT 0
        )
      `);

      // Creer un slot de replication logique
      await query(client, `
        SELECT pg_create_logical_replication_slot('test_slot_lab16', 'test_decoding')
      `);

      // Inserer des donnees
      await query(client, `
        INSERT INTO repl_demo (name, value) VALUES
          ('alpha', 100),
          ('beta', 200),
          ('gamma', 300)
      `);

      // Lire les changements decodés
      const changes = await query(client, `
        SELECT lsn, xid, data
        FROM pg_logical_slot_get_changes('test_slot_lab16', NULL, NULL)
      `);

      assertGreaterThan(changes.rows.length, 0,
        'Des changements doivent etre captures');

      // Verifier que les INSERT sont presents
      const inserts = changes.rows.filter(r => r.data.includes('INSERT'));
      assertGreaterThan(inserts.length, 0,
        'Les INSERT doivent apparaitre dans les changements');

      console.log(`     → ${changes.rows.length} changements decodes`);
      console.log(`     → ${inserts.length} INSERT captures`);
      changes.rows.slice(0, 3).forEach(r =>
        console.log(`       • ${r.data.substring(0, 80)}...`)
      );

      // Nettoyage du slot
      await query(client, `SELECT pg_drop_replication_slot('test_slot_lab16')`);
    });

    // -----------------------------------------------------------------------
    // Test 5 : Requete de monitoring du replication lag
    // -----------------------------------------------------------------------
    await test('Requete de monitoring du replication lag', async () => {
      // Requete de monitoring du lag — s'execute meme sans standby
      const lagRes = await query(client, `
        SELECT
          pid,
          client_addr,
          application_name,
          state,
          sent_lsn,
          write_lsn,
          flush_lsn,
          replay_lsn,
          write_lag,
          flush_lag,
          replay_lag
        FROM pg_stat_replication
      `);

      // La requete doit s'executer sans erreur
      assert(lagRes.rows !== undefined, 'La requete de lag doit s\'executer');
      console.log(`     → Standbys avec lag : ${lagRes.rows.length}`);

      // Verifier aussi pg_stat_replication_slots
      const slotsRes = await query(client, `
        SELECT
          slot_name,
          slot_type,
          active
        FROM pg_replication_slots
      `);

      console.log(`     → Slots de replication actifs : ${slotsRes.rows.length}`);

      // Verifier les colonnes de pg_stat_wal_receiver (vue cote standby)
      const receiverCols = await query(client, `
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'pg_stat_wal_receiver'
        ORDER BY ordinal_position
      `);
      assertGreaterThan(receiverCols.rows.length, 0,
        'pg_stat_wal_receiver doit exister');
      console.log(`     → pg_stat_wal_receiver : ${receiverCols.rows.length} colonnes disponibles`);
    });

    // -----------------------------------------------------------------------
    // Test 6 : Statistiques WAL depuis pg_stat_wal
    // -----------------------------------------------------------------------
    await test('Statistiques WAL depuis pg_stat_wal', async () => {
      const res = await query(client, `
        SELECT
          wal_records,
          wal_fpi,
          wal_bytes,
          wal_write,
          wal_sync,
          stats_reset
        FROM pg_stat_wal
      `);

      assertEqual(res.rows.length, 1, 'pg_stat_wal doit retourner une ligne');

      const stats = res.rows[0];
      const walRecords = parseInt(stats.wal_records);
      const walBytes = parseInt(stats.wal_bytes);

      assertGreaterThan(walRecords, 0,
        'wal_records doit etre > 0 (il y a eu de l\'activite)');
      assertGreaterThan(walBytes, 0,
        'wal_bytes doit etre > 0');

      console.log(`     → WAL records : ${walRecords.toLocaleString()}`);
      console.log(`     → WAL bytes : ${(walBytes / 1024 / 1024).toFixed(2)} MB`);
      console.log(`     → WAL full-page images : ${stats.wal_fpi}`);
      console.log(`     → WAL writes : ${stats.wal_write}`);
      console.log(`     → WAL syncs : ${stats.wal_sync}`);
    });

    // -----------------------------------------------------------------------
    // Test 7 : Simuler le routage lecture/ecriture
    // -----------------------------------------------------------------------
    await test('Simuler le routage lecture/ecriture avec 2 clients', async () => {
      const readClient = await createClient();
      try {
        // Client principal = client lecture-ecriture
        await query(client, `
          CREATE TABLE IF NOT EXISTS repl_orders (
            id SERIAL PRIMARY KEY,
            product TEXT NOT NULL,
            amount NUMERIC(10,2) NOT NULL,
            created_at TIMESTAMPTZ DEFAULT now()
          )
        `);

        await query(client, `
          INSERT INTO repl_orders (product, amount) VALUES
            ('Widget A', 29.99),
            ('Widget B', 49.99),
            ('Widget C', 99.99)
        `);

        // readClient = client lecture seule (simule un replica)
        await query(readClient, 'SET default_transaction_read_only = ON');

        // Les SELECT doivent fonctionner
        const readRes = await query(readClient,
          'SELECT * FROM repl_orders ORDER BY id'
        );
        assertEqual(readRes.rows.length, 3,
          'Le client read-only doit pouvoir lire les 3 lignes');

        // Les INSERT doivent echouer
        let readOnlyError = false;
        try {
          await query(readClient, `
            INSERT INTO repl_orders (product, amount) VALUES ('Interdit', 0)
          `);
        } catch (err: unknown) {
          readOnlyError = true;
          const errMsg = err instanceof Error ? err.message : String(err);
          assertIncludes(errMsg, 'read-only',
            'L\'erreur doit mentionner read-only');
        }
        assert(readOnlyError,
          'INSERT doit echouer sur le client read-only');

        console.log(`     → Client read-write : INSERT OK`);
        console.log(`     → Client read-only : SELECT OK, INSERT bloque`);
        console.log(`     → Routage lecture/ecriture simule avec succes`);
      } finally {
        await readClient.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 8 : Verification pg_basebackup (dry-run)
    // -----------------------------------------------------------------------
    await test('Verification pg_basebackup — pre-requis', async () => {
      // Verifier max_wal_senders
      const walSendersRes = await query(client, 'SHOW max_wal_senders');
      const maxWalSenders = parseInt(walSendersRes.rows[0].max_wal_senders);
      assertGreaterThan(maxWalSenders, 0,
        'max_wal_senders doit etre > 0 pour pg_basebackup');

      // Verifier max_replication_slots
      const replSlotsRes = await query(client, 'SHOW max_replication_slots');
      const maxReplSlots = parseInt(replSlotsRes.rows[0].max_replication_slots);
      assertGreaterThan(maxReplSlots, 0,
        'max_replication_slots doit etre > 0');

      // Verifier les permissions du role courant
      const roleRes = await query(client, `
        SELECT rolreplication, rolsuper
        FROM pg_roles
        WHERE rolname = current_user
      `);
      const role = roleRes.rows[0];
      const canReplicate = role.rolreplication || role.rolsuper;
      assert(canReplicate,
        'Le role doit avoir REPLICATION ou etre superuser pour pg_basebackup');

      // Verifier wal_level
      const walLevelRes = await query(client, 'SHOW wal_level');
      const walLevel = walLevelRes.rows[0].wal_level;

      console.log(`     → Pre-requis pg_basebackup :`);
      console.log(`       • max_wal_senders = ${maxWalSenders} (OK)`);
      console.log(`       • max_replication_slots = ${maxReplSlots} (OK)`);
      console.log(`       • wal_level = ${walLevel}`);
      console.log(`       • REPLICATION = ${role.rolreplication}, SUPERUSER = ${role.rolsuper}`);
      console.log(`     → pg_basebackup est utilisable depuis ce serveur`);
    });

    summary();
  } finally {
    try {
      await teardownDatabase(client, `
        DROP TABLE IF EXISTS repl_demo CASCADE;
        DROP TABLE IF EXISTS repl_orders CASCADE;
        DROP TABLE IF EXISTS repl_products CASCADE;
        SELECT pg_drop_replication_slot(slot_name)
          FROM pg_replication_slots
          WHERE slot_name = 'test_slot_lab16'
            AND active = false;
      `);
    } catch (e) { /* ignore cleanup errors */ }
    await client.end();
  }
}

run().catch(console.error);
