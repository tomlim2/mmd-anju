// babylon-ui.js — UI controller for Babylon.js MMD player
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { VmdLoader } from 'babylon-mmd/esm/Loader/vmdLoader';

const FPS = 30;

export class BabylonUI {
  constructor(app, { log, materialBuilder }) {
    this._app = app;
    this._log = log;
    this._materialBuilder = materialBuilder;

    this._pmxManifest = [];
    this._vmdManifest = [];
    this._sampleIndex = 0;
    this._playing = false;
    this._muted = true;

    // Timeline state
    this._tlDragging = false;
    this._tlWasPlaying = false;
    this._autoNextLock = false;

    // Current VMD tracking (for reapply on PMX switch)
    this._currentVmdSource = null; // { type: 'sample', song } | { type: 'upload', index }

    // Upload state
    this._uploadedVmds = [];
    this._uploadedPmxs = [];

    // DOM refs
    this._els = {};
  }

  async init() {
    this._cacheEls();
    this._initPlayOverlay();
    this._initPlayback();
    this._initTimeline();
    this._initVolume();
    this._initUpload();
    this._initKeyboard();
    this._startTimelineLoop();

    await this._loadManifests();
    await this._loadDefaultModel();
  }

  // ── DOM cache ──

  _cacheEls() {
    const ids = [
      'select-song', 'select-pmx', 'btn-playpause', 'btn-mute', 'btn-prev', 'btn-next',
      'volume', 'timeline', 'tl-bar', 'tl-fill', 'tl-thumb', 'tl-current', 'tl-total',
      'play-overlay', 'loading-status', 'status', 'toast',
      'btn-upload-vmd', 'btn-upload-pmx', 'input-vmd', 'input-pmx',
    ];
    for (const id of ids) {
      this._els[id] = document.getElementById(id);
    }
  }

  // ── Manifests ──

  async _loadManifests() {
    try {
      const [pmxRes, vmdRes] = await Promise.all([
        fetch('samples/pmx/manifest.json'),
        fetch('samples/vmd/manifest.json'),
      ]);
      if (pmxRes.ok) this._pmxManifest = (await pmxRes.json()).filter(e => e.deployed !== false);
      if (vmdRes.ok) this._vmdManifest = (await vmdRes.json()).filter(e => e.deployed !== false);
    } catch (e) {
      console.warn('Manifest load failed:', e);
    }

    this._populatePmxSelect();
    this._populateVmdSelect();
  }

  _populatePmxSelect() {
    const sel = this._els['select-pmx'];
    sel.innerHTML = '';
    for (const entry of this._pmxManifest) {
      const opt = document.createElement('option');
      opt.value = JSON.stringify(entry);
      opt.textContent = entry.name;
      sel.appendChild(opt);
    }
    sel.disabled = this._pmxManifest.length <= 1;

    sel.addEventListener('change', async () => {
      if (!sel.value) return;
      // Handle uploaded PMX selection
      if (sel.value.startsWith('upload:')) {
        const name = sel.value.slice(7);
        const idx = this._uploadedPmxs.findIndex(p => p.name === name);
        if (idx >= 0) await this._loadUploadedPmx(idx);
        return;
      }
      const entry = JSON.parse(sel.value);
      const wasPlaying = this._playing;
      await this._loadPmx('samples/pmx/' + entry.path);
      await this._reapplyCurrentVmd();
      if (wasPlaying) {
        this._app.mmdRuntime.playAnimation();
        this._playing = true;
        this._updatePlayPauseBtn(true);
      }
    });
  }

  _populateVmdSelect() {
    const sel = this._els['select-song'];
    sel.innerHTML = '';
    for (const song of this._vmdManifest) {
      const opt = document.createElement('option');
      opt.value = song.vmd;
      opt.textContent = song.name;
      sel.appendChild(opt);
    }
    sel.disabled = this._vmdManifest.length <= 1;

    sel.addEventListener('change', async () => {
      if (!sel.value) return;
      // Handle uploaded VMD selection
      if (sel.value.startsWith('upload:')) {
        const name = sel.value.slice(7);
        const idx = this._uploadedVmds.findIndex(v => v.name === name);
        if (idx >= 0) await this._loadUploadedVmd(idx);
        return;
      }
      const song = this._vmdManifest.find(s => s.vmd === sel.value);
      if (!song) return;
      this._sampleIndex = this._vmdManifest.indexOf(song);
      await this._loadSampleVmd(song);
    });
  }

