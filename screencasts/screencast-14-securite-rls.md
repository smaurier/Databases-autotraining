# Screencast 14 — Sécurité et administration

## Informations
- **Durée estimée** : 18-20 min
- **Module** : `modules/14-securite-et-administration.md`
- **Lab associé** : `labs/lab-14-securite-rls/`
- **Prérequis** : Modules précédents terminés, PostgreSQL running, base `course_db`

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] Terminal ouvert dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] `psql` connecté à `course_db` en tant que `postgres` (superuser)

## Script

### [00:00-02:30] Introduction — Roles et GRANT/REVOKE

> La sécurité dans PostgreSQL repose sur un système de rôles et de privilèges. Un rôle peut être un utilisateur (avec LOGIN) ou un groupe (sans LOGIN). Les privilèges sont accordés avec GRANT et retirés avec REVOKE.

**Action** : Créer les rôles et les tables de démonstration.

```sql
-- Voir les rôles existants
\du

-- Créer des rôles
CREATE ROLE app_readonly WITH LOGIN PASSWORD 'readonly123';
CREATE ROLE app_readwrite WITH LOGIN PASSWORD 'readwrite123';
CREATE ROLE app_admin WITH LOGIN PASSWORD 'admin123';

-- Créer un rôle de groupe (sans LOGIN)
CREATE ROLE developers;

-- Ajouter des rôles au groupe
GRANT developers TO app_readwrite;
GRANT developers TO app_admin;

-- Table de démonstration
CREATE TABLE customers (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    email       VARCHAR(255) NOT NULL UNIQUE,
    company     VARCHAR(100),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO customers (name, email, company) VALUES
    ('Alice Martin', 'alice@acme.com', 'Acme Corp'),
    ('Bob Dupont', 'bob@techno.fr', 'Techno SA'),
    ('Charlie Petit', 'charlie@acme.com', 'Acme Corp'),
    ('Diana Leroy', 'diana@startup.io', 'Startup IO');
```

### [02:30-06:00] GRANT et REVOKE en pratique

> GRANT accorde des privilèges spécifiques sur des objets spécifiques à des rôles spécifiques.

**Action** : Configurer les privilèges pour chaque rôle.

```sql
-- Accorder les privilèges sur le schéma
GRANT USAGE ON SCHEMA public TO app_readonly, app_readwrite, app_admin;

-- app_readonly : lecture seule
GRANT SELECT ON ALL TABLES IN SCHEMA public TO app_readonly;

-- app_readwrite : lecture + écriture
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_readwrite;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_readwrite;

-- app_admin : tout (mais pas superuser)
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO app_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO app_admin;

-- Vérifier les privilèges
\dp customers
```

**Action** : Montrer la sortie de `\dp` avec les privilèges de chaque rôle.

```sql
-- Tester en se connectant avec app_readonly
SET ROLE app_readonly;

SELECT * FROM customers;  -- OK
INSERT INTO customers (name, email) VALUES ('Test', 'test@test.com');
-- ERREUR : permission denied for table customers

RESET ROLE;  -- Revenir à postgres

-- Tester avec app_readwrite
SET ROLE app_readwrite;

INSERT INTO customers (name, email, company)
VALUES ('Eve Moreau', 'eve@techno.fr', 'Techno SA')
RETURNING *;  -- OK

RESET ROLE;

-- REVOKE : retirer des privilèges
REVOKE DELETE ON customers FROM app_readwrite;

SET ROLE app_readwrite;
DELETE FROM customers WHERE name = 'Eve Moreau';
-- ERREUR : permission denied
RESET ROLE;
```

> Le principe du moindre privilège : chaque rôle ne doit avoir que les permissions strictement nécessaires. L'application web se connecte avec `app_readwrite`, le dashboard analytique avec `app_readonly`.

**Action** : Montrer les erreurs de permission et le succès selon le rôle.

### [06:00-11:00] Row Level Security (RLS)

> RLS va plus loin que les GRANTs : il filtre les lignes visibles en fonction du rôle connecté. Chaque utilisateur ne voit que ses propres données.

**Action** : Activer RLS et créer des politiques.

