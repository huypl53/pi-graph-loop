# Swarm multi-agent edge cases & risk analysis

Phân tích sâu dựa trên source `extensions/swarm/src/` (đọc trực tiếp: `agents.ts`, `mailbox.ts`, `delivery.ts`, `reconcile.ts`, `taskgraph.ts`, `loop.ts`, `hooks.ts`, `tmux.ts`, `state.ts`, `session.ts`, `constants.ts`, `gc.ts`). Mục tiêu: liệt kê các tình huống xấu khi **nhiều swarm agent chạy đồng thời**, xung đột tiềm năng, điểm nghẽn message, và rủi ro của tích hợp tmux — kèm mức độ nghiêm trọng và gợi ý mitigate.

Mỗi mục có tham chiếu `file:line` (theo file tại thời điểm phân tích) để dễ truy ngược.

---

## 1. Xung đột state & concurrency (nhiều agent ghi đồng thời)

### 1.1. Lock directory là best-effort, không phải mutex thật
- `withLock` (`src/state.ts`) dùng `mkdir` lock-dir + stale-break sau `LOCK_STALE_MS = 60s` và timeout `LOCK_STALE_MS * 2`.
- **Edge case:**
  - Một agent treo > 60s giữa `readState → writeState` (vd do tmux injection chậm, model call chậm) → agent khác coi lock là stale, `rm -rf` lock dir và giành quyền → **2 process cùng ghi `swarm-state.json`** → lost update nguyên khối (state là read-modify-write toàn file, không merge field-level).
  - Timeout `LOCK_STALE_MS * 2` (120s) quá dài: một lệnh send message tới agent pane chết (tmux timeout 10s × vài bước + settle 700ms) thường không tới 120s, nhưng reconcile sweep nhiều tasks + nhiều `isTmuxRunning` probe (mỗi probe 3s) với vài chục agent có thể vượt → tool report "Timed out acquiring swarm lock" dù hệ thống khỏe.
- **Nghẹt thực tế:** mọi hook (`agent_start`, `agent_settled`, `tool_execution_start/end`, `session_start/shutdown`, input interception) của MỌI agent đều `withLock → readState → writeState` toàn file state. Với N agent hoạt động nao nhiệt, lock serialization biến thành **thắt cổ chai toàn cục**; state file phình (toàn bộ `messages`, `agents`) làm mỗi critical section ngày càng dài.

### 1.2. Read-modify-write nguyên khối, không optimistic concurrency
- `writeState` ghi đè cả file; không version check / compare-and-swap.
- **Edge case:** process A đọc state, process B đọc+ghi (agent mới, ack mới), A ghi lại → **mất agent record / ack / delivered ledger** của B. Các đường chạy ngoài lock (vd `pumpOrchestratorMailbox` sau lock đọc kết quả rồi ghi ledger lần nữa) đã cố giảm window nhưng mọi core "lock-free core" (docstring trong `agents.ts`) **đặt định rằng caller giữ lock** — chỉ cần một caller quên là race im lặng.
- Đặc biệt: `hooks.ts` input-intercept, `agent_settled` notify, `session_shutdown` nudge đều mutate `st` rồi `writeState` — nếu cùng lúc orchestrator pump đang sweep, một trong hai bản ghi bị rơi.

### 1.3. `st.delivered` là dedup ledger chia sẻ nhưng ghi ở nhiều nơi
- Ghi tại: inject thành công (`deliverMessageLocked`), reconcile retry, pump informational-consume, auto-ack nudge. Nhiều writer + lost update (1.2) → message đã inject có thể bị **re-inject duplicate** (ledger mất entry) hoặc message chưa từng surfaced bị coi là đã surface.
- `delivered` không được trim theo mailbox — mảng mỗi agent lớn dần cho đến khi `swarm_prune` (gc giữ 500 newest, nhưng **phải gọi thủ công**).

### 1.4. Terminal transition + `releaseNodeAssignment` không phải hàng ràng cứng
- Transition map `ALLOWED_NODE_TRANSITIONS` chỉ chặn worker regress từ terminal; **orchestrator bypass hoàn toàn** (`force`). Hai orchestrator lane (xem 3.1) cùng force một node → last-writer-wins trên `task.json` (cũng là atomic file nhưng read-modify-write).
- `task.json` cũng có lost-update giữa `reconcileTasks` (mark=true) và `swarm_update_task` của assignee — cả hai `readTaskState → writeTaskState` dưới cùng lock nên thường an toàn, nhưng `scanAgentOpenAssignments`/`runtimeTaskWarnings` đọc **ngoài lock** (`hooks.ts` session_shutdown đọc task, mutate, writeTaskState trong lock — ok; `loop.ts` `recordLoopPlan` đọc task/loop **ngoài lock** rồi ghi lại).

