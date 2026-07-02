# Lab 02 — CRUD et requêtes

> **Outcome :** à la fin, tu as écrit les requêtes CRUD complètes sur le schéma TribuZen (familles + posts) — INSERT avec RETURNING, feed paginé, agrégation GROUP BY / HAVING, UPDATE et DELETE avec RETURNING. Tout tourne sur une vraie base PostgreSQL 17 locale.
> **Vrai outil :** psql / SQL réel (PostgreSQL 17 local via Docker). Aucune simulation.
> **Feedback :** le coach valide en session.

## Pré-requis

- Lab 01 terminé (PostgreSQL 17 tourne en Docker, psql connecté)
- Module 02 lu

## Démarrer

```bash
# Se connecter à la base du cours
psql -h localhost -U postgres -d tribuzen_lab
# ou via Docker :
docker exec -it pg17 psql -U postgres -d tribuzen_lab
```

---

## Setup — schéma et données de départ

Exécuter ce bloc une seule fois avant les exercices.

```sql
-- Nettoyer si nécessaire
DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS families;

-- Schéma TribuZen simplifié
CREATE TABLE families (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  members_count INT  NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE posts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id  UUID NOT NULL REFERENCES families(id),
  author_id  TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed : 3 familles
INSERT INTO families (id, name, created_by, members_count) VALUES
  ('fam-1', 'Les Maurier',  'u-1', 3),
  ('fam-2', 'Les Dupont',   'u-4', 2),
  ('fam-3', 'Les Martin',   'u-7', 1);

-- Seed : posts variés
INSERT INTO posts (family_id, author_id, content, created_at) VALUES
  ('fam-1', 'u-1', 'Bienvenue dans l''espace famille !',    now() - INTERVAL '10 days'),
  ('fam-1', 'u-2', 'Première photo de vacances partagée',   now() - INTERVAL '8 days'),
  ('fam-1', 'u-3', 'Rappel : repas dimanche 14h',           now() - INTERVAL '5 days'),
  ('fam-1', 'u-1', 'Album été 2026 créé',                   now() - INTERVAL '2 days'),
  ('fam-1', 'u-2', 'À bientôt tout le monde !',             now() - INTERVAL '1 day'),
  ('fam-2', 'u-4', 'Hello famille Dupont !',                now() - INTERVAL '15 days'),
  ('fam-2', 'u-5', 'Photo de la réunion de famille',        now() - INTERVAL '3 days'),
  ('fam-3', 'u-7', 'Premier post de la famille Martin',     now() - INTERVAL '1 hour');
```

---

## Exercice 1 — INSERT avec RETURNING

**Objectif :** créer une nouvelle famille et récupérer son `id` UUID en une seule opération.

```
Crée la famille 'Les Bernard' (created_by = 'u-10').
Récupère id, name et created_at dans la même requête.
```

**Résultat attendu :** une ligne retournée avec un UUID généré automatiquement.

---

### Corrigé 1

```sql
INSERT INTO families (name, created_by)
VALUES ('Les Bernard', 'u-10')
RETURNING id, name, created_at;

-- Résultat (uuid généré dynamiquement) :
--  id                                   | name         | created_at
-- --------------------------------------+--------------+-------------------------------
--  xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx | Les Bernard  | 2026-07-02 ...

-- Pourquoi RETURNING ?
-- Sans RETURNING, il faudrait un SELECT séparé pour récupérer l'id.
-- Avec RETURNING, une seule requête — pas de fenêtre de concurrence, pas de round-trip réseau.
```

---

## Exercice 2 — INSERT batch

