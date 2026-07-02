---
titre: Relations et jointures
cours: 10-postgresql
notions: [INNER JOIN, LEFT et RIGHT JOIN, FULL OUTER JOIN, self-join, sous-requêtes, sous-requêtes corrélées, EXISTS et IN, UNION et jointures multiples]
outcomes: [écrire des jointures internes et externes, choisir le bon type de jointure, utiliser des sous-requêtes et EXISTS, combiner plusieurs tables]
prerequis: [02-crud-et-requetes]
next: 04-transactions-et-acid
libs: [{ name: postgresql, version: "17" }]
tribuzen: lister les membres d'une famille et les posts avec leur auteur (jointures TribuZen)
last-reviewed: 2026-07
---

# Relations et jointures

> **Outcomes — tu sauras FAIRE :** écrire des jointures internes et externes (INNER, LEFT, FULL OUTER), choisir le bon type selon ce que tu veux conserver, utiliser des sous-requêtes corrélées et EXISTS, combiner plusieurs tables dans une seule requête.
> **Difficulté :** :star::star:

## 1. Cas concret d'abord

Dans TribuZen, la page famille affiche deux choses : la liste des membres avec leur prénom/nom, et le fil de posts avec le nom de l'auteur de chaque message. Les données vivent dans quatre tables — `family`, `users`, `family_member`, `post` — et sans jointures tu finirais à faire une requête par ligne (le problème N+1) :

```sql
-- ❌ Approche N+1 : 1 requête pour la liste + 1 requête par membre pour le nom
SELECT user_id FROM family_member WHERE family_id = 'fam-1';
-- → 12 lignes → 12 SELECT users WHERE id = ... supplémentaires

-- ✅ Une seule jointure fait le travail
SELECT u.first_name, u.last_name, fm.role, fm.joined_at
FROM family_member fm
INNER JOIN users u ON fm.user_id = u.id
WHERE fm.family_id = 'fam-1'
ORDER BY fm.joined_at;
```

Même chose pour les posts : joindre `post` sur `users` pour avoir l'auteur, et sur `family` pour le nom de la famille. Ce module te donne tous les outils pour écrire ces requêtes correctement.

## 2. Théorie complète, concise

### Schéma TribuZen utilisé dans ce module

