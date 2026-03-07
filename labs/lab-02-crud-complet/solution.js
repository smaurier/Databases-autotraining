// =============================================================================
// Lab 02 — CRUD complet (Solution)
// =============================================================================
// Objectifs :
//   - Maitriser INSERT, SELECT, UPDATE, DELETE
//   - Utiliser RETURNING
//   - Agregations et requetes parametrees
//   - Protection contre l'injection SQL
// =============================================================================

import { createTestRunner, createClient, query } from '../db-test-utils.js';

const { test, assert, assertEqual, assertGreaterThan, summary } = createTestRunner('Lab 02 — CRUD complet');

let client;

try {
  client = await createClient();

  // Nettoyage + creation de la table
  await query(client, 'DROP TABLE IF EXISTS products');
  await query(client, `
    CREATE TABLE products (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      price      NUMERIC(10,2) NOT NULL,
      category   TEXT NOT NULL,
      in_stock   BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 1 : INSERT d'un seul produit
  // ─────────────────────────────────────────────────────────────────────────────
  await test('INSERT d\'un seul produit', async () => {
    await query(client, `
      INSERT INTO products (name, price, category) VALUES ('Clavier', 49.99, 'Informatique')
    `);

    const result = await query(client, 'SELECT * FROM products WHERE name = $1', ['Clavier']);
    assertEqual(result.rows.length, 1, 'Le produit Clavier devrait exister');
    assertEqual(parseFloat(result.rows[0].price), 49.99, 'Le prix devrait etre 49.99');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2 : INSERT multiple avec RETURNING
  // ─────────────────────────────────────────────────────────────────────────────
  await test('INSERT multiple avec RETURNING', async () => {
    const result = await query(client, `
      INSERT INTO products (name, price, category) VALUES
        ('Souris', 29.99, 'Informatique'),
        ('Ecran', 299.99, 'Informatique'),
        ('Bureau', 199.99, 'Mobilier'),
        ('Chaise', 149.99, 'Mobilier')
      RETURNING *
    `);

    assertEqual(result.rows.length, 4, 'RETURNING devrait retourner 4 produits');
    assert(result.rows[0].id, 'Chaque produit devrait avoir un id');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3 : SELECT avec WHERE
  // ─────────────────────────────────────────────────────────────────────────────
  await test('SELECT avec WHERE', async () => {
    const result = await query(client, "SELECT * FROM products WHERE category = 'Informatique'");

    assertEqual(result.rows.length, 3, 'Il devrait y avoir 3 produits Informatique');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4 : SELECT avec agregation
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Agregation AVG par categorie', async () => {
    const result = await query(client, `
      SELECT category, AVG(price) AS avg_price
      FROM products
      GROUP BY category
      ORDER BY category
    `);

    assertEqual(result.rows.length, 2, 'Il devrait y avoir 2 categories');
    const infoRow = result.rows.find(r => r.category === 'Informatique');
    assert(infoRow, 'La categorie Informatique devrait exister');
    const avgPrice = parseFloat(infoRow.avg_price);
    assert(avgPrice > 126 && avgPrice < 127, `Le prix moyen Informatique devrait etre ~126.66, recu: ${avgPrice}`);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5 : UPDATE avec RETURNING
  // ─────────────────────────────────────────────────────────────────────────────
  await test('UPDATE avec RETURNING', async () => {
    const result = await query(client, `
      UPDATE products SET price = 59.99 WHERE name = 'Clavier' RETURNING *
    `);

    assertEqual(result.rows.length, 1, 'UPDATE devrait retourner 1 ligne');
    assertEqual(parseFloat(result.rows[0].price), 59.99, 'Le nouveau prix devrait etre 59.99');
    assertEqual(result.rows[0].name, 'Clavier', 'Le nom devrait etre Clavier');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6 : DELETE avec RETURNING
  // ─────────────────────────────────────────────────────────────────────────────
  await test('DELETE avec RETURNING', async () => {
    const result = await query(client, `
      DELETE FROM products WHERE name = 'Bureau' RETURNING *
    `);

    assertEqual(result.rows.length, 1, 'DELETE devrait retourner 1 ligne');
    assertEqual(result.rows[0].name, 'Bureau', 'Le produit supprime devrait etre Bureau');

    // Verification : le produit n'existe plus
    const check = await query(client, "SELECT * FROM products WHERE name = 'Bureau'");
    assertEqual(check.rows.length, 0, 'Le produit Bureau ne devrait plus exister');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 7 : Requetes parametrees
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Requetes parametrees ($1, $2)', async () => {
    const result = await query(
      client,
      'SELECT * FROM products WHERE category = $1 AND price > $2',
      ['Informatique', 40]
    );

    assert(result.rows.length > 0, 'La requete parametree devrait retourner des resultats');
    result.rows.forEach(row => {
      assertEqual(row.category, 'Informatique', 'La categorie devrait etre Informatique');
      assert(parseFloat(row.price) > 40, 'Le prix devrait etre > 40');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 8 : Protection injection SQL
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Protection contre l\'injection SQL', async () => {
    const maliciousInput = "'; DROP TABLE products; --";

    // La requete parametree echappe automatiquement la valeur malicieuse
    const result = await query(client, 'SELECT * FROM products WHERE name = $1', [maliciousInput]);
    assertEqual(result.rows.length, 0, 'Aucun produit ne correspond a la valeur malicieuse');

    // Verification : la table existe toujours
    const check = await query(client, 'SELECT COUNT(*) AS count FROM products');
    assertGreaterThan(parseInt(check.rows[0].count), 0, 'La table products devrait toujours exister avec des donnees');
  });

} finally {
  if (client) {
    await query(client, 'DROP TABLE IF EXISTS products');
    await client.end();
  }
  summary();
}
