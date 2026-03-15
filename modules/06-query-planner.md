# Module 06 — Le Query Planner

> **Objectif** : Comprendre comment PostgreSQL choisit le plan d'exécution optimal, maîtriser `EXPLAIN` et `EXPLAIN ANALYZE`, identifier les différents types de scans et stratégies de jointure, et savoir optimiser une requête lente.
>
> **Difficulte** : ⭐⭐⭐ (avance)

---

## 1. Qu'est-ce que le query planner (optimizer)

### 1.1 Le role du planner

Le **query planner** (où optimizer) est le composant de PostgreSQL qui decide **comment** exécuter ta requête SQL. Tu ecris du SQL declaratif (ce que tu veux), et le planner déterminé le chemin le plus rapide pour obtenir le résultat.

> **Analogie** : Le query planner est un **GPS**. Tu lui donnes ta destination (la requête SQL), et il calcule le meilleur itineraire en tenant compte de la carte routiere (les tables et index), du trafic (les statistiques), et des regles de circulation (les contraintes). Plusieurs itineraires sont possibles — le GPS choisit le plus rapide.

```
 Le pipeline d'une requete SQL :

 1. Parser     → Arbre syntaxique (est-ce du SQL valide ?)
 2. Analyzer   → Resolution des noms (tables et colonnes existent-elles ?)
 3. Rewriter   → Application des regles (vues, RLS)
 4. Planner    → Choix du plan optimal ←── CE MODULE
 5. Executor   → Execution du plan et renvoi des resultats
```

### 1.2 Comment le planner choisit

Pour chaque requête, le planner :

1. **Enumere** les plans possibles (combinaisons de scans, joins, tris)
2. **Estime** le cout de chaque plan (en unites abstraites)
3. **Choisit** le plan avec le cout le plus bas

```
 Exemple : SELECT * FROM employe WHERE departement_id = 3

 Plan A : Seq Scan
   → Lire toutes les lignes, filtrer departement_id = 3
   → Cout estime : 1000 (toute la table)

 Plan B : Index Scan (si index sur departement_id)
   → Naviguer dans l'index, lire les lignes correspondantes
   → Cout estime : 15 (quelques pages d'index + quelques pages de table)

 Plan C : Bitmap Index Scan + Bitmap Heap Scan
   → Construire un bitmap des pages concernees via l'index
   → Lire ces pages dans l'ordre
   → Cout estime : 25

 Planner choisit → Plan B (cout le plus bas)
```

---

## 2. EXPLAIN — lire un plan d'exécution

### 2.1 Syntaxe de base

```sql
-- Afficher le plan SANS executer la requete
EXPLAIN SELECT * FROM employe WHERE departement_id = 3;
```

Sortie typique :

```
                                    QUERY PLAN
 ──────────────────────────────────────────────────────────────────────
 Index Scan using idx_employe_dep on employe  (cost=0.29..8.30 rows=5 width=72)
   Index Cond: (departement_id = 3)
```

### 2.2 Decoder les couts

```
 cost=0.29..8.30 rows=5 width=72
 │         │       │       │
 │         │       │       └── Largeur estimee d'une ligne en octets
 │         │       └── Nombre estime de lignes retournees
 │         └── Cout total pour obtenir TOUTES les lignes
 └── Cout de demarrage (startup cost) avant la premiere ligne
```

