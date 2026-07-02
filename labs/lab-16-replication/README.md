# Lab 16 — Réplication PostgreSQL

> **Outcome :** à la fin, tu sais configurer une publication et une subscription sur une instance locale, observer le flux WAL via les vues système, mesurer le lag, et simuler un failover avec `pg_promote()`.
> **Vrai outil :** PostgreSQL 17 (psql). Deux bases sur la même instance — publisher et subscriber — pour simuler la réplication logique sans avoir besoin de deux serveurs.
> **Feedback :** le coach valide en session (pas de test-runner auto-correcteur).

## Prérequis · Durée

- Module 16 lu
- Docker + psql (ou DBeaver)
- `wal_level = logical` requis (vérifier avant de commencer)
- Durée estimée : 60 min

## Setup

```sql
-- Vérifier le niveau WAL (doit être 'logical' pour la réplication logique)
SHOW wal_level;
-- Si 'replica' ou 'minimal' : ALTER SYSTEM SET wal_level = 'logical'; puis redémarrer.

-- Créer les deux bases
CREATE DATABASE tribuzen_pub;
CREATE DATABASE tribuzen_sub;
```

```sql
-- === PUBLISHER (tribuzen_pub) ===
\c tribuzen_pub

CREATE TABLE posts (
    id         SERIAL PRIMARY KEY,
    family_id  INT  NOT NULL,
    author_id  INT  NOT NULL,
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reactions (
    id       SERIAL PRIMARY KEY,
    post_id  INT  NOT NULL REFERENCES posts(id),
    user_id  INT  NOT NULL,
    emoji    TEXT NOT NULL,
    reacted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Données initiales
INSERT INTO posts (family_id, author_id, content)
SELECT (i % 10) + 1, (i % 50) + 1, 'Post TribuZen #' || i
FROM generate_series(1, 200) i;

INSERT INTO reactions (post_id, user_id, emoji)
SELECT (random()*199 + 1)::int, (random()*49 + 1)::int, '❤️'
FROM generate_series(1, 500);
```

```sql
-- === SUBSCRIBER (tribuzen_sub) ===
\c tribuzen_sub

-- Le schéma doit exister AVANT la subscription (la réplication logique ne crée pas les tables)
CREATE TABLE posts (
    id         SERIAL PRIMARY KEY,
    family_id  INT  NOT NULL,
    author_id  INT  NOT NULL,
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reactions (
    id       SERIAL PRIMARY KEY,
    post_id  INT  NOT NULL,   -- pas de FK : le subscriber gère ses contraintes séparément
    user_id  INT  NOT NULL,
    emoji    TEXT NOT NULL,
    reacted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## Étape 1 — Créer la publication

La publication déclare quelles tables le publisher met à disposition.

**TODO** : crée une publication `pub_feed` sur `tribuzen_pub` qui expose les tables `posts` et `reactions`. Puis vérifie que la publication existe.

```sql
-- TODO : dans tribuzen_pub
\c tribuzen_pub
CREATE PUBLICATION ??? FOR TABLE ???, ???;

-- TODO : vérifier
SELECT pubname, pubtables FROM pg_publication_tables ORDER BY pubname, tablename;
```

**Corrigé** :

```sql
\c tribuzen_pub

CREATE PUBLICATION pub_feed FOR TABLE posts, reactions;

-- Vérification
SELECT pubname, tablename
FROM pg_publication_tables
ORDER BY tablename;
--  pubname  | tablename
-- ----------+-----------
--  pub_feed | posts
--  pub_feed | reactions
```

`pg_publication_tables` liste toutes les tables exposées par chaque publication. À ce stade, aucune donnée n'a encore été transférée — la publication est juste la déclaration d'intention côté publisher.

---

## Étape 2 — Créer la subscription et observer la synchronisation initiale

**TODO** : depuis `tribuzen_sub`, crée une subscription `sub_feed` connectée à la publication `pub_feed` de `tribuzen_pub`. Utilise l'utilisateur `postgres` en local.

```sql
\c tribuzen_sub
-- TODO : CREATE SUBSCRIPTION sub_feed CONNECTION '...' PUBLICATION pub_feed;
-- (adapter host, port, dbname, user selon ton Docker)

