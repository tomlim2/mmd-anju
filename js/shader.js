import {
  MeshBasicNodeMaterial,
  Color,
} from 'three/webgpu';
import {
  Fn,
  uniform,
  texture,
} from 'three/tsl';

/**
 * Swap MMDLoader's ShaderMaterial to flat unlit material (one-tone, no shadows).
 */
export function swapToToonMaterial(mesh) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

  const swapped = materials.map((mat) => {
    const flat = new MeshBasicNodeMaterial();

    flat.side = mat.side;
    flat.transparent = mat.transparent;
    flat.opacity = mat.opacity;

    const baseColor = uniform(mat.color || new Color(1, 1, 1));
    const mapTex = mat.map;

    flat.colorNode = Fn(() => {
      let color = baseColor;
      if (mapTex) color = color.mul(texture(mapTex).rgb);
      return color;
    })();

    mat.dispose();
    return flat;
  });

  mesh.material = swapped.length === 1 ? swapped[0] : swapped;
  return mesh;
}
