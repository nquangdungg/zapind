import { InFlightDeduplicator, TTLCache } from '../core/cache.js';
import type { PolicyExecutor } from '../core/policies.js';
import type { ThreadTypeRegistry } from '../core/thread-registry.js';
import { AuthenticationError, NotFoundError, ValidationError } from '../errors/index.js';
import {
  mapAccountSettings,
  mapContactData,
  mapGroupData,
  mapGroupMember,
  mapGroupSummaries,
  mapLastOnline,
  mapMessageData,
  mapOnlineFriends,
  mapProfileData,
  mapUploadedMedia,
  mapUserData,
} from '../mappers/index.js';
import {
  Contact,
  Conversation,
  Group,
  Message,
  Profile,
  ThreadType,
  User,
  type AccountSettings,
  type GetMessagesOptions,
  type GroupMember,
  type GroupSummary,
  type LastOnlineInfo,
  type MediaInput,
  type MessagePage,
  type ModelActions,
  type OnlineStatus,
  type PinnedConversations,
  type Reaction,
  type SendMessageContent,
  type SendMessagePayload,
  type SendMessageReceipt,
  type ThreadTarget,
  type UnreadMarks,
  type UploadedMedia,
} from '../models/index.js';
import type { TransportAdapter } from '../transport/adapter.js';

export interface ServiceDeps {
  transport: TransportAdapter;
  executor: PolicyExecutor;
  registry: ThreadTypeRegistry;
  actions: ModelActions;
  userCache: TTLCache<string, User>;
  groupCache: TTLCache<string, Group>;
  dedup: InFlightDeduplicator;
}

export interface CacheLookupOptions {
  readonly skipCache?: boolean;
}

function ensureConnected(transport: TransportAdapter): void {
  if (!transport.isConnected()) {
    throw new AuthenticationError(
      'Zapind client is not authenticated. Call await client.login() first.',
    );
  }
}

function requireNonEmpty(value: string, fieldName: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw new ValidationError(`${fieldName} must be a non-empty string`);
  }
  return trimmed;
}

function requireUniqueNonEmptyIds(values: readonly string[], fieldName: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const trimmed = typeof v === 'string' ? v.trim() : '';
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  if (out.length === 0) {
    throw new ValidationError(`${fieldName} must contain at least one non-empty ID`);
  }
  return out;
}

function assertOptionalPositiveInt(value: number | undefined, fieldName: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
    throw new ValidationError(`${fieldName} must be a positive integer`);
  }
}

async function resolveThreadTarget(
  deps: ServiceDeps,
  target: ThreadTarget,
  explicitType?: ThreadType,
): Promise<{ threadId: string; threadType: ThreadType }> {
  const resolved = await deps.registry.resolve(target, explicitType, async () => {
    const map = await deps.executor.execute(() => deps.transport.getAllGroups(), {
      operation: 'registry.fetchGroupIds',
      idempotent: true,
    });
    return Object.keys(map);
  });
  if (!resolved.threadId) {
    throw new ValidationError('Target threadId must be a non-empty string');
  }
  return resolved;
}

export class AccountService {
  constructor(private readonly deps: ServiceDeps) {}

  public getOwnId(): string {
    ensureConnected(this.deps.transport);
    return this.deps.transport.getOwnId();
  }

  public async getMe(): Promise<Profile> {
    ensureConnected(this.deps.transport);
    const raw = await this.deps.executor.execute(() => this.deps.transport.fetchAccountInfo(), {
      operation: 'account.getMe',
      idempotent: true,
    });
    const data = mapProfileData(raw ?? { userId: this.deps.transport.getOwnId() });
    this.deps.registry.registerUser(data.id);
    return new Profile(data, this.deps.actions);
  }

  public async updateProfile(patch: {
    name: string;
    dob: `${number}-${number}-${number}`;
    gender: 'male' | 'female';
  }): Promise<void> {
    ensureConnected(this.deps.transport);
    const name = requireNonEmpty(patch.name, 'name');
    await this.deps.executor.execute(
      () =>
        this.deps.transport.updateProfile({
          name,
          dob: patch.dob,
          gender: patch.gender === 'male' ? 0 : 1,
        }),
      { operation: 'account.updateProfile', idempotent: true },
    );
  }

