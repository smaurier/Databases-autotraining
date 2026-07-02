---
titre: Partitioning et scaling
cours: 10-postgresql
notions: [partitionnement de table range list hash, partitionnement déclaratif, élagage des partitions partition pruning, maintenance des partitions, concepts de sharding, scaling vertical vs horizontal, pooling de connexions pgbouncer]
outcomes: [partitionner une grande table par plage, bénéficier du partition pruning, gérer le cycle de vie des partitions, situer sharding et pooling dans une stratégie de scaling]
prerequis: [17-monitoring-et-observabilite]
next: 19-pgvector-embeddings
libs: [{ name: postgresql, version: "17" }]
tribuzen: partitionner la table posts de TribuZen par mois pour garder le feed rapide à grande échelle
last-reviewed: 2026-07
---

# Partitioning et scaling

> **Outcomes — tu sauras FAIRE :** partitionner une grande table par plage de dates, vérifier et exploiter le partition pruning avec `EXPLAIN ANALYZE`, gérer le cycle de vie des partitions (création, DETACH, DROP), et situer sharding et pooling dans une stratégie de scaling.
> **Difficulté :** :star::star::star::star:

## 1. Cas concret d'abord

La table `posts` de TribuZen a démarré à quelques milliers de lignes — le feed famille chargeait en 0,8 ms. Six mois plus tard, avec 8 millions de posts sur 200 familles, la même requête prend **3,4 secondes**. L'index `(family_id, created_at DESC)` du module 11 aide sur les petits volumes, mais avec 8 M de lignes le Bitmap Heap Scan explose :

```sql
-- Plan observé sur la table monolithique actuelle
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content, created_at
FROM posts
WHERE family_id = 12
ORDER BY created_at DESC
LIMIT 20;
```

```
Bitmap Heap Scan on posts  (actual time=1820.310..3397.540 rows=20 loops=1)
  Buffers: shared hit=1240 read=62820
  ->  Bitmap Index Scan on idx_posts_family_date
        (actual time=1810.040..1810.050 rows=41000 loops=1)
        Buffers: shared read=62820
Execution Time: 3397.8 ms
```

PostgreSQL lit 62 820 pages parce qu'il traverse **tous** les posts de la famille 12 sur 8 mois avant d'en extraire 20. En plus, l'équipe redoute de purger les vieux posts : `DELETE FROM posts WHERE created_at < '2026-01-01'` sur 5 millions de lignes serait une opération de plusieurs heures avec des millions de dead tuples à nettoyer.

La solution : partitionner `posts` par mois. La même requête ne lira plus qu'**une** partition (le mois courant) et la purge des données anciennes deviendra instantanée avec `DROP TABLE partition`.

## 2. Théorie complète, concise

### Partitionnement déclaratif

Depuis PostgreSQL 10, le partitionnement est **déclaratif** : on déclare `PARTITION BY RANGE | LIST | HASH` sur la table parent, puis on crée des sous-tables (partitions) qui héritent du schéma. Le moteur route automatiquement `INSERT`, `UPDATE` et `SELECT` vers la bonne partition.

Trois stratégies :

- **RANGE** — plages continues sur une colonne ordonnée (date, ID numérique). Cas le plus courant pour les données temporelles. Borne inférieure incluse, borne supérieure exclue : `[FROM, TO)`.
- **LIST** — ensemble fini de valeurs discrètes (région, statut, tenant_id). Idéal pour le multi-tenant ou la répartition géographique.
- **HASH** — distribution uniforme par hachage (`MODULUS`, `REMAINDER`). Utile quand il n'y a pas de critère naturel de découpage.

```sql
-- RANGE : table posts partitionnée par mois de création
CREATE TABLE posts (
  id         BIGINT GENERATED ALWAYS AS IDENTITY,
  family_id  INT NOT NULL,
  author_id  INT NOT NULL,
  content    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)      -- ⚠ la colonne de partition doit être dans la PK
) PARTITION BY RANGE (created_at);

-- Partitions concrètes (bornes [FROM, TO))
CREATE TABLE posts_2026_06 PARTITION OF posts
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE posts_2026_07 PARTITION OF posts
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- Partition par défaut : capte les lignes hors plage définie
CREATE TABLE posts_default PARTITION OF posts DEFAULT;
```

