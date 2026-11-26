# ZAPIND Issue Tracker

Tracked SDK issues discovered during the continuous audit of `zapind` while rebuilding `zalo-meet-clean`.

---

## Summary Table

| ID | Date discovered | Affected version | Area | Severity | Status | Origin |
|---|---|---|---|---|---|---|
| ZAPIND-001 | 2026-11-26 | `1.0.0` | Messaging / History | CRITICAL | VERIFIED | Previously observed / confirmed |
| ZAPIND-002 | 2026-11-26 | `1.0.0` | Realtime / Listener | HIGH | VERIFIED | Newly discovered |
| ZAPIND-003 | 2026-11-26 | `1.0.0` | Realtime / Messaging | HIGH | VERIFIED | Previously observed / confirmed |
| ZAPIND-004 | 2026-11-26 | `1.0.0` | Errors / Retry Policy | HIGH | VERIFIED | Previously observed / confirmed |
| ZAPIND-005 | 2026-11-26 | `1.0.0` | Mappers / Events | MEDIUM | VERIFIED | Newly discovered |
| ZAPIND-006 | 2026-11-26 | `1.0.0` | Authentication | MEDIUM | VERIFIED | Previously observed / confirmed |
| ZAPIND-007 | 2026-11-26 | `1.0.0` | Conversations / Types | MEDIUM | VERIFIED | Newly discovered |

---

## Issue — ZAPIND-001

- **ID**: ZAPIND-001
- **Date discovered**: 2026-11-26
- **Affected version**: `1.0.0`
- **Area**: Messaging / History
- **Severity**: CRITICAL
- **Status**: VERIFIED
- **Origin**: Previously observed / confirmed (live 404 on `192.168.1.47`)
- **Title**: `conversations.getMessages()` and `group.getMessages()` fail with HTTP 404 due to deprecated `/api/group/history` endpoint
- **Observed behavior**: Calling `client.conversations.getMessages(groupId, 50)` or `group.getMessages(50)` fails on every group conversation with `Request failed with status code 404`.
- **Expected behavior**: Returns real group message history with pagination metadata (`hasMore`, `nextCursor`, `isOld`).
- **Reproduction steps**:
  1. Authenticate `Zapind@1.0.0` with a valid Zalo session.
  2. Call `await client.conversations.getMessages(validGroupId, 50)`.
- **Application layer**: `src/api/routes/chat.js`
- **Zapind API/function**: `ZcaTransport.getGroupChatHistory()` / `ConversationsService.getMessages()`
- **Input**: `groupId = "1135182446573383566", count = 50`
- **Actual output**: Throws `APIError: Request failed with status code 404`
- **Expected output**: `MessagePage` containing up to 50 normalized `Message` objects and pagination cursor.
- **Error**: `Request failed with status code 404`
- **Root cause**: `ZcaTransport.getGroupChatHistory()` called `zca-js`'s deprecated `api.getGroupChatHistory()` (`/api/group/history`), which Zalo removed. `zca-js` replaced it with `api.getCloudMessage()` (`/api/cm/getrecentv2` and `/api/cm/getoldv2`).
- **Classification**: ZAPIND (driven by ZALO endpoint removal)
- **Fix**: Switched `ZcaTransport.getGroupChatHistory()` to `api.getCloudMessage(groupId, cursor, { isOld })`, handled Zalo stop-paging code `-69` cleanly, and added backward-compatible `GetMessagesOptions` (`{ count?, cursor?, isOld? }`) + `MessagePage.isOld`.
- **Files changed**: `src/transport/zca.transport.ts`, `src/transport/adapter.ts`, `src/services/index.ts`, `src/models/entities.ts`, `src/zapind.ts`, `src/index.ts`
- **Tests**: `tests/unit/sdk-regressions.test.ts` (`ZAPIND-001`)
- **Regression result**: PASS
- **Application impact**: Removed `z.raw.getCloudMessage` workaround in `zalo-meet-clean`; real group history & pagination now run natively through `zapind`.

---

## Issue — ZAPIND-002

