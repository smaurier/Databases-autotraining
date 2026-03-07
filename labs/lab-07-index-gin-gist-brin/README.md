# Lab 07 — Index GIN, GiST et BRIN

## Objectifs

- Comprendre les index GIN (Generalized Inverted Index) pour JSONB, tableaux, full-text
- Comprendre les index BRIN (Block Range INdex) pour les donnees ordonnees
- Comprendre les index GiST (Generalized Search Tree) pour les ranges
- Comparer tailles et performances des differents types d'index

## Pre-requis

- Labs 05 et 06 termines
- Comprendre EXPLAIN et les index B-tree

## Schema

```sql
-- Produits avec donnees JSONB
CREATE TABLE products_json (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  data JSONB NOT NULL
);

-- Evenements avec timestamps sequentiels
CREATE TABLE events (
  id         SERIAL PRIMARY KEY,
  event_name TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  metadata   JSONB
);

-- Table avec tags (tableau de texte)
CREATE TABLE tags_table (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  tags TEXT[] NOT NULL
);
```

## Instructions

1. Ouvrez `exercise.js`
2. Completez les 10 TODOs
3. Lancez avec `node exercise.js`
4. Objectif : 10/10

## Tests attendus

| # | Description |
|---|-------------|
| 1 | JSONB sans GIN → Seq Scan |
| 2 | GIN sur JSONB → Index Scan avec @> |
| 3 | GIN + operateur ? (existence de cle) |
| 4 | BRIN sur timestamps → scan de plage |
| 5 | Comparaison taille BRIN vs B-tree |
| 6 | GIN sur tableau TEXT[] avec @> |
| 7 | GiST sur tsrange pour chevauchement |
| 8 | Comparaison performances (no index vs GIN vs B-tree) |
| 9 | Full-text search avec GIN |
| 10 | GIN partiel sur JSONB |
