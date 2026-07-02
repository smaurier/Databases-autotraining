---
titre: Réplication
cours: 10-postgresql
notions: [réplication en flux streaming, primaire et réplica, rôle du WAL, réplication synchrone vs asynchrone, réplicas en lecture, réplication logique, bascule failover, haute disponibilité]
outcomes: [expliquer la réplication streaming primaire/réplica, distinguer synchrone et asynchrone, router les lectures vers un réplica, comprendre failover et haute disponibilité]
prerequis: [15-projet-final]
next: 17-monitoring-et-observabilite
libs: [{ name: postgresql, version: "17" }]
tribuzen: réplicas en lecture pour scaler les lectures du feed TribuZen sans surcharger le primaire
last-reviewed: 2026-07
---

# Réplication

> **Outcomes — tu sauras FAIRE :** expliquer la réplication streaming primaire/réplica, distinguer synchrone et asynchrone, router les lectures vers un réplica, et comprendre failover et haute disponibilité.
> **Difficulté :** :star::star::star::star:

## 1. Cas concret d'abord

Le feed TribuZen génère 90 % de trafic en lecture (`SELECT` sur `posts`, `reactions`, `users`) et 10 % en écriture. Avec 50 000 familles actives le vendredi soir, le **primaire unique** atteint 600 connexions simultanées et répond en 400 ms au lieu de 10 ms. `pg_stat_activity` le confirme :

```sql
-- Sur le primaire surchargé (instance unique)
SELECT state, COUNT(*)
FROM pg_stat_activity
WHERE datname = 'tribuzen'
GROUP BY state;
--  state  | count
-- --------+-------
--  active |   612
--  idle   |   190
```

Le diagnostic est clair : les lectures paient le coût du moteur d'écriture (flush WAL, MVCC) alors qu'un réplica en lecture seule n'a pas ce surcoût. Router les `SELECT` vers un réplica libère le primaire pour les `INSERT` / `UPDATE` et fait descendre la latence du feed.

Ce module explique comment PostgreSQL réplique le primaire vers un réplica via le WAL, quelle garantie choisir (synchrone vs asynchrone), comment activer les lectures sur le réplica, et comment basculer en cas de panne.

## 2. Théorie complète, concise

### Le WAL comme colonne vertébrale de la réplication

PostgreSQL écrit **toute modification** dans le WAL (Write-Ahead Log) avant de toucher les fichiers de données — c'est ce qui garantit la durabilité (D d'ACID). La **réplication en flux** (streaming replication) exploite ce même WAL : le primaire ouvre un flux TCP vers chaque réplica et lui envoie les enregistrements WAL en quasi-temps réel. Le réplica les rejoue dans l'ordre, obtenant une copie physique bit-à-bit du primaire.

```conf
# postgresql.conf du PRIMAIRE — paramètres minimaux
wal_level        = replica   # encode les infos nécessaires pour les réplicas
max_wal_senders  = 5         # connexions de réplication simultanées autorisées
wal_keep_size    = 256MB     # conserver ces WAL même si un réplica est lent (PG13+)
```

### Architecture primaire / réplica

```
        ┌─────────────┐
        │  Application│
        └──────┬──────┘
               │
        ┌──────▼──────┐
        │   PRIMAIRE  │  ← seul serveur acceptant les écritures
        │  (read/write│
        │  port 5432) │
        └──┬───────┬──┘
     flux  │       │  flux
     WAL   │       │  WAL
  ┌────────▼──┐ ┌──▼────────┐
  │  RÉPLICA 1│ │  RÉPLICA 2│  ← lecture seule si hot_standby = on
  │  port 5433│ │  port 5434│
  └───────────┘ └───────────┘
```

Le réplica démarre avec un `pg_basebackup` du primaire, puis suit le flux WAL via le processus **WAL receiver**. La présence du fichier `standby.signal` (fichier vide) indique à PostgreSQL de démarrer en mode standby. L'option `-R` de `pg_basebackup` génère automatiquement ce fichier et le `primary_conninfo`.