- **ID**: ZAPIND-002
- **Date discovered**: 2026-11-26
- **Affected version**: `1.0.0`
- **Area**: Realtime / Event Listener
- **Severity**: HIGH
- **Status**: VERIFIED
- **Origin**: Newly discovered (source audit of `zca.transport.ts`)
- **Title**: `ZcaTransport.stopListening()` leaks underlying listeners (causing duplicates on restart) and `closed` leaves `listenerAttached = true` (deadlocking reconnect)
- **Observed behavior**:
  1. Calling `stopListening()` then `startListening()` attaches a second set of anonymous listeners onto `api.listener`, causing every event to fire 2×, 3×, N×.
  2. When the WS emits `closed` (without `retryOnClose`), `Zapind.listening` resets to `false`, but `ZcaTransport.listenerAttached` stays `true`, causing subsequent `client.startListening()` calls to return early without starting `api.listener`.
- **Expected behavior**: `stopListening()` and non-retry `closed` cleanly detach all registered callbacks from `api.listener` so restart/reconnect works cleanly with exactly 1 listener per event.
- **Reproduction steps**: Call `startListening()`, then `stopListening()`, then `startListening()`, emit a message → handler fires twice. Or emit `closed` then call `startListening()` → `api.listener.start()` is never called again.
- **Application layer**: `src/zalo/client.js`
- **Zapind API/function**: `ZcaTransport.startListening()`, `ZcaTransport.stopListening()`
- **Input**: Lifecycle sequence `startListening -> stopListening -> startListening` and `startListening -> closed -> startListening`
- **Actual output**: Duplicate handler invocations / no-op reconnect.
- **Expected output**: Exactly 1 invocation per event; clean restart after close.
- **Error**: Silent duplicate events / silent dead listener.
- **Root cause**: `startListening()` registered inline anonymous callbacks without storing references or removing them via `off()` in `stopListening()` / `closed`.
- **Classification**: ZAPIND
- **Fix**: Added `attachListener()` and `detachListeners()` tracking bound `[event, fn]` pairs and calling `api.listener.off(event, fn)` on `stopListening()` and non-retry `closed`.
- **Files changed**: `src/transport/zca.transport.ts`
- **Tests**: `tests/unit/sdk-regressions.test.ts` (`ZAPIND-002`)
- **Regression result**: PASS
- **Application impact**: Eliminates duplicate event firing and silent reconnect lockups.

---

## Issue — ZAPIND-003

- **ID**: ZAPIND-003
- **Date discovered**: 2026-11-26
- **Affected version**: `1.0.0`
- **Area**: Realtime / Messaging
- **Severity**: HIGH
- **Status**: VERIFIED
- **Origin**: Previously observed / confirmed (needed for 1:1 DM history in `zalo-meet-clean`)
- **Title**: No first-class SDK support for WebSocket `old_messages` event or `requestOldMessages()`
- **Observed behavior**: Applications could not sync recent 1:1 DM history (or WS-buffered group messages) through `zapind`'s public API and had to access `client.raw.listener`.
- **Expected behavior**: `zapind` exposes typed `'old_messages'` event (`OldMessagesEvent`) and `conversations.requestOldMessages(threadType, lastMsgId?)`.
- **Reproduction steps**: Attempt to load 1:1 DM history via `zapind` public APIs without `client.raw`.
- **Application layer**: `src/zalo/history.js`
- **Zapind API/function**: `Zapind.on('old_messages')`, `ConversationsService.requestOldMessages()`
- **Input**: `ThreadType.User` / `ThreadType.Group`
- **Actual output**: Missing from `ZapindEventMap` and `ConversationsService`.
- **Expected output**: `requestOldMessages()` triggers WS sync and `'old_messages'` emits normalized `Message[]`.
- **Error**: Missing SDK abstraction.
- **Root cause**: `ZcaTransport.startListening()` did not bind `api.listener.on('old_messages')` or expose `requestOldMessages()`.
- **Classification**: ZAPIND
- **Fix**: Bound `old_messages` in `ZcaTransport`, added `OldMessagesEvent` to `ZapindEventMap`, and exposed `conversations.requestOldMessages()` + `events.requestOldMessages()`.
- **Files changed**: `src/transport/zca.transport.ts`, `src/transport/adapter.ts`, `src/models/events.ts`, `src/services/index.ts`, `src/zapind.ts`, `src/index.ts`
- **Tests**: `tests/unit/sdk-regressions.test.ts` (`ZAPIND-003`)
- **Regression result**: PASS
- **Application impact**: Removed `z.raw.listener` escape hatch in `zalo-meet-clean`.

