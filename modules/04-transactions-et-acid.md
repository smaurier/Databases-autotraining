# Module 04 — Transactions & ACID

> **Objectif** : Comprendre les propriétés ACID, maîtriser les transactions en SQL et en Node.js, découvrir le WAL (Write-Ahead Log) et le mécanisme de crash recovery de PostgreSQL.
>
> **Difficulte** : ⭐⭐ (intermédiaire)

---

## 1. Qu'est-ce qu'une transaction

### 1.1 Definition

Une **transaction** est un groupe d'operations SQL qui forment une **unite logique de travail**. Soit toutes les operations reussissent (`COMMIT`), soit aucune n'est appliquee (`ROLLBACK`).

> **Analogie** : Le virement bancaire est l'exemple classique. Quand tu transferes 100 EUR de ton compte A vers ton compte B, il faut que les deux operations se fassent ensemble :
> 1. Debiter 100 EUR de A
> 2. Crediter 100 EUR sur B
>
> Si le système plante entre les deux operations, l'argent ne doit ni disparaitre ni etre duplique. La transaction garantit que c'est **tout ou rien**.

```sql
-- Transaction de virement bancaire
BEGIN;

UPDATE compte SET solde = solde - 100 WHERE id = 1;  -- debiter A
UPDATE compte SET solde = solde + 100 WHERE id = 2;  -- crediter B

-- Verifier que le solde n'est pas negatif
-- (on pourrait aussi utiliser une contrainte CHECK)
DO $$
BEGIN
    IF (SELECT solde FROM compte WHERE id = 1) < 0 THEN
        RAISE EXCEPTION 'Solde insuffisant';
    END IF;
END $$;

COMMIT;  -- les deux operations sont appliquees atomiquement
```

### 1.2 Sans transactions : le chaos

```
 Sans transaction — ce qui peut arriver :

 Temps    Operation               Solde A    Solde B
 ────────────────────────────────────────────────────
 t0       (etat initial)          500 EUR    200 EUR
 t1       UPDATE A: -100          400 EUR    200 EUR
 t2       *** CRASH SERVEUR ***
 t3       (redemarrage)           400 EUR    200 EUR
                                     │
                                     ▼
                               100 EUR PERDUS !

 Avec transaction — ce qui se passe :

 Temps    Operation               Solde A    Solde B
 ────────────────────────────────────────────────────
 t0       BEGIN                   500 EUR    200 EUR
 t1       UPDATE A: -100          (400)*     200 EUR
 t2       *** CRASH SERVEUR ***
 t3       (redemarrage)           500 EUR    200 EUR
           ROLLBACK automatique       │
                                     ▼
                               RIEN N'A CHANGE !

 * modifications visibles seulement dans la transaction
```

---

## 2. ACID en detail

### 2.1 Atomicity (Atomicite)

**Tout ou rien.** Une transaction est indivisible : soit toutes les operations sont appliquees, soit aucune.

> **Analogie** : Envoyer un colis. Le colis arrive complet (tous les objets dedans) ou pas du tout. On ne recoit pas la moitie du colis. Si la livraison echoue, tout le colis revient a l'expediteur.

```sql
-- Atomicite : si une operation echoue, tout est annule
BEGIN;

INSERT INTO commande (client_id, total) VALUES (1, 150.00);
-- OK, commande creee

INSERT INTO ligne_commande (commande_id, produit_id, quantite)
VALUES (currval('commande_id_seq'), 999, 2);
-- ERREUR : produit_id=999 n'existe pas (violation FK)

-- A ce stade, la transaction est en etat "aborted"
-- TOUTES les operations precedentes sont annulees
COMMIT;  -- PostgreSQL fait automatiquement un ROLLBACK ici
```

### 2.2 Consistency (Coherence)

La base de donnees passe d'un **état valide** à un autre **état valide**. Les contraintes (NOT NULL, CHECK, FK, UNIQUE) sont toujours respectees après un COMMIT.

> **Analogie** : Les regles du jeu d'echecs. Après chaque coup, le plateau doit etre dans un état legal. Un joueur ne peut pas poser un pion sur une case déjà occupee par son propre pion. La base de donnees, c'est pareil : les contraintes sont les regles du jeu.

