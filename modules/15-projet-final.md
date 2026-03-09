# Module 15 — Projet final : Systeme de reservation

> **Objectif** : Mettre en pratique TOUS les concepts des modules precedents en construisant un systeme de reservation de salles complet — modelisation, contraintes, concurrence, securite, performance et monitoring.
>
> **Difficulte** : ⭐⭐⭐⭐⭐

---

## 1. Cahier des charges

### 1.1 Description du systeme

Vous construisez un systeme de reservation de salles pour une entreprise multi-sites. Les utilisateurs peuvent reserver des salles pour des evenements (reunions, conferences, formations).

### 1.2 Exigences fonctionnelles

| Exigence | Description | Modules mobilises |
|----------|-------------|-------------------|
| Reservation | Creer, modifier, annuler des reservations | Transactions, MVCC |
| Anti-double-booking | Impossible de reserver un creneau deja pris | Range types, EXCLUDE |
| Multi-tenant | Chaque entreprise voit ses propres donnees | RLS, schemas |
| Recherche | Trouver des evenements par mots-cles | Full-Text Search |
| Statistiques | Tableaux de bord d'utilisation | Window Functions, CTEs |
| Audit | Historique de toutes les modifications | Triggers, JSONB |
| Performance | < 100ms pour les requetes principales | Index, pooling |

### 1.3 Contraintes techniques

```
┌──────────────────────────────────────────────────────────────┐
│  CONTRAINTES NON-FONCTIONNELLES                               │
│                                                               │
│  - Concurrence : 100+ utilisateurs simultanees               │
│  - Double booking : strictement IMPOSSIBLE                   │
│  - Latence : < 100ms pour les requetes critiques             │
│  - Donnees : 10 000+ reservations/mois                       │
│  - Retention : 2 ans d'historique                            │
│  - Securite : isolation complete entre tenants               │
│  - Disponibilite : PITR pour la restauration                 │
└──────────────────────────────────────────────────────────────┘
```

### 1.4 Architecture cible

```
┌──────────┐     ┌──────────────┐     ┌──────────────────┐
│ Frontend │────►│  Node.js API │────►│   PostgreSQL 16   │
│ (React)  │     │  (Express)   │     │                    │
│          │     │  pg.Pool     │     │  RLS (multi-tenant)│
│          │     │  max: 20     │     │  EXCLUDE (overlap) │
│          │     │              │     │  GiST (ranges)     │
└──────────┘     └──────────────┘     │  GIN (FTS, JSONB)  │
                                       │  Serializable txn  │
                                       └──────────────────┘
```

---

## 2. Modelisation du schema

### 2.1 Diagramme des tables

```
┌────────────────┐       ┌────────────────┐
│    tenants     │       │     users      │
├────────────────┤       ├────────────────┤
│ id (PK)        │◄──────│ tenant_id (FK) │
│ name           │       │ id (PK)        │
│ plan           │       │ email          │
│ settings JSONB │       │ password_hash  │
│ created_at     │       │ role           │
└────────────────┘       │ full_name      │
                          │ created_at     │
                          └───────┬────────┘
                                  │
┌────────────────┐       ┌────────┴───────┐
│     rooms      │       │  reservations  │
├────────────────┤       ├────────────────┤
│ tenant_id (FK) │       │ id (PK)        │
│ id (PK)        │◄──────│ room_id (FK)   │
│ name           │       │ user_id (FK)   │
│ capacity       │       │ tenant_id (FK) │
│ floor          │       │ time_slot      │
│ equipment JSONB│       │ status         │
│ is_active      │       │ metadata JSONB │
│ created_at     │       │ created_at     │
└────────────────┘       │ updated_at     │
                          └───────┬────────┘
┌────────────────┐                │
│    events      │       ┌────────┴───────┐
├────────────────┤       │   audit_log    │
│ id (PK)        │       ├────────────────┤
│ tenant_id (FK) │       │ id (PK)        │
│ reservation_id │       │ tenant_id      │
│ title          │       │ table_name     │
│ description    │       │ record_id      │
│ event_type     │       │ action         │
│ search_vector  │       │ old_data JSONB │
│ created_at     │       │ new_data JSONB │
└────────────────┘       │ changed_by     │
                          │ changed_at     │
                          └────────────────┘
```

### 2.2 Script de creation complet

