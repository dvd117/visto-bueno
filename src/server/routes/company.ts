import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { CompanyPreview, CompanyRecord } from '../../shared/api';
import { CURRENCIES } from '../../shared/domain/currencies';
import type { Rules } from '../../shared/domain/types';
import { validateRulesConfig } from '../../shared/engine/rules-config';
import { simulateImpact } from '../../shared/engine/simulate';
import { markStale } from '../db/decide';
import { getWorkspaceData, putRules, type Db } from '../db/db';
import { readCompanyProfile, writeCompanyProfile } from '../db/workspace';
import type { ServerEnv } from '../middleware/workspace';
import { readSimulationSnapshot } from './rules';

const INVALID_REQUEST = { error: 'invalid_request', message: 'Solicitud inválida.' } as const;
const INTERNAL_ERROR = { error: 'internal_error', message: 'No se pudo procesar la solicitud.' } as const;

const countrySchema = z.enum(['CO', 'MX', 'VE', 'CL', 'PE', 'AR', 'US']);
const currencySchema = z.enum(CURRENCIES);
const moneySchema = z.number().int().refine(Number.isSafeInteger).min(0);
const isUnique = (values: readonly string[]) => new Set(values).size === values.length;

const companySchema = z.object({
  name: z.string().trim().min(1).max(120),
  operatingCountries: z.array(countrySchema).min(1).max(7).refine(isUnique),
  vendorCountries: z.array(countrySchema).min(1).max(7).refine(isUnique),
  currencies: z.array(currencySchema).min(1).max(7).refine(isUnique).refine((list) => list.includes('USD')),
  limits: z.object({
    perPaymentUsdMinor: moneySchema, monthlyUsdMinor: moneySchema, approvalThresholdUsdMinor: moneySchema,
  }).strict(),
}).strict();

type CompanyInput = z.infer<typeof companySchema>;

function parseBody(c: Context<ServerEnv>): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(c.get('requestBytes'))) as unknown;
  } catch {
    return null;
  }
}

/** Returns null when the limits break the core rules (for example, threshold >= per-payment limit). */
function candidateRules(current: Rules, limits: CompanyInput['limits']): Rules | null {
  try {
    return validateRulesConfig({
      ...current,
      perPaymentLimitUsdMinor: limits.perPaymentUsdMinor,
      monthlyLimitUsdMinor: limits.monthlyUsdMinor,
      approvalThresholdUsdMinor: limits.approvalThresholdUsdMinor,
    });
  } catch {
    return null;
  }
}

function limitsChanged(current: Rules, next: Rules): boolean {
  return current.perPaymentLimitUsdMinor !== next.perPaymentLimitUsdMinor
    || current.monthlyLimitUsdMinor !== next.monthlyLimitUsdMinor
    || current.approvalThresholdUsdMinor !== next.approvalThresholdUsdMinor;
}

function pendingCount(db: Db, workspaceId: string): number {
  // Same statuses that markStale(rules) rewrites to 'stale'.
  return (db.prepare(`SELECT COUNT(*) AS count FROM invoices WHERE workspace_id = ?
    AND status IN ('ready', 'approval_required', 'review_required')`).get(workspaceId) as { count: number }).count;
}

function readCompany(db: Db, workspaceId: string): CompanyRecord {
  const profile = readCompanyProfile(db, workspaceId);
  const { rules } = getWorkspaceData(db, workspaceId);
  return {
    name: profile.name,
    operatingCountries: profile.operatingCountries,
    vendorCountries: profile.vendorCountries,
    currencies: profile.currencies,
    limits: {
      perPaymentUsdMinor: rules.perPaymentLimitUsdMinor,
      monthlyUsdMinor: rules.monthlyLimitUsdMinor,
      approvalThresholdUsdMinor: rules.approvalThresholdUsdMinor,
    },
  };
}

export function createCompanyRoutes({ db }: { db: Db }): Hono<ServerEnv> {
  const routes = new Hono<ServerEnv>();

  routes.get('/company', (c) => c.json(readCompany(db, c.get('workspaceId'))));

  routes.put('/company', (c) => {
    const workspaceId = c.get('workspaceId');
    const parsed = companySchema.safeParse(parseBody(c));
    if (!parsed.success) return c.json(INVALID_REQUEST, 400);
    const { limits, ...profile } = parsed.data;

    const saved = db.transaction(() => {
      const current = getWorkspaceData(db, workspaceId).rules;
      const candidate = candidateRules(current, limits);
      if (!candidate) return null;
      writeCompanyProfile(db, workspaceId, profile);
      if (limitsChanged(current, candidate)) {
        putRules(db, workspaceId, candidate);
        markStale(db, workspaceId, { rules: true });
      }
      return readCompany(db, workspaceId);
    }).immediate();
    return saved ? c.json(saved) : c.json(INVALID_REQUEST, 400);
  });

  routes.post('/company/preview', (c) => {
    const workspaceId = c.get('workspaceId');
    const parsed = companySchema.safeParse(parseBody(c));
    if (!parsed.success) return c.json(INVALID_REQUEST, 400);
    const current = getWorkspaceData(db, workspaceId).rules;
    const candidate = candidateRules(current, parsed.data.limits);
    if (!candidate) return c.json(INVALID_REQUEST, 400);

    try {
      const impact = simulateImpact(readSimulationSnapshot(db, workspaceId), candidate);
      const body: CompanyPreview = {
        ...impact,
        staleCount: limitsChanged(current, candidate) ? pendingCount(db, workspaceId) : 0,
      };
      return c.json(body);
    } catch {
      return c.json(INTERNAL_ERROR, 500);
    }
  });

  return routes;
}
