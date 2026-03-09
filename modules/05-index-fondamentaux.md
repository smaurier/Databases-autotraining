# Module 05 — Index : les fondamentaux

> **Objectif** : Comprendre pourquoi les index sont indispensables, maitriser le fonctionnement interne du B-tree, savoir creer des index simples, composites, partiels, d'expression et hash, et evaluer le cout/benefice de chaque index.
>
> **Difficulte** : ⭐⭐ (intermediaire)

---

## 1. Pourquoi les index

### 1.1 Le probleme : chercher une aiguille dans une botte de foin

Sans index, PostgreSQL doit lire **chaque ligne** de la table pour trouver celles qui correspondent a ta requete. C'est ce qu'on appelle un **Seq Scan** (Sequential Scan) ou **Full Table Scan**.

> **Analogie** : Imagine un livre de 1000 pages sans index ni table des matieres. Pour trouver toutes les pages qui parlent de "PostgreSQL", tu dois lire les 1000 pages une par une. Avec un index alphabetique a la fin du livre, tu trouves "PostgreSQL : pages 42, 156, 789" instantanement.

```sql
-- Sans index : PostgreSQL lit TOUTE la table
SELECT * FROM employe WHERE email = 'alice@example.com';
-- Plan : Seq Scan on employe (cost=0.00..25.00 rows=1 width=...)
-- Lit les 10 000 lignes pour en trouver 1

-- Avec un index sur email
CREATE INDEX idx_employe_email ON employe(email);

-- Maintenant : PostgreSQL utilise l'index
SELECT * FROM employe WHERE email = 'alice@example.com';
-- Plan : Index Scan using idx_employe_email on employe (cost=0.29..8.30 rows=1 width=...)
-- Lit directement la bonne ligne
```

### 1.2 Impact de performance

| Nombre de lignes | Seq Scan (sans index) | Index Scan (avec B-tree) | Acceleration |
|---|---|---|---|
| 1 000 | ~1 ms | ~0.1 ms | x10 |
| 10 000 | ~10 ms | ~0.1 ms | x100 |
| 100 000 | ~100 ms | ~0.1 ms | x1 000 |
| 1 000 000 | ~1 000 ms | ~0.2 ms | x5 000 |
| 10 000 000 | ~10 000 ms | ~0.3 ms | x33 000 |
| 100 000 000 | ~100 000 ms | ~0.4 ms | x250 000 |

> **Ce qu'il faut retenir** : Le Seq Scan est en **O(n)** — lineaire. L'Index Scan avec B-tree est en **O(log n)** — logarithmique. Sur 100 millions de lignes, c'est la difference entre 100 secondes et 0.4 milliseconde. L'index est INDISPENSABLE pour les tables de taille moyenne a grande.

---

## 2. Sans index : le Seq Scan

### 2.1 Comment fonctionne un Seq Scan

```
 Seq Scan (Sequential Scan) :

 Table "employe" sur disque (pages de 8 Ko) :

 ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
 │ Page 0   │  │ Page 1   │  │ Page 2   │  │ Page 3   │ ...
 │ ligne 1  │  │ ligne 51 │  │ ligne 101│  │ ligne 151│
 │ ligne 2  │  │ ligne 52 │  │ ligne 102│  │ ligne 152│
 │ ...      │  │ ...      │  │ ...      │  │ ...      │
 │ ligne 50 │  │ ligne 100│  │ ligne 150│  │ ligne 200│
 └──────────┘  └──────────┘  └──────────┘  └──────────┘
      ▲              ▲              ▲              ▲
      │              │              │              │
      └──────────────┴──────────────┴──────────────┘
             Lire TOUTES les pages, une par une
             Pour chaque ligne : verifier WHERE
```

### 2.2 Quand le Seq Scan est-il optimal ?

Le Seq Scan n'est pas toujours mauvais. Il est optimal quand :

