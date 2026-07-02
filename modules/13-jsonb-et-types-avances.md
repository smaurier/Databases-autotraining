---
titre: JSONB et types avancés
cours: 10-postgresql
notions: [JSONB vs JSON, opérateurs jsonb flèche et contenance, jsonpath, index GIN sur jsonb, recherche plein texte tsvector et tsquery, tableaux PostgreSQL, types énumérés et composites, JSONB vs modèle relationnel]
outcomes: [stocker et interroger du JSONB avec les bons opérateurs, indexer du JSONB en GIN, faire de la recherche plein texte, choisir JSONB ou relationnel selon le cas]
prerequis: [12-fonctions-avancees-sql]
next: 14-securite-et-administration
libs: [{ name: postgresql, version: "17" }]
tribuzen: stocker les métadonnées flexibles des posts TribuZen en JSONB et rechercher dans le journal (full-text)
last-reviewed: 2026-07
---

# JSONB et types avancés

> **Outcomes — tu sauras FAIRE :** stocker et interroger du JSONB avec les bons opérateurs (`->`, `->>`, `@>`, `?`), indexer une colonne JSONB avec GIN et mesurer le gain avec EXPLAIN ANALYZE, faire de la recherche plein texte en français avec `tsvector` et `tsquery`, choisir entre JSONB et colonnes relationnelles selon le cas d'usage.
> **Difficulté :** :star::star::star:

## 1. Cas concret d'abord

Dans TribuZen, chaque post peut avoir une structure différente selon la famille et l'usage : un post « événement » porte une date et un lieu, un post « épinglé » porte l'auteur et la date d'épinglage, un post « simple » porte des réactions. L'équipe a d'abord ajouté des colonnes séparées — `is_event`, `event_date`, `event_location`, `is_pinned`, `pinned_by`, `reaction_count` — et après trois migrations, la table `posts` avait onze colonnes nullable dont la grande majorité sont à `NULL` pour 90 % des lignes.

```sql
-- Avant : colonnes clairsemées — signal d'un modèle mal ajusté
SELECT is_event, event_date, event_location, is_pinned, pinned_by, reaction_count
FROM posts WHERE id = 1;
-- is_event | event_date | event_location | is_pinned | pinned_by | reaction_count
--  NULL    |   NULL     |     NULL       |   NULL    |   NULL    |      NULL

-- Après : une colonne metadata JSONB, chaque post porte ce dont il a besoin
SELECT metadata FROM posts WHERE id = 1;
-- {"type": "pinned", "pinned_by": 42, "reactions": {"heart": 3, "laugh": 1}}
```

Deuxième problème : la page journal permet de chercher dans les posts par mots-clés. La requête `WHERE content ILIKE '%vacances%'` fonctionne sur 500 posts, pas sur 80 000 — Seq Scan systématique, aucun stemming (« vacancier » ne matche pas « vacances »), aucun classement par pertinence. Le **Full-Text Search** PostgreSQL résout les trois points avec `tsvector`, `tsquery` et un index GIN.

## 2. Théorie complète, concise

### JSON vs JSONB

PostgreSQL propose deux types pour stocker du JSON :

| Critère | JSON | JSONB |
|---|---|---|
| Stockage | Texte brut (tel quel) | Binaire décomposé |
| Ordre des clés / doublons | Préservés | Triés, dernier doublon gagne |
| Indexation GIN | Non | **Oui** |
| Opérateurs de contenance | Limités | **Complets** |
| Vitesse de lecture | Re-parsing à chaque lecture | **Rapide** (déjà parsé) |
| Vitesse d'écriture | Plus rapide | Légèrement plus lent |

**Règle :** toujours utiliser **JSONB** sauf besoin exceptionnel de préserver le formatage exact (audit, conformité légale).

