PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_values (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS vendors (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS contracts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, vendor_id) REFERENCES vendors(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS budgets (
  workspace_id TEXT NOT NULL,
  cost_center TEXT NOT NULL,
  month TEXT NOT NULL,
  approved_usd_minor INTEGER NOT NULL CHECK (approved_usd_minor >= 0),
  payload_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, cost_center, month),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS invoices (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'ready', 'approval_required', 'review_required', 'stopped', 'approved', 'rejected', 'stale')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('pdf', 'image', 'text')),
  source_text TEXT,
  file_path TEXT,
  extraction_json TEXT,
  jev_json TEXT,
  invoice_hash TEXT,
  vendor_id TEXT,
  contract_id TEXT,
  invoice_date TEXT,
  due_date TEXT,
  evaluated_today TEXT,
  month TEXT,
  contract_period TEXT,
  cost_center TEXT,
  amount_usd_minor INTEGER,
  normalized_invoice_id TEXT,
  latest_record_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS decision_records (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  supersedes_id TEXT,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, invoice_id) REFERENCES invoices(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, supersedes_id) REFERENCES decision_records(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS commitments (
  workspace_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('committed', 'reserved')),
  vendor_id TEXT,
  contract_id TEXT,
  period TEXT,
  month TEXT,
  cost_center TEXT,
  amount_usd_minor INTEGER CHECK (amount_usd_minor IS NULL OR amount_usd_minor >= 0),
  normalized_invoice_id TEXT,
  PRIMARY KEY (workspace_id, invoice_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  event TEXT NOT NULL,
  status TEXT NOT NULL,
  actor TEXT,
  reason TEXT,
  headline TEXT NOT NULL,
  seal TEXT,
  record_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, invoice_id) REFERENCES invoices(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, record_id) REFERENCES decision_records(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
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

CREATE TABLE IF NOT EXISTS flag_resolutions (
  workspace_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  flag_id TEXT NOT NULL,
  resolution_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, invoice_id, flag_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, invoice_id) REFERENCES invoices(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS invoices_workspace_status ON invoices(workspace_id, status);
CREATE INDEX IF NOT EXISTS invoices_workspace_vendor_date ON invoices(workspace_id, vendor_id, invoice_date);
CREATE INDEX IF NOT EXISTS decisions_workspace_invoice_time ON decision_records(workspace_id, invoice_id, created_at);
CREATE INDEX IF NOT EXISTS commitments_workspace_month_state ON commitments(workspace_id, month, state);
CREATE INDEX IF NOT EXISTS commitments_workspace_vendor_invoice ON commitments(workspace_id, vendor_id, normalized_invoice_id);
CREATE UNIQUE INDEX IF NOT EXISTS commitments_unique_committed_invoice
  ON commitments(workspace_id, vendor_id, normalized_invoice_id)
  WHERE state = 'committed' AND vendor_id IS NOT NULL AND normalized_invoice_id IS NOT NULL AND normalized_invoice_id <> '';
CREATE INDEX IF NOT EXISTS audit_workspace_time ON audit_events(workspace_id, created_at, id);
