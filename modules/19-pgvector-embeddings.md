---
titre: pgvector et embeddings
cours: 10-postgresql
notions: [type vector et extension pgvector, embeddings et représentation vectorielle, recherche de similarité cosinus et L2, index HNSW et IVFFlat, cas d'usage RAG, intégration avec une API d'embeddings, dimensions et performances]
outcomes: [stocker des embeddings avec pgvector, faire une recherche de similarité, choisir un index HNSW ou IVFFlat, comprendre le pattern RAG sur PostgreSQL]
prerequis: [18-partitioning-et-scaling]
next: fin-parcours-10-postgresql
libs: [{ name: postgresql, version: "17" }, { name: pgvector, version: "0.8" }]
tribuzen: recherche sémantique dans les souvenirs et le journal de TribuZen (embeddings + similarité)
last-reviewed: 2026-07
---

# pgvector et embeddings

> **Outcomes — tu sauras FAIRE :** stocker des embeddings avec pgvector, exécuter une recherche de similarité cosinus, choisir entre HNSW et IVFFlat selon le contexte, et câbler le pattern RAG directement dans PostgreSQL.
> **Difficulté :** :star::star::star::star:

## 1. Cas concret d'abord

Dans TribuZen, les membres écrivent des **souvenirs** (moments partagés, anecdotes, instants de vie) et un **journal** personnel. La recherche textuelle classique (`ILIKE '%mamie%'`) ne retrouve que les mots exacts — elle rate "grand-mère", "pépé", "bonne-maman". Un utilisateur qui tape *"les moments doux avec mamie"* doit retrouver le souvenir intitulé *"goûter du dimanche chez grand-mère"* même si aucun mot commun n'existe.

```sql
-- Sans pgvector : recherche par mots-clés, résultats limités
SELECT titre, contenu
FROM souvenirs
WHERE contenu ILIKE '%mamie%' OR contenu ILIKE '%grand-mère%';
-- 2 lignes — rate tout ce qui dit "pépé", "aïeule", "nan", "bonne-maman"

-- Avec pgvector : recherche sémantique, résultats par sens
-- $1 = embedding de "les moments doux avec mamie"
SELECT titre, 1 - (embedding <=> $1::vector) AS similarite
FROM souvenirs
WHERE famille_id = $2
ORDER BY embedding <=> $1::vector
LIMIT 5;
-- Résultat : "goûter du dimanche chez grand-mère" (0.91),
--            "promenade avec papi et les enfants" (0.87), ...
```

Le reste du module explique comment passer de la table `souvenirs` brute aux vecteurs stockés, indexés et interrogeables, puis comment assembler le pattern RAG pour qu'un LLM réponde en citant les vrais souvenirs de la famille.

## 2. Théorie complète, concise

### Extension et type `vector`

pgvector s'installe comme n'importe quelle extension PostgreSQL. Elle expose le type `vector(n)` où `n` est la dimension, fixée à la création de la colonne :

```sql
-- À exécuter une fois par base de données
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE souvenirs (
    id          SERIAL PRIMARY KEY,
    auteur_id   INT NOT NULL,
    famille_id  INT NOT NULL,
    titre       TEXT NOT NULL,
    contenu     TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now(),
    embedding   vector(1536)   -- dimension du modèle d'embedding
);
```

> L'extension est activée **par base de données**. Sur un serveur multi-bases, `CREATE EXTENSION vector` doit être exécuté dans chaque base concernée.

### Embeddings et représentation vectorielle

Un **embedding** est la projection d'un texte dans un espace vectoriel de dimension fixe. Deux textes sémantiquement proches produisent des vecteurs proches. L'API d'embeddings prend du texte en entrée et retourne un tableau de flottants :

```
"goûter du dimanche chez grand-mère"  →  [0.12, -0.34, 0.78, ..., 0.05]  (1536 valeurs)
"les moments doux avec mamie"          →  [0.11, -0.31, 0.80, ..., 0.06]  (1536 valeurs)
                                                   ↑ vecteurs très proches → sens similaire
```

