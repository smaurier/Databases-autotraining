# Screencast 09 — Verrous et locks

## Informations
- **Durée estimée** : 18-20 min
- **Module** : `modules/09-verrous-et-locks.md`
- **Lab associé** : `labs/lab-09-locks-en-action/`
- **Prérequis** : Modules 04 et 08 terminés, PostgreSQL running, base `course_db`

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] **Deux terminaux** ouverts dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] **Deux sessions psql** connectées à `course_db`
- [ ] Navigateur prêt pour `lock-matrix.html`

## Script

### [00:00-02:30] Introduction — Row locks (FOR UPDATE)

> MVCC gère la concurrence en lecture, mais pour les écritures, PostgreSQL utilise des verrous. Le verrou le plus courant est le row lock, qui protège une ligne pendant qu'une transaction la modifie.

**Action** : Créer la table de démonstration.

```sql
-- Table de démonstration
CREATE TABLE tickets (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_name  VARCHAR(100) NOT NULL,
    seat        VARCHAR(10) NOT NULL UNIQUE,
    status      VARCHAR(20) NOT NULL DEFAULT 'available'
                CHECK (status IN ('available', 'reserved', 'sold')),
    reserved_by VARCHAR(50)
);

INSERT INTO tickets (event_name, seat) VALUES
    ('Concert Rock', 'A1'), ('Concert Rock', 'A2'), ('Concert Rock', 'A3'),
    ('Concert Rock', 'B1'), ('Concert Rock', 'B2'), ('Concert Rock', 'B3'),
    ('Concert Rock', 'C1'), ('Concert Rock', 'C2'), ('Concert Rock', 'C3');

SELECT * FROM tickets;
```

> `SELECT ... FOR UPDATE` verrouille les lignes sélectionnées. Les autres transactions qui veulent modifier ou verrouiller ces mêmes lignes doivent attendre.

**Action** : Démontrer FOR UPDATE avec deux terminaux.

```sql
-- === TERMINAL 1 ===
BEGIN;
SELECT * FROM tickets
WHERE seat = 'A1' AND status = 'available'
FOR UPDATE;
-- La ligne A1 est maintenant verrouillée par Terminal 1
```

```sql
-- === TERMINAL 2 ===
BEGIN;
SELECT * FROM tickets
WHERE seat = 'A1' AND status = 'available'
FOR UPDATE;
-- Terminal 2 est BLOQUÉ — il attend que Terminal 1 libère le verrou
```

```sql
-- === TERMINAL 1 ===
UPDATE tickets SET status = 'reserved', reserved_by = 'Alice'
WHERE seat = 'A1';
COMMIT;
-- Terminal 2 est débloqué
```

```sql
-- === TERMINAL 2 ===
-- La requête retourne maintenant... 0 lignes ! (status n'est plus 'available')
ROLLBACK;
```

**Action** : Montrer que Terminal 2 est bloqué puis débloqué après le COMMIT de Terminal 1.

### [02:30-05:00] Table locks

> En plus des row locks, PostgreSQL utilise des table-level locks pour certaines opérations. La plupart sont acquis automatiquement.

**Action** : Montrer les différents niveaux de table locks.

```sql
-- Les DDL acquièrent des locks exclusifs sur la table
-- Pendant un ALTER TABLE, personne ne peut lire la table

-- Voir les locks actuels (depuis une 3e session ou après la démo)
-- ACCESS SHARE : SELECT (compatible avec tout sauf ACCESS EXCLUSIVE)
-- ROW SHARE : SELECT FOR UPDATE
-- ROW EXCLUSIVE : INSERT/UPDATE/DELETE
-- SHARE : CREATE INDEX (non-concurrent)
-- ACCESS EXCLUSIVE : ALTER TABLE, DROP TABLE

-- Exemple : lock explicite
BEGIN;
LOCK TABLE tickets IN SHARE MODE;
-- Maintenant les écritures sont bloquées mais les lectures passent
SELECT * FROM tickets;
ROLLBACK;
```

> En pratique, vous n'avez presque jamais besoin de verrous de table explicites. PostgreSQL les gère automatiquement. Mais il est important de comprendre leur existence pour diagnostiquer les problèmes de contention.

**Action** : Montrer les niveaux de locks dans un tableau.

### [05:00-08:00] Observation avec pg_locks

