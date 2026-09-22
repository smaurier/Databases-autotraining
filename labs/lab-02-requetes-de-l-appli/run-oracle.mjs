#!/usr/bin/env node
// Oracle du lab 02 PostgreSQL : les requêtes réelles, sur un VRAI Postgres 17 éphémère.
// Usage : node run-oracle.mjs lab | solution
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] === "solution" ? "solution" : "lab";
const CONTAINER = "tribuzen-pg-lab02";
const PORT = 55492;
const DB = "tribuzen_lab";
const PASSWORD = "labpass";
const QUERIES_PATH = join(HERE, mode === "solution" ? "solution/queries.mjs" : "queries.mjs");

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
  if (condition) {
    console.log(`✅ ${label}`);
  } else {
    console.log(`❌ ${label}`);
    failed = true;
  }
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
    await client.query(readFileSync(join(HERE, "schema.sql"), "utf8"));
    console.log("✅ schéma donné appliqué\n");

    let queries;
    try {
      queries = await import(pathToFileURL(QUERIES_PATH).href);
    } catch (e) {
      console.log(`❌ RED — queries.mjs ne s'importe même pas : ${e.message}\n`);
      failed = true;
      return;
    }
    const { createFamilyWithAdmin, listMembers, searchFamilies, familyMemberCounts } = queries;
    for (const [name, fn] of Object.entries({ createFamilyWithAdmin, listMembers, searchFamilies, familyMemberCounts })) {
      if (typeof fn !== "function") {
        console.log(`❌ RED — export manquant ou n'est pas une fonction : ${name}\n`);
        failed = true;
      }
    }
    if (failed) return;

    // ── createFamilyWithAdmin : cas nominal ────────────────────────────────────────────
    const { family, admin: adminMember } = await createFamilyWithAdmin(client, { name: "Dupont", email: "alice@tribuzen.app" });
    check("createFamilyWithAdmin crée la famille et l'admin", family?.name === "Dupont" && adminMember?.role === "admin");

    // ── createFamilyWithAdmin : ATOMICITÉ — email null doit tout annuler ──────────────
    const avant = await client.query("SELECT count(*) AS n FROM families");
    let echecAttrape = false;
    try {
      await createFamilyWithAdmin(client, { name: "Famille Fantôme", email: null });
    } catch {
      echecAttrape = true;
    }
    const apres = await client.query("SELECT count(*) AS n FROM families");
    check(
      "un membre qui échoue à se créer (email NULL) annule AUSSI la famille (transaction réelle)",
      echecAttrape && avant.rows[0].n === apres.rows[0].n,
    );

    // ── listMembers : pagination réelle, paramètres liés ──────────────────────────────
    for (let i = 0; i < 5; i++) {
      await client.query("INSERT INTO members (family_id, email, role) VALUES ($1, $2, 'enfant')", [family.id, `enfant${i}@t.fr`]);
    }
    const page1 = await listMembers(client, family.id, { limit: 3, offset: 0 });
    const page2 = await listMembers(client, family.id, { limit: 3, offset: 3 });
    check("listMembers pagine correctement (page 1 = 3, page 2 = le reste, aucun chevauchement)",
      page1.length === 3 && page2.length === 3 && !page1.some((m) => page2.some((m2) => m2.id === m.id)));

    // ── searchFamilies : insensible à la casse, ET résistant à l'injection ────────────
    await createFamilyWithAdmin(client, { name: "Martin", email: "bob@tribuzen.app" });
    const trouveInsensible = await searchFamilies(client, "dup");
    check("searchFamilies est insensible à la casse (\"dup\" trouve \"Dupont\")", trouveInsensible.some((f) => f.name === "Dupont"));

    const tentativeInjection = "x'; DROP TABLE families; --";
    let injectionOk = false;
    try {
      const resultatInjection = await searchFamilies(client, tentativeInjection);
      const tableEncoreLa = await client.query("SELECT count(*) AS n FROM families");
      injectionOk = Array.isArray(resultatInjection) && Number(tableEncoreLa.rows[0].n) > 0;
    } catch {
      injectionOk = false;
    }
    check("searchFamilies résiste à une tentative d'injection SQL (paramètre lié, pas de concaténation)", injectionOk);

    // ── familyMemberCounts : LEFT JOIN (les familles à 0 membre comptent aussi) ────────
    await client.query("INSERT INTO families (name) VALUES ('Famille Vide')");
    const counts = await familyMemberCounts(client);
    const vide = counts.find((c) => c.familyName === "Famille Vide");
    check("familyMemberCounts inclut les familles SANS membre (LEFT JOIN, memberCount = 0)", vide?.memberCount === 0);
    check("familyMemberCounts est trié par memberCount décroissant", counts[0].memberCount >= counts[counts.length - 1].memberCount);
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
