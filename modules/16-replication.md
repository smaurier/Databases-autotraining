# Module 16 — Replication

> **Objectif** : Comprendre et mettre en oeuvre la replication PostgreSQL — streaming replication, replication logique, failover, PITR — pour garantir la disponibilite et la durabilite de vos donnees.
>
> **Difficulte** : ⭐⭐⭐⭐

---

## 1. Pourquoi la replication

Imaginez que vous possedez un unique exemplaire d'un manuscrit ancien de valeur inestimable. Si un incendie ravage la bibliotheque, tout est perdu. La solution evidente : faire des **photocopies de securite** et les stocker dans d'autres batiments.

> **Analogie** : La replication PostgreSQL, c'est exactement ce systeme de photocopies. Votre base de donnees principale (le manuscrit original) est copiee en permanence vers un ou plusieurs serveurs secondaires (les photocopies). Si l'original est detruit, une copie prend le relais en quelques secondes.

Mais les photocopies servent aussi a autre chose : si 200 etudiants veulent lire le manuscrit en meme temps, on peut leur distribuer des copies au lieu de faire la queue devant l'original.

### Les trois raisons de repliquer

```
┌──────────────────────────────────────────────────────────────┐
│           POURQUOI REPLIQUER ?                                │
│                                                               │
│  1. HAUTE DISPONIBILITE (HA)                                 │
│     Si le primary tombe, un standby prend le relais          │
│     → Objectif : temps d'arret < 30 secondes                 │
│                                                               │
│  2. REPARTITION DE CHARGE (Read Scaling)                     │
│     Les lectures sont distribuees sur les replicas           │
│     → Le primary ne gere que les ecritures                   │
│                                                               │
│  3. PROTECTION DES DONNEES (Disaster Recovery)               │
│     Copie des donnees dans un autre datacenter               │
│     → Survit a une panne totale du site principal            │
└──────────────────────────────────────────────────────────────┘
```

| Besoin | Solution | Temps de recovery |
|--------|----------|-------------------|
| Protection contre les pannes disque | RAID + replicas | Quelques secondes |
| Protection contre les pannes serveur | Streaming replication + failover | 10-30 secondes |
| Protection contre les erreurs humaines | PITR (Point-in-Time Recovery) | Quelques minutes |
| Protection contre la perte d'un datacenter | Replication cross-datacenter | Quelques secondes a minutes |
| Migration zero-downtime | Replication logique | Pas de downtime |

---

## 2. Replication physique (streaming replication)

### 2.1 Principe : copie bit-a-bit des WAL

La replication physique (ou streaming replication) copie les **WAL (Write-Ahead Log)** du serveur primary vers un ou plusieurs serveurs standby. Les WAL contiennent l'enregistrement de chaque modification physique des fichiers de donnees.

> **Analogie** : Imaginez un comptable qui note chaque operation dans un journal. Au lieu de refaire tous les calculs, son assistant photocopy chaque page du journal au fur et a mesure et la rejoue sur sa propre copie des livres de comptes. C'est exactement ce que fait le standby : il recoit les WAL et les "rejoue" pour maintenir une copie identique.

```
Streaming Replication — flux de donnees :

  PRIMARY                                    STANDBY
  ┌────────────────┐                        ┌────────────────┐
  │  Application    │                        │                │
  │  ┌──────────┐  │    WAL stream          │  ┌──────────┐  │
  │  │ INSERT   │──┼──►  (segments WAL) ──► │  │ WAL      │  │
  │  │ UPDATE   │  │    port 5432           │  │ Receiver │  │
  │  │ DELETE   │  │                        │  │          │  │
  │  └──────────┘  │                        │  └────┬─────┘  │
  │       │        │                        │       │        │
  │  ┌────▼─────┐  │                        │  ┌────▼─────┐  │
  │  │ WAL      │  │                        │  │ Recovery │  │
  │  │ Writer   │  │                        │  │ Process  │  │
  │  └────┬─────┘  │                        │  └────┬─────┘  │
  │       │        │                        │       │        │
  │  ┌────▼─────┐  │                        │  ┌────▼─────┐  │
  │  │ Data     │  │     identique          │  │ Data     │  │
  │  │ Files    │  │  ◄─────────────────►   │  │ Files    │  │
  │  └──────────┘  │                        │  └──────────┘  │
  └────────────────┘                        └────────────────┘
```

Caracteristiques cles :
- Copie **bit-a-bit** : le standby est une copie physique exacte du primary
- Le standby ne peut pas avoir un schema different
- Les **deux serveurs doivent avoir la meme version majeure** de PostgreSQL
- Le standby est en **lecture seule** (si `hot_standby = on`)

### 2.2 Architecture primary → standby

```
Architecture typique :

                      ┌─────────────┐
                      │   Clients   │
                      │  (Ecritures │
                      │  + Lectures)│
                      └──────┬──────┘
                             │
                      ┌──────▼──────┐
                      │   PRIMARY   │
                      │ (read/write)│
                      │  port 5432  │
                      └──┬───────┬──┘
                   WAL   │       │  WAL
                 stream  │       │  stream
                ┌────────▼──┐ ┌──▼────────┐
                │ STANDBY 1 │ │ STANDBY 2 │
                │ (read-only│ │ (read-only│
                │  sync)    │ │  async)   │
                │ port 5433 │ │ port 5434 │
                └───────────┘ └───────────┘
```

### 2.3 Configuration du primary

```
# postgresql.conf du PRIMARY

# Niveau de WAL : 'replica' pour la streaming replication
wal_level = replica

# Nombre maximum de connexions de replication simultanees
max_wal_senders = 5

# Conserver les WAL meme si le standby est en retard
wal_keep_size = 1GB          # PG13+ (remplace wal_keep_segments)

# Activer l'archivage des WAL (pour PITR)
archive_mode = on
archive_command = 'cp %p /var/lib/pgsql/wal_archive/%f'

# Nombre maximum de replication slots
max_replication_slots = 5
```

```sql
-- Creer un role dedie a la replication
CREATE ROLE replicator WITH
    REPLICATION
    LOGIN
    PASSWORD 'mot_de_passe_tres_secret';
```

