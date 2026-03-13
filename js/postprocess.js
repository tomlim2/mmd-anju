import { PostProcessing } from 'three/webgpu';
import {
  pass,
  uniform, screenUV,
  vec3, float,
  length, mix, normalize,
  dot, fract, sin, timerLocal,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

const DEFAULTS = {
  bloom: { strength: 0, radius: 0.1, threshold: 0.2 },
  vignette: { intensity: 0 },
  aces: { exposure: 0.5 },
  temp: { value: 0 },
  ca: { intensity: 0 },
  grain: { amount: 0 },
  saturation: { value: 1 },
  bw: { mix: 0 },
  contrast: { value: 1, brightness: 0 },
};

export class PostProcess {
  static DEFAULTS = DEFAULTS;

  constructor(renderer, scene, camera) {
    this._pp = new PostProcessing(renderer);

    // --- Shared uniforms ---
    this.caIntensity = uniform(DEFAULTS.ca.intensity);
    this.acesMix = uniform(0.0);
    this.acesExposure = uniform(DEFAULTS.aces.exposure);
    this.temperature = uniform(0.0);
    this.saturation = uniform(DEFAULTS.saturation.value);
    this.bwMix = uniform(DEFAULTS.bw.mix);
    this.contrast = uniform(DEFAULTS.contrast.value);
    this.brightness = uniform(DEFAULTS.contrast.brightness);
    this.grainAmount = uniform(DEFAULTS.grain.amount);
    this.vignetteIntensity = uniform(DEFAULTS.vignette.intensity);

    // --- Scene pass ---
    const scenePass = pass(scene, camera);
    const sceneTex = scenePass.getTextureNode('output');

    // --- CA (chromatic aberration) — high cost: 3 texture fetches ---
    const caDir = screenUV.sub(0.5);
    const caAmount = length(caDir).mul(this.caIntensity);
    const caNorm = normalize(caDir);
    const uvR = screenUV.add(caNorm.mul(caAmount));
    const uvB = screenUV.sub(caNorm.mul(caAmount));
    const caOutput = vec3(
      sceneTex.uv(uvR).x,
      sceneTex.y,
      sceneTex.uv(uvB).z,
    );

    // --- Bloom node — high cost: multi-pass downsample+blur ---
    this._bloomNode = bloom(sceneTex, DEFAULTS.bloom.strength, DEFAULTS.bloom.radius, DEFAULTS.bloom.threshold);

    // --- 3 output chains ---
    // High: CA + bloom + grain + per-pixel effects
    this._outputHigh = this._buildChain(caOutput.add(this._bloomNode), { grain: true });
    // Low (with bloom off but CA still in graph — reuse for bloom toggle within high)
    this._outputMid = this._buildChain(caOutput, { grain: true });
    // Low: no CA, no bloom, no grain — just per-pixel math
    this._outputLow = this._buildChain(sceneTex, { grain: false });

    this._level = 'low';  // 'low' or 'high'
    this._bloomActive = false;
    this._pp.outputNode = this._outputLow;

    // --- Saved values for enable/disable ---
    this._saved = {
      bloomStrength: DEFAULTS.bloom.strength,
      vignetteIntensity: DEFAULTS.vignette.intensity,
      acesExposure: DEFAULTS.aces.exposure,
      temperature: DEFAULTS.temp.value,
      caIntensity: DEFAULTS.ca.intensity,
      grainAmount: DEFAULTS.grain.amount,
      saturation: DEFAULTS.saturation.value,
      bwMix: DEFAULTS.bw.mix,
      contrast: DEFAULTS.contrast.value,
      brightness: DEFAULTS.contrast.brightness,
    };
  }

  _buildChain(startOutput, { grain = true } = {}) {
    let output = startOutput;

    // ACES Tone Mapping
    const exposed = output.mul(this.acesExposure);
    const acesA = exposed.mul(exposed.mul(2.51).add(0.03));
    const acesB = exposed.mul(exposed.mul(2.43).add(0.59)).add(0.14);
    const tonemapped = acesA.div(acesB).clamp(0, 1);
    output = mix(output, tonemapped, this.acesMix);

    // Color Temperature
    output = output.add(vec3(
      this.temperature.mul(0.08),
      this.temperature.mul(0.02),
      this.temperature.mul(-0.08),
    )).clamp(0, 1);

    // Saturation
    const luma = output.x.mul(0.2126).add(output.y.mul(0.7152)).add(output.z.mul(0.0722));
    const gray = vec3(luma, luma, luma);
    output = mix(gray, output, this.saturation).clamp(0, 1);

    // Black & White
    const bwGray = output.x.mul(0.299).add(output.y.mul(0.587)).add(output.z.mul(0.114));
    output = mix(output, vec3(bwGray, bwGray, bwGray), this.bwMix);

    // Contrast / Brightness
    output = output.sub(0.5).mul(this.contrast).add(0.5).add(this.brightness).clamp(0, 1);

    // Film Grain (only in high chain)
    if (grain) {
      const seed = dot(screenUV, vec3(12.9898, 78.233, 45.164)).add(timerLocal());
      const noise = fract(sin(seed).mul(43758.5453)).sub(0.5).mul(this.grainAmount);
      output = output.add(noise).clamp(0, 1);
    }

    // Vignette (last)
    const dist = length(screenUV.sub(0.5));
    const vig = float(1.0).sub(dist.mul(2.0).pow(2.5).mul(this.vignetteIntensity));
    output = output.mul(vig.clamp(0, 1));

    return output;
  }

  // --- Level switching ---
  setLevel(level) {
    this._level = level;
    this._updateOutputNode();
  }

  _updateOutputNode() {
    if (this._level === 'high') {
      this._pp.outputNode = this._bloomActive ? this._outputHigh : this._outputMid;
    } else {
      this._pp.outputNode = this._outputLow;
    }
    this._pp.needsUpdate = true;
  }

  // --- Bloom accessors (via BloomNode internal uniforms) ---
  get bloomStrength() { return this._bloomNode.strength; }
  get bloomRadius() { return this._bloomNode.radius; }
  get bloomThreshold() { return this._bloomNode.threshold; }

  // --- Enable / Disable ---
  setBloomEnabled(on) {
    this._bloomActive = on;
    this._updateOutputNode();
    if (on) {
      this._bloomNode.strength.value = this._saved.bloomStrength;
    }
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

  setCaEnabled(on) {
    this.caIntensity.value = on ? this._saved.caIntensity : 0;
  }

  setGrainEnabled(on) {
    this.grainAmount.value = on ? this._saved.grainAmount : 0;
  }

  setSaturationEnabled(on) {
    this.saturation.value = on ? this._saved.saturation : 1.0;
  }

  setBwEnabled(on) {
    if (on && this._saved.bwMix === 0) this._saved.bwMix = 1.0;
    this.bwMix.value = on ? this._saved.bwMix : 0;
  }

  setContrastEnabled(on) {
    this.contrast.value = on ? this._saved.contrast : 1.0;
    this.brightness.value = on ? this._saved.brightness : 0;
  }

  render() {
    this._pp.render();
  }
}
