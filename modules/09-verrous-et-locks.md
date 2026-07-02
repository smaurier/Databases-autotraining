---
titre: Verrous et locks
cours: 10-postgresql
notions: [verrous de ligne FOR UPDATE et FOR SHARE, verrous de table et modes de lock, LOCK explicite, advisory locks, SELECT FOR UPDATE SKIP LOCKED, NOWAIT, observer les locks avec pg_locks, contention]
outcomes: [poser un verrou de ligne pour une mise à jour sûre, utiliser SKIP LOCKED pour une file de tâches, diagnostiquer une contention avec pg_locks, choisir le bon mode de lock]
prerequis: [08-niveaux-isolation]
next: 10-deadlocks
libs: [{ name: postgresql, version: "17" }]
tribuzen: verrou sur une ressource à quota limité de TribuZen (réservation d'une place)
last-reviewed: 2026-07
---

# Verrous et locks

> **Outcomes — tu sauras FAIRE :** poser un verrou de ligne `FOR UPDATE` pour sécuriser une réservation, utiliser `SKIP LOCKED` pour une file de tâches sans contention, diagnostiquer un blocage en live avec `pg_locks`, choisir le bon mode de lock selon le cas d'usage.
> **Difficulté :** :star::star::star:

## 1. Cas concret d'abord

Dans TribuZen, un événement famille ("Pique-nique Martin") n'a plus **qu'une seule place**. Deux membres ouvrent l'app en même temps et cliquent sur "Réserver". Sans verrou, les deux transactions lisent `places_restantes = 1`, valident la garde (`> 0`), et décrémentent toutes les deux. Résultat : `places_restantes = -1`. Surbooking silencieux, aucune erreur levée.

```sql
-- Sans verrou : MVCC donne le même snapshot aux deux sessions → lost update
SELECT places_restantes FROM evenements WHERE id = 1; -- Session A : voit 1
SELECT places_restantes FROM evenements WHERE id = 1; -- Session B : voit aussi 1
UPDATE evenements SET places_restantes = places_restantes - 1 WHERE id = 1; -- A : 1→0
UPDATE evenements SET places_restantes = places_restantes - 1 WHERE id = 1; -- B : 0→-1
-- Résultat : deux réservations créées pour une seule place.
```

La solution : `SELECT … FOR UPDATE`. La première session acquiert un verrou exclusif sur la ligne **avant** de lire la valeur. La seconde attend que la première commite, puis lit la valeur après mise à jour — elle voit `places_restantes = 0` et annule.

```sql
-- Avec FOR UPDATE : atomique, pas de race condition
BEGIN;
SELECT places_restantes FROM evenements WHERE id = 1 FOR UPDATE;
-- places_restantes = 1 → verrou exclusif acquis ; Session B BLOQUÉE jusqu'au COMMIT
UPDATE evenements SET places_restantes = places_restantes - 1 WHERE id = 1;
INSERT INTO reservations (evenement_id, membre_id) VALUES (1, 'u-7');
COMMIT;
-- Verrou libéré. Session B se débloque, lit places_restantes = 0. Elle doit ROLLBACK.
```

La suite couvre tous les modes de row lock, les table locks, les advisory locks, `SKIP LOCKED` et `NOWAIT`, et comment observer tout ça en direct dans `pg_locks`.

## 2. Théorie complète, concise

### Row-level locks — 4 modes

PostgreSQL pose un verrou de ligne automatiquement sur chaque `UPDATE`/`DELETE`, et manuellement via `SELECT … FOR …`. Quatre modes du plus léger au plus exclusif :

| Mode | Posé par | Bloque | Cas d'usage |
|------|----------|--------|-------------|
| `FOR KEY SHARE` | vérification FK interne | Seulement `FOR UPDATE` sur PK | Check de clé étrangère |
| `FOR SHARE` | `SELECT FOR SHARE` | `FOR UPDATE`, `FOR NO KEY UPDATE` | Lecture protégée — ligne ne sera pas supprimée |
| `FOR NO KEY UPDATE` | `UPDATE` sans toucher PK/UNIQUE | `FOR SHARE`, `FOR UPDATE` | Modification sans impacter les FK |
| `FOR UPDATE` | `SELECT FOR UPDATE`, `DELETE` | Tout sauf `FOR KEY SHARE` | Modification ou suppression imminente |

**Pas de lock escalation.** Les row locks sont stockés dans les tuples (`xmax`), pas en mémoire partagée. PostgreSQL ne remplace jamais des row locks par un table lock — contrairement à SQL Server ou MySQL. Dix millions de row locks restent dix millions de row locks.

### NOWAIT et SKIP LOCKED

`SELECT … FOR UPDATE` attend indéfiniment si la ligne est verrouillée. Deux modificateurs changent ce comportement :

- **`NOWAIT`** : échoue immédiatement avec `ERROR 55P03 lock_not_available`.
- **`SKIP LOCKED`** : ignore silencieusement les lignes verrouillées, retourne seulement les libres.

```sql
-- NOWAIT : erreur immédiate
SELECT places_restantes FROM evenements WHERE id = 1 FOR UPDATE NOWAIT;
-- → ERROR: could not obtain lock on row in relation "evenements"  (55P03)

-- SKIP LOCKED : prendre les notifications disponibles sans attendre
SELECT id, membre_id, contenu FROM notifications
WHERE statut = 'pending'
ORDER BY id
LIMIT 5
FOR UPDATE SKIP LOCKED;
-- Retourne jusqu'à 5 lignes non verrouillées. Zéro attente.
```

Variante avec délai configurable :

```sql
SET lock_timeout = '3s'; -- Attendre max 3 s avant erreur 55P03
```

### Table-level locks — 8 modes

Chaque statement acquiert aussi un **table lock** pour signaler son intention. Du plus permissif au plus exclusif :

| Niveau | Acquis automatiquement par | Bloque |
|--------|---------------------------|--------|
| `ACCESS SHARE` | `SELECT` | Seulement `ACCESS EXCLUSIVE` |
| `ROW SHARE` | `SELECT FOR UPDATE/SHARE` | `EXCLUSIVE`, `ACCESS EXCLUSIVE` |
| `ROW EXCLUSIVE` | `INSERT`, `UPDATE`, `DELETE` | `SHARE` et plus lourds |
| `SHARE UPDATE EXCLUSIVE` | `VACUUM`, `ANALYZE`, `CREATE INDEX CONCURRENTLY` | Lui-même et plus lourds |
| `SHARE` | `CREATE INDEX` (non-concurrent) | `ROW EXCLUSIVE` et plus lourds |
| `SHARE ROW EXCLUSIVE` | `CREATE TRIGGER` | `ROW EXCLUSIVE` et plus lourds |
| `EXCLUSIVE` | `REFRESH MATERIALIZED VIEW CONCURRENTLY` | `ROW SHARE` et plus lourds |
| `ACCESS EXCLUSIVE` | `ALTER TABLE`, `DROP TABLE`, `VACUUM FULL` | **Tout** — bloque même les `SELECT` |

`ALTER TABLE … ADD COLUMN` acquiert `ACCESS EXCLUSIVE` : sur une grande table, cela peut bloquer tous les `SELECT` pendant plusieurs minutes. Préférer `ADD COLUMN … DEFAULT expr` (PostgreSQL 11+ : instantané si valeur constante) ou `CREATE INDEX CONCURRENTLY`.

### LOCK TABLE — verrou explicite

Utile pour des opérations de maintenance qui exigent une vue cohérente sur plusieurs tables. **Par défaut `LOCK TABLE` pose `ACCESS EXCLUSIVE`** — toujours préciser le mode :

```sql
-- DANGEREUX : ACCESS EXCLUSIVE par défaut, bloque tout y compris SELECT
LOCK TABLE evenements; -- à éviter sans besoin précis

-- Correct : bloquer seulement les écritures
BEGIN;
LOCK TABLE evenements IN SHARE MODE;
SELECT id, places_restantes FROM evenements; -- lecture cohérente, personne ne peut modifier
COMMIT;
```

### Advisory locks

Les advisory locks sont des verrous applicatifs portant une clé numérique définie par l'application, sans lien avec une table ou une ligne. Utiles pour du mutex applicatif (un seul process traite une entité à la fois).

| Fonction | Scope | Bloquant | Libération |
|----------|-------|----------|------------|
| `pg_advisory_lock(key)` | Session | Oui | `pg_advisory_unlock(key)` ou fin de session |
| `pg_try_advisory_lock(key)` | Session | Non — retourne bool | Idem |
| `pg_advisory_xact_lock(key)` | Transaction | Oui | Automatique au `COMMIT`/`ROLLBACK` |
| `pg_try_advisory_xact_lock(key)` | Transaction | Non — retourne bool | Automatique |

```sql
-- Mutex : un seul cron génère le récapitulatif de l'événement 1 à la fois
BEGIN;
SELECT pg_advisory_xact_lock(1); -- bloquant : attend si un autre process tient la clé 1
-- ... opérations sur l'événement 1 ...
COMMIT; -- lock libéré automatiquement

-- Non-bloquant : tenter sans attendre
BEGIN;
SELECT pg_try_advisory_xact_lock(1) AS acquired; -- false si déjà pris → skip
-- Si acquired = false → ROLLBACK, log, retry
COMMIT;
```

### Observer les locks avec pg_locks

La vue système `pg_locks` liste tous les verrous actifs sur l'instance.

```sql
-- Locks actifs avec contexte
SELECT
    l.locktype,
    l.relation::regclass AS table_name,
    l.mode,
    l.granted,
    l.pid,
    left(a.query, 60) AS query,
    age(now(), a.query_start) AS duree
FROM pg_locks l
JOIN pg_stat_activity a ON l.pid = a.pid
WHERE l.relation IS NOT NULL
  AND a.datname = current_database()
ORDER BY l.granted DESC, a.query_start;
```

```sql
-- Qui bloque qui ? (PostgreSQL 9.6+)
SELECT
    blocked.pid          AS pid_bloque,
    left(blocked.query, 50) AS requete_bloquee,
    blocking.pid         AS pid_bloquant,
    left(blocking.query, 50) AS requete_bloquante,
    age(now(), blocked.query_start) AS bloque_depuis
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking
    ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0;
```

`granted = false` dans `pg_locks` = verrou **en attente** (session bloquée). `pg_blocking_pids(pid)` retourne directement la liste des PIDs bloquants — la forme la plus simple pour diagnostiquer une contention.

## 3. Worked examples

### Exemple A — Réservation de place TribuZen avec FOR UPDATE

Objectif : une seule réservation créée pour la dernière place, même sous concurrence.

```sql
-- Schéma
CREATE TABLE evenements (
    id               SERIAL PRIMARY KEY,
    titre            TEXT NOT NULL,
    places_totales   INT NOT NULL,
    places_restantes INT NOT NULL CHECK (places_restantes >= 0)
);

CREATE TABLE reservations (
    id            SERIAL PRIMARY KEY,
    evenement_id  INT NOT NULL REFERENCES evenements(id),
    membre_id     TEXT NOT NULL,
    reservee_le   TIMESTAMPTZ DEFAULT now()
);

INSERT INTO evenements (titre, places_totales, places_restantes)
VALUES ('Pique-nique Martin', 8, 1);
```

```sql
-- Session A : réservation avec verrou
BEGIN;

SELECT places_restantes
FROM evenements
WHERE id = 1
FOR UPDATE;
-- → places_restantes = 1 ; verrou exclusif acquis.
-- Session B qui tente le même SELECT FOR UPDATE est BLOQUÉE jusqu'au COMMIT de A.

UPDATE evenements
SET places_restantes = places_restantes - 1
WHERE id = 1;

INSERT INTO reservations (evenement_id, membre_id)
VALUES (1, 'u-7');

COMMIT;
-- Session B se débloque. Elle lit places_restantes = 0. Elle doit ROLLBACK.
```

Pas-à-pas : (1) `FOR UPDATE` verrouille la ligne **atomiquement avec la lecture** — pas de fenêtre entre "lire" et "verrouiller" comme dans un `SELECT` suivi d'un `UPDATE` séparé ; (2) Session B attend le `COMMIT` de A, puis lit `places_restantes = 0` — la contrainte `CHECK` bloquerait un décrément supplémentaire, mais la garde métier doit l'anticiper pour renvoyer un message clair ; (3) une seule réservation est créée, zéro surbooking, zéro erreur de sérialisation.

### Exemple B — SKIP LOCKED pour les notifications TribuZen

Objectif : plusieurs workers envoient des notifications en parallèle sans doublon ni blocage.

```sql
-- Table de notifications
CREATE TABLE notifications (
    id         SERIAL PRIMARY KEY,
    membre_id  TEXT NOT NULL,
    contenu    TEXT NOT NULL,
    statut     TEXT NOT NULL DEFAULT 'pending'
);

INSERT INTO notifications (membre_id, contenu)
SELECT 'u-' || i, 'Rappel : événement demain'
FROM generate_series(1, 20) i;
```

```sql
-- Worker 1 : prendre et marquer atomiquement un batch de 5 notifications
BEGIN;

WITH batch AS (
    SELECT id
    FROM notifications
    WHERE statut = 'pending'
    ORDER BY id
    LIMIT 5
    FOR UPDATE SKIP LOCKED
)
UPDATE notifications
SET statut = 'en_cours'
FROM batch
WHERE notifications.id = batch.id
RETURNING notifications.id, notifications.membre_id, notifications.contenu;
-- → ids 1,2,3,4,5 — verrouillés et passés à 'en_cours' atomiquement
-- (Worker 1 traite ses notifications ; ne COMMIT pas encore)

-- Worker 2 (simultané) — même requête exacte :
-- → ids 6,7,8,9,10 (les 5 de Worker 1 sont verrouillés → skippés)
-- Aucune attente, aucun doublon.

COMMIT; -- Worker 1
-- 10 notifications traitées en parallèle.
```

Pas-à-pas : (1) `SKIP LOCKED` ne bloque jamais — une ligne verrouillée est ignorée silencieusement ; (2) le CTE `WITH … AS (SELECT … FOR UPDATE SKIP LOCKED)` suivi d'un `UPDATE … FROM` est le pattern "sélectionner + marquer" en une seule requête atomique — pas de second `SELECT` ; (3) `RETURNING` donne directement les données à traiter ; (4) chaque worker traite son propre lot en totale indépendance.

## 4. Pièges & misconceptions

- **`SELECT` puis `UPDATE` sans `FOR UPDATE` = lost update.** Lire une valeur et décider d'agir dessus sans verrou laisse une fenêtre pendant laquelle une autre session modifie la même ligne. *Correct* : toujours `SELECT … FOR UPDATE` quand la logique dépend de la valeur lue avant d'écrire.

- **`LOCK TABLE` sans mode = `ACCESS EXCLUSIVE`.** Le défaut bloque **tout**, y compris les `SELECT`. C'est rarement l'intention. *Correct* : toujours écrire `LOCK TABLE t IN SHARE MODE` (ou le mode adapté) — jamais `LOCK TABLE t` tout court en production.

- **`NOWAIT` et `lock_timeout` ne sont pas interchangeables.** `NOWAIT` échoue immédiatement ; `lock_timeout` laisse patienter N secondes avant d'échouer. *Correct* : `NOWAIT` pour les APIs temps réel (réponse immédiate à l'utilisateur — intercepter `SQLSTATE 55P03`) ; `lock_timeout` pour les traitements batch qui peuvent attendre quelques secondes.

