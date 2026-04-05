---
project: mmd-anju
topic: physics-jitter
started: 2026-04-05
baseline-commit: 98af4ce
---

# Experiments: mmd-anju / physics-jitter

## Goal
피직스 본(옷/머리카락) 떨림(jitter) 제거. 정지/저속 상태에서 부들부들 떨리는 현상 해결.

## Baseline
- 타임스텝: 1/65 (~0.0154s)
- maxStepNum: 3
- 슬리핑 임계값: (0, 0) — 비활성화
- additionalDamping: 미사용
- 스프링 댐핑: 0.475 고정
- 솔버 반복: 기본값 (10)
- **증상**: 정지 상태에서 옷 본이 지속적으로 미세 진동

---

## EXP-001: 슬리핑 임계값 복원

- **Status**: `failed`
- **Hypothesis**: If setSleepingThresholds를 (0,0)→(0.3, 0.5)로 변경하면, 정지 상태의 미세 진동이 사라진다.
- **Fail threshold**: 떨림 변화 없음 또는 물리 본이 멈춘 채 안 깨어남 → abandon

### Params
| File | Change | Before | After |
|------|--------|--------|-------|
| vendor/MMDPhysics.js:954 | setSleepingThresholds | (0, 0) | (0.3, 0.5) |

### Metrics
| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| 정지 시 옷 떨림 | 있음 | 있음 | 변화 없음 |
| 동작 후 물리 반응 | 정상 | — | — |

### Conclusion
슬리핑 임계값만으로는 부족. 떨림이 임계값 이상의 에너지로 발생 중이거나, 스프링이 계속 깨우는 것으로 추정.

### Next
→ EXP-002: 타임스텝 1/120 + maxStepNum 4

---

## EXP-002: 타임스텝 축소 (1/65 → 1/120)

- **Status**: `failed`
- **Hypothesis**: If unitStep을 1/65→1/120으로 줄이고 maxStepNum을 4로 올리면, 시뮬레이션 안정성이 높아져 떨림이 감소한다.
- **Fail threshold**: 떨림 변화 없음 또는 눈에 띄는 퍼포먼스 저하 → abandon

### Params
| File | Change | Before | After |
|------|--------|--------|-------|
| vendor/MMDPhysics.js:58 | unitStep | 1/65 | 1/120 |
| vendor/MMDPhysics.js:59 | maxStepNum | 3 | 4 |

### Metrics
| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| 정지 시 옷 떨림 | 있음 | 있음 | 변화 없음 |

### Conclusion
타임스텝 축소만으로는 부족. 진동 에너지 자체를 소산시키는 메커니즘이 필요.

### Next
→ EXP-003: additionalDamping 활성화

---

## EXP-003: additionalDamping 활성화

- **Status**: `failed`
- **Hypothesis**: If btRigidBodyConstructionInfo에 additionalDamping=true를 설정하면, Bullet 내장 미세진동 억제가 작동하여 옷 떨림이 사라진다. (babylon-mmd에서 검증된 방법)
- **Fail threshold**: 떨림 변화 없음 → abandon

### Conclusion
변화 없음. EXP-004(물리 OFF)에서 VMD 재생 시에도 옷 떨림 확인 → 물리 파라미터가 원인이 아님.

---

## EXP-004: 물리 OFF 원인 분리

- **Status**: `succeeded` (진단용)
- **Hypothesis**: 물리를 끄면 떨림이 사라지는지 확인
- **Result**: 물리 OFF + VMD 재생 시에도 옷 본 떨림 발생. T포즈는 정상.
- **Conclusion**: 원인은 물리가 아니라 VMD 키프레임이 옷 본을 직접 움직이고 있음. 물리 ON 시 VMD와 물리가 같은 본을 동시에 제어하여 충돌.

---

## EXP-005: 물리 본 VMD 트랙 제거

- **Status**: `failed`
- **Hypothesis**: If 물리 본(type 1,2)에 해당하는 VMD 트랙을 AnimationClip에서 제거하면, 물리만 옷 본을 제어하게 되어 떨림이 사라진다.

### Conclusion
트랙 제거 시 옷이 과하게 움직임. VMD 키프레임이 물리 본에 안정화/제약 역할을 하고 있었음. type 1만 제거해도 동일. 전부 원복.

---

## EXP-006: babylon-mmd 마이그레이션

- **Status**: `succeeded`
- **Hypothesis**: babylon-mmd는 올바른 MMD 파이프라인(물리 본 VMD 키프레임 무시 + 2패스 본 평가 + Havok 물리)을 구현하므로, 치마 떨림이 사라진다.
- **Fail threshold**: 떨림 동일 → 근본 원인이 다른 곳

### Params
| File | Change | Before | After |
|------|--------|--------|-------|
| 전체 렌더링 스택 | Three.js → Babylon.js + babylon-mmd | Three.js MMDAnimationHelper + ammo.js | MmdRuntime + MmdPhysics (Havok) |

### Metrics
| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| 옷/치마 떨림 | 있음 (모든 모델, 모든 VMD) | **없음** | 해결 |

### Conclusion
**근본 해결.** Three.js MMDAnimationHelper의 구조적 문제였음:
1. VMD 키프레임을 모든 본(물리 본 포함)에 적용 후 물리가 덮어쓰는 방식 → 매 프레임 충돌
2. VMD 베지어 보간 버그 (Three.js #22282, NOT_PLANNED)
3. save/restore bones 사이클에서 물리 본 상태 오염

babylon-mmd는 원본 MMD와 동일한 파이프라인:
- beforePhysics: 애니메이션 → IK → Append Transform (물리 본 VMD 무시)
- Physics step (Havok WASM)
- afterPhysics: 물리 결과 → 본 반영

---

## Dead Ends
- EXP-001: sleepingThresholds → 효과 없음
- EXP-002: 타임스텝 축소 → 효과 없음
- EXP-003: additionalDamping → 효과 없음
- EXP-005: 물리 본 VMD 트랙 제거 → 과도한 움직임 유발 (VMD가 앵커 역할)

## Key Findings
1. Three.js MMDAnimationHelper는 물리 본에도 VMD 키프레임을 적용하는 구조적 결함이 있음
2. 물리 파라미터 튜닝(댐핑, 타임스텝, 슬리핑)으로는 해결 불가 — 파이프라인 자체가 원인
3. babylon-mmd 마이그레이션으로 근본 해결 확인 (2026-04-05)
4. 마이그레이션 브랜치: `feat/babylon-mmd`, Phase 1(코어) 완료
