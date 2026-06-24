// @ts-nocheck - MeshStandardNodeMaterial exposes runtime PBR fields beyond the current typings.
import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";

export function createPreviewTileMeshMaterial(params = {}) {
  return new MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    ...params
  });
}

export function replacePreviewMeshMaterials(root: THREE.Object3D) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) {
      return;
    }

    const previousMaterial = object.material;
    if (Array.isArray(previousMaterial)) {
      const nextMaterials = previousMaterial.map((material) => replacePreviewMaterial(material));
      object.material = nextMaterials;
      previousMaterial.forEach((material, index) => {
        if (material !== nextMaterials[index]) {
          material.dispose();
        }
      });
      return;
    }

    const nextMaterial = replacePreviewMaterial(previousMaterial);
    object.material = nextMaterial;
    if (previousMaterial !== nextMaterial) {
      previousMaterial.dispose();
    }
  });
}

function replacePreviewMaterial(source: THREE.Material) {
  if (source instanceof MeshStandardNodeMaterial) {
    return source;
  }

  const target = createPreviewTileMeshMaterial();
  copyPreviewMaterialBasics(source, target);

  if (source.isMeshStandardMaterial || source.isMeshPhysicalMaterial) {
    copyPreviewStandardPbr(source, target);
  } else if (source.isMeshBasicMaterial) {
    target.color.copy(source.color);
    assignPreviewTexture(target, "map", source.map);
    assignPreviewTexture(target, "alphaMap", source.alphaMap);
  } else {
    if ("color" in source && source.color instanceof THREE.Color) {
      target.color.copy(source.color);
    }
    if ("map" in source) {
      assignPreviewTexture(target, "map", source.map);
    }
  }

  return target;
}

function copyPreviewMaterialBasics(source: THREE.Material, target: THREE.Material) {
  target.name = source.name;
  target.side = source.side;
  target.vertexColors = source.vertexColors;
  target.opacity = source.opacity;
  target.transparent = source.transparent;
  target.alphaTest = source.alphaTest;
  target.alphaToCoverage = source.alphaToCoverage;
  target.depthTest = source.depthTest;
  target.depthWrite = source.depthWrite;
  target.toneMapped = source.toneMapped;
  target.visible = source.visible;
}

function copyPreviewStandardPbr(source, target) {
  target.color.copy(source.color);
  target.roughness = source.roughness;
  target.metalness = source.metalness;

  assignPreviewTexture(target, "map", source.map);
  assignPreviewTexture(target, "roughnessMap", source.roughnessMap);
  assignPreviewTexture(target, "metalnessMap", source.metalnessMap);
  assignPreviewTexture(target, "normalMap", source.normalMap);
  assignPreviewTexture(target, "aoMap", source.aoMap);
  assignPreviewTexture(target, "emissiveMap", source.emissiveMap);
  assignPreviewTexture(target, "alphaMap", source.alphaMap);
  assignPreviewTexture(target, "lightMap", source.lightMap);
  assignPreviewTexture(target, "bumpMap", source.bumpMap);
  assignPreviewTexture(target, "displacementMap", source.displacementMap);
  assignPreviewTexture(target, "envMap", source.envMap);

  target.lightMapIntensity = source.lightMapIntensity;
  target.aoMapIntensity = source.aoMapIntensity;
  target.emissive.copy(source.emissive);
  target.emissiveIntensity = source.emissiveIntensity;
  target.bumpScale = source.bumpScale;
  target.normalMapType = source.normalMapType;
  target.normalScale.copy(source.normalScale);
  target.displacementScale = source.displacementScale;
  target.displacementBias = source.displacementBias;
  target.envMapIntensity = source.envMapIntensity;
  target.wireframe = source.wireframe;
  target.wireframeLinewidth = source.wireframeLinewidth;
  target.flatShading = source.flatShading;
  target.fog = source.fog;

  if (source.envMapRotation != null && target.envMapRotation != null) {
    target.envMapRotation.copy(source.envMapRotation);
  }
}

function assignPreviewTexture(target, key, texture) {
  if (texture != null) {
    target[key] = texture;
  }
}

export class PreviewTileMaterialReplacementPlugin {
  priority = -1000;
  tiles = null;

  init(tiles) {
    this.tiles = tiles;
    tiles.forEachLoadedModel((scene) => {
      this.processTileModel(scene);
    });
  }

  processTileModel(scene) {
    replacePreviewMeshMaterials(scene);
  }
}