- **`SKIP LOCKED` n'est pas un filtre métier.** Il saute des lignes selon leur état de verrouillage au moment de l'exécution. Une ligne skippée n'est pas perdue — elle sera disponible au prochain passage du worker. *Correct* : réserver `SKIP LOCKED` au dispatch de work items, jamais à une logique de filtrage fonctionnel.

- **Advisory locks sans enforcement.** Un process qui n'appelle pas `pg_advisory_xact_lock` n'est pas bloqué. Les advisory locks sont purement conventionnels. *Correct* : ils ne remplacent pas les row locks — ils servent de mutex applicatif pour des ressources qui n'ont pas de ligne dans la base (cron, batch, singleton).

- **Transaction `idle in transaction` qui tient un lock.** Une session qui ouvre `BEGIN`, pose un `FOR UPDATE`, puis reste en attente (I/O externe, pause utilisateur) maintient le verrou et bloque toutes les sessions concurrentes sur cette ligne indéfiniment. *Correct* : configurer `idle_in_transaction_session_timeout` (ex. `60s`) ; ne placer aucune I/O externe dans une transaction.

- **`pg_locks` sans jointure sur `pg_stat_activity` = OIDs illisibles.** La colonne `relation` est un OID ; `pid` seul ne dit pas quelle requête est en cause. *Correct* : toujours joindre `pg_stat_activity` et caster `relation::regclass` pour voir le nom de la table et la requête.

