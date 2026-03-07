# Screencast 02 — CRUD et requêtes

## Informations
- **Durée estimée** : 18-20 min
- **Module** : `modules/02-crud-et-requetes.md`
- **Lab associé** : `labs/lab-02-crud-complet/`
- **Prérequis** : Module 01 terminé, PostgreSQL running, base `course_db`

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] Terminal ouvert dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] `psql` connecté à `course_db`
- [ ] Tables de démo prêtes (on les crée au début)

## Script

### [00:00-01:30] Introduction

> Le CRUD — Create, Read, Update, Delete — c'est le quotidien de tout développeur qui travaille avec une base de données. Dans ce module, on va maîtriser chaque opération en SQL pur, puis on verra comment les exécuter depuis Node.js de manière sécurisée.

**Action** : Afficher le module dans l'éditeur et montrer le plan.

```sql
-- Préparer la table de démonstration
CREATE TABLE products (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    category    VARCHAR(50) NOT NULL,
    price       NUMERIC(10, 2) NOT NULL CHECK (price > 0),
    stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

### [01:30-04:30] INSERT et RETURNING

> Commençons par INSERT. La syntaxe de base est simple, mais PostgreSQL offre des fonctionnalités puissantes comme RETURNING et les insertions multiples.

**Action** : Taper les requêtes dans psql.

```sql
-- INSERT simple
INSERT INTO products (name, category, price, stock)
VALUES ('Clavier mécanique', 'Informatique', 89.99, 50);

-- INSERT avec RETURNING : récupérer la ligne insérée
INSERT INTO products (name, category, price, stock)
VALUES ('Souris ergonomique', 'Informatique', 59.99, 30)
RETURNING id, name, created_at;

-- INSERT multiple en une seule requête
INSERT INTO products (name, category, price, stock) VALUES
    ('Écran 27 pouces', 'Informatique', 349.99, 15),
    ('Casque audio', 'Audio', 129.99, 40),
    ('Webcam HD', 'Informatique', 79.99, 25),
    ('Micro USB', 'Audio', 49.99, 60),
    ('Hub USB-C', 'Accessoires', 34.99, 100),
    ('Tapis de souris XL', 'Accessoires', 19.99, 200)
RETURNING id, name;

-- INSERT ... ON CONFLICT (upsert)
INSERT INTO products (name, category, price, stock)
VALUES ('Clavier mécanique', 'Informatique', 94.99, 45)
ON CONFLICT (name) DO NOTHING;
-- Remarque : nécessite un index UNIQUE sur name pour fonctionner
```

> `RETURNING` est extrêmement utile en pratique. Plutôt que de faire un INSERT puis un SELECT, on récupère directement les données insérées — y compris l'id généré automatiquement.

**Action** : Mettre en évidence la sortie de RETURNING avec l'id auto-généré.

### [04:30-08:30] SELECT — WHERE, ORDER BY, LIMIT

> SELECT est la requête la plus utilisée. Voyons les différentes clauses pour filtrer, trier et paginer les résultats.

**Action** : Exécuter les requêtes progressivement, en montrant la sortie de chacune.

```sql
-- SELECT basique : toutes les colonnes
SELECT * FROM products;

-- SELECT avec colonnes spécifiques
SELECT name, price, stock FROM products;

-- WHERE : filtrage simple
SELECT name, price FROM products
WHERE category = 'Informatique';

-- WHERE avec opérateurs
SELECT name, price FROM products
WHERE price BETWEEN 50 AND 100;

SELECT name, price FROM products
WHERE name LIKE '%USB%';

SELECT name, price FROM products
WHERE category IN ('Audio', 'Accessoires');

-- ORDER BY : tri
SELECT name, price FROM products
ORDER BY price DESC;

-- ORDER BY multiple
SELECT name, category, price FROM products
ORDER BY category ASC, price DESC;

-- LIMIT et OFFSET : pagination
SELECT name, price FROM products
ORDER BY price DESC
LIMIT 3;

SELECT name, price FROM products
ORDER BY price DESC
LIMIT 3 OFFSET 3;

-- Compter les résultats
SELECT COUNT(*) FROM products;
SELECT COUNT(*) FROM products WHERE category = 'Informatique';
```

> En production, on utilise presque toujours `LIMIT` avec `ORDER BY` pour la pagination. Attention, `OFFSET` sur de grands datasets peut être lent — on verra des alternatives dans le module performances.

**Action** : Montrer la pagination en exécutant les deux requêtes LIMIT/OFFSET côte à côte.

### [08:30-11:00] UPDATE et DELETE

> UPDATE et DELETE modifient les données existantes. La règle d'or : toujours vérifier votre clause WHERE avant d'exécuter.

**Action** : Démontrer UPDATE et DELETE avec prudence.

```sql
-- UPDATE simple
UPDATE products
SET price = 99.99
WHERE name = 'Clavier mécanique'
RETURNING id, name, price;

-- UPDATE multiple colonnes
UPDATE products
SET price = price * 0.9, stock = stock + 10
WHERE category = 'Accessoires'
RETURNING name, price, stock;

-- Vérifier le résultat
SELECT name, price, stock FROM products WHERE category = 'Accessoires';

-- DELETE avec WHERE
DELETE FROM products
WHERE name = 'Tapis de souris XL'
RETURNING *;

-- ⚠ DANGER : DELETE sans WHERE supprime TOUT
-- DELETE FROM products; -- NE PAS EXÉCUTER !
-- Toujours ajouter WHERE et vérifier avec un SELECT d'abord