### Réplication synchrone vs asynchrone

La différence est **quand le primaire confirme le COMMIT au client**.

**Asynchrone (défaut)** : le primaire confirme dès que la modification est écrite dans son propre WAL. Le réplica peut avoir quelques millisecondes de retard. Si le primaire tombe à cet instant, les dernières transactions peuvent ne pas avoir atteint le réplica → perte de données possible (RPO > 0).

**Synchrone** : le primaire attend l'accusé de réception du réplica avant de confirmer. Zéro perte de données (RPO = 0), mais chaque écriture supporte un aller-retour réseau supplémentaire. Si le réplica synchrone tombe, **les écritures se bloquent** sur le primaire.

```conf
# postgresql.conf du PRIMAIRE — activer la synchronisation
synchronous_standby_names = 'replica1'
```

```sql
-- Contrôle fin par transaction
BEGIN;
SET LOCAL synchronous_commit = 'local';     -- flush local uniquement, pas d'attente réplica
INSERT INTO events_log (type, ts) VALUES ('page_view', now());
COMMIT;

BEGIN;
SET LOCAL synchronous_commit = 'remote_apply';  -- attendre que le réplica ait appliqué
UPDATE accounts SET balance = balance - 100 WHERE id = 42;
COMMIT;
```

| Valeur `synchronous_commit` | Garantie | Latence ajoutée |
|---|---|---|
| `off` | Aucune (flush différé) | Nulle |
| `local` | Flush primaire uniquement | Nulle |
| `on` (défaut si sync activé) | Flush primaire + flush réplica | Aller-retour réseau |
| `remote_apply` | Le réplica a appliqué le WAL | Aller-retour + replay |

### Réplicas en lecture (hot_standby)

```conf
# postgresql.conf du RÉPLICA
hot_standby          = on   # autorise les SELECT sur le réplica
hot_standby_feedback = on   # informe le primaire des snapshots en cours
                            # (évite que VACUUM supprime des tuples
                            #  encore nécessaires au réplica)
```

```sql
-- Sur le RÉPLICA : vérifier qu'on est bien en lecture seule
SELECT pg_is_in_recovery();   -- true = réplica, false = primaire
```

### Monitoring du lag

```sql
-- Sur le PRIMAIRE : état de chaque réplica connecté
SELECT
    client_addr,
    state,
    sync_state,
    pg_size_pretty(
        pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)
    ) AS lag_taille,
    replay_lag   -- retard en temps (PG10+)
FROM pg_stat_replication;
```

| Colonne | Signification |
|---|---|
| `sent_lsn` | Dernier WAL envoyé au réplica |
| `flush_lsn` | Dernier WAL écrit sur disque par le réplica |
| `replay_lsn` | Dernier WAL appliqué par le réplica |
| `replay_lag` | Retard en temps entre primaire et réplica |

Un **slot de réplication** (`pg_create_physical_replication_slot`) garantit que le primaire conserve les WAL même si le réplica prend du retard — au prix d'un risque de saturation disque si le réplica reste hors ligne trop longtemps.

### Failover et pg_promote()

Quand le primaire devient inaccessible, on **promeut** un réplica en nouveau primaire :

```sql
-- Sur le RÉPLICA à promouvoir (PG12+)
SELECT pg_promote(wait := true, wait_seconds := 60);
-- Le réplica accepte maintenant les écritures

-- Vérifier que la promotion est complète
SELECT pg_is_in_recovery();   -- doit retourner false
```

```bash
# Alternative shell
pg_ctl -D /var/lib/pgsql/17/data promote
```

L'ancien primaire, une fois réparé, ne peut pas rejoindre le cluster tel quel : il a divergé sur son propre **timeline**. On utilise `pg_rewind` pour le réconcilier rapidement sans refaire un `pg_basebackup` complet.

```bash
# Resynchroniser l'ancien primaire comme nouveau réplica
pg_rewind \
    --target-pgdata=/var/lib/pgsql/17/data \
    --source-server='host=nouveau-primaire port=5432 user=replicator'
```

