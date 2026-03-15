# Module 13 — JSONB & Types avances

> **Objectif** : Exploiter la puissance de JSONB, des arrays, des range types et du Full-Text Search pour aller au-dela du modèle relationnel classique.
>
> **Difficulte** : ⭐⭐⭐

---

## 1. JSON vs JSONB dans PostgreSQL

### 1.1 Deux types, deux philosophies

PostgreSQL propose **deux** types pour stocker du JSON :

| Critere | JSON | JSONB |
|---------|------|-------|
| Stockage | Texte brut | Binaire decompose |
| Preservation du formatage | **Oui** (espaces, ordre des clés) | Non |
| Doublons de clés | Conserves | Derniere valeur gagne |
| Indexation (GIN) | **Non** | **Oui** |
| Operateurs avances | Limites | **Complets** |
| Vitesse d'écriture | Plus rapide (pas de parsing) | Legerement plus lent |
| Vitesse de lecture | Plus lent (re-parsing à chaque lecture) | **Plus rapide** |

> **Analogie** : JSON, c'est comme garder un document Word tel quel — avec sa mise en forme. JSONB, c'est comme le convertir dans une base de donnees structuree — on perd la mise en forme mais on peut chercher dedans instantanement.

### 1.2 La regle d'or

```
┌──────────────────────────────────────────────────────────────┐
│                                                               │
│   TOUJOURS utiliser JSONB.                                   │
│                                                               │
│   Sauf si vous avez besoin de preserver                      │
│   le formatage exact du JSON original                        │
│   (cas tres rare : audit, conformite).                       │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

### 1.3 Créer une table avec JSONB

```sql
CREATE TABLE produits (
    id       SERIAL PRIMARY KEY,
    nom      TEXT NOT NULL,
    prix     NUMERIC(10,2) NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb
);

INSERT INTO produits (nom, prix, metadata) VALUES
    ('Laptop Pro', 1299.99, '{
        "marque": "TechCorp",
        "specs": {
            "ram": 16,
            "stockage": "512GB SSD",
            "processeur": "M2"
        },
        "tags": ["portable", "pro", "performant"],
        "en_stock": true,
        "note": 4.5
    }'),
    ('Clavier Ergo', 89.99, '{
        "marque": "KeyMaster",
        "specs": {
            "type": "mecanique",
            "switches": "Cherry MX Brown",
            "retroeclairage": true
        },
        "tags": ["peripherique", "ergonomique"],
        "en_stock": true,
        "note": 4.2
    }'),
    ('Ecran 4K', 549.99, '{
        "marque": "ViewPro",
        "specs": {
            "taille": "27 pouces",
            "resolution": "3840x2160",
            "dalle": "IPS"
        },
        "tags": ["ecran", "4k", "pro"],
        "en_stock": false,
        "note": 4.7
    }');
```

---

## 2. Operateurs JSONB

### 2.1 Acceder aux valeurs

| Operateur | Retourne | Exemple | Résultat |
|-----------|---------|---------|----------|
| `->` | JSONB | `metadata->'marque'` | `"TechCorp"` (avec guillemets) |
| `->>` | TEXT | `metadata->>'marque'` | `TechCorp` (sans guillemets) |
| `#>` | JSONB (chemin) | `metadata#>'{specs,ram}'` | `16` |
| `#>>` | TEXT (chemin) | `metadata#>>'{specs,ram}'` | `16` (en texte) |

```sql
-- Acceder a une cle simple
SELECT nom, metadata->>'marque' AS marque FROM produits;

-- Acceder a une cle imbriquee
SELECT nom, metadata#>>'{specs,ram}' AS ram FROM produits;

-- Acceder a un element de tableau (0-indexed)
SELECT nom, metadata->'tags'->>0 AS premier_tag FROM produits;
```

> **Piege classique** : `->` retourne du JSONB, `->>` retourne du TEXT. Si vous voulez comparer avec un nombre, utilisez `#>>` et castez :