### 1.5. Advisory edit locks chỉ là advisory
- `task.editLocks` không được hard-enforce (docs thừa nhận). Hai node có `allowedFiles` giao nhau (hoặc hai agent tự ý edit ngoài scope) → **conflict edit file thật**, không có cơ chế nào trong swarm phát hiện (chỉ git conflict lúc commit). Node A done với artifact, node B đã đọc artifact cũ → stale-read cascade.

---

## 2. Message pipeline: nghẽn, bão, mất message

### 2.1. Orchestrator mailbox là điểm nghẽn hình phễu duy nhất
- Mọi notify đều đổ về `to: "orchestrator"`: PM auto-notify (settle với open work, cooldown 2 phút), node-close notify, response_missing notify, loop kickoff/reopen/plan-now nudges, graph-advance nudges, shutdown nudges. Worker không bao giờ tự phối hợp ngang (mọi handshake đều qua PM hoặc qua message ngang nhưng điều phối bởi PM).
- **Nghẽn:** pump quét `readMailbox(orchestrator)` **mỗi 5 giây** (TUI interval) + đọc slice 50 message cuối (`PUMP_SCAN_WINDOW`) + parse toàn file JSONL mỗi lần. Mailbox orchestrator không bao giờ bị trim tự động (chỉ `swarm_prune` thủ tác) → file phình theo thời gian sống của swarm → mỗi tick 5s đọc toàn bộ. Với vài nghìn message, pump 5s trở thành I/O + CPU đáng kể, và message thứ 51+ kể từ cuối **không bao giờ được nhìn thấy trong cùng tick** (chỉ 10 surface/tick, các tick sau xử lý tiếp — chậm dần nếu rate arrive > rate consume).
- Busy-pump deferral: khi orchestrator đang chạy turn, message không surface và không đánh dấu → đúng thiết kế, nhưng nếu orchestrator **bận liên tục dài hạn** (vd chạy tool batch lớn), đống followUp dồn lại; re-trigger cap `PUMP_RETRIGGER_MAX = 3` × delay 60s — nếu 3 lần re-trigger đều rơi vào lúc busy thì message requiresAck **chỉ còn nằm lại dạng unacked**, không có escalation nào nữa cho tới khi người/người-đứng-đọc `swarm_check_mailbox`.

### 2.2. Loop nudge storms (đã mitigate một phần nhưng còn khe)
- Các nudge đều idempotent theo `idempotencyKey` (một nudge/round/node) + auto-ack. Nhưng:
  - `sendGraphAdvanceNudgeLocked` quét **mọi task in_progress × mọi node** mỗi `LOOP_RECONCILE_INTERVAL_MS = 30s`. Một graph lớn (20+ node ready song song — parallel design là điểm mạnh của graph) → 20 nudges đòi "assign node X" đổ vào mailbox orchestrator trong 1 tick; orchestrator 1 turn chỉ surface 10 → các nudge còn lại chờ tick sau trong khi orchestrator đã assign → sau đó bị auto-ack, nhưng **vẫn chiếm slot surface** của tick kế (surfaced set đánh dấu khi trigger, ack ở tick sau).
  - Cooldown settle-notify là per-agent 2 phút, nhưng **không cooldown toàn cục**: 20 agent cùng settle "với open work" trong cùng cửa sổ → 20 informational messages cùng lúc (chỉ 1 lần mỗi agent, nhưng vẫn burst).
  - Loop kickoff nudge gửi khi task close-done; nếu orchestrator reopen và close lại nhanh (rework loop), mỗi close-done tạo round mới → round dồn, `maxRounds` mặc định **không đặt** (`cfg.maxRounds` undefined = vô hạn) → vòng lặp plan/reopen không chặn trên trừ khi cấu hình.

