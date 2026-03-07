# Glossaire

Termes cles utilises tout au long de la formation, classes par ordre alphabetique.

---

## A

### ACID {#acid}
Acronyme pour Atomicity, Consistency, Isolation, Durability. Les quatre proprietes fondamentales qui garantissent la fiabilite des transactions dans une base de donnees relationnelle. Chaque transaction est soit executee entierement, soit annulee completement.

### Advisory Lock {#advisory-lock}
Verrou applicatif fourni par PostgreSQL, gere manuellement par l'application plutot que par le moteur. Permet de synchroniser des processus concurrents sans bloquer des lignes ou des tables reelles. Se prend avec `pg_advisory_lock()` et se libere explicitement.

### ANALYZE {#analyze}
Commande PostgreSQL qui collecte des statistiques sur le contenu des tables (distribution des valeurs, cardinalite, correlation). Ces statistiques sont utilisees par le query planner pour choisir le plan d'execution optimal. Executee automatiquement par autovacuum ou manuellement.

### Autocommit {#autocommit}
Mode par defaut de PostgreSQL ou chaque instruction SQL est automatiquement englobee dans une transaction implicite qui est commitee immediatement apres execution. Pour grouper plusieurs instructions, il faut utiliser explicitement `BEGIN` / `COMMIT`.

### AUTOVACUUM {#autovacuum}
Processus d'arriere-plan de PostgreSQL qui execute automatiquement `VACUUM` et `ANALYZE` sur les tables modifiees. Nettoie les dead tuples, met a jour les statistiques et previent le table bloat. Configurable via les parametres `autovacuum_*`.

## B

### B-tree {#b-tree}
Structure d'index par defaut dans PostgreSQL. Arbre equilibre ou chaque noeud contient des cles triees et des pointeurs vers les noeuds enfants. Efficace pour les comparaisons d'egalite (`=`) et de plage (`<`, `>`, `BETWEEN`). Supporte le tri et les recherches prefixees.

### BEGIN {#begin}
Commande SQL qui demarre explicitement une transaction. Toutes les instructions suivantes font partie de la meme transaction jusqu'au `COMMIT` ou `ROLLBACK`. Synonyme de `START TRANSACTION`.

### Bitmap Index Scan {#bitmap-index-scan}
Strategie d'acces ou PostgreSQL construit d'abord un bitmap des pages contenant des lignes correspondantes en utilisant un ou plusieurs index, puis lit ces pages en une seule passe sequentielle. Efficace pour les requetes retournant un pourcentage modere de lignes.

### BRIN (Block Range Index) {#brin}
Type d'index tres compact qui stocke des informations resumees (min/max) pour des plages de blocs physiques consecutifs. Ideal pour les colonnes naturellement correlees avec l'ordre physique des lignes (timestamps, identifiants sequentiels). Tres petit en taille comparee a un B-tree.

## C

### Checkpoint {#checkpoint}
Operation ou PostgreSQL ecrit toutes les pages modifiees en memoire (dirty pages) vers les fichiers de donnees sur disque. Garantit un point de reprise coherent en cas de crash. Configure via `checkpoint_timeout` et `max_wal_size`.

### COMMIT {#commit}
Commande SQL qui termine une transaction en rendant permanentes toutes les modifications effectuees depuis le `BEGIN`. Une fois commitees, les modifications sont durables meme en cas de crash (propriete D d'ACID).

### Composite Index {#composite-index}
Index portant sur plusieurs colonnes. L'ordre des colonnes est crucial : l'index est efficace pour les requetes filtrant par les colonnes dans l'ordre de gauche a droite. Un index sur `(a, b, c)` est utilisable pour filtrer sur `a`, `a, b`, ou `a, b, c`, mais pas sur `b` seul.

### Connection Pooling {#connection-pooling}
Technique qui maintient un pool de connexions ouvertes a la base de donnees, reutilisees par les requetes de l'application. Evite le cout d'ouverture/fermeture de connexion a chaque requete. Outils : PgBouncer, pgpool-II.

### Correlated Subquery {#correlated-subquery}
Sous-requete qui reference une colonne de la requete parente, executee une fois pour chaque ligne de la requete externe. Peut etre couteuse car executee de maniere repetee. Souvent remplacable par un `JOIN` ou un `LATERAL` pour de meilleures performances.

### Covering Index {#covering-index}
Index qui contient toutes les colonnes necessaires pour satisfaire une requete, evitant un acces a la table (heap). Cree avec la clause `INCLUDE` dans PostgreSQL. Permet un Index Only Scan pur, offrant les meilleures performances de lecture.

### CTE (Common Table Expression) {#cte}
Expression de table nommee definie avec `WITH`, permettant de decomposer des requetes complexes en sous-parties lisibles et reutilisables. Depuis PostgreSQL 12, les CTE non-recursives sont inlinées par l'optimiseur si elles ne sont referencees qu'une fois.

## D

### Deadlock {#deadlock}
Situation ou deux transactions ou plus se bloquent mutuellement, chacune attendant un verrou detenu par l'autre. PostgreSQL detecte automatiquement les deadlocks (via un graphe d'attente) et annule l'une des transactions pour debloquer la situation.

