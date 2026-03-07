# Module 01 — Le modele relationnel

> **Objectif** : Comprendre les fondements du modele relationnel, maitriser les types de donnees PostgreSQL, savoir creer des tables avec les bonnes contraintes et adopter les conventions de nommage professionnelles.
>
> **Difficulte** : ⭐ (debutant)

---

## 1. L'invention du modele relationnel

### 1.1 Edgar F. Codd et la revolution de 1970

En 1970, Edgar Frank Codd, mathematicien chez IBM, publie un article qui va revolutionner l'informatique : *"A Relational Model of Data for Large Shared Data Banks"*. Avant cet article, les bases de donnees utilisaient des modeles **hierarchiques** ou **reseau** — des structures rigides, difficiles a interroger et a maintenir.

> **Analogie** : Avant Codd, les bases de donnees ressemblaient a un organigramme d'entreprise : pour trouver un employe, il fallait descendre la hierarchie depuis le PDG. Si un employe changeait de service, il fallait restructurer tout l'arbre. Codd a propose de ranger les informations dans des tables plates, comme des feuilles de calcul, et de les relier par des cles — une revolution.

L'idee geniale de Codd repose sur la **theorie des ensembles** et l'**algebre relationnelle** :

| Concept mathematique | Equivalent en base de donnees |
|---|---|
| **Relation** | Table |
| **Tuple** | Ligne (enregistrement) |
| **Attribut** | Colonne (champ) |
| **Domaine** | Type de donnees (ensemble des valeurs possibles) |
| **Cle** | Attribut(s) identifiant uniquement chaque tuple |

### 1.2 Pourquoi le modele relationnel a gagne

| Critere | Modele hierarchique | Modele reseau | Modele relationnel |
|---|---|---|---|
| **Structure** | Arbre rigide | Graphe complexe | Tables plates |
| **Navigation** | Parcours d'arbre obligatoire | Pointeurs entre enregistrements | SQL declaratif |
| **Flexibilite** | Faible (restructuration couteuse) | Moyenne | Forte (vues, jointures) |
| **Independance donnees/programme** | Non | Non | **Oui** (SQL abstrait le stockage) |
| **Facilite d'apprentissage** | Difficile | Tres difficile | Accessible |

> **Ce qu'il faut retenir** : Le genie du modele relationnel, c'est la **separation entre la structure logique (tables) et le stockage physique (fichiers)**. Tu ecris du SQL sans te soucier de comment les donnees sont stockees sur disque. C'est le SGBDR qui s'en occupe.

---

## 2. Tables, lignes, colonnes — la terminologie

### 2.1 Anatomie d'une table

```
                    Table "utilisateurs"
 ┌─────┬──────────────┬─────────────────────┬────────┐
 │ id  │     nom      │       email         │  age   │  ← Colonnes (Attributs)
 ├─────┼──────────────┼─────────────────────┼────────┤
 │  1  │ Alice Dupont │ alice@example.com   │   28   │  ← Ligne 1 (Tuple)
 │  2  │ Bob Martin   │ bob@example.com     │   35   │  ← Ligne 2 (Tuple)
 │  3  │ Claire Petit │ claire@example.com  │   42   │  ← Ligne 3 (Tuple)
 └─────┴──────────────┴─────────────────────┴────────┘
         ▲
         │
    Cle primaire (PK) : identifiant unique de chaque ligne
```

### 2.2 Vocabulaire formel vs informel

| Formel (theorie) | Informel (pratique) | PostgreSQL |
|---|---|---|
| Relation | Table | `CREATE TABLE` |
| Tuple | Ligne, enregistrement, row | Une rangee de donnees |
| Attribut | Colonne, champ, field | `nom TEXT NOT NULL` |
| Domaine | Type | `INTEGER`, `TEXT`, etc. |
| Schema de relation | Structure de table | `\d nom_table` |
| Cle candidate | Identifiant unique potentiel | `UNIQUE` |
| Cle primaire | Identifiant officiel | `PRIMARY KEY` |
| Cardinalite | Nombre de lignes | `SELECT COUNT(*)` |
| Degre | Nombre de colonnes | Nombre d'attributs |

> **Piege classique** : En theorie relationnelle, une "relation" n'est PAS une relation entre tables (c'est une table elle-meme). La relation entre tables s'appelle une **association** et se materialise par une cle etrangere. Ne confonds pas les deux termes.

---

## 3. Types de donnees PostgreSQL

PostgreSQL offre un systeme de types extremement riche. Voici les types les plus importants :

### 3.1 Types texte

