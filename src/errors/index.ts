export type ZapindErrorCode =
  | 'ZAPIND_ERROR'
  | 'AUTHENTICATION_ERROR'
  | 'SESSION_ERROR'
  | 'NETWORK_ERROR'
  | 'RATE_LIMIT_ERROR'
  | 'VALIDATION_ERROR'
  | 'PERMISSION_ERROR'
  | 'NOT_FOUND_ERROR'
  | 'API_ERROR';

export interface ZapindErrorOptions {
  readonly code?: ZapindErrorCode;
  readonly retryable?: boolean;
  readonly rawCode?: number | null;
  readonly cause?: unknown;
}

/**
 * Base error class for all errors thrown by Zapind.
 */
export class ZapindError extends Error {
  public readonly code: ZapindErrorCode;
  public readonly retryable: boolean;
  public readonly rawCode: number | null;
  public override readonly cause?: unknown;

  constructor(message: string, options: ZapindErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? 'ZAPIND_ERROR';
    this.retryable = options.retryable ?? false;
    this.rawCode = options.rawCode ?? null;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AuthenticationError extends ZapindError {
  constructor(message = 'Not authenticated with Zalo', cause?: unknown, rawCode: number | null = null) {
    super(message, { code: 'AUTHENTICATION_ERROR', retryable: false, cause, rawCode });
  }
}

export class SessionError extends ZapindError {
  constructor(message = 'Session is invalid, expired, or could not be accessed', cause?: unknown, rawCode: number | null = null) {
    super(message, { code: 'SESSION_ERROR', retryable: false, cause, rawCode });
  }
}

export class NetworkError extends ZapindError {
  constructor(message = 'Network error communicating with Zalo', cause?: unknown) {
    super(message, { code: 'NETWORK_ERROR', retryable: true, cause });
  }
}

export class RateLimitError extends ZapindError {
  public readonly retryAfterMs: number | null;

  constructor(message = 'Rate limit exceeded', retryAfterMs: number | null = null, cause?: unknown) {
    super(message, { code: 'RATE_LIMIT_ERROR', retryable: true, cause });
    this.retryAfterMs = retryAfterMs;
  }
}

export class ValidationError extends ZapindError {
  constructor(message: string, cause?: unknown) {
    super(message, { code: 'VALIDATION_ERROR', retryable: false, cause });
  }
}

export class PermissionError extends ZapindError {
  constructor(message = 'Insufficient permissions for this operation', cause?: unknown, rawCode: number | null = null) {
    super(message, { code: 'PERMISSION_ERROR', retryable: false, cause, rawCode });
  }
}

export class NotFoundError extends ZapindError {
  constructor(message = 'Requested resource was not found', cause?: unknown, rawCode: number | null = null) {
    super(message, { code: 'NOT_FOUND_ERROR', retryable: false, cause, rawCode });
  }
}

export class APIError extends ZapindError {
  constructor(message: string, rawCode: number | null = null, cause?: unknown, retryable = false) {
    super(message, { code: 'API_ERROR', retryable, rawCode, cause });
  }
}

interface ErrorLike {
  name?: string;
  message?: string;
  code?: string | number | null;
  status?: number;
  statusCode?: number;
  response?: { status?: number };
  retryAfterMs?: number;
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * Normalizes any error thrown by the underlying transport into a typed ZapindError.
 */
export function normalizeError(err: unknown, fallbackMessage = 'Unexpected Zalo API error'): ZapindError {
  if (err instanceof ZapindError) return err;

  const e = (typeof err === 'object' && err !== null ? err : {}) as ErrorLike;
  const name = typeof e.name === 'string' ? e.name : '';
  const message =
    typeof e.message === 'string' && e.message.trim().length > 0
      ? e.message
      : typeof err === 'string' && err.trim().length > 0
        ? err
        : fallbackMessage;
  const rawNumericCode = typeof e.code === 'number' ? e.code : null;
  const rawStringCode = typeof e.code === 'string' ? e.code : '';
  const lower = message.toLowerCase();

  // Extract HTTP status from explicit properties or message ("Request failed with status code 429")
  let httpStatus: number | null =
    typeof e.status === 'number'
      ? e.status
      : typeof e.statusCode === 'number'
        ? e.statusCode
        : typeof e.response?.status === 'number'
          ? e.response.status
          : null;
  if (httpStatus === null) {
    const statusMatch = message.match(/status code\s+(\d{3})/i);
    if (statusMatch) {
      httpStatus = Number(statusMatch[1]);
    }
  }

  if (name === 'ZaloApiLoginQRDeclined' || name === 'ZaloApiLoginQRAborted') {
    return new AuthenticationError(message, err, rawNumericCode);
  }
  if (name === 'ZaloApiMissingImageMetadataGetter') {
    return new ValidationError(
      'Uploading local image files requires an imageMetadataGetter in Zapind options (or pass Buffer with width/height).',
      err,
    );
  }
  if (httpStatus === 429 || lower.includes('rate limit') || lower.includes('too many requests')) {
    return new RateLimitError(message, typeof e.retryAfterMs === 'number' ? e.retryAfterMs : null, err);
  }
  if (
    httpStatus === 401 ||
    lower.includes('session expired') ||
    lower.includes('invalid cookie') ||
    lower.includes('not logged in') ||
    lower.includes('unauthorized')
  ) {
    return new SessionError(message, err, rawNumericCode);
  }
  if (httpStatus === 403 || lower.includes('permission') || lower.includes('forbidden')) {
    return new PermissionError(message, err, rawNumericCode);
  }
  if (httpStatus === 404 || lower.includes('not found')) {
    return new NotFoundError(message, err, rawNumericCode);
  }
  if (
    NETWORK_CODES.has(rawStringCode) ||
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('socket hang up') ||
    lower.includes('timed out')
  ) {
    return new NetworkError(message, err);
  }

  const retryable = httpStatus !== null && httpStatus >= 500;
  return new APIError(message, rawNumericCode, err, retryable);
}
