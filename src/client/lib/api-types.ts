import type {
  ApiError, CompanyPreview, CompanyRecord, LogEntry, SimulationResult,
} from '../../shared/api';
import type { Budget, Contract, Rules, Treasury, Vendor } from '../../shared/domain/types';

export type { ApiEvaluationResult as EvaluationResult } from '../../shared/api';

export type DataTable = 'vendors' | 'contracts' | 'budgets' | 'treasury';
export type CsvTable = 'vendors' | 'contracts' | 'budgets' | 'fx';

export interface DataTableValues {
  vendors: Vendor[];
  contracts: Contract[];
  budgets: Budget[];
  treasury: Treasury;
}

export interface DataRowMap {
  vendors: Vendor;
  contracts: Contract;
  budgets: Budget;
  treasury: Treasury;
}

export type DataUploadResult = { ok: true } | { ok: false; error: ApiError };

export interface DatosApi {
  getTable<T extends DataTable>(table: T): Promise<DataTableValues[T]>;
  putRow<T extends DataTable>(table: T, row: DataRowMap[T]): Promise<DataRowMap[T]>;
  uploadCsv(table: CsvTable, file: File): Promise<DataUploadResult>;
  templateUrl(table: CsvTable): string;
  getCompany(): Promise<CompanyRecord>;
  saveCompany(company: CompanyRecord): Promise<CompanyRecord>;
  previewCompany(company: CompanyRecord): Promise<CompanyPreview>;
}

export interface BitacoraApi {
  getLog(): Promise<LogEntry[]>;
  exportPaymentsCsv(): Promise<string>;
  exportLogCsv(): Promise<string>;
  exportReportMd(): Promise<string>;
}

export interface ReglasApi {
  getRules(): Promise<Rules>;
  saveRules(rules: Rules): Promise<Rules>;
  simulate(rules: Rules): Promise<SimulationResult>;
  getVendors(): Promise<Vendor[]>;
  saveVendor(vendor: Vendor): Promise<Vendor>;
}