Dimensions courantes selon le modèle :

| Modèle | Dimension | Notes |
|--------|-----------|-------|
| OpenAI `text-embedding-3-small` | 1536 | Rapport qualité/prix recommandé |
| OpenAI `text-embedding-3-large` | 3072 | Haute précision |
| Cohere `embed-v3` | 1024 | Multilingue, différencie query/document |
| MiniLM-L6-v2 (local) | 384 | Gratuit, prototypage |

### Opérateurs de distance

pgvector expose trois opérateurs. Tous sont supportés par HNSW et IVFFlat :

```sql
-- <=> : distance cosinus (0 = identique, 2 = opposés)
SELECT titre, embedding <=> $1::vector AS dist
FROM souvenirs ORDER BY dist LIMIT 5;

-- <-> : distance L2 euclidienne (0 à +∞)
SELECT titre, embedding <-> $1::vector AS dist
FROM souvenirs ORDER BY dist LIMIT 5;

-- <#> : produit scalaire négatif (pour vecteurs normalisés)
SELECT titre, embedding <#> $1::vector AS dist
FROM souvenirs ORDER BY dist LIMIT 5;

-- Convertir distance cosinus en similarité lisible (0 à 1)
SELECT titre, 1 - (embedding <=> $1::vector) AS similarite
FROM souvenirs ORDER BY embedding <=> $1::vector LIMIT 5;
```

Règle de choix : `<=>` (cosinus) par défaut pour la recherche sémantique sur texte — recommandé par OpenAI et Cohere. `<->` (L2) quand la magnitude du vecteur a un sens métier (images, clustering spatial).

### Index HNSW

HNSW (Hierarchical Navigable Small World) construit un graphe multi-niveaux : les niveaux supérieurs sont des autoroutes pour naviguer rapidement vers la zone pertinente, la recherche précise se fait au niveau 0.

```sql
-- Index HNSW cosinus (défaut recommandé en production)
CREATE INDEX idx_souvenirs_hnsw
ON souvenirs
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Tuning à la requête : augmenter ef_search pour un meilleur recall
SET hnsw.ef_search = 100;   -- défaut : 40

-- Variante half-precision : index plus petit, légèrement moins précis
CREATE INDEX ON souvenirs
USING hnsw ((embedding::halfvec(1536)) halfvec_cosine_ops);
```

Paramètres de construction :
- `m` (défaut 16) : connexions par nœud — plus élevé = meilleur recall, plus de RAM
- `ef_construction` (défaut 64) : qualité de construction — augmenter à 128-512 pour la production

### Index IVFFlat

IVFFlat divise l'espace vectoriel en `lists` clusters. Une requête ne cherche que dans les clusters les plus proches (`probes`). Construction plus rapide que HNSW, recall légèrement inférieur.

```sql
-- IVFFlat : lists ≈ sqrt(nombre de lignes)
-- ⚠ Exige des données existantes — ne pas créer sur table vide
CREATE INDEX idx_souvenirs_ivfflat
ON souvenirs
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- Tuning recall à la requête
SET ivfflat.probes = 10;   -- défaut : 1, recommandé : sqrt(lists)

-- pgvector 0.8 : iterative_scan pour les requêtes filtrées
SET ivfflat.iterative_scan = 'relaxed_order';
SELECT titre, embedding <=> $1::vector AS dist
FROM souvenirs
WHERE famille_id = 42
ORDER BY dist LIMIT 10;
```

### HNSW vs IVFFlat

| Critère | HNSW | IVFFlat |
|---------|------|---------|
| Construction | Lente (RAM élevée) | Rapide |
| Recall | Excellent (95-99 %) | Bon (85-95 %) |
| Insertions dynamiques | Sans dégradation | Nécessite REINDEX périodique |
| Filtres WHERE | `hnsw.ef_search` + index B-tree | `iterative_scan = relaxed_order` (0.8+) |
| Cas d'usage | Production, données dynamiques | Batch statique, RAM contrainte |

