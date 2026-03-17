# Module 19 — pgvector & Recherche semantique par embeddings

> **Objectif** : Installer et configurer l'extension pgvector, stocker des vecteurs d'embeddings dans PostgreSQL, creer des index performants (IVFFlat, HNSW), executer des recherches par similarite vectorielle, et integrer le tout dans une application Node.js/TypeScript avec les APIs d'embeddings OpenAI et Cohere.
>
> **Difficulte** : ⭐⭐⭐⭐

---

## 1. Pourquoi stocker des vecteurs dans PostgreSQL ?

Imaginez une bibliotheque classique ou les livres sont ranges par genre, puis par auteur. Si vous cherchez "un livre qui parle de survie en mer avec une touche de poesie", le classement alphabetique ne vous aide pas. Vous auriez besoin d'un bibliothecaire qui **comprend le sens** de chaque livre et peut trouver ceux qui ressemblent a votre description.

> **Analogie** : pgvector transforme PostgreSQL en ce bibliothecaire. Chaque texte (produit, article, question) est converti en un **vecteur** — une liste de nombres qui represente son "sens". Deux textes au sens proche auront des vecteurs proches dans l'espace. La recherche par similarite vectorielle, c'est comme demander au bibliothecaire : "trouve-moi les 10 livres les plus proches de cette description".

```
Recherche classique (mots-cles) :         Recherche semantique (vecteurs) :

  "chaussures running"                      "je cherche quelque chose pour
  → LIKE '%chaussures%'                      courir confortablement"
  → match exact sur les mots                → embedding = [0.12, -0.34, 0.78, ...]
                                            → distance cosinus avec tous les produits
  Resultat :                                Resultat :
  ✓ "Chaussures de running Nike"            ✓ "Chaussures de running Nike"
  ✗ "Baskets pour le jogging"               ✓ "Baskets pour le jogging"
  ✗ "Sneakers de course legeres"            ✓ "Sneakers de course legeres"
                                            ✓ "Semelles sport performance"
```

### Pourquoi pgvector plutot qu'une base vectorielle dediee ?

| Critere | pgvector (PostgreSQL) | Pinecone / Weaviate / Qdrant |
|---------|----------------------|------------------------------|
| Infrastructure | Votre PostgreSQL existant | Service supplementaire |
| Jointures SQL | ✅ Natives | ❌ Impossible |
| Transactions ACID | ✅ Oui | ❌ Eventuelle |
| Filtres WHERE | ✅ Combines avec la similarite | ⚠️ Pre/post-filtrage |
| Scalabilite vectorielle | ✅ Bonne (millions de vecteurs) | ✅ Excellente (milliards) |
| Cout operationnel | Faible (meme infra) | Eleve (service supplementaire) |
| Cas d'usage ideal | < 10M vecteurs, SQL requis | > 100M vecteurs, pur vectoriel |

> **Conseil** : si votre application utilise deja PostgreSQL et que vous avez moins de 10 millions de vecteurs, pgvector est presque toujours le meilleur choix. Vous evitez un service supplementaire, vous gardez vos jointures SQL, et les performances sont excellentes.

---

## 2. Installation et configuration de pgvector

### 2.1 Installation

```bash
# ============================================================
# Ubuntu / Debian
# ============================================================
sudo apt install postgresql-16-pgvector

# ============================================================
# macOS avec Homebrew
# ============================================================
brew install pgvector

# ============================================================
# Docker (image officielle avec pgvector)
# ============================================================
docker run -d \
  --name postgres-vector \
  -e POSTGRES_PASSWORD=secret \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

### 2.2 Activation de l'extension

```sql
-- Activer l'extension dans votre base
CREATE EXTENSION IF NOT EXISTS vector;