---

## Issue — ZAPIND-004

- **ID**: ZAPIND-004
- **Date discovered**: 2026-11-26
- **Affected version**: `1.0.0`
- **Area**: Errors / Retry Policy
- **Severity**: HIGH
- **Status**: VERIFIED
- **Origin**: Previously observed / confirmed (live 429 on `192.168.1.47`)
- **Title**: `normalizeError()` fails to classify HTTP 429/404/401/403/5xx from `zca-js` error messages, disabling automatic retries on 429/5xx
- **Observed behavior**: `zca-js` threw `Error("Request failed with status code 429")` without an `.status` property; `zapind` classified it as `APIError` with `retryable: false`, so `PolicyExecutor` never retried.
- **Expected behavior**: HTTP 429 → `RateLimitError` (`retryable: true`), 404 → `NotFoundError`, 401 → `SessionError`, 403 → `PermissionError`, 5xx → retryable `APIError`.
- **Reproduction steps**: Pass `new Error("Request failed with status code 429")` to `normalizeError()`.
- **Application layer**: `src/api/routes/chat.js` (`contacts.list`)
- **Zapind API/function**: `normalizeError()`
- **Input**: `Error("Request failed with status code 429")`
- **Actual output**: `APIError { code: 'API_ERROR', retryable: false }`
- **Expected output**: `RateLimitError { code: 'RATE_LIMIT_ERROR', retryable: true }`
- **Error**: `Request failed with status code 429`
- **Root cause**: `normalizeError()` only checked `e.status` and specific English phrases, not `e.statusCode`, `e.response?.status`, or `/status code (\d{3})/i` in `e.message`.
- **Classification**: ZAPIND
- **Fix**: Extracted HTTP status from `.status`, `.statusCode`, `.response?.status`, and regex `/status code\s+(\d{3})/i` in `normalizeError()`.
- **Files changed**: `src/errors/index.ts`
- **Tests**: `tests/unit/sdk-regressions.test.ts` (`ZAPIND-004`)
- **Regression result**: PASS
- **Application impact**: Transient 429 and 5xx errors from Zalo are now automatically retried with exponential backoff by `PolicyExecutor`.

---

## Issue — ZAPIND-005

- **ID**: ZAPIND-005
- **Date discovered**: 2026-11-26
- **Affected version**: `1.0.0`
- **Area**: Mappers / Events
- **Severity**: MEDIUM
- **Status**: VERIFIED
- **Origin**: Newly discovered (source audit of `mappers/index.ts` & `zca.transport.ts`)
- **Title**: `mapMessageData()` drops `quote.fromD` (`senderName`) and `seen_messages` drops `realMsgId`/`msgId`
- **Observed behavior**: Reply quotes lacked the quoted sender's display name (`fromD`), and `SeenEvent.messageIds` was empty when `zca-js` provided `realMsgId` or `msgId` instead of array `idTo`.
- **Expected behavior**: `MessageQuote.senderName` preserves `quote.fromD`; `SeenEvent.messageIds` includes `realMsgId`/`msgId`.
- **Reproduction steps**: Map a raw message containing `data.quote.fromD = "Alice"`; emit `seen_messages` with `{ realMsgId: "m-55", seenUids: ["u1"] }`.
- **Application layer**: `src/messages/service.js`
- **Zapind API/function**: `mapMessageData()`, `ZcaTransport.startListening()` (`seen_messages`)
- **Input**: Raw quote with `fromD`, raw `seen_messages` with `realMsgId`
- **Actual output**: `replyTo.senderName === undefined`, `seenEvent.messageIds === []`
- **Expected output**: `replyTo.senderName === "Alice"`, `seenEvent.messageIds === ["m-55"]`
- **Error**: Missing metadata fields at runtime.
- **Root cause**: Omitted `fromD` field in `RawMessageEnvelope`/`MessageQuote`, and wrong property lookup (`d.idTo` array) in `seen_messages` handler.
- **Classification**: ZAPIND
- **Fix**: Added optional `senderName?: string` to `MessageQuote`, mapped `data.quote.fromD`, and parsed `realMsgId` / `msgId` (string or array) in `seen_messages`.
- **Files changed**: `src/models/entities.ts`, `src/mappers/index.ts`, `src/transport/zca.transport.ts`
- **Tests**: `tests/unit/sdk-regressions.test.ts` (`ZAPIND-005`)
- **Regression result**: PASS
- **Application impact**: Reply quotes now carry sender names natively from `zapind`.