  public async updateBio(bio: string): Promise<void> {
    ensureConnected(this.deps.transport);
    await this.deps.executor.execute(() => this.deps.transport.updateBio(bio), {
      operation: 'account.updateBio',
      idempotent: true,
    });
  }

  public async keepAlive(): Promise<{ configVersion: number }> {
    ensureConnected(this.deps.transport);
    return this.deps.executor.execute(() => this.deps.transport.keepAlive(), {
      operation: 'account.keepAlive',
      idempotent: true,
    });
  }
}

export class UsersService {
  constructor(private readonly deps: ServiceDeps) {}

  public async get(userId: string, options?: CacheLookupOptions): Promise<User | null> {
    ensureConnected(this.deps.transport);
    const id = requireNonEmpty(userId, 'userId');

    if (!options?.skipCache) {
      const cached = this.deps.userCache.get(id);
      if (cached) return cached;
    }

    return this.deps.dedup.run(`user:${id}`, async () => {
      const profiles = await this.deps.executor.execute(() => this.deps.transport.getUserInfo(id), {
        operation: 'users.get',
        idempotent: true,
      });
      const raw = profiles[id] ?? Object.values(profiles)[0];
      if (!raw) return null;
      const user = new User(mapUserData(raw), this.deps.actions);
      this.deps.registry.registerUser(user.id);
      this.deps.userCache.set(user.id, user);
      return user;
    });
  }

  public async getMany(
    userIds: readonly string[],
    options?: CacheLookupOptions,
  ): Promise<Record<string, User>> {
    ensureConnected(this.deps.transport);
    const ids = requireUniqueNonEmptyIds(userIds, 'userIds');
    const out: Record<string, User> = {};
    const missing: string[] = [];

    for (const id of ids) {
      const cached = options?.skipCache ? undefined : this.deps.userCache.get(id);
      if (cached) {
        out[id] = cached;
      } else {
        missing.push(id);
      }
    }

    if (missing.length === 0) {
      return out;
    }

    const rawMap = await this.deps.executor.execute(() => this.deps.transport.getUserInfo(missing), {
      operation: 'users.getMany',
      idempotent: true,
    });
    for (const [id, raw] of Object.entries(rawMap)) {
      const user = new User(mapUserData(raw), this.deps.actions);
      this.deps.registry.registerUser(user.id);
      this.deps.userCache.set(user.id, user);
      out[id] = user;
    }
    return out;
  }

  public async findByPhone(phoneNumber: string): Promise<User | null> {
    ensureConnected(this.deps.transport);
    const phone = requireNonEmpty(phoneNumber, 'phoneNumber');

    const raw = await this.deps.executor.execute(() => this.deps.transport.findUserByPhone(phone), {
      operation: 'users.findByPhone',
      idempotent: true,
    });
    if (!raw) return null;
    const user = new User(mapUserData(raw), this.deps.actions);
    this.deps.registry.registerUser(user.id);
    this.deps.userCache.set(user.id, user);
    return user;
  }

  public async findByUsername(username: string): Promise<User | null> {
    ensureConnected(this.deps.transport);
    const cleaned = requireNonEmpty(username, 'username');

    const raw = await this.deps.executor.execute(
      () => this.deps.transport.findUserByUsername(cleaned),
      { operation: 'users.findByUsername', idempotent: true },
    );
    if (!raw) return null;
    const user = new User(mapUserData(raw), this.deps.actions);
    this.deps.registry.registerUser(user.id);
    this.deps.userCache.set(user.id, user);
    return user;
  }

  public async getLastOnline(userId: string): Promise<LastOnlineInfo> {
    ensureConnected(this.deps.transport);
    const id = requireNonEmpty(userId, 'userId');

    const raw = await this.deps.executor.execute(() => this.deps.transport.getLastOnline(id), {
      operation: 'users.getLastOnline',
      idempotent: true,
    });
    return mapLastOnline(id, raw);
  }
}

