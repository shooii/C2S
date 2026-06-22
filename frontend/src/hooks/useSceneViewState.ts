import { useCallback, useState } from "react";
import type { SceneViewState } from "../types/preview";

export function useSceneViewState(initialState: SceneViewState = {}) {
  const [sceneViewState, setSceneViewState] = useState<SceneViewState>(initialState);

  const mergeSceneViewState = useCallback((nextState: SceneViewState) => {
    setSceneViewState((current) => ({
      ...current,
      ...nextState,
      camera: nextState.camera || current.camera
    }));
  }, []);

  return {
    sceneViewState,
    setSceneViewState,
    mergeSceneViewState
  };
}