### Réplication logique

La réplication physique copie le WAL **bit-à-bit** : même version majeure obligatoire, toute la base répliquée. La réplication **logique** décode le WAL en opérations SQL (INSERT / UPDATE / DELETE) et les rejoue sur un subscriber qui peut avoir une version, un schéma ou une structure différents.

```sql
-- Sur le PUBLISHER (wal_level = logical requis)
ALTER SYSTEM SET wal_level = 'logical';
-- (redémarrage nécessaire)

CREATE PUBLICATION pub_feed
    FOR TABLE posts, reactions, users;
    -- PG17 : filtres de lignes possibles (WHERE clause par table dans la publication)

-- Sur le SUBSCRIBER
CREATE SUBSCRIPTION sub_feed
    CONNECTION 'host=publisher port=5432 dbname=tribuzen user=replicator password=secret'
    PUBLICATION pub_feed;
```

```sql
-- Vérifier la progression de la synchronisation initiale
SELECT subname, subenabled FROM pg_subscription;
SELECT * FROM pg_stat_subscription;
```

Limites : pas de réplication DDL automatique (`ALTER TABLE` à rejouer manuellement), pas de réplication des séquences, `REPLICA IDENTITY` requis pour UPDATE / DELETE sans PRIMARY KEY.

**PG 17** : les **failover slots** permettent à un slot logique de survivre au failover physique du publisher — avant PG17, un failover faisait perdre la position de décodage et nécessitait de resynchroniser le subscriber depuis zéro.

### Haute disponibilité avec Patroni

Pour un failover **automatique**, **Patroni** orchestre le cluster via un consensus distribué (etcd, Consul ou ZooKeeper). Patroni surveille chaque nœud, élit le leader, déclenche la promotion et reconstruit les standbys après bascule, sans intervention humaine.

```yaml
# patroni.yml (extrait)
scope: tribuzen-cluster
bootstrap:
  dcs:
    ttl: 30
    maximum_lag_on_failover: 1048576   # n'élire que les réplicas avec moins de 1 MB de lag
    synchronous_mode: false
  postgresql:
    parameters:
      wal_level: replica
      hot_standby: "on"
      max_wal_senders: 5
```

## 3. Worked examples

### Exemple A — Configurer un réplica streaming

Scénario : primaire sur `primary.local:5432`, réplica à monter sur `replica.local`.

**Étape 1 — Préparer le primaire**

```sql
-- Créer le rôle de réplication
CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'secret_repl';
```

```conf
# pg_hba.conf du PRIMAIRE — autoriser le réplica
hostssl   replication   replicator   10.0.1.0/24   scram-sha-256
```

**Étape 2 — Bootstrapper le réplica**

```bash
# Copie physique cohérente du primaire + génération des fichiers de config
pg_basebackup \
    -h primary.local -U replicator \
    -D /var/lib/pgsql/17/data \
    -Fp -Xs -P -R
# -R : génère standby.signal + postgresql.auto.conf avec primary_conninfo
```

```conf
# postgresql.auto.conf généré automatiquement
primary_conninfo = 'host=primary.local port=5432 user=replicator password=secret_repl'
```

```conf
# postgresql.conf du RÉPLICA
hot_standby = on
```

**Étape 3 — Démarrer et vérifier**

```bash
pg_ctl -D /var/lib/pgsql/17/data start
```

```sql
-- Sur le PRIMAIRE : confirmer la connexion du réplica
SELECT client_addr, state, sync_state, replay_lag
FROM pg_stat_replication;
--  client_addr | state     | sync_state | replay_lag
-- -------------+-----------+------------+------------
--  10.0.1.5    | streaming | async      | 00:00:00.02
```

