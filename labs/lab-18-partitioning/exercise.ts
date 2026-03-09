// =============================================================================
// Lab 18 — Partitioning et Scaling PostgreSQL (Exercice)
// =============================================================================

import pg from 'pg';
import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.ts';

const { test, assert, assertEqual, assertIncludes, assertGreaterThan, assertLessThan, summary } = createTestRunner('Lab 18 — Partitioning');

// ---------------------------------------------------------------------------
// Nettoyage initial
// ---------------------------------------------------------------------------
const CLEANUP_SQL = `
  DROP TABLE IF EXISTS part_logs CASCADE;
  DROP TABLE IF EXISTS part_logs_default CASCADE;
  DROP TABLE IF EXISTS part_tickets CASCADE;
  DROP TABLE IF EXISTS part_sessions CASCADE;
  DROP TABLE IF EXISTS npart_logs CASCADE;
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function run(): Promise<void> {
  const client = await createClient();

  try {
    await setupDatabase(client, CLEANUP_SQL);

    console.log('\n📦 Lab 18 — Partitioning et Scaling\n');

    // -----------------------------------------------------------------------
    // Test 1 : Creer une table RANGE partitionnee par mois
    // -----------------------------------------------------------------------
    await test('Creer une table RANGE partitionnee par mois', async () => {
      // TODO:
      // 1. Creer une table part_logs partitionnee par RANGE sur created_at :
      //    CREATE TABLE part_logs (
      //      id BIGSERIAL,
      //      created_at DATE NOT NULL,
      //      level TEXT NOT NULL DEFAULT 'info',
      //      message TEXT NOT NULL,
      //      source TEXT
      //    ) PARTITION BY RANGE (created_at)
      // 2. Verifier que la table existe dans pg_class avec relkind = 'p' (partitioned)
    });

    // -----------------------------------------------------------------------
    // Test 2 : Creer les 12 partitions mensuelles de 2024
    // -----------------------------------------------------------------------
    await test('Creer les 12 partitions mensuelles (Jan-Dec 2024)', async () => {
      // TODO:
      // 1. Pour chaque mois de 2024, creer une partition :
      //    CREATE TABLE part_logs_2024_01 PARTITION OF part_logs
      //      FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
      //    ... (repeter pour les 12 mois)
      // 2. Verifier qu'il y a 12 partitions dans pg_inherits
      //    SELECT count(*) FROM pg_inherits
      //    WHERE inhparent = 'part_logs'::regclass
    });

    // -----------------------------------------------------------------------
    // Test 3 : Inserer des donnees dans les partitions
    // -----------------------------------------------------------------------
    await test('Inserer des donnees reparties sur les partitions', async () => {
      // TODO:
      // 1. Inserer des lignes avec des dates reparties sur 2024 :
      //    INSERT INTO part_logs (created_at, level, message, source)
      //    SELECT
      //      '2024-01-01'::date + (random() * 365)::int,
      //      (ARRAY['info','warn','error'])[1 + (random()*2)::int],
      //      'Log message ' || i,
      //      'source-' || (i % 10)
      //    FROM generate_series(1, 5000) AS i
      // 2. Verifier que les donnees sont reparties :
      //    SELECT tableoid::regclass AS partition, count(*)
      //    FROM part_logs GROUP BY tableoid
    });

    // -----------------------------------------------------------------------
    // Test 4 : EXPLAIN — verifier le partition pruning
    // -----------------------------------------------------------------------
    await test('EXPLAIN — verifier le partition pruning', async () => {
      // TODO:
      // 1. Executer EXPLAIN sur une requete filtree par date :
      //    EXPLAIN (FORMAT TEXT)
      //    SELECT * FROM part_logs WHERE created_at = '2024-06-15'
      // 2. Verifier que le plan ne scanne PAS toutes les partitions
      // 3. Il doit mentionner uniquement part_logs_2024_06
    });

    // -----------------------------------------------------------------------
    // Test 5 : Creer une table LIST partitionnee par statut
    // -----------------------------------------------------------------------
    await test('Creer une table LIST partitionnee par statut', async () => {
      // TODO:
      // 1. Creer une table part_tickets partitionnee par LIST sur status :
      //    CREATE TABLE part_tickets (
      //      id BIGSERIAL,
      //      title TEXT NOT NULL,
      //      status TEXT NOT NULL,
      //      created_at TIMESTAMPTZ DEFAULT now()
      //    ) PARTITION BY LIST (status)
      // 2. Creer 3 partitions :
      //    - part_tickets_active FOR VALUES IN ('active')
      //    - part_tickets_archived FOR VALUES IN ('archived')
      //    - part_tickets_deleted FOR VALUES IN ('deleted')
      // 3. Inserer des tickets dans chaque partition
      // 4. Verifier la repartition avec tableoid::regclass
    });

    // -----------------------------------------------------------------------
    // Test 6 : Creer une table HASH partitionnee
    // -----------------------------------------------------------------------
    await test('Creer une table HASH partitionnee (distribution uniforme)', async () => {
      // TODO:
      // 1. Creer une table part_sessions partitionnee par HASH sur user_id :
      //    CREATE TABLE part_sessions (
      //      id BIGSERIAL,
      //      user_id INT NOT NULL,
      //      session_data JSONB DEFAULT '{}',
      //      created_at TIMESTAMPTZ DEFAULT now()
      //    ) PARTITION BY HASH (user_id)
      // 2. Creer 4 partitions :
      //    CREATE TABLE part_sessions_0 PARTITION OF part_sessions
      //      FOR VALUES WITH (MODULUS 4, REMAINDER 0);
      //    ... (repeter pour 1, 2, 3)
      // 3. Inserer 1000 sessions
      // 4. Verifier que la distribution est relativement uniforme
      //    (chaque partition ~25% +/- 10%)
    });

    // -----------------------------------------------------------------------
    // Test 7 : Verifier "Subplans Removed" dans EXPLAIN
    // -----------------------------------------------------------------------
    await test('Verifier l\'exclusion de partitions dans EXPLAIN', async () => {
      // TODO:
      // 1. Executer EXPLAIN (VERBOSE) sur part_logs avec WHERE date precise :
      //    EXPLAIN (VERBOSE, FORMAT TEXT)
      //    SELECT * FROM part_logs
      //    WHERE created_at BETWEEN '2024-03-01' AND '2024-03-31'
      // 2. Le plan devrait mentionner uniquement part_logs_2024_03
      // 3. Les autres partitions ne doivent PAS apparaitre
      // 4. Compter combien de partitions sont dans le plan
    });

    // -----------------------------------------------------------------------
    // Test 8 : DETACH partition pour archivage
    // -----------------------------------------------------------------------
    await test('DETACH partition pour archivage', async () => {
      // TODO:
      // 1. Compter les lignes dans part_logs_2024_01
      // 2. Detacher la partition :
      //    ALTER TABLE part_logs DETACH PARTITION part_logs_2024_01
      // 3. Verifier que part_logs_2024_01 existe encore comme table independante
      //    (SELECT count(*) FROM part_logs_2024_01 doit fonctionner)
      // 4. Verifier que les lignes de janvier ne sont plus dans part_logs
      // 5. Re-attacher pour la suite :
      //    ALTER TABLE part_logs ATTACH PARTITION part_logs_2024_01
      //    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')
    });

    // -----------------------------------------------------------------------
    // Test 9 : Partition par defaut
    // -----------------------------------------------------------------------
    await test('Partition par defaut pour les donnees hors range', async () => {
      // TODO:
      // 1. Creer une partition par defaut :
      //    CREATE TABLE part_logs_default PARTITION OF part_logs DEFAULT
      // 2. Inserer des donnees hors 2024 :
      //    INSERT INTO part_logs (created_at, level, message)
      //    VALUES ('2025-06-15', 'info', 'Donnee hors range 2024')
      // 3. Verifier que ces donnees atterrissent dans part_logs_default
      // 4. Verifier que les donnees 2024 ne sont PAS dans default
    });

    // -----------------------------------------------------------------------
    // Test 10 : Performance — partitionnee vs non-partitionnee
    // -----------------------------------------------------------------------
    await test('Performance — partitionnee vs non-partitionnee sur 500K rows', async () => {
      // TODO:
      // 1. Creer une table non-partitionnee npart_logs avec le meme schema
      // 2. Inserer 500K lignes dans part_logs et npart_logs (memes donnees)
      //    INSERT INTO ... SELECT ... FROM generate_series(1, 500000)
      // 3. Creer un index sur created_at pour npart_logs
      // 4. ANALYZE les deux tables
      // 5. Mesurer une requete date range sur part_logs :
      //    SELECT count(*) FROM part_logs
      //    WHERE created_at BETWEEN '2024-06-01' AND '2024-06-30'
      // 6. Mesurer la meme requete sur npart_logs
      // 7. Comparer les temps d'execution
      // 8. Le partitionnement devrait etre au moins aussi rapide
    });

    summary();
  } finally {
    try {
      await teardownDatabase(client, `
        DROP TABLE IF EXISTS part_logs CASCADE;
        DROP TABLE IF EXISTS part_logs_default CASCADE;
        DROP TABLE IF EXISTS part_tickets CASCADE;
        DROP TABLE IF EXISTS part_sessions CASCADE;
        DROP TABLE IF EXISTS npart_logs CASCADE;
      `);
    } catch (_e) { /* ignore */ }
    await client.end();
  }
}

run().catch(console.error);
