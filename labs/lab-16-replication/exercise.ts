// =============================================================================
// Lab 16 — Replication PostgreSQL (Exercice)
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
      // TODO:
      // 1. Executer SHOW wal_level
      // 2. Le resultat doit etre 'replica' ou 'logical'
      //    - 'replica' permet la replication physique (streaming)
      //    - 'logical' permet en plus la replication logique
      // 3. Verifier que wal_level n'est PAS 'minimal'
    });

    // -----------------------------------------------------------------------
    // Test 2 : Creer une publication (replication logique)
    // -----------------------------------------------------------------------
    await test('Creer une publication pour replication logique', async () => {
      // TODO:
      // 1. Creer une table repl_demo (id SERIAL PK, name TEXT, value INT)
      // 2. CREATE PUBLICATION lab16_pub FOR TABLE repl_demo
      // 3. Verifier que la publication existe dans pg_publication
      // 4. Verifier que la table est dans pg_publication_tables
      // 5. DROP PUBLICATION lab16_pub a la fin
    });

    // -----------------------------------------------------------------------
    // Test 3 : Verifier la structure de pg_stat_replication
    // -----------------------------------------------------------------------
    await test('Verifier la structure de pg_stat_replication', async () => {
      // TODO:
      // 1. Interroger pg_stat_replication (SELECT * ... LIMIT 0 suffit)
      // 2. Verifier que les colonnes suivantes existent :
      //    - pid, usename, application_name
      //    - client_addr, state
      //    - sent_lsn, write_lsn, flush_lsn, replay_lsn
      // 3. Ces colonnes sont essentielles pour le monitoring de replication
      // Note : la vue sera probablement vide (pas de standby connecte)
    });

    // -----------------------------------------------------------------------
    // Test 4 : Decodage logique — slot de replication
    // -----------------------------------------------------------------------
    await test('Decodage logique — slot et lecture des changements', async () => {
      // TODO:
      // 1. Verifier que wal_level = 'logical' (sinon skip le test)
      // 2. Creer un slot de replication logique :
      //    SELECT pg_create_logical_replication_slot('test_slot_lab16', 'test_decoding')
      // 3. Inserer des donnees dans repl_demo
      // 4. Lire les changements :
      //    SELECT * FROM pg_logical_slot_get_changes('test_slot_lab16', NULL, NULL)
      // 5. Verifier que les changements contiennent les INSERT
      // 6. Supprimer le slot : SELECT pg_drop_replication_slot('test_slot_lab16')
    });

    // -----------------------------------------------------------------------
    // Test 5 : Requete de monitoring du replication lag
    // -----------------------------------------------------------------------
    await test('Requete de monitoring du replication lag', async () => {
      // TODO:
      // 1. Construire une requete qui calculerait le lag de replication :
      //    SELECT
      //      pid,
      //      client_addr,
      //      state,
      //      sent_lsn,
      //      write_lsn,
      //      flush_lsn,
      //      replay_lsn,
      //      (sent_lsn - replay_lsn) AS replay_lag_bytes
      //    FROM pg_stat_replication
      // 2. Verifier que la requete s'execute sans erreur
      // 3. Verifier aussi pg_stat_replication_slots pour les stats des slots
    });

    // -----------------------------------------------------------------------
    // Test 6 : Statistiques WAL depuis pg_stat_wal
    // -----------------------------------------------------------------------
    await test('Statistiques WAL depuis pg_stat_wal', async () => {
      // TODO:
      // 1. Interroger pg_stat_wal :
      //    SELECT wal_records, wal_fpi, wal_bytes, wal_write, wal_sync
      //    FROM pg_stat_wal
      // 2. Verifier que wal_records > 0 (il y a eu de l'activite)
      // 3. Verifier que wal_bytes > 0
      // 4. Afficher les statistiques pour information
    });

    // -----------------------------------------------------------------------
    // Test 7 : Simuler le routage lecture/ecriture
    // -----------------------------------------------------------------------
    await test('Simuler le routage lecture/ecriture avec 2 clients', async () => {
      const readClient = await createClient();
      try {
        // TODO:
        // 1. Client principal (client) = client lecture-ecriture
        //    - Creer une table repl_orders si elle n'existe pas
        //    - Inserer des donnees
        // 2. readClient = client lecture seule
        //    - Mettre en mode read-only :
        //      SET default_transaction_read_only = ON
        //    - Verifier que les SELECT fonctionnent
        //    - Verifier qu'un INSERT echoue (ERROR: cannot execute INSERT in a read-only transaction)
        // 3. Ce pattern simule le routage lecture/ecriture avec replicas
      } finally {
        await readClient.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 8 : Verification pg_basebackup (dry-run)
    // -----------------------------------------------------------------------
    await test('Verification pg_basebackup — pre-requis', async () => {
      // TODO:
      // 1. Verifier max_wal_senders > 0 (SHOW max_wal_senders)
      //    C'est un pre-requis pour pg_basebackup
      // 2. Verifier max_replication_slots > 0 (SHOW max_replication_slots)
      // 3. Verifier que le role courant a REPLICATION ou est superuser :
      //    SELECT rolreplication, rolsuper FROM pg_roles WHERE rolname = current_user
      // 4. Afficher un resume des pre-requis pour pg_basebackup
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
