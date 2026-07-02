---
titre: Sécurité et administration
cours: 10-postgresql
notions: [rôles et privilèges GRANT REVOKE, principe du moindre privilège, Row-Level Security RLS et policies, authentification pg_hba.conf, chiffrement SSL, prévention des injections SQL, sauvegarde pg_dump et restauration]
outcomes: [gérer rôles et privilèges au moindre privilège, isoler les données par tenant avec RLS, prévenir les injections SQL, sauvegarder et restaurer la base]
prerequis: [13-jsonb-et-types-avances]
next: 15-projet-final
libs: [{ name: postgresql, version: "17" }]
tribuzen: isoler les données par famille avec Row-Level Security dans TribuZen (une famille ne voit que ses posts)
last-reviewed: 2026-07
---

# Sécurité et administration

> **Outcomes — tu sauras FAIRE :** créer des rôles au moindre privilège, isoler les données par famille avec RLS, prévenir les injections SQL avec des requêtes paramétrées, sauvegarder et restaurer une base PostgreSQL.
> **Difficulté :** :star::star::star::star:

## 1. Cas concret d'abord

Dans TribuZen, la table `posts` contient les messages de **toutes les familles**. Sans protection, un seul bug dans l'application suffit à fuiter l'intégralité des données :

```sql
-- Bug applicatif : filtre family_id oublié dans le handler de feed
SELECT id, content, author_id, created_at
FROM posts
ORDER BY created_at DESC
LIMIT 20;
-- Retourne les posts de TOUTES les familles. Fuite silencieuse.
```

Trois vecteurs distincts à neutraliser :

1. **Excès de privilèges** — l'utilisateur applicatif peut exécuter `DROP TABLE posts` ou `TRUNCATE posts`, opérations qu'il n'a jamais besoin de faire.
2. **Absence de Row-Level Security** — même connecté avec le bon rôle, une requête sans filtre retourne tout : la sécurité repose entièrement sur le code applicatif.
3. **Injection SQL** — si `family_id` vient d'un paramètre externe et est concaténé dans la requête, un attaquant peut réécrire la requête et contourner tout filtrage.

Ce module installe les trois protections couche par couche sur le schéma TribuZen réel.

## 2. Théorie complète, concise

### Rôles et privilèges

PostgreSQL ne distingue pas "utilisateur" et "groupe" : tout est un **rôle**. L'attribut `LOGIN` permet la connexion (= utilisateur) ; sans `LOGIN`, le rôle sert de groupe réutilisable.

```sql
-- Groupes fonctionnels (sans LOGIN)
CREATE ROLE tribuzen_readonly;    -- rapports, analytics
CREATE ROLE tribuzen_app;         -- API applicative (CRUD)
CREATE ROLE tribuzen_migrator;    -- migrations de schéma

-- Utilisateur applicatif — hérite des droits de son groupe
CREATE ROLE tribuzen_api WITH LOGIN PASSWORD 'mot_de_passe_fort';
GRANT tribuzen_app TO tribuzen_api;
```

**Principe du moindre privilège** : chaque rôle reçoit exactement ce dont il a besoin, pas plus.

```sql
-- Lecture seule
GRANT SELECT ON ALL TABLES IN SCHEMA public TO tribuzen_readonly;

-- API applicative : CRUD, jamais DDL ni TRUNCATE
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tribuzen_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tribuzen_app;

-- Migrations : tous droits, exécuté hors production ou via CI dédié
GRANT ALL PRIVILEGES ON ALL TABLES   IN SCHEMA public TO tribuzen_migrator;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO tribuzen_migrator;
```

**ALTER DEFAULT PRIVILEGES** — couvre les tables créées *après* le GRANT :

```sql
-- GRANT ... ON ALL TABLES s'applique uniquement aux tables existantes.
-- Pour les tables créées lors des futures migrations :
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tribuzen_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tribuzen_app;
```

**REVOKE** — retirer un privilège déjà accordé :

```sql
-- Retirer DELETE sur une table sensible
REVOKE DELETE ON posts FROM tribuzen_app;

-- Retirer tous les droits à un rôle compromis
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM role_compromis;

-- Retirer le droit de connexion immédiatement
REVOKE CONNECT ON DATABASE tribuzen FROM role_compromis;
```

Vérifier les droits existants :