| Type | Description | Taille max | Cas d'usage |
|---|---|---|---|
| `TEXT` | Texte de longueur illimitee | ~1 Go | **Recommande par defaut** pour tout texte |
| `VARCHAR(n)` | Texte limite a n caracteres | n caracteres | Quand une limite stricte est necessaire |
| `CHAR(n)` | Texte de longueur fixe (padde avec des espaces) | n caracteres | **Rarement utilise** — codes fixes (ISO) |
| `NAME` | Type interne PostgreSQL (63 octets) | 63 octets | Noms d'objets internes uniquement |

> **Ce qu'il faut retenir** : En PostgreSQL, `TEXT` et `VARCHAR` ont **exactement les memes performances**. Il n'y a AUCUN avantage de performance a utiliser `VARCHAR(255)` par rapport a `TEXT`. Utilise `TEXT` par defaut, et `VARCHAR(n)` uniquement si tu as une contrainte metier reelle sur la longueur.

```sql
-- Toutes ces declarations sont equivalentes en performance
CREATE TABLE exemple_texte (
    col1 TEXT,              -- recommande
    col2 VARCHAR(255),      -- inutilement restrictif en general
    col3 VARCHAR,           -- equivalent a TEXT
    col4 CHAR(10)           -- eviter sauf cas specifique
);
```

### 3.2 Types numeriques

| Type | Taille | Plage | Cas d'usage |
|---|---|---|---|
| `SMALLINT` | 2 octets | -32 768 a 32 767 | Petits entiers (age, quantite limitee) |
| `INTEGER` | 4 octets | -2 147 483 648 a 2 147 483 647 | **Entier par defaut** |
| `BIGINT` | 8 octets | -9.2 × 10^18 a 9.2 × 10^18 | Compteurs, IDs a grande echelle |
| `NUMERIC(p, s)` | Variable | Precision arbitraire | **Montants financiers** (exact) |
| `REAL` | 4 octets | ~6 chiffres significatifs | Calculs scientifiques approximatifs |
| `DOUBLE PRECISION` | 8 octets | ~15 chiffres significatifs | Calculs scientifiques |

> **Piege classique** : N'utilise JAMAIS `REAL` ou `DOUBLE PRECISION` pour des montants financiers. Ces types utilisent la virgule flottante IEEE 754 et introduisent des erreurs d'arrondi. `0.1 + 0.2 ≠ 0.3` en virgule flottante ! Utilise `NUMERIC` ou `INTEGER` (stocker les centimes).

```sql
-- MAUVAIS : virgule flottante pour de l'argent
SELECT 0.1::REAL + 0.2::REAL;
-- Resultat : 0.30000000000000004 (!!!)

-- BON : NUMERIC pour de l'argent
SELECT 0.1::NUMERIC + 0.2::NUMERIC;
-- Resultat : 0.3 (exact)

-- BON : stocker en centimes avec INTEGER
-- 10.50 EUR → 1050 centimes
SELECT 1050 + 2099;  -- 10.50 + 20.99 = 31.49 EUR → 3149 centimes
```

### 3.3 Types auto-incrementes

| Type | Equivalent | Recommandation |
|---|---|---|
| `SERIAL` | `INTEGER` + sequence automatique | Legacy, encore tres utilise |
| `BIGSERIAL` | `BIGINT` + sequence automatique | Legacy, pour grandes tables |
| `GENERATED ALWAYS AS IDENTITY` | Standard SQL, plus strict | **Recommande (SQL standard)** |
| `GENERATED BY DEFAULT AS IDENTITY` | Standard SQL, permet override | Quand on veut pouvoir specifier l'ID |

```sql
-- Ancien style (SERIAL) — fonctionne mais n'est pas standard SQL
CREATE TABLE produits_v1 (
    id SERIAL PRIMARY KEY,
    nom TEXT NOT NULL
);

-- Nouveau style (IDENTITY) — recommande depuis PostgreSQL 10+
CREATE TABLE produits_v2 (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nom TEXT NOT NULL
);

-- La difference : IDENTITY empeche l'insertion manuelle d'un ID
INSERT INTO produits_v2 (id, nom) VALUES (999, 'Test');
-- ERREUR : cannot insert a non-DEFAULT value into column "id"

-- Sauf si on force explicitement (overriding)
INSERT INTO produits_v2 (id, nom) OVERRIDING SYSTEM VALUE VALUES (999, 'Test');
```

### 3.4 Types date et heure

| Type | Taille | Description | Cas d'usage |
|---|---|---|---|
| `DATE` | 4 octets | Date seule (AAAA-MM-JJ) | Dates de naissance, echeances |
| `TIME` | 8 octets | Heure seule (HH:MM:SS.µs) | Horaires (rare) |
| `TIMESTAMP` | 8 octets | Date + heure SANS fuseau | **A eviter** |
| `TIMESTAMPTZ` | 8 octets | Date + heure AVEC fuseau | **Toujours utiliser celui-ci** |
| `INTERVAL` | 16 octets | Duree (jours, heures, etc.) | Calculs de duree |

