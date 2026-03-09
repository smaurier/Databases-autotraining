# Module 02 — CRUD & Requetes SQL

> **Objectif** : Maitriser les quatre operations fondamentales (Create, Read, Update, Delete), les fonctions d'agregation, les sous-requetes et l'integration securisee avec Node.js via des requetes parametrees.
>
> **Difficulte** : ⭐ (debutant)

---

## 1. INSERT — ajouter des donnees

### 1.1 Insertion simple

```sql
-- Syntaxe de base
INSERT INTO nom_table (colonne1, colonne2, ...) VALUES (valeur1, valeur2, ...);

-- Exemple concret
INSERT INTO produit (nom, prix, categorie)
VALUES ('Clavier mecanique', 89.99, 'peripherique');
```

> **Analogie** : `INSERT`, c'est comme remplir un formulaire et le deposer dans le bon classeur. Chaque champ du formulaire correspond a une colonne, et le classeur est la table.

### 1.2 Insertion multiple

```sql
-- Inserer plusieurs lignes en une seule requete (beaucoup plus performant)
INSERT INTO produit (nom, prix, categorie) VALUES
    ('Souris sans fil', 34.99, 'peripherique'),
    ('Ecran 27"', 349.00, 'ecran'),
    ('Cable HDMI 2m', 12.50, 'cable'),
    ('Webcam HD', 59.99, 'peripherique'),
    ('Hub USB-C', 29.99, 'accessoire');
```

> **Ce qu'il faut retenir** : Inserer 1000 lignes avec un seul `INSERT ... VALUES (row1), (row2), ...` est **10 a 100 fois plus rapide** qu'executer 1000 `INSERT` individuels. Chaque `INSERT` individuel est une transaction complete (parse, plan, execute, WAL write, commit).

### 1.3 RETURNING — recuperer les donnees inserees

```sql
-- RETURNING : obtenir les donnees inserees (notamment l'ID genere)
INSERT INTO produit (nom, prix, categorie)
VALUES ('Casque audio', 149.99, 'audio')
RETURNING id, nom, prix;

-- Resultat :
--  id |    nom      |  prix
-- ----+-------------+--------
--   7 | Casque audio| 149.99

-- RETURNING * : toutes les colonnes
INSERT INTO produit (nom, prix, categorie)
VALUES ('Tapis de souris', 19.99, 'accessoire')
RETURNING *;
```

> **Ce qu'il faut retenir** : `RETURNING` est une extension PostgreSQL extremement utile. Elle evite de faire un `SELECT` apres l'`INSERT` pour recuperer l'ID genere. C'est **une seule operation** au lieu de deux.

### 1.4 INSERT ... ON CONFLICT (Upsert)

L'upsert (update or insert) est un pattern tres courant : si la ligne existe deja, on la met a jour au lieu de generer une erreur.

```sql
-- Creer une table avec contrainte UNIQUE
CREATE TABLE configuration (
    cle     TEXT PRIMARY KEY,
    valeur  TEXT NOT NULL,
    maj_le  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Premier insert : cree la ligne
INSERT INTO configuration (cle, valeur) VALUES ('theme', 'sombre');

-- Deuxieme insert : conflit sur la PK → mettre a jour
INSERT INTO configuration (cle, valeur)
VALUES ('theme', 'clair')
ON CONFLICT (cle) DO UPDATE
SET valeur = EXCLUDED.valeur,
    maj_le = now();

-- EXCLUDED fait reference aux valeurs qu'on essayait d'inserer

-- ON CONFLICT DO NOTHING : ignorer silencieusement les doublons
INSERT INTO configuration (cle, valeur)
VALUES ('theme', 'bleu')
ON CONFLICT (cle) DO NOTHING;
-- Pas d'erreur, pas de modification

-- Upsert avec condition supplementaire
INSERT INTO configuration (cle, valeur)
VALUES ('version', '2.0')
ON CONFLICT (cle) DO UPDATE
SET valeur = EXCLUDED.valeur,
    maj_le = now()
WHERE configuration.valeur <> EXCLUDED.valeur;
-- Mise a jour uniquement si la valeur change reellement
```

```
 ┌─────────────────────────────────────────────────┐
 │                  INSERT ... ON CONFLICT          │
 │                                                  │
 │   Donnees ──▶ Conflit ?                          │
 │                  │                               │
 │          Non ◄───┤───▶ Oui                       │
 │           │             │                        │
 │       INSERT        DO UPDATE ?                  │
 │       normal            │                        │
 │                 Oui ◄───┤───▶ Non                │
 │                  │             │                  │
 │              UPDATE        DO NOTHING            │
 │           avec EXCLUDED    (ignorer)             │
 └─────────────────────────────────────────────────┘
```

### 1.5 INSERT ... SELECT

```sql
-- Inserer des donnees a partir d'une autre requete
INSERT INTO archive_produit (nom, prix, archive_le)
SELECT nom, prix, now()
FROM produit
WHERE categorie = 'obsolete';

-- Utile pour : archivage, duplication, transformation
```

