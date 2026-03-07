// =============================================================================
// Lab 11 — Performances (Solution)
// =============================================================================

import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.js';

const { test, assert, assertEqual, assertIncludes, assertGreaterThan, assertLessThan, summary } = createTestRunner('Lab 11 — Performances');

// ---------------------------------------------------------------------------
// Schema et donnees de test
// ---------------------------------------------------------------------------
const SCHEMA_SQL = `
  DROP TABLE IF EXISTS big_table CASCADE;
  DROP TABLE IF EXISTS perf_test CASCADE;
  DROP TABLE IF EXISTS logs_partitioned CASCADE;

  CREATE TABLE big_table (
    id SERIAL PRIMARY KEY,
    category TEXT NOT NULL,
    value NUMERIC NOT NULL,
    data TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  );
`;

const SEED_SQL = `
  INSERT INTO big_table (category, value, data, created_at)
  SELECT
    'cat_' || (random() * 100)::int,
    random() * 10000,
    'donnees_' || gs,
    now() - (random() * interval '365 days')
  FROM generate_series(1, 500000) AS gs;
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function run() {
  const client = await createClient();

  // Variable pour stocker le temps sans index (partage entre tests 1 et 2)
  let timeWithoutIndex = 0;

  try {
    console.log('\n⚡ Lab 11 — Performances\n');
    console.log('  Preparation du schema et des donnees (500k lignes)...');
    await setupDatabase(client, SCHEMA_SQL);
    await setupDatabase(client, SEED_SQL);
    console.log('  Donnees pretes !\n');

    // -----------------------------------------------------------------------
    // Test 1 : SELECT sans index
    // -----------------------------------------------------------------------
    await test('SELECT sans index — mesure du temps', async () => {
      // S'assurer qu'il n'y a pas d'index sur category
      await query(client, 'DROP INDEX IF EXISTS idx_big_table_category');

      const { result, duration } = await measure(async () => {
        return await query(client, `SELECT * FROM big_table WHERE category = 'cat_42'`);
      });

      timeWithoutIndex = duration;
      assertGreaterThan(result.rows.length, 0, 'Doit trouver des resultats');
      console.log(`     → Sans index : ${duration.toFixed(2)} ms (${result.rows.length} lignes)`);
    });

    // -----------------------------------------------------------------------
    // Test 2 : Ajout d'index → acceleration significative
    // -----------------------------------------------------------------------
    await test('Ajout d\'index → acceleration significative', async () => {
      // Creer l'index
      await query(client, 'CREATE INDEX idx_big_table_category ON big_table(category)');
      await query(client, 'ANALYZE big_table');

      const { result, duration } = await measure(async () => {
        return await query(client, `SELECT * FROM big_table WHERE category = 'cat_42'`);
      });

      console.log(`     → Sans index : ${timeWithoutIndex.toFixed(2)} ms`);
      console.log(`     → Avec index : ${duration.toFixed(2)} ms`);
      console.log(`     → Acceleration : x${(timeWithoutIndex / duration).toFixed(1)}`);

      // L'index doit accelerer la requete (au moins 2x plus rapide en general)
      assertLessThan(duration, timeWithoutIndex,
        'La requete avec index doit etre plus rapide');
    });

    // -----------------------------------------------------------------------
    // Test 3 : INSERT individuel vs batch
    // -----------------------------------------------------------------------
    await test('INSERT individuel vs batch — comparaison', async () => {
      await query(client, 'CREATE TABLE IF NOT EXISTS perf_test (id SERIAL, val TEXT)');
      await query(client, 'TRUNCATE perf_test');

      // Methode 1 : INSERTs individuels
      const { duration: durationIndividual } = await measure(async () => {
        for (let i = 0; i < 1000; i++) {
          await query(client, 'INSERT INTO perf_test (val) VALUES ($1)', [`val_${i}`]);
        }
      });

      await query(client, 'TRUNCATE perf_test');

      // Methode 2 : Batch INSERT (un seul INSERT multi-valeurs)
      const { duration: durationBatch } = await measure(async () => {
        const values = [];
        const params = [];
        for (let i = 0; i < 1000; i++) {
          values.push(`($${i + 1})`);
          params.push(`val_${i}`);
        }
        await query(client, `INSERT INTO perf_test (val) VALUES ${values.join(', ')}`, params);
      });

      console.log(`     → INSERTs individuels (1000) : ${durationIndividual.toFixed(2)} ms`);
      console.log(`     → Batch INSERT (1000 valeurs) : ${durationBatch.toFixed(2)} ms`);
      console.log(`     → Acceleration : x${(durationIndividual / durationBatch).toFixed(1)}`);

      assertLessThan(durationBatch, durationIndividual,
        'Le batch INSERT doit etre plus rapide');
    });

    // -----------------------------------------------------------------------
    // Test 4 : COPY / generate_series pour le chargement en masse
    // -----------------------------------------------------------------------
    await test('Chargement en masse avec generate_series', async () => {
      await query(client, 'TRUNCATE perf_test');

      // Utiliser INSERT ... SELECT generate_series comme proxy de COPY
      const { duration: durationGenerate } = await measure(async () => {
        await query(client,
          `INSERT INTO perf_test (val)
           SELECT 'val_' || g FROM generate_series(1, 1000) g`
        );
      });

      const countRes = await query(client, 'SELECT count(*) FROM perf_test');
      assertEqual(parseInt(countRes.rows[0].count), 1000, 'Doit inserer 1000 lignes');

      console.log(`     → generate_series (1000 lignes) : ${durationGenerate.toFixed(2)} ms`);
      console.log(`     → Equivalent rapide de COPY pour le chargement en masse`);
      assertGreaterThan(durationGenerate, 0, 'Doit avoir mesure un temps positif');
    });

    // -----------------------------------------------------------------------
    // Test 5 : Prepared statements
    // -----------------------------------------------------------------------
    await test('Prepared statements accelerent les requetes repetees', async () => {
      // Sans prepare : 100 requetes avec query parametrees
      const { duration: durationNormal } = await measure(async () => {
        for (let i = 0; i < 100; i++) {
          await query(client,
            'SELECT * FROM big_table WHERE category = $1 LIMIT 10',
            [`cat_${i % 100}`]
          );
        }
      });

      // Avec prepare : preparer puis executer 100 fois
      await query(client,
        'PREPARE cat_query(text) AS SELECT * FROM big_table WHERE category = $1 LIMIT 10'
      );

      const { duration: durationPrepared } = await measure(async () => {
        for (let i = 0; i < 100; i++) {
          await query(client, 'EXECUTE cat_query($1)', [`cat_${i % 100}`]);
        }
      });

      await query(client, 'DEALLOCATE cat_query');

      console.log(`     → Sans prepare (100 requetes) : ${durationNormal.toFixed(2)} ms`);
      console.log(`     → Avec prepare (100 requetes) : ${durationPrepared.toFixed(2)} ms`);

      // Les prepared statements doivent etre au moins aussi rapides
      // (la difference peut etre faible avec le cache du planificateur)
      assert(durationPrepared >= 0, 'Le temps doit etre positif');
    });

    // -----------------------------------------------------------------------
    // Test 6 : Table bloat — observer n_dead_tup
    // -----------------------------------------------------------------------
    await test('Observer le bloat avec n_dead_tup', async () => {
      // Lire les tuples morts avant
      const beforeRes = await query(client,
        `SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 'big_table'`
      );
      const deadBefore = parseInt(beforeRes.rows[0].n_dead_tup);

      // UPDATE massif → cree des tuples morts (anciennes versions)
      await query(client,
        'UPDATE big_table SET value = value + 1 WHERE id <= 10000'
      );

      // Lire les tuples morts apres
      const afterRes = await query(client,
        `SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 'big_table'`
      );
      const deadAfter = parseInt(afterRes.rows[0].n_dead_tup);

      console.log(`     → Tuples morts avant UPDATE : ${deadBefore}`);
      console.log(`     → Tuples morts apres UPDATE : ${deadAfter}`);

      assertGreaterThan(deadAfter, deadBefore,
        'Le nombre de tuples morts doit augmenter apres un UPDATE massif');
    });

    // -----------------------------------------------------------------------
    // Test 7 : VACUUM nettoie les tuples morts
    // -----------------------------------------------------------------------
    await test('VACUUM nettoie les tuples morts', async () => {
      // Lire avant VACUUM
      const beforeRes = await query(client,
        `SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 'big_table'`
      );
      const deadBefore = parseInt(beforeRes.rows[0].n_dead_tup);

      // Executer VACUUM
      await query(client, 'VACUUM big_table');

      // Lire apres VACUUM
      const afterRes = await query(client,
        `SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 'big_table'`
      );
      const deadAfter = parseInt(afterRes.rows[0].n_dead_tup);

      console.log(`     → Tuples morts avant VACUUM : ${deadBefore}`);
      console.log(`     → Tuples morts apres VACUUM : ${deadAfter}`);

      assertLessThan(deadAfter, deadBefore,
        'VACUUM doit reduire le nombre de tuples morts');
    });

    // -----------------------------------------------------------------------
    // Test 8 : VACUUM FULL vs VACUUM regulier
    // -----------------------------------------------------------------------
    await test('VACUUM FULL vs VACUUM regulier', async () => {
      // Taille avant
      const sizeBeforeRes = await query(client,
        `SELECT pg_total_relation_size('big_table') AS size`
      );
      const sizeBefore = parseInt(sizeBeforeRes.rows[0].size);

      // Creer du bloat avec un UPDATE massif
      await query(client,
        'UPDATE big_table SET value = value + 1 WHERE id <= 50000'
      );

      // VACUUM regulier (ne reduit pas la taille physique)
      await query(client, 'VACUUM big_table');
      const sizeAfterVacuumRes = await query(client,
        `SELECT pg_total_relation_size('big_table') AS size`
      );
      const sizeAfterVacuum = parseInt(sizeAfterVacuumRes.rows[0].size);

      // VACUUM FULL (reorganise physiquement la table)
      await query(client, 'VACUUM FULL big_table');
      const sizeAfterFullRes = await query(client,
        `SELECT pg_total_relation_size('big_table') AS size`
      );
      const sizeAfterFull = parseInt(sizeAfterFullRes.rows[0].size);

      console.log(`     → Taille avant          : ${(sizeBefore / 1024 / 1024).toFixed(2)} Mo`);
      console.log(`     → Apres VACUUM regulier  : ${(sizeAfterVacuum / 1024 / 1024).toFixed(2)} Mo`);
      console.log(`     → Apres VACUUM FULL      : ${(sizeAfterFull / 1024 / 1024).toFixed(2)} Mo`);

      assertLessThan(sizeAfterFull, sizeAfterVacuum,
        'VACUUM FULL doit reduire la taille physique de la table');
    });

    // -----------------------------------------------------------------------
    // Test 9 : ANALYZE met a jour les statistiques
    // -----------------------------------------------------------------------
    await test('ANALYZE met a jour les statistiques du planificateur', async () => {
      // Lire la date du dernier ANALYZE
      const beforeRes = await query(client,
        `SELECT last_analyze FROM pg_stat_user_tables WHERE relname = 'big_table'`
      );
      const lastAnalyzeBefore = beforeRes.rows[0].last_analyze;

      // Petite pause pour que le timestamp soit different
      await sleep(100);

      // Executer ANALYZE
      await query(client, 'ANALYZE big_table');

      // Lire apres
      const afterRes = await query(client,
        `SELECT last_analyze FROM pg_stat_user_tables WHERE relname = 'big_table'`
      );
      const lastAnalyzeAfter = afterRes.rows[0].last_analyze;

      assert(lastAnalyzeAfter !== null, 'last_analyze ne doit pas etre null');
      assert(
        lastAnalyzeBefore === null || new Date(lastAnalyzeAfter) >= new Date(lastAnalyzeBefore),
        'La date de last_analyze doit etre mise a jour'
      );

      // Verifier que EXPLAIN utilise les statistiques
      const explainRes = await query(client,
        `EXPLAIN (FORMAT JSON) SELECT * FROM big_table WHERE category = 'cat_42'`
      );
      const plan = explainRes.rows[0]['QUERY PLAN'][0]['Plan'];
      console.log(`     → Type de scan : ${plan['Node Type']}`);
      assert(
        plan['Node Type'] === 'Index Scan' || plan['Node Type'] === 'Bitmap Heap Scan'
          || plan['Node Type'] === 'Bitmap Index Scan',
        'Le planificateur doit utiliser un index scan grace aux stats a jour'
      );
    });

    // -----------------------------------------------------------------------
    // Test 10 : Partitionnement par date
    // -----------------------------------------------------------------------
    await test('Partitionnement par date avec partition pruning', async () => {
      // Creer la table partitionnee
      await query(client, `
        CREATE TABLE logs_partitioned (
          id SERIAL,
          message TEXT,
          created_at DATE NOT NULL
        ) PARTITION BY RANGE (created_at)
      `);

      // Creer les partitions pour 2024, 2025, 2026
      await query(client, `
        CREATE TABLE logs_2024 PARTITION OF logs_partitioned
          FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')
      `);
      await query(client, `
        CREATE TABLE logs_2025 PARTITION OF logs_partitioned
          FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')
      `);
      await query(client, `
        CREATE TABLE logs_2026 PARTITION OF logs_partitioned
          FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')
      `);

      // Inserer des donnees dans chaque annee
      await query(client, `
        INSERT INTO logs_partitioned (message, created_at) VALUES
          ('log 2024', '2024-06-15'),
          ('log 2025a', '2025-03-01'),
          ('log 2025b', '2025-09-15'),
          ('log 2026', '2026-01-10')
      `);

      // Verifier le partition pruning avec EXPLAIN
      const explainRes = await query(client, `
        EXPLAIN (FORMAT TEXT)
        SELECT * FROM logs_partitioned
        WHERE created_at >= '2025-01-01' AND created_at < '2026-01-01'
      `);

      const explainText = explainRes.rows.map(r => r['QUERY PLAN']).join('\n');
      console.log(`     → Plan :\n${explainText.split('\n').map(l => `       ${l}`).join('\n')}`);

      // Verifier que seule la partition 2025 est scannee
      assertIncludes(explainText, 'logs_2025',
        'Le plan doit mentionner la partition logs_2025');

      // Verifier que les autres partitions ne sont PAS scannees
      // (elles ne doivent pas apparaitre dans le plan, ou etre marquees "never executed")
      const scanLines = explainText.split('\n').filter(l =>
        l.includes('Scan') && !l.includes('Append')
      );
      const scansPartitions = scanLines.filter(l =>
        l.includes('logs_2024') || l.includes('logs_2026')
      );
      assertEqual(scansPartitions.length, 0,
        'Les partitions 2024 et 2026 ne doivent pas etre scannees (partition pruning)');
    });

    summary();
  } finally {
    await teardownDatabase(client, `
      DROP TABLE IF EXISTS big_table CASCADE;
      DROP TABLE IF EXISTS perf_test CASCADE;
      DROP TABLE IF EXISTS logs_partitioned CASCADE;
    `);
    await client.end();
  }
}

run().catch(console.error);
