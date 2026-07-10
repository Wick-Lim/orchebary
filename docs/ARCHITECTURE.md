# Orchebary — 아키텍처 & 워크플로우 총람

> Warp급 터미널 + Vibe-Kanban식 AI 에이전트 오케스트레이션을 결합한 Electron 데스크톱 개발 도구.
> 이 문서는 코드 전체(main/preload/renderer/shared, 약 8,500줄 TS/TSX)를 서브시스템·데이터흐름·상태머신 단위로 정밀 분해한 총람이다.

---

## 0. 한눈에

- **정체성**: 칸반 카드 = "코딩 태스크". 카드를 **In Progress로 드래그**하면 프로젝트 전용 git worktree에서 실제 zsh 터미널이 열리고 `claude`가 자동 실행 → 종료 시 자동 커밋 → diff 집계 → 카드가 **In Review**로. 동시에 Warp식 **커맨드 블록** 터미널(OSC 133 셸 통합)을 제공한다.
- **스택**: Electron 39, electron-vite, React 19, TypeScript 5.9, zustand 5, better-sqlite3(WAL), node-pty, xterm.js 6(WebGL), dnd-kit, fractional-indexing, cmdk, zod 4, execa, uuid(v7), nanoid.
- **프로세스 3-타깃 + 공용 계약**:
  - `src/shared/` — **동결 계약**(런타임 import 금지, 타입/상수만): `ipc.ts`(IPC 채널 맵), `domain.ts`(도메인 타입).
  - `src/main/` — PTY·SQLite·git·에이전트 오케스트레이션(모든 특권 로직).
  - `src/preload/` — `contextBridge`로 `window.orchebary`만 노출(고정 채널 래퍼, passthrough 없음).
  - `src/renderer/` — sandbox+contextIsolation React UI.

### 핵심 설계 규칙
1. 렌더러는 sandbox+contextIsolation. PTY/git/DB/에이전트는 전부 main.
2. 고빈도 터미널 바이트는 **zustand를 거치지 않는다** — xterm 인스턴스/marker는 레지스트리가 소유(React 밖).
3. `marker.line`은 **캐시 금지**(reflow/스크롤백 트림 시 변동) — 항상 live 조회.
4. 셸 통합은 feature-detect(첫 `OSC 133;A`) — 실패 시 일반 터미널로 강등.
5. 실행 중 태스크는 보드에서 함부로 이동 불가(드래그 아웃 시 detach). 앱 종료 시 자식 전부 kill, 재시작 시 reconcile.

---

## 1. 디렉터리 지도

