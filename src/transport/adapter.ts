import type {
  ConnectionEvent,
  GroupUpdateEvent,
  ImageMetadataGetter,
  MediaInput,
  Message,
  PinnedConversations,
  QRCodeData,
  QRScannedData,
  Reaction,
  ReactionEvent,
  SeenEvent,
  SendMessagePayload,
  SendMessageReceipt,
  SessionCredentials,
  ThreadType,
  TypingEvent,
  UndoEvent,
  UnreadMarks,
  UserUpdateEvent,
} from '../models/index.js';
import type {
  RawGroupInfoLike,
  RawGroupMemberLike,
  RawLastOnlineResponse,
  RawMessageEnvelope,
  RawOnlineEntry,
  RawUploadedMediaLike,
  RawUserLike,
  RawUserSetting,
} from '../mappers/index.js';

export interface TransportQRCallbacks {
  onQRCode?: (qr: QRCodeData) => void;
  onScanned?: (info: QRScannedData) => void;
  onExpired?: () => void;
  onDeclined?: () => void;
  onCredentials?: (creds: SessionCredentials) => void;
}

export interface TransportListenerHandlers {
  onMessage: (raw: RawMessageEnvelope) => void;
  onOldMessages?: (raws: readonly RawMessageEnvelope[], threadType: ThreadType) => void;
  onReaction: (evt: ReactionEvent) => void;
  onGroupUpdate: (evt: GroupUpdateEvent) => void;
  onUserUpdate: (evt: UserUpdateEvent) => void;
  onTyping: (evt: TypingEvent) => void;
  onSeen: (evt: SeenEvent) => void;
  onUndo: (evt: UndoEvent) => void;
  onConnected: (evt: ConnectionEvent) => void;
  onDisconnected: (evt: ConnectionEvent) => void;
  onError: (err: unknown) => void;
}

export interface TransportAdapter {
  loginWithCredentials(credentials: SessionCredentials): Promise<void>;
  loginWithQR(
    options: { userAgent: string; language: string; signal?: AbortSignal },
    callbacks: TransportQRCallbacks,
  ): Promise<SessionCredentials>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getOwnId(): string;
  getRawApi(): unknown;

  fetchAccountInfo(): Promise<RawUserLike | null>;
  updateProfile(patch: { name: string; dob: `${number}-${number}-${number}`; gender: 0 | 1 }): Promise<void>;
  updateBio(bio: string): Promise<void>;
  keepAlive(): Promise<{ configVersion: number }>;

  getUserInfo(userIds: string | string[]): Promise<Record<string, RawUserLike>>;
  findUserByPhone(phone: string): Promise<RawUserLike | null>;
  findUserByUsername(username: string): Promise<RawUserLike | null>;
  getLastOnline(userId: string): Promise<RawLastOnlineResponse>;

  getAllFriends(count?: number, page?: number): Promise<RawUserLike[]>;
  sendFriendRequest(userId: string, message: string): Promise<void>;
  acceptFriendRequest(userId: string): Promise<void>;
  rejectFriendRequest(userId: string): Promise<void>;
  removeFriend(userId: string): Promise<void>;
  blockUser(userId: string): Promise<void>;
  unblockUser(userId: string): Promise<void>;
  setFriendAlias(userId: string, alias: string): Promise<void>;
  getOnlineFriends(): Promise<RawOnlineEntry[]>;

  getAllGroups(): Promise<Record<string, string>>;
  getGroupInfo(groupIds: string | string[]): Promise<Record<string, RawGroupInfoLike>>;
  getGroupMembersInfo(memberIds: string | string[]): Promise<Record<string, RawGroupMemberLike>>;
  createGroup(options: { name?: string; members: string[] }): Promise<{ groupId: string }>;
  addGroupMembers(groupId: string, userIds: string[]): Promise<void>;
  removeGroupMembers(groupId: string, userIds: string[]): Promise<void>;
  renameGroup(groupId: string, name: string): Promise<void>;
  leaveGroup(groupId: string): Promise<void>;

  getPinnedConversations(): Promise<PinnedConversations>;
  getUnreadMarks(): Promise<UnreadMarks>;
  setPinnedConversations(ids: string[], pinned: boolean, threadType: ThreadType): Promise<void>;
  setMute(threadId: string, durationSeconds: number, threadType: ThreadType): Promise<void>;
  sendTyping(threadId: string, threadType: ThreadType): Promise<void>;

  sendMessage(
    threadId: string,
    payload: SendMessagePayload,
    threadType: ThreadType,
  ): Promise<SendMessageReceipt>;
  getGroupChatHistory(
    groupId: string,
    options?: { count?: number; cursor?: string | null; isOld?: boolean },
  ): Promise<{ messages: RawMessageEnvelope[]; hasMore: boolean; nextCursor: string | null; isOld?: boolean }>;
  requestOldMessages?(threadType: ThreadType, lastMsgId?: string | null): void;
  undoMessage(message: Message): Promise<void>;
  deleteMessage(message: Message, onlyMe: boolean): Promise<void>;
  addReaction(message: Message, reaction: Reaction | string): Promise<void>;
  markSeen(messages: readonly Message[], threadType: ThreadType): Promise<void>;

  uploadAttachment(
    sources: readonly MediaInput[],
    threadId: string,
    threadType: ThreadType,
  ): Promise<RawUploadedMediaLike[]>;

  getAccountSettings(): Promise<RawUserSetting>;
  updateLanguage(lang: 'VI' | 'EN'): Promise<void>;

  startListening(handlers: TransportListenerHandlers, options?: { retryOnClose?: boolean }): void;
  stopListening(): void;
}

export interface ZcaTransportOptions {
  selfListen?: boolean;
  checkUpdate?: boolean;
  imageMetadataGetter?: ImageMetadataGetter;
}