| Situation | Pourquoi Seq Scan est mieux |
|---|---|
| **Petite table** (< 1000 lignes) | L'overhead de l'index (navigation dans l'arbre) coute plus cher que lire toute la petite table |
| **Grande proportion des lignes** (> 5-10%) | Si tu lis 30% de la table, l'acces aleatoire via l'index est plus lent que la lecture sequentielle |
| **Pas de clause WHERE** | `SELECT * FROM table` doit lire tout → Seq Scan est le seul choix |
| **Pas d'index disponible** | Aucun index ne couvre la colonne filtree |

> **Piege classique** : Ne cree pas un index sur une colonne `boolean` avec seulement 2 valeurs distinctes. Si 50% des lignes ont `true` et 50% `false`, PostgreSQL preferera un Seq Scan de toute facon. L'index est utile quand la **selectivite** est elevee (peu de lignes correspondent).

---

## 3. Le B-tree en profondeur

Le B-tree (Balanced Tree) est le type d'index par **defaut** et le plus courant dans PostgreSQL.

### 3.1 Structure arborescente

```
 B-tree pour la colonne "id" (valeurs 1 a 1000) :

                    ┌─────────────────────┐
                    │     Root Page       │
                    │  [250] [500] [750]  │
                    └──┬──────┬──────┬──┬─┘
                       │      │      │  │
          ┌────────────┘      │      │  └──────────────┐
          ▼                   ▼      ▼                  ▼
 ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
 │ Internal     │  │ Internal     │  │ Internal     │  │ Internal     │
 │ [50][100]    │  │ [300][400]   │  │ [550][650]   │  │ [800][900]   │
 │ [150][200]   │  │ [350][450]   │  │ [600][700]   │  │ [850][950]   │
 └──┬─┬─┬──────┘  └──┬─┬─┬──────┘  └──────────────┘  └──────────────┘
    │ │ │              │ │ │
    ▼ ▼ ▼              ▼ ▼ ▼
 ┌────────┐         ┌────────┐
 │ Leaf   │ ◀─────▶ │ Leaf   │ ◀─────▶ ...
 │ 1,2,3  │         │ 51,52  │
 │ ...,50 │         │ ..100  │
 │ →heap  │         │ →heap  │   → pointeur vers la ligne dans la table
 └────────┘         └────────┘

 Les feuilles sont LIEES entre elles (doubly linked list)
 → permet les range scans efficaces (ORDER BY, BETWEEN)
```

### 3.2 Comment la recherche fonctionne

Rechercher `id = 742` dans un B-tree :

```
 Recherche de id = 742 :

 Etape 1 : Root Page → 742 est entre 500 et 750
            → suivre le pointeur vers la 3e branche
 Etape 2 : Internal Page → 742 est entre 700 et 750
            → suivre le pointeur vers la page feuille
 Etape 3 : Leaf Page → trouver 742, lire le TID (tuple ID)
 Etape 4 : Acceder directement a la ligne dans la table (heap)

 Total : 3-4 lectures de pages au lieu de 1000+

 Complexite : O(log n)
 Pour 1 000 000 de lignes :  log2(1 000 000) ≈ 20 niveaux max
 → seulement ~4 niveaux en pratique (pages larges)
```

### 3.3 Range Scan (parcours de plage)

L'un des avantages majeurs du B-tree : les feuilles sont liees entre elles, permettant un parcours sequentiel pour les **plages de valeurs**.

```sql
-- Range scan : chercher les employes avec id entre 100 et 200
SELECT * FROM employe WHERE id BETWEEN 100 AND 200;

-- Le B-tree :
-- 1. Descend jusqu'a la feuille contenant 100
-- 2. Parcourt les feuilles de gauche a droite (linked list)
-- 3. S'arrete quand il depasse 200
-- → Tres efficace, pas besoin de remonter dans l'arbre
```

```
 Range Scan : id BETWEEN 100 AND 200

 Feuilles du B-tree :
 ... ◀─▶ [80-99] ◀─▶ [100-120] ◀─▶ [121-150] ◀─▶ [151-180] ◀─▶ [181-210] ◀─▶ ...
                       ▲ DEBUT                                      ▲ FIN
                       └──────── parcourir ces 4 feuilles ──────────┘
```

### 3.4 Insertion et reequilibrage

```
 Insertion dans un B-tree :

 1. Descendre dans l'arbre pour trouver la bonne feuille
 2. Inserer la valeur dans la feuille

 Si la feuille est pleine → "Page Split" :
 ┌──────────────────┐         ┌──────────┐   ┌──────────┐
 │ [1,2,3,4,5,6,7]  │   →    │ [1,2,3,4]│   │ [5,6,7]  │
 │   (PLEINE)       │         └──────────┘   └──────────┘
 └──────────────────┘         + ajouter "5" dans le parent

 Le reequilibrage se propage vers le haut si necessaire
 → L'arbre reste TOUJOURS equilibre (meme profondeur partout)
```

### 3.5 Operations supportees par le B-tree

| Operation | Supportee ? | Exemple |
|---|---|---|
| Egalite (`=`) | Oui | `WHERE id = 42` |
| Plage (`<`, `>`, `BETWEEN`) | Oui | `WHERE prix BETWEEN 10 AND 50` |
| `IN` | Oui | `WHERE id IN (1, 5, 9)` |
| `IS NULL` / `IS NOT NULL` | Oui | `WHERE email IS NOT NULL` |
| `LIKE 'prefix%'` | Oui (prefix) | `WHERE nom LIKE 'Dup%'` |
| `LIKE '%suffix'` | **Non** | Necessite un index trigram (pg_trgm) |
| `ORDER BY` | Oui | `ORDER BY nom` (evite le tri) |
| `MIN()` / `MAX()` | Oui | Acces direct a la premiere/derniere feuille |

---

## 4. CREATE INDEX — syntaxe et options

### 4.1 Syntaxe de base

```sql
-- Index simple
CREATE INDEX idx_employe_email ON employe(email);

-- Index avec nom explicite (recommande)
CREATE INDEX idx_employe_nom ON employe(nom);

-- Index si n'existe pas deja
CREATE INDEX IF NOT EXISTS idx_employe_email ON employe(email);

-- Index CONCURRENTLY (ne bloque pas les ecritures pendant la creation)
CREATE INDEX CONCURRENTLY idx_produit_prix ON produit(prix);
-- ATTENTION : plus lent, ne peut pas etre dans une transaction

-- Supprimer un index
DROP INDEX idx_employe_nom;
DROP INDEX IF EXISTS idx_employe_nom;
DROP INDEX CONCURRENTLY idx_employe_nom;
```

### 4.2 Conventions de nommage

| Convention | Exemple | Description |
|---|---|---|
| `idx_table_colonne` | `idx_employe_email` | Standard, simple |
| `idx_table_col1_col2` | `idx_cmd_client_date` | Index multi-colonnes |
| `idx_table_colonne_partial` | `idx_employe_actif_partial` | Index partiel |
| `idx_table_colonne_unique` | `idx_employe_email_unique` | Index unique |

### 4.3 CONCURRENTLY : creer un index sans bloquer

```sql
-- CREATE INDEX normal : bloque les INSERT/UPDATE/DELETE pendant la creation
CREATE INDEX idx_gros ON grosse_table(colonne);
-- Les ecritures sont bloquees pendant plusieurs minutes/heures sur une grosse table

-- CREATE INDEX CONCURRENTLY : ne bloque PAS les ecritures
CREATE INDEX CONCURRENTLY idx_gros ON grosse_table(colonne);
-- Plus lent (2 passes), mais les ecritures continuent normalement
```

> **Ce qu'il faut retenir** : En production, utilise **toujours** `CREATE INDEX CONCURRENTLY` sur les tables qui recoivent du trafic. Un `CREATE INDEX` normal pose un verrou `ShareLock` qui bloque toutes les ecritures.

| Aspect | `CREATE INDEX` | `CREATE INDEX CONCURRENTLY` |
|---|---|---|
| **Bloque les ecritures** | Oui | Non |
| **Vitesse** | Plus rapide | Plus lent (~2x) |
| **Transactionnel** | Oui (dans un BEGIN) | Non (pas dans un BEGIN) |
| **Risque d'echec** | Faible | Peut echouer (index invalide) |
| **Usage** | Dev, maintenance planifiee | **Production** |

---

## 5. Index multi-colonnes (composite)

### 5.1 Principe

Un index composite couvre **plusieurs colonnes** et est particulierement utile pour les requetes qui filtrent sur une combinaison de colonnes.

```sql
-- Index sur (departement_id, nom)
CREATE INDEX idx_employe_dep_nom ON employe(departement_id, nom);
```

### 5.2 L'ordre des colonnes : pourquoi ca compte

> **Analogie** : Un annuaire telephonique est trie par nom de famille, PUIS par prenom. Tu peux chercher "Dupont" facilement. Tu peux chercher "Dupont, Alice" encore plus facilement. Mais chercher "Alice" (juste le prenom) ne t'aide pas — l'annuaire n'est pas trie par prenom.

C'est la **Leftmost Prefix Rule** : l'index composite `(A, B, C)` peut etre utilise pour :

| Requete | Utilise l'index ? | Raison |
|---|---|---|
| `WHERE A = 1` | Oui | Prefixe gauche (A) |
| `WHERE A = 1 AND B = 2` | Oui | Prefixe gauche (A, B) |
| `WHERE A = 1 AND B = 2 AND C = 3` | Oui | Index complet (A, B, C) |
| `WHERE B = 2` | **Non** | B n'est pas le prefixe gauche |
| `WHERE C = 3` | **Non** | C n'est pas le prefixe gauche |
| `WHERE B = 2 AND C = 3` | **Non** | Commence par B, pas par A |
| `WHERE A = 1 AND C = 3` | Partiellement | Utilise A, puis scan pour C |

```sql
-- Demonstrer avec EXPLAIN
CREATE INDEX idx_emp_dep_nom_sal ON employe(departement_id, nom, salaire);

-- Utilise l'index (prefixe complet)
EXPLAIN SELECT * FROM employe
WHERE departement_id = 1 AND nom = 'Dupont';
-- Index Scan using idx_emp_dep_nom_sal

-- Utilise l'index (prefixe partiel)
EXPLAIN SELECT * FROM employe
WHERE departement_id = 1;
-- Index Scan using idx_emp_dep_nom_sal

-- N'utilise PAS l'index (pas le prefixe)
EXPLAIN SELECT * FROM employe
WHERE nom = 'Dupont';
-- Seq Scan (ou utilise un autre index s'il existe)
```

### 5.3 Regle pour choisir l'ordre des colonnes

```
 Regle de base pour l'ordre des colonnes :

 1. Colonnes avec EGALITE en premier (=)
 2. Colonnes avec PLAGE ensuite (<, >, BETWEEN)
 3. Colonnes pour le TRI en dernier (ORDER BY)

 Exemple de requete :
 SELECT * FROM commande
 WHERE statut = 'en_attente'        -- egalite
   AND date >= '2024-01-01'         -- plage
 ORDER BY date;                     -- tri

 Index optimal :
 CREATE INDEX idx_cmd_statut_date ON commande(statut, date);
           egalite ──▲     ▲── plage + tri
```

---

## 6. Index UNIQUE

### 6.1 Principe

Un index unique combine la fonction d'acceleration des recherches avec la **garantie d'unicite**.

```sql
-- Creer un index unique
CREATE UNIQUE INDEX idx_employe_email_unique ON employe(email);

-- Equivalent a la contrainte UNIQUE dans CREATE TABLE
-- En fait, PostgreSQL cree un index unique quand tu definis UNIQUE :
ALTER TABLE employe ADD CONSTRAINT employe_email_unique UNIQUE (email);
-- → cree automatiquement un index unique en arriere-plan

-- Verifier
\d employe
-- Indexes:
--   "employe_email_unique" UNIQUE, btree (email)
```

### 6.2 Index unique multi-colonnes

```sql
-- Unicite sur une combinaison de colonnes
CREATE UNIQUE INDEX idx_reservation_unique
ON reservation(salle, date, heure);

-- Cela signifie : pas deux reservations pour la meme salle + date + heure
-- Mais la meme salle peut etre reservee a des heures differentes
```

---

## 7. Hash index

### 7.1 Principe

Le Hash index utilise une **fonction de hachage** pour calculer directement la position d'une valeur. C'est un acces en **O(1)** theorique.

```
 Hash Index :

 hash('alice@test.com') = 42  → bucket 42 → TID (0, 5)
 hash('bob@test.com')   = 17  → bucket 17 → TID (0, 8)
 hash('claire@test.com')= 42  → bucket 42 → TID (1, 2) (collision)

 ┌───────────────────────────┐
 │  Bucket 0  → (vide)      │
 │  Bucket 1  → TID (3, 1)  │
 │  ...                      │
 │  Bucket 17 → TID (0, 8)  │
 │  ...                      │
 │  Bucket 42 → TID (0, 5)  │
 │             → TID (1, 2)  │  (collision : chain)
 │  ...                      │
 └───────────────────────────┘
```

### 7.2 Quand utiliser un Hash index

```sql
-- Creer un hash index
CREATE INDEX idx_session_token_hash ON session USING HASH (token);
```

| Aspect | B-tree | Hash |
|---|---|---|
| **Egalite** (`=`) | Oui | **Oui (optimise)** |
| **Plage** (`<`, `>`, `BETWEEN`) | **Oui** | Non |
| **ORDER BY** | **Oui** | Non |
| **IS NULL** | **Oui** | Non (avant PG10) |
| **Multi-colonnes** | **Oui** | Non |
| **Taille** | Plus grand | **Plus petit** |
| **WAL-logged** (depuis PG10) | Oui | Oui |
| **Cas d'usage** | Polyvalent | **Egalite uniquement** sur de longues chaines |

> **Ce qu'il faut retenir** : Le Hash index est utile quand tu fais **exclusivement** des recherches par egalite (`=`) sur des valeurs longues (tokens, hash, URLs). Dans la plupart des cas, le B-tree est un meilleur choix car il supporte aussi les plages et le tri.

---

## 8. Expression indexes (index sur fonction)

### 8.1 Principe

Un **expression index** indexe le resultat d'une **expression** ou d'une **fonction**, pas directement la valeur de la colonne.

```sql
-- Probleme : recherche insensible a la casse
SELECT * FROM employe WHERE email = 'Alice@Example.Com';
-- L'index sur email ne match pas (casse differente)

SELECT * FROM employe WHERE LOWER(email) = 'alice@example.com';
-- L'index sur email ne peut PAS etre utilise car la requete utilise LOWER(email)

-- Solution : index sur l'expression LOWER(email)
CREATE INDEX idx_employe_email_lower ON employe(LOWER(email));

-- Maintenant cette requete utilise l'index
SELECT * FROM employe WHERE LOWER(email) = 'alice@example.com';
-- Index Scan using idx_employe_email_lower
```

### 8.2 Exemples courants

```sql
-- Index sur l'annee d'une date
CREATE INDEX idx_commande_annee ON commande(EXTRACT(YEAR FROM date_commande));

SELECT * FROM commande WHERE EXTRACT(YEAR FROM date_commande) = 2024;
-- Utilise l'index

-- Index sur la longueur d'un texte
CREATE INDEX idx_article_longueur ON article(LENGTH(contenu));

SELECT * FROM article WHERE LENGTH(contenu) > 5000;
-- Utilise l'index

-- Index sur une extraction JSONB
CREATE INDEX idx_event_page ON evenement((data->>'page'));

SELECT * FROM evenement WHERE data->>'page' = '/accueil';
-- Utilise l'index

-- Index sur une colonne calculee (nom complet)
CREATE INDEX idx_employe_nom_complet ON employe((prenom || ' ' || nom));

SELECT * FROM employe WHERE prenom || ' ' || nom = 'Alice Dupont';
-- Utilise l'index
```

> **Piege classique** : L'expression dans la requete doit correspondre **exactement** a l'expression de l'index. Si l'index est sur `LOWER(email)`, la requete `WHERE lower(email) = ...` utilise l'index, mais `WHERE UPPER(email) = ...` ne l'utilise **pas**.

---

## 9. Partial indexes (index partiels)

### 9.1 Principe

Un **index partiel** n'indexe qu'un **sous-ensemble** des lignes de la table, celles qui satisfont une condition `WHERE`.

> **Analogie** : Au lieu d'indexer tous les livres de la bibliotheque, tu ne fais un index que pour les livres "empruntes en ce moment". Beaucoup plus petit, beaucoup plus rapide.

```sql
-- Index seulement sur les employes actifs
CREATE INDEX idx_employe_actif ON employe(nom, email)
WHERE est_actif = true;

-- Cet index est utilise quand la requete inclut la meme condition
SELECT nom, email FROM employe
WHERE est_actif = true AND nom LIKE 'D%';
-- Index Scan using idx_employe_actif

-- Cet index n'est PAS utilise si la condition est differente
SELECT nom, email FROM employe
WHERE est_actif = false AND nom LIKE 'D%';
-- Seq Scan (ou autre index)
```

### 9.2 Cas d'usage classiques

```sql
-- Index sur les commandes non traitees (generalement << 5% du total)
CREATE INDEX idx_commande_en_attente ON commande(date_commande)
WHERE statut = 'en_attente';

-- Index sur les lignes non supprimees (soft delete)
CREATE INDEX idx_utilisateur_non_supprime ON utilisateur(email)
WHERE supprime_le IS NULL;

-- Index unique partiel (unicite conditionnelle)
CREATE UNIQUE INDEX idx_email_unique_actif ON employe(email)
WHERE est_actif = true;
-- Permet plusieurs employes inactifs avec le meme email
-- Mais un seul employe actif par email
```

### 9.3 Avantages des index partiels

| Avantage | Description |
|---|---|
| **Taille reduite** | L'index ne contient qu'un sous-ensemble des lignes |
| **Maintenance rapide** | Moins de lignes a mettre a jour lors des INSERT/UPDATE |
| **Cache efficace** | L'index tient mieux en memoire (shared buffers) |
| **Unicite conditionnelle** | Contrainte UNIQUE sur un sous-ensemble |

```sql
-- Comparer la taille
CREATE INDEX idx_complet ON commande(date_commande);
CREATE INDEX idx_partiel ON commande(date_commande) WHERE statut = 'en_attente';

SELECT
    indexrelname AS index,
    pg_size_pretty(pg_relation_size(indexrelid)) AS taille
FROM pg_stat_user_indexes
WHERE relname = 'commande';

-- idx_complet : 214 MB
-- idx_partiel : 2 MB   (100x plus petit !)
```

---

## 10. Le cout des index

### 10.1 Espace disque

Chaque index est une **structure supplementaire** stockee sur disque, en plus de la table elle-meme.

```sql
-- Voir la taille des tables et des index
SELECT
    relname AS nom,
    relkind AS type,  -- 'r' = table, 'i' = index
    pg_size_pretty(pg_relation_size(oid)) AS taille
FROM pg_class
WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
ORDER BY pg_relation_size(oid) DESC;

-- Resume par table
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS total,
    pg_size_pretty(pg_table_size(schemaname || '.' || tablename)) AS table_seule,
    pg_size_pretty(pg_indexes_size(schemaname || '.' || tablename)) AS index_total
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC;
```

### 10.2 Ralentissement des ecritures

Chaque `INSERT`, `UPDATE` ou `DELETE` doit mettre a jour **tous les index** de la table.

```
 Impact des index sur les ecritures :

 INSERT INTO employe (nom, email, salaire) VALUES (...);

 Sans index :
 1. Ecrire la ligne dans la table         ← 1 operation

 Avec 5 index :
 1. Ecrire la ligne dans la table         ← 1 operation
 2. Inserer dans idx_employe_email        ← +1 operation
 3. Inserer dans idx_employe_nom          ← +1 operation
 4. Inserer dans idx_employe_salaire      ← +1 operation
 5. Inserer dans idx_employe_dep_id       ← +1 operation
 6. Inserer dans idx_employe_cree_le      ← +1 operation
                                          = 6 operations au total
```

### 10.3 HOT updates et quand un index les empeche

PostgreSQL a une optimisation appelee **HOT** (Heap-Only Tuple) qui accelere les UPDATE en evitant de mettre a jour les index si les colonnes indexees n'ont pas change.

```sql
-- Sans index sur 'salaire' : HOT update possible
UPDATE employe SET salaire = 50000 WHERE id = 1;
-- → seule la table est modifiee, pas les index

-- Avec un index sur 'salaire' : HOT update IMPOSSIBLE
CREATE INDEX idx_employe_salaire ON employe(salaire);
UPDATE employe SET salaire = 50000 WHERE id = 1;
-- → la table ET l'index doivent etre mis a jour
```

> **Ce qu'il faut retenir** : Chaque index supplementaire ralentit les ecritures. Sur une table a forte volumetrie d'insertion (logs, evenements, IoT), le nombre d'index doit etre minimise. Cree un index seulement si les requetes de lecture le necessitent.

### 10.4 Cout des index — resume

| Cout | Description |
|---|---|
| **Espace disque** | Chaque index occupe de l'espace (~50-100% de la taille de la table pour un B-tree) |
| **Ralentissement INSERT** | Chaque index ajoute une ecriture supplementaire |
| **Ralentissement UPDATE** | Si la colonne indexee change, l'index doit etre mis a jour |
| **Ralentissement DELETE** | Les entrees d'index doivent etre marquees comme supprimees |
| **Maintenance** | VACUUM doit nettoyer les index en plus de la table |
| **Temps de creation** | Creer un index sur une grande table prend du temps et des ressources |

---

## 11. Visibility Map et Index Only Scan

### 11.1 Le probleme : l'index ne suffit pas toujours

Meme quand un index couvre toutes les colonnes demandees par une requete, PostgreSQL doit parfois **retourner dans la table (heap)** pour verifier que la ligne est visible par la transaction courante. C'est a cause de MVCC : l'index ne stocke pas les informations de visibilite (`xmin`, `xmax`).

### 11.2 La Visibility Map

La **Visibility Map** (VM) est une structure annexe, maintenue pour chaque table, qui indique quelles **pages sont "all-visible"** : toutes les lignes de la page sont visibles par toutes les transactions en cours.

```
 Visibility Map pour la table "employe" :

 Page 0 : ✓ all-visible    (toutes les lignes sont visibles)
 Page 1 : ✓ all-visible
 Page 2 : ✗ pas all-visible (un UPDATE recent a cree des tuples morts)
 Page 3 : ✓ all-visible
 Page 4 : ✗ pas all-visible
 ...

 1 bit par page → tres compact (ex: 1 Mo pour une table de 8 Go)
```

### 11.3 Index Only Scan : le scan ideal

Quand un index couvre toutes les colonnes necessaires **et** que la Visibility Map confirme que la page est all-visible, PostgreSQL peut repondre **uniquement a partir de l'index**, sans lire la table. C'est l'**Index Only Scan**.

```
 Index Only Scan — parcours :

 ┌─────────────┐     ┌───────────────────┐
 │  Index      │     │  Visibility Map   │
 │  B-tree     │     │  Page 0: ✓        │
 │  (colonne)  │────▶│  Page 1: ✓        │
 │             │     │  Page 2: ✗        │
 └─────────────┘     └───────────────────┘
       │                      │
       │  Page all-visible ?  │
       │                      │
       ├── Oui → reponse directe depuis l'index (rapide)
       │
       └── Non → lire la page dans le heap pour verifier la visibilite
```

```sql
-- Exemple : Index Only Scan avec un index couvrant
CREATE INDEX idx_employe_dept_sal ON employe(departement_id, salaire);

-- Cette requete ne demande que des colonnes presentes dans l'index
EXPLAIN SELECT departement_id, salaire FROM employe
WHERE departement_id = 1;
-- Index Only Scan using idx_employe_dept_sal on employe
-- Heap Fetches: 0   ← aucun acces au heap si toutes les pages sont all-visible
```

### 11.4 Impact de VACUUM sur la Visibility Map

C'est **VACUUM** qui met a jour la Visibility Map. Apres un VACUUM, les pages dont les tuples morts ont ete nettoyes sont marquees "all-visible". Sans VACUUM regulier, la VM est incomplète et les Index Only Scans tombent dans le cas lent (Heap Fetches).

| Situation | Heap Fetches | Performance |
|---|---|---|
| VACUUM frequent (autovacuum OK) | Proches de 0 | Index Only Scan rapide |
| VACUUM rare / table tres active | Eleves | Index Only Scan degrade |
| Table en lecture seule | 0 | Index Only Scan optimal |

> **Ce qu'il faut retenir** : Pour beneficier pleinement des Index Only Scans, il faut (1) un index couvrant toutes les colonnes de la requete, et (2) un VACUUM regulier pour que la Visibility Map soit a jour. Surveille la colonne `Heap Fetches` dans le plan `EXPLAIN ANALYZE` : si elle est elevee, c'est que VACUUM doit passer.

---

## 12. Quand ne PAS creer un index

| Situation | Raison |
|---|---|
| **Table tres petite** (< 1000 lignes) | Seq Scan est deja tres rapide |
| **Colonne rarement filtree** | L'index est maintenu en ecriture mais jamais utilise en lecture |
| **Faible selectivite** (ex: boolean) | Peu de valeurs distinctes → le planner prefere le Seq Scan |
| **Table a tres forte insertion** | Chaque index ralentit les INSERT |
| **Colonne souvent modifiee** | Chaque UPDATE sur la colonne modifie aussi l'index |
| **Index redondant** | `(A, B)` rend `(A)` redondant car le composite couvre deja `A` seul |

---

## 13. Node.js : creer et verifier des index

```typescript
// fichier : index-management.mjs
// Creer et verifier des index depuis Node.js

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'cours',
  user: 'postgres',
  password: 'postgres',
});

// Creer des index
async function creerIndex() {
  // Index simples
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_employe_email ON employe(email)'
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_employe_dep_id ON employe(departement_id)'
  );

  // Index composite
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_employe_dep_nom ON employe(departement_id, nom)'
  );

  // Index partiel
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_employe_actif_nom
    ON employe(nom)
    WHERE est_actif = true
  `);

  // Expression index
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_employe_email_lower ON employe(LOWER(email))'
  );

  console.log('Index crees avec succes.');
}

