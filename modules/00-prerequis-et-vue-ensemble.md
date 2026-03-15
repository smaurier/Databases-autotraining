# Module 00 — Prerequis & Vue d'ensemble

> **Objectif** : Comprendre ce qu'est un SGBDR, pourquoi PostgreSQL est le choix de reference, installer un environnement de travail complet et etablir un premier contact avec la base de donnees via `psql` et Node.js.
>
> **Difficulte** : ⭐ (debutant)

---

## 1. Ce que ce cours va t'apprendre

Ce cours est un parcours complet a travers PostgreSQL, de la premiere requete `SELECT` jusqu'aux mecanismes internes du moteur. Voici les grandes competences que tu vas acquerir :

| Domaine | Ce que tu sauras faire |
|---|---|
| **SQL fondamental** | Ecrire des requetes CRUD, des jointures, des sous-requetes, des agregations |
| **Modelisation** | Concevoir un schema relationnel normalise avec les bonnes contraintes |
| **Transactions** | Gerer la concurrence, comprendre ACID, eviter les anomalies |
| **Performance** | Lire un plan d'execution, creer les bons index, optimiser des requetes lentes |
| **Index avances** | Utiliser GIN, GiST, BRIN selon le cas d'usage |
| **PostgreSQL internals** | Comprendre le WAL, le VACUUM, le query planner, les mecanismes MVCC |
| **Node.js + pg** | Integrer PostgreSQL dans une application backend JavaScript moderne |
| **Administration** | Gerer les roles, les permissions, les backups, la surveillance |

> **Analogie** : Imagine que PostgreSQL est une voiture de course. Ce cours t'apprend d'abord a conduire (SQL), puis a comprendre le moteur (internals), et enfin a regler les performances (tuning). Tu ne seras pas juste un conducteur, tu seras un mecanicien capable de diagnostiquer et optimiser.

### Ce que ce cours n'est PAS

- Ce n'est pas un cours de theorie pure : chaque concept est accompagne de code executable.
- Ce n'est pas un cours Node.js : on suppose que tu connais les bases de JavaScript et les modules ES.
- Ce n'est pas un cours d'administration systeme : on utilise Docker pour simplifier l'installation.

---

## 2. Qu'est-ce qu'un SGBDR

### 2.1 Definition

Un **SGBDR** (Systeme de Gestion de Base de Donnees Relationnelles) est un logiciel qui :

1. **Stocke** des donnees structurees dans des tables (lignes et colonnes)
2. **Garantit** l'integrite des donnees via des contraintes et des transactions
3. **Permet** d'interroger les donnees via un langage standardise : **SQL**
4. **Gere** les acces concurrents de multiples utilisateurs

> **Analogie** : Un SGBDR, c'est comme une bibliotheque tres bien organisee. Chaque livre (ligne) est range dans une etagere precise (table), avec un systeme de classification (index). Le bibliothecaire (le moteur) sait exactement ou trouver chaque livre et gere les emprunts simultanement sans conflit.

### 2.2 Comparaison avec d'autres approches de stockage

| Critere | Fichier texte/CSV | Excel | NoSQL (MongoDB) | SGBDR (PostgreSQL) |
|---|---|---|---|---|
| **Structure** | Libre, aucune | Feuilles, cellules | Documents flexibles (JSON) | Tables, colonnes typees |
| **Integrite** | Aucune | Faible (formules) | Faible (pas de schema impose) | Forte (contraintes, FK, CHECK) |
| **Concurrence** | Aucune | Fichier verrouille | Bonne (document-level) | Excellente (MVCC, transactions) |
| **Requetes** | `grep`, scripts | Filtres, formules | Aggregation pipeline | SQL standardise |
| **Relations** | Manuelles | Manuelles (VLOOKUP) | Denormalisees (embedded) | Jointures natives |
| **Transactions ACID** | Non | Non | Partiel (depuis 4.0) | Oui, complet |
| **Scalabilite** | Limite (~MB) | Limite (~1M lignes) | Horizontale (sharding) | Verticale + extensions |
| **Cas d'usage** | Logs simples, config | Rapports, prototypage | Documents, real-time | Applications metier, finance |

