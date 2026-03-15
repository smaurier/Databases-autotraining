# Lab 01 — Premiers pas avec PostgreSQL

## Objectifs

- Se connecter a PostgreSQL depuis Node.js
- Créer une table avec différentes contraintes
- Inserer des donnees
- Effectuer des requêtes SELECT simples

## Pre-requis

- PostgreSQL en cours d'exécution sur `localhost:5432`
- Base de donnees `postgres` accessible avec l'utilisateur `postgres`
- Node.js installe avec le module `pg`

## Schema

```sql
CREATE TABLE users (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Instructions

1. Ouvrez le fichier `exercise.js`
2. Completez chaque section marquee `TODO`
3. Lancez le fichier avec `node exercise.js`
4. Verifiez que tous les tests passent (5/5)

## Tests attendus

| # | Description |
|---|-------------|
| 1 | Connexion a PostgreSQL |
| 2 | Création de la table `users` |
| 3 | Insertion de 3 utilisateurs |
| 4 | SELECT de tous les utilisateurs |
| 5 | SELECT avec clause WHERE |

## Aide

- Documentation `pg` : https://node-postgres.com/
- `client.query(sql)` pour exécuter du SQL
- `client.query(sql, [params])` pour les requêtes parametrees
- Le résultat contient `.rows` (tableau) et `.rowCount` (nombre de lignes)