```sql
-- Différence visible : ordre des clés
SELECT '{"b": 2, "a": 1}'::json;    -- {"b": 2, "a": 1}   (préservé)
SELECT '{"b": 2, "a": 1}'::jsonb;   -- {"a": 1, "b": 2}   (trié alphabétiquement)

-- JSONB ignore les doublons : la dernière valeur gagne
SELECT '{"x": 1, "x": 2}'::jsonb;  -- {"x": 2}
```

### Opérateurs flèche (extraction)

| Opérateur | Retourne | Exemple | Résultat |
|---|---|---|---|
| `->` | JSONB | `metadata->'reactions'` | `{"heart": 3, "laugh": 1}` |
| `->>` | TEXT | `metadata->>'type'` | `pinned` (sans guillemets) |
| `#>` | JSONB (chemin) | `metadata#>'{reactions,heart}'` | `3` |
| `#>>` | TEXT (chemin) | `metadata#>>'{reactions,heart}'` | `3` (texte) |

```sql
-- Clé simple : extraire le type en texte
SELECT metadata->>'type' AS type_post FROM posts LIMIT 5;

-- Chemin imbriqué : nombre de cœurs
SELECT id, metadata#>>'{reactions,heart}' AS hearts FROM posts;

-- Piège : -> retourne JSONB, pas un entier — comparer avec un nombre exige un cast
-- ❌ échoue : operator does not exist: jsonb > integer
SELECT * FROM posts WHERE metadata->'reactions'->'heart' > 2;

-- ✅ correct : extraire en TEXT puis caster
SELECT * FROM posts WHERE (metadata#>>'{reactions,heart}')::int > 2;
```

### Opérateurs de contenance et d'existence

| Opérateur | Signification | Exemple |
|---|---|---|
| `@>` | Contient le document | `metadata @> '{"type": "event"}'` |
| `<@` | Est contenu dans | `'{"type": "event"}' <@ metadata` |
| `?` | Clé existe (toute valeur) | `metadata ? 'event_date'` |
| `?\|` | Au moins une clé existe | `metadata ?\| array['event_date','location']` |
| `?&` | Toutes les clés existent | `metadata ?& array['type','reactions']` |

```sql
-- Posts de type 'event'
SELECT id, content FROM posts WHERE metadata @> '{"type": "event"}';

-- Posts ayant la clé 'event_date' (peu importe la valeur)
SELECT id FROM posts WHERE metadata ? 'event_date';

-- Posts ayant à la fois 'reactions' ET 'type'
SELECT id FROM posts WHERE metadata ?& array['reactions', 'type'];
```

### jsonpath (PostgreSQL 12+)

`jsonpath` est un langage de chemin natif, plus expressif pour les conditions sur les valeurs.

| Opérateur / fonction | Description |
|---|---|
| `@?` | Au moins un élément du chemin existe |
| `@@` | Le chemin évalue à true (prédicat booléen) |
| `jsonb_path_query(j, path)` | Retourne les éléments qui matchent |
| `jsonb_path_exists(j, path)` | Booléen : au moins un élément existe |

```sql
-- @? : la clé reactions.heart existe-t-elle dans ce document ?
SELECT id FROM posts WHERE metadata @? '$.reactions.heart';

-- @@ : le nombre de cœurs est-il supérieur à 5 ?
SELECT id FROM posts WHERE metadata @@ '$.reactions.heart > 5';

-- jsonb_path_query : extraire tous les types de réactions disponibles
SELECT jsonb_path_query(metadata, '$.reactions.keyvalue().key') AS reaction_type
FROM posts WHERE metadata ? 'reactions'
LIMIT 10;

-- Filtre sur un tableau JSONB : posts ayant le tag 'voyage' dans metadata.tags
-- (metadata = {"tags": ["voyage", "famille"]})
SELECT id FROM posts WHERE metadata @? '$.tags[*] ? (@ == "voyage")';
```

### Index GIN sur JSONB

Sans index, l'opérateur `@>` force un **Seq Scan** sur toute la table. Un index GIN stocke une entrée par clé/valeur de chaque document — les opérateurs de contenance deviennent quasi-instantanés.

