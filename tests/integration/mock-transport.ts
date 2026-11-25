import { SessionError } from '../../src/errors/index.js';
import type {
  RawGroupInfoLike,
  RawGroupMemberLike,
  RawLastOnlineResponse,
  RawMessageEnvelope,
  RawOnlineEntry,
  RawUploadedMediaLike,
  RawUserLike,
  RawUserSetting,
} from '../../src/mappers/index.js';
import type {
  MediaInput,
  Message,
  PinnedConversations,
  Reaction,
  SendMessagePayload,
  SendMessageReceipt,
  SessionCredentials,
  ThreadType,
  UnreadMarks,
} from '../../src/models/index.js';
import type {
  TransportAdapter,
  TransportListenerHandlers,
  TransportQRCallbacks,
} from '../../src/transport/adapter.js';

export class MockTransport implements TransportAdapter {
  public connected = false;
  public ownId = 'u-me';
  public failCredentialLogin = false;
  public rawApiMarker = { __mockRawApi: true };

  public userInfoCalls = 0;
  public groupInfoCalls = 0;
  public allGroupsCalls = 0;
  public sentMessages: Array<{ threadId: string; payload: SendMessagePayload; threadType: ThreadType }> = [];
  public reactions: Array<{ messageId: string; reaction: string }> = [];
  public listenerHandlers: TransportListenerHandlers | null = null;
  public listening = false;

  public async loginWithCredentials(): Promise<void> {
    if (this.failCredentialLogin) {
      throw new SessionError('Saved cookie expired');
    }
    this.connected = true;
  }

  public async loginWithQR(
    options: { userAgent: string; language: string },
    callbacks: TransportQRCallbacks,
  ): Promise<SessionCredentials> {
    callbacks.onQRCode?.({
      imageBase64: 'iVBORw0KGgo=',
      imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      code: 'qr-1',
    });
    callbacks.onScanned?.({ displayName: 'Mock Me', avatarUrl: '' });
    const creds: SessionCredentials = {
      cookie: [{ name: 'zpw_sek', value: `cookie-${this.ownId}` }],
      imei: `imei-${this.ownId}`,
      userAgent: options.userAgent,
      language: options.language,
    };
    callbacks.onCredentials?.(creds);
    this.connected = true;
    return creds;
  }

