import { InFlightDeduplicator, TTLCache } from './core/cache.js';
import { EventBus } from './core/event-bus.js';
import {
  PolicyExecutor,
  RateLimiter,
  RedactingLogger,
  type Logger,
  type RateLimiterOptions,
  type RetryOptions,
} from './core/policies.js';
import { ThreadTypeRegistry } from './core/thread-registry.js';
import {
  AuthenticationError,
  SessionError,
  ValidationError,
  normalizeError,
} from './errors/index.js';
import { mapMessageData, mapProfileData } from './mappers/index.js';
import {
  ClientStatus,
  CloseReason,
  Message,
  ThreadType,
  type Group,
  type ImageMetadataGetter,
  type LoginOptions,
  type LogoutOptions,
  type ModelActions,
  type SessionCredentials,
  type SessionInfo,
  type UnsubscribeFn,
  type User,
  type ZapindEventHandler,
  type ZapindEventName,
} from './models/index.js';
import {
  AccountService,
  ContactsService,
  ConversationsService,
  GroupsService,
  MediaService,
  MessagesService,
  SettingsService,
  UsersService,
  type ServiceDeps,
} from './services/index.js';
import {
  FileSessionStore,
  MemorySessionStore,
  type SessionStore,
} from './storage/index.js';
import type { TransportAdapter } from './transport/adapter.js';
import { ZcaTransport } from './transport/zca.transport.js';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0';

export interface ZapindOptions {
  /** Path to a session JSON file (e.g. "./session.json") or a custom SessionStore instance. */
  readonly session?: string | SessionStore;
  readonly timeoutMs?: number;
  readonly qrTimeoutMs?: number;
  readonly retry?: Partial<RetryOptions>;
  readonly rateLimit?: RateLimiterOptions | false;
  readonly cacheTtlMs?: number;
  readonly maxCacheEntries?: number;
  readonly logger?: Logger;
  readonly debug?: boolean;
  readonly selfListen?: boolean;
  readonly userAgent?: string;
  readonly language?: string;
  readonly imageMetadataGetter?: ImageMetadataGetter;
  /** Optional custom transport (e.g., MockTransport for testing). */
  readonly transport?: TransportAdapter;
}

export interface EventsNamespace {
  on: <K extends ZapindEventName>(event: K, handler: ZapindEventHandler<K>) => UnsubscribeFn;
  once: <K extends ZapindEventName>(event: K, handler: ZapindEventHandler<K>) => UnsubscribeFn;
  off: <K extends ZapindEventName>(event: K, handler: ZapindEventHandler<K>) => void;
  start: (options?: { retryOnClose?: boolean }) => void;
  stop: () => void;
}

/**
 * Zapind — Developer-friendly, contextual, type-safe Zalo SDK.
 */
export class Zapind {
  public readonly account: AccountService;
  public readonly users: UsersService;
  public readonly contacts: ContactsService;
  public readonly groups: GroupsService;
  public readonly conversations: ConversationsService;
  public readonly messages: MessagesService;
  public readonly media: MediaService;
  public readonly settings: SettingsService;
  public readonly events: EventsNamespace;

  private readonly transport: TransportAdapter;
  private readonly sessionStore: SessionStore;
  private readonly executor: PolicyExecutor;
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly registry: ThreadTypeRegistry;
  private readonly userCache: TTLCache<string, User>;
  private readonly groupCache: TTLCache<string, Group>;
  private readonly dedup: InFlightDeduplicator;
  private readonly selfListen: boolean;
  private readonly defaultUserAgent: string;
  private readonly defaultLanguage: string;
  private readonly defaultQrTimeoutMs: number;
  private readonly modelActions: ModelActions;

  private status: ClientStatus = ClientStatus.Idle;
  private sessionInfo: SessionInfo | null = null;
  private listening = false;

  constructor(options: ZapindOptions = {}) {
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ValidationError('timeoutMs must be a positive number');
    }

    const qrTimeoutMs = options.qrTimeoutMs ?? 180_000;
    if (!Number.isFinite(qrTimeoutMs) || qrTimeoutMs <= 0) {
      throw new ValidationError('qrTimeoutMs must be a positive number');
    }

    const cacheTtlMs = options.cacheTtlMs ?? 60_000;
    if (!Number.isFinite(cacheTtlMs) || cacheTtlMs <= 0) {
      throw new ValidationError('cacheTtlMs must be a positive number');
    }