```sql
-- ============================================================
-- EXTENSIONS NECESSAIRES
-- ============================================================
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- Pour EXCLUDE constraint
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- Pour le hashage
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- Pour la recherche floue

-- ============================================================
-- TYPES PERSONNALISES
-- ============================================================
CREATE TYPE user_role AS ENUM ('admin', 'manager', 'user');
CREATE TYPE reservation_status AS ENUM ('confirmed', 'tentative', 'cancelled');
CREATE TYPE event_type AS ENUM ('meeting', 'conference', 'training', 'workshop', 'other');
CREATE TYPE audit_action AS ENUM ('INSERT', 'UPDATE', 'DELETE');

-- ============================================================
-- TABLE : tenants
-- ============================================================
CREATE TABLE tenants (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    plan       TEXT NOT NULL DEFAULT 'standard'
                   CHECK (plan IN ('free', 'standard', 'premium')),
    settings   JSONB NOT NULL DEFAULT '{
        "max_rooms": 10,
        "max_users": 50,
        "max_reservation_hours": 8,
        "allow_recurring": false
    }'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TABLE : users
-- ============================================================
CREATE TABLE users (
    id            SERIAL PRIMARY KEY,
    tenant_id     INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL,
    role          user_role NOT NULL DEFAULT 'user',
    is_active     BOOLEAN NOT NULL DEFAULT true,
    last_login    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, email)  -- Email unique par tenant
);

-- ============================================================
-- TABLE : rooms
-- ============================================================
CREATE TABLE rooms (
    id          SERIAL PRIMARY KEY,
    tenant_id   INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    capacity    INT NOT NULL CHECK (capacity > 0 AND capacity <= 500),
    floor       INT NOT NULL DEFAULT 0,
    equipment   JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Exemple : {"projecteur": true, "visio": true, "tableau_blanc": true}
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, name)
);

-- ============================================================
-- TABLE : reservations
-- ============================================================
CREATE TABLE reservations (
    id          SERIAL PRIMARY KEY,
    tenant_id   INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    room_id     INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    time_slot   TSTZRANGE NOT NULL,
    status      reservation_status NOT NULL DEFAULT 'confirmed',
    metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Exemple : {"recurrence": "weekly", "guests": ["bob@corp.com"]}
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- CONTRAINTE CLE : pas de chevauchement pour la meme salle
    -- (uniquement pour les reservations non-annulees)
    CONSTRAINT no_overlap_active_reservations
    EXCLUDE USING GIST (
        room_id WITH =,
        time_slot WITH &&
    ) WHERE (status != 'cancelled'),

    -- Verification : le creneau ne peut pas etre dans le passe
    CONSTRAINT future_reservation
    CHECK (lower(time_slot) >= now() - interval '1 hour'),

    -- Verification : duree minimum 15 minutes
    CONSTRAINT min_duration
    CHECK (upper(time_slot) - lower(time_slot) >= interval '15 minutes'),

    -- Verification : duree maximum 24 heures
    CONSTRAINT max_duration
    CHECK (upper(time_slot) - lower(time_slot) <= interval '24 hours')
);

-- ============================================================
-- TABLE : events
-- ============================================================
CREATE TABLE events (
    id              SERIAL PRIMARY KEY,
    tenant_id       INT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    reservation_id  INT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    title           TEXT NOT NULL CHECK (length(title) >= 3),
    description     TEXT,
    event_type      event_type NOT NULL DEFAULT 'meeting',
    attendees_count INT CHECK (attendees_count > 0),

    -- Full-Text Search : colonne generee
    search_vector   TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('french', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('french', coalesce(description, '')), 'B')
    ) STORED,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TABLE : audit_log
-- ============================================================
CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   INT,
    table_name  TEXT NOT NULL,
    record_id   INT NOT NULL,
    action      audit_action NOT NULL,
    old_data    JSONB,
    new_data    JSONB,
    changed_by  TEXT NOT NULL DEFAULT current_user,
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (changed_at);

-- Partitions mensuelles pour l'audit
CREATE TABLE audit_log_2025_01 PARTITION OF audit_log
    FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
CREATE TABLE audit_log_2025_02 PARTITION OF audit_log
    FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');
CREATE TABLE audit_log_2025_03 PARTITION OF audit_log
    FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');
CREATE TABLE audit_log_2025_04 PARTITION OF audit_log
    FOR VALUES FROM ('2025-04-01') TO ('2025-05-01');
CREATE TABLE audit_log_2025_05 PARTITION OF audit_log
    FOR VALUES FROM ('2025-05-01') TO ('2025-06-01');
CREATE TABLE audit_log_2025_06 PARTITION OF audit_log
    FOR VALUES FROM ('2025-06-01') TO ('2025-07-01');
-- ... continuer pour chaque mois
-- Partition par defaut pour les mois non-couverts
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;
```

---

## 3. Index strategy

### 3.1 Index B-tree sur FK et filtres frequents

```sql
-- FK : essentiels pour les JOINs
CREATE INDEX idx_users_tenant ON users (tenant_id);
CREATE INDEX idx_rooms_tenant ON rooms (tenant_id);
CREATE INDEX idx_reservations_tenant ON reservations (tenant_id);
CREATE INDEX idx_reservations_room ON reservations (room_id);
CREATE INDEX idx_reservations_user ON reservations (user_id);
CREATE INDEX idx_events_tenant ON events (tenant_id);
CREATE INDEX idx_events_reservation ON events (reservation_id);
CREATE INDEX idx_audit_tenant ON audit_log (tenant_id);

-- Filtres frequents
CREATE INDEX idx_users_email ON users (tenant_id, email);
CREATE INDEX idx_rooms_active ON rooms (tenant_id) WHERE is_active = true;
CREATE INDEX idx_reservations_status ON reservations (status)
    WHERE status != 'cancelled';
```

### 3.2 Index GiST sur ranges (creneaux)

```sql
-- Index GiST pour les requetes de chevauchement et de disponibilite
CREATE INDEX idx_reservations_timeslot
    ON reservations USING GIST (time_slot);

-- Index composite GiST (salle + creneau)
CREATE INDEX idx_reservations_room_timeslot
    ON reservations USING GIST (room_id, time_slot)
    WHERE status != 'cancelled';
```

### 3.3 Index GIN sur JSONB

```sql
-- JSONB metadata (recherche par contenance)
CREATE INDEX idx_reservations_metadata
    ON reservations USING GIN (metadata jsonb_path_ops);

CREATE INDEX idx_rooms_equipment
    ON rooms USING GIN (equipment jsonb_path_ops);
```

### 3.4 Index GIN pour Full-Text Search

```sql
-- Full-Text Search sur les evenements
CREATE INDEX idx_events_search
    ON events USING GIN (search_vector);
```

### 3.5 Partial indexes

```sql
-- Index uniquement sur les reservations actives (pas les annulees)
CREATE INDEX idx_reservations_active_timeslot
    ON reservations USING GIST (room_id, time_slot)
    WHERE status IN ('confirmed', 'tentative');

-- Index sur les utilisateurs actifs
CREATE INDEX idx_users_active
    ON users (tenant_id, email)
    WHERE is_active = true;
```

### 3.6 Strategie resumee

