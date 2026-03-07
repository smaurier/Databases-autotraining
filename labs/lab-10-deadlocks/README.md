# Lab 10 — Deadlocks

## Objectifs

- Comprendre comment un deadlock se produit
- Detecter et catcher les erreurs de deadlock (code 40P01)
- Prevenir les deadlocks par l'ordonnancement des verrous
- Utiliser NOWAIT et SKIP LOCKED comme alternatives
- Surveiller les deadlocks via pg_stat_database
- Implementer des fonctions de transfert securisees
- Traiter des lots (batch) sans provoquer de deadlocks

## Schema

```sql
CREATE TABLE accounts (
  id SERIAL PRIMARY KEY,
  owner TEXT NOT NULL,
  balance NUMERIC(12,2) NOT NULL
);
```

## Donnees de test

- Compte 1 : Alice — 1000.00
- Compte 2 : Bob — 1000.00

## Tests (8)

1. **Provoquer un deadlock** — Deux clients verrouillent en ordre inverse
2. **Catcher l'erreur 40P01** — Verifier le code et le message
3. **Lock ordering** — Toujours verrouiller par ID croissant
4. **NOWAIT** — Echouer rapidement au lieu de bloquer
5. **SKIP LOCKED** — Traitement de file sans deadlock
6. **pg_stat_database** — Compteur de deadlocks
7. **Transfert securise** — Fonction avec ordonnancement des verrous
8. **Traitement par lots** — UPDATE avec ORDER BY pour eviter les deadlocks

## Lancer le lab

```bash
# Exercice (avec TODOs)
node exercise.js

# Solution
node solution.js
```
