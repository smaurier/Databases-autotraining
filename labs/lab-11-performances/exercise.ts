// =============================================================================
// Lab 11 — Performances (Exercice)
// =============================================================================

import pg from 'pg';
import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.ts';

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
async function run(): Promise<void> {
  const client = await createClient();

  try {
    console.log('\n⚡ Lab 11 — Performances\n');
    console.log('  Preparation du schema et des donnees (500k lignes)...');
    await setupDatabase(client, SCHEMA_SQL);
    await setupDatabase(client, SEED_SQL);
    console.log('  Donnees prates !\n');

    // -----------------------------------------------------------------------
    // Test 1 : SELECT sans index
    // -----------------------------------------------------------------------
    await test('SELECT sans index — mesure du temps', async () => {
      // TODO:
      // 1. Supprimer l'index s'il existe : DROP INDEX IF EXISTS idx_big_table_category
      // 2. Utiliser measure() pour mesurer le temps de :
      //    SELECT * FROM big_table WHERE category = 'cat_42'
      // 3. Stocker la duree (on la comparera au test suivant)
      // 4. Afficher le temps avec console.log
    });

    // -----------------------------------------------------------------------
    // Test 2 : Ajout d'index → acceleration significative
    // -----------------------------------------------------------------------
    await test('Ajout d\'index → acceleration significative', async () => {
      // TODO:
      // 1. Creer un index : CREATE INDEX idx_big_table_category ON big_table(category)
      // 2. Executer ANALYZE big_table pour mettre a jour les stats
      // 3. Mesurer la meme requete : SELECT * FROM big_table WHERE category = 'cat_42'
      // 4. Verifier que le temps avec index est significativement plus rapide
      // 5. Afficher les deux temps pour comparaison
    });

    // -----------------------------------------------------------------------
    // Test 3 : INSERT individuel vs batch
    // -----------------------------------------------------------------------
    await test('INSERT individuel vs batch — comparaison', async () => {
      // TODO:
      // 1. Creer une table temporaire : CREATE TABLE perf_test (id SERIAL, val TEXT)
      // 2. Mesurer 1000 INSERTs individuels dans une boucle
      // 3. Vider la table : TRUNCATE perf_test
      // 4. Mesurer 1 INSERT avec 1000 valeurs (multi-value INSERT)
      //    INSERT INTO perf_test (val) VALUES ('v1'), ('v2'), ...
      // 5. Verifier que le batch est plus rapide
    });

    // -----------------------------------------------------------------------
    // Test 4 : COPY pour le chargement en masse
    // -----------------------------------------------------------------------
    await test('COPY pour le chargement en masse', async () => {
      // TODO:
      // 1. Vider la table perf_test
      // 2. Generer une chaine CSV en memoire (1000 lignes)
      // 3. Utiliser COPY ... FROM STDIN (via le protocole du client pg)
      //    const stream = client.query(copyFrom('COPY perf_test(val) FROM STDIN'))
      //    Note : on peut aussi utiliser un INSERT genere avec generate_series comme proxy
      // 4. Alternative : mesurer INSERT INTO perf_test (val)
      //    SELECT 'val_' || g FROM generate_series(1, 1000) g
      // 5. Comparer avec les temps precedents
    });

    // -----------------------------------------------------------------------
    // Test 5 : Prepared statements
    // -----------------------------------------------------------------------
    await test('Prepared statements accelerent les requetes repetees', async () => {
      // TODO:
      // 1. Mesurer 100 executions de :
      //    SELECT * FROM big_table WHERE category = $1 LIMIT 10
      //    avec des valeurs differentes, SANS prepare (query a chaque fois)
      // 2. Preparer la requete : PREPARE cat_query(text) AS
      //    SELECT * FROM big_table WHERE category = $1 LIMIT 10
      // 3. Mesurer 100 executions de : EXECUTE cat_query($1)
      // 4. Comparer les temps (le prepare devrait etre plus rapide ou equivalent)
      // 5. DEALLOCATE cat_query
    });

    // -----------------------------------------------------------------------
    // Test 6 : Table bloat — observer n_dead_tup
    // -----------------------------------------------------------------------
    await test('Observer le bloat avec n_dead_tup', async () => {
      // TODO:
      // 1. Lire n_dead_tup avant :
      //    SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 'big_table'
      // 2. Faire un UPDATE massif :
      //    UPDATE big_table SET value = value + 1 WHERE id <= 10000
      // 3. Relire n_dead_tup apres
      // 4. Verifier que n_dead_tup a augmente (les anciennes versions existent encore)
    });

    // -----------------------------------------------------------------------
    // Test 7 : VACUUM nettoie les tuples morts
    // -----------------------------------------------------------------------
    await test('VACUUM nettoie les tuples morts', async () => {
      // TODO:
      // 1. Lire n_dead_tup avant VACUUM
      // 2. Executer VACUUM big_table
      // 3. Relire n_dead_tup apres VACUUM
      // 4. Verifier que n_dead_tup a diminue
    });

    // -----------------------------------------------------------------------
    // Test 8 : VACUUM FULL vs VACUUM regulier
    // -----------------------------------------------------------------------
    await test('VACUUM FULL vs VACUUM regulier', async () => {
      // TODO:
      // 1. Lire la taille de la table : pg_total_relation_size('big_table')
      // 2. Faire un UPDATE sur 50000 lignes pour creer du bloat
      // 3. Executer VACUUM big_table (regulier)
      // 4. Lire la taille apres VACUUM regulier
      // 5. Executer VACUUM FULL big_table
      // 6. Lire la taille apres VACUUM FULL
      // 7. Verifier que VACUUM FULL a reduit la taille (il reorganise physiquement)
    });

    // -----------------------------------------------------------------------
    // Test 9 : ANALYZE met a jour les statistiques
    // -----------------------------------------------------------------------
    await test('ANALYZE met a jour les statistiques du planificateur', async () => {
      // TODO:
      // 1. Lire last_analyze dans pg_stat_user_tables pour big_table
      // 2. Executer ANALYZE big_table
      // 3. Relire last_analyze
      // 4. Verifier que la date a ete mise a jour
      // 5. Verifier avec EXPLAIN que le planificateur utilise les stats
    });

    // -----------------------------------------------------------------------
    // Test 10 : Partitionnement par date
    // -----------------------------------------------------------------------
    await test('Partitionnement par date avec partition pruning', async () => {
      // TODO:
      // 1. Creer une table partitionnee :
      //    CREATE TABLE logs_partitioned (
      //      id SERIAL, message TEXT, created_at DATE NOT NULL
      //    ) PARTITION BY RANGE (created_at)
      // 2. Creer 3 partitions : 2024, 2025, 2026
      // 3. Inserer des donnees dans chaque annee
      // 4. Executer EXPLAIN sur une requete filtrant sur 2025
      // 5. Verifier que seule la partition 2025 est scannee (partition pruning)
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