```sql
-- GIN standard (jsonb_ops) : supporte @>, ?, ?|, ?&
CREATE INDEX idx_posts_metadata ON posts USING GIN (metadata);

-- GIN path_ops : plus compact (~30 % moins grand), supporte @> uniquement
CREATE INDEX idx_posts_metadata_path ON posts USING GIN (metadata jsonb_path_ops);

-- Index sur expression extraite (B-tree classique, pour les comparaisons numériques)
CREATE INDEX idx_posts_hearts ON posts (((metadata#>>'{reactions,heart}')::int));
```

**Règle de choix :**
- Seul `@>` est utilisé → `jsonb_path_ops` (plus compact, ~30 % plus petit)
- `?`, `?|`, `?&` aussi → `jsonb_ops` (défaut)
- Comparaison numérique/texte sur une clé précise → index sur expression B-tree

### Recherche plein texte — tsvector et tsquery

| Concept | Rôle |
|---|---|
| `tsvector` | Document indexé : lexèmes normalisés avec positions et poids |
| `tsquery` | Requête : opérateurs logiques sur lexèmes normalisés |
| `@@` | Match : `tsvector @@ tsquery` → booléen |
| `to_tsvector(lang, text)` | Convertit du texte en tsvector avec stemming + stop words |
| `to_tsquery(lang, expr)` | Convertit une expression formelle en tsquery |
| `websearch_to_tsquery(lang, text)` | Syntaxe naturelle (Google-like) → tsquery |

```sql
-- to_tsvector : stemming + suppression des stop words
SELECT to_tsvector('french', 'Les enfants partaient en vacances à la montagne');
-- 'enfant':2 'montagne':9 'part':3 'vacanc':6
-- "Les", "en", "à", "la" → stop words supprimés
-- "partaient" → "part", "vacances" → "vacanc" (stemming français)

-- to_tsquery : normalise aussi les termes de la requête
SELECT to_tsquery('french', 'vacance & enfant');
-- 'vacanc' & 'enfant'   ← normalisé côté requête aussi

-- Match : les deux côtés sont normalisés → "vacances" et "vacanc" matchent
SELECT to_tsvector('french', 'Départ en vacances demain')
    @@ to_tsquery('french', 'vacance');
-- true

-- websearch_to_tsquery : syntaxe naturelle pour les utilisateurs finaux
-- 'vacances montagne'  →  'vacanc' & 'montagne'
-- '"repas de famille"' →  'repas' <-> 'famil'   (phrase)
-- 'vacances -plage'    →  'vacanc' & !'plage'
SELECT id FROM posts
WHERE search_vector @@ websearch_to_tsquery('french', 'vacances montagne');
```

**Colonne TSVECTOR générée (recommandé) :**

```sql
-- Colonne TSVECTOR générée : PostgreSQL la maintient automatiquement
ALTER TABLE posts ADD COLUMN search_vector TSVECTOR
    GENERATED ALWAYS AS (
        setweight(to_tsvector('french', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('french', coalesce(content, '')), 'B')
    ) STORED;

-- Index GIN sur la colonne générée
CREATE INDEX idx_posts_fts ON posts USING GIN (search_vector);
```

`setweight` donne un poids aux sources (`A` > `B` > `C` > `D`) — `ts_rank` en tient compte pour le classement. PostgreSQL met à jour `search_vector` à chaque INSERT/UPDATE sans trigger.

**ts_rank et ts_headline :**

```sql
-- Classement par pertinence
SELECT id, content,
    ts_rank(search_vector, websearch_to_tsquery('french', 'vacances')) AS score
FROM posts
WHERE search_vector @@ websearch_to_tsquery('french', 'vacances')
ORDER BY score DESC
LIMIT 20;

-- Extrait mis en forme pour l'UI
SELECT id,
    ts_headline('french', content,
        websearch_to_tsquery('french', 'vacances'),
        'StartSel=<mark>, StopSel=</mark>, MaxWords=30, MinWords=15'
    ) AS extrait
FROM posts
WHERE search_vector @@ websearch_to_tsquery('french', 'vacances');
```

