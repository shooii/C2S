import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Divider,
  Empty,
  InputNumber,
  Radio,
  Result,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography
} from "antd";
import {
  AimOutlined,
  ArrowLeftOutlined,
  CloseOutlined,
  ColumnHeightOutlined,
  CompressOutlined,
  DownOutlined,
  DragOutlined,
  EnvironmentOutlined,
  FileOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  HomeOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  NodeIndexOutlined,
  ReloadOutlined,
  RightOutlined,
  RotateRightOutlined,
  SettingOutlined,
  StarOutlined,
  UndoOutlined
} from "@ant-design/icons";
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { USDLoader } from "three/examples/jsm/loaders/USDLoader.js";
import { Ellipsoid as GeospatialEllipsoid, Geodetic } from "@takram/three-geospatial";
import { GlobeControls, TilesRenderer, WGS84_ELLIPSOID, type Ellipsoid as TilesEllipsoid } from "3d-tiles-renderer/three";
import { CesiumIonAuthPlugin } from "3d-tiles-renderer/core/plugins";
import { GLTFExtensionsPlugin, TilesFadePlugin, UpdateOnChangePlugin } from "3d-tiles-renderer/three/plugins";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../../services/api";
import { EngineSelector } from "../../components/preview/EngineSelector";
import { RendererSelector } from "../../components/preview/RendererSelector";
import { UnrealPreview } from "../../components/preview/UnrealPreview";
import { usePreviewSettings } from "../../hooks/usePreviewSettings";
import { useSceneViewState } from "../../hooks/useSceneViewState";
import { useWebGPUSupport } from "../../hooks/useWebGPUSupport";
import type {
  PreviewGeoPlacement,
  PreviewPayload,
  PreviewSceneMode,
  PreviewState,
  PreviewTransform,
  ResultFile
} from "../../types";
import type {
  PreviewEngine,
  PreviewLoadStatus,
  PreviewRuntimeStatus,
  SceneViewState,
  ThreeRendererBackend,
  ThreeRendererPreference,
  UnrealConnectionStatus
} from "../../types/preview";

type TransformMode = "translate" | "rotate" | "scale";
type RendererBackend = ThreeRendererBackend;
type LoadStatus = PreviewLoadStatus;
type ViewCommand = "fit" | "reset" | null;
type LayerVisibilityState = "visible" | "hidden" | "partial";
type PreviewSaveState = "idle" | "saving" | "saved" | "error";

interface PreviewViewOptions {
  stars: boolean;
}

interface LayerNode {
  key: string;
  title: string;
  children?: LayerNode[];
}

interface SceneInfo {
  backend: RendererBackend;
  status: LoadStatus;
  message: string;
  meshes: number;
  vertices: number;
  fps?: number;
}

type PreviewRenderer = THREE.WebGLRenderer | InstanceType<typeof WebGPURenderer>;
interface PreviewRendererResult {
  renderer: PreviewRenderer;
  backend: RendererBackend;
  fallbackMessage?: string;
}

interface EllipsoidContext {
  tilesEllipsoid: TilesEllipsoid;
  geospatialEllipsoid: GeospatialEllipsoid;
  group: THREE.Object3D;
}

interface LoadedPreviewObject {
  object: THREE.Object3D;
  name: string;
  tiles?: TilesRenderer;
  isPhotorealisticGlobe?: boolean;
}

interface SurfacePlacement {
  point: THREE.Vector3;
}

interface LayerTreeOptions {
  rootTitle?: string;
  shallow?: boolean;
}

interface CanvasPointerIntent {
  id: number;
  x: number;
  y: number;
}

const DEFAULT_TRANSFORM: PreviewTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  geo: { longitude: 0, latitude: 0, height: 0 }
};

const TRANSFORM_MODE_OPTIONS: Array<{
  value: TransformMode;
  label: string;
  tooltip: string;
  icon: ReactNode;
}> = [
  { value: "translate", label: "平移", tooltip: "切换到平移", icon: <DragOutlined /> },
  { value: "rotate", label: "旋转", tooltip: "切换到旋转", icon: <RotateRightOutlined /> },
  { value: "scale", label: "缩放", tooltip: "切换到缩放", icon: <CompressOutlined /> }
];

const METERS_PER_DEGREE = 111_319.49079327358;
const DEFAULT_GLOBE_LONGITUDE = 104;
const DEFAULT_GLOBE_LATITUDE = 30;
const DEFAULT_GLOBE_HEIGHT = 15_500_000;
const MIN_GLOBE_ZOOM_DISTANCE = 2;
const MIN_GLOBE_CAMERA_NEAR = 0.001;
const MAX_GLOBE_CAMERA_FAR = 120_000_000;
const MIN_GLOBE_FOCUS_DISTANCE = 0.5;
const CESIUM_RIGHT_DRAG_ZOOM_SPEED = 0.85;
const CESIUM_DOUBLE_CLICK_ZOOM_DELTA = 360;
const WEBGPU_FALLBACK_MESSAGE = "当前环境无法使用 WebGPU，已自动切换为 WebGL。";
const CESIUM_ION_TOKEN = String(import.meta.env.VITE_CESIUM_ION_TOKEN || "").trim();
const CESIUM_ION_ASSET_ID = String(import.meta.env.VITE_CESIUM_ION_ASSET_ID || "2275207").trim();
const UE_PIXEL_STREAMING_URL = String(import.meta.env.VITE_UE_PIXEL_STREAMING_URL || "").trim();
const GEOSPATIAL_WGS84 = GeospatialEllipsoid.WGS84;
// three-geospatial ENU uses Z as local Up, matching the preview transform fields.
const OBJECT_FRAME_ADJUSTMENT = new THREE.Matrix4();
const IMPORT_OBJECT_FRAME_ADJUSTMENT = new THREE.Matrix4().makeRotationX(Math.PI / 2);

THREE.Cache.enabled = true;