> **Piege classique** : Beaucoup de debutants pensent que NoSQL est "mieux" que SQL parce que c'est "plus moderne". En realite, les bases relationnelles restent le choix dominant pour toute application qui a besoin de coherence des donnees, de transactions fiables et de requetes complexes. PostgreSQL supporte aussi le JSON (JSONB), ce qui offre le meilleur des deux mondes.

### 2.3 Le langage SQL

SQL (Structured Query Language) est un langage **declaratif** : tu dis **ce que tu veux**, pas **comment l'obtenir**.

```sql
-- Tu dis : "donne-moi les utilisateurs actifs de Paris"
SELECT nom, email
FROM utilisateurs
WHERE ville = 'Paris'
  AND actif = true
ORDER BY nom;

-- Tu ne dis PAS : "ouvre le fichier, lis ligne par ligne,
-- verifie si ville = Paris ET actif = true, trie par nom..."
```

> **Analogie** : SQL, c'est comme commander au restaurant. Tu dis "je veux le plat du jour avec une salade". Tu ne dis pas au chef comment couper les legumes, a quelle temperature cuire, etc. Le SGBDR (le chef) decide de la meilleure facon d'executer ta demande.

SQL se divise en plusieurs sous-langages :

| Sous-langage | Acronyme | Exemples | Role |
|---|---|---|---|
| Data Definition Language | **DDL** | `CREATE`, `ALTER`, `DROP` | Definir la structure |
| Data Manipulation Language | **DML** | `SELECT`, `INSERT`, `UPDATE`, `DELETE` | Manipuler les donnees |
| Data Control Language | **DCL** | `GRANT`, `REVOKE` | Gerer les permissions |
| Transaction Control Language | **TCL** | `BEGIN`, `COMMIT`, `ROLLBACK` | Gerer les transactions |

---

## 3. Pourquoi PostgreSQL

### 3.1 Un peu d'histoire

PostgreSQL a une histoire remarquable qui explique sa robustesse :

| Annee | Evenement |
|---|---|
| 1973 | Ingres, ancetre de PostgreSQL, nait a UC Berkeley |
| 1986 | Le projet **POSTGRES** (Post-Ingres) demarre sous Michael Stonebraker |
| 1995 | Ajout du support SQL → renomme **PostgreSQL** |
| 1996 | Premier release open-source, communaute mondiale |
| 2005 | Support natif du JSONB, extensions |
| 2017 | Replication logique, partitionnement declaratif |
| 2023 | PostgreSQL 16 : parallelisme ameliore, performance I/O |
| 2024 | PostgreSQL 17 — JSON_TABLE, incremental backup, MERGE RETURNING |
| 2024 | PostgreSQL est elu "DBMS of the Year" par DB-Engines (4e fois) |

### 3.2 PostgreSQL vs les autres

| Critere | PostgreSQL | MySQL | SQLite | SQL Server |
|---|---|---|---|---|
| **Licence** | PostgreSQL (MIT-like) | GPL / Commercial | Domaine public | Commercial |
| **Conformite SQL** | Tres elevee | Moyenne | Limitee | Elevee |
| **Types de donnees** | Tres riche (JSONB, arrays, ranges, hstore, geometric) | Standard | Standard | Riche |
| **Extensions** | Oui (PostGIS, pg_trgm, pgvector...) | Limitees | Non | Limitees |
| **MVCC** | Natif, complet | Depend du moteur (InnoDB) | WAL-mode | Oui |
| **Full-text search** | Integre (tsvector, tsquery) | Basique | FTS5 (extension) | Integre |
| **Replication** | Streaming + logique | Basique | Non | Oui |
| **Partitionnement** | Declaratif (natif) | Range, List, Hash | Non | Oui |
| **JSON** | JSONB indexable (GIN) | JSON (pas indexable nativement) | JSON1 extension | JSON |
| **Parallelisme** | Requetes paralleles | Limite | Non | Oui |
| **Prix** | Gratuit | Gratuit / payant | Gratuit | ~15 000 $/coeur |
| **Communaute** | Enorme, active | Enorme | Moderee | Corporate |

