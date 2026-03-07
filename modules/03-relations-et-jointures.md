# Module 03 — Relations & Jointures

> **Objectif** : Comprendre les cles etrangeres, les differents types de relations (1:1, 1:N, N:M), maitriser toutes les variantes de JOIN et savoir construire des requetes multi-tables performantes.
>
> **Difficulte** : ⭐⭐ (intermediaire)

---

## 1. Cles etrangeres (FOREIGN KEY)

### 1.1 Principe

Une **cle etrangere** (Foreign Key, FK) est une contrainte qui garantit qu'une valeur dans une colonne **existe** dans une autre table. C'est le mecanisme fondamental qui relie les tables entre elles.

> **Analogie** : Imagine un bon de commande papier. La case "Client n°" ne peut contenir qu'un numero qui existe dans le registre des clients. Si tu ecris un numero inexistant, le comptable rejette le bon. La cle etrangere, c'est le comptable automatique.

```sql
-- La table "parent" (referencee)
CREATE TABLE departement (
    id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nom  TEXT NOT NULL UNIQUE
);

-- La table "enfant" (qui reference)
CREATE TABLE employe (
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nom             TEXT NOT NULL,
    departement_id  INTEGER REFERENCES departement(id)
    --              ^^^^^^^^ cle etrangere vers departement.id
);

-- Tentative d'inserer un employe avec un departement inexistant
INSERT INTO employe (nom, departement_id) VALUES ('Alice', 999);
-- ERREUR : insert or update on table "employe" violates foreign key constraint
-- Key (departement_id)=(999) is not present in table "departement"
```

### 1.2 Syntaxe complete

```sql
-- Syntaxe inline (sur une seule colonne)
CREATE TABLE employe (
    id              SERIAL PRIMARY KEY,
    departement_id  INTEGER REFERENCES departement(id) ON DELETE CASCADE
);

-- Syntaxe contrainte de table (nommee, pour multi-colonnes)
CREATE TABLE employe (
    id              SERIAL PRIMARY KEY,
    departement_id  INTEGER NOT NULL,
    CONSTRAINT fk_employe_departement
        FOREIGN KEY (departement_id)
        REFERENCES departement(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);
```

### 1.3 Actions ON DELETE et ON UPDATE

Que se passe-t-il quand on supprime ou modifie la ligne referencee (le departement) ?

| Action | Comportement | Cas d'usage |
|---|---|---|
| `RESTRICT` (defaut) | **Interdit** la suppression si des lignes referentes existent | Proteger les donnees critiques |
| `NO ACTION` | Comme RESTRICT mais verifie a la fin de la transaction | Verification differee |
| `CASCADE` | **Supprime** automatiquement les lignes referentes | Donnees dependantes (commande → lignes) |
| `SET NULL` | Met la FK a `NULL` dans les lignes referentes | Conserver l'historique (employe → ancien departement) |
| `SET DEFAULT` | Met la FK a sa valeur `DEFAULT` | Rare, valeur par defaut significative |

```sql
-- Demonstration de chaque action

-- CASCADE : supprimer le departement supprime tous ses employes
CREATE TABLE emp_cascade (
    id SERIAL PRIMARY KEY,
    dep_id INTEGER REFERENCES departement(id) ON DELETE CASCADE
);

-- SET NULL : supprimer le departement met dep_id a NULL
CREATE TABLE emp_setnull (
    id SERIAL PRIMARY KEY,
    dep_id INTEGER REFERENCES departement(id) ON DELETE SET NULL
);

-- RESTRICT : impossible de supprimer un departement qui a des employes
CREATE TABLE emp_restrict (
    id SERIAL PRIMARY KEY,
    dep_id INTEGER NOT NULL REFERENCES departement(id) ON DELETE RESTRICT
);
```

> **Piege classique** : `ON DELETE CASCADE` est pratique mais dangereux. Supprimer un seul departement peut entrainer la suppression de centaines d'employes. Utilise-le pour les relations de composition (une commande et ses lignes), mais pas pour les relations d'association faible. En cas de doute, utilise `RESTRICT` et gere les suppressions explicitement dans ton code.

```
 ON DELETE CASCADE — Attention danger !

 DELETE FROM departement WHERE id = 3;

 ┌────────────────┐       ┌──────────────────┐
 │  departement   │       │     employe      │
 │                │       │                  │
 │  id=3 "R&D"   │──────▶│  id=10, dep=3    │ ← SUPPRIME
 │  (SUPPRIME)    │──────▶│  id=11, dep=3    │ ← SUPPRIME
 │                │──────▶│  id=12, dep=3    │ ← SUPPRIME
 └────────────────┘       │  id=13, dep=1    │ ← intact
                          │  id=14, dep=2    │ ← intact
                          └──────────────────┘
```

