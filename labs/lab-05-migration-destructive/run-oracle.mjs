#!/usr/bin/env node
// Oracle du lab 05 PostgreSQL : une migration qui SPLIT une colonne ne doit JAMAIS perdre de
// données. On seed des membres avec des noms réels, on capture leur full_name AVANT la
// migration, on applique migration.sql (starter ou solution), puis on vérifie qu'on peut
// RECONSTRUIRE exactement chaque nom original à partir de first_name/last_name.
// Usage : node run-oracle.mjs lab | solution
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] === "solution" ? "solution" : "lab";
const CONTAINER = "tribuzen-pg-lab05";
const PORT = 55495;
const DB = "tribuzen_lab";
const PASSWORD = "labpass";
const MIGRATION_PATH = join(HERE, mode === "solution" ? "solution/migration.sql" : "migration.sql");

const NOMS = ["Marie Dupont", "Jean-Paul De La Fontaine", "Cher", "Al Pacino", "Zoé Petit"];

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
  await client.query(readFileSync(join(HERE, "schema-existant.sql"), "utf8"));
  console.log("✅ schéma existant appliqué\n");

  const famille = await client.query("INSERT INTO families (name) VALUES ('Dupont') RETURNING id");
  const familyId = famille.rows[0].id;
  const before = new Map();
  for (let i = 0; i < NOMS.length; i++) {
    const row = await client.query(
      "INSERT INTO members (family_id, email, full_name, role) VALUES ($1, $2, $3, 'parent') RETURNING id",
      [familyId, `membre${i}@t.fr`, NOMS[i]],
    );
    before.set(row.rows[0].id, NOMS[i]);
  }
  console.log(`✅ ${before.size} membres seedés avec un vrai full_name\n`);

  console.log(`— application de la migration (${mode}) —`);
  let migrationOk = true;
  try {
    await client.query(readFileSync(MIGRATION_PATH, "utf8"));
  } catch (e) {
    migrationOk = false;
    check(`migration.sql s'applique sans erreur (${e.message})`, false);
  }

  if (migrationOk) {
    check("migration.sql s'applique sans erreur", true);

    const cols = await client.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'members' AND column_name IN ('full_name', 'first_name', 'last_name')`,
    );
    const byName = Object.fromEntries(cols.rows.map((r) => [r.column_name, r]));

    check("la colonne full_name a bien été retirée (migration terminée, pas à moitié faite)", !byName.full_name);
    check("first_name existe et est NOT NULL", byName.first_name?.is_nullable === "NO");
    check("last_name existe et est NOT NULL", byName.last_name?.is_nullable === "NO");

    const apres = await client.query("SELECT id, first_name, last_name FROM members");
    let tousReconstruits = apres.rows.length === before.size;
    for (const row of apres.rows) {
      const original = before.get(row.id);
      const reconstruit = `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
      if (reconstruit !== original) {
        console.log(`   attendu "${original}" — reconstruit "${reconstruit}" (id ${row.id})`);
        tousReconstruits = false;
      }
    }
    check("chaque full_name original est EXACTEMENT reconstruit depuis first_name + last_name (aucune donnée perdue)", tousReconstruits);
  }

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