> **Ce qu'il faut retenir** : PostgreSQL est le SGBDR open-source le plus complet et le plus conforme aux standards SQL. Si tu ne sais pas quoi choisir, choisis PostgreSQL. Tu ne le regretteras pas.

### 3.3 Qui utilise PostgreSQL

PostgreSQL est utilise en production par des geants du web et de la finance :

- **Apple** : iCloud, services backend
- **Instagram** : stockage principal (des milliards de lignes)
- **Spotify** : metadata des chansons et playlists
- **Reddit** : base de donnees principale
- **GitLab** : stockage de tous les repositories et metadata
- **Banques** : Goldman Sachs, JP Morgan pour les systemes transactionnels

---

## 4. Architecture de PostgreSQL

### 4.1 Vue d'ensemble

PostgreSQL utilise un modele **client-serveur** avec une architecture **multi-processus** (pas multi-thread).

```
                     Architecture PostgreSQL
 ┌──────────────────────────────────────────────────────────┐
 │                    Postmaster (PID 1)                     │
 │         Processus principal, accepte les connexions       │
 │                          │                                │
 │     ┌────────────────────┼────────────────────┐           │
 │     │                    │                    │           │
 │  ┌──▼──┐  ┌──────┐  ┌──▼──┐                             │
 │  │Back │  │Back  │  │Back │   Backend processes          │
 │  │end 1│  │end 2 │  │end 3│   (1 par connexion)          │
 │  └──┬──┘  └──┬───┘  └──┬──┘                             │
 │     │        │         │                                  │
 │     ▼        ▼         ▼                                  │
 │  ┌─────────────────────────────────┐                     │
 │  │       Shared Buffers            │  Memoire partagee    │
 │  │  (cache des pages de donnees)   │  (shared_buffers)    │
 │  └──────────────┬──────────────────┘                     │
 │                 │                                         │
 │     ┌───────────┼───────────┐                            │
 │     ▼           ▼           ▼                            │
 │  ┌──────┐  ┌────────┐  ┌──────────┐                     │
 │  │ WAL  │  │ Check  │  │ Autovac  │  Background workers  │
 │  │Writer│  │pointer │  │  uum     │                      │
 │  └──┬───┘  └───┬────┘  └──────────┘                     │
 │     │          │                                          │
 │     ▼          ▼                                          │
 │  ┌──────┐  ┌──────────┐                                  │
 │  │ WAL  │  │ Fichiers │   Stockage disque                │
 │  │files │  │ donnees  │   (PGDATA)                       │
 │  └──────┘  └──────────┘                                  │
 └──────────────────────────────────────────────────────────┘
```

### 4.2 Les composants principaux

| Composant | Role | Analogie |
|---|---|---|
| **Postmaster** | Processus principal qui ecoute les connexions entrantes et fork un backend par client | Le maitre d'hotel qui accueille les clients et assigne un serveur a chacun |
| **Backend process** | Un processus dedie par connexion client, execute les requetes | Le serveur qui s'occupe exclusivement de ta table |
| **Shared Buffers** | Cache memoire partage entre tous les backends, stocke les pages de donnees | Le plan de travail commun en cuisine |
| **WAL Writer** | Ecrit les journaux de transactions (Write-Ahead Log) sur disque | Le scribe qui note chaque operation AVANT qu'elle soit effectuee |
| **Checkpointer** | Ecrit periodiquement les pages modifiees (dirty pages) du cache vers le disque | Le comptable qui fait le bilan periodique |
| **Autovacuum** | Nettoie les lignes mortes (tuples morts) laissees par MVCC | L'equipe de nettoyage qui passe apres les clients |
| **WAL files** | Journaux de transactions sur disque, garantissent la durabilite | Le journal de bord : meme si le bateau coule, on peut reconstituer ce qui s'est passe |
| **Data files** | Les fichiers physiques contenant les tables et les index | Les etageres de la bibliotheque |

### 4.3 Le cycle de vie d'une requete

Quand tu executes `SELECT * FROM utilisateurs WHERE id = 42`, voici ce qui se passe :

