# Lab 12 — Fonctions avancées SQL

> **Module associé :** [12 — Fonctions avancées SQL](../../modules/12-fonctions-avancees-sql.md)
> **Vrai outil :** PostgreSQL 17 — psql ou tout client SQL sur une base Docker locale.
> **Durée estimée :** 60 min

## Objectifs

- Classer des posts par popularité avec `RANK`, `ROW_NUMBER`, `LAG`
- Parcourir un arbre généalogique TribuZen avec une CTE récursive
- Extraire le top-N par famille avec `LATERAL`
- Produire des statistiques multi-niveaux avec `GROUPING SETS`
- Filtrer des agrégats avec `FILTER`

---

## Setup — Schéma TribuZen

```sql
-- Réinitialisation complète (à exécuter une fois)
DROP TABLE IF EXISTS reactions, posts, members, users, families CASCADE;

CREATE TABLE families (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE users (
  id           SERIAL PRIMARY KEY,
  display_name TEXT NOT NULL
);

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

-- Arbre généalogique : parent_id NULL = racine
CREATE TABLE members (
  id        SERIAL PRIMARY KEY,
  family_id INT NOT NULL REFERENCES families(id),
  user_id   INT NOT NULL REFERENCES users(id),
  parent_id INT REFERENCES members(id)
);
```

## Seed data

```sql
-- Familles
INSERT INTO families (id, name) VALUES
  (1, 'Famille Dupont'),
  (2, 'Famille Martin'),
  (3, 'Famille Leblanc');

-- Membres / utilisateurs
INSERT INTO users (id, display_name) VALUES
  (1, 'Alice'),
  (2, 'Bob'),
  (3, 'Charlie'),
  (4, 'Diana'),
  (5, 'Eve'),
  (6, 'Frank'),
  (7, 'Grace');

-- Posts : familles 1 et 2, répartis sur 3 semaines
INSERT INTO posts (id, family_id, author_id, content, created_at) VALUES
  (1,  1, 1, 'Premier post Alice',    now() - INTERVAL '20 days'),
  (2,  1, 2, 'Bob partage une photo', now() - INTERVAL '18 days'),
  (3,  1, 1, 'Anniversaire !',        now() - INTERVAL '15 days'),
  (4,  1, 3, 'Sortie famille',        now() - INTERVAL '10 days'),
  (5,  1, 2, 'Nouvelle recette',      now() - INTERVAL '7 days'),
  (6,  1, 1, 'Réunion de clan',       now() - INTERVAL '3 days'),
  (7,  1, 4, 'Bienvenue !',           now() - INTERVAL '1 day'),
  (8,  2, 5, 'Hello depuis Martin',   now() - INTERVAL '12 days'),
  (9,  2, 6, 'Vacances !',            now() - INTERVAL '5 days'),
  (10, 3, 7, 'Seul post Leblanc',     now() - INTERVAL '2 days');

-- Réactions (données volontairement inégales pour tester RANK)
INSERT INTO reactions (post_id, user_id) VALUES
  -- post 1 : 3 réactions
  (1,2),(1,3),(1,4),
  -- post 2 : 5 réactions
  (2,1),(2,3),(2,4),(2,5),(2,6),
  -- post 3 : 5 réactions (ex-aequo avec post 2)
  (3,1),(3,2),(3,4),(3,5),(3,6),
  -- post 4 : 7 réactions
  (4,1),(4,2),(4,3),(4,5),(4,6),(4,7),(4,2),
  -- post 5 : 2 réactions
  (5,3),(5,4),
  -- post 6 : 4 réactions
  (6,1),(6,2),(6,3),(6,4),
  -- post 7 : 1 réaction
  (7,1),
  -- famille 2
  (8,1),(8,2),(8,3),
  (9,1),(9,2),(9,3),(9,4),(9,5);

-- Arbre généalogique famille 1 (5 membres, 3 niveaux)
-- Alice (1) est la racine
-- Bob (2) et Charlie (3) sont enfants d'Alice
-- Diana (4) et Eve (5) sont enfants de Bob
INSERT INTO members (id, family_id, user_id, parent_id) VALUES
  (1, 1, 1, NULL),  -- Alice   — génération 0 (racine)
  (2, 1, 2, 1),     -- Bob     — génération 1
  (3, 1, 3, 1),     -- Charlie — génération 1
  (4, 1, 4, 2),     -- Diana   — génération 2
  (5, 1, 5, 2);     -- Eve     — génération 2
```