export class ContactsService {
  constructor(private readonly deps: ServiceDeps) {}

  public async list(options: { count?: number; page?: number } = {}): Promise<Contact[]> {
    ensureConnected(this.deps.transport);
    assertOptionalPositiveInt(options.count, 'count');
    assertOptionalPositiveInt(options.page, 'page');

    const rawList = await this.deps.executor.execute(
      () => this.deps.transport.getAllFriends(options.count, options.page),
      { operation: 'contacts.list', idempotent: true },
    );
    return rawList.map((raw) => {
      const contact = new Contact(mapContactData(raw), this.deps.actions);
      this.deps.registry.registerUser(contact.id);
      this.deps.userCache.set(contact.id, contact);
      return contact;
    });
  }

  public async sendRequest(userId: string, message = 'Hello!'): Promise<void> {
    ensureConnected(this.deps.transport);
    const id = requireNonEmpty(userId, 'userId');
    await this.deps.executor.execute(() => this.deps.transport.sendFriendRequest(id, message), {
      operation: 'contacts.sendRequest',
      idempotent: false,
    });
  }

  public async acceptRequest(userId: string): Promise<void> {
    ensureConnected(this.deps.transport);
    const id = requireNonEmpty(userId, 'userId');
    await this.deps.executor.execute(() => this.deps.transport.acceptFriendRequest(id), {
      operation: 'contacts.acceptRequest',
      idempotent: true,
    });
  }

  public async rejectRequest(userId: string): Promise<void> {
    ensureConnected(this.deps.transport);
    const id = requireNonEmpty(userId, 'userId');
    await this.deps.executor.execute(() => this.deps.transport.rejectFriendRequest(id), {
      operation: 'contacts.rejectRequest',
      idempotent: true,
    });
  }

  public async remove(userId: string): Promise<void> {
    ensureConnected(this.deps.transport);
    const id = requireNonEmpty(userId, 'userId');
    await this.deps.executor.execute(() => this.deps.transport.removeFriend(id), {
      operation: 'contacts.remove',
      idempotent: true,
    });
    this.deps.userCache.delete(id);
  }

  public async block(userId: string): Promise<void> {
    ensureConnected(this.deps.transport);
    const id = requireNonEmpty(userId, 'userId');
    await this.deps.executor.execute(() => this.deps.transport.blockUser(id), {
      operation: 'contacts.block',
      idempotent: true,
    });
    this.deps.userCache.delete(id);
  }

  public async unblock(userId: string): Promise<void> {
    ensureConnected(this.deps.transport);
    const id = requireNonEmpty(userId, 'userId');
    await this.deps.executor.execute(() => this.deps.transport.unblockUser(id), {
      operation: 'contacts.unblock',
      idempotent: true,
    });
    this.deps.userCache.delete(id);
  }

  public async setAlias(userId: string, alias: string): Promise<void> {
    ensureConnected(this.deps.transport);
    const id = requireNonEmpty(userId, 'userId');
    await this.deps.executor.execute(() => this.deps.transport.setFriendAlias(id, alias), {
      operation: 'contacts.setAlias',
      idempotent: true,
    });
  }

  public async getOnline(): Promise<OnlineStatus[]> {
    ensureConnected(this.deps.transport);
    const raw = await this.deps.executor.execute(() => this.deps.transport.getOnlineFriends(), {
      operation: 'contacts.getOnline',
      idempotent: true,
    });
    return mapOnlineFriends(raw);
  }
}

export class GroupsService {
  constructor(private readonly deps: ServiceDeps) {}

  public async list(): Promise<GroupSummary[]> {
    ensureConnected(this.deps.transport);
    const map = await this.deps.executor.execute(() => this.deps.transport.getAllGroups(), {
      operation: 'groups.list',
      idempotent: true,
    });
    const summaries = mapGroupSummaries(map);
    this.deps.registry.registerGroups(summaries.map((g) => g.id));
    return summaries;
  }