-- Verifier l'installation
SELECT * FROM pg_extension WHERE extname = 'vector';
-- extname | extversion
-- --------+-----------
-- vector  | 0.7.4
```

> **Piege classique** : l'extension doit etre activee **par base de donnees**. Si vous avez plusieurs bases sur le meme serveur, executez `CREATE EXTENSION vector` dans chacune.

---

## 3. Types de donnees vectoriels

### 3.1 Le type `vector(n)`

Un vecteur est une liste ordonnee de nombres a virgule flottante. La dimension `n` est fixee a la creation de la colonne.

```sql
-- Creer une table avec une colonne vectorielle
CREATE TABLE products (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    price       NUMERIC(10, 2),
    category    TEXT,
    -- Vecteur d'embedding de dimension 1536 (OpenAI text-embedding-3-small)
    embedding   vector(1536)
);
```

### 3.2 Choisir la dimension

Le choix de la dimension depend du modele d'embedding utilise :

| Modele | Dimension | Qualite | Cout | Cas d'usage |
|--------|-----------|---------|------|-------------|
| OpenAI `text-embedding-3-small` | 1536 | Bonne | $0.02/1M tokens | Usage general, bon rapport qualite/prix |
| OpenAI `text-embedding-3-large` | 3072 | Excellente | $0.13/1M tokens | Haute precision requise |
| Cohere `embed-english-v3.0` | 1024 | Tres bonne | $0.10/1M tokens | Multilingue, classification |
| Sentence-Transformers `all-MiniLM-L6-v2` | 384 | Correcte | Gratuit (local) | Prototypage, budget serre |
| Mistral `mistral-embed` | 1024 | Bonne | $0.10/1M tokens | Ecosysteme Mistral |

```sql
-- Exemples de dimensions courantes
ALTER TABLE products ADD COLUMN embedding_small vector(384);   -- MiniLM
ALTER TABLE products ADD COLUMN embedding_medium vector(1024);  -- Cohere
ALTER TABLE products ADD COLUMN embedding_large vector(1536);   -- OpenAI small
ALTER TABLE products ADD COLUMN embedding_xl vector(3072);      -- OpenAI large
```

> **Conseil** : commencez avec `text-embedding-3-small` (1536 dimensions) d'OpenAI. C'est le meilleur rapport qualite/prix pour la plupart des cas d'usage. Passez a 384 dimensions si vous avez des contraintes de stockage ou de performance.

### 3.3 Operations de base sur les vecteurs

```sql
-- Inserer un vecteur
INSERT INTO products (name, description, price, category, embedding)
VALUES (
    'Running Shoe Pro',
    'Chaussure de course legere avec amorti revolutionnaire',
    129.99,
    'chaussures',
    '[0.12, -0.34, 0.78, ...]'::vector  -- 1536 valeurs
);

-- Recuperer la dimension d'un vecteur
SELECT vector_dims(embedding) FROM products LIMIT 1;
-- → 1536

-- Norme d'un vecteur (utile pour debug)
SELECT vector_norm(embedding) FROM products LIMIT 1;
-- → 1.0 (si normalise)
```

---

## 4. Operateurs de distance

pgvector propose trois operateurs de distance, chacun adapte a des cas d'usage differents.

### 4.1 Les trois operateurs

```sql
-- ============================================================
-- <-> : Distance euclidienne (L2)
-- ============================================================
-- Mesure la distance "en ligne droite" entre deux points.
-- Plus petite = plus similaire.
SELECT name, embedding <-> '[0.12, -0.34, ...]'::vector AS distance
FROM products
ORDER BY distance
LIMIT 5;

-- ============================================================
-- <=> : Distance cosinus
-- ============================================================
-- Mesure l'angle entre deux vecteurs (ignore la magnitude).
-- Plus petite = plus similaire. Valeurs entre 0 et 2.
SELECT name, embedding <=> '[0.12, -0.34, ...]'::vector AS distance
FROM products
ORDER BY distance
LIMIT 5;

-- ============================================================
-- <#> : Produit scalaire negatif (inner product)
-- ============================================================
-- Plus petit (plus negatif) = plus similaire.
-- Utile quand les vecteurs sont deja normalises.
SELECT name, embedding <#> '[0.12, -0.34, ...]'::vector AS distance
FROM products
ORDER BY distance
LIMIT 5;
```

### 4.2 Quel operateur choisir ?

```
┌──────────────────────────────────────────────────────────────┐
│         CHOIX DE L'OPERATEUR DE DISTANCE                      │
│                                                               │
│  <=> (cosinus)                                               │
│  → Le choix par defaut pour la recherche semantique          │
│  → Insensible a la longueur du vecteur                       │
│  → Ideal quand les vecteurs ne sont pas normalises           │
│  → La plupart des APIs d'embedding recommandent cosinus      │
│                                                               │
│  <-> (L2 / euclidienne)                                      │
│  → Sensible a la magnitude des vecteurs                      │
│  → Utile pour des donnees ou la norme a un sens              │
│  → Image similarity, clustering spatial                      │
│                                                               │
│  <#> (inner product)                                         │
│  → Equivalent a cosinus SI les vecteurs sont normalises      │
│  → Plus rapide que cosinus (pas de normalisation)            │
│  → A preferer quand vous normalisez vous-meme les vecteurs   │
└──────────────────────────────────────────────────────────────┘
```

| Operateur | Nom | Plage | Normalisation requise | Cas d'usage |
|-----------|-----|-------|----------------------|-------------|
| `<=>` | Cosinus | 0 a 2 | Non | Recherche semantique (defaut) |
| `<->` | L2 (euclidienne) | 0 a +inf | Non | Clustering, images |
| `<#>` | Inner product | -inf a +inf | Oui (pour similarite) | Vecteurs pre-normalises |