### Tableaux PostgreSQL

Pour les listes ordonnées de valeurs scalaires homogènes, PostgreSQL offre des colonnes tableau natives.

```sql
-- Colonne TEXT[]
ALTER TABLE posts ADD COLUMN tag_list TEXT[] NOT NULL DEFAULT '{}';

-- Opérateurs sur tableau
SELECT id FROM posts WHERE tag_list @> ARRAY['voyage'];          -- contient 'voyage'
SELECT id FROM posts WHERE tag_list && ARRAY['voyage', 'sport']; -- au moins un des deux

-- unnest() : décomposer en lignes
SELECT id, unnest(tag_list) AS tag FROM posts;

-- array_agg() : agréger des lignes en tableau
SELECT array_agg(DISTINCT tag ORDER BY tag) AS all_tags
FROM posts, unnest(tag_list) AS tag;

-- GIN sur tableau (mêmes opérateurs @>, <@, &&)
CREATE INDEX idx_posts_tag_list ON posts USING GIN (tag_list);
```

**JSONB vs tableau natif :** si les tags sont une liste plate de chaînes sans attributs, `TEXT[]` avec GIN est plus simple et plus compact. Si les tags ont des attributs ou des métadonnées (`{"voyage": {"region": "europe"}}`), JSONB.

### Types énumérés et composites

**Enum** — valeurs prédéfinies, contrôle strict, stockage compact :

```sql
CREATE TYPE post_status AS ENUM ('draft', 'published', 'archived', 'pinned');

ALTER TABLE posts ADD COLUMN status post_status NOT NULL DEFAULT 'draft';

-- PostgreSQL rejette les valeurs non définies
UPDATE posts SET status = 'deleted';
-- ERROR: invalid input value for enum post_status: "deleted"

-- Tri naturel dans l'ordre de déclaration
SELECT id FROM posts WHERE status > 'draft' ORDER BY status;
-- retourne : published, archived, pinned (dans cet ordre)
```

**Type composite** — regrouper des champs apparentés en un seul type :

```sql
CREATE TYPE event_location AS (
    city    TEXT,
    country TEXT,
    lat     NUMERIC(9,6),
    lng     NUMERIC(9,6)
);

ALTER TABLE posts ADD COLUMN location event_location;

INSERT INTO posts (content, location)
VALUES ('Week-end à Lyon', ROW('Lyon', 'France', 45.7640, 4.8357));

-- Accès avec la notation point (parenthèses obligatoires pour lever l'ambiguïté)
SELECT (location).city, (location).lat FROM posts WHERE (location).country = 'France';
```

**Règle :** `ENUM` quand la liste de valeurs est fermée et rarement étendue (statuts, rôles, types) ; type composite pour des champs structurés qui voyagent ensemble et ne nécessitent pas de jointure.

### JSONB vs modèle relationnel

JSONB complète le modèle relationnel — il ne le remplace pas.

| Situation | Recommandation |
|---|---|
| Données dont le schéma est **connu et stable** | Colonnes relationnelles |
| Données qui **varient par enregistrement** | JSONB |
| Données **liées** à d'autres tables via FK | Colonnes relationnelles |
| Données **comparées ou triées** fréquemment | Colonnes relationnelles (index B-tree) |
| Attributs **extensibles** reçus d'une API tierce | JSONB |
| Tags ou liste de valeurs simples | `TEXT[]` ou table de liaison |

Anti-patterns à éviter :
- Mettre `user_id` ou `family_id` dans JSONB pour éviter une migration → perd les FK, rend les jointures impossibles.
- Requêter JSONB sans index GIN → Seq Scan systématique dès que la table grossit.
- Stocker dans JSONB des données mises à jour colonne par colonne → `jsonb_set` sur chaque clé est moins efficace qu'un UPDATE classique sur une colonne.

