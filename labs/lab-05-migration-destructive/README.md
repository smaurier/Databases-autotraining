# Lab 05 — Intervention : rendre sûre une migration qui perd des données

> **Outcome :** à la fin, tu sais repérer, à la lecture d'une PR, qu'une migration
> `ADD` + `DROP` perd silencieusement des données — et tu sais comment un split de colonne se
> fait vraiment : backfill AVANT de droper, dans une transaction, avec une vérification que
> tu peux reconstruire l'original.
> **Vrai outil :** PostgreSQL 17 (Docker éphémère). L'oracle capture les vraies valeurs
> AVANT la migration et vérifie qu'elles sont reconstructibles APRÈS — pas une relecture du
> SQL, une vraie mesure sur des lignes réelles.
> **Feedback :** `npm run lab` — RED tant que `migration.sql` perd des données. `npm run
> solution` prouve l'oracle : zéro perte, colonnes NOT NULL en place.

## Prérequis technique

Docker Desktop doit tourner. L'oracle applique `schema-existant.sql` (l'état actuel de la
prod), seed 5 membres avec des `full_name` réels et volontairement variés (un nom composé,
un nom à particule multi-mots, un nom sans espace), **capture ces valeurs**, applique
`migration.sql`, puis vérifie qu'on peut les reconstruire exactement depuis les nouvelles
colonnes.

## Lire avant (une lecture bornée)

- Module [`04-transactions-et-acid.md`](../../modules/04-transactions-et-acid.md) — une
  migration multi-étapes qui échoue à mi-chemin doit laisser la table dans un état
  **cohérent**, jamais à moitié migrée.
- Module [`01-modele-relationnel.md`](../../modules/01-modele-relationnel.md) — `ALTER TABLE
  ... DROP COLUMN` est irréversible dès le COMMIT : il n'y a pas de corbeille.

## Énoncé

PR d'un collègue, prête à merger. Ticket : *« on doit pouvoir trier et rechercher les
membres par nom de famille — il faut splitter `full_name` en `first_name` et `last_name`. »*
La migration proposée, déjà dans `migration.sql` :

```sql
ALTER TABLE members ADD COLUMN first_name text;
ALTER TABLE members ADD COLUMN last_name text;
ALTER TABLE members DROP COLUMN full_name;
```

Elle s'applique **sans erreur**. C'est exactement pour ça qu'elle est dangereuse : rien ne
crie au moment du déploiement. `first_name`/`last_name` sont ajoutées vides (NULL), puis
`full_name` est détruite — chaque nom que les familles avaient renseigné disparaît
définitivement, sans qu'aucune exception ne soit levée.

Réécris `migration.sql` : le split doit **backfill** `first_name`/`last_name` à partir de
`full_name` AVANT de la droper, et rien ne doit se perdre.

**Le piège à éviter.** Un split naïf sur l'espace échoue sur les noms composés
("Jean-Paul De La Fontaine" → tu veux `first_name = "Jean-Paul"`, `last_name = "De La
Fontaine"`, pas un split sur TOUS les espaces) et sur les noms sans espace ("Cher" → un
`first_name` vide n'est pas une erreur, `last_name` doit rester reconstructible).

## Étapes (en friction)

1. `npm run lab` une première fois : regarde la migration "réussir" (aucune erreur SQL) puis
   le check de reconstruction échouer — c'est la preuve que "ça s'applique sans erreur" ne
   veut RIEN dire sur la sécurité d'une migration.
2. Réécris `migration.sql` : ajoute les deux colonnes, `UPDATE` pour les remplir à partir de
   `full_name` (split sur le PREMIER espace), passe-les en `NOT NULL`, droppe `full_name` —
   le tout entre `BEGIN`/`COMMIT`.
3. Relance : le check de reconstruction doit passer pour les 5 noms, y compris les cas
   limites.

## Vérifier

```bash
cd 10-postgresql/labs/lab-05-migration-destructive
npm install
npm run lab
npm run solution
```

**Ce que l'oracle vérifie**

La migration s'applique sans erreur ; `full_name` a bien disparu (migration menée à son
terme, pas à moitié faite) ; `first_name`/`last_name` existent et sont `NOT NULL` ; pour
**chacun** des 5 membres seedés, `trim(first_name || ' ' || last_name)` reproduit
**exactement** le `full_name` original capturé avant la migration — c'est ce dernier check
qui démasque la perte de données, même quand la migration "a marché" au sens SQL.

## Variante J+30 (fading)

Un membre a un `full_name` avec un espace en début/fin ("  Marie Dupont") ou un caractère
Unicode non-ASCII dans le prénom. Le split sur le premier espace tient-il encore ? Écris le
cas de test avant de répondre.

## Application TribuZen

Même vigilance sur `tribuzen-api` pour toute migration qui touche des données existantes
(jamais un `DROP COLUMN` sans backfill préalable vérifié). Commit :
`fix(migration): split full_name en first_name/last_name avec backfill — zéro perte prouvée`.
