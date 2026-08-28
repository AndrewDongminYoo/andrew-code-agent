<!-- markdownlint-disable MD013 MD024 -->

# Transcript: Oracle deliverable propagation rerun

Date: 2026-08-28

The prompts are byte-identical to the prompt blocks in `docs/notes/2026-08-26-v0.2-oracle-acceptance-transcripts.md`.
The hashes below identify the exact prompt bytes used in both arms.
The directions are the final assistant messages extracted from the parent session JSONL files.

## Task 1: bubble_shooter#43

- Target revision: `7d9dd4f932357c41b1e0bf228728575e4a6c179d`
- Prompt SHA-256: `29d4130e69f8301959bcfa073393a0112dcb822ab7e6bfcc06f8d56389b7f214`
- Control thread: `01a043b5-f5e0-7c32-a7de-aac5d727d239`
- Treatment thread: `01a043b9-bdb3-7ad1-94a5-70dafaa745c9`

### Control direction

```markdown
## 설계 방향

`GameSessionController`가 게임 바인딩마다 **현재 점수 읽기 콜백**도 보유하고, `detach`·다음 게임의 `attach` 인계 시점에 그 점수를 한 번 스냅샷해 최고 기록만 저장하도록 합니다.

현재 `GameView`는 종료마다 `detach`를 호출하지만, `abandonRun()`은 `continueOffer`·`rewardedShowing`에서만 동작해 Continue 후 다시 `playing`이 된 기록은 유실됩니다. 반면 화면은 `max(shooter.score, session.highScore)`를 Best로 표시합니다. [controller](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/lib/game/session/game_session_controller.dart:231) [view](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/lib/game/view/game_page.dart:272)

구체적으로는:

- `attach`에 `int Function() currentScore`를 추가하고, `GameView`는 `shooter.score`를 전달합니다.
- 컨트롤러에 “후보 점수가 `state.highScore`보다 클 때만 저장하고 즉시 state도 갱신”하는 단일 private helper를 둡니다.
- `abandonRun()`은 `playing`에서는 그 helper만 호출하고 phase, `completedRuns`, `run_end`, 광고 cadence는 건드리지 않습니다.
- Continue 제안·광고 표시 중 이탈은 기존처럼 `_finalizeRun(...allowInterstitial: false)`를 유지합니다.
- 새 바인딩이 기존 바인딩을 대체하는 경우에도, 콜백을 교체하기 전에 이전 게임의 점수를 기록합니다. 이는 `pushReplacement`에서 이전 페이지 dispose보다 새 페이지 attach가 먼저 일어날 수 있는 현재 토큰 모델을 보존합니다. [controller](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/lib/game/session/game_session_controller.dart:71)

이 선택은 새 UI나 게임 도메인 이벤트를 추가하지 않습니다. 현재 Continue는 점수를 보존한 채 `playing`으로 복귀하고, `run_end`는 최종화된 run만을 뜻합니다. [spec](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/docs/specs/2026-08-07-production-concept-design.md:72) [spec](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/docs/specs/2026-08-07-production-concept-design.md:177)

## 배제할 선택

- `GameView.dispose()`가 저장소를 직접 호출하는 방식은 배제합니다. 페이지의 수명·stale binding 경합을 이미 컨트롤러가 관리하므로, 최고 기록 정책까지 위젯으로 분산하면 인계 순서의 신뢰성이 약해집니다.
- playing 이탈을 가짜 `GameOverStats`로 최종화하는 방식은 배제합니다. `run_end`, 완료 run 수, interstitial cadence의 의미를 바꾸며 이 이슈의 analytics 비변경 제약을 위반합니다.
- 점수 변동마다 저장하거나 새 domain 이벤트를 발행하는 방식은 배제합니다. 불필요한 저장 빈도와 deterministic event surface 변경을 만들며, 필요한 것은 종료 경계의 스냅샷뿐입니다.
- `SettingsRepository`를 “무조건 max 저장” 계약으로 넓히는 것도 배제합니다. 컨트롤러가 이미 session high score의 소유자이며, 저장소는 순차 write와 재실행 읽기를 제공하므로 호출부의 단조성만 보장하면 됩니다. [repository](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/lib/game/session/shared_preferences_settings_repository.dart:65)

## 검증 방향

- 먼저 Continue 성공 → 점수 갱신 → 페이지 teardown(Back 경로)에서 현행 구현이 기록을 남기지 못하는 widget/controller 실패 테스트를 추가합니다.
- 수정 후에는 최고 기록 저장과 state 갱신, 낮은 점수 이탈의 무저장, `playing` 이탈이 `run_end`·`completedRuns`·phase를 바꾸지 않음을 검증합니다.
- 기존 rewarded callback 중복·stale callback·run number 인계 테스트를 유지하고, 이전 바인딩이 새 바인딩에 넘겨질 때도 이전 점수가 저장되는 케이스를 추가합니다.
- SharedPreferences 테스트는 기존 `_relaunch()`처럼 `SharedPreferences.resetStatic()` 후 새 저장소를 생성해, Continue 후 이탈로 기록한 값이 실제 store에서 다음 controller/새 게임 Best로 읽히는지 확인합니다. [persistence test](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/test/game/session/shared_preferences_settings_repository_test.dart:29)

예상 변경 범위는 controller·GameView와 해당 controller/widget/persistence 테스트이며, Flame 게임 규칙·analytics 정의·광고 정책·UI 구성은 변경하지 않습니다. 파일은 수정하지 않았습니다.
```

### Treatment direction

