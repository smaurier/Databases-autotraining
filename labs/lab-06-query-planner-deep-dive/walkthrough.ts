// =============================================================================
// Lab 06 — Query Planner Deep Dive : Visite guidee (Walkthrough)
// =============================================================================
// Exploration interactive du planificateur de requetes PostgreSQL.
// Executez avec : node walkthrough.js
// =============================================================================

import pg from 'pg';
import { createClient, query } from '../db-test-utils.ts';

// Couleurs
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const DIM = '\x1b[2m';

function title(text: string): void {
  console.log(`\n${BOLD}${BLUE}${'═'.repeat(65)}${RESET}`);
  console.log(`${BOLD}${BLUE}  ${text}${RESET}`);
  console.log(`${BOLD}${BLUE}${'═'.repeat(65)}${RESET}\n`);
}

function subtitle(text: string): void {
  console.log(`\n${BOLD}${CYAN}  --- ${text} ---${RESET}\n`);
}

function explain(text: string): void {
  console.log(`${DIM}  > ${text}${RESET}`);
}

function showPlan(label: string, rows: Array<{ 'QUERY PLAN': string }>): void {
  console.log(`\n  ${BOLD}${MAGENTA}${label}${RESET}`);
  rows.forEach(r => {
    const line = r['QUERY PLAN'] || r['QUERY PLAN'];
    console.log(`  ${DIM}${line}${RESET}`);
  });
  console.log();
}

function annotation(text: string): void {
  console.log(`  ${YELLOW}→ ${text}${RESET}`);
}

let client: pg.Client | undefined;

