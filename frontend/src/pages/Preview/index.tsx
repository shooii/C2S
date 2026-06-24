import { type CSSProperties, type Dispatch, type PointerEvent as ReactPointerEvent, type ReactNode, type SetStateAction, memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Divider,
  Empty,
  Input,
  InputNumber,
  Radio,
  Result,
  Slider,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography
} from "antd";
import {
  AimOutlined,
  ArrowLeftOutlined,
  BgColorsOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  ColumnHeightOutlined,
  CompressOutlined,
  DownOutlined,
  DragOutlined,
  EnvironmentOutlined,
  FileOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  GlobalOutlined,
  HomeOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  NodeIndexOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  RightOutlined,
  RotateRightOutlined,
  SearchOutlined,
  SettingOutlined,
  StarOutlined,
  SunOutlined,
  UndoOutlined,
  UpOutlined
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
import { detectWebGPUAdapterSupport, describeWebGPUAdapterFailure } from "../../utils/webgpuSupport";
import { createPreviewAtmosphereRenderer, getPreviewSunDirectionECEF, type PreviewAtmosphereRenderer } from "./previewAtmosphereRenderer";
import { AgXPunchyToneMapping, agxPunchyToneMapping } from "./previewAgxToneMapping";
import { configurePreviewGlobeControls, type RuntimeGlobeControls } from "./previewGlobeControls";
import { PreviewTileMaterialReplacementPlugin, replacePreviewMeshMaterials } from "./previewWebGpuMaterials";
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
type ViewCommand = "fit" | "focus-selected" | "reset" | "earth-default" | "cancel-interaction";
type PreviewPerformanceMode = "normal" | "adaptive";
type PreviewInteractionHint =
  | "globe-rotate"
  | "globe-pan"
  | "globe-tilt"
  | "globe-zoom"
  | "view-fit"
  | "view-focus-selected"
  | "view-reset"
  | "view-earth-default"
  | "view-cancel-interaction"
  | "transform-translate"
  | "transform-rotate"
  | "transform-scale";
type PreviewSideTab = "files" | "materials" | "meshes";
type PreviewMeshViewMode = "list" | "tree";
type LayerVisibilityState = "visible" | "hidden" | "partial";
type PreviewSaveState = "idle" | "saving" | "saved" | "error";

interface PreviewViewOptions {
  stars: boolean;
}

interface LayerNode {
  key: string;
  title: string;
  kind?: string;
  children?: LayerNode[];
}

interface MaterialNode {
  key: string;
  title: string;
  layerKey: string | null;
  objectCount: number;
  color?: string;
}

interface SceneInfo {
  backend: RendererBackend;
  status: LoadStatus;
  message: string;
  meshes: number;
  vertices: number;
  fps?: number;
  performanceMode?: PreviewPerformanceMode;
}

interface PreviewStateSaveQueueItem {
  taskId: string;
  fileId: string;
  signature: string;
  previewState: PreviewState;
}

interface ViewCommandRequest {
  type: ViewCommand;
  revision: number;
  signature: string;
}

interface ViewCommandHandledResult {
  cancelledInteraction?: boolean;
}

type PreviewRenderer = THREE.WebGLRenderer | InstanceType<typeof WebGPURenderer>;

const PREVIEW_LEFT_PANEL_MIN_WIDTH = 260;
const PREVIEW_LEFT_PANEL_MAX_WIDTH = 460;
const PREVIEW_LEFT_PANEL_DEFAULT_WIDTH = 312;
const PREVIEW_RIGHT_PANEL_MIN_WIDTH = 248;
const PREVIEW_RIGHT_PANEL_MAX_WIDTH = 420;
const PREVIEW_RIGHT_PANEL_DEFAULT_WIDTH = 288;
const PREVIEW_PANEL_LAYOUT_STORAGE_KEY = "c2s.preview.panelLayout.v1";
const PREVIEW_VIEW_OPTIONS_STORAGE_KEY = "c2s.preview.viewOptions.v1";
const PREVIEW_SIDE_PANEL_STORAGE_KEY = "c2s.preview.sidePanel.v1";
const PREVIEW_LAYER_ROW_HEIGHT = 36;
const PREVIEW_LAYER_VIRTUAL_THRESHOLD = 140;
const PREVIEW_LAYER_VIRTUAL_OVERSCAN = 12;
const PREVIEW_MATERIAL_ROW_HEIGHT = 40;
const PREVIEW_MATERIAL_VIRTUAL_THRESHOLD = 120;
const PREVIEW_MATERIAL_VIRTUAL_OVERSCAN = 10;
const PREVIEW_MODEL_HIT_CACHE_MS = 350;
const PREVIEW_DYNAMIC_LAYER_SIGNATURE_LIMIT = 160;
const PREVIEW_DYNAMIC_PICKABLE_SCAN_LIMIT = 1200;
const PREVIEW_DYNAMIC_PICKABLE_OBJECT_LIMIT = 520;
const PREVIEW_DYNAMIC_MATERIAL_SCAN_LIMIT = 650;
const PREVIEW_DYNAMIC_STATS_SCAN_LIMIT = 1000;
const PREVIEW_DAY_MINUTES = 24 * 60;
const PREVIEW_TIME_SLIDER_STEP_MINUTES = 15;

function clampPreviewLeftPanelWidth(width: number): number {
  return Math.round(THREE.MathUtils.clamp(
    width,
    PREVIEW_LEFT_PANEL_MIN_WIDTH,
    PREVIEW_LEFT_PANEL_MAX_WIDTH
  ));
}

function clampPreviewRightPanelWidth(width: number): number {
  return Math.round(THREE.MathUtils.clamp(
    width,
    PREVIEW_RIGHT_PANEL_MIN_WIDTH,
    PREVIEW_RIGHT_PANEL_MAX_WIDTH
  ));
}

function normalizePreviewFps(fps?: number): number | undefined {
  return typeof fps === "number" && Number.isFinite(fps) && fps > 0
    ? Math.round(fps)
    : undefined;
}

function isSamePreviewSceneInfo(current: SceneInfo, next: SceneInfo): boolean {
  return current.backend === next.backend &&
    current.status === next.status &&
    current.message === next.message &&
    current.meshes === next.meshes &&
    current.vertices === next.vertices &&
    normalizePreviewFps(current.fps) === normalizePreviewFps(next.fps) &&
    (current.performanceMode || "normal") === (next.performanceMode || "normal");
}

function normalizePreviewKeyList(keys: string[]): string[] {
  return Array.from(new Set(keys)).sort();
}

function isSamePreviewKeySet(first: string[], second: string[]): boolean {
  const normalizedFirst = normalizePreviewKeyList(first);
  const normalizedSecond = normalizePreviewKeyList(second);
  return normalizedFirst.length === normalizedSecond.length &&
    normalizedFirst.every((key, index) => key === normalizedSecond[index]);
}

function formatPreviewStateNumber(value: number): number {
  return Number.isFinite(value)
    ? Math.round(value * 1_000_000_000) / 1_000_000_000
    : 0;
}

function roundPreviewTimeToMinute(timeMs: number): number {
  if (!Number.isFinite(timeMs)) {
    return roundPreviewTimeToMinute(Date.now());
  }
  return Math.round(timeMs / 60_000) * 60_000;
}

function padPreviewTimePart(value: number): string {
  return String(value).padStart(2, "0");
}

function formatPreviewDateTimeLocal(timeMs: number): string {
  const date = new Date(Number.isFinite(timeMs) ? timeMs : Date.now());
  return [
    date.getFullYear(),
    "-",
    padPreviewTimePart(date.getMonth() + 1),
    "-",
    padPreviewTimePart(date.getDate()),
    "T",
    padPreviewTimePart(date.getHours()),
    ":",
    padPreviewTimePart(date.getMinutes())
  ].join("");
}

function parsePreviewDateTimeLocal(value: string): number | null {
  const timeMs = new Date(value).getTime();
  return Number.isFinite(timeMs) ? roundPreviewTimeToMinute(timeMs) : null;
}

function getPreviewTimeOfDayMinutes(timeMs: number): number {
  const date = new Date(Number.isFinite(timeMs) ? timeMs : Date.now());
  return date.getHours() * 60 + date.getMinutes();
}

function setPreviewTimeOfDayMinutes(timeMs: number, minuteOfDay: number): number {
  const date = new Date(Number.isFinite(timeMs) ? timeMs : Date.now());
  const normalizedMinute = Math.round(THREE.MathUtils.clamp(minuteOfDay, 0, PREVIEW_DAY_MINUTES - 1));
  date.setHours(Math.floor(normalizedMinute / 60), normalizedMinute % 60, 0, 0);
  return date.getTime();
}

function formatPreviewMinuteOfDay(minuteOfDay: number): string {
  const normalizedMinute = Math.round(THREE.MathUtils.clamp(minuteOfDay, 0, PREVIEW_DAY_MINUTES - 1));
  return `${padPreviewTimePart(Math.floor(normalizedMinute / 60))}:${padPreviewTimePart(normalizedMinute % 60)}`;
}

function getPreviewSolarTimeMs(timeMs: number, longitude: number): number {
  const date = new Date(Number.isFinite(timeMs) ? timeMs : Date.now());
  const year = date.getFullYear();
  const dayOfYear = getPreviewLocalDayOfYear(date);
  const timeOfDay = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  const epoch = Date.UTC(year, 0, 1, 0, 0, 0, 0);
  const longitudeOffset = longitude / 15;
  return epoch + ((dayOfYear - 1) * 24 + timeOfDay - longitudeOffset) * 3_600_000;
}

function getPreviewLocalDayOfYear(date: Date): number {
  const start = Date.UTC(date.getFullYear(), 0, 1);
  const day = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((day - start) / 86_400_000) + 1;
}

function getPreviewLightingReferenceGeo(transform: PreviewTransform, modelLoaded: boolean): PreviewGeoPlacement {
  if (modelLoaded && transform.geo && !isDefaultPreviewLightingGeo(transform.geo)) {
    return transform.geo;
  }
  return {
    longitude: DEFAULT_GLOBE_LONGITUDE,
    latitude: DEFAULT_GLOBE_LATITUDE,
    height: 0
  };
}

function isDefaultPreviewLightingGeo(geo: PreviewGeoPlacement): boolean {
  return Math.abs(geo.longitude) < 1e-8 &&
    Math.abs(geo.latitude) < 1e-8 &&
    Math.abs(geo.height) < 1e-4;
}

const previewLightingSurfaceScratch = new THREE.Vector3();
const previewLightingNormalScratch = new THREE.Vector3();
const previewLightingSunScratch = new THREE.Vector3();

function getPreviewTimeLightingState(
  timeMs: number,
  transform: PreviewTransform,
  ellipsoidContext: EllipsoidContext,
  modelLoaded: boolean
): PreviewTimeLightingState {
  const referenceGeo = getPreviewLightingReferenceGeo(transform, modelLoaded);
  const solarTimeMs = getPreviewSolarTimeMs(timeMs, referenceGeo.longitude);
  const localPosition = geodeticToLocalPosition({
    longitude: referenceGeo.longitude,
    latitude: referenceGeo.latitude,
    height: 0
  }, ellipsoidContext, previewLightingSurfaceScratch);
  const normal = ellipsoidContext.geospatialEllipsoid
    .getSurfaceNormal(localPosition, previewLightingNormalScratch)
    .normalize();
  const sunDirection = getPreviewSunDirectionECEF(solarTimeMs, previewLightingSunScratch);
  const sunElevation = THREE.MathUtils.clamp(normal.dot(sunDirection), -1, 1);
  const daylight = smoothPreviewLighting(-0.06, 0.28, sunElevation);
  const horizonGlow = 1 - Math.min(1, Math.abs(sunElevation + 0.02) / 0.22);
  const twilight = THREE.MathUtils.clamp(horizonGlow, 0, 1) * (1 - daylight * 0.45);
  const backgroundColor = PREVIEW_LIGHTING_NIGHT_SKY.clone().lerp(PREVIEW_LIGHTING_DAY_SKY, daylight);
  const sunColor = PREVIEW_LIGHTING_SUNSET.clone().lerp(PREVIEW_LIGHTING_DAY_SUN, smoothPreviewLighting(0.04, 0.45, sunElevation));

  return {
    daylight,
    sunIntensity: 0.08 + daylight * 4.45 + twilight * 0.95,
    hemisphereIntensity: 0.16 + daylight * 0.95 + twilight * 0.24,
    atmosphereHemisphereIntensity: 0.05 + daylight * 0.3 + twilight * 0.12,
    rendererExposure: 0.42 + daylight * 0.96 + twilight * 0.16,
    atmosphereExposure: 7 + daylight * 30 + twilight * 9,
    starOpacity: 0.78 - daylight * 0.58,
    backgroundColor,
    sunColor,
    solarTimeMs,
    signature: [
      Math.round(solarTimeMs / 60_000),
      daylight.toFixed(3),
      twilight.toFixed(3)
    ].join(":")
  };
}

function smoothPreviewLighting(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function getPreviewTransformPersistenceState(transform: PreviewTransform) {
  return {
    position: transform.position.map(formatPreviewStateNumber),
    rotation: transform.rotation.map(formatPreviewStateNumber),
    scale: transform.scale.map(formatPreviewStateNumber),
    geo: transform.geo
      ? {
        longitude: formatPreviewStateNumber(transform.geo.longitude),
        latitude: formatPreviewStateNumber(transform.geo.latitude),
        height: formatPreviewStateNumber(transform.geo.height)
      }
      : null
  };
}

function getPreviewTransformPersistenceSignature(
  sceneMode: PreviewSceneMode,
  transform: PreviewTransform
): string {
  return JSON.stringify({
    sceneMode,
    transform: getPreviewTransformPersistenceState(transform)
  });
}

function isSamePreviewTransform(
  sceneMode: PreviewSceneMode,
  current: PreviewTransform,
  next: PreviewTransform
): boolean {
  return getPreviewTransformPersistenceSignature(sceneMode, current) ===
    getPreviewTransformPersistenceSignature(sceneMode, next);
}

function getPreviewStatePersistenceSignature(
  sceneMode: PreviewSceneMode,
  transform: PreviewTransform,
  selectedLayerKey: string | null,
  hiddenLayerKeys: string[]
): string {
  return JSON.stringify({
    sceneMode,
    transform: getPreviewTransformPersistenceState(transform),
    selectedLayerKey: selectedLayerKey || null,
    hiddenLayerKeys: normalizePreviewKeyList(hiddenLayerKeys)
  });
}
type PreviewTilesQuality = "normal" | "balanced" | "interactive";

interface PreviewTilesResolutionState {
  width: number;
  height: number;
  quality: PreviewTilesQuality;
  errorTarget: number;
  maxTilesProcessed: number;
}

interface PreviewPanelWidthRafState {
  frameId: number;
  width: number | null;
}

interface PreviewPanelLayoutPreferences {
  leftPanelWidth?: number;
  rightPanelWidth?: number;
  leftPanelCollapsed?: boolean;
  rightPanelCollapsed?: boolean;
}

interface PreviewSidePanelPreferences {
  activeSideTab?: PreviewSideTab;
  meshViewMode?: PreviewMeshViewMode;
}

function isPreviewSideTab(value: unknown): value is PreviewSideTab {
  return value === "files" || value === "materials" || value === "meshes";
}

function isPreviewMeshViewMode(value: unknown): value is PreviewMeshViewMode {
  return value === "list" || value === "tree";
}

function readPreviewPanelLayoutPreferences(): PreviewPanelLayoutPreferences {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const rawValue = window.localStorage.getItem(PREVIEW_PANEL_LAYOUT_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }
    const parsedValue = JSON.parse(rawValue) as PreviewPanelLayoutPreferences;
    return parsedValue && typeof parsedValue === "object" ? parsedValue : {};
  } catch {
    return {};
  }
}

function writePreviewPanelLayoutPreferences(nextPreferences: PreviewPanelLayoutPreferences) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const currentPreferences = readPreviewPanelLayoutPreferences();
    const nextValue = JSON.stringify({
      ...currentPreferences,
      ...nextPreferences
    });
    if (window.localStorage.getItem(PREVIEW_PANEL_LAYOUT_STORAGE_KEY) === nextValue) {
      return;
    }
    window.localStorage.setItem(PREVIEW_PANEL_LAYOUT_STORAGE_KEY, nextValue);
  } catch {
    // Local storage may be unavailable in restricted browsing modes.
  }
}

function getInitialPreviewLeftPanelWidth(): number {
  const storedWidth = readPreviewPanelLayoutPreferences().leftPanelWidth;
  return typeof storedWidth === "number" && Number.isFinite(storedWidth)
    ? clampPreviewLeftPanelWidth(storedWidth)
    : PREVIEW_LEFT_PANEL_DEFAULT_WIDTH;
}

function getInitialPreviewRightPanelWidth(): number {
  const storedWidth = readPreviewPanelLayoutPreferences().rightPanelWidth;
  return typeof storedWidth === "number" && Number.isFinite(storedWidth)
    ? clampPreviewRightPanelWidth(storedWidth)
    : PREVIEW_RIGHT_PANEL_DEFAULT_WIDTH;
}

function getInitialPreviewLeftPanelCollapsed(): boolean {
  const storedCollapsed = readPreviewPanelLayoutPreferences().leftPanelCollapsed;
  return typeof storedCollapsed === "boolean" ? storedCollapsed : shouldDefaultCollapseLayerPanel();
}

function getInitialPreviewRightPanelCollapsed(): boolean {
  const storedCollapsed = readPreviewPanelLayoutPreferences().rightPanelCollapsed;
  return typeof storedCollapsed === "boolean" ? storedCollapsed : shouldDefaultCollapseInspector();
}

function hasStoredPreviewLeftPanelCollapsedPreference(): boolean {
  return typeof readPreviewPanelLayoutPreferences().leftPanelCollapsed === "boolean";
}

function hasStoredPreviewRightPanelCollapsedPreference(): boolean {
  return typeof readPreviewPanelLayoutPreferences().rightPanelCollapsed === "boolean";
}

function readPreviewViewOptions(): PreviewViewOptions {
  if (typeof window === "undefined") {
    return { stars: true };
  }
  try {
    const rawValue = window.localStorage.getItem(PREVIEW_VIEW_OPTIONS_STORAGE_KEY);
    if (!rawValue) {
      return { stars: true };
    }
    const parsedValue = JSON.parse(rawValue) as Partial<PreviewViewOptions>;
    return {
      stars: typeof parsedValue.stars === "boolean" ? parsedValue.stars : true
    };
  } catch {
    return { stars: true };
  }
}

function writePreviewViewOptions(nextOptions: PreviewViewOptions) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const nextValue = JSON.stringify(nextOptions);
    if (window.localStorage.getItem(PREVIEW_VIEW_OPTIONS_STORAGE_KEY) === nextValue) {
      return;
    }
    window.localStorage.setItem(PREVIEW_VIEW_OPTIONS_STORAGE_KEY, nextValue);
  } catch {
    // Local storage may be unavailable in restricted browsing modes.
  }
}

function readPreviewSidePanelPreferences(): PreviewSidePanelPreferences {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const rawValue = window.localStorage.getItem(PREVIEW_SIDE_PANEL_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }
    const parsedValue = JSON.parse(rawValue) as PreviewSidePanelPreferences;
    return {
      activeSideTab: isPreviewSideTab(parsedValue.activeSideTab) ? parsedValue.activeSideTab : undefined,
      meshViewMode: isPreviewMeshViewMode(parsedValue.meshViewMode) ? parsedValue.meshViewMode : undefined
    };
  } catch {
    return {};
  }
}

function writePreviewSidePanelPreferences(nextPreferences: PreviewSidePanelPreferences) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const currentPreferences = readPreviewSidePanelPreferences();
    const nextValue = JSON.stringify({
      ...currentPreferences,
      ...nextPreferences
    });
    if (window.localStorage.getItem(PREVIEW_SIDE_PANEL_STORAGE_KEY) === nextValue) {
      return;
    }
    window.localStorage.setItem(PREVIEW_SIDE_PANEL_STORAGE_KEY, nextValue);
  } catch {
    // Local storage may be unavailable in restricted browsing modes.
  }
}

function getInitialPreviewSideTab(): PreviewSideTab {
  return readPreviewSidePanelPreferences().activeSideTab || "files";
}

function getInitialPreviewMeshViewMode(): PreviewMeshViewMode {
  return readPreviewSidePanelPreferences().meshViewMode || "list";
}

function schedulePreviewPanelWidthUpdate(
  updateRef: { current: PreviewPanelWidthRafState },
  width: number,
  setWidth: Dispatch<SetStateAction<number>>
) {
  updateRef.current.width = width;
  if (updateRef.current.frameId) {
    return;
  }
  updateRef.current.frameId = window.requestAnimationFrame(() => {
    const nextWidth = updateRef.current.width;
    updateRef.current.frameId = 0;
    updateRef.current.width = null;
    if (typeof nextWidth === "number") {
      setWidth((current) => (current === nextWidth ? current : nextWidth));
    }
  });
}

function flushPreviewPanelWidthUpdate(
  updateRef: { current: PreviewPanelWidthRafState },
  setWidth: Dispatch<SetStateAction<number>>
) {
  if (updateRef.current.frameId) {
    window.cancelAnimationFrame(updateRef.current.frameId);
    updateRef.current.frameId = 0;
  }
  const nextWidth = updateRef.current.width;
  updateRef.current.width = null;
  if (typeof nextWidth === "number") {
    setWidth((current) => (current === nextWidth ? current : nextWidth));
  }
}

function cancelPreviewPanelWidthUpdate(updateRef: { current: PreviewPanelWidthRafState }) {
  if (updateRef.current.frameId) {
    window.cancelAnimationFrame(updateRef.current.frameId);
  }
  updateRef.current.frameId = 0;
  updateRef.current.width = null;
}

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

interface CanvasPickRequest {
  clientX: number;
  clientY: number;
  modelRoot: THREE.Object3D;
}

interface CanvasHoverRequest {
  clientX: number;
  clientY: number;
  shiftKey: boolean;
}

interface PreviewTimeLightingState {
  daylight: number;
  sunIntensity: number;
  hemisphereIntensity: number;
  atmosphereHemisphereIntensity: number;
  rendererExposure: number;
  atmosphereExposure: number;
  starOpacity: number;
  backgroundColor: THREE.Color;
  sunColor: THREE.Color;
  solarTimeMs: number;
  signature: string;
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
  shortcut: string;
  tooltip: string;
  icon: ReactNode;
}> = [
  { value: "translate", label: "平移 W", shortcut: "W", tooltip: "切换到平移（W）", icon: <DragOutlined /> },
  { value: "rotate", label: "旋转 E", shortcut: "E", tooltip: "切换到旋转（E）", icon: <RotateRightOutlined /> },
  { value: "scale", label: "缩放 R", shortcut: "R", tooltip: "切换到缩放（R）", icon: <CompressOutlined /> }
];

