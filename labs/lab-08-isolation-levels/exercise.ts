// =============================================================================
// Lab 08 — Niveaux d'isolation (Exercice)
// =============================================================================
// Objectifs :
//   - Observer les phenomenes de concurrence
//   - Comprendre Read Committed, Repeatable Read, Serializable
//   - Observer MVCC (xmin/xmax)
//   - Implementer une logique de retry
// =============================================================================

import pg from 'pg';
import { createTestRunner, createClient, query, sleep } from '../db-test-utils.ts';

const { test, assert, assertEqual, assertGreaterThan, summary } = createTestRunner('Lab 08 — Niveaux d\'isolation');

let client1: pg.Client | undefined;
let client2: pg.Client | undefined;

async function resetCounters(c: pg.Client): Promise<void> {
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

    // TODO 1 : Demontrez qu'en Read Committed, une meme requete peut retourner
    // des valeurs differentes si une autre transaction commite entre-temps.
    //
    // Scenario :
    // 1. Client1 : BEGIN (Read Committed est le defaut)
    // 2. Client1 : SELECT value FROM counters WHERE name = 'compteur_a'
    //    → devrait retourner 100
    // 3. Client2 : UPDATE counters SET value = 150 WHERE name = 'compteur_a'
    //    (pas de transaction explicite = auto-commit)
    // 4. Client1 : SELECT value FROM counters WHERE name = 'compteur_a'
    //    → devrait retourner 150 (valeur modifiee !)
    // 5. Client1 : COMMIT

    let firstRead;  // <-- valeur de la 1ere lecture
    let secondRead; // <-- valeur de la 2eme lecture

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

    // TODO 2 : Montrez qu'en Read Committed, on ne voit pas les modifications
    // non commitees d'une autre transaction.
    //
    // Scenario :
    // 1. Client2 : BEGIN
    // 2. Client2 : UPDATE counters SET value = 999 WHERE name = 'compteur_a'
    // 3. Client1 : SELECT value FROM counters WHERE name = 'compteur_a'
    //    → devrait toujours retourner 100 (pas de dirty read)
    // 4. Client2 : ROLLBACK

    let readValue; // <-- valeur lue par client1

    assertEqual(readValue, 100, 'En Read Committed, on ne devrait pas voir le dirty write (999)');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 3 : Repeatable Read — snapshot fixe
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Repeatable Read : snapshot fixe', async () => {
    await resetCounters(client1);

    // TODO 3 : Montrez qu'en Repeatable Read, le snapshot est fixe au debut
    // de la transaction.
    //
    // Scenario :
    // 1. Client1 : BEGIN ISOLATION LEVEL REPEATABLE READ
    // 2. Client1 : SELECT value → 100
    // 3. Client2 : UPDATE value = 150 (auto-commit)
    // 4. Client1 : SELECT value → toujours 100 (snapshot fixe !)
    // 5. Client1 : COMMIT

    let firstRead;  // <-- 1ere lecture
    let secondRead; // <-- 2eme lecture

    assertEqual(firstRead, 100, 'Premiere lecture = 100');
    assertEqual(secondRead, 100, 'Deuxieme lecture = 100 (snapshot fixe, malgre le commit de client2)');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 4 : Repeatable Read — erreur de serialisation
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Repeatable Read : erreur de serialisation sur conflit', async () => {
    await resetCounters(client1);

    // TODO 4 : Montrez qu'en Repeatable Read, un UPDATE conflictuel echoue
    //
    // Scenario :
    // 1. Client1 : BEGIN ISOLATION LEVEL REPEATABLE READ
    // 2. Client1 : SELECT value FROM counters WHERE name = 'compteur_a' → 100
    // 3. Client2 : UPDATE counters SET value = 200 WHERE name = 'compteur_a' (auto-commit)
    // 4. Client1 : UPDATE counters SET value = 300 WHERE name = 'compteur_a'
    //    → ERREUR : could not serialize access
    // 5. Client1 : ROLLBACK (necessaire apres l'erreur)

    let serializationError = false;

    // Indice : attrapez l'erreur du UPDATE de client1 avec try/catch
    // L'erreur contiendra "could not serialize access"

    assert(serializationError, 'Un UPDATE conflictuel devrait provoquer une erreur de serialisation');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 5 : Serializable — write skew
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Serializable : detection d\'anomalie (write skew)', async () => {
    await resetCounters(client1);

    // TODO 5 : Demontrez le write skew en Serializable
    // Le write skew : deux transactions lisent la meme donnee et ecrivent
    // des donnees differentes, creant une inconsistance.
    //
    // Scenario :
    // 1. Client1 : BEGIN ISOLATION LEVEL SERIALIZABLE
    // 2. Client2 : BEGIN ISOLATION LEVEL SERIALIZABLE
    // 3. Client1 : SELECT value FROM counters WHERE name = 'compteur_a' → 100
    // 4. Client2 : SELECT value FROM counters WHERE name = 'compteur_a' → 100
    // 5. Client1 : UPDATE counters SET value = 50 WHERE name = 'compteur_b'
    // 6. Client2 : UPDATE counters SET value = 75 WHERE name = 'compteur_a'
    // 7. Client1 : COMMIT → OK
    // 8. Client2 : COMMIT → ERREUR (serialization failure)

    let writeSkewDetected = false;

    // Indice : le COMMIT de client2 devrait echouer si PostgreSQL detecte l'anomalie

    assert(writeSkewDetected, 'Le write skew devrait etre detecte en Serializable');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 6 : MVCC — xmin/xmax
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Observation MVCC avec xmin/xmax', async () => {
    await resetCounters(client1);

    // TODO 6 : Observez les colonnes systeme xmin et xmax
    // xmin = ID de la transaction qui a cree la version de la ligne
    // xmax = ID de la transaction qui a supprime/modifie la version (0 si actif)
    //
    // 1. SELECT xmin, xmax, * FROM counters WHERE name = 'compteur_a'
    //    → xmax devrait etre 0 (pas de modification en cours)
    // 2. BEGIN une transaction et UPDATE le compteur
    //    → Dans une autre session, xmax change
    // 3. COMMIT
    //    → La nouvelle version a un xmin different

    // Lecture initiale
    let result; // <-- SELECT xmin, xmax, * FROM counters ...

    const initialXmin = result.rows[0].xmin;
    const initialXmax = result.rows[0].xmax;
    console.log(`    xmin initial : ${initialXmin}`);
    console.log(`    xmax initial : ${initialXmax}`);

    // Le xmax devrait etre 0 (aucune modification en cours)
    assertEqual(parseInt(initialXmax), 0, 'xmax devrait etre 0 pour une ligne non modifiee');
    assertGreaterThan(parseInt(initialXmin), 0, 'xmin devrait etre > 0');

    // Apres un UPDATE, le xmin change
    await query(client1, "UPDATE counters SET value = 999 WHERE name = 'compteur_a'");

    // Relecture
    // TODO : relisez xmin, xmax apres l'UPDATE

    let resultAfter; // <-- remplacez

    const newXmin = resultAfter.rows[0].xmin;
    console.log(`    xmin apres UPDATE : ${newXmin}`);
    assert(parseInt(newXmin) > parseInt(initialXmin),
      'Le xmin devrait augmenter apres un UPDATE (nouvelle version)');
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 7 : Phantom reads
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Phantom reads : Read Committed vs Repeatable Read', async () => {
    await resetCounters(client1);

    // TODO 7 : Demontrez les phantom reads en Read Committed
    // et leur absence en Repeatable Read
    //
    // Scenario Read Committed :
    // 1. Client1 : BEGIN
    // 2. Client1 : SELECT COUNT(*) FROM counters → 2
    // 3. Client2 : INSERT INTO counters (name, value) VALUES ('compteur_c', 300)
    // 4. Client1 : SELECT COUNT(*) FROM counters → 3 (phantom read !)
    // 5. Client1 : COMMIT
    //
    // Scenario Repeatable Read :
    // 1. Client1 : BEGIN ISOLATION LEVEL REPEATABLE READ
    // 2. Client1 : SELECT COUNT(*) FROM counters → (valeur actuelle)
    // 3. Client2 : INSERT INTO counters (name, value) VALUES ('compteur_d', 400)
    // 4. Client1 : SELECT COUNT(*) FROM counters → meme valeur (pas de phantom !)
    // 5. Client1 : COMMIT

    // Phase 1 : Read Committed
    let rcCount1, rcCount2; // les deux counts en Read Committed

    assert(rcCount1 !== rcCount2, `Read Committed devrait montrer un phantom read (${rcCount1} vs ${rcCount2})`);

    // Phase 2 : Repeatable Read
    let rrCount1, rrCount2; // les deux counts en Repeatable Read

    assertEqual(rrCount1, rrCount2, `Repeatable Read ne devrait PAS montrer de phantom read (${rrCount1} vs ${rrCount2})`);
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 8 : Logique de retry pour serialisation
  // ─────────────────────────────────────────────────────────────────────────────
  await test('Logique de retry pour erreurs de serialisation', async () => {
    await resetCounters(client1);

    // TODO 8 : Implementez une fonction qui retente une transaction en cas d'erreur
    // de serialisation. Utilisez Repeatable Read ou Serializable.
    //
    // La fonction retryTransaction devrait :
    // 1. Executer la fonction passee en parametre dans une transaction
    // 2. Si l'erreur contient "could not serialize", retenter (max 3 fois)
    // 3. Sinon, propager l'erreur
    //
    // async function retryTransaction(client, fn, maxRetries = 3) { ... }

    async function retryTransaction(clientArg: pg.Client, fn: (c: pg.Client) => Promise<unknown>, maxRetries = 3): Promise<unknown> {
      // TODO : implementez la logique de retry
      // Indice :
      // for (let attempt = 1; attempt <= maxRetries; attempt++) {
      //   try {
      //     await query(clientArg, 'BEGIN ISOLATION LEVEL REPEATABLE READ');
      //     const result = await fn(clientArg);
      //     await query(clientArg, 'COMMIT');
      //     return result;
      //   } catch (err) {
      //     await query(clientArg, 'ROLLBACK');
      //     if (err.message.includes('could not serialize') && attempt < maxRetries) continue;
      //     throw err;
      //   }
      // }
    }

    // Test : la transaction devrait reussir (pas de conflit ici)
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