> **Piege classique** : Utilise TOUJOURS `TIMESTAMPTZ` et jamais `TIMESTAMP`. PostgreSQL stocke `TIMESTAMPTZ` en UTC interne et le convertit automatiquement selon le fuseau de la session. Avec `TIMESTAMP` (sans TZ), tu perds l'information de fuseau et tu auras des bugs quand tes utilisateurs sont dans differents fuseaux horaires.

```sql
-- Demontrer la difference
SET timezone = 'Europe/Paris';

SELECT
    '2024-06-15 14:00:00'::TIMESTAMP AS sans_tz,
    '2024-06-15 14:00:00'::TIMESTAMPTZ AS avec_tz;
-- sans_tz : 2024-06-15 14:00:00
-- avec_tz : 2024-06-15 14:00:00+02

SET timezone = 'America/New_York';
SELECT '2024-06-15 14:00:00+02'::TIMESTAMPTZ;
-- Resultat : 2024-06-15 08:00:00-04 (conversion automatique !)

-- Fonctions utiles
SELECT
    now()                        AS maintenant,
    CURRENT_DATE                 AS date_du_jour,
    CURRENT_TIMESTAMP            AS timestamp_courant,
    now() + INTERVAL '30 days'   AS dans_30_jours,
    now() - INTERVAL '2 hours'   AS il_y_a_2h,
    EXTRACT(YEAR FROM now())     AS annee,
    EXTRACT(DOW FROM now())      AS jour_semaine; -- 0=dimanche
```

### 3.5 Types booleens et autres

| Type | Description | Cas d'usage |
|---|---|---|
| `BOOLEAN` | `true`, `false`, `NULL` | Drapeaux, etats binaires |
| `UUID` | Identifiant universel unique (128 bits) | IDs distribues, APIs publiques |
| `JSONB` | JSON binaire indexable | Donnees semi-structurees |
| `BYTEA` | Donnees binaires (bytes) | Fichiers, images (deconseille) |
| `INET` / `CIDR` | Adresses IP / reseaux | Logs, securite |
| `ARRAY` | Tableau de n'importe quel type | Listes simples |

```sql
-- UUID : generer un identifiant unique
SELECT gen_random_uuid();
-- Resultat : 550e8400-e29b-41d4-a716-446655440000

-- JSONB : stocker et interroger du JSON
CREATE TABLE evenements (
    id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type  TEXT NOT NULL,
    data  JSONB NOT NULL DEFAULT '{}'
);

INSERT INTO evenements (type, data) VALUES
    ('click', '{"page": "/accueil", "bouton": "inscription", "duree_ms": 150}'),
    ('view', '{"page": "/produits", "duree_ms": 3200}');

-- Interroger le JSONB
SELECT type, data->>'page' AS page, (data->>'duree_ms')::INT AS duree
FROM evenements
WHERE data->>'page' = '/accueil';

-- ARRAY : stocker une liste
CREATE TABLE articles (
    id   SERIAL PRIMARY KEY,
    titre TEXT NOT NULL,
    tags  TEXT[] DEFAULT '{}'
);

INSERT INTO articles (titre, tags) VALUES
    ('PostgreSQL pour les nuls', ARRAY['sql', 'postgresql', 'debutant']),
    ('Optimisation avancee', ARRAY['postgresql', 'performance', 'index']);

-- Rechercher dans un array
SELECT titre FROM articles WHERE 'postgresql' = ANY(tags);
```

---

## 4. CREATE TABLE en detail

### 4.1 Syntaxe complete

```sql
CREATE TABLE [IF NOT EXISTS] nom_table (
    nom_colonne  TYPE  [contrainte_colonne ...],
    nom_colonne  TYPE  [contrainte_colonne ...],
    ...
    [contrainte_table, ...]
);
```

### 4.2 Exemple complet et commente

```sql
-- Table representant des employes
CREATE TABLE IF NOT EXISTS employes (
    -- Identifiant auto-incremente (methode moderne)
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Informations personnelles
    prenom          TEXT NOT NULL,
    nom             TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    date_naissance  DATE,

    -- Informations professionnelles
    poste           TEXT NOT NULL DEFAULT 'Non defini',
    salaire         NUMERIC(10, 2) CHECK (salaire > 0),
    departement_id  INTEGER,  -- sera une FK plus tard
    actif           BOOLEAN NOT NULL DEFAULT true,

    -- Metadata
    cree_le         TIMESTAMPTZ NOT NULL DEFAULT now(),
    modifie_le      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Contraintes de table (multi-colonnes)
    CONSTRAINT employe_nom_prenom_unique UNIQUE (nom, prenom, date_naissance)
);

-- Ajouter un commentaire sur la table
COMMENT ON TABLE employes IS 'Table principale des employes de l''entreprise';
COMMENT ON COLUMN employes.salaire IS 'Salaire brut annuel en euros';
```