---

## 2. SELECT — lire des donnees

### 2.1 Les bases

```sql
-- Toutes les colonnes, toutes les lignes
SELECT * FROM produit;

-- Colonnes specifiques
SELECT nom, prix FROM produit;

-- Avec alias (AS)
SELECT
    nom AS nom_produit,
    prix AS prix_ttc,
    prix * 0.8 AS prix_ht,
    prix * 0.2 AS tva
FROM produit;

-- Expressions calculees
SELECT
    nom,
    prix,
    CASE
        WHEN prix < 20 THEN 'pas cher'
        WHEN prix < 100 THEN 'moyen'
        ELSE 'cher'
    END AS gamme
FROM produit;
```

### 2.2 DISTINCT — eliminer les doublons

```sql
-- Valeurs uniques d'une colonne
SELECT DISTINCT categorie FROM produit;

-- Combinaison unique de colonnes
SELECT DISTINCT categorie, en_stock FROM produit;

-- DISTINCT ON (PostgreSQL specifique) — premier de chaque groupe
SELECT DISTINCT ON (categorie) categorie, nom, prix
FROM produit
ORDER BY categorie, prix DESC;
-- Pour chaque categorie, retourne le produit le plus cher
```

> **Piege classique** : `SELECT DISTINCT` trie implicitement les resultats pour eliminer les doublons. Sur une grande table, c'est couteux. Si tu as besoin de `DISTINCT` souvent, c'est peut-etre un signe que ton modele est mal normalise.

### 2.3 Expressions et operateurs utiles

```sql
-- Concatenation de texte
SELECT prenom || ' ' || nom AS nom_complet FROM employe;

-- Fonctions texte
SELECT
    UPPER(nom) AS majuscule,
    LOWER(email) AS minuscule,
    LENGTH(nom) AS longueur,
    TRIM('  espaces  ') AS sans_espaces,
    LEFT(nom, 3) AS debut,
    REPLACE(nom, 'a', '@') AS remplace
FROM employe;

-- Fonctions de date
SELECT
    CURRENT_DATE AS aujourdhui,
    EXTRACT(YEAR FROM date_naissance) AS annee_naissance,
    AGE(date_naissance) AS age_exact,
    DATE_PART('month', cree_le) AS mois_creation,
    TO_CHAR(cree_le, 'DD/MM/YYYY HH24:MI') AS date_formatee
FROM employe;

-- Coalesce : premiere valeur non NULL
SELECT
    nom,
    COALESCE(telephone, email, 'aucun contact') AS contact
FROM client;

-- NULLIF : retourne NULL si les deux valeurs sont egales
SELECT NULLIF(stock, 0) AS stock_ou_null FROM produit;
-- Utile pour eviter les divisions par zero :
SELECT total / NULLIF(quantite, 0) AS prix_unitaire FROM ligne;
```

---

## 3. WHERE — filtrer les resultats

### 3.1 Operateurs de comparaison

| Operateur | Description | Exemple |
|---|---|---|
| `=` | Egal | `WHERE prix = 29.99` |
| `<>` ou `!=` | Different | `WHERE statut <> 'annule'` |
| `<` | Inferieur | `WHERE prix < 100` |
| `>` | Superieur | `WHERE prix > 50` |
| `<=` | Inferieur ou egal | `WHERE stock <= 10` |
| `>=` | Superieur ou egal | `WHERE note >= 4.0` |

### 3.2 Operateurs logiques et speciaux

```sql
-- AND / OR
SELECT * FROM produit
WHERE categorie = 'peripherique'
  AND prix < 100
  AND en_stock = true;

SELECT * FROM produit
WHERE prix < 20 OR categorie = 'promo';

-- BETWEEN (inclusif des deux cotes)
SELECT * FROM produit
WHERE prix BETWEEN 20 AND 100;
-- Equivalent a : prix >= 20 AND prix <= 100

-- IN : appartenance a une liste
SELECT * FROM produit
WHERE categorie IN ('peripherique', 'audio', 'ecran');

-- NOT IN
SELECT * FROM produit
WHERE categorie NOT IN ('cable', 'accessoire');

-- LIKE : pattern matching (% = n'importe quoi, _ = un caractere)
SELECT * FROM produit WHERE nom LIKE 'Clavier%';
SELECT * FROM produit WHERE nom LIKE '____'; -- exactement 4 caracteres

-- ILIKE : LIKE insensible a la casse (PostgreSQL specifique)
SELECT * FROM produit WHERE nom ILIKE '%souris%';

-- IS NULL / IS NOT NULL (JAMAIS utiliser = NULL !)
SELECT * FROM employe WHERE telephone IS NULL;
SELECT * FROM employe WHERE telephone IS NOT NULL;

-- Expressions regulieres PostgreSQL
SELECT * FROM produit WHERE nom ~ '^[A-Z].*\d$'; -- commence par majuscule, finit par chiffre
SELECT * FROM produit WHERE nom ~* 'clavier'; -- insensible a la casse
```

