# Module 12 — Fonctions avancees SQL

> **Objectif** : Maitriser les Window Functions, les CTEs (y compris recursives), les LATERAL joins et les outils analytiques avances de PostgreSQL.
>
> **Difficulte** : ⭐⭐⭐

---

## 1. Window Functions — La revolution analytique

### 1.1 Le concept

Les **Window Functions** (fonctions de fenetrage) permettent de faire des calculs sur un ensemble de lignes **sans reduire le nombre de lignes** du resultat. Contrairement a GROUP BY qui agrege les lignes, une Window Function les **enrichit**.

> **Analogie** : Imaginez un classement de marathon. Avec GROUP BY, vous obtenez le temps moyen par categorie. Avec une Window Function, chaque coureur garde sa ligne **et** voit son rang, le temps du precedent, le cumul des temps, etc.

```
GROUP BY (agrege) :                 Window Function (enrichit) :

│ categorie │ avg_time │            │ nom    │ time  │ rank │ avg_cat │
├───────────┼──────────┤            ├────────┼───────┼──────┼─────────┤
│ Senior    │ 3:45:00  │            │ Alice  │ 3:30  │ 1    │ 3:45    │
│ Junior    │ 4:10:00  │            │ Bob    │ 3:50  │ 2    │ 3:45    │
                                    │ Charlie│ 3:55  │ 3    │ 3:45    │
  3 lignes → 2 lignes              │ David  │ 4:00  │ 1    │ 4:10    │
                                    │ Eve    │ 4:20  │ 2    │ 4:10    │

                                     5 lignes → 5 lignes (enrichies)
```

### 1.2 Syntaxe generale

```sql
fonction_fenetre() OVER (
    PARTITION BY colonne_partitionnement
    ORDER BY colonne_tri
    frame_clause
)
```

| Element | Role | Analogie |
|---------|------|----------|
| `OVER (...)` | Definit la "fenetre" | Le cadre de la photo |
| `PARTITION BY` | Regroupe (comme GROUP BY mais sans agreger) | Les categories |
| `ORDER BY` | Trie a l'interieur de chaque partition | L'ordre de classement |
| Frame clause | Delimite les lignes a considerer | Le zoom |

### 1.3 Preparation des donnees d'exemple

```sql
CREATE TABLE ventes (
    id         SERIAL PRIMARY KEY,
    vendeur    TEXT NOT NULL,
    region     TEXT NOT NULL,
    montant    NUMERIC(10,2) NOT NULL,
    date_vente DATE NOT NULL
);

INSERT INTO ventes (vendeur, region, montant, date_vente) VALUES
    ('Alice',   'Nord',  1500, '2025-01-15'),
    ('Alice',   'Nord',  2000, '2025-02-10'),
    ('Alice',   'Nord',  1800, '2025-03-05'),
    ('Bob',     'Nord',  1200, '2025-01-20'),
    ('Bob',     'Nord',  1600, '2025-02-15'),
    ('Charlie', 'Sud',   2200, '2025-01-10'),
    ('Charlie', 'Sud',   1900, '2025-02-20'),
    ('Charlie', 'Sud',   2500, '2025-03-15'),
    ('David',   'Sud',   1100, '2025-01-25'),
    ('David',   'Sud',   1400, '2025-02-28'),
    ('David',   'Sud',   1700, '2025-03-20');
```

---

### 1.4 ROW_NUMBER() — Numerotation

Attribue un numero unique a chaque ligne dans la partition.

```sql
-- Numerotation par region, tri par montant decroissant
SELECT
    vendeur,
    region,
    montant,
    ROW_NUMBER() OVER (
        PARTITION BY region
        ORDER BY montant DESC
    ) AS rang
FROM ventes;
```

```
 vendeur  │ region │ montant │ rang
──────────┼────────┼─────────┼──────
 Alice    │ Nord   │ 2000.00 │  1
 Alice    │ Nord   │ 1800.00 │  2
 Bob      │ Nord   │ 1600.00 │  3
 Alice    │ Nord   │ 1500.00 │  4
 Bob      │ Nord   │ 1200.00 │  5
 Charlie  │ Sud    │ 2500.00 │  1
 Charlie  │ Sud    │ 2200.00 │  2
 Charlie  │ Sud    │ 1900.00 │  3
 David    │ Sud    │ 1700.00 │  4
 David    │ Sud    │ 1400.00 │  5
 David    │ Sud    │ 1100.00 │  6
```