### 4.3 IF NOT EXISTS

```sql
-- Sans IF NOT EXISTS : erreur si la table existe deja
CREATE TABLE test (id INT);
CREATE TABLE test (id INT);
-- ERREUR : relation "test" already exists

-- Avec IF NOT EXISTS : pas d'erreur, silencieusement ignoree
CREATE TABLE IF NOT EXISTS test (id INT);
-- NOTICE : relation "test" already exists, skipping
```

> **Ce qu'il faut retenir** : Utilise toujours `IF NOT EXISTS` dans tes scripts d'initialisation pour qu'ils soient **idempotents** (executables plusieurs fois sans erreur).

---

## 5. Contraintes en detail

Les contraintes sont le coeur de l'integrite relationnelle. Elles empechent les donnees invalides d'entrer dans ta base.

### 5.1 NOT NULL

```sql
-- La colonne ne peut pas contenir NULL
CREATE TABLE clients (
    id    SERIAL PRIMARY KEY,
    nom   TEXT NOT NULL,        -- obligatoire
    email TEXT NOT NULL,        -- obligatoire
    phone TEXT                  -- optionnel (NULL autorise)
);

INSERT INTO clients (nom, email) VALUES ('Alice', 'alice@test.com');
-- OK

INSERT INTO clients (nom, email) VALUES (NULL, 'test@test.com');
-- ERREUR : null value in column "nom" violates not-null constraint
```

> **Analogie** : `NOT NULL`, c'est comme un formulaire administratif ou certains champs sont marques d'un asterisque rouge (*). Tu ne peux pas soumettre le formulaire sans les remplir.

### 5.2 UNIQUE

```sql
-- Garantit l'unicite des valeurs dans une ou plusieurs colonnes
CREATE TABLE utilisateurs (
    id    SERIAL PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,    -- unicite simple
    pseudo TEXT NOT NULL UNIQUE    -- unicite simple
);

-- Unicite multi-colonnes
CREATE TABLE reservations (
    id      SERIAL PRIMARY KEY,
    salle   TEXT NOT NULL,
    date    DATE NOT NULL,
    heure   TIME NOT NULL,
    UNIQUE (salle, date, heure)   -- meme salle + meme date + meme heure = interdit
);
```

> **Piege classique** : `UNIQUE` autorise plusieurs `NULL` dans PostgreSQL. Deux lignes peuvent avoir `phone = NULL` meme si `phone` est `UNIQUE`. C'est conforme au standard SQL : `NULL ≠ NULL`.

### 5.3 CHECK

```sql
-- Verifie une condition sur les valeurs
CREATE TABLE produits (
    id    SERIAL PRIMARY KEY,
    nom   TEXT NOT NULL,
    prix  NUMERIC(10,2) NOT NULL CHECK (prix >= 0),
    stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),

    -- CHECK multi-colonnes
    prix_promo NUMERIC(10,2),
    CONSTRAINT promo_inferieur_au_prix
        CHECK (prix_promo IS NULL OR prix_promo < prix)
);

INSERT INTO produits (nom, prix, stock) VALUES ('Clavier', -10, 5);
-- ERREUR : new row for relation "produits" violates check constraint "produits_prix_check"
```

### 5.4 DEFAULT

```sql
CREATE TABLE commandes (
    id         SERIAL PRIMARY KEY,
    statut     TEXT NOT NULL DEFAULT 'en_attente',
    priorite   INTEGER NOT NULL DEFAULT 0,
    cree_le    TIMESTAMPTZ NOT NULL DEFAULT now(),
    reference  TEXT NOT NULL DEFAULT 'CMD-' || gen_random_uuid()::TEXT
);

-- INSERT sans specifier les colonnes avec DEFAULT
INSERT INTO commandes DEFAULT VALUES;
-- Toutes les colonnes prennent leur valeur par defaut
```

### 5.5 PRIMARY KEY

La cle primaire est une combinaison de `NOT NULL` + `UNIQUE`. Chaque table doit avoir une et une seule cle primaire.

```sql
-- Cle primaire simple (la plus courante)
CREATE TABLE pays (
    code CHAR(2) PRIMARY KEY,  -- 'FR', 'US', 'DE'
    nom  TEXT NOT NULL
);

-- Cle primaire composite (pour les tables de jonction)
CREATE TABLE cours_etudiants (
    cours_id    INTEGER NOT NULL REFERENCES cours(id),
    etudiant_id INTEGER NOT NULL REFERENCES etudiants(id),
    note        NUMERIC(4, 2),
    PRIMARY KEY (cours_id, etudiant_id)
);
```

