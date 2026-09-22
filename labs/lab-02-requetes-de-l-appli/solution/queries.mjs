// queries.mjs — SOLUTION DE RÉFÉRENCE (commentée). Ne l'ouvre pas avant ton GREEN.

export async function createFamilyWithAdmin(client, { name, email }) {
  // BEGIN/COMMIT/ROLLBACK explicites : si la 2e requête échoue, la 1re ne doit PAS survivre.
  await client.query("BEGIN");
  try {
    const familyResult = await client.query(
      "INSERT INTO families (name) VALUES ($1) RETURNING id, name",
      [name],
    );
    const family = familyResult.rows[0];

    const memberResult = await client.query(
      "INSERT INTO members (family_id, email, role) VALUES ($1, $2, 'admin') RETURNING id, email, role",
      [family.id, email],
    );
    const admin = memberResult.rows[0];

    await client.query("COMMIT");
    return { family, admin };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

export async function listMembers(client, familyId, { limit, offset }) {
  const result = await client.query(
    // $1/$2/$3 liés — jamais de template string interpolé dans le SQL.
    "SELECT id, email, role FROM members WHERE family_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3",
    [familyId, limit, offset],
  );
  return result.rows;
}

export async function searchFamilies(client, query) {
  const result = await client.query(
    // ILIKE + paramètre lié : `query` ne devient JAMAIS du SQL, quoi qu'il contienne.
    "SELECT id, name FROM families WHERE name ILIKE '%' || $1 || '%' ORDER BY name",
    [query],
  );
  return result.rows;
}

export async function familyMemberCounts(client) {
  const result = await client.query(`
    SELECT f.name AS "familyName", count(m.id)::int AS "memberCount"
    FROM families f
    LEFT JOIN members m ON m.family_id = f.id
    GROUP BY f.id, f.name
    ORDER BY "memberCount" DESC, f.name ASC
  `);
  return result.rows;
}