### Élagage des partitions (partition pruning)

Le planificateur élimine statiquement ou dynamiquement les partitions dont la plage ne peut pas contenir de lignes satisfaisant la clause `WHERE`. C'est le gain principal du partitionnement. Le champ `Subplans Removed: N` dans le plan `EXPLAIN` indique combien de partitions ont été élaguées.

**Condition nécessaire** : la clause `WHERE` doit filtrer sur la **colonne de partition**. Un filtre uniquement sur `family_id` sans condition sur `created_at` scanne **toutes** les partitions — aucun pruning.

```sql
-- Le pruning s'active car WHERE porte sur la colonne de partition (created_at)
EXPLAIN (ANALYZE)
SELECT id, content, created_at
FROM posts
WHERE family_id = 12
  AND created_at >= '2026-07-01'
  AND created_at <  '2026-08-01'
ORDER BY created_at DESC
LIMIT 20;
-- → Index Scan on posts_2026_07 seulement ; Subplans Removed: 2
-- Execution Time: 0.5 ms

-- Pas de pruning : filtre uniquement sur family_id
EXPLAIN SELECT * FROM posts WHERE family_id = 12;
-- → Seq Scan on posts_2026_06, posts_2026_07, posts_default (toutes)
```

### Règle PK/UNIQUE et propagation des index

Contrainte fondamentale : toute `PRIMARY KEY` ou contrainte `UNIQUE` sur une table partitionnée **doit inclure la colonne de partition**. Sans ça, PostgreSQL ne peut pas garantir l'unicité globale sans scanner toutes les partitions et refuse la définition.

Un index créé sur la table parent est automatiquement propagé à toutes les partitions **existantes** et à celles créées ultérieurement via `CREATE TABLE ... PARTITION OF`.

```sql
-- INCORRECT — erreur à l'exécution :
-- "unique constraint on partitioned table must include all partitioning columns"
CREATE TABLE posts (
  id         BIGINT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL
) PARTITION BY RANGE (created_at);

-- CORRECT
CREATE TABLE posts (
  id         BIGINT GENERATED ALWAYS AS IDENTITY,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Index parent propagé à toutes les partitions existantes et futures
CREATE INDEX ON posts (family_id, created_at DESC);
```

### Maintenance du cycle de vie des partitions

**Créer les partitions à l'avance.** Si une ligne arrive sans partition correspondante et qu'il n'y a pas de partition DEFAULT, PostgreSQL lève une erreur. Planifier la création 1 à 3 mois en avance — via un cron, `pg_cron`, ou une fonction PL/pgSQL planifiée.

**DROP partition vs DELETE.** Supprimer une partition entière est quasi-instantané et ne génère aucun dead tuple ni WAL excessif :

```sql
-- Supprimer un mois entier de posts : instantané, sans dead tuples
DROP TABLE posts_2025_12;

-- Équivalent DELETE massif — NE PAS faire en production :
-- DELETE FROM posts WHERE created_at < '2026-01-01';
-- → Seq Scan sur des millions de lignes, génère des dead tuples,
--   nécessite un VACUUM long, peut prendre des heures

-- Détacher sans supprimer (archivage) : non bloquant depuis PG 14
ALTER TABLE posts DETACH PARTITION posts_2026_05 CONCURRENTLY;
-- posts_2026_05 existe toujours comme table autonome consultable
-- Les requêtes sur posts ne la voient plus

-- ATTACH : ajouter une table existante comme partition
-- (créer + valider hors partition, puis attacher rapidement)
CREATE TABLE posts_2026_08 (LIKE posts INCLUDING ALL);
ALTER TABLE posts_2026_08 ADD CONSTRAINT chk_2026_08
  CHECK (created_at >= '2026-08-01' AND created_at < '2026-09-01');
ALTER TABLE posts ATTACH PARTITION posts_2026_08
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
```