**Règle** : choisir HNSW pour une nouvelle application. IVFFlat si les données sont reconstruites en batch et que la RAM est limitée.

### Pattern RAG

RAG (Retrieval-Augmented Generation) = récupérer les documents pertinents via similarité vectorielle, puis les passer en contexte à un LLM pour qu'il génère une réponse ancrée dans ces documents.

```
Question utilisateur
        │
        ▼
   Embedding de la question  (même modèle que l'indexation)
        │
        ▼
   SELECT TOP-K souvenirs  (pgvector + filtres SQL)
        │
        ▼
   Contexte injecté dans le prompt LLM
        │
        ▼
   Réponse LLM citant les vrais souvenirs de la famille
```

PostgreSQL avec pgvector est l'endroit naturel pour la couche retrieval : on combine similarité vectorielle et filtres SQL (`famille_id`, `created_at`…) sans infrastructure supplémentaire.

## 3. Worked examples

### Exemple A — Stocker les embeddings des souvenirs TribuZen

Objectif : définir le schéma, générer un embedding via l'API OpenAI et l'insérer avec le souvenir.

```sql
-- Schéma complet
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE souvenirs (
    id          SERIAL PRIMARY KEY,
    auteur_id   INT NOT NULL,
    famille_id  INT NOT NULL,
    titre       TEXT NOT NULL,
    contenu     TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now(),
    embedding   vector(1536)
);

-- Index HNSW pour la recherche sémantique
CREATE INDEX idx_souvenirs_hnsw
ON souvenirs
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Index B-tree pour les filtres métier
CREATE INDEX idx_souvenirs_famille ON souvenirs (famille_id);
```

```typescript
// npm install pg pgvector openai
// npm install -D @types/pg
import pg from 'pg';
import pgvector from 'pgvector/pg';
import OpenAI from 'openai';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await pgvector.registerTypes(pool);   // ⚠ obligatoire avant toute requête vectorielle

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function genererEmbedding(texte: string): Promise<number[]> {
    const res = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: texte,
    });
    return res.data[0].embedding;   // number[] de dimension 1536
}

async function creerSouvenir(
    auteurId: number,
    familleId: number,
    titre: string,
    contenu: string,
): Promise<number> {
    // Combiner titre + contenu pour que l'embedding capte les deux
    const embedding = await genererEmbedding(`${titre}. ${contenu}`);

    const { rows } = await pool.query<{ id: number }>(`
        INSERT INTO souvenirs (auteur_id, famille_id, titre, contenu, embedding)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
    `, [auteurId, familleId, titre, contenu, pgvector.toSql(embedding)]);

    return rows[0].id;
}

// Utilisation
await creerSouvenir(
    1, 42,
    'Goûter du dimanche',
    'Ce dimanche chez grand-mère, les enfants ont fait des gâteaux ensemble.',
);
```

Pas-à-pas : (1) on concatène titre + contenu pour que l'embedding capte les deux champs ; (2) `pgvector.toSql()` sérialise le tableau JS en format `[0.12,-0.34,…]` attendu par PostgreSQL ; (3) l'index HNSW est mis à jour automatiquement à l'insertion — pas de REINDEX nécessaire.

### Exemple B — Recherche de similarité dans les souvenirs famille

Objectif : retrouver les 5 souvenirs les plus proches d'une requête utilisateur, filtrés par famille.

```sql
-- Requête SQL directe
-- $1 = vecteur de la requête, $2 = famille_id, $3 = limite
SELECT
    id,
    titre,
    left(contenu, 120) AS extrait,
    1 - (embedding <=> $1::vector) AS similarite
FROM souvenirs
WHERE famille_id = $2
  AND embedding IS NOT NULL
ORDER BY embedding <=> $1::vector
LIMIT $3;
```

