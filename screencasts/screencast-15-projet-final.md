# Screencast 15 — Projet final : Système de réservation

## Informations
- **Durée estimée** : 25-30 min
- **Module** : `modules/15-projet-final.md`
- **Lab associé** : `labs/lab-15-systeme-reservation/`
- **Prérequis** : Tous les modules précédents terminés, PostgreSQL running, base `course_db`

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] **Deux terminaux** ouverts dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] `psql` connecté à `course_db`
- [ ] Node.js prêt pour les scripts

## Script

### [00:00-03:00] Architecture du projet

> Bienvenue dans le projet final ! On va construire un système de réservation de salles complet, en utilisant tout ce qu'on a appris : schéma relationnel, transactions, index, concurrence, full-text search et monitoring. C'est le test ultime pour consolider vos connaissances.

**Action** : Afficher le schéma d'architecture du projet (diagramme ER).

> Le système comprend quatre entités principales : les salles (rooms), les utilisateurs (users), les réservations (bookings) et les événements (events). Une réservation lie un utilisateur à une salle pour une période donnée. Le défi : garantir qu'il n'y a jamais deux réservations qui se chevauchent sur la même salle.

**Action** : Dessiner ou afficher le diagramme entité-relation avec les cardinalités.

```sql
-- Créer le schéma du projet
CREATE SCHEMA IF NOT EXISTS reservation;
SET search_path TO reservation, public;
```

### [03:00-08:00] Schema + EXCLUDE constraints

> Commençons par le schéma. La contrainte EXCLUDE est la fonctionnalité clé : elle interdit les chevauchements de ranges au niveau de la base de données.

**Action** : Créer les tables une par une, en expliquant chaque choix de conception.

```sql
-- Extension nécessaire pour EXCLUDE avec GiST
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Table des salles
CREATE TABLE reservation.rooms (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(100) NOT NULL UNIQUE,
    capacity    INTEGER NOT NULL CHECK (capacity > 0),
    floor       INTEGER NOT NULL,
    equipment   JSONB NOT NULL DEFAULT '[]',
    description TEXT,
    search_vector TSVECTOR,
    is_active   BOOLEAN DEFAULT true
);

-- Table des utilisateurs
CREATE TABLE reservation.users (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username    VARCHAR(50) NOT NULL UNIQUE,
    full_name   VARCHAR(100) NOT NULL,
    email       VARCHAR(255) NOT NULL UNIQUE,
    department  VARCHAR(50) NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Table des réservations avec contrainte EXCLUDE
CREATE TABLE reservation.bookings (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id     INTEGER NOT NULL REFERENCES reservation.rooms(id),
    user_id     INTEGER NOT NULL REFERENCES reservation.users(id),
    during      TSTZRANGE NOT NULL,
    title       VARCHAR(200) NOT NULL,
    description TEXT,
    status      VARCHAR(20) NOT NULL DEFAULT 'confirmed'
                CHECK (status IN ('confirmed', 'cancelled', 'completed')),
    created_at  TIMESTAMPTZ DEFAULT NOW(),

    -- LA contrainte clé : pas de chevauchement par salle
    CONSTRAINT no_overlap EXCLUDE USING GIST (
        room_id WITH =,
        during WITH &&
    ) WHERE (status != 'cancelled')
);

-- Table des événements (log d'activité)
CREATE TABLE reservation.events (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id  INTEGER REFERENCES reservation.bookings(id),
    event_type  VARCHAR(30) NOT NULL,
    payload     JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Vérifier la structure
\dt reservation.*
\d+ reservation.bookings
```

> La contrainte `EXCLUDE USING GIST (room_id WITH =, during WITH &&)` dit : pour une même salle (room_id =), les périodes (during) ne doivent pas se chevaucher (&&). La clause WHERE exclut les réservations annulées. C'est la base de données qui garantit l'intégrité, pas l'application.

**Action** : Mettre en évidence la contrainte EXCLUDE dans le CREATE TABLE. Expliquer chaque partie.