> **Piege classique** : `NULL` n'est pas une valeur, c'est l'**absence de valeur**. On ne peut pas comparer avec `=` :
> - `WHERE telephone = NULL` → **ne retourne JAMAIS rien** (meme si des lignes ont `telephone` NULL)
> - `WHERE telephone IS NULL` → **correct**
> - `NULL = NULL` → `NULL` (pas `true` !)
> - `NULL <> 42` → `NULL` (pas `true` !)

```sql
-- Demonstration du piege NULL
SELECT NULL = NULL;     -- NULL (pas true)
SELECT NULL <> NULL;    -- NULL (pas false)
SELECT NULL IS NULL;    -- true
SELECT 1 IN (1, NULL);  -- true (1 est dans la liste)
SELECT 2 IN (1, NULL);  -- NULL (pas false ! car on ne sait pas si NULL = 2)
SELECT 2 NOT IN (1, NULL); -- NULL (pas true !)
```

> **Ce qu'il faut retenir** : En SQL, la logique est **trivalente** : `true`, `false`, `NULL`. Toute comparaison impliquant `NULL` retourne `NULL`. `WHERE` ne garde que les lignes ou la condition est `true` (pas `NULL`).

---

## 4. ORDER BY, LIMIT, OFFSET — tri et pagination

### 4.1 ORDER BY

```sql
-- Tri ascendant (par defaut)
SELECT nom, prix FROM produit ORDER BY prix;
SELECT nom, prix FROM produit ORDER BY prix ASC; -- equivalent

-- Tri descendant
SELECT nom, prix FROM produit ORDER BY prix DESC;

-- Tri multi-colonnes
SELECT nom, categorie, prix
FROM produit
ORDER BY categorie ASC, prix DESC;
-- D'abord par categorie (A→Z), puis par prix decroissant dans chaque categorie

-- Tri avec NULLS FIRST / NULLS LAST
SELECT nom, telephone FROM employe
ORDER BY telephone NULLS LAST;
-- Les employes sans telephone apparaissent a la fin

-- Tri par position de colonne (deconseille mais possible)
SELECT nom, prix FROM produit ORDER BY 2 DESC; -- trie par la 2e colonne (prix)
```

### 4.2 LIMIT et OFFSET

```sql
-- Les 10 premiers resultats
SELECT nom, prix FROM produit ORDER BY prix DESC LIMIT 10;

-- Pagination : page 1 (lignes 1-10)
SELECT * FROM produit ORDER BY id LIMIT 10 OFFSET 0;

-- Pagination : page 2 (lignes 11-20)
SELECT * FROM produit ORDER BY id LIMIT 10 OFFSET 10;

-- Pagination : page N (lignes (N-1)*10+1 a N*10)
-- OFFSET = (page - 1) * taille_page
```

> **Piege classique** : La pagination par `OFFSET` est **tres inefficace** sur les grandes tables. `OFFSET 1000000` oblige PostgreSQL a lire 1 000 000 de lignes, puis a les jeter. Pour une pagination performante, utilise la **pagination par curseur** (keyset pagination) :

```sql
-- MAUVAIS : pagination par OFFSET (lent sur les grandes pages)
SELECT * FROM produit ORDER BY id LIMIT 20 OFFSET 100000;
-- PostgreSQL lit 100 020 lignes, jette les 100 000 premieres

-- BON : pagination par curseur (keyset pagination)
-- Le client se souvient du dernier ID vu
SELECT * FROM produit
WHERE id > 100000        -- dernier ID de la page precedente
ORDER BY id
LIMIT 20;
-- PostgreSQL utilise l'index sur id, lit directement les 20 lignes
```

```
 Comparaison de performance : OFFSET vs Keyset

 Page       OFFSET (temps)     Keyset (temps)
 ─────────────────────────────────────────────
 1          ~1 ms              ~1 ms
 10         ~2 ms              ~1 ms
 100        ~15 ms             ~1 ms
 1 000      ~150 ms            ~1 ms
 10 000     ~1 500 ms          ~1 ms
 100 000    ~15 000 ms         ~1 ms
              ▲                   ▲
         Lineaire O(n)       Constant O(1)
```

---

## 5. UPDATE — modifier des donnees

### 5.1 Syntaxe de base

```sql
-- Mettre a jour une colonne
UPDATE produit
SET prix = 79.99
WHERE id = 1;

-- Mettre a jour plusieurs colonnes
UPDATE produit
SET prix = 79.99,
    nom = 'Clavier mecanique RGB',
    modifie_le = now()
WHERE id = 1;

-- ATTENTION : sans WHERE, TOUTES les lignes sont modifiees !
UPDATE produit SET prix = 0;  -- DANGER : tous les prix a zero !
```

> **Piege classique** : Un `UPDATE` sans `WHERE` modifie **toutes** les lignes de la table. C'est l'une des erreurs les plus frequentes et les plus destructrices en SQL. Toujours verifier ta clause `WHERE` avec un `SELECT` d'abord :

