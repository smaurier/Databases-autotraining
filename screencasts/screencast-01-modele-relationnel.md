# Screencast 01 — Le modèle relationnel

## Informations
- **Durée estimée** : 15-18 min
- **Module** : `modules/01-modele-relationnel.md`
- **Lab associé** : `labs/lab-01-premiers-pas-psql/`
- **Prérequis** : PostgreSQL lancé (Docker), psql accessible

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] Terminal ouvert dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] `psql` connecté à `course_db`

## Script

### [00:00-02:00] Introduction aux tables et types de données

> Dans ce module, on va poser les bases du modèle relationnel. En PostgreSQL, tout est organisé en tables — des lignes et des colonnes. Chaque colonne a un type de données bien défini, et c'est cette rigueur qui garantit l'intégrité de nos données.

**Action** : Afficher un schéma simple d'une table avec colonnes typées (slide ou dessin).

> PostgreSQL offre une richesse de types impressionnante. On a les classiques : INTEGER, TEXT, BOOLEAN, TIMESTAMP. Mais aussi des types avancés comme JSONB, UUID, ou les types géométriques. Aujourd'hui, on se concentre sur les types fondamentaux.

**Action** : Se connecter à psql et montrer la liste des types.

```bash
docker exec -it pg-course psql -U postgres -d course_db
```

```sql
-- Quelques types fondamentaux de PostgreSQL
-- Entiers : SMALLINT (2 bytes), INTEGER (4 bytes), BIGINT (8 bytes)
-- Texte : CHAR(n), VARCHAR(n), TEXT
-- Nombres décimaux : NUMERIC(precision, scale), REAL, DOUBLE PRECISION
-- Booléen : BOOLEAN
-- Date/heure : DATE, TIME, TIMESTAMP, TIMESTAMPTZ
-- UUID : UUID (identifiant universel)
```

### [02:00-06:00] CREATE TABLE — Démonstration complète

> Créons notre première vraie table. On va modéliser une table `users` avec différents types de colonnes.

**Action** : Taper la requête CREATE TABLE dans psql en expliquant chaque ligne.

```sql
-- Créer la table users
CREATE TABLE users (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username    VARCHAR(50) NOT NULL UNIQUE,
    email       VARCHAR(255) NOT NULL UNIQUE,
    full_name   TEXT,
    age         INTEGER,
    is_active   BOOLEAN DEFAULT true,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Vérifier la structure de la table
\d+ users
```

> Regardons la sortie de `\d+ users`. On voit chaque colonne avec son type, ses contraintes, et sa valeur par défaut. Le `+` dans `\d+` donne des informations supplémentaires comme le stockage et la description.

**Action** : Mettre en évidence la sortie de `\d+ users` et pointer chaque colonne.

```sql
-- Insérer quelques lignes pour tester
INSERT INTO users (username, email, full_name, age)
VALUES ('alice', 'alice@example.com', 'Alice Martin', 28);

INSERT INTO users (username, email, full_name, age)
VALUES ('bob', 'bob@example.com', 'Bob Dupont', 35);

SELECT * FROM users;
```

> Remarquez que `id`, `is_active` et `created_at` sont remplis automatiquement. C'est la puissance des valeurs par défaut et de GENERATED ALWAYS AS IDENTITY.

**Action** : Montrer la sortie du SELECT avec les valeurs auto-générées bien visibles.

### [06:00-10:00] Contraintes — PK, NOT NULL, UNIQUE, CHECK

> Les contraintes sont le cœur du modèle relationnel. Elles garantissent que vos données restent cohérentes, quoi qu'il arrive.

**Action** : Démontrer chaque type de contrainte avec des exemples d'erreurs.

```sql
-- PRIMARY KEY : unicité + NOT NULL
INSERT INTO users (username, email) VALUES ('alice', 'alice2@example.com');
-- ERREUR : duplicate key value violates unique constraint "users_username_key"

-- NOT NULL : la colonne ne peut pas être vide
INSERT INTO users (username, email) VALUES (NULL, 'test@example.com');
-- ERREUR : null value in column "username" violates not-null constraint

-- UNIQUE : pas de doublons
INSERT INTO users (username, email) VALUES ('charlie', 'alice@example.com');
-- ERREUR : duplicate key value violates unique constraint "users_email_key"

-- CHECK : validation personnalisée
CREATE TABLE products (
    id      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name    TEXT NOT NULL,
    price   NUMERIC(10, 2) NOT NULL CHECK (price > 0),
    stock   INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0)
);

-- Tester la contrainte CHECK
INSERT INTO products (name, price, stock) VALUES ('Widget', -5.00, 10);
-- ERREUR : new row violates check constraint "products_price_check"

INSERT INTO products (name, price, stock) VALUES ('Widget', 9.99, 10);
-- OK !
SELECT * FROM products;
```

