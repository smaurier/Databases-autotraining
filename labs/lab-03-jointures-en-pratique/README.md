# Lab 03 — Jointures en pratique

> **Vrai outil :** PostgreSQL 17 — requêtes SQL exécutées sur une base locale (Docker ou installation native).
> **Durée estimée :** 60–90 min
> **Prérequis :** lab-01 (setup), lab-02 (CRUD)

---

## Contexte TribuZen

Tu travailles sur la couche base de données de TribuZen. Les deux écrans prioritaires — **liste des membres d'une famille** et **fil de posts avec auteur** — nécessitent des jointures multi-tables. Tu vas créer le schéma, insérer des données, écrire les requêtes, et observer leur plan d'exécution.

---

## Setup

Lance une base PostgreSQL locale (Docker) :

```bash
docker run --name pg-lab03 -e POSTGRES_PASSWORD=lab -e POSTGRES_DB=tribuzen -p 5432:5432 -d postgres:17
psql -h localhost -U postgres -d tribuzen
```

---

## Schéma à créer

```sql
CREATE TABLE users (
    id         TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name  TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE,
    invited_by TEXT REFERENCES users(id)
);

CREATE TABLE family (
    id   TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE family_member (
    family_id TEXT NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT 'member'
              CHECK (role IN ('owner','admin','member','guest')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (family_id, user_id)
);

CREATE TABLE post (
    id        TEXT PRIMARY KEY,
    family_id TEXT NOT NULL REFERENCES family(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id),
    content   TEXT NOT NULL,
    posted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## Données de départ

```sql
INSERT INTO users (id, first_name, last_name, email, invited_by) VALUES
    ('u-1', 'Alice',  'Moreau',   'alice@tribu.fr',  NULL),
    ('u-2', 'Bob',    'Dupont',   'bob@tribu.fr',    'u-1'),
    ('u-3', 'Claire', 'Martin',   'claire@tribu.fr', 'u-1'),
    ('u-4', 'David',  'Lefebvre', 'david@tribu.fr',  'u-2'),
    ('u-5', 'Eva',    'Bernard',  'eva@tribu.fr',    NULL);  -- Eva n'a pas été invitée

INSERT INTO family (id, name) VALUES
    ('fam-1', 'Les Moreau'),
    ('fam-2', 'Les Dupont');

INSERT INTO family_member (family_id, user_id, role, joined_at) VALUES
    ('fam-1', 'u-1', 'owner',  '2025-01-10 10:00:00+00'),
    ('fam-1', 'u-2', 'admin',  '2025-02-15 14:30:00+00'),
    ('fam-1', 'u-3', 'member', '2025-03-01 09:00:00+00'),
    ('fam-2', 'u-4', 'owner',  '2025-01-20 11:00:00+00');
-- u-5 (Eva) n'est membre d'aucune famille

INSERT INTO post (id, family_id, author_id, content, posted_at) VALUES
    ('p-1', 'fam-1', 'u-1', 'Bienvenue dans Les Moreau !',    '2025-03-05 10:00:00+00'),
    ('p-2', 'fam-1', 'u-2', 'Merci pour l invitation',        '2025-03-06 11:00:00+00'),
    ('p-3', 'fam-1', 'u-1', 'Photo du week-end',              '2025-03-08 09:00:00+00'),
    ('p-4', 'fam-2', 'u-4', 'Premiere famille active !',      '2025-03-09 10:00:00+00');
-- Claire (u-3) est membre de fam-1 mais n'a pas encore posté
```

---

## Exercices

### Exercice 1 — INNER JOIN : membres de fam-1 avec prénom/nom

Écris une requête qui affiche `first_name`, `last_name`, `role` et `joined_at` (date seulement) pour tous les membres de `fam-1`, triés par ancienneté.

Résultat attendu :

```
 first_name | last_name | role   | depuis
------------+-----------+--------+------------
 Alice      | Moreau    | owner  | 2025-01-10
 Bob        | Dupont    | admin  | 2025-02-15
 Claire     | Martin    | member | 2025-03-01
```

<details>
<summary>Corrigé</summary>

```sql
SELECT
    u.first_name,
    u.last_name,
    fm.role,
    fm.joined_at::DATE AS depuis
FROM family_member fm
INNER JOIN users u ON fm.user_id = u.id
WHERE fm.family_id = 'fam-1'
ORDER BY fm.joined_at;
```

**Pourquoi INNER JOIN ?** Tout `family_member` valide a une FK vers `users` (contrainte déclarée). L'INNER JOIN est sémantiquement correct : on veut les membres avec leurs informations — une ligne sans utilisateur correspondant serait un bug de données, pas un cas à afficher.

</details>

---

### Exercice 2 — LEFT JOIN : membres + nombre de posts (y compris zéro)

Affiche tous les membres de `fam-1` avec leur nombre de posts dans cette même famille. Les membres qui n'ont pas posté doivent apparaître avec `0`.

Résultat attendu :

```
 first_name | last_name | nb_posts
