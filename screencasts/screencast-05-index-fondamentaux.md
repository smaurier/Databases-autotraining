# Screencast 05 — Index fondamentaux

## Informations
- **Durée estimée** : 20-22 min
- **Module** : `modules/05-index-fondamentaux.md`
- **Lab associé** : `labs/lab-05-index-et-explain/`
- **Prérequis** : Modules 01-04 terminés, PostgreSQL running, base `course_db`

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] Terminal ouvert dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] `psql` connecté à `course_db`
- [ ] Navigateur prêt pour `btree-index.html`

## Script

### [00:00-03:00] Pourquoi les index — Analogie du livre

> Imaginez un livre de 1000 pages sans table des matières ni index. Pour trouver un sujet, vous devez lire chaque page. C'est exactement ce que fait PostgreSQL quand il n'y a pas d'index : il parcourt chaque ligne de la table — c'est un Seq Scan. Un index, c'est comme l'index en fin de livre : il permet de sauter directement à la bonne page.

**Action** : Afficher un schéma comparant la recherche séquentielle et la recherche indexée.

> Créons une grande table pour voir la différence de performance.

**Action** : Créer et peupler une table volumineuse.

```sql
-- Créer une table avec beaucoup de données
CREATE TABLE events (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type  VARCHAR(20) NOT NULL,
    user_id     INTEGER NOT NULL,
    payload     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insérer 500 000 lignes
INSERT INTO events (event_type, user_id, payload, created_at)
SELECT
    (ARRAY['click', 'view', 'purchase', 'signup', 'logout'])[1 + floor(random() * 5)::int],
    (random() * 10000)::int + 1,
    'payload_' || i,
    NOW() - (random() * INTERVAL '365 days')
FROM generate_series(1, 500000) AS s(i);

-- Vérifier le nombre de lignes
SELECT COUNT(*) FROM events;

-- Analyser la table pour les statistiques
ANALYZE events;
```

**Action** : Montrer que l'insertion de 500 000 lignes prend quelques secondes. Afficher le COUNT.

### [03:00-06:00] B-tree — Structure de l'index

> L'index par défaut de PostgreSQL est le B-tree. C'est un arbre équilibré qui permet de trouver n'importe quelle valeur en O(log n). Pour 500 000 lignes, c'est environ 19 comparaisons au lieu de 500 000.

**Action** : Afficher un schéma de B-tree avec des niveaux (racine, branches, feuilles).

> Le B-tree est optimal pour les comparaisons : égalité, inégalité, BETWEEN, ORDER BY. C'est l'index que vous utiliserez 90% du temps.

```sql
-- Sans index : Seq Scan (parcourt toute la table)
EXPLAIN ANALYZE
SELECT * FROM events WHERE user_id = 4242;

-- Résultat typique :
-- Seq Scan on events  (cost=... rows=... width=...)
--   Filter: (user_id = 4242)
--   Rows Removed by Filter: ~499950
-- Execution Time: ~80-120 ms
```

**Action** : Montrer la sortie EXPLAIN ANALYZE et pointer le Seq Scan et le temps d'exécution.

### [06:00-09:30] CREATE INDEX

> Créons un index B-tree sur `user_id` et comparons.

**Action** : Créer l'index et relancer la même requête.

```sql
-- Créer un index B-tree
CREATE INDEX idx_events_user_id ON events (user_id);

-- Vérifier que l'index existe
\di+ idx_events_user_id

-- Même requête, avec l'index
EXPLAIN ANALYZE
SELECT * FROM events WHERE user_id = 4242;

-- Résultat typique :
-- Index Scan using idx_events_user_id on events (cost=... rows=... width=...)
--   Index Cond: (user_id = 4242)
-- Execution Time: ~0.1-0.5 ms
```

> On passe de ~100ms à moins de 1ms. C'est 100 à 200 fois plus rapide. Le planificateur utilise maintenant un Index Scan au lieu d'un Seq Scan.

**Action** : Afficher les deux EXPLAIN ANALYZE côte à côte (où successivement) pour comparer les temps.

```sql
-- L'index a un coût : espace disque
SELECT
    indexname,
    pg_size_pretty(pg_relation_size(indexname::regclass)) AS index_size
FROM pg_indexes
WHERE tablename = 'events';

-- Taille de la table vs index
SELECT
    pg_size_pretty(pg_table_size('events')) AS table_size,
    pg_size_pretty(pg_indexes_size('events')) AS total_index_size;
```

**Action** : Montrer la taille de l'index et comparer avec la table.

### [09:30-12:00] Composite index (index multi-colonnes)

> Un index composite couvre plusieurs colonnes. L'ordre des colonnes est crucial — c'est comme un annuaire : on peut chercher par nom, ou par nom + prénom, mais pas par prénom seul.

**Action** : Créer et tester un index composite.

```sql
-- Index composite : event_type + created_at
CREATE INDEX idx_events_type_date ON events (event_type, created_at);

-- Cette requête utilise l'index composite (les deux colonnes)
EXPLAIN ANALYZE
SELECT * FROM events
WHERE event_type = 'purchase'
  AND created_at > NOW() - INTERVAL '30 days';

-- Cette requête utilise aussi l'index (préfixe gauche)
EXPLAIN ANALYZE
SELECT * FROM events
WHERE event_type = 'click';

-- Cette requête N'utilise PAS l'index composite
EXPLAIN ANALYZE
SELECT * FROM events
WHERE created_at > NOW() - INTERVAL '30 days';
-- PostgreSQL fait un Seq Scan car created_at n'est pas le premier champ de l'index
```