```sql
-- Etape 1 : verifier quelles lignes seront affectees
SELECT id, nom, prix FROM produit WHERE categorie = 'obsolete';

-- Etape 2 : une fois satisfait, executer l'UPDATE
UPDATE produit SET en_stock = false WHERE categorie = 'obsolete';
```

### 5.2 UPDATE avec RETURNING

```sql
-- Recuperer les lignes modifiees
UPDATE produit
SET prix = prix * 1.10  -- augmentation de 10%
WHERE categorie = 'peripherique'
RETURNING id, nom, prix AS nouveau_prix;
```

### 5.3 UPDATE avec sous-requete

```sql
-- Mettre a jour une colonne a partir d'une autre table
UPDATE employe
SET departement_id = (
    SELECT id FROM departement WHERE code = 'IT'
)
WHERE poste LIKE '%developpeur%';

-- UPDATE avec FROM (syntaxe PostgreSQL)
UPDATE employe e
SET salaire = salaire * 1.05
FROM departement d
WHERE e.departement_id = d.id
  AND d.nom = 'Recherche';
```

### 5.4 UPDATE conditionnel avec CASE

```sql
-- Augmentation differenciee selon l'anciennete
UPDATE employe
SET salaire = salaire * CASE
    WHEN cree_le < now() - INTERVAL '5 years' THEN 1.08   -- +8% pour 5+ ans
    WHEN cree_le < now() - INTERVAL '2 years' THEN 1.05   -- +5% pour 2-5 ans
    ELSE 1.03                                               -- +3% pour < 2 ans
END
WHERE est_actif = true
RETURNING id, nom, salaire;
```

---

## 6. DELETE — supprimer des donnees

### 6.1 Syntaxe de base

```sql
-- Supprimer des lignes specifiques
DELETE FROM produit WHERE id = 42;

-- Supprimer avec condition complexe
DELETE FROM produit
WHERE en_stock = false
  AND modifie_le < now() - INTERVAL '1 year';

-- RETURNING : savoir ce qu'on a supprime
DELETE FROM produit
WHERE categorie = 'obsolete'
RETURNING id, nom;

-- ATTENTION : sans WHERE, TOUTES les lignes sont supprimees !
DELETE FROM produit;  -- supprime tout le contenu
```

### 6.2 DELETE avec sous-requete

```sql
-- Supprimer les employes des departements fermes
DELETE FROM employe
WHERE departement_id IN (
    SELECT id FROM departement WHERE est_ferme = true
);

-- Syntaxe USING (PostgreSQL specifique)
DELETE FROM employe e
USING departement d
WHERE e.departement_id = d.id
  AND d.est_ferme = true;
```

### 6.3 TRUNCATE — vider une table entierement

```sql
-- TRUNCATE : beaucoup plus rapide que DELETE pour vider une table
TRUNCATE TABLE produit;

-- TRUNCATE avec reinitialisation de la sequence
TRUNCATE TABLE produit RESTART IDENTITY;

-- TRUNCATE en cascade (vide aussi les tables dependantes)
TRUNCATE TABLE departement CASCADE;
```

| Aspect | `DELETE FROM table` | `TRUNCATE TABLE table` |
|---|---|---|
| **Vitesse** | Lent (supprime ligne par ligne) | Tres rapide (desalloue les pages) |
| **WHERE** | Oui | Non (tout ou rien) |
| **RETURNING** | Oui | Non |
| **Triggers** | Oui (FOR EACH ROW) | Non (sauf FOR EACH STATEMENT) |
| **Transactionnel** | Oui | Oui (en PostgreSQL !) |
| **VACUUM necessaire** | Oui | Non |
| **Reinitialiser SERIAL** | Non | Oui (avec RESTART IDENTITY) |

---

## 7. Fonctions d'agregation

Les fonctions d'agregation calculent une valeur a partir d'un **ensemble** de lignes.

### 7.1 Les fonctions de base

```sql
-- COUNT : nombre de lignes
SELECT COUNT(*) AS total FROM produit;                    -- toutes les lignes
SELECT COUNT(telephone) AS avec_tel FROM employe;          -- lignes ou telephone IS NOT NULL
SELECT COUNT(DISTINCT categorie) AS nb_categories FROM produit;  -- valeurs uniques

-- SUM : somme
SELECT SUM(prix) AS valeur_totale FROM produit WHERE en_stock = true;

-- AVG : moyenne
SELECT AVG(prix)::NUMERIC(10,2) AS prix_moyen FROM produit;

-- MIN / MAX
SELECT
    MIN(prix) AS moins_cher,
    MAX(prix) AS plus_cher,
    MAX(prix) - MIN(prix) AS ecart
FROM produit;

-- Tout en une requete
SELECT
    COUNT(*) AS total,
    SUM(prix) AS somme,
    AVG(prix)::NUMERIC(10,2) AS moyenne,
    MIN(prix) AS minimum,
    MAX(prix) AS maximum,
    STDDEV(prix)::NUMERIC(10,2) AS ecart_type
FROM produit;
```