### Scaling vertical vs horizontal

| Axe | Mécanisme | Quand l'utiliser |
|-----|-----------|-----------------|
| Vertical | Plus de CPU/RAM/SSD sur le même serveur | Premier réflexe — sans changement d'architecture |
| Horizontal lecture | Read replicas (streaming replication) | Trafic de lecture dominant, déjà optimisé en écriture |
| Horizontal écriture | Sharding (Citus, FDW + partitions) | Écriture dépasse la capacité d'un seul nœud — rare avant plusieurs TB |

Le partitionnement local (un seul serveur) couvre la majorité des besoins jusqu'à quelques centaines de Go. Le sharding distribué apporte une complexité opérationnelle élevée ; ne l'envisager qu'après épuisement des optimisations locales (index, partitionnement, read replicas).

### Pooling de connexions — PgBouncer

Chaque connexion PostgreSQL crée un processus OS (~5-10 MB RAM). Une app Node.js multi-instances peut ouvrir des centaines de connexions et dépasser `max_connections`. PgBouncer agit comme proxy entre l'app et PostgreSQL en mode **transaction pooling** : une connexion PG sert plusieurs clients applicatifs, chacun la recevant seulement le temps d'une transaction.

```sql
-- Diagnostiquer la pression sur les connexions
SELECT state, count(*)
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state
ORDER BY count(*) DESC;
-- Si "idle in transaction" est élevé → transactions trop longues ou PgBouncer utile
```

Règle empirique : `max_connections` PG ≤ `(CPUs × 2) + nb_disques`. PgBouncer multiplie la capacité applicative sans toucher à cette limite.

## 3. Worked examples

### Exemple A — Partitionner posts par mois et vérifier le pruning

Contexte : créer le schéma partitionné TribuZen sur une base de dev, injecter des données et mesurer le gain réel.

```sql
-- Schéma de base TribuZen (version dev)
CREATE TABLE users    (id SERIAL PRIMARY KEY, display_name TEXT NOT NULL);
CREATE TABLE families (id SERIAL PRIMARY KEY, name TEXT NOT NULL);

-- Table partitionnée — PK inclut la colonne de partition
CREATE TABLE posts (
  id         BIGINT GENERATED ALWAYS AS IDENTITY,
  family_id  INT NOT NULL REFERENCES families(id),
  author_id  INT NOT NULL REFERENCES users(id),
  content    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Trois mois de partitions (couvrent les données de test)
CREATE TABLE posts_2026_05 PARTITION OF posts
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE posts_2026_06 PARTITION OF posts
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE posts_2026_07 PARTITION OF posts
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE posts_default PARTITION OF posts DEFAULT;

-- Index composite propagé à toutes les partitions
CREATE INDEX ON posts (family_id, created_at DESC);

-- Données de test (500 000 posts répartis sur 3 mois)
INSERT INTO users    SELECT i, 'User '||i FROM generate_series(1, 200) i;
INSERT INTO families SELECT i, 'Famille '||i FROM generate_series(1, 20) i;
INSERT INTO posts (family_id, author_id, content, created_at)
  SELECT
    (random()*19 + 1)::int,
    (random()*199 + 1)::int,
    repeat('contenu tribuzen ', 8),
    now() - (random()*89 || ' days')::interval
  FROM generate_series(1, 500000);
ANALYZE;
```

Vérification du pruning et mesure du gain :

```sql
-- Requête avec filtre sur la colonne de partition : pruning actif
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, content, created_at
FROM posts
WHERE family_id = 5
  AND created_at >= '2026-07-01'
  AND created_at <  '2026-08-01'
ORDER BY created_at DESC
LIMIT 20;
```

```
Limit  (actual time=0.140..0.370 rows=20 loops=1)
  ->  Index Scan using posts_2026_07_family_id_created_at_idx on posts_2026_07
        (actual time=0.135..0.360 rows=20 loops=1)
        Index Cond: ((family_id = 5) AND (created_at >= '2026-07-01') AND ...)
        Buffers: shared hit=6
Execution Time: 0.4 ms
```