**Objectif :** insérer trois posts en une seule requête pour la famille 'Les Bernard' (utilise l'`id` retourné en exercice 1).

```
Insère 3 posts pour la famille créée :
- author_id 'u-10' : 'Bienvenue dans notre espace Bernard !'
- author_id 'u-11' : 'Contente de rejoindre la famille !'
- author_id 'u-10' : 'Premier album partagé'
Récupère id, author_id et created_at pour les trois lignes.
```

---

### Corrigé 2

```sql
-- Remplace 'fam-bernard-uuid' par l'uuid retourné en exercice 1
INSERT INTO posts (family_id, author_id, content) VALUES
  ('fam-bernard-uuid', 'u-10', 'Bienvenue dans notre espace Bernard !'),
  ('fam-bernard-uuid', 'u-11', 'Contente de rejoindre la famille !'),
  ('fam-bernard-uuid', 'u-10', 'Premier album partagé')
RETURNING id, author_id, created_at;

-- Résultat : 3 lignes retournées.

-- Pourquoi le batch ?
-- Un seul cycle parse/plan/WAL write pour les trois lignes.
-- Environ 10× plus rapide que 3 INSERT individuels sur des volumes réels.
```

---

## Exercice 3 — SELECT avec WHERE, ORDER BY, LIMIT

**Objectif :** produire le feed des 3 posts les plus récents de la famille `fam-1`.

```
SELECT les colonnes id, content, author_id, created_at
de la table post pour family_id = 'fam-1',
triés du plus récent au plus ancien,
limités à 3 résultats.
```

---

### Corrigé 3

```sql
SELECT id, content, author_id, created_at
FROM posts
WHERE family_id = 'fam-1'
ORDER BY created_at DESC
LIMIT 3;

-- Résultat attendu (3 lignes, created_at décroissant) :
--  À bientôt tout le monde !   | u-2 | now() - 1 day
--  Album été 2026 créé          | u-1 | now() - 2 days
--  Rappel : repas dimanche 14h  | u-3 | now() - 5 days

-- Note : sans ORDER BY, PostgreSQL ne garantit aucun ordre.
-- TOUJOURS trier explicitement pour un feed.
```

---

## Exercice 4 — DISTINCT

**Objectif :** lister les auteurs uniques qui ont posté dans `fam-1`.

```
Récupère la liste des author_id distincts pour family_id = 'fam-1'.
```

---

### Corrigé 4

```sql
SELECT DISTINCT author_id
FROM posts
WHERE family_id = 'fam-1'
ORDER BY author_id;

-- Résultat attendu :
--  u-1
--  u-2
--  u-3

-- DISTINCT déclenche un tri implicite pour éliminer les doublons.
-- Sur les grandes tables, préférer une sous-requête ou GROUP BY + index.
```

---

## Exercice 5 — UPDATE avec RETURNING

**Objectif :** corriger le contenu d'un post précis et confirmer la modification.

```
Met à jour le contenu du post 'Rappel : repas dimanche 14h'
(de family_id = 'fam-1', author_id = 'u-3')
→ nouveau contenu : 'Rappel : repas dimanche 13h (heure changée)'
Récupère id et content après la modification.
```

---

### Corrigé 5

```sql
-- Étape 1 (recommandé en prod) : vérifier la cible avec SELECT
SELECT id, content FROM posts
WHERE family_id = 'fam-1'
  AND author_id = 'u-3'
  AND content = 'Rappel : repas dimanche 14h';

-- Étape 2 : exécuter l'UPDATE avec RETURNING
UPDATE posts
SET content = 'Rappel : repas dimanche 13h (heure changée)'
WHERE family_id = 'fam-1'
  AND author_id = 'u-3'
  AND content = 'Rappel : repas dimanche 14h'
RETURNING id, content;

-- RETURNING confirme que la ligne a bien été modifiée.
-- Si RETURNING retourne 0 lignes → la clause WHERE ne matchait rien.

-- Piège à éviter : UPDATE posts SET content = '...' sans WHERE modifie TOUTES les lignes.
```

---

## Exercice 6 — DELETE avec RETURNING

**Objectif :** supprimer les posts antérieurs à 9 jours dans `fam-1` et confirmer ce qui a été supprimé.

```
Supprime les posts de family_id = 'fam-1'
dont created_at est antérieur à now() - INTERVAL '9 days'.
Récupère id et content des lignes supprimées.
```

---

### Corrigé 6

```sql
DELETE FROM posts
WHERE family_id = 'fam-1'
  AND created_at < now() - INTERVAL '9 days'
RETURNING id, content;

-- Résultat attendu : 1 ligne supprimée
--  Bienvenue dans l'espace famille ! | now() - 10 days

-- RETURNING indique exactement ce qui a été supprimé.
-- Sans WHERE → DELETE FROM posts supprime toutes les lignes de toute la table.
```

---

## Exercice 7 — Agrégation GROUP BY

**Objectif :** compter le nombre de posts par famille.

```
Pour chaque family_id, compte le nombre de posts
et la date du dernier post (MAX created_at).
Trie par nombre de posts décroissant.
```

---

### Corrigé 7

```sql
SELECT
  family_id,
  COUNT(*)          AS nb_posts,
  MAX(created_at)   AS dernier_post
FROM posts
GROUP BY family_id
ORDER BY nb_posts DESC;

-- Résultat attendu :
--  fam-1 | 4 | ... (après suppression exercice 6)
--  fam-2 | 2 | ...
--  fam-3 | 1 | ...
-- (+ les posts de la famille Bernard créés en ex. 2)

-- Toute colonne dans SELECT hors d'une agrégation doit être dans GROUP BY.
-- Ici seul family_id est dans GROUP BY → COUNT et MAX sont les seules agrégs autorisées.
```

---

## Exercice 8 — GROUP BY + HAVING + JOIN

**Objectif :** lister les familles avec au moins 2 posts, en affichant leur `name` (pas leur `id`).

```
Jointure family + post.
Groupe par f.id et f.name.
Filtre HAVING COUNT(p.id) >= 2.
Affiche name, nb_posts, dernier_post.
Trie par nb_posts DESC.
```

---

### Corrigé 8

```sql
SELECT
  f.name,
  COUNT(p.id)       AS nb_posts,
  MAX(p.created_at) AS dernier_post
FROM families f
JOIN posts p ON p.family_id = f.id
GROUP BY f.id, f.name
HAVING COUNT(p.id) >= 2
ORDER BY nb_posts DESC;

-- Résultat attendu (selon l'état après les exercices précédents) :
--  Les Bernard | 3 | ...
--  Les Dupont  | 2 | ...
--  Les Maurier | 4 | ...  (selon ce qui reste après le DELETE ex. 6)

-- Pourquoi GROUP BY f.id, f.name ?
-- f.id suffit fonctionnellement (PK → f.name dépend de f.id),
-- mais PostgreSQL requiert que f.name soit dans GROUP BY car il est dans SELECT sans agrégation.

-- Pourquoi HAVING et pas WHERE ?
-- WHERE ne peut pas filtrer sur COUNT(*) car il s'applique avant le GROUP BY.
-- HAVING filtre après : c'est la seule façon de filtrer sur une valeur agrégée.
```

---

## Vérification finale

Exécute cette requête de contrôle — elle doit retourner les familles avec le nombre de posts actuel :

```sql
SELECT f.name, COUNT(p.id) AS posts
FROM families f
LEFT JOIN posts p ON p.family_id = f.id
GROUP BY f.id, f.name
ORDER BY f.name;
```

Si tu vois `Les Bernard` avec 3 posts, `Les Dupont` avec 2, `Les Martin` avec 1, et `Les Maurier` avec 4 (ou 3 après le DELETE de l'ex. 6) → tout est correct.

---

## Variante J+30

Reviens dans 30 jours et refais sans regarder le corrigé :

1. Crée une table `comment (id UUID PK, post_id UUID FK, author_id TEXT, body TEXT, created_at TIMESTAMPTZ)`.
2. Insère 10 commentaires en batch sur plusieurs posts.
3. Liste les 5 posts les plus commentés (GROUP BY + HAVING + ORDER BY).
4. Pagination keyset : affiche les 5 commentaires précédant un curseur `created_at` donné.
5. Supprime tous les commentaires d'un auteur donné avec RETURNING.

Objectif : écrire les 5 requêtes en moins de 10 minutes sans aide.

---

## Application TribuZen

Porte ce lab dans le vrai repo `smaurier/tribuzen` :

1. Ouvre `schema.prisma` de TribuZen. Identifie les models `Family` et `Post`. Vérifie que les types correspondent à ce que tu as pratiqué (`String`, `DateTime`, `@default(now())`, `@relation`).
2. Dans psql sur ta base de développement TribuZen (`npx prisma db pull` si besoin), reproduis les exercices 1 et 7 avec les vraies tables (`Family`, `FamilyMember`, `Post`).
3. Écris la requête GROUP BY de l'exercice 7 dans un service NestJS (via `prisma.$queryRaw` ou un Repository), retourne le résultat en JSON dans un endpoint `GET /families/stats`.
4. Commit `smaurier/tribuzen` : `feat(db): CRUD queries families + posts feed`.
