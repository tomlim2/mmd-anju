import {
  MeshBasicNodeMaterial,
  SkinnedMesh,
  Color,
  BackSide,
} from 'three/webgpu';
import {
  Fn,
  uniform,
  texture,
  positionLocal,
  normalLocal,
  float,
  vec3,
} from 'three/tsl';

/**
 * Swap MMDLoader's ShaderMaterial to flat unlit material (one-tone, no shadows).
 * Preserves userData.outlineParameters for outline mesh creation.
 */
export function swapToToonMaterial(mesh) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

  const swapped = materials.map((mat) => {
    const flat = new MeshBasicNodeMaterial();

    flat.side = mat.side;
    flat.transparent = mat.transparent;
    flat.opacity = mat.opacity;


    // Preserve outline parameters before disposing
    if (mat.userData?.outlineParameters) {
      flat.userData.outlineParameters = mat.userData.outlineParameters;
    }

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

/**
 * Create an outline SkinnedMesh that shares the original mesh's geometry & skeleton.
 * Uses BackSide + vertex displacement (inverted hull). Rendered in the same pass
 * via renderOrder so no 2-pass autoClear issues.
 */
export function createOutlineMesh(mesh) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

  const outlineMats = materials.map((mat) => {
    const params = mat.userData?.outlineParameters;

    if (!params?.visible) {
      const hidden = new MeshBasicNodeMaterial();
      hidden.visible = false;
      return hidden;
    }

    const outline = new MeshBasicNodeMaterial();
    outline.side = BackSide;
    outline.transparent = false;
    outline.depthWrite = true;
    const baseThickness = params.thickness;
    const scale = uniform(10.0);
    const color = uniform(new Color(params.color[0], params.color[1], params.color[2]));

    outline.positionNode = Fn(() => {
      return positionLocal.add(normalLocal.mul(float(baseThickness).mul(scale)));
    })();
    outline.colorNode = color;

    outline.userData.edgeScale = scale;
    outline.userData.edgeColor = color;
    outline.userData.edgeOriginalColor = new Color(params.color[0], params.color[1], params.color[2]);
    outline.userData.edgeBaseThickness = baseThickness;

    return outline;
  });

  const outlineMesh = new SkinnedMesh(mesh.geometry, outlineMats.length === 1 ? outlineMats[0] : outlineMats);
  outlineMesh.skeleton = mesh.skeleton;
  outlineMesh.bindMatrix.copy(mesh.bindMatrix);
  outlineMesh.bindMatrixInverse.copy(mesh.bindMatrixInverse);
  outlineMesh.renderOrder = -1;  // render before main mesh (BackSide behind FrontSide)
  outlineMesh.frustumCulled = false;
  outlineMesh.name = 'outline';

  // Store refs for UI controls
  outlineMesh.userData.outlineMaterials = outlineMats;

  return outlineMesh;
}
