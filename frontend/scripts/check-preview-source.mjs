import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const sourceRoots = [
  "src/pages/Preview",
  "src/components/preview",
  "src/styles.css"
];
const sourceExtensions = new Set([".css", ".ts", ".tsx"]);

const forbiddenChecks = [
  { pattern: "\u5e73\u9762\u573a\u666f", reason: "flat scene toggle should not be visible in the preview UI" },
  { pattern: "\u6587\u4ef6\u4fe1\u606f", reason: "file information panel was intentionally removed from the preview inspector" },
  { pattern: "\u7cbe\u786e\u843d\u4f4d", reason: "geospatial placement fields should be grouped as position, not a redundant inspector subsection" },
  { pattern: "\u6a21\u578b\u8868\u9762", reason: "surface placement excludes the preview model itself, so the hint should not promise model-surface placement" },
  { pattern: "\u8868\u9762\u843d\u4f4d", reason: "placement mode should be labelled as ground-surface placement to avoid implying the preview model itself is a valid target" },
  { pattern: "\u6570\u636e\u4f53\u91cf", reason: "file size belongs in compact file metadata, not a bottom statistics strip" },
  { pattern: "\u4efb\u52a1\u72b6\u6001", reason: "task status belongs in task detail pages, not the focused preview surface" },
  { pattern: "preview-status-bar", reason: "bottom preview status bar was intentionally removed" },
  { pattern: "3D Tiles \u5df2\u63a5\u5165", reason: "debug 3D Tiles status text should not be user-visible" },
  { pattern: "\u4e0a\u4e0b\u6587 3D Tiles \u5df2\u52a0\u8f7d", reason: "debug context 3D Tiles status text should not be user-visible" },
  { pattern: "FPS\uff1a--", reason: "placeholder FPS should not be rendered" },
  { pattern: "Math.max(0, Math.round(runtimeStatus.fps ?? 0))", reason: "FPS should not show a misleading 0 before a real sample exists" },
  { pattern: "CanvasTexture", reason: "globe imagery must come from Cesium ion / 3D Tiles, not generated textures" },
  { pattern: "TextureLoader", reason: "globe imagery must come from Cesium ion / 3D Tiles, not ad-hoc texture loading" },
  { pattern: "document.querySelector", reason: "preview scene controls should use scoped refs instead of global DOM selectors" },
  { pattern: "surfaceNormalToTransformRotation", reason: "surface placement should keep WGS84/ENU up instead of tilting the model from tile triangle normals" },
  { pattern: "hit.face?.normal", reason: "surface placement should not persist mesh face normals as model orientation" },
  { pattern: "\u65e0\u5b50\u56fe\u5c42", reason: "leaf layers should use a non-interactive spacer instead of a disabled expand button" },
  { pattern: "modelTransform", reason: "scene view state should not duplicate persisted model transform state" },
  { pattern: "\u91cd\u7f6e\u6a21\u578b", reason: "reset action should be labelled as transform reset because it preserves the current geospatial placement" }
];

const requiredChecks = [
  { pattern: "\u9884\u89c8\u5f15\u64ce", reason: "preview engine selector should remain explicit" },
  { pattern: "Three.js \u6e32\u67d3\u5668", reason: "Three.js renderer selector should remain nested under the engine choice" },
  { pattern: "WebGPU", reason: "Three.js renderer choices should include WebGPU" },
  { pattern: "WebGL", reason: "Three.js renderer choices should include WebGL" },
  { pattern: "role=\"tree\"", reason: "model layers should keep tree semantics" },
  { pattern: "aria-expanded", reason: "model layers should support collapse/expand semantics" },
  { pattern: "\u5b9a\u4f4d\u56fe\u5c42", reason: "model layers should keep layer focus controls" },
  { pattern: "\u9690\u85cf\u56fe\u5c42", reason: "model layers should keep visibility controls" },
  { pattern: "\u663e\u793a\u56fe\u5c42", reason: "model layers should keep visibility controls" },
  { pattern: "preview-scene-fps", reason: "FPS should stay inside the scene viewport" },
  { pattern: "\u6027\u80fd\u4fdd\u62a4\u4e2d", reason: "low-FPS adaptive rendering should be visible to users instead of silently reducing quality" },
  { pattern: "preview-scene-tools", reason: "common scene actions should remain available when the inspector is collapsed" },
  { pattern: "CesiumIonAuthPlugin", reason: "Cesium ion authentication should remain wired through 3D Tiles" },
  { pattern: "cesium-ion://asset", reason: "real globe context should resolve through Cesium ion assets" }
];

const failures = [];

function normalizeSource(source) {
  return source.replace(/\r\n/g, "\n");
}

