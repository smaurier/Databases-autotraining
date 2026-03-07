# Lab 13 — JSONB & Full-Text Search

## Objectifs

- Manipuler les donnees JSONB avec les operateurs `->`, `->>`, `@>`, `?`
- Creer et utiliser des index GIN sur des colonnes JSONB
- Travailler avec les tableaux PostgreSQL (TEXT[]) et l'operateur `@>`
- Implementer la recherche plein texte avec `to_tsvector`, `to_tsquery`, `@@`
- Classer les resultats par pertinence avec `ts_rank`
- Mettre en evidence les termes trouves avec `ts_headline`
- Combiner filtre JSONB, recherche plein texte et classement

## Schema

```sql
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  specs JSONB NOT NULL DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  search_vector TSVECTOR GENERATED ALWAYS AS (
    to_tsvector('french', name || ' ' || description)
  ) STORED
);
```

## Donnees de test

1000 produits avec des specifications JSONB variees, des tags et des descriptions en francais.

## Tests (10)

1. **JSONB -> et ->>** — Extraire des valeurs de specs
2. **JSONB @>** — Trouver les produits avec des specs specifiques
3. **JSONB ?** — Verifier l'existence d'une cle
4. **GIN sur JSONB** — Creer un index et verifier son usage
5. **Tableaux @>** — Filtrer par tags
6. **GIN sur tableaux** — Indexer et verifier l'usage
7. **Full-text search** — Recherche avec to_tsquery et @@
8. **ts_rank** — Classer les resultats par pertinence
9. **ts_headline** — Mettre en evidence les termes trouves
10. **Requete combinee** — JSONB + full-text + ranking

## Lancer le lab

```bash
# Exercice (avec TODOs)
node exercise.js

# Solution
node solution.js
```
