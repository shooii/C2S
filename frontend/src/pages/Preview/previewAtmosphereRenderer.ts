// @ts-nocheck - Three WebGPU node exports are ahead of @types/three here.
import * as THREE from "three";
import { RedFormat } from "three";
import type { TilesRenderer } from "3d-tiles-renderer";
import { context, mrt, output, pass, toneMapping, uniform } from "three/tsl";
import { RenderPipeline, WebGPURenderer } from "three/webgpu";
import {
  getECIToECEFRotationMatrix,
  getMoonDirectionECI,
  getSunDirectionECI
} from "@takram/three-atmosphere";
import {
  aerialPerspective,
  AtmosphereContext,
  AtmosphereLight,
  AtmosphereLightNode,
  AtmosphereParameters,
  shadowLength,
  viewZUnit
} from "@takram/three-atmosphere/webgpu";
import {
  CascadedShadowMapsNode,
  dithering,
  highpVelocity,
  lensFlare,
  temporalAntialias
} from "@takram/three-geospatial/webgpu";
import { AgXPunchyToneMapping } from "./previewAgxToneMapping";

type PreviewRenderer = THREE.WebGLRenderer | InstanceType<typeof WebGPURenderer>;

export interface PreviewAtmosphereRenderer {
  render: () => void;
  dispose: () => void;
  readonly usesAtmosphereLighting: boolean;
}

interface PreviewAtmosphereRendererOptions {
  renderer: PreviewRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  ellipsoidFrame: THREE.Object3D;
  getGeospatialEllipsoid: () => unknown;
  getShadowTiles?: () => TilesRenderer[];
  getTimeMs?: () => number;
  getToneMappingExposure?: () => number;
}

const CELESTIAL_UPDATE_INTERVAL_MS = 60_000;
const DEFAULT_TONE_MAPPING_EXPOSURE = 35;
const SHADOW_FAR = 50_000;

const matrixScratch = new THREE.Matrix4();
const celestialMatrixScratch = new THREE.Matrix4();

export function getPreviewSunDirectionECEF(timeMs: number, target = new THREE.Vector3()): THREE.Vector3 {
  const date = new Date(Number.isFinite(timeMs) ? timeMs : Date.now());
  getECIToECEFRotationMatrix(date, celestialMatrixScratch);
  return getSunDirectionECI(date, target).applyMatrix4(celestialMatrixScratch).normalize();
}

