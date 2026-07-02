# Lab 13 — JSONB et Full-Text Search

> **Vrai outil :** SQL + `EXPLAIN (ANALYZE, BUFFERS)` sur une base PostgreSQL locale (Docker).
> Audit d'abord, index ensuite — chaque exercice suit le cycle **audit → fix → vérifie**.

## Pré-requis

- Module 13 terminé (opérateurs JSONB, GIN, tsvector/tsquery)
- Base Docker disponible : `docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17`

---

## Setup — schéma et données

Ouvrir `psql` et coller le bloc complet. Environ 5 s.

```sql
-- Nettoyer si rejeu du lab
DROP TABLE IF EXISTS posts CASCADE;
DROP TYPE IF EXISTS post_status;

-- Type énuméré pour le statut
CREATE TYPE post_status AS ENUM ('draft', 'published', 'archived', 'pinned');

-- Table posts TribuZen
CREATE TABLE posts (
    id         BIGSERIAL PRIMARY KEY,
    family_id  INT NOT NULL,
    author_id  INT NOT NULL,
    content    TEXT NOT NULL,
    status     post_status NOT NULL DEFAULT 'published',
    metadata   JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 50 000 posts avec metadata variée
INSERT INTO posts (family_id, author_id, content, status, metadata)
SELECT
    (random() * 49 + 1)::int,
    (random() * 499 + 1)::int,
    (ARRAY[
        'Week-end en famille à la montagne, randonnée et fondue !',
        'Organisation du repas de Noël, qui apporte le dessert ?',
        'Photos des vacances à la plage, quel beau soleil cet été.',
        'Réunion familiale dimanche, pensez à confirmer votre présence.',
        'Bon anniversaire à notre grand-mère, 80 ans déjà !',
        'Nouvelles du jardin, les tomates poussent enfin.',
        'Sortie au cinéma samedi soir, film d''aventure prévu.',
        'Les enfants ont réussi leurs examens, bravo à tous !'
    ])[(random() * 7 + 1)::int],
    CASE WHEN random() < 0.8
         THEN 'published'::post_status
         ELSE 'draft'::post_status
    END,
    (ARRAY[
        '{"type": "simple", "reactions": {"heart": 3, "laugh": 1}}',
        '{"type": "event", "event_date": "2026-08-15", "location": "Lyon", "rsvp_count": 5}',
        '{"type": "pinned", "pinned_by": 42, "pinned_at": "2026-06-01T08:00:00Z"}',
        '{"type": "simple", "reactions": {"heart": 12}}',
        '{"type": "event", "event_date": "2026-07-20", "location": "Paris", "rsvp_count": 8}'
    ]::jsonb[])[(random() * 4 + 1)::int]
FROM generate_series(1, 50000);

ANALYZE;
```

---

## Exercice 1 — Audit : opérateurs JSONB sans index

**Objectif :** maîtriser les opérateurs d'extraction et de contenance, mesurer le coût sans index.

```sql
-- 1a. Extraire le type de post (->> retourne TEXT) et compter
SELECT metadata->>'type' AS type_post, COUNT(*) AS nb
FROM posts
GROUP BY metadata->>'type'
ORDER BY nb DESC;

-- 1b. Posts de type 'event' avec leur date d'événement
SELECT id, content, metadata->>'event_date' AS date_ev
FROM posts
WHERE metadata @> '{"type": "event"}'
LIMIT 5;

-- 1c. Posts avec au moins 5 cœurs (chemin imbriqué + cast)
SELECT id, (metadata#>>'{reactions,heart}')::int AS hearts
FROM posts
WHERE (metadata#>>'{reactions,heart}')::int >= 5;

-- 1d. Observer le plan sur @> : Seq Scan attendu
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM posts WHERE metadata @> '{"type": "event"}';
```

**Ce que tu dois voir :**

```
Seq Scan on posts  (actual time=... rows=50000 loops=1)
  Filter: (metadata @> '{"type": "event"}'::jsonb)
  Rows Removed by Filter: ~40000
Execution Time: 400–900 ms
```