| Champ | Signification |
|---|---|
| **startup_cost** | Cout avant de pouvoir retourner la première ligne (ex: un Sort doit d'abord trier tout) |
| **total_cost** | Cout total pour retourner toutes les lignes |
| **rows** | Estimation du nombre de lignes retournees |
| **width** | Taille estimee d'une ligne en octets |

> **Ce qu'il faut retenir** : Les couts sont des **unites abstraites**, pas des millisecondes. Un cout de 100 ne signifie pas "100 ms". Les couts sont relatifs entre eux : un plan a cout 50 est deux fois "moins cher" qu'un plan a cout 100 (selon les estimations du planner).

### 2.3 Formats de sortie

```sql
-- Format texte (par defaut)
EXPLAIN SELECT * FROM employe;

-- Format JSON (utile pour le parsing programmatique)
EXPLAIN (FORMAT JSON) SELECT * FROM employe;

-- Format YAML
EXPLAIN (FORMAT YAML) SELECT * FROM employe;

-- Format XML
EXPLAIN (FORMAT XML) SELECT * FROM employe;
```

```json
// Sortie JSON (plus facile a analyser)
[
  {
    "Plan": {
      "Node Type": "Seq Scan",
      "Relation Name": "employe",
      "Alias": "employe",
      "Startup Cost": 0.00,
      "Total Cost": 25.00,
      "Plan Rows": 1000,
      "Plan Width": 72
    }
  }
]
```

---

## 3. EXPLAIN ANALYZE — mesurer le temps réel

### 3.1 Différence avec EXPLAIN simple

| | EXPLAIN | EXPLAIN ANALYZE |
|---|---|---|
| **Execute la requête** | Non | **Oui** |
| **Couts** | Estimes | Estimes + **réels** |
| **Temps** | Non | **Oui** (actual time) |
| **Lignes** | Estimees | Estimees + **reelles** |
| **Modifie les donnees** | Non | **Oui** (INSERT, UPDATE, DELETE) |

> **Piege classique** : `EXPLAIN ANALYZE` sur un `DELETE FROM grande_table` va **réellement supprimer** les donnees ! Pour tester un DELETE/UPDATE sans impact, enveloppe dans une transaction :

```sql
BEGIN;
EXPLAIN ANALYZE DELETE FROM commande WHERE date < '2020-01-01';
ROLLBACK;  -- les donnees ne sont pas reellement supprimees
```

### 3.2 Lire la sortie d'EXPLAIN ANALYZE

```sql
EXPLAIN ANALYZE SELECT * FROM employe WHERE departement_id = 3;
```

```
 Index Scan using idx_employe_dep on employe
   (cost=0.29..8.30 rows=5 width=72)
   (actual time=0.025..0.031 rows=7 loops=1)
   Index Cond: (departement_id = 3)
 Planning Time: 0.152 ms
 Execution Time: 0.058 ms
```

```
 Decoder la sortie :

 cost=0.29..8.30          → couts ESTIMES par le planner
 rows=5                   → nombre de lignes ESTIMEES
 actual time=0.025..0.031 → temps REEL (ms) : startup..total
 rows=7                   → nombre de lignes REELLES
 loops=1                  → nombre de fois que ce noeud a ete execute

 Planning Time: 0.152 ms  → temps de planification
 Execution Time: 0.058 ms → temps d'execution total
```

### 3.3 Comparaison estimations vs realite

| Metrique | Estime | Reel | Commentaire |
|---|---|---|---|
| **rows** | 5 | 7 | Différence acceptable (~40%) |
| **time** | — | 0.031 ms | Très rapide |

> **Ce qu'il faut retenir** : Si les estimations sont très différentes de la realite (ex: estime 10 lignes, réel 100 000), le planner a fait un **mauvais choix** de plan. La cause est généralement des **statistiques obsoletes**. Lance `ANALYZE nom_table` pour les mettre a jour.

### 3.4 EXPLAIN avec options avancees

```sql
-- BUFFERS : voir les lectures de pages (essentiel pour le diagnostic)
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM employe WHERE departement_id = 3;
```

```
 Index Scan using idx_employe_dep on employe
   (cost=0.29..8.30 rows=5 width=72)
   (actual time=0.025..0.031 rows=7 loops=1)
   Index Cond: (departement_id = 3)
   Buffers: shared hit=4
 Planning Time: 0.152 ms
 Execution Time: 0.058 ms
```

| Buffer | Signification |
|---|---|
| `shared hit=4` | 4 pages lues depuis le cache (shared buffers) — **rapide** |
| `shared read=2` | 2 pages lues depuis le disque — **lent** |
| `shared dirtied=1` | 1 page modifiee en cache |
| `shared written=0` | 0 page ecrite sur disque |

> **Analogie** : `shared hit`, c'est quand tu trouves le livre sur ton bureau (mémoire). `shared read`, c'est quand tu dois aller le chercher dans la reserve (disque). La différence de vitesse est enorme.

```sql
-- Options completes d'EXPLAIN
EXPLAIN (
    ANALYZE,     -- executer la requete
    BUFFERS,     -- afficher les buffers
    COSTS,       -- afficher les couts (defaut: on)
    TIMING,      -- afficher le timing (defaut: on)
    VERBOSE,     -- afficher plus de details
    FORMAT TEXT  -- ou JSON, YAML, XML
) SELECT * FROM employe WHERE departement_id = 3;
```

---

## 4. Types de scans

### 4.1 Seq Scan (Sequential Scan)

Lit **toutes** les pages de la table sequentiellement.

```sql
EXPLAIN SELECT * FROM employe;
-- Seq Scan on employe  (cost=0.00..25.00 rows=1000 width=72)
```

```
 Seq Scan :
 ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐
 │ P0 │→│ P1 │→│ P2 │→│ P3 │→│ P4 │→│ P5 │
 └────┘ └────┘ └────┘ └────┘ └────┘ └────┘
   ▲                                    ▲
   └──── lecture sequentielle ──────────┘
   Rapide car lecture lineaire (pas de "saut" sur disque)
```

**Quand le planner choisit Seq Scan :**
- Pas d'index disponible
- Grande proportion des lignes retournees (> 5-10%)
- Table très petite
- `enable_seqscan = on` (defaut)

### 4.2 Index Scan

Navigue dans l'index pour trouver les TID (Tuple ID), puis lit les lignes correspondantes dans la table (heap).

```sql
EXPLAIN SELECT * FROM employe WHERE id = 42;
-- Index Scan using employe_pkey on employe  (cost=0.29..8.30 rows=1 width=72)
--   Index Cond: (id = 42)
```

```
 Index Scan :

 1. Naviguer dans l'index B-tree
    Root → Internal → Leaf (TID trouvé)

 2. Pour chaque TID : aller chercher la ligne dans la table (heap)
    TID (page=5, offset=3) → lire la page 5, ligne 3

 ┌─────────────┐           ┌─────────────┐
 │   Index     │           │   Table     │
 │   (B-tree)  │  TID      │   (Heap)    │
 │   ───────── │──────────▶│   page 5    │
 │    42 → (5,3)│          │   ligne 3   │
 └─────────────┘           └─────────────┘
```

**Quand le planner choisit Index Scan :**
- Faible nombre de lignes retournees
- Bonne selectivite de la condition WHERE
- Acces aleatoire acceptable (peu de pages a lire)

### 4.3 Index Only Scan

Quand **toutes** les colonnes nécessaires sont dans l'index, pas besoin de lire la table (heap).

```sql
-- Index couvrant : toutes les colonnes sont dans l'index
CREATE INDEX idx_employe_dep_nom ON employe(departement_id, nom);

EXPLAIN SELECT departement_id, nom FROM employe WHERE departement_id = 3;
-- Index Only Scan using idx_employe_dep_nom on employe
--   (cost=0.29..4.30 rows=5 width=36)
--   Index Cond: (departement_id = 3)
```

```
 Index Only Scan :

 ┌─────────────┐
 │   Index     │   Toutes les donnees necessaires
 │   (B-tree)  │   sont DANS l'index
 │             │
 │  dep=3,Alice│───▶ retourne directement
 │  dep=3,Bob  │───▶ retourne directement
 │             │
 │   PAS besoin│   Pas d'acces a la table !
 │   du heap   │   = plus rapide
 └─────────────┘
```

> **Ce qu'il faut retenir** : L'Index Only Scan est le scan le **plus rapide**. Pour en beneficier, toutes les colonnes du SELECT, WHERE et ORDER BY doivent etre dans l'index. C'est le principe des **covering indexes** (voir Module 07).

> **Piege classique** : L'Index Only Scan ne fonctionne correctement que si la **visibility map** de la table est a jour. Si VACUUM n'a pas tourne recemment, PostgreSQL doit quand même vérifier la table pour la visibilite des tuples. Lance `VACUUM` regulierement.

### 4.4 Bitmap Index Scan + Bitmap Heap Scan

Compromis entre Seq Scan et Index Scan, pour un nombre **moyen** de lignes.

```sql
EXPLAIN SELECT * FROM employe WHERE salaire BETWEEN 30000 AND 50000;
-- Bitmap Heap Scan on employe  (cost=12.50..120.30 rows=500 width=72)
--   Recheck Cond: (salaire >= 30000 AND salaire <= 50000)
--   -> Bitmap Index Scan on idx_employe_salaire  (cost=0.00..12.25 rows=500 width=0)
--        Index Cond: (salaire >= 30000 AND salaire <= 50000)
```

```
 Bitmap Index Scan + Bitmap Heap Scan :

 Etape 1 : Bitmap Index Scan
 → Parcourir l'index et construire un BITMAP des pages concernees

 ┌─────────────┐      ┌────────────────────────────────┐
 │   Index     │      │   Bitmap (1 bit par page)      │
 │   (B-tree)  │─────▶│   [1][0][1][1][0][0][1][0]     │
 │             │      │    ▲     ▲  ▲        ▲          │
 │  pages      │      │    page  page page   page       │
 │  contenant  │      │    0     2   3       6          │
 │  les valeurs│      └────────────────────────────────┘
 └─────────────┘

 Etape 2 : Bitmap Heap Scan
 → Lire les pages marquees dans le bitmap (dans l'ordre physique)
 → Recheck la condition car le bitmap est au niveau PAGE, pas LIGNE

 Page 0 : lire et filtrer → garder les lignes qui matchent
 Page 2 : lire et filtrer → garder les lignes qui matchent
 Page 3 : lire et filtrer → garder les lignes qui matchent
 Page 6 : lire et filtrer → garder les lignes qui matchent
```

**Avantages du Bitmap Scan :**
- Lit les pages dans l'**ordre physique** (pas aleatoire comme l'Index Scan)
- Peut combiner plusieurs index avec `BitmapAnd` / `BitmapOr`

