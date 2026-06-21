# Screencast 00 — Prérequis et vue d'ensemble

## Informations

- **Durée estimée** : 12-15 min
- **Module** : `modules/00-prerequis-et-vue-ensemble.md`
- **Lab associé** : aucun
- **Prérequis** : Docker installé, Node.js >= 18, éditeur de code

## Setup

- [ ] Docker Desktop lancé
- [ ] Terminal ouvert dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] Navigateur prêt pour la documentation PostgreSQL

## Script

### [00:00-02:30] Introduction — Pourquoi PostgreSQL

> Bienvenue dans ce cours complet sur PostgreSQL. On va commencer par comprendre pourquoi PostgreSQL est devenu la base de données relationnelle la plus populaire chez les développeurs. PostgreSQL est open-source, extrêmement robuste, et il supporte des fonctionnalités avancées comme le JSONB, le full-text search, ou encore le Row Level Security — des choses que d'autres bases ne proposent pas nativement.

**Action** : Afficher la page d'accueil de postgresql.org et montrer le slogan "The World's Most Advanced Open Source Relational Database".

> Dans ce cours, on va partir de zéro et aller jusqu'à des notions avancées : transactions, index, concurrence, optimisation. Tout sera illustré avec du SQL pur et du code Node.js.

**Action** : Afficher le plan du cours dans `index.md` et scroller lentement sur les 16 modules.

### [02:30-05:30] Setup Docker PostgreSQL

> Pour commencer, on va lancer PostgreSQL via Docker. C'est le moyen le plus rapide et le plus propre d'avoir une instance PostgreSQL.

**Action** : Ouvrir le terminal et taper les commandes suivantes.

```bash
# Vérifier que Docker est disponible
docker --version

# Lancer PostgreSQL 17 dans un conteneur
docker run --name pg-course \
  -e POSTGRES_PASSWORD=secret \
  -e POSTGRES_DB=course_db \
  -p 5432:5432 \
  -d postgres:17

# Vérifier que le conteneur tourne
docker ps
```

> On utilise PostgreSQL 17. Le mot de passe est "secret" pour simplifier — évidemment, en production, on utiliserait un mot de passe robuste.

**Action** : Montrer la sortie de `docker ps` avec le conteneur qui tourne, le port 5432 mappé.

### [05:30-08:30] Premier contact avec psql

> Maintenant qu'on a PostgreSQL qui tourne, connectons-nous avec `psql`, le client en ligne de commande officiel.

**Action** : Se connecter à PostgreSQL et explorer les commandes de base.

```bash
# Se connecter via psql
docker exec -it pg-course psql -U postgres -d course_db
```

```sql
-- Vérifier la version
SELECT version();

-- Lister les bases de données
\l

-- Afficher les tables (vide pour l'instant)
\dt

-- Créer une table simple pour tester
CREATE TABLE test (id SERIAL PRIMARY KEY, message TEXT);
INSERT INTO test (message) VALUES ('Hello PostgreSQL!');
SELECT * FROM test;

-- Supprimer la table de test
DROP TABLE test;

-- Quitter psql
\q
```

> `psql` est votre meilleur ami pour explorer PostgreSQL. Les commandes commençant par `\` sont des méta-commandes psql : `\l` liste les bases, `\dt` les tables, `\d+ nom_table` la structure détaillée d'une table.

**Action** : Exécuter chaque commande une par une, en laissant le temps de voir la sortie. Mettre en évidence la sortie de `SELECT version()`.

### [08:30-11:30] Hello World Node.js + pg

> Passons maintenant au côté applicatif. On va connecter une application Node.js à notre base PostgreSQL.

**Action** : Ouvrir l'éditeur et créer un fichier de démo.

```bash
# Installer le driver PostgreSQL pour Node.js
npm install pg
```

```javascript
// demo-hello.js
const { Client } = require("pg");

async function main() {
  const client = new Client({
    host: "localhost",
    port: 5432,
    user: "postgres",
    password: "secret",
    database: "course_db",
  });

  await client.connect();
  console.log("Connecté à PostgreSQL !");

  // Requête simple
  const res = await client.query("SELECT NOW() AS heure_actuelle");
  console.log("Heure serveur :", res.rows[0].heure_actuelle);

  // Requête paramétrée (bonne pratique)
  const name = "PostgreSQL";
  const greeting = await client.query(
    "SELECT $1::text || ' est formidable !'  AS message",
    [name],
  );
  console.log(greeting.rows[0].message);

  await client.end();
}

main().catch(console.error);
```

**Action** : Exécuter le script avec `node demo-hello.js` et montrer la sortie dans le terminal.

```bash
node demo-hello.js
# Sortie attendue :
# Connecté à PostgreSQL !
# Heure serveur : 2025-xx-xx ...
# PostgreSQL est formidable !
```

> Notez l'utilisation de `$1` pour le paramètre. On ne concatène jamais de valeurs utilisateur dans une requête SQL — c'est la règle numéro un pour éviter les injections SQL.

### [11:30-13:30] Tour du cours

> Faisons un tour rapide de ce qui vous attend dans ce cours.

**Action** : Afficher `index.md` et parcourir les modules un par un.

> Les modules 1 à 3 couvrent les fondamentaux : modèle relationnel, CRUD, jointures. Les modules 4 à 7 plongent dans les transactions, les index et le query planner. Les modules 8 à 10 traitent de la concurrence : isolation, verrous, deadlocks. Les modules 11 à 14 abordent les performances, les fonctions avancées SQL, le JSONB et la sécurité. Enfin, le module 15 est un projet final complet.

**Action** : Montrer la structure du dossier `postgres-course/` dans l'éditeur : modules, labs, visualizations, screencasts.

> Chaque module à un lab pratique associé. Je vous encourage à toujours faire le lab après avoir regardé le screencast correspondant. C'est en pratiquant qu'on apprend vraiment.

**Action** : Ouvrir rapidement un dossier lab pour montrer la structure (README, fichiers SQL, tests).

### [13:30-14:30] Conclusion

> Voilà, votre environnement est prêt. PostgreSQL tourne dans Docker, vous savez vous connecter avec psql et avec Node.js. On est prêts pour attaquer le module 1 sur le modèle relationnel. À tout de suite !

**Action** : Revenir au terminal et montrer que le conteneur tourne toujours avec `docker ps`.

## Points d'attention pour l'enregistrement

- Vérifier que Docker Desktop est lancé avant de commencer
- Taper les commandes assez lentement pour que le spectateur puisse suivre
- Bien montrer la sortie de chaque commande avant de passer à la suivante
- Zoomer sur le terminal pour une bonne lisibilité
- S'assurer que le port 5432 n'est pas déjà utilisé par une autre instance
- Préparer le fichier `demo-hello.js` à l'avance en cas de faute de frappe