Pas-à-pas : (1) `pg_basebackup -R` crée une copie physique cohérente du primaire et génère les fichiers de configuration nécessaires — c'est la seule méthode supportée pour bootstrapper un réplica streaming ; (2) `standby.signal` est un fichier vide dont la **présence** suffit à signaler à PostgreSQL de démarrer en mode récupération continue ; (3) `pg_stat_replication` sur le primaire est la source de vérité — `state = streaming` confirme que le réplica suit le flux WAL en temps réel.

### Exemple B — Router les lectures vers le réplica (Node.js)

```typescript
import { Pool } from 'pg';

// Écritures → primaire uniquement
const primary = new Pool({
    host: 'primary.local', port: 5432,
    database: 'tribuzen', user: 'app', password: 'secret', max: 20,
});

// Lectures → réplica (utilisateur en lecture seule pour defense-in-depth)
const replica = new Pool({
    host: 'replica.local', port: 5432,
    database: 'tribuzen', user: 'app_ro', password: 'secret_ro', max: 30,
});

// Feed TribuZen (lecture seule) → réplica
export async function getFeed(familyId: number, cursor?: { ts: string; id: number }) {
    const whereKeyset = cursor
        ? 'AND (p.created_at, p.id) < ($2, $3)'
        : '';
    const params: unknown[] = cursor
        ? [familyId, cursor.ts, cursor.id]
        : [familyId];
    const { rows } = await replica.query(
        `SELECT p.id, p.content, p.created_at, u.display_name
         FROM posts p JOIN users u ON p.author_id = u.id
         WHERE p.family_id = $1 ${whereKeyset}
         ORDER BY p.created_at DESC, p.id DESC
         LIMIT 20`,
        params,
    );
    return rows;
}

// Publier un post (écriture) → primaire
export async function createPost(familyId: number, authorId: number, content: string) {
    const { rows } = await primary.query(
        `INSERT INTO posts (family_id, author_id, content)
         VALUES ($1, $2, $3) RETURNING id, created_at`,
        [familyId, authorId, content],
    );
    return rows[0];
    // On retourne le RETURNING du primaire : pas besoin de relire sur le réplica
    // (évite le stale read dans les 10-100 ms qui suivent l'écriture)
}
```

Pas-à-pas : (1) deux pools distincts — `replica` avec un `max` plus élevé (30 vs 20) car c'est là que va l'essentiel du trafic ; (2) l'utilisateur `app_ro` n'a que `SELECT` — si un bug de routing tente un `INSERT` sur le réplica, PostgreSQL le rejette avec `cannot execute INSERT in a read-only transaction` (defense-in-depth) ; (3) la pagination keyset `(created_at, id) < ($2, $3)` garantit des performances constantes même à grande profondeur de feed (voir module 11) ; (4) `createPost` retourne le `RETURNING` du primaire sans relire sur le réplica, évitant le problème de stale read qui survient dans les millisecondes suivant une écriture.

### Exemple C — Observer le lag et promouvoir en failover

```sql
-- Mettre en pause le replay sur le RÉPLICA (simulation de lag, test uniquement)
SELECT pg_wal_replay_pause();
```

```sql
-- Écrire sur le PRIMAIRE (le lag s'accumule)
INSERT INTO posts (family_id, author_id, content)
SELECT 1, 1, 'post test lag ' || i
FROM generate_series(1, 1000) i;

-- Mesurer le lag depuis le PRIMAIRE
SELECT
    client_addr,
    pg_size_pretty(
        pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)
    ) AS lag_taille,
    replay_lag
FROM pg_stat_replication;
```

```sql
-- Reprendre le replay sur le RÉPLICA
SELECT pg_wal_replay_resume();

-- Simuler un failover : promouvoir le réplica
SELECT pg_promote(wait := true, wait_seconds := 30);

-- Confirmer : le réplica est devenu primaire
SELECT pg_is_in_recovery();   -- false = primaire actif
```

