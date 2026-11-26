import {
  Gender,
  GroupType,
  ThreadType,
  type AccountSettings,
  type Attachment,
  type AttachmentKind,
  type ContactData,
  type GroupData,
  type GroupMember,
  type GroupSettings,
  type GroupSummary,
  type LastOnlineInfo,
  type Mention,
  type MessageData,
  type MessageQuote,
  type OnlineStatus,
  type ProfileData,
  type UploadedMedia,
  type UserData,
} from '../models/index.js';

export interface RawUserLike {
  userId?: string;
  uid?: string;
  username?: string;
  displayName?: string;
  display_name?: string;
  zaloName?: string;
  zalo_name?: string;
  avatar?: string;
  cover?: string;
  gender?: number;
  sdob?: string;
  status?: string;
  phoneNumber?: string;
  isFr?: number;
  isBlocked?: number | boolean;
  lastActionTime?: number;
  globalId?: string;
  bizPkg?: { pkgId?: number } | null;
  createdTs?: number;
}

export interface RawGroupInfoLike {
  groupId?: string;
  name?: string;
  desc?: string;
  type?: number;
  creatorId?: string;
  avt?: string;
  fullAvt?: string;
  memberIds?: string[];
  adminIds?: string[];
  totalMember?: number;
  maxMember?: number;
  e2ee?: number;
  createdTime?: number;
  setting?: {
    blockName?: number;
    signAdminMsg?: number;
    addMemberOnly?: number;
    setTopicOnly?: number;
    enableMsgHistory?: number;
    joinAppr?: number;
    lockCreatePost?: number;
    lockCreatePoll?: number;
    lockSendMsg?: number;
    lockViewMember?: number;
  };
}

export interface RawGroupMemberLike {
  id?: string;
  displayName?: string;
  zaloName?: string;
  avatar?: string;
  globalId?: string;
  accountStatus?: number;
}

export interface RawMessageEnvelope {
  type?: number;
  threadId?: string;
  isSelf?: boolean;
  data?: {
    msgId?: string | number;
    cliMsgId?: string | number;
    msgType?: string;
    uidFrom?: string | number;
    idTo?: string | number;
    dName?: string;
    ts?: string | number;
    content?: unknown;
    ttl?: number;
    st?: number;
    at?: number;
    cmd?: number;
    mentions?: Array<{ uid?: string; pos?: number; len?: number }>;
    quote?: {
      ownerId?: string | number;
      cliMsgId?: string | number;
      globalMsgId?: string | number;
      ts?: string | number;
      msg?: string;
    };
  };
}

export interface RawUploadedMediaLike {
  fileType?: string;
  photoId?: string;
  fileId?: string;
  normalUrl?: string;
  hdUrl?: string;
  thumbUrl?: string;
  fileUrl?: string;
  fileName?: string;
  totalSize?: number;
  width?: number;
  height?: number;
  checksum?: string;
}

export interface RawOnlineEntry {
  userId?: string;
  status?: string;
}

export interface RawLastOnlineResponse {
  settings?: { show_online_status?: boolean };
  lastOnline?: number;
}

export interface RawUserSetting {
  show_online_status?: boolean;
  display_seen_status?: number;
  add_friend_via_phone?: number;
  add_friend_via_contact?: number;
  add_friend_via_group?: number;
  add_friend_via_qr?: number;
  accept_stranger_call?: number;
  setting_2FA_status?: number;
}

function toDate(ts: unknown): Date {
  const n = typeof ts === 'number' ? ts : Number(ts);
  if (!Number.isFinite(n) || n <= 0) return new Date(0);
  return new Date(n < 1e12 ? n * 1000 : n);
}

function toOptionalDate(ts: unknown): Date | undefined {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return undefined;
  return new Date(ts < 1e12 ? ts * 1000 : ts);
}

export function mapUserData(raw: RawUserLike): UserData {
  const id = String(raw.userId ?? raw.uid ?? '');
  const displayName = String(raw.displayName ?? raw.display_name ?? raw.zaloName ?? raw.zalo_name ?? '');
  return {
    id,
    username: raw.username || undefined,
    displayName,
    zaloName: String(raw.zaloName ?? raw.zalo_name ?? displayName),
    avatarUrl: String(raw.avatar ?? ''),
    coverUrl: raw.cover || undefined,
    gender: raw.gender === 0 ? Gender.Male : raw.gender === 1 ? Gender.Female : Gender.Unknown,
    birthday: raw.sdob || undefined,
    statusMessage: raw.status || undefined,
    phoneNumber: raw.phoneNumber || undefined,
    isFriend: raw.isFr === 1,
    isBlocked: raw.isBlocked === 1 || raw.isBlocked === true,
    lastActiveAt: toOptionalDate(raw.lastActionTime),
  };
}