  public async get(groupId: string, options?: CacheLookupOptions): Promise<Group> {
    ensureConnected(this.deps.transport);
    const id = requireNonEmpty(groupId, 'groupId');

    if (!options?.skipCache) {
      const cached = this.deps.groupCache.get(id);
      if (cached) return cached;
    }

    return this.deps.dedup.run(`group:${id}`, async () => {
      const map = await this.deps.executor.execute(() => this.deps.transport.getGroupInfo(id), {
        operation: 'groups.get',
        idempotent: true,
      });
      const raw = map[id];
      if (!raw) throw new NotFoundError(`Group "${id}" was not found`);
      const group = new Group(mapGroupData(raw, id), this.deps.actions);
      this.deps.registry.registerGroup(group.id);
      this.deps.groupCache.set(group.id, group);
      return group;
    });
  }

  public async getMany(
    groupIds: readonly string[],
    options?: CacheLookupOptions,
  ): Promise<Record<string, Group>> {
    ensureConnected(this.deps.transport);
    const ids = requireUniqueNonEmptyIds(groupIds, 'groupIds');
    const out: Record<string, Group> = {};
    const missing: string[] = [];

    for (const id of ids) {
      const cached = options?.skipCache ? undefined : this.deps.groupCache.get(id);
      if (cached) {
        out[id] = cached;
      } else {
        missing.push(id);
      }
    }

    if (missing.length === 0) {
      return out;
    }

    const map = await this.deps.executor.execute(() => this.deps.transport.getGroupInfo(missing), {
      operation: 'groups.getMany',
      idempotent: true,
    });
    for (const [id, raw] of Object.entries(map)) {
      const group = new Group(mapGroupData(raw, id), this.deps.actions);
      this.deps.registry.registerGroup(group.id);
      this.deps.groupCache.set(group.id, group);
      out[id] = group;
    }
    return out;
  }

  public async create(options: { name?: string; members: readonly string[] }): Promise<Group> {
    ensureConnected(this.deps.transport);
    const members = requireUniqueNonEmptyIds(options.members, 'members');

    const created = await this.deps.executor.execute(
      () => this.deps.transport.createGroup({ name: options.name, members }),
      { operation: 'groups.create', idempotent: false },
    );
    this.deps.registry.registerGroup(created.groupId);
    return this.get(created.groupId, { skipCache: true });
  }

  public async getMembers(memberIds: readonly string[]): Promise<GroupMember[]> {
    ensureConnected(this.deps.transport);
    const ids = requireUniqueNonEmptyIds(memberIds, 'memberIds');

    const profiles = await this.deps.executor.execute(
      () => this.deps.transport.getGroupMembersInfo(ids),
      { operation: 'groups.getMembers', idempotent: true },
    );
    return Object.values(profiles).map(mapGroupMember);
  }

  public async addMembers(groupId: string, userIds: readonly string[]): Promise<void> {
    ensureConnected(this.deps.transport);
    const id = requireNonEmpty(groupId, 'groupId');
    const ids = requireUniqueNonEmptyIds(userIds, 'userIds');
    await this.deps.executor.execute(() => this.deps.transport.addGroupMembers(id, ids), {
      operation: 'groups.addMembers',
      idempotent: true,
    });
    this.deps.groupCache.delete(id);
  }

  public async removeMembers(groupId: string, userIds: readonly string[]): Promise<void> {
    ensureConnected(this.deps.transport);
    const id = requireNonEmpty(groupId, 'groupId');
    const ids = requireUniqueNonEmptyIds(userIds, 'userIds');
    await this.deps.executor.execute(() => this.deps.transport.removeGroupMembers(id, ids), {
      operation: 'groups.removeMembers',
      idempotent: true,
    });
    this.deps.groupCache.delete(id);
  }

  public async rename(groupId: string, name: string): Promise<void> {
    ensureConnected(this.deps.transport);
    const id = requireNonEmpty(groupId, 'groupId');
    const trimmedName = requireNonEmpty(name, 'name');
    await this.deps.executor.execute(() => this.deps.transport.renameGroup(id, trimmedName), {
      operation: 'groups.rename',
      idempotent: true,
    });
    this.deps.groupCache.delete(id);
  }