### Dead Tuple {#dead-tuple}
Version obsolete d'une ligne qui n'est plus visible par aucune transaction active mais qui occupe toujours de l'espace physique. Les dead tuples sont nettoyes par `VACUUM`. Leur accumulation cause le table bloat.

### Dirty Read {#dirty-read}
Phenomene d'isolation ou une transaction lit des modifications non commitees d'une autre transaction. PostgreSQL ne permet jamais les dirty reads, meme au niveau d'isolation le plus bas (`Read Committed`).

## E

### EXPLAIN {#explain}
Commande PostgreSQL qui affiche le plan d'execution choisi par le query planner pour une requete, sans l'executer. Montre les noeuds du plan, les estimations de cout et de cardinalite. Indispensable pour comprendre et optimiser les performances.

### EXPLAIN ANALYZE {#explain-analyze}
Variante de `EXPLAIN` qui execute reellement la requete et affiche les temps d'execution reels, le nombre de lignes effectivement traitees et l'utilisation memoire. Permet de comparer les estimations du planner avec la realite. Attention : la requete est executee.

### Expression Index {#expression-index}
Index cree sur le resultat d'une expression ou d'une fonction plutot que sur une colonne brute. Exemple : `CREATE INDEX ON users (LOWER(email))` pour les recherches case-insensitive. L'expression dans la requete doit correspondre exactement a celle de l'index.

## F

### Foreign Key {#foreign-key}
Contrainte d'integrite referentielle qui garantit qu'une valeur dans une colonne (ou un groupe de colonnes) correspond a une valeur existante dans la table referencee. Assure la coherence des relations entre tables. Peut definir des actions `ON DELETE` et `ON UPDATE`.

### FOR UPDATE {#for-update}
Clause SQL ajoutee a un `SELECT` pour poser un verrou exclusif sur les lignes selectionnees, empechant d'autres transactions de les modifier ou de les verrouiller. Utilisee pour implementer le verrouillage pessimiste dans les scenarios de concurrence.

### Full-Text Search {#full-text-search}
Fonctionnalite native de PostgreSQL pour la recherche textuelle avancee. Utilise les types `tsvector` (document indexe) et `tsquery` (requete de recherche). Supporte la lemmatisation, le ranking, la mise en evidence, et les dictionnaires multilingues. Indexe avec GIN.

## G

### GIN (Generalized Inverted Index) {#gin}
Type d'index optimise pour les valeurs contenant plusieurs elements (tableaux, JSONB, tsvector, hstore). Stocke chaque element avec la liste des lignes qui le contiennent. Lecture rapide mais ecriture plus lente que B-tree. Ideal pour le full-text search et les requetes JSONB.

### GiST (Generalized Search Tree) {#gist}
Type d'index equilibre supportant des strategies de recherche variees : containment, intersection, proximite. Utilise pour les donnees geometriques, les ranges, le full-text search (alternatif a GIN), et les types de donnees personnalises. Plus versatile mais moins precis que GIN pour le texte.

### GRANT {#grant}
Commande SQL pour attribuer des privileges (SELECT, INSERT, UPDATE, DELETE, etc.) a un role ou un utilisateur sur un objet de la base (table, schema, fonction). Le controle d'acces dans PostgreSQL repose sur le systeme de roles et de privileges.

## H

### Hash Index {#hash-index}
Type d'index utilisant une table de hachage, optimise uniquement pour les comparaisons d'egalite exacte (`=`). Plus compact qu'un B-tree pour ce cas d'usage, mais ne supporte pas les scans de plage ni le tri. Durable depuis PostgreSQL 10 (WAL-logged).

