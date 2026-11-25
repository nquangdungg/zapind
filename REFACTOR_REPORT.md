# REFACTOR_REPORT.md — `zca-js` → `zapid`

> **Package:** `zapid@0.1.0`
> **Repository:** `https://github.com/nquangdungg/zapid` (local: `d:\Documents\GitHub\zapid`)
> **Underlying Engine:** `zca-js@^2.4.0` (audited from clone at `C:\Users\nquan\Desktop\zapid`)

---

## 1. Những gì đã thay đổi

- Đóng gói `zca-js` làm internal transport engine duy nhất tại `src/transport/zca.transport.ts`, xây dựng lớp SDK hiện đại `Zapid` phía trên theo kiến trúc phân tầng:
  `Public API (Zapid) → Contextual Models → Domain Services → Core Policies & Cache → Session Storage → TransportAdapter → zca-js`.
- Tổ chức toàn bộ public API theo 9 domain rõ ràng: `account`, `users`, `contacts`, `groups`, `conversations`, `messages`, `media`, `settings`, `events` — kèm `client.raw` cho 10% nhu cầu low-level.
- Xây dựng hệ thống **Contextual Models** (`User`, `Profile`, `Contact`, `Group`, `Conversation`, `Message`) có hành vi trực tiếp (`.send()`, `.reply()`, `.react()`, `.undo()`, `.delete()`, `.markSeen()`, `.getMessages()`, `.pin()`, `.mute()`, `.rename()`, `.leave()`, ...).
- Chuẩn hóa hệ thống lỗi (`ZapidError` + 8 subclass), hệ thống sự kiện thống nhất (`message`, `reaction`, `group.update`, `user.update`, `typing`, `seen`, `undo`, `auth.required`, `connected`, `disconnected`, `error`), và quản lý phiên tự động (`MemorySessionStore`, `FileSessionStore`, `EncryptedFileSessionStore`).

---

## 2. API cũ (`zca-js`) → API mới (`zapid`)

| Tác vụ | `zca-js` (cũ) | `zapid` (mới) |
|---|---|---|
| Khởi tạo & Login | `new Zalo()` + tự đọc file + `zalo.login()` / `zalo.loginQR()` + bắt `GotLoginInfo` | `const client = new Zapid({ session: "./session.json" }); await client.login();` |
| Gửi tin nhắn DM | `api.sendMessage({ msg: "Hi" }, userId, ThreadType.User)` | `await client.messages.send(userId, "Hi")` hoặc `await user.send("Hi")` |
| Gửi tin nhắn Group | `api.sendMessage({ msg: "Hi" }, groupId, ThreadType.Group)` | `await client.messages.send(groupId, "Hi")` hoặc `await group.send("Hi")` |
| Trả lời tin nhắn | Tự tạo object `quote: { content, msgType, uidFrom, msgId, cliMsgId, ts, ttl }` | `await message.reply("Got it!")` hoặc `client.messages.send(id, { text, replyTo: message })` |
| Thả reaction | `api.addReaction(icon, { data: { msgId, cliMsgId }, threadId, type })` | `await message.react(Reaction.Heart)` |
| Gửi link / sticker / voice / video | 4 hàm riêng (`sendLink`, `sendSticker`, `sendVoice`, `sendVideo`) | Thống nhất trong `client.messages.send(target, { link \| sticker \| voice \| video })` |
| Lấy thông tin nhóm | `const res = await api.getGroupInfo(id); const g = res.gridInfoMap[id]` | `const group = await client.groups.get(id)` |
| Lấy thông tin user | `const res = await api.getUserInfo(id); const u = res.changed_profiles[id]` | `const user = await client.users.get(id)` |
| Nhận tin nhắn | `api.listener.on("message", m => m.data.content)` | `client.on("message", m => m.text)` |
| Low-level API | `api.<method>(...)` | `client.raw` (escape hatch) |

---

## 3. Những parameter đã được tự động hóa

1. **`threadType` (30 API trong `zca-js`):** Tự suy luận từ contextual object (`User`, `Group`, `Conversation`, `Message`) hoặc `ThreadTypeRegistry` (cache danh sách Group ID từ `getAllGroups()` và sự kiện realtime). Vẫn cho phép override tường minh nếu cần.
2. **Message metadata cho `reply`, `react`, `undo`, `delete`, `markSeen`:** Tự trích `msgId`, `cliMsgId`, `uidFrom`, `idTo`, `ts`, `threadId`, `threadType` từ `Message` object.
3. **Session & Credentials:** Tự đọc/lưu nguyên tử (atomic write), tự phát hiện session hết hạn để fallback sang QR login và phát `auth.required`.
4. **Defaults an toàn:** Tự tắt `checkUpdate` (tránh gọi npm registry mỗi lần login), tự đặt `userAgent`, `language: "vi"`, `timeoutMs: 15_000`, `qrTimeoutMs: 180_000`, `rateLimit: 5 req/s`.
5. **Normalization:** Tự chuyển `ts: string` → `Date`, `e2ee: 0|1` / `isFr: 0|1` → `boolean`, unwrap `gridInfoMap` / `changed_profiles`.

---

## 4. Performance Improvements (Số liệu đo thực tế)