------------+-----------+----------
 Alice      | Moreau    | 2
 Bob        | Dupont    | 1
 Claire     | Martin    | 0
```

<details>
<summary>Corrigé</summary>

```sql
SELECT
    u.first_name,
    u.last_name,
    COUNT(p.id) AS nb_posts
FROM family_member fm
INNER JOIN users u ON fm.user_id = u.id
LEFT JOIN  post  p ON p.author_id = u.id AND p.family_id = fm.family_id
WHERE fm.family_id = 'fam-1'
GROUP BY u.id, u.first_name, u.last_name
ORDER BY nb_posts DESC;
```

**Points clés :**
- Le filtre `p.family_id = fm.family_id` est dans la clause `ON`, pas dans `WHERE`. Le mettre dans `WHERE` éliminerait les NULL (Claire) et transformerait le LEFT JOIN en INNER JOIN.
- `COUNT(p.id)` ignore les NULL → Claire obtient `0`. `COUNT(*)` lui aurait donné `1` (la ligne existe, ses colonnes post sont juste NULL).

</details>

---

### Exercice 3 — LEFT JOIN : utilisateurs sans famille

Trouve tous les utilisateurs qui ne sont membres d'**aucune** famille. Affiche `first_name`, `last_name`, `email`.

Résultat attendu :

```
 first_name | last_name | email
------------+-----------+----------------
 Eva        | Bernard   | eva@tribu.fr
```

<details>
<summary>Corrigé</summary>

```sql
SELECT u.first_name, u.last_name, u.email
FROM users u
LEFT JOIN family_member fm ON u.id = fm.user_id
WHERE fm.family_id IS NULL;
```

**Pattern "orphelin"** : LEFT JOIN + `WHERE colonne_droite IS NULL`. C'est plus efficace qu'une sous-requête `NOT IN` (voir exercice 5).

</details>

---

### Exercice 4 — Self-join : afficher la chaîne de parrainage

Pour chaque utilisateur, affiche son prénom et le prénom de la personne qui l'a invité (NULL si personne).

Résultat attendu :

```
 membre  | parrain
---------+---------
 Alice   | (null)
 Bob     | Alice
 Claire  | Alice
 David   | Bob
 Eva     | (null)
```

<details>
<summary>Corrigé</summary>

```sql
SELECT
    u.first_name   AS membre,
    inv.first_name AS parrain
FROM users u
LEFT JOIN users inv ON u.invited_by = inv.id
ORDER BY u.first_name;
```

**Self-join** : les deux alias `u` et `inv` pointent vers la même table `users`. Sans `LEFT JOIN`, Alice et Eva disparaîtraient (leur `invited_by` est NULL, pas de correspondance).

</details>

---

### Exercice 5 — EXISTS vs NOT IN avec NULL

**Contexte** : tu veux trouver les utilisateurs qui n'ont invité personne. Deux approches — compare leur comportement.

```sql
-- Approche A : NOT IN
SELECT first_name FROM users
WHERE id NOT IN (SELECT invited_by FROM users);

-- Approche B : NOT EXISTS
SELECT first_name FROM users u
WHERE NOT EXISTS (
    SELECT 1 FROM users inv WHERE inv.invited_by = u.id
);
```

1. Exécute les deux requêtes. Observe la différence de résultats.
2. Corrige l'approche A pour qu'elle retourne les mêmes résultats que B.

<details>
<summary>Corrigé et explication</summary>

```sql
-- Approche A retourne zéro ligne !
-- Pourquoi : invited_by contient NULL pour Alice et Eva.
-- NOT IN (NULL, 'u-1', 'u-2') → chaque comparaison avec NULL donne UNKNOWN → aucune ligne.

-- Correction de l'approche A : filtrer les NULL dans la sous-requête
SELECT first_name FROM users
WHERE id NOT IN (
    SELECT invited_by FROM users WHERE invited_by IS NOT NULL
);

