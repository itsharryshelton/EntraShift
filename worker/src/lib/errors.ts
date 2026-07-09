/**
 * Standard error envelope (api-spec.md):
 *   { "error": { "code": "string_code", "message": "human readable", "detail": "optional" } }
 *
 * Every failure path in the Worker throws an ApiError; the global Hono error handler
 * (src/index.ts) serialises it to this envelope with the mapped HTTP status.
 */

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'csrf'
  | 'rate_limited'
  | 'budget_exhausted'
  | 'not_found'
  | 'validation'
  | 'graph_error'
  | 'token_error'
  | 'conflict'
  | 'internal';

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; detail?: string };
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  csrf: 403,
  rate_limited: 429,
  budget_exhausted: 429,
  not_found: 404,
  validation: 400,
  graph_error: 502,
  token_error: 502,
  conflict: 409,
  internal: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail?: string;

  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.detail = detail;
  }

  toEnvelope(): ErrorEnvelope {
    return { error: { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) } };
  }
}

/** Concise constructors so route code reads cleanly. */
export const err = {
  unauthorized: (m = 'Authentication required', d?: string) => new ApiError('unauthorized', m, d),
  forbidden: (m = 'Forbidden', d?: string) => new ApiError('forbidden', m, d),
  csrf: (m = 'Invalid or missing CSRF token', d?: string) => new ApiError('csrf', m, d),
  rateLimited: (m = 'Too many requests', d?: string) => new ApiError('rate_limited', m, d),
  budgetExhausted: (m = 'Daily free-tier budget exhausted', d?: string) => new ApiError('budget_exhausted', m, d),
  notFound: (m = 'Not found', d?: string) => new ApiError('not_found', m, d),
  validation: (m = 'Validation failed', d?: string) => new ApiError('validation', m, d),
  graph: (m = 'Microsoft Graph request failed', d?: string) => new ApiError('graph_error', m, d),
  token: (m = 'Token acquisition failed', d?: string) => new ApiError('token_error', m, d),
  conflict: (m = 'Conflict', d?: string) => new ApiError('conflict', m, d),
};
