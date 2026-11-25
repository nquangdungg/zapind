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

function ensureConnected(transport: TransportAdapter): void {
  if (!transport.isConnected()) {
    throw new AuthenticationError();
  }
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
    if (!patch.name.trim()) throw new ValidationError('name must not be empty');
    await this.deps.executor.execute(
      () =>
        this.deps.transport.updateProfile({
          name: patch.name.trim(),
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

  public async get(userId: string, options?: { skipCache?: boolean }): Promise<User | null> {
    ensureConnected(this.deps.transport);
    const id = userId.trim();
    if (!id) throw new ValidationError('userId must be a non-empty string');

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

  public async getMany(userIds: readonly string[]): Promise<Record<string, User>> {
    ensureConnected(this.deps.transport);
    const ids = userIds.map((u) => u.trim()).filter(Boolean);
    if (ids.length === 0) throw new ValidationError('userIds must not be empty');

    const rawMap = await this.deps.executor.execute(() => this.deps.transport.getUserInfo(ids), {
      operation: 'users.getMany',
      idempotent: true,
    });
    const out: Record<string, User> = {};
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
    const phone = phoneNumber.trim();
    if (!phone) throw new ValidationError('phoneNumber must be a non-empty string');

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
    const cleaned = username.trim();
    if (!cleaned) throw new ValidationError('username must be a non-empty string');

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
    const id = userId.trim();
    if (!id) throw new ValidationError('userId must be a non-empty string');

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
    if (!userId.trim()) throw new ValidationError('userId must not be empty');
    await this.deps.executor.execute(
      () => this.deps.transport.sendFriendRequest(userId.trim(), message),
      { operation: 'contacts.sendRequest', idempotent: false },
    );
  }

  public async acceptRequest(userId: string): Promise<void> {
    ensureConnected(this.deps.transport);
    await this.deps.executor.execute(() => this.deps.transport.acceptFriendRequest(userId.trim()), {
      operation: 'contacts.acceptRequest',
      idempotent: true,
    });
  }

  public async rejectRequest(userId: string): Promise<void> {
    ensureConnected(this.deps.transport);
    await this.deps.executor.execute(() => this.deps.transport.rejectFriendRequest(userId.trim()), {
      operation: 'contacts.rejectRequest',
      idempotent: true,
    });
  }

  public async remove(userId: string): Promise<void> {
    ensureConnected(this.deps.transport);
    await this.deps.executor.execute(() => this.deps.transport.removeFriend(userId.trim()), {
      operation: 'contacts.remove',
      idempotent: true,
    });
  }

  public async block(userId: string): Promise<void> {
    ensureConnected(this.deps.transport);
    await this.deps.executor.execute(() => this.deps.transport.blockUser(userId.trim()), {
      operation: 'contacts.block',
      idempotent: true,
    });
  }

  public async unblock(userId: string): Promise<void> {
    ensureConnected(this.deps.transport);
    await this.deps.executor.execute(() => this.deps.transport.unblockUser(userId.trim()), {
      operation: 'contacts.unblock',
      idempotent: true,
    });
  }

  public async setAlias(userId: string, alias: string): Promise<void> {
    ensureConnected(this.deps.transport);
    await this.deps.executor.execute(
      () => this.deps.transport.setFriendAlias(userId.trim(), alias),
      { operation: 'contacts.setAlias', idempotent: true },
    );
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

  public async get(groupId: string, options?: { skipCache?: boolean }): Promise<Group> {
    ensureConnected(this.deps.transport);
    const id = groupId.trim();
    if (!id) throw new ValidationError('groupId must be a non-empty string');

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

  public async getMany(groupIds: readonly string[]): Promise<Record<string, Group>> {
    ensureConnected(this.deps.transport);
    const ids = groupIds.map((g) => g.trim()).filter(Boolean);
    if (ids.length === 0) throw new ValidationError('groupIds must not be empty');

    const map = await this.deps.executor.execute(() => this.deps.transport.getGroupInfo(ids), {
      operation: 'groups.getMany',
      idempotent: true,
    });
    const out: Record<string, Group> = {};
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
    const members = options.members.map((m) => m.trim()).filter(Boolean);
    if (members.length === 0) throw new ValidationError('members must contain at least one userId');

    const created = await this.deps.executor.execute(
      () => this.deps.transport.createGroup({ name: options.name, members }),
      { operation: 'groups.create', idempotent: false },
    );
    this.deps.registry.registerGroup(created.groupId);
    return this.get(created.groupId, { skipCache: true });
  }

  public async getMembers(memberIds: readonly string[]): Promise<GroupMember[]> {
    ensureConnected(this.deps.transport);
    const ids = memberIds.map((m) => m.trim()).filter(Boolean);
    if (ids.length === 0) throw new ValidationError('memberIds must not be empty');

    const profiles = await this.deps.executor.execute(
      () => this.deps.transport.getGroupMembersInfo(ids),
      { operation: 'groups.getMembers', idempotent: true },
    );
    return Object.values(profiles).map(mapGroupMember);
  }

  public async addMembers(groupId: string, userIds: readonly string[]): Promise<void> {
    ensureConnected(this.deps.transport);
    const id = groupId.trim();
    const ids = userIds.map((u) => u.trim()).filter(Boolean);
    if (!id || ids.length === 0) throw new ValidationError('groupId and userIds are required');
    await this.deps.executor.execute(() => this.deps.transport.addGroupMembers(id, ids), {
      operation: 'groups.addMembers',
      idempotent: true,
    });
    this.deps.groupCache.delete(id);
  }

  public async removeMembers(groupId: string, userIds: readonly string[]): Promise<void> {
    ensureConnected(this.deps.transport);
    const id = groupId.trim();
    const ids = userIds.map((u) => u.trim()).filter(Boolean);
    if (!id || ids.length === 0) throw new ValidationError('groupId and userIds are required');
    await this.deps.executor.execute(() => this.deps.transport.removeGroupMembers(id, ids), {
      operation: 'groups.removeMembers',
      idempotent: true,
    });
    this.deps.groupCache.delete(id);
  }

  public async rename(groupId: string, name: string): Promise<void> {
    ensureConnected(this.deps.transport);
    const id = groupId.trim();
    if (!id || !name.trim()) throw new ValidationError('groupId and name are required');
    await this.deps.executor.execute(() => this.deps.transport.renameGroup(id, name.trim()), {
      operation: 'groups.rename',
      idempotent: true,
    });
    this.deps.groupCache.delete(id);
  }

  public async leave(groupId: string): Promise<void> {
    ensureConnected(this.deps.transport);
    const id = groupId.trim();
    if (!id) throw new ValidationError('groupId is required');
    await this.deps.executor.execute(() => this.deps.transport.leaveGroup(id), {
      operation: 'groups.leave',
      idempotent: false,
    });
    this.deps.groupCache.delete(id);
  }
}

export class ConversationsService {
  constructor(private readonly deps: ServiceDeps) {}

  private fetchGroupIds = async (): Promise<string[]> => {
    const map = await this.deps.transport.getAllGroups();
    return Object.keys(map);
  };

  public async get(id: string, threadType?: ThreadType): Promise<Conversation> {
    ensureConnected(this.deps.transport);
    if (!id.trim()) throw new ValidationError('conversation id must not be empty');
    const resolved = await this.deps.registry.resolve(id, threadType, this.fetchGroupIds);
    return new Conversation(resolved.threadId, resolved.threadType, this.deps.actions);
  }

  public async getMessages(conversationId: string, count?: number): Promise<MessagePage> {
    ensureConnected(this.deps.transport);
    const id = conversationId.trim();
    if (!id) throw new ValidationError('conversationId must not be empty');
    const res = await this.deps.executor.execute(
      () => this.deps.transport.getGroupChatHistory(id, count),
      { operation: 'conversations.getMessages', idempotent: true },
    );
    return {
      items: res.messages.map((raw) => new Message(mapMessageData(raw), this.deps.actions)),
      hasMore: res.hasMore,
      nextCursor: res.nextCursor,
    };
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

  public async pin(target: ThreadTarget, pinned = true): Promise<void> {
    ensureConnected(this.deps.transport);
    const { threadId, threadType } = await this.deps.registry.resolve(
      target,
      undefined,
      this.fetchGroupIds,
    );
    await this.deps.executor.execute(
      () => this.deps.transport.setPinnedConversations([threadId], pinned, threadType),
      { operation: 'conversations.pin', idempotent: true },
    );
  }

  public async mute(target: ThreadTarget, durationSeconds: number): Promise<void> {
    ensureConnected(this.deps.transport);
    const { threadId, threadType } = await this.deps.registry.resolve(
      target,
      undefined,
      this.fetchGroupIds,
    );
    await this.deps.executor.execute(
      () => this.deps.transport.setMute(threadId, durationSeconds, threadType),
      { operation: 'conversations.mute', idempotent: true },
    );
  }

  public async sendTyping(target: ThreadTarget): Promise<void> {
    ensureConnected(this.deps.transport);
    const { threadId, threadType } = await this.deps.registry.resolve(
      target,
      undefined,
      this.fetchGroupIds,
    );
    await this.deps.executor.execute(() => this.deps.transport.sendTyping(threadId, threadType), {
      operation: 'conversations.sendTyping',
      idempotent: true,
    });
  }
}

export class MessagesService {
  constructor(private readonly deps: ServiceDeps) {}

  private fetchGroupIds = async (): Promise<string[]> => {
    const map = await this.deps.transport.getAllGroups();
    return Object.keys(map);
  };

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

    const targetLike =
      target instanceof Message
        ? { id: target.threadId, threadType: target.threadType }
        : target;

    const resolved = await this.deps.registry.resolve(
      targetLike,
      explicitType ?? payload.threadType,
      this.fetchGroupIds,
    );
    if (!resolved.threadId) {
      throw new ValidationError('Target threadId must be a non-empty string');
    }

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

  private fetchGroupIds = async (): Promise<string[]> => {
    const map = await this.deps.transport.getAllGroups();
    return Object.keys(map);
  };

  public async upload(
    target: ThreadTarget,
    sources: MediaInput | readonly MediaInput[],
    explicitType?: ThreadType,
  ): Promise<UploadedMedia[]> {
    ensureConnected(this.deps.transport);
    const list = Array.isArray(sources) ? sources : [sources];
    if (list.length === 0) throw new ValidationError('upload requires at least one media item');

    const targetLike =
      target instanceof Message
        ? { id: target.threadId, threadType: target.threadType }
        : target;
    const { threadId, threadType } = await this.deps.registry.resolve(
      targetLike,
      explicitType,
      this.fetchGroupIds,
    );

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