```
# pg_hba.conf du PRIMARY — autoriser la connexion de replication
# TYPE    DATABASE       USER         ADDRESS          METHOD
hostssl   replication    replicator   10.0.1.0/24      scram-sha-256
```

### 2.4 Configuration du standby

```bash
# Etape 1 : Faire un backup de base du primary
pg_basebackup -h primary.example.com -U replicator \
    -D /var/lib/pgsql/16/data \
    -Fp -Xs -P -R
#     │   │   │  └── Cree automatiquement standby.signal
#     │   │   └── Affiche la progression
#     │   └── Stream les WAL pendant le backup
#     └── Format plain (pas tar)
```

L'option `-R` de `pg_basebackup` genere automatiquement les fichiers necessaires :

```
# postgresql.auto.conf (genere par pg_basebackup -R)
primary_conninfo = 'host=primary.example.com port=5432 user=replicator password=mot_de_passe_tres_secret'
```

```
# Le fichier standby.signal est cree (fichier vide)
# Sa presence indique a PostgreSQL de demarrer en mode standby
```

```
# postgresql.conf du STANDBY
hot_standby = on       # Autorise les lectures sur le standby
```

```bash
# Etape 2 : Demarrer le standby
pg_ctl -D /var/lib/pgsql/16/data start
```

```sql
-- Verifier que la replication fonctionne (sur le PRIMARY)
SELECT
    client_addr,
    state,
    sent_lsn,
    write_lsn,
    flush_lsn,
    replay_lsn,
    sync_state
FROM pg_stat_replication;

-- Resultat :
--  client_addr  |  state    | sent_lsn    | write_lsn   | flush_lsn   | replay_lsn  | sync_state
-- ─────────────+───────────+─────────────+─────────────+─────────────+─────────────+────────────
--  10.0.1.5     | streaming | 0/5000060   | 0/5000060   | 0/5000060   | 0/5000060   | async
```

### 2.5 Synchronous vs asynchronous replication

C'est LA decision architecturale la plus importante en replication.

```
Replication ASYNCHRONE (defaut) :

  Client           PRIMARY              STANDBY
    │                 │                     │
    │── INSERT ──►    │                     │
    │                 │── WAL record ──►    │
    │◄── OK ──────    │   (en arriere-plan) │
    │                 │                     │
    Le client recoit  │     Le standby peut │
    le "OK" AVANT     │     etre en retard  │
    que le standby    │     (lag)           │
    ait recu la       │                     │
    donnee            │                     │


Replication SYNCHRONE :

  Client           PRIMARY              STANDBY
    │                 │                     │
    │── INSERT ──►    │                     │
    │                 │── WAL record ──►    │
    │                 │                     │── applique
    │                 │◄── ACK ──────────   │
    │◄── OK ──────    │                     │
    │                 │                     │
    Le client recoit  │     Le standby a    │
    le "OK" APRES     │     confirme la     │
    confirmation du   │     reception       │
    standby           │                     │
```

| Aspect | Asynchrone | Synchrone |
|--------|------------|-----------|
| Latence d'ecriture | Normale | Plus elevee (aller-retour reseau) |
| Perte de donnees possible | Oui (dernieres transactions) | **Non** (zero data loss) |
| Impact si standby tombe | Aucun | **Bloque les ecritures !** |
| Cas d'usage | General, performance | Finance, donnees critiques |

### 2.6 synchronous_commit options

PostgreSQL offre un controle fin du comportement synchrone :

```
# postgresql.conf du PRIMARY
synchronous_standby_names = 'standby1'   # Nom du standby synchrone
```

```sql
-- Le parametre synchronous_commit controle "quand" le client recoit le OK
-- Il peut etre configure globalement OU par transaction
```

| Valeur | Comportement | Perte possible | Latence |
|--------|-------------|----------------|---------|
| `on` | Attend flush local + **flush standby** | Aucune | Haute |
| `remote_apply` | Attend que le standby ait **applique** le WAL | Aucune, lectures coherentes | Tres haute |
| `remote_write` | Attend que le standby ait **ecrit** (pas flush) | Crash standby = perte | Moyenne |
| `local` | Flush local uniquement | Crash primary = perte | Normale |
| `off` | Pas de flush du tout | Crash primary = perte | Tres basse |

```sql
-- Par transaction : desactiver la synchronisation pour un batch non critique
BEGIN;
SET LOCAL synchronous_commit = 'local';
INSERT INTO logs_analytics (event, ts) VALUES ('page_view', now());
COMMIT;
-- Cette transaction ne bloquera pas en attendant le standby

-- Transaction critique : attendre l'application sur le standby
BEGIN;
SET LOCAL synchronous_commit = 'remote_apply';
UPDATE comptes SET solde = solde - 1000 WHERE id = 42;
COMMIT;
-- Garantie : le standby a applique la modification
```

> **Piege classique** : Si `synchronous_standby_names` est configure et que le standby tombe, les ecritures sur le primary sont **bloquees** en attente du standby. C'est le cauchemar du synchrone. Solution : utiliser `synchronous_standby_names = 'FIRST 1 (standby1, standby2)'` pour basculer automatiquement sur un autre standby.

### 2.7 Failover et pg_promote()

Quand le primary tombe, un standby doit prendre le relais.

```
Failover — chronologie :

  t=0s     t=5s         t=10s          t=15s         t=20s
    │        │             │              │             │
    ▼        ▼             ▼              ▼             ▼
  Primary   Detection    Promotion     Clients       Service
  tombe     de la       du standby    redirigés     restaure
            panne       en primary    vers le
                                      nouveau
                                      primary
```

```sql
-- Methode 1 : pg_promote() (PostgreSQL 12+)
-- Executer sur le STANDBY que l'on veut promouvoir
SELECT pg_promote(wait := true, wait_seconds := 60);
-- wait=true : attend que la promotion soit complete
-- Le standby devient un primary (read-write)
```

```bash
# Methode 2 : pg_ctl promote
pg_ctl -D /var/lib/pgsql/16/data promote

# Methode 3 : fichier trigger (ancienne methode, deconseille)
# promote_trigger_file dans recovery.conf (avant PG12)
```

Apres la promotion :