```
src/shared/           # 3-타깃 공용 동결 계약 (런타임 import 0)
  ipc.ts              #   Invokables(37) / Sendables(3) / MainEvents(3) 채널 맵
  domain.ts           #   Task/TaskRun/Project/AppEvent/… 도메인 타입 + 상태 상수표

src/main/             # Electron main (모든 특권 로직)
  index.ts            #   부트: whenReady→env warm→DB open+migrate→IPC 등록→window
  smoke.ts            #   ORB_SMOKE=1 헤드리스 자가진단(PTY+OSC133 왕복 검증)
  terminal/           #   PTY 파이프라인
    SessionManager.ts #     node-pty 소유, 세션당 DataBatcher+FlowController 배선
    DataBatcher.ts    #     5ms/64KB 코얼레싱(출력 프레이밍)
    FlowController.ts #     ack-크레딧 백프레셔(1MB high / 256KB low 히스테리시스)
    shellEnv.ts       #     로그인 셸 env 캡처(GUI/launchd PATH 복원), 메모이즈
    shellIntegration.ts#    ZDOTDIR shim 경로 + env 증분
  agents/             #   오케스트레이션 엔진
    RunOrchestrator.ts#     상태머신·프로젝트↔세션 매핑·settle 파이프라인
    CommandTracker.ts #     터미널당 OSC133 A/C/D 직렬화 상태머신
    GitService.ts     #     git CLI 래퍼(worktree/diff/merge/rebase, execFile)
    WorktreeManager.ts#     orc/* worktree·브랜치 할당(workbench + per-task)
    ClaudeCodeAdapter.ts#   claude CLI 어댑터 + stream-json NDJSON 파서
    AgentAdapter.ts   #     벤더 무관 에이전트 추상 인터페이스
    registry.ts       #     AgentKind→adapter(현재 claude-code만 라이브)
    orchestratorHandle.ts#  set/getOrchestrator 싱글턴(순환 import 회피)
  db/                 #   SQLite(better-sqlite3, WAL)
    database.ts       #     getDb/openAt/migrate + nowIso
    migrations.ts     #     forward-only 마이그레이션(v1 init)
    TaskStore.ts RunStore.ts ProjectStore.ts HistoryStore.ts SettingsStore.ts
  ipc/                #   채널→핸들러→스토어 배선
    router.ts         #     handle/on/broadcast + assertTrustedSender + zod
    terminal.ipc.ts tasks.ipc.ts agent.ipc.ts misc.ipc.ts ui.ipc.ts

src/preload/index.ts  # contextBridge → window.orchebary (invoke/send/subscribe 3원소)

src/renderer/src/
  terminal/           # xterm 레지스트리 + 커맨드 블록
    TerminalRegistry.ts#    모든 xterm 인스턴스 소유(React 밖), WebGL LRU(6), IPC data/ack
    BlockManager.ts   #     OSC 이벤트→마커/데코레이션→블록 세그먼트
    blockStore.ts     #     세션당 vanilla zustand(블록 레코드)
    blockOutput.ts    #     블록 출력 텍스트 lazy 추출(soft-wrap 재결합)
    ShellIntegrationAddon.ts# OSC 133/633/7 파서(typed 이벤트 이미터)
    TerminalView/BlockHeaderChrome/StickyBlockHeader/BlockInspector/BlockPortals/PerfHud
  kanban/             # 보드(기본 뷰)
    BoardPage/Column/TaskCard/TaskDetailPanel/DiffView/RunLogView/ProjectSwitcher
    ordering.ts       #     fractional-indexing 드롭 위치 계획
    runDot.ts toastStore.ts Toasts.tsx
  layout/             # 터미널 워크스페이스
    tree.ts           #     순수 이진 분할 트리 대수(DOM/IPC 없음)
    PaneLayout/TerminalPane/WorkspaceRail(Working-on 레일)
    KeybindingService.ts#   document capture-phase 키 디스패처
    HistorySearchOverlay.tsx# ⌃R 히스토리 검색
  palette/            # ⌘K 커맨드 팔레트 + Workflows
    ActionRegistry.ts actions.ts CommandPalette.tsx PaletteHost.tsx
    workflows.ts      #     사용자 정의 커맨드 스니펫(설정 저장, {{param}})
    WorkflowParamsModal.tsx
  worktrees/          # WorktreesPage(리스트) + GitPanel(GitLens식 사이드바)
  state/              # boardStore / layoutStore / uiStore (zustand)
  App.tsx main.tsx

resources/shell-integration/zsh/  # ZDOTDIR shim + orchebary-integration.zsh (OSC 방출)
```

---

## 2. 공용 계약 (`src/shared`)

두 파일 모두 **런타임 import 0**(타입·const 리터럴만) → 어느 프로세스에서든 부작용 없이 import 가능.

### 2.1 도메인 타입 (`domain.ts`)
- **상태 유니온(둘은 별개 생명주기)**
  - `TaskStatus = todo | inprogress | inreview | done | cancelled`
  - `RunStatus = queued | running | completed | failed | cancelled`
  - `AgentKind = claude-code | gemini-cli | codex` (현재 claude-code만 구현)
- **`Task`** — 카드 엔티티. `position`은 **분수 인덱싱 문자열**(숫자 아님), `latestRun`/`remoteLink`/`diffStat`는 리스트 쿼리에서 조인되는 비정규화 읽기 모델. 소프트 삭제(`deletedAt`).
- **`TaskRun`** — 실행 로우 전체(`worktreePath`, `branch`, `baseRef`, `pid`, `exitCode`, `costUsd`, `numTurns`, `logPath`, `parentRunId`, `agentSessionId`).
- **`AgentEvent`** — claude `stream-json` NDJSON 이벤트 분류(`system|assistant-text|tool-use|tool-result|result|raw`), `result`에 `{ok,summary,sessionId,costUsd,numTurns}`.
- **`WorktreeEntry`** — 관리/유령(`orphan`) worktree, `dirty`(미커밋) 플래그.
- **`AppEvent`** — 단일 `app:event` 채널로 다중화되는 **9-암 판별 유니온**: `task.updated|deleted|moved`, `run.status|output|diffstat`, `terminal.registered|closed`, `jira.syncState`.
- `RemoteLinkView`/`jira.syncState`(idle|syncing|error) — **Jira는 계약에 내장, 동기화 엔진은 Phase 2**.