```sql
-- Table multi-tenant
CREATE TABLE documents (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title       VARCHAR(200) NOT NULL,
    content     TEXT,
    owner       VARCHAR(50) NOT NULL,
    tenant_id   VARCHAR(50) NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO documents (title, content, owner, tenant_id) VALUES
    ('Rapport Q1', 'Résultats du premier trimestre...', 'alice', 'acme'),
    ('Budget 2025', 'Prévisions budgétaires...', 'alice', 'acme'),
    ('Plan stratégique', 'Objectifs à 5 ans...', 'bob', 'acme'),
    ('Rapport Q1', 'Résultats Techno SA...', 'charlie', 'techno'),
    ('Roadmap produit', 'Features prévues...', 'charlie', 'techno'),
    ('Contrat client', 'Termes et conditions...', 'diana', 'techno');

-- Activer RLS sur la table
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

-- Politique : chaque utilisateur ne voit que ses propres documents
CREATE POLICY user_documents ON documents
    FOR ALL
    USING (owner = current_user);

-- Accorder les permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO app_readwrite;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_readwrite;
```

```sql
-- Créer des utilisateurs pour la démo
CREATE ROLE alice WITH LOGIN PASSWORD 'alice123';
CREATE ROLE bob WITH LOGIN PASSWORD 'bob123';
GRANT SELECT, INSERT, UPDATE, DELETE ON documents TO alice, bob;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO alice, bob;

-- Tester avec alice
SET ROLE alice;
SELECT * FROM documents;
-- Ne voit que ses 2 documents !

RESET ROLE;

-- Tester avec bob
SET ROLE bob;
SELECT * FROM documents;
-- Ne voit que son 1 document !

INSERT INTO documents (title, content, owner, tenant_id)
VALUES ('Note de Bob', 'Contenu...', 'bob', 'acme');
-- OK — Bob peut insérer pour lui-même

INSERT INTO documents (title, content, owner, tenant_id)
VALUES ('Hack', 'Contenu...', 'alice', 'acme');
-- Inséré mais Bob ne pourra pas le voir (owner = 'alice', pas 'bob')

RESET ROLE;
```

> RLS est transparent pour l'application. Elle envoie un simple `SELECT * FROM documents` et PostgreSQL filtre automatiquement selon l'utilisateur connecté. Pas besoin de `WHERE owner = ?` dans chaque requête.

**Action** : Montrer que alice et bob voient des résultats différents pour le même SELECT.

### [11:00-14:00] Multi-tenant RLS

> Le pattern multi-tenant utilise RLS pour isoler les données de chaque entreprise (tenant). On utilise une variable de session au lieu de `current_user`.

**Action** : Implémenter un RLS multi-tenant.

```sql
-- Supprimer l'ancienne politique
DROP POLICY user_documents ON documents;

-- Nouvelle politique basée sur le tenant_id
CREATE POLICY tenant_isolation ON documents
    FOR ALL
    USING (tenant_id = current_setting('app.tenant_id', true));

-- Simuler une connexion pour le tenant 'acme'
SET app.tenant_id = 'acme';

SET ROLE app_readwrite;
SELECT * FROM documents;
-- Ne voit que les documents de 'acme' (4 documents)

RESET ROLE;

-- Simuler une connexion pour le tenant 'techno'
SET app.tenant_id = 'techno';

SET ROLE app_readwrite;
SELECT * FROM documents;
-- Ne voit que les documents de 'techno' (3 documents)

RESET ROLE;
```

**Action** : Montrer le code Node.js pour configurer le tenant.

```javascript
// demo-rls-tenant.js
const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost', port: 5432,
  user: 'app_readwrite', password: 'readwrite123',
  database: 'course_db',
});

async function getDocuments(tenantId) {
  const client = await pool.connect();
  try {
    // Configurer le tenant pour cette connexion
    await client.query('SET app.tenant_id = $1', [tenantId]);

    const { rows } = await client.query('SELECT title, owner FROM documents');
    console.log(`Documents pour ${tenantId}:`, rows);
    return rows;
  } finally {
    // IMPORTANT : réinitialiser avant de rendre la connexion au pool
    await client.query('RESET app.tenant_id');
    client.release();
  }
}

async function main() {
  await getDocuments('acme');
  await getDocuments('techno');
  await pool.end();
}

main().catch(console.error);
```

> Le `RESET app.tenant_id` dans le finally est crucial. Sans ça, une connexion du pool pourrait garder le tenant_id d'une requête précédente et exposer les données d'un autre tenant.

**Action** : Exécuter le script et montrer que chaque appel retourne les documents du bon tenant.

### [14:00-16:00] pg_dump / pg_restore

> La sauvegarde est essentielle. `pg_dump` exporte une base et `pg_restore` la restaure.

**Action** : Démontrer pg_dump et pg_restore.