> Règle importante : un index composite est utilisable pour les colonnes de gauche à droite. (event_type) fonctionne, (event_type, created_at) fonctionne, mais (created_at) seul ne peut pas utiliser cet index.

**Action** : Montrer les trois EXPLAIN ANALYZE et pointer les différences de plan.

### [12:00-14:30] Expression index

> On peut aussi indexer une expression plutôt qu'une simple colonne. C'est utile pour les recherches insensibles à la casse ou les calculs fréquents.

**Action** : Démontrer un index sur expression.

```sql
-- Index sur expression : recherche insensible à la casse
CREATE INDEX idx_events_type_lower ON events (LOWER(event_type));

-- Cette requête utilise l'index sur expression
EXPLAIN ANALYZE
SELECT * FROM events WHERE LOWER(event_type) = 'purchase';

-- Index sur extraction de date (pour les requêtes par jour)
CREATE INDEX idx_events_date ON events ((created_at::date));

EXPLAIN ANALYZE
SELECT COUNT(*) FROM events
WHERE created_at::date = CURRENT_DATE - 30;
```

> L'index sur expression doit correspondre exactement à l'expression dans la requête. Si vous indexez `LOWER(event_type)`, il faut que la requête utilise aussi `LOWER(event_type)`.

**Action** : Montrer que l'index est utilisé dans l'EXPLAIN ANALYZE.

### [14:30-17:00] Partial index

> Un index partiel ne couvre qu'un sous-ensemble de lignes. C'est plus petit, plus rapide, et parfait quand vous ne cherchez que dans une partie des données.

**Action** : Créer et tester un index partiel.

```sql
-- Index partiel : uniquement les achats (event_type = 'purchase')
CREATE INDEX idx_events_purchase_user
ON events (user_id)
WHERE event_type = 'purchase';

-- Taille comparée
SELECT
    indexname,
    pg_size_pretty(pg_relation_size(indexname::regclass)) AS size
FROM pg_indexes
WHERE tablename = 'events'
ORDER BY pg_relation_size(indexname::regclass) DESC;

-- Cette requête utilise l'index partiel
EXPLAIN ANALYZE
SELECT * FROM events
WHERE event_type = 'purchase' AND user_id = 4242;

-- Cette requête n'utilise PAS l'index partiel
EXPLAIN ANALYZE
SELECT * FROM events
WHERE event_type = 'click' AND user_id = 4242;
```

> L'index partiel sur les achats est beaucoup plus petit que l'index complet. Si 80% de vos requêtes cherchent des achats, c'est un excellent compromis.

**Action** : Comparer la taille de l'index partiel avec les autres index dans la sortie.

### [17:00-19:00] Visualisation btree-index.html

> Ouvrons la visualisation interactive pour mieux comprendre la structure d'un B-tree.

**Action** : Ouvrir `visualizations/btree-index.html` dans le navigateur.

> Cette visualisation montre comment les valeurs sont organisées dans les noeuds du B-tree. Quand on cherche une valeur, on descend de la racine aux feuilles en suivant les pointeurs. Chaque niveau divise l'espace de recherche — c'est pour ça que c'est si rapide.

**Action** : Interagir avec la visualisation : chercher une valeur et montrer le chemin parcouru dans l'arbre.

### [19:00-21:00] Lab-05 : step1 -> step2 -> step3

> Le lab 05 est structuré en trois étapes. Step 1 : mesurer les performances sans index. Step 2 : créer les bons index. Step 3 : comparer les plans d'exécution avant/après.

**Action** : Ouvrir `labs/lab-05-index-et-explain/` et parcourir les instructions.

```sql
-- Aperçu lab-05
-- Step 1 : EXPLAIN ANALYZE sans index
-- Step 2 : Créer des index adaptés
-- Step 3 : Vérifier l'amélioration avec EXPLAIN ANALYZE

-- Vérifier les index existants sur une table
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'events';
```

**Action** : Montrer les trois étapes du lab et les résultats attendus.

### [21:00-21:45] Conclusion

> Les index sont l'outil numéro un pour accélérer vos requêtes. On a vu le B-tree, les index composites, les expression indexes et les index partiels. Mais attention — chaque index à un coût en espace et ralentit les écritures. Il faut indexer intelligemment. Dans le prochain module, on va plonger dans le query planner pour comprendre comment PostgreSQL décide d'utiliser ou non un index.

**Action** : Nettoyage.

```sql
DROP TABLE IF EXISTS events;
```

## Points d'attention pour l'enregistrement
- Les temps d'exécution varient selon la machine — faire un test avant
- Bien montrer la différence de temps avant/après la création de l'index
- Ne pas aller trop vite sur la structure B-tree — un schéma visuel aide beaucoup
- Vérifier que la visualisation `btree-index.html` fonctionne dans le navigateur
- Préparer la table de 500k lignes à l'avance si l'INSERT est trop lent en live
- Garder l'EXPLAIN ANALYZE lisible — utiliser `\x` si nécessaire pour le format étendu
