# Lab 11 — Performances

## Objectifs

- Mesurer l'impact des index sur les requetes SELECT
- Comparer INSERT individuel, batch INSERT et COPY
- Exploiter les prepared statements pour les requetes repetees
- Comprendre le bloat et le ramasse-miettes (VACUUM)
- Analyser les statistiques du planificateur (ANALYZE)
- Creer et tester des tables partitionnees

## Schema

```sql
CREATE TABLE big_table (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  value NUMERIC NOT NULL,
  data TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

## Donnees de test

500 000 lignes generees avec `generate_series` et `random()`.

## Tests (10)

1. **SELECT sans index** — Mesurer le temps d'une requete filtrée
2. **Ajout d'index** — Mesurer l'amelioration significative
3. **INSERT individuel vs batch** — Comparer 1000 INSERTs un par un vs un seul multi-valeurs
4. **COPY** — Chargement en masse le plus rapide
5. **Prepared statements** — Comparer requetes preparees vs non preparees
6. **Table bloat** — Observer n_dead_tup apres des UPDATEs
7. **VACUUM** — Nettoyer les tuples morts
8. **VACUUM FULL vs VACUUM** — Comparer les deux approches
9. **ANALYZE** — Mettre a jour les statistiques du planificateur
10. **Partitionnement** — Creer des partitions par date et verifier le partition pruning

## Lancer le lab

```bash
# Exercice (avec TODOs)
node exercise.js

# Solution
node solution.js
```