```sql
-- Verifier que le nouveau primary accepte les ecritures
SELECT pg_is_in_recovery();
-- false = c'est un primary
-- true  = c'est encore un standby

-- Verifier le timeline
SELECT timeline_id FROM pg_control_checkpoint();
-- Le timeline a ete incremente (ex: 1 → 2)
```

> **Piege classique** : Apres un failover, l'ancien primary ne peut pas simplement etre rebranché comme standby. Il est sur un ancien timeline. Il faut soit le reconstruire avec `pg_basebackup`, soit utiliser `pg_rewind` (plus rapide) :

```bash
# pg_rewind : resynchroniser l'ancien primary pour en faire un standby
pg_rewind --target-pgdata=/var/lib/pgsql/16/data \
          --source-server='host=new-primary.example.com port=5432 user=replicator'
```

### 2.8 Replication slots : pourquoi et configuration

Sans replication slot, le primary peut recycler des WAL **avant** que le standby les ait recus, ce qui casse la replication.

> **Analogie** : Imaginez un journal quotidien. Sans abonnement (slot), le vendeur jette les vieux numeros. Si vous etes en vacances une semaine, vous avez manque 7 numeros et ne pouvez plus suivre. Avec un abonnement (slot), le vendeur garde vos numeros jusqu'a ce que vous les recuperiez.

```sql
-- Creer un replication slot (sur le PRIMARY)
SELECT pg_create_physical_replication_slot('standby1_slot');

-- Le standby doit referencier ce slot
-- postgresql.auto.conf du STANDBY :
-- primary_slot_name = 'standby1_slot'
```

```sql
-- Surveiller les replication slots
SELECT
    slot_name,
    slot_type,
    active,
    restart_lsn,
    pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS lag_bytes
FROM pg_replication_slots;

-- Resultat :
--  slot_name      | slot_type | active | restart_lsn | lag_bytes
-- ────────────────+───────────+────────+─────────────+──────────
--  standby1_slot  | physical  | t      | 0/5000060   |      256
```

> **Piege classique** : Un replication slot inactif **accumule les WAL indefiniment** sur le primary, ce qui peut remplir le disque et crasher le serveur. Toujours monitorer les slots inactifs et les supprimer si le standby est definitivement perdu :

```sql
-- Supprimer un slot qui n'est plus utilise
SELECT pg_drop_replication_slot('standby1_slot');
```

---

## 3. Replication logique

### 3.1 Principe : replication au niveau SQL

Contrairement a la replication physique qui copie des blocs bruts, la replication logique decode les WAL en **operations SQL logiques** (INSERT, UPDATE, DELETE) et les envoie au subscriber.

```
Replication physique vs logique :

  PHYSIQUE :  WAL brut (octets)    ──►  Replay identique bit-a-bit
              "Ecrire 48 octets        (meme structure de fichiers,
               a l'offset 0x3F00       meme version, meme OS)
               du fichier 16384"

  LOGIQUE :   Operations SQL       ──►  Application selective
              "INSERT INTO users        (schema different possible,
               (id, nom) VALUES         version differente,
               (42, 'Alice')"          tables specifiques)
```

> **Analogie** : La replication physique, c'est photocopier un livre page par page (copie exacte). La replication logique, c'est dicter le contenu du livre a quelqu'un qui l'ecrit dans son propre cahier — il peut choisir de ne noter que certains chapitres, et son cahier peut avoir un format different.

### 3.2 Publication / Subscription model

```
Architecture Publication / Subscription :

  PUBLISHER (source)              SUBSCRIBER (destination)
  ┌─────────────────┐            ┌─────────────────┐
  │                 │            │                 │
  │  Table: orders  │            │  Table: orders  │
  │  Table: users   │  ────►    │  (copie)        │
  │                 │            │                 │
  │  PUBLICATION    │            │  SUBSCRIPTION   │
  │  "pub_orders"   │            │  "sub_orders"   │
  │  (orders only)  │            │                 │
  └─────────────────┘            └─────────────────┘

  Le publisher "publie" les changements de certaines tables.
  Le subscriber "s'abonne" et recoit ces changements.
```

### 3.3 CREATE PUBLICATION, CREATE SUBSCRIPTION

```sql
-- ============================================================
-- SUR LE PUBLISHER (serveur source)
-- ============================================================

-- Prerequis : wal_level = logical
-- ALTER SYSTEM SET wal_level = 'logical';
-- (necessite un redemarrage)

-- Publier des tables specifiques
CREATE PUBLICATION pub_orders
    FOR TABLE orders, order_items;

-- Publier toutes les tables
CREATE PUBLICATION pub_all
    FOR ALL TABLES;

-- Publier avec filtrage (PostgreSQL 15+)
CREATE PUBLICATION pub_orders_france
    FOR TABLE orders WHERE (country = 'FR');

-- Publier seulement certaines operations
CREATE PUBLICATION pub_inserts_only
    FOR TABLE logs
    WITH (publish = 'insert');  -- pas de UPDATE ni DELETE
```

```sql
-- ============================================================
-- SUR LE SUBSCRIBER (serveur destination)
-- ============================================================

-- La table doit exister AVANT de s'abonner
CREATE TABLE orders (
    id          INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    total       NUMERIC(10,2),
    country     TEXT,
    created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE order_items (
    id       INTEGER PRIMARY KEY,
    order_id INTEGER NOT NULL,
    product  TEXT,
    quantity INTEGER
);

-- Creer la subscription
CREATE SUBSCRIPTION sub_orders
    CONNECTION 'host=publisher.example.com port=5432 dbname=mydb user=replicator password=secret'
    PUBLICATION pub_orders;

-- PostgreSQL va :
-- 1. Se connecter au publisher
-- 2. Copier les donnees initiales (snapshot)
-- 3. Commencer a recevoir les changements en continu
```

```sql
-- Verifier l'etat de la subscription
SELECT
    subname,
    subenabled,
    subconninfo,
    subpublications
FROM pg_subscription;

-- Verifier la progression de la copie initiale
SELECT * FROM pg_stat_subscription;
```

### 3.4 Cas d'usage de la replication logique