```markdown
파일 수정 없이 방향만 정리했습니다.

## 결정

`GameSessionController`가 게임 바인딩 시점에 **현재 점수를 읽는 콜백**을 함께 보유하고, `abandonRun()`이 이 점수를 먼저 최고점과 비교·저장하도록 바꿉니다.

- `GameView`는 `attach()`에 `() => shooter.score`를 전달합니다.
- `abandonRun()`은 phase 확인 전에 live score를 `state.highScore`와 비교합니다.
  더 높으면 저장 요청과 함께 `state.highScore`도 갱신합니다.
- 이후 기존처럼 `continueOffer`/`rewardedShowing`이면 `_finalizeRun()`으로 이어집니다.
  `playing`이면 여기서 끝냅니다.
- `detach()`는 현재 binding의 점수 콜백을 사용한 뒤 해제하고, 새 `attach()`가 기존 binding을 대체할 때에도 **교체 전 콜백**으로 먼저 보존해야 합니다.

이렇게 하면 Continue 직후 게임오버 당시의 `lastGameOver.score`가 아니라, 부활 뒤 실제로 늘어난 점수를 저장할 수 있습니다. 현재 `abandonRun()`은 `continueOffer`와 `rewardedShowing`에서만 동작하고, `playing`은 즉시 반환하는 것이 직접 원인입니다. [game_session_controller.dart](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/lib/game/session/game_session_controller.dart:231) 게임오버 오버레이의 `max(shooter.score, session.highScore)` 표시는 이미 더 높은 Best를 보여주므로 저장만 뒤처집니다. [game_page.dart](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/lib/game/view/game_page.dart:269)

`currentScore` 콜백은 선택값이 아니라 `attach()`의 필수 인자로 두는 편이 맞습니다. 새 binding이 점수 보존 없이 생성되는 일을 컴파일 단계에서 막고, 테스트의 직접 `attach()` 호출도 의도를 명시하게 합니다.

## 유지할 제약

- active-play 이탈을 `run_end`로 최종화하거나 `completedRuns`·interstitial cadence를 변경하지 않습니다. 이는 분석 이벤트 의미를 바꾸지 말라는 이슈 범위와, Continue된 게임은 Continue 결정 뒤 한 번만 최종화한다는 스펙을 지킵니다. [production concept](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/docs/specs/2026-08-07-production-concept-design.md:78)
- 최고점 판단은 controller에 둡니다. Widget에서 직접 저장하지 않고, Flame domain event에 점수를 추가하거나 매 샷마다 저장하지 않습니다. domain의 결정성과 서비스 무지를 보존하는 더 작은 변경입니다. [production concept](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/docs/specs/2026-08-07-production-concept-design.md:84)
- 낮은 점수는 저장 호출 자체를 하지 않습니다. 기존 controller의 “개선된 경우에만 저장” 규칙을 active-play 이탈에도 재사용하면 기존 기록을 덮어쓰지 않습니다. [game_session_controller.dart](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/lib/game/session/game_session_controller.dart:262)
- rewarded callback의 `runNumber`/phase 소유권 보호와 기존 중복-finalization guard는 건드리지 않습니다. [game_session_controller.dart](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/lib/game/session/game_session_controller.dart:188)

active play 중에는 별도 Home 버튼이 없고, 실제 결함 경로는 Back 또는 route teardown입니다. 다만 `GameView.dispose()`가 Home, Back, replacement를 모두 `detach()`로 모으므로 UI를 추가하거나 lifecycle 종료를 새로 처리할 필요는 없습니다. [game_page.dart](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/lib/game/view/game_page.dart:105)

## 기각

- `playing` 이탈도 run finalization으로 처리: `run_end`, 완료 횟수, 광고 cadence의 의미를 바꾸므로 기각합니다.
- UI의 `max()` 표시만 신뢰: 표시와 저장소의 불일치를 그대로 남기므로 기각합니다.
- 앱 lifecycle/OS 종료에 의존해 저장: 제어 가능한 Back/Home route보다 신뢰할 수 없고 이번 범위를 넓힙니다.
- repository의 일반 `saveHighScore()`를 광범위하게 단조 증가 API로 재설계: 현 단일 writer인 controller의 비교 규칙으로 해결 가능하며, 불필요하게 fake와 persistence 계약을 넓힙니다.

## 테스트 방향

먼저 현재 코드에서 실패하는 회귀 테스트를 추가합니다.

1. Controller: Continue 성공 → `playing` 복귀 → live score를 기존 최고점보다 높게 설정 → `abandonRun()`.
   저장값과 state의 high score는 새 점수여야 하지만, `run_end`, 완료 횟수, run number, Continue analytics는 변하지 않아야 합니다.
2. Controller: 같은 경로에서 live score가 더 낮으면 저장 호출 0회 및 기존 최고점 유지.
3. Widget: 실제 패배 → Continue 탭 → 부활 → 점수 상승 → navigator Back으로 page teardown.
   in-memory repository에 새 기록이 남는지 확인합니다.
4. Persistence: 실제 `SharedPreferencesSettingsRepository`와 위 controller 경로를 사용한 뒤 `SharedPreferences.resetStatic()`과 새 `load()`를 거쳐 새 repository에서 기록을 읽습니다.
   같은 instance의 `highScore`를 읽는 검증은 금지합니다.
   기존 `_relaunch()` helper가 이미 이 경계를 제공합니다. [shared_preferences_settings_repository_test.dart](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/test/game/session/shared_preferences_settings_repository_test.dart:29)
5. 기존 game-over, decline/restart, pending-ad abandonment, stale rewarded callback 테스트는 그대로 통과해야 합니다.

예상 변경 범위는 controller와 GameView, 그리고 controller/widget/SharedPreferences 테스트 세 파일입니다. 저장소 구현·localization·dependency 변경은 필요 없습니다.

Oracle 선례도 이 방향을 뒷받침합니다.

- `wiki/sources/claude--projects---volumes-dongminyu-development-01-personal-bubble-shooter--memory--meta-ui-open-decisions.md:30-36`: active-play 이탈의 최고점 보존은 finalization·cadence와 분리하고 live score를 controller에 전달하라는 선례입니다. 이 때문에 별도 active-play 저장 분기를 선택했습니다.
- `wiki/sources/claude--projects---volumes-dongminyu-development-01-personal-bubble-shooter--memory--shared-prefs-reload-is-vacuous.md:30-42`: static cache를 초기화하지 않은 reload는 실제 persisted write를 증명하지 못합니다. 이 때문에 fresh repository reload를 필수 테스트로 둡니다.
- `wiki/concepts/evidence-basis-discipline.md:44-56`: 새 테스트는 production 동작을 의도적으로 깨뜨렸을 때 실패 이유가 맞는지 확인해야 합니다. 이 때문에 구현 전 red test를 명시했습니다.
```

## Task 2: llm-wiki-dongminyu#9

- Target revision: `77d4bebced909b6863d1dfcac6cf9131bba91494`
- Prompt SHA-256: `907c3c815f537d42839f44e530f3c09b0b1c31ad5cd45248dbcb189fde60e6c8`
- Control thread: `01a043bf-bbd9-7272-a0a2-817a8331cd68`
- Treatment thread: `01a043c4-38c3-7f33-aa73-5a0018c8b565`

### Control direction