> **Conseil** : utilisez `<=>` (cosinus) sauf si vous avez une raison specifique de faire autrement. C'est l'operateur recommande par OpenAI et Cohere pour leurs embeddings.

---

## 5. Index pour la recherche vectorielle

Sans index, pgvector effectue un scan sequentiel (exact nearest neighbor). Avec des millions de vecteurs, c'est trop lent. Deux types d'index accelerent la recherche au prix d'une approximation.

### 5.1 IVFFlat — Inverted File with Flat Compression

```
IVFFlat :
  1. Decoupe l'espace vectoriel en "clusters" (listes)
  2. Lors d'une requete, ne cherche que dans les clusters les plus proches

  ┌─────────────────────────────────┐
  │  Espace vectoriel               │
  │                                 │
  │   Cluster 1    Cluster 2        │
  │   ┌───────┐    ┌───────┐       │
  │   │ • •   │    │  • •  │       │
  │   │  •    │    │ •  •  │       │
  │   │   •   │    │  •    │       │
  │   └───────┘    └───────┘       │
  │                                 │
  │   Cluster 3    Cluster 4        │
  │   ┌───────┐    ┌───────┐       │
  │   │  •    │    │ •     │       │
  │   │ • •   │    │  • •  │       │
  │   └───────┘    └───────┘       │
  │                                 │
  │  Requete: Q = ⊕                │
  │  → probes = 2 : cherche dans   │
  │    Cluster 2 et Cluster 4      │
  └─────────────────────────────────┘
```

```sql
-- ============================================================
-- Creer un index IVFFlat
-- ============================================================

-- Regle de base : lists = sqrt(nombre_de_lignes)
-- Pour 1M de lignes : lists = 1000
-- Pour 100K de lignes : lists = 316

CREATE INDEX idx_products_embedding_ivfflat
ON products
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- vector_cosine_ops → pour l'operateur <=>
-- vector_l2_ops     → pour l'operateur <->
-- vector_ip_ops     → pour l'operateur <#>
```

**Parametres de tuning IVFFlat :**

| Parametre | Quand | Valeur | Effet |
|-----------|-------|--------|-------|
| `lists` (creation) | CREATE INDEX | sqrt(N) a 4*sqrt(N) | Plus de listes = index plus precis mais plus lent a construire |
| `probes` (requete) | SET ivfflat.probes | 1 a lists | Plus de probes = meilleur recall, requete plus lente |

```sql
-- Augmenter le nombre de probes pour un meilleur recall
SET ivfflat.probes = 10;  -- Defaut = 1, recommande = sqrt(lists)

-- Requete avec le recall ameliore
SELECT name, embedding <=> $1::vector AS distance
FROM products
ORDER BY distance
LIMIT 10;
```

### 5.2 HNSW — Hierarchical Navigable Small World

```
HNSW :
  Graphe multi-niveaux. Les niveaux superieurs sont
  des "autoroutes" pour naviguer rapidement vers la
  zone de l'espace qui nous interesse.

  Niveau 2 (autoroute)  :  A ──────── D ──── F
                           │                  │
  Niveau 1 (route)      :  A ── B ── D ── E ── F
                           │    │    │    │    │
  Niveau 0 (rue)        :  A ─ B ─ C ─ D ─ E ─ F ─ G ─ H

  Recherche de Q (proche de E) :
  → Niveau 2 : part de A, saute a D, saute a F
  → Niveau 1 : de D, va a E (proche !)
  → Niveau 0 : de E, explore les voisins E, D, F
  → Resultat : E (et ses voisins les plus proches)
```

```sql
-- ============================================================
-- Creer un index HNSW
-- ============================================================
CREATE INDEX idx_products_embedding_hnsw
ON products
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

**Parametres de tuning HNSW :**

| Parametre | Quand | Defaut | Plage recommandee | Effet |
|-----------|-------|--------|-------------------|-------|
| `m` | CREATE INDEX | 16 | 8 a 64 | Connexions par noeud. Plus = meilleur recall, plus de RAM |
| `ef_construction` | CREATE INDEX | 64 | 64 a 512 | Qualite de construction. Plus = index plus precis, build plus lent |
| `ef_search` | SET hnsw.ef_search | 40 | 40 a 400 | Qualite de recherche. Plus = meilleur recall, requete plus lente |

```sql
-- Augmenter ef_search pour un meilleur recall
SET hnsw.ef_search = 100;  -- Defaut = 40

