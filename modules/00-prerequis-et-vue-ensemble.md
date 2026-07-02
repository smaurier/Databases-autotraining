---
titre: Prérequis et vue d'ensemble
cours: 10-postgresql
notions: [rôle d'une base de données, SGBD relationnel, présentation de PostgreSQL, installation et client psql, tables lignes colonnes, types de base, exécuter une requête, objectif du cours]
outcomes: [installer PostgreSQL et se connecter avec psql, exécuter des requêtes SQL de base, comprendre le modèle tables/lignes/colonnes, situer le parcours du cours]
prerequis: [notions informatiques de base]
next: 01-modele-relationnel
libs: [{ name: postgresql, version: "17" }]
tribuzen: mettre en place la base de données de TribuZen (première connexion, premières tables)
last-reviewed: 2026-07
---

# Prérequis et vue d'ensemble

> **Outcomes — tu sauras FAIRE :** installer PostgreSQL via Docker et te connecter avec psql, exécuter tes premières requêtes SQL, comprendre le modèle tables/lignes/colonnes, et situer le plan du cours.
> **Difficulté :** :star:

## 1. Cas concret d'abord

Tu démarres le backend de TribuZen. L'app gère des familles (`family`), des membres (`member_user`), et des invitations. Ces données doivent persister — survivre aux redémarrages du serveur, rester cohérentes si deux utilisateurs écrivent en même temps, être interrogeables avec des filtres.

Tu pourrais stocker ça dans un fichier JSON :

```json
{
  "families": [
    { "id": "fam-1", "name": "Les Dupont", "owner_id": "u-1" }
  ],
  "members": [
    { "family_id": "fam-1", "user_id": "u-2" }
  ]
}
```

Problèmes immédiats : deux requêtes en parallèle corrompent le fichier. Pour lister les membres d'une famille avec leur email, tu charges tout en mémoire et filtres en JavaScript. Si tu supprimes `fam-1`, les membres orphelins restent — aucune contrainte ne les bloque.

PostgreSQL résout les trois : **transactions** pour la concurrence, **SQL** pour les requêtes expressives, **clés étrangères** pour l'intégrité. Voici ce que tu vas installer et écrire dès ce module :

```sql
-- Dans psql, connecté à la base tribuzen
CREATE TABLE family (
    id         TEXT        PRIMARY KEY,
    name       TEXT        NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO family (id, name) VALUES ('fam-1', 'Les Dupont');

SELECT id, name FROM family;
--  id    |   name
-- -------+-----------
--  fam-1 | Les Dupont
```

Trois instructions SQL. Pas de bibliothèque, pas de code JavaScript. Tu te connectes, tu crées, tu interroges. Ce module explique comment arriver là et pose le socle de tout le cours.

## 2. Théorie complète, concise

### Rôle d'une base de données

Une base de données fait quatre choses qu'un fichier JSON ne garantit pas :

1. **Persistance structurée** — les données survivent aux redémarrages et respectent un schéma déclaré à l'avance.
2. **Cohérence** — les contraintes (`NOT NULL`, `UNIQUE`, clé étrangère) sont vérifiées automatiquement à chaque écriture par le moteur.
3. **Concurrence** — des milliers de lectures et écritures simultanées sans corruption de données.
4. **Interrogation** — filtres, jointures, agrégations exprimés en SQL, exécutés par le moteur sans code applicatif de tri ou de boucle.

### SGBD relationnel

Un **SGBD** (Système de Gestion de Base de Données) est le logiciel qui gère la base. **Relationnel** signifie que les données sont organisées en **tables** liées entre elles par des références. Trois concepts fondamentaux :

| Concept | Définition | Exemple TribuZen |
|---------|-----------|-----------------|
| **Table** | Ensemble de données de même nature | `family`, `member_user`, `invitation` |
| **Ligne (tuple)** | Un enregistrement individuel | une famille spécifique |
| **Colonne (attribut)** | Une propriété typée de chaque ligne | `name TEXT`, `created_at TIMESTAMPTZ` |

Chaque table a une **clé primaire** — identifiant unique par ligne (`id`). Les tables se relient via des **clés étrangères** : `member.family_id` référence `family.id`, empêchant les membres orphelins.

SQL (Structured Query Language) est le langage **déclaratif** qui interroge ces tables : tu décris *ce que tu veux*, pas *comment l'obtenir*. Le moteur choisit le plan d'exécution optimal.

### Présentation de PostgreSQL

PostgreSQL est un SGBD relationnel open-source lancé en 1986 à UC Berkeley, distribué sous licence PostgreSQL (MIT-like). Il est élu "DBMS of the Year" par DB-Engines en 2017, 2018, 2023 et 2024. Points clés pour ce cours :

- **Conformité SQL très élevée** — ce que tu apprends ici est du SQL standard, transférable.
- **Types riches** — `JSONB`, `ARRAY`, `UUID`, `TIMESTAMPTZ`, types géométriques, ranges.
- **Extensions** — `PostGIS` (géo), `pgvector` (embeddings IA), `pg_trgm` (recherche approximative).
- **MVCC natif** — les lectures ne bloquent pas les écritures (Multi-Version Concurrency Control, cf. module 09).
- **WAL** — les données commitées survivent à un crash (Write-Ahead Log, cf. module 04).
- **Gratuit et auto-hébergeable** — utilisé en production par Apple, Instagram, GitLab, Shopify.

PostgreSQL 17 (octobre 2024) apporte `JSON_TABLE`, les sauvegardes incrémentales, et `MERGE RETURNING`.

### Installation et client psql

La façon la plus reproductible d'installer PostgreSQL en développement est Docker. Un seul `docker run` suffit :

```bash
docker run \
  --name tribuzen-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=tribuzen \
  -p 5432:5432 \
  -v tribuzen-pgdata:/var/lib/postgresql/data \
  -d \
  postgres:17
```

`psql` est le client officiel en ligne de commande. Il se connecte au conteneur via `docker exec` :

```bash
docker exec -it tribuzen-pg psql -U postgres -d tribuzen
```

Le prompt `tribuzen=#` confirme la connexion. Les **méta-commandes** psql commencent par `\` et ne sont pas du SQL :

| Commande | Action |
|----------|--------|
| `\l` | lister les bases de données |
| `\c nomdb` | se connecter à une base |
| `\dt` | lister les tables du schéma courant |
| `\d nomtable` | décrire une table (colonnes, types, contraintes) |
| `\timing` | afficher le temps d'exécution de chaque requête |
| `\x` | basculer en affichage vertical (une colonne par ligne) |
| `\i fichier.sql` | exécuter un fichier SQL |
| `\q` | quitter psql |
| `\h SELECT` | aide syntaxe d'une commande SQL |

### Tables, lignes, colonnes, types de base

Une table se déclare avec `CREATE TABLE`. Chaque colonne a un **type** qui contraint les valeurs acceptées :

```sql
CREATE TABLE family (
    id         TEXT        PRIMARY KEY,   -- identifiant unique, texte libre
    name       TEXT        NOT NULL,      -- obligatoire, refuse NULL
    max_size   INTEGER     DEFAULT 10,    -- entier, valeur par défaut
    is_active  BOOLEAN     DEFAULT true,  -- vrai/faux
    created_at TIMESTAMPTZ DEFAULT now() -- horodatage avec fuseau horaire
);
```

Types fondamentaux à retenir pour TribuZen :

| Type | Usage | Exemple |
|------|-------|---------|
| `TEXT` | chaîne de longueur variable | `'Les Dupont'` |
| `INTEGER` | entier 32 bits | `10` |
| `BIGINT` | entier 64 bits (compteurs, grands IDs) | `9007199254740992` |
| `NUMERIC(p,s)` | décimal exact (finances) | `NUMERIC(10,2)` |
| `BOOLEAN` | vrai/faux | `true`, `false` |
| `TIMESTAMPTZ` | horodatage + fuseau UTC | `'2026-07-01 14:00+02'` |
| `UUID` | identifiant universel unique | `gen_random_uuid()` |
| `JSONB` | JSON binaire indexable | `'{"key": "val"}'` |

### Exécuter une requête

Les quatre opérations CRUD en SQL sur TribuZen :

```sql
-- INSERT — créer une ligne
INSERT INTO family (id, name) VALUES ('fam-1', 'Les Dupont');

-- SELECT — lire des données
SELECT id, name, created_at FROM family WHERE is_active = true ORDER BY name;

-- UPDATE — modifier une ligne
UPDATE family SET name = 'Dupont-Martin' WHERE id = 'fam-1';

-- DELETE — supprimer une ligne
DELETE FROM family WHERE id = 'fam-1';
```

Toute instruction SQL se termine par un **point-virgule** en psql. Sans lui, psql attend silencieusement la suite (prompt `tribuzen(#-`), sans exécuter ni afficher d'erreur.

## 3. Worked examples

### Exemple A — démarrer PostgreSQL et créer les premières tables TribuZen

Objectif : lancer le conteneur, se connecter avec psql, créer les tables `family` et `member_user`, insérer des données et les lire.

```bash
# 1. Démarrer le conteneur PostgreSQL 17
docker run \
  --name tribuzen-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=tribuzen \
  -p 5432:5432 \
  -v tribuzen-pgdata:/var/lib/postgresql/data \
  -d postgres:17

# 2. Vérifier que le conteneur tourne
docker ps

# 3. Se connecter avec psql
docker exec -it tribuzen-pg psql -U postgres -d tribuzen
```

```sql
-- 4. Créer la table family
CREATE TABLE family (
    id         TEXT        PRIMARY KEY,
    name       TEXT        NOT NULL,
    max_size   INTEGER     DEFAULT 10,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. Créer la table member_user (USER est un mot réservé SQL)
CREATE TABLE member_user (
    id           TEXT NOT NULL PRIMARY KEY,
    email        TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT now()
);

-- 6. Vérifier les structures créées
\dt
\d family
\d member_user

-- 7. Insérer des données
INSERT INTO family (id, name) VALUES
    ('fam-1', 'Les Dupont'),
    ('fam-2', 'Les Martin');

INSERT INTO member_user (id, email, display_name) VALUES
    ('u-1', 'alice@tribu.fr', 'Alice Dupont'),
    ('u-2', 'bob@tribu.fr',   'Bob Martin');

-- 8. Lire les données
SELECT id, name, max_size FROM family ORDER BY name;
SELECT id, email, display_name FROM member_user;
```

Pas-à-pas : (1) le flag `-v tribuzen-pgdata:/var/lib/postgresql/data` crée un volume Docker nommé — les données survivent à `docker rm` ; (2) `TEXT PRIMARY KEY` déclare la clé primaire sans `SERIAL` — l'ID sera géré côté applicatif (UUID en production) ; (3) `UNIQUE` sur `email` délègue le contrôle des doublons au moteur, pas à l'appli ; (4) `\d member_user` dans psql affiche les colonnes, leurs types et la contrainte `member_user_email_key` créée automatiquement par l'index unique.

### Exemple B — tester les contraintes et explorer avec les méta-commandes

Objectif : observer qu'une contrainte `UNIQUE` bloque une insertion en doublon, et utiliser les méta-commandes psql pour naviguer dans la base.

```sql
-- Tenter d'insérer un email déjà présent
INSERT INTO member_user (id, email, display_name)
VALUES ('u-3', 'alice@tribu.fr', 'Alice Bis');
-- ERROR:  duplicate key value violates unique constraint "member_user_email_key"
-- DETAIL: Key (email)=(alice@tribu.fr) already exists.
-- PostgreSQL refuse l'insertion — erreur moteur, pas applicative.

-- Activer le timing pour mesurer les requêtes
\timing

SELECT COUNT(*) AS total FROM family;
--  total
-- -------
--      2
-- Time: 0.543 ms

-- Basculer en affichage vertical
\x

SELECT * FROM member_user;
-- -[ RECORD 1 ]-----------
-- id           | u-1
-- email        | alice@tribu.fr
-- display_name | Alice Dupont
-- created_at   | 2026-07-01 14:00:00+02

-- Revenir à l'affichage tabulaire
\x
\timing
\q
```

Pas-à-pas : (1) l'erreur `duplicate key value violates unique constraint` vient du moteur — même si l'appli n'effectue pas de vérification, PostgreSQL bloque ; (2) `\timing` s'active/désactive par alternance — le temps en ms apparaît sous chaque résultat ; (3) `\x` bascule l'affichage vertical : utile pour les tables larges ou les lignes avec de nombreuses colonnes ; (4) `\q` quitte proprement psql et libère la connexion.

## 4. Pièges & misconceptions

- **Oublier le point-virgule.** En psql, une commande sans `;` n'est pas exécutée — le prompt passe à `tribuzen(#-` et attend la suite. Aucun message d'erreur, attente silencieuse indéfinie. *Correct* : terminer chaque instruction par `;` avant Entrée.

- **Supprimer le conteneur sans volume nommé.** `docker rm tribuzen-pg` puis `docker run ...` sans `-v` recrée un conteneur vide — toutes les données sont perdues. *Correct* : nommer le volume (`-v tribuzen-pgdata:/var/lib/postgresql/data`) dès le premier `docker run`. Le volume persiste indépendamment du conteneur.

- **Utiliser `user` comme nom de table.** `USER` est un mot réservé SQL — `CREATE TABLE user (...)` provoque une erreur de syntaxe. Même chose pour `order`, `group`, `table`, `select`. *Correct* : nommer `member_user`, `app_user`, ou `account` — vérifier avec `\h` les mots réservés.

- **Croire que `VARCHAR(255)` est plus performant que `TEXT`.** En PostgreSQL, `TEXT` et `VARCHAR` sans longueur ont des performances identiques. `VARCHAR(255)` n'apporte aucun gain de vitesse — c'est un mythe hérité de MySQL. *Correct* : utiliser `TEXT` par défaut ; réserver `VARCHAR(n)` uniquement quand la longueur maximale est une contrainte métier explicite.

- **Confondre `TIMESTAMP` et `TIMESTAMPTZ`.** `TIMESTAMP` stocke l'heure sans fuseau — si le serveur change de timezone ou si des utilisateurs sont dans plusieurs pays, les données deviennent ambiguës. *Correct* : toujours utiliser `TIMESTAMPTZ` — PostgreSQL stocke en UTC et convertit à l'affichage selon la timezone de la session.

- **Croire que `SELECT *` est neutre.** `SELECT *` retourne les colonnes dans l'ordre de définition de la table. Si la table évolue (ajout ou réordonnancement de colonne), le code qui suppose une position par index (`rows[0][2]`) se casse silencieusement. *Correct* : nommer les colonnes explicitement dans le code applicatif ; `SELECT *` reste acceptable pour l'exploration interactive en psql.

## 5. Ancrage TribuZen

Couche fil-rouge : **base de données de TribuZen** dans `smaurier/tribuzen`.

- Les tables `family` et `member_user` créées dans les Worked examples sont les premières tables réelles de TribuZen. Elles seront enrichies à chaque module : clés étrangères (module 01), CRUD complet via Prisma (module 02), jointures pour récupérer les membres d'une famille (module 03), transactions pour l'acceptation d'invitation (module 04).
- Le conteneur `tribuzen-pg` avec le volume `tribuzen-pgdata` devient l'environnement de développement local du cours — il reste actif tout au long des modules suivants. Pour reprendre après un arrêt : `docker start tribuzen-pg`, pas `docker run`.
- La connexion psql directe est l'outil de débogage de premier recours tout au long du cours : inspecter l'état réel de la base, tester une requête avant intégration, vérifier une contrainte après migration.
- `gen_random_uuid()` (fonction native PostgreSQL 17, sans extension) remplacera les IDs textuels manuels à partir du module 01 — adapté à une app multi-appareils où les IDs doivent être uniques sans coordination centrale.

## 6. Points clés

1. Une base de données relationnelle garantit persistance, cohérence, concurrence et interrogeabilité — ce qu'un fichier JSON ne peut pas offrir de manière fiable.
2. PostgreSQL est le SGBD open-source le plus conforme SQL, extensible, et utilisé en production à grande échelle. Version de référence du cours : PostgreSQL 17.
3. Le modèle est simple : **tables** (noms) → **colonnes** (types) → **lignes** (valeurs). Les tables se relient par clés étrangères.
4. Démarrer avec Docker (`postgres:17`) + volume nommé = environnement reproductible, données persistées entre redémarrages.
5. `psql` est l'outil de référence : méta-commandes `\dt`, `\d nomtable`, `\timing`, `\x`, `\q` suffisent pour explorer et déboguer toute la durée du cours.
6. Types essentiels : `TEXT`, `INTEGER`, `BOOLEAN`, `NUMERIC`, `TIMESTAMPTZ`, `UUID`. Préférer `TEXT` à `VARCHAR(n)` sans raison, et `TIMESTAMPTZ` à `TIMESTAMP` systématiquement.
7. Toute instruction SQL se termine par `;` en psql. Sans lui, le prompt attend en silence.
8. `USER`, `ORDER`, `GROUP`, `TABLE`, `SELECT` sont des mots réservés SQL — ne pas les utiliser comme noms de table.

## 7. Seeds Anki

```
Qu'est-ce qu'un SGBD relationnel ?|Un logiciel qui stocke des données dans des tables liées, garantit leur cohérence par des contraintes, gère la concurrence, et les interroge via SQL
Différence entre TIMESTAMP et TIMESTAMPTZ en PostgreSQL ?|TIMESTAMP stocke l'heure sans fuseau (ambiguë si timezone change) ; TIMESTAMPTZ stocke l'instant UTC et l'affiche dans la timezone de la session — toujours utiliser TIMESTAMPTZ
Pourquoi TEXT est préférable à VARCHAR(255) en PostgreSQL ?|TEXT et VARCHAR sans longueur sont identiques en performance ; VARCHAR(n) n'apporte aucun gain et est un mythe hérité d'autres SGBD
Commande psql pour décrire la structure d'une table ?|\d nomtable — affiche les colonnes, types, valeurs par défaut et contraintes
Que se passe-t-il si on oublie le point-virgule dans psql ?|psql attend silencieusement la suite (prompt base(#-) — aucune exécution, aucun message d'erreur
Pourquoi nommer le volume Docker de PostgreSQL ?|Sans volume nommé les données sont perdues à docker rm ; avec -v tribuzen-pgdata:/var/lib/postgresql/data elles survivent à la suppression du conteneur
Pourquoi éviter USER comme nom de table en PostgreSQL ?|USER est un mot réservé SQL — CREATE TABLE user provoque une erreur de syntaxe ; utiliser member_user ou account
Rôle de la contrainte UNIQUE sur une colonne email ?|Interdit deux lignes avec la même valeur — PostgreSQL rejette l'INSERT avec duplicate key value violates unique constraint, sans code applicatif
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-01-premiers-pas-psql/`. Tu démarres PostgreSQL 17 en Docker, crées les premières tables de TribuZen (`family`, `member_user`) depuis psql, insères des données, testes les contraintes et utilises les méta-commandes d'exploration. Corrigé SQL complet commenté + variante J+30 dans le README du lab.