```sql
-- Peupler les données de base
INSERT INTO reservation.rooms (name, capacity, floor, equipment, description) VALUES
    ('Salle Turing', 10, 1, '["vidéoprojecteur", "tableau blanc", "visio"]', 'Grande salle de réunion avec équipement complet'),
    ('Salle Lovelace', 6, 1, '["écran TV", "tableau blanc"]', 'Salle moyenne idéale pour les stand-ups'),
    ('Salle Hopper', 20, 2, '["vidéoprojecteur", "micro", "visio", "tableau blanc"]', 'Salle de conférence pour les grands groupes'),
    ('Phone Booth A', 1, 1, '["visio"]', 'Cabine téléphonique pour les appels privés'),
    ('Phone Booth B', 1, 2, '["visio"]', 'Cabine téléphonique pour les appels privés');

INSERT INTO reservation.users (username, full_name, email, department) VALUES
    ('amartin', 'Alice Martin', 'alice@company.com', 'Engineering'),
    ('bdupont', 'Bob Dupont', 'bob@company.com', 'Product'),
    ('cpetit', 'Charlie Petit', 'charlie@company.com', 'Engineering'),
    ('dleroy', 'Diana Leroy', 'diana@company.com', 'Marketing'),
    ('emoreau', 'Eve Moreau', 'eve@company.com', 'Engineering');
```

### [08:00-12:30] Transaction design

> Réserver une salle doit être atomique : vérifier la disponibilité, créer la réservation, et logger l'événement — tout dans une seule transaction.

**Action** : Implémenter la logique de réservation.

```sql
-- Réservation réussie
BEGIN;

INSERT INTO reservation.bookings (room_id, user_id, during, title, description)
VALUES (
    1,  -- Salle Turing
    1,  -- Alice
    '[2025-06-15 09:00, 2025-06-15 10:00)'::tstzrange,
    'Daily standup Engineering',
    'Réunion quotidienne de l''équipe'
)
RETURNING id, room_id, during, title;

-- Logger l'événement
INSERT INTO reservation.events (booking_id, event_type, payload)
VALUES (
    currval(pg_get_serial_sequence('reservation.bookings', 'id')),
    'booking_created',
    jsonb_build_object('room', 'Salle Turing', 'user', 'Alice Martin')
);

COMMIT;

-- Tenter une réservation qui chevauche
BEGIN;

INSERT INTO reservation.bookings (room_id, user_id, during, title)
VALUES (
    1,  -- Même salle Turing
    2,  -- Bob
    '[2025-06-15 09:30, 2025-06-15 11:00)'::tstzrange,
    'Revue produit'
);
-- ERREUR : conflicting key value violates exclusion constraint "no_overlap"

ROLLBACK;
```

> La contrainte EXCLUDE a fait son travail : la deuxième réservation chevauche la première sur la Salle Turing (9h30 est entre 9h et 10h). L'erreur est déclenchée automatiquement par PostgreSQL — pas besoin de vérification manuelle dans l'application.

**Action** : Montrer l'erreur de conflit et expliquer que c'est la contrainte EXCLUDE qui l'a déclenchée.

```javascript
// demo-booking.js
const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost', port: 5432,
  user: 'postgres', password: 'secret', database: 'course_db',
});

async function createBooking(roomId, userId, start, end, title) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET search_path TO reservation, public');

    const { rows } = await client.query(
      `INSERT INTO bookings (room_id, user_id, during, title)
       VALUES ($1, $2, tstzrange($3, $4), $5)
       RETURNING id, during`,
      [roomId, userId, start, end, title]
    );

    await client.query(
      `INSERT INTO events (booking_id, event_type, payload)
       VALUES ($1, 'booking_created', $2)`,
      [rows[0].id, JSON.stringify({ room_id: roomId, user_id: userId })]
    );

    await client.query('COMMIT');
    console.log('Réservation créée :', rows[0]);
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23P01') {
      // Exclusion constraint violation
      console.error('Conflit : la salle est déjà réservée sur ce créneau');
    } else {
      console.error('Erreur :', err.message);
    }
    return null;
  } finally {
    client.release();
  }
}

async function main() {
  // Réservation réussie
  await createBooking(2, 2, '2025-06-15 14:00', '2025-06-15 15:00', 'Sprint planning');

  // Conflit : même salle, même créneau
  await createBooking(2, 3, '2025-06-15 14:30', '2025-06-15 15:30', 'Tech review');

  // OK : autre salle
  await createBooking(3, 3, '2025-06-15 14:30', '2025-06-15 15:30', 'Tech review');

  await pool.end();
}

main();
```

**Action** : Exécuter le script et montrer le succès, le conflit, puis le succès sur une autre salle.

### [12:30-16:00] Test de réservation concurrente

> Le vrai test : que se passe-t-il quand deux utilisateurs essaient de réserver le même créneau exactement en même temps ?

**Action** : Ouvrir les deux terminaux pour la démo de concurrence.

