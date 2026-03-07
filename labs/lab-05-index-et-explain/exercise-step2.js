// =============================================================================
// Lab 05 — Index & EXPLAIN — Etape 2 : Index B-tree (Exercice)
// =============================================================================
// Objectifs :
//   - Creer des index B-tree
//   - Observer la transition Seq Scan -> Index Scan
//   - Index composite et UNIQUE
// =============================================================================

import { createTestRunner, createClient, query } from '../db-test-utils.js';

const { test, assert, assertEqual, assertGreaterThan, assertIncludes, summary } = createTestRunner('Lab 05 — Etape 2 : Index B-tree');

let client;

async function setupSchema(c) {
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

  // ─── Tests 1-5 : repris de l'etape 1 ────────────────────────────────────────

  await test('EXPLAIN simple — observer le plan', async () => {
    const result = await query(client, "EXPLAIN SELECT * FROM employees WHERE department = 'Engineering'");
    assert(result.rows.length > 0, 'EXPLAIN devrait retourner un plan');
  });

  await test('Verification du Seq Scan (sans index)', async () => {
    const result = await query(client, "EXPLAIN SELECT * FROM employees WHERE department = 'Engineering'");
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assertIncludes(plan, 'Seq Scan', 'Sans index, PostgreSQL devrait utiliser un Seq Scan');
  });

  await test('EXPLAIN ANALYZE — temps reels', async () => {
    const result = await query(client, "EXPLAIN ANALYZE SELECT * FROM employees WHERE department = 'Engineering'");
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assertIncludes(plan, 'actual time', 'EXPLAIN ANALYZE devrait montrer les temps reels');
  });

  await test('Extraction du cout du plan', async () => {
    const result = await query(client, "EXPLAIN SELECT * FROM employees WHERE department = 'Engineering'");
    const planLine = result.rows[0]['QUERY PLAN'];
    const match = planLine.match(/cost=[\d.]+\.\.([\d.]+)/);
    assert(match, 'Le plan devrait contenir un cout');
    const totalCost = parseFloat(match[1]);
    assertGreaterThan(totalCost, 0, 'Le cout devrait etre > 0');
  });

  await test('Comparaison lignes estimees vs reelles', async () => {
    const result = await query(client, "EXPLAIN ANALYZE SELECT * FROM employees WHERE department = 'Engineering'");
    const planLine = result.rows[0]['QUERY PLAN'];
    const estimatedMatch = planLine.match(/rows=(\d+)/);
    const actualMatch = planLine.match(/actual.*rows=(\d+)/);
    assert(estimatedMatch, 'Le plan devrait contenir les lignes estimees');
    assert(actualMatch, 'EXPLAIN ANALYZE devrait contenir les lignes reelles');
  });

  // ─── Tests 6-8 : Index B-tree ───────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6 : Index B-tree sur department → Index Scan
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Index B-tree sur department → Index Scan', async () => {
    // TODO 6 : Creez un index B-tree sur la colonne "department"
    // Puis verifiez avec EXPLAIN que PostgreSQL utilise un Index Scan ou Bitmap Index Scan
    //
    // Indice : CREATE INDEX idx_employees_department ON employees(department);
    // Puis : EXPLAIN SELECT * FROM employees WHERE department = 'HR'
    // Note : HR a ~2000 lignes sur 10000, donc PG peut choisir Bitmap Index Scan

    // Verification
    const result = await query(client, "EXPLAIN SELECT * FROM employees WHERE department = 'HR'");
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Index Scan') || plan.includes('Bitmap'),
      `Le plan devrait utiliser un Index Scan ou Bitmap Scan, recu : ${plan}`
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 7 : Index composite (department, salary)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Index composite (department, salary)', async () => {
    // TODO 7 : Creez un index composite sur (department, salary)
    // Puis verifiez qu'il est utilise pour une requete filtrant sur les deux colonnes
    //
    // Indice : CREATE INDEX idx_employees_dept_salary ON employees(department, salary);
    // Puis : EXPLAIN SELECT * FROM employees WHERE department = 'HR' AND salary > 60000

    const result = await query(client, "EXPLAIN SELECT * FROM employees WHERE department = 'HR' AND salary > 60000");
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Index') || plan.includes('Bitmap'),
      `Le plan devrait utiliser un index, recu : ${plan}`
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 8 : Index UNIQUE sur email
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Index UNIQUE sur email', async () => {
    // TODO 8 : Creez un index UNIQUE sur la colonne "email"
    // Puis verifiez que :
    //   a) L'index est utilise pour un SELECT par email
    //   b) Un INSERT en doublon echoue
    //
    // Indice : CREATE UNIQUE INDEX idx_employees_email ON employees(email);

    // a) Verification de l'utilisation de l'index
    const result = await query(client, "EXPLAIN SELECT * FROM employees WHERE email = 'employe_1@entreprise.fr'");
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Index Scan') || plan.includes('Bitmap'),
      `La recherche par email devrait utiliser un Index Scan ou Bitmap Scan, recu : ${plan}`
    );

    // b) Verification de la contrainte d'unicite
    let duplicateError = false;
    try {
      await query(client, `
        INSERT INTO employees (name, department, salary, hire_date, email)
        VALUES ('Doublon', 'HR', 50000, '2024-01-01', 'employe_1@entreprise.fr')
      `);
    } catch (err) {
      duplicateError = true;
    }
    assert(duplicateError, 'L\'insertion d\'un email en doublon devrait echouer');
  });

} finally {
  if (client) {
    await query(client, 'DROP TABLE IF EXISTS employees');
    await client.end();
  }
  summary();
}