    const maxCacheEntries = options.maxCacheEntries ?? 500;
    if (!Number.isInteger(maxCacheEntries) || maxCacheEntries < 1) {
      throw new ValidationError('maxCacheEntries must be a positive integer');
    }

    this.defaultQrTimeoutMs = qrTimeoutMs;
    this.selfListen = options.selfListen ?? false;
    this.defaultUserAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.defaultLanguage = options.language ?? 'vi';

    this.logger = new RedactingLogger({ sink: options.logger, debug: options.debug ?? false });
    this.sessionStore =
      typeof options.session === 'string'
        ? new FileSessionStore(options.session)
        : (options.session ?? new MemorySessionStore());

    this.transport =
      options.transport ??
      new ZcaTransport({
        selfListen: this.selfListen,
        checkUpdate: false,
        imageMetadataGetter: options.imageMetadataGetter,
      });

    const retryOptions: RetryOptions = {
      maxAttempts: options.retry?.maxAttempts ?? 3,
      baseDelayMs: options.retry?.baseDelayMs ?? 300,
      maxDelayMs: options.retry?.maxDelayMs ?? 5_000,
    };
    if (!Number.isInteger(retryOptions.maxAttempts) || retryOptions.maxAttempts < 1) {
      throw new ValidationError('retry.maxAttempts must be an integer >= 1');
    }
    if (!Number.isFinite(retryOptions.baseDelayMs) || retryOptions.baseDelayMs < 0) {
      throw new ValidationError('retry.baseDelayMs must be >= 0');
    }
    if (!Number.isFinite(retryOptions.maxDelayMs) || retryOptions.maxDelayMs < retryOptions.baseDelayMs) {
      throw new ValidationError('retry.maxDelayMs must be >= retry.baseDelayMs');
    }

    const rateLimiter =
      options.rateLimit === false
        ? null
        : new RateLimiter(options.rateLimit ?? { maxRequestsPerSecond: 5, burst: 10 });

    this.executor = new PolicyExecutor(timeoutMs, retryOptions, rateLimiter, this.logger);
    this.eventBus = new EventBus(this.logger);
    this.registry = new ThreadTypeRegistry(options.cacheTtlMs ?? 5 * 60_000);
    this.userCache = new TTLCache<string, User>({
      maxEntries: maxCacheEntries,
      defaultTtlMs: cacheTtlMs,
    });
    this.groupCache = new TTLCache<string, Group>({
      maxEntries: options.maxCacheEntries ?? 250,
      defaultTtlMs: cacheTtlMs,
    });
    this.dedup = new InFlightDeduplicator();

    const actions: ModelActions = {
      sendMessage: (id, content, type) => this.messages.send(id, content, type),
      replyMessage: (msg, content) => this.messages.reply(msg, content),
      reactMessage: (msg, reaction) => this.messages.react(msg, reaction),
      undoMessage: (msg) => this.messages.undo(msg),
      deleteMessage: (msg, onlyMe) => this.messages.delete(msg, onlyMe),
      markSeen: (msgs) => this.messages.markSeen(msgs),
      getGroupMessages: (groupId, count) => this.conversations.getMessages(groupId, count),
      sendTyping: (id, type) => this.conversations.sendTyping(id, type),
      pinConversation: (id, pinned, type) => this.conversations.pin(id, pinned, type),
      muteConversation: (id, duration, type) => this.conversations.mute(id, duration, type),
      sendFriendRequest: (uid, msg) => this.contacts.sendRequest(uid, msg),
      blockUser: (uid) => this.contacts.block(uid),
      unblockUser: (uid) => this.contacts.unblock(uid),
      setFriendAlias: (uid, alias) => this.contacts.setAlias(uid, alias),
      removeFriend: (uid) => this.contacts.remove(uid),
      addGroupMembers: (gid, uids) => this.groups.addMembers(gid, uids),
      removeGroupMembers: (gid, uids) => this.groups.removeMembers(gid, uids),
      renameGroup: (gid, name) => this.groups.rename(gid, name),
      leaveGroup: (gid) => this.groups.leave(gid),
    };

    this.modelActions = actions;

    const deps: ServiceDeps = {
      transport: this.transport,
      executor: this.executor,
      registry: this.registry,
      actions,
      userCache: this.userCache,
      groupCache: this.groupCache,
      dedup: this.dedup,
    };

