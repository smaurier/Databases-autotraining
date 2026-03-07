# Lab 06 — Query Planner Deep Dive

## Objectifs

- Explorer en profondeur le planificateur de requetes PostgreSQL
- Comprendre les differents types de scan (Seq, Index, Bitmap, Index Only)
- Comprendre les strategies de jointure (Nested Loop, Hash Join, Merge Join)
- Analyser les buffers et les temps de planification vs execution

## Pre-requis

- Lab 05 termine (EXPLAIN, index B-tree)
- Bonne comprehension des index

## Schema

```sql
CREATE TABLE customers (id SERIAL, name TEXT, city TEXT);          -- 1000 lignes
CREATE TABLE products  (id SERIAL, name TEXT, price NUMERIC, category TEXT); -- 500 lignes
CREATE TABLE orders    (id SERIAL, customer_id INT, product_id INT,
                        quantity INT, total NUMERIC, order_date DATE,
                        status TEXT);                               -- 50000 lignes
```

## Fichiers

| Fichier | Description |
|---------|-------------|
| `walkthrough.js` | Visite guidee du query planner |
| `exercise.js` | Exercice avec TODOs (8 tests) |
| `solution.js` | Solution complete |

## Instructions

1. Commencez par `node walkthrough.js`
2. Puis completez `exercise.js`
3. Objectif : 8/8 tests

## Tests attendus

| # | Description |
|---|-------------|
| 1 | EXPLAIN → identifier Seq Scan |
| 2 | Ajout d'index → Index Scan |
| 3 | Forcer Bitmap Index Scan (plage large) |
| 4 | EXPLAIN un JOIN → Hash Join |
| 5 | Comparer Nested Loop vs Hash Join |
| 6 | EXPLAIN ANALYZE avec BUFFERS |
| 7 | Index Only Scan avec covering index |
| 8 | Temps de planification vs execution |