### 2.3. tmux injection là "delivered" ngay cả khi chưa chắc agent đọc được
- `deliver()` (`src/mailbox.ts`): `sendToPane` không throw = delivered → mark `injected`. Nếu pane đang ở **trạng thái không nhận input** (dialog confirm, editor mode, agent đang streaming output — `send-keys -l` vẫn gõ vào TUI nhưng dòng gõ có thể bị TUI bỏ/part render), message bị coi là đã deliver rồi nằm kẹt ở `ack_missing` 5 phút trước khi reconcile chỉ *đánh dấu*, **không re-inject** (ack_missing path cố tình không bump attempts). Recovery duy nhất: TTL (nếu đặt) hoặc người gọi lại reconcile retry — nhưng retry predicate `isDeliveryFailureRetryable` chỉ nhận `queued/failed` không có `lastAck` → message `injected` không ack **không bao giờ được re-inject tự động**. Đây là nghẽn/ứ đọng bền: node gán rồi, agent không thấy, chỉ có stale signal sau `ACK_MISSING_MS = 5p` và `TASK_NUDGE_MS = 30p` (chỉ warning).
- Hai message gửi liên tiếp vào cùng pane: `sendToPane` = literal text + Enter, sleep 150ms; nếu agent TUI đang xử lý dòng trước, dòng thứ hai **ghi đè/chen vào input buffer** (không có kiểm tra idle-recipient). Base64 single-line giúp tránh marker collision nhưng không tránh **race TUI input**. `deliverMessageLocked` gửi tuần tự trong lock nên ít gặp, nhưng deliver từ 2 process khác nhau (2 orchestrator lane) → chen dòng.

### 2.4. Dead-letter chỉ vì TTL/attempts, không có DLQ drain tự động
- `swarm_dead_letters` là tool đọc; không có gì tự động xử lý. Message requiresResponse dead → node tham chiếu nó thành "dead-lettered" warning mãi. Fine cho ops-manual, nhưng nhiều swarm song song dài hạn sẽ chất đống requiresResponse missing → `responseMissingRecords` quét **toàn bộ `st.messages`** mỗi lần gọi (settle hook, findReusableAgent từng agent) → O(M×N) dần nặng.

### 2.5. Idempotency quét tuyến tính toàn state
- `deliverMessageLocked` với `idempotencyKey` thực hiện `Object.values(st.messages).find(...)` — O(M) mỗi send. Với nudges idempotency-check cũng `Object.values(st.messages).some(...)` trong `sendGraphAdvanceNudgeLocked`, `sendLoopReopenNudgeLocked`, `ackLoopNudgeLocked`... Mỗi tick reconcile 30s × mỗi node/round. M lớn (hàng nghìn) → CPU lãng phí + kéo dài critical section lock.

---

### 2.6. Settle-notify races (đã quan sát thực tế)
- `agent_settled` hook (`hooks.ts`) gửi 2 loại informational notify khi settle: "settled with missing response(s)" (dựa `responseMissingRecords`) và "settled idle with open assignment(s)" (dựa `agent.activeTaskIds`). Cả hai đọc **state snapshot tại thời điểm settle** — notify có thể đến orchestrator **sau khi** response đã verified / node đã done (đặc biệt khi agent settle lần cuối trước khi bị stop).
- Đã tái hiện trong task task-swarm-robustness-v2: planner-01 settle sau khi node plan đã done + response verified → orchestrator nhận 2 cảnh báo giả. Nguyên nhân pointer `activeTaskIds` không được dọn khi node terminal xảy ra trước settle (chỉ `releaseNodeAssignment` trên transition terminal dọn pointer).
- **Mitigate:** trong `agent_settled`, re-check `response?.status === "verified"` và closure của node trước khi notify; hoặc dọn `activeTaskIds` theo node-status thực tế thay vì chỉ theo transition.

## 3. Đa orchestrator / đa swarm

### 3.1. Hai lane orchestrator cùng lúc
- Nhận diện orchestrator = env (`PI_SWARM_IS_ORCHESTRATOR` / `PI_SWARM_AGENT_ID=orchestrator`) — **không phải lock single-owner**. Mở 2 terminal cùng env này:
  - Cả hai chạy pump 5s; per-pid surfaced set giúp không starve nhau, nhưng **cả hai có thể surface cùng một message requiresAck** (session-local) → orchestrator xử lý 2 lần (duplicate actions: assign 2 lần, plan 2 lần).
  - `orchestratorPumpSessions` entries per-pid được prune theo TTL 1h — session chết sớm (crash) để lại ghost entry 1h (bounded, chỉ rác nhỏ).