**Questions d'audit :**
1. PostgreSQL lit-il toutes les lignes ou uniquement celles de type 'event' ?
2. Pourquoi un index B-tree standard ne peut pas servir l'opérateur `@>` ?
3. Quelle différence entre `metadata ? 'type'` et `metadata @> '{"type": "event"}'` ?

---

## Exercice 1 — Fix : index GIN sur metadata

```sql
-- GIN avec jsonb_path_ops : seul @> est utilisé → index plus compact
CREATE INDEX CONCURRENTLY idx_posts_metadata_gin
    ON posts USING GIN (metadata jsonb_path_ops);

ANALYZE posts;

-- Relancer la même requête et comparer
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM posts WHERE metadata @> '{"type": "event"}';
```

**Ce que tu dois voir :**

```
Bitmap Index Scan on idx_posts_metadata_gin
  Index Cond: (metadata @> '{"type": "event"}'::jsonb)
  Buffers: shared hit=30–60
Execution Time: 1–4 ms
```

**Checkpoint :** Seq Scan disparu. Execution Time divisé par ~200. Confirmer avec `pg_indexes` :

```sql
SELECT indexname, pg_size_pretty(pg_relation_size(indexrelid)) AS taille
FROM pg_indexes
JOIN pg_stat_user_indexes USING (indexrelname)
WHERE tablename = 'posts' AND indexname = 'idx_posts_metadata_gin';
```

---

## Exercice 2 — JSONB : modifier et interroger

**Objectif :** pratiquer `jsonb_set`, `||`, `?`, jsonpath.

```sql
-- 2a. Ajouter une réaction 'celebrate' à un post sans écraser les autres réactions
--     jsonb_set(doc, path, valeur, creer_si_absent)
UPDATE posts
SET metadata = jsonb_set(
    metadata,
    '{reactions,celebrate}',
    '2'::jsonb,
    true
)
WHERE id = 1;

-- Vérifier : la clé 'celebrate' est ajoutée, les autres inchangées
SELECT metadata->'reactions' FROM posts WHERE id = 1;

-- 2b. Incrémenter le rsvp_count d'un post 'event'
UPDATE posts
SET metadata = jsonb_set(
    metadata,
    '{rsvp_count}',
    ((metadata->>'rsvp_count')::int + 1)::text::jsonb
)
WHERE id = (SELECT id FROM posts WHERE metadata @> '{"type": "event"}' LIMIT 1);

-- Vérifier
SELECT metadata->>'rsvp_count' FROM posts
WHERE id = (SELECT id FROM posts WHERE metadata @> '{"type": "event"}' LIMIT 1);

-- 2c. jsonpath @? : posts avec event_date après le 1er août 2026
SELECT id, content, metadata->>'event_date' AS date_ev
FROM posts
WHERE metadata @? '$.event_date ? (@ >= "2026-08-01")';

-- 2d. jsonpath @@ : posts avec plus de 10 cœurs
SELECT id, metadata#>>'{reactions,heart}' AS hearts
FROM posts
WHERE metadata @@ '$.reactions.heart > 10';

-- 2e. Posts ayant à la fois 'reactions' ET 'type' (les deux clés présentes)
SELECT COUNT(*) FROM posts WHERE metadata ?& array['reactions', 'type'];
```

---

## Exercice 3 — Audit : Full-Text Search sans vecteur

**Objectif :** mesurer les limites de `ILIKE` et comprendre pourquoi Full-Text Search est nécessaire.

```sql
-- 3a. ILIKE : Seq Scan systématique même avec un index B-tree sur content
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content FROM posts
WHERE content ILIKE '%vacances%';
-- → Seq Scan, aucun index utilisable

-- 3b. ILIKE ne gère pas le stemming
SELECT COUNT(*) FROM posts WHERE content ILIKE '%vacanc%';
SELECT COUNT(*) FROM posts WHERE content ILIKE '%vacances%';
-- Les deux retournent des résultats différents selon la forme exacte

-- 3c. Visualiser le prétraitement qu'effectuera to_tsvector
SELECT to_tsvector('french', 'Les enfants partaient en vacances à la montagne');
-- Résultat attendu : 'enfant':2 'montagne':9 'part':3 'vacanc':6
-- stop words supprimés, stemming appliqué
```

