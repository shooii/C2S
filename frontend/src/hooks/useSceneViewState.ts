import { useCallback, useState } from "react";
import type { SceneViewState } from "../types/preview";

const SCENE_VIEW_NUMBER_EPSILON = 1e-6;

function areSceneViewTuplesEqual(
  first?: [number, number, number],
  second?: [number, number, number]
): boolean {
  if (first === second) {
    return true;
  }
  if (!first || !second) {
    return false;
  }
  return first.every((value, index) => Math.abs(value - second[index]) <= SCENE_VIEW_NUMBER_EPSILON);
}

function areSceneViewCamerasEqual(
  first: SceneViewState["camera"],
  second: SceneViewState["camera"]
): boolean {
  if (first === second) {
    return true;
  }
  if (!first || !second) {
    return false;
  }
  return areSceneViewTuplesEqual(first.position, second.position) &&
    areSceneViewTuplesEqual(first.target, second.target);
}

function normalizeSceneViewIds(ids?: string[]): string[] | undefined {
  return ids ? Array.from(new Set(ids)).sort() : undefined;
}

function areSceneViewIdListsEqual(first?: string[], second?: string[]): boolean {
  if (first === second) {
    return true;
  }
  if (!first || !second) {
    return false;
  }
  const normalizedFirst = normalizeSceneViewIds(first)!;
  const normalizedSecond = normalizeSceneViewIds(second)!;
  return normalizedFirst.length === normalizedSecond.length &&
    normalizedFirst.every((id, index) => id === normalizedSecond[index]);
}

function isSameSceneViewState(first: SceneViewState, second: SceneViewState): boolean {
  return areSceneViewCamerasEqual(first.camera, second.camera) &&
    (first.selectedObjectId || undefined) === (second.selectedObjectId || undefined) &&
    areSceneViewIdListsEqual(first.visibleLayerIds, second.visibleLayerIds);
}

function mergeSceneViewStateValue(current: SceneViewState, nextState: SceneViewState): SceneViewState {
  return {
    ...current,
    ...nextState,
    camera: nextState.camera || current.camera
  };
}

export function useSceneViewState(initialState: SceneViewState = {}) {
  const [sceneViewState, setSceneViewState] = useState<SceneViewState>(initialState);

  const replaceSceneViewState = useCallback((nextState: SceneViewState) => {
    setSceneViewState((current) => (
      isSameSceneViewState(current, nextState) ? current : nextState
    ));
  }, []);

  const mergeSceneViewState = useCallback((nextState: SceneViewState) => {
    setSceneViewState((current) => {
      const next = mergeSceneViewStateValue(current, nextState);
      return isSameSceneViewState(current, next) ? current : next;
    });
  }, []);

  return {
    sceneViewState,
    setSceneViewState: replaceSceneViewState,
    mergeSceneViewState
  };
}
