// =============================================================================
// Lab 01 — Premiers pas avec PostgreSQL (Solution)
// =============================================================================
// Objectifs :
//   - Se connecter a PostgreSQL
//   - Creer une table
//   - Inserer des donnees
//   - Effectuer des requetes SELECT
// =============================================================================

import { createTestRunner, createClient, query } from '../db-test-utils.js';

const { test, assert, assertEqual, assertGreaterThan, summary } = createTestRunner('Lab 01 — Premiers pas psql');

let client;

try {
  // ─────────────────────────────────────────────────────────────────────────────
  // Connexion a PostgreSQL
  // ─────────────────────────────────────────────────────────────────────────────
  client = await createClient();

  // Nettoyage initial
  await query(client, 'DROP TABLE IF EXISTS users');

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 1 : Connexion reussie
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Connexion a PostgreSQL reussie', async () => {
    const result = await query(client, 'SELECT 1 AS connected');
    assertEqual(result.rows[0].connected, 1, 'La connexion devrait retourner 1');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2 : Creation de la table users
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Creation de la table users', async () => {
    await query(client, `
      CREATE TABLE users (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        email      TEXT UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Verification : la table existe avec les bonnes colonnes
    const result = await query(client, `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'users'
      ORDER BY ordinal_position
    `);
    assertGreaterThan(result.rows.length, 0, 'La table users devrait exister');
    assertEqual(result.rows.length, 4, 'La table devrait avoir 4 colonnes');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3 : Insertion de 3 utilisateurs
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Insertion de 3 utilisateurs', async () => {
    await query(client, `
      INSERT INTO users (name, email) VALUES
        ('Alice', 'alice@example.com'),
        ('Bob', 'bob@example.com'),
        ('Charlie', 'charlie@example.com')
    `);

    const result = await query(client, 'SELECT COUNT(*) AS count FROM users');
    assertEqual(parseInt(result.rows[0].count), 3, 'Il devrait y avoir 3 utilisateurs');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4 : SELECT tous les utilisateurs
  // ─────────────────────────────────────────────────────────────────────────────
  await test('SELECT de tous les utilisateurs', async () => {
    const result = await query(client, 'SELECT * FROM users ORDER BY id');

    assertEqual(result.rows.length, 3, 'SELECT devrait retourner 3 lignes');
    assert(result.rows[0].name, 'Chaque ligne devrait avoir un champ "name"');
    assert(result.rows[0].email, 'Chaque ligne devrait avoir un champ "email"');
    assert(result.rows[0].created_at, 'Chaque ligne devrait avoir un champ "created_at"');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5 : SELECT avec WHERE (requete parametree)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('SELECT avec clause WHERE', async () => {
    const result = await query(client, 'SELECT * FROM users WHERE name = $1', ['Alice']);

    assertEqual(result.rows.length, 1, 'WHERE devrait retourner 1 seule ligne');
    assertEqual(result.rows[0].name, 'Alice', 'Le nom devrait etre Alice');
    assertEqual(result.rows[0].email, 'alice@example.com', "L'email devrait etre alice@example.com");
  });

} finally {
  // ─────────────────────────────────────────────────────────────────────────────
  // Nettoyage
  // ─────────────────────────────────────────────────────────────────────────────
  if (client) {
    await query(client, 'DROP TABLE IF EXISTS users');
    await client.end();
  }
  summary();
}
