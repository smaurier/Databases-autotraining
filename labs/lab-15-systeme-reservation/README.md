# Lab 15 — Système de réservation TribuZen (Capstone)

> **Capstone** · Construit de zéro · Corrigé SQL inline · Aucun fichier séparé

## Objectif

Livrer un schéma PostgreSQL complet et production-ready pour le système de réservation TribuZen : activités à places limitées, contrainte d'anti-chevauchement (EXCLUDE), index GiST/GIN/B-tree, RLS par famille, transaction Serializable de réservation avec retry, et audit trail par trigger.

**Durée estimée :** 90–120 min  
**Prérequis :** Docker (`docker compose up -d postgres`) · psql ou DBeaver · modules 01–14 vus

---

## Contexte TribuZen

Les familles TribuZen organisent des activités (atelier poterie, sortie nature, cours de cuisine…). Chaque activité propose des **créneaux** horaires avec un nombre de places limité. Les membres réservent des créneaux — si les places sont épuisées, la réservation est refusée même sous charge concurrente.

**Schéma existant supposé déjà en base :**

```sql
-- families(id, name, members_count, ...)
-- users(id, family_id, email, display_name, ...)
```

---

## Étape 1 — Extension et tables de base

### TODO

Crée les tables `activities`, `slots`, `bookings`, `audit_log` avec toutes les contraintes ci-dessous. Active d'abord l'extension nécessaire.

**Contraintes attendues :**
- `activities` : `title` ≥ 3 caractères, `search_vector` GENERATED ALWAYS (tsvector bilingue)
- `slots` : EXCLUDE anti-chevauchement par activité, durée 15 min–12 h, `places_max` entre 1 et 200
- `bookings` : unicité active (slot + user) par index partiel WHERE confirmed, `nb_places` > 0, status parmi `confirmed` / `cancelled`
- `audit_log` : action parmi `INSERT` / `UPDATE` / `DELETE`, clé BIGSERIAL

### Corrigé

```sql
-- Rend les types scalaires (INT) indexables dans GiST — obligatoire pour EXCLUDE ci-dessous
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ============================================================
-- TABLE : activities
-- ============================================================
CREATE TABLE activities (
    id            SERIAL PRIMARY KEY,
    family_id     INT  NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    title         TEXT NOT NULL CHECK (length(trim(title)) >= 3),
    description   TEXT,
    search_vector TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('french', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('french', coalesce(description, '')), 'B')
    ) STORED,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TABLE : slots
-- ============================================================
CREATE TABLE slots (
    id           SERIAL PRIMARY KEY,
    activity_id  INT  NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    family_id    INT  NOT NULL REFERENCES families(id),   -- dénormalisé pour RLS
    time_range   TSTZRANGE NOT NULL,
    places_max   INT  NOT NULL CHECK (places_max > 0 AND places_max <= 200),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Pas de chevauchement de créneaux pour la même activité
    CONSTRAINT no_slot_overlap
        EXCLUDE USING GIST (activity_id WITH =, time_range WITH &&),

    CONSTRAINT min_slot_duration
        CHECK (upper(time_range) - lower(time_range) >= interval '15 minutes'),

    CONSTRAINT max_slot_duration
        CHECK (upper(time_range) - lower(time_range) <= interval '12 hours')
);

-- ============================================================
-- TABLE : bookings
-- ============================================================
CREATE TABLE bookings (
    id          SERIAL PRIMARY KEY,
    slot_id     INT  NOT NULL REFERENCES slots(id)   ON DELETE CASCADE,
    user_id     INT  NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    family_id   INT  NOT NULL REFERENCES families(id),   -- dénormalisé pour RLS
    nb_places   INT  NOT NULL DEFAULT 1 CHECK (nb_places > 0),
    status      TEXT NOT NULL DEFAULT 'confirmed'
                    CHECK (status IN ('confirmed', 'cancelled')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pas de double-booking actif ; autorise la re-réservation après annulation
CREATE UNIQUE INDEX idx_bookings_no_double
    ON bookings(slot_id, user_id) WHERE status = 'confirmed';

-- ============================================================
-- TABLE : audit_log
-- ============================================================
CREATE TABLE audit_log (
    id          BIGSERIAL PRIMARY KEY,
    table_name  TEXT        NOT NULL,
    record_id   INT         NOT NULL,
    action      TEXT        NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
    old_data    JSONB,
    new_data    JSONB,
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Vérification rapide :**

```sql
\d slots     -- doit afficher la contrainte no_slot_overlap
\d bookings  -- doit afficher l'index idx_bookings_no_double
SELECT * FROM pg_extension WHERE extname = 'btree_gist';   -- doit retourner 1 ligne
```

---

## Étape 2 — Index

### TODO

Ajoute les index manquants :
- B-tree sur toutes les FK (activities, slots, bookings)
- GiST sur `slots.time_range` (en plus de celui créé implicitement par EXCLUDE)
- GIN sur `activities.search_vector`
- Partial B-tree sur `bookings(slot_id, nb_places)` pour les réservations confirmées seulement

### Corrigé

```sql
-- B-tree FK : accélèrent JOIN et lookups par id
CREATE INDEX idx_activities_family ON activities(family_id);
CREATE INDEX idx_slots_activity    ON slots(activity_id);
CREATE INDEX idx_slots_family      ON slots(family_id);
CREATE INDEX idx_bookings_slot     ON bookings(slot_id);
CREATE INDEX idx_bookings_user     ON bookings(user_id);
CREATE INDEX idx_bookings_family   ON bookings(family_id);

