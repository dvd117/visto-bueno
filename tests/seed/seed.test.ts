import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPdf } from '../../src/server/extract/pdf';
import { seed, seededPriorPayments } from '../../src/server/seed/andina';
import type { InvoiceStatus, SourceKind } from '../../src/shared/domain/types';

interface InvoiceLabel {
  invoiceId: string;
  file: string;
  sourceKind: SourceKind;
  expected: InvoiceStatus;
  reasonCheck: string;
}

interface PriorPayment {
  id: string;
  vendorId: string | null;
  contractId: string | null;
  period: string;
  costCenter: string;
  amountUsdMinor: number;
}

const labels = JSON.parse(
  readFileSync(resolve(process.cwd(), 'fixtures/invoices/labels.json'), 'utf8'),
) as InvoiceLabel[];

const invoiceContracts: Record<string, string | null> = {
  'AL-030': 'pixel-diseno-monthly',
  'AL-031': 'norte-consultoria-monthly',
  'AL-032': 'estacion-mantenimiento-once',
  'AL-033': 'taller-calibracion-monthly',
  'AL-034': 'taller-revision-once',
  'AL-035': 'pixel-auditoria-once',
  'AL-036': 'imprenta-reimpresion-once',
  'AL-037': 'valentina-diseno-monthly',
  'AL-038': 'carlos-backend-variable',
  'AL-039': null,
  'AL-040': 'valentina-ajustes-once',
  'AL-041': 'imprenta-materiales-once',
  'AL-042': 'nube-hosting-monthly',
  'AL-043': 'lex-registro-annual',
  'AL-044': 'datos-restablecimiento-once',
  'AL-045': 'datos-soporte-monthly',
  'AL-046': 'nube-hosting-monthly',
  'AL-047': 'pixel-prototipo-once',
  'AL-048': 'taller-revision-once',
  'AL-049': 'lex-presentacion-once',
};

const priorPayments = seededPriorPayments as unknown as readonly PriorPayment[];