```
 Client (psql / Node.js)
        │
        │ 1. Connexion TCP
        ▼
    Postmaster
        │
        │ 2. Fork un backend
        ▼
  Backend process
        │
        │ 3. Parse SQL → arbre syntaxique
        │ 4. Analyze → resolution des noms
        │ 5. Rewrite → application des regles
        │ 6. Plan → choix du meilleur plan d'execution
        │ 7. Execute → lecture des donnees
        │
        │ 8. Cherche d'abord dans Shared Buffers
        │    Si pas trouve → lit depuis le disque
        │
        │ 9. Renvoie les resultats au client
        ▼
    Client recoit les lignes
```

> **Exercice mental** : Quand PostgreSQL execute un `INSERT`, a quel moment les donnees sont-elles vraiment "en securite" ? Reponse : quand le WAL Writer a ecrit l'entree dans le journal sur disque. Les donnees dans les Shared Buffers ne sont pas encore ecrites dans les fichiers de donnees — c'est le Checkpointer qui s'en charge plus tard.

---

## 5. Setup : Docker, psql, pgAdmin

### 5.1 Installation avec Docker

Docker est la facon la plus simple et la plus propre d'installer PostgreSQL pour le developpement.

```bash
# Telecharger et demarrer PostgreSQL 16
docker run \
  --name pg-cours \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=cours \
  -p 5432:5432 \
  -v pgdata:/var/lib/postgresql/data \
  -d \
  postgres:17

# Verifier que le conteneur tourne
docker ps

# Voir les logs de PostgreSQL
docker logs pg-cours
```

> **Piege classique** : N'oublie pas le flag `-v pgdata:/var/lib/postgresql/data`. Sans ce volume, tes donnees seront perdues a chaque redemarrage du conteneur. Le volume Docker persiste les donnees meme si le conteneur est supprime.

### 5.2 Se connecter avec psql

`psql` est le client en ligne de commande officiel de PostgreSQL. C'est l'outil incontournable.

```bash
# Se connecter depuis Docker
docker exec -it pg-cours psql -U postgres -d cours

# Ou si psql est installe localement
psql -h localhost -p 5432 -U postgres -d cours
```

### 5.3 Commandes psql essentielles

| Commande | Description | Exemple |
|---|---|---|
| `\l` | Lister toutes les bases de donnees | `\l` |
| `\c nomdb` | Se connecter a une base | `\c cours` |
| `\dt` | Lister les tables du schema courant | `\dt` |
| `\dt+` | Lister les tables avec taille et description | `\dt+` |
| `\d nomtable` | Decrire une table (colonnes, types, contraintes) | `\d utilisateurs` |
| `\d+ nomtable` | Description detaillee (avec stockage, stats) | `\d+ utilisateurs` |
| `\di` | Lister les index | `\di` |
| `\dn` | Lister les schemas | `\dn` |
| `\du` | Lister les roles/utilisateurs | `\du` |
| `\timing` | Activer/desactiver l'affichage du temps d'execution | `\timing` |
| `\x` | Activer/desactiver l'affichage etendu (vertical) | `\x` |
| `\e` | Ouvrir l'editeur pour ecrire une requete | `\e` |
| `\i fichier.sql` | Executer un fichier SQL | `\i setup.sql` |
| `\q` | Quitter psql | `\q` |
| `\?` | Aide sur les commandes psql | `\?` |
| `\h SELECT` | Aide sur la syntaxe SQL | `\h CREATE TABLE` |

### 5.4 pgAdmin (interface graphique)

```bash
# Demarrer pgAdmin 4 via Docker
docker run \
  --name pgadmin \
  -e PGADMIN_DEFAULT_EMAIL=admin@local.dev \
  -e PGADMIN_DEFAULT_PASSWORD=admin \
  -p 8080:80 \
  --link pg-cours:pg-cours \
  -d \
  dpage/pgadmin4

# Ouvrir http://localhost:8080 dans le navigateur
# Ajouter un serveur : host=pg-cours, port=5432, user=postgres, password=postgres
```

---

## 6. Premier contact : psql basics

### 6.1 Creer et explorer une base de donnees