Pas-à-pas : (1) `pg_wal_replay_pause()` gèle le replay sans couper le flux WAL — le réplica continue de recevoir des WAL mais ne les applique pas, simulant un réplica lent sans vraie déconnexion ; (2) `pg_wal_lsn_diff` calcule l'écart en octets entre la position courante du primaire et le dernier LSN appliqué par le réplica — c'est la métrique à monitorer en production ; (3) `pg_promote(wait := true)` est la méthode PG12+ recommandée — `wait := true` rend l'appel synchrone et confirme que la promotion est complète avant de retourner ; (4) `pg_is_in_recovery() = false` est le test décisif avant de rediriger les connexions d'écriture vers le nouveau primaire.

## 4. Pièges & misconceptions

- **Lire sur le réplica juste après une écriture (stale read).** En réplication asynchrone, le réplica peut avoir 10-100 ms de retard. Relire l'enregistrement qu'on vient de créer peut retourner « introuvable ». *Correct* : retourner le résultat directement via `RETURNING` depuis le primaire, ou implémenter des "sticky reads" — forcer l'utilisateur à lire sur le primaire pendant quelques secondes après chaque écriture.

- **`synchronous_commit = on` avec un seul réplica synchrone bloque toutes les écritures si ce réplica tombe.** Si `synchronous_standby_names = 'replica1'` et que `replica1` est hors ligne, chaque `COMMIT` attend indéfiniment. *Correct* : utiliser `'FIRST 1 (replica1, replica2)'` pour basculer automatiquement sur un autre réplica synchrone disponible, ou n'activer le synchrone qu'au niveau transaction (`SET LOCAL synchronous_commit = 'on'`) pour les seules écritures critiques.

- **Un slot de réplication inactif remplit le disque du primaire.** Un slot inactif retient tous les WAL depuis son `restart_lsn`. Si le réplica reste hors ligne des heures, le disque du primaire se remplit progressivement jusqu'au crash. *Correct* : surveiller `pg_replication_slots` (colonne `active` et `lag_bytes`) et supprimer les slots orphelins avec `SELECT pg_drop_replication_slot('nom_slot')` dès que le réplica est définitivement abandonné.

- **La réplication logique réplique le DDL automatiquement.** Non : `CREATE TABLE`, `ALTER TABLE`, `DROP` ne sont pas répliqués. Ajouter une colonne sur le publisher sans la créer d'abord sur le subscriber provoque le rejet des INSERT suivants sur le subscriber. *Correct* : toujours appliquer le DDL manuellement dans l'ordre (subscriber d'abord pour une colonne ajoutée, publisher d'abord pour une colonne supprimée) avant la modification sur le publisher.

- **L'ancien primaire peut rejoindre le cluster sans resynchronisation.** Après un failover, l'ancien primaire a divergé sur son propre timeline. Le brancher directement comme réplica causera des erreurs de timeline. *Correct* : utiliser `pg_rewind` pour resynchroniser rapidement l'ancien primaire avec le nouveau, puis le redémarrer comme réplica avec `standby.signal`.

- **Failover = redémarrage normal.** Si le primaire a été arrêté proprement (`pg_ctl stop -m fast`), il n'y a pas de failover — on peut redémarrer le primaire directement. `pg_promote()` est réservé aux pannes non planifiées où le primaire est vraiment inaccessible. *Correct* : distinguer arrêt propre (redémarrer le primaire) de panne (promouvoir un réplica).

## 5. Ancrage TribuZen

Couche fil-rouge : **réplicas en lecture** dans `smaurier/tribuzen` pour scaler le feed sans surcharger le primaire.

- `getFeed()` (Exemple B) pointe vers le pool `replica` — les 90 % de trafic SELECT ne sollicitent plus le primaire. Sur 50 000 familles actives, cela divise par 3 la charge CPU du primaire et fait descendre la latence du feed de 400 ms à 12 ms.
- Le pool `replica` utilise l'utilisateur `app_ro` (droits `SELECT` uniquement) — si un bug de routing envoie un INSERT vers le réplica, PostgreSQL le rejette proprement avec `cannot execute INSERT in a read-only transaction`.
- `hot_standby_feedback = on` empêche le primaire de VACUUM-er des tuples encore visibles pour les transactions de lecture longues du réplica (pagination du feed sur plusieurs pages).
- En cas de panne du primaire la nuit, Patroni promeut automatiquement le réplica le moins en retard (`maximum_lag_on_failover`). L'application ne change pas ses chaînes de connexion si elles pointent vers un VIP ou un proxy (HAProxy, PgBouncer).
- La réplication logique sert pour les futures migrations de version (PG17 → PG18) sans downtime : publisher sur la vieille version, subscriber sur la nouvelle, bascule du trafic une fois le lag à zéro.

