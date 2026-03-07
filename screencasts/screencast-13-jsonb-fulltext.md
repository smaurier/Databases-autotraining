# Screencast 13 — JSONB et full-text search

## Informations
- **Durée estimée** : 18-20 min
- **Module** : `modules/13-jsonb-et-types-avances.md`
- **Lab associé** : `labs/lab-13-jsonb-fulltext/`
- **Prérequis** : Module 07 (index avancés) terminé, PostgreSQL running, base `course_db`

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] Terminal ouvert dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] `psql` connecté à `course_db`

## Script

### [00:00-02:00] Introduction

> PostgreSQL brille là où d'autres bases relationnelles s'arrêtent : le JSONB natif et la recherche full-text intégrée. Pas besoin d'Elasticsearch pour la plupart des cas d'usage. PostgreSQL fait les deux dans la même base, avec des transactions ACID.

**Action** : Créer les tables de démonstration.

```sql
-- Table produits avec JSONB
CREATE TABLE products (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    category    VARCHAR(50) NOT NULL,
    specs       JSONB NOT NULL DEFAULT '{}',
    tags        TEXT[] DEFAULT '{}',
    description TEXT NOT NULL
);

INSERT INTO products (name, category, specs, tags, description) VALUES
    ('MacBook Pro 16"', 'Laptop',
     '{"brand": "Apple", "cpu": "M3 Max", "ram": 36, "storage": "1TB SSD", "screen": {"size": 16.2, "resolution": "3456x2234"}, "ports": ["HDMI", "USB-C", "MagSafe", "SD Card"]}',
     ARRAY['laptop', 'apple', 'pro', 'creative'],
     'Le MacBook Pro 16 pouces avec puce M3 Max offre des performances exceptionnelles pour les professionnels de la création'),

    ('ThinkPad X1 Carbon', 'Laptop',
     '{"brand": "Lenovo", "cpu": "i7-1365U", "ram": 16, "storage": "512GB SSD", "screen": {"size": 14, "resolution": "2560x1600"}, "ports": ["USB-C", "USB-A", "HDMI"]}',
     ARRAY['laptop', 'lenovo', 'business', 'lightweight'],
     'PC portable Lenovo ultraléger et robuste, conçu pour les professionnels en déplacement'),

    ('Galaxy S24 Ultra', 'Smartphone',
     '{"brand": "Samsung", "cpu": "Snapdragon 8 Gen 3", "ram": 12, "storage": "512GB", "screen": {"size": 6.8, "resolution": "3120x1440"}, "cameras": [200, 50, 12, 10]}',
     ARRAY['phone', 'samsung', 'android', 'flagship'],
     'Smartphone Samsung haut de gamme avec stylet S Pen intégré et capteur photo de 200 mégapixels'),

    ('Sony WH-1000XM5', 'Audio',
     '{"brand": "Sony", "type": "over-ear", "noise_cancelling": true, "battery_hours": 30, "bluetooth": "5.3", "codecs": ["LDAC", "AAC", "SBC"]}',
     ARRAY['audio', 'headphones', 'sony', 'noise-cancelling'],
     'Casque audio Sony à réduction de bruit active avec une autonomie de 30 heures et un son exceptionnel'),

    ('Kindle Paperwhite', 'E-Reader',
     '{"brand": "Amazon", "screen": {"size": 6.8, "type": "e-ink"}, "storage": "16GB", "waterproof": true, "battery_weeks": 10}',
     ARRAY['ereader', 'amazon', 'reading'],
     'Liseuse Amazon étanche avec écran anti-reflet, idéale pour la lecture en plein soleil ou dans le bain');
```

### [02:00-06:30] Opérateurs JSONB

> JSONB offre une multitude d'opérateurs pour extraire, filtrer et manipuler les données JSON directement en SQL.

**Action** : Démontrer les opérateurs JSONB progressivement.