-- GiST : opérateurs de disponibilité (&&, @>) et contrainte EXCLUDE
CREATE INDEX idx_slots_range ON slots USING GIST (time_range);

-- GIN : full-text search sur titre + description en français
CREATE INDEX idx_activities_fts ON activities USING GIN (search_vector);

-- Partial : compter uniquement les places prises actives, ignorer les annulations
CREATE INDEX idx_bookings_active ON bookings(slot_id, nb_places)
    WHERE status = 'confirmed';

ANALYZE activities, slots, bookings;
```

---

## Étape 3 — Données de test

```sql
-- Adapter les IDs si families/users existent déjà en base
INSERT INTO families (id, name) VALUES (1, 'Les Martin'), (2, 'Les Durand')
    ON CONFLICT DO NOTHING;

INSERT INTO users (id, family_id, email, display_name) VALUES
    (10, 1, 'alice@martin.fr',  'Alice Martin'),
    (11, 1, 'bob@martin.fr',    'Bob Martin'),
    (12, 1, 'eve@martin.fr',    'Eve Martin'),
    (20, 2, 'claire@durand.fr', 'Claire Durand')
ON CONFLICT DO NOTHING;

-- Activités
INSERT INTO activities (id, family_id, title, description) VALUES
    (42, 1, 'Atelier poterie',  'Initiation à la poterie japonaise pour toute la famille'),
    (43, 1, 'Sortie nature',    'Randonnée en forêt avec identification des plantes'),
    (44, 2, 'Cuisine italienne','Pasta, pizza et tiramisu maison');

-- Créneaux (TSTZRANGE avec borne supérieure exclue '[)')
INSERT INTO slots (id, activity_id, family_id, time_range, places_max) VALUES
    (100, 42, 1, tstzrange('2026-08-02 10:00+02', '2026-08-02 12:00+02', '[)'), 5),
    (101, 42, 1, tstzrange('2026-08-09 10:00+02', '2026-08-09 12:00+02', '[)'), 5),
    (102, 43, 1, tstzrange('2026-08-03 09:00+02', '2026-08-03 13:00+02', '[)'), 8),
    (103, 44, 2, tstzrange('2026-08-05 18:00+02', '2026-08-05 21:00+02', '[)'), 6);

-- Réservations initiales : 3 places prises sur le créneau 100 → il reste 2
INSERT INTO bookings (slot_id, user_id, family_id, nb_places, status) VALUES
    (100, 10, 1, 2, 'confirmed'),
    (100, 11, 1, 1, 'confirmed');
