// =============================================================================
// Lab 07 — Index GIN, GiST et BRIN (Solution)
// =============================================================================
// 10 tests couvrant GIN (JSONB, tableaux, full-text), BRIN (timestamps),
// GiST (ranges) et comparaisons de performances.
// =============================================================================

import pg from 'pg';
import { createTestRunner, createClient, query, measure } from '../db-test-utils.ts';

const { test, assert, assertEqual, assertGreaterThan, assertLessThan, assertIncludes, summary } = createTestRunner('Lab 07 — Index GIN/GiST/BRIN');

let client: pg.Client | undefined;

async function setupSchema(c: pg.Client): Promise<void> {
  await query(c, 'DROP TABLE IF EXISTS products_json, events, tags_table, time_ranges CASCADE');

  await query(c, `
    CREATE TABLE products_json (
      id   SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      data JSONB NOT NULL
    )
  `);

  await query(c, `
    CREATE TABLE events (
      id         SERIAL PRIMARY KEY,
      event_name TEXT NOT NULL,
      event_time TIMESTAMPTZ NOT NULL,
      metadata   JSONB
    )
  `);

  await query(c, `
    CREATE TABLE tags_table (
      id   SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      tags TEXT[] NOT NULL
    )
  `);

  await query(c, `
    CREATE TABLE time_ranges (
      id      SERIAL PRIMARY KEY,
      label   TEXT NOT NULL,
      period  TSRANGE NOT NULL
    )
  `);

  // 10 000 produits JSONB
  await query(c, `
    INSERT INTO products_json (name, data)
    SELECT
      'Produit_' || i,
      jsonb_build_object(
        'category', (ARRAY['electronique', 'vetements', 'alimentation', 'sport', 'mobilier'])[1 + (i % 5)],
        'price', 10 + (random() * 490)::int,
        'tags', to_jsonb(ARRAY[
          (ARRAY['promo', 'nouveau', 'populaire', 'solde', 'exclusif'])[1 + (i % 5)],
          (ARRAY['qualite', 'eco', 'premium', 'basique', 'luxe'])[1 + ((i+2) % 5)]
        ]),
        'rating', (1 + random() * 4)::numeric(2,1),
        'in_stock', (random() > 0.3)
      )
    FROM generate_series(1, 10000) AS i
  `);

  // 100 000 evenements sequentiels
  await query(c, `
    INSERT INTO events (event_name, event_time, metadata)
    SELECT
      'event_type_' || (i % 10),
      TIMESTAMP '2020-01-01' + (i || ' minutes')::interval,
      jsonb_build_object('source', 'app_' || (i % 5), 'level', (ARRAY['info', 'warn', 'error'])[1 + (i % 3)])
    FROM generate_series(1, 100000) AS i
  `);

  // 5 000 elements avec tags
  await query(c, `
    INSERT INTO tags_table (name, tags)
    SELECT
      'Item_' || i,
      ARRAY[
        (ARRAY['javascript', 'python', 'rust', 'go', 'java'])[1 + (i % 5)],
        (ARRAY['web', 'mobile', 'backend', 'devops', 'data'])[1 + ((i+1) % 5)],
        (ARRAY['debutant', 'intermediaire', 'avance'])[1 + (i % 3)]
      ]
    FROM generate_series(1, 5000) AS i
  `);

  // 1 000 ranges de temps
  await query(c, `
    INSERT INTO time_ranges (label, period)
    SELECT
      'Reservation_' || i,
      tsrange(
        TIMESTAMP '2024-01-01' + ((i * 3) || ' hours')::interval,
        TIMESTAMP '2024-01-01' + (((i * 3) + 1 + (random() * 5)::int) || ' hours')::interval
      )
    FROM generate_series(1, 1000) AS i
  `);

  await query(c, 'ANALYZE products_json, events, tags_table, time_ranges');
}