```sql
-- Extraction : -> retourne du JSON, ->> retourne du texte
SELECT
    name,
    specs->'brand' AS brand_json,       -- "Apple" (avec guillemets, type jsonb)
    specs->>'brand' AS brand_text,      -- Apple (sans guillemets, type text)
    specs->'screen'->>'size' AS screen_size  -- accès imbriqué
FROM products;

-- Extraction avec #>> pour les chemins profonds
SELECT
    name,
    specs #>> '{screen, resolution}' AS resolution
FROM products
WHERE specs #>> '{screen, size}' IS NOT NULL;

-- Opérateur de contenance : @> (contient)
SELECT name FROM products
WHERE specs @> '{"brand": "Apple"}';

SELECT name FROM products
WHERE specs @> '{"noise_cancelling": true}';

-- Opérateur d'existence : ? (la clé existe)
SELECT name FROM products
WHERE specs ? 'cameras';

-- Opérateurs sur les clés multiples
SELECT name FROM products
WHERE specs ?& ARRAY['brand', 'ram'];  -- toutes les clés existent

SELECT name FROM products
WHERE specs ?| ARRAY['waterproof', 'cameras'];  -- au moins une clé existe

-- Modification JSONB : || (concaténation / mise à jour)
UPDATE products
SET specs = specs || '{"color": "Space Black"}'
WHERE name = 'MacBook Pro 16"';

SELECT name, specs->>'color' FROM products WHERE name LIKE 'MacBook%';

-- Suppression d'une clé
UPDATE products
SET specs = specs - 'color'
WHERE name = 'MacBook Pro 16"';

-- jsonb_set : modifier une valeur imbriquée
UPDATE products
SET specs = jsonb_set(specs, '{ram}', '64')
WHERE name = 'MacBook Pro 16"';

SELECT name, specs->>'ram' FROM products WHERE name LIKE 'MacBook%';
```

> Les opérateurs JSONB sont la force de PostgreSQL face à MongoDB. Vous gardez les transactions ACID, les jointures, les contraintes, tout en manipulant des données semi-structurées.

**Action** : Exécuter chaque requête et montrer la sortie. Mettre en évidence la différence `->` vs `->>`.

### [06:30-09:00] Index GIN sur JSONB

> Sans index, chaque opérateur JSONB fait un Seq Scan. Avec un index GIN, les recherches deviennent instantanées.

**Action** : Insérer des données en masse et comparer les performances.

```sql
-- Ajouter 200 000 produits pour le benchmark
INSERT INTO products (name, category, specs, tags, description)
SELECT
    'Product ' || i,
    (ARRAY['Laptop', 'Smartphone', 'Audio', 'Tablet', 'Accessory'])[1 + floor(random()*5)::int],
    jsonb_build_object(
        'brand', (ARRAY['Apple', 'Samsung', 'Sony', 'Lenovo', 'HP'])[1 + floor(random()*5)::int],
        'ram', (ARRAY[4, 8, 16, 32, 64])[1 + floor(random()*5)::int],
        'price', round((random() * 2000 + 50)::numeric, 2)
    ),
    ARRAY[(ARRAY['tech', 'pro', 'budget', 'flagship', 'entry'])[1 + floor(random()*5)::int]],
    'Description du produit ' || i || ' avec des caractéristiques variées'
FROM generate_series(1, 200000) AS s(i);

ANALYZE products;

-- Sans index GIN
EXPLAIN ANALYZE
SELECT name FROM products WHERE specs @> '{"brand": "Apple", "ram": 32}';

-- Créer l'index GIN
CREATE INDEX idx_products_specs ON products USING GIN (specs);

-- Avec index GIN
EXPLAIN ANALYZE
SELECT name FROM products WHERE specs @> '{"brand": "Apple", "ram": 32}';

-- Index GIN sur jsonb_path_ops (plus compact, opérateur @> uniquement)
CREATE INDEX idx_products_specs_path ON products USING GIN (specs jsonb_path_ops);
```

> `jsonb_path_ops` crée un index plus petit qui ne supporte que l'opérateur `@>`. Si c'est votre seul besoin, c'est un meilleur choix que le GIN par défaut.

**Action** : Comparer les temps EXPLAIN ANALYZE et les tailles d'index.

### [09:00-11:30] Arrays PostgreSQL

> Les arrays natifs de PostgreSQL sont parfaits pour les listes de tags, de rôles, ou de valeurs multiples.

**Action** : Démontrer les opérations sur arrays.

```sql
-- Opérateurs sur arrays
SELECT name, tags FROM products
WHERE 'apple' = ANY(tags);           -- contient 'apple'

SELECT name, tags FROM products
WHERE tags @> ARRAY['laptop', 'pro'];  -- contient les deux

SELECT name, tags FROM products
WHERE tags && ARRAY['audio', 'phone']; -- overlap (au moins un en commun)

-- Fonctions utiles
SELECT
    name,
    tags,
    array_length(tags, 1) AS nb_tags,
    array_to_string(tags, ', ') AS tags_str
FROM products
WHERE id <= 5;

-- Index GIN sur array
CREATE INDEX idx_products_tags ON products USING GIN (tags);

EXPLAIN ANALYZE
SELECT name FROM products WHERE tags @> ARRAY['pro'];
```

**Action** : Montrer les résultats des requêtes sur arrays et l'utilisation de l'index GIN.

### [11:30-16:00] Full-text search — tsvector et tsquery

> Le full-text search de PostgreSQL permet de chercher des mots dans du texte de manière linguistique : stemming, stopwords, classement par pertinence.

**Action** : Démontrer le full-text search progressivement.