```markdown
## 결정

후보 2를 택합니다. 다만 이번 이슈에서는 설계만 확정하고, 실제 변경은 성능이 감당하기 어려워질 때 별도 PR로 합니다.

`assertSourceCommit`이 `ValidatedSourceCommit`이라는 opaque capability를 반환하게 하고, `readCommittedBlobs(capability, paths)`는 capability만 받아 읽습니다. capability에는 canonical repo root와 검증된 full commit ID를 모듈 내부에 묶어 두며, 호출자가 repo/commit을 다시 전달할 수 없게 합니다. TypeScript 타입만으로는 충분하지 않으므로, 런타임에서도 위조·다른 repo/commit과의 재조합을 거부해야 합니다.

`readCommittedBlob({ repoRoot, sourceCommit, path })`는 그대로 self-validating public API로 유지합니다. 내부적으로 capability를 만들고 단일 경로 batch API를 호출하면, 단일 읽기 신뢰 계약은 보존됩니다. 현재 이 함수가 repo top-level, 객체 형식/전체 ID, commit 객체를 확인한 뒤에만 blob을 읽는 것이 그 계약의 핵심입니다. [git-tree.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task2/artifact-kernel/src/git-tree.ts:63) [git-tree.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task2/artifact-kernel/src/git-tree.ts:109)

## 적용 경계와 거부할 선택

빌드와 전체 provenance 검증은 각각 자기 capability를 한 번 만들고, policy를 읽은 뒤 승인된 payload 목록을 한 번에 읽습니다. 즉 build/verify 사이에 proof를 공유하지 않습니다. 이로써 builder가 committed policy와 payload를 만들고, verifier가 그것을 독립적으로 다시 증명하는 현재 경계가 유지됩니다. [private-artifact.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task2/artifact-kernel/src/private-artifact.ts:34) [verify-private-artifact.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task2/artifact-kernel/src/verify-private-artifact.ts:123)

후보 1의 raw `readUncheckedBlob(repoRoot, commit, path)` 계열은 거부합니다. 검증 호출과 읽기 호출의 시간적 결합을 미래 호출자에게 맡기며, provenance 경계를 코드 리뷰로만 지켜야 하기 때문입니다. capability 기반 API에는 내부 구현용 helper가 있더라도 capability 없이는 호출할 수 있는 unchecked export가 없어야 합니다.

PR #10의 `readCommitTree`는 그대로 pipeline-local selection reader로 남겨야 합니다. 이는 후보 경로를 고르는 비신뢰 경계이고, 이후 kernel이 다시 hardened read를 수행한다는 현재 근거가 명확합니다. 이를 provenance reader로 승격하거나 kernel이 pipeline에 의존하게 만드는 것은 범위 확장입니다. [read-commit-tree.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task2/mcp-server/src/pipeline/read-commit-tree.ts:10)

v1에서는 capability API와 PR #10식 `git cat-file --batch` 프로세스 최적화를 묶지 않겠습니다. 먼저 문제의 세 검증 Git 호출을 payload마다 하지 않도록 하되, blob 읽기의 대규모 단일-buffer/streaming 계약은 별도 성능 작업으로 남깁니다. 이는 기존 16 MiB 단일 읽기 제한을 근거 없이 512 MiB tree-reader 수준으로 완화하지 않기 위함입니다. [git-tree.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task2/artifact-kernel/src/git-tree.ts:25)

## 구현 시 불변조건

- capability는 canonical root, full object ID, storage object format, commit type 검증을 모두 통과한 결과여야 합니다.
- 모든 path는 기존 traversal 차단·literal pathspec·regular-file-only 규칙을 그대로 적용하고, 결과는 입력 path 순서와 중복을 보존해야 합니다.
- `GIT_*` override 제거와 replace-object 비활성화도 batch 경로에 동일하게 적용해야 합니다.
- 기존 single-read 보안 회귀와 artifact의 integrity/provenance 분리 회귀를 유지하고, 새 batch API에는 빈 파일·큰 파일·symlink·경로 탈출·SHA-256 repo·위조 capability를 직접 검증하는 테스트를 추가해야 합니다.
- determinism gate는 실제로 build를 두 번 수행하므로, 동일 커밋에서 결과 digest가 동일함을 다시 확인해야 합니다. [check-determinism.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task2/mcp-server/src/pipeline/check-determinism.ts:27)

독립 설계 점검도 이 결론을 지지했고, 특히 “opaque”를 타입 표기만이 아니라 런타임에서도 repo/commit에 묶인 capability로 만들라는 제약을 반영했습니다. 파일 변경, 커밋, PR 생성은 하지 않았습니다.
```

### Treatment direction

```markdown
결정: **2번을 택합니다.** `assertSourceCommit`이 검증된 저장소 루트와 full commit OID를 담은 불투명·작업 범위 한정 handle을 반환하고, `readCommittedBlobs({ source, paths })`만 그 handle을 받아 일괄 읽어야 합니다.

`readCommittedBlob`은 그대로 둡니다. 단건 호출은 지금처럼 독립적으로 신뢰할 수 있어야 합니다. 반면 build와 full-provenance verify는 시작 시 한 번 handle을 만들고, committed policy와 payload 묶음을 그 handle로 읽습니다. handle 외에 `repoRoot`나 `sourceCommit`을 다시 받지 않아 검증 증명과 실제 읽기를 분리할 수 없게 해야 합니다.

1번(내부 unchecked reader 노출)은 거절합니다. 미래 호출자가 “빠른” 내부 함수를 신뢰 경계 밖에서 쓸 위험이 직접 생깁니다. 또한 raw 문자열을 받는 self-validating bulk API보다 handle API가 build/verify가 한 작업 안에서 동일한 검증 결과를 재사용한다는 의도를 더 분명히 드러냅니다.

현재 경계는 반드시 보존해야 합니다.

- canonical Git top-level, 저장소 hash format의 full OID, commit object 여부 검증: [git-tree.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task2/artifact-kernel/src/git-tree.ts:53)
- 경로 traversal·symlink 거부, literal path 처리, `GIT_*` override와 replace ref 차단: [git-tree.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task2/artifact-kernel/src/git-tree.ts:14), [git-tree-reader.test.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task2/artifact-kernel/test/git-tree-reader.test.ts:101)
- policy를 해당 commit에서 읽고, payload마다 authorization과 committed-byte 일치를 확인하는 provenance gate: [verify-private-artifact.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task2/artifact-kernel/src/verify-private-artifact.ts:123), [verify-artifact.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task2/mcp-server/src/pipeline/verify-artifact.ts:26)

검증은 기존 음성 사례를 batch에도 그대로 적용하고, 요청 순서·중복 cardinality·정규 파일만 허용하는 성질과 “build/verify 한 작업당 commit validation 한 번”을 별도로 증명해야 합니다. selection의 pipeline-local reader는 계속 예외로 남겨야 합니다. 그것은 artifact claim의 신뢰 경계가 아니며 hardened reader로 재확인됩니다. [read-commit-tree.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task2/mcp-server/src/pipeline/read-commit-tree.ts:10)

Oracle 선례도 이 방향을 뒷받침합니다: [source-verified-output.md](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task2/wiki/concepts/source-verified-output.md:28)는 검증되지 않은 값으로 fallback하지 말 것을, [evidence-basis-discipline.md](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task2/wiki/concepts/evidence-basis-discipline.md:35)는 실패 상태를 실제로 검출하는 음성 검증을 요구합니다. `home-git-root-hazard`의 핵심인 canonical root binding도 handle에 반영하되, 그 문서의 환경 예시는 stale입니다.

참고로 이 작업 디렉터리는 `77d4bebc`에 분리되어 있고, 저장소 `main`에는 이후 `3306523d perf(artifact): batch committed blob reads`가 있습니다. 새 작업을 시작한다면 먼저 그 변경이 이 이슈의 의도된 해결인지 확인해야 합니다.
```

