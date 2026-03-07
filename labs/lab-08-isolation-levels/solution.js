// =============================================================================
// Lab 08 — Niveaux d'isolation (Solution)
// =============================================================================
// 8 tests demontrant les phenomenes de concurrence et les niveaux d'isolation
// de PostgreSQL : Read Committed, Repeatable Read, Serializable.
// =============================================================================

import { createTestRunner, createClient, query, sleep } from '../db-test-utils.js';

const { test, assert, assertEqual, assertGreaterThan, summary } = createTestRunner('Lab 08 — Niveaux d\'isolation');

let client1;
let client2;

async function resetCounters(c) {
  await query(c, 'DROP TABLE IF EXISTS counters');
  await query(c, `
    CREATE TABLE counters (
      id    SERIAL PRIMARY KEY,
      name  TEXT NOT NULL UNIQUE,
      value INTEGER NOT NULL DEFAULT 0
    )
  `);
  await query(c, `
    INSERT INTO counters (name, value) VALUES
      ('compteur_a', 100),
      ('compteur_b', 200)
  `);
}

try {
  client1 = await createClient();
  client2 = await createClient();

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 1 : Read Committed — non-repeatable read
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Read Committed : non-repeatable read', async () => {
    await resetCounters(client1);

    // Client1 demarre une transaction Read Committed (defaut)
    await query(client1, 'BEGIN');

    // Premiere lecture : 100
    const read1 = await query(client1, "SELECT value FROM counters WHERE name = 'compteur_a'");
    const firstRead = read1.rows[0].value;

    // Client2 modifie la valeur (auto-commit)
    await query(client2, "UPDATE counters SET value = 150 WHERE name = 'compteur_a'");

    // Deuxieme lecture : 150 (la valeur a change !)
    const read2 = await query(client1, "SELECT value FROM counters WHERE name = 'compteur_a'");
    const secondRead = read2.rows[0].value;

    await query(client1, 'COMMIT');

    assert(firstRead !== secondRead,
      `En Read Committed, les deux lectures devraient etre differentes (${firstRead} vs ${secondRead})`);
    assertEqual(firstRead, 100, 'Premiere lecture = 100');
    assertEqual(secondRead, 150, 'Deuxieme lecture = 150 (apres commit de client2)');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2 : Read Committed — pas de dirty read
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Read Committed : pas de dirty read', async () => {
    await resetCounters(client1);

    // Client2 commence une transaction et modifie sans commiter
    await query(client2, 'BEGIN');
    await query(client2, "UPDATE counters SET value = 999 WHERE name = 'compteur_a'");

    // Client1 lit la valeur : elle devrait etre 100 (pas de dirty read)
    const result = await query(client1, "SELECT value FROM counters WHERE name = 'compteur_a'");
    const readValue = result.rows[0].value;

    // Client2 annule
    await query(client2, 'ROLLBACK');

    assertEqual(readValue, 100, 'En Read Committed, on ne devrait pas voir le dirty write (999)');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3 : Repeatable Read — snapshot fixe
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Repeatable Read : snapshot fixe', async () => {
    await resetCounters(client1);

    // Client1 demarre une transaction Repeatable Read
    await query(client1, 'BEGIN ISOLATION LEVEL REPEATABLE READ');

    // Premiere lecture
    const read1 = await query(client1, "SELECT value FROM counters WHERE name = 'compteur_a'");
    const firstRead = read1.rows[0].value;

    // Client2 modifie et commite
    await query(client2, "UPDATE counters SET value = 150 WHERE name = 'compteur_a'");

    // Deuxieme lecture : TOUJOURS 100 (snapshot fixe)
    const read2 = await query(client1, "SELECT value FROM counters WHERE name = 'compteur_a'");
    const secondRead = read2.rows[0].value;

    await query(client1, 'COMMIT');

    assertEqual(firstRead, 100, 'Premiere lecture = 100');
    assertEqual(secondRead, 100, 'Deuxieme lecture = 100 (snapshot fixe, malgre le commit de client2)');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4 : Repeatable Read — erreur de serialisation
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Repeatable Read : erreur de serialisation sur conflit', async () => {
    await resetCounters(client1);

    // Client1 demarre une transaction Repeatable Read et lit
    await query(client1, 'BEGIN ISOLATION LEVEL REPEATABLE READ');
    await query(client1, "SELECT value FROM counters WHERE name = 'compteur_a'");

    // Client2 modifie et commite la meme ligne
    await query(client2, "UPDATE counters SET value = 200 WHERE name = 'compteur_a'");

    // Client1 essaie de modifier la meme ligne → erreur
    let serializationError = false;
    try {
      await query(client1, "UPDATE counters SET value = 300 WHERE name = 'compteur_a'");
    } catch (err) {
      serializationError = err.message.includes('could not serialize');
    }

    // Rollback necessaire apres l'erreur
    await query(client1, 'ROLLBACK');

    assert(serializationError, 'Un UPDATE conflictuel devrait provoquer une erreur de serialisation');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5 : Serializable — write skew
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Serializable : detection d\'anomalie (write skew)', async () => {
    // Le write skew peut ne pas etre detecte a chaque tentative selon le timing.
    // On utilise une boucle de retry (max 3 tentatives) pour rendre le test robuste.
    let writeSkewDetected = false;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await resetCounters(client1);

      // Les deux clients demarrent en Serializable
      await query(client1, 'BEGIN ISOLATION LEVEL SERIALIZABLE');
      await query(client2, 'BEGIN ISOLATION LEVEL SERIALIZABLE');

      // Les deux lisent les DEUX compteurs pour creer des dependances croisees
      await query(client1, "SELECT value FROM counters WHERE name IN ('compteur_a', 'compteur_b')");
      await query(client2, "SELECT value FROM counters WHERE name IN ('compteur_a', 'compteur_b')");

      // Client1 modifie compteur_b, client2 modifie compteur_a
      // C'est un cas de "write skew" : les lectures se chevauchent
      await query(client1, "UPDATE counters SET value = 50 WHERE name = 'compteur_b'");
      await query(client2, "UPDATE counters SET value = 75 WHERE name = 'compteur_a'");

      // Client1 commite en premier → OK
      await query(client1, 'COMMIT');

      // Client2 tente de commiter → erreur de serialisation
      try {
        await query(client2, 'COMMIT');
      } catch (err) {
        writeSkewDetected = true;
        await query(client2, 'ROLLBACK');
      }

      if (writeSkewDetected) break;

      // Si pas detecte, rollback propre et reessayer
      console.log(`    Tentative ${attempt}/${maxAttempts} : write skew non detecte, nouvelle tentative...`);
      await query(client1, 'ROLLBACK').catch(() => {});
      await query(client2, 'ROLLBACK').catch(() => {});
    }

    assert(writeSkewDetected, 'Le write skew devrait etre detecte en Serializable');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6 : MVCC — xmin/xmax
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Observation MVCC avec xmin/xmax', async () => {
    await resetCounters(client1);

    // Lecture initiale des colonnes systeme
    const result = await query(client1, "SELECT xmin, xmax, * FROM counters WHERE name = 'compteur_a'");
    const initialXmin = result.rows[0].xmin;
    const initialXmax = result.rows[0].xmax;
    console.log(`    xmin initial : ${initialXmin}`);
    console.log(`    xmax initial : ${initialXmax}`);

    // xmax = 0 signifie que la ligne n'est pas en cours de modification
    assertEqual(parseInt(initialXmax), 0, 'xmax devrait etre 0 pour une ligne non modifiee');
    assertGreaterThan(parseInt(initialXmin), 0, 'xmin devrait etre > 0');

    // Apres un UPDATE, le xmin de la nouvelle version change
    await query(client1, "UPDATE counters SET value = 999 WHERE name = 'compteur_a'");

    const resultAfter = await query(client1, "SELECT xmin, xmax, * FROM counters WHERE name = 'compteur_a'");
    const newXmin = resultAfter.rows[0].xmin;
    console.log(`    xmin apres UPDATE : ${newXmin}`);
    assert(parseInt(newXmin) > parseInt(initialXmin),
      'Le xmin devrait augmenter apres un UPDATE (nouvelle version de la ligne)');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 7 : Phantom reads
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Phantom reads : Read Committed vs Repeatable Read', async () => {
    await resetCounters(client1);

    // Phase 1 : Read Committed → phantom read
    await query(client1, 'BEGIN');

    const rc1 = await query(client1, 'SELECT COUNT(*)::int AS cnt FROM counters');
    const rcCount1 = rc1.rows[0].cnt;

    // Client2 insere une ligne (auto-commit)
    await query(client2, "INSERT INTO counters (name, value) VALUES ('compteur_c', 300)");

    const rc2 = await query(client1, 'SELECT COUNT(*)::int AS cnt FROM counters');
    const rcCount2 = rc2.rows[0].cnt;

    await query(client1, 'COMMIT');

    assert(rcCount1 !== rcCount2, `Read Committed devrait montrer un phantom read (${rcCount1} vs ${rcCount2})`);

    // Phase 2 : Repeatable Read → pas de phantom read
    await query(client1, 'BEGIN ISOLATION LEVEL REPEATABLE READ');

    const rr1 = await query(client1, 'SELECT COUNT(*)::int AS cnt FROM counters');
    const rrCount1 = rr1.rows[0].cnt;

    // Client2 insere une autre ligne
    await query(client2, "INSERT INTO counters (name, value) VALUES ('compteur_d', 400)");

    const rr2 = await query(client1, 'SELECT COUNT(*)::int AS cnt FROM counters');
    const rrCount2 = rr2.rows[0].cnt;

    await query(client1, 'COMMIT');

    assertEqual(rrCount1, rrCount2, `Repeatable Read ne devrait PAS montrer de phantom read (${rrCount1} vs ${rrCount2})`);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 8 : Logique de retry pour serialisation
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Logique de retry pour erreurs de serialisation', async () => {
    await resetCounters(client1);

    // Fonction de retry pour les erreurs de serialisation
    async function retryTransaction(clientArg, fn, maxRetries = 3) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await query(clientArg, 'BEGIN ISOLATION LEVEL REPEATABLE READ');
          const result = await fn(clientArg);
          await query(clientArg, 'COMMIT');
          return result;
        } catch (err) {
          await query(clientArg, 'ROLLBACK');
          if (err.message.includes('could not serialize') && attempt < maxRetries) {
            console.log(`    Tentative ${attempt} echouee, nouvelle tentative...`);
            continue;
          }
          throw err;
        }
      }
    }

    // Test : transaction simple qui reussit
    const result = await retryTransaction(client1, async (c) => {
      const res = await query(c, "SELECT value FROM counters WHERE name = 'compteur_a'");
      return res.rows[0].value;
    });

    assertEqual(result, 100, 'La transaction avec retry devrait retourner 100');
  });

} finally {
  if (client1) {
    await query(client1, 'DROP TABLE IF EXISTS counters');
    await client1.end();
  }
  if (client2) {
    await client2.end();
  }
  summary();
}
