import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InFlightDeduplicator, TTLCache } from '../../src/core/cache.js';
import { EventBus } from '../../src/core/event-bus.js';
import {
  RateLimiter,
  RedactingLogger,
  redactSensitive,
  withRetry,
  withTimeout,
} from '../../src/core/policies.js';
import { ThreadTypeRegistry } from '../../src/core/thread-registry.js';
import {
  APIError,
  AuthenticationError,
  NetworkError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  SessionError,
  ValidationError,
  normalizeError,
} from '../../src/errors/index.js';
import { mapGroupData, mapMessageData, mapUserData } from '../../src/mappers/index.js';
import { Gender, GroupType, ThreadType } from '../../src/models/index.js';
import {
  EncryptedFileSessionStore,
  FileSessionStore,
  MemorySessionStore,
} from '../../src/storage/index.js';

describe('Errors & Normalization', () => {
  it('maps transport errors into ZapidError hierarchy', () => {
    expect(normalizeError({ status: 401, message: 'Session expired' })).toBeInstanceOf(SessionError);
    expect(normalizeError({ status: 403, message: 'Forbidden' })).toBeInstanceOf(PermissionError);
    expect(normalizeError({ status: 404, message: 'Not found' })).toBeInstanceOf(NotFoundError);
    expect(normalizeError({ status: 429, message: 'Too many requests' })).toBeInstanceOf(RateLimitError);
    expect(normalizeError({ code: 'ECONNRESET', message: 'socket hang up' })).toBeInstanceOf(NetworkError);
    expect(normalizeError(Object.assign(new Error('declined'), { name: 'ZaloApiLoginQRDeclined' }))).toBeInstanceOf(
      AuthenticationError,
    );
    expect(
      normalizeError(Object.assign(new Error('missing'), { name: 'ZaloApiMissingImageMetadataGetter' })),
    ).toBeInstanceOf(ValidationError);
    expect(normalizeError({ status: 503, code: 99, message: 'Down' })).toBeInstanceOf(APIError);
  });
});

describe('Cache, Deduplicator & ThreadTypeRegistry', () => {
  it('evicts oldest entry when TTLCache exceeds maxEntries and respects TTL', async () => {
    const cache = new TTLCache<string, number>({ maxEntries: 2, defaultTtlMs: 50 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);

    await new Promise((r) => setTimeout(r, 60));
    expect(cache.get('b')).toBeUndefined();
  });

  it('deduplicates concurrent in-flight calls', async () => {
    const dedup = new InFlightDeduplicator();
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return 'shared';
    };
    const results = await Promise.all([
      dedup.run('k', fn),
      dedup.run('k', fn),
      dedup.run('k', fn),
    ]);
    expect(results).toEqual(['shared', 'shared', 'shared']);
    expect(calls).toBe(1);
  });

  it('resolves threadType automatically from context or cached group registry', async () => {
    const registry = new ThreadTypeRegistry(60_000);
    let fetchCalls = 0;
    const fetchGroups = async () => {
      fetchCalls++;
      return ['g-1', 'g-2'];
    };

    const r1 = await registry.resolve('g-1', undefined, fetchGroups);
    expect(r1).toEqual({ threadId: 'g-1', threadType: ThreadType.Group });

    // Second call hits cache with zero extra fetch
    const r2 = await registry.resolve('g-2', undefined, fetchGroups);
    expect(r2).toEqual({ threadId: 'g-2', threadType: ThreadType.Group });
    expect(fetchCalls).toBe(1);

    // Unknown ID defaults safely to User
    const r3 = await registry.resolve('u-99', undefined, fetchGroups);
    expect(r3).toEqual({ threadId: 'u-99', threadType: ThreadType.User });

    // Contextual object bypasses registry
    const r4 = await registry.resolve({ id: 'g-999', threadType: ThreadType.Group }, undefined);
    expect(r4).toEqual({ threadId: 'g-999', threadType: ThreadType.Group });
  });
});

describe('Policies & Mappers & EventBus', () => {
  it('redacts sensitive metadata fields', () => {
    const out = redactSensitive({
      cookie: [{ value: 'secret' }],
      imei: '123',
      text: 'private',
      accountId: 'u-1',
    }) as Record<string, unknown>;
    expect(out.cookie).toBe('[REDACTED]');
    expect(out.imei).toBe('[REDACTED]');
    expect(out.text).toBe('[REDACTED]');
    expect(out.accountId).toBe('u-1');
  });

  it('handles timeout, retry, rate limiting, and isolated event handlers', async () => {
    await expect(
      withTimeout(() => new Promise((r) => setTimeout(r, 80)), 15, 'op'),
    ).rejects.toBeInstanceOf(NetworkError);

    let tries = 0;
    const ok = await withRetry(
      async () => {
        tries++;
        if (tries < 2) throw new NetworkError('retry me');
        return 'done';
      },
      { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 20 },
    );
    expect(ok).toBe('done');
    expect(tries).toBe(2);

    const limiter = new RateLimiter({ maxRequestsPerSecond: 100, burst: 2 });
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);

    const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const bus = new EventBus(new RedactingLogger({ sink }));
    const good = vi.fn();
    bus.on('connected', () => {
      throw new Error('bad handler');
    });
    bus.on('connected', good);
    bus.emit('connected', { connected: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(good).toHaveBeenCalledTimes(1);
    expect(sink.error).toHaveBeenCalledTimes(1);
  });

  it('maps raw user, group, and message payloads cleanly', () => {
    const u = mapUserData({ userId: 'u1', displayName: 'Alice', gender: 1, isFr: 1 });
    expect(u.gender).toBe(Gender.Female);
    expect(u.isFriend).toBe(true);

    const g = mapGroupData({ groupId: 'g1', name: 'Devs', type: 2, e2ee: 1 });
    expect(g.type).toBe(GroupType.Community);
    expect(g.isE2EE).toBe(true);

    const m = mapMessageData({
      type: ThreadType.Group,
      threadId: 'g1',
      data: { msgId: 'm1', cliMsgId: 'c1', uidFrom: 'u1', idTo: 'g1', ts: '1700000000000', content: 'Hi' },
    });
    expect(m.text).toBe('Hi');
    expect(m.sender.id).toBe('u1');
    expect(m.timestamp).toBeInstanceOf(Date);
  });
});

describe('SessionStore implementations', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zapid-session-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const sample = {
    version: 1 as const,
    savedAt: 1700000000000,
    credentials: {
      cookie: [{ name: 'zpw_sek', value: 'secret-cookie' }],
      imei: 'secret-imei',
      userAgent: 'TestAgent',
    },
  };

  it('roundtrips Memory, File, and EncryptedFile stores', async () => {
    const mem = new MemorySessionStore();
    await mem.save(sample);
    expect(await mem.load()).toEqual(sample);
    await mem.clear();
    expect(await mem.load()).toBeNull();

    const file = new FileSessionStore(join(dir, 'session.json'));
    await file.save(sample);
    expect(await file.load()).toEqual(sample);
    await file.clear();
    expect(await file.load()).toBeNull();

    const encPath = join(dir, 'session.enc.json');
    const enc = new EncryptedFileSessionStore(encPath, 'my-super-secret-passphrase');
    await enc.save(sample);
    const disk = await readFile(encPath, 'utf8');
    expect(disk).not.toContain('secret-cookie');
    expect(await enc.load()).toEqual(sample);
  });
});