**Cas d'usage : pagination keyset**

```sql
-- Page 1 (10 premiers)
SELECT * FROM (
    SELECT
        *,
        ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS rn
    FROM articles
) sub
WHERE rn BETWEEN 1 AND 10;

-- Page 2 (11-20)
-- ... WHERE rn BETWEEN 11 AND 20;
```

### 1.5 RANK() et DENSE_RANK() — Classements

```sql
-- Comparaison RANK vs DENSE_RANK vs ROW_NUMBER
SELECT
    vendeur,
    montant,
    ROW_NUMBER() OVER (ORDER BY montant DESC) AS row_num,
    RANK()       OVER (ORDER BY montant DESC) AS rank,
    DENSE_RANK() OVER (ORDER BY montant DESC) AS dense_rank
FROM ventes;
```

| Fonction | Ex-aequo a 1500 | Prochain rang |
|----------|-----------------|---------------|
| ROW_NUMBER() | 7, 8 | 9 |
| RANK() | 7, 7 | **9** (saute le 8) |
| DENSE_RANK() | 7, 7 | **8** (pas de saut) |

### 1.6 LAG() et LEAD() — Lignes precedente/suivante

```sql
-- Comparer chaque vente avec la precedente du meme vendeur
SELECT
    vendeur,
    date_vente,
    montant,
    LAG(montant) OVER (
        PARTITION BY vendeur ORDER BY date_vente
    ) AS montant_precedent,
    montant - LAG(montant) OVER (
        PARTITION BY vendeur ORDER BY date_vente
    ) AS variation
FROM ventes
ORDER BY vendeur, date_vente;
```

```
 vendeur │ date_vente │ montant │ montant_precedent │ variation
─────────┼────────────┼─────────┼───────────────────┼──────────
 Alice   │ 2025-01-15 │ 1500.00 │            NULL   │    NULL
 Alice   │ 2025-02-10 │ 2000.00 │         1500.00   │  500.00
 Alice   │ 2025-03-05 │ 1800.00 │         2000.00   │ -200.00
 Bob     │ 2025-01-20 │ 1200.00 │            NULL   │    NULL
 Bob     │ 2025-02-15 │ 1600.00 │         1200.00   │  400.00
```

```sql
-- LEAD : voir la vente suivante
SELECT
    vendeur,
    date_vente,
    montant,
    LEAD(montant, 1, 0) OVER (
        PARTITION BY vendeur ORDER BY date_vente
    ) AS montant_suivant
    -- LEAD(valeur, offset, defaut)
FROM ventes;
```

### 1.7 SUM() OVER — Totaux cumules (Running totals)

```sql
-- Total cumule des ventes par vendeur
SELECT
    vendeur,
    date_vente,
    montant,
    SUM(montant) OVER (
        PARTITION BY vendeur
        ORDER BY date_vente
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS cumul
FROM ventes
ORDER BY vendeur, date_vente;
```

```
 vendeur │ date_vente │ montant │  cumul
─────────┼────────────┼─────────┼─────────
 Alice   │ 2025-01-15 │ 1500.00 │ 1500.00
 Alice   │ 2025-02-10 │ 2000.00 │ 3500.00
 Alice   │ 2025-03-05 │ 1800.00 │ 5300.00
 Bob     │ 2025-01-20 │ 1200.00 │ 1200.00
 Bob     │ 2025-02-15 │ 1600.00 │ 2800.00
```

### 1.8 FIRST_VALUE / LAST_VALUE / NTH_VALUE

```sql
-- Premier et dernier montant par vendeur
SELECT DISTINCT ON (vendeur)
    vendeur,
    FIRST_VALUE(montant) OVER w AS premiere_vente,
    LAST_VALUE(montant) OVER w AS derniere_vente,
    NTH_VALUE(montant, 2) OVER w AS deuxieme_vente
FROM ventes
WINDOW w AS (
    PARTITION BY vendeur
    ORDER BY date_vente
    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
);
```

> **Piege classique** : `LAST_VALUE` retourne souvent la ligne courante car le frame par defaut est `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. Il faut explicitement specifier `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`.

### 1.9 Window frames

```sql
-- Moyenne mobile sur 3 periodes
SELECT
    vendeur,
    date_vente,
    montant,
    ROUND(AVG(montant) OVER (
        PARTITION BY vendeur
        ORDER BY date_vente
        ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING
    ), 2) AS moyenne_mobile_3
