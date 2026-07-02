---
titre: Fonctions avancées SQL
cours: 10-postgresql
notions: [fonctions fenêtre ROW_NUMBER RANK DENSE_RANK, LAG et LEAD, PARTITION BY et frame, CTE avec WITH, CTE récursive, GROUPING SETS ROLLUP CUBE, LATERAL, agrégats filtrés FILTER]
outcomes: [classer et comparer des lignes avec les fonctions fenêtre, structurer une requête avec des CTE, écrire une CTE récursive, utiliser LATERAL et FILTER]
prerequis: [11-performances-et-optimisation]
next: 13-jsonb-et-types-avances
libs: [{ name: postgresql, version: "17" }]
tribuzen: classer les posts d'une famille par popularité et parcourir l'arbre familial (CTE récursive)
last-reviewed: 2026-07
---

# Fonctions avancées SQL

> **Outcomes — tu sauras FAIRE :** classer et comparer des lignes avec les fonctions fenêtre (ROW\_NUMBER, RANK, LAG, LEAD), structurer une requête complexe avec des CTE, écrire une CTE récursive pour traverser un arbre, et filtrer des agrégats avec FILTER.
> **Difficulté :** :star::star::star:

## 1. Cas concret d'abord

Dans TribuZen, deux besoins arrivent le même sprint :

**Besoin 1 — Dashboard famille :** afficher les 10 posts les plus aimés de la semaine dans une famille, avec le rang de chaque post et la variation de popularité par rapport au post précédent (↑ ou ↓).

**Besoin 2 — Arbre généalogique :** parcourir l'arbre familial depuis un membre racine jusqu'aux feuilles, profondeur inconnue à l'avance.

Approche naïve — besoin 1 :

```sql
-- Sous-requête corrélée par ligne : une exécution par post → N+1 interne
SELECT
  p.id,
  p.content,
  (SELECT COUNT(*) FROM reactions r WHERE r.post_id = p.id) AS nb_reactions
FROM posts p
WHERE p.family_id = 1
ORDER BY nb_reactions DESC
LIMIT 10;
-- La variation par rapport au post précédent exige un deuxième aller-retour.
-- ORDER BY sur une sous-requête scalaire : non indexable, full scan à chaque ligne.
```

Approche naïve — besoin 2 :

```sql
-- Impossible sans récursion : autant de jointures que de niveaux,
-- profondeur inconnue → boucle Node.js avec une requête par niveau.
-- 5 niveaux = 5 round-trips ; pas de garantie sur la profondeur max.
```

Les fonctions fenêtre et les CTEs récursives résolvent les deux en **une seule requête**.

## 2. Théorie complète, concise

### Fonctions fenêtre — le principe

Une fonction fenêtre calcule une valeur pour chaque ligne en utilisant un **ensemble de lignes voisines** (la "fenêtre"), sans réduire le nombre de lignes du résultat. Contrairement à `GROUP BY` qui agrège, une fonction fenêtre **enrichit**.

```sql
fonction() OVER (
    PARTITION BY col_partition   -- découpe en groupes indépendants
    ORDER BY col_tri             -- ordre dans chaque groupe
    ROWS BETWEEN ... AND ...     -- délimite les lignes incluses (frame)
)
```

La clause `OVER (...)` peut être nommée avec `WINDOW w AS (...)` pour éviter la répétition.

### ROW_NUMBER, RANK, DENSE_RANK

Les trois classent les lignes selon `ORDER BY`. La différence apparaît sur les **ex-aequo** :

| Fonction | Ex-aequo (score = 5) | Rang suivant |
|---|---|---|
| ROW_NUMBER | 3, 4 (unique, arbitraire) | 5 |
| RANK | 3, 3 (même rang) | **5** (saute le 4) |
| DENSE_RANK | 3, 3 (même rang) | **4** (pas de saut) |