## 5. Ancrage TribuZen

Couche fil-rouge : **verrou sur une ressource à quota limité** dans `smaurier/tribuzen` — la réservation de place dans un événement famille.

- Le cas du pique-nique (Exemple A) reproduit le scénario de production exact : une famille avec plusieurs membres sur des appareils différents, tous notifiés simultanément qu'il reste une place. `FOR UPDATE` est la seule garantie d'atomicité entre la lecture du quota et l'écriture de la réservation.
- La contrainte `CHECK (places_restantes >= 0)` est un filet de sécurité complémentaire au verrou : même si un bug applicatif oublie la garde métier, la base refuse le décrément.
- Les notifications TribuZen (Exemple B) illustrent `SKIP LOCKED` : plusieurs instances du service notification envoient des pushes en parallèle — `SKIP LOCKED` garantit qu'une notification n'est jamais traitée deux fois sans sérialiser les workers.
- En production, les advisory locks servent à s'assurer qu'un seul cron (récapitulatif hebdomadaire famille) tourne à la fois, même en déploiement multi-instances.
- En session, les deux exemples s'exécutent sur la base Docker locale TribuZen avec deux terminaux `psql` — les blocages et timings sont réels, pas simulés.

## 6. Points clés

1. `SELECT … FOR UPDATE` verrouille la ligne atomiquement avec la lecture — pas de fenêtre entre "lire" et "verrouiller". Indispensable pour tout pattern check-then-act.
2. Quatre modes de row lock du plus léger au plus exclusif : `FOR KEY SHARE` → `FOR SHARE` → `FOR NO KEY UPDATE` → `FOR UPDATE`. PostgreSQL ne fait jamais de lock escalation.
3. `NOWAIT` : erreur immédiate (55P03) si verrou impossible ; `SKIP LOCKED` : ignore les lignes verrouillées sans erreur ni attente — les deux évitent l'attente, mais pour des cas différents.
4. Table locks : 8 modes de `ACCESS SHARE` (`SELECT`) à `ACCESS EXCLUSIVE` (`ALTER TABLE` — bloque tout). `LOCK TABLE` sans mode = `ACCESS EXCLUSIVE` : toujours spécifier le mode.
5. Advisory locks : verrou numérique applicatif, scope session ou transaction, bloquant ou non-bloquant (`pg_try_advisory_*`). Purement conventionnel — à combiner avec les row locks, pas à les remplacer.
6. `pg_locks` + jointure `pg_stat_activity` + cast `::regclass` : observer tous les locks en live. `granted = false` = en attente. `pg_blocking_pids(pid)` : raccourci pour identifier le bloquant.
7. Transaction `idle in transaction` + row lock = blocage indéfini en production. Configurer `idle_in_transaction_session_timeout`. Ne mettre aucune I/O externe dans une transaction.
8. Bon outil selon le scénario : réservation → `FOR UPDATE` ; file de tâches → `SKIP LOCKED` ; rapport cohérent multi-tables → `LOCK TABLE … IN SHARE MODE` ; mutex applicatif → advisory lock.

