// =============================================================================
// Lab 17 — Monitoring et Observabilite PostgreSQL (Solution)
// =============================================================================

import pg from 'pg';
import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.ts';

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
async function run(): Promise<void> {
  const client = await createClient();

  try {
    await setupDatabase(client, CLEANUP_SQL);

    console.log('\n📊 Lab 17 — Monitoring et Observabilite\n');

    // -----------------------------------------------------------------------
    // Test 1 : pg_stat_activity — sessions actives
    // -----------------------------------------------------------------------
    await test('pg_stat_activity — trouver les sessions actives', async () => {
      const res = await query(client, `
        SELECT pid, usename, state, query, query_start, backend_type
        FROM pg_stat_activity
        WHERE datname = current_database()
      `);

      assertGreaterThan(res.rows.length, 0,
        'Doit trouver au moins 1 session (la notre)');

      // Notre propre session doit etre 'active'
      const mySession = res.rows.find(r => r.state === 'active');
      assert(mySession !== undefined,
        'Notre session doit etre active');

      // Compter par etat
      const stateRes = await query(client, `
        SELECT state, count(*) AS cnt
        FROM pg_stat_activity
        WHERE datname = current_database()
        GROUP BY state
        ORDER BY cnt DESC
      `);

      console.log(`     → ${res.rows.length} sessions sur la base courante`);
      stateRes.rows.forEach(r =>
        console.log(`       • ${r.state || 'NULL'} : ${r.cnt}`)
      );
    });

    // -----------------------------------------------------------------------
    // Test 2 : pg_stat_statements — top SQL
    // -----------------------------------------------------------------------
    await test('pg_stat_statements — activer et interroger les top SQL', async () => {
      let extensionAvailable = false;

      try {
        await query(client, 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
        extensionAvailable = true;
      } catch (_err) {
        console.log(`     → Extension pg_stat_statements non disponible`);
        console.log(`     → Pour l'activer : shared_preload_libraries = 'pg_stat_statements' dans postgresql.conf`);
      }

      if (extensionAvailable) {
        const res = await query(client, `
          SELECT query, calls, total_exec_time, mean_exec_time, rows
          FROM pg_stat_statements
          ORDER BY total_exec_time DESC
          LIMIT 5
        `);

        assertGreaterThan(res.rows.length, 0,
          'pg_stat_statements doit contenir des entrees');

        console.log(`     → Top 5 requetes par temps d'execution :`);
        res.rows.forEach((r, i) =>
          console.log(`       ${i + 1}. calls=${r.calls}, mean=${parseFloat(r.mean_exec_time).toFixed(2)}ms — ${r.query.substring(0, 60)}...`)
        );
      } else {
        // Mode degrade : verifier que la vue existe dans le catalogue
        const extRes = await query(client, `
          SELECT name, default_version
          FROM pg_available_extensions
          WHERE name = 'pg_stat_statements'
        `);

        if (extRes.rows.length > 0) {
          console.log(`     → Extension disponible (v${extRes.rows[0].default_version}) mais pas chargee`);
        } else {
          console.log(`     → Extension non disponible sur ce serveur`);
        }
        assert(true, 'Test en mode degrade — extension non chargee');
      }
    });

    // -----------------------------------------------------------------------
    // Test 3 : pg_stat_user_tables — seq_scan vs idx_scan
    // -----------------------------------------------------------------------
    await test('pg_stat_user_tables — ratio seq_scan vs idx_scan', async () => {
      // Creer la table avec des donnees
      await query(client, `
        CREATE TABLE mon_products (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          category TEXT NOT NULL,
          price NUMERIC(10,2) NOT NULL
        )
      `);

      // Inserer 1000 lignes
      await query(client, `
        INSERT INTO mon_products (name, category, price)
        SELECT
          'Produit ' || i,
          CASE (i % 5)
            WHEN 0 THEN 'electronique'
            WHEN 1 THEN 'vetement'
            WHEN 2 THEN 'alimentation'
            WHEN 3 THEN 'sport'
            WHEN 4 THEN 'maison'
          END,
          round((random() * 200 + 5)::numeric, 2)
        FROM generate_series(1, 1000) AS i
      `);

      // Creer un index sur category
      await query(client, 'CREATE INDEX idx_mon_products_cat ON mon_products (category)');

      // ANALYZE pour les statistiques
      await query(client, 'ANALYZE mon_products');

      // Forcer des seq_scans et idx_scans
      // Reset des stats pour avoir des chiffres propres
      await query(client, 'SELECT pg_stat_reset_single_table_counters(\'mon_products\'::regclass)');

      // Seq scan (pas de WHERE)
      await query(client, 'SELECT count(*) FROM mon_products');
      await query(client, 'SELECT count(*) FROM mon_products');

      // Index scan (WHERE sur category)
      await query(client, "SELECT * FROM mon_products WHERE category = 'electronique'");
      await query(client, "SELECT * FROM mon_products WHERE category = 'sport'");
      await query(client, "SELECT * FROM mon_products WHERE category = 'vetement'");

      // Verifier les statistiques
      const statsRes = await query(client, `
        SELECT
          relname,
          seq_scan,
          idx_scan,
          CASE WHEN (seq_scan + idx_scan) > 0
            THEN round(100.0 * idx_scan / (seq_scan + idx_scan), 1)
            ELSE 0 END AS idx_scan_pct
        FROM pg_stat_user_tables
        WHERE relname = 'mon_products'
      `);

      assertEqual(statsRes.rows.length, 1, 'Doit trouver la table mon_products');

      const stats = statsRes.rows[0];
      console.log(`     → seq_scan : ${stats.seq_scan}`);
      console.log(`     → idx_scan : ${stats.idx_scan}`);
      console.log(`     → Index scan ratio : ${stats.idx_scan_pct}%`);
    });

    // -----------------------------------------------------------------------
    // Test 4 : pg_stat_user_indexes — index inutilises
    // -----------------------------------------------------------------------
    await test('pg_stat_user_indexes — trouver les index inutilises', async () => {
      // Creer un index inutilise
      await query(client, 'CREATE INDEX idx_mon_unused_price ON mon_products (price)');

      // Reset des stats de cet index
      await query(client, 'SELECT pg_stat_reset_single_table_counters(\'mon_products\'::regclass)');

      // NE PAS utiliser cet index (pas de WHERE price = ...)

      // Chercher les index inutilises
      const res = await query(client, `
        SELECT
          indexrelname,
          relname AS table_name,
          idx_scan,
          idx_tup_read,
          idx_tup_fetch,
          pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
        FROM pg_stat_user_indexes
        WHERE schemaname = 'public'
          AND idx_scan = 0
          AND indexrelname NOT LIKE '%_pkey'
        ORDER BY pg_relation_size(indexrelid) DESC
      `);

      assertGreaterThan(res.rows.length, 0,
        'Doit trouver au moins un index inutilise');

      const unusedNames = res.rows.map(r => r.indexrelname);
      assertIncludes(unusedNames, 'idx_mon_unused_price',
        'L\'index idx_mon_unused_price doit etre dans la liste');

      console.log(`     → ${res.rows.length} index inutilises trouves :`);
      res.rows.forEach(r =>
        console.log(`       • ${r.indexrelname} sur ${r.table_name} (${r.index_size}, scans: ${r.idx_scan})`)
      );
    });

    // -----------------------------------------------------------------------
    // Test 5 : pg_stat_database — cache hit ratio
    // -----------------------------------------------------------------------
    await test('pg_stat_database — calculer le cache hit ratio', async () => {
      const res = await query(client, `
        SELECT
          datname,
          blks_hit,
          blks_read,
          CASE WHEN (blks_hit + blks_read) > 0
            THEN round(100.0 * blks_hit / (blks_hit + blks_read), 2)
            ELSE 0 END AS cache_hit_ratio
        FROM pg_stat_database
        WHERE datname = current_database()
      `);

      assertEqual(res.rows.length, 1, 'Doit trouver la base courante');

      const stats = res.rows[0];
      const ratio = parseFloat(stats.cache_hit_ratio);

      // Le cache hit ratio devrait etre > 50% au minimum
      assertGreaterThan(ratio, 0,
        'Le cache hit ratio doit etre positif');

      console.log(`     → Base : ${stats.datname}`);
      console.log(`     → Blocs en cache (hit) : ${parseInt(stats.blks_hit).toLocaleString()}`);
      console.log(`     → Blocs lus depuis disque : ${parseInt(stats.blks_read).toLocaleString()}`);
      console.log(`     → Cache hit ratio : ${ratio}%`);

      if (ratio < 90) {
        console.log(`     → ATTENTION : ratio < 90%, augmenter shared_buffers`);
      } else {
        console.log(`     → OK : bon ratio de cache`);
      }
    });

    // -----------------------------------------------------------------------
    // Test 6 : pg_stat_bgwriter — checkpoints
    // -----------------------------------------------------------------------
    await test('pg_stat_bgwriter — statistiques de checkpoints', async () => {
      const res = await query(client, `
        SELECT
          checkpoints_timed,
          checkpoints_req,
          buffers_checkpoint,
          buffers_backend,
          buffers_alloc,
          stats_reset
        FROM pg_stat_bgwriter
      `);

      assertEqual(res.rows.length, 1, 'pg_stat_bgwriter doit retourner une ligne');

      const stats = res.rows[0];
      const timedCp = parseInt(stats.checkpoints_timed);
      const reqCp = parseInt(stats.checkpoints_req);

      console.log(`     → Checkpoints planifies (timed) : ${timedCp}`);
      console.log(`     → Checkpoints forces (requested) : ${reqCp}`);
      console.log(`     → Buffers ecrits par checkpointer : ${stats.buffers_checkpoint}`);
      console.log(`     → Buffers ecrits par backends : ${stats.buffers_backend}`);
      console.log(`     → Buffers alloues : ${stats.buffers_alloc}`);

      if (reqCp > timedCp && timedCp > 0) {
        console.log(`     → ATTENTION : plus de checkpoints forces que planifies`);
        console.log(`       → Augmenter checkpoint_timeout ou max_wal_size`);
      }
    });

    // -----------------------------------------------------------------------
    // Test 7 : Requetes longues (> 1 seconde)
    // -----------------------------------------------------------------------
    await test('Identifier les requetes longues (> 1 seconde)', async () => {
      const slowClient = await createClient();
      try {
        // Lancer une requete longue en arriere-plan
        const slowQuery = slowClient.query('SELECT pg_sleep(2)');

        // Attendre un peu pour que la requete demarre
        await sleep(300);

        // Chercher les requetes longues
        const res = await query(client, `
          SELECT
            pid,
            now() - query_start AS duration,
            state,
            left(query, 80) AS query_preview
          FROM pg_stat_activity
          WHERE state = 'active'
            AND query NOT LIKE '%pg_stat_activity%'
            AND now() - query_start > INTERVAL '0.1 seconds'
          ORDER BY query_start ASC
        `);

        // On devrait trouver notre pg_sleep
        const sleepQueries = res.rows.filter(r =>
          r.query_preview.includes('pg_sleep')
        );

        assertGreaterThan(sleepQueries.length, 0,
          'Doit trouver la requete pg_sleep comme requete longue');

        console.log(`     → ${res.rows.length} requete(s) longue(s) detectee(s) :`);
        res.rows.forEach(r =>
          console.log(`       • PID ${r.pid} (${r.duration}) : ${r.query_preview}`)
        );

        // Attendre la fin
        await slowQuery;
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
        // Creer une table et inserer une ligne
        await query(client, `
          CREATE TABLE IF NOT EXISTS mon_orders (
            id SERIAL PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'pending'
          )
        `);
        await query(client, `
          INSERT INTO mon_orders (status) VALUES ('pending')
          ON CONFLICT DO NOTHING
        `);

        // blocker verrouille la ligne
        await query(blocker, 'BEGIN');
        await query(blocker, 'SELECT * FROM mon_orders WHERE id = 1 FOR UPDATE');

        // blocked tente un UPDATE (sera bloque)
        await query(blocked, 'BEGIN');
        const blockedQuery = blocked.query(
          "UPDATE mon_orders SET status = 'processed' WHERE id = 1"
        );

        // Attendre que le blocage se produise
        await sleep(300);

        // Detecter les blocages
        const res = await query(client, `
          SELECT
            pid,
            pg_blocking_pids(pid) AS blocked_by,
            state,
            wait_event_type,
            left(query, 80) AS query_preview
          FROM pg_stat_activity
          WHERE cardinality(pg_blocking_pids(pid)) > 0
        `);

        assertGreaterThan(res.rows.length, 0,
          'Doit detecter au moins une session bloquee');

        console.log(`     → ${res.rows.length} session(s) bloquee(s) :`);
        res.rows.forEach(r =>
          console.log(`       • PID ${r.pid} bloque par ${r.blocked_by} — ${r.query_preview}`)
        );

        // Liberer le verrou
        await query(blocker, 'ROLLBACK');
        await blockedQuery; // La requete bloquee se termine
        await query(blocked, 'ROLLBACK');
      } finally {
        try { await query(blocker, 'ROLLBACK'); } catch (_e) { /* ignore */ }
        try { await query(blocked, 'ROLLBACK'); } catch (_e) { /* ignore */ }
        await blocker.end();
        await blocked.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 9 : Dead tuples — creer, monitorer, VACUUM
    // -----------------------------------------------------------------------
    await test('Dead tuples — creer, monitorer, VACUUM, re-verifier', async () => {
      // Creer la table
      await query(client, `
        CREATE TABLE mon_deadtuple_demo (
          id SERIAL PRIMARY KEY,
          data TEXT NOT NULL
        )
      `);

      // Inserer 1000 lignes
      await query(client, `
        INSERT INTO mon_deadtuple_demo (data)
        SELECT 'Ligne originale ' || i
        FROM generate_series(1, 1000) AS i
      `);

      // Mettre a jour TOUTES les lignes (cree 1000 dead tuples)
      await query(client, `
        UPDATE mon_deadtuple_demo SET data = 'Ligne modifiee ' || id
      `);

      // Forcer la mise a jour des stats
      await query(client, 'ANALYZE mon_deadtuple_demo');

      // Verifier les dead tuples AVANT vacuum
      const beforeRes = await query(client, `
        SELECT n_live_tup, n_dead_tup, last_vacuum, last_autovacuum
        FROM pg_stat_user_tables
        WHERE relname = 'mon_deadtuple_demo'
      `);

      const deadBefore = parseInt(beforeRes.rows[0].n_dead_tup);
      assertGreaterThan(deadBefore, 0,
        'Il doit y avoir des dead tuples apres l\'UPDATE massif');

      console.log(`     → Avant VACUUM :`);
      console.log(`       • n_live_tup : ${beforeRes.rows[0].n_live_tup}`);
      console.log(`       • n_dead_tup : ${deadBefore}`);

      // Executer VACUUM
      await query(client, 'VACUUM mon_deadtuple_demo');

      // Re-verifier apres VACUUM
      const afterRes = await query(client, `
        SELECT n_live_tup, n_dead_tup, last_vacuum
        FROM pg_stat_user_tables
        WHERE relname = 'mon_deadtuple_demo'
      `);

      const deadAfter = parseInt(afterRes.rows[0].n_dead_tup);
      assertLessThan(deadAfter, deadBefore,
        'Les dead tuples doivent diminuer apres VACUUM');

      console.log(`     → Apres VACUUM :`);
      console.log(`       • n_live_tup : ${afterRes.rows[0].n_live_tup}`);
      console.log(`       • n_dead_tup : ${deadAfter}`);
      console.log(`       • last_vacuum : ${afterRes.rows[0].last_vacuum}`);
    });

    // -----------------------------------------------------------------------
    // Test 10 : Health check — fonction JSON
    // -----------------------------------------------------------------------
    await test('Health check — fonction retournant les metriques en JSON', async () => {
      // Creer la fonction de health check
      await query(client, `
        CREATE OR REPLACE FUNCTION health_check() RETURNS JSONB AS $$
        DECLARE
          result JSONB;
          v_active_connections INT;
          v_cache_hit_ratio NUMERIC;
          v_total_dead_tuples BIGINT;
          v_database_size TEXT;
          v_uptime INTERVAL;
          v_longest_query_seconds NUMERIC;
        BEGIN
          -- Connexions actives
          SELECT count(*) INTO v_active_connections
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND state = 'active';

          -- Cache hit ratio
          SELECT
            CASE WHEN (blks_hit + blks_read) > 0
              THEN round(100.0 * blks_hit / (blks_hit + blks_read), 2)
              ELSE 0 END
          INTO v_cache_hit_ratio
          FROM pg_stat_database
          WHERE datname = current_database();

          -- Dead tuples total
          SELECT coalesce(sum(n_dead_tup), 0) INTO v_total_dead_tuples
          FROM pg_stat_user_tables;

          -- Taille de la base
          SELECT pg_size_pretty(pg_database_size(current_database()))
          INTO v_database_size;

          -- Uptime
          SELECT now() - pg_postmaster_start_time() INTO v_uptime;

          -- Requete la plus longue
          SELECT coalesce(
            extract(epoch FROM max(now() - query_start)), 0
          ) INTO v_longest_query_seconds
          FROM pg_stat_activity
          WHERE state = 'active'
            AND query NOT LIKE '%health_check%';

          result := jsonb_build_object(
            'active_connections', v_active_connections,
            'cache_hit_ratio', v_cache_hit_ratio,
            'total_dead_tuples', v_total_dead_tuples,
            'database_size', v_database_size,
            'uptime', v_uptime::text,
            'longest_running_query_seconds', round(v_longest_query_seconds, 2)
          );

          RETURN result;
        END;
        $$ LANGUAGE plpgsql;
      `);

      // Appeler la fonction
      const res = await query(client, 'SELECT health_check() AS health');
      const health = res.rows[0].health;

      // Verifier les cles
      assert(health.active_connections !== undefined,
        'active_connections doit etre present');
      assert(health.cache_hit_ratio !== undefined,
        'cache_hit_ratio doit etre present');
      assert(health.total_dead_tuples !== undefined,
        'total_dead_tuples doit etre present');
      assert(health.database_size !== undefined,
        'database_size doit etre present');
      assert(health.uptime !== undefined,
        'uptime doit etre present');

      // Verifier les valeurs
      assertGreaterThan(health.active_connections, 0,
        'active_connections doit etre > 0');
      assertGreaterThan(parseFloat(health.cache_hit_ratio), 0,
        'cache_hit_ratio doit etre > 0');

      console.log(`     → Health check JSON :`);
      console.log(`       • Connexions actives : ${health.active_connections}`);
      console.log(`       • Cache hit ratio : ${health.cache_hit_ratio}%`);
      console.log(`       • Dead tuples total : ${health.total_dead_tuples}`);
      console.log(`       • Taille base : ${health.database_size}`);
      console.log(`       • Uptime : ${health.uptime}`);
      console.log(`       • Plus longue requete : ${health.longest_running_query_seconds}s`);
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
    } catch (_e) { /* ignore */ }
    await client.end();
  }
}

run().catch(console.error);
