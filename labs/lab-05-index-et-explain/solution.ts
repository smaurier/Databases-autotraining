// =============================================================================
// Lab 05 — Index & EXPLAIN (Solution)
// =============================================================================
// 12 tests couvrant EXPLAIN, B-tree, index composites, UNIQUE,
// index d'expression, index partiels, mesure de performances et statistiques.
// =============================================================================

import pg from 'pg';
import { createTestRunner, createClient, query, measure } from '../db-test-utils.ts';

const { test, assert, assertEqual, assertGreaterThan, assertLessThan, assertIncludes, summary } = createTestRunner('Lab 05 — Index & EXPLAIN');

let client: pg.Client | undefined;

async function setupSchema(c: pg.Client): Promise<void> {
  await query(c, 'DROP TABLE IF EXISTS employees');
  await query(c, `
    CREATE TABLE employees (
      id        SERIAL PRIMARY KEY,
      name      TEXT NOT NULL,
      department TEXT NOT NULL,
      salary    NUMERIC(10,2) NOT NULL,
      hire_date DATE NOT NULL,
      email     TEXT NOT NULL,
      is_active BOOLEAN DEFAULT true
    )
  `);

  await query(c, `
    INSERT INTO employees (name, department, salary, hire_date, email, is_active)
    SELECT
      'Employe_' || i,
      (ARRAY['Engineering', 'Marketing', 'Sales', 'HR', 'Finance'])[1 + (i % 5)],
      30000 + (random() * 70000)::int,
      DATE '2015-01-01' + (random() * 3650)::int,
      'employe_' || i || '@entreprise.fr',
      (random() > 0.2)
    FROM generate_series(1, 10000) AS i
  `);

  await query(c, 'ANALYZE employees');
}