```sql
-- La coherence est garantie par les contraintes
CREATE TABLE compte (
    id     SERIAL PRIMARY KEY,
    solde  NUMERIC(12,2) NOT NULL CHECK (solde >= 0)
);

INSERT INTO compte (solde) VALUES (500), (200);

BEGIN;
UPDATE compte SET solde = solde - 600 WHERE id = 1;  -- 500 - 600 = -100
-- ERREUR : new row violates check constraint "compte_solde_check"
-- La transaction est annulee → coherence preservee
ROLLBACK;
```

### 2.3 Isolation

Les transactions concurrentes **ne se voient pas** pendant leur exécution. Chaque transaction travaille comme si elle etait seule.

> **Analogie** : Deux cuisiniers travaillent dans la même cuisine mais avec des plans de travail separes. Chacun prepare son plat sans voir ce que l'autre fait. Quand un cuisinier a fini (COMMIT), son plat est servi et visible par tous.

```sql
-- Session 1                        -- Session 2
BEGIN;                               BEGIN;
UPDATE compte
SET solde = 1000
WHERE id = 1;
                                     SELECT solde FROM compte WHERE id = 1;
                                     -- Resultat : 500 (pas 1000 !)
                                     -- Session 2 ne voit PAS la modification
                                     -- de Session 1 (pas encore COMMIT)
COMMIT;
                                     SELECT solde FROM compte WHERE id = 1;
                                     -- Resultat : 1000 (maintenant visible)
                                     COMMIT;
```

> **Ce qu'il faut retenir** : L'isolation a plusieurs niveaux (Read Committed, Repeatable Read, Serializable). Le niveau par defaut de PostgreSQL est **Read Committed** : une transaction voit les modifications commitees par les autres transactions, mais pas les modifications en cours. Les niveaux d'isolation avances sont traites dans un module dedie.

### 2.4 Durability (Durabilite)

Une fois qu'une transaction est `COMMIT`, les donnees sont **definitivement** stockees, même en cas de crash, panne de courant, ou defaillance materielle.

> **Analogie** : Le journal de bord du capitaine. Chaque événement important est écrit dans le journal AVANT d'etre exécuté. Même si le bateau coule, on peut reconstituer ce qui s'est passe en lisant le journal (qui est dans un coffre etanche). Dans PostgreSQL, ce journal s'appelle le **WAL** (Write-Ahead Log).

```
 COMMIT et durabilite :

 1. Application : "COMMIT cette transaction"
 2. PostgreSQL ecrit dans le WAL (disque)        ← DURABLE a partir d'ici
 3. PostgreSQL repond "COMMIT OK" au client
 4. Plus tard, le Checkpointer ecrit les donnees
    modifiees dans les fichiers de donnees

 Si crash entre 2 et 4 :
 → Au redemarrage, PostgreSQL relit le WAL et re-applique les operations
 → Les donnees sont restaurees a leur etat post-COMMIT
```

### 2.5 Tableau récapitulatif ACID

| Propriété | Garantie | Mécanisme PostgreSQL | Analogie |
|---|---|---|---|
| **Atomicity** | Tout ou rien | Transaction log + ROLLBACK | Colis complet ou retour |
| **Consistency** | État valide → état valide | Contraintes (CHECK, FK, NOT NULL...) | Regles du jeu d'echecs |
| **Isolation** | Transactions invisibles entre elles | MVCC (Multi-Version Concurrency Control) | Plans de travail separes |
| **Durability** | COMMIT = permanent | WAL (Write-Ahead Log) | Journal de bord du capitaine |

---

## 3. BEGIN / COMMIT / ROLLBACK

### 3.1 Syntaxe de base

```sql
-- Demarrer une transaction
BEGIN;
-- ou
BEGIN TRANSACTION;
-- ou
START TRANSACTION;

-- Valider (appliquer) la transaction
COMMIT;
-- ou
COMMIT TRANSACTION;
-- ou
END;

-- Annuler la transaction
ROLLBACK;
-- ou
ABORT;
```

### 3.2 Exemples pratiques