## Task 3: bubble_shooter#38

- Target revision: `7d9dd4f932357c41b1e0bf228728575e4a6c179d`
- Prompt SHA-256: `675521ee8080e404f0eeff439c6a808eb3c8f6453a3948b51de8fd4619026d77`
- Control thread: `01a043c9-b8c8-7b43-8d31-dde10b5d467d`
- Treatment thread: `01a043cf-de53-7863-8aa3-834c4ba849b6`

### Control direction

````markdown
결정: UMP 다음에만 동작하는 프로젝트 소유 ATT 게이트를 둡니다. `app_tracking_transparency` 의존성은 추가하지 않고, iOS의 작은 `MethodChannel` 어댑터와 Dart 인터페이스/가짜 구현으로 `ATTrackingManager` 상태 조회와 요청을 감쌉니다.

조건은 다음으로 고정합니다.

```plaintext
UMP가 광고 요청 불가 → ATT 요청·AdMob 초기화 모두 하지 않음
UMP가 광고 요청 가능 + 실제 출시 구성에서 IDFA 기반 교차 앱/웹 추적 사용 → iOS ATT 상태 확인
  notDetermined → 한 번만 시스템 ATT 요청 후 결과를 기다림
  authorized → IDFA 허용 범위에서 광고 시작
  denied / restricted → IDFA 없이 허용되는 AdMob 광고만 시작
  요청 실패·미결정 유지 → 광고는 막고 게임은 계속 실행
추적을 사용하지 않는 구성 또는 비 iOS → ATT 없이 UMP 결과만으로 광고 시작
```