const METERS_PER_DEGREE = 111_319.49079327358;
const DEFAULT_GLOBE_LONGITUDE = 104;
const DEFAULT_GLOBE_LATITUDE = 30;
const DEFAULT_GLOBE_HEIGHT = 10_000_000;
const MIN_GLOBE_ZOOM_DISTANCE = 2;
const MIN_GLOBE_CAMERA_NEAR = 0.001;
const MAX_GLOBE_CAMERA_FAR = 120_000_000;
const MIN_GLOBE_FOCUS_DISTANCE = 0.5;
const PREVIEW_LIGHTING_NIGHT_SKY = new THREE.Color(0x020611);
const PREVIEW_LIGHTING_DAY_SKY = new THREE.Color(0x071422);
const PREVIEW_LIGHTING_SUNSET = new THREE.Color(0xffb06a);
const PREVIEW_LIGHTING_DAY_SUN = new THREE.Color(0xffffff);
const PREVIEW_MAX_PIXEL_RATIO = 1.5;
const PREVIEW_INTERACTIVE_PIXEL_RATIO = 0.9;
const PREVIEW_LOW_FPS_PIXEL_RATIO = 0.85;
const PREVIEW_LOW_FPS_THRESHOLD = 18;
const PREVIEW_LOW_FPS_RECOVER_THRESHOLD = 28;
const PREVIEW_LOW_FPS_RECOVERY_MS = 2200;
const PREVIEW_LOW_FPS_INFO_INTERVAL_MS = 1800;
const PREVIEW_FPS_SIGNIFICANT_CHANGE = 3;
const PREVIEW_TILES_MAX_RESOLUTION = 1600;
const PREVIEW_BALANCED_TILES_MAX_RESOLUTION = 900;
const PREVIEW_INTERACTIVE_TILES_MAX_RESOLUTION = 520;
const PREVIEW_TILE_ERROR_TARGET = 12;
const PREVIEW_BALANCED_TILE_ERROR_TARGET = 42;
const PREVIEW_INTERACTIVE_TILE_ERROR_TARGET = 96;
const PREVIEW_TILE_MAX_PROCESSED = 220;
const PREVIEW_BALANCED_TILE_MAX_PROCESSED = 110;
const PREVIEW_INTERACTIVE_TILE_MAX_PROCESSED = 60;
const PREVIEW_DYNAMIC_SUMMARY_INTERVAL_MS = 1500;
const PREVIEW_DEFERRED_SUMMARY_DELAY_MS = 350;
const PREVIEW_VIEW_STATE_SYNC_INTERVAL_MS = 2000;
const PREVIEW_DEFERRED_VIEW_STATE_SYNC_DELAY_MS = 280;
const PREVIEW_SCENE_VIEW_NUMBER_PRECISION = 2;
const PREVIEW_IDLE_RENDER_INTERVAL_MS = 125;
const PREVIEW_LOW_FPS_TILES_UPDATE_INTERVAL_MS = 320;
const PREVIEW_BACKGROUND_RENDER_INTERVAL_MS = 1000;
const PREVIEW_SCENE_VISUAL_DIRTY_MS = 320;
const PREVIEW_TILES_VISUAL_DIRTY_MS = 900;
const PREVIEW_LOAD_PROGRESS_STEP = 5;
const PREVIEW_LOAD_PROGRESS_INTERVAL_MS = 250;
const PREVIEW_INTERACTION_MARK_INTERVAL_MS = 80;
const PREVIEW_TRANSFORM_CHANGE_THROTTLE_MS = 80;
const PREVIEW_HOVER_PICK_INTERVAL_MS = 90;
const PREVIEW_HOVER_PICK_MOVE_THRESHOLD_PX = 6;
const GLOBE_INTERACTION_QUALITY_RECOVERY_MS = 650;
const WEBGPU_FALLBACK_MESSAGE = "当前环境无法使用 WebGPU，已自动切换为 WebGL。";
const CESIUM_ION_TOKEN = String(import.meta.env.VITE_CESIUM_ION_TOKEN || "").trim();
const CESIUM_ION_ASSET_ID = String(import.meta.env.VITE_CESIUM_ION_ASSET_ID || "2275207").trim();
const UE_PIXEL_STREAMING_URL = String(import.meta.env.VITE_UE_PIXEL_STREAMING_URL || "").trim();
const GEOSPATIAL_WGS84 = GeospatialEllipsoid.WGS84;
// three-geospatial ENU uses Z as local Up, matching the preview transform fields.
const OBJECT_FRAME_ADJUSTMENT = new THREE.Matrix4();
const IMPORT_OBJECT_FRAME_ADJUSTMENT = new THREE.Matrix4().makeRotationX(Math.PI / 2);
const TILE_RESOLUTION_SIZE = new THREE.Vector2();
const TRANSFORM_CONTROL_HIT_POINTER = new THREE.Vector2();
const TRANSFORM_CONTROL_HIT_RAYCASTER = new THREE.Raycaster();
const TILE_CAMERA_CACHE = new WeakMap<TilesRenderer, THREE.Camera>();
const TILE_RESOLUTION_CACHE = new WeakMap<TilesRenderer, PreviewTilesResolutionState>();

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
  const [activeSideTab, setActiveSideTab] = useState<PreviewSideTab>(getInitialPreviewSideTab);
  const [renderedSideTab, setRenderedSideTab] = useState<PreviewSideTab>(getInitialPreviewSideTab);
  const [meshViewMode, setMeshViewMode] = useState<PreviewMeshViewMode>(getInitialPreviewMeshViewMode);
  const [meshSearchText, setMeshSearchText] = useState("");
  const deferredMeshSearchText = useDeferredValue(meshSearchText);
  const [materialList, setMaterialList] = useState<MaterialNode[]>([]);
  const [selectedMaterialKey, setSelectedMaterialKey] = useState<string | null>(null);
  const [transformMode, setTransformMode] = useState<TransformMode>("translate");
  const [viewOptions, setViewOptions] = useState<PreviewViewOptions>(readPreviewViewOptions);
  const [previewTimeMs, setPreviewTimeMs] = useState(() => roundPreviewTimeToMinute(Date.now()));
  const [viewCommand, setViewCommand] = useState<ViewCommandRequest | null>(null);
  const [placementMode, setPlacementMode] = useState(false);
  const [placementFeedback, setPlacementFeedback] = useState("");
  const [operationHelpOpen, setOperationHelpOpen] = useState(false);
  const [interactionHint, setInteractionHint] = useState<PreviewInteractionHint | null>(null);
  const initialSceneInfo: SceneInfo = {
    backend: "Detecting",
    status: "idle",
    message: "",
    meshes: 0,
    vertices: 0,
    performanceMode: "normal"
  };
  const [sceneInfo, setSceneInfo] = useState<SceneInfo>(initialSceneInfo);
  const [unrealStatus, setUnrealStatus] = useState<UnrealConnectionStatus>("idle");
  const [unrealMessage, setUnrealMessage] = useState("");
  const [engineSwitching, setEngineSwitching] = useState(false);
  const [saveState, setSaveState] = useState<PreviewSaveState>("idle");
  const [saveRevision, setSaveRevision] = useState(0);
  const [leftPanelCollapsed, setLeftPanelCollapsed] = useState(getInitialPreviewLeftPanelCollapsed);
  const [leftPanelWidth, setLeftPanelWidth] = useState(getInitialPreviewLeftPanelWidth);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(getInitialPreviewRightPanelCollapsed);
  const [rightPanelWidth, setRightPanelWidth] = useState(getInitialPreviewRightPanelWidth);
  const [stageFullscreen, setStageFullscreen] = useState(false);
  const placementModeRef = useRef(placementMode);
  const operationHelpOpenRef = useRef(operationHelpOpen);
  const transformModeRef = useRef<TransformMode>(transformMode);
  const stageFullscreenRef = useRef(stageFullscreen);
  const leftPanelTouchedRef = useRef(hasStoredPreviewLeftPanelCollapsedPreference());
  const leftPanelCollapsedRef = useRef(leftPanelCollapsed);
  const leftPanelResizeRef = useRef<{ startX: number; startWidth: number; lastWidth: number } | null>(null);
  const leftPanelWidthUpdateRef = useRef<PreviewPanelWidthRafState>({ frameId: 0, width: null });
  const rightPanelTouchedRef = useRef(hasStoredPreviewRightPanelCollapsedPreference());
  const rightPanelCollapsedRef = useRef(rightPanelCollapsed);
  const rightPanelResizeRef = useRef<{ startX: number; startWidth: number; lastWidth: number } | null>(null);
  const rightPanelWidthUpdateRef = useRef<PreviewPanelWidthRafState>({ frameId: 0, width: null });
  const placementFeedbackTimerRef = useRef(0);
  const placementFeedbackRef = useRef("");
  const interactionHintTimerRef = useRef(0);
  const interactionHintRef = useRef<PreviewInteractionHint | null>(null);
  const viewCommandRef = useRef<ViewCommandRequest | null>(null);
  const sceneInfoRef = useRef<SceneInfo>(initialSceneInfo);
  const unrealStatusRef = useRef<UnrealConnectionStatus>("idle");
  const unrealMessageRef = useRef("");
  const previewEngineSwitchSignatureRef = useRef(`${previewEngine}:${threeRenderer}`);
  const saveStateRef = useRef<PreviewSaveState>("idle");
  const layerTreeSignatureRef = useRef("");
  const expandedLayerKeysRef = useRef<string[]>([]);
  const materialListSignatureRef = useRef("");
  const selectedMaterialKeyRef = useRef<string | null>(null);
  const sideTabRenderTimerRef = useRef(0);
  const activeSideTabRef = useRef<PreviewSideTab>(getInitialPreviewSideTab());
  const meshViewModeRef = useRef<PreviewMeshViewMode>(meshViewMode);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef<PreviewTransform>(normalizeTransformState(initialState, initialSceneMode));
  const selectedLayerKeyRef = useRef<string | null>(initialState?.selectedLayerKey || null);
  const meshSearchRevealSelectionRef = useRef<string | null>(initialState?.selectedLayerKey || null);
  const hiddenLayerKeysRef = useRef<string[]>(initialState?.hiddenLayerKeys || []);
  const latestPreviewSaveRequestSignatureRef = useRef("");
  const previewSaveGenerationRef = useRef(0);
  const previewSaveInFlightRef = useRef(false);
  const queuedPreviewSaveRef = useRef<PreviewStateSaveQueueItem | null>(null);
  const lastPersistedPreviewStateSignatureRef = useRef(getPreviewStatePersistenceSignature(
    initialSceneMode,
    normalizeTransformState(initialState, initialSceneMode),
    initialState?.selectedLayerKey || null,
    initialState?.hiddenLayerKeys || []
  ));
  const isModel = isModelPreviewType(payload.type);
  const hasUnrealPreview = Boolean(UE_PIXEL_STREAMING_URL);
  const activePreviewEngine: PreviewEngine = hasUnrealPreview ? previewEngine : "three";
  const canEditScene = isModel && activePreviewEngine === "three";
  const fileKey = payload.file?.id || "none";

  const updateSaveState = useCallback((nextState: PreviewSaveState) => {
    if (saveStateRef.current === nextState) {
      return;
    }
    saveStateRef.current = nextState;
    setSaveState(nextState);
  }, []);

  const commitSceneInfo = useCallback((next: SceneInfo) => {
    if (isSamePreviewSceneInfo(sceneInfoRef.current, next)) {
      return;
    }
    sceneInfoRef.current = next;
    setSceneInfo(next);
  }, []);

  const commitUnrealStatus = useCallback((status: UnrealConnectionStatus, message = "") => {
    if (unrealStatusRef.current === status && unrealMessageRef.current === message) {
      return;
    }
    unrealStatusRef.current = status;
    unrealMessageRef.current = message;
    setUnrealStatus(status);
    setUnrealMessage(message);
  }, []);

  const commitLeftPanelCollapsed = useCallback((collapsed: boolean) => {
    if (leftPanelCollapsedRef.current === collapsed) {
      return;
    }
    leftPanelCollapsedRef.current = collapsed;
    setLeftPanelCollapsed(collapsed);
  }, []);

  const commitRightPanelCollapsed = useCallback((collapsed: boolean) => {
    if (rightPanelCollapsedRef.current === collapsed) {
      return;
    }
    rightPanelCollapsedRef.current = collapsed;
    setRightPanelCollapsed(collapsed);
  }, []);

  const commitStageFullscreen = useCallback((fullscreen: boolean) => {
    if (stageFullscreenRef.current === fullscreen) {
      return;
    }
    stageFullscreenRef.current = fullscreen;
    setStageFullscreen(fullscreen);
  }, []);

  const commitPlacementMode = useCallback((enabled: boolean) => {
    if (placementModeRef.current === enabled) {
      return;
    }
    placementModeRef.current = enabled;
    setPlacementMode(enabled);
  }, []);

  const togglePlacementMode = useCallback(() => {
    const nextPlacementMode = !placementModeRef.current;
    placementModeRef.current = nextPlacementMode;
    setPlacementMode(nextPlacementMode);
  }, []);

  const commitOperationHelpOpen = useCallback((open: boolean) => {
    if (operationHelpOpenRef.current === open) {
      return;
    }
    operationHelpOpenRef.current = open;
    setOperationHelpOpen(open);
  }, []);

  const toggleOperationHelpOpen = useCallback(() => {
    const nextOpen = !operationHelpOpenRef.current;
    operationHelpOpenRef.current = nextOpen;
    setOperationHelpOpen(nextOpen);
  }, []);

  const commitTransformMode = useCallback((mode: TransformMode) => {
    if (transformModeRef.current === mode) {
      return false;
    }
    transformModeRef.current = mode;
    setTransformMode(mode);
    return true;
  }, []);

  const clearViewCommand = useCallback(() => {
    if (!viewCommandRef.current) {
      return;
    }
    viewCommandRef.current = null;
    setViewCommand(null);
  }, []);

  const commitExpandedLayerKeys = useCallback((keys: string[]) => {
    const nextKeys = Array.from(new Set(keys));
    if (isSamePreviewKeySet(expandedLayerKeysRef.current, nextKeys)) {
      return;
    }
    expandedLayerKeysRef.current = nextKeys;
    setExpandedLayerKeys(nextKeys);
  }, []);

  useEffect(() => {
    const nextState = payload.file?.previewState || null;
    const nextSceneMode = normalizeSceneMode(nextState, payload.type);
    const nextTransform = normalizeTransformState(nextState, nextSceneMode);
    const nextSelectedLayerKey = nextState?.selectedLayerKey || null;
    const nextHiddenLayerKeys = nextState?.hiddenLayerKeys || [];
    setSceneMode(nextSceneMode);
    setTransform(nextTransform);
    setSelectedLayerKey(nextSelectedLayerKey);
    setHiddenLayerKeys(nextHiddenLayerKeys);
    transformRef.current = nextTransform;
    selectedLayerKeyRef.current = nextSelectedLayerKey;
    meshSearchRevealSelectionRef.current = nextSelectedLayerKey;
    hiddenLayerKeysRef.current = nextHiddenLayerKeys;
    latestPreviewSaveRequestSignatureRef.current = "";
    previewSaveGenerationRef.current += 1;
    previewSaveInFlightRef.current = false;
    queuedPreviewSaveRef.current = null;
    lastPersistedPreviewStateSignatureRef.current = getPreviewStatePersistenceSignature(
      nextSceneMode,
      nextTransform,
      nextSelectedLayerKey,
      nextHiddenLayerKeys
    );
    commitExpandedLayerKeys([]);
    setLayerTree([]);
    setMeshSearchText("");
    layerTreeSignatureRef.current = "";
    const nextSideTab = getInitialPreviewSideTab();
    setActiveSideTab(nextSideTab);
    setRenderedSideTab(nextSideTab);
    activeSideTabRef.current = nextSideTab;
    if (sideTabRenderTimerRef.current) {
      window.clearTimeout(sideTabRenderTimerRef.current);
      sideTabRenderTimerRef.current = 0;
    }
    const nextMeshViewMode = getInitialPreviewMeshViewMode();
    meshViewModeRef.current = nextMeshViewMode;
    setMeshViewMode(nextMeshViewMode);
    setMaterialList([]);
    materialListSignatureRef.current = "";
    selectedMaterialKeyRef.current = null;
    setSelectedMaterialKey(null);
    commitTransformMode("translate");
    clearViewCommand();
    commitPlacementMode(false);
    if (placementFeedbackTimerRef.current) {
      window.clearTimeout(placementFeedbackTimerRef.current);
      placementFeedbackTimerRef.current = 0;
    }
    placementFeedbackRef.current = "";
    setPlacementFeedback("");
    commitOperationHelpOpen(false);
    if (interactionHintTimerRef.current) {
      window.clearTimeout(interactionHintTimerRef.current);
      interactionHintTimerRef.current = 0;
    }
    interactionHintRef.current = null;
    setInteractionHint(null);
    updateSaveState("idle");
    setSaveRevision(0);
    setSceneViewState({});
    leftPanelTouchedRef.current = hasStoredPreviewLeftPanelCollapsedPreference();
    rightPanelTouchedRef.current = hasStoredPreviewRightPanelCollapsedPreference();
    commitLeftPanelCollapsed(getInitialPreviewLeftPanelCollapsed());
    commitRightPanelCollapsed(getInitialPreviewRightPanelCollapsed());
  }, [clearViewCommand, commitExpandedLayerKeys, commitLeftPanelCollapsed, commitOperationHelpOpen, commitPlacementMode, commitRightPanelCollapsed, commitTransformMode, fileKey, payload.type, setSceneViewState, updateSaveState]);

  useEffect(() => {
    const syncPreviewResponsiveLayout = () => {
      if (!leftPanelTouchedRef.current) {
        commitLeftPanelCollapsed(shouldDefaultCollapseLayerPanel());
      }
      if (!rightPanelTouchedRef.current) {
        commitRightPanelCollapsed(shouldDefaultCollapseInspector());
      }
    };
    syncPreviewResponsiveLayout();
    window.addEventListener("resize", syncPreviewResponsiveLayout);
    return () => window.removeEventListener("resize", syncPreviewResponsiveLayout);
  }, [commitLeftPanelCollapsed, commitRightPanelCollapsed]);

  useEffect(() => {
    return () => {
      document.body.classList.remove("is-preview-side-resizing");
      document.body.classList.remove("is-preview-inspector-resizing");
      cancelPreviewPanelWidthUpdate(leftPanelWidthUpdateRef);
      cancelPreviewPanelWidthUpdate(rightPanelWidthUpdateRef);
      if (sideTabRenderTimerRef.current) {
        window.clearTimeout(sideTabRenderTimerRef.current);
        sideTabRenderTimerRef.current = 0;
      }
      if (interactionHintTimerRef.current) {
        window.clearTimeout(interactionHintTimerRef.current);
        interactionHintTimerRef.current = 0;
      }
      interactionHintRef.current = null;
    };
  }, []);

  useEffect(() => {
    const nextSwitchSignature = `${previewEngine}:${threeRenderer}`;
    if (previewEngineSwitchSignatureRef.current === nextSwitchSignature) {
      return;
    }
    previewEngineSwitchSignatureRef.current = nextSwitchSignature;
    setEngineSwitching(true);
    const timer = window.setTimeout(() => setEngineSwitching(false), 180);
    return () => window.clearTimeout(timer);
  }, [previewEngine, threeRenderer]);

  const markDirty = useCallback(() => {
    if (payload.file?.id && isModelPreviewType(payload.type)) {
      updateSaveState("saving");
    }
    setSaveRevision((value) => (value > 0 ? value : 1));
  }, [payload.file?.id, payload.type, updateSaveState]);

  const updateTransform = useCallback((next: PreviewTransform) => {
    const normalizedTransform = normalizeTransformForScene(next, sceneMode);
    if (isSamePreviewTransform(sceneMode, transformRef.current, normalizedTransform)) {
      return;
    }
    transformRef.current = normalizedTransform;
    setTransform(normalizedTransform);
    markDirty();
  }, [markDirty, sceneMode]);

  const commitSelectedMaterialKey = useCallback((key: string | null) => {
    if (selectedMaterialKeyRef.current === key) {
      return;
    }
    selectedMaterialKeyRef.current = key;
    setSelectedMaterialKey(key);
  }, []);

  const updateSelectedLayer = useCallback((key: string | null) => {
    if (!key) {
      commitSelectedMaterialKey(null);
    }
    if (selectedLayerKeyRef.current === key) {
      return;
    }
    selectedLayerKeyRef.current = key;
    setSelectedLayerKey(key);
    markDirty();
  }, [commitSelectedMaterialKey, markDirty]);

  const clearPreviewSelection = useCallback(() => {
    updateSelectedLayer(null);
  }, [updateSelectedLayer]);

  const clearScheduledInteractionHint = useCallback(() => {
    if (!interactionHintTimerRef.current) {
      return;
    }
    window.clearTimeout(interactionHintTimerRef.current);
    interactionHintTimerRef.current = 0;
  }, []);

  const handleInteractionHintChange = useCallback((hint: PreviewInteractionHint | null) => {
    if (interactionHintRef.current === hint) {
      return;
    }
    clearScheduledInteractionHint();
    interactionHintRef.current = hint;
    setInteractionHint(hint);
  }, [clearScheduledInteractionHint]);

  const showInteractionHint = useCallback((hint: PreviewInteractionHint, durationMs = 900) => {
    clearScheduledInteractionHint();
    if (interactionHintRef.current !== hint) {
      interactionHintRef.current = hint;
      setInteractionHint(hint);
    }
    interactionHintTimerRef.current = window.setTimeout(() => {
      interactionHintTimerRef.current = 0;
      interactionHintRef.current = null;
      setInteractionHint(null);
    }, durationMs);
  }, [clearScheduledInteractionHint]);

  const issueViewCommand = useCallback((type: ViewCommand) => {
    const nextViewCommandSignature = type === "focus-selected"
      ? `${type}:${selectedLayerKeyRef.current || "scene"}`
      : type === "reset" || type === "earth-default"
        ? `${type}:${sceneMode}`
        : type;
    const pendingViewCommand = viewCommandRef.current;
    if (pendingViewCommand?.signature === nextViewCommandSignature) {
      return;
    }
    const hint = type === "cancel-interaction" ? null : viewCommandInteractionHint(type);
    if (hint) {
      showInteractionHint(hint);
    }
    const nextViewCommand = {
      type,
      revision: (viewCommandRef.current?.revision ?? 0) + 1,
      signature: nextViewCommandSignature
    };
    viewCommandRef.current = nextViewCommand;
    setViewCommand(nextViewCommand);
  }, [sceneMode, showInteractionHint]);

  const updateTransformMode = useCallback((mode: TransformMode) => {
    if (!commitTransformMode(mode)) {
      return;
    }
    showInteractionHint(transformModeInteractionHint(mode));
  }, [commitTransformMode, showInteractionHint]);

  const handleFocusLayer = useCallback((key: string | null) => {
    updateSelectedLayer(key);
    issueViewCommand("focus-selected");
  }, [issueViewCommand, updateSelectedLayer]);

  const updateHiddenLayers = useCallback((keys: string[]) => {
    const nextKeys = Array.from(new Set(keys));
    const selectedKey = selectedLayerKeyRef.current;
    const shouldClearSelection = Boolean(selectedKey && nextKeys.includes(selectedKey));
    const hiddenKeysUnchanged = isSamePreviewKeySet(hiddenLayerKeysRef.current, nextKeys);
    if (hiddenKeysUnchanged && !shouldClearSelection) {
      return;
    }
    if (!hiddenKeysUnchanged) {
      hiddenLayerKeysRef.current = nextKeys;
      setHiddenLayerKeys(nextKeys);
    }
    if (shouldClearSelection) {
      selectedLayerKeyRef.current = null;
      setSelectedLayerKey((current) => (current && nextKeys.includes(current) ? null : current));
      commitSelectedMaterialKey(null);
    }
    markDirty();
  }, [commitSelectedMaterialKey, markDirty]);

  const updateLayerTree = useCallback((tree: LayerNode[]) => {
    const nextSignature = getLayerTreeStateSignature(tree);
    if (nextSignature === layerTreeSignatureRef.current) {
      return;
    }
    layerTreeSignatureRef.current = nextSignature;
    setLayerTree(tree);
    if (!expandedLayerKeysRef.current.length) {
      commitExpandedLayerKeys(collectExpandableLayerKeys(tree));
    }
  }, [commitExpandedLayerKeys]);

  const updateMaterialList = useCallback((materials: MaterialNode[]) => {
    const nextSignature = getMaterialListStateSignature(materials);
    if (nextSignature === materialListSignatureRef.current) {
      return;
    }
    materialListSignatureRef.current = nextSignature;
    setMaterialList(materials);
    if (selectedMaterialKeyRef.current && !materials.some((material) => material.key === selectedMaterialKeyRef.current)) {
      commitSelectedMaterialKey(null);
    }
  }, [commitSelectedMaterialKey]);

  const handleSideTabChange = useCallback((tab: PreviewSideTab) => {
    if (tab === activeSideTabRef.current) {
      return;
    }
    activeSideTabRef.current = tab;
    setActiveSideTab(tab);
    writePreviewSidePanelPreferences({ activeSideTab: tab });
    if (sideTabRenderTimerRef.current) {
      window.clearTimeout(sideTabRenderTimerRef.current);
    }
    sideTabRenderTimerRef.current = window.setTimeout(() => {
      sideTabRenderTimerRef.current = 0;
      setRenderedSideTab(tab);
    }, 16);
  }, []);

  const handleMeshViewModeChange = useCallback((mode: PreviewMeshViewMode) => {
    if (mode === meshViewModeRef.current) {
      return;
    }
    meshViewModeRef.current = mode;
    setMeshViewMode(mode);
    writePreviewSidePanelPreferences({ meshViewMode: mode });
  }, []);

  const handleMaterialSelect = useCallback((material: MaterialNode) => {
    commitSelectedMaterialKey(selectedMaterialKeyRef.current === material.key ? null : material.key);
    if (material.layerKey) {
      updateSelectedLayer(material.layerKey);
    }
  }, [commitSelectedMaterialKey, updateSelectedLayer]);

  const handleMaterialFocus = useCallback((material: MaterialNode) => {
    if (!material.layerKey) {
      return;
    }
    commitSelectedMaterialKey(material.key);
    handleFocusLayer(material.layerKey);
  }, [commitSelectedMaterialKey, handleFocusLayer]);

  const expandLayerPanel = useCallback(() => {
    leftPanelTouchedRef.current = true;
    commitLeftPanelCollapsed(false);
    writePreviewPanelLayoutPreferences({ leftPanelCollapsed: false });
  }, [commitLeftPanelCollapsed]);

  const collapseLayerPanel = useCallback(() => {
    leftPanelTouchedRef.current = true;
    commitLeftPanelCollapsed(true);
    writePreviewPanelLayoutPreferences({ leftPanelCollapsed: true });
  }, [commitLeftPanelCollapsed]);

  const revealSelectedLayerInMeshList = useCallback(() => {
    if (!selectedLayerKeyRef.current) {
      return;
    }
    leftPanelTouchedRef.current = true;
    commitLeftPanelCollapsed(false);
    writePreviewPanelLayoutPreferences({ leftPanelCollapsed: false });
    handleSideTabChange("meshes");
    setMeshSearchText("");
  }, [commitLeftPanelCollapsed, handleSideTabChange]);

  const handleLeftPanelResizeStart = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (leftPanelCollapsed) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    leftPanelTouchedRef.current = true;
    leftPanelResizeRef.current = {
      startX: event.clientX,
      startWidth: leftPanelWidth,
      lastWidth: leftPanelWidth
    };

    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      handle.setPointerCapture?.(pointerId);
    } catch {
      // Pointer capture can fail when the browser has already redirected the pointer.
    }
    document.body.classList.add("is-preview-side-resizing");
    let resizeStopped = false;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const resizeState = leftPanelResizeRef.current;
      if (!resizeState) {
        return;
      }
      const nextWidth = clampPreviewLeftPanelWidth(resizeState.startWidth + moveEvent.clientX - resizeState.startX);
      resizeState.lastWidth = nextWidth;
      schedulePreviewPanelWidthUpdate(leftPanelWidthUpdateRef, nextWidth, setLeftPanelWidth);
    };

    const stopResize = () => {
      if (resizeStopped) {
        return;
      }
      resizeStopped = true;
      const finalWidth = leftPanelResizeRef.current?.lastWidth;
      flushPreviewPanelWidthUpdate(leftPanelWidthUpdateRef, setLeftPanelWidth);
      leftPanelResizeRef.current = null;
      if (typeof finalWidth === "number") {
        writePreviewPanelLayoutPreferences({ leftPanelWidth: finalWidth });
      }
      document.body.classList.remove("is-preview-side-resizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      window.removeEventListener("blur", stopResize);
      handle.removeEventListener("lostpointercapture", stopResize);
      try {
        handle.releasePointerCapture?.(pointerId);
      } catch {
        // Pointer capture may already be released.
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    window.addEventListener("blur", stopResize);
    handle.addEventListener("lostpointercapture", stopResize);
  }, [leftPanelCollapsed, leftPanelWidth]);

  const expandInspector = useCallback(() => {
    rightPanelTouchedRef.current = true;
    commitRightPanelCollapsed(false);
    writePreviewPanelLayoutPreferences({ rightPanelCollapsed: false });
  }, [commitRightPanelCollapsed]);

  const collapseInspector = useCallback(() => {
    rightPanelTouchedRef.current = true;
    commitRightPanelCollapsed(true);
    writePreviewPanelLayoutPreferences({ rightPanelCollapsed: true });
  }, [commitRightPanelCollapsed]);

  const handleRightPanelResizeStart = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (rightPanelCollapsed) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    rightPanelTouchedRef.current = true;
    rightPanelResizeRef.current = {
      startX: event.clientX,
      startWidth: rightPanelWidth,
      lastWidth: rightPanelWidth
    };

    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    try {
      handle.setPointerCapture?.(pointerId);
    } catch {
      // Pointer capture can fail when the browser has already redirected the pointer.
    }
    document.body.classList.add("is-preview-inspector-resizing");
    let resizeStopped = false;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const resizeState = rightPanelResizeRef.current;
      if (!resizeState) {
        return;
      }
      const nextWidth = clampPreviewRightPanelWidth(resizeState.startWidth + resizeState.startX - moveEvent.clientX);
      resizeState.lastWidth = nextWidth;
      schedulePreviewPanelWidthUpdate(rightPanelWidthUpdateRef, nextWidth, setRightPanelWidth);
    };

    const stopResize = () => {
      if (resizeStopped) {
        return;
      }
      resizeStopped = true;
      const finalWidth = rightPanelResizeRef.current?.lastWidth;
      flushPreviewPanelWidthUpdate(rightPanelWidthUpdateRef, setRightPanelWidth);
      rightPanelResizeRef.current = null;
      if (typeof finalWidth === "number") {
        writePreviewPanelLayoutPreferences({ rightPanelWidth: finalWidth });
      }
      document.body.classList.remove("is-preview-inspector-resizing");
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      window.removeEventListener("blur", stopResize);
      handle.removeEventListener("lostpointercapture", stopResize);
      try {
        handle.releasePointerCapture?.(pointerId);
      } catch {
        // Pointer capture may already be released.
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    window.addEventListener("blur", stopResize);
    handle.addEventListener("lostpointercapture", stopResize);
  }, [rightPanelCollapsed, rightPanelWidth]);

  const handleSceneInfoChange = useCallback((info: SceneInfo) => {
    const current = sceneInfoRef.current;
    commitSceneInfo({
      ...info,
      fps: normalizePreviewFps(info.fps ?? current.fps),
      performanceMode: info.performanceMode ?? current.performanceMode ?? "normal"
    });
  }, [commitSceneInfo]);

  const clearPlacementFeedback = useCallback(() => {
    if (placementFeedbackTimerRef.current) {
      window.clearTimeout(placementFeedbackTimerRef.current);
      placementFeedbackTimerRef.current = 0;
    }
    if (!placementFeedbackRef.current) {
      return;
    }
    placementFeedbackRef.current = "";
    setPlacementFeedback("");
  }, []);

  const showPlacementFeedback = useCallback((message: string) => {
    if (placementFeedbackTimerRef.current) {
      window.clearTimeout(placementFeedbackTimerRef.current);
    }
    if (placementFeedbackRef.current !== message) {
      placementFeedbackRef.current = message;
      setPlacementFeedback(message);
    }
    placementFeedbackTimerRef.current = window.setTimeout(() => {
      placementFeedbackTimerRef.current = 0;
      placementFeedbackRef.current = "";
      setPlacementFeedback("");
    }, 1800);
  }, []);

  const toggleExpandedLayer = useCallback((key: string) => {
    const current = expandedLayerKeysRef.current;
    commitExpandedLayerKeys(current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key]
    );
  }, [commitExpandedLayerKeys]);

  const handlePlacementDone = useCallback(() => {
    showPlacementFeedback("模型已放置到地表");
    commitPlacementMode(false);
  }, [commitPlacementMode, showPlacementFeedback]);

  const handlePlacementCancel = useCallback(() => {
    clearPlacementFeedback();
    commitPlacementMode(false);
  }, [clearPlacementFeedback, commitPlacementMode]);

  useEffect(() => () => {
    if (placementFeedbackTimerRef.current) {
      window.clearTimeout(placementFeedbackTimerRef.current);
      placementFeedbackTimerRef.current = 0;
    }
  }, []);

  useEffect(() => {
    if (!placementMode || operationHelpOpen) {
      return;
    }
    const handlePlacementKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      handlePlacementCancel();
    };
    window.addEventListener("keydown", handlePlacementKeyDown);
    return () => window.removeEventListener("keydown", handlePlacementKeyDown);
  }, [handlePlacementCancel, operationHelpOpen, placementMode]);

  useEffect(() => {
    const handlePreviewKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (operationHelpOpen) {
          event.preventDefault();
          commitOperationHelpOpen(false);
          return;
        }
        if (placementMode) {
          event.preventDefault();
          handlePlacementCancel();
          return;
        }
        if (isEditableKeyboardTarget(event.target)) {
          return;
        }
        if (canEditScene) {
          event.preventDefault();
          if (!event.repeat) {
            issueViewCommand("cancel-interaction");
          }
          return;
        }
        if (!selectedLayerKeyRef.current && !selectedMaterialKeyRef.current) {
          return;
        }
        event.preventDefault();
        clearPreviewSelection();
        return;
      }

      if (isEditableKeyboardTarget(event.target)) {
        return;
      }

      if (isOperationHelpShortcut(event) && canEditScene) {
        event.preventDefault();
        if (event.repeat) {
          return;
        }
        toggleOperationHelpOpen();
        return;
      }

      if (event.key.toLowerCase() === "f" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        if (event.repeat) {
          return;
        }
        issueViewCommand(selectedLayerKeyRef.current ? "focus-selected" : "fit");
        return;
      }

      if (event.key === "Home" && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        if (event.repeat) {
          return;
        }
        issueViewCommand(sceneMode === "sphere" ? "earth-default" : "reset");
        return;
      }

      const shortcutTransformMode = getTransformModeShortcut(event.key);
      if (
        shortcutTransformMode &&
        canEditScene &&
        !placementMode &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        if (event.repeat) {
          return;
        }
        updateTransformMode(shortcutTransformMode);
      }
    };
    window.addEventListener("keydown", handlePreviewKeyDown);
    return () => window.removeEventListener("keydown", handlePreviewKeyDown);
  }, [canEditScene, clearPreviewSelection, commitOperationHelpOpen, handlePlacementCancel, issueViewCommand, operationHelpOpen, placementMode, sceneMode, toggleOperationHelpOpen, updateTransformMode]);

  const handleSceneViewStateChange = useCallback((nextState: SceneViewState) => {
    mergeSceneViewState(nextState);
  }, [mergeSceneViewState]);

  const handleUnrealStatusChange = useCallback((status: UnrealConnectionStatus, message = "") => {
    commitUnrealStatus(status, message);
  }, [commitUnrealStatus]);

  const handleViewCommandHandled = useCallback((result?: ViewCommandHandledResult) => {
    const handledCommand = viewCommandRef.current;
    clearViewCommand();
    if (
      handledCommand?.type !== "cancel-interaction"
    ) {
      return;
    }
    if (result?.cancelledInteraction) {
      showInteractionHint("view-cancel-interaction");
      return;
    }
    if (selectedLayerKeyRef.current || selectedMaterialKeyRef.current) {
      clearPreviewSelection();
    }
  }, [clearPreviewSelection, clearViewCommand, showInteractionHint]);

  const handleRendererFallback = useCallback((message: string) => {
    const current = sceneInfoRef.current;
    if (
      current.backend === "WebGL" &&
      current.status === "loading" &&
      current.message === message
    ) {
      return;
    }
    commitSceneInfo({
      ...current,
      backend: "WebGL",
      status: "loading",
      message
    });
    if (threeRenderer !== "webgl") {
      setThreeRenderer("webgl");
    }
  }, [commitSceneInfo, setThreeRenderer, threeRenderer]);

  const handleSwitchToThree = useCallback(() => {
    if (previewEngine !== "three") {
      setPreviewEngine("three");
    }
  }, [previewEngine, setPreviewEngine]);

  const toggleViewOption = useCallback((key: keyof PreviewViewOptions) => {
    setViewOptions((current) => ({
      ...current,
      [key]: !current[key]
    }));
  }, []);

  const handlePreviewTimeInputChange = useCallback((value: string) => {
    const nextTimeMs = parsePreviewDateTimeLocal(value);
    if (nextTimeMs !== null) {
      setPreviewTimeMs(nextTimeMs);
    }
  }, []);

  const handlePreviewTimeOfDayChange = useCallback((value: number | number[]) => {
    if (Array.isArray(value)) {
      return;
    }
    setPreviewTimeMs((current) => setPreviewTimeOfDayMinutes(current, value));
  }, []);

  const resetPreviewTimeToNow = useCallback(() => {
    setPreviewTimeMs(roundPreviewTimeToMinute(Date.now()));
  }, []);

  useEffect(() => {
    writePreviewViewOptions(viewOptions);
  }, [viewOptions]);

  useEffect(() => {
    const syncStageFullscreen = () => {
      commitStageFullscreen(document.fullscreenElement === stageRef.current);
    };
    syncStageFullscreen();
    document.addEventListener("fullscreenchange", syncStageFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncStageFullscreen);
  }, [commitStageFullscreen]);

  const toggleStageFullscreen = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) {
      return;
    }
    if (document.fullscreenElement === stage) {
      const exitFullscreenRequest = document.exitFullscreen?.();
      void exitFullscreenRequest?.catch(() => {
        commitStageFullscreen(document.fullscreenElement === stage);
      });
      return;
    }
    const requestFullscreenRequest = stage.requestFullscreen?.();
    void requestFullscreenRequest?.catch(() => {
      commitStageFullscreen(false);
    });
  }, [commitStageFullscreen]);

  const flushPreviewStateSaveQueue = useCallback(() => {
    if (previewSaveInFlightRef.current) {
      return;
    }
    const nextSave = queuedPreviewSaveRef.current;
    if (!nextSave) {
      return;
    }
    const generation = previewSaveGenerationRef.current;
    queuedPreviewSaveRef.current = null;
    previewSaveInFlightRef.current = true;
    latestPreviewSaveRequestSignatureRef.current = nextSave.signature;
    updateSaveState("saving");
    api.updatePreviewState(nextSave.taskId, nextSave.fileId, nextSave.previewState)
      .then(() => {
        if (
          generation !== previewSaveGenerationRef.current ||
          latestPreviewSaveRequestSignatureRef.current !== nextSave.signature
        ) {
          return;
        }
        lastPersistedPreviewStateSignatureRef.current = nextSave.signature;
        if (queuedPreviewSaveRef.current) {
          updateSaveState("saving");
        } else {
          updateSaveState("saved");
        }
      })
      .catch(() => {
        if (
          generation !== previewSaveGenerationRef.current ||
          queuedPreviewSaveRef.current ||
          latestPreviewSaveRequestSignatureRef.current !== nextSave.signature
        ) {
          return;
        }
        updateSaveState("error");
      })
      .finally(() => {
        if (generation !== previewSaveGenerationRef.current) {
          return;
        }
        previewSaveInFlightRef.current = false;
        if (queuedPreviewSaveRef.current) {
          flushPreviewStateSaveQueue();
        } else if (latestPreviewSaveRequestSignatureRef.current === nextSave.signature) {
          latestPreviewSaveRequestSignatureRef.current = "";
        }
      });
  }, [updateSaveState]);

  useEffect(() => {
    if (!payload.file?.id || !isModelPreviewType(payload.type) || saveRevision === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      const nextSignature = getPreviewStatePersistenceSignature(
        sceneMode,
        transform,
        selectedLayerKey,
        hiddenLayerKeys
      );
      const pendingSaveSignature = latestPreviewSaveRequestSignatureRef.current;
      const queuedSaveSignature = queuedPreviewSaveRef.current?.signature;
      if (
        nextSignature === lastPersistedPreviewStateSignatureRef.current &&
        !previewSaveInFlightRef.current &&
        (!queuedSaveSignature || queuedSaveSignature === nextSignature) &&
        (!pendingSaveSignature || pendingSaveSignature === nextSignature)
      ) {
        latestPreviewSaveRequestSignatureRef.current = "";
        updateSaveState("idle");
        return;
      }
      if (
        nextSignature === pendingSaveSignature ||
        nextSignature === queuedSaveSignature
      ) {
        updateSaveState("saving");
        return;
      }
      const previewState: PreviewState = {
        sceneMode,
        transform: {
          ...transform,
          updatedAt: new Date().toISOString()
        },
        selectedLayerKey,
        hiddenLayerKeys
      };
      latestPreviewSaveRequestSignatureRef.current = nextSignature;
      queuedPreviewSaveRef.current = {
        taskId,
        fileId: payload.file!.id,
        signature: nextSignature,
        previewState
      };
      updateSaveState("saving");
      flushPreviewStateSaveQueue();
    }, 650);

    return () => window.clearTimeout(timer);
  }, [flushPreviewStateSaveQueue, hiddenLayerKeys, payload.file, payload.type, saveRevision, sceneMode, selectedLayerKey, taskId, transform, updateSaveState]);

  useEffect(() => {
    if (saveState !== "saved") {
      return;
    }
    const timer = window.setTimeout(() => updateSaveState("idle"), 1600);
    return () => window.clearTimeout(timer);
  }, [saveState, updateSaveState]);

  const allLayerKeys = useMemo(() => flattenLayerKeys(layerTree), [layerTree]);
  const hiddenLayerKeySet = useMemo(() => new Set(hiddenLayerKeys), [hiddenLayerKeys]);
  const checkedLayerKeys = useMemo(
    () => allLayerKeys.filter((key) => !hiddenLayerKeySet.has(key)),
    [allLayerKeys, hiddenLayerKeySet]
  );
  const checkedLayerKeySet = useMemo(() => new Set(checkedLayerKeys), [checkedLayerKeys]);
  const meshLayerTree = useMemo(() => compactMeshLayerTree(layerTree), [layerTree]);
  const flatMeshLayerList = useMemo(() => collectFlatMeshLayerNodes(layerTree), [layerTree]);
  const allMeshLayerKeys = useMemo(() => flattenLayerKeys(flatMeshLayerList), [flatMeshLayerList]);
  const allMeshLayerKeySet = useMemo(() => new Set(allMeshLayerKeys), [allMeshLayerKeys]);
  const meshSearchQuery = useMemo(() => normalizeLayerSearchQuery(deferredMeshSearchText), [deferredMeshSearchText]);
  const filteredFlatMeshLayerList = useMemo(
    () => meshSearchQuery
      ? flatMeshLayerList.filter((node) => isLayerNodeSearchMatch(node, meshSearchQuery))
      : flatMeshLayerList,
    [flatMeshLayerList, meshSearchQuery]
  );
  const filteredMeshLayerTree = useMemo(
    () => meshSearchQuery ? filterLayerTreeBySearchQuery(meshLayerTree, meshSearchQuery) : meshLayerTree,
    [meshLayerTree, meshSearchQuery]
  );
  const meshSearchMatchCount = useMemo(
    () => meshSearchQuery ? countLayerSearchMatches(meshLayerTree, meshSearchQuery) : 0,
    [meshLayerTree, meshSearchQuery]
  );
  const displayedMeshLayers = meshViewMode === "list" ? filteredFlatMeshLayerList : filteredMeshLayerTree;
  const displayedMeshKeys = useMemo(() => flattenLayerKeys(displayedMeshLayers), [displayedMeshLayers]);
  const displayedMeshKeySet = useMemo(() => new Set(displayedMeshKeys), [displayedMeshKeys]);
  const displayedMeshNodeKeyLookup = useMemo(() => buildLayerNodeKeyLookup(displayedMeshLayers), [displayedMeshLayers]);
  const displayedMeshVisibilityStates = useMemo(
    () => buildLayerVisibilityStateMap(displayedMeshLayers, checkedLayerKeySet),
    [checkedLayerKeySet, displayedMeshLayers]
  );
  const selectedLayerTitle = useMemo(
    () => selectedLayerKey ? findLayerNodeTitle(layerTree, selectedLayerKey) || getLayerKeyFallbackTitle(selectedLayerKey) : "",
    [layerTree, selectedLayerKey]
  );
  const selectedMeshAncestorKeys = useMemo(
    () => selectedLayerKey ? findLayerAncestorKeys(meshLayerTree, selectedLayerKey) : [],
    [meshLayerTree, selectedLayerKey]
  );
  const meshLayersHidden = displayedMeshKeys.length > 0 && displayedMeshKeys.every((key) => hiddenLayerKeySet.has(key));
  const allMeshLayersHidden = allMeshLayerKeys.length > 0 && allMeshLayerKeys.every((key) => hiddenLayerKeySet.has(key));
  const effectiveExpandedLayerKeys = useMemo(() => {
    if (meshViewMode !== "tree") {
      return expandedLayerKeys;
    }
    return Array.from(new Set([
      ...expandedLayerKeys,
      ...selectedMeshAncestorKeys,
      ...(meshSearchQuery ? collectExpandableLayerKeys(displayedMeshLayers, Number.POSITIVE_INFINITY, 500) : [])
    ]));
  }, [displayedMeshLayers, expandedLayerKeys, meshSearchQuery, meshViewMode, selectedMeshAncestorKeys]);
  const showAllMeshLayers = useCallback(() => {
    updateHiddenLayers(hiddenLayerKeys.filter((key) => !allMeshLayerKeySet.has(key)));
  }, [allMeshLayerKeySet, hiddenLayerKeys, updateHiddenLayers]);

  useEffect(() => {
    if (meshSearchRevealSelectionRef.current === selectedLayerKey) {
      return;
    }
    meshSearchRevealSelectionRef.current = selectedLayerKey;
    if (!selectedLayerKey || !meshSearchQuery || displayedMeshKeySet.has(selectedLayerKey)) {
      return;
    }
    setMeshSearchText("");
  }, [displayedMeshKeySet, meshSearchQuery, selectedLayerKey]);

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
  const adaptivePerformanceActive = activePreviewEngine === "three" && isModel && sceneInfo.performanceMode === "adaptive";
  const showScenePerformanceBadge = Boolean(fpsLabel || adaptivePerformanceActive);
  const isSphereScene = sceneMode === "sphere";
  const canUsePlacementMode = canEditScene && isSphereScene;
  const focusViewCommand: ViewCommand = selectedLayerKey ? "focus-selected" : "fit";
  const fitViewTooltip = selectedLayerKey ? "聚焦选中对象（F）" : "适配模型（F）";
  const fitViewAriaLabel = selectedLayerKey ? "聚焦选中对象" : "适配模型";
  const resetViewTooltip = isSphereScene ? "恢复到地球默认（Home）" : "重置视角（Home）";
  const placementTooltip = !isSphereScene
    ? "球面场景支持地表落位"
    : placementMode
      ? "退出地表落位（Esc）"
      : "地表落位：单击地球表面放置";
  const operationHelpTooltip = operationHelpOpen ? "收起操作说明（Esc / H / ?）" : "操作说明（H / ?）";

  useEffect(() => {
    if (!hasUnrealPreview && previewEngine === "unreal") {
      setPreviewEngine("three");
    }
  }, [hasUnrealPreview, previewEngine, setPreviewEngine]);

  useEffect(() => {
    if (canUsePlacementMode) {
      return;
    }
    clearScheduledInteractionHint();
    interactionHintRef.current = null;
    setInteractionHint(null);
    clearPlacementFeedback();
    commitPlacementMode(false);
    if (!canEditScene) {
      commitTransformMode("translate");
      commitOperationHelpOpen(false);
    }
  }, [canEditScene, canUsePlacementMode, clearPlacementFeedback, clearScheduledInteractionHint, commitOperationHelpOpen, commitPlacementMode, commitTransformMode]);
  const workspaceClassName = [
    "preview-workspace",
    leftPanelCollapsed ? "is-left-collapsed" : "",
    rightPanelCollapsed ? "is-right-collapsed" : ""
  ].filter(Boolean).join(" ");
  const workspaceStyle: CSSProperties & {
    "--preview-left-panel-width": string;
    "--preview-right-panel-width": string;
  } = {
    "--preview-left-panel-width": `${leftPanelWidth}px`,
    "--preview-right-panel-width": `${rightPanelWidth}px`
  };
  const showSceneShortcutTools = canEditScene && (rightPanelCollapsed || stageFullscreen);
  const showInspectorShortcutActions = canEditScene && !stageFullscreen;
  const showStandaloneOperationHelpButton = canEditScene && !showSceneShortcutTools;
  const showFloatingSelectedObject = Boolean(canEditScene && selectedLayerKey && showSceneShortcutTools);
  const showHiddenMeshesHint = Boolean(canEditScene && isModel && allMeshLayersHidden);
  const transformModeControlsDisabled = !canEditScene || placementMode;
  const timeControlsDisabled = activePreviewEngine !== "three";
  const previewTimeInputValue = formatPreviewDateTimeLocal(previewTimeMs);
  const previewTimeOfDayMinutes = getPreviewTimeOfDayMinutes(previewTimeMs);
  const previewTimeOfDayLabel = formatPreviewMinuteOfDay(previewTimeOfDayMinutes);
  const sideTabContentPending = activeSideTab !== renderedSideTab;

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
              <span>Three.js 渲染器</span>
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

      <div className={workspaceClassName} style={workspaceStyle}>
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
        <div className="preview-panel preview-side preview-side-tabs">
          <nav className="preview-side-tab-rail" aria-label="预览资源面板">
            {([
              { key: "files" as const, label: "文件列表", icon: <FileOutlined /> },
              { key: "materials" as const, label: "材质列表", icon: <BgColorsOutlined /> },
              { key: "meshes" as const, label: "网格列表", icon: <NodeIndexOutlined /> }
            ]).map((tab) => (
              <Tooltip title={tab.label} placement="right" key={tab.key}>
                <button
                  aria-label={tab.label}
                  aria-pressed={activeSideTab === tab.key}
                  className={`preview-side-tab-button${activeSideTab === tab.key ? " is-active" : ""}`}
                  type="button"
                  onPointerDown={(event) => {
                    if (event.button === 0) {
                      handleSideTabChange(tab.key);
                    }
                  }}
                  onClick={(event) => {
                    if (event.detail === 0) {
                      handleSideTabChange(tab.key);
                    }
                  }}
                >
                  {tab.icon}
                </button>
              </Tooltip>
            ))}
          </nav>
          <section className="preview-side-tab-content" aria-busy={sideTabContentPending}>
            <div className="preview-panel-header">
              <Typography.Title level={5}>
                {activeSideTab === "files" ? "文件列表" : activeSideTab === "materials" ? "材质列表" : "网格列表"}
              </Typography.Title>
              <Tooltip title="收起资源面板">
                <Button
                  aria-label="收起资源面板"
                  icon={<MenuFoldOutlined />}
                  size="small"
                  type="text"
                  onClick={collapseLayerPanel}
                />
              </Tooltip>
            </div>

            {sideTabContentPending ? (
              <div className="preview-side-tab-loading">
                <Spin size="small" />
                <span>正在切换面板…</span>
              </div>
            ) : null}

            {!sideTabContentPending && renderedSideTab === "files" ? (
              <PreviewFileList
                files={payload.files}
                selectedFileId={payload.file?.id || null}
                onSelectFile={onSelectFile}
              />
            ) : null}

            {!sideTabContentPending && renderedSideTab === "materials" ? (
              <MaterialList
                materials={materialList}
                selectedKey={selectedMaterialKey}
                onSelect={handleMaterialSelect}
                onFocus={handleMaterialFocus}
              />
            ) : null}

            {!sideTabContentPending && renderedSideTab === "meshes" ? (
              <div className="preview-mesh-list-panel">
                {layerTree.length ? (
                  <div className="preview-mesh-toolbar" aria-label="网格列表工具栏">
                    <Tooltip title="网格列表">
                      <Button
                        aria-label="网格列表"
                        aria-pressed={meshViewMode === "list"}
                        className={meshViewMode === "list" ? "is-active" : ""}
                        icon={<MenuUnfoldOutlined />}
                        size="small"
                        type="text"
                        onClick={() => handleMeshViewModeChange("list")}
                      />
                    </Tooltip>
                    <Tooltip title="树形层级">
                      <Button
                        aria-label="树形层级"
                        aria-pressed={meshViewMode === "tree"}
                        className={meshViewMode === "tree" ? "is-active" : ""}
                        icon={<NodeIndexOutlined />}
                        size="small"
                        type="text"
                        onClick={() => handleMeshViewModeChange("tree")}
                      />
                    </Tooltip>
                    <span className="preview-mesh-toolbar-divider" aria-hidden="true" />
                    <Tooltip title="展开全部">
                      <Button
                        aria-label="展开全部网格"
                        disabled={meshViewMode !== "tree" || !displayedMeshKeys.length}
                        icon={<DownOutlined />}
                        size="small"
                        type="text"
                        onClick={() => commitExpandedLayerKeys(collectExpandableLayerKeys(displayedMeshLayers, Number.POSITIVE_INFINITY, 500))}
                      />
                    </Tooltip>
                    <Tooltip title="收起全部">
                      <Button
                        aria-label="收起全部网格"
                        disabled={meshViewMode !== "tree" || !effectiveExpandedLayerKeys.length}
                        icon={<UpOutlined />}
                        size="small"
                        type="text"
                        onClick={() => commitExpandedLayerKeys([])}
                      />
                    </Tooltip>
                    <span className="preview-mesh-toolbar-spacer" aria-hidden="true" />
                    <Tooltip title="定位模型">
                      <Button
                        aria-label="定位模型"
                        disabled={!displayedMeshKeys.length}
                        icon={<FullscreenOutlined />}
                        size="small"
                        type="text"
                        onClick={() => issueViewCommand("fit")}
                      />
                    </Tooltip>
                    <Tooltip title={meshLayersHidden ? "全部显示" : "全部隐藏"}>
                      <Button
                        aria-label={meshLayersHidden ? "全部显示网格" : "全部隐藏网格"}
                        disabled={!displayedMeshKeys.length}
                        icon={meshLayersHidden ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                        size="small"
                        type="text"
                        onClick={() => {
                          updateHiddenLayers(meshLayersHidden
                            ? hiddenLayerKeys.filter((key) => !displayedMeshKeySet.has(key))
                            : Array.from(new Set([...hiddenLayerKeys, ...displayedMeshKeys]))
                          );
                        }}
                      />
                    </Tooltip>
                  </div>
                ) : null}
                {layerTree.length ? (
                  <div className="preview-mesh-search-row">
                    <Input
                      allowClear
                      aria-label="搜索网格"
                      className="preview-layer-search"
                      placeholder="搜索网格名称 / ID"
                      prefix={<SearchOutlined />}
                      size="small"
                      value={meshSearchText}
                      onChange={(event) => setMeshSearchText(event.target.value)}
                    />
                    {meshSearchQuery ? (
                      <Typography.Text className="preview-mesh-search-count" type="secondary">
                        {meshSearchMatchCount} / {allMeshLayerKeys.length}
                      </Typography.Text>
                    ) : null}
                  </div>
                ) : null}
                {displayedMeshLayers.length ? (
                    <LayerTreeView
                      nodes={displayedMeshLayers}
                      checkedSet={checkedLayerKeySet}
                      expandedKeys={effectiveExpandedLayerKeys}
                      selectedKey={selectedLayerKey}
                      visibilityStates={displayedMeshVisibilityStates}
                      virtualized={meshViewMode === "list"}
                      onSelect={updateSelectedLayer}
                      onFocusLayer={handleFocusLayer}
                      onToggleExpanded={toggleExpandedLayer}
                      onToggle={(node) => {
                        const nodeKeys = displayedMeshNodeKeyLookup.get(node.key) || [node.key];
                        const checkedSet = new Set(checkedLayerKeySet);
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
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={meshSearchQuery
                      ? `未找到匹配“${meshSearchText.trim()}”的网格`
                      : isModel ? "模型加载后显示网格" : "当前文件无网格列表"}
                  />
                )}
              </div>
            ) : null}
          </section>
          <button
            aria-label="拖拽调整资源面板宽度"
            className="preview-side-resize-handle"
            type="button"
            onPointerDown={handleLeftPanelResizeStart}
          />
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
            placementFeedback={placementFeedback}
            canEditScene={canEditScene}
            viewOptions={viewOptions}
            previewTimeMs={previewTimeMs}
            viewCommand={viewCommand}
            sceneViewState={sceneViewState}
            onLayerTreeChange={updateLayerTree}
            onMaterialListChange={updateMaterialList}
            onSceneInfoChange={handleSceneInfoChange}
            onSceneViewStateChange={handleSceneViewStateChange}
            onSelectLayer={updateSelectedLayer}
            onTransformChange={updateTransform}
            onPlacementDone={handlePlacementDone}
            onPlacementCancel={handlePlacementCancel}
            onPlacementMiss={showPlacementFeedback}
            onViewCommandHandled={handleViewCommandHandled}
            onInteractionHintChange={handleInteractionHintChange}
            onRendererFallback={handleRendererFallback}
            onSwitchToThree={handleSwitchToThree}
            onUnrealStatusChange={handleUnrealStatusChange}
          />
          {canEditScene && interactionHint ? (
            <div className="preview-interaction-hint" role="status" aria-live="polite">
              {previewInteractionHintLabel(interactionHint)}
            </div>
          ) : null}
          {engineSwitching ? (
            <div className="preview-switch-mask">
              <Spin />
              <span>正在切换预览引擎</span>
            </div>
          ) : null}
          {showSceneShortcutTools ? (
            <div className="preview-scene-tools" aria-label="场景快捷工具">
              <Tooltip title={fitViewTooltip}>
                <Button
                  aria-label={fitViewAriaLabel}
                  icon={<AimOutlined />}
                  onClick={() => issueViewCommand(focusViewCommand)}
                />
              </Tooltip>
              {!isSphereScene ? (
                <Tooltip title={resetViewTooltip}>
                  <Button
                    aria-label="重置视角"
                    icon={<HomeOutlined />}
                    onClick={() => issueViewCommand("reset")}
                  />
                </Tooltip>
              ) : null}
              {isSphereScene ? (
                <Tooltip title={resetViewTooltip}>
                  <Button
                    aria-label="恢复到地球默认"
                    icon={<GlobalOutlined />}
                    onClick={() => issueViewCommand("earth-default")}
                  />
                </Tooltip>
              ) : null}
              <Tooltip title={placementTooltip}>
                <Button
                  aria-label="地表落位"
                  aria-pressed={canUsePlacementMode && placementMode}
                  type={canUsePlacementMode && placementMode ? "primary" : "default"}
                  icon={<EnvironmentOutlined />}
                  disabled={!canUsePlacementMode}
                  onClick={togglePlacementMode}
                />
              </Tooltip>
              <Tooltip title={placementMode ? "退出地表落位后可编辑模型变换" : "回正姿态"}>
                <Button
                  aria-label="回正姿态"
                  icon={<ColumnHeightOutlined />}
                  disabled={placementMode}
                  onClick={() => {
                    if (placementMode) {
                      return;
                    }
                    updateTransform(normalizeUprightTransform(transform, sceneMode));
                  }}
                />
              </Tooltip>
              <Tooltip title={placementMode ? "退出地表落位后可编辑模型变换" : "重置变换"}>
                <Button
                  aria-label="重置变换"
                  icon={<UndoOutlined />}
                  disabled={placementMode}
                  onClick={() => {
                    if (placementMode) {
                      return;
                    }
                    updateTransform(normalizeResetTransform(transform, sceneMode));
                  }}
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
              <Tooltip title={operationHelpTooltip}>
                <Button
                  aria-label="操作说明"
                  aria-pressed={operationHelpOpen}
                  icon={<QuestionCircleOutlined />}
                  type={operationHelpOpen ? "primary" : "default"}
                  onClick={toggleOperationHelpOpen}
                />
              </Tooltip>
              <div className="preview-scene-mode-switch" aria-label="模型变换模式">
                {TRANSFORM_MODE_OPTIONS.map((mode) => (
                  <Tooltip title={placementMode ? "退出地表落位后可切换变换模式" : mode.tooltip} key={mode.value}>
                    <Button
                      aria-label={mode.tooltip}
                      aria-pressed={transformMode === mode.value}
                      className={transformMode === mode.value ? "is-active" : undefined}
                      disabled={placementMode}
                      icon={mode.icon}
                      type={transformMode === mode.value ? "primary" : "default"}
                      onClick={() => {
                        if (placementMode) {
                          return;
                        }
                        updateTransformMode(mode.value);
                      }}
                    />
                  </Tooltip>
                ))}
              </div>
            </div>
          ) : null}
          {showHiddenMeshesHint ? (
            <div className="preview-hidden-meshes-hint" role="status" aria-live="polite">
              <strong>模型图层已全部隐藏</strong>
              <span>画布为空不是加载失败，可以一键恢复所有网格。</span>
              <Button
                icon={<EyeOutlined />}
                size="small"
                type="primary"
                onClick={showAllMeshLayers}
              >
                显示全部网格
              </Button>
            </div>
          ) : null}
          {showFloatingSelectedObject ? (
            <div className="preview-selected-object-floating" aria-live="polite">
              <span className="preview-selected-object-floating-label">当前选中</span>
              <span className="preview-selected-object-floating-name" title={selectedLayerTitle}>
                {selectedLayerTitle}
              </span>
              <span className="preview-selected-object-floating-actions">
                <Tooltip title="聚焦选中对象（F）">
                  <Button
                    aria-label={`聚焦选中对象：${selectedLayerTitle}`}
                    icon={<AimOutlined />}
                    size="small"
                    type="text"
                    onClick={() => issueViewCommand("focus-selected")}
                  />
                </Tooltip>
                <Tooltip title="在图层列表中显示">
                  <Button
                    aria-label={`在图层列表中显示：${selectedLayerTitle}`}
                    icon={<NodeIndexOutlined />}
                    size="small"
                    type="text"
                    onClick={revealSelectedLayerInMeshList}
                  />
                </Tooltip>
                <Tooltip title="清除选中（Esc）">
                  <Button
                    aria-label={`清除选中对象：${selectedLayerTitle}`}
                    icon={<CloseOutlined />}
                    size="small"
                    type="text"
                    onClick={clearPreviewSelection}
                  />
                </Tooltip>
              </span>
            </div>
          ) : null}
          {showStandaloneOperationHelpButton ? (
            <Tooltip title={operationHelpTooltip}>
              <Button
                aria-label="操作说明"
                aria-pressed={operationHelpOpen}
                className="preview-operation-help-toggle"
                icon={<QuestionCircleOutlined />}
                type={operationHelpOpen ? "primary" : "default"}
                onClick={toggleOperationHelpOpen}
              />
            </Tooltip>
          ) : null}
          {operationHelpOpen && canEditScene ? (
            <aside className="preview-operation-help" aria-label="三维预览操作说明">
              <div className="preview-operation-help-header">
                <strong>三维操作说明</strong>
                <Button
                  aria-label="关闭操作说明"
                  icon={<CloseOutlined />}
                  size="small"
                  type="text"
                  onClick={() => commitOperationHelpOpen(false)}
                />
              </div>
              <div className="preview-operation-help-section">
                <span>浏览场景</span>
                <dl>
                  {isSphereScene ? (
                    <>
                      <div>
                        <dt>左键拖动</dt>
                        <dd>拖动地球表面平移</dd>
                      </div>
                      <div>
                        <dt>右键拖动</dt>
                        <dd>旋转视角</dd>
                      </div>
                      <div>
                        <dt>Shift + 左键</dt>
                        <dd>旋转视角</dd>
                      </div>
                      <div>
                        <dt>滚轮</dt>
                        <dd>按鼠标位置缩放</dd>
                      </div>
                    </>
                  ) : (
                    <>
                      <div>
                        <dt>左键拖动</dt>
                        <dd>旋转视角</dd>
                      </div>
                      <div>
                        <dt>Shift/Ctrl/⌘ + 左键</dt>
                        <dd>平移视角</dd>
                      </div>
                      <div>
                        <dt>滚轮</dt>
                        <dd>以鼠标位置缩放</dd>
                      </div>
                      <div>
                        <dt>右键上下拖动</dt>
                        <dd>快速缩放</dd>
                      </div>
                      <div>
                        <dt>中键拖动</dt>
                        <dd>俯仰观察</dd>
                      </div>
                      <div>
                        <dt>双击左键</dt>
                        <dd>双击模型时选中并聚焦对象</dd>
                      </div>
                    </>
                  )}
                </dl>
              </div>
              <div className="preview-operation-help-section">
                <span>模型操作</span>
                <dl>
                  <div>
                    <dt>单击模型</dt>
                    <dd>选中网格 / 图层</dd>
                  </div>
                  <div>
                    <dt>双击模型</dt>
                    <dd>选中并聚焦该对象</dd>
                  </div>
                  <div>
                    <dt>双击列表行</dt>
                    <dd>在网格或材质列表中快速聚焦对象</dd>
                  </div>
                  <div>
                    <dt>W / E / R</dt>
                    <dd>切换平移 / 旋转 / 缩放变换模式</dd>
                  </div>
                  <div>
                    <dt>地表落位</dt>
                    <dd>{isSphereScene ? "开启后单击地球表面放置模型；落位期间暂停变换编辑" : "仅球面场景支持地表落位"}</dd>
                  </div>
                </dl>
              </div>
              <div className="preview-operation-help-section">
                <span>快捷恢复</span>
                <dl>
                  <div>
                    <dt>F</dt>
                    <dd>聚焦选中对象；未选中时适配整个模型</dd>
                  </div>
                  <div>
                    <dt>Home</dt>
                    <dd>{sceneMode === "sphere" ? "恢复到地球默认视角" : "恢复默认视角"}</dd>
                  </div>
                  <div>
                    <dt>H / ?</dt>
                    <dd>打开或收起这份操作说明</dd>
                  </div>
                  <div>
                    <dt>Esc</dt>
                    <dd>关闭说明、退出落位、清除选中或停止视角惯性</dd>
                  </div>
                </dl>
              </div>
            </aside>
          ) : null}
          {showScenePerformanceBadge ? (
            <div className="preview-scene-fps" role="status" aria-live="polite">
              {fpsLabel ? <span>FPS：{fpsLabel}</span> : null}
              {adaptivePerformanceActive ? <span className="preview-scene-fps-badge">性能保护中</span> : null}
            </div>
          ) : null}
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
          {canEditScene && saveState !== "idle" ? (
            <div
              className={`preview-stage-save-status is-${saveState}`}
              role="status"
              aria-live="polite"
            >
              {saveLabel(saveState)}
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
          <button
            aria-label="拖拽调整场景控制宽度"
            className="preview-inspector-resize-handle"
            type="button"
            onPointerDown={handleRightPanelResizeStart}
          />
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
            {selectedLayerKey ? (
              <div className="preview-selected-object-card" aria-live="polite">
                <span className="preview-selected-object-label">当前选中</span>
                <span className="preview-selected-object-name" title={selectedLayerTitle}>
                  {selectedLayerTitle}
                </span>
                <span className="preview-selected-object-actions">
                  <Tooltip title="聚焦选中对象（F）">
                    <Button
                      aria-label={`聚焦选中对象：${selectedLayerTitle}`}
                      icon={<AimOutlined />}
                      size="small"
                      type="text"
                      onClick={() => issueViewCommand("focus-selected")}
                    />
                  </Tooltip>
                  <Tooltip title="在图层列表中显示">
                    <Button
                      aria-label={`在图层列表中显示：${selectedLayerTitle}`}
                      icon={<NodeIndexOutlined />}
                      size="small"
                      type="text"
                      onClick={revealSelectedLayerInMeshList}
                    />
                  </Tooltip>
                  <Tooltip title="清除选中（Esc）">
                    <Button
                      aria-label={`清除选中对象：${selectedLayerTitle}`}
                      icon={<CloseOutlined />}
                      size="small"
                      type="text"
                      onClick={clearPreviewSelection}
                    />
                  </Tooltip>
                </span>
              </div>
            ) : null}
            <Space wrap className="preview-tool-row">
              {showInspectorShortcutActions ? (
                <>
                  <Tooltip title={fitViewTooltip}>
                    <Button
                      aria-label={fitViewAriaLabel}
                      icon={<AimOutlined />}
                      disabled={!canEditScene}
                      onClick={() => issueViewCommand(focusViewCommand)}
                    />
                  </Tooltip>
                  {!isSphereScene ? (
                    <Tooltip title={resetViewTooltip}>
                      <Button
                        aria-label="重置视角"
                        icon={<HomeOutlined />}
                        disabled={!canEditScene}
                        onClick={() => issueViewCommand("reset")}
                      />
                    </Tooltip>
                  ) : null}
                  {isSphereScene ? (
                    <Tooltip title={resetViewTooltip}>
                      <Button
                        aria-label="恢复到地球默认"
                        icon={<GlobalOutlined />}
                        disabled={!canEditScene}
                        onClick={() => issueViewCommand("earth-default")}
                      />
                    </Tooltip>
                  ) : null}
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
                  <Tooltip title={placementTooltip}>
                    <Button
                      aria-label="地表落位"
                      aria-pressed={canUsePlacementMode && placementMode}
                      type={canUsePlacementMode && placementMode ? "primary" : "default"}
                      icon={<EnvironmentOutlined />}
                      disabled={!canUsePlacementMode}
                      onClick={togglePlacementMode}
                    />
                  </Tooltip>
                  <Tooltip title={placementMode ? "退出地表落位后可编辑模型变换" : "回正姿态"}>
                    <Button
                      aria-label="回正姿态"
                      icon={<ColumnHeightOutlined />}
                      disabled={transformModeControlsDisabled}
                      onClick={() => {
                        if (transformModeControlsDisabled) {
                          return;
                        }
                        updateTransform(normalizeUprightTransform(transform, sceneMode));
                      }}
                    />
                  </Tooltip>
                  <Tooltip title={placementMode ? "退出地表落位后可编辑模型变换" : "重置变换"}>
                    <Button
                      aria-label="重置变换"
                      icon={<UndoOutlined />}
                      disabled={transformModeControlsDisabled}
                      onClick={() => {
                        if (transformModeControlsDisabled) {
                          return;
                        }
                        updateTransform(normalizeResetTransform(transform, sceneMode));
                      }}
                    />
                  </Tooltip>
                </>
              ) : null}
            </Space>
            <div className="preview-time-panel">
              <div className="preview-time-panel-header">
                <span>
                  <SunOutlined />
                  时间与光照
                </span>
                <Tooltip title="使用当前时间">
                  <Button
                    aria-label="使用当前时间"
                    icon={<ClockCircleOutlined />}
                    size="small"
                    type="text"
                    disabled={timeControlsDisabled}
                    onClick={resetPreviewTimeToNow}
                  />
                </Tooltip>
              </div>
              <Input
                aria-label="预览时间"
                type="datetime-local"
                value={previewTimeInputValue}
                disabled={timeControlsDisabled}
                onChange={(event) => handlePreviewTimeInputChange(event.target.value)}
              />
              <div className="preview-time-slider-row">
                <span>{previewTimeOfDayLabel}</span>
                <Slider
                  aria-label="一天内时间"
                  min={0}
                  max={PREVIEW_DAY_MINUTES - 1}
                  step={PREVIEW_TIME_SLIDER_STEP_MINUTES}
                  value={previewTimeOfDayMinutes}
                  disabled={timeControlsDisabled}
                  tooltip={{ formatter: (value) => formatPreviewMinuteOfDay(Number(value ?? 0)) }}
                  onChange={handlePreviewTimeOfDayChange}
                />
              </div>
            </div>
            <Radio.Group
              aria-label="模型变换模式"
              block
              optionType="button"
              buttonStyle="solid"
              value={transformMode}
              disabled={transformModeControlsDisabled}
              options={TRANSFORM_MODE_OPTIONS.map(({ label, value }) => ({ label, value }))}
              onChange={(event) => {
                if (transformModeControlsDisabled) {
                  return;
                }
                updateTransformMode(event.target.value);
              }}
            />
            {placementMode ? (
              <div className="preview-control-mode-hint" role="status">
                地表落位中：单击地球表面放置，或按 Esc 退出；变换编辑已暂停。
              </div>
            ) : null}
          </Space>

          <Divider />

          <TransformInspector
            transform={transform}
            sceneMode={sceneMode}
            transformMode={transformMode}
            disabled={transformModeControlsDisabled}
            onChange={updateTransform}
          />
        </div>
        )}
      </div>
    </div>
  );
}

type PreviewStageProps = {
  payload: PreviewPayload;
  activeEngine: PreviewEngine;
  threeRenderer: ThreeRendererPreference;
  sceneMode: PreviewSceneMode;
  transform: PreviewTransform;
  transformMode: TransformMode;
  selectedLayerKey: string | null;
  hiddenLayerKeys: string[];
  placementMode: boolean;
  placementFeedback: string;
  canEditScene: boolean;
  viewOptions: PreviewViewOptions;
  previewTimeMs: number;
  viewCommand: ViewCommandRequest | null;
  sceneViewState: SceneViewState;
  onLayerTreeChange: (tree: LayerNode[]) => void;
  onMaterialListChange: (materials: MaterialNode[]) => void;
  onSceneInfoChange: (info: SceneInfo) => void;
  onSceneViewStateChange: (state: SceneViewState) => void;
  onSelectLayer: (key: string | null) => void;
  onTransformChange: (transform: PreviewTransform) => void;
  onPlacementDone: () => void;
  onPlacementCancel: () => void;
  onPlacementMiss: (message: string) => void;
  onViewCommandHandled: (result?: ViewCommandHandledResult) => void;
  onInteractionHintChange: (hint: PreviewInteractionHint | null) => void;
  onRendererFallback: (message: string) => void;
  onSwitchToThree: () => void;
  onUnrealStatusChange: (status: UnrealConnectionStatus, message?: string) => void;
};

function arePreviewPropsShallowEqual<T extends object>(previous: T, next: T): boolean {
  const previousKeys = Object.keys(previous) as Array<keyof T>;
  const nextKeys = Object.keys(next) as Array<keyof T>;
  return previousKeys.length === nextKeys.length &&
    previousKeys.every((key) => (
      Object.prototype.hasOwnProperty.call(next, key) &&
      Object.is(previous[key], next[key])
    ));
}

function arePreviewStagePropsEqual(previous: PreviewStageProps, next: PreviewStageProps): boolean {
  const { sceneViewState: previousSceneViewState, ...previousRest } = previous;
  const { sceneViewState: nextSceneViewState, ...nextRest } = next;
  if (!arePreviewPropsShallowEqual(previousRest, nextRest)) {
    return false;
  }
  return next.activeEngine !== "unreal" || previousSceneViewState === nextSceneViewState;
}

const PreviewStage = memo(function PreviewStage({
  payload,
  activeEngine,
  threeRenderer,
  sceneMode,
  transform,
  transformMode,
  selectedLayerKey,
  hiddenLayerKeys,
  placementMode,
  placementFeedback,
  canEditScene,
  viewOptions,
  previewTimeMs,
  viewCommand,
  sceneViewState,
  onLayerTreeChange,
  onMaterialListChange,
  onSceneInfoChange,
  onSceneViewStateChange,
  onSelectLayer,
  onTransformChange,
  onPlacementDone,
  onPlacementCancel,
  onPlacementMiss,
  onViewCommandHandled,
  onInteractionHintChange,
  onRendererFallback,
  onSwitchToThree,
  onUnrealStatusChange
}: PreviewStageProps) {
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
        previewTimeMs={previewTimeMs}
        viewCommand={viewCommand}
        sceneViewState={sceneViewState}
        onLayerTreeChange={onLayerTreeChange}
        onMaterialListChange={onMaterialListChange}
        onSceneInfoChange={onSceneInfoChange}
        onSceneViewStateChange={onSceneViewStateChange}
        onSelectLayer={onSelectLayer}
        onTransformChange={onTransformChange}
        onPlacementDone={onPlacementDone}
        onPlacementMiss={onPlacementMiss}
        onViewCommandHandled={onViewCommandHandled}
        onInteractionHintChange={onInteractionHintChange}
        onRendererFallback={onRendererFallback}
      />
      {placementMode ? (
        <div
          className="preview-placement-hint"
          role="status"
          aria-label="地表落位模式：单击地球表面完成落位，Esc 退出"
        >
          <AimOutlined className="preview-placement-hint-icon" />
          <span className="preview-placement-hint-copy">
            <strong>落位中</strong>
            <span>单击地球表面放置 · Esc 退出</span>
            {placementFeedback ? (
              <span className="preview-placement-feedback">{placementFeedback}</span>
            ) : null}
          </span>
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
      ) : placementFeedback ? (
        <div
          className="preview-placement-hint"
          role="status"
          aria-label="地表落位完成"
        >
          <AimOutlined className="preview-placement-hint-icon" />
          <span className="preview-placement-hint-copy">
            <strong>落位完成</strong>
            <span>{placementFeedback}</span>
          </span>
        </div>
      ) : null}
    </div>
  );
}, arePreviewStagePropsEqual);

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