```sql
-- Préparer un créneau libre
-- Salle Hopper (id 3), 16h-17h, libre

-- === TERMINAL 1 ===
BEGIN;
INSERT INTO reservation.bookings (room_id, user_id, during, title)
VALUES (3, 4, '[2025-06-15 16:00, 2025-06-15 17:00)', 'Présentation marketing');
-- OK mais pas encore committé
```

```sql
-- === TERMINAL 2 ===
BEGIN;
INSERT INTO reservation.bookings (room_id, user_id, during, title)
VALUES (3, 5, '[2025-06-15 16:00, 2025-06-15 17:00)', 'Workshop dev');
-- BLOQUÉ ! Attend que Terminal 1 commit ou rollback
```

```sql
-- === TERMINAL 1 ===
COMMIT;
-- Terminal 2 se débloque et échoue :
-- ERROR: conflicting key value violates exclusion constraint "no_overlap"
```

```sql
-- === TERMINAL 2 ===
ROLLBACK;
```

> PostgreSQL sérialise les opérations conflictuelles au niveau de la contrainte. Le premier à committer gagne. Le second reçoit une erreur qu'il peut gérer (proposer un autre créneau, par exemple).

**Action** : Montrer que Terminal 2 est bloqué, puis débloqué avec l'erreur après le COMMIT de Terminal 1.

### [16:00-18:30] Full-text search sur les salles

> Permettons aux utilisateurs de chercher des salles par mot-clé : nom, description, équipement.

**Action** : Configurer et tester le full-text search.

```sql
-- Mettre à jour le search_vector
UPDATE reservation.rooms
SET search_vector = setweight(to_tsvector('french', coalesce(name, '')), 'A')
    || setweight(to_tsvector('french', coalesce(description, '')), 'B')
    || setweight(to_tsvector('french', coalesce(
        array_to_string(
            ARRAY(SELECT jsonb_array_elements_text(equipment)),
            ' '
        ), ''
    )), 'C');

-- Index GIN pour la recherche
CREATE INDEX idx_rooms_search ON reservation.rooms USING GIN (search_vector);

-- Chercher une salle avec vidéoprojecteur
SELECT
    name,
    capacity,
    ts_headline('french', description,
        to_tsquery('french', 'vidéoprojecteur'),
        'StartSel=<<, StopSel=>>') AS extrait
FROM reservation.rooms
WHERE search_vector @@ to_tsquery('french', 'vidéoprojecteur')
ORDER BY ts_rank(search_vector, to_tsquery('french', 'vidéoprojecteur')) DESC;

-- Chercher "visio" et capacité > 5
SELECT name, capacity, equipment
FROM reservation.rooms
WHERE search_vector @@ to_tsquery('french', 'visio')
  AND capacity > 5
ORDER BY capacity DESC;

-- Recherche avancée avec JSONB : salles avec tableau blanc
SELECT name, capacity
FROM reservation.rooms
WHERE equipment @> '"tableau blanc"'::jsonb;
```

**Action** : Montrer les résultats de recherche avec les highlights.

### [18:30-21:00] EXPLAIN ANALYZE sur les requêtes clés

> Vérifions que nos index sont bien utilisés pour les requêtes critiques du système.

**Action** : Analyser les plans d'exécution.

```sql
-- Index sur les réservations par salle et période
CREATE INDEX idx_bookings_room_during ON reservation.bookings
USING GIST (room_id, during);

-- Index pour les requêtes par utilisateur
CREATE INDEX idx_bookings_user ON reservation.bookings (user_id);

-- Analyser la requête "disponibilité d'une salle"
EXPLAIN ANALYZE
SELECT * FROM reservation.bookings
WHERE room_id = 1
  AND during && '[2025-06-15, 2025-06-16)'::tstzrange
  AND status != 'cancelled';

-- Analyser la requête "réservations d'un utilisateur"
EXPLAIN ANALYZE
SELECT
    b.title,
    r.name AS room_name,
    b.during,
    b.status
FROM reservation.bookings b
JOIN reservation.rooms r ON b.room_id = r.id
WHERE b.user_id = 1
ORDER BY lower(b.during) DESC;

-- Analyser le full-text search
EXPLAIN ANALYZE
SELECT name FROM reservation.rooms
WHERE search_vector @@ to_tsquery('french', 'réunion & visio');
```

> Toutes les requêtes critiques utilisent des Index Scans. La requête de disponibilité utilise l'index GiST pour le range. La recherche utilise l'index GIN. C'est exactement ce qu'on veut.

**Action** : Montrer les plans d'exécution et pointer les Index Scans.

### [21:00-24:00] Monitoring du système