```
┌──────────────────────────────────────────────────────────────┐
│  TYPE D'INDEX          UTILISATION                           │
│                                                               │
│  B-tree (defaut)       FK, egalite, range sur scalaires      │
│  GiST                  Ranges (tstzrange), geometrie         │
│  GIN                   JSONB, Full-Text, arrays              │
│  Partial               Reduire la taille, cibler les actifs  │
│                                                               │
│  TOTAL : ~15 index pour 6 tables                             │
│  Taille estimee : < 5% de la taille des donnees             │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Transaction design

### 4.1 La reservation : operation critique

La creation d'une reservation est l'operation la plus critique du systeme. Elle doit :
1. Verifier que la salle existe et est active
2. Verifier que l'utilisateur a le droit de reserver
3. Verifier qu'il n'y a pas de chevauchement
4. Creer la reservation ET l'evenement atomiquement

### 4.2 Isolation Serializable pour les reservations

```sql
-- Fonction de reservation avec isolation Serializable
CREATE OR REPLACE FUNCTION create_reservation(
    p_tenant_id INT,
    p_room_id INT,
    p_user_id INT,
    p_start TIMESTAMPTZ,
    p_end TIMESTAMPTZ,
    p_title TEXT,
    p_description TEXT DEFAULT NULL,
    p_event_type event_type DEFAULT 'meeting',
    p_metadata JSONB DEFAULT '{}'
)
RETURNS TABLE (reservation_id INT, event_id INT)
LANGUAGE plpgsql
AS $$
DECLARE
    v_reservation_id INT;
    v_event_id INT;
    v_room_capacity INT;
BEGIN
    -- Verifier que la salle existe et est active
    SELECT capacity INTO v_room_capacity
    FROM rooms
    WHERE id = p_room_id
      AND tenant_id = p_tenant_id
      AND is_active = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Salle % introuvable ou inactive', p_room_id;
    END IF;

    -- Creer la reservation
    -- La contrainte EXCLUDE verifie automatiquement les chevauchements
    INSERT INTO reservations (tenant_id, room_id, user_id, time_slot, metadata)
    VALUES (
        p_tenant_id,
        p_room_id,
        p_user_id,
        tstzrange(p_start, p_end, '[)'),
        p_metadata
    )
    RETURNING id INTO v_reservation_id;

    -- Creer l'evenement associe
    INSERT INTO events (tenant_id, reservation_id, title, description, event_type)
    VALUES (
        p_tenant_id,
        v_reservation_id,
        p_title,
        p_description,
        p_event_type
    )
    RETURNING id INTO v_event_id;

    RETURN QUERY SELECT v_reservation_id, v_event_id;
END;
$$;
```

### 4.3 Node.js : reservation avec retry

```typescript
import pg from 'pg';
import type { PoolClient } from 'pg';
const { Pool } = pg;

const pool = new Pool({
    host: process.env.PGHOST,
    database: 'reservation_db',
    user: 'reservation_app',
    password: process.env.PGPASSWORD,
    max: 20,
    idleTimeoutMillis: 30_000,
});

interface ReservationInput {
    tenantId: number;
    roomId: number;
    userId: number;
    start: string;
    end: string;
    title: string;
    description?: string | null;
    eventType?: string;
    metadata?: Record<string, unknown>;
}

interface ReservationResult {
    success: boolean;
    reservationId?: number;
    eventId?: number;
    error?: string;
    message?: string;
}

interface DatabaseError extends Error {
    code?: string;
}

/**
 * Creer une reservation avec retry automatique
 * en cas de conflit de serialisation.
 */
async function createReservation({
    tenantId,
    roomId,
    userId,
    start,
    end,
    title,
    description = null,
    eventType = 'meeting',
    metadata = {},
}: ReservationInput): Promise<ReservationResult> {
    const maxRetries = 5;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const client: PoolClient = await pool.connect();

        try {
            await client.query(
                'BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE'
            );

            // Definir le tenant pour RLS
            await client.query(
                "SELECT set_config('app.tenant_id', $1::text, true)",
                [tenantId.toString()]
            );

            // Appeler la fonction de reservation
            const { rows } = await client.query(
                `SELECT * FROM create_reservation(
                    $1, $2, $3, $4, $5, $6, $7, $8::event_type, $9::jsonb
                )`,
                [
                    tenantId, roomId, userId,
                    start, end,
                    title, description, eventType,
                    JSON.stringify(metadata),
                ]
            );

            await client.query('COMMIT');

            return {
                success: true,
                reservationId: rows[0].reservation_id,
                eventId: rows[0].event_id,
            };
        } catch (error) {
            await client.query('ROLLBACK');
            const dbError = error as DatabaseError;

            // Serialization failure (40001) ou deadlock (40P01) → retry
            if (
                (dbError.code === '40001' || dbError.code === '40P01') &&
                attempt < maxRetries
            ) {
                const delay: number = Math.min(
                    50 * Math.pow(2, attempt) + Math.random() * 50,
                    3000
                );
                console.warn(
                    `Reservation retry ${attempt}/${maxRetries} ` +
                    `(${dbError.code}), waiting ${Math.round(delay)}ms`
                );
                await new Promise((r) => setTimeout(r, delay));
                continue;
            }

            // Exclusion constraint violation (23P01) → double booking
            if (dbError.code === '23P01') {
                return {
                    success: false,
                    error: 'DOUBLE_BOOKING',
                    message: 'Ce creneau est deja reserve pour cette salle.',
                };
            }

            // Check constraint violation (23514)
            if (dbError.code === '23514') {
                return {
                    success: false,
                    error: 'CONSTRAINT_VIOLATION',
                    message: dbError.message,
                };
            }

            throw error;
        } finally {
            client.release();
        }
    }

    return {
        success: false,
        error: 'MAX_RETRIES',
        message: 'Impossible de creer la reservation apres plusieurs tentatives.',
    };
}
```

### 4.4 FOR UPDATE NOWAIT pour le lock optimiste

```typescript
interface CancelResult {
    success: boolean;
    error?: string;
    message?: string;
}

interface ReservationRow {
    id: number;
    user_id: number;
    status: string;
}

interface UserRow {
    role: string;
}

/**
 * Annuler une reservation.
 * Utilise FOR UPDATE NOWAIT pour echouer vite
 * si la reservation est deja en cours de modification.
 */