-- Bonne pratique : vérifier avant de supprimer
SELECT * FROM products WHERE stock = 0;
-- Si le résultat est correct, alors :
-- DELETE FROM products WHERE stock = 0;
```

> Astuce professionnelle : avant un UPDATE ou DELETE, remplacez le mot-clé par SELECT * pour vérifier quelles lignes seront affectées. C'est une habitude qui peut vous sauver la mise.

**Action** : Montrer la technique SELECT-avant-DELETE en direct.

### [11:00-14:00] Agrégats — GROUP BY et HAVING

> Les fonctions d'agrégation permettent de calculer des statistiques sur vos données : sommes, moyennes, comptages, etc.

**Action** : Exécuter les requêtes d'agrégation.

```sql
-- Fonctions d'agrégation de base
SELECT
    COUNT(*) AS total_produits,
    AVG(price)::NUMERIC(10,2) AS prix_moyen,
    MIN(price) AS prix_min,
    MAX(price) AS prix_max,
    SUM(stock) AS stock_total
FROM products;

-- GROUP BY : agrégats par catégorie
SELECT
    category,
    COUNT(*) AS nb_produits,
    AVG(price)::NUMERIC(10,2) AS prix_moyen,
    SUM(stock) AS stock_total
FROM products
GROUP BY category
ORDER BY nb_produits DESC;

-- HAVING : filtrer les groupes
SELECT
    category,
    COUNT(*) AS nb_produits,
    AVG(price)::NUMERIC(10,2) AS prix_moyen
FROM products
GROUP BY category
HAVING COUNT(*) >= 2
ORDER BY prix_moyen DESC;

-- HAVING vs WHERE : WHERE filtre les lignes, HAVING filtre les groupes
SELECT
    category,
    AVG(price)::NUMERIC(10,2) AS prix_moyen
FROM products
WHERE stock > 0           -- filtre AVANT le regroupement
GROUP BY category
HAVING AVG(price) > 50    -- filtre APRÈS le regroupement
ORDER BY prix_moyen;
```

> La distinction WHERE vs HAVING est une question classique d'entretien. WHERE filtre les lignes individuelles avant le regroupement. HAVING filtre les groupes après le calcul des agrégats.

**Action** : Afficher les deux requêtes côte à côte et pointer la différence.

### [14:00-17:30] Requêtes paramétrées en Node.js

> En Node.js, on ne concatène jamais les valeurs dans les requêtes SQL. On utilise des paramètres pour se protéger des injections SQL.

**Action** : Ouvrir l'éditeur et montrer le code Node.js.

```javascript
// demo-crud.js
const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: 'secret',
  database: 'course_db',
});

async function main() {
  // INSERT avec paramètres et RETURNING
  const insertResult = await pool.query(
    'INSERT INTO products (name, category, price, stock) VALUES ($1, $2, $3, $4) RETURNING *',
    ['Câble HDMI', 'Accessoires', 12.99, 150]
  );
  console.log('Inséré :', insertResult.rows[0]);

  // SELECT avec filtre paramétré
  const category = 'Informatique';
  const minPrice = 50;
  const selectResult = await pool.query(
    'SELECT name, price FROM products WHERE category = $1 AND price >= $2 ORDER BY price',
    [category, minPrice]
  );
  console.log('Produits :', selectResult.rows);

  // UPDATE paramétré
  const updateResult = await pool.query(
    'UPDATE products SET stock = stock - $1 WHERE name = $2 AND stock >= $1 RETURNING name, stock',
    [5, 'Câble HDMI']
  );
  console.log('Mis à jour :', updateResult.rows[0]);

  // Nombre de lignes affectées
  console.log('Lignes affectées :', updateResult.rowCount);

  await pool.end();
}

main().catch(console.error);
```

**Action** : Exécuter le script et montrer la sortie.

```bash
node demo-crud.js
```

> On utilise `Pool` au lieu de `Client` car un pool gère automatiquement plusieurs connexions. C'est indispensable en production pour ne pas saturer le serveur.

### [17:30-19:00] Démo Lab-02

> Le lab 02 vous fait pratiquer toutes ces opérations CRUD sur un jeu de données plus conséquent. Voyons ce qui vous attend.

**Action** : Ouvrir `labs/lab-02-crud-complet/` et parcourir les instructions du README.

```sql
-- Aperçu du lab : on travaille avec une table plus riche
-- Vous devrez écrire des requêtes SELECT complexes,
-- des UPDATE conditionnels, et des agrégats GROUP BY.

-- Exemple de vérification du lab
SELECT category, COUNT(*), AVG(price)::NUMERIC(10,2)
FROM products
GROUP BY category
ORDER BY COUNT(*) DESC;
```

**Action** : Montrer la structure du dossier lab, les fichiers SQL de départ et les tests.

### [19:00-19:45] Conclusion

> On a couvert tout le CRUD : INSERT avec RETURNING, SELECT avec filtres et agrégats, UPDATE et DELETE sécurisés, et les requêtes paramétrées en Node.js. Dans le prochain module, on attaque les relations et les jointures — c'est là que le modèle relationnel prend tout son sens.

**Action** : Nettoyage.

```sql
DROP TABLE IF EXISTS products;
```

## Points d'attention pour l'enregistrement
- Avoir suffisamment de données dans la table pour que les agrégats soient intéressants
- Bien montrer les résultats de RETURNING à chaque INSERT/UPDATE
- Prendre le temps d'expliquer la différence WHERE vs HAVING avec un exemple visuel
- Montrer l'erreur d'injection SQL (optionnel) pour motiver les requêtes paramétrées
- S'assurer que le fichier `demo-crud.js` fonctionne avant l'enregistrement
- Garder un rythme régulier — ce module couvre beaucoup de contenu