### Hash Join {#hash-join}
Strategie de jointure ou PostgreSQL construit une table de hachage a partir de la plus petite table, puis parcourt la plus grande en cherchant les correspondances dans la table de hachage. Tres performant pour les jointures d'egalite sur de grands volumes.

### HOT Update (Heap-Only Tuple) {#hot-update}
Optimisation PostgreSQL ou une mise a jour qui ne modifie aucune colonne indexee est effectuee sans mettre a jour les index. La nouvelle version de la ligne est stockee dans la meme page et chainee a l'ancienne. Reduit significativement le cout des updates frequents.

## I

### Index Only Scan {#index-only-scan}
Strategie d'acces ou PostgreSQL satisfait la requete entierement depuis l'index, sans acceder a la table (heap). Possible uniquement si toutes les colonnes necessaires sont dans l'index et que la visibility map confirme que les pages sont all-visible.

### Index Scan {#index-scan}
Strategie d'acces ou PostgreSQL parcourt un index pour trouver les identifiants des lignes correspondantes, puis accede a la table pour recuperer les donnees completes. Efficace quand le pourcentage de lignes retournees est faible.

### Isolation Level {#isolation-level}
Niveau qui definit comment les transactions concurrentes interagissent entre elles. PostgreSQL supporte trois niveaux : Read Committed (defaut), Repeatable Read, et Serializable. Chaque niveau offre des garanties croissantes contre les anomalies de concurrence.

## J

### JSONB {#jsonb}
Type de donnees binaire pour stocker des documents JSON dans PostgreSQL. Contrairement a `JSON`, les donnees sont decomposees et stockees en format binaire, permettant l'indexation (GIN), les requetes avec operateurs (`@>`, `->`, `->>`, `?`, `#>`), et des performances superieures.

### Junction Table {#junction-table}
Table intermediaire utilisee pour implementer une relation many-to-many entre deux tables. Contient les cles etrangeres des deux tables liees, souvent avec une cle primaire composite. Aussi appelee table de liaison, table d'association ou table pivot.

## L

### LATERAL Join {#lateral-join}
Type de jointure ou la sous-requete droite peut referencer des colonnes de la requete gauche (comme une correlated subquery, mais dans le `FROM`). Permet des patterns comme « pour chaque ligne, selectionner les N elements les plus recents ».

### Lock Timeout {#lock-timeout}
Parametre PostgreSQL (`lock_timeout`) qui definit le temps maximum qu'une transaction attend pour obtenir un verrou avant d'echouer avec une erreur. Evite les blocages indefinis dans les applications. Se configure par session ou globalement.

## M

### Merge Join {#merge-join}
Strategie de jointure ou PostgreSQL trie les deux tables sur la cle de jointure puis les parcourt simultanement. Tres efficace quand les donnees sont deja triees (via un index) ou pour les tres grands ensembles de donnees. Supporte egalement les jointures de plage.

### MVCC (Multi-Version Concurrency Control) {#mvcc}
Mecanisme fondamental de PostgreSQL pour gerer la concurrence. Chaque modification cree une nouvelle version (tuple) de la ligne plutot que d'ecraser l'ancienne. Les transactions voient un snapshot coherent de la base, permettant des lectures sans blocage.

## N

### Nested Loop {#nested-loop}
Strategie de jointure la plus simple ou PostgreSQL parcourt la table interne une fois pour chaque ligne de la table externe. Efficace quand la table externe est petite et qu'un index existe sur la table interne. Cout en O(n * m) sans index.

### NOWAIT {#nowait}
Option ajoutee a `SELECT ... FOR UPDATE` ou `LOCK TABLE` qui provoque une erreur immediate si le verrou demande ne peut pas etre obtenu, au lieu d'attendre. Permet aux applications de reagir rapidement aux conflits de concurrence.

## P

### Partial Index {#partial-index}
Index portant uniquement sur un sous-ensemble de lignes defini par une clause `WHERE`. Exemple : `CREATE INDEX ON orders (created_at) WHERE status = 'pending'`. Plus petit et plus rapide qu'un index complet quand les requetes ciblent toujours le meme sous-ensemble.