Inspecter les partitions et leurs tailles :

```sql
SELECT
  inhrelid::regclass                            AS partition,
  pg_size_pretty(pg_total_relation_size(inhrelid)) AS taille,
  pg_stat_get_live_tuples(inhrelid)             AS lignes_vivantes
FROM pg_inherits
WHERE inhparent = 'posts'::regclass
ORDER BY partition;
```

Pas-à-pas : (1) La table parent `posts` est une enveloppe de routage vide — toutes les lignes sont dans les partitions concrètes. (2) L'index créé sur `posts` se propage à `posts_2026_05`, `posts_2026_06`, `posts_2026_07` et `posts_default` — aucune création manuelle par partition. (3) Le plan `Index Scan ... on posts_2026_07` confirme que seule la partition de juillet a été scannée — les deux autres sont élaguées (`Subplans Removed: 2`). (4) 6 pages lues au lieu de 62 820 : gain de ×10 000 sur la latence. (5) `pg_inherits` est la vue canonique pour lister les partitions ; `pg_total_relation_size` inclut les index de la partition.

### Exemple B — Cycle de vie : DETACH + DROP d'une vieille partition

Objectif : archiver `posts_2026_05` sans bloquer les requêtes en cours, puis la supprimer.

```sql
-- Étape 1 : DETACH CONCURRENTLY (PG 14+) — non bloquant pour les lecteurs
-- La partition est retirée de l'arbre de routage ; les requêtes sur posts ne la voient plus
-- Les sessions déjà en cours sur posts_2026_05 ne sont pas interrompues
ALTER TABLE posts DETACH PARTITION posts_2026_05 CONCURRENTLY;

-- Étape 2 : posts_2026_05 existe toujours comme table autonome
SELECT count(*) FROM posts_2026_05;   -- consultable directement

-- Étape 3 (optionnel) : export avant suppression
-- COPY posts_2026_05 TO '/backups/posts_2026_05.csv' CSV HEADER;

-- Étape 4 : DROP instantané — supprime le fichier sur disque en ~50 ms
-- Aucun dead tuple, aucun VACUUM nécessaire
DROP TABLE posts_2026_05;

-- Comparer avec le DELETE équivalent (ne pas faire en production) :
-- DELETE FROM posts WHERE created_at < '2026-06-01';
-- → Seq Scan + dead tuples sur des millions de lignes → VACUUM obligatoire,
--   blocage partiel d'autovacuum, durée estimée : plusieurs heures
```

Inspection de l'état après le cycle :

```sql
-- Vérifier que posts_2026_05 n'apparaît plus dans l'arbre des partitions
SELECT inhrelid::regclass AS partition
FROM pg_inherits
WHERE inhparent = 'posts'::regclass;
-- → seulement posts_2026_06, posts_2026_07, posts_default
```

Pas-à-pas : (1) `DETACH CONCURRENTLY` est disponible depuis PG 14 ; l'ancienne forme `DETACH` (sans `CONCURRENTLY`) prend un lock `ACCESS SHARE` sur la table parent qui bloque les écrivains le temps du détachement. (2) Après `DETACH`, `posts_2026_05` est une table normale — l'inspecter, l'exporter ou la compresser via `pg_dump -t posts_2026_05`. (3) `DROP TABLE` supprime le fichier de données du système de fichiers en quelques dizaines de millisecondes, sans générer de dead tuples ni déclencher VACUUM. (4) Ce cycle mensuel (DETACH + vérification + DROP) est infiniment plus sûr qu'un DELETE massif et peut être planifié via `pg_cron`.

## 4. Pièges & misconceptions

- **« Un index sur la table parent couvre toutes les partitions. »** Vrai pour les partitions créées avec `CREATE TABLE ... PARTITION OF` après la création de l'index. Mais une table **attachée** via `ATTACH PARTITION` (table existante) n'hérite pas automatiquement des index — il faut les créer sur la table avant l'ATTACH. *Correct* : créer les index sur la nouvelle partition avant de l'attacher, ou vérifier avec `\d partition_name` après l'ATTACH.

