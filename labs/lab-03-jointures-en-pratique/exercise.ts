// =============================================================================
// Lab 03 — Jointures en pratique (Exercice)
// =============================================================================
// Objectifs :
//   - Maitriser INNER JOIN, LEFT JOIN, RIGHT JOIN, FULL OUTER JOIN
//   - Tables de jonction (many-to-many)
//   - GROUP BY avec JOIN
//   - Sous-requetes vs jointures
// =============================================================================

import { createTestRunner, createClient, query } from '../db-test-utils.ts';

const { test, assert, assertEqual, assertGreaterThan, summary } = createTestRunner('Lab 03 — Jointures en pratique');

let client: Awaited<ReturnType<typeof createClient>> | undefined;

try {
  client = await createClient();

  // ─────────────────────────────────────────────────────────────────────────────
  // Setup : creation du schema et insertion des donnees
  // ─────────────────────────────────────────────────────────────────────────────
  await query(client, 'DROP TABLE IF EXISTS book_categories, books, categories, authors CASCADE');

  await query(client, `
    CREATE TABLE authors (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      nationality TEXT
    )
  `);

  await query(client, `
    CREATE TABLE books (
      id             SERIAL PRIMARY KEY,
      title          TEXT NOT NULL,
      author_id      INTEGER REFERENCES authors(id),
      published_year INTEGER
    )
  `);

  await query(client, `
    CREATE TABLE categories (
      id   SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    )
  `);

  await query(client, `
    CREATE TABLE book_categories (
      book_id     INTEGER REFERENCES books(id),
      category_id INTEGER REFERENCES categories(id),
      PRIMARY KEY (book_id, category_id)
    )
  `);

  // Insertion des auteurs (dont un sans livres)
  await query(client, `
    INSERT INTO authors (name, nationality) VALUES
      ('Victor Hugo', 'Francaise'),
      ('Albert Camus', 'Francaise'),
      ('Gabriel Garcia Marquez', 'Colombienne'),
      ('Haruki Murakami', 'Japonaise'),
      ('Toni Morrison', 'Americaine')
  `);

  // Insertion des livres (certains auteurs ont plusieurs livres, un livre sans auteur)
  await query(client, `
    INSERT INTO books (title, author_id, published_year) VALUES
      ('Les Miserables', 1, 1862),
      ('Notre-Dame de Paris', 1, 1831),
      ('L''Etranger', 2, 1942),
      ('La Peste', 2, 1947),
      ('Cent ans de solitude', 3, 1967),
      ('L''amour au temps du cholera', 3, 1985),
      ('Kafka sur le rivage', 4, 2002),
      ('Livre anonyme', NULL, 2020)
  `);

  // Insertion des categories
  await query(client, `
    INSERT INTO categories (name) VALUES
      ('Roman'),
      ('Classique'),
      ('Realisme magique'),
      ('Philosophie'),
      ('Aventure')
  `);

  // Associations livres <-> categories
  await query(client, `
    INSERT INTO book_categories (book_id, category_id) VALUES
      (1, 1), (1, 2),
      (2, 1), (2, 2),
      (3, 1), (3, 4),
      (4, 1), (4, 4),
      (5, 1), (5, 3),
      (6, 1), (6, 3),
      (7, 1), (7, 5)
  `);

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 1 : INNER JOIN auteurs + livres
  // ─────────────────────────────────────────────────────────────────────────────
  await test('INNER JOIN auteurs et livres', async () => {
    // TODO 1 : Ecrivez un INNER JOIN entre authors et books
    // Recuperez : author name, book title, published_year
    // Indice : SELECT a.name, b.title, b.published_year
    //          FROM authors a INNER JOIN books b ON ...

    let result: Awaited<ReturnType<typeof query>>; // <-- remplacez

    assertGreaterThan(result!.rows.length, 0, 'INNER JOIN devrait retourner des resultats');
    // 7 livres ont un author_id non NULL
    assertEqual(result!.rows.length, 7, 'INNER JOIN devrait retourner 7 lignes');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2 : LEFT JOIN (auteurs sans livres)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('LEFT JOIN — tous les auteurs, meme sans livres', async () => {
    // TODO 2 : Ecrivez un LEFT JOIN pour voir TOUS les auteurs, meme ceux sans livres
    // Indice : SELECT a.name, b.title
    //          FROM authors a LEFT JOIN books b ON ...

    let result: Awaited<ReturnType<typeof query>>; // <-- remplacez

    // 5 auteurs : Hugo(2), Camus(2), Marquez(2), Murakami(1), Morrison(0) = 8 lignes
    assertEqual(result!.rows.length, 8, 'LEFT JOIN devrait retourner 8 lignes');
    // Toni Morrison n'a pas de livres
    const morrison = result!.rows.find((r: { name: string }) => r.name === 'Toni Morrison');
    assert(morrison, 'Toni Morrison devrait apparaitre');
    assertEqual(morrison.title, null, 'Toni Morrison ne devrait pas avoir de livre');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3 : RIGHT JOIN
  // ─────────────────────────────────────────────────────────────────────────────
  await test('RIGHT JOIN — tous les livres, meme sans auteur', async () => {
    // TODO 3 : Ecrivez un RIGHT JOIN pour voir TOUS les livres, meme ceux sans auteur
    // Indice : SELECT a.name AS author_name, b.title
    //          FROM authors a RIGHT JOIN books b ON ...

    let result: Awaited<ReturnType<typeof query>>; // <-- remplacez

    // 8 livres, dont 1 sans auteur
    assertEqual(result!.rows.length, 8, 'RIGHT JOIN devrait retourner 8 lignes');
    const anonyme = result!.rows.find((r: { title: string }) => r.title === 'Livre anonyme');
    assert(anonyme, 'Le Livre anonyme devrait apparaitre');
    assertEqual(anonyme.author_name, null, 'Le Livre anonyme ne devrait pas avoir d\'auteur');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4 : FULL OUTER JOIN
  // ─────────────────────────────────────────────────────────────────────────────
  await test('FULL OUTER JOIN', async () => {
    // TODO 4 : Ecrivez un FULL OUTER JOIN entre authors et books
    // Indice : SELECT a.name AS author_name, b.title
    //          FROM authors a FULL OUTER JOIN books b ON ...

    let result: Awaited<ReturnType<typeof query>>; // <-- remplacez

    // 7 matchs + 1 auteur sans livre + 1 livre sans auteur = 9
    assertEqual(result!.rows.length, 9, 'FULL OUTER JOIN devrait retourner 9 lignes');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5 : Table de jonction (livres avec categories)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Table de jonction — livres avec leurs categories', async () => {
    // TODO 5 : Ecrivez une requete qui recupere chaque livre avec ses categories
    // Joignez books, book_categories et categories
    // Indice : SELECT b.title, c.name AS category
    //          FROM books b
    //          JOIN book_categories bc ON bc.book_id = b.id
    //          JOIN categories c ON ...

    let result: Awaited<ReturnType<typeof query>>; // <-- remplacez

    assertGreaterThan(result!.rows.length, 0, 'La requete devrait retourner des resultats');
    // 14 associations au total
    assertEqual(result!.rows.length, 14, 'Il devrait y avoir 14 associations livre-categorie');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6 : Self-join (preparation)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Self-join — auteurs de la meme nationalite', async () => {
    // TODO 6 : Trouvez les paires d'auteurs qui ont la meme nationalite
    // Utilisez un self-join : authors a1 JOIN authors a2
    // Condition : a1.nationality = a2.nationality AND a1.id < a2.id (pour eviter les doublons)
    // Indice : SELECT a1.name AS auteur1, a2.name AS auteur2, a1.nationality
    //          FROM authors a1 JOIN authors a2 ON ...

    let result: Awaited<ReturnType<typeof query>>; // <-- remplacez

    // Hugo et Camus sont tous les deux Francais = 1 paire
    assertEqual(result!.rows.length, 1, 'Il devrait y avoir 1 paire d\'auteurs de meme nationalite');
    assert(
      result!.rows[0].auteur1 && result!.rows[0].auteur2,
      'Chaque paire devrait avoir auteur1 et auteur2'
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 7 : Multi-table JOIN (auteurs + livres + categories)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Multi-table JOIN — auteurs + livres + categories', async () => {
    // TODO 7 : Ecrivez une requete qui joint authors, books, book_categories et categories
    // Recuperez : author name, book title, category name
    // Indice : 4 tables jointes avec INNER JOIN

    let result: Awaited<ReturnType<typeof query>>; // <-- remplacez

    assertGreaterThan(result!.rows.length, 0, 'La requete multi-table devrait retourner des resultats');
    // Verification : chaque ligne a les 3 champs
    assert(result!.rows[0].author_name, 'Chaque ligne devrait avoir author_name');
    assert(result!.rows[0].title, 'Chaque ligne devrait avoir title');
    assert(result!.rows[0].category, 'Chaque ligne devrait avoir category');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 8 : COUNT livres par auteur
  // ─────────────────────────────────────────────────────────────────────────────
  await test('COUNT livres par auteur avec GROUP BY + JOIN', async () => {
    // TODO 8 : Comptez le nombre de livres par auteur
    // Utilisez LEFT JOIN pour inclure les auteurs sans livres (count = 0)
    // Indice : SELECT a.name, COUNT(b.id) AS book_count
    //          FROM authors a LEFT JOIN books b ON ...
    //          GROUP BY a.name ORDER BY book_count DESC

    let result: Awaited<ReturnType<typeof query>>; // <-- remplacez

    assertEqual(result!.rows.length, 5, 'Il devrait y avoir 5 auteurs');
    // Hugo et Camus ont 2 livres chacun
    const hugo = result!.rows.find((r: { name: string }) => r.name === 'Victor Hugo');
    assertEqual(parseInt(hugo.book_count), 2, 'Victor Hugo devrait avoir 2 livres');
    // Morrison a 0 livres
    const morrison = result!.rows.find((r: { name: string }) => r.name === 'Toni Morrison');
    assertEqual(parseInt(morrison.book_count), 0, 'Toni Morrison devrait avoir 0 livres');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 9 : Auteurs sans livres (LEFT JOIN WHERE NULL)
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Auteurs sans livres — LEFT JOIN WHERE NULL', async () => {
    // TODO 9 : Trouvez les auteurs qui n'ont AUCUN livre
    // Technique : LEFT JOIN + WHERE b.id IS NULL
    // Indice : SELECT a.name FROM authors a LEFT JOIN books b ON ... WHERE b.id IS NULL

    let result: Awaited<ReturnType<typeof query>>; // <-- remplacez

    assertEqual(result!.rows.length, 1, 'Il devrait y avoir 1 auteur sans livres');
    assertEqual(result!.rows[0].name, 'Toni Morrison', 'L\'auteur sans livres devrait etre Toni Morrison');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 10 : Sous-requete vs JOIN
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Comparaison sous-requete vs JOIN', async () => {
    // TODO 10 : Trouvez les auteurs qui ont au moins un livre publie apres 1950
    // Methode A : sous-requete (SELECT ... WHERE id IN (SELECT ...))
    // Methode B : JOIN avec WHERE + DISTINCT
    // Les deux doivent retourner les memes resultats

    let resultSubquery: Awaited<ReturnType<typeof query>>;   // <-- Methode A : sous-requete
    let resultJoin: Awaited<ReturnType<typeof query>>;       // <-- Methode B : JOIN

    // Les deux methodes doivent retourner les memes auteurs
    assertEqual(resultSubquery!.rows.length, resultJoin!.rows.length,
      'Les deux methodes doivent retourner le meme nombre de resultats');

    const namesSubquery = resultSubquery!.rows.map((r: { name: string }) => r.name).sort();
    const namesJoin = resultJoin!.rows.map((r: { name: string }) => r.name).sort();
    assertEqual(JSON.stringify(namesSubquery), JSON.stringify(namesJoin),
      'Les deux methodes doivent retourner les memes auteurs');

    // Marquez(1967, 1985), Murakami(2002) = 2 auteurs
    assertEqual(resultSubquery!.rows.length, 2, 'Il devrait y avoir 2 auteurs avec des livres apres 1950');
  });

} finally {
  if (client) {
    await query(client, 'DROP TABLE IF EXISTS book_categories, books, categories, authors CASCADE');
    await client.end();
  }
  summary();
}