> `pg_locks` est la vue système qui montre tous les verrous actifs. C'est l'outil de diagnostic essentiel.

**Action** : Ouvrir un troisième terminal (où utiliser un des deux) pour observer les locks.

```sql
-- === TERMINAL 1 ===
BEGIN;
SELECT * FROM tickets WHERE seat = 'B1' FOR UPDATE;
-- Garde la transaction ouverte
```

```sql
-- === TERMINAL 2 (observation) ===
-- Voir les verrous actifs avec des informations lisibles
SELECT
    l.locktype,
    l.relation::regclass AS table_name,
    l.mode,
    l.granted,
    l.pid,
    a.query
FROM pg_locks l
JOIN pg_stat_activity a ON l.pid = a.pid
WHERE l.relation IS NOT NULL
  AND a.datname = 'course_db'
ORDER BY l.relation, l.mode;

-- Voir spécifiquement les row locks
SELECT
    l.locktype,
    l.relation::regclass,
    l.page,
    l.tuple,
    l.mode,
    l.granted,
    l.pid
FROM pg_locks l
WHERE l.locktype = 'tuple'
  OR (l.locktype = 'relation' AND l.relation::regclass::text = 'tickets');
```

```sql
-- === TERMINAL 1 ===
ROLLBACK; -- Libérer les verrous
```

> `pg_locks` montre le type de verrou, la table concernée, le mode (FOR UPDATE = RowExclusiveLock), et si le verrou est accordé ou en attente. Quand `granted = false`, la transaction attend.

**Action** : Montrer la sortie de pg_locks et pointer les colonnes importantes.

### [08:00-10:30] NOWAIT — Ne pas attendre

> Parfois, on préfère échouer immédiatement plutôt que d'attendre un verrou. C'est le rôle de `NOWAIT`.

**Action** : Démontrer NOWAIT.

```sql
-- === TERMINAL 1 ===
BEGIN;
SELECT * FROM tickets WHERE seat = 'C1' FOR UPDATE;
-- Verrou posé sur C1
```

```sql
-- === TERMINAL 2 ===
BEGIN;
SELECT * FROM tickets WHERE seat = 'C1' FOR UPDATE NOWAIT;
-- ERREUR IMMÉDIATE : could not obtain lock on row in relation "tickets"
ROLLBACK;
```

```sql
-- === TERMINAL 1 ===
ROLLBACK;
```

> `NOWAIT` est utile quand votre application à un timeout strict ou quand vous préférez retenter immédiatement avec une autre stratégie plutôt que de bloquer le thread.

**Action** : Montrer l'erreur immédiate de NOWAIT dans Terminal 2.

### [10:30-14:00] SKIP LOCKED — Pattern job queue

> `SKIP LOCKED` est une fonctionnalité puissante pour implémenter des files d'attente (job queues) directement en PostgreSQL. Les lignes verrouillées sont simplement ignorées.

**Action** : Démontrer SKIP LOCKED avec un pattern de job queue.

```sql
-- Créer une table de jobs
CREATE TABLE jobs (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    payload     JSONB NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'done', 'failed')),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Insérer des jobs
INSERT INTO jobs (payload) VALUES
    ('{"task": "send_email", "to": "alice@example.com"}'),
    ('{"task": "send_email", "to": "bob@example.com"}'),
    ('{"task": "generate_report", "month": "2025-06"}'),
    ('{"task": "send_email", "to": "charlie@example.com"}'),
    ('{"task": "cleanup", "older_than": "30d"}');
```

```sql
-- === TERMINAL 1 (Worker 1) ===
BEGIN;
SELECT id, payload FROM jobs
WHERE status = 'pending'
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;
-- Récupère le job 1 et le verrouille
-- Les autres workers ne le verront pas

UPDATE jobs SET status = 'processing' WHERE id = 1;
-- ... traitement du job ...
UPDATE jobs SET status = 'done' WHERE id = 1;
COMMIT;
```

```sql
-- === TERMINAL 2 (Worker 2) ===
BEGIN;
SELECT id, payload FROM jobs
WHERE status = 'pending'
ORDER BY created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;
-- Récupère le job 2 (job 1 est verrouillé, donc sauté !)

UPDATE jobs SET status = 'processing' WHERE id = 2;
UPDATE jobs SET status = 'done' WHERE id = 2;
COMMIT;
```

```sql
-- Vérifier l'état des jobs
SELECT * FROM jobs ORDER BY id;
```