-- Requete
SELECT name, embedding <=> $1::vector AS distance
FROM products
ORDER BY distance
LIMIT 10;
```

### 5.3 IVFFlat vs HNSW — comparaison

| Critere | IVFFlat | HNSW |
|---------|---------|------|
| Temps de construction | ⚡ Rapide | 🐢 Lent (5-10x plus) |
| RAM pendant la construction | Faible | Elevee |
| Recall (qualite des resultats) | Bon (85-95%) | Excellent (95-99%) |
| Latence de requete | Bonne | Meilleure |
| Insertion incrementale | ⚠️ Necessite REINDEX periodique | ✅ Supporte nativement |
| Cas d'usage | Donnees statiques, budget RAM serre | Donnees dynamiques, haute qualite requise |

> **Conseil** : preferez **HNSW** pour les nouvelles applications. Le cout de construction est plus eleve mais le recall est meilleur et l'index supporte les insertions sans degradation. Utilisez **IVFFlat** si vous avez des contraintes de RAM ou si vos donnees sont reconstruites en batch.

---

## 6. Recherche hybride : vecteurs + SQL

La force de pgvector par rapport aux bases vectorielles dediees, c'est de **combiner** la recherche semantique avec des filtres SQL classiques.

### 6.1 Vecteurs + WHERE

```sql
-- ============================================================
-- Recherche semantique AVEC filtres metier
-- ============================================================

-- Trouver les 10 produits les plus similaires a une requete
-- MAIS uniquement dans la categorie "chaussures" et en stock
SELECT
    p.id,
    p.name,
    p.price,
    p.category,
    1 - (p.embedding <=> $1::vector) AS similarity  -- Convertir distance en similarite
FROM products p
WHERE p.category = 'chaussures'
  AND p.stock > 0
  AND p.price BETWEEN 50 AND 200
ORDER BY p.embedding <=> $1::vector
LIMIT 10;
```

> **Piege classique** : l'index vectoriel est utilise **avant** les filtres WHERE. Si le WHERE est tres selectif (peu de lignes matchent), PostgreSQL peut choisir de ne pas utiliser l'index vectoriel et faire un scan sequentiel filtre. Dans ce cas, un index composite (B-tree sur category + vector) peut aider.

### 6.2 Vecteurs + Full-Text Search

```sql
-- ============================================================
-- Recherche hybride : semantique + full-text
-- ============================================================

-- Ajouter une colonne tsvector pour le full-text search
ALTER TABLE products ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
        to_tsvector('french', coalesce(name, '') || ' ' || coalesce(description, ''))
    ) STORED;

CREATE INDEX idx_products_fts ON products USING gin(search_vector);

-- Requete hybride : combiner les scores
WITH semantic AS (
    SELECT
        id,
        1 - (embedding <=> $1::vector) AS semantic_score
    FROM products
    ORDER BY embedding <=> $1::vector
    LIMIT 50  -- Pre-filtrage large en semantique
),
fulltext AS (
    SELECT
        id,
        ts_rank(search_vector, plainto_tsquery('french', $2)) AS text_score
    FROM products
    WHERE search_vector @@ plainto_tsquery('french', $2)
)
SELECT
    p.id,
    p.name,
    p.price,
    COALESCE(s.semantic_score, 0) AS semantic_score,
    COALESCE(f.text_score, 0) AS text_score,
    -- Score hybride (pondere)
    0.7 * COALESCE(s.semantic_score, 0) + 0.3 * COALESCE(f.text_score, 0) AS hybrid_score
FROM products p
LEFT JOIN semantic s ON s.id = p.id
LEFT JOIN fulltext f ON f.id = p.id
WHERE s.id IS NOT NULL OR f.id IS NOT NULL
ORDER BY hybrid_score DESC
LIMIT 10;
```

> **Analogie** : la recherche hybride, c'est comme demander a deux experts de noter les memes livres. Le premier (semantique) comprend le sens global. Le second (full-text) repere les mots-cles precis. Vous combinez leurs notes avec une ponderation pour obtenir le meilleur des deux mondes.

### 6.3 Reranking pattern

```sql
-- ============================================================
-- Pattern : sur-recuperer puis reranker
-- ============================================================

-- Etape 1 : recuperer 100 candidats avec l'index vectoriel (rapide)
-- Etape 2 : reranker avec un modele plus precis (cote application)

-- En SQL, on recupere les candidats :
SELECT id, name, description,
       embedding <=> $1::vector AS vector_distance
