# Screencast 03 — Relations et jointures

## Informations
- **Durée estimée** : 18-20 min
- **Module** : `modules/03-relations-et-jointures.md`
- **Lab associé** : `labs/lab-03-jointures-en-pratique/`
- **Prérequis** : Modules 01-02 terminés, PostgreSQL running, base `course_db`

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] Terminal ouvert dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] `psql` connecté à `course_db`

## Script

### [00:00-02:00] Introduction — Clés étrangères

> Jusqu'ici, on a travaillé avec des tables isolées. Mais la vraie puissance du modèle relationnel, ce sont les relations entre tables. Et la clé étrangère est le mécanisme qui garantit l'intégrité de ces relations.

**Action** : Afficher un schéma entité-relation simple (authors -> books).

> Une clé étrangère est une colonne qui référence la clé primaire d'une autre table. PostgreSQL vérifie automatiquement que la valeur référencée existe — impossible d'avoir un livre sans auteur.

### [02:00-06:00] Schéma authors / books / categories

> Construisons un schéma complet avec trois tables liées : des auteurs, des livres et des catégories.

**Action** : Créer les tables une par une dans psql.

```sql
-- Table des auteurs
CREATE TABLE authors (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    country     VARCHAR(50),
    birth_year  INTEGER
);

-- Table des catégories
CREATE TABLE categories (
    id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name  VARCHAR(50) NOT NULL UNIQUE
);

-- Table des livres avec clé étrangère vers authors
CREATE TABLE books (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title       VARCHAR(200) NOT NULL,
    author_id   INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    published   INTEGER,
    pages       INTEGER CHECK (pages > 0)
);

-- Vérifier la structure
\d+ books
```

> Remarquez `REFERENCES authors(id)` : c'est la clé étrangère. `ON DELETE CASCADE` signifie que si on supprime un auteur, tous ses livres seront aussi supprimés. D'autres options sont `SET NULL`, `SET DEFAULT` ou `RESTRICT`.

**Action** : Montrer la sortie de `\d+ books` et pointer la contrainte de clé étrangère.

```sql
-- Peupler les tables
INSERT INTO authors (name, country, birth_year) VALUES
    ('Victor Hugo', 'France', 1802),
    ('Albert Camus', 'France', 1913),
    ('George Orwell', 'Royaume-Uni', 1903),
    ('Haruki Murakami', 'Japon', 1949),
    ('Chimamanda Ngozi Adichie', 'Nigeria', 1977);

INSERT INTO categories (name) VALUES
    ('Roman'), ('Science-Fiction'), ('Philosophie'), ('Poésie');

INSERT INTO books (title, author_id, published, pages) VALUES
    ('Les Misérables', 1, 1862, 1900),
    ('Notre-Dame de Paris', 1, 1831, 940),
    ('L''Étranger', 2, 1942, 185),
    ('La Peste', 2, 1947, 308),
    ('1984', 3, 1949, 328),
    ('La Ferme des animaux', 3, 1945, 112),
    ('Kafka sur le rivage', 4, 2002, 638),
    ('Americanah', 5, 2013, 588);

-- Vérifier l'intégrité référentielle
INSERT INTO books (title, author_id, published, pages)
VALUES ('Livre fantôme', 999, 2024, 100);
-- ERREUR : insert or update on table "books" violates foreign key constraint
```

**Action** : Montrer l'erreur de clé étrangère quand on référence un auteur inexistant.

### [06:00-09:00] INNER JOIN

> Le JOIN est l'opération qui combine des lignes de plusieurs tables. INNER JOIN est le plus courant : il ne retourne que les lignes qui ont une correspondance dans les deux tables.

**Action** : Exécuter les requêtes JOIN et montrer les résultats.

```sql
-- INNER JOIN : livres avec le nom de l'auteur
SELECT
    b.title,
    b.published,
    a.name AS author_name,
    a.country
FROM books b
INNER JOIN authors a ON b.author_id = a.id
ORDER BY b.published;

-- INNER JOIN avec filtre
SELECT
    b.title,
    a.name AS author_name,
    b.pages
FROM books b
INNER JOIN authors a ON b.author_id = a.id
WHERE a.country = 'France'
ORDER BY b.pages DESC;

-- INNER JOIN avec agrégat
SELECT
    a.name AS author_name,
    COUNT(b.id) AS nb_books,
    AVG(b.pages)::INTEGER AS avg_pages
FROM authors a
INNER JOIN books b ON a.id = b.author_id
GROUP BY a.id, a.name
ORDER BY nb_books DESC;
```

> La syntaxe `b.` et `a.` sont des alias de table. On écrit `FROM books b` pour pouvoir ensuite écrire `b.title` au lieu de `books.title`. C'est plus lisible, surtout avec plusieurs JOINs.

**Action** : Pointer les alias dans la requête et leur correspondance dans le FROM.

### [09:00-12:30] LEFT, RIGHT et FULL JOIN

> INNER JOIN exclut les lignes sans correspondance. Mais parfois, on veut garder toutes les lignes d'une table, même sans correspondance. C'est le rôle des JOINs externes.

**Action** : Ajouter un auteur sans livre pour illustrer la différence.