```sql
-- Creer une base de donnees
CREATE DATABASE boutique;

-- Se connecter a cette base
\c boutique

-- Creer une premiere table
CREATE TABLE produits (
    id          SERIAL PRIMARY KEY,
    nom         TEXT NOT NULL,
    prix        NUMERIC(10, 2) NOT NULL CHECK (prix >= 0),
    en_stock    BOOLEAN DEFAULT true,
    cree_le     TIMESTAMPTZ DEFAULT now()
);

-- Verifier la structure
\d produits

-- Inserer des donnees
INSERT INTO produits (nom, prix) VALUES
    ('Clavier mecanique', 89.99),
    ('Souris ergonomique', 45.50),
    ('Ecran 27 pouces', 349.00),
    ('Cable USB-C', 12.99);

-- Voir les donnees
SELECT * FROM produits;

-- Resultat :
--  id |        nom         |  prix  | en_stock |          cree_le
-- ----+--------------------+--------+----------+-------------------------------
--   1 | Clavier mecanique  |  89.99 | t        | 2024-01-15 10:30:00.123456+01
--   2 | Souris ergonomique |  45.50 | t        | 2024-01-15 10:30:00.123456+01
--   3 | Ecran 27 pouces    | 349.00 | t        | 2024-01-15 10:30:00.123456+01
--   4 | Cable USB-C        |  12.99 | t        | 2024-01-15 10:30:00.123456+01
```

### 6.2 Quelques requetes de base

```sql
-- Filtrer avec WHERE
SELECT nom, prix FROM produits WHERE prix > 50;

-- Trier
SELECT nom, prix FROM produits ORDER BY prix DESC;

-- Compter
SELECT COUNT(*) AS total_produits FROM produits;

-- Moyenne des prix
SELECT AVG(prix)::NUMERIC(10,2) AS prix_moyen FROM produits;

-- Mettre a jour
UPDATE produits SET prix = 79.99 WHERE nom = 'Clavier mecanique';

-- Supprimer
DELETE FROM produits WHERE id = 4;

-- Verifier
SELECT * FROM produits;
```

---

## 7. Node.js + pg driver : hello world complet

### 7.1 Installation

```bash
# Creer un nouveau projet
mkdir pg-hello && cd pg-hello
npm init -y

# Installer le driver pg
npm install pg

# Ajouter "type": "module" dans package.json pour utiliser les imports ES
```

### 7.2 Premier script complet

```typescript
// fichier : index.mjs
// Premier contact avec PostgreSQL depuis Node.js

import pg from 'pg';
const { Pool } = pg;

// Configuration de la connexion
const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'cours',
  user: 'postgres',
  password: 'postgres',
  // Nombre maximum de connexions dans le pool
  max: 10,
  // Temps maximum d'attente pour une connexion (ms)
  connectionTimeoutMillis: 5000,
  // Temps maximum d'inactivite d'une connexion avant fermeture (ms)
  idleTimeoutMillis: 30000,
});

// Gestion des erreurs du pool
pool.on('error', (err: Error) => {
  console.error('Erreur inattendue sur le pool :', err.message);
  process.exit(1);
});

async function main(): Promise<void> {
  try {
    // Test de connexion
    const resultat = await pool.query('SELECT version()');
    console.log('Connecte a PostgreSQL !');
    console.log('Version :', resultat.rows[0].version);

    // Creer une table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id    SERIAL PRIMARY KEY,
        texte TEXT NOT NULL,
        date  TIMESTAMPTZ DEFAULT now()
      )
    `);
    console.log('Table "messages" creee (ou deja existante).');

    // Inserer un message (requete parametree pour eviter les injections SQL)
    const texte = 'Bonjour PostgreSQL depuis Node.js !';
    const insertion = await pool.query(
      'INSERT INTO messages (texte) VALUES ($1) RETURNING *',
      [texte]
    );
    console.log('Message insere :', insertion.rows[0]);

    // Lire tous les messages
    const lecture = await pool.query(
      'SELECT id, texte, date FROM messages ORDER BY date DESC'
    );
    console.log('Tous les messages :');
    for (const msg of lecture.rows) {
      console.log(`  [${msg.id}] ${msg.texte} (${msg.date})`);
    }

    // Compter les messages
    const comptage = await pool.query('SELECT COUNT(*)::int AS total FROM messages');
    console.log('Nombre total de messages :', comptage.rows[0].total);

  } catch (err) {
    console.error('Erreur :', err.message);
  } finally {
    // Toujours fermer le pool a la fin
    await pool.end();
    console.log('Pool ferme. Au revoir !');
  }
}