```sql
-- MAUVAIS : compare du JSONB avec un nombre
SELECT * FROM produits WHERE metadata->'note' > 4;
-- ERROR: operator does not exist: jsonb > integer

-- BON : extraire en TEXT puis caster
SELECT * FROM produits WHERE (metadata->>'note')::numeric > 4;

-- BON aussi : comparer avec un JSONB
SELECT * FROM produits WHERE metadata->'note' > '4'::jsonb;
```

### 2.2 Operateurs de contenance et d'existence

| Operateur | Signification | Exemple |
|-----------|---------------|---------|
| `@>` | Contient | `metadata @> '{"en_stock": true}'` |
| `<@` | Est contenu dans | `'{"en_stock": true}' <@ metadata` |
| `?` | Cle existe | `metadata ? 'marque'` |
| `?\|` | Au moins une clé existe | `metadata ?\| array['marque','couleur']` |
| `?&` | Toutes les clés existent | `metadata ?& array['marque','note']` |

```sql
-- Produits en stock
SELECT nom FROM produits
WHERE metadata @> '{"en_stock": true}';

-- Produits qui ont un tag "pro"
SELECT nom FROM produits
WHERE metadata->'tags' ? 'pro';

-- Produits avec la cle "marque"
SELECT nom FROM produits
WHERE metadata ? 'marque';
```

### 2.3 Operateurs de modification

```sql
-- Fusionner (||) : ajoute ou ecrase des cles
UPDATE produits
SET metadata = metadata || '{"garantie": "2 ans", "note": 4.8}'::jsonb
WHERE nom = 'Laptop Pro';
-- note passe de 4.5 a 4.8, garantie est ajoutee

-- Supprimer une cle (-)
UPDATE produits
SET metadata = metadata - 'garantie'
WHERE nom = 'Laptop Pro';

-- Supprimer par chemin (#-)
UPDATE produits
SET metadata = metadata #- '{specs,retroeclairage}'
WHERE nom = 'Clavier Ergo';

-- Supprimer un element de tableau par index
UPDATE produits
SET metadata = metadata #- '{tags,0}'  -- supprime le premier tag
WHERE nom = 'Laptop Pro';
```

### 2.4 Fonctions de modification

```sql
-- jsonb_set : modifier une valeur a un chemin specifique
UPDATE produits
SET metadata = jsonb_set(
    metadata,
    '{specs,ram}',     -- chemin
    '32'::jsonb,       -- nouvelle valeur
    true               -- creer le chemin si absent
)
WHERE nom = 'Laptop Pro';

-- jsonb_insert : inserer dans un tableau
UPDATE produits
SET metadata = jsonb_insert(
    metadata,
    '{tags,0}',          -- position
    '"nouveau-tag"'::jsonb,
    false                -- false = inserer AVANT, true = APRES
)
WHERE nom = 'Laptop Pro';

-- jsonb_strip_nulls : supprimer les cles avec valeur null
SELECT jsonb_strip_nulls('{"a": 1, "b": null, "c": 3}'::jsonb);
-- {"a": 1, "c": 3}
```

### 2.5 Decomposer du JSONB

```sql
-- jsonb_each : decomposer en paires cle/valeur
SELECT key, value
FROM produits,
     jsonb_each(metadata->'specs')
WHERE nom = 'Laptop Pro';

--     key      │    value
-- ─────────────┼──────────────
--  ram         │ 32
--  stockage    │ "512GB SSD"
--  processeur  │ "M2"

-- jsonb_array_elements : decomposer un tableau
SELECT value AS tag
FROM produits,
     jsonb_array_elements_text(metadata->'tags')
WHERE nom = 'Laptop Pro';
```

### 2.6 Construire du JSONB

```sql
-- jsonb_build_object : creer un objet
SELECT jsonb_build_object(
    'nom', p.nom,
    'prix', p.prix,
    'marque', p.metadata->>'marque'
) AS json_simplifie
FROM produits p;

-- jsonb_agg : agreger des lignes en tableau JSONB
SELECT jsonb_agg(
    jsonb_build_object('nom', nom, 'prix', prix)
) AS tous_produits
FROM produits;

-- jsonb_object_agg : agreger en objet
SELECT jsonb_object_agg(nom, prix) AS prix_par_produit
FROM produits;
-- {"Laptop Pro": 1299.99, "Clavier Ergo": 89.99, "Ecran 4K": 549.99}
```

