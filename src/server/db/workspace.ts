import { randomUUID } from 'node:crypto';
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

export const SECONDARY_DEMO_COMPANY_NAME = 'Marea Norte SpA';

export interface OwnedWorkspaceClient {
  id: string;
  clientId: string;
  ownerId: string;
  defaultName: string;
  isPrimary: boolean;
  createdAt: string;
}

interface WorkspaceClientRow {
  client_id: string;
  workspace_id: string;
  owner_id: string;
  default_name: string;
  is_primary: number;
  created_at: string;
}

function toOwnedWorkspace(row: WorkspaceClientRow): OwnedWorkspaceClient {
  return {
    id: row.workspace_id,
    clientId: row.client_id,
    ownerId: row.owner_id,
    defaultName: row.default_name,
    isPrimary: row.is_primary === 1,
    createdAt: row.created_at,
  };
}

function workspaceClientsForOwner(db: Db, ownerId: string): OwnedWorkspaceClient[] {
  return (db.prepare(`SELECT client_id, workspace_id, owner_id, default_name, is_primary, created_at
    FROM workspace_clients WHERE owner_id = ? ORDER BY is_primary DESC, created_at, workspace_id`)
    .all(ownerId) as WorkspaceClientRow[]).map(toOwnedWorkspace);
}

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

function insertEmptyClientWorkspace(db: Db, workspaceId: string, now: string, companyName: string): void {
  db.prepare('INSERT INTO workspaces(id, created_at, last_seen) VALUES (?, ?, ?)').run(workspaceId, now, now);
  const defaults = seed();
  const insertValue = db.prepare('INSERT INTO workspace_values(workspace_id, key, value_json) VALUES (?, ?, ?)');
  insertValue.run(workspaceId, 'treasury', JSON.stringify({ ...defaults.treasury, balanceUsdMinor: 0 }));
  insertValue.run(workspaceId, 'rules', JSON.stringify(defaults.rules));
  insertValue.run(workspaceId, 'company', JSON.stringify({ ...DEFAULT_COMPANY_PROFILE, name: companyName }));
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

/** Create the demo's two workspaces once, tying both to a server-issued owner token. */
export function ensureClientWorkspaces(db: Db, ownerId: string, legacyWorkspaceId?: string): void {
  if (!ownerId.trim()) throw new Error('Workspace owner id cannot be empty.');
  const now = nowIso();
  db.transaction(() => {
    let clients = workspaceClientsForOwner(db, ownerId);
    if (!clients.some((client) => client.isPrimary)) {
      const primaryId = clients.length === 0 ? legacyWorkspaceId ?? ownerId : ownerId;
      const existing = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(primaryId);
      if (existing) db.prepare('UPDATE workspaces SET last_seen = ? WHERE id = ?').run(now, primaryId);
      else insertSeed(db, primaryId, now);
      db.prepare(`INSERT INTO workspace_clients(client_id, workspace_id, owner_id, default_name, is_primary, created_at)
        VALUES (?, ?, ?, ?, 1, ?)`)
        .run(randomUUID(), primaryId, ownerId, DEFAULT_COMPANY_PROFILE.name, now);
    }

    clients = workspaceClientsForOwner(db, ownerId);
    if (!clients.some((client) => !client.isPrimary)) {
      const secondaryId = randomUUID();
      insertEmptyClientWorkspace(db, secondaryId, now, SECONDARY_DEMO_COMPANY_NAME);
      db.prepare(`INSERT INTO workspace_clients(client_id, workspace_id, owner_id, default_name, is_primary, created_at)
        VALUES (?, ?, ?, ?, 0, ?)`)
        .run(randomUUID(), secondaryId, ownerId, SECONDARY_DEMO_COMPANY_NAME, now);
    }
  }).immediate();
}

export function listOwnedWorkspaceClients(db: Db, ownerId: string): OwnedWorkspaceClient[] {
  return workspaceClientsForOwner(db, ownerId);
}

export function getOwnedWorkspaceClient(db: Db, ownerId: string, clientId: string): OwnedWorkspaceClient | null {
  const row = db.prepare(`SELECT client_id, workspace_id, owner_id, default_name, is_primary, created_at
    FROM workspace_clients WHERE owner_id = ? AND client_id = ?`).get(ownerId, clientId) as WorkspaceClientRow | undefined;
  return row ? toOwnedWorkspace(row) : null;
}

export function primaryWorkspaceForOwner(db: Db, ownerId: string): OwnedWorkspaceClient | null {
  return workspaceClientsForOwner(db, ownerId).find((client) => client.isPrimary) ?? null;
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
  const client = db.prepare(`SELECT client_id, workspace_id, owner_id, default_name, is_primary, created_at
    FROM workspace_clients WHERE workspace_id = ?`).get(workspaceId) as WorkspaceClientRow | undefined;
  db.transaction(() => {
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
    if (client && client.is_primary === 0) insertEmptyClientWorkspace(db, workspaceId, now, client.default_name);
    else insertSeed(db, workspaceId, now);
    if (client) {
      db.prepare(`INSERT INTO workspace_clients(client_id, workspace_id, owner_id, default_name, is_primary, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(client.client_id, client.workspace_id, client.owner_id, client.default_name, client.is_primary, client.created_at);
      writeCompanyProfile(db, workspaceId, { ...DEFAULT_COMPANY_PROFILE, name: client.default_name });
    }
  }).immediate();
}