-- TODO : vérifier l'état de la subscription
SELECT subname, subenabled FROM pg_subscription;
SELECT * FROM pg_stat_subscription;
```

**Corrigé** :

```sql
\c tribuzen_sub

CREATE SUBSCRIPTION sub_feed
    CONNECTION 'host=localhost port=5432 dbname=tribuzen_pub user=postgres password=postgres'
    PUBLICATION pub_feed;

-- PostgreSQL va :
-- 1. Se connecter au publisher
-- 2. Copier les données initiales (snapshot initial)
-- 3. Commencer à recevoir les changements en continu

-- Vérifier l'état
SELECT subname, subenabled, subpublications
FROM pg_subscription;
--  subname  | subenabled | subpublications
-- ----------+------------+-----------------
--  sub_feed | t          | {pub_feed}

-- Confirmer que les données initiales ont été copiées
SELECT COUNT(*) FROM posts;     -- doit retourner 200
SELECT COUNT(*) FROM reactions; -- doit retourner 500
```

La copie initiale (table sync) se produit automatiquement à la création de la subscription — PostgreSQL transfère un snapshot cohérent des tables publiées. Après la sync initiale, le subscriber entre en mode **apply** : il applique les nouveaux changements WAL en quasi-temps réel.

---

## Étape 3 — Observer la réplication en temps réel

**TODO** : insère un post sur le publisher, puis vérifie qu'il apparaît sur le subscriber.

```sql
-- Sur le PUBLISHER
\c tribuzen_pub

-- TODO : insérer 3 posts pour la famille 1
INSERT INTO posts (family_id, author_id, content)
VALUES ???;

-- TODO : sur le SUBSCRIBER, vérifier que les nouveaux posts sont arrivés
\c tribuzen_sub
SELECT id, family_id, content, created_at FROM posts ORDER BY id DESC LIMIT 5;
```

**Corrigé** :

```sql
-- PUBLISHER : insérer des données
\c tribuzen_pub

INSERT INTO posts (family_id, author_id, content) VALUES
    (1, 1, 'Nouvelle du week-end TribuZen'),
    (1, 2, 'Photo de famille reçue'),
    (2, 3, 'Anniversaire bientôt');

-- SUBSCRIBER : les mêmes lignes doivent apparaître (quasi-immédiatement)
\c tribuzen_sub

SELECT id, family_id, content, created_at
FROM posts
ORDER BY id DESC
LIMIT 5;
--  id  | family_id | content                        | created_at
-- -----+-----------+--------------------------------+------------------------------
--  203 |         2 | Anniversaire bientôt           | 2026-07-02 ...
--  202 |         1 | Photo de famille reçue         | 2026-07-02 ...
--  201 |         1 | Nouvelle du week-end TribuZen  | 2026-07-02 ...
```

La réplication logique est **asynchrone par défaut** : il peut y avoir quelques millisecondes entre l'écriture sur le publisher et l'apparition sur le subscriber. Ajouter un `SELECT pg_sleep(0.1)` si les lignes n'apparaissent pas immédiatement.

---

## Étape 4 — Surveiller le lag via pg_stat_replication

Depuis le publisher, la vue `pg_stat_replication` liste les connexions de réplication actives (streaming physique et logique).

**TODO** : depuis `tribuzen_pub`, interroge `pg_stat_replication` pour voir l'état du subscriber. Génère ensuite du volume et mesure le lag.

```sql
\c tribuzen_pub

-- TODO : requête complète sur pg_stat_replication
SELECT ???
FROM pg_stat_replication;

-- Générer du volume pour créer du lag mesurable
INSERT INTO posts (family_id, author_id, content)
SELECT (i % 10) + 1, (i % 50) + 1, 'Stress post ' || i
FROM generate_series(1, 5000) i;

-- TODO : mesurer le lag en octets et en temps
SELECT
    client_addr,
    application_name,
    state,
    ???   AS lag_octets,
    replay_lag
