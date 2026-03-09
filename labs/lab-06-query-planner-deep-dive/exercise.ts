// =============================================================================
// Lab 06 — Query Planner Deep Dive (Exercice)
// =============================================================================
// Objectifs :
//   - Identifier les types de scan (Seq, Index, Bitmap, Index Only)
//   - Comprendre les strategies de jointure (Hash, Nested Loop)
//   - Analyser les buffers et les temps
// =============================================================================

import pg from 'pg';
import { createTestRunner, createClient, query } from '../db-test-utils.ts';

const { test, assert, assertEqual, assertGreaterThan, assertIncludes, summary } = createTestRunner('Lab 06 — Query Planner Deep Dive');

let client: pg.Client | undefined;

async function setupSchema(c: pg.Client): Promise<void> {
  await query(c, 'DROP TABLE IF EXISTS orders, customers, products CASCADE');

  await query(c, `CREATE TABLE customers (id SERIAL PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL)`);
  await query(c, `CREATE TABLE products (id SERIAL PRIMARY KEY, name TEXT NOT NULL, price NUMERIC(10,2) NOT NULL, category TEXT NOT NULL)`);
  await query(c, `
    CREATE TABLE orders (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER REFERENCES customers(id),
      product_id INTEGER REFERENCES products(id),
      quantity INTEGER NOT NULL,
      total NUMERIC(10,2) NOT NULL,
      order_date DATE NOT NULL,
      status TEXT NOT NULL
    )
  `);

  await query(c, `
    INSERT INTO customers (name, city)
    SELECT 'Client_' || i, (ARRAY['Paris', 'Lyon', 'Marseille', 'Bordeaux', 'Lille'])[1 + (i % 5)]
    FROM generate_series(1, 1000) AS i
  `);

  await query(c, `
    INSERT INTO products (name, price, category)
    SELECT 'Produit_' || i, 10 + (random() * 490)::numeric(10,2),
           (ARRAY['Electronique', 'Vetements', 'Alimentation', 'Mobilier', 'Sport'])[1 + (i % 5)]
    FROM generate_series(1, 500) AS i
  `);

  await query(c, `
    INSERT INTO orders (customer_id, product_id, quantity, total, order_date, status)
    SELECT
      1 + (random() * 999)::int,
      1 + (random() * 499)::int,
      1 + (random() * 10)::int,
      10 + (random() * 1000)::numeric(10,2),
      DATE '2020-01-01' + (random() * 1825)::int,
      (ARRAY['en_attente', 'expediee', 'livree', 'annulee'])[1 + (i % 4)]
    FROM generate_series(1, 50000) AS i
  `);

  await query(c, 'ANALYZE customers, products, orders');
}

try {
  client = await createClient();
  await setupSchema(client);

  await test('EXPLAIN simple — identifier Seq Scan', async () => {
    let result: Awaited<ReturnType<typeof query>>; // <-- remplacez

    const plan = result!.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assertIncludes(plan, 'Seq Scan', 'Sans index, le plan devrait montrer Seq Scan');
  });

  await test('Ajout d\'index → transition vers Index Scan', async () => {
    // TODO 2 : Creez un index sur orders(status)

    const result = await query(client!, "EXPLAIN SELECT * FROM orders WHERE status = 'annulee'");
    const plan = result.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Index Scan') || plan.includes('Bitmap'),
      `Le plan devrait montrer un Index Scan ou Bitmap, recu : ${plan}`
    );
  });

  await test('Bitmap Index Scan — plage large', async () => {
    // TODO 3 : Creez un index sur orders(order_date)

    const result = await query(client!, "EXPLAIN SELECT * FROM orders WHERE order_date > '2022-01-01'");
    const plan = result.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Bitmap') || plan.includes('Seq Scan'),
      `Pour une large plage, le plan devrait montrer Bitmap ou Seq Scan, recu : ${plan}`
    );
  });

  await test('EXPLAIN un JOIN — identifier Hash Join', async () => {
    let result: Awaited<ReturnType<typeof query>>; // <-- remplacez

    const plan = result!.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assertIncludes(plan, 'Hash Join', 'Le join devrait utiliser Hash Join');
  });

  await test('Comparer Nested Loop vs Hash Join', async () => {
    const hashResult = await query(client!, `
      EXPLAIN SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id
    `);
    const hashPlan = hashResult.rows[0]['QUERY PLAN'];
    const hashCostMatch = hashPlan.match(/cost=[\d.]+\.\.([\d.]+)/);

    // TODO : desactivez hashjoin et mergejoin, executez EXPLAIN, puis reactivez

    let nestedResult: Awaited<ReturnType<typeof query>>; // <-- remplacez

    const nestedPlan = nestedResult!.rows[0]['QUERY PLAN'];
    const nestedCostMatch = nestedPlan.match(/cost=[\d.]+\.\.([\d.]+)/);

    assert(hashCostMatch && nestedCostMatch, 'Les deux plans devraient avoir un cout');
    const hashCost = parseFloat(hashCostMatch![1]);
    const nestedCost = parseFloat(nestedCostMatch![1]);
    console.log(`    Hash Join cout   : ${hashCost}`);
    console.log(`    Nested Loop cout : ${nestedCost}`);
    assert(hashCost > 0 && nestedCost > 0, 'Les deux couts devraient etre positifs');
  });

  await test('EXPLAIN ANALYZE avec BUFFERS', async () => {
    let result: Awaited<ReturnType<typeof query>>; // <-- remplacez

    const plan = result!.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Buffers') || plan.includes('shared'),
      `Le plan devrait contenir des info de buffers, recu : ${plan}`
    );
  });

  await test('Index Only Scan — covering index', async () => {
    // TODO 7 : Creez un index couvrant

    const result = await query(client!, "EXPLAIN SELECT status, total FROM orders WHERE status = 'annulee'");
    const plan = result.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join(' ');
    assertIncludes(plan, 'Index Only Scan', 'Le plan devrait montrer un Index Only Scan');
  });

  await test('Temps de planification vs execution', async () => {
    let result: Awaited<ReturnType<typeof query>>; // <-- remplacez

    const plan = result!.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n');
    const planningMatch = plan.match(/Planning Time:\s+([\d.]+)\s+ms/);
    const executionMatch = plan.match(/Execution Time:\s+([\d.]+)\s+ms/);

    assert(planningMatch, 'Le plan devrait contenir le Planning Time');
    assert(executionMatch, 'Le plan devrait contenir l\'Execution Time');

    const planningTime = parseFloat(planningMatch![1]);
    const executionTime = parseFloat(executionMatch![1]);
    console.log(`    Planning Time  : ${planningTime} ms`);
    console.log(`    Execution Time : ${executionTime} ms`);
    assertGreaterThan(executionTime, 0, 'Le temps d\'execution devrait etre > 0');
  });

} finally {
  if (client) {
    await query(client, 'SET enable_hashjoin = on');
    await query(client, 'SET enable_mergejoin = on');
    await query(client, 'DROP TABLE IF EXISTS orders, customers, products CASCADE');
    await client.end();
  }
  summary();
}