Chạy bằng `npm run bench` (`tests/benchmark.ts` trên Node.js v24.18.0):

| Tối ưu hóa | Kết quả đo thực tế |
|---|---|
| Tắt `checkUpdate` mặc định khi login | Loại bỏ 1 HTTP request thừa tới npm registry trên mỗi lần `login()`. |
| `TTLCache` + `InFlightDeduplicator` (Users & Groups) | **100 concurrent user lookups → chỉ 1 network call trong 11.26ms (giảm 99% request trùng lặp).** |
| `ThreadTypeRegistry` (cached Group ID lookup) | **50,000 lookups trong 7.68ms (~6,510,332 ops/sec)** — không tốn thêm network call trên hot path. |
| `mapMessageData` normalization | **100,000 messages trong 17.99ms (~5,557,161 ops/sec)**. |
| Reuse `modelActions` + `.unref()` timers + clear cache on `logout()` | Loại bỏ cấp phát thừa trong `startListening()`, tránh rò rỉ timer/memory khi đóng client. |

---

## 5. Dependencies thay đổi

- **Runtime dependencies của `zapid`:** Duy nhất **`zca-js` (`^2.4.0`)** — không thêm bất kỳ thư viện runtime bên ngoài nào; toàn bộ crypto mã hóa session at-rest (AES-256-GCM), atomic file store, rate limiter, cache, logger đều dùng Node.js built-in (`node:crypto`, `node:fs/promises`, `node:path`).
- **Dev dependencies tối giản:** `typescript`, `tsup`, `vitest`, `eslint`, `typescript-eslint`, `tsx`, `@types/node`.

---

## 6. Breaking Changes (so với dùng trực tiếp `zca-js`)

- Entry point mới là `Zapid` (`import { Zapid } from "zapid"`) thay vì `Zalo`.
- `messages.send(target, content)` đổi thứ tự tham số thành `(target, content)` thay vì `(content, threadId, threadType)` để nhất quán với các SDK hiện đại (`users.get`, `groups.get`, `conversations.get`).
- Payload sự kiện `message` là `Message` model đã chuẩn hóa (`msg.text`, `msg.sender`, `msg.timestamp`, `msg.conversation`) thay vì raw `UserMessage | GroupMessage`.
- Mọi lỗi đều được chuẩn hóa thành `ZapidError` thay vì `ZaloApiError` thô.

---

## 7. Compatibility

- Dual package **ESM (`dist/index.js`) + CommonJS (`dist/index.cjs`)** kèm full TypeScript declarations (`dist/index.d.ts`, `dist/index.d.cts`).
- Advanced users có toàn quyền truy cập 100% 174 API của `zca-js` qua `client.raw` mà không bị mất bất kỳ tính năng nào.

---

## 8. Test Results (Fresh Verification Evidence)

| Kiểm tra | Lệnh | Kết quả |
|---|---|---|
| TypeScript Strict Check | `npm run typecheck` | **PASS** (0 errors) |
| ESLint | `npm run lint` | **PASS** (0 errors, 0 warnings) |
| Unit Tests | `npm run test:unit` | **PASS** (1 file, **8/8 tests passed**) |
| Integration Tests (`MockTransport`) | `npm run test:integration` | **PASS** (1 file, **4/4 tests passed**) |
| Build (`tsup`) | `npm run build` | **PASS** (ESM 83.35 KB, CJS 84.08 KB, DTS 38.47 KB) |
| ESM & CJS Runtime Import | `node -e ...` | **PASS** (30 exports, `new Zapid()` OK trên cả ESM & CJS) |
| Benchmark | `npm run bench` | **PASS** (số liệu thực tế ở mục 4) |

---

## 9. Những API chưa thể tối ưu / giới hạn giao thức

1. **Unified inbox `conversations.list()` (cả DM + Group mới nhất):** `zca-js` v2.4.0 không có endpoint REST đơn lẻ trả toàn bộ inbox; giữ nguyên các hàm đã xác minh (`get`, `getMessages`, `getPinned`, `getUnread`, `pin`, `mute`, `sendTyping`).
2. **Lịch sử tin nhắn DM 1-1 qua REST:** `zca-js` v2.4.0 chỉ có `getGroupChatHistory` cho nhóm; không giả lập hoặc suy đoán endpoint cho DM.
3. **Server-side logout revocation:** Chưa có endpoint thu hồi cookie phía máy chủ Zalo trong `zca-js`; `logout()` chỉ ngắt kết nối và xóa session cục bộ.
4. **Niche APIs (Poll, Reminder, Note, Bank, Catalog, AutoReply, QuickMessage, Board):** Giữ nguyên truy cập qua `client.raw` để tránh phình to bề mặt API cốt lõi.

---

## 10. Những việc còn lại

1. Kiểm chứng live với tài khoản Zalo thật (`ZAPID_LIVE_TEST=1 npm run test:live`).
2. Kiểm tra tên package `zapid` trên npm registry trước khi `npm publish`.
3. Triển khai thư viện **Python (`zapid` cho PyPI)** ở giai đoạn tiếp theo sau khi chốt transport strategy (Native Python protocol port vs Node sidecar bridge).
