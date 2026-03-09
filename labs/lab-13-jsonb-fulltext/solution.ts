// =============================================================================
// Lab 13 — JSONB & Full-Text Search (Solution)
// =============================================================================

import pg from 'pg';
import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.ts';

const { test, assert, assertEqual, assertIncludes, assertGreaterThan, assertLessThan, summary } = createTestRunner('Lab 13 — JSONB & Full-Text Search');

// ---------------------------------------------------------------------------
// Schema et donnees de test
// ---------------------------------------------------------------------------
const SCHEMA_SQL = `
  DROP TABLE IF EXISTS products CASCADE;

  CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    specs JSONB NOT NULL DEFAULT '{}',
    tags TEXT[] DEFAULT '{}',
    search_vector TSVECTOR GENERATED ALWAYS AS (
      to_tsvector('french', name || ' ' || description)
    ) STORED
  );
`;

// Generer 1000 produits avec des donnees variees en francais
const SEED_SQL = `
  INSERT INTO products (name, description, specs, tags)
  SELECT
    CASE (g % 10)
      WHEN 0 THEN 'Ordinateur portable Pro ' || g
      WHEN 1 THEN 'Ecran ultra-large ' || g
      WHEN 2 THEN 'Clavier mecanique RGB ' || g
      WHEN 3 THEN 'Souris ergonomique ' || g
      WHEN 4 THEN 'Casque audio sans fil ' || g
      WHEN 5 THEN 'Webcam haute definition ' || g
      WHEN 6 THEN 'Station d''accueil USB-C ' || g
      WHEN 7 THEN 'Disque SSD externe ' || g
      WHEN 8 THEN 'Tablette graphique ' || g
      WHEN 9 THEN 'Imprimante laser couleur ' || g
    END,
    CASE (g % 10)
      WHEN 0 THEN 'Ordinateur portable performant pour les professionnels et developpeurs, avec processeur rapide et ecran haute resolution'
      WHEN 1 THEN 'Ecran large haute resolution pour le travail de bureau et le graphisme professionnel, avec couleurs fideles'
      WHEN 2 THEN 'Clavier mecanique retroeclaire avec touches programmables pour les joueurs et les developpeurs exigeants'
      WHEN 3 THEN 'Souris ergonomique confortable pour une utilisation prolongee au bureau, avec capteur precision'
      WHEN 4 THEN 'Casque audio premium avec reduction de bruit active et connexion sans fil Bluetooth'
      WHEN 5 THEN 'Webcam full HD avec autofocus et microphone integre pour les visioconferences professionnelles'
      WHEN 6 THEN 'Station d''accueil universelle avec ports USB-C, HDMI, Ethernet pour transformer votre portable'
      WHEN 7 THEN 'Disque SSD externe rapide et compact pour le stockage et la sauvegarde de vos donnees importantes'
      WHEN 8 THEN 'Tablette graphique sensible a la pression pour les artistes et designers professionnels'
      WHEN 9 THEN 'Imprimante laser rapide et economique pour les documents couleur de haute qualite au bureau'
    END,
    CASE (g % 10)
      WHEN 0 THEN jsonb_build_object('marque', 'TechPro', 'ram', (8 + (g % 4) * 8)::text || ' Go', 'stockage', (256 + (g % 4) * 256)::text || ' Go', 'poids', round((1.2 + random())::numeric, 1)::text || ' kg', 'processeur', 'Intel i' || (5 + g % 4))
      WHEN 1 THEN jsonb_build_object('marque', 'ScreenMax', 'taille', (24 + (g % 4) * 3)::text || ' pouces', 'resolution', CASE WHEN g % 2 = 0 THEN '4K' ELSE '1440p' END, 'dalle', CASE WHEN g % 3 = 0 THEN 'IPS' WHEN g % 3 = 1 THEN 'VA' ELSE 'OLED' END)
      WHEN 2 THEN jsonb_build_object('marque', 'KeyForce', 'type', 'mecanique', 'switches', CASE WHEN g % 3 = 0 THEN 'Cherry MX Red' WHEN g % 3 = 1 THEN 'Cherry MX Blue' ELSE 'Cherry MX Brown' END, 'retroeclairage', 'RGB')
      WHEN 3 THEN jsonb_build_object('marque', 'ErgoMouse', 'dpi', (800 + (g % 5) * 400)::text, 'boutons', (5 + g % 4)::text, 'sans_fil', g % 2 = 0)
      WHEN 4 THEN jsonb_build_object('marque', 'SoundElite', 'type', 'circumaural', 'anc', true, 'bluetooth', '5.' || (g % 3), 'autonomie', (20 + g % 20)::text || 'h')
      WHEN 5 THEN jsonb_build_object('marque', 'CamPro', 'resolution', '1080p', 'fps', (30 + (g % 2) * 30)::text, 'autofocus', true)
      WHEN 6 THEN jsonb_build_object('marque', 'DockIt', 'ports_usb', (3 + g % 4)::text, 'hdmi', true, 'ethernet', true, 'puissance', (60 + (g % 3) * 30)::text || 'W')
      WHEN 7 THEN jsonb_build_object('marque', 'SpeedStore', 'capacite', (500 + (g % 4) * 500)::text || ' Go', 'interface', 'USB-C', 'vitesse_lecture', (500 + g % 500)::text || ' Mo/s')
      WHEN 8 THEN jsonb_build_object('marque', 'ArtPad', 'taille', CASE WHEN g % 3 = 0 THEN 'S' WHEN g % 3 = 1 THEN 'M' ELSE 'L' END, 'niveaux_pression', '8192', 'ecran', g % 2 = 0)
      WHEN 9 THEN jsonb_build_object('marque', 'PrintFast', 'type', 'laser', 'couleur', true, 'recto_verso', g % 2 = 0, 'vitesse', (20 + g % 20)::text || ' ppm')
    END,
    CASE (g % 10)
      WHEN 0 THEN ARRAY['informatique', 'portable', 'professionnel']
      WHEN 1 THEN ARRAY['informatique', 'ecran', 'bureau']
      WHEN 2 THEN ARRAY['informatique', 'peripherique', 'gaming']
      WHEN 3 THEN ARRAY['informatique', 'peripherique', 'ergonomie']
      WHEN 4 THEN ARRAY['audio', 'sans-fil', 'bluetooth']
      WHEN 5 THEN ARRAY['informatique', 'video', 'visioconference']
      WHEN 6 THEN ARRAY['informatique', 'connectique', 'usb-c']
      WHEN 7 THEN ARRAY['informatique', 'stockage', 'ssd']
      WHEN 8 THEN ARRAY['creatif', 'design', 'tablette']
      WHEN 9 THEN ARRAY['bureau', 'impression', 'laser']
    END
  FROM generate_series(1, 1000) g;
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function run(): Promise<void> {
  const client = await createClient();

  try {
    console.log('\n🔍 Lab 13 — JSONB & Full-Text Search\n');
    console.log('  Preparation du schema et des donnees (1000 produits)...');
    await setupDatabase(client, SCHEMA_SQL);
    await setupDatabase(client, SEED_SQL);
    console.log('  Donnees pretes !\n');

    // -----------------------------------------------------------------------
    // Test 1 : JSONB -> et ->> pour extraire des valeurs
    // -----------------------------------------------------------------------
    await test('JSONB -> et ->> pour extraire des valeurs', async () => {
      const res = await query(client, `
        SELECT
          name,
          specs->'marque' AS marque_json,
          specs->>'marque' AS marque_text
        FROM products
        LIMIT 5
      `);

      assertEqual(res.rows.length, 5, 'Doit retourner 5 resultats');

      for (const row of res.rows) {
        assert(row.marque_text !== null, 'La marque ne doit pas etre null');
        // -> retourne du JSON (avec guillemets), ->> retourne du texte
        assert(typeof row.marque_text === 'string', '->> doit retourner une chaine');
      }
    });

    // -----------------------------------------------------------------------
    // Test 2 : JSONB @> (containment) pour trouver des produits
    // -----------------------------------------------------------------------
    await test('JSONB @> pour trouver des produits avec specs specifiques', async () => {
      const res = await query(client, `
        SELECT * FROM products
        WHERE specs @> '{"marque": "TechPro"}'
      `);

      assertGreaterThan(res.rows.length, 0, 'Doit trouver des produits TechPro');

      // Verifier que chaque resultat a bien la marque TechPro
      for (const row of res.rows) {
        assertEqual(row.specs.marque, 'TechPro',
          'Chaque produit doit avoir marque = TechPro');
      }
      console.log(`     → ${res.rows.length} produits TechPro trouves`);
    });

    // -----------------------------------------------------------------------
    // Test 3 : JSONB ? pour verifier l'existence d'une cle
    // -----------------------------------------------------------------------
    await test('JSONB ? pour verifier l\'existence d\'une cle', async () => {
      // Produits avec la cle 'bluetooth' (casques audio)
      const resWithBluetooth = await query(client, `
        SELECT count(*) AS nb FROM products WHERE specs ? 'bluetooth'
      `);
      assertGreaterThan(parseInt(resWithBluetooth.rows[0].nb), 0,
        'Des produits avec la cle bluetooth doivent exister');

      // Cle inexistante
      const resNoKey = await query(client, `
        SELECT count(*) AS nb FROM products WHERE specs ? 'cle_inexistante'
      `);
      assertEqual(parseInt(resNoKey.rows[0].nb), 0,
        'Aucun produit ne doit avoir la cle inexistante');

      console.log(`     → ${resWithBluetooth.rows[0].nb} produits avec cle 'bluetooth'`);
    });

    // -----------------------------------------------------------------------
    // Test 4 : GIN index sur JSONB → verifier l'usage
    // -----------------------------------------------------------------------
    await test('GIN index sur JSONB — verifier l\'usage avec EXPLAIN', async () => {
      // Creer l'index GIN
      await query(client, 'CREATE INDEX idx_products_specs ON products USING GIN (specs)');
      await query(client, 'ANALYZE products');

      // Verifier que l'index est utilise
      const explainRes = await query(client, `
        EXPLAIN (FORMAT TEXT)
        SELECT * FROM products WHERE specs @> '{"marque": "TechPro"}'
      `);

      const explainText = explainRes.rows.map(r => r['QUERY PLAN']).join('\n');
      const usesIndex = explainText.includes('Bitmap Index Scan') ||
                        explainText.includes('Index Scan') ||
                        explainText.includes('idx_products_specs');

      assert(usesIndex, 'Le planificateur doit utiliser l\'index GIN');
      console.log(`     → Plan : ${explainText.split('\n')[0]}`);
    });

    // -----------------------------------------------------------------------
    // Test 5 : Tableaux @> pour filtrer par tags
    // -----------------------------------------------------------------------
    await test('Tableau @> pour filtrer par tags', async () => {
      // Filtrer par un seul tag
      const resGaming = await query(client, `
        SELECT * FROM products WHERE tags @> ARRAY['gaming']
      `);
      assertGreaterThan(resGaming.rows.length, 0, 'Doit trouver des produits gaming');

      // Verifier que chaque resultat contient le tag
      for (const row of resGaming.rows) {
        assert(row.tags.includes('gaming'),
          'Chaque resultat doit contenir le tag gaming');
      }

      // Filtrer par deux tags
      const resDouble = await query(client, `
        SELECT * FROM products WHERE tags @> ARRAY['informatique', 'portable']
      `);
      assertGreaterThan(resDouble.rows.length, 0, 'Doit trouver des produits informatique+portable');

      for (const row of resDouble.rows) {
        assert(row.tags.includes('informatique') && row.tags.includes('portable'),
          'Chaque resultat doit contenir les deux tags');
      }
      console.log(`     → ${resGaming.rows.length} produits gaming, ${resDouble.rows.length} produits informatique+portable`);
    });

    // -----------------------------------------------------------------------
    // Test 6 : GIN index sur tableaux
    // -----------------------------------------------------------------------
    await test('GIN index sur tableaux — verifier l\'usage', async () => {
      await query(client, 'CREATE INDEX idx_products_tags ON products USING GIN (tags)');
      await query(client, 'ANALYZE products');

      const explainRes = await query(client, `
        EXPLAIN (FORMAT TEXT)
        SELECT * FROM products WHERE tags @> ARRAY['gaming']
      `);

      const explainText = explainRes.rows.map(r => r['QUERY PLAN']).join('\n');
      const usesIndex = explainText.includes('Bitmap Index Scan') ||
                        explainText.includes('Index Scan') ||
                        explainText.includes('idx_products_tags');

      assert(usesIndex, 'Le planificateur doit utiliser l\'index GIN sur tags');
      console.log(`     → Plan : ${explainText.split('\n')[0]}`);
    });

    // -----------------------------------------------------------------------
    // Test 7 : Full-text search avec to_tsquery et @@
    // -----------------------------------------------------------------------
    await test('Full-text search avec to_tsquery et @@', async () => {
      // Creer un index GIN sur le search_vector
      await query(client, 'CREATE INDEX idx_products_search ON products USING GIN (search_vector)');
      await query(client, 'ANALYZE products');

      const res = await query(client, `
        SELECT name, description
        FROM products
        WHERE search_vector @@ to_tsquery('french', 'professionnel & portable')
        LIMIT 20
      `);

      assertGreaterThan(res.rows.length, 0,
        'Doit trouver des produits correspondant a "professionnel & portable"');

      console.log(`     → ${res.rows.length} resultats pour "professionnel & portable"`);
      console.log(`     → Premier resultat : ${res.rows[0].name}`);
    });

    // -----------------------------------------------------------------------
    // Test 8 : ts_rank pour classer par pertinence
    // -----------------------------------------------------------------------
    await test('ts_rank — classer les resultats par pertinence', async () => {
      const tsquery = `to_tsquery('french', 'professionnel')`;

      const res = await query(client, `
        SELECT name, description,
          ts_rank(search_vector, ${tsquery}) AS rank
        FROM products
        WHERE search_vector @@ ${tsquery}
        ORDER BY rank DESC
        LIMIT 10
      `);

      assertGreaterThan(res.rows.length, 0, 'Doit trouver des resultats');

      // Verifier que le tri est decroissant
      for (let i = 1; i < res.rows.length; i++) {
        assert(
          parseFloat(res.rows[i].rank) <= parseFloat(res.rows[i - 1].rank),
          'Les resultats doivent etre tries par rank decroissant'
        );
      }

      // Verifier que le rank est positif
      assertGreaterThan(parseFloat(res.rows[0].rank), 0,
        'Le rank doit etre > 0');

      console.log(`     → Meilleur rank : ${res.rows[0].rank} — ${res.rows[0].name}`);
    });

    // -----------------------------------------------------------------------
    // Test 9 : ts_headline pour mettre en evidence les termes
    // -----------------------------------------------------------------------
    await test('ts_headline — mettre en evidence les termes trouves', async () => {
      const res = await query(client, `
        SELECT name,
          ts_headline(
            'french',
            description,
            to_tsquery('french', 'professionnel'),
            'StartSel=<b>, StopSel=</b>, MaxWords=30, MinWords=15'
          ) AS headline
        FROM products
        WHERE search_vector @@ to_tsquery('french', 'professionnel')
        LIMIT 5
      `);

      assertGreaterThan(res.rows.length, 0, 'Doit trouver des resultats');

      // Verifier que le headline contient les balises de mise en evidence
      let hasHighlight = false;
      for (const row of res.rows) {
        if (row.headline.includes('<b>') && row.headline.includes('</b>')) {
          hasHighlight = true;
        }
      }
      assert(hasHighlight, 'Au moins un headline doit contenir les balises <b>');

      console.log(`     → Exemple : ${res.rows[0].headline}`);
    });

    // -----------------------------------------------------------------------
    // Test 10 : Requete combinee JSONB + full-text + ranking
    // -----------------------------------------------------------------------
    await test('Requete combinee — JSONB + full-text + ranking', async () => {
      const tsquery = `to_tsquery('french', 'professionnel | performant')`;

      const res = await query(client, `
        SELECT
          name,
          specs->>'marque' AS marque,
          ts_rank(search_vector, ${tsquery}) AS rank,
          ts_headline(
            'french',
            description,
            ${tsquery},
            'StartSel=<b>, StopSel=</b>, MaxWords=20, MinWords=10'
          ) AS headline
        FROM products
        WHERE specs @> '{"marque": "TechPro"}'
          AND search_vector @@ ${tsquery}
        ORDER BY rank DESC
        LIMIT 10
      `);

      assertGreaterThan(res.rows.length, 0,
        'Doit trouver des produits TechPro correspondant a la recherche');

      // Verifier les deux criteres
      for (const row of res.rows) {
        assertEqual(row.marque, 'TechPro', 'La marque doit etre TechPro');
        assertGreaterThan(parseFloat(row.rank), 0, 'Le rank doit etre > 0');
      }

      // Verifier le tri par pertinence
      for (let i = 1; i < res.rows.length; i++) {
        assert(
          parseFloat(res.rows[i].rank) <= parseFloat(res.rows[i - 1].rank),
          'Les resultats doivent etre tries par pertinence decroissante'
        );
      }

      console.log(`     → ${res.rows.length} produits TechPro pertinents`);
      console.log(`     → Meilleur : ${res.rows[0].name} (rank=${res.rows[0].rank})`);
      console.log(`     → Headline : ${res.rows[0].headline}`);
    });

    summary();
  } finally {
    await teardownDatabase(client, 'DROP TABLE IF EXISTS products CASCADE;');
    await client.end();
  }
}

run().catch(console.error);