main();
```

### 7.3 Executer

```bash
node index.mjs
```

Sortie attendue :

```
Connecte a PostgreSQL !
Version : PostgreSQL 17.x on x86_64-pc-linux-gnu, compiled by gcc...
Table "messages" creee (ou deja existante).
Message insere : { id: 1, texte: 'Bonjour PostgreSQL depuis Node.js !', date: 2024-01-15T10:30:00.000Z }
Tous les messages :
  [1] Bonjour PostgreSQL depuis Node.js ! (2024-01-15T10:30:00.000Z)
Nombre total de messages : 1
Pool ferme. Au revoir !
```

### 7.4 Pool vs Client

| | `Pool` | `Client` |
|---|---|---|
| **Utilisation** | Applications web (connexions partagees) | Scripts ponctuels, transactions |
| **Connexions** | Reutilise les connexions existantes | 1 connexion dediee |
| **Transactions** | Pas directement (chaque `query` peut utiliser une connexion differente) | Oui (BEGIN / COMMIT sur la meme connexion) |
| **Recommandation** | **Utiliser par defaut** | Utiliser pour les transactions explicites |

> **Piege classique** : Ne fais JAMAIS `BEGIN` directement sur un `Pool` avec `pool.query('BEGIN')`. Les requetes suivantes pourraient etre executees sur une AUTRE connexion du pool. Utilise `pool.connect()` pour obtenir un `Client` dedie, puis fais ta transaction sur ce client.

```typescript
// MAUVAIS : transaction sur un pool
await pool.query('BEGIN');          // connexion A
await pool.query('INSERT ...');     // connexion B (!!!)
await pool.query('COMMIT');         // connexion C (!!!)

