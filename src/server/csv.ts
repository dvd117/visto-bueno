import Decimal from 'decimal.js';
import { z } from 'zod';
import type { Budget, Contract, CostCenter, Currency, FxRate, Vendor } from '../shared/domain/types';

export const CSV_TABLES = ['vendors', 'contracts', 'budgets', 'fx'] as const;
export type CsvTable = (typeof CSV_TABLES)[number];

interface ParsedRowMap {
  vendors: Vendor;
  contracts: Contract;
  budgets: Budget;
  fx: FxRate;
}

export interface CsvRowError {
  row: number;
  field: string;
  message: string;
}

export type CsvParseResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; summary: string; errors: CsvRowError[] };

const countries = ['CO', 'MX', 'VE', 'US'] as const;
const currencies = ['USD', 'COP', 'MXN'] as const;
const costCenters = ['ingenieria', 'diseno', 'operaciones', 'legal'] as const;
const decimalPattern = /^\d+(?:\.\d+)?$/;

function text(label: string) {
  return z.string().trim().min(1, `${label} es obligatorio.`);
}

function optionalText() {
  return z.preprocess(
    (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.string().trim().min(1, 'El texto no puede estar vacío.').optional(),
  );
}

function enumValue<const T extends readonly [string, ...string[]]>(values: T, label: string) {
  return z.enum(values, { error: `${label} debe ser uno de estos valores: ${values.join(', ')}.` });
}

function toMinorUnits(value: string) {
  return new Decimal(value).mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toNumber();
}

const money = z.string()
  .trim()
  .regex(decimalPattern, 'Usa un monto decimal, por ejemplo 850.00.')
  .transform(toMinorUnits)
  .refine(Number.isSafeInteger, 'El monto excede el rango permitido.');

const optionalMoney = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  money.optional(),
);

const integer = z.string()
  .trim()
  .regex(/^\d+$/, 'Usa un número entero positivo.')
  .transform(Number)
  .refine(Number.isSafeInteger, 'El número excede el rango permitido.');

const optionalPositiveInteger = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  integer.refine((value) => value > 0, 'El número debe ser mayor que cero.').optional(),
);

function isDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const date = z.string().trim().refine(isDate, 'Usa una fecha válida con formato AAAA-MM-DD.');
const isoMonth = z.string().trim().refine((value) => {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  return Boolean(match && Number(match[2]) >= 1 && Number(match[2]) <= 12);
}, 'Usa un mes válido con formato AAAA-MM.');

const vendorSchema = z.object({
  id: text('El ID'),
  name: text('El nombre'),
  taxId: text('El identificador fiscal'),
  country: enumValue(countries, 'El país'),
  payoutCurrency: enumValue(currencies, 'La moneda de pago'),
  payoutAccount: text('La cuenta de pago'),
  status: enumValue(['allowed', 'blocked'], 'El estado'),
  version: integer.refine((value) => value > 0, 'La versión debe ser mayor que cero.'),
}).transform((row): Vendor => row);