function readSource(relativePath) {
  return normalizeSource(fs.readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

function collectSourceFiles(relativePath) {
  const absolutePath = path.join(projectRoot, relativePath);
  const stat = fs.statSync(absolutePath);
  if (stat.isFile()) {
    return sourceExtensions.has(path.extname(absolutePath)) ? [relativePath] : [];
  }

  return fs.readdirSync(absolutePath, { withFileTypes: true })
    .flatMap((entry) => collectSourceFiles(path.join(relativePath, entry.name)));
}

const sourceTargets = sourceRoots.flatMap((target) => collectSourceFiles(target));

for (const relativePath of sourceTargets) {
  const content = readSource(relativePath);
  for (const check of forbiddenChecks) {
    if (content.includes(check.pattern)) {
      failures.push(`${relativePath}: found "${check.pattern}" (${check.reason})`);
    }
  }
}

const combinedSource = sourceTargets
  .map((relativePath) => readSource(relativePath))
  .join("\n");

for (const check of requiredChecks) {
  if (!combinedSource.includes(check.pattern)) {
    failures.push(`missing "${check.pattern}" (${check.reason})`);
  }
}

const previewPage = readSource("src/pages/Preview/index.tsx");
const previewStyles = readSource("src/styles.css");
if (!previewPage.includes("shouldDefaultCollapseInspector")) {
  failures.push("src/pages/Preview/index.tsx: medium-width preview should default to a collapsed inspector so the scene remains primary");
}
if (!previewPage.includes("shouldDefaultCollapseLayerPanel")) {
  failures.push("src/pages/Preview/index.tsx: narrow preview should default to a collapsed file/layer panel so the scene remains primary");
}
if (!previewPage.includes("commitRightPanelCollapsed(shouldDefaultCollapseInspector())")) {
  failures.push("src/pages/Preview/index.tsx: file changes should re-apply the responsive inspector default");
}
if (!previewPage.includes("commitLeftPanelCollapsed(shouldDefaultCollapseLayerPanel())")) {
  failures.push("src/pages/Preview/index.tsx: file changes should re-apply the responsive layer-panel default");
}
if (!previewPage.includes("rightPanelTouchedRef") || !previewPage.includes("leftPanelTouchedRef") || !previewPage.includes('window.addEventListener("resize"')) {
  failures.push("src/pages/Preview/index.tsx: inspector collapse should follow viewport defaults until the user manually toggles it");
}
if (
  !previewPage.includes("const leftPanelCollapsedRef = useRef(leftPanelCollapsed)") ||
  !previewPage.includes("const rightPanelCollapsedRef = useRef(rightPanelCollapsed)") ||
  !previewPage.includes("const commitLeftPanelCollapsed = useCallback((collapsed: boolean) => {") ||
  !previewPage.includes("if (leftPanelCollapsedRef.current === collapsed)") ||
  !previewPage.includes("const commitRightPanelCollapsed = useCallback((collapsed: boolean) => {") ||
  !previewPage.includes("if (rightPanelCollapsedRef.current === collapsed)")
) {
  failures.push("src/pages/Preview/index.tsx: responsive panel collapse sync should skip unchanged state before dispatching React updates");
}
if (!previewPage.includes("const showSceneShortcutTools = canEditScene && (rightPanelCollapsed || stageFullscreen)") || !previewPage.includes("{showSceneShortcutTools ? (")) {
  failures.push("src/pages/Preview/index.tsx: scene shortcut tools should appear when the inspector is collapsed or the stage is fullscreen");
}
const rightPanelResizeStart = previewPage.indexOf("const handleRightPanelResizeStart = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {");
const rightPanelResizeEnd = previewPage.indexOf("const handleSceneInfoChange", rightPanelResizeStart);
const rightPanelResizeBranch = rightPanelResizeStart >= 0 && rightPanelResizeEnd > rightPanelResizeStart
  ? previewPage.slice(rightPanelResizeStart, rightPanelResizeEnd)
  : "";
if (
  !previewPage.includes("rightPanelWidth?: number") ||
  !previewPage.includes("--preview-right-panel-width") ||
  !previewPage.includes('className="preview-inspector-resize-handle"') ||
  !rightPanelResizeBranch.includes("rightPanelTouchedRef.current = true") ||
  !rightPanelResizeBranch.includes("rightPanelResizeRef.current = {") ||
  !rightPanelResizeBranch.includes("clampPreviewRightPanelWidth(resizeState.startWidth + resizeState.startX - moveEvent.clientX)") ||
  !rightPanelResizeBranch.includes("schedulePreviewPanelWidthUpdate(rightPanelWidthUpdateRef, nextWidth, setRightPanelWidth)") ||
  !rightPanelResizeBranch.includes("writePreviewPanelLayoutPreferences({ rightPanelWidth: finalWidth })") ||
  !previewStyles.includes(".preview-inspector-resize-handle") ||
  !previewStyles.includes("left: 0;")
) {
  failures.push("src/pages/Preview/index.tsx: scene-control inspector should resize like the layer panel, with a left-edge drag handle that grows leftward, shrinks rightward, and persists width");
}
if (!previewPage.includes("CanvasPointerIntent") || !previewPage.includes("handlePointerUp") || !previewPage.includes("hasPointerMoved(canvasPointerIntent, event)") || !previewPage.includes("event.button !== 0")) {
  failures.push("src/pages/Preview/index.tsx: canvas selection and surface placement should trigger only on primary-button taps, not on camera drags or secondary clicks");
}
const canvasPointerDownStart = previewPage.indexOf("const handlePointerDown = (event: PointerEvent) => {");
const canvasPointerDownEnd = previewPage.indexOf("const handlePointerCancel", canvasPointerDownStart);
const canvasPointerDownBranch = canvasPointerDownStart >= 0 && canvasPointerDownEnd > canvasPointerDownStart
  ? previewPage.slice(canvasPointerDownStart, canvasPointerDownEnd)
  : "";
const canvasPointerUpStart = previewPage.indexOf("const handlePointerUp = (event: PointerEvent) => {");
const canvasPointerUpEnd = previewPage.indexOf("const handleCanvasDoubleClick", canvasPointerUpStart);
const canvasPointerUpBranch = canvasPointerUpStart >= 0 && canvasPointerUpEnd > canvasPointerUpStart
  ? previewPage.slice(canvasPointerUpStart, canvasPointerUpEnd)
  : "";
const canvasDoubleClickStart = previewPage.indexOf("const handleCanvasDoubleClick = (event: MouseEvent) => {");
const canvasDoubleClickEnd = previewPage.indexOf("const handlePreviewPointerMove", canvasDoubleClickStart);
const canvasDoubleClickBranch = canvasDoubleClickStart >= 0 && canvasDoubleClickEnd > canvasDoubleClickStart
  ? previewPage.slice(canvasDoubleClickStart, canvasDoubleClickEnd)
  : "";
const canvasPointerLeaveStart = previewPage.indexOf("const handlePreviewPointerLeave = (event: PointerEvent) => {");
const canvasPointerLeaveEnd = previewPage.indexOf("const handlePreviewWheel", canvasPointerLeaveStart);
const canvasPointerLeaveBranch = canvasPointerLeaveStart >= 0 && canvasPointerLeaveEnd > canvasPointerLeaveStart
  ? previewPage.slice(canvasPointerLeaveStart, canvasPointerLeaveEnd)
  : "";
if (
  !canvasPointerDownBranch.includes("isTransformControlPointerHit(event") ||
  !canvasPointerUpBranch.includes("isTransformControlPointerHit(event") ||
  !canvasDoubleClickBranch.includes("isTransformControlPointerHit(event")
) {
  failures.push("src/pages/Preview/index.tsx: canvas selection, placement, and double-click focus should not fire from TransformControls handles");
}
if (canvasPointerDownBranch.includes("markPreviewInteraction()")) {
  failures.push("src/pages/Preview/index.tsx: canvas pointer-down should only record tap intent and must not extend the interaction quality window");
}
if (!canvasPointerLeaveBranch.includes("event.buttons") || !canvasPointerLeaveBranch.includes("canvasPointerIntent = null")) {
  failures.push("src/pages/Preview/index.tsx: leaving the canvas while dragging should clear pending click-selection intent");
}
if (!previewPage.includes("onPlacementCancel") || !previewPage.includes('aria-label="\u5730\u8868\u843d\u4f4d\u6a21\u5f0f\uff1a\u5355\u51fb\u5730\u7403\u8868\u9762\u5b8c\u6210\u843d\u4f4d\uff0cEsc \u9000\u51fa"') || !previewPage.includes("\u9000\u51fa\u5730\u8868\u843d\u4f4d")) {
  failures.push("src/pages/Preview/index.tsx: placement mode should keep a concise visible status, accessible instructions, and an in-scene exit");
}
if (
  !previewPage.includes("const placementModeRef = useRef(placementMode)") ||
  !previewPage.includes("const commitPlacementMode = useCallback((enabled: boolean) => {") ||
  !previewPage.includes("if (placementModeRef.current === enabled)") ||
  !previewPage.includes("const togglePlacementMode = useCallback(() => {")
) {
  failures.push("src/pages/Preview/index.tsx: placement mode open/close paths should skip unchanged state before dispatching React updates");
}
if (previewPage.includes("setPlacementMode(false)") || previewPage.includes("setPlacementMode((value)")) {
  failures.push("src/pages/Preview/index.tsx: placement mode controls should route through the guarded commit/toggle helpers");
}
if (
  !previewPage.includes("const operationHelpOpenRef = useRef(operationHelpOpen)") ||
  !previewPage.includes("const commitOperationHelpOpen = useCallback((open: boolean) => {") ||
  !previewPage.includes("if (operationHelpOpenRef.current === open)") ||
  !previewPage.includes("const toggleOperationHelpOpen = useCallback(() => {")
) {
  failures.push("src/pages/Preview/index.tsx: operation help open/close paths should skip unchanged state before dispatching React updates");
}
if (previewPage.includes("setOperationHelpOpen(false)") || previewPage.includes("setOperationHelpOpen((value)")) {
  failures.push("src/pages/Preview/index.tsx: operation help controls should route through the guarded commit/toggle helpers");
}
if (!previewPage.includes("<strong>\u843d\u4f4d\u4e2d</strong>") || !previewPage.includes('aria-label="\u5730\u8868\u843d\u4f4d"')) {
  failures.push("src/pages/Preview/index.tsx: placement hint should use a state label distinct from the action button");
}
if (!previewPage.includes("aria-label=\"\u5730\u8868\u843d\u4f4d\"") || !previewPage.includes("\u5730\u8868\u843d\u4f4d")) {
  failures.push("src/pages/Preview/index.tsx: placement entry points should use the explicit ground-surface label");
}
if (!previewPage.includes('event.key !== "Escape"') || !previewPage.includes('window.addEventListener("keydown", handlePlacementKeyDown)') || !previewPage.includes("Esc \u9000\u51fa")) {
  failures.push("src/pages/Preview/index.tsx: placement mode should support and disclose Escape as a keyboard exit");
}
if (!previewPage.includes("stageFullscreen") || !previewPage.includes('document.addEventListener("fullscreenchange", syncStageFullscreen)') || !previewPage.includes("toggleStageFullscreen") || !previewPage.includes("document.exitFullscreen") || !previewPage.includes("FullscreenExitOutlined")) {
  failures.push("src/pages/Preview/index.tsx: fullscreen control should reflect current state and support exiting fullscreen");
}
if (
  !previewPage.includes("const stageFullscreenRef = useRef(stageFullscreen)") ||
  !previewPage.includes("const commitStageFullscreen = useCallback((fullscreen: boolean) => {") ||
  !previewPage.includes("if (stageFullscreenRef.current === fullscreen)") ||
  !previewPage.includes("commitStageFullscreen(document.fullscreenElement === stageRef.current)")
) {
  failures.push("src/pages/Preview/index.tsx: fullscreen state sync should skip unchanged state before dispatching React updates");
}
if (
  !previewPage.includes("const exitFullscreenRequest = document.exitFullscreen?.()") ||
  !previewPage.includes("void exitFullscreenRequest?.catch(() => {") ||
  !previewPage.includes("const requestFullscreenRequest = stage.requestFullscreen?.()") ||
  !previewPage.includes("void requestFullscreenRequest?.catch(() => {")
) {
  failures.push("src/pages/Preview/index.tsx: fullscreen enter/exit failures should be caught so rejected browser permissions do not surface as console errors");
}
const sceneToolsStart = previewPage.indexOf("preview-scene-tools");
const sceneToolsEnd = previewPage.indexOf("{fpsLabel", sceneToolsStart);
const sceneToolsBranch = sceneToolsStart >= 0 && sceneToolsEnd > sceneToolsStart
  ? previewPage.slice(sceneToolsStart, sceneToolsEnd)
  : "";
if (!sceneToolsBranch.includes("\u56de\u6b63\u59ff\u6001") || !sceneToolsBranch.includes("normalizeUprightTransform(transform, sceneMode)")) {
  failures.push("src/pages/Preview/index.tsx: collapsed scene shortcut tools should include upright reset for geospatial axis recovery");
}
if (!sceneToolsBranch.includes("\u91cd\u7f6e\u53d8\u6362") || !sceneToolsBranch.includes("normalizeResetTransform(transform, sceneMode)")) {
  failures.push("src/pages/Preview/index.tsx: collapsed scene shortcut tools should include transform reset for quick recovery after rotate/scale edits");
}
if (!previewPage.includes("TRANSFORM_MODE_OPTIONS") || !sceneToolsBranch.includes("preview-scene-mode-switch") || !sceneToolsBranch.includes("updateTransformMode(mode.value)") || !sceneToolsBranch.includes("transformMode === mode.value")) {
  failures.push("src/pages/Preview/index.tsx: scene shortcut tools should expose transform mode switching when the inspector is collapsed or fullscreen");
}
if (!previewPage.includes("options={TRANSFORM_MODE_OPTIONS.map(({ label, value }) => ({ label, value }))}")) {
  failures.push("src/pages/Preview/index.tsx: inspector and scene transform mode controls should share one option source");
}
const commitTransformModeStart = previewPage.indexOf("const commitTransformMode = useCallback((mode: TransformMode) => {");
const commitTransformModeEnd = previewPage.indexOf("const clearViewCommand", commitTransformModeStart);
const commitTransformModeBranch = commitTransformModeStart >= 0 && commitTransformModeEnd > commitTransformModeStart
  ? previewPage.slice(commitTransformModeStart, commitTransformModeEnd)
  : "";
const updateTransformModeStart = previewPage.indexOf("const updateTransformMode = useCallback((mode: TransformMode) => {");
const updateTransformModeEnd = previewPage.indexOf("const handleFocusLayer", updateTransformModeStart);
const updateTransformModeBranch = updateTransformModeStart >= 0 && updateTransformModeEnd > updateTransformModeStart
  ? previewPage.slice(updateTransformModeStart, updateTransformModeEnd)
  : "";
if (
  !previewPage.includes("const transformModeRef = useRef<TransformMode>(transformMode)") ||
  !commitTransformModeBranch.includes("if (transformModeRef.current === mode)") ||
  !commitTransformModeBranch.includes("return false;") ||
  !commitTransformModeBranch.includes("transformModeRef.current = mode") ||
  !commitTransformModeBranch.includes("setTransformMode(mode)") ||
  !commitTransformModeBranch.includes("return true;") ||
  !updateTransformModeBranch.includes("if (!commitTransformMode(mode))") ||
  updateTransformModeBranch.indexOf("if (!commitTransformMode(mode))") > updateTransformModeBranch.indexOf("showInteractionHint")
) {
  failures.push("src/pages/Preview/index.tsx: transform mode controls should use a ref-backed commit helper so shortcuts skip unchanged state and listener churn");
}
if (!previewPage.includes("runtimeStatus.fps && runtimeStatus.fps > 0") || !previewPage.includes("const fpsLabel = fpsValue ? String(fpsValue) : null")) {
  failures.push("src/pages/Preview/index.tsx: FPS overlay should appear only after a real positive sample exists");
}
if (
  !previewPage.includes('let lastFpsInfoPerformanceMode: PreviewPerformanceMode = "normal"') ||
  !previewPage.includes('const nextPerformanceMode: PreviewPerformanceMode = lowFpsActive ? "adaptive" : "normal"') ||
  !previewPage.includes("lastFpsInfoPerformanceMode === nextPerformanceMode") ||
  !previewPage.includes("performanceMode: nextPerformanceMode")
) {
  failures.push("src/pages/Preview/index.tsx: FPS status updates should throttle small value jitter without delaying adaptive performance mode changes");
}
if (
  previewPage.includes("attachCesiumLikeGlobeInteractions") ||
  previewPage.includes("normalizeGlobeWheelZoomDelta") ||
  previewPage.includes("normalizeGlobeDragZoomDelta") ||
  previewPage.includes("isGlobePanModifier") ||
  previewPage.includes("CESIUM_RIGHT_DRAG_ZOOM_SPEED") ||
  previewPage.includes("GLOBE_INERTIA_DECAY")
) {
  failures.push("src/pages/Preview/index.tsx: sphere preview should discard the previous custom Cesium-like mouse interaction implementation");
}
if (
  !previewPage.includes("configurePreviewGlobeControls(globeControls") ||
  !combinedSource.includes("function modifyPivotMesh") ||
  !combinedSource.includes("runtimeControls.adjustHeight = false") ||
  !combinedSource.includes("runtimeControls.adjustHeight = true") ||
  !combinedSource.includes("_cancelInteractionMomentum")
) {
  failures.push("src/pages/Preview: globe controls should use the threejs-render GlobeControls initialization and cancellation adapter");
}
if (
  !previewPage.includes("isNativeGlobeRotateModifier(event)") ||
  !previewPage.includes("isNativeGlobeRotateModifier(request)")
) {
  failures.push("src/pages/Preview/index.tsx: native Shift+left globe rotation should not also trigger hover or model selection work");
}
if (
  !previewPage.includes("拖动地球表面平移") ||
  !previewPage.includes("Shift + 左键") ||
  !previewPage.includes("按鼠标位置缩放") ||
  previewPage.includes("地球区域放大；Shift + 双击缩小") ||
  previewPage.includes("旋转 / 拖动地球")
) {
  failures.push("src/pages/Preview/index.tsx: sphere operation help should describe the native threejs-render globe controls instead of the previous custom controls");
}
const rendererSelectorSource = readSource("src/components/preview/RendererSelector.tsx");
if (!rendererSelectorSource.includes('aria-label="渲染器"')) {
  failures.push("src/components/preview/RendererSelector.tsx: renderer selector aria label should stay concise");
}
if (previewPage.includes("statusLabel(runtimeStatus.status)")) {
  failures.push("src/pages/Preview/index.tsx: toolbar should not duplicate scene loading/error status that is already shown in-canvas");
}
if (!previewPage.includes('type PreviewSaveState = "idle" | "saving" | "saved" | "error"') || !previewPage.includes('updateSaveState("saved")') || !previewPage.includes('window.setTimeout(() => updateSaveState("idle"), 1600)') || !previewPage.includes('saved: "已保存"')) {
  failures.push("src/pages/Preview/index.tsx: preview edits should show a brief saved confirmation and then clear the toolbar status");
}
if (!previewPage.includes('const saveStateRef = useRef<PreviewSaveState>("idle")') || !previewPage.includes("const updateSaveState = useCallback((nextState: PreviewSaveState) => {") || !previewPage.includes("if (saveStateRef.current === nextState)")) {
  failures.push("src/pages/Preview/index.tsx: preview save status should skip duplicate state dispatches during continuous edits");
}
if (!previewPage.includes('const placementFeedbackRef = useRef("")') || !previewPage.includes("if (placementFeedbackRef.current !== message)") || !previewPage.includes("placementFeedbackRef.current = \"\"")) {
  failures.push("src/pages/Preview/index.tsx: placement feedback should avoid duplicate text state updates while still refreshing its timer");
}
if (!previewPage.includes("normalizeResetTransform(transform, sceneMode)")) {
  failures.push("src/pages/Preview/index.tsx: reset transform should keep the current geospatial placement instead of teleporting to the default longitude/latitude");
}
if (!previewPage.includes("\u91cd\u7f6e\u53d8\u6362")) {
  failures.push("src/pages/Preview/index.tsx: transform reset action should use the precise label \"\u91cd\u7f6e\u53d8\u6362\"");
}
if (!previewPage.includes("position: transform.position")) {
  failures.push("src/pages/Preview/index.tsx: geospatial coordinate edits should keep position as a cached display value and let geo drive placement");
}
const scheduleTransformChangeStart = previewPage.indexOf("const scheduleTransformChange = (nextTransform: PreviewTransform, force = false) => {");
const scheduleTransformChangeEnd = previewPage.indexOf("const container = containerRef.current;", scheduleTransformChangeStart);
const scheduleTransformChangeBranch = scheduleTransformChangeStart >= 0 && scheduleTransformChangeEnd > scheduleTransformChangeStart
  ? previewPage.slice(scheduleTransformChangeStart, scheduleTransformChangeEnd)
  : "";
if (
  !scheduleTransformChangeBranch.includes("isSamePreviewTransform(latestSceneModeRef.current, latestTransformRef.current, nextTransform)") ||
  !scheduleTransformChangeBranch.includes("if (force && pendingTransformChange)") ||
  !scheduleTransformChangeBranch.includes("flushPendingTransformChange();") ||
  scheduleTransformChangeBranch.indexOf("isSamePreviewTransform") > scheduleTransformChangeBranch.indexOf("latestTransformRef.current = nextTransform")
) {
  failures.push("src/pages/Preview/index.tsx: transform control updates should skip unchanged transforms before scheduling throttled React/save work");
}
if (!previewPage.includes("setSelectedLayerKey((current) => (current && nextKeys.includes(current) ? null : current))") || !previewPage.includes("if (selected?.visible)")) {
  failures.push("src/pages/Preview/index.tsx: hidden layers should not remain selected or keep rendering selection boxes");
}
const updateHiddenLayersStart = previewPage.indexOf("const updateHiddenLayers = useCallback((keys: string[]) => {");
const updateHiddenLayersEnd = previewPage.indexOf("const updateLayerTree", updateHiddenLayersStart);
const updateHiddenLayersBranch = updateHiddenLayersStart >= 0 && updateHiddenLayersEnd > updateHiddenLayersStart
  ? previewPage.slice(updateHiddenLayersStart, updateHiddenLayersEnd)
  : "";
if (
  !updateHiddenLayersBranch.includes("const hiddenKeysUnchanged = isSamePreviewKeySet(hiddenLayerKeysRef.current, nextKeys)") ||
  !updateHiddenLayersBranch.includes("if (hiddenKeysUnchanged && !shouldClearSelection)") ||
  !updateHiddenLayersBranch.includes("if (!hiddenKeysUnchanged)") ||
  updateHiddenLayersBranch.indexOf("if (!hiddenKeysUnchanged)") > updateHiddenLayersBranch.indexOf("setHiddenLayerKeys(nextKeys)") ||
  !updateHiddenLayersBranch.includes("setSelectedLayerKey((current) => (current && nextKeys.includes(current) ? null : current))")
) {
  failures.push("src/pages/Preview/index.tsx: hidden-layer updates should skip unchanged hidden-key arrays while still clearing hidden selections");
}
const applyHiddenLayerVisibilityStart = previewPage.indexOf("const applyHiddenLayerVisibility = useCallback((keys: string[], options: { force?: boolean } = {}) => {");
const applyHiddenLayerVisibilityEnd = previewPage.indexOf("useEffect(() => {", applyHiddenLayerVisibilityStart);
const applyHiddenLayerVisibilityBranch = applyHiddenLayerVisibilityStart >= 0 && applyHiddenLayerVisibilityEnd > applyHiddenLayerVisibilityStart
  ? previewPage.slice(applyHiddenLayerVisibilityStart, applyHiddenLayerVisibilityEnd)
  : "";
const hiddenLayerEffectStart = previewPage.indexOf("useEffect(() => {\n    const visibilityChanged = applyHiddenLayerVisibility(hiddenLayerKeys);");
const hiddenLayerEffectEnd = previewPage.indexOf("useEffect(() => {\n    if (!viewCommand)", hiddenLayerEffectStart);
const hiddenLayerEffectBranch = hiddenLayerEffectStart >= 0 && hiddenLayerEffectEnd > hiddenLayerEffectStart
  ? previewPage.slice(hiddenLayerEffectStart, hiddenLayerEffectEnd)
  : "";
if (
  !previewPage.includes("const latestHiddenLayerKeysRef = useRef(hiddenLayerKeys)") ||
  !previewPage.includes("const hiddenLayerKeysSignatureRef = useRef<string | null>(null)") ||
  !applyHiddenLayerVisibilityBranch.includes("const nextSignature = normalizePreviewKeyList(keys).join(\"\\u0000\")") ||
  !applyHiddenLayerVisibilityBranch.includes("!options.force && hiddenLayerKeysSignatureRef.current === nextSignature") ||
  !applyHiddenLayerVisibilityBranch.includes("return false;") ||
  !applyHiddenLayerVisibilityBranch.includes("object.visible = nextVisible") ||
  !applyHiddenLayerVisibilityBranch.includes("layerVisibilityRevisionRef.current += 1") ||
  !hiddenLayerEffectBranch.includes("if (!visibilityChanged)") ||
  hiddenLayerEffectBranch.indexOf("if (!visibilityChanged)") > hiddenLayerEffectBranch.indexOf("notifySceneRefreshRef.current()") ||
  !previewPage.includes("applyHiddenLayerVisibility(latestHiddenLayerKeysRef.current, { force: true })")
) {
  failures.push("src/pages/Preview/index.tsx: Three scene hidden-layer visibility should skip unchanged hidden sets and force-apply current visibility after layer tree rebuilds");
}
if (
  !previewPage.includes("const expandedLayerKeysRef = useRef<string[]>([])") ||
  !previewPage.includes("const commitExpandedLayerKeys = useCallback((keys: string[]) => {") ||
  !previewPage.includes("if (isSamePreviewKeySet(expandedLayerKeysRef.current, nextKeys))") ||
  !previewPage.includes("expandedLayerKeysRef.current = nextKeys") ||
  !previewPage.includes("const current = expandedLayerKeysRef.current") ||
  !previewPage.includes("onClick={() => commitExpandedLayerKeys(collectExpandableLayerKeys(displayedMeshLayers, Number.POSITIVE_INFINITY, 500))") ||
  !previewPage.includes("onClick={() => commitExpandedLayerKeys([])")
) {
  failures.push("src/pages/Preview/index.tsx: mesh tree expand/collapse should route through guarded expanded-key commits");
}
if (previewPage.includes("setExpandedLayerKeys([])") || previewPage.includes("setExpandedLayerKeys((current)")) {
  failures.push("src/pages/Preview/index.tsx: mesh tree expand/collapse controls should not bypass the guarded expanded-key commit helper");
}
const clearPreviewSelectionStart = previewPage.indexOf("const clearPreviewSelection = useCallback(() => {");
const clearPreviewSelectionEnd = previewPage.indexOf("const clearScheduledInteractionHint", clearPreviewSelectionStart);
const clearPreviewSelectionBranch = clearPreviewSelectionStart >= 0 && clearPreviewSelectionEnd > clearPreviewSelectionStart
  ? previewPage.slice(clearPreviewSelectionStart, clearPreviewSelectionEnd)
  : "";
if (clearPreviewSelectionBranch.includes("setSelectedMaterialKey(null)")) {
  failures.push("src/pages/Preview/index.tsx: clear selection should avoid duplicate material state updates and use updateSelectedLayer(null)");
}
const handleInteractionHintStart = previewPage.indexOf("const handleInteractionHintChange = useCallback((hint: PreviewInteractionHint | null) => {");
const handleInteractionHintEnd = previewPage.indexOf("const showInteractionHint", handleInteractionHintStart);
const handleInteractionHintBranch = handleInteractionHintStart >= 0 && handleInteractionHintEnd > handleInteractionHintStart
  ? previewPage.slice(handleInteractionHintStart, handleInteractionHintEnd)
  : "";
const showInteractionHintStart = previewPage.indexOf("const showInteractionHint = useCallback((hint: PreviewInteractionHint");
const showInteractionHintEnd = previewPage.indexOf("const issueViewCommand", showInteractionHintStart);
const showInteractionHintBranch = showInteractionHintStart >= 0 && showInteractionHintEnd > showInteractionHintStart
  ? previewPage.slice(showInteractionHintStart, showInteractionHintEnd)
  : "";
if (
  !previewPage.includes("const interactionHintRef = useRef<PreviewInteractionHint | null>(null)") ||
  !handleInteractionHintBranch.includes("if (interactionHintRef.current === hint)") ||
  !handleInteractionHintBranch.includes("interactionHintRef.current = hint") ||
  !showInteractionHintBranch.includes("if (interactionHintRef.current !== hint)") ||
  !showInteractionHintBranch.includes("interactionHintRef.current = hint") ||
  !showInteractionHintBranch.includes("interactionHintRef.current = null")
) {
  failures.push("src/pages/Preview/index.tsx: high-frequency interaction hints should use a ref guard while manual hints keep their auto-clear timer");
}
const handleRendererFallbackStart = previewPage.indexOf("const handleRendererFallback = useCallback((message: string) => {");
const handleRendererFallbackEnd = previewPage.indexOf("const handleSwitchToThree", handleRendererFallbackStart);
const handleRendererFallbackBranch = handleRendererFallbackStart >= 0 && handleRendererFallbackEnd > handleRendererFallbackStart
  ? previewPage.slice(handleRendererFallbackStart, handleRendererFallbackEnd)
  : "";
const handleViewCommandHandledStart = previewPage.indexOf("const handleViewCommandHandled = useCallback((result?: ViewCommandHandledResult) => {");
const handleViewCommandHandledEnd = previewPage.indexOf("const handleRendererFallback", handleViewCommandHandledStart);
const handleViewCommandHandledBranch = handleViewCommandHandledStart >= 0 && handleViewCommandHandledEnd > handleViewCommandHandledStart
  ? previewPage.slice(handleViewCommandHandledStart, handleViewCommandHandledEnd)
  : "";
const previewStagePropsStart = previewPage.indexOf("<PreviewStage");
const previewStagePropsEnd = previewPage.indexOf("/>", previewStagePropsStart);
const previewStagePropsBranch = previewStagePropsStart >= 0 && previewStagePropsEnd > previewStagePropsStart
  ? previewPage.slice(previewStagePropsStart, previewStagePropsEnd)
  : "";
if (
  !handleViewCommandHandledBranch.includes("const handledCommand = viewCommandRef.current") ||
  !previewPage.includes("const handleSwitchToThree = useCallback(() => {") ||
  !handleRendererFallbackBranch.includes("current.backend === \"WebGL\"") ||
  !handleRendererFallbackBranch.includes("const current = sceneInfoRef.current") ||
  !handleRendererFallbackBranch.includes("return;") ||
  !handleRendererFallbackBranch.includes("commitSceneInfo({") ||
  !previewStagePropsBranch.includes("onViewCommandHandled={handleViewCommandHandled}") ||
  !previewStagePropsBranch.includes("onRendererFallback={handleRendererFallback}") ||
  !previewStagePropsBranch.includes("onSwitchToThree={handleSwitchToThree}")
) {
  failures.push("src/pages/Preview/index.tsx: preview stage callbacks should be stable and avoid duplicate fallback state updates");
}
const previewKeyDownStart = previewPage.indexOf("const handlePreviewKeyDown = (event: KeyboardEvent) => {");
const previewKeyDownEnd = previewPage.indexOf("window.addEventListener(\"keydown\", handlePreviewKeyDown)", previewKeyDownStart);
const previewKeyDownBranch = previewKeyDownStart >= 0 && previewKeyDownEnd > previewKeyDownStart
  ? previewPage.slice(previewKeyDownStart, previewKeyDownEnd)
  : "";
const escapeKeyBranchStart = previewKeyDownBranch.indexOf("if (event.key === \"Escape\")");
const escapeKeyBranchEnd = previewKeyDownBranch.indexOf("if (isOperationHelpShortcut(event)", escapeKeyBranchStart);
const escapeKeyBranch = escapeKeyBranchStart >= 0 && escapeKeyBranchEnd > escapeKeyBranchStart
  ? previewKeyDownBranch.slice(escapeKeyBranchStart, escapeKeyBranchEnd)
  : "";
const escapeCanEditIndex = escapeKeyBranch.indexOf("if (canEditScene)");
const escapeCancelIndex = escapeKeyBranch.indexOf("issueViewCommand(\"cancel-interaction\")", escapeCanEditIndex);
const escapeCanEditReturnIndex = escapeKeyBranch.indexOf("return;", escapeCancelIndex);
const escapeClearSelectionIndex = escapeKeyBranch.indexOf("clearPreviewSelection()", escapeCanEditIndex);
const previewKeyDownDependencyStart = previewPage.indexOf("}, [", previewKeyDownStart);
const previewKeyDownDependencyEnd = previewPage.indexOf("]);", previewKeyDownDependencyStart);
const previewKeyDownDependencyBranch = previewKeyDownDependencyStart >= 0 && previewKeyDownDependencyEnd > previewKeyDownDependencyStart
  ? previewPage.slice(previewKeyDownDependencyStart, previewKeyDownDependencyEnd)
  : "";
if (
  !previewPage.includes("interface ViewCommandHandledResult") ||
  !handleViewCommandHandledBranch.includes("handledCommand?.type !== \"cancel-interaction\"") ||
  !handleViewCommandHandledBranch.includes("if (result?.cancelledInteraction)") ||
  !handleViewCommandHandledBranch.includes("showInteractionHint(\"view-cancel-interaction\")") ||
  !handleViewCommandHandledBranch.includes("clearPreviewSelection()") ||
  !previewPage.includes("onViewCommandHandled({ cancelledInteraction })") ||
  !escapeKeyBranch.includes("if (!selectedLayerKeyRef.current && !selectedMaterialKeyRef.current)") ||
  previewKeyDownDependencyBranch.includes("selectedMaterialKey") ||
  escapeCanEditIndex < 0 ||
  escapeCancelIndex < 0 ||
  escapeCanEditReturnIndex < 0 ||
  escapeClearSelectionIndex < 0 ||
  escapeCanEditReturnIndex > escapeClearSelectionIndex
) {
  failures.push("src/pages/Preview/index.tsx: Escape should prioritize cancelling active globe/camera interaction before clearing the selected layer");
}
const issueViewCommandStart = previewPage.indexOf("const issueViewCommand = useCallback((type: ViewCommand) => {");
const issueViewCommandEnd = previewPage.indexOf("const updateTransformMode", issueViewCommandStart);
const issueViewCommandBranch = issueViewCommandStart >= 0 && issueViewCommandEnd > issueViewCommandStart
  ? previewPage.slice(issueViewCommandStart, issueViewCommandEnd)
  : "";
const clearViewCommandStart = previewPage.indexOf("const clearViewCommand = useCallback(() => {");
const clearViewCommandEnd = previewPage.indexOf("useEffect(() => {", clearViewCommandStart);
const clearViewCommandBranch = clearViewCommandStart >= 0 && clearViewCommandEnd > clearViewCommandStart
  ? previewPage.slice(clearViewCommandStart, clearViewCommandEnd)
  : "";
if (
  !previewPage.includes("const viewCommandRef = useRef<ViewCommandRequest | null>(null)") ||
  !previewPage.includes("signature: string;") ||
  !clearViewCommandBranch.includes("if (!viewCommandRef.current)") ||
  !clearViewCommandBranch.includes("viewCommandRef.current = null") ||
  !issueViewCommandBranch.includes("const nextViewCommandSignature = type === \"focus-selected\"") ||
  !issueViewCommandBranch.includes("`${type}:${selectedLayerKeyRef.current || \"scene\"}`") ||
  !issueViewCommandBranch.includes("? `${type}:${sceneMode}`") ||
  !issueViewCommandBranch.includes("const pendingViewCommand = viewCommandRef.current") ||
  !issueViewCommandBranch.includes("if (pendingViewCommand?.signature === nextViewCommandSignature)") ||
  !issueViewCommandBranch.includes("const hint = type === \"cancel-interaction\" ? null : viewCommandInteractionHint(type)") ||
  !issueViewCommandBranch.includes("revision: (viewCommandRef.current?.revision ?? 0) + 1") ||
  !issueViewCommandBranch.includes("signature: nextViewCommandSignature") ||
  !issueViewCommandBranch.includes("viewCommandRef.current = nextViewCommand") ||
  issueViewCommandBranch.indexOf("if (pendingViewCommand?.signature === nextViewCommandSignature)") > issueViewCommandBranch.indexOf("const hint = type === \"cancel-interaction\" ? null : viewCommandInteractionHint(type)") ||
  !handleViewCommandHandledBranch.includes("clearViewCommand();")
) {
  failures.push("src/pages/Preview/index.tsx: view commands should dedupe by target signature so repeated pending commands are skipped without dropping focus changes");
}
if (
  !previewPage.includes("const sceneInfoRef = useRef<SceneInfo>(initialSceneInfo)") ||
  !previewPage.includes("const commitSceneInfo = useCallback((next: SceneInfo) => {") ||
  !previewPage.includes("if (isSamePreviewSceneInfo(sceneInfoRef.current, next))") ||
  !previewPage.includes("sceneInfoRef.current = next") ||
  !previewPage.includes("const current = sceneInfoRef.current;\n    commitSceneInfo({")
) {
  failures.push("src/pages/Preview/index.tsx: repeated scene info updates should be filtered before dispatching React state");
}
const commitUnrealStatusStart = previewPage.indexOf("const commitUnrealStatus = useCallback((status: UnrealConnectionStatus, message = \"\") => {");
const commitUnrealStatusEnd = previewPage.indexOf("const commitLeftPanelCollapsed", commitUnrealStatusStart);
const commitUnrealStatusBranch = commitUnrealStatusStart >= 0 && commitUnrealStatusEnd > commitUnrealStatusStart
  ? previewPage.slice(commitUnrealStatusStart, commitUnrealStatusEnd)
  : "";
const handleUnrealStatusStart = previewPage.indexOf("const handleUnrealStatusChange = useCallback((status: UnrealConnectionStatus, message = \"\") => {");
const handleUnrealStatusEnd = previewPage.indexOf("const handleViewCommandHandled", handleUnrealStatusStart);
const handleUnrealStatusBranch = handleUnrealStatusStart >= 0 && handleUnrealStatusEnd > handleUnrealStatusStart
  ? previewPage.slice(handleUnrealStatusStart, handleUnrealStatusEnd)
  : "";
if (
  !previewPage.includes('const unrealStatusRef = useRef<UnrealConnectionStatus>("idle")') ||
  !previewPage.includes('const unrealMessageRef = useRef("")') ||
  !commitUnrealStatusBranch.includes("unrealStatusRef.current === status && unrealMessageRef.current === message") ||
  !commitUnrealStatusBranch.includes("unrealStatusRef.current = status") ||
  !commitUnrealStatusBranch.includes("unrealMessageRef.current = message") ||
  !handleUnrealStatusBranch.includes("commitUnrealStatus(status, message)")
) {
  failures.push("src/pages/Preview/index.tsx: repeated Unreal status updates should be filtered before dispatching React state");
}
if (
  !previewPage.includes("memo, useCallback") ||
  !previewPage.includes("const PreviewStage = memo(function PreviewStage") ||
  !previewPage.includes("const ThreeScene = memo(function ThreeScene")
) {
  failures.push("src/pages/Preview/index.tsx: preview stage components should stay memoized so FPS/status updates do not rerender the Three scene");
}
const previewStageMemoStart = previewPage.indexOf("function arePreviewStagePropsEqual(");
const previewStageMemoEnd = previewPage.indexOf("const PreviewStage = memo", previewStageMemoStart);
const previewStageMemoBranch = previewStageMemoStart >= 0 && previewStageMemoEnd > previewStageMemoStart
  ? previewPage.slice(previewStageMemoStart, previewStageMemoEnd)
  : "";
const threeSceneMemoStart = previewPage.indexOf("function areThreeScenePropsEqual(");
const threeSceneMemoEnd = previewPage.indexOf("const ThreeScene = memo", threeSceneMemoStart);
const threeSceneMemoBranch = threeSceneMemoStart >= 0 && threeSceneMemoEnd > threeSceneMemoStart
  ? previewPage.slice(threeSceneMemoStart, threeSceneMemoEnd)
  : "";
const syncSceneViewStateStart = previewPage.indexOf("function syncSceneViewState()");
const syncSceneViewStateEnd = previewPage.indexOf("function clearSelectionBox", syncSceneViewStateStart);
const syncSceneViewStateBranch = syncSceneViewStateStart >= 0 && syncSceneViewStateEnd > syncSceneViewStateStart
  ? previewPage.slice(syncSceneViewStateStart, syncSceneViewStateEnd)
  : "";
if (
  !previewStageMemoBranch.includes("next.activeEngine !== \"unreal\" || previousSceneViewState === nextSceneViewState") ||
  !threeSceneMemoBranch.includes("sceneViewState: _previousSceneViewState") ||
  !threeSceneMemoBranch.includes("sceneViewState: _nextSceneViewState") ||
  !syncSceneViewStateBranch.includes("latestSceneViewStateRef.current = nextState") ||
  syncSceneViewStateBranch.indexOf("latestSceneViewStateRef.current = nextState") > syncSceneViewStateBranch.indexOf("onSceneViewStateChange(nextState)")
) {
  failures.push("src/pages/Preview/index.tsx: Three camera state feedback should update internal refs without rerendering the Three scene");
}
const previewSettingsSource = readSource("src/hooks/usePreviewSettings.ts");
if (
  !previewSettingsSource.includes("window.localStorage.getItem(key) === value") ||
  !previewSettingsSource.includes("setPreviewEngineState((current) => (current === engine ? current : engine))") ||
  !previewSettingsSource.includes("setThreeRendererState((current) => (current === renderer ? current : renderer))")
) {
  failures.push("src/hooks/usePreviewSettings.ts: preview setting updates should skip unchanged state and storage writes");
}
const engineSwitchingEffectStart = previewPage.indexOf("const nextSwitchSignature = `${previewEngine}:${threeRenderer}`;");
const engineSwitchingEffectEnd = previewPage.indexOf("const markDirty = useCallback", engineSwitchingEffectStart);
const engineSwitchingEffectBranch = engineSwitchingEffectStart >= 0 && engineSwitchingEffectEnd > engineSwitchingEffectStart
  ? previewPage.slice(engineSwitchingEffectStart, engineSwitchingEffectEnd)
  : "";
if (
  !previewPage.includes("const previewEngineSwitchSignatureRef = useRef(`${previewEngine}:${threeRenderer}`)") ||
  !engineSwitchingEffectBranch.includes("if (previewEngineSwitchSignatureRef.current === nextSwitchSignature)") ||
  !engineSwitchingEffectBranch.includes("return;") ||
  !engineSwitchingEffectBranch.includes("previewEngineSwitchSignatureRef.current = nextSwitchSignature") ||
  engineSwitchingEffectBranch.indexOf("if (previewEngineSwitchSignatureRef.current === nextSwitchSignature)") > engineSwitchingEffectBranch.indexOf("setEngineSwitching(true)")
) {
  failures.push("src/pages/Preview/index.tsx: preview engine switch mask should not flash on initial render or unchanged renderer settings");
}
if (
  !previewPage.includes("createWebGPUPreviewRenderer(container, rendererPreference") ||
  !previewPage.includes("const renderer = new WebGPURenderer({") ||
  !previewPage.includes("forceWebGL") ||
  !previewPage.includes("await renderer.init()") ||
  !previewPage.includes("highPrecision")
) {
  failures.push("src/pages/Preview/index.tsx: online preview should use the threejs-render WebGPURenderer initialization path");
}
if (
  !previewPage.includes("createPreviewAtmosphereRenderer") ||
  !combinedSource.includes("aerialPerspective") ||
  !combinedSource.includes("AtmosphereContext")
) {
  failures.push("src/pages/Preview: online sphere preview should keep the threejs-render atmosphere earth rendering path");
}
const viewOptionsWriterStart = previewPage.indexOf("function writePreviewViewOptions(");
const viewOptionsWriterEnd = previewPage.indexOf("function readPreviewSidePanelPreferences", viewOptionsWriterStart);
const viewOptionsWriterBranch = viewOptionsWriterStart >= 0 && viewOptionsWriterEnd > viewOptionsWriterStart
  ? previewPage.slice(viewOptionsWriterStart, viewOptionsWriterEnd)
  : "";
const sidePanelWriterStart = previewPage.indexOf("function writePreviewSidePanelPreferences(");
const sidePanelWriterEnd = previewPage.indexOf("function getInitialPreviewSideTab", sidePanelWriterStart);
const sidePanelWriterBranch = sidePanelWriterStart >= 0 && sidePanelWriterEnd > sidePanelWriterStart
  ? previewPage.slice(sidePanelWriterStart, sidePanelWriterEnd)
  : "";
const panelLayoutWriterStart = previewPage.indexOf("function writePreviewPanelLayoutPreferences(");
const panelLayoutWriterEnd = previewPage.indexOf("function getInitialPreviewLeftPanelWidth", panelLayoutWriterStart);
const panelLayoutWriterBranch = panelLayoutWriterStart >= 0 && panelLayoutWriterEnd > panelLayoutWriterStart
  ? previewPage.slice(panelLayoutWriterStart, panelLayoutWriterEnd)
  : "";
const panelWidthUpdateStart = previewPage.indexOf("function schedulePreviewPanelWidthUpdate(");
const panelWidthUpdateEnd = previewPage.indexOf("function cancelPreviewPanelWidthUpdate", panelWidthUpdateStart);
const panelWidthUpdateBranch = panelWidthUpdateStart >= 0 && panelWidthUpdateEnd > panelWidthUpdateStart
  ? previewPage.slice(panelWidthUpdateStart, panelWidthUpdateEnd)
  : "";
const meshViewModeHandlerStart = previewPage.indexOf("const handleMeshViewModeChange = useCallback((mode: PreviewMeshViewMode) => {");
const meshViewModeHandlerEnd = previewPage.indexOf("const handleMaterialSelect", meshViewModeHandlerStart);
const meshViewModeHandlerBranch = meshViewModeHandlerStart >= 0 && meshViewModeHandlerEnd > meshViewModeHandlerStart
  ? previewPage.slice(meshViewModeHandlerStart, meshViewModeHandlerEnd)
  : "";
if (
  !panelLayoutWriterBranch.includes("window.localStorage.getItem(PREVIEW_PANEL_LAYOUT_STORAGE_KEY) === nextValue") ||
  !panelWidthUpdateBranch.includes("setWidth((current) => (current === nextWidth ? current : nextWidth))") ||
  !viewOptionsWriterBranch.includes("window.localStorage.getItem(PREVIEW_VIEW_OPTIONS_STORAGE_KEY) === nextValue") ||
  !sidePanelWriterBranch.includes("window.localStorage.getItem(PREVIEW_SIDE_PANEL_STORAGE_KEY) === nextValue") ||
  !previewPage.includes("const meshViewModeRef = useRef<PreviewMeshViewMode>(meshViewMode)") ||
  !meshViewModeHandlerBranch.includes("if (mode === meshViewModeRef.current)") ||
  !meshViewModeHandlerBranch.includes("meshViewModeRef.current = mode")
) {
  failures.push("src/pages/Preview/index.tsx: preview UI preferences should skip unchanged state and localStorage writes");
}
const updateSelectedLayerStart = previewPage.indexOf("const updateSelectedLayer = useCallback((key: string | null) => {");
const updateSelectedLayerEnd = previewPage.indexOf("const clearPreviewSelection", updateSelectedLayerStart);
const updateSelectedLayerBranch = updateSelectedLayerStart >= 0 && updateSelectedLayerEnd > updateSelectedLayerStart
  ? previewPage.slice(updateSelectedLayerStart, updateSelectedLayerEnd)
  : "";
const commitSelectedMaterialStart = previewPage.indexOf("const commitSelectedMaterialKey = useCallback((key: string | null) => {");
const commitSelectedMaterialEnd = previewPage.indexOf("const updateSelectedLayer", commitSelectedMaterialStart);
const commitSelectedMaterialBranch = commitSelectedMaterialStart >= 0 && commitSelectedMaterialEnd > commitSelectedMaterialStart
  ? previewPage.slice(commitSelectedMaterialStart, commitSelectedMaterialEnd)
  : "";
if (
  !previewPage.includes("selectedMaterialKeyRef") ||
  !commitSelectedMaterialBranch.includes("selectedMaterialKeyRef.current = key") ||
  !updateSelectedLayerBranch.includes("if (!key)") ||
  !updateSelectedLayerBranch.includes("commitSelectedMaterialKey(null)")
) {
  failures.push("src/pages/Preview/index.tsx: empty canvas selection should avoid enqueueing duplicate material clears");
}
if (previewPage.includes("selectedMaterialKeyRef.current = next")) {
  failures.push("src/pages/Preview/index.tsx: material selection ref should be synchronized through commitSelectedMaterialKey, not setState updaters");
}
const materialFocusStart = previewPage.indexOf("const handleMaterialFocus = useCallback((material: MaterialNode) => {");
const materialFocusEnd = previewPage.indexOf("const expandLayerPanel", materialFocusStart);
const materialFocusBranch = materialFocusStart >= 0 && materialFocusEnd > materialFocusStart
  ? previewPage.slice(materialFocusStart, materialFocusEnd)
  : "";
if (!materialFocusBranch.includes("commitSelectedMaterialKey(material.key)") || materialFocusBranch.includes("? null : material.key")) {
  failures.push("src/pages/Preview/index.tsx: double-clicking a material should keep it selected while focusing its layer");
}
const buildLayerTreeStart = previewPage.indexOf("function buildLayerTree(");
const buildLayerTreeEnd = previewPage.indexOf("function collectMaterialList", buildLayerTreeStart);
const buildLayerTreeBranch = buildLayerTreeStart >= 0 && buildLayerTreeEnd > buildLayerTreeStart
  ? previewPage.slice(buildLayerTreeStart, buildLayerTreeEnd)
  : "";
if (buildLayerTreeBranch.includes("count > 500")) {
  failures.push("src/pages/Preview/index.tsx: ordinary model layer tree should not truncate the mesh list at 500 objects");
}
if (!previewPage.includes("isObjectVisibleInHierarchy") || !previewPage.includes("isPickableObject(item.object)") || !previewPage.includes("isObjectVisibleInHierarchy(object) && !isHelperObject(object)")) {
  failures.push("src/pages/Preview/index.tsx: canvas ray picking should ignore hidden layers and transform/helper objects");
}
const canvasHoverRequestStart = previewPage.indexOf("interface CanvasHoverRequest");
const canvasHoverRequestEnd = previewPage.indexOf("}", canvasHoverRequestStart);
const canvasHoverRequestBranch = canvasHoverRequestStart >= 0 && canvasHoverRequestEnd > canvasHoverRequestStart
  ? previewPage.slice(canvasHoverRequestStart, canvasHoverRequestEnd)
  : "";
if (!canvasHoverRequestBranch.includes("shiftKey: boolean") || canvasHoverRequestBranch.includes("event:")) {
  failures.push("src/pages/Preview/index.tsx: hover picking should store a lightweight pointer snapshot instead of retaining PointerEvent across frames");
}
const canvasHoverScheduleStart = previewPage.indexOf("const scheduleCanvasHoverPick = (event: PointerEvent) => {");
const canvasHoverScheduleEnd = previewPage.indexOf("const handlePointerDown", canvasHoverScheduleStart);
const canvasHoverScheduleBranch = canvasHoverScheduleStart >= 0 && canvasHoverScheduleEnd > canvasHoverScheduleStart
  ? previewPage.slice(canvasHoverScheduleStart, canvasHoverScheduleEnd)
  : "";
const canvasWheelStart = previewPage.indexOf("const handlePreviewWheel = (event: WheelEvent) => {");
const canvasWheelEnd = previewPage.indexOf('renderer.domElement.addEventListener("pointerdown"', canvasWheelStart);
const canvasWheelBranch = canvasWheelStart >= 0 && canvasWheelEnd > canvasWheelStart
  ? previewPage.slice(canvasWheelStart, canvasWheelEnd)
  : "";
if (
  !previewPage.includes("const shouldThrottleCanvasHoverPick = (clientX: number, clientY: number, now: number)") ||
  canvasHoverScheduleBranch.indexOf("if (shouldThrottleCanvasHoverPick(event.clientX, event.clientY, now) && !pendingCanvasHoverFrame)") < 0 ||
  canvasHoverScheduleBranch.indexOf("pendingCanvasHoverRequest = {") < 0 ||
  canvasHoverScheduleBranch.indexOf("if (shouldThrottleCanvasHoverPick(event.clientX, event.clientY, now) && !pendingCanvasHoverFrame)") >
    canvasHoverScheduleBranch.indexOf("pendingCanvasHoverRequest = {") ||
  canvasHoverScheduleBranch.indexOf("if (shouldThrottleCanvasHoverPick(request.clientX, request.clientY, now))") < 0 ||
  canvasHoverScheduleBranch.indexOf("lastCanvasHoverPickTime = now") < 0 ||
  canvasHoverScheduleBranch.indexOf("isTransformControlPointerHit(request") < 0 ||
  canvasHoverScheduleBranch.indexOf("if (shouldThrottleCanvasHoverPick(request.clientX, request.clientY, now))") >
    canvasHoverScheduleBranch.indexOf("isTransformControlPointerHit(request") ||
  canvasHoverScheduleBranch.indexOf("lastCanvasHoverPickTime = now") >
    canvasHoverScheduleBranch.indexOf("isTransformControlPointerHit(request")
) {
  failures.push("src/pages/Preview/index.tsx: hover picking should throttle tiny pointer samples before scheduling work and before transform-control helper raycasts");
}
if (
  !previewPage.includes("if (!pendingCanvasHoverRequest && !pendingCanvasHoverFrame && !canvasHoverCursorActive)") ||
  !previewPage.includes('if (canvasHoverCursorActive && renderer.domElement.style.cursor === "pointer")')
) {
  failures.push("src/pages/Preview/index.tsx: canvas hover cursor updates should no-op when there is no pending work or visible cursor change");
}
if (
  !previewPage.includes("function hasNonZeroWheelDelta(event: WheelEvent): boolean") ||
  !canvasWheelBranch.includes("if (!hasNonZeroWheelDelta(event))") ||
  canvasWheelBranch.indexOf("if (!hasNonZeroWheelDelta(event))") > canvasWheelBranch.indexOf("markPreviewInteraction()")
) {
  failures.push("src/pages/Preview/index.tsx: zero-delta canvas wheel samples should not cancel hover picks or extend the interaction quality window");
}
if (!previewPage.includes("getVisibleObjectBox") || !previewPage.includes("new THREE.Box3Helper(selectedBox") || !previewPage.includes("isObjectVisibleInHierarchy(child)")) {
  failures.push("src/pages/Preview/index.tsx: focus bounds and selection boxes should ignore hidden layer geometry");
}
if (!previewPage.includes('visibilityState === "hidden" ? " is-hidden" : ""') || !previewPage.includes("disabled={!checked}")) {
  failures.push("src/pages/Preview/index.tsx: hidden layer rows should disable selection and focus while keeping visibility toggles available");
}
const layerVisibilityStart = previewPage.indexOf('className="preview-layer-visibility"');
const layerVisibilityEnd = previewPage.indexOf("<NodeIndexOutlined />", layerVisibilityStart);
const layerVisibilityBranch = layerVisibilityStart >= 0 && layerVisibilityEnd > layerVisibilityStart
  ? previewPage.slice(layerVisibilityStart, layerVisibilityEnd)
  : "";
if (!layerVisibilityBranch.includes('role="switch"') || layerVisibilityBranch.includes('type="checkbox"')) {
  failures.push("src/pages/Preview/index.tsx: layer visibility should be an explicit icon switch button, not a hidden checkbox masquerading as a tool");
}
if (!previewPage.includes("getLayerVisibilityState") || !previewPage.includes('aria-checked={visibilityState === "partial" ? "mixed" : fullyVisible}') || !previewPage.includes('visibilityState === "partial" ? " is-partial" : ""')) {
  failures.push("src/pages/Preview/index.tsx: parent layers should expose partial visibility with a mixed state");
}
if (!previewPage.includes("setSearchParams({ fileId: payload.file.id }, { replace: true })")) {
  failures.push("src/pages/Preview/index.tsx: preview URL should replace mapped dependency file ids with the active preview file id");
}
if (!previewPage.includes('object.type === "Line" || object.type === "LineSegments"')) {
  failures.push("src/pages/Preview/index.tsx: TransformControls helper guide lines should stay hidden so they are not mistaken for model axes");
}
if (!previewPage.includes("getEastNorthUpFrame(position") || !previewPage.includes("three-geospatial ENU uses Z as local Up")) {
  failures.push("src/pages/Preview/index.tsx: geospatial placement must keep the model local Z axis aligned to ENU up");
}
if (!previewPage.includes("function hasNativeGeospatialPlacement") || !previewPage.includes('return type === "3dtiles"') || !previewPage.includes("sceneMode === \"sphere\" && !hasNativeGeospatialPlacement(type)")) {
  failures.push("src/pages/Preview/index.tsx: 3D Tiles should preserve native tileset georeferencing instead of being geospatially re-positioned a second time");
}
if (!previewPage.includes("normalizeTransformForScene") || !previewPage.includes("normalizeAngle(transform.rotation[0])") || !previewPage.includes("rotation: [\n      normalizeAngle(transform.rotation[0]),\n      0,\n      0")) {
  failures.push("src/pages/Preview/index.tsx: sphere preview should keep only azimuth so the model Z axis stays perpendicular to local ground");
}
if (!previewPage.includes("updateTransformControlAxisVisibility") || !previewPage.includes("controls.showX = !shouldLockToLocalUp") || !previewPage.includes("showRotation && isGeospatial") || !previewPage.includes("<ControlScalar") || previewPage.includes("disabledIndexes")) {
  failures.push("src/pages/Preview/index.tsx: sphere rotation controls should expose one azimuth field and only the local Up transform axis");
}
if (!previewPage.includes("setObjectWorldMatrix(transformHandle, matrix)") || !previewPage.includes("localMatrix.premultiply(object.parent.matrixWorld.clone().invert())")) {
  failures.push("src/pages/Preview/index.tsx: geospatial transform handles should convert ENU world frames into parent-local matrices");
}
const singleFileBranchStart = previewPage.indexOf("if (files.length === 1)");
const singleFileBranchEnd = previewPage.indexOf("return (\n    <div className=\"preview-file-list\">", singleFileBranchStart + 1);
const singleFileBranch = singleFileBranchStart >= 0 && singleFileBranchEnd > singleFileBranchStart
  ? previewPage.slice(singleFileBranchStart, singleFileBranchEnd)
  : "";
if (
  !singleFileBranch.includes("preview-file-row is-static is-compact") ||
  !singleFileBranch.includes("previewTypeLabel(file.fileType)") ||
  !singleFileBranch.includes("formatSize(file.fileSize)")
) {
  failures.push("src/pages/Preview/index.tsx: single-file result rows should keep compact type and size metadata");
}

if (!previewStyles.includes("grid-template-rows: minmax(430px, 64vh) auto auto")) {
  failures.push("src/styles.css: mobile preview workspace should place the scene first with a usable viewport height");
}
if (!previewStyles.includes(".preview-workspace .preview-stage,\n  .preview-workspace.is-right-collapsed .preview-stage")) {
  failures.push("src/styles.css: mobile preview stage should remain first even when side panels are collapsed");
}
if (!previewStyles.includes("calc(100% - 78px)") || !previewStyles.includes("flex-wrap: wrap")) {
  failures.push("src/styles.css: scene shortcut tools should wrap inside narrow viewports");
}
if (!previewStyles.includes("max-width: min(342px, calc(100% - 78px))") || !previewStyles.includes("max-width: min(186px, calc(100% - 64px))")) {
  failures.push("src/styles.css: scene shortcut tools should keep compact width caps on desktop and mobile");
}
if (!previewStyles.includes(".preview-scene-mode-switch")) {
  failures.push("src/styles.css: scene transform mode switch should be visually grouped inside shortcut tools");
}
if (!previewStyles.includes(".preview-layer-row.is-hidden") || !previewStyles.includes(".preview-layer-name-button:disabled")) {
  failures.push("src/styles.css: hidden layer rows should look inactive without disabling the visibility toggle");
}
if (!previewStyles.includes(".preview-layer-row.is-partial")) {
  failures.push("src/styles.css: partially visible parent layers should have a distinct middle state");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Preview source check passed: removed UI/debug/texture regressions are absent.");
}
