/**
 * Classifies Meta Graph API errors so the send worker can decide between
 * retry, back off, mark-for-reconnect or dead-letter.
 */
export type ErrorClass = "rate_limited" | "auth" | "permanent" | "transient";

export interface MetaErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

export class MetaApiError extends Error {
  readonly code: number | undefined;
  readonly subcode: number | undefined;
  readonly httpStatus: number;
  readonly errorClass: ErrorClass;

  constructor(httpStatus: number, body: MetaErrorBody | undefined) {
    super(body?.message ?? `Meta API error (HTTP ${httpStatus})`);
    this.name = "MetaApiError";
    this.httpStatus = httpStatus;
    this.code = body?.code;
    this.subcode = body?.error_subcode;
    this.errorClass = classifyMetaError(httpStatus, body);
  }
}

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002, 80006]);
// 10: permission / outside allowed window, 100: invalid param (deleted comment, bad id),
// 551: user unavailable, 200: permissions, 2534022 subcode: outside messaging window.
const PERMANENT_CODES = new Set([10, 100, 200, 551, 2018001, 2018278]);

export function classifyMetaError(httpStatus: number, body: MetaErrorBody | undefined): ErrorClass {
  const code = body?.code;
  if (code !== undefined && RATE_LIMIT_CODES.has(code)) return "rate_limited";
  if (code === 190 || code === 102 || httpStatus === 401) return "auth";
  if (code !== undefined && PERMANENT_CODES.has(code)) return "permanent";
  if (httpStatus >= 500 || httpStatus === 0 || code === 1 || code === 2) return "transient";
  if (httpStatus >= 400) return "permanent";
  return "transient";
}
