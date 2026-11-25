# Zapid

**Developer-friendly, type-safe, contextual Zalo SDK for JavaScript & TypeScript** — powered by `zca-js` under the hood.

Zapid wraps `zca-js` with a clean domain-oriented API, automatic `threadType` resolution, contextual objects (`user.send()`, `group.send()`, `conversation.send()`, `message.reply()`), built-in session management, unified error hierarchy, caching, request deduplication, and full access to the low-level engine via `client.raw`.

---

## Installation

```bash
npm install zapid
```

Requires **Node.js >= 20**.

---

## Quick Start

```ts
import { Zapid, Reaction } from "zapid";

const client = new Zapid({
  session: "./session.json",
});

await client.login({
  onQRCode: ({ imageDataUrl }) => console.log("Scan QR:", imageDataUrl),
});

client.on("message", async (message) => {
  console.log(`${message.sender.name ?? message.sender.id}: ${message.text}`);

  if (message.text === "!ping") {
    await message.reply("pong!");
    await message.react(Reaction.Heart);
  }
});

client.startListening({ retryOnClose: true });
```

---

## Authentication

`client.login()` automatically handles the full session lifecycle:
1. Restores saved credentials from `session` if present and validates them.
2. If no session exists or the session expired, emits `"auth.required"` and falls back to QR login.
3. Saves the fresh session automatically.

```ts
const client = new Zapid({
  session: "./session.json",
});

client.on("auth.required", ({ reason }) => {
  console.log("Authentication required:", reason);
});

const session = await client.login({
  onQRCode: ({ imageDataUrl }) => console.log("QR Data URL:", imageDataUrl),
  onScanned: ({ displayName }) => console.log("Scanned by:", displayName),
});

console.log("Logged in as:", session.accountId, session.displayName);
```

---

## Sending Messages

No need to manually pass `ThreadType.User` or `ThreadType.Group` — Zapid resolves `threadType` automatically from contextual objects or its cached Group ID registry.

```ts
// Plain text (auto-detects DM vs Group)
await client.messages.send(userId, "Hello!");
await client.messages.send(groupId, "Hello group!");

// Unified rich payload
await client.messages.send(groupId, {
  text: "Check this out",
  replyTo: incomingMessage,
  mentions: [{ userId: "123456", pos: 0, len: 5 }],
  attachment: "./report.pdf",
});

// Send a link, sticker, voice, or video with the same API
await client.messages.send(groupId, {
  link: { url: "https://github.com/nquangdungg/zapid" },
});
```

---

## Users

```ts
const user = await client.users.get(userId);
if (user) {
  await user.send("Hi there!");
}

const byPhone = await client.users.findByPhone("0912345678");
const byUsername = await client.users.findByUsername("alice");
const lastOnline = await client.users.getLastOnline(userId);
```

---

## Contacts

```ts
const friends = await client.contacts.list({ count: 50, page: 1 });
await friends[0]?.send("Hey!");
await friends[0]?.setAlias("Teammate");

const online = await client.contacts.getOnline();
await client.contacts.sendRequest(userId, "Let's connect!");
```

---

## Groups

```ts
const groupSummaries = await client.groups.list();
const group = await client.groups.get(groupId);

await group.send("Hello everyone!");
await group.rename("Engineering Team");
await group.addMembers(["uid-1", "uid-2"]);

const history = await group.getMessages(20);
const members = await client.groups.getMembers(group.memberIds);
```

---

## Conversations

```ts
const conversation = await client.conversations.get(threadId);
await conversation.send("Hello!");
await conversation.sendTyping();
await conversation.pin(true);
await conversation.mute(3600);

const pinned = await client.conversations.getPinned();
const unread = await client.conversations.getUnread();
```

---

## Media

```ts
// Upload and inspect uploaded media metadata
const uploaded = await client.media.upload(groupId, "./document.pdf");

// Or send media directly with an optional caption
await client.media.send(groupId, "./document.pdf", "Weekly report");
```

> **Note:** When uploading local image files by path, provide `imageMetadataGetter` in `new Zapid({ imageMetadataGetter })` or pass a `Buffer` with `{ data, filename, width, height }`.

---

## Events

```ts
const unsubscribe = client.on("message", (msg) => {
  console.log(msg.text, msg.sender.id, msg.timestamp);
});

client.on("reaction", (evt) => console.log("Reaction:", evt.icon));
client.on("group.update", (evt) => console.log("Group update:", evt.groupId, evt.type));
client.on("user.update", (evt) => console.log("User update:", evt.userId, evt.type));
client.on("connected", () => console.log("Connected"));
client.on("disconnected", ({ code }) => console.log("Disconnected:", code));
client.on("error", (err) => console.error("Error:", err.code, err.message));

client.startListening({ retryOnClose: true });

// Later:
unsubscribe();
client.stopListening();
```

---

## Sessions

Zapid ships with 3 built-in `SessionStore` implementations:

- **`MemorySessionStore`** (default) — in-memory only.
- **`FileSessionStore`** (shorthand: `session: "./session.json"`) — atomic writes with `0o600` permissions on POSIX.
- **`EncryptedFileSessionStore`** — AES-256-GCM encryption at rest:

```ts
import { Zapid, EncryptedFileSessionStore } from "zapid";

const client = new Zapid({
  session: new EncryptedFileSessionStore("./session.enc.json", process.env.SESSION_KEY!),
});
```

To log out and clear local session state:

```ts
await client.logout({ clearSession: true });
```

---

## Error Handling

All errors inherit from `ZapidError`:

```ts
import {
  ZapidError,
  AuthenticationError,
  SessionError,
  NetworkError,
  RateLimitError,
  ValidationError,
  PermissionError,
  NotFoundError,
  APIError,
} from "zapid";

try {
  await client.messages.send(groupId, "Hello");
} catch (err) {
  if (err instanceof RateLimitError) {
    console.error("Rate limited, retry after:", err.retryAfterMs);
  } else if (err instanceof SessionError) {
    console.error("Session expired, re-login required");
  } else if (err instanceof ZapidError) {
    console.error(err.code, err.message);
  }
}
```

---

## Advanced / Raw API

Need a niche or low-level `zca-js` API not yet abstracted? Use `client.raw`:

```ts
import type { API } from "zca-js";

const raw = client.raw as API;
const polls = await raw.getPollDetail("poll-id");
```

---

## License

MIT