```sql
-- Transaction reussie
BEGIN;
INSERT INTO produit (nom, prix) VALUES ('Clavier', 89.99);
INSERT INTO produit (nom, prix) VALUES ('Souris', 34.99);
UPDATE produit SET prix = prix * 0.9 WHERE prix > 50;
COMMIT;
-- Les 3 operations sont appliquees atomiquement

-- Transaction annulee manuellement
BEGIN;
DELETE FROM produit WHERE categorie = 'obsolete';
-- Oups, on a supprime trop de produits
SELECT COUNT(*) FROM produit;  -- verification
ROLLBACK;
-- Aucune suppression n'est appliquee

-- Transaction annulee par erreur
BEGIN;
INSERT INTO produit (nom, prix) VALUES ('Test', 10);
INSERT INTO produit (nom, prix) VALUES ('Test', -5);  -- CHECK violation
-- ERREUR : prix doit etre >= 0
-- Transaction en etat "aborted"
INSERT INTO produit (nom, prix) VALUES ('Autre', 20);
-- ERREUR : current transaction is aborted, commands ignored until end of transaction block
ROLLBACK;  -- seule option possible maintenant
```

> **Piege classique** : En PostgreSQL, après une erreur dans une transaction, **toutes les commandes suivantes sont rejetees** jusqu'au `ROLLBACK`. C'est différent de MySQL qui peut continuer après une erreur. Tu DOIS faire un `ROLLBACK` pour "nettoyer" l'état d'erreur.

---

## 4. SAVEPOINT — checkpoints dans une transaction

### 4.1 Principe

Un `SAVEPOINT` créé un point de sauvegarde a l'interieur d'une transaction. Tu peux revenir a ce point (`ROLLBACK TO`) sans annuler toute la transaction.

> **Analogie** : C'est comme les points de sauvegarde dans un jeu video. Si tu meurs au niveau 5, tu reviens au dernier checkpoint (niveau 3) au lieu de recommencer depuis le debut.

```sql
BEGIN;

INSERT INTO compte (nom, solde) VALUES ('Alice', 1000);
SAVEPOINT avant_bob;

INSERT INTO compte (nom, solde) VALUES ('Bob', -500);
-- ERREUR : CHECK constraint violation (solde >= 0)

ROLLBACK TO avant_bob;
-- On revient au point apres l'insertion d'Alice

-- Alice est toujours inseree, Bob non
INSERT INTO compte (nom, solde) VALUES ('Bob', 500);
-- OK cette fois

COMMIT;
-- Alice (1000) et Bob (500) sont enregistres
```

### 4.2 Savepoints imbriques

```sql
BEGIN;

INSERT INTO log (message) VALUES ('etape 1');
SAVEPOINT sp1;

INSERT INTO log (message) VALUES ('etape 2');
SAVEPOINT sp2;

INSERT INTO log (message) VALUES ('etape 3');
-- Probleme a l'etape 3 → revenir a sp2
ROLLBACK TO sp2;

INSERT INTO log (message) VALUES ('etape 3 bis');
-- Finalement, revenir a sp1
ROLLBACK TO sp1;

-- Seule "etape 1" est conservee
INSERT INTO log (message) VALUES ('etape 2 corrigee');

COMMIT;
-- Resultat : "etape 1" et "etape 2 corrigee"
```

### 4.3 Liberer un savepoint

```sql
BEGIN;
SAVEPOINT sp1;
-- ... operations ...
RELEASE SAVEPOINT sp1;  -- le savepoint est supprime, les operations sont conservees
COMMIT;
```

---

## 5. Autocommit dans PostgreSQL

### 5.1 Chaque statement est une mini-transaction

En dehors d'un bloc `BEGIN`...`COMMIT`, chaque instruction SQL est **automatiquement enveloppee** dans sa propre transaction.

```sql
-- Sans BEGIN explicite, chaque ligne est une transaction independante

INSERT INTO produit (nom, prix) VALUES ('A', 10);
-- Transaction implicite : BEGIN → INSERT → COMMIT (automatique)

INSERT INTO produit (nom, prix) VALUES ('B', 20);
-- Transaction implicite : BEGIN → INSERT → COMMIT (automatique)

-- Si la 2e instruction echoue, la 1ere est deja commitee
-- Pas de rollback possible de 'A'
```

