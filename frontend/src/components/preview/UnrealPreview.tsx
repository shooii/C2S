import type { SceneViewState, UnrealConnectionStatus } from "../../types/preview";
import { PixelStreamingViewer } from "./PixelStreamingViewer";

export function UnrealPreview({
  url,
  sceneId,
  sceneViewState,
  onStatusChange,
  onSwitchToThree
}: {
  url: string;
  sceneId: string;
  sceneViewState: SceneViewState;
  onStatusChange: (status: UnrealConnectionStatus, message?: string) => void;
  onSwitchToThree: () => void;
}) {
  return (
    <PixelStreamingViewer
      url={url}
      sceneId={sceneId}
      sceneViewState={sceneViewState}
      onStatusChange={onStatusChange}
      onSwitchToThree={onSwitchToThree}
    />
  );
}
