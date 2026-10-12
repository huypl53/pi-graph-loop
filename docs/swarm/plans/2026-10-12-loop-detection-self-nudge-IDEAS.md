# Swarm Loop-Detection & Self-Nudge — Idea Notes (2026-10-12)

> Status: idea notes, chưa implement. Plan nhỏ đầu tiên (L1 self-nudge) nằm cuối file.
> Bối cảnh: user phát hiện thỉnh thoảng swarm agents hallucinate — lặp gọi tools chạy mãi
> vài giờ không ra kết quả. Mọi detector hiện có (task-stall nudge, heartbeat-stale 10min,
> swap-chain cap, engine-retry tracker, reconcile) đều coi `busy/tool_running + heartbeat
> alive` = khỏe. Gap: **không detector nào cho "high activity + zero progress"**.

## 1. Nguyên lý nhận diện (detection)

Hook `tool_call`/`tool_result` đã tồn tại (`hooks/tools.ts`). Core: **fingerprint mỗi tool call**:

```
fp = hash(toolName + normalizedArgs + hash(normalizedResult))
```

- Include result-hash để TDD lặp `run tests` 10 lần vẫn thoát (result khác nhau mỗi lần);
  loop hallucinate (cùng args + cùng output, hoặc edit chạy vòng về cùng content file)
  trúng predicate.
- Ring-buffer per agent: `{fp, toolName, kind, at}[]`, sliding window ~20 calls.
- **Same-input alone KHÔNG đủ** (miss semantic loop grep-A→B→A→B, miss cycle, false-positive
  TDD, miss talk-loop). → 4 criteria dưới đây, fire khi TRÚNG BẤT KỲ.

### 1a. Phân loại tool theo HIỆU ỨNG (không theo tên cứng)

| Kind | Tool | Xử lý output-hash |
|---|---|---|
| `PURE_READ` | read/grep/find/ls | — (không cần) |
| `MUTATING` | edit/write | — |
| `AMBIG` | bash + tool lạ | output-hash đổi → treat như info-gain (reset churn streak); giống hệt → null (không reset, để C2 bắt) |
| `COMMUNICATING` | message/mailbox | — |

### 1b. Bốn tiêu chí loop (fire khi trúng bất kỳ)

| # | Tên | Điều kiện fire | Bắt shape nào |
|---|---|---|---|
| **C1** | Read-churn | ≥12 calls gần nhất toàn PURE_READ (+AMBIG null-output), **0 MUTATING, 0 message**, trải ≥5 phút | Lục lọi read/grep không ra, không write/edit |
| **C2** | Hard repeat | ≥5 identical fp trong 15 phút | Spam cùng command |
| **C3** | Cycle | Cycle length ≤4 lặp ≥3 vòng trong 15 phút | A→B→A→B, kể cả edit-revert |
| **C4** | Talk-churn | ≥6 turn boundaries liên tiếp: 0 MUTATING + 0 message đi ra | Text loop, không hành động |

**Reset counters:** MUTATING call → C1/C4 về 0; message đi ra → C1/C4 về 0. C2/C3 KHÔNG reset
khi có mutation (edit-revert loop vẫn nguy hiểm). Nudge xong → cooldown 10 phút (giữ evidence).
Worker restart → reset hết (in-memory, chấp nhận; loop phải tích lại từ đầu).

### 1c. Counter là gì

- **Primary: tool-call count** (sliding window ~20 calls) — deterministic, rẻ, replay được trong
  mock-llm test, model-agnostic.
- **Gate: time span** (≥5 phút cho C1; 15 phút cho C2/C3) — 12 read trong 2 phút là explore hợp lệ;
  trải dài mới đáng ngờ.
- **Turn boundaries** cho C4 (đếm lượt settle→turn mới).
- **KHÔNG dùng context tokens làm counter** — non-stationary giữa model/tokenizer; read file to
  inflate nhanh, grep nhỏ inflate chậm → threshold không ổn định. Nếu dùng, chỉ làm *drift signal
  phụ* (context +30% mà 0 mutation).