- **Edge case nghiêm trọng hơn:** 2 process pi cùng agent-id worker (vd restart tay bằng cách chạy `PI_SWARM_AGENT_ID=reviewer pi` trong 2 pane). `pid-guard` trong hooks chặn phần lớn mutation của process không sở hữu, nhưng `session_start` path cho agent **đã có record** ghi đè `pid = process.pid` không có guard (chỉ `lastSessionStartAt`...) — thực tế nó *cập nhật* pid, tức process mới "cướp" ownership im lặng; process cũ bị pid-guard chặn ở các hook sau → hành vi thường đúng cho restart, nhưng nếu cả hai cùng sống: acks từ process cũ có thể bị từ chối logic (guard `agent.pid !== process.pid` chỉ chặn state-update hooks, **không chặn tool handlers** như `swarm_ack_message` — tools không kiểm pid) → 2 "reviewer" cùng ack/commit task.

### 3.2. Nhiều swarm trong cùng repo (share `.pi/swarm/`)
- Paths neo theo `cwd` — 2 orchestrator khác swarmId trong cùng project **chia sẻ** `swarm-state.json`, mailboxes, tasks. `defaultState` tạo swarmId mới nhưng mọi thứ vẫn ghi chung file. Agent id trùng (vd cả hai spawn `reviewer`) → `spawnAgent` guard chỉ chặn khi `status === "running"`; một bên stop rồi bên kia spawn lại cùng id → **mailbox/identity/history hoà trộn giữa 2 swarm**. Không có namespacing per-swarmId (field `swarmId` có trong message nhưng không dùng để route/scope).

### 3.3. Restart agent giữa chừng
- `restartAgent` kill pane rồi respawn cùng id, mailbox/identity giữ. Message đã `injected` chưa ack trước khi kill → sau restart, agent mới **không tự re-read mailbox** trừ khi được bảo (initialPrompt mặc định "await tasks" không nhắc check_mailbox). → Message ứ: chỉ được phát hiện bởi ack_missing 5p → cảnh báo, không re-deliver (2.3). Kịch bản rất hay gặp khi PM "restart" agent treo.

---

## 4. Tích hợp tmux: rủi ro riêng

### 4.1. Liveness = "tmux resolve được target"
- `isTmuxRunning` dùng `display-message -p #{pane_id}` thành công = alive. **Pane chứa shell thường (không pi)** vẫn "alive" — agent record nói running nhưng thực tế pane chỉ là shell sau khi pi crash → injection gõ base64 vào shell (vô hại nhưng bị coi delivered → ack_missing vĩnh viễn như 2.3). Không có check `pane_current_command` liveness-path (chỉ dùng cho display ở `listAllPanes`).
- Ngược lại: user zoom/copy-mode không ảnh hưởng (`display-message` vẫn ok) — nhưng `send-keys` khi pane ở **copy-mode** không tới được input của pi → tương tự mất message "đã deliver".

### 4.2. Window index không ổn định
- Target lưu dạng `session:windowIndex.paneIndex` (`spawnAgent`: `${state.tmuxSession}:${window}.0` với window = id, dùng **window name** thực ra — tmux resolve name trước index, ổn hơn). NHƯC: `registerAgent` nhận target tùy ý từ operator — nếu target theo **index** (`myproj:2.1`) và user swap/move window, injection đi nhầm pane. tmux pane-id `%n` ổn định nhưng register mặc định theo target con người chỉ định. Không có auto-repair target khi pane chết/window đổi (chỉ `register` lại thủ công).

### 4.3. `send-keys` vào pane không phải của mình
- Không có xác thực/namespace pane: mọi agent đều có thể `swarm_send_keys` tới target bất kỳ (kể cả pane người dùng đang gõ, hoặc chính orchestrator) → **lệnh literal rơi vào input của process khác**. Tương tự `swarm_register_agent` adopt pane người dùng một cách hợp lệ (đó là feature) nhưng cũng là vector nghịch ý: 2 swarm cùng host, swarm A register nhầm pane của swarm B.
- `killAgentPane` kill-window theo `tmuxSession:tmuxWindow` — nếu 2 agent được register vào **cùng một window** (2 pane cùng window), kill một agent chết cả window, kéo theo agent kia (tái hiện dưới dạng "assignee tmux pane not alive" stale chain).

### 4.4. Capture-pane 300 dòng trước/sau mỗi delivery
- Mỗi message deliver ghi 2 file capture (`-S -300`). Fan-out 1 graph 20 node → 40 file mỗi đợt assign + dung lượng trace lớn; hơn nữa `capturePane` **fail vẫn ghi file** `[capture failed]` và trả về như bằng chứng — consumer không phân biệt được evidence thật/giả (chỉ là trace, rủi ro thấp, nhưng làm memory/metric evidence-review nhiễu).