async function cancelReservation(
    tenantId: number,
    reservationId: number,
    userId: number
): Promise<CancelResult> {
    const client: PoolClient = await pool.connect();

    try {
        await client.query('BEGIN');
        await client.query(
            "SELECT set_config('app.tenant_id', $1::text, true)",
            [tenantId.toString()]
        );

        // Verrouiller la reservation immediatement ou echouer
        const { rows } = await client.query<ReservationRow>(
            `SELECT id, user_id, status
             FROM reservations
             WHERE id = $1
               AND tenant_id = $2
             FOR UPDATE NOWAIT`,
            [reservationId, tenantId]
        );

        if (rows.length === 0) {
            await client.query('ROLLBACK');
            return { success: false, error: 'NOT_FOUND' };
        }

        if (rows[0].status === 'cancelled') {
            await client.query('ROLLBACK');
            return { success: false, error: 'ALREADY_CANCELLED' };
        }

        // Verifier les droits (admin ou proprietaire)
        const { rows: userRows } = await client.query<UserRow>(
            'SELECT role FROM users WHERE id = $1 AND tenant_id = $2',
            [userId, tenantId]
        );

        if (
            userRows[0].role !== 'admin' &&
            rows[0].user_id !== userId
        ) {
            await client.query('ROLLBACK');
            return { success: false, error: 'FORBIDDEN' };
        }

        // Annuler (soft delete)
        await client.query(
            `UPDATE reservations
             SET status = 'cancelled', updated_at = now()
             WHERE id = $1`,
            [reservationId]
        );

        await client.query('COMMIT');
        return { success: true };
    } catch (error) {
        await client.query('ROLLBACK');
        const dbError = error as DatabaseError;

        if (dbError.code === '55P03') {
            return {
                success: false,
                error: 'LOCKED',
                message: 'La reservation est en cours de modification.',
            };
        }

        throw error;
    } finally {
        client.release();
    }
}
```

---

## 5. Requetes complexes

### 5.1 Disponibilite avec LATERAL joins

```sql
-- Trouver les creneaux disponibles pour une salle donnee
-- sur une journee donnee
WITH time_slots AS (
    -- Generer des creneaux de 30 minutes
    SELECT
        slot_start,
        slot_start + interval '30 minutes' AS slot_end
    FROM generate_series(
        '2025-03-10 08:00'::timestamptz,
        '2025-03-10 19:30'::timestamptz,
        interval '30 minutes'
    ) AS slot_start
)
SELECT
    ts.slot_start,
    ts.slot_end,
    CASE
        WHEN r.id IS NOT NULL THEN 'RESERVE'
        ELSE 'DISPONIBLE'
    END AS statut,
    e.title AS evenement
FROM time_slots ts
LEFT JOIN LATERAL (
    SELECT r.id
    FROM reservations r
    WHERE r.room_id = 1  -- Salle 1
      AND r.status != 'cancelled'
      AND r.time_slot && tstzrange(ts.slot_start, ts.slot_end, '[)')
    LIMIT 1
) r ON true
LEFT JOIN events e ON e.reservation_id = r.id
ORDER BY ts.slot_start;
```

### 5.2 Statistiques avec Window Functions

```sql
-- Taux d'occupation des salles par semaine
WITH weekly_stats AS (
    SELECT
        ro.name AS salle,
        date_trunc('week', lower(r.time_slot))::date AS semaine,
        SUM(
            EXTRACT(EPOCH FROM (upper(r.time_slot) - lower(r.time_slot))) / 3600
        ) AS heures_reservees,
        -- Heures ouvrables par semaine : 5 jours * 11h = 55h
        55.0 AS heures_disponibles
    FROM reservations r
    JOIN rooms ro ON r.room_id = ro.id
    WHERE r.status = 'confirmed'
      AND r.tenant_id = 1
    GROUP BY ro.name, date_trunc('week', lower(r.time_slot))
)
SELECT
    salle,
    semaine,
    ROUND(heures_reservees, 1) AS heures_reservees,
    ROUND(100.0 * heures_reservees / heures_disponibles, 1) AS taux_occupation,
    ROUND(AVG(heures_reservees) OVER (
        PARTITION BY salle
        ORDER BY semaine
        ROWS BETWEEN 3 PRECEDING AND CURRENT ROW
    ), 1) AS moyenne_mobile_4sem,
    RANK() OVER (
        PARTITION BY semaine
        ORDER BY heures_reservees DESC
    ) AS classement_semaine
FROM weekly_stats
ORDER BY semaine DESC, classement_semaine;
```

### 5.3 Recherche Full-Text sur evenements

```sql
-- Recherche d'evenements avec scoring et highlighting
SELECT
    e.title,
    ts_headline('french', e.description,
        websearch_to_tsquery('french', $1),
        'StartSel=<b>, StopSel=</b>, MaxFragments=2, MaxWords=30'
    ) AS extrait,
    r.time_slot,
    ro.name AS salle,
    ts_rank(e.search_vector, websearch_to_tsquery('french', $1)) AS score
FROM events e
JOIN reservations r ON e.reservation_id = r.id
JOIN rooms ro ON r.room_id = ro.id
WHERE e.search_vector @@ websearch_to_tsquery('french', $1)
  AND e.tenant_id = $2
