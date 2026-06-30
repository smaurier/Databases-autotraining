# Lab 04 — Transactions et ACID

> **Outcome :** à la fin, tu sais écrire une transaction atomique avec **Prisma** (interactive + séquentielle), observer une anomalie de concurrence en SQL réel, et gérer les conflits de sérialisation avec un retry.
> **Vrai outil :** PostgreSQL (psql) + Prisma `$transaction`. Aucune simulation de transaction.
> **Feedback :** le coach valide en session (pas de test-runner auto-correcteur).

## Énoncé

Base TribuZen locale (Docker Postgres), schéma de départ (déjà migré) :

```prisma
// schema.prisma (extrait)
model Invitation {
  id        String  @id @default(cuid())
  familyId  String
  status    String  @default("pending") // pending | accepted | declined
}
model FamilyMember {
  id       String @id @default(cuid())
  familyId String
  userId   String
  @@unique([familyId, userId]) // un user = une seule fois par famille
}
model Family {
  id           String @id @default(cuid())
  membersCount Int    @default(0)
}
```

Mission : implémenter `acceptInvitation(invitationId, userId)` qui, **atomiquement**, passe l'invitation à `accepted`, crée le `FamilyMember`, et incrémente `membersCount` — avec une garde métier (refuser si l'invitation n'est pas `pending`) et une résistance aux acceptations concurrentes.

## Étapes (en friction)

1. **Transaction interactive.** Écris `acceptInvitation` avec `prisma.$transaction(async (tx) => { ... })`. Lis l'invitation via `tx`, applique la garde métier (`throw` si `status !== 'pending'`), puis les 3 écritures.
2. **Atomicité prouvée.** Provoque une erreur volontaire après la création du membre (ex. `throw new Error('boom')` avant le COMMIT) et vérifie en base qu'**aucune** des 3 écritures n'a été persistée.
3. **Anomalie observée (SQL).** Dans deux sessions `psql`, reproduis un **non-repeatable read** sur `membersCount` en Read Committed, puis montre que `BEGIN ISOLATION LEVEL REPEATABLE READ` le supprime.
4. **Concurrence + retry.** Passe la transaction en `isolationLevel: Serializable`. Simule deux acceptations concurrentes et ajoute une **boucle de retry** (max 3) sur l'erreur `40001` (Prisma `P2034`/serialization failure).
5. **Forme séquentielle.** Réécris une variante **sans** garde métier en `$transaction([...])` (array) et explique pourquoi elle ne convient pas dès qu'il faut lire/brancher.
6. **Discipline.** Utilise `tx` (jamais `prisma`) dans le callback ; aucune I/O externe dans la transaction.

## Corrigé complet commenté

```typescript
// src/family/accept-invitation.ts
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

// --- Étape 1 : transaction interactive avec garde métier ---
export async function acceptInvitation(invitationId: string, userId: string) {
  return prisma.$transaction(
    async (tx) => {
      // Lire DANS la transaction (même snapshot) — tx, pas prisma.
      const inv = await tx.invitation.findUniqueOrThrow({ where: { id: invitationId } });

      // Garde métier : throw => ROLLBACK automatique de tout ce qui précède.
      if (inv.status !== 'pending') throw new Error('NOT_PENDING');

      // 3 écritures liées, atomiques.
      await tx.invitation.update({ where: { id: inv.id }, data: { status: 'accepted' } });
      const member = await tx.familyMember.create({
        data: { familyId: inv.familyId, userId },
      });
      await tx.family.update({
        where: { id: inv.familyId },
        data: { membersCount: { increment: 1 } },
      });

      return member; // valeur résolue de $transaction APRÈS le COMMIT
    },
    // Serializable : empêche le write skew (double acceptation => double incrément).
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10_000 },
  );
}

// --- Étape 4 : enveloppe de retry sur conflit de sérialisation (40001) ---
// Prisma remonte une erreur connue P2034 pour les write conflicts / deadlocks.
export async function acceptInvitationWithRetry(
  invitationId: string,
  userId: string,
  maxAttempts = 3,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await acceptInvitation(invitationId, userId);
    } catch (e) {
      const isSerializationConflict =
        e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034';
      if (isSerializationConflict && attempt < maxAttempts) {
        continue; // on retente : la transaction concurrente a gagné, on rejoue sur l'état frais
      }
      throw e; // garde métier (NOT_PENDING) ou échec définitif → on propage
    }
  }
}

// --- Étape 5 : forme séquentielle (array) — atomique mais SANS logique intermédiaire ---
// À n'utiliser que si aucune lecture/branche n'est nécessaire entre les opérations.
export async function acceptInvitationSequential(
  invitationId: string,
  familyId: string,
  userId: string,
) {
  // Impossible de vérifier ici inv.status === 'pending' : pas d'accès au résultat
  // intermédiaire. C'est la limite de la forme séquentielle → préférer l'interactive.
  return prisma.$transaction([
    prisma.invitation.update({ where: { id: invitationId }, data: { status: 'accepted' } }),
    prisma.familyMember.create({ data: { familyId, userId } }),
    prisma.family.update({ where: { id: familyId }, data: { membersCount: { increment: 1 } } }),
  ]);
}
```