```

**Vérification :**

```sql
-- Doit retourner 2 places disponibles sur le créneau 100
SELECT s.places_max - COALESCE(SUM(b.nb_places), 0) AS places_dispo
FROM slots s
LEFT JOIN bookings b ON b.slot_id = s.id AND b.status = 'confirmed'
WHERE s.id = 100
GROUP BY s.places_max;
-- → 2
```

---

## Étape 4 — Fonction de réservation et gestion de concurrence

### TODO

Écris la fonction PL/pgSQL `book_slot(p_slot_id, p_user_id, p_family_id, p_nb_places)` qui :
1. Lit les places disponibles dans la transaction courante
2. Lève une exception métier si le créneau est introuvable ou complet
3. Insère la réservation et retourne l'id créé

### Corrigé

```sql
CREATE OR REPLACE FUNCTION book_slot(
    p_slot_id   INT,
    p_user_id   INT,
    p_family_id INT,
    p_nb_places INT DEFAULT 1
)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
    v_places_dispo INT;
    v_booking_id   INT;
BEGIN
    -- Lire les places disponibles dans le snapshot de la transaction courante
    -- (en Serializable, une écriture concurrente déclenchera 40001 au COMMIT)
    SELECT s.places_max - COALESCE(SUM(b.nb_places), 0)
    INTO   v_places_dispo
    FROM   slots s
    LEFT   JOIN bookings b ON b.slot_id = s.id AND b.status = 'confirmed'
    WHERE  s.id = p_slot_id
    GROUP  BY s.places_max;

    IF v_places_dispo IS NULL THEN
        RAISE EXCEPTION 'SLOT_NOT_FOUND : créneau % inexistant', p_slot_id;
    END IF;

    IF v_places_dispo < p_nb_places THEN
        RAISE EXCEPTION 'SLOT_FULL : % place(s) disponible(s), % demandée(s)',
            v_places_dispo, p_nb_places;
    END IF;

    INSERT INTO bookings (slot_id, user_id, family_id, nb_places)
    VALUES (p_slot_id, p_user_id, p_family_id, p_nb_places)
    RETURNING id INTO v_booking_id;

    RETURN v_booking_id;
END;
$$;
```

**Test nominal :**

```sql
-- user 12 (Eve) prend les 2 dernières places du créneau 100
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT set_config('app.family_id', '1', true);
SELECT book_slot(100, 12, 1, 2);   -- doit retourner un id entier
COMMIT;

-- Vérification : 0 place restante
SELECT s.places_max - COALESCE(SUM(b.nb_places), 0) AS places_dispo
FROM slots s
LEFT JOIN bookings b ON b.slot_id = s.id AND b.status = 'confirmed'
WHERE s.id = 100
GROUP BY s.places_max;
-- → 0

-- Tentative sur créneau plein : doit lever SLOT_FULL
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT book_slot(100, 20, 2, 1);
COMMIT;
-- ERROR:  SLOT_FULL : 0 place(s) disponible(s), 1 demandée(s)
```

---

### Simulation de concurrence (deux sessions psql)

Ouvre deux terminaux. Annule d'abord la réservation d'Eve pour retrouver 2 places :

```sql
UPDATE bookings SET status = 'cancelled', updated_at = now()
WHERE slot_id = 100 AND user_id = 12;
```

Puis joue le scénario simultané — démarre les deux sessions **avant** de taper `COMMIT` dans l'une :

```sql
-- SESSION A                                         -- SESSION B
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;      BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT set_config('app.family_id', '1', true);       SELECT set_config('app.family_id', '1', true);
SELECT book_slot(100, 12, 1, 2);                     SELECT book_slot(100, 20, 1, 2);
-- (les deux fonctions lisent 2 places dispo)
COMMIT;  -- Session A commite en première              COMMIT;
-- → retourne l'id de réservation (succès)            -- → ERROR 40001: could not serialize access
```

Session B doit **réessayer** dans l'application. Pattern Node.js de référence :

```javascript
async function bookSlotWithRetry(pool, slotId, userId, familyId, nbPlaces, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      await client.query(
        "SELECT set_config('app.family_id', $1::text, true)", [familyId]
      );
      const { rows } = await client.query(
        'SELECT book_slot($1, $2, $3, $4) AS booking_id',
        [slotId, userId, familyId, nbPlaces]
      );
      await client.query('COMMIT');
      return rows[0].booking_id;
    } catch (err) {
      await client.query('ROLLBACK');
      if ((err.code === '40001' || err.code === '40P01') && attempt < maxRetries) {
        const delay = Math.min(50 * Math.pow(2, attempt) + Math.random() * 50, 3000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;  // SLOT_FULL ou autre erreur → propager à l'appelant
    } finally {
      client.release();
    }
  }
  throw new Error('MAX_RETRIES_EXCEEDED');
}
```

---

## Étape 5 — RLS par famille

### TODO

Active RLS sur `activities`, `slots`, `bookings`. Crée le rôle `reservation_app` et les policies d'isolation par `family_id`.

### Corrigé

```sql
CREATE ROLE reservation_app LOGIN PASSWORD 'tribuzen_secret';
GRANT SELECT, INSERT, UPDATE ON activities, slots, bookings TO reservation_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO reservation_app;
GRANT EXECUTE ON FUNCTION book_slot(INT, INT, INT, INT) TO reservation_app;

ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE slots      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings   ENABLE ROW LEVEL SECURITY;