- 429/engine-retry không tạo tool call (engine layer) → không đếm vào criteria nào.

### Chống false-positive (bài học đã có trong memory)
- `tool_running` (dev server, watch mode) → pause đếm, không phải loop.
- Cooldown/backoff giữa các nudge; idempotency key + nudge cap (pattern `NOTIFY_DEFAULT_MAX_NUDGES`).

## 2. Escalation ladder

| Level | Hành động | Actor |
|---|---|---|
| **L0** | Ghi trace/errors ledger + hiển thị `/swarm status` (observe-only) | detector |
| **L1** | **Self-nudge** worker: "bạn vừa gọi `X` N lần cùng args; re-read task.json, nêu blocker, land incrementally" | mailbox → worker |
| **L2** | Nudge xong streak tiếp tục (hoặc không ack trong T): escalate lên root kèm bằng chứng (agentId, taskId, fp stats, 3 calls gần nhất) | mailbox → root |
| **L3** | `ctx.abort` turn, node → `blocked` + reason, release assignee → node về `ready` cho agent khác, hoặc stop+respawn worker | root / reconcile (auto chỉ khi env-gated) |

L1 giữ context worker (bài học max-output-token: nudge đúng cách → tự hồi phục, không vội thay).
L2–L3 = "reconcile lên root" — root có bằng chứng để quyết reassign/respawn.

## 3. Kiến trúc

Detector chạy trong **session của chính worker** (hook tool_call local). Worker tự đếm; khi trúng
ngưỡng → worker gửi escalation message lên root mailbox. State per-agent sống trong process worker
→ không shared state, restart = sạch. Root chỉ nhận escalation + expose ở `/swarm status`.
`reconcile` đọc trace để pick up node bị mark blocked.

## 4. Phương án đã cân nhắc

- **Pane-scraping tmux** tìm output lặp: flaky, đắt, miss khi scrollback thiếu → chỉ secondary signal.
- **LLM-judge** đọc transcript phán "đang loop": chính xác nhất về ngữ nghĩa nhưng tốn token, thêm
  1 model vào loop chẩn đoán lỗi model → để làm lệnh manual `/swarm diag <agent>` cho operator,
  không vào đường tự động.

## 5. Rollout

1. Observe-only (L0) mặc định 1 tuần — thu data, chỉnh N/M/T theo thực tế.
2. Bật L1 self-nudge.
3. Bật L2 escalate.
4. L3 auto env-gated (`PI_SWARM_LOOP_AUTO_REASSIGN=1`), mặc định root xác nhận.

Config: `constants.ts`, pattern `PI_SWARM_LOOP_*`.

## 6. Ràng buộc AGENTS.md

- **Mock-llm fixture bắt buộc**: scenario mock worker lặp gọi cùng 1 tool (delayMs timing-controlled)
  → detector fire → nudge → escalate → node reassigned. Incident-derived fixtures là template chất lượng.
- Touch `pi.sendMessage`/mailbox delivery → đọc `docs/swarm/pi-runtime-contract.md` + evidence doc
  trước khi implement; thêm R10-1 boundary assertion; review phải cite contract §.

## 7. PLAN v1 (MINIMAL) — read-streak budget nudge

> Feedback user 2026-10-12 (lần 2): "phức tạp quá" → không fingerprint, không identical-repeat,
> không cycle. Chỉ 1 concept: **streak đọc + ngân sách đốt**.
> (§1–6 ở trên là idea notes cho tương lai, KHÔNG thuộc scope v1.)

### Thiết kế v1.1 — SAU RED-TEAM (2 reviewers, verdict: AMEND PLAN)

Red-team 2026-10-12: design lens (D1–D6) + runtime lens (B1, M1–M3, m1–m2). Các vá đã chấp nhận:

