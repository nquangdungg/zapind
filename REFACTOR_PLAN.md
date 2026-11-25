# REFACTOR_PLAN.md — Refactoring `zca-js` into `zapid`

> **Audited Engine:** `zca-js` v2.4.0 (cloned at `C:\Users\nquan\Desktop\zapid` — 174 API modules, 24 models, 5 error classes, 4 sync modules).
> **Target Package:** `zapid` (JavaScript / TypeScript SDK in `d:\Documents\GitHub\zapid`, remote `https://github.com/nquangdungg/zapid.git`).
> **Strategy:** Keep `zca-js` as an encapsulated internal transport engine (`dependencies: { "zca-js": "^2.4.0" }`), build a clean developer-first SDK (`Zapid`) on top, and retain `client.raw` as an explicit escape hatch for 100% low-level control.

---

## 1. Key Findings from Full `zca-js` v2.4.0 Audit

1. **High Parameter Friction (`ThreadType` everywhere):** 30 out of 174 APIs (`sendMessage`, `addReaction`, `undo`, `deleteMessage`, `sendSeenEvent`, `sendTypingEvent`, `uploadAttachment`, `sendLink`, `sendSticker`, `sendVoice`, `sendVideo`, `setMute`, `setPinnedConversations`, `deleteChat`, etc.) force the caller to pass `ThreadType.User | ThreadType.Group` manually on every call.
2. **No Contextual Domain Objects:** `getUserInfo`, `getGroupInfo`, and `listener.on("message")` return raw DTOs (`msg.data.content`, `msg.data.ts` as string, `msg.data.uidFrom`, `gridInfoMap[groupId]`). Developers cannot do `user.send(...)`, `group.send(...)`, `conversation.send(...)`, or `message.reply(...)`.
3. **Manual Session Lifecycle:** `zalo.loginQR` and `zalo.login` have no session persistence. Developers must wire `GotLoginInfo` callbacks, serialize cookies/IMEI/userAgent manually, detect expired sessions, and handle fallback login.
4. **Flat Error Model:** Almost all HTTP, auth, validation, rate-limit, and network failures collapse into generic `ZaloApiError`.
5. **Performance & Resource Bottlenecks Observed in `zca-js`:**
   - `zalo.login()` runs `await checkUpdate(ctx)` (external HTTP call to npm registry) on every login unless `checkUpdate: false`.
   - `CallbacksMap.set()` (`src/context.ts:187`) schedules `setTimeout` without `.unref()`, which can keep Node.js event loops alive.
   - Repeated `getGroupInfo` / `getUserInfo` / `getAllGroups` calls trigger redundant network requests because there is no TTL cache or in-flight request deduplication.
   - `Listener` creates deprecated single-callback slots alongside EventEmitter and emits unnormalized protocol payloads.
   - `zca-js/index.d.ts` uses `export * from "./dist"` (no `.js` extension), causing TypeScript `NodeNext` friction unless handled via bundler resolution.

---

## 2. Classification Matrix (A / B / C / D)

### A. Có thể tự động hóa ngay (Automate Immediately)

| Concern | `zca-js` Manual Burden | `zapid` Automation |
|---|---|---|
| `threadType` | Passed manually to 30 APIs | Auto-resolved via contextual object (`UserModel`/`GroupModel`/`ConversationModel`/`MessageModel`) or cached `ThreadTypeRegistry` (lazy `getAllGroups()` + incoming event learning). Explicit override still supported. |
| Message payload normalization | `{ msg, quote, attachments, mentions, styles }` vs `sendLink`/`sendSticker`/`sendVoice`/`sendVideo` | Unified `client.messages.send(target, "text" \| SendPayload)` with automatic routing for text, attachments, quote (`replyTo`), mentions, styles, link, sticker, voice, video. |
| ID extraction | Caller extracts `msg.threadId`, `msg.data.msgId`, `msg.data.cliMsgId`, `msg.data.uidFrom` | Methods accept either string IDs or rich model objects (`user`, `group`, `conversation`, `message`). |
| Response parsing | Unwrap `gridInfoMap[id]`, `changed_profiles[id]`, `ts: string`, `e2ee: 0\|1`, `isFr: 0\|1` | Normalized immutable public models with `Date`, `boolean`, and clean field names. |
| Default options | `userAgent`, `language`, `checkUpdate`, `logging`, `timeout` | Sensible defaults (`checkUpdate: false`, `logging: false`, 15s timeout, 180s QR timeout, safe rate limiter). |
| Session lookup & restore | Manual `fs.readFile` + `login()` + fallback to `loginQR()` | `new Zapid({ session: "./session.json" })` + `await client.login()` auto-restores, validates, and falls back to QR login. |
| Error normalization | Raw `ZaloApiError` / Node `fetch` / `ws` errors | Mapped to `ZapidError` hierarchy (`AuthenticationError`, `SessionError`, `NetworkError`, `RateLimitError`, `ValidationError`, `PermissionError`, `NotFoundError`, `APIError`). |

