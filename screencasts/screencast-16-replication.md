# Screencast 16 — Réplication PostgreSQL

## Informations
- **Durée estimée** : 20-22 min
- **Module** : `modules/16-replication.md`
- **Lab associé** : `labs/lab-16-replication/`
- **Prérequis** : Modules 1-15 terminés, PostgreSQL running, base `course_db`

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] **Deux terminaux** ouverts dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] `psql` connecté à `course_db`
- [ ] Node.js prêt pour les scripts

## Script

### [00:00-04:00] Streaming replication — concepts et setup

> Bienvenue dans le module sur la réplication PostgreSQL. La réplication est essentielle en production pour la haute disponibilité, la répartition de charge, et la reprise après sinistre. On va explorer les deux types principaux : physique (streaming) et logique.

**Action** : Afficher un schéma d'architecture primary/standby.

> La réplication physique — aussi appelée streaming replication — consiste à transmettre les WAL (Write-Ahead Logs) du primary au standby. Le standby rejoue ces WAL et maintient une copie exacte, bit-à-bit. C'est le mécanisme le plus courant en production.

**Action** : Vérifier la configuration WAL du serveur.

```sql
-- Vérifier le niveau WAL
SHOW wal_level;
-- 'replica' = streaming replication possible
-- 'logical' = réplication logique aussi possible

-- Paramètres clés pour la réplication
SHOW max_wal_senders;
SHOW max_replication_slots;
SHOW wal_keep_size;

-- Vérifier les connexions de réplication autorisées
SELECT * FROM pg_hba_file_rules
WHERE database = '{replication}' OR database @> ARRAY['replication'];
```

> Le `wal_level` doit être au minimum `replica` pour le streaming. Les `max_wal_senders` définissent combien de standbys peuvent se connecter simultanément. En production, on utilise des replication slots pour garantir que le primary conserve les WAL nécessaires.

**Action** : Montrer les paramètres et expliquer leur rôle.

```sql
-- Configuration typique d'un primary (postgresql.conf)
-- wal_level = replica
-- max_wal_senders = 5
-- max_replication_slots = 5
-- wal_keep_size = 1GB

-- Vue des WAL senders actifs
SELECT * FROM pg_stat_replication;

-- Vue des slots de réplication
SELECT slot_name, slot_type, active, restart_lsn
FROM pg_replication_slots;
```

### [04:00-09:00] Réplication logique — publication/subscription

> La réplication logique est différente : au lieu de copier les WAL bruts, PostgreSQL décode les changements en opérations SQL logiques. Ça permet de répliquer table par table, entre versions différentes, et même d'écrire sur le subscriber.

**Action** : Créer une publication et démontrer le décodage logique.

```sql
-- Créer une table de démonstration
CREATE TABLE repl_demo (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    value INT DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Vérifier que wal_level est 'logical'
SHOW wal_level;

-- Créer une publication (côté publisher)
CREATE PUBLICATION demo_pub FOR TABLE repl_demo;

-- Vérifier la publication
SELECT * FROM pg_publication;
SELECT * FROM pg_publication_tables WHERE pubname = 'demo_pub';
```

> La publication définit quelles tables sont répliquées. Le subscriber se connecte et reçoit les changements. Voyons le décodage logique en action.

**Action** : Démontrer le décodage logique avec un slot.

```sql
-- Créer un slot de réplication logique (pour la démo)
SELECT pg_create_logical_replication_slot('demo_slot', 'test_decoding');

-- Insérer des données
INSERT INTO repl_demo (name, value) VALUES
    ('alpha', 100),
    ('beta', 200),
    ('gamma', 300);

-- Lire les changements décodés
SELECT lsn, xid, data
FROM pg_logical_slot_get_changes('demo_slot', NULL, NULL);
```

> Vous voyez les INSERT décodés en texte lisible. C'est exactement ce qu'un subscriber recevrait. Le format `test_decoding` est un plugin de démo — en production, on utilise `pgoutput` qui est le format natif des subscriptions.

**Action** : Montrer les changements décodés et expliquer la sortie.

```sql
-- Mettre à jour et supprimer
UPDATE repl_demo SET value = 999 WHERE name = 'alpha';
DELETE FROM repl_demo WHERE name = 'gamma';

-- Voir les changements
SELECT lsn, xid, data
FROM pg_logical_slot_get_changes('demo_slot', NULL, NULL);

-- Nettoyage
SELECT pg_drop_replication_slot('demo_slot');
DROP PUBLICATION demo_pub;
```

> Les UPDATE et DELETE sont aussi capturés. Le subscriber applique ces changements pour rester synchronisé. Contrairement à la réplication physique, le subscriber peut avoir ses propres index, tables supplémentaires, et même recevoir des écritures locales.

### [09:00-13:00] Monitoring avec pg_stat_replication

> En production, le monitoring de la réplication est critique. `pg_stat_replication` est la vue principale côté primary.

**Action** : Explorer la vue pg_stat_replication en détail.

```sql
-- Structure de pg_stat_replication
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'pg_stat_replication'
ORDER BY ordinal_position;

-- Les colonnes clés :
-- pid           : PID du WAL sender
-- usename       : utilisateur de réplication
-- application_name : nom du standby
-- client_addr   : adresse IP du standby
-- state         : streaming, startup, catchup, backup
-- sent_lsn      : dernier LSN envoyé
-- write_lsn     : dernier LSN écrit par le standby
-- flush_lsn     : dernier LSN flush sur disque standby
-- replay_lsn    : dernier LSN appliqué par le standby
-- write_lag, flush_lag, replay_lag : retards en temps

-- Requête de monitoring du lag
SELECT
    pid,
    application_name,
    client_addr,
    state,
    sent_lsn,
    replay_lsn,
    write_lag,
    flush_lag,
    replay_lag,
    pg_wal_lsn_diff(sent_lsn, replay_lsn) AS replay_lag_bytes
FROM pg_stat_replication;
```

