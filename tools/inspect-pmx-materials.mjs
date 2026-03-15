#!/usr/bin/env node
/**
 * inspect-pmx-materials.mjs
 *
 * Parses a PMX file and prints detailed material information,
 * focusing on diffuse textures, sphere textures, and sphere modes.
 *
 * Usage: node inspect-pmx-materials.mjs <path-to-pmx>
 */

import { readFileSync } from 'fs';
import { basename } from 'path';

// ─── PMX Binary Reader ───────────────────────────────────────────────

class PMXReader {
  constructor(buffer) {
    this.dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    this.offset = 0;
    this.encoding = 0; // 0 = UTF-16LE, 1 = UTF-8
  }

  getInt8()   { const v = this.dv.getInt8(this.offset);   this.offset += 1; return v; }
  getUint8()  { const v = this.dv.getUint8(this.offset);  this.offset += 1; return v; }
  getInt16()  { const v = this.dv.getInt16(this.offset, true);  this.offset += 2; return v; }
  getUint16() { const v = this.dv.getUint16(this.offset, true); this.offset += 2; return v; }
  getInt32()  { const v = this.dv.getInt32(this.offset, true);  this.offset += 4; return v; }
  getUint32() { const v = this.dv.getUint32(this.offset, true); this.offset += 4; return v; }
  getFloat32(){ const v = this.dv.getFloat32(this.offset, true); this.offset += 4; return v; }

  getFloat32Array(n) {
    const a = [];
    for (let i = 0; i < n; i++) a.push(this.getFloat32());
    return a;
  }

  getIndex(size, unsigned = false) {
    switch (size) {
      case 1: return unsigned ? this.getUint8() : this.getInt8();
      case 2: return unsigned ? this.getUint16() : this.getInt16();
      case 4: return this.getInt32();
      default: throw new Error(`Unknown index size: ${size}`);
    }
  }

  getIndexArray(size, count, unsigned = false) {
    const a = [];
    for (let i = 0; i < count; i++) a.push(this.getIndex(size, unsigned));
    return a;
  }

  getChars(n) {
    let str = '';
    for (let i = 0; i < n; i++) {
      str += String.fromCharCode(this.getUint8());
    }
    return str;
  }

  getTextBuffer() {
    const size = this.getUint32();
    if (size === 0) return '';

    if (this.encoding === 0) {
      // UTF-16LE
      let str = '';
      let remaining = size;
      while (remaining >= 2) {
        const code = this.getUint16();
        remaining -= 2;
        if (code === 0) break;
        str += String.fromCharCode(code);
      }
      // Skip remaining bytes
      while (remaining > 0) { this.getUint8(); remaining--; }
      return str;
    } else {
      // UTF-8
      const bytes = Buffer.from(this.dv.buffer, this.dv.byteOffset + this.offset, size);
      this.offset += size;
      // Remove trailing nulls
      let end = size;
      while (end > 0 && bytes[end - 1] === 0) end--;
      return bytes.subarray(0, end).toString('utf-8');
    }
  }

  skip(n) { this.offset += n; }
}

// ─── PMX Parser (header + textures + materials only) ─────────────────