### B. Có thể abstraction (Domain & Contextual Abstractions)

- **Facade:** `Zapid` class (multi-account, zero singletons).
- **Domain Namespaces:** `client.account`, `client.users`, `client.contacts`, `client.groups`, `client.conversations`, `client.messages`, `client.media`, `client.settings`, `client.events`.
- **Contextual Models (Objects with Behavior):**
  - `User` (`user.send()`, `user.block()`, `user.unblock()`, `user.sendFriendRequest()`)
  - `Contact` (`contact.send()`, `contact.setAlias()`, `contact.remove()`)
  - `Group` (`group.send()`, `group.getMessages()`, `group.addMembers()`, `group.removeMembers()`, `group.rename()`, `group.leave()`)
  - `Conversation` (`conversation.send()`, `conversation.getMessages()`, `conversation.sendTyping()`, `conversation.pin()`, `conversation.mute()`)
  - `Message` (`message.text`, `message.sender`, `message.conversation`, `message.timestamp`, `message.replyTo`, `message.reply()`, `message.react()`, `message.undo()`, `message.delete()`, `message.markSeen()`)
- **Unified Event System:** `message`, `reaction`, `group.update`, `user.update`, `typing`, `seen`, `undo`, `auth.required`, `connected`, `disconnected`, `error`.
- **Session Storage:** `SessionStore` interface (`MemorySessionStore`, `FileSessionStore`, `EncryptedFileSessionStore`) + shorthand `{ session: "./session.json" }`.

### C. Không nên abstraction (Keep Low-Level via `client.raw`)

- Raw WebSocket frames (`listener.sendWs`), `cipher_key`, `sync_event`, `custom()` API factory.
- Niche Zalo Business / Banking / Product Catalog / Auto-Reply / QuickMessage / Poll / Board / Reminder / Sticker Pack endpoints — exposed cleanly via `client.raw` without bloating core abstractions until needed.
- Raw `zpwServiceMap` and `ContextSession` internals.

### D. API nguy hiểm cần giữ nguyên behavior (Protocol-Sensitive / Careful Handling)

- **Non-idempotent writes (`sendMessage`, `uploadAttachment`, `createGroup`, `disperseGroup`, `leaveGroup`):** Never auto-retry on unknown failure to prevent duplicate messages or unintended destructive actions.
- **`logout()`:** Zalo Web has no verified server-side revocation endpoint in `zca-js`; `logout()` stops listener, clears caches, and clears local session store (documented explicitly).
- **`getConversations()`:** `zca-js` v2.4.0 has no single unified inbox REST endpoint; `conversations` namespace provides `get(id)`, `getMessages(groupId)`, `getPinned()`, `getUnread()`, `pin()`, `mute()`, `sendTyping()`, and clearly documents the DM history limitation rather than fabricating data.
- **Image uploads without metadata:** `zca-js` requires `imageMetadataGetter` when passing image file paths; surface a clear `ValidationError` / `APIError` rather than silently failing.

---

## 3. Target Architecture (`d:\Documents\GitHub\zapid`)

```text
Public API (Zapid)
  ├── Domain Services (account, users, contacts, groups, conversations, messages, media, settings)
  ├── Contextual Models (User, Contact, Group, Conversation, Message)
  ├── Event Bus (events / client.on)
  ├── Session Manager & Stores (Memory / File / EncryptedFile)
  ├── Performance & Resilience Layer (TTLCache, InFlightDeduplicator, ThreadTypeRegistry, Timeout, Retry, RateLimiter, RedactingLogger)
  ├── Error Hierarchy (ZapidError + subclasses)
  ├── Escape Hatch (client.raw)
  └── Transport Layer (TransportAdapter -> ZcaTransport wrapping zca-js)
```

---

## 4. Verification & Benchmark Plan

- Unit tests: errors, mappers, TTLCache, ThreadTypeRegistry, policies, session stores, event bus.
- Integration tests (`MockTransport`): full `Zapid` flows including contextual objects (`user.send`, `group.send`, `conversation.send`, `message.reply`, `message.react`), automatic `threadType` resolution, session auto-restore/fallback, error normalization, and multi-account isolation.
- Benchmark (`tests/benchmark.ts`): real measured performance of `TTLCache` + `InFlightDeduplicator` + `ThreadTypeRegistry` + message normalization throughput.
- Full verification gate before commit & push: `typecheck` → `lint` → `test` → `build` → ESM & CJS runtime import checks → clean git push to `https://github.com/nquangdungg/zapid`.