- **« Le pruning s'active automatiquement dès qu'on partitionne. »** Seulement si la clause `WHERE` filtre sur la **colonne de partition**. `SELECT ... FROM posts WHERE family_id = 5` sans filtre `created_at` scanne toutes les partitions — zéro gain. *Correct* : s'assurer que les requêtes critiques filtrent sur la clé de partition ; vérifier avec `EXPLAIN` et lire le champ `Subplans Removed`.

- **« La partition DEFAULT est une sécurité anodine. »** Elle devient un blocage quand on veut créer une nouvelle partition couvrant des dates déjà présentes dans DEFAULT. PostgreSQL refuse avec `ERROR: updated partition constraint for default partition would be violated by some row`. *Correct* : créer les partitions **à l'avance** (1-3 mois) et maintenir DEFAULT vide ; si elle contient des données, les déplacer manuellement avant de créer la nouvelle partition.

- **« DROP TABLE d'une partition est comme DROP d'une table normale — irréversible. »** Oui, et c'est exactement l'intention. Mais contrairement à `DETACH`, il n'y a pas d'étape intermédiaire. *Correct* : toujours `DETACH CONCURRENTLY` d'abord, inspecter le contenu, exporter si nécessaire, puis `DROP` — jamais `DROP` directement sur une partition active sans audit.

- **« Partitionner améliore toujours les performances. »** Sur une table de moins d'un million de lignes, le surcoût de planification (évaluer le pruning sur N partitions) peut dépasser le gain. De plus, les insertions unitaires à très haut débit subissent le coût du routage vers la bonne partition. *Correct* : partitionner quand la table dépasse ~10 Go ou ~100 millions de lignes, ou quand la purge par `DROP` est l'objectif principal.

- **« Une FK vers une table partitionnée se déclare normalement. »** La FK doit inclure la colonne de partition. `FOREIGN KEY (post_id) REFERENCES posts(id)` échoue ; il faut `FOREIGN KEY (post_id, created_at) REFERENCES posts(id, created_at)`, ce qui oblige à stocker `created_at` dans la table enfant. *Correct* : concevoir les FK en incluant la clé de partition dès le départ, ou gérer l'intégrité référentielle côté application pour les tables partitionnées.

## 5. Ancrage TribuZen

Couche fil-rouge : **partitionner `posts` par mois** dans `smaurier/tribuzen` pour que le feed famille reste rapide à grande échelle, et purger les vieilles données sans opération lourde.

- La table `posts` partitionnée `PARTITION BY RANGE (created_at)` avec des partitions mensuelles est la cible directe. L'API `/feed` filtre toujours sur `family_id` **et** sur `created_at` (pagination keyset du module 11) — les deux conditions activent le pruning : une seule partition du mois courant est lue, quelle que soit la taille totale de la table.
- L'index `(family_id, created_at DESC)` créé sur la table parent se propage à chaque nouvelle partition — aucune maintenance manuelle par partition n'est nécessaire après la mise en place initiale.
- Le cycle de rétention mensuel (DETACH CONCURRENTLY le 1ᵉʳ du mois + export optionnel + DROP) est planifié via `pg_cron`. Il remplace un `DELETE` massif qui aurait généré des millions de dead tuples et bloqué VACUUM pendant des heures (cf. module 11, autovacuum section).
- `pg_inherits` et `pg_stat_user_tables` (filtrés sur les partitions `posts_*`) alimentent le dashboard de monitoring du module 17 : une partition dont la taille croît anormalement par rapport aux autres signale un bug de timestamp côté app.
- PgBouncer en mode transaction pooling est positionné devant PostgreSQL dès que TribuZen est déployé en multi-instances sur staging : `max_connections` reste à 100, PgBouncer absorbe jusqu'à 1 000 connexions applicatives simultanées.

## 6. Points clés

