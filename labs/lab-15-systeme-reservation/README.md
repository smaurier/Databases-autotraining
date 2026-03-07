# Lab 15 — Systeme de reservation (Projet final)

## Objectifs

Ce lab final integre toutes les competences acquises dans les labs precedents pour construire un systeme de reservation complet :

- Modelisation de schema avec contraintes avancees (EXCLUDE, FK, indexes)
- Transactions et verrouillage (FOR UPDATE, Serializable)
- Recherche plein texte (TSVECTOR)
- Analyse de performances (EXPLAIN ANALYZE)
- Fonctions de fenetre et CTEs
- Requetes LATERAL
- Monitoring avec pg_stat_activity
- Gestion de la concurrence avec logique de retry

## Schema

```sql
-- Salles
CREATE TABLE rooms (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  capacity INT NOT NULL,
  amenities JSONB DEFAULT '{}'
);

-- Evenements
CREATE TABLE events (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('french', name || ' ' || COALESCE(description, ''))
  ) STORED
);

-- Reservations (avec contrainte EXCLUDE pour eviter les chevauchements)
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
);

-- Journal d'audit
CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  record_id INT,
  old_data JSONB,
  new_data JSONB,
  performed_by TEXT,
  performed_at TIMESTAMPTZ DEFAULT now()
);
```

## Tests (12)

1. **Schema** — Creer toutes les tables, contraintes, index
2. **Insertion** — Ajouter des salles et evenements
3. **Reservation** — Reserver avec transaction + FOR UPDATE
4. **Double booking** — Contrainte EXCLUDE empeche le chevauchement
5. **Concurrence** — Deux clients en Serializable
6. **Recherche** — Full-text search sur les evenements
7. **EXPLAIN ANALYZE** — Verifier l'usage des index
8. **Window function** — Stats de reservations par salle
9. **CTE** — Rapport de disponibilite
10. **LATERAL** — Prochain creneau disponible par salle
11. **Monitoring** — pg_stat_activity pendant la concurrence
12. **Scenario complet** — Reservation concurrente avec retry

## Lancer le lab

```bash
# Exercice (avec TODOs)
node exercise.js

# Solution
node solution.js
```