### JSON_TABLE (PostgreSQL 17+)

`JSON_TABLE` convertit des donnees JSON en lignes et colonnes relationnelles — c'est la fonction SQL standard (SQL:2016) la plus attendue :

```sql
-- Extraire les items d'une commande JSON en table relationnelle
SELECT jt.*
FROM orders,
  JSON_TABLE(
    data, '$.items[*]'
    COLUMNS (
      product_name TEXT PATH '$.name',
      quantity INT PATH '$.qty',
      price NUMERIC PATH '$.price'
    )
  ) AS jt
WHERE orders.id = 42;

-- Resultat :
-- product_name | quantity | price
-- Laptop       | 1        | 999.99
-- Mouse        | 2        | 29.99
```

> **Avant JSON_TABLE**, il fallait combiner `jsonb_array_elements()`, `->>'key'` et des casts manuels. JSON_TABLE est plus lisible et plus performant sur les structures complexes.

---

## 3. GIN index sur JSONB

### 3.1 Pourquoi indexer le JSONB

Sans index, PostgreSQL doit lire **chaque ligne** et parser le JSONB pour trouver une correspondance. Avec un index GIN, la recherche est quasi-instantanee.

### 3.2 jsonb_ops vs jsonb_path_ops

```sql
-- jsonb_ops (defaut) : supporte tous les operateurs
CREATE INDEX idx_produits_metadata
    ON produits USING GIN (metadata);
-- Supporte : @>, ?, ?|, ?&

-- jsonb_path_ops : plus petit, plus rapide, mais seulement @>
CREATE INDEX idx_produits_metadata_path
    ON produits USING GIN (metadata jsonb_path_ops);
-- Supporte seulement : @>
```

| Classe d'operateur | Taille index | Operateurs supportes | Cas d'usage |
|---|---|---|---|
| `jsonb_ops` | Plus grand | @>, ?, ?\|, ?& | Usage général |
| `jsonb_path_ops` | ~3x plus petit | @> seulement | Recherche par contenance |

### 3.3 Index sur une expression JSONB

```sql
-- Index sur une cle specifique (comme un index classique)
CREATE INDEX idx_produits_marque
    ON produits ((metadata->>'marque'));

-- Utilise pour :
SELECT * FROM produits WHERE metadata->>'marque' = 'TechCorp';

-- Index sur une valeur numerique extraite
CREATE INDEX idx_produits_note
    ON produits (((metadata->>'note')::numeric));

-- Utilise pour :
SELECT * FROM produits WHERE (metadata->>'note')::numeric > 4.5;
```

### 3.4 Node.js : requêtes JSONB

```typescript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ max: 10 });

interface Produit {
    id: number;
    nom: string;
    prix: number;
    metadata: Record<string, unknown>;
}

// Rechercher par contenance (@>)
async function rechercherProduits(criteres: Record<string, unknown>): Promise<Produit[]> {
    const { rows } = await pool.query<Produit>(
        `SELECT id, nom, prix, metadata
         FROM produits
         WHERE metadata @> $1::jsonb`,
        [JSON.stringify(criteres)]
    );
    return rows;
}

// Exemples :
await rechercherProduits({ en_stock: true });
await rechercherProduits({ marque: 'TechCorp' });
await rechercherProduits({ specs: { ram: 16 } });

// Modifier du JSONB
async function ajouterTag(produitId: number, tag: string): Promise<void> {
    await pool.query(
        `UPDATE produits
         SET metadata = jsonb_set(
             metadata,
             '{tags}',
             (metadata->'tags') || $1::jsonb
         )
         WHERE id = $2`,
        [JSON.stringify(tag), produitId]
    );
}

await ajouterTag(1, 'promotion');
```

---

## 4. Arrays PostgreSQL

### 4.1 Declaration et insertion

