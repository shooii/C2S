export type PreviewEngine = "three" | "unreal";
export type ThreeRendererPreference = "webgpu" | "webgl";
export type ThreeRendererBackend = "WebGPU" | "WebGL" | "WebGL2 fallback" | "Detecting";
export type PreviewLoadStatus = "idle" | "loading" | "ready" | "error";
export type UnrealConnectionStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";

export interface SceneViewState {
  camera?: {
    position: [number, number, number];
    target: [number, number, number];
  };
  selectedObjectId?: string;
  visibleLayerIds?: string[];
}

export interface PreviewRuntimeStatus {
  engine: PreviewEngine;
  renderer: ThreeRendererBackend | "UE5 Pixel Streaming" | "未连接";
  status: PreviewLoadStatus;
  message: string;
  fps?: number;
  unrealStatus?: UnrealConnectionStatus;
}