> **Analogie** : La cle primaire, c'est le numero de securite sociale. Chaque personne en a un, il est unique, et il ne change jamais. Dans une table, c'est l'adresse definitive de chaque ligne.

### 5.6 Tableau recapitulatif des contraintes

| Contrainte | Niveau | Null autorise ? | Duplicats autorises ? | Cas d'usage |
|---|---|---|---|---|
| `NOT NULL` | Colonne | Non | Oui | Champs obligatoires |
| `UNIQUE` | Colonne ou table | Oui (multiples) | Non | Emails, pseudos |
| `CHECK` | Colonne ou table | Oui | Oui | Validations metier |
| `DEFAULT` | Colonne | — | — | Valeurs par defaut |
| `PRIMARY KEY` | Colonne ou table | Non | Non | Identifiant unique |
| `FOREIGN KEY` | Colonne ou table | Oui | Oui | References entre tables |

---

## 6. Sequences et SERIAL vs IDENTITY

### 6.1 Qu'est-ce qu'une sequence ?

Une sequence est un objet PostgreSQL qui genere des nombres uniques incrementaux.

```sql
-- Creer une sequence manuellement
CREATE SEQUENCE compteur_seq START 1 INCREMENT 1;

-- Utiliser la sequence
SELECT nextval('compteur_seq');  -- 1
SELECT nextval('compteur_seq');  -- 2
SELECT nextval('compteur_seq');  -- 3

-- Voir la valeur courante (sans incrementer)
SELECT currval('compteur_seq');  -- 3

-- Reinitialiser
ALTER SEQUENCE compteur_seq RESTART WITH 1;
```

> **Piege classique** : Les sequences ne sont PAS transactionnelles pour la generation de valeurs. Si une transaction fait `nextval()` puis `ROLLBACK`, la valeur est "perdue" — la sequence ne revient pas en arriere. C'est normal et voulu : cela evite les blocages entre transactions concurrentes. Accepte les trous dans tes IDs.

### 6.2 SERIAL : le raccourci historique

```sql
-- SERIAL est un raccourci qui fait 3 choses :
-- 1. Cree une sequence
-- 2. Definit DEFAULT nextval('sequence')
-- 3. Marque la colonne comme NOT NULL
CREATE TABLE t1 (
    id SERIAL PRIMARY KEY
);

-- Equivalent explicite :
CREATE SEQUENCE t1_id_seq;
CREATE TABLE t1 (
    id INTEGER NOT NULL DEFAULT nextval('t1_id_seq')
);
ALTER SEQUENCE t1_id_seq OWNED BY t1.id;
```

### 6.3 IDENTITY : le standard SQL (recommande)

```sql
-- GENERATED ALWAYS : interdit l'insertion manuelle d'un ID
CREATE TABLE t2 (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nom TEXT NOT NULL
);

-- GENERATED BY DEFAULT : autorise l'insertion manuelle (comme SERIAL)
CREATE TABLE t3 (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    nom TEXT NOT NULL
);
```

| Aspect | `SERIAL` | `GENERATED ALWAYS AS IDENTITY` |
|---|---|---|
| Standard SQL | Non (PostgreSQL specifique) | Oui |
| Insertion manuelle | Autorisee (avec risque de conflit) | Interdite (sauf `OVERRIDING SYSTEM VALUE`) |
| `pg_dump` | La sequence peut se desynchroniser | Mieux gere |
| Recommandation | Legacy, fonctionne bien | **Preferer pour les nouveaux projets** |

---

## 7. Bonnes pratiques de modelisation

### 7.1 Conventions de nommage

| Regle | Bon exemple | Mauvais exemple | Raison |
|---|---|---|---|
| **snake_case** pour tout | `date_naissance` | `dateNaissance`, `DateNaissance` | PostgreSQL convertit en minuscule par defaut |
| **Tables au singulier** | `utilisateur` | `utilisateurs` | Coherence : `SELECT * FROM utilisateur` lit mieux |
| **Tables au pluriel** (alternative) | `utilisateurs` | — | Convention aussi valide, mais sois **coherent** |
| **Cle primaire : `id`** | `id` | `utilisateur_id`, `uid` | Simple, universel |
| **Cle etrangere : `table_id`** | `departement_id` | `dept`, `dep_id`, `fk_dep` | Explicite et lisible |
| **Pas d'abreviations** | `commande`, `produit` | `cmd`, `prod` | Lisibilite pour toute l'equipe |
| **Prefixe pour les booleans** | `est_actif`, `a_paye` | `actif`, `paye` | Clarifie que c'est un boolean |
| **Pas de mots reserves** | `commande` | `order`, `table`, `user` | Evite les conflits SQL |
| **Pas de type dans le nom** | `email` | `email_varchar`, `str_email` | Le type est dans le schema |