```sql
CREATE TABLE articles (
    id      SERIAL PRIMARY KEY,
    titre   TEXT NOT NULL,
    tags    TEXT[] NOT NULL DEFAULT '{}',
    scores  INTEGER[]
);

INSERT INTO articles (titre, tags, scores) VALUES
    ('Intro a PostgreSQL', ARRAY['sql', 'database', 'tutorial'], ARRAY[85, 92, 78]),
    ('Node.js avance', ARRAY['javascript', 'node', 'backend'], ARRAY[90, 88]),
    ('React et PostgreSQL', ARRAY['javascript', 'sql', 'fullstack'], ARRAY[75, 95, 82]),
    ('DevOps 101', ARRAY['devops', 'docker', 'ci-cd'], NULL);
```

### 4.2 Operateurs sur les arrays

| Operateur | Signification | Exemple |
|-----------|---------------|---------|
| `@>` | Contient | `tags @> ARRAY['sql']` |
| `<@` | Est contenu dans | `ARRAY['sql'] <@ tags` |
| `&&` | Intersection non vide | `tags && ARRAY['sql','node']` |
| `\|\|` | Concatenation | `tags \|\| ARRAY['new']` |
| `=` | Egalite | `tags = ARRAY['a','b']` |

```sql
-- Articles contenant le tag 'sql'
SELECT titre FROM articles WHERE tags @> ARRAY['sql'];
-- Intro a PostgreSQL, React et PostgreSQL

-- Articles contenant 'sql' OU 'node'
SELECT titre FROM articles WHERE tags && ARRAY['sql', 'node'];
-- Intro a PostgreSQL, Node.js avance, React et PostgreSQL

-- Nombre d'elements
SELECT titre, array_length(tags, 1) AS nb_tags FROM articles;
```

### 4.3 unnest() et array_agg()

```sql
-- Decomposer un array en lignes (unnest)
SELECT titre, unnest(tags) AS tag
FROM articles;

--       titre          │    tag
-- ─────────────────────┼────────────
-- Intro a PostgreSQL   │ sql
-- Intro a PostgreSQL   │ database
-- Intro a PostgreSQL   │ tutorial
-- Node.js avance       │ javascript
-- ...

-- Re-agreger en array (array_agg)
SELECT tag, array_agg(titre) AS articles_avec_tag
FROM (
    SELECT titre, unnest(tags) AS tag
    FROM articles
) sub
GROUP BY tag
ORDER BY tag;

-- Compter les tags les plus populaires
SELECT tag, COUNT(*) AS nb_articles
FROM articles, unnest(tags) AS tag
GROUP BY tag
ORDER BY nb_articles DESC;
```

### 4.4 GIN sur les arrays

```sql
CREATE INDEX idx_articles_tags ON articles USING GIN (tags);

-- Utilise automatiquement pour @>, <@, &&
EXPLAIN SELECT * FROM articles WHERE tags @> ARRAY['sql'];
-- Bitmap Index Scan on idx_articles_tags
```

---

## 5. Range types

### 5.1 Les types de ranges

PostgreSQL offre des types natifs pour representer des **intervalles** :

| Type | Contenu | Exemple |
|------|---------|---------|
| `int4range` | Entiers | `[1,10)` |
| `int8range` | Grands entiers | `[1,1000000)` |
| `numrange` | Numeriques | `[1.5,9.5]` |
| `tsrange` | Timestamps (sans TZ) | `['2025-01-01','2025-02-01')` |
| `tstzrange` | Timestamps (avec TZ) | `['2025-01-01 00:00+01','2025-02-01 00:00+01')` |
| `daterange` | Dates | `[2025-01-01,2025-02-01)` |

> **Analogie** : Un range, c'est comme un segment sur une droite numérique. Au lieu de stocker "debut" et "fin" dans deux colonnes, vous stockez le segment entier. PostgreSQL peut alors faire des operations geometriques : intersection, union, chevauchement...

### 5.2 Notation

```
[  = borne incluse (inclusive)
(  = borne exclue (exclusive)

[1,5]  = 1, 2, 3, 4, 5
[1,5)  = 1, 2, 3, 4
(1,5]  = 2, 3, 4, 5
(1,5)  = 2, 3, 4
```

### 5.3 Operateurs sur les ranges

