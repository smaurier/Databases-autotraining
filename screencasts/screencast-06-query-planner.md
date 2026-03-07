# Screencast 06 — Le Query Planner

## Informations
- **Durée estimée** : 20-22 min
- **Module** : `modules/06-query-planner.md`
- **Lab associé** : `labs/lab-06-query-planner-deep-dive/`
- **Prérequis** : Modules 01-05 terminés, PostgreSQL running, table `events` avec index

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] Terminal ouvert dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] `psql` connecté à `course_db`
- [ ] Navigateur prêt pour `query-planner.html`

## Script

### [00:00-02:30] Introduction — EXPLAIN basique

> Le query planner est le cerveau de PostgreSQL. À chaque requête, il analyse toutes les stratégies possibles et choisit la plus efficace. Comprendre ses décisions, c'est la clé pour optimiser vos requêtes.

**Action** : Créer la table de démo et les index.

```sql
-- Recréer la table events avec des données
CREATE TABLE events (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type  VARCHAR(20) NOT NULL,
    user_id     INTEGER NOT NULL,
    payload     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO events (event_type, user_id, payload, created_at)
SELECT
    (ARRAY['click', 'view', 'purchase', 'signup', 'logout'])[1 + floor(random() * 5)::int],
    (random() * 10000)::int + 1,
    'payload_' || i,
    NOW() - (random() * INTERVAL '365 days')
FROM generate_series(1, 500000) AS s(i);

CREATE INDEX idx_events_user_id ON events (user_id);
CREATE INDEX idx_events_type_date ON events (event_type, created_at);
ANALYZE events;
```

```sql
-- EXPLAIN : affiche le plan SANS exécuter la requête
EXPLAIN
SELECT * FROM events WHERE user_id = 4242;

-- Sortie typique :
-- Index Scan using idx_events_user_id on events  (cost=0.42..53.44 rows=50 width=52)
--   Index Cond: (user_id = 4242)
```

> EXPLAIN montre le plan estimé. Les coûts sont en unités arbitraires. `rows=50` est l'estimation du nombre de lignes. On ne sait pas encore si c'est juste.

**Action** : Pointer les différentes parties de la sortie EXPLAIN : type de scan, coût, rows estimées.

### [02:30-06:00] EXPLAIN ANALYZE — Estimations vs réalité

> EXPLAIN ANALYZE exécute réellement la requête et compare les estimations avec les résultats réels. C'est l'outil indispensable pour diagnostiquer les problèmes de performance.

**Action** : Exécuter EXPLAIN ANALYZE et analyser la sortie.

```sql
-- EXPLAIN ANALYZE : exécute et mesure
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT * FROM events WHERE user_id = 4242;

-- Sortie typique :
-- Index Scan using idx_events_user_id on events
--   (cost=0.42..53.44 rows=50 width=52)
--   (actual time=0.031..0.089 rows=48 loops=1)
--   Index Cond: (user_id = 4242)
--   Buffers: shared hit=51
-- Planning Time: 0.085 ms
-- Execution Time: 0.112 ms
```

> On voit maintenant les temps réels : `actual time=0.031..0.089`. Et les lignes réelles : `rows=48` contre `rows=50` estimées. L'estimation est bonne ici. `Buffers: shared hit=51` signifie que 51 pages ont été lues depuis le cache.

**Action** : Encadrer ou surligner les champs `actual time`, `rows`, et `Buffers`.

```sql
-- EXPLAIN avec format JSON (plus détaillé, utile pour les outils)
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT * FROM events WHERE user_id = 4242;
```

**Action** : Montrer brièvement le format JSON — utile pour les outils de visualisation.

### [06:00-09:30] Seq Scan vs Index Scan

> Le planificateur choisit entre Seq Scan et Index Scan en fonction de la sélectivité. Si on cherche peu de lignes, l'index est rapide. Si on cherche beaucoup de lignes, le Seq Scan est parfois plus efficace.

**Action** : Montrer les deux comportements.

```sql
-- Index Scan : peu de lignes retournées (~50 sur 500 000)
EXPLAIN ANALYZE
SELECT * FROM events WHERE user_id = 4242;
-- -> Index Scan

-- Seq Scan : beaucoup de lignes retournées (~100 000 sur 500 000)
EXPLAIN ANALYZE
SELECT * FROM events WHERE event_type = 'click';
-- -> Seq Scan (même avec un index, le planificateur préfère le scan séquentiel)
```

> Pourquoi le Seq Scan ? Parce qu'on ramène ~20% de la table. Lire séquentiellement 500 000 lignes sur disque est plus rapide que faire 100 000 allers-retours aléatoires via l'index. Le planificateur fait un calcul de coût et choisit la meilleure stratégie.

**Action** : Comparer les deux plans côte à côte.

```sql
-- Forcer un Index Scan pour comparer (ne pas faire en production !)
SET enable_seqscan = off;
EXPLAIN ANALYZE
SELECT * FROM events WHERE event_type = 'click';
-- -> Index Scan (forcé, souvent plus lent)
SET enable_seqscan = on;
```

> On peut forcer le planificateur à utiliser un index avec `SET enable_seqscan = off`. Mais en pratique, le planificateur a presque toujours raison. C'est uniquement utile pour le diagnostic.

**Action** : Montrer que l'Index Scan forcé est effectivement plus lent.

### [09:30-13:00] Bitmap Scan

> Le Bitmap Scan est un compromis entre Seq Scan et Index Scan. Il est utilisé quand on retourne trop de lignes pour un Index Scan mais pas assez pour un Seq Scan.

**Action** : Provoquer un Bitmap Scan.