try {
  client = await createClient();

  // ─── Setup ──────────────────────────────────────────────────────────────────
  await query(client, 'DROP TABLE IF EXISTS orders, customers, products CASCADE');

  await query(client, `CREATE TABLE customers (id SERIAL PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL)`);
  await query(client, `CREATE TABLE products (id SERIAL PRIMARY KEY, name TEXT NOT NULL, price NUMERIC(10,2) NOT NULL, category TEXT NOT NULL)`);
  await query(client, `
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

  // Donnees
  await query(client, `
    INSERT INTO customers (name, city)
    SELECT 'Client_' || i, (ARRAY['Paris', 'Lyon', 'Marseille', 'Bordeaux', 'Lille'])[1 + (i % 5)]
    FROM generate_series(1, 1000) AS i
  `);

  await query(client, `
    INSERT INTO products (name, price, category)
    SELECT 'Produit_' || i, 10 + (random() * 490)::numeric(10,2),
           (ARRAY['Electronique', 'Vetements', 'Alimentation', 'Mobilier', 'Sport'])[1 + (i % 5)]
    FROM generate_series(1, 500) AS i
  `);

  await query(client, `
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

  await query(client, 'ANALYZE customers, products, orders');

  // ═══════════════════════════════════════════════════════════════════════════
  // PARTIE 1 : Les types de Scan
  // ═══════════════════════════════════════════════════════════════════════════
  title('PARTIE 1 : Les types de Scan');

  // --- Seq Scan ---
  subtitle('1.1 Sequential Scan (Seq Scan)');
  explain('Sans index, PostgreSQL lit la table ligne par ligne (full table scan).');
  explain('C\'est la methode par defaut quand aucun index n\'est disponible.');

  let result = await query(client, "EXPLAIN ANALYZE SELECT * FROM orders WHERE status = 'livree'");
  showPlan('EXPLAIN ANALYZE SELECT * FROM orders WHERE status = \'livree\'', result.rows);
  annotation('Seq Scan : PostgreSQL parcourt toutes les 50 000 lignes.');
  annotation('Le filtre est applique a chaque ligne → lent sur de grandes tables.');

  // --- Index Scan ---
  subtitle('1.2 Index Scan');
  explain('Avec un index B-tree, PostgreSQL peut aller directement aux lignes pertinentes.');

  await query(client, 'CREATE INDEX idx_orders_status ON orders(status)');
  await query(client, 'ANALYZE orders');

  result = await query(client, "EXPLAIN ANALYZE SELECT * FROM orders WHERE status = 'annulee'");
  showPlan('Apres CREATE INDEX idx_orders_status ON orders(status)', result.rows);
  annotation('Index Scan ou Bitmap Index Scan : PostgreSQL utilise l\'index.');
  annotation('Pour ~25% des lignes, PG peut preferer un Bitmap Scan (plus efficient en I/O).');

  // --- Bitmap Index Scan ---
  subtitle('1.3 Bitmap Index Scan');
  explain('Quand l\'index retourne beaucoup de lignes, PostgreSQL cree un "bitmap"');
  explain('des pages de la table a lire, puis les lit sequentiellement.');
  explain('C\'est un compromis entre Seq Scan et Index Scan.');

  result = await query(client, "EXPLAIN ANALYZE SELECT * FROM orders WHERE status IN ('livree', 'expediee')");
  showPlan('SELECT * FROM orders WHERE status IN (\'livree\', \'expediee\')', result.rows);
  annotation('Bitmap Heap Scan : combine les resultats de l\'index en un bitmap.');

  // --- Index Only Scan ---
  subtitle('1.4 Index Only Scan');
  explain('Si toutes les colonnes demandees sont dans l\'index, PostgreSQL');
  explain('n\'a meme pas besoin de lire la table ! (covering index)');

  await query(client, 'CREATE INDEX idx_orders_status_total ON orders(status, total)');
  await query(client, 'VACUUM orders'); // necessaire pour Index Only Scan
  await query(client, 'ANALYZE orders');

  result = await query(client, "EXPLAIN ANALYZE SELECT status, total FROM orders WHERE status = 'annulee'");
  showPlan('SELECT status, total FROM orders WHERE status = \'annulee\' (covering index)', result.rows);
  annotation('Index Only Scan : aucune lecture de la table, uniquement l\'index.');
  annotation('Condition : la table doit etre VACUUMee (visibility map a jour).');

  // ═══════════════════════════════════════════════════════════════════════════
  // PARTIE 2 : Les strategies de jointure
  // ═══════════════════════════════════════════════════════════════════════════
  title('PARTIE 2 : Les strategies de jointure');

  // --- Hash Join ---
  subtitle('2.1 Hash Join');
  explain('PostgreSQL cree une table de hachage a partir de la petite table,');
  explain('puis parcourt la grande table en cherchant les correspondances.');

  result = await query(client, `
    EXPLAIN ANALYZE
    SELECT o.id, c.name, o.total
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    WHERE o.status = 'livree'
  `);
  showPlan('JOIN orders + customers (Hash Join probable)', result.rows);
  annotation('Hash Join : ideal quand une table est petite et l\'autre grande.');

  // --- Nested Loop ---
  subtitle('2.2 Nested Loop');
  explain('Pour chaque ligne de la table externe, PostgreSQL cherche les');
  explain('correspondances dans la table interne via un index.');
  explain('Forcons un Nested Loop en desactivant Hash Join :');

  await query(client, 'SET enable_hashjoin = off');
  await query(client, 'SET enable_mergejoin = off');

  result = await query(client, `
    EXPLAIN ANALYZE
    SELECT o.id, c.name, o.total
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    WHERE o.status = 'annulee'
    LIMIT 100
  `);
  showPlan('Meme JOIN avec Nested Loop force', result.rows);
  annotation('Nested Loop : efficace pour les petits resultats ou avec un bon index.');

  await query(client, 'SET enable_hashjoin = on');
  await query(client, 'SET enable_mergejoin = on');

  // --- Merge Join ---
  subtitle('2.3 Merge Join');
  explain('Les deux tables sont triees sur la colonne de jointure,');
  explain('puis fusionnees comme un "merge sort".');
  explain('Forcons un Merge Join :');

  await query(client, 'SET enable_hashjoin = off');

  result = await query(client, `
    EXPLAIN ANALYZE
    SELECT o.id, c.name, o.total
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
  `);
  showPlan('JOIN avec Merge Join force', result.rows);
  annotation('Merge Join : efficace quand les deux tables sont deja triees.');

  await query(client, 'SET enable_hashjoin = on');

  // ═══════════════════════════════════════════════════════════════════════════
  // PARTIE 3 : EXPLAIN ANALYZE avec BUFFERS
  // ═══════════════════════════════════════════════════════════════════════════
  title('PARTIE 3 : Buffers et metriques avancees');

  subtitle('3.1 BUFFERS — lecture du cache');
  explain('EXPLAIN (ANALYZE, BUFFERS) montre le nombre de pages lues');
  explain('depuis le cache (shared hit) ou depuis le disque (read).');

  result = await query(client, `
    EXPLAIN (ANALYZE, BUFFERS)
    SELECT * FROM orders WHERE order_date > '2024-01-01'
  `);
  showPlan('EXPLAIN (ANALYZE, BUFFERS)', result.rows);
  annotation('shared hit = pages lues depuis le cache PostgreSQL');
  annotation('read = pages lues depuis le disque (ou cache OS)');

  // ═══════════════════════════════════════════════════════════════════════════
  // Resume
  // ═══════════════════════════════════════════════════════════════════════════
  title('Resume des types de scan');
  console.log(`  ${BOLD}Seq Scan${RESET}         : Parcours sequentiel (toutes les lignes)`);
  console.log(`  ${BOLD}Index Scan${RESET}       : Utilise l'index pour trouver les lignes`);
  console.log(`  ${BOLD}Bitmap Scan${RESET}      : Cree un bitmap de pages a lire`);
  console.log(`  ${BOLD}Index Only Scan${RESET}  : Lit uniquement l'index (covering index)`);
  console.log();

  title('Resume des strategies de jointure');
  console.log(`  ${BOLD}Hash Join${RESET}    : Table de hachage (petite table × grande table)`);
  console.log(`  ${BOLD}Nested Loop${RESET}  : Boucle imbriquee (petit resultat + index)`);
  console.log(`  ${BOLD}Merge Join${RESET}   : Fusion de tables triees`);
  console.log();

} finally {
  if (client) {
    await query(client, 'DROP TABLE IF EXISTS orders, customers, products CASCADE');
    await client.end();
  }
}
