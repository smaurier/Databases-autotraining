// =============================================================================
// Lab 18 — Partitioning et Scaling PostgreSQL (Solution)
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
      await query(client, `
        CREATE TABLE part_logs (
          id BIGSERIAL,
          created_at DATE NOT NULL,
          level TEXT NOT NULL DEFAULT 'info',
          message TEXT NOT NULL,
          source TEXT
        ) PARTITION BY RANGE (created_at)
      `);

      // Verifier que la table est partitionnee (relkind = 'p')
      const res = await query(client, `
        SELECT relname, relkind
        FROM pg_class
        WHERE relname = 'part_logs'
      `);

      assertEqual(res.rows.length, 1, 'La table part_logs doit exister');
      assertEqual(res.rows[0].relkind, 'p',
        'relkind doit etre "p" (partitioned table)');

      console.log(`     → Table part_logs creee avec partitionnement RANGE`);
    });

    // -----------------------------------------------------------------------
    // Test 2 : Creer les 12 partitions mensuelles de 2024
    // -----------------------------------------------------------------------
    await test('Creer les 12 partitions mensuelles (Jan-Dec 2024)', async () => {
      const months = [
        { name: '01', from: '2024-01-01', to: '2024-02-01' },
        { name: '02', from: '2024-02-01', to: '2024-03-01' },
        { name: '03', from: '2024-03-01', to: '2024-04-01' },
        { name: '04', from: '2024-04-01', to: '2024-05-01' },
        { name: '05', from: '2024-05-01', to: '2024-06-01' },
        { name: '06', from: '2024-06-01', to: '2024-07-01' },
        { name: '07', from: '2024-07-01', to: '2024-08-01' },
        { name: '08', from: '2024-08-01', to: '2024-09-01' },
        { name: '09', from: '2024-09-01', to: '2024-10-01' },
        { name: '10', from: '2024-10-01', to: '2024-11-01' },
        { name: '11', from: '2024-11-01', to: '2024-12-01' },
        { name: '12', from: '2024-12-01', to: '2025-01-01' },
      ];

      for (const m of months) {
        await query(client, `
          CREATE TABLE part_logs_2024_${m.name}
          PARTITION OF part_logs
          FOR VALUES FROM ('${m.from}') TO ('${m.to}')
        `);
      }

      // Verifier le nombre de partitions
      const res = await query(client, `
        SELECT count(*) AS cnt
        FROM pg_inherits
        WHERE inhparent = 'part_logs'::regclass
      `);

      assertEqual(parseInt(res.rows[0].cnt), 12,
        'Doit y avoir 12 partitions mensuelles');

      console.log(`     → 12 partitions creees (Jan-Dec 2024)`);
    });

    // -----------------------------------------------------------------------
    // Test 3 : Inserer des donnees dans les partitions
    // -----------------------------------------------------------------------
    await test('Inserer des donnees reparties sur les partitions', async () => {
      await query(client, `
        INSERT INTO part_logs (created_at, level, message, source)
        SELECT
          '2024-01-01'::date + (random() * 365)::int,
          (ARRAY['info','warn','error'])[1 + (random()*2)::int],
          'Log message ' || i,
          'source-' || (i % 10)
        FROM generate_series(1, 5000) AS i
      `);

      // Verifier la repartition
      const res = await query(client, `
        SELECT tableoid::regclass AS partition, count(*) AS cnt
        FROM part_logs
        GROUP BY tableoid
        ORDER BY partition
      `);

      assertGreaterThan(res.rows.length, 6,
        'Les donnees doivent etre reparties sur plusieurs partitions');

      const totalRows = res.rows.reduce((sum, r) => sum + parseInt(r.cnt), 0);
      assertEqual(totalRows, 5000, 'Total doit etre 5000 lignes');

      console.log(`     → 5000 lignes reparties sur ${res.rows.length} partitions :`);
      res.rows.forEach(r =>
        console.log(`       • ${r.partition} : ${r.cnt} lignes`)
      );
    });

    // -----------------------------------------------------------------------
    // Test 4 : EXPLAIN — verifier le partition pruning
    // -----------------------------------------------------------------------
    await test('EXPLAIN — verifier le partition pruning', async () => {
      await query(client, 'ANALYZE part_logs');

      const res = await query(client, `
        EXPLAIN (FORMAT TEXT)
        SELECT * FROM part_logs WHERE created_at = '2024-06-15'
      `);

      const plan = res.rows.map(r => r['QUERY PLAN']).join('\n');

      // Le plan doit mentionner la partition de juin
      assertIncludes(plan, 'part_logs_2024_06',
        'Le plan doit mentionner uniquement part_logs_2024_06');

      // Compter combien de partitions sont dans le plan
      const partitionMentions = plan.match(/part_logs_2024_\d{2}/g) || [];
      const uniquePartitions = [...new Set(partitionMentions)];

      assertEqual(uniquePartitions.length, 1,
        'Une seule partition doit etre scannee');

      console.log(`     → Partition pruning actif : seule ${uniquePartitions[0]} est scannee`);
      console.log(`     → Plan : ${res.rows[0]['QUERY PLAN']}`);
    });

    // -----------------------------------------------------------------------
    // Test 5 : Creer une table LIST partitionnee par statut
    // -----------------------------------------------------------------------
    await test('Creer une table LIST partitionnee par statut', async () => {
      await query(client, `
        CREATE TABLE part_tickets (
          id BIGSERIAL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now()
        ) PARTITION BY LIST (status)
      `);

      await query(client, `
        CREATE TABLE part_tickets_active
        PARTITION OF part_tickets FOR VALUES IN ('active')
      `);
      await query(client, `
        CREATE TABLE part_tickets_archived
        PARTITION OF part_tickets FOR VALUES IN ('archived')
      `);
      await query(client, `
        CREATE TABLE part_tickets_deleted
        PARTITION OF part_tickets FOR VALUES IN ('deleted')
      `);

      // Inserer des tickets
      await query(client, `
        INSERT INTO part_tickets (title, status) VALUES
          ('Bug critique', 'active'),
          ('Feature request', 'active'),
          ('Ancien rapport', 'archived'),
          ('Doublon supprime', 'deleted'),
          ('Mise a jour urgente', 'active'),
          ('Archives Q1', 'archived'),
          ('Spam', 'deleted'),
          ('Performance issue', 'active')
      `);

      // Verifier la repartition
      const res = await query(client, `
        SELECT tableoid::regclass AS partition, count(*) AS cnt
        FROM part_tickets
        GROUP BY tableoid
        ORDER BY partition
      `);

      assertEqual(res.rows.length, 3, 'Doit y avoir 3 partitions utilisees');

      console.log(`     → Repartition par statut :`);
      res.rows.forEach(r =>
        console.log(`       • ${r.partition} : ${r.cnt} tickets`)
      );
    });

    // -----------------------------------------------------------------------
    // Test 6 : Creer une table HASH partitionnee
    // -----------------------------------------------------------------------
    await test('Creer une table HASH partitionnee (distribution uniforme)', async () => {
      await query(client, `
        CREATE TABLE part_sessions (
          id BIGSERIAL,
          user_id INT NOT NULL,
          session_data JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT now()
        ) PARTITION BY HASH (user_id)
      `);

      // Creer 4 partitions HASH
      for (let i = 0; i < 4; i++) {
        await query(client, `
          CREATE TABLE part_sessions_${i}
          PARTITION OF part_sessions
          FOR VALUES WITH (MODULUS 4, REMAINDER ${i})
        `);
      }

      // Inserer 1000 sessions
      await query(client, `
        INSERT INTO part_sessions (user_id, session_data)
        SELECT
          (random() * 1000)::int,
          jsonb_build_object('action', 'login', 'seq', i)
        FROM generate_series(1, 1000) AS i
      `);

      // Verifier la distribution
      const res = await query(client, `
        SELECT tableoid::regclass AS partition, count(*) AS cnt
        FROM part_sessions
        GROUP BY tableoid
        ORDER BY partition
      `);

      assertEqual(res.rows.length, 4, 'Doit y avoir 4 partitions HASH');

      // Verifier que la distribution est relativement uniforme (~25% +/- 15%)
      for (const row of res.rows) {
        const pct = parseInt(row.cnt) / 10; // sur 1000 lignes
        assertGreaterThan(pct, 10,
          `${row.partition} doit avoir > 10% (a ${pct}%)`);
        assertLessThan(pct, 40,
          `${row.partition} doit avoir < 40% (a ${pct}%)`);
      }

      console.log(`     → Distribution HASH sur 4 partitions :`);
      res.rows.forEach(r =>
        console.log(`       • ${r.partition} : ${r.cnt} sessions (${(parseInt(r.cnt) / 10).toFixed(1)}%)`)
      );
    });

    // -----------------------------------------------------------------------
    // Test 7 : Verifier "Subplans Removed" dans EXPLAIN
    // -----------------------------------------------------------------------
    await test('Verifier l\'exclusion de partitions dans EXPLAIN', async () => {
      const res = await query(client, `
        EXPLAIN (VERBOSE, FORMAT TEXT)
        SELECT * FROM part_logs
        WHERE created_at BETWEEN '2024-03-01' AND '2024-03-31'
      `);

      const plan = res.rows.map(r => r['QUERY PLAN']).join('\n');

      // La partition de mars doit etre presente
      assertIncludes(plan, 'part_logs_2024_03',
        'Le plan doit inclure part_logs_2024_03');

      // Compter les partitions dans le plan
      const partitionMentions = plan.match(/part_logs_2024_\d{2}/g) || [];
      const uniquePartitions = [...new Set(partitionMentions)];

      // Doit etre 1 ou 2 max (mars, et potentiellement avril pour la borne)
      assertLessThan(uniquePartitions.length, 4,
        'Le pruning doit exclure la majorite des partitions');

      console.log(`     → Partitions scannees : ${uniquePartitions.join(', ')}`);
      console.log(`     → ${12 - uniquePartitions.length} partitions exclues par le pruning`);
    });

    // -----------------------------------------------------------------------
    // Test 8 : DETACH partition pour archivage
    // -----------------------------------------------------------------------
    await test('DETACH partition pour archivage', async () => {
      // Compter les lignes de janvier
      const beforeCount = await query(client,
        "SELECT count(*) FROM part_logs WHERE created_at >= '2024-01-01' AND created_at < '2024-02-01'"
      );
      const janCount = parseInt(beforeCount.rows[0].count);
      console.log(`     → Lignes en janvier avant DETACH : ${janCount}`);

      // Total avant detach
      const totalBefore = await query(client, 'SELECT count(*) FROM part_logs');

      // Detacher la partition
      await query(client, 'ALTER TABLE part_logs DETACH PARTITION part_logs_2024_01');

      // La table existe encore comme table independante
      const detachedRes = await query(client, 'SELECT count(*) FROM part_logs_2024_01');
      assertEqual(parseInt(detachedRes.rows[0].count), janCount,
        'La table detachee doit conserver ses lignes');

      // Les lignes de janvier ne sont plus dans part_logs
      const totalAfter = await query(client, 'SELECT count(*) FROM part_logs');
      assertEqual(
        parseInt(totalAfter.rows[0].count),
        parseInt(totalBefore.rows[0].count) - janCount,
        'part_logs doit avoir perdu les lignes de janvier'
      );

      console.log(`     → Partition detachee : part_logs_2024_01 (${janCount} lignes)`);
      console.log(`     → part_logs : ${totalBefore.rows[0].count} → ${totalAfter.rows[0].count} lignes`);

      // Re-attacher pour la suite des tests
      await query(client, `
        ALTER TABLE part_logs ATTACH PARTITION part_logs_2024_01
        FOR VALUES FROM ('2024-01-01') TO ('2024-02-01')
      `);

      // Verifier que les lignes sont de retour
      const totalReattach = await query(client, 'SELECT count(*) FROM part_logs');
      assertEqual(
        parseInt(totalReattach.rows[0].count),
        parseInt(totalBefore.rows[0].count),
        'Apres re-attach, le total doit etre restaure'
      );

      console.log(`     → Partition re-attachee avec succes`);
    });

    // -----------------------------------------------------------------------
    // Test 9 : Partition par defaut
    // -----------------------------------------------------------------------
    await test('Partition par defaut pour les donnees hors range', async () => {
      // Creer une partition par defaut
      await query(client, 'CREATE TABLE part_logs_default PARTITION OF part_logs DEFAULT');

      // Inserer des donnees hors 2024
      await query(client, `
        INSERT INTO part_logs (created_at, level, message) VALUES
          ('2025-06-15', 'info', 'Donnee 2025 hors range'),
          ('2023-12-01', 'warn', 'Donnee 2023 hors range'),
          ('2025-12-31', 'error', 'Fin 2025 hors range')
      `);

      // Verifier que ces donnees sont dans la partition par defaut
      const defaultRes = await query(client, 'SELECT count(*) FROM part_logs_default');
      assertEqual(parseInt(defaultRes.rows[0].count), 3,
        'Les 3 lignes hors range doivent etre dans la partition default');

      // Verifier que les donnees 2024 ne sont PAS dans default
      const check2024 = await query(client, `
        SELECT count(*) FROM part_logs_default
        WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01'
      `);
      assertEqual(parseInt(check2024.rows[0].count), 0,
        'Les donnees 2024 ne doivent pas etre dans la partition default');

      console.log(`     → Partition default recoit les donnees hors range`);
      console.log(`     → 3 lignes (2023/2025) dans part_logs_default`);
    });

    // -----------------------------------------------------------------------
    // Test 10 : Performance — partitionnee vs non-partitionnee
    // -----------------------------------------------------------------------
    await test('Performance — partitionnee vs non-partitionnee sur 500K rows', async () => {
      // Creer une table non-partitionnee
      await query(client, `
        CREATE TABLE npart_logs (
          id BIGSERIAL PRIMARY KEY,
          created_at DATE NOT NULL,
          level TEXT NOT NULL DEFAULT 'info',
          message TEXT NOT NULL,
          source TEXT
        )
      `);

      // Inserer 500K lignes dans la table non-partitionnee
      console.log(`     → Insertion de 500K lignes (non-partitionnee)...`);
      await query(client, `
        INSERT INTO npart_logs (created_at, level, message, source)
        SELECT
          '2024-01-01'::date + (random() * 365)::int,
          (ARRAY['info','warn','error'])[1 + (random()*2)::int],
          'Log message ' || i,
          'source-' || (i % 100)
        FROM generate_series(1, 500000) AS i
      `);

      // Vider et re-remplir part_logs pour avoir 500K lignes aussi
      // (on ajoute aux ~5000 existantes)
      console.log(`     → Insertion de ~495K lignes supplementaires (partitionnee)...`);
      await query(client, `
        INSERT INTO part_logs (created_at, level, message, source)
        SELECT
          '2024-01-01'::date + (random() * 365)::int,
          (ARRAY['info','warn','error'])[1 + (random()*2)::int],
          'Log message ' || i,
          'source-' || (i % 100)
        FROM generate_series(1, 495000) AS i
      `);

      // Index sur la table non-partitionnee
      await query(client, 'CREATE INDEX idx_npart_logs_date ON npart_logs (created_at)');

      // ANALYZE
      await query(client, 'ANALYZE npart_logs');
      await query(client, 'ANALYZE part_logs');

      // Mesurer la requete sur la table partitionnee
      const { duration: partDuration } = await measure(async () => {
        return await query(client, `
          SELECT count(*) FROM part_logs
          WHERE created_at BETWEEN '2024-06-01' AND '2024-06-30'
        `);
      });

      // Mesurer la requete sur la table non-partitionnee
      const { duration: npartDuration } = await measure(async () => {
        return await query(client, `
          SELECT count(*) FROM npart_logs
          WHERE created_at BETWEEN '2024-06-01' AND '2024-06-30'
        `);
      });

      console.log(`     → Requete date range (juin 2024) :`);
      console.log(`       • Partitionnee : ${partDuration.toFixed(2)} ms`);
      console.log(`       • Non-partitionnee : ${npartDuration.toFixed(2)} ms`);

      if (partDuration < npartDuration) {
        console.log(`       → Partitionnement plus rapide de ${((1 - partDuration / npartDuration) * 100).toFixed(1)}%`);
      } else {
        console.log(`       → Performances similaires (l'index B-tree est aussi efficace ici)`);
      }

      // Verifier les plans d'execution
      const partPlan = await query(client, `
        EXPLAIN (FORMAT TEXT)
        SELECT count(*) FROM part_logs
        WHERE created_at BETWEEN '2024-06-01' AND '2024-06-30'
      `);
      const partPlanText = partPlan.rows.map(r => r['QUERY PLAN']).join('\n');

      const npartPlan = await query(client, `
        EXPLAIN (FORMAT TEXT)
        SELECT count(*) FROM npart_logs
        WHERE created_at BETWEEN '2024-06-01' AND '2024-06-30'
      `);
      const npartPlanText = npartPlan.rows.map(r => r['QUERY PLAN']).join('\n');

      console.log(`     → Plan partitionnee : ${partPlanText.split('\n')[0]}`);
      console.log(`     → Plan non-partitionnee : ${npartPlanText.split('\n')[0]}`);

      // Les deux doivent retourner des resultats
      assert(partDuration >= 0 && npartDuration >= 0,
        'Les deux requetes doivent s\'executer');
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