---

## Exercice 1 — Classement des posts par popularité (RANK + ROW_NUMBER)

**Objectif :** afficher tous les posts de la famille 1 avec le nombre de réactions, le rang global par popularité, et le numéro de séquence de l'auteur dans ses propres posts.

```sql
-- TODO : remplir les trous (???)
WITH post_stats AS (
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
  nb_reactions,
  ???() OVER (ORDER BY nb_reactions DESC) AS rang_global,
  ???() OVER (PARTITION BY ??? ORDER BY nb_reactions DESC) AS rang_auteur
FROM post_stats
ORDER BY rang_global, rang_auteur;
```

**Corrigé :**

```sql
WITH post_stats AS (
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
  nb_reactions,
  RANK()       OVER (ORDER BY nb_reactions DESC)                        AS rang_global,
  ROW_NUMBER() OVER (PARTITION BY author_id ORDER BY nb_reactions DESC) AS rang_auteur
FROM post_stats
ORDER BY rang_global, rang_auteur;
```

**Résultat attendu (extrait) :**
- Post 4 (7 réactions) → rang\_global = 1
- Posts 2 et 3 (5 réactions chacun) → rang\_global = 2 (ex-aequo, RANK saute le rang 3)
- Post suivant → rang\_global = 4

---

## Exercice 2 — Tendance de popularité (LAG)

**Objectif :** pour chaque post de la famille 1 trié par date, afficher la variation du nombre de réactions par rapport au post précédent dans le temps.

```sql
-- TODO : compléter la fenêtre LAG
WITH post_stats AS (
  SELECT
    p.id, p.content, p.created_at,
    COUNT(r.id) AS nb_reactions
  FROM posts p
  LEFT JOIN reactions r ON r.post_id = p.id
  WHERE p.family_id = 1
  GROUP BY p.id, p.content, p.created_at
)
SELECT
  id,
  content,
  nb_reactions,
  LAG(???, 1, 0) OVER (ORDER BY ???) AS reactions_post_precedent,
  nb_reactions - LAG(nb_reactions, 1, 0) OVER (ORDER BY created_at) AS variation
FROM post_stats
ORDER BY created_at;
```

**Corrigé :**

```sql
WITH post_stats AS (
  SELECT
    p.id, p.content, p.created_at,
    COUNT(r.id) AS nb_reactions
  FROM posts p
  LEFT JOIN reactions r ON r.post_id = p.id
  WHERE p.family_id = 1
  GROUP BY p.id, p.content, p.created_at
)
SELECT
  id,
  content,
  nb_reactions,
  LAG(nb_reactions, 1, 0) OVER (ORDER BY created_at) AS reactions_post_precedent,
  nb_reactions - LAG(nb_reactions, 1, 0) OVER (ORDER BY created_at) AS variation
FROM post_stats
ORDER BY created_at;
```

**Points de vérification :**
- Le premier post a `reactions_post_precedent = 0` (valeur par défaut du 3ᵉ argument de `LAG`)
- `variation` peut être négative (popularité en baisse vs post précédent)

---

## Exercice 3 — CTE pour lisibilité (refactoring)

**Objectif :** réécrire la requête suivante (sous-requêtes imbriquées, illisible) avec des CTEs nommées.