```typescript
interface ResultatRecherche {
    id: number;
    titre: string;
    extrait: string;
    similarite: number;
}

async function chercherSouvenirs(
    requete: string,
    familleId: number,
    limite = 5,
): Promise<ResultatRecherche[]> {
    // ⚠ Même modèle qu'à l'insertion — mélanger les modèles produit des distances sans sens
    const embedding = await genererEmbedding(requete);

    const { rows } = await pool.query<ResultatRecherche>(`
        SELECT
            id,
            titre,
            left(contenu, 120) AS extrait,
            1 - (embedding <=> $1::vector) AS similarite
        FROM souvenirs
        WHERE famille_id = $2
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $3
    `, [pgvector.toSql(embedding), familleId, limite]);

    return rows;
}

// Utilisation
const resultats = await chercherSouvenirs('les moments doux avec mamie', 42);
// → [{ titre: 'Goûter du dimanche chez grand-mère', similarite: 0.91, … }, …]
for (const r of resultats) {
    console.log(`${r.titre} (${(r.similarite * 100).toFixed(0)}%) — ${r.extrait}`);
}
```

Pas-à-pas : (1) l'embedding de la requête doit utiliser le **même** modèle que celui de l'insertion — des espaces vectoriels différents produisent des distances sans signification ; (2) le filtre `famille_id = $2` restreint la recherche à la famille concernée, combinant isolation relationnelle et recherche sémantique ; (3) `1 - distance` convertit la distance cosinus en score de similarité lisible (0 à 1).

### Exemple C — Pattern RAG sur les souvenirs

Objectif : assembler la couche retrieval PostgreSQL du pattern RAG — pgvector extrait les souvenirs pertinents, le LLM génère une réponse ancrée dans la vraie histoire familiale.

```typescript
async function ragSouvenirs(
    question: string,
    familleId: number,
): Promise<string> {
    // Étape 1 : retrieval — top-5 souvenirs pertinents via pgvector
    const souvenirs = await chercherSouvenirs(question, familleId, 5);

    if (souvenirs.length === 0) {
        return "Aucun souvenir correspondant trouvé pour cette famille.";
    }

    // Étape 2 : construction du contexte injecté dans le prompt
    const contexte = souvenirs
        .map((s, i) =>
            `[${i + 1}] "${s.titre}" (similarité ${(s.similarite * 100).toFixed(0)}%)\n${s.extrait}`
        )
        .join('\n\n');

    // Étape 3 : génération LLM avec contexte ancré
    const reponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            {
                role: 'system',
                content: "Tu es l'assistant mémoire de TribuZen. Réponds uniquement à partir des souvenirs fournis. Cite le numéro du souvenir entre crochets.",
            },
            {
                role: 'user',
                content: `Question : ${question}\n\nSouvenirs disponibles :\n${contexte}`,
            },
        ],
    });

    return reponse.choices[0].message.content ?? '';
}

// Utilisation
const rep = await ragSouvenirs("Quand est-ce qu'on a fait des gâteaux en famille ?", 42);
// → "D'après le souvenir [1] 'Goûter du dimanche', les enfants ont fait des gâteaux…"
```

Pas-à-pas : (1) pgvector fait le travail dur — trouver les documents pertinents dans toute la base via HNSW ; (2) on passe les top-k souvenirs en contexte au LLM, pas toute la table — contrôle du coût en tokens ; (3) le LLM répond en citant les vrais souvenirs → réponse vérifiable, ancrée dans la réalité de la famille, sans hallucination sur des souvenirs inexistants.

## 4. Pièges & misconceptions

- **Mélanger les modèles d'embeddings dans la même colonne.** Un vecteur OpenAI et un vecteur Cohere vivent dans des espaces vectoriels différents — leurs distances sont sans signification. pgvector lève même une erreur si les dimensions diffèrent (`ERROR: different vector dimensions`). *Correct* : un seul modèle par colonne, documenté dans le schéma et idéalement dans une contrainte de commentaire.

