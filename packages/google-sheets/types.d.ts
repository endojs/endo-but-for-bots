export type GoogleSheetsErrorCode =
  | 'quota-exceeded'
  | 'permission-denied'
  | 'not-found'
  | 'unauthenticated'
  | 'invalid-argument'
  | 'google-sheets-error';

export class GoogleSheetsError extends Error {
  code: GoogleSheetsErrorCode;
  status: number;
  retryAfterSeconds?: number;
  details?: unknown;
}

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchLikeResponse>;

export interface SheetsClient {
  values: {
    get(range: string, options?: Record<string, unknown>): Promise<any>;
    batchGet(ranges: string[], options?: Record<string, unknown>): Promise<any>;
    update(
      range: string,
      values: unknown[][],
      options?: Record<string, unknown>,
    ): Promise<any>;
    batchUpdate(
      updates: { range: string; values: unknown[][] }[],
      options?: Record<string, unknown>,
    ): Promise<any>;
    append(
      range: string,
      values: unknown[][],
      options?: Record<string, unknown>,
    ): Promise<any>;
    clear(range: string, options?: Record<string, unknown>): Promise<any>;
  };
  spreadsheets: { get(options?: Record<string, unknown>): Promise<any> };
  getValues: SheetsClient['values']['get'];
  batchGetValues: SheetsClient['values']['batchGet'];
  updateValues: SheetsClient['values']['update'];
  batchUpdateValues: SheetsClient['values']['batchUpdate'];
  appendValues: SheetsClient['values']['append'];
  clearValues: SheetsClient['values']['clear'];
  getSpreadsheet: SheetsClient['spreadsheets']['get'];
}

export function encodeA1Range(range: string): string;
export function serialToISO8601(serial: number): string;
export function iso8601ToSerial(iso8601: string): number;
export function makeSheetsClient(
  fetch: FetchLike,
  options: { spreadsheetId: string; baseUrl?: string },
): SheetsClient;