  public async leave(groupId: string): Promise<void> {
    ensureConnected(this.deps.transport);
    const id = requireNonEmpty(groupId, 'groupId');
    await this.deps.executor.execute(() => this.deps.transport.leaveGroup(id), {
      operation: 'groups.leave',
      idempotent: false,
    });
    this.deps.groupCache.delete(id);
  }
}

export class ConversationsService {
  constructor(private readonly deps: ServiceDeps) {}

  public async get(id: string, threadType?: ThreadType): Promise<Conversation> {
    ensureConnected(this.deps.transport);
    const cleaned = requireNonEmpty(id, 'conversationId');
    const resolved = await resolveThreadTarget(this.deps, cleaned, threadType);
    return new Conversation(resolved.threadId, resolved.threadType, this.deps.actions);
  }

  public async getMessages(
    conversationId: string,
    options?: number | GetMessagesOptions,
  ): Promise<MessagePage> {
    ensureConnected(this.deps.transport);
    const id = requireNonEmpty(conversationId, 'conversationId');
    const normalized: GetMessagesOptions =
      typeof options === 'number' ? { count: options } : (options ?? {});
    assertOptionalPositiveInt(normalized.count, 'count');

    const res = await this.deps.executor.execute(
      () => this.deps.transport.getGroupChatHistory(id, normalized),
      { operation: 'conversations.getMessages', idempotent: true },
    );
    return {
      items: res.messages.map((raw) => new Message(mapMessageData(raw), this.deps.actions)),
      hasMore: res.hasMore,
      nextCursor: res.nextCursor,
      isOld: res.isOld,
    };
  }

  public requestOldMessages(threadType: ThreadType, lastMsgId?: string | null): void {
    ensureConnected(this.deps.transport);
    if (typeof this.deps.transport.requestOldMessages !== 'function') {
      throw new ValidationError('Current transport does not support requestOldMessages');
    }
    this.deps.transport.requestOldMessages(threadType, lastMsgId ?? null);
  }

  public async getPinned(): Promise<PinnedConversations> {
    ensureConnected(this.deps.transport);
    return this.deps.executor.execute(() => this.deps.transport.getPinnedConversations(), {
      operation: 'conversations.getPinned',
      idempotent: true,
    });
  }

  public async getUnread(): Promise<UnreadMarks> {
    ensureConnected(this.deps.transport);
    return this.deps.executor.execute(() => this.deps.transport.getUnreadMarks(), {
      operation: 'conversations.getUnread',
      idempotent: true,
    });
  }

  public async pin(
    target: ThreadTarget,
    pinned = true,
    explicitType?: ThreadType,
  ): Promise<void> {
    ensureConnected(this.deps.transport);
    const { threadId, threadType } = await resolveThreadTarget(this.deps, target, explicitType);
    await this.deps.executor.execute(
      () => this.deps.transport.setPinnedConversations([threadId], pinned, threadType),
      { operation: 'conversations.pin', idempotent: true },
    );
  }

  public async mute(
    target: ThreadTarget,
    durationSeconds: number,
    explicitType?: ThreadType,
  ): Promise<void> {
    ensureConnected(this.deps.transport);
    const { threadId, threadType } = await resolveThreadTarget(this.deps, target, explicitType);
    await this.deps.executor.execute(
      () => this.deps.transport.setMute(threadId, durationSeconds, threadType),
      { operation: 'conversations.mute', idempotent: true },
    );
  }

  public async sendTyping(target: ThreadTarget, explicitType?: ThreadType): Promise<void> {
    ensureConnected(this.deps.transport);
    const { threadId, threadType } = await resolveThreadTarget(this.deps, target, explicitType);
    await this.deps.executor.execute(() => this.deps.transport.sendTyping(threadId, threadType), {
      operation: 'conversations.sendTyping',
      idempotent: true,
    });
  }
}

