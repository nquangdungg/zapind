import type { ClientStatus } from './enums.js';

export interface SerializedCookie {
  key?: string;
  name?: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string | number | null;
  expirationDate?: number;
  httpOnly?: boolean;
  secure?: boolean;
  hostOnly?: boolean;
  sameSite?: string;
  [key: string]: unknown;
}

export interface SessionCredentials {
  readonly cookie: readonly SerializedCookie[];
  readonly imei: string;
  readonly userAgent: string;
  readonly language?: string;
}

export interface SessionInfo {
  readonly accountId: string;
  readonly displayName: string;
  readonly avatarUrl: string;
  readonly status: ClientStatus;
  readonly authenticatedAt: Date;
}

export interface StoredSessionRecord {
  readonly version: 1;
  readonly savedAt: number;
  readonly credentials: SessionCredentials;
  readonly account?: {
    readonly accountId: string;
    readonly displayName: string;
    readonly avatarUrl: string;
  };
}

export interface QRCodeData {
  readonly imageBase64: string;
  readonly imageDataUrl: string;
  readonly code?: string;
}

export interface QRScannedData {
  readonly displayName: string;
  readonly avatarUrl: string;
}

export interface LoginOptions {
  readonly credentials?: SessionCredentials;
  readonly onQRCode?: (qr: QRCodeData) => void | Promise<void>;
  readonly onScanned?: (info: QRScannedData) => void | Promise<void>;
  readonly onExpired?: () => void | Promise<void>;
  readonly onDeclined?: () => void | Promise<void>;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
  readonly language?: string;
  /** If true, skips restoring saved session and starts a fresh QR login. */
  readonly forceQR?: boolean;
}

export interface LogoutOptions {
  readonly clearSession?: boolean;
}
