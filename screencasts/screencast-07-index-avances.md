# Screencast 07 — Index avancés

## Informations
- **Durée estimée** : 18-20 min
- **Module** : `modules/07-index-avances.md`
- **Lab associé** : `labs/lab-07-index-gin-gist-brin/`
- **Prérequis** : Modules 05-06 terminés, PostgreSQL running, base `course_db`

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] Terminal ouvert dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] `psql` connecté à `course_db`

## Script

### [00:00-02:00] Introduction — Au-delà du B-tree

> Le B-tree est excellent pour les comparaisons classiques. Mais PostgreSQL offre d'autres types d'index optimisés pour des cas d'usage spécifiques : GIN pour les données composites (JSONB, arrays, full-text), GiST pour les données spatiales et les ranges, et BRIN pour les données naturellement triées comme les time-series.

**Action** : Afficher un tableau comparatif des types d'index et leurs cas d'usage.

> Choisir le bon type d'index peut faire la différence entre une requête de 500ms et une requête de 2ms. C'est ce qu'on va voir dans ce module.

### [02:00-07:00] GIN — JSONB et full-text search

> GIN signifie Generalized Inverted Index. Il fonctionne comme un index inversé : pour chaque valeur possible (clé JSONB, mot dans un texte, élément d'un array), il stocke la liste des lignes qui la contiennent.

**Action** : Créer une table avec des données JSONB et démontrer GIN.

```sql
-- Table avec données JSONB
CREATE TABLE products (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    attributes  JSONB NOT NULL DEFAULT '{}',
    tags        TEXT[] DEFAULT '{}',
    description TEXT
);

-- Insérer des données variées
INSERT INTO products (name, attributes, tags, description) VALUES
    ('MacBook Pro 16', '{"brand": "Apple", "ram": 32, "storage": "1TB", "cpu": "M3 Max"}',
     ARRAY['laptop', 'apple', 'pro'], 'Ordinateur portable haut de gamme Apple avec puce M3 Max'),
    ('ThinkPad X1', '{"brand": "Lenovo", "ram": 16, "storage": "512GB", "cpu": "i7"}',
     ARRAY['laptop', 'lenovo', 'business'], 'PC portable professionnel Lenovo robuste et léger'),
    ('Galaxy S24', '{"brand": "Samsung", "ram": 12, "storage": "256GB", "screen": "6.2"}',
     ARRAY['phone', 'samsung', 'android'], 'Smartphone Samsung avec IA intégrée'),
    ('Pixel 8 Pro', '{"brand": "Google", "ram": 12, "storage": "256GB", "screen": "6.7"}',
     ARRAY['phone', 'google', 'android'], 'Smartphone Google avec appareil photo exceptionnel'),
    ('iPad Air', '{"brand": "Apple", "ram": 8, "storage": "256GB", "screen": "10.9"}',
     ARRAY['tablet', 'apple'], 'Tablette Apple polyvalente pour le quotidien');

-- Insérer 100 000 lignes supplémentaires pour les benchmarks
INSERT INTO products (name, attributes, tags, description)
SELECT
    'Product ' || i,
    jsonb_build_object(
        'brand', (ARRAY['Apple', 'Samsung', 'Sony', 'LG', 'HP'])[1 + floor(random()*5)::int],
        'ram', (ARRAY[4, 8, 16, 32])[1 + floor(random()*4)::int],
        'price', (random() * 2000 + 100)::int
    ),
    ARRAY[(ARRAY['electronics', 'phone', 'laptop', 'tablet', 'accessory'])[1 + floor(random()*5)::int]],
    'Description du produit numéro ' || i
FROM generate_series(1, 100000) AS s(i);

ANALYZE products;
```

```sql
-- Sans index GIN : Seq Scan
EXPLAIN ANALYZE
SELECT name, attributes FROM products
WHERE attributes @> '{"brand": "Apple"}';

-- Créer un index GIN sur JSONB
CREATE INDEX idx_products_attrs ON products USING GIN (attributes);

-- Avec index GIN : beaucoup plus rapide
EXPLAIN ANALYZE
SELECT name, attributes FROM products
WHERE attributes @> '{"brand": "Apple"}';

-- GIN supporte aussi les opérateurs d'existence
EXPLAIN ANALYZE
SELECT name FROM products
WHERE attributes ? 'screen';

-- Index GIN sur array
CREATE INDEX idx_products_tags ON products USING GIN (tags);

EXPLAIN ANALYZE
SELECT name FROM products
WHERE tags @> ARRAY['apple'];
```

> L'opérateur `@>` signifie "contient". Avec l'index GIN, PostgreSQL peut trouver instantanément tous les produits Apple dans le JSONB sans scanner toute la table.

**Action** : Comparer les temps avant/après l'index GIN. Montrer les différents opérateurs JSONB supportés.

### [07:00-10:00] GiST — Ranges et données spatiales

> GiST (Generalized Search Tree) est idéal pour les données qui se chevauchent : ranges de dates, ranges numériques, données géométriques.

**Action** : Démontrer GiST avec des ranges.

```sql
-- Table de réservations avec ranges de dates
CREATE TABLE reservations (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_name   VARCHAR(50) NOT NULL,
    during      TSTZRANGE NOT NULL,
    guest_name  VARCHAR(100) NOT NULL
);

-- Insérer des réservations
INSERT INTO reservations (room_name, during, guest_name) VALUES
    ('Suite 101', '[2025-06-01, 2025-06-05)', 'Alice Martin'),
    ('Suite 101', '[2025-06-10, 2025-06-15)', 'Bob Dupont'),
    ('Suite 102', '[2025-06-01, 2025-06-08)', 'Charlie Petit'),
    ('Suite 102', '[2025-06-12, 2025-06-14)', 'Diana Leroy');

-- Insérer des données en masse pour le benchmark
INSERT INTO reservations (room_name, during, guest_name)
SELECT
    'Room ' || (i % 50 + 100),
    tstzrange(
        '2025-01-01'::timestamptz + (random() * 365)::int * INTERVAL '1 day',
        '2025-01-01'::timestamptz + (random() * 365 + 1)::int * INTERVAL '1 day'
    ),
    'Guest ' || i
FROM generate_series(1, 100000) AS s(i);

ANALYZE reservations;

-- Requête : réservations qui chevauchent une période
EXPLAIN ANALYZE
SELECT room_name, during, guest_name
FROM reservations
WHERE during && '[2025-06-01, 2025-06-10)'::tstzrange;

-- Créer un index GiST sur le range
CREATE INDEX idx_reservations_during ON reservations USING GIST (during);

-- Même requête avec l'index GiST
EXPLAIN ANALYZE
SELECT room_name, during, guest_name
FROM reservations
WHERE during && '[2025-06-01, 2025-06-10)'::tstzrange;
```

> L'opérateur `&&` signifie "overlap" — il cherche les ranges qui se chevauchent avec la période donnée. C'est exactement ce dont on a besoin pour un système de réservation. Le B-tree ne sait pas faire ça — il faut un GiST.

**Action** : Montrer la différence de temps avec et sans index GiST.

### [10:00-13:30] BRIN — Time-series et données triées

> BRIN (Block Range INdex) est un index minuscule qui fonctionne quand les données sont physiquement triées sur le disque. Parfait pour les tables de logs ou d'événements où les nouvelles lignes arrivent toujours à la fin.

**Action** : Démontrer BRIN sur une table de logs.

```sql
-- Table de logs (données naturellement triées par timestamp)
CREATE TABLE logs (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    level       VARCHAR(10) NOT NULL,
    message     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insérer 1 million de lignes dans l'ordre chronologique
INSERT INTO logs (level, message, created_at)
SELECT
    (ARRAY['INFO', 'WARN', 'ERROR', 'DEBUG'])[1 + floor(random()*4)::int],
    'Log message ' || i,
    '2025-01-01'::timestamptz + (i * INTERVAL '30 seconds')
FROM generate_series(1, 1000000) AS s(i);

ANALYZE logs;

-- Index B-tree classique
CREATE INDEX idx_logs_btree ON logs (created_at);

-- Index BRIN (beaucoup plus compact)
CREATE INDEX idx_logs_brin ON logs USING BRIN (created_at);

-- Comparer les tailles
SELECT
    indexname,
    pg_size_pretty(pg_relation_size(indexname::regclass)) AS size
FROM pg_indexes
WHERE tablename = 'logs'
ORDER BY pg_relation_size(indexname::regclass) DESC;

-- Le BRIN est ~100x plus petit que le B-tree !

-- Requête avec BRIN
EXPLAIN ANALYZE
SELECT COUNT(*) FROM logs
WHERE created_at BETWEEN '2025-03-01' AND '2025-03-31';
```

> Le BRIN stocke uniquement les valeurs min/max par bloc de pages. Pour 1 million de lignes, un BRIN fait quelques Ko là où un B-tree fait plusieurs Mo. La contrepartie : il est moins précis et peut lire des blocs inutiles, mais pour les time-series, c'est un excellent compromis.

**Action** : Montrer la différence de taille entre B-tree et BRIN. C'est le point clé de la démo.

### [13:30-16:00] Covering indexes (INCLUDE)

> Un covering index inclut des colonnes supplémentaires dans l'index sans les utiliser pour la recherche. Cela permet un Index Only Scan — PostgreSQL n'a même pas besoin de lire la table, tout est dans l'index.

**Action** : Créer et tester un covering index.

```sql
-- Sans covering index : Index Scan (lit l'index PUIS la table)
EXPLAIN ANALYZE
SELECT name, attributes->>'brand' AS brand
FROM products
WHERE attributes @> '{"brand": "Apple"}';

-- Covering index B-tree avec INCLUDE
CREATE INDEX idx_products_name_brand ON products (name) INCLUDE (attributes);

-- Index Only Scan sur les colonnes couvertes
EXPLAIN ANALYZE
SELECT name FROM products
WHERE name LIKE 'Product 1%';

-- Comparaison des plans
DROP INDEX idx_products_name_brand;

-- Covering index pratique : recherche par user_id, retourne event_type
CREATE INDEX idx_events_covering ON events (user_id) INCLUDE (event_type, created_at);

-- Recréons la table events rapidement
CREATE TABLE IF NOT EXISTS events (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type  VARCHAR(20),
    user_id     INTEGER,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

> L'Index Only Scan est le Graal de la performance. Aucun accès à la table heap, tout est servi depuis l'index. C'est particulièrement efficace pour les requêtes de type dashboard qui lisent quelques colonnes sur beaucoup de lignes.

**Action** : Pointer "Index Only Scan" dans le plan d'exécution.

### [16:00-18:00] Comparaison de performance

> Récapitulons : quand utiliser quel index ?

**Action** : Afficher un tableau récapitulatif.

```sql
-- Résumé des tailles d'index sur nos tables
SELECT
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexname::regclass)) AS index_size
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, pg_relation_size(indexname::regclass) DESC;
```

> B-tree : comparaisons classiques (=, <, >, BETWEEN, ORDER BY). GIN : données composites (JSONB, arrays, full-text). GiST : ranges, géométrie, overlap. BRIN : données physiquement triées, time-series. Le choix dépend toujours du type de requête que vous faites le plus souvent.

**Action** : Montrer le tableau comparatif et commenter chaque cas d'usage.

### [18:00-19:30] Démo Lab-07

> Le lab 07 vous fait expérimenter avec ces trois types d'index sur des datasets réalistes.

**Action** : Ouvrir `labs/lab-07-index-gin-gist-brin/` et parcourir les exercices.

```sql
-- Aperçu lab-07
-- Exercice 1 : GIN sur JSONB — recherche de produits par attributs
-- Exercice 2 : GiST sur ranges — vérification de chevauchements
-- Exercice 3 : BRIN sur time-series — requêtes sur fenêtres temporelles
-- Bonus : comparer les tailles et performances de chaque type
```

**Action** : Parcourir les fichiers du lab et montrer la progression des exercices.

### [19:30-20:15] Conclusion

> Les index avancés de PostgreSQL couvrent des cas d'usage que peu d'autres bases proposent. GIN, GiST et BRIN sont des outils puissants quand le B-tree ne suffit pas. Dans le prochain module, on change de sujet pour parler des niveaux d'isolation des transactions et du MVCC.

**Action** : Nettoyage.

```sql
DROP TABLE IF EXISTS products, reservations, logs, events;
```

## Points d'attention pour l'enregistrement
- Préparer les données en avance — les INSERT de 100k+ lignes prennent du temps
- Bien montrer les tailles d'index comparées (surtout BRIN vs B-tree)
- Les opérateurs JSONB (@>, ?, ?&) sont nouveaux pour beaucoup — les expliquer
- Tester les plans EXPLAIN ANALYZE avant l'enregistrement
- Garder un rythme soutenu — ce module couvre beaucoup de types d'index
- Préparer un aide-mémoire des opérateurs pour chaque type d'index
