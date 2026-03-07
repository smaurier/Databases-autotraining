// =============================================================================
// Lab 15 — Systeme de reservation — Projet final (Exercice)
// =============================================================================

import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.js';

const { test, assert, assertEqual, assertIncludes, assertGreaterThan, assertLessThan, summary } = createTestRunner('Lab 15 — Systeme de reservation');

// ---------------------------------------------------------------------------
// Nettoyage initial
// ---------------------------------------------------------------------------
const CLEANUP_SQL = `
  DROP TABLE IF EXISTS audit_log CASCADE;
  DROP TABLE IF EXISTS reservations CASCADE;
  DROP TABLE IF EXISTS events CASCADE;
  DROP TABLE IF EXISTS rooms CASCADE;
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function run() {
  const client = await createClient();

  try {
    await setupDatabase(client, CLEANUP_SQL);

    // Necessaire pour la contrainte EXCLUDE avec tstzrange
    await query(client, 'CREATE EXTENSION IF NOT EXISTS btree_gist');

    console.log('\n🏨 Lab 15 — Systeme de reservation (Projet final)\n');

    // -----------------------------------------------------------------------
    // Test 1 : Creer le schema complet
    // -----------------------------------------------------------------------
    await test('Creer le schema avec tables, contraintes et index', async () => {
      // TODO:
      // 1. Creer la table rooms (id, name, capacity, amenities JSONB)
      // 2. Creer la table events (id, name, description, search_vector TSVECTOR GENERATED)
      // 3. Creer la table reservations avec :
      //    - FK vers rooms et events
      //    - Contrainte EXCLUDE USING gist pour empecher les chevauchements :
      //      EXCLUDE USING gist (room_id WITH =, tstzrange(start_time, end_time) WITH &&)
      // 4. Creer la table audit_log (id, table_name, operation, record_id, old_data, new_data, ...)
      // 5. Creer les index :
      //    - GIN sur events(search_vector)
      //    - B-tree sur reservations(room_id, start_time)
      //    - GIN sur rooms(amenities)
      // 6. Verifier que les 4 tables existent dans information_schema.tables
    });

    // -----------------------------------------------------------------------
    // Test 2 : Inserer des salles et evenements
    // -----------------------------------------------------------------------
    await test('Inserer des salles et evenements', async () => {
      // TODO:
      // 1. Inserer 5 salles avec des capacites et equipements differents :
      //    - Salle de conference (20 pers, videoconference, tableau blanc)
      //    - Amphitheatre (100 pers, micro, projecteur)
      //    - Salle de reunion (8 pers, ecran, whiteboard)
      //    - Espace coworking (30 pers, wifi, prises)
      //    - Salle de formation (25 pers, ordinateurs, projecteur)
      // 2. Inserer 5 evenements :
      //    - "Conference sur l'intelligence artificielle"
      //    - "Formation PostgreSQL avancee"
      //    - "Reunion trimestrielle de direction"
      //    - "Atelier design thinking et innovation"
      //    - "Seminaire securite informatique"
      // 3. Verifier le nombre de salles et evenements
    });

    // -----------------------------------------------------------------------
    // Test 3 : Faire une reservation avec transaction + FOR UPDATE
    // -----------------------------------------------------------------------
    await test('Reservation avec transaction et FOR UPDATE', async () => {
      // TODO:
      // 1. BEGIN
      // 2. Verifier que la salle existe et n'est pas en maintenance :
      //    SELECT * FROM rooms WHERE id = 1 FOR UPDATE
      // 3. Inserer la reservation :
      //    INSERT INTO reservations (room_id, event_id, start_time, end_time, reserved_by)
      //    VALUES (1, 1, '2025-06-15 09:00', '2025-06-15 12:00', 'Marie Dupont')
      // 4. Inserer dans audit_log
      // 5. COMMIT
      // 6. Verifier que la reservation existe
    });

    // -----------------------------------------------------------------------
    // Test 4 : Empecher le double booking (contrainte EXCLUDE)
    // -----------------------------------------------------------------------
    await test('Contrainte EXCLUDE empeche le chevauchement', async () => {
      // TODO:
      // 1. Tenter d'inserer une reservation qui chevauche la precedente
      //    (meme salle, meme creneau ou creneau qui se chevauche)
      // 2. Capturer l'erreur (code '23P01' = exclusion_violation)
      // 3. Verifier que l'erreur est bien une violation de contrainte d'exclusion
      // 4. Verifier qu'une reservation sur un creneau DIFFERENT passe bien
    });

    // -----------------------------------------------------------------------
    // Test 5 : Reservations concurrentes avec isolation Serializable
    // -----------------------------------------------------------------------
    await test('Reservations concurrentes en Serializable', async () => {
      const client2 = await createClient();
      try {
        // TODO:
        // 1. Client 1 : BEGIN ISOLATION LEVEL SERIALIZABLE
        //    Inserer une reservation pour salle 2, le 16 juin
        // 2. Client 2 : BEGIN ISOLATION LEVEL SERIALIZABLE
        //    Tenter une reservation sur la meme salle, meme creneau
        // 3. Verifier que la contrainte EXCLUDE bloque le 2eme
        // 4. COMMIT / ROLLBACK selon les cas
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 6 : Recherche plein texte sur les evenements
    // -----------------------------------------------------------------------
    await test('Recherche plein texte sur les evenements', async () => {
      // TODO:
      // 1. Rechercher les evenements correspondant a 'formation | intelligence' :
      //    SELECT name, ts_rank(search_vector, q) AS rank
      //    FROM events, to_tsquery('french', 'formation | intelligence') q
      //    WHERE search_vector @@ q
      //    ORDER BY rank DESC
      // 2. Verifier qu'on trouve au moins 2 evenements
      // 3. Verifier que le premier resultat est le plus pertinent
    });

    // -----------------------------------------------------------------------
    // Test 7 : EXPLAIN ANALYZE sur la requete de reservation
    // -----------------------------------------------------------------------
    await test('EXPLAIN ANALYZE — verifier l\'usage des index', async () => {
      // TODO:
      // 1. EXPLAIN (ANALYZE, FORMAT TEXT)
      //    SELECT * FROM reservations
      //    WHERE room_id = 1 AND start_time >= '2025-06-15' AND start_time < '2025-06-16'
      // 2. Verifier que le plan utilise un index (Index Scan ou Bitmap Index Scan)
      // 3. Afficher le temps d'execution
    });

    // -----------------------------------------------------------------------
    // Test 8 : Window function — stats par salle
    // -----------------------------------------------------------------------
    await test('Window function — statistiques de reservations par salle', async () => {
      // TODO:
      // 1. Ajouter quelques reservations supplementaires pour avoir des stats
      // 2. Requete avec window function :
      //    SELECT r.name AS room_name,
      //      COUNT(*) OVER (PARTITION BY r.id) AS total_reservations,
      //      ROW_NUMBER() OVER (PARTITION BY r.id ORDER BY res.start_time) AS reservation_order
      //    FROM rooms r
      //    LEFT JOIN reservations res ON r.id = res.room_id
      // 3. Verifier les resultats
    });

    // -----------------------------------------------------------------------
    // Test 9 : CTE — rapport de disponibilite
    // -----------------------------------------------------------------------
    await test('CTE — rapport de disponibilite pour une date', async () => {
      // TODO:
      // 1. CTE qui liste les creneaux reserves pour une date :
      //    WITH reserved_slots AS (
      //      SELECT room_id, start_time, end_time
      //      FROM reservations
      //      WHERE start_time::date = '2025-06-15'
      //    )
      //    SELECT r.name, r.capacity,
      //      COALESCE(rs.start_time::text, 'Disponible') AS status
      //    FROM rooms r
      //    LEFT JOIN reserved_slots rs ON r.id = rs.room_id
      // 2. Verifier que toutes les salles apparaissent
      // 3. Verifier que les salles reservees montrent le creneau
    });

    // -----------------------------------------------------------------------
    // Test 10 : LATERAL — prochain creneau disponible par salle
    // -----------------------------------------------------------------------
    await test('LATERAL JOIN — prochain creneau disponible par salle', async () => {
      // TODO:
      // 1. Pour chaque salle, trouver le dernier creneau reserve :
      //    SELECT r.name, r.capacity, latest.end_time AS next_available_from
      //    FROM rooms r,
      //    LATERAL (
      //      SELECT end_time
      //      FROM reservations
      //      WHERE room_id = r.id AND end_time > now()
      //      ORDER BY end_time DESC
      //      LIMIT 1
      //    ) latest
      // 2. Si pas de reservation, la salle est disponible maintenant
      // 3. Verifier les resultats
    });

    // -----------------------------------------------------------------------
    // Test 11 : Monitoring avec pg_stat_activity
    // -----------------------------------------------------------------------
    await test('Monitoring avec pg_stat_activity', async () => {
      const client2 = await createClient();
      try {
        // TODO:
        // 1. Client 2 : demarrer une transaction longue (BEGIN + SELECT ... FOR UPDATE)
        // 2. Client 1 : observer dans pg_stat_activity :
        //    SELECT pid, state, query, query_start
        //    FROM pg_stat_activity
        //    WHERE datname = current_database() AND state != 'idle'
        // 3. Verifier qu'on voit la transaction de client 2
        // 4. ROLLBACK les transactions
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 12 : Scenario complet — reservation concurrente avec retry
    // -----------------------------------------------------------------------
    await test('Scenario complet — reservation concurrente avec retry', async () => {
      const client2 = await createClient();
      try {
        // TODO:
        // 1. Implementer une fonction reserveWithRetry(client, roomId, eventId, start, end, user, maxRetries)
        //    qui :
        //    - Tente la reservation dans une transaction
        //    - Si conflit (EXCLUDE violation ou serialization failure), retry avec delai
        //    - Retourne { success: true/false, attempts: n }
        // 2. Lancer deux reservations concurrentes sur le meme creneau
        // 3. Verifier qu'une seule reussit
        // 4. Verifier que l'autre a retry et echoue
        // 5. Verifier l'integrite des donnees (pas de double booking)
      } finally {
        await client2.end();
      }
    });

    summary();
  } finally {
    await teardownDatabase(client, `
      DROP TABLE IF EXISTS audit_log CASCADE;
      DROP TABLE IF EXISTS reservations CASCADE;
      DROP TABLE IF EXISTS events CASCADE;
      DROP TABLE IF EXISTS rooms CASCADE;
    `);
    await client.end();
  }
}

run().catch(console.error);
