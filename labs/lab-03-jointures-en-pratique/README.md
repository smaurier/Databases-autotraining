# Lab 03 — Jointures en pratique

## Objectifs

- Maîtriser les différents types de jointures (INNER, LEFT, RIGHT, FULL OUTER)
- Comprendre les tables de jonction (many-to-many)
- Combiner jointures avec GROUP BY et agregations
- Comparer sous-requêtes et jointures

## Pre-requis

- Labs 01 et 02 termines
- Bonne comprehension de SELECT et WHERE

## Schema

```sql
-- Table des auteurs
CREATE TABLE authors (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  nationality TEXT
);

-- Table des livres
CREATE TABLE books (
  id             SERIAL PRIMARY KEY,
  title          TEXT NOT NULL,
  author_id      INTEGER REFERENCES authors(id),
  published_year INTEGER
);

-- Table des categories
CREATE TABLE categories (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- Table de jonction livres <-> categories (many-to-many)
CREATE TABLE book_categories (
  book_id     INTEGER REFERENCES books(id),
  category_id INTEGER REFERENCES categories(id),
  PRIMARY KEY (book_id, category_id)
);
```

## Instructions

1. Ouvrez le fichier `exercise.js`
2. Completez les 10 TODOs
3. Lancez avec `node exercise.js`
4. Objectif : 10/10 tests

## Tests attendus

| # | Description |
|---|-------------|
| 1 | INNER JOIN auteurs + livres |
| 2 | LEFT JOIN (auteurs sans livres) |
| 3 | RIGHT JOIN |
| 4 | FULL OUTER JOIN |
| 5 | Table de jonction (livres avec categories) |
| 6 | Self-join preparation |
| 7 | Multi-table JOIN (auteurs + livres + categories) |
| 8 | COUNT livres par auteur (GROUP BY + JOIN) |
| 9 | Auteurs sans livres (LEFT JOIN WHERE NULL) |
| 10 | Comparaison sous-requête vs JOIN |