FROM products
WHERE category = $2
ORDER BY embedding <=> $1::vector
LIMIT 100;

-- Cote Node.js, on reranke avec Cohere Rerank ou un cross-encoder
-- (voir section 7)
```

---

## 7. Integration Node.js / TypeScript

### 7.1 Setup avec pgvector et node-postgres

```typescript
// ============================================================
// Installation
// ============================================================
// npm install pg pgvector openai
// npm install -D @types/pg

import pg from 'pg';
import pgvector from 'pgvector/pg';
import OpenAI from 'openai';

const { Pool } = pg;

// ────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────
const pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'myapp',
    user: 'app',
    password: 'secret',
});

// Enregistrer le type vector pour node-postgres
await pgvector.registerTypes(pool);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
```

### 7.2 Generer des embeddings

```typescript
// ────────────────────────────────────────────────────────────
// Generer un embedding avec OpenAI
// ────────────────────────────────────────────────────────────
async function generateEmbedding(text: string): Promise<number[]> {
    const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
    });
    return response.data[0].embedding;  // number[] de dimension 1536
}

// ────────────────────────────────────────────────────────────
// Generer des embeddings en batch (plus efficace)
// ────────────────────────────────────────────────────────────
async function generateEmbeddings(texts: string[]): Promise<number[][]> {
    // L'API OpenAI accepte un tableau d'inputs
    const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: texts,  // Max 2048 inputs par requete
    });
    // Trier par index pour garantir l'ordre
    return response.data
        .sort((a, b) => a.index - b.index)
        .map(d => d.embedding);
}
```

### 7.3 Inserer et rechercher

```typescript
// ────────────────────────────────────────────────────────────
// Inserer un produit avec son embedding
// ────────────────────────────────────────────────────────────
interface Product {
    id?: number;
    name: string;
    description: string;
    price: number;
    category: string;
}

async function insertProduct(product: Product): Promise<number> {
    const text = `${product.name}: ${product.description}`;
    const embedding = await generateEmbedding(text);

    const { rows } = await pool.query<{ id: number }>(`
        INSERT INTO products (name, description, price, category, embedding)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
    `, [product.name, product.description, product.price, product.category, pgvector.toSql(embedding)]);

    return rows[0].id;
}

// ────────────────────────────────────────────────────────────
// Recherche semantique
// ────────────────────────────────────────────────────────────
interface SearchResult {
    id: number;
    name: string;
    description: string;
    price: number;
    similarity: number;
}

async function searchProducts(
    query: string,
    category?: string,
    limit: number = 10,
): Promise<SearchResult[]> {
    const queryEmbedding = await generateEmbedding(query);

    let sql = `
        SELECT
            id, name, description, price,
            1 - (embedding <=> $1::vector) AS similarity
        FROM products
        WHERE embedding IS NOT NULL
    `;
    const params: unknown[] = [pgvector.toSql(queryEmbedding)];

    if (category) {
        sql += ` AND category = $${params.length + 1}`;
        params.push(category);
    }

    sql += `
        ORDER BY embedding <=> $1::vector
        LIMIT $${params.length + 1}
    `;
    params.push(limit);

    const { rows } = await pool.query<SearchResult>(sql, params);
    return rows;
}

// ────────────────────────────────────────────────────────────
// Utilisation
// ────────────────────────────────────────────────────────────
const results = await searchProducts(
    'chaussure legere pour courir sur route',
    'chaussures',
    5,
);

for (const r of results) {
    console.log(`${r.name} (${(r.similarity * 100).toFixed(1)}%) — ${r.price}€`);
}
// Running Shoe Pro (94.2%) — 129.99€
// Marathon Air Elite (91.8%) — 159.99€
// Trail Runner GTX (87.5%) — 189.99€
```

### 7.4 Integration avec Cohere

```typescript
// ────────────────────────────────────────────────────────────
// Alternative : Cohere pour les embeddings + reranking
// ────────────────────────────────────────────────────────────
// npm install cohere-ai

import { CohereClient } from 'cohere-ai';

const cohere = new CohereClient({ token: process.env.COHERE_API_KEY });

async function generateCohereEmbedding(
    texts: string[],
    inputType: 'search_query' | 'search_document' = 'search_document',
): Promise<number[][]> {
    const response = await cohere.embed({
        texts,
        model: 'embed-english-v3.0',
        inputType,        // Important : differencier query vs document
        embeddingTypes: ['float'],
    });
    return response.embeddings.float!;
}

