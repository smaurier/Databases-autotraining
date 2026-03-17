# Guide de l'apprenant -- PostgreSQL

> **Ce guide est ta boussole.** PostgreSQL est bien plus qu'une base de donnees --
> c'est un outil de precision. Ce cours t'emmene des premieres requetes SELECT
> jusqu'a la replication et le partitioning.
>
> **Temps estime** : ~130-170h (4-5 mois a 8-10h/semaine)
>
> **Philosophie** : On n'apprend pas SQL en lisant. On l'apprend en ouvrant `psql`,
> en ecrivant des requetes, en lisant des `EXPLAIN ANALYZE`, et en cassant des choses.
> Ta base de dev est faite pour etre maltraitee -- profites-en.

---

## Avant de commencer -- Auto-diagnostic

### Le minimum vital

- [ ] Tu sais ce qu'est une base de donnees relationnelle (tables, colonnes, lignes)
- [ ] Tu as deja installe PostgreSQL (ou utilise Docker pour le lancer)
- [ ] Tu sais te connecter a une base avec un outil (psql, pgAdmin, DBeaver)
- [ ] Tu sais ecrire un `SELECT * FROM users WHERE id = 1`
- [ ] Tu sais ce qu'est une cle primaire

**5/5** -> Tu es pret. Attaque le module 00.
**3-4/5** -> Installe PostgreSQL (Docker recommande : `docker run -e POSTGRES_PASSWORD=pass -p 5432:5432 postgres:16`), puis lance-toi.
**0-2/5** -> Pas de panique. Le module 00 part de zero. Mais installe PostgreSQL d'abord.

### SQL -- ou en es-tu ?

- [ ] Tu sais ecrire une jointure (INNER JOIN, LEFT JOIN)
- [ ] Tu sais utiliser GROUP BY et HAVING
- [ ] Tu sais ce qu'est une sous-requete
- [ ] Tu sais lire un plan d'execution (EXPLAIN)
- [ ] Tu as deja cree un index

**5/5** -> Tu peux survoler la Phase 1 et passer plus de temps sur les Phases 2-3.
**3-4/5** -> Bonne base. La Phase 1 ira vite.
**0-2/5** -> Tu es le public cible. Commence au module 00, chaque concept est explique.

### Le test decisif

On te donne deux tables : `orders` (id, user_id, total, created_at) et `users` (id, name, email).
Ecris une requete qui retourne le nom de chaque utilisateur avec le total de ses commandes.

- Si tu ecris `SELECT u.name, SUM(o.total) FROM users u LEFT JOIN orders o ON u.id = o.user_id GROUP BY u.name` -> tu as les bases. Commence a la Phase 2.
- Si tu ecris quelque chose avec deux requetes separees -> la Phase 1 est faite pour toi.
- Si tu ne sais pas par ou commencer -> parfait, on part de la.

---

## Les 5 phases de ta progression

### Phase 1 -- SQL : les bases (modules 00-03) ~25-30h

> **Objectif** : Maitriser le SQL fondamental. SELECT, INSERT, UPDATE, DELETE,
> jointures, relations. Le vocabulaire de base de toute base de donnees.
>
> **Analogie** : Le SQL est une langue. Phase 1 = apprendre les mots et la grammaire.
> Tu ne fais pas de la litterature, tu apprends a parler.

| Module | Sujet | Temps | Note |
|---|---|---|---|
| 00 | Prerequis et vue d'ensemble | 2h | PostgreSQL dans l'ecosysteme, installation |
| 01 | Modele relationnel | 3h | Tables, types, contraintes, normalisation |
| 02 | CRUD et requetes | 3h | SELECT, WHERE, ORDER BY, LIMIT, agregation |
| 03 | Relations et jointures | 4h | **Cours cle** -- INNER, LEFT, RIGHT, FULL, auto-jointures |

**Conseil** : Ne lis pas les requetes. Ecris-les. Ouvre `psql` ou DBeaver,
cree une base de test, insere des donnees bidon, et essaie chaque requete.
Si tu lis sans taper, tu n'apprends pas -- tu fais semblant.

**Checkpoint Phase 1** :
- [ ] Tu sais creer une table avec des contraintes (PK, FK, NOT NULL, UNIQUE, CHECK)
- [ ] Tu sais ecrire un SELECT avec WHERE, ORDER BY, LIMIT, GROUP BY, HAVING
- [ ] Tu sais faire un INNER JOIN et un LEFT JOIN et expliquer la difference
- [ ] Tu sais utiliser INSERT, UPDATE, DELETE avec des conditions
- [ ] Tu comprends les 3 formes normales (meme si tu ne retiens pas les noms)