-- Approche B retourne correctement :
-- Eva, Alice (personne n'a cited leur id dans invited_by)
-- Bob, Claire, David ont des utilisateurs qui ont leur id dans invited_by
```

**Règle** : `NOT EXISTS` est immunisé aux NULL. `NOT IN` avec une sous-requête pouvant contenir NULL donne des résultats silencieusement incorrects — toujours filtrer `WHERE colonne IS NOT NULL` ou préférer `NOT EXISTS`.

</details>

---

### Exercice 6 — Jointure 3 tables : posts avec auteur et nom de famille

Affiche tous les posts avec le prénom de l'auteur et le nom de la famille, triés du plus récent au plus ancien.

Résultat attendu :

```
 famille     | auteur | contenu                        | posted_at
-------------+--------+--------------------------------+---------------------
 Les Dupont  | David  | Premiere famille active !      | 2025-03-09 10:00:00
 Les Moreau  | Alice  | Photo du week-end              | 2025-03-08 09:00:00
 Les Moreau  | Bob    | Merci pour l invitation        | 2025-03-06 11:00:00
 Les Moreau  | Alice  | Bienvenue dans Les Moreau !    | 2025-03-05 10:00:00
```

<details>
<summary>Corrigé</summary>

```sql
SELECT
    f.name         AS famille,
    u.first_name   AS auteur,
    p.content      AS contenu,
    p.posted_at
FROM post p
INNER JOIN users  u ON p.author_id = u.id
INNER JOIN family f ON p.family_id = f.id
ORDER BY p.posted_at DESC;
```

**Ordre de lecture** : `post` est la table centrale (chaque post a un auteur et appartient à une famille). Les deux INNER JOIN récupèrent les noms. Pas de LEFT JOIN nécessaire ici : les FK `author_id` et `family_id` sont `NOT NULL`, donc toute correspondance existe forcément.

</details>

---

### Exercice 7 — UNION : fusionner deux listes

Produis une liste unique de tous les `user_id` qui sont soit membres de `fam-1`, soit auteurs d'un post dans `fam-1`. Chaque user_id ne doit apparaître qu'une fois.

Résultat attendu (3 lignes) : `u-1`, `u-2`, `u-3`

<details>
<summary>Corrigé</summary>

```sql
SELECT user_id FROM family_member WHERE family_id = 'fam-1'
UNION
SELECT author_id FROM post WHERE family_id = 'fam-1';

-- UNION supprime les doublons (u-1 et u-2 apparaissent dans les deux SELECT)
-- Résultat : u-1, u-2, u-3 (3 lignes distinctes)

-- Si tu voulais voir les doublons pour les compter :
SELECT user_id FROM family_member WHERE family_id = 'fam-1'
UNION ALL
SELECT author_id FROM post WHERE family_id = 'fam-1';
-- Retourne 6 lignes (u-1 × 2, u-2 × 2, u-3 × 1)
```

</details>

---

### Exercice 8 — EXPLAIN ANALYZE : impact des index

Pour la requête de l'exercice 1, observe le plan avant et après ajout d'un index.

```sql
-- Avant index : observer le plan
EXPLAIN ANALYZE
SELECT u.first_name, u.last_name, fm.role, fm.joined_at::DATE AS depuis
FROM family_member fm
INNER JOIN users u ON fm.user_id = u.id
WHERE fm.family_id = 'fam-1'
ORDER BY fm.joined_at;

-- Ajouter un index sur family_id (la colonne de filtre)
CREATE INDEX idx_family_member_family_id ON family_member(family_id);

-- Après index : comparer le plan
EXPLAIN ANALYZE
SELECT u.first_name, u.last_name, fm.role, fm.joined_at::DATE AS depuis
FROM family_member fm
INNER JOIN users u ON fm.user_id = u.id
WHERE fm.family_id = 'fam-1'
ORDER BY fm.joined_at;
```

<details>
<summary>Ce que tu devrais observer</summary>

Avec peu de données, PostgreSQL utilisera probablement un `Seq Scan` dans les deux cas (le planner juge le scan séquentiel plus rapide sur une petite table). Sur un jeu de données plus grand (10 000+ lignes), l'index transforme le `Seq Scan` en `Index Scan` ou `Bitmap Index Scan`, réduisant drastiquement le coût.

**Index à créer systématiquement sur les colonnes de jointure :**

```sql
CREATE INDEX idx_family_member_user_id   ON family_member(user_id);
CREATE INDEX idx_post_author_id          ON post(author_id);
CREATE INDEX idx_post_family_id          ON post(family_id);
```

Les FK en PostgreSQL ne créent **pas** automatiquement d'index — c'est à toi de les déclarer.

</details>

---

## Variante J+30

Reviens dans 30 jours et fais les exercices sans ouvrir le corrigé. Si tu bloque, lis seulement la section **Points clés** du module 03, puis retente.

Exercice bonus : écris une CTE (`WITH stats AS (...)`) qui calcule le nombre de posts par membre de `fam-1`, puis dans la requête principale affiche uniquement les membres qui ont posté **plus de la médiane**.

<details>
<summary>Corrigé variante J+30</summary>

```sql
WITH stats AS (
    SELECT
        fm.user_id,
        u.first_name,
        COUNT(p.id) AS nb_posts
    FROM family_member fm
    INNER JOIN users u ON fm.user_id = u.id
    LEFT JOIN  post  p ON p.author_id = u.id AND p.family_id = fm.family_id
    WHERE fm.family_id = 'fam-1'
    GROUP BY fm.user_id, u.first_name
),
mediane AS (
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY nb_posts) AS valeur
    FROM stats
)
SELECT s.first_name, s.nb_posts
FROM stats s, mediane m
WHERE s.nb_posts > m.valeur
ORDER BY s.nb_posts DESC;
```

</details>

---

## Navigation

| | Lien |
|---|---|
| Module associé | [Module 03 — Relations et jointures](../../modules/03-relations-et-jointures.md) |
| Lab précédent | [Lab 02 — CRUD en pratique](../lab-02-crud-en-pratique/README.md) |
| Lab suivant | [Lab 04 — Transactions](../lab-04-transactions/README.md) |
