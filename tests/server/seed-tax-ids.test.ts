import { describe, expect, it } from 'vitest';
import { getWorkspaceData, openDb } from '../../src/server/db/db';
import { ensureClientWorkspaces, listOwnedWorkspaceClients } from '../../src/server/db/workspace';
import { parseTable, templateCsv } from '../../src/server/csv';
import { seed } from '../../src/server/seed/andina';
import { taxIdChecksumValid } from '../../src/shared/domain/tax-ids';
import { invoiceTemplates } from '../../src/shared/templates';
import type { VendorCountry } from '../../src/shared/domain/types';

const rfcCharacterValues = new Map<string, number>([
  ...[...'0123456789'].map((character, value) => [character, value] as const),
  ...[...'ABCDEFGHIJKLMN'].map((character, index) => [character, index + 10] as const),
  ['&', 24] as const,
  ...[...'OPQRSTUVWXYZ'].map((character, index) => [character, index + 25] as const),
  [' ', 37] as const,
  ['Ñ', 38] as const,
]);

function expectedMexicanRfcCheckDigit(rfc: string): string | null {
  if (!/^[A-ZÑ&]{3}\d{6}[A-Z\d]{2}[\dA]$/u.test(rfc)) return null;

  const body = rfc.slice(0, -1).padStart(12, ' ');
  const sum = [...body].reduce((total, character, index) => (
    total + rfcCharacterValues.get(character)! * (13 - index)
  ), 0);
  const digit = 11 - (sum % 11);

  return digit === 11 ? '0' : digit === 10 ? 'A' : String(digit);
}

describe('Mexican RFC seed tax IDs', () => {
  it('has a valid SAT check digit for every RFC-formatted Mexican vendor tax ID', () => {
    const mexicanRfcVendors = seed().vendors.filter((vendor) => (
      vendor.country === 'MX' && expectedMexicanRfcCheckDigit(vendor.taxId) !== null
    ));

    expect(mexicanRfcVendors.length).toBeGreaterThan(0);
    for (const vendor of mexicanRfcVendors) {
      expect(vendor.taxId.at(-1), vendor.name).toBe(expectedMexicanRfcCheckDigit(vendor.taxId));
    }
  });
});

describe('demo vendor tax IDs', () => {
  it('checks vendors across Andina and Marea and keeps only documented legacy checksum failures', () => {
    const db = openDb(':memory:');
    try {
      const ownerId = 'demo-tax-id-owner';
      ensureClientWorkspaces(db, ownerId, ownerId);
      const clients = listOwnedWorkspaceClients(db, ownerId);
      expect(clients.map(({ defaultName }) => defaultName)).toEqual(['Andina Labs Inc.', 'Marea Norte SpA']);

      const seededVendors = clients.flatMap(({ defaultName, id }) => getWorkspaceData(db, id).vendors.map((vendor) => ({
        clientName: defaultName,
        ...vendor,
      })));
      const invalidSeededVendors = seededVendors
        .filter(({ country, taxId }) => taxIdChecksumValid(country, taxId) === false)
        .map(({ clientName, id, taxId }) => ({ clientName, id, taxId }))
        .sort((left, right) => left.id.localeCompare(right.id));

      // These are pre-existing, fictional Andina RIFs; keep them as untouched legacy data.
      expect(invalidSeededVendors).toEqual([
        { clientName: 'Andina Labs Inc.', id: 'estacion-solar', taxId: 'J-40000103-7' },
        { clientName: 'Andina Labs Inc.', id: 'imprenta-caribe', taxId: 'J-40123456-1' },
      ]);

      const vendorCsv = parseTable('vendors', templateCsv('vendors'));
      if (!vendorCsv.ok) throw new Error(`Invalid vendor CSV sample: ${vendorCsv.summary}`);
      const sampleVendors = [
        ...vendorCsv.rows,
        ...invoiceTemplates.map((template) => {
          const country = /· (CO|MX|VE|CL|PE|AR|US) ·/u.exec(template.label)?.[1] as VendorCountry | undefined;
          const taxId = /^(?:RFC|RUT|NIT|RIF|RUC|CUIT):\s*(.+)$/mu.exec(template.content)?.[1];
          if (!country || !taxId) throw new Error(`Missing country or tax ID in Recibir template ${template.id}.`);
          return { country, taxId };
        }),
      ];
      expect(sampleVendors).toHaveLength(1 + invoiceTemplates.length);
      for (const vendor of sampleVendors) {
        expect(taxIdChecksumValid(vendor.country, vendor.taxId), vendor.taxId).not.toBe(false);
      }
    } finally {
      db.close();
    }
  });
});
