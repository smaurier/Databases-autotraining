-- fix.sql — SOLUTION DE RÉFÉRENCE (commentée). Ne l'ouvre pas avant ton GREEN.
--
-- L'index existant (idx_posts_family_id, sur family_id seul) sert à trouver les bonnes
-- lignes, mais Postgres doit ensuite les TRIER en mémoire (Sort, "top-N heapsort") pour
-- satisfaire ORDER BY created_at DESC — sur une famille avec 6 000 posts, ce tri coûte
-- l'essentiel du temps de la requête (mesuré : ~9,3 ms).
--
-- Un index COMPOSITE (family_id, created_at DESC) répond aux deux besoins d'un coup : il
-- trouve la famille ET rend les lignes déjà triées — Postgres n'a plus qu'à les lire dans
-- l'ordre (Index Scan, sans Sort). Mesuré : ~0,1 ms, un facteur ~90 sur ce volume.
--
-- L'ancien index n'est plus nécessaire : le composite couvre aussi "WHERE family_id = $1"
-- seul (préfixe gauche de l'index). Le garder en plus serait de la redondance pure.
DROP INDEX idx_posts_family_id;
CREATE INDEX idx_posts_family_created ON posts (family_id, created_at DESC);