FROM ventes;
```

| Frame | Signification |
|-------|---------------|
| `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` | Du debut a la ligne courante |
| `ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING` | 1 avant + courante + 1 apres |
| `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` | Toutes les lignes de la partition |
| `ROWS BETWEEN 3 PRECEDING AND CURRENT ROW` | 3 precedentes + courante |

```
Frame ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING :

  Ligne 1  ←─ precedente
  Ligne 2  ←─ COURANTE        ──► AVG(ligne1, ligne2, ligne3)
  Ligne 3  ←─ suivante
  Ligne 4
  Ligne 5
```

---

## 2. CTEs (Common Table Expressions)

### 2.1 WITH ... AS — Sous-requetes nommees

```sql
-- SANS CTE (sous-requete imbriquee, difficile a lire)
SELECT v.vendeur, v.total, m.moy_region
FROM (
    SELECT vendeur, region, SUM(montant) AS total
    FROM ventes GROUP BY vendeur, region
) v
JOIN (
    SELECT region, AVG(total) AS moy_region
    FROM (
        SELECT vendeur, region, SUM(montant) AS total
        FROM ventes GROUP BY vendeur, region
    ) sub
    GROUP BY region
) m ON v.region = m.region;

-- AVEC CTE (lisible, maintenable)
WITH totaux_vendeur AS (
    SELECT vendeur, region, SUM(montant) AS total
    FROM ventes
    GROUP BY vendeur, region
),
moyenne_region AS (
    SELECT region, AVG(total) AS moy_region
    FROM totaux_vendeur
    GROUP BY region
)
SELECT
    tv.vendeur,
    tv.total,
    mr.moy_region
FROM totaux_vendeur tv
JOIN moyenne_region mr ON tv.region = mr.region;
```

### 2.2 Materialisee vs non-materialisee

```sql
-- PostgreSQL 12+ : controle de la materialisation

-- MATERIALIZED : la CTE est executee une seule fois,
-- le resultat est stocke en memoire temporaire
WITH stats AS MATERIALIZED (
    SELECT region, COUNT(*) AS nb, SUM(montant) AS total
    FROM ventes
    GROUP BY region
)
SELECT * FROM stats WHERE nb > 3;

-- NOT MATERIALIZED : la CTE est "inlinee" dans la requete principale
-- (le planner peut la fusionner et optimiser)
WITH stats AS NOT MATERIALIZED (
    SELECT region, COUNT(*) AS nb, SUM(montant) AS total
    FROM ventes
    GROUP BY region
)
SELECT * FROM stats WHERE nb > 3;
```

| Mode | Comportement | Cas d'usage |
|------|-------------|-------------|
| MATERIALIZED | Execute une fois, resultat en memoire | CTE utilisee plusieurs fois, ou pour forcer un plan |
| NOT MATERIALIZED | Inlinee (comme une sous-requete) | CTE utilisee une fois, pour que le planner optimise |
| (par defaut PG 12+) | NOT MATERIALIZED si utilisee une seule fois | - |

---

## 3. CTEs recursives

### 3.1 WITH RECURSIVE — Le concept

> **Analogie** : Imaginez un arbre genealogique. Pour trouver tous les descendants d'une personne, vous devez regarder ses enfants, puis les enfants de ses enfants, etc. C'est une operation **recursive** : chaque etape decouvre de nouvelles lignes qui alimentent l'etape suivante.

```sql
WITH RECURSIVE nom_cte AS (
    -- Terme initial (anchor) : le point de depart
    SELECT ... FROM ... WHERE ...

    UNION ALL

    -- Terme recursif : reference nom_cte (lui-meme)
    SELECT ... FROM ... JOIN nom_cte ON ...
)
SELECT * FROM nom_cte;
```

```
Execution :

Etape 0 : Terme initial → resultats R0
Etape 1 : Terme recursif avec R0 → nouveaux resultats R1
Etape 2 : Terme recursif avec R1 → nouveaux resultats R2
...
Etape N : Terme recursif avec R(N-1) → ensemble vide → STOP

