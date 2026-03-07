// =============================================================================
// Lab 05 — Index & EXPLAIN — Etape 1 : EXPLAIN basique (Exercice)
// =============================================================================
// Objectifs :
//   - Comprendre EXPLAIN et EXPLAIN ANALYZE
//   - Observer les Seq Scans
//   - Extraire les couts et comparer estimations vs realite
// =============================================================================

import { createTestRunner, createClient, query } from '../db-test-utils.js';

const { test, assert, assertEqual, assertGreaterThan, assertIncludes, summary } = createTestRunner('Lab 05 — Etape 1 : EXPLAIN basique');

let client;

// ─────────────────────────────────────────────────────────────────────────────
// Helper : genere le schema et les donnees de test
// ─────────────────────────────────────────────────────────────────────────────
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

  // Insertion de 10 000 employes
  const departments = ['Engineering', 'Marketing', 'Sales', 'HR', 'Finance'];
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

  // On force l'analyse des statistiques
  await query(c, 'ANALYZE employees');
}

try {
  client = await createClient();
  await setupSchema(client);

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 1 : EXPLAIN simple
  // ─────────────────────────────────────────────────────────────────────────────
  await test('EXPLAIN simple — observer le plan', async () => {
    // TODO 1 : Executez EXPLAIN sur la requete :
    //   SELECT * FROM employees WHERE department = 'Engineering'
    // Stockez le resultat dans "result"
    // Indice : EXPLAIN retourne le plan dans result.rows, chaque ligne a un champ "QUERY PLAN"

    let result; // <-- remplacez

    assert(result.rows.length > 0, 'EXPLAIN devrait retourner un plan');
    console.log('    Plan :', result.rows.map(r => r['QUERY PLAN']).join('\n    '));
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2 : Verifier Seq Scan (pas d'index)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Verification du Seq Scan (sans index)', async () => {
    // TODO 2 : Executez EXPLAIN et verifiez que le plan contient "Seq Scan"
    // Indice : concatenez toutes les lignes du plan et cherchez "Seq Scan"

    let result; // <-- remplacez

    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assertIncludes(plan, 'Seq Scan', 'Sans index, PostgreSQL devrait utiliser un Seq Scan');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3 : EXPLAIN ANALYZE (temps reels)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('EXPLAIN ANALYZE — temps reels', async () => {
    // TODO 3 : Executez EXPLAIN ANALYZE sur la meme requete
    // EXPLAIN ANALYZE execute reellement la requete et retourne les temps
    // Indice : le plan devrait contenir "actual time" et "rows"

    let result; // <-- remplacez

    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assertIncludes(plan, 'actual time', 'EXPLAIN ANALYZE devrait montrer les temps reels');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4 : Extraire le cout du plan
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Extraction du cout du plan', async () => {
    // TODO 4 : Executez EXPLAIN et extrayez le cout total
    // Le format est "cost=0.00..XXX.XX" dans la premiere ligne du plan
    // Indice : utilisez une regex pour extraire le cout
    //   const match = planLine.match(/cost=[\d.]+\.\.([\d.]+)/);
    //   const totalCost = parseFloat(match[1]);

    let result; // <-- remplacez

    const planLine = result.rows[0]['QUERY PLAN'];
    const match = planLine.match(/cost=[\d.]+\.\.([\d.]+)/);
    assert(match, 'Le plan devrait contenir un cout');
    const totalCost = parseFloat(match[1]);
    assertGreaterThan(totalCost, 0, 'Le cout devrait etre > 0');
    console.log(`    Cout total : ${totalCost}`);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5 : Comparer lignes estimees vs reelles
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Comparaison lignes estimees vs reelles', async () => {
    // TODO 5 : Executez EXPLAIN ANALYZE et comparez les lignes estimees et reelles
    // Format dans le plan : "rows=XXXX" (estime) et "actual ... rows=XXXX" (reel)
    // Indice :
    //   const estimatedMatch = planLine.match(/rows=(\d+)/);
    //   const actualMatch = planLine.match(/actual.*rows=(\d+)/);

    let result; // <-- remplacez

    const planLine = result.rows[0]['QUERY PLAN'];
    const estimatedMatch = planLine.match(/rows=(\d+)/);
    const actualMatch = planLine.match(/actual.*rows=(\d+)/);
    assert(estimatedMatch, 'Le plan devrait contenir les lignes estimees');
    assert(actualMatch, 'EXPLAIN ANALYZE devrait contenir les lignes reelles');
    console.log(`    Lignes estimees : ${estimatedMatch[1]}`);
    console.log(`    Lignes reelles  : ${actualMatch[1]}`);
  });

} finally {
  if (client) {
    await query(client, 'DROP TABLE IF EXISTS employees');
    await client.end();
  }
  summary();
}