```sql
-- Dans psql, affichage formaté des ACL d'une table
\dp posts

-- Via information_schema (scriptable)
SELECT grantee, privilege_type, is_grantable
FROM information_schema.role_table_grants
WHERE table_name = 'posts'
ORDER BY grantee, privilege_type;
```

### pg_hba.conf et authentification

`pg_hba.conf` (Host-Based Authentication) contrôle **qui** peut se connecter, **depuis quelle adresse**, et **par quelle méthode**.

```
# TYPE    DATABASE     USER           ADDRESS          METHOD
local     all          postgres                        peer
host      tribuzen     tribuzen_api   127.0.0.1/32     scram-sha-256
hostssl   tribuzen     tribuzen_api   10.0.0.0/24      scram-sha-256
host      all          all            0.0.0.0/0        reject
```

Méthodes d'authentification :

| Méthode | Sécurité | Usage |
|---|---|---|
| `scram-sha-256` | Forte — standard actuel | Production |
| `peer` | Forte — vérifie l'utilisateur OS | Connexions locales Unix uniquement |
| `md5` | Faible — obsolète | À migrer vers scram-sha-256 |
| `trust` | Aucune | Dev local uniquement — interdit en prod |
| `reject` | — | Blocage explicite d'une source |

Les lignes sont évaluées **de haut en bas** : la première qui correspond s'applique. Un `reject` trop haut bloque tout.

Recharger sans redémarrage après modification :

```sql
SELECT pg_reload_conf();
-- Ou depuis le shell OS : pg_ctl reload
```

### SSL — chiffrement du transit

`hostssl` dans `pg_hba.conf` impose SSL pour les connexions réseau concernées. Sans SSL, les identifiants et données transitent en clair.

```
# Forcer SSL pour les connexions réseau (10.x.x.x)
hostssl   tribuzen   tribuzen_api   10.0.0.0/24   scram-sha-256
# Autoriser sans SSL uniquement depuis localhost
host      tribuzen   tribuzen_api   127.0.0.1/32  scram-sha-256
```

Vérifier côté serveur :

```sql
SHOW ssl;            -- on / off
SHOW ssl_cert_file;  -- chemin du certificat serveur
```

### Row-Level Security (RLS)

RLS filtre les lignes **au niveau du moteur de base de données**, indépendamment du code applicatif. Même une requête sans clause `WHERE` ne retourne que les lignes autorisées.

**Activation :**

```sql
-- Activer RLS sur la table
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
-- Après activation : aucune ligne visible pour les non-propriétaires, sans policy explicite.
-- Deny-by-default intégré.

-- FORCE : soumet également le propriétaire de la table aux policies
-- Indispensable en production (le rôle "migration" est souvent propriétaire)
ALTER TABLE posts FORCE ROW LEVEL SECURITY;
```

**Créer les policies (isolation par famille) :**

```sql
-- SELECT : ne voir que ses propres posts
CREATE POLICY posts_family_select ON posts
  FOR SELECT
  USING (family_id = current_setting('app.family_id', true)::int);

-- INSERT : ne pouvoir insérer que dans son propre espace
CREATE POLICY posts_family_insert ON posts
  FOR INSERT
  WITH CHECK (family_id = current_setting('app.family_id', true)::int);

-- UPDATE : USING filtre les lignes modifiables ; WITH CHECK valide la ligne après modification
CREATE POLICY posts_family_update ON posts
  FOR UPDATE
  USING  (family_id = current_setting('app.family_id', true)::int)
  WITH CHECK (family_id = current_setting('app.family_id', true)::int);

-- DELETE : USING filtre les lignes supprimables
CREATE POLICY posts_family_delete ON posts
  FOR DELETE
  USING (family_id = current_setting('app.family_id', true)::int);
```

**USING vs WITH CHECK :**

| Clause | Opérations | Rôle |
|---|---|---|
| `USING` | SELECT, UPDATE (source), DELETE | Filtre les lignes **existantes** visibles/modifiables |
| `WITH CHECK` | INSERT, UPDATE (résultat) | Valide la **nouvelle** ligne avant persistance |

Pour un UPDATE, les deux clauses s'appliquent : `USING` détermine quelle ligne peut être sélectionnée pour la modification, `WITH CHECK` vérifie que la ligne résultante est aussi autorisée — ce qui empêche un utilisateur de changer le `family_id` d'un post pour le "déplacer" vers une autre famille.