Resultat final = R0 ∪ R1 ∪ R2 ∪ ... ∪ R(N-1)
```

### 3.2 Cas d'usage : Organigramme (employe → manager)

```sql
CREATE TABLE employes (
    id         SERIAL PRIMARY KEY,
    nom        TEXT NOT NULL,
    manager_id INT REFERENCES employes(id)
);

INSERT INTO employes (id, nom, manager_id) VALUES
    (1, 'CEO Pierre',     NULL),
    (2, 'CTO Marie',      1),
    (3, 'CFO Jean',       1),
    (4, 'Dev Alice',      2),
    (5, 'Dev Bob',        2),
    (6, 'DevOps Charlie', 2),
    (7, 'Compta David',   3),
    (8, 'Compta Eve',     3),
    (9, 'Junior Frank',   4);
```

```
Organigramme :

          CEO Pierre (1)
          ├── CTO Marie (2)
          │   ├── Dev Alice (4)
          │   │   └── Junior Frank (9)
          │   ├── Dev Bob (5)
          │   └── DevOps Charlie (6)
          └── CFO Jean (3)
              ├── Compta David (7)
              └── Compta Eve (8)
```

```sql
-- Trouver tous les subordonnes (directs et indirects) de Marie (id=2)
WITH RECURSIVE subordonnes AS (
    -- Anchor : Marie elle-meme
    SELECT id, nom, manager_id, 0 AS niveau
    FROM employes
    WHERE id = 2

    UNION ALL

    -- Recursif : les employes dont le manager est dans les subordonnes
    SELECT e.id, e.nom, e.manager_id, s.niveau + 1
    FROM employes e
    JOIN subordonnes s ON e.manager_id = s.id
)
SELECT
    REPEAT('  ', niveau) || nom AS hierarchie,
    niveau
FROM subordonnes
ORDER BY niveau, nom;
```

```
    hierarchie      │ niveau
────────────────────┼────────
CTO Marie           │      0
  Dev Alice         │      1
  Dev Bob           │      1
  DevOps Charlie    │      1
    Junior Frank    │      2
```

### 3.3 Cas d'usage : Categories hierarchiques

```sql
CREATE TABLE categories (
    id        SERIAL PRIMARY KEY,
    nom       TEXT NOT NULL,
    parent_id INT REFERENCES categories(id)
);

INSERT INTO categories (id, nom, parent_id) VALUES
    (1, 'Electronique', NULL),
    (2, 'Ordinateurs', 1),
    (3, 'Portables', 2),
    (4, 'Fixes', 2),
    (5, 'Smartphones', 1),
    (6, 'Apple', 5),
    (7, 'Samsung', 5),
    (8, 'Vetements', NULL),
    (9, 'Homme', 8),
    (10, 'Femme', 8);

-- Chemin complet de chaque categorie (breadcrumb)
WITH RECURSIVE chemin AS (
    SELECT id, nom, parent_id,
           nom::TEXT AS chemin_complet,
           ARRAY[id] AS path
    FROM categories
    WHERE parent_id IS NULL

    UNION ALL

    SELECT c.id, c.nom, c.parent_id,
           ch.chemin_complet || ' > ' || c.nom,
           ch.path || c.id
    FROM categories c
    JOIN chemin ch ON c.parent_id = ch.id
)
SELECT chemin_complet FROM chemin ORDER BY path;
```

```
 chemin_complet
─────────────────────────────────────
 Electronique
 Electronique > Ordinateurs
 Electronique > Ordinateurs > Portables
 Electronique > Ordinateurs > Fixes
 Electronique > Smartphones
 Electronique > Smartphones > Apple
 Electronique > Smartphones > Samsung
 Vetements
 Vetements > Homme
 Vetements > Femme
```

### 3.4 Detection de boucles infinies (CYCLE)

```sql
-- PostgreSQL 14+ : clause CYCLE
WITH RECURSIVE graph AS (
    SELECT id, nom, parent_id, ARRAY[id] AS visited
    FROM categories
    WHERE parent_id IS NULL

    UNION ALL

    SELECT c.id, c.nom, c.parent_id, g.visited || c.id
    FROM categories c
    JOIN graph g ON c.parent_id = g.id
    WHERE c.id != ALL(g.visited)  -- Eviter les boucles !
)
SELECT * FROM graph;