### 2.2 IPC 계약 (`ipc.ts`) — 전송 티어를 의미로 선택
- **`Invokables` (37채널, req/res, `invoke`/`handle`)**: `app:ping`; `terminal:*`(4); `projects:*`(4); `tasks:*`(6: list/listWorkingOn/create/update/move/delete); `runs:*`(5: start/followUp/cancel/listForTask/readLog); `git:*`(7: diff/diffStat/merge/logGraph/branches/branchAction/show); `worktree:*`(4: openInTerminal/remove/listAll/pruneGhost); `agents:listAvailable`; `history:search`; `settings:get/set`; `dialog:pickDirectory`; `ui:contextMenu`.
- **`Sendables` (3채널, fire-and-forget, promise 없는 핫패스)**: `terminal:input`, `terminal:ack`(파싱 완료 바이트 크레딧), `history:append`.
- **`MainEvents` (3채널, push)**: `terminal:data`(`Uint8Array`), `terminal:exit`, `app:event`(`AppEvent`).
- **낙관적 동시성**: `tasks:move`는 `expectedRev`를 왕복하고 `{ok,rev}|{ok:false,reason}`을 반환, 같은 `rev`가 `task.moved` 브로드캐스트에도 실려 모든 창이 수렴.
- 파생 `InvokeChannel/SendChannel/EventChannel = keyof …`로 preload/main 래퍼를 컴파일타임 제약.

---

## 3. 보안 경계 (`preload`)
- 노출 전역은 **`window.orchebary` 단 하나**(README의 `window.api`는 구칭). 세 원소 래퍼만 존재:
  - `invoke<K>(ch, req)` → `ipcRenderer.invoke`
  - `send<K>(ch, payload)` → `ipcRenderer.send` (3개 핫패스 전용)
  - `subscribe<K>(ch, cb)` → `ipcRenderer.on`, **원시 `IpcRendererEvent`는 렌더러에 절대 노출 안 함**, disposer 반환.
- **제네릭 passthrough 없음** → 침해된 렌더러도 열거된 채널 이외엔 도달 불가.
- `OrchebaryApi = typeof api`로 `.d.ts` 전역이 구현과 자동 동기화(드리프트 불가).
- main 측 `router.ts`가 모든 진입점에서 **`assertTrustedSender`**(top-level mainFrame만 허용) + **zod 검증**(핫패스는 의도적으로 zod 생략, 구조적 typeof 가드).

---

## 4. 영속성 (`src/main/db`, SQLite/WAL)
`getDb()`가 `<userData>/orchebary.db`를 lazy open → `journal_mode=WAL`, `foreign_keys=ON` → **`migrate()`**(forward-only; 기존 DB는 `${file}.bak-v<n>` 백업 후 트랜잭션으로 적용). 마이그레이션 v1 `init` 테이블:

| 테이블 | 요지 |
|---|---|
| `projects` | id, name, repo_path(UNIQUE), base_branch, settings_json, 타임스탬프, archived_at |
| `tasks` | status CHECK(5값), **position(분수키)**, **rev(낙관 락)**, deleted_at; `idx_tasks_board(project_id,status,position) WHERE deleted_at IS NULL` |
| `task_runs` | agent_kind, prompt, parent_run_id, agent_session_id, worktree_path, branch, base_ref, pid, status CHECK(5값), exit_code, cost_usd, num_turns, log_path; `idx_runs_active WHERE status IN (queued,running)` |
| `remote_links` | Jira 연동(provider/remote_key/status/push_pending/sync_error) — **1일차부터 준비, 엔진은 Phase 2** |
| `jira_status_map` | jira↔local 상태 전이 매핑 |
| `command_history` | 셸 통합 블록 파이프라인 출처(session_id, cwd, command, exit_code, started_at, duration_ms, project_root) |
| `app_settings` | key/value(JSON) — **Workflows도 여기 `workflows` 키에 저장** |

스토어 API 요점:
- **`TaskStore`** — `LIST_SQL`(latest run + remote_link 조인). `move(id,status,position,expectedRev)`: `expectedRev!==null && rev!==expectedRev` → `{ok:false,'stale revision'}`; 성공 시 `rev=rev+1`. `keyAtColumnEnd`=`generateKeyBetween(last,null)`. `listWorkingOn(liveTaskIds)`=inprogress ∪ 라이브 세션 태스크. id는 **uuid v7**(시간 정렬).
- **`RunStore`** — `insert`(status='queued'), `markRunning(pid)`, `finish`(COALESCE로 세션ID/비용/턴 보존), `listActive`(부트 reconcile용), `listLatestPerWorktree`(Worktrees 뷰 백본).

