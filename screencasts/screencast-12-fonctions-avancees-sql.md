# Screencast 12 — Fonctions avancées SQL

## Informations
- **Durée estimée** : 20-22 min
- **Module** : `modules/12-fonctions-avancees-sql.md`
- **Lab associé** : `labs/lab-12-window-functions-cte/`
- **Prérequis** : Modules 01-03 (CRUD, jointures) terminés, PostgreSQL running, base `course_db`

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] Terminal ouvert dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] `psql` connecté à `course_db`

## Script

### [00:00-02:00] Introduction

> Les fonctions avancées SQL transforment PostgreSQL en un véritable moteur analytique. Les window functions permettent des calculs sur des "fenêtres" de lignes sans regrouper les données. Les CTEs rendent les requêtes complexes lisibles. Et les CTEs récursives permettent de parcourir des structures hiérarchiques.

**Action** : Créer les tables de démonstration.

```sql
-- Table des ventes pour les window functions
CREATE TABLE sales (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    salesperson VARCHAR(50) NOT NULL,
    region      VARCHAR(30) NOT NULL,
    amount      NUMERIC(10, 2) NOT NULL,
    sale_date   DATE NOT NULL
);

INSERT INTO sales (salesperson, region, amount, sale_date) VALUES
    ('Alice', 'Nord', 1500.00, '2025-01-15'),
    ('Alice', 'Nord', 2200.00, '2025-02-10'),
    ('Alice', 'Nord', 1800.00, '2025-03-22'),
    ('Alice', 'Nord', 3100.00, '2025-04-05'),
    ('Bob', 'Sud', 900.00, '2025-01-20'),
    ('Bob', 'Sud', 1400.00, '2025-02-18'),
    ('Bob', 'Sud', 2100.00, '2025-03-12'),
    ('Bob', 'Sud', 1600.00, '2025-04-28'),
    ('Charlie', 'Nord', 2500.00, '2025-01-08'),
    ('Charlie', 'Nord', 1900.00, '2025-02-25'),
    ('Charlie', 'Nord', 2800.00, '2025-03-30'),
    ('Charlie', 'Nord', 2200.00, '2025-04-15'),
    ('Diana', 'Sud', 1100.00, '2025-01-12'),
    ('Diana', 'Sud', 1700.00, '2025-02-05'),
    ('Diana', 'Sud', 2400.00, '2025-03-18'),
    ('Diana', 'Sud', 1900.00, '2025-04-22');
```

### [02:00-07:00] Window functions — ROW_NUMBER, RANK, LAG/LEAD

> Les window functions calculent une valeur pour chaque ligne en utilisant un ensemble de lignes liées. Contrairement à GROUP BY, elles ne regroupent pas les lignes — chaque ligne reste dans le résultat.

**Action** : Démontrer les window functions progressivement.

```sql
-- ROW_NUMBER : numéroter les lignes dans chaque groupe
SELECT
    salesperson,
    sale_date,
    amount,
    ROW_NUMBER() OVER (PARTITION BY salesperson ORDER BY sale_date) AS sale_num
FROM sales
ORDER BY salesperson, sale_date;

-- RANK et DENSE_RANK : classement
SELECT
    salesperson,
    SUM(amount) AS total_sales,
    RANK() OVER (ORDER BY SUM(amount) DESC) AS rank,
    DENSE_RANK() OVER (ORDER BY SUM(amount) DESC) AS dense_rank
FROM sales
GROUP BY salesperson
ORDER BY total_sales DESC;

-- Classement par région
SELECT
    salesperson,
    region,
    SUM(amount) AS total_sales,
    RANK() OVER (PARTITION BY region ORDER BY SUM(amount) DESC) AS rank_in_region
FROM sales
GROUP BY salesperson, region
ORDER BY region, rank_in_region;
```

> `PARTITION BY` divise les lignes en groupes (comme GROUP BY, mais sans les fusionner). `ORDER BY` définit l'ordre dans chaque partition. Chaque ligne reçoit son propre numéro/rang.

**Action** : Montrer les résultats et pointer comment ROW_NUMBER redémarre à 1 pour chaque vendeur.

```sql
-- LAG et LEAD : accéder aux lignes précédentes/suivantes
SELECT
    salesperson,
    sale_date,
    amount,
    LAG(amount) OVER (PARTITION BY salesperson ORDER BY sale_date) AS prev_amount,
    amount - LAG(amount) OVER (PARTITION BY salesperson ORDER BY sale_date) AS diff,
    LEAD(amount) OVER (PARTITION BY salesperson ORDER BY sale_date) AS next_amount
FROM sales
ORDER BY salesperson, sale_date;
```

> `LAG(amount)` retourne le montant de la vente précédente. La colonne `diff` montre l'évolution d'une vente à l'autre. `LEAD` fait la même chose mais vers l'avant. NULL apparaît quand il n'y a pas de ligne précédente/suivante.