Étape 2 — preuve d'atomicité (à exécuter ponctuellement) :

```typescript
// Injecte un throw juste avant la fin du callback, puis :
// SELECT status FROM "Invitation" WHERE id = 'inv-1';   -> toujours 'pending'
// SELECT count(*) FROM "FamilyMember" WHERE "userId" = 'u-9'; -> 0
// SELECT "membersCount" FROM "Family" WHERE id = 'fam-1';     -> inchangé
// => ROLLBACK total confirmé : aucune des 3 écritures n'a survécu.
```

Étape 3 — anomalie en SQL réel (deux sessions psql) :

```sql
-- Session 1 (Read Committed = défaut)        | -- Session 2
BEGIN;                                         |
SELECT "membersCount" FROM "Family"            |
  WHERE id = 'fam-1';        -- → 3            |
                                               | UPDATE "Family"
                                               |   SET "membersCount" = 4
                                               |   WHERE id = 'fam-1';
                                               | COMMIT;
SELECT "membersCount" FROM "Family"            |
  WHERE id = 'fam-1';        -- → 4  ❗         |   <- non-repeatable read
COMMIT;                                        |

-- Même scénario en Repeatable Read : la 2e lecture renvoie encore 3 (snapshot figé).
-- Session 1 :
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT "membersCount" FROM "Family" WHERE id = 'fam-1';  -- → 3
-- (Session 2 : UPDATE ... = 4 ; COMMIT)
SELECT "membersCount" FROM "Family" WHERE id = 'fam-1';  -- → 3  ✅ stable
COMMIT;
```

Points de validation par le coach : (a) `tx` partout dans le callback, jamais `prisma` ; (b) garde métier via `throw` (pas de rollback explicite) ; (c) atomicité prouvée en base, pas affirmée ; (d) retry **seulement** sur `P2034`, la garde métier `NOT_PENDING` n'est pas retentée ; (e) tu sais expliquer pourquoi la forme séquentielle ne permet pas la garde métier.

## Variante J+30 (fading)

Reprends sans relire le corrigé, **en 25 min**, avec une contrainte ajoutée : `acceptInvitation` doit aussi **refuser** si la famille a déjà atteint `maxMembers` (nouvelle colonne `Family.maxMembers`). Lis le compteur dans la transaction, lève `FAMILY_FULL` si dépassé, et prouve qu'une acceptation concurrente ne peut **pas** faire passer la famille au-dessus de la limite (write skew) — d'abord en montrant le bug en `Read Committed`, puis en le corrigeant en `Serializable` + retry. Explique à voix haute : pourquoi Read Committed laisse passer le dépassement et pourquoi Serializable le bloque.

## Application TribuZen

Porte ce lab dans le vrai repo `smaurier/tribuzen` :

1. Ajoute/migre les modèles `Invitation`, `FamilyMember`, `Family` dans `schema.prisma` (Postgres Docker local), `npx prisma migrate dev`.
2. Implémente `src/family/accept-invitation.ts` avec la transaction interactive + retry ci-dessus.
3. Teste-le avec Vitest (couche cours 06) : un test d'intégration sur une base de test qui vérifie l'atomicité (les 3 écritures ou aucune) et le rejet `NOT_PENDING`.
4. Commit `smaurier/tribuzen` : `feat(family): acceptation d'invitation atomique (Prisma $transaction + retry 40001)`.
