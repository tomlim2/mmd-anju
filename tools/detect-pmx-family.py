#!/usr/bin/env python3
"""Detect PMX model bone family (animasa, tda, yyb, tsumidango, diva, millishita).

Parses PMX bone names and matches against known bone signatures
to identify which model family the skeleton belongs to.

Usage: python3 detect-pmx-family.py <pmx_file> [--json]
       python3 detect-pmx-family.py <directory> [--json]  # scan all .pmx files
"""

import struct
import sys
import json
import os
from pathlib import Path


# --- Bone signature profiles ---
# Each profile has:
#   required: bones that MUST exist (all must match)
#   markers:  bones that are strong indicators (scored)
#   absent:   bones that must NOT exist (disqualifiers)

PROFILES = {
    'millishita': {
        'required': ['KOSHI', 'MUNE1', 'KATA_L', 'KATA_R'],
        'markers':  ['HIJI_L', 'HIJI_R', 'MOMO_L', 'MOMO_R', 'HIZA_L', 'HIZA_R',
                     'TE_L', 'TE_R', 'SAKOTSU_L', 'SAKOTSU_R', 'ATAMA'],
        'absent':   [],
    },
    'tda': {
        'required': ['センター', '上半身', '下半身'],
        'markers':  ['右ひじ補助', '+右ひじ補助', '左ひじ補助', '+左ひじ補助',
                     'アホ毛１', 'アホ毛２', '腕ベルト'],
        'absent':   ['眼鏡', 'あご', '舌0', 'KOSHI', '左腕S'],
    },
    'yyb': {
        'required': ['センター', '上半身', '下半身', '左ダミー', '右ダミー'],
        'markers':  ['眼鏡', 'あご', '左眉', '右眉', '舌0', '舌1', '上歯',
                     '左r', '右r'],
        'absent':   ['KOSHI', '右ひじ補助', '左腕S'],
    },
    'tsumidango': {
        'required': ['センター', '上半身', '下半身', '左腕S', '右腕S'],
        'markers':  ['左ひざD1', '左ひざD2', '左ひざDIK', '右ひざD1', '右ひざD2',
                     '左ひじIK', '右ひじIK', '左手首IK', '右手首IK'],
        'absent':   ['KOSHI'],
    },
    'diva': {
        'required': ['センター', '上半身', '下半身', '左ダミー', '右ダミー'],
        'markers':  ['上半身1', 'tongue_01', 'tongue_02', 'DownTeeth', 'UpTeeth'],
        'absent':   ['眼鏡', 'あご', '舌0', '右ひじ補助', 'KOSHI',
                     '左腕S', '左ひざD1'],
    },
    # animasa = catch-all for standard MMD bones without specific family markers.
    # Matches both classic (no groove) and modern (with groove/dummy) animasa models.
    'animasa': {
        'required': ['センター', '上半身', '下半身', '首', '頭'],
        'markers':  ['左足0', '右足0', 'ﾈｸﾀｲ１', 'ﾈｸﾀｲ２',
                     '左ｽｶｰﾄ前', '右ｽｶｰﾄ前'],
        'absent':   ['KOSHI'],
    },
}

# Evaluation order: most specific first, animasa last (catch-all)
EVAL_ORDER = ['millishita', 'tda', 'yyb', 'tsumidango', 'diva', 'animasa']


def read_text(f, encoding_flag):
    size = struct.unpack('<i', f.read(4))[0]
    if size <= 0:
        return ''
    raw = f.read(size)
    enc = 'utf-16-le' if encoding_flag == 0 else 'utf-8'
    return raw.decode(enc, errors='replace')


def read_index(f, index_size):
    if index_size == 1:
        return struct.unpack('<b', f.read(1))[0]
    elif index_size == 2:
        return struct.unpack('<h', f.read(2))[0]
    elif index_size == 4:
        return struct.unpack('<i', f.read(4))[0]
    return -1