**Action** : Montrer la sortie et pointer les NULL pour la première ligne de chaque vendeur.

### [07:00-10:30] Running totals — Cumuls

> Les window functions permettent aussi de calculer des cumuls : somme cumulée, moyenne mobile, pourcentage du total.

**Action** : Démontrer les calculs cumulatifs.

```sql
-- Somme cumulée par vendeur
SELECT
    salesperson,
    sale_date,
    amount,
    SUM(amount) OVER (
        PARTITION BY salesperson
        ORDER BY sale_date
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS running_total
FROM sales
ORDER BY salesperson, sale_date;

-- Pourcentage du total de la région
SELECT
    salesperson,
    region,
    SUM(amount) AS total,
    SUM(SUM(amount)) OVER (PARTITION BY region) AS region_total,
    ROUND(
        100.0 * SUM(amount) / SUM(SUM(amount)) OVER (PARTITION BY region),
        1
    ) AS pct_of_region
FROM sales
GROUP BY salesperson, region
ORDER BY region, pct_of_region DESC;

-- Moyenne mobile sur 3 périodes
SELECT
    salesperson,
    sale_date,
    amount,
    ROUND(AVG(amount) OVER (
        PARTITION BY salesperson
        ORDER BY sale_date
        ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
    ), 2) AS moving_avg_3
FROM sales
ORDER BY salesperson, sale_date;
```

> La clause `ROWS BETWEEN 2 PRECEDING AND CURRENT ROW` définit la fenêtre : les 2 lignes précédentes plus la ligne courante. C'est une moyenne mobile sur 3 périodes. On peut aussi utiliser `RANGE` au lieu de `ROWS` pour travailler avec des intervalles de valeurs.

**Action** : Montrer la somme cumulée qui augmente progressivement pour chaque vendeur.

### [10:30-14:00] CTEs — Common Table Expressions

> Les CTEs (WITH queries) permettent de décomposer une requête complexe en étapes nommées. C'est plus lisible qu'un empilement de sous-requêtes.

**Action** : Montrer une CTE et la comparer avec une sous-requête.

```sql
-- Sans CTE (sous-requête, difficile à lire)
SELECT * FROM (
    SELECT
        salesperson,
        SUM(amount) AS total_sales,
        RANK() OVER (ORDER BY SUM(amount) DESC) AS rank
    FROM sales
    GROUP BY salesperson
) ranked
WHERE rank <= 3;

-- Avec CTE (même résultat, beaucoup plus lisible)
WITH ranked_sales AS (
    SELECT
        salesperson,
        SUM(amount) AS total_sales,
        RANK() OVER (ORDER BY SUM(amount) DESC) AS rank
    FROM sales
    GROUP BY salesperson
)
SELECT salesperson, total_sales, rank
FROM ranked_sales
WHERE rank <= 3;

-- CTEs chaînées : résultat de l'une utilisé par l'autre
WITH monthly_totals AS (
    SELECT
        salesperson,
        DATE_TRUNC('month', sale_date)::date AS month,
        SUM(amount) AS monthly_total
    FROM sales
    GROUP BY salesperson, DATE_TRUNC('month', sale_date)
),
with_growth AS (
    SELECT
        salesperson,
        month,
        monthly_total,
        LAG(monthly_total) OVER (PARTITION BY salesperson ORDER BY month) AS prev_month,
        ROUND(
            100.0 * (monthly_total - LAG(monthly_total) OVER (PARTITION BY salesperson ORDER BY month))
            / NULLIF(LAG(monthly_total) OVER (PARTITION BY salesperson ORDER BY month), 0),
            1
        ) AS growth_pct
    FROM monthly_totals
)
SELECT * FROM with_growth
ORDER BY salesperson, month;
```

> On décompose en trois étapes : d'abord les totaux mensuels, puis la croissance. Chaque CTE est une "table temporaire" lisible. Le résultat final combine le tout.

**Action** : Montrer les deux CTE et le résultat avec les pourcentages de croissance.

### [14:00-17:30] Recursive CTE — Organigramme

> Les CTEs récursives permettent de parcourir des structures hiérarchiques : organigrammes, catégories, arborescences.

**Action** : Créer et parcourir un organigramme.