    this.account = new AccountService(deps);
    this.users = new UsersService(deps);
    this.contacts = new ContactsService(deps);
    this.groups = new GroupsService(deps);
    this.conversations = new ConversationsService(deps);
    this.messages = new MessagesService(deps);
    this.media = new MediaService(deps, this.messages);
    this.settings = new SettingsService(deps);
    this.events = {
      on: (e, h) => this.on(e, h),
      once: (e, h) => this.once(e, h),
      off: (e, h) => this.off(e, h),
      start: (opts) => this.startListening(opts),
      stop: () => this.stopListening(),
    };
  }

  /**
   * Low-level escape hatch to access the underlying `zca-js` API directly.
   * Intended for advanced 10% use cases not wrapped by high-level domain services.
   */
  public get raw(): unknown {
    return this.transport.getRawApi();
  }

  public getStatus(): ClientStatus {
    return this.status;
  }

  public getSession(): SessionInfo | null {
    return this.sessionInfo;
  }

  public isAuthenticated(): boolean {
    return (
      this.status === ClientStatus.Connected &&
      this.transport.isConnected() &&
      this.sessionInfo !== null
    );
  }

  /**
   * Smart authentication entry point:
   * 1. If `options.credentials` is provided -> authenticates with those credentials.
   * 2. Otherwise tries to restore and validate a saved session from `SessionStore`.
   * 3. If missing or expired -> emits `auth.required` and performs QR login.
   */
  public async login(options: LoginOptions = {}): Promise<SessionInfo> {
    if (options.credentials) {
      return this.authenticateWithCredentials(options.credentials);
    }

    if (!options.forceQR) {
      const stored = await this.sessionStore.load();
      if (stored?.credentials?.cookie?.length) {
        try {
          return await this.authenticateWithCredentials(stored.credentials);
        } catch (err) {
          const normalized = normalizeError(err, 'Saved session expired or invalid');
          this.logger.warn('Saved session restore failed, falling back to QR login', {
            code: normalized.code,
          });
          this.eventBus.emit('auth.required', {
            reason: 'session_expired',
            error: normalized,
          });
        }
      } else {
        this.eventBus.emit('auth.required', { reason: 'no_session' });
      }
    }

    return this.loginWithQR(options);
  }

  private async buildAndPersistSession(credentials: SessionCredentials): Promise<SessionInfo> {
    let accountId = '';
    let displayName = '';
    let avatarUrl = '';

    try {
      const rawProfile = await this.executor.execute(() => this.transport.fetchAccountInfo(), {
        operation: 'auth.fetchProfile',
        idempotent: true,
      });
      if (rawProfile) {
        const p = mapProfileData(rawProfile);
        accountId = p.id;
        displayName = p.displayName;
        avatarUrl = p.avatarUrl;
      }
    } catch {
      // Fallback to ownId below
    }

    if (!accountId) accountId = this.transport.getOwnId();

    const info: SessionInfo = {
      accountId,
      displayName,
      avatarUrl,
      status: ClientStatus.Connected,
      authenticatedAt: new Date(),
    };

    this.sessionInfo = info;
    this.status = ClientStatus.Connected;
    this.registry.registerUser(accountId);

    await this.sessionStore.save({
      version: 1,
      savedAt: Date.now(),
      credentials,
      account: { accountId, displayName, avatarUrl },
    });

    return info;
  }

  private async authenticateWithCredentials(credentials: SessionCredentials): Promise<SessionInfo> {
    if (!credentials.cookie?.length || !credentials.imei) {
      throw new ValidationError('Credentials must include non-empty cookie array and imei');
    }
    this.status = ClientStatus.Starting;
    try {
      await this.executor.execute(
        () =>
          this.transport.loginWithCredentials({
            ...credentials,
            userAgent: credentials.userAgent || this.defaultUserAgent,
            language: credentials.language || this.defaultLanguage,
          }),
        { operation: 'auth.loginWithCredentials', idempotent: false },
      );
      return await this.buildAndPersistSession(credentials);
    } catch (err) {
      this.status = ClientStatus.Error;
      this.sessionInfo = null;
      throw normalizeError(err, 'Session authentication failed');
    }
  }

  private async loginWithQR(options: LoginOptions): Promise<SessionInfo> {
    const timeoutMs = options.timeoutMs ?? this.defaultQrTimeoutMs;
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeoutMs);
    timer.unref?.();

    this.status = ClientStatus.QRPending;
    try {
      const creds = await this.transport.loginWithQR(
        {
          userAgent: options.userAgent ?? this.defaultUserAgent,
          language: options.language ?? this.defaultLanguage,
          signal: ac.signal,
        },
        {
          onQRCode: (qr) => {
            this.status = ClientStatus.QRPending;
            Promise.resolve(options.onQRCode?.(qr)).catch(() => {});
          },
          onScanned: (info) => {
            this.status = ClientStatus.Scanned;
            Promise.resolve(options.onScanned?.(info)).catch(() => {});
          },
          onExpired: () => {
            this.status = ClientStatus.Idle;
            Promise.resolve(options.onExpired?.()).catch(() => {});
          },
          onDeclined: () => {
            this.status = ClientStatus.Idle;
            Promise.resolve(options.onDeclined?.()).catch(() => {});
          },
        },
      );
      return await this.buildAndPersistSession(creds);
    } catch (err) {
      this.status = ClientStatus.Error;
      this.sessionInfo = null;
      if (timedOut) {
        throw new AuthenticationError(`QR login timed out after ${timeoutMs}ms`, err);
      }
      throw normalizeError(err, 'QR login failed');
    } finally {
      clearTimeout(timer);
    }
  }

  public async logout(options: LogoutOptions = {}): Promise<void> {
    this.stopListening();
    await this.transport.disconnect();
    this.sessionInfo = null;
    this.status = ClientStatus.Idle;
    this.userCache.clear();
    this.groupCache.clear();
    this.registry.clear();
    this.dedup.clear();

    if (options.clearSession ?? true) {
      await this.sessionStore.clear();
    }
  }

  /**
   * Stops realtime listeners, disconnects, clears caches, and removes all registered event listeners.
   */
  public async destroy(options: LogoutOptions = { clearSession: false }): Promise<void> {
    await this.logout(options);
    this.eventBus.removeAllListeners();
  }

  // --- Event System ---

  public on<K extends ZapindEventName>(event: K, handler: ZapindEventHandler<K>): UnsubscribeFn {
    return this.eventBus.on(event, handler);
  }

  public once<K extends ZapindEventName>(event: K, handler: ZapindEventHandler<K>): UnsubscribeFn {
    return this.eventBus.once(event, handler);
  }

  public off<K extends ZapindEventName>(event: K, handler: ZapindEventHandler<K>): void {
    this.eventBus.off(event, handler);
  }

  public startListening(options?: { retryOnClose?: boolean }): void {
    if (!this.isAuthenticated()) {
      throw new AuthenticationError('Cannot start listening before login()');
    }
    if (this.listening) return;
    this.listening = true;

    this.transport.startListening(
      {
        onMessage: (raw) => {
          const data = mapMessageData(raw);
          if (data.threadType === ThreadType.Group) this.registry.registerGroup(data.threadId);
          else this.registry.registerUser(data.threadId);

          if (data.isSelf && !this.selfListen) return;
          this.eventBus.emit('message', new Message(data, this.modelActions));
        },
        onReaction: (evt) => {
          if (evt.isSelf && !this.selfListen) return;
          this.eventBus.emit('reaction', evt);
        },
        onGroupUpdate: (evt) => {
          if (evt.groupId) {
            this.registry.registerGroup(evt.groupId);
            this.groupCache.delete(evt.groupId);
          }
          this.eventBus.emit('group.update', evt);
        },
        onUserUpdate: (evt) => {
          if (evt.userId) {
            this.registry.registerUser(evt.userId);
            this.userCache.delete(evt.userId);
          }
          this.eventBus.emit('user.update', evt);
        },
        onTyping: (evt) => {
          if (evt.isSelf && !this.selfListen) return;
          this.eventBus.emit('typing', evt);
        },
        onSeen: (evt) => this.eventBus.emit('seen', evt),
        onUndo: (evt) => {
          if (evt.isSelf && !this.selfListen) return;
          this.eventBus.emit('undo', evt);
        },
        onConnected: (evt) => this.eventBus.emit('connected', evt),
        onDisconnected: (evt) => {
          this.listening = false;
          this.eventBus.emit('disconnected', evt);
          if (
            evt.code === CloseReason.KickConnection ||
            evt.code === CloseReason.DuplicateConnection
          ) {
            const err = new SessionError(`Realtime connection closed with code ${evt.code}`, undefined, evt.code);
            this.status = ClientStatus.Error;
            this.sessionInfo = null;
            this.eventBus.emit('auth.required', { reason: 'session_expired', error: err });
          }
        },
        onError: (err) => this.eventBus.emit('error', normalizeError(err, 'Realtime listener error')),
      },
      options,
    );
  }

  public stopListening(): void {
    if (!this.listening) return;
    this.transport.stopListening();
    this.listening = false;
  }
}