> **Piege classique** : Si tu utilises des majuscules dans un nom PostgreSQL, tu devras TOUJOURS le mettre entre guillemets doubles. `CREATE TABLE "MaTable" (...)` oblige a ecrire `SELECT * FROM "MaTable"` partout. Utilise snake_case et tu n'auras jamais ce probleme.

```sql
-- BON : snake_case, tout en minuscule
CREATE TABLE ligne_commande (
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    commande_id     INTEGER NOT NULL,
    produit_id      INTEGER NOT NULL,
    quantite        INTEGER NOT NULL CHECK (quantite > 0),
    prix_unitaire   NUMERIC(10, 2) NOT NULL CHECK (prix_unitaire >= 0)
);

-- MAUVAIS : CamelCase, abreviations, mots reserves
CREATE TABLE "OrderLine" (
    "ID"         SERIAL PRIMARY KEY,
    "OrderID"    INT,
    "ProdID"     INT,
    "Qty"        INT,
    "Price"      DECIMAL
);
```

### 7.2 Les 10 regles d'or

1. **Toujours une cle primaire** — chaque table doit avoir un identifiant unique
2. **Toujours `NOT NULL` sauf si NULL a un sens metier** — un email optionnel est acceptable, un nom NULL ne l'est pas
3. **Utiliser les bons types** — `TIMESTAMPTZ` pas `TEXT` pour les dates, `NUMERIC` pas `REAL` pour l'argent
4. **Contraintes dans la base, pas dans l'application** — ne fais pas confiance au code applicatif pour valider
5. **Noms explicites** — un developpeur qui lit le schema doit comprendre sans documentation
6. **Eviter les colonnes "fourre-tout"** — pas de colonne `data TEXT` qui contient du JSON en serie
7. **Normaliser** — eviter la duplication de donnees (voir modules suivants)
8. **Pas de donnees calculees stockees** (sauf cache) — `total = prix * quantite` se calcule a la volee
9. **Colonnes de metadata** — `cree_le`, `modifie_le` sur les tables importantes
10. **Commentaires sur les colonnes ambigues** — `COMMENT ON COLUMN`

---

## 8. Node.js : creer des tables programmatiquement

### 8.1 Script de migration basique

```javascript
// fichier : migrations/001_create_tables.mjs
// Script de creation des tables pour le module 01

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'cours',
  user: 'postgres',
  password: 'postgres',
});

async function creerTables() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Table des departements
    await client.query(`
      CREATE TABLE IF NOT EXISTS departement (
        id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        nom   TEXT NOT NULL UNIQUE,
        code  VARCHAR(10) NOT NULL UNIQUE,
        etage INTEGER CHECK (etage >= 0 AND etage <= 50)
      )
    `);
    console.log('Table "departement" creee.');

    // Table des employes (avec FK vers departement)
    await client.query(`
      CREATE TABLE IF NOT EXISTS employe (
        id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        prenom          TEXT NOT NULL,
        nom             TEXT NOT NULL,
        email           TEXT NOT NULL UNIQUE,
        date_naissance  DATE,
        poste           TEXT NOT NULL DEFAULT 'Non defini',
        salaire         NUMERIC(10, 2) CHECK (salaire > 0),
        departement_id  INTEGER REFERENCES departement(id) ON DELETE SET NULL,
        est_actif       BOOLEAN NOT NULL DEFAULT true,
        cree_le         TIMESTAMPTZ NOT NULL DEFAULT now(),
        modifie_le      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    console.log('Table "employe" creee.');

    // Table des projets
    await client.query(`
      CREATE TABLE IF NOT EXISTS projet (
        id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        titre       TEXT NOT NULL,
        description TEXT,
        debut       DATE NOT NULL DEFAULT CURRENT_DATE,
        fin         DATE,
        budget      NUMERIC(12, 2) CHECK (budget >= 0),
        CONSTRAINT projet_dates_coherentes CHECK (fin IS NULL OR fin >= debut)
      )
    `);
    console.log('Table "projet" creee.');

    // Table de jonction employe <-> projet (N:M)
    await client.query(`
      CREATE TABLE IF NOT EXISTS employe_projet (
        employe_id  INTEGER NOT NULL REFERENCES employe(id) ON DELETE CASCADE,
        projet_id   INTEGER NOT NULL REFERENCES projet(id) ON DELETE CASCADE,
        role        TEXT NOT NULL DEFAULT 'contributeur',
        depuis      DATE NOT NULL DEFAULT CURRENT_DATE,
        PRIMARY KEY (employe_id, projet_id)
      )
    `);
    console.log('Table "employe_projet" creee.');

    await client.query('COMMIT');
    console.log('Toutes les tables ont ete creees avec succes.');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erreur lors de la creation des tables :', err.message);
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  try {
    await creerTables();
  } finally {
    await pool.end();
  }
}

