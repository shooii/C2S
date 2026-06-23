import fs from "node:fs";
import type { Plugin } from "vite";

const EXTERNAL_IMAGE_VALIDATION = `
\t\tif ( image == null ) return;

\t\tif ( image instanceof HTMLImageElement ) {

\t\t\tif ( image.complete === false ) return;

\t\t\tconst sourceWidth = image.naturalWidth;
\t\t\tconst sourceHeight = image.naturalHeight;

\t\t\tif ( sourceWidth <= 0 || sourceHeight <= 0 ) return;

\t\t} else {

\t\t\tconst sourceWidth = image.width ?? image.videoWidth ?? 0;
\t\t\tconst sourceHeight = image.height ?? image.videoHeight ?? 0;

\t\t\tif ( sourceWidth <= 0 || sourceHeight <= 0 ) return;

\t\t}

`;

const SRC_COPY_ANCHOR =
  "_copyImageToTexture( image, textureGPU, textureDescriptorGPU, originDepth, flipY, premultiplyAlpha, mipLevel = 0 ) {\n\n\t\tconst device = this.backend.device;";

const SRC_COPY_REPLACEMENT =
  `_copyImageToTexture( image, textureGPU, textureDescriptorGPU, originDepth, flipY, premultiplyAlpha, mipLevel = 0 ) {${EXTERNAL_IMAGE_VALIDATION}\n\t\tconst device = this.backend.device;`;

const BUILD_COPY_ANCHOR =
  "_copyImageToTexture( image, textureGPU, textureDescriptorGPU, originDepth, flipY, premultiplyAlpha, mipLevel = 0 ) {\n\n\t\tif ( image.width === 0 || image.height === 0 ) {\n\n\t\t\treturn;\n\n\t\t}\n\n\t\tconst device = this.backend.device;";

const BUILD_COPY_REPLACEMENT =
  `_copyImageToTexture( image, textureGPU, textureDescriptorGPU, originDepth, flipY, premultiplyAlpha, mipLevel = 0 ) {${EXTERNAL_IMAGE_VALIDATION}\n\t\tconst device = this.backend.device;`;

const THREE_WEBGPU_TEXTURE_UTILS_SRC =
  /three[\\/]src[\\/]renderers[\\/]webgpu[\\/]utils[\\/]WebGPUTextureUtils\.js$/;

const THREE_WEBGPU_BUILD =
  /three[\\/]build[\\/]three\.webgpu(\.nodes)?\.js$/;

export function patchWebGPUExternalImageValidation(code: string): string {
  if (code.includes("image.naturalWidth") && code.includes("_copyImageToTexture")) {
    return code;
  }

  if (code.includes(BUILD_COPY_ANCHOR)) {
    return code.replace(BUILD_COPY_ANCHOR, BUILD_COPY_REPLACEMENT);
  }

  if (code.includes(SRC_COPY_ANCHOR)) {
    return code.replace(SRC_COPY_ANCHOR, SRC_COPY_REPLACEMENT);
  }

  return code;
}

function shouldPatchWebGPUExternalImage(id: string, code: string): boolean {
  if (!id.includes("node_modules/three") || !code.includes("_copyImageToTexture")) {
    return false;
  }

  return (
    THREE_WEBGPU_TEXTURE_UTILS_SRC.test(id) ||
    (THREE_WEBGPU_BUILD.test(id) && code.includes(BUILD_COPY_ANCHOR)) ||
    (THREE_WEBGPU_BUILD.test(id) && code.includes(SRC_COPY_ANCHOR))
  );
}

export function validateWebGPUExternalImagePlugin(): Plugin {
  return {
    name: "validate-webgpu-external-image",
    enforce: "pre",
    transform(code, id) {
      if (!shouldPatchWebGPUExternalImage(id, code)) {
        return null;
      }
      return { code: patchWebGPUExternalImageValidation(code), map: null };
    }
  };
}

export const validateWebGPUExternalImageEsbuild = {
  name: "validate-webgpu-external-image-esbuild",
  setup(build: {
    onLoad: (
      options: { filter: RegExp },
      callback: (args: { path: string }) => Promise<{ contents: string; loader: "js" }>
    ) => void;
  }) {
    build.onLoad(
      { filter: /three[\\/](src[\\/]renderers[\\/]webgpu[\\/]utils[\\/]WebGPUTextureUtils\.js|build[\\/]three\.webgpu(\.nodes)?\.js)$/ },
      async (args) => ({
        contents: patchWebGPUExternalImageValidation(
          await fs.promises.readFile(args.path, "utf8")
        ),
        loader: "js"
      })
    );
  }
};
