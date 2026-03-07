# Module 07 — Index avances (GIN, GiST, BRIN)

> **Objectif** : Comprendre pourquoi le B-tree ne suffit pas toujours, maitriser les index GIN (JSONB, arrays, full-text), GiST (ranges, geometrie), BRIN (time-series), et les covering indexes avec `INCLUDE`.
>
> **Difficulte** : ⭐⭐⭐ (avance)

---

## 1. Rappel : pourquoi un B-tree ne suffit pas toujours

Le B-tree est excellent pour les comparaisons simples (`=`, `<`, `>`, `BETWEEN`) sur des valeurs scalaires. Mais certains types de donnees et certaines operations ne se pretent pas a une comparaison lineaire :

| Besoin | B-tree peut faire ? | Index adapte |
|---|---|---|
| Chercher une cle dans un objet JSONB | Non (valeur composite) | **GIN** |
| Chercher si un array contient un element | Non (valeur composite) | **GIN** |
| Full-text search (tsvector @@ tsquery) | Non (pas d'ordre lineaire) | **GIN** ou **GiST** |
| Chercher si deux intervalles se chevauchent | Non (comparaison 2D) | **GiST** |
| Recherche geospatiale (points, polygones) | Non (comparaison 2D/3D) | **GiST** |
| Donnees naturellement ordonnees (time-series) | Oui mais gaspillage | **BRIN** |

> **Analogie** : Le B-tree est comme un dictionnaire : parfait pour chercher un mot par ordre alphabetique. Mais si tu veux chercher "tous les livres qui parlent de PostgreSQL", il te faut un **index inversee** (comme Google). Si tu veux chercher "tous les restaurants a moins de 500m", il te faut un **index spatial**. Chaque type de recherche a son index optimal.

```
 Arbre de decision pour choisir un type d'index :

                      Quel type de requete ?
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         Scalaire       Composite      Spatial/Range
         (=, <, >)      (JSON, array,   (overlap,
                        texte libre)    contains)
              │              │              │
         ┌────┘              │              │
         │                   │              │
    ┌────▼───┐         ┌────▼───┐     ┌────▼───┐
    │ B-tree │         │  GIN   │     │  GiST  │
    │  Hash  │         └────────┘     └────────┘
    └────────┘
                    Donnees ordonnees
                    chronologiquement ?
                         │
                    ┌────▼───┐
                    │  BRIN  │
                    └────────┘
```

---

## 2. GIN (Generalized Inverted Index)

### 2.1 Principe : un index inverse

Le GIN est un **index inverse** (inverted index). Au lieu de mapper "ligne → valeur", il mappe "valeur → liste de lignes". C'est le meme principe que l'index de Google : pour chaque mot, on connait toutes les pages web qui le contiennent.

```
 B-tree vs GIN — difference fondamentale :

 B-tree (index direct) :
 ligne 1 → {sql, postgresql, debutant}
 ligne 2 → {postgresql, performance}
 ligne 3 → {javascript, react}

 Pour chercher "postgresql" : parcourir chaque entree...

 GIN (index inverse) :
 "debutant"    → {ligne 1}
 "javascript"  → {ligne 3}
 "performance" → {ligne 2}
 "postgresql"  → {ligne 1, ligne 2}   ← acces direct !
 "react"       → {ligne 3}
 "sql"         → {ligne 1}

 Pour chercher "postgresql" : acces direct a la liste {ligne 1, ligne 2}
```

> **Analogie** : Un B-tree, c'est comme une liste de courses classee par rayon (rayon 1 : lait, oeufs, beurre). Un GIN, c'est comme un registre alphabetique des ingredients : "beurre → rayon 1, rayon 5 ; oeufs → rayon 1, rayon 3". Si tu cherches un ingredient specifique, le registre alphabetique est beaucoup plus rapide.

### 2.2 GIN pour JSONB

```sql
-- Table avec colonne JSONB
CREATE TABLE evenement (
    id      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type    TEXT NOT NULL,
    data    JSONB NOT NULL DEFAULT '{}'
);

-- Inserer des donnees
INSERT INTO evenement (type, data) VALUES
    ('click', '{"page": "/accueil", "bouton": "inscription", "user_id": 42}'),
    ('view', '{"page": "/produits", "duree_ms": 3200, "user_id": 42}'),
    ('click', '{"page": "/produits", "bouton": "ajouter_panier", "produit_id": 7}'),
    ('achat', '{"montant": 89.99, "produit_ids": [7, 12], "user_id": 42}');

-- Creer un index GIN sur la colonne JSONB
CREATE INDEX idx_evenement_data_gin ON evenement USING GIN (data);

-- Operateurs GIN pour JSONB
-- @> : contient (le document contient cette sous-structure)
SELECT * FROM evenement WHERE data @> '{"page": "/accueil"}';
-- Utilise l'index GIN

-- ? : la cle existe
SELECT * FROM evenement WHERE data ? 'produit_id';
-- Utilise l'index GIN

-- ?| : au moins une des cles existe
SELECT * FROM evenement WHERE data ?| ARRAY['produit_id', 'produit_ids'];

-- ?& : toutes les cles existent
SELECT * FROM evenement WHERE data ?& ARRAY['page', 'bouton'];
```

### 2.3 Classes d'operateurs GIN pour JSONB

| Classe | Operateurs supportes | Taille index | Cas d'usage |
|---|---|---|---|
| `jsonb_ops` (defaut) | `@>`, `?`, `?|`, `?&` | Plus grande | Recherche complete |
| `jsonb_path_ops` | `@>` uniquement | **Plus petite** | Quand seul `@>` est utilise |

```sql
-- Index avec jsonb_path_ops (plus compact)
CREATE INDEX idx_event_data_path ON evenement USING GIN (data jsonb_path_ops);

-- Ne supporte QUE l'operateur @>
SELECT * FROM evenement WHERE data @> '{"user_id": 42}';
-- OK : utilise l'index

SELECT * FROM evenement WHERE data ? 'user_id';
-- ERREUR conceptuelle : jsonb_path_ops ne supporte pas ?
-- → Seq Scan ou utiliser un index jsonb_ops
```

### 2.4 GIN pour les arrays

```sql
-- Table avec colonne array
CREATE TABLE article (
    id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    titre TEXT NOT NULL,
    tags  TEXT[] NOT NULL DEFAULT '{}'
);

INSERT INTO article (titre, tags) VALUES
    ('Intro PostgreSQL', ARRAY['sql', 'postgresql', 'debutant']),
    ('Index avances', ARRAY['postgresql', 'performance', 'index']),
    ('React Hooks', ARRAY['javascript', 'react', 'frontend']);

-- Index GIN sur le tableau
CREATE INDEX idx_article_tags_gin ON article USING GIN (tags);

-- Rechercher les articles contenant un tag specifique
SELECT titre FROM article WHERE tags @> ARRAY['postgresql'];
-- Index Scan using idx_article_tags_gin

-- Rechercher les articles contenant TOUS ces tags
SELECT titre FROM article WHERE tags @> ARRAY['postgresql', 'performance'];

-- Rechercher les articles contenant AU MOINS UN de ces tags
SELECT titre FROM article WHERE tags && ARRAY['react', 'postgresql'];

-- Rechercher les articles dont les tags sont un sous-ensemble
SELECT titre FROM article WHERE tags <@ ARRAY['sql', 'postgresql', 'debutant', 'avance'];
```

### 2.5 GIN pour le full-text search

```sql
-- Colonne tsvector pour la recherche plein texte
CREATE TABLE document (
    id       INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    titre    TEXT NOT NULL,
    contenu  TEXT NOT NULL,
    tsv      tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('french', titre), 'A') ||
        setweight(to_tsvector('french', contenu), 'B')
    ) STORED
);

-- Index GIN sur le tsvector
CREATE INDEX idx_document_tsv_gin ON document USING GIN (tsv);

-- Recherche plein texte
SELECT titre, ts_rank(tsv, query) AS pertinence
FROM document, to_tsquery('french', 'postgresql & index') AS query
WHERE tsv @@ query
ORDER BY pertinence DESC;
-- Utilise l'index GIN pour trouver rapidement les documents
```

### 2.6 Cout en ecriture du GIN

Le GIN a un cout en ecriture plus eleve que le B-tree car chaque valeur composite (JSON, array) peut contenir plusieurs cles a indexer.

```
 INSERT d'un document JSONB avec 10 cles :

 B-tree : 1 entree d'index
 GIN    : 10 entrees d'index (une par cle)
            │
            ▼
       Plus lent en ecriture
```

Pour attenuer ce cout, le GIN utilise une **pending list** :

```sql
-- Le GIN accumule les nouvelles entrees dans une "pending list"
-- en memoire, puis les insere en batch dans l'index
-- Parametre : fastupdate (defaut: on)

CREATE INDEX idx_event_gin ON evenement USING GIN (data)
WITH (fastupdate = on);  -- defaut

-- Desactiver fastupdate pour des lectures plus rapides
-- mais des ecritures plus lentes
CREATE INDEX idx_event_gin ON evenement USING GIN (data)
WITH (fastupdate = off);

-- Vider manuellement la pending list
SELECT gin_clean_pending_list('idx_event_gin');
```

| Aspect | `fastupdate = on` | `fastupdate = off` |
|---|---|---|
| Vitesse INSERT | Rapide (pending list) | Lent (insertion directe) |
| Vitesse SELECT | Peut etre plus lent (scan pending list) | Rapide (index complet) |
| Maintenance | VACUUM vide la pending list | Pas de pending list |
| Recommandation | **Defaut** pour la plupart des cas | Tables rarement modifiees |

---

## 3. GiST (Generalized Search Tree)

### 3.1 Principe : arbre de recherche generalise

Le GiST est un framework d'arbre de recherche **generalise** qui peut indexer des donnees multi-dimensionnelles et des operations de chevauchement.

> **Analogie** : Si le B-tree est un dictionnaire ordonne (une dimension), le GiST est une carte geographique indexee (deux dimensions ou plus). Tu peux chercher "tout ce qui est dans cette zone" ou "tout ce qui chevauche cette periode".

```
 B-tree : recherche sur UN axe
 ──────────|─────|─────────────▶ valeur
           a     b
           WHERE x BETWEEN a AND b

 GiST : recherche sur PLUSIEURS axes
         ▲
  y      │    ┌────────┐
         │    │ zone   │
         │    │ de     │
         │    │recherche│
         │    └────────┘
         └──────────────────────▶ x
         WHERE box OVERLAPS zone
```

### 3.2 Range types (types intervalle)

Les range types sont le cas d'usage ideal du GiST en PostgreSQL pur (sans extension spatiale).

```sql
-- Types range integres a PostgreSQL
-- int4range, int8range, numrange, tsrange, tstzrange, daterange

-- Table de reservations de salle
CREATE TABLE reservation (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    salle       TEXT NOT NULL,
    pendant     tstzrange NOT NULL,
    reserve_par TEXT NOT NULL
);

-- Index GiST sur le range
CREATE INDEX idx_reservation_pendant ON reservation USING GIST (pendant);

-- Inserer des reservations
INSERT INTO reservation (salle, pendant, reserve_par) VALUES
    ('A', '[2024-06-15 09:00, 2024-06-15 11:00)', 'Alice'),
    ('A', '[2024-06-15 14:00, 2024-06-15 16:00)', 'Bob'),
    ('B', '[2024-06-15 10:00, 2024-06-15 12:00)', 'Claire');

-- Trouver les reservations qui chevauchent un creneau
SELECT * FROM reservation
WHERE pendant && '[2024-06-15 10:00, 2024-06-15 11:00)'::tstzrange;
-- Retourne la reservation d'Alice (9h-11h) et Claire (10h-12h)
-- Utilise l'index GiST

-- Operateurs range
-- &&  : overlap (chevauchement)
-- @>  : contains (contient)
-- <@  : contained by (est contenu dans)
-- <<  : strictly left of (strictement avant)
-- >>  : strictly right of (strictement apres)
-- -|- : adjacent (adjacent)
```

### 3.3 Constraint exclusion avec GiST

```sql
-- Empecher les reservations qui se chevauchent pour la meme salle
ALTER TABLE reservation
ADD CONSTRAINT pas_de_chevauchement
EXCLUDE USING GIST (
    salle WITH =,
    pendant WITH &&
);

-- Tentative d'inserer une reservation qui chevauche
INSERT INTO reservation (salle, pendant, reserve_par)
VALUES ('A', '[2024-06-15 10:00, 2024-06-15 12:00)', 'David');
-- ERREUR : conflicting key value violates exclusion constraint
-- Key (salle, pendant)=("A", ["2024-06-15 10:00","2024-06-15 12:00"))
-- conflicts with existing key
```

> **Ce qu'il faut retenir** : Les contraintes d'exclusion avec GiST sont une fonctionnalite unique de PostgreSQL. Elles permettent d'exprimer des regles metier complexes (pas de chevauchement de creneaux, pas de superposition de zones) directement dans la base de donnees, avec des performances garanties par l'index.

### 3.4 GiST pour le full-text search (alternative au GIN)

```sql
-- Index GiST sur tsvector (alternative au GIN)
CREATE INDEX idx_document_tsv_gist ON document USING GIST (tsv);

-- Memes requetes que GIN
SELECT * FROM document WHERE tsv @@ to_tsquery('french', 'postgresql');
```

### 3.5 GiST vs GIN pour le full-text search

| Critere | GIN | GiST |
|---|---|---|
| **Vitesse de recherche** | **Rapide** (index inverse, acces direct) | Plus lent (parcours d'arbre) |
| **Vitesse de creation** | Plus lent (beaucoup d'entrees) | **Plus rapide** |
| **Taille d'index** | Plus grand | **Plus petit** |
| **Vitesse d'insertion** | Plus lent (meme avec fastupdate) | **Plus rapide** |
| **Exact match** | Oui | Peut avoir des faux positifs (recheck) |
| **Recommandation** | **Tables stables** (peu d'INSERT) | Tables avec beaucoup d'INSERT |

> **Ce qu'il faut retenir** : Pour le full-text search en production, **GIN** est generalement le meilleur choix car la vitesse de recherche prime. Utilise GiST si les insertions sont tres frequentes et que la vitesse de recherche est secondaire.

### 3.6 GiST pour la geometrie (PostGIS preview)

```sql
-- Avec l'extension PostGIS installee
-- CREATE EXTENSION postgis;

-- Table de points d'interet
CREATE TABLE poi (
    id      SERIAL PRIMARY KEY,
    nom     TEXT NOT NULL,
    geom    geometry(Point, 4326) NOT NULL
);

-- Index GiST spatial
CREATE INDEX idx_poi_geom ON poi USING GIST (geom);

-- Trouver les POI dans un rayon de 500m autour d'un point
SELECT nom, ST_Distance(geom, ST_MakePoint(2.3522, 48.8566)::geography) AS distance_m
FROM poi
WHERE ST_DWithin(
    geom::geography,
    ST_MakePoint(2.3522, 48.8566)::geography,
    500  -- 500 metres
)
ORDER BY distance_m;
-- L'index GiST accelere enormement les recherches spatiales
```

---

## 4. BRIN (Block Range INdex)

### 4.1 Principe : min/max par bloc de pages

Le BRIN est un type d'index extremement compact qui stocke seulement les valeurs **minimum et maximum** pour chaque **groupe de pages** (bloc) de la table.

> **Analogie** : Imagine un classeur avec 100 tiroirs, chacun contenant 1000 dossiers. Un index BRIN, c'est une etiquette sur chaque tiroir : "Tiroir 1 : dossiers du 01/01 au 15/01, Tiroir 2 : dossiers du 16/01 au 31/01". Pour trouver le dossier du 20/01, tu sais immediatement qu'il est dans le tiroir 2, sans ouvrir les 99 autres.

```
 BRIN vs B-tree — structure :

 B-tree (index complet) :
 ┌───────────────────────────────────────────────────┐
 │  Chaque valeur individuelle est indexee            │
 │  id=1 → page 0, id=2 → page 0, ... id=1M → page 5000 │
 │  Taille : ~200 MB pour 10M de lignes               │
 └───────────────────────────────────────────────────┘

 BRIN (resume par bloc) :
 ┌───────────────────────────────────────────────────┐
 │  Pages 0-127    : min=1,     max=6400              │
 │  Pages 128-255  : min=6401,  max=12800             │
 │  Pages 256-383  : min=12801, max=19200             │
 │  ...                                               │
 │  Taille : ~48 KB pour 10M de lignes                │
 │           ^^^^^^^^ 4000x plus petit que le B-tree ! │
 └───────────────────────────────────────────────────┘
```

### 4.2 Cas d'usage ideal : donnees naturellement ordonnees

Le BRIN est magique quand les donnees physiques sur disque sont **naturellement ordonnees** selon la colonne indexee :

| Type de donnees | Ordonnees physiquement ? | BRIN efficace ? |
|---|---|---|
| **Logs avec timestamp** | Oui (inseres chronologiquement) | **Parfait** |
| **IDs auto-incrementes** | Oui (SERIAL/IDENTITY) | **Parfait** |
| **Time-series (IoT, metriques)** | Oui (inseres dans l'ordre) | **Parfait** |
| **Donnees melangees (random)** | Non | **Inutile** |
| **Donnees frequemment mises a jour** | Non (UPDATE deplace les lignes) | **Inutile** |

```sql
-- Table de logs (donnees chronologiques)
CREATE TABLE log_acces (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    horodatage  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip          INET NOT NULL,
    methode     TEXT NOT NULL,
    url         TEXT NOT NULL,
    status_code SMALLINT NOT NULL
);

-- BRIN sur le timestamp (donnees naturellement ordonnees)
CREATE INDEX idx_log_horodatage_brin ON log_acces USING BRIN (horodatage);

-- Requete : logs de la derniere heure
SELECT * FROM log_acces
WHERE horodatage >= now() - INTERVAL '1 hour'
ORDER BY horodatage DESC;
-- Le BRIN elimine instantanement >99% des blocs de pages
```

### 4.3 Le parametre pages_per_range

Le parametre `pages_per_range` controle le nombre de pages dans chaque "zone" du BRIN.

```sql
-- Defaut : 128 pages par range
CREATE INDEX idx_brin_default ON log_acces USING BRIN (horodatage);
-- → 1 entree d'index pour chaque groupe de 128 pages (~1 MB)

-- Plus precis : 32 pages par range
CREATE INDEX idx_brin_precis ON log_acces USING BRIN (horodatage)
WITH (pages_per_range = 32);
-- → 4x plus d'entrees, mais meilleure precision
-- → index un peu plus grand mais elimine plus de blocs

-- Moins precis : 512 pages par range
CREATE INDEX idx_brin_compact ON log_acces USING BRIN (horodatage)
WITH (pages_per_range = 512);
-- → Index minuscule mais moins de precision
```

```
 Impact de pages_per_range :

 pages_per_range = 32 :
 ┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐...
 │ 1-32 ││33-64 ││65-96 ││97-128││129-..│
 │min/  ││min/  ││min/  ││min/  ││min/  │
 │max   ││max   ││max   ││max   ││max   │
 └──────┘└──────┘└──────┘└──────┘└──────┘
 → Plus precis, plus d'entrees, index un peu plus grand

 pages_per_range = 512 :
 ┌─────────────────────────────────────┐┌──────────...
 │ pages 1-512                         ││ 513-1024
 │ min/max                              ││ min/max
 └─────────────────────────────────────┘└──────────
 → Moins precis, moins d'entrees, index minuscule
```

### 4.4 Quand BRIN est magique et quand il est inutile

```sql
-- BRIN sur des donnees ordonnees : MAGIQUE
-- Table de 100M de lignes de logs

-- Comparaison de taille
SELECT
    indexrelname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS taille
FROM pg_stat_user_indexes
WHERE relname = 'log_acces';

-- idx_log_horodatage_btree : 2.1 GB
-- idx_log_horodatage_brin  : 128 KB  ← 16 000x plus petit !

-- Performance comparable pour les requetes de plage :
EXPLAIN ANALYZE SELECT COUNT(*) FROM log_acces
WHERE horodatage >= '2024-06-01' AND horodatage < '2024-06-02';
-- B-tree : 0.5 ms
-- BRIN   : 2.0 ms (un peu plus lent, mais ENORMEMENT moins d'espace)
```

```sql
-- BRIN sur des donnees aleatoires : INUTILE
CREATE TABLE donnees_random AS
SELECT gen_random_uuid() AS valeur FROM generate_series(1, 1000000);

CREATE INDEX idx_random_brin ON donnees_random USING BRIN (valeur);

EXPLAIN ANALYZE SELECT * FROM donnees_random WHERE valeur = 'some-uuid';
-- BRIN ne peut PAS eliminer de blocs car les UUIDs sont repartis
-- aleatoirement → chaque bloc contient des UUIDs de toute la plage
-- → Seq Scan sera probablement choisi
```

> **Ce qu'il faut retenir** : Le BRIN est extraordinaire pour les donnees qui sont naturellement ordonnees sur disque (time-series, logs, IDs sequentiels). Son ratio taille/performance est imbattable. Mais il est completement inutile pour les donnees aleatoires ou frequemment mises a jour.

### 4.5 Verifier la correlation physique

```sql
-- La colonne "correlation" dans pg_stats indique si les donnees
-- sont physiquement ordonnees sur disque
SELECT
    attname,
    correlation
FROM pg_stats
WHERE tablename = 'log_acces';

-- correlation proche de 1.0 ou -1.0 → donnees ordonnees → BRIN efficace
-- correlation proche de 0.0 → donnees aleatoires → BRIN inutile

-- horodatage : correlation = 0.99 → PARFAIT pour BRIN
-- ip         : correlation = 0.02 → MAUVAIS pour BRIN
```

---

## 5. Covering indexes (INCLUDE)

### 5.1 Principe

Un **covering index** ajoute des colonnes supplementaires dans les **feuilles** de l'index, sans les inclure dans l'arbre de recherche. Cela permet l'**Index Only Scan** meme pour des requetes qui lisent des colonnes non indexees.

```sql
-- Index standard sur (departement_id)
CREATE INDEX idx_emp_dep ON employe(departement_id);

-- Requete qui lit nom et email en plus
SELECT nom, email FROM employe WHERE departement_id = 3;
-- Index Scan (pas Index Only Scan car nom et email ne sont pas dans l'index)
-- → doit aller lire la table (heap) pour obtenir nom et email

-- Covering index avec INCLUDE
CREATE INDEX idx_emp_dep_covering ON employe(departement_id) INCLUDE (nom, email);

-- Meme requete
SELECT nom, email FROM employe WHERE departement_id = 3;
-- Index Only Scan ! (nom et email sont dans les feuilles de l'index)
-- → pas besoin de lire la table
```

```
 Index standard vs Covering index :

 Index standard (departement_id) :
 ┌──────────────────────────────────────────┐
 │ Root: [IT=1] [RH=2] [FIN=3]             │
 │ Leaf: dep=1 → TID(0,1) TID(0,3) TID(1,5)│
 │       dep=2 → TID(0,2) TID(1,1)          │
 │       dep=3 → TID(1,2) TID(1,4)          │
 └──────────────────────────────────────────┘
  → Pour obtenir nom/email : aller lire la table via TID

 Covering index (departement_id) INCLUDE (nom, email) :
 ┌──────────────────────────────────────────────────────────┐
 │ Root: [IT=1] [RH=2] [FIN=3]                              │
 │ Leaf: dep=1 → TID(0,1), nom="Alice", email="alice@..."   │
 │               TID(0,3), nom="Bob",   email="bob@..."     │
 │       dep=2 → TID(0,2), nom="Claire",email="claire@..."  │
 │       dep=3 → TID(1,2), nom="David", email="david@..."   │
 └──────────────────────────────────────────────────────────┘
  → nom et email sont DANS l'index → Index Only Scan
```

### 5.2 INCLUDE vs index multi-colonnes

| Aspect | `INDEX ON (a, b, c)` | `INDEX ON (a) INCLUDE (b, c)` |
|---|---|---|
| Colonnes dans l'arbre | a, b, c | a uniquement |
| Colonnes dans les feuilles | a, b, c | a, b, c |
| `WHERE a = 1 AND b = 2` | Utilise a ET b | Utilise a uniquement |
| `WHERE b = 2` | Non (leftmost prefix) | Non |
| Index Only Scan pour `SELECT b, c` | Oui | Oui |
| Taille de l'index | Plus grand (arbre plus profond) | **Plus petit** (arbre compact) |
| Tri sur b | Oui (`ORDER BY a, b`) | Non (b n'est pas dans l'arbre) |

> **Ce qu'il faut retenir** : Utilise `INCLUDE` quand tu veux un Index Only Scan mais que les colonnes supplementaires ne sont **pas utilisees pour le filtrage ou le tri**. Le covering index est plus compact qu'un index multi-colonnes complet.

### 5.3 INCLUDE avec index unique

```sql
-- Index unique sur email, avec nom et poste inclus
CREATE UNIQUE INDEX idx_emp_email_unique ON employe(email) INCLUDE (nom, poste);

-- La contrainte d'unicite est sur email uniquement
-- Mais les requetes qui lisent nom et poste beneficient de l'Index Only Scan
SELECT nom, poste FROM employe WHERE email = 'alice@example.com';
-- Index Only Scan !
```

---

## 6. Partial indexes avec types avances

### 6.1 Index partiel GIN

```sql
-- Index GIN seulement sur les documents publies
CREATE INDEX idx_doc_tsv_publie ON document USING GIN (tsv)
WHERE est_publie = true;

-- Utilise l'index (condition matche)
SELECT titre FROM document
WHERE tsv @@ to_tsquery('french', 'postgresql')
  AND est_publie = true;

-- N'utilise PAS l'index (condition differente)
SELECT titre FROM document
WHERE tsv @@ to_tsquery('french', 'postgresql')
  AND est_publie = false;
```

### 6.2 Index partiel BRIN

```sql
-- BRIN seulement sur les logs recents (30 derniers jours)
-- Utile si les logs anciens sont rarement requetes
CREATE INDEX idx_log_recent_brin ON log_acces USING BRIN (horodatage)
WHERE horodatage >= now() - INTERVAL '30 days';
-- ATTENTION : cet index devient obsolete avec le temps
-- Il faudrait le recreer periodiquement ou utiliser une approche differente
```

### 6.3 Combinaison expression + partiel

```sql
-- Index sur l'heure uniquement, pour les logs d'erreur
CREATE INDEX idx_log_erreur_heure ON log_acces (
    EXTRACT(HOUR FROM horodatage)
)
WHERE status_code >= 500;

-- Requete : erreurs 500 entre 2h et 5h du matin
SELECT * FROM log_acces
WHERE status_code >= 500
  AND EXTRACT(HOUR FROM horodatage) BETWEEN 2 AND 5;
-- Utilise l'index partiel + expression
```

---

## 7. Tableau comparatif complet

### 7.1 B-tree vs Hash vs GIN vs GiST vs BRIN

| Critere | B-tree | Hash | GIN | GiST | BRIN |
|---|---|---|---|---|---|
| **Type de donnees** | Scalaire | Scalaire | Composite (JSON, array, tsvector) | Range, geometrie, tsvector | Scalaire ordonne |
| **Egalite** (`=`) | Oui | **Optimise** | Via `@>` | Via `@>` | Oui (imprecis) |
| **Plage** (`<`, `>`) | **Oui** | Non | Non | **Oui** (ranges) | **Oui** |
| **Contient** (`@>`) | Non | Non | **Oui** | **Oui** | Non |
| **Chevauche** (`&&`) | Non | Non | Non | **Oui** | Non |
| **Full-text** (`@@`) | Non | Non | **Oui** | Oui (plus lent) | Non |
| **ORDER BY** | **Oui** | Non | Non | Non | Non |
| **Taille** | Moyenne | Petite | **Grande** | Moyenne | **Minuscule** |
| **Vitesse INSERT** | Rapide | Rapide | **Lent** | Moyen | **Tres rapide** |
| **Vitesse SELECT** | Rapide | Tres rapide (=) | Rapide (composite) | Moyen | Moyen |
| **Multi-colonnes** | Oui | Non | Oui | Oui | Oui |
| **Index partiel** | Oui | Oui | Oui | Oui | Oui |
| **INCLUDE** | Oui (PG11+) | Non | Non | Non | Non |
| **Cas d'usage** | Polyvalent, defaut | Egalite sur longues chaines | JSONB, arrays, FTS | Ranges, geometrie, exclusion | Time-series, logs |

### 7.2 Arbre de decision

```
 Comment choisir le bon index ?

 1. Est-ce une colonne scalaire avec des comparaisons simples ?
    OUI → B-tree (ou Hash si egalite uniquement)

 2. Est-ce une colonne JSONB et tu utilises @>, ?, ?| ?
    OUI → GIN (avec jsonb_ops ou jsonb_path_ops)

 3. Est-ce une colonne array et tu utilises @>, && ?
    OUI → GIN

 4. Est-ce du full-text search (tsvector @@ tsquery) ?
    OUI → GIN (recherche rapide) ou GiST (insertions rapides)

 5. Est-ce un range type et tu cherches des chevauchements ?
    OUI → GiST

 6. As-tu besoin d'une contrainte d'exclusion (EXCLUDE) ?
    OUI → GiST

 7. Est-ce une colonne naturellement ordonnee (timestamp, serial) ?
    OUI → BRIN (index minuscule, parfait pour time-series)

 8. Est-ce une colonne rarement modifiee que tu veux couvrir
    pour un Index Only Scan ?
    OUI → INCLUDE sur un B-tree existant
```

---

## 8. Node.js : utiliser les index avances

```javascript
// fichier : index-avances.mjs
// Demonstration des index avances avec pg

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'cours',
  user: 'postgres',
  password: 'postgres',
});

// Recherche JSONB avec index GIN
async function rechercherEvenements(criteres) {
  // criteres est un objet JSON que l'on cherche avec @>
  const { rows } = await pool.query(
    `SELECT id, type, data
     FROM evenement
     WHERE data @> $1::jsonb
     ORDER BY id DESC
     LIMIT 20`,
    [JSON.stringify(criteres)]
  );
  return rows;
}

// Recherche full-text avec index GIN
async function rechercherDocuments(terme) {
  const { rows } = await pool.query(
    `SELECT
       id,
       titre,
       ts_headline('french', contenu, query,
         'StartSel=<b>, StopSel=</b>, MaxWords=35, MinWords=15'
       ) AS extrait,
       ts_rank(tsv, query) AS pertinence
     FROM document,
       to_tsquery('french', $1) AS query
     WHERE tsv @@ query
     ORDER BY pertinence DESC
     LIMIT 10`,
    [terme]
  );
  return rows;
}

// Recherche de disponibilite avec index GiST (ranges)
async function verifierDisponibilite(salle, debut, fin) {
  const { rows } = await pool.query(
    `SELECT *
     FROM reservation
     WHERE salle = $1
       AND pendant && tstzrange($2::timestamptz, $3::timestamptz)`,
    [salle, debut, fin]
  );

  if (rows.length === 0) {
    console.log(`Salle ${salle} disponible de ${debut} a ${fin}`);
    return true;
  } else {
    console.log(`Salle ${salle} occupee : ${rows.length} reservations conflictuelles`);
    return false;
  }
}

// Recherche dans les logs avec index BRIN
async function logsRecents(depuisMinutes = 60) {
  const { rows } = await pool.query(
    `SELECT
       horodatage,
       ip,
       methode,
       url,
       status_code
     FROM log_acces
     WHERE horodatage >= now() - make_interval(mins := $1)
     ORDER BY horodatage DESC
     LIMIT 100`,
    [depuisMinutes]
  );
  return rows;
}

// Diagnostiquer les index
async function diagnosticIndex() {
  const { rows } = await pool.query(`
    SELECT
      c.relname AS table_name,
      i.relname AS index_name,
      am.amname AS index_type,
      pg_size_pretty(pg_relation_size(i.oid)) AS taille,
      s.idx_scan AS nb_scans,
      s.idx_tup_read AS tuples_lus,
      CASE
        WHEN s.idx_scan = 0 THEN 'INUTILISE'
        WHEN s.idx_scan < 10 THEN 'PEU UTILISE'
        ELSE 'ACTIF'
      END AS statut
    FROM pg_index idx
    JOIN pg_class i ON i.oid = idx.indexrelid
    JOIN pg_class c ON c.oid = idx.indrelid
    JOIN pg_am am ON am.oid = i.relam
    LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.oid
    WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    ORDER BY am.amname, c.relname
  `);

  // Regrouper par type
  const parType = {};
  for (const r of rows) {
    if (!parType[r.index_type]) parType[r.index_type] = [];
    parType[r.index_type].push(r);
  }

  for (const [type, indices] of Object.entries(parType)) {
    console.log(`\n=== Index ${type.toUpperCase()} ===`);
    for (const idx of indices) {
      console.log(
        `  [${idx.statut}] ${idx.index_name} ` +
        `(${idx.table_name}) — ${idx.taille}, ${idx.nb_scans} scans`
      );
    }
  }
}

async function main() {
  try {
    // Recherche JSONB
    const events = await rechercherEvenements({ user_id: 42 });
    console.log('Evenements user 42 :', events.length);

    // Full-text search
    const docs = await rechercherDocuments('postgresql & performance');
    console.log('Documents trouves :', docs.length);

    // Disponibilite salle
    await verifierDisponibilite('A', '2024-06-15 10:00', '2024-06-15 12:00');

    // Diagnostic
    await diagnosticIndex();
  } finally {
    await pool.end();
  }
}

main();
```

---

## 9. Exercice mental

1. **Tu as une table `evenement` avec une colonne `data JSONB`. Tu fais souvent `WHERE data @> '{"user_id": 42}'`. Quel index creer ?** (GIN avec `jsonb_path_ops` car seul `@>` est utilise, et cet index est plus compact)

2. **Tu as une table de 500M de lignes de logs avec un timestamp. Un index B-tree sur le timestamp fait 10 GB. Comment reduire a quelques KB ?** (BRIN : les donnees sont naturellement ordonnees par timestamp)

3. **Tu veux empecher deux evenements dans la meme salle au meme creneau horaire. Comment faire cela au niveau de la base ?** (Constraint EXCLUDE USING GIST avec `salle WITH =, creneau WITH &&`)

4. **Ta requete fait un Index Scan mais pas un Index Only Scan. Le SELECT lit `nom` et `email` en plus de `departement_id`. Comment obtenir un Index Only Scan ?** (Creer un covering index : `CREATE INDEX ... ON table(departement_id) INCLUDE (nom, email)`)

5. **Tu as un index GIN sur une colonne JSONB. Les INSERT sont lents. Que faire ?** (Verifier que `fastupdate = on` est active, ou si les performances en lecture sont critiques, accepter le cout en ecriture. Eventuellement, utiliser `jsonb_path_ops` pour un index plus petit)

---

## 10. Resume : quand utiliser chaque type d'index

```
 ┌─────────────────────────────────────────────────────────────┐
 │                                                             │
 │  B-tree   → Choix par defaut. Egalite, plage, tri, unicite │
 │                                                             │
 │  Hash     → Egalite uniquement sur de longues valeurs       │
 │                                                             │
 │  GIN      → JSONB, arrays, full-text search                 │
 │             Recherche "contient" dans des valeurs composites │
 │                                                             │
 │  GiST     → Ranges (chevauchement), geometrie (PostGIS)    │
 │             Contraintes d'exclusion (EXCLUDE)                │
 │             Alternative au GIN pour le full-text             │
 │                                                             │
 │  BRIN     → Donnees naturellement ordonnees (time-series)   │
 │             Index minuscule, ideal pour les grosses tables   │
 │                                                             │
 │  INCLUDE  → Ajouter des colonnes pour Index Only Scan       │
 │             Se combine avec B-tree (et uniquement B-tree)   │
 │                                                             │
 └─────────────────────────────────────────────────────────────┘
```

---

## Navigation

| | Lien |
|---|---|
| Module precedent | [Module 06 — Le Query Planner](./06-query-planner.md) |
| Module suivant | [Module 08 — Niveaux d'isolation](./08-niveaux-isolation.md) |
| Lab associe | [Lab 07 — Index avances en pratique](../labs/lab-07.md) |

---

> **Ce qu'il faut retenir** : PostgreSQL offre une palette d'index specialises pour chaque type de donnees et de requete. Le GIN excelle pour les donnees composites (JSONB, arrays, full-text). Le GiST est le choix pour les ranges et la geometrie. Le BRIN offre un ratio taille/performance imbattable pour les time-series. Les covering indexes avec INCLUDE permettent l'Index Only Scan sans alourdir l'arbre de recherche. Choisis le bon index en fonction de tes donnees et de tes requetes, pas par habitude.