> Avec `SKIP LOCKED`, deux workers ne traitent jamais le même job. Pas besoin de Redis ou de RabbitMQ pour des cas simples — PostgreSQL suffit. C'est le pattern "poor man's job queue", mais il est très robuste.

**Action** : Montrer que chaque terminal récupère un job différent grâce à SKIP LOCKED.

### [14:00-16:00] Advisory locks

> Les advisory locks sont des verrous applicatifs — ils ne protègent pas des lignes, mais un concept abstrait identifié par un numéro. C'est utile pour la synchronisation entre processus.

**Action** : Démontrer les advisory locks.

```sql
-- Advisory lock : verrouiller un "concept" (pas une ligne)
-- Utile pour : import de fichier unique, migration de schéma, cron job unique

-- === TERMINAL 1 ===
BEGIN;
-- Tenter d'acquérir un advisory lock (numéro 42)
SELECT pg_try_advisory_lock(42);
-- Résultat : true (lock acquis)

-- Simuler un traitement long
-- (on garde la transaction ouverte)
```

```sql
-- === TERMINAL 2 ===
-- Tenter d'acquérir le même lock
SELECT pg_try_advisory_lock(42);
-- Résultat : false (déjà pris par Terminal 1)

-- Version bloquante (attend la libération)
-- SELECT pg_advisory_lock(42);  -- bloquerait
```

```sql
-- === TERMINAL 1 ===
-- Libérer le lock
SELECT pg_advisory_unlock(42);
-- Résultat : true
COMMIT;
```

```sql
-- Advisory lock au niveau session (pas besoin de transaction)
SELECT pg_advisory_lock(100);
-- Ce lock reste actif jusqu'à un unlock explicite ou la fin de la session
SELECT pg_advisory_unlock(100);
```

> Les advisory locks sont souvent utilisés pour empêcher l'exécution simultanée de cron jobs. Par exemple, un import quotidien qui ne doit tourner que sur un seul serveur.

**Action** : Montrer le `true`/`false` de `pg_try_advisory_lock` dans les deux terminaux.

### [16:00-18:00] Visualisation lock-matrix.html

> Ouvrons la matrice de compatibilité des locks pour comprendre quels locks peuvent coexister.

**Action** : Ouvrir `visualizations/lock-matrix.html` dans le navigateur.

> Cette matrice montre quels types de locks sont compatibles entre eux. Par exemple, ACCESS SHARE (SELECT) est compatible avec tout sauf ACCESS EXCLUSIVE (ALTER TABLE). ROW EXCLUSIVE (UPDATE) est compatible avec ACCESS SHARE mais pas avec SHARE.

**Action** : Parcourir la matrice interactive. Cliquer sur différentes combinaisons pour voir les compatibilités.

### [18:00-19:30] Démo Lab-09

> Le lab 09 vous fait pratiquer les verrous dans des scénarios réalistes.

**Action** : Ouvrir `labs/lab-09-locks-en-action/` et parcourir les exercices.

```sql
-- Aperçu lab-09
-- Exercice 1 : Implémenter une réservation de place avec FOR UPDATE
-- Exercice 2 : Observer les locks avec pg_locks
-- Exercice 3 : Implémenter une job queue avec SKIP LOCKED
-- Exercice 4 : Utiliser les advisory locks pour un singleton
```

**Action** : Montrer les fichiers du lab et les scénarios de test.

### [19:30-20:15] Conclusion

> Les verrous sont le complément de MVCC pour les écritures concurrentes. On a vu FOR UPDATE, NOWAIT, SKIP LOCKED pour les job queues, et les advisory locks. Dans le prochain module, on va voir ce qui se passe quand les verrous se bloquent mutuellement — les deadlocks.

**Action** : Nettoyage.

```sql
DROP TABLE IF EXISTS tickets, jobs;
```

## Points d'attention pour l'enregistrement
- Bien numéroter les terminaux visuellement (Terminal 1, Terminal 2)
- Le timing est crucial : montrer que Terminal 2 est bloqué pendant que Terminal 1 tient le lock
- Laisser le temps de voir le blocage avant de faire le COMMIT
- Tester le scénario SKIP LOCKED minutieusement avant l'enregistrement
- La matrice lock-matrix.html doit être interactive et fonctionnelle
- Garder pg_locks ouvert dans un coin pour observer en temps réel