```sql
-- Comprendre tsvector et tsquery
SELECT to_tsvector('french', 'Le MacBook Pro offre des performances exceptionnelles');
-- 'except':7 'macbook':2 'offr':4 'perform':6 'pro':3

SELECT to_tsquery('french', 'performances & exceptionnelles');
-- 'perform' & 'except'

-- Recherche full-text basique
SELECT name, description
FROM products
WHERE to_tsvector('french', description) @@ to_tsquery('french', 'professionnel');

-- Recherche avec opérateurs
SELECT name FROM products
WHERE to_tsvector('french', description) @@ to_tsquery('french', 'Samsung & photo');

SELECT name FROM products
WHERE to_tsvector('french', description) @@ to_tsquery('french', 'Apple | Samsung');

-- Ajouter une colonne tsvector pour la performance
ALTER TABLE products ADD COLUMN search_vector TSVECTOR;

UPDATE products
SET search_vector = to_tsvector('french', coalesce(name, '') || ' ' || coalesce(description, ''));

-- Index GIN sur le vecteur de recherche
CREATE INDEX idx_products_search ON products USING GIN (search_vector);

-- Recherche rapide avec l'index
EXPLAIN ANALYZE
SELECT name, description
FROM products
WHERE search_vector @@ to_tsquery('french', 'portable & professionnel');
```

> La combinaison nom + description dans un seul tsvector permet de chercher dans les deux champs simultanément. L'index GIN rend la recherche quasi-instantanée, même sur des centaines de milliers de lignes.

**Action** : Montrer les tsvector décomposés et expliquer le stemming (performance -> perform).

### [16:00-18:00] ts_rank et ts_headline

> `ts_rank` classe les résultats par pertinence. `ts_headline` met en évidence les mots trouvés dans un extrait.

**Action** : Démontrer le classement et la mise en évidence.

```sql
-- Classement par pertinence
SELECT
    name,
    ts_rank(search_vector, to_tsquery('french', 'Samsung')) AS rank,
    ts_headline('french', description,
        to_tsquery('french', 'Samsung'),
        'StartSel=<<, StopSel=>>, MaxWords=30, MinWords=15'
    ) AS headline
FROM products
WHERE search_vector @@ to_tsquery('french', 'Samsung')
ORDER BY rank DESC
LIMIT 5;

-- Recherche pondérée : le nom compte plus que la description
UPDATE products
SET search_vector = setweight(to_tsvector('french', coalesce(name, '')), 'A')
    || setweight(to_tsvector('french', coalesce(description, '')), 'B');

-- Avec les poids, un match dans le nom (poids A) a plus d'impact
SELECT
    name,
    ts_rank(search_vector, to_tsquery('french', 'Sony')) AS rank
FROM products
WHERE search_vector @@ to_tsquery('french', 'Sony')
ORDER BY rank DESC
LIMIT 5;
```

> `setweight` attribue des poids A, B, C, D aux tokens. Le poids A est le plus important. C'est comme donner plus d'importance au titre qu'au contenu dans un moteur de recherche.

**Action** : Montrer le headline avec les marqueurs << >> et le classement par rank.

### [18:00-19:30] Démo Lab-13

> Le lab 13 vous fait construire un système de recherche complet avec JSONB et full-text search.

**Action** : Ouvrir `labs/lab-13-jsonb-fulltext/` et parcourir les exercices.

```sql
-- Aperçu lab-13
-- Exercice 1 : Requêtes JSONB avancées (filtrage, modification)
-- Exercice 2 : Index GIN sur JSONB et arrays
-- Exercice 3 : Configuration full-text search (français)
-- Exercice 4 : Classement par pertinence avec ts_rank
-- Exercice 5 : Combinaison JSONB + full-text en une seule requête
```

**Action** : Montrer les fichiers du lab et les cas de test.

### [19:30-20:15] Conclusion

> PostgreSQL remplace MongoDB pour le JSONB et Elasticsearch pour le full-text search dans de nombreux cas. On a vu les opérateurs JSONB, les index GIN, les arrays natifs, tsvector/tsquery, le classement par pertinence et les headlines. Dans le prochain module, on aborde la sécurité et l'administration.

**Action** : Nettoyage.

```sql
DROP TABLE IF EXISTS products;
```

## Points d'attention pour l'enregistrement
- La distinction `->` (jsonb) vs `->>` (text) est fondamentale — bien l'illustrer
- Prendre le temps de montrer le contenu du tsvector pour comprendre le stemming
- Les opérateurs JSONB ont des symboles inhabituels (@>, ?, ?&) — les épeler
- Tester le full-text search en français — la configuration 'french' doit être disponible
- Le ts_headline avec les marqueurs doit être visible à l'écran
- Garder un bon rythme — ce module couvre deux gros sujets
