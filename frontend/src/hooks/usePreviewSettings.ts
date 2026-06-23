import { useCallback, useEffect, useState } from "react";
import type { PreviewEngine, ThreeRendererPreference } from "../types/preview";

const PREVIEW_ENGINE_KEY = "previewEngine";
const THREE_RENDERER_KEY = "threeRenderer";

function readStorageValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorageValue(key: string, value: string) {
  try {
    if (window.localStorage.getItem(key) === value) {
      return;
    }
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in locked-down or private browser contexts.
  }
}

function readPreviewEngine(): PreviewEngine {
  return readStorageValue(PREVIEW_ENGINE_KEY) === "unreal" ? "unreal" : "three";
}

function readThreeRenderer(): ThreeRendererPreference {
  return readStorageValue(THREE_RENDERER_KEY) === "webgl" ? "webgl" : "webgpu";
}

export function usePreviewSettings() {
  const [previewEngine, setPreviewEngineState] = useState<PreviewEngine>(() => readPreviewEngine());
  const [threeRenderer, setThreeRendererState] = useState<ThreeRendererPreference>(() => readThreeRenderer());

  useEffect(() => {
    writeStorageValue(PREVIEW_ENGINE_KEY, previewEngine);
  }, [previewEngine]);

  useEffect(() => {
    writeStorageValue(THREE_RENDERER_KEY, threeRenderer);
  }, [threeRenderer]);

  const setPreviewEngine = useCallback((engine: PreviewEngine) => {
    setPreviewEngineState((current) => (current === engine ? current : engine));
  }, []);

  const setThreeRenderer = useCallback((renderer: ThreeRendererPreference) => {
    setThreeRendererState((current) => (current === renderer ? current : renderer));
  }, []);

  return {
    previewEngine,
    threeRenderer,
    setPreviewEngine,
    setThreeRenderer
  };
}
