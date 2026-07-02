---
titre: Projet final
cours: 10-postgresql
notions: [concevoir un schéma complet, contraintes index et RLS combinés, requêtes optimisées, transactions et concurrence, du besoin au schéma production-ready, synthèse du cours]
outcomes: [concevoir une base complète (schéma, contraintes, index, RLS), écrire des requêtes optimisées et transactionnelles, livrer un schéma prêt pour la production]
prerequis: [14-securite-et-administration]
next: 16-replication
libs: [{ name: postgresql, version: "17" }]
tribuzen: concevoir la base complète d'un système de réservation TribuZen (places limitées, concurrence, RLS) — capstone
last-reviewed: 2026-07
---

# Projet final

> **Outcomes — tu sauras FAIRE :** concevoir une base de données complète de zéro (schéma, contraintes, index, RLS), écrire une transaction Serializable de réservation avec gestion de concurrence et retry, et livrer un schéma production-ready documenté et testé.
> **Difficulté :** :star::star::star::star::star:

## 1. Cas concret d'abord

La famille « Les Martin » (family_id = 3) veut s'inscrire à l'atelier poterie du samedi — 5 places, 3 déjà réservées, 2 disponibles. Deux membres de la famille ouvrent l'app simultanément et cliquent « Réserver » en même temps depuis leurs téléphones respectifs.

```sql
-- Ce que les deux sessions lisent (Read Committed, défaut) :
SELECT s.places_max - COALESCE(SUM(b.nb_places), 0) AS places_dispo
FROM slots s
LEFT JOIN bookings b ON b.slot_id = s.id AND b.status = 'confirmed'
WHERE s.id = 42
GROUP BY s.places_max;
-- → 2 (dans les deux sessions simultanément)
```

Sans protection, les deux insèrent chacune 2 places → 7 réservations pour 5 places : overbooking. La seule façon d'interdire ça **au niveau de la base** est de combiner :

1. Un schéma propre — types exacts (`TSTZRANGE`), contraintes CHECK et EXCLUDE au niveau DDL
2. Des index adaptés — GiST pour les ranges, GIN pour la recherche plein-texte, B-tree sur toutes les FK
3. Des politiques RLS qui isolent chaque famille via `current_setting('app.family_id')`
4. Une transaction Serializable qui relit les places dans son propre snapshot ; si une concurrente a écrit entre la lecture et l'INSERT, PostgreSQL lève `40001` → retry côté applicatif

C'est le fil conducteur de ce module : **du besoin au schéma production-ready**, en mobilisant tout ce que tu as vu depuis le module 01.

## 2. Théorie complète, concise

### Du besoin au schéma : démarche ingénieur

Ne jamais ouvrir `psql` avant d'avoir une liste de besoins. La démarche :

1. **Stories utilisateur** — « En tant que membre, je veux réserver un créneau pour l'activité de ma famille. »
2. **Entités + relations** — Identifier les nœuds (activité, créneau, réservation, famille, utilisateur) et leurs cardinalités (1–N, N–N).
3. **Normalisation 3NF** — Chaque attribut dépend de la clé entière et de rien d'autre. Dénormaliser uniquement si `EXPLAIN ANALYZE` prouve que la jointure est le goulot.
4. **Contraintes au plus tôt** — `CHECK`, `UNIQUE`, `EXCLUDE`, `NOT NULL` au niveau DDL ; la cohérence ne se délègue pas à l'application.
5. **Index après schéma** — Un index par FK d'abord, puis les index spécialisés (GiST, GIN) une fois le schéma stabilisé et les données de test insérées.
6. **RLS en dernier** — Les politiques s'appuient sur le schéma finalisé et un rôle applicatif dédié.

### Schéma du système de réservation TribuZen

`families` et `users` existent déjà dans TribuZen. Quatre nouvelles tables :

| Table | Rôle |
|---|---|
| `activities` | Activités organisées par une famille (atelier, sortie, cours…) |
| `slots` | Créneaux horaires d'une activité — durée + nombre de places |
| `bookings` | Réservation d'un créneau par un utilisateur |
| `audit_log` | Journal immuable de toutes les modifications (INSERT / UPDATE / DELETE) |

