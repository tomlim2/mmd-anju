import { LoadingManager } from 'three/webgpu';
import { MMDLoader } from '../vendor/MMDLoader.js';
import { swapToToonMaterial, createOutlineMesh } from './shader.js';
import { findMojibakeMatch } from './encoding.js';

export class MMDModelLoader {
  constructor(mmdScene) {
    this.mmdScene = mmdScene;
    this.mesh = null;
    this.outlineMesh = null;
    this.edgeVisible = true;
    this._blobUrls = [];
    this._texturesReady = Promise.resolve();
    this.onStatus = null; // (msg: string) => void
    this.onProgress = null; // (loaded: number, total: number) => void
  }

  loadPMXFromBlobs(pmxFile, blobs) {
    // Pre-create blob URLs for all files, keyed by lowercase filename
    this._revokeBlobUrls();
    const urlMap = new Map();

    for (const [path, file] of blobs) {
      // Key by filename (lowercase, handle backslash paths from PMX)
      const name = path.split(/[/\\]/).pop().toLowerCase();
      if (!urlMap.has(name)) {
        const blobUrl = URL.createObjectURL(file);
        urlMap.set(name, blobUrl);
        this._blobUrls.push(blobUrl);
      }
    }

    // Build candidate set for mojibake fallback
    const candidateSet = new Set(urlMap.keys());

    // Custom LoadingManager that resolves texture filenames to blob URLs
    const manager = new LoadingManager();
    manager.resolveURL = (url) => {
      const decoded = decodeURIComponent(url);
      const filename = decoded.split(/[/\\]/).pop().toLowerCase();
      const direct = urlMap.get(filename);
      if (direct) return direct;

      // Mojibake fallback: try encoding round-trips
      const dotIdx = filename.lastIndexOf('.');
      if (dotIdx > 0) {
        const stem = filename.slice(0, dotIdx);
        const ext = filename.slice(dotIdx);
        const match = findMojibakeMatch(stem, ext, candidateSet);
        if (match) {
          console.info(`[MMD] Mojibake fallback: "${filename}" → "${match}"`);
          return urlMap.get(match);
        }
      }
      // Missing texture: return transparent 1px PNG for image files to suppress console errors
      if (/\.(png|jpe?g|bmp|tga|dds|gif|spa|sph)$/i.test(filename)) {
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      }
      return url;
    };

    let texturesResolved = false;
    this._texturesReady = new Promise((resolveTex) => {
      manager.onLoad = () => { texturesResolved = true; resolveTex(); };
    });
    let meshLoaded = false;
    manager.onProgress = (_url, loaded, total) => {
      if (!meshLoaded) return;
      if (!texturesResolved) {
        this.onStatus?.('Loading textures...');
        this.onProgress?.(loaded, total);
      }
    };

    const loader = new MMDLoader(manager);
    const pmxUrl = URL.createObjectURL(pmxFile);
    this._blobUrls.push(pmxUrl);

    return new Promise((resolve, reject) => {
      this.onStatus?.('Loading mesh...');
      loader.load(pmxUrl, (mesh) => {
        meshLoaded = true;
        this.onStatus?.('Loading textures...');
        swapToToonMaterial(mesh);
        this._pendingMesh = mesh;
        this._pendingOutlineMesh = createOutlineMesh(mesh);
        resolve(mesh);
      }, undefined, (err) => {
        reject(err);
      });
    });
  }

  loadPMXFromPath(path) {
    this._revokeBlobUrls();
    const manager = new LoadingManager();
    let texturesResolved = false;
    this._texturesReady = new Promise((resolveTex) => {
      manager.onLoad = () => { texturesResolved = true; resolveTex(); };
    });
    let meshLoaded = false;
    manager.onProgress = (_url, loaded, total) => {
      if (!meshLoaded) return;
      if (!texturesResolved) {
        this.onStatus?.('Loading textures...');
        this.onProgress?.(loaded, total);
      }
    };
    const loader = new MMDLoader(manager);

    return new Promise((resolve, reject) => {
      this.onStatus?.('Loading mesh...');
      loader.load(path, (mesh) => {
        meshLoaded = true;
        this.onStatus?.('Loading textures...');
        swapToToonMaterial(mesh);
        this._pendingMesh = mesh;
        this._pendingOutlineMesh = createOutlineMesh(mesh);
        resolve(mesh);
      }, undefined, (err) => {
        reject(err);
      });
    });
  }

  /** Swap pending mesh into scene, disposing the old one. Starts hidden. */
  commitPendingMesh() {
    if (!this._pendingMesh) return;
    this._removeCurrentMesh();
    this.mesh = this._pendingMesh;
    this._pendingMesh = null;
    this.mesh.visible = false;
    this.mmdScene.scene.add(this.mesh);

    // Add outline mesh to scene (shares skeleton, single render pass)
    this.outlineMesh = this._pendingOutlineMesh || null;
    this._pendingOutlineMesh = null;
    if (this.outlineMesh) {
      this.outlineMesh.visible = false;
      this.mmdScene.scene.add(this.outlineMesh);
    }
  }

  /** Reveal the current mesh after all textures finish loading (fade-in). */
  async reveal() {
    await this._texturesReady;
    if (!this.mesh) return;

    // Collect all materials and save original opacity/transparent values
    const allMats = [];
    const meshMats = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
    for (const m of meshMats) {
      allMats.push({ mat: m, origOpacity: m.opacity, origTransparent: m.transparent });
      m.opacity = 0;
      m.transparent = true;
    }
    const chk = document.getElementById('chk-edge');
    this.edgeVisible = chk ? chk.checked : true;
    if (this.outlineMesh) {
      const outMats = this.outlineMesh.userData.outlineMaterials || [];
      for (const m of outMats) {
        allMats.push({ mat: m, origOpacity: m.opacity, origTransparent: m.transparent });
        m.opacity = 0;
        m.transparent = true;
      }
    }

    // Make meshes visible (opacity 0, so invisible initially)
    this.mesh.visible = true;
    if (this.outlineMesh) this.outlineMesh.visible = this.edgeVisible;

    // Animate opacity 0→1 over ~300ms
    const duration = 300;
    const start = performance.now();
    await new Promise((resolve) => {
      const tick = (now) => {
        const t = Math.min((now - start) / duration, 1);
        for (const { mat, origOpacity } of allMats) {
          mat.opacity = t * origOpacity;
        }
        if (t < 1) {
          requestAnimationFrame(tick);
        } else {
          // Restore original transparent flags
          for (const { mat, origTransparent } of allMats) {
            mat.transparent = origTransparent;
          }
          resolve();
        }
      };
      requestAnimationFrame(tick);
    });
  }

  _removeCurrentMesh() {
    if (this.outlineMesh) {
      this.mmdScene.scene.remove(this.outlineMesh);
      const mats = this.outlineMesh.userData.outlineMaterials || [];
      mats.forEach(m => m.dispose());
      // Don't dispose geometry (shared with main mesh)
      this.outlineMesh = null;
    }
    if (this.mesh) {
      this.mmdScene.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      const mats = Array.isArray(this.mesh.material) ? this.mesh.material : [this.mesh.material];
      mats.forEach(m => {
        for (const key of ['map', 'normalMap', 'emissiveMap', 'alphaMap', 'matcap']) {
          if (m[key]) m[key].dispose();
        }
        m.dispose();
      });
      this.mesh = null;
    }
  }

  _revokeBlobUrls() {
    this._blobUrls.forEach(u => URL.revokeObjectURL(u));
    this._blobUrls = [];
  }
}