  public async disconnect(): Promise<void> {
    this.stopListening();
    this.connected = false;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getOwnId(): string {
    return this.ownId;
  }

  public getRawApi(): unknown {
    return this.rawApiMarker;
  }

  public async fetchAccountInfo(): Promise<RawUserLike | null> {
    return { userId: this.ownId, displayName: 'Mock Me', zaloName: 'Mock Me', avatar: '' };
  }

  public async updateProfile(): Promise<void> {}
  public async updateBio(): Promise<void> {}
  public async keepAlive(): Promise<{ configVersion: number }> {
    return { configVersion: 1 };
  }

  public async getUserInfo(userIds: string | string[]): Promise<Record<string, RawUserLike>> {
    this.userInfoCalls++;
    const ids = Array.isArray(userIds) ? userIds : [userIds];
    const out: Record<string, RawUserLike> = {};
    for (const id of ids) {
      out[id] = { userId: id, displayName: `User ${id}`, zaloName: `User ${id}`, avatar: '' };
    }
    return out;
  }

  public async findUserByPhone(phone: string): Promise<RawUserLike | null> {
    return phone === '0912345678' ? { uid: 'u-phone', display_name: 'Phone User', avatar: '' } : null;
  }

  public async findUserByUsername(username: string): Promise<RawUserLike | null> {
    return username === 'bob' ? { uid: 'u-bob', display_name: 'Bob', avatar: '' } : null;
  }

  public async getLastOnline(): Promise<RawLastOnlineResponse> {
    return { lastOnline: 1700000000, settings: { show_online_status: true } };
  }

  public async getAllFriends(): Promise<RawUserLike[]> {
    return [{ userId: 'u-friend-1', displayName: 'Friend 1', avatar: '', isFr: 1 }];
  }

  public async sendFriendRequest(): Promise<void> {}
  public async acceptFriendRequest(): Promise<void> {}
  public async rejectFriendRequest(): Promise<void> {}
  public async removeFriend(): Promise<void> {}
  public async blockUser(): Promise<void> {}
  public async unblockUser(): Promise<void> {}
  public async setFriendAlias(): Promise<void> {}
  public async getOnlineFriends(): Promise<RawOnlineEntry[]> {
    return [{ userId: 'u-friend-1', status: 'online' }];
  }

  public async getAllGroups(): Promise<Record<string, string>> {
    this.allGroupsCalls++;
    return { 'g-100': 'v1', 'g-200': 'v2' };
  }

  public async getGroupInfo(groupIds: string | string[]): Promise<Record<string, RawGroupInfoLike>> {
    this.groupInfoCalls++;
    const ids = Array.isArray(groupIds) ? groupIds : [groupIds];
    const out: Record<string, RawGroupInfoLike> = {};
    for (const id of ids) {
      if (id.startsWith('g-')) {
        out[id] = {
          groupId: id,
          name: `Group ${id}`,
          desc: 'Team',
          type: 1,
          creatorId: this.ownId,
          memberIds: [this.ownId, 'u-friend-1'],
          adminIds: [this.ownId],
          totalMember: 2,
          maxMember: 1000,
        };
      }
    }
    return out;
  }

  public async getGroupMembersInfo(
    memberIds: string | string[],
  ): Promise<Record<string, RawGroupMemberLike>> {
    const ids = Array.isArray(memberIds) ? memberIds : [memberIds];
    const out: Record<string, RawGroupMemberLike> = {};
    for (const id of ids) {
      out[id] = { id, displayName: `Member ${id}`, zaloName: `Member ${id}`, avatar: '' };
    }
    return out;
  }

  public async createGroup(): Promise<{ groupId: string }> {
    return { groupId: 'g-new' };
  }

  public async addGroupMembers(): Promise<void> {}
  public async removeGroupMembers(): Promise<void> {}
  public async renameGroup(): Promise<void> {}
  public async leaveGroup(): Promise<void> {}

  public async getPinnedConversations(): Promise<PinnedConversations> {
    return { conversationIds: ['g-100'], version: 1 };
  }

  public async getUnreadMarks(): Promise<UnreadMarks> {
    return { groups: [], users: [] };
  }

  public async setPinnedConversations(): Promise<void> {}
  public async setMute(): Promise<void> {}
  public async sendTyping(): Promise<void> {}

  public async sendMessage(
    threadId: string,
    payload: SendMessagePayload,
    threadType: ThreadType,
  ): Promise<SendMessageReceipt> {
    this.sentMessages.push({ threadId, payload, threadType });
    return {
      messageId: String(100 + this.sentMessages.length),
      attachmentMessageIds: payload.attachment || payload.attachments ? ['900'] : [],
    };
  }

  public async getGroupChatHistory(
    groupId: string,
  ): Promise<{ messages: RawMessageEnvelope[]; hasMore: boolean; nextCursor: string | null }> {
    return {
      messages: [
        {
          type: 1,
          threadId: groupId,
          isSelf: false,
          data: {
            msgId: 'm-1',
            cliMsgId: 'c-1',
            msgType: 'webchat',
            uidFrom: 'u-friend-1',
            idTo: groupId,
            dName: 'Friend 1',
            ts: '1700000000000',
            content: 'Hello from group',
          },
        },
      ],
      hasMore: false,
      nextCursor: null,
    };
  }

  public async undoMessage(): Promise<void> {}
  public async deleteMessage(): Promise<void> {}
  public async addReaction(message: Message, reaction: Reaction | string): Promise<void> {
    this.reactions.push({ messageId: message.id, reaction: String(reaction) });
  }
  public async markSeen(): Promise<void> {}

  public async uploadAttachment(sources: readonly MediaInput[]): Promise<RawUploadedMediaLike[]> {
    return sources.map((_, i) => ({
      fileType: 'others',
      fileId: `f-${i}`,
      fileUrl: `https://cdn/f-${i}.pdf`,
      fileName: `f-${i}.pdf`,
      totalSize: 512,
    }));
  }

  public async getAccountSettings(): Promise<RawUserSetting> {
    return { show_online_status: true, display_seen_status: 1, setting_2FA_status: 1 };
  }

  public async updateLanguage(): Promise<void> {}

  public startListening(handlers: TransportListenerHandlers): void {
    this.listenerHandlers = handlers;
    this.listening = true;
    handlers.onConnected({ connected: true });
  }

  public stopListening(): void {
    this.listening = false;
  }
}