---

## 2. Types de relations

### 2.1 Relation 1:1 (un a un)

Chaque ligne de la table A correspond a exactement une ligne de la table B, et inversement.

```sql
-- Exemple : un employe a une fiche de paie unique
CREATE TABLE employe (
    id      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nom     TEXT NOT NULL,
    email   TEXT NOT NULL UNIQUE
);

CREATE TABLE fiche_paie (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employe_id  INTEGER NOT NULL UNIQUE REFERENCES employe(id),
    --                           ^^^^^^ UNIQUE garantit le 1:1
    iban        TEXT NOT NULL,
    salaire     NUMERIC(10,2) NOT NULL
);
```

```
 Relation 1:1

 ┌──────────┐        ┌─────────────┐
 │ employe  │  1──1  │ fiche_paie  │
 │          │───────▶│             │
 │ id (PK)  │        │ employe_id  │
 │ nom      │        │ (FK+UNIQUE) │
 │ email    │        │ iban        │
 └──────────┘        │ salaire     │
                     └─────────────┘
```

> **Exercice mental** : Quand utiliser une relation 1:1 plutot que tout mettre dans la meme table ? Reponses possibles :
> - **Separation des donnees sensibles** (salaire, IBAN separes des donnees publiques)
> - **Colonnes rarement lues** (eviter de charger des colonnes lourdes a chaque requete)
> - **Schemas differents** (une table "publique", une table "privee" avec des permissions differentes)

### 2.2 Relation 1:N (un a plusieurs)

C'est la relation la plus courante. Un departement a plusieurs employes, mais chaque employe n'a qu'un seul departement.

```sql
CREATE TABLE departement (
    id   INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nom  TEXT NOT NULL UNIQUE
);

CREATE TABLE employe (
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nom             TEXT NOT NULL,
    departement_id  INTEGER NOT NULL REFERENCES departement(id)
    -- Pas de UNIQUE ici → plusieurs employes par departement
);
```

```
 Relation 1:N

 ┌──────────────┐          ┌──────────────┐
 │ departement  │   1──N   │   employe    │
 │              │─────────▶│              │
 │ id (PK)      │          │ id (PK)      │
 │ nom          │          │ nom          │
 └──────────────┘          │ departement_id│
                           │ (FK)          │
                           └──────────────┘
 1 departement ──▶ N employes
 1 employe ──▶ 1 seul departement
```

### 2.3 Relation N:M (plusieurs a plusieurs)

