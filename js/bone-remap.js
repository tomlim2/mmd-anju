// Bone remapping: detect missing VMD bones and apply known aliases.

// Half-width ↔ full-width digit map
const HW = '0123456789';
const FW = '０１２３４５６７８９';

function toFullWidth(name) {
  let out = name;
  for (let i = 0; i < HW.length; i++) out = out.replaceAll(HW[i], FW[i]);
  return out;
}

function toHalfWidth(name) {
  let out = name;
  for (let i = 0; i < FW.length; i++) out = out.replaceAll(FW[i], HW[i]);
  return out;
}

// True aliases — same bone, different naming convention
const BONE_ALIASES = {
  // Extend as new alias patterns are discovered
};

// Bones whose rotation should merge into a fallback parent when missing
const ROTATION_FALLBACKS = {
  'グルーブ': 'センター',
};

// Bones safe to ignore when missing (cosmetic/optional)
const IGNORABLE_PREFIXES = [
  'スカート', 'j_f_', 'j_ago', 'n_sippo',
  'Glasses', '新規ボーン',
];
const IGNORABLE_SUFFIXES = ['指先'];

function isIgnorable(name) {
  for (const p of IGNORABLE_PREFIXES) { if (name.startsWith(p)) return true; }
  for (const s of IGNORABLE_SUFFIXES) { if (name.endsWith(s)) return true; }
  return false;
}

/**
 * Analyze and remap VMD clip bones against a PMX skeleton.
 * Modifies clip.tracks in-place for alias remaps.
 * Returns { remapped, dropped, ignored } for debug display.
 */
export function remapClipBones(clip, skeleton) {
  const boneNames = new Set(skeleton.bones.map(b => b.name));
  const remapped = [];
  const dropped = [];
  const ignored = [];

  // Collect unique bone names referenced by tracks
  const trackBones = new Set();
  for (const track of clip.tracks) {
    const m = track.name.match(/\.bones\[(.+?)\]\./);
    if (m) trackBones.add(m[1]);
  }

  for (const bone of trackBones) {
    if (boneNames.has(bone)) continue;

    // 1. Check explicit aliases
    let alias = BONE_ALIASES[bone];

    // 2. Try half/full-width digit conversion
    if (!alias || !boneNames.has(alias)) {
      const fw = toFullWidth(bone);
      const hw = toHalfWidth(bone);
      if (fw !== bone && boneNames.has(fw)) alias = fw;
      else if (hw !== bone && boneNames.has(hw)) alias = hw;
    }

    if (alias && boneNames.has(alias)) {
      // Rename tracks to the alias
      for (const track of clip.tracks) {
        if (track.name.includes(`.bones[${bone}].`)) {
          track.name = track.name.replace(`.bones[${bone}].`, `.bones[${alias}].`);
        }
      }
      remapped.push(`${bone} → ${alias}`);
    } else if (ROTATION_FALLBACKS[bone] && boneNames.has(ROTATION_FALLBACKS[bone])) {
      // Merge rotation into fallback parent
      const fallback = ROTATION_FALLBACKS[bone];
      _mergeRotationTracks(clip, bone, fallback);
      remapped.push(`${bone} → ${fallback} (merged)`);
    } else if (isIgnorable(bone)) {
      ignored.push(bone);
    } else {
      dropped.push(bone);
    }
  }

  // Log details
  if (remapped.length) console.info('[MMD] Bone remapped:', remapped.join(', '));
  if (dropped.length) console.info('[MMD] Bone missing:', dropped.join(', '));
  if (ignored.length) console.info('[MMD] Bone ignored:', ignored.join(', '));

  return { remapped, dropped, ignored, trackBones };
}

/**
 * Merge quaternion rotation tracks from srcBone into dstBone.
 * srcBone tracks are removed; dstBone quaternion is multiplied by srcBone quaternion.
 * Position tracks from srcBone are simply renamed to dstBone (additive).
 */
function _mergeRotationTracks(clip, srcBone, dstBone) {
  const srcQuat = `.bones[${srcBone}].quaternion`;
  const dstQuat = `.bones[${dstBone}].quaternion`;
  const srcPos = `.bones[${srcBone}].position`;
  const dstPos = `.bones[${dstBone}].position`;

  const srcQTrack = clip.tracks.find(t => t.name.endsWith(srcQuat));
  const dstQTrack = clip.tracks.find(t => t.name.endsWith(dstQuat));

  if (srcQTrack && dstQTrack) {
    // Both have quaternion tracks — multiply at each keyframe
    // Simple approach: resample src onto dst's times and multiply
    const dv = dstQTrack.values;
    const sv = srcQTrack.values;
    const dLen = dv.length / 4;
    const sLen = sv.length / 4;

    // If same keyframe count, multiply directly
    if (dLen === sLen) {
      for (let i = 0; i < dLen; i++) {
        const di = i * 4;
        // q_dst = q_src * q_dst (apply src rotation first)
        const ax = sv[di], ay = sv[di + 1], az = sv[di + 2], aw = sv[di + 3];
        const bx = dv[di], by = dv[di + 1], bz = dv[di + 2], bw = dv[di + 3];
        dv[di]     = aw * bx + ax * bw + ay * bz - az * by;
        dv[di + 1] = aw * by - ax * bz + ay * bw + az * bx;
        dv[di + 2] = aw * bz + ax * by - ay * bx + az * bw;
        dv[di + 3] = aw * bw - ax * bx - ay * by - az * bz;
      }
    } else {
      // Different keyframe counts — just rename src to dst (best effort)
      srcQTrack.name = srcQTrack.name.replace(srcQuat, dstQuat);
      return; // keep both tracks, Three.js will blend
    }

    // Remove src quaternion track
    clip.tracks = clip.tracks.filter(t => t !== srcQTrack);
  } else if (srcQTrack) {
    // Only src has quaternion — rename to dst
    srcQTrack.name = srcQTrack.name.replace(srcQuat, dstQuat);
  }

  // Handle position tracks — rename src to dst
  const srcPTrack = clip.tracks.find(t => t.name.endsWith(srcPos));
  if (srcPTrack) {
    const dstPTrack = clip.tracks.find(t => t.name.endsWith(dstPos));
    if (dstPTrack && srcPTrack.values.length === dstPTrack.values.length) {
      // Add src position to dst position
      for (let i = 0; i < dstPTrack.values.length; i++) {
        dstPTrack.values[i] += srcPTrack.values[i];
      }
      clip.tracks = clip.tracks.filter(t => t !== srcPTrack);
    } else {
      srcPTrack.name = srcPTrack.name.replace(srcPos, dstPos);
    }
  }
}
