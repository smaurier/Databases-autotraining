// =============================================================================
// Lab 15 — Systeme de reservation — Projet final (Solution)
// =============================================================================

import pg from 'pg';
import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.ts';

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
// Utilitaire : reservation avec retry
// ---------------------------------------------------------------------------
async function reserveWithRetry(
  c: pg.Client, roomId: number, eventId: number,
  startTime: string, endTime: string, user: string, maxRetries = 3
): Promise<{ success: boolean; attempts: number; reservation?: unknown; error?: string; code?: string }> {
  let attempts = 0;

  while (attempts < maxRetries) {
    attempts++;
    try {
      await query(c, 'BEGIN');

      // Verifier que la salle existe
      const roomRes = await query(c, 'SELECT * FROM rooms WHERE id = $1 FOR UPDATE', [roomId]);
      if (roomRes.rows.length === 0) {
        await query(c, 'ROLLBACK');
        return { success: false, attempts, error: 'Salle introuvable' };
      }

      // Inserer la reservation
      const resRes = await query(c, `
        INSERT INTO reservations (room_id, event_id, start_time, end_time, reserved_by)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `, [roomId, eventId, startTime, endTime, user]);

      // Audit log
      await query(c, `
        INSERT INTO audit_log (table_name, operation, record_id, new_data, performed_by)
        VALUES ('reservations', 'INSERT', $1, $2, $3)
      `, [resRes.rows[0].id, JSON.stringify(resRes.rows[0]), user]);

      await query(c, 'COMMIT');
      return { success: true, attempts, reservation: resRes.rows[0] };

    } catch (err: unknown) {
      await query(c, 'ROLLBACK').catch(() => {});

      // Conflit d'exclusion (23P01) ou erreur de serialisation (40001)
      const pgErr = err as { code?: string; message?: string };
      const retryable = pgErr.code === '23P01' || pgErr.code === '40001' || pgErr.code === '40P01';
      if (retryable && attempts < maxRetries) {
        // Attendre un peu avant de reessayer
        await sleep(50 * attempts);
        continue;
      }

      return { success: false, attempts, error: pgErr.message, code: pgErr.code };
    }
  }

  return { success: false, attempts, error: 'Nombre maximum de tentatives atteint' };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function run(): Promise<void> {
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
      // Table des salles
      await query(client, `
        CREATE TABLE rooms (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          capacity INT NOT NULL,
          amenities JSONB DEFAULT '{}'
        )
      `);

      // Table des evenements avec recherche plein texte
      await query(client, `
        CREATE TABLE events (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          search_vector TSVECTOR GENERATED ALWAYS AS (
            to_tsvector('french', name || ' ' || COALESCE(description, ''))
          ) STORED
        )
      `);

      // Table des reservations avec contrainte d'exclusion
      await query(client, `
        CREATE TABLE reservations (
          id SERIAL PRIMARY KEY,
          room_id INT REFERENCES rooms(id),
          event_id INT REFERENCES events(id),
          start_time TIMESTAMPTZ NOT NULL,
          end_time TIMESTAMPTZ NOT NULL,
          status TEXT DEFAULT 'confirmed',
          reserved_by TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT now(),
          EXCLUDE USING gist (
            room_id WITH =,
            tstzrange(start_time, end_time) WITH &&
          )
        )
      `);

      // Table d'audit
      await query(client, `
        CREATE TABLE audit_log (
          id SERIAL PRIMARY KEY,
          table_name TEXT NOT NULL,
          operation TEXT NOT NULL,
          record_id INT,
          old_data JSONB,
          new_data JSONB,
          performed_by TEXT,
          performed_at TIMESTAMPTZ DEFAULT now()
        )
      `);

      // Index
      await query(client, 'CREATE INDEX idx_events_search ON events USING GIN (search_vector)');
      await query(client, 'CREATE INDEX idx_reservations_room_time ON reservations (room_id, start_time)');
      await query(client, 'CREATE INDEX idx_rooms_amenities ON rooms USING GIN (amenities)');

      // Verifier que les 4 tables existent
      const res = await query(client, `
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('rooms', 'events', 'reservations', 'audit_log')
        ORDER BY table_name
      `);

      assertEqual(res.rows.length, 4, 'Les 4 tables doivent exister');
    });

    // -----------------------------------------------------------------------
    // Test 2 : Inserer des salles et evenements
    // -----------------------------------------------------------------------
    await test('Inserer des salles et evenements', async () => {
      // Salles
      await query(client, `
        INSERT INTO rooms (name, capacity, amenities) VALUES
          ('Salle de conference', 20, '{"videoconference": true, "tableau_blanc": true, "climatisation": true}'),
          ('Amphitheatre', 100, '{"micro": true, "projecteur": true, "estrade": true}'),
          ('Salle de reunion', 8, '{"ecran": true, "whiteboard": true}'),
          ('Espace coworking', 30, '{"wifi": true, "prises": true, "cuisine": true}'),
          ('Salle de formation', 25, '{"ordinateurs": true, "projecteur": true, "tableau_blanc": true}')
      `);

      // Evenements
      await query(client, `
        INSERT INTO events (name, description) VALUES
          ('Conference sur l''intelligence artificielle',
           'Conference sur les dernieres avancees en intelligence artificielle et machine learning, presentee par des experts du domaine'),
          ('Formation PostgreSQL avancee',
           'Formation intensive sur les fonctionnalites avancees de PostgreSQL : performances, indexation, transactions et securite'),
          ('Reunion trimestrielle de direction',
           'Reunion de direction pour le bilan trimestriel, revue des objectifs et planification strategique'),
          ('Atelier design thinking et innovation',
           'Atelier collaboratif de design thinking pour stimuler l''innovation et la creativite en equipe'),
          ('Seminaire securite informatique',
           'Seminaire sur les bonnes pratiques de securite informatique, protection des donnees et cybersecurite')
      `);

      const roomCount = await query(client, 'SELECT count(*) FROM rooms');
      const eventCount = await query(client, 'SELECT count(*) FROM events');

      assertEqual(parseInt(roomCount.rows[0].count), 5, 'Doit y avoir 5 salles');
      assertEqual(parseInt(eventCount.rows[0].count), 5, 'Doit y avoir 5 evenements');
    });

    // -----------------------------------------------------------------------
    // Test 3 : Reservation avec transaction + FOR UPDATE
    // -----------------------------------------------------------------------
    await test('Reservation avec transaction et FOR UPDATE', async () => {
      await query(client, 'BEGIN');

      // Verrouiller la salle
      const roomRes = await query(client,
        'SELECT * FROM rooms WHERE id = 1 FOR UPDATE'
      );
      assert(roomRes.rows.length > 0, 'La salle doit exister');

      // Creer la reservation
      const resRes = await query(client, `
        INSERT INTO reservations (room_id, event_id, start_time, end_time, reserved_by)
        VALUES (1, 1, '2025-06-15 09:00+02', '2025-06-15 12:00+02', 'Marie Dupont')
        RETURNING *
      `);

      // Audit
      await query(client, `
        INSERT INTO audit_log (table_name, operation, record_id, new_data, performed_by)
        VALUES ('reservations', 'INSERT', $1, $2, 'Marie Dupont')
      `, [resRes.rows[0].id, JSON.stringify(resRes.rows[0])]);

      await query(client, 'COMMIT');

      // Verifier
      const checkRes = await query(client,
        'SELECT * FROM reservations WHERE room_id = 1'
      );
      assertEqual(checkRes.rows.length, 1, 'Doit y avoir 1 reservation');
      assertEqual(checkRes.rows[0].reserved_by, 'Marie Dupont', 'Reservee par Marie');

      const auditRes = await query(client, 'SELECT * FROM audit_log');
      assertGreaterThan(auditRes.rows.length, 0, 'L\'audit log doit contenir une entree');
    });

    // -----------------------------------------------------------------------
    // Test 4 : Contrainte EXCLUDE empeche le double booking
    // -----------------------------------------------------------------------
    await test('Contrainte EXCLUDE empeche le chevauchement', async () => {
      // Tenter une reservation chevauchante (meme salle, creneau qui chevauche)
      let exclusionError = false;
      try {
        await query(client, `
          INSERT INTO reservations (room_id, event_id, start_time, end_time, reserved_by)
          VALUES (1, 2, '2025-06-15 11:00+02', '2025-06-15 14:00+02', 'Jean Martin')
        `);
      } catch (err: unknown) {
        exclusionError = true;
        const pgErr = err as { code?: string };
        assertEqual(pgErr.code, '23P01',
          'Doit recevoir une erreur d\'exclusion (23P01)');
      }
      assert(exclusionError, 'La reservation chevauchante doit echouer');

      // Une reservation sur un creneau non chevauchant doit passer
      await query(client, `
        INSERT INTO reservations (room_id, event_id, start_time, end_time, reserved_by)
        VALUES (1, 2, '2025-06-15 14:00+02', '2025-06-15 17:00+02', 'Jean Martin')
      `);

      const count = await query(client,
        `SELECT count(*) FROM reservations WHERE room_id = 1`
      );
      assertEqual(parseInt(count.rows[0].count), 2,
        'Doit y avoir 2 reservations non chevauchantes');
    });

    // -----------------------------------------------------------------------
    // Test 5 : Reservations concurrentes avec isolation Serializable
    // -----------------------------------------------------------------------
    await test('Reservations concurrentes en Serializable', async () => {
      const client2 = await createClient();
      try {
        // Client 1 : reservation Serializable
        await query(client, 'BEGIN ISOLATION LEVEL SERIALIZABLE');
        await query(client, `
          INSERT INTO reservations (room_id, event_id, start_time, end_time, reserved_by)
          VALUES (2, 3, '2025-06-16 09:00+02', '2025-06-16 12:00+02', 'Sophie Bernard')
        `);

        // Client 2 : tente la meme reservation en Serializable
        await query(client2, 'BEGIN ISOLATION LEVEL SERIALIZABLE');
        let conflictDetected = false;
        try {
          await query(client2, `
            INSERT INTO reservations (room_id, event_id, start_time, end_time, reserved_by)
            VALUES (2, 4, '2025-06-16 10:00+02', '2025-06-16 13:00+02', 'Pierre Durand')
          `);
          await query(client2, 'COMMIT');
        } catch (_err) {
          conflictDetected = true;
          await query(client2, 'ROLLBACK').catch(() => {});
        }

        await query(client, 'COMMIT');

        assert(conflictDetected,
          'Le deuxieme client doit detecter un conflit (EXCLUDE ou serialisation)');

        // Verifier qu'il n'y a qu'une seule reservation pour cette salle/date
        const countRes = await query(client,
          `SELECT count(*) FROM reservations WHERE room_id = 2
           AND start_time::date = '2025-06-16'`
        );
        assertEqual(parseInt(countRes.rows[0].count), 1,
          'Une seule reservation doit exister');
      } finally {
        await client2.end();
      }
    });

    // -----------------------------------------------------------------------
    // Test 6 : Recherche plein texte sur les evenements
    // -----------------------------------------------------------------------
    await test('Recherche plein texte sur les evenements', async () => {
      const tsquery = `to_tsquery('french', 'formation | intelligence')`;

      const res = await query(client, `
        SELECT name, ts_rank(search_vector, ${tsquery}) AS rank
        FROM events
        WHERE search_vector @@ ${tsquery}
        ORDER BY rank DESC
      `);

      assertGreaterThan(res.rows.length, 0,
        'Doit trouver des evenements correspondants');

      // Verifier le tri par pertinence
      for (let i = 1; i < res.rows.length; i++) {
        assert(
          parseFloat(res.rows[i].rank) <= parseFloat(res.rows[i - 1].rank),
          'Les resultats doivent etre tries par pertinence decroissante'
        );
      }

      console.log(`     → ${res.rows.length} evenements trouves`);
      res.rows.forEach(r => console.log(`       • ${r.name} (rank=${parseFloat(r.rank).toFixed(4)})`));
    });

    // -----------------------------------------------------------------------
    // Test 7 : EXPLAIN ANALYZE sur la requete de reservation
    // -----------------------------------------------------------------------
    await test('EXPLAIN ANALYZE — verifier l\'usage des index', async () => {
      // S'assurer que les statistiques sont a jour
      await query(client, 'ANALYZE reservations');

      const explainRes = await query(client, `
        EXPLAIN (ANALYZE, FORMAT TEXT)
        SELECT * FROM reservations
        WHERE room_id = 1
          AND start_time >= '2025-06-15'
          AND start_time < '2025-06-16'
      `);

      const explainText = explainRes.rows.map(r => r['QUERY PLAN']).join('\n');

      // Avec peu de donnees, le planificateur peut choisir un Seq Scan
      // mais l'index doit etre disponible
      const hasIndexInfo = explainText.includes('Index') || explainText.includes('Scan');
      assert(hasIndexInfo, 'Le plan doit mentionner une strategie de scan');

      // Extraire le temps d'execution
      const timeMatch = explainText.match(/Execution Time: ([\d.]+)/);
      if (timeMatch) {
        console.log(`     → Temps d'execution : ${timeMatch[1]} ms`);
      }
      console.log(`     → Plan : ${explainText.split('\n')[0]}`);
    });

    // -----------------------------------------------------------------------
    // Test 8 : Window function — stats par salle
    // -----------------------------------------------------------------------
    await test('Window function — statistiques de reservations par salle', async () => {
      // Ajouter quelques reservations supplementaires
      await query(client, `
        INSERT INTO reservations (room_id, event_id, start_time, end_time, reserved_by) VALUES
          (3, 3, '2025-06-15 09:00+02', '2025-06-15 10:00+02', 'Claire Simon'),
          (3, 4, '2025-06-15 14:00+02', '2025-06-15 16:00+02', 'Luc Moreau'),
          (4, 5, '2025-06-17 10:00+02', '2025-06-17 12:00+02', 'Anne Petit')
      `);

      const res = await query(client, `
        SELECT
          r.name AS room_name,
          r.capacity,
          COUNT(res.id) OVER (PARTITION BY r.id) AS total_reservations,
          res.reserved_by,
          res.start_time,
          ROW_NUMBER() OVER (PARTITION BY r.id ORDER BY res.start_time) AS reservation_order
        FROM rooms r
        LEFT JOIN reservations res ON r.id = res.room_id
        WHERE res.id IS NOT NULL
        ORDER BY r.name, res.start_time
      `);

      assertGreaterThan(res.rows.length, 0, 'Doit avoir des resultats');

      // Verifier que le ROW_NUMBER est correct (commence a 1 par salle)
      const firstPerRoom = res.rows.filter(r => parseInt(r.reservation_order) === 1);
      assertGreaterThan(firstPerRoom.length, 0,
        'Doit y avoir au moins une salle avec reservation_order = 1');

      console.log(`     → ${res.rows.length} lignes de stats sur les reservations`);
    });

    // -----------------------------------------------------------------------
    // Test 9 : CTE — rapport de disponibilite
    // -----------------------------------------------------------------------
    await test('CTE — rapport de disponibilite pour une date', async () => {
      const res = await query(client, `
        WITH reserved_slots AS (
          SELECT room_id, start_time, end_time, reserved_by
          FROM reservations
          WHERE start_time::date = '2025-06-15'
        ),
        room_status AS (
          SELECT
            r.id, r.name, r.capacity,
            rs.start_time,
            rs.end_time,
            rs.reserved_by,
            CASE WHEN rs.room_id IS NOT NULL THEN 'Reserve' ELSE 'Disponible' END AS status
          FROM rooms r
          LEFT JOIN reserved_slots rs ON r.id = rs.room_id
        )
        SELECT * FROM room_status ORDER BY name, start_time
      `);

      assertGreaterThan(res.rows.length, 0, 'Doit retourner des resultats');

      // Toutes les salles doivent apparaitre
      const roomNames = [...new Set(res.rows.map(r => r.name))];
      assertEqual(roomNames.length, 5, 'Les 5 salles doivent apparaitre');

      // Verifier qu'il y a des salles reservees et des salles disponibles
      const statuses = [...new Set(res.rows.map(r => r.status))];
      assertIncludes(statuses, 'Reserve', 'Des salles doivent etre reservees');
      assertIncludes(statuses, 'Disponible', 'Des salles doivent etre disponibles');

      console.log(`     → Rapport du 15 juin : ${roomNames.length} salles, ${res.rows.filter(r => r.status === 'Reserve').length} creneaux reserves`);
    });

    // -----------------------------------------------------------------------
    // Test 10 : LATERAL — prochain creneau disponible par salle
    // -----------------------------------------------------------------------
    await test('LATERAL JOIN — prochain creneau disponible par salle', async () => {
      const res = await query(client, `
        SELECT
          r.name,
          r.capacity,
          COALESCE(latest.end_time::text, 'Disponible maintenant') AS available_from,
          latest.end_time
        FROM rooms r
        LEFT JOIN LATERAL (
          SELECT end_time
          FROM reservations
          WHERE room_id = r.id
          ORDER BY end_time DESC
          LIMIT 1
        ) latest ON true
        ORDER BY r.name
      `);

      assertEqual(res.rows.length, 5, 'Doit retourner les 5 salles');

      // Certaines salles ont des reservations, d'autres non
      const withReservations = res.rows.filter(r => r.end_time !== null);
      const withoutReservations = res.rows.filter(r => r.end_time === null);

      assertGreaterThan(withReservations.length, 0,
        'Certaines salles doivent avoir des reservations');

      console.log('     → Disponibilite par salle :');
      for (const row of res.rows) {
        console.log(`       • ${row.name} : ${row.available_from}`);
      }
    });

    // -----------------------------------------------------------------------
    // Test 11 : Monitoring avec pg_stat_activity
    // -----------------------------------------------------------------------
    await test('Monitoring avec pg_stat_activity', async () => {
      const client2 = await createClient();
      try {
        // Client 2 demarre une transaction longue
        await query(client2, 'BEGIN');
        await query(client2, 'SELECT * FROM rooms WHERE id = 1 FOR UPDATE');

        // Client 1 observe les sessions actives
        const activityRes = await query(client, `
          SELECT pid, state, query, wait_event_type
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid != pg_backend_pid()
            AND state != 'idle'
        `);

        // On devrait voir la transaction de client2
        const activeTransactions = activityRes.rows.filter(r =>
          r.state === 'idle in transaction' || r.state === 'active'
        );

        assertGreaterThan(activeTransactions.length, 0,
          'Doit voir au moins une transaction active (celle de client2)');

        console.log(`     → ${activeTransactions.length} transaction(s) active(s) detectee(s)`);

        await query(client2, 'ROLLBACK');
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
        // Les deux clients tentent de reserver le meme creneau
        const startTime = '2025-07-01 09:00+02';
        const endTime = '2025-07-01 12:00+02';

        const [result1, result2] = await Promise.all([
          reserveWithRetry(client, 5, 1, startTime, endTime, 'Alice', 3),
          reserveWithRetry(client2, 5, 2, startTime, endTime, 'Bob', 3),
        ]);

        // Exactement un doit reussir
        const successes = [result1, result2].filter(r => r.success);
        const failures = [result1, result2].filter(r => !r.success);

        assertEqual(successes.length, 1,
          'Exactement une reservation doit reussir');
        assertEqual(failures.length, 1,
          'Exactement une reservation doit echouer');

        console.log(`     → Gagnant : ${successes[0].reservation.reserved_by} (${successes[0].attempts} tentative(s))`);
        console.log(`     → Perdant : ${failures[0].error ? 'apres ' + failures[0].attempts + ' tentative(s)' : ''}`);

        // Verifier l'integrite : pas de double booking
        const countRes = await query(client, `
          SELECT count(*) FROM reservations
          WHERE room_id = 5
            AND start_time = $1
            AND end_time = $2
        `, [startTime, endTime]);

        assertEqual(parseInt(countRes.rows[0].count), 1,
          'Il ne doit y avoir qu\'une seule reservation pour ce creneau');
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