## 3. Worked examples

### Exemple A — Métadonnées flexibles des posts TribuZen

Schéma et données :

```sql
CREATE TABLE posts (
    id         BIGSERIAL PRIMARY KEY,
    family_id  INT NOT NULL,
    author_id  INT NOT NULL,
    content    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'published',
    metadata   JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trois types de posts avec des structures différentes
INSERT INTO posts (family_id, author_id, content, metadata) VALUES
    (1, 42, 'Week-end à Lyon ce samedi !',
     '{"type": "event", "event_date": "2026-07-19", "location": "Lyon", "rsvp_count": 5}'),
    (1, 7, 'Bon anniversaire Maman !',
     '{"type": "simple", "reactions": {"heart": 12, "cake": 3}}'),
    (1, 42, 'Règles de la tribu TribuZen',
     '{"type": "pinned", "pinned_by": 42, "pinned_at": "2026-06-01T08:00:00Z"}');
```

```sql
-- 1. Posts de type 'event' avec leur date
SELECT id, content, metadata->>'event_date' AS date_ev
FROM posts
WHERE metadata @> '{"type": "event"}';

-- 2. Posts avec plus de 5 cœurs (chemin imbriqué + cast)
SELECT id, content, (metadata#>>'{reactions,heart}')::int AS hearts
FROM posts
WHERE (metadata#>>'{reactions,heart}')::int > 5;

-- 3. Posts ayant une localisation (clé présente, quelle que soit la valeur)
SELECT id FROM posts WHERE metadata ? 'location';

-- 4. Mettre à jour une clé sans toucher les autres
UPDATE posts
SET metadata = jsonb_set(metadata, '{rsvp_count}', '6'::jsonb)
WHERE metadata @> '{"type": "event"}' AND id = 1;

-- 5. Fusionner des clés (|| : les clés existantes sont écrasées)
UPDATE posts
SET metadata = metadata || '{"reactions": {"heart": 13, "cake": 3}}'::jsonb
WHERE id = 2;

-- 6. jsonpath : posts avec un événement après le 1er août 2026
SELECT id, content
FROM posts
WHERE metadata @? '$.event_date ? (@ >= "2026-08-01")';
```

Ajout de l'index GIN et mesure du gain :

```sql
-- Sans GIN : Seq Scan sur 80 000 posts
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM posts WHERE metadata @> '{"type": "event"}';
-- Seq Scan on posts  Filter: (metadata @> ...)  Execution Time: ~900 ms

-- Créer le GIN (jsonb_path_ops : seul @> est utilisé)
CREATE INDEX CONCURRENTLY idx_posts_metadata_gin
    ON posts USING GIN (metadata jsonb_path_ops);
ANALYZE posts;

-- Avec GIN : Bitmap Index Scan
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM posts WHERE metadata @> '{"type": "event"}';
-- Bitmap Index Scan on idx_posts_metadata_gin  Execution Time: ~2 ms
```

Pas-à-pas : (1) `jsonb_path_ops` est choisi car seul `@>` est utilisé — index ~30 % plus compact que `jsonb_ops` ; (2) pour les opérateurs `?`, `?|`, `?&`, recréer sans la classe d'opérateur (défaut = `jsonb_ops`) ; (3) `jsonb_set` modifie une clé sans re-parser tout le document — troisième argument `true` crée le chemin s'il est absent ; (4) `||` fusionne les documents JSONB — les clés en conflit prennent la valeur du côté droit ; (5) `jsonpath @?` filtre sur les valeurs sans extraire en TEXT.

### Exemple B — Recherche plein texte dans le journal TribuZen

Contexte : la barre de recherche du journal doit gérer le stemming français, classer par pertinence et surligner les extraits dans l'UI.

