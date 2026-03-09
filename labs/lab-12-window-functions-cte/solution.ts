// =============================================================================
// Lab 12 — Window Functions & CTEs (Solution)
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
      const res = await query(client, `
        WITH numbered AS (
          SELECT *, ROW_NUMBER() OVER (ORDER BY name) AS rn
          FROM employees
        )
        SELECT * FROM numbered
        WHERE rn BETWEEN 11 AND 20
        ORDER BY rn
      `);

      assertEqual(res.rows.length, 10, 'La page 2 doit contenir 10 resultats');
      assertEqual(parseInt(res.rows[0].rn), 11, 'Le premier resultat doit avoir rn = 11');
      assertEqual(parseInt(res.rows[9].rn), 20, 'Le dernier resultat doit avoir rn = 20');
    });

    // -----------------------------------------------------------------------
    // Test 2 : RANK — classement par salaire dans chaque departement
    // -----------------------------------------------------------------------
    await test('RANK — classement des salaires par departement', async () => {
      const res = await query(client, `
        SELECT name, department, salary,
          RANK() OVER (PARTITION BY department ORDER BY salary DESC) AS rank
        FROM employees
      `);

      // Filtrer les premiers de chaque departement
      const topEarners = res.rows.filter(r => parseInt(r.rank) === 1);
      assertEqual(topEarners.length, 5,
        'Doit y avoir 5 premiers (un par departement)');

      // Verifier que chaque departement est represente
      const departments = topEarners.map(r => r.department).sort();
      assertIncludes(departments, 'Direction', 'Direction doit etre present');
      assertIncludes(departments, 'Ingenierie', 'Ingenierie doit etre present');
      assertIncludes(departments, 'Marketing', 'Marketing doit etre present');
      assertIncludes(departments, 'Finance', 'Finance doit etre present');
      assertIncludes(departments, 'RH', 'RH doit etre present');
    });

    // -----------------------------------------------------------------------
    // Test 3 : DENSE_RANK — gestion des ex aequo
    // -----------------------------------------------------------------------
    await test('DENSE_RANK — gestion des ex aequo', async () => {
      const res = await query(client, `
        SELECT name, salary,
          DENSE_RANK() OVER (ORDER BY salary DESC) AS dense_rank,
          RANK() OVER (ORDER BY salary DESC) AS rank
        FROM employees
        WHERE department = 'Ingenierie'
        ORDER BY salary DESC
      `);

      // Thomas Faure et Julie Garnier ont le meme salaire (58000)
      // Ils doivent avoir le meme dense_rank
      const thomasSalary = res.rows.find(r => r.name === 'Thomas Faure');
      const julieSalary = res.rows.find(r => r.name === 'Julie Garnier');

      assert(thomasSalary && julieSalary, 'Thomas et Julie doivent etre dans les resultats');
      assertEqual(parseFloat(thomasSalary.salary), parseFloat(julieSalary.salary),
        'Thomas et Julie ont le meme salaire');
      assertEqual(parseInt(thomasSalary.dense_rank), parseInt(julieSalary.dense_rank),
        'DENSE_RANK doit etre identique pour les ex aequo');

      // Verifier qu'il n'y a pas de trou dans dense_rank
      const ranks = [...new Set(res.rows.map(r => parseInt(r.dense_rank)))].sort((a, b) => a - b);
      for (let i = 0; i < ranks.length - 1; i++) {
        assertEqual(ranks[i + 1] - ranks[i], 1,
          'DENSE_RANK ne doit pas avoir de trou');
      }
    });

    // -----------------------------------------------------------------------
    // Test 4 : LAG/LEAD — comparer avec precedent/suivant
    // -----------------------------------------------------------------------
    await test('LAG/LEAD — comparer salaire avec precedent et suivant', async () => {
      const res = await query(client, `
        SELECT name, department, salary,
          LAG(salary) OVER (PARTITION BY department ORDER BY salary) AS prev_salary,
          LEAD(salary) OVER (PARTITION BY department ORDER BY salary) AS next_salary
        FROM employees
        WHERE department = 'Ingenierie'
        ORDER BY salary
      `);

      // Premier employe : pas de predecesseur
      assert(res.rows[0].prev_salary === null, 'Le premier employe n\'a pas de prev_salary');

      // Dernier employe : pas de successeur
      const last = res.rows[res.rows.length - 1];
      assert(last.next_salary === null, 'Le dernier employe n\'a pas de next_salary');

      // Employe au milieu : prev_salary <= salary <= next_salary
      const mid = res.rows[Math.floor(res.rows.length / 2)];
      if (mid.prev_salary !== null) {
        assert(parseFloat(mid.prev_salary) <= parseFloat(mid.salary),
          'prev_salary doit etre <= salary');
      }
      if (mid.next_salary !== null) {
        assert(parseFloat(mid.salary) <= parseFloat(mid.next_salary),
          'salary doit etre <= next_salary');
      }
    });

    // -----------------------------------------------------------------------
    // Test 5 : Running total (total cumulatif)
    // -----------------------------------------------------------------------
    await test('Running total — SUM(salary) OVER (ORDER BY hire_date)', async () => {
      const res = await query(client, `
        SELECT name, hire_date, salary,
          SUM(salary) OVER (ORDER BY hire_date, id) AS cumul
        FROM employees
        ORDER BY hire_date, id
      `);

      // Le premier cumul = le salaire du premier employe
      assertEqual(parseFloat(res.rows[0].cumul), parseFloat(res.rows[0].salary),
        'Le premier cumul doit etre egal au premier salaire');

      // Le dernier cumul = la somme totale
      const totalRes = await query(client, 'SELECT SUM(salary) AS total FROM employees');
      const total = parseFloat(totalRes.rows[0].total);
      const lastCumul = parseFloat(res.rows[res.rows.length - 1].cumul);
      assertEqual(lastCumul, total,
        'Le dernier cumul doit etre egal a la somme totale');

      // Le cumul doit etre croissant (ou egal)
      for (let i = 1; i < res.rows.length; i++) {
        assert(parseFloat(res.rows[i].cumul) >= parseFloat(res.rows[i - 1].cumul),
          'Le cumul doit etre croissant');
      }
    });

    // -----------------------------------------------------------------------
    // Test 6 : CTE — reecrire une sous-requete
    // -----------------------------------------------------------------------
    await test('CTE — reecrire une sous-requete complexe', async () => {
      const res = await query(client, `
        WITH dept_avg AS (
          SELECT department, AVG(salary)::numeric(10,2) AS avg_salary
          FROM employees
          GROUP BY department
        )
        SELECT e.name, e.department, e.salary, d.avg_salary
        FROM employees e
        JOIN dept_avg d ON e.department = d.department
        WHERE e.salary > d.avg_salary
        ORDER BY e.department, e.salary DESC
      `);

      assertGreaterThan(res.rows.length, 0, 'Doit trouver des employes au-dessus de la moyenne');

      // Verifier que chaque salaire est bien > la moyenne de son departement
      for (const row of res.rows) {
        assertGreaterThan(parseFloat(row.salary), parseFloat(row.avg_salary),
          `${row.name} (${row.salary}) doit etre > moyenne (${row.avg_salary})`);
      }
    });

    // -----------------------------------------------------------------------
    // Test 7 : CTE recursive — organigramme
    // -----------------------------------------------------------------------
    await test('CTE recursive — tous les rapports d\'un manager', async () => {
      const res = await query(client, `
        WITH RECURSIVE org AS (
          -- Cas de base : employes directement sous Marie (id=1)
          SELECT id, name, manager_id
          FROM employees
          WHERE manager_id = 1

          UNION ALL

          -- Recursion : employes sous les managers trouves
          SELECT e.id, e.name, e.manager_id
          FROM employees e
          JOIN org o ON e.manager_id = o.id
        )
        SELECT * FROM org ORDER BY id
      `);

      // Toute l'entreprise est sous Marie (49 employes sur 50)
      assertGreaterThan(res.rows.length, 40,
        'Marie doit avoir plus de 40 rapports (directs et indirects)');

      // Marie ne doit PAS etre dans les resultats
      const marieInResults = res.rows.find(r => r.id === 1);
      assert(!marieInResults, 'Marie (id=1) ne doit pas apparaitre dans ses propres rapports');
    });

    // -----------------------------------------------------------------------
    // Test 8 : CTE recursive — niveau hierarchique
    // -----------------------------------------------------------------------
    await test('CTE recursive — calculer le niveau hierarchique', async () => {
      const res = await query(client, `
        WITH RECURSIVE hierarchy AS (
          -- Racine : employes sans manager (Marie)
          SELECT id, name, manager_id, 0 AS depth
          FROM employees
          WHERE manager_id IS NULL

          UNION ALL

          -- Recursion : descendre dans l'arbre
          SELECT e.id, e.name, e.manager_id, h.depth + 1
          FROM employees e
          JOIN hierarchy h ON e.manager_id = h.id
        )
        SELECT * FROM hierarchy ORDER BY depth, name
      `);

      // Marie (id=1) doit etre au depth 0
      const marie = res.rows.find(r => r.id === 1);
      assertEqual(parseInt(marie.depth), 0, 'Marie doit avoir depth = 0');

      // Les directeurs de departement (ids 2-5) au depth 1
      const jean = res.rows.find(r => r.id === 2);
      assertEqual(parseInt(jean.depth), 1, 'Jean Martin doit avoir depth = 1');

      // La profondeur maximale doit etre >= 3
      const maxDepth = Math.max(...res.rows.map(r => parseInt(r.depth)));
      assertGreaterThan(maxDepth, 2, 'La profondeur maximale doit etre >= 3');
      console.log(`     → Profondeur max de l'organigramme : ${maxDepth}`);
    });

    // -----------------------------------------------------------------------
    // Test 9 : LATERAL JOIN — top 3 par departement
    // -----------------------------------------------------------------------
    await test('LATERAL JOIN — top 3 salaires par departement', async () => {
      const res = await query(client, `
        SELECT d.department, t.name, t.salary
        FROM (SELECT DISTINCT department FROM employees) d,
        LATERAL (
          SELECT name, salary
          FROM employees
          WHERE department = d.department
          ORDER BY salary DESC
          LIMIT 3
        ) t
        ORDER BY d.department, t.salary DESC
      `);

      assertEqual(res.rows.length, 15,
        'Doit avoir 15 resultats (3 par departement x 5 departements)');

      // Verifier le tri decroissant dans chaque departement
      let currentDept = null;
      let prevSalary = Infinity;
      for (const row of res.rows) {
        if (row.department !== currentDept) {
          currentDept = row.department;
          prevSalary = Infinity;
        }
        assert(parseFloat(row.salary) <= prevSalary,
          `Les salaires doivent etre decroissants dans ${currentDept}`);
        prevSalary = parseFloat(row.salary);
      }
    });

    // -----------------------------------------------------------------------
    // Test 10 : GROUPING SETS
    // -----------------------------------------------------------------------
    await test('GROUPING SETS — stats par departement et annee', async () => {
      const res = await query(client, `
        SELECT
          department,
          EXTRACT(YEAR FROM hire_date)::int AS hire_year,
          COUNT(*) AS nb,
          AVG(salary)::numeric(10,2) AS avg_salary
        FROM employees
        GROUP BY GROUPING SETS (
          (department),
          (EXTRACT(YEAR FROM hire_date)),
          (department, EXTRACT(YEAR FROM hire_date))
        )
        ORDER BY department NULLS LAST, hire_year NULLS LAST
      `);

      assertGreaterThan(res.rows.length, 0, 'Doit retourner des resultats');

      // Lignes avec department NULL = stats par annee uniquement
      const byYearOnly = res.rows.filter(r => r.department === null && r.hire_year !== null);
      assertGreaterThan(byYearOnly.length, 0,
        'Doit avoir des lignes avec department NULL (stats par annee)');

      // Lignes avec hire_year NULL = stats par departement uniquement
      const byDeptOnly = res.rows.filter(r => r.department !== null && r.hire_year === null);
      assertGreaterThan(byDeptOnly.length, 0,
        'Doit avoir des lignes avec hire_year NULL (stats par departement)');

      // Lignes avec les deux renseignes = stats croisees
      const cross = res.rows.filter(r => r.department !== null && r.hire_year !== null);
      assertGreaterThan(cross.length, 0,
        'Doit avoir des lignes avec department et hire_year renseignes');

      console.log(`     → ${byDeptOnly.length} lignes par departement, ${byYearOnly.length} par annee, ${cross.length} croisees`);
    });

    summary();
  } finally {
    await teardownDatabase(client, 'DROP TABLE IF EXISTS employees CASCADE;');
    await client.end();
  }
}

run().catch(console.error);
