import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  APIError,
  MemorySessionStore,
  NotFoundError,
  PermissionError,
  RateLimitError,
  SessionError,
  ThreadType,
  ValidationError,
  Zapind,
  noopLogger,
} from '../../src/index.js';
import { normalizeError } from '../../src/errors/index.js';
import { mapMessageData } from '../../src/mappers/index.js';
import { ZcaTransport } from '../../src/transport/zca.transport.js';
import { MockTransport } from '../integration/mock-transport.js';

describe('Zapind SDK Regression Suite (v1.0.1)', () => {
  // ZAPIND-001: Cloud message history + pagination + -69 stop code
  it('ZAPIND-001: uses getCloudMessage (not deprecated getGroupChatHistory) and handles code -69', async () => {
    const transport = new ZcaTransport();
    const getCloudMessage = vi.fn().mockResolvedValueOnce({
      groupMsgs: [
        {
          type: 1,
          threadId: 'g-100',
          isSelf: false,
          data: { msgId: '10', cliMsgId: 'c10', uidFrom: 'u1', idTo: 'g-100', dName: 'Alice', ts: '1700000001000', content: 'Older' },
        },
        {
          type: 1,
          threadId: 'g-100',
          isSelf: false,
          data: { msgId: '11', cliMsgId: 'c11', uidFrom: 'u2', idTo: 'g-100', dName: 'Bob', ts: '1700000002000', content: 'Newer' },
        },
      ],
      hasMore: true,
      lastMsgId: '10',
      isOld: true,
    });
    const fakeApi = { getCloudMessage };
    (transport as unknown as { api: unknown }).api = fakeApi;

    const page = await transport.getGroupChatHistory('g-100', { count: 1, cursor: '20', isOld: false });
    expect(getCloudMessage).toHaveBeenCalledWith('g-100', '20', { isOld: false });
    expect(page.messages).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('10');
    expect(page.isOld).toBe(true);

    // Code -69 means no more older messages
    getCloudMessage.mockRejectedValueOnce(Object.assign(new Error('Stop retry'), { code: -69 }));
    const endPage = await transport.getGroupChatHistory('g-100', { cursor: '10', isOld: true });
    expect(endPage.messages).toEqual([]);
    expect(endPage.hasMore).toBe(false);
    expect(endPage.nextCursor).toBeNull();
  });

  // ZAPIND-002: Listener detach on stopListening and non-retry closed prevents duplicate listeners & reconnect deadlock
  it('ZAPIND-002: detaches underlying listeners on stopListening and allows clean restart without duplicates', () => {
    const transport = new ZcaTransport();
    const fakeListener = Object.assign(new EventEmitter(), {
      start: vi.fn(),
      stop: vi.fn(),
      requestOldMessages: vi.fn(),
    });
    (transport as unknown as { api: unknown }).api = { listener: fakeListener };

    let received = 0;
    const handlers = {
      onMessage: () => {
        received += 1;
      },
      onReaction: vi.fn(),
      onGroupUpdate: vi.fn(),
      onUserUpdate: vi.fn(),
      onTyping: vi.fn(),
      onSeen: vi.fn(),
      onUndo: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onError: vi.fn(),
    };

    transport.startListening(handlers);
    expect(fakeListener.listenerCount('message')).toBe(1);

    // Stop and restart twice -> listener count must remain 1 (no duplicates)
    transport.stopListening();
    expect(fakeListener.listenerCount('message')).toBe(0);

    transport.startListening(handlers);
    expect(fakeListener.listenerCount('message')).toBe(1);

    fakeListener.emit('message', { data: { msgId: '1', content: 'hi' } });
    expect(received).toBe(1);

    // Simulate non-retry close -> detaches so subsequent startListening() succeeds
    fakeListener.emit('closed', 1006, 'network drop');
    expect(fakeListener.listenerCount('message')).toBe(0);

    transport.startListening(handlers);
    expect(fakeListener.start).toHaveBeenCalledTimes(3);
    fakeListener.emit('message', { data: { msgId: '2', content: 'after reconnect' } });
    expect(received).toBe(2);
  });

  // ZAPIND-003: old_messages event & requestOldMessages first-class support
  it('ZAPIND-003: exposes conversations.requestOldMessages and emits typed old_messages event', async () => {
    const transport = new MockTransport();
    const client = new Zapind({
      transport,
      session: new MemorySessionStore(),
      logger: noopLogger,
      rateLimit: false,
    });
    await client.login();

    const receivedOld: Array<{ count: number; threadType: ThreadType }> = [];
    client.on('old_messages', (evt) => {
      receivedOld.push({ count: evt.messages.length, threadType: evt.threadType });
    });

    client.startListening();
    client.conversations.requestOldMessages(ThreadType.User);
    expect(transport.oldMessageRequests).toEqual([{ threadType: ThreadType.User, lastMsgId: null }]);

    transport.listenerHandlers?.onOldMessages?.(
      [
        {
          type: 0,
          threadId: 'u-friend-1',
          isSelf: false,
          data: { msgId: 'dm-1', cliMsgId: 'cdm-1', uidFrom: 'u-friend-1', idTo: 'u-me', dName: 'Friend 1', ts: '1700000005000', content: 'DM history' },
        },
      ],
      ThreadType.User,
    );

    expect(receivedOld).toEqual([{ count: 1, threadType: ThreadType.User }]);
    await client.destroy();
  });

  // ZAPIND-004: normalizeError parses HTTP status codes embedded in zca-js error messages
  it('ZAPIND-004: classifies HTTP 429/404/401/403/502 embedded in error message strings', () => {
    const e429 = normalizeError(new Error('Request failed with status code 429'));
    expect(e429).toBeInstanceOf(RateLimitError);
    expect(e429.retryable).toBe(true);

    const e404 = normalizeError(new Error('Request failed with status code 404'));
    expect(e404).toBeInstanceOf(NotFoundError);
    expect(e404.retryable).toBe(false);

    const e401 = normalizeError(new Error('Request failed with status code 401'));
    expect(e401).toBeInstanceOf(SessionError);

    const e403 = normalizeError(new Error('Request failed with status code 403'));
    expect(e403).toBeInstanceOf(PermissionError);

    const e502 = normalizeError(new Error('Request failed with status code 502'));
    expect(e502).toBeInstanceOf(APIError);
    expect(e502.retryable).toBe(true);
  });

  // ZAPIND-005: mapMessageData preserves quote.fromD (senderName) and seen_messages parses realMsgId/msgId
  it('ZAPIND-005: maps quote senderName from fromD and parses seen_messages msgId', () => {
    const mapped = mapMessageData({
      type: 1,
      threadId: 'g-100',
      isSelf: false,
      data: {
        msgId: 'm-9',
        cliMsgId: 'c-9',
        uidFrom: 'u2',
        idTo: 'g-100',
        dName: 'Bob',
        ts: '1700000009000',
        content: 'Replying!',
        quote: {
          ownerId: 'u1',
          fromD: 'Alice',
          cliMsgId: 'c-1',
          globalMsgId: 'm-1',
          ts: '1700000000000',
          msg: 'Original',
        },
      },
    });
    expect(mapped.replyTo?.senderName).toBe('Alice');

    const transport = new ZcaTransport();
    const fakeListener = Object.assign(new EventEmitter(), { start: vi.fn(), stop: vi.fn() });
    (transport as unknown as { api: unknown }).api = { listener: fakeListener };
    const seenEvents: Array<{ messageIds: readonly string[]; seenBy: readonly string[] }> = [];
    transport.startListening({
      onMessage: vi.fn(),
      onReaction: vi.fn(),
      onGroupUpdate: vi.fn(),
      onUserUpdate: vi.fn(),
      onTyping: vi.fn(),
      onSeen: (evt) => seenEvents.push({ messageIds: evt.messageIds, seenBy: evt.seenBy }),
      onUndo: vi.fn(),
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onError: vi.fn(),
    });
    fakeListener.emit('seen_messages', [
      { threadId: 'g-100', type: 1, data: { realMsgId: 'm-55', seenUids: ['u1', 'u2'] } },
    ]);
    expect(seenEvents).toEqual([{ messageIds: ['m-55'], seenBy: ['u1', 'u2'] }]);
  });

  // ZAPIND-006: sessionOnly login throws SessionError instead of blocking on QR login
  it('ZAPIND-006: login({ sessionOnly: true }) rejects immediately when no saved session or expired', async () => {
    const transport = new MockTransport();
    const qrSpy = vi.spyOn(transport, 'loginWithQR');
    const client = new Zapind({
      transport,
      session: new MemorySessionStore(),
      logger: noopLogger,
      rateLimit: false,
    });

    await expect(client.login({ sessionOnly: true })).rejects.toBeInstanceOf(SessionError);
    expect(qrSpy).not.toHaveBeenCalled();
  });

  // ZAPIND-007: Conversation.getMessages rejects clearly for DM threads & supports options object for Groups
  it('ZAPIND-007: Conversation.getMessages passes pagination options for groups and rejects clearly for DMs', async () => {
    const transport = new MockTransport();
    const client = new Zapind({
      transport,
      session: new MemorySessionStore(),
      logger: noopLogger,
      rateLimit: false,
    });
    await client.login();

    const groupConv = await client.conversations.get('g-100', ThreadType.Group);
    const page1 = await groupConv.getMessages({ count: 25, cursor: 'm-50', isOld: true });
    expect(page1.items).toHaveLength(1);
    expect(transport.historyRequests[0]).toEqual({
      groupId: 'g-100',
      options: { count: 25, cursor: 'm-50', isOld: true },
    });

    const dmConv = await client.conversations.get('u-friend-1', ThreadType.User);
    await expect(dmConv.getMessages()).rejects.toBeInstanceOf(ValidationError);

    await client.destroy();
  });
});