**`current_setting('app.family_id', true)`** — le deuxième argument `true` = *missing_ok* : si la variable n'est pas définie dans la session, retourne `NULL` au lieu de lever une erreur. `NULL::int` rend `family_id = NULL` toujours faux pour toutes les lignes → **deny-by-default** automatique si l'application oublie de positionner le contexte. Ne jamais utiliser la forme à un seul argument dans une policy RLS.

**Positionner le contexte depuis l'application :**

```sql
-- set_config(name, value, is_local)
-- is_local = true : LOCAL à la transaction — réinitialisé au COMMIT/ROLLBACK
-- Sûr avec un pool de connexions : la connexion retournée au pool est propre
BEGIN;
SELECT set_config('app.family_id', '42', true);
SELECT * FROM posts;  -- ne retourne que les posts de la famille 42
INSERT INTO posts (family_id, author_id, content)
  VALUES (42, 7, 'Nouveau post') ;  -- OK (family_id = 42 = contexte)
COMMIT;

-- À ne PAS faire : SET au niveau session (persiste après COMMIT, fuite dans le pool)
-- SET app.family_id = '42';  -- dangereux avec pooling
```

**Policies multiples et modes :**

```sql
-- PERMISSIVE (défaut) : les policies d'un même rôle/opération sont OR-ées
-- RESTRICTIVE : AND-ées avec les policies permissives

-- Accès admin total via rôle dédié (pas SUPERUSER)
CREATE POLICY posts_admin_all ON posts
  FOR ALL
  TO tribuzen_migrator
  USING (true)
  WITH CHECK (true);

-- Rôles qui contournent RLS par défaut :
-- - SUPERUSER (toujours)
-- - Propriétaire de la table (sauf FORCE ROW LEVEL SECURITY)
-- - Tout rôle avec l'attribut BYPASSRLS
```

### Prévention des injections SQL

Une injection SQL se produit quand une valeur externe est **concaténée** dans la chaîne SQL plutôt que passée comme paramètre séparé.

```sql
-- DANGEREUX : valeur external concaténée dans le SQL
-- Un attaquant envoie : family_id = "0 OR 1=1 --"
-- Requête générée : SELECT * FROM posts WHERE family_id = 0 OR 1=1 --
-- → retourne tous les posts (1=1 est toujours vrai)

-- SÛR : requête paramétrée — $1 est TOUJOURS traité comme donnée, jamais comme SQL
SELECT id, content, created_at
FROM posts
WHERE family_id = $1;
-- Le moteur compile le plan sans la valeur, puis substitue $1 lors de l'exécution
-- Injection impossible : $1 ne peut pas modifier la structure de la requête
```

En Node.js avec le driver `pg` :

```typescript
// DANGEREUX : interpolation de chaîne
const rows = await client.query(
  `SELECT * FROM posts WHERE family_id = ${req.params.id}`
);

// SÛR : tableau de paramètres — toujours
const { rows } = await client.query(
  'SELECT id, content, created_at FROM posts WHERE family_id = $1',
  [req.params.id]  // pg cast et échappe automatiquement
);
```

Règle absolue : **aucune interpolation** de valeur externe dans une chaîne SQL. Les noms de tables et colonnes ne peuvent pas être paramétrés (utiliser une allowlist explicite si nécessaire).

### Sauvegarde pg_dump et restauration

`pg_dump` produit un backup logique : cohérent à l'instant t, indépendant de la version de PostgreSQL cible (dans les limites de compatibilité).

```bash
# Format custom (recommandé) : compressé, restauration sélective, rapide
pg_dump -U postgres -d tribuzen -Fc -f tribuzen_$(date +%Y%m%d).dump

# Format directory : parallèle (-j 4 = 4 workers simultanés)
pg_dump -U postgres -d tribuzen -Fd -j 4 -f tribuzen_backup_dir/

# Schéma seul (structure sans données — pour audit ou migration)
pg_dump -U postgres -d tribuzen --schema-only -f tribuzen_schema.sql

# Restaurer un dump custom sur une base existante vide
pg_restore -U postgres -d tribuzen tribuzen_20260701.dump

# Restaurer une seule table
pg_restore -U postgres -d tribuzen -t posts tribuzen_20260701.dump

# Restaurer en parallèle (format directory uniquement)
pg_restore -U postgres -d tribuzen -j 4 tribuzen_backup_dir/
```

