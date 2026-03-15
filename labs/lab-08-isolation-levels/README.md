# Lab 08 — Niveaux d'isolation

## Objectifs

- Comprendre les trois niveaux d'isolation de PostgreSQL (Read Committed, Repeatable Read, Serializable)
- Observer les phenomenes de concurrence (non-repeatable read, phantom read)
- Comprendre MVCC (Multi-Version Concurrency Control)
- Gérer les erreurs de serialisation avec une logique de retry

## Pre-requis

- Lab 04 (Transactions) termine
- Bonne comprehension de BEGIN, COMMIT, ROLLBACK

## Schema

```sql
CREATE TABLE counters (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  value INTEGER NOT NULL DEFAULT 0
);
```

## Niveaux d'isolation PostgreSQL

| Niveau | Dirty Read | Non-repeatable Read | Phantom Read | Serialization Anomaly |
|--------|-----------|--------------------|--------------|-----------------------|
| Read Committed | Impossible | Possible | Possible | Possible |
| Repeatable Read | Impossible | Impossible | Impossible* | Possible |
| Serializable | Impossible | Impossible | Impossible | Impossible |

*PostgreSQL previent aussi les phantom reads en Repeatable Read

## Instructions

1. Ouvrez `exercise.js`
2. Completez les 8 TODOs
3. Lancez avec `node exercise.js`
4. Objectif : 8/8

## Tests attendus

| # | Description |
|---|-------------|
| 1 | Read Committed : non-repeatable read |
| 2 | Read Committed : pas de dirty read |
| 3 | Repeatable Read : snapshot fixe |
| 4 | Repeatable Read : erreur de serialisation |
| 5 | Serializable : detection d'anomalie (write skew) |
| 6 | Observation MVCC avec xmin/xmax |
| 7 | Phantom reads : Read Committed vs Repeatable Read |
| 8 | Logique de retry pour les erreurs de serialisation |
