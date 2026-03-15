# Lab 16 — Replication PostgreSQL

## Objectifs

Ce lab explore les concepts fondamentaux de la replication PostgreSQL. Comme la replication nécessité plusieurs instances PostgreSQL, les exercices simulent et verifient les concepts clés sur une instance unique :

- Configuration WAL (Write-Ahead Log)
- Publications et souscriptions (replication logique)
- Slots de replication logique et decodage
- Monitoring de la replication via pg_stat_replication
- Statistiques WAL avec pg_stat_wal
- Routage lecture/écriture avec clients multiples
- Vérification pg_basebackup

## Concepts clés

```sql
-- Verifier le niveau WAL
SHOW wal_level;

-- Creer une publication (replication logique)
CREATE PUBLICATION my_pub FOR TABLE my_table;

-- Creer un slot de replication logique
SELECT pg_create_logical_replication_slot('test_slot', 'test_decoding');

-- Lire les changements depuis le slot
SELECT * FROM pg_logical_slot_get_changes('test_slot', NULL, NULL);

-- Monitoring replication
SELECT * FROM pg_stat_replication;

-- Statistiques WAL
SELECT * FROM pg_stat_wal;
```

## Tests (8)

1. **WAL level** — Vérifier le paramètre wal_level
2. **Publication** — Créer une publication pour replication logique
3. **pg_stat_replication** — Vérifier la structure de la vue
4. **Decodage logique** — Créer un slot et lire les changements
5. **Replication lag** — Requête de monitoring du retard
6. **Statistiques WAL** — Consulter pg_stat_wal
7. **Routage lecture/écriture** — Simuler avec deux clients
8. **pg_basebackup** — Vérification dry-run

## Lancer le lab

```bash
# Exercice (avec TODOs)
node exercise.js

# Solution
node solution.js
```