Formats comparés :

| Format | Option | Compressé | Parallèle | Sélectif |
|---|---|---|---|---|
| Plain SQL | `-Fp` | Non | Non | Non |
| Custom | `-Fc` | Oui | Non | Oui |
| Directory | `-Fd` | Oui | Oui | Oui |

Règle critique : **tester la restauration** régulièrement. Un backup non testé n'est pas un backup — il peut être corrompu, incomplet, ou incompatible avec la version cible.

## 3. Worked examples

### Exemple A — RLS par famille sur posts TribuZen

Setup complet : schéma, données, rôle, RLS, tests.

```sql
-- Nettoyer si déjà joué
DROP TABLE IF EXISTS posts, families CASCADE;
DROP ROLE IF EXISTS tribuzen_api;

-- Schéma TribuZen minimal
CREATE TABLE families (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE posts (
  id         SERIAL PRIMARY KEY,
  family_id  INT NOT NULL REFERENCES families(id),
  author_id  INT NOT NULL,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Données : 2 familles, 3 posts chacune
INSERT INTO families (name) VALUES ('Famille Dupont'), ('Famille Martin');

INSERT INTO posts (family_id, author_id, content) VALUES
  (1, 1, 'Vacances Dupont — côte bretonne'),
  (1, 2, 'Réunion Dupont — dimanche'),
  (1, 1, 'Photo Dupont — plage'),
  (2, 3, 'Vacances Martin — montagne'),
  (2, 4, 'Anniversaire Martin — mercredi'),
  (2, 3, 'Photo Martin — neige');

-- Rôle applicatif avec droits minimaux
CREATE ROLE tribuzen_api WITH LOGIN PASSWORD 'mdp_fort_1234';
GRANT SELECT, INSERT, UPDATE, DELETE ON posts    TO tribuzen_api;
GRANT SELECT                          ON families TO tribuzen_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tribuzen_api;
```

Activation de RLS et création des policies :

```sql
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE posts FORCE ROW LEVEL SECURITY;  -- protège aussi le propriétaire

CREATE POLICY posts_family_select ON posts
  FOR SELECT
  USING (family_id = current_setting('app.family_id', true)::int);

CREATE POLICY posts_family_insert ON posts
  FOR INSERT
  WITH CHECK (family_id = current_setting('app.family_id', true)::int);

CREATE POLICY posts_family_update ON posts
  FOR UPDATE
  USING  (family_id = current_setting('app.family_id', true)::int)
  WITH CHECK (family_id = current_setting('app.family_id', true)::int);

CREATE POLICY posts_family_delete ON posts
  FOR DELETE
  USING (family_id = current_setting('app.family_id', true)::int);
```

Tests d'isolation (se connecter en tant que tribuzen_api, ou `SET ROLE`) :

```sql
SET ROLE tribuzen_api;

-- 1. Sans contexte : deny-by-default (missing_ok → NULL → aucune ligne)
SELECT COUNT(*) FROM posts;
-- → 0  (pas d'erreur, juste aucun résultat)

-- 2. Famille 1 : voit uniquement ses 3 posts
SELECT set_config('app.family_id', '1', true);
SELECT id, family_id, content FROM posts ORDER BY id;
-- → 3 lignes (Dupont uniquement)

-- 3. Famille 2 : voit uniquement ses 3 posts
SELECT set_config('app.family_id', '2', true);
SELECT id, family_id, content FROM posts ORDER BY id;
-- → 3 lignes (Martin uniquement)

-- 4. INSERT cross-famille : bloqué par WITH CHECK
SELECT set_config('app.family_id', '1', true);
INSERT INTO posts (family_id, author_id, content)
  VALUES (2, 1, 'Post frauduleux dans Martin');
-- ERROR: new row violates row-level security policy for table "posts"

-- 5. UPDATE pour changer le family_id d'un post : bloqué par WITH CHECK
SELECT set_config('app.family_id', '1', true);
UPDATE posts SET family_id = 2 WHERE id = 1;
-- ERROR: new row violates row-level security policy for table "posts"

-- 6. UPDATE sur un post d'une autre famille : invisible → 0 lignes affectées
SELECT set_config('app.family_id', '1', true);
UPDATE posts SET content = 'Modifié' WHERE family_id = 2;
-- UPDATE 0  (silencieux — les lignes sont invisibles, pas d'erreur)

-- 7. DROP TABLE : interdit (rôle sans DDL)
DROP TABLE posts;
-- ERROR: must be owner of table posts

RESET ROLE;
```

