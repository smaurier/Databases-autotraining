#!/usr/bin/env node
// Oracle du lab 01 PostgreSQL : un VRAI Postgres 17 (Docker, éphémère), une VRAIE migration,
// 100 000 lignes seedées, un VRAI EXPLAIN. Rien de simulé. Usage : node run-oracle.mjs lab|solution
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] === "solution" ? "solution" : "lab";
const CONTAINER = "tribuzen-pg-lab01";
const PORT = 55491;
const DB = "tribuzen_lab";
const PASSWORD = "labpass";

const MIGRATION = join(HERE, mode === "solution" ? "solution/migrations/001_init.sql" : "migrations/001_init.sql");

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function startContainer() {
  try { sh(`docker rm -f ${CONTAINER}`); } catch { /* n'existait pas, tant mieux */ }
  sh(`docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=${PASSWORD} -p ${PORT}:5432 postgres:17`);
}

function stopContainer() {
  try { sh(`docker rm -f ${CONTAINER}`); } catch { /* best effort */ }
}

// pg.Client ne se reconnecte pas après un connect() en échec : une NOUVELLE instance à
// chaque tentative, jusqu'à ce que le conteneur (initdb + redémarrage) soit vraiment prêt.
async function waitForPostgres(makeClient, timeoutMs = 60_000) {
  const start = Date.now();
  for (;;) {
    const client = makeClient();
    try {
      await client.connect();
      return client;
    } catch {
      await client.end().catch(() => {});
      if (Date.now() - start > timeoutMs) throw new Error("Postgres n'a jamais répondu (timeout).");
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

function fail(msg) {
  console.log(`\n❌ RED — ${msg}\n`);
  process.exitCode = 1;
}

async function main() {
  console.log(`\n— démarrage d'un Postgres 17 éphémère (${CONTAINER}, port ${PORT}) —\n`);
  startContainer();

  const admin = await waitForPostgres(
    () => new pg.Client({ host: "localhost", port: PORT, user: "postgres", password: PASSWORD, database: "postgres" }),
  );
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();

  const client = new pg.Client({ host: "localhost", port: PORT, user: "postgres", password: PASSWORD, database: DB });
  await client.connect();

  try {
    // ── Étape 1 : appliquer LA migration (starter ou solution selon le mode) ──────────
    if (!existsSync(MIGRATION)) return fail(`migration introuvable : ${MIGRATION}`);
    const sql = readFileSync(MIGRATION, "utf8").replace(/^--.*$/gm, "").trim();
    if (!sql) return fail("la migration est vide (juste des commentaires) — rien à appliquer, c'est attendu sur le starter.");
    try {
      await client.query(sql);
    } catch (e) {
      return fail(`la migration échoue à s'appliquer : ${e.message}`);
    }
    console.log("✅ migration appliquée");

    // ── Étape 2 : forme du schéma ──────────────────────────────────────────────────────
    const cols = await client.query(
      `SELECT table_name, column_name, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`,
    );
    const has = (table, column) => cols.rows.some((r) => r.table_name === table && r.column_name === column);
    for (const [table, column] of [
      ["families", "id"], ["families", "name"], ["families", "created_at"],
      ["members", "id"], ["members", "family_id"], ["members", "email"], ["members", "role"], ["members", "created_at"],
    ]) {
      if (!has(table, column)) return fail(`colonne manquante : ${table}.${column}`);
    }
    console.log("✅ colonnes attendues présentes");

    // ── Étape 3 : contraintes RÉELLEMENT appliquées par Postgres ───────────────────────
    const famille = await client.query(`INSERT INTO families (name) VALUES ('Dupont') RETURNING id`);
    const familyId = famille.rows[0].id;
    await client.query(`INSERT INTO members (family_id, email, role) VALUES ($1, 'a@t.fr', 'parent')`, [familyId]);

    let roleRejete = false;
    try {
      await client.query(`INSERT INTO members (family_id, email, role) VALUES ($1, 'b@t.fr', 'grand-parent')`, [familyId]);
    } catch {
      roleRejete = true;
    }
    if (!roleRejete) return fail("un role invalide (\"grand-parent\") a été accepté — la contrainte CHECK manque ou est trop permissive.");

    let doublonRejete = false;
    try {
      await client.query(`INSERT INTO members (family_id, email, role) VALUES ($1, 'a@t.fr', 'enfant')`, [familyId]);
    } catch {
      doublonRejete = true;
    }
    if (!doublonRejete) return fail("un email en double DANS LA MÊME famille a été accepté — la contrainte UNIQUE(family_id, email) manque.");
    console.log("✅ contraintes CHECK et UNIQUE réellement appliquées (pas seulement déclarées)");

    // ── Étape 4 : seed massif (100 000 lignes, pour que EXPLAIN soit probant) ──────────
    await client.query(`INSERT INTO families (id, name) SELECT gen_random_uuid(), 'Famille ' || g FROM generate_series(1, 500) AS g`);
    await client.query(`
      INSERT INTO members (family_id, email, role)
      SELECT f.id, 'membre' || row_number() OVER () || '@t.fr',
             (ARRAY['admin','parent','enfant'])[1 + floor(random() * 3)]
      FROM families f, generate_series(1, 200) AS s
      WHERE f.name <> 'Dupont'
    `);
    await client.query("ANALYZE members");
    console.log("✅ 100 000 lignes seedées");

    // ── Étape 5 : EXPLAIN — la preuve, pas la supposition ──────────────────────────────
    const plan = await client.query(
      `EXPLAIN (FORMAT JSON) SELECT * FROM members ORDER BY created_at DESC LIMIT 20`,
    );
    const planJson = JSON.stringify(plan.rows[0]["QUERY PLAN"]);
    if (planJson.includes('"Node Type": "Seq Scan"') || planJson.includes('"Node Type":"Seq Scan"')) {
      return fail("EXPLAIN montre un Seq Scan sur 100 000 lignes triées à chaque appel — l'index sur members(created_at) manque (ou n'est pas utilisable).");
    }
    if (!planJson.includes("idx_members_created_at") && !/"Node Type":\s*"Index/.test(planJson)) {
      return fail("EXPLAIN ne montre aucun Index Scan sur idx_members_created_at.");
    }
    console.log("✅ EXPLAIN confirme un Index Scan (pas de Seq Scan) sur la requête des membres récents");

    console.log("\n✅ GREEN\n");
  } finally {
    await client.end().catch(() => {});
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    stopContainer();
    console.log(`— conteneur ${CONTAINER} supprimé —`);
    process.exit(process.exitCode ?? 0);
  });
