# Orchebary

Warp급 터미널과 Vibe-Kanban식 AI 에이전트 오케스트레이션을 결합한 데스크톱 개발도구.

- **터미널**: xterm.js(WebGL) + node-pty. OSC 133 셸 통합 기반 **커맨드 블록**(exit 배지·duration·copy·re-run·스티키 헤더), 탭·분할 패널, ⌘K 커맨드 팔레트, ⌃R 히스토리 검색(SQLite 영속), Fig식 자동완성·AI 명령 생성용 seam 포함.
- **칸반 보드**: 카드 = 코딩 태스크. **Start Agent**로 Claude Code(`claude -p --output-format stream-json`)를 태스크 전용 **git worktree**(`~/.orchebary/worktrees`, 브랜치 `orc/*`)에서 실행. 카드가 To Do → In Progress → In Review → Done으로 라이브 이동, 구조화 런 로그·diff 뷰·후속 프롬프트(`--resume`)·squash 머지·Open-in-terminal 제공. Jira 연동은 Phase 2(스키마는 준비됨).

## 개발

```bash
npm install            # postinstall이 Electron ABI 리빌드 + node-pty spawn-helper 권한 복구
npm run dev            # HMR 개발 모드
npm run typecheck
npm test               # vitest (트리 연산, NDJSON 파서, git 서비스, 정렬 등 90+ 테스트)
ORB_SMOKE=1 npx electron .   # 헤드리스 자가진단: PTY + OSC 133 셸 통합 왕복 검증
npm run build:mac      # 패키징 (.dmg/.zip)
```

## 아키텍처 요지

```
src/shared/    타입드 IPC 계약(ipc.ts) + 도메인 타입(domain.ts) — 3-타깃 공용, 동결 계약
src/main/      PTY(SessionManager, 5ms/64KB 배칭 + ack-크레딧 백프레셔), SQLite(better-sqlite3, WAL),
               agents/(GitService·WorktreeManager·ClaudeCodeAdapter·RunOrchestrator 상태머신)
src/preload/   contextBridge — 렌더러가 보는 유일한 표면(고정 채널 래퍼만, passthrough 없음)
src/renderer/  terminal/(TerminalRegistry가 xterm 인스턴스 소유·React 밖, BlockManager가 marker/decoration),
               layout/(이진 분할 트리), palette/(ActionRegistry), kanban/(dnd-kit + fractional-indexing)
resources/shell-integration/zsh/  ZDOTDIR shim — OSC 133/633/7 방출, 유저 dotfile 보존
```

핵심 규칙:

- 렌더러는 sandbox+contextIsolation. PTY/git/DB/에이전트는 전부 main.
- 고빈도 터미널 데이터는 zustand를 거치지 않음. xterm 인스턴스·marker는 레지스트리 소유.
- `marker.line`은 캐시 금지(reflow 시 변동). 셸 통합은 feature-detect(첫 `133;A`) — 실패 시 일반 터미널로 강등.
- 에이전트 완료 감지는 stream-json `result` 이벤트 + exit code(결정적). 실행 중인 태스크는 보드에서 이동 불가.
- 앱 종료 시 자식 전부 kill. 재시작 시 reconcile: 고아 run → `failed(orphaned)`, 유령 worktree prune.

## 트러블슈팅

- `NODE_MODULE_VERSION` 불일치 → `npm run postinstall` (Electron ABI 리빌드)
- `posix_spawnp failed` → node-pty `spawn-helper` 실행권한 유실. postinstall이 복구함.
- 셸 통합 비활성(블록 없음) → zsh가 아니거나 dotfile이 훅을 깨는 경우. 터미널은 일반 모드로 동작.
