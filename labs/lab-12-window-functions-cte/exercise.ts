// =============================================================================
// Lab 12 — Window Functions & CTEs (Exercice)
// =============================================================================

import pg from 'pg';
import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.ts';

const { test, assert, assertEqual, assertIncludes, assertGreaterThan, assertLessThan, summary } = createTestRunner('Lab 12 — Window Functions & CTEs');

// ---------------------------------------------------------------------------
// Schema et donnees de test
// ---------------------------------------------------------------------------
const SCHEMA_SQL = `
  DROP TABLE IF EXISTS employees CASCADE;

  CREATE TABLE employees (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    salary NUMERIC NOT NULL,
    hire_date DATE NOT NULL,
    manager_id INT REFERENCES employees(id)
  );
`;

// 50 employes dans 5 departements avec hierarchie
const SEED_SQL = `
  -- Directeurs (pas de manager)
  INSERT INTO employees (id, name, department, salary, hire_date, manager_id) VALUES
    (1, 'Marie Dupont', 'Direction', 95000, '2018-01-15', NULL),
    (2, 'Jean Martin', 'Ingenierie', 85000, '2018-03-01', 1),
    (3, 'Sophie Bernard', 'Marketing', 80000, '2018-06-10', 1),
    (4, 'Pierre Durand', 'Finance', 82000, '2018-04-20', 1),
    (5, 'Isabelle Leroy', 'RH', 78000, '2018-07-05', 1);

  -- Managers intermediaires
  INSERT INTO employees (id, name, department, salary, hire_date, manager_id) VALUES
    (6, 'Luc Moreau', 'Ingenierie', 72000, '2019-02-01', 2),
    (7, 'Anne Petit', 'Ingenierie', 70000, '2019-05-15', 2),
    (8, 'Marc Roux', 'Marketing', 68000, '2019-03-20', 3),
    (9, 'Claire Simon', 'Finance', 67000, '2019-06-01', 4),
    (10, 'Paul Laurent', 'RH', 65000, '2019-04-10', 5);

  -- Employes niveau 3
  INSERT INTO employees (id, name, department, salary, hire_date, manager_id) VALUES
    (11, 'Thomas Faure', 'Ingenierie', 58000, '2020-01-10', 6),
    (12, 'Julie Garnier', 'Ingenierie', 58000, '2020-02-15', 6),
    (13, 'Nicolas Chevalier', 'Ingenierie', 56000, '2020-03-20', 7),
    (14, 'Emma Blanc', 'Ingenierie', 57000, '2020-04-01', 7),
    (15, 'Hugo Guerin', 'Marketing', 52000, '2020-01-20', 8),
    (16, 'Lea Fournier', 'Marketing', 53000, '2020-05-10', 8),
    (17, 'Antoine Morel', 'Finance', 55000, '2020-02-28', 9),
    (18, 'Camille Girard', 'Finance', 54000, '2020-06-15', 9),
    (19, 'Maxime Andre', 'RH', 50000, '2020-03-01', 10),
    (20, 'Laura Mercier', 'RH', 51000, '2020-07-20', 10);

  -- Employes niveau 4 et plus
  INSERT INTO employees (id, name, department, salary, hire_date, manager_id) VALUES
    (21, 'Romain Dufour', 'Ingenierie', 48000, '2021-01-05', 11),
    (22, 'Manon Bonnet', 'Ingenierie', 47000, '2021-02-10', 11),
    (23, 'Kevin Dupuis', 'Ingenierie', 49000, '2021-03-15', 12),
    (24, 'Sarah Lambert', 'Ingenierie', 46000, '2021-04-20', 13),
    (25, 'Florian Fontaine', 'Ingenierie', 50000, '2021-05-01', 14),
    (26, 'Oceane Rousseau', 'Marketing', 44000, '2021-01-15', 15),
    (27, 'Dylan Vincent', 'Marketing', 45000, '2021-06-10', 15),
    (28, 'Chloe Muller', 'Marketing', 43000, '2021-02-20', 16),
    (29, 'Axel Lefevre', 'Finance', 47000, '2021-03-01', 17),
    (30, 'Ines Fabre', 'Finance', 46000, '2021-07-15', 17),
    (31, 'Lucas Robin', 'Finance', 45000, '2021-04-10', 18),
    (32, 'Jade Clement', 'RH', 42000, '2021-05-20', 19),
    (33, 'Nathan Morin', 'RH', 43000, '2021-08-01', 19),
    (34, 'Eva Gauthier', 'RH', 41000, '2021-06-15', 20),
    (35, 'Tom Henry', 'Ingenierie', 52000, '2022-01-10', 6),
    (36, 'Lina Perrin', 'Ingenierie', 51000, '2022-02-15', 7),
    (37, 'Gabriel Renaud', 'Marketing', 48000, '2022-03-20', 8),
    (38, 'Alice Picard', 'Finance', 49000, '2022-04-01', 9),
    (39, 'Raphael David', 'RH', 46000, '2022-05-10', 10),
    (40, 'Louise Bertrand', 'Ingenierie', 53000, '2022-06-01', 6),
    (41, 'Arthur Masson', 'Marketing', 47000, '2022-07-15', 3),
    (42, 'Zoe Sanchez', 'Finance', 48000, '2022-08-20', 4),
    (43, 'Victor Nguyen', 'RH', 44000, '2022-09-01', 5),
    (44, 'Elsa Michel', 'Ingenierie', 55000, '2023-01-10', 2),
    (45, 'Oscar Lemaire', 'Marketing', 46000, '2023-02-15', 3),
    (46, 'Mila Garcia', 'Finance', 50000, '2023-03-20', 4),
    (47, 'Adam Lefebvre', 'RH', 45000, '2023-04-01', 5),
    (48, 'Rose Dubois', 'Ingenierie', 54000, '2023-05-10', 2),
    (49, 'Louis Martinez', 'Marketing', 49000, '2023-06-15', 3),
    (50, 'Clara Legrand', 'Finance', 51000, '2023-07-20', 4);

  SELECT setval('employees_id_seq', 50);
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function run(): Promise<void> {
  const client = await createClient();

  try {
    await setupDatabase(client, SCHEMA_SQL);
    await setupDatabase(client, SEED_SQL);
    console.log('\n📊 Lab 12 — Window Functions & CTEs\n');

    // -----------------------------------------------------------------------
    // Test 1 : ROW_NUMBER pour la pagination
    // -----------------------------------------------------------------------
    await test('ROW_NUMBER — pagination (page 2, 10 par page)', async () => {
      // TODO:
      // 1. Ecrire une requete avec ROW_NUMBER() OVER (ORDER BY name) AS rn
      // 2. Filtrer pour obtenir la page 2 (lignes 11 a 20)
      //    WITH numbered AS (
      //      SELECT *, ROW_NUMBER() OVER (ORDER BY name) AS rn FROM employees
      //    )
      //    SELECT * FROM numbered WHERE rn BETWEEN 11 AND 20
      // 3. Verifier qu'on obtient exactement 10 resultats
      // 4. Verifier que le premier resultat a rn = 11
    });

    // -----------------------------------------------------------------------
    // Test 2 : RANK — classement par salaire dans chaque departement
    // -----------------------------------------------------------------------
    await test('RANK — classement des salaires par departement', async () => {
      // TODO:
      // 1. SELECT name, department, salary,
      //    RANK() OVER (PARTITION BY department ORDER BY salary DESC) AS rank
      //    FROM employees
      // 2. Filtrer rank = 1 pour obtenir le plus haut salaire par departement
      // 3. Verifier qu'on a 5 resultats (un par departement)
    });

    // -----------------------------------------------------------------------
    // Test 3 : DENSE_RANK — gestion des ex aequo
    // -----------------------------------------------------------------------
    await test('DENSE_RANK — gestion des ex aequo', async () => {
      // TODO:
      // 1. Utiliser DENSE_RANK() OVER (PARTITION BY department ORDER BY salary DESC)
      //    sur le departement 'Ingenierie'
      // 2. Verifier que les employes avec le meme salaire ont le meme rang
      // 3. Verifier que le rang suivant n'a pas de trou
      //    (ex: si 2 employes au rang 1, le suivant est rang 2, pas rang 3)
    });

    // -----------------------------------------------------------------------
    // Test 4 : LAG/LEAD — comparer avec precedent/suivant
    // -----------------------------------------------------------------------
    await test('LAG/LEAD — comparer salaire avec precedent et suivant', async () => {
      // TODO:
      // 1. SELECT name, department, salary,
      //    LAG(salary) OVER (PARTITION BY department ORDER BY salary) AS prev_salary,
      //    LEAD(salary) OVER (PARTITION BY department ORDER BY salary) AS next_salary
      //    FROM employees WHERE department = 'Ingenierie'
      // 2. Verifier que le premier employe a prev_salary = NULL
      // 3. Verifier que le dernier employe a next_salary = NULL
      // 4. Pour un employe au milieu, verifier prev_salary < salary < next_salary
    });

    // -----------------------------------------------------------------------
    // Test 5 : Running total (total cumulatif)
    // -----------------------------------------------------------------------
    await test('Running total — SUM(salary) OVER (ORDER BY hire_date)', async () => {
      // TODO:
      // 1. SELECT name, hire_date, salary,
      //    SUM(salary) OVER (ORDER BY hire_date) AS cumul
      //    FROM employees ORDER BY hire_date
      // 2. Verifier que le premier cumul = le salaire du premier employe
      // 3. Verifier que le dernier cumul = la somme totale des salaires
      // 4. Verifier que le cumul est croissant
    });

    // -----------------------------------------------------------------------
    // Test 6 : CTE — reecrire une sous-requete
    // -----------------------------------------------------------------------
    await test('CTE — reecrire une sous-requete complexe', async () => {
      // TODO:
      // 1. Ecrire une CTE qui calcule le salaire moyen par departement
      //    WITH dept_avg AS (
      //      SELECT department, AVG(salary) AS avg_salary
      //      FROM employees GROUP BY department
      //    )
      // 2. Joindre avec employees pour trouver les employes au-dessus de la moyenne
      //    SELECT e.name, e.department, e.salary, d.avg_salary
      //    FROM employees e JOIN dept_avg d ON e.department = d.department
      //    WHERE e.salary > d.avg_salary
      // 3. Verifier qu'on obtient des resultats
      // 4. Verifier que chaque salaire est bien > avg_salary de son departement
    });

    // -----------------------------------------------------------------------
    // Test 7 : CTE recursive — organigramme
    // -----------------------------------------------------------------------
    await test('CTE recursive — tous les rapports d\'un manager', async () => {
      // TODO:
      // 1. Ecrire une CTE recursive pour trouver tous les rapports de Marie Dupont (id=1)
      //    WITH RECURSIVE org AS (
      //      SELECT id, name, manager_id FROM employees WHERE manager_id = 1
      //      UNION ALL
      //      SELECT e.id, e.name, e.manager_id
      //      FROM employees e JOIN org o ON e.manager_id = o.id
      //    )
      //    SELECT * FROM org
      // 2. Verifier que le resultat contient plus de 40 employes (toute l'entreprise sous Marie)
      // 3. Verifier que Marie (id=1) n'est PAS dans les resultats (elle est la racine)
    });

    // -----------------------------------------------------------------------
    // Test 8 : CTE recursive — niveau hierarchique
    // -----------------------------------------------------------------------
    await test('CTE recursive — calculer le niveau hierarchique', async () => {
      // TODO:
      // 1. CTE recursive avec un compteur de profondeur :
      //    WITH RECURSIVE hierarchy AS (
      //      SELECT id, name, manager_id, 0 AS depth FROM employees WHERE manager_id IS NULL
      //      UNION ALL
      //      SELECT e.id, e.name, e.manager_id, h.depth + 1
      //      FROM employees e JOIN hierarchy h ON e.manager_id = h.id
      //    )
      //    SELECT * FROM hierarchy ORDER BY depth, name
      // 2. Verifier que Marie (id=1) a depth = 0
      // 3. Verifier que les directeurs de departement ont depth = 1
      // 4. Verifier que le max depth est >= 3
    });

    // -----------------------------------------------------------------------
    // Test 9 : LATERAL JOIN — top 3 par departement
    // -----------------------------------------------------------------------
    await test('LATERAL JOIN — top 3 salaires par departement', async () => {
      // TODO:
      // 1. SELECT DISTINCT department FROM employees → liste des departements
      // 2. LATERAL JOIN pour obtenir les 3 plus gros salaires par departement :
      //    SELECT d.department, t.name, t.salary
      //    FROM (SELECT DISTINCT department FROM employees) d,
      //    LATERAL (
      //      SELECT name, salary FROM employees
      //      WHERE department = d.department
      //      ORDER BY salary DESC LIMIT 3
      //    ) t
      // 3. Verifier qu'on a 15 resultats (3 par departement x 5 departements)
      // 4. Verifier le tri par salaire decroissant dans chaque departement
    });

    // -----------------------------------------------------------------------
    // Test 10 : GROUPING SETS
    // -----------------------------------------------------------------------
    await test('GROUPING SETS — stats par departement et annee', async () => {
      // TODO:
      // 1. SELECT department, EXTRACT(YEAR FROM hire_date) AS hire_year,
      //    COUNT(*) AS nb, AVG(salary)::numeric(10,2) AS avg_salary
      //    FROM employees
      //    GROUP BY GROUPING SETS (
      //      (department),
      //      (EXTRACT(YEAR FROM hire_date)),
      //      (department, EXTRACT(YEAR FROM hire_date))
      //    )
      //    ORDER BY department NULLS LAST, hire_year NULLS LAST
      // 2. Verifier qu'il y a des lignes avec department NULL (stats par annee)
      // 3. Verifier qu'il y a des lignes avec hire_year NULL (stats par departement)
      // 4. Verifier qu'il y a des lignes avec les deux renseignes (stats croisees)
    });

    summary();
  } finally {
    await teardownDatabase(client, 'DROP TABLE IF EXISTS employees CASCADE;');
    await client.end();
  }
}

run().catch(console.error);
