# Lab 12 — Window Functions & CTEs

## Objectifs

- Maîtriser les fonctions de fenêtre (ROW_NUMBER, RANK, DENSE_RANK, LAG, LEAD)
- Calculer des totaux cumulatifs avec SUM OVER
- Écrire des CTEs (Common Table Expressions) pour simplifier les requêtes
- Utiliser les CTEs recursives pour les hierarchies (organigramme)
- Exploiter LATERAL JOIN pour les top-N par groupe
- Decouvrir GROUPING SETS pour les statistiques multi-dimensions

## Schema

```sql
CREATE TABLE employees (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  department TEXT NOT NULL,
  salary NUMERIC NOT NULL,
  hire_date DATE NOT NULL,
  manager_id INT REFERENCES employees(id)
);
```

## Donnees de test

50 employes repartis dans 5 departements avec une hiérarchie manager/employe.

## Tests (10)

1. **ROW_NUMBER** — Pagination (page 2, 10 par page)
2. **RANK** — Classement des salaires par departement
3. **DENSE_RANK** — Gestion des ex aequo
4. **LAG/LEAD** — Comparer le salaire avec le précédent/suivant
5. **Running total** — Total cumulatif des salaires par date
6. **CTE** — Reecrire une sous-requête en CTE
7. **CTE recursive** — Organigramme (tous les rapports d'un manager)
8. **CTE recursive** — Calculer le niveau hiérarchique
9. **LATERAL JOIN** — Top 3 des salaires par departement
10. **GROUPING SETS** — Statistiques par departement et annee

## Lancer le lab

```bash
# Exercice (avec TODOs)
node exercise.js

# Solution
node solution.js
```
