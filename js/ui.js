import { MMDLoader } from '../vendor/MMDLoader.js';
import { hasHumanoidBones } from './pmx-check.js';
import { remapClipBones } from './bone-remap.js';
import { validateClip } from './vmd-validator.js';
import { retargetClip } from './bone-retarget.js';
import { extractVmdMeta } from './vmd-meta.js';
import { precomputeEffectEvents } from './effects/spark-precompute.js';
import { autoSizeIK } from './ik-sizing.js';

export class UI {
  constructor({ mmdScene, loader, animation, audio, riseFx, fallFx, rippleFx, mirrorFx }) {
    this.mmdScene = mmdScene;
    this.loader = loader;
    this.animation = animation;
    this.audio = audio;
    this.riseFx = riseFx;
    this.fallFx = fallFx;
    this.rippleFx = rippleFx;
    this.mirrorFx = mirrorFx;
    this.postProcess = null;
    this._ac = new AbortController();
    this._pmxPath = '';
    this._vmdPath = '';
    this._currentVmd = null;   // {vmdPath, audioPath} of currently playing song
    this._pendingVmd = null;   // VMD blob fetched before mesh is available
    this._currentPmxEntry = null; // PMX manifest entry for current model

    this.loader.onStatus = (msg) => this._setLoadingText(msg);
    this.loader.onProgress = (loaded, total) => this._setLoadingCounter(loaded, total);
    this._pmxReady = this._initPmxSelect();
    this._initSampleMode();
    this._initUpload();
    this._initPlayback();
    this._initTimeline();
    this._initFxSelectors();
    this._initKeyboard();
    this._initHideUI();
    this._initTheaterMode();
    this._pmxReady.then(() => this._loadDefaultModel());

    this.audio.onEnded(() => this._playNextSample());
  }

  async _loadDefaultModel() {
    const defaultEntry = this._pmxManifest?.find(e => e.family === 'animasa')
      || this._pmxManifest?.[0];
    const path = defaultEntry
      ? 'samples/pmx/' + defaultEntry.path
      : 'samples/pmx/animasa/miku.pmx';
    const statusEl = document.getElementById('loading-status');
    statusEl.textContent = 'Loading...';

    try {
      // Wait for both PMX and first VMD to finish loading
      await Promise.all([
        this.loader.loadPMXFromPath(path),
        this._firstVmdReady,
      ]);
      this._setLoadingText('Applying motion...');
      this.loader.commitPendingMesh();
      this._pmxPath = path;
      this._currentPmxEntry = defaultEntry || null;
      this._syncPmxSelect();
      document.getElementById('title').style.display = 'none';

      // Apply VMD — _firstVmdReady resolved so _pendingVmd should be set
      if (this._pendingVmd) {
        await this._applyVmdToMesh(this._pendingVmd.vmdBlob);
        this._currentVmd = this._pendingVmd;
        this._pendingVmd = null;
      }

      // Everything ready — show play button overlay
      await this.loader.reveal();
      this._hideLoading();
      this._showPlayOverlay();

      statusEl.textContent = '';
    } catch (err) {
      console.error('Default model load error:', err);
      this._hideLoading();
      statusEl.textContent = 'Model not found';
    }
  }

  // --- PMX Model Selection ---

  async _initPmxSelect() {
    const selectPmx = document.getElementById('select-pmx');
    const sig = { signal: this._ac.signal };

    try {
      const res = await fetch('samples/pmx/manifest.json');
      if (!res.ok) return;
      this._pmxManifest = await res.json();
    } catch {
      return;
    }

    const deployed = this._pmxManifest.filter(e => e.deployed !== false);
    for (const entry of deployed) {
      const opt = document.createElement('option');
      opt.value = JSON.stringify(entry);
      opt.textContent = entry.name;
      selectPmx.appendChild(opt);
    }
    // Set default to animasa family (matches _loadDefaultModel)
    const defaultEntry = deployed.find(e => e.family === 'animasa') || deployed[0];
    if (defaultEntry) selectPmx.value = JSON.stringify(defaultEntry);
    selectPmx.disabled = deployed.length <= 1;

    selectPmx.addEventListener('change', async () => {
      if (!selectPmx.value) return;
      // Handle uploaded PMX selection
      if (selectPmx.value.startsWith('upload:')) {
        const name = selectPmx.value.slice(7);
        const idx = this._uploadedPmxs.findIndex(p => p.name === name);
        if (idx >= 0) await this._loadUploadedPmx(idx);
        return;
      }
      const entry = JSON.parse(selectPmx.value);
      this._currentPmxEntry = entry;
      if (entry.type === 'zip') {
        await this._loadPmxFromZipPath('samples/pmx/' + entry.path);
      } else {
        await this._loadPmxFromSamplePath('samples/pmx/' + entry.path);
      }
    }, sig);
  }

  _syncPmxSelect() {
    if (!this._currentPmxEntry) return;
    const selectPmx = document.getElementById('select-pmx');
    for (const opt of selectPmx.options) {
      if (!opt.value) continue;
      try {
        const entry = JSON.parse(opt.value);
        if (entry.path === this._currentPmxEntry.path) {
          selectPmx.value = opt.value;
          return;
        }
      } catch {}
    }
  }

  async _loadPmxFromSamplePath(pmxPath) {
    const statusEl = document.getElementById('loading-status');
    statusEl.textContent = 'Loading...';
    this._showLoading('Loading...');

    const savedTime = this.audio.currentTime;
    const wasPlaying = this.animation.playing;

    try {
      // Load new mesh in background (old model stays visible)
      await this.loader.loadPMXFromPath(pmxPath);
      // Swap: destroy old animation, commit new mesh, reapply VMD
      this._setLoadingText('Applying motion...');
      this.animation.destroy();
      this.loader.commitPendingMesh();
      this._pmxPath = pmxPath;
      this._updateDebugPaths();
      await this._reapplyCurrentVmd(savedTime, wasPlaying);
      await this.loader.reveal();
      this._hideLoading();
      statusEl.textContent = '';
    } catch (err) {
      console.error('PMX load error:', err);
      this._hideLoading();
      statusEl.textContent = 'Load failed';
      setTimeout(() => { if (statusEl.textContent === 'Load failed') statusEl.textContent = ''; }, 3000);
    }
  }

