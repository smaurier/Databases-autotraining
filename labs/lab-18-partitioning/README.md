# Lab 18 — Partitioning et Scaling PostgreSQL

## Objectifs

Ce lab explore les strategies de partitionnement dans PostgreSQL pour gerer de grands volumes de donnees :

- Partitionnement RANGE (par date)
- Partitionnement LIST (par statut ou categorie)
- Partitionnement HASH (distribution uniforme)
- Partition pruning et verification via EXPLAIN
- Detachement de partitions pour archivage
- Partition par defaut
- Comparaison de performances partitionnee vs non-partitionnee

## Concepts cles

```sql
-- Table partitionnee par RANGE
CREATE TABLE logs (
  id BIGSERIAL, created_at DATE NOT NULL, message TEXT
) PARTITION BY RANGE (created_at);

-- Creer une partition
CREATE TABLE logs_2024_01 PARTITION OF logs
  FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

-- Partition pruning
EXPLAIN SELECT * FROM logs WHERE created_at = '2024-06-15';

-- Detacher une partition
ALTER TABLE logs DETACH PARTITION logs_2024_01;
```

## Tests (10)

1. **RANGE** — Creer une table partitionnee par mois
2. **Partitions mensuelles** — Creer les 12 partitions de 2024
3. **Insertion** — Distribuer des donnees dans les partitions
4. **Partition pruning** — EXPLAIN verifie l'exclusion
5. **LIST** — Partitionner par statut
6. **HASH** — Distribution uniforme
7. **Subplans Removed** — Verifier l'exclusion dans EXPLAIN
8. **DETACH** — Detacher une partition pour archivage
9. **Default** — Partition par defaut pour les donnees hors range
10. **Performance** — Comparer partitionnee vs non-partitionnee sur 500K rows

## Lancer le lab

```bash
# Exercice (avec TODOs)
node exercise.js

# Solution
node solution.js
```