Un etudiant suit plusieurs cours, et chaque cours a plusieurs etudiants. Ce type de relation necessite une **table de jonction** (ou table d'association).

```sql
-- Les deux tables principales
CREATE TABLE etudiant (
    id      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nom     TEXT NOT NULL,
    email   TEXT NOT NULL UNIQUE
);

CREATE TABLE cours (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    titre       TEXT NOT NULL,
    credits     INTEGER NOT NULL CHECK (credits > 0)
);

-- La table de jonction
CREATE TABLE inscription (
    etudiant_id INTEGER NOT NULL REFERENCES etudiant(id) ON DELETE CASCADE,
    cours_id    INTEGER NOT NULL REFERENCES cours(id) ON DELETE CASCADE,
    date_inscription DATE NOT NULL DEFAULT CURRENT_DATE,
    note        NUMERIC(4,2) CHECK (note >= 0 AND note <= 20),
    PRIMARY KEY (etudiant_id, cours_id)  -- cle primaire composite
);
```

```
 Relation N:M via table de jonction

 ┌──────────┐       ┌──────────────┐       ┌──────────┐
 │ etudiant │  N    │ inscription  │    N  │  cours   │
 │          │──────▶│              │◀──────│          │
 │ id (PK)  │       │ etudiant_id  │       │ id (PK)  │
 │ nom      │       │ cours_id     │       │ titre    │
 │ email    │       │ date_inscr.  │       │ credits  │
 └──────────┘       │ note         │       └──────────┘
                    └──────────────┘
                     PK = (etudiant_id, cours_id)
```

> **Ce qu'il faut retenir** : La table de jonction porte souvent des **attributs propres a la relation** : la date d'inscription, la note, le role, etc. Ce ne sont pas des attributs de l'etudiant ni du cours, mais de la **relation entre les deux**.

---

## 3. Tables de jonction (junction tables) pour N:M

### 3.1 Conventions de nommage

| Convention | Exemple | Commentaire |
|---|---|---|
| `table1_table2` | `etudiant_cours` | Simple, aleatoire |
| Nom semantique | `inscription` | **Recommande** quand un nom metier existe |
| `table1_has_table2` | `etudiant_has_cours` | Convention Ruby on Rails |
| Verbe | `suit` | Trop abstrait, a eviter |

### 3.2 Exemple complet : systeme de tags

```sql
-- Articles de blog
CREATE TABLE article (
    id      INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    titre   TEXT NOT NULL,
    contenu TEXT,
    publie  BOOLEAN NOT NULL DEFAULT false
);

-- Tags
CREATE TABLE tag (
    id  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nom TEXT NOT NULL UNIQUE
);

-- Table de jonction : un article peut avoir plusieurs tags,
-- un tag peut etre associe a plusieurs articles
CREATE TABLE article_tag (
    article_id  INTEGER NOT NULL REFERENCES article(id) ON DELETE CASCADE,
    tag_id      INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    PRIMARY KEY (article_id, tag_id)
);

-- Inserer des donnees
INSERT INTO article (titre) VALUES ('PostgreSQL pour les nuls'), ('Guide des index');
INSERT INTO tag (nom) VALUES ('sql'), ('postgresql'), ('performance'), ('debutant');

-- Associer des tags aux articles
INSERT INTO article_tag (article_id, tag_id) VALUES
    (1, 1), (1, 2), (1, 4),  -- article 1 : sql, postgresql, debutant
    (2, 2), (2, 3);           -- article 2 : postgresql, performance

-- Trouver les tags d'un article
SELECT t.nom
FROM tag t
JOIN article_tag at ON t.id = at.tag_id
WHERE at.article_id = 1;

-- Trouver les articles d'un tag
SELECT a.titre
FROM article a
JOIN article_tag at ON a.id = at.article_id
JOIN tag t ON at.tag_id = t.id
WHERE t.nom = 'postgresql';
```

---

## 4. INNER JOIN — le join le plus courant

### 4.1 Principe

Le `INNER JOIN` retourne uniquement les lignes qui ont une correspondance dans **les deux tables**.

```sql
-- Syntaxe
SELECT colonnes
FROM table_a
INNER JOIN table_b ON table_a.colonne = table_b.colonne;

-- Exemple : employes avec leur departement
SELECT e.nom, e.prenom, d.nom AS departement
FROM employe e
INNER JOIN departement d ON e.departement_id = d.id;
```

```
 INNER JOIN — Diagramme de Venn

     Table A              Table B
   ┌─────────┐         ┌─────────┐
   │         │░░░░░░░░░│         │
   │   A     │░░░JOIN░░│    B    │
   │  seul   │░░░░░░░░░│   seul  │
   │         │░░░░░░░░░│         │
   └─────────┘         └─────────┘

   ░░░ = INNER JOIN (lignes presentes dans A ET B)
   A seul = lignes de A sans correspondance dans B (exclues)
   B seul = lignes de B sans correspondance dans A (exclues)
```

### 4.2 Exemple detaille

```sql
-- Donnees
INSERT INTO departement (nom) VALUES ('IT'), ('RH'), ('Finance');
INSERT INTO employe (nom, prenom, departement_id) VALUES
    ('Dupont', 'Alice', 1),   -- IT
    ('Martin', 'Bob', 1),     -- IT
    ('Petit', 'Claire', 2),   -- RH
    ('Durand', 'David', NULL); -- pas de departement

-- INNER JOIN
SELECT e.nom, e.prenom, d.nom AS departement
FROM employe e
INNER JOIN departement d ON e.departement_id = d.id;

-- Resultat :
-- nom     | prenom | departement
-- --------+--------+------------
-- Dupont  | Alice  | IT
-- Martin  | Bob    | IT
-- Petit   | Claire | RH
-- (3 lignes — David est EXCLU car departement_id IS NULL)
-- (Finance est EXCLU car aucun employe n'y est affecte)
```

> **Ce qu'il faut retenir** : `INNER JOIN` est le type de join par defaut. `JOIN` sans prefixe est un `INNER JOIN`. Si tu oublies la clause `ON`, PostgreSQL te renverra une erreur.

---

## 5. LEFT JOIN / LEFT OUTER JOIN

### 5.1 Principe

Le `LEFT JOIN` retourne **toutes** les lignes de la table de gauche, meme si elles n'ont pas de correspondance dans la table de droite. Les colonnes de la table de droite sont remplies avec `NULL` quand il n'y a pas de correspondance.

```sql
-- Tous les employes, meme ceux sans departement
SELECT e.nom, e.prenom, d.nom AS departement
FROM employe e
LEFT JOIN departement d ON e.departement_id = d.id;

-- Resultat :
-- nom     | prenom | departement
-- --------+--------+------------
-- Dupont  | Alice  | IT
-- Martin  | Bob    | IT
-- Petit   | Claire | RH
-- Durand  | David  | NULL        ← inclus malgre l'absence de departement
```

```
 LEFT JOIN — Diagramme de Venn

     Table A              Table B
   ┌─────────┐         ┌─────────┐
   │░░░░░░░░░│░░░░░░░░░│         │
   │░░░A░░░░░│░░░JOIN░░│    B    │
   │░░░░░░░░░│░░░░░░░░░│   seul  │
   │░░░░░░░░░│░░░░░░░░░│         │
   └─────────┘         └─────────┘

   ░░░ = LEFT JOIN (toutes les lignes de A + correspondances de B)
   B seul = lignes de B sans correspondance dans A (exclues)
```

### 5.2 Trouver les lignes SANS correspondance

Un pattern tres courant avec `LEFT JOIN` est de trouver les lignes "orphelines" :

```sql
-- Employes qui n'ont PAS de departement
SELECT e.nom, e.prenom
FROM employe e
LEFT JOIN departement d ON e.departement_id = d.id
WHERE d.id IS NULL;

-- Departements qui n'ont AUCUN employe
SELECT d.nom AS departement_vide
FROM departement d
LEFT JOIN employe e ON d.id = e.departement_id
WHERE e.id IS NULL;
```

> **Analogie** : Le `LEFT JOIN`, c'est comme un appel nominal en classe. Tous les eleves de la liste (table gauche) sont appeles. Si un eleve n'a pas de groupe de projet (table droite), il apparait quand meme, mais avec "aucun groupe" en face.

---

## 6. RIGHT JOIN / RIGHT OUTER JOIN

### 6.1 Principe

Le `RIGHT JOIN` est le miroir du `LEFT JOIN` : il retourne toutes les lignes de la table de **droite**, meme sans correspondance dans la table de gauche.

```sql
-- Tous les departements, meme ceux sans employes
SELECT e.nom, e.prenom, d.nom AS departement
FROM employe e
RIGHT JOIN departement d ON e.departement_id = d.id;

-- Resultat :
-- nom     | prenom | departement
-- --------+--------+------------
-- Dupont  | Alice  | IT
-- Martin  | Bob    | IT
-- Petit   | Claire | RH
-- NULL    | NULL   | Finance     ← inclus malgre l'absence d'employes
```

```
 RIGHT JOIN — Diagramme de Venn

     Table A              Table B
   ┌─────────┐         ┌─────────┐
   │         │░░░░░░░░░│░░░░░░░░░│
   │   A     │░░░JOIN░░│░░░B░░░░░│
   │  seul   │░░░░░░░░░│░░░░░░░░░│
   │         │░░░░░░░░░│░░░░░░░░░│
   └─────────┘         └─────────┘

   ░░░ = RIGHT JOIN (correspondances de A + toutes les lignes de B)
```

> **Ce qu'il faut retenir** : En pratique, le `RIGHT JOIN` est **rarement utilise**. On prefere inverser l'ordre des tables et utiliser un `LEFT JOIN`, car c'est plus lisible. `A RIGHT JOIN B` est equivalent a `B LEFT JOIN A`.

---

## 7. FULL OUTER JOIN

### 7.1 Principe

Le `FULL OUTER JOIN` retourne **toutes** les lignes des **deux** tables, avec `NULL` la ou il n'y a pas de correspondance.

```sql
SELECT e.nom AS employe, d.nom AS departement
FROM employe e
FULL OUTER JOIN departement d ON e.departement_id = d.id;

-- Resultat :
-- employe | departement
-- --------+------------
-- Dupont  | IT
-- Martin  | IT
-- Petit   | RH
-- Durand  | NULL         ← employe sans departement
-- NULL    | Finance      ← departement sans employe
```

```
 FULL OUTER JOIN — Diagramme de Venn

     Table A              Table B
   ┌─────────┐         ┌─────────┐
   │░░░░░░░░░│░░░░░░░░░│░░░░░░░░░│
   │░░░A░░░░░│░░░JOIN░░│░░░B░░░░░│
   │░░░░░░░░░│░░░░░░░░░│░░░░░░░░░│
   │░░░░░░░░░│░░░░░░░░░│░░░░░░░░░│
   └─────────┘         └─────────┘

   ░░░ = FULL OUTER JOIN (tout de A + tout de B)
```

### 7.2 Cas d'usage : reconciliation de donnees

```sql
-- Comparer deux tables pour trouver les differences
-- Exemple : comparer les employes entre deux bases
SELECT
    COALESCE(a.email, b.email) AS email,
    CASE
        WHEN a.email IS NULL THEN 'Uniquement dans B'
        WHEN b.email IS NULL THEN 'Uniquement dans A'
        ELSE 'Dans les deux'
    END AS statut
FROM employes_a a
FULL OUTER JOIN employes_b b ON a.email = b.email
WHERE a.email IS NULL OR b.email IS NULL;
```

---

## 8. CROSS JOIN (produit cartesien)

### 8.1 Principe

Le `CROSS JOIN` combine **chaque ligne** de la table A avec **chaque ligne** de la table B. Si A a 10 lignes et B a 5 lignes, le resultat a 10 × 5 = 50 lignes.

```sql
-- Syntaxe explicite
SELECT t.taille, c.couleur
FROM taille t
CROSS JOIN couleur c;

-- Syntaxe implicite (virgule)
SELECT t.taille, c.couleur
FROM taille t, couleur c;
-- Equivalent mais moins lisible
```

```
 CROSS JOIN — Produit cartesien

 taille     couleur       Resultat (3 × 2 = 6 lignes)
 ┌────┐     ┌───────┐     ┌────────────────┐
 │ S  │  ×  │ Rouge │  =  │  S  │  Rouge   │
 │ M  │     │ Bleu  │     │  S  │  Bleu    │
 │ L  │     └───────┘     │  M  │  Rouge   │
 └────┘                   │  M  │  Bleu    │
                          │  L  │  Rouge   │
                          │  L  │  Bleu    │
                          └────────────────┘
```

> **Piege classique** : Le `CROSS JOIN` est rarement ce que tu veux. Si tu as oublie la clause `ON` dans un `JOIN`, tu obtiens un produit cartesien accidentel. Sur deux tables de 10 000 lignes chacune, le resultat fait 100 000 000 lignes !

### 8.2 Cas d'usage : generateur de combinaisons

```sql
-- Generer un calendrier des 12 prochains mois × 3 categories
WITH mois AS (
    SELECT generate_series(
        DATE_TRUNC('month', CURRENT_DATE),
        DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '11 months',
        INTERVAL '1 month'
    )::DATE AS debut_mois
),
categories AS (
    SELECT unnest(ARRAY['Ventes', 'Achats', 'Salaires']) AS categorie
)
SELECT m.debut_mois, c.categorie, 0.00 AS montant
FROM mois m
CROSS JOIN categories c
ORDER BY m.debut_mois, c.categorie;
```

---

## 9. Self-joins (auto-jointure)

### 9.1 Principe

Un self-join est une jointure d'une table avec **elle-meme**. Le cas classique est une hierarchie (employe → manager).

```sql
-- Table avec auto-reference
CREATE TABLE personnel (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nom         TEXT NOT NULL,
    poste       TEXT NOT NULL,
    manager_id  INTEGER REFERENCES personnel(id)  -- auto-reference
);

INSERT INTO personnel (nom, poste, manager_id) VALUES
    ('Marie Dupont', 'PDG', NULL),          -- id=1, pas de manager
    ('Jean Martin', 'Directeur IT', 1),      -- id=2, manager=Marie
    ('Alice Petit', 'Dev Senior', 2),        -- id=3, manager=Jean
    ('Bob Durand', 'Dev Junior', 3),         -- id=4, manager=Alice
    ('Claire Leroy', 'Directrice RH', 1);   -- id=5, manager=Marie

-- Trouver chaque employe avec le nom de son manager
SELECT
    e.nom AS employe,
    e.poste,
    m.nom AS manager
FROM personnel e
LEFT JOIN personnel m ON e.manager_id = m.id;

-- Resultat :
-- employe        | poste          | manager
-- ---------------+----------------+---------------
-- Marie Dupont   | PDG            | NULL
-- Jean Martin    | Directeur IT   | Marie Dupont
-- Alice Petit    | Dev Senior     | Jean Martin
-- Bob Durand     | Dev Junior     | Alice Petit
-- Claire Leroy   | Directrice RH  | Marie Dupont
```

```
 Hierarchie via self-join

           Marie Dupont (PDG)
           ┌──────┴──────┐
    Jean Martin     Claire Leroy
    (Dir. IT)       (Dir. RH)
        │
    Alice Petit
    (Dev Senior)
        │
    Bob Durand
    (Dev Junior)
```

### 9.2 Requete recursive (CTE recursive)

```sql
-- Trouver toute la chaine hierarchique d'un employe
WITH RECURSIVE hierarchie AS (
    -- Cas de base : l'employe de depart
    SELECT id, nom, poste, manager_id, 0 AS niveau
    FROM personnel
    WHERE id = 4  -- Bob Durand

    UNION ALL

    -- Cas recursif : remonter au manager
    SELECT p.id, p.nom, p.poste, p.manager_id, h.niveau + 1
    FROM personnel p
    INNER JOIN hierarchie h ON p.id = h.manager_id
)
SELECT nom, poste, niveau
FROM hierarchie
ORDER BY niveau;

-- Resultat :
-- nom            | poste        | niveau
-- ---------------+--------------+-------
-- Bob Durand     | Dev Junior   | 0
-- Alice Petit    | Dev Senior   | 1
-- Jean Martin    | Directeur IT | 2
-- Marie Dupont   | PDG          | 3
```

---

## 10. Jointures multiples (3+ tables)

### 10.1 Enchainer les joins

```sql
-- Schema : employe → departement, employe ↔ projet (via employe_projet)

-- Trouver les employes, leur departement, et leurs projets
SELECT
    e.prenom || ' ' || e.nom AS employe,
    d.nom AS departement,
    p.titre AS projet,
    ep.role
FROM employe e
INNER JOIN departement d ON e.departement_id = d.id
INNER JOIN employe_projet ep ON e.id = ep.employe_id
INNER JOIN projet p ON ep.projet_id = p.id
ORDER BY e.nom, p.titre;

-- Meme chose mais avec les employes sans projet (LEFT JOIN)
SELECT
    e.prenom || ' ' || e.nom AS employe,
    d.nom AS departement,
    COALESCE(p.titre, '(aucun projet)') AS projet,
    COALESCE(ep.role, '-') AS role
FROM employe e
INNER JOIN departement d ON e.departement_id = d.id
LEFT JOIN employe_projet ep ON e.id = ep.employe_id
LEFT JOIN projet p ON ep.projet_id = p.id
ORDER BY e.nom, p.titre;
```

> **Piege classique** : Quand tu enchaines des joins, l'ordre compte pour la lisibilite. Place les `INNER JOIN` d'abord (ils filtrent), puis les `LEFT JOIN` (ils conservent). Si tu mets un `INNER JOIN` apres un `LEFT JOIN` sur la meme branche, les NULL du LEFT JOIN seront elimines par l'INNER JOIN, annulant l'effet du LEFT.

```sql
-- PROBLEME : le INNER JOIN sur projet annule le LEFT JOIN sur employe_projet
SELECT e.nom, p.titre
FROM employe e
LEFT JOIN employe_projet ep ON e.id = ep.employe_id
INNER JOIN projet p ON ep.projet_id = p.id;  -- elimine les NULL !
-- Les employes sans projet disparaissent

-- CORRECT : utiliser LEFT JOIN pour toute la chaine
SELECT e.nom, p.titre
FROM employe e
LEFT JOIN employe_projet ep ON e.id = ep.employe_id
LEFT JOIN projet p ON ep.projet_id = p.id;
-- Les employes sans projet ont NULL pour p.titre
```

### 10.2 Diagramme des tables d'un e-commerce

```
 ┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
 │  client      │     │  commande    │     │  ligne_commande  │
 │              │  1:N│              │ 1:N │                  │
 │  id (PK)     │────▶│  id (PK)     │────▶│  id (PK)         │
 │  nom         │     │  client_id   │     │  commande_id (FK)│
 │  email       │     │  date        │     │  produit_id (FK) │
 │  ville       │     │  statut      │     │  quantite        │
 └──────────────┘     │  total       │     │  prix_unitaire   │
                      └──────────────┘     └────────┬─────────┘
                                                    │ N:1
                                                    ▼
                                           ┌──────────────┐
                                           │  produit     │
                                           │              │
                                           │  id (PK)     │
                                           │  nom         │
                                           │  prix        │
                                           │  categorie   │
                                           └──────────────┘
```

```sql
-- Requete complete traversant 4 tables
SELECT
    c.nom AS client,
    c.ville,
    cmd.id AS commande_n,
    cmd.date AS date_commande,
    cmd.statut,
    p.nom AS produit,
    lc.quantite,
    lc.prix_unitaire,
    (lc.quantite * lc.prix_unitaire) AS sous_total
FROM client c
JOIN commande cmd ON c.id = cmd.client_id
JOIN ligne_commande lc ON cmd.id = lc.commande_id
JOIN produit p ON lc.produit_id = p.id
WHERE cmd.date >= '2024-01-01'
ORDER BY c.nom, cmd.date, p.nom;

-- Total par client
SELECT
    c.nom AS client,
    COUNT(DISTINCT cmd.id) AS nb_commandes,
    SUM(lc.quantite * lc.prix_unitaire)::NUMERIC(12,2) AS total_depense
FROM client c
JOIN commande cmd ON c.id = cmd.client_id
JOIN ligne_commande lc ON cmd.id = lc.commande_id
GROUP BY c.id, c.nom
ORDER BY total_depense DESC;
```

---

## 11. Performance des jointures

### 11.1 Pourquoi l'ordre peut compter

Theoriquement, le query planner de PostgreSQL est libre de reordonner les joins pour trouver le plan optimal. En pratique, il existe des cas ou l'ordre des tables influence le plan :

| Facteur | Impact |
|---|---|
| **Statistiques a jour** | Le planner a besoin de bonnes stats (`ANALYZE`) pour choisir le bon ordre |
| **Nombre de tables** | Au-dela de ~12 tables jointes, le planner utilise une heuristique (GEQO) |
| **Indexes disponibles** | Un index sur la colonne de jointure accelere enormement le join |
| **Cardinalite** | Joindre d'abord les tables les plus selectivement filtrees reduit le volume |

### 11.2 Regles de bonne pratique

```sql
-- BON : filtrer tot, sur des colonnes indexees
SELECT e.nom, d.nom AS departement
FROM employe e
JOIN departement d ON e.departement_id = d.id
WHERE e.est_actif = true         -- filtre selectif
  AND d.ville = 'Paris';         -- filtre selectif

-- ASSURER les index
CREATE INDEX idx_employe_departement ON employe(departement_id);
CREATE INDEX idx_employe_actif ON employe(est_actif) WHERE est_actif = true;
```

> **Ce qu'il faut retenir** : La performance des jointures depend avant tout des **index** et des **statistiques**. Cree un index sur chaque colonne utilisee dans une clause `ON` ou `WHERE`. Lance `ANALYZE` regulierement (l'autovacuum le fait automatiquement, mais tu peux le forcer).

