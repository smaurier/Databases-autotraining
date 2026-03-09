// =============================================================================
// Lab 04 — Transactions : Visite guidee (Walkthrough)
// =============================================================================
// Ce fichier vous guide pas a pas a travers les concepts de transactions
// PostgreSQL. Executez-le avec : npx tsx walkthrough.ts
// =============================================================================

import pg from 'pg';
import { createClient, query } from '../db-test-utils.ts';

// Couleurs pour la console
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function title(text: string): void {
  console.log(`\n${BOLD}${BLUE}${'═'.repeat(60)}${RESET}`);
  console.log(`${BOLD}${BLUE}  ${text}${RESET}`);
  console.log(`${BOLD}${BLUE}${'═'.repeat(60)}${RESET}\n`);
}

function step(num: number, text: string): void {
  console.log(`${BOLD}${CYAN}  [Etape ${num}]${RESET} ${text}`);
}

function explain(text: string): void {
  console.log(`${DIM}  > ${text}${RESET}`);
}

function success(text: string): void {
  console.log(`${GREEN}  OK : ${text}${RESET}`);
}

function warning(text: string): void {
  console.log(`${YELLOW}  ATTENTION : ${text}${RESET}`);
}

function error(text: string): void {
  console.log(`${RED}  ERREUR : ${text}${RESET}`);
}

function showBalance(label: string, rows: Array<{ owner: string; balance: string }>): void {
  console.log(`${DIM}  ${label}${RESET}`);
  rows.forEach(r => {
    console.log(`    ${r.owner}: ${parseFloat(r.balance).toFixed(2)} EUR`);
  });
}

let client: pg.Client | undefined;