```sql
CREATE TABLE users (
    id         TEXT PRIMARY KEY,          -- 'u-1', 'u-2'…
    first_name TEXT NOT NULL,
    last_name  TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE,
    invited_by TEXT REFERENCES users(id)  -- auto-référence : qui a invité cet utilisateur
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

### INNER JOIN — correspondance stricte

Retourne uniquement les lignes qui ont une correspondance dans **les deux** tables. Si un côté n'a pas de match, la ligne est exclue.

```sql
-- Membres de fam-1 avec prénom/nom
SELECT u.first_name, u.last_name, fm.role
FROM family_member fm
INNER JOIN users u ON fm.user_id = u.id
WHERE fm.family_id = 'fam-1';
-- Un fm sans users correspondant → exclu (cas d'intégrité cassée)
-- Un users sans fm dans cette famille → exclu également
```

`JOIN` seul sans préfixe = `INNER JOIN`. C'est le type de jointure par défaut et le plus courant.

### LEFT JOIN — conserver toute la table de gauche

Retourne **toutes** les lignes de la table de gauche ; les colonnes de droite sont `NULL` quand il n'y a pas de correspondance.

```sql
-- Tous les utilisateurs, avec leur rôle dans fam-1 s'ils en sont membres
-- (NULL si pas membre)
SELECT u.first_name, u.last_name, fm.role
FROM users u
LEFT JOIN family_member fm ON u.id = fm.user_id AND fm.family_id = 'fam-1';

-- Trouver les utilisateurs qui ne sont membres d'AUCUNE famille
SELECT u.first_name, u.last_name
FROM users u
LEFT JOIN family_member fm ON u.id = fm.user_id
WHERE fm.family_id IS NULL;
```

Le filtre `WHERE fm.colonne IS NULL` après un LEFT JOIN est le pattern pour trouver les lignes **sans correspondance** ("orphelines").

### RIGHT JOIN — miroir du LEFT JOIN

Retourne toutes les lignes de la table de **droite**. En pratique, il vaut mieux inverser l'ordre des tables et utiliser un LEFT JOIN — le résultat est identique mais plus lisible.

```sql
-- Ces deux requêtes sont équivalentes
SELECT u.first_name, fm.role
FROM family_member fm
RIGHT JOIN users u ON fm.user_id = u.id AND fm.family_id = 'fam-1';

-- Préférer cette formulation (LEFT JOIN, table "principale" à gauche)
SELECT u.first_name, fm.role
FROM users u
LEFT JOIN family_member fm ON u.id = fm.user_id AND fm.family_id = 'fam-1';
```

### FULL OUTER JOIN — tout conserver des deux côtés

Retourne toutes les lignes des deux tables ; `NULL` là où il n'y a pas de correspondance.

```sql
-- Setup reproductible : deux snapshots d'emails avant/après migration TribuZen
CREATE TEMP TABLE users_snapshot_a (email TEXT PRIMARY KEY);
INSERT INTO users_snapshot_a VALUES
    ('alice@tribu.fr'),   -- email avant migration
    ('bob@tribu.fr'),
    ('claire@tribu.fr');

CREATE TEMP TABLE users_snapshot_b (email TEXT PRIMARY KEY);
INSERT INTO users_snapshot_b VALUES
    ('alice.moreau@tribu.fr'),  -- email changé après migration
    ('bob@tribu.fr'),
    ('diana@tribu.fr');         -- nouvel utilisateur ajouté

-- Détecter les écarts entre les deux snapshots
SELECT
    COALESCE(a.email, b.email) AS email,
    CASE
        WHEN a.email IS NULL THEN 'seulement dans B'
        WHEN b.email IS NULL THEN 'seulement dans A'
        ELSE 'dans les deux'
    END AS statut
FROM users_snapshot_a a
FULL OUTER JOIN users_snapshot_b b ON a.email = b.email
WHERE a.email IS NULL OR b.email IS NULL;

-- Résultat (bob@tribu.fr est dans les deux → exclu par le WHERE) :
-- email                    | statut
-- -------------------------+------------------
-- alice@tribu.fr           | seulement dans A
-- claire@tribu.fr          | seulement dans A
-- alice.moreau@tribu.fr    | seulement dans B
-- diana@tribu.fr           | seulement dans B
```

Cas d'usage réel : détecter les écarts lors d'une migration de données ou d'un audit.

### Self-join — une table jointe avec elle-même

Quand une table contient une auto-référence (FK vers elle-même), on la joint à elle-même avec deux alias.

```sql
-- Qui a invité qui ? (invited_by dans users)
SELECT
    u.first_name   AS membre,
    inv.first_name AS parrain
FROM users u
LEFT JOIN users inv ON u.invited_by = inv.id;

-- Resultat :
-- membre  | parrain
-- --------+---------
-- Alice   | NULL       ← fondatrice, personne ne l'a invitée
-- Bob     | Alice
-- Claire  | Alice
-- David   | Bob
```

Les deux alias (`u` et `inv`) pointent vers la même table `users` ; sans alias, PostgreSQL ne saurait pas quelle occurrence est quelle.

### Sous-requêtes (subqueries)

Une sous-requête est une `SELECT` imbriquée dans une autre requête. Trois usages principaux :

**Scalaire** (retourne une valeur unique) :

```sql
-- Posts plus récents que le post médian de la famille
SELECT content, posted_at
FROM post
WHERE posted_at > (
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY posted_at)
    FROM post
    WHERE family_id = 'fam-1'
)
AND family_id = 'fam-1';
```

**Dans le FROM** (table dérivée) :

```sql
-- Auteurs avec leur compteur de posts, filtré sur ceux qui en ont plus de 3
SELECT u.first_name, stats.nb_posts
FROM users u
JOIN (
    SELECT author_id, COUNT(*) AS nb_posts
    FROM post
    WHERE family_id = 'fam-1'
    GROUP BY author_id
) AS stats ON u.id = stats.author_id
WHERE stats.nb_posts > 3;
```

### Sous-requêtes corrélées

Une sous-requête corrélée référence une colonne de la requête **externe**. Elle est réévaluée pour chaque ligne de la requête externe.

```sql
-- Pour chaque utilisateur, nombre de familles dont il est membre
SELECT
    u.first_name,
    u.last_name,
    (SELECT COUNT(*) FROM family_member fm WHERE fm.user_id = u.id) AS nb_familles