// Reranking avec Cohere (apres la recherche vectorielle)
async function rerankResults(
    query: string,
    documents: { id: number; text: string }[],
    topN: number = 5,
): Promise<{ id: number; relevanceScore: number }[]> {
    const response = await cohere.rerank({
        query,
        documents: documents.map(d => d.text),
        model: 'rerank-english-v3.0',
        topN,
    });
    return response.results.map(r => ({
        id: documents[r.index].id,
        relevanceScore: r.relevanceScore,
    }));
}
```

> **Conseil** : Cohere differencie les embeddings de type `search_query` et `search_document`. Utilisez `search_document` pour indexer et `search_query` pour chercher. Cela ameliore significativement le recall.

---

## 8. Performance, benchmarks et scaling

### 8.1 Benchmarks de reference

```
┌──────────────────────────────────────────────────────────────┐
│         BENCHMARKS pgvector (serveur 8 vCPU, 32 GB RAM)       │
│                                                               │
│  Dataset : 1 million de vecteurs, dimension 1536              │
│                                                               │
│  Sans index (exact KNN) :                                    │
│  → Latence : ~2000 ms par requete                            │
│  → Recall : 100% (exact)                                     │
│                                                               │
│  IVFFlat (lists=1000, probes=10) :                           │
│  → Latence : ~15 ms par requete                              │
│  → Recall : ~92%                                             │
│  → Construction : ~2 minutes                                 │
│                                                               │
│  HNSW (m=16, ef_construction=128, ef_search=100) :           │
│  → Latence : ~5 ms par requete                               │
│  → Recall : ~98%                                             │
│  → Construction : ~20 minutes                                │
│                                                               │
│  Recommandation : HNSW pour la production                    │
└──────────────────────────────────────────────────────────────┘
```

### 8.2 Optimisation de la RAM

```sql
-- pgvector charge les index en memoire partagee
-- Verifier la taille de vos index

SELECT
    indexrelname AS index_name,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND indexrelname LIKE '%embedding%';

-- index_name                          | index_size
-- ------------------------------------+-----------
-- idx_products_embedding_hnsw         | 2.4 GB
```

```
┌──────────────────────────────────────────────────────────────┐
│         ESTIMATION DE LA RAM REQUISE                          │
│                                                               │
│  Formule approximative pour HNSW :                           │
│  RAM ≈ N × D × 4 bytes × (1 + m/D)                         │
│                                                               │
│  Exemples (dimension 1536) :                                 │
│  100K vecteurs  → ~0.6 GB                                    │
│  1M vecteurs    → ~6 GB                                      │
│  5M vecteurs    → ~30 GB                                     │
│  10M vecteurs   → ~60 GB                                     │
│                                                               │
│  → shared_buffers doit etre suffisant pour contenir l'index  │
│  → Sinon, les requetes vectorielles seront ralenties par     │
│    les lectures disque                                       │
└──────────────────────────────────────────────────────────────┘
```

```sql
-- Ajuster shared_buffers pour pgvector
-- Recommandation : au moins 2x la taille de l'index vectoriel
ALTER SYSTEM SET shared_buffers = '8GB';
ALTER SYSTEM SET effective_cache_size = '24GB';
ALTER SYSTEM SET maintenance_work_mem = '2GB';  -- Pour la construction d'index
SELECT pg_reload_conf();
```

### 8.3 Partitionnement des vecteurs

Pour les tres gros volumes (> 5M vecteurs), combinez pgvector avec le partitionnement PostgreSQL.

```sql
-- ============================================================
-- Partitionnement + pgvector
-- ============================================================

-- Partitionner par categorie (LIST)
CREATE TABLE products_partitioned (
    id          SERIAL,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    embedding   vector(1536),
    PRIMARY KEY (id, category)
) PARTITION BY LIST (category);

CREATE TABLE products_shoes PARTITION OF products_partitioned
    FOR VALUES IN ('chaussures');
CREATE TABLE products_clothes PARTITION OF products_partitioned
    FOR VALUES IN ('vetements');
CREATE TABLE products_electronics PARTITION OF products_partitioned
    FOR VALUES IN ('electronique');

-- Creer un index HNSW sur CHAQUE partition
-- (les index partitionnes sont plus petits = plus rapides)
CREATE INDEX ON products_shoes
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 128);
CREATE INDEX ON products_clothes
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 128);
CREATE INDEX ON products_electronics
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 128);

-- La requete avec filtre sur la categorie beneficie
-- du partition pruning ET de l'index vectoriel
SELECT name, embedding <=> $1::vector AS distance
FROM products_partitioned
WHERE category = 'chaussures'
ORDER BY embedding <=> $1::vector
LIMIT 10;
-- → Ne scanne que la partition products_shoes (et son index HNSW local)
```

### 8.4 Insertion en batch

```typescript
// ============================================================
// Insertion optimisee en batch avec COPY
// ============================================================
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { from as copyFrom } from 'pg-copy-streams';