### 4.5. Timing heuristics cứng
- `SEND_SETTLE_MS = 700ms`, `SPAWN_SETTLE_MS = 2.5s`, sleep 120–150ms giữa send-keys/Enter. Model/pane chậm (cold start pi, model latency cao) → kickoff prompt đến **trước khi pi TUI sẵn sàng nhận input** → prompt bị shell nuốt hoặc tách dòng. Không có probe "pane ready" (chỉ sleep). Đây là nguyên nhân phổ biến nhất của "spawn xong nhưng agent ngồi im".
- Loop refresh dùng `/new` + Enter qua send-keys (`loop.ts` `refreshLoopAgent`) — nếu agent đang có dialog/confirm mở, `/new` bị TUI diễn giải là text thường.

### 4.6. tmux server là single point
- tmux server chết / bị restart (user `tmux kill-server`) → toàn bộ agent "chết" cùng lúc; durable state sống sót nhưng mọi in-flight injected-unacked message thànhack_missing, mọi pane target invalid → `isTmuxRunning` throw-path catch trả false → reconcile bão "pending: recipient not running". Hệ thống tự lành chỉ khi có orchestrator nhìn thấy và reconcile lại — nếu chính PM session cũng trong tmux server đó thì PM chết luôn.

---

## 5. Task graph edge cases

### 5.1. `computeReadyNodes` AND/OR semantics tinh vi
- Node không có incoming edges = AND-join theo `dependsOn`; node có edges = chỉ cần **một** edge thỏa (`edges.some`). Graph nhập tay dễ tạo node có **cả** dependsOn lẫn edges → semantics lẫn: deps đều done nhưng chưa có edge outcome khớp → node treo "pending" không warning (chỉ warning unreachable, không warning "pending vĩnh viễn vì edge outcome không khớp"). `swarm_validate_graph` không kiểm "outcome values có trong edges có thể được set" — node `test` chỉ có edge khi `passed`/`failed`, nhưng worker có thể set outcome tùy ý → outcome lạ = mọi downstream edge không khớp = stall im lặng cho tới graph-advance nudge... vốn chỉ nudge node **ready**, node pending-mãi-kiểu-này không được nudge.
### 5.2. `maxAttempts` không được engine đếch
- Node có `attempts/maxAttempts` nhưng không thấy nơi nào auto-fail khi vượt (chỉ dữ liệu). Worker loop done→rework→done không bị chặn bởi graph.
### 5.3. Multi-assignee race
- `swarm_assign_task` không kiểm "node đã assigned cho agent khác đang in_progress" (chỉ supersede message, waives response). Orchestrator reassign khi agent cũ vẫn đang chạy → **2 agent cùng làm 1 node**, artifact write đè nhau; agent cũ khi update task bị ownership-check từ chối (node assignee giờ là agent mới) → công sức vứt, message ack của nó thành ack trễ trên message đã superseded (đã waived, vô hại nhưng confusing).
### 5.4. Closure derive đọc artifacts tồn tại
- `computeNodeClosureSummary` check artifact file exists khi done. Agent done nhưng artifact trong `tp.root` (per-task dir) — nếu artifact ghi nhầm chỗ (vd repo root) → closure blocking "artifact missing" dù task done → reconcile "task_status_drift" loop cảnh báo.

---

## 6. Metrics/memory/iteration (nhẹ hơn, nhưng có)

- `runs.jsonl`/`memory.jsonl` append-only với latest-by-id đọc **toàn file** mỗi lần — dài hạn chậm tương tự mailbox.
- `readJsonlLatestById` giữ record cuối theo thứ tự file — 2 writer append cùng runId gần như đồng thời (không lock file JSONL ngoài `appendFile` atomic-per-line trên POSIX) → có thể 2 dòng, latest theo thứ tự vật lý = không xác định nhưng chấp nhận được.
- `captureGitCommit` lấy base = head hiện tại lúc ghi run — 2 agent commit giữa chừng làm base/head của run khác meaningless (chỉ ảnh hưởng tính "change" của run).

---

## 7. Model routing: spawn mặc định glm-5.1 (hard-coded chain)

