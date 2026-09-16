# MMD Anju — 프로젝트 맵

사람과 코딩 도구가 함께 사용하는 개발 문서의 진입점입니다.
작업 전 [개발 가이드라인](DEVELOPMENT.md)을 읽고, 변경한 구조와 규칙은 해당 문서에 함께 반영합니다.

## 문서

- [README.md](README.md): 기능, 실행 방법, 배포 절차
- [DEVELOPMENT.md](DEVELOPMENT.md): UI·아이콘 규칙, 개발·검증·배포 원칙
- [AGENTS.md](AGENTS.md): 코딩 에이전트를 위한 공통 진입점

## 코드 위치

| 작업 영역 | 파일 / 디렉터리 |
| --- | --- |
| 화면 구조, 스타일, 아이콘 폰트 | `index.html` |
| 환경 확인, 재생 불가 안내 | `js/bootstrap.js`, `js/startup.js` |
| 앱 초기화, 렌더 루프 | `js/main.js` |
| WebGPU 장면, 셰이더, 후처리 | `js/scene.js`, `js/shader.js`, `js/postprocess.js` |
| UI 조작 연결 | `js/ui.js` |
| 모델 로딩 | `js/loader.js` |
| 애니메이션, 오디오 | `js/animation.js`, `js/audio.js` |
| 본 이름·리타게팅·IK | `js/bone-remap.js`, `js/bone-retarget.js`, `js/ik-sizing.js` |
| PMX/VMD 검사, 인코딩 | `js/pmx-check.js`, `js/vmd-meta.js`, `js/vmd-validator.js`, `js/encoding.js` |
| 시각 효과 | `js/effects/` |
| 수정한 외부 모듈 | `vendor/` |
| 샘플과 공개 여부 메타데이터 | `samples/` |
| 시작 흐름 테스트 | `tests/startup.test.mjs` |
| 배포 파일 구성, 릴리스 노트 | `scripts/build_site.py`, `scripts/release_notes.py` |
| CI 검증, 태그 배포 | `.github/workflows/` |
| 로컬 분석 도구, 비공개 아카이브 | `tools/`, `data` 심볼릭 링크 |

## 기존 작업 메모

아래 목록은 기존 CLAUDE.md에서 보존한 후보 작업입니다. 완료 여부와 현재 필요성은 구현을 확인한 뒤 판단합니다.

## TODO

### Multi-model & Camera
- [ ] Multi-model support (multiple PMX slots for multi-character VMDs like Knife MIKU/RIN/LEN)
- [ ] Camera VMD playback with free/VMD camera toggle (OrbitControls ↔ VMD camera switch)

### VMD special types (non-playable → playable)
- [ ] `hands-facial` VMD: merge finger/hand bone tracks + morph tracks into main body motion
- [ ] `facial-only` VMD: overlay morph-only VMD on top of body motion (expression layer)
- [ ] `camera` VMD: sync camera keyframes with character motion playback
- [ ] `prop` VMD: accessory/stage motion (microphone stand, etc.) — load as separate mesh

### UX Improvements
- [ ] Keyboard shortcuts (Space=play/pause, M=mute, ←→=seek, ↑↓=volume)
- [ ] Timeline hit area expansion (hover: 4px→8px, touch: always 8px)
- [ ] Error feedback (show load failures in #loading-status)
- [ ] Current song info display (separate from select dropdowns)
- [ ] Prev/Next track buttons (⏮ ⏭)
- [ ] Focus-visible styles on all interactive elements
- [ ] Idle auto-hide controls (3s timeout, fade out)
- [ ] Song transition fade (audio crossfade 0.3s)
- [ ] Debug info toggle (D key, default visible for now)

## Related Resources

- **MMD archive:** `mmd-archive` in repo-paths.json
- **Learnings:** Obsidian `claude/learnings/projects/mmd-player-anju/`
- **Origin:** Migrated from `anju/web/mmd-player-anju`
