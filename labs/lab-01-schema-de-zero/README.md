# Lab 01 — Un schéma PostgreSQL de zéro, avec un index qu'on PROUVE, pas qu'on suppose

> **Outcome :** à la fin, tu as construit un schéma complet — tables, contraintes réellement
> appliquées par la base (pas juste validées côté app), et un index dont tu as **prouvé**
> l'utilité avec `EXPLAIN`, sur un vrai volume de données (100 000 lignes). Pas de mock, pas
> de simulation : un vrai PostgreSQL 17 tourne dans Docker le temps du test.
> **Vrai outil :** PostgreSQL **17**, `pg` (client Node natif), Docker (conteneur éphémère,
> détruit à la fin de chaque run).
> **Feedback :** `npm run lab` (depuis ce dossier) — RED tant que `migrations/001_init.sql`
> est vide. `npm run solution` prouve l'oracle sur la référence.

## Prérequis technique

Docker Desktop doit tourner (`docker ps` doit répondre). L'oracle démarre un conteneur
`postgres:17` sur le port `55491`, le détruit à la fin — rien ne persiste entre deux runs,
rien n'entre en conflit avec une éventuelle vraie base sur ta machine.

## Lire avant (une lecture bornée)

- Module [`01-modele-relationnel.md`](../../modules/01-modele-relationnel.md) — contraintes
  `NOT NULL`, `CHECK`, `UNIQUE`, `FOREIGN KEY`, et pourquoi elles vivent dans la base, pas
  seulement dans le code applicatif.
- Module [`05-index-fondamentaux.md`](../../modules/05-index-fondamentaux.md) §2 — ce qu'un
  index B-tree accélère (et ce qu'il n'accélère pas).
- Module [`06-query-planner.md`](../../modules/06-query-planner.md) §2 — lire un plan
  `EXPLAIN` : `Seq Scan` (parcours complet) vs `Index Scan` (parcours d'index), `Sort`
  (tri en mémoire/disque), coût estimé.

## Énoncé

Écris `migrations/001_init.sql` : deux tables (`families`, `members`), les contraintes
exactes listées dans le fichier starter, et **un index** sur `members(created_at)`.

Pourquoi cet index précisément : l'app affiche un fil « membres récemment arrivés, toutes
familles confondues » — `ORDER BY created_at DESC LIMIT 20`. Sur une table de 100 000 lignes,
sans index, Postgres doit **tout lire et tout trier** à chaque appel (`Seq Scan` + `Sort`,
coût ~11 000 dans ce lab). Avec l'index, un simple parcours en sens inverse suffit (`Index
Scan Backward`, coût < 1). L'oracle ne suppose pas cette différence : il seed réellement
100 000 lignes et lance `EXPLAIN (FORMAT JSON)` pour de vrai.

## Étapes (en friction)

1. `CREATE TABLE families` avec les 3 colonnes exigées.
2. `CREATE TABLE members` avec les 5 colonnes, la `CHECK` sur `role`, la `FOREIGN KEY` vers
   `families`, et l'`UNIQUE (family_id, email)` — composite, pas sur `email` seul.
3. `CREATE INDEX idx_members_created_at ON members (created_at)`.
4. `npm run lab` — lis l'étape qui échoue (l'oracle te dit précisément laquelle : colonnes,
   contraintes, ou `EXPLAIN`), corrige, relance.

## Vérifier

```bash
cd 10-postgresql/labs/lab-01-schema-de-zero
npm install
npm run lab
npm run solution   # prouve l'oracle sur la référence
```

**Ce que l'oracle vérifie, dans l'ordre**

1. La migration s'applique sans erreur SQL.
2. Les 8 colonnes attendues existent (`families` × 3, `members` × 5).
3. Un `role` hors énumération est **réellement rejeté** par Postgres (pas par un DTO — il n'y
   en a pas ici, c'est la base elle-même qui protège).
4. Un email en double **dans la même famille** est réellement rejeté.
5. 100 000 lignes sont seedées avec succès (la migration doit donc être compatible avec un
   vrai volume, pas juste un exemple jouet).
6. `EXPLAIN` sur la requête des membres récents ne montre **aucun** `Seq Scan`, et montre un
   `Index Scan` sur `idx_members_created_at`.

## Variante J+30 (fading)

L'app ajoute un filtre : « membres récents d'UNE famille précise » (`WHERE family_id = $1
ORDER BY created_at DESC LIMIT 20`). Un index composite `(family_id, created_at)` sert-il
mieux que les deux index séparés ? Écris les deux versions, lance `EXPLAIN` sur chacune, et
tranche avec les chiffres — pas avec ton intuition.

## Application TribuZen

`tribuzen-api/migrations/001_init.sql`, consommé par le cours 03 NestJS (Prisma/TypeORM
génèrera ses propres migrations, mais sur CE schéma). Commit :
`feat(db): schéma families/members — contraintes réelles, index prouvé par EXPLAIN`.
