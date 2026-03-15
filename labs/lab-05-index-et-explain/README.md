# Lab 05 — Index & EXPLAIN

## Objectifs

- Comprendre EXPLAIN et EXPLAIN ANALYZE
- Observer la différence entre Seq Scan et Index Scan
- Créer des index B-tree (simples, composites, uniques)
- Decouvrir les index d'expression et partiels
- Mesurer l'impact des index sur les performances

## Pre-requis

- Labs 01 a 04 termines
- Comprendre les bases de SELECT et WHERE

## Schema

```sql
CREATE TABLE employees (
  id        SERIAL PRIMARY KEY,
  name      TEXT NOT NULL,
  department TEXT NOT NULL,
  salary    NUMERIC(10,2) NOT NULL,
  hire_date DATE NOT NULL,
  email     TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true
);
-- 10 000 employes generes avec generate_series
```

## Fichiers — Approche progressive

| Fichier | Tests | Description |
|---------|-------|-------------|
| `exercise-step1.js` | 5 | EXPLAIN basique |
| `exercise-step2.js` | 8 | + Index B-tree |
| `exercise-step3.js` | 12 | + Index avances |
| `exercise.js` | 12 | Version complete (= step3) |
| `solution.js` | 12 | Solution complete |

## Progression

### Étape 1 : EXPLAIN basique (5 tests)
1. EXPLAIN simple → observer le plan
2. Vérifier qu'un Seq Scan est utilise (pas d'index)
3. EXPLAIN ANALYZE pour les temps réels
4. Extraire le cout du plan
5. Comparer lignes estimees vs reelles

### Étape 2 : Index B-tree (3 tests supplementaires)
6. Index B-tree sur department → Index Scan
7. Index composite (department, salary) → utilisation
8. Index UNIQUE sur email → contrainte + index

### Étape 3 : Index avances (4 tests supplementaires)
9. Index d'expression LOWER(email) → recherche insensible à la casse
10. Index partiel WHERE is_active = true → requête filtree
11. Comparaison temps Seq Scan vs Index Scan
12. Statistiques d'utilisation des index (pg_stat_user_indexes)

## Instructions

1. Commencez par `node exercise-step1.js` (5 tests)
2. Puis `node exercise-step2.js` (8 tests)
3. Puis `node exercise-step3.js` ou `node exercise.js` (12 tests)
4. Objectif final : 12/12
