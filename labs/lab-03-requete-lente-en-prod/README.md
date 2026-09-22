# Lab 03 — Intervention : diagnostiquer et corriger une requête lente en prod

> **Outcome :** à la fin, tu sais lire un `EXPLAIN ANALYZE` **réel** (pas estimé — le temps
> d'exécution vrai), identifier qu'un `Sort` coûte cher, et savoir POURQUOI un index composite
> résout ce qu'un index simple ne résout pas de façon fiable. Le piège du lab : une correction
> qui "a l'air" de marcher sur un jeu de données uniforme peut être fausse sur un jeu de
> données réaliste — tu vas le vivre, pas juste le lire.
> **Vrai outil :** PostgreSQL 17 (Docker éphémère), `EXPLAIN (ANALYZE, FORMAT JSON)` — temps
> mesuré, pas estimé.
> **Feedback :** `npm run lab` — RED tant que `fix.sql` est vide OU que la correction ne
> tient pas la mesure (voir plus bas, le piège). `npm run solution` prouve l'oracle.

## Prérequis technique

Docker Desktop doit tourner. L'oracle applique `schema-existant.sql` (l'état actuel de la
prod — table `posts`, un index déjà là depuis longtemps), seed **300 000 lignes** avec une
distribution volontairement **non uniforme**, mesure avant/après.

## Lire avant (une lecture bornée)

- Module [`06-query-planner.md`](../../modules/06-query-planner.md) §2 — `EXPLAIN` vs
  `EXPLAIN ANALYZE` : le premier estime, le second **exécute et mesure**.
- Module [`07-index-avances.md`](../../modules/07-index-avances.md) §2 — index composites,
  ordre des colonnes, pourquoi `(a, b)` sert `WHERE a = ?` seul mais pas `WHERE b = ?` seul.
- Module [`11-performances-et-optimisation.md`](../../modules/11-performances-et-optimisation.md) §2 — diagnostiquer une requête lente en production, méthodiquement.

## Énoncé

Ticket : *« le fil d'une famille met plus d'une milliseconde... non, plus d'une SECONDE à
charger en prod, sur les grosses familles. »* La requête : `SELECT * FROM posts WHERE
family_id = $1 ORDER BY created_at DESC LIMIT 20`. Un index existe déjà sur `family_id`
seul — il trouve les bonnes lignes, mais Postgres doit ensuite les **trier** (`Sort`) pour
satisfaire `ORDER BY`, et ce tri coûte cher sur une famille à 6 000 posts.

Écris `fix.sql` : un index qui élimine le `Sort`.

**Le piège, explicitement.** Un index sur `created_at` seul semble aussi résoudre le problème
— Postgres peut parcourir l'index en sens inverse et filtrer au passage, sans `Sort` visible
dans le plan. Mais ce lab seed une famille qui n'a **pas posté depuis un an**, au milieu de
familles très actives cette semaine. Avec un index sur `created_at` seul, retrouver les 20
vieux posts de cette famille oblige à parcourir des dizaines de milliers de posts récents
**des autres familles** avant de tomber dessus — mesuré dans ce lab : **~48 ms**, pire que
le point de départ. Un index composite `(family_id, created_at DESC)` n'a jamais ce problème :
il trouve la famille en premier, dans l'ordre, toujours.

## Étapes (en friction)

1. `npm run lab` une première fois : regarde le temps « avant correction » affiché.
2. Écris `fix.sql` : supprime l'ancien index (`DROP INDEX idx_posts_family_id` — il devient
   redondant), crée `CREATE INDEX ... ON posts (family_id, created_at DESC)`.
3. Relance. Regarde le temps « après correction » — pas juste le statut GREEN/RED, le
   **chiffre**.
4. Si tu es tenté par un index sur `created_at` seul : essaie-le, regarde ce que l'oracle en
   dit, comprends pourquoi avant de revenir au composite.

## Vérifier

```bash
cd 10-postgresql/labs/lab-03-requete-lente-en-prod
npm install
npm run lab
npm run solution
```

**Ce que l'oracle vérifie**

`fix.sql` s'applique sans erreur ; le nombre de posts n'a pas changé (pas de perte de
données) ; le plan **après** correction ne contient plus de nœud `Sort` ; la requête est
**au moins 5 fois plus rapide** qu'avant (mesuré en millisecondes réelles, pas en coût
estimé) — ce dernier critère est celui qui démasque le piège de l'index simple.

## Variante J+30 (fading)

Le produit ajoute un filtre `WHERE family_id = $1 AND author_id = $2 ORDER BY created_at
DESC LIMIT 20` (les posts d'un membre précis dans sa famille). L'index `(family_id,
created_at DESC)` sert-il encore bien ? Mesure avant de répondre.

## Application TribuZen

Même diagnostic et même correction sur `tribuzen-api`, avec un vrai outil de monitoring
(cours 16 Observabilité) qui aurait signalé la requête lente avant le ticket utilisateur.
Commit : `perf(posts): index composite (family_id, created_at) — Sort éliminé, ×39 mesuré`.