> La différence entre `sent_lsn` et `replay_lsn` donne le lag en bytes. Les colonnes `_lag` donnent le lag en temps. Un `replay_lag` > 1 seconde mérite attention. Un lag croissant indique que le standby n'arrive pas à suivre.

**Action** : Expliquer chaque colonne et les seuils d'alerte.

```sql
-- Vue côté standby : pg_stat_wal_receiver
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'pg_stat_wal_receiver'
ORDER BY ordinal_position;

-- Statistiques WAL globales
SELECT
    wal_records,
    wal_fpi,
    wal_bytes,
    pg_size_pretty(wal_bytes::bigint) AS wal_bytes_pretty,
    wal_write,
    wal_sync
FROM pg_stat_wal;
```

### [13:00-17:00] PITR — Point-In-Time Recovery

> Le PITR permet de restaurer une base à un instant précis dans le passé. C'est basé sur les WAL archivés et un backup de base (pg_basebackup).

**Action** : Vérifier les prérequis pour pg_basebackup et PITR.

```sql
-- Prérequis pg_basebackup
SHOW max_wal_senders;           -- doit être > 0
SHOW max_replication_slots;      -- doit être > 0
SHOW wal_level;                  -- doit être replica ou logical

-- Vérifier les permissions
SELECT rolname, rolreplication, rolsuper
FROM pg_roles
WHERE rolname = current_user;

-- Archivage WAL (nécessaire pour PITR)
SHOW archive_mode;
SHOW archive_command;
```

> Le workflow PITR est : (1) pg_basebackup pour le backup de base, (2) archivage continu des WAL, (3) en cas de besoin, restaurer le backup et rejouer les WAL jusqu'à l'instant cible.

**Action** : Montrer les commandes de pg_basebackup (sans l'exécuter sur la base de cours).

```bash
# pg_basebackup — commande typique
# pg_basebackup -h primary_host -U repl_user -D /backup/base \
#   --wal-method=stream --checkpoint=fast -P

# Restauration PITR — recovery.conf (ou postgresql.conf en v12+)
# restore_command = 'cp /archive/%f %p'
# recovery_target_time = '2024-06-15 14:30:00'
# recovery_target_action = 'promote'
```

```sql
-- Vérifier la timeline actuelle
SELECT pg_current_wal_lsn(), pg_walfile_name(pg_current_wal_lsn());

-- Après un PITR, la timeline est incrémentée
-- pour éviter les conflits avec les anciens WAL
```

> Le PITR est votre filet de sécurité ultime. Même si quelqu'un exécute un `DELETE FROM orders` accidentel en production, vous pouvez restaurer la base à la seconde avant l'erreur.

### [17:00-20:00] Routage read replica et démo lab

> En production, on utilise souvent des read replicas pour répartir la charge de lecture. L'application route les SELECT vers les standbys et les écritures vers le primary.

**Action** : Démontrer le routage lecture/écriture avec deux connexions.

```sql
-- Simuler un client read-only (comme un read replica)
-- Terminal 2 :
SET default_transaction_read_only = ON;

-- Les SELECT fonctionnent normalement
SELECT count(*) FROM repl_demo;

-- Les écritures sont refusées
INSERT INTO repl_demo (name, value) VALUES ('test', 0);
-- ERROR: cannot execute INSERT in a read-only transaction
```

> Ce pattern simule ce qu'on obtient avec un vrai standby en hot_standby mode. Les frameworks comme PgBouncer, pgpool-II, ou les drivers applicatifs (libpq target_session_attrs) gèrent ce routage automatiquement.

**Action** : Ouvrir le lab 16 et parcourir les exercices.

```bash
ls labs/lab-16-replication/
# README.md  exercise.js  solution.js
```

> Le lab 16 vous fait pratiquer la vérification WAL, les publications, le décodage logique, le monitoring du lag, et le routage lecture/écriture. Comme la réplication complète nécessite plusieurs instances PostgreSQL, les exercices simulent les concepts sur une seule instance.

**Action** : Montrer le résumé des 8 tests du lab.

### [20:00-22:00] Récapitulatif

> Pour résumer : la réplication physique (streaming) copie les WAL bruts pour une copie exacte — c'est simple et fiable. La réplication logique décode les changements et permet la réplication sélective. Les replication slots garantissent qu'aucun WAL n'est recyclé prématurément. `pg_stat_replication` est votre tableau de bord. Et le PITR via pg_basebackup est votre assurance-vie contre les erreurs humaines.

**Action** : Afficher un résumé des concepts clés.

```sql
-- Points clés à retenir :
-- 1. wal_level = replica (minimum) ou logical
-- 2. Streaming = WAL bruts, Logique = changements SQL
-- 3. Replication slots empêchent le recyclage WAL
-- 4. pg_stat_replication pour le monitoring
-- 5. pg_basebackup + WAL archiving = PITR
-- 6. Read replicas : routage automatique lecture/écriture

-- Nettoyage
DROP TABLE IF EXISTS repl_demo CASCADE;
```

## Points d'attention pour l'enregistrement
- Ce screencast est conceptuel — pas de vrai standby à configurer
- Vérifier wal_level AVANT de démarrer (logical idéalement pour la démo de décodage)
- Si wal_level = replica, adapter la section décodage logique (mentionner qu'il faut logical)
- La démo pg_basebackup est en mode dry-run — ne pas exécuter réellement
- Insister sur la différence physique vs logique
- Montrer les colonnes de pg_stat_replication même si la vue est vide
- Le routage read-only avec SET default_transaction_read_only est la partie interactive
