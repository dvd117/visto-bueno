import type { Db } from './db';
import { nowIso, touchWorkspace } from './db';
import { seed, seededPriorPayments } from '../seed/andina';
import { normalize } from '../../shared/engine/normalize';
import type { CompanyProfile } from '../../shared/domain/types';

/** Used until a workspace saves its own profile; workspaces created before C1 have no row. */
export const DEFAULT_COMPANY_PROFILE: CompanyProfile = {
  name: 'Andina Labs Inc.',
  operatingCountries: ['US'],
  vendorCountries: ['CO', 'MX', 'VE', 'CL', 'US'],
  currencies: ['USD', 'COP', 'MXN'],
};

function insertSeed(db: Db, workspaceId: string, now: string): void {
  db.prepare('INSERT INTO workspaces(id, created_at, last_seen) VALUES (?, ?, ?)').run(workspaceId, now, now);
  const data = seed();
  const insertVendor = db.prepare('INSERT INTO vendors(workspace_id, id, payload_json) VALUES (?, ?, ?)');
  for (const vendor of data.vendors) insertVendor.run(workspaceId, vendor.id, JSON.stringify(vendor));

  const insertContract = db.prepare('INSERT INTO contracts(workspace_id, id, vendor_id, payload_json) VALUES (?, ?, ?, ?)');
  for (const contract of data.contracts) {
    insertContract.run(workspaceId, contract.id, contract.vendorId, JSON.stringify(contract));
  }

  const insertBudget = db.prepare(`INSERT INTO budgets(workspace_id, cost_center, month, approved_usd_minor, payload_json)
    VALUES (?, ?, ?, ?, ?)`);
  for (const budget of data.budgets) {
    insertBudget.run(workspaceId, budget.costCenter, budget.month, budget.approvedUsdMinor, JSON.stringify(budget));
  }

  const insertValue = db.prepare('INSERT INTO workspace_values(workspace_id, key, value_json) VALUES (?, ?, ?)');
  insertValue.run(workspaceId, 'treasury', JSON.stringify(data.treasury));
  insertValue.run(workspaceId, 'rules', JSON.stringify(data.rules));
  insertValue.run(workspaceId, 'company', JSON.stringify(DEFAULT_COMPANY_PROFILE));

  const insertPayment = db.prepare(`INSERT INTO commitments(
    workspace_id, invoice_id, state, vendor_id, contract_id, period, month, cost_center,
    amount_usd_minor, normalized_invoice_id
  ) VALUES (?, ?, 'committed', ?, ?, ?, ?, ?, ?, ?)`);
  for (const payment of seededPriorPayments) {
    insertPayment.run(
      workspaceId,
      payment.id,
      payment.vendorId,
      payment.contractId,
      payment.period,
      /^\d{4}-\d{2}$/.test(payment.period) ? payment.period : null,
      payment.costCenter,
      payment.amountUsdMinor,
      normalize(payment.id),
    );
  }
}

export function ensureWorkspace(db: Db, workspaceId: string): void {
  if (!workspaceId.trim()) throw new Error('Workspace id cannot be empty.');
  const now = nowIso();
  db.transaction(() => {
    const existing = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId);
    if (existing) {
      db.prepare('UPDATE workspaces SET last_seen = ? WHERE id = ?').run(now, workspaceId);
      return;
    }
    insertSeed(db, workspaceId, now);
  }).immediate();
}

export function readCompanyProfile(db: Db, workspaceId: string): CompanyProfile {
  const row = db.prepare("SELECT value_json FROM workspace_values WHERE workspace_id = ? AND key = 'company'")
    .get(workspaceId) as { value_json: string } | undefined;
  return row ? JSON.parse(row.value_json) as CompanyProfile : structuredClone(DEFAULT_COMPANY_PROFILE);
}

export function writeCompanyProfile(db: Db, workspaceId: string, profile: CompanyProfile): void {
  touchWorkspace(db, workspaceId);
  db.prepare(`INSERT INTO workspace_values(workspace_id, key, value_json) VALUES (?, 'company', ?)
    ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = excluded.value_json`)
    .run(workspaceId, JSON.stringify(profile));
}

export function resetWorkspace(db: Db, workspaceId: string): void {
  if (!workspaceId.trim()) throw new Error('Workspace id cannot be empty.');
  const now = nowIso();
  db.transaction(() => {
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    insertSeed(db, workspaceId, now);
  }).immediate();
}
