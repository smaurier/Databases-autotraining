# Lab 09 — Locks en action

## Objectifs

- Comprendre le verrouillage de lignes avec `SELECT ... FOR UPDATE`
- Observer le blocage entre clients concurrents
- Utiliser `NOWAIT` et `SKIP LOCKED` pour gerer les conflits
- Explorer les verrous dans `pg_locks` et `pg_stat_activity`
- Decouvrir `FOR SHARE` pour les lectures partagees
- Mettre en oeuvre les advisory locks pour le verrouillage applicatif
- Implementer une fonction de reservation avec verrouillage

## Schema

```sql
CREATE TABLE seats (
  id SERIAL PRIMARY KEY,
  row_letter CHAR(1) NOT NULL,
  seat_number INT NOT NULL,
  event_id INT NOT NULL,
  status TEXT DEFAULT 'available',
  reserved_by TEXT
);
```

## Donnees de test

100 places pour `event_id = 1` (rangees A-J, places 1-10).

## Tests (8)

1. **FOR UPDATE** — Verrouiller une place et verifier le verrouillage
2. **Blocage entre clients** — Client 1 verrouille, Client 2 est bloque
3. **FOR UPDATE NOWAIT** — Erreur immediate si la place est deja verrouillee
4. **SKIP LOCKED** — Sauter les places verrouillees et obtenir la suivante
5. **Observer pg_locks** — Requeter pg_locks avec pg_stat_activity
6. **FOR SHARE** — Lectures partagees autorisees, ecriture bloquee
7. **Advisory locks** — Verrou applicatif au niveau evenement
8. **Fonction de reservation** — FOR UPDATE + mise a jour du statut

## Lancer le lab

```bash
# Exercice (avec TODOs)
node exercise.js

# Solution
node solution.js
```