```bash
# Sauvegarder la base en format custom (compressé, flexible)
docker exec -it pg-course pg_dump -U postgres -d course_db -Fc -f /tmp/course_db.dump

# Sauvegarder en SQL pur (lisible)
docker exec -it pg-course pg_dump -U postgres -d course_db --schema-only > schema.sql

# Sauvegarder uniquement les données
docker exec -it pg-course pg_dump -U postgres -d course_db --data-only -t customers > customers_data.sql

# Restaurer dans une nouvelle base
docker exec -it pg-course createdb -U postgres course_db_copy
docker exec -it pg-course pg_restore -U postgres -d course_db_copy /tmp/course_db.dump

# Vérifier la restauration
docker exec -it pg-course psql -U postgres -d course_db_copy -c "SELECT COUNT(*) FROM customers"
```

> Le format custom (`-Fc`) est recommandé pour les sauvegardes de production. Il est compressé et permet de restaurer sélectivement (une seule table, uniquement le schéma, etc.).

**Action** : Montrer la taille du dump et la restauration réussie.

### [16:00-18:00] Monitoring — pg_stat_*

> PostgreSQL fournit de nombreuses vues statistiques pour le monitoring. Les plus utiles sont `pg_stat_activity`, `pg_stat_user_tables` et `pg_stat_user_indexes`.

**Action** : Parcourir les vues de monitoring.

```sql
-- Connexions actives
SELECT
    pid,
    usename,
    state,
    query_start,
    LEFT(query, 80) AS query
FROM pg_stat_activity
WHERE datname = 'course_db'
ORDER BY query_start DESC;

-- Statistiques par table
SELECT
    relname AS table_name,
    seq_scan,
    idx_scan,
    n_tup_ins AS inserts,
    n_tup_upd AS updates,
    n_tup_del AS deletes,
    n_live_tup AS live_rows,
    n_dead_tup AS dead_rows
FROM pg_stat_user_tables
ORDER BY seq_scan DESC;

-- Index inutilisés (candidats à la suppression)
SELECT
    indexrelname AS index_name,
    relname AS table_name,
    idx_scan AS times_used,
    pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;

-- Taille des tables
SELECT
    relname AS table_name,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
    pg_size_pretty(pg_relation_size(relid)) AS data_size,
    pg_size_pretty(pg_indexes_size(relid)) AS index_size
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```

> Les index inutilisés (`idx_scan = 0`) sont des candidats à la suppression. Ils occupent de l'espace et ralentissent les écritures sans bénéfice.

**Action** : Montrer les statistiques et commenter les tables/index problématiques.

### [18:00-19:00] Démo Lab-14

> Le lab 14 vous fait configurer les rôles, implémenter RLS, et mettre en place le monitoring.

**Action** : Ouvrir `labs/lab-14-securite-rls/` et parcourir les exercices.

```sql
-- Aperçu lab-14
-- Exercice 1 : Créer des rôles et configurer GRANT/REVOKE
-- Exercice 2 : Implémenter RLS pour l'isolation des données
-- Exercice 3 : Multi-tenant RLS avec variable de session
-- Exercice 4 : Backup et restore avec pg_dump
-- Exercice 5 : Créer un dashboard de monitoring avec pg_stat_*
```

**Action** : Montrer les fichiers du lab et les résultats attendus.

### [19:00-19:45] Conclusion

> La sécurité PostgreSQL est mature et complète. Les rôles et GRANT/REVOKE contrôlent l'accès aux objets. Le Row Level Security filtre les lignes visibles — parfait pour le multi-tenant. pg_dump assure les sauvegardes. Et les vues pg_stat_* donnent une visibilité complète sur la santé de la base. Dans le prochain et dernier module, on met tout en pratique dans un projet final.

**Action** : Nettoyage.

```sql
-- Supprimer les rôles créés
DROP OWNED BY alice; DROP ROLE alice;
DROP OWNED BY bob; DROP ROLE bob;
DROP OWNED BY app_readonly; DROP ROLE app_readonly;
DROP OWNED BY app_readwrite; DROP ROLE app_readwrite;
DROP OWNED BY app_admin; DROP ROLE app_admin;
DROP ROLE developers;

DROP TABLE IF EXISTS customers, documents;
DROP DATABASE IF EXISTS course_db_copy;
```

## Points d'attention pour l'enregistrement
- Se connecter en tant que `postgres` (superuser) au début
- Bien montrer les erreurs de permission quand un rôle n'a pas les droits
- Le SET ROLE / RESET ROLE est le moyen le plus simple de tester les rôles
- RLS doit être visible : montrer que le même SELECT retourne des résultats différents
- Le pg_dump peut prendre du temps sur une base volumineuse — avoir un dump pré-fait
- Les vues pg_stat_* peuvent être vides si aucune activité — lancer quelques requêtes avant