```sql
-- Combinaison de deux index avec BitmapAnd
EXPLAIN SELECT * FROM employe
WHERE departement_id = 3 AND salaire > 50000;

-- BitmapAnd
--   -> Bitmap Index Scan on idx_employe_dep  (departement_id = 3)
--   -> Bitmap Index Scan on idx_employe_sal  (salaire > 50000)
-- → Intersection des deux bitmaps
```

### 4.5 Tableau comparatif des scans

| Scan | Quand | Nb lignes | Acces disque | Vitesse |
|---|---|---|---|---|
| **Seq Scan** | Pas d'index ou beaucoup de lignes | > 10% | Sequentiel (rapide) | O(n) |
| **Index Scan** | Peu de lignes, bonne selectivite | < 5% | Aleatoire (lent par page) | O(log n) |
| **Index Only Scan** | Toutes colonnes dans l'index | < 5% | Index seulement | O(log n) |
| **Bitmap Index/Heap** | Nombre moyen de lignes | 1-10% | Sequentiel (via bitmap) | O(log n + pages) |

---

## 5. Stratégies de JOIN

### 5.1 Nested Loop

Pour chaque ligne de la table externe, scanner la table interne.

```
 Nested Loop :

 Table externe (employe) :     Table interne (departement) :
 ┌───────────────────────┐     ┌───────────────────────┐
 │ Alice, dep_id=1       │────▶│ Chercher id=1 → "IT"  │
 │ Bob, dep_id=2         │────▶│ Chercher id=2 → "RH"  │
 │ Claire, dep_id=1      │────▶│ Chercher id=1 → "IT"  │
 │ David, dep_id=3       │────▶│ Chercher id=3 → "FIN" │
 └───────────────────────┘     └───────────────────────┘

 Pour N employes et un index sur departement(id) :
 → N recherches dans l'index = N × O(log M)
 → Total : O(N × log M)

 Ideal quand : table externe petite OU bons index sur la table interne
```

