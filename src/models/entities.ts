import { ThreadType, type Gender, type GroupType, type Reaction, type TextStyle, type Urgency } from './enums.js';

export type MediaInput =
  | string
  | {
      readonly data: Buffer;
      readonly filename: `${string}.${string}`;
      readonly totalSize?: number;
      readonly width?: number;
      readonly height?: number;
    };

export interface UploadedMedia {
  readonly id: string;
  readonly kind: 'image' | 'video' | 'file';
  readonly url: string;
  readonly hdUrl?: string;
  readonly thumbnailUrl?: string;
  readonly fileName?: string;
  readonly totalSize: number;
  readonly width?: number;
  readonly height?: number;
  readonly checksum?: string;
}

export interface ImageMetadata {
  readonly width: number;
  readonly height: number;
  readonly size: number;
}

export type ImageMetadataGetter = (filePath: string) => Promise<ImageMetadata | null>;

export type AttachmentKind = 'image' | 'video' | 'file' | 'audio' | 'link' | 'sticker' | 'other';

export interface Attachment {
  readonly kind: AttachmentKind;
  readonly url?: string;
  readonly thumbnailUrl?: string;
  readonly title?: string;
  readonly description?: string;
}

export interface Mention {
  readonly userId: string;
  readonly pos: number;
  readonly len: number;
}

export interface MessageStyle {
  readonly start: number;
  readonly len: number;
  readonly style: TextStyle;
  readonly indentSize?: number;
}

export interface MessageQuote {
  readonly ownerId: string;
  readonly clientMsgId: string;
  readonly globalMsgId: string;
  readonly text: string;
  readonly timestamp: Date;
}

export interface SendMessagePayload {
  readonly text?: string;
  readonly attachment?: MediaInput;
  readonly attachments?: readonly MediaInput[];
  readonly replyTo?: Message;
  readonly mentions?: readonly Mention[];
  readonly styles?: readonly MessageStyle[];
  readonly urgency?: Urgency;
  readonly ttlMs?: number;
  readonly link?: { readonly url: string; readonly title?: string };
  readonly sticker?: { readonly id: number; readonly cateId: number; readonly type: number };
  readonly voice?: { readonly voiceUrl: string; readonly ttlMs?: number };
  readonly video?: {
    readonly msg?: string;
    readonly videoUrl: string;
    readonly thumbnailUrl: string;
    readonly duration?: number;
    readonly width?: number;
    readonly height?: number;
    readonly ttlMs?: number;
  };
  /** Optional explicit override; normally auto-resolved by Zapid. */
  readonly threadType?: ThreadType;
}

export type SendMessageContent = string | SendMessagePayload;

export interface SendMessageReceipt {
  readonly messageId: string | null;
  readonly attachmentMessageIds: readonly string[];
}