// Lister les index d'une table
async function listerIndex(nomTable) {
  const { rows } = await pool.query(`
    SELECT
      i.relname AS nom_index,
      am.amname AS type,
      pg_size_pretty(pg_relation_size(i.oid)) AS taille,
      idx.indisunique AS est_unique,
      idx.indisvalid AS est_valide,
      pg_get_indexdef(idx.indexrelid) AS definition
    FROM pg_index idx
    JOIN pg_class i ON i.oid = idx.indexrelid
    JOIN pg_class t ON t.oid = idx.indrelid
    JOIN pg_am am ON am.oid = i.relam
    WHERE t.relname = $1
    ORDER BY i.relname
  `, [nomTable]);

  console.log(`\nIndex de la table "${nomTable}" :`);
  for (const idx of rows) {
    console.log(`  ${idx.nom_index}`);
    console.log(`    Type: ${idx.type}, Taille: ${idx.taille}, Unique: ${idx.est_unique}`);
    console.log(`    Definition: ${idx.definition}`);
    console.log();
  }
}

// Verifier l'utilisation des index
async function verifierUtilisation() {
  const { rows } = await pool.query(`
    SELECT
      schemaname,
      relname AS table_name,
      indexrelname AS index_name,
      idx_scan AS nb_utilisations,
      idx_tup_read AS tuples_lus,
      idx_tup_fetch AS tuples_retournes,
      pg_size_pretty(pg_relation_size(indexrelid)) AS taille
    FROM pg_stat_user_indexes
    ORDER BY idx_scan DESC
  `);

  console.log('\nUtilisation des index :');
  console.log('─'.repeat(80));
  for (const r of rows) {
    const usage = r.nb_utilisations > 0 ? 'UTILISE' : 'INUTILISE';
    console.log(
      `  [${usage}] ${r.index_name} (${r.table_name}) — ` +
      `${r.nb_utilisations} scans, ${r.taille}`
    );
  }
}