> **Ce qu'il faut retenir** : En PostgreSQL, **il n'y a pas d'instruction executee en dehors d'une transaction**. L'autocommit est simplement un raccourci qui fait `BEGIN`/`COMMIT` autour de chaque instruction individuelle. C'est le comportement par defaut de psql et de la plupart des drivers.

### 5.2 Desactiver l'autocommit dans psql

```sql
-- Dans psql, tu peux desactiver l'autocommit
\set AUTOCOMMIT off

-- Maintenant, chaque commande est dans une transaction implicite
-- Tu dois faire COMMIT ou ROLLBACK manuellement
INSERT INTO produit (nom, prix) VALUES ('Test', 10);
-- Transaction ouverte (pas de COMMIT automatique)
COMMIT;

-- Reactiver
\set AUTOCOMMIT on
```

---

## 6. Le WAL (Write-Ahead Log)

### 6.1 Principe fondamental

Le WAL est le mécanisme qui garantit la **durabilite** (le D de ACID). La regle est simple :

> **Avant de modifier les donnees sur disque, ecris d'abord la modification dans le journal (WAL).**

```
 Ecriture SANS WAL (dangereux) :

 Application → Modifier les donnees directement sur disque
                     │
                     ▼
                *** CRASH ***
                     │
                     ▼
              Donnees corrompues
              (modification a moitie faite)


 Ecriture AVEC WAL (PostgreSQL) :

 Application → 1. Ecrire dans le WAL (journal)
                     │
                     ▼
               2. Confirmer le COMMIT au client
                     │
                     ▼
               3. Plus tard : ecrire les donnees sur disque
                     │
                     ▼
                *** CRASH ***
                     │
                     ▼
               4. Au redemarrage : relire le WAL
                  et re-appliquer les operations manquantes
                     │
                     ▼
               Donnees intactes !
```

> **Analogie** : Le journal de bord du capitaine. Avant chaque manoeuvre, le capitaine écrit dans son journal : "A 14h30, virer a babord de 30 degres". Si le capitaine est frappe d'amnesie, on peut relire le journal et reproduire toutes les manoeuvres exactement.

### 6.2 Structure du WAL

```
 Structure du WAL sur disque :

 PGDATA/pg_wal/
 ├── 000000010000000000000001   (16 Mo, segment WAL)
 ├── 000000010000000000000002   (16 Mo)
 ├── 000000010000000000000003   (16 Mo)
 └── ...

 Chaque segment = 16 Mo (par defaut)
 Chaque segment contient des "WAL records" :

 ┌─────────────────────────────────────────────────┐
 │  WAL Record 1: INSERT INTO produit VALUES(...)  │
 │  WAL Record 2: UPDATE compte SET solde=...      │
 │  WAL Record 3: DELETE FROM log WHERE...         │
 │  WAL Record 4: COMMIT (transaction X)           │
 │  ...                                            │
 └─────────────────────────────────────────────────┘
```

### 6.3 Parametres WAL importants

| Paramètre | Valeur par defaut | Role |
|---|---|---|
| `wal_level` | `replica` | Niveau de detail du WAL (minimal, replica, logical) |
| `fsync` | `on` | Force l'écriture physique sur disque (JAMAIS désactiver en prod !) |
| `synchronous_commit` | `on` | Attend la confirmation d'écriture WAL avant COMMIT |
| `wal_buffers` | `~3% de shared_buffers` | Taille du buffer WAL en mémoire |
| `max_wal_size` | `1GB` | Taille max des WAL avant un checkpoint force |
| `min_wal_size` | `80MB` | Taille min a conserver |
| `checkpoint_timeout` | `5min` | Intervalle max entre deux checkpoints |

> **Piege classique** : Certains tutoriels recommandent de mettre `fsync = off` pour accelerer les benchmarks. C'est extremement dangereux en production : en cas de coupure de courant, tu peux perdre TOUTES tes donnees. Ne JAMAIS désactiver `fsync` sauf pour des bases de donnees jetables (tests, dev).

### 6.4 Le processus WAL Writer