| Operateur | Signification | Exemple |
|-----------|---------------|---------|
| `@>` | Contient élément | `int4range(1,10) @> 5` → true |
| `<@` | Est contenu dans | `5 <@ int4range(1,10)` → true |
| `&&` | Se chevauchent | `int4range(1,5) && int4range(3,8)` → true |
| `-\|-` | Adjacent | `int4range(1,5) -\|- int4range(5,10)` → true |
| `<<` | Strictement a gauche | `int4range(1,3) << int4range(5,8)` → true |
| `>>` | Strictement a droite | `int4range(5,8) >> int4range(1,3)` → true |
| `*` | Intersection | `int4range(1,8) * int4range(3,12)` → [3,8) |
| `+` | Union | `int4range(1,5) + int4range(3,8)` → [1,8) |

### 5.4 Cas d'usage : creneaux horaires

```sql
CREATE TABLE salles (
    id  SERIAL PRIMARY KEY,
    nom TEXT NOT NULL
);

CREATE TABLE reservations (
    id         SERIAL PRIMARY KEY,
    salle_id   INT REFERENCES salles(id),
    creneau    TSTZRANGE NOT NULL,
    reserve_par TEXT NOT NULL
);

INSERT INTO salles (nom) VALUES ('Salle A'), ('Salle B');

INSERT INTO reservations (salle_id, creneau, reserve_par) VALUES
    (1, '[2025-03-07 09:00, 2025-03-07 10:00)', 'Alice'),
    (1, '[2025-03-07 10:00, 2025-03-07 11:30)', 'Bob'),
    (1, '[2025-03-07 14:00, 2025-03-07 16:00)', 'Charlie'),
    (2, '[2025-03-07 09:00, 2025-03-07 12:00)', 'David');
```

```sql
-- Trouver les reservations qui chevauchent un creneau
SELECT r.*, s.nom AS salle
FROM reservations r
JOIN salles s ON r.salle_id = s.id
WHERE r.creneau && '[2025-03-07 09:30, 2025-03-07 10:30)'::tstzrange;

-- Extraire debut et fin
SELECT
    reserve_par,
    lower(creneau) AS debut,
    upper(creneau) AS fin,
    upper(creneau) - lower(creneau) AS duree
FROM reservations;
```

### 5.5 EXCLUDE constraint — Empecher les chevauchements

```sql
-- Necessite l'extension btree_gist
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Contrainte : pas de chevauchement pour la meme salle
ALTER TABLE reservations
ADD CONSTRAINT no_overlap
EXCLUDE USING GIST (
    salle_id WITH =,       -- meme salle
    creneau WITH &&         -- creneaux qui se chevauchent
);

-- Tentative d'insertion chevauchante
INSERT INTO reservations (salle_id, creneau, reserve_par)
VALUES (1, '[2025-03-07 09:30, 2025-03-07 10:30)', 'Eve');
-- ERROR: conflicting key value violates exclusion constraint "no_overlap"
-- DETAIL: Key (salle_id, creneau)=(1, ["2025-03-07 09:30","2025-03-07 10:30"))
-- conflicts with existing key (salle_id, creneau)=
-- (1, ["2025-03-07 09:00","2025-03-07 10:00")).
```

> **Point clé** : La contrainte EXCLUDE avec les ranges est **la** façon correcte d'empecher les doubles reservations. C'est plus fiable que n'importe quelle vérification applicative.

### 5.6 GiST index sur les ranges

```sql
-- Index GiST pour les requetes de chevauchement
CREATE INDEX idx_reservations_creneau
    ON reservations USING GIST (creneau);

-- Index composite (salle + creneau)
CREATE INDEX idx_reservations_salle_creneau
    ON reservations USING GIST (salle_id, creneau);
```

---

## 6. Full-Text Search

### 6.1 Le problème

```sql
-- LIKE est simple mais limite
SELECT * FROM articles WHERE titre LIKE '%postgresql%';
-- Problemes :
-- 1. Pas d'index (sauf pg_trgm)
-- 2. Pas de stemming : "databases" ne matche pas "database"
-- 3. Pas de classement par pertinence
-- 4. Sensible a la casse (sans ILIKE)
```

### 6.2 tsvector et tsquery