export function mapProfileData(raw: RawUserLike): ProfileData {
  return {
    ...mapUserData(raw),
    globalId: raw.globalId || undefined,
    isBusiness: Boolean(raw.bizPkg && typeof raw.bizPkg.pkgId === 'number' && raw.bizPkg.pkgId > 0),
    createdAt: toOptionalDate(raw.createdTs),
  };
}

export function mapContactData(raw: RawUserLike, alias?: string): ContactData {
  return {
    ...mapUserData(raw),
    isFriend: true,
    alias: alias || undefined,
  };
}

export function mapGroupData(raw: RawGroupInfoLike, fallbackId?: string): GroupData {
  const memberIds = Array.isArray(raw.memberIds) ? raw.memberIds.map(String) : [];
  const adminIds = Array.isArray(raw.adminIds) ? raw.adminIds.map(String) : [];
  const settings: GroupSettings | undefined = raw.setting
    ? {
        blockName: raw.setting.blockName === 1,
        signAdminMsg: raw.setting.signAdminMsg === 1,
        addMemberOnly: raw.setting.addMemberOnly === 1,
        setTopicOnly: raw.setting.setTopicOnly === 1,
        enableMsgHistory: raw.setting.enableMsgHistory === 1,
        joinApprovalRequired: raw.setting.joinAppr === 1,
        lockCreatePost: raw.setting.lockCreatePost === 1,
        lockCreatePoll: raw.setting.lockCreatePoll === 1,
        lockSendMsg: raw.setting.lockSendMsg === 1,
        lockViewMember: raw.setting.lockViewMember === 1,
      }
    : undefined;

  return {
    id: String(raw.groupId ?? fallbackId ?? ''),
    name: String(raw.name ?? ''),
    description: String(raw.desc ?? ''),
    type: raw.type === 2 ? GroupType.Community : GroupType.Group,
    creatorId: String(raw.creatorId ?? ''),
    avatarUrl: String(raw.avt ?? ''),
    fullAvatarUrl: raw.fullAvt || undefined,
    memberCount: typeof raw.totalMember === 'number' ? raw.totalMember : memberIds.length,
    maxMembers: typeof raw.maxMember === 'number' ? raw.maxMember : 0,
    memberIds,
    adminIds,
    isE2EE: raw.e2ee === 1,
    createdAt: toOptionalDate(raw.createdTime),
    settings,
  };
}

export function mapGroupSummaries(gridVerMap?: Record<string, string>): GroupSummary[] {
  if (!gridVerMap || typeof gridVerMap !== 'object') return [];
  return Object.entries(gridVerMap).map(([id, version]) => ({
    id: String(id),
    version: String(version ?? ''),
  }));
}

export function mapGroupMember(raw: RawGroupMemberLike): GroupMember {
  return {
    id: String(raw.id ?? ''),
    displayName: String(raw.displayName ?? raw.zaloName ?? ''),
    zaloName: String(raw.zaloName ?? raw.displayName ?? ''),
    avatarUrl: String(raw.avatar ?? ''),
    globalId: raw.globalId || undefined,
    accountStatus: typeof raw.accountStatus === 'number' ? raw.accountStatus : 0,
  };
}

const EMPTY_ATTACHMENTS: readonly Attachment[] = Object.freeze([]);
const EMPTY_MENTIONS: readonly Mention[] = Object.freeze([]);

function inferKind(msgType: string, rawType?: string): AttachmentKind {
  const s = rawType ? `${msgType} ${rawType}`.toLowerCase() : msgType.toLowerCase();
  if (s.includes('photo') || s.includes('image')) return 'image';
  if (s.includes('video')) return 'video';
  if (s.includes('voice') || s.includes('audio')) return 'audio';
  if (s.includes('sticker')) return 'sticker';
  if (s.includes('link') || s.includes('url')) return 'link';
  if (s.includes('file') || s.includes('share.file')) return 'file';
  return 'other';
}