try {
  client = await createClient();
  await setupSchema(client);

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 1 : JSONB sans GIN → Seq Scan
  // ─────────────────────────────────────────────────────────────────────────────
  await test('JSONB contenance sans index → Seq Scan', async () => {
    const result = await query(client, `
      EXPLAIN SELECT * FROM products_json WHERE data @> '{"category": "electronique"}'
    `);
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assertIncludes(plan, 'Seq Scan', 'Sans GIN, JSONB devrait utiliser Seq Scan');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2 : GIN sur JSONB → Index Scan avec @>
  // ─────────────────────────────────────────────────────────────────────────────
  await test('GIN sur JSONB → utilisation avec @>', async () => {
    await query(client, 'CREATE INDEX idx_products_data_gin ON products_json USING gin(data)');
    await query(client, 'ANALYZE products_json');

    const result = await query(client, `
      EXPLAIN SELECT * FROM products_json WHERE data @> '{"category": "electronique"}'
    `);
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Bitmap Heap Scan') || plan.includes('Index Scan'),
      `Avec GIN, la requete devrait utiliser un index, recu : ${plan}`
    );
    console.log('    Plan :', result.rows[0]['QUERY PLAN']);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3 : GIN + operateur ? (existence de cle)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('GIN + operateur ? (existence de cle JSONB)', async () => {
    const result = await query(client, `
      EXPLAIN SELECT * FROM products_json WHERE data ? 'rating'
    `);
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Bitmap') || plan.includes('Index'),
      `L'operateur ? devrait utiliser l'index GIN, recu : ${plan}`
    );
    console.log('    Plan :', result.rows[0]['QUERY PLAN']);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4 : BRIN sur events(event_time)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('BRIN sur events(event_time) — scan de plage', async () => {
    await query(client, 'CREATE INDEX idx_events_time_brin ON events USING brin(event_time)');
    await query(client, 'ANALYZE events');

    const result = await query(client, `
      EXPLAIN SELECT * FROM events WHERE event_time BETWEEN '2024-01-01' AND '2024-02-01'
    `);
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Bitmap Heap Scan') || plan.includes('Bitmap Index Scan'),
      `BRIN devrait etre utilise pour la plage de temps, recu : ${plan}`
    );
    console.log('    Plan :', result.rows[0]['QUERY PLAN']);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5 : Comparaison taille BRIN vs B-tree
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Comparaison taille BRIN vs B-tree', async () => {
    await query(client, 'CREATE INDEX idx_events_time_btree ON events(event_time)');
    await query(client, 'ANALYZE events');

    const result = await query(client, `
      SELECT pg_relation_size('idx_events_time_brin') AS brin_size,
             pg_relation_size('idx_events_time_btree') AS btree_size
    `);

    const brinSize = parseInt(result.rows[0].brin_size);
    const btreeSize = parseInt(result.rows[0].btree_size);
    console.log(`    BRIN   : ${(brinSize / 1024).toFixed(1)} KB`);
    console.log(`    B-tree : ${(btreeSize / 1024).toFixed(1)} KB`);
    assertLessThan(brinSize, btreeSize, 'L\'index BRIN devrait etre plus petit que le B-tree');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6 : GIN sur tableau TEXT[] avec @>
  // ─────────────────────────────────────────────────────────────────────────────
  await test('GIN sur tableau TEXT[] avec @>', async () => {
    await query(client, 'CREATE INDEX idx_tags_gin ON tags_table USING gin(tags)');
    await query(client, 'ANALYZE tags_table');

    const result = await query(client, "EXPLAIN SELECT * FROM tags_table WHERE tags @> ARRAY['python']");
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Bitmap') || plan.includes('Index'),
      `GIN devrait etre utilise pour la recherche de tags, recu : ${plan}`
    );
    console.log('    Plan :', result.rows[0]['QUERY PLAN']);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 7 : GiST sur tsrange (chevauchement &&)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('GiST sur tsrange — chevauchement (&&)', async () => {
    await query(client, 'CREATE INDEX idx_time_ranges_gist ON time_ranges USING gist(period)');
    await query(client, 'ANALYZE time_ranges');

    const result = await query(client, `
      EXPLAIN SELECT * FROM time_ranges
      WHERE period && tsrange('2024-01-15', '2024-01-20')
    `);
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Index Scan') || plan.includes('Bitmap'),
      `GiST devrait etre utilise pour le chevauchement de ranges, recu : ${plan}`
    );
    console.log('    Plan :', result.rows[0]['QUERY PLAN']);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 8 : Comparaison performances
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Comparaison performances : no index vs GIN vs B-tree', async () => {
    // Seq Scan force
    await query(client, 'SET enable_indexscan = off');
    await query(client, 'SET enable_bitmapscan = off');
    const { duration: noIndexTime } = await measure(async () => {
      await query(client, `SELECT * FROM products_json WHERE data @> '{"category": "electronique"}'`);
    });
    await query(client, 'SET enable_indexscan = on');
    await query(client, 'SET enable_bitmapscan = on');

    // GIN
    const { duration: ginTime } = await measure(async () => {
      await query(client, `SELECT * FROM products_json WHERE data @> '{"category": "electronique"}'`);
    });

    // B-tree sur expression extraite
    await query(client, `CREATE INDEX idx_products_category_btree ON products_json ((data->>'category'))`);
    await query(client, 'ANALYZE products_json');
    const { duration: btreeTime } = await measure(async () => {
      await query(client, `SELECT * FROM products_json WHERE data->>'category' = 'electronique'`);
    });

    console.log(`    Sans index : ${noIndexTime.toFixed(2)} ms`);
    console.log(`    GIN        : ${ginTime.toFixed(2)} ms`);
    console.log(`    B-tree     : ${btreeTime.toFixed(2)} ms`);
    assert(noIndexTime >= 0 && ginTime >= 0 && btreeTime >= 0, 'Les temps devraient etre mesures');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 9 : Full-text search avec GIN
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Full-text search avec GIN', async () => {
    // Ajout d'une colonne tsvector
    await query(client, 'ALTER TABLE products_json ADD COLUMN IF NOT EXISTS search_vector TSVECTOR');
    await query(client, `
      UPDATE products_json
      SET search_vector = to_tsvector('french', name || ' ' || (data->>'category'))
    `);
    await query(client, 'CREATE INDEX idx_products_fts ON products_json USING gin(search_vector)');
    await query(client, 'ANALYZE products_json');

    const result = await query(client, `
      EXPLAIN SELECT * FROM products_json WHERE search_vector @@ to_tsquery('french', 'electronique')
    `);
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Bitmap') || plan.includes('Index'),
      `Le full-text search devrait utiliser l'index GIN, recu : ${plan}`
    );
    console.log('    Plan :', result.rows[0]['QUERY PLAN']);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 10 : GIN partiel sur JSONB
  // ─────────────────────────────────────────────────────────────────────────────
  await test('GIN partiel sur JSONB (WHERE condition)', async () => {
    await query(client, `
      CREATE INDEX idx_products_instock_gin ON products_json USING gin(data)
      WHERE (data->>'in_stock')::boolean = true
    `);
    await query(client, 'ANALYZE products_json');

    const result = await query(client, `
      EXPLAIN SELECT * FROM products_json
      WHERE data @> '{"category": "sport"}' AND (data->>'in_stock')::boolean = true
    `);
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Bitmap') || plan.includes('Index'),
      `Le GIN partiel devrait etre utilise, recu : ${plan}`
    );
    console.log('    Plan :', result.rows[0]['QUERY PLAN']);
  });

} finally {
  if (client) {
    await query(client, 'SET enable_indexscan = on');
    await query(client, 'SET enable_bitmapscan = on');
    await query(client, 'DROP TABLE IF EXISTS products_json, events, tags_table, time_ranges CASCADE');
    await client.end();
  }
  summary();
}