핵심은 `canRequestAds`만으로 ATT를 띄우지 않는 것입니다. UMP의 광고 가능 여부는 ATT가 필요한 “교차 앱/웹 추적” 여부와 동의어가 아닙니다. Apple은 사용자·기기 데이터를 다른 회사와 공유해 앱/웹 간 추적에 쓰는 경우 ATT를 요구합니다. [Apple ATT 문서](https://developer.apple.com/documentation/apptrackingtransparency) 따라서 실제 AdMob 구성에서 IDFA 기반 개인화·측정이 활성화된 빌드에만 ATT를 요청해야 합니다.

기존 `LoadingPage`의 비차단 흐름은 유지합니다. 현재도 UMP 완료 뒤에만 `AdsGateway.start()`를 호출하고, 동의 지연·실패가 타이틀 진입을 막지 않습니다. [loading_page.dart](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/lib/loading/view/loading_page.dart:23) 이를 `PrivacyGate` 하나로 바꿔 `UMP → ATT 상태/요청 → 광고 권한 결정 → AdsGateway` 순서를 직렬화합니다. ATT 응답 전에는 AdMob 초기화나 preload를 하지 않습니다. Google도 ATT 완료 뒤 광고를 로드하라고 권고합니다. [Google Mobile Ads iOS privacy guide](https://developers.google.com/ad-manager/mobile-ads-sdk/ios/privacy/strategies)

`ConsentGateway`는 UMP 경계로 유지하고, 별도 `TrackingAuthorizationGateway`를 추가합니다. Dart의 순수 `PrivacyGate`가 두 결과와 `TrackingDataUse` 구성으로 `noAds / adsWithoutIdfa / adsWithIdfa`를 산출합니다. `AdsGateway.start`는 이 최종 권한 없이는 호출되지 않게 합니다. AdMob 자체는 ATT 거부 시 IDFA를 광고 요청에 싣지 않으므로, 거부·제한은 게임도 광고의 허용 범위도 막지 않습니다. [Google Flutter IDFA guide](https://developers.google.com/admob/flutter/privacy/idfa)

Privacy Options도 같은 게이트를 다시 통과시켜야 합니다. 현재는 UMP Privacy Options 종료 뒤 `canRequestAds`만 보고 `start/stop`합니다. [game_page.dart](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/lib/game/view/game_page.dart:195) 이를 바꿔 UMP 철회면 즉시 `stop`, 재허용이면 현재 ATT 상태를 다시 평가해 IDFA 허용 여부에 맞춰 재개합니다. 이미 `denied`, `restricted`, `authorized`인 상태에서는 ATT를 다시 요청하지 않습니다.

거절할 선택은 세 가지입니다.

- UMP의 `canRequestAds == true`면 무조건 ATT를 띄우는 방식: 맥락 광고 허용과 교차 앱 추적 필요를 혼동합니다.
- UMP의 IDFA 메시지 자동 경로와 직접 ATT 호출을 함께 쓰는 방식: 프롬프트 소유권과 상태 전이가 이중화됩니다. 이 방향에서는 앱의 채널 게이트가 ATT를 단독 소유하고, AdMob 콘솔의 UMP IDFA 메시지는 활성화하지 않습니다.
- `bootstrap()`이나 첫 `GamePage`에서 요청하는 방식: 전자는 프레젠테이션 컨텍스트가 없고, 후자는 첫 Continue 광고 준비를 늦춥니다. 기존 `LoadingPage`가 맞는 소유자입니다.

테스트 seam은 이 인터페이스가 담당합니다. 자동 테스트는 최소한 UMP 거부, 추적 미사용, `notDetermined → authorized`, `notDetermined → denied`, `restricted`, 채널 오류, 이미 결정된 상태의 무재요청, Privacy Options 철회/재허용, 그리고 “광고 시작은 최종 결정 뒤” 호출 순서를 가짜 게이트로 검증해야 합니다. 실제 iOS 채널은 얇게 유지하고 기기 QA로 보완합니다.

사용 문구는 iOS 네이티브 리소스에 둡니다. ARB는 시스템 ATT 알림에 사용되지 않습니다. 영어 기본값은 `Info.plist`, 한국어는 기존 [InfoPlist.strings](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/ios/Runner/ko.lproj/InfoPlist.strings)에 넣습니다.

- EN: “Pebbix uses your device identifier to show personalized ads and measure ad performance across apps and websites.”
- KO: “페빅스는 앱과 웹사이트 전반에서 맞춤 광고를 제공하고 광고 성과를 측정하기 위해 기기 식별자를 사용합니다.”

이 문구와 `NSUserTrackingUsageDescription`은 실제로 그 추적 구성을 켤 때만 추가합니다. 현재 iOS는 Google의 샘플 AdMob 앱 ID와 테스트 광고 단위만 쓰며, 해당 usage description도 없습니다. [Info.plist](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/ios/Runner/Info.plist:32) [ad_unit_ids.dart](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task1/lib/game/session/ad_unit_ids.dart:10) 그러므로 실제 광고 계정·데이터 사용 결정 전에는 ATT를 미리 켜거나 App Store Privacy 신고를 확정하면 안 됩니다.

출시 전 기기 검증은 신규 설치 허용, 신규 설치 거부, 거부 후 재실행 시 무재프롬프트, UMP Privacy Options 철회/재허용, 그리고 iOS 설정에서의 추적 변경 후 재실행을 포함합니다. App Store Privacy는 최종 SDK/AdMob/Firebase 구성으로 다시 대조해야 합니다. Google Mobile Ads SDK가 IP 주소, 기기 ID, 광고·상호작용 데이터 등을 수집할 수 있으므로 추측으로 체크하면 안 됩니다. [Google SDK disclosure guide](https://developers.google.com/ad-manager/mobile-ads-sdk/ios/privacy/data-disclosure)

`#35`, `#37`의 본문은 GitHub 읽기 권한이 거절되어 확인하지 못했습니다. 따라서 그 둘이 확정해야 할 AdMob 실제 구성과 개인정보 범위는 이 방향의 명시적 선행 조건으로 남깁니다. 파일·커밋·PR은 변경하지 않았습니다.
````

### Treatment direction

```markdown
## 설계 방향

결정: **독자 ATT 플랫폼 채널이나 `app_tracking_transparency` 패키지는 추가하지 않고, UMP의 IDFA 메시지 경로가 ATT를 소유하도록 한다.** 현재 승인 스펙도 “UMP-driven consent flow; ATT requested conditionally through it”으로 고정돼 있고, UMP는 IDFA 메시지와 ATT 시스템 프롬프트를 연결한다. [Google UMP Flutter IDFA 안내](https://developers.google.com/admob/ios/privacy/idfa?authuser=19)

`LoadingPage → ConsentGateway.gather() → AdsGateway.start()`라는 현재 순서는 유지한다. UMP 폼과 그 안의 조건부 ATT가 완결된 뒤 `canRequestAds`를 다시 읽고, `true`일 때만 SDK 초기화·프리로드를 시작한다. `canRequestAds`는 “광고 요청 가능”이지 ATT 허용 자체는 아니다. ATT 거부·제한 상태에서도 UMP가 광고를 허용하면 IDFA 없이 광고 요청을 계속하는 것이 맞다. Google도 거부 후 광고 요청은 가능하며 IDFA만 전송되지 않는다고 명시한다. [Google 안내](https://developers.google.com/admob/ios/privacy/idfa?authuser=19)

| 운영 데이터 사용                | UMP/ATT 상태               | 결과                                                        |
| ------------------------------- | -------------------------- | ----------------------------------------------------------- |
| 교차 앱·웹 추적을 사용하지 않음 | UMP만 처리                 | ATT 없음, UMP가 허용한 광고 모드만 사용                     |
| IDFA 기반 추적 사용             | UMP 허용 + `notDetermined` | UMP IDFA 설명 후 시스템 ATT를 한 번 요청, 완료 뒤 광고 시작 |
| IDFA 기반 추적 사용             | ATT 허용                   | IDFA 사용 가능 범위의 광고 요청                             |
| IDFA 기반 추적 사용             | 거부·제한·요청 불가        | 게임은 즉시 계속, IDFA 없는 허용 광고만 요청                |
| UMP 거부·오류·미해결            | `canRequestAds == false`   | SDK 초기화·광고 요청 없음, 게임은 계속                      |

현재 모든 flavor가 Google 샘플 앱/광고 단위이고 실제 AdMob 데이터 사용 구성이 없으므로, **운영 구성 확정 전 기본값은 `nonTracking`**이어야 합니다. 실제 AdMob 계정에서 IDFA 메시지를 만들고, mediation 파트너까지 포함한 데이터 흐름이 Apple의 “tracking” 정의에 해당할 때만 `trackingWithIdfa`로 전환합니다. 이 전환은 원격 기능 토글이 아니라 출시 체크리스트와 스펙에 명시된 운영 정책이어야 합니다.

거절하는 선택은 세 가지입니다.

- 앱 시작 즉시 ATT 요청: UMP 설명·동의보다 앞서며 승인 스펙과 맞지 않습니다.
- UMP와 별도로 ATT를 직접 요청하는 새 채널/패키지: 중복 프롬프트와 두 상태 원천을 만들고, UMP 소유 경계를 깨뜨립니다.
- ATT 거부를 무광고 처리로 해석하는 것: 거부는 IDFA 사용 불가이지 게임이나 UMP가 허용한 비추적 광고의 금지는 아닙니다.

구현 시에는 `Info.plist`에 키를 추측으로 먼저 넣지 말고, 추적 구성을 실제로 켜는 변경과 함께 영어·한국어 `InfoPlist.strings`를 추가합니다. Flutter ARB가 아니라 iOS 네이티브 로컬라이제이션입니다. 문구의 권장 초안은 다음이며, 실제 광고 파트너와 공유 범위를 확인한 뒤 확정합니다.

- EN: “Your device identifier is used to provide personalized ads and measure their performance, and may be shared with advertising partners.”
- KO: “기기 식별자는 맞춤형 광고를 제공하고 광고 성과를 측정하는 데 사용되며, 광고 파트너와 공유될 수 있습니다.”

`NSUserTrackingUsageDescription`은 ATT 호출 시 필수이며, 누락하면 최초 요청에서 문제가 날 수 있습니다. [Apple 문서](https://developer.apple.com/documentation/bundleresources/information-property-list/nsusertrackingusagedescription) UMP IDFA 구성 시에는 기존 Swift Package Manager 방향을 유지한 채 `AppTrackingTransparency` 프레임워크 연결도 확인합니다. Pods는 복구하지 않습니다.

테스트는 기존 `UmpConsentGateway`의 주입 가능한 `ConsentInformation`·`ShowConsentForm`과 `AdMobAdsGateway`의 주입 seam을 확장해, 다음 전이를 자동 검증합니다: 미결정/오류 시 무광고, UMP 허용 후에만 시작, ATT 허용·거부·제한을 모사한 UMP 완료 뒤의 IDFA 가능/불가 광고 경로, Privacy Options 철회 시 즉시 `ads.stop()`, 재허용 시 한 번만 재개. 시스템 프롬프트 자체는 iOS가 소유하므로 Dart 단위 테스트가 “표시됨”을 증명한다고 가장하면 안 됩니다.

기기 QA는 신규 설치 허용·거부, 재실행의 무재표시, 시스템 추적 요청 제한, Settings의 Privacy Options 변경 뒤 광고 중지/재개를 각각 확인해야 합니다. ATT는 사용자가 앱을 삭제·재설치하지 않는 한 다시 표시되지 않습니다. [Apple ATT API](https://developer.apple.com/documentation/apptrackingtransparency/attrackingmanager/requesttrackingauthorization%28completionhandler%3A%29)

App Store Privacy 선언은 아직 확정할 수 없습니다. 실제 AdMob/mediation 구성과 SDK별 수집·공유 데이터를 목록화한 뒤, 광고 식별자·광고 데이터·사용 데이터의 수집/연결/추적 여부를 App Store Connect에 반영해야 합니다. Apple은 내장한 광고 SDK를 포함한 제3자 수집 관행까지 신고하도록 요구합니다. [Apple App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)

Oracle 선례도 이 방향을 확인합니다: `wiki/sources/claude--projects---volumes-dongminyu-development-01-personal-bubble-shooter--memory--att-not-implemented.md:31`의 UMP 기반 조건부 ATT 원칙과 `...google-mobile-ads-web-safe.md:39`의 주입형 패키지 seam 원칙을 유지합니다. 다만 UMP 9.0.0의 폼 완료 시점 선례는 현재 9.1.0에 대해 부분적으로만 검증됐으므로, 위 기기 QA에서 실제 완료 순서를 재확인해야 합니다.

파일 변경, 커밋, PR 생성은 하지 않았습니다.
```

## Task 4: andrew-code-agent#10

- Target revision: `d491d92524d4fbd60067cc5f5f85f432dd75be49`
- Prompt SHA-256: `f0f21d4e697ca663ec6187728dc9081fe1ef84089f75570cd935e840223ac4df`
- Control thread: `01a043d6-49c0-7b43-8ade-bccab10f72af`
- Treatment thread: `01a043d9-f156-7613-b462-6c77047e339c`

### Control direction

```markdown
## 설계 방향

명령 출력은 **전용 512 한도를 의도적으로 유지**합니다. 완료 메시지의 청크 경로는 적용하지 않고, 개행만 메시지 렌더링에서 구조적으로 처리합니다.

- 메시지는 `\n`을 이스케이프하기 전에 세그먼트 경계로 처리합니다. 각 세그먼트(빈 세그먼트 포함)는 별도 렌더링 줄이 되며, 긴 세그먼트만 기존 바이트 한도로 추가 청크합니다.
- `\r`, ESC/CSI/OSC, bidi 제어문자 등은 계속 [terminal.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task4/src/app-server/terminal.ts:1)의 기존 이스케이프로만 표현합니다. `\n`을 정규식에서 제외하는 방식은 거절합니다. 원본 줄 경계와 터미널 출력 줄 경계를 섞어 spoofing 표면을 다시 만들기 때문입니다.
- 다중 줄/청크 출력에는 기존처럼 최종 개수를 포함한 ordinal을 붙여, 같은 item id의 나중 줄이 이전 줄의 strict prefix가 되지 않게 합니다. 각 최종 줄은 `boundedTerminalText`의 escaped UTF-8 바이트 한도를 계속 만족해야 합니다.
- 현재 대용량 hostile 입력에서 완전한 escaped 복사본 생성을 피하는 제약이 있으므로, 구현은 거대한 `split()` 배열보다 한 번 순회하며 `\n`에서 flush하는 형태가 적절합니다.

명령 출력은 청크화하거나 상향하지 않습니다. [renderer.test.mjs](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task4/test/unit/renderer.test.mjs:278)도 이를 스트리밍 중 반복 렌더되는 값으로 취급합니다. 반면 완료 메시지는 완료 시 한 번 전체를 보여 주므로, 두 경로의 목적이 다릅니다.

- 리듀서는 현재 command output을 일반 필드와 같이 512 UTF-16 code units로 보관하면서 `[truncated]`를 붙입니다([reducer.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task4/src/app-server/reducer.ts:33)).
- 렌더러는 같은 출력을 512 escaped UTF-8 bytes의 줄에 다시 맞춥니다([renderer.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task4/src/app-server/renderer.ts:15)). 이 둘은 단위가 달라 단일 숫자를 억지로 공유하면 안 됩니다.
- 대신 작은 공유 정책 `COMMAND_OUTPUT_POLICY`를 한 곳에 두고 `retainedCodeUnits: 512`, `renderedLineBytes: 512`처럼 단위를 명시합니다. 리듀서와 렌더러가 각각 해당 필드를 읽게 하면, “전용 512 정책”이 명시되고 렌더러 단독 상향으로 실제 출력량이 늘지 않는 문제도 피합니다.

거절하는 선택은 두 가지입니다: 명령 출력을 메시지처럼 청크화하는 것(스트리밍 중 중복·잡음과 상태 보존 범위를 불필요하게 키움), 그리고 근거 없이 더 큰 전용 한도를 정하는 것(현재 리듀서 보존 한도와도 불일치).

테스트는 (1) `a\n\nb`가 실제 여러 줄로 렌더되고 `\\x0A`가 없음을, (2) CR/CSI/OSC/bidi가 계속 가시적으로 escape됨을, (3) 모든 줄의 escaped-byte 한도와 동일 id prefix-reprint 불변식을, (4) 리듀서 `outputDelta`를 실제 한도 초과로 누적한 뒤 렌더된 `Command output:` 줄이 truncation marker로 끝남을 확인해야 합니다.

파일은 수정하지 않았습니다.
```

### Treatment direction

````markdown
권고 방향은 다음입니다.

1. 메시지의 `\n`은 제어문자 패턴에서 빼지 않습니다. 대신 `messageLines`에서만 raw U+000A를 구분자로 처리해, 각 논리 줄을 별도 렌더 줄로 만듭니다. 각 줄은 신뢰된 `item id + lifecycle + [ordinal/total]` 헤더를 먼저 확보하고, 남은 바이트 예산 안에서 본문을 escape·truncate 합니다. `\r`, ESC/CSI, OSC 8, bidi 등은 계속 [terminal.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task4/src/app-server/terminal.ts:1)의 기존 경로로 가시적으로 escape합니다.

- `text.split("\n")`은 거절합니다. 현재는 hostile input을 전체 escape 문자열로 만들지 않도록 순회하며 끊으므로, 구분자 인지형 반복자로 구현해야 합니다. [renderer.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task4/src/app-server/renderer.ts:72)
- 줄 수 상한은 기존 byte-chunk 상한뿐 아니라, reducer가 보존하는 4096 code units가 모두 줄바꿈일 때의 4097개 논리 줄도 수용하도록 유도해야 합니다. 그 이상인 renderer 직접 입력은 마지막 줄에 marker를 붙이고 중단합니다.
- 모든 메시지 줄에 ordinal을 붙입니다. `reportTurnState`는 완전히 같은 문자열만 중복 제거하므로, 동일하거나 빈 세그먼트도 충돌하거나 이전 출력의 strict prefix가 되면 안 됩니다. [run.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task4/src/commands/run.ts:295)

2. 명령 출력은 메시지와 같은 chunked 처리로 올리지 않고, 현재처럼 한 줄짜리 preview로 유지합니다. 정책을 명시적으로 `COMMAND_OUTPUT_LIMITS` 한 곳에 두되, 서로 다른 단위를 숨기지 않습니다.

```plaintext
retainedCodeUnits: 512
renderedLineBytes: 512  # "Command output: " 접두사와 marker를 포함한 전체 줄
```

reducer와 renderer가 이 상수를 각각 읽게 하고, renderer는 명령 출력의 최종 조합 줄에 `renderedLineBytes`를 적용합니다. 초과분은 반드시 ` [truncated]`로 끝나게 테스트합니다. 현재 메시지는 4096 units를 보존하지만 command output은 일반 512-unit 필드를 사용하고, 델타마다 누적·재출력됩니다. [reducer.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task4/src/app-server/reducer.ts:33) [reducer.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task4/src/app-server/reducer.ts:640)

거절하는 선택은 다음입니다.

- `\n`을 전역 escape 예외로 만드는 것: 출력 writer가 추가하는 줄바꿈 외에 신뢰할 수 없는 줄 경계를 허용하게 됩니다. [run.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task4/src/commands/run.ts:356)
- command output을 메시지처럼 완료 시 chunking하는 것: 실행 중에는 output을 계속 렌더하고, 전체 문자열 기반 중복 제거를 쓰므로 재출력량이 커집니다. 또한 완료 이벤트의 `aggregatedOutput`이 없으면 output이 `null`이 될 수 있습니다. [renderer.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task4/src/app-server/renderer.ts:140) [reducer.ts](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task4/src/app-server/reducer.ts:360)
- 단순히 command output의 숫자만 키우는 것: 보존 cap과 terminal byte cap이 분리돼 있어, 출력량만 늘리고 완전한 로그를 보장하지 못합니다.

필요한 테스트는 메시지 `a\nb\nc`의 줄·ordinal·no-`\x0A`, 네 종류의 제어문자 escape, 전체 조합 줄의 512-byte bound, running→completed 전환에서 같은 item의 이전 줄이 이후 줄의 strict prefix가 아님을 확인하는 경우입니다. command output은 raw retention 초과와 escaped-byte 초과 모두 marker로 끝나는지 확인해야 합니다. 기존 테스트도 메시지 chunk의 고유성과 command streaming의 작은 bound를 이미 보호합니다. [renderer.test.mjs](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task4/test/unit/renderer.test.mjs:278)

이 방향은 dogfooding에서 확인된 두 증상—literal `\x0A`와 512-byte command-output truncation—을 각각 별개의 문제로 유지합니다. [dogfooding note](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task4/docs/notes/2026-08-24-dogfooding-second-run.md:160)

Oracle 선례: `wiki/entities/andrew-code-agent.md:42` 및 `.claude/projects/-Volumes-dongminyu-Development-01-personal-andrew-code-agent/memory/v0-2-oracle-acceptance-state.md:70-75`는 readability와 terminal escaping을 분리하라고 뒷받침했습니다. 따라서 newline은 구조적으로 나누고, escaping 경계는 그대로 유지합니다. 정확한 command-output 크기에 대한 선례는 `[no precedent found]`이며, 위 512 preview 정책은 현재 streaming 구조와 기존 테스트에 근거한 새 결정입니다.

파일 변경, 커밋, PR 생성은 하지 않았습니다.
````

## Task 5: flutter_receipt_scanner#3

- Target revision: `558bffa539c26104b72f75df6a3ccd5ceba7af56`
- Prompt SHA-256: `755dc7c0d322ccb287669acbae4a7ce715142138b365ad05aceea0db6945bbb2`
- Control thread: `01a043ec-6548-79c2-bef0-80009f75239e`
- Treatment thread: `01a043ef-9dff-7930-8828-837eb5ed47f9`

### Control direction

```markdown
결정: **정규화된 줄 배열의 완전 일치만 허용하고, 가장 깊은 overlap부터 검사하며, 서로 다른 정규화 줄이 최소 두 개여야 seam을 수용**하겠습니다.

현재 구현은 1–8줄 창을 Levenshtein 유사도로 비교해 접두부를 삭제하고, 단일 긴 줄도 허용합니다. [현재 구현](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task5-retry/flutter_receipt_scanner/lib/src/ocr_page_merger.dart:71) 이는 “불확실한 내용은 삭제하지 않는다”는 명세의 안전 원칙과 충돌합니다. [명세](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task5-retry/docs/specs/0001-long-receipt-ocr-merge/spec.md:165)

방향은 다음과 같습니다.

- 기존의 공백 축약·소문자화 정규화는 유지하되, 페이지별로 정규화된 줄 배열을 한 번 만든다.
- 각 인접 경계에서 `min(left.length, right.length)`부터 깊이를 2까지 내리며, 왼쪽 suffix와 오른쪽 prefix가 **동일한 개수의 줄로 한 줄씩 완전히 같은지** 확인한다.
- 일치 블록에 서로 다른 non-empty 정규화 줄이 둘 이상 있을 때만 첫 번째(가장 깊은) 후보를 수용하고, 그 깊이만큼 다음 페이지의 prefix를 제거한다.
- 후보가 없으면 모든 텍스트를 보존하고 `unmatchedBoundaryIndexes`에 기록한다. 따라서 `isComplete`는 “모든 경계가 이 보수적 textual seam 기준을 통과했다”는 뜻으로 문서화하며, 실제 촬영 overlap의 수학적 증명이라고 과장하지 않는다.

이에 따라 `_maxWindowLines`, Levenshtein, 유사도·문자 수 임계값, 길이비 prefilter, 512자 guard, `_Overlap` 및 tie-break는 모두 제거합니다. 최대 8줄 제한과 현행 “similarity 우선, 이후 더 큰 문자 수” 구현은 사라지므로, 명세의 상충된 네 단계 tie-break도 함께 제거됩니다. 현재 명세는 fuzzy 정책과 1–8줄 제한을 명시하고 있어 변경 대상입니다. [명세](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task5-retry/docs/specs/0001-long-receipt-ocr-merge/spec.md:115)

거절하는 선택은 다음입니다.

- **임계값만 높이는 방식**: 숫자만 다른 반복 구매와 OCR 오독을 유사도만으로 분리할 수 없으므로, 실제 행 삭제 위험을 해소하지 못합니다.
- **fuzzy matching 유지**: 현재 테스트도 fuzzy seam을 성공으로 고정하지만, 이 계약은 안전 우선 정책으로 명시적으로 폐기해야 합니다. [기존 테스트](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task5-retry/flutter_receipt_scanner/test/ocr_page_merger_test.dart:42)
- **단일 줄 exact seam 허용**: 충분히 긴 동일 상품 행도 반복 구매일 수 있습니다. 현재 긴 단일 줄 성공 테스트도 반대 기대값으로 바뀌어야 합니다. [기존 테스트](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task5-retry/flutter_receipt_scanner/test/ocr_page_merger_test.dart:80)
- **window cap만 확대**: 9줄 이상의 실제 overlap은 계속 잘릴 수 있으므로 근본 해결이 아닙니다.
- **새 public 설정이나 native/Pigeon 변경**: 이 merger는 app-facing Dart의 raw OCR 텍스트 처리이며, 현재 공개 진단 모델과 인접 경계 계약으로 충분합니다.

구현 전에는 이슈의 네 사례를 Dart 회귀 테스트로 먼저 추가해 현재 코드에서 실패시켜야 합니다. 추가로 8줄을 초과하는 exact overlap, fuzzy seam 보존·미완료 처리, 단일 줄 exact seam 보존, 동일한 두 줄 반복 블록 거부를 검증합니다. 기존의 “두 개의 동일한 반복 줄” 성공 테스트도 새 distinct-line 규칙에서는 거부되어야 합니다. [기존 테스트](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task5-retry/flutter_receipt_scanner/test/ocr_page_merger_test.dart:182)

제약은 명확합니다: 페이지는 최대 열 장이며, 이미지가 아니라 OCR 문자열만 다루고, 불확실한 seam은 진단 가능한 중복으로 남겨야 합니다. [명세](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task5-retry/docs/specs/0001-long-receipt-ocr-merge/spec.md:174) 깊이 우선 비교의 최악 복잡도는 증가하지만, 현 저장소의 10×200줄·100ms 벤치마크는 유지해 Dart에서 측정해야 합니다. RN 포트의 성능 수치는 이 저장소의 검증 근거로 전용하지 않습니다.
```

### Treatment direction

```markdown
## 결정

RN 포트와 같은 보수적 방향을 채택합니다. seam은 **정규화된 줄 배열의 정확한 일치**로만 증명합니다.

- 각 비어 있지 않은 줄은 현재처럼 trim·소문자화·연속 공백 축약으로 정규화하되, 줄들을 공백으로 합치지 않습니다.
- 두 인접 페이지의 suffix/prefix를 가능한 가장 깊은 같은 줄 수부터 검사합니다.
- 배열이 줄 단위로 완전히 같고, 그 영역에 **서로 다른 정규화 줄이 최소 2개** 있을 때만 seam으로 인정합니다.
- 첫 일치 깊이가 곧 선택 결과입니다. 다음 페이지에서 그 깊이만큼만 제거합니다.
- 증명하지 못하면 현재 계약대로 텍스트를 전부 보존하고 `unmatchedBoundaryIndexes`에 경계를 남기며 `isComplete: false`를 반환합니다.

이는 현재 구현이 8줄 cap, joined-window 비교, Levenshtein 유사도와 문자 수 tie-break를 실제 사용한다는 점과 충돌하지만, 저장소가 이미 선언한 “불확실한 seam의 텍스트는 삭제하지 않는다”는 계약에는 부합합니다. [현재 merger](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task5-retry/flutter_receipt_scanner/lib/src/ocr_page_merger.dart:71), [안전성 계약](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task5-retry/docs/specs/0001-long-receipt-ocr-merge/interview-ledger.md:72)

## 거절할 선택

- 유사도 floor를 높이거나 single-line 경우만 막는 방식은 거절합니다. 숫자 차이가 의미를 바꾸지만 edit distance에는 거의 반영되지 않아, 다중 줄 반복 구매도 같은 오탐을 냅니다.
- 8줄 상한과 “가장 높은 similarity” 선택도 거절합니다. 더 얕은 우연 일치가 실제 더 깊은 overlap을 이길 수 있습니다.
- 현재 spec의 문자 수·prefix/suffix 수 tie-break를 구현에 맞추는 것도 거절합니다. 깊이 우선의 정확 일치에서는 후보 ranking 자체가 불필요합니다.
- OCR 한 글자 차이를 이번 변경에서 다시 허용하는 digit-aware 비교도 범위 밖입니다. 실제 기기 데이터로 미증명 seam 비율을 확인한 뒤에만 별도 설계로 다룹니다.

의도적인 비용은 한 글자라도 다른 실제 overlap이 미확정으로 남는 것입니다. 그러나 그것은 가시적인 진단이고, 실제 영수증 행 삭제는 복구 불가능합니다.

## 구현 전 증명 기준

Dart 테스트에 네 재현을 먼저 추가해 현 구현에서 실패함을 확인한 뒤, 변경 후 통과시켜야 합니다.

1. 25자 이상인 동일 단일 행 반복 구매: 양쪽 행 보존, 미확정.
2. similarity 0.9200 단일 행 근사 반복 구매: 양쪽 행 보존, 미확정.
3. similarity 0.8974의 두 줄 근사 반복 구매: 두 행 보존, 미확정.
4. 9줄 overlap에서 얕은 `[A, B]`와 실제 9줄 overlap이 경쟁하는 경우: 9줄만 제거하고 11줄 출력.

기존의 fuzzy-overlap 승인, 긴 단일 행 exact 승인, 동일 행만 반복된 2줄 overlap 승인 테스트는 새 계약에 맞게 반전해야 합니다. 반대로 서로 다른 두 줄 이상의 exact overlap과 미확정 경계 보존 테스트는 유지합니다. 현재 테스트에는 fuzzy 및 단일 행 승인을 명시한 사례가 있습니다. [현재 unit tests](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task5-retry/flutter_receipt_scanner/test/ocr_page_merger_test.dart)

명세는 `spec.md`의 1–8줄/Levenshtein/문자 수/tie-break 요구를 “줄 배열 exact equality, 깊이 우선, 두 distinct 줄”로 교체해야 합니다. 512자 guard와 length-ratio prefilter, similarity 상수도 삭제합니다. 동일한 과거 표현이 남은 interview ledger·work item·다국어 release work item의 “similarity threshold” 문구도 superseded로 정리해야 합니다. [현재 spec](/Volumes/dongminyu/Development/01_personal/andrew-agent-oracle.nvhOA4/target-task5-retry/docs/specs/0001-long-receipt-ocr-merge/spec.md)

범위는 Dart의 순수 merger와 테스트·문서뿐입니다. public model, Pigeon, Swift/Kotlin transport는 바꾸지 않습니다. 10페이지·페이지당 200줄의 기존 100ms 검증은 유지하되, RN의 3ms 측정치를 Dart 성능 근거로 전이하지 않습니다.

Oracle 선례도 반영했습니다.

- 함수 본문과 조건 분기까지 읽어 문서 drift를 판단하라는 원칙이 있어, issue의 전이가 아니라 실제 merger·테스트·spec을 대조했습니다. 출처: `wiki/concepts/evidence-basis-discipline.md:35`, `:50`.
- RN과의 차이는 승인된 divergence일 수 있으므로, RN 구현을 그대로 권위로 삼지 않고 Dart에서 네 회귀를 먼저 재현하는 방향으로 제한했습니다. 출처: `wiki/sources/claude--projects---volumes-dongminyu-development-01-personal-flutter-receipt-scanner--memory--memory.md:24`.
- OCR seam의 false-positive 삭제 대 false-negative 진단 비대칭을 직접 다룬 Oracle 선례는 **[no precedent found]**입니다. 다만 현재 저장소의 명세·README·테스트가 이미 텍스트 보존을 명시하므로, 그것을 이 결정의 직접 근거로 삼았습니다.

파일은 수정하지 않았고 테스트도 실행하지 않았습니다.
```