```sql
-- Table d'employés avec hiérarchie
CREATE TABLE employees (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(50) NOT NULL,
    title       VARCHAR(100) NOT NULL,
    manager_id  INTEGER REFERENCES employees(id)
);

INSERT INTO employees (name, title, manager_id) VALUES
    ('Marie', 'CEO', NULL),           -- id 1, pas de manager
    ('Pierre', 'CTO', 1),             -- id 2, rapporte à Marie
    ('Sophie', 'CFO', 1),             -- id 3, rapporte à Marie
    ('Lucas', 'Tech Lead', 2),        -- id 4, rapporte à Pierre
    ('Emma', 'Dev Senior', 4),        -- id 5, rapporte à Lucas
    ('Hugo', 'Dev Junior', 4),        -- id 6, rapporte à Lucas
    ('Léa', 'Comptable', 3),          -- id 7, rapporte à Sophie
    ('Paul', 'Dev Senior', 2);        -- id 8, rapporte à Pierre

-- CTE récursive : parcourir l'organigramme
WITH RECURSIVE org_chart AS (
    -- Cas de base : le CEO (pas de manager)
    SELECT
        id, name, title, manager_id,
        0 AS depth,
        name::text AS path
    FROM employees
    WHERE manager_id IS NULL

    UNION ALL

    -- Cas récursif : les subordonnés
    SELECT
        e.id, e.name, e.title, e.manager_id,
        oc.depth + 1,
        oc.path || ' > ' || e.name
    FROM employees e
    JOIN org_chart oc ON e.manager_id = oc.id
)
SELECT
    REPEAT('  ', depth) || name AS org_name,
    title,
    depth,
    path
FROM org_chart
ORDER BY path;
```

> La CTE récursive a deux parties : le cas de base (SELECT initial) et le cas récursif (après UNION ALL). PostgreSQL exécute le cas de base, puis itère le cas récursif jusqu'à ce qu'il ne produise plus de nouvelles lignes.

**Action** : Montrer la sortie en forme d'arbre avec l'indentation. Pointer le `depth` et le `path`.

```sql
-- Trouver tous les subordonnés de Pierre
WITH RECURSIVE subordinates AS (
    SELECT id, name, title FROM employees WHERE name = 'Pierre'
    UNION ALL
    SELECT e.id, e.name, e.title
    FROM employees e
    JOIN subordinates s ON e.manager_id = s.id
)
SELECT * FROM subordinates;
-- Pierre, Lucas, Emma, Hugo, Paul
```

**Action** : Montrer que la requête descend dans la hiérarchie à partir de Pierre.

### [17:30-19:30] LATERAL JOIN

> LATERAL permet à une sous-requête de référencer les colonnes des tables qui la précèdent dans le FROM. C'est comme une boucle for-each en SQL.

**Action** : Démontrer LATERAL.

```sql
-- Pour chaque vendeur, trouver ses 2 meilleures ventes
SELECT
    s.salesperson,
    top.sale_date,
    top.amount
FROM (SELECT DISTINCT salesperson FROM sales) s
CROSS JOIN LATERAL (
    SELECT sale_date, amount
    FROM sales
    WHERE sales.salesperson = s.salesperson
    ORDER BY amount DESC
    LIMIT 2
) top
ORDER BY s.salesperson, top.amount DESC;

-- Sans LATERAL, il faudrait une window function avec filtre
-- LATERAL est plus lisible pour ce type de requête "top-N par groupe"
```

> LATERAL est particulièrement utile pour le pattern "top-N par groupe" : pour chaque catégorie, les 3 meilleurs produits. Pour chaque client, les 5 dernières commandes. C'est plus intuitif qu'une window function avec filtre.

**Action** : Montrer les 2 meilleures ventes par vendeur dans la sortie.

### [19:30-20:30] Démo Lab-12

> Le lab 12 vous fait pratiquer toutes ces fonctions sur des données de ventes et un organigramme.

**Action** : Ouvrir `labs/lab-12-window-functions-cte/` et parcourir les exercices.

```sql
-- Aperçu lab-12
-- Exercice 1 : Classement des vendeurs avec RANK
-- Exercice 2 : Évolution mois par mois avec LAG
-- Exercice 3 : Cumuls et moyennes mobiles
-- Exercice 4 : CTE récursive sur un organigramme
-- Exercice 5 : Top-N par groupe avec LATERAL
```

**Action** : Montrer les fichiers du lab et les résultats attendus.

### [20:30-21:30] Conclusion

> Les window functions, les CTEs et LATERAL transforment PostgreSQL en un outil analytique puissant. On a vu ROW_NUMBER, RANK, LAG/LEAD, les cumuls, les CTEs chaînées, les CTEs récursives pour les hiérarchies, et LATERAL pour le top-N par groupe. Dans le prochain module, on attaque le JSONB et la recherche full-text.

**Action** : Nettoyage.

```sql
DROP TABLE IF EXISTS sales, employees;
```

## Points d'attention pour l'enregistrement
- Les window functions sont un sujet complexe — aller progressivement
- Bien montrer les résultats avec `\x` si les colonnes sont trop nombreuses
- L'organigramme doit s'afficher en forme d'arbre (l'indentation est visuelle)
- Prendre le temps de montrer le PARTITION BY et l'ORDER BY de chaque window function
- Préparer les données de manière à ce que les résultats soient clairs et parlants
- Tester toutes les requêtes avant l'enregistrement — les window functions sont faciles à mal écrire