### 5.2 Hash Join

Construire une table de hachage en mémoire pour une table, puis scanner l'autre.

```
 Hash Join :

 Phase 1 : BUILD — construire la hash table sur la petite table
 ┌───────────────────────┐      ┌─────────────────────┐
 │ departement           │      │ Hash Table          │
 │ id=1, nom="IT"        │─────▶│ hash(1) → "IT"     │
 │ id=2, nom="RH"        │─────▶│ hash(2) → "RH"     │
 │ id=3, nom="Finance"   │─────▶│ hash(3) → "Finance"│
 └───────────────────────┘      └─────────────────────┘

 Phase 2 : PROBE — scanner la grande table et chercher dans la hash table
 ┌───────────────────────┐
 │ employe               │
 │ Alice, dep_id=1       │──▶ hash(1) → trouvé "IT" ✓
 │ Bob, dep_id=2         │──▶ hash(2) → trouvé "RH" ✓
 │ Claire, dep_id=1      │──▶ hash(1) → trouvé "IT" ✓
 └───────────────────────┘

 Complexite : O(N + M)  (lineaire !)
 Ideal quand : jointure sur egalite (=) avec grands ensembles
```

### 5.3 Merge Join

Trier les deux tables sur la colonne de jointure, puis les fusionner.

```
 Merge Join :

 Etape 1 : Trier les deux tables (ou utiliser un index trie)

 employe (trie par dep_id):    departement (trie par id):
 ┌─────────────────┐          ┌─────────────────┐
 │ Alice, dep=1    │          │ id=1, "IT"       │
 │ Claire, dep=1   │          │ id=2, "RH"       │
 │ Bob, dep=2      │          │ id=3, "Finance"  │
 │ David, dep=3    │          └─────────────────┘
 └─────────────────┘

 Etape 2 : Fusionner (comme un merge sort)
 Pointeur A         Pointeur B
     │                  │
     ▼                  ▼
 Alice,dep=1  ←──▶  id=1,"IT"    → MATCH ! → sortie
 Claire,dep=1 ←──▶  id=1,"IT"    → MATCH ! → sortie
 Bob,dep=2    ←──▶  id=2,"RH"    → MATCH ! → sortie
 David,dep=3  ←──▶  id=3,"FIN"   → MATCH ! → sortie

 Complexite : O(N log N + M log M) pour le tri + O(N + M) pour la fusion
 Ideal quand : donnees deja triees (index) ou tres grands ensembles
```

