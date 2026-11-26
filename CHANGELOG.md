# Changelog

All notable changes to `zapind` are documented in this file.

## [1.0.1] - 2026-11-26

### Fixed
- **Cloud Message History (`ZAPIND-001`)**: Replaced deprecated `zca-js` `getGroupChatHistory` (`/api/group/history`, which Zalo removed with HTTP 404) with `getCloudMessage` (`/api/cm/getrecentv2` and `/api/cm/getoldv2`). Handled Zalo stop-paging code `-69` cleanly by returning an empty page with `hasMore: false`.
- **Realtime Listener Leak & Reconnect Deadlock (`ZAPIND-002`)**: `ZcaTransport.stopListening()` and non-retry `closed` events now detach all registered `api.listener` callbacks before clearing `listenerAttached`. Prevents duplicate event handlers across stop/start cycles and unblocks clean reconnection after unexpected disconnects.
- **HTTP Error Classification (`ZAPIND-004`)**: `normalizeError()` now extracts HTTP status codes from error message strings (`"Request failed with status code 429"`, `404`, `401`, `403`, `5xx`) in addition to explicit `.status` properties, ensuring HTTP 429 maps to retryable `RateLimitError`, 404 to `NotFoundError`, 401 to `SessionError`, 403 to `PermissionError`, and 5xx to retryable `APIError`.
- **Quote & Seen Event Mapping (`ZAPIND-005`)**: Mapped `quote.fromD` onto optional `MessageQuote.senderName`, and fixed `seen_messages` parsing to extract `realMsgId` / `msgId` into `SeenEvent.messageIds`.
- **DM `Conversation.getMessages()` Guard (`ZAPIND-007`)**: Calling `conversation.getMessages()` on a 1:1 `ThreadType.User` conversation now throws a clear `ValidationError` explaining that REST cloud history is group-only and pointing to `'old_messages'` + `conversations.requestOldMessages(ThreadType.User)`.

### Added
- **Pagination Options on `getMessages()`**: `conversations.getMessages(groupId, options)` and `group.getMessages(options)` now accept either legacy `count: number` or `GetMessagesOptions` (`{ count?, cursor?, isOld? }`) and return `isOld?: boolean` on `MessagePage`.
- **WebSocket Historical Sync (`ZAPIND-003`)**: Added typed `'old_messages'` event (`OldMessagesEvent`) on `ZapindEventMap` and `conversations.requestOldMessages(threadType, lastMsgId?)` (also aliased on `client.events.requestOldMessages`).
- **Restore-Only Login (`ZAPIND-006`)**: Added optional `sessionOnly?: boolean` to `LoginOptions` so servers can attempt restoring a saved session without blocking on a 3-minute QR fallback.

### Compatibility
- Fully backward-compatible with `1.0.0` (no breaking changes).

## [1.0.0] - 2026-11-26
- Initial stable release of `zapind`.