### 7.1. Chuỗi fallback cứng về glm-5.1/zai-coding-cn
- `currentModel()` (`src/session.ts`): `settings.defaultModel → PI_SWARM_DEFAULT_MODEL → DEFAULT_MODEL ("glm-5.1")`; `currentProvider()` fallback tương tự về `zai-coding-cn` (`providerForModel`: chỉ `gpt-5.4-mini` → openai, **mọi model khác đều về zai-coding-cn**).
- `swarm_spawn_agent` tool (`src/tools/agents.ts:161`): `params.model || currentModel()` → khi orchestrator/agent **không chỉ định model** (rất phổ biến — LLM gọi tool thường lược field tùy chọn), mọi agent spawn ra đều glm-5.1, kể cả khi session cha chạy model khác. `restartAgent` Worse: dùng lại `existing.model` đã ghi trong record — model cũ được "đúc kết" vĩnh viễn qua restart, không có đường config lại ngoài `swarm_set_role` (không đổi model) hay re-register.
- **Edge case cụ thể:**
  - Project dùng `.pi/settings.json` swarm config nhưng orchestrator chạy ở repo khác / cwd khác → settings không được đọc (readSwarmSettings neo `process.cwd()`) → âm thầm fallback glm-5.1.
  - Spawn 1 lúc 10 worker không truyền model → cả 10 trừ một nhà cung cấp (zai): nghẽn rate limit + chi phí + không tận dụng được fast model cho task nhẹ. Tool description có nhắc "fast preset gpt-5.4-mini" nhưng không có preset switch (vd `model: "fast"`) — LLM phải tự nhớ tên model.
  - `providerForModel` là bảng cứng 1 mục: model tùy chỉnh (Claude, Gemini...) mặc định bị ghép với provider zai-coding-cn → spawn fail lúc tmux chạy lệnh `pi --provider zai-coding-cn --model <model-khác>` trừ khi caller luôn nhớ truyền provider khớp.
  - Loop refresh (`refreshLoopAgent`) và identity reload không chạm model — nhưng `restartAgent` giữ model cũ, nên "đổi model hàng loạt sau khi accept memory về model tốt hơn" không có công cụ nào làm được (phải stop + spawn id mới).
- **Mitigate gợi ý:** đặt `defaultModel` trong `.pi/settings.json` (mọi môi trường deploy swarm); thêm preset alias (`fast`/`reason`) trong tool schema; `providerForModel` đọc từ settings/models registry thay vì bảng cứng; thêm `swarm_set_role`-style model update hoặc cho `restartAgent` nhận `model` override.

## 8. Metric/qualification & success-criteria: skill chỉ là prompt-guide, chưa ứng dụng được

### 8.1. Nature của gap
`swarm_metric_designer` (`.agents/skills/swarm_metric_designer/SKILL.md`) là **skill thuần văn bản** — hướng dẫn hội thoại + JSON mẫu. Còn engine (`src/metric.ts` + tools metrics) chỉ là **file-IO CRUD**: `swarm_metric_define` ghi file JSON, `swarm_run_record` append JSONL, gate so digest. Giữa hai lớp không có cầu nối tự động:

### 8.2. Các lỗ hổng cụ thể
- **Không có qualification/success-criteria primitive.** Contract chỉ có 1 `primaryMetric` + `validityRules` **dạng chuỗi tự do** (string[]) — engine không diễn giải được (không eval, không schema). "Metric artifact must exist" là validityRule mẫu nhưng engine chỉ check `evidenceRequired` tồn tại file, **không check validityRules** (chỉ lưu). Success criterion của node/task (acceptance criteria trong task.md) cũng không liên kết gì với metric contract — hai hệ song song không gặp nhau.
- **Không có tool nào *tạo* giá trị metric.** `source.command` được lưu trong contract nhưng **"stored, not auto-run in V1"** (doc tool thừa nhận) — mọi giá trị phải do agent tự ghi `metrics` param khi gọi `swarm_run_record`. Nghĩa là: agent tự chấm điểm chính mình (self-report), chỉ có digest-file gate chống sửa file sau, **không chống agent khai số tuỳ ý**. Qualification metrics thực sự (chạy test, đo precision...) phải do LLM tự nhớ thực thi command rồi copy số — bước này không được engine kiểm chứng (không có "giá trị trích từ artifact khớp jsonPath" check khi record; `jsonPath` chỉ dùng lúc... không có chỗ nào chạy cả).
- **Skill không trigger được từ trong swarm.** Skill nằm ở `.agents/skills/` của human-user; các agent con spawn ra có thể load skill, nhưng không có graph node role/kind `metric-designer`, không có node template "define qualification metrics" trong `buildDefaultGraph` (plan→implement→test→fix→review→commit — không có node define-metric/evaluate/baseline). Muốn chạy loop metrics phải PM tự biết gọi đúng chuỗi 8 tool theo đúng thứ tự skill mô tả — một LLM agent thường không làm trọn vẹn nếu không được nhét skill vào prompt.
- **Iteration loop là orchestration thủ công.** `swarm_iteration_create/record/status/context` chỉ ghi/lọc file; "loop" V1.5 (loop.ts) là nudge-harness quanh task graph, **không kết nối iteration session với graph execution** — không có gì ép node `run_uat` phải `swarm_run_record` với đúng `metricContractId`, nên runs.jsonl và task.json evidence dễ lệch nhau (run có metric nhưng node done thiếu evidenceRefs, hoặc ngược lại). Memory gate kiểm evidenceRefs tồn tại + digest, nhưng **không kiểm run có thuộc task/node đang chấm** — memory claim có thể mượn run của task khác cùng contract.
- **baseline không được engine bảo vệ.** `swarm_iteration_create(baselineRunId)` validate tồn tại, nhưng không chặn baseline bị thay (append record mới cùng runId với metric khác — latest-by-id wins) → best/improvement toàn phiên có thể bị flip bằng cách append dòng runs.jsonl thủ công.
- **`minimumMeaningfulChange` chỉ là cờ `meaningful` boolean** trong status; không threshold chặn promote memory hay chặn loop kickoff round mới — một "improvement" 0.001 không meaningful vẫn đủ để vòng lặp tự tái khởi động (maxRounds mặc định vô hạn, mục 2.2).

