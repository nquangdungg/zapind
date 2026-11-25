import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { SessionError } from '../errors/index.js';
import type { StoredSessionRecord } from '../models/session.js';

export interface SessionStore {
  load(): Promise<StoredSessionRecord | null>;
  save(record: StoredSessionRecord): Promise<void>;
  clear(): Promise<void>;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

export class MemorySessionStore implements SessionStore {
  private record: StoredSessionRecord | null = null;

  public async load(): Promise<StoredSessionRecord | null> {
    return this.record ? structuredClone(this.record) : null;
  }

  public async save(record: StoredSessionRecord): Promise<void> {
    this.record = structuredClone(record);
  }

  public async clear(): Promise<void> {
    this.record = null;
  }
}

export class FileSessionStore implements SessionStore {
  constructor(public readonly filePath: string) {
    if (!filePath || typeof filePath !== 'string') {
      throw new SessionError('FileSessionStore requires a non-empty filePath');
    }
  }

  public async load(): Promise<StoredSessionRecord | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoredSessionRecord;
      return parsed && typeof parsed === 'object' && parsed.credentials ? parsed : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw new SessionError(`Failed to read session file "${this.filePath}"`, err);
    }
  }

  public async save(record: StoredSessionRecord): Promise<void> {
    const dir = dirname(this.filePath);
    const tmp = `${this.filePath}.tmp.${Date.now()}.${randomBytes(4).toString('hex')}`;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(tmp, JSON.stringify(record, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.filePath);
      if (process.platform !== 'win32') {
        await chmod(this.filePath, 0o600).catch(() => {});
      }
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw new SessionError(`Failed to save session file "${this.filePath}"`, err);
    }
  }

  public async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err) {
      if (isNotFound(err)) return;
      throw new SessionError(`Failed to remove session file "${this.filePath}"`, err);
    }
  }
}

interface EncryptedEnvelope {
  v: 1;
  alg: 'aes-256-gcm';
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

export class EncryptedFileSessionStore implements SessionStore {
  constructor(
    public readonly filePath: string,
    private readonly secret: string | Buffer,
  ) {
    if (!filePath) throw new SessionError('EncryptedFileSessionStore requires a non-empty filePath');
    const len = typeof secret === 'string' ? Buffer.byteLength(secret, 'utf8') : secret.length;
    if (len < 16) throw new SessionError('Encryption secret must be at least 16 bytes');
  }

  private deriveKey(salt: Buffer): Buffer {
    return scryptSync(this.secret, salt, 32);
  }

  public async load(): Promise<StoredSessionRecord | null> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const env = JSON.parse(raw) as EncryptedEnvelope;
      if (env?.v !== 1 || env.alg !== 'aes-256-gcm') {
        throw new SessionError('Unsupported encrypted session format');
      }
      const key = this.deriveKey(Buffer.from(env.salt, 'base64'));
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(env.data, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return JSON.parse(plain) as StoredSessionRecord;
    } catch (err) {
      if (isNotFound(err)) return null;
      if (err instanceof SessionError) throw err;
      throw new SessionError(`Failed to decrypt session file "${this.filePath}"`, err);
    }
  }

  public async save(record: StoredSessionRecord): Promise<void> {
    const dir = dirname(this.filePath);
    const tmp = `${this.filePath}.tmp.${Date.now()}.${randomBytes(4).toString('hex')}`;
    try {
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const key = this.deriveKey(salt);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(record), 'utf8')),
        cipher.final(),
      ]);
      const envelope: EncryptedEnvelope = {
        v: 1,
        alg: 'aes-256-gcm',
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: encrypted.toString('base64'),
      };
      await mkdir(dir, { recursive: true });
      await writeFile(tmp, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.filePath);
      if (process.platform !== 'win32') {
        await chmod(this.filePath, 0o600).catch(() => {});
      }
    } catch (err) {
      await unlink(tmp).catch(() => {});
      throw new SessionError(`Failed to save encrypted session "${this.filePath}"`, err);
    }
  }

  public async clear(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch (err) {
      if (isNotFound(err)) return;
      throw new SessionError(`Failed to remove encrypted session "${this.filePath}"`, err);
    }
  }
}