function parsePMX(filePath) {
  const buf = readFileSync(filePath);
  const r = new PMXReader(buf);

  // --- Header ---
  const magic = r.getChars(4);
  if (magic !== 'PMX ') throw new Error(`Not a PMX file (magic: "${magic}")`);

  const version = r.getFloat32();
  const headerSize = r.getUint8(); // number of globals that follow

  const encoding     = r.getUint8(); // 0=UTF-16LE, 1=UTF-8
  r.encoding = encoding;

  const additionalUvNum   = r.getUint8();
  const vertexIndexSize   = r.getUint8();
  const textureIndexSize  = r.getUint8();
  const materialIndexSize = r.getUint8();
  const boneIndexSize     = r.getUint8();
  const morphIndexSize    = r.getUint8();
  const rigidBodyIndexSize = r.getUint8();

  const modelName        = r.getTextBuffer();
  const englishModelName = r.getTextBuffer();
  const comment          = r.getTextBuffer();
  const englishComment   = r.getTextBuffer();

  // --- Vertices (skip) ---
  const vertexCount = r.getUint32();
  for (let i = 0; i < vertexCount; i++) {
    r.skip(4 * 3); // position
    r.skip(4 * 3); // normal
    r.skip(4 * 2); // uv
    r.skip(4 * 4 * additionalUvNum); // additional uvs

    const boneType = r.getUint8();
    if (boneType === 0) { // BDEF1
      r.getIndex(boneIndexSize);
    } else if (boneType === 1) { // BDEF2
      r.getIndex(boneIndexSize);
      r.getIndex(boneIndexSize);
      r.skip(4); // weight
    } else if (boneType === 2) { // BDEF4
      r.getIndex(boneIndexSize);
      r.getIndex(boneIndexSize);
      r.getIndex(boneIndexSize);
      r.getIndex(boneIndexSize);
      r.skip(4 * 4); // weights
    } else if (boneType === 3) { // SDEF
      r.getIndex(boneIndexSize);
      r.getIndex(boneIndexSize);
      r.skip(4); // weight
      r.skip(4 * 3); // C
      r.skip(4 * 3); // R0
      r.skip(4 * 3); // R1
    } else if (boneType === 4) { // QDEF (PMX 2.1)
      r.getIndex(boneIndexSize);
      r.getIndex(boneIndexSize);
      r.getIndex(boneIndexSize);
      r.getIndex(boneIndexSize);
      r.skip(4 * 4); // weights
    } else {
      throw new Error(`Unknown bone type ${boneType} at vertex ${i}`);
    }

    r.skip(4); // edge ratio
  }

  // --- Faces (skip) ---
  const faceIndexCount = r.getUint32();
  r.skip(vertexIndexSize * faceIndexCount);

  // --- Textures ---
  const textureCount = r.getUint32();
  const textures = [];
  for (let i = 0; i < textureCount; i++) {
    textures.push(r.getTextBuffer());
  }

  // --- Materials ---
  const materialCount = r.getUint32();
  const materials = [];

  for (let i = 0; i < materialCount; i++) {
    const mat = {};
    mat.name        = r.getTextBuffer();
    mat.englishName = r.getTextBuffer();
    mat.diffuse     = r.getFloat32Array(4); // RGBA (A = alpha/opacity)
    mat.specular    = r.getFloat32Array(3);
    mat.shininess   = r.getFloat32();
    mat.ambient     = r.getFloat32Array(3);
    mat.flag        = r.getUint8();
    mat.edgeColor   = r.getFloat32Array(4);
    mat.edgeSize    = r.getFloat32();
    mat.textureIndex    = r.getIndex(textureIndexSize);
    mat.envTextureIndex = r.getIndex(textureIndexSize);
    mat.envFlag         = r.getUint8();  // 0=none, 1=multiply, 2=add, 3=sub-texture
    mat.toonFlag        = r.getUint8();

    if (mat.toonFlag === 0) {
      mat.toonIndex = r.getIndex(textureIndexSize);
    } else if (mat.toonFlag === 1) {
      mat.toonIndex = r.getInt8();
    } else {
      throw new Error(`Unknown toon flag ${mat.toonFlag}`);
    }

    mat.comment   = r.getTextBuffer();
    mat.faceCount = r.getUint32() / 3; // stored as index count, convert to face count

    materials.push(mat);
  }

  return {
    version,
    encoding: encoding === 0 ? 'UTF-16LE' : 'UTF-8',
    modelName,
    englishModelName,
    vertexCount,
    faceCount: faceIndexCount / 3,
    textureCount,
    textures,
    materialCount,
    materials,
  };
}

// ─── Material flag decoder ───────────────────────────────────────────

function decodeMaterialFlag(flag) {
  const flags = [];
  if (flag & 0x01) flags.push('double-sided');
  if (flag & 0x02) flags.push('ground-shadow');
  if (flag & 0x04) flags.push('cast-shadow');
  if (flag & 0x08) flags.push('receive-shadow');
  if (flag & 0x10) flags.push('has-edge');
  if (flag & 0x20) flags.push('vertex-color');   // PMX 2.1
  if (flag & 0x40) flags.push('draw-point');      // PMX 2.1
  if (flag & 0x80) flags.push('draw-line');       // PMX 2.1
  return flags;
}

const SPHERE_MODES = ['none', 'multiply (spa)', 'add (sph)', 'sub-texture'];

// ─── Main ────────────────────────────────────────────────────────────

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error('Usage: node inspect-pmx-materials.mjs <pmx-file> [pmx-file2] ...');
  process.exit(1);
}

