import { AnimationMixer, Vector3 } from 'three/webgpu';

const STEP = 1 / 30;

// Spark detection
const SPARK_THRESHOLD = 15;
const SPARK_SMOOTHING = 0.3;
const SPARK_COOLDOWN = 3; // frames (~0.1s)

// Foot contact detection
const FOOT_MARGIN = 2.0;        // margin above ground-level for threshold
const FOOT_COOLDOWN = 10;       // ~0.33s at 30fps

/**
 * Precompute spark (wrist velocity) and foot contact events.
 *
 * Single mixer pass samples world positions for all tracked bones.
 * Spark: velocity threshold on wrist bones.
 * Foot:  samples all candidates per side, picks the bone with the largest
 *        Y range (handles both IK-driven and body-chain-driven VMDs).
 */
export function precomputeEffectEvents(mesh, clip, sparkBoneNames, footBoneGroups) {
  const duration = clip.duration;
  const N = Math.ceil(duration / STEP) + 1;

  // ── Build bone lookup ──
  const boneMap = new Map();
  for (const bone of mesh.skeleton.bones) boneMap.set(bone.name, bone);

  const sparkEntries = [];
  for (const name of sparkBoneNames) {
    const bone = boneMap.get(name);
    if (bone) sparkEntries.push({ name, bone });
  }

  // Flatten foot candidate groups for sampling
  const footCandEntries = [];
  const groupBounds = [];
  for (const group of footBoneGroups) {
    const start = footCandEntries.length;
    for (const name of group) {
      const bone = boneMap.get(name);
      if (bone) footCandEntries.push({ name, bone });
    }
    groupBounds.push({ start, count: footCandEntries.length - start });
  }

  // ── Single mixer pass: sample world positions for all bones ──
  const mixer = new AnimationMixer(mesh);
  const action = mixer.clipAction(clip);
  action.play();

  const tmp = new Vector3();
  const allEntries = [...sparkEntries, ...footCandEntries];
  const positions = allEntries.map(() => []);

  for (let f = 0; f < N; f++) {
    mixer.setTime(Math.min(f * STEP, duration));
    mesh.updateMatrixWorld(true);
    for (let i = 0; i < allEntries.length; i++) {
      allEntries[i].bone.getWorldPosition(tmp);
      positions[i].push({ x: tmp.x, y: tmp.y, z: tmp.z });
    }
  }

  // Cleanup
  action.stop();
  mixer.stopAllAction();
  if (mesh.skeleton) mesh.skeleton.pose();
  if (mesh.morphTargetInfluences) mesh.morphTargetInfluences.fill(0);
  mesh.position.set(0, 0, 0);
  mesh.rotation.set(0, 0, 0);

  // ── Detect spark events (velocity threshold) ──
  const sparkEvents = [];
  for (let i = 0; i < sparkEntries.length; i++) {
    const pos = positions[i];
    let sx = 0, sy = 0, sz = 0;
    let cd = 0;

    for (let f = 1; f < N; f++) {
      const rx = (pos[f].x - pos[f - 1].x) / STEP;
      const ry = (pos[f].y - pos[f - 1].y) / STEP;
      const rz = (pos[f].z - pos[f - 1].z) / STEP;

      sx += (rx - sx) * SPARK_SMOOTHING;
      sy += (ry - sy) * SPARK_SMOOTHING;
      sz += (rz - sz) * SPARK_SMOOTHING;

      const speed = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (cd > 0) { cd--; continue; }

      if (speed > SPARK_THRESHOLD) {
        cd = SPARK_COOLDOWN;
        sparkEvents.push({
          time: f * STEP,
          position: { x: pos[f].x, y: pos[f].y, z: pos[f].z },
          velocity: { x: sx, y: sy, z: sz },
          speed,
        });
      }
    }
  }
  sparkEvents.sort((a, b) => a.time - b.time);

  // ── Select best foot bone per group (largest Y range) & detect events ──
  const footEvents = [];
  const footOffset = sparkEntries.length;
  for (const { start, count } of groupBounds) {
    if (count === 0) continue;

    // Pick candidate with largest Y range
    let bestIdx = 0, bestRange = -1;
    for (let c = 0; c < count; c++) {
      const pos = positions[footOffset + start + c];
      let minY = Infinity, maxY = -Infinity;
      for (const p of pos) {
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      const range = maxY - minY;
      console.log(`[ripple]   ${footCandEntries[start + c].name} Y: ${minY.toFixed(2)}~${maxY.toFixed(2)} (range ${range.toFixed(2)})`);
      if (range > bestRange) { bestRange = range; bestIdx = c; }
    }

    const sel = start + bestIdx;
    console.log(`[ripple] → ${footCandEntries[sel].name}`);
    const pos = positions[footOffset + sel];

    // Adaptive ground level: 5th percentile Y
    const ys = pos.map(p => p.y).sort((a, b) => a - b);
    const groundY = ys[Math.floor(ys.length * 0.05)];
    const threshold = groundY + FOOT_MARGIN;

    let cd = 0;
    for (let f = 2; f < N; f++) {
      if (cd > 0) { cd--; continue; }

      const prevVy = pos[f - 1].y - pos[f - 2].y;
      const curVy = pos[f].y - pos[f - 1].y;
      const speed = Math.abs(prevVy / STEP);
      if (prevVy <= 0 && curVy >= 0 && pos[f - 1].y <= threshold && speed > 1.0) {
        cd = FOOT_COOLDOWN;
        footEvents.push({
          time: (f - 1) * STEP,
          position: { x: pos[f - 1].x, y: 0, z: pos[f - 1].z },
          speed,
        });
      }
    }
  }
  footEvents.sort((a, b) => a.time - b.time);

  console.log(`[precompute] ${sparkEvents.length} spark events, ${footEvents.length} foot events`);
  return { sparkEvents, footEvents };
}