Pas-à-pas : (1) sans contexte, `current_setting('app.family_id', true)` retourne `NULL`, `family_id = NULL` est faux → aucune ligne ; (2) `set_config(..., true)` avec `is_local=true` limite le paramètre à la transaction courante — indispensable avec un pool pour éviter les "fuites" entre requêtes de clients différents ; (3) le INSERT avec `family_id = 2` dans un contexte `app.family_id = '1'` est rejeté par la policy `WITH CHECK` — protection contre la falsification du `family_id` côté client ; (4) l'UPDATE de `family_id` pour déplacer un post vers une autre famille est rejeté par la policy UPDATE qui vérifie la **valeur après modification** via `WITH CHECK` ; (5) `FORCE ROW LEVEL SECURITY` empêche l'utilisateur propriétaire de la table (ex. rôle de migration) de voir tous les posts — sans FORCE, le propriétaire contourne toujours RLS.

### Exemple B — Requête paramétrée vs injection SQL

Illustration du vecteur d'injection et sa prévention en SQL pur et en Node.js.

```sql
-- Simuler une recherche de posts par famille_id entré par l'utilisateur
-- (en production ce serait dans une fonction ou du code applicatif)

-- DANGEREUX : si family_id_param = '0 OR 1=1 --'
-- La requête construite devient :
-- SELECT * FROM posts WHERE family_id = 0 OR 1=1 --
-- L'opérateur -- commente le reste → toutes les lignes retournées

-- SÛR : requête paramétrée en psql (syntaxe \set + requête avec $1)
-- En pratique, on utilise le driver qui gère les paramètres
\set fam_id 1
SELECT id, content FROM posts WHERE family_id = :fam_id;
-- $1 est toujours traité comme scalaire entier, jamais comme SQL
```

Avec le driver `pg` en Node.js (contexte RLS + requête paramétrée combinés) :

```typescript
import { Pool } from 'pg';

const pool = new Pool({
  user: 'tribuzen_api',
  password: process.env.DB_APP_PASSWORD,
  database: 'tribuzen',
  host: process.env.DB_HOST,
  ssl: { rejectUnauthorized: true },  // SSL obligatoire — refuse les certificats non approuvés
  max: 20,
});

/**
 * Récupère les posts d'une famille.
 * Double protection : RLS (moteur) + requête paramétrée (parsing).
 */
export async function getFamilyPosts(familyId: number): Promise<Post[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config paramétré lui aussi ($1) — jamais de concaténation
    await client.query(
      "SELECT set_config('app.family_id', $1::text, true)",
      [familyId]
    );
    // La requête paramétrée prévient l'injection ;
    // RLS filtre par family_id même si on oublie le WHERE.
    const { rows } = await client.query<Post>(
      'SELECT id, content, created_at FROM posts ORDER BY created_at DESC LIMIT 20',
    );
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();   // la connexion repasse au pool, set_config LOCAL réinitialisé
  }
}
```

Pas-à-pas : (1) `set_config('app.family_id', $1::text, true)` est lui-même paramétré — le `familyId` n'est jamais concaténé dans le SQL ; (2) `is_local=true` garantit que le paramètre de session est effacé au `COMMIT`/`ROLLBACK` — la connexion retournée au pool est propre pour le prochain utilisateur ; (3) la requête `SELECT ... FROM posts` sans `WHERE family_id` semble dangereuse mais RLS l'intercepte au moteur — **défense en profondeur** : le code applicatif peut oublier le filtre, le moteur l'impose quand même ; (4) `ssl: { rejectUnauthorized: true }` refuse les certificats non approuvés — activer SSL sans ce flag est vulnérable aux attaques man-in-the-middle.

## 4. Pièges & misconceptions

- **`GRANT ... ON ALL TABLES` ne couvre pas les tables futures.** Le GRANT s'applique aux tables existantes au moment de son exécution. *Correct :* `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ... TO role` pour que les tables créées lors des prochaines migrations reçoivent automatiquement les bons droits.