interface ProductBatch {
    name: string;
    description: string;
    price: number;
    category: string;
    embedding: number[];
}

async function bulkInsertProducts(products: ProductBatch[]): Promise<void> {
    const client = await pool.connect();
    try {
        // Generer les embeddings en batch
        const texts = products.map(p => `${p.name}: ${p.description}`);
        const embeddings = await generateEmbeddings(texts);

        // Utiliser COPY pour l'insertion bulk (10-50x plus rapide qu'INSERT)
        const copyStream = client.query(
            copyFrom(`COPY products (name, description, price, category, embedding)
                       FROM STDIN WITH (FORMAT csv)`)
        );

        const rows = products.map((p, i) => {
            const embStr = `"[${embeddings[i].join(',')}]"`;
            return `"${p.name}","${p.description}",${p.price},"${p.category}",${embStr}`;
        });

        const readable = Readable.from(rows.join('\n') + '\n');
        await pipeline(readable, copyStream);

        console.log(`${products.length} produits inseres`);
    } finally {
        client.release();
    }
}
```

---

## 9. Exemple complet : recherche semantique sur un catalogue produit

```typescript
// ============================================================
// Application complete : Semantic Product Search
// ============================================================

import pg from 'pg';
import pgvector from 'pgvector/pg';
import OpenAI from 'openai';
import express from 'express';

const { Pool } = pg;

// ────────────────────────────────────────────────────────────
// Setup
// ────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pgvector.registerTypes(pool);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ────────────────────────────────────────────────────────────
// Schema
// ────────────────────────────────────────────────────────────
async function initSchema(): Promise<void> {
    await pool.query(`
        CREATE EXTENSION IF NOT EXISTS vector;

        CREATE TABLE IF NOT EXISTS products (
            id          SERIAL PRIMARY KEY,
            name        TEXT NOT NULL,
            description TEXT NOT NULL,
            price       NUMERIC(10, 2) NOT NULL,
            category    TEXT NOT NULL,
            in_stock    BOOLEAN DEFAULT true,
            embedding   vector(1536),
            created_at  TIMESTAMPTZ DEFAULT now()
        );

        CREATE INDEX IF NOT EXISTS idx_products_hnsw
        ON products USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 128);

        CREATE INDEX IF NOT EXISTS idx_products_category
        ON products (category);
    `);
}

// ────────────────────────────────────────────────────────────
// Embedding
// ────────────────────────────────────────────────────────────
async function embed(text: string): Promise<number[]> {
    const res = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: text,
    });
    return res.data[0].embedding;
}

// ────────────────────────────────────────────────────────────
// API Routes
// ────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// POST /products — Ajouter un produit
app.post('/products', async (req, res) => {
    const { name, description, price, category } = req.body;
    const embedding = await embed(`${name}: ${description}`);

    const { rows } = await pool.query(`
        INSERT INTO products (name, description, price, category, embedding)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, name, price, category
    `, [name, description, price, category, pgvector.toSql(embedding)]);

    res.status(201).json(rows[0]);
});

// GET /search?q=...&category=...&min_price=...&max_price=...&limit=...
app.get('/search', async (req, res) => {
    const { q, category, min_price, max_price, limit = '10' } = req.query;

    if (!q || typeof q !== 'string') {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
    }

    const queryEmbedding = await embed(q);
    const params: unknown[] = [pgvector.toSql(queryEmbedding)];
    const conditions: string[] = ['embedding IS NOT NULL', 'in_stock = true'];

    if (category) {
        params.push(category);
        conditions.push(`category = $${params.length}`);
    }
    if (min_price) {
        params.push(Number(min_price));
        conditions.push(`price >= $${params.length}`);
    }
    if (max_price) {
        params.push(Number(max_price));
        conditions.push(`price <= $${params.length}`);
    }

    params.push(Number(limit));

    const sql = `
        SELECT
            id, name, description, price, category,
            1 - (embedding <=> $1::vector) AS similarity
        FROM products
        WHERE ${conditions.join(' AND ')}
        ORDER BY embedding <=> $1::vector
        LIMIT $${params.length}
    `;

    const { rows } = await pool.query(sql, params);
    res.json({ query: q, results: rows });
});