### 5.4 Tableau comparatif des 3 stratégies

| Stratégie | Complexite | Mémoire | Cas optimal | Cas defavorable |
|---|---|---|---|---|
| **Nested Loop** | O(N × log M) | Faible | Petite table externe + index | Deux grandes tables sans index |
| **Hash Join** | O(N + M) | Elevee (hash table) | Egalite sur grands ensembles | Hash table trop grande pour la mémoire |
| **Merge Join** | O(N log N + M log M) | Moyenne | Donnees déjà triees (index) | Donnees non triees |

---

## 6. Autres noeuds du plan

### 6.1 Sort

```sql
EXPLAIN SELECT * FROM employe ORDER BY nom;
-- Sort  (cost=70.00..72.50 rows=1000 width=72)
--   Sort Key: nom
--   -> Seq Scan on employe  (cost=0.00..25.00 rows=1000 width=72)
```

> **Ce qu'il faut retenir** : Un `Sort` dans le plan signifie que PostgreSQL doit trier les donnees en mémoire (où sur disque si `work_mem` est insuffisant). Si tu vois un sort et que la requête est lente, envisage un index qui fournit les donnees déjà triees.

### 6.2 HashAggregate vs GroupAggregate

```sql
-- HashAggregate : utilise une hash table pour regrouper
EXPLAIN SELECT departement_id, COUNT(*) FROM employe GROUP BY departement_id;
-- HashAggregate  (cost=25.00..27.50 rows=5 width=12)
--   Group Key: departement_id
--   -> Seq Scan on employe

-- GroupAggregate : necessite des donnees triees
EXPLAIN SELECT departement_id, COUNT(*) FROM employe
GROUP BY departement_id ORDER BY departement_id;
-- GroupAggregate  (cost=70.00..75.00 rows=5 width=12)
--   Group Key: departement_id
--   -> Sort  (cost=70.00..72.50 rows=1000 width=4)
--     -> Seq Scan on employe
```

### 6.3 Materialize

Stocke le résultat d'un sous-plan en mémoire pour le réutiliser.

```sql
-- Le noeud Materialize apparait quand le plan interne
-- d'un Nested Loop doit etre relu plusieurs fois
-- → stocke le resultat la premiere fois, reutilise ensuite
```

### 6.4 Append

Combine les résultats de plusieurs sous-plans (UNION, tables heritees, partitionnement).

```sql
EXPLAIN SELECT * FROM employe WHERE id < 10
UNION ALL
SELECT * FROM ancien_employe WHERE id < 10;
-- Append  (cost=0.00..50.00 rows=20 width=72)
--   -> Index Scan on employe
--   -> Index Scan on ancien_employe
```

---

## 7. Statistiques du planner

### 7.1 pg_stats — les statistiques de chaque colonne

```sql
-- Voir les statistiques d'une colonne
SELECT
    schemaname,
    tablename,
    attname AS colonne,
    n_distinct,
    most_common_vals,
    most_common_freqs,
    correlation
FROM pg_stats
WHERE tablename = 'employe'
  AND attname = 'departement_id';
```

| Champ | Signification |
|---|---|
| `n_distinct` | Nombre de valeurs distinctes (negatif = fraction des lignes) |
| `most_common_vals` | Les valeurs les plus frequentes |
| `most_common_freqs` | La frequence de chaque valeur commune |
| `histogram_bounds` | Distribution des valeurs non communes |
| `correlation` | Correlation physique (-1 a 1) : les donnees sont-elles triees sur disque ? |
| `null_frac` | Fraction de valeurs NULL |
| `avg_width` | Largeur moyenne de la colonne en octets |

### 7.2 ANALYZE — mettre a jour les statistiques

```sql
-- Mettre a jour les statistiques d'une table
ANALYZE employe;

-- Mettre a jour les statistiques de colonnes specifiques
ANALYZE employe(departement_id, salaire);

-- Mettre a jour toute la base
ANALYZE;
```

> **Ce qu'il faut retenir** : L'**autovacuum** lance automatiquement `ANALYZE` quand une table a subi suffisamment de modifications (~10% des lignes). Mais après un chargement massif de donnees (COPY, migration), lance `ANALYZE` manuellement pour mettre a jour les statistiques immediatement.

### 7.3 Augmenter la précision des statistiques

