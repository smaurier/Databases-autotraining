// =============================================================================
// Lab 01 — Premiers pas avec PostgreSQL (Exercice)
// =============================================================================
// Objectifs :
//   - Se connecter a PostgreSQL
//   - Creer une table
//   - Inserer des donnees
//   - Effectuer des requetes SELECT
// =============================================================================

import { createTestRunner, createClient, query, setupDatabase, teardownDatabase } from '../db-test-utils.ts';

const { test, assert, assertEqual, assertGreaterThan, summary } = createTestRunner('Lab 01 — Premiers pas psql');

let client: Awaited<ReturnType<typeof createClient>> | undefined;

try {
  // ─────────────────────────────────────────────────────────────────────────────
  // Connexion
  // ─────────────────────────────────────────────────────────────────────────────

  // TODO 1 : Creez une connexion a PostgreSQL avec createClient()
  // Indice : const client = await createClient();
  // client = ???

  // ─────────────────────────────────────────────────────────────────────────────
  // Nettoyage initial
  // ─────────────────────────────────────────────────────────────────────────────

  // On supprime la table si elle existe deja (pour pouvoir relancer le script)
  await query(client!, 'DROP TABLE IF EXISTS users');

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 1 : Connexion
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Connexion a PostgreSQL reussie', async () => {
    const result = await query(client!, 'SELECT 1 AS connected');
    assertEqual(result.rows[0].connected, 1, 'La connexion devrait retourner 1');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2 : Creation de la table
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Creation de la table users', async () => {
    // TODO 2 : Creez la table "users" avec les colonnes suivantes :
    //   - id         : SERIAL PRIMARY KEY
    //   - name       : TEXT NOT NULL
    //   - email      : TEXT UNIQUE
    //   - created_at : TIMESTAMPTZ DEFAULT NOW()
    //
    // Indice : await query(client!, 'CREATE TABLE users (...)');

    // Verification : la table existe
    const result = await query(client!, `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'users'
      ORDER BY ordinal_position
    `);
    assertGreaterThan(result.rows.length, 0, 'La table users devrait exister');
    assertEqual(result.rows.length, 4, 'La table devrait avoir 4 colonnes');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3 : Insertion de donnees
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Insertion de 3 utilisateurs', async () => {
    // TODO 3 : Inserez 3 utilisateurs dans la table "users"
    // Utilisateurs a inserer :
    //   - Alice, alice@example.com
    //   - Bob, bob@example.com
    //   - Charlie, charlie@example.com
    //
    // Indice : await query(client!, "INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')");
    // Vous pouvez faire 3 INSERT separes ou un seul INSERT avec plusieurs VALUES

    const result = await query(client!, 'SELECT COUNT(*) AS count FROM users');
    assertEqual(parseInt(result.rows[0].count), 3, 'Il devrait y avoir 3 utilisateurs');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4 : SELECT tous les utilisateurs
  // ─────────────────────────────────────────────────────────────────────────────
  await test('SELECT de tous les utilisateurs', async () => {
    // TODO 4 : Recuperez tous les utilisateurs avec SELECT * FROM users
    // Stockez le resultat dans une variable "result"
    //
    // Indice : const result = await query(client!, 'SELECT ...');

    let result: Awaited<ReturnType<typeof query>>; // <-- remplacez par votre requete

    assertEqual(result!.rows.length, 3, 'SELECT devrait retourner 3 lignes');
    assert(result!.rows[0].name, 'Chaque ligne devrait avoir un champ "name"');
    assert(result!.rows[0].email, 'Chaque ligne devrait avoir un champ "email"');
    assert(result!.rows[0].created_at, 'Chaque ligne devrait avoir un champ "created_at"');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5 : SELECT avec WHERE
  // ─────────────────────────────────────────────────────────────────────────────
  await test('SELECT avec clause WHERE', async () => {
    // TODO 5 : Recuperez uniquement l'utilisateur dont le nom est 'Alice'
    // Utilisez une requete parametree avec $1
    //
    // Indice : const result = await query(client!, 'SELECT ... WHERE name = $1', ['Alice']);

    let result: Awaited<ReturnType<typeof query>>; // <-- remplacez par votre requete

    assertEqual(result!.rows.length, 1, 'WHERE devrait retourner 1 seule ligne');
    assertEqual(result!.rows[0].name, 'Alice', 'Le nom devrait etre Alice');
    assertEqual(result!.rows[0].email, 'alice@example.com', "L'email devrait etre alice@example.com");
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
