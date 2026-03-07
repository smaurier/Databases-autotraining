# Lab 14 — Securite & Row Level Security (RLS)

## Objectifs

- Creer et gerer des roles PostgreSQL
- Accorder et revoquer des privileges (GRANT / REVOKE)
- Activer la securite au niveau des lignes (RLS)
- Creer des politiques de securite pour le multi-tenant
- Utiliser `current_setting` et `SET` pour le contexte applicatif
- Comprendre le contournement RLS par les superutilisateurs

## Schema

```sql
CREATE TABLE tenants (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE tenant_data (
  id SERIAL PRIMARY KEY,
  tenant_id INT REFERENCES tenants(id),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

## Configuration multi-tenant

Chaque locataire (tenant) ne doit voir que ses propres donnees grace a RLS.

## Tests (8)

1. **Creer des roles** — admin_role et tenant_role
2. **GRANT** — Accorder SELECT, INSERT sur tenant_data
3. **REVOKE** — Revoquer DELETE et verifier l'interdiction
4. **Activer RLS** — ALTER TABLE ... ENABLE ROW LEVEL SECURITY
5. **Politique de securite** — USING (tenant_id = current_setting('app.tenant_id')::int)
6. **Tenant 1** — SET app.tenant_id = '1' → ne voit que ses donnees
7. **Tenant 2** — SET app.tenant_id = '2' → ne voit que ses donnees
8. **Admin bypass** — Le superutilisateur contourne le RLS

## Lancer le lab

```bash
# Exercice (avec TODOs)
node exercise.js

# Solution
node solution.js
```
