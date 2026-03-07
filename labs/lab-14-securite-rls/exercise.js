// =============================================================================
// Lab 14 — Securite & RLS (Exercice)
// =============================================================================

import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.js';

const { test, assert, assertEqual, assertIncludes, assertGreaterThan, assertLessThan, summary } = createTestRunner('Lab 14 — Securite & RLS');

// ---------------------------------------------------------------------------
// Schema et donnees de test
// ---------------------------------------------------------------------------
const SETUP_SQL = `
  -- Nettoyage
  DROP TABLE IF EXISTS tenant_data CASCADE;
  DROP TABLE IF EXISTS tenants CASCADE;
  DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_data;

  -- Supprimer les roles s'ils existent
  DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'tenant_role') THEN
      -- Revoquer les privileges avant de supprimer le role
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM tenant_role;
      DROP ROLE tenant_role;
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'admin_role') THEN
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM admin_role;
      DROP ROLE admin_role;
    END IF;
  END $$;

  -- Schema
  CREATE TABLE tenants (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL
  );

  CREATE TABLE tenant_data (
    id SERIAL PRIMARY KEY,
    tenant_id INT REFERENCES tenants(id),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );

  -- Donnees de test
  INSERT INTO tenants (id, name) VALUES
    (1, 'Entreprise Alpha'),
    (2, 'Entreprise Beta'),
    (3, 'Entreprise Gamma');

  INSERT INTO tenant_data (tenant_id, content) VALUES
    (1, 'Document confidentiel Alpha 1'),
    (1, 'Document confidentiel Alpha 2'),
    (1, 'Rapport interne Alpha'),
    (2, 'Document confidentiel Beta 1'),
    (2, 'Document confidentiel Beta 2'),
    (2, 'Rapport interne Beta'),
    (3, 'Document confidentiel Gamma 1'),
    (3, 'Rapport interne Gamma');
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function run() {
  const client = await createClient();

  try {
    await setupDatabase(client, SETUP_SQL);
    console.log('\n🔐 Lab 14 — Securite & RLS\n');

    // -----------------------------------------------------------------------
    // Test 1 : Creer des roles
    // -----------------------------------------------------------------------
    await test('Creer des roles admin_role et tenant_role', async () => {
      // TODO:
      // 1. CREATE ROLE admin_role
      // 2. CREATE ROLE tenant_role
      // 3. Verifier leur existence dans pg_roles :
      //    SELECT rolname FROM pg_roles WHERE rolname IN ('admin_role', 'tenant_role')
      // 4. Verifier qu'on obtient 2 resultats
    });

    // -----------------------------------------------------------------------
    // Test 2 : GRANT SELECT, INSERT
    // -----------------------------------------------------------------------
    await test('GRANT SELECT, INSERT sur tenant_data a tenant_role', async () => {
      // TODO:
      // 1. GRANT SELECT, INSERT ON tenant_data TO tenant_role
      // 2. Verifier les privileges avec :
      //    SELECT privilege_type FROM information_schema.role_table_grants
      //    WHERE grantee = 'tenant_role' AND table_name = 'tenant_data'
      // 3. Verifier que SELECT et INSERT sont accordes
    });

    // -----------------------------------------------------------------------
    // Test 3 : REVOKE DELETE
    // -----------------------------------------------------------------------
    await test('REVOKE DELETE — verifier l\'interdiction', async () => {
      // TODO:
      // 1. S'assurer que DELETE n'est pas accorde :
      //    REVOKE DELETE ON tenant_data FROM tenant_role
      // 2. Verifier les privileges : DELETE ne doit PAS etre dans la liste
      //    SELECT privilege_type FROM information_schema.role_table_grants
      //    WHERE grantee = 'tenant_role' AND table_name = 'tenant_data'
      // 3. Verifier que 'DELETE' n'est pas dans les resultats
    });

    // -----------------------------------------------------------------------
    // Test 4 : Activer RLS
    // -----------------------------------------------------------------------
    await test('Activer RLS sur tenant_data', async () => {
      // TODO:
      // 1. ALTER TABLE tenant_data ENABLE ROW LEVEL SECURITY
      // 2. Verifier avec :
      //    SELECT relrowsecurity FROM pg_class WHERE relname = 'tenant_data'
      // 3. Verifier que relrowsecurity est true
    });

    // -----------------------------------------------------------------------
    // Test 5 : Creer une politique de securite
    // -----------------------------------------------------------------------
    await test('Politique de securite avec current_setting', async () => {
      // TODO:
      // 1. Creer la politique :
      //    CREATE POLICY tenant_isolation_policy ON tenant_data
      //    FOR ALL
      //    TO tenant_role
      //    USING (tenant_id = current_setting('app.tenant_id')::int)
      //    WITH CHECK (tenant_id = current_setting('app.tenant_id')::int)
      // 2. Verifier l'existence de la politique :
      //    SELECT polname FROM pg_policy WHERE polrelid = 'tenant_data'::regclass
      // 3. Verifier que la politique existe
    });

    // -----------------------------------------------------------------------
    // Test 6 : Tenant 1 ne voit que ses donnees
    // -----------------------------------------------------------------------
    await test('Tenant 1 ne voit que ses propres donnees', async () => {
      // TODO:
      // 1. SET app.tenant_id = '1'
      // 2. SET ROLE tenant_role
      // 3. SELECT * FROM tenant_data → ne doit retourner que les donnees du tenant 1
      // 4. Verifier que tous les resultats ont tenant_id = 1
      // 5. Verifier qu'on a 3 resultats (les 3 documents Alpha)
      // 6. RESET ROLE (revenir au superutilisateur)
    });

    // -----------------------------------------------------------------------
    // Test 7 : Tenant 2 ne voit que ses donnees
    // -----------------------------------------------------------------------
    await test('Tenant 2 ne voit que ses propres donnees', async () => {
      // TODO:
      // 1. SET app.tenant_id = '2'
      // 2. SET ROLE tenant_role
      // 3. SELECT * FROM tenant_data → ne doit retourner que les donnees du tenant 2
      // 4. Verifier que tous les resultats ont tenant_id = 2
      // 5. Verifier qu'on a 3 resultats (les 3 documents Beta)
      // 6. RESET ROLE
    });

    // -----------------------------------------------------------------------
    // Test 8 : Admin / superutilisateur contourne le RLS
    // -----------------------------------------------------------------------
    await test('Le superutilisateur contourne le RLS', async () => {
      // TODO:
      // 1. S'assurer qu'on est le superutilisateur (RESET ROLE si necessaire)
      // 2. SELECT * FROM tenant_data → doit retourner TOUTES les donnees
      // 3. Verifier qu'on a 8 resultats (tous les documents de tous les tenants)
      // 4. Verifier que les 3 tenant_id sont presents
    });

    summary();
  } finally {
    // Nettoyage complet
    await query(client, 'RESET ROLE').catch(() => {});
    await teardownDatabase(client, `
      DROP POLICY IF EXISTS tenant_isolation_policy ON tenant_data;
      DROP TABLE IF EXISTS tenant_data CASCADE;
      DROP TABLE IF EXISTS tenants CASCADE;
      DO $$ BEGIN
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'tenant_role') THEN
          REVOKE ALL ON ALL TABLES IN SCHEMA public FROM tenant_role;
          DROP ROLE tenant_role;
        END IF;
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'admin_role') THEN
          REVOKE ALL ON ALL TABLES IN SCHEMA public FROM admin_role;
          DROP ROLE admin_role;
        END IF;
      END $$;
    `);
    await client.end();
  }
}

run().catch(console.error);
