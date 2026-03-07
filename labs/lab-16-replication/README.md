# Lab 16 — Replication PostgreSQL

## Objectifs

Ce lab explore les concepts fondamentaux de la replication PostgreSQL. Comme la replication necessite plusieurs instances PostgreSQL, les exercices simulent et verifient les concepts cles sur une instance unique :

- Configuration WAL (Write-Ahead Log)
- Publications et souscriptions (replication logique)
- Slots de replication logique et decodage
- Monitoring de la replication via pg_stat_replication
- Statistiques WAL avec pg_stat_wal
- Routage lecture/ecriture avec clients multiples
- Verification pg_basebackup

## Concepts cles

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

1. **WAL level** — Verifier le parametre wal_level
2. **Publication** — Creer une publication pour replication logique
3. **pg_stat_replication** — Verifier la structure de la vue
4. **Decodage logique** — Creer un slot et lire les changements
5. **Replication lag** — Requete de monitoring du retard
6. **Statistiques WAL** — Consulter pg_stat_wal
7. **Routage lecture/ecriture** — Simuler avec deux clients
8. **pg_basebackup** — Verification dry-run

## Lancer le lab

```bash
# Exercice (avec TODOs)
node exercise.js

# Solution
node solution.js
```