### Partitioning {#partitioning}
Technique de decomposition d'une grande table en partitions plus petites basees sur une cle (range, list, hash). Chaque partition est une table physique separee. Ameliore les performances des requetes ciblant une partition et facilite la maintenance (archivage, purge).

### pg_locks {#pg-locks}
Vue systeme PostgreSQL qui affiche tous les verrous actuellement detenus ou attendus dans l'instance. Indispensable pour diagnostiquer les problemes de blocage et les deadlocks. Jointure avec `pg_stat_activity` pour identifier les requetes en cause.

### pg_stat_activity {#pg-stat-activity}
Vue systeme qui montre l'etat de toutes les connexions actives : requete en cours, etat d'attente, debut de la transaction, PID du processus. Outil principal pour diagnostiquer les problemes de performance et de blocage en temps reel.

### pg_stat_statements {#pg-stat-statements}
Extension PostgreSQL qui collecte des statistiques sur toutes les requetes executees : nombre d'appels, temps total, temps moyen, lignes retournees, I/O. Essentielle pour identifier les requetes les plus couteuses et prioriser les optimisations.

### pg_stat_user_indexes {#pg-stat-user-indexes}
Vue systeme qui affiche les statistiques d'utilisation des index : nombre de scans, tuples lus, tuples retournes. Permet d'identifier les index inutilises (jamais scannes) qui consomment de l'espace et ralentissent les ecritures.

### pg_stat_user_tables {#pg-stat-user-tables}
Vue systeme qui affiche les statistiques des tables : nombre de seq scans, index scans, tuples inseres/modifies/supprimes, dead tuples, dernier vacuum et analyze. Permet d'evaluer l'activite et la sante de chaque table.

### Prepared Statement {#prepared-statement}
Requete SQL pre-compilee et parametree envoyee au serveur en deux etapes : preparation (parsing, planning) puis execution avec les valeurs. Evite le re-parsing et le re-planning, ameliore les performances et protege contre les injections SQL.

### Primary Key {#primary-key}
Contrainte qui identifie de maniere unique chaque ligne d'une table. Combine une contrainte `NOT NULL` et un index unique. PostgreSQL cree automatiquement un index B-tree sur la cle primaire. Chaque table devrait avoir une cle primaire.

## Q

### Query Planner {#query-planner}
Composant du moteur PostgreSQL qui analyse une requete SQL et choisit le plan d'execution optimal parmi des milliers de plans possibles. Se base sur les statistiques des tables, les index disponibles, et un modele de cout pour estimer le cout de chaque strategie.

## R

### Read Committed {#read-committed}
Niveau d'isolation par defaut de PostgreSQL. Chaque instruction dans la transaction voit un snapshot coherent pris au debut de cette instruction (pas de la transaction). Evite les dirty reads mais permet les non-repeatable reads et les phantom reads.

### Recursive CTE {#recursive-cte}
CTE utilisant le mot-cle `RECURSIVE` pour s'auto-referencer, permettant de parcourir des structures hierarchiques (arbres, graphes). Composee d'un terme de base (non-recursif) et d'un terme recursif relies par `UNION ALL`. Utilisee pour les menus imbriques, les organigrammes, les chemins.

### REINDEX {#reindex}
Commande PostgreSQL qui reconstruit un ou plusieurs index. Utile quand un index est corrompu ou devenu inefficace a cause du bloat. `REINDEX CONCURRENTLY` permet de reconstruire sans bloquer les ecritures.

### Repeatable Read {#repeatable-read}
Niveau d'isolation ou la transaction voit un snapshot coherent de la base pris au debut de la transaction (pas de chaque instruction). Evite les dirty reads et les non-repeatable reads. Peut echouer avec une erreur de serialisation en cas de conflit.

### RETURNING {#returning}
Clause SQL specifique a PostgreSQL qui permet a `INSERT`, `UPDATE` et `DELETE` de retourner les lignes affectees. Evite un `SELECT` supplementaire apres la modification. Exemple : `INSERT INTO users (name) VALUES ('Alice') RETURNING id`.

### ROLLBACK {#rollback}
Commande SQL qui annule toutes les modifications effectuees depuis le dernier `BEGIN` ou `SAVEPOINT`. La transaction est abandonnee et la base revient a son etat precedent. Utilise en cas d'erreur ou de condition d'annulation.

