# PostgreSQL & Databases — Maîtriser les bases de données relationnelles

Formation complète sur PostgreSQL et les bases de données relationnelles : du modèle relationnel aux techniques avancées (débutant -> expert).

**Ce cours couvre tout le spectre** : le modèle relationnel, le SQL, les transactions ACID, les index (B-tree, GIN, GiST, BRIN), le query planner, MVCC, les niveaux d'isolation, les verrous, les deadlocks, les performances, les window functions, JSONB, le full-text search, la sécurité et l'administration.

## Prérequis

- JavaScript courant (ES2020+, async/await, Promises)
- Notions de base en développement web
- Node.js 20+ installé
- PostgreSQL 16 via Docker (ou installation locale)

## Structure

```
modules/     → 16 cours théoriques (Markdown)
labs/        → 15 labs pratiques exécutables (Node.js + pg)
quizzes/     → 16 quizzes interactifs (HTML)
visualizations/ → 5 visualisations animées (HTML)
screencasts/ → 16 scripts de screencast (Markdown)
```

## Programme

| # | Module | Lab | Thème |
|---|--------|-----|-------|
| 00 | Prérequis & Vue d'ensemble | — | Introduction |
| 01 | Le modèle relationnel | Premiers pas psql | Fondamentaux |
| 02 | CRUD & Requêtes SQL | CRUD complet | Fondamentaux |
| 03 | Relations & Jointures | Jointures en pratique | Fondamentaux |
| 04 | Transactions & ACID | Transactions | Transactions |
| 05 | Index : les fondamentaux | Index et EXPLAIN | Index |
| 06 | Le Query Planner | Query Planner deep dive | Index |
| 07 | Index avancés (GIN, GiST, BRIN) | Index GIN/GiST/BRIN | Index |
| 08 | Niveaux d'isolation & MVCC | Isolation levels | Concurrence |
| 09 | Verrous & Locks | Locks en action | Concurrence |
| 10 | Deadlocks | Deadlocks | Concurrence |
| 11 | Performances & Optimisation | Performances | Performances |
| 12 | Fonctions avancées SQL | Window functions & CTE | SQL avancé |
| 13 | JSONB & Types avancés | JSONB & Full-text | SQL avancé |
| 14 | Sécurité & Administration | Sécurité & RLS | Administration |
| 15 | Projet final | Système de réservation | Synthèse |

## Exécution des labs

```bash
# Démarrer PostgreSQL via Docker
docker run --name pg-course -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16

# Installer les dépendances
npm install

# Exécuter un lab
node labs/lab-01-premiers-pas-psql/exercise.js

# Comparer avec la solution
node labs/lab-01-premiers-pas-psql/solution.js

# Lab progressif (Index en 3 étapes)
node labs/lab-05-index-et-explain/exercise-step1.js
node labs/lab-05-index-et-explain/exercise-step2.js
node labs/lab-05-index-et-explain/exercise-step3.js
```

## Durée estimée

~50h (16 modules : 1 module d'introduction + 15 modules x ~3h : lecture + lab + défi)

## Objectifs de sortie

À la fin de ce cursus, tu es capable de :
- Concevoir un schéma relationnel normalisé avec les bonnes contraintes
- Écrire des requêtes SQL complexes (jointures, sous-requêtes, CTE, window functions)
- Comprendre et utiliser les transactions avec le bon niveau d'isolation
- Choisir le bon type d'index (B-tree, GIN, GiST, BRIN, partiel, expression)
- Lire et interpréter un plan d'exécution (EXPLAIN ANALYZE)
- Comprendre le fonctionnement interne de PostgreSQL (MVCC, WAL, VACUUM)
- Diagnostiquer et résoudre les problèmes de locks et deadlocks
- Optimiser les performances d'une base PostgreSQL en production
- Utiliser les fonctionnalités avancées (JSONB, full-text search, RLS)
- Sécuriser et administrer une base PostgreSQL

## Niveau

**Débutant -> Expert.** Ce cours part des bases du modèle relationnel et progresse jusqu'aux techniques avancées d'optimisation et d'administration PostgreSQL.
