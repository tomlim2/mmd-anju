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

## Related Resources

- **MMD archive:** `mmd-archive` in repo-paths.json
- **Learnings:** Obsidian `claude/learnings/projects/mmd-player-anju/`
- **Origin:** Migrated from `anju/web/mmd-player-anju`
