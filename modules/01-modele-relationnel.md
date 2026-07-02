---
titre: Modèle relationnel
cours: 10-postgresql
notions: [modèle relationnel, tables et relations, clé primaire, clé étrangère, contraintes NOT NULL UNIQUE CHECK, normalisation 1NF 2NF 3NF, types de données PostgreSQL, DDL CREATE TABLE]
outcomes: [modéliser un schéma relationnel avec clés et contraintes, écrire le DDL de création de tables, appliquer la normalisation jusqu'en 3NF, choisir les bons types]
prerequis: [00-prerequis-et-vue-ensemble]
next: 02-crud-et-requetes
libs: [{ name: postgresql, version: "17" }]
tribuzen: schéma relationnel de TribuZen (users, families, family_members, posts) avec clés et contraintes
last-reviewed: 2026-07
---

# Modèle relationnel

> **Outcomes — tu sauras FAIRE :** modéliser un schéma relationnel avec clés et contraintes, écrire le DDL de création de tables, appliquer la normalisation jusqu'en 3NF, choisir les bons types PostgreSQL.
> **Difficulté :** :star:

## 1. Cas concret d'abord

TribuZen doit stocker des familles, leurs membres et leurs posts. Première ébauche naïve : une seule table `post` avec les infos famille et auteur répétées à chaque ligne.

```sql
-- Modélisation naïve (non relationnelle)
-- post_id | post_content       | family_name | author_name | author_email
-- --------|--------------------|-------------|-------------|------------------
-- 1       | Joyeux anniversaire| Dupont      | Alice       | alice@tribu.fr
-- 2       | Photo vacances     | Dupont      | Bob         | bob@tribu.fr
-- 3       | Bonne année        | Martin      | Claire      | claire@tribu.fr
```

Trois problèmes immédiats : si Alice change d'email, il faut mettre à jour chaque post qu'elle a écrit. Si la famille Dupont change de nom, idem. Et rien n'empêche d'insérer `author_email = NULL` sur un post. Le modèle relationnel résout ça par la **séparation des entités**, les **clés étrangères** et les **contraintes**.

La suite montre les fondations théoriques, les types PostgreSQL, le DDL, la normalisation — et débouche sur le schéma réel de TribuZen.

## 2. Théorie complète, concise

### Le modèle relationnel

Edgar Codd (IBM, 1970) propose de ranger les données dans des **relations** (tables), reliées entre elles par des clés plutôt que par des pointeurs. L'algèbre relationnelle fournit les opérations (sélection, projection, jointure) — SQL en est l'implémentation concrète.

| Terme formel | Terme courant | DDL PostgreSQL |
|---|---|---|
| Relation | Table | `CREATE TABLE` |
| Tuple | Ligne, row | Une rangée de données |
| Attribut | Colonne, champ | `email TEXT NOT NULL` |
| Domaine | Type | `TEXT`, `INTEGER`, `TIMESTAMPTZ`… |
| Clé candidate | Identifiant unique potentiel | `UNIQUE` |
| Clé primaire | Identifiant officiel | `PRIMARY KEY` |

Règle fondamentale : chaque table doit avoir une **clé primaire** — un ou plusieurs attributs qui identifient chaque ligne de façon unique et permanente.

### Types de données PostgreSQL

Choisir le bon type, c'est déléguer la validation à la base plutôt qu'à l'application.

**Texte**

```sql
-- TEXT : longueur illimitée, performances identiques à VARCHAR
-- Recommandé par défaut ; utiliser VARCHAR(n) uniquement si contrainte métier stricte
email       TEXT NOT NULL
pseudo      TEXT NOT NULL
description TEXT          -- nullable : champ optionnel
```

**Nombres**

```sql
-- INTEGER (4 octets) : entier standard — compteurs, IDs si pas de distribution
-- BIGINT  (8 octets) : compteurs à grande échelle
-- NUMERIC(p, s)      : montants financiers (exact), éviter REAL / DOUBLE PRECISION
members_count  INTEGER  NOT NULL DEFAULT 0
monthly_fee    NUMERIC(10, 2)
```

**Date et heure**

```sql
-- TIMESTAMPTZ : date + heure + fuseau (stocké UTC, converti à la lecture)
-- Ne jamais utiliser TIMESTAMP sans TZ : pas de fuseau = bugs multi-fuseaux
created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Identifiants et booléens**

```sql
-- UUID : id distribué, sûr à exposer dans les URLs d'API
-- BOOLEAN : true / false / NULL
id          UUID        NOT NULL DEFAULT gen_random_uuid()
is_public   BOOLEAN     NOT NULL DEFAULT false
```

**Auto-incrément**

```sql
-- GENERATED ALWAYS AS IDENTITY : standard SQL (PG 10+), préférable à SERIAL
id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY
-- SERIAL : ancien style, évité dans les nouveaux projets
```

Pour TribuZen, les tables `users`, `families`, `family_members` et `posts` utilisent des UUID comme clés primaires (exposition dans les API REST) et `TIMESTAMPTZ` pour toutes les dates.

### DDL CREATE TABLE

La syntaxe complète avec les contraintes les plus utiles :

```sql
CREATE TABLE nom_table (
    -- Colonnes avec leurs contraintes inline
    col_1  TYPE  NOT NULL,
    col_2  TYPE  NOT NULL DEFAULT valeur,
    col_3  TYPE  CHECK (condition),
    col_4  TYPE  UNIQUE,

    -- Contraintes de table (multi-colonnes ou nommées explicitement)
    CONSTRAINT nom_contrainte UNIQUE (col_a, col_b),
    CONSTRAINT nom_check CHECK (col_c > 0)
);
```

**Clé étrangère (FOREIGN KEY / REFERENCES)**

```sql
-- Inline (colonne unique)
family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE

-- Niveau table (clé composite ou nom explicite)
CONSTRAINT fk_family FOREIGN KEY (family_id) REFERENCES families(id) ON DELETE CASCADE
```

Comportements `ON DELETE` utiles :

| Option | Effet |
|---|---|
| `CASCADE` | Supprime les lignes enfant quand la ligne parent est supprimée |
| `SET NULL` | Met la FK à NULL (colonne doit être nullable) |
| `RESTRICT` (défaut) | Bloque la suppression si des lignes enfant existent |

### Normalisation

La normalisation élimine la redondance et les anomalies de mise à jour. Les trois premières formes normales couvrent la quasi-totalité des cas pratiques.

**1NF — valeurs atomiques, pas de groupes répétés**

Chaque cellule contient une seule valeur ; pas de colonnes répétées du type `role_1`, `role_2`, `role_3`.

```sql
-- MAUVAIS : valeurs non atomiques, groupes répétés
CREATE TABLE membre_bad (
    id       INTEGER PRIMARY KEY,
    roles    TEXT    -- 'owner,admin' — deux valeurs dans une colonne
);

-- BON : 1NF — chaque cellule = une valeur
CREATE TABLE family_member (
    family_id  UUID NOT NULL,
    user_id    UUID NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
    PRIMARY KEY (family_id, user_id)
);
```

**2NF — dépendance totale à la clé primaire**

S'applique aux tables avec clé composite : chaque attribut non-clé doit dépendre de **toute** la clé, pas d'une partie.

```sql
-- MAUVAIS : family_name dépend de family_id seulement, pas de (family_id, user_id)
CREATE TABLE member_bad (
    family_id    UUID NOT NULL,
    user_id      UUID NOT NULL,
    role         TEXT NOT NULL,
    family_name  TEXT NOT NULL,   -- dépendance partielle !
    PRIMARY KEY (family_id, user_id)
);

-- BON : family_name dans families, pas dans la table de jonction
-- Voir schéma TribuZen complet ci-dessous
```

**3NF — pas de dépendance transitive**

Aucun attribut non-clé ne doit dépendre d'un autre attribut non-clé.

```sql
-- MAUVAIS : city dépend de zip_code, pas de id (transitivité id -> zip_code -> city)
CREATE TABLE user_bad (
    id        UUID PRIMARY KEY,
    zip_code  TEXT NOT NULL,
    city      TEXT NOT NULL   -- dépend de zip_code, pas de id
);

-- BON : extraire la dépendance dans sa propre table
CREATE TABLE zip_code (
    code  TEXT PRIMARY KEY,
    city  TEXT NOT NULL
);
CREATE TABLE users (
    id        UUID PRIMARY KEY,
    zip_code  TEXT REFERENCES zip_code(code)
);
```

En pratique, un schéma TribuZen en 3NF signifie : les infos utilisateur vivent dans `users`, les infos famille dans `families`, l'appartenance dans `family_members`, les posts dans `posts` — chaque entité dans sa table, les relations via FK.

## 3. Worked examples

### Exemple A — Schéma TribuZen complet (users, families, family_members, posts)

```sql
-- Table des utilisateurs
CREATE TABLE users (
    id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    email         TEXT        NOT NULL UNIQUE,
    display_name  TEXT        NOT NULL,
    avatar_url    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table des familles
CREATE TABLE families (
    id             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    name           TEXT        NOT NULL,
    description    TEXT,
    is_public      BOOLEAN     NOT NULL DEFAULT false,
    members_count  INTEGER     NOT NULL DEFAULT 0 CHECK (members_count >= 0),
    created_by     UUID        NOT NULL REFERENCES users(id),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table de jonction : appartenance d'un user à une famille
-- Clé primaire composite : un user ne peut avoir qu'un rôle par famille
CREATE TABLE family_members (
    family_id   UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    user_id     UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    role        TEXT        NOT NULL DEFAULT 'member'
                            CHECK (role IN ('owner', 'admin', 'member', 'guest')),
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (family_id, user_id)
);

-- Table des posts
CREATE TABLE posts (
    id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    family_id   UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
    author_id   UUID        NOT NULL REFERENCES users(id),
    content     TEXT        NOT NULL CHECK (char_length(content) > 0),
    is_pinned   BOOLEAN     NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Pas-à-pas : (1) `users` ne contient que les attributs propres à l'utilisateur — aucune info famille ; (2) `families` contient un `members_count` dénormalisé intentionnellement pour les performances (updated en transaction au module 04) ; (3) `family_members` est en 2NF : `role` et `joined_at` dépendent de `(family_id, user_id)` ensemble — pas d'un seul des deux ; (4) `posts` référence `families` et `users` par FK avec `ON DELETE CASCADE` : si une famille est supprimée, ses posts le sont aussi ; (5) tous les UUID ont `DEFAULT gen_random_uuid()` — l'application peut ne pas fournir l'id à l'insertion.

### Exemple B — Évolution du schéma : ajouter une contrainte NOT NULL après coup

En développement, tu ajoutes une colonne sans la rendre obligatoire, puis tu veux la contraindre après avoir rempli les données existantes.

```sql
-- Étape 1 : ajouter la colonne nullable (rapide, pas de réécriture de table)
ALTER TABLE users ADD COLUMN timezone TEXT;

-- Étape 2 : remplir les lignes existantes
UPDATE users SET timezone = 'UTC' WHERE timezone IS NULL;

-- Étape 3 : ajouter NOT NULL + DEFAULT (scan de la table, mais pas de réécriture complète)
ALTER TABLE users
    ALTER COLUMN timezone SET NOT NULL,
    ALTER COLUMN timezone SET DEFAULT 'UTC';
```

Pas-à-pas : l'ordre compte. Ajouter `NOT NULL` directement sur une table remplie avec des NULLs échouerait. En production, on fait les trois étapes dans une migration — idéalement sans downtime si la table est grande (zero-downtime ALTER est un sujet avancé couvert au module index).

## 4. Pièges & misconceptions

- **`TIMESTAMP` au lieu de `TIMESTAMPTZ`.** `TIMESTAMP` ne stocke pas l'information de fuseau. Si ton serveur passe de Paris à UTC, toutes tes dates "glissent". *Correct* : toujours `TIMESTAMPTZ` ; PostgreSQL stocke en UTC interne et convertit selon le fuseau de session.

- **`REAL` ou `DOUBLE PRECISION` pour les montants.** Ces types utilisent la virgule flottante IEEE 754 : `0.1 + 0.2 = 0.30000000000000004`. *Correct* : `NUMERIC(p, s)` pour les montants exacts, ou stocker des centimes en `INTEGER`.

- **`VARCHAR(255)` comme reflexe.** En PostgreSQL, `TEXT` et `VARCHAR(n)` ont exactement les mêmes performances de stockage et d'accès. `VARCHAR(255)` n'optimise rien — il ajoute une contrainte arbitraire. *Correct* : utiliser `TEXT` par défaut, `VARCHAR(n)` uniquement si une limite métier réelle existe (code ISO à 3 caractères par exemple).

- **UNIQUE autorise plusieurs NULL.** `UNIQUE` garantit qu'aucune valeur non-NULL n'est dupliquée, mais plusieurs lignes peuvent avoir `NULL` dans une colonne `UNIQUE`. C'est conforme au standard SQL (`NULL ≠ NULL`). *Correct* : ajouter `NOT NULL` si le champ doit être à la fois unique et obligatoire.

- **Clé primaire entière sur une API publique.** Exposer `id = 42` dans une URL permet d'énumérer les ressources (IDOR). *Correct* : UUID (`gen_random_uuid()`) pour les entités exposées en API, séquences entières pour les tables purement internes.

- **Normaliser à l'excès.** La 3NF dit de supprimer les dépendances transitives, pas de tout extraire dans des tables séparées. `members_count` dans `families` est une dénormalisation *intentionnelle et documentée* pour éviter un `COUNT(*)` à chaque affichage du profil famille. La dénormalisation est acceptable quand le coût de la cohérence est géré explicitement (transaction + contrainte CHECK).

- **`ON DELETE CASCADE` partout sans réfléchir.** Sur `family_members → families`, `CASCADE` est justifié : les membres d'une famille supprimée n'ont plus de sens. Sur `posts → users`, `CASCADE` supprimerait tous les posts d'un utilisateur si on le supprime — souvent non voulu (on veut garder l'historique avec un `author_id` anonymisé). *Correct* : choisir `ON DELETE SET NULL` ou `RESTRICT` selon la sémantique métier.

## 5. Ancrage TribuZen

Couche fil-rouge : **schéma relationnel de TribuZen** (`smaurier/tribuzen`).

- Les quatre tables (`users`, `families`, `family_members`, `posts`) forment le noyau du produit. Toute feature TribuZen (invitation, RBAC, feed de posts, stats famille) s'appuie sur ces tables.
- La clé composite de `family_members (family_id, user_id)` est en 2NF stricte : `role` et `joined_at` dépendent du couple complet, pas d'un seul id. Cela interdit naturellement qu'un user ait deux rôles dans la même famille.
- Les FK avec `ON DELETE CASCADE` sur `family_members` et `posts` garantissent qu'une famille supprimée ne laisse pas de lignes orphelines — intégrité référentielle gérée par le moteur, pas par l'application.
- Le `members_count` dans `families` est une dénormalisation documentée : la colonne est maintenue à jour via une transaction atomique (module 04 — Transactions et ACID). Le `CHECK (members_count >= 0)` est un filet de sécurité contre un bug de synchronisation.
- En session, ce schéma sera créé sur une vraie base Postgres locale (Docker), les CRUD exercés au module 02, les transactions au module 04, les index au module 05.

> **Note pratique :** la pratique SQL sur ce schéma commence au module 02 (CRUD et requêtes). Ce module est conceptuel et de design — l'objectif est de savoir écrire et justifier le DDL avant de le peupler.

## 6. Points clés

1. Le modèle relationnel organise les données en tables (relations), lignes (tuples) et colonnes (attributs), reliées par des clés — pas par des pointeurs.
2. Chaque table doit avoir une clé primaire : `GENERATED ALWAYS AS IDENTITY` pour les entiers, `UUID DEFAULT gen_random_uuid()` pour les API exposées.
3. Contraintes fondamentales : `NOT NULL` (champ obligatoire), `UNIQUE` (valeur unique, plusieurs NULL autorisés), `CHECK (condition)`, `DEFAULT valeur`.
4. `FOREIGN KEY … REFERENCES` matérialise une relation entre tables ; `ON DELETE CASCADE / SET NULL / RESTRICT` pilote le comportement à la suppression du parent.
5. Types à retenir : `TEXT` (texte par défaut, pas `VARCHAR(255)`), `NUMERIC(p, s)` (montants), `TIMESTAMPTZ` (jamais `TIMESTAMP`), `UUID`, `BOOLEAN`, `INTEGER` / `BIGINT`.
6. 1NF : une valeur par cellule, pas de groupes répétés. 2NF : dépendance totale à la clé primaire. 3NF : pas de dépendance transitive entre attributs non-clés.
7. `ON DELETE CASCADE` est justifié quand l'enfant n'a pas de sens sans le parent (membres → famille) ; `SET NULL` ou `RESTRICT` quand l'historique doit être conservé.
8. La dénormalisation intentionnelle (ex. `members_count`) est acceptable si la cohérence est garantie par une transaction et une contrainte `CHECK`.

## 7. Seeds Anki

```
Différence TIMESTAMPTZ vs TIMESTAMP en PostgreSQL ?|TIMESTAMPTZ stocke en UTC interne et convertit au fuseau de session ; TIMESTAMP ignore le fuseau, source de bugs multi-fuseaux. Toujours utiliser TIMESTAMPTZ.
Pourquoi TEXT est préféré à VARCHAR(255) en PostgreSQL ?|En PostgreSQL TEXT et VARCHAR ont exactement les mêmes performances. VARCHAR(255) ajoute une contrainte arbitraire sans bénéfice. Utiliser TEXT par défaut.
Qu'est-ce que la 2NF et quand s'applique-t-elle ?|La 2NF s'applique aux tables à clé composite : chaque attribut non-clé doit dépendre de TOUTE la clé, pas d'une partie seulement. Exemple : family_name dans family_members est une dépendance partielle vers family_id — violation de la 2NF.
Que garantit ON DELETE CASCADE sur une FK ?|Quand la ligne parente est supprimée, toutes les lignes enfant référençant cette clé sont automatiquement supprimées. Utile pour les entités sans sens sans le parent (ex. family_members → families).
Différence entre PRIMARY KEY et UNIQUE en PostgreSQL ?|PRIMARY KEY = NOT NULL + UNIQUE + identifiant officiel de la table (une seule par table). UNIQUE = unicité des valeurs non-NULL, plusieurs NULL autorisés, plusieurs colonnes UNIQUE possibles par table.
Pourquoi NUMERIC(p, s) pour les montants et pas REAL ?|REAL utilise la virgule flottante IEEE 754 : 0.1 + 0.2 = 0.30000000000000004. NUMERIC est un type à précision exacte, sans erreur d'arrondi. Indispensable pour les montants financiers.
Qu'est-ce que la 3NF ?|Troisième forme normale : aucun attribut non-clé ne dépend d'un autre attribut non-clé (pas de dépendance transitive). Exemple : si city dépend de zip_code et zip_code de id, city viole la 3NF — extraire zip_code dans sa propre table.
Pourquoi utiliser UUID comme clé primaire sur une API publique ?|Un id entier auto-incrémenté (1, 2, 3…) permet l'énumération des ressources (IDOR). Un UUID est opaque et non devinable. gen_random_uuid() génère un UUID v4 aléatoire dans PostgreSQL 13+.
Que se passe-t-il si on insère NULL dans une colonne UNIQUE ?|PostgreSQL autorise plusieurs NULL dans une colonne UNIQUE (NULL ≠ NULL selon le standard SQL). Pour interdire les NULL ET garantir l'unicité, combiner UNIQUE et NOT NULL.
```
