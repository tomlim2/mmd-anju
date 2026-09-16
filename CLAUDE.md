# mmd-anju

Three.js WebGPU MMD (MikuMikuDance) player.

## Structure

```
index.html              # Entry point
js/
├── main.js             # App bootstrap
├── scene.js            # Three.js scene setup (WebGPU)
├── loader.js           # PMX/VMD loading
├── animation.js        # Animation mixer, playback control
├── audio.js            # Audio sync
├── ui.js               # UI controls
├── shader.js           # TSL shaders
├── encoding.js         # Shift-JIS encoding utils
├── bone-remap.js       # Bone name remapping
├── bone-retarget.js    # Cross-model bone retargeting
├── ik-sizing.js        # Per-family IK auto-sizing
├── pmx-check.js        # PMX model validation
├── vmd-meta.js         # VMD metadata extraction
├── vmd-validator.js    # VMD-PMX compatibility check
└── effects/            # BG FX (rising-light, foot-ripple, etc.)
vendor/                 # Modified Three.js MMD modules
tools/                  # Python analysis scripts (PMX/VMD parsing)
data -> symlink         # Local MMD archive (not in repo)
```

## Release workflow

- Run `python3 scripts/build_site.py` with Git, Node.js, and Python 3.10+ available before releasing.
- `_site/` contains only tracked runtime files and samples; never deploy the repository root or the local `data` archive.
- `main` pushes validate without deploying. Stable `vMAJOR.MINOR.PATCH` tags deploy to GitHub Pages and publish release notes after success.
- Commit optional `releases/<tag>.md` notes before tagging. See README for release commands.

## TODO

### Multi-model & Camera
- [ ] Multi-model support (multiple PMX slots for multi-character VMDs like Knife MIKU/RIN/LEN)
- [ ] Camera VMD playback with free/VMD camera toggle (OrbitControls ↔ VMD camera switch)

### VMD special types (non-playable → playable)
- [ ] `hands-facial` VMD: merge finger/hand bone tracks + morph tracks into main body motion
- [ ] `facial-only` VMD: overlay morph-only VMD on top of body motion (expression layer)
- [ ] `camera` VMD: sync camera keyframes with character motion playback
- [ ] `prop` VMD: accessory/stage motion (microphone stand, etc.) — load as separate mesh

### UX Improvements
- [ ] Keyboard shortcuts (Space=play/pause, M=mute, ←→=seek, ↑↓=volume)
- [ ] Timeline hit area expansion (hover: 4px→8px, touch: always 8px)
- [ ] Error feedback (show load failures in #loading-status)
- [ ] Current song info display (separate from select dropdowns)
- [ ] Prev/Next track buttons (⏮ ⏭)
- [ ] Focus-visible styles on all interactive elements
- [ ] Idle auto-hide controls (3s timeout, fade out)
- [ ] Song transition fade (audio crossfade 0.3s)
- [ ] Debug info toggle (D key, default visible for now)

## Related Resources

- **MMD archive:** `mmd-archive` in repo-paths.json
- **Learnings:** Obsidian `claude/learnings/projects/mmd-player-anju/`
- **Origin:** Migrated from `anju/web/mmd-player-anju`