| Concept | Description | Exemple |
|---------|-------------|---------|
| `tsvector` | Document preprocesse (tokens, positions, poids) | `'introduct':1 'postgresql':3 'databas':4` |
| `tsquery` | Requête de recherche (operateurs logiques) | `'postgresql & database'` |
| `@@` | Operateur de correspondance | `tsvector @@ tsquery` |

```sql
-- Creer un tsvector a partir de texte
SELECT to_tsvector('french', 'Introduction aux bases de donnees PostgreSQL');
-- 'bas':3 'don':5 'introduct':1 'postgresql':6

-- Creer une tsquery
SELECT to_tsquery('french', 'base & donnees');
-- 'bas' & 'don'

-- Verifier la correspondance
SELECT to_tsvector('french', 'Introduction aux bases de donnees PostgreSQL')
    @@ to_tsquery('french', 'base & donnees');
-- true
```

> **Analogie** : `tsvector` est comme un index de livre : il liste les mots importants avec leur position. `tsquery` est comme votre question : "je cherche les livres qui parlent de X ET Y". L'operateur `@@` cherche dans l'index.

### 6.3 Configuration en français

```sql
-- Voir les configurations disponibles
SELECT cfgname FROM pg_ts_config;
-- simple, danish, dutch, english, finnish, french, ...

-- Tester le francais
SELECT to_tsvector('french', 'Les chevaux mangeaient dans les champs');
-- 'champ':6 'cheval':2 'mangeai':3
-- "Les" est un stop word (supprime)
-- "chevaux" est reduit a "cheval" (stemming)
-- "mangeaient" est reduit a "mangeai"

-- Comparer avec l'anglais
SELECT to_tsvector('english', 'Les chevaux mangeaient dans les champs');
-- 'champ':6 'chevaux':2 'dan':4 'le':1,5 'mangeaient':3
-- Pas de stemming francais !
```

### 6.4 Créer une table avec Full-Text Search

```sql
CREATE TABLE evenements (
    id          SERIAL PRIMARY KEY,
    titre       TEXT NOT NULL,
    description TEXT,
    lieu        TEXT,
    date_event  DATE,
    -- Colonne generee pour le Full-Text Search
    search_vector TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('french', coalesce(titre, '')), 'A') ||
        setweight(to_tsvector('french', coalesce(description, '')), 'B') ||
        setweight(to_tsvector('french', coalesce(lieu, '')), 'C')
    ) STORED
);

-- Index GIN sur le vecteur de recherche
CREATE INDEX idx_evenements_search ON evenements USING GIN (search_vector);

INSERT INTO evenements (titre, description, lieu, date_event) VALUES
    ('Conference PostgreSQL France',
     'Decouvrez les nouveautes de PostgreSQL 17 avec des experts de la communaute. Sessions techniques et retours d''experience.',
     'Paris, Palais des Congres',
     '2025-06-15'),
    ('Atelier Node.js et bases de donnees',
     'Apprenez a connecter Node.js a PostgreSQL et MongoDB. Travaux pratiques intensifs sur les requetes avancees.',
     'Lyon, Campus Numerique',
     '2025-07-20'),
    ('Meetup DevOps et PostgreSQL',
     'Haute disponibilite, replication, monitoring. Comment deployer PostgreSQL en production avec Docker et Kubernetes.',
     'Marseille, La Cantine',
     '2025-09-10');
```

### 6.5 Rechercher avec Full-Text

```sql
-- Recherche simple
SELECT titre, ts_rank(search_vector, q) AS rank
FROM evenements,
     to_tsquery('french', 'postgresql') q
WHERE search_vector @@ q
ORDER BY rank DESC;

-- Recherche avec operateurs logiques
-- & = ET, | = OU, ! = NON, <-> = suivi de
SELECT titre
FROM evenements
WHERE search_vector @@ to_tsquery('french', 'postgresql & production');
-- Meetup DevOps et PostgreSQL

SELECT titre
FROM evenements
WHERE search_vector @@ to_tsquery('french', 'node | react');
-- Atelier Node.js et bases de donnees

-- Recherche de phrase (mots adjacents)
SELECT titre
FROM evenements
WHERE search_vector @@ to_tsquery('french', 'base <-> donnee');
```

