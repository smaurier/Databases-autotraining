# Lab 06 — Intervention : ajouter un champ JSONB indexé à une table vivante

> **Outcome :** à la fin, tu sais consolider des colonnes clairsemées en JSONB avec un index
> GIN utile (prouvé par `EXPLAIN`), ET tu sais pourquoi une migration qui "marche" en local
> peut quand même **bloquer toutes les écritures** en prod pendant plusieurs secondes — et
> comment `CREATE INDEX CONCURRENTLY` (et le découpage des transactions) évite ça.
> **Vrai outil :** PostgreSQL 17 (Docker éphémère), deux connexions `pg` réelles — l'une
> exécute la migration, l'autre tente un `INSERT` **pendant ce temps** et chronomètre.
> **Feedback :** `npm run lab` — RED : l'INSERT concurrent met ~2,7 s à passer (bloqué
> jusqu'à la fin de la migration). `npm run solution` — GREEN : le même INSERT passe en
> ~150 ms, migration en cours ou pas.

## Prérequis technique

Docker Desktop doit tourner. L'oracle seed **200 000 posts** (90 % simples, 5 % événements,
5 % épinglés — via les colonnes clairsemées existantes), lance la migration sur une
connexion, et 200 ms après son démarrage, tente un `INSERT` sur une **connexion séparée** en
mesurant son temps de réponse.

## Lire avant (une lecture bornée)

- Module [`13-jsonb-et-types-avances.md`](../../modules/13-jsonb-et-types-avances.md) §1-2 —
  le cas concret exact de ce lab (colonnes clairsemées → JSONB), les opérateurs et l'index
  GIN.
- Module [`09-verrous-et-locks.md`](../../modules/09-verrous-et-locks.md) — un `ALTER TABLE`
  pose un verrou `ACCESS EXCLUSIVE`, gardé jusqu'au `COMMIT` de **sa transaction** — pas
  jusqu'à la fin de l'instruction elle-même.

## Énoncé

PR d'un collègue, prête à merger. Ticket : *« consolider `is_event`/`event_date`/
`event_location`/`is_pinned`/`pinned_by` en une seule colonne `metadata` JSONB, indexée pour
les recherches par type de post. »* `posts` est **en production**, avec du trafic d'écriture
continu. La migration proposée (`migration.sql`) fait tout dans **une seule transaction** :
ajoute la colonne, backfill 200 000 lignes, construit l'index GIN, droppe les anciennes
colonnes — puis `COMMIT`.

Elle s'applique sans erreur. Le problème : elle prend un verrou `ACCESS EXCLUSIVE` dès le
premier `ALTER TABLE`, et **le garde jusqu'au COMMIT final** — donc pendant tout le
backfill ET toute la construction de l'index. N'importe quel `INSERT` sur `posts` pendant ce
temps attend, littéralement, la fin de la migration entière.

Réécris `migration.sql` : même résultat final, mais sans jamais bloquer un `INSERT`
concurrent plus de quelques centaines de millisecondes.

**Le piège à éviter.** Ajouter juste `CONCURRENTLY` au `CREATE INDEX` ne suffit pas si
l'`ALTER TABLE ADD COLUMN` et le gros `UPDATE` de backfill restent dans la MÊME transaction :
le verrou exclusif de l'`ADD COLUMN`, lui, reste posé pendant tout le backfill qui suit,
avant même d'arriver à l'index. Chaque étape qui doit rester rapide (DDL) doit être dans SA
PROPRE transaction, séparée du gros travail (`UPDATE`, `CREATE INDEX CONCURRENTLY`).

## Étapes (en friction)

1. `npm run lab` une première fois : regarde le chiffre de l'INSERT concurrent — plusieurs
   secondes, presque la durée totale de la migration.
2. Découpe `migration.sql` en étapes séparées par un marqueur `-- @step` (le runner de
   l'oracle exécute chaque étape dans un appel séparé — donc sa propre transaction
   implicite) : `ADD COLUMN` seul, `UPDATE` de backfill seul, `CREATE INDEX CONCURRENTLY`
   seul (hors transaction — c'est une contrainte Postgres, pas un choix), `DROP COLUMN`
   seul.
3. Relance : l'INSERT concurrent doit tomber sous 500 ms, quelle que soit la durée totale de
   la migration.

## Vérifier

```bash
cd 10-postgresql/labs/lab-06-jsonb-en-production
npm install
npm run lab
npm run solution
```

**Ce que l'oracle vérifie**

La migration s'applique sans erreur, et est assez lourde (> 1 s) pour que le test de
verrouillage soit significatif ; un `INSERT` concurrent, déclenché pendant que la migration
tourne, ne doit **pas** dépasser 500 ms ; les anciennes colonnes clairsemées ont disparu,
`metadata` existe ; la répartition par type est exacte sur 200 000 lignes (aucune perte) et
des posts précis (un événement, un épinglé) sont vérifiés au champ près ; un index GIN
existe sur `metadata` et la requête `metadata @> '{"type": "pinned"}'` l'utilise réellement
(`EXPLAIN (ANALYZE, FORMAT JSON)` — pas de `Seq Scan`).

## Variante J+30 (fading)

Un nouveau type de post apparaît (`"type": "sondage"` avec des options et des votes). Le
`GIN` existant sert-il encore bien une requête `metadata @> '{"type": "sondage"}'` sans
modification ? Et une requête qui cherche une option précise à l'intérieur du sondage ?

## Application TribuZen

Même migration sur `tribuzen-api`, exécutée un jour de trafic réel, avec le nombre
d'`INSERT` en attente suivi via le dashboard du cours 16 (Observabilité). Commit :
`refactor(posts): metadata JSONB indexée GIN, migration sans verrou bloquant`.