```
 Cycle d'ecriture des donnees :

                    Backend (ta requete)
                           │
             ┌─────────────┴─────────────┐
             │                           │
             ▼                           ▼
    ┌──────────────┐          ┌──────────────────┐
    │ Shared Buffers│          │   WAL Buffers    │
    │ (pages       │          │   (journal en    │
    │  modifiees)  │          │    memoire)      │
    └──────┬───────┘          └────────┬─────────┘
           │                           │
           │ (checkpoint)              │ (WAL Writer / COMMIT)
           ▼                           ▼
    ┌──────────────┐          ┌──────────────────┐
    │ Fichiers de  │          │  Fichiers WAL    │
    │ donnees      │          │  (pg_wal/)       │
    │ (sur disque) │          │  (sur disque)    │
    └──────────────┘          └──────────────────┘

    L'ecriture WAL est TOUJOURS faite avant
    l'ecriture des donnees → Write-Ahead Log
```

---

## 7. Gestion d'erreurs dans les transactions PostgreSQL

### 7.1 L'état "aborted"

```sql
BEGIN;

SELECT * FROM produit;         -- OK
INSERT INTO produit (nom, prix) VALUES ('Test', 10);  -- OK
INSERT INTO produit (nom, prix) VALUES ('Bug', -1);   -- ERREUR : CHECK violation

-- A partir d'ici, la transaction est en etat "aborted"
SELECT 1;
-- ERREUR : current transaction is aborted, commands ignored
-- until end of transaction block

-- La SEULE option est ROLLBACK
ROLLBACK;
```

> **Ce qu'il faut retenir** : En PostgreSQL, une erreur dans une transaction **empeche toutes les commandes suivantes**. C'est plus strict que MySQL ou Oracle. C'est un choix de design delibere : il vaut mieux forcer le développeur a gérer l'erreur plutot que de laisser passer des operations sur des donnees potentiellement incoherentes.

### 7.2 Pattern : SAVEPOINT pour gérer les erreurs partielles

```sql
BEGIN;

-- Operation 1 : toujours necessaire
INSERT INTO commande (client_id, total) VALUES (1, 100);

-- Operation 2 : optionnelle (on peut tolerer un echec)
SAVEPOINT avant_bonus;
BEGIN
    INSERT INTO bonus (commande_id, montant) VALUES (currval('commande_id_seq'), 10);
EXCEPTION WHEN OTHERS THEN
    -- Ignorer l'erreur et continuer
    ROLLBACK TO avant_bonus;
END;

-- Operation 3 : continue meme si le bonus a echoue
UPDATE client SET nb_commandes = nb_commandes + 1 WHERE id = 1;

COMMIT;
```

### 7.3 Gestion en PL/pgSQL

```sql
-- Bloc PL/pgSQL avec gestion d'exceptions
DO $$
DECLARE
    v_commande_id INTEGER;
BEGIN
    -- Inserer la commande
    INSERT INTO commande (client_id, total)
    VALUES (1, 150.00)
    RETURNING id INTO v_commande_id;

    -- Inserer les lignes (peut echouer)
    INSERT INTO ligne_commande (commande_id, produit_id, quantite)
    VALUES (v_commande_id, 42, 2);

    RAISE NOTICE 'Commande % creee avec succes', v_commande_id;

EXCEPTION
    WHEN foreign_key_violation THEN
        RAISE WARNING 'Produit inexistant, commande annulee';
        -- Le bloc est automatiquement en ROLLBACK
    WHEN check_violation THEN
        RAISE WARNING 'Violation de contrainte, commande annulee';
    WHEN OTHERS THEN
        RAISE WARNING 'Erreur inattendue : %', SQLERRM;
END $$;
```

---

## 8. Transactions en Node.js avec pg

### 8.1 Pattern de base : BEGIN / COMMIT / ROLLBACK