## 7. Seeds Anki

```
Quelle différence entre SELECT FOR UPDATE et SELECT FOR SHARE ?|FOR UPDATE est exclusif — bloque tout autre FOR UPDATE/FOR SHARE sur la ligne ; FOR SHARE est partagé — plusieurs lectures FOR SHARE coexistent mais bloquent FOR UPDATE
Que fait SELECT FOR UPDATE SKIP LOCKED ?|Retourne uniquement les lignes non verrouillées en ignorant silencieusement les lignes déjà verrouillées — idéal pour une file de tâches traitée par plusieurs workers en parallèle
Quel est le SQLSTATE d'un NOWAIT sur une ligne verrouillée ?|55P03 (lock_not_available) — ERROR: could not obtain lock on row in relation
Quel mode de lock acquiert LOCK TABLE sans préciser le mode ?|ACCESS EXCLUSIVE — bloque tout, y compris les SELECT. Toujours écrire LOCK TABLE t IN MODE MODE explicitement
À quoi servent les advisory locks ?|Mutex applicatif défini par clé numérique — un seul processus exécute un traitement à la fois (cron, batch, singleton) sans lier le verrou à une ligne ou une table
Différence pg_advisory_lock et pg_advisory_xact_lock ?|Session lock — libération manuelle via pg_advisory_unlock ou fin de session ; transaction lock — libération automatique au COMMIT/ROLLBACK. Préférer xact_lock pour éviter les fuites
Comment trouver qui bloque qui sans analyser pg_locks manuellement ?|SELECT pid, query, pg_blocking_pids(pid) FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0 — retourne les PIDs bloquants pour chaque session bloquée
Pourquoi PostgreSQL ne fait-il jamais de lock escalation ?|Les row locks sont stockés dans les tuples (xmax), pas en mémoire partagée — pas de limite de nombre, donc pas besoin d'escalader en table lock, contrairement à SQL Server ou MySQL
Quel piège avec une transaction idle in transaction qui tient un FOR UPDATE ?|Elle maintient le verrou indéfiniment — toutes les sessions concurrentes sur cette ligne sont bloquées. Corriger avec idle_in_transaction_session_timeout et aucune I/O externe dans la transaction
```

## Pont vers le lab

> Lab associé : `10-postgresql/labs/lab-09-locks-en-action/`. Tu reproduis en deux sessions psql le blocage sur la réservation de place TribuZen, tu observes `pg_locks` en live, tu testes `NOWAIT` et `SKIP LOCKED` sur une file de notifications, et tu poses un advisory lock sur un événement. Corrigé SQL inline dans le README, aucun fichier séparé.