```sql
SELECT
  p.id,
  nb_reactions,
  ROW_NUMBER() OVER (ORDER BY nb_reactions DESC) AS row_num,
  RANK()       OVER (ORDER BY nb_reactions DESC) AS rnk,
  DENSE_RANK() OVER (ORDER BY nb_reactions DESC) AS dense_rnk
FROM post_stats;
```

`ROW_NUMBER` est préféré pour la **pagination** (numéros uniques). `RANK` et `DENSE_RANK` pour les **classements** avec ex-aequo significatifs (top 3 podium).

### LAG et LEAD

Accèdent à la valeur d'une ligne **précédente** (`LAG`) ou **suivante** (`LEAD`) dans la partition ordonnée.

```sql
LAG(expression, offset, défaut) OVER (PARTITION BY ... ORDER BY ...)
-- offset : nombre de lignes en arrière (défaut 1)
-- défaut : valeur si la ligne n'existe pas (défaut NULL)
```

```sql
SELECT
  p.id,
  nb_reactions,
  LAG(nb_reactions, 1, 0) OVER (ORDER BY created_at) AS reactions_precedent,
  nb_reactions - LAG(nb_reactions, 1, 0) OVER (ORDER BY created_at) AS variation
FROM post_stats
ORDER BY created_at;
```

`LEAD` fonctionne de manière symétrique, vers les lignes suivantes.

### PARTITION BY et frame

`PARTITION BY` découpe le résultat en **groupes indépendants** — les fonctions fenêtre s'appliquent séparément dans chaque groupe (comme un `GROUP BY` mais sans agréger).

La **frame clause** contrôle quelles lignes de la partition sont incluses dans le calcul :

| Frame | Lignes incluses | Utilisation typique |
|---|---|---|
| `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` | Du début à la ligne courante | Total cumulé (running total) |
| `ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING` | Ligne précédente + courante + suivante | Moyenne mobile 3 périodes |
| `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` | Toutes les lignes de la partition | Valeur globale de la partition |

**Piège `LAST_VALUE` :** le frame par défaut est `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`, donc `LAST_VALUE` retourne souvent la ligne courante. Toujours spécifier `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` avec `LAST_VALUE`.

### CTE avec WITH

Une CTE (**Common Table Expression**) nomme un sous-résultat temporaire, réutilisable dans la requête principale ou dans les CTEs suivantes.

```sql
WITH
  cte_a AS (SELECT ...),    -- calculée en premier
  cte_b AS (SELECT ... FROM cte_a ...)  -- peut référencer cte_a
SELECT * FROM cte_b WHERE ...;
```

Depuis **PostgreSQL 12**, une CTE utilisée **une seule fois** est inlinée (`NOT MATERIALIZED` par défaut) : le planner peut pousser les filtres dedans. Une CTE référencée **plusieurs fois** est matérialisée une seule fois (`MATERIALIZED`). Tu peux forcer le comportement :

```sql
WITH stats AS MATERIALIZED (     -- force l'exécution une seule fois
  SELECT family_id, COUNT(*) AS nb FROM posts GROUP BY family_id
)
SELECT * FROM stats WHERE nb > 10;
```

### CTE récursive

La CTE récursive traverse les **structures hiérarchiques** (arbres, graphes) en répétant un terme jusqu'à épuisement.

```sql
WITH RECURSIVE nom AS (
    -- Terme initial (anchor) : point de départ, exécuté une fois
    SELECT ... FROM ... WHERE ...
    UNION ALL
    -- Terme récursif : référence nom, exécuté sur les résultats de l'étape précédente
    SELECT ... FROM ... JOIN nom ON ...
)
SELECT * FROM nom;
```