```typescript
// fichier : transaction-basique.mjs
// Pattern de transaction avec le driver pg

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'cours',
  user: 'postgres',
  password: 'postgres',
});

async function virementBancaire(compteSource, compteDestination, montant) {
  // IMPORTANT : utiliser un Client dedie (pas pool.query directement)
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Debiter le compte source
    const debit = await client.query(
      'UPDATE compte SET solde = solde - $1 WHERE id = $2 RETURNING solde',
      [montant, compteSource]
    );

    // Verifier que le solde est suffisant
    if (debit.rows[0].solde < 0) {
      throw new Error(`Solde insuffisant sur le compte ${compteSource}`);
    }

    // Crediter le compte destination
    await client.query(
      'UPDATE compte SET solde = solde + $1 WHERE id = $2',
      [montant, compteDestination]
    );

    // Enregistrer le virement dans l'historique
    await client.query(
      `INSERT INTO historique_virement (source, destination, montant, date)
       VALUES ($1, $2, $3, now())`,
      [compteSource, compteDestination, montant]
    );

    await client.query('COMMIT');
    console.log(`Virement de ${montant} EUR effectue avec succes.`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Virement annule :', err.message);
    throw err;  // propager l'erreur

  } finally {
    // TOUJOURS remettre le client dans le pool
    client.release();
  }
}

// Utilisation
async function main() {
  try {
    await virementBancaire(1, 2, 100);
  } catch (err) {
    console.error('Erreur finale :', err.message);
  } finally {
    await pool.end();
  }
}

main();
```

### 8.2 Helper générique : withTransaction()

```typescript
// fichier : helpers/transaction.mjs
// Helper reutilisable pour les transactions

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'cours',
  user: 'postgres',
  password: 'postgres',
});

/**
 * Execute une fonction dans une transaction.
 * Si la fonction reussit → COMMIT.
 * Si la fonction echoue → ROLLBACK.
 *
 * @param {function} fn - Fonction async recevant le client en parametre
 * @returns {*} Le resultat de la fonction
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const resultat = await fn(client);
    await client.query('COMMIT');
    return resultat;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Utilisation
async function creerCommandeComplete(clientId, lignes) {
  return withTransaction(async (client) => {
    // Creer la commande
    const { rows: [commande] } = await client.query(
      `INSERT INTO commande (client_id, statut)
       VALUES ($1, 'en_attente')
       RETURNING id`,
      [clientId]
    );

    let total = 0;

    // Inserer chaque ligne de commande
    for (const ligne of lignes) {
      // Verifier le stock
      const { rows: [produit] } = await client.query(
        'SELECT prix, stock FROM produit WHERE id = $1 FOR UPDATE',
        [ligne.produitId]
      );

      if (!produit) {
        throw new Error(`Produit ${ligne.produitId} introuvable`);
      }
      if (produit.stock < ligne.quantite) {
        throw new Error(`Stock insuffisant pour le produit ${ligne.produitId}`);
      }

      // Inserer la ligne
      await client.query(
        `INSERT INTO ligne_commande (commande_id, produit_id, quantite, prix_unitaire)
         VALUES ($1, $2, $3, $4)`,
        [commande.id, ligne.produitId, ligne.quantite, produit.prix]
      );

      // Diminuer le stock
      await client.query(
        'UPDATE produit SET stock = stock - $1 WHERE id = $2',
        [ligne.quantite, ligne.produitId]
      );

      total += produit.prix * ligne.quantite;
    }

    // Mettre a jour le total de la commande
    await client.query(
      'UPDATE commande SET total = $1 WHERE id = $2',
      [total, commande.id]
    );

    return { commandeId: commande.id, total };
  });
}

// Exemple d'appel
async function main() {
  try {
    const resultat = await creerCommandeComplete(1, [
      { produitId: 1, quantite: 2 },
      { produitId: 3, quantite: 1 },
    ]);
    console.log('Commande creee :', resultat);
  } catch (err) {
    console.error('Erreur :', err.message);
  } finally {
    await pool.end();
  }
}

main();
```

### 8.3 Pool vs Client pour les transactions

```
 RAPPEL : Pourquoi utiliser un Client dedie pour les transactions ?

 Pool.query() :
 ┌──────────────────────────────────────────────────┐
 │  pool.query('BEGIN')    → connexion A            │
 │  pool.query('INSERT')   → connexion B (!!!)      │
 │  pool.query('COMMIT')   → connexion C (!!!)      │
 │                                                  │
 │  Les 3 requetes sont sur des connexions          │
 │  DIFFERENTES → la transaction est cassee         │
 └──────────────────────────────────────────────────┘

 Client dedie (pool.connect()) :
 ┌──────────────────────────────────────────────────┐
 │  const client = await pool.connect();            │
 │  client.query('BEGIN')    → connexion A          │
 │  client.query('INSERT')   → connexion A          │
 │  client.query('COMMIT')   → connexion A          │
 │  client.release();                               │
 │                                                  │
 │  Les 3 requetes sont sur la MEME connexion       │
 │  → la transaction fonctionne correctement        │
 └──────────────────────────────────────────────────┘
```