function MaterialList({
  materials,
  selectedKey,
  onSelect,
  onFocus
}: {
  materials: MaterialNode[];
  selectedKey: string | null;
  onSelect: (material: MaterialNode) => void;
  onFocus: (material: MaterialNode) => void;
}) {
  if (!materials.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="模型加载后显示材质" />;
  }

  if (materials.length > PREVIEW_MATERIAL_VIRTUAL_THRESHOLD) {
    return (
      <VirtualizedMaterialList
        materials={materials}
        selectedKey={selectedKey}
        onSelect={onSelect}
        onFocus={onFocus}
      />
    );
  }

  return (
    <div className="preview-material-list" role="list" aria-label="材质列表">
      {materials.map((material) => (
        <Tooltip title={materialListTooltip(material)} key={material.key}>
          <button
            aria-current={selectedKey === material.key}
            className={`preview-material-row${selectedKey === material.key ? " is-active" : ""}`}
            type="button"
            onClick={() => onSelect(material)}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onFocus(material);
            }}
          >
            <span
              className="preview-material-swatch"
              style={{ background: material.color || "#d7dee8" }}
              aria-hidden="true"
            />
            <span className="preview-material-row-main">
              <span>{material.title}</span>
              <small>{materialListMeta(material)}</small>
            </span>
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

function MaterialListRow({
  material,
  selectedKey,
  onSelect,
  onFocus
}: {
  material: MaterialNode;
  selectedKey: string | null;
  onSelect: (material: MaterialNode) => void;
  onFocus: (material: MaterialNode) => void;
}) {
  return (
    <Tooltip title={materialListTooltip(material)} key={material.key}>
      <button
        aria-current={selectedKey === material.key}
        className={`preview-material-row${selectedKey === material.key ? " is-active" : ""}`}
        type="button"
        onClick={() => onSelect(material)}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onFocus(material);
        }}
      >
        <span
          className="preview-material-swatch"
          style={{ background: material.color || "#d7dee8" }}
          aria-hidden="true"
        />
        <span className="preview-material-row-main">
          <span>{material.title}</span>
          <small>{materialListMeta(material)}</small>
        </span>
      </button>
    </Tooltip>
  );
}

function materialListTooltip(material: MaterialNode): string {
  return `${material.title} · ${materialListMeta(material)}`;
}

function materialListMeta(material: MaterialNode): string {
  return `${material.objectCount} 个对象 · ${material.layerKey ? "双击聚焦" : "仅材质选择"}`;
}

function useVirtualListMetrics(itemCount: number, rowHeight: number) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef(0);
  const [metrics, setMetrics] = useState({ scrollTop: 0, viewportHeight: 0 });

  const updateMetrics = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const nextMetrics = {
      scrollTop: container.scrollTop,
      viewportHeight: container.clientHeight
    };
    setMetrics((current) => (
      current.scrollTop === nextMetrics.scrollTop &&
      current.viewportHeight === nextMetrics.viewportHeight
        ? current
        : nextMetrics
    ));
  }, []);

  const scheduleMetricsUpdate = useCallback(() => {
    if (frameRef.current) {
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0;
      updateMetrics();
    });
  }, [updateMetrics]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    updateMetrics();
    const observer = new ResizeObserver(scheduleMetricsUpdate);
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (frameRef.current) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
    };
  }, [scheduleMetricsUpdate, updateMetrics]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const maxScrollTop = Math.max(itemCount * rowHeight - container.clientHeight, 0);
    if (container.scrollTop > maxScrollTop) {
      container.scrollTop = maxScrollTop;
      updateMetrics();
      return;
    }
    scheduleMetricsUpdate();
  }, [itemCount, rowHeight, scheduleMetricsUpdate, updateMetrics]);

  return {
    containerRef,
    scrollTop: metrics.scrollTop,
    viewportHeight: metrics.viewportHeight,
    onScroll: scheduleMetricsUpdate
  };
}