---

## Issue — ZAPIND-006

- **ID**: ZAPIND-006
- **Date discovered**: 2026-11-26
- **Affected version**: `1.0.0`
- **Area**: Authentication
- **Severity**: MEDIUM
- **Status**: VERIFIED
- **Origin**: Previously observed / confirmed (blocked HTTP startup in `zalo-meet-clean`)
- **Title**: `login()` always falls back to 3-minute blocking QR login with no restore-only mode
- **Observed behavior**: Calling `client.login()` on startup when a saved session is missing or expired blocks for up to 180 seconds waiting for a QR scan.
- **Expected behavior**: Callers can pass `login({ sessionOnly: true })` to attempt session restoration and fail fast with `SessionError` if unavailable.
- **Reproduction steps**: Instantiate `Zapind` with empty `MemorySessionStore` and call `client.login()` → blocks in `loginWithQR()`.
- **Application layer**: `src/zalo/client.js` (`tryRestoreSession`)
- **Zapind API/function**: `Zapind.login(options)`
- **Input**: `{ sessionOnly: true }`
- **Actual output**: Previously unavailable; always entered `loginWithQR()`.
- **Expected output**: Throws `SessionError` immediately without invoking `loginWithQR()`.
- **Error**: Unintended blocking QR flow on server boot.
- **Root cause**: `LoginOptions` had `forceQR` but no `sessionOnly` option.
- **Classification**: ZAPIND
- **Fix**: Added optional `sessionOnly?: boolean` to `LoginOptions` (default `false` for backward compatibility).
- **Files changed**: `src/models/session.ts`, `src/zapind.ts`
- **Tests**: `tests/unit/sdk-regressions.test.ts` (`ZAPIND-006`)
- **Regression result**: PASS
- **Application impact**: `zalo-meet-clean` startup restoration is now fast, deterministic, and non-blocking.

---

## Issue — ZAPIND-007

- **ID**: ZAPIND-007
- **Date discovered**: 2026-11-26
- **Affected version**: `1.0.0`
- **Area**: Conversations / Types
- **Severity**: MEDIUM
- **Status**: VERIFIED
- **Origin**: Newly discovered (source audit of `models/entities.ts`)
- **Title**: `Conversation.getMessages()` silently dispatches group history API even on 1:1 User conversations
- **Observed behavior**: Calling `dmConversation.getMessages()` called `getGroupChatHistory(userId)` which failed with a cryptic API error.
- **Expected behavior**: Fails fast with a descriptive `ValidationError` pointing developers to `'old_messages'` + `conversations.requestOldMessages(ThreadType.User)`.
- **Reproduction steps**: `const c = await client.conversations.get(userId, ThreadType.User); await c.getMessages();`
- **Application layer**: `src/api/routes/chat.js`
- **Zapind API/function**: `Conversation.getMessages()`
- **Input**: `Conversation` with `threadType === ThreadType.User`
- **Actual output**: Calls group cloud history endpoint with a user ID.
- **Expected output**: Rejects with `ValidationError`.
- **Error**: Confusing upstream Zalo API error.
- **Root cause**: `Conversation.getMessages()` delegated unconditionally to `this.actions.getGroupMessages()`.
- **Classification**: ZAPIND
- **Fix**: Added `this.threadType !== ThreadType.Group` guard returning rejected `ValidationError`.
- **Files changed**: `src/models/entities.ts`
- **Tests**: `tests/unit/sdk-regressions.test.ts` (`ZAPIND-007`)
- **Regression result**: PASS
- **Application impact**: Clear contract separating Group Cloud REST history vs DM WebSocket history.