```sql
-- Version illisible à refactoriser
SELECT
  f.name                       AS famille,
  auteurs.nb_auteurs,
  top.meilleur_post,
  top.max_reactions
FROM families f
JOIN (
  SELECT p.family_id, COUNT(DISTINCT p.author_id) AS nb_auteurs
  FROM posts p
  GROUP BY p.family_id
) auteurs ON auteurs.family_id = f.id
JOIN (
  SELECT ps.family_id, ps.content AS meilleur_post, ps.nb AS max_reactions
  FROM (
    SELECT p.family_id, p.content,
           COUNT(r.id) AS nb,
           RANK() OVER (PARTITION BY p.family_id ORDER BY COUNT(r.id) DESC) AS rnk
    FROM posts p
    LEFT JOIN reactions r ON r.post_id = p.id
    GROUP BY p.family_id, p.id, p.content
  ) ps
  WHERE ps.rnk = 1
) top ON top.family_id = f.id;
```

**TODO :** Réécrire avec au moins deux CTEs (`auteurs_par_famille`, `posts_avec_rang`).

**Corrigé :**

```sql
WITH
-- CTE 1 : nombre d'auteurs distincts par famille
auteurs_par_famille AS (
  SELECT
    family_id,
    COUNT(DISTINCT author_id) AS nb_auteurs
  FROM posts
  GROUP BY family_id
),
-- CTE 2 : rang de chaque post par popularité, par famille
posts_avec_rang AS (
  SELECT
    p.family_id,
    p.content,
    COUNT(r.id)                                                     AS nb_reactions,
    RANK() OVER (PARTITION BY p.family_id ORDER BY COUNT(r.id) DESC) AS rnk
  FROM posts p
  LEFT JOIN reactions r ON r.post_id = p.id
  GROUP BY p.family_id, p.id, p.content
),
-- CTE 3 : garder uniquement le meilleur post par famille
meilleur_post AS (
  SELECT family_id, content AS meilleur_post, nb_reactions AS max_reactions
  FROM posts_avec_rang
  WHERE rnk = 1
)
SELECT
  f.name         AS famille,
  a.nb_auteurs,
  m.meilleur_post,
  m.max_reactions
FROM families f
JOIN auteurs_par_famille a ON a.family_id = f.id
JOIN meilleur_post       m ON m.family_id = f.id;
```

---

## Exercice 4 — CTE récursive : arbre généalogique

**Objectif :** à partir du membre racine (Alice, id = 1), lister tous les membres de l'arbre avec leur niveau (génération) et le chemin complet de noms.

```sql
-- TODO : compléter la CTE récursive
WITH RECURSIVE arbre AS (
    -- Anchor : racine
    SELECT
      m.id,
      u.display_name,
      m.parent_id,
      0                    AS niveau,
      ARRAY[m.id]          AS chemin,
      u.display_name::TEXT AS chemin_noms
    FROM members m
    JOIN users u ON u.id = m.user_id
    WHERE m.id = 1

    UNION ALL

    -- Récursif : ???
    SELECT
      ???
    FROM members m
    JOIN users u ON ???
    JOIN arbre a ON ???
    WHERE NOT (m.id = ANY(a.chemin))
)
SELECT
  REPEAT('  ', niveau) || display_name AS affichage,
  niveau,
  chemin_noms
FROM arbre
ORDER BY chemin;
```

**Corrigé :**

```sql
WITH RECURSIVE arbre AS (
    -- Anchor : Alice, racine de l'arbre
    SELECT
      m.id,
      u.display_name,
      m.parent_id,
      0                    AS niveau,
      ARRAY[m.id]          AS chemin,
      u.display_name::TEXT AS chemin_noms
    FROM members m
    JOIN users u ON u.id = m.user_id
    WHERE m.id = 1

    UNION ALL

    -- Récursif : enfants directs des membres déjà traversés
    SELECT
      m.id,
      u.display_name,
      m.parent_id,
      a.niveau + 1,
      a.chemin || m.id,
      a.chemin_noms || ' → ' || u.display_name
    FROM members m
    JOIN users u ON u.id = m.user_id
    JOIN arbre  a ON m.parent_id = a.id
    WHERE NOT (m.id = ANY(a.chemin))  -- protection anti-cycle
)
SELECT
  REPEAT('  ', niveau) || display_name AS affichage,
  niveau,
  chemin_noms
FROM arbre
ORDER BY chemin;
```