function VirtualizedMaterialList({
  materials,
  selectedKey,
  onSelect,
  onFocus
}: {
  materials: MaterialNode[];
  selectedKey: string | null;
  onSelect: (material: MaterialNode) => void;
  onFocus: (material: MaterialNode) => void;
}) {
  const {
    containerRef,
    scrollTop,
    viewportHeight,
    onScroll
  } = useVirtualListMetrics(materials.length, PREVIEW_MATERIAL_ROW_HEIGHT);

  const totalHeight = materials.length * PREVIEW_MATERIAL_ROW_HEIGHT;
  const startIndex = Math.max(
    Math.floor(scrollTop / PREVIEW_MATERIAL_ROW_HEIGHT) - PREVIEW_MATERIAL_VIRTUAL_OVERSCAN,
    0
  );
  const endIndex = Math.min(
    Math.ceil((scrollTop + viewportHeight) / PREVIEW_MATERIAL_ROW_HEIGHT) + PREVIEW_MATERIAL_VIRTUAL_OVERSCAN,
    materials.length
  );
  const visibleMaterials = materials.slice(startIndex, endIndex);

  return (
    <div
      ref={containerRef}
      className="preview-material-list preview-material-list-virtual"
      role="list"
      aria-label="材质列表"
      onScroll={onScroll}
    >
      <div className="preview-material-list-virtual-spacer" style={{ height: totalHeight }}>
        <div
          className="preview-material-list-virtual-window"
          style={{ transform: `translateY(${startIndex * PREVIEW_MATERIAL_ROW_HEIGHT}px)` }}
        >
          {visibleMaterials.map((material) => (
            <MaterialListRow
              key={material.key}
              material={material}
              selectedKey={selectedKey}
              onSelect={onSelect}
              onFocus={onFocus}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function LayerTreeView({
  nodes,
  checkedSet,
  expandedKeys,
  selectedKey,
  visibilityStates,
  virtualized = false,
  onSelect,
  onFocusLayer,
  onToggleExpanded,
  onToggle
}: {
  nodes: LayerNode[];
  checkedSet: Set<string>;
  expandedKeys: string[];
  selectedKey: string | null;
  visibilityStates: Map<string, LayerVisibilityState>;
  virtualized?: boolean;
  onSelect: (key: string | null) => void;
  onFocusLayer: (key: string | null) => void;
  onToggleExpanded: (key: string) => void;
  onToggle: (node: LayerNode) => void;
}) {
  const expandedSet = useMemo(() => new Set(expandedKeys), [expandedKeys]);
  const treeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (virtualized || !selectedKey) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      const tree = treeRef.current;
      const selectedRow = tree?.querySelector<HTMLElement>('[data-layer-selected="true"]');
      if (!tree || !selectedRow) {
        return;
      }
      const treeRect = tree.getBoundingClientRect();
      const rowRect = selectedRow.getBoundingClientRect();
      const rowTop = rowRect.top - treeRect.top + tree.scrollTop;
      const rowBottom = rowTop + rowRect.height;
      const viewTop = tree.scrollTop;
      const viewBottom = viewTop + tree.clientHeight;
      if (rowTop < viewTop) {
        tree.scrollTop = Math.max(rowTop - PREVIEW_LAYER_ROW_HEIGHT, 0);
        return;
      }
      if (rowBottom > viewBottom) {
        tree.scrollTop = Math.max(rowBottom - tree.clientHeight + PREVIEW_LAYER_ROW_HEIGHT, 0);
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [expandedKeys, nodes, selectedKey, virtualized]);

  if (virtualized && nodes.length > PREVIEW_LAYER_VIRTUAL_THRESHOLD) {
    return (
      <VirtualizedLayerTree
        nodes={nodes}
        checkedSet={checkedSet}
        expandedSet={expandedSet}
        selectedKey={selectedKey}
        visibilityStates={visibilityStates}
        onSelect={onSelect}
        onFocusLayer={onFocusLayer}
        onToggleExpanded={onToggleExpanded}
        onToggle={onToggle}
      />
    );
  }
  return (
    <div ref={treeRef} className="preview-layer-tree" role="tree" aria-label="模型图层">
      {nodes.map((node) => (
        <LayerTreeItem
          key={node.key}
          node={node}
          depth={0}
          checkedSet={checkedSet}
          expandedSet={expandedSet}
          selectedKey={selectedKey}
          visibilityStates={visibilityStates}
          onSelect={onSelect}
          onFocusLayer={onFocusLayer}
          onToggleExpanded={onToggleExpanded}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

function VirtualizedLayerTree({
  nodes,
  checkedSet,
  expandedSet,
  selectedKey,
  visibilityStates,
  onSelect,
  onFocusLayer,
  onToggleExpanded,
  onToggle
}: {
  nodes: LayerNode[];
  checkedSet: Set<string>;
  expandedSet: Set<string>;
  selectedKey: string | null;
  visibilityStates: Map<string, LayerVisibilityState>;
  onSelect: (key: string | null) => void;
  onFocusLayer: (key: string | null) => void;
  onToggleExpanded: (key: string) => void;
  onToggle: (node: LayerNode) => void;
}) {
  const {
    containerRef,
    scrollTop,
    viewportHeight,
    onScroll
  } = useVirtualListMetrics(nodes.length, PREVIEW_LAYER_ROW_HEIGHT);

  const totalHeight = nodes.length * PREVIEW_LAYER_ROW_HEIGHT;
  const startIndex = Math.max(
    Math.floor(scrollTop / PREVIEW_LAYER_ROW_HEIGHT) - PREVIEW_LAYER_VIRTUAL_OVERSCAN,
    0
  );
  const endIndex = Math.min(
    Math.ceil((scrollTop + viewportHeight) / PREVIEW_LAYER_ROW_HEIGHT) + PREVIEW_LAYER_VIRTUAL_OVERSCAN,
    nodes.length
  );
  const visibleNodes = nodes.slice(startIndex, endIndex);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !selectedKey) {
      return;
    }
    const selectedIndex = nodes.findIndex((node) => node.key === selectedKey);
    if (selectedIndex < 0) {
      return;
    }
    const rowTop = selectedIndex * PREVIEW_LAYER_ROW_HEIGHT;
    const rowBottom = rowTop + PREVIEW_LAYER_ROW_HEIGHT;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;
    if (rowTop >= viewTop && rowBottom <= viewBottom) {
      return;
    }
    const centeredTop = rowTop - Math.max((container.clientHeight - PREVIEW_LAYER_ROW_HEIGHT) / 2, 0);
    container.scrollTop = Math.max(0, Math.min(centeredTop, totalHeight));
  }, [containerRef, nodes, selectedKey, totalHeight]);

  return (
    <div
      ref={containerRef}
      className="preview-layer-tree preview-layer-tree-virtual"
      role="tree"
      aria-label="模型图层"
      onScroll={onScroll}
    >
      <div className="preview-layer-tree-virtual-spacer" style={{ height: totalHeight }}>
        <div
          className="preview-layer-tree-virtual-window"
          style={{ transform: `translateY(${startIndex * PREVIEW_LAYER_ROW_HEIGHT}px)` }}
        >
          {visibleNodes.map((node) => (
            <LayerTreeItem
              key={node.key}
              node={node}
              depth={0}
              checkedSet={checkedSet}
              expandedSet={expandedSet}
              selectedKey={selectedKey}
              visibilityStates={visibilityStates}
              onSelect={onSelect}
              onFocusLayer={onFocusLayer}
              onToggleExpanded={onToggleExpanded}
              onToggle={onToggle}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function LayerTreeItem({
  node,
  depth,
  checkedSet,
  expandedSet,
  selectedKey,
  visibilityStates,
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
  visibilityStates: Map<string, LayerVisibilityState>;
  onSelect: (key: string | null) => void;
  onFocusLayer: (key: string | null) => void;
  onToggleExpanded: (key: string) => void;
  onToggle: (node: LayerNode) => void;
}) {
  const visibilityState = visibilityStates.get(node.key) || (checkedSet.has(node.key) ? "visible" : "hidden");
  const checked = visibilityState !== "hidden";
  const fullyVisible = visibilityState === "visible";
  const hasChildren = Boolean(node.children?.length);
  const expanded = !hasChildren || expandedSet.has(node.key);
  const selected = selectedKey === node.key;
  const selectLayerLabel = selected ? `当前选中：${node.title}，双击聚焦` : `选择 ${node.title}`;
  const focusLayerLabel = selected ? `定位当前选中图层：${node.title}` : `定位 ${node.title}`;
  const layerNameTooltip = `${selected ? "当前选中 · " : ""}${node.title} · 双击聚焦`;
  return (
    <div className="preview-layer-branch">
      <div
        className={`preview-layer-row${selected ? " is-active" : ""}${visibilityState === "hidden" ? " is-hidden" : ""}${visibilityState === "partial" ? " is-partial" : ""}`}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={selected}
        aria-expanded={hasChildren ? expanded : undefined}
        data-layer-selected={selected ? "true" : undefined}
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
        <Tooltip title={layerNameTooltip}>
          <button
            aria-label={selectLayerLabel}
            className="preview-layer-name-button"
            disabled={!checked}
            title={layerNameTooltip}
            type="button"
            onClick={() => onSelect(node.key)}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onFocusLayer(node.key);
            }}
          >
            <NodeIndexOutlined />
            <span>{node.title}</span>
          </button>
        </Tooltip>
        <Tooltip title={selected ? "定位当前选中图层" : "定位图层"}>
          <button
            aria-label={focusLayerLabel}
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
          visibilityStates={visibilityStates}
          onSelect={onSelect}
          onFocusLayer={onFocusLayer}
          onToggleExpanded={onToggleExpanded}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

type ThreeSceneProps = {
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
  previewTimeMs: number;
  viewCommand: ViewCommandRequest | null;
  sceneViewState: SceneViewState;
  onLayerTreeChange: (tree: LayerNode[]) => void;
  onMaterialListChange: (materials: MaterialNode[]) => void;
  onSceneInfoChange: (info: SceneInfo) => void;
  onSceneViewStateChange: (state: SceneViewState) => void;
  onSelectLayer: (key: string | null) => void;
  onTransformChange: (transform: PreviewTransform) => void;
  onPlacementDone: () => void;
  onPlacementMiss: (message: string) => void;
  onViewCommandHandled: (result?: ViewCommandHandledResult) => void;
  onInteractionHintChange: (hint: PreviewInteractionHint | null) => void;
  onRendererFallback: (message: string) => void;
};

function areThreeScenePropsEqual(previous: ThreeSceneProps, next: ThreeSceneProps): boolean {
  const { sceneViewState: _previousSceneViewState, ...previousRest } = previous;
  const { sceneViewState: _nextSceneViewState, ...nextRest } = next;
  return arePreviewPropsShallowEqual(previousRest, nextRest);
}

const ThreeScene = memo(function ThreeScene({
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
  previewTimeMs,
  viewCommand,
  sceneViewState,
  onLayerTreeChange,
  onMaterialListChange,
  onSceneInfoChange,
  onSceneViewStateChange,
  onSelectLayer,
  onTransformChange,
  onPlacementDone,
  onPlacementMiss,
  onViewCommandHandled,
  onInteractionHintChange,
  onRendererFallback
}: ThreeSceneProps) {
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
  const pickableObjectsRef = useRef<THREE.Object3D[]>([]);
  const layerVisibilityRevisionRef = useRef(0);
  const ellipsoidContextRef = useRef<EllipsoidContext>(createDefaultEllipsoidContext());
  const applyingTransformRef = useRef(false);
  const latestTransformRef = useRef(transform);
  const latestSceneModeRef = useRef(sceneMode);
  const latestPlacementModeRef = useRef(placementMode);
  const latestTransformModeRef = useRef(transformMode);
  const latestSelectedLayerKeyRef = useRef(selectedLayerKey);
  const latestSceneViewStateRef = useRef(sceneViewState);
  const latestViewOptionsRef = useRef(viewOptions);
  const latestPreviewTimeMsRef = useRef(previewTimeMs);
  const latestHiddenLayerKeysRef = useRef(hiddenLayerKeys);
  const hiddenLayerKeysSignatureRef = useRef<string | null>(null);
  const notifySceneRefreshRef = useRef<(options?: { syncCamera?: boolean }) => void>(() => undefined);

  const applyHiddenLayerVisibility = useCallback((keys: string[], options: { force?: boolean } = {}) => {
    latestHiddenLayerKeysRef.current = keys;
    const nextSignature = normalizePreviewKeyList(keys).join("\u0000");
    if (!options.force && hiddenLayerKeysSignatureRef.current === nextSignature) {
      return false;
    }
    hiddenLayerKeysSignatureRef.current = nextSignature;
    const hidden = new Set(keys);
    let visibilityChanged = false;
    objectsByLayerKeyRef.current.forEach((object, key) => {
      const nextVisible = !hidden.has(key);
      if (object.visible === nextVisible) {
        return;
      }
      object.visible = nextVisible;
      visibilityChanged = true;
    });
    if (visibilityChanged) {
      layerVisibilityRevisionRef.current += 1;
    }
    return visibilityChanged;
  }, []);

  useEffect(() => {
    latestTransformRef.current = transform;
  }, [transform]);

  useEffect(() => {
    latestSceneModeRef.current = sceneMode;
    const camera = cameraRef.current;
    if (!camera) return;
    setInitialCamera(camera, sceneMode, ellipsoidContextRef.current);
    globeControlsRef.current?.update(0);
    notifySceneRefreshRef.current({ syncCamera: true });
  }, [sceneMode]);

  useEffect(() => {
    latestPlacementModeRef.current = placementMode;
    const controls = transformControlsRef.current;
    if (controls) {
      controls.getHelper().visible = shouldShowTransformControlHelper(
        latestSelectedLayerKeyRef.current,
        objectsByLayerKeyRef.current,
        placementMode
      );
    }
    notifySceneRefreshRef.current();
  }, [placementMode]);

  useEffect(() => {
    latestSelectedLayerKeyRef.current = selectedLayerKey;
    const controls = transformControlsRef.current;
    if (controls) {
      controls.getHelper().visible = shouldShowTransformControlHelper(
        selectedLayerKey,
        objectsByLayerKeyRef.current,
        latestPlacementModeRef.current
      );
    }
    notifySceneRefreshRef.current();
  }, [selectedLayerKey]);

  useEffect(() => {
    latestSceneViewStateRef.current = sceneViewState;
  }, [sceneViewState]);

  useEffect(() => {
    latestViewOptionsRef.current = viewOptions;
    notifySceneRefreshRef.current();
  }, [viewOptions]);

  useEffect(() => {
    latestPreviewTimeMsRef.current = previewTimeMs;
    notifySceneRefreshRef.current();
  }, [previewTimeMs]);

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
    if (transformControlsRef.current) {
      transformControlsRef.current.getHelper().visible = shouldShowTransformControlHelper(
        latestSelectedLayerKeyRef.current,
        objectsByLayerKeyRef.current,
        latestPlacementModeRef.current
      );
    }
    applyingTransformRef.current = false;
    notifySceneRefreshRef.current();
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
    if (controls) {
      controls.getHelper().visible = shouldShowTransformControlHelper(
        latestSelectedLayerKeyRef.current,
        objectsByLayerKeyRef.current,
        latestPlacementModeRef.current
      );
    }
    notifySceneRefreshRef.current();
  }, [transformMode]);

  useEffect(() => {
    const visibilityChanged = applyHiddenLayerVisibility(hiddenLayerKeys);
    if (!visibilityChanged) {
      return;
    }
    const controls = transformControlsRef.current;
    if (controls) {
      controls.getHelper().visible = shouldShowTransformControlHelper(
        latestSelectedLayerKeyRef.current,
        objectsByLayerKeyRef.current,
        latestPlacementModeRef.current
      );
    }
    notifySceneRefreshRef.current();
  }, [applyHiddenLayerVisibility, hiddenLayerKeys]);

  useEffect(() => {
    if (!viewCommand) return;
    const viewCommandType = viewCommand.type;
    const camera = cameraRef.current;
    const modelRoot = modelRootRef.current;
    const globeControls = globeControlsRef.current as RuntimeGlobeControls | null;
    let handledCameraCommand = false;
    if (viewCommandType === "cancel-interaction") {
      const cancelledInteraction = globeControls?._cancelInteractionMomentum?.({ clearHint: false }) ?? false;
      if (!cancelledInteraction) {
        onInteractionHintChange(null);
      }
      if (cancelledInteraction) {
        notifySceneRefreshRef.current();
      }
      onViewCommandHandled({ cancelledInteraction });
      return;
    }
    if (camera) {
      globeControls?._cancelInteractionMomentum?.({ clearHint: false });
      if (viewCommandType === "fit" && modelRoot) {
        focusObject(
          modelRoot,
          camera,
          latestSceneModeRef.current,
          globeControls,
          ellipsoidContextRef.current
        );
        handledCameraCommand = true;
      }
      if (viewCommandType === "focus-selected") {
        const target = selectedLayerKey ? objectsByLayerKeyRef.current.get(selectedLayerKey) : modelRoot;
        if (target) {
          focusObject(
            target,
            camera,
            latestSceneModeRef.current,
            globeControls,
            ellipsoidContextRef.current
          );
          handledCameraCommand = true;
        }
      }
      if (viewCommandType === "reset" || viewCommandType === "earth-default") {
        setInitialCamera(camera, latestSceneModeRef.current, ellipsoidContextRef.current);
        globeControls?.update(0);
        handledCameraCommand = true;
      }
    }
    if (handledCameraCommand) {
      notifySceneRefreshRef.current({ syncCamera: true });
    }
    onViewCommandHandled();
  }, [onInteractionHintChange, onViewCommandHandled, selectedLayerKey, viewCommand]);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let frameId = 0;
    let frameTimerId = 0;
    let animateLoop: (() => void) | null = null;
    let resizeFrameId = 0;
    let starField: THREE.Points | null = null;
    let fallbackEarth: THREE.Group | null = null;
    let selectionBox: THREE.Box3Helper | null = null;
    let selectionBoxSignature = "";
    let selectionBoxBoundsSignature = "";
    let lastSelectionBoxTime = 0;
    let renderer: PreviewRenderer | null = null;
    const loadedObjects: LoadedPreviewObject[] = [];
    const tileEventCleanups: Array<() => void> = [];
    let hasCriticalSceneError = false;
    let layerSignature = "";
    let statsSignature = "";
    let cachedStats: { meshes: number; vertices: number } = { meshes: 0, vertices: 0 };
    let framedLoadedTiles = false;
    let statusMessage = "";
    let lastFpsTime = performance.now();
    let lastRenderTime = 0;
    let lastSummaryTime = 0;
    let lastTilesUpdateTime = 0;
    let sceneVisualDirtyUntil = 0;
    let tilesVisualDirtyUntil = 0;
    let pendingDeferredSummary = false;
    let tilesContentRevision = 0;
    let summarizedTilesContentRevision = -1;
    let lastViewStateSyncTime = 0;
    let pendingDeferredViewStateSync = false;
    let deferredViewStateSyncReadyAt = 0;
    let sceneViewStateSignature = "";
    let visibleLayerIdsCacheSource: Map<string, THREE.Object3D> | null = null;
    let visibleLayerIdsCacheVisibilityRevision = -1;
    let visibleLayerIdsCache: string[] = [];
    let fpsFrameCount = 0;
    let currentFps: number | undefined;
    let fpsLabelVisible = false;
    let lastFpsInfoEmitTime = 0;
    let lastFpsInfoValue: number | undefined;
    let lastFpsInfoPerformanceMode: PreviewPerformanceMode = "normal";
    let renderFailed = false;
    let globeInteractionQualityUntil = 0;
    let lowFpsRecoveryUntil = 0;
    let lastPreviewInteractionMarkTime = 0;
    let previewDocumentHidden = document.visibilityState === "hidden";
    let activeRendererPixelRatio = getPreviewPixelRatio();
    let pendingTransformChange: PreviewTransform | null = null;
    let pendingTransformChangeTimer = 0;
    let lastTransformChangeEmitTime = 0;
    let previewLightingSignature = "";
    const plainBackground = new THREE.Color(0x071422);
    let atmosphereRenderer: PreviewAtmosphereRenderer | null = null;
    const cancelScheduledPreviewResize = () => {
      if (!resizeFrameId) {
        return;
      }
      window.cancelAnimationFrame(resizeFrameId);
      resizeFrameId = 0;
    };
    const cancelScheduledPreviewAnimation = () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
        frameId = 0;
      }
      if (frameTimerId) {
        window.clearTimeout(frameTimerId);
        frameTimerId = 0;
      }
    };
    const schedulePreviewAnimation = (delayMs = 0) => {
      if (disposed || !animateLoop) {
        return;
      }
      if (delayMs <= 0) {
        if (frameTimerId) {
          window.clearTimeout(frameTimerId);
          frameTimerId = 0;
        }
        if (!frameId) {
          frameId = window.requestAnimationFrame(animateLoop);
        }
        return;
      }
      if (frameId || frameTimerId) {
        return;
      }
      frameTimerId = window.setTimeout(() => {
        frameTimerId = 0;
        if (!disposed && animateLoop && !frameId) {
          frameId = window.requestAnimationFrame(animateLoop);
        }
      }, delayMs);
    };
    const markPreviewInteraction = () => {
      const now = performance.now();
      const wasInteractionActive = now < globeInteractionQualityUntil;
      if (wasInteractionActive && now - lastPreviewInteractionMarkTime < PREVIEW_INTERACTION_MARK_INTERVAL_MS) {
        return;
      }
      lastPreviewInteractionMarkTime = now;
      globeInteractionQualityUntil = now + GLOBE_INTERACTION_QUALITY_RECOVERY_MS;
      if (!wasInteractionActive) {
        fpsFrameCount = 0;
        lastFpsTime = now;
        currentFps = undefined;
      }
      pendingDeferredViewStateSync = true;
      deferredViewStateSyncReadyAt = globeInteractionQualityUntil + PREVIEW_DEFERRED_VIEW_STATE_SYNC_DELAY_MS;
      schedulePreviewAnimation();
    };
    const flushPendingTransformChange = () => {
      if (pendingTransformChangeTimer) {
        window.clearTimeout(pendingTransformChangeTimer);
        pendingTransformChangeTimer = 0;
      }
      if (!pendingTransformChange || disposed) {
        return;
      }
      const nextTransform = pendingTransformChange;
      pendingTransformChange = null;
      lastTransformChangeEmitTime = performance.now();
      onTransformChange(nextTransform);
    };
    const scheduleTransformChange = (nextTransform: PreviewTransform, force = false) => {
      if (isSamePreviewTransform(latestSceneModeRef.current, latestTransformRef.current, nextTransform)) {
        if (force && pendingTransformChange) {
          flushPendingTransformChange();
        }
        return;
      }
      latestTransformRef.current = nextTransform;
      pendingTransformChange = nextTransform;
      if (force) {
        flushPendingTransformChange();
        return;
      }
      const now = performance.now();
      const remaining = PREVIEW_TRANSFORM_CHANGE_THROTTLE_MS - (now - lastTransformChangeEmitTime);
      if (remaining <= 0) {
        flushPendingTransformChange();
        return;
      }
      if (!pendingTransformChangeTimer) {
        pendingTransformChangeTimer = window.setTimeout(flushPendingTransformChange, remaining);
      }
    };

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
    fallbackEarth = createFallbackEarth();
    ellipsoidAnchor.add(fallbackEarth);
    if (latestSceneModeRef.current === "sphere" && (type === "3dtiles" || contextTilesUrl)) {
      fallbackEarth.visible = false;
    }
    const allowAtmosphereRenderer = hasCesiumIonGlobeContext(contextTilesUrl, url);

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
      vertices: 0,
      performanceMode: "normal"
    });

    const run = async () => {
      const rendererResult = await createWebGPUPreviewRenderer(container, rendererPreference, (backend) => {
        onSceneInfoChange({
          backend,
          status: "loading",
          message: "正在加载模型",
          meshes: 0,
          vertices: 0,
          fps: currentFps,
          performanceMode: "normal"
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
      const detachGlobeControlsBehavior = configurePreviewGlobeControls(globeControls, {
        overlayScene: scene,
        onInteraction: markPreviewInteraction,
        onInteractionHintChange
      });
      const rendererElement = renderer.domElement;
      const pointer = new THREE.Vector2();
      const raycaster = new THREE.Raycaster();
      let pickableObjectsRevision = 0;
      let modelHitCache: {
        x: number;
        y: number;
        at: number;
        modelRoot: THREE.Object3D;
        pickableObjectsRevision: number;
        layerVisibilityRevision: number;
        cameraX: number;
        cameraY: number;
        cameraZ: number;
        cameraQx: number;
        cameraQy: number;
        cameraQz: number;
        cameraQw: number;
        hit: THREE.Intersection<THREE.Object3D> | null;
      } | null = null;
      const setRaycasterFromClientPoint = (clientX: number, clientY: number) => {
        const rect = rendererElement.getBoundingClientRect();
        pointer.x = ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
        pointer.y = -((clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
      };
      const setRaycasterFromEvent = (event: MouseEvent | PointerEvent) => {
        setRaycasterFromClientPoint(event.clientX, event.clientY);
      };
      const getModelHitFromClientPoint = (clientX: number, clientY: number) => {
        const modelRoot = modelRootRef.current;
        if (!modelRoot) {
          return null;
        }
        const now = performance.now();
        if (
          modelHitCache &&
          modelHitCache.modelRoot === modelRoot &&
          modelHitCache.pickableObjectsRevision === pickableObjectsRevision &&
          modelHitCache.layerVisibilityRevision === layerVisibilityRevisionRef.current &&
          modelHitCache.cameraX === camera.position.x &&
          modelHitCache.cameraY === camera.position.y &&
          modelHitCache.cameraZ === camera.position.z &&
          modelHitCache.cameraQx === camera.quaternion.x &&
          modelHitCache.cameraQy === camera.quaternion.y &&
          modelHitCache.cameraQz === camera.quaternion.z &&
          modelHitCache.cameraQw === camera.quaternion.w &&
          now - modelHitCache.at <= PREVIEW_MODEL_HIT_CACHE_MS &&
          Math.hypot(clientX - modelHitCache.x, clientY - modelHitCache.y) <= 4
        ) {
          return modelHitCache.hit && isPickableObject(modelHitCache.hit.object)
            ? modelHitCache.hit
            : null;
        }
        setRaycasterFromClientPoint(clientX, clientY);
        const pickableObjects = pickableObjectsRef.current;
        const intersections = pickableObjects.length
          ? raycaster.intersectObjects(pickableObjects, false)
          : raycaster.intersectObject(modelRoot, true);
        const hit = intersections.find((item) => isPickableObject(item.object)) || null;
        modelHitCache = {
          x: clientX,
          y: clientY,
          at: now,
          modelRoot,
          pickableObjectsRevision,
          layerVisibilityRevision: layerVisibilityRevisionRef.current,
          cameraX: camera.position.x,
          cameraY: camera.position.y,
          cameraZ: camera.position.z,
          cameraQx: camera.quaternion.x,
          cameraQy: camera.quaternion.y,
          cameraQz: camera.quaternion.z,
          cameraQw: camera.quaternion.w,
          hit
        };
        return hit;
      };
      const getModelHitFromEvent = (event: MouseEvent | PointerEvent) => getModelHitFromClientPoint(
        event.clientX,
        event.clientY
      );

      const updateNavigationMode = (dragging = false) => {
        globeControls.enabled = !dragging;
      };
      updateNavigationMode();

      const getCurrentPreviewLightingState = () => getPreviewTimeLightingState(
        latestPreviewTimeMsRef.current,
        latestTransformRef.current,
        ellipsoidContextRef.current,
        Boolean(modelRootRef.current)
      );
      const initialLightingState = getCurrentPreviewLightingState();
      const hemisphereLight = new THREE.HemisphereLight(0xdcefff, 0x162032, initialLightingState.hemisphereIntensity);
      scene.add(hemisphereLight);
      let fallbackDirectionalLight: THREE.DirectionalLight | null = new THREE.DirectionalLight(0xffffff, 4.2);
      updatePreviewFallbackSunLight(fallbackDirectionalLight, initialLightingState, ellipsoidContextRef.current);
      scene.add(fallbackDirectionalLight);
      const syncPreviewTimeLighting = (activeRenderer: PreviewRenderer): boolean => {
        const lightingState = getCurrentPreviewLightingState();
        if (lightingState.signature === previewLightingSignature) {
          return false;
        }
        previewLightingSignature = lightingState.signature;
        activeRenderer.toneMappingExposure = lightingState.rendererExposure;
        hemisphereLight.intensity = atmosphereRenderer
          ? lightingState.atmosphereHemisphereIntensity
          : lightingState.hemisphereIntensity;
        if (fallbackDirectionalLight) {
          updatePreviewFallbackSunLight(fallbackDirectionalLight, lightingState, ellipsoidContextRef.current);
        }
        updatePreviewStarFieldOpacity(starField, lightingState.starOpacity);
        plainBackground.copy(lightingState.backgroundColor);
        return true;
      };
      const ensureAtmosphereRenderer = () => {
        if (!allowAtmosphereRenderer || atmosphereRenderer || !renderer) {
          return;
        }
        try {
          const lightingState = getCurrentPreviewLightingState();
          atmosphereRenderer = createPreviewAtmosphereRenderer({
            renderer,
            scene,
            camera,
            ellipsoidFrame: ellipsoidAnchor,
            getGeospatialEllipsoid: () => ellipsoidContextRef.current.geospatialEllipsoid,
            getShadowTiles: () => tilesRef.current,
            getTimeMs: () => getCurrentPreviewLightingState().solarTimeMs,
            getToneMappingExposure: () => getCurrentPreviewLightingState().atmosphereExposure
          });
          if (atmosphereRenderer) {
            hemisphereLight.intensity = lightingState.atmosphereHemisphereIntensity;
            if (fallbackDirectionalLight) {
              scene.remove(fallbackDirectionalLight);
              fallbackDirectionalLight = null;
            }
            previewLightingSignature = "";
            syncPreviewTimeLighting(renderer);
          }
        } catch (error) {
          console.warn("Takram atmosphere preview renderer failed to initialize.", error);
          atmosphereRenderer = null;
        }
      };

      starField = createStarField();
      starField.visible = true;
      scene.add(starField);
      scene.background = null;
      previewLightingSignature = "";
      syncPreviewTimeLighting(renderer);

      let lastLoadProgressPercent = -1;
      let lastLoadProgressEmitTime = 0;
      const handleLoadProgress = (percent: number) => {
        if (!renderer) return;
        const nextPercent = THREE.MathUtils.clamp(Math.round(percent), 0, 100);
        const now = performance.now();
        if (nextPercent === lastLoadProgressPercent) {
          return;
        }
        const progressChangedEnough = lastLoadProgressPercent < 0 ||
          Math.abs(nextPercent - lastLoadProgressPercent) >= PREVIEW_LOAD_PROGRESS_STEP ||
          nextPercent === 100;
        const intervalElapsed = now - lastLoadProgressEmitTime >= PREVIEW_LOAD_PROGRESS_INTERVAL_MS;
        if (!progressChangedEnough && !intervalElapsed) {
          return;
        }
        lastLoadProgressPercent = nextPercent;
        lastLoadProgressEmitTime = now;
        onSceneInfoChange({
          backend: getRendererBackend(renderer),
          status: "loading",
          message: `正在加载模型 ${nextPercent}%`,
          meshes: 0,
          vertices: 0,
          fps: currentFps,
          performanceMode: "normal"
        });
      };
      const markSceneVisualDirty = () => {
        if (disposed) {
          return;
        }
        sceneVisualDirtyUntil = performance.now() + PREVIEW_SCENE_VISUAL_DIRTY_MS;
        schedulePreviewAnimation();
      };
      const markTilesVisualDirty = () => {
        if (disposed) {
          return;
        }
        tilesVisualDirtyUntil = performance.now() + PREVIEW_TILES_VISUAL_DIRTY_MS;
        schedulePreviewAnimation();
      };
      notifySceneRefreshRef.current = (options) => {
        markSceneVisualDirty();
        markTilesVisualDirty();
        if (options?.syncCamera) {
          lastViewStateSyncTime = performance.now();
          lastTilesUpdateTime = 0;
          pendingDeferredViewStateSync = false;
          deferredViewStateSyncReadyAt = 0;
          syncSceneViewState();
        }
      };
      const handlePreviewVisibilityChange = () => {
        previewDocumentHidden = document.visibilityState === "hidden";
        if (previewDocumentHidden) {
          return;
        }
        const now = performance.now();
        fpsFrameCount = 0;
        currentFps = undefined;
        lowFpsRecoveryUntil = 0;
        lastFpsTime = now;
        lastRenderTime = 0;
        lastTilesUpdateTime = 0;
        pendingDeferredViewStateSync = true;
        deferredViewStateSyncReadyAt = now + PREVIEW_DEFERRED_VIEW_STATE_SYNC_DELAY_MS;
        markSceneVisualDirty();
        markTilesVisualDirty();
      };
      document.addEventListener("visibilitychange", handlePreviewVisibilityChange);
      const markTilesContentChanged = () => {
        if (disposed) {
          return;
        }
        markTilesVisualDirty();
        tilesContentRevision += 1;
        pendingDeferredSummary = true;
      };
      const addTilesEventListener = (
        tiles: TilesRenderer,
        type: string,
        listener: (event: any) => void
      ) => {
        tiles.addEventListener(type, listener);
        tileEventCleanups.push(() => tiles.removeEventListener(type, listener));
      };
      const trackTilesContentChanges = (tiles: TilesRenderer) => {
        addTilesEventListener(tiles, "needs-render", markTilesVisualDirty);
        addTilesEventListener(tiles, "needs-update", markTilesVisualDirty);
        addTilesEventListener(tiles, "tiles-load-start", markTilesVisualDirty);
        addTilesEventListener(tiles, "tiles-load-end", markTilesVisualDirty);
        addTilesEventListener(tiles, "load-model", markTilesContentChanged);
        addTilesEventListener(tiles, "dispose-model", markTilesContentChanged);
        addTilesEventListener(tiles, "tile-visibility-change", markTilesVisualDirty);
        addTilesEventListener(tiles, "load-error", markTilesVisualDirty);
      };

      const focusLoadedModelWhenReady = (modelRoot: THREE.Object3D) => {
        if (disposed || framedLoadedTiles) {
          return false;
        }
        const focused = focusObject(
          modelRoot,
          camera,
          latestSceneModeRef.current,
          globeControls,
          ellipsoidContextRef.current,
          { allowInitialFallback: false }
        );
        if (!focused) {
          return false;
        }
        framedLoadedTiles = true;
        lastTilesUpdateTime = 0;
        markSceneVisualDirty();
        markTilesVisualDirty();
        return true;
      };

      const watchPhotorealisticGlobe = (loaded: LoadedPreviewObject) => {
        if (!loaded.tiles || !loaded.isPhotorealisticGlobe) return;
        let hasContent = false;
        addTilesEventListener(loaded.tiles, "load-model", () => {
          hasContent = true;
          if (fallbackEarth) {
            fallbackEarth.visible = false;
          }
          ensureAtmosphereRenderer();
        });
        addTilesEventListener(loaded.tiles, "load-error", (event) => {
          if (hasContent || !renderer) return;
          markTilesVisualDirty();
          if (fallbackEarth) {
            fallbackEarth.visible = true;
          }
          const message = getTilesLoadErrorMessage(event);
          statusMessage = `Cesium ion 真实地球加载失败，已使用默认地球${message ? `：${message}` : ""}`;
          onSceneInfoChange({
            backend: getRendererBackend(renderer),
            status: modelRootRef.current ? "ready" : "loading",
            message: modelRootRef.current ? "" : "正在加载场景",
            meshes: cachedStats.meshes,
            vertices: cachedStats.vertices,
            performanceMode: "normal"
          });
        });
      };

      const transformControls = new TransformControls(camera, renderer.domElement);
      transformControls.setMode(transformMode);
      transformControls.setSpace("local");
      transformControls.setSize(0.85);
      transformControls.addEventListener("dragging-changed", (event) => {
        const dragging = Boolean(event.value);
        markPreviewInteraction();
        updateNavigationMode(dragging);
        if (!dragging) {
          flushPendingTransformChange();
        }
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
          try {
            applyTransformToObject(modelRoot, nextTransform, type, latestSceneModeRef.current, ellipsoidContextRef.current);
          } finally {
            applyingTransformRef.current = false;
          }
        }
        scheduleTransformChange(nextTransform, !transformControls.dragging);
      });
      transformControlsRef.current = transformControls;
      const transformControlsHelper = transformControls.getHelper();
      removeTransformControlHelperLines(transformControlsHelper);
      transformControlsHelper.visible = shouldShowTransformControlHelper(
        latestSelectedLayerKeyRef.current,
        objectsByLayerKeyRef.current,
        latestPlacementModeRef.current
      );
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
              trackTilesContentChanges(contextTiles.tiles);
              ellipsoidContextRef.current = setEllipsoidContextFromTiles(contextTiles.tiles, globeControls, ellipsoidAnchor);
              if (contextTiles.isPhotorealisticGlobe) {
                watchPhotorealisticGlobe(contextTiles);
              }
            }
          } catch (error) {
            contextWarning = error instanceof Error
              ? `Cesium ion 真实地球加载失败，已使用默认地球：${error.message}`
              : "Cesium ion 真实地球加载失败，已使用默认地球";
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
          trackTilesContentChanges(loaded.tiles);
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
          const focusMainTiles = () => {
            focusLoadedModelWhenReady(modelRoot);
          };
          addTilesEventListener(loaded.tiles, "load-tileset", focusMainTiles);
          addTilesEventListener(loaded.tiles, "load-model", focusMainTiles);
          addTilesEventListener(loaded.tiles, "tile-visibility-change", focusMainTiles);
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
          transformControls.getHelper().visible = shouldShowTransformControlHelper(
            latestSelectedLayerKeyRef.current,
            objectsByLayerKeyRef.current,
            latestPlacementModeRef.current
          );
          const shouldAutoFocusLoadedModel = Boolean(loaded.tiles || contextTilesUrl);
          if (shouldAutoFocusLoadedModel) {
            focusLoadedModelWhenReady(modelRoot);
          } else if (!restoreCameraView(camera, latestSceneViewStateRef.current, ellipsoidContextRef.current)) {
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
        markSceneVisualDirty();
        markTilesVisualDirty();

      } catch (error) {
        onSceneInfoChange({
          backend: renderer ? getRendererBackend(renderer) : "Detecting",
          status: "error",
          message: error instanceof Error ? error.message : "模型加载失败",
          meshes: 0,
          vertices: 0,
          performanceMode: "normal"
        });
      }

      let canvasPointerIntent: CanvasPointerIntent | null = null;
      let pendingCanvasPickFrame = 0;
      let pendingCanvasPickRequest: CanvasPickRequest | null = null;
      let pendingCanvasHoverFrame = 0;
      let pendingCanvasHoverRequest: CanvasHoverRequest | null = null;
      let lastCanvasHoverPickTime = 0;
      let lastCanvasHoverPickX = Number.NaN;
      let lastCanvasHoverPickY = Number.NaN;
      let canvasHoverCursorActive = false;

      const clearCanvasHoverCursor = () => {
        if (!pendingCanvasHoverRequest && !pendingCanvasHoverFrame && !canvasHoverCursorActive) {
          return;
        }
        pendingCanvasHoverRequest = null;
        if (pendingCanvasHoverFrame) {
          window.cancelAnimationFrame(pendingCanvasHoverFrame);
          pendingCanvasHoverFrame = 0;
        }
        if (canvasHoverCursorActive && renderer?.domElement.style.cursor === "pointer") {
          renderer.domElement.style.cursor = "";
        }
        canvasHoverCursorActive = false;
      };

      const setCanvasHoverCursor = (active: boolean) => {
        if (!renderer) return;
        if (active) {
          if (canvasHoverCursorActive && renderer.domElement.style.cursor === "pointer") {
            return;
          }
          if (renderer.domElement.style.cursor !== "pointer") {
            renderer.domElement.style.cursor = "pointer";
          }
          canvasHoverCursorActive = true;
          return;
        }
        clearCanvasHoverCursor();
      };

      const cancelPendingCanvasPick = () => {
        if (pendingCanvasPickFrame) {
          window.cancelAnimationFrame(pendingCanvasPickFrame);
          pendingCanvasPickFrame = 0;
        }
        pendingCanvasPickRequest = null;
      };

      const scheduleCanvasPick = (clientX: number, clientY: number) => {
        const modelRoot = modelRootRef.current;
        if (!modelRoot) {
          return;
        }
        cancelPendingCanvasPick();
        pendingCanvasPickRequest = {
          clientX,
          clientY,
          modelRoot
        };
        pendingCanvasPickFrame = window.requestAnimationFrame(() => {
          pendingCanvasPickFrame = 0;
          const request = pendingCanvasPickRequest;
          pendingCanvasPickRequest = null;
          if (
            !request ||
            disposed ||
            !renderer ||
            transformControls.dragging ||
            latestPlacementModeRef.current ||
            modelRootRef.current !== request.modelRoot
          ) {
            return;
          }
          const hit = getModelHitFromClientPoint(request.clientX, request.clientY);
          if (hit) {
            const key = findLayerKeyForObject(hit.object);
            onSelectLayer(key);
          } else {
            onSelectLayer(null);
          }
        });
      };

      const shouldThrottleCanvasHoverPick = (clientX: number, clientY: number, now: number) => {
        const movedEnough = !Number.isFinite(lastCanvasHoverPickX) ||
          Math.hypot(clientX - lastCanvasHoverPickX, clientY - lastCanvasHoverPickY) >= PREVIEW_HOVER_PICK_MOVE_THRESHOLD_PX;
        return !movedEnough && now - lastCanvasHoverPickTime < PREVIEW_HOVER_PICK_INTERVAL_MS;
      };

      const scheduleCanvasHoverPick = (event: PointerEvent) => {
        if (
          !renderer ||
          !modelRootRef.current ||
          event.buttons ||
          transformControls.dragging ||
          latestPlacementModeRef.current ||
          isNativeGlobeRotateModifier(event) ||
          performance.now() < lowFpsRecoveryUntil
        ) {
          clearCanvasHoverCursor();
          return;
        }
        const now = performance.now();
        if (shouldThrottleCanvasHoverPick(event.clientX, event.clientY, now) && !pendingCanvasHoverFrame) {
          return;
        }
        pendingCanvasHoverRequest = {
          clientX: event.clientX,
          clientY: event.clientY,
          shiftKey: event.shiftKey
        };
        if (pendingCanvasHoverFrame) {
          return;
        }
        pendingCanvasHoverFrame = window.requestAnimationFrame(() => {
          pendingCanvasHoverFrame = 0;
          const request = pendingCanvasHoverRequest;
          pendingCanvasHoverRequest = null;
          if (
            !request ||
            disposed ||
            !renderer ||
            !modelRootRef.current ||
            transformControls.dragging ||
            latestPlacementModeRef.current ||
            isNativeGlobeRotateModifier(request) ||
            performance.now() < lowFpsRecoveryUntil
          ) {
            clearCanvasHoverCursor();
            return;
          }
          const now = performance.now();
          if (shouldThrottleCanvasHoverPick(request.clientX, request.clientY, now)) {
            return;
          }
          lastCanvasHoverPickTime = now;
          lastCanvasHoverPickX = request.clientX;
          lastCanvasHoverPickY = request.clientY;
          if (isTransformControlPointerHit(request, transformControlsRef.current, camera, rendererElement)) {
            clearCanvasHoverCursor();
            return;
          }
          setCanvasHoverCursor(Boolean(getModelHitFromClientPoint(request.clientX, request.clientY)));
        });
      };

      const handlePointerDown = (event: PointerEvent) => {
        cancelPendingCanvasPick();
        clearCanvasHoverCursor();
        canvasPointerIntent = null;
        if (
          !renderer ||
          !modelRootRef.current ||
          transformControls.dragging ||
          event.button !== 0 ||
          isNativeGlobeRotateModifier(event) ||
          isTransformControlPointerHit(event, transformControlsRef.current, camera, rendererElement)
        ) {
          return;
        }
        canvasPointerIntent = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY
        };
      };

      const handlePointerCancel = (event: PointerEvent) => {
        cancelPendingCanvasPick();
        clearCanvasHoverCursor();
        if (canvasPointerIntent?.id === event.pointerId) {
          canvasPointerIntent = null;
        }
      };

      const handlePointerUp = (event: PointerEvent) => {
        if (
          !renderer ||
          !modelRootRef.current ||
          transformControls.dragging ||
          event.button !== 0 ||
          isNativeGlobeRotateModifier(event) ||
          isTransformControlPointerHit(event, transformControlsRef.current, camera, rendererElement)
        ) {
          cancelPendingCanvasPick();
          canvasPointerIntent = null;
          return;
        }
        if (!canvasPointerIntent || canvasPointerIntent.id !== event.pointerId || hasPointerMoved(canvasPointerIntent, event)) {
          cancelPendingCanvasPick();
          canvasPointerIntent = null;
          return;
        }
        canvasPointerIntent = null;

        if (latestPlacementModeRef.current) {
          setRaycasterFromEvent(event);
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
          } else {
            onPlacementMiss("未命中地球表面，请点击可见地表区域");
          }
          return;
        }

        scheduleCanvasPick(event.clientX, event.clientY);
      };
      const handleCanvasDoubleClick = (event: MouseEvent) => {
        if (
          !renderer ||
          transformControls.dragging ||
          latestPlacementModeRef.current ||
          event.button !== 0 ||
          isNativeGlobeRotateModifier(event) ||
          isTransformControlPointerHit(event, transformControlsRef.current, camera, rendererElement)
        ) {
          return;
        }
        cancelPendingCanvasPick();
        const hit = getModelHitFromEvent(event);
        if (!hit) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        markPreviewInteraction();
        const key = findLayerKeyForObject(hit.object);
        onSelectLayer(key);
        const focusTarget = key ? objectsByLayerKeyRef.current.get(key) || hit.object : hit.object;
        focusObject(
          focusTarget,
          camera,
          latestSceneModeRef.current,
          globeControls,
          ellipsoidContextRef.current
        );
      };
      const handlePreviewPointerMove = (event: PointerEvent) => {
        if (event.buttons) {
          cancelPendingCanvasPick();
          clearCanvasHoverCursor();
          markPreviewInteraction();
          return;
        }
        scheduleCanvasHoverPick(event);
      };
      const handlePreviewPointerLeave = (event: PointerEvent) => {
        clearCanvasHoverCursor();
        if (event.buttons) {
          cancelPendingCanvasPick();
          canvasPointerIntent = null;
        }
      };
      const handlePreviewWheel = (event: WheelEvent) => {
        if (!hasNonZeroWheelDelta(event)) {
          return;
        }
        cancelPendingCanvasPick();
        clearCanvasHoverCursor();
        markPreviewInteraction();
      };
      renderer.domElement.addEventListener("pointerdown", handlePointerDown);
      renderer.domElement.addEventListener("pointermove", handlePreviewPointerMove, { passive: true });
      renderer.domElement.addEventListener("pointerleave", handlePreviewPointerLeave);
      renderer.domElement.addEventListener("pointerup", handlePointerUp);
      renderer.domElement.addEventListener("pointercancel", handlePointerCancel);
      renderer.domElement.addEventListener("dblclick", handleCanvasDoubleClick);
      renderer.domElement.addEventListener("wheel", handlePreviewWheel, { passive: true });

      const runPreviewResize = () => {
        if (!renderer || disposed) return;
        const activeRenderer = renderer;
        resizeRenderer(container, activeRenderer, camera);
        tilesRef.current.forEach((tiles) => setTilesPreviewResolution(tiles, camera, activeRenderer, container, "normal", true));
        markTilesVisualDirty();
      };
      const schedulePreviewResize = () => {
        if (resizeFrameId) {
          return;
        }
        resizeFrameId = window.requestAnimationFrame(() => {
          resizeFrameId = 0;
          runPreviewResize();
        });
      };
      resizeObserver = new ResizeObserver(schedulePreviewResize);
      resizeObserver.observe(container);
      runPreviewResize();

      function refreshSceneSummary(force = false) {
        const modelRoot = modelRootRef.current;
        if (!modelRoot || !renderer) return;

        const isDynamicTilesScene = type === "3dtiles";
        const nextLayerSignature = collectLayerSignature(
          modelRoot,
          isDynamicTilesScene ? PREVIEW_DYNAMIC_LAYER_SIGNATURE_LIMIT : 800
        );
        if (force || nextLayerSignature !== layerSignature) {
          layerSignature = nextLayerSignature;
          const layerResult = buildLayerTree(modelRoot, {
            rootTitle: isDynamicTilesScene ? layerRootTitle || "tileset.json" : undefined,
            shallow: isDynamicTilesScene
          });
          objectsByLayerKeyRef.current = layerResult.objectsByKey;
          pickableObjectsRef.current = collectPickableObjects(
            modelRoot,
            isDynamicTilesScene ? layerResult.tree[0]?.key || null : null,
            {
              maxObjects: isDynamicTilesScene ? PREVIEW_DYNAMIC_PICKABLE_SCAN_LIMIT : Number.POSITIVE_INFINITY,
              maxPickableObjects: isDynamicTilesScene ? PREVIEW_DYNAMIC_PICKABLE_OBJECT_LIMIT : Number.POSITIVE_INFINITY
            }
          );
          pickableObjectsRevision += 1;
          modelHitCache = null;
          applyHiddenLayerVisibility(latestHiddenLayerKeysRef.current, { force: true });
          onLayerTreeChange(layerResult.tree);
          onMaterialListChange(collectMaterialList(
            modelRoot,
            isDynamicTilesScene ? PREVIEW_DYNAMIC_MATERIAL_SCAN_LIMIT : Number.POSITIVE_INFINITY
          ));
          transformControls.getHelper().visible = shouldShowTransformControlHelper(
            latestSelectedLayerKeyRef.current,
            objectsByLayerKeyRef.current,
            latestPlacementModeRef.current
          );
        }

        const stats = collectSceneStats(
          modelRoot,
          isDynamicTilesScene ? PREVIEW_DYNAMIC_STATS_SCAN_LIMIT : Number.POSITIVE_INFINITY
        );
        cachedStats = stats;
        const nextStatsSignature = `${stats.meshes}:${stats.vertices}`;
        if (force || nextStatsSignature !== statsSignature) {
          statsSignature = nextStatsSignature;
          if (tilesRef.current.length && !framedLoadedTiles && stats.meshes > 0) {
            framedLoadedTiles = focusObject(
              modelRoot,
              camera,
              latestSceneModeRef.current,
              globeControls,
              ellipsoidContextRef.current,
              { allowInitialFallback: false }
            ) || framedLoadedTiles;
          }
          onSceneInfoChange({
            backend: getRendererBackend(renderer),
            status: hasCriticalSceneError ? "error" : "ready",
            message: hasCriticalSceneError ? statusMessage : "",
            meshes: stats.meshes,
            vertices: stats.vertices,
            fps: currentFps,
            performanceMode: "normal"
          });
        }
        summarizedTilesContentRevision = tilesContentRevision;
        pendingDeferredSummary = false;
      }

      function syncSceneViewState() {
        const objectsByLayerKey = objectsByLayerKeyRef.current;
        const visibilityRevision = layerVisibilityRevisionRef.current;
        if (
          visibleLayerIdsCacheSource !== objectsByLayerKey ||
          visibleLayerIdsCacheVisibilityRevision !== visibilityRevision
        ) {
          visibleLayerIdsCacheSource = objectsByLayerKey;
          visibleLayerIdsCacheVisibilityRevision = visibilityRevision;
          visibleLayerIdsCache = [];
          objectsByLayerKey.forEach((object, key) => {
            if (object.visible) {
              visibleLayerIdsCache.push(key);
            }
          });
        }
        const nextState: SceneViewState = {
          camera: readCameraView(camera, globeControls),
          selectedObjectId: latestSelectedLayerKeyRef.current || undefined,
          visibleLayerIds: visibleLayerIdsCache
        };
        const nextSignature = getSceneViewStateSignature(nextState);
        if (nextSignature === sceneViewStateSignature) {
          return;
        }
        sceneViewStateSignature = nextSignature;
        latestSceneViewStateRef.current = nextState;
        onSceneViewStateChange(nextState);
      }

      function clearSelectionBox() {
        if (!selectionBox) return;
        scene.remove(selectionBox);
        selectionBox.geometry.dispose();
        if (Array.isArray(selectionBox.material)) {
          selectionBox.material.forEach(disposeMaterial);
        } else {
          disposeMaterial(selectionBox.material);
        }
        selectionBox = null;
        selectionBoxBoundsSignature = "";
      }

      function updateSelectionBox(selected: THREE.Object3D | null, signature: string, force = false) {
        if (!signature || !selected || !isObjectVisibleInHierarchy(selected)) {
          if (selectionBox || selectionBoxSignature) {
            clearSelectionBox();
            selectionBoxSignature = "";
            return true;
          }
          return false;
        }

        const selectedBox = getVisibleObjectBox(selected);
        if (!selectedBox) {
          if (selectionBox) {
            clearSelectionBox();
            selectionBoxSignature = signature;
            return true;
          }
          selectionBoxSignature = signature;
          return false;
        }

        const nextBoundsSignature = getBox3Signature(selectedBox);
        if (
          !force &&
          selectionBox &&
          selectionBoxSignature === signature &&
          selectionBoxBoundsSignature === nextBoundsSignature
        ) {
          return false;
        }

        if (!selectionBox || selectionBoxSignature !== signature) {
          clearSelectionBox();
          selectionBox = new THREE.Box3Helper(selectedBox.clone(), 0x5fd3ff);
          scene.add(selectionBox);
        } else {
          selectionBox.box.copy(selectedBox);
          selectionBox.updateMatrixWorld(true);
        }
        selectionBoxSignature = signature;
        selectionBoxBoundsSignature = nextBoundsSignature;
        return true;
      }

      const animate = () => {
        frameId = 0;
        if (!renderer || disposed) return;
        const activeRenderer = renderer;
        const now = performance.now();
        if (previewDocumentHidden) {
          if (fpsLabelVisible && renderer) {
            fpsLabelVisible = false;
            lastFpsInfoEmitTime = now;
            lastFpsInfoValue = undefined;
            lastFpsInfoPerformanceMode = "normal";
            onSceneInfoChange({
              backend: getRendererBackend(renderer),
              status: hasCriticalSceneError ? "error" : modelRootRef.current ? "ready" : "loading",
              message: hasCriticalSceneError || !modelRootRef.current ? statusMessage : "",
              meshes: cachedStats.meshes,
              vertices: cachedStats.vertices,
              fps: 0,
              performanceMode: "normal"
            });
          }
          fpsFrameCount = 0;
          lastFpsTime = now;
          lastRenderTime = now;
          schedulePreviewAnimation(PREVIEW_BACKGROUND_RENDER_INTERVAL_MS);
          return;
        }
        const interactionActive = now < globeInteractionQualityUntil || transformControls.dragging;
        const tilesRenderBurstActive = now < tilesVisualDirtyUntil;
        let lowFpsActive = now < lowFpsRecoveryUntil;
        const shouldDisplayLiveFps = interactionActive || !modelRootRef.current;
        if (!shouldDisplayLiveFps && fpsLabelVisible && renderer) {
          fpsLabelVisible = false;
          lastFpsInfoEmitTime = now;
          lastFpsInfoValue = undefined;
          lastFpsInfoPerformanceMode = lowFpsActive ? "adaptive" : "normal";
          onSceneInfoChange({
            backend: getRendererBackend(renderer),
            status: hasCriticalSceneError ? "error" : modelRootRef.current ? "ready" : "loading",
            message: hasCriticalSceneError || !modelRootRef.current ? statusMessage : "",
            meshes: cachedStats.meshes,
            vertices: cachedStats.vertices,
            fps: 0,
            performanceMode: lowFpsActive ? "adaptive" : "normal"
          });
        }
        if (now - lastFpsTime >= 1000) {
          currentFps = (fpsFrameCount * 1000) / (now - lastFpsTime);
          fpsFrameCount = 0;
          lastFpsTime = now;
          if (interactionActive || tilesRenderBurstActive) {
            if (currentFps < PREVIEW_LOW_FPS_THRESHOLD) {
              lowFpsRecoveryUntil = now + PREVIEW_LOW_FPS_RECOVERY_MS;
            } else if (currentFps < PREVIEW_LOW_FPS_RECOVER_THRESHOLD && now < lowFpsRecoveryUntil) {
              lowFpsRecoveryUntil = Math.max(lowFpsRecoveryUntil, now + PREVIEW_LOW_FPS_RECOVERY_MS / 2);
            } else if (currentFps >= PREVIEW_LOW_FPS_RECOVER_THRESHOLD && now > lowFpsRecoveryUntil) {
              lowFpsRecoveryUntil = 0;
            }
          } else if (now > lowFpsRecoveryUntil) {
            lowFpsRecoveryUntil = 0;
          }
          lowFpsActive = now < lowFpsRecoveryUntil;
          if (renderer) {
            const shouldDisplayFps = interactionActive || !modelRootRef.current;
            const nextFpsLabelVisible = shouldDisplayFps && typeof currentFps === "number" && currentFps > 0;
            const nextFpsValue = nextFpsLabelVisible ? normalizePreviewFps(currentFps) : undefined;
            const nextPerformanceMode: PreviewPerformanceMode = lowFpsActive ? "adaptive" : "normal";
            const shouldThrottleFpsInfo =
              fpsLabelVisible &&
              nextFpsLabelVisible &&
              lastFpsInfoPerformanceMode === nextPerformanceMode &&
              typeof nextFpsValue === "number" &&
              typeof lastFpsInfoValue === "number" &&
              now - lastFpsInfoEmitTime < PREVIEW_LOW_FPS_INFO_INTERVAL_MS &&
              Math.abs(nextFpsValue - lastFpsInfoValue) < PREVIEW_FPS_SIGNIFICANT_CHANGE;
            if (!shouldThrottleFpsInfo) {
              fpsLabelVisible = nextFpsLabelVisible;
              lastFpsInfoEmitTime = now;
              lastFpsInfoValue = nextFpsValue;
              lastFpsInfoPerformanceMode = nextPerformanceMode;
              onSceneInfoChange({
                backend: getRendererBackend(renderer),
                status: hasCriticalSceneError ? "error" : modelRootRef.current ? "ready" : "loading",
                message: hasCriticalSceneError || !modelRootRef.current ? statusMessage : "",
                meshes: cachedStats.meshes,
                vertices: cachedStats.vertices,
                fps: nextFpsLabelVisible ? currentFps : 0,
                performanceMode: nextPerformanceMode
              });
            }
          }
        }
        let sceneVisualDirty = false;
        const hasDynamicTiles = tilesRef.current.length > 0;
        const targetPixelRatio = getPreviewPixelRatio(
          interactionActive ? "interactive" : lowFpsActive ? "low-fps" : "normal"
        );
        if (Math.abs(targetPixelRatio - activeRendererPixelRatio) > 0.01) {
          activeRendererPixelRatio = targetPixelRatio;
          activeRenderer.setPixelRatio(activeRendererPixelRatio);
          resizeRenderer(container, activeRenderer, camera);
          sceneVisualDirty = true;
        }
        const sceneRefreshDirty = now < sceneVisualDirtyUntil;
        const lightingDirty = syncPreviewTimeLighting(activeRenderer);
        sceneVisualDirty = lightingDirty || sceneVisualDirty;
        const runtimeGlobeControls = globeControls as RuntimeGlobeControls;
        const globeControlsPending = Boolean(
          runtimeGlobeControls.needsUpdate ||
          runtimeGlobeControls._inertiaNeedsUpdate?.()
        );
        const viewStateSyncReady = pendingDeferredViewStateSync &&
          !lowFpsActive &&
          now >= deferredViewStateSyncReadyAt;
        const canSkipStaticIdleWork = Boolean(
          modelRootRef.current &&
          !hasDynamicTiles &&
          !interactionActive &&
          !lowFpsActive &&
          !sceneVisualDirty &&
          !sceneRefreshDirty &&
          !globeControlsPending &&
          !viewStateSyncReady
        );
        if (canSkipStaticIdleWork) {
          schedulePreviewAnimation(PREVIEW_IDLE_RENDER_INTERVAL_MS);
          return;
        }
        updateNavigationMode(transformControls.dragging);
        globeControls.update();
        applyCloseZoomCameraClipping(camera, ellipsoidContextRef.current);
        if (starField) starField.visible = latestViewOptionsRef.current.stars;
        scene.background = latestViewOptionsRef.current.stars ? null : plainBackground;
        tilesRef.current.forEach((tiles) => {
          if (tiles.group.name === "上下文 3D Tiles") {
            tiles.group.visible = true;
          }
        });
        const tilesUpdateInterval = lowFpsActive
          ? PREVIEW_LOW_FPS_TILES_UPDATE_INTERVAL_MS
          : PREVIEW_IDLE_RENDER_INTERVAL_MS;
        const shouldUpdateTiles = hasDynamicTiles && (
          interactionActive ||
          now - lastTilesUpdateTime >= tilesUpdateInterval
        );
        if (shouldUpdateTiles) {
          lastTilesUpdateTime = now;
          const tilesQuality: PreviewTilesQuality = interactionActive ? "interactive" : lowFpsActive ? "balanced" : "normal";
          tilesRef.current.forEach((tiles) => {
            ensureTilesCamera(tiles, camera);
            if (setTilesPreviewResolution(tiles, camera, activeRenderer, container, tilesQuality)) {
              sceneVisualDirty = true;
            }
            tiles.update();
          });
        }
        const tilesVisualDirty = hasDynamicTiles && now < tilesVisualDirtyUntil;
        const tilesSummaryDirty = hasDynamicTiles && tilesContentRevision !== summarizedTilesContentRevision;
        if (tilesSummaryDirty && now - lastSummaryTime >= PREVIEW_DYNAMIC_SUMMARY_INTERVAL_MS) {
          if (interactionActive || lowFpsActive) {
            pendingDeferredSummary = true;
            lastSummaryTime = now;
          } else {
            lastSummaryTime = now;
            refreshSceneSummary();
          }
        }
        if (
          tilesSummaryDirty &&
          pendingDeferredSummary &&
          !interactionActive &&
          !lowFpsActive &&
          now - lastSummaryTime >= PREVIEW_DEFERRED_SUMMARY_DELAY_MS
        ) {
          pendingDeferredSummary = false;
          lastSummaryTime = now;
          refreshSceneSummary();
        }
        if (now - lastViewStateSyncTime >= PREVIEW_VIEW_STATE_SYNC_INTERVAL_MS) {
          lastViewStateSyncTime = now;
          if (interactionActive || lowFpsActive) {
            pendingDeferredViewStateSync = true;
            deferredViewStateSyncReadyAt = Math.max(
              deferredViewStateSyncReadyAt,
              now + PREVIEW_DEFERRED_VIEW_STATE_SYNC_DELAY_MS
            );
          } else {
            pendingDeferredViewStateSync = false;
            deferredViewStateSyncReadyAt = 0;
            syncSceneViewState();
          }
        } else if (
          pendingDeferredViewStateSync &&
          !interactionActive &&
          !lowFpsActive &&
          now >= deferredViewStateSyncReadyAt
        ) {
          pendingDeferredViewStateSync = false;
          deferredViewStateSyncReadyAt = 0;
          lastViewStateSyncTime = now;
          syncSceneViewState();
        }
        const latestSelectedLayerKey = latestSelectedLayerKeyRef.current;
        const selected = latestSelectedLayerKey ? objectsByLayerKeyRef.current.get(latestSelectedLayerKey) : null;
        let selectedVisible = false;
        if (selected?.visible) {
          selectedVisible = isObjectVisibleInHierarchy(selected);
        }
        const selectedSignature = selectedVisible && selected
          ? [
            latestSelectedLayerKey,
            latestTransformRef.current.position.join(","),
            latestTransformRef.current.rotation.join(","),
            latestTransformRef.current.scale.join(","),
            latestTransformRef.current.geo
              ? `${latestTransformRef.current.geo.longitude},${latestTransformRef.current.geo.latitude},${latestTransformRef.current.geo.height}`
              : ""
          ].join("|")
          : "";
        if (selectedSignature !== selectionBoxSignature) {
          lastSelectionBoxTime = now;
          sceneVisualDirty = updateSelectionBox(selectedVisible ? selected || null : null, selectedSignature, true) || sceneVisualDirty;
        } else if (
          selectionBox &&
          selected &&
          isObjectInTilesRendererHierarchy(selected) &&
          now - lastSelectionBoxTime >= 1000
        ) {
          lastSelectionBoxTime = now;
          sceneVisualDirty = updateSelectionBox(selectedVisible ? selected || null : null, selectedSignature) || sceneVisualDirty;
        }
        const shouldRenderIdleHeartbeat = (!modelRootRef.current || hasDynamicTiles) &&
          now - lastRenderTime >= PREVIEW_IDLE_RENDER_INTERVAL_MS;
        const shouldRenderTilesVisual = tilesVisualDirty && (
          !lowFpsActive ||
          interactionActive ||
          now - lastRenderTime >= PREVIEW_IDLE_RENDER_INTERVAL_MS
        );
        const shouldRenderFrame = sceneRefreshDirty ||
          shouldRenderTilesVisual ||
          interactionActive ||
          sceneVisualDirty ||
          shouldRenderIdleHeartbeat;
        if (!shouldRenderFrame) {
          schedulePreviewAnimation(PREVIEW_IDLE_RENDER_INTERVAL_MS);
          return;
        }
        lastRenderTime = now;
        fpsFrameCount += 1;
        try {
          if (latestSceneModeRef.current === "sphere" && atmosphereRenderer) {
            try {
              atmosphereRenderer.render();
            } catch (error) {
              console.warn("Takram atmosphere preview renderer failed during render; using the base renderer.", error);
              atmosphereRenderer.dispose();
              atmosphereRenderer = null;
              renderer.render(scene, camera);
            }
          } else {
            renderer.render(scene, camera);
          }
        } catch (error) {
          if (!renderFailed && rendererPreference === "webgpu") {
            renderFailed = true;
            onRendererFallback(WEBGPU_FALLBACK_MESSAGE);
            return;
          }
          throw error;
        }
        schedulePreviewAnimation();
      };
      animateLoop = animate;
      schedulePreviewAnimation();

      return () => {
        detachGlobeControlsBehavior();
        atmosphereRenderer?.dispose();
        atmosphereRenderer = null;
        cancelPendingCanvasPick();
        clearCanvasHoverCursor();
        cancelScheduledPreviewAnimation();
        cancelScheduledPreviewResize();
        document.removeEventListener("visibilitychange", handlePreviewVisibilityChange);
        renderer?.domElement.removeEventListener("pointerdown", handlePointerDown);
        renderer?.domElement.removeEventListener("pointermove", handlePreviewPointerMove);
        renderer?.domElement.removeEventListener("pointerleave", handlePreviewPointerLeave);
        renderer?.domElement.removeEventListener("pointerup", handlePointerUp);
        renderer?.domElement.removeEventListener("pointercancel", handlePointerCancel);
        renderer?.domElement.removeEventListener("dblclick", handleCanvasDoubleClick);
        renderer?.domElement.removeEventListener("wheel", handlePreviewWheel);
      };
    };

    let removePointerHandler: (() => void) | undefined;
    void run().then((cleanup) => {
      removePointerHandler = cleanup;
    }).catch((error) => {
      if (disposed) {
        return;
      }
      onSceneInfoChange({
        backend: renderer ? getRendererBackend(renderer) : "Detecting",
        status: "error",
        message: error instanceof Error ? error.message : "渲染器初始化失败",
        meshes: 0,
        vertices: 0,
        performanceMode: "normal"
      });
    });

    return () => {
      disposed = true;
      notifySceneRefreshRef.current = () => undefined;
      if (pendingTransformChangeTimer) {
        window.clearTimeout(pendingTransformChangeTimer);
        pendingTransformChangeTimer = 0;
      }
      pendingTransformChange = null;
      cancelScheduledPreviewAnimation();
      cancelScheduledPreviewResize();
      removePointerHandler?.();
      resizeObserver?.disconnect();
      transformControlsRef.current?.detach();
      transformControlsRef.current?.dispose();
      globeControlsRef.current?.dispose();
      tileEventCleanups.splice(0).forEach((cleanup) => cleanup());
      loadedObjects.forEach(disposeLoaded);
      atmosphereRenderer?.dispose();
      atmosphereRenderer = null;
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
      pickableObjectsRef.current = [];
      onLayerTreeChange([]);
      onMaterialListChange([]);
      scene.traverse((object) => disposeObject(object));
      renderer?.dispose();
      if (renderer?.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [applyHiddenLayerVisibility, contextTilesUrl, onInteractionHintChange, onLayerTreeChange, onMaterialListChange, onPlacementDone, onPlacementMiss, onSceneInfoChange, onSelectLayer, onTransformChange, type, url]);

  const canvasInteractionDescription = placementMode
    ? "地表落位模式：单击地球表面放置模型，按 Esc 退出"
    : sceneMode === "sphere"
      ? "三维操作：左键拖动平移地球，右键或 Shift 加左键旋转，滚轮缩放，双击模型聚焦"
      : "三维操作：左键旋转，Shift、Ctrl 或 ⌘ 加左键平移，滚轮缩放，右键上下拖动缩放，中键俯仰观察，双击模型聚焦";
  const canvasInteractionTitle = placementMode
    ? "地表落位：单击地球表面放置 · Esc 退出"
    : sceneMode === "sphere"
      ? "左键拖动平移地球 · 右键或 Shift+左键旋转 · 滚轮缩放 · 双击模型聚焦"
      : "左键旋转 · Shift/Ctrl/⌘+左键平移 · 滚轮缩放 · 右键拖动缩放 · 中键俯仰 · 双击模型聚焦";

  return (
    <div
      ref={containerRef}
      aria-label={canvasInteractionDescription}
      className={`preview-three-canvas${placementMode ? " is-placement-mode" : ""}`}
      title={canvasInteractionTitle}
    />
  );
}, areThreeScenePropsEqual);

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
        <InputNumber
          aria-label="经度"
          disabled={disabled}
          value={geo.longitude}
          min={-180}
          max={180}
          step={0.000001}
          formatter={(value, info) => formatPreviewNumberInput(value, info, 6)}
          onChange={(value) => setGeo("longitude", value)}
        />
        </div>
        <div className="preview-control-row">
        <span>纬度</span>
        <InputNumber
          aria-label="纬度"
          disabled={disabled}
          value={geo.latitude}
          min={-90}
          max={90}
          step={0.000001}
          formatter={(value, info) => formatPreviewNumberInput(value, info, 6)}
          onChange={(value) => setGeo("latitude", value)}
        />
        </div>
        <div className="preview-control-row">
        <span>高程</span>
        <InputNumber
          aria-label="高程"
          disabled={disabled}
          value={geo.height}
          step={1}
          formatter={(value, info) => formatPreviewNumberInput(value, info, 2)}
          onChange={(value) => setGeo("height", value)}
        />
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
          value={value}
          min={min}
          step={step}
          formatter={(nextValue, info) => formatPreviewNumberInput(nextValue, info)}
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
            value={values[index]}
            min={min}
            step={step}
            formatter={(nextValue, info) => formatPreviewNumberInput(nextValue, info)}
            onChange={(value) => onChange(index, value)}
          />
          {suffix ? <em>{suffix}</em> : null}
        </span>
      ))}
    </div>
  );
}

async function createWebGPUPreviewRenderer(
  container: HTMLDivElement,
  preference: ThreeRendererPreference,
  onBackend: (backend: RendererBackend) => void
): Promise<PreviewRendererResult> {
  let webgpuInitError: unknown;
  const webgpuSupport = preference === "webgpu" ? await detectWebGPUAdapterSupport() : null;

  if (webgpuSupport?.supported) {
    try {
      const renderer = new WebGPURenderer({
        antialias: true,
        alpha: true,
        powerPreference: webgpuSupport.powerPreference
      });
      await renderer.init();
      (renderer as unknown as { highPrecision?: boolean }).highPrecision = true;
      (renderer as unknown as {
        library?: {
          addToneMapping?: (node: unknown, toneMapping: unknown) => void;
        };
      }).library?.addToneMapping?.(agxPunchyToneMapping, AgXPunchyToneMapping);
      configurePreviewRenderer(container, renderer);
      const backend = getRendererBackend(renderer);
      onBackend(backend);
      return {
        renderer,
        backend,
        fallbackMessage: backend === "WebGL2 fallback" ? WEBGPU_FALLBACK_MESSAGE : undefined
      };
    } catch (error) {
      webgpuInitError = error;
      console.warn("WebGPU preview renderer failed to initialize; using native WebGL renderer.", error);
    }
  } else if (preference === "webgpu") {
    webgpuInitError = new Error(webgpuSupport?.reason || describeWebGPUAdapterFailure([]));
  }

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance"
  });
  configurePreviewRenderer(container, renderer);
  const backend = getRendererBackend(renderer);
  onBackend(backend);
  return {
    renderer,
    backend,
    fallbackMessage: preference === "webgpu"
      ? webgpuInitError instanceof Error
        ? `${WEBGPU_FALLBACK_MESSAGE}（${webgpuInitError.message}）`
        : WEBGPU_FALLBACK_MESSAGE
      : undefined
  };
}

function configurePreviewRenderer(container: HTMLDivElement, renderer: PreviewRenderer) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.setPixelRatio(getPreviewPixelRatio());
  resizeRenderer(container, renderer, new THREE.PerspectiveCamera());
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
    preparePreviewObjectForRenderer(gltf.scene, renderer);
    return { object: gltf.scene, name: gltf.scene.name || label || "glTF / GLB" };
  }
  if (type === "fbx") {
    const object = await new FBXLoader().loadAsync(url, createLoadingProgressHandler(onProgress));
    preparePreviewObjectForRenderer(object, renderer);
    return { object, name: object.name || label || "FBX" };
  }
  if (type === "obj") {
    const object = await new OBJLoader().loadAsync(url, createLoadingProgressHandler(onProgress));
    preparePreviewObjectForRenderer(object, renderer);
    return { object, name: object.name || label || "OBJ" };
  }
  if (type === "dae") {
    const collada = await new ColladaLoader().loadAsync(url, createLoadingProgressHandler(onProgress));
    if (!collada?.scene) {
      throw new Error("DAE / Collada 模型加载失败。");
    }
    preparePreviewObjectForRenderer(collada.scene, renderer);
    return { object: collada.scene, name: collada.scene.name || label || "DAE" };
  }
  if (type === "stl") {
    const geometry = await new STLLoader().loadAsync(url, createLoadingProgressHandler(onProgress));
    const material = new THREE.MeshStandardMaterial({ color: 0x8ec9ff, metalness: 0.05, roughness: 0.72 });
    const object = new THREE.Mesh(geometry, material);
    object.name = label || "STL";
    preparePreviewObjectForRenderer(object, renderer);
    return { object, name: object.name };
  }
  if (type === "ply") {
    const geometry = await new PLYLoader().loadAsync(url, createLoadingProgressHandler(onProgress));
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: 0x8ec9ff, metalness: 0.05, roughness: 0.72 });
    const object = new THREE.Mesh(geometry, material);
    object.name = label || "PLY";
    preparePreviewObjectForRenderer(object, renderer);
    return { object, name: object.name };
  }
  if (type === "usd") {
    try {
      const object = await new USDLoader().loadAsync(url, createLoadingProgressHandler(onProgress));
      preparePreviewObjectForRenderer(object, renderer);
      return { object, name: object.name || label || "USD" };
    } catch (error) {
      throw new Error(`USD / USDZ 暂时无法在线预览${error instanceof Error ? `：${error.message}` : ""}`);
    }
  }
  if (type === "3dtiles") {
    const tiles = createTilesRenderer(url, shouldUsePreviewWebGpuNodeMaterials(renderer));
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

function preparePreviewObjectForRenderer(object: THREE.Object3D, renderer: PreviewRenderer) {
  if (shouldUsePreviewWebGpuNodeMaterials(renderer)) {
    replacePreviewMeshMaterials(object);
  }
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

function getPreviewPixelRatio(mode: "normal" | "interactive" | "low-fps" = "normal"): number {
  const devicePixelRatio = Math.max(window.devicePixelRatio || 1, 0.5);
  const normalPixelRatio = Math.min(devicePixelRatio, PREVIEW_MAX_PIXEL_RATIO);
  if (mode === "interactive") {
    return Math.min(normalPixelRatio, PREVIEW_INTERACTIVE_PIXEL_RATIO);
  }
  if (mode === "low-fps") {
    return Math.min(normalPixelRatio, PREVIEW_LOW_FPS_PIXEL_RATIO);
  }
  return normalPixelRatio;
}

function hasNonZeroWheelDelta(event: WheelEvent): boolean {
  return event.deltaX !== 0 || event.deltaY !== 0 || event.deltaZ !== 0;
}

function isNativeGlobeRotateModifier(event: Pick<MouseEvent | KeyboardEvent, "shiftKey">): boolean {
  return event.shiftKey;
}

function isTransformControlPointerHit(
  event: Pick<MouseEvent | PointerEvent, "clientX" | "clientY">,
  controls: TransformControls | null,
  camera: THREE.Camera,
  element: HTMLElement
): boolean {
  if (!controls) return false;
  const helper = controls.getHelper();
  if (!helper.visible) return false;
  const rect = element.getBoundingClientRect();
  TRANSFORM_CONTROL_HIT_POINTER.set(
    ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
    -((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1
  );
  helper.updateMatrixWorld(true);
  TRANSFORM_CONTROL_HIT_RAYCASTER.setFromCamera(TRANSFORM_CONTROL_HIT_POINTER, camera);
  return TRANSFORM_CONTROL_HIT_RAYCASTER.intersectObject(helper, true).length > 0;
}

function shouldShowTransformControlHelper(
  selectedLayerKey: string | null,
  objectsByLayerKey: Map<string, THREE.Object3D>,
  placementMode: boolean
): boolean {
  if (placementMode || !selectedLayerKey) {
    return false;
  }
  const selected = objectsByLayerKey.get(selectedLayerKey);
  return Boolean(selected && hasVisibleRenderableObject(selected));
}

function hasVisibleRenderableObject(object: THREE.Object3D): boolean {
  let hasRenderableObject = false;
  object.traverse((child) => {
    if (hasRenderableObject || isHelperObject(child) || !isObjectVisibleInHierarchy(child)) {
      return;
    }
    if (isRaycastRenderableObject(child)) {
      hasRenderableObject = true;
    }
  });
  return hasRenderableObject;
}

function getRendererBackend(renderer: PreviewRenderer): RendererBackend {
  const backend = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean; isWebGLBackend?: boolean } }).backend;
  if (backend?.isWebGPUBackend) return "WebGPU";
  if (backend?.isWebGLBackend) return "WebGL2 fallback";
  return renderer instanceof THREE.WebGLRenderer ? "WebGL" : "WebGPU";
}

function shouldUsePreviewWebGpuNodeMaterials(renderer: PreviewRenderer): boolean {
  return renderer instanceof WebGPURenderer && getRendererBackend(renderer) === "WebGPU";
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
  ellipsoidContext: EllipsoidContext,
  options: { allowInitialFallback?: boolean } = {}
): boolean {
  const allowInitialFallback = options.allowInitialFallback ?? true;
  const sphere = getObjectFocusSphere(object);
  if (!sphere) {
    if (allowInitialFallback && sceneMode === "sphere") {
      setInitialCamera(camera, sceneMode, ellipsoidContext);
      return true;
    }
    return false;
  }
  return focusSphere(sphere, camera, sceneMode, globeControls, ellipsoidContext);
}

function focusSphere(
  sphere: THREE.Sphere,
  camera: THREE.PerspectiveCamera,
  sceneMode: PreviewSceneMode,
  globeControls: GlobeControls | null,
  ellipsoidContext: EllipsoidContext
): boolean {
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
    return true;
  }
  return false;
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
    position: toSceneViewTuple(camera.position),
    target: toSceneViewTuple(target)
  };
}