FROM users u;
```

La sous-requête `(SELECT COUNT(*) ... WHERE fm.user_id = u.id)` est corrélée à `u.id` : elle est exécutée une fois **par ligne** de `users`. À éviter sur de grandes tables — préférer un JOIN + GROUP BY.

### EXISTS et IN

`EXISTS` vérifie si la sous-requête retourne **au moins une ligne**. Elle s'arrête dès la première correspondance.

```sql
-- Utilisateurs qui ont au moins un post dans fam-1
SELECT u.first_name, u.last_name
FROM users u
WHERE EXISTS (
    SELECT 1 FROM post p
    WHERE p.author_id = u.id AND p.family_id = 'fam-1'
);

-- Même résultat avec IN
SELECT u.first_name, u.last_name
FROM users u
WHERE u.id IN (
    SELECT p.author_id FROM post p WHERE p.family_id = 'fam-1'
);
```

Règle de choix :

| Situation | Préférer |
|-----------|----------|
| Sous-requête corrélée, juste vérifier l'existence | `EXISTS` — court-circuit dès la 1ʳᵉ ligne |
| Liste de valeurs constantes ou petite sous-requête | `IN` — syntaxe claire |
| Sous-requête peut retourner `NULL` | `EXISTS` — `IN (NULL, ...)` produit des résultats surprenants |

Piège : `NOT IN (sous-requête)` retourne zéro ligne si la sous-requête contient un seul `NULL`. `NOT EXISTS` n'a pas ce comportement.

### UNION — combiner des ensembles de résultats

`UNION` réunit deux ensembles de lignes et supprime les doublons. `UNION ALL` conserve les doublons (plus rapide, pas de déduplication).

```sql
-- Tous les identifiants actifs dans fam-1 : membres actuels + anciens membres archivés
SELECT user_id, 'actif'   AS statut FROM family_member   WHERE family_id = 'fam-1'
UNION
SELECT user_id, 'archive' AS statut FROM former_member    WHERE family_id = 'fam-1';

-- Les colonnes doivent être en même nombre et types compatibles
-- UNION supprime les doublons (comme DISTINCT) ; UNION ALL les conserve
```

### Jointures multiples (3+ tables)

```sql
-- Posts avec prénom de l'auteur et nom de la famille — 3 tables
SELECT
    f.name         AS famille,
    u.first_name   AS auteur,
    p.content,
    p.posted_at
FROM post p
INNER JOIN users  u ON p.author_id = u.id
INNER JOIN family f ON p.family_id = f.id
WHERE p.family_id = 'fam-1'
ORDER BY p.posted_at DESC;
```

Règle d'ordre : place les `INNER JOIN` qui filtrent en premier, puis les `LEFT JOIN`. Un `INNER JOIN` **après** un `LEFT JOIN` sur la même branche annule le LEFT JOIN (les NULL disparaissent).

```sql
-- ❌ Mauvais : le INNER JOIN annule le LEFT JOIN
SELECT u.first_name, p.content
FROM users u
LEFT JOIN family_member fm ON u.id = fm.user_id
INNER JOIN post p ON fm.user_id = p.author_id;  -- élimine les NULL de fm