| Cas d'usage | Description | Avantage |
|-------------|-------------|----------|
| Migration zero-downtime | Repliquer vers le nouveau serveur, basculer le trafic | Pas d'arret de service |
| Replication partielle | Ne repliquer que certaines tables | Economie de ressources |
| Cross-version | Repliquer de PG14 vers PG16 | Migration de version majeure |
| Consolidation | Plusieurs bases → une base centrale (reporting) | Dashboard unifie |
| CDC (Change Data Capture) | Capturer les changements pour un systeme externe | Integration Kafka, etc. |

```sql
-- Exemple : migration zero-downtime de PG14 vers PG16

-- 1. Sur PG14 (ancien) : creer la publication
CREATE PUBLICATION migration_pub FOR ALL TABLES;

-- 2. Sur PG16 (nouveau) : recreer le schema
-- pg_dump --schema-only | psql sur PG16

-- 3. Sur PG16 : s'abonner
CREATE SUBSCRIPTION migration_sub
    CONNECTION 'host=old-server port=5432 ...'
    PUBLICATION migration_pub;

-- 4. Attendre que le subscriber soit a jour (lag = 0)

-- 5. Arreter les ecritures sur l'ancien serveur
-- 6. Verifier une derniere fois que le lag = 0
-- 7. Basculer l'application vers le nouveau serveur
-- 8. Supprimer la subscription

DROP SUBSCRIPTION migration_sub;
```

### 3.5 Logical decoding et output plugins

Le logical decoding est le mecanisme interne qui transforme les WAL en operations logiques.

```sql
-- Creer un slot de decodage logique
SELECT pg_create_logical_replication_slot('my_slot', 'pgoutput');

-- Plugins disponibles :
-- pgoutput : plugin natif PostgreSQL (utilise par les subscriptions)
-- wal2json : sortie en format JSON (populaire pour le CDC)
-- test_decoding : plugin de test/debug
```

```sql
-- Exemple avec test_decoding (debug)
SELECT pg_create_logical_replication_slot('test_slot', 'test_decoding');

-- Inserer des donnees
INSERT INTO orders (id, customer_id, total, country)
VALUES (100, 1, 99.99, 'FR');

-- Lire les changements
SELECT * FROM pg_logical_slot_get_changes('test_slot', NULL, NULL);

-- Resultat :
--  lsn      | xid  | data
-- ──────────+──────+──────────────────────────────────────────────────
--  0/170B8A0| 1234 | BEGIN 1234
--  0/170B8A0| 1234 | table public.orders: INSERT: id[integer]:100
--           |      |   customer_id[integer]:1 total[numeric]:99.99
--           |      |   country[text]:'FR'
--  0/170B940| 1234 | COMMIT 1234
```

```bash
# wal2json — installation et utilisation
# Installer l'extension wal2json
# apt-get install postgresql-16-wal2json

# Utiliser avec pg_recvlogical
pg_recvlogical -d mydb --slot=wal2json_slot \
    --create-slot --plugin=wal2json --start -f -

# Sortie JSON :
# {"change":[{"kind":"insert","schema":"public","table":"orders",
#   "columnnames":["id","customer_id","total","country"],
#   "columnvalues":[100,1,99.99,"FR"]}]}
```

### 3.6 Limitations de la replication logique

```
┌──────────────────────────────────────────────────────────────┐
│         LIMITATIONS DE LA REPLICATION LOGIQUE                 │
│                                                               │
│  1. PAS de replication DDL                                   │
│     CREATE TABLE, ALTER TABLE, DROP → doivent etre           │
│     executes manuellement sur le subscriber                  │
│                                                               │
│  2. PAS de replication des sequences                         │
│     Les nextval() ne sont pas repliques                      │
│     → Risque de conflit si le subscriber insere aussi        │
│                                                               │
│  3. PAS de TRUNCATE (avant PostgreSQL 11)                    │
│     A partir de PG11 : TRUNCATE est replique                │
│                                                               │
│  4. Les tables doivent avoir un REPLICA IDENTITY             │
│     (PRIMARY KEY ou UNIQUE) pour UPDATE/DELETE               │
│                                                               │
│  5. PAS de replication des Large Objects                     │
│                                                               │
│  6. Les conflits ne sont PAS geres automatiquement           │
│     Si le subscriber a une ligne en conflit → erreur         │
└──────────────────────────────────────────────────────────────┘
```

```sql
-- REPLICA IDENTITY : necessaire pour UPDATE/DELETE en replication logique
-- Par defaut, c'est la PRIMARY KEY

-- Si la table n'a pas de PK, il faut specifier une identity :
ALTER TABLE orders REPLICA IDENTITY USING INDEX orders_unique_idx;

-- Ou utiliser FULL (compare toutes les colonnes — peu performant)
ALTER TABLE orders REPLICA IDENTITY FULL;
```

---

## 4. pg_stat_replication : monitoring du lag

### 4.1 Anatomie de pg_stat_replication

```sql
-- Requete de monitoring complete (sur le PRIMARY)
SELECT
    pid,
    usename,
    client_addr,
    client_hostname,
    state,
    sync_state,
    sent_lsn,
    write_lsn,
    flush_lsn,
    replay_lsn,
    -- Lag en octets entre chaque etape
    pg_wal_lsn_diff(sent_lsn, write_lsn) AS write_lag_bytes,
    pg_wal_lsn_diff(sent_lsn, flush_lsn) AS flush_lag_bytes,
    pg_wal_lsn_diff(sent_lsn, replay_lsn) AS replay_lag_bytes,
    -- Lag en temps (PG10+)
    write_lag,
    flush_lag,
    replay_lag
FROM pg_stat_replication;
```

### 4.2 Comprendre les LSN (Log Sequence Number)

```
Flux du WAL et points de mesure :

  PRIMARY                                          STANDBY
  ┌─────────┐    envoi    ┌─────────┐   ecriture   ┌─────────┐
  │ current │───────────►│  sent   │────────────► │  write  │
  │ WAL LSN │   reseau   │  _lsn   │   memoire   │  _lsn   │
  └─────────┘            └─────────┘              └────┬────┘
                                                       │ flush
                                                  ┌────▼────┐
                                                  │  flush  │
                                                  │  _lsn   │
                                                  └────┬────┘
                                                       │ replay
                                                  ┌────▼────┐
                                                  │ replay  │
                                                  │  _lsn   │
                                                  └─────────┘

  sent_lsn    = derniere position envoyee au standby
  write_lsn   = derniere position ecrite en memoire par le standby
  flush_lsn   = derniere position ecrite sur disque par le standby
  replay_lsn  = derniere position appliquee par le standby
```

