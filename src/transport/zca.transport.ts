import {
  Zalo,
  LoginQRCallbackEventType,
  MuteAction,
  ThreadType as ZcaThreadType,
  UpdateLangAvailableLanguages,
  type API,
  type AttachmentSource,
  type Credentials,
  type LoginQRCallbackEvent,
  type MessageContent,
  type Reactions,
  type Style,
  type TextStyle as ZcaTextStyle,
  type Urgency as ZcaUrgency,
} from 'zca-js';
import { AuthenticationError } from '../errors/index.js';
import {
  ThreadType,
  type MediaInput,
  type Message,
  type PinnedConversations,
  type Reaction,
  type SendMessagePayload,
  type SendMessageReceipt,
  type SerializedCookie,
  type SessionCredentials,
  type UnreadMarks,
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
import type {
  TransportAdapter,
  TransportListenerHandlers,
  TransportQRCallbacks,
  ZcaTransportOptions,
} from './adapter.js';

function toZcaType(t: ThreadType): ZcaThreadType {
  return t === ThreadType.Group ? ZcaThreadType.Group : ZcaThreadType.User;
}

function toAttachment(input: MediaInput): AttachmentSource {
  if (typeof input === 'string') return input;
  return {
    data: input.data,
    filename: input.filename,
    metadata: {
      totalSize: input.totalSize ?? input.data.length,
      width: input.width,
      height: input.height,
    },
  };
}

function normalizeQRImage(raw: string): { imageBase64: string; imageDataUrl: string } {
  const s = raw.trim();
  if (s.startsWith('data:')) {
    const idx = s.indexOf(',');
    return { imageBase64: idx >= 0 ? s.slice(idx + 1) : s, imageDataUrl: s };
  }
  return { imageBase64: s, imageDataUrl: `data:image/png;base64,${s}` };
}

export class ZcaTransport implements TransportAdapter {
  private api: API | null = null;
  private listenerAttached = false;

  constructor(private readonly options: ZcaTransportOptions = {}) {}

  private createEngine(): Zalo {
    return new Zalo({
      logging: false,
      selfListen: this.options.selfListen ?? false,
      checkUpdate: this.options.checkUpdate ?? false,
      imageMetadataGetter: this.options.imageMetadataGetter,
    });
  }

  private requireApi(): API {
    if (!this.api) {
      throw new AuthenticationError('Zapid client is not authenticated. Call await client.login() first.');
    }
    return this.api;
  }

  public isConnected(): boolean {
    return this.api !== null;
  }

  public getOwnId(): string {
    return String(this.requireApi().getOwnId());
  }

  public getRawApi(): API {
    return this.requireApi();
  }

  public async loginWithCredentials(credentials: SessionCredentials): Promise<void> {
    const engine = this.createEngine();
    const creds: Credentials = {
      imei: credentials.imei,
      cookie: credentials.cookie as unknown as Credentials['cookie'],
      userAgent: credentials.userAgent,
      language: credentials.language,
    };
    this.api = await engine.login(creds);
    this.listenerAttached = false;
  }

  public async loginWithQR(
    options: { userAgent: string; language: string; signal?: AbortSignal },
    callbacks: TransportQRCallbacks,
  ): Promise<SessionCredentials> {
    const engine = this.createEngine();
    let captured: SessionCredentials | null = null;
    let abortFn: (() => unknown) | null = null;
    let failure: Error | null = null;

    const onAbort = (): void => {
      failure = new AuthenticationError('QR code login timed out');
      try {
        abortFn?.();
      } catch {
        // ignore
      }
    };

    if (options.signal) {
      if (options.signal.aborted) throw new AuthenticationError('QR login aborted');
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const onEvent = (evt: LoginQRCallbackEvent): void => {
      if (evt.actions && typeof evt.actions.abort === 'function') {
        abortFn = evt.actions.abort;
      }
      switch (evt.type) {
        case LoginQRCallbackEventType.QRCodeGenerated: {
          const { imageBase64, imageDataUrl } = normalizeQRImage(String(evt.data?.image ?? ''));
          callbacks.onQRCode?.({ imageBase64, imageDataUrl, code: evt.data?.code });
          break;
        }
        case LoginQRCallbackEventType.QRCodeScanned: {
          callbacks.onScanned?.({
            displayName: String(evt.data?.display_name ?? ''),
            avatarUrl: String(evt.data?.avatar ?? ''),
          });
          break;
        }
        case LoginQRCallbackEventType.QRCodeExpired: {
          failure = new AuthenticationError('QR code expired');
          callbacks.onExpired?.();
          try {
            evt.actions?.abort?.();
          } catch {
            // ignore
          }
          break;
        }
        case LoginQRCallbackEventType.QRCodeDeclined: {
          failure = new AuthenticationError('QR code login declined on device');
          callbacks.onDeclined?.();
          try {
            evt.actions?.abort?.();
          } catch {
            // ignore
          }
          break;
        }
        case LoginQRCallbackEventType.GotLoginInfo: {
          captured = {
            cookie: (evt.data?.cookie ?? []) as unknown as SerializedCookie[],
            imei: String(evt.data?.imei ?? ''),
            userAgent: String(evt.data?.userAgent ?? options.userAgent),
            language: options.language,
          };
          callbacks.onCredentials?.(captured);
          break;
        }
      }
    };

    try {
      const logged = await engine.loginQR(
        { userAgent: options.userAgent, language: options.language },
        onEvent,
      );
      this.api = logged;
      this.listenerAttached = false;

      if (!captured) {
        const ctx = logged.getContext();
        const jar = logged.getCookie().toJSON();
        captured = {
          cookie: (jar?.cookies ?? []) as unknown as SerializedCookie[],
          imei: String(ctx.imei ?? ''),
          userAgent: String(ctx.userAgent ?? options.userAgent),
          language: options.language,
        };
      }
      return captured;
    } catch (err) {
      if (failure) throw failure;
      throw err;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  public async disconnect(): Promise<void> {
    this.stopListening();
    this.api = null;
  }

  public async fetchAccountInfo(): Promise<RawUserLike | null> {
    const res = await this.requireApi().fetchAccountInfo();
    return (res?.profile as unknown as RawUserLike) ?? null;
  }

  public async updateProfile(patch: {
    name: string;
    dob: `${number}-${number}-${number}`;
    gender: 0 | 1;
  }): Promise<void> {
    await this.requireApi().updateProfile({
      profile: {
        name: patch.name,
        dob: patch.dob,
        gender: patch.gender,
      },
    });
  }

  public async updateBio(bio: string): Promise<void> {
    await this.requireApi().updateProfileBio(bio);
  }

  public async keepAlive(): Promise<{ configVersion: number }> {
    const res = await this.requireApi().keepAlive();
    return { configVersion: Number(res?.config_vesion ?? 0) };
  }

  public async getUserInfo(userIds: string | string[]): Promise<Record<string, RawUserLike>> {
    const res = await this.requireApi().getUserInfo(userIds);
    return (res?.changed_profiles ?? {}) as unknown as Record<string, RawUserLike>;
  }

  public async findUserByPhone(phone: string): Promise<RawUserLike | null> {
    const res = await this.requireApi().findUser(phone);
    return (res as unknown as RawUserLike) ?? null;
  }

  public async findUserByUsername(username: string): Promise<RawUserLike | null> {
    const res = await this.requireApi().findUserByUsername(username);
    return (res as unknown as RawUserLike) ?? null;
  }

  public async getLastOnline(userId: string): Promise<RawLastOnlineResponse> {
    const res = await this.requireApi().lastOnline(userId);
    return res as unknown as RawLastOnlineResponse;
  }

  public async getAllFriends(count?: number, page?: number): Promise<RawUserLike[]> {
    const res = await this.requireApi().getAllFriends(count, page);
    return (Array.isArray(res) ? res : []) as unknown as RawUserLike[];
  }

  public async sendFriendRequest(userId: string, message: string): Promise<void> {
    await this.requireApi().sendFriendRequest(message, userId);
  }

  public async acceptFriendRequest(userId: string): Promise<void> {
    await this.requireApi().acceptFriendRequest(userId);
  }

  public async rejectFriendRequest(userId: string): Promise<void> {
    await this.requireApi().rejectFriendRequest(userId);
  }

  public async removeFriend(userId: string): Promise<void> {
    await this.requireApi().removeFriend(userId);
  }

  public async blockUser(userId: string): Promise<void> {
    await this.requireApi().blockUser(userId);
  }

  public async unblockUser(userId: string): Promise<void> {
    await this.requireApi().unblockUser(userId);
  }

  public async setFriendAlias(userId: string, alias: string): Promise<void> {
    await this.requireApi().changeFriendAlias(alias, userId);
  }

  public async getOnlineFriends(): Promise<RawOnlineEntry[]> {
    const res = await this.requireApi().getFriendOnlines();
    return (Array.isArray(res?.onlines) ? res.onlines : []) as RawOnlineEntry[];
  }

  public async getAllGroups(): Promise<Record<string, string>> {
    const res = await this.requireApi().getAllGroups();
    return res?.gridVerMap ?? {};
  }

  public async getGroupInfo(groupIds: string | string[]): Promise<Record<string, RawGroupInfoLike>> {
    const res = await this.requireApi().getGroupInfo(groupIds);
    return (res?.gridInfoMap ?? {}) as unknown as Record<string, RawGroupInfoLike>;
  }

  public async getGroupMembersInfo(
    memberIds: string | string[],
  ): Promise<Record<string, RawGroupMemberLike>> {
    const res = await this.requireApi().getGroupMembersInfo(memberIds);
    return (res?.profiles ?? {}) as unknown as Record<string, RawGroupMemberLike>;
  }

  public async createGroup(options: { name?: string; members: string[] }): Promise<{ groupId: string }> {
    const res = await this.requireApi().createGroup({
      name: options.name,
      members: options.members,
    });
    return { groupId: String(res?.groupId ?? '') };
  }

  public async addGroupMembers(groupId: string, userIds: string[]): Promise<void> {
    await this.requireApi().addUserToGroup(userIds, groupId);
  }

  public async removeGroupMembers(groupId: string, userIds: string[]): Promise<void> {
    await this.requireApi().removeUserFromGroup(userIds, groupId);
  }

  public async renameGroup(groupId: string, name: string): Promise<void> {
    await this.requireApi().changeGroupName(name, groupId);
  }

  public async leaveGroup(groupId: string): Promise<void> {
    await this.requireApi().leaveGroup(groupId);
  }

  public async getPinnedConversations(): Promise<PinnedConversations> {
    const res = await this.requireApi().getPinConversations();
    return {
      conversationIds: Array.isArray(res?.conversations) ? res.conversations.map(String) : [],
      version: Number(res?.version ?? 0),
    };
  }

  public async getUnreadMarks(): Promise<UnreadMarks> {
    const res = await this.requireApi().getUnreadMark();
    const mapList = (
      items: Array<{ id: number; cliMsgId: number; fromUid: number; ts: number }> | undefined,
      threadType: ThreadType,
    ) =>
      (Array.isArray(items) ? items : []).map((i) => ({
        threadId: String(i.id),
        threadType,
        clientMsgId: String(i.cliMsgId),
        senderId: String(i.fromUid),
        timestamp: new Date(i.ts < 1e12 ? i.ts * 1000 : i.ts),
      }));

    return {
      groups: mapList(res?.data?.convsGroup, ThreadType.Group),
      users: mapList(res?.data?.convsUser, ThreadType.User),
    };
  }

  public async setPinnedConversations(
    ids: string[],
    pinned: boolean,
    threadType: ThreadType,
  ): Promise<void> {
    await this.requireApi().setPinnedConversations(pinned, ids, toZcaType(threadType));
  }

  public async setMute(
    threadId: string,
    durationSeconds: number,
    threadType: ThreadType,
  ): Promise<void> {
    const action = durationSeconds <= 0 ? MuteAction.UNMUTE : MuteAction.MUTE;
    await this.requireApi().setMute(
      { action, duration: durationSeconds },
      threadId,
      toZcaType(threadType),
    );
  }

  public async sendTyping(threadId: string, threadType: ThreadType): Promise<void> {
    await this.requireApi().sendTypingEvent(threadId, toZcaType(threadType));
  }

  public async sendMessage(
    threadId: string,
    payload: SendMessagePayload,
    threadType: ThreadType,
  ): Promise<SendMessageReceipt> {
    const api = this.requireApi();
    const zcaType = toZcaType(threadType);

    if (payload.link) {
      const res = await api.sendLink(
        { link: payload.link.url, msg: payload.text ?? payload.link.title },
        threadId,
        zcaType,
      );
      return { messageId: res?.msgId !== undefined ? String(res.msgId) : null, attachmentMessageIds: [] };
    }

    if (payload.sticker) {
      const res = await api.sendSticker(payload.sticker, threadId, zcaType);
      return { messageId: res?.msgId !== undefined ? String(res.msgId) : null, attachmentMessageIds: [] };
    }

    if (payload.voice) {
      const res = await api.sendVoice(
        { voiceUrl: payload.voice.voiceUrl, ttl: payload.voice.ttlMs },
        threadId,
        zcaType,
      );
      return { messageId: res?.msgId !== undefined ? String(res.msgId) : null, attachmentMessageIds: [] };
    }

    if (payload.video) {
      const res = await api.sendVideo(
        {
          msg: payload.video.msg ?? payload.text,
          videoUrl: payload.video.videoUrl,
          thumbnailUrl: payload.video.thumbnailUrl,
          duration: payload.video.duration,
          width: payload.video.width,
          height: payload.video.height,
          ttl: payload.video.ttlMs,
        },
        threadId,
        zcaType,
      );
      return { messageId: res?.msgId !== undefined ? String(res.msgId) : null, attachmentMessageIds: [] };
    }

    const content: MessageContent = { msg: payload.text ?? '' };
    const allAttachments: MediaInput[] = [];
    if (payload.attachment) allAttachments.push(payload.attachment);
    if (payload.attachments) allAttachments.push(...payload.attachments);
    if (allAttachments.length > 0) {
      content.attachments = allAttachments.map(toAttachment);
    }

    if (payload.mentions && payload.mentions.length > 0) {
      content.mentions = payload.mentions.map((m) => ({ uid: m.userId, pos: m.pos, len: m.len }));
    }

    if (payload.styles && payload.styles.length > 0) {
      content.styles = payload.styles.map((s) =>
        s.indentSize !== undefined
          ? ({
              start: s.start,
              len: s.len,
              st: s.style as unknown as ZcaTextStyle.Indent,
              indentSize: s.indentSize,
            } as Style)
          : ({
              start: s.start,
              len: s.len,
              st: s.style as unknown as Exclude<ZcaTextStyle, ZcaTextStyle.Indent>,
            } as Style),
      );
    }

    if (payload.urgency !== undefined) {
      content.urgency = payload.urgency as unknown as ZcaUrgency;
    }

    if (payload.replyTo) {
      content.quote = {
        content: payload.replyTo.text,
        msgType: payload.replyTo.msgType,
        propertyExt: undefined,
        uidFrom: payload.replyTo.sender.id,
        msgId: payload.replyTo.id,
        cliMsgId: payload.replyTo.clientMsgId,
        ts: String(payload.replyTo.timestamp.getTime()),
        ttl: payload.replyTo.ttlMs,
      };
    }

    if (payload.ttlMs !== undefined) {
      content.ttl = payload.ttlMs;
    }

    const res = await api.sendMessage(content, threadId, zcaType);
    return {
      messageId: res?.message?.msgId !== undefined ? String(res.message.msgId) : null,
      attachmentMessageIds: Array.isArray(res?.attachment)
        ? res.attachment.map((a) => String(a.msgId))
        : [],
    };
  }

  public async getGroupChatHistory(
    groupId: string,
    count?: number,
  ): Promise<{ messages: RawMessageEnvelope[]; hasMore: boolean; nextCursor: string | null }> {
    const res = await this.requireApi().getGroupChatHistory(groupId, count);
    return {
      messages: (Array.isArray(res?.groupMsgs) ? res.groupMsgs : []) as unknown as RawMessageEnvelope[],
      hasMore: res?.more === 1,
      nextCursor: res?.lastActionId ? String(res.lastActionId) : null,
    };
  }

  public async undoMessage(message: Message): Promise<void> {
    await this.requireApi().undo(
      { msgId: message.id, cliMsgId: message.clientMsgId },
      message.threadId,
      toZcaType(message.threadType),
    );
  }

  public async deleteMessage(message: Message, onlyMe: boolean): Promise<void> {
    await this.requireApi().deleteMessage(
      {
        data: {
          cliMsgId: message.clientMsgId,
          msgId: message.id,
          uidFrom: message.sender.id,
        },
        threadId: message.threadId,
        type: toZcaType(message.threadType),
      },
      onlyMe,
    );
  }

  public async addReaction(message: Message, reaction: Reaction | string): Promise<void> {
    await this.requireApi().addReaction(reaction as Reactions, {
      data: { msgId: message.id, cliMsgId: message.clientMsgId },
      threadId: message.threadId,
      type: toZcaType(message.threadType),
    });
  }

  public async markSeen(messages: readonly Message[], threadType: ThreadType): Promise<void> {
    const params = messages.map((m) => ({
      msgId: m.id,
      cliMsgId: m.clientMsgId,
      uidFrom: m.sender.id,
      idTo: m.recipientId || m.threadId,
      msgType: m.msgType,
      st: m.st,
      at: m.at,
      cmd: m.cmd,
      ts: String(m.timestamp.getTime()),
    }));
    await this.requireApi().sendSeenEvent(params, toZcaType(threadType));
  }

  public async uploadAttachment(
    sources: readonly MediaInput[],
    threadId: string,
    threadType: ThreadType,
  ): Promise<RawUploadedMediaLike[]> {
    const res = await this.requireApi().uploadAttachment(
      sources.map(toAttachment),
      threadId,
      toZcaType(threadType),
    );
    return (Array.isArray(res) ? res : []) as unknown as RawUploadedMediaLike[];
  }

  public async getAccountSettings(): Promise<RawUserSetting> {
    const res = await this.requireApi().getSettings();
    return res as unknown as RawUserSetting;
  }

  public async updateLanguage(lang: 'VI' | 'EN'): Promise<void> {
    await this.requireApi().updateLang(
      lang === 'EN' ? UpdateLangAvailableLanguages.EN : UpdateLangAvailableLanguages.VI,
    );
  }

  public startListening(
    handlers: TransportListenerHandlers,
    options?: { retryOnClose?: boolean },
  ): void {
    const api = this.requireApi();
    if (this.listenerAttached) return;
    this.listenerAttached = true;

    api.listener.on('message', (msg) => {
      handlers.onMessage(msg as unknown as RawMessageEnvelope);
    });

    api.listener.on('reaction', (r) => {
      const ts = Number(r.data?.ts ?? Date.now());
      handlers.onReaction({
        threadId: String(r.threadId ?? ''),
        threadType: r.isGroup ? ThreadType.Group : ThreadType.User,
        senderId: String(r.data?.uidFrom ?? ''),
        icon: String(r.data?.content?.rIcon ?? ''),
        targetMessageIds: Array.isArray(r.data?.content?.rMsg)
          ? r.data.content.rMsg.map((x) => String(x.gMsgID))
          : [],
        isSelf: Boolean(r.isSelf),
        timestamp: new Date(Number.isFinite(ts) ? ts : Date.now()),
      });
    });

    api.listener.on('group_event', (evt) => {
      const data = (evt.data ?? {}) as Record<string, unknown>;
      handlers.onGroupUpdate({
        groupId: String(evt.threadId ?? data.groupId ?? ''),
        type: String(evt.type ?? 'unknown'),
        actorId: typeof data.sourceId === 'string' ? data.sourceId : undefined,
        targetIds: Array.isArray(data.updateMembers)
          ? (data.updateMembers as Array<{ id?: string }>).map((m) => String(m.id ?? '')).filter(Boolean)
          : [],
        data,
      });
    });

    api.listener.on('friend_event', (evt) => {
      const data = (evt.data ?? {}) as Record<string, unknown>;
      handlers.onUserUpdate({
        userId: String(evt.threadId ?? data.fromUid ?? ''),
        type: String(evt.type ?? 'unknown'),
        data,
      });
    });

    api.listener.on('typing', (t) => {
      handlers.onTyping({
        threadId: String(t.threadId ?? ''),
        threadType: t.type === ZcaThreadType.Group ? ThreadType.Group : ThreadType.User,
        userId: String(t.data?.uid ?? ''),
        isSelf: Boolean(t.isSelf),
      });
    });

    api.listener.on('seen_messages', (list) => {
      for (const item of list) {
        const d = item.data as unknown as Record<string, unknown>;
        handlers.onSeen({
          threadId: String(item.threadId ?? ''),
          threadType: item.type === ZcaThreadType.Group ? ThreadType.Group : ThreadType.User,
          messageIds: Array.isArray(d?.idTo) ? (d.idTo as string[]).map(String) : [],
          seenBy: Array.isArray(d?.seenUids) ? (d.seenUids as string[]).map(String) : [],
        });
      }
    });

    api.listener.on('undo', (u) => {
      handlers.onUndo({
        threadId: String(u.threadId ?? ''),
        threadType: u.isGroup ? ThreadType.Group : ThreadType.User,
        senderId: String(u.data?.uidFrom ?? ''),
        messageId: String(u.data?.content?.globalMsgId ?? u.data?.msgId ?? ''),
        clientMsgId: String(u.data?.content?.cliMsgId ?? u.data?.cliMsgId ?? ''),
        isSelf: Boolean(u.isSelf),
      });
    });

    api.listener.on('connected', () => handlers.onConnected({ connected: true }));
    api.listener.on('closed', (code, reason) =>
      handlers.onDisconnected({ connected: false, code, reason }),
    );
    api.listener.on('error', (err) => handlers.onError(err));

    api.listener.start({ retryOnClose: options?.retryOnClose ?? false });
  }

  public stopListening(): void {
    if (!this.api?.listener) return;
    try {
      this.api.listener.stop();
    } catch {
      // ignore
    }
    this.listenerAttached = false;
  }
}