-- PostgreSQL 14+ : syntaxe CYCLE native
WITH RECURSIVE graph AS (
    SELECT id, nom, parent_id
    FROM categories
    WHERE parent_id IS NULL

    UNION ALL

    SELECT c.id, c.nom, c.parent_id
    FROM categories c
    JOIN graph g ON c.parent_id = g.id
)
CYCLE id SET is_cycle USING path
SELECT * FROM graph WHERE NOT is_cycle;
```

### 3.5 Generation de series avec CTE recursive

```sql
-- Generer les dates d'un mois
WITH RECURSIVE dates AS (
    SELECT DATE '2025-03-01' AS jour

    UNION ALL

    SELECT jour + 1
    FROM dates
    WHERE jour < '2025-03-31'
)
SELECT jour, TO_CHAR(jour, 'Day') AS jour_semaine
FROM dates;

-- Equivalent plus simple :
SELECT generate_series('2025-03-01'::date, '2025-03-31'::date, '1 day')::date;
```

---

## 4. LATERAL joins

### 4.1 Principe

Un **LATERAL join** permet a une sous-requete dans FROM de **referencer** des colonnes des tables precedentes (ce qu'un JOIN normal ne peut pas faire).

> **Analogie** : Imaginez un formulaire ou chaque champ depend du precedent. Un LATERAL join, c'est comme un champ "ville" qui depend du champ "pays" selectionne juste avant. La sous-requete peut "voir" les valeurs de la table de gauche.

```sql
-- IMPOSSIBLE sans LATERAL :
SELECT v.vendeur, top3.*
FROM (SELECT DISTINCT vendeur FROM ventes) v
JOIN (
    SELECT montant FROM ventes
    WHERE vendeur = v.vendeur  -- ERREUR : v n'est pas visible ici !
    LIMIT 3
) top3 ON true;

-- POSSIBLE avec LATERAL :
SELECT v.vendeur, top3.*
FROM (SELECT DISTINCT vendeur FROM ventes) v
JOIN LATERAL (
    SELECT montant, date_vente
    FROM ventes
    WHERE vendeur = v.vendeur  -- v est visible grace a LATERAL !
    ORDER BY montant DESC
    LIMIT 3
) top3 ON true;
```

### 4.2 Cas d'usage : Top-N par groupe

```sql
-- Les 2 meilleures ventes par region
SELECT
    r.region,
    top.vendeur,
    top.montant,
    top.date_vente
FROM (SELECT DISTINCT region FROM ventes) r
CROSS JOIN LATERAL (
    SELECT vendeur, montant, date_vente
    FROM ventes v
    WHERE v.region = r.region
    ORDER BY montant DESC
    LIMIT 2
) top;
```

```
 region │ vendeur  │ montant │ date_vente
────────┼──────────┼─────────┼────────────
 Nord   │ Alice    │ 2000.00 │ 2025-02-10
 Nord   │ Alice    │ 1800.00 │ 2025-03-05
 Sud    │ Charlie  │ 2500.00 │ 2025-03-15
 Sud    │ Charlie  │ 2200.00 │ 2025-01-10
```

### 4.3 LATERAL vs Window Function vs sous-requete

| Approche | Top-N par groupe | Performance | Lisibilite |
|----------|-----------------|-------------|------------|
| ROW_NUMBER() + WHERE | Oui | Bonne | Moyenne |
| LATERAL + LIMIT | Oui | **Excellente** (utilise les index) | Bonne |
| Sous-requete correlee | Oui | Mauvaise | Mauvaise |

```sql
-- Approche Window Function (equivalent)
SELECT * FROM (
    SELECT
        vendeur, region, montant, date_vente,
        ROW_NUMBER() OVER (
            PARTITION BY region ORDER BY montant DESC
        ) AS rn
    FROM ventes
) sub
WHERE rn <= 2;
```

### 4.4 LATERAL pour la denormalisation

```sql
-- Enrichir chaque commande avec le dernier commentaire
SELECT
    o.id AS order_id,
    o.total,
    latest_comment.body,
    latest_comment.created_at
FROM orders o
LEFT JOIN LATERAL (
    SELECT body, created_at
    FROM comments c
    WHERE c.order_id = o.id
    ORDER BY created_at DESC
    LIMIT 1
) latest_comment ON true;
```

---

## 5. UNION / INTERSECT / EXCEPT

### 5.1 Les operateurs ensemblistes

```sql
-- UNION : combine (elimine les doublons)
SELECT vendeur FROM ventes WHERE region = 'Nord'
UNION
SELECT vendeur FROM ventes WHERE region = 'Sud';