Exécution : étape 0 (anchor) → étape 1 (terme récursif sur l'étape 0) → étape 2 → … → étape N (résultat vide → STOP). Résultat final = union de toutes les étapes.

**Condition d'arrêt :** le terme récursif doit produire zéro ligne à un moment — sinon boucle infinie. Ajouter une condition `WHERE` sur la profondeur ou détecter les cycles avec `CYCLE` (PostgreSQL 14+).

### LATERAL

Un join `LATERAL` permet à une sous-requête dans `FROM` de **référencer les colonnes des tables précédentes** — impossible dans un `JOIN` ordinaire.

```sql
SELECT f.id, top_post.*
FROM families f
CROSS JOIN LATERAL (
    SELECT p.id, COUNT(r.id) AS nb_reactions
    FROM posts p
    LEFT JOIN reactions r ON r.post_id = p.id
    WHERE p.family_id = f.id           -- f.id visible grâce à LATERAL
    GROUP BY p.id
    ORDER BY nb_reactions DESC
    LIMIT 3
) top_post;
-- Retourne les 3 posts les plus aimés pour chaque famille, une ligne par post.
```

Cas `LEFT JOIN LATERAL … ON true` : inclut les familles sans aucun post (lignes NULL du côté latéral).

### GROUPING SETS, ROLLUP, CUBE

Produisent plusieurs niveaux d'agrégation en une seule requête, évitant plusieurs `UNION ALL`.

```sql
-- GROUPING SETS : liste explicite des combinaisons
GROUP BY GROUPING SETS ((family_id, week), (family_id), ())
-- Equivalent à :  GROUP BY family_id, week
--           UNION GROUP BY family_id
--           UNION (total général)

-- ROLLUP(a, b) : sous-totaux hiérarchiques (a,b) → (a) → ()
GROUP BY ROLLUP (family_id, week)

-- CUBE(a, b) : toutes les combinaisons (a,b) → (a) → (b) → ()
GROUP BY CUBE (family_id, week)
```

`GROUPING(col)` retourne 1 si la colonne est agrégée (NULL de sous-total), 0 si c'est une vraie valeur — utile pour distinguer un NULL réel d'un sous-total.

### Agrégats filtrés avec FILTER

`FILTER` conditionne un agrégat sans recourir à `CASE WHEN` :

```sql
SELECT
  family_id,
  COUNT(*)                                          AS total_posts,
  COUNT(*) FILTER (WHERE nb_reactions >= 10)        AS posts_populaires,
  SUM(nb_reactions) FILTER (WHERE created_at > now() - INTERVAL '7 days') AS reactions_semaine
FROM post_stats
GROUP BY family_id;
```

Plus lisible que `SUM(CASE WHEN ... THEN 1 ELSE 0 END)`, et optimisé de la même façon par le planner.

## 3. Worked examples

### Exemple A — Classement des posts TribuZen par popularité (fenêtre + LAG)

Objectif : retourner les 10 posts de la famille 1 classés par nombre de réactions, avec leur rang, la variation vs le post précédent dans le temps, et le rang par auteur.

```sql
-- Schéma minimal TribuZen pour cet exemple
CREATE TABLE families  (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE users     (id SERIAL PRIMARY KEY, display_name TEXT NOT NULL);
CREATE TABLE posts (
  id         SERIAL PRIMARY KEY,
  family_id  INT NOT NULL REFERENCES families(id),
  author_id  INT NOT NULL REFERENCES users(id),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE reactions (
  id      SERIAL PRIMARY KEY,
  post_id INT NOT NULL REFERENCES posts(id),
  user_id INT NOT NULL REFERENCES users(id)
);

-- Données de test
INSERT INTO families VALUES (1, 'Famille Dupont'), (2, 'Famille Martin');
INSERT INTO users VALUES
  (1,'Alice'),(2,'Bob'),(3,'Charlie'),(4,'Diana'),(5,'Eve');
INSERT INTO posts VALUES
  (1,1,1,'Premier post',  now() - INTERVAL '10 days'),
  (2,1,2,'Deuxième post', now() - INTERVAL '8 days'),
  (3,1,1,'Troisième post',now() - INTERVAL '5 days'),
  (4,1,3,'Quatrième post',now() - INTERVAL '3 days'),
  (5,1,2,'Cinquième post',now() - INTERVAL '1 day'),
  (6,2,4,'Post famille 2',now() - INTERVAL '2 days');
INSERT INTO reactions (post_id, user_id)
  SELECT p, u FROM (VALUES
    (1,2),(1,3),(1,4),
    (2,1),(2,3),(2,4),(2,5),
    (3,2),(3,4),
    (4,1),(4,2),(4,3),(4,4),(4,5),
    (5,1)
  ) AS v(p, u);
```

```sql
WITH post_stats AS (
  -- 1. Agréger les réactions : une ligne par post
  SELECT
    p.id,
    p.author_id,
    u.display_name,
    p.content,
    p.created_at,
    COUNT(r.id) AS nb_reactions
  FROM posts p
  JOIN users u ON u.id = p.author_id
  LEFT JOIN reactions r ON r.post_id = p.id
  WHERE p.family_id = 1
  GROUP BY p.id, p.author_id, u.display_name, p.content, p.created_at
)
SELECT
  id,
  display_name,
  content,
  nb_reactions,
  -- 2. Rang global par popularité (RANK pour les ex-aequo)
  RANK()       OVER (ORDER BY nb_reactions DESC)                         AS rang_global,
  -- 3. Rang de l'auteur dans ses propres posts (popularité relative)
  ROW_NUMBER() OVER (PARTITION BY author_id ORDER BY nb_reactions DESC)  AS rang_auteur,
  -- 4. Tendance : variation vs le post chronologiquement précédent
  nb_reactions - LAG(nb_reactions, 1, 0)
                OVER (ORDER BY created_at)                               AS variation
FROM post_stats
ORDER BY nb_reactions DESC
LIMIT 10;
```

```
 id │ display_name │ content        │ nb_reactions │ rang_global │ rang_auteur │ variation
────┼──────────────┼────────────────┼──────────────┼─────────────┼─────────────┼──────────
  4 │ Charlie      │ Quatrième post │ 5            │ 1           │ 1           │ 3
  2 │ Bob          │ Deuxième post  │ 4            │ 2           │ 1           │ 1
  1 │ Alice        │ Premier post   │ 3            │ 3           │ 2           │ 3
  3 │ Alice        │ Troisième post │ 2            │ 4           │ 1           │ -1
  5 │ Bob          │ Cinquième post │ 1            │ 5           │ 2           │ -1
```

Pas-à-pas : (1) la CTE `post_stats` isole l'agrégation des réactions — résultat matérialisé une seule fois ; (2) `RANK()` sur `nb_reactions DESC` donne le classement global : si deux posts avaient 4 réactions, ils partageraient le rang 2 et le suivant serait rang 4 ; (3) `ROW_NUMBER()` avec `PARTITION BY author_id` crée un classement **indépendant par auteur** — les fonctions fenêtre dans la même requête peuvent avoir des `OVER` différents ; (4) `LAG(..., 1, 0)` récupère les réactions du post précédent dans le temps (0 par défaut pour le premier) — `variation` positive = le post a reçu plus de réactions que le précédent.

### Exemple B — Arbre généalogique TribuZen (CTE récursive)

Objectif : parcourir l'arbre des membres d'une famille depuis un ancêtre donné, calculer le niveau de chaque membre, et générer le chemin complet.

```sql
-- Table membres avec lien parent (arbre généalogique)
CREATE TABLE members (
  id        SERIAL PRIMARY KEY,
  family_id INT NOT NULL REFERENCES families(id),
  user_id   INT NOT NULL REFERENCES users(id),
  parent_id INT REFERENCES members(id)  -- NULL = racine de l'arbre
);

INSERT INTO members (id, family_id, user_id, parent_id) VALUES
  (1, 1, 1, NULL),   -- Alice, racine (grand-parent)
  (2, 1, 2, 1),      -- Bob,    enfant d'Alice
  (3, 1, 3, 1),      -- Charlie, enfant d'Alice
  (4, 1, 4, 2),      -- Diana,  petite-fille (enfant de Bob)
  (5, 1, 5, 2),      -- Eve,    petite-fille (enfant de Bob)
  (6, 1, 1, 3);      -- (autre branche, enfant de Charlie)
```

```sql
-- Parcourir tous les descendants d'Alice (id = 1), niveau et chemin
WITH RECURSIVE arbre AS (
    -- Anchor : Alice elle-même
    SELECT
      m.id,
      u.display_name,
      m.parent_id,
      0                              AS niveau,
      ARRAY[m.id]                    AS chemin,
      u.display_name::TEXT           AS chemin_noms
    FROM members m
    JOIN users u ON u.id = m.user_id
    WHERE m.id = 1

    UNION ALL

    -- Récursif : enfants directs des membres déjà dans l'arbre
    SELECT
      m.id,
      u.display_name,
      m.parent_id,
      a.niveau + 1,
      a.chemin || m.id,
      a.chemin_noms || ' → ' || u.display_name
    FROM members m
    JOIN users u ON u.id = m.user_id
    JOIN arbre a ON m.parent_id = a.id
    WHERE NOT (m.id = ANY(a.chemin))   -- protection anti-cycle (données corrompues)
)
SELECT
  REPEAT('  ', niveau) || display_name  AS arbre_affiche,
  niveau,
  chemin_noms
FROM arbre
ORDER BY chemin;
```

```
 arbre_affiche  │ niveau │ chemin_noms
────────────────┼────────┼─────────────────────────────
Alice           │      0 │ Alice
  Bob           │      1 │ Alice → Bob
    Diana       │      2 │ Alice → Bob → Diana
    Eve         │      2 │ Alice → Bob → Eve
  Charlie       │      1 │ Alice → Charlie
    Alice       │      2 │ Alice → Charlie → Alice
```

Pas-à-pas : (1) le terme anchor sélectionne la racine avec `niveau = 0` et initialise `chemin` comme un tableau d'IDs — `ARRAY[m.id]` est un tableau PostgreSQL ; (2) le terme récursif joint les membres dont `parent_id` est dans le résultat courant (`arbre.id`) — c'est la définition de "descendant direct" ; (3) `chemin_noms || ' → ' || display_name` concatène le chemin textuel à chaque étape grâce à la valeur portée par la récursion ; (4) `WHERE NOT (m.id = ANY(a.chemin))` empêche une boucle infinie si les données ont un cycle (ex. un enfant est en même temps ancêtre) ; (5) `ORDER BY chemin` trie par tableau d'IDs — PostgreSQL compare les tableaux lexicographiquement, ce qui produit un parcours en profondeur naturel.

## 4. Pièges & misconceptions

- **`RANK()` crée des trous, `DENSE_RANK()` non.** Deux posts ex-aequo rang 2 font que le suivant est rang 4 avec `RANK()`, rang 3 avec `DENSE_RANK()`. *Correct* : choisir en fonction du besoin métier — `RANK()` pour "le 3ᵉ de podium", `DENSE_RANK()` pour "le 3ᵉ niveau de popularité distinct".

- **`LAST_VALUE` retourne souvent la ligne courante.** Le frame par défaut est `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`, donc `LAST_VALUE` dans ce frame = la ligne courante. *Correct* : toujours spécifier `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` avec `LAST_VALUE` pour obtenir la dernière ligne de la partition.

- **CTE récursive sans condition d'arrêt → boucle infinie.** Si le terme récursif ne produit jamais zéro ligne, PostgreSQL tourne jusqu'à l'erreur mémoire. *Correct* : toujours inclure une condition `WHERE` qui converge (profondeur max, `NOT (id = ANY(chemin))`, ou clause `CYCLE` de PG 14+). Tester sur de petits jeux de données avant de lancer sur la production.

- **`CROSS JOIN LATERAL` vs `LEFT JOIN LATERAL … ON true`.** `CROSS JOIN LATERAL` ne retourne rien pour les lignes de gauche dont la sous-requête est vide (comportement `INNER JOIN`). *Correct* : utiliser `LEFT JOIN LATERAL … ON true` pour inclure les familles sans aucun post (la sous-requête latérale retourne NULL).

- **Fonctions fenêtre dans WHERE ou HAVING.** `SELECT rank() OVER (...) AS r FROM t WHERE r < 3` échoue : les fonctions fenêtre sont évaluées après `WHERE` et `HAVING`. *Correct* : encapsuler dans une sous-requête ou une CTE, puis filtrer dans la requête externe.

- **CTE pas toujours plus rapide qu'une sous-requête.** En PG 12+, une CTE utilisée une seule fois est `NOT MATERIALIZED` par défaut : le planner peut pousser les prédicats dedans et utiliser des index. Mais `WITH stats AS MATERIALIZED (...)` force la matérialisation — utile pour éviter de recalculer une CTE lourde appelée deux fois, contre-productif pour une CTE simple filtrée ensuite.

- **`FILTER` ne remplace pas les index.** `COUNT(*) FILTER (WHERE family_id = 1)` dans une grosse agrégation scanne quand même toutes les lignes — `FILTER` conditionne l'agrégation, pas la lecture. *Correct* : filtrer en amont avec `WHERE` ou sur une CTE pré-filtrée.

## 5. Ancrage TribuZen

Couche fil-rouge : **classement des posts et arbre généalogique** dans `smaurier/tribuzen`.

- **`ROW_NUMBER()` pour la pagination du feed** : numéroter les posts par date décroissante dans une famille et paginer avec `WHERE rn BETWEEN 11 AND 20` — pattern keyset plus fiable que `OFFSET` sur un flux qui change en temps réel.

- **`RANK()` pour le dashboard "top posts"** : le dashboard famille affiche le top 10 hebdomadaire. Deux posts ex-aequo méritent le même rang — `RANK()` est le bon choix ; `ROW_NUMBER()` donnerait un rang arbitraire pour des popularités identiques.

- **`LAG()` pour la tendance** : l'indicateur ↑/↓ (variation de réactions vs le post précédent) est calculé en une seule fenêtre sans sous-requête supplémentaire. La colonne `variation` dans l'Exemple A pilote directement le composant Vue `<TrendBadge>`.

- **CTE récursive pour l'arbre familial** : la page profil d'un membre affiche ses ancêtres et descendants directs. La CTE récursive (Exemple B) est exécutée avec un `LIMIT 200` de sécurité et un filtre `WHERE niveau <= 5` pour éviter de traverser des arbres trop profonds. En session, la requête tourne sur Docker avec les seeds TribuZen.

- **`LATERAL` pour les tops par famille** : la page admin liste les 3 posts les plus aimés de chaque famille en une seule requête `CROSS JOIN LATERAL (... LIMIT 3)` — sans `LATERAL`, il faudrait une requête par famille ou une sous-requête corrélée plus lente.

- **`GROUPING SETS` pour les stats admin** : le tableau de bord admin affiche `posts par famille`, `posts par semaine`, et `total général` en une seule requête — évitant trois `UNION ALL`. `GROUPING(family_id) = 1` détecte les lignes de sous-total vs les lignes normales avec `family_id` NULL réel.

## 6. Points clés

1. Une fonction fenêtre enrichit chaque ligne sans réduire le résultat — `OVER (...)` distingue la fenêtre d'un agrégat `GROUP BY`.
2. `ROW_NUMBER()` : numéros uniques sans ex-aequo (pagination). `RANK()` : ex-aequo + trous. `DENSE_RANK()` : ex-aequo sans trous (classements).
3. `LAG(expr, offset, défaut)` / `LEAD(expr, offset, défaut)` : accéder aux lignes voisines sans jointure.
4. `PARTITION BY` découpe la fenêtre en groupes indépendants ; la **frame clause** (`ROWS BETWEEN …`) délimite les lignes incluses dans le calcul.
5. CTE (`WITH …`) : nommer des sous-résultats pour la lisibilité. PG 12+ : `NOT MATERIALIZED` par défaut si utilisée une fois, `MATERIALIZED` si plusieurs fois ou forcé.
6. CTE récursive : terme anchor + `UNION ALL` + terme récursif référençant la CTE. Toujours prévoir une condition d'arrêt ; protection anti-cycle avec `NOT (id = ANY(chemin))` ou `CYCLE` (PG 14+).
7. `LATERAL` : sous-requête dans `FROM` qui voit les colonnes des tables précédentes — idéal pour le top-N par groupe. `LEFT JOIN LATERAL … ON true` pour conserver les lignes sans résultat latéral.
8. `FILTER (WHERE …)` : agrégation conditionnelle, plus lisible que `CASE WHEN` ; `GROUPING SETS / ROLLUP / CUBE` : multi-niveaux d'agrégation en une requête.

## 7. Seeds Anki

```
Différence ROW_NUMBER / RANK / DENSE_RANK sur les ex-aequo ?|ROW_NUMBER : numéros uniques arbitraires (pas d'ex-aequo). RANK : même rang + trous (deux 2ᵉ → le suivant est 4ᵉ). DENSE_RANK : même rang sans trou (deux 2ᵉ → le suivant est 3ᵉ)
Comment récupérer la valeur de la ligne précédente dans une fenêtre ?|LAG(expression, offset, défaut) OVER (PARTITION BY … ORDER BY …). Offset = 1 par défaut. Défaut = NULL si non fourni, sinon la valeur spécifiée quand la ligne précédente n'existe pas
Quelle frame clause utiliser pour un total cumulé (running total) ?|ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW — accumule du début de la partition jusqu'à la ligne courante
Pourquoi LAST_VALUE retourne-t-il souvent la ligne courante ?|Le frame par défaut est RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW. Solution : spécifier ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING pour que LAST_VALUE voie toutes les lignes
Comment écrire une CTE récursive en PostgreSQL ?|WITH RECURSIVE nom AS (terme_anchor UNION ALL terme_recursif_qui_reference_nom) SELECT * FROM nom. La récursion s'arrête quand le terme récursif produit zéro ligne
Que se passe-t-il si une CTE récursive n'a pas de condition d'arrêt ?|Boucle infinie jusqu'à l'erreur mémoire. Prévenir avec : condition WHERE qui converge (profondeur max, NOT (id = ANY(chemin))), ou clause CYCLE (PG 14+)
Différence CROSS JOIN LATERAL et LEFT JOIN LATERAL … ON true ?|CROSS JOIN LATERAL = INNER JOIN : exclut les lignes de gauche sans résultat latéral. LEFT JOIN LATERAL … ON true = inclut ces lignes avec NULL côté latéral
Pourquoi ne peut-on pas filtrer sur une fonction fenêtre dans WHERE ?|Les fonctions fenêtre sont évaluées après WHERE et HAVING. Encapsuler dans une sous-requête ou une CTE, puis filtrer dans la requête externe
Comment calculer plusieurs agrégations conditionnelles dans un GROUP BY ?|COUNT(*) FILTER (WHERE condition) — plus lisible que SUM(CASE WHEN ... THEN 1 ELSE 0 END) et optimisé de façon identique par le planner
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-12-window-functions-cte/`. Tu y écris les requêtes du feed TribuZen classé par popularité (RANK + LAG), tu traverses l'arbre généalogique avec une CTE récursive, et tu génères les stats admin en une seule requête GROUPING SETS. Corrigé SQL inline dans le README, aucun fichier séparé.