-- ✅ Correct : chaîne homogène de LEFT JOIN
SELECT u.first_name, p.content
FROM users u
LEFT JOIN family_member fm ON u.id = fm.user_id AND fm.family_id = 'fam-1'
LEFT JOIN post p ON u.id = p.author_id AND p.family_id = 'fam-1';
```

## 3. Worked examples

### Exemple A — liste des membres d'une famille avec rôle (INNER JOIN)

Objectif : afficher la liste complète des membres de `fam-1` avec prénom, nom, rôle et date d'adhésion, triée par ancienneté.

```sql
-- Étape 1 : jeu de données minimal
INSERT INTO users (id, first_name, last_name, email) VALUES
    ('u-1', 'Alice',  'Moreau',  'alice@tribu.fr'),
    ('u-2', 'Bob',    'Dupont',  'bob@tribu.fr'),
    ('u-3', 'Claire', 'Martin',  'claire@tribu.fr'),
    ('u-4', 'David',  'Lefebvre','david@tribu.fr');

INSERT INTO family (id, name) VALUES ('fam-1', 'Les Moreau');

INSERT INTO family_member (family_id, user_id, role, joined_at) VALUES
    ('fam-1', 'u-1', 'owner',  '2025-01-10 10:00:00+00'),
    ('fam-1', 'u-2', 'admin',  '2025-02-15 14:30:00+00'),
    ('fam-1', 'u-3', 'member', '2025-03-01 09:00:00+00');
-- u-4 (David) n'est PAS membre de fam-1

-- Étape 2 : requête principale
SELECT
    u.first_name,
    u.last_name,
    fm.role,
    fm.joined_at::DATE AS depuis
FROM family_member fm
INNER JOIN users u ON fm.user_id = u.id
WHERE fm.family_id = 'fam-1'
ORDER BY fm.joined_at;

-- Résultat attendu :
-- first_name | last_name | role   | depuis
-- -----------+-----------+--------+------------
-- Alice      | Moreau    | owner  | 2025-01-10
-- Bob        | Dupont    | admin  | 2025-02-15
-- Claire     | Martin    | member | 2025-03-01
-- (David est absent : pas de ligne dans family_member pour fam-1)
```

Pas-à-pas : (1) `fm` est la table de jonction entre `family` et `users` — elle porte les attributs de la relation (rôle, date) ; (2) `INNER JOIN` est correct ici car tout `family_member` doit avoir un `users` correspondant (contrainte FK) ; (3) sans le filtre `WHERE fm.family_id = 'fam-1'`, la jointure ramènerait tous les membres de toutes les familles.

### Exemple B — posts avec auteur, comptage, et utilisateurs sans post (LEFT JOIN + agrégation)

Objectif : afficher tous les membres de `fam-1` avec leur nombre de posts — y compris ceux qui n'ont encore rien publié.

```sql
INSERT INTO post (id, family_id, author_id, content, posted_at) VALUES
    ('p-1', 'fam-1', 'u-1', 'Bienvenue !',         '2025-03-05 10:00:00+00'),
    ('p-2', 'fam-1', 'u-2', 'Merci pour l invitation', '2025-03-06 11:00:00+00'),
    ('p-3', 'fam-1', 'u-1', 'Photo du week-end',    '2025-03-08 09:00:00+00');
-- Claire (u-3) est membre mais n'a pas encore posté

SELECT
    u.first_name,
    u.last_name,
    COUNT(p.id) AS nb_posts
FROM family_member fm
INNER JOIN users u  ON fm.user_id  = u.id
LEFT JOIN  post  p  ON p.author_id = u.id AND p.family_id = fm.family_id
WHERE fm.family_id = 'fam-1'
GROUP BY u.id, u.first_name, u.last_name
ORDER BY nb_posts DESC;