```sql
-- Par defaut, PostgreSQL echantillonne 100 valeurs par colonne
-- Pour une colonne avec une distribution tres variee :
ALTER TABLE employe ALTER COLUMN salaire SET STATISTICS 500;
ANALYZE employe(salaire);
-- Plus de statistiques = meilleur plan, mais ANALYZE plus lent
```

### 7.4 Parametres de cout du planner

| Paramètre | Defaut | Signification |
|---|---|---|
| `seq_page_cost` | 1.0 | Cout de lecture d'une page sequentielle |
| `random_page_cost` | 4.0 | Cout de lecture d'une page aleatoire |
| `cpu_tuple_cost` | 0.01 | Cout de traitement d'une ligne |
| `cpu_index_tuple_cost` | 0.005 | Cout de traitement d'une entree d'index |
| `cpu_operator_cost` | 0.0025 | Cout d'un operateur (=, <, ...) |
| `effective_cache_size` | 4GB | Estimation de la mémoire disponible pour le cache OS + shared buffers |
| `work_mem` | 4MB | Mémoire disponible pour les tris et hash tables |

> **Piege classique** : Si tes donnees sont principalement en SSD, le ratio `random_page_cost / seq_page_cost = 4.0` est trop eleve. Sur SSD, mets `random_page_cost = 1.1` car les acces aleatoires sont presque aussi rapides que les acces sequentiels.

```sql
-- Pour un serveur avec SSD
SET random_page_cost = 1.1;
SET effective_cache_size = '12GB';  -- 75% de la RAM
SET work_mem = '64MB';  -- plus de memoire pour les tris et hash

-- Voir les parametres actuels
SHOW random_page_cost;
SHOW effective_cache_size;
SHOW work_mem;
```

---

## 8. Forcer le planner (debug tool)

### 8.1 Desactiver des stratégies

```sql
-- Desactiver le Seq Scan pour forcer l'utilisation d'un index
SET enable_seqscan = off;
EXPLAIN SELECT * FROM employe WHERE departement_id = 3;
-- Force un Index Scan (si un index existe)

-- Desactiver les Hash Join
SET enable_hashjoin = off;

-- Desactiver les Merge Join
SET enable_mergejoin = off;

-- Desactiver les Nested Loop
SET enable_nestloop = off;

-- Reactiver tout
RESET enable_seqscan;
RESET enable_hashjoin;
RESET enable_mergejoin;
RESET enable_nestloop;
-- ou
RESET ALL;
```

> **Piege classique** : Ne mets JAMAIS `enable_seqscan = off` en production. C'est un outil de diagnostic pour comprendre pourquoi le planner ne choisit pas un certain plan. Si le planner choisit un Seq Scan alors qu'un index existe, le problème est souvent dans les **statistiques** ou les **paramètres de cout**, pas dans le planner lui-même.

---

## 9. Cas pratiques : optimiser une requête lente

### 9.1 Méthodologie

```
 Etapes pour optimiser une requete lente :

 1. EXPLAIN ANALYZE → obtenir le plan reel
 2. Identifier le noeud le plus couteux
 3. Verifier les estimations vs la realite (rows)
 4. Si estimation mauvaise → ANALYZE la table
 5. Si Seq Scan sur grande table → creer un index
 6. Si Sort couteux → index sur la colonne ORDER BY
 7. Si Hash Join deborde sur disque → augmenter work_mem
 8. Verifier les parametres (random_page_cost, effective_cache_size)
 9. Re-executer et comparer
```

### 9.2 Exemple : optimiser une requête e-commerce

```sql
-- Requete lente : trouver les commandes recentes d'un client avec leurs produits
EXPLAIN (ANALYZE, BUFFERS)
SELECT
    c.nom AS client,
    cmd.id AS commande,
    cmd.date_commande,
    p.nom AS produit,
    lc.quantite,
    lc.prix_unitaire
FROM client c
JOIN commande cmd ON c.id = cmd.client_id
JOIN ligne_commande lc ON cmd.id = lc.commande_id
JOIN produit p ON lc.produit_id = p.id
WHERE c.email = 'alice@example.com'
  AND cmd.date_commande >= '2024-01-01'
ORDER BY cmd.date_commande DESC;
```

