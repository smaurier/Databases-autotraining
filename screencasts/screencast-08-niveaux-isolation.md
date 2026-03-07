# Screencast 08 — Niveaux d'isolation et MVCC

## Informations
- **Durée estimée** : 20-22 min
- **Module** : `modules/08-niveaux-isolation.md`
- **Lab associé** : `labs/lab-08-isolation-levels/`
- **Prérequis** : Module 04 (transactions) terminé, PostgreSQL running, base `course_db`

## Setup
- [ ] PostgreSQL running (Docker ou local)
- [ ] **Deux terminaux** ouverts dans `postgres-course/`
- [ ] Éditeur de code ouvert
- [ ] **Deux sessions psql** connectées à `course_db` (Terminal 1 et Terminal 2)
- [ ] Navigateur prêt pour `mvcc-isolation.html`

## Script

### [00:00-03:30] MVCC — Concept fondamental (xmin / xmax)

> PostgreSQL n'utilise pas de verrous pour gérer les lectures concurrentes. Il utilise MVCC — Multi-Version Concurrency Control. Chaque ligne a plusieurs versions, et chaque transaction voit un snapshot cohérent des données.

**Action** : Afficher un schéma du modèle MVCC avec xmin/xmax.

> Chaque ligne dans PostgreSQL a deux champs cachés : `xmin` (l'id de la transaction qui a créé cette version) et `xmax` (l'id de la transaction qui l'a supprimée ou modifiée). Quand vous faites un UPDATE, PostgreSQL ne modifie pas la ligne — il crée une nouvelle version et marque l'ancienne avec xmax.

**Action** : Créer une table et observer xmin/xmax.

```sql
-- Table de démonstration
CREATE TABLE inventory (
    id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item  VARCHAR(50) NOT NULL,
    qty   INTEGER NOT NULL CHECK (qty >= 0)
);

INSERT INTO inventory (item, qty) VALUES
    ('Widget A', 100),
    ('Widget B', 50),
    ('Widget C', 200);

-- Voir les champs cachés xmin et xmax
SELECT xmin, xmax, ctid, * FROM inventory;
```

> `xmin` est l'id de la transaction INSERT. `xmax` est 0 car la ligne n'a pas encore été modifiée. `ctid` est l'emplacement physique (page, offset).

**Action** : Pointer xmin, xmax et ctid dans la sortie.

```sql
-- Modifier une ligne et observer
UPDATE inventory SET qty = 90 WHERE item = 'Widget A';
SELECT xmin, xmax, ctid, * FROM inventory WHERE item = 'Widget A';

-- xmin a changé (nouvelle version), ctid aussi (nouvel emplacement)
```

**Action** : Comparer les xmin/ctid avant et après l'UPDATE.

### [03:30-08:00] Read Committed — Démo avec deux terminaux

> Read Committed est le niveau d'isolation par défaut de PostgreSQL. Chaque requête au sein d'une transaction voit les données committées au moment où la requête commence.

**Action** : Disposer les deux terminaux côte à côte.

```sql
-- === TERMINAL 1 ===
BEGIN;
SELECT qty FROM inventory WHERE item = 'Widget A';
-- Résultat : 90
```

```sql
-- === TERMINAL 2 ===
BEGIN;
UPDATE inventory SET qty = 80 WHERE item = 'Widget A';
COMMIT;
```

```sql
-- === TERMINAL 1 (toujours dans la même transaction) ===
-- Re-exécuter la même requête
SELECT qty FROM inventory WHERE item = 'Widget A';
-- Résultat : 80 (!) — on voit le changement de Terminal 2
-- C'est le "non-repeatable read" : dans Read Committed,
-- chaque SELECT voit les données les plus récentes committées.
COMMIT;
```

> C'est le comportement attendu en Read Committed : chaque SELECT au sein d'une transaction peut retourner des résultats différents si d'autres transactions committent entre-temps. C'est suffisant pour la plupart des applications.

**Action** : Exécuter les commandes dans l'ordre exact, en basculant entre Terminal 1 et Terminal 2. Montrer que le deuxième SELECT retourne une valeur différente.

### [08:00-13:00] Repeatable Read — Démo

> Repeatable Read garantit que tous les SELECT dans une transaction voient le même snapshot. Les modifications committées par d'autres transactions ne sont pas visibles.

**Action** : Réinitialiser et recommencer avec Repeatable Read.

```sql
-- Remettre à zéro
UPDATE inventory SET qty = 100 WHERE item = 'Widget A';
```

```sql
-- === TERMINAL 1 ===
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT qty FROM inventory WHERE item = 'Widget A';
-- Résultat : 100
```

```sql
-- === TERMINAL 2 ===
BEGIN;
UPDATE inventory SET qty = 75 WHERE item = 'Widget A';
COMMIT;
```

```sql
-- === TERMINAL 1 ===
-- Même requête dans la même transaction
SELECT qty FROM inventory WHERE item = 'Widget A';
-- Résultat : 100 (!) — on ne voit PAS le changement de Terminal 2
-- Le snapshot est figé au début de la transaction.

-- Que se passe-t-il si Terminal 1 essaie de modifier la même ligne ?
UPDATE inventory SET qty = qty - 10 WHERE item = 'Widget A';
-- ERREUR : could not serialize access due to concurrent update
ROLLBACK;
```

> En Repeatable Read, PostgreSQL détecte le conflit d'écriture et lance une erreur de sérialisation. L'application doit retenter la transaction. C'est le compromis : plus de cohérence, mais il faut gérer les retries.

**Action** : Montrer l'erreur de sérialisation clairement dans Terminal 1. Expliquer qu'il faut retenter.

### [13:00-16:30] Serializable + retry pattern

> Serializable est le niveau le plus strict. Il garantit que le résultat est identique à une exécution séquentielle des transactions, même si elles s'exécutent en parallèle.

**Action** : Montrer un cas de write skew et le retry pattern en Node.js.

```sql
-- Remettre à zéro
UPDATE inventory SET qty = 100 WHERE item = 'Widget A';
UPDATE inventory SET qty = 50 WHERE item = 'Widget B';
```

```sql
-- === TERMINAL 1 ===
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT SUM(qty) FROM inventory;
-- Résultat : 350 (100 + 50 + 200)
UPDATE inventory SET qty = qty - 50 WHERE item = 'Widget A';
-- (ne commit pas encore)
```

```sql
-- === TERMINAL 2 ===
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT SUM(qty) FROM inventory;
-- Résultat : 350 (même snapshot)
UPDATE inventory SET qty = qty - 50 WHERE item = 'Widget B';
COMMIT;
```

```sql
-- === TERMINAL 1 ===
COMMIT;
-- ERREUR : could not serialize access due to read/write dependencies
```

**Action** : Montrer le pattern de retry en Node.js.

```javascript
// demo-retry.js
const { Pool } = require('pg');
const pool = new Pool({
  host: 'localhost', port: 5432,
  user: 'postgres', password: 'secret', database: 'course_db',
});

async function withRetry(fn, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '40001' && attempt < maxRetries) {
        // Serialization failure — on retente
        console.log(`Tentative ${attempt} échouée, retry...`);
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

async function main() {
  const result = await withRetry(async (client) => {
    const { rows } = await client.query('SELECT SUM(qty) AS total FROM inventory');
    console.log('Total :', rows[0].total);
    await client.query(
      'UPDATE inventory SET qty = qty - 10 WHERE item = $1',
      ['Widget A']
    );
    return 'OK';
  });
  console.log('Résultat :', result);
  await pool.end();
}

main().catch(console.error);
```

> Le code d'erreur `40001` est le code PostgreSQL pour les erreurs de sérialisation. On le capture et on retente. Ce pattern est obligatoire avec Serializable.

**Action** : Exécuter le script et montrer la sortie.

### [16:30-19:00] Visualisation mvcc-isolation.html

> Utilisons la visualisation interactive pour comprendre comment MVCC fonctionne sous le capot.

**Action** : Ouvrir `visualizations/mvcc-isolation.html` dans le navigateur.

> Cette visualisation montre les versions de lignes avec xmin/xmax. Quand une transaction fait un UPDATE, une nouvelle version est créée. Selon le niveau d'isolation, les transactions voient des versions différentes de la même ligne.

**Action** : Jouer avec la visualisation : créer deux transactions, modifier une ligne, et montrer quelles versions sont visibles pour chaque transaction selon le niveau d'isolation.

```sql
-- Voir les transactions actives et leur snapshot
SELECT pid, xact_start, state, query
FROM pg_stat_activity
WHERE datname = 'course_db' AND state != 'idle';
```

**Action** : Montrer pg_stat_activity pendant que les deux terminaux ont des transactions ouvertes.

### [19:00-20:30] Démo Lab-08

> Le lab 08 vous fait expérimenter les trois niveaux d'isolation avec des scénarios concrets.

**Action** : Ouvrir `labs/lab-08-isolation-levels/` et parcourir les exercices.

```sql
-- Aperçu lab-08
-- Exercice 1 : Observer le non-repeatable read en Read Committed
-- Exercice 2 : Tester Repeatable Read et gérer l'erreur de sérialisation
-- Exercice 3 : Provoquer un write skew en Serializable
-- Exercice 4 : Implémenter le retry pattern en Node.js
```

**Action** : Montrer les instructions du lab et les résultats attendus.

### [20:30-21:30] Conclusion

> MVCC est ce qui rend PostgreSQL si performant en lecture concurrente : les lecteurs ne bloquent jamais les écrivains. On a vu les trois niveaux d'isolation — Read Committed, Repeatable Read, Serializable — et leurs compromis. Dans le prochain module, on aborde les verrous explicites et les locks.

**Action** : Nettoyage.

```sql
DROP TABLE IF EXISTS inventory;
```

## Points d'attention pour l'enregistrement
- Les deux terminaux doivent être bien visibles côte à côte
- Numéroter clairement les terminaux (Terminal 1, Terminal 2) à l'écran
- Exécuter les commandes dans l'ordre exact pour reproduire les anomalies
- Bien laisser le temps de voir les résultats avant de basculer entre terminaux
- Tester le scénario Serializable avant l'enregistrement — le timing est important
- La visualisation MVCC doit être pré-chargée et fonctionnelle