> **Piege classique** : `AVG` et `SUM` ignorent les valeurs `NULL`. Si tu as 10 lignes dont 3 avec `NULL`, `AVG` calcule la moyenne sur 7 lignes, pas 10. Utilise `COALESCE(colonne, 0)` si tu veux traiter les `NULL` comme des zeros :

```sql
-- Moyenne sur les non-NULL uniquement (par defaut)
SELECT AVG(note) FROM avis; -- 4.2 (sur 7 avis non-NULL)

-- Moyenne incluant les NULL comme 0
SELECT AVG(COALESCE(note, 0)) FROM avis; -- 2.94 (sur 10 avis)
```

### 7.2 Fonctions d'agregation avancees

```sql
-- STRING_AGG : concatener des valeurs texte
SELECT
    categorie,
    STRING_AGG(nom, ', ' ORDER BY nom) AS produits
FROM produit
GROUP BY categorie;
-- peripherique | Clavier mecanique, Souris sans fil, Webcam HD

-- ARRAY_AGG : collecter les valeurs dans un tableau
SELECT
    categorie,
    ARRAY_AGG(nom ORDER BY prix DESC) AS produits
FROM produit
GROUP BY categorie;
-- peripherique | {Webcam HD, Clavier mecanique, Souris sans fil}

-- BOOL_AND / BOOL_OR
SELECT
    categorie,
    BOOL_AND(en_stock) AS tous_en_stock,
    BOOL_OR(en_stock) AS au_moins_un_en_stock
FROM produit
GROUP BY categorie;

-- PERCENTILE (fonctions d'ensemble ordonne)
SELECT
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY prix) AS mediane,
    PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY prix) AS p95
FROM produit;
```

---

## 8. GROUP BY et HAVING

### 8.1 GROUP BY

`GROUP BY` regroupe les lignes qui ont les memes valeurs et permet d'appliquer des fonctions d'agregation par groupe.

```sql
-- Nombre de produits par categorie
SELECT
    categorie,
    COUNT(*) AS nb_produits,
    AVG(prix)::NUMERIC(10,2) AS prix_moyen,
    MIN(prix) AS moins_cher,
    MAX(prix) AS plus_cher
FROM produit
GROUP BY categorie
ORDER BY nb_produits DESC;
```

```
 Resultat :
 ┌───────────────┬────────────┬────────────┬────────────┬───────────┐
 │  categorie    │ nb_produits│ prix_moyen │ moins_cher │ plus_cher │
 ├───────────────┼────────────┼────────────┼────────────┼───────────┤
 │ peripherique  │     3      │   61.66    │   34.99    │  89.99    │
 │ accessoire    │     2      │   24.99    │   19.99    │  29.99    │
 │ ecran         │     1      │  349.00    │  349.00    │ 349.00    │
 │ cable         │     1      │   12.50    │   12.50    │  12.50    │
 │ audio         │     1      │  149.99    │  149.99    │ 149.99    │
 └───────────────┴────────────┴────────────┴────────────┴───────────┘
```

> **Piege classique** : Toute colonne dans le `SELECT` qui n'est PAS dans une fonction d'agregation DOIT etre dans le `GROUP BY`. Sinon PostgreSQL ne sait pas quelle valeur afficher pour le groupe.

```sql
-- ERREUR : "nom" n'est ni dans GROUP BY ni dans une agregation
SELECT categorie, nom, COUNT(*) FROM produit GROUP BY categorie;
-- ERROR: column "produit.nom" must appear in the GROUP BY clause
-- or be used in an aggregate function

-- CORRECT
SELECT categorie, COUNT(*), STRING_AGG(nom, ', ') FROM produit GROUP BY categorie;
```

### 8.2 GROUP BY avec plusieurs colonnes

```sql
-- Statistiques par categorie ET par disponibilite
SELECT
    categorie,
    en_stock,
    COUNT(*) AS total,
    SUM(prix) AS valeur
FROM produit
GROUP BY categorie, en_stock
ORDER BY categorie, en_stock;
```

### 8.3 HAVING — filtrer les groupes

`HAVING` est au `GROUP BY` ce que `WHERE` est au `SELECT` : un filtre. Mais `HAVING` s'applique **apres** le regroupement, sur les resultats agreges.

```sql
-- Categories avec plus de 2 produits
SELECT
    categorie,
    COUNT(*) AS nb_produits
FROM produit
GROUP BY categorie
HAVING COUNT(*) > 2;

-- Categories dont le prix moyen depasse 50 EUR
SELECT
    categorie,
    AVG(prix)::NUMERIC(10,2) AS prix_moyen,
    COUNT(*) AS nb_produits
FROM produit
WHERE en_stock = true          -- WHERE filtre AVANT le GROUP BY
GROUP BY categorie
HAVING AVG(prix) > 50         -- HAVING filtre APRES le GROUP BY
ORDER BY prix_moyen DESC;
```