### Contraintes combinées

Trois types de contraintes se complètent :

- **CHECK** : valeurs métier (`places_max > 0`, durée ≥ 15 min et ≤ 12 h, `nb_places > 0`).
- **EXCLUDE USING GIST** : interdit le chevauchement de créneaux pour la **même** activité. Requiert l'extension `btree_gist` pour rendre le type `INT` indexable dans GiST.
- **Index partiel UNIQUE** : pas de double-booking pour un utilisateur sur un créneau actif. Un index partiel (`WHERE status = 'confirmed'`) autorise la re-réservation après annulation, contrairement à une contrainte table-level `UNIQUE (slot_id, user_id)` simple.

```sql
-- Interdit le chevauchement pour une même activité (requiert btree_gist)
CONSTRAINT no_slot_overlap
    EXCLUDE USING GIST (activity_id WITH =, time_range WITH &&)

-- Index partiel : pas de double-booking actif, re-réservation possible après annulation
CREATE UNIQUE INDEX idx_bookings_no_double
    ON bookings(slot_id, user_id) WHERE status = 'confirmed';
```

### Stratégie d'index

| Type | Colonnes cibles | Pourquoi |
|---|---|---|
| B-tree | FK de toutes les tables | Accélère les JOIN et les lookups par id |
| GiST | `slots(time_range)` | Contrainte EXCLUDE + opérateurs de disponibilité (`&&`, `@>`) |
| GIN | `activities(search_vector)` | Full-text search sur titre + description |
| Partial B-tree | `bookings(slot_id, nb_places) WHERE status = 'confirmed'` | Comptage rapide des places prises sans lire les annulations |

Règle : créer l'index après les données de test, mesurer avec `EXPLAIN (ANALYZE, BUFFERS)`, supprimer ceux que le planner ignore.

### RLS par famille

Le rôle `reservation_app` se connecte pour toutes les familles. Le middleware applicatif pose `app.family_id` avant chaque requête :

```sql
-- Middleware : avant chaque requête de l'API
SELECT set_config('app.family_id', $1::text, true);  -- local à la transaction

-- Policy unifiée (même pattern sur activities, slots, bookings)
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

CREATE POLICY family_isolation ON bookings
    FOR ALL TO reservation_app
    USING      (family_id = current_setting('app.family_id', true)::int)
    WITH CHECK (family_id = current_setting('app.family_id', true)::int);
```

Piège : un superuser et les rôles `BYPASSRLS` contournent silencieusement RLS. Tester uniquement en se connectant avec `SET ROLE reservation_app` pour voir les vraies restrictions.

### Transaction de réservation : Serializable + retry

```sql
-- Schéma de la transaction (appel depuis Node.js via pg.Pool)
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SELECT set_config('app.family_id', '3', true);

-- 1. Lire les places disponibles dans le snapshot Serializable
SELECT s.places_max - COALESCE(SUM(b.nb_places), 0) AS places_dispo
FROM   slots s
LEFT   JOIN bookings b ON b.slot_id = s.id AND b.status = 'confirmed'
WHERE  s.id = 42
GROUP  BY s.places_max;
-- → 2 dans ce snapshot

-- 2. Si places_dispo >= demandes : insérer
INSERT INTO bookings (slot_id, user_id, family_id, nb_places)
VALUES (42, 17, 3, 2);

COMMIT;
-- Si une transaction concurrente a inséré avant ce COMMIT :
-- ERROR 40001 : could not serialize access due to concurrent update
-- → retry côté applicatif (max 5, backoff exponentiel 50ms × 2^n + jitter)
```

Serializable garantit que le résultat concurrent équivaut à une exécution séquentielle : deux transactions qui lisent « 2 places dispo » et tentent toutes les deux d'insérer → la première commite, la seconde reçoit `40001` et **doit** réessayer après avoir relu.

## 3. Worked examples

### Exemple A — Schéma complet