FROM pg_stat_replication;
```

**Corrigé** :

```sql
\c tribuzen_pub

-- Vue complète de la réplication
SELECT
    pid,
    application_name,
    client_addr,
    state,
    sync_state,
    sent_lsn,
    replay_lsn,
    pg_size_pretty(
        pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)
    ) AS lag_taille,
    replay_lag
FROM pg_stat_replication;
--  pid   | application_name | client_addr | state     | sync_state | lag_taille | replay_lag
-- -------+------------------+-------------+-----------+------------+------------+-----------
--  12345 | sub_feed         | 127.0.0.1   | streaming | async      | 8192 bytes | 00:00:00

-- Vérifier les slots de réplication
SELECT slot_name, slot_type, active,
       pg_size_pretty(
           pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
       ) AS wal_retenu
FROM pg_replication_slots;
```

`pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)` calcule le nombre d'octets de WAL que le subscriber n'a pas encore appliqués. Après l'INSERT massif, ce lag peut atteindre quelques MB le temps que le subscriber rattrape — il revient à 0 une fois la synchronisation terminée.

---

## Étape 5 — Décodage logique et inspection du WAL

Le décodage logique permet d'inspecter les opérations WAL sous forme de texte lisible, sans passer par une subscription.

**TODO** : crée un slot de décodage logique `debug_slot` sur `tribuzen_pub` avec le plugin `test_decoding`, insère une ligne, puis lis les changements.

```sql
\c tribuzen_pub

-- TODO : créer un slot de décodage logique
SELECT pg_create_logical_replication_slot(???, ???);

-- TODO : insérer une réaction pour générer un changement
INSERT INTO reactions (post_id, user_id, emoji) VALUES (1, 99, '🔥');

-- TODO : lire les changements depuis le slot
SELECT lsn, xid, data
FROM pg_logical_slot_get_changes(???, NULL, NULL);
```

**Corrigé** :

```sql
\c tribuzen_pub

-- Créer le slot de décodage
SELECT pg_create_logical_replication_slot('debug_slot', 'test_decoding');

-- Insérer un changement
INSERT INTO reactions (post_id, user_id, emoji) VALUES (1, 99, '🔥');
UPDATE posts SET content = content || ' (édité)' WHERE id = 1;

-- Lire les changements décodés
SELECT lsn, xid, data
FROM pg_logical_slot_get_changes('debug_slot', NULL, NULL);
--  lsn         | xid  | data
-- -------------+------+----------------------------------------------------------------------
--  0/1A2B3C40  | 1234 | BEGIN 1234
--  0/1A2B3C80  | 1234 | table public.reactions: INSERT: id[integer]:501 post_id[integer]:1 ...
--  0/1A2B3CC0  | 1234 | COMMIT 1234
--  0/1A2B3D00  | 1235 | BEGIN 1235
--  0/1A2B3D40  | 1235 | table public.posts: UPDATE: id[integer]:1 content[text]:'Post...'
--  0/1A2B3D80  | 1235 | COMMIT 1235

-- Nettoyage : supprimer le slot (sinon il retient les WAL indéfiniment)
SELECT pg_drop_replication_slot('debug_slot');
```

Le décodage logique transforme les WAL bruts (octets) en opérations SQL lisibles. Le plugin `test_decoding` est inclus dans PostgreSQL — `pgoutput` (utilisé par les subscriptions) et `wal2json` (format JSON pour les pipelines CDC) sont d'autres options. **Toujours supprimer un slot de décodage inutilisé** pour éviter l'accumulation de WAL sur le disque.

---

## Étape 6 — Simuler un failover (pg_promote)

Cette étape utilise une instance unique et simule la promotion d'un standby en examinant les fonctions de contrôle. Sur une vraie instance standby, on appellerait `pg_promote()`.

**TODO** : vérifie que notre instance n'est **pas** en recovery (elle joue le rôle du primaire), consulte les statistiques WAL, puis documente ce que ferait un failover réel.

```sql
\c tribuzen_pub