> **Ce qu'il faut retenir** : L'ordre d'execution logique d'une requete SQL est :
>
> 1. `FROM` (quelle table ?)
> 2. `WHERE` (filtrer les lignes)
> 3. `GROUP BY` (regrouper)
> 4. `HAVING` (filtrer les groupes)
> 5. `SELECT` (choisir les colonnes)
> 6. `DISTINCT` (eliminer les doublons)
> 7. `ORDER BY` (trier)
> 8. `LIMIT` / `OFFSET` (paginer)

```
 Ordre d'execution logique :
 ┌──────────┐
 │  FROM    │  1. Identifier la/les table(s)
 └────┬─────┘
      ▼
 ┌──────────┐
 │  WHERE   │  2. Filtrer les lignes individuelles
 └────┬─────┘
      ▼
 ┌──────────┐
 │ GROUP BY │  3. Regrouper les lignes restantes
 └────┬─────┘
      ▼
 ┌──────────┐
 │  HAVING  │  4. Filtrer les groupes
 └────┬─────┘
      ▼
 ┌──────────┐
 │  SELECT  │  5. Calculer les expressions, alias
 └────┬─────┘
      ▼
 ┌──────────┐
 │ ORDER BY │  6. Trier les resultats
 └────┬─────┘
      ▼
 ┌──────────┐
 │  LIMIT   │  7. Limiter le nombre de resultats
 └──────────┘
```

---

## 9. Sous-requetes

### 9.1 Sous-requete scalaire (retourne une seule valeur)

```sql
-- Produits plus chers que la moyenne
SELECT nom, prix
FROM produit
WHERE prix > (SELECT AVG(prix) FROM produit);

-- Employes du departement qui a le plus d'effectifs
SELECT nom, prenom
FROM employe
WHERE departement_id = (
    SELECT departement_id
    FROM employe
    GROUP BY departement_id
    ORDER BY COUNT(*) DESC
    LIMIT 1
);
```

### 9.2 Sous-requete avec IN

```sql
-- Employes qui travaillent dans un departement a Paris
SELECT nom, prenom
FROM employe
WHERE departement_id IN (
    SELECT id FROM departement WHERE ville = 'Paris'
);

-- Produits qui n'ont jamais ete commandes
SELECT nom
FROM produit
WHERE id NOT IN (
    SELECT DISTINCT produit_id FROM ligne_commande
    WHERE produit_id IS NOT NULL  -- IMPORTANT : eviter le piege NOT IN + NULL
);
```

> **Piege classique** : `NOT IN` avec une sous-requete qui contient des `NULL` retourne un ensemble VIDE. C'est contre-intuitif mais logique : `2 NOT IN (1, NULL)` → `NULL` (pas `true`), et `WHERE NULL` ne garde rien. Utilise `NOT EXISTS` a la place.

### 9.3 Sous-requete avec EXISTS

```sql
-- Employes qui ont au moins un projet
SELECT e.nom, e.prenom
FROM employe e
WHERE EXISTS (
    SELECT 1 FROM employe_projet ep WHERE ep.employe_id = e.id
);

-- Employes qui n'ont aucun projet
SELECT e.nom, e.prenom
FROM employe e
WHERE NOT EXISTS (
    SELECT 1 FROM employe_projet ep WHERE ep.employe_id = e.id
);
```

> **Ce qu'il faut retenir** : `EXISTS` est generalement **plus performant** que `IN` pour les sous-requetes correlees, car il s'arrete des qu'il trouve une correspondance (`short-circuit`). Privilegie `EXISTS` / `NOT EXISTS` quand c'est possible.

### 9.4 Sous-requete dans le FROM (table derivee)

```sql
-- Statistiques par categorie, puis filtrage
SELECT *
FROM (
    SELECT
        categorie,
        COUNT(*) AS nb,
        AVG(prix)::NUMERIC(10,2) AS prix_moyen
    FROM produit
    GROUP BY categorie
) AS stats
WHERE stats.nb >= 2 AND stats.prix_moyen > 30;
```

### 9.5 CTE (Common Table Expression) — WITH

Les CTE rendent les requetes complexes lisibles et maintenables.

```sql
-- Meme requete avec CTE (beaucoup plus lisible)
WITH stats_categorie AS (
    SELECT
        categorie,
        COUNT(*) AS nb,
        AVG(prix)::NUMERIC(10,2) AS prix_moyen
    FROM produit
    GROUP BY categorie
)
SELECT *
FROM stats_categorie
WHERE nb >= 2 AND prix_moyen > 30;

-- CTE multiples
WITH
employes_it AS (
    SELECT e.*
    FROM employe e
    JOIN departement d ON e.departement_id = d.id
    WHERE d.code = 'IT'
),
projets_actifs AS (
    SELECT *
    FROM projet
    WHERE fin IS NULL OR fin > CURRENT_DATE
)
SELECT
    e.nom,
    e.prenom,
    p.titre AS projet
FROM employes_it e
JOIN employe_projet ep ON e.id = ep.employe_id
JOIN projets_actifs p ON ep.projet_id = p.id;
```