> **Test** : "Quelle est la difference entre WHERE et HAVING ?"
> Si tu reponds "WHERE filtre les lignes avant l'agregation, HAVING filtre apres", c'est bon.

---

### Phase 2 -- Performance (modules 04-07) ~30-35h

> **Objectif** : Comprendre pourquoi une requete est lente et comment l'accelerer.
> Transactions, index, query planner, EXPLAIN ANALYZE.
>
> **Analogie** : Tu sais conduire. Maintenant tu apprends la mecanique
> pour comprendre pourquoi la voiture rame et comment la tuner.

| Module | Sujet | Temps | Note |
|---|---|---|---|
| 04 | Transactions et ACID | 3h | BEGIN, COMMIT, ROLLBACK -- la fiabilite des donnees |
| 05 | Index fondamentaux | 4h | **Cours cle** -- B-tree, quand indexer, quand ne pas |
| 06 | Query planner | 4h | **Cours cle** -- EXPLAIN ANALYZE, lire un plan d'execution |
| 07 | Index avances | 3h | GIN, GiST, BRIN, index partiels, index expression |

**Attention** : Le module 06 (query planner) est le tournant du cours.
Un dev qui sait lire un EXPLAIN ANALYZE vaut 10 devs qui ajoutent des index au hasard.
Prends le temps. Fais tourner EXPLAIN sur tes propres requetes.

**Checkpoint Phase 2** :
- [ ] Tu sais expliquer ACID avec un exemple concret (transfert bancaire)
- [ ] Tu sais creer un index et mesurer son impact avec EXPLAIN ANALYZE
- [ ] Tu sais lire un plan d'execution : Seq Scan, Index Scan, Bitmap Scan, Nested Loop, Hash Join
- [ ] Tu sais quand un index est INUTILE (selectivite faible, petite table)
- [ ] Tu sais ce qu'est un index GIN et quand l'utiliser (JSONB, full-text, arrays)

> **Test** : "Une requete met 2 secondes. Tu fais quoi en premier ?"
> Si tu reponds "EXPLAIN ANALYZE pour voir le plan, identifier le Seq Scan sur une grande table, verifier si un index manque", c'est bon.
> Si tu reponds "ajouter un index sur toutes les colonnes" -- relis le module 06.

---

### Phase 3 -- Concurrence (modules 08-10) ~20-25h

> **Objectif** : Comprendre ce qui se passe quand plusieurs transactions
> accedent aux memes donnees en meme temps. Isolation, verrous, deadlocks.
>
> **Analogie** : Plusieurs cuisiniers dans la meme cuisine.
> Sans regles, c'est le chaos. Les niveaux d'isolation sont les regles de la cuisine.

| Module | Sujet | Temps | Note |
|---|---|---|---|
| 08 | Niveaux d'isolation | 3h | READ COMMITTED, REPEATABLE READ, SERIALIZABLE |
| 09 | Verrous et locks | 4h | **Cours cle** -- row locks, advisory locks, SELECT FOR UPDATE |
| 10 | Deadlocks | 3h | Detection, prevention, resolution |

**Conseil** : La concurrence est abstraite tant que tu ne la vis pas.
Ouvre DEUX terminaux psql, demarre deux transactions, et fais-les se marcher dessus.
Observer un deadlock en direct vaut 100 pages de theorie.

