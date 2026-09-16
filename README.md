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
- WebGPU capability checks with a responsive browser guidance card, retry, and shareable player URL

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

Hosted at https://tomlim2.github.io/mmd-anju/ using GitHub Pages. No bundler; ES modules are loaded via importmap from CDN.

`main` pushes and pull requests run validation only. Pushing a stable version tag (`vMAJOR.MINOR.PATCH`) validates the tagged source, deploys it, then creates a GitHub Release with release notes. The tagged commit must belong to `main` history.

```bash
# Validate and preview the actual deployment bundle (Python 3.10+, Node.js, Git)
node --test tests/*.test.mjs
python3 scripts/build_site.py
python3 -m http.server 3002 --directory _site

# After committing reviewed changes, publish a new version:
git push origin main
git tag -a v1.0.1 -m "Describe this update"
git push origin v1.0.1
```

The staging script copies only Git-tracked `index.html`, `js/`, `vendor/`, and `samples/` files into `_site/`. It checks JavaScript syntax, relative module imports, and manifest paths for deployed samples. Local `data`, analysis tools, and repository metadata are excluded. Add new runtime files to Git before validating. Keep local-only sample files untracked; `deployed: false` controls UI visibility, not file access.

Optional human-written release notes live in `releases/<tag>.md` and must be committed before tagging. The workflow adds changes since the preceding version tag and the deployed commit. The first release lists the tagged commit. If no notes file exists, a summary and commit list are generated automatically. Failed runs can be retried in Actions; the same tag's existing release is updated instead of duplicated.

Repository settings: Pages uses **GitHub Actions**, and the `github-pages` environment allows `v*` tags. Workflows use the built-in `GITHUB_TOKEN`, with no extra deployment secret. See `.github/workflows/release.yml` and `.github/workflows/validate.yml`.

For development without staging:

```bash
# Local dev
npx serve -l 3002 .
```