```sql
-- Extension obligatoire : rend INT indexable dans GiST (nécessaire pour EXCLUDE)
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

    -- Durée 15 min minimum
    CONSTRAINT min_slot_duration
        CHECK (upper(time_range) - lower(time_range) >= interval '15 minutes'),

    -- Durée 12 h maximum
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
    family_id   INT  NOT NULL REFERENCES families(id),  -- dénormalisé pour RLS
    nb_places   INT  NOT NULL DEFAULT 1 CHECK (nb_places > 0),
    status      TEXT NOT NULL DEFAULT 'confirmed'
                    CHECK (status IN ('confirmed', 'cancelled')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index partiel : pas de double-booking actif ; la re-réservation reste possible après annulation
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

### Exemple B — Index, RLS, transaction et audit

**Index :**

```sql
-- B-tree sur toutes les FK
CREATE INDEX idx_activities_family ON activities(family_id);
CREATE INDEX idx_slots_activity    ON slots(activity_id);
CREATE INDEX idx_slots_family      ON slots(family_id);
CREATE INDEX idx_bookings_slot     ON bookings(slot_id);
CREATE INDEX idx_bookings_user     ON bookings(user_id);
CREATE INDEX idx_bookings_family   ON bookings(family_id);

-- GiST : disponibilité et contrainte EXCLUDE (btree_gist déjà actif)
CREATE INDEX idx_slots_range ON slots USING GIST (time_range);

-- GIN : full-text search sur titre + description en français
CREATE INDEX idx_activities_fts ON activities USING GIN (search_vector);

-- Partial B-tree : compter uniquement les places prises actives
CREATE INDEX idx_bookings_active ON bookings(slot_id, nb_places)
    WHERE status = 'confirmed';

ANALYZE activities, slots, bookings;
```

**RLS par famille :**

```sql
CREATE ROLE reservation_app LOGIN PASSWORD 'tribuzen_secret';
GRANT SELECT, INSERT, UPDATE ON activities, slots, bookings TO reservation_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO reservation_app;

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

-- Vérification : se connecter en tant que rôle applicatif
-- SET ROLE reservation_app;
-- SELECT set_config('app.family_id', '3', true);
-- SELECT * FROM activities;  -- doit retourner uniquement family_id = 3
```

**Fonction de réservation atomique :**

```sql
CREATE OR REPLACE FUNCTION book_slot(
    p_slot_id   INT,
    p_user_id   INT,
    p_family_id INT,
    p_nb_places INT DEFAULT 1
)
RETURNS INT   -- id de la réservation créée
LANGUAGE plpgsql AS $$
DECLARE
    v_places_dispo INT;
    v_booking_id   INT;
BEGIN
    -- Lire les places disponibles dans le snapshot de la transaction courante
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

-- Appel depuis l'API (dans une transaction Serializable) :
-- BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
-- SELECT set_config('app.family_id', '3', true);
-- SELECT book_slot(42, 17, 3, 2);
-- COMMIT;
-- → 40001 si concurrent : retry avec backoff exponentiel (max 5 tentatives)
```

**Trigger d'audit :**

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

**Requête de disponibilité avec Full-Text Search :**

```sql
-- Créneaux disponibles pour les activités TribuZen correspondant à « poterie »
SELECT
    a.title,
    s.id                                              AS slot_id,
    lower(s.time_range)                               AS debut,
    upper(s.time_range)                               AS fin,
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

Pas-à-pas : (1) `search_vector @@` exploite l'index GIN `idx_activities_fts` → pas de Seq Scan sur `activities` ; (2) la jointure LEFT avec `b.status = 'confirmed'` utilise `idx_bookings_active` (index partiel) → seules les lignes actives participent au `SUM` ; (3) le filtre `HAVING` exclut les créneaux complets sans sous-requête supplémentaire ; (4) `ts_rank` trie par pertinence sans coût additionnel car `search_vector` est une colonne `STORED`.

## 4. Pièges & misconceptions

