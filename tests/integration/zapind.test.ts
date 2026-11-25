import { describe, expect, it, vi } from 'vitest';
import {
  CloseReason,
  MemorySessionStore,
  Reaction,
  ThreadType,
  Zapind,
  noopLogger,
} from '../../src/index.js';
import { MockTransport } from './mock-transport.js';

describe('Zapind end-to-end integration (MockTransport)', () => {
  it('auto-restores session and falls back to QR login when expired', async () => {
    const store = new MemorySessionStore();
    const authEvents: string[] = [];

    // First login: no session -> emits auth.required(no_session) -> QR login -> saves session
    const t1 = new MockTransport();
    const c1 = new Zapind({ session: store, transport: t1, logger: noopLogger, rateLimit: false });
    c1.on('auth.required', (e) => {
      authEvents.push(e.reason);
    });
    const s1 = await c1.login();
    expect(s1.accountId).toBe('u-me');
    expect(authEvents).toEqual(['no_session']);

    // Second login: valid session -> restores without QR
    const t2 = new MockTransport();
    const c2 = new Zapind({ session: store, transport: t2, logger: noopLogger, rateLimit: false });
    const onQR = vi.fn();
    await c2.login({ onQRCode: onQR });
    expect(onQR).not.toHaveBeenCalled();

    // Third login: expired session -> emits auth.required(session_expired) -> falls back to QR
    const t3 = new MockTransport();
    t3.failCredentialLogin = true;
    const c3 = new Zapind({ session: store, transport: t3, logger: noopLogger, rateLimit: false });
    c3.on('auth.required', (e) => {
      authEvents.push(e.reason);
    });
    await c3.login({ onQRCode: onQR });
    expect(onQR).toHaveBeenCalledTimes(1);
    expect(authEvents).toEqual(['no_session', 'session_expired']);
  });

  it('auto-resolves threadType and supports contextual objects (user, group, conversation, message)', async () => {
    const transport = new MockTransport();
    const client = new Zapind({ transport, logger: noopLogger, rateLimit: false });
    await client.login();

    // Auto-resolves group ID without manual ThreadType!
    await client.messages.send('g-100', 'Hello group');
    expect(transport.sentMessages[0]?.threadType).toBe(ThreadType.Group);

    // Auto-resolves user ID without manual ThreadType!
    await client.messages.send('u-42', 'Hello user');
    expect(transport.sentMessages[1]?.threadType).toBe(ThreadType.User);

    // Contextual User object
    const user = await client.users.get('u-42');
    expect(user).not.toBeNull();
    await user!.send('Direct from user.send');
    expect(transport.sentMessages[2]?.threadType).toBe(ThreadType.User);

    // Contextual Group object
    const group = await client.groups.get('g-100');
    await group.send('Direct from group.send');
    expect(transport.sentMessages[3]?.threadType).toBe(ThreadType.Group);

    // Contextual Conversation object
    const conv = await client.conversations.get('g-100');
    expect(conv.isGroup).toBe(true);
    await conv.send({ text: 'From conv', link: { url: 'https://example.com' } });
    expect(transport.sentMessages[4]?.payload.link?.url).toBe('https://example.com');

    // Contextual Message object (reply + react)
    const history = await group.getMessages(10);
    const msg = history.items[0]!;
    await msg.reply('Replying!');
    expect(transport.sentMessages[5]?.payload.replyTo?.id).toBe('m-1');
    await msg.react(Reaction.Heart);
    expect(transport.reactions[0]).toEqual({ messageId: 'm-1', reaction: Reaction.Heart });

    // Escape hatch: client.raw exposes underlying API
    expect(client.raw).toBe(transport.rawApiMarker);
  });

  it('caches user/group lookups and deduplicates concurrent requests', async () => {
    const transport = new MockTransport();
    const client = new Zapind({ transport, logger: noopLogger, rateLimit: false });
    await client.login();

    // 3 concurrent calls -> 1 network request
    await Promise.all([
      client.users.get('u-1'),
      client.users.get('u-1'),
      client.users.get('u-1'),
    ]);
    expect(transport.userInfoCalls).toBe(1);

    // Cached hit -> still 1 network request
    await client.users.get('u-1');
    expect(transport.userInfoCalls).toBe(1);

    // Group cache + invalidation on rename
    await client.groups.get('g-100');
    await client.groups.get('g-100');
    expect(transport.groupInfoCalls).toBe(1);

    await client.groups.rename('g-100', 'New Name');
    await client.groups.get('g-100');
    expect(transport.groupInfoCalls).toBe(2);
  });

  it('dispatches normalized realtime events and supports multi-account isolation', async () => {
    const tA = new MockTransport();
    tA.ownId = 'bot-A';
    const tB = new MockTransport();
    tB.ownId = 'bot-B';

    const clientA = new Zapind({ transport: tA, logger: noopLogger, rateLimit: false });
    const clientB = new Zapind({ transport: tB, logger: noopLogger, rateLimit: false });
    await Promise.all([clientA.login(), clientB.login()]);

    const received: string[] = [];
    const expired = vi.fn();
    clientA.on('message', async (msg) => {
      received.push(`${msg.sender.id}:${msg.text}`);
      await msg.reply('auto-reply');
    });
    clientA.on('auth.required', expired);
    clientA.startListening();

    tA.listenerHandlers?.onMessage({
      type: ThreadType.Group,
      threadId: 'g-100',
      isSelf: false,
      data: {
        msgId: 'm-9',
        cliMsgId: 'c-9',
        uidFrom: 'u-99',
        idTo: 'g-100',
        ts: '1700000000000',
        content: 'ping',
      },
    });
    tA.listenerHandlers?.onDisconnected({ connected: false, code: CloseReason.KickConnection });

    await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual(['u-99:ping']);
    expect(tA.sentMessages[0]?.payload.text).toBe('auto-reply');
    expect(expired).toHaveBeenCalledTimes(1);

    // clientB remains completely unaffected
    expect(clientB.isAuthenticated()).toBe(true);
    expect(clientB.account.getOwnId()).toBe('bot-B');
  });
});