export default function Preview() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const fileId = searchParams.get("fileId") || undefined;
  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<PreviewPayload | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!taskId) return;
    let disposed = false;
    const load = async () => {
      setLoading(true);
      setLoadError("");
      try {
        const nextPayload = await api.getPreview(taskId, fileId);
        if (!disposed) {
          setPayload(nextPayload);
        }
      } catch (error) {
        if (!disposed) {
          setPayload(null);
          setLoadError(error instanceof Error ? error.message : "预览数据加载失败");
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [fileId, reloadToken, taskId]);

  useEffect(() => {
    if (!payload?.file?.id || fileId === payload.file.id) {
      return;
    }
    setSearchParams({ fileId: payload.file.id }, { replace: true });
  }, [fileId, payload?.file?.id, setSearchParams]);

  if (loading) {
    return (
      <div className="center-state">
        <Spin />
      </div>
    );
  }

  if (!payload) {
    if (loadError) {
      return (
        <Result
          status="error"
          title="预览加载失败"
          subTitle={loadError}
          extra={[
            <Button key="back" onClick={() => navigate(`/results/${taskId}`)}>返回任务详情</Button>,
            <Button key="retry" type="primary" onClick={() => setReloadToken((value) => value + 1)}>
              重试
            </Button>
          ]}
        />
      );
    }
    return <Empty description="预览数据不存在" />;
  }

  return (
    <PreviewWorkspace
      payload={payload}
      taskId={taskId || payload.task.id}
      onBack={() => navigate(`/results/${taskId}`)}
      onReload={() => setReloadToken((value) => value + 1)}
      onSelectFile={(nextFileId) => setSearchParams({ fileId: nextFileId })}
    />
  );
}

function PreviewWorkspace({
  payload,
  taskId,
  onBack,
  onReload,
  onSelectFile
}: {
  payload: PreviewPayload;
  taskId: string;
  onBack: () => void;
  onReload: () => void;
  onSelectFile: (fileId: string) => void;
}) {
  const initialState = payload.file?.previewState || null;
  const initialSceneMode = normalizeSceneMode(initialState, payload.type);
  const { previewEngine, threeRenderer, setPreviewEngine, setThreeRenderer } = usePreviewSettings();
  const webgpuSupport = useWebGPUSupport();
  const { sceneViewState, setSceneViewState, mergeSceneViewState } = useSceneViewState();
  const [sceneMode, setSceneMode] = useState<PreviewSceneMode>(() => initialSceneMode);
  const [transform, setTransform] = useState<PreviewTransform>(() => normalizeTransformState(initialState, initialSceneMode));
  const [selectedLayerKey, setSelectedLayerKey] = useState<string | null>(() => initialState?.selectedLayerKey || null);
  const [hiddenLayerKeys, setHiddenLayerKeys] = useState<string[]>(() => initialState?.hiddenLayerKeys || []);
  const [expandedLayerKeys, setExpandedLayerKeys] = useState<string[]>([]);
  const [layerTree, setLayerTree] = useState<LayerNode[]>([]);
  const [transformMode, setTransformMode] = useState<TransformMode>("translate");
  const [viewOptions, setViewOptions] = useState<PreviewViewOptions>({
    stars: true
  });
  const [viewCommand, setViewCommand] = useState<ViewCommand>(null);
  const [placementMode, setPlacementMode] = useState(false);
  const [sceneInfo, setSceneInfo] = useState<SceneInfo>({
    backend: "Detecting",
    status: "idle",
    message: "",
    meshes: 0,
    vertices: 0
  });
  const [unrealStatus, setUnrealStatus] = useState<UnrealConnectionStatus>("idle");
  const [unrealMessage, setUnrealMessage] = useState("");
  const [engineSwitching, setEngineSwitching] = useState(false);
  const [saveState, setSaveState] = useState<PreviewSaveState>("idle");
  const [saveRevision, setSaveRevision] = useState(0);
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(() => shouldDefaultCollapseLayerPanel());
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(() => shouldDefaultCollapseInspector());
  const [stageFullscreen, setStageFullscreen] = useState(false);
  const leftPanelTouchedRef = useRef(false);
  const rightPanelTouchedRef = useRef(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const fileKey = payload.file?.id || "none";

  useEffect(() => {
    const nextState = payload.file?.previewState || null;
    const nextSceneMode = normalizeSceneMode(nextState, payload.type);
    setSceneMode(nextSceneMode);
    setTransform(normalizeTransformState(nextState, nextSceneMode));
    setSelectedLayerKey(nextState?.selectedLayerKey || null);
    setHiddenLayerKeys(nextState?.hiddenLayerKeys || []);
    setExpandedLayerKeys([]);
    setLayerTree([]);
    setTransformMode("translate");
    setViewCommand(null);
    setPlacementMode(false);
    setSaveState("idle");
    setSaveRevision(0);
    setSceneViewState({});
    leftPanelTouchedRef.current = false;
    rightPanelTouchedRef.current = false;
    setLeftPanelCollapsed(shouldDefaultCollapseLayerPanel());
    setRightPanelCollapsed(shouldDefaultCollapseInspector());
  }, [fileKey, payload.type, setSceneViewState]);

  useEffect(() => {
    const syncPreviewResponsiveLayout = () => {
      if (!leftPanelTouchedRef.current) {
        setLeftPanelCollapsed(shouldDefaultCollapseLayerPanel());
      }
      if (!rightPanelTouchedRef.current) {
        setRightPanelCollapsed(shouldDefaultCollapseInspector());
      }
    };
    syncPreviewResponsiveLayout();
    window.addEventListener("resize", syncPreviewResponsiveLayout);
    return () => window.removeEventListener("resize", syncPreviewResponsiveLayout);
  }, []);

  useEffect(() => {
    setEngineSwitching(true);
    const timer = window.setTimeout(() => setEngineSwitching(false), 180);
    return () => window.clearTimeout(timer);
  }, [previewEngine, threeRenderer]);

  useEffect(() => {
    if (!webgpuSupport.checking && !webgpuSupport.supported && threeRenderer === "webgpu") {
      setThreeRenderer("webgl");
    }
  }, [setThreeRenderer, threeRenderer, webgpuSupport.checking, webgpuSupport.supported]);

  const markDirty = useCallback(() => {
    setSaveRevision((value) => value + 1);
  }, []);

  const updateTransform = useCallback((next: PreviewTransform) => {
    setTransform(normalizeTransformForScene(next, sceneMode));
    markDirty();
  }, [markDirty, sceneMode]);

  const updateSelectedLayer = useCallback((key: string | null) => {
    setSelectedLayerKey(key);
    markDirty();
  }, [markDirty]);

  const updateHiddenLayers = useCallback((keys: string[]) => {
    setHiddenLayerKeys(keys);
    setSelectedLayerKey((current) => (current && keys.includes(current) ? null : current));
    markDirty();
  }, [markDirty]);

  const updateLayerTree = useCallback((tree: LayerNode[]) => {
    setLayerTree(tree);
    setExpandedLayerKeys((current) => {
      if (current.length) return current;
      return collectExpandableLayerKeys(tree);
    });
  }, []);

  const expandLayerPanel = useCallback(() => {
    leftPanelTouchedRef.current = true;
    setLeftPanelCollapsed(false);
  }, []);

  const collapseLayerPanel = useCallback(() => {
    leftPanelTouchedRef.current = true;
    setLeftPanelCollapsed(true);
  }, []);

  const expandInspector = useCallback(() => {
    rightPanelTouchedRef.current = true;
    setRightPanelCollapsed(false);
  }, []);

  const collapseInspector = useCallback(() => {
    rightPanelTouchedRef.current = true;
    setRightPanelCollapsed(true);
  }, []);

  const handleSceneInfoChange = useCallback((info: SceneInfo) => {
    setSceneInfo((current) => ({
      ...info,
      fps: info.fps ?? current.fps
    }));
  }, []);

  const toggleExpandedLayer = useCallback((key: string) => {
    setExpandedLayerKeys((current) => (
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key]
    ));
  }, []);

  const handlePlacementDone = useCallback(() => {
    setPlacementMode(false);
  }, []);

  useEffect(() => {
    if (!placementMode) {
      return;
    }
    const handlePlacementKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setPlacementMode(false);
    };
    window.addEventListener("keydown", handlePlacementKeyDown);
    return () => window.removeEventListener("keydown", handlePlacementKeyDown);
  }, [placementMode]);

  const handleSceneViewStateChange = useCallback((nextState: SceneViewState) => {
    mergeSceneViewState(nextState);
  }, [mergeSceneViewState]);

  const handleUnrealStatusChange = useCallback((status: UnrealConnectionStatus, message = "") => {
    setUnrealStatus(status);
    setUnrealMessage(message);
  }, []);

  const toggleViewOption = useCallback((key: keyof PreviewViewOptions) => {
    setViewOptions((current) => ({
      ...current,
      [key]: !current[key]
    }));
  }, []);

  useEffect(() => {
    const syncStageFullscreen = () => {
      setStageFullscreen(document.fullscreenElement === stageRef.current);
    };
    syncStageFullscreen();
    document.addEventListener("fullscreenchange", syncStageFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncStageFullscreen);
  }, []);

  const toggleStageFullscreen = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    if (document.fullscreenElement === stage) {
      void document.exitFullscreen?.();
      return;
    }
    void stage.requestFullscreen?.();
  }, []);

  useEffect(() => {
    if (!payload.file?.id || !isModelPreviewType(payload.type) || saveRevision === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      setSaveState("saving");
      const previewState: PreviewState = {
        sceneMode,
        transform: {
          ...transform,
          updatedAt: new Date().toISOString()
        },
        selectedLayerKey,
        hiddenLayerKeys
      };
      api.updatePreviewState(taskId, payload.file!.id, previewState)
        .then(() => setSaveState("saved"))
        .catch(() => setSaveState("error"));
    }, 650);

    return () => window.clearTimeout(timer);
  }, [hiddenLayerKeys, payload.file, payload.type, saveRevision, sceneMode, selectedLayerKey, taskId, transform]);

  useEffect(() => {
    if (saveState !== "saved") {
      return;
    }
    const timer = window.setTimeout(() => setSaveState("idle"), 1600);
    return () => window.clearTimeout(timer);
  }, [saveState]);

  const allLayerKeys = useMemo(() => flattenLayerKeys(layerTree), [layerTree]);
  const checkedLayerKeys = useMemo(
    () => allLayerKeys.filter((key) => !hiddenLayerKeys.includes(key)),
    [allLayerKeys, hiddenLayerKeys]
  );
  const isModel = isModelPreviewType(payload.type);
  const hasUnrealPreview = Boolean(UE_PIXEL_STREAMING_URL);
  const activePreviewEngine: PreviewEngine = hasUnrealPreview ? previewEngine : "three";
  const canEditScene = isModel && activePreviewEngine === "three";
  const runtimeStatus: PreviewRuntimeStatus = activePreviewEngine === "three"
    ? {
      engine: "three",
      renderer: sceneInfo.backend,
      status: sceneInfo.status,
      message: sceneInfo.message,
      fps: sceneInfo.fps
    }
    : {
      engine: "unreal",
      renderer: UE_PIXEL_STREAMING_URL ? "UE5 Pixel Streaming" : "未连接",
      status: unrealStatus === "connected" ? "ready" : unrealStatus === "error" ? "error" : unrealStatus === "idle" ? "idle" : "loading",
      message: unrealMessage,
      unrealStatus
    };
  const fpsValue = activePreviewEngine === "three" && isModel && runtimeStatus.fps && runtimeStatus.fps > 0
    ? Math.round(runtimeStatus.fps)
    : null;
  const fpsLabel = fpsValue ? String(fpsValue) : null;

  useEffect(() => {
    if (!hasUnrealPreview && previewEngine === "unreal") {
      setPreviewEngine("three");
    }
  }, [hasUnrealPreview, previewEngine, setPreviewEngine]);

  useEffect(() => {
    if (canEditScene) {
      return;
    }
    setPlacementMode(false);
    setTransformMode("translate");
  }, [canEditScene]);
  const workspaceClassName = [
    "preview-workspace",
    leftPanelCollapsed ? "is-left-collapsed" : "",
    rightPanelCollapsed ? "is-right-collapsed" : ""
  ].filter(Boolean).join(" ");
  const showSceneShortcutTools = canEditScene && (rightPanelCollapsed || stageFullscreen);
  const showInspectorShortcutActions = canEditScene && !stageFullscreen;

  return (
    <div className="page-stack preview-page">
      <div className="toolbar preview-toolbar">
        <Space className="preview-titlebar">
          <Button icon={<ArrowLeftOutlined />} onClick={onBack}>返回</Button>
          <Space direction="vertical" size={0}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              在线三维预览
            </Typography.Title>
            <Typography.Text type="secondary">{payload.task.taskName}</Typography.Text>
          </Space>
        </Space>
        <Space wrap className="preview-engine-toolbar">
          {hasUnrealPreview ? (
            <div className="preview-toolbar-control">
              <span>预览引擎</span>
              <EngineSelector
                value={activePreviewEngine}
                disabled={engineSwitching}
                onChange={setPreviewEngine}
              />
            </div>
          ) : null}
          {activePreviewEngine === "three" ? (
            <div className="preview-toolbar-control">
              <RendererSelector
                value={threeRenderer}
                webgpuSupported={webgpuSupport.supported}
                webgpuChecking={webgpuSupport.checking}
                webgpuReason={webgpuSupport.reason}
                onChange={setThreeRenderer}
              />
            </div>
          ) : null}
          {saveState !== "idle" ? (
            <Tag color={saveState === "error" ? "error" : saveState === "saved" ? "success" : "processing"}>
              {saveLabel(saveState)}
            </Tag>
          ) : null}
          <Tooltip title="刷新">
            <Button
              aria-label="刷新"
              className="preview-toolbar-icon-button"
              icon={<ReloadOutlined />}
              onClick={onReload}
            />
          </Tooltip>
        </Space>
      </div>

      <div className={workspaceClassName}>
        {leftPanelCollapsed ? (
          <div className="preview-panel preview-rail is-left">
            <Tooltip title="展开成果与图层">
              <Button
                aria-label="展开成果与图层"
                icon={<MenuUnfoldOutlined />}
                onClick={expandLayerPanel}
              />
            </Tooltip>
          </div>
        ) : (
        <div className="preview-panel preview-side preview-side-stack">
          <section className="preview-side-section">
            <div className="preview-panel-header">
              <Typography.Title level={5}>成果文件</Typography.Title>
              <Tooltip title="收起成果与图层">
                <Button
                  aria-label="收起成果与图层"
                  icon={<MenuFoldOutlined />}
                  size="small"
                  type="text"
                  onClick={collapseLayerPanel}
                />
              </Tooltip>
            </div>
            <PreviewFileList
              files={payload.files}
              selectedFileId={payload.file?.id || null}
              onSelectFile={onSelectFile}
            />
          </section>

          <Divider />

          <section className="preview-side-section preview-layer-section">
            <Space className="preview-section-heading">
              <NodeIndexOutlined />
              <Typography.Title level={5}>模型图层</Typography.Title>
            </Space>
            {layerTree.length ? (
              <LayerTreeView
                nodes={layerTree}
                checkedKeys={checkedLayerKeys}
                expandedKeys={expandedLayerKeys}
                selectedKey={selectedLayerKey}
                onSelect={updateSelectedLayer}
                onFocusLayer={updateSelectedLayer}
                onToggleExpanded={toggleExpandedLayer}
                onToggle={(node) => {
                  const nodeKeys = collectNodeKeys(node);
                  const checkedSet = new Set(checkedLayerKeys);
                  const shouldHide = nodeKeys.every((key) => checkedSet.has(key));
                  nodeKeys.forEach((key) => {
                    if (shouldHide) {
                      checkedSet.delete(key);
                    } else {
                      checkedSet.add(key);
                    }
                  });
                  updateHiddenLayers(allLayerKeys.filter((key) => !checkedSet.has(key)));
                }}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={isModel ? "模型加载后显示层级" : "当前文件无图层树"} />
            )}
          </section>
        </div>
        )}

        <div ref={stageRef} className="preview-panel preview-stage">
          <PreviewStage
            payload={payload}
            activeEngine={activePreviewEngine}
            threeRenderer={threeRenderer}
            sceneMode={sceneMode}
            transform={transform}
            transformMode={transformMode}
            selectedLayerKey={selectedLayerKey}
            hiddenLayerKeys={hiddenLayerKeys}
            placementMode={placementMode}
            canEditScene={canEditScene}
            viewOptions={viewOptions}
            viewCommand={viewCommand}
            sceneViewState={sceneViewState}
            onLayerTreeChange={updateLayerTree}
            onSceneInfoChange={handleSceneInfoChange}
            onSceneViewStateChange={handleSceneViewStateChange}
            onSelectLayer={updateSelectedLayer}
            onTransformChange={updateTransform}
            onPlacementDone={handlePlacementDone}
            onPlacementCancel={() => setPlacementMode(false)}
            onViewCommandHandled={() => setViewCommand(null)}
            onRendererFallback={(message) => {
              setSceneInfo((current) => ({
                ...current,
                backend: "WebGL",
                status: "loading",
                message
              }));
              setThreeRenderer("webgl");
            }}
            onSwitchToThree={() => setPreviewEngine("three")}
            onUnrealStatusChange={handleUnrealStatusChange}
          />
          {engineSwitching ? (
            <div className="preview-switch-mask">
              <Spin />
              <span>正在切换预览引擎</span>
            </div>
          ) : null}
          {showSceneShortcutTools ? (
            <div className="preview-scene-tools" aria-label="场景快捷工具">
              <Tooltip title="聚焦模型">
                <Button
                  aria-label="聚焦模型"
                  icon={<AimOutlined />}
                  onClick={() => setViewCommand("fit")}
                />
              </Tooltip>
              <Tooltip title="重置视角">
                <Button
                  aria-label="重置视角"
                  icon={<HomeOutlined />}
                  onClick={() => setViewCommand("reset")}
                />
              </Tooltip>
              <Tooltip title={placementMode ? "退出地表落位" : "地表落位"}>
                <Button
                  aria-label="地表落位"
                  aria-pressed={placementMode}
                  type={placementMode ? "primary" : "default"}
                  icon={<EnvironmentOutlined />}
                  onClick={() => setPlacementMode((value) => !value)}
                />
              </Tooltip>
              <Tooltip title="回正姿态">
                <Button
                  aria-label="回正姿态"
                  icon={<ColumnHeightOutlined />}
                  onClick={() => updateTransform(normalizeUprightTransform(transform, sceneMode))}
                />
              </Tooltip>
              <Tooltip title="重置变换">
                <Button
                  aria-label="重置变换"
                  icon={<UndoOutlined />}
                  onClick={() => updateTransform(normalizeResetTransform(transform, sceneMode))}
                />
              </Tooltip>
              <Tooltip title={stageFullscreen ? "退出全屏" : "全屏"}>
                <Button
                  aria-label={stageFullscreen ? "退出全屏" : "全屏"}
                  aria-pressed={stageFullscreen}
                  icon={stageFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                  onClick={toggleStageFullscreen}
                />
              </Tooltip>
              <div className="preview-scene-mode-switch" aria-label="模型变换模式">
                {TRANSFORM_MODE_OPTIONS.map((mode) => (
                  <Tooltip title={mode.tooltip} key={mode.value}>
                    <Button
                      aria-label={mode.tooltip}
                      aria-pressed={transformMode === mode.value}
                      className={transformMode === mode.value ? "is-active" : undefined}
                      icon={mode.icon}
                      type={transformMode === mode.value ? "primary" : "default"}
                      onClick={() => setTransformMode(mode.value)}
                    />
                  </Tooltip>
                ))}
              </div>
            </div>
          ) : null}
          {fpsLabel ? <div className="preview-scene-fps">FPS：{fpsLabel}</div> : null}
          {runtimeStatus.status === "loading" ? (
            <div className="preview-scene-status is-loading">
              <Spin size="small" />
              <span>{runtimeStatus.message || "正在加载场景"}</span>
            </div>
          ) : null}
          {runtimeStatus.status === "error" ? (
            <div className="preview-scene-status is-error">
              <span>{runtimeStatus.message || "场景加载失败"}</span>
            </div>
          ) : null}
        </div>

        {rightPanelCollapsed ? (
          <div className="preview-panel preview-rail is-right">
            <Tooltip title="展开场景控制">
              <Button
                aria-label="展开场景控制"
                icon={<SettingOutlined />}
                onClick={expandInspector}
              />
            </Tooltip>
          </div>
        ) : (
        <div className="preview-panel preview-side preview-inspector-panel">
          <div className="preview-panel-header">
            <Typography.Title level={5}>场景控制</Typography.Title>
            <Tooltip title="收起场景控制">
              <Button
                aria-label="收起场景控制"
                icon={<MenuUnfoldOutlined />}
                size="small"
                type="text"
                onClick={collapseInspector}
              />
            </Tooltip>
          </div>
          <Space direction="vertical" size={12} className="preview-control-stack">
            <Space wrap className="preview-tool-row">
              {showInspectorShortcutActions ? (
                <>
                  <Tooltip title="聚焦模型">
                    <Button
                      aria-label="聚焦模型"
                      icon={<AimOutlined />}
                      disabled={!canEditScene}
                      onClick={() => setViewCommand("fit")}
                    />
                  </Tooltip>
                  <Tooltip title="重置视角">
                    <Button
                      aria-label="重置视角"
                      icon={<HomeOutlined />}
                      disabled={!canEditScene}
                      onClick={() => setViewCommand("reset")}
                    />
                  </Tooltip>
                  <Tooltip title={stageFullscreen ? "退出全屏" : "全屏"}>
                    <Button
                      aria-label={stageFullscreen ? "退出全屏" : "全屏"}
                      aria-pressed={stageFullscreen}
                      icon={stageFullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                      onClick={toggleStageFullscreen}
                    />
                  </Tooltip>
                </>
              ) : null}
              <Tooltip title={viewOptions.stars ? "隐藏星空背景" : "显示星空背景"}>
                <Button
                  aria-label={viewOptions.stars ? "隐藏星空背景" : "显示星空背景"}
                  aria-pressed={viewOptions.stars}
                  type={viewOptions.stars ? "primary" : "default"}
                  icon={<StarOutlined />}
                  disabled={activePreviewEngine !== "three"}
                  onClick={() => toggleViewOption("stars")}
                />
              </Tooltip>
              {showInspectorShortcutActions ? (
                <>
                  <Tooltip title={placementMode ? "退出地表落位" : "地表落位"}>
                    <Button
                      aria-label="地表落位"
                      aria-pressed={canEditScene && placementMode}
                      type={canEditScene && placementMode ? "primary" : "default"}
                      icon={<EnvironmentOutlined />}
                      disabled={!canEditScene}
                      onClick={() => setPlacementMode((value) => !value)}
                    />
                  </Tooltip>
                  <Tooltip title="回正姿态">
                    <Button
                      aria-label="回正姿态"
                      icon={<ColumnHeightOutlined />}
                      disabled={!canEditScene}
                      onClick={() => updateTransform(normalizeUprightTransform(transform, sceneMode))}
                    />
                  </Tooltip>
                  <Tooltip title="重置变换">
                    <Button
                      aria-label="重置变换"
                      icon={<UndoOutlined />}
                      disabled={!canEditScene}
                      onClick={() => updateTransform(normalizeResetTransform(transform, sceneMode))}
                    />
                  </Tooltip>
                </>
              ) : null}
            </Space>
            <Radio.Group
              aria-label="模型变换模式"
              block
              optionType="button"
              buttonStyle="solid"
              value={transformMode}
              disabled={!canEditScene}
              options={TRANSFORM_MODE_OPTIONS.map(({ label, value }) => ({ label, value }))}
              onChange={(event) => setTransformMode(event.target.value)}
            />
          </Space>

          <Divider />

          <TransformInspector
            transform={transform}
            sceneMode={sceneMode}
            transformMode={transformMode}
            disabled={!canEditScene}
            onChange={updateTransform}
          />
        </div>
        )}
      </div>
    </div>
  );
}

function PreviewStage({
  payload,
  activeEngine,
  threeRenderer,
  sceneMode,
  transform,
  transformMode,
  selectedLayerKey,
  hiddenLayerKeys,
  placementMode,
  canEditScene,
  viewOptions,
  viewCommand,
  sceneViewState,
  onLayerTreeChange,
  onSceneInfoChange,
  onSceneViewStateChange,
  onSelectLayer,
  onTransformChange,
  onPlacementDone,
  onPlacementCancel,
  onViewCommandHandled,
  onRendererFallback,
  onSwitchToThree,
  onUnrealStatusChange
}: {
  payload: PreviewPayload;
  activeEngine: PreviewEngine;
  threeRenderer: ThreeRendererPreference;
  sceneMode: PreviewSceneMode;
  transform: PreviewTransform;
  transformMode: TransformMode;
  selectedLayerKey: string | null;
  hiddenLayerKeys: string[];
  placementMode: boolean;
  canEditScene: boolean;
  viewOptions: PreviewViewOptions;
  viewCommand: ViewCommand;
  sceneViewState: SceneViewState;
  onLayerTreeChange: (tree: LayerNode[]) => void;
  onSceneInfoChange: (info: SceneInfo) => void;
  onSceneViewStateChange: (state: SceneViewState) => void;
  onSelectLayer: (key: string | null) => void;
  onTransformChange: (transform: PreviewTransform) => void;
  onPlacementDone: () => void;
  onPlacementCancel: () => void;
  onViewCommandHandled: () => void;
  onRendererFallback: (message: string) => void;
  onSwitchToThree: () => void;
  onUnrealStatusChange: (status: UnrealConnectionStatus, message?: string) => void;
}) {
  const url = api.absoluteUrl(payload.url);
  const contextTilesUrl = resolveContextTilesUrl(payload);

  if (payload.type === "json") {
    return <pre className="preview-json">{JSON.stringify(payload.json, null, 2)}</pre>;
  }

  if (!isModelPreviewType(payload.type) || !url) {
    return (
      <div className="center-state">
        <Empty description={payload.message || unsupportedPreviewMessage(payload.file)} />
      </div>
    );
  }

  if (activeEngine === "unreal") {
    return (
      <div className={`preview-render-surface is-${sceneMode}`}>
        <UnrealPreview
          url={UE_PIXEL_STREAMING_URL}
          sceneId={payload.file?.id || payload.task.id}
          sceneViewState={sceneViewState}
          onStatusChange={onUnrealStatusChange}
          onSwitchToThree={onSwitchToThree}
        />
      </div>
    );
  }

  return (
    <div className={`preview-render-surface is-${sceneMode}`}>
      <ThreeScene
        key={`${payload.file?.id || payload.url}-${payload.type}-${threeRenderer}`}
        url={url}
        contextTilesUrl={contextTilesUrl}
        type={payload.type}
        layerRootTitle={payload.file?.fileName}
        rendererPreference={threeRenderer}
        sceneMode={sceneMode}
        transform={transform}
        transformMode={transformMode}
        selectedLayerKey={selectedLayerKey}
        hiddenLayerKeys={hiddenLayerKeys}
        placementMode={canEditScene && placementMode}
        viewOptions={viewOptions}
        viewCommand={viewCommand}
        sceneViewState={sceneViewState}
        onLayerTreeChange={onLayerTreeChange}
        onSceneInfoChange={onSceneInfoChange}
        onSceneViewStateChange={onSceneViewStateChange}
        onSelectLayer={onSelectLayer}
        onTransformChange={onTransformChange}
        onPlacementDone={onPlacementDone}
        onViewCommandHandled={onViewCommandHandled}
        onRendererFallback={onRendererFallback}
      />
      {placementMode ? (
        <div className="preview-placement-hint" role="status" aria-label="地表落位模式：单击地球表面完成落位，Esc 退出">
          <AimOutlined className="preview-placement-hint-icon" />
          <strong>落位中</strong>
          <Tooltip title="退出地表落位">
            <Button
              aria-label="退出地表落位"
              icon={<CloseOutlined />}
              size="small"
              type="text"
              onClick={onPlacementCancel}
            />
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}

function PreviewFileList({
  files,
  selectedFileId,
  onSelectFile
}: {
  files: ResultFile[];
  selectedFileId: string | null;
  onSelectFile: (fileId: string) => void;
}) {
  if (!files.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无成果文件" />;
  }

  if (files.length === 1) {
    const [file] = files;
    return (
      <div className="preview-file-list">
        <Tooltip title={previewFileTooltip(file)}>
          <div
            aria-label={`${file.fileName}，${previewTypeLabel(file.fileType)}，${formatSize(file.fileSize)}`}
            className="preview-file-row is-static is-compact"
          >
            <FileOutlined />
            <span className="preview-file-row-main">
              <span>{file.fileName}</span>
              <small>{previewTypeLabel(file.fileType)} · {formatSize(file.fileSize)}</small>
            </span>
          </div>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="preview-file-list">
      {files.map((file) => {
        const isSelected = selectedFileId === file.id;
        if (isSelected) {
          return (
            <Tooltip title={previewFileTooltip(file)} key={file.id}>
              <div aria-current="true" className="preview-file-row is-active is-static is-current">
                <FileOutlined />
                <span className="preview-file-row-main">
                  <span>{file.fileName}</span>
                  <small>{previewTypeLabel(file.fileType)} · {formatSize(file.fileSize)}</small>
                </span>
              </div>
            </Tooltip>
          );
        }

        return (
          <Tooltip title={previewFileTooltip(file)} key={file.id}>
            <button
              className={`preview-file-row${file.previewable ? "" : " is-unsupported"}`}
              type="button"
              disabled={!file.previewable}
              onClick={() => {
                if (file.previewable) {
                  onSelectFile(file.id);
                }
              }}
            >
              <FileOutlined />
              <span className="preview-file-row-main">
                <span>{file.fileName}</span>
                <small>{previewTypeLabel(file.fileType)} · {formatSize(file.fileSize)}</small>
              </span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

function LayerTreeView({
  nodes,
  checkedKeys,
  expandedKeys,
  selectedKey,
  onSelect,
  onFocusLayer,
  onToggleExpanded,
  onToggle
}: {
  nodes: LayerNode[];
  checkedKeys: string[];
  expandedKeys: string[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onFocusLayer: (key: string | null) => void;
  onToggleExpanded: (key: string) => void;
  onToggle: (node: LayerNode) => void;
}) {
  const checkedSet = new Set(checkedKeys);
  const expandedSet = new Set(expandedKeys);
  return (
    <div className="preview-layer-tree" role="tree" aria-label="模型图层">
      {nodes.map((node) => (
        <LayerTreeItem
          key={node.key}
          node={node}
          depth={0}
          checkedSet={checkedSet}
          expandedSet={expandedSet}
          selectedKey={selectedKey}
          onSelect={onSelect}
          onFocusLayer={onFocusLayer}
          onToggleExpanded={onToggleExpanded}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

function LayerTreeItem({
  node,
  depth,
  checkedSet,
  expandedSet,
  selectedKey,
  onSelect,
  onFocusLayer,
  onToggleExpanded,
  onToggle
}: {
  node: LayerNode;
  depth: number;
  checkedSet: Set<string>;
  expandedSet: Set<string>;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  onFocusLayer: (key: string | null) => void;
  onToggleExpanded: (key: string) => void;
  onToggle: (node: LayerNode) => void;
}) {
  const visibilityState = getLayerVisibilityState(node, checkedSet);
  const checked = visibilityState !== "hidden";
  const fullyVisible = visibilityState === "visible";
  const hasChildren = Boolean(node.children?.length);
  const expanded = !hasChildren || expandedSet.has(node.key);
  return (
    <div className="preview-layer-branch">
      <div
        className={`preview-layer-row${selectedKey === node.key ? " is-active" : ""}${visibilityState === "hidden" ? " is-hidden" : ""}${visibilityState === "partial" ? " is-partial" : ""}`}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={selectedKey === node.key}
        aria-expanded={hasChildren ? expanded : undefined}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        {hasChildren ? (
          <Tooltip title={expanded ? "收起图层" : "展开图层"}>
            <button
              aria-label={`${expanded ? "收起" : "展开"} ${node.title}`}
              className="preview-layer-icon-button preview-layer-expand-button"
              type="button"
              onClick={() => onToggleExpanded(node.key)}
            >
              {expanded ? <DownOutlined /> : <RightOutlined />}
            </button>
          </Tooltip>
        ) : (
          <span className="preview-layer-indent-spacer" aria-hidden="true" />
        )}
        <Tooltip title={fullyVisible ? "隐藏图层" : "显示图层"}>
          <button
            aria-checked={visibilityState === "partial" ? "mixed" : fullyVisible}
            aria-label={`${fullyVisible ? "隐藏" : "显示"} ${node.title}`}
            className="preview-layer-visibility"
            role="switch"
            type="button"
            onClick={() => onToggle(node)}
          >
            {visibilityState === "hidden" ? <EyeInvisibleOutlined /> : <EyeOutlined />}
          </button>
        </Tooltip>
        <button
          aria-label={`选择 ${node.title}`}
          className="preview-layer-name-button"
          disabled={!checked}
          type="button"
          onClick={() => onSelect(node.key)}
        >
          <NodeIndexOutlined />
          <span>{node.title}</span>
        </button>
        <Tooltip title="定位图层">
          <button
            aria-label={`定位 ${node.title}`}
            className="preview-layer-icon-button"
            disabled={!checked}
            type="button"
            onClick={() => onFocusLayer(node.key)}
          >
            <AimOutlined />
          </button>
        </Tooltip>
      </div>
      {expanded && node.children?.map((child) => (
        <LayerTreeItem
          key={child.key}
          node={child}
          depth={depth + 1}
          checkedSet={checkedSet}
          expandedSet={expandedSet}
          selectedKey={selectedKey}
          onSelect={onSelect}
          onFocusLayer={onFocusLayer}
          onToggleExpanded={onToggleExpanded}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

function ThreeScene({
  url,
  contextTilesUrl,
  type,
  layerRootTitle,
  rendererPreference,
  sceneMode,
  transform,
  transformMode,
  selectedLayerKey,
  hiddenLayerKeys,
  placementMode,
  viewOptions,
  viewCommand,
  sceneViewState,
  onLayerTreeChange,
  onSceneInfoChange,
  onSceneViewStateChange,
  onSelectLayer,
  onTransformChange,
  onPlacementDone,
  onViewCommandHandled,
  onRendererFallback
}: {
  url: string;
  contextTilesUrl?: string;
  type: string;
  layerRootTitle?: string;
  rendererPreference: ThreeRendererPreference;
  sceneMode: PreviewSceneMode;
  transform: PreviewTransform;
  transformMode: TransformMode;
  selectedLayerKey: string | null;
  hiddenLayerKeys: string[];
  placementMode: boolean;
  viewOptions: PreviewViewOptions;
  viewCommand: ViewCommand;
  sceneViewState: SceneViewState;
  onLayerTreeChange: (tree: LayerNode[]) => void;
  onSceneInfoChange: (info: SceneInfo) => void;
  onSceneViewStateChange: (state: SceneViewState) => void;
  onSelectLayer: (key: string | null) => void;
  onTransformChange: (transform: PreviewTransform) => void;
  onPlacementDone: () => void;
  onViewCommandHandled: () => void;
  onRendererFallback: (message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const modelRootRef = useRef<THREE.Object3D | null>(null);
  const transformHandleRef = useRef<THREE.Object3D | null>(null);
  const placementSurfaceRootRef = useRef<THREE.Object3D | null>(null);
  const tilesRef = useRef<TilesRenderer[]>([]);
  const transformControlsRef = useRef<TransformControls | null>(null);
  const globeControlsRef = useRef<GlobeControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<PreviewRenderer | null>(null);
  const objectsByLayerKeyRef = useRef<Map<string, THREE.Object3D>>(new Map());
  const ellipsoidContextRef = useRef<EllipsoidContext>(createDefaultEllipsoidContext());
  const applyingTransformRef = useRef(false);
  const latestTransformRef = useRef(transform);
  const latestSceneModeRef = useRef(sceneMode);
  const latestPlacementModeRef = useRef(placementMode);
  const latestTransformModeRef = useRef(transformMode);
  const latestSelectedLayerKeyRef = useRef(selectedLayerKey);
  const latestSceneViewStateRef = useRef(sceneViewState);
  const latestViewOptionsRef = useRef(viewOptions);

  useEffect(() => {
    latestTransformRef.current = transform;
  }, [transform]);

  useEffect(() => {
    latestSceneModeRef.current = sceneMode;
    const camera = cameraRef.current;
    if (!camera) return;
    setInitialCamera(camera, sceneMode, ellipsoidContextRef.current);
    globeControlsRef.current?.update(0);
  }, [sceneMode]);

  useEffect(() => {
    latestPlacementModeRef.current = placementMode;
    const controls = transformControlsRef.current;
    if (controls) {
      controls.getHelper().visible = !placementMode;
    }
  }, [placementMode]);

  useEffect(() => {
    latestSelectedLayerKeyRef.current = selectedLayerKey;
  }, [selectedLayerKey]);

  useEffect(() => {
    latestSceneViewStateRef.current = sceneViewState;
  }, [sceneViewState]);

  useEffect(() => {
    latestViewOptionsRef.current = viewOptions;
  }, [viewOptions]);

  useEffect(() => {
    const modelRoot = modelRootRef.current;
    if (!modelRoot) return;
    applyingTransformRef.current = true;
    applyTransformToObject(modelRoot, transform, type, latestSceneModeRef.current, ellipsoidContextRef.current);
    updateTransformControlTarget(
      transformControlsRef.current,
      modelRoot,
      transformHandleRef.current,
      transform,
      type,
      latestSceneModeRef.current,
      ellipsoidContextRef.current,
      latestTransformModeRef.current
    );
    applyingTransformRef.current = false;
  }, [transform, type]);

  useEffect(() => {
    const controls = transformControlsRef.current;
    latestTransformModeRef.current = transformMode;
    controls?.setMode(transformMode);
    controls?.setSpace("local");
    if (modelRootRef.current) {
      updateTransformControlTarget(
        controls,
        modelRootRef.current,
        transformHandleRef.current,
        latestTransformRef.current,
        type,
        latestSceneModeRef.current,
        ellipsoidContextRef.current,
        transformMode
      );
    }
  }, [transformMode]);

  useEffect(() => {
    const hidden = new Set(hiddenLayerKeys);
    objectsByLayerKeyRef.current.forEach((object, key) => {
      object.visible = !hidden.has(key);
    });
  }, [hiddenLayerKeys]);

  useEffect(() => {
    const object = selectedLayerKey ? objectsByLayerKeyRef.current.get(selectedLayerKey) : modelRootRef.current;
    if (object && cameraRef.current) {
      focusObject(
        object,
        cameraRef.current,
        latestSceneModeRef.current,
        globeControlsRef.current,
        ellipsoidContextRef.current
      );
    }
  }, [selectedLayerKey]);

  useEffect(() => {
    if (!viewCommand) return;
    const camera = cameraRef.current;
    const modelRoot = modelRootRef.current;
    if (camera) {
      if (viewCommand === "fit" && modelRoot) {
        focusObject(
          modelRoot,
          camera,
          latestSceneModeRef.current,
          globeControlsRef.current,
          ellipsoidContextRef.current
        );
      }
      if (viewCommand === "reset") {
        setInitialCamera(camera, latestSceneModeRef.current, ellipsoidContextRef.current);
        globeControlsRef.current?.update(0);
      }
    }
    onViewCommandHandled();
  }, [onViewCommandHandled, viewCommand]);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let frameId = 0;
    let starField: THREE.Points | null = null;
    let selectionBox: THREE.Box3Helper | null = null;
    let renderer: PreviewRenderer | null = null;
    const loadedObjects: LoadedPreviewObject[] = [];
    let hasCriticalSceneError = false;
    let frameCounter = 0;
    let layerSignature = "";
    let statsSignature = "";
    let framedLoadedTiles = false;
    let statusMessage = "";
    let lastFpsTime = performance.now();
    let fpsFrameCount = 0;
    let currentFps: number | undefined;
    let renderFailed = false;
    const plainBackground = new THREE.Color(0x071422);

    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    const sceneContentRoot = new THREE.Group();
    sceneContentRoot.name = "Preview Scene";
    scene.add(sceneContentRoot);
    const transformHandle = new THREE.Group();
    transformHandle.name = "Geospatial Transform Handle";
    transformHandle.visible = false;
    sceneContentRoot.add(transformHandle);
    transformHandleRef.current = transformHandle;

    const ellipsoidAnchor = new THREE.Group();
    ellipsoidAnchor.name = "WGS84 Ellipsoid Frame";
    scene.add(ellipsoidAnchor);
    ellipsoidContextRef.current = {
      tilesEllipsoid: WGS84_ELLIPSOID,
      geospatialEllipsoid: GEOSPATIAL_WGS84,
      group: ellipsoidAnchor
    };

    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 120_000_000);
    if (!restoreCameraView(camera, latestSceneViewStateRef.current, ellipsoidContextRef.current)) {
      setInitialCamera(camera, latestSceneModeRef.current, ellipsoidContextRef.current);
    }
    cameraRef.current = camera;

    onSceneInfoChange({
      backend: "Detecting",
      status: "loading",
      message: "正在初始化渲染器",
      meshes: 0,
      vertices: 0
    });

    const run = async () => {
      const rendererResult = await createRenderer(container, rendererPreference, (backend) => {
        onSceneInfoChange({
          backend,
          status: "loading",
          message: "正在加载模型",
          meshes: 0,
          vertices: 0,
          fps: currentFps
        });
      });
      renderer = rendererResult.renderer;
      const rendererWarning = rendererResult.fallbackMessage || "";
      if (disposed || !renderer) {
        renderer?.dispose();
        return;
      }
      rendererRef.current = renderer;
      container.appendChild(renderer.domElement);

      const globeControls = new GlobeControls(sceneContentRoot, camera, renderer.domElement);
      globeControls.enableDamping = true;
      globeControls.dampingFactor = 0.09;
      globeControls.adjustHeight = true;
      globeControls.enableFlight = true;
      globeControls.flightSpeed = 1000;
      globeControls.flightSpeedMultiplier = 8;
      globeControls.rotationSpeed = 0.95;
      globeControls.zoomSpeed = 1.12;
      globeControls.minAltitude = 0;
      globeControls.maxAltitude = 0.49 * Math.PI;
      globeControls.cameraRadius = MIN_GLOBE_ZOOM_DISTANCE;
      globeControls.minDistance = MIN_GLOBE_ZOOM_DISTANCE;
      globeControls.maxDistance = Number.POSITIVE_INFINITY;
      globeControls.maxZoom = Number.POSITIVE_INFINITY;
      globeControls.setEllipsoid(WGS84_ELLIPSOID, ellipsoidAnchor);
      globeControlsRef.current = globeControls;
      const rendererElement = renderer.domElement;
      const detachCesiumLikeInteractions = attachCesiumLikeGlobeInteractions(
        globeControls,
        rendererElement,
        () => latestSceneModeRef.current === "sphere" &&
          !transformControlsRef.current?.dragging &&
          !latestPlacementModeRef.current,
        (event) => isTransformControlPointerHit(event, transformControlsRef.current, camera, rendererElement)
      );

      const updateNavigationMode = (dragging = false) => {
        globeControls.enabled = !dragging;
      };
      updateNavigationMode();

      scene.add(new THREE.HemisphereLight(0xdcefff, 0x162032, 1.1));
      const directional = new THREE.DirectionalLight(0xffffff, 4.2);
      directional.position.set(1, 0.35, 0.55).normalize();
      scene.add(directional);

      starField = createStarField();
      starField.visible = true;
      scene.add(starField);
      scene.background = null;

      const handleLoadProgress = (percent: number) => {
        if (!renderer) return;
        onSceneInfoChange({
          backend: getRendererBackend(renderer),
          status: "loading",
          message: `正在加载模型 ${percent}%`,
          meshes: 0,
          vertices: 0,
          fps: currentFps
        });
      };

      const watchPhotorealisticGlobe = (loaded: LoadedPreviewObject) => {
        if (!loaded.tiles || !loaded.isPhotorealisticGlobe) return;
        let hasContent = false;
        loaded.tiles.addEventListener("load-model", () => {
          hasContent = true;
        });
        loaded.tiles.addEventListener("load-error", (event) => {
          if (hasContent || !renderer) return;
          const message = getTilesLoadErrorMessage(event);
          statusMessage = `Cesium ion 真实地球加载失败${message ? `：${message}` : ""}`;
          hasCriticalSceneError = true;
          const stats = modelRootRef.current ? collectSceneStats(modelRootRef.current) : { meshes: 0, vertices: 0 };
          onSceneInfoChange({
            backend: getRendererBackend(renderer),
            status: "error",
            message: statusMessage,
            meshes: stats.meshes,
            vertices: stats.vertices
          });
        });
      };

      const transformControls = new TransformControls(camera, renderer.domElement);
      transformControls.setMode(transformMode);
      transformControls.setSpace("local");
      transformControls.setSize(0.85);
      transformControls.addEventListener("dragging-changed", (event) => {
        updateNavigationMode(Boolean(event.value));
      });
      transformControls.addEventListener("objectChange", () => {
        const modelRoot = modelRootRef.current;
        if (!modelRoot || applyingTransformRef.current) return;
        const controlledObject = transformControls.object || modelRoot;
        const nextTransform = readObjectTransform(
          controlledObject,
          type,
          latestSceneModeRef.current,
          ellipsoidContextRef.current,
          latestTransformRef.current,
          latestTransformModeRef.current
        );
        if (controlledObject !== modelRoot) {
          applyingTransformRef.current = true;
          applyTransformToObject(modelRoot, nextTransform, type, latestSceneModeRef.current, ellipsoidContextRef.current);
          applyingTransformRef.current = false;
        }
        onTransformChange(nextTransform);
      });
      transformControlsRef.current = transformControls;
      const transformControlsHelper = transformControls.getHelper();
      removeTransformControlHelperLines(transformControlsHelper);
      transformControlsHelper.visible = !latestPlacementModeRef.current;
      scene.add(transformControlsHelper);

      try {
        let contextWarning = "";
        if (contextTilesUrl && contextTilesUrl !== url) {
          try {
            const contextTiles = await loadPreviewObject("3dtiles", contextTilesUrl, camera, renderer, "上下文 3D Tiles");
            if (disposed) {
              disposeLoaded(contextTiles);
              return;
            }
            loadedObjects.push(contextTiles);
            sceneContentRoot.add(contextTiles.object);
            placementSurfaceRootRef.current = contextTiles.object;
            if (contextTiles.tiles) {
              registerTilesRenderer(contextTiles.tiles, camera, renderer, container);
              tilesRef.current.push(contextTiles.tiles);
              ellipsoidContextRef.current = setEllipsoidContextFromTiles(contextTiles.tiles, globeControls, ellipsoidAnchor);
              if (contextTiles.isPhotorealisticGlobe) {
                watchPhotorealisticGlobe(contextTiles);
              }
            }
          } catch (error) {
            contextWarning = error instanceof Error ? error.message : "上下文 3D Tiles 加载失败";
            hasCriticalSceneError = true;
          }
        }

        const loaded = await loadPreviewObject(type, url, camera, renderer, undefined, handleLoadProgress);
        if (disposed) {
          disposeLoaded(loaded);
          return;
        }
        loadedObjects.push(loaded);

        if (loaded.tiles) {
          const modelRoot = new THREE.Group();
          modelRoot.name = loaded.name;
          modelRoot.userData.previewTilesRenderer = loaded.tiles;
          modelRoot.add(loaded.object);
          sceneContentRoot.add(modelRoot);
          registerTilesRenderer(loaded.tiles, camera, renderer, container);
          tilesRef.current.push(loaded.tiles);
          if (!contextTilesUrl) {
            ellipsoidContextRef.current = setEllipsoidContextFromTiles(loaded.tiles, globeControls, ellipsoidAnchor);
          }
          if (loaded.isPhotorealisticGlobe) {
            watchPhotorealisticGlobe(loaded);
          }
          if (contextTilesUrl) {
            const fallbackGeo = getTilesetCenterGeo(loaded.tiles, ellipsoidContextRef.current) || latestTransformRef.current.geo || DEFAULT_TRANSFORM.geo!;
            latestTransformRef.current = {
              ...latestTransformRef.current,
              geo: latestTransformRef.current.geo || fallbackGeo
            };
          }
          modelRootRef.current = modelRoot;
        } else {
          const modelRoot = new THREE.Group();
          modelRoot.name = loaded.name;
          normalizeObjectToPivot(loaded.object);
          if (shouldAlignImportedObjectToZUp(type)) {
            alignImportedObjectToZUp(loaded.object);
          }
          modelRoot.add(loaded.object);
          sceneContentRoot.add(modelRoot);
          modelRootRef.current = modelRoot;
        }

        const modelRoot = modelRootRef.current;
        if (modelRoot) {
          applyTransformToObject(modelRoot, latestTransformRef.current, type, latestSceneModeRef.current, ellipsoidContextRef.current);
          updateTransformControlTarget(
            transformControls,
            modelRoot,
            transformHandle,
            latestTransformRef.current,
            type,
            latestSceneModeRef.current,
            ellipsoidContextRef.current,
            latestTransformModeRef.current
          );
          transformControls.getHelper().visible = !latestPlacementModeRef.current;
          if (!restoreCameraView(camera, latestSceneViewStateRef.current, ellipsoidContextRef.current)) {
            setInitialCamera(camera, latestSceneModeRef.current, ellipsoidContextRef.current);
          }
          globeControls.update(0);
        }

        statusMessage = "";
        if (rendererWarning) {
          statusMessage = rendererWarning;
        }
        if (contextWarning) {
          statusMessage = contextWarning;
        }
        refreshSceneSummary(true);

      } catch (error) {
        onSceneInfoChange({
          backend: renderer ? getRendererBackend(renderer) : "Detecting",
          status: "error",
          message: error instanceof Error ? error.message : "模型加载失败",
          meshes: 0,
          vertices: 0
        });
      }

      const pointer = new THREE.Vector2();
      const raycaster = new THREE.Raycaster();
      let canvasPointerIntent: CanvasPointerIntent | null = null;

      const handlePointerDown = (event: PointerEvent) => {
        canvasPointerIntent = null;
        if (!renderer || !modelRootRef.current || transformControls.dragging || event.button !== 0) {
          return;
        }
        canvasPointerIntent = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY
        };
      };

      const handlePointerCancel = (event: PointerEvent) => {
        if (canvasPointerIntent?.id === event.pointerId) {
          canvasPointerIntent = null;
        }
      };

      const handlePointerUp = (event: PointerEvent) => {
        if (!renderer || !modelRootRef.current || transformControls.dragging || event.button !== 0) {
          canvasPointerIntent = null;
          return;
        }
        if (!canvasPointerIntent || canvasPointerIntent.id !== event.pointerId || hasPointerMoved(canvasPointerIntent, event)) {
          canvasPointerIntent = null;
          return;
        }
        canvasPointerIntent = null;
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);

        if (latestPlacementModeRef.current) {
          const placement = getSurfacePlacement(
            raycaster,
            latestSceneModeRef.current,
            ellipsoidContextRef.current,
            placementSurfaceRootRef.current,
            modelRootRef.current
          );
          if (placement) {
            onTransformChange({
              ...latestTransformRef.current,
              position: placement.point.toArray() as [number, number, number],
              rotation: shouldUseGeoPlacement(type, latestSceneModeRef.current)
                ? [0, 0, 0]
                : latestTransformRef.current.rotation,
              geo: scenePositionToGeo(placement.point.toArray(), latestSceneModeRef.current, ellipsoidContextRef.current)
            });
            onPlacementDone();
          }
          return;
        }

        const intersections = raycaster.intersectObject(modelRootRef.current, true);
        const hit = intersections.find((item) => isPickableObject(item.object));
        if (hit) {
          const key = findLayerKeyForObject(hit.object);
          onSelectLayer(key);
        }
      };
      renderer.domElement.addEventListener("pointerdown", handlePointerDown);
      renderer.domElement.addEventListener("pointerup", handlePointerUp);
      renderer.domElement.addEventListener("pointercancel", handlePointerCancel);

      resizeObserver = new ResizeObserver(() => {
        if (!renderer) return;
        resizeRenderer(container, renderer, camera);
        tilesRef.current.forEach((tiles) => tiles.setResolution(camera, container.clientWidth, container.clientHeight));
      });
      resizeObserver.observe(container);
      resizeRenderer(container, renderer, camera);

      function refreshSceneSummary(force = false) {
        const modelRoot = modelRootRef.current;
        if (!modelRoot || !renderer) return;

        const nextLayerSignature = collectLayerSignature(modelRoot);
        if (force || nextLayerSignature !== layerSignature) {
          layerSignature = nextLayerSignature;
          const layerResult = buildLayerTree(modelRoot, {
            rootTitle: type === "3dtiles" ? layerRootTitle || "tileset.json" : undefined,
            shallow: type === "3dtiles"
          });
          objectsByLayerKeyRef.current = layerResult.objectsByKey;
          onLayerTreeChange(layerResult.tree);
        }

        const stats = collectSceneStats(modelRoot);
        const nextStatsSignature = `${stats.meshes}:${stats.vertices}`;
        if (force || nextStatsSignature !== statsSignature) {
          statsSignature = nextStatsSignature;
          if (tilesRef.current.length && !framedLoadedTiles && stats.meshes > 0) {
            focusObject(modelRoot, camera, latestSceneModeRef.current, globeControls, ellipsoidContextRef.current);
            framedLoadedTiles = true;
          }
          onSceneInfoChange({
            backend: getRendererBackend(renderer),
            status: hasCriticalSceneError ? "error" : "ready",
            message: hasCriticalSceneError ? statusMessage : "",
            meshes: stats.meshes,
            vertices: stats.vertices,
            fps: currentFps
          });
        }
      }

      function syncSceneViewState() {
        const visibleLayerIds = [...objectsByLayerKeyRef.current.entries()]
          .filter(([, object]) => object.visible)
          .map(([key]) => key);
        onSceneViewStateChange({
          camera: readCameraView(camera, globeControls),
          selectedObjectId: latestSelectedLayerKeyRef.current || undefined,
          visibleLayerIds
        });
      }

      const animate = () => {
        if (!renderer) return;
        frameCounter += 1;
        fpsFrameCount += 1;
        const now = performance.now();
        if (now - lastFpsTime >= 1000) {
          currentFps = (fpsFrameCount * 1000) / (now - lastFpsTime);
          fpsFrameCount = 0;
          lastFpsTime = now;
          if (renderer) {
            const stats = modelRootRef.current ? collectSceneStats(modelRootRef.current) : { meshes: 0, vertices: 0 };
            onSceneInfoChange({
              backend: getRendererBackend(renderer),
              status: hasCriticalSceneError ? "error" : modelRootRef.current ? "ready" : "loading",
              message: hasCriticalSceneError || !modelRootRef.current ? statusMessage : "",
              meshes: stats.meshes,
              vertices: stats.vertices,
              fps: currentFps
            });
          }
        }
        updateNavigationMode(transformControls.dragging);
        globeControls.update();
        applyCloseZoomCameraClipping(camera, ellipsoidContextRef.current);
        if (starField) starField.visible = latestViewOptionsRef.current.stars;
        scene.background = latestViewOptionsRef.current.stars ? null : plainBackground;
        modelRootRef.current?.updateMatrixWorld(true);
        tilesRef.current.forEach((tiles) => {
          if (tiles.group.name === "上下文 3D Tiles") {
            tiles.group.visible = true;
          }
        });
        tilesRef.current.forEach((tiles) => {
          tiles.setCamera(camera);
          tiles.setResolution(camera, container.clientWidth, container.clientHeight);
          tiles.update();
        });
        if (frameCounter % 30 === 0) {
          refreshSceneSummary();
          syncSceneViewState();
        }
        if (selectionBox) {
          scene.remove(selectionBox);
          selectionBox.geometry.dispose();
          if (Array.isArray(selectionBox.material)) {
            selectionBox.material.forEach(disposeMaterial);
          } else {
            disposeMaterial(selectionBox.material);
          }
          selectionBox = null;
        }
        const latestSelectedLayerKey = latestSelectedLayerKeyRef.current;
        const selected = latestSelectedLayerKey ? objectsByLayerKeyRef.current.get(latestSelectedLayerKey) : null;
        if (selected?.visible) {
          const selectedBox = getVisibleObjectBox(selected);
          if (selectedBox) {
            selectionBox = new THREE.Box3Helper(selectedBox, 0x5fd3ff);
            scene.add(selectionBox);
          }
        }
        try {
          renderer.render(scene, camera);
        } catch (error) {
          if (!renderFailed && rendererPreference === "webgpu") {
            renderFailed = true;
            onRendererFallback(WEBGPU_FALLBACK_MESSAGE);
            return;
          }
          throw error;
        }
        frameId = window.requestAnimationFrame(animate);
      };
      animate();

      return () => {
        detachCesiumLikeInteractions();
        renderer?.domElement.removeEventListener("pointerdown", handlePointerDown);
        renderer?.domElement.removeEventListener("pointerup", handlePointerUp);
        renderer?.domElement.removeEventListener("pointercancel", handlePointerCancel);
      };
    };

    let removePointerHandler: (() => void) | undefined;
    void run().then((cleanup) => {
      removePointerHandler = cleanup;
    });

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
      removePointerHandler?.();
      resizeObserver?.disconnect();
      transformControlsRef.current?.detach();
      transformControlsRef.current?.dispose();
      globeControlsRef.current?.dispose();
      loadedObjects.forEach(disposeLoaded);
      rendererRef.current = null;
      cameraRef.current = null;
      modelRootRef.current = null;
      transformHandleRef.current = null;
      placementSurfaceRootRef.current = null;
      tilesRef.current = [];
      transformControlsRef.current = null;
      globeControlsRef.current = null;
      ellipsoidContextRef.current = createDefaultEllipsoidContext();
      objectsByLayerKeyRef.current = new Map();
      onLayerTreeChange([]);
      scene.traverse((object) => disposeObject(object));
      renderer?.dispose();
      if (renderer?.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [contextTilesUrl, onLayerTreeChange, onPlacementDone, onSceneInfoChange, onSelectLayer, onTransformChange, type, url]);

  return <div ref={containerRef} className={`preview-three-canvas${placementMode ? " is-placement-mode" : ""}`} />;
}

function TransformInspector({
  transform,
  sceneMode,
  transformMode,
  disabled,
  onChange
}: {
  transform: PreviewTransform;
  sceneMode: PreviewSceneMode;
  transformMode: TransformMode;
  disabled: boolean;
  onChange: (transform: PreviewTransform) => void;
}) {
  const geo = transform.geo || DEFAULT_TRANSFORM.geo!;
  const isGeospatial = sceneMode === "sphere";
  const showPosition = !isGeospatial && transformMode === "translate";
  const showRotation = transformMode === "rotate";
  const showScale = transformMode === "scale";

  const setPosition = (index: number, value: number | null) => {
    const next = [...transform.position] as [number, number, number];
    next[index] = Number(value ?? 0);
    onChange({ ...transform, position: next });
  };

  const setRotationDegrees = (index: number, value: number | null) => {
    const next = [...transform.rotation] as [number, number, number];
    next[index] = THREE.MathUtils.degToRad(Number(value ?? 0));
    onChange(normalizeTransformForScene({ ...transform, rotation: next }, sceneMode));
  };

  const setScale = (index: number, value: number | null) => {
    const next = [...transform.scale] as [number, number, number];
    next[index] = Math.max(0.0001, Number(value ?? 1));
    onChange({ ...transform, scale: next });
  };

  const setGeo = (field: keyof PreviewGeoPlacement, value: number | null) => {
    const nextGeo = {
      ...geo,
      [field]: Number(value ?? 0)
    };
    onChange({
      ...transform,
      geo: nextGeo,
      position: transform.position
    });
  };

  return (
    <div className="preview-transform-panel">
      <Typography.Title level={5}>模型变换</Typography.Title>
      {showPosition ? (
        <ControlTriplet
          label="位置"
          suffix="m"
          values={transform.position}
          disabled={disabled}
          onChange={setPosition}
        />
      ) : null}
      {showRotation && isGeospatial ? (
        <ControlScalar
          label="方位"
          suffix="deg"
          value={THREE.MathUtils.radToDeg(transform.rotation[0])}
          disabled={disabled}
          onChange={(value) => setRotationDegrees(0, value)}
        />
      ) : null}
      {showRotation && !isGeospatial ? (
        <ControlTriplet
          label="旋转"
          suffix="deg"
          values={[
            THREE.MathUtils.radToDeg(transform.rotation[0]),
            THREE.MathUtils.radToDeg(transform.rotation[1]),
            THREE.MathUtils.radToDeg(transform.rotation[2])
          ]}
          disabled={disabled}
          onChange={setRotationDegrees}
        />
      ) : null}
      {showScale ? (
        <ControlTriplet
          label="缩放"
          min={0.0001}
          step={0.1}
          values={transform.scale}
          disabled={disabled}
          onChange={setScale}
        />
      ) : null}

      <div className={`preview-geo-position${showRotation || showScale ? " has-divider" : ""}`}>
        <Typography.Title level={5}>位置</Typography.Title>
        <div className="preview-control-row">
        <span>经度</span>
        <InputNumber aria-label="经度" disabled={disabled} value={geo.longitude} min={-180} max={180} step={0.000001} onChange={(value) => setGeo("longitude", value)} />
        </div>
        <div className="preview-control-row">
        <span>纬度</span>
        <InputNumber aria-label="纬度" disabled={disabled} value={geo.latitude} min={-90} max={90} step={0.000001} onChange={(value) => setGeo("latitude", value)} />
        </div>
        <div className="preview-control-row">
        <span>高程</span>
        <InputNumber aria-label="高程" disabled={disabled} value={geo.height} step={1} onChange={(value) => setGeo("height", value)} />
        </div>
      </div>
    </div>
  );
}

function ControlScalar({
  label,
  value,
  suffix,
  min,
  step = 0.01,
  disabled,
  onChange
}: {
  label: string;
  value: number;
  suffix?: string;
  min?: number;
  step?: number;
  disabled: boolean;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className="preview-scalar-control">
      <span>{label}</span>
      <span className="preview-triplet-input">
        <InputNumber
          aria-label={label}
          disabled={disabled}
          value={roundDisplay(value)}
          min={min}
          step={step}
          onChange={onChange}
        />
        {suffix ? <em>{suffix}</em> : null}
      </span>
    </div>
  );
}

function ControlTriplet({
  label,
  axisLabels = ["X", "Y", "Z"],
  values,
  suffix,
  min,
  step = 0.01,
  disabled,
  onChange
}: {
  label: string;
  axisLabels?: [string, string, string];
  values: readonly number[];
  suffix?: string;
  min?: number;
  step?: number;
  disabled: boolean;
  onChange: (index: number, value: number | null) => void;
}) {
  return (
    <div className="preview-triplet">
      <span>{label}</span>
      {axisLabels.map((axis, index) => (
        <span className="preview-triplet-input" key={axis}>
          <span>{axis}</span>
          <InputNumber
            aria-label={`${label} ${axis}`}
            disabled={disabled}
            value={roundDisplay(values[index])}
            min={min}
            step={step}
            onChange={(value) => onChange(index, value)}
          />
          {suffix ? <em>{suffix}</em> : null}
        </span>
      ))}
    </div>
  );
}

async function createRenderer(
  container: HTMLDivElement,
  preference: ThreeRendererPreference,
  onBackend: (backend: RendererBackend) => void
): Promise<PreviewRendererResult> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu;
  if (preference === "webgpu" && gpu?.requestAdapter) {
    try {
      const adapter = await withTimeout(gpu.requestAdapter(), 2000, "WebGPU 适配器请求超时。");
      if (!adapter) {
        throw new Error("当前设备没有可用的 WebGPU 适配器。");
      }
      const renderer = new WebGPURenderer({
        antialias: true,
        alpha: true
      });
      await withTimeout(renderer.init(), 2500, "WebGPU 初始化超时。");
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.AgXToneMapping;
      renderer.toneMappingExposure = 1.25;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      resizeRenderer(container, renderer, new THREE.PerspectiveCamera());
      const backend = getRendererBackend(renderer);
      onBackend(backend);
      return { renderer, backend };
    } catch {
      // Fall through to WebGL when WebGPU is unavailable or initialization stalls.
    }
  }

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  resizeRenderer(container, renderer, new THREE.PerspectiveCamera());
  onBackend("WebGL");
  return {
    renderer,
    backend: "WebGL",
    fallbackMessage: preference === "webgpu" ? WEBGPU_FALLBACK_MESSAGE : undefined
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function loadPreviewObject(
  type: string,
  url: string,
  camera: THREE.Camera,
  renderer: PreviewRenderer,
  label?: string,
  onProgress?: (percent: number) => void
): Promise<LoadedPreviewObject> {
  if (type === "gltf") {
    const gltf = await new GLTFLoader().loadAsync(url, createLoadingProgressHandler(onProgress));
    return { object: gltf.scene, name: gltf.scene.name || label || "glTF / GLB" };
  }
  if (type === "fbx") {
    const object = await new FBXLoader().loadAsync(url, createLoadingProgressHandler(onProgress));
    return { object, name: object.name || label || "FBX" };
  }
  if (type === "obj") {
    const object = await new OBJLoader().loadAsync(url, createLoadingProgressHandler(onProgress));
    return { object, name: object.name || label || "OBJ" };
  }
  if (type === "dae") {
    const collada = await new ColladaLoader().loadAsync(url, createLoadingProgressHandler(onProgress));
    if (!collada?.scene) {
      throw new Error("DAE / Collada 模型加载失败。");
    }
    return { object: collada.scene, name: collada.scene.name || label || "DAE" };
  }
  if (type === "stl") {
    const geometry = await new STLLoader().loadAsync(url, createLoadingProgressHandler(onProgress));
    const material = new THREE.MeshStandardMaterial({ color: 0x8ec9ff, metalness: 0.05, roughness: 0.72 });
    const object = new THREE.Mesh(geometry, material);
    object.name = label || "STL";
    return { object, name: object.name };
  }
  if (type === "ply") {
    const geometry = await new PLYLoader().loadAsync(url, createLoadingProgressHandler(onProgress));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: 0x8ec9ff, metalness: 0.05, roughness: 0.72 });
    const object = new THREE.Mesh(geometry, material);
    object.name = label || "PLY";
    return { object, name: object.name };
  }
  if (type === "usd") {
    try {
      const object = await new USDLoader().loadAsync(url, createLoadingProgressHandler(onProgress));
      return { object, name: object.name || label || "USD" };
    } catch (error) {
      throw new Error(`USD / USDZ 暂时无法在线预览${error instanceof Error ? `：${error.message}` : ""}`);
    }
  }
  if (type === "3dtiles") {
    const tiles = createTilesRenderer(url);
    tiles.group.name = label || "3D Tiles";
    tiles.group.userData.previewTilesRenderer = tiles;
    return {
      object: tiles.group,
      name: label || "3D Tiles",
      tiles,
      isPhotorealisticGlobe: Boolean(getCesiumIonConfig(url))
    };
  }
  throw new Error(`暂不支持该预览类型：${type}`);
}

function createLoadingProgressHandler(onProgress?: (percent: number) => void) {
  if (!onProgress) {
    return undefined;
  }
  return (event: ProgressEvent) => {
    if (event.lengthComputable && event.total > 0) {
      onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    }
  };
}

function disposeLoaded(loaded: LoadedPreviewObject) {
  loaded.tiles?.dispose();
  loaded.object.traverse(disposeObject);
}

function resizeRenderer(container: HTMLDivElement, renderer: PreviewRenderer, camera: THREE.PerspectiveCamera) {
  const width = Math.max(container.clientWidth, 1);
  const height = Math.max(container.clientHeight, 1);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

type RuntimeGlobeControls = GlobeControls & {
  needsUpdate: boolean;
  zoomDelta: number;
  zoomDirectionSet: boolean;
  zoomPointSet: boolean;
  _applyRotation?: (x: number, y: number, pivotPoint: THREE.Vector3) => void;
  pointerTracker?: {
    setHoverEvent: (event: unknown) => void;
  };
};

function attachCesiumLikeGlobeInteractions(
  controls: GlobeControls,
  element: HTMLElement,
  isActive: () => boolean,
  shouldBypassLeftDrag: (event: PointerEvent) => boolean = () => false
) {
  const runtimeControls = controls as RuntimeGlobeControls;
  let leftCandidate: { id: number; startX: number; startY: number; lastX: number; lastY: number; pivot: THREE.Vector3; previousCursor: string } | null = null;
  let leftDrag: { id: number; lastX: number; lastY: number; pivot: THREE.Vector3; previousCursor: string } | null = null;
  let rightDrag: { id: number; lastY: number; previousCursor: string } | null = null;
  let middleDrag: { id: number; lastX: number; lastY: number; anchor: THREE.Vector3; previousCursor: string } | null = null;
  const pointer = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const localRay = new THREE.Ray();
  const surfacePoint = new THREE.Vector3();
  const tmpVector = new THREE.Vector3();
  const tmpRight = new THREE.Vector3();
  const tmpUp = new THREE.Vector3();

  const canHandle = () => controls.enabled && isActive();
  const blockEvent = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  const setHoverPoint = (event: PointerEvent | MouseEvent) => {
    runtimeControls.pointerTracker?.setHoverEvent({
      type: "pointermove",
      pointerType: "mouse",
      target: event.target,
      clientX: event.clientX,
      clientY: event.clientY
    });
  };
  const releasePointer = (event?: PointerEvent) => {
    if (!event) return;
    try {
      element.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released by the browser.
    }
  };
  const capturePointer = (event: PointerEvent) => {
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // Some browser targets do not allow pointer capture.
    }
  };
  const getControlsPivotPoint = () => {
    const pivot = new THREE.Vector3();
    const readPivot = controls.getPivotPoint as unknown as (target: THREE.Vector3) => THREE.Vector3 | null;
    return readPivot.call(controls, pivot) ? pivot : null;
  };
  const getSurfacePoint = (clientX: number, clientY: number) => {
    const camera = controls.camera;
    if (!camera) return null;
    const rect = element.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    pointer.y = -((clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    localRay.copy(raycaster.ray).applyMatrix4(controls.ellipsoidFrameInverse);
    const hit = controls.ellipsoid.intersectRay(localRay, surfacePoint);
    if (!hit) return null;
    return surfacePoint.clone().applyMatrix4(controls.ellipsoidFrame);
  };
  const getScreenCenterPivot = () => {
    const rect = element.getBoundingClientRect();
    return getSurfacePoint(rect.left + rect.width / 2, rect.top + rect.height / 2) || getControlsPivotPoint();
  };
  const queueZoom = (delta: number) => {
    if (!delta || !canHandle()) return;
    runtimeControls.zoomDelta += delta;
    runtimeControls.zoomDirectionSet = false;
    runtimeControls.zoomPointSet = false;
    runtimeControls.needsUpdate = true;
  };
  const orbitAroundPivot = (deltaX: number, deltaY: number, pivot: THREE.Vector3) => {
    if (!runtimeControls._applyRotation) return;
    const scale = 2 * Math.PI / Math.max(element.clientHeight, 1);
    runtimeControls._applyRotation.call(runtimeControls, deltaX * scale, deltaY * scale, pivot);
    runtimeControls.needsUpdate = true;
  };
  const panToKeepSurfacePointUnderPointer = (event: PointerEvent) => {
    if (!middleDrag) return;
    const camera = controls.camera;
    if (!camera) return;
    const currentPoint = getSurfacePoint(event.clientX, event.clientY);
    if (currentPoint) {
      tmpVector.subVectors(middleDrag.anchor, currentPoint);
      camera.position.add(tmpVector);
    } else {
      const deltaX = event.clientX - middleDrag.lastX;
      const deltaY = event.clientY - middleDrag.lastY;
      const distance = Math.max(camera.position.distanceTo(middleDrag.anchor), MIN_GLOBE_ZOOM_DISTANCE);
      const worldUnitsPerPixel = camera instanceof THREE.PerspectiveCamera
        ? 2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.max(element.clientHeight, 1)
        : 1;
      tmpRight.set(1, 0, 0).transformDirection(camera.matrixWorld);
      tmpUp.set(0, 1, 0).transformDirection(camera.matrixWorld);
      camera.position
        .addScaledVector(tmpRight, -deltaX * worldUnitsPerPixel)
        .addScaledVector(tmpUp, deltaY * worldUnitsPerPixel);
    }
    camera.updateMatrixWorld();
    runtimeControls.needsUpdate = true;
  };
  const endLeftDrag = (event?: PointerEvent) => {
    if (!leftDrag && !leftCandidate) return;
    element.style.cursor = (leftDrag || leftCandidate)?.previousCursor || "";
    releasePointer(event);
    leftDrag = null;
    leftCandidate = null;
  };
  const endRightDrag = (event?: PointerEvent) => {
    if (!rightDrag) return;
    element.style.cursor = rightDrag.previousCursor;
    releasePointer(event);
    rightDrag = null;
  };
  const endMiddleDrag = (event?: PointerEvent) => {
    if (!middleDrag) return;
    element.style.cursor = middleDrag.previousCursor;
    releasePointer(event);
    middleDrag = null;
  };
  const handlePointerDown = (event: PointerEvent) => {
    if (!canHandle()) return;
    if (event.button === 0) {
      if (!runtimeControls._applyRotation || shouldBypassLeftDrag(event)) return;
      const pivot = getScreenCenterPivot();
      if (!pivot) return;
      leftCandidate = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        pivot,
        previousCursor: element.style.cursor
      };
      return;
    }
    if (event.button === 1) {
      const anchor = getSurfacePoint(event.clientX, event.clientY) || getScreenCenterPivot();
      if (!anchor) return;
      blockEvent(event);
      controls.resetState();
      middleDrag = {
        id: event.pointerId,
        lastX: event.clientX,
        lastY: event.clientY,
        anchor,
        previousCursor: element.style.cursor
      };
      element.style.cursor = "move";
      element.focus();
      capturePointer(event);
      return;
    }
    if (event.button !== 2) return;
    blockEvent(event);
    controls.resetState();
    setHoverPoint(event);
    rightDrag = {
      id: event.pointerId,
      lastY: event.clientY,
      previousCursor: element.style.cursor
    };
    element.style.cursor = "ns-resize";
    element.focus();
    capturePointer(event);
  };
  const handlePointerMove = (event: PointerEvent) => {
    if (leftDrag && leftDrag.id === event.pointerId) {
      blockEvent(event);
      if (!canHandle() || !runtimeControls._applyRotation) {
        endLeftDrag(event);
        return;
      }
      const deltaX = event.clientX - leftDrag.lastX;
      const deltaY = event.clientY - leftDrag.lastY;
      leftDrag.lastX = event.clientX;
      leftDrag.lastY = event.clientY;
      orbitAroundPivot(deltaX, deltaY, leftDrag.pivot);
      return;
    }
    if (leftCandidate && leftCandidate.id === event.pointerId) {
      if (!canHandle()) {
        endLeftDrag(event);
        return;
      }
      const moved = Math.hypot(event.clientX - leftCandidate.startX, event.clientY - leftCandidate.startY);
      if (moved <= 4) {
        return;
      }
      blockEvent(event);
      controls.resetState();
      leftDrag = {
        id: leftCandidate.id,
        lastX: leftCandidate.lastX,
        lastY: leftCandidate.lastY,
        pivot: leftCandidate.pivot,
        previousCursor: leftCandidate.previousCursor
      };
      leftCandidate = null;
      element.style.cursor = "grabbing";
      capturePointer(event);
      const deltaX = event.clientX - leftDrag.lastX;
      const deltaY = event.clientY - leftDrag.lastY;
      leftDrag.lastX = event.clientX;
      leftDrag.lastY = event.clientY;
      orbitAroundPivot(deltaX, deltaY, leftDrag.pivot);
      return;
    }
    if (middleDrag && middleDrag.id === event.pointerId) {
      blockEvent(event);
      if (!canHandle()) {
        endMiddleDrag(event);
        return;
      }
      panToKeepSurfacePointUnderPointer(event);
      middleDrag.lastX = event.clientX;
      middleDrag.lastY = event.clientY;
      return;
    }
    if (!rightDrag || rightDrag.id !== event.pointerId) return;
    blockEvent(event);
    if (!canHandle()) {
      endRightDrag(event);
      return;
    }
    const deltaY = rightDrag.lastY - event.clientY;
    rightDrag.lastY = event.clientY;
    setHoverPoint(event);
    queueZoom(deltaY * CESIUM_RIGHT_DRAG_ZOOM_SPEED);
  };
  const handlePointerEnd = (event: PointerEvent) => {
    if (leftDrag && leftDrag.id === event.pointerId) {
      blockEvent(event);
      endLeftDrag(event);
      return;
    }
    if (leftCandidate && leftCandidate.id === event.pointerId) {
      leftCandidate = null;
      return;
    }
    if (middleDrag && middleDrag.id === event.pointerId) {
      blockEvent(event);
      endMiddleDrag(event);
      return;
    }
    if (!rightDrag || rightDrag.id !== event.pointerId) return;
    blockEvent(event);
    endRightDrag(event);
  };
  const handleContextMenu = (event: MouseEvent) => {
    if (canHandle()) {
      blockEvent(event);
    }
  };
  const handleDoubleClick = (event: MouseEvent) => {
    if (event.button !== 0 || !canHandle()) return;
    blockEvent(event);
    controls.resetState();
    setHoverPoint(event);
    queueZoom(CESIUM_DOUBLE_CLICK_ZOOM_DELTA);
  };

  element.addEventListener("pointerdown", handlePointerDown, true);
  element.addEventListener("contextmenu", handleContextMenu, true);
  element.addEventListener("dblclick", handleDoubleClick, true);
  window.addEventListener("pointermove", handlePointerMove, true);
  window.addEventListener("pointerup", handlePointerEnd, true);
  window.addEventListener("pointercancel", handlePointerEnd, true);

  return () => {
    endLeftDrag();
    endRightDrag();
    endMiddleDrag();
    element.removeEventListener("pointerdown", handlePointerDown, true);
    element.removeEventListener("contextmenu", handleContextMenu, true);
    element.removeEventListener("dblclick", handleDoubleClick, true);
    window.removeEventListener("pointermove", handlePointerMove, true);
    window.removeEventListener("pointerup", handlePointerEnd, true);
    window.removeEventListener("pointercancel", handlePointerEnd, true);
  };
}

function isTransformControlPointerHit(
  event: PointerEvent,
  controls: TransformControls | null,
  camera: THREE.Camera,
  element: HTMLElement
): boolean {
  if (!controls) return false;
  const helper = controls.getHelper();
  if (!helper.visible) return false;
  const rect = element.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
    -((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1
  );
  const raycaster = new THREE.Raycaster();
  helper.updateMatrixWorld(true);
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObject(helper, true).length > 0;
}

function getRendererBackend(renderer: PreviewRenderer): RendererBackend {
  const backend = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean; isWebGLBackend?: boolean } }).backend;
  if (backend?.isWebGPUBackend) return "WebGPU";
  if (backend?.isWebGLBackend) return "WebGL2 fallback";
  return renderer instanceof THREE.WebGLRenderer ? "WebGL" : "WebGPU";
}

function normalizeObjectToPivot(object: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(object);
  if (!Number.isFinite(box.min.x) || box.isEmpty()) {
    return;
  }
  const center = box.getCenter(new THREE.Vector3());
  object.position.sub(center);
}

function alignImportedObjectToZUp(object: THREE.Object3D) {
  object.applyMatrix4(IMPORT_OBJECT_FRAME_ADJUSTMENT);
  object.updateMatrixWorld(true);
}

function shouldAlignImportedObjectToZUp(type: string): boolean {
  return ["gltf", "fbx", "dae", "usd"].includes(type);
}

function focusObject(
  object: THREE.Object3D,
  camera: THREE.PerspectiveCamera,
  sceneMode: PreviewSceneMode,
  globeControls: GlobeControls | null,
  ellipsoidContext: EllipsoidContext
) {
  const sphere = getObjectFocusSphere(object);
  if (!sphere) {
    if (sceneMode === "sphere") {
      setInitialCamera(camera, sceneMode, ellipsoidContext);
    }
    return;
  }
  const radius = Math.max(sphere.radius, MIN_GLOBE_FOCUS_DISTANCE);
  if (sceneMode === "sphere" && globeControls) {
    const normal = getWorldSurfaceNormal(sphere.center, ellipsoidContext);
    const distance = Math.max(radius * 3, MIN_GLOBE_FOCUS_DISTANCE);
    camera.position.copy(sphere.center).addScaledVector(normal, distance);
    camera.up.copy(normal);
    camera.lookAt(sphere.center);
    camera.near = THREE.MathUtils.clamp(distance / 20_000, MIN_GLOBE_CAMERA_NEAR, 1);
    camera.far = Math.max(distance + radius * 10, MAX_GLOBE_CAMERA_FAR);
    camera.updateProjectionMatrix();
    globeControls.update(0);
    applyCloseZoomCameraClipping(camera, ellipsoidContext);
    return;
  }
}

function readCameraView(camera: THREE.PerspectiveCamera, globeControls: GlobeControls | null): SceneViewState["camera"] {
  const target = new THREE.Vector3();
  if (globeControls) {
    globeControls.getPivotPoint(target);
  } else {
    camera.getWorldDirection(target);
    target.multiplyScalar(100).add(camera.position);
  }
  return {
    position: camera.position.toArray() as [number, number, number],
    target: target.toArray() as [number, number, number]
  };
}

function restoreCameraView(
  camera: THREE.PerspectiveCamera,
  sceneViewState: SceneViewState,
  ellipsoidContext: EllipsoidContext
): boolean {
  const view = sceneViewState.camera;
  if (!view || !isFiniteTuple(view.position) || !isFiniteTuple(view.target)) {
    return false;
  }
  const position = new THREE.Vector3().fromArray(view.position);
  const target = new THREE.Vector3().fromArray(view.target);
  if (position.distanceToSquared(target) < 1e-6) {
    return false;
  }
  camera.position.copy(position);
  camera.up.copy(getWorldSurfaceNormal(target, ellipsoidContext));
  camera.lookAt(target);
  camera.near = 1;
  camera.far = MAX_GLOBE_CAMERA_FAR;
  camera.updateProjectionMatrix();
  return true;
}

function isFiniteTuple(value: readonly number[]): value is [number, number, number] {
  return value.length === 3 && value.every(Number.isFinite);
}

function getObjectFocusSphere(object: THREE.Object3D): THREE.Sphere | null {
  const tiles = getTilesRendererFromObject(object);
  if (tiles) {
    const sphere = new THREE.Sphere();
    if (tiles.getBoundingSphere(sphere) && Number.isFinite(sphere.radius) && sphere.radius > 0) {
      return sphere.applyMatrix4(tiles.group.matrixWorld);
    }
  }

  const box = getVisibleObjectBox(object);
  if (!box || box.isEmpty() || !Number.isFinite(box.min.x)) {
    return null;
  }
  return box.getBoundingSphere(new THREE.Sphere());
}

function getVisibleObjectBox(object: THREE.Object3D): THREE.Box3 | null {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const geometryBox = new THREE.Box3();
  let hasBounds = false;

  object.traverse((child) => {
    if (!isObjectVisibleInHierarchy(child)) {
      return;
    }
    const mesh = child as THREE.Object3D & { geometry?: THREE.BufferGeometry };
    const geometry = mesh.geometry;
    if (!geometry) {
      return;
    }
    if (!geometry.boundingBox) {
      geometry.computeBoundingBox();
    }
    if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) {
      return;
    }
    geometryBox.copy(geometry.boundingBox).applyMatrix4(child.matrixWorld);
    box.union(geometryBox);
    hasBounds = true;
  });

  return hasBounds && !box.isEmpty() && Number.isFinite(box.min.x) ? box : null;
}

function getTilesRendererFromObject(object: THREE.Object3D): TilesRenderer | null {
  const candidate = object.userData.previewTilesRenderer;
  return candidate instanceof TilesRenderer ? candidate : null;
}

function createStarField() {
  const geometry = new THREE.BufferGeometry();
  const positions: number[] = [];
  const colors: number[] = [];
  const color = new THREE.Color();
  const count = 1400;
  for (let index = 0; index < count; index += 1) {
    const radius = 90_000_000 + pseudoRandom(index, 11) * 70_000_000;
    const theta = pseudoRandom(index, 23) * Math.PI * 2;
    const phi = Math.acos(2 * pseudoRandom(index, 41) - 1);
    positions.push(
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi)
    );
    const warmth = 0.72 + pseudoRandom(index, 67) * 0.28;
    color.setRGB(warmth, warmth, 1);
    colors.push(color.r, color.g, color.b);
  }

  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 75_000,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.72,
    depthWrite: false
  });
  const stars = new THREE.Points(geometry, material);
  stars.name = "Star Field";
  stars.renderOrder = -10;
  return stars;
}

function pseudoRandom(index: number, salt: number) {
  const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function applyTransformToObject(
  object: THREE.Object3D,
  transform: PreviewTransform,
  type: string,
  sceneMode: PreviewSceneMode,
  ellipsoidContext: EllipsoidContext
) {
  if (shouldUseGeoPlacement(type, sceneMode)) {
    const matrix = geoTransformToMatrix(transform, ellipsoidContext);
    matrix.decompose(object.position, object.quaternion, object.scale);
  } else {
    object.position.fromArray(transform.position);
    object.rotation.set(transform.rotation[0], transform.rotation[1], transform.rotation[2]);
    object.scale.fromArray(transform.scale);
  }
  object.updateMatrixWorld(true);
}

function updateTransformControlTarget(
  controls: TransformControls | null,
  modelRoot: THREE.Object3D,
  transformHandle: THREE.Object3D | null,
  transform: PreviewTransform,
  type: string,
  sceneMode: PreviewSceneMode,
  ellipsoidContext: EllipsoidContext,
  transformMode: TransformMode
) {
  if (!controls) return;
  const useGeospatialTranslateHandle = transformMode === "translate" && shouldUseGeoPlacement(type, sceneMode) && transformHandle;
  const target = useGeospatialTranslateHandle ? transformHandle : modelRoot;
  if (useGeospatialTranslateHandle && transformHandle) {
    const matrix = geospatialFrameToMatrix(transform, ellipsoidContext);
    setObjectWorldMatrix(transformHandle, matrix);
    transformHandle.updateMatrixWorld(true);
  }
  if (controls.object !== target) {
    controls.attach(target);
  }
  controls.setSpace("local");
  updateTransformControlAxisVisibility(controls, transformMode, type, sceneMode);
}

function updateTransformControlAxisVisibility(
  controls: TransformControls,
  transformMode: TransformMode,
  type: string,
  sceneMode: PreviewSceneMode
) {
  const shouldLockToLocalUp = transformMode === "rotate" && shouldUseGeoPlacement(type, sceneMode);
  controls.showX = !shouldLockToLocalUp;
  controls.showY = !shouldLockToLocalUp;
  controls.showZ = true;
}

function readObjectTransform(
  object: THREE.Object3D,
  type: string,
  sceneMode: PreviewSceneMode,
  ellipsoidContext: EllipsoidContext,
  previousTransform: PreviewTransform,
  activeMode: TransformMode
): PreviewTransform {
  object.updateMatrixWorld(true);
  const worldPosition = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
  const position = worldPosition.toArray() as [number, number, number];
  const scale = object.scale.toArray() as [number, number, number];
  if (shouldUseGeoPlacement(type, sceneMode)) {
    const objectFrame = getObjectFrameInEllipsoid(object, ellipsoidContext);
    const cartographic = readGeospatialObjectFrame(objectFrame, ellipsoidContext);
    const geo = {
      longitude: cartographic.longitude,
      latitude: cartographic.latitude,
      height: cartographic.height
    };
    return {
      position,
      rotation: activeMode === "rotate"
        ? [cartographic.azimuth, cartographic.elevation, cartographic.roll]
        : previousTransform.rotation,
      scale: activeMode === "scale" ? scale : previousTransform.scale,
      geo
    };
  }

  return {
    position,
    rotation: activeMode === "rotate"
      ? [object.rotation.x, object.rotation.y, object.rotation.z]
      : previousTransform.rotation,
    scale: activeMode === "scale" ? scale : previousTransform.scale,
    geo: scenePositionToGeo(position, sceneMode, ellipsoidContext)
  };
}

function getSurfacePlacement(
  raycaster: THREE.Raycaster,
  sceneMode: PreviewSceneMode,
  ellipsoidContext: EllipsoidContext,
  surfaceRoot: THREE.Object3D | null,
  modelRoot: THREE.Object3D | null
): SurfacePlacement | null {
  if (surfaceRoot) {
    const surfaceHit = raycaster
      .intersectObject(surfaceRoot, true)
      .find((item) => isPickableObject(item.object) && !isDescendantOf(item.object, modelRoot));
    if (surfaceHit) {
      return getSurfacePlacementFromHit(surfaceHit);
    }
  }

  return getFallbackSurfacePlacement(raycaster.ray, sceneMode, ellipsoidContext);
}

function getSurfacePlacementFromHit(hit: THREE.Intersection): SurfacePlacement {
  return {
    point: hit.point.clone()
  };
}

function hasPointerMoved(intent: CanvasPointerIntent, event: PointerEvent): boolean {
  return Math.hypot(event.clientX - intent.x, event.clientY - intent.y) > 4;
}

function getFallbackSurfacePlacement(
  ray: THREE.Ray,
  sceneMode: PreviewSceneMode,
  ellipsoidContext: EllipsoidContext
): SurfacePlacement | null {
  const target = new THREE.Vector3();
  if (sceneMode === "sphere") {
    const localRay = ray.clone().applyMatrix4(getEllipsoidFrameInverse(ellipsoidContext));
    const hit = ellipsoidContext.geospatialEllipsoid.getIntersection(localRay, target);
    if (hit) {
      target.applyMatrix4(ellipsoidContext.group.matrixWorld);
      return {
        point: target
      };
    }
  }
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = ray.intersectPlane(plane, target);
  return hit
    ? {
      point: target
    }
    : null;
}

function buildLayerTree(
  root: THREE.Object3D,
  options: LayerTreeOptions = {}
): { tree: LayerNode[]; objectsByKey: Map<string, THREE.Object3D> } {
  const objectsByKey = new Map<string, THREE.Object3D>();
  let count = 0;

  const visit = (object: THREE.Object3D, path: string): LayerNode | null => {
    if (count > 500) return null;
    const key = path || "root";
    object.userData.previewLayerKey = key;
    objectsByKey.set(key, object);
    count += 1;
    if (options.shallow) {
      return {
        key,
        title: options.rootTitle || `${safeLayerName(object)}${object.type ? ` · ${object.type}` : ""}`
      };
    }
    const children = object.children
      .map((child, index) => visit(child, `${key}/${index}-${safeLayerName(child)}`))
      .filter((child): child is LayerNode => Boolean(child));

    return {
      key,
      title: options.rootTitle || `${safeLayerName(object)}${object.type ? ` · ${object.type}` : ""}`,
      children: children.length ? children : undefined
    };
  };

  const rootNode = visit(root, "model");
  return {
    tree: rootNode ? [rootNode] : [],
    objectsByKey
  };
}

function safeLayerName(object: THREE.Object3D): string {
  return (object.name || object.type || "Object").slice(0, 80);
}

function collectLayerSignature(root: THREE.Object3D): string {
  const parts: string[] = [];
  let count = 0;
  root.traverse((object) => {
    if (count > 800) return;
    parts.push(`${object.uuid}:${object.type}:${object.name}:${object.children.length}`);
    count += 1;
  });
  return parts.join("|");
}

function findLayerKeyForObject(object: THREE.Object3D): string | null {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (typeof current.userData.previewLayerKey === "string") {
      return current.userData.previewLayerKey;
    }
    current = current.parent;
  }
  return null;
}

function flattenLayerKeys(nodes: LayerNode[]): string[] {
  const keys: string[] = [];
  const visit = (node: LayerNode) => {
    keys.push(node.key);
    node.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return keys;
}

function collectExpandableLayerKeys(nodes: LayerNode[]): string[] {
  const keys: string[] = [];
  const visit = (node: LayerNode) => {
    if (node.children?.length) {
      keys.push(node.key);
      node.children.forEach(visit);
    }
  };
  nodes.forEach(visit);
  return keys;
}

function collectNodeKeys(node: LayerNode): string[] {
  return [
    node.key,
    ...(node.children || []).flatMap(collectNodeKeys)
  ];
}

function getLayerVisibilityState(node: LayerNode, checkedSet: Set<string>): LayerVisibilityState {
  const nodeVisible = checkedSet.has(node.key);
  if (!node.children?.length) {
    return nodeVisible ? "visible" : "hidden";
  }

  const childStates = node.children.map((child) => getLayerVisibilityState(child, checkedSet));
  if (nodeVisible && childStates.every((state) => state === "visible")) {
    return "visible";
  }
  if (!nodeVisible && childStates.every((state) => state === "hidden")) {
    return "hidden";
  }
  return "partial";
}

function collectSceneStats(root: THREE.Object3D): { meshes: number; vertices: number } {
  let meshes = 0;
  let vertices = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes += 1;
    const position = mesh.geometry?.getAttribute("position");
    vertices += position?.count || 0;
  });
  return { meshes, vertices };
}

function disposeObject(object: THREE.Object3D) {
  const mesh = object as THREE.Mesh;
  mesh.geometry?.dispose?.();
  const material = mesh.material;
  if (Array.isArray(material)) {
    material.forEach(disposeMaterial);
  } else if (material) {
    disposeMaterial(material);
  }
}

function disposeMaterial(material: THREE.Material) {
  Object.values(material).forEach((value) => {
    if (value && typeof value === "object" && "isTexture" in value) {
      (value as THREE.Texture).dispose();
    }
  });
  material.dispose();
}

function isHelperObject(object: THREE.Object3D): boolean {
  return object.type.includes("Helper") || object.type.includes("TransformControls");
}

function isObjectVisibleInHierarchy(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) {
      return false;
    }
    current = current.parent;
  }
  return true;
}

function isPickableObject(object: THREE.Object3D): boolean {
  return isObjectVisibleInHierarchy(object) && !isHelperObject(object);
}

function isDescendantOf(object: THREE.Object3D, ancestor: THREE.Object3D | null): boolean {
  if (!ancestor) {
    return false;
  }
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current === ancestor) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function setObjectWorldMatrix(object: THREE.Object3D, worldMatrix: THREE.Matrix4) {
  const localMatrix = worldMatrix.clone();
  if (object.parent) {
    object.parent.updateMatrixWorld(true);
    localMatrix.premultiply(object.parent.matrixWorld.clone().invert());
  }
  localMatrix.decompose(object.position, object.quaternion, object.scale);
}

function removeTransformControlHelperLines(helper: THREE.Object3D) {
  const helperLines: THREE.Object3D[] = [];
  helper.traverse((object) => {
    const tag = (object as THREE.Object3D & { tag?: string }).tag;
    const isLinePrimitive = object.type === "Line" || object.type === "LineSegments";
    const isHelperLine = tag === "helper" || isLinePrimitive || (object.type === "Line" && (
      tag === "helper" ||
      isDescendantOf(object, (helper as THREE.Object3D & { helper?: Record<string, THREE.Object3D> }).helper?.translate || null) ||
      isDescendantOf(object, (helper as THREE.Object3D & { helper?: Record<string, THREE.Object3D> }).helper?.rotate || null) ||
      isDescendantOf(object, (helper as THREE.Object3D & { helper?: Record<string, THREE.Object3D> }).helper?.scale || null)
    ));
    if (isHelperLine) {
      helperLines.push(object);
    }
  });
  helperLines.forEach((object) => object.parent?.remove(object));
}

function getTilesLoadErrorMessage(event: unknown): string {
  const error = (event as { error?: unknown })?.error;
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  const url = (event as { url?: unknown })?.url;
  return typeof url === "string" ? url : "";
}

function resolveContextTilesUrl(payload: PreviewPayload): string | undefined {
  if (CESIUM_ION_TOKEN && CESIUM_ION_ASSET_ID) {
    return `cesium-ion://asset/${encodeURIComponent(CESIUM_ION_ASSET_ID)}`;
  }
  const companionTiles = payload.files.find((file) => (
    file.fileType === "3dtiles" &&
    file.previewable &&
    file.id !== payload.file?.id
  ));
  if (companionTiles) {
    return api.absoluteUrl(api.previewContentUrl(payload.task.id, companionTiles.fileName));
  }
  return undefined;
}

function createDefaultEllipsoidContext(): EllipsoidContext {
  const group = new THREE.Group();
  group.name = "WGS84 Ellipsoid Frame";
  group.updateMatrixWorld(true);
  return {
    tilesEllipsoid: WGS84_ELLIPSOID,
    geospatialEllipsoid: GEOSPATIAL_WGS84,
    group
  };
}

function createTilesRenderer(url: string): TilesRenderer {
  const ionConfig = getCesiumIonConfig(url);
  const tiles = new TilesRenderer(ionConfig?.endpointUrl || (ionConfig ? undefined : url));
  if (ionConfig) {
    tiles.registerPlugin(new CesiumIonAuthPlugin({
      apiToken: ionConfig.apiToken,
      assetId: ionConfig.assetId,
      autoRefreshToken: true
    }));
  }
  tiles.registerPlugin(new GLTFExtensionsPlugin({
    dracoLoader: createDracoLoader(),
    autoDispose: true
  }));
  tiles.registerPlugin(new TilesFadePlugin());
  tiles.registerPlugin(new UpdateOnChangePlugin());
  return tiles;
}

function createDracoLoader() {
  const loader = new DRACOLoader();
  loader.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
  return loader;
}

function registerTilesRenderer(
  tiles: TilesRenderer,
  camera: THREE.Camera,
  renderer: PreviewRenderer,
  element: HTMLElement
) {
  tiles.setCamera(camera);
  tiles.setResolution(
    camera,
    element.clientWidth || renderer.domElement.clientWidth || 1024,
    element.clientHeight || renderer.domElement.clientHeight || 768
  );
}

function setEllipsoidContextFromTiles(
  tiles: TilesRenderer,
  controls: GlobeControls,
  ellipsoidFrame: THREE.Object3D
): EllipsoidContext {
  tiles.group.updateMatrixWorld(true);
  const context = {
    tilesEllipsoid: tiles.ellipsoid,
    geospatialEllipsoid: tilesEllipsoidToGeospatial(tiles.ellipsoid),
    group: ellipsoidFrame
  };
  controls.setEllipsoid(context.tilesEllipsoid, context.group);
  return context;
}

function tilesEllipsoidToGeospatial(ellipsoid: TilesEllipsoid): GeospatialEllipsoid {
  const radius = ellipsoid.radius;
  if (
    Math.abs(radius.x - GEOSPATIAL_WGS84.radii.x) < 1e-6 &&
    Math.abs(radius.y - GEOSPATIAL_WGS84.radii.y) < 1e-6 &&
    Math.abs(radius.z - GEOSPATIAL_WGS84.radii.z) < 1e-6
  ) {
    return GEOSPATIAL_WGS84;
  }
  return new GeospatialEllipsoid(radius.x, radius.y, radius.z);
}

function getCesiumIonConfig(url: string): { apiToken: string; assetId: string | null; endpointUrl?: string } | null {
  if (/^cesium-ion:\/\//i.test(url)) {
    const parsed = new URL(url);
    const token = parsed.searchParams.get("token") || CESIUM_ION_TOKEN;
    const assetIdText = parsed.searchParams.get("assetId") || (
      parsed.hostname === "asset" ? parsed.pathname.replace(/^\//, "") : parsed.hostname
    );
    if (!token) {
      throw new Error("Cesium ion 3D Tiles requires VITE_CESIUM_ION_TOKEN or an ion token URL parameter.");
    }
    const assetId = Number(assetIdText);
    if (!Number.isFinite(assetId)) {
      throw new Error("Cesium ion asset id is invalid.");
    }
    return { apiToken: token, assetId: String(assetId) };
  }

  if (/^https:\/\/api\.cesium\.com\/v1\/assets\/\d+\/endpoint/i.test(url)) {
    const token = CESIUM_ION_TOKEN;
    if (!token) {
      throw new Error("Cesium ion endpoint URLs require VITE_CESIUM_ION_TOKEN.");
    }
    return { apiToken: token, assetId: null, endpointUrl: url };
  }

  return null;
}

function shouldUseGeoPlacement(type: string, sceneMode: PreviewSceneMode): boolean {
  return sceneMode === "sphere";
}

function geoTransformToMatrix(transform: PreviewTransform, ellipsoidContext: EllipsoidContext): THREE.Matrix4 {
  const matrix = geospatialFrameToMatrix(transform, ellipsoidContext)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
      transform.rotation[1],
      transform.rotation[2],
      -transform.rotation[0],
      "ZXY"
    )))
    .multiply(OBJECT_FRAME_ADJUSTMENT);
  matrix.scale(new THREE.Vector3(transform.scale[0], transform.scale[1], transform.scale[2]));
  return matrix;
}

function geospatialFrameToMatrix(transform: PreviewTransform, ellipsoidContext: EllipsoidContext): THREE.Matrix4 {
  const geo = transform.geo || DEFAULT_TRANSFORM.geo!;
  const position = geodeticToLocalPosition(geo, ellipsoidContext);
  const matrix = ellipsoidContext.geospatialEllipsoid
    .getEastNorthUpFrame(position, new THREE.Matrix4());
  ellipsoidContext.group.updateMatrixWorld(true);
  matrix.premultiply(ellipsoidContext.group.matrixWorld);
  return matrix;
}

function getObjectFrameInEllipsoid(object: THREE.Object3D, ellipsoidContext: EllipsoidContext): THREE.Matrix4 {
  object.updateMatrixWorld(true);
  const frameInverse = getEllipsoidFrameInverse(ellipsoidContext);
  const matrix = object.matrixWorld.clone().premultiply(frameInverse);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  return new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1));
}

function readGeospatialObjectFrame(matrix: THREE.Matrix4, ellipsoidContext: EllipsoidContext) {
  const adjusted = matrix.clone().multiply(OBJECT_FRAME_ADJUSTMENT);
  const position = new THREE.Vector3().setFromMatrixPosition(adjusted);
  const geodetic = new Geodetic().setFromECEF(position, {
    ellipsoid: ellipsoidContext.geospatialEllipsoid
  });
  const enuInverse = ellipsoidContext.geospatialEllipsoid
    .getEastNorthUpFrame(position, new THREE.Matrix4())
    .invert();
  adjusted.premultiply(enuInverse);
  const rotation = new THREE.Euler().setFromRotationMatrix(adjusted, "ZXY");
  return {
    longitude: THREE.MathUtils.radToDeg(geodetic.longitude),
    latitude: THREE.MathUtils.radToDeg(geodetic.latitude),
    height: geodetic.height,
    azimuth: -rotation.z,
    elevation: rotation.x,
    roll: rotation.y
  };
}

function geodeticToLocalPosition(
  geo: PreviewGeoPlacement,
  ellipsoidContext: EllipsoidContext,
  target = new THREE.Vector3()
): THREE.Vector3 {
  return new Geodetic(
    THREE.MathUtils.degToRad(geo.longitude),
    THREE.MathUtils.degToRad(geo.latitude),
    geo.height
  ).toECEF(target, {
    ellipsoid: ellipsoidContext.geospatialEllipsoid
  });
}

function getEllipsoidFrameInverse(ellipsoidContext: EllipsoidContext): THREE.Matrix4 {
  ellipsoidContext.group.updateMatrixWorld(true);
  return ellipsoidContext.group.matrixWorld.clone().invert();
}

function getWorldSurfaceNormal(point: THREE.Vector3, ellipsoidContext: EllipsoidContext): THREE.Vector3 {
  const localPoint = point.clone().applyMatrix4(getEllipsoidFrameInverse(ellipsoidContext));
  const normal = ellipsoidContext.geospatialEllipsoid.getSurfaceNormal(localPoint, new THREE.Vector3());
  if (normal.lengthSq() < 1e-10) {
    normal.set(0, 0, 1);
  }
  return normal.transformDirection(ellipsoidContext.group.matrixWorld).normalize();
}

function getTilesetCenterGeo(tiles: TilesRenderer, ellipsoidContext: EllipsoidContext): PreviewGeoPlacement | null {
  const sphere = new THREE.Sphere();
  if (!tiles.getBoundingSphere(sphere) || !Number.isFinite(sphere.radius)) {
    return null;
  }

  const center = sphere.center.clone().applyMatrix4(tiles.group.matrixWorld);
  if (center.lengthSq() < 1e-6) {
    return null;
  }

  return scenePositionToGeo(center.toArray(), "sphere", ellipsoidContext);
}

function setInitialCamera(
  camera: THREE.PerspectiveCamera,
  sceneMode: PreviewSceneMode,
  ellipsoidContext: EllipsoidContext
) {
  const target = geoToScenePosition({
    longitude: DEFAULT_GLOBE_LONGITUDE,
    latitude: DEFAULT_GLOBE_LATITUDE,
    height: 0
  }, "sphere", ellipsoidContext);
  const position = geoToScenePosition({
    longitude: DEFAULT_GLOBE_LONGITUDE,
    latitude: DEFAULT_GLOBE_LATITUDE,
    height: DEFAULT_GLOBE_HEIGHT
  }, "sphere", ellipsoidContext);
  const targetVector = new THREE.Vector3().fromArray(target);
  const positionVector = new THREE.Vector3().fromArray(position);
  camera.position.copy(positionVector);
  camera.up.copy(getWorldSurfaceNormal(targetVector, ellipsoidContext));
  camera.lookAt(targetVector);
  camera.near = 1;
  camera.far = MAX_GLOBE_CAMERA_FAR;
  camera.updateProjectionMatrix();
}

function applyCloseZoomCameraClipping(
  camera: THREE.PerspectiveCamera,
  ellipsoidContext: EllipsoidContext
) {
  const geo = scenePositionToGeo(camera.position.toArray(), "sphere", ellipsoidContext);
  if (!Number.isFinite(geo.height)) {
    return;
  }
  const altitude = Math.max(geo.height, 0);
  const near = THREE.MathUtils.clamp(altitude / 10_000, MIN_GLOBE_CAMERA_NEAR, 10);
  if (Math.abs(camera.near - near) > 1e-6) {
    camera.near = near;
    camera.updateProjectionMatrix();
  }
}

function geoToScenePosition(
  geo: PreviewGeoPlacement,
  sceneMode: PreviewSceneMode,
  ellipsoidContext = createDefaultEllipsoidContext()
): [number, number, number] {
  if (sceneMode === "sphere") {
    const position = geodeticToLocalPosition(geo, ellipsoidContext)
      .applyMatrix4(ellipsoidContext.group.matrixWorld);
    return position.toArray() as [number, number, number];
  }
  return [...DEFAULT_TRANSFORM.position] as [number, number, number];
}

function scenePositionToGeo(
  position: readonly number[],
  sceneMode: PreviewSceneMode,
  ellipsoidContext = createDefaultEllipsoidContext()
): PreviewGeoPlacement {
  if (sceneMode === "sphere") {
    const localPosition = new THREE.Vector3(position[0], position[1], position[2])
      .applyMatrix4(getEllipsoidFrameInverse(ellipsoidContext));
    const geodetic = new Geodetic().setFromECEF(localPosition, {
      ellipsoid: ellipsoidContext.geospatialEllipsoid
    });
    return {
      longitude: THREE.MathUtils.radToDeg(geodetic.longitude),
      latitude: THREE.MathUtils.radToDeg(geodetic.latitude),
      height: geodetic.height
    };
  }
  return {
    longitude: position[0] / METERS_PER_DEGREE,
    latitude: -position[2] / METERS_PER_DEGREE,
    height: position[1]
  };
}

function normalizeSceneMode(_state: PreviewState | null, _type: string): PreviewSceneMode {
  return "sphere";
}

function shouldDefaultCollapseInspector(): boolean {
  return typeof window !== "undefined" && window.innerWidth < 1280;
}

function shouldDefaultCollapseLayerPanel(): boolean {
  return typeof window !== "undefined" && window.innerWidth < 960;
}

function normalizeResetTransform(transform: PreviewTransform, sceneMode: PreviewSceneMode): PreviewTransform {
  const geo = sceneMode === "sphere" && transform.geo
    ? { ...transform.geo }
    : { ...DEFAULT_TRANSFORM.geo! };
  return {
    position: sceneMode === "sphere" ? [...transform.position] as [number, number, number] : [...DEFAULT_TRANSFORM.position] as [number, number, number],
    rotation: [...DEFAULT_TRANSFORM.rotation] as [number, number, number],
    scale: [...DEFAULT_TRANSFORM.scale] as [number, number, number],
    geo
  };
}

function normalizeUprightTransform(transform: PreviewTransform, sceneMode: PreviewSceneMode): PreviewTransform {
  const geo = transform.geo ? { ...transform.geo } : undefined;
  return {
    ...transform,
    position: [...transform.position] as [number, number, number],
    rotation: [0, 0, 0],
    scale: [...transform.scale] as [number, number, number],
    geo
  };
}

function normalizeTransformState(state: PreviewState | null, sceneMode: PreviewSceneMode): PreviewTransform {
  const raw = state?.transform || {};
  const geo = normalizeGeo(raw.geo);
  return normalizeTransformForScene({
    position: normalizeTuple(raw.position, DEFAULT_TRANSFORM.position),
    rotation: normalizeTuple(raw.rotation, DEFAULT_TRANSFORM.rotation),
    scale: normalizeTuple(raw.scale, DEFAULT_TRANSFORM.scale, 0.0001),
    geo
  }, sceneMode);
}

function normalizeTransformForScene(transform: PreviewTransform, sceneMode: PreviewSceneMode): PreviewTransform {
  if (sceneMode !== "sphere") {
    return transform;
  }
  return {
    ...transform,
    rotation: [
      normalizeAngle(transform.rotation[0]),
      0,
      0
    ],
    geo: transform.geo ? { ...transform.geo } : { ...DEFAULT_TRANSFORM.geo! }
  };
}

function normalizeAngle(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function normalizeTuple(
  value: unknown,
  fallback: [number, number, number],
  minValue?: number
): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    return [...fallback] as [number, number, number];
  }
  const next = value.map((item, index) => {
    const number = Number(item);
    const safe = Number.isFinite(number) ? number : fallback[index];
    return minValue === undefined ? safe : Math.max(minValue, safe);
  });
  return next as [number, number, number];
}

function normalizeGeo(value: unknown): PreviewGeoPlacement {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_TRANSFORM.geo! };
  }
  const raw = value as Partial<PreviewGeoPlacement>;
  return {
    longitude: clampNumber(raw.longitude, -180, 180, 0),
    latitude: clampNumber(raw.latitude, -90, 90, 0),
    height: finiteNumber(raw.height, 0)
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return THREE.MathUtils.clamp(finiteNumber(value, fallback), min, max);
}

function isModelPreviewType(type: string): boolean {
  return ["fbx", "gltf", "obj", "dae", "stl", "ply", "usd", "3dtiles"].includes(type);
}

function previewTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    fbx: "FBX",
    gltf: "glTF / GLB",
    obj: "OBJ",
    dae: "DAE / Collada",
    stl: "STL",
    ply: "PLY",
    usd: "USD / USDA / USDC / USDZ",
    "3dtiles": "3D Tiles",
    json: "JSON",
    unsupported: "暂不支持"
  };
  return labels[type] || type || "-";
}

function saveLabel(status: PreviewSaveState): string {
  const labels = {
    idle: "",
    saving: "保存中",
    saved: "已保存",
    error: "保存失败"
  };
  return labels[status];
}

function previewFileTooltip(file: ResultFile): string {
  if (file.previewable) return file.fileName;
  if (file.downloadable) return `${file.fileName}（可下载，暂不支持在线预览）`;
  return `${file.fileName}（暂不支持预览或下载）`;
}

function unsupportedPreviewMessage(file?: ResultFile): string {
  if (!file) return "暂无可预览成果文件";
  if (file.downloadable) return "该成果类型暂不支持在线预览，可下载后查看";
  return "该成果类型暂不支持在线预览，且当前文件不可下载";
}

function formatSize(value: number): string {
  if (!value) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function roundDisplay(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : 0;
}