- **Oublier `btree_gist` avant une contrainte EXCLUDE sur un scalaire + TSTZRANGE.** `EXCLUDE USING GIST (activity_id WITH =, time_range WITH &&)` nécessite que `INT` soit indexable dans GiST, ce que `btree_gist` active. Sans l'extension, PostgreSQL lève `operator class "=" is not supported for access method "gist"` au moment du `CREATE TABLE`. *Correct* : `CREATE EXTENSION IF NOT EXISTS btree_gist` en première ligne du script DDL.

- **Compter les places disponibles hors transaction.** Lire `COUNT(bookings)` dans une requête séparée puis insérer dans une autre laisse une fenêtre de race condition — deux sessions lisent « 2 dispo », insèrent toutes les deux. *Correct* : lire et insérer dans **une seule** transaction Serializable via `book_slot()` ; le moteur lève `40001` si un concurrent a écrit entre les deux, et l'appelant réessaie.

- **Tester RLS avec le superuser.** Par défaut, le superuser et les rôles `BYPASSRLS` court-circuitent silencieusement toutes les policies — les tests passent, la sécurité est fictive. *Correct* : tester systématiquement avec `SET ROLE reservation_app` et `set_config('app.family_id', ...)` pour voir les vraies restrictions.

- **UNIQUE (slot_id, user_id) sans exclure les annulations.** Avec une contrainte table-level simple, un utilisateur qui annule sa réservation ne peut jamais re-réserver le même créneau — la ligne annulée occupe toujours la contrainte unique. *Correct* : un index partiel `WHERE status = 'confirmed'` n'interdit que les doublons actifs et autorise la re-réservation après annulation.

- **Dénormaliser `family_id` sans garantir la cohérence.** `slots.family_id` est copié depuis `activities.family_id` pour simplifier les policies RLS. Si `activities.family_id` change sans mettre à jour `slots.family_id`, les données deviennent incohérentes et la RLS filtre mal. *Correct* : un trigger `BEFORE INSERT OR UPDATE` sur `slots` qui copie `family_id` depuis `activities`, ou une FK check déclenchée à chaque écriture.

- **Négliger le retry sur `40001`.** Choisir Serializable sans gérer le retry produit des erreurs visibles par l'utilisateur sur des opérations parfaitement légitimes — pas un bug applicatif, une collision normale de concurrence. *Correct* : encapsuler la transaction dans une boucle (max 5 tentatives, backoff 50 ms × 2^n + jitter aléatoire) ; loguer chaque retry pour détecter un taux anormalement élevé de collisions (hot spot sur un créneau très demandé).

## 5. Ancrage TribuZen

Couche fil-rouge : **concevoir la base complète** dans `smaurier/tribuzen` — ce capstone ajoute les quatre tables (`activities`, `slots`, `bookings`, `audit_log`) au schéma existant (`families`, `users`, `family_member`).

- Le schéma est **production-ready** dès le départ : extension `btree_gist`, contrainte EXCLUDE sur `slots`, index partiel unique sur `bookings`, GIN pour la recherche d'activités en français.
- La fonction `book_slot()` est le **point d'entrée unique** pour toute réservation TribuZen : zéro logique de concurrence côté Node.js, tout est encapsulé dans la transaction Serializable.
- RLS isole chaque famille : « Les Martin » ne voient que leurs activités et réservations, même si le pool de connexions `pg.Pool` est partagé entre toutes les familles de la plateforme.
- Le trigger d'audit sur `bookings` constitue le journal légal du système : chaque annulation conserve l'état `old_data` en JSONB, immuable et requêtable.
- La requête de disponibilité avec FTS (Exemple B) alimente directement la vue « Trouver une activité » de l'app React Native — score de pertinence + filtre places restantes en un seul aller-retour, sous 2 ms avec les index GIN et GiST.
- Ce schéma sera repris au module 16 (réplication logique) : `activities` et `slots` (lecture intensive) seront routés vers un replica dédié, `bookings` (écriture critique) resteront sur le primaire.

## 6. Points clés