async function main() {
  try {
    await creerIndex();
    await listerIndex('employe');
    await verifierUtilisation();
  } finally {
    await pool.end();
  }
}

main();
```

---

## 14. pg_stat_user_indexes : surveiller l'utilisation

### 14.1 Trouver les index inutilises

```sql
-- Index qui n'ont JAMAIS ete utilises depuis le dernier reset des stats
SELECT
    schemaname || '.' || relname AS table,
    indexrelname AS index,
    idx_scan AS nb_scans,
    pg_size_pretty(pg_relation_size(indexrelid)) AS taille
FROM pg_stat_user_indexes
WHERE idx_scan = 0
  AND indexrelname NOT LIKE '%pkey'  -- exclure les PK (toujours utiles)
  AND indexrelname NOT LIKE '%unique%'  -- exclure les contraintes UNIQUE
ORDER BY pg_relation_size(indexrelid) DESC;
```

### 14.2 Trouver les tables sans index (qui pourraient en avoir besoin)

```sql
-- Tables avec beaucoup de Seq Scan et pas d'Index Scan
SELECT
    schemaname,
    relname AS table,
    seq_scan,
    seq_tup_read,
    idx_scan,
    n_live_tup AS nb_lignes
FROM pg_stat_user_tables
WHERE seq_scan > 100         -- beaucoup de Seq Scan
  AND idx_scan < seq_scan    -- moins d'Index Scan que de Seq Scan
  AND n_live_tup > 10000     -- table de taille significative