// BON : transaction sur un client dedie
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('INSERT ...');
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release(); // remettre la connexion dans le pool
}
```

---

## 8. Glossaire des termes cles

| Terme | Definition | Analogie |
|---|---|---|
| **SGBDR** | Systeme de Gestion de Base de Donnees Relationnelles | La bibliotheque entiere avec son systeme de gestion |
| **Table (Relation)** | Structure qui stocke des donnees en lignes et colonnes | Une etagere avec des rangements standardises |
| **Ligne (Tuple)** | Un enregistrement dans une table | Un livre sur l'etagere |
| **Colonne (Attribut)** | Un champ type d'une table | Une propriete du livre (titre, auteur, ISBN) |
| **Cle primaire (PK)** | Identifiant unique d'une ligne | Le numero ISBN du livre |
| **Cle etrangere (FK)** | Reference vers la cle primaire d'une autre table | La reference bibliographique |
| **Index** | Structure accelerant les recherches | L'index alphabetique a la fin du livre |
| **Transaction** | Groupe d'operations atomique (tout ou rien) | Un virement bancaire |
| **ACID** | Atomicity, Consistency, Isolation, Durability | Les 4 garanties du contrat bancaire |
| **WAL** | Write-Ahead Log, journal de transactions | Le journal de bord du capitaine |
| **MVCC** | Multi-Version Concurrency Control | Chaque lecteur a sa propre copie du livre |
| **Schema** | Espace de noms logique dans une base | Un etage de la bibliotheque |
| **Query Planner** | Optimiseur qui choisit le meilleur plan d'execution | Le GPS qui calcule le meilleur itineraire |
| **Shared Buffers** | Cache memoire partage pour les pages de donnees | Le plan de travail en cuisine |
| **VACUUM** | Nettoyage des lignes mortes (MVCC) | L'equipe de menage qui recycle les livres retires |

---

## 9. Roadmap du cours

Voici la vue d'ensemble de tous les modules du cours, avec leur niveau de difficulte :

| Module | Titre | Difficulte | Themes principaux |
|---|---|---|---|
| **00** | Prerequis & Vue d'ensemble | ⭐ | SGBDR, architecture, setup, premier contact |
| **01** | Le modele relationnel | ⭐ | Tables, types, contraintes, modelisation |
| **02** | CRUD & Requetes SQL | ⭐ | INSERT, SELECT, UPDATE, DELETE, agregations |
| **03** | Relations & Jointures | ⭐⭐ | FK, JOIN, 1:N, N:M, self-join |
| **04** | Transactions & ACID | ⭐⭐ | BEGIN/COMMIT, WAL, isolation, crash recovery |
| **05** | Index : les fondamentaux | ⭐⭐ | B-tree, composite, partial, hash |
| **06** | Le Query Planner | ⭐⭐⭐ | EXPLAIN ANALYZE, scans, join strategies, stats |
| **07** | Index avances (GIN, GiST, BRIN) | ⭐⭐⭐ | JSONB, full-text, ranges, covering indexes |
| **08** | Niveaux d'isolation | ⭐⭐⭐ | Read Committed, Repeatable Read, Serializable |
| **09** | MVCC en profondeur | ⭐⭐⭐ | xmin/xmax, snapshots, VACUUM, bloat |
| **10** | Full-text search | ⭐⭐ | tsvector, tsquery, ranking, GIN |
| **11** | JSONB & donnees semi-structurees | ⭐⭐ | Operateurs JSONB, indexation, patterns |
| **12** | Fonctions & procedures (PL/pgSQL) | ⭐⭐⭐ | Fonctions, triggers, procedures stockees |
| **13** | Roles, permissions & securite | ⭐⭐ | GRANT, REVOKE, Row-Level Security |
| **14** | Partitionnement | ⭐⭐⭐ | Range, List, Hash partitioning |
| **15** | Backup, replication & haute dispo | ⭐⭐⭐ | pg_dump, streaming replication, failover |

### Progression recommandee

```
 Semaine 1          Semaine 2          Semaine 3          Semaine 4
 ┌─────────┐       ┌─────────┐       ┌─────────┐       ┌─────────┐
 │ Mod. 00 │──────▶│ Mod. 03 │──────▶│ Mod. 06 │──────▶│ Mod. 09 │
 │ Mod. 01 │       │ Mod. 04 │       │ Mod. 07 │       │ Mod. 10 │
 │ Mod. 02 │       │ Mod. 05 │       │ Mod. 08 │       │ Mod. 11 │
 └─────────┘       └─────────┘       └─────────┘       └─────────┘
       │                 │                 │                 │
       ▼                 ▼                 ▼                 ▼
   Fondations       Relations &       Optimisation     Avance &
   SQL de base      Transactions      & Performance    Specialise
```

> **Ce qu'il faut retenir** : Ne saute pas les modules fondamentaux (00-02). Meme si tu connais deja SQL, les sections sur l'architecture PostgreSQL et les bonnes pratiques Node.js te seront utiles. Les modules avances (06+) s'appuient fortement sur les concepts des modules precedents.

---

## 10. Exercice mental

Avant de passer au module suivant, reflechis a ces questions :

1. **Pourquoi PostgreSQL utilise-t-il un processus par connexion plutot que des threads ?** (Indice : stabilite, isolation memoire, crash d'un processus n'affecte pas les autres)

2. **Pourquoi le WAL (Write-Ahead Log) ecrit-il sur disque AVANT les donnees ?** (Indice : si le serveur crash apres l'ecriture WAL mais avant l'ecriture des donnees, PostgreSQL peut rejouer le WAL au redemarrage)

3. **Pourquoi utiliser un pool de connexions en Node.js plutot qu'un seul Client ?** (Indice : les connexions PostgreSQL sont couteuses a creer — fork d'un processus — et une application web gere des dizaines/centaines de requetes simultanees)

---

## Navigation

| | Lien |
|---|---|
| Module suivant | [Module 01 — Le modele relationnel](./01-modele-relationnel.md) |
| Lab associe | Pas de lab pour ce module d'introduction |

---

> **Ce qu'il faut retenir** : PostgreSQL est un SGBDR open-source mature, puissant et extensible. Son architecture multi-processus avec WAL garantit la fiabilite. Docker + psql + Node.js pg forment un trio de developpement efficace. Ce cours te guidera du debutant a l'expert, un module a la fois.