---

## 10. Requetes parametrees et protection SQL injection (Node.js)

### 10.1 Le danger de l'injection SQL

```typescript
// MAUVAIS : injection SQL possible !!!
const nom = "'; DROP TABLE utilisateur; --";
const query = `SELECT * FROM utilisateur WHERE nom = '${nom}'`;
// Resultat : SELECT * FROM utilisateur WHERE nom = ''; DROP TABLE utilisateur; --'
// La table est SUPPRIMEE !
```

> **Analogie** : L'injection SQL, c'est comme si tu demandais a quelqu'un de remplir un formulaire, et au lieu d'ecrire son nom, il ecrit des instructions qui modifient le formulaire lui-meme. Les requetes parametrees empechent cela en separant les donnees des instructions.

### 10.2 Requetes parametrees avec pg

```typescript
// fichier : securise.mjs
// Demonstration de requetes parametrees securisees

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'cours',
  user: 'postgres',
  password: 'postgres',
});

async function main() {
  // BON : requete parametree avec $1, $2, $3
  // Les valeurs sont envoyees separement du SQL → impossible d'injecter
  const nom = "O'Brien";  // meme les apostrophes sont gerees
  const resultat = await pool.query(
    'SELECT * FROM employe WHERE nom = $1',
    [nom]
  );
  console.log('Resultats :', resultat.rows);

  // INSERT parametree
  const nouvel_employe = {
    prenom: 'Jean',
    nom: 'Dupont',
    email: 'jean.dupont@example.com',
    poste: 'Developpeur',
    salaire: 45000,
  };

  const insertion = await pool.query(
    `INSERT INTO employe (prenom, nom, email, poste, salaire)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      nouvel_employe.prenom,
      nouvel_employe.nom,
      nouvel_employe.email,
      nouvel_employe.poste,
      nouvel_employe.salaire,
    ]
  );
  console.log('Employe cree avec ID :', insertion.rows[0].id);

  // SELECT avec plusieurs parametres
  const recherche = await pool.query(
    `SELECT nom, prenom, salaire
     FROM employe
     WHERE salaire BETWEEN $1 AND $2
       AND departement_id = $3
     ORDER BY salaire DESC`,
    [30000, 60000, 1]
  );
  console.log('Employes trouves :', recherche.rows.length);

  // UPDATE parametree
  const mise_a_jour = await pool.query(
    `UPDATE employe
     SET salaire = $1, modifie_le = now()
     WHERE id = $2
     RETURNING nom, salaire`,
    [48000, insertion.rows[0].id]
  );
  console.log('Mis a jour :', mise_a_jour.rows[0]);

  // DELETE parametree
  const suppression = await pool.query(
    'DELETE FROM employe WHERE id = $1 RETURNING nom',
    [insertion.rows[0].id]
  );
  console.log('Supprime :', suppression.rows[0].nom);

  await pool.end();
}

main();
```

### 10.3 Pattern d'acces aux donnees (DAO)

```typescript
// fichier : dao/produit-dao.mjs
// Data Access Object pour la table produit

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'cours',
  user: 'postgres',
  password: 'postgres',
});

