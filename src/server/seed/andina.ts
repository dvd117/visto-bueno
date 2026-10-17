import type { Budget, Contract, Rules, Treasury, Vendor } from '../../shared/domain/types';

/** Existing October operations spend, loaded separately by the ledger seed. */
export const seededPriorPayments = [
  {
    id: 'DA-2026-10', vendorId: 'datos-avila', contractId: 'datos-soporte-monthly',
    period: '2026-10', costCenter: 'operaciones', amountUsdMinor: 64_000,
  },
  {
    id: 'OPS-PRIOR-2026-10', vendorId: null, contractId: null,
    period: '2026-10', costCenter: 'operaciones', amountUsdMinor: 121_000,
  },
] as const;

export function seed(): {
  vendors: Vendor[];
  contracts: Contract[];
  budgets: Budget[];
  treasury: Treasury;
  rules: Rules;
} {
  return {
    vendors: [
      { id: 'nube-andina', name: 'Nube Andina Tecnología S. de R.L.', taxId: 'NAT010101AB1', country: 'MX', payoutCurrency: 'USD', payoutAccount: 'Banco Ventaluz ···· 8890', status: 'allowed', version: 1 },
      { id: 'valentina-ruiz', name: 'Estudio Bruma S.A.S.', taxId: '900.123.456-7', country: 'CO', payoutCurrency: 'COP', payoutAccount: 'Banco Ventaluz ···· 7712', status: 'allowed', version: 1 },
      { id: 'carlos-mendez', name: 'Codaluz Digital S. de R.L.', taxId: 'COD010101AA2', country: 'MX', payoutCurrency: 'MXN', payoutAccount: 'Banco Brumavela ···· 2038', status: 'allowed', version: 1 },
      { id: 'imprenta-caribe', name: 'Imprenta Caribe C.A.', taxId: 'J-40123456-1', country: 'VE', payoutCurrency: 'USD', payoutAccount: 'Banco Cielarroyo ···· 6130', status: 'allowed', version: 1 },
      { id: 'lex-delaware', name: 'Lex Delaware LLP', taxId: 'US-DE-004218', country: 'US', payoutCurrency: 'USD', payoutAccount: 'Banco Valleclaro ···· 4510', status: 'allowed', version: 1 },
      { id: 'datos-avila', name: 'Ladera Austral SpA', taxId: '76.384.219-3', country: 'CL', payoutCurrency: 'USD', payoutAccount: 'Banco Alborvia ···· 5206', status: 'allowed', version: 1 },
      { id: 'pixel-patio', name: 'Pixel Patio S.A.S.', taxId: '900.000.101-3', country: 'CO', payoutCurrency: 'USD', payoutAccount: 'Banco Altocauce ···· 1184', status: 'allowed', version: 1 },
      { id: 'norte-claro', name: 'Norte Claro Soluciones S.A.S.', taxId: '900.000.202-5', country: 'CO', payoutCurrency: 'USD', payoutAccount: 'Banco Altocauce ···· 2295', status: 'allowed', version: 1 },
      { id: 'estacion-solar', name: 'La Estación Solar C.A.', taxId: 'J-40000103-7', country: 'VE', payoutCurrency: 'USD', payoutAccount: 'Banco Alborvia ···· 3306', status: 'allowed', version: 1 },
      { id: 'taller-lumbre', name: 'Taller Lumbre S. de R.L.', taxId: 'MEX-201107-8P4', country: 'MX', payoutCurrency: 'USD', payoutAccount: 'Banco Brumavela ···· 6161', status: 'allowed', version: 1 },
    ],
    contracts: [
      { id: 'nube-hosting-monthly', vendorId: 'nube-andina', scope: 'Hosting administrado y respaldo de infraestructura', type: 'fixed', currency: 'USD', amountMinor: 85_000, billingFrequency: 'monthly', costCenter: 'operaciones', start: '2026-01-01', end: '2026-12-31', version: 1 },
      { id: 'valentina-diseno-monthly', vendorId: 'valentina-ruiz', scope: 'Diseño UX y sistema visual', type: 'fixed', currency: 'COP', amountMinor: 480_000_000, billingFrequency: 'monthly', costCenter: 'diseno', start: '2026-01-01', end: '2026-10-20', version: 1 },
      { id: 'valentina-ajustes-once', vendorId: 'valentina-ruiz', scope: 'Ajustes de diseño para entregables de octubre', type: 'fixed', currency: 'COP', amountMinor: 475_000_000, billingFrequency: 'one_time', costCenter: 'diseno', start: '2026-10-21', end: '2026-10-31', version: 1 },
      { id: 'valentina-diseno-november-monthly', vendorId: 'valentina-ruiz', scope: 'Diseño UX y sistema visual', type: 'fixed', currency: 'COP', amountMinor: 480_000_000, billingFrequency: 'monthly', costCenter: 'diseno', start: '2026-11-01', end: '2026-11-30', version: 1 },
      { id: 'carlos-backend-variable', vendorId: 'carlos-mendez', scope: 'Desarrollo backend por horas', type: 'variable', currency: 'MXN', rateMinor: 100_000, unit: 'hora', maxUnitsPerPeriod: 70, billingFrequency: 'monthly', costCenter: 'ingenieria', start: '2026-01-01', end: '2026-12-31', version: 1 },
      { id: 'imprenta-materiales-once', vendorId: 'imprenta-caribe', scope: 'Impresión de materiales para el equipo', type: 'fixed', currency: 'USD', amountMinor: 31_000, billingFrequency: 'one_time', costCenter: 'operaciones', start: '2026-10-01', end: '2026-10-15', version: 1 },
      { id: 'imprenta-reimpresion-once', vendorId: 'imprenta-caribe', scope: 'Reimpresión puntual de afiches', type: 'fixed', currency: 'USD', amountMinor: 50_000, billingFrequency: 'one_time', costCenter: 'operaciones', start: '2026-10-16', end: '2026-10-31', version: 1 },
      { id: 'lex-registro-annual', vendorId: 'lex-delaware', scope: 'Presentación anual de registros corporativos', type: 'fixed', currency: 'USD', amountMinor: 120_000, billingFrequency: 'annual', costCenter: 'legal', start: '2026-01-01', end: '2026-10-15', version: 1 },
      { id: 'lex-presentacion-once', vendorId: 'lex-delaware', scope: 'Presentación extraordinaria de documentos corporativos', type: 'fixed', currency: 'USD', amountMinor: 120_000, billingFrequency: 'one_time', costCenter: 'legal', start: '2026-10-16', end: '2026-10-31', version: 1 },
      { id: 'datos-soporte-monthly', vendorId: 'datos-avila', scope: 'Soporte de datos y conectividad', type: 'fixed', currency: 'USD', amountMinor: 64_000, billingFrequency: 'monthly', costCenter: 'operaciones', start: '2026-10-01', end: '2026-10-14', version: 1 },
      { id: 'datos-restablecimiento-once', vendorId: 'datos-avila', scope: 'Restablecimiento urgente de enlace', type: 'fixed', currency: 'USD', amountMinor: 64_000, billingFrequency: 'one_time', costCenter: 'operaciones', start: '2026-10-15', end: '2026-10-31', version: 1 },
      { id: 'pixel-diseno-monthly', vendorId: 'pixel-patio', scope: 'Diseño y mantenimiento de interfaz', type: 'fixed', currency: 'USD', amountMinor: 78_000, billingFrequency: 'monthly', costCenter: 'ingenieria', start: '2026-10-01', end: '2026-10-15', version: 1 },
      { id: 'norte-consultoria-monthly', vendorId: 'norte-claro', scope: 'Consultoría de seguridad de aplicaciones', type: 'fixed', currency: 'USD', amountMinor: 95_000, billingFrequency: 'monthly', costCenter: 'legal', start: '2026-10-01', end: '2026-10-31', version: 1 },
      { id: 'estacion-mantenimiento-once', vendorId: 'estacion-solar', scope: 'Mantenimiento de equipos de energía', type: 'fixed', currency: 'USD', amountMinor: 43_000, billingFrequency: 'one_time', costCenter: 'operaciones', start: '2026-10-01', end: '2026-10-31', version: 1 },
      { id: 'taller-calibracion-monthly', vendorId: 'taller-lumbre', scope: 'Calibración y mantenimiento de equipos', type: 'fixed', currency: 'USD', amountMinor: 135_000, billingFrequency: 'monthly', costCenter: 'legal', start: '2026-10-01', end: '2026-10-15', version: 1 },
      { id: 'taller-revision-once', vendorId: 'taller-lumbre', scope: 'Revisión puntual de plataforma y equipos', type: 'fixed', currency: 'USD', amountMinor: 45_000, billingFrequency: 'one_time', costCenter: 'legal', start: '2026-10-16', end: '2026-10-31', version: 1 },
      { id: 'pixel-auditoria-once', vendorId: 'pixel-patio', scope: 'Auditoría de accesibilidad del prototipo', type: 'fixed', currency: 'USD', amountMinor: 400_000, billingFrequency: 'one_time', costCenter: 'ingenieria', start: '2026-10-16', end: '2026-10-20', version: 1 },
      { id: 'pixel-prototipo-once', vendorId: 'pixel-patio', scope: 'Prototipo de panel para monitoreo', type: 'fixed', currency: 'USD', amountMinor: 250_000, billingFrequency: 'one_time', costCenter: 'ingenieria', start: '2026-10-21', end: '2026-10-31', version: 1 },
    ],
    budgets: [
      { costCenter: 'ingenieria', month: '2026-10', approvedUsdMinor: 2_000_000 },
      { costCenter: 'diseno', month: '2026-10', approvedUsdMinor: 600_000 },
      { costCenter: 'diseno', month: '2026-11', approvedUsdMinor: 600_000 },
      { costCenter: 'operaciones', month: '2026-10', approvedUsdMinor: 600_000 },
      { costCenter: 'legal', month: '2026-10', approvedUsdMinor: 500_000 },
    ],
    treasury: {
      balanceUsdMinor: 4_800_000,
      fx: [
        { currency: 'COP', perUsd: '4171.30', date: '2026-10-15' },
        { currency: 'MXN', perUsd: '18.8656', date: '2026-10-15' },
        { currency: 'USD', perUsd: '1', date: '2026-10-15' },
      ],
    },
    rules: {
      version: 1,
      perPaymentLimitUsdMinor: 1_500_000,
      monthlyLimitUsdMinor: 6_000_000,
      approvalThresholdUsdMinor: 300_000,
      fuzzyDuplicateWindowDays: 60,
      preset: 'equilibrado',
    },
  };
}
