import { Hono } from 'hono';
import type { Budget, Contract, CostCenter, ExtractionResult, JevAnswers, Rules, Treasury, Vendor } from '../../shared/domain/types';
import { DEFAULT_SIMULATION_TODAY, simulateImpact, type SimulationInput, type SimulationPriorCommitment } from '../../shared/engine/simulate';
import { validateRulesConfig } from '../../shared/engine/rules-config';
import { readLimitedBody } from '../middleware/limits';
import { markStale } from '../db/decide';
import { putRules, type Db } from '../db/db';

interface CommitmentRow {
  invoice_id: string;
  state: 'committed' | 'reserved';
  vendor_id: string | null;
  contract_id: string | null;
  period: string | null;
  month: string | null;
  cost_center: string | null;
  amount_usd_minor: number | null;
  normalized_invoice_id: string | null;
  invoice_date: string | null;
  extraction_json: string | null;
  source_text: string | null;
}

interface InvoiceSnapshotRow {
  id: string;
  extraction_json: string | null;
  jev_json: string | null;
}

interface RulesRouteEnv {
  Variables: { workspaceId: string };
}

const INVALID_REQUEST = { error: 'invalid_request', message: 'Solicitud inválida.' } as const;
const INTERNAL_ERROR = { error: 'internal_error', message: 'No se pudo procesar la solicitud.' } as const;

type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400; message: string }
  | { ok: false; status: 413; message: string };

async function readJsonBody(request: Request): Promise<JsonBodyResult> {
  try {
    const limited = await readLimitedBody(request);
    if (!limited.ok) return limited;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(limited.bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, message: INVALID_REQUEST.message };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readValue<T>(db: Db, workspaceId: string, key: string): T {
  const row = db.prepare('SELECT value_json FROM workspace_values WHERE workspace_id = ? AND key = ?')
    .get(workspaceId, key) as { value_json: string } | undefined;
  if (!row) throw new Error('Missing workspace value.');
  return JSON.parse(row.value_json) as T;
}

function priorDescription(row: CommitmentRow): string | undefined {
  if (row.extraction_json) {
    const extraction = JSON.parse(row.extraction_json) as ExtractionResult;
    if (extraction.ok && extraction.claims.description) return extraction.claims.description;
  }
  return row.source_text?.slice(0, 240) || undefined;
}

function readPriorCommitments(db: Db, workspaceId: string): SimulationPriorCommitment[] {
  const rows = db.prepare(`SELECT c.invoice_id, c.state, c.vendor_id, c.contract_id, c.period, c.month,
      c.cost_center, c.amount_usd_minor, c.normalized_invoice_id, i.invoice_date, i.extraction_json, i.source_text
    FROM commitments c LEFT JOIN invoices i ON i.workspace_id = c.workspace_id AND i.id = c.invoice_id
    WHERE c.workspace_id = ? AND c.state IN ('committed', 'reserved') ORDER BY c.invoice_id`)
    .all(workspaceId) as CommitmentRow[];
  const prior: SimulationPriorCommitment[] = [];

  for (const row of rows) {
    // Current rows are re-evaluated from their snapshots. Never coerce unknown money into the ledger.
    if (row.amount_usd_minor === null || row.month === null) continue;
    if (!Number.isSafeInteger(row.amount_usd_minor) || row.amount_usd_minor < 0) {
      throw new Error('Invalid commitment money.');
    }
    prior.push({
      invoiceId: row.invoice_id,
      state: row.state,
      amountUsdMinor: row.amount_usd_minor,
      month: row.month,
      costCenter: row.cost_center as CostCenter | null,
      vendorId: row.vendor_id,
      invoiceNumber: row.normalized_invoice_id,
      contractId: row.contract_id,
      contractPeriod: row.period,
      invoiceDate: row.invoice_date,
      description: priorDescription(row),
    });
  }
  return prior;
}

function readSimulationSnapshot(db: Db, workspaceId: string): SimulationInput {
  return db.transaction(() => {
    const workspaceData = {
      vendors: db.prepare('SELECT payload_json FROM vendors WHERE workspace_id = ? ORDER BY id')
        .all(workspaceId).map((row) => JSON.parse((row as { payload_json: string }).payload_json) as Vendor),
      contracts: db.prepare('SELECT payload_json FROM contracts WHERE workspace_id = ? ORDER BY id')
        .all(workspaceId).map((row) => JSON.parse((row as { payload_json: string }).payload_json) as Contract),
      budgets: db.prepare('SELECT payload_json FROM budgets WHERE workspace_id = ? ORDER BY month, cost_center')
        .all(workspaceId).map((row) => JSON.parse((row as { payload_json: string }).payload_json) as Budget),
      rules: readValue<Rules>(db, workspaceId, 'rules'),
      treasury: readValue<Treasury>(db, workspaceId, 'treasury'),
    };
    const invoiceRows = db.prepare(`SELECT id, extraction_json, jev_json FROM invoices
      WHERE workspace_id = ? AND status NOT IN ('queued', 'approved', 'rejected')
      AND extraction_json IS NOT NULL ORDER BY id`)
      .all(workspaceId) as InvoiceSnapshotRow[];
    const invoices = invoiceRows
      .map((row) => ({
        id: row.id,
        extraction: JSON.parse(row.extraction_json!) as ExtractionResult,
        jev: row.jev_json === null ? null : JSON.parse(row.jev_json) as JevAnswers,
      }));
    const priorCommitments = readPriorCommitments(db, workspaceId);

    return {
      ...workspaceData,
      invoices,
      priorCommitments,
      today: DEFAULT_SIMULATION_TODAY,
    };
  }).deferred();
}

export function createRulesRoutes({ db }: { db: Db }): Hono<RulesRouteEnv> {
  const routes = new Hono<RulesRouteEnv>();

  routes.get('/rules', (c) => {
    try {
      return c.json(readValue<Rules>(db, c.get('workspaceId'), 'rules'));
    } catch {
      return c.json(INTERNAL_ERROR, 500);
    }
  });

  routes.put('/rules', async (c) => {
    const parsed = await readJsonBody(c.req.raw);
    if (!parsed.ok) return c.json({ error: 'invalid_request', message: parsed.message }, parsed.status);

    let rules: Rules;
    try {
      rules = validateRulesConfig(parsed.value);
    } catch {
      return c.json(INVALID_REQUEST, 400);
    }

    try {
      const persisted = db.transaction(() => {
        const next = putRules(db, c.get('workspaceId'), rules);
        markStale(db, c.get('workspaceId'), { rules: true });
        return next;
      }).immediate();
      return c.json(persisted);
    } catch {
      return c.json(INTERNAL_ERROR, 500);
    }
  });

  routes.post('/rules/simulate', async (c) => {
    const parsed = await readJsonBody(c.req.raw);
    if (!parsed.ok) return c.json({ error: 'invalid_request', message: parsed.message }, parsed.status);
    if (!isRecord(parsed.value) || Object.keys(parsed.value).length !== 1 || !Object.hasOwn(parsed.value, 'rules')) {
      return c.json(INVALID_REQUEST, 400);
    }

    let candidateRules: Rules;
    try {
      candidateRules = validateRulesConfig(parsed.value.rules);
    } catch {
      return c.json(INVALID_REQUEST, 400);
    }

    try {
      const snapshot = readSimulationSnapshot(db, c.get('workspaceId'));
      return c.json(simulateImpact(snapshot, candidateRules));
    } catch {
      return c.json(INTERNAL_ERROR, 500);
    }
  });

  return routes;
}