export class MessagesService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Unified message sender. Automatically resolves threadType from target or Group ID cache.
   */
  public async send(
    target: ThreadTarget,
    content: SendMessageContent,
    explicitType?: ThreadType,
  ): Promise<SendMessageReceipt> {
    ensureConnected(this.deps.transport);

    const payload: SendMessagePayload =
      typeof content === 'string' ? { text: content } : content;

    const hasMedia = Boolean(
      payload.attachment ||
        (payload.attachments && payload.attachments.length > 0) ||
        payload.link ||
        payload.sticker ||
        payload.voice ||
        payload.video,
    );
    if (!payload.text && !hasMedia) {
      throw new ValidationError('Message payload must contain text or media/link/sticker');
    }

    const resolved = await resolveThreadTarget(
      this.deps,
      target,
      explicitType ?? payload.threadType,
    );

    return this.deps.executor.execute(
      () => this.deps.transport.sendMessage(resolved.threadId, payload, resolved.threadType),
      { operation: 'messages.send', idempotent: false },
    );
  }

  public async reply(message: Message, content: SendMessageContent): Promise<SendMessageReceipt> {
    const payload: SendMessagePayload =
      typeof content === 'string'
        ? { text: content, replyTo: message }
        : { ...content, replyTo: message };
    return this.send(message, payload, message.threadType);
  }

  public async react(message: Message, reaction: Reaction | string): Promise<void> {
    ensureConnected(this.deps.transport);
    await this.deps.executor.execute(() => this.deps.transport.addReaction(message, reaction), {
      operation: 'messages.react',
      idempotent: true,
    });
  }

  public async undo(message: Message): Promise<void> {
    ensureConnected(this.deps.transport);
    await this.deps.executor.execute(() => this.deps.transport.undoMessage(message), {
      operation: 'messages.undo',
      idempotent: true,
    });
  }

  public async delete(message: Message, onlyMe = true): Promise<void> {
    ensureConnected(this.deps.transport);
    await this.deps.executor.execute(() => this.deps.transport.deleteMessage(message, onlyMe), {
      operation: 'messages.delete',
      idempotent: true,
    });
  }

  public async markSeen(messages: readonly Message[]): Promise<void> {
    ensureConnected(this.deps.transport);
    if (messages.length === 0) throw new ValidationError('markSeen requires at least one message');
    const threadType = messages[0]!.threadType;
    await this.deps.executor.execute(() => this.deps.transport.markSeen(messages, threadType), {
      operation: 'messages.markSeen',
      idempotent: true,
    });
  }
}

export class MediaService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly messages: MessagesService,
  ) {}

  public async upload(
    target: ThreadTarget,
    sources: MediaInput | readonly MediaInput[],
    explicitType?: ThreadType,
  ): Promise<UploadedMedia[]> {
    ensureConnected(this.deps.transport);
    const list = Array.isArray(sources) ? sources : [sources];
    if (list.length === 0) throw new ValidationError('upload requires at least one media item');

    const { threadId, threadType } = await resolveThreadTarget(this.deps, target, explicitType);

    const raw = await this.deps.executor.execute(
      () => this.deps.transport.uploadAttachment(list, threadId, threadType),
      { operation: 'media.upload', idempotent: false },
    );
    return raw.map(mapUploadedMedia);
  }

  public send(
    target: ThreadTarget,
    media: MediaInput | readonly MediaInput[],
    caption?: string,
  ): Promise<SendMessageReceipt> {
    const attachments = Array.isArray(media) ? media : [media];
    return this.messages.send(target, { text: caption, attachments });
  }
}

export class SettingsService {
  constructor(private readonly deps: ServiceDeps) {}

  public async get(): Promise<AccountSettings> {
    ensureConnected(this.deps.transport);
    const raw = await this.deps.executor.execute(() => this.deps.transport.getAccountSettings(), {
      operation: 'settings.get',
      idempotent: true,
    });
    return mapAccountSettings(raw);
  }

  public async updateLanguage(lang: 'VI' | 'EN'): Promise<void> {
    ensureConnected(this.deps.transport);
    await this.deps.executor.execute(() => this.deps.transport.updateLanguage(lang), {
      operation: 'settings.updateLanguage',
      idempotent: true,
    });
  }
}