ORDER BY score DESC
LIMIT 20;
```

### 5.4 Rapport avec CTE

```sql
-- Rapport mensuel complet
WITH
monthly_reservations AS (
    SELECT
        date_trunc('month', lower(time_slot))::date AS mois,
        COUNT(*) AS nb_reservations,
        COUNT(DISTINCT user_id) AS nb_utilisateurs,
        COUNT(DISTINCT room_id) AS nb_salles_utilisees,
        SUM(EXTRACT(EPOCH FROM (upper(time_slot) - lower(time_slot))) / 3600)
            AS heures_totales
    FROM reservations
    WHERE tenant_id = 1
      AND status = 'confirmed'
    GROUP BY date_trunc('month', lower(time_slot))
),
monthly_cancellations AS (
    SELECT
        date_trunc('month', updated_at)::date AS mois,
        COUNT(*) AS nb_annulations
    FROM reservations
    WHERE tenant_id = 1
      AND status = 'cancelled'
    GROUP BY date_trunc('month', updated_at)
),
top_users AS (
    SELECT
        date_trunc('month', lower(r.time_slot))::date AS mois,
        u.full_name,
        COUNT(*) AS nb_reservations,
        ROW_NUMBER() OVER (
            PARTITION BY date_trunc('month', lower(r.time_slot))
            ORDER BY COUNT(*) DESC
        ) AS rang
    FROM reservations r
    JOIN users u ON r.user_id = u.id
    WHERE r.tenant_id = 1
      AND r.status = 'confirmed'
    GROUP BY date_trunc('month', lower(r.time_slot)), u.full_name
)
SELECT
    mr.mois,
    mr.nb_reservations,
    mr.nb_utilisateurs,
    mr.nb_salles_utilisees,
    ROUND(mr.heures_totales::numeric, 1) AS heures_totales,
    COALESCE(mc.nb_annulations, 0) AS nb_annulations,
    ROUND(
        100.0 * COALESCE(mc.nb_annulations, 0) /
        NULLIF(mr.nb_reservations + COALESCE(mc.nb_annulations, 0), 0),
        1
    ) AS taux_annulation_pct,
    tu.full_name AS top_utilisateur,
    tu.nb_reservations AS reservations_top_user
FROM monthly_reservations mr
LEFT JOIN monthly_cancellations mc ON mr.mois = mc.mois
LEFT JOIN top_users tu ON mr.mois = tu.mois AND tu.rang = 1
ORDER BY mr.mois DESC;
```

---

## 6. Securite

### 6.1 Roles

```sql
-- Role pour l'application
CREATE ROLE reservation_app WITH LOGIN PASSWORD 'strong_password_here';
GRANT CONNECT ON DATABASE reservation_db TO reservation_app;
GRANT USAGE ON SCHEMA public TO reservation_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO reservation_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO reservation_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO reservation_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO reservation_app;

-- Role pour les rapports (lecture seule)
CREATE ROLE reservation_reports WITH LOGIN PASSWORD 'another_strong_password';
GRANT CONNECT ON DATABASE reservation_db TO reservation_reports;
GRANT USAGE ON SCHEMA public TO reservation_reports;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO reservation_reports;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO reservation_reports;

-- Role pour le monitoring
CREATE ROLE reservation_monitor WITH LOGIN PASSWORD 'monitor_password';
GRANT pg_monitor TO reservation_monitor;
GRANT CONNECT ON DATABASE reservation_db TO reservation_monitor;
```

### 6.2 RLS policies par tenant

```sql
-- Activer RLS sur toutes les tables multi-tenant
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Policy generique pour chaque table
CREATE POLICY tenant_isolation ON users
    FOR ALL TO reservation_app
    USING (tenant_id = current_setting('app.tenant_id')::int)
    WITH CHECK (tenant_id = current_setting('app.tenant_id')::int);

CREATE POLICY tenant_isolation ON rooms
    FOR ALL TO reservation_app
    USING (tenant_id = current_setting('app.tenant_id')::int)
    WITH CHECK (tenant_id = current_setting('app.tenant_id')::int);

CREATE POLICY tenant_isolation ON reservations
    FOR ALL TO reservation_app
    USING (tenant_id = current_setting('app.tenant_id')::int)
    WITH CHECK (tenant_id = current_setting('app.tenant_id')::int);

CREATE POLICY tenant_isolation ON events
    FOR ALL TO reservation_app
    USING (tenant_id = current_setting('app.tenant_id')::int)
    WITH CHECK (tenant_id = current_setting('app.tenant_id')::int);

CREATE POLICY tenant_isolation ON audit_log
    FOR ALL TO reservation_app
    USING (tenant_id = current_setting('app.tenant_id')::int)
    WITH CHECK (tenant_id = current_setting('app.tenant_id')::int);