| Metrique | Signification | Alerte si |
|----------|---------------|-----------|
| `sent_lsn - write_lsn` | Lag reseau | > 1MB |
| `write_lsn - flush_lsn` | Lag d'ecriture disque | > 0 longtemps |
| `flush_lsn - replay_lsn` | Lag d'application | > 10MB |
| `replay_lag` | Retard temporel total | > 1 seconde |

### 4.3 Calcul du lag en bytes et en temps

```sql
-- Lag total en octets (sur le PRIMARY)
SELECT
    client_addr,
    pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS total_lag_bytes,
    pg_size_pretty(
        pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)
    ) AS total_lag_pretty
FROM pg_stat_replication;

-- Lag vu depuis le STANDBY
SELECT
    CASE
        WHEN pg_is_in_recovery() THEN
            pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn())
        ELSE 0
    END AS receive_replay_lag_bytes,
    CASE
        WHEN pg_is_in_recovery() AND pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()
        THEN 0
        ELSE EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())
    END AS lag_seconds;
```

> **Piege classique** : La fonction `pg_last_xact_replay_timestamp()` retourne le timestamp de la **derniere transaction repliquee**, pas le "lag reel". Si le primary n'ecrit rien, ce timestamp ne bouge pas, et le lag semble augmenter alors qu'il est en realite de 0. Utilisez plutot `replay_lag` de `pg_stat_replication` (PG10+).

---

## 5. Read replicas

### 5.1 hot_standby = on

```
# postgresql.conf du STANDBY
hot_standby = on   # Autorise les requetes SELECT en lecture

# Parametres utiles pour les read replicas :
hot_standby_feedback = on   # Informe le primary des requetes en cours
                            # (evite que VACUUM supprime des tuples
                            #  encore necessaires au standby)
max_standby_streaming_delay = 30s   # Temps d'attente max avant d'annuler
                                    # une requete en conflit sur le standby
```

### 5.2 Routing des lectures vers les replicas

```
Architecture avec read replicas :

  ┌────────────┐
  │ Application│
  └─────┬──────┘
        │
  ┌─────▼──────┐     SELECT        ┌────────────┐
  │  Routeur   │────────────────► │  Replica 1  │
  │  (HAProxy, │     SELECT        ├────────────┤
  │   pgpool,  │────────────────► │  Replica 2  │
  │   app)     │                   ├────────────┤
  │            │     INSERT/       │  Replica 3  │
  │            │     UPDATE/       └────────────┘
  │            │     DELETE
  │            │────────────────► ┌────────────┐
  └────────────┘                  │  Primary   │
                                  └────────────┘
```

**Option 1 : Routing au niveau applicatif**

```javascript
// Node.js — deux pools de connexion
const { Pool } = require('pg');

// Pool pour les ecritures (primary)
const primaryPool = new Pool({
    host: 'primary.example.com',
    port: 5432,
    database: 'mydb',
    user: 'app',
    password: 'secret',
    max: 20,
});

// Pool pour les lectures (replicas en round-robin)
const replicaHosts = [
    'replica1.example.com',
    'replica2.example.com',
    'replica3.example.com',
];
let currentReplica = 0;

function getReplicaPool() {
    const host = replicaHosts[currentReplica % replicaHosts.length];
    currentReplica++;
    return new Pool({
        host,
        port: 5432,
        database: 'mydb',
        user: 'app_readonly',
        password: 'secret',
        max: 10,
    });
}

// Pools pre-crees pour les replicas
const replicaPools = replicaHosts.map(host => new Pool({
    host,
    port: 5432,
    database: 'mydb',
    user: 'app_readonly',
    password: 'secret',
    max: 10,
}));

// Fonction utilitaire
async function query(sql, params, { readonly = false } = {}) {
    if (readonly) {
        // Round-robin sur les replicas
        const pool = replicaPools[currentReplica % replicaPools.length];
        currentReplica++;
        return pool.query(sql, params);
    }
    return primaryPool.query(sql, params);
}

// Utilisation
const users = await query(
    'SELECT * FROM users WHERE active = true',
    [],
    { readonly: true }  // → envoye vers un replica
);

await query(
    'UPDATE users SET last_login = now() WHERE id = $1',
    [userId]
    // → envoye vers le primary (defaut)
);
```

**Option 2 : HAProxy**

```
# haproxy.cfg
listen postgres_write
    bind *:5432
    mode tcp
    option pgsql-check user haproxy
    default-server inter 3s fall 3
    server primary 10.0.1.1:5432 check

listen postgres_read
    bind *:5433
    mode tcp
    balance roundrobin
    option pgsql-check user haproxy
    default-server inter 3s fall 3
    server replica1 10.0.1.2:5432 check
    server replica2 10.0.1.3:5432 check
    server replica3 10.0.1.4:5432 check
```

### 5.3 Probleme de replication lag et consistency

```
Le probleme du "read-your-own-write" :

  1. Client ecrit sur le primary    : INSERT INTO orders (...)
  2. Client lit sur un replica      : SELECT * FROM orders WHERE id = 42
  3. Le replica est en retard       : → ordre introuvable !

  Timeline :
  Primary:   ──[INSERT]────────────────────────────────
  Replica:   ──────────────────────[INSERT]─────────────
                    ▲                  ▲
                    │                  │
              Le client lit ici   La donnee arrive ici
              → pas encore la !
```

Solutions :

```javascript
// Solution 1 : Lire sur le primary apres une ecriture
async function createOrder(data) {
    // Ecriture sur le primary
    const { rows } = await primaryPool.query(
        'INSERT INTO orders (...) VALUES (...) RETURNING *',
        [...]
    );
    // Lire le resultat directement du RETURNING (pas besoin d'un 2e query)
    return rows[0];
}

// Solution 2 : "Sticky reads" — lire sur le primary pendant N secondes
const STICKY_DURATION_MS = 5000; // 5 secondes
const userLastWrite = new Map(); // userId → timestamp

async function queryWithSticky(sql, params, userId, readonly = false) {
    const lastWrite = userLastWrite.get(userId) || 0;
    const isSticky = Date.now() - lastWrite < STICKY_DURATION_MS;

    if (readonly && !isSticky) {
        return replicaPool.query(sql, params);
    }
    return primaryPool.query(sql, params);
}

// Solution 3 : synchronous_commit = remote_apply (garantie la plus forte)
// Le primary attend que le replica ait applique les modifications
```