## 6. Points clés

1. La réplication streaming envoie le WAL du primaire vers le réplica en quasi-temps réel — le réplica rejoue ce WAL et obtient une copie physique identique.
2. `wal_level = replica` + `max_wal_senders` sur le primaire ; `standby.signal` + `primary_conninfo` sur le réplica ; `pg_basebackup -Fp -Xs -P -R` pour bootstrapper.
3. Asynchrone (défaut) : confirmation immédiate, risque de perte des dernières transactions. Synchrone (`synchronous_commit = on`) : zéro perte, écriture plus lente, blocage si le réplica synchrone tombe.
4. `hot_standby = on` sur le réplica active les SELECT — router les lectures vers le réplica libère le primaire pour les écritures.
5. Surveiller `pg_stat_replication` (lag en octets et en temps) et `pg_replication_slots` (slots inactifs = risque de saturation disque).
6. Failover : `pg_promote()` promeut un réplica en primaire ; `pg_rewind` resynchronise l'ancien primaire comme réplica sans refaire un `pg_basebackup` complet.
7. La réplication logique (publication / subscription) permet la réplication sélective par table et les migrations cross-version, mais ne réplique pas le DDL.
8. Pour le failover automatique sans intervention humaine, Patroni + etcd est le standard de production.

## 7. Seeds Anki

```
Quel paramètre du primaire détermine le volume d'info dans le WAL pour la réplication ?|wal_level = replica (minimal pour streaming) ; wal_level = logical pour la réplication logique
Comment bootstrapper un réplica streaming en une commande ?|pg_basebackup -h primaire -U replicator -D /data -Fp -Xs -P -R — l'option -R génère standby.signal et primary_conninfo automatiquement
Différence réplication synchrone vs asynchrone ?|Asynchrone : primaire confirme sans attendre le réplica → perte possible en cas de panne. Synchrone (synchronous_commit = on) : primaire attend l'accusé du réplica → zéro perte, latence plus élevée
Quel paramètre du réplica autorise les SELECT en lecture ?|hot_standby = on dans postgresql.conf du réplica
Comment mesurer le lag de réplication depuis le primaire ?|SELECT client_addr, replay_lag, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS lag FROM pg_stat_replication
Comment promouvoir un réplica en primaire (PG12+) ?|SELECT pg_promote(wait := true, wait_seconds := 60) depuis le réplica ; pg_is_in_recovery() doit retourner false après
Risque d'un slot de réplication inactif sur le primaire ?|Il retient tous les WAL depuis restart_lsn — le disque du primaire se remplit progressivement ; supprimer avec pg_drop_replication_slot('nom')
Quelle est la limite principale de la réplication logique par rapport à la physique ?|Le DDL (CREATE/ALTER/DROP TABLE) n'est pas répliqué — il faut l'appliquer manuellement sur le subscriber
Comment resynchroniser l'ancien primaire comme réplica après un failover ?|pg_rewind --target-pgdata=/data --source-server='host=nouveau-primaire ...' puis redémarrer avec standby.signal
Qu'apportent les failover slots en PG17 pour la réplication logique ?|Un slot logique peut survivre au failover physique du publisher — avant PG17 un failover faisait perdre la position de décodage et obligeait à resynchroniser le subscriber depuis zéro
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-16-replication/`. Tu configures la réplication logique entre deux bases locales (publication / subscription), tu observes le flux WAL via les vues système, tu simules un lag et tu mesures le retard en octets. Corrigé SQL complet inline dans le README.