  // ── Model Loading ──

  async _loadDefaultModel() {
    const entry = this._pmxManifest.find(e => e.family === 'animasa') || this._pmxManifest[0];
    if (!entry) {
      this._log('No PMX model found');
      return;
    }

    this._log('Loading model...');
    const pmxPath = 'samples/pmx/' + entry.path;
    await this._loadPmx(pmxPath);

    // Load first VMD
    if (this._vmdManifest.length > 0) {
      this._sampleIndex = 0;
      this._els['select-song'].value = this._vmdManifest[0].vmd;
      await this._loadSampleVmd(this._vmdManifest[0]);
    }

    this._log('');
    this._els['status'].style.display = 'none';
  }

  async _loadPmx(pmxPath) {
    const { scene, mmdRuntime } = this._app;

    // Destroy existing model
    if (this._app.mmdModel) {
      mmdRuntime.destroyMmdModel(this._app.mmdModel);
      this._app.mmdModel = null;
    }

    // Remove old meshes
    const oldMeshes = scene.meshes.filter(m => m.metadata?.isMmdModel);
    for (const m of oldMeshes) m.dispose();

    this._setStatus('Loading model...');

    const pmxDir = pmxPath.substring(0, pmxPath.lastIndexOf('/') + 1);
    const pmxFile = pmxPath.substring(pmxPath.lastIndexOf('/') + 1);

    const result = await SceneLoader.ImportMeshAsync(undefined, pmxDir, pmxFile, scene);
    const mmdMesh = result.meshes[0];
    if (!mmdMesh) throw new Error('Failed to load mesh');

    mmdMesh.metadata = { ...mmdMesh.metadata, isMmdModel: true };

    // Tag child meshes too
    for (const child of result.meshes) {
      child.metadata = { ...child.metadata, isMmdModel: true };
    }

    this._app.mmdModel = mmdRuntime.createMmdModel(mmdMesh);
    this._setStatus('');
  }

  // ── VMD Loading ──

  async _loadSampleVmd(song) {
    const { scene, mmdRuntime } = this._app;
    const model = this._app.mmdModel;
    if (!model) return;

    this._setStatus('Loading motion...');

    const vmdPath = 'samples/vmd/' + song.vmd;
    const vmdLoader = new VmdLoader(scene);
    const vmdAnimation = await vmdLoader.loadAsync('motion', vmdPath);

    // Remove old animation
    this._clearAnimation();

    const handle = model.createRuntimeAnimation(vmdAnimation);
    model.setRuntimeAnimation(handle);

    // Set audio if available
    if (song.audio) {
      this._app.audioPlayer.source = 'samples/vmd/' + song.audio;
      await mmdRuntime.setAudioPlayer(this._app.audioPlayer);
    } else {
      await mmdRuntime.setAudioPlayer(null);
      // Set manual duration from manifest (in frames)
      if (song.duration) {
        mmdRuntime.setManualAnimationDuration(song.duration * FPS);
      }
    }

    this._currentVmdSource = { type: 'sample', song };
    this._setStatus('');
  }

  _clearAnimation() {
    const { mmdRuntime } = this._app;
    if (mmdRuntime.isAnimationPlaying) {
      mmdRuntime.pauseAnimation();
    }
    this._playing = false;
    this._updatePlayPauseBtn(false);
  }

  // ── Playback ──

  _initPlayOverlay() {
    const overlay = this._els['play-overlay'];
    overlay.addEventListener('click', () => {
      overlay.classList.add('hidden');
      this._startPlayback();
    });
  }

  _initPlayback() {
    this._els['btn-playpause'].addEventListener('click', () => this._togglePlayback());
    this._els['btn-prev'].addEventListener('click', () => this._prevTrack());
    this._els['btn-next'].addEventListener('click', () => this._nextTrack());
  }

