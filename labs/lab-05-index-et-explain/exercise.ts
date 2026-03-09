// =============================================================================
// Lab 05 — Index & EXPLAIN — Version complete (Exercice)
// =============================================================================
// Objectifs :
//   - Index d'expression (LOWER, ...)
//   - Index partiels (WHERE condition)
//   - Mesurer les performances
//   - Consulter les statistiques d'index
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

  // ─── Tests 1-5 : EXPLAIN basique ────────────────────────────────────────────

  await test('EXPLAIN simple — observer le plan', async () => {
    const result = await query(client!, "EXPLAIN SELECT * FROM employees WHERE department = 'Engineering'");
    assert(result.rows.length > 0, 'EXPLAIN devrait retourner un plan');
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
    assertGreaterThan(parseFloat(match![1]), 0, 'Le cout devrait etre > 0');
  });

  await test('Comparaison lignes estimees vs reelles', async () => {
    const result = await query(client!, "EXPLAIN ANALYZE SELECT * FROM employees WHERE department = 'Engineering'");
    const planLine = result.rows[0]['QUERY PLAN'];
    assert(planLine.match(/rows=(\d+)/), 'Le plan devrait contenir les lignes estimees');
    assert(planLine.match(/actual.*rows=(\d+)/), 'EXPLAIN ANALYZE devrait contenir les lignes reelles');
  });

  // ─── Tests 6-8 : Index B-tree ───────────────────────────────────────────────

  await test('Index B-tree sur department → Index Scan', async () => {
    await query(client!, 'CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department)');
    await query(client!, 'ANALYZE employees');
    const result = await query(client!, "EXPLAIN SELECT * FROM employees WHERE department = 'HR'");
    const plan = result.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assert(plan.includes('Index Scan') || plan.includes('Bitmap'), `Devrait utiliser un index, recu : ${plan}`);
  });

  await test('Index composite (department, salary)', async () => {
    await query(client!, 'CREATE INDEX IF NOT EXISTS idx_employees_dept_salary ON employees(department, salary)');
    await query(client!, 'ANALYZE employees');
    const result = await query(client!, "EXPLAIN SELECT * FROM employees WHERE department = 'HR' AND salary > 60000");
    const plan = result.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assert(plan.includes('Index') || plan.includes('Bitmap'), `Devrait utiliser un index, recu : ${plan}`);
  });

  await test('Index UNIQUE sur email', async () => {
    await query(client!, 'CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email ON employees(email)');
    await query(client!, 'ANALYZE employees');
    const result = await query(client!, "EXPLAIN SELECT * FROM employees WHERE email = 'employe_1@entreprise.fr'");
    const plan = result.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Index Scan') || plan.includes('Bitmap'),
      `Recherche par email devrait utiliser un Index Scan ou Bitmap Scan, recu : ${plan}`
    );
    let duplicateError = false;
    try {
      await query(client!, "INSERT INTO employees (name, department, salary, hire_date, email) VALUES ('Dup', 'HR', 50000, '2024-01-01', 'employe_1@entreprise.fr')");
    } catch (_err) { duplicateError = true; }
    assert(duplicateError, 'Doublon email devrait echouer');
  });

  // ─── Tests 9-12 : Index avances ─────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 9 : Index d'expression LOWER(email)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Index d\'expression LOWER(email)', async () => {
    // TODO 9 : Creez un index sur LOWER(email) pour les recherches insensibles a la casse
    // Puis verifiez que EXPLAIN montre l'utilisation de l'index
    //
    // Indice : CREATE INDEX idx_employees_lower_email ON employees(LOWER(email));
    // Requete : EXPLAIN SELECT * FROM employees WHERE LOWER(email) = 'employe_42@entreprise.fr'

    const result = await query(client!, "EXPLAIN SELECT * FROM employees WHERE LOWER(email) = 'employe_42@entreprise.fr'");
    const plan = result.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Index Scan') || plan.includes('Bitmap'),
      `La recherche LOWER(email) devrait utiliser un Index Scan ou Bitmap Scan, recu : ${plan}`
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 10 : Index partiel WHERE is_active = true
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Index partiel WHERE is_active = true', async () => {
    // TODO 10 : Creez un index partiel sur department pour les employes actifs uniquement
    // Puis verifiez qu'il est utilise quand la requete filtre sur is_active = true
    //
    // Indice : CREATE INDEX idx_employees_active_dept ON employees(department) WHERE is_active = true;
    // Requete : EXPLAIN SELECT * FROM employees WHERE department = 'HR' AND is_active = true

    const result = await query(client!, "EXPLAIN SELECT * FROM employees WHERE department = 'HR' AND is_active = true");
    const plan = result.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Index') || plan.includes('Bitmap'),
      `Le plan devrait utiliser un index (partiel), recu : ${plan}`
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 11 : Comparaison temps Seq Scan vs Index Scan
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Comparaison temps Seq Scan vs Index Scan', async () => {
    // TODO 11 : Mesurez le temps d'execution avec et sans index

    // Desactiver les index pour forcer Seq Scan
    await query(client!, 'SET enable_indexscan = off');
    await query(client!, 'SET enable_bitmapscan = off');

    let seqTime: number | undefined; // <-- mesurez ici

    // Reactiver les index
    await query(client!, 'SET enable_indexscan = on');
    await query(client!, 'SET enable_bitmapscan = on');

    let idxTime: number | undefined; // <-- mesurez ici

    console.log(`    Seq Scan : ${seqTime?.toFixed(2)} ms`);
    console.log(`    Index Scan : ${idxTime?.toFixed(2)} ms`);
    // Note : sur de petites tables, la difference peut etre minime
    assert(seqTime !== undefined && idxTime !== undefined, 'Les temps devraient etre mesures');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 12 : Statistiques d'utilisation des index
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Statistiques d\'utilisation des index (pg_stat_user_indexes)', async () => {
    // TODO 12 : Consultez pg_stat_user_indexes pour voir les statistiques d'utilisation

    let result: Awaited<ReturnType<typeof query>>; // <-- remplacez

    assertGreaterThan(result!.rows.length, 0, 'Il devrait y avoir des index dans les statistiques');
    console.log('    Index trouves :');
    result!.rows.forEach((r: { indexrelname: string; idx_scan: string; idx_tup_read: string }) => {
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
