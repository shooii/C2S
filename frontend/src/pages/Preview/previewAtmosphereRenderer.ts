// @ts-nocheck - Three WebGPU node exports are ahead of @types/three here.
import * as THREE from "three";
import { RedFormat } from "three";
import { context, mrt, output, pass } from "three/tsl";
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
  viewZUnit
} from "@takram/three-atmosphere/webgpu";
import {
  dithering,
  highpVelocity,
  lensFlare,
  temporalAntialias
} from "@takram/three-geospatial/webgpu";

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
}

const CELESTIAL_UPDATE_INTERVAL_MS = 60_000;

const matrixScratch = new THREE.Matrix4();

export function createPreviewAtmosphereRenderer({
  renderer,
  scene,
  camera,
  ellipsoidFrame,
  getGeospatialEllipsoid
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
  webgpuRenderer.library.addLight(AtmosphereLightNode, AtmosphereLight);

  const sunlight = new AtmosphereLight(1, "sun");
  sunlight.name = "Takram Atmosphere Sun";
  sunlight.intensity = 1;
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

  const aerialNode = aerialPerspective(colorNode.mul(2 / 3), depthNode, null, null);
  const lensFlareNode = lensFlare(aerialNode);
  const outputNode = temporalAntialias(lensFlareNode, depthNode, velocityNode, camera).add(dithering);
  const renderPipeline = new RenderPipeline(renderer, outputNode);

  let disposed = false;
  let lastCelestialUpdate = 0;

  const updateAtmosphereFrame = () => {
    ellipsoidFrame.updateMatrixWorld(true);
    atmosphereContext.matrixWorldToECEF.value.copy(matrixScratch.copy(ellipsoidFrame.matrixWorld).invert());
    atmosphereContext.ellipsoid = getGeospatialEllipsoid();

    const now = Date.now();
    if (now - lastCelestialUpdate >= CELESTIAL_UPDATE_INTERVAL_MS) {
      lastCelestialUpdate = now;
      const date = new Date(now);
      getECIToECEFRotationMatrix(date, atmosphereContext.matrixECIToECEF.value);
      getSunDirectionECI(date, atmosphereContext.sunDirectionECEF.value).applyMatrix4(
        atmosphereContext.matrixECIToECEF.value
      );
      getMoonDirectionECI(date, atmosphereContext.moonDirectionECEF.value).applyMatrix4(
        atmosphereContext.matrixECIToECEF.value
      );
    }
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
    }
  };
}