### 8.3. Mitigate gợi ý
- Thêm `type:"command"` execution gate: khi `swarm_run_record` với contract có `source.command`, engine chạy lệnh + trích `jsonPath` + **so sánh với `metrics` do agent khai** (mismatch → reject run) — biến self-report thành measured-report với chi phí nhỏ.
- Formalize `validityRules` thành schema nhỏ (`requiresArtifact`, `requiresCommandExitZero`, `maxMetricAge`) để engine thực thi được; liên kết `task.acceptanceCriteria[]` với `contract.evidenceRequired` qua id.
- Thêm default-graph variant `buildMetricQualificationGraph` (define_metric → baseline → implement → evaluate → compare → distill) và một roleKind `evaluator` để skill ↔ engine có điểmIntegration thay vì dựa PM đọc skill.
- Pin baseline digest vào iteration session khi create; chặn memory propose khi `meaningful=false` trừ khi waived.

## 9. Bảng tổng hợp rủi ro

| # | Rủi ro | Sev | Điểm nghẽn/xung đột | Mitigate gợi ý |
|---|---|---|---|---|
| 1.1 | Stale-lock break → concurrent write `swarm-state.json` | Cao | Lost update toàn cục | Heartbeat lock (pid+ts trong lock dir), CAS bằng version trong state |
| 1.2 | Read-modify-write nguyên khối, mất ack/agent | Cao | Mọi hook | Cùng 1.1; tách state per-domain (agents/messages/tasks) |
| 1.3 | `delivered` ledger nhiều writer | TB | Dup inject / mất surface | Single-writer qua reconcile; hoặc move dedup vào mailbox offset |
| 2.1 | Orchestrator pump 5s đọc mailbox không trim, window 50, 10/tick | Cao (dài hạn) | Nghẽn hình phễu PM | Trim mailbox theo checkpoint; tăng window; priority queue |
| 2.3 | Injected-unacked không bao giờ auto re-inject | Cao | Message ứ bền | Re-inject có giới hạn sau ack_missing; hoặc check pane-current-command trước khi coi delivered |
| 2.5 | Idempotency/nudge check O(M) trong lock | TB | Kéo dài critical section | Index Map idempotencyKey trong state |
| 3.1 | 2 orchestrator / 2 process cùng agent id | Cao | Duplicate actions, cướp pid | Lease single-orchestrator; pid-guard cho tool handlers |
| 3.2 | 2 swarm share `.pi/swarm/` | TB | Trộn mailbox/identity | Namespace theo swarmId |
| 4.1 | Pane alive ≠ pi alive | Cao | Dead-marked-delivered | Probe `pane_current_command` + probe prompt marker |
| 4.3 | send-keys/register vào pane ngoài swarm | TB | Cross-talk, kill nhầm window | Ghi swarm marker vào pane_user_option; kill check owner |
| 4.5 | Settle time cứng → prompt bị nuốt | Cao | Agent spawn im lặng | Poll pane cho pi prompt marker trước send |
| 4.6 | tmux server chết = toàn swarm chết | TB | SPOF | Doc runbook; reconcile hàng loạt sau sự cố |
| 5.3 | Reassign khi agent cũ còn chạy | TB | Double-work, artifact đè | Assign chặn node in_progress trừ force; nudge agent cũ stop |
| 5.1 | Edge outcome không khớp → pending vĩnh viễn | TB | Stall không nudge | Validate outcome vocabulary; nudge cả "pending lâu" |
| 2.6 | Settle-notify false positive (response đã verified / node đã done) | Thấp | Nhiễu PM, hành động thừa | Re-check closure trước khi notify; dọn activeTaskIds theo node status |
| 7.1 | Spawn không truyền model → luôn glm-5.1/zai | TB | Vendor lock-in, rate limit | defaultModel settings mọi env; preset alias; provider map từ registry |
| 7.1 | restart giữ model cũ vĩnh viễn | TB | Không đổi model hàng loạt | restartAgent nhận model override |
| 8.2 | validityRules không được engine thực thi | Cao (đối với use qualification) | Success criteria chỉ trên giấy | Schema hóa rules + command gate |
| 8.2 | Metric value là self-report, source.command không auto-run | Cao | Số liệu không tin được | Run-record chạy command + đối chiếu jsonPath |
| 8.2 | Skill metric_designer không tích hợp graph/agent role | TB | Loop metrics không thể tự chạy | Node template + roleKind evaluator |
| 8.2 | Baseline mutable qua append latest-by-id | TB | Flip best/improvement | Pin digest baseline vào iteration |