```
 Plan AVANT optimisation :

 Sort  (actual time=1250.000..1250.010 rows=15 loops=1)
   Sort Key: cmd.date_commande DESC
   -> Hash Join  (actual time=1200.000..1248.000 rows=15 loops=1)
        Hash Cond: (lc.produit_id = p.id)
        -> Hash Join  (actual time=850.000..1100.000 rows=15 loops=1)
             Hash Cond: (lc.commande_id = cmd.id)
             -> Seq Scan on ligne_commande lc
                  (actual time=0.010..800.000 rows=5000000 loops=1)
                  ← PROBLEME : Seq Scan sur 5M de lignes !
             -> Hash  (actual time=45.000..45.000 rows=50 loops=1)
                  -> Nested Loop  (actual time=0.050..44.000 rows=50 loops=1)
                       -> Seq Scan on client c
                            Filter: (email = 'alice@example.com')
                            ← PROBLEME : Seq Scan sur client
                       -> Seq Scan on commande cmd
                            Filter: (date_commande >= '2024-01-01')
                            ← PROBLEME : Seq Scan sur commande

 Execution Time: 1250.235 ms  ← 1.25 seconde (LENT)
```

```sql
-- Optimisation : creer les index manquants
CREATE INDEX idx_client_email ON client(email);
CREATE INDEX idx_commande_client_date ON commande(client_id, date_commande);
CREATE INDEX idx_ligne_commande_commande ON ligne_commande(commande_id);
CREATE INDEX idx_ligne_commande_produit ON ligne_commande(produit_id);

-- Mettre a jour les statistiques
ANALYZE client, commande, ligne_commande, produit;
```

```
 Plan APRES optimisation :

 Sort  (actual time=0.150..0.152 rows=15 loops=1)
   Sort Key: cmd.date_commande DESC
   -> Nested Loop  (actual time=0.030..0.120 rows=15 loops=1)
        -> Nested Loop  (actual time=0.025..0.080 rows=15 loops=1)
             -> Nested Loop  (actual time=0.020..0.045 rows=50 loops=1)
                  -> Index Scan on client c using idx_client_email
                       Index Cond: (email = 'alice@example.com')
                       (actual time=0.010..0.012 rows=1 loops=1)
                  -> Index Scan on commande cmd using idx_commande_client_date
                       Index Cond: (client_id = 1 AND date >= '2024-01-01')
                       (actual time=0.005..0.025 rows=50 loops=1)
             -> Index Scan on ligne_commande lc using idx_lc_commande
                  (actual time=0.002..0.005 rows=3 loops=50)
        -> Index Scan on produit p using produit_pkey
             (actual time=0.001..0.001 rows=1 loops=15)

 Execution Time: 0.205 ms  ← 0.2 ms (6000x plus rapide !)
```

| | Avant | Après | Amelioration |
|---|---|---|---|
| Temps | 1250 ms | 0.2 ms | **x6 250** |
| Scans | Seq Scan partout | Index Scan partout | Acces direct |
| Pages lues | ~50 000 | ~20 | **x2 500** |

---

## 10. Common Table Expressions et le planner

### 10.1 Avant PostgreSQL 12 : optimization fence

```sql
-- Avant PG12 : les CTE etaient TOUJOURS materialisees
-- Le planner ne pouvait PAS "pousser" les filtres dans la CTE
WITH tous_employes AS (
    SELECT * FROM employe  -- lit TOUTE la table
)
SELECT * FROM tous_employes WHERE id = 42;
-- PG < 12 : Seq Scan dans la CTE, puis filtre sur id=42
-- PG >= 12 : le planner peut inliner la CTE et utiliser l'index
```

### 10.2 Depuis PostgreSQL 12 : inlining automatique

```sql
-- PG 12+ : les CTE simples (non recursives, referencees une seule fois)
-- sont automatiquement "inlinees" dans la requete principale
WITH employe_it AS (
    SELECT * FROM employe WHERE departement_id = 1
)
SELECT * FROM employe_it WHERE salaire > 50000;
-- Equivalent a :
SELECT * FROM employe WHERE departement_id = 1 AND salaire > 50000;

-- Pour FORCER la materialisation (ancien comportement) :
WITH employe_it AS MATERIALIZED (
    SELECT * FROM employe WHERE departement_id = 1
)
SELECT * FROM employe_it WHERE salaire > 50000;

-- Pour FORCER l'inlining :
WITH employe_it AS NOT MATERIALIZED (
    SELECT * FROM employe WHERE departement_id = 1
)
SELECT * FROM employe_it WHERE salaire > 50000;
```

---

## 11. Node.js : analyser les plans depuis l'application

