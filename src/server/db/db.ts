import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogEntry } from '../../shared/api';
import type {
  Budget, Contract, DecisionRecord, ExtractionResult, InvoiceStatus, JevAnswers, Rules, SourceKind,
  Treasury, Vendor,
} from '../../shared/domain/types';

export type Db = InstanceType<typeof Database>;

export interface WorkspaceData {
  vendors: Vendor[];
  contracts: Contract[];
  budgets: Budget[];
  treasury: Treasury;
  rules: Rules;
}

export interface NewInvoice {
  id: string;
  sourceKind: SourceKind;
  sourceText?: string | null;
  filePath?: string | null;
}

export interface StoredInvoice {
  id: string;
  status: InvoiceStatus;
  sourceKind: SourceKind;
  sourceText: string | null;
  filePath: string | null;
  extraction: ExtractionResult | null;
  jev: JevAnswers | null;
  invoiceHash: string | null;
  vendorId: string | null;
  contractId: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  evaluatedToday: string | null;
  month: string | null;
  contractPeriod: string | null;
  costCenter: string | null;
  amountUsdMinor: number | null;
  normalizedInvoiceId: string | null;
  latestRecord: DecisionRecord | null;
  createdAt: string;
  updatedAt: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

function decode<T>(value: string | null): T | null {
  return value === null ? null : JSON.parse(value) as T;
}

export function touchWorkspace(db: Db, workspaceId: string, at = nowIso()): void {
  if (!workspaceId.trim()) throw new Error('Workspace id cannot be empty.');
  const result = db.prepare('UPDATE workspaces SET last_seen = ? WHERE id = ?').run(at, workspaceId);
  if (result.changes !== 1) throw new Error(`Workspace not found: ${workspaceId}`);
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  const schema = readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8');
  db.exec(schema);
  migrateIdempotencyActions(db);
  migrateIdempotencyInputFingerprint(db);
  return db;
}

function migrateIdempotencyActions(db: Db): void {
  const migrate = db.transaction(() => {
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_keys'")
      .get() as { sql: string } | undefined;
    if (table?.sql.includes("'decided'")) return;
    const columns = db.prepare('PRAGMA table_info(idempotency_keys)').all() as Array<{ name: string }>;
    const fingerprint = columns.some(({ name }) => name === 'input_fingerprint')
      ? 'input_fingerprint' : 'NULL';

    db.exec(`CREATE TABLE idempotency_keys_next (
      workspace_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      invoice_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('approved', 'rejected', 'decided')),
      input_fingerprint TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, idempotency_key),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, invoice_id) REFERENCES invoices(workspace_id, id) ON DELETE CASCADE,
      FOREIGN KEY (workspace_id, record_id) REFERENCES decision_records(workspace_id, id)
    );
    INSERT INTO idempotency_keys_next(workspace_id, idempotency_key, invoice_id, record_id, action, input_fingerprint, created_at)
      SELECT workspace_id, idempotency_key, invoice_id, record_id, action, ${fingerprint}, created_at FROM idempotency_keys;
    DROP TABLE idempotency_keys;
    ALTER TABLE idempotency_keys_next RENAME TO idempotency_keys;`);
  });
  migrate.immediate();
}

function migrateIdempotencyInputFingerprint(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(idempotency_keys)').all() as Array<{ name: string }>;
  if (columns.some(({ name }) => name === 'input_fingerprint')) return;
  db.exec('ALTER TABLE idempotency_keys ADD COLUMN input_fingerprint TEXT');
}

export function getWorkspaceData(db: Db, workspaceId: string): WorkspaceData {
  touchWorkspace(db, workspaceId);
  const vendors = db.prepare('SELECT payload_json FROM vendors WHERE workspace_id = ? ORDER BY id')
    .all(workspaceId).map((row) => decode<Vendor>((row as { payload_json: string }).payload_json)!);
  const contracts = db.prepare('SELECT payload_json FROM contracts WHERE workspace_id = ? ORDER BY id')
    .all(workspaceId).map((row) => decode<Contract>((row as { payload_json: string }).payload_json)!);
  const budgets = db.prepare('SELECT payload_json FROM budgets WHERE workspace_id = ? ORDER BY month, cost_center')
    .all(workspaceId).map((row) => decode<Budget>((row as { payload_json: string }).payload_json)!);
  const values = db.prepare('SELECT key, value_json FROM workspace_values WHERE workspace_id = ?')
    .all(workspaceId) as Array<{ key: string; value_json: string }>;
  const byKey = new Map(values.map((entry) => [entry.key, entry.value_json]));
  const treasuryJson = byKey.get('treasury');
  const rulesJson = byKey.get('rules');
  if (!treasuryJson || !rulesJson) throw new Error(`Workspace data is incomplete: ${workspaceId}`);
  return {
    vendors,
    contracts,
    budgets,
    treasury: JSON.parse(treasuryJson) as Treasury,
    rules: JSON.parse(rulesJson) as Rules,
  };
}

export function putRules(db: Db, workspaceId: string, rules: Rules): Rules {
  touchWorkspace(db, workspaceId);
  const current = getWorkspaceData(db, workspaceId).rules;
  const next = { ...rules, version: Math.max(rules.version, current.version + 1) };
  db.prepare(`INSERT INTO workspace_values(workspace_id, key, value_json) VALUES (?, 'rules', ?)
    ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = excluded.value_json`)
    .run(workspaceId, JSON.stringify(next));
  return next;
}

export function putTreasury(db: Db, workspaceId: string, treasury: Treasury): void {
  touchWorkspace(db, workspaceId);
  db.prepare(`INSERT INTO workspace_values(workspace_id, key, value_json) VALUES (?, 'treasury', ?)
    ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = excluded.value_json`)
    .run(workspaceId, JSON.stringify(treasury));
}

export function putVendor(db: Db, workspaceId: string, vendor: Vendor): Vendor {
  touchWorkspace(db, workspaceId);
  const current = db.prepare('SELECT payload_json FROM vendors WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, vendor.id) as { payload_json: string } | undefined;
  const previous = current ? JSON.parse(current.payload_json) as Vendor : null;
  const next = { ...vendor, version: previous ? Math.max(vendor.version, previous.version + 1) : vendor.version };
  db.prepare(`INSERT INTO vendors(workspace_id, id, payload_json) VALUES (?, ?, ?)
    ON CONFLICT(workspace_id, id) DO UPDATE SET payload_json = excluded.payload_json`)
    .run(workspaceId, next.id, JSON.stringify(next));
  return next;
}

export function putContract(db: Db, workspaceId: string, contract: Contract): Contract {
  touchWorkspace(db, workspaceId);
  const current = db.prepare('SELECT payload_json FROM contracts WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, contract.id) as { payload_json: string } | undefined;
  const previous = current ? JSON.parse(current.payload_json) as Contract : null;
  const next = { ...contract, version: previous ? Math.max(contract.version, previous.version + 1) : contract.version };
  db.prepare(`INSERT INTO contracts(workspace_id, id, vendor_id, payload_json) VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace_id, id) DO UPDATE SET vendor_id = excluded.vendor_id, payload_json = excluded.payload_json`)
    .run(workspaceId, next.id, next.vendorId, JSON.stringify(next));
  return next;
}

export function putBudget(db: Db, workspaceId: string, budget: Budget): void {
  touchWorkspace(db, workspaceId);
  db.prepare(`INSERT INTO budgets(workspace_id, cost_center, month, approved_usd_minor, payload_json)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, cost_center, month) DO UPDATE SET
    approved_usd_minor = excluded.approved_usd_minor, payload_json = excluded.payload_json`)
    .run(workspaceId, budget.costCenter, budget.month, budget.approvedUsdMinor, JSON.stringify(budget));
}

export function createInvoice(db: Db, workspaceId: string, input: NewInvoice): StoredInvoice {
  touchWorkspace(db, workspaceId);
  if (!input.id.trim()) throw new Error('Invoice id cannot be empty.');
  if (db.prepare('SELECT 1 FROM commitments WHERE workspace_id = ? AND invoice_id = ?').get(workspaceId, input.id)) {
    throw new Error(`Invoice id is reserved by a seeded commitment: ${input.id}`);
  }
  const now = nowIso();
  db.prepare(`INSERT INTO invoices(workspace_id, id, status, source_kind, source_text, file_path, created_at, updated_at)
    VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`)
    .run(workspaceId, input.id, input.sourceKind, input.sourceText ?? null, input.filePath ?? null, now, now);
  const invoice = getInvoice(db, workspaceId, input.id);
  if (!invoice) throw new Error(`Unable to create invoice: ${input.id}`);
  return invoice;
}

function hydrateInvoice(row: Record<string, unknown>, recordJson: string | null): StoredInvoice {
  return {
    id: row.id as string,
    status: row.status as InvoiceStatus,
    sourceKind: row.source_kind as SourceKind,
    sourceText: row.source_text as string | null,
    filePath: row.file_path as string | null,
    extraction: decode<ExtractionResult>(row.extraction_json as string | null),
    jev: decode<JevAnswers>(row.jev_json as string | null),
    invoiceHash: row.invoice_hash as string | null,
    vendorId: row.vendor_id as string | null,
    contractId: row.contract_id as string | null,
    invoiceDate: row.invoice_date as string | null,
    dueDate: row.due_date as string | null,
    evaluatedToday: row.evaluated_today as string | null,
    month: row.month as string | null,
    contractPeriod: row.contract_period as string | null,
    costCenter: row.cost_center as string | null,
    amountUsdMinor: row.amount_usd_minor as number | null,
    normalizedInvoiceId: row.normalized_invoice_id as string | null,
    latestRecord: decode<DecisionRecord>(recordJson),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function getInvoice(db: Db, workspaceId: string, invoiceId: string): StoredInvoice | null {
  touchWorkspace(db, workspaceId);
  const row = db.prepare('SELECT * FROM invoices WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, invoiceId) as Record<string, unknown> | undefined;
  if (!row) return null;
  let recordJson: string | null = null;
  if (row.latest_record_id) {
    const record = db.prepare('SELECT record_json FROM decision_records WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, row.latest_record_id as string) as { record_json: string } | undefined;
    recordJson = record?.record_json ?? null;
  }
  return hydrateInvoice(row, recordJson);
}

export function listInvoices(db: Db, workspaceId: string): StoredInvoice[] {
  touchWorkspace(db, workspaceId);
  const rows = db.prepare('SELECT * FROM invoices WHERE workspace_id = ? ORDER BY created_at, id')
    .all(workspaceId) as Array<Record<string, unknown>>;
  const latestRecord = db.prepare('SELECT record_json FROM decision_records WHERE workspace_id = ? AND id = ?');
  return rows.map((row) => {
    const record = row.latest_record_id
      ? latestRecord.get(workspaceId, row.latest_record_id as string) as { record_json: string } | undefined
      : undefined;
    return hydrateInvoice(row, record?.record_json ?? null);
  });
}

export function getDecisionHistory(db: Db, workspaceId: string, invoiceId: string): DecisionRecord[] {
  touchWorkspace(db, workspaceId);
  return db.prepare('SELECT record_json FROM decision_records WHERE workspace_id = ? AND invoice_id = ? ORDER BY rowid')
    .all(workspaceId, invoiceId)
    .map((row) => JSON.parse((row as { record_json: string }).record_json) as DecisionRecord);
}

export function getAuditLog(db: Db, workspaceId: string): LogEntry[] {
  touchWorkspace(db, workspaceId);
  return db.prepare(`SELECT created_at, invoice_id, status, headline, actor, seal
    FROM audit_events WHERE workspace_id = ? ORDER BY created_at, id`)
    .all(workspaceId)
    .map((row) => {
      const event = row as { created_at: string; invoice_id: string; status: InvoiceStatus; headline: string; actor: string | null; seal: string | null };
      return {
        at: event.created_at,
        invoiceId: event.invoice_id,
        status: event.status,
        headline: event.headline,
        by: event.actor,
        seal: event.seal ?? '',
      };
    });
}