> Chaque contrainte violée produit un message d'erreur clair. En production, votre code applicatif doit intercepter ces erreurs et les traduire en messages utilisateur compréhensibles.

**Action** : Exécuter chaque INSERT qui échoue et montrer le message d'erreur. Puis exécuter l'INSERT qui réussit.

### [10:00-13:00] SERIAL vs GENERATED ALWAYS AS IDENTITY

> Historiquement, PostgreSQL utilisait `SERIAL` pour les colonnes auto-incrémentées. Depuis PostgreSQL 10, on préfère `GENERATED ALWAYS AS IDENTITY`, qui est conforme au standard SQL.

**Action** : Montrer les deux syntaxes côte à côte.

```sql
-- Ancienne méthode : SERIAL (crée une séquence implicite)
CREATE TABLE old_style (
    id SERIAL PRIMARY KEY,
    name TEXT
);

-- Nouvelle méthode : IDENTITY (standard SQL, recommandé)
CREATE TABLE new_style (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name TEXT
);

-- Différence clé : SERIAL permet d'insérer un id manuellement
INSERT INTO old_style (id, name) VALUES (999, 'hack');
-- OK avec SERIAL

-- IDENTITY bloque l'insertion manuelle par défaut
INSERT INTO new_style (id, name) VALUES (999, 'hack');
-- ERREUR : cannot insert a non-DEFAULT value into column "id"

-- Sauf si on le force explicitement (OVERRIDING SYSTEM VALUE)
INSERT INTO new_style (id, name) OVERRIDING SYSTEM VALUE VALUES (999, 'forcé');
-- OK, mais c'est délibéré

-- Voir les séquences créées
\ds
```

> La différence principale : `IDENTITY` protège contre les insertions manuelles accidentelles. C'est plus sûr, et c'est ce qu'on utilisera dans tout le cours.

**Action** : Montrer clairement l'erreur avec IDENTITY et le succès avec SERIAL pour illustrer la différence.

```sql
-- Nettoyage
DROP TABLE old_style;
DROP TABLE new_style;
```

### [13:00-16:30] Démo Lab-01

> Maintenant, regardons le lab 01. C'est votre premier exercice pratique — vous allez créer des tables, ajouter des contraintes, et explorer les types de données.

**Action** : Ouvrir le dossier `labs/lab-01-premiers-pas-psql/` dans l'éditeur.

```bash
# Voir le contenu du lab
ls labs/lab-01-premiers-pas-psql/
```

**Action** : Ouvrir le README du lab et parcourir les instructions.

> Le lab vous demande de créer un schéma basique avec des tables et des contraintes. Voici un aperçu de ce que vous allez faire.

```sql
-- Exemple de ce que le lab demande
-- Créer une table avec les bonnes contraintes
CREATE TABLE articles (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title       VARCHAR(200) NOT NULL,
    content     TEXT,
    published   BOOLEAN DEFAULT false,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Vérifier la structure
\d+ articles

-- Insérer des données de test
INSERT INTO articles (title, content)
VALUES ('Mon premier article', 'Contenu de l''article...');

SELECT * FROM articles;
```

**Action** : Exécuter les commandes du lab étape par étape. Montrer les résultats intermédiaires.

> Je vous encourage à faire ce lab vous-même après ce screencast. La meilleure façon d'apprendre, c'est de taper les requêtes soi-même.

### [16:30-17:30] Conclusion

> On a vu les fondamentaux du modèle relationnel : les types de données, la création de tables, les contraintes, et la différence entre SERIAL et IDENTITY. Dans le prochain module, on va passer au CRUD — créer, lire, mettre à jour et supprimer des données. À tout de suite !

**Action** : Nettoyage des tables de démo.

```sql
DROP TABLE IF EXISTS users, products, articles;
```

## Points d'attention pour l'enregistrement
- Préparer les requêtes SQL dans un fichier à copier-coller si besoin
- Bien laisser le temps de lire les messages d'erreur à l'écran
- Zoomer sur la sortie de `\d+ users` pour que la structure soit lisible
- Accentuer visuellement les différences SERIAL vs IDENTITY
- S'assurer que la base `course_db` est propre avant de commencer
- Parler lentement lors de l'explication des contraintes — c'est un concept clé
