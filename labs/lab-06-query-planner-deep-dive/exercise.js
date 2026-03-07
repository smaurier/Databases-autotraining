// =============================================================================
// Lab 06 — Query Planner Deep Dive (Exercice)
// =============================================================================
// Objectifs :
//   - Identifier les types de scan (Seq, Index, Bitmap, Index Only)
//   - Comprendre les strategies de jointure (Hash, Nested Loop)
//   - Analyser les buffers et les temps
// =============================================================================

import { createTestRunner, createClient, query } from '../db-test-utils.js';

const { test, assert, assertEqual, assertGreaterThan, assertIncludes, summary } = createTestRunner('Lab 06 — Query Planner Deep Dive');

let client;

async function setupSchema(c) {
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 1 : EXPLAIN simple → Seq Scan
  // ─────────────────────────────────────────────────────────────────────────────
  await test('EXPLAIN simple — identifier Seq Scan', async () => {
    // TODO 1 : Executez EXPLAIN sur :
    //   SELECT * FROM orders WHERE status = 'livree'
    // Verifiez que le plan contient "Seq Scan" (pas d'index encore)

    let result; // <-- remplacez

    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assertIncludes(plan, 'Seq Scan', 'Sans index, le plan devrait montrer Seq Scan');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2 : Ajout d'index → Index Scan
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Ajout d\'index → transition vers Index Scan', async () => {
    // TODO 2 : Creez un index sur orders(status)
    // Puis verifiez que EXPLAIN montre Index Scan ou Bitmap Index Scan
    //
    // Indice : CREATE INDEX idx_orders_status ON orders(status);

    const result = await query(client, "EXPLAIN SELECT * FROM orders WHERE status = 'annulee'");
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Index Scan') || plan.includes('Bitmap'),
      `Le plan devrait montrer un Index Scan ou Bitmap, recu : ${plan}`
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3 : Bitmap Index Scan (plage large)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Bitmap Index Scan — plage large', async () => {
    // TODO 3 : Creez un index sur orders(order_date)
    // Puis executez EXPLAIN sur une requete avec une plage large de dates
    // qui retourne beaucoup de lignes (ex: > '2022-01-01')
    // PostgreSQL devrait choisir un Bitmap Scan ou Seq Scan (selon la selectivite)
    //
    // Indice : CREATE INDEX idx_orders_date ON orders(order_date);
    // Puis : EXPLAIN SELECT * FROM orders WHERE order_date > '2022-01-01'

    const result = await query(client, "EXPLAIN SELECT * FROM orders WHERE order_date > '2022-01-01'");
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    // Avec une plage large, PG peut choisir Bitmap Scan ou Seq Scan
    assert(
      plan.includes('Bitmap') || plan.includes('Seq Scan'),
      `Pour une large plage, le plan devrait montrer Bitmap ou Seq Scan, recu : ${plan}`
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4 : EXPLAIN un JOIN → Hash Join
  // ─────────────────────────────────────────────────────────────────────────────
  await test('EXPLAIN un JOIN — identifier Hash Join', async () => {
    // TODO 4 : Executez EXPLAIN sur un JOIN entre orders et customers
    // PostgreSQL devrait choisir un Hash Join (table customers plus petite)
    //
    // Indice : EXPLAIN SELECT o.id, c.name, o.total
    //          FROM orders o JOIN customers c ON c.id = o.customer_id

    let result; // <-- remplacez

    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assertIncludes(plan, 'Hash Join', 'Le join devrait utiliser Hash Join');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5 : Nested Loop vs Hash Join
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Comparer Nested Loop vs Hash Join', async () => {
    // TODO 5 : Desactivez Hash Join et Merge Join pour forcer Nested Loop
    // Puis comparez les couts des deux strategies
    //
    // Indice :
    //   SET enable_hashjoin = off;
    //   SET enable_mergejoin = off;
    //   ... EXPLAIN ...
    //   SET enable_hashjoin = on;
    //   SET enable_mergejoin = on;

    // Hash Join (par defaut)
    const hashResult = await query(client, `
      EXPLAIN SELECT o.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id
    `);
    const hashPlan = hashResult.rows[0]['QUERY PLAN'];
    const hashCostMatch = hashPlan.match(/cost=[\d.]+\.\.([\d.]+)/);

    // Nested Loop (force)
    // TODO : desactivez hashjoin et mergejoin, executez EXPLAIN, puis reactivez

    let nestedResult; // <-- remplacez

    // Reactivez hashjoin et mergejoin ici

    const nestedPlan = nestedResult.rows[0]['QUERY PLAN'];
    const nestedCostMatch = nestedPlan.match(/cost=[\d.]+\.\.([\d.]+)/);

    assert(hashCostMatch && nestedCostMatch, 'Les deux plans devraient avoir un cout');
    const hashCost = parseFloat(hashCostMatch[1]);
    const nestedCost = parseFloat(nestedCostMatch[1]);
    console.log(`    Hash Join cout   : ${hashCost}`);
    console.log(`    Nested Loop cout : ${nestedCost}`);
    // En general, Hash Join est moins couteux pour cette requete
    assert(hashCost > 0 && nestedCost > 0, 'Les deux couts devraient etre positifs');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6 : EXPLAIN ANALYZE avec BUFFERS
  // ─────────────────────────────────────────────────────────────────────────────
  await test('EXPLAIN ANALYZE avec BUFFERS', async () => {
    // TODO 6 : Executez EXPLAIN (ANALYZE, BUFFERS) sur une requete
    // et verifiez que le plan contient des informations de buffers
    //
    // Indice : EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE status = 'livree'
    // Le plan devrait contenir "Buffers:" ou "shared hit" ou "shared read"

    let result; // <-- remplacez

    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Buffers') || plan.includes('shared'),
      `Le plan devrait contenir des info de buffers, recu : ${plan}`
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 7 : Index Only Scan (covering index)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Index Only Scan — covering index', async () => {
    // TODO 7 : Creez un index couvrant qui contient toutes les colonnes necessaires
    // pour eviter de lire la table (Index Only Scan)
    //
    // Indice :
    //   CREATE INDEX idx_orders_covering ON orders(status, total);
    //   VACUUM orders;  -- necessaire pour mettre a jour la visibility map
    //   EXPLAIN SELECT status, total FROM orders WHERE status = 'annulee'

    const result = await query(client, "EXPLAIN SELECT status, total FROM orders WHERE status = 'annulee'");
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assertIncludes(plan, 'Index Only Scan', 'Le plan devrait montrer un Index Only Scan');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 8 : Temps de planification vs execution
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Temps de planification vs execution', async () => {
    // TODO 8 : Executez EXPLAIN ANALYZE et extrayez les temps de planification et d'execution
    // Les dernieres lignes du plan contiennent :
    //   "Planning Time: X.XXX ms"
    //   "Execution Time: X.XXX ms"

    let result; // <-- remplacez

    const plan = result.rows.map(r => r['QUERY PLAN']).join('\n');
    const planningMatch = plan.match(/Planning Time:\s+([\d.]+)\s+ms/);
    const executionMatch = plan.match(/Execution Time:\s+([\d.]+)\s+ms/);

    assert(planningMatch, 'Le plan devrait contenir le Planning Time');
    assert(executionMatch, 'Le plan devrait contenir l\'Execution Time');

    const planningTime = parseFloat(planningMatch[1]);
    const executionTime = parseFloat(executionMatch[1]);
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