```sql
-- Ajouter la colonne TSVECTOR générée
ALTER TABLE posts ADD COLUMN search_vector TSVECTOR
    GENERATED ALWAYS AS (
        to_tsvector('french', coalesce(content, ''))
    ) STORED;

-- Index GIN sur la colonne générée
CREATE INDEX idx_posts_search ON posts USING GIN (search_vector);

ANALYZE posts;
```

```sql
-- Données : posts avec du contenu en français
INSERT INTO posts (family_id, author_id, content, metadata) VALUES
    (1, 7, 'Nous partons en vacances à la montagne cet été. Les enfants sont impatients !',
     '{"type": "simple"}'),
    (1, 42, 'Organisation du repas familial de Noël. Qui apporte le dessert ?',
     '{"type": "event"}'),
    (1, 9, 'Photos des vacances à la plage. Quel beau soleil cet été !',
     '{"type": "simple"}');
```

```sql
-- Recherche simple : "vacances" trouve aussi les formes voisines via stemming
SELECT id, content,
    ts_rank(search_vector, websearch_to_tsquery('french', 'vacances')) AS score
FROM posts
WHERE search_vector @@ websearch_to_tsquery('french', 'vacances')
ORDER BY score DESC;

-- Opérateurs tsquery avancés
-- & = ET,  | = OU,  ! = NON,  <-> = adjacence (phrase)
SELECT id FROM posts
WHERE search_vector @@ to_tsquery('french', 'vacanc & montagne');

SELECT id FROM posts
WHERE search_vector @@ to_tsquery('french', 'vacanc & !plage');

-- websearch_to_tsquery : saisie utilisateur brute sans syntaxe formelle
SELECT id FROM posts
WHERE search_vector @@ websearch_to_tsquery('french', 'vacances -plage');

-- Extrait mis en forme pour l'UI React
SELECT
    id,
    ts_headline('french', content,
        websearch_to_tsquery('french', 'vacances'),
        'StartSel=<mark>, StopSel=</mark>, MaxWords=30, MinWords=15, HighlightAll=false'
    ) AS extrait
FROM posts
WHERE search_vector @@ websearch_to_tsquery('french', 'vacances')
ORDER BY ts_rank(search_vector, websearch_to_tsquery('french', 'vacances')) DESC;
```

Pas-à-pas : (1) `GENERATED ALWAYS AS ... STORED` — PostgreSQL met à jour `search_vector` à chaque INSERT/UPDATE sans trigger ; (2) `to_tsvector('french', ...)` réduit « vacances » → « vacanc » et « partaient » → « part » — la requête `websearch_to_tsquery` fait le même stemming côté requête, donc les deux côtés se rejoignent ; (3) `websearch_to_tsquery` tolère la saisie brute des utilisateurs (espaces = `&`, tiret = `!`, guillemets = phrase) — à préférer à `to_tsquery` pour les inputs UI ; (4) `ts_headline` s'appelle sur la colonne **texte** (`content`), pas sur `search_vector` — elle génère l'extrait à partir du texte original en ne balisant que les termes trouvés.

## 4. Pièges & misconceptions

- **`->` vs `->>` — type mismatch.** `metadata->'heart' > 2` échoue : `->` retourne du JSONB, pas un entier. *Correct* : extraire en TEXT et caster — `(metadata->>'heart')::int > 2` — ou utiliser jsonpath `metadata @@ '$.heart > 2'`.

- **`@>` vs `?` — usage inversé.** `metadata @> '{"k": null}'` cherche la clé `k` avec la valeur `null`. `metadata ? 'k'` cherche la clé `k` quelle que soit sa valeur (y compris `null`). *Correct* : utiliser `?` pour tester l'existence d'une clé, `@>` pour tester une valeur précise.

- **GIN sans `fastupdate` sur une table très écrite.** Un document JSONB à 10 clés génère 10 entrées d'index par INSERT. *Correct* : `fastupdate = on` (défaut) tamponne les entrées — vérifier que ce paramètre n'a pas été désactivé ; regrouper les INSERTs en batch en production.

