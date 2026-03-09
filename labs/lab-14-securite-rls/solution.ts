// =============================================================================
// Lab 14 — Securite & RLS (Solution)
// =============================================================================

import pg from 'pg';
import { createTestRunner, createClient, query, setupDatabase, teardownDatabase, withClient, withTransaction, sleep, measure } from '../db-test-utils.ts';

const { test, assert, assertEqual, assertIncludes, assertGreaterThan, assertLessThan, summary } = createTestRunner('Lab 14 — Securite & RLS');

// ---------------------------------------------------------------------------
// Schema et donnees de test
// ---------------------------------------------------------------------------
const SETUP_SQL = `
  -- Nettoyage
  DROP TABLE IF EXISTS tenant_data CASCADE;
  DROP TABLE IF EXISTS tenants CASCADE;

  -- Supprimer les roles s'ils existent
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
async function run(): Promise<void> {
  const client = await createClient();

  try {
    await setupDatabase(client, SETUP_SQL);
    console.log('\n🔐 Lab 14 — Securite & RLS\n');

    // -----------------------------------------------------------------------
    // Test 1 : Creer des roles
    // -----------------------------------------------------------------------
    await test('Creer des roles admin_role et tenant_role', async () => {
      await query(client, 'CREATE ROLE admin_role');
      await query(client, 'CREATE ROLE tenant_role');

      const res = await query(client, `
        SELECT rolname FROM pg_roles
        WHERE rolname IN ('admin_role', 'tenant_role')
        ORDER BY rolname
      `);

      assertEqual(res.rows.length, 2, 'Doit trouver 2 roles');
      assertEqual(res.rows[0].rolname, 'admin_role', 'admin_role doit exister');
      assertEqual(res.rows[1].rolname, 'tenant_role', 'tenant_role doit exister');
    });

    // -----------------------------------------------------------------------
    // Test 2 : GRANT SELECT, INSERT
    // -----------------------------------------------------------------------
    await test('GRANT SELECT, INSERT sur tenant_data a tenant_role', async () => {
      await query(client, 'GRANT SELECT, INSERT ON tenant_data TO tenant_role');

      const res = await query(client, `
        SELECT privilege_type
        FROM information_schema.role_table_grants
        WHERE grantee = 'tenant_role' AND table_name = 'tenant_data'
        ORDER BY privilege_type
      `);

      const privileges = res.rows.map(r => r.privilege_type);
      assertIncludes(privileges, 'SELECT', 'SELECT doit etre accorde');
      assertIncludes(privileges, 'INSERT', 'INSERT doit etre accorde');
      console.log(`     → Privileges accordes : ${privileges.join(', ')}`);
    });

    // -----------------------------------------------------------------------
    // Test 3 : REVOKE DELETE
    // -----------------------------------------------------------------------
    await test('REVOKE DELETE — verifier l\'interdiction', async () => {
      // Revoquer DELETE (meme s'il n'etait pas accorde, pour etre explicite)
      await query(client, 'REVOKE DELETE ON tenant_data FROM tenant_role');

      const res = await query(client, `
        SELECT privilege_type
        FROM information_schema.role_table_grants
        WHERE grantee = 'tenant_role' AND table_name = 'tenant_data'
      `);

      const privileges = res.rows.map(r => r.privilege_type);
      assert(!privileges.includes('DELETE'),
        'DELETE ne doit PAS etre dans les privileges de tenant_role');
      console.log(`     → Privileges actuels : ${privileges.join(', ')} (pas de DELETE)`);
    });

    // -----------------------------------------------------------------------
    // Test 4 : Activer RLS
    // -----------------------------------------------------------------------
    await test('Activer RLS sur tenant_data', async () => {
      await query(client, 'ALTER TABLE tenant_data ENABLE ROW LEVEL SECURITY');

      const res = await query(client, `
        SELECT relrowsecurity
        FROM pg_class
        WHERE relname = 'tenant_data'
      `);

      assertEqual(res.rows[0].relrowsecurity, true,
        'RLS doit etre active sur tenant_data');
    });

    // -----------------------------------------------------------------------
    // Test 5 : Creer une politique de securite
    // -----------------------------------------------------------------------
    await test('Politique de securite avec current_setting', async () => {
      await query(client, `
        CREATE POLICY tenant_isolation_policy ON tenant_data
        FOR ALL
        TO tenant_role
        USING (tenant_id = current_setting('app.tenant_id')::int)
        WITH CHECK (tenant_id = current_setting('app.tenant_id')::int)
      `);

      const res = await query(client, `
        SELECT polname
        FROM pg_policy
        WHERE polrelid = 'tenant_data'::regclass
      `);

      assertEqual(res.rows.length, 1, 'Doit y avoir 1 politique');
      assertEqual(res.rows[0].polname, 'tenant_isolation_policy',
        'La politique doit s\'appeler tenant_isolation_policy');
    });

    // -----------------------------------------------------------------------
    // Test 6 : Tenant 1 ne voit que ses donnees
    // -----------------------------------------------------------------------
    await test('Tenant 1 ne voit que ses propres donnees', async () => {
      // Configurer le contexte applicatif
      await query(client, "SET app.tenant_id = '1'");
      // Passer au role tenant
      await query(client, 'SET ROLE tenant_role');

      const res = await query(client, 'SELECT * FROM tenant_data');

      // Verifier que seules les donnees du tenant 1 sont visibles
      assertEqual(res.rows.length, 3,
        'Le tenant 1 doit voir exactement 3 documents');

      for (const row of res.rows) {
        assertEqual(row.tenant_id, 1,
          'Chaque ligne doit avoir tenant_id = 1');
      }

      // Revenir au superutilisateur
      await query(client, 'RESET ROLE');
    });

    // -----------------------------------------------------------------------
    // Test 7 : Tenant 2 ne voit que ses donnees
    // -----------------------------------------------------------------------
    await test('Tenant 2 ne voit que ses propres donnees', async () => {
      await query(client, "SET app.tenant_id = '2'");
      await query(client, 'SET ROLE tenant_role');

      const res = await query(client, 'SELECT * FROM tenant_data');

      assertEqual(res.rows.length, 3,
        'Le tenant 2 doit voir exactement 3 documents');

      for (const row of res.rows) {
        assertEqual(row.tenant_id, 2,
          'Chaque ligne doit avoir tenant_id = 2');
      }

      await query(client, 'RESET ROLE');
    });

    // -----------------------------------------------------------------------
    // Test 8 : Superutilisateur contourne le RLS
    // -----------------------------------------------------------------------
    await test('Le superutilisateur contourne le RLS', async () => {
      // S'assurer qu'on est le superutilisateur
      await query(client, 'RESET ROLE');

      const res = await query(client, 'SELECT * FROM tenant_data ORDER BY tenant_id');

      // Le superutilisateur voit TOUTES les donnees
      assertEqual(res.rows.length, 8,
        'Le superutilisateur doit voir les 8 documents de tous les tenants');

      // Verifier que les 3 tenants sont presents
      const tenantIds = [...new Set(res.rows.map(r => r.tenant_id))].sort();
      assertEqual(tenantIds.length, 3, 'Doit y avoir 3 tenants differents');
      assertEqual(tenantIds[0], 1, 'Tenant 1 doit etre present');
      assertEqual(tenantIds[1], 2, 'Tenant 2 doit etre present');
      assertEqual(tenantIds[2], 3, 'Tenant 3 doit etre present');

      console.log(`     → Le superutilisateur voit ${res.rows.length} documents de ${tenantIds.length} tenants`);
    });

    summary();
  } finally {
    // Nettoyage complet — toujours revenir au superutilisateur d'abord
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
