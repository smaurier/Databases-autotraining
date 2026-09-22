#!/usr/bin/env node
// Oracle du lab 06 PostgreSQL : ajouter une colonne JSONB indexée à une table VIVANTE. Deux
// preuves réelles : 1) aucune donnée perdue dans la consolidation, l'index GIN sert bien les
// requêtes de contenance (EXPLAIN réel) ; 2) pendant la migration, un INSERT concurrent ne
// doit (quasi) jamais attendre — sinon la table a été verrouillée pour les écritures pendant
// toute la construction de l'index, ce qu'un CREATE INDEX CONCURRENTLY évite.
// Usage : node run-oracle.mjs lab | solution
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] === "solution" ? "solution" : "lab";
const CONTAINER = "tribuzen-pg-lab06";
const PORT = 55496;
const DB = "tribuzen_lab";
const PASSWORD = "labpass";
const MIGRATION_PATH = join(HERE, mode === "solution" ? "solution/migration.sql" : "migration.sql");
const N_POSTS = 200_000;

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
function newClient() {
  return new pg.Client({ host: "localhost", port: PORT, user: "postgres", password: PASSWORD, database: DB });
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Le fichier de migration peut être découpé en étapes indépendantes via des marqueurs
// `-- @step` — chaque étape s'exécute dans SON PROPRE appel (donc sa propre transaction
// implicite), jamais toutes ensemble : c'est ce qui permet à CREATE INDEX CONCURRENTLY (qui
// refuse tout bloc de transaction explicite) de cohabiter avec des ALTER TABLE transactionnels.
function parseSteps(sql) {
  const parts = sql.split(/^-- @step.*$/m).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [sql];
}

let failed = false;
function check(label, condition) {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  if (!condition) failed = true;
}

async function main() {
  console.log(`\n— démarrage d'un Postgres 17 éphémère (${CONTAINER}, port ${PORT}) —\n`);
  startContainer();

  const admin = await waitForPostgres(
    () => new pg.Client({ host: "localhost", port: PORT, user: "postgres", password: PASSWORD, database: "postgres" }),
  );
  await admin.query(`CREATE DATABASE ${DB}`);
  await admin.end();

  const client = newClient();
  await client.connect();
  await client.query(readFileSync(join(HERE, "schema-existant.sql"), "utf8"));
  console.log("✅ schéma existant appliqué\n");

  const famille = await client.query("INSERT INTO families (name) VALUES ('Dupont') RETURNING id");
  const familyId = famille.rows[0].id;

  console.log(`— seed de ${N_POSTS.toLocaleString("fr-FR")} posts (90% simple, 5% événement, 5% épinglé) —`);
  await client.query(
    `INSERT INTO posts (family_id, author_id, content, is_event, event_date, event_location, is_pinned, pinned_by)
     SELECT
       $1,
       gen_random_uuid(),
       'post ' || gs,
       (gs % 20 = 0),
       CASE WHEN gs % 20 = 0 THEN (now()::date - (gs % 365)) ELSE NULL END,
       CASE WHEN gs % 20 = 0 THEN 'Lyon' ELSE NULL END,
       (gs % 20 = 1),
       CASE WHEN gs % 20 = 1 THEN gen_random_uuid() ELSE NULL END
     FROM generate_series(1, $2) AS gs`,
    [familyId, N_POSTS],
  );
  console.log("✅ seed terminé\n");

  // ── Lance la migration sur un client dédié, mesure un INSERT concurrent pendant ce temps ──
  console.log(`— application de la migration (${mode}), avec un INSERT concurrent pendant ce temps —`);
  const migClient = newClient();
  await migClient.connect();
  const steps = parseSteps(readFileSync(MIGRATION_PATH, "utf8"));

  let migrationError = null;
  const t0 = Date.now();
  const migrationPromise = (async () => {
    for (const step of steps) {
      await migClient.query(step);
    }
  })().catch((e) => { migrationError = e; });

  await sleep(200); // laisse la migration démarrer et poser son premier verrou
  const insertClient = newClient();
  await insertClient.connect();
  const tInsert0 = Date.now();
  let insertError = null;
  try {
    await insertClient.query(
      "INSERT INTO posts (family_id, author_id, content) VALUES ($1, gen_random_uuid(), 'concurrent-check')",
      [familyId],
    );
  } catch (e) {
    insertError = e;
  }
  const insertLatencyMs = Date.now() - tInsert0;
  await insertClient.end();

  await migrationPromise;
  const migrationDurationMs = Date.now() - t0;
  await migClient.end();

  console.log(`   migration totale : ${migrationDurationMs} ms — INSERT concurrent : ${insertLatencyMs} ms`);

  if (migrationError) {
    check(`migration.sql s'applique sans erreur (${migrationError.message})`, false);
  } else {
    check("migration.sql s'applique sans erreur", true);
    check(
      "la migration a été assez lourde pour que le test de verrouillage soit significatif (> 1000 ms)",
      migrationDurationMs > 1000,
    );
    check(
      "un INSERT concurrent n'a PAS été bloqué par la construction de l'index (< 500 ms)",
      !insertError && insertLatencyMs < 500,
    );
  }

  // ── Vérifications structurelles et de non-perte de données ─────────────────────────────
  const cols = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'posts' AND column_name IN
       ('is_event', 'event_date', 'event_location', 'is_pinned', 'pinned_by', 'metadata')`,
  );
  const names = cols.rows.map((r) => r.column_name);
  check("les anciennes colonnes clairsemées ont disparu", !["is_event", "event_date", "event_location", "is_pinned", "pinned_by"].some((c) => names.includes(c)));
  check("la colonne metadata (jsonb) existe", names.includes("metadata"));

  const counts = await client.query(
    `SELECT metadata->>'type' AS type, count(*) FROM posts WHERE content <> 'concurrent-check' GROUP BY 1 ORDER BY 1`,
  );
  const byType = Object.fromEntries(counts.rows.map((r) => [r.type, Number(r.count)]));
  check(
    `répartition par type correcte (event=${Math.floor(N_POSTS / 20)}, pinned≈${Math.floor(N_POSTS / 20)}, simple=le reste), aucune ligne perdue`,
    byType.event === Math.floor(N_POSTS / 20) &&
      byType.pinned > 0 &&
      byType.simple > 0 &&
      byType.event + byType.pinned + byType.simple === N_POSTS,
  );

  const echantillonEvent = await client.query("SELECT metadata FROM posts WHERE content = 'post 20'");
  check(
    "un post événement connu porte bien event_date/event_location dans metadata (aucune perte de champ)",
    echantillonEvent.rows[0]?.metadata?.event_location === "Lyon" && !!echantillonEvent.rows[0]?.metadata?.event_date,
  );
  const echantillonPinned = await client.query("SELECT metadata FROM posts WHERE content = 'post 21'");
  check(
    "un post épinglé connu porte bien pinned_by dans metadata",
    !!echantillonPinned.rows[0]?.metadata?.pinned_by,
  );

  const gin = await client.query(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'posts' AND indexdef ILIKE '%using gin%'`,
  );
  check("un index GIN existe sur metadata", gin.rows.length > 0);

  const plan = await client.query(
    `EXPLAIN (ANALYZE, FORMAT JSON) SELECT id FROM posts WHERE metadata @> '{"type": "pinned"}'`,
  );
  const planJson = JSON.stringify(plan.rows[0]["QUERY PLAN"]);
  check(
    "la requête de contenance metadata @> utilise l'index GIN (Bitmap Index Scan / Index Scan, pas Seq Scan)",
    !planJson.includes("Seq Scan") && (planJson.includes("Bitmap Index Scan") || planJson.includes("Index Scan")),
  );

  await client.end();
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