const contractSchema = z.object({
  id: text('El ID'),
  vendorId: text('El ID del proveedor'),
  scope: text('El alcance'),
  type: enumValue(['fixed', 'variable'], 'El tipo'),
  currency: enumValue(currencies, 'La moneda'),
  amount: optionalMoney,
  rate: optionalMoney,
  unit: optionalText(),
  maxUnitsPerPeriod: optionalPositiveInteger,
  billingFrequency: enumValue(['monthly', 'one_time', 'annual'], 'La frecuencia'),
  costCenter: enumValue(costCenters, 'El centro de costo'),
  start: date,
  end: date,
  version: integer.refine((value) => value > 0, 'La versión debe ser mayor que cero.'),
}).superRefine((row, context) => {
  if (row.type === 'fixed') {
    if (row.amount === undefined) {
      context.addIssue({ code: 'custom', path: ['amount'], message: 'El monto es obligatorio para un contrato fijo.' });
    } else if (row.amount <= 0) {
      context.addIssue({ code: 'custom', path: ['amount'], message: 'El monto debe ser mayor que cero.' });
    }
    if (row.rate !== undefined || row.unit !== undefined || row.maxUnitsPerPeriod !== undefined) {
      context.addIssue({ code: 'custom', path: ['type'], message: 'Un contrato fijo no puede incluir tarifa ni unidades.' });
    }
  } else {
    if (row.rate === undefined) {
      context.addIssue({ code: 'custom', path: ['rate'], message: 'La tarifa es obligatoria para un contrato variable.' });
    } else if (row.rate <= 0) {
      context.addIssue({ code: 'custom', path: ['rate'], message: 'La tarifa debe ser mayor que cero.' });
    }
    if (!row.unit) {
      context.addIssue({ code: 'custom', path: ['unit'], message: 'La unidad es obligatoria para un contrato variable.' });
    }
    if (row.maxUnitsPerPeriod === undefined) {
      context.addIssue({ code: 'custom', path: ['maxUnitsPerPeriod'], message: 'El máximo de unidades es obligatorio para un contrato variable.' });
    }
    if (row.amount !== undefined) {
      context.addIssue({ code: 'custom', path: ['amount'], message: 'Un contrato variable no puede incluir un monto fijo.' });
    }
  }
}).transform((row): Contract => {
  const { amount, rate, ...contract } = row;
  return {
    ...contract,
    ...(amount === undefined ? {} : { amountMinor: amount }),
    ...(rate === undefined ? {} : { rateMinor: rate }),
  };
});

const budgetSchema = z.object({
  costCenter: enumValue(costCenters, 'El centro de costo'),
  month: isoMonth,
  approvedUsd: money,
}).transform((row): Budget => ({
  costCenter: row.costCenter as CostCenter,
  month: row.month,
  approvedUsdMinor: row.approvedUsd,
}));

const fxRateSchema = z.object({
  currency: enumValue(currencies, 'La moneda'),
  perUsd: z.string()
    .trim()
    .regex(decimalPattern, 'Usa una tasa decimal, por ejemplo 4171.30.')
    .refine((value) => new Decimal(value).greaterThan(0), 'La tasa debe ser mayor que cero.'),
  date,
}).transform((row): FxRate => ({
  currency: row.currency as Currency,
  perUsd: row.perUsd,
  date: row.date,
}));

const config = {
  vendors: {
    headers: ['id', 'name', 'taxId', 'country', 'payoutCurrency', 'payoutAccount', 'status', 'version'],
    schema: vendorSchema,
    example: ['nube-andina-ejemplo', 'Nube Andina, S.A.S.', 'NIT-FICTICIO-001', 'CO', 'USD', 'Banco Demo ···· 4412', 'allowed', '1'],
  },
  contracts: {
    headers: ['id', 'vendorId', 'scope', 'type', 'currency', 'amount', 'rate', 'unit', 'maxUnitsPerPeriod', 'billingFrequency', 'costCenter', 'start', 'end', 'version'],
    schema: contractSchema,
    example: ['contrato-ejemplo', 'nube-andina-ejemplo', 'Servicios de ejemplo para Andina Labs', 'fixed', 'USD', '850.00', '', '', '', 'monthly', 'operaciones', '2026-10-01', '2026-12-31', '1'],
  },
  budgets: {
    headers: ['costCenter', 'month', 'approvedUsd'],
    schema: budgetSchema,
    example: ['operaciones', '2026-10', '850.00'],
  },
  fx: {
    headers: ['currency', 'perUsd', 'date'],
    schema: fxRateSchema,
    example: ['USD', '1', '2026-10-15'],
  },
} satisfies Record<CsvTable, { headers: string[]; schema: z.ZodType; example: string[] }>;