main();
```

### 8.2 Verifier le schema depuis Node.js

```javascript
// fichier : check-schema.mjs
// Verifier que les tables existent et afficher leur structure

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'cours',
  user: 'postgres',
  password: 'postgres',
});

async function listerTables() {
  const resultat = await pool.query(`
    SELECT table_name,
           (SELECT COUNT(*) FROM information_schema.columns c
            WHERE c.table_name = t.table_name
              AND c.table_schema = 'public') AS nb_colonnes
    FROM information_schema.tables t
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  console.log('Tables dans le schema public :');
  console.log('─'.repeat(40));
  for (const row of resultat.rows) {
    console.log(`  ${row.table_name} (${row.nb_colonnes} colonnes)`);
  }
}

async function decrireTable(nomTable) {
  const resultat = await pool.query(`
    SELECT
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
    ORDER BY ordinal_position
  `, [nomTable]);

  console.log(`\nStructure de "${nomTable}" :`);
  console.log('─'.repeat(60));
  for (const col of resultat.rows) {
    const nullable = col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
    const defaut = col.column_default ? ` DEFAULT ${col.column_default}` : '';
    console.log(`  ${col.column_name.padEnd(20)} ${col.data_type.padEnd(15)} ${nullable}${defaut}`);
  }
}

async function main() {
  try {
    await listerTables();
    await decrireTable('employe');
    await decrireTable('departement');
  } finally {
    await pool.end();
  }
}

main();
```

---

## 9. DROP TABLE, ALTER TABLE — modifications de schema

### 9.1 DROP TABLE

```sql
-- Supprimer une table
DROP TABLE employe_projet;

-- Supprimer seulement si elle existe (pas d'erreur sinon)
DROP TABLE IF EXISTS employe_projet;

-- Supprimer une table et toutes les tables qui en dependent (CASCADE)
DROP TABLE departement CASCADE;
-- Attention : cela supprime aussi les FK dans les tables referentes

-- Supprimer plusieurs tables d'un coup
DROP TABLE IF EXISTS employe_projet, projet, employe, departement CASCADE;
```

> **Piege classique** : `DROP TABLE CASCADE` ne demande PAS de confirmation. Il supprime instantanement la table et toutes les dependances. En production, c'est extremement dangereux. Toujours verifier avec `\d+ nom_table` avant de supprimer.

### 9.2 ALTER TABLE — les modifications les plus courantes

```sql
-- Ajouter une colonne
ALTER TABLE employe ADD COLUMN telephone TEXT;

-- Ajouter une colonne avec contrainte
ALTER TABLE employe ADD COLUMN code_postal VARCHAR(5) CHECK (code_postal ~ '^\d{5}$');

-- Supprimer une colonne
ALTER TABLE employe DROP COLUMN telephone;

-- Renommer une colonne
ALTER TABLE employe RENAME COLUMN nom TO nom_famille;

-- Changer le type d'une colonne
ALTER TABLE employe ALTER COLUMN poste TYPE VARCHAR(100);

-- Ajouter une contrainte NOT NULL
ALTER TABLE employe ALTER COLUMN date_naissance SET NOT NULL;

-- Supprimer une contrainte NOT NULL
ALTER TABLE employe ALTER COLUMN date_naissance DROP NOT NULL;

-- Ajouter une contrainte CHECK
ALTER TABLE employe ADD CONSTRAINT salaire_raisonnable CHECK (salaire < 1000000);

-- Supprimer une contrainte
ALTER TABLE employe DROP CONSTRAINT salaire_raisonnable;

-- Ajouter une valeur par defaut
ALTER TABLE employe ALTER COLUMN poste SET DEFAULT 'Stagiaire';

-- Supprimer une valeur par defaut
ALTER TABLE employe ALTER COLUMN poste DROP DEFAULT;

-- Renommer la table
ALTER TABLE employe RENAME TO collaborateur;
```

> **Ce qu'il faut retenir** : La plupart des `ALTER TABLE` en PostgreSQL sont **tres rapides** car elles ne modifient que le catalogue systeme (metadata), pas les donnees. Exceptions notables : `ALTER COLUMN TYPE` peut necessiter une reecriture complete de la table si le type change de facon incompatible.

### 9.3 Tableau des operations ALTER et leur impact

| Operation | Verrouillage | Reecriture table | Risque production |
|---|---|---|---|
| `ADD COLUMN` (nullable, sans defaut) | Leger | Non | Faible |
| `ADD COLUMN` (avec DEFAULT volatile) | Leger (PG11+) | Non (PG11+) | Faible |
| `DROP COLUMN` | Leger | Non (marque invisible) | Faible |
| `ALTER TYPE` (compatible) | Leger | Non | Faible |
| `ALTER TYPE` (incompatible) | Lourd | **Oui** | **Eleve** |
| `ADD CONSTRAINT CHECK` | Lourd (scan) | Non | Moyen |
| `ADD CONSTRAINT FK` | Lourd (scan) | Non | Moyen |
| `SET NOT NULL` | Lourd (scan) | Non | Moyen |

---

## 10. Exercice mental : modeliser une bibliotheque

Imagine que tu dois modeliser la base de donnees d'une bibliotheque municipale. Reflechis aux questions suivantes avant de regarder la solution :

1. Quelles sont les entites principales ? (livres, auteurs, adherents, emprunts...)
2. Quelles sont les relations entre elles ? (un auteur ecrit plusieurs livres, un adherent emprunte plusieurs livres...)
3. Quelles contraintes metier faut-il appliquer ? (un emprunt a une date de retour prevue, un livre ne peut pas etre emprunte s'il est deja sorti...)

### Solution proposee

```sql
-- Auteurs
CREATE TABLE auteur (
    id      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    prenom  TEXT NOT NULL,
    nom     TEXT NOT NULL,
    pays    TEXT,
    ne_le   DATE,
    bio     TEXT
);

-- Livres (un livre a un seul auteur principal pour simplifier)
CREATE TABLE livre (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    titre       TEXT NOT NULL,
    isbn        VARCHAR(13) UNIQUE,
    auteur_id   INTEGER NOT NULL REFERENCES auteur(id),
    genre       TEXT,
    pages       INTEGER CHECK (pages > 0),
    publie_en   INTEGER CHECK (publie_en > 0 AND publie_en <= 2030)
);

-- Exemplaires (un livre peut avoir plusieurs exemplaires physiques)
CREATE TABLE exemplaire (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    livre_id    INTEGER NOT NULL REFERENCES livre(id) ON DELETE CASCADE,
    code_barre  TEXT NOT NULL UNIQUE,
    etat        TEXT NOT NULL DEFAULT 'bon' CHECK (etat IN ('neuf','bon','use','abime')),
    disponible  BOOLEAN NOT NULL DEFAULT true
);

-- Adherents
CREATE TABLE adherent (
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    prenom          TEXT NOT NULL,
    nom             TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    telephone       TEXT,
    inscrit_le      DATE NOT NULL DEFAULT CURRENT_DATE,
    carte_valide    BOOLEAN NOT NULL DEFAULT true
);

-- Emprunts
CREATE TABLE emprunt (
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    exemplaire_id   INTEGER NOT NULL REFERENCES exemplaire(id),
    adherent_id     INTEGER NOT NULL REFERENCES adherent(id),
    emprunte_le     DATE NOT NULL DEFAULT CURRENT_DATE,
    retour_prevu    DATE NOT NULL,
    retourne_le     DATE,
    CONSTRAINT retour_apres_emprunt
        CHECK (retour_prevu >= emprunte_le),
    CONSTRAINT retour_reel_apres_emprunt
        CHECK (retourne_le IS NULL OR retourne_le >= emprunte_le)
);
```

```
 Relations :
 ┌────────┐     1:N     ┌───────┐     1:N     ┌───────────┐
 │ auteur │────────────▶│ livre │────────────▶│ exemplaire │
 └────────┘             └───────┘             └─────┬─────┘
                                                    │
                                                    │ N:1
                                                    ▼
 ┌──────────┐    N:1    ┌─────────┐
 │ adherent │◀──────────│ emprunt │
 └──────────┘           └─────────┘

 Un auteur ecrit N livres.
 Un livre a N exemplaires physiques.
 Un adherent fait N emprunts.
 Chaque emprunt concerne 1 exemplaire et 1 adherent.
```

---

## 11. Navigation

| | Lien |
|---|---|
| Module precedent | [Module 00 — Prerequis & Vue d'ensemble](./00-prerequis-et-vue-ensemble.md) |
| Module suivant | [Module 02 — CRUD & Requetes SQL](./02-crud-et-requetes.md) |
| Lab associe | [Lab 01 — Creer un schema de base de donnees](../labs/lab-01.md) |

---

> **Ce qu'il faut retenir** : Le modele relationnel repose sur des tables, des types stricts et des contraintes qui garantissent l'integrite des donnees. PostgreSQL offre un systeme de types extremement riche (TEXT, NUMERIC, TIMESTAMPTZ, UUID, JSONB, arrays...). Choisis tes types avec soin, nomme tes colonnes clairement en snake_case, et laisse la base de donnees valider tes donnees via les contraintes — c'est sa raison d'etre.