---

## 6. Point-in-Time Recovery (PITR)

### 6.1 Principe

Le PITR permet de restaurer la base a **n'importe quel instant** dans le passe. C'est l'outil indispensable contre les erreurs humaines.

> **Analogie** : Imaginez une camera de surveillance dans votre bureau. Meme si quelqu'un a fait tomber du cafe sur un document a 14h37, vous pouvez rembobiner la bande video et voir l'etat du bureau a 14h36, juste avant l'accident. Le PITR est cette camera pour votre base de donnees.

```
Composants du PITR :

  1. pg_basebackup     = la PHOTO initiale (backup complet)
  2. WAL archiving     = le FILM continu (chaque modification)
  3. Recovery          = REMBOBINAGE jusqu'a un point precis

  ┌──────────┐    ┌─────┬─────┬─────┬─────┬─────┐
  │ Backup   │ +  │ WAL │ WAL │ WAL │ WAL │ WAL │
  │ de base  │    │  1  │  2  │  3  │  4  │  5  │
  │ (t=0)    │    │     │     │     │     │     │
  └──────────┘    └─────┴─────┴──┬──┴─────┴─────┘
                                 │
                           Recovery ici
                           (t=3.5)
```

### 6.2 WAL archiving

```
# postgresql.conf — activer l'archivage
archive_mode = on
archive_command = 'test ! -f /var/lib/pgsql/wal_archive/%f && cp %p /var/lib/pgsql/wal_archive/%f'
# %p = chemin du fichier WAL source
# %f = nom du fichier WAL

# Ou archiver vers un stockage distant (S3, etc.)
# archive_command = 'aws s3 cp %p s3://my-bucket/wal-archive/%f'

# Limiter le temps avant l'archivage d'un segment incomplet
archive_timeout = 60   # Forcer l'archivage toutes les 60 secondes
                       # (meme si le segment WAL n'est pas plein)
```

### 6.3 pg_basebackup

```bash
# Creer un backup de base
pg_basebackup \
    -h primary.example.com \
    -U replicator \
    -D /var/lib/pgsql/backup/base_2024_06_15 \
    -Ft \        # Format tar (compressible)
    -z \         # Compression gzip
    -Xs \        # Stream les WAL pendant le backup
    -P           # Afficher la progression

# Exemple de sortie :
# 24576/24576 kB (100%), 1/1 tablespace
```

### 6.4 Recovery to a specific timestamp

```bash
# Etape 1 : Arreter PostgreSQL
pg_ctl -D /var/lib/pgsql/16/data stop

# Etape 2 : Deplacer les donnees corrompues
mv /var/lib/pgsql/16/data /var/lib/pgsql/16/data_old

# Etape 3 : Restaurer le backup de base
tar xzf /var/lib/pgsql/backup/base_2024_06_15/base.tar.gz \
    -C /var/lib/pgsql/16/data
```

```
# postgresql.conf — configurer la recovery
restore_command = 'cp /var/lib/pgsql/wal_archive/%f %p'

# Option 1 : Restaurer jusqu'a un timestamp precis
recovery_target_time = '2024-06-15 14:36:00+02'

# Option 2 : Restaurer jusqu'a un LSN precis
# recovery_target_lsn = '0/5000060'

# Option 3 : Restaurer jusqu'a une transaction specifique
# recovery_target_xid = '12345'

# Option 4 : Restaurer jusqu'a un named restore point
# recovery_target_name = 'before_migration'

# Que faire apres avoir atteint la cible ?
recovery_target_action = 'pause'   # pause, promote, shutdown
```

```bash
# Creer le fichier recovery.signal
touch /var/lib/pgsql/16/data/recovery.signal

# Demarrer PostgreSQL — la recovery commence automatiquement
pg_ctl -D /var/lib/pgsql/16/data start
```

```sql
-- Creer un named restore point AVANT une operation risquee
SELECT pg_create_restore_point('before_big_migration');
-- Maintenant on peut revenir a ce point si la migration echoue
```

> **Piege classique** : Oubliez `recovery.signal` et PostgreSQL demarre normalement sans faire la recovery ! Verifiez toujours que le fichier est present avant de demarrer.

---

## 7. Haute disponibilite

### 7.1 Patroni

Patroni est le standard de facto pour la haute disponibilite PostgreSQL. Il gere automatiquement le failover et la gestion du cluster.

```
Architecture Patroni :

  ┌───────────────────────────────────────────────┐
  │                 DCS (etcd / Consul / ZooKeeper)│
  │            Stocke l'etat du cluster            │
  └───────┬───────────────┬───────────────┬───────┘
          │               │               │
    ┌─────▼─────┐   ┌─────▼─────┐   ┌─────▼─────┐
    │ Patroni   │   │ Patroni   │   │ Patroni   │
    │ Agent     │   │ Agent     │   │ Agent     │
    │           │   │           │   │           │
    │ PostgreSQL│   │ PostgreSQL│   │ PostgreSQL│
    │ (Primary) │   │ (Standby) │   │ (Standby) │
    │ node-1    │   │ node-2    │   │ node-3    │
    └───────────┘   └───────────┘   └───────────┘

  Patroni :
  - Surveille la sante de chaque noeud
  - Gere le leader election via le DCS
  - Declenche le failover automatiquement
  - Reconstruit les standbys apres failover
```

