# mmd-player-anju

Browser-based MikuMikuDance player built on Three.js WebGPU.

Loads PMX models and VMD motions with audio sync, particle effects, and real-time IK.

## Features

- PMX model loading (file path or ZIP upload)
- VMD motion playback with bone retargeting and IK
- Audio-synced animation with wall clock fallback (autoplay policy)
- Particle effects: Rising Light, Falling Light, Foot Ripple, Ground Mirror
- FX parameter controller with copy/paste JSON presets
- ShiftJIS mojibake texture fallback
- Mobile compatibility detection (WebGPU required)

## UI

```
Top Bar:  [Song v] | [PMX v] | [Rise] [Fall] [Ripple] [Mirror]
Controls: [<< Prev] [Play/Pause] [Next >>]  [Volume]  [Mute]
          [Timeline ━━━━━━━━━━━━━━━━━━━━━━━━]
FX Panel: Rise (speed, wind, size, life, radius)
          Fall (speed, size)
          Ripple (radius, strength, speed)
```

- `H` key or UI button to hide all panels
- Debug panel (hidden on touch devices)

## Tech Stack

- Three.js r0.172.0 (WebGPU / TSL shaders)
- Vanilla ES modules (no bundler)
- JSZip 3.10.1
- HTML Audio API

## Project Structure

```
js/
  main.js          Render loop, audio-animation sync
  ui.js            UI wiring, model/song loading, FX controls
  loader.js        PMX loading (path + blob), mesh swap
  animation.js     MMD animation helper, IK, seek
  audio.js         Audio playback, mute state
  scene.js         Three.js scene setup (WebGPU)
  shader.js        Toon material swap (TSL)
  encoding.js      ShiftJIS mojibake resolver
  bone-remap.js    Bone name remapping
  bone-retarget.js Cross-model VMD retargeting
  vmd-validator.js VMD-PMX compatibility check
  vmd-meta.js      VMD binary metadata extraction
  pmx-check.js     Humanoid bone detection
  ik-sizing.js     Auto IK chain sizing
  effects/
    rising-light.js   Upward particle stream
    falling-light.js  Downward particle rain
    foot-ripple.js    Foot impact ripples
    ground-reflect.js Mirror floor reflection
    spark-burst.js    Spark particle burst
    spark-precompute.js  Effect event precomputation
    velocity-effect.js   Velocity-based base effect
samples/
  pmx/             Sample PMX models + manifest.json
  vmd/             Sample VMD motions + manifest.json
vendor/
  MMDLoader.js     Patched Three.js MMD loader
```

## Sample Files

Manifests (`samples/pmx/manifest.json`, `samples/vmd/manifest.json`) track all known samples. Entries with `"deployed": false` are local-only and hidden from the web UI.

## Deploy

Static hosting (GitHub Pages). No build step. ES modules loaded via importmap from CDN.

```bash
# Local dev
npx serve -l 3002 .
```