---

## 12. Node.js : executer des jointures complexes avec pg

```javascript
// fichier : jointures.mjs
// Exemples de requetes avec jointures en Node.js

import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'cours',
  user: 'postgres',
  password: 'postgres',
});

// Employes avec leur departement
async function employesAvecDepartement() {
  const { rows } = await pool.query(`
    SELECT
      e.id,
      e.prenom || ' ' || e.nom AS nom_complet,
      d.nom AS departement,
      e.poste,
      e.salaire
    FROM employe e
    LEFT JOIN departement d ON e.departement_id = d.id
    ORDER BY d.nom, e.nom
  `);

  console.log('Employes par departement :');
  let lastDep = null;
  for (const row of rows) {
    if (row.departement !== lastDep) {
      console.log(`\n  --- ${row.departement || 'Sans departement'} ---`);
      lastDep = row.departement;
    }
    console.log(`    ${row.nom_complet} (${row.poste}) — ${row.salaire} EUR`);
  }
  return rows;
}

// Statistiques croisees (jointure + agregation)
async function statsParDepartement() {
  const { rows } = await pool.query(`
    SELECT
      d.nom AS departement,
      COUNT(e.id) AS effectif,
      AVG(e.salaire)::NUMERIC(10,2) AS salaire_moyen,
      MIN(e.salaire) AS salaire_min,
      MAX(e.salaire) AS salaire_max
    FROM departement d
    LEFT JOIN employe e ON d.id = e.departement_id AND e.est_actif = true
    GROUP BY d.id, d.nom
    ORDER BY effectif DESC
  `);

  console.log('\nStatistiques par departement :');
  console.table(rows);
  return rows;
}

// Recherche parametree avec jointure
async function rechercherProjets(departement, budgetMin) {
  const { rows } = await pool.query(`
    SELECT
      p.titre,
      p.budget,
      d.nom AS departement,
      COUNT(ep.employe_id) AS nb_membres,
      STRING_AGG(e.prenom || ' ' || e.nom, ', ' ORDER BY e.nom) AS equipe
    FROM projet p
    JOIN employe_projet ep ON p.id = ep.projet_id
    JOIN employe e ON ep.employe_id = e.id
    JOIN departement d ON e.departement_id = d.id
    WHERE d.nom = $1
      AND p.budget >= $2
    GROUP BY p.id, p.titre, p.budget, d.nom
    ORDER BY p.budget DESC
  `, [departement, budgetMin]);

  return rows;
}

async function main() {
  try {
    await employesAvecDepartement();
    await statsParDepartement();

    const projets = await rechercherProjets('IT', 10000);
    console.log('\nProjets IT avec budget > 10k :', projets);
  } finally {
    await pool.end();
  }
}

main();
```