-- UNION ALL : combine (garde les doublons, plus rapide)
SELECT vendeur FROM ventes WHERE region = 'Nord'
UNION ALL
SELECT vendeur FROM ventes WHERE region = 'Sud';

-- INTERSECT : elements communs
SELECT vendeur FROM ventes WHERE region = 'Nord'
INTERSECT
SELECT vendeur FROM ventes WHERE montant > 2000;

-- EXCEPT : elements dans A mais pas dans B
SELECT vendeur FROM ventes WHERE region = 'Nord'
EXCEPT
SELECT vendeur FROM ventes WHERE montant < 1300;
```

| Operateur | Doublons | Performance |
|-----------|----------|-------------|
| UNION | Elimines (DISTINCT implicite) | Plus lent |
| UNION ALL | Conserves | Plus rapide |
| INTERSECT | Elimines | - |
| EXCEPT | Elimines | - |

---

## 6. CASE WHEN / COALESCE / NULLIF

### 6.1 CASE WHEN — Le switch SQL

```sql
-- Classification des ventes
SELECT
    vendeur,
    montant,
    CASE
        WHEN montant >= 2000 THEN 'Excellent'
        WHEN montant >= 1500 THEN 'Bon'
        WHEN montant >= 1000 THEN 'Moyen'
        ELSE 'Faible'
    END AS performance
FROM ventes;

