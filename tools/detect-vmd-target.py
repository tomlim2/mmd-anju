#!/usr/bin/env python3
"""Detect VMD motion target model family and extract metadata.

Reads VMD bone/morph names and header model name to identify
which model family the motion was authored for.

Usage: python3 detect-vmd-target.py <vmd_file> [--json]
       python3 detect-vmd-target.py <directory> [--json]  # scan all .vmd files
"""

import struct
import sys
import json
import os
from collections import defaultdict


# --- VMD bone signatures per family ---
# VMDs only contain bones that have keyframes, so signatures are
# based on commonly animated bones unique to each family.

PROFILES = {
    'millishita': {
        'required': ['KOSHI'],
        'markers':  ['MUNE1', 'MUNE2', 'KATA_L', 'KATA_R', 'HIJI_L', 'HIJI_R',
                     'MOMO_L', 'MOMO_R', 'HIZA_L', 'HIZA_R', 'TE_L', 'TE_R',
                     'ATAMA', 'KUBI'],
        'absent':   ['センター'],
    },
    'camera': {
        # Camera VMDs have no bone keyframes, only camera keyframes
        # Handled separately in detect logic
        'required': [],
        'markers':  [],
        'absent':   [],
    },
}

# Standard MMD bones shared across animasa/tda/yyb/tsumidango/diva.
# We distinguish by secondary signals.
STANDARD_BONES = {
    'core':  ['センター', '上半身', '下半身', '首', '頭'],
    'arms':  ['左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首'],
    'legs':  ['左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首'],
    'ik':    ['左足ＩＫ', '右足ＩＫ', '左つま先ＩＫ', '右つま先ＩＫ'],
    'extra': ['グルーブ', '全ての親', '左肩', '右肩', '両目', '腰'],
}

# Bones that hint at the VMD's intended target within standard models
STANDARD_HINTS = {
    'tda':        ['右ひじ補助', '+右ひじ補助', '左ひじ補助', '+左ひじ補助'],
    'yyb':        ['眼鏡', 'あご', '左眉', '右眉', '舌0', '舌1'],
    'tsumidango': ['左腕S', '右腕S', '左ひざD1', '右ひざD1'],
    'diva':       ['上半身1', 'tongue_01', 'DownTeeth'],
}

# Known VMD header model names → family mapping
MODEL_NAME_HINTS = {
    '初音ミク': 'animasa',
    '初音ミクVer2': 'animasa',
    'miku': 'animasa',
    'Miku': 'animasa',
    'MEIKO': 'animasa',
    'リン': 'animasa',
    'レン': 'animasa',
    'ルカ': 'animasa',
    'カイト': 'animasa',
    'Tda式初音ミク': 'tda',
    'Tda式': 'tda',
    'TDA': 'tda',
    'YYB式初音ミク': 'yyb',
    'YYB': 'yyb',
    'つみ式': 'tsumidango',
}


def parse_vmd_meta(filepath):
    """Parse VMD and return metadata for detection."""
    with open(filepath, 'rb') as f:
        magic = f.read(30)
        if b'Vocaloid Motion Data' not in magic:
            raise ValueError('Not a VMD file')

        model_name_raw = f.read(20)
        try:
            model_name = model_name_raw.split(b'\x00')[0].decode('shift_jis')
        except:
            model_name = model_name_raw.split(b'\x00')[0].decode('utf-8', errors='replace')

        # Bone keyframes
        bone_kf_count = struct.unpack('<I', f.read(4))[0]
        bone_names = set()
        bone_kf_per_bone = defaultdict(int)
        max_frame = 0

        for _ in range(bone_kf_count):
            name_raw = f.read(15)
            try:
                name = name_raw.split(b'\x00')[0].decode('shift_jis')
            except:
                name = name_raw.split(b'\x00')[0].decode('utf-8', errors='replace')

            frame = struct.unpack('<I', f.read(4))[0]
            f.read(12 + 16 + 64)  # pos + rot + interp

            bone_names.add(name)
            bone_kf_per_bone[name] += 1
            if frame > max_frame:
                max_frame = frame

        # Morph keyframes
        morph_kf_count = struct.unpack('<I', f.read(4))[0]
        morph_names = set()

        for _ in range(morph_kf_count):
            name_raw = f.read(15)
            try:
                name = name_raw.split(b'\x00')[0].decode('shift_jis')
            except:
                name = name_raw.split(b'\x00')[0].decode('utf-8', errors='replace')

            frame = struct.unpack('<I', f.read(4))[0]
            f.read(4)  # weight

            morph_names.add(name)
            if frame > max_frame:
                max_frame = frame

        # Camera keyframes
        camera_kf_count = 0
        if f.tell() + 4 <= os.path.getsize(filepath):
            camera_kf_count = struct.unpack('<I', f.read(4))[0]
            for _ in range(camera_kf_count):
                frame = struct.unpack('<I', f.read(4))[0]
                f.read(57)  # rest of camera keyframe
                if frame > max_frame:
                    max_frame = frame

        return {
            'model_name': model_name,
            'bone_names': bone_names,
            'bone_kf_count': bone_kf_count,
            'bone_kf_per_bone': dict(bone_kf_per_bone),
            'morph_names': morph_names,
            'morph_kf_count': morph_kf_count,
            'camera_kf_count': camera_kf_count,
            'max_frame': max_frame,
            'duration_sec': round(max_frame / 30, 1),
        }