1. Commencer par les besoins et les entités ; normaliser en 3NF avant tout ; dénormaliser uniquement après que `EXPLAIN ANALYZE` prouve un goulot sur une jointure.
2. Activer `btree_gist` avant toute contrainte `EXCLUDE USING GIST` qui mélange un type scalaire (INT) et un type range (TSTZRANGE) — sans l'extension, le DDL échoue.
3. Le comptage des places disponibles et l'INSERT **doivent** être dans la même transaction Serializable ; séparer la lecture et l'écriture ouvre une race condition incontrôlable.
4. RLS s'appuie sur un rôle dédié (`reservation_app`) et une variable de session (`app.family_id`) ; ne jamais tester en superuser — les policies sont invisibles en BYPASSRLS.
5. La contrainte `UNIQUE (slot_id, user_id)` simple bloque la re-réservation après annulation ; un index partiel `WHERE status = 'confirmed'` n'interdit que les doublons actifs.
6. Tout audit de donnée sensible passe par un trigger AFTER qui écrit `old_data` / `new_data` en JSONB — la base garantit la traçabilité, l'application n'a pas à s'en charger.
7. Chaque transaction Serializable susceptible d'entrer en conflit doit avoir une boucle de retry sur `40001` avec backoff exponentiel et jitter ; loguer le taux de retry pour détecter les hot spots.
8. La conception suit un ordre strict : besoins → entités → normalisation → contraintes → index → données de test → `EXPLAIN ANALYZE` → RLS → tests de sécurité.

## 7. Seeds Anki

```
Pourquoi activer btree_gist avant EXCLUDE USING GIST avec un INT et un TSTZRANGE ?|L'extension rend les types scalaires (INT) indexables dans GiST ; sans elle PostgreSQL lève "operator class = is not supported for access method gist" au CREATE TABLE
Comment interdire le chevauchement de créneaux pour une même activité ?|CONSTRAINT no_slot_overlap EXCLUDE USING GIST (activity_id WITH =, time_range WITH &&) — nécessite btree_gist activé
Pourquoi le comptage des places disponibles doit-il être dans la même transaction que l'INSERT ?|Lire puis insérer séparément ouvre une race condition ; deux sessions lisent "2 dispo" et insèrent toutes les deux → overbooking. Serializable dans la même transaction → la deuxième reçoit 40001 et réessaie
Comment tester une policy RLS sans être superuser ?|SET ROLE reservation_app; SELECT set_config('app.family_id', '3', true); — le superuser et les rôles BYPASSRLS court-circuitent silencieusement toutes les policies
Quelle différence entre UNIQUE (slot_id, user_id) et un index partiel WHERE status = confirmed ?|La contrainte table-level bloque toute re-réservation même après annulation ; l'index partiel n'interdit que les doublons actifs, permettant de re-réserver un créneau annulé
Comment gérer l'erreur 40001 côté applicatif ?|Boucle de retry (max 5 tentatives), backoff exponentiel 50ms × 2^n + jitter aléatoire, log du taux de collisions pour détecter les hot spots
Quel rôle joue le trigger AFTER INSERT OR UPDATE OR DELETE sur bookings ?|Écrire chaque modification dans audit_log avec old_data et new_data en JSONB — la traçabilité est garantie par la base, pas par l'application
Quel type PostgreSQL modélise un créneau avec ses deux bornes inclusif/exclusif ?|TSTZRANGE — stocke debut et fin, supporte les opérateurs de chevauchement (&&) et containment (@>), et s'indexe avec GiST
Quel ordre suivre pour un schéma production-ready ?|besoins → entités → normalisation 3NF → contraintes (CHECK, EXCLUDE, UNIQUE) → index → données de test → EXPLAIN ANALYZE → RLS → tests de sécurité
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-15-systeme-reservation/`. Tu construis de zéro le schéma complet du système de réservation TribuZen — activités, créneaux, réservations, audit — avec toutes les contraintes, index et policies RLS. Tu écris la fonction `book_slot()`, tu observes la gestion de concurrence en deux sessions psql, et tu vérifies que RLS isole correctement les familles. Corrigé SQL inline dans le README, aucun fichier séparé.
