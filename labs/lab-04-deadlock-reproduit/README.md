# Lab 04 — Intervention : reproduire et corriger un vrai deadlock

> **Outcome :** à la fin, tu as vu un **vrai deadlock PostgreSQL** se produire (code erreur
> `40P01`), pas une description dans un cours — et tu sais pourquoi la seule correction
> fiable est de toujours verrouiller dans le **même ordre**, jamais d'ajouter un retry ou un
> timeout en pansement.
> **Vrai outil :** PostgreSQL 17 (Docker éphémère), deux connexions `pg` concurrentes réelles.
> **Feedback :** `npm run lab` — GREEN si un vrai deadlock est détecté sur le code non
> corrigé (c'est le comportement ATTENDU du starter). `npm run solution` — GREEN si aucun
> deadlock ne se produit sur la référence corrigée.

## Prérequis technique

Docker Desktop doit tourner. L'oracle démarre un conteneur `postgres:17` éphémère, applique
`schema.sql`, seed une famille avec deux membres, puis lance **deux clients `pg` distincts en
parallèle** (`Promise.allSettled`) qui appellent `updateMemberPair` avec les **mêmes deux ids,
mais dans l'ordre inverse** — la condition exacte qui crée un verrou circulaire.

## Lire avant (une lecture bornée)

- Module [`09-verrous-et-locks.md`](../../modules/09-verrous-et-locks.md) — ce qu'un `UPDATE`
  verrouille réellement, et jusqu'à quand (jusqu'au `COMMIT`/`ROLLBACK`, pas jusqu'à la fin
  de la requête).
- Module [`10-deadlocks.md`](../../modules/10-deadlocks.md) — verrou circulaire, comment
  Postgres le détecte (`deadlock_detected`, code `40P01`), et pourquoi il annule
  **une seule** des deux transactions (l'autre continue normalement).

## Énoncé

Ticket : *« deux mises à jour simultanées de deux membres provoquent parfois une erreur
"deadlock detected" côté serveur. »* Le code en cause, `updatePair.mjs`, est déjà en
production :

```js
export async function updateMemberPair(client, idA, idB, bio) {
  await client.query("BEGIN");
  await client.query("UPDATE members SET bio = $2 WHERE id = $1", [idA, bio]);
  await client.query("SELECT pg_sleep(0.3)");           // le vrai traitement métier
  await client.query("UPDATE members SET bio = $2 WHERE id = $1", [idB, bio]);
  await client.query("COMMIT");
}
```

Deux appels concurrents avec les ids **inversés** — `updateMemberPair(A, idX, idY)` et
`updateMemberPair(B, idY, idX)` — verrouillent chacun un membre en premier, puis attendent
l'autre membre, déjà tenu par l'autre transaction. Verrou circulaire : Postgres détecte,
annule une des deux transactions après ~1 seconde, renvoie `40P01` sur celle-ci.

Corrige `updatePair.mjs` : plus aucun deadlock possible, quel que soit l'ordre dans lequel
l'appelant passe les deux ids.

**Le piège à éviter.** Un `try/catch` qui retry silencieusement l'appel en cas de `40P01`
« marche » en apparence (l'appelant ne voit plus jamais l'erreur) mais ne corrige rien : le
deadlock continue de se produire à chaque fois, coûte une seconde de latence à chaque
collision, et un jour un retry échoue aussi. La vraie correction porte sur l'**ordre des
verrous**, pas sur la gestion de l'erreur.

## Étapes (en friction)

1. `npm run lab` une première fois : regarde le deadlock se produire réellement dans les
   logs (l'oracle l'attend — c'est GREEN parce que le bug est prouvé réel, pas malgré lui).
2. Dans `updatePair.mjs`, trie les deux ids **avant** de décider lequel verrouiller en
   premier (`idA < idB ? [idA, idB] : [idB, idA]`) — indépendamment de l'ordre dans lequel
   l'appelant les a passés.
3. Relance `npm run lab` : le check "un deadlock a été détecté" doit maintenant échouer
   (RED) — c'est le signal que tu as touché au bon fichier. Compare avec `npm run solution`.

## Vérifier

```bash
cd 10-postgresql/labs/lab-04-deadlock-reproduit
npm install
npm run lab
npm run solution
```

**Ce que l'oracle vérifie**

Deux clients `pg` réels, deux transactions concurrentes avec les ids inversés ; en mode
`lab` (starter non corrigé), un vrai deadlock (`error.code === "40P01"`) doit se produire ;
en mode `solution` (référence corrigée), aucune des deux transactions ne doit échouer ;
dans les deux cas, les membres qui ont fini par écrire portent bien une des deux valeurs
attendues (pas de corruption, pas d'écriture partielle).

## Variante J+30 (fading)

Le produit ajoute une troisième famille de méthodes qui verrouille **trois** membres à la
fois (ex. fusion de comptes). Le tri à deux éléments ne suffit plus littéralement — comment
généraliser la règle "toujours le même ordre" à N ressources ?

## Application TribuZen

Même correction sur `tribuzen-api`, appliquée à toute fonction qui verrouille plusieurs
lignes dans une transaction (fusion de familles, transferts entre comptes). Commit :
`fix(members): verrouillage dans un ordre déterministe — deadlock 40P01 éliminé`.
