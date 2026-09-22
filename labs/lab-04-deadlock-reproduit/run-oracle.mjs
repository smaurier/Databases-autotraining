#!/usr/bin/env node
// Oracle du lab 04 PostgreSQL : reproduire un VRAI deadlock (deux sessions concurrentes,
// verrous circulaires, Postgres détecte et annule l'une des deux — code erreur 40P01), puis
// le corriger. Usage : node run-oracle.mjs lab | solution
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync as readFile } from "node:fs";
import { dirname, join } from "node:path";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] === "solution" ? "solution" : "lab";
const CONTAINER = "tribuzen-pg-lab04";
const PORT = 55494;
const DB = "tribuzen_lab";
const PASSWORD = "labpass";
const MODULE_PATH = join(HERE, mode === "solution" ? "solution/updatePair.mjs" : "updatePair.mjs");

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

  const setup = new pg.Client({ host: "localhost", port: PORT, user: "postgres", password: PASSWORD, database: DB });
  await setup.connect();
  await setup.query(readFile(join(HERE, "schema.sql"), "utf8"));
  console.log("✅ schéma appliqué\n");

  const famille = await setup.query("INSERT INTO families (name) VALUES ('Dupont') RETURNING id");
  const familyId = famille.rows[0].id;
  const m1 = (await setup.query("INSERT INTO members (family_id, email, role) VALUES ($1, 'a@t.fr', 'parent') RETURNING id", [familyId])).rows[0].id;
  const m2 = (await setup.query("INSERT INTO members (family_id, email, role) VALUES ($1, 'b@t.fr', 'parent') RETURNING id", [familyId])).rows[0].id;
  await setup.end();

  let updateMemberPair;
  try {
    ({ updateMemberPair } = await import(pathToFileURL(MODULE_PATH).href));
  } catch (e) {
    check(`updatePair.mjs s'importe (${e.message})`, false);
    return finish();
  }
  if (typeof updateMemberPair !== "function") {
    check("updateMemberPair est exporté comme fonction", false);
    return finish();
  }

  // ── Deux sessions distinctes, ordres d'id INVERSÉS, lancées quasi simultanément ────────
  const clientA = newClient();
  const clientB = newClient();
  await clientA.connect();
  await clientB.connect();

  console.log("— deux transactions concurrentes, ordre de verrouillage inversé —");
  const [resultA, resultB] = await Promise.allSettled([
    updateMemberPair(clientA, m1, m2, "écrit par A"),
    updateMemberPair(clientB, m2, m1, "écrit par B"),
  ]);

  await clientA.end().catch(() => {});
  await clientB.end().catch(() => {});

  const rejections = [resultA, resultB].filter((r) => r.status === "rejected");
  const deadlockDetecte = rejections.some((r) => r.reason?.code === "40P01");

  if (mode === "lab") {
    // On teste le STARTER : la bonne réponse ATTENDUE au premier essai est "ça reproduit le
    // deadlock". Si ça ne reproduit pas, ce n'est pas forcément que le code est déjà corrigé —
    // regarde d'abord si tu as touché à autre chose que l'ordre de verrouillage.
    check("un vrai deadlock a été détecté par Postgres (40P01) sur le code non corrigé", deadlockDetecte);
    if (deadlockDetecte) {
      console.log("   (c'est ATTENDU sur le starter — corrige updatePair.mjs pour le faire disparaître)");
    }
  } else {
    check("AUCUN deadlock avec la référence corrigée", !deadlockDetecte && rejections.length === 0);
  }

  // ── Vérifie l'état final (les deux transactions qui ont réussi ont bien écrit) ─────────
  const verif = new pg.Client({ host: "localhost", port: PORT, user: "postgres", password: PASSWORD, database: DB });
  await verif.connect();
  const rows = await verif.query("SELECT id, bio FROM members WHERE id = ANY($1) ORDER BY id", [[m1, m2]]);
  await verif.end();
  const bios = rows.rows.map((r) => r.bio);
  check("les membres non touchés par une transaction annulée ont bien reçu leur écriture", bios.every((b) => b === "écrit par A" || b === "écrit par B"));

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