export const produitDAO = {
  // Lire tous les produits
  async findAll({ limit = 20, offset = 0 } = {}) {
    const { rows } = await pool.query(
      'SELECT * FROM produit ORDER BY id LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    return rows;
  },

  // Lire un produit par ID
  async findById(id) {
    const { rows } = await pool.query(
      'SELECT * FROM produit WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  },

  // Rechercher par nom (insensible a la casse)
  async searchByNom(terme) {
    const { rows } = await pool.query(
      'SELECT * FROM produit WHERE nom ILIKE $1 ORDER BY nom',
      [`%${terme}%`]
    );
    return rows;
  },

  // Creer un produit
  async create({ nom, prix, categorie }) {
    const { rows } = await pool.query(
      `INSERT INTO produit (nom, prix, categorie)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [nom, prix, categorie]
    );
    return rows[0];
  },

  // Mettre a jour un produit
  async update(id, { nom, prix, categorie }) {
    const { rows } = await pool.query(
      `UPDATE produit
       SET nom = COALESCE($1, nom),
           prix = COALESCE($2, prix),
           categorie = COALESCE($3, categorie),
           modifie_le = now()
       WHERE id = $4
       RETURNING *`,
      [nom, prix, categorie, id]
    );
    return rows[0] || null;
  },

  // Supprimer un produit
  async delete(id) {
    const { rows } = await pool.query(
      'DELETE FROM produit WHERE id = $1 RETURNING *',
      [id]
    );
    return rows[0] || null;
  },
};
```

---

## 11. COPY et bulk operations

### 11.1 COPY — import/export haute performance

```sql
-- Exporter une table vers un fichier CSV
COPY produit TO '/tmp/produits.csv' WITH (FORMAT csv, HEADER true);

-- Importer un fichier CSV dans une table
COPY produit (nom, prix, categorie)
FROM '/tmp/produits.csv'
WITH (FORMAT csv, HEADER true);

-- Avec des options avancees
COPY produit TO '/tmp/produits.csv'
WITH (
    FORMAT csv,
    HEADER true,
    DELIMITER ';',
    NULL 'N/A',
    QUOTE '"',
    ENCODING 'UTF8'
);
```

### 11.2 \copy depuis psql (cote client)

```sql
-- \copy fonctionne cote client (pas besoin d'acces filesystem serveur)
\copy produit TO 'produits.csv' WITH (FORMAT csv, HEADER true)
\copy produit FROM 'produits.csv' WITH (FORMAT csv, HEADER true)
```

### 11.3 Bulk insert depuis Node.js

```typescript
// fichier : bulk-insert.mjs
// Insertion massive avec pg-copy-streams ou multi-VALUES

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'cours',
  user: 'postgres',
  password: 'postgres',
});

// Methode 1 : Multi-VALUES (bon pour < 10 000 lignes)
async function bulkInsertValues(produits) {
  // Construire la requete parametree dynamiquement
  const valeurs = [];
  const params = [];
  let index = 1;

  for (const p of produits) {
    valeurs.push(`($${index++}, $${index++}, $${index++})`);
    params.push(p.nom, p.prix, p.categorie);
  }

  const sql = `
    INSERT INTO produit (nom, prix, categorie)
    VALUES ${valeurs.join(', ')}
    RETURNING id
  `;

  const { rows } = await pool.query(sql, params);
  return rows;
}

// Methode 2 : UNNEST (plus propre, recommandee pour PostgreSQL)
async function bulkInsertUnnest(produits) {
  const noms = produits.map(p => p.nom);
  const prix = produits.map(p => p.prix);
  const categories = produits.map(p => p.categorie);

  const { rows } = await pool.query(
    `INSERT INTO produit (nom, prix, categorie)
     SELECT * FROM UNNEST($1::text[], $2::numeric[], $3::text[])
     RETURNING id`,
    [noms, prix, categories]
  );
  return rows;
}

// Utilisation
async function main() {
  const produits = Array.from({ length: 1000 }, (_, i) => ({
    nom: `Produit ${i + 1}`,
    prix: Math.round(Math.random() * 10000) / 100,
    categorie: ['electronique', 'vetement', 'alimentation'][i % 3],
  }));

  console.time('Multi-VALUES');
  const ids1 = await bulkInsertValues(produits);
  console.timeEnd('Multi-VALUES');
  console.log(`${ids1.length} produits inseres.`);

  await pool.end();
}

main();
```

---

## 12. Exercice mental

Avant de passer au module suivant, ecris mentalement (ou sur papier) les requetes pour :

1. **Trouver les 5 produits les plus chers** de la categorie 'electronique'
2. **Compter le nombre d'employes par departement**, en n'affichant que les departements avec plus de 3 employes
3. **Trouver les produits dont le prix est superieur a la moyenne de leur categorie** (indice : sous-requete correlee)
4. **Faire un upsert** : inserer un employe, et si l'email existe deja, mettre a jour le nom et le poste

### Solutions

```sql
-- 1. Top 5 produits les plus chers en electronique
SELECT nom, prix
FROM produit
WHERE categorie = 'electronique'
ORDER BY prix DESC
LIMIT 5;

-- 2. Departements avec plus de 3 employes
SELECT d.nom, COUNT(*) AS effectif
FROM employe e
JOIN departement d ON e.departement_id = d.id
GROUP BY d.nom
HAVING COUNT(*) > 3
ORDER BY effectif DESC;

-- 3. Produits plus chers que la moyenne de leur categorie
SELECT p.nom, p.prix, p.categorie
FROM produit p
WHERE p.prix > (
    SELECT AVG(p2.prix)
    FROM produit p2
    WHERE p2.categorie = p.categorie
);

-- 4. Upsert employe
INSERT INTO employe (prenom, nom, email, poste)
VALUES ('Marie', 'Curie', 'marie.curie@lab.fr', 'Chercheur')
ON CONFLICT (email) DO UPDATE
SET nom = EXCLUDED.nom,
    poste = EXCLUDED.poste,
    modifie_le = now();
```

---

## Navigation

| | Lien |
|---|---|
| Module precedent | [Module 01 — Le modele relationnel](./01-modele-relationnel.md) |
| Module suivant | [Module 03 — Relations & Jointures](./03-relations-et-jointures.md) |
| Lab associe | [Lab 02 — CRUD operations](../labs/lab-02.md) |

---

> **Ce qu'il faut retenir** : Les operations CRUD sont le pain quotidien du developpeur SQL. `INSERT ... RETURNING` et `ON CONFLICT` sont des outils puissants specifiques a PostgreSQL. Utilise TOUJOURS des requetes parametrees ($1, $2...) en Node.js pour te proteger des injections SQL. Les fonctions d'agregation + GROUP BY + HAVING forment un trio indispensable pour l'analyse de donnees.