**Résultat attendu :**

```
Alice              | 0 | Alice
  Bob              | 1 | Alice → Bob
    Diana          | 2 | Alice → Bob → Diana
    Eve            | 2 | Alice → Bob → Eve
  Charlie          | 1 | Alice → Charlie
```

**Variante :** inverser — trouver tous les **ancêtres** de Diana (id = 4), de la feuille vers la racine :

```sql
WITH RECURSIVE ancetres AS (
    SELECT m.id, u.display_name, m.parent_id, 0 AS niveau
    FROM members m
    JOIN users u ON u.id = m.user_id
    WHERE m.id = 4  -- Diana

    UNION ALL

    SELECT m.id, u.display_name, m.parent_id, a.niveau + 1
    FROM members m
    JOIN users u ON u.id = m.user_id
    JOIN ancetres a ON m.id = a.parent_id
)
SELECT display_name, niveau FROM ancetres ORDER BY niveau;
-- Diana (0) → Bob (1) → Alice (2)
```

---

## Exercice 5 — Top-3 posts par famille (LATERAL)

**Objectif :** lister les 3 posts les plus aimés pour **chaque** famille en une seule requête.

```sql
-- TODO : remplacer ??? par LATERAL
SELECT
  f.name AS famille,
  top.content,
  top.nb_reactions
FROM families f
??? (
  SELECT p.content, COUNT(r.id) AS nb_reactions
  FROM posts p
  LEFT JOIN reactions r ON r.post_id = p.id
  WHERE p.family_id = f.id
  GROUP BY p.id, p.content
  ORDER BY nb_reactions DESC
  LIMIT 3
) top ON true;
```

**Corrigé :**

```sql
SELECT
  f.name AS famille,
  top.content,
  top.nb_reactions
FROM families f
LEFT JOIN LATERAL (
  SELECT p.content, COUNT(r.id) AS nb_reactions
  FROM posts p
  LEFT JOIN reactions r ON r.post_id = p.id
  WHERE p.family_id = f.id    -- f.id visible grâce à LATERAL
  GROUP BY p.id, p.content
  ORDER BY nb_reactions DESC
  LIMIT 3
) top ON true
ORDER BY f.name, top.nb_reactions DESC;
```

**Points de vérification :**
- La famille Leblanc (1 seul post) apparaît dans le résultat avec ce post unique
- `LEFT JOIN LATERAL … ON true` conserve la famille même si la sous-requête retourne zéro ligne
- `CROSS JOIN LATERAL` exclurait la famille Leblanc si elle n'avait aucun post

---

## Exercice 6 — Statistiques multi-niveaux (GROUPING SETS + FILTER)

**Objectif :** produire en une seule requête le tableau de bord admin :
- Nombre de posts et total de réactions par famille
- Sous-total par semaine (posts des 7 derniers jours vs anciens)
- Total général

```sql
-- TODO : compléter GROUPING SETS et FILTER
WITH post_stats AS (
  SELECT
    p.family_id,
    f.name AS famille,
    p.id   AS post_id,
    COUNT(r.id) AS nb_reactions,
    CASE WHEN p.created_at > now() - INTERVAL '7 days'
         THEN 'cette semaine' ELSE 'archives' END AS periode
  FROM posts p
  JOIN families f ON f.id = p.family_id
  LEFT JOIN reactions r ON r.post_id = p.id
  GROUP BY p.family_id, f.name, p.id, p.created_at
)
SELECT
  CASE WHEN GROUPING(famille) = 1 THEN 'TOUTES' ELSE famille END  AS famille,
  CASE WHEN GROUPING(periode) = 1 THEN 'TOTAL'  ELSE periode END  AS periode,
  COUNT(post_id)                                                    AS nb_posts,
  SUM(nb_reactions)                                                 AS total_reactions,
  COUNT(post_id) FILTER (WHERE nb_reactions >= ???)                 AS posts_populaires
FROM post_stats
GROUP BY ???
ORDER BY GROUPING(famille), famille, GROUPING(periode), periode;
```