**Questions d'audit :**
1. Quelle est l'Execution Time de ILIKE sur 50 000 lignes ?
2. Que manque-t-il à ILIKE pour une vraie barre de recherche ? (3 défauts)
3. Que signifie `'vacanc':6` dans la sortie de `to_tsvector` ?

---

## Exercice 3 — Fix : colonne TSVECTOR générée + GIN

```sql
-- Ajouter la colonne générée : PostgreSQL la maintient automatiquement
ALTER TABLE posts ADD COLUMN search_vector TSVECTOR
    GENERATED ALWAYS AS (
        to_tsvector('french', coalesce(content, ''))
    ) STORED;

-- Index GIN sur la colonne générée
CREATE INDEX idx_posts_search ON posts USING GIN (search_vector);

ANALYZE posts;

-- Relancer la recherche
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content,
    ts_rank(search_vector, websearch_to_tsquery('french', 'vacances')) AS score
FROM posts
WHERE search_vector @@ websearch_to_tsquery('french', 'vacances')
ORDER BY score DESC
LIMIT 10;
```

**Ce que tu dois voir :**

```
Bitmap Index Scan on idx_posts_search
  Index Cond: (search_vector @@ websearch_to_tsquery('french', 'vacances'))
Execution Time: 2–8 ms
```

**Checkpoint :** GIN utilisé. Comparer le count avec ILIKE :

```sql
-- Full-Text (avec stemming) vs ILIKE strict
SELECT COUNT(*) FROM posts
WHERE search_vector @@ websearch_to_tsquery('french', 'vacances');

SELECT COUNT(*) FROM posts WHERE content ILIKE '%vacances%';
-- Le FTS trouve plus de résultats grâce au stemming
```

---

## Exercice 4 — Recherche avancée, ranking et extrait

**Objectif :** combiner filtre JSONB, full-text et classement pour la barre de recherche TribuZen.

```sql
-- 4a. Opérateurs tsquery avancés
-- & = ET
SELECT id, content FROM posts
WHERE search_vector @@ to_tsquery('french', 'famil & repas');

-- ! = NON
SELECT id, content FROM posts
WHERE search_vector @@ to_tsquery('french', 'vacanc & !plage');

-- | = OU
SELECT id, content FROM posts
WHERE search_vector @@ to_tsquery('french', 'anniversair | noël');

-- 4b. websearch_to_tsquery : saisie utilisateur brute
SELECT id, content FROM posts
WHERE search_vector @@ websearch_to_tsquery('french', 'vacances -plage');
-- Équivalent à to_tsquery('french', 'vacanc & !plage')

-- 4c. Classement par pertinence (ts_rank)
SELECT id, content,
    ts_rank(search_vector, websearch_to_tsquery('french', 'famille anniversaire')) AS score
FROM posts
WHERE search_vector @@ websearch_to_tsquery('french', 'famille anniversaire')
ORDER BY score DESC
LIMIT 10;

-- 4d. Extrait mis en forme pour l'UI
SELECT
    id,
    ts_headline('french', content,
        websearch_to_tsquery('french', 'vacances'),
        'StartSel=<mark>, StopSel=</mark>, MaxWords=25, MinWords=10'
    ) AS extrait
FROM posts
WHERE search_vector @@ websearch_to_tsquery('french', 'vacances')
ORDER BY ts_rank(search_vector, websearch_to_tsquery('french', 'vacances')) DESC
LIMIT 5;

-- 4e. Requête combinée : posts 'event' mentionnant 'famille' ou 'réunion'
SELECT
    id,
    content,
    metadata->>'event_date' AS date_ev,
    ts_rank(search_vector, websearch_to_tsquery('french', 'famille réunion')) AS score
FROM posts
WHERE metadata @> '{"type": "event"}'
  AND search_vector @@ websearch_to_tsquery('french', 'famille réunion')
ORDER BY score DESC
LIMIT 5;
```

---

## Récapitulatif — index créés pendant le lab

