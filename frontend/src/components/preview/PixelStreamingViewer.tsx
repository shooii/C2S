import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Empty, Space, Spin } from "antd";
import { FullscreenOutlined, ReloadOutlined } from "@ant-design/icons";
import type { SceneViewState, UnrealConnectionStatus } from "../../types/preview";

interface PixelStreamingWindow extends Window {
  PixelStreaming?: new (config: Record<string, unknown>, options?: Record<string, unknown>) => {
    connect?: () => void;
    disconnect?: () => void;
    close?: () => void;
    emitUIInteraction?: (payload: unknown) => void;
    addEventListener?: (event: string, handler: EventListener) => void;
    removeEventListener?: (event: string, handler: EventListener) => void;
  };
}

export function PixelStreamingViewer({
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
  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const pixelStreamingRef = useRef<InstanceType<NonNullable<PixelStreamingWindow["PixelStreaming"]>> | null>(null);
  const [status, setStatus] = useState<UnrealConnectionStatus>(url ? "connecting" : "idle");
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState("");
  const reconnectTimerRef = useRef<number | null>(null);

  const viewerUrl = useMemo(() => {
    if (!url) return "";
    const next = new URL(url, window.location.href);
    next.searchParams.set("sceneId", sceneId);
    return next.toString();
  }, [sceneId, url]);

  const updateStatus = useCallback((nextStatus: UnrealConnectionStatus, nextMessage = "") => {
    setStatus(nextStatus);
    setMessage(nextMessage);
    onStatusChange(nextStatus, nextMessage);
  }, [onStatusChange]);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    clearReconnectTimer();
    reconnectTimerRef.current = window.setTimeout(() => {
      setRevision((value) => value + 1);
      reconnectTimerRef.current = null;
    }, 3000);
  }, [clearReconnectTimer]);

  useEffect(() => {
    if (!viewerUrl || !containerRef.current) {
      updateStatus("idle", "");
      return undefined;
    }

    let disposed = false;
    const win = window as PixelStreamingWindow;
    const PixelStreaming = win.PixelStreaming;

    updateStatus("connecting", "正在连接 UE5 Pixel Streaming");

    if (PixelStreaming) {
      try {
        const instance = new PixelStreaming({
          streamUrl: viewerUrl,
          initialSettings: {
            AutoConnect: true,
            HoveringMouse: true
          },
          videoParent: containerRef.current
        });
        pixelStreamingRef.current = instance;
        const handleConnected = () => {
          if (disposed) return;
          clearReconnectTimer();
          updateStatus("connected", "UE5 Pixel Streaming 已连接");
        };
        const handleDisconnected = () => {
          if (disposed) return;
          updateStatus("disconnected", "UE5 Pixel Streaming 已断开，正在自动重连");
          scheduleReconnect();
        };
        const handleError = () => {
          if (disposed) return;
          updateStatus("error", "UE5 Pixel Streaming 连接失败，正在自动重连");
          scheduleReconnect();
        };
        instance.addEventListener?.("webRtcConnected", handleConnected);
        instance.addEventListener?.("webRtcDisconnected", handleDisconnected);
        instance.addEventListener?.("webRtcFailed", handleError);
        instance.connect?.();
        return () => {
          disposed = true;
          clearReconnectTimer();
          instance.removeEventListener?.("webRtcConnected", handleConnected);
          instance.removeEventListener?.("webRtcDisconnected", handleDisconnected);
          instance.removeEventListener?.("webRtcFailed", handleError);
          instance.disconnect?.();
          instance.close?.();
          pixelStreamingRef.current = null;
        };
      } catch (error) {
        updateStatus("error", error instanceof Error ? error.message : "UE5 Pixel Streaming 初始化失败");
      }
    }

    const frame = iframeRef.current;
    const handleLoad = () => {
      clearReconnectTimer();
      updateStatus("connected", "UE5 Pixel Streaming 页面已打开");
    };
    const handleError = () => {
      updateStatus("error", "UE5 Pixel Streaming 页面加载失败，正在自动重连");
      scheduleReconnect();
    };
    frame?.addEventListener("load", handleLoad);
    frame?.addEventListener("error", handleError);

    return () => {
      disposed = true;
      clearReconnectTimer();
      frame?.removeEventListener("load", handleLoad);
      frame?.removeEventListener("error", handleError);
      if (frame) {
        frame.src = "about:blank";
      }
      updateStatus("disconnected", "UE5 Pixel Streaming 已断开");
    };
  }, [clearReconnectTimer, revision, scheduleReconnect, updateStatus, viewerUrl]);

  useEffect(() => {
    const instance = pixelStreamingRef.current;
    if (instance && status === "connected") {
      instance.emitUIInteraction?.({
        type: "scene-state",
        sceneId,
        state: sceneViewState
      });
    }
    const frame = iframeRef.current;
    if (!frame?.contentWindow || status !== "connected") return;
    frame.contentWindow.postMessage({
      type: "c2s-preview-state",
      sceneId,
      state: sceneViewState
    }, "*");
  }, [sceneId, sceneViewState, status]);

  if (!url) {
    return (
      <div className="preview-unreal-empty">
        <Empty
          description="未配置 UE5 Pixel Streaming 服务地址"
        />
        <Button type="primary" onClick={onSwitchToThree}>切换到 Three.js</Button>
      </div>
    );
  }

  return (
    <div className="preview-pixel-streaming" ref={containerRef}>
      <iframe
        key={`${viewerUrl}-${revision}`}
        ref={iframeRef}
        title="UE5 Pixel Streaming"
        allow="fullscreen; autoplay; microphone; camera; gamepad; xr-spatial-tracking"
        src={viewerUrl}
      />
      {status === "connecting" ? (
        <div className="preview-stage-state">
          <Spin />
          <span>正在连接 UE5 Pixel Streaming</span>
        </div>
      ) : null}
      {status === "error" ? (
        <Alert
          className="preview-unreal-alert"
          type="error"
          showIcon
          message={message || "UE5 Pixel Streaming 连接失败"}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => {
            clearReconnectTimer();
            setRevision((value) => value + 1);
          }}>重连</Button>}
        />
      ) : null}
      <Space className="preview-unreal-actions">
        <Button icon={<ReloadOutlined />} onClick={() => {
          clearReconnectTimer();
          setRevision((value) => value + 1);
        }}>重连</Button>
        <Button
          icon={<FullscreenOutlined />}
          onClick={() => containerRef.current?.requestFullscreen?.()}
        >
          全屏
        </Button>
      </Space>
    </div>
  );
}
