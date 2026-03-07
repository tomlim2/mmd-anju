import { MMDLoader } from '../vendor/MMDLoader.js';
import { hasHumanoidBones } from './pmx-check.js';
import { remapClipBones } from './bone-remap.js';
import { validateClip } from './vmd-validator.js';
import { retargetClip } from './bone-retarget.js';
import { extractVmdMeta } from './vmd-meta.js';
import { precomputeSparkEvents, precomputeFootEvents } from './effects/spark-precompute.js';
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
    this._ac = new AbortController();
    this._pmxPath = '';
    this._vmdPath = '';
    this._currentVmd = null;   // {vmdPath, audioPath} of currently playing song
    this._pendingVmd = null;   // VMD blob fetched before mesh is available

    this._initPmxSelect();
    this._initSampleMode();
    this._initPlayback();
    this._initTimeline();
    this._initFxSelectors();
    this._loadDefaultModel();

    this.audio.onEnded(() => this._playNextSample());
  }

  async _loadDefaultModel() {
    const path = 'samples/pmx/animasa/miku.pmx';
    const statusEl = document.getElementById('loading-status');
    statusEl.textContent = 'Loading...';

    try {
      await this.loader.loadPMXFromPath(path);
      this._pmxPath = path;
      document.getElementById('title').style.display = 'none';

      // Apply pending VMD if autoplay already fetched one
      if (this._pendingVmd) {
        await this._applyVmdToMesh(this._pendingVmd.vmdBlob);
        this._currentVmd = this._pendingVmd;
        this._pendingVmd = null;

        if (this.animation.helper && this.animation.mesh) {
          const obj = this.animation.helper.objects.get(this.animation.mesh);
          if (obj && obj.mixer) {
            const t = this.audio.currentTime;
            obj.mixer.setTime(t);
            this.riseFx.seekTo(t);
            this.rippleFx.seekTo(t);
          }
        }
        this.animation.playing = true;
        try {
          await this.audio.audioElement.play();
          this._updatePlayPauseButton(true);
        } catch {
          this.animation.playing = false;
          this._updatePlayPauseButton(false);
          const resume = () => {
            this.audio.play();
            this.animation.playing = true;
            this._updatePlayPauseButton(true);
            document.removeEventListener('click', resume);
            document.removeEventListener('keydown', resume);
          };
          document.addEventListener('click', resume, { once: true });
          document.addEventListener('keydown', resume, { once: true });
        }
      }

      statusEl.textContent = '';
    } catch (err) {
      console.error('Default model load error:', err);
      statusEl.textContent = '';
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

    for (const entry of this._pmxManifest) {
      const opt = document.createElement('option');
      opt.value = JSON.stringify(entry);
      opt.textContent = entry.name;
      selectPmx.appendChild(opt);
    }
    selectPmx.disabled = false;

    selectPmx.addEventListener('change', async () => {
      if (!selectPmx.value) return;
      const entry = JSON.parse(selectPmx.value);
      if (entry.type === 'zip') {
        await this._loadPmxFromZipPath('samples/pmx/' + entry.path);
      } else {
        await this._loadPmxFromSamplePath('samples/pmx/' + entry.path);
      }
    }, sig);
  }

  async _loadPmxFromSamplePath(pmxPath) {
    const statusEl = document.getElementById('loading-status');
    statusEl.textContent = 'Loading...';

    const savedTime = this.audio.currentTime;
    this.animation.destroy();
    this.riseFx.resetTime();
    this.rippleFx.resetTime();

    try {
      await this.loader.loadPMXFromPath(pmxPath);
      this._pmxPath = pmxPath;
      this._updateDebugPaths();
      await this._reapplyCurrentVmd(savedTime);
      statusEl.textContent = '';
    } catch (err) {
      console.error('PMX load error:', err);
      statusEl.textContent = '';
    }
  }

  async _loadPmxFromZipPath(zipUrl) {
    const statusEl = document.getElementById('loading-status');
    statusEl.textContent = 'Loading...';

    const savedTime = this.audio.currentTime;
    this.animation.destroy();
    this.riseFx.resetTime();
    this.rippleFx.resetTime();

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
      this._pmxPath = targetPmx;
      this._updateDebugPaths();
      await this._reapplyCurrentVmd(savedTime);
      statusEl.textContent = '';
    } catch (err) {
      console.error('ZIP PMX load error:', err);
      statusEl.textContent = '';
    }
  }

  async _reapplyCurrentVmd(savedTime) {
    const vmdToApply = this._currentVmd || this._pendingVmd;
    if (!vmdToApply) return;

    await this._applyVmdToMesh(vmdToApply.vmdBlob);
    this._currentVmd = vmdToApply;
    this._pendingVmd = null;

    if (this.animation.helper && this.animation.mesh) {
      const obj = this.animation.helper.objects.get(this.animation.mesh);
      if (obj && obj.mixer) {
        obj.mixer.setTime(savedTime);
        this.riseFx.seekTo(savedTime);
        this.rippleFx.seekTo(savedTime);
      }
    }
    this.animation.playing = true;
  }

  // --- Sample Mode ---

  _sampleSongs = [
    { name: 'HIGHER', vmd: 'samples/vmd/higher/motion.vmd', audio: 'samples/vmd/higher/audio.mp3' },
    { name: 'Your Affection', vmd: 'samples/vmd/your-affection/motion.vmd', audio: 'samples/vmd/your-affection/audio.mp3' },
  ];
  _sampleIndex = 0;

  _initSampleMode() {
    const artistSelect = document.getElementById('select-artist');
    const songSelect = document.getElementById('select-song');

    artistSelect.innerHTML = '<option value="sample" selected>Sample</option>';

    songSelect.innerHTML = '<option value="">Song</option>';
    for (const song of this._sampleSongs) {
      const o = document.createElement('option');
      o.value = JSON.stringify({ vmd: song.vmd, audio: song.audio });
      o.textContent = song.name;
      songSelect.appendChild(o);
    }
    songSelect.disabled = false;

    const sig = { signal: this._ac.signal };
    songSelect.addEventListener('change', async () => {
      if (!songSelect.value) return;
      const { vmd, audio } = JSON.parse(songSelect.value);
      await this._loadVMDFromPath(vmd, audio);
    }, sig);

    // Auto-play first sample
    this._sampleIndex = 0;
    const first = this._sampleSongs[0];
    songSelect.value = JSON.stringify({ vmd: first.vmd, audio: first.audio });
    this._loadVMDFromPath(first.vmd, first.audio);
  }

  _playNextSample() {
    this._sampleIndex = (this._sampleIndex + 1) % this._sampleSongs.length;
    const song = this._sampleSongs[this._sampleIndex];
    const songSelect = document.getElementById('select-song');
    songSelect.value = JSON.stringify({ vmd: song.vmd, audio: song.audio });
    this._loadVMDFromPath(song.vmd, song.audio);
  }

  async _loadVMDFromPath(vmdPath, audioPath) {
    try {
      const [vmdRes, audioRes] = await Promise.all([
        fetch(vmdPath),
        fetch(audioPath),
      ]);
      if (!vmdRes.ok) throw new Error(`Failed to fetch VMD: ${vmdRes.status}`);
      if (!audioRes.ok) throw new Error(`Failed to fetch audio: ${audioRes.status}`);

      const vmdBlob = await vmdRes.blob();
      const vmdFile = new File([vmdBlob], vmdPath.split('/').pop());
      const audioBlob = await audioRes.blob();
      const audioFile = new File([audioBlob], audioPath.split('/').pop());

      this.audio.loadFromFile(audioFile);

      this._vmdPath = vmdPath;
      this._updateDebugPaths();

      if (this.loader.mesh) {
        this.animation.destroy();
        this.riseFx.resetTime();
        this.rippleFx.resetTime();
        await this._applyVmdToMesh(vmdFile);
        this._currentVmd = { vmdPath, audioPath, vmdBlob: vmdFile };
        this._pendingVmd = null;

        this.animation.playing = true;
        try {
          await this.audio.audioElement.play();
          this._updatePlayPauseButton(true);
        } catch {
          this.animation.playing = false;
          this._updatePlayPauseButton(false);
          const resume = () => {
            this.audio.play();
            this.animation.playing = true;
            this._updatePlayPauseButton(true);
            document.removeEventListener('click', resume);
            document.removeEventListener('keydown', resume);
          };
          document.addEventListener('click', resume, { once: true });
          document.addEventListener('keydown', resume, { once: true });
        }
      } else {
        this._pendingVmd = { vmdPath, audioPath, vmdBlob: vmdFile };
        this._currentVmd = null;
        try {
          await this.audio.audioElement.play();
          this._updatePlayPauseButton(true);
        } catch {
          this._updatePlayPauseButton(false);
          const resume = () => {
            this.audio.play();
            this._updatePlayPauseButton(true);
            document.removeEventListener('click', resume);
            document.removeEventListener('keydown', resume);
          };
          document.addEventListener('click', resume, { once: true });
          document.addEventListener('keydown', resume, { once: true });
        }
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

    // ⑤ Precompute effect events
    const wrists = ['左手首', '右手首'];
    const motionEvents = precomputeSparkEvents(mesh, clip, wrists);
    this.riseFx.setEvents(motionEvents);

    // Check which bones the VMD actually keyframes
    const trackNames = new Set(clip.tracks.map(t => {
      const m = t.name.match(/\.bones\[(.+?)\]/);
      return m ? m[1] : t.name.replace(/\.(position|quaternion)$/, '');
    }));
    const boneMap = new Map();
    for (const bone of mesh.skeleton.bones) boneMap.set(bone.name, bone);

    function pickFoot(side) {
      const ik = side + '足ＩＫ';
      if (boneMap.has(ik) && trackNames.has(ik)) return ik;
      const toe = side + 'つま先';
      if (boneMap.has(toe)) return toe;
      return side + '足首';
    }
    const footBones = [pickFoot('左'), pickFoot('右')];
    const ikTracks = [...trackNames].filter(n => n.includes('足'));
    const pmxFootBones = [...boneMap.keys()].filter(n => n.includes('足'));
    console.log('[ripple] PMX foot bones:', pmxFootBones);
    console.log('[ripple] VMD foot tracks:', ikTracks);
    console.log('[ripple] selected:', footBones);
    const footEvents = precomputeFootEvents(mesh, clip, footBones);
    console.log('[ripple] events:', footEvents.length);
    this.rippleFx.setEvents(footEvents);

    this._showBoneDebug(remap, validation, retarget, sizing, vmdMeta);
    return { remap, validation, retarget, sizing };
  }

  _showBoneDebug({ remapped, dropped, ignored }, validation, retarget, sizing, vmdMeta) {
    const el = document.getElementById('debug-info');
    const lines = [];

    // Line 1: bone/morph counts + score
    if (validation) {
      const { boneMatch, morphMatch, score } = validation;
      const bonePart = `${boneMatch.matched}/${boneMatch.total} bones`;
      const morphPart = morphMatch
        ? ` · ${morphMatch.matched}/${morphMatch.total} morphs`
        : '';
      const scoreClass = score >= 80 ? 'score-good' : score >= 50 ? 'score-fair' : 'score-poor';
      const scoreLabel = score >= 80 ? '' : score >= 50 ? ' FAIR' : ' POOR';
      lines.push(`${bonePart}${morphPart} · <span class="${scoreClass}">${Math.round(score)}%${scoreLabel}</span>`);
    }

    // Line 2: Source + Retarget
    const infoParts = [];
    if (validation?.vmdFamily || validation?.pmxFamily) {
      infoParts.push(`VMD: ${validation.vmdFamily || '?'} → PMX: ${validation.pmxFamily || '?'}`);
    }
    if (retarget?.applied.length) {
      infoParts.push(`Retarget: ${retarget.applied.join(', ')}`);
    }
    if (sizing) {
      const delta = sizing.ikFloorDelta;
      const sign = delta >= 0 ? '+' : '';
      infoParts.push(`Sizing: ×${sizing.legRatio.toFixed(2)} IK${sign}${delta.toFixed(2)}`);
    }
    if (infoParts.length) lines.push(infoParts.join(' · '));

    // Warnings
    if (validation?.isCamera) {
      lines.push('<span class="warn">WARN Camera VMD loaded on character slot</span>');
    }
    if (validation?.semiStdCoverage?.missing.length) {
      lines.push(`<span class="warn">WARN 準標準ボーン: ${validation.semiStdCoverage.missing.join(', ')}</span>`);
    }
    if (validation?.zenoyaPosition) {
      lines.push('<span class="warn">WARN 全ての親 has position keyframes</span>');
    }
    if (validation?.translationWarns?.length) {
      lines.push(`<span class="warn">WARN Large translation: ${validation.translationWarns.join(', ')}</span>`);
    }

    // Arm extremes
    if (validation && Object.keys(validation.armExtremes).length > 0) {
      const warns = Object.entries(validation.armExtremes)
        .map(([bone, v]) => `${bone} ${v.peakAngle}°`);
      lines.push(`<span class="drop">Arm peak: ${warns.join(', ')}</span>`);
    }

    // Missing bones
    if (dropped.length) {
      lines.push(`<span class="drop">Missing: ${dropped.join(', ')}</span>`);
    }

    // Morph missing
    if (validation?.morphMatch?.missing?.length) {
      const miss = validation.morphMatch.missing;
      const display = miss.length > 5
        ? miss.slice(0, 5).join(', ') + ` +${miss.length - 5} more`
        : miss.join(', ');
      lines.push(`<span class="warn">Morph missing: ${display}</span>`);
    }

    // Paths
    if (this._pmxPath) {
      const pmxDisplay = this._pmxPath;
      lines.push(`PMX: ${pmxDisplay}`);
    }
    if (this._vmdPath) {
      lines.push(`VMD: ${this._vmdPath}`);
    }

    el.innerHTML = lines.length ? lines.join('<br>') : '';
  }

  // --- Debug Paths (renders path-only until validation overwrites) ---

  _updateDebugPaths() {
    const el = document.getElementById('debug-info');
    const lines = [];
    if (this._pmxPath) {
      const pmxDisplay = this._pmxPath;
      lines.push(`PMX: ${pmxDisplay}`);
    }
    if (this._vmdPath) lines.push(`VMD: ${this._vmdPath}`);
    el.innerHTML = lines.length ? lines.join('<br>') : '';
  }

  // --- Playback Controls (Play/Pause toggle) ---

  _initPlayback() {
    const sig = { signal: this._ac.signal };
    const btn = document.getElementById('btn-playpause');
    const muteBtn = document.getElementById('btn-mute');
    const volumeEl = document.getElementById('volume');

    // Start muted — slider stays at 0.5 but audio is silent
    this._muted = true;
    this._prevVolume = parseFloat(volumeEl.value);
    this.audio.setVolume(0);

    btn.addEventListener('click', () => {
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
      if (this._muted) {
        this.audio.setVolume(0);
      } else {
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
  }

  _updateMuteButton() {
    const btn = document.getElementById('btn-mute');
    btn.innerHTML = this._muted ? '&#128263;' : '&#128264;';
    btn.classList.toggle('active', !this._muted);
  }

  _updatePlayPauseButton(isPlaying) {
    const btn = document.getElementById('btn-playpause');
    btn.innerHTML = isPlaying ? '&#9646;&#9646;' : '&#9655;';
  }

  // --- Timeline Scrubber ---

  _initTimeline() {
    this._tlTrack = document.getElementById('tl-track');
    this._tlFill = document.getElementById('tl-fill');
    this._tlThumb = document.getElementById('tl-thumb');
    this._tlCurrent = document.getElementById('tl-current');
    this._tlTotal = document.getElementById('tl-total');
    this._tlContainer = document.getElementById('timeline');
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
      this._tlContainer.classList.add('dragging');
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
      this._tlContainer.classList.remove('dragging');
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
    const FPS = 30;
    const ratio = duration > 0 ? time / duration : 0;
    this._tlFill.style.transform = `scaleX(${ratio})`;
    this._tlThumb.style.left = (ratio * 100) + '%';
    this._tlCurrent.textContent = this._formatTimeline(time, FPS);
    this._tlTotal.textContent = this._formatTimeline(duration, FPS);
  }

  _formatTimeline(seconds, fps) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const f = Math.round(seconds * fps);
    return `${m}:${String(s).padStart(2, '0')} f${f}`;
  }

  _initFxSelectors() {
    const sig = { signal: this._ac.signal };

    document.getElementById('chk-rise').addEventListener('change', (e) => {
      this.riseFx.enabled = e.target.checked;
    }, sig);

    document.getElementById('chk-fall').addEventListener('change', (e) => {
      this.fallFx.enabled = e.target.checked;
    }, sig);

    document.getElementById('chk-ripple').addEventListener('change', (e) => {
      this.rippleFx.enabled = e.target.checked;
    }, sig);

    document.getElementById('chk-mirror').addEventListener('change', (e) => {
      this.mirrorFx.enabled = e.target.checked;
    }, sig);
  }

  destroy() {
    this._ac.abort();
    if (this._tlRAF) cancelAnimationFrame(this._tlRAF);
  }
}