```yaml
# patroni.yml — configuration minimale
scope: my-cluster
name: node1

restapi:
  listen: 0.0.0.0:8008
  connect_address: 10.0.1.1:8008

etcd:
  hosts: 10.0.2.1:2379,10.0.2.2:2379,10.0.2.3:2379

bootstrap:
  dcs:
    ttl: 30
    loop_wait: 10
    retry_timeout: 10
    maximum_lag_on_failover: 1048576  # 1MB max lag pour failover
    synchronous_mode: true
  postgresql:
    parameters:
      wal_level: replica
      max_wal_senders: 5
      max_replication_slots: 5
      hot_standby: "on"

postgresql:
  listen: 0.0.0.0:5432
  connect_address: 10.0.1.1:5432
  data_dir: /var/lib/pgsql/16/data
  authentication:
    replication:
      username: replicator
      password: secret
    superuser:
      username: postgres
      password: secret
```

### 7.2 repmgr (alternative)

```bash
# repmgr — enregistrer un primary
repmgr -f /etc/repmgr.conf primary register

# Cloner un standby depuis le primary
repmgr -h primary.example.com -U repmgr -d repmgr \
    -f /etc/repmgr.conf standby clone

# Promouvoir un standby en primary
repmgr -f /etc/repmgr.conf standby promote

# Rejoindre l'ancien primary comme standby
repmgr -f /etc/repmgr.conf node rejoin -d 'host=new-primary ...'
```

### 7.3 Split-brain prevention

Le split-brain est le scenario cauchemar : deux noeuds pensent etre le primary et acceptent des ecritures. Les donnees divergent de facon irreversible.

```
Split-brain :

  ┌───────────┐         ┌───────────┐
  │ Noeud A   │         │ Noeud B   │
  │ "Je suis  │         │ "Je suis  │
  │  primary" │         │  primary" │
  │           │         │           │
  │ INSERT x  │         │ INSERT y  │
  └───────────┘         └───────────┘
       │                      │
       ▼                      ▼
  Donnees A ≠ Donnees B   ← CATASTROPHE
```

Solutions :

```
┌──────────────────────────────────────────────────────────────┐
│            PREVENTION DU SPLIT-BRAIN                          │
│                                                               │
│  1. DCS (Distributed Consensus Store)                        │
│     Un seul leader a la fois, garanti par le consensus       │
│     → Patroni + etcd/Consul                                  │
│                                                               │
│  2. Fencing (STONITH — Shoot The Other Node In The Head)     │
│     Si un noeud ne repond plus, on le "tue" (power off)      │
│     pour etre SUR qu'il n'ecrit plus                         │
│                                                               │
│  3. Watchdog                                                 │
│     Si Patroni perd la connexion au DCS, il arrete           │
│     PostgreSQL plutot que de risquer un split-brain          │
│                                                               │
│  4. Synchronous replication                                  │
│     Le primary ne confirme pas les ecritures tant que        │
│     le standby n'a pas recu → donnees coherentes             │
└──────────────────────────────────────────────────────────────┘
```

---

## 8. Comparaison streaming vs logical replication

| Critere | Streaming (physique) | Logique |
|---------|---------------------|---------|
| Niveau de copie | Bit-a-bit (WAL brut) | Operations SQL |
| Version croisee | Non (meme version majeure) | **Oui** |
| Replication partielle | Non (toute la base) | **Oui** (tables specifiques) |
| Schema different | Non | **Oui** (colonnes supplementaires OK) |
| DDL replique | Oui (implicitement) | **Non** |
| Sequences repliquees | Oui | **Non** |
| Performance | Excellente | Bonne (decodage overhead) |
| Failover | Oui (standby promouvable) | Non (pas de promotion) |
| Read replica | Oui (hot_standby) | Le subscriber est read-write |
| Cas d'usage principal | HA + read scaling | Migration, CDC, partiel |
| Configuration | Moderee | Plus complexe |
| Conflits | Impossible (read-only) | Possibles (subscriber read-write) |

```
Arbre de decision :

  Votre besoin ?
       │
  ┌────┴────────────────┐
  │                     │
  Haute disponibilite   Migration ou
  + read scaling        replication selective
  │                     │
  │                     │
  ▼                     ▼
  Streaming             Logique
  replication           replication
```

---

## 9. Node.js : connection routing read/write

```javascript
// ============================================================
// Module de routage read/write complet pour Node.js
// ============================================================

const { Pool } = require('pg');

class DatabaseRouter {
    constructor(config) {
        // Pool primary (read-write)
        this.primary = new Pool({
            host: config.primaryHost,
            port: config.port || 5432,
            database: config.database,
            user: config.user,
            password: config.password,
            max: config.primaryMaxConnections || 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });

        // Pools replicas (read-only)
        this.replicas = config.replicaHosts.map(host => new Pool({
            host,
            port: config.port || 5432,
            database: config.database,
            user: config.readonlyUser || config.user,
            password: config.readonlyPassword || config.password,
            max: config.replicaMaxConnections || 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        }));

        this._replicaIndex = 0;
        this._stickyReads = new Map(); // userId → timestamp

        // Health check
        this._healthyReplicas = new Set(
            config.replicaHosts.map((_, i) => i)
        );
        this._startHealthCheck();
    }

    // Round-robin sur les replicas sains
    _getReplicaPool() {
        if (this._healthyReplicas.size === 0) {
            console.warn('Aucun replica sain, fallback sur le primary');
            return this.primary;
        }

        const healthyIndexes = [...this._healthyReplicas];
        const idx = healthyIndexes[
            this._replicaIndex % healthyIndexes.length
        ];
        this._replicaIndex++;
        return this.replicas[idx];
    }

    // Health check periodique des replicas
    _startHealthCheck() {
        setInterval(async () => {
            for (let i = 0; i < this.replicas.length; i++) {
                try {
                    const { rows } = await this.replicas[i].query(
                        'SELECT 1 AS ok'
                    );
                    if (rows[0].ok === 1) {
                        this._healthyReplicas.add(i);
                    }
                } catch (err) {
                    console.error(
                        `Replica ${i} en panne :`, err.message
                    );
                    this._healthyReplicas.delete(i);
                }
            }
        }, 5000); // Toutes les 5 secondes
    }

    // Marquer un utilisateur comme "sticky" apres une ecriture
    markWrite(userId) {
        this._stickyReads.set(userId, Date.now());
    }

    // Determiner si l'utilisateur doit lire sur le primary
    _isSticky(userId) {
        if (!userId) return false;
        const lastWrite = this._stickyReads.get(userId);
        if (!lastWrite) return false;
        const elapsed = Date.now() - lastWrite;
        if (elapsed > 5000) {
            this._stickyReads.delete(userId);
            return false;
        }
        return true;
    }

    // Requete en lecture
    async read(sql, params, { userId } = {}) {
        if (this._isSticky(userId)) {
            // Lire sur le primary pour eviter le stale read
            return this.primary.query(sql, params);
        }
        return this._getReplicaPool().query(sql, params);
    }

    // Requete en ecriture
    async write(sql, params, { userId } = {}) {
        const result = await this.primary.query(sql, params);
        if (userId) {
            this.markWrite(userId);
        }
        return result;
    }

    // Transaction (toujours sur le primary)
    async transaction(fn) {
        const client = await this.primary.connect();
        try {
            await client.query('BEGIN');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    // Fermer toutes les connexions
    async close() {
        await this.primary.end();
        await Promise.all(this.replicas.map(r => r.end()));
    }
}

// ============================================================
// Utilisation
// ============================================================

const db = new DatabaseRouter({
    primaryHost: 'primary.example.com',
    replicaHosts: [
        'replica1.example.com',
        'replica2.example.com',
    ],
    port: 5432,
    database: 'mydb',
    user: 'app',
    password: 'secret',
    readonlyUser: 'app_readonly',
    readonlyPassword: 'secret_ro',
});

// Lecture → va sur un replica
const users = await db.read(
    'SELECT * FROM users WHERE active = true',
    [],
    { userId: 42 }
);

// Ecriture → va sur le primary + marque l'user comme "sticky"
await db.write(
    'UPDATE users SET last_login = now() WHERE id = $1',
    [42],
    { userId: 42 }
);

// Lecture juste apres ecriture → va sur le primary (sticky)
const user = await db.read(
    'SELECT * FROM users WHERE id = $1',
    [42],
    { userId: 42 }  // sticky pendant 5 secondes
);

// Transaction → toujours sur le primary
await db.transaction(async (client) => {
    await client.query(
        'UPDATE comptes SET solde = solde - 100 WHERE id = $1', [1]
    );
    await client.query(
        'UPDATE comptes SET solde = solde + 100 WHERE id = $1', [2]
    );
});
```