  _startPlayback() {
    const { mmdRuntime, audioPlayer } = this._app;
    if (!this._app.mmdModel) return;

    // Unmute on first user interaction
    if (this._muted) {
      audioPlayer.unmute();
      this._muted = false;
      this._updateMuteBtn();
    }

    mmdRuntime.playAnimation();
    this._playing = true;
    this._updatePlayPauseBtn(true);
  }

  _togglePlayback() {
    const { mmdRuntime, audioPlayer } = this._app;
    // Dismiss overlay if visible
    const overlay = this._els['play-overlay'];
    if (!overlay.classList.contains('hidden')) {
      overlay.classList.add('hidden');
    }

    if (this._playing) {
      mmdRuntime.pauseAnimation();
      this._playing = false;
    } else {
      // Unmute on first play (same as overlay click)
      if (this._muted) {
        audioPlayer.unmute();
        this._muted = false;
        this._updateMuteBtn();
      }
      mmdRuntime.playAnimation();
      this._playing = true;
    }
    this._updatePlayPauseBtn(this._playing);
  }

  _updatePlayPauseBtn(isPlaying) {
    const btn = this._els['btn-playpause'];
    btn.innerHTML = `<span class="material-symbols-rounded">${isPlaying ? 'pause' : 'play_arrow'}</span>`;
    btn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  }

  async _nextTrack() {
    if (!this._vmdManifest.length) return;
    this._sampleIndex = (this._sampleIndex + 1) % this._vmdManifest.length;
    const song = this._vmdManifest[this._sampleIndex];
    this._els['select-song'].value = song.vmd;
    await this._loadSampleVmd(song);
    if (this._playing) this._app.mmdRuntime.playAnimation();
  }

  async _prevTrack() {
    if (!this._vmdManifest.length) return;
    this._sampleIndex = (this._sampleIndex - 1 + this._vmdManifest.length) % this._vmdManifest.length;
    const song = this._vmdManifest[this._sampleIndex];
    this._els['select-song'].value = song.vmd;
    await this._loadSampleVmd(song);
    if (this._playing) this._app.mmdRuntime.playAnimation();
  }

  // ── Timeline ──

  _initTimeline() {
    const tl = this._els['timeline'];

    const seekFromEvent = (e) => {
      const rect = tl.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const { mmdRuntime } = this._app;
      const durationFrames = mmdRuntime.animationFrameTimeDuration;
      if (durationFrames <= 0) return;
      const frameTime = Math.round(ratio * durationFrames);
      mmdRuntime.seekAnimation(frameTime, true);
    };

    tl.addEventListener('pointerdown', (e) => {
      this._tlDragging = true;
      this._tlWasPlaying = this._playing;
      if (this._playing) {
        this._app.mmdRuntime.pauseAnimation();
        this._playing = false;
      }
      tl.classList.add('dragging');
      tl.setPointerCapture(e.pointerId);
      seekFromEvent(e);
    });

    tl.addEventListener('pointermove', (e) => {
      if (!this._tlDragging) return;
      seekFromEvent(e);
    });

    const onEnd = (e) => {
      if (!this._tlDragging) return;
      this._tlDragging = false;
      tl.classList.remove('dragging');
      tl.releasePointerCapture(e.pointerId);
      if (this._tlWasPlaying) {
        this._app.mmdRuntime.playAnimation();
        this._playing = true;
        this._updatePlayPauseBtn(true);
      }
    };

    tl.addEventListener('pointerup', onEnd);
    tl.addEventListener('lostpointercapture', onEnd);
  }

