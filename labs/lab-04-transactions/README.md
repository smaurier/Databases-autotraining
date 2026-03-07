# Lab 04 — Transactions

## Objectifs

- Comprendre le concept de transaction (ACID)
- Utiliser BEGIN, COMMIT, ROLLBACK
- Maitriser les SAVEPOINT pour les rollbacks partiels
- Gerer les transferts bancaires de maniere atomique
- Observer le comportement concurrent de deux clients

## Pre-requis

- Labs 01 a 03 termines
- Comprendre les operations CRUD

## Schema

```sql
CREATE TABLE accounts (
  id      SERIAL PRIMARY KEY,
  owner   TEXT NOT NULL,
  balance NUMERIC(12,2) NOT NULL DEFAULT 0
);
```

## Fichiers

| Fichier | Description |
|---------|-------------|
| `walkthrough.js` | Visite guidee interactive — a executer en premier |
| `exercise.js` | Exercice avec TODOs |
| `solution.js` | Solution complete (6 tests) |

## Instructions

1. Commencez par `node walkthrough.js` pour comprendre les concepts
2. Puis ouvrez `exercise.js` et completez les TODOs
3. Lancez avec `node exercise.js`
4. Objectif : 6/6 tests

## Tests attendus

| # | Description |
|---|-------------|
| 1 | Transfert basique (debit + credit atomique) |
| 2 | Rollback sur fonds insuffisants |
| 3 | SAVEPOINT avec rollback partiel |
| 4 | Transferts concurrents (2 clients) |
| 5 | Recuperation apres erreur (etat avorte) |
| 6 | Lecture du solde dans une transaction |