```

### 6.3 Audit trail avec trigger

```sql
-- Trigger generique d'audit
CREATE OR REPLACE FUNCTION audit_trigger_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_tenant_id INT;
BEGIN
    -- Extraire le tenant_id selon l'operation
    IF TG_OP = 'DELETE' THEN
        v_tenant_id := OLD.tenant_id;
    ELSE
        v_tenant_id := NEW.tenant_id;
    END IF;

    INSERT INTO audit_log (tenant_id, table_name, record_id, action, old_data, new_data)
    VALUES (
        v_tenant_id,
        TG_TABLE_NAME,
        CASE TG_OP
            WHEN 'DELETE' THEN OLD.id
            ELSE NEW.id
        END,
        TG_OP::audit_action,
        CASE WHEN TG_OP IN ('UPDATE', 'DELETE')
            THEN to_jsonb(OLD) ELSE NULL END,
        CASE WHEN TG_OP IN ('INSERT', 'UPDATE')
            THEN to_jsonb(NEW) ELSE NULL END
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;

-- Appliquer le trigger sur les tables sensibles
CREATE TRIGGER audit_reservations
    AFTER INSERT OR UPDATE OR DELETE ON reservations
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

CREATE TRIGGER audit_events
    AFTER INSERT OR UPDATE OR DELETE ON events
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

CREATE TRIGGER audit_rooms
    AFTER INSERT OR UPDATE OR DELETE ON rooms
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
```

---

## 7. Monitoring

### 7.1 Dashboard pg_stat_statements

```sql
-- Top 10 requetes les plus couteuses
SELECT
    LEFT(query, 80) AS query,
    calls,
    ROUND(total_exec_time::numeric, 2) AS total_ms,
    ROUND(mean_exec_time::numeric, 2) AS avg_ms,
    ROUND(max_exec_time::numeric, 2) AS max_ms,
    rows,
    ROUND(100.0 * shared_blks_hit /
        NULLIF(shared_blks_hit + shared_blks_read, 0), 1) AS cache_hit_pct
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

### 7.2 Detection des requetes lentes

```sql
-- Requetes actives depuis plus de 5 secondes
CREATE OR REPLACE VIEW slow_queries AS
SELECT
    pid,
    usename,
    datname,
    state,
    LEFT(query, 200) AS query,
    age(now(), query_start) AS duration,
    wait_event_type,
    wait_event,
    pg_blocking_pids(pid) AS blocked_by
FROM pg_stat_activity
WHERE state = 'active'
  AND age(now(), query_start) > interval '5 seconds'
  AND pid != pg_backend_pid()
ORDER BY query_start;
```

### 7.3 Monitoring des locks

```sql
-- Vue des locks en attente
CREATE OR REPLACE VIEW lock_monitor AS
SELECT
    blocked.pid AS blocked_pid,
    blocked.usename AS blocked_user,
    LEFT(blocked.query, 100) AS blocked_query,
    age(now(), blocked.query_start) AS blocked_since,
    blocking.pid AS blocking_pid,
    blocking.usename AS blocking_user,
    LEFT(blocking.query, 100) AS blocking_query,
    blocking.state AS blocking_state
FROM pg_stat_activity blocked
JOIN pg_locks bl ON bl.pid = blocked.pid AND NOT bl.granted
JOIN pg_locks gl ON gl.relation = bl.relation
    AND gl.locktype = bl.locktype
    AND gl.pid != bl.pid
    AND gl.granted
JOIN pg_stat_activity blocking ON blocking.pid = gl.pid
WHERE blocked.state != 'idle';
```

### 7.4 Script Node.js de monitoring complet

```typescript
import pg from 'pg';
const { Pool } = pg;

const monitorPool = new Pool({
    user: 'reservation_monitor',
    database: 'reservation_db',
    max: 2,
});

interface ConnRow {
    state: string | null;
    count: string;
}

interface CacheRatioRow {
    ratio: string | null;
}

interface DeadlockRow {
    deadlocks: string;
}

interface TableSizeRow {
    relname: string;
    size: string;
    dead_tuples: string;
}

interface TodayRow {
    confirmed: string;
    tentative: string;
    cancelled: string;
}

interface Metrics {
    connections: Record<string, number>;
    cacheHitRatio: number;
    deadlocks: number;
    topTables: TableSizeRow[];
    todayReservations: TodayRow;
}

async function collectMetrics(): Promise<Metrics> {
    // 1. Connexions
    const { rows: connRows } = await monitorPool.query<ConnRow>(`
        SELECT state, COUNT(*) AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
        GROUP BY state
    `);
    const connections: Record<string, number> = Object.fromEntries(
        connRows.map((r) => [r.state || 'null', parseInt(r.count)])
    );

    // 2. Cache hit ratio
    const { rows: cacheRows } = await monitorPool.query<CacheRatioRow>(`
        SELECT ROUND(100.0 * SUM(blks_hit) /
            NULLIF(SUM(blks_hit) + SUM(blks_read), 0), 2) AS ratio
        FROM pg_stat_database
        WHERE datname = current_database()
    `);
    const cacheHitRatio: number = parseFloat(cacheRows[0].ratio || '0');

    // 3. Deadlocks
    const { rows: dlRows } = await monitorPool.query<DeadlockRow>(`
        SELECT deadlocks FROM pg_stat_database
        WHERE datname = current_database()
    `);
    const deadlocks: number = parseInt(dlRows[0].deadlocks);

    // 4. Table sizes
    const { rows: sizeRows } = await monitorPool.query<TableSizeRow>(`
        SELECT relname,
               pg_size_pretty(pg_total_relation_size(relid)) AS size,
               n_dead_tup AS dead_tuples
        FROM pg_stat_user_tables
        ORDER BY pg_total_relation_size(relid) DESC
        LIMIT 5
    `);

    // 5. Reservations du jour
    const { rows: todayRows } = await monitorPool.query<TodayRow>(`
        SELECT
            COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed,
            COUNT(*) FILTER (WHERE status = 'tentative') AS tentative,
            COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled
        FROM reservations
        WHERE time_slot && tstzrange(
            date_trunc('day', now()),
            date_trunc('day', now()) + interval '1 day'
        )
    `);

    return {
        connections,
        cacheHitRatio,
        deadlocks,
        topTables: sizeRows,
        todayReservations: todayRows[0],
    };
}

// Boucle de collecte
async function monitorLoop(): Promise<void> {
    while (true) {
        try {
            const metrics: Metrics = await collectMetrics();
            console.log(
                `[${new Date().toISOString()}] Metrics:`,
                JSON.stringify(metrics, null, 2)
            );

            // Alertes
            if (metrics.cacheHitRatio < 95) {
                console.warn('ALERTE : Cache hit ratio bas !', metrics.cacheHitRatio);
            }
            if (metrics.connections['idle in transaction'] > 5) {
                console.warn('ALERTE : Trop de transactions idle !');
            }
        } catch (error) {
            console.error('Erreur monitoring :', (error as Error).message);
        }

        await new Promise((r) => setTimeout(r, 30_000)); // 30s
    }
}
```

---

## 8. Optimisation

### 8.1 EXPLAIN ANALYZE sur les requetes critiques

```sql
-- Verifier le plan de la requete de disponibilite
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT r.id, r.time_slot, e.title
FROM reservations r
JOIN events e ON e.reservation_id = r.id
WHERE r.room_id = 1
  AND r.status = 'confirmed'
  AND r.time_slot && '[2025-03-10 08:00, 2025-03-10 20:00)'::tstzrange;

-- Resultat attendu (avec index GiST) :
-- Nested Loop (actual time=0.05..0.12 rows=3)
--   -> Index Scan using idx_reservations_room_timeslot
--      on reservations r (actual time=0.03..0.05 rows=3)
--        Index Cond: (room_id = 1) AND (time_slot && ...)
--        Filter: (status = 'confirmed')
--   -> Index Scan using idx_events_reservation
--      on events e (actual time=0.01..0.01 rows=1)
--        Index Cond: (reservation_id = r.id)
-- Planning Time: 0.2ms
-- Execution Time: 0.15ms   ← < 1ms, excellent !
```

### 8.2 Connection pooling

```typescript
// Configuration optimale pour le systeme de reservation
const pool = new Pool({
    max: 20,                       // 20 connexions max
    min: 5,                        // 5 connexions minimum
    idleTimeoutMillis: 30_000,     // Fermer les idle apres 30s
    connectionTimeoutMillis: 5_000, // Timeout connexion 5s
    maxUses: 7500,                 // Recycler apres 7500 requetes
    statement_timeout: 30_000,     // Timeout requete 30s
});
```

### 8.3 Partitionnement de l'audit_log par date

```sql
-- Deja fait dans la creation du schema (section 2)
-- Purge des vieilles partitions (automatisable avec pg_cron)

-- Supprimer les audits de plus de 2 ans
-- DROP TABLE audit_log_2023_01;  -- INSTANTANE !
-- (beaucoup plus rapide que DELETE FROM audit_log WHERE ...)

-- Script de creation automatique de partitions
CREATE OR REPLACE FUNCTION create_audit_partition(p_date DATE)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_partition_name TEXT;
    v_start_date DATE;
    v_end_date DATE;
BEGIN
    v_start_date := date_trunc('month', p_date)::date;
    v_end_date := (v_start_date + interval '1 month')::date;
    v_partition_name := 'audit_log_' || to_char(v_start_date, 'YYYY_MM');

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_log
         FOR VALUES FROM (%L) TO (%L)',
        v_partition_name, v_start_date, v_end_date
    );
END;
$$;

-- Creer les partitions pour les 6 prochains mois
SELECT create_audit_partition(
    (now() + (n || ' months')::interval)::date
)
FROM generate_series(0, 5) AS n;
```

---

## 9. Script de test de charge

```typescript
import pg from 'pg';
import type { PoolClient } from 'pg';
const { Pool } = pg;

const pool = new Pool({
    database: 'reservation_db',
    user: 'reservation_app',
    max: 50,
});

const TENANTS: number[] = [1, 2, 3];
const ROOMS_PER_TENANT = 5;
const CONCURRENT_USERS = 20;
const OPERATIONS = 200;

let successCount = 0;
let failureCount = 0;
let doubleBookingCount = 0;
let retryCount = 0;

interface LoadTestParams {
    tenantId: number;
    roomId: number;
    userId: number;
    start: string;
    end: string;
    title: string;
}

interface LoadTestResult {
    success: boolean;
    error?: string;
}

interface DatabaseError extends Error {
    code?: string;
}

async function simulateUser(userId: number): Promise<void> {
    for (let i = 0; i < OPERATIONS / CONCURRENT_USERS; i++) {
        const tenantId: number = TENANTS[Math.floor(Math.random() * TENANTS.length)];
        const roomId: number = Math.floor(Math.random() * ROOMS_PER_TENANT) + 1;

        // Generer un creneau aleatoire dans les 7 prochains jours
        const dayOffset: number = Math.floor(Math.random() * 7);
        const hourOffset: number = 8 + Math.floor(Math.random() * 10); // 8h-18h
        const start = new Date();
        start.setDate(start.getDate() + dayOffset + 1);
        start.setHours(hourOffset, 0, 0, 0);

        const end = new Date(start);
        end.setHours(start.getHours() + 1); // 1 heure

        try {
            const result: LoadTestResult = await createReservationWithRetry({
                tenantId,
                roomId,
                userId,
                start: start.toISOString(),
                end: end.toISOString(),
                title: `Test ${userId}-${i}`,
            });

            if (result.success) {
                successCount++;
            } else if (result.error === 'DOUBLE_BOOKING') {
                doubleBookingCount++;
            } else {
                failureCount++;
            }
        } catch (error) {
            failureCount++;
            console.error(`User ${userId}, op ${i}: ${(error as Error).message}`);
        }
    }
}

async function createReservationWithRetry(params: LoadTestParams): Promise<LoadTestResult> {
    const maxRetries = 5;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const client: PoolClient = await pool.connect();
        try {
            await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
            await client.query(
                "SELECT set_config('app.tenant_id', $1::text, true)",
                [params.tenantId.toString()]
            );

            await client.query(
                `INSERT INTO reservations (tenant_id, room_id, user_id, time_slot)
                 VALUES ($1, $2, $3, tstzrange($4::timestamptz, $5::timestamptz, '[)'))`,
                [params.tenantId, params.roomId, params.userId, params.start, params.end]
            );

            await client.query(
                `INSERT INTO events (tenant_id, reservation_id, title)
                 VALUES ($1, currval('reservations_id_seq'), $2)`,
                [params.tenantId, params.title]
            );

            await client.query('COMMIT');
            return { success: true };
        } catch (error) {
            await client.query('ROLLBACK');
            const dbError = error as DatabaseError;

            if ((dbError.code === '40001' || dbError.code === '40P01') && attempt < maxRetries) {
                retryCount++;
                await new Promise((r) => setTimeout(r, Math.random() * 100 * attempt));
                continue;
            }

            if (dbError.code === '23P01') {
                return { success: false, error: 'DOUBLE_BOOKING' };
            }

            throw error;
        } finally {
            client.release();
        }
    }

    return { success: false, error: 'MAX_RETRIES' };
}

async function runLoadTest(): Promise<void> {
    console.log(`Demarrage du test de charge...`);
    console.log(`${CONCURRENT_USERS} utilisateurs, ${OPERATIONS} operations`);
    console.log(`---`);

    const startTime: number = Date.now();

    // Lancer les utilisateurs en parallele
    const promises: Promise<void>[] = Array.from({ length: CONCURRENT_USERS }, (_, i) =>
        simulateUser(i + 1)
    );

    await Promise.all(promises);

    const duration: number = (Date.now() - startTime) / 1000;

    console.log(`\n=== RESULTATS ===`);
    console.log(`Duree : ${duration.toFixed(1)}s`);
    console.log(`Operations/s : ${(OPERATIONS / duration).toFixed(1)}`);
    console.log(`Succes : ${successCount}`);
    console.log(`Double bookings bloques : ${doubleBookingCount}`);
    console.log(`Echecs : ${failureCount}`);
    console.log(`Retries (serialization) : ${retryCount}`);
    console.log(`Taux de succes : ${(100 * successCount / OPERATIONS).toFixed(1)}%`);
}

runLoadTest()
    .catch(console.error)
    .finally(() => pool.end());
```

---

## 10. Checklist de validation du projet

### 10.1 Modelisation

- [ ] Tables normalisees (3NF minimum)
- [ ] Types adequats (TIMESTAMPTZ, ENUM, JSONB, TSTZRANGE)
- [ ] Contraintes CHECK sur les valeurs metier
- [ ] Foreign keys avec ON DELETE CASCADE/RESTRICT
- [ ] Contrainte EXCLUDE pour le no-overlap

### 10.2 Index

- [ ] B-tree sur toutes les FK
- [ ] GiST sur les ranges (tstzrange)
- [ ] GIN sur JSONB (metadata, equipment)
- [ ] GIN sur tsvector (Full-Text Search)
- [ ] Partial indexes sur les statuts actifs
- [ ] EXPLAIN ANALYZE sur les requetes critiques (< 10ms)

### 10.3 Concurrence

- [ ] Isolation SERIALIZABLE pour les reservations
- [ ] Retry pattern pour serialization_failure (40001)
- [ ] Retry pattern pour deadlock_detected (40P01)
- [ ] FOR UPDATE NOWAIT pour les modifications
- [ ] SKIP LOCKED si pattern de queue

### 10.4 Securite

- [ ] Roles avec principe du moindre privilege
- [ ] pg_hba.conf avec scram-sha-256
- [ ] RLS actif sur toutes les tables multi-tenant
- [ ] Policies testees (SET ROLE, set_config)
- [ ] Audit trail fonctionnel

### 10.5 Performance

- [ ] Connection pooling (pg.Pool max: 20)
- [ ] Prepared statements pour les requetes frequentes
- [ ] Autovacuum tune pour les tables actives
- [ ] Cache hit ratio > 99%
- [ ] Requetes critiques < 100ms

### 10.6 Monitoring

- [ ] pg_stat_statements installe et consulte
- [ ] Alertes sur deadlocks, slow queries, idle-in-transaction
- [ ] Backup quotidien (pg_dump -Fc)
- [ ] Test de restauration effectue
- [ ] Partitionnement de l'audit_log

### 10.7 Tests

- [ ] Test unitaire de la fonction create_reservation
- [ ] Test de double booking (doit echouer)
- [ ] Test de charge avec concurrence
- [ ] Test RLS (un tenant ne voit pas les donnees d'un autre)
- [ ] Test de restauration depuis un backup

---

## Exercice mental final

> **Exercice mental** : Votre systeme de reservation est en production depuis 6 mois. Un matin, les utilisateurs signalent que les reservations prennent 5 secondes au lieu de 100ms. Quelles etapes suivriez-vous pour diagnostiquer et resoudre le probleme ?

<details>
<summary>Reponse</summary>

**Etape 1 : Observation**
- `SELECT * FROM pg_stat_activity WHERE state = 'active'` → requetes en cours
- `SELECT * FROM lock_monitor` → locks en attente ?
- `SELECT * FROM slow_queries` → requetes lentes

**Etape 2 : Diagnostic**
- `pg_stat_statements` → requetes les plus lentes (avg_ms)
- `pg_stat_user_tables` → `n_dead_tup` sur la table reservations (bloat ?)
- `last_autovacuum` → l'autovacuum tourne-t-il ?
- Cache hit ratio → est-il tombe sous 99% ?

**Etape 3 : Actions**
- Si bloat : `VACUUM ANALYZE reservations;`
- Si statistiques obsoletes : `ANALYZE reservations;`
- Si lock contention : verifier les transactions idle-in-transaction
- Si index manquant : `EXPLAIN ANALYZE` sur la requete lente
- Si connexions saturees : verifier `max_connections` vs pool size

**Etape 4 : Prevention**
- Tuner l'autovacuum : `autovacuum_vacuum_scale_factor = 0.01`
- Alerter si `n_dead_tup` depasse un seuil
- Mettre un `statement_timeout` et `idle_in_transaction_session_timeout`
</details>

---

## Ce qu'il faut retenir

```
┌──────────────────────────────────────────────────────────────┐
│              RECAPITULATIF DU COURS COMPLET                   │
│                                                               │
│  MODELISATION    : Types, contraintes, EXCLUDE, ranges       │
│  INDEX           : B-tree, GiST, GIN, partial               │
│  TRANSACTIONS    : MVCC, isolation, Serializable             │
│  CONCURRENCE     : Locks, NOWAIT, SKIP LOCKED, retry        │
│  DEADLOCKS       : Detection, prevention, lock ordering      │
│  PERFORMANCE     : Pooling, COPY, VACUUM, partitioning      │
│  SQL AVANCE      : Window Functions, CTEs, LATERAL           │
│  TYPES AVANCES   : JSONB, arrays, ranges, Full-Text         │
│  SECURITE        : Roles, GRANT, RLS, audit                 │
│  ADMINISTRATION  : pg_dump, monitoring, extensions           │
│                                                               │
│  Vous avez maintenant les outils pour construire             │
│  des applications robustes, performantes et securisees       │
│  avec PostgreSQL.                                            │
└──────────────────────────────────────────────────────────────┘
```

---

## Navigation

| Precedent | Suivant |
|---|---|
| [Module 14 — Securite & Administration](./14-securite-et-administration.md) | Fin du cours |

**Travaux pratiques** : [Lab 15 — Construire le systeme de reservation complet](../labs/lab-15-projet-final.md)

---

> *"La theorie sans la pratique est sterile. La pratique sans la theorie est aveugle. Ce projet final est le pont entre les deux."*