for (const filePath of files) {
  console.log('\n' + '='.repeat(80));
  console.log(`FILE: ${basename(filePath)}`);
  console.log(`PATH: ${filePath}`);
  console.log('='.repeat(80));

  try {
    const pmx = parsePMX(filePath);

    console.log(`\nModel: ${pmx.modelName}`);
    if (pmx.englishModelName) console.log(`English: ${pmx.englishModelName}`);
    console.log(`Version: ${pmx.version}, Encoding: ${pmx.encoding}`);
    console.log(`Vertices: ${pmx.vertexCount}, Faces: ${pmx.faceCount}`);
    console.log(`Textures: ${pmx.textureCount}, Materials: ${pmx.materialCount}`);

    // Print texture list
    console.log(`\n--- Texture List (${pmx.textures.length}) ---`);
    pmx.textures.forEach((t, i) => {
      console.log(`  [${i}] ${t}`);
    });

    // Print material details
    console.log(`\n--- Materials (${pmx.materials.length}) ---`);
    for (let i = 0; i < pmx.materials.length; i++) {
      const m = pmx.materials[i];
      const hasDiffuse = m.textureIndex >= 0 && m.textureIndex < pmx.textures.length;
      const hasSphere  = m.envTextureIndex >= 0 && m.envTextureIndex < pmx.textures.length;
      const alpha = m.diffuse[3];
      const flags = decodeMaterialFlag(m.flag);

      console.log(`\n  [${i}] "${m.name}"`);
      if (m.englishName) console.log(`       English: "${m.englishName}"`);
      console.log(`       Alpha/Opacity: ${alpha.toFixed(3)}`);
      console.log(`       Diffuse:  RGBA(${m.diffuse.map(v => v.toFixed(3)).join(', ')})`);
      console.log(`       Specular: RGB(${m.specular.map(v => v.toFixed(3)).join(', ')}), Shininess: ${m.shininess.toFixed(1)}`);
      console.log(`       Ambient:  RGB(${m.ambient.map(v => v.toFixed(3)).join(', ')})`);
      console.log(`       Flags: [${flags.join(', ')}] (raw: 0x${m.flag.toString(16).padStart(2, '0')})`);

      // Diffuse texture
      if (hasDiffuse) {
        console.log(`       Diffuse Texture: [${m.textureIndex}] "${pmx.textures[m.textureIndex]}"`);
      } else {
        console.log(`       Diffuse Texture: NONE (index: ${m.textureIndex})`);
      }

      // Sphere texture
      if (hasSphere) {
        console.log(`       Sphere Texture: [${m.envTextureIndex}] "${pmx.textures[m.envTextureIndex]}"`);
        console.log(`       Sphere Mode: ${m.envFlag} = ${SPHERE_MODES[m.envFlag] || 'unknown'}`);
      } else {
        console.log(`       Sphere Texture: NONE (index: ${m.envTextureIndex})`);
        console.log(`       Sphere Mode: ${m.envFlag} = ${SPHERE_MODES[m.envFlag] || 'unknown'}`);
      }

      // Toon
      if (m.toonFlag === 0 && m.toonIndex >= 0 && m.toonIndex < pmx.textures.length) {
        console.log(`       Toon: [${m.toonIndex}] "${pmx.textures[m.toonIndex]}" (custom)`);
      } else if (m.toonFlag === 1) {
        console.log(`       Toon: built-in #${m.toonIndex}`);
      } else {
        console.log(`       Toon: NONE (flag: ${m.toonFlag}, index: ${m.toonIndex})`);
      }

      console.log(`       Face Count: ${m.faceCount}`);
      if (m.comment) console.log(`       Comment: "${m.comment}"`);

      // Highlight interesting cases
      if (hasSphere && !hasDiffuse) {
        console.log(`       >>> OVERLAY: sphere only (no diffuse texture)`);
      }
      if (hasSphere && hasDiffuse) {
        console.log(`       >>> HAS BOTH: diffuse + sphere`);
      }
      if (alpha < 1.0) {
        console.log(`       >>> TRANSLUCENT: alpha = ${alpha.toFixed(3)}`);
      }
    }

    // Summary: sphere usage
    console.log(`\n--- Sphere Texture Summary ---`);
    const sphereMats = pmx.materials.filter((m, i) => {
      return m.envTextureIndex >= 0 && m.envTextureIndex < pmx.textures.length;
    });
    if (sphereMats.length === 0) {
      console.log('  No materials use sphere textures.');
    } else {
      console.log(`  ${sphereMats.length} of ${pmx.materials.length} materials use sphere textures:`);
      for (const m of sphereMats) {
        const hasDiffuse = m.textureIndex >= 0 && m.textureIndex < pmx.textures.length;
        const mode = SPHERE_MODES[m.envFlag] || `unknown(${m.envFlag})`;
        const overlay = hasDiffuse ? 'diffuse+sphere' : 'SPHERE ONLY (overlay)';
        console.log(`    "${m.name}" -> sphere: "${pmx.textures[m.envTextureIndex]}" mode: ${mode} | ${overlay} | alpha: ${m.diffuse[3].toFixed(3)}`);
      }
    }

  } catch (err) {
    console.error(`ERROR parsing ${filePath}: ${err.message}`);
    console.error(err.stack);
  }
}

console.log('\n');