---

## 5. 서브시스템 상세

### 5.1 터미널 PTY 파이프라인 (`main/terminal`)
- **`SessionManager`**: 모든 `IPty` 소유(shell/agent 두 kind). 로그인 셸을 `['-il']`로 스폰, `TERM=xterm-256color`/`COLORTERM=truecolor`/`TERM_PROGRAM=orchebary` 주입. zsh면 `shellIntegrationEnv`(ZDOTDIR shim, `ORB_SESSION_ID`, `ORB_SHELL_INTEGRATION=1`) 병합, **`req.env`가 최후 승리**(테스트 격리). 세션당 `DataBatcher`+`FlowController` 배선.
- **`DataBatcher`**: `pty.onData`를 코얼레싱 — **5ms 타이머(`FLUSH_INTERVAL_MS`) 또는 64KB(`MAX_BATCH_BYTES`)** 중 먼저. 타이머는 첫 미플러시 청크에만 무장(최악 지연 5ms 상한). 단일 청크 fast-path(`Buffer.concat` 회피). `cat bigfile`을 수천 msg/s → ~200 msg/s로.
- **`FlowController`**: ack-크레딧 백프레셔. `sent(flushed frame len)` → `outstanding>1MB`(HIGH)면 `pty.pause()`(커널 PTY 버퍼에서 생산자 차단). `acked(bytes)` → `<256KB`(LOW)면 `pty.resume()`. **256KB~1MB 히스테리시스**로 flapping 방지. **ack는 렌더러 xterm이 파싱을 끝낸 뒤에만** → 실제 렌더 진행을 반영.
- **`shellEnv`**: `$SHELL -ilc '/usr/bin/env -0'`를 NUL 구분 파싱(값에 개행 있어도 견고), 메모이즈, 실패해도 reject 안 함(clean env 바닥값). GUI/launchd 앱이 homebrew/nvm PATH를 놓치는 문제 해결.
- **ZDOTDIR shim**(`resources/shell-integration/zsh`): VS Code식. `ZDOTDIR`을 shim 디렉터리로, `ORB_USER_ZDOTDIR`로 원본 보존 → 각 dotfile이 잠시 원본으로 되돌려 유저 startup 실행 후 복원 → 유저 설정 + 우리 통합 둘 다 로드. `orchebary-integration.zsh`의 `preexec/precmd` 훅이 OSC 방출: `133;A`(prompt-start), `133;B`(prompt-end, p10k/omz가 PS1을 재할당하므로 매 precmd zero-width PS1 마커 재삽입), `133;C`(exec), `133;D;<exit>`(finished), `633;E;<escaped cmdline>`(정확한 명령줄, `;`/개행 hand-encode), `OSC 7`(cwd). `HISTFILE`은 shim 밖으로 재배치.

### 5.2 렌더러 터미널 & 커맨드 블록 (`renderer/terminal`)
- **`TerminalRegistry`**(싱글턴): 모든 xterm `Terminal`과 **재부모화 가능한 DOM 컨테이너**를 소유 — **React state가 아님**, PTY 세션 전 생애 유지. 탭/pane 이동 시 `attach()/detach()`로 컨테이너를 옮겨 **스크롤백 보존**. IPC `onData`를 **한 번만** 바인딩, `term.write(data, ()=>terminal.ack(len))`로 flow-control. WebGL은 attach 시 LRU로 부여(최대 6, 컨텍스트 소실 시 DOM 렌더러 폴백).
- **`ShellIntegrationAddon`**: `parser.registerOscHandler`로 133/633/7 등록. `term.write` **동기 파싱 중** 발화(커서가 경계 행에 정확히 위치). typed 이벤트로 변환.
- **`BlockManager`**: 이벤트 구독 → `registerMarker(0)`(현재 행 고정)+`registerDecoration`으로 블록당 DOM 앵커 → 세션당 vanilla zustand(`getBlockStore`)에 불변 `CommandBlock` 발행. 블록당 마커 3개(prompt/output/end), 각각의 `onDispose`가 스크롤백 트림에 따라 `partial` 강등 또는 제거. 누락 OSC에 견고(정지된 running 블록 강제 close, 133;C가 prompt 없이 오면 합성). 완료 시 `history.append`.
- **UI**: `BlockPortals`가 데코레이션 DOM에 `BlockHeaderChrome`(cwd/명령/버튼/duration/exit 배지)를 portal, `StickyBlockHeader`가 스크롤 시 마커 라인 이진 탐색으로 상단 커버 블록 고정, `BlockInspector`가 `extractBlockOutput`(라이브 버퍼 행 범위, soft-wrap 재결합). alt-screen(vim/htop)에서는 마커·크롬 전면 억제.