ORDER BY seq_scan DESC;
```

### 14.3 Verifier les index dupliques

```sql
-- Trouver les index redondants (meme prefixe de colonnes)
SELECT
    a.indexrelid::regclass AS index_redondant,
    b.indexrelid::regclass AS index_couvrant,
    pg_size_pretty(pg_relation_size(a.indexrelid)) AS taille_redondante
FROM pg_index a
JOIN pg_index b ON a.indrelid = b.indrelid
    AND a.indexrelid <> b.indexrelid
    AND a.indkey::text = ANY(
        SELECT string_to_array(b.indkey::text, ' ')::text[]
    )
WHERE a.indkey <> b.indkey
ORDER BY pg_relation_size(a.indexrelid) DESC;
```

---

## 15. Exercice mental

1. **Tu as un index sur `(ville, nom)`. La requete `WHERE nom = 'Dupont'` utilise-t-elle l'index ?** (Non — la leftmost prefix rule impose de commencer par `ville`)

2. **Tu as 1 million de lignes dont 999 000 avec `actif = true` et 1 000 avec `actif = false`. Quel index est le plus utile ?** (Un index partiel `WHERE actif = false` : petit et tres selectif)

3. **Tu as 20 index sur une table. Chaque INSERT est lent. Que faire ?** (Auditer les index inutilises avec `pg_stat_user_indexes`, supprimer les redondants et inutilises)

---

## Navigation

| | Lien |
|---|---|
| Module precedent | [Module 04 — Transactions & ACID](./04-transactions-et-acid.md) |
| Module suivant | [Module 06 — Le Query Planner](./06-query-planner.md) |
| Lab associe | [Lab 05 — Creer et optimiser des index](../labs/lab-05.md) |

---

> **Ce qu'il faut retenir** : Les index sont essentiels pour les performances en lecture (de O(n) a O(log n) avec le B-tree). L'ordre des colonnes dans un index composite suit la leftmost prefix rule. Les index partiels et d'expression offrent des optimisations ciblees. Mais chaque index a un cout en ecriture et en espace. Surveille l'utilisation avec `pg_stat_user_indexes` et supprime les index inutilises.