- **`ENABLE ROW LEVEL SECURITY` sans `FORCE` laisse passer le propriétaire.** Le propriétaire de la table contourne RLS par défaut — ce qui inclut souvent le rôle de migration. *Correct :* ajouter systématiquement `ALTER TABLE t FORCE ROW LEVEL SECURITY` sur toute table multi-tenant.

- **Policy UPDATE sans `WITH CHECK` explicite laisse modifier le `family_id`.** Si seul `USING` est spécifié sur une policy ALL/UPDATE, la clause `WITH CHECK` prend implicitement la valeur de `USING` — mais ce comportement implicite est source d'erreurs. *Correct :* toujours déclarer `WITH CHECK` explicitement sur les policies UPDATE portant sur une colonne de partition.

- **`current_setting('app.family_id')` sans deuxième argument lève une erreur si la variable n'est pas définie.** *Correct :* `current_setting('app.family_id', true)` (missing_ok = true). Si la variable est absente, retourne `NULL` → deny-by-default. La forme à un seul argument est dangereuse dans une policy RLS : une session sans contexte lèverait une erreur au lieu de simplement ne rien retourner.

- **`SET app.family_id = '42'` (au niveau session) fuite dans un pool de connexions.** Une connexion retournée au pool après un `SET` session-level garde le paramètre pour le prochain utilisateur. *Correct :* utiliser `set_config('app.family_id', $1, true)` dans une transaction (`is_local = true` = réinitialisé au COMMIT/ROLLBACK).

- **Croire que RLS remplace les requêtes paramétrées.** RLS protège contre les fuites de lignes (isolation données), pas contre l'injection SQL (exécution de code malveillant). *Correct :* les deux couches sont complémentaires et nécessaires.

- **Tester un backup sans tester la restauration.** Un dump corrompu ou incompatible ne se révèle qu'au moment où on en a besoin. *Correct :* exécuter `pg_restore` sur une base de test à chaque changement de schéma majeur et valider que les données sont cohérentes.

## 5. Ancrage TribuZen

Couche fil-rouge : **isolation des données par famille avec RLS** dans `smaurier/tribuzen`.

- La table `posts` est la table la plus sensible de TribuZen : messages privés de famille, photos, souvenirs. Sans RLS, un bug de filtrage dans l'API — oubli d'un `WHERE family_id = $familyId` — exposerait les posts de toutes les familles à n'importe quel utilisateur connecté, silencieusement.
- `ALTER TABLE posts FORCE ROW LEVEL SECURITY` + quatre policies (SELECT/INSERT/UPDATE/DELETE) constituent le filet de sécurité **moteur** : même si l'application est buggée ou compromise, le moteur refuse les accès cross-famille.
- `set_config('app.family_id', familyId, true)` dans une transaction (`is_local = true`) : le contexte RLS ne fuit pas entre les requêtes d'un pool de 20 connexions partagées par des centaines de familles concurrentes.
- La policy UPDATE avec `USING` ET `WITH CHECK` empêche un post d'être "déplacé" d'une famille à une autre via une modification du `family_id` — vecteur d'attaque non évident mais réel.
- Le rôle `tribuzen_api` (SELECT/INSERT/UPDATE/DELETE — pas de DDL, pas de TRUNCATE, pas de SUPERUSER) applique le moindre privilège : une compromission du code applicatif ne peut pas supprimer des tables, créer des rôles ou lire le schéma de sécurité.
- Les requêtes paramétrées sur les endpoints d'API (feed, création de post, recherche) éliminent le vecteur d'injection SQL — couche distincte de RLS qui opère au niveau du parsing de la requête.

## 6. Points clés

