---
titre: CRUD et requêtes
cours: 10-postgresql
notions: [INSERT, SELECT avec WHERE, UPDATE, DELETE, ORDER BY et LIMIT OFFSET, opérateurs et filtres, fonctions d'agrégation, GROUP BY et HAVING, DISTINCT et RETURNING]
outcomes: [écrire des requêtes CRUD complètes, filtrer et trier, agréger avec GROUP BY et HAVING, utiliser RETURNING]
prerequis: [01-modele-relationnel]
next: 03-relations-et-jointures
libs: [{ name: postgresql, version: "17" }]
tribuzen: CRUD sur les familles et posts de TribuZen (créer une famille, lister les posts récents)
last-reviewed: 2026-07
---

# CRUD et requêtes

> **Outcomes — tu sauras FAIRE :** écrire des requêtes CRUD complètes en SQL, filtrer et trier avec WHERE / ORDER BY / LIMIT OFFSET, agréger des données avec GROUP BY et HAVING, et récupérer les lignes modifiées avec RETURNING.
> **Difficulté :** :star::star:

## 1. Cas concret d'abord

Dans TribuZen, quand un utilisateur crée une famille, le serveur doit enchaîner deux écritures : insérer la famille, puis insérer le créateur comme premier membre. La deuxième écriture a besoin de l'`id` UUID généré par la première. Sans `RETURNING`, il faut un second `SELECT` après l'INSERT — un aller-retour réseau de plus et une fenêtre de concurrence.

```sql
-- Sans RETURNING : deux requêtes, fenêtre de race condition entre les deux
INSERT INTO family (name, created_by) VALUES ('Les Maurier', 'u-1');
SELECT id FROM family WHERE name = 'Les Maurier' AND created_by = 'u-1'; -- non atomique !

-- Avec RETURNING : une seule requête, l'id est disponible immédiatement
INSERT INTO family (name, created_by)
VALUES ('Les Maurier', 'u-1')
RETURNING id, name, created_at;
-- → { id: 'fam-abc', name: 'Les Maurier', created_at: '2026-07-01T10:00:00Z' }
```

Même logique pour un `UPDATE` ou `DELETE` : `RETURNING` évite le `SELECT` de confirmation. La suite couvre INSERT, SELECT, UPDATE, DELETE, les filtres et les agrégations — tous ancrés sur le schéma TribuZen.

## 2. Théorie complète, concise

### Schéma de référence

```sql
CREATE TABLE family (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  created_by    UUID NOT NULL,
  members_count INT  NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE post (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id  UUID NOT NULL REFERENCES family(id),
  author_id  UUID NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### INSERT

```sql
-- Insertion simple
INSERT INTO family (name, created_by)
VALUES ('Les Dupont', 'u-42');

-- Insertion multiple (batch) — bien plus rapide que N INSERT individuels
-- Un seul cycle parse / plan / WAL write pour toutes les lignes
INSERT INTO post (family_id, author_id, content) VALUES
  ('fam-1', 'u-1', 'Bonjour famille !'),
  ('fam-1', 'u-2', 'Heureux d''être ici'),
  ('fam-1', 'u-1', 'Premier album partagé');

-- RETURNING : récupère les colonnes de la ou des lignes insérées
INSERT INTO family (name, created_by)
VALUES ('Les Martin', 'u-9')
RETURNING id, name, created_at;
```

`RETURNING` est une extension PostgreSQL ; elle fonctionne aussi sur `UPDATE` et `DELETE` et peut retourner `*` ou n'importe quelles colonnes.

### SELECT, WHERE et opérateurs de filtre

```sql
-- Toutes les colonnes
SELECT * FROM post WHERE family_id = 'fam-1';

-- Colonnes choisies + alias
SELECT content, created_at AS posted_at FROM post WHERE family_id = 'fam-1';

-- Opérateurs courants
SELECT * FROM family WHERE members_count >= 3;
SELECT * FROM post WHERE family_id IN ('fam-1', 'fam-2');
SELECT * FROM post WHERE content ILIKE '%photo%';          -- insensible à la casse
SELECT * FROM post WHERE created_at >= now() - INTERVAL '7 days';
SELECT * FROM post WHERE author_id IS NOT NULL;            -- jamais = NULL !
```

**Règle NULL** : toute comparaison avec `NULL` retourne `NULL`, pas `false`. `WHERE col = NULL` ne retourne jamais rien. Toujours `IS NULL` / `IS NOT NULL`.

### ORDER BY et LIMIT OFFSET

```sql
-- Posts les plus récents en premier
SELECT id, content, created_at
FROM post
WHERE family_id = 'fam-1'
ORDER BY created_at DESC;

-- Pagination classique : page 1, 20 résultats
SELECT id, content, created_at
FROM post
WHERE family_id = 'fam-1'
ORDER BY created_at DESC
LIMIT 20 OFFSET 0;

-- Pagination keyset (performante sur les grandes tables)
-- Le client mémorise le dernier created_at vu et l'envoie comme curseur
SELECT id, content, created_at
FROM post
WHERE family_id = 'fam-1'
  AND created_at < '2026-06-30T12:00:00Z'   -- curseur = dernier vu
ORDER BY created_at DESC
LIMIT 20;
```

`OFFSET N` force PostgreSQL à lire et ignorer N lignes — coût O(N). La pagination keyset est O(1) via l'index sur `(family_id, created_at)`.

### UPDATE

```sql
-- Modifier un post + récupérer le résultat
UPDATE post
SET content = 'Photo de famille mise à jour'
WHERE id = 'post-7'
RETURNING id, content;

-- Danger : sans WHERE, toutes les lignes sont modifiées
-- UPDATE post SET content = '';  ← détruit tout le contenu de toute la table
```

Toujours vérifier la clause `WHERE` avec un `SELECT` avant d'exécuter un `UPDATE` en production, ou utiliser `BEGIN` / `ROLLBACK`.

### DELETE

```sql
-- Supprimer un post précis
DELETE FROM post
WHERE id = 'post-7'
RETURNING id, author_id;

-- Supprimer les vieux posts d'une famille
DELETE FROM post
WHERE family_id = 'fam-1'
  AND created_at < now() - INTERVAL '1 year'
RETURNING id;

-- Danger : sans WHERE, toute la table est vidée
-- DELETE FROM post;  ← supprime tous les posts de toutes les familles
```

### DISTINCT

```sql
-- Familles ayant au moins un post (sans doublons)
SELECT DISTINCT family_id FROM post;

-- Auteurs uniques d'une famille
SELECT DISTINCT author_id FROM post WHERE family_id = 'fam-1';
```

`DISTINCT` déclenche un tri implicite pour éliminer les doublons — coûteux sur les grandes tables. Si tu en as besoin souvent, c'est souvent un signal de modèle à revoir.

### Fonctions d'agrégation

```sql
-- Compter les posts d'une famille
SELECT COUNT(*) AS nb_posts FROM post WHERE family_id = 'fam-1';

-- Statistiques temporelles
SELECT
  COUNT(*)          AS total_posts,
  MIN(created_at)   AS premier_post,
  MAX(created_at)   AS dernier_post
FROM post
WHERE family_id = 'fam-1';
```

`COUNT(*)` compte toutes les lignes y compris celles avec des `NULL`. `COUNT(col)` ignore les `NULL` de cette colonne.

### GROUP BY et HAVING

```sql
-- Nombre de posts par famille
SELECT
  family_id,
  COUNT(*) AS nb_posts
FROM post
GROUP BY family_id
ORDER BY nb_posts DESC;

-- Familles avec plus de 5 posts (filtre appliqué après regroupement)
SELECT
  family_id,
  COUNT(*) AS nb_posts
FROM post
GROUP BY family_id
HAVING COUNT(*) > 5
ORDER BY nb_posts DESC;
```

**Ordre logique d'exécution :** `FROM` → `WHERE` → `GROUP BY` → `HAVING` → `SELECT` → `ORDER BY` → `LIMIT`.

`WHERE` filtre les lignes **avant** le regroupement. `HAVING` filtre les groupes **après**. Toujours préférer `WHERE` pour les filtres sélectifs.

Toute colonne dans `SELECT` hors d'une agrégation **doit** apparaître dans `GROUP BY`. Sinon PostgreSQL lève une erreur.

## 3. Worked examples

### Exemple A — créer une famille et ses premiers posts

Objectif : insérer la famille, chaîner sur son `id` retourné par `RETURNING`, insérer trois posts en une requête batch.

```sql
-- Étape 1 : créer la famille, récupérer son id immédiatement
INSERT INTO family (name, created_by)
VALUES ('Les Bertrand', 'u-55')
RETURNING id, name, created_at;
-- → { id: 'fam-b3c9', name: 'Les Bertrand', created_at: '2026-07-01T10:00:00Z' }

-- Étape 2 : insérer trois posts en batch avec l'id récupéré
INSERT INTO post (family_id, author_id, content) VALUES
  ('fam-b3c9', 'u-55', 'Bienvenue dans notre espace !'),
  ('fam-b3c9', 'u-55', 'Première photo de famille ajoutée'),
  ('fam-b3c9', 'u-56', 'Contente d''être dans ce groupe')
RETURNING id, author_id, created_at;
```

Pas-à-pas : (1) `RETURNING id` dans le premier INSERT évite un SELECT de confirmation ; l'`id` sert immédiatement pour les INSERT suivants sans aller-retour supplémentaire. (2) L'INSERT batch est environ 10× plus rapide que trois INSERT individuels : un seul parse/plan/WAL write pour les trois lignes. (3) `RETURNING` sur le batch retourne les trois lignes — utile pour loguer ou confirmer côté applicatif.

### Exemple B — lister et analyser l'activité des familles

Objectif : produire le feed des 20 posts récents d'une famille et le classement des familles les plus actives.

```sql
-- Feed des 20 derniers posts de la famille
SELECT
  p.id,
  p.content,
  p.author_id,
  p.created_at
FROM post p
WHERE p.family_id = 'fam-1'
ORDER BY p.created_at DESC
LIMIT 20;

-- Classement des 5 familles les plus actives (au moins 3 posts)
SELECT
  f.name,
  COUNT(p.id)       AS nb_posts,
  MAX(p.created_at) AS dernier_post
FROM family f
JOIN post p ON p.family_id = f.id
GROUP BY f.id, f.name
HAVING COUNT(p.id) >= 3
ORDER BY nb_posts DESC
LIMIT 5;
```

Pas-à-pas : (1) `ORDER BY created_at DESC LIMIT 20` avec un index sur `(family_id, created_at)` permet à PostgreSQL de lire exactement 20 lignes via l'index — pas de scan complet de la table. (2) `COUNT(p.id)` plutôt que `COUNT(*)` : si on passait à un `LEFT JOIN`, les familles sans post auraient `p.id = NULL` et `COUNT(p.id)` retournerait 0 là où `COUNT(*)` retournerait 1 — prendre l'habitude maintenant. (3) `GROUP BY f.id, f.name` : `f.id` suffit fonctionnellement (PK → `f.name` dépendant), mais PostgreSQL requiert que `f.name` soit dans le `GROUP BY` puisqu'il est dans le `SELECT` sans agrégation.

## 4. Pièges & misconceptions

- **UPDATE / DELETE sans WHERE.** `UPDATE post SET content = ''` vide le contenu de **tous** les posts. `DELETE FROM post` supprime **toute** la table. *Correct* : tester avec `SELECT * FROM post WHERE <condition>` avant d'exécuter, ou ouvrir un `BEGIN` et vérifier les lignes affectées avant `COMMIT` / `ROLLBACK`.

- **Comparer à NULL avec `=`.** `WHERE author_id = NULL` ne retourne jamais rien — `NULL = NULL` retourne `NULL`, pas `true`. *Correct* : `WHERE author_id IS NULL` / `IS NOT NULL`.

- **`HAVING` à la place de `WHERE`.** Mettre `HAVING family_id = 'fam-1'` force PostgreSQL à agréger **toutes** les lignes puis à filtrer. *Correct* : `WHERE family_id = 'fam-1'` filtre **avant** le regroupement — beaucoup plus efficace et est planifiable via un index.

- **Colonne SELECT non agrégée absente du GROUP BY.** `SELECT family_id, content, COUNT(*) FROM post GROUP BY family_id` déclenche `ERROR: column "post.content" must appear in the GROUP BY clause or be used in an aggregate function`. *Correct* : inclure `content` dans `GROUP BY` ou l'envelopper dans `STRING_AGG(content, ', ')`.

- **`OFFSET` lent sur les grandes tables.** `OFFSET 50000 LIMIT 20` force PostgreSQL à lire et ignorer 50 000 lignes — O(N). À page 2500 la requête peut dépasser 10 secondes. *Correct* : pagination keyset `WHERE created_at < $cursor ORDER BY created_at DESC LIMIT 20` — O(1) par index.

- **`RETURNING` n'est pas du SQL standard.** `RETURNING` est une extension PostgreSQL (supportée aussi par MariaDB ≥ 10.5, SQLite ≥ 3.35). Sur MySQL strict ou d'autres BDD, il faut adapter ou supprimer.

## 5. Ancrage TribuZen

Couche fil-rouge : **schéma + requêtes CRUD** dans `smaurier/tribuzen`. INSERT, SELECT, UPDATE et DELETE sur `family` et `post` sont les requêtes les plus fréquentes du produit :

- `INSERT INTO family ... RETURNING id` (Exemple A) est le point d'entrée de toute création de famille : l'`id` UUID sert immédiatement pour le `family_member` du créateur — `RETURNING` n'est pas optionnel dans ce flux, il évite la race condition.
- Le feed `ORDER BY created_at DESC LIMIT 20` (Exemple B) est la requête la plus fréquente de TribuZen : l'index `(family_id, created_at)` posé au module 05 (Index fondamentaux) la rend sous-milliseconde même à grande échelle.
- `GROUP BY f.id HAVING COUNT(p.id) >= 3` produit la base du tableau de bord d'activité — données des notifications de relance ("ta famille n'a pas posté depuis 7 jours").
- `DELETE FROM post WHERE id = $1 RETURNING id` confirme la suppression sans SELECT supplémentaire : le serveur peut répondre 204 uniquement si la ligne existait bien.
- En session, toutes ces requêtes s'écrivent sur une vraie base PostgreSQL 17 locale (Docker), pas un sandbox — elles servent de base aux modules suivants (jointures, index, transactions).

## 6. Points clés

1. `INSERT ... RETURNING` récupère les colonnes de la ligne insérée (dont l'`id` auto-généré) en une seule opération — évite le `SELECT` de confirmation.
2. L'INSERT batch `VALUES (r1), (r2), ...` est 10× à 100× plus rapide que N INSERT individuels : un seul cycle parse/plan/WAL write.
3. `UPDATE` et `DELETE` sans `WHERE` modifient ou suppriment **toutes** les lignes — toujours tester avec un `SELECT` d'abord ou travailler dans une transaction.
4. `NULL` n'est pas une valeur : toute comparaison avec `=` retourne `NULL`. Toujours `IS NULL` / `IS NOT NULL`.
5. `WHERE` filtre les lignes **avant** le regroupement ; `HAVING` filtre les groupes **après** — les filtres sélectifs vont en `WHERE`.
6. Toute colonne dans `SELECT` hors d'une agrégation doit être dans `GROUP BY`, sans quoi PostgreSQL lève une erreur.
7. `DISTINCT` déclenche un tri implicite — coûteux sur les grandes tables.
8. `OFFSET N` est O(N) — préférer la pagination keyset `WHERE col < $cursor` (O(1) par index).

## 7. Seeds Anki

```
Qu'est-ce que RETURNING dans PostgreSQL ?|Extension PostgreSQL qui retourne les colonnes des lignes affectées par INSERT, UPDATE ou DELETE — évite un SELECT de confirmation séparé
Pourquoi WHERE col = NULL ne retourne-t-il jamais rien ?|NULL n'est pas une valeur : toute comparaison avec = retourne NULL (pas false). Utiliser IS NULL ou IS NOT NULL
Différence WHERE vs HAVING ?|WHERE filtre les lignes individuelles AVANT le GROUP BY ; HAVING filtre les groupes APRÈS — un filtre en WHERE est plus efficace car il réduit le volume avant l'agrégation
Règle GROUP BY : quelle colonne doit y apparaître ?|Toute colonne dans SELECT qui n'est pas dans une agrégation (COUNT, SUM, AVG…) doit figurer dans GROUP BY — sinon erreur PostgreSQL
Pourquoi OFFSET est-il lent sur les grandes tables ?|OFFSET N force PostgreSQL à lire et ignorer N lignes (coût O(N)) — la pagination keyset (WHERE col < curseur ORDER BY col LIMIT N) utilise l'index en O(1)
Avantage de INSERT batch VALUES (r1),(r2)… sur N INSERT individuels ?|Un seul cycle parse/plan/WAL write pour toutes les lignes — 10× à 100× plus rapide
Comment vérifier un UPDATE sûr en production ?|Tester la clause WHERE avec SELECT d'abord, ou ouvrir BEGIN et vérifier les lignes affectées avant COMMIT — sans WHERE toutes les lignes sont modifiées
Différence COUNT(*) vs COUNT(col) ?|COUNT(*) compte toutes les lignes y compris celles avec NULL ; COUNT(col) ignore les lignes où col est NULL
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-02-crud-complet/`. Tu écris les requêtes CRUD complètes sur le schéma TribuZen (famille + posts) : INSERT avec RETURNING pour chaîner les ID, feed paginé avec ORDER BY et LIMIT, agrégation GROUP BY / HAVING pour le tableau de bord d'activité, UPDATE et DELETE avec RETURNING. Corrigé SQL complet commenté + variante J+30 dans le README du lab.