1. Le partitionnement déclaratif (`PARTITION BY RANGE | LIST | HASH`) découpe une table en sous-tables physiques ; PostgreSQL route INSERT/SELECT automatiquement vers la bonne partition.
2. Le pruning élimine les partitions hors plage lors de la planification — il nécessite un filtre `WHERE` sur la colonne de partition pour s'activer ; vérifier avec `EXPLAIN` et `Subplans Removed`.
3. Toute `PRIMARY KEY` ou contrainte `UNIQUE` doit inclure la colonne de partition — contrainte incontournable à intégrer dès la conception du schéma.
4. Les index créés sur la table parent se propagent aux partitions existantes et à celles créées ultérieurement via `CREATE TABLE ... PARTITION OF`.
5. `DROP TABLE partition` est instantané et sans dead tuples ; un `DELETE` massif sur la même plage génère du bloat et force un VACUUM long — préférer toujours `DETACH CONCURRENTLY` puis `DROP`.
6. `DETACH PARTITION CONCURRENTLY` (PG 14+) est non bloquant pour les lecteurs ; toujours préférer cette forme à `DETACH` seul avant toute suppression.
7. Partitionner n'a de sens qu'au-delà de ~10 Go / ~100 M lignes, ou quand la purge par `DROP` est l'objectif ; sous ce seuil, le surcoût de planification annule le gain.
8. Scaling : vertical d'abord, read replicas pour la lecture, sharding distribué uniquement quand un seul serveur est saturé en écriture. PgBouncer en mode transaction pooling pour le pooling de connexions en multi-instances.

## 7. Seeds Anki

```
Quel mot-clé déclare qu'une table PostgreSQL est partitionnée ?|PARTITION BY suivi de RANGE, LIST ou HASH dans la définition CREATE TABLE
Pourquoi la PRIMARY KEY d'une table partitionnée doit-elle inclure la colonne de partition ?|PostgreSQL ne peut garantir l'unicité qu'au sein d'une partition ; inclure la clé de partition dans la PK est obligatoire sous peine d'erreur à la création
Qu'est-ce que le partition pruning ?|L'élimination statique ou dynamique des partitions dont la plage ne peut pas satisfaire la clause WHERE — seules les partitions candidates sont scannées
Quelle condition est nécessaire pour que le partition pruning s'active ?|La clause WHERE doit filtrer sur la colonne de partition ; un filtre uniquement sur une autre colonne scanne toutes les partitions sans pruning
Pourquoi DROP TABLE d'une partition est-il préférable à DELETE pour purger les anciennes données ?|DROP est instantané, ne génère aucun dead tuple et ne nécessite pas de VACUUM ; DELETE sur des millions de lignes génère du bloat et peut prendre des heures
Qu'apporte DETACH PARTITION CONCURRENTLY par rapport à DETACH seul ?|DETACH CONCURRENTLY (PG 14+) est non bloquant pour les lecteurs et les écrivains ; DETACH seul prend un lock qui peut bloquer les écrivains pendant l'opération
Quel type de partition utiliser pour distribuer uniformément des lignes sans critère naturel d'ordre ?|PARTITION BY HASH — PostgreSQL calcule hash(colonne) % MODULUS et route vers la partition dont le REMAINDER correspond
Dans quel cas le partitionnement peut-il nuire aux performances ?|Table trop petite (< 1M lignes / < 10 Go) : le surcoût de planification dépasse le gain ; ou requêtes sans filtre sur la clé de partition (pas de pruning)
Quel rôle joue PgBouncer en mode transaction pooling ?|Proxy entre l'app et PostgreSQL : une connexion PG sert plusieurs clients applicatifs, chacun la recevant le temps d'une transaction — réduit le nombre de connexions PG ouvertes sans changer max_connections
Quelle vue PostgreSQL liste les partitions d'une table parent ?|pg_inherits — WHERE inhparent = 'table_parent'::regclass ; inhrelid::regclass donne le nom de chaque partition
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-18-partitioning/`. Tu partitionnes la table `posts` de TribuZen par mois, tu vérifies le pruning avec `EXPLAIN ANALYZE`, tu inspectes la taille de chaque partition via `pg_inherits`, et tu simules un cycle de vie complet (DETACH CONCURRENTLY + DROP). Corrigé SQL inline dans le README, aucun fichier séparé.