### Row Level Security (RLS) {#row-level-security}
Fonctionnalite PostgreSQL permettant de definir des politiques d'acces au niveau des lignes individuelles. Active avec `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`, puis des politiques `CREATE POLICY` definissent quelles lignes chaque role peut voir ou modifier. Essentielle pour les applications multi-tenant.

## S

### SAVEPOINT {#savepoint}
Point de sauvegarde dans une transaction permettant un rollback partiel. `SAVEPOINT sp1` cree un point, `ROLLBACK TO sp1` annule les modifications depuis ce point sans annuler la transaction entiere. Permet une gestion d'erreur fine dans les transactions longues.

### Seq Scan (Sequential Scan) {#seq-scan}
Strategie d'acces ou PostgreSQL lit chaque ligne de la table sequentiellement, du debut a la fin. Choisi par le planner quand aucun index n'est applicable, quand un grand pourcentage de la table est requis, ou quand la table est petite.

### Serializable {#serializable}
Niveau d'isolation le plus strict. Garantit que le resultat de l'execution concurrente est identique a une execution serielle (une transaction apres l'autre). Utilise le SSI (Serializable Snapshot Isolation). Peut provoquer des erreurs de serialisation necessitant un retry.

### Serialization Failure {#serialization-failure}
Erreur (code `40001`) levee par PostgreSQL quand une transaction au niveau Repeatable Read ou Serializable entre en conflit avec une transaction concurrente. L'application doit intercepter cette erreur et re-essayer la transaction depuis le debut.

### SKIP LOCKED {#skip-locked}
Option ajoutee a `SELECT ... FOR UPDATE` qui ignore silencieusement les lignes deja verrouillees par une autre transaction au lieu d'attendre ou d'echouer. Ideal pour implementer des files d'attente (job queues) ou les workers prennent le prochain element disponible.

## T

### Table Bloat {#table-bloat}
Phenomene ou une table occupe plus d'espace disque que necessaire a cause de l'accumulation de dead tuples non nettoyes. Degrade les performances des seq scans et augmente les I/O. Corrige par `VACUUM FULL` (verrou exclusif) ou `pg_repack` (en ligne).

### Transaction {#transaction}
Unite de travail atomique composee d'une ou plusieurs operations SQL. Delimitee par `BEGIN` et `COMMIT` (ou `ROLLBACK`). Garantit les proprietes ACID. En cas de crash, une transaction non commitee est automatiquement annulee.

### tsvector {#tsvector}
Type de donnees PostgreSQL representant un document optimise pour la recherche textuelle. Contient des lexemes (mots normalises) avec leurs positions. Cree avec `to_tsvector('french', 'texte a indexer')`. Indexe avec GIN pour des recherches rapides.

### tsquery {#tsquery}
Type de donnees PostgreSQL representant une requete de recherche textuelle. Supporte les operateurs booleens (`&`, `|`, `!`), la recherche de phrases (`<->`) et les prefixes (`:*`). Cree avec `to_tsquery('french', 'mot1 & mot2')`. Utilise avec l'operateur `@@` contre un `tsvector`.

### Tuple {#tuple}
Terme PostgreSQL pour une version d'une ligne (row) dans une table. En raison de MVCC, une meme ligne logique peut avoir plusieurs tuples physiques (versions). Chaque tuple est identifie par un `ctid` (adresse physique dans le fichier de la table).

## V

### VACUUM {#vacuum}
Commande de maintenance qui recupere l'espace occupe par les dead tuples. `VACUUM` marque l'espace comme reutilisable (sans le restituer a l'OS). `VACUUM FULL` reecrit la table entiere pour compacter l'espace mais prend un verrou exclusif. `VACUUM ANALYZE` combine nettoyage et mise a jour des statistiques.

## W

### WAL (Write-Ahead Log) {#wal}
Journal de transactions ou PostgreSQL ecrit toutes les modifications avant de les appliquer aux fichiers de donnees. Garantit la durabilite (propriete D d'ACID) : en cas de crash, les transactions commitees sont rejouees depuis le WAL. Sert aussi a la replication et au Point-In-Time Recovery.

### Window Function {#window-function}
Fonction SQL qui effectue un calcul sur un ensemble de lignes liees a la ligne courante, sans les agréger en une seule. Definie avec `OVER (PARTITION BY ... ORDER BY ...)`. Exemples : `ROW_NUMBER()`, `RANK()`, `LAG()`, `LEAD()`, `SUM() OVER(...)`. Indispensable pour les analyses et les rapports.

## X

### xmin / xmax {#xmin-xmax}
Colonnes systeme cachees de chaque tuple dans PostgreSQL. `xmin` contient l'identifiant de la transaction qui a cree le tuple. `xmax` contient l'identifiant de la transaction qui l'a supprime ou modifie (0 si le tuple est toujours valide). Mecanisme central de MVCC pour determiner la visibilite des tuples.

---

## Termes expert (Modules 16-18)

### Failover {#failover}
Basculement automatique ou manuel du trafic vers un serveur standby lorsque le serveur primaire tombe en panne. En PostgreSQL, declenche via `pg_promote()` ou des outils comme Patroni/repmgr. Le standby devient le nouveau primaire.

### Logical Decoding {#logical-decoding}
Mecanisme PostgreSQL qui traduit les changements du WAL en un flux logique (INSERT/UPDATE/DELETE) lisible par des consumers externes. Base de la replication logique. Utilise des output plugins comme `pgoutput` ou `wal2json`.

### Logical Replication {#logical-replication}
Replication au niveau SQL (INSERT/UPDATE/DELETE) entre un publisher et un subscriber. Permet la replication selective (tables specifiques), cross-version et cross-platform. Ne replique pas le DDL ni les sequences.

### Partition Pruning {#partition-pruning}
Optimisation du query planner qui exclut automatiquement les partitions non pertinentes lors d'une requete. Si une table est partitionnee par date et qu'on filtre sur un mois specifique, seule la partition correspondante est scannee.

### Patroni {#patroni}
Outil open-source de haute disponibilite pour PostgreSQL. Gere automatiquement le failover, l'election du leader et la configuration des standbys via un consensus distribue (etcd, Consul, ZooKeeper).

### pg_basebackup {#pg-basebackup}
Utilitaire PostgreSQL pour creer une copie physique complete d'un cluster (backup de base). Sert de point de depart pour le PITR (Point-in-Time Recovery) et la creation de standbys.

### pg_stat_replication {#pg-stat-replication}
Vue systeme qui affiche l'etat de chaque connexion de replication : sent_lsn, write_lsn, flush_lsn, replay_lsn. Permet de calculer le lag de replication en bytes et en temps.

### PITR (Point-in-Time Recovery) {#pitr}
Technique de restauration qui permet de recuperer une base a un instant precis dans le passe en rejouant les WAL archives depuis un backup de base. Configure via `recovery_target_time` ou `recovery_target_lsn`.

### Predicate Lock (SIReadLock) {#predicate-lock}
Mecanisme interne utilise par le niveau d'isolation Serializable (SSI) pour tracer les dependances de lecture entre transactions. Ne bloque pas — trace uniquement. Permet de detecter les anomalies de serialisation (write skew) sans verrous bloquants.

### Publication {#publication}
Objet PostgreSQL qui definit un ensemble de tables dont les changements seront repliques via la replication logique. Cree avec `CREATE PUBLICATION`. Un subscriber peut s'abonner a une ou plusieurs publications.

### Replication Lag {#replication-lag}
Retard entre le serveur primaire et un standby/subscriber. Mesure en bytes (difference de LSN) ou en temps. Un lag eleve signifie que le standby n'est pas a jour — critique pour les lectures sur les replicas.

### Replication Slot {#replication-slot}
Mecanisme qui empeche PostgreSQL de recycler les WAL avant qu'un subscriber/standby les ait consommes. Garantit qu'aucun changement n'est perdu, mais peut causer une accumulation de WAL si le consumer est en retard.

### Streaming Replication {#streaming-replication}
Replication physique ou le standby recoit les WAL en continu depuis le primaire via une connexion TCP. Copie bit-a-bit, le standby est une replique exacte. Base de la haute disponibilite PostgreSQL.

### Subscription {#subscription}
Objet PostgreSQL sur un serveur subscriber qui s'abonne a une publication sur un autre serveur. Cree avec `CREATE SUBSCRIPTION`. Recoit et applique les changements en temps reel via la replication logique.

### Visibility Map {#visibility-map}
Structure annexe de chaque table qui indique quelles pages contiennent uniquement des tuples visibles par toutes les transactions. Utilisee par l'Index Only Scan pour eviter de lire le heap, et par VACUUM pour savoir quelles pages ignorer.
