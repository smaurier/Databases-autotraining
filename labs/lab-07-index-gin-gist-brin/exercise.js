// =============================================================================
// Lab 07 — Index GIN, GiST et BRIN (Exercice)
// =============================================================================
// Objectifs :
//   - Index GIN pour JSONB, tableaux, full-text search
//   - Index BRIN pour donnees sequentielles
//   - Index GiST pour ranges
//   - Comparaison de tailles et performances
// =============================================================================

import { createTestRunner, createClient, query, measure } from '../db-test-utils.js';

const { test, assert, assertEqual, assertGreaterThan, assertLessThan, assertIncludes, summary } = createTestRunner('Lab 07 — Index GIN/GiST/BRIN');

let client;

async function setupSchema(c) {
  await query(c, 'DROP TABLE IF EXISTS products_json, events, tags_table, time_ranges CASCADE');

  // Table produits avec JSONB
  await query(c, `
    CREATE TABLE products_json (
      id   SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      data JSONB NOT NULL
    )
  `);

  // Table evenements avec timestamps sequentiels
  await query(c, `
    CREATE TABLE events (
      id         SERIAL PRIMARY KEY,
      event_name TEXT NOT NULL,
      event_time TIMESTAMPTZ NOT NULL,
      metadata   JSONB
    )
  `);

  // Table avec tags (tableau de texte)
  await query(c, `
    CREATE TABLE tags_table (
      id   SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      tags TEXT[] NOT NULL
    )
  `);

  // Table pour les ranges (GiST)
  await query(c, `
    CREATE TABLE time_ranges (
      id      SERIAL PRIMARY KEY,
      label   TEXT NOT NULL,
      period  TSRANGE NOT NULL
    )
  `);

  // ─── Insertion des donnees ──────────────────────────────────────────────────

  // 10 000 produits avec JSONB varie
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

  // 100 000 evenements avec timestamps sequentiels
  await query(c, `
    INSERT INTO events (event_name, event_time, metadata)
    SELECT
      'event_type_' || (i % 10),
      TIMESTAMP '2020-01-01' + (i || ' minutes')::interval,
      jsonb_build_object('source', 'app_' || (i % 5), 'level', (ARRAY['info', 'warn', 'error'])[1 + (i % 3)])
    FROM generate_series(1, 100000) AS i
  `);

  // 5 000 elements avec tags (tableau)
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
    // TODO 1 : Executez EXPLAIN sur une requete de contenance JSONB (@>)
    // Requete : SELECT * FROM products_json WHERE data @> '{"category": "electronique"}'
    // Verifiez que c'est un Seq Scan (pas d'index GIN)

    let result; // <-- remplacez

    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assertIncludes(plan, 'Seq Scan', 'Sans GIN, JSONB devrait utiliser Seq Scan');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2 : GIN sur JSONB → Index Scan avec @>
  // ─────────────────────────────────────────────────────────────────────────────
  await test('GIN sur JSONB → utilisation avec @>', async () => {
    // TODO 2 : Creez un index GIN sur la colonne data, puis verifiez
    // Indice : CREATE INDEX idx_products_data_gin ON products_json USING gin(data);

    const result = await query(client, `
      EXPLAIN SELECT * FROM products_json WHERE data @> '{"category": "electronique"}'
    `);
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Bitmap Heap Scan') || plan.includes('Index Scan'),
      `Avec GIN, la requete devrait utiliser un index, recu : ${plan}`
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3 : GIN + operateur ? (existence de cle)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('GIN + operateur ? (existence de cle JSONB)', async () => {
    // TODO 3 : Verifiez que l'index GIN fonctionne aussi avec l'operateur ?
    // Requete : SELECT * FROM products_json WHERE data ? 'rating'
    // L'index GIN sur jsonb supporte @>, ?, ?|, ?& et d'autres operateurs

    let result; // <-- remplacez

    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Bitmap') || plan.includes('Index'),
      `L'operateur ? devrait utiliser l'index GIN, recu : ${plan}`
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4 : BRIN sur events(event_time)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('BRIN sur events(event_time) — scan de plage', async () => {
    // TODO 4 : Creez un index BRIN sur event_time
    // Les donnees sont inserees dans l'ordre chronologique = ideal pour BRIN
    // Indice : CREATE INDEX idx_events_time_brin ON events USING brin(event_time);

    const result = await query(client, `
      EXPLAIN SELECT * FROM events WHERE event_time BETWEEN '2024-01-01' AND '2024-02-01'
    `);
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Bitmap Heap Scan') || plan.includes('Bitmap Index Scan'),
      `BRIN devrait etre utilise pour la plage de temps, recu : ${plan}`
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5 : Comparaison taille BRIN vs B-tree
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Comparaison taille BRIN vs B-tree', async () => {
    // TODO 5 : Creez un index B-tree sur la meme colonne et comparez les tailles
    // Indice : CREATE INDEX idx_events_time_btree ON events(event_time);
    // Taille : SELECT pg_relation_size('idx_events_time_brin') AS brin_size,
    //                 pg_relation_size('idx_events_time_btree') AS btree_size

    let result; // <-- remplacez

    const brinSize = parseInt(result.rows[0].brin_size);
    const btreeSize = parseInt(result.rows[0].btree_size);
    console.log(`    BRIN  : ${(brinSize / 1024).toFixed(1)} KB`);
    console.log(`    B-tree : ${(btreeSize / 1024).toFixed(1)} KB`);
    assertLessThan(brinSize, btreeSize, 'L\'index BRIN devrait etre plus petit que le B-tree');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6 : GIN sur tableau TEXT[] avec @>
  // ─────────────────────────────────────────────────────────────────────────────
  await test('GIN sur tableau TEXT[] avec @>', async () => {
    // TODO 6 : Creez un index GIN sur la colonne tags (TEXT[])
    // Puis verifiez qu'il est utilise pour une recherche de contenance
    // Indice : CREATE INDEX idx_tags_gin ON tags_table USING gin(tags);
    // Requete : SELECT * FROM tags_table WHERE tags @> ARRAY['python']

    const result = await query(client, "EXPLAIN SELECT * FROM tags_table WHERE tags @> ARRAY['python']");
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Bitmap') || plan.includes('Index'),
      `GIN devrait etre utilise pour la recherche de tags, recu : ${plan}`
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 7 : GiST sur tsrange (chevauchement &&)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('GiST sur tsrange — chevauchement (&&)', async () => {
    // TODO 7 : Creez un index GiST sur la colonne period (TSRANGE)
    // Puis verifiez qu'il est utilise pour une requete de chevauchement
    // Indice : CREATE INDEX idx_time_ranges_gist ON time_ranges USING gist(period);
    // Requete : EXPLAIN SELECT * FROM time_ranges
    //           WHERE period && tsrange('2024-01-15', '2024-01-20')

    const result = await query(client, `
      EXPLAIN SELECT * FROM time_ranges
      WHERE period && tsrange('2024-01-15', '2024-01-20')
    `);
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Index Scan') || plan.includes('Bitmap'),
      `GiST devrait etre utilise pour le chevauchement de ranges, recu : ${plan}`
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 8 : Comparaison performances
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Comparaison performances : no index vs GIN vs B-tree', async () => {
    // TODO 8 : Comparez les temps d'execution de 3 approches pour chercher dans JSONB
    // a) Sans index (desactivez les index)
    // b) Avec GIN (notre index existant)
    // c) Avec B-tree sur une colonne extraite
    //
    // Pour B-tree : CREATE INDEX idx_products_category_btree
    //   ON products_json ((data->>'category'));
    // Requete B-tree : WHERE data->>'category' = 'electronique'
    //
    // Utilisez measure() pour les temps

    // Seq Scan (desactiver les index)
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

    // B-tree sur expression
    // TODO : creez l'index B-tree sur expression et mesurez

    let btreeTime = 0; // <-- remplacez

    console.log(`    Sans index : ${noIndexTime.toFixed(2)} ms`);
    console.log(`    GIN        : ${ginTime.toFixed(2)} ms`);
    console.log(`    B-tree     : ${btreeTime.toFixed ? btreeTime.toFixed(2) : btreeTime} ms`);
    assert(noIndexTime >= 0 && ginTime >= 0, 'Les temps devraient etre mesures');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 9 : Full-text search avec GIN
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Full-text search avec GIN', async () => {
    // TODO 9 : Ajoutez une colonne tsvector et creez un index GIN pour le full-text search
    // 1. ALTER TABLE products_json ADD COLUMN search_vector TSVECTOR;
    // 2. UPDATE products_json SET search_vector = to_tsvector('french', name || ' ' || (data->>'category'));
    // 3. CREATE INDEX idx_products_fts ON products_json USING gin(search_vector);
    // 4. EXPLAIN SELECT * FROM products_json WHERE search_vector @@ to_tsquery('french', 'electronique')

    const result = await query(client, `
      EXPLAIN SELECT * FROM products_json WHERE search_vector @@ to_tsquery('french', 'electronique')
    `);
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Bitmap') || plan.includes('Index'),
      `Le full-text search devrait utiliser l'index GIN, recu : ${plan}`
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 10 : GIN partiel sur JSONB
  // ─────────────────────────────────────────────────────────────────────────────
  await test('GIN partiel sur JSONB (WHERE condition)', async () => {
    // TODO 10 : Creez un index GIN partiel sur les produits en stock uniquement
    // Indice : CREATE INDEX idx_products_instock_gin ON products_json USING gin(data)
    //          WHERE (data->>'in_stock')::boolean = true;
    // Verifiez que EXPLAIN utilise cet index quand la condition correspond

    const result = await query(client, `
      EXPLAIN SELECT * FROM products_json
      WHERE data @> '{"category": "sport"}' AND (data->>'in_stock')::boolean = true
    `);
    const plan = result.rows.map(r => r['QUERY PLAN']).join(' ');
    assert(
      plan.includes('Bitmap') || plan.includes('Index'),
      `Le GIN partiel devrait etre utilise, recu : ${plan}`
    );
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