-- Résultat attendu :
-- first_name | last_name | nb_posts
-- -----------+-----------+---------
-- Alice      | Moreau    | 2
-- Bob        | Dupont    | 1
-- Claire     | Martin    | 0        ← incluse grâce au LEFT JOIN
```

Pas-à-pas : (1) le `INNER JOIN users` garantit qu'on a bien les noms ; (2) le `LEFT JOIN post` conserve les membres sans post (NULL pour `p.id` → `COUNT(p.id)` retourne 0, pas 1) ; (3) la condition `p.family_id = fm.family_id` dans le `ON` du LEFT JOIN est cruciale — la mettre dans `WHERE` transformerait le LEFT JOIN en INNER JOIN en éliminant les NULL ; (4) `COUNT(p.id)` et non `COUNT(*)` — compter les IDs de posts (NULL ignoré par COUNT) pour ne pas compter les lignes sans post.

## 4. Pièges & misconceptions

- **`NOT IN` avec une sous-requête qui peut retourner NULL.** `WHERE u.id NOT IN (SELECT invited_by FROM users)` retourne zéro ligne si une seule valeur `invited_by` est `NULL` — parce que `x NOT IN (NULL, ...)` est `UNKNOWN`, pas `TRUE`. *Correct* : utiliser `NOT EXISTS` ou filtrer les NULL dans la sous-requête (`WHERE invited_by IS NOT NULL`).

- **Condition dans `WHERE` vs `ON` sur un LEFT JOIN.** `LEFT JOIN post p ON p.author_id = u.id WHERE p.family_id = 'fam-1'` élimine les lignes où `p.family_id IS NULL` → le LEFT JOIN devient de facto un INNER JOIN. *Correct* : déplacer le filtre dans la clause `ON` : `LEFT JOIN post p ON p.author_id = u.id AND p.family_id = 'fam-1'`.

- **`COUNT(*)` au lieu de `COUNT(colonne)` après un LEFT JOIN.** `COUNT(*)` compte toutes les lignes, y compris celles avec des colonnes `NULL` issues du LEFT JOIN — un membre sans post serait comptabilisé à 1 au lieu de 0. *Correct* : `COUNT(p.id)` — `COUNT` ignore les `NULL`.

- **Sous-requête corrélée sur une grande table.** Une sous-requête corrélée dans le `SELECT` est réévaluée pour chaque ligne du résultat. Sur 100 000 users, c'est 100 000 exécutions. *Correct* : reformuler en JOIN + GROUP BY ou en CTE, et vérifier `EXPLAIN ANALYZE`.

- **`UNION` sans `ALL` sur de grandes tables.** `UNION` effectue un tri et une déduplication coûteux sur l'ensemble combiné. *Correct* : utiliser `UNION ALL` si les doublons sont impossibles ou acceptables, et n'utiliser `UNION` que quand la déduplication est réellement nécessaire.

- **Chaîner un `INNER JOIN` après un `LEFT JOIN` sur la même branche.** Le `INNER JOIN` élimine les NULL produits par le LEFT JOIN, rendant ce dernier inutile. *Correct* : utiliser des LEFT JOIN cohérents sur toute la chaîne, ou restructurer la requête pour que les INNER JOIN précèdent les LEFT JOIN.

## 5. Ancrage TribuZen

Couche fil-rouge : **schéma + requêtes (PostgreSQL)** dans `smaurier/tribuzen`. Les jointures décrites dans ce module correspondent aux requêtes réellement nécessaires pour les deux écrans clés de l'app :

- **Page famille — liste des membres** : `family_member INNER JOIN users` filtrée sur `family_id` (Exemple A). Cette requête alimente la `FamilyMemberList` côté API ; toute modification du schéma (ajout de `nickname`, changement de type de `role`) impacte directement cette jointure.
- **Fil de posts avec comptage** : `family_member INNER JOIN users LEFT JOIN post` + `GROUP BY` (Exemple B). La condition `ON p.family_id = fm.family_id` dans le LEFT JOIN n'est pas intuitive mais est indispensable pour que `COUNT` soit exact par famille.
- **Système de parrainage** : `users LEFT JOIN users inv ON u.invited_by = inv.id` — self-join pour afficher la chaîne d'invitation dans le profil. Ce schéma est aussi la base du calcul de "qui a amené le plus de membres".
- **EXISTS pour les droits** : `EXISTS (SELECT 1 FROM family_member WHERE user_id = $1 AND family_id = $2 AND role IN ('owner','admin'))` — vérification rapide des droits avant une opération admin ; EXISTS s'arrête à la première correspondance, ce qui est optimal pour cette garde.
- En session, on exécute ces requêtes sur une base Postgres locale (Docker), on lit le plan d'exécution (`EXPLAIN ANALYZE`) pour observer l'impact des index sur les colonnes de jointure, et on compare la performance de `EXISTS` vs `IN` sur un jeu de 10 000 users.

## 6. Points clés

1. `INNER JOIN` : seulement les lignes avec correspondance dans les deux tables ; `JOIN` seul = `INNER JOIN`.
2. `LEFT JOIN` : toutes les lignes de gauche + NULL à droite si pas de correspondance ; pattern orphelin = `WHERE table_droite.col IS NULL`.
3. `RIGHT JOIN` = `LEFT JOIN` avec tables inversées — préférer LEFT JOIN pour la lisibilité.
4. `FULL OUTER JOIN` : toutes les lignes des deux tables, NULL des deux côtés si pas de correspondance.
5. Self-join : même table avec deux alias — indispensable pour les hiérarchies et auto-références.
6. Filtre de LEFT JOIN dans `ON`, pas dans `WHERE` — sinon le LEFT JOIN se comporte comme un INNER JOIN.
7. `COUNT(colonne)` ignore les NULL ; `COUNT(*)` les compte — différence critique après un LEFT JOIN.
8. `EXISTS` court-circuite à la première ligne, `NOT IN` est dangereux si la sous-requête peut contenir NULL.
9. `UNION` déduplique (tri coûteux) ; `UNION ALL` conserve les doublons et est plus rapide.
10. Chaîner un `INNER JOIN` après un `LEFT JOIN` sur la même branche annule le LEFT JOIN.

## 7. Seeds Anki

```
Différence INNER JOIN vs LEFT JOIN ?|INNER JOIN ne retourne que les lignes avec correspondance dans les deux tables ; LEFT JOIN retourne toutes les lignes de gauche et NULL à droite si pas de correspondance
Comment trouver les lignes sans correspondance avec un LEFT JOIN ?|LEFT JOIN puis WHERE table_droite.colonne IS NULL — les lignes sans match ont NULL sur les colonnes de droite
Pourquoi NOT IN est dangereux avec une sous-requête ?|Si la sous-requête retourne un seul NULL, NOT IN retourne zéro ligne (x NOT IN (NULL,...) = UNKNOWN) — préférer NOT EXISTS
Différence EXISTS vs IN pour une sous-requête ?|EXISTS court-circuite à la première correspondance (efficace, sans risque NULL) ; IN matérialise la liste complète (risque NULL dans NOT IN)
Pourquoi mettre le filtre de LEFT JOIN dans ON et non dans WHERE ?|Un filtre dans WHERE élimine les NULL produits par le LEFT JOIN, le transformant de facto en INNER JOIN
Différence UNION vs UNION ALL ?|UNION supprime les doublons (tri coûteux) ; UNION ALL conserve les doublons et est plus rapide — préférer UNION ALL si les doublons sont impossibles ou acceptables
Pourquoi COUNT(colonne) et non COUNT(*) après un LEFT JOIN ?|COUNT(*) compte toutes les lignes y compris celles avec NULL (membres sans post = 1 au lieu de 0) ; COUNT(colonne) ignore les NULL
Qu'est-ce qu'une sous-requête corrélée et quel est son risque ?|Sous-requête qui référence une colonne de la requête externe, réévaluée pour chaque ligne — risque de performance sur grande table, reformuler en JOIN+GROUP BY
Comment écrire un self-join ?|Deux alias sur la même table : users u LEFT JOIN users inv ON u.invited_by = inv.id — indispensable pour les hiérarchies et auto-références
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-03-jointures-en-pratique/`. Tu crées le schéma TribuZen (family, users, family_member, post), tu écris les jointures membres+posts, tu compares EXISTS vs NOT IN sur un cas avec NULL, et tu observes le plan d'exécution des jointures sans index puis avec. Corrigé SQL inline commenté + variante J+30 dans le README du lab.