function toSceneViewTuple(vector: THREE.Vector3): [number, number, number] {
  return [
    normalizeSceneViewNumber(vector.x),
    normalizeSceneViewNumber(vector.y),
    normalizeSceneViewNumber(vector.z)
  ];
}

function getSceneViewStateSignature(state: SceneViewState): string {
  const camera = state.camera;
  const cameraSignature = camera
    ? [
      ...camera.position.map(formatSceneViewNumber),
      ...camera.target.map(formatSceneViewNumber)
    ].join(",")
    : "";
  return [
    cameraSignature,
    state.selectedObjectId || "",
    state.visibleLayerIds?.join("\u001f") || ""
  ].join("|");
}

function formatSceneViewNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(PREVIEW_SCENE_VIEW_NUMBER_PRECISION) : String(value);
}

function normalizeSceneViewNumber(value: number): number {
  return Number.isFinite(value)
    ? Number(value.toFixed(PREVIEW_SCENE_VIEW_NUMBER_PRECISION))
    : value;
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

function getBox3Signature(box: THREE.Box3): string {
  return [
    box.min.x,
    box.min.y,
    box.min.z,
    box.max.x,
    box.max.y,
    box.max.z
  ].map((value) => Number.isFinite(value) ? value.toPrecision(10) : String(value)).join(",");
}

function getTilesRendererFromObject(object: THREE.Object3D): TilesRenderer | null {
  const candidate = object.userData.previewTilesRenderer;
  return candidate instanceof TilesRenderer ? candidate : null;
}

function isObjectInTilesRendererHierarchy(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (getTilesRendererFromObject(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
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

function createFallbackEarth() {
  const group = new THREE.Group();
  group.name = "Default Earth";

  const globe = new THREE.Mesh(
    createScaledFallbackSphereGeometry(1, 128, 64),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 1,
      metalness: 0
    })
  );
  globe.name = "Default Earth Surface";
  group.add(globe);

  return group;
}

const previewFallbackSunDirectionScratch = new THREE.Vector3();

function updatePreviewFallbackSunLight(
  light: THREE.DirectionalLight,
  lightingState: PreviewTimeLightingState,
  ellipsoidContext: EllipsoidContext
) {
  getPreviewSunDirectionECEF(lightingState.solarTimeMs, previewFallbackSunDirectionScratch);
  previewFallbackSunDirectionScratch.transformDirection(ellipsoidContext.group.matrixWorld).normalize();
  light.position.copy(previewFallbackSunDirectionScratch);
  light.intensity = lightingState.sunIntensity;
  light.color.copy(lightingState.sunColor);
  light.updateMatrixWorld();
}

function updatePreviewStarFieldOpacity(starField: THREE.Points | null, opacity: number) {
  if (!starField || !(starField.material instanceof THREE.PointsMaterial)) {
    return;
  }
  const nextOpacity = THREE.MathUtils.clamp(opacity, 0.12, 0.82);
  if (Math.abs(starField.material.opacity - nextOpacity) < 0.01) {
    return;
  }
  starField.material.opacity = nextOpacity;
}

function createScaledFallbackSphereGeometry(scale: number, widthSegments: number, heightSegments: number) {
  const geometry = new THREE.SphereGeometry(1, widthSegments, heightSegments);
  geometry.rotateX(Math.PI / 2);
  geometry.scale(
    GEOSPATIAL_WGS84.radii.x * scale,
    GEOSPATIAL_WGS84.radii.y * scale,
    GEOSPATIAL_WGS84.radii.z * scale
  );
  return geometry;
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

  const visit = (object: THREE.Object3D, path: string): LayerNode | null => {
    const key = path || "root";
    object.userData.previewLayerKey = key;
    objectsByKey.set(key, object);
    if (options.shallow) {
      return {
        key,
        title: options.rootTitle || safeLayerName(object),
        kind: object.type
      };
    }
    const children = object.children
      .map((child, index) => visit(child, `${key}/${index}-${safeLayerName(child)}`))
      .filter((child): child is LayerNode => Boolean(child));

    return {
      key,
      title: options.rootTitle || safeLayerName(object),
      kind: object.type,
      children: children.length ? children : undefined
    };
  };

  const rootNode = visit(root, "model");
  return {
    tree: rootNode ? [rootNode] : [],
    objectsByKey
  };
}

function collectMaterialList(root: THREE.Object3D, maxObjects = Number.POSITIVE_INFINITY): MaterialNode[] {
  const materials = new Map<string, MaterialNode>();
  const stack = [root];
  let count = 0;
  while (stack.length && count < maxObjects) {
    const object = stack.pop()!;
    count += 1;
    const mesh = object as THREE.Object3D & { material?: THREE.Material | THREE.Material[] };
    const objectMaterials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    if (objectMaterials.length) {
      const layerKey = typeof object.userData.previewLayerKey === "string" ? object.userData.previewLayerKey : findLayerKeyForObject(object);
      objectMaterials.forEach((material) => {
        const key = material.uuid || material.name || "material";
        const current = materials.get(key);
        if (current) {
          current.objectCount += 1;
          if (!current.layerKey && layerKey) {
            current.layerKey = layerKey;
          }
          return;
        }
        materials.set(key, {
          key,
          title: material.name?.trim() || "No Name",
          layerKey,
          objectCount: 1,
          color: getMaterialPreviewColor(material)
        });
      });
    }
    for (let index = object.children.length - 1; index >= 0; index -= 1) {
      stack.push(object.children[index]);
    }
  }
  return [...materials.values()].sort((first, second) => first.title.localeCompare(second.title, "zh-CN"));
}

function getLayerTreeStateSignature(nodes: LayerNode[]): string {
  const parts: string[] = [];
  const visit = (node: LayerNode) => {
    parts.push(node.key, node.title, node.kind || "", String(node.children?.length || 0));
    node.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return parts.join("\u001f");
}

function getMaterialListStateSignature(materials: MaterialNode[]): string {
  return materials
    .map((material) => [
      material.key,
      material.title,
      material.layerKey || "",
      material.objectCount,
      material.color || ""
    ].join("\u001e"))
    .join("\u001f");
}

function getMaterialPreviewColor(material: THREE.Material): string | undefined {
  const candidate = material as THREE.Material & { color?: THREE.Color };
  return candidate.color instanceof THREE.Color ? `#${candidate.color.getHexString()}` : undefined;
}

function safeLayerName(object: THREE.Object3D): string {
  return (object.name || object.type || "Object").slice(0, 80);
}

function collectLayerSignature(root: THREE.Object3D, maxObjects = 800): string {
  const parts: string[] = [];
  const stack = [root];
  let count = 0;
  while (stack.length && count < maxObjects) {
    const object = stack.pop()!;
    parts.push(`${object.uuid}:${object.type}:${object.name}:${object.children.length}`);
    count += 1;
    for (let index = object.children.length - 1; index >= 0; index -= 1) {
      stack.push(object.children[index]);
    }
  }
  if (stack.length) {
    parts.push(`more:${stack.length}`);
  }
  return parts.join("|");
}

function findLayerKeyForObject(object: THREE.Object3D): string | null {
  if (typeof object.userData.previewLayerKey === "string") {
    return object.userData.previewLayerKey;
  }
  let current: THREE.Object3D | null = object;
  while (current) {
    if (typeof current.userData.previewLayerKey === "string") {
      object.userData.previewLayerKey = current.userData.previewLayerKey;
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

function compactMeshLayerTree(nodes: LayerNode[]): LayerNode[] {
  const visit = (node: LayerNode): LayerNode[] => {
    const children = node.children?.flatMap(visit);
    const nextNode = children
      ? {
        ...node,
        children: children.length ? children : undefined
      }
      : node;
    return shouldPromoteMeshLayerNode(nextNode) ? nextNode.children || [] : [nextNode];
  };
  return nodes.flatMap(visit);
}

function collectFlatMeshLayerNodes(nodes: LayerNode[]): LayerNode[] {
  const renderableNodes: LayerNode[] = [];
  const leafNodes: LayerNode[] = [];
  const visit = (node: LayerNode) => {
    const flatNode = {
      ...node,
      children: undefined
    };
    if (isRenderableMeshLayerNode(node)) {
      renderableNodes.push(flatNode);
    }
    if (!node.children?.length) {
      leafNodes.push(flatNode);
      return;
    }
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return renderableNodes.length ? renderableNodes : leafNodes;
}

function normalizeLayerSearchQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isLayerNodeSearchMatch(node: LayerNode, query: string): boolean {
  if (!query) {
    return true;
  }
  return node.title.toLocaleLowerCase().includes(query) ||
    node.key.toLocaleLowerCase().includes(query) ||
    (node.kind || "").toLocaleLowerCase().includes(query);
}

function filterLayerTreeBySearchQuery(nodes: LayerNode[], query: string): LayerNode[] {
  if (!query) {
    return nodes;
  }
  const visit = (node: LayerNode): LayerNode | null => {
    if (isLayerNodeSearchMatch(node, query)) {
      return node;
    }
    const children = node.children
      ?.map(visit)
      .filter((child): child is LayerNode => Boolean(child));
    if (!children?.length) {
      return null;
    }
    return {
      ...node,
      children
    };
  };
  return nodes
    .map(visit)
    .filter((node): node is LayerNode => Boolean(node));
}

function countLayerSearchMatches(nodes: LayerNode[], query: string): number {
  if (!query) {
    return 0;
  }
  let count = 0;
  const visit = (node: LayerNode) => {
    if (isLayerNodeSearchMatch(node, query)) {
      count += 1;
    }
    node.children?.forEach(visit);
  };
  nodes.forEach(visit);
  return count;
}

function collectPickableObjects(
  root: THREE.Object3D,
  fallbackLayerKey: string | null = null,
  options: { maxObjects?: number; maxPickableObjects?: number } = {}
): THREE.Object3D[] {
  const maxObjects = options.maxObjects ?? Number.POSITIVE_INFINITY;
  const maxPickableObjects = options.maxPickableObjects ?? Number.POSITIVE_INFINITY;
  const pickableObjects: THREE.Object3D[] = [];
  const stack = [root];
  let count = 0;
  while (stack.length && count < maxObjects && pickableObjects.length < maxPickableObjects) {
    const object = stack.pop()!;
    count += 1;
    if (isRaycastRenderableObject(object) && !isHelperObject(object)) {
      if (fallbackLayerKey && typeof object.userData.previewLayerKey !== "string") {
        object.userData.previewLayerKey = fallbackLayerKey;
      }
      pickableObjects.push(object);
    }
    for (let index = object.children.length - 1; index >= 0; index -= 1) {
      stack.push(object.children[index]);
    }
  }
  return pickableObjects;
}

function isRaycastRenderableObject(object: THREE.Object3D): boolean {
  const candidate = object as THREE.Object3D & {
    isBatchedMesh?: boolean;
    isInstancedMesh?: boolean;
    isLine?: boolean;
    isLineSegments?: boolean;
    isMesh?: boolean;
    isPoints?: boolean;
    isSkinnedMesh?: boolean;
    isSprite?: boolean;
  };
  return Boolean(
    candidate.isMesh ||
    candidate.isSkinnedMesh ||
    candidate.isInstancedMesh ||
    candidate.isBatchedMesh ||
    candidate.isLine ||
    candidate.isLineSegments ||
    candidate.isPoints ||
    candidate.isSprite
  );
}

function isRenderableMeshLayerNode(node: LayerNode): boolean {
  const kind = node.kind || "";
  return kind === "Mesh" ||
    kind === "SkinnedMesh" ||
    kind === "InstancedMesh" ||
    kind === "BatchedMesh" ||
    kind === "Line" ||
    kind === "LineSegments" ||
    kind === "Points" ||
    kind === "Sprite";
}

function shouldPromoteMeshLayerNode(node: LayerNode): boolean {
  if (!node.children?.length) {
    return false;
  }
  const title = node.title.toLowerCase();
  return node.key === "model" ||
    title.startsWith("group") ||
    title.startsWith("scene") ||
    title.includes("gltf") ||
    title.includes("glb");
}

function collectExpandableLayerKeys(nodes: LayerNode[], maxDepth = 2, maxKeys = 80): string[] {
  const keys: string[] = [];
  const visit = (node: LayerNode, depth: number) => {
    if (keys.length >= maxKeys) {
      return;
    }
    if (node.children?.length && depth < maxDepth) {
      keys.push(node.key);
      node.children.forEach((child) => visit(child, depth + 1));
    }
  };
  nodes.forEach((node) => visit(node, 0));
  return keys;
}

function buildLayerNodeKeyLookup(nodes: LayerNode[]): Map<string, string[]> {
  const lookup = new Map<string, string[]>();
  const visit = (node: LayerNode): string[] => {
    const keys = [node.key];
    node.children?.forEach((child) => {
      keys.push(...visit(child));
    });
    lookup.set(node.key, keys);
    return keys;
  };
  nodes.forEach(visit);
  return lookup;
}

function findLayerNodeTitle(nodes: LayerNode[], key: string): string | null {
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.key === key) {
      return node.title;
    }
    if (node.children?.length) {
      stack.push(...node.children);
    }
  }
  return null;
}

function findLayerAncestorKeys(nodes: LayerNode[], targetKey: string): string[] {
  const visit = (node: LayerNode, ancestors: string[]): string[] | null => {
    if (node.key === targetKey) {
      return ancestors;
    }
    if (!node.children?.length) {
      return null;
    }
    const nextAncestors = [...ancestors, node.key];
    for (const child of node.children) {
      const result = visit(child, nextAncestors);
      if (result) {
        return result;
      }
    }
    return null;
  };
  for (const node of nodes) {
    const result = visit(node, []);
    if (result) {
      return result;
    }
  }
  return [];
}

function getLayerKeyFallbackTitle(key: string): string {
  const fallbackTitle = key.split("/").filter(Boolean).pop();
  return fallbackTitle || key;
}

function buildLayerVisibilityStateMap(
  nodes: LayerNode[],
  checkedSet: Set<string>
): Map<string, LayerVisibilityState> {
  const states = new Map<string, LayerVisibilityState>();
  const visit = (node: LayerNode): LayerVisibilityState => {
    const nodeVisible = checkedSet.has(node.key);
    if (!node.children?.length) {
      const state: LayerVisibilityState = nodeVisible ? "visible" : "hidden";
      states.set(node.key, state);
      return state;
    }

    const childStates = node.children.map(visit);
    const state = getLayerVisibilityState(nodeVisible, childStates);
    states.set(node.key, state);
    return state;
  };
  nodes.forEach(visit);
  return states;
}

function getLayerVisibilityState(
  nodeVisible: boolean,
  childStates: LayerVisibilityState[]
): LayerVisibilityState {
  if (nodeVisible && childStates.every((childState) => childState === "visible")) {
    return "visible";
  }
  if (!nodeVisible && childStates.every((childState) => childState === "hidden")) {
    return "hidden";
  }
  return "partial";
}

function collectSceneStats(root: THREE.Object3D, maxObjects = Number.POSITIVE_INFINITY): { meshes: number; vertices: number } {
  let meshes = 0;
  let vertices = 0;
  const stack = [root];
  let count = 0;
  while (stack.length && count < maxObjects) {
    const object = stack.pop()!;
    count += 1;
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) {
      meshes += 1;
      const position = mesh.geometry?.getAttribute("position");
      vertices += position?.count || 0;
    }
    for (let index = object.children.length - 1; index >= 0; index -= 1) {
      stack.push(object.children[index]);
    }
  }
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

function hasCesiumIonGlobeContext(contextTilesUrl?: string, previewUrl?: string): boolean {
  if (!CESIUM_ION_TOKEN && !getCesiumIonRuntimeToken()) {
    return false;
  }
  return isCesiumIonTilesUrl(contextTilesUrl) || isCesiumIonTilesUrl(previewUrl);
}

function isCesiumIonTilesUrl(url?: string): boolean {
  return Boolean(url && (
    /^cesium-ion:\/\//i.test(url) ||
    /^https:\/\/api\.cesium\.com\/v1\/assets\/\d+\/endpoint/i.test(url)
  ));
}

function resolveContextTilesUrl(payload: PreviewPayload): string | undefined {
  const runtimeToken = getCesiumIonRuntimeToken();
  const assetId = getCesiumIonRuntimeAssetId();
  if ((CESIUM_ION_TOKEN || runtimeToken) && assetId) {
    const tokenQuery = runtimeToken ? `?token=${encodeURIComponent(runtimeToken)}` : "";
    return `cesium-ion://asset/${encodeURIComponent(assetId)}${tokenQuery}`;
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

function getCesiumIonRuntimeToken(): string {
  if (typeof window === "undefined") {
    return "";
  }
  const params = new URLSearchParams(window.location.search);
  return String(params.get("ionToken") || params.get("cesiumIonToken") || "").trim();
}

function getCesiumIonRuntimeAssetId(): string {
  if (typeof window === "undefined") {
    return CESIUM_ION_ASSET_ID;
  }
  const params = new URLSearchParams(window.location.search);
  return String(params.get("ionAssetId") || params.get("cesiumIonAssetId") || CESIUM_ION_ASSET_ID).trim();
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

function createTilesRenderer(url: string, useWebGpuNodeMaterials = false): TilesRenderer {
  const ionConfig = getCesiumIonConfig(url);
  const tiles = new TilesRenderer(ionConfig?.endpointUrl || (ionConfig ? undefined : url));
  tiles.errorTarget = PREVIEW_TILE_ERROR_TARGET;
  tiles.loadSiblings = false;
  tiles.loadAncestors = false;
  tiles.maxTilesProcessed = PREVIEW_TILE_MAX_PROCESSED;
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
  if (useWebGpuNodeMaterials) {
    tiles.registerPlugin(new PreviewTileMaterialReplacementPlugin() as any);
  }
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
  ensureTilesCamera(tiles, camera);
  setTilesPreviewResolution(tiles, camera, renderer, element, "normal", true);
}

function ensureTilesCamera(tiles: TilesRenderer, camera: THREE.Camera) {
  if (TILE_CAMERA_CACHE.get(tiles) === camera) {
    return;
  }
  tiles.setCamera(camera);
  TILE_CAMERA_CACHE.set(tiles, camera);
}

function setTilesPreviewResolution(
  tiles: TilesRenderer,
  camera: THREE.Camera,
  renderer: PreviewRenderer,
  element: HTMLElement,
  quality: PreviewTilesQuality = "normal",
  force = false
) {
  renderer.getDrawingBufferSize(TILE_RESOLUTION_SIZE);
  const width = TILE_RESOLUTION_SIZE.x || element.clientWidth || renderer.domElement.clientWidth || 1024;
  const height = TILE_RESOLUTION_SIZE.y || element.clientHeight || renderer.domElement.clientHeight || 768;
  const { maxResolution, errorTarget, maxTilesProcessed } = getPreviewTilesQualitySettings(quality);
  const scale = Math.min(1, maxResolution / Math.max(width, height, 1));
  const nextWidth = Math.max(1, Math.round(width * scale));
  const nextHeight = Math.max(1, Math.round(height * scale));
  const cached = TILE_RESOLUTION_CACHE.get(tiles);
  if (
    !force &&
    cached &&
    cached.width === nextWidth &&
    cached.height === nextHeight &&
    cached.quality === quality &&
    cached.errorTarget === errorTarget &&
    cached.maxTilesProcessed === maxTilesProcessed
  ) {
    return false;
  }
  tiles.errorTarget = errorTarget;
  tiles.maxTilesProcessed = maxTilesProcessed;
  tiles.setResolution(camera, nextWidth, nextHeight);
  TILE_RESOLUTION_CACHE.set(tiles, {
    width: nextWidth,
    height: nextHeight,
    quality,
    errorTarget,
    maxTilesProcessed
  });
  return true;
}

function getPreviewTilesQualitySettings(quality: PreviewTilesQuality) {
  if (quality === "interactive") {
    return {
      maxResolution: PREVIEW_INTERACTIVE_TILES_MAX_RESOLUTION,
      errorTarget: PREVIEW_INTERACTIVE_TILE_ERROR_TARGET,
      maxTilesProcessed: PREVIEW_INTERACTIVE_TILE_MAX_PROCESSED
    };
  }
  if (quality === "balanced") {
    return {
      maxResolution: PREVIEW_BALANCED_TILES_MAX_RESOLUTION,
      errorTarget: PREVIEW_BALANCED_TILE_ERROR_TARGET,
      maxTilesProcessed: PREVIEW_BALANCED_TILE_MAX_PROCESSED
    };
  }
  return {
    maxResolution: PREVIEW_TILES_MAX_RESOLUTION,
    errorTarget: PREVIEW_TILE_ERROR_TARGET,
    maxTilesProcessed: PREVIEW_TILE_MAX_PROCESSED
  };
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

function hasNativeGeospatialPlacement(type: string): boolean {
  return type === "3dtiles";
}

function shouldUseGeoPlacement(type: string, sceneMode: PreviewSceneMode): boolean {
  return sceneMode === "sphere" && !hasNativeGeospatialPlacement(type);
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

function getWorldNorthDirection(point: THREE.Vector3, ellipsoidContext: EllipsoidContext): THREE.Vector3 {
  const localPoint = point.clone().applyMatrix4(getEllipsoidFrameInverse(ellipsoidContext));
  const eastNorthUpFrame = ellipsoidContext.geospatialEllipsoid
    .getEastNorthUpFrame(localPoint, new THREE.Matrix4());
  return new THREE.Vector3(0, 1, 0)
    .transformDirection(eastNorthUpFrame)
    .transformDirection(ellipsoidContext.group.matrixWorld)
    .normalize();
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
  camera.up.copy(getWorldNorthDirection(targetVector, ellipsoidContext));
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

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    Boolean(target.closest("[contenteditable='true']"));
}

function isOperationHelpShortcut(event: KeyboardEvent): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }
  return event.key === "?" || event.key.toLowerCase() === "h";
}

function getTransformModeShortcut(key: string): TransformMode | null {
  const normalizedKey = key.toLowerCase();
  return TRANSFORM_MODE_OPTIONS.find((option) => option.shortcut.toLowerCase() === normalizedKey)?.value || null;
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

function previewInteractionHintLabel(hint: PreviewInteractionHint): string {
  const labels: Record<PreviewInteractionHint, string> = {
    "globe-rotate": "旋转地球",
    "globe-pan": "平移地球",
    "globe-tilt": "俯仰观察",
    "globe-zoom": "缩放地球",
    "view-fit": "正在适配模型",
    "view-focus-selected": "正在聚焦选中对象",
    "view-reset": "正在恢复默认视角",
    "view-earth-default": "正在恢复地球默认视角",
    "view-cancel-interaction": "已停止视角惯性",
    "transform-translate": "已切换到平移模式",
    "transform-rotate": "已切换到旋转模式",
    "transform-scale": "已切换到缩放模式"
  };
  return labels[hint];
}

function viewCommandInteractionHint(command: ViewCommand): PreviewInteractionHint | null {
  const hints: Record<Exclude<ViewCommand, null>, PreviewInteractionHint> = {
    fit: "view-fit",
    "focus-selected": "view-focus-selected",
    reset: "view-reset",
    "earth-default": "view-earth-default",
    "cancel-interaction": "view-cancel-interaction"
  };
  return command ? hints[command] : null;
}

function transformModeInteractionHint(mode: TransformMode): PreviewInteractionHint {
  const hints: Record<TransformMode, PreviewInteractionHint> = {
    translate: "transform-translate",
    rotate: "transform-rotate",
    scale: "transform-scale"
  };
  return hints[mode];
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

function formatPreviewNumberInput(
  value: string | number | undefined,
  info: { userTyping: boolean; input: string },
  precision = 4
): string {
  if (info.userTyping) {
    return info.input;
  }
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return "0";
  }
  return String(Number(numericValue.toFixed(precision)));
}