| # | Finding | Vá trong v1.1 |
|---|---|---|
| D1 🔴 | `turn_end` KHÔNG có usage; `tool_result.usage` optional + chỉ là tool-execution tokens, không phải model tokens → mốc 50k tokens không implement được đáng tin | **Bỏ tokens khỏi trigger v1.** Budget = số READ calls + active elapsed time. Token accounting chỉ observe-only nếu sau này tìm được nguồn đúng (log rõ hạn chế: không đếm được reasoning) |
| D2 🟠 | Elapsed wall-time ăn cả idle gap (đọc 1 lần → settle chờ message 10 phút → false nudge) | Elapsed = **active segments**: khởi động ở tool_result READ đầu streak; `agent_settled` → freeze segment vào accumulator; READ tiếp theo → mở segment mới. Idle giữa các turn KHÔNG tính |
| D3 🟠 | Bash allowlist bypass 2 chiều (`cd x && grep`, `sed -n..; rm`, redirect…) | **Fail-closed: v1 chỉ nhận native read/grep/find/ls là READ. Mọi bash = OTHER** (an toàn theo hướng reset; chấp nhận miss read-loop thuần bash — ghi rõ) |
| D4 🟠 | Xen 1 OTHER vô hại là reset → evasion dễ | Đổi claim: đây là **read-streak guard**, KHÔNG phải generic loop detection. Ghi rõ residual evasion trong docs |
| D5 🟠 | Restart reset in-memory → multi-hour loop không bao giờ chạm mốc 3 (đúng scenario motivation) | **Persist streak state vào swarm state file** keyed `agentId+activeTaskId` (streakId, readCallCount, accumulatedActiveMs, nudges, escalated). Reset chỉ khi: task/attempt đổi, OTHER, hoặc root `/swarm loop off|on` |
| D6 🟡 | Reviewer/QA đọc nhiều là HỢP LỆ; 1 read + reasoning dài không được thành nudge | Mốc thứ k cần **CẢ HAI**: readCallCount ≥ 6·k VÀ accumulatedActiveMs ≥ 5phút·k. Nudge advisory, kèm evidence window (số calls, commands rút gọn, active time, lần nhắc thứ mấy) |
| B1 🔴 | Delivery tới chính agent ĐANG busy: queue/mailbox chỉ surface khi settle (agent loop không bao giờ settle) → NO-OP | **Delivery path chính = mid-run injection tại `turn_end`:** hook turn_end (chạy sau MỖI vòng tool trong run) khi mốc nudge vừa fire → return `{ custom_message: <nudge>, continue: true }` → pi tạo model request kế tiếp trong cùng run với nudge trong context (docs/extensions.md:117 — API chính thức). Guard chống continuation-loop (điều kiện docs đòi hỏi): CHỈ tiếp tục khi mốc vừa fire — max 3 lần/streak. Mailbox append vẫn ghi để durable/audit; queue/pump chỉ phục vụ agent idle. Probe B1 (chạy trước code): assert trên mock-llm lane rằng custom_message continuation THỰC SỰ đến model (transcript chứa nudge giữa run) |
| M1 🟠 | Thiếu §10 row + R10-1 | Thêm row §10: "self-nudge tới busy agent chạm được loop" (status: unproven → probe). R10-1: counter đếm send THẬT tại injection site + control assert **0 sends** khi streak dưới mốc (template F24/R30) |
| M2 🟠 | Fixture KHÔNG set env được; token threshold trong mock lane fragile | Env override nằm ở **lane command** (`PI_SWARM_READ_STREAK_MS=… pi --provider mock-llm …`). 3 fixtures: `loop-read-streak-milestones` (nudge 1→2→3→root, mốc time), `loop-read-streak-reset` (write xen → 0 nudge), `loop-read-streak-escalate-once` (root escalation đúng 1 lần/streak) |
| M3/m2 🟡 | /reload mid-loop: streak in-memory reset nhưng toggle còn ON; idempotency key phụ thuộc streak identity | Document: reload giữa loop = streak tích lại từ đầu (streakId mới → key mới, cooldown là guard duy nhất cross-restart cho nudge-dedupe; escalation state persisted nên không re-escalate). Toggle đọc trực tiếp từ state file **mỗi event**, không cache |
| m1 | Command mechanics | Root-only theo pattern `commands/goal.ts` (`ctx.ui.notify` warning); thêm entry `/swarm loop` vào `docs/swarm/tools.md` + README module map |