try {
  client = await createClient();

  // Nettoyage
  await query(client, 'DROP TABLE IF EXISTS accounts');
  await query(client, `
    CREATE TABLE accounts (
      id      SERIAL PRIMARY KEY,
      owner   TEXT NOT NULL,
      balance NUMERIC(12,2) NOT NULL DEFAULT 0
    )
  `);

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 1 : Transfert reussi
  // ═══════════════════════════════════════════════════════════════════════════
  title('Scenario 1 : Transfert bancaire reussi');

  step(1, 'Creation des comptes');
  await query(client, `
    INSERT INTO accounts (owner, balance) VALUES
      ('Alice', 1000.00),
      ('Bob', 500.00)
  `);
  let balances = await query(client, 'SELECT owner, balance FROM accounts ORDER BY owner');
  showBalance('Soldes initiaux :', balances.rows);

  step(2, 'Demarrage de la transaction avec BEGIN');
  await query(client, 'BEGIN');
  explain('La transaction est ouverte. Toutes les operations suivantes sont atomiques.');

  step(3, 'Debit du compte d\'Alice de 200 EUR');
  await query(client, "UPDATE accounts SET balance = balance - 200 WHERE owner = 'Alice'");
  explain('Le debit est fait mais pas encore visible pour les autres connexions.');

  step(4, 'Credit du compte de Bob de 200 EUR');
  await query(client, "UPDATE accounts SET balance = balance + 200 WHERE owner = 'Bob'");
  explain('Le credit est fait. Les deux operations sont en attente de COMMIT.');

  step(5, 'Validation avec COMMIT');
  await query(client, 'COMMIT');
  success('Transaction validee ! Les deux operations sont maintenant permanentes.');

  step(6, 'Verification des soldes');
  balances = await query(client, 'SELECT owner, balance FROM accounts ORDER BY owner');
  showBalance('Soldes apres transfert :', balances.rows);
  explain('Alice : 1000 - 200 = 800 EUR');
  explain('Bob   : 500 + 200 = 700 EUR');

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 2 : Rollback sur echec
  // ═══════════════════════════════════════════════════════════════════════════
  title('Scenario 2 : Rollback sur fonds insuffisants');

  step(1, 'Tentative de transfert de 5000 EUR (Alice n\'a que 800 EUR)');
  await query(client, 'BEGIN');
  explain('Transaction ouverte.');

  step(2, 'Debit de 5000 EUR sur le compte d\'Alice');
  await query(client, "UPDATE accounts SET balance = balance - 5000 WHERE owner = 'Alice'");
  const aliceBalance = await query(client, "SELECT balance FROM accounts WHERE owner = 'Alice'");
  warning(`Solde d'Alice en transaction : ${parseFloat(aliceBalance.rows[0].balance).toFixed(2)} EUR (negatif !)`);

  step(3, 'Detection du probleme : solde negatif');
  explain('On detecte que le solde serait negatif. On annule tout.');

  step(4, 'Annulation avec ROLLBACK');
  await query(client, 'ROLLBACK');
  success('Transaction annulee ! Aucune modification n\'est appliquee.');

  step(5, 'Verification : les soldes sont inchanges');
  balances = await query(client, 'SELECT owner, balance FROM accounts ORDER BY owner');
  showBalance('Soldes apres rollback :', balances.rows);
  explain('Les soldes sont identiques a avant la tentative de transfert.');

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO 3 : SAVEPOINT
  // ═══════════════════════════════════════════════════════════════════════════
  title('Scenario 3 : SAVEPOINT pour rollback partiel');

  step(1, 'Ouverture de la transaction');
  await query(client, 'BEGIN');

  step(2, 'Operation 1 : Credit de 100 EUR a Alice (bonus)');
  await query(client, "UPDATE accounts SET balance = balance + 100 WHERE owner = 'Alice'");
  explain('Solde temporaire Alice : 900 EUR');

  step(3, 'Creation d\'un SAVEPOINT');
  await query(client, 'SAVEPOINT avant_operation_risquee');
  explain('Point de sauvegarde cree. On peut revenir ici si necessaire.');

  step(4, 'Operation 2 (risquee) : Transfert de 2000 EUR vers Bob');
  await query(client, "UPDATE accounts SET balance = balance - 2000 WHERE owner = 'Alice'");
  const check = await query(client, "SELECT balance FROM accounts WHERE owner = 'Alice'");
  warning(`Solde Alice apres debit : ${parseFloat(check.rows[0].balance).toFixed(2)} EUR (negatif !)`);

  step(5, 'Rollback vers le SAVEPOINT');
  await query(client, 'ROLLBACK TO SAVEPOINT avant_operation_risquee');
  success('Retour au savepoint ! L\'operation risquee est annulee.');
  explain('Le bonus de 100 EUR est toujours applique.');

  step(6, 'COMMIT de la transaction');
  await query(client, 'COMMIT');

  step(7, 'Verification finale');
  balances = await query(client, 'SELECT owner, balance FROM accounts ORDER BY owner');
  showBalance('Soldes finaux :', balances.rows);
  explain('Alice : 800 + 100 (bonus) = 900 EUR (le transfert risque a ete annule)');
  explain('Bob   : 700 EUR (inchange)');

  // ═══════════════════════════════════════════════════════════════════════════
  // Resume
  // ═══════════════════════════════════════════════════════════════════════════
  title('Resume');
  console.log(`  ${BOLD}BEGIN${RESET}      → Demarre une transaction`);
  console.log(`  ${BOLD}COMMIT${RESET}     → Valide toutes les operations`);
  console.log(`  ${BOLD}ROLLBACK${RESET}   → Annule toutes les operations`);
  console.log(`  ${BOLD}SAVEPOINT${RESET}  → Cree un point de sauvegarde`);
  console.log(`  ${BOLD}ROLLBACK TO SAVEPOINT${RESET} → Revient au point de sauvegarde`);
  console.log();
  explain('Les transactions garantissent les proprietes ACID :');
  explain('  A — Atomicite : tout ou rien');
  explain('  C — Coherence : la base reste valide');
  explain('  I — Isolation : les transactions ne se voient pas mutuellement');
  explain('  D — Durabilite : une fois commite, c\'est permanent');
  console.log();

} finally {
  if (client) {
    await query(client, 'DROP TABLE IF EXISTS accounts');
    await client.end();
  }
}