### 5.3 오케스트레이션 엔진 (`main/agents`) — **심장부**
- **`RunOrchestrator`**: **프로젝트당 하나의 라이브 터미널**(`projectSessions`↔`sessionProjects` 역맵) + 그 세션당 하나의 `CommandTracker`. 카드를 In Progress로 넣으면 그 단일 세션에 프롬프트를 큐잉하고, claude 명령이 끝나면 **거기 탄 태스크들을 한 번에 settle**(자동 커밋 → diffStat → In Review). `stopped` 플래그로 종료 중 DB 접근 차단.
- **`CommandTracker`**: 터미널당 4-phase 상태머신 `idle→wait-prompt→wait-exec→running→(done)idle`. OSC `133;A/C/D`를 프레임에서 스캔(마커가 프레임 경계에서 잘려도 32바이트 tail 보존). 명령은 **bracketed paste**(`ESC[200~…ESC[201~CR`)로 주입(임베디드 개행 리터럴화). 에이전트가 `>INPUT_READY_MS(20s)` 살아있으면 후속 프롬프트를 **라이브 대화에 직접 타이핑**, 부팅 중이면 `pending[]` 대기(startup 다이얼로그 오염 방지). OSC 없는 degraded 셸은 25s 폴백 타이머로 그냥 타이핑.
- **`WorktreeManager`**: 루트 `~/.orchebary/worktrees`. **`ensureWorkbench`** = `<root>/<shortId(pid)>/workbench` + 브랜치 `orc/workbench-<shortId>`(재사용; 디렉터리만 사라졌으면 prune+attach로 self-heal). `create`(per-task, 숫자 접미사 충돌 회피)도 존재하나 **오케스트레이터는 workbench만 사용**(§7 드리프트).
- **`GitService`**: `execFile` 래퍼(electron import 0 → vitest). `worktreeAdd/attach/remove/prune`, `addAllAndCommit`, `diffStat`/`diffFiles`(numstat `-M`; 바이너리·rename 견고 파싱; `MAX_BUFFER=64MB`), **`mergeSquash`**(clean tree + baseBranch 체크아웃 프리플라이트, 충돌 시 `git reset --merge` 롤백, no-op도 성공), `rebase`(충돌 시 abort+원복). 삭제는 항상 `-D`(squash merge는 `-d`로 merged 인식 안 됨).
- **`ClaudeCodeAdapter`**: **두 실행 모드 공존**(§7): ① 헤드리스 `buildSpawn`=`claude -p <prompt> --permission-mode acceptEdits --output-format stream-json --verbose`(+`ClaudeStreamParser` NDJSON→AgentEvent, cost/turns 집계) ② 인터랙티브 `buildInteractiveCommand`=`claude --permission-mode plan '<prompt>'`(**오케스트레이터가 실제 사용**). `checkAvailability`는 로그인 셸 env로 `claude --version`.
- **`registry`**: `gemini-cli`/`codex`는 `listAvailability`에 `{available:false,'not yet supported'}`로 광고(어댑터 맵엔 claude-code만).

### 5.4 렌더러 상태 (`renderer/state`) & 뷰 셸
- **`boardStore`**: 프로젝트/`tasksById`(+rev)/필터/선택. `applyEvent`는 **멱등·rev 단조**(오래된 에코 무시), 타 프로젝트 이벤트 드롭. `moveTask`는 **진짜 낙관적 동시성**(스냅샷→로컬 적용→`expectedRev` 전송→실패/예외 시 전체 롤백, 성공 시 acked rev만 전진). `withRev`가 wire의 plain `Task`에 런타임 `rev`를 한 곳에서만 widening.
- **`layoutStore`**: 탭/이진 분할 pane 트리 + PTY 세션 **메타데이터 미러**(바이트 아님). **adopt-only 부트**(PTY 스폰 안 함; `terminal.list()`로 기존 세션 입양). `moveFocus`는 `getBoundingClientRect` 기하 최근접(축 거리 + 교차축 4배 페널티). refcount 0일 때만 `terminal.kill`.
- **`uiStore`**: `activeView('terminal'|'board')` + `requestOpenSession/consumeOpenSession` **디커플링 seam**(kanban/worktree가 layoutStore를 import하지 않고 세션 열기 요청, App이 `revealSession`으로 번역).
- **`App`/`main`**: **StrictMode 미사용**(xterm은 명령형·레지스트리 소유 자원, 이중 마운트 시 손상). Nerd Font를 첫 렌더 전 로드(xterm이 생성 시 글리프 측정). 터미널 뷰는 `display:none`으로 마운트 유지(스크롤백 생존), 보드만 언마운트.
- **`worktrees/GitPanel`**: GitLens식 우측 사이드바 — `git log --graph` ASCII 파싱(정규식으로 hash/refs/message), 브랜치 merge/rebase/delete 컨텍스트 메뉴(baseBranch·현재 브랜치 가드), `WorktreeList`(dirty 점, 유령 스타일, 열기/제거/prune). 이벤트 버스트를 300~400ms 디바운스로 코얼레싱.

