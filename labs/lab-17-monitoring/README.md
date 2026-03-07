# Lab 17 — Monitoring et Observabilite PostgreSQL

## Objectifs

Ce lab explore les outils de monitoring integres a PostgreSQL pour diagnostiquer les problemes de performance et surveiller la sante de la base de donnees :

- pg_stat_activity — sessions actives et requetes en cours
- pg_stat_statements — statistiques d'execution des requetes
- pg_stat_user_tables — scans sequentiels vs index scans
- pg_stat_user_indexes — detection des index inutilises
- pg_stat_database — cache hit ratio
- pg_stat_bgwriter — statistiques de checkpoints
- Detection des requetes longues et des sessions bloquantes
- Monitoring des dead tuples et VACUUM
- Construction d'une fonction de health check

## Concepts cles

```sql
-- Sessions actives
SELECT pid, state, query FROM pg_stat_activity;

-- Cache hit ratio
SELECT blks_hit::float / (blks_hit + blks_read) * 100 AS ratio
FROM pg_stat_database WHERE datname = current_database();

-- Dead tuples
SELECT relname, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables;

-- Sessions bloquantes
SELECT pg_blocking_pids(pid) FROM pg_stat_activity;
```

## Tests (10)

1. **pg_stat_activity** — Trouver les sessions actives
2. **pg_stat_statements** — Activer et interroger les top SQL
3. **pg_stat_user_tables** — Ratio seq_scan vs idx_scan
4. **pg_stat_user_indexes** — Trouver les index inutilises
5. **pg_stat_database** — Calculer le cache hit ratio
6. **pg_stat_bgwriter** — Statistiques de checkpoints
7. **Requetes longues** — Identifier les requetes > 1 seconde
8. **Sessions bloquantes** — Identifier avec pg_blocking_pids()
9. **Dead tuples** — Creer, monitorer, VACUUM, re-verifier
10. **Health check** — Fonction JSON avec toutes les metriques

## Lancer le lab

```bash
# Exercice (avec TODOs)
node exercise.js

# Solution
node solution.js
```
