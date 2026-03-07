// =============================================================================
// Lab 17 — Monitoring et Observabilite PostgreSQL (Exercice)
// =============================================================================

import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.js';

const { test, assert, assertEqual, assertIncludes, assertGreaterThan, assertLessThan, summary } = createTestRunner('Lab 17 — Monitoring');

// ---------------------------------------------------------------------------
// Nettoyage initial
// ---------------------------------------------------------------------------
const CLEANUP_SQL = `
  DROP TABLE IF EXISTS mon_orders CASCADE;
  DROP TABLE IF EXISTS mon_products CASCADE;
  DROP TABLE IF EXISTS mon_deadtuple_demo CASCADE;
  DROP FUNCTION IF EXISTS health_check() CASCADE;
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function run() {
  const client = await createClient();

  try {
    await setupDatabase(client, CLEANUP_SQL);

    console.log('\n📊 Lab 17 — Monitoring et Observabilite\n');

    // -----------------------------------------------------------------------
    // Test 1 : pg_stat_activity — sessions actives
    // -----------------------------------------------------------------------
    await test('pg_stat_activity — trouver les sessions actives', async () => {
      // TODO:
      // 1. Interroger pg_stat_activity pour la base courante :
      //    SELECT pid, usename, state, query, query_start, backend_type
      //    FROM pg_stat_activity
      //    WHERE datname = current_database()
      // 2. Verifier qu'on trouve au moins 1 session (la notre)
      // 3. Verifier que notre session est 'active'
      // 4. Compter les sessions par etat (GROUP BY state)
    });

    // -----------------------------------------------------------------------
    // Test 2 : pg_stat_statements — top SQL
    // -----------------------------------------------------------------------
    await test('pg_stat_statements — activer et interroger les top SQL', async () => {
      // TODO:
      // 1. Tenter de creer l'extension :
      //    CREATE EXTENSION IF NOT EXISTS pg_stat_statements
      // 2. Si ca echoue (extension non disponible), tester en mode degrade
      // 3. Si l'extension est disponible, interroger :
      //    SELECT query, calls, total_exec_time, mean_exec_time, rows
      //    FROM pg_stat_statements
      //    ORDER BY total_exec_time DESC
      //    LIMIT 5
      // 4. Verifier que la vue retourne des resultats
    });

    // -----------------------------------------------------------------------
    // Test 3 : pg_stat_user_tables — seq_scan vs idx_scan
    // -----------------------------------------------------------------------
    await test('pg_stat_user_tables — ratio seq_scan vs idx_scan', async () => {
      // TODO:
      // 1. Creer une table mon_products (id, name, category, price) avec 1000 lignes
      // 2. Creer un index sur category
      // 3. Faire des requetes : SELECT avec WHERE category = ... (idx_scan)
      //    et SELECT sans WHERE (seq_scan)
      // 4. ANALYZE la table
      // 5. Interroger pg_stat_user_tables :
      //    SELECT relname, seq_scan, idx_scan,
      //      CASE WHEN (seq_scan + idx_scan) > 0
      //        THEN round(100.0 * idx_scan / (seq_scan + idx_scan), 1)
      //        ELSE 0 END AS idx_scan_pct
      //    FROM pg_stat_user_tables
      //    WHERE relname = 'mon_products'
      // 6. Afficher le ratio
    });

    // -----------------------------------------------------------------------
    // Test 4 : pg_stat_user_indexes — index inutilises
    // -----------------------------------------------------------------------
    await test('pg_stat_user_indexes — trouver les index inutilises', async () => {
      // TODO:
      // 1. Creer un index supplementaire peu utile sur mon_products
      //    (ex: CREATE INDEX idx_mon_unused ON mon_products (price))
      // 2. Ne PAS utiliser cet index (pas de requete WHERE price = ...)
      // 3. Interroger pg_stat_user_indexes :
      //    SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
      //    FROM pg_stat_user_indexes
      //    WHERE schemaname = 'public'
      //      AND idx_scan = 0
      //      AND indexrelname NOT LIKE '%_pkey'
      // 4. Verifier que notre index inutilise apparait
    });

    // -----------------------------------------------------------------------
    // Test 5 : pg_stat_database — cache hit ratio
    // -----------------------------------------------------------------------
    await test('pg_stat_database — calculer le cache hit ratio', async () => {
      // TODO:
      // 1. Interroger pg_stat_database pour la base courante :
      //    SELECT
      //      datname,
      //      blks_hit,
      //      blks_read,
      //      CASE WHEN (blks_hit + blks_read) > 0
      //        THEN round(100.0 * blks_hit / (blks_hit + blks_read), 2)
      //        ELSE 0 END AS cache_hit_ratio
      //    FROM pg_stat_database
      //    WHERE datname = current_database()
      // 2. Le cache hit ratio devrait etre > 90% en general
      // 3. Afficher le resultat
    });

    // -----------------------------------------------------------------------
    // Test 6 : pg_stat_bgwriter — checkpoints
    // -----------------------------------------------------------------------
    await test('pg_stat_bgwriter — statistiques de checkpoints', async () => {
      // TODO:
      // 1. Interroger pg_stat_bgwriter :
      //    SELECT
      //      checkpoints_timed,
      //      checkpoints_req,
      //      buffers_checkpoint,
      //      buffers_backend,
      //      buffers_alloc
      //    FROM pg_stat_bgwriter
      // 2. Verifier que la requete retourne des resultats
      // 3. checkpoints_timed = checkpoints planifies (normaux)
      //    checkpoints_req = checkpoints forces (signe de charge)
      // 4. Afficher les stats
    });

    // -----------------------------------------------------------------------
    // Test 7 : Requetes longues (> 1 seconde)
    // -----------------------------------------------------------------------
    await test('Identifier les requetes longues (> 1 seconde)', async () => {
      const slowClient = await createClient();
      try {
        // TODO:
        // 1. Lancer une requete longue sur slowClient (pg_sleep(2)) en arriere-plan
        //    Utiliser : slowClient.query('SELECT pg_sleep(2)') sans await
        // 2. Attendre un peu (sleep(200))
        // 3. Depuis client, chercher les requetes > 1 seconde :
        //    SELECT pid, now() - query_start AS duration, query, state
        //    FROM pg_stat_activity
        //    WHERE state = 'active'
        //      AND query NOT LIKE '%pg_stat_activity%'
        //      AND now() - query_start > INTERVAL '0.1 seconds'
        // 4. On devrait trouver notre pg_sleep
        // 5. Attendre que slowClient termine
      } finally {
        await slowClient.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 8 : Sessions bloquantes avec pg_blocking_pids()
    // -----------------------------------------------------------------------
    await test('Identifier les sessions bloquantes avec pg_blocking_pids()', async () => {
      const blocker = await createClient();
      const blocked = await createClient();
      try {
        // TODO:
        // 1. Creer une table simple si elle n'existe pas
        //    CREATE TABLE IF NOT EXISTS mon_orders (id SERIAL PK, status TEXT)
        //    INSERT une ligne
        // 2. blocker : BEGIN + SELECT ... FOR UPDATE (verrouille la ligne)
        // 3. blocked : BEGIN + tenter un UPDATE sur la meme ligne (sans await, sera bloque)
        // 4. sleep(200) pour laisser le blocage se produire
        // 5. Depuis client, detecter les blocages :
        //    SELECT pid, pg_blocking_pids(pid) AS blocked_by, query, state
        //    FROM pg_stat_activity
        //    WHERE cardinality(pg_blocking_pids(pid)) > 0
        // 6. Verifier qu'on trouve au moins un blocage
        // 7. ROLLBACK les transactions
      } finally {
        try { await query(blocker, 'ROLLBACK'); } catch (e) { /* ignore */ }
        try { await query(blocked, 'ROLLBACK'); } catch (e) { /* ignore */ }
        await blocker.end();
        await blocked.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 9 : Dead tuples — creer, monitorer, VACUUM
    // -----------------------------------------------------------------------
    await test('Dead tuples — creer, monitorer, VACUUM, re-verifier', async () => {
      // TODO:
      // 1. Creer une table mon_deadtuple_demo (id SERIAL PK, data TEXT)
      // 2. Inserer 1000 lignes
      // 3. Mettre a jour toutes les lignes (UPDATE ... SET data = ...)
      //    Cela cree 1000 dead tuples
      // 4. ANALYZE la table
      // 5. Verifier les dead tuples :
      //    SELECT n_live_tup, n_dead_tup
      //    FROM pg_stat_user_tables
      //    WHERE relname = 'mon_deadtuple_demo'
      // 6. n_dead_tup doit etre > 0
      // 7. Executer VACUUM mon_deadtuple_demo
      // 8. Re-verifier : n_dead_tup doit etre 0 (ou tres faible)
    });

    // -----------------------------------------------------------------------
    // Test 10 : Health check — fonction JSON
    // -----------------------------------------------------------------------
    await test('Health check — fonction retournant les metriques en JSON', async () => {
      // TODO:
      // 1. Creer une fonction PL/pgSQL health_check() RETURNS JSONB :
      //    - active_connections : nombre de connexions actives
      //    - cache_hit_ratio : ratio de cache hit
      //    - total_dead_tuples : somme des dead tuples
      //    - database_size : taille de la base en pretty
      //    - uptime : duree depuis le demarrage
      //    - longest_running_query_seconds : duree de la requete la plus longue
      // 2. Appeler la fonction : SELECT health_check()
      // 3. Parser le JSON et verifier les cles
      // 4. Verifier que active_connections > 0
      // 5. Verifier que cache_hit_ratio > 0
    });

    summary();
  } finally {
    try {
      await teardownDatabase(client, `
        DROP TABLE IF EXISTS mon_orders CASCADE;
        DROP TABLE IF EXISTS mon_products CASCADE;
        DROP TABLE IF EXISTS mon_deadtuple_demo CASCADE;
        DROP FUNCTION IF EXISTS health_check() CASCADE;
      `);
    } catch (e) { /* ignore */ }
    await client.end();
  }
}

run().catch(console.error);