## 8. Câu trả lời trực tiếp cho câu hỏi đặt ra

- **Có xung đột gì không khi multiple agents làm việc?** Có, ba lớp: (a) xung đột ghi state do lock best-effort + full-file write (mất ack/agent record); (b) xung đột công việc khi reassign node đang in_progress (hai agent cùng code một node, edit lock chỉ advisory); (c) xung đột "danh tính" khi 2 process dùng cùng agent id (tool handlers không pid-guard).
- **Có bị nghẽn message ở đâu không?** Có — điểm nghẽn lớn nhất là **mailbox của orchestrator + pump 5 giây** (mọi notify đổ về đây, đọc toàn file JSONL mỗi tick, window scan 50, surface 10/tick, không trim tự động). Thứ hai là trạng thái **injected-but-unacked** — message đã coi là delivered nhưng agent không thực sự đọc (pane ở dialog/copy-mode/pi chết) thì không bao giờ được re-inject tự động. Thứ ba là chính **swarm lock** khi N agent đông: mọi hook đều serial qua một lock directory.
- **Tích hợp tmux có rủi ro gì không?** Có: liveness chỉ là "target resolve được" (không chắc pi còn sống); send-keys không xác thực chủ sở hữu pane (có thể gõ vào pane người dùng/swarm khác, kill-window làm chết cả shared window); settle time cứng làm mất kickoff prompt; window-index target không ổn định khi user đổi layout; tmux server là SPOF cho toàn swarm kể cả PM.
- **Spawn mặc định glm-5.1?** Đúng: chuỗi fallback `params.model → settings → env → DEFAULT_MODEL("glm-5.1")` + `providerForModel` bảng cứng 1 mục (mọi model ≠ gpt-5.4-mini đều ghép zai-coding-cn). Tool `swarm_spawn_agent` không truyền model (thói quen của LLM caller) thì mọi agent sinh ra đều glm-5.1; `restartAgent` còn "đúc kết" model cũ vĩnh viễn. Chỉ settings `.pi/settings.json` ở đúng cwd mới rescue được.
- **Skill qualification metrics sơ sài?** Đúng, theo 2 chiều: (a) skill `swarm_metric_designer` chỉ là prompt-guide — không node/role graph nào gọi nó, PM phải tự thuộc 8-tool sequence; (b) engine metric chỉ là file-IO — `validityRules` là chuỗi tự do không được thực thi, `source.command` "stored, not auto-run", giá trị metric do agent **self-report** (gate chỉ chặn sửa file sau, không chặn khai số tuỳ ý), baseline mutable qua append latest-by-id, và `minimumMeaningfulChange` không chặn promote memory hay loop round mới. Nói ngắn: qualification/success-criteria hiện là **tuyên bố** chứ chưa phải **cơ chế**.

---
*Phân tích thực hiện trên commit hiện tại của `master`; tham chiếu hàm theo `extensions/swarm/src/`. Khi thay đổi code, cập nhật lại bảng tham chiếu.*
