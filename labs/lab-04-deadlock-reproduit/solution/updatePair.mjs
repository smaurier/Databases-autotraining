// updatePair.mjs — SOLUTION DE RÉFÉRENCE (commentée). Ne l'ouvre pas avant ton GREEN.
export async function updateMemberPair(client, idA, idB, bio) {
  // Fix : verrouille TOUJOURS dans le même ordre (tri lexicographique des uuid), quel que
  // soit l'ordre dans lequel l'appelant a passé idA/idB. Deux appels concurrents — même avec
  // des arguments inversés — attendent alors l'un l'autre au lieu de s'attendre CIRCULAIREMENT
  // : c'est une sérialisation normale (l'un patiente), plus jamais un deadlock.
  const [first, second] = idA < idB ? [idA, idB] : [idB, idA];
  await client.query("BEGIN");
  try {
    await client.query("UPDATE members SET bio = $2 WHERE id = $1", [first, bio]);
    await client.query("SELECT pg_sleep(0.3)");
    await client.query("UPDATE members SET bio = $2 WHERE id = $1", [second, bio]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