- **Créer un index IVFFlat sur une table vide.** IVFFlat nécessite des données existantes pour calculer les `lists` clusters lors du `CREATE INDEX`. Sur table vide, l'index est créé mais inutilisable. *Correct* : insérer les données en premier, puis créer l'index IVFFlat ; pour les données dynamiques, préférer HNSW qui accepte les insertions incrémentielles sans dégradation.

- **Oublier `pgvector.registerTypes(pool)` côté Node.js.** Sans cet appel, node-postgres reçoit les vecteurs sous forme de chaîne brute et les opérations de comparaison échouent ou retournent des résultats silencieusement incorrects. *Correct* : appeler `await pgvector.registerTypes(pool)` une fois au démarrage, avant toute requête vectorielle.

- **Confondre distance cosinus et similarité cosinus.** L'opérateur `<=>` retourne une **distance** (0 = identique, 2 = opposés). Trier par `distance DESC` donne les résultats les moins pertinents en premier. *Correct* : toujours `ORDER BY embedding <=> $1 LIMIT k` pour les plus proches, et convertir avec `1 - distance` uniquement pour l'affichage du score.

- **Laisser `hnsw.ef_search` au défaut (40) en production.** La valeur par défaut favorise la vitesse au détriment du recall (~85 %). Pour une recherche de souvenirs familiaux, un recall de 95 %+ est attendu. *Correct* : `SET hnsw.ef_search = 100` au niveau session, ou configurer dans `postgresql.conf` pour l'appliquer globalement.

- **Négliger l'index B-tree sur les colonnes de filtre.** Un filtre `WHERE famille_id = 42` combiné à `ORDER BY embedding <=>` oblige PostgreSQL à choisir entre l'index HNSW et le scan. Sans B-tree sur `famille_id`, PostgreSQL peut scanner toute la table avant de trier. *Correct* : créer un index B-tree sur toute colonne de filtre métier utilisée avec la recherche vectorielle.

- **Appeler l'API d'embedding une fois par texte lors d'une migration.** Vectoriser des milliers de souvenirs un par un coûte du temps et de l'argent. OpenAI accepte jusqu'à 2048 textes par appel. *Correct* : regrouper les textes en batches (`openai.embeddings.create({ input: textes[] })`) et insérer en batch avec des transactions groupées.

## 5. Ancrage TribuZen

Couche fil-rouge : **recherche sémantique dans les souvenirs et le journal** de `smaurier/tribuzen`.

- La table `souvenirs` (Exemples A et B) est la pièce centrale du module Mémoire de TribuZen : chaque souvenir posté par un membre est vectorisé à l'insertion via `creerSouvenir`. Le titre et le contenu sont concaténés pour un embedding riche.
- Le filtre `famille_id` est le garde-fou d'isolation : un utilisateur ne retrouve que les souvenirs de **sa** famille, combinant la sécurité relationnelle classique (FK, Row-Level Security) avec la recherche vectorielle. C'est l'avantage structurel de pgvector sur les bases vectorielles dédiées qui ne connaissent pas les jointures.
- La recherche de similarité (Exemple B) alimente le moteur de découverte : "retrouve-moi des moments comme celui-là", "qu'est-ce que nous avons fait l'été dernier", sans correspondance exacte de mots.
- Le pattern RAG (Exemple C) est la fondation de l'assistant mémoire familial : l'utilisateur pose une question en langage naturel, pgvector extrait les souvenirs pertinents, le LLM génère une réponse ancrée dans la vraie histoire de la famille — sans halluciner des souvenirs inventés.
- L'index HNSW accepte les insertions dynamiques sans REINDEX : adapté au rythme réel de TribuZen où les familles ajoutent des souvenirs au fil du temps, pas en batch unique.

## 6. Points clés