class CsvSyntaxError extends Error {
  constructor(readonly row: number, message: string) {
    super(message);
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false;
  let fieldWasQuoted = false;

  const finishField = () => {
    row.push(field);
    field = '';
    afterQuote = false;
    fieldWasQuoted = false;
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (afterQuote) {
      if (character === ',') {
        finishField();
      } else if (character === '\n') {
        finishRow();
      } else if (character === '\r' && text[index + 1] === '\n') {
        finishRow();
        index += 1;
      } else {
        throw new CsvSyntaxError(rows.length + 1, 'Después de cerrar comillas debe venir una coma o un salto de línea.');
      }
      continue;
    }

    if (character === ',') {
      finishField();
    } else if (character === '\n') {
      finishRow();
    } else if (character === '\r') {
      if (text[index + 1] !== '\n') {
        throw new CsvSyntaxError(rows.length + 1, 'Usa CRLF para separar las filas.');
      }
      finishRow();
      index += 1;
    } else if (character === '"') {
      if (field.length > 0 || fieldWasQuoted) {
        throw new CsvSyntaxError(rows.length + 1, 'Las comillas dentro de un campo deben duplicarse.');
      }
      inQuotes = true;
      fieldWasQuoted = true;
    } else {
      field += character;
    }
  }

  if (inQuotes) throw new CsvSyntaxError(rows.length + 1, 'Hay un campo entre comillas sin cerrar.');
  if (field.length > 0 || row.length > 0 || fieldWasQuoted || afterQuote) {
    finishField();
    rows.push(row);
  }
  return rows;
}

function summaryFor(errors: CsvRowError[]) {
  const grouped = new Map<number, string[]>();
  for (const error of errors) {
    const messages = grouped.get(error.row) ?? [];
    messages.push(`${error.field}: ${error.message}`);
    grouped.set(error.row, messages);
  }
  const details = [...grouped].map(([row, messages]) => `Fila ${row}: ${messages.join('; ')}`).join(' ');
  return `No se pudo validar el CSV. ${details}`;
}

export function parseTable<T extends CsvTable>(table: T, csvText: string): CsvParseResult<ParsedRowMap[T]> {
  let records: string[][];
  try {
    records = parseCsv(csvText);
  } catch (error) {
    if (!(error instanceof CsvSyntaxError)) throw error;
    const errors = [{ row: error.row, field: 'CSV', message: error.message }];
    return { ok: false, summary: summaryFor(errors), errors };
  }

  const [rawHeaders, ...dataRows] = records;
  if (!rawHeaders) {
    const errors = [{ row: 1, field: 'CSV', message: 'Incluye una fila de encabezados.' }];
    return { ok: false, summary: summaryFor(errors), errors };
  }

  const headers = rawHeaders.map((header, index) => (index === 0 ? header.replace(/^\uFEFF/, '') : header).trim());
  const expectedHeaders = config[table].headers;
  const errors: CsvRowError[] = [];
  const headerSet = new Set(headers);

  if (headerSet.size !== headers.length) {
    errors.push({ row: 1, field: 'encabezados', message: 'No puede haber nombres de columna duplicados.' });
  }
  for (const header of expectedHeaders) {
    if (!headerSet.has(header)) errors.push({ row: 1, field: header, message: `Falta la columna "${header}".` });
  }
  for (const header of headerSet) {
    if (!expectedHeaders.includes(header)) errors.push({ row: 1, field: header || 'encabezados', message: `La columna "${header}" no está permitida.` });
  }
  if (errors.length > 0) return { ok: false, summary: summaryFor(errors), errors };

  if (dataRows.length === 0) {
    const noRows = [{ row: 2, field: 'CSV', message: 'Incluye al menos una fila de datos.' }];
    return { ok: false, summary: summaryFor(noRows), errors: noRows };
  }

  const rows: ParsedRowMap[CsvTable][] = [];
  for (const [index, values] of dataRows.entries()) {
    const rowNumber = index + 2;
    if (values.length !== headers.length) {
      errors.push({ row: rowNumber, field: 'CSV', message: `La fila tiene ${values.length} columnas; se esperaban ${headers.length}.` });
      continue;
    }
    const record = Object.fromEntries(headers.map((header, column) => [header, values[column] ?? '']));
    const parsed = config[table].schema.safeParse(record);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({
          row: rowNumber,
          field: String(issue.path[0] ?? 'fila'),
          message: issue.message,
        });
      }
    } else {
      rows.push(parsed.data as ParsedRowMap[CsvTable]);
    }
  }

  if (errors.length > 0) return { ok: false, summary: summaryFor(errors), errors };
  return { ok: true, rows: rows as ParsedRowMap[T][] };
}

function escapeCell(value: string) {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function templateCsv(table: CsvTable): string {
  const { headers, example } = config[table];
  return `${headers.join(',')}\r\n${example.map(escapeCell).join(',')}\r\n`;
}
