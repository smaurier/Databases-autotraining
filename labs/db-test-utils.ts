// =============================================================================
// db-test-utils.ts — Utilitaires partagés pour les labs PostgreSQL
// =============================================================================

import pg from 'pg';
import type { ClientConfig, QueryResult } from 'pg';

const { Client } = pg;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface TestError {
  name: string;
  error: Error;
}

interface TestRunner {
  test: (name: string, fn: () => Promise<void>) => Promise<void>;
  assert: (condition: unknown, message?: string) => void;
  assertEqual: (actual: unknown, expected: unknown, message?: string) => void;
  assertIncludes: (str: string | unknown[], substr: unknown, message?: string) => void;
  assertGreaterThan: (actual: number, expected: number, message?: string) => void;
  assertLessThan: (actual: number, expected: number, message?: string) => void;
  summary: () => { passed: number; failed: number; total: number };
}

interface MeasureResult<T> {
  result: T;
  duration: number;
}

// ---------------------------------------------------------------------------
// Configuration par défaut
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG: ClientConfig = {
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  database: process.env.PGDATABASE || 'postgres',
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
};

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------
export function createTestRunner(labName: string): TestRunner {
  let passed = 0;
  let failed = 0;
  const errors: TestError[] = [];

  async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      passed++;
      console.log(`  ✅ ${name}`);
    } catch (err) {
      failed++;
      const error = err instanceof Error ? err : new Error(String(err));
      errors.push({ name, error });
      console.log(`  ❌ ${name}`);
      console.log(`     → ${error.message}`);
    }
  }

  function assert(condition: unknown, message?: string): void {
    if (!condition) throw new Error(message || 'Assertion failed');
  }

  function assertEqual(actual: unknown, expected: unknown, message?: string): void {
    if (actual !== expected) {
      throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  function assertIncludes(str: string | unknown[], substr: unknown, message?: string): void {
    if (typeof str === 'string' && !str.includes(substr as string)) {
      throw new Error(message || `Expected string to include "${substr}"`);
    }
    if (Array.isArray(str) && !str.includes(substr)) {
      throw new Error(message || `Expected array to include ${JSON.stringify(substr)}`);
    }
  }

  function assertGreaterThan(actual: number, expected: number, message?: string): void {
    if (!(actual > expected)) {
      throw new Error(message || `Expected ${actual} > ${expected}`);
    }
  }

  function assertLessThan(actual: number, expected: number, message?: string): void {
    if (!(actual < expected)) {
      throw new Error(message || `Expected ${actual} < ${expected}`);
    }
  }

  function summary(): { passed: number; failed: number; total: number } {
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
export async function createClient(config: Partial<ClientConfig> = {}): Promise<pg.Client> {
  const client = new Client({ ...DEFAULT_CONFIG, ...config });
  await client.connect();
  return client;
}

export async function query(client: pg.Client, sql: string, params: unknown[] = []): Promise<QueryResult> {
  try {
    return await client.query(sql, params);
  } catch (err) {
    if (err instanceof Error) {
      err.message = `SQL Error: ${err.message}\nQuery: ${sql}`;
    }
    throw err;
  }
}

export async function setupDatabase(client: pg.Client, sql: string): Promise<void> {
  await client.query(sql);
}

export async function teardownDatabase(client: pg.Client, sql: string): Promise<void> {
  await client.query(sql);
}

export async function withClient<T>(fn: (client: pg.Client) => Promise<T>, config: Partial<ClientConfig> = {}): Promise<T> {
  const client = await createClient(config);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function withTransaction<T>(client: pg.Client, fn: (client: pg.Client) => Promise<T>): Promise<T> {
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function measure<T>(fn: () => Promise<T>): Promise<MeasureResult<T>> {
  const start = performance.now();
  const result = await fn();
  const duration = performance.now() - start;
  return { result, duration };
}