### 6.6 ts_rank et ts_headline

```sql
-- Scoring : classer par pertinence
SELECT
    titre,
    ts_rank(search_vector, q) AS score,
    -- Avec poids : A=1.0, B=0.4, C=0.2, D=0.1
    ts_rank(search_vector, q, 32) AS score_normalise
FROM evenements,
     to_tsquery('french', 'postgresql') q
WHERE search_vector @@ q
ORDER BY score DESC;

-- Highlighting : mettre en evidence les mots trouves
SELECT
    titre,
    ts_headline('french', description, to_tsquery('french', 'postgresql'),
        'StartSel=<b>, StopSel=</b>, MaxWords=35, MinWords=15'
    ) AS extrait
FROM evenements
WHERE search_vector @@ to_tsquery('french', 'postgresql');
```

```
 titre                          │ extrait
────────────────────────────────┼───────────────────────────────────────────
 Conference PostgreSQL France   │ les nouveautes de <b>PostgreSQL</b> 17
                                │ avec des experts de la communaute
 Meetup DevOps et PostgreSQL    │ deployer <b>PostgreSQL</b> en production
                                │ avec Docker et Kubernetes
```

### 6.7 websearch_to_tsquery — Recherche user-friendly

```sql
-- Les utilisateurs ne connaissent pas la syntaxe tsquery
-- websearch_to_tsquery accepte une syntaxe naturelle

SELECT * FROM evenements
WHERE search_vector @@ websearch_to_tsquery('french', 'postgresql production');
-- Equivalent a : 'postgresql' & 'production'

SELECT * FROM evenements
WHERE search_vector @@ websearch_to_tsquery('french', '"base de donnees"');
-- Recherche de phrase exacte

SELECT * FROM evenements
WHERE search_vector @@ websearch_to_tsquery('french', 'postgresql -docker');
-- PostgreSQL mais PAS docker

SELECT * FROM evenements
WHERE search_vector @@ websearch_to_tsquery('french', 'node OR react');
-- node OU react
```

### 6.8 Comparaison LIKE vs ILIKE vs Full-Text

| Critere | LIKE/ILIKE | pg_trgm | Full-Text Search |
|---------|-----------|---------|-----------------|
| Stemming | Non | Non | **Oui** |
| Stop words | Non | Non | **Oui** |
| Scoring | Non | Similarite | **ts_rank** |
| Index | B-tree (prefixe) | GIN/GiST | **GIN** |
| Fautes de frappe | Non | **Oui** (similarite) | Non |
| Performance | Mauvaise sans index | Bonne | **Excellente** |
| Configuration langue | Non | Non | **Oui** |

### 6.9 Node.js : Full-Text Search

```typescript
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ max: 10 });

interface SearchOptions {
    limit?: number;
    offset?: number;
}

interface EvenementResult {
    id: number;
    titre: string;
    extrait: string;
    lieu: string;
    date_event: string;
    score: number;
}

async function rechercherEvenements(
    termeRecherche: string,
    options: SearchOptions = {}
): Promise<EvenementResult[]> {
    const { limit = 20, offset = 0 } = options;

    const { rows } = await pool.query<EvenementResult>(
        `SELECT
            id,
            titre,
            ts_headline('french', description,
                websearch_to_tsquery('french', $1),
                'StartSel=<mark>, StopSel=</mark>, MaxWords=50'
            ) AS extrait,
            lieu,
            date_event,
            ts_rank(search_vector, websearch_to_tsquery('french', $1)) AS score
        FROM evenements
        WHERE search_vector @@ websearch_to_tsquery('french', $1)
        ORDER BY score DESC
        LIMIT $2 OFFSET $3`,
        [termeRecherche, limit, offset]
    );

    return rows;
}

// Utilisation
const resultats: EvenementResult[] = await rechercherEvenements('PostgreSQL production');
console.log(resultats);
```

---

## 7. Generated columns

### 7.1 Colonnes calculees

