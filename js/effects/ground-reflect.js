import { Mesh, PlaneGeometry, MeshBasicNodeMaterial } from 'three/webgpu';
import { reflector, positionView, smoothstep, float, uniform } from 'three/tsl';

export class GroundReflectEffect {
  constructor(scene) {
    this.scene = scene;

    const geo = new PlaneGeometry(200, 200);

    // Depth-only plane: opaque, renders before outlines (renderOrder -2),
    // writes depth at Y=0 so outline vertices below ground are occluded.
    const depthMat = new MeshBasicNodeMaterial();
    depthMat.colorWrite = false;
    this._depthPlane = new Mesh(geo, depthMat);
    this._depthPlane.rotateX(-Math.PI / 2);
    this._depthPlane.renderOrder = -2;
    this.scene.add(this._depthPlane);

    const reflect = reflector();
    const depth = positionView.z.negate();
    this._strength = uniform(0.4);
    const opacity = smoothstep(float(20.0), float(80.0), depth).mul(this._strength);
    const mat = new MeshBasicNodeMaterial();
    mat.transparent = true;
    mat.colorNode = reflect;
    mat.opacityNode = opacity;

    this._mesh = new Mesh(geo, mat);
    this._mesh.rotateX(-Math.PI / 2);
    this._mesh.renderOrder = -1;
    this._mesh.add(reflect.target);

    this.scene.add(this._mesh);
  }

  get enabled() { return this._mesh.visible; }
  set enabled(v) {
    this._mesh.visible = v;
    this._depthPlane.visible = v;
  }

  get strength() { return this._strength.value; }
  set strength(v) { this._strength.value = v; }

  dispose() {
    this.scene.remove(this._mesh);
    this.scene.remove(this._depthPlane);
    this._mesh.geometry.dispose();
    this._mesh.material.dispose();
    this._depthPlane.material.dispose();
  }
}
