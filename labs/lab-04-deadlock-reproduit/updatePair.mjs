// updatePair.mjs — L'EXISTANT, EN PRODUCTION. Un ticket vient d'arriver : « deux mises à
// jour simultanées de deux membres provoquent parfois une erreur "deadlock detected" côté
// serveur. » Reproduis-le, comprends pourquoi, corrige-le — c'est CE fichier que tu modifies.
//
// updateMemberPair(client, idA, idB, bio) — verrouille (via UPDATE) le membre idA, ATTEND
// délibérément (le vrai code de prod fait un traitement métier entre les deux écritures —
// ce délai simule ça), puis verrouille idB. Le tout dans une transaction.

export async function updateMemberPair(client, idA, idB, bio) {
  await client.query("BEGIN");
  try {
    await client.query("UPDATE members SET bio = $2 WHERE id = $1", [idA, bio]);
    await client.query("SELECT pg_sleep(0.3)");
    await client.query("UPDATE members SET bio = $2 WHERE id = $1", [idB, bio]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
