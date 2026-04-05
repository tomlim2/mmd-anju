// babylon-mmd core — Phase 1 minimal setup
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3, Color4 } from '@babylonjs/core/Maths/math';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import '@babylonjs/core/Rendering/depthRendererSceneComponent';
import '@babylonjs/core/Physics/joinedPhysicsEngineComponent';
import { HavokPlugin } from '@babylonjs/core/Physics/v2/Plugins/havokPlugin';
import HavokPhysics from '@babylonjs/havok';

// babylon-mmd imports
import { MmdRuntime } from 'babylon-mmd/esm/Runtime/mmdRuntime';
import { MmdPhysics } from 'babylon-mmd/esm/Runtime/Physics/mmdPhysics';
import { VmdLoader } from 'babylon-mmd/esm/Loader/vmdLoader';
import { SdefInjector } from 'babylon-mmd/esm/Loader/sdefInjector';
import { MmdStandardMaterialBuilder } from 'babylon-mmd/esm/Loader/mmdStandardMaterialBuilder';
import { MmdMesh } from 'babylon-mmd/esm/Runtime/mmdMesh';

// Side effect imports (required for animation binding)
import 'babylon-mmd/esm/Runtime/Animation/mmdRuntimeModelAnimation';
import 'babylon-mmd/esm/Loader/pmxLoader';

const status = document.getElementById('status');
const log = (msg) => { status.textContent = msg; console.log('[mmd]', msg); };

async function main() {
  const canvas = document.getElementById('canvas');

  // Engine
  log('Creating engine...');
  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
  });
  engine.setHardwareScalingLevel(1 / window.devicePixelRatio);

  // Scene
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.102, 0.102, 0.102, 1);
  scene.ambientColor = new Color3(0.5, 0.5, 0.5);

  // Havok physics engine (required by MmdPhysics)
  log('Initializing Havok physics...');
  const havokInstance = await HavokPhysics();
  const havokPlugin = new HavokPlugin(true, havokInstance);
  scene.enablePhysics(new Vector3(0, -9.8 * 10, 0), havokPlugin);

  // SDEF
  SdefInjector.OverrideEngineCreateEffect(engine);

  // Camera
  const camera = new ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 2.5, 25, new Vector3(0, 10, 0), scene);
  camera.attachControl(canvas, true);
  camera.minZ = 0.1;
  camera.maxZ = 300;
  camera.wheelPrecision = 10;
  camera.panningSensibility = 100;

  // Lights
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.6;
  hemi.groundColor = new Color3(0.2, 0.2, 0.25);

  const dir = new DirectionalLight('dir', new Vector3(-0.5, -1.5, 1), scene);
  dir.intensity = 0.8;

  // Ground
  const ground = MeshBuilder.CreateGround('ground', { width: 60, height: 60 }, scene);
  const groundMat = new StandardMaterial('groundMat', scene);
  groundMat.diffuseColor = new Color3(0.15, 0.15, 0.15);
  groundMat.specularColor = new Color3(0, 0, 0);
  ground.material = groundMat;
  ground.receiveShadows = true;

  // MMD Runtime with physics
  log('Initializing physics...');
  const mmdRuntime = new MmdRuntime(scene, new MmdPhysics(scene));
  mmdRuntime.register(scene);

  // Material builder
  const materialBuilder = new MmdStandardMaterialBuilder();
  materialBuilder.loadOutlineRenderingProperties = () => { /* skip outline for now */ };

  // Load PMX
  log('Loading PMX model...');

  // Use first sample from manifest
  let pmxPath;
  try {
    const res = await fetch('samples/pmx/manifest.json');
    const manifest = await res.json();
    const first = manifest.find(m => m.deployed !== false);
    if (first) {
      pmxPath = 'samples/pmx/' + first.path;
      log(`Loading: ${first.name}...`);
    }
  } catch (e) {
    console.warn('No PMX manifest, using default path');
  }

  if (!pmxPath) {
    log('No PMX model found');
    engine.runRenderLoop(() => scene.render());
    return;
  }

  const pmxDir = pmxPath.substring(0, pmxPath.lastIndexOf('/') + 1);
  const pmxFile = pmxPath.substring(pmxPath.lastIndexOf('/') + 1);

  const result = await SceneLoader.ImportMeshAsync(
    undefined,
    pmxDir,
    pmxFile,
    scene,
  );

  const mmdMesh = result.meshes[0];
  if (!mmdMesh) {
    log('Failed to load mesh');
    engine.runRenderLoop(() => scene.render());
    return;
  }

  log('Creating MMD model...');
  const mmdModel = mmdRuntime.createMmdModel(mmdMesh);

  // Load VMD
  log('Loading VMD animation...');
  let vmdPath;
  try {
    const res = await fetch('samples/vmd/manifest.json');
    const manifest = await res.json();
    const first = manifest.find(v => v.deployed !== false);
    if (first) {
      vmdPath = 'samples/vmd/' + first.vmd;
      log(`Loading VMD: ${first.name}...`);
    }
  } catch (e) {
    console.warn('No VMD manifest');
  }

  if (vmdPath) {
    const vmdLoader = new VmdLoader(scene);
    const vmdAnimation = await vmdLoader.loadAsync('motion', vmdPath);

    const animHandle = mmdModel.createRuntimeAnimation(vmdAnimation);
    mmdModel.setRuntimeAnimation(animHandle);

    mmdRuntime.playAnimation();
    log('Playing! Physics ON — check cloth stability.');
  } else {
    log('No VMD found. Model loaded (T-pose).');
  }

  // Render loop
  engine.runRenderLoop(() => {
    scene.render();
  });

  // Resize
  window.addEventListener('resize', () => {
    engine.resize();
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  log('Error: ' + err.message);
});
