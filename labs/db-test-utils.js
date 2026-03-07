// =============================================================================
// db-test-utils.js — Utilitaires partagés pour les labs PostgreSQL
// =============================================================================

import pg from 'pg';
const { Client } = pg;

// ---------------------------------------------------------------------------
// Configuration par défaut
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'postgres',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
};

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
export function createTestRunner(labName) {
  let passed = 0;
  let failed = 0;
  const errors = [];

  async function test(name, fn) {
    try {
      await fn();
      passed++;
      console.log(`  ✅ ${name}`);
    } catch (err) {
      failed++;
      errors.push({ name, error: err });
      console.log(`  ❌ ${name}`);
      console.log(`     → ${err.message}`);
    }
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
  }

  function assertEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  function assertIncludes(str, substr, message) {
    if (typeof str === 'string' && !str.includes(substr)) {
      throw new Error(message || `Expected string to include "${substr}"`);
    }
    if (Array.isArray(str) && !str.includes(substr)) {
      throw new Error(message || `Expected array to include ${JSON.stringify(substr)}`);
    }
  }

  function assertGreaterThan(actual, expected, message) {
    if (!(actual > expected)) {
      throw new Error(message || `Expected ${actual} > ${expected}`);
    }
  }

  function assertLessThan(actual, expected, message) {
    if (!(actual < expected)) {
      throw new Error(message || `Expected ${actual} < ${expected}`);
    }
  }

  function summary() {
    const total = passed + failed;
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`📊 ${labName} — Résultats : ${passed}/${total} tests réussis`);
    if (failed > 0) {
      console.log(`\n❌ ${failed} test(s) échoué(s) :`);
      errors.forEach(({ name, error }) => {
        console.log(`   • ${name} : ${error.message}`);
      });
    } else {
      console.log(`\n🎉 Tous les tests passent !`);
    }
    console.log(`${'─'.repeat(50)}\n`);
    return { passed, failed, total };
  }

  return { test, assert, assertEqual, assertIncludes, assertGreaterThan, assertLessThan, summary };
}

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------
export async function createClient(config = {}) {
  const client = new Client({ ...DEFAULT_CONFIG, ...config });
  await client.connect();
  return client;
}

export async function query(client, sql, params = []) {
  try {
    return await client.query(sql, params);
  } catch (err) {
    err.message = `SQL Error: ${err.message}\nQuery: ${sql}`;
    throw err;
  }
}

export async function setupDatabase(client, sql) {
  await client.query(sql);
}

export async function teardownDatabase(client, sql) {
  await client.query(sql);
}

export async function withClient(fn, config = {}) {
  const client = await createClient(config);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function withTransaction(client, fn) {
  await client.query('BEGIN');
  try {
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function measure(fn) {
  const start = performance.now();
  const result = await fn();
  const duration = performance.now() - start;
  return { result, duration };
}
