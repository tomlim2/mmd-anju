import { PostProcessing } from 'three/webgpu';
import {
  pass,
  uniform, screenUV,
  vec3, float,
  length, mix,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

const DEFAULTS = {
  bloom: { strength: 0.1, radius: 0.05, threshold: 0.75 },
  vignette: { intensity: 0.8 },
  aces: { exposure: 1.0 },
  temp: { value: 0 },
};

export class PostProcess {
  static DEFAULTS = DEFAULTS;

  constructor(renderer, scene, camera) {
    this._pp = new PostProcessing(renderer);

    // --- Node graph ---
    const scenePass = pass(scene, camera);
    const sceneTex = scenePass.getTextureNode('output');

    // 1. Bloom — pass numbers, access .strength/.radius/.threshold on the node
    const bloomPass = bloom(sceneTex, DEFAULTS.bloom.strength, DEFAULTS.bloom.radius, DEFAULTS.bloom.threshold);
    this._bloomNode = bloomPass;
    let output = sceneTex.add(bloomPass);

    // 2. ACES Tone Mapping
    this.acesMix = uniform(0.0);
    this.acesExposure = uniform(DEFAULTS.aces.exposure);
    const exposed = output.mul(this.acesExposure);
    const acesA = exposed.mul(exposed.mul(2.51).add(0.03));
    const acesB = exposed.mul(exposed.mul(2.43).add(0.59)).add(0.14);
    const tonemapped = acesA.div(acesB).clamp(0, 1);
    output = mix(output, tonemapped, this.acesMix);

    // 3. Color Temperature (warm: +R -B, cool: -R +B)
    this.temperature = uniform(0.0);
    output = output.add(vec3(
      this.temperature.mul(0.08),
      this.temperature.mul(0.02),
      this.temperature.mul(-0.08),
    )).clamp(0, 1);

    // 4. Vignette (last)
    this.vignetteIntensity = uniform(DEFAULTS.vignette.intensity);
    const dist = length(screenUV.sub(0.5));
    const vig = float(1.0).sub(dist.mul(2.0).pow(2.5).mul(this.vignetteIntensity));
    output = output.mul(vig.clamp(0, 1));

    this._pp.outputNode = output;

    // --- Saved values for enable/disable ---
    this._saved = {
      bloomStrength: DEFAULTS.bloom.strength,
      vignetteIntensity: DEFAULTS.vignette.intensity,
      acesExposure: DEFAULTS.aces.exposure,
      temperature: DEFAULTS.temp.value,
    };
  }

  // --- Bloom accessors (via BloomNode internal uniforms) ---
  get bloomStrength() { return this._bloomNode.strength; }
  get bloomRadius() { return this._bloomNode.radius; }
  get bloomThreshold() { return this._bloomNode.threshold; }

  // --- Enable / Disable ---
  setBloomEnabled(on) {
    this._bloomNode.strength.value = on ? this._saved.bloomStrength : 0;
  }

  setVignetteEnabled(on) {
    this.vignetteIntensity.value = on ? this._saved.vignetteIntensity : 0;
  }

  setAcesEnabled(on) {
    this.acesMix.value = on ? 1.0 : 0.0;
  }

  setTempEnabled(on) {
    this.temperature.value = on ? this._saved.temperature : 0;
  }

  render() {
    this._pp.render();
  }
}