```typescript
// fichier : analyze-query.mjs
// Analyser les plans d'execution depuis Node.js

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'cours',
  user: 'postgres',
  password: 'postgres',
});

async function analyserRequete(sql, params = []) {
  // Obtenir le plan en JSON
  const explainSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`;
  const { rows } = await pool.query(explainSql, params);
  const plan = rows[0]['QUERY PLAN'][0];

  console.log('='.repeat(60));
  console.log('Requete :', sql);
  console.log('Parametres :', params);
  console.log('-'.repeat(60));
  console.log('Temps planification :', plan['Planning Time'], 'ms');
  console.log('Temps execution     :', plan['Execution Time'], 'ms');
  console.log('Noeud racine        :', plan.Plan['Node Type']);
  console.log('Lignes estimees     :', plan.Plan['Plan Rows']);
  console.log('Lignes reelles      :', plan.Plan['Actual Rows']);

  // Detecter les problemes
  const problemes = [];
  function inspecterNoeud(noeud, profondeur = 0) {
    const indent = '  '.repeat(profondeur);
    const estimation = noeud['Plan Rows'] || 0;
    const reel = noeud['Actual Rows'] || 0;

    // Estimation tres differente de la realite
    if (estimation > 0 && reel > 0) {
      const ratio = Math.max(estimation, reel) / Math.min(estimation, reel);
      if (ratio > 10) {
        problemes.push(
          `${indent}[ESTIMATION] ${noeud['Node Type']} : ` +
          `estime ${estimation} vs reel ${reel} (ratio x${ratio.toFixed(0)})`
        );
      }
    }

    // Seq Scan sur une grande table
    if (noeud['Node Type'] === 'Seq Scan' && reel > 10000) {
      problemes.push(
        `${indent}[SEQ SCAN] sur ${noeud['Relation Name']} ` +
        `(${reel} lignes) — envisager un index`
      );
    }

    // Parcourir les sous-plans
    if (noeud.Plans) {
      for (const sousPlan of noeud.Plans) {
        inspecterNoeud(sousPlan, profondeur + 1);
      }
    }
  }

  inspecterNoeud(plan.Plan);

  if (problemes.length > 0) {
    console.log('\nProblemes detectes :');
    for (const p of problemes) {
      console.log(`  ⚠ ${p}`);
    }
  } else {
    console.log('\nAucun probleme detecte.');
  }
  console.log('='.repeat(60));
}

async function main() {
  try {
    await analyserRequete(
      'SELECT * FROM employe WHERE departement_id = $1',
      [3]
    );
    await analyserRequete(
      'SELECT * FROM employe WHERE LOWER(email) = $1',
      ['alice@example.com']
    );
  } finally {
    await pool.end();
  }
}

main();
```

---

## 12. Exercice mental

1. **Tu vois un Seq Scan sur une table de 10M de lignes avec `rows=10M` dans EXPLAIN. La requête retourne 5 lignes. Que fais-tu ?** (Créer un index sur la colonne WHERE, puis `ANALYZE`)

2. **Le plan montre `rows=100` estime mais `rows=500000` réel. Quel est le problème ?** (Statistiques obsoletes → `ANALYZE`, ou statistiques insuffisantes → `SET STATISTICS`)

3. **Tu vois `Buffers: shared read=50000`. Est-ce bon ?** (Non : 50000 pages lues depuis le disque. Les donnees ne sont pas en cache. Soit augmenter `shared_buffers`, soit optimiser la requête pour lire moins de pages)

4. **Un Hash Join à un `Batches: 16`. Que signifie ce nombre ?** (Le hash table ne tient pas en mémoire (`work_mem`), PostgreSQL a du écrire sur disque en 16 batches. Augmenter `work_mem` pourrait aider)

---

## Navigation

| | Lien |
|---|---|
| Module précédent | [Module 05 — Index : les fondamentaux](./05-index-fondamentaux.md) |
| Module suivant | [Module 07 — Index avances (GIN, GiST, BRIN)](./07-index-avances.md) |
| Lab associe | [Lab 06 — Analyser et optimiser avec EXPLAIN](../labs/lab-06.md) |

---

> **Ce qu'il faut retenir** : Le query planner est le cerveau de PostgreSQL. `EXPLAIN ANALYZE` avec `BUFFERS` est ton meilleur outil de diagnostic. Les clés d'optimisation sont : des statistiques a jour (`ANALYZE`), des index adaptes, des paramètres de cout realistes (`random_page_cost` pour SSD), et suffisamment de `work_mem` pour les tris et hash joins. Ne force jamais le planner en production — corrige la cause plutot que le symptome.

---

<!-- parcours-recommande -->

::: tip Parcours recommandé
1. **Screencast** : [screencast 06 query planner](../screencasts/screencast-06-query-planner.md)
2. **Lab** : [lab-06-query-planner-deep-dive](../labs/lab-06-query-planner-deep-dive/README)
3. **Visualisation** : [B-tree Index](../visualizations/btree-index.html)
4. **Visualisation** : [Query Planner](../visualizations/query-planner.html)
5. **Quiz** : [quiz 06 query planner](../quizzes/quiz-06-query-planner.html)
:::