```sql
-- Colonne generee avec une expression
CREATE TABLE factures (
    id         SERIAL PRIMARY KEY,
    montant_ht NUMERIC(10,2) NOT NULL,
    taux_tva   NUMERIC(4,2) NOT NULL DEFAULT 20.00,
    montant_ttc NUMERIC(10,2) GENERATED ALWAYS AS (
        montant_ht * (1 + taux_tva / 100)
    ) STORED
);

INSERT INTO factures (montant_ht) VALUES (100.00);
SELECT * FROM factures;
-- id | montant_ht | taux_tva | montant_ttc
-- 1  | 100.00     | 20.00    | 120.00

-- Impossible de modifier directement une colonne generee
UPDATE factures SET montant_ttc = 150;
-- ERROR: column "montant_ttc" can only be updated to DEFAULT
```

### 7.2 tsvector en colonne générée (rappel)

```sql
-- Deja vu plus haut, c'est le pattern recommande
ALTER TABLE articles ADD COLUMN search_vector TSVECTOR
    GENERATED ALWAYS AS (
        to_tsvector('french', coalesce(titre, '') || ' ' || coalesce(contenu, ''))
    ) STORED;

CREATE INDEX idx_articles_fts ON articles USING GIN (search_vector);
```

---

## 8. Exercice mental

> **Exercice mental** : Vous construisez un système de reservation de salles. Comment empecheriez-vous les doubles reservations en utilisant les types avances de PostgreSQL ? Quels types, contraintes et index utiliseriez-vous ?

<details>
<summary>Reponse</summary>

1. **Type** : `tstzrange` pour le creneau de reservation
2. **Extension** : `btree_gist` pour les contraintes d'exclusion
3. **Contrainte** : `EXCLUDE USING GIST (salle_id WITH =, creneau WITH &&)`
   - "Pas deux reservations pour la même salle avec des creneaux qui se chevauchent"
4. **Index** : GiST sur `(salle_id, creneau)` pour les requêtes de disponibilité
5. **Recherche** : `WHERE creneau && '[2025-03-07 09:00, 2025-03-07 10:00)'::tstzrange` pour trouver les conflits

C'est exactement ce qu'on implementera dans le module 15 (projet final).
</details>

---

## Ce qu'il faut retenir

```
┌──────────────────────────────────────────────────────────────┐
│                    A RETENIR                                  │
│                                                               │
│  1. JSONB > JSON (toujours, sauf preservation du formatage)  │
│                                                               │
│  2. -> retourne JSONB, ->> retourne TEXT                     │
│     @> pour la contenance, ? pour l'existence                │
│                                                               │
│  3. GIN index sur JSONB : jsonb_ops (general)                │
│     ou jsonb_path_ops (plus petit, seulement @>)             │
│                                                               │
│  4. Arrays : @> (contient), && (intersection), unnest()      │
│                                                               │
│  5. Range types : intervalles natifs avec operateurs          │
│     EXCLUDE constraint pour empecher les chevauchements      │
│                                                               │
│  6. Full-Text Search : tsvector + tsquery + GIN              │
│     to_tsvector('french', ...) pour le francais              │
│     websearch_to_tsquery pour les utilisateurs               │
│                                                               │
│  7. Generated columns pour les colonnes calculees            │
└──────────────────────────────────────────────────────────────┘
```

---

## Navigation

| Précédent | Suivant |
|---|---|
| [Module 12 — Fonctions avancees SQL](./12-fonctions-avancees-sql.md) | [Module 14 — Sécurité & Administration](./14-securite-et-administration.md) |

**Travaux pratiques** : [Lab 13 — JSONB, arrays, ranges et Full-Text Search](../labs/lab-13-types-avances.md)

---

> *"PostgreSQL n'est pas juste une base relationnelle. C'est une base relationnelle qui a absorbe le meilleur des bases documents, des bases clé-valeur et des moteurs de recherche."*

---

<!-- parcours-recommande -->

::: tip Parcours recommandé
1. **Screencast** : [screencast 13 jsonb fulltext](../screencasts/screencast-13-jsonb-fulltext.md)
2. **Lab** : [lab-13-jsonb-fulltext](../labs/lab-13-jsonb-fulltext/README)
3. **Quiz** : [quiz 13 jsonb et types avances](../quizzes/quiz-13-jsonb-et-types-avances.html)
:::
