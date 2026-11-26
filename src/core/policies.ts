import { NetworkError, RateLimitError, ZapindError, normalizeError } from '../errors/index.js';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const SENSITIVE_KEY_PATTERN =
  /token|secret|password|cookie|refresh|credential|auth|imei|cipher|zpw_sek|qr|imagebase64|imagedataurl|content|message|msg|text/i;

export function redactSensitive(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return `[Buffer(${value.length})]`;
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(k)) {
      out[k] = '[REDACTED]';
    } else if (v !== null && typeof v === 'object') {
      out[k] = redactSensitive(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function formatLine(level: string, message: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  if (!meta) return `[${ts}] [${level}] ${message}`;
  try {
    return `[${ts}] [${level}] ${message} ${JSON.stringify(meta)}`;
  } catch {
    return `[${ts}] [${level}] ${message} [Unserializable meta]`;
  }
}

export class RedactingLogger implements Logger {
  private readonly sink: Logger;
  private readonly debugEnabled: boolean;

  constructor(options: { sink?: Logger; debug?: boolean } = {}) {
    this.debugEnabled = options.debug ?? false;
    this.sink = options.sink ?? {
      debug: (msg, meta) => console.debug(formatLine('DEBUG', msg, meta)),
      info: (msg, meta) => console.info(formatLine('INFO', msg, meta)),
      warn: (msg, meta) => console.warn(formatLine('WARN', msg, meta)),
      error: (msg, meta) => console.error(formatLine('ERROR', msg, meta)),
    };
  }

  private sanitize(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
    return meta ? (redactSensitive(meta) as Record<string, unknown>) : undefined;
  }

  public debug(message: string, meta?: Record<string, unknown>): void {
    if (!this.debugEnabled) return;
    this.sink.debug(message, this.sanitize(meta));
  }
  public info(message: string, meta?: Record<string, unknown>): void {
    this.sink.info(message, this.sanitize(meta));
  }
  public warn(message: string, meta?: Record<string, unknown>): void {
    this.sink.warn(message, this.sanitize(meta));
  }
  public error(message: string, meta?: Record<string, unknown>): void {
    this.sink.error(message, this.sanitize(meta));
  }
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export interface RetryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export interface RateLimiterOptions {
  readonly maxRequestsPerSecond: number;
  readonly burst?: number;
}

export async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  label?: string,
): Promise<T> {
  if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) return operation();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new NetworkError(`${label ?? 'Request'} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([operation(), timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
  allowRetry = true,
): Promise<T> {
  const attempts = allowRetry ? Math.max(1, options.maxAttempts) : 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      const isRetryable = err instanceof ZapindError && err.retryable;
      if (!allowRetry || !isRetryable || attempt >= attempts) throw err;

      const delayMs =
        err instanceof RateLimitError && err.retryAfterMs !== null && err.retryAfterMs > 0
          ? Math.min(err.retryAfterMs, options.maxDelayMs)
          : Math.min(
              options.baseDelayMs * Math.pow(2, attempt - 1) +
                Math.floor(Math.random() * Math.max(1, options.baseDelayMs / 2)),
              options.maxDelayMs,
            );

      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delayMs);
        t.unref?.();
      });
    }
  }
  throw lastError;
}

export class RateLimiter {
  private readonly ratePerMs: number;
  private readonly capacity: number;
  private tokens: number;
  private lastRefillAt: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions) {
    const rps = Math.max(0.1, options.maxRequestsPerSecond);
    this.ratePerMs = rps / 1000;
    this.capacity = Math.max(1, options.burst ?? Math.ceil(rps));
    this.tokens = this.capacity;
    this.lastRefillAt = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.lastRefillAt);
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
      this.lastRefillAt = now;
    }
  }

  public acquire(): Promise<void> {
    const next = this.queue.then(async () => {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - this.tokens) / this.ratePerMs);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, waitMs);
        t.unref?.();
      });
      this.refill();
      this.tokens = Math.max(0, this.tokens - 1);
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

export class PolicyExecutor {
  constructor(
    private readonly defaultTimeoutMs: number,
    private readonly retryOptions: RetryOptions,
    private readonly rateLimiter: RateLimiter | null,
    private readonly logger: Logger,
  ) {}

  public async execute<T>(
    fn: () => Promise<T>,
    options: { operation: string; timeoutMs?: number; idempotent?: boolean },
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const allowRetry = options.idempotent ?? true;

    const runOnce = async (): Promise<T> => {
      if (this.rateLimiter) await this.rateLimiter.acquire();
      try {
        return await withTimeout(fn, timeoutMs, options.operation);
      } catch (err) {
        const normalized = normalizeError(err, `Failed during ${options.operation}`);
        this.logger.debug('Operation error', {
          operation: options.operation,
          code: normalized.code,
          retryable: normalized.retryable,
        });
        throw normalized;
      }
    };

    if (!allowRetry || this.retryOptions.maxAttempts <= 1) {
      return runOnce();
    }

    return withRetry(runOnce, this.retryOptions, true);
  }
}