```sql
SELECT
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS taille,
    indexdef
FROM pg_indexes
JOIN pg_stat_user_indexes USING (indexrelname)
WHERE tablename = 'posts'
ORDER BY pg_relation_size(indexrelid) DESC;
```

---

## Corrigé complet — commandes dans l'ordre

```sql
-- 0. SETUP
DROP TABLE IF EXISTS posts CASCADE;
DROP TYPE IF EXISTS post_status;
CREATE TYPE post_status AS ENUM ('draft', 'published', 'archived', 'pinned');
CREATE TABLE posts (
    id BIGSERIAL PRIMARY KEY,
    family_id INT NOT NULL, author_id INT NOT NULL,
    content TEXT NOT NULL, status post_status NOT NULL DEFAULT 'published',
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO posts (family_id, author_id, content, status, metadata)
SELECT
    (random()*49+1)::int, (random()*499+1)::int,
    (ARRAY[
        'Week-end en famille à la montagne, randonnée et fondue !',
        'Organisation du repas de Noël, qui apporte le dessert ?',
        'Photos des vacances à la plage, quel beau soleil cet été.',
        'Réunion familiale dimanche, pensez à confirmer votre présence.',
        'Bon anniversaire à notre grand-mère, 80 ans déjà !',
        'Nouvelles du jardin, les tomates poussent enfin.',
        'Sortie au cinéma samedi soir, film d''aventure prévu.',
        'Les enfants ont réussi leurs examens, bravo à tous !'
    ])[(random()*7+1)::int],
    CASE WHEN random()<0.8
         THEN 'published'::post_status ELSE 'draft'::post_status END,
    (ARRAY[
        '{"type": "simple", "reactions": {"heart": 3, "laugh": 1}}',
        '{"type": "event", "event_date": "2026-08-15", "location": "Lyon", "rsvp_count": 5}',
        '{"type": "pinned", "pinned_by": 42, "pinned_at": "2026-06-01T08:00:00Z"}',
        '{"type": "simple", "reactions": {"heart": 12}}',
        '{"type": "event", "event_date": "2026-07-20", "location": "Paris", "rsvp_count": 8}'
    ]::jsonb[])[(random()*4+1)::int]
FROM generate_series(1, 50000);
ANALYZE;

-- 1. GIN sur metadata JSONB
CREATE INDEX CONCURRENTLY idx_posts_metadata_gin
    ON posts USING GIN (metadata jsonb_path_ops);
ANALYZE posts;
-- Vérifier : EXPLAIN sur WHERE metadata @> '{"type": "event"}' → Bitmap Index Scan, ~2 ms

-- 2. jsonb_set — modifier sans écraser
UPDATE posts
    SET metadata = jsonb_set(metadata, '{reactions,celebrate}', '2'::jsonb, true)
    WHERE id = 1;
-- Vérifier : SELECT metadata->'reactions' FROM posts WHERE id = 1;

-- jsonpath — événements après le 1er août
SELECT id FROM posts WHERE metadata @? '$.event_date ? (@ >= "2026-08-01")';

-- 3. Colonne TSVECTOR générée + GIN FTS
ALTER TABLE posts ADD COLUMN search_vector TSVECTOR
    GENERATED ALWAYS AS (to_tsvector('french', coalesce(content, ''))) STORED;
CREATE INDEX idx_posts_search ON posts USING GIN (search_vector);
ANALYZE posts;
-- Vérifier : EXPLAIN sur WHERE search_vector @@ websearch_to_tsquery('french', 'vacances')
--            → Bitmap Index Scan idx_posts_search, ~3 ms

-- 4a. Opérateurs tsquery
SELECT id FROM posts WHERE search_vector @@ to_tsquery('french', 'famil & repas');
SELECT id FROM posts WHERE search_vector @@ to_tsquery('french', 'vacanc & !plage');
SELECT id FROM posts WHERE search_vector @@ to_tsquery('french', 'anniversair | noël');

-- 4b. websearch_to_tsquery
SELECT id FROM posts WHERE search_vector @@ websearch_to_tsquery('french', 'vacances -plage');

-- 4c. Ranking
SELECT id, content,
    ts_rank(search_vector, websearch_to_tsquery('french', 'famille anniversaire')) AS score
FROM posts
WHERE search_vector @@ websearch_to_tsquery('french', 'famille anniversaire')
ORDER BY score DESC LIMIT 10;

-- 4d. Extrait
SELECT id,
    ts_headline('french', content, websearch_to_tsquery('french', 'vacances'),
        'StartSel=<mark>, StopSel=</mark>, MaxWords=25, MinWords=10') AS extrait
FROM posts
WHERE search_vector @@ websearch_to_tsquery('french', 'vacances')
ORDER BY ts_rank(search_vector, websearch_to_tsquery('french', 'vacances')) DESC
LIMIT 5;

-- 4e. Combiné JSONB + FTS
SELECT id, content, metadata->>'event_date' AS date_ev,
    ts_rank(search_vector, websearch_to_tsquery('french', 'famille réunion')) AS score
FROM posts
WHERE metadata @> '{"type": "event"}'
  AND search_vector @@ websearch_to_tsquery('french', 'famille réunion')
ORDER BY score DESC LIMIT 5;
```

