// =============================================================================
// Lab 13 — JSONB & Full-Text Search (Exercice)
// =============================================================================

import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.js';

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
  -- Categories de produits avec descriptions en francais
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
async function run() {
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
      // TODO:
      // 1. SELECT name, specs->'marque' AS marque_json, specs->>'marque' AS marque_text
      //    FROM products LIMIT 5
      // 2. Verifier que -> retourne un JSON (avec guillemets)
      // 3. Verifier que ->> retourne du texte (sans guillemets)
      // 4. Verifier que les marques ne sont pas null
    });

    // -----------------------------------------------------------------------
    // Test 2 : JSONB @> (containment) pour trouver des produits
    // -----------------------------------------------------------------------
    await test('JSONB @> pour trouver des produits avec specs specifiques', async () => {
      // TODO:
      // 1. SELECT * FROM products WHERE specs @> '{"marque": "TechPro"}'
      // 2. Verifier qu'on obtient des resultats (les ordinateurs portables)
      // 3. Verifier que chaque resultat a bien marque = 'TechPro' dans specs
    });

    // -----------------------------------------------------------------------
    // Test 3 : JSONB ? pour verifier l'existence d'une cle
    // -----------------------------------------------------------------------
    await test('JSONB ? pour verifier l\'existence d\'une cle', async () => {
      // TODO:
      // 1. SELECT count(*) FROM products WHERE specs ? 'bluetooth'
      //    (seuls les casques audio ont cette cle)
      // 2. Verifier que le nombre est > 0
      // 3. SELECT count(*) FROM products WHERE specs ? 'cle_inexistante'
      // 4. Verifier que le resultat est 0
    });

    // -----------------------------------------------------------------------
    // Test 4 : GIN index sur JSONB → verifier l'usage
    // -----------------------------------------------------------------------
    await test('GIN index sur JSONB — verifier l\'usage avec EXPLAIN', async () => {
      // TODO:
      // 1. CREATE INDEX idx_products_specs ON products USING GIN (specs)
      // 2. ANALYZE products
      // 3. EXPLAIN (FORMAT TEXT) SELECT * FROM products WHERE specs @> '{"marque": "TechPro"}'
      // 4. Verifier que le plan contient "Bitmap Index Scan" ou "Index Scan"
    });

    // -----------------------------------------------------------------------
    // Test 5 : Tableaux @> pour filtrer par tags
    // -----------------------------------------------------------------------
    await test('Tableau @> pour filtrer par tags', async () => {
      // TODO:
      // 1. SELECT * FROM products WHERE tags @> ARRAY['gaming']
      // 2. Verifier que tous les resultats contiennent le tag 'gaming'
      // 3. SELECT * FROM products WHERE tags @> ARRAY['informatique', 'portable']
      // 4. Verifier que les resultats contiennent les DEUX tags
    });

    // -----------------------------------------------------------------------
    // Test 6 : GIN index sur tableaux
    // -----------------------------------------------------------------------
    await test('GIN index sur tableaux — verifier l\'usage', async () => {
      // TODO:
      // 1. CREATE INDEX idx_products_tags ON products USING GIN (tags)
      // 2. ANALYZE products
      // 3. EXPLAIN (FORMAT TEXT) SELECT * FROM products WHERE tags @> ARRAY['gaming']
      // 4. Verifier que le plan utilise l'index GIN
    });

    // -----------------------------------------------------------------------
    // Test 7 : Full-text search avec to_tsquery et @@
    // -----------------------------------------------------------------------
    await test('Full-text search avec to_tsquery et @@', async () => {
      // TODO:
      // 1. SELECT * FROM products
      //    WHERE search_vector @@ to_tsquery('french', 'professionnel & portable')
      // 2. Verifier qu'on obtient des resultats
      // 3. Verifier que les resultats sont pertinents
      //    (contiennent "professionnel" et/ou "portable" dans le nom ou la description)
    });

    // -----------------------------------------------------------------------
    // Test 8 : ts_rank pour classer par pertinence
    // -----------------------------------------------------------------------
    await test('ts_rank — classer les resultats par pertinence', async () => {
      // TODO:
      // 1. SELECT name, description,
      //    ts_rank(search_vector, to_tsquery('french', 'professionnel')) AS rank
      //    FROM products
      //    WHERE search_vector @@ to_tsquery('french', 'professionnel')
      //    ORDER BY rank DESC LIMIT 10
      // 2. Verifier que les resultats sont tries par rank decroissant
      // 3. Verifier que le rank est un nombre > 0
    });

    // -----------------------------------------------------------------------
    // Test 9 : ts_headline pour mettre en evidence les termes
    // -----------------------------------------------------------------------
    await test('ts_headline — mettre en evidence les termes trouves', async () => {
      // TODO:
      // 1. SELECT name,
      //    ts_headline('french', description, to_tsquery('french', 'professionnel'),
      //      'StartSel=<b>, StopSel=</b>, MaxWords=30, MinWords=15') AS headline
      //    FROM products
      //    WHERE search_vector @@ to_tsquery('french', 'professionnel')
      //    LIMIT 5
      // 2. Verifier que le headline contient '<b>' et '</b>'
      // 3. Verifier que le terme est mis en evidence
    });

    // -----------------------------------------------------------------------
    // Test 10 : Requete combinee JSONB + full-text + ranking
    // -----------------------------------------------------------------------
    await test('Requete combinee — JSONB + full-text + ranking', async () => {
      // TODO:
      // 1. Combiner :
      //    - Filtre JSONB : specs @> '{"marque": "TechPro"}'
      //    - Full-text : search_vector @@ to_tsquery('french', 'professionnel | performant')
      //    - Ranking : ts_rank(search_vector, ...)
      //    - Headline : ts_headline(...)
      // 2. Verifier que les resultats satisfont les DEUX criteres
      // 3. Verifier le tri par pertinence
    });

    summary();
  } finally {
    await teardownDatabase(client, 'DROP TABLE IF EXISTS products CASCADE;');
    await client.end();
  }
}

run().catch(console.error);