### 5.5 레이아웃·팔레트 (`renderer/layout`, `renderer/palette`)
- **`tree.ts`**: 순수 이진 분할 대수. 모든 노드는 `LeafNode`(세션 1:1) 또는 자식 2개 `SplitNode`(ratio 0.05~0.95). 구조 공유(변화 없으면 동일 참조 반환).
- **`KeybindingService`**: `document` **capture-phase** 리스너(xterm이 textarea에서 키를 삼키기 전에 가로채야 함). Combo는 modifier **정확 일치**. `⌘K`(palette.toggle)는 `terminalOnly` 아님 → 보드에서도 동작.
- **`ActionRegistry`**: static 액션(Map) + 동적 provider(Set, 쿼리마다 재평가). 빌트인: 탭/pane/뷰/히스토리 + `session.switch.*`(라이브 세션) + `workflow.*`.

---

## 6. 워크플로우 (엔드투엔드 트레이스)

### 6.1 커맨드 블록 생명주기
키 입력 → `term.onData` → `terminal:input`(send) → main `pty.write`. zsh가 명령 실행하며 `OSC 633;E → 133;C → 출력 → 133;D;<exit> → 7 → 133;A`. 출력은 `DataBatcher`(5ms/64KB)로 프레이밍, `FlowController.sent`가 백프레셔, `terminal:data`(Uint8Array) push. 렌더러가 `term.write` **후 ack**(크레딧 반환→resume). 파싱 중 `ShellIntegrationAddon`이 OSC를 동기 발화 → `BlockManager`가 마커/데코레이션으로 블록 세그먼트 → 크롬(exit 배지·duration·copy·re-run) → 완료 시 `history:append`로 SQLite 영속. **블록 상태**: `prompt→running→done`(+`partial` 트림, 빈 엔터/ctrl-c는 bare `133;D`로 제거).

### 6.2 에이전트 런 생명주기 (**중심 워크플로우**)
```
[보드 드래그 → In Progress]
  BoardPage.onDragEnd → planDropPosition(분수키) → boardStore.moveTask(낙관적)
    → invoke tasks:move → router(assertTrustedSender+zod)
      → tasks.ipc handle('tasks:move'):
          · inprogress 밖으로 나가면 orchestrator.detachTask (터미널 유지)
          · TaskStore.move(expectedRev 가드, rev++)
          · broadcast task.moved + task.updated
          · inprogress로 들어오고 활성 run 없으면 → orchestrator.start(id)  (fire-and-forget)
[RunOrchestrator.start]
  · 중복 가드(활성 run 있으면 그거 반환)
  · adapter.checkAvailability (로그인 셸 env로 claude --version)
  · WorktreeManager.ensureWorkbench → orc/workbench-<pid>, baseRef=revParse(baseBranch)
  · RunStore.insert(status=queued, worktree/branch/baseRef 스냅샷) ; moveTask→inprogress
  · ensureProjectTerminal (재사용/입양/생성; zsh -il, 120x30) ; CommandTracker 배선
  · tracker.submit(buildInteractiveCommand = `claude --permission-mode plan '<prompt>'`)
  · runs.markRunning(pid) ; broadcast run.status
[런타임]
  sessions.onData(frame) → tracker.push → OSC 133 A/C/D 스캔
  133;D(exit) → onFinished(attachedRunIds, exit) → settleRuns
[settleRuns]  (한 명령에 여러 태스크가 탈 수 있음 → 배치)
  · git.statusPorcelain 있으면 addAllAndCommit("orchebary: <제목들>")
  · git.diffStat(baseRef) → broadcast run.diffstat (카드 +/- 칩)
  · 각 run: runs.finish(completed|cancelled) ; moveTask→inreview ; broadcast run.status
[In Review]
  TaskDetailPanel: runs:listForTask, DiffView(git:diff), RunLogView(runs:readLog+run.output 스트림)
  · Follow-up(inreview만) → runs:followUp → start(같은 workbench에 새 run, 같은 세션에 프롬프트)
  · Cancel → ctrl-c ×2 + 6s 하드킬 폴백(터미널 생존, 나머지 큐는 settle)
  · Merge(inreview만) → git:merge → mergeSquash(baseBranch로 squash) → 성공 시 태스크 done
  · Open terminal / Discard(worktree:remove, 활성 run이면 거부 → cancelled)
```
**태스크 상태**: `todo→inprogress→inreview→done`(+측면 `cancelled`). **런 상태**: `queued→running→completed|failed|cancelled`.

