import {
  MeshToonNodeMaterial,
  DataTexture,
  RedFormat,
  NearestFilter,
  Color,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  uniform,
  normalView,
  dot,
  normalize,
  clamp,
  step,
  mix,
  texture,
} from 'three/tsl';

/**
 * Create a 2-band toon gradient texture (light/dark hard boundary).
 */
function createGradientMap(bands = 2) {
  const size = bands;
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    data[i] = Math.round((i / (size - 1)) * 255);
  }
  const tex = new DataTexture(data, size, 1, RedFormat);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Swap MMDLoader's ShaderMaterial to MeshToonNodeMaterial with TSL toon shading.
 */
export function swapToToonMaterial(mesh) {
  const gradientMap = createGradientMap(2);
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

  const lightDir = uniform(new Vector3(0.5, 1.0, 0.75).normalize());
  const shadowTint = uniform(new Color(0.82, 0.75, 0.92));
  const threshold = uniform(0.5);

  const swapped = materials.map((mat) => {
    const toon = new MeshToonNodeMaterial();
    toon.gradientMap = gradientMap;

    // Transfer base properties
    toon.side = mat.side;
    toon.transparent = mat.transparent;
    toon.opacity = mat.opacity;

    // Anime shadow color tint — texture sampled inside colorNode
    const baseColor = uniform(mat.color || new Color(1, 1, 1));
    const mapTex = mat.map;

    toon.colorNode = Fn(() => {
      let color = baseColor;
      if (mapTex) color = color.mul(texture(mapTex).rgb);
      return color;
    })();

    mat.dispose();
    return toon;
  });

  mesh.material = swapped.length === 1 ? swapped[0] : swapped;
  return mesh;
}