CREATE POLICY family_isolation ON activities FOR ALL TO reservation_app
    USING      (family_id = current_setting('app.family_id', true)::int)
    WITH CHECK (family_id = current_setting('app.family_id', true)::int);

CREATE POLICY family_isolation ON slots FOR ALL TO reservation_app
    USING      (family_id = current_setting('app.family_id', true)::int)
    WITH CHECK (family_id = current_setting('app.family_id', true)::int);

CREATE POLICY family_isolation ON bookings FOR ALL TO reservation_app
    USING      (family_id = current_setting('app.family_id', true)::int)
    WITH CHECK (family_id = current_setting('app.family_id', true)::int);
```

**Test d'isolation :**

```sql
-- Se connecter en tant que rôle applicatif (pas en superuser)
SET ROLE reservation_app;

-- Famille Martin (family_id = 1) : doit voir uniquement ses activités
SELECT set_config('app.family_id', '1', true);
SELECT id, title FROM activities ORDER BY id;
-- → 2 lignes : Atelier poterie (42) + Sortie nature (43)
-- NE doit PAS retourner Cuisine italienne (44, family_id = 2)

-- Famille Durand (family_id = 2) : doit voir uniquement sa cuisine
SELECT set_config('app.family_id', '2', true);
SELECT id, title FROM activities ORDER BY id;
-- → 1 ligne : Cuisine italienne (44)

-- Tentative d'insertion cross-tenant : doit échouer avec RLS violation
INSERT INTO activities (family_id, title) VALUES (1, 'Tentative cross-tenant');
-- ERROR:  new row violates row-level security policy for table "activities"

RESET ROLE;
```

---

## Étape 6 — Trigger d'audit

### Corrigé

```sql
CREATE OR REPLACE FUNCTION audit_fn()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO audit_log (table_name, record_id, action, old_data, new_data)
    VALUES (
        TG_TABLE_NAME,
        COALESCE(NEW.id, OLD.id),
        TG_OP,
        CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
        CASE WHEN TG_OP IN ('INSERT', 'UPDATE')  THEN to_jsonb(NEW) END
    );
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_audit_bookings
    AFTER INSERT OR UPDATE OR DELETE ON bookings
    FOR EACH ROW EXECUTE FUNCTION audit_fn();
```

**Vérification :**

```sql
-- Annuler une réservation et vérifier la trace dans audit_log
UPDATE bookings SET status = 'cancelled', updated_at = now()
WHERE slot_id = 100 AND user_id = 10;

SELECT table_name,
       action,
       old_data->>'status'  AS old_status,
       new_data->>'status'  AS new_status,
       changed_at
FROM audit_log
ORDER BY id DESC LIMIT 1;
-- → bookings | UPDATE | confirmed | cancelled | 2026-...

-- Vérifier que l'insert initial a aussi été audité
SELECT action, new_data->>'slot_id' AS slot, new_data->>'nb_places' AS places
FROM audit_log
WHERE table_name = 'bookings'
ORDER BY id;
-- → INSERT pour chaque booking initial, UPDATE pour l'annulation
```

---

## Étape 7 — EXPLAIN ANALYZE et validation de performance

```sql
-- Requête de disponibilité avec FTS : vérifier GIN et index partiel
EXPLAIN (ANALYZE, BUFFERS)
SELECT
    a.title,
    s.id                                              AS slot_id,
    lower(s.time_range)                               AS debut,
    s.places_max - COALESCE(SUM(b.nb_places), 0)     AS places_dispo,
    ts_rank(a.search_vector,
            websearch_to_tsquery('french', 'poterie')) AS score
