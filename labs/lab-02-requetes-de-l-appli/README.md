# Lab 02 — Les requêtes réelles de TribuZen, en SQL brut, avant l'ORM

> **Outcome :** à la fin, tu sais écrire les requêtes qu'une vraie app envoie à Postgres —
> une transaction atomique, une pagination correcte, une recherche texte **qui résiste à
> l'injection**, une agrégation avec `LEFT JOIN`. Le cours 03 (NestJS) te fera ensuite
> découvrir Prisma/TypeORM : tu sauras alors exactement ce qu'ils génèrent à ta place, et
> pourquoi.
> **Vrai outil :** PostgreSQL 17 (Docker éphémère), `pg` (client Node natif, sans ORM).
> **Feedback :** `npm run lab` — RED tant que `queries.mjs` est vide. `npm run solution`
> prouve l'oracle.

## Prérequis technique

Docker Desktop doit tourner. L'oracle applique le schéma du lab 01 (`schema.sql`, donné,
identique à sa solution), démarre/détruit un conteneur `postgres:17` à chaque run.

## Lire avant (une lecture bornée)

- Module [`02-crud-et-requetes.md`](../../modules/02-crud-et-requetes.md) §2 — `INSERT ...
  RETURNING`, requêtes paramétrées (`$1`, `$2`…), pourquoi ne JAMAIS concaténer une valeur
  utilisateur dans du SQL.
- Module [`04-transactions-et-acid.md`](../../modules/04-transactions-et-acid.md) §2 —
  `BEGIN`/`COMMIT`/`ROLLBACK`, atomicité : soit tout arrive, soit rien.
- Module [`03-relations-et-jointures.md`](../../modules/03-relations-et-jointures.md) §2 —
  `LEFT JOIN` vs `INNER JOIN` (une ligne sans correspondance survit ou disparaît).

## Énoncé

Écris `queries.mjs`, quatre fonctions :

- `createFamilyWithAdmin(client, { name, email })` — crée une famille **et** son premier
  membre admin, **dans une seule transaction**. Si la création du membre échoue, la famille
  ne doit **jamais** survivre seule en base.
- `listMembers(client, familyId, { limit, offset })` — pagination réelle, `limit`/`offset`
  en paramètres liés.
- `searchFamilies(client, query)` — recherche par nom, insensible à la casse (`ILIKE`),
  `query` en paramètre lié — jamais interpolé dans la chaîne SQL.
- `familyMemberCounts(client)` — le nombre de membres par famille, **y compris les familles
  à zéro membre** (`LEFT JOIN`, pas `INNER JOIN`).

## Étapes (en friction)

1. `createFamilyWithAdmin` — `BEGIN`, deux `INSERT ... RETURNING`, `COMMIT` ; `catch` +
   `ROLLBACK` + relance l'erreur.
2. `listMembers` — un `SELECT` avec trois paramètres liés (`$1`, `$2`, `$3`).
3. `searchFamilies` — `ILIKE '%' || $1 || '%'` (jamais de template string autour de `$1`).
4. `familyMemberCounts` — `LEFT JOIN` + `GROUP BY` + `count()`.
5. `npm run lab` — sept vérifications, dans l'ordre où les fonctions apparaissent ci-dessus.

## Vérifier

```bash
cd 10-postgresql/labs/lab-02-requetes-de-l-appli
npm install
npm run lab
npm run solution
```

**Ce que l'oracle vérifie**

`createFamilyWithAdmin` : cas nominal (famille + admin créés) ; **atomicité réelle** — un
`email` `NULL` fait échouer l'insertion du membre (violation `NOT NULL`), et l'oracle vérifie
que le **nombre de familles n'a pas changé** (pas de famille orpheline). `listMembers` :
deux pages sans chevauchement. `searchFamilies` : insensible à la casse, **et** une tentative
d'injection (`x'; DROP TABLE families; --`) ne doit ni planter la fonction ni faire disparaître
la table — l'oracle vérifie que `families` existe toujours après l'appel.
`familyMemberCounts` : une famille à 0 membre apparaît quand même, tri décroissant.

## Variante J+30 (fading)

Ajoute `renameFamily(client, familyId, newName)`, avec une contrainte : si `newName` est vide
ou ne contient que des espaces, la fonction doit lever une erreur **avant** d'toucher la base
(pas de requête inutile). Écris le test qui le prouve avant d'écrire la fonction.

## Application TribuZen

Les mêmes requêtes, presque mot pour mot, vivront dans `tribuzen-api/src/families/families.repository.ts`
au cours 03 — sauf qu'elles utiliseront alors le client Prisma généré. Compare les deux versions
quand tu y arriveras : c'est le meilleur moyen de comprendre ce qu'un ORM automatise vraiment.
Commit : `feat(db): requêtes TribuZen en SQL brut — transaction, pagination, recherche, agrégat`.