> **Piege classique** : Oublier `client.release()` dans le `finally`. Si tu oublies, la connexion n'est jamais rendue au pool, et après `max` connexions non liberees, l'application se bloque en attendant une connexion disponible. Utilise TOUJOURS un bloc `try`/`finally`.

---

## 9. Transactions longues : les risques

### 9.1 Pourquoi les transactions longues sont dangereuses

```
 Transaction longue — problemes :

 ┌─────────────────────────────────────────────────────────┐
 │  Transaction A (longue, 30 minutes)                     │
 │  BEGIN;                                                 │
 │  SELECT ... (snapshot pris ici)                         │
 │  ... (le developpeur est parti prendre un cafe)         │
 │                                                         │
 │  Pendant ce temps :                                     │
 │  - Transaction B : UPDATE 1000 lignes → COMMIT          │
 │  - Transaction C : DELETE 500 lignes → COMMIT           │
 │  - Transaction D : UPDATE 2000 lignes → COMMIT          │
 │                                                         │
 │  Les anciennes versions des lignes NE PEUVENT PAS       │
 │  etre nettoyees par VACUUM car la transaction A         │
 │  pourrait encore en avoir besoin !                      │
 │                                                         │
 │  Resultat : "table bloat" — la table grossit            │
 │  enormement avec des lignes mortes                      │
 └─────────────────────────────────────────────────────────┘
```

| Risque | Description |
|---|---|
| **Table bloat** | Les tuples morts s'accumulent car VACUUM ne peut pas les nettoyer |
| **Index bloat** | Les index grossissent avec des entrees pointant vers des tuples morts |
| **Lock contention** | Les verrous sont maintenus, bloquant d'autres transactions |
| **Wraparound risk** | Les transaction IDs sont limites (2^32), les anciennes transactions empechent le recyclage |
| **Performance degradee** | Les Seq Scan doivent lire les tuples morts en plus des tuples vivants |

### 9.2 Bonnes pratiques

```sql
-- Surveiller les transactions longues
SELECT
    pid,
    usename,
    state,
    age(now(), xact_start) AS duree,
    query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND xact_start < now() - INTERVAL '5 minutes'
ORDER BY xact_start;

-- Configurer un timeout pour les transactions idle
SET idle_in_transaction_session_timeout = '5min';

-- En configuration globale (postgresql.conf)
-- idle_in_transaction_session_timeout = 300000  -- 5 minutes en ms
```

> **Ce qu'il faut retenir** : Garde tes transactions aussi **courtes que possible**. Ne fais JAMAIS d'operations non-base-de-donnees (appels HTTP, attente utilisateur, etc.) a l'interieur d'une transaction. Prends les donnees, fais les calculs en mémoire, puis ouvre une transaction juste pour les ecritures.

---

## 10. Crash recovery : comment PostgreSQL redemarre

### 10.1 Le processus de récupération

Quand PostgreSQL redemarre après un crash (où un arret brutal), il exécuté automatiquement la **crash recovery** :

```
 Crash Recovery :

 1. PostgreSQL detecte un arret non propre
    (pas de pg_control avec "shut down" propre)

 2. Lire le dernier checkpoint dans pg_control
    ┌─────────────────────────────────────┐
    │ Checkpoint : WAL position 0/1A3B000 │
    │ = Toutes les donnees AVANT ce point │
    │   sont deja ecrites sur disque      │
    └─────────────────────────────────────┘

 3. Rejouer (replay) tous les WAL records APRES le checkpoint

    WAL : [...checkpoint...][record A][record B][record C]
                             ▲
                             └─ Commencer ici

    Pour chaque WAL record :
    - Si c'est un INSERT → re-inserer la ligne
    - Si c'est un UPDATE → re-appliquer la modification
    - Si c'est un COMMIT → marquer la transaction comme commitee
    - Si c'est un ABORT → ignorer (ne pas appliquer)

 4. Les transactions non commitees au moment du crash
    sont automatiquement annulees (ROLLBACK implicite)

 5. PostgreSQL est pret a accepter les connexions
```