export function mapMessageData(raw: RawMessageEnvelope): MessageData {
  const data = raw.data;
  if (!data) {
    return {
      id: '',
      clientMsgId: '',
      threadId: String(raw.threadId ?? ''),
      threadType: raw.type === ThreadType.Group ? ThreadType.Group : ThreadType.User,
      sender: { id: '' },
      recipientId: '',
      isSelf: Boolean(raw.isSelf),
      msgType: 'webchat',
      text: '',
      attachments: EMPTY_ATTACHMENTS,
      mentions: EMPTY_MENTIONS,
      replyTo: undefined,
      timestamp: new Date(0),
      ttlMs: 0,
      st: 0,
      at: 0,
      cmd: 0,
    };
  }

  const msgType = typeof data.msgType === 'string' ? data.msgType : 'webchat';
  let text = '';
  let attachments: readonly Attachment[] = EMPTY_ATTACHMENTS;

  const content = data.content;
  if (typeof content === 'string') {
    text = content;
  } else if (content !== null && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    text = typeof obj.title === 'string' ? obj.title : '';
    attachments = [
      {
        kind: inferKind(msgType, typeof obj.type === 'string' ? obj.type : undefined),
        url: typeof obj.href === 'string' ? obj.href : undefined,
        thumbnailUrl: typeof obj.thumb === 'string' ? obj.thumb : undefined,
        title: text || undefined,
        description: typeof obj.description === 'string' ? obj.description : undefined,
      },
    ];
  }

  let mentions: readonly Mention[] = EMPTY_MENTIONS;
  if (Array.isArray(data.mentions) && data.mentions.length > 0) {
    const mapped: Mention[] = new Array(data.mentions.length);
    for (let i = 0; i < data.mentions.length; i++) {
      const m = data.mentions[i]!;
      mapped[i] = {
        userId: String(m.uid ?? ''),
        pos: typeof m.pos === 'number' ? m.pos : 0,
        len: typeof m.len === 'number' ? m.len : 0,
      };
    }
    mentions = mapped;
  }

  let replyTo: MessageQuote | undefined;
  if (data.quote && typeof data.quote === 'object') {
    replyTo = {
      ownerId: String(data.quote.ownerId ?? ''),
      clientMsgId: String(data.quote.cliMsgId ?? ''),
      globalMsgId: String(data.quote.globalMsgId ?? ''),
      text: String(data.quote.msg ?? ''),
      timestamp: toDate(data.quote.ts),
    };
  }

  return {
    id: data.msgId !== undefined ? String(data.msgId) : '',
    clientMsgId: data.cliMsgId !== undefined ? String(data.cliMsgId) : '',
    threadId: String(raw.threadId ?? data.idTo ?? ''),
    threadType: raw.type === ThreadType.Group ? ThreadType.Group : ThreadType.User,
    sender: {
      id: data.uidFrom !== undefined ? String(data.uidFrom) : '',
      name: data.dName || undefined,
    },
    recipientId: data.idTo !== undefined ? String(data.idTo) : '',
    isSelf: Boolean(raw.isSelf),
    msgType,
    text,
    attachments,
    mentions,
    replyTo,
    timestamp: toDate(data.ts),
    ttlMs: typeof data.ttl === 'number' ? data.ttl : 0,
    st: typeof data.st === 'number' ? data.st : 0,
    at: typeof data.at === 'number' ? data.at : 0,
    cmd: typeof data.cmd === 'number' ? data.cmd : 0,
  };
}

export function mapUploadedMedia(raw: RawUploadedMediaLike): UploadedMedia {
  if (raw.fileType === 'image') {
    return {
      id: String(raw.photoId ?? ''),
      kind: 'image',
      url: String(raw.normalUrl ?? raw.hdUrl ?? ''),
      hdUrl: raw.hdUrl || undefined,
      thumbnailUrl: raw.thumbUrl || undefined,
      totalSize: typeof raw.totalSize === 'number' ? raw.totalSize : 0,
      width: typeof raw.width === 'number' ? raw.width : undefined,
      height: typeof raw.height === 'number' ? raw.height : undefined,
    };
  }
  return {
    id: String(raw.fileId ?? ''),
    kind: raw.fileType === 'video' ? 'video' : 'file',
    url: String(raw.fileUrl ?? ''),
    fileName: raw.fileName || undefined,
    totalSize: typeof raw.totalSize === 'number' ? raw.totalSize : 0,
    checksum: raw.checksum || undefined,
  };
}

export function mapOnlineFriends(entries?: RawOnlineEntry[]): OnlineStatus[] {
  if (!Array.isArray(entries)) return [];
  return entries.map((e) => ({
    userId: String(e.userId ?? ''),
    status: String(e.status ?? ''),
  }));
}

export function mapLastOnline(userId: string, raw: RawLastOnlineResponse): LastOnlineInfo {
  const ts = typeof raw.lastOnline === 'number' && raw.lastOnline > 0 ? raw.lastOnline : null;
  return {
    userId,
    lastOnlineAt: ts !== null ? toDate(ts) : null,
    showOnlineStatus: Boolean(raw.settings?.show_online_status),
  };
}

export function mapAccountSettings(raw: RawUserSetting): AccountSettings {
  return {
    showOnlineStatus: Boolean(raw.show_online_status),
    displaySeenStatus: raw.display_seen_status === 1,
    addFriendViaPhone: raw.add_friend_via_phone === 1,
    addFriendViaContact: raw.add_friend_via_contact === 1,
    addFriendViaGroup: raw.add_friend_via_group === 1,
    addFriendViaQR: raw.add_friend_via_qr === 1,
    acceptStrangerCall: raw.accept_stranger_call === 1,
    twoFactorEnabled: raw.setting_2FA_status === 1,
  };
}
