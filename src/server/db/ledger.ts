import type { CostCenter } from '../../shared/domain/types';
import type { LedgerView } from '../../shared/engine/rules';
import { normalize } from '../../shared/engine/normalize';
import type { Db } from './db';
import { touchWorkspace } from './db';

export interface LedgerOptions {
  excludeInvoiceId?: string;
  today?: string;
}

function asSafeMinor(value: unknown): number {
  const amount = Number(value ?? 0);
  if (!Number.isSafeInteger(amount)) throw new Error('Ledger total exceeds safe integer minor units.');
  return amount;
}

function sum(db: Db, sql: string, workspaceId: string, month: string, excludeInvoiceId?: string | null, costCenter?: CostCenter): number {
  const row = db.prepare(sql).get(
    workspaceId,
    month,
    ...(costCenter ? [costCenter] : []),
    excludeInvoiceId ?? null,
    excludeInvoiceId ?? null,
  ) as { total: number | bigint | null };
  return asSafeMinor(row.total);
}

function startDate(today: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !Number.isInteger(days) || days < 0) {
    throw new Error('Invalid date window for recent invoices.');
  }
  const date = new Date(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid reference date for recent invoices.');
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

export function ledgerView(db: Db, workspaceId: string, options: LedgerOptions = {}): LedgerView {
  touchWorkspace(db, workspaceId);
  const exclusion = options.excludeInvoiceId ?? null;
  const today = options.today ?? '2026-10-16';

  return {
    committedUsdMinor(month) {
      return sum(db, `SELECT COALESCE(SUM(amount_usd_minor), 0) AS total FROM commitments
        WHERE workspace_id = ? AND month = ? AND state = 'committed'
        AND (? IS NULL OR invoice_id <> ?)`, workspaceId, month, exclusion);
    },
    reservedUsdMinor(month) {
      return sum(db, `SELECT COALESCE(SUM(amount_usd_minor), 0) AS total FROM commitments
        WHERE workspace_id = ? AND month = ? AND state = 'reserved'
        AND (? IS NULL OR invoice_id <> ?)`, workspaceId, month, exclusion);
    },
    committedByCostCenter(costCenter, month) {
      return sum(db, `SELECT COALESCE(SUM(amount_usd_minor), 0) AS total FROM commitments
        WHERE workspace_id = ? AND month = ? AND cost_center = ? AND state = 'committed'
        AND (? IS NULL OR invoice_id <> ?)`, workspaceId, month, exclusion, costCenter);
    },
    reservedByCostCenter(costCenter, month) {
      return sum(db, `SELECT COALESCE(SUM(amount_usd_minor), 0) AS total FROM commitments
        WHERE workspace_id = ? AND month = ? AND cost_center = ? AND state = 'reserved'
        AND (? IS NULL OR invoice_id <> ?)`, workspaceId, month, exclusion, costCenter);
    },
    hasInvoiceId(vendorId, normalizedId) {
      const row = db.prepare(`SELECT 1 FROM commitments WHERE workspace_id = ? AND vendor_id = ?
        AND normalized_invoice_id = ? AND state = 'committed'
        AND (? IS NULL OR invoice_id <> ?) LIMIT 1`)
        .get(workspaceId, vendorId, normalize(normalizedId), exclusion, exclusion);
      return row !== undefined;
    },
    hasCommitmentForContractPeriod(contractId, period) {
      const row = db.prepare(`SELECT 1 FROM commitments WHERE workspace_id = ? AND contract_id = ?
        AND period = ? AND state = 'committed'
        AND (? IS NULL OR invoice_id <> ?) LIMIT 1`)
        .get(workspaceId, contractId, period, exclusion, exclusion);
      return row !== undefined;
    },
    recentByVendor(vendorId, days) {
      const from = startDate(today, days);
      const rows = db.prepare(`SELECT id, extraction_json, source_text FROM invoices
        WHERE workspace_id = ? AND vendor_id = ? AND invoice_date >= ? AND invoice_date <= ?
        AND status IN ('ready', 'approval_required', 'review_required', 'approved', 'stale')
        AND (? IS NULL OR id <> ?) ORDER BY invoice_date DESC, id`)
        .all(workspaceId, vendorId, from, today, exclusion, exclusion) as Array<{
          id: string; extraction_json: string | null; source_text: string | null;
        }>;
      return rows.map((row) => {
        let description = '';
        if (row.extraction_json) {
          try {
            const extraction = JSON.parse(row.extraction_json) as { ok?: boolean; claims?: { description?: string | null } };
            description = extraction.ok ? extraction.claims?.description ?? '' : '';
          } catch {
            description = '';
          }
        }
        return { invoiceId: row.id, description: description || row.source_text?.slice(0, 240) || '' };
      });
    },
  };
}