1. PostgreSQL unifie utilisateurs et groupes en **rôles** ; `LOGIN` = peut se connecter, son absence = groupe ; un utilisateur hérite des droits du groupe via `GRANT groupe TO utilisateur`.
2. Moindre privilège : SELECT/INSERT/UPDATE/DELETE pour l'API, SELECT pour les rapports, DDL uniquement pour les migrations — **jamais SUPERUSER** pour le compte applicatif.
3. `ALTER DEFAULT PRIVILEGES` est indispensable en complément de `GRANT ... ON ALL TABLES` : couvre les tables créées lors des prochaines migrations.
4. `pg_hba.conf` : méthode recommandée = `scram-sha-256` ; `trust` interdit en production ; `hostssl` impose SSL côté client pour les connexions réseau.
5. `ALTER TABLE t ENABLE ROW LEVEL SECURITY` : deny-by-default dès l'activation (aucune ligne visible sans policy). Ajouter `FORCE` pour inclure le propriétaire.
6. `USING` filtre les lignes **existantes** (SELECT, source d'UPDATE, DELETE) ; `WITH CHECK` valide la **nouvelle** ligne (INSERT, résultat d'UPDATE) — toujours déclarer les deux explicitement sur les policies UPDATE.
7. `current_setting('app.family_id', true)` avec `true` = *missing_ok* : si la variable n'est pas définie, retourne `NULL` → deny-by-default automatique.
8. Requêtes paramétrées (`$1`, `$2`) : le plan SQL et la donnée sont compilés séparément — injection impossible. `set_config` lui-même doit utiliser des paramètres.
9. `pg_dump -Fc` (format custom) : compressé, restauration sélective via `pg_restore -t table` ; **tester la restauration** sur une base de test à chaque changement majeur.

## 7. Seeds Anki

```
Différence USING vs WITH CHECK dans une policy RLS PostgreSQL ?|USING filtre les lignes existantes (SELECT visible, UPDATE source, DELETE). WITH CHECK valide la nouvelle ligne avant persistance (INSERT, UPDATE résultat). Pour UPDATE : USING détermine quelles lignes sont modifiables ; WITH CHECK vérifie la ligne après modification.
Pourquoi current_setting('app.family_id', true) et pas current_setting('app.family_id') dans une policy RLS ?|Le deuxième argument true = missing_ok : si la variable n'est pas définie en session, retourne NULL au lieu de lever une erreur. NULL rend toute comparaison fausse → deny-by-default automatique si l'app oublie de positionner le contexte.
GRANT ... ON ALL TABLES IN SCHEMA public couvre-t-il les tables créées après ?|Non. GRANT s'applique uniquement aux tables existantes au moment de l'exécution. Utiliser ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ... TO role pour couvrir les futures tables.
Que fait ALTER TABLE t FORCE ROW LEVEL SECURITY ?|Soumet le propriétaire de la table aux policies RLS comme n'importe quel autre rôle. Sans FORCE, le propriétaire de la table contourne RLS même si ENABLE ROW LEVEL SECURITY est actif.
Comment éviter qu'un family_id de session fuite entre requêtes dans un pool de connexions PostgreSQL ?|Utiliser set_config('app.family_id', $1, true) (is_local=true) dans une transaction. La valeur est réinitialisée au COMMIT/ROLLBACK — la connexion retournée au pool est propre.
Pourquoi une requête paramétrée ($1, $2) empêche-t-elle les injections SQL ?|Le moteur compile le plan d'exécution SQL séparément des valeurs. Les paramètres sont toujours traités comme données, jamais comme SQL — impossible d'injecter une commande via $1.
Quand faut-il WITH CHECK sur une policy UPDATE en plus de USING ?|Toujours sur une colonne de partition (ex. family_id). USING contrôle quelles lignes sont sélectionnables pour update ; WITHOUT CHECK la valeur de la colonne peut être modifiée pour pointer vers une autre famille. WITH CHECK bloque ce changement.
Différence entre les formats pg_dump -Fc et -Fd ?|-Fc (custom) : un fichier compressé, restauration sélective mais pas parallèle. -Fd (directory) : dossier de fichiers compressés, restauration parallèle avec -j N. Les deux permettent pg_restore -t table pour restaurer une seule table.
Méthode d'authentification pg_hba.conf recommandée en production ?|scram-sha-256 : authentification par défi côté serveur, résistante aux attaques par rejeu. md5 est obsolète. trust est interdit en production.
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-14-securite-rls/`. Tu actives RLS sur la table `posts` TribuZen, tu crées les quatre policies d'isolation famille, tu vérifies que famille 1 ne voit pas les posts de famille 2, tu testes le blocage d'un INSERT cross-famille et d'un UPDATE sur le `family_id`, et tu vérifies que le rôle applicatif ne peut pas faire `DROP TABLE`. Corrigé SQL complet inline dans le README.
