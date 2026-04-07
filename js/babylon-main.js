// babylon-mmd core — Phase 2 with UI integration
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
import { Plane } from '@babylonjs/core/Maths/math.plane';
import { MirrorTexture } from '@babylonjs/core/Materials/Textures/mirrorTexture';
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
import { StreamAudioPlayer } from 'babylon-mmd/esm/Runtime/Audio/streamAudioPlayer';
import { PmxLoader } from 'babylon-mmd/esm/Loader/pmxLoader';

// Side effect imports
import 'babylon-mmd/esm/Runtime/Animation/mmdRuntimeModelAnimation';
import 'babylon-mmd/esm/Loader/mmdOutlineRenderer';
// Pre-register outline shaders in ShaderStore (avoid dynamic import race)
import 'babylon-mmd/esm/Loader/Shaders/mmdOutline.vertex';
import 'babylon-mmd/esm/Loader/Shaders/mmdOutline.fragment';

import { BabylonUI } from './babylon-ui.js';

// ── App state ──
const app = {
  engine: null,
  scene: null,
  camera: null,
  mmdRuntime: null,
  mmdModel: null,
  audioPlayer: null,
  vmdLoader: null,
};

const log = (msg) => {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
  console.log('[mmd]', msg);
};

async function main() {
  const canvas = document.getElementById('canvas');

  // Engine
  log('Creating engine...');
  const engine = new Engine(canvas, true, {
    preserveDrawingBuffer: true,
    stencil: true,
  });
  engine.setHardwareScalingLevel(1 / window.devicePixelRatio);
  app.engine = engine;

  // Scene
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.102, 0.102, 0.102, 1);
  scene.ambientColor = new Color3(0.5, 0.5, 0.5);
  app.scene = scene;

  // Havok physics
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
  app.camera = camera;

  // Lights
  const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
  hemi.intensity = 0.6;
  hemi.groundColor = new Color3(0.2, 0.2, 0.25);

  const dir = new DirectionalLight('dir', new Vector3(-0.5, -1.5, 1), scene);
  dir.intensity = 0.8;

  // Ground with mirror reflection
  const ground = MeshBuilder.CreateGround('ground', { width: 60, height: 60 }, scene);
  const groundMat = new StandardMaterial('groundMat', scene);
  groundMat.diffuseColor = new Color3(0.15, 0.15, 0.15);
  groundMat.specularColor = new Color3(0, 0, 0);

  // Mirror reflection — renders scene from below, blended at 40% opacity
  const mirror = new MirrorTexture('mirror', 1024, scene, true);
  mirror.mirrorPlane = new Plane(0, -1, 0, 0);
  mirror.level = 0.4;
  mirror.adaptiveBlurKernel = 16;
  groundMat.reflectionTexture = mirror;

  ground.material = groundMat;
  ground.receiveShadows = true;
  app.ground = ground;
  app.mirror = mirror;

  // MMD Runtime with physics
  log('Initializing MMD runtime...');
  const mmdRuntime = new MmdRuntime(scene, new MmdPhysics(scene));
  mmdRuntime.register(scene);
  app.mmdRuntime = mmdRuntime;

  // Audio player (integrated with MmdRuntime for sync)
  const audioPlayer = new StreamAudioPlayer(scene);
  audioPlayer.volume = 0.5;
  audioPlayer.mute(); // Start muted — unmute on user interaction
  app.audioPlayer = audioPlayer;

  // VmdLoader
  app.vmdLoader = new VmdLoader(scene);

  // Material builder (toon shading + outline from PMX data)
  const materialBuilder = new MmdStandardMaterialBuilder();
  SceneLoader.OnPluginActivatedObservable.add((loader) => {
    if (loader.name === 'pmx') {
      loader.materialBuilder = materialBuilder;
    }
  });

  // Render loop
  engine.runRenderLoop(() => scene.render());
  window.addEventListener('resize', () => engine.resize());

  // Init UI — handles model/VMD loading, playback, timeline
  const ui = new BabylonUI(app, { log, materialBuilder });
  await ui.init();
}

main().catch((err) => {
  console.error('Fatal:', err);
  log('Error: ' + err.message);
});
