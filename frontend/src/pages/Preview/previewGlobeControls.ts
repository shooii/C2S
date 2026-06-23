// @ts-nocheck - Three WebGPU node material typings lag behind the runtime API.
import type { GlobeControls } from "3d-tiles-renderer/three";
import type { Material, Mesh, Scene } from "three";
import {
  cameraProjectionMatrix,
  Fn,
  fwidth,
  modelViewMatrix,
  positionGeometry,
  screenDPR,
  screenSize,
  smoothstep,
  uniform,
  uv,
  vec4
} from "three/tsl";
import { NodeMaterial, type UniformNode } from "three/webgpu";

interface PivotUniforms {
  size: UniformNode<number>;
  thickness: UniformNode<number>;
  opacity: UniformNode<number>;
}

export type RuntimeGlobeControls = GlobeControls & {
  needsUpdate: boolean;
  state?: number;
  zoomDelta?: number;
  zoomDirectionSet?: boolean;
  zoomPointSet?: boolean;
  rotationInertia?: { lengthSq: () => number; set: (...values: number[]) => void };
  dragInertia?: { lengthSq: () => number; set: (...values: number[]) => void };
  globeInertia?: { identity: () => void };
  globeInertiaFactor?: number;
  pointerTracker?: { reset: () => void };
  _cancelInteractionMomentum?: (options?: { clearHint?: boolean }) => boolean;
  _inertiaNeedsUpdate?: () => boolean;
};

export interface PreviewGlobeControlsBehaviorOptions {
  overlayScene?: Scene;
  onInteraction: () => void;
  onInteractionHintChange: (hint: null) => void;
}

function createPivotMaterial(uniforms: PivotUniforms): Material {
  const size = uniforms.size.mul(screenDPR);
  const thickness = uniforms.thickness.mul(screenDPR);
  const opacity = uniforms.opacity;

  const material = new NodeMaterial();
  material.depthWrite = false;
  material.depthTest = false;
  material.transparent = true;

  material.vertexNode = Fn(() => {
    const aspect = screenSize.x.div(screenSize.y);
    const offset = uv().mul(2).sub(1);
    offset.y.mulAssign(aspect);

    const screenPoint = cameraProjectionMatrix
      .mul(modelViewMatrix)
      .mul(vec4(positionGeometry, 1));
    screenPoint.xy.addAssign(
      offset.mul(size.add(thickness)).mul(screenPoint.w).div(screenSize.x)
    );
    return screenPoint;
  })();

  material.outputNode = Fn(() => {
    const ht = thickness.mul(0.5);
    const planeDim = size.add(thickness);
    const offset = planeDim.sub(ht).sub(2).div(planeDim);
    const texelThickness = ht.div(planeDim);
    const vec = uv().mul(2).sub(1);
    const dist = vec.length().sub(offset).abs();
    const fw = fwidth(dist).mul(0.5);
    const a = smoothstep(texelThickness.sub(fw), texelThickness.add(fw), dist);
    return vec4(1, 1, 1, opacity.mul(a.oneMinus()));
  })();

  return material;
}

function modifyPivotMesh(originalPivotMesh: Mesh): Mesh {
  const pivotMesh = Object.assign(originalPivotMesh, {
    size: uniform(15),
    thickness: uniform(2),
    opacity: uniform(0.5)
  });
  const originalMaterial = pivotMesh.material as Material;
  originalMaterial.dispose();
  pivotMesh.material = createPivotMaterial(pivotMesh);
  pivotMesh.onBeforeRender = () => {};
  return pivotMesh;
}

function hasPendingNativeGlobeMotion(controls: RuntimeGlobeControls): boolean {
  return Boolean(
    controls.state ||
    controls.needsUpdate ||
    controls.zoomDelta ||
    controls._inertiaNeedsUpdate?.() ||
    controls.rotationInertia?.lengthSq?.() ||
    controls.dragInertia?.lengthSq?.() ||
    controls.globeInertiaFactor
  );
}

function clearNativeGlobeMotion(controls: RuntimeGlobeControls): void {
  controls.zoomDelta = 0;
  controls.zoomDirectionSet = false;
  controls.zoomPointSet = false;
  controls.rotationInertia?.set(0, 0);
  controls.dragInertia?.set(0, 0, 0);
  controls.globeInertia?.identity();
  controls.globeInertiaFactor = 0;
  controls.pointerTracker?.reset();
}

export function configurePreviewGlobeControls(
  controls: GlobeControls,
  {
    overlayScene,
    onInteraction,
    onInteractionHintChange
  }: PreviewGlobeControlsBehaviorOptions
): () => void {
  const runtimeControls = controls as RuntimeGlobeControls & { pivotMesh: Mesh };
  modifyPivotMesh(runtimeControls.pivotMesh);

  const movePivotToOverlay = () => {
    if (runtimeControls.pivotMesh.parent != null) {
      overlayScene?.add(runtimeControls.pivotMesh);
    }
  };
  const handleStart = () => {
    movePivotToOverlay();
    runtimeControls.adjustHeight = true;
    onInteractionHintChange(null);
    onInteraction();
  };
  const handleChange = () => {
    onInteraction();
  };
  const handleEnd = () => {
    onInteractionHintChange(null);
    onInteraction();
  };
  const cancelInteractionMomentum = (options: { clearHint?: boolean } = {}) => {
    const hadMotion = hasPendingNativeGlobeMotion(runtimeControls);
    if (!hadMotion) {
      return false;
    }
    clearNativeGlobeMotion(runtimeControls);
    runtimeControls.resetState();
    runtimeControls.needsUpdate = true;
    if (options.clearHint !== false) {
      onInteractionHintChange(null);
    }
    onInteraction();
    return true;
  };

  runtimeControls.adjustHeight = false;
  runtimeControls._cancelInteractionMomentum = cancelInteractionMomentum;
  runtimeControls.addEventListener("start", handleStart);
  runtimeControls.addEventListener("change", handleChange);
  runtimeControls.addEventListener("end", handleEnd);

  return () => {
    runtimeControls.removeEventListener("start", handleStart);
    runtimeControls.removeEventListener("change", handleChange);
    runtimeControls.removeEventListener("end", handleEnd);
    if (runtimeControls._cancelInteractionMomentum === cancelInteractionMomentum) {
      delete runtimeControls._cancelInteractionMomentum;
    }
  };
}