FROM activities a
JOIN slots s ON s.activity_id = a.id
LEFT JOIN bookings b ON b.slot_id = s.id AND b.status = 'confirmed'
WHERE a.search_vector @@ websearch_to_tsquery('french', 'poterie')
  AND upper(s.time_range) > now()
GROUP BY a.title, s.id, a.search_vector
HAVING s.places_max - COALESCE(SUM(b.nb_places), 0) > 0
ORDER BY score DESC, debut;
```

**Plan attendu (lignes clés à vérifier) :**

```
Bitmap Index Scan on idx_activities_fts     ← GIN utilisé pour FTS
Index Scan using idx_slots_activity          ← pas de Seq Scan sur slots
Index Scan using idx_bookings_active         ← index partiel utilisé
```

Si le plan montre des Seq Scan sur de petits jeux de données (< 1 000 lignes), c'est normal — le planner préfère le Seq Scan quand la table tient en cache. Pour forcer un vrai benchmark, injecter au moins 10 000 lignes avec `generate_series`.

**Test de la contrainte EXCLUDE :**

```sql
-- Tenter d'insérer un créneau chevauchant le slot 100 (même activité, même heure)
INSERT INTO slots (activity_id, family_id, time_range, places_max)
VALUES (42, 1, tstzrange('2026-08-02 11:00+02', '2026-08-02 13:00+02', '[)'), 3);
-- ERROR:  conflicting key value violates exclusion constraint "no_slot_overlap"
-- ✓ EXCLUDE fonctionne

-- Un créneau non chevauchant doit passer sans erreur
INSERT INTO slots (activity_id, family_id, time_range, places_max)
VALUES (42, 1, tstzrange('2026-08-02 14:00+02', '2026-08-02 16:00+02', '[)'), 3);
-- INSERT 0 1 ✓
```

---

## Checklist de livraison

- [ ] Extension `btree_gist` activée
- [ ] Tables créées avec toutes les contraintes (CHECK, EXCLUDE, UNIQUE partiel)
- [ ] Index B-tree sur toutes les FK
- [ ] Index GiST sur `slots.time_range`
- [ ] Index GIN sur `activities.search_vector`
- [ ] Index partiel sur `bookings(slot_id, nb_places) WHERE status = 'confirmed'`
- [ ] Fonction `book_slot()` créée et testée (nominal + SLOT_FULL)
- [ ] Concurrence testée : session B reçoit `40001`, retry pattern documenté
- [ ] RLS actif : famille A ne voit pas les données de famille B
- [ ] Insert cross-tenant échoue avec RLS violation
- [ ] Trigger d'audit en place : UPDATE de booking trace `old_data` et `new_data`
- [ ] `EXPLAIN ANALYZE` confirme GIN et index partiel utilisés
- [ ] Contrainte EXCLUDE refuse un créneau chevauchant, accepte un créneau adjacent

---

## Questions J+30

1. Que se passe-t-il si la session A ne tape jamais `COMMIT` dans le test de concurrence ? Pourquoi la session B reste-t-elle bloquée ou reçoit-elle `40001` immédiatement ?
2. Pourquoi `family_id` est-il dénormalisé dans `slots` plutôt que résolu via `activities.family_id` à l'exécution ? Quel est le risque si `activities.family_id` change ?
3. Quel est l'impact sur les performances si tu remplaçes l'index partiel `WHERE status = 'confirmed'` par une contrainte `UNIQUE (slot_id, user_id)` sans clause WHERE ?
4. Comment partitionner `audit_log` par mois (`PARTITION BY RANGE (changed_at)`) sans casser le trigger `audit_fn()` existant ?
5. La policy `family_isolation` actuelle autorise-t-elle un admin à voir toutes les familles ? Comment ajouter une exception pour le rôle `admin_app` sans désactiver RLS ?
