# Lab 02 — CRUD complet

## Objectifs

- Maitriser les operations CRUD (Create, Read, Update, Delete)
- Utiliser INSERT avec RETURNING
- Effectuer des requetes d'agregation (AVG, GROUP BY)
- Comprendre les requetes parametrees et la protection contre l'injection SQL

## Pre-requis

- Lab 01 termine
- PostgreSQL en cours d'execution

## Schema

```sql
CREATE TABLE products (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  price      NUMERIC(10,2) NOT NULL,
  category   TEXT NOT NULL,
  in_stock   BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Instructions

1. Ouvrez le fichier `exercise.js`
2. Completez chaque section marquee `TODO`
3. Lancez avec `node exercise.js`
4. Verifiez que tous les tests passent (8/8)

## Tests attendus

| # | Description |
|---|-------------|
| 1 | INSERT d'un seul produit |
| 2 | INSERT multiple avec RETURNING |
| 3 | SELECT avec WHERE |
| 4 | SELECT avec agregation (AVG par categorie) |
| 5 | UPDATE avec RETURNING |
| 6 | DELETE avec RETURNING |
| 7 | Requetes parametrees ($1, $2) |
| 8 | Protection contre l'injection SQL |