-- TODO : vérifier l'état de l'instance
SELECT pg_is_in_recovery();   -- false = primaire, true = standby

-- TODO : inspecter les statistiques WAL
SELECT * FROM pg_stat_wal;

-- TODO : inspecter la timeline actuelle
SELECT timeline_id, reason FROM pg_control_checkpoint();
```

**Corrigé** :

```sql
\c tribuzen_pub

-- Notre instance est le primaire
SELECT pg_is_in_recovery();
--  pg_is_in_recovery
-- -------------------
--  f   ← false = primaire

-- Statistiques WAL globales
SELECT
    wal_records,
    wal_bytes,
    wal_buffers_full,
    wal_write,
    wal_sync
FROM pg_stat_wal;

-- Vérifier la timeline
SELECT timeline_id FROM pg_control_checkpoint();
--  timeline_id
-- -------------
--  1   ← timeline initiale, incrémentée à chaque failover

-- Sur un VRAI RÉPLICA, le failover se fait ainsi :
-- SELECT pg_promote(wait := true, wait_seconds := 60);
-- → pg_is_in_recovery() passe de true à false
-- → timeline_id est incrémenté (1 → 2)
-- → le réplica accepte les écritures

-- Resynchroniser l'ancien primaire ensuite :
-- pg_rewind --target-pgdata=/data --source-server='host=new-primary ...'
-- touch /data/standby.signal
-- pg_ctl start
```

`pg_stat_wal` (PG14+) expose les statistiques cumulées d'écriture WAL depuis le démarrage de l'instance — utile pour calibrer `wal_keep_size` et évaluer le volume de WAL généré par les insertions massives.

---

## Variante J+30

Reprends sans relire le corrigé, en 30 min, avec ces contraintes supplémentaires :

- Ajoute une **troisième table** `comments` à la publication `pub_feed` **après** que la subscription est créée. Identifie le problème (DDL non répliqué) et documente les deux étapes de migration : (1) `ALTER PUBLICATION pub_feed ADD TABLE comments` sur le publisher, (2) créer `comments` sur le subscriber, (3) `ALTER SUBSCRIPTION sub_feed REFRESH PUBLICATION`.
- Configure `synchronous_commit = 'remote_apply'` **seulement pour les transactions critiques** (mutations de `posts`) et `synchronous_commit = 'local'` pour les lectures + logs. Explique à voix haute pourquoi `remote_apply` garantit la cohérence lecture-après-écriture sur le subscriber.
- Utilise `pg_logical_slot_peek_changes` au lieu de `pg_logical_slot_get_changes` et explique la différence (peek vs consume) — quand utilise-t-on chacun ?
- Observe `pg_stat_subscription_stats` (PG15+) et identifie les métriques `apply_error_count` et `sync_error_count` — dans quel cas ces compteurs s'incrémentent-ils ?

---

## Application TribuZen

Porte ce lab dans le vrai repo `smaurier/tribuzen` :

1. Mets à jour `docker-compose.yml` pour ajouter un second service `db-replica` basé sur `postgres:17` avec `wal_level = logical` sur le service `db-primary`.
2. Dans un script `scripts/setup-replication.sh`, automatise les étapes : `pg_basebackup` (ou `CREATE PUBLICATION` + `CREATE SUBSCRIPTION` en logique), vérification via `pg_stat_replication`.
3. Dans `src/db/pools.ts`, expose deux pools `primary` et `replica` et utilise `replica` dans `getFeed()` (module 05 du fil-rouge).
4. Ajoute un healthcheck dans le compose qui vérifie `pg_is_in_recovery()` pour s'assurer que le réplica est en lecture seule avant que l'app démarre.
5. Commit `smaurier/tribuzen` : `feat(db): réplica en lecture pour le feed TribuZen (streaming replication + pool routing)`.

---

## Navigation

| | Lien |
|---|---|
| Module associé | [Module 16 — Réplication](../../modules/16-replication.md) |
| Module suivant | [Module 17 — Monitoring et observabilité](../../modules/17-monitoring-et-observabilite.md) |