- **jsonpath `@?` non couvert par `jsonb_ops`.** `metadata @? '$.type'` n'utilise pas un GIN `jsonb_ops`. *Correct* : pour les opérateurs `@?` et `@@`, recréer l'index avec `jsonb_path_ops`; pour une clé précise, un index sur expression `((metadata->>'type'))` est souvent plus efficace.

- **`tsvector` sans index GIN — Seq Scan.** Ajouter `search_vector TSVECTOR GENERATED` sans `CREATE INDEX ... USING GIN` ne change rien à la performance. *Correct* : toujours créer le GIN sur la colonne `tsvector` immédiatement après.

- **Stocker dans JSONB des données relationnelles.** Mettre `family_id` ou `author_id` dans `metadata` pour éviter une migration perd les FK et rend les jointures impossibles (PostgreSQL ne peut pas indexer une relation entre un champ JSONB et une clé primaire). *Correct* : les clés étrangères restent en colonnes relationnelles ; JSONB = attributs extensibles non relationnels.

- **`websearch_to_tsquery` vs `to_tsquery` — syntaxe incompatible.** `to_tsquery('french', 'vacances montagne')` échoue (pas d'opérateur entre les termes) ; il faut `to_tsquery('french', 'vacance & montagne')`. *Correct* : pour la saisie utilisateur brute, utiliser `websearch_to_tsquery` ; réserver `to_tsquery` quand on contrôle la syntaxe (côté serveur, requêtes internes).

## 5. Ancrage TribuZen

Couche fil-rouge : **schéma + requêtes** dans `smaurier/tribuzen`.

- La table `posts` reçoit une colonne `metadata JSONB NOT NULL DEFAULT '{}'` — type de post, réactions, RSVP count, post épinglé. Chaque type de post porte uniquement ses clés. Aucune migration future pour ajouter un nouveau type de post.
- L'index `CREATE INDEX CONCURRENTLY idx_posts_metadata_gin ON posts USING GIN (metadata jsonb_path_ops)` sert le filtre par type et par attribut sur la page d'accueil famille — l'opérateur `@>` est la requête la plus fréquente sur cette table.
- La colonne `search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('french', coalesce(content, ''))) STORED` avec index GIN `idx_posts_search` alimente la barre de recherche du journal : stemming français, classement `ts_rank`, extraits `ts_headline` pour l'UI React.
- `ENUM post_status` (`draft`, `published`, `archived`, `pinned`) remplace la colonne `TEXT status` non contrainte — PostgreSQL rejette les valeurs invalides sans trigger, et le tri sur le statut est naturel.
- Le choix `jsonb_path_ops` pour le GIN sur `metadata` réduit l'index de ~30 % et accélère les INSERTs — essentiel car `posts` est la table la plus écrite de TribuZen (chaque message publié = 1 INSERT).
- En session : tous les `EXPLAIN ANALYZE` sont exécutés sur une base Docker locale avec 50 000 posts seedés — les timings sont mesurés, pas estimés.

## 6. Points clés

1. **JSONB toujours** (sauf preservation du formatage exact) : binaire, indexable avec GIN, opérateurs complets. `JSON` = texte brut, pas indexable.
2. `->` retourne **JSONB** (type conservé) ; `->>` retourne **TEXT** (pour comparer avec des scalaires) ; `#>` / `#>>` = chemin multi-niveaux.
3. `@>` teste la **contenance** (le document contient ce sous-document clé+valeur) ; `?` teste l'**existence** d'une clé quelle que soit sa valeur — ne pas les confondre.
4. `jsonpath` (`@?`, `@@`) permet des filtres expressifs sur les valeurs (comparaisons numériques, `starts with`, `[*]`) sans extraire en TEXT.
5. GIN sur JSONB : `jsonb_path_ops` si seul `@>` (index ~30 % plus compact) ; `jsonb_ops` si aussi `?`, `?|`, `?&`. Sans GIN, tout `@>` est un Seq Scan.
6. Full-Text Search : `to_tsvector('french', text)` normalise via stemming et stop words ; `websearch_to_tsquery` pour la saisie utilisateur ; `@@` pour le match ; `ts_rank` pour le classement ; `ts_headline` pour les extraits HTML.
7. Colonne `TSVECTOR GENERATED ALWAYS AS ... STORED` + GIN : maintenue automatiquement par PostgreSQL, aucun trigger. Toujours créer le GIN immédiatement après.
8. JSONB **complète** le modèle relationnel — FK, jointures et clés étrangères restent en colonnes ; JSONB = attributs extensibles non relationnels, structures variables par enregistrement.

## 7. Seeds Anki

```
Différence entre -> et ->> sur une colonne JSONB ?|-> retourne du JSONB (type conservé) ; ->> retourne du TEXT. Pour comparer avec un entier : (metadata->>'note')::int > 5 — pas metadata->'note' > 5 qui lève ERROR: operator does not exist: jsonb > integer
Quand utiliser @> plutôt que ? sur du JSONB ?|@> teste la contenance clé+valeur (le document contient exactement ce sous-document) ; ? teste uniquement l'existence d'une clé quelle que soit sa valeur. Pour filtrer sur une valeur précise : @>. Pour vérifier la présence d'un champ : ?
Quelle classe d'opérateur GIN choisir pour un index JSONB ?|jsonb_path_ops si seul @> est utilisé — index ~30 % plus compact, meilleures performances en lecture. jsonb_ops (défaut) si les opérateurs ?, ?|, ?& sont aussi nécessaires
Comment maintenir automatiquement une colonne tsvector sans trigger ?|GENERATED ALWAYS AS (to_tsvector('french', coalesce(col, ''))) STORED — PostgreSQL la met à jour à chaque INSERT/UPDATE. Ajouter ensuite CREATE INDEX ... USING GIN sur cette colonne
Différence entre to_tsquery et websearch_to_tsquery ?|to_tsquery exige la syntaxe formelle ('a & b', 'a | b', 'a <-> b') — un espace seul échoue. websearch_to_tsquery accepte la saisie naturelle ('a b' → 'a' & 'b', '"a b"' → phrase, 'a -b' → 'a' & !'b') — à préférer pour les inputs utilisateurs
Que retourne ts_headline et sur quelle colonne l'appeler ?|ts_headline retourne un extrait du texte original avec les termes trouvés balisés (StartSel/StopSel). L'appeler sur la colonne TEXT (content, title) — pas sur search_vector. Paramètres utiles : MaxWords, MinWords, HighlightAll
Pourquoi jsonpath @? ne profite pas toujours de l'index GIN jsonb_ops ?|jsonb_ops indexe les clés et valeurs scalaires pour @>, ?, etc. Les opérateurs @? et @@ de jsonpath sont couverts par jsonb_path_ops. Pour un filtrage jsonpath fréquent sur une clé précise, un index sur expression B-tree ((metadata->>'key')) est souvent plus efficace
Quand JSONB est-il un anti-pattern par rapport aux colonnes relationnelles ?|Quand les données nécessitent des FK (jointures, intégrité référentielle), quand elles sont filtrées ou triées fréquemment sur leur valeur, ou quand elles participent à des contraintes UNIQUE/CHECK. JSONB convient aux attributs extensibles variables par enregistrement
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-13-jsonb-fulltext/`. Tu ajoutes une colonne `metadata JSONB` à la table `posts` TribuZen, tu mesures le Seq Scan sans index sur `@>`, tu crées le GIN et confirmes le gain avec EXPLAIN ANALYZE. Puis tu ajoutes une colonne `search_vector TSVECTOR GENERATED`, tu crées le GIN FTS et tu écris les requêtes de recherche avec classement `ts_rank` et extrait `ts_headline`. Corrigé SQL complet inline dans le README.