---

## 13. Exercice mental : modeliser un systeme e-commerce

Concois le schema d'une boutique en ligne avec les entites suivantes :

1. **Clients** : id, nom, prenom, email (unique), adresse, ville, code_postal
2. **Produits** : id, nom, description, prix, stock, categorie_id
3. **Categories** : id, nom, description, categorie_parente_id (hierarchie)
4. **Commandes** : id, client_id, date, statut, adresse_livraison
5. **Lignes de commande** : commande_id, produit_id, quantite, prix_unitaire

Questions a te poser :
- Quels types de relations existent entre ces tables ?
- Quelles contraintes CHECK sont necessaires ?
- Quel ON DELETE choisir pour chaque FK ?

### Solution

```sql
CREATE TABLE categorie (
    id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nom                 TEXT NOT NULL,
    description         TEXT,
    categorie_parente_id INTEGER REFERENCES categorie(id) ON DELETE SET NULL
    -- auto-reference pour les sous-categories (self-join)
);

CREATE TABLE client (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    prenom      TEXT NOT NULL,
    nom         TEXT NOT NULL,
    email       TEXT NOT NULL UNIQUE,
    adresse     TEXT,
    ville       TEXT,
    code_postal VARCHAR(5) CHECK (code_postal ~ '^\d{5}$'),
    cree_le     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE produit (
    id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nom           TEXT NOT NULL,
    description   TEXT,
    prix          NUMERIC(10,2) NOT NULL CHECK (prix > 0),
    stock         INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    categorie_id  INTEGER REFERENCES categorie(id) ON DELETE SET NULL,
    est_actif     BOOLEAN NOT NULL DEFAULT true,
    cree_le       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE commande (
    id                  INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id           INTEGER NOT NULL REFERENCES client(id) ON DELETE RESTRICT,
    date_commande       TIMESTAMPTZ NOT NULL DEFAULT now(),
    statut              TEXT NOT NULL DEFAULT 'en_attente'
                        CHECK (statut IN ('en_attente','confirmee','expediee','livree','annulee')),
    adresse_livraison   TEXT NOT NULL,
    total               NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0)
);

CREATE TABLE ligne_commande (
    id              INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    commande_id     INTEGER NOT NULL REFERENCES commande(id) ON DELETE CASCADE,
    produit_id      INTEGER NOT NULL REFERENCES produit(id) ON DELETE RESTRICT,
    quantite        INTEGER NOT NULL CHECK (quantite > 0),
    prix_unitaire   NUMERIC(10,2) NOT NULL CHECK (prix_unitaire >= 0),
    UNIQUE (commande_id, produit_id)  -- un produit par ligne maximum
);
```