```sql
-- Bitmap Scan : sélectivité intermédiaire
EXPLAIN ANALYZE
SELECT * FROM events
WHERE user_id BETWEEN 1000 AND 1100;

-- Sortie typique :
-- Bitmap Heap Scan on events
--   Recheck Cond: (user_id >= 1000 AND user_id <= 1100)
--   -> Bitmap Index Scan on idx_events_user_id
--        Index Cond: (user_id >= 1000 AND user_id <= 1100)
```

> Le Bitmap Scan fonctionne en deux étapes. D'abord, il parcourt l'index et crée un bitmap des pages à lire (Bitmap Index Scan). Ensuite, il lit ces pages dans l'ordre physique (Bitmap Heap Scan), ce qui est plus efficace que les lectures aléatoires.

**Action** : Pointer les deux étapes dans le plan : Bitmap Index Scan puis Bitmap Heap Scan.

```sql
-- Bitmap Scan avec combinaison de deux index (BitmapAnd/BitmapOr)
EXPLAIN ANALYZE
SELECT * FROM events
WHERE user_id = 4242 OR event_type = 'purchase';

-- PostgreSQL peut combiner deux Bitmap Index Scans avec BitmapOr
```

> Le Bitmap Scan peut même combiner plusieurs index avec BitmapAnd et BitmapOr. C'est une stratégie que le planificateur utilise automatiquement quand c'est avantageux.

**Action** : Montrer le plan avec BitmapOr si le planificateur le choisit.

### [13:00-16:00] JOIN strategies

> Pour les jointures, le planificateur a trois stratégies : Nested Loop, Hash Join et Merge Join.

**Action** : Créer une table supplémentaire et montrer les différentes stratégies.

```sql
-- Table users pour les jointures
CREATE TABLE users (
    id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name  VARCHAR(50) NOT NULL
);

INSERT INTO users (name)
SELECT 'user_' || i FROM generate_series(1, 10000) AS s(i);
ANALYZE users;

-- Nested Loop : quand une table est petite
EXPLAIN ANALYZE
SELECT u.name, e.event_type
FROM users u
JOIN events e ON e.user_id = u.id
WHERE u.id = 42;

-- Hash Join : quand les deux tables sont grandes
EXPLAIN ANALYZE
SELECT u.name, COUNT(*) AS nb_events
FROM users u
JOIN events e ON e.user_id = u.id
GROUP BY u.id, u.name
ORDER BY nb_events DESC
LIMIT 10;

-- Merge Join : quand les données sont triées
EXPLAIN ANALYZE
SELECT u.name, e.event_type
FROM users u
JOIN events e ON e.user_id = u.id
ORDER BY u.id
LIMIT 100;
```

> Nested Loop : boucle sur la petite table, cherche dans la grande via index. Hash Join : construit une table de hachage en mémoire, très rapide pour les jointures d'égalité. Merge Join : fusionne deux flux triés, efficace quand les données sont déjà ordonnées.

**Action** : Montrer chaque type de jointure dans le plan d'exécution et expliquer brièvement.

### [16:00-18:30] Visualisation query-planner.html

> Utilisons la visualisation interactive pour mieux comprendre les plans d'exécution.

**Action** : Ouvrir `visualizations/query-planner.html` dans le navigateur.

```sql
-- Obtenir un plan JSON pour la visualisation
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT u.name, COUNT(*) AS nb_events
FROM users u
JOIN events e ON e.user_id = u.id
GROUP BY u.id, u.name
HAVING COUNT(*) > 60
ORDER BY nb_events DESC;
```

> Copiez la sortie JSON dans la visualisation. Elle affiche le plan sous forme d'arbre avec les coûts, les temps et les buffers pour chaque noeud. Les noeuds les plus coûteux sont mis en évidence — c'est là qu'il faut optimiser.

**Action** : Copier le JSON dans la visualisation et parcourir l'arbre interactif. Pointer les noeuds coûteux.

### [18:30-20:30] Walkthrough Lab-06

> Le lab 06 vous fait analyser des plans d'exécution complexes et identifier les optimisations possibles.

**Action** : Ouvrir `labs/lab-06-query-planner-deep-dive/` et parcourir les exercices.

```sql
-- Aperçu lab-06 : diagnostiquer et optimiser
-- Exercice 1 : Identifier pourquoi une requête est lente
-- Exercice 2 : Créer l'index qui manque
-- Exercice 3 : Comparer les plans avant/après

-- Astuce : repérer les mauvaises estimations
EXPLAIN ANALYZE
SELECT * FROM events
WHERE event_type = 'purchase' AND created_at > NOW() - INTERVAL '7 days';
-- Vérifier si rows estimées ≈ rows réelles
```

**Action** : Montrer les étapes du lab et l'approche méthodique pour lire un EXPLAIN ANALYZE.

### [20:30-21:30] Conclusion

> Le query planner est votre allié. Avec EXPLAIN ANALYZE, vous pouvez comprendre chaque décision : Seq Scan, Index Scan, Bitmap Scan, stratégies de jointure. L'objectif n'est pas de forcer le planificateur, mais de lui donner les bons outils — les bons index et des statistiques à jour. Dans le prochain module, on explore les index avancés : GIN, GiST et BRIN.

**Action** : Nettoyage.

```sql
DROP TABLE IF EXISTS events, users;
```

## Points d'attention pour l'enregistrement
- Les plans d'exécution changent selon les statistiques — faire un ANALYZE avant
- Zoomer sur les sorties EXPLAIN ANALYZE pour la lisibilité
- Ne pas aller trop vite sur les différents types de scans — c'est un sujet dense
- Tester la visualisation `query-planner.html` avant l'enregistrement
- Préparer des captures d'écran des plans au cas où la sortie serait trop longue
- Utiliser `\x` ou le format JSON selon ce qui est plus lisible
