import {
  MeshBasicNodeMaterial,
  SkinnedMesh,
  Color,
  BackSide,
  AdditiveBlending,
  AddOperation,
} from 'three/webgpu';
import {
  Fn,
  uniform,
  texture,
  positionLocal,
  normalLocal,
  normalView,
  positionView,
  float,
  vec3,
  normalize,
  dot,
  step,
  clamp,
  matcapUV,
} from 'three/tsl';

// Shared uniforms — all materials reference these, UI controls once
export const rimUniforms = {
  intensity: uniform(0),
  threshold: uniform(0.5),
  color: uniform(new Color(1, 1, 1)),
};

// Shadow lift: screen-blends a flat value to raise dark areas.
// 0 = off (default), 0.3 ≈ MMD ambient, 0.5 = strong lift.
export const shadowLift = uniform(0);

// Basic mode: 1 = raw baseColor × texture only, 0 = full toon pipeline.
export const basicMode = uniform(0);

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
    const matcapTex = mat.matcap;

    const isOverlay = mat.name?.endsWith('+');
    const isAdditiveOverlay = isOverlay && matcapTex && mat.matcapCombine === AddOperation;

    if (isOverlay) {
      flat.depthWrite = false;
      flat.transparent = true;
    }
    if (isAdditiveOverlay) {
      flat.blending = AdditiveBlending;
    }

    flat.colorNode = Fn(() => {
      // Raw texture color — used for basic mode output
      let raw = baseColor;
      if (mapTex) raw = raw.mul(texture(mapTex).rgb);

      // Additive sphere overlay: output only sphere, masked by diffuse alpha.
      // AdditiveBlending → GPU: src.rgb × src.a + dst.rgb
      // α=0 (97%+ area) → no highlight; α>0 → highlight at texture-defined intensity.
      if (isAdditiveOverlay) {
        const sphere = texture(matcapTex, matcapUV).rgb;
        if (mapTex) {
          const map = texture(mapTex);
          flat.opacityNode = map.a;
          return sphere.mul(map.rgb).mul(float(1).sub(basicMode)).add(raw.mul(basicMode));
        }
        return sphere.mul(float(1).sub(basicMode)).add(raw.mul(basicMode));
      }

      let color = raw;

      if (matcapTex) {
        const sphere = texture(matcapTex, matcapUV).rgb;
        if (mat.matcapCombine === AddOperation) {
          // Screen blend: highlights without exceeding 1.0
          color = color.add(sphere).sub(color.mul(sphere));
        } else {
          color = color.mul(sphere);
        }
      }

      // Shadow lift: screen blend to raise dark areas
      // screen(color, lift) = color + lift - color * lift
      const lift = vec3(shadowLift);
      color = color.add(lift).sub(color.mul(lift));

      // Overlay with diffuse alpha: use texture alpha for per-pixel transparency.
      // Covers multiply sphere overlays (e.g. 昔涟 衣+/衣++) where α=0 areas
      // have white RGB and must be fully transparent.
      if (isOverlay && mapTex) {
        flat.opacityNode = texture(mapTex).a;
      }

      // Rim light only for non-overlay materials
      if (!isOverlay) {
        const viewDir = normalize(positionView.negate());
        const NdotV = clamp(dot(normalView, viewDir), 0, 1);
        const rim = step(rimUniforms.threshold, float(1).sub(NdotV));
        color = color.add(vec3(rimUniforms.color).mul(rim).mul(rimUniforms.intensity));
      }

      // Basic mode: bypass all effects, output raw baseColor × texture
      return color.mul(float(1).sub(basicMode)).add(raw.mul(basicMode));
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