  _startTimelineLoop() {
    const update = () => {
      if (!this._tlDragging) {
        const { mmdRuntime } = this._app;
        const currentSec = mmdRuntime.currentTime;       // seconds
        const durationSec = mmdRuntime.animationDuration; // seconds
        const ratio = durationSec > 0 ? currentSec / durationSec : 0;

        this._els['tl-fill'].style.transform = `scaleX(${ratio})`;
        this._els['tl-thumb'].style.left = (ratio * 100) + '%';
        this._els['tl-current'].textContent = this._fmtTime(currentSec);
        this._els['tl-total'].textContent = this._fmtTime(durationSec);

        // End detection (guarded to prevent rapid re-trigger)
        if (this._playing && !this._autoNextLock && durationSec > 0 && currentSec >= durationSec - 0.1) {
          this._autoNextLock = true;
          this._nextTrack().finally(() => { this._autoNextLock = false; });
        }
      }
      requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
  }

  // ── Volume ──

  _initVolume() {
    const { audioPlayer } = this._app;
    const volumeEl = this._els['volume'];
    const muteBtn = this._els['btn-mute'];

    muteBtn.addEventListener('click', async () => {
      if (this._muted) {
        const success = await audioPlayer.unmute();
        if (success) this._muted = false;
      } else {
        audioPlayer.mute();
        this._muted = true;
      }
      this._updateMuteBtn();
    });

    volumeEl.addEventListener('input', () => {
      audioPlayer.volume = parseFloat(volumeEl.value);
    });
  }

  _updateMuteBtn() {
    const btn = this._els['btn-mute'];
    btn.innerHTML = `<span class="material-symbols-rounded">${this._muted ? 'volume_off' : 'volume_up'}</span>`;
    btn.setAttribute('aria-label', this._muted ? 'Unmute' : 'Mute');
  }

  // ── Upload ──

  _initUpload() {
    const btnVmd = this._els['btn-upload-vmd'];
    const btnPmx = this._els['btn-upload-pmx'];
    const inputVmd = this._els['input-vmd'];
    const inputPmx = this._els['input-pmx'];

    btnVmd.addEventListener('click', () => inputVmd.click());
    btnPmx.addEventListener('click', () => inputPmx.click());

    inputVmd.addEventListener('change', (e) => this._handleVmdUpload(e.target.files));
    inputPmx.addEventListener('change', (e) => this._handlePmxUpload(e.target.files));
  }

  async _handleVmdUpload(fileList) {
    const files = Array.from(fileList);
    const vmds = files.filter(f => /\.vmd$/i.test(f.name));
    const audios = files.filter(f => /\.(mp3|ogg|m4a|wav)$/i.test(f.name));

    if (!vmds.length) {
      this._showToast('No .vmd files found');
      return;
    }

    this._uploadedVmds = vmds.map(vmdFile => {
      const stem = vmdFile.name.replace(/\.vmd$/i, '').toLowerCase();
      const audioFile = audios.find(a => {
        const aStem = a.name.replace(/\.(mp3|ogg|m4a|wav)$/i, '').toLowerCase();
        return aStem === stem;
      }) || audios[0] || null;
      return { name: vmdFile.name.replace(/\.vmd$/i, ''), file: vmdFile, audioFile };
    });

    const sel = this._els['select-song'];
    sel.innerHTML = '';
    for (const entry of this._uploadedVmds) {
      const o = document.createElement('option');
      o.value = 'upload:' + entry.name;
      o.textContent = entry.name;
      sel.appendChild(o);
    }
    sel.value = 'upload:' + this._uploadedVmds[0].name;
    sel.disabled = sel.options.length <= 1;

    this._els['btn-upload-vmd'].classList.add('uploaded');
    await this._loadUploadedVmd(0);
  }

  async _loadUploadedVmd(index) {
    const entry = this._uploadedVmds[index];
    if (!entry) return;

    const { scene, mmdRuntime } = this._app;
    const model = this._app.mmdModel;
    if (!model) return;

    this._setStatus('Loading uploaded VMD...');

    // Load VMD from file blob
    const buffer = await entry.file.arrayBuffer();
    const vmdLoader = new VmdLoader(scene);
    const vmdAnimation = await vmdLoader.loadAsync('motion', new Uint8Array(buffer));

    this._clearAnimation();

    const handle = model.createRuntimeAnimation(vmdAnimation);
    model.setRuntimeAnimation(handle);

    // Handle audio
    if (entry.audioFile) {
      const url = URL.createObjectURL(entry.audioFile);
      this._app.audioPlayer.source = url;
      await mmdRuntime.setAudioPlayer(this._app.audioPlayer);
    } else {
      await mmdRuntime.setAudioPlayer(null);
    }

    this._currentVmdSource = { type: 'upload', index };
    this._setStatus('');
    if (this._playing) mmdRuntime.playAnimation();
  }

  async _reapplyCurrentVmd() {
    const src = this._currentVmdSource;
    if (!src || !this._app.mmdModel) return;
    if (src.type === 'sample') {
      await this._loadSampleVmd(src.song);
    } else if (src.type === 'upload') {
      await this._loadUploadedVmd(src.index);
    }
  }

  async _handlePmxUpload(fileList) {
    const files = Array.from(fileList);
    const pmxFiles = files.filter(f => /\.pmx$/i.test(f.name));

    if (!pmxFiles.length) {
      this._showToast('No .pmx files found');
      return;
    }

    // Store all uploaded PMX files (with their sibling textures)
    this._uploadedPmxs = pmxFiles.map(f => ({
      name: f.name.replace(/\.pmx$/i, ''),
      file: f,
    }));

    // Populate PMX select
    const sel = this._els['select-pmx'];
    sel.innerHTML = '';
    for (const entry of this._uploadedPmxs) {
      const o = document.createElement('option');
      o.value = 'upload:' + entry.name;
      o.textContent = entry.name;
      sel.appendChild(o);
    }
    sel.value = 'upload:' + this._uploadedPmxs[0].name;
    sel.disabled = this._uploadedPmxs.length <= 1;

    this._els['btn-upload-pmx'].classList.add('uploaded');
    await this._loadUploadedPmx(0);
  }

  async _loadUploadedPmx(index) {
    const entry = this._uploadedPmxs[index];
    if (!entry) return;

    const { scene, mmdRuntime } = this._app;
    const wasPlaying = this._playing;

    // Destroy existing model
    if (this._app.mmdModel) {
      mmdRuntime.destroyMmdModel(this._app.mmdModel);
      this._app.mmdModel = null;
    }
    const oldMeshes = scene.meshes.filter(m => m.metadata?.isMmdModel);
    for (const m of oldMeshes) m.dispose();

    this._setStatus('Loading model...');

    try {
      const result = await SceneLoader.ImportMeshAsync(undefined, '', entry.file, scene);
      const mmdMesh = result.meshes[0];
      if (!mmdMesh) throw new Error('No mesh loaded');

      for (const child of result.meshes) {
        child.metadata = { ...child.metadata, isMmdModel: true };
      }

      this._app.mmdModel = mmdRuntime.createMmdModel(mmdMesh);
      this._setStatus('');

      // Reapply current VMD on the new model
      await this._reapplyCurrentVmd();
      if (wasPlaying) {
        mmdRuntime.playAnimation();
        this._playing = true;
        this._updatePlayPauseBtn(true);
      }
    } catch (err) {
      console.error('PMX upload error:', err);
      this._setStatus('Load failed');
      setTimeout(() => this._setStatus(''), 3000);
    }
  }

  // ── Keyboard ──

  _initKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          this._togglePlayback();
          break;
        case 'KeyM':
          this._els['btn-mute'].click();
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
      }
    });
  }

  _seekRelative(seconds) {
    const { mmdRuntime } = this._app;
    const durationFrames = mmdRuntime.animationFrameTimeDuration;
    const currentFrames = mmdRuntime.currentFrameTime;
    const target = Math.max(0, Math.min(durationFrames, currentFrames + seconds * FPS));
    mmdRuntime.seekAnimation(target, true);
  }

  _adjustVolume(delta) {
    const volumeEl = this._els['volume'];
    const newVal = Math.max(0, Math.min(1, parseFloat(volumeEl.value) + delta));
    volumeEl.value = newVal;
    this._app.audioPlayer.volume = newVal;
  }

  // ── Utils ──

  _setStatus(msg) {
    this._els['loading-status'].textContent = msg;
  }

  _fmtTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const f = Math.floor((seconds % 1) * FPS);
    return `${m}:${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
  }

  _showToast(msg) {
    const el = this._els['toast'];
    el.textContent = msg;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2000);
  }
}