### Tiêu chí cuối cùng (read-streak guard v1.1)

- **READ** = native `read`, `grep`, `find`, `ls` tools. **Mọi tool khác (kể cả toàn bộ bash) = OTHER** → streak đứt, reset toàn bộ.
- Streak READ chạy: đếm **readCallCount**, cộng dồn **accumulatedActiveMs** (chỉ segment active, pause khi settle), khởi tạo **streakId**.
- State persisted trong swarm state file keyed `agentId+activeTaskId` — sống qua restart, chết khi task đổi.
- **Mốc k (k=1..3):** readCallCount ≥ 6·k **VÀ** accumulatedActiveMs ≥ 5·60_000·k → self-nudge thứ k
  (durable mailbox + send-keys; text tự chứa: tổng calls/active-time/lần nhắc). Tham số env-overridable:
  `PI_SWARM_READ_STREAK_MS` (segment mốc, default 300_000), `PI_SWARM_READ_STREAK_CALLS` (default 6).
- Sau nudge 3, mốc 4 vẫn chưa đứt → **reconcile lên root 1 lần/streak** (persisted escalated flag):
  evidence agentId, taskId, streakId, totals, timeline mốc, READ calls gần nhất. Root tự quyết.
- Không tokens trong trigger; không abort; không reassign tự động.

### Files

| File | Thay đổi |
|---|---|
| `src/nudges/loop-detect.ts` (mới) | classify, observe, milestone check, state persist/load, nudge + escalate |
| `src/hooks/tools.ts` | gọi observe tại tool_result (tool_result chạy trong loop → là điểm inject tự nhiên) |
| `src/hooks/settled.ts` | pause segment tại agent_settled |
| `src/commands` (`/swarm loop`) | on\|off (root-only, persist) + status; docs `docs/swarm/tools.md` + README module map |
| `src/constants.ts` | 2 env-overridable ở trên |
| `docs/swarm/pi-runtime-contract.md` §10 | row mới cho claim delivery-to-busy (unproven → probe) |
| Test R10-1 | boundary counter tại injection site + zero-send control khi dưới mốc |
| 3 fixtures | milestones / reset / escalate-once (env override ở lane command) |

### Thứ tự implement (bắt buộc)

1. **Probe trước** (mock-llm lane): `turn_end` + `custom_message` + `continue: true` có thực sự đưa nudge vào model request giữa run không (assert transcript) → chốt delivery path, ghi kết quả vào §10 row + evidence doc.
2. Reproduction fixture `loop-read-streak-milestones` chạy ĐỎ (chưa có detector).
3. Code detector + hooks + state persist → fixture XANH. R10-1 counter + zero-send control.
4. 2 fixtures còn lại xanh; `/swarm loop` command + docs.
5. Mock-llm lane tmux riêng, assert transcript `.pi/mock-llm/transcripts/`.

### Review ask — ĐÃ CHỐT (user, 2026-10-12)

1. Ngưỡng 5 phút active / 6 READ calls mỗi mốc (tokens đã bỏ theo red-team D1) — ✅
2. Self-nudge 3 lần xong → reconcile lên root — ✅
3. Bật mặc định ON + `/swarm loop on|off|status` — ✅
4. Compact-safe + restart-safe (persist state) + nudge text tự chứa — ✅

### Known limits (ghi vào docs, không giấu)

- Read-loop thuần bash không bị bắt (fail-closed theo D3).
- Xen OTHER vô hại định kỳ = evasion (D4) — đây là read-streak guard, không phải full loop detection.
- Single never-ending turn out of scope v1 — đã giải quyết: nudge bám vào `turn_end` sau mỗi vòng tool, không cần settle.