```
 Schema complet :

 ┌───────────┐          ┌──────────┐    1:N    ┌────────────────┐
 │ categorie │◀─self    │  client  │──────────▶│   commande     │
 │           │          └──────────┘           └───────┬────────┘
 │  id (PK)  │                                         │ 1:N
 │  parent_id│                                         ▼
 └─────┬─────┘                                ┌────────────────┐
       │ 1:N                                  │ligne_commande  │
       ▼                                      │                │
 ┌──────────┐                                 │ commande_id(FK)│
 │ produit  │◀────────────────────────────────│ produit_id(FK) │
 └──────────┘              N:1                │ quantite       │
                                              │ prix_unitaire  │
                                              └────────────────┘
```

---

## 14. Tableau recapitulatif de tous les types de JOIN

| Type de JOIN | Lignes retournees | SQL |
|---|---|---|
| `INNER JOIN` | Uniquement les correspondances | `A JOIN B ON ...` |
| `LEFT JOIN` | Tout A + correspondances B (NULL si absent) | `A LEFT JOIN B ON ...` |
| `RIGHT JOIN` | Correspondances A (NULL si absent) + tout B | `A RIGHT JOIN B ON ...` |
| `FULL OUTER JOIN` | Tout A + tout B (NULL des deux cotes si absent) | `A FULL OUTER JOIN B ON ...` |
| `CROSS JOIN` | Produit cartesien (A × B) | `A CROSS JOIN B` |
| Self-join | Table jointe avec elle-meme | `A a1 JOIN A a2 ON ...` |
| `NATURAL JOIN` | Join automatique sur colonnes de meme nom | **A eviter** (fragile) |

> **Piege classique** : N'utilise JAMAIS `NATURAL JOIN` en production. Il joint automatiquement sur toutes les colonnes de meme nom. Si tu ajoutes une colonne `nom` dans les deux tables, le join change de comportement sans avertissement. Toujours specifier explicitement la clause `ON`.

---

## Navigation

| | Lien |
|---|---|
| Module precedent | [Module 02 — CRUD & Requetes SQL](./02-crud-et-requetes.md) |
| Module suivant | [Module 04 — Transactions & ACID](./04-transactions-et-acid.md) |
| Lab associe | [Lab 03 — Jointures et relations](../labs/lab-03.md) |

---

> **Ce qu'il faut retenir** : Les jointures sont le coeur du modele relationnel. `INNER JOIN` pour les correspondances strictes, `LEFT JOIN` pour conserver toutes les lignes d'une table, `FULL OUTER JOIN` pour la reconciliation. Les cles etrangeres garantissent l'integrite referentielle. Les tables de jonction materialisent les relations N:M. Toujours mettre un index sur les colonnes de jointure.