def detect_target(meta):
    """Detect target model family from VMD metadata."""
    bone_names = meta['bone_names']
    model_name = meta['model_name']

    # Camera-only VMD
    if meta['bone_kf_count'] == 0 and meta['camera_kf_count'] > 0:
        return 'camera', 100, 'camera-only VMD'

    # Millishita (romaji bones)
    profile = PROFILES['millishita']
    if all(b in bone_names for b in profile['required']):
        hits = [b for b in profile['markers'] if b in bone_names]
        return 'millishita', round(len(hits) / len(profile['markers']) * 100), \
               f'romaji bones ({len(hits)}/{len(profile["markers"])} markers)'

    # Standard MMD — check how many core bones match
    core_hits = sum(1 for b in STANDARD_BONES['core'] if b in bone_names)
    if core_hits < 3:
        # Might be a facial-only or partial VMD
        if meta['morph_kf_count'] > 0 and meta['bone_kf_count'] == 0:
            return 'facial-only', 80, 'morph keyframes only'
        if len(bone_names) < 5:
            return 'partial', 50, f'only {len(bone_names)} bones'

    # Check for family-specific hints in bone names
    hint_scores = {}
    for family, hint_bones in STANDARD_HINTS.items():
        hits = [b for b in hint_bones if b in bone_names]
        if hits:
            hint_scores[family] = (len(hits), hits)

    if hint_scores:
        best_family = max(hint_scores, key=lambda k: hint_scores[k][0])
        count, hits = hint_scores[best_family]
        return best_family, round(count / len(STANDARD_HINTS[best_family]) * 100), \
               f'hint bones: {", ".join(hits)}'

    # Check header model name
    for pattern, family in MODEL_NAME_HINTS.items():
        if pattern in model_name:
            return family, 60, f'header model name: {model_name}'

    # Fallback: standard MMD bones present → likely animasa-compatible
    if core_hits >= 3:
        extra_hits = sum(1 for b in STANDARD_BONES['extra'] if b in bone_names)
        has_groove = 'グルーブ' in bone_names
        if has_groove:
            return 'standard-extended', 40, 'has groove bone, no family-specific hints'
        return 'standard', 40, 'basic MMD bones, no family-specific hints'

    return 'unknown', 0, 'no matching pattern'


def detect_file(filepath, output_json=False):
    """Detect target for a single VMD file."""
    try:
        meta = parse_vmd_meta(filepath)
    except Exception as e:
        result = {'file': str(filepath), 'error': str(e)}
        if not output_json:
            print(f'[ERROR]  {filepath}: {e}')
        return result

    family, confidence, reason = detect_target(meta)

    result = {
        'file': str(filepath),
        'model_name': meta['model_name'],
        'target': family,
        'confidence': confidence,
        'reason': reason,
        'bone_count': len(meta['bone_names']),
        'bone_kf_count': meta['bone_kf_count'],
        'morph_kf_count': meta['morph_kf_count'],
        'camera_kf_count': meta['camera_kf_count'],
        'duration_sec': meta['duration_sec'],
        'max_frame': meta['max_frame'],
    }

    if not output_json:
        tag = f'[{family}]'
        dur = f'{meta["duration_sec"]}s'
        print(f'{tag:20s} {confidence:3d}%  model="{meta["model_name"]}"  '
              f'{len(meta["bone_names"])} bones  {meta["bone_kf_count"]} kf  '
              f'{meta["morph_kf_count"]} morphs  {meta["camera_kf_count"]} cam  '
              f'{dur:>7s}  {filepath}')
        print(f'                     reason: {reason}')
        if meta['bone_names'] and len(meta['bone_names']) <= 50:
            sorted_bones = sorted(meta['bone_names'],
                                  key=lambda b: -meta['bone_kf_per_bone'].get(b, 0))
            top = sorted_bones[:15]
            print(f'                     top bones: {", ".join(top)}')

    return result


def main():
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <vmd_file_or_dir> [--json]')
        sys.exit(1)

    target = sys.argv[1]
    output_json = '--json' in sys.argv

    results = []

    if os.path.isdir(target):
        for root, dirs, files in os.walk(target):
            for f in sorted(files):
                if f.lower().endswith('.vmd'):
                    r = detect_file(os.path.join(root, f), output_json)
                    results.append(r)
    else:
        r = detect_file(target, output_json)
        results.append(r)

    if output_json:
        print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