def extract_bone_names(filepath):
    """Parse PMX and return (model_name, set of bone names)."""
    with open(filepath, 'rb') as f:
        magic = f.read(4)
        if magic != b'PMX ':
            raise ValueError(f'Not a PMX file: {magic}')

        version = struct.unpack('<f', f.read(4))[0]
        globals_count = struct.unpack('<b', f.read(1))[0]
        globals_data = f.read(globals_count)

        encoding_flag = globals_data[0]
        additional_vec4 = globals_data[1]
        vertex_index_size = globals_data[2]
        texture_index_size = globals_data[3]
        material_index_size = globals_data[4]
        bone_index_size = globals_data[5]

        name_jp = read_text(f, encoding_flag)
        name_en = read_text(f, encoding_flag)
        read_text(f, encoding_flag)  # comment jp
        read_text(f, encoding_flag)  # comment en

        # Skip vertices
        vertex_count = struct.unpack('<i', f.read(4))[0]
        for _ in range(vertex_count):
            f.read(12 + 12 + 8)  # pos + normal + uv
            f.read(16 * additional_vec4)
            wt = struct.unpack('<b', f.read(1))[0]
            if wt == 0:
                read_index(f, bone_index_size)
            elif wt == 1:
                read_index(f, bone_index_size)
                read_index(f, bone_index_size)
                f.read(4)
            elif wt == 2 or wt == 4:
                for _ in range(4):
                    read_index(f, bone_index_size)
                f.read(16)
            elif wt == 3:
                read_index(f, bone_index_size)
                read_index(f, bone_index_size)
                f.read(4 + 12 + 12 + 12)
            f.read(4)  # edge scale

        # Skip faces
        face_count = struct.unpack('<i', f.read(4))[0]
        for _ in range(face_count):
            read_index(f, vertex_index_size)

        # Skip textures
        tex_count = struct.unpack('<i', f.read(4))[0]
        for _ in range(tex_count):
            read_text(f, encoding_flag)

        # Skip materials
        mat_count = struct.unpack('<i', f.read(4))[0]
        for _ in range(mat_count):
            read_text(f, encoding_flag)
            read_text(f, encoding_flag)
            f.read(16 + 12 + 4 + 12 + 1 + 16 + 4)
            read_index(f, texture_index_size)
            read_index(f, texture_index_size)
            f.read(1)
            toon_flag = struct.unpack('<b', f.read(1))[0]
            if toon_flag == 0:
                read_index(f, texture_index_size)
            else:
                f.read(1)
            read_text(f, encoding_flag)
            f.read(4)

        # Parse bone names
        bone_count = struct.unpack('<i', f.read(4))[0]
        bone_names = set()
        for i in range(bone_count):
            bn = read_text(f, encoding_flag)
            read_text(f, encoding_flag)  # en
            bone_names.add(bn)

            f.read(12)  # position
            read_index(f, bone_index_size)  # parent
            f.read(4)  # transform class
            flag = struct.unpack('<H', f.read(2))[0]

            if flag & 0x0001:
                read_index(f, bone_index_size)
            else:
                f.read(12)
            if flag & 0x0100 or flag & 0x0200:
                read_index(f, bone_index_size)
                f.read(4)
            if flag & 0x0400:
                f.read(12)
            if flag & 0x0800:
                f.read(24)
            if flag & 0x2000:
                f.read(4)
            if flag & 0x0020:
                read_index(f, bone_index_size)
                f.read(4 + 4)
                link_count = struct.unpack('<i', f.read(4))[0]
                for _ in range(link_count):
                    read_index(f, bone_index_size)
                    has_limit = struct.unpack('<b', f.read(1))[0]
                    if has_limit:
                        f.read(24)

        return name_jp, bone_names, bone_count


def detect_family(bone_names):
    """Match bone names against profiles, return (family, confidence, details)."""
    results = []

    for family in EVAL_ORDER:
        profile = PROFILES[family]

        # Check required bones
        required_match = all(b in bone_names for b in profile['required'])
        if not required_match:
            continue

        # Check absent bones (disqualifiers)
        has_absent = [b for b in profile['absent'] if b in bone_names]
        if has_absent:
            continue

        # Score markers
        marker_hits = [b for b in profile['markers'] if b in bone_names]
        marker_total = len(profile['markers'])
        marker_score = len(marker_hits) / marker_total if marker_total > 0 else 1.0

        # Non-catchall profiles need at least one marker hit
        if family != 'animasa' and marker_total > 0 and len(marker_hits) == 0:
            continue

        confidence = round(marker_score * 100)

        results.append({
            'family': family,
            'confidence': confidence,
            'required_matched': profile['required'],
            'markers_matched': marker_hits,
            'markers_missed': [b for b in profile['markers'] if b not in bone_names],
        })

    if not results:
        return 'unknown', 0, {}

    best = max(results, key=lambda r: r['confidence'])
    return best['family'], best['confidence'], best


def detect_file(filepath, output_json=False):
    """Detect family for a single PMX file."""
    try:
        model_name, bone_names, bone_count = extract_bone_names(filepath)
    except Exception as e:
        return {'file': str(filepath), 'error': str(e)}

    family, confidence, details = detect_family(bone_names)

    result = {
        'file': str(filepath),
        'model': model_name,
        'bones': bone_count,
        'family': family,
        'confidence': confidence,
    }
    if details:
        result['markers_matched'] = details.get('markers_matched', [])
        result['markers_missed'] = details.get('markers_missed', [])

    if not output_json:
        tag = f'[{family}]' if family != 'unknown' else '[???]'
        print(f'{tag:14s} {confidence:3d}%  {model_name}  ({bone_count} bones)  {filepath}')
        if details.get('markers_matched'):
            print(f'               matched: {", ".join(details["markers_matched"])}')
        if details.get('markers_missed'):
            print(f'               missed:  {", ".join(details["markers_missed"])}')

    return result


def main():
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <pmx_file_or_dir> [--json]')
        sys.exit(1)

    target = sys.argv[1]
    output_json = '--json' in sys.argv

    results = []

    if os.path.isdir(target):
        for root, dirs, files in os.walk(target):
            for f in sorted(files):
                if f.lower().endswith('.pmx'):
                    r = detect_file(os.path.join(root, f), output_json)
                    results.append(r)
    else:
        r = detect_file(target, output_json)
        results.append(r)

    if output_json:
        print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