```sql
-- Ajouter un auteur sans livre
INSERT INTO authors (name, country, birth_year)
VALUES ('Nouveau Auteur', 'France', 1990);

-- LEFT JOIN : tous les auteurs, même sans livre
SELECT
    a.name AS author_name,
    b.title
FROM authors a
LEFT JOIN books b ON a.id = b.author_id
ORDER BY a.name;

-- Remarquez : 'Nouveau Auteur' apparaît avec NULL pour le titre
-- Trouver les auteurs sans livre
SELECT
    a.name AS author_name
FROM authors a
LEFT JOIN books b ON a.id = b.author_id
WHERE b.id IS NULL;

-- RIGHT JOIN : tous les livres, même sans auteur (symétrique)
SELECT
    a.name AS author_name,
    b.title
FROM authors a
RIGHT JOIN books b ON a.id = b.author_id
ORDER BY b.title;

-- FULL OUTER JOIN : toutes les lignes des deux côtés
SELECT
    a.name AS author_name,
    b.title
FROM authors a
FULL OUTER JOIN books b ON a.id = b.author_id
ORDER BY a.name;
```

> Le pattern `LEFT JOIN ... WHERE b.id IS NULL` est très utile : il permet de trouver les lignes orphelines — ici, les auteurs qui n'ont aucun livre. C'est un pattern qu'on utilise régulièrement en production.

**Action** : Montrer la ligne avec NULL dans le LEFT JOIN et l'expliquer visuellement.

### [12:30-16:30] Relation N:M avec junction table

> Une relation many-to-many, comme livres-catégories, nécessite une table de jonction. Un livre peut avoir plusieurs catégories, et une catégorie contient plusieurs livres.

**Action** : Créer la table de jonction et la peupler.

```sql
-- Table de jonction books <-> categories
CREATE TABLE book_categories (
    book_id     INTEGER REFERENCES books(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (book_id, category_id)
);

-- Associer des livres aux catégories
INSERT INTO book_categories (book_id, category_id) VALUES
    (1, 1),  -- Les Misérables -> Roman
    (2, 1),  -- Notre-Dame de Paris -> Roman
    (3, 1),  -- L'Étranger -> Roman
    (3, 3),  -- L'Étranger -> Philosophie
    (4, 1),  -- La Peste -> Roman
    (5, 2),  -- 1984 -> Science-Fiction
    (6, 2),  -- La Ferme des animaux -> Science-Fiction
    (7, 1),  -- Kafka sur le rivage -> Roman
    (8, 1);  -- Americanah -> Roman

-- Requête N:M : livres avec leurs catégories
SELECT
    b.title,
    a.name AS author_name,
    STRING_AGG(c.name, ', ' ORDER BY c.name) AS categories
FROM books b
JOIN authors a ON b.author_id = a.id
JOIN book_categories bc ON b.id = bc.book_id
JOIN categories c ON bc.category_id = c.id
GROUP BY b.id, b.title, a.name
ORDER BY b.title;

-- Catégories avec le nombre de livres
SELECT
    c.name AS category,
    COUNT(bc.book_id) AS nb_books
FROM categories c
LEFT JOIN book_categories bc ON c.id = bc.category_id
GROUP BY c.id, c.name
ORDER BY nb_books DESC;
```

> `STRING_AGG` est une fonction d'agrégation qui concatène les valeurs texte avec un séparateur. Très pratique pour afficher une liste de catégories par livre sur une seule ligne.

**Action** : Mettre en évidence la sortie avec les catégories concaténées par `STRING_AGG`.

### [16:30-18:30] Démo Lab-03

> Le lab 03 va vous faire pratiquer toutes ces jointures sur un schéma plus riche. Voyons l'aperçu.

**Action** : Ouvrir `labs/lab-03-jointures-en-pratique/` dans l'éditeur.

```sql
-- Aperçu lab-03 : requêtes de jointure complexes
-- Exemple : trouver les auteurs français avec plus de 1 livre
SELECT
    a.name,
    COUNT(b.id) AS nb_books
FROM authors a
JOIN books b ON a.id = b.author_id
WHERE a.country = 'France'
GROUP BY a.id, a.name
HAVING COUNT(b.id) > 1;
```

**Action** : Montrer la structure du lab et les tests de validation.

### [18:30-19:30] Conclusion

> Les relations et les jointures sont le cœur du modèle relationnel. On a vu les clés étrangères, les quatre types de JOIN, et les relations many-to-many avec table de jonction. Dans le prochain module, on passe aux transactions et à ACID — comment garantir la cohérence de vos données.

**Action** : Nettoyage.

```sql
DROP TABLE IF EXISTS book_categories, books, categories, authors;
```

## Points d'attention pour l'enregistrement
- Préparer un schéma entité-relation visuel (diagram) pour le début
- Bien montrer les résultats NULL dans les LEFT/RIGHT JOINs
- Taper les JOINs progressivement (pas tout d'un coup) pour que le spectateur suive
- Utiliser `\x` (expanded display) dans psql si les résultats sont trop larges
- Montrer clairement la clé primaire composite de la table de jonction
- S'assurer que les données de démo sont cohérentes et intéressantes