try {
  client = await createClient();
  await setupSchema(client);

  // ═══════════════════════════════════════════════════════════════════════════
  // Tests 1-5 : EXPLAIN basique
  // ═══════════════════════════════════════════════════════════════════════════

  await test('EXPLAIN simple — observer le plan', async () => {
    const result = await query(client!, "EXPLAIN SELECT * FROM employees WHERE department = 'Engineering'");
    assert(result.rows.length > 0, 'EXPLAIN devrait retourner un plan');
    console.log('    Plan :', result.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n    '));
  });

  await test('Verification du Seq Scan (sans index)', async () => {
    const result = await query(client!, "EXPLAIN SELECT * FROM employees WHERE department = 'Engineering'");
    const plan = result.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assertIncludes(plan, 'Seq Scan', 'Sans index, PostgreSQL devrait utiliser un Seq Scan');
  });

  await test('EXPLAIN ANALYZE — temps reels', async () => {
    const result = await query(client!, "EXPLAIN ANALYZE SELECT * FROM employees WHERE department = 'Engineering'");
    const plan = result.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assertIncludes(plan, 'actual time', 'EXPLAIN ANALYZE devrait montrer les temps reels');
  });

  await test('Extraction du cout du plan', async () => {
    const result = await query(client!, "EXPLAIN SELECT * FROM employees WHERE department = 'Engineering'");
    const planLine = result.rows[0]['QUERY PLAN'];
    const match = planLine.match(/cost=[\d.]+\.\.([\d.]+)/);
    assert(match, 'Le plan devrait contenir un cout');
    const totalCost = parseFloat(match![1]);
    assertGreaterThan(totalCost, 0, 'Le cout devrait etre > 0');
    console.log(`    Cout total : ${totalCost}`);
  });

  await test('Comparaison lignes estimees vs reelles', async () => {
    const result = await query(client!, "EXPLAIN ANALYZE SELECT * FROM employees WHERE department = 'Engineering'");
    const planLine = result.rows[0]['QUERY PLAN'];
    const estimatedMatch = planLine.match(/rows=(\d+)/);
    const actualMatch = planLine.match(/actual.*rows=(\d+)/);
    assert(estimatedMatch, 'Le plan devrait contenir les lignes estimees');
    assert(actualMatch, 'EXPLAIN ANALYZE devrait contenir les lignes reelles');
    console.log(`    Lignes estimees : ${estimatedMatch![1]}`);
    console.log(`    Lignes reelles  : ${actualMatch![1]}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Tests 6-8 : Index B-tree
  // ═══════════════════════════════════════════════════════════════════════════

  await test('Index B-tree sur department → Index Scan', async () => {
    await query(client!, 'CREATE INDEX idx_employees_department ON employees(department)');
    await query(client!, 'ANALYZE employees');

    const result = await query(client!, "EXPLAIN SELECT * FROM employees WHERE department = 'HR'");
    const plan = result.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Index Scan') || plan.includes('Bitmap'),
      `Le plan devrait utiliser un Index Scan ou Bitmap Scan, recu : ${plan}`
    );
    console.log('    Plan :', result.rows[0]['QUERY PLAN']);
  });

  await test('Index composite (department, salary)', async () => {
    await query(client!, 'CREATE INDEX idx_employees_dept_salary ON employees(department, salary)');
    await query(client!, 'ANALYZE employees');

    const result = await query(client!, "EXPLAIN SELECT * FROM employees WHERE department = 'HR' AND salary > 60000");
    const plan = result.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Index') || plan.includes('Bitmap'),
      `Le plan devrait utiliser un index, recu : ${plan}`
    );
    console.log('    Plan :', result.rows[0]['QUERY PLAN']);
  });

  await test('Index UNIQUE sur email', async () => {
    await query(client!, 'CREATE UNIQUE INDEX idx_employees_email ON employees(email)');
    await query(client!, 'ANALYZE employees');

    // a) Verification de l'utilisation de l'index
    const result = await query(client!, "EXPLAIN SELECT * FROM employees WHERE email = 'employe_1@entreprise.fr'");
    const plan = result.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Index Scan') || plan.includes('Bitmap'),
      `La recherche par email devrait utiliser un Index Scan ou Bitmap Scan, recu : ${plan}`
    );

    // b) Verification de la contrainte d'unicite
    let duplicateError = false;
    try {
      await query(client!, `
        INSERT INTO employees (name, department, salary, hire_date, email)
        VALUES ('Doublon', 'HR', 50000, '2024-01-01', 'employe_1@entreprise.fr')
      `);
    } catch (_err) {
      duplicateError = true;
    }
    assert(duplicateError, 'L\'insertion d\'un email en doublon devrait echouer');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Tests 9-12 : Index avances
  // ═══════════════════════════════════════════════════════════════════════════

  await test('Index d\'expression LOWER(email)', async () => {
    await query(client!, 'CREATE INDEX idx_employees_lower_email ON employees(LOWER(email))');
    await query(client!, 'ANALYZE employees');

    const result = await query(client!, "EXPLAIN SELECT * FROM employees WHERE LOWER(email) = 'employe_42@entreprise.fr'");
    const plan = result.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Index Scan') || plan.includes('Bitmap'),
      `La recherche LOWER(email) devrait utiliser un Index Scan ou Bitmap Scan, recu : ${plan}`
    );
    console.log('    Plan :', result.rows[0]['QUERY PLAN']);
  });

  await test('Index partiel WHERE is_active = true', async () => {
    await query(client!, 'CREATE INDEX idx_employees_active_dept ON employees(department) WHERE is_active = true');
    await query(client!, 'ANALYZE employees');

    const result = await query(client!, "EXPLAIN SELECT * FROM employees WHERE department = 'HR' AND is_active = true");
    const plan = result.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Index') || plan.includes('Bitmap'),
      `Le plan devrait utiliser un index (partiel), recu : ${plan}`
    );
    console.log('    Plan :', result.rows[0]['QUERY PLAN']);
  });

  await test('Comparaison temps Seq Scan vs Index Scan', async () => {
    // Forcer Seq Scan en desactivant les index scans
    await query(client!, 'SET enable_indexscan = off');
    await query(client!, 'SET enable_bitmapscan = off');

    const { duration: seqTime } = await measure(async () => {
      await query(client!, "SELECT * FROM employees WHERE email = 'employe_5000@entreprise.fr'");
    });

    // Reactiver les index
    await query(client!, 'SET enable_indexscan = on');
    await query(client!, 'SET enable_bitmapscan = on');

    const { duration: idxTime } = await measure(async () => {
      await query(client!, "SELECT * FROM employees WHERE email = 'employe_5000@entreprise.fr'");
    });

    console.log(`    Seq Scan : ${seqTime.toFixed(2)} ms`);
    console.log(`    Index Scan : ${idxTime.toFixed(2)} ms`);
    assert(seqTime !== undefined && idxTime !== undefined, 'Les temps devraient etre mesures');
  });

  await test('Statistiques d\'utilisation des index (pg_stat_user_indexes)', async () => {
    const result = await query(client!, `
      SELECT indexrelname, idx_scan, idx_tup_read
      FROM pg_stat_user_indexes
      WHERE schemaname = 'public' AND relname = 'employees'
      ORDER BY indexrelname
    `);

    assertGreaterThan(result.rows.length, 0, 'Il devrait y avoir des index dans les statistiques');
    console.log('    Index trouves :');
    result.rows.forEach((r: { indexrelname: string; idx_scan: string; idx_tup_read: string }) => {
      console.log(`      ${r.indexrelname} — scans: ${r.idx_scan}, tuples lus: ${r.idx_tup_read}`);
    });
  });

} finally {
  if (client) {
    await query(client, 'DROP TABLE IF EXISTS employees');
    await client.end();
  }
  summary();
}