-- CASE simple (comparaison d'egalite)
SELECT
    region,
    CASE region
        WHEN 'Nord' THEN 'Regions septentrionales'
        WHEN 'Sud'  THEN 'Regions meridionales'
        ELSE 'Autre'
    END AS description
FROM ventes;
```

### 6.2 COALESCE — Premiere valeur non-NULL

```sql
-- Remplacer les NULLs
SELECT
    nom,
    COALESCE(telephone, email, 'Aucun contact') AS contact
FROM clients;

-- Equivalent a :
-- CASE WHEN telephone IS NOT NULL THEN telephone
--      WHEN email IS NOT NULL THEN email
--      ELSE 'Aucun contact' END
```

### 6.3 NULLIF — Retourner NULL si egal

```sql
-- Eviter la division par zero
SELECT
    region,
    total_ventes / NULLIF(nombre_vendeurs, 0) AS moyenne
FROM stats_region;
-- Si nombre_vendeurs = 0, NULLIF retourne NULL
-- et la division retourne NULL au lieu d'une erreur
```

---

## 7. FILTER clause avec agregats

```sql
-- Compter conditionnellement (PostgreSQL 9.4+)
SELECT
    region,
    COUNT(*) AS total_ventes,
    COUNT(*) FILTER (WHERE montant >= 2000) AS ventes_excellentes,
    COUNT(*) FILTER (WHERE montant < 1500) AS ventes_faibles,
    SUM(montant) FILTER (WHERE date_vente >= '2025-03-01') AS total_mars
FROM ventes
GROUP BY region;
```

```
 region │ total │ excellentes │ faibles │ total_mars
────────┼───────┼─────────────┼─────────┼────────────
 Nord   │     5 │           1 │       1 │    1800.00
 Sud    │     6 │           2 │       1 │    4200.00
```

| Ancienne syntaxe (CASE) | Nouvelle syntaxe (FILTER) |
|---|---|
| `SUM(CASE WHEN x > 10 THEN 1 ELSE 0 END)` | `COUNT(*) FILTER (WHERE x > 10)` |
| Plus verbeux, moins clair | Concis, intention claire |

---

## 8. GROUPING SETS, CUBE, ROLLUP

### 8.1 GROUPING SETS — Plusieurs GROUP BY en une requete

```sql
-- Au lieu de 3 requetes separees :
SELECT region, vendeur, SUM(montant) FROM ventes GROUP BY region, vendeur
UNION ALL
SELECT region, NULL, SUM(montant) FROM ventes GROUP BY region
UNION ALL
SELECT NULL, NULL, SUM(montant) FROM ventes;

-- Utilisez GROUPING SETS :
SELECT
    region,
    vendeur,
    SUM(montant) AS total
FROM ventes
GROUP BY GROUPING SETS (
    (region, vendeur),  -- Detail par region + vendeur
    (region),           -- Sous-total par region
    ()                  -- Total general
)
ORDER BY region NULLS LAST, vendeur NULLS LAST;
```

```
 region │ vendeur  │   total
────────┼──────────┼──────────
 Nord   │ Alice    │  5300.00
 Nord   │ Bob      │  2800.00
 Nord   │ NULL     │  8100.00  ← sous-total Nord
 Sud    │ Charlie  │  6600.00
 Sud    │ David    │  4200.00
 Sud    │ NULL     │ 10800.00  ← sous-total Sud
 NULL   │ NULL     │ 18900.00  ← TOTAL GENERAL
```

### 8.2 ROLLUP — Sous-totaux hierarchiques

```sql
-- ROLLUP(a, b) = GROUPING SETS((a,b), (a), ())
SELECT
    region,
    vendeur,
    SUM(montant) AS total
FROM ventes
GROUP BY ROLLUP (region, vendeur)
ORDER BY region NULLS LAST, vendeur NULLS LAST;
-- Meme resultat que ci-dessus
```

### 8.3 CUBE — Toutes les combinaisons

```sql
-- CUBE(a, b) = GROUPING SETS((a,b), (a), (b), ())
SELECT
    region,
    vendeur,
    SUM(montant) AS total
FROM ventes
GROUP BY CUBE (region, vendeur)
ORDER BY region NULLS LAST, vendeur NULLS LAST;
-- Inclut aussi les totaux par vendeur (toutes regions)
```

### 8.4 GROUPING() — Distinguer NULL reel vs sous-total

```sql
SELECT
    CASE WHEN GROUPING(region) = 1 THEN 'TOUTES' ELSE region END AS region,
    CASE WHEN GROUPING(vendeur) = 1 THEN 'TOUS' ELSE vendeur END AS vendeur,
    SUM(montant) AS total
FROM ventes
GROUP BY ROLLUP (region, vendeur)
ORDER BY GROUPING(region), region, GROUPING(vendeur), vendeur;
```

---

## 9. Exercice mental

> **Exercice mental** : Vous avez une table `logs` avec des millions de lignes. Vous devez trouver, pour chaque utilisateur, sa session la plus longue (ecart maximum entre deux actions consecutives inferieur a 30 minutes). Quelles fonctions utiliseriez-vous ?

<details>
<summary>Reponse</summary>

1. **LAG()** pour calculer le temps entre chaque action et la precedente
2. **CASE WHEN** pour detecter les debuts de session (ecart > 30 min)
3. **SUM() OVER** pour creer un identifiant de session (cumul des debuts)
4. **GROUP BY** session_id pour calculer la duree de chaque session
5. **ROW_NUMBER()** ou **MAX()** pour trouver la plus longue

C'est le pattern classique de **sessionization** en analytics.
</details>

---

## Ce qu'il faut retenir

```
┌──────────────────────────────────────────────────────────────┐
│                    A RETENIR                                  │
│                                                               │
│  1. Window Functions : enrichissent sans agreger             │
│     ROW_NUMBER, RANK, LAG, LEAD, SUM OVER                   │
│                                                               │
│  2. CTEs : sous-requetes nommees, lisibilite ++              │
│     MATERIALIZED vs NOT MATERIALIZED                         │
│                                                               │
│  3. WITH RECURSIVE : hierarchies, arbres, graphes            │
│     Anchor + terme recursif + condition d'arret              │
│                                                               │
│  4. LATERAL : sous-requete correlee dans FROM                │
│     Top-N par groupe, denormalisation                        │
│                                                               │
│  5. FILTER : agregats conditionnels elegants                 │
│                                                               │
│  6. GROUPING SETS / ROLLUP / CUBE : multi-niveaux           │
│     d'agregation en une seule requete                        │
└──────────────────────────────────────────────────────────────┘
```

---

## Navigation

| Precedent | Suivant |
|---|---|
| [Module 11 — Performances & Optimisation](./11-performances-et-optimisation.md) | [Module 13 — JSONB & Types avances](./13-jsonb-et-types-avances.md) |

**Travaux pratiques** : [Lab 12 — Window Functions et CTEs recursives](../labs/lab-12-fonctions-avancees.md)

---

> *"SQL n'est pas un langage de programmation imperatif. C'est un langage declaratif : dites QUOI, pas COMMENT. Les Window Functions en sont la plus belle illustration."*