**Checkpoint Phase 3** :
- [ ] Tu sais expliquer la difference entre READ COMMITTED et REPEATABLE READ
- [ ] Tu sais utiliser `SELECT ... FOR UPDATE` et expliquer pourquoi
- [ ] Tu sais ce qu'est un deadlock et comment l'eviter (ordre d'acces coherent)
- [ ] Tu sais utiliser un advisory lock pour synchroniser des processus
- [ ] Tu peux reproduire un probleme de concurrence dans psql

> **Test** : "Deux utilisateurs commandent le dernier article en stock en meme temps. Comment tu geres ?"
> Si tu parles de `SELECT FOR UPDATE` sur la ligne de stock, ou de `SERIALIZABLE`, c'est bon.

---

### Phase 4 -- Fonctionnalites avancees (modules 11-15) ~30-40h

> **Objectif** : Les outils avances de PostgreSQL. Optimisation poussee,
> fonctions SQL, JSONB, securite, et un projet final pour tout consolider.
>
> **Analogie** : Tu maitrises la conduite et la mecanique.
> Maintenant tu apprends les techniques de pilotage avance.

| Module | Sujet | Temps | Note |
|---|---|---|---|
| 11 | Performances et optimisation | 4h | Configuration, vacuum, bloat, connection pooling |
| 12 | Fonctions avancees SQL | 3h | Window functions, CTE, requetes recursives |
| 13 | JSONB et types avances | 3h | Le meilleur des deux mondes : relationnel + document |
| 14 | Securite et administration | 3h | Roles, privileges, Row Level Security |
| 15 | Projet final | 8h+ | Concevoir et optimiser un schema complet |

**Conseil** : Le module 12 (window functions) est un game-changer.
Une requete avec `ROW_NUMBER()`, `LAG()`, `LEAD()` remplace souvent
3 sous-requetes et un traitement applicatif. Apprends-les, tu les utiliseras partout.

**Checkpoint Phase 4** :
- [ ] Tu sais configurer `work_mem`, `shared_buffers`, et expliquer leur impact
- [ ] Tu sais ecrire une window function (ROW_NUMBER, RANK, LAG, LEAD)
- [ ] Tu sais utiliser un CTE recursif (hierarchie, arbre)
- [ ] Tu sais stocker et requeter du JSONB efficacement (avec index GIN)
- [ ] Tu sais mettre en place du Row Level Security pour du multi-tenant
- [ ] Ton projet final a un schema normalise, des index pertinents, et des requetes optimisees

> **Test** : "Comment tu numerotes les commandes par client, triees par date ?"
> Si tu ecris `ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at)`, c'est bon.

---

### Phase 5 -- DBA (modules 16-18 + bonus) ~25-35h

> **Objectif** : Les sujets d'administration avancee. Replication, monitoring,
> partitioning. Tu passes de "dev qui utilise PostgreSQL" a "dev qui comprend PostgreSQL".
>
> **Analogie** : Tu ne conduis plus -- tu concois le circuit.

| Module | Sujet | Temps | Note |
|---|---|---|---|
| 16 | Replication | 4h | Streaming replication, read replicas, failover |
| 17 | Monitoring et observabilite | 3h | pg_stat, pgBadger, alerting |
| 18 | Partitioning et scaling | 4h | Range, list, hash partitioning, sharding |
| 19 | pgvector et embeddings | 3h | **Bonus** -- PostgreSQL comme base vectorielle pour l'IA |

**Conseil** : Ces modules sont optionnels pour un dev, essentiels pour un lead/archi.
Si tu n'as pas de besoin immediat, fais-les en survol et reviens-y quand le besoin se presente.

**Checkpoint Phase 5** :
- [ ] Tu sais configurer une replication streaming (au moins en theorie)
- [ ] Tu sais lire `pg_stat_statements` pour identifier les requetes les plus couteuses
- [ ] Tu sais quand et comment partitionner une table
- [ ] Tu comprends la difference entre partitioning et sharding
- [ ] Tu sais ce qu'est un embedding vectoriel et comment le stocker dans PostgreSQL

> **Test** : "La table `events` fait 500M de lignes et les requetes ralentissent. Solutions ?"
> Si tu parles de partitioning par date, d'archivage des vieilles donnees, et d'index partiels sur la partition active, c'est bon.

---

## Quand tu bloques

### "Ma requete est lente mais je ne sais pas pourquoi"
1. `EXPLAIN (ANALYZE, BUFFERS) ta_requete;` -- toujours la premiere etape
2. Cherche "Seq Scan" sur une grande table -- c'est souvent la
3. Regarde le "actual time" de chaque noeud -- le plus lent est ton bottleneck
4. Verifie que tes statistiques sont a jour : `ANALYZE ta_table;`

### "Mon index n'est pas utilise"
1. Le planner a peut-etre raison : si la table est petite, un Seq Scan est plus rapide
2. Verifie que ta requete correspond a l'index (un index sur `lower(email)` n'aide pas `WHERE email = ...`)
3. Verifie le type : un index B-tree ne fonctionne pas pour `LIKE '%pattern%'`
4. Force temporairement : `SET enable_seqscan = off;` pour verifier -- mais ne laisse JAMAIS ca en prod

### "Je ne comprends pas les jointures"
1. Dessine les deux tables avec 3-4 lignes chacune
2. Trace les lignes qui correspondent avec des fleches
3. INNER JOIN = seulement les lignes connectees, LEFT JOIN = toutes les lignes de gauche + les connexions
4. Si ca reste flou, fais un SELECT sans FROM avec des VALUES pour visualiser