### 10.2 Checkpoint en detail

```
 Checkpoint : le "point de coherence"

 Avant checkpoint :
 ┌─────────────────────────────────────────────┐
 │  Shared Buffers        │   Fichiers disque  │
 │  (dirty pages)         │   (peut-etre vieux)│
 │  Page A (modifiee)     │   Page A (ancienne)│
 │  Page B (modifiee)     │   Page B (ancienne)│
 │  Page C (propre)       │   Page C (a jour)  │
 └─────────────────────────────────────────────┘

 Pendant le checkpoint :
 → Ecrire toutes les dirty pages sur disque
 → Enregistrer la position WAL du checkpoint

 Apres checkpoint :
 ┌─────────────────────────────────────────────┐
 │  Shared Buffers        │   Fichiers disque  │
 │  Page A (propre)       │   Page A (a jour)  │
 │  Page B (propre)       │   Page B (a jour)  │
 │  Page C (propre)       │   Page C (a jour)  │
 └─────────────────────────────────────────────┘

 → Les WAL avant ce checkpoint peuvent etre recycles
 → En cas de crash, seuls les WAL apres le checkpoint
   doivent etre rejoues
```

```sql
-- Forcer un checkpoint manuellement (rarement necessaire)
CHECKPOINT;

-- Voir les statistiques de checkpoint
SELECT * FROM pg_stat_bgwriter;
-- checkpoints_timed : checkpoints automatiques (par timeout)
-- checkpoints_req   : checkpoints demandes (par max_wal_size)
```

---

## 11. Exercice mental

1. **Une transaction INSERT + UPDATE echoue a l'UPDATE.** Que se passe-t-il avec l'INSERT ? (Reponse : l'INSERT est aussi annule, car la transaction est atomique)

2. **Tu fais un COMMIT, puis le serveur crash 1 seconde après.** Les donnees sont-elles perdues ? (Reponse : non, car le WAL a ete écrit sur disque AVANT le COMMIT)

3. **Tu as une transaction ouverte depuis 2 heures en "idle in transaction".** Quels sont les problèmes potentiels ? (Reponse : table bloat, lock contention, risque de transaction ID wraparound)

4. **Pourquoi faut-il utiliser `pool.connect()` et pas `pool.query()` pour les transactions en Node.js ?** (Reponse : `pool.query()` prend une connexion différente à chaque appel, donc les commandes BEGIN/INSERT/COMMIT pourraient s'exécuter sur des connexions différentes)

---

## Navigation

| | Lien |
|---|---|
| Module précédent | [Module 03 — Relations & Jointures](./03-relations-et-jointures.md) |
| Module suivant | [Module 05 — Index : les fondamentaux](./05-index-fondamentaux.md) |
| Lab associe | [Lab 04 — Transactions et gestion d'erreurs](../labs/lab-04.md) |

---

> **Ce qu'il faut retenir** : Les transactions garantissent ACID : Atomicite (tout ou rien), Coherence (contraintes respectees), Isolation (transactions invisibles entre elles), Durabilite (COMMIT = permanent grace au WAL). En Node.js, utilise toujours un Client dedie (`pool.connect()`) pour les transactions, et un helper `withTransaction()` pour éviter les oublis de ROLLBACK ou release. Garde les transactions courtes pour éviter le bloat et les blocages.

---

<!-- parcours-recommande -->

::: tip Parcours recommandé
1. **Screencast** : [screencast 04 transactions et acid](../screencasts/screencast-04-transactions-et-acid.md)
2. **Lab** : [lab-04-transactions](../labs/lab-04-transactions/README)
3. **Visualisation** : [WAL & Transaction](../visualizations/wal-transaction.html)
4. **Quiz** : [quiz 04 transactions et acid](../quizzes/quiz-04-transactions-et-acid.html)
:::