export function createPreviewAtmosphereRenderer({
  renderer,
  scene,
  camera,
  ellipsoidFrame,
  getGeospatialEllipsoid,
  getShadowTiles,
  getTimeMs,
  getToneMappingExposure
}: PreviewAtmosphereRendererOptions): PreviewAtmosphereRenderer | null {
  if (!(renderer instanceof WebGPURenderer)) {
    return null;
  }

  const webgpuRenderer = renderer as InstanceType<typeof WebGPURenderer> & {
    contextNode?: { value?: Record<string, unknown> };
    library?: {
      addLight?: (nodeClass: unknown, lightClass: unknown) => void;
    };
    shadowMap?: { enabled?: boolean; transmitted?: boolean };
  };
  if (!webgpuRenderer.library?.addLight) {
    return null;
  }

  const previousContextNode = webgpuRenderer.contextNode;
  const previousToneMapping = webgpuRenderer.toneMapping;
  const previousToneMappingExposure = webgpuRenderer.toneMappingExposure;
  const atmosphereParameters = new AtmosphereParameters();
  atmosphereParameters.higherOrderScatteringTexture = true;
  const atmosphereContext = new AtmosphereContext(atmosphereParameters);
  atmosphereContext.camera = camera;
  atmosphereContext.showGround = true;
  atmosphereContext.raymarchScattering = true;

  webgpuRenderer.contextNode = context({
    ...(previousContextNode?.value ?? {}),
    getAtmosphere: () => atmosphereContext
  });
  webgpuRenderer.shadowMap.enabled = true;
  webgpuRenderer.shadowMap.transmitted = true;
  webgpuRenderer.toneMapping = THREE.NoToneMapping;
  webgpuRenderer.library.addLight(AtmosphereLightNode, AtmosphereLight);

  const sunlight = new AtmosphereLight(1, "sun");
  sunlight.name = "Takram Atmosphere Sun";
  sunlight.intensity = 1;
  sunlight.castShadow = true;
  sunlight.shadow.mapSize.width = 1024;
  sunlight.shadow.mapSize.height = 1024;
  sunlight.shadow.camera.near = 0;
  sunlight.shadow.camera.far = SHADOW_FAR * 4;

  const csmShadowNode = new CascadedShadowMapsNode(sunlight);
  csmShadowNode.cascades = 3;
  csmShadowNode.maxFar = SHADOW_FAR;
  csmShadowNode.fade = true;
  csmShadowNode.lightMargin = SHADOW_FAR * 2;
  sunlight.shadow.shadowNode = csmShadowNode;

  scene.add(sunlight);

  const passNode = pass(scene, camera, { samples: 0 }).setMRT(
    mrt({
      output,
      velocity: highpVelocity,
      viewZUnit
    })
  );
  const colorNode = passNode.getTextureNode("output");
  const depthNode = passNode.getTextureNode("depth");
  const velocityNode = passNode.getTextureNode("velocity");
  const viewZUnitNode = passNode.getTextureNode("viewZUnit");
  viewZUnitNode.value.format = RedFormat;

  const shadowLengthNode = shadowLength(csmShadowNode, viewZUnitNode);
  const aerialNode = aerialPerspective(colorNode.mul(2 / 3), depthNode, null, shadowLengthNode);
  const lensFlareNode = lensFlare(aerialNode);
  const toneMappingExposureNode = uniform(DEFAULT_TONE_MAPPING_EXPOSURE);
  const toneMappingNode = toneMapping(AgXPunchyToneMapping, toneMappingExposureNode, lensFlareNode);
  const outputNode = temporalAntialias(toneMappingNode, depthNode, velocityNode, camera).add(dithering);
  const renderPipeline = new RenderPipeline(renderer, outputNode);

  let disposed = false;
  let lastCelestialUpdateAt = 0;
  let lastControlledCelestialTimeMs = Number.NaN;

  const updateShadowTiles = () => {
    const activeTiles = getShadowTiles?.() ?? [];
    if (!activeTiles.length || csmShadowNode.lights.length === 0) {
      return;
    }
    const lastLight = csmShadowNode.lights[csmShadowNode.lights.length - 1];
    const shadowCamera = lastLight.shadow?.camera;
    const mapSize = lastLight.shadow?.mapSize;
    if (!shadowCamera || !mapSize) {
      return;
    }
    for (const tiles of activeTiles) {
      tiles.setCamera(shadowCamera);
      tiles.setResolution(shadowCamera, mapSize);
    }
  };

  const updateAtmosphereFrame = () => {
    ellipsoidFrame.updateMatrixWorld(true);
    atmosphereContext.matrixWorldToECEF.value.copy(matrixScratch.copy(ellipsoidFrame.matrixWorld).invert());
    atmosphereContext.ellipsoid = getGeospatialEllipsoid();
    toneMappingExposureNode.value = THREE.MathUtils.clamp(
      getToneMappingExposure?.() ?? DEFAULT_TONE_MAPPING_EXPOSURE,
      1,
      60
    );

    const now = Date.now();
    const controlledTimeMs = getTimeMs?.();
    const hasControlledTime = typeof controlledTimeMs === "number" && Number.isFinite(controlledTimeMs);
    const celestialTimeMs = hasControlledTime ? controlledTimeMs : now;
    if (
      (hasControlledTime && celestialTimeMs !== lastControlledCelestialTimeMs) ||
      (!hasControlledTime && now - lastCelestialUpdateAt >= CELESTIAL_UPDATE_INTERVAL_MS)
    ) {
      lastControlledCelestialTimeMs = celestialTimeMs;
      lastCelestialUpdateAt = now;
      const date = new Date(celestialTimeMs);
      getECIToECEFRotationMatrix(date, atmosphereContext.matrixECIToECEF.value);
      getSunDirectionECI(date, atmosphereContext.sunDirectionECEF.value).applyMatrix4(
        atmosphereContext.matrixECIToECEF.value
      ).normalize();
      getMoonDirectionECI(date, atmosphereContext.moonDirectionECEF.value).applyMatrix4(
        atmosphereContext.matrixECIToECEF.value
      ).normalize();
    }

    updateShadowTiles();
  };

  updateAtmosphereFrame();

  return {
    usesAtmosphereLighting: true,
    render: () => {
      if (disposed) {
        return;
      }
      updateAtmosphereFrame();
      renderPipeline.render();
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      renderPipeline.dispose();
      atmosphereContext.dispose();
      sunlight.dispose();
      scene.remove(sunlight);
      if (webgpuRenderer.contextNode !== previousContextNode) {
        webgpuRenderer.contextNode = previousContextNode;
      }
      webgpuRenderer.toneMapping = previousToneMapping;
      webgpuRenderer.toneMappingExposure = previousToneMappingExposure;
    }
  };
}