### "Ma transaction bloque"
1. `SELECT * FROM pg_stat_activity WHERE wait_event IS NOT NULL;` -- qui attend quoi ?
2. `SELECT * FROM pg_locks WHERE NOT granted;` -- quels verrous sont en attente ?
3. C'est probablement une autre transaction qui tient le verrou -- trouve-la et comprends pourquoi
4. En dev : `SELECT pg_cancel_backend(pid);` pour debloquer. En prod : identifie la cause racine d'abord.

### "Je ne sais pas si mon schema est bon"
1. Verifie les 3 formes normales -- pas de donnees dupliquees, pas de colonnes qui dependent d'une partie de la cle
2. Chaque table doit avoir un sujet clair (une table `user_order_products` est un red flag)
3. Demande-toi : "Si je mets a jour cette donnee, combien de lignes dois-je modifier ?" -- si la reponse est "plusieurs", normalise
4. Un schema qui evolue est normal. Les migrations existent pour ca.

---

## Auto-evaluation globale

**Apres Phase 1** : "C'est quoi la difference entre INNER JOIN et LEFT JOIN ?"
-> Si tu reponds avec un exemple concret (clients sans commandes), c'est bon.

**Apres Phase 2** : "Tu as un Seq Scan sur 10M lignes. C'est toujours un probleme ?"
-> Si tu reponds "ca depend -- si la requete retourne 80% des lignes, un Seq Scan est optimal", c'est bon. Reponse "oui" = relis le module 06.

**Apres Phase 3** : "Deux transactions modifient la meme ligne. Que se passe-t-il ?"
-> Si tu reponds "la deuxieme attend que la premiere COMMIT ou ROLLBACK, grace au row-level lock implicite", c'est bon.

**Apres Phase 4** : "Comment stocker des tags sur un article ?"
-> Si tu proposes soit une table de jointure (relationnel pur), soit un array ou JSONB (avec index GIN), et que tu sais argumenter le choix, c'est bon.

**Apres Phase 5** : "Ta base primaire tombe. Que se passe-t-il ?"
-> Si tu parles de failover vers le replica, de promotion automatique ou manuelle, et de la perte potentielle des derniers WAL non repliques, c'est bon.

---

## Rythme recommande

| Rythme | Par semaine | Duree totale |
|---|---|---|
| **Decouverte** (a cote du boulot) | 5-6h | 5-7 mois |
| **Regulier** (motivation) | 8-10h | 4-5 mois |
| **Intensif** (objectif DBA) | 12-15h | 2-3 mois |

### Conseils concrets

- **Phase 1 : rapide mais pratique.** 2-3 semaines. Tape chaque requete.
- **Phase 2 : le coeur du cours.** 4-5 semaines. C'est la que tu deviens dangereux.
- **Phase 3 : ouvre deux terminaux.** La concurrence se vit, elle ne se lit pas.
- **Phase 4 : les window functions d'abord.** C'est le ROI le plus eleve.
- **Phase 5 : optionnelle pour un dev, essentielle pour un lead.** Fais-la en survol si tu n'as pas le temps.
- **Installe pgcli** (au lieu de psql) -- l'autocompletion change la vie.

### L'erreur classique

Ne fais PAS ca : apprendre SQL avec un ORM (Prisma, TypeORM).
L'ORM masque le SQL. Apprends le SQL brut d'abord, puis utilise un ORM
en sachant ce qu'il genere en dessous. Sinon tu debuggues a l'aveugle.

---

## Ressources complementaires

### References
- [PostgreSQL Documentation](https://www.postgresql.org/docs/current/) -- la meilleure doc de tous les SGBD
- [Use The Index, Luke](https://use-the-index-luke.com/) -- tout sur les index, gratuit, excellent
- [pgexercises.com](https://pgexercises.com/) -- exercices SQL interactifs

### Pour approfondir
- *The Art of PostgreSQL* (Dimitri Fontaine) -- le livre de reference PostgreSQL
- *SQL Performance Explained* (Markus Winand) -- comprendre les plans d'execution
- [Postgres Weekly](https://postgresweekly.com/) -- newsletter hebdomadaire

---

## Et apres ?

Tu as fini les 19 modules ? Tu n'es plus "un dev qui utilise une BDD" -- tu es un dev qui COMPREND sa BDD.

Prochaines etapes :
1. **Optimise un vrai projet** -- prends une app existante, lance `pg_stat_statements`, et ameliore les 5 requetes les plus lentes
2. **Explore le cours NestJS (05)** -- connecte tes connaissances SQL a un vrai backend
3. **Essaie le module pgvector (19)** -- PostgreSQL comme base vectorielle pour les projets IA
4. **Participe a un meetup PostgreSQL** -- la communaute PG est l'une des plus accueillantes du monde open source