  async _loadPmxFromZipPath(zipUrl) {
    const statusEl = document.getElementById('loading-status');
    statusEl.textContent = 'Loading...';
    this._showLoading('Downloading ZIP...');

    const savedTime = this.audio.currentTime;
    const wasPlaying = this.animation.playing;

    try {
      const res = await fetch(zipUrl);
      if (!res.ok) throw new Error(`Failed to fetch ZIP: ${res.status}`);
      const zipBlob = await res.blob();
      const zip = await JSZip.loadAsync(zipBlob);

      const entries = new Map();
      const pmxPaths = [];
      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        const blob = await entry.async('blob');
        entries.set(path, blob);
        if (/\.pmx$/i.test(path)) pmxPaths.push(path);
      }

      // Find first humanoid PMX
      let targetPmx = pmxPaths[0];
      for (const p of pmxPaths) {
        const buf = await entries.get(p).arrayBuffer();
        if (hasHumanoidBones(buf)) { targetPmx = p; break; }
      }
      if (!targetPmx) throw new Error('No PMX found in ZIP');

      const pmxName = targetPmx.split('/').pop();
      const pmxFile = new File([entries.get(targetPmx)], pmxName);
      const blobs = new Map();
      for (const [path, blob] of entries) {
        blobs.set(path, new File([blob], path.split('/').pop()));
      }

      await this.loader.loadPMXFromBlobs(pmxFile, blobs);
      // Swap: destroy old animation, commit new mesh, reapply VMD
      this._setLoadingText('Applying motion...');
      this.animation.destroy();
      this.loader.commitPendingMesh();
      this._pmxPath = targetPmx;
      this._updateDebugPaths();
      await this._reapplyCurrentVmd(savedTime, wasPlaying);
      await this.loader.reveal();
      this._hideLoading();
      statusEl.textContent = '';
    } catch (err) {
      console.error('ZIP PMX load error:', err);
      this._hideLoading();
      statusEl.textContent = 'Load failed';
      setTimeout(() => { if (statusEl.textContent === 'Load failed') statusEl.textContent = ''; }, 3000);
    }
  }

  async _reapplyCurrentVmd(savedTime, wasPlaying = false) {
    const vmdToApply = this._currentVmd || this._pendingVmd;
    if (!vmdToApply) return;

    await this._applyVmdToMesh(vmdToApply.vmdBlob);
    this._currentVmd = vmdToApply;
    this._pendingVmd = null;

    if (this.animation.helper && this.animation.mesh) {
      this.animation.seekTo(savedTime);
      this.riseFx.seekTo(savedTime);
      this.rippleFx.seekTo(savedTime);
    }
    this.animation.playing = wasPlaying;
    this._updatePlayPauseButton(wasPlaying);
  }

  // --- Upload Mode ---

  _initUpload() {
    const btnVmd = document.getElementById('btn-upload-vmd');
    const btnPmx = document.getElementById('btn-upload-pmx');
    const inputVmd = document.getElementById('input-vmd');
    const inputPmx = document.getElementById('input-pmx');

    this._uploadedVmds = [];
    this._uploadedPmxs = [];

    btnVmd.onclick = () => inputVmd.click();
    btnPmx.onclick = () => inputPmx.click();

    inputVmd.onchange = (e) => this._handleVmdUpload(e.target.files);
    inputPmx.onchange = (e) => this._handlePmxUpload(e.target.files);
  }

  _handleVmdUpload(fileList) {
    const files = Array.from(fileList);
    const vmds = files.filter(f => /\.vmd$/i.test(f.name));
    const audios = files.filter(f => /\.(mp3|ogg|m4a|wav)$/i.test(f.name));

    if (!vmds.length) return;

    this._uploadedVmds = vmds.map(vmdFile => {
      const stem = vmdFile.name.replace(/\.vmd$/i, '').toLowerCase();
      const audioFile = audios.find(a => {
        const aStem = a.name.replace(/\.(mp3|ogg|m4a|wav)$/i, '').toLowerCase();
        return aStem === stem;
      }) || audios[0] || null;
      return { name: vmdFile.name.replace(/\.vmd$/i, ''), file: vmdFile, audioFile };
    });

    const songSelect = document.getElementById('select-song');
    // Remove previously uploaded VMD options
    for (const opt of [...songSelect.options]) {
      if (opt.value.startsWith('upload:')) opt.remove();
    }
    for (const entry of this._uploadedVmds) {
      const o = document.createElement('option');
      o.value = 'upload:' + entry.name;
      o.textContent = entry.name;
      songSelect.appendChild(o);
    }
    songSelect.value = 'upload:' + this._uploadedVmds[0].name;
    songSelect.disabled = songSelect.options.length <= 1;

    document.getElementById('btn-upload-vmd').classList.add('uploaded');
    this._loadUploadedVmd(0);
  }

  async _handlePmxUpload(fileList) {
    const files = Array.from(fileList);
    const pmxFiles = files.filter(f => /\.pmx$/i.test(f.name));

    if (!pmxFiles.length) return;

    const allBlobs = new Map();
    for (const f of files) allBlobs.set(f.name, f);

    // Filter: only humanoid PMX files
    const valid = [];
    for (const pmxFile of pmxFiles) {
      const buf = await pmxFile.arrayBuffer();
      if (hasHumanoidBones(buf)) {
        valid.push(new File([buf], pmxFile.name));
      }
    }
    if (!valid.length) {
      this._showToast('No humanoid PMX found');
      return;
    }

    this._uploadedPmxs = valid.map(pmxFile => ({
      name: pmxFile.name.replace(/\.pmx$/i, ''),
      pmxFile,
      blobs: allBlobs,
    }));

    const selectPmx = document.getElementById('select-pmx');
    // Remove previously uploaded PMX options
    for (const opt of [...selectPmx.options]) {
      if (opt.value.startsWith('upload:')) opt.remove();
    }
    for (const entry of this._uploadedPmxs) {
      const o = document.createElement('option');
      o.value = 'upload:' + entry.name;
      o.textContent = entry.name;
      selectPmx.appendChild(o);
    }
    selectPmx.value = 'upload:' + this._uploadedPmxs[0].name;
    selectPmx.disabled = selectPmx.options.length <= 1;

    document.getElementById('btn-upload-pmx').classList.add('uploaded');
    this._loadUploadedPmx(0);
  }

  async _loadUploadedVmd(index) {
    const entry = this._uploadedVmds[index];
    if (!entry) return;

    if (entry.audioFile) {
      this.audio.loadFromFile(entry.audioFile);
    } else {
      this.audio.stop();
    }

    this._vmdPath = entry.name;
    this._updateDebugPaths();

    if (this.loader.mesh) {
      this.animation.destroy();
      this.riseFx.resetTime();
      this.rippleFx.resetTime();
      await this._applyVmdToMesh(entry.file);
      this._currentVmd = { vmdPath: entry.name, audioPath: '', vmdBlob: entry.file };
      this._pendingVmd = null;

      const overlay = document.getElementById('play-overlay');
      const autoplay = overlay.classList.contains('hidden');
      this.animation.playing = autoplay;
      this._updatePlayPauseButton(autoplay);
      if (autoplay && entry.audioFile) this.audio.play();
    } else {
      this._pendingVmd = { vmdPath: entry.name, audioPath: '', vmdBlob: entry.file };
      this._currentVmd = null;
    }
  }

  async _loadUploadedPmx(index) {
    const entry = this._uploadedPmxs[index];
    if (!entry) return;

    const statusEl = document.getElementById('loading-status');
    statusEl.textContent = 'Loading...';
    this._showLoading('Loading...');

    const savedTime = this.audio.currentTime;
    const wasPlaying = this.animation.playing;

    try {
      await this.loader.loadPMXFromBlobs(entry.pmxFile, entry.blobs);
      this._setLoadingText('Applying motion...');
      this.animation.destroy();
      this.loader.commitPendingMesh();
      this._pmxPath = entry.name + '.pmx';
      this._updateDebugPaths();

      await this._reapplyCurrentVmd(savedTime, wasPlaying);
      await this.loader.reveal();
      this._hideLoading();
      statusEl.textContent = '';
    } catch (err) {
      console.error('Upload PMX load error:', err);
      this._hideLoading();
      statusEl.textContent = 'Load failed';
      setTimeout(() => { if (statusEl.textContent === 'Load failed') statusEl.textContent = ''; }, 3000);
    }
  }

  // --- Sample Mode ---

  _sampleSongs = [];
  _sampleIndex = 0;

  async _initSampleMode() {
    const songSelect = document.getElementById('select-song');

    try {
      const res = await fetch('samples/vmd/manifest.json');
      if (!res.ok) return;
      this._sampleSongs = await res.json();
    } catch { return; }

    this._sampleSongs = this._sampleSongs.filter(s => s.deployed !== false);
    songSelect.innerHTML = '';
    for (const song of this._sampleSongs) {
      const o = document.createElement('option');
      o.value = song.vmd;
      o.textContent = song.score < 35 ? `\u26A0 ${song.name}` : song.name;
      if (song.score < 35) o.style.color = '#e06c75';
      songSelect.appendChild(o);
    }
    songSelect.disabled = this._sampleSongs.length <= 1;

    const sig = { signal: this._ac.signal };
    const syncSelectColor = () => {
      const song = this._sampleSongs.find(s => s.vmd === songSelect.value);
      songSelect.style.color = song && song.score < 35 ? '#e06c75' : '';
    };

    songSelect.addEventListener('change', async () => {
      if (!songSelect.value) return;
      // Handle uploaded VMD selection
      if (songSelect.value.startsWith('upload:')) {
        const name = songSelect.value.slice(7);
        const idx = this._uploadedVmds.findIndex(v => v.name === name);
        if (idx >= 0) await this._loadUploadedVmd(idx);
        return;
      }
      const song = this._sampleSongs.find(s => s.vmd === songSelect.value);
      if (!song) return;
      syncSelectColor();
      this._sampleIndex = this._sampleSongs.indexOf(song);
      await this._loadSampleSong(song);
    }, sig);

    // Auto-play first sample
    this._sampleIndex = 0;
    const first = this._sampleSongs[0];
    songSelect.value = first.vmd;
    syncSelectColor();
    this._firstVmdReady = this._loadSampleSong(first);
  }

  _loadSampleSong(song) {
    return this._loadVMDFromPath(
      'samples/vmd/' + song.vmd,
      song.audio ? 'samples/vmd/' + song.audio : null,
    );
  }

  _playNextSample() {
    if (!this._sampleSongs.length) return;
    this._sampleIndex = (this._sampleIndex + 1) % this._sampleSongs.length;
    const song = this._sampleSongs[this._sampleIndex];
    const songSelect = document.getElementById('select-song');
    songSelect.value = song.vmd;
    this._loadSampleSong(song);
  }

  async _loadVMDFromPath(vmdPath, audioPath) {
    try {
      const fetches = [fetch(vmdPath)];
      if (audioPath) fetches.push(fetch(audioPath));

      const responses = await Promise.all(fetches);
      const vmdRes = responses[0];
      if (!vmdRes.ok) throw new Error(`Failed to fetch VMD: ${vmdRes.status}`);

      const vmdBlob = await vmdRes.blob();
      const vmdFile = new File([vmdBlob], vmdPath.split('/').pop());

      if (audioPath) {
        const audioRes = responses[1];
        if (!audioRes.ok) throw new Error(`Failed to fetch audio: ${audioRes.status}`);
        const audioBlob = await audioRes.blob();
        const audioFile = new File([audioBlob], audioPath.split('/').pop());
        this.audio.loadFromFile(audioFile);
      } else {
        this.audio.stop();
      }

      this._vmdPath = vmdPath;
      this._updateDebugPaths();

      if (this.loader.mesh) {
        this.animation.destroy();
        this.riseFx.resetTime();
        this.rippleFx.resetTime();
        await this._applyVmdToMesh(vmdFile);
        this._currentVmd = { vmdPath, audioPath, vmdBlob: vmdFile };
        this._pendingVmd = null;

        const overlay = document.getElementById('play-overlay');
        const autoplay = overlay.classList.contains('hidden');
        this.animation.playing = autoplay;
        this._updatePlayPauseButton(autoplay);
        if (autoplay && audioPath) this.audio.play();
      } else {
        this._pendingVmd = { vmdPath, audioPath, vmdBlob: vmdFile };
        this._currentVmd = null;
        // Audio playback deferred — _loadDefaultModel will play after mesh + VMD ready
      }
    } catch (err) {
      console.error('VMD load error:', err);
    }
  }

  async _applyVmdToMesh(vmdFile) {
    const mesh = this.loader.mesh;

    // Reset skeleton to rest pose BEFORE loadAnimation — MMDLoader captures
    // bone.position as basePosition for track baking (rest + vmdOffset).
    // Without this, a mid-animation song change bakes animated positions.
    mesh.skeleton.pose();

    const loader = new MMDLoader();

    // Extract VMD metadata before loading
    const buffer = await vmdFile.arrayBuffer();
    const vmdMeta = extractVmdMeta(buffer);

    const url = URL.createObjectURL(vmdFile);

    return new Promise((resolve, reject) => {
      loader.loadAnimation(url, mesh, (clip) => {
        URL.revokeObjectURL(url);

        this._prepareAnimation(clip, mesh, vmdMeta);

        this.animation.initHelper(mesh, { vmd: clip, physics: false });
        this.animation.playing = false;
        resolve(clip);
      }, undefined, (err) => {
        URL.revokeObjectURL(url);
        reject(err);
      });
    });
  }

  _prepareAnimation(clip, mesh, vmdMeta = null) {
    // ① Bone remap
    const remap = remapClipBones(clip, mesh.skeleton);

    // ② Validate compatibility
    const validation = validateClip(clip, mesh, remap, vmdMeta);

    // ③ Retarget (source model detection → offset correction)
    const retarget = retargetClip(clip, remap.trackBones, new Set(remap.dropped));

    // ④ IK sizing (body proportion retargeting)
    const sizing = autoSizeIK(clip, mesh, validation?.vmdFamily);

    // ⑤ Precompute effect events (single mixer pass)
    const trackNames = new Set(clip.tracks.map(t => {
      const m = t.name.match(/\.bones\[(.+?)\]/);
      return m ? m[1] : t.name.replace(/\.(position|quaternion)$/, '');
    }));
    const boneMap = new Map();
    for (const bone of mesh.skeleton.bones) boneMap.set(bone.name, bone);

    function footCandidates(side) {
      const cands = [];
      for (const suffix of ['つま先', '足首', '足ＩＫ']) {
        const name = side + suffix;
        if (boneMap.has(name)) cands.push(name);
      }
      return cands;
    }
    const footGroups = [footCandidates('左'), footCandidates('右')];

    const { sparkEvents, footEvents, footDiag } = precomputeEffectEvents(
      mesh, clip, ['左手首', '右手首'], footGroups,
    );
    this.riseFx.setEvents(sparkEvents);
    this.rippleFx.setEvents(footEvents);

    const fxInfo = { sparkCount: sparkEvents.length, footCount: footEvents.length, footGroups, footDiag, footEvents };
    this._showBoneDebug(remap, validation, retarget, sizing, vmdMeta, fxInfo);
    return { remap, validation, retarget, sizing };
  }

  _showBoneDebug({ remapped, dropped, ignored }, validation, retarget, sizing, vmdMeta, fxInfo) {
    const el = document.getElementById('debug-info');
    const lines = [];
    const scoreHtml = (pct) => {
      if (pct < 75) return `<span class="score-poor">${pct}%</span>`;
      return `${pct}%`;
    };

    // ── Section 1: VMD ──
    const song = this._sampleSongs?.[this._sampleIndex];
    if (song) {
      const target = song.model || vmdMeta?.modelName || '?';
      const reasons = song.warnings?.length
        ? `  <span class="warn">${song.warnings.join(', ')}</span>` : '';
      const vmdLow = song.score < 35;
      const vmdLine = `<span class="meta">VMD</span>  ${song.name} · ${target} · ${scoreHtml(song.score)}${reasons}`;
      lines.push(vmdLow ? `<span class="score-poor">${vmdLine}</span>` : vmdLine);
    } else if (this._vmdPath) {
      const parts = this._vmdPath.split('/');
      const name = parts.length >= 2 ? parts[parts.length - 2] : parts[parts.length - 1];
      lines.push(`<span class="meta">VMD</span>  ${name}`);
    }

    // Audio status
    const audioEl = this.audio.audioElement;
    if (audioEl) {
      if (audioEl.error) {
        lines.push(`<span class="meta">Audio</span>  <span class="error">corrupt (${audioEl.error.message || 'decode failed'})</span>`);
      } else if (audioEl.duration > 0 && !isNaN(audioEl.duration)) {
        lines.push(`<span class="meta">Audio</span>  <span class="detail">${this._formatTime(audioEl.duration)}</span>`);
      } else {
        lines.push(`<span class="meta">Audio</span>  <span class="detail">loading…</span>`);
      }
    } else {
      lines.push(`<span class="meta">Audio</span>  <span class="warn">none</span>`);
    }

    // ── Section 2: PMX ──
    const pmxEntry = this._currentPmxEntry;
    if (pmxEntry) {
      const conf = pmxEntry.confidence ?? 100;
      const family = validation?.pmxFamily || pmxEntry.family || '?';
      const reason = conf < 90 ? `  <span class="warn">unclear family match</span>` : '';
      lines.push(`<span class="meta">PMX</span>  ${pmxEntry.name} · ${family} · ${scoreHtml(conf)}${reason}`);
    } else if (this._pmxPath) {
      const basename = this._pmxPath.replace(/^.*\//, '').replace(/\.pmx$/i, '');
      const family = validation?.pmxFamily || '?';
      lines.push(`<span class="meta">PMX</span>  ${basename} · ${family}`);
    }

    // ── Section 3: Compatibility ──
    if (validation) {
      const score = Math.round(validation.score);
      const { boneMatch, morphMatch } = validation;
      const bonePart = `${boneMatch.matched}/${boneMatch.total} bones`;
      const morphPart = morphMatch ? ` · ${morphMatch.matched}/${morphMatch.total} morphs` : '';
      const sizePart = sizing ? ` · <span class="ratio">×${sizing.legRatio.toFixed(2)}</span>` : '';
      lines.push(`<span class="meta">VMD/PMX</span>  ${scoreHtml(score)}  <span class="detail">${bonePart}${morphPart}${sizePart}</span>`);

      // Reasons for low score
      const warns = [];
      if (validation.isCamera) warns.push('<span class="error">Camera VMD on character slot</span>');

      const armCount = Object.keys(validation.armExtremes).length;
      if (armCount) {
        warns.push(`<span class="error">${armCount} arm angle${armCount > 1 ? 's' : ''} >120°</span>`);
        console.log('[debug] Arm peaks:', Object.entries(validation.armExtremes)
          .map(([bone, v]) => `${bone} ${v.peakAngle}°`).join(', '));
      }
      if (dropped.length) {
        const cls = dropped.length > 5 ? 'error' : 'warn';
        warns.push(`<span class="${cls}">${dropped.length} bone${dropped.length > 1 ? 's' : ''} missing</span>`);
        console.log('[debug] Missing bones:', dropped.join(', '));
      }
      if (validation.morphMatch?.missing?.length) {
        const n = validation.morphMatch.missing.length;
        warns.push(`<span class="warn">${n} morph${n > 1 ? 's' : ''} not in PMX</span>`);
        console.log('[debug] Missing morphs:', validation.morphMatch.missing.join(', '));
      }
      if (validation.semiStdCoverage?.missing.length) {
        warns.push(`<span class="warn">${validation.semiStdCoverage.missing.length} semi-std missing</span>`);
        console.log('[debug] Semi-std missing:', validation.semiStdCoverage.missing.join(', '));
      }
      if (validation.zenoyaPosition) warns.push('<span class="warn">root position keys</span>');
      if (validation.translationWarns?.length) {
        warns.push(`<span class="warn">${validation.translationWarns.length} large translation${validation.translationWarns.length > 1 ? 's' : ''}</span>`);
      }
      if (warns.length) lines.push(warns.join(' · '));
    }

    // ── Section 4: FX Precompute ──
    if (fxInfo) {
      const parts = [];
      parts.push(`${fxInfo.sparkCount} spark`);
      const footCls = fxInfo.footCount === 0 ? 'warn' : 'detail';
      parts.push(`<span class="${footCls}">${fxInfo.footCount} ripple</span>`);
      if (fxInfo.footEvents?.length) {
        const first = fxInfo.footEvents[0].time.toFixed(1);
        const last = fxInfo.footEvents[fxInfo.footEvents.length - 1].time.toFixed(1);
        parts.push(`<span class="meta">${first}s~${last}s</span>`);
      }
      lines.push(`<span class="meta">FX</span>  ${parts.join(' · ')}`);

      // Per-foot diagnostics
      if (fxInfo.footDiag?.length) {
        for (const d of fxInfo.footDiag) {
          const cls = d.events === 0 ? 'warn' : 'detail';
          lines.push(`<span class="meta">${d.bone}</span>  <span class="${cls}">${d.events} hits</span> · <span class="meta">ground=${d.groundY} thr=${d.threshold} Y=${d.yRange[0]}~${d.yRange[1]}</span>`);
        }
      }
    }

    // Console-only details
    if (sizing) {
      const sign = sizing.ikFloorDelta >= 0 ? '+' : '';
      console.log(`[debug] Sizing: ×${sizing.legRatio.toFixed(2)} IK${sign}${sizing.ikFloorDelta.toFixed(2)}`);
    }
    if (retarget?.applied.length) console.log('[debug] Retarget:', retarget.applied.join(', '));

    el.innerHTML = lines.length ? lines.join('<br>') : '';
  }

  // --- Debug Paths (renders path-only until validation overwrites) ---

  _updateDebugPaths() {
    const el = document.getElementById('debug-info');
    const lines = [];
    if (this._vmdPath) {
      const parts = this._vmdPath.split('/');
      const name = parts.length >= 2 ? parts[parts.length - 2] : parts[parts.length - 1];
      lines.push(`<span class="meta">VMD</span>  ${name}`);
    }
    if (this._pmxPath) {
      const basename = this._pmxPath.replace(/^.*\//, '').replace(/\.pmx$/i, '');
      lines.push(`<span class="meta">PMX</span>  ${basename}`);
    }
    el.innerHTML = lines.join('<br>');
  }

  // --- Playback Controls (Play/Pause toggle) ---

  _initPlayback() {
    const sig = { signal: this._ac.signal };
    const btn = document.getElementById('btn-playpause');
    const muteBtn = document.getElementById('btn-mute');
    const volumeEl = document.getElementById('volume');

    // Start muted — slider stays at 0.5 but audio is silent
    // Use audioElement.muted (not volume=0) so browser allows autoplay
    this._muted = true;
    this._prevVolume = parseFloat(volumeEl.value);
    this.audio.setMuted(true);
    this._updateMuteButton();

    btn.addEventListener('click', () => {
      // Dismiss play overlay if visible
      const overlay = document.getElementById('play-overlay');
      if (!overlay.classList.contains('hidden')) {
        overlay.classList.remove('loading', 'ready');
        overlay.classList.add('hidden');
      }
      if (this.audio.audioElement && !this.audio.audioElement.paused) {
        this.animation.playing = false;
        this.audio.pause();
        this._updatePlayPauseButton(false);
      } else {
        this.animation.playing = true;
        this.audio.play();
        this._updatePlayPauseButton(true);
      }
    }, sig);

    muteBtn.addEventListener('click', () => {
      this._muted = !this._muted;
      this.audio.setMuted(this._muted);
      if (!this._muted) {
        this.audio.setVolume(parseFloat(volumeEl.value));
      }
      this._updateMuteButton();
    }, sig);

    volumeEl.addEventListener('input', () => {
      const v = parseFloat(volumeEl.value);
      if (!this._muted) {
        this.audio.setVolume(v);
      }
      if (v > 0) this._prevVolume = v;
    }, sig);

    document.getElementById('btn-prev').addEventListener('click', () => {
      this._playPrevSample();
    }, sig);

    document.getElementById('btn-next').addEventListener('click', () => {
      this._playNextSample();
    }, sig);
  }

  _updateMuteButton() {
    const btn = document.getElementById('btn-mute');
    btn.innerHTML = `<span class="material-symbols-rounded">${this._muted ? 'volume_off' : 'volume_up'}</span>`;
    btn.setAttribute('aria-label', this._muted ? 'Unmute' : 'Mute');
    btn.classList.toggle('active', !this._muted);
  }

  _updatePlayPauseButton(isPlaying) {
    const btn = document.getElementById('btn-playpause');
    btn.innerHTML = `<span class="material-symbols-rounded">${isPlaying ? 'pause' : 'play_arrow'}</span>`;
    btn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  }

  // --- Timeline Scrubber ---

  _initTimeline() {
    this._tlTrack = document.getElementById('timeline');
    this._tlFill = document.getElementById('tl-fill');
    this._tlThumb = document.getElementById('tl-thumb');
    this._tlCurrent = document.getElementById('tl-current');
    this._tlTotal = document.getElementById('tl-total');
    this._tlDragging = false;
    this._tlWasPlaying = false;

    const FPS = 30;
    const sig = { signal: this._ac.signal };

    const seekFromEvent = (e) => {
      const rect = this._tlTrack.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, x / rect.width));
      const duration = this.audio.duration;
      if (duration <= 0) return;
      const time = Math.round(ratio * duration * FPS) / FPS;
      this.animation.seekTo(time);
      this.audio.seekTo(time);
      this.riseFx.seekTo(time);
      this.rippleFx.seekTo(time);
      this._updateTimelineDisplay(time, duration);
    };

    const onStart = (e) => {
      this._tlDragging = true;
      this._tlWasPlaying = this.animation.playing;
      if (this._tlWasPlaying) {
        this.animation.playing = false;
        this.audio.pause();
      }
      this._tlTrack.classList.add('dragging');
      this._tlTrack.setPointerCapture(e.pointerId);
      seekFromEvent(e);
    };

    const onMove = (e) => {
      if (!this._tlDragging) return;
      seekFromEvent(e);
    };

    const onEnd = (e) => {
      if (!this._tlDragging) return;
      this._tlDragging = false;
      this._tlTrack.classList.remove('dragging');
      this._tlTrack.releasePointerCapture(e.pointerId);
      if (this._tlWasPlaying) {
        this.animation.playing = true;
        this.audio.play();
      }
    };

    this._tlTrack.addEventListener('pointerdown', onStart, sig);
    this._tlTrack.addEventListener('pointermove', onMove, sig);
    this._tlTrack.addEventListener('pointerup', onEnd, sig);
    this._tlTrack.addEventListener('lostpointercapture', onEnd, sig);

    // Continuous update loop
    const updateLoop = () => {
      if (!this._tlDragging) {
        const duration = this.audio.duration;
        const time = this.audio.currentTime;
        this._updateTimelineDisplay(time, duration);
      }
      this._tlRAF = requestAnimationFrame(updateLoop);
    };
    this._tlRAF = requestAnimationFrame(updateLoop);
  }

  _updateTimelineDisplay(time, duration) {
    const ratio = duration > 0 ? time / duration : 0;
    this._tlFill.style.transform = `scaleX(${ratio})`;
    this._tlThumb.style.left = (ratio * 100) + '%';
    this._tlCurrent.textContent = this._formatTime(time);
    this._tlTotal.textContent = this._formatTime(duration);
  }

  _formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const f = Math.floor((seconds % 1) * 30);
    return `${m}:${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
  }

  _initFxSelectors() {
    const sig = { signal: this._ac.signal };

    // Tab switching (VFX / PP) — skip master toggle
    for (const tab of document.querySelectorAll('.fx-tab[data-tab]')) {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.fx-tab[data-tab]').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.fx-tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      }, sig);
    }

    // Master toggle checkboxes
    const setupMasterToggle = (masterChkId, containerId, onToggle) => {
      const masterChk = document.getElementById(masterChkId);
      let saved = null;
      masterChk.addEventListener('change', () => {
        const chks = document.querySelectorAll(`#${containerId} .fx-section input[type="checkbox"]`);
        if (!masterChk.checked) {
          saved = new Map();
          for (const chk of chks) {
            saved.set(chk.id, chk.checked);
            if (chk.checked) { chk.checked = false; chk.dispatchEvent(new Event('change')); }
          }
          onToggle?.(false);
        } else {
          if (saved) {
            for (const chk of chks) {
              const was = saved.get(chk.id) ?? false;
              if (chk.checked !== was) { chk.checked = was; chk.dispatchEvent(new Event('change')); }
            }
            saved = null;
          }
          onToggle?.(true);
        }
      }, sig);
    };
    setupMasterToggle('chk-vfx-all', 'tab-vfx');
    const tmRow = document.getElementById('pp-tonemapping-row');
    const ppSections = document.getElementById('pp-sections');
    const ppHighEls = ppSections.querySelectorAll('.pp-high');
    const selPpLevel = document.getElementById('sel-pp-level');

    const applyPpLevel = async (level) => {
      const ppOn = level !== 'off';
      await this.mmdScene.setPostProcessEnabled(ppOn);
      if (ppOn && !this.postProcess) {
        this.postProcess = this.mmdScene._postProcess;
        this._wirePpControls();
      }
      if (this.postProcess) this.postProcess.setLevel(level === 'off' ? 'low' : level);
      tmRow.style.display = ppOn ? 'none' : '';
      ppSections.style.display = ppOn ? '' : 'none';
      // High-cost sections: bloom, CA, grain
      for (const el of ppHighEls) {
        el.style.display = level === 'high' ? '' : 'none';
      }
      // Disable high-cost effects when switching to low
      if (this.postProcess && level !== 'high') {
        this.postProcess.setBloomEnabled(false);
        this.postProcess.setCaEnabled(false);
        this.postProcess.setGrainEnabled(false);
        document.getElementById('chk-bloom').checked = false;
        document.getElementById('chk-ca').checked = false;
        document.getElementById('chk-grain').checked = false;
      }
    };

    selPpLevel.addEventListener('change', () => applyPpLevel(selPpLevel.value), sig);

    // Tone mapping dropdown (applies when PP is off)
    document.getElementById('sel-tonemapping').addEventListener('change', (e) => {
      this.mmdScene.setToneMapping(e.target.value);
    }, sig);

    // Toggle checkbox → effect enabled (section always visible)
    const fxMap = [
      { chk: 'chk-rise', fx: this.riseFx },
      { chk: 'chk-fall', fx: this.fallFx },
      { chk: 'chk-ripple', fx: this.rippleFx },
      { chk: 'chk-mirror', fx: this.mirrorFx },
    ];
    for (const { chk, fx } of fxMap) {
      document.getElementById(chk).addEventListener('change', (e) => {
        fx.enabled = e.target.checked;
      }, sig);
    }

    // Edge outline toggle
    document.getElementById('chk-edge').addEventListener('change', (e) => {
      this.loader.edgeVisible = e.target.checked;
      if (this.loader.outlineMesh) this.loader.outlineMesh.visible = e.target.checked;
    }, sig);

    // Edge thickness scale
    const getOutlineMats = () => {
      const om = this.loader.outlineMesh;
      if (!om) return [];
      return om.userData.outlineMaterials || [];
    };
    const setEdgeScale = (v) => {
      for (const m of getOutlineMats()) {
        if (m.userData.edgeScale) m.userData.edgeScale.value = v;
      }
    };
    const rngEdge = document.getElementById('rng-edge-scale');
    const valEdge = document.getElementById('val-edge-scale');
    rngEdge.addEventListener('input', () => { valEdge.value = rngEdge.value; setEdgeScale(parseFloat(rngEdge.value)); }, sig);
    valEdge.addEventListener('change', () => {
      let v = Math.max(0, Math.min(20, parseFloat(valEdge.value) || 0));
      valEdge.value = v; rngEdge.value = v; setEdgeScale(v);
    }, sig);

    // Outline color override (only when checkbox is checked)
    const chkEdgeColor = document.getElementById('chk-edge-color');
    const clrEdge = document.getElementById('clr-edge');
    const applyEdgeColor = () => {
      if (!chkEdgeColor.checked) {
        // Restore original PMX colors
        for (const m of getOutlineMats()) {
          if (m.userData.edgeColor && m.userData.edgeOriginalColor) {
            const c = m.userData.edgeOriginalColor;
            m.userData.edgeColor.value.setRGB(c.r, c.g, c.b);
          }
        }
        return;
      }
      const hex = clrEdge.value;
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      for (const m of getOutlineMats()) {
        if (m.userData.edgeColor) m.userData.edgeColor.value.setRGB(r, g, b);
      }
    };
    chkEdgeColor.addEventListener('change', applyEdgeColor, sig);
    clrEdge.addEventListener('input', () => {
      if (chkEdgeColor.checked) applyEdgeColor();
    }, sig);

    // Material Fresnel rim light
    const rim = this.loader.rimUniforms;
    let savedRimIntensity = 0.8;
    document.getElementById('chk-rim-mat').addEventListener('change', (e) => {
      if (e.target.checked) {
        rim.intensity.value = savedRimIntensity;
        document.getElementById('rng-rim-mat-intensity').value = savedRimIntensity;
        document.getElementById('val-rim-mat-intensity').value = savedRimIntensity.toFixed(2);
      } else {
        rim.intensity.value = 0;
      }
    }, sig);
    const wireRimSlider = (rngId, valId, setter) => {
      const rng = document.getElementById(rngId);
      const val = document.getElementById(valId);
      rng.addEventListener('input', () => { const v = parseFloat(rng.value); val.value = v; setter(v); }, sig);
      val.addEventListener('change', () => {
        let v = parseFloat(val.value) || parseFloat(rng.min);
        v = Math.max(parseFloat(rng.min), Math.min(parseFloat(rng.max), v));
        val.value = v; rng.value = v; setter(v);
      }, sig);
    };
    wireRimSlider('rng-rim-mat-intensity', 'val-rim-mat-intensity', (v) => { rim.intensity.value = v; savedRimIntensity = v; });
    wireRimSlider('rng-rim-mat-threshold', 'val-rim-mat-threshold', (v) => { rim.threshold.value = v; });
    document.getElementById('clr-rim-mat').addEventListener('input', (e) => {
      rim.color.value.setHex(parseInt(e.target.value.slice(1), 16));
    }, sig);

    // FOV Fix — adjust camera FOV (lower = more orthographic-like)
    // Compensate distance so apparent size stays constant: d * tan(fov/2) = const
    const camera = this.mmdScene.camera;
    const controls = this.mmdScene.controls;
    const baseFov = 45;
    const baseHalfTan = Math.tan((baseFov / 2) * Math.PI / 180);
    let baseDistance = camera.position.distanceTo(controls.target);
    const setFov = (v) => {
      const newHalfTan = Math.tan((v / 2) * Math.PI / 180);
      const newDist = baseDistance * baseHalfTan / newHalfTan;
      const dir = camera.position.clone().sub(controls.target).normalize();
      camera.position.copy(controls.target).addScaledVector(dir, newDist);
      camera.fov = v;
      camera.far = Math.max(200, newDist + 200);
      camera.updateProjectionMatrix();
      controls.update();
    };
    const rngFov = document.getElementById('rng-fov-fix');
    const valFov = document.getElementById('val-fov-fix');
    rngFov.addEventListener('input', () => { valFov.value = rngFov.value; setFov(parseFloat(rngFov.value)); }, sig);
    valFov.addEventListener('change', () => {
      let v = Math.max(10, Math.min(45, parseFloat(valFov.value) || 45));
      valFov.value = v; rngFov.value = v; setFov(v);
    }, sig);
    // Apply default FOV from slider
    setFov(parseFloat(rngFov.value));

    // Wire slider ↔ number input pairs
    const wireSlider = (rngId, valId, setter) => {
      const rng = document.getElementById(rngId);
      const val = document.getElementById(valId);
      rng.addEventListener('input', () => {
        const v = parseFloat(rng.value);
        val.value = v;
        setter(v);
      }, sig);
      val.addEventListener('change', () => {
        let v = parseFloat(val.value) || parseFloat(rng.min);
        v = Math.max(parseFloat(rng.min), Math.min(parseFloat(rng.max), v));
        val.value = v;
        rng.value = v;
        setter(v);
      }, sig);
    };

    // Rise
    wireSlider('rng-rise-speed', 'val-rise-speed', (v) => { this.riseFx.speed = v; });
    wireSlider('rng-rise-wind', 'val-rise-wind', (v) => { this.riseFx.wind = v; });
    wireSlider('rng-rise-size', 'val-rise-size', (v) => { this.riseFx.size = v; });
    wireSlider('rng-rise-life', 'val-rise-life', (v) => { this.riseFx.life = v; });
    wireSlider('rng-rise-radius', 'val-rise-radius', (v) => { this.riseFx.radius = v; });
    wireSlider('rng-rise-count', 'val-rise-count', (v) => { this.riseFx.count = v; });

    // Fall
    wireSlider('rng-fall-speed', 'val-fall-speed', (v) => { this.fallFx.speed = v; });
    wireSlider('rng-fall-size', 'val-fall-size', (v) => { this.fallFx.size = v; });

    // Ripple
    wireSlider('rng-ripple-radius', 'val-ripple-radius', (v) => { this.rippleFx.radius = v; });
    wireSlider('rng-ripple-life', 'val-ripple-life', (v) => { this.rippleFx.life = v; });

    // Mirror
    wireSlider('rng-mirror-strength', 'val-mirror-strength', (v) => { this.mirrorFx.strength = v / 100; });

    // PP slider/checkbox wiring deferred to _wirePpControls()

    // SVG icon markup
    const copySvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="12" height="12" fill="currentColor"><path d="M360-240q-33 0-56.5-23.5T280-320v-480q0-33 23.5-56.5T360-880h360q33 0 56.5 23.5T800-800v480q0 33-23.5 56.5T720-240H360Zm0-80h360v-480H360v480ZM200-80q-33 0-56.5-23.5T120-160v-560h80v560h440v80H200Zm160-240v-480 480Z"/></svg>';
    const checkSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="12" height="12" fill="currentColor"><path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z"/></svg>';

    const flashCopied = (btn) => {
      btn.classList.add('copied');
      btn.innerHTML = checkSvg;
      setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = copySvg; }, 1200);
    };

    // FX param getters & setters
    const fxChkMap = { rise: 'chk-rise', fall: 'chk-fall', ripple: 'chk-ripple', mirror: 'chk-mirror' };
    const fxParams = {
      rise: () => ({ enabled: document.getElementById('chk-rise').checked, speed: this.riseFx.speed, wind: this.riseFx.wind, size: this.riseFx.size, life: this.riseFx.life, radius: this.riseFx.radius, count: this.riseFx.count }),
      fall: () => ({ enabled: document.getElementById('chk-fall').checked, speed: this.fallFx.speed, size: this.fallFx.size }),
      ripple: () => ({ enabled: document.getElementById('chk-ripple').checked, radius: this.rippleFx.radius, life: this.rippleFx.life }),
      mirror: () => ({ enabled: document.getElementById('chk-mirror').checked, strength: this.mirrorFx.strength }),
    };

    const sliderMap = {
      rise:   { speed: ['rng-rise-speed', 'val-rise-speed', (v) => { this.riseFx.speed = v; }],
                wind:  ['rng-rise-wind', 'val-rise-wind', (v) => { this.riseFx.wind = v; }],
                size:  ['rng-rise-size', 'val-rise-size', (v) => { this.riseFx.size = v; }],
                life:  ['rng-rise-life', 'val-rise-life', (v) => { this.riseFx.life = v; }],
                radius: ['rng-rise-radius', 'val-rise-radius', (v) => { this.riseFx.radius = v; }],
                count: ['rng-rise-count', 'val-rise-count', (v) => { this.riseFx.count = v; }] },
      fall:   { speed: ['rng-fall-speed', 'val-fall-speed', (v) => { this.fallFx.speed = v; }],
                size:  ['rng-fall-size', 'val-fall-size', (v) => { this.fallFx.size = v; }] },
      ripple: { radius: ['rng-ripple-radius', 'val-ripple-radius', (v) => { this.rippleFx.radius = v; }],
                life:   ['rng-ripple-life', 'val-ripple-life', (v) => { this.rippleFx.life = v; }] },
      mirror: { strength: ['rng-mirror-strength', 'val-mirror-strength', (v) => { this.mirrorFx.strength = v / 100; }] },
    };

    const applyFxValues = (section, data) => {
      const map = sliderMap[section];
      if (!map) return false;
      let applied = false;
      if (data.enabled != null && fxChkMap[section]) {
        const chk = document.getElementById(fxChkMap[section]);
        if (chk.checked !== data.enabled) { chk.checked = data.enabled; chk.dispatchEvent(new Event('change')); }
        applied = true;
      }
      for (const [key, [rngId, valId, setter]] of Object.entries(map)) {
        const v = data[key];
        if (v == null) continue;
        const rng = document.getElementById(rngId);
        const val = document.getElementById(valId);
        rng.value = v;
        val.value = v;
        setter(v);
        applied = true;
      }
      return applied;
    };

    // Per-section copy buttons (VFX)
    for (const btn of document.querySelectorAll('.fx-copy[data-fx]')) {
      btn.addEventListener('click', async () => {
        const data = fxParams[btn.dataset.fx]();
        await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
        flashCopied(btn);
      }, sig);
    }

    // Copy all FX
    document.getElementById('fx-copy-all')?.addEventListener('click', async () => {
      const all = {};
      for (const [key, getter] of Object.entries(fxParams)) all[key] = getter();
      await navigator.clipboard.writeText(JSON.stringify(all, null, 2));
      this._showToast('FX copied');
      flashCopied(document.getElementById('fx-copy-all'));
    }, sig);

    // Paste all FX
    document.getElementById('fx-paste-all')?.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        const data = JSON.parse(text);
        let applied = false;
        for (const [section, values] of Object.entries(data)) {
          if (typeof values === 'object' && sliderMap[section]) {
            applyFxValues(section, values);
            applied = true;
          }
        }
        if (!applied) {
          for (const section of Object.keys(sliderMap)) {
            if (applyFxValues(section, data)) { applied = true; break; }
          }
        }
        this._showToast(applied ? 'FX pasted' : 'No matching FX data');
      } catch {
        this._showToast('Paste failed — invalid JSON or clipboard denied');
      }
    }, sig);

    // PP copy/paste — works even before PP is initialized (reads checkbox/slider DOM values)
    const ppChkMap = { bloom: 'chk-bloom', vignette: 'chk-vignette', aces: 'chk-aces', temp: 'chk-temp', ca: 'chk-ca', bw: 'chk-bw', grain: 'chk-grain', saturation: 'chk-saturation', contrast: 'chk-contrast' };

    const ppSliderIds = {
      bloom: { strength: ['rng-bloom-strength', 'val-bloom-strength'], radius: ['rng-bloom-radius', 'val-bloom-radius'], threshold: ['rng-bloom-threshold', 'val-bloom-threshold'] },
      vignette: { intensity: ['rng-vignette-intensity', 'val-vignette-intensity'] },
      aces: { exposure: ['rng-aces-exposure', 'val-aces-exposure'] },
      temp: { value: ['rng-temp', 'val-temp'] },
      ca: { intensity: ['rng-ca-intensity', 'val-ca-intensity'] },
      bw: { mix: ['rng-bw-mix', 'val-bw-mix'] },
      grain: { amount: ['rng-grain-amount', 'val-grain-amount'] },
      saturation: { value: ['rng-saturation', 'val-saturation'] },
      contrast: { contrast: ['rng-contrast', 'val-contrast'], brightness: ['rng-brightness', 'val-brightness'] },
    };

    const getPpParams = () => {
      const all = {};
      for (const [section, sliders] of Object.entries(ppSliderIds)) {
        const obj = { enabled: document.getElementById(ppChkMap[section]).checked };
        for (const [key, [rngId]] of Object.entries(sliders)) {
          obj[key] = parseFloat(document.getElementById(rngId).value);
        }
        all[section] = obj;
      }
      all.toneMapping = document.getElementById('sel-tonemapping').value;
      all.ppLevel = document.getElementById('sel-pp-level').value;
      return all;
    };

    const applyPpValues = (section, data) => {
      const ids = ppSliderIds[section];
      if (!ids) return false;
      let applied = false;
      if (data.enabled != null && ppChkMap[section]) {
        const chk = document.getElementById(ppChkMap[section]);
        if (chk.checked !== data.enabled) { chk.checked = data.enabled; chk.dispatchEvent(new Event('change')); }
        applied = true;
      }
      for (const [key, [rngId, valId]] of Object.entries(ids)) {
        const v = data[key];
        if (v == null) continue;
        const rng = document.getElementById(rngId);
        const val = document.getElementById(valId);
        rng.value = v;
        val.value = v;
        rng.dispatchEvent(new Event('input'));
        applied = true;
      }
      return applied;
    };

    // Per-section copy buttons (PP)
    for (const btn of document.querySelectorAll('.fx-copy[data-pp]')) {
      btn.addEventListener('click', async () => {
        const all = getPpParams();
        const data = all[btn.dataset.pp];
        await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
        flashCopied(btn);
      }, sig);
    }

    // Copy all PP
    document.getElementById('pp-copy-all')?.addEventListener('click', async () => {
      const all = getPpParams();
      await navigator.clipboard.writeText(JSON.stringify(all, null, 2));
      this._showToast('PP copied');
      flashCopied(document.getElementById('pp-copy-all'));
    }, sig);

    // Paste all PP
    document.getElementById('pp-paste-all')?.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        const data = JSON.parse(text);
        let applied = false;
        for (const [section, values] of Object.entries(data)) {
          if (typeof values === 'object' && ppSliderIds[section]) {
            applyPpValues(section, values);
            applied = true;
          }
        }
        if (!applied) {
          for (const section of Object.keys(ppSliderIds)) {
            if (applyPpValues(section, data)) { applied = true; break; }
          }
        }
        if (data.toneMapping) {
          const sel = document.getElementById('sel-tonemapping');
          sel.value = data.toneMapping;
          sel.dispatchEvent(new Event('change'));
        }
        if (data.ppLevel) {
          const sel = document.getElementById('sel-pp-level');
          sel.value = data.ppLevel;
          sel.dispatchEvent(new Event('change'));
        } else if (data.ppOff != null) {
          // Backward compat with old format
          const sel = document.getElementById('sel-pp-level');
          sel.value = data.ppOff ? 'off' : 'low';
          sel.dispatchEvent(new Event('change'));
        }
        this._showToast(applied ? 'PP pasted' : 'No matching PP data');
      } catch {
        this._showToast('Paste failed — invalid JSON or clipboard denied');
      }
    }, sig);
  }

  _wirePpControls() {
    if (this._ppWired) return;
    this._ppWired = true;
    const pp = this.postProcess;
    const sig = { signal: this._ac.signal };

    const wireSlider = (rngId, valId, setter) => {
      const rng = document.getElementById(rngId);
      const val = document.getElementById(valId);
      rng.addEventListener('input', () => {
        const v = parseFloat(rng.value);
        val.value = v;
        setter(v);
      }, sig);
      val.addEventListener('change', () => {
        let v = parseFloat(val.value) || parseFloat(rng.min);
        v = Math.max(parseFloat(rng.min), Math.min(parseFloat(rng.max), v));
        val.value = v;
        rng.value = v;
        setter(v);
      }, sig);
    };

    const ppMap = [
      { chk: 'chk-bloom', toggle: (on) => pp.setBloomEnabled(on) },
      { chk: 'chk-vignette', toggle: (on) => pp.setVignetteEnabled(on) },
      { chk: 'chk-aces', toggle: (on) => pp.setAcesEnabled(on) },
      { chk: 'chk-temp', toggle: (on) => pp.setTempEnabled(on) },
      { chk: 'chk-ca', toggle: (on) => pp.setCaEnabled(on) },
      { chk: 'chk-grain', toggle: (on) => pp.setGrainEnabled(on) },
      { chk: 'chk-bw', toggle: (on) => {
        pp.setBwEnabled(on);
        if (on) {
          document.getElementById('rng-bw-mix').value = pp.bwMix.value;
          document.getElementById('val-bw-mix').value = pp.bwMix.value.toFixed(2);
        }
      }},
      { chk: 'chk-saturation', toggle: (on) => pp.setSaturationEnabled(on) },
      { chk: 'chk-contrast', toggle: (on) => pp.setContrastEnabled(on) },
    ];
    for (const { chk, toggle } of ppMap) {
      document.getElementById(chk).addEventListener('change', (e) => {
        toggle(e.target.checked);
      }, sig);
    }

    wireSlider('rng-bloom-strength', 'val-bloom-strength', (v) => { pp.bloomStrength.value = v; pp._saved.bloomStrength = v; });
    wireSlider('rng-bloom-radius', 'val-bloom-radius', (v) => { pp.bloomRadius.value = v; });
    wireSlider('rng-bloom-threshold', 'val-bloom-threshold', (v) => { pp.bloomThreshold.value = v; });
    wireSlider('rng-vignette-intensity', 'val-vignette-intensity', (v) => { pp.vignetteIntensity.value = v; pp._saved.vignetteIntensity = v; });
    wireSlider('rng-aces-exposure', 'val-aces-exposure', (v) => { pp.acesExposure.value = v; });
    wireSlider('rng-temp', 'val-temp', (v) => { pp.temperature.value = v; pp._saved.temperature = v; });
    wireSlider('rng-ca-intensity', 'val-ca-intensity', (v) => { pp.caIntensity.value = v; pp._saved.caIntensity = v; });
    wireSlider('rng-grain-amount', 'val-grain-amount', (v) => { pp.grainAmount.value = v; pp._saved.grainAmount = v; });
    wireSlider('rng-bw-mix', 'val-bw-mix', (v) => { pp.bwMix.value = v; pp._saved.bwMix = v; });
    wireSlider('rng-saturation', 'val-saturation', (v) => { pp.saturation.value = v; pp._saved.saturation = v; });
    wireSlider('rng-contrast', 'val-contrast', (v) => { pp.contrast.value = v; pp._saved.contrast = v; });
    wireSlider('rng-brightness', 'val-brightness', (v) => { pp.brightness.value = v; pp._saved.brightness = v; });
  }

  _startPlaybackPoll() {
    const tryPlay = () => {
      if (!this.audio.audioElement) return;
      this.audio.audioElement.play().catch(() => {});
      // Check if audio actually started (paused === false)
      setTimeout(() => {
        if (this.audio.audioElement && !this.audio.audioElement.paused) {
          clearInterval(this._playPollId);
          this._playPollId = null;
          this.animation.playing = true;
          this.loader.reveal().then(() => {
            this._hideLoading();
            this._updatePlayPauseButton(true);
          });
        }
      }, 100);
    };
    tryPlay();
    this._playPollId = setInterval(tryPlay, 1000);
  }

  _showPlayOverlay() {
    const overlay = document.getElementById('play-overlay');
    overlay.classList.remove('hidden', 'loading');
    overlay.classList.add('ready');
    this.riseFx.staggerStart(5);
    this.riseFx.enabled = document.getElementById('chk-rise').checked;
    this.fallFx.enabled = document.getElementById('chk-fall').checked;
    this.rippleFx.enabled = document.getElementById('chk-ripple').checked;
    this.mirrorFx.enabled = document.getElementById('chk-mirror').checked;
    const label = overlay.querySelector('.play-label');
    const songSelect = document.getElementById('select-song');
    const song = this._sampleSongs.find(s => s.vmd === songSelect?.value);
    if (label) label.textContent = song?.name || 'Ready';
    overlay.addEventListener('click', () => {
      overlay.classList.remove('ready');
      overlay.classList.add('dismissing');
      setTimeout(() => {
        overlay.classList.remove('dismissing');
        overlay.classList.add('hidden');
        this.animation.playing = true;
        this._updatePlayPauseButton(true);
        if (this.audio.audioElement) {
          this.audio.play();
        }
      }, 300);
    }, { once: true });
  }

  _initTheaterMode() {
    const btn = document.getElementById('btn-theater');
    this._theaterTimer = null;
    this._theaterMouseHandler = null;

    btn.addEventListener('click', () => this._toggleTheater(), { signal: this._ac.signal });
  }

  _toggleTheater() {
    const body = document.body;
    const btn = document.getElementById('btn-theater');
    const entering = !body.classList.contains('theater-mode');

    if (entering) {
      body.classList.add('theater-mode');
      btn.classList.add('active');
      this._theaterMouseHandler = () => {
        body.classList.remove('auto-hidden');
        clearTimeout(this._theaterTimer);
        this._theaterTimer = setTimeout(() => body.classList.add('auto-hidden'), 3000);
      };
      document.addEventListener('mousemove', this._theaterMouseHandler, { signal: this._ac.signal });
      this._theaterTimer = setTimeout(() => body.classList.add('auto-hidden'), 3000);
    } else {
      body.classList.remove('theater-mode', 'auto-hidden');
      btn.classList.remove('active');
      clearTimeout(this._theaterTimer);
      if (this._theaterMouseHandler) {
        document.removeEventListener('mousemove', this._theaterMouseHandler);
        this._theaterMouseHandler = null;
      }
    }
  }

  _initHideUI() {
    document.getElementById('btn-hide-ui').addEventListener('click', () => {
      this._toggleUI();
    }, { signal: this._ac.signal });
  }

  _toggleUI() {
    document.body.classList.toggle('ui-hidden');
  }

  _showLoading(msg) {
    const overlay = document.getElementById('play-overlay');
    overlay.classList.remove('hidden', 'ready');
    overlay.classList.add('loading');
    const label = overlay.querySelector('.play-label');
    if (label) label.textContent = msg || 'Loading...';
  }

  _setLoadingText(msg) {
    const label = document.querySelector('#play-overlay .play-label');
    if (label) label.textContent = msg;
  }

  _setLoadingCounter(loaded, total) {
    const counter = document.querySelector('#play-overlay .play-counter');
    if (!counter) return;
    counter.textContent = total > 0 ? Math.round((loaded / total) * 100) + '%' : '';
    const progress = total > 0 ? loaded / total : 0;
    const ringFill = document.querySelector('#play-overlay .ring-fill');
    if (ringFill) {
      ringFill.style.strokeDashoffset = `${289 * (1 - progress)}`;
    }
  }

  _hideLoading() {
    const overlay = document.getElementById('play-overlay');
    overlay.classList.remove('loading');
    overlay.classList.add('hidden');
  }

  _showToast(message) {
    clearTimeout(this._toastTimer);
    let toast = document.getElementById('mmd-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'mmd-toast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('visible');
    this._toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
  }

  _playPrevSample() {
    if (!this._sampleSongs.length) return;
    this._sampleIndex = (this._sampleIndex - 1 + this._sampleSongs.length) % this._sampleSongs.length;
    const song = this._sampleSongs[this._sampleIndex];
    const songSelect = document.getElementById('select-song');
    songSelect.value = song.vmd;
    this._loadSampleSong(song);
  }

  _initKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          document.getElementById('btn-playpause').click();
          break;
        case 'KeyM':
          document.getElementById('btn-mute').click();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          this._seekRelative(-5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          this._seekRelative(5);
          break;
        case 'ArrowUp':
          e.preventDefault();
          this._adjustVolume(0.1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          this._adjustVolume(-0.1);
          break;
        case 'KeyN':
          this._playNextSample();
          break;
        case 'KeyP':
          this._playPrevSample();
          break;
        case 'KeyH':
          this._toggleUI();
          break;
        case 'KeyT':
          this._toggleTheater();
          break;
      }
    }, { signal: this._ac.signal });
  }

  _seekRelative(delta) {
    const time = Math.max(0, Math.min(this.audio.currentTime + delta, this.audio.duration));
    this.animation.seekTo(time);
    this.audio.seekTo(time);
    this.riseFx.seekTo(time);
    this.rippleFx.seekTo(time);
  }

  _adjustVolume(delta) {
    const el = document.getElementById('volume');
    const v = Math.max(0, Math.min(1, parseFloat(el.value) + delta));
    el.value = v;
    if (!this._muted) this.audio.setVolume(v);
    if (v > 0) this._prevVolume = v;
  }

  destroy() {
    this._ac.abort();
    if (this._tlRAF) cancelAnimationFrame(this._tlRAF);
  }
}