> En production, il faut surveiller les performances et l'utilisation du système.

**Action** : Mettre en place les requêtes de monitoring.

```sql
-- Dashboard de monitoring
-- 1. Réservations par jour
SELECT
    lower(during)::date AS jour,
    COUNT(*) AS nb_reservations
FROM reservation.bookings
WHERE status = 'confirmed'
GROUP BY lower(during)::date
ORDER BY jour;

-- 2. Taux d'occupation par salle
WITH time_slots AS (
    SELECT generate_series(
        '2025-06-15 08:00'::timestamptz,
        '2025-06-15 18:00'::timestamptz,
        INTERVAL '1 hour'
    ) AS slot_start
)
SELECT
    r.name,
    COUNT(b.id) AS heures_reservees,
    10 AS heures_total,
    ROUND(100.0 * COUNT(b.id) / 10, 1) AS occupation_pct
FROM reservation.rooms r
CROSS JOIN time_slots ts
LEFT JOIN reservation.bookings b ON b.room_id = r.id
    AND b.during @> ts.slot_start
    AND b.status = 'confirmed'
GROUP BY r.id, r.name
ORDER BY occupation_pct DESC;

-- 3. Statistiques de la base
SELECT
    relname AS table_name,
    n_live_tup AS rows,
    pg_size_pretty(pg_total_relation_size('reservation.' || relname)) AS size,
    seq_scan,
    idx_scan
FROM pg_stat_user_tables
WHERE schemaname = 'reservation'
ORDER BY n_live_tup DESC;

-- 4. Index du projet
SELECT
    indexname,
    tablename,
    pg_size_pretty(pg_relation_size(indexname::regclass)) AS size
FROM pg_indexes
WHERE schemaname = 'reservation'
ORDER BY pg_relation_size(indexname::regclass) DESC;
```

**Action** : Montrer le dashboard de monitoring avec les statistiques d'occupation et de performance.

### [24:00-27:30] Démo Lab-15 complète

> Le lab 15 est le plus complet du cours. Il vous guide dans la construction de ce système de réservation de A à Z.

**Action** : Ouvrir `labs/lab-15-systeme-reservation/` et parcourir la structure.

```bash
ls labs/lab-15-systeme-reservation/
```

> Le lab comprend le schéma SQL, les scripts Node.js, les tests de concurrence et le monitoring. C'est l'occasion de mettre en pratique tous les concepts du cours.

**Action** : Parcourir les fichiers du lab : schema.sql, les scripts de test, les exercices.

```sql
-- Vérification finale du système
SELECT
    (SELECT COUNT(*) FROM reservation.rooms) AS nb_rooms,
    (SELECT COUNT(*) FROM reservation.users) AS nb_users,
    (SELECT COUNT(*) FROM reservation.bookings WHERE status = 'confirmed') AS nb_bookings,
    (SELECT COUNT(*) FROM reservation.events) AS nb_events;
```

**Action** : Montrer un résumé du système complet fonctionnel.

### [27:30-29:00] Conclusion du cours

> Félicitations ! Vous avez terminé ce cours PostgreSQL. On a parcouru un chemin complet : du CREATE TABLE jusqu'à un système de réservation concurrent avec contraintes d'exclusion, full-text search et monitoring. Vous maîtrisez maintenant le modèle relationnel, les transactions ACID, les index B-tree, GIN et GiST, le query planner, MVCC, les verrous, les window functions, le JSONB, et la sécurité avec RLS. PostgreSQL est un outil incroyablement puissant — continuez à l'explorer et à l'utiliser dans vos projets.

**Action** : Revenir sur le plan du cours dans `index.md` et montrer le chemin parcouru.

> Merci d'avoir suivi ce cours. Bonne continuation avec PostgreSQL !

**Action** : Nettoyage optionnel (garder le projet si le participant veut continuer).

```sql
-- Pour nettoyer complètement :
-- DROP SCHEMA reservation CASCADE;
```

## Points d'attention pour l'enregistrement
- Ce screencast est le plus long — prévoir 25-30 minutes
- Préparer les données à l'avance pour ne pas perdre de temps sur les INSERT
- La démo de concurrence avec deux terminaux doit être fluide — la pratiquer
- L'erreur EXCLUDE constraint doit être clairement visible et expliquée
- Le full-text search en français doit fonctionner (tester to_tsvector('french', ...))
- Terminer sur une note positive — c'est la conclusion du cours complet
- Vérifier que tous les index sont créés avant les EXPLAIN ANALYZE
