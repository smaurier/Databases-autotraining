# Visualisations interactives

5 visualisations HTML animées pour comprendre les mécanismes internes de PostgreSQL. Ouvrez-les directement dans votre navigateur — aucune dépendance requise.

| Visualisation | Description | Module associé |
|--------------|-------------|----------------|
| [B-tree Index](./btree-index.html) | B-tree interactif : insertion, recherche O(log n), range scan animé | Modules 05-07 |
| [Query Planner](./query-planner.html) | Pipeline du query planner : Seq Scan / Index Scan / Bitmap Scan / JOIN strategies | Module 06 |
| [MVCC & Isolation](./mvcc-isolation.html) | Timeline de 2 transactions : Read Committed / Repeatable Read / Serializable avec xmin/xmax | Module 08 |
| [Lock Matrix](./lock-matrix.html) | Matrice de compatibilité des verrous, wait-for graph animé, détection de deadlock | Modules 09-10 |
| [WAL & Transactions](./wal-transaction.html) | Pipeline WAL : COMMIT → WAL → disk, ROLLBACK, crash recovery | Module 04 |

## Comment utiliser

1. Ouvrez le fichier `.html` directement dans votre navigateur
2. Utilisez les boutons **Play**, **Pause**, **Pas-à-pas** et **Reset**
3. Lisez le panneau d'explication en bas pour comprendre chaque étape
4. Essayez les différents scénarios via le menu déroulant ou les boutons

> **Conseil** : Utilisez ces visualisations pendant que vous lisez le module théorique correspondant.