**Corrigé :**

```sql
WITH post_stats AS (
  SELECT
    p.family_id,
    f.name      AS famille,
    p.id        AS post_id,
    COUNT(r.id) AS nb_reactions,
    CASE WHEN p.created_at > now() - INTERVAL '7 days'
         THEN 'cette semaine' ELSE 'archives' END AS periode
  FROM posts p
  JOIN families f ON f.id = p.family_id
  LEFT JOIN reactions r ON r.post_id = p.id
  GROUP BY p.family_id, f.name, p.id, p.created_at
)
SELECT
  CASE WHEN GROUPING(famille) = 1 THEN 'TOUTES' ELSE famille END  AS famille,
  CASE WHEN GROUPING(periode) = 1 THEN 'TOTAL'  ELSE periode END  AS periode,
  COUNT(post_id)                                                    AS nb_posts,
  SUM(nb_reactions)                                                 AS total_reactions,
  COUNT(post_id) FILTER (WHERE nb_reactions >= 3)                  AS posts_populaires
FROM post_stats
GROUP BY GROUPING SETS (
  (famille, periode),  -- détail : par famille + période
  (famille),           -- sous-total par famille (toutes périodes)
  ()                   -- total général
)
ORDER BY GROUPING(famille), famille, GROUPING(periode), periode;
```

**Résultat attendu (extrait) :**

```
famille          | periode        | nb_posts | total_reactions | posts_populaires
Famille Dupont   | archives       |        5 |              21 |               3
Famille Dupont   | cette semaine  |        2 |               5 |               1
Famille Dupont   | TOTAL          |        7 |              26 |               4
Famille Leblanc  | cette semaine  |        1 |               0 |               0
Famille Leblanc  | TOTAL          |        1 |               0 |               0
Famille Martin   | archives       |        1 |               3 |               1
Famille Martin   | cette semaine  |        1 |               5 |               1
Famille Martin   | TOTAL          |        2 |               8 |               2
TOUTES           | TOTAL          |       10 |              34 |               6
```

**Point clé :** `GROUPING(famille) = 1` détecte les lignes de sous-total (où `famille` est NULL parce qu'agrégé) vs les lignes avec un vrai `NULL` dans la colonne — indispensable pour afficher "TOUTES" au lieu de NULL.

---

## Checklist de validation

- [ ] Exo 1 : les posts 2 et 3 partagent `rang_global = 2`, le suivant est rang 4 (pas 3)
- [ ] Exo 2 : le premier post a `reactions_post_precedent = 0` (valeur par défaut LAG)
- [ ] Exo 3 : la requête retourne le même résultat que la version imbriquée originale
- [ ] Exo 4 : Diana a niveau 2, Alice niveau 0 ; la variante remonte Alice → Bob → Diana
- [ ] Exo 5 : Famille Leblanc apparaît avec son unique post (LEFT JOIN LATERAL)
- [ ] Exo 6 : la ligne `TOUTES | TOTAL` affiche le cumul des 3 familles

## Aller plus loin

- Ajouter une clause `CYCLE id SET is_cycle USING path` (PG 14+) à l'exercice 4 pour détecter les cycles sans la protection manuelle `NOT (id = ANY(chemin))`
- Réécrire l'exercice 5 avec `ROW_NUMBER() OVER (PARTITION BY family_id ORDER BY nb_reactions DESC)` et comparer le plan `EXPLAIN ANALYZE` avec la version `LATERAL + LIMIT`
- Utiliser `ROLLUP(famille, periode)` à la place de `GROUPING SETS` dans l'exercice 6 et vérifier que le résultat est identique