### 6.3 칸반 CRUD·정렬·Working-on 레일
- **정렬**: 카드 위치는 **분수 인덱싱 키**(문자열 비교). `planDropPosition`이 dnd-kit `arrayMove` 의미를 수동 재현(자기 제거 후 하향=over 뒤/상향=over 앞, off-by-one 회피), 손상 키는 try/catch로 끝에 append 폴백. `columns`는 **필터 미적용 전체**로 드롭 계산, 표시만 필터.
- **동시성**: 낙관적 이동 + `expectedRev` + `task.moved`의 `rev`로 다중 창 수렴.
- **레일**: `tasks:listWorkingOn`(inprogress ∪ 라이브 세션 태스크)을 프로젝트별 그룹(프로젝트당 에이전트 터미널 1개) + 중첩 이슈 행, 스크래치 셸은 하단. 이벤트 시 150ms 디바운스 refresh.

### 6.4 IPC 계약 흐름
`window.orchebary.*` → preload 고정채널 래퍼 → Electron → `router`(assertTrustedSender + zod parse; 핫패스는 null 스키마) → 도메인 `*.ipc.ts` 핸들러 → 스토어/서비스 → 응답(또는 throw→reject). Push는 `broadcast`가 파괴 안 된 모든 `webContents`에 `wc.send`. 등록 순서(`index.ts`): `app:ping` → terminal → misc → tasks → agent → ui.

### 6.5 앱 라이프사이클: 부트·reconcile·크래시복구·종료
`whenReady` → (`ORB_SMOKE=1`이면 smoke 후 종료) → `captureLoginShellEnv` 예열 → `getDb()`(WAL+migrate) → IPC 등록 → `registerAgentIpc`에서 오케스트레이터 생성/`setOrchestrator` → **`reconcileOnStartup`**(활성 run을 `cancelled`+요약 'app restarted — session ended'로 정착, inprogress 태스크는 inreview로, 유령 worktree는 **prune하되 orphan 디렉터리는 리뷰 위해 보존** = adopt-only) → `createWindow`(하드닝된 webPreferences, 외부 링크는 OS 브라우저, 내비게이션 차단). 종료: `before-quit` 두 개(오케스트레이터 `stopAll`로 DB 접근 차단, `sessionManager.disposeAll`로 PTY 전부 kill + `closeDb`). `ORB_SMOKE`는 15s 워치독으로 PTY+OSC133+cwd 왕복을 헤드리스 검증.

### 6.6 커맨드 팔레트 & **Workflows** (⌘K)
> 사용자가 지목한 "workflows"는 **CI 워크플로가 아니라 앱 내부 기능**이다.
- **정의**: `settings`의 `workflows` 키에 저장되는 **사용자 정의 터미널 커맨드 스니펫** — `{ name, command, params?: [{name, prompt, default?}] }`. 사용자 편집 JSON이라 `parseWorkflows`가 잘못된 항목을 조용히 스킵.
- **실행**: ⌘K → `CommandPalette`가 열릴 때 `refreshWorkflows()`(→`settings:get`)로 캐시 채우고 리렌더 → `ActionRegistry`의 workflows provider가 `workflow.<name>` 액션으로 노출("Workflows" 섹션). 선택 시:
  - 파라미터 없음 → `sendWorkflowCommand`가 `terminal:input`으로 활성 세션에 커맨드 주입(**개행 없음** — 사용자가 검토 후 Enter).
  - 파라미터 있음 → `layout.setPendingWorkflow` → `WorkflowParamsModal`이 값 수집(라이브 프리뷰) → `substituteParams`(`{{name}}`/`{{ name }}` 치환, 미지정은 원문 유지) → 주입.