// ────────────────────────────────────────────────────────────
// Start
// ────────────────────────────────────────────────────────────
await initSchema();
app.listen(3000, () => console.log('Semantic search API on :3000'));
```

---

## 10. Exercices mentaux

> **Exercice mental 1** : Vous avez 2 millions de produits avec des embeddings de dimension 1536. Un utilisateur lance la requete `SELECT * FROM products WHERE category = 'livres' ORDER BY embedding <=> $1 LIMIT 5`. La categorie "livres" ne contient que 500 produits. Pourquoi la requete est-elle plus lente que prevu, et comment l'optimiser ?

<details>
<summary>Reponse</summary>

L'index HNSW retourne les voisins les plus proches **sur toute la table** (2M produits), puis PostgreSQL filtre sur `category = 'livres'`. Si les 5 plus proches globalement ne sont pas des livres, PostgreSQL doit recuperer beaucoup plus de candidats.

Solutions :
1. **Partitionner par categorie** : chaque partition a son propre index HNSW, la recherche ne se fait que sur 500 produits
2. **Index partiel** : `CREATE INDEX ON products USING hnsw (embedding vector_cosine_ops) WHERE category = 'livres'`
3. **Sur-recuperer** : `LIMIT 100` puis filtrer applicativement
</details>

> **Exercice mental 2** : Vous utilisez IVFFlat avec `lists = 100` et `probes = 1` (defaut). Votre recall est de 75%. Comment l'ameliorer sans reconstruire l'index ?

<details>
<summary>Reponse</summary>

Augmenter le nombre de probes : `SET ivfflat.probes = 10` (ou meme `= 20`). Plus on sonde de clusters, plus le recall s'ameliore, au prix d'une latence de requete plus elevee. La regle empirique est `probes = sqrt(lists)`, donc pour 100 listes : probes = 10.

Si le recall est toujours insuffisant, il faudra reconstruire l'index avec plus de listes ou migrer vers HNSW.
</details>

> **Exercice mental 3** : Vous stockez des embeddings OpenAI (`text-embedding-3-small`, dimension 1536) et des embeddings Cohere (`embed-v3`, dimension 1024) dans la meme table. Pouvez-vous comparer la distance entre un vecteur OpenAI et un vecteur Cohere ?

<details>
<summary>Reponse</summary>

Non. Les vecteurs de modeles differents vivent dans des **espaces vectoriels differents**. Un vecteur OpenAI de dimension 1536 et un vecteur Cohere de dimension 1024 ne sont pas comparables — meme s'ils representaient le meme texte. D'ailleurs, pgvector refuserait l'operation car les dimensions ne correspondent pas (`ERROR: different vector dimensions`).

Il faut toujours utiliser le **meme modele** pour generer tous les embeddings d'une colonne.
</details>

---

## Ce qu'il faut retenir

```
┌──────────────────────────────────────────────────────────────┐
│                    A RETENIR                                  │
│                                                               │
│  1. pgvector = recherche vectorielle dans PostgreSQL.         │
│     Pas besoin d'une base vectorielle dediee si < 10M        │
│     vecteurs.                                                │
│                                                               │
│  2. Utilisez <=> (cosinus) comme operateur par defaut.       │
│     C'est le choix recommande pour les embeddings textuels.  │
│                                                               │
│  3. HNSW > IVFFlat pour la plupart des cas.                  │
│     Meilleur recall, supporte les insertions incrementales.  │
│                                                               │
│  4. Recherche hybride = vecteurs + WHERE + full-text.        │
│     C'est l'avantage majeur de pgvector vs Pinecone.         │
│                                                               │
│  5. Un meme modele pour tous les vecteurs d'une colonne.     │
│     Jamais de melange OpenAI + Cohere dans la meme colonne.  │
│                                                               │
│  6. Tuning : ef_search (HNSW) et probes (IVFFlat) sont      │
│     les leviers les plus importants cote requete.            │
│                                                               │
│  7. Partitionnement + pgvector = scaling efficace.            │
│     Chaque partition a son propre index vectoriel local.     │
│                                                               │
│  8. Batch les embeddings : l'API OpenAI accepte 2048 textes  │
│     par requete. Ne generez jamais un embedding a la fois.   │
└──────────────────────────────────────────────────────────────┘
```

---

## Navigation

| Precedent | Suivant |
|---|---|
| [Module 18 — Partitioning & Scaling](./18-partitioning-et-scaling.md) | Fin du cours avance |

---

> *"La recherche vectorielle ne remplace pas SQL — elle le complete. La vraie puissance, c'est de combiner la comprehension semantique des embeddings avec la precision chirurgicale des filtres relationnels."*

---

<!-- parcours-recommande -->

::: tip Parcours recommande
Ce module n'a pas encore de lab ni de quiz associe. Revenez bientot !
:::