---

## Variante J+30 (fading)

> Refais sans regarder le corrigé. L'objectif est de vérifier que l'index GIN est bien utilisé via `EXPLAIN`.

**Nouveau champ : `location TEXT` dans `metadata` des posts d'événement.**

```sql
-- Ajouter des valeurs de location variées dans metadata (rejeu sur la même table)
UPDATE posts
SET metadata = metadata || jsonb_build_object('location', (
    ARRAY['Lyon', 'Paris', 'Marseille', 'Bordeaux', 'Nantes']
)[(random()*4+1)::int])
WHERE metadata @> '{"type": "event"}';

ANALYZE posts;
```

**Sans aide, reproduis de mémoire les étapes suivantes :**

1. **Audit JSONB :** mesure le coût d'une recherche `@>` sur `{"location": "Lyon"}` — confirme le Seq Scan via `EXPLAIN (ANALYZE, BUFFERS)`.
2. **Fix GIN :** crée l'index GIN approprié sur `metadata` (si absent) et reconfirme avec `EXPLAIN` que le Bitmap Index Scan est utilisé.
3. **Full-text sur un champ extrait :** ajoute une colonne TSVECTOR générée `location_vector` construite à partir de `metadata->>'location'` (pas de dictionnaire linguistique nécessaire — utilise `'simple'`), crée l'index GIN sur cette colonne.
4. **Requête combinée :** retrouve tous les posts `event` dont la location est `'Lyon'` **et** dont le `content` contient `'famille'`, ordonnés par `ts_rank` décroissant, et vérifie avec `EXPLAIN` que les **deux** index GIN sont utilisés (un sur `metadata`, un sur `search_vector` ou `location_vector`).

```sql
-- Templates vides — complète de mémoire

-- 1. Audit
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM posts WHERE metadata @> '{"location": "Lyon"}';

-- 2. Fix GIN (si absent)
-- CREATE INDEX CONCURRENTLY ... ;

-- 3. Colonne générée location_vector
ALTER TABLE posts ADD COLUMN location_vector TSVECTOR
    GENERATED ALWAYS AS ( ... ) STORED;
CREATE INDEX ... ;
ANALYZE posts;

-- 4. Requête combinée avec EXPLAIN
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content, metadata->>'location' AS location, ts_rank(search_vector, ...) AS score
FROM posts
WHERE metadata @> '{"location": "Lyon"}'
  AND search_vector @@ websearch_to_tsquery('french', 'famille')
ORDER BY score DESC
LIMIT 10;
```

**Critère de réussite :** l'`EXPLAIN` final montre deux Bitmap Index Scans (un sur `metadata`, un sur `search_vector`) — pas de Seq Scan résiduel.

---

## Navigation

| | Lien |
|---|---|
| Module | [13 — JSONB et types avancés](../../modules/13-jsonb-et-types-avances.md) |
| Module précédent | [12 — Fonctions avancées SQL](../../modules/12-fonctions-avancees-sql.md) |
| Module suivant | [14 — Sécurité & Administration](../../modules/14-securite-et-administration.md) |