---

## 10. Exercice mental

> **Exercice mental 1** : Vous avez un primary et deux standbys en replication asynchrone. Le primary tombe. Le standby 1 a un lag de 0.5s, le standby 2 a un lag de 2s. Lequel promouvoir ? Quelles donnees sont perdues ?

<details>
<summary>Reponse</summary>

On promeut le **standby 1** (lag le plus faible). Les transactions commitees dans les 0.5 dernieres secondes sur le primary, mais pas encore repliquees sur le standby 1, sont **perdues**. C'est le prix de la replication asynchrone.

Pour eviter cette perte, il faudrait utiliser `synchronous_commit = on` avec `synchronous_standby_names`, mais cela augmente la latence d'ecriture et bloque les ecritures si tous les standbys synchrones sont indisponibles.
</details>

> **Exercice mental 2** : Vous utilisez la replication logique pour migrer de PG14 a PG16. Un developpeur execute un `ALTER TABLE orders ADD COLUMN discount NUMERIC DEFAULT 0` sur le publisher (PG14). Que se passe-t-il cote subscriber ?

<details>
<summary>Reponse</summary>

**Rien ne se passe automatiquement.** La replication logique ne replique pas le DDL. Le subscriber n'a pas la colonne `discount`. Les INSERT futures sur le publisher incluront `discount`, mais le subscriber ne la recevra pas (la colonne est ignoree).

Il faut executer manuellement le meme `ALTER TABLE` sur le subscriber. Si on ne le fait pas, les donnees de la colonne `discount` sont perdues cote subscriber.

C'est une des principales limitations de la replication logique : le DDL doit etre synchronise manuellement.
</details>

> **Exercice mental 3** : Votre replication slot `standby1_slot` est marque comme `active = false` dans `pg_replication_slots` et le `lag_bytes` augmente de 16 MB par heure. Combien de temps avant que le disque du primary (200 GB libres) soit plein ?

<details>
<summary>Reponse</summary>

200 GB = 200 * 1024 MB = 204 800 MB.
A 16 MB/heure : 204 800 / 16 = **12 800 heures** soit environ **533 jours**.

Cela semble confortable, mais attention : si la charge augmente (batch nocturne, import massif), le rythme peut passer a plusieurs GB/heure. Il faut **monitorer** les slots inactifs et les supprimer si le standby est definitivement perdu :

```sql
SELECT pg_drop_replication_slot('standby1_slot');
```
</details>

---

## Ce qu'il faut retenir

```
┌──────────────────────────────────────────────────────────────┐
│                    A RETENIR                                  │
│                                                               │
│  1. Streaming replication = copie physique des WAL            │
│     → HA + read scaling. Meme version majeure.               │
│                                                               │
│  2. Logical replication = operations SQL decodees             │
│     → Migration, replication partielle, cross-version.       │
│                                                               │
│  3. synchronous_commit controle la garantie de durabilite    │
│     remote_apply = zero data loss + lectures coherentes.     │
│                                                               │
│  4. Replication slots empechent le recyclage premature        │
│     des WAL, mais attention au remplissage disque !          │
│                                                               │
│  5. PITR = pg_basebackup + WAL archiving                     │
│     → Restauration a n'importe quel instant.                 │
│                                                               │
│  6. Patroni = standard pour la HA automatisee                │
│     Failover automatique + prevention du split-brain.        │
│                                                               │
│  7. Read replicas : attention au replication lag              │
│     → Sticky reads ou synchronous_commit = remote_apply.     │
│                                                               │
│  8. Toujours monitorer pg_stat_replication et                │
│     pg_replication_slots.                                    │
└──────────────────────────────────────────────────────────────┘
```

---

## Navigation

| Precedent | Suivant |
|---|---|
| [Module 15 — Projet final](./15-projet-final.md) | [Module 17 — Monitoring & Observabilite](./17-monitoring-et-observabilite.md) |

---

> *"La replication n'est pas un luxe, c'est une assurance. Le jour ou votre serveur tombe, la seule question est : aviez-vous un replica pret a prendre le relais ?"*
