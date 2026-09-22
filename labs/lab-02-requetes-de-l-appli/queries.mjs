// queries.mjs — PAGE BLANCHE. Les requêtes réelles de TribuZen, en SQL brut — avant qu'un
// ORM (Prisma/TypeORM, cours 03) ne les génère à ta place. Chaque fonction reçoit un client
// `pg` déjà connecté (`client`) et retourne des données JS, jamais des lignes brutes non
// interprétées.
//
// Exports attendus (toutes async) :
//
//   createFamilyWithAdmin(client, { name, email })
//     → { family: { id, name }, admin: { id, email, role } }
//     Crée la famille ET son premier membre (role "admin") en UNE TRANSACTION. Si le membre
//     échoue à se créer (ex. email invalide selon une contrainte future), la famille ne doit
//     PAS survivre — aucune famille orpheline sans membre. BEGIN / COMMIT / ROLLBACK explicites.
//
//   listMembers(client, familyId, { limit, offset })
//     → tableau de membres (id, email, role), triés par created_at croissant, paginés.
//     `limit`/`offset` DOIVENT être des paramètres liés ($1, $2…) — jamais interpolés dans
//     la chaîne SQL.
//
//   searchFamilies(client, query)
//     → tableau de familles dont le nom contient `query`, insensible à la casse (ILIKE).
//     `query` DOIT être un paramètre lié. Une chaîne malveillante (ex. contenant du SQL) ne
//     doit JAMAIS être interprétée comme du SQL — elle doit juste ne matcher aucun nom.
//
//   familyMemberCounts(client)
//     → tableau { familyName, memberCount }, une ligne par famille (même à 0 membre — LEFT
//     JOIN, pas INNER), trié par memberCount décroissant.
export {};