export interface MessagePage {
  readonly items: readonly Message[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface MessageSenderRef {
  readonly id: string;
  readonly name?: string;
}

export interface GroupSummary {
  readonly id: string;
  readonly version: string;
}

export interface GroupSettings {
  readonly blockName: boolean;
  readonly signAdminMsg: boolean;
  readonly addMemberOnly: boolean;
  readonly setTopicOnly: boolean;
  readonly enableMsgHistory: boolean;
  readonly joinApprovalRequired: boolean;
  readonly lockCreatePost: boolean;
  readonly lockCreatePoll: boolean;
  readonly lockSendMsg: boolean;
  readonly lockViewMember: boolean;
}

export interface GroupMember {
  readonly id: string;
  readonly displayName: string;
  readonly zaloName: string;
  readonly avatarUrl: string;
  readonly globalId?: string;
  readonly accountStatus: number;
}

export interface OnlineStatus {
  readonly userId: string;
  readonly status: string;
}

export interface LastOnlineInfo {
  readonly userId: string;
  readonly lastOnlineAt: Date | null;
  readonly showOnlineStatus: boolean;
}

export interface AccountSettings {
  readonly showOnlineStatus: boolean;
  readonly displaySeenStatus: boolean;
  readonly addFriendViaPhone: boolean;
  readonly addFriendViaContact: boolean;
  readonly addFriendViaGroup: boolean;
  readonly addFriendViaQR: boolean;
  readonly acceptStrangerCall: boolean;
  readonly twoFactorEnabled: boolean;
}

export interface PinnedConversations {
  readonly conversationIds: readonly string[];
  readonly version: number;
}

export interface UnreadMark {
  readonly threadId: string;
  readonly threadType: ThreadType;
  readonly clientMsgId: string;
  readonly senderId: string;
  readonly timestamp: Date;
}

export interface UnreadMarks {
  readonly groups: readonly UnreadMark[];
  readonly users: readonly UnreadMark[];
}

/**
 * Internal action bridge injected into contextual domain models.
 */
export interface ModelActions {
  sendMessage(
    targetId: string,
    content: SendMessageContent,
    threadType: ThreadType,
  ): Promise<SendMessageReceipt>;
  replyMessage(message: Message, content: SendMessageContent): Promise<SendMessageReceipt>;
  reactMessage(message: Message, reaction: Reaction | string): Promise<void>;
  undoMessage(message: Message): Promise<void>;
  deleteMessage(message: Message, onlyMe?: boolean): Promise<void>;
  markSeen(messages: readonly Message[]): Promise<void>;
  getGroupMessages(groupId: string, count?: number): Promise<MessagePage>;
  sendTyping(threadId: string, threadType: ThreadType): Promise<void>;
  pinConversation(threadId: string, pinned: boolean, threadType: ThreadType): Promise<void>;
  muteConversation(threadId: string, durationSeconds: number, threadType: ThreadType): Promise<void>;
  sendFriendRequest(userId: string, message: string): Promise<void>;
  blockUser(userId: string): Promise<void>;
  unblockUser(userId: string): Promise<void>;
  setFriendAlias(userId: string, alias: string): Promise<void>;
  removeFriend(userId: string): Promise<void>;
  addGroupMembers(groupId: string, userIds: readonly string[]): Promise<void>;
  removeGroupMembers(groupId: string, userIds: readonly string[]): Promise<void>;
  renameGroup(groupId: string, name: string): Promise<void>;
  leaveGroup(groupId: string): Promise<void>;
}

export interface UserData {
  readonly id: string;
  readonly username?: string;
  readonly displayName: string;
  readonly zaloName: string;
  readonly avatarUrl: string;
  readonly coverUrl?: string;
  readonly gender: Gender;
  readonly birthday?: string;
  readonly statusMessage?: string;
  readonly phoneNumber?: string;
  readonly isFriend: boolean;
  readonly isBlocked: boolean;
  readonly lastActiveAt?: Date;
}

/**
 * Contextual User model with direct messaging and relationship actions.
 */
export class User implements UserData {
  public readonly threadType = ThreadType.User;
  public readonly id: string;
  public readonly username?: string;
  public readonly displayName: string;
  public readonly zaloName: string;
  public readonly avatarUrl: string;
  public readonly coverUrl?: string;
  public readonly gender: Gender;
  public readonly birthday?: string;
  public readonly statusMessage?: string;
  public readonly phoneNumber?: string;
  public readonly isFriend: boolean;
  public readonly isBlocked: boolean;
  public readonly lastActiveAt?: Date;

  constructor(
    data: UserData,
    protected readonly actions: ModelActions,
  ) {
    this.id = data.id;
    this.username = data.username;
    this.displayName = data.displayName;
    this.zaloName = data.zaloName;
    this.avatarUrl = data.avatarUrl;
    this.coverUrl = data.coverUrl;
    this.gender = data.gender;
    this.birthday = data.birthday;
    this.statusMessage = data.statusMessage;
    this.phoneNumber = data.phoneNumber;
    this.isFriend = data.isFriend;
    this.isBlocked = data.isBlocked;
    this.lastActiveAt = data.lastActiveAt;
  }

  /** Send a direct message to this user without passing threadType. */
  public send(content: SendMessageContent): Promise<SendMessageReceipt> {
    return this.actions.sendMessage(this.id, content, ThreadType.User);
  }

  public sendFriendRequest(message = 'Hello!'): Promise<void> {
    return this.actions.sendFriendRequest(this.id, message);
  }

  public block(): Promise<void> {
    return this.actions.blockUser(this.id);
  }

  public unblock(): Promise<void> {
    return this.actions.unblockUser(this.id);
  }
}

export interface ProfileData extends UserData {
  readonly globalId?: string;
  readonly isBusiness: boolean;
  readonly createdAt?: Date;
}

export class Profile extends User {
  public readonly globalId?: string;
  public readonly isBusiness: boolean;
  public readonly createdAt?: Date;

  constructor(data: ProfileData, actions: ModelActions) {
    super(data, actions);
    this.globalId = data.globalId;
    this.isBusiness = data.isBusiness;
    this.createdAt = data.createdAt;
  }
}

export interface ContactData extends UserData {
  readonly alias?: string;
}

export class Contact extends User {
  public readonly alias?: string;

  constructor(data: ContactData, actions: ModelActions) {
    super(data, actions);
    this.alias = data.alias;
  }

  public setAlias(alias: string): Promise<void> {
    return this.actions.setFriendAlias(this.id, alias);
  }

  public remove(): Promise<void> {
    return this.actions.removeFriend(this.id);
  }
}

export interface GroupData {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly type: GroupType;
  readonly creatorId: string;
  readonly avatarUrl: string;
  readonly fullAvatarUrl?: string;
  readonly memberCount: number;
  readonly maxMembers: number;
  readonly memberIds: readonly string[];
  readonly adminIds: readonly string[];
  readonly isE2EE: boolean;
  readonly createdAt?: Date;
  readonly settings?: GroupSettings;
}

/**
 * Contextual Group model with direct messaging and group management actions.
 */
export class Group implements GroupData {
  public readonly threadType = ThreadType.Group;
  public readonly id: string;
  public readonly name: string;
  public readonly description: string;
  public readonly type: GroupType;
  public readonly creatorId: string;
  public readonly avatarUrl: string;
  public readonly fullAvatarUrl?: string;
  public readonly memberCount: number;
  public readonly maxMembers: number;
  public readonly memberIds: readonly string[];
  public readonly adminIds: readonly string[];
  public readonly isE2EE: boolean;
  public readonly createdAt?: Date;
  public readonly settings?: GroupSettings;

  constructor(
    data: GroupData,
    private readonly actions: ModelActions,
  ) {
    this.id = data.id;
    this.name = data.name;
    this.description = data.description;
    this.type = data.type;
    this.creatorId = data.creatorId;
    this.avatarUrl = data.avatarUrl;
    this.fullAvatarUrl = data.fullAvatarUrl;
    this.memberCount = data.memberCount;
    this.maxMembers = data.maxMembers;
    this.memberIds = data.memberIds;
    this.adminIds = data.adminIds;
    this.isE2EE = data.isE2EE;
    this.createdAt = data.createdAt;
    this.settings = data.settings;
  }

  /** Send a message to this group without passing threadType. */
  public send(content: SendMessageContent): Promise<SendMessageReceipt> {
    return this.actions.sendMessage(this.id, content, ThreadType.Group);
  }

  public getMessages(count?: number): Promise<MessagePage> {
    return this.actions.getGroupMessages(this.id, count);
  }

  public addMembers(userIds: readonly string[]): Promise<void> {
    return this.actions.addGroupMembers(this.id, userIds);
  }

  public removeMembers(userIds: readonly string[]): Promise<void> {
    return this.actions.removeGroupMembers(this.id, userIds);
  }

  public rename(name: string): Promise<void> {
    return this.actions.renameGroup(this.id, name);
  }

  public leave(): Promise<void> {
    return this.actions.leaveGroup(this.id);
  }
}

/**
 * Contextual Conversation handle representing either a DM or Group thread.
 */
export class Conversation {
  public readonly id: string;
  public readonly threadType: ThreadType;

  constructor(
    id: string,
    threadType: ThreadType,
    private readonly actions: ModelActions,
  ) {
    this.id = id;
    this.threadType = threadType;
  }

  public get isGroup(): boolean {
    return this.threadType === ThreadType.Group;
  }

  public send(content: SendMessageContent): Promise<SendMessageReceipt> {
    return this.actions.sendMessage(this.id, content, this.threadType);
  }

  public getMessages(count?: number): Promise<MessagePage> {
    return this.actions.getGroupMessages(this.id, count);
  }

  public sendTyping(): Promise<void> {
    return this.actions.sendTyping(this.id, this.threadType);
  }

  public pin(pinned = true): Promise<void> {
    return this.actions.pinConversation(this.id, pinned, this.threadType);
  }

  public mute(durationSeconds: number): Promise<void> {
    return this.actions.muteConversation(this.id, durationSeconds, this.threadType);
  }
}

export interface MessageData {
  readonly id: string;
  readonly clientMsgId: string;
  readonly threadId: string;
  readonly threadType: ThreadType;
  readonly sender: MessageSenderRef;
  readonly recipientId: string;
  readonly isSelf: boolean;
  readonly msgType: string;
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly mentions: readonly Mention[];
  readonly replyTo?: MessageQuote;
  readonly timestamp: Date;
  readonly ttlMs: number;
  readonly st: number;
  readonly at: number;
  readonly cmd: number;
}

/**
 * Normalized contextual Message model.
 */
export class Message implements MessageData {
  public readonly id: string;
  public readonly clientMsgId: string;
  public readonly threadId: string;
  public readonly threadType: ThreadType;
  public readonly sender: MessageSenderRef;
  public readonly recipientId: string;
  public readonly isSelf: boolean;
  public readonly msgType: string;
  public readonly text: string;
  public readonly attachments: readonly Attachment[];
  public readonly mentions: readonly Mention[];
  public readonly replyTo?: MessageQuote;
  public readonly timestamp: Date;
  public readonly ttlMs: number;
  public readonly st: number;
  public readonly at: number;
  public readonly cmd: number;
  public readonly conversation: Conversation;

  constructor(
    data: MessageData,
    private readonly actions: ModelActions,
  ) {
    this.id = data.id;
    this.clientMsgId = data.clientMsgId;
    this.threadId = data.threadId;
    this.threadType = data.threadType;
    this.sender = data.sender;
    this.recipientId = data.recipientId;
    this.isSelf = data.isSelf;
    this.msgType = data.msgType;
    this.text = data.text;
    this.attachments = data.attachments;
    this.mentions = data.mentions;
    this.replyTo = data.replyTo;
    this.timestamp = data.timestamp;
    this.ttlMs = data.ttlMs;
    this.st = data.st;
    this.at = data.at;
    this.cmd = data.cmd;
    this.conversation = new Conversation(data.threadId, data.threadType, actions);
  }

  public get isGroup(): boolean {
    return this.threadType === ThreadType.Group;
  }

  /** Reply directly to this message (automatically sets quote and threadType). */
  public reply(content: SendMessageContent): Promise<SendMessageReceipt> {
    return this.actions.replyMessage(this, content);
  }

  /** React to this message without passing threadId or threadType. */
  public react(reaction: Reaction | string): Promise<void> {
    return this.actions.reactMessage(this, reaction);
  }

  public undo(): Promise<void> {
    return this.actions.undoMessage(this);
  }

  public delete(onlyMe = true): Promise<void> {
    return this.actions.deleteMessage(this, onlyMe);
  }

  public markSeen(): Promise<void> {
    return this.actions.markSeen([this]);
  }
}

export type ThreadTarget = string | User | Contact | Group | Conversation | Message;