- 활성 터미널 세션이 있을 때만 적용(`when: activeSessionId!==null`).

---

## 7. 아키텍처 진화 / 드리프트 (중요)
코드가 README보다 앞서 있으며, 두 세대의 설계가 공존한다. **현재 라이브 경로**는 후자다.

1. **worktree 모델**: `WorktreeManager.create`(태스크당 worktree, README가 기술) vs **`ensureWorkbench`(프로젝트당 단일 workbench)** — 오케스트레이터는 **workbench만** 사용. 따라서 한 프로젝트의 여러 카드가 하나의 워크트리/세션을 공유하고 배치로 settle된다.
2. **claude 실행**: 헤드리스 `claude -p … --output-format stream-json`(+`ClaudeStreamParser`, `acceptEdits`) vs **인터랙티브 `claude --permission-mode plan`(실제 터미널 주입)**. 완료 감지도 stream-json `result` 이벤트가 아니라 **OSC 133 셸 마커 + exit code**로 이뤄진다(`ClaudeStreamParser`/`interpretExit`는 `-p` 경로·`runs:readLog`용으로 잔존).
3. **`--continue`**: README는 후속 프롬프트에 `--continue`를 언급하고 어댑터에 `buildInteractiveFollowUpCommand`(`--continue`)가 존재하지만, **오케스트레이터의 board 경로는 의도적으로 `--continue`를 쓰지 않는다**("worktree 내 대화 조회가 불안정 — 각 턴은 self-contained", `RunOrchestrator.ts` 주석). 후속도 같은 세션에 새 `plan` 턴으로 들어간다.
4. **reconcile 요약**: README는 고아 run을 `failed(orphaned)`로 기술하나, 실제로는 `cancelled`("app restarted — session ended")로 정착(스키마에 `orphaned` 값 없음).

---

## 8. 불변식 & 영리한 디테일 모음
- **낙관적 락**: `tasks.rev`가 매 변경마다 `+1`; 이동은 `expectedRev` 가드, 오케스트레이터는 `expectedRev=null`로 강제(자신이 진실 원천).
- **분수 인덱싱**: 순서 변경이 이웃 두 키 사이 새 키 생성만으로 끝남(대량 재작성 없음).
- **터미널 바이트는 store 우회**: 세션당 청크마다 React 리렌더를 막기 위해 xterm에 직접 write, store엔 메타데이터만.
- **`marker.line` 캐시 금지**: 트림/reflow로 변동(-1=트림됨). 블록 정렬은 라이브 라인.
- **feature-detect 강등**: 첫 `133;A` 없으면 셸 통합 off(일반 터미널), CommandTracker는 25s 폴백으로 명령 주입.
- **부트는 adopt-only**: 크래시 후 PTY 재개 안 함, 고아 worktree는 리뷰 위해 보존.
- **종료 레이스 가드**: `stopped=true`로 늦은 PTY exit 콜백이 닫힌 DB를 만지지 않음.
- **어댑터 추상화**: `AgentAdapter`로 오케스트레이터가 claude 세부와 분리(gemini/codex 확장 지점 준비).
- **native 컨텍스트 메뉴**: `ui:contextMenu`로 렌더러가 항목 스펙 전송→클릭 id 회신(렌더는 native, 로직은 renderer), 200ms 폴백으로 hang 방지.

---

## 9. 개발·빌드·테스트
```bash
npm install         # postinstall: Electron ABI 리빌드 + node-pty spawn-helper 권한 복구
npm run dev         # electron-vite HMR
npm run typecheck   # node(tsconfig.node) + web(tsconfig.web) 분리 타입체크
npm test            # vitest: tree 연산, NDJSON 파서, git 서비스, ordering 등 90+
ORB_SMOKE=1 npx electron .   # 헤드리스 자가진단(PTY+OSC133 왕복)
npm run build:mac|win|linux  # electron-builder 패키징
```
- **3-tsconfig**: `.node`(main/preload), `.web`(renderer), 루트 조합. lint=eslint(flat), format=prettier.
- **테스트 가능성 설계**: `GitService`/`WorktreeManager`/`tree.ts`는 electron/DOM import가 없어 순수 vitest로 검증.

---

## 10. Phase 2 준비 상태 (Jira)
스키마(`remote_links`, `jira_status_map`), 도메인 타입(`RemoteLinkView`), 이벤트(`jira.syncState`)가 **1일차부터 계약에 내장**되어 있고 동기화 엔진만 미구현. 태스크 카드는 `remoteLink` 칩을 이미 렌더할 수 있다.