1. `CREATE EXTENSION IF NOT EXISTS vector;` active pgvector par base de données ; la colonne `vector(n)` fixe la dimension à la création — non modifiable sans migration.
2. Un embedding = projection d'un texte en vecteur de dimension fixe ; deux textes sémantiquement proches → vecteurs proches ; le modèle doit être le même à l'indexation et à la requête.
3. Opérateur `<=>` (cosinus) par défaut pour la recherche sémantique sur texte ; `1 - (embedding <=> query)` convertit la distance en similarité lisible de 0 à 1.
4. HNSW : meilleur recall (95-99 %), insertions dynamiques sans dégradation, `hnsw.ef_search` pour tuner la qualité à la requête ; préférer en production.
5. IVFFlat : construction rapide, `ivfflat.probes` pour tuner, `iterative_scan = 'relaxed_order'` (pgvector 0.8) améliore le recall sur requêtes filtrées ; exige des données à la création.
6. Toujours un seul modèle d'embedding par colonne — mélanger OpenAI et Cohere produit des distances sans signification.
7. Pattern RAG sur PostgreSQL = retrieval pgvector + contexte injecté dans un prompt LLM ; pas d'infrastructure vectorielle supplémentaire si l'application utilise déjà PostgreSQL.
8. Combiner filtre SQL (`famille_id`, dates…) + `ORDER BY embedding <=>` : avantage clé de pgvector sur les bases vectorielles dédiées qui ne supportent pas les jointures ni le filtrage relationnel natif.

## 7. Seeds Anki

```
Quelle commande active pgvector dans une base PostgreSQL ?|CREATE EXTENSION IF NOT EXISTS vector; — à exécuter dans chaque base de données concernée, pas une seule fois sur le serveur
Quel opérateur pgvector utiliser par défaut pour la recherche sémantique sur texte ?|<=> (distance cosinus) — recommandé par OpenAI et Cohere pour les embeddings textuels ; ORDER BY embedding <=> query LIMIT k
Comment convertir une distance cosinus pgvector en score de similarité 0-1 ?|1 - (embedding <=> query::vector) — la distance 0 (identique) devient similarité 1, la distance 2 (opposés) devient 0
Différence principale entre HNSW et IVFFlat dans pgvector ?|HNSW = meilleur recall (95-99 %), insertions dynamiques, lent à construire ; IVFFlat = construction rapide, REINDEX périodique, recall 85-95 %
Quel paramètre de session améliore le recall des requêtes HNSW ?|SET hnsw.ef_search = 100 (défaut 40) — plus élevé = meilleur recall, requête plus lente
Pourquoi IVFFlat ne peut-il pas être créé sur une table vide ?|Il nécessite des données existantes pour calculer les clusters (lists) lors du CREATE INDEX
Quel est le rôle de pgvector dans le pattern RAG ?|La couche retrieval — trouver les k documents les plus similaires à la question via similarité vectorielle, passés en contexte au LLM
Pourquoi ne pas mélanger deux modèles d'embeddings dans la même colonne vector ?|Les vecteurs vivent dans des espaces vectoriels différents, leurs distances sont sans signification ; pgvector lève ERROR si les dimensions diffèrent
Quel appel Node.js est obligatoire avant d'utiliser pgvector avec node-postgres ?|await pgvector.registerTypes(pool) — enregistre le type vector pour que node-postgres désérialise correctement les résultats
```

> **Note — pas de lab dédié pour ce module.** C'est le dernier module du parcours `10-postgresql`. La pratique est intégrée aux worked examples ci-dessus : le schéma `souvenirs`, l'insertion avec embedding, la recherche de similarité et le pattern RAG sont des blocs complets, exécutables sur ta base locale. Lance une instance Docker avec `pgvector/pgvector:pg17` et rejoue les trois exemples de bout en bout.

---

## Navigation

| Précédent | Suivant |
|-----------|---------|
| [Module 18 — Partitioning et Scaling](./18-partitioning-et-scaling.md) | Dernier module du parcours 10-postgresql |
