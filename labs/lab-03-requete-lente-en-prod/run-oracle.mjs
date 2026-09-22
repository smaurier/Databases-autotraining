#!/usr/bin/env node
// Oracle du lab 03 PostgreSQL : requête lente en prod, diagnostic EXPLAIN ANALYZE réel,
// correction mesurée. Usage : node run-oracle.mjs lab | solution
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] === "solution" ? "solution" : "lab";
const CONTAINER = "tribuzen-pg-lab03";
const PORT = 55493;
const DB = "tribuzen_lab";
const PASSWORD = "labpass";
const FIX_PATH = join(HERE, mode === "solution" ? "solution/fix.sql" : "fix.sql");

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function startContainer() {
  try { sh(`docker rm -f ${CONTAINER}`); } catch {}
  sh(`docker run -d --name ${CONTAINER} -e POSTGRES_PASSWORD=${PASSWORD} -p ${PORT}:5432 postgres:17`);
}
function stopContainer() {
  try { sh(`docker rm -f ${CONTAINER}`); } catch {}
}
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

let failed = false;
function check(label, condition) {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) failed = true;
}

function findNodeTypes(plan, acc = new Set()) {
  if (!plan || typeof plan !== "object") return acc;
  if (plan["Node Type"]) acc.add(plan["Node Type"]);
  for (const child of plan.Plans ?? []) findNodeTypes(child, acc);
  return acc;
}

async function explainAnalyze(client, familyId) {
  const r = await client.query(
    `EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM posts WHERE family_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [familyId],
  );
  const plan = r.rows[0]["QUERY PLAN"][0].Plan;
  return { plan, totalTimeMs: plan["Actual Total Time"], nodeTypes: findNodeTypes(plan) };
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
    await client.query(readFileSync(join(HERE, "schema-existant.sql"), "utf8"));
    console.log("✅ schéma existant (prod actuelle) appliqué\n");

console.log("— seed : 50 familles × 6000 posts (300 000 lignes), une famille INACTIVE parmi des familles actives —");
    // La famille testée n'a pas posté depuis un an ; toutes les autres postent activement
    // cette semaine. Un index sur created_at SEUL (sans family_id) semblerait marcher sur un
    // jeu de données uniforme — il s'effondre ici : il doit parcourir les ~294 000 posts
    // récents des AUTRES familles avant de trouver les 20 vieux posts de celle-ci. Un piège
    // volontaire : la solution qui "a l'air de marcher" doit être vraiment mesurée, pas juste
    // regardée une fois sur un jeu de données qui l'avantage par hasard.
    const FAMILY_ID = "00000000-0000-0000-0000-000000000001";
    await client.query("INSERT INTO families (id, name) VALUES ($1, 'Famille Inactive')", [FAMILY_ID]);
    await client.query(`INSERT INTO families (id, name) SELECT gen_random_uuid(), 'Famille ' || g FROM generate_series(1, 49) AS g`);
    await client.query(
      `INSERT INTO posts (family_id, author_id, content, created_at)
       SELECT $1, gen_random_uuid(), 'Vieux post ' || s, now() - interval '1 year' - (s || ' seconds')::interval
       FROM generate_series(1, 6000) AS s`,
      [FAMILY_ID],
    );
    await client.query(`
      INSERT INTO posts (family_id, author_id, content, created_at)
      SELECT f.id, gen_random_uuid(), 'Post recent ' || s, now() - (s || ' seconds')::interval
      FROM families f, generate_series(1, 6000) AS s
      WHERE f.id <> '${FAMILY_ID}'
    `);
    await client.query("ANALYZE posts");
    const familyId = FAMILY_ID;
    const avantCount = (await client.query("SELECT count(*) AS n FROM posts")).rows[0].n;

    const baseline = await explainAnalyze(client, familyId);
    console.log(`— avant correction : ${baseline.totalTimeMs.toFixed(3)} ms, nœuds : ${[...baseline.nodeTypes].join(", ")} —\n`);

    // ── Applique le fix (starter ou solution) ──────────────────────────────────────────
    const sql = readFileSync(FIX_PATH, "utf8").replace(/^--.*$/gm, "").trim();
    if (!sql) {
      check("fix.sql n'est pas vide", false);
      return;
    }
    try {
      await client.query(sql);
    } catch (e) {
      check(`fix.sql s'applique sans erreur (${e.message})`, false);
      return;
    }
    console.log("✅ fix.sql appliqué\n");

    const apresCount = (await client.query("SELECT count(*) AS n FROM posts")).rows[0].n;
    check("aucune donnée perdue (le compte de posts n'a pas bougé)", avantCount === apresCount);

    await client.query("ANALYZE posts");
    const apres = await explainAnalyze(client, familyId);
    console.log(`— après correction : ${apres.totalTimeMs.toFixed(3)} ms, nœuds : ${[...apres.nodeTypes].join(", ")} —\n`);

    check("le plan ne contient plus de nœud Sort (le tri n'est plus nécessaire)", !apres.nodeTypes.has("Sort"));
    check(
      `la requête est significativement plus rapide (au moins ×5 ; mesuré : ${baseline.totalTimeMs.toFixed(2)}ms → ${apres.totalTimeMs.toFixed(2)}ms)`,
      apres.totalTimeMs * 5 < baseline.totalTimeMs,
    );
  } finally {
    await client.end().catch(() => {});
  }
}

main()
  .catch((e) => {
    console.error(e);
    failed = true;
  })
  .finally(() => {
    stopContainer();
    console.log(`\n— conteneur ${CONTAINER} supprimé —`);
    console.log(failed ? "\n❌ RED\n" : "\n✅ GREEN\n");
    process.exit(failed ? 1 : 0);
  });