describe('Andina seed', () => {
  it('keeps known real tax IDs out of the seed and invoice fixtures', async () => {
    const knownRealTaxIds = ['76.384.219-3', '900.123.456-7'];
    const fixtureDirectory = resolve(process.cwd(), 'fixtures/invoices');
    const fixtureFiles = readdirSync(fixtureDirectory);

    const seedText = JSON.stringify(seed());
    const sourceTexts = fixtureFiles.filter((name) => name.endsWith('.txt'))
      .map((file) => readFileSync(resolve(fixtureDirectory, file), 'utf8'));
    const pdfTexts = await Promise.all(fixtureFiles.filter((name) => name.endsWith('.pdf'))
      .map(async (file) => (await readPdf(readFileSync(resolve(fixtureDirectory, file)))).text));

    for (const realTaxId of knownRealTaxIds) {
      expect(seedText).not.toContain(realTaxId);
      for (const text of [...sourceTexts, ...pdfTexts]) {
        expect(text).not.toContain(realTaxId);
      }
    }
  });

  it('is internally consistent with the labeled invoice set', () => {
    const data = seed();
    const vendorIds = new Set(data.vendors.map((vendor) => vendor.id));
    const invoiceIds = labels.map((label) => label.invoiceId);

    expect(data.vendors).toHaveLength(10);
    expect(data.contracts.every((contract) => vendorIds.has(contract.vendorId))).toBe(true);
    expect(new Set(invoiceIds).size).toBe(invoiceIds.length);
    expect(labels).toHaveLength(20);
    expect([...invoiceIds].sort()).toEqual(Array.from({ length: 20 }, (_, index) => `AL-${String(index + 30).padStart(3, '0')}`));
    expect(Object.keys(invoiceContracts).sort()).toEqual([...invoiceIds].sort());
    expect(labels.every((label) => readFileSync(resolve(process.cwd(), label.file)).length > 0)).toBe(true);
    for (const label of labels) {
      const source = readFileSync(resolve(process.cwd(), 'fixtures/invoices', `${label.invoiceId}.txt`), 'utf8');
      expect(source).toContain(label.invoiceId);
      expect(source).toMatch(/(?:USD|COP|MXN)\s+[\d.,]+/);
      expect(source).toMatch(/····\s*\d{4}/);
      expect(source).toMatch(/(?:NIT|RIF|RFC|RUT|Tax ID|EIN)\s*[: ]/i);
      expect(label.reasonCheck.length).toBeGreaterThan(0);
    }
    expect(readFileSync(resolve(process.cwd(), 'fixtures/invoices/AL-034.txt'), 'utf8')).toContain('COTIZACIÓN');
    expect(readFileSync(resolve(process.cwd(), 'fixtures/invoices/AL-049.txt'), 'utf8')).toContain('AL-043');
    expect(readFileSync(resolve(process.cwd(), 'fixtures/invoices/AL-044.txt'), 'utf8'))
      .toContain('Restablecimiento urgente de enlace');
    expect(data.vendors.find((vendor) => vendor.name === 'Nube Andina Tecnología S. de R.L.')?.payoutAccount.endsWith('8890')).toBe(true);
    expect(data.budgets.filter((budget) => budget.month === '2026-10').sort((a, b) => a.costCenter.localeCompare(b.costCenter)))
      .toEqual([
        { costCenter: 'diseno', month: '2026-10', approvedUsdMinor: 600_000 },
        { costCenter: 'ingenieria', month: '2026-10', approvedUsdMinor: 2_000_000 },
        { costCenter: 'legal', month: '2026-10', approvedUsdMinor: 500_000 },
        { costCenter: 'operaciones', month: '2026-10', approvedUsdMinor: 600_000 },
      ]);
    expect(seededPriorPayments.reduce((sum, payment) => sum + payment.amountUsdMinor, 0)).toBe(185_000);
    const operationsBudget = data.budgets.find((budget) => budget.costCenter === 'operaciones' && budget.month === '2026-10');
    expect(operationsBudget?.approvedUsdMinor).toBe(600_000);
    expect(operationsBudget!.approvedUsdMinor - priorPayments.reduce((sum, payment) => sum + payment.amountUsdMinor, 0)).toBe(415_000);
    expect(data.treasury.balanceUsdMinor).toBe(4_800_000);
    expect(data.treasury.fx).toEqual([
      { currency: 'COP', perUsd: '4171.30', date: '2026-10-15' },
      { currency: 'MXN', perUsd: '18.8656', date: '2026-10-15' },
      { currency: 'USD', perUsd: '1', date: '2026-10-15' },
    ]);
    expect(data.rules).toEqual({
      version: 1,
      perPaymentLimitUsdMinor: 1_500_000,
      monthlyLimitUsdMinor: 6_000_000,
      approvalThresholdUsdMinor: 300_000,
      fuzzyDuplicateWindowDays: 60,
      preset: 'equilibrado',
    });
    const contracts = new Map(data.contracts.map((contract) => [contract.id, contract]));
    expect(contracts.get('nube-hosting-monthly')).toMatchObject({
      vendorId: 'nube-andina', type: 'fixed', currency: 'USD', amountMinor: 85_000,
      billingFrequency: 'monthly', costCenter: 'operaciones',
    });
    expect(contracts.get('valentina-diseno-monthly')).toMatchObject({
      vendorId: 'valentina-ruiz', type: 'fixed', currency: 'COP', amountMinor: 480_000_000,
      billingFrequency: 'monthly', costCenter: 'diseno',
    });
    expect(contracts.get('carlos-backend-variable')).toMatchObject({
      vendorId: 'carlos-mendez', type: 'variable', currency: 'MXN', rateMinor: 100_000,
      unit: 'hora', maxUnitsPerPeriod: 70, costCenter: 'ingenieria',
    });
    expect(contracts.get('imprenta-materiales-once')).toMatchObject({
      vendorId: 'imprenta-caribe', currency: 'USD', amountMinor: 31_000, billingFrequency: 'one_time',
    });
    expect(contracts.get('lex-registro-annual')).toMatchObject({
      vendorId: 'lex-delaware', currency: 'USD', amountMinor: 120_000, billingFrequency: 'annual', costCenter: 'legal',
    });
    expect(contracts.get('datos-soporte-monthly')).toMatchObject({
      vendorId: 'datos-avila', currency: 'USD', amountMinor: 64_000, billingFrequency: 'monthly', costCenter: 'operaciones',
      start: '2026-10-01', end: '2026-10-14',
    });
    expect(contracts.get('datos-restablecimiento-once')).toMatchObject({
      vendorId: 'datos-avila', scope: 'Restablecimiento urgente de enlace', currency: 'USD',
      amountMinor: 64_000, billingFrequency: 'one_time', costCenter: 'operaciones',
      start: '2026-10-15', end: '2026-10-31',
    });
    expect(contracts.get('valentina-ajustes-once')).toMatchObject({
      vendorId: 'valentina-ruiz', billingFrequency: 'one_time', costCenter: 'diseno',
      start: '2026-10-21', end: '2026-10-31',
    });
    expect(labels.filter((label) => label.expected === 'ready')).toHaveLength(8);
    expect(labels.filter((label) => label.expected === 'approval_required')).toHaveLength(3);
    expect(labels.filter((label) => label.expected === 'review_required')).toHaveLength(2);
    expect(labels.filter((label) => label.expected === 'stopped')).toHaveLength(7);
    const labelsById = new Map(labels.map((label) => [label.invoiceId, label]));
    expect(labelsById.get('AL-037')).toMatchObject({ sourceKind: 'pdf', expected: 'ready', reasonCheck: 'R5' });
    expect(labelsById.get('AL-038')).toMatchObject({ expected: 'approval_required', reasonCheck: 'R6' });
    expect(labelsById.get('AL-040')).toMatchObject({ expected: 'ready', reasonCheck: 'jev:fuzzy_duplicate' });
    expect(labelsById.get('AL-034')).toMatchObject({ sourceKind: 'pdf', expected: 'stopped', reasonCheck: 'jev:document_type' });
    expect(labelsById.get('AL-041')).toMatchObject({ sourceKind: 'pdf', expected: 'ready' });
    expect(labelsById.get('AL-043')).toMatchObject({ sourceKind: 'pdf', expected: 'ready' });
    expect(labelsById.get('AL-049')).toMatchObject({ sourceKind: 'pdf', expected: 'stopped', reasonCheck: 'R8' });
    expect(labelsById.get('AL-044')).toMatchObject({ expected: 'review_required', reasonCheck: 'jev:artificial_urgency' });
    expect(labelsById.get('AL-048')).toMatchObject({ expected: 'stopped', reasonCheck: 'verify:two_accounts' });
  });

  it('distributes the 20 invoices across the approved five-country mix', () => {
    const data = seed();
    const contracts = new Map(data.contracts.map((contract) => [contract.id, contract]));
    const vendors = new Map(data.vendors.map((vendor) => [vendor.id, vendor]));
    const invoiceCountries = labels.map(({ invoiceId }) => {
      const contractId = invoiceContracts[invoiceId];
      if (contractId) {
        const contract = contracts.get(contractId);
        return contract ? vendors.get(contract.vendorId)?.country : undefined;
      }
      const source = readFileSync(resolve(process.cwd(), 'fixtures/invoices', `${invoiceId}.txt`), 'utf8');
      return /^País del proveedor: (CO|MX|VE|CL|US)$/mu.exec(source)?.[1];
    });
    const counts = Object.fromEntries(['MX', 'CO', 'VE', 'CL', 'US'].map((country) => [
      country, invoiceCountries.filter((invoiceCountry) => invoiceCountry === country).length,
    ]));

    expect(counts).toEqual({ MX: 6, CO: 6, VE: 3, CL: 3, US: 2 });
    expect(invoiceCountries).toHaveLength(20);
    expect(invoiceCountries.every(Boolean)).toBe(true);

    const chileVendors = data.vendors.filter(({ country }) => country === 'CL');
    expect(chileVendors).toHaveLength(1);
    expect(chileVendors[0]).toMatchObject({ payoutCurrency: 'USD' });
    const chileRut = chileVendors[0]?.taxId;
    expect(chileRut).toMatch(/^\d{1,2}\.\d{3}\.\d{3}-[\dK]$/u);
    const [rutBody, rutCheckDigit] = chileRut!.replaceAll('.', '').split('-');
    let checksum = 0;
    let multiplier = 2;
    for (const digit of [...rutBody!].reverse()) {
      checksum += Number(digit) * multiplier;
      multiplier = multiplier === 7 ? 2 : multiplier + 1;
    }
    const remainder = 11 - (checksum % 11);
    expect(rutCheckDigit).toBe(remainder === 11 ? '0' : remainder === 10 ? 'K' : String(remainder));
    expect(new Set(data.contracts.map(({ currency }) => currency))).toEqual(new Set(['USD', 'COP', 'MXN']));
  });

  it('seeds a committed October Datos payment for the monthly support contract', () => {
    expect(priorPayments).toContainEqual({
      id: 'DA-2026-10',
      vendorId: 'datos-avila',
      contractId: 'datos-soporte-monthly',
      period: '2026-10',
      costCenter: 'operaciones',
      amountUsdMinor: 64_000,
    });
    expect(labels.find((label) => label.invoiceId === 'AL-045')).toMatchObject({
      expected: 'stopped',
      reasonCheck: 'R7',
    });
  });

  it('sorts labels by invoice id and processes duplicates after their originals', () => {
    const invoiceIds = labels.map((label) => label.invoiceId);
    expect(invoiceIds).toEqual([...invoiceIds].sort());

    const duplicates = { 'AL-040': 'AL-037', 'AL-049': 'AL-043' };
    const duplicateLabels = labels.filter((label) => ['R8', 'jev:fuzzy_duplicate'].includes(label.reasonCheck));
    expect(duplicateLabels.map((label) => label.invoiceId).sort()).toEqual(Object.keys(duplicates).sort());
    for (const label of duplicateLabels) {
      const originalId = duplicates[label.invoiceId as keyof typeof duplicates];
      expect(Number(label.invoiceId.slice(3))).toBeGreaterThan(Number(originalId.slice(3)));
      expect(readFileSync(resolve(process.cwd(), 'fixtures/invoices', `${label.invoiceId}.txt`), 'utf8'))
        .toContain(originalId);
    }
  });

  it('does not label an invoice non-stopped when its contract already has an October commitment', () => {
    const data = seed();
    const contracts = new Map(data.contracts.map((contract) => [contract.id, contract]));

    for (const label of labels.filter((entry) => entry.expected !== 'stopped')) {
      const contractId = invoiceContracts[label.invoiceId];
      if (!contractId) continue;
      const contract = contracts.get(contractId);
      expect(contract, `${label.invoiceId} must map to a seeded contract`).toBeDefined();
      expect(
        priorPayments.some((payment) => payment.vendorId === contract!.vendorId
          && payment.contractId === contractId
          && payment.period === '2026-10'),
        `${label.invoiceId} cannot bill contract ${contractId} with an October commitment`,
      ).toBe(false);
    }
  });
});
