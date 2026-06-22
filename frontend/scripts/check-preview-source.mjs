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
  { pattern: "preview-scene-tools", reason: "common scene actions should remain available when the inspector is collapsed" },
  { pattern: "CesiumIonAuthPlugin", reason: "Cesium ion authentication should remain wired through 3D Tiles" },
  { pattern: "cesium-ion://asset", reason: "real globe context should resolve through Cesium ion assets" }
];

const failures = [];

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
  const absolutePath = path.join(projectRoot, relativePath);
  const content = fs.readFileSync(absolutePath, "utf8");
  for (const check of forbiddenChecks) {
    if (content.includes(check.pattern)) {
      failures.push(`${relativePath}: found "${check.pattern}" (${check.reason})`);
    }
  }
}

const combinedSource = sourceTargets
  .map((relativePath) => fs.readFileSync(path.join(projectRoot, relativePath), "utf8"))
  .join("\n");

for (const check of requiredChecks) {
  if (!combinedSource.includes(check.pattern)) {
    failures.push(`missing "${check.pattern}" (${check.reason})`);
  }
}

const previewPage = fs.readFileSync(path.join(projectRoot, "src/pages/Preview/index.tsx"), "utf8");
if (!previewPage.includes("shouldDefaultCollapseInspector")) {
  failures.push("src/pages/Preview/index.tsx: medium-width preview should default to a collapsed inspector so the scene remains primary");
}
if (!previewPage.includes("shouldDefaultCollapseLayerPanel")) {
  failures.push("src/pages/Preview/index.tsx: narrow preview should default to a collapsed file/layer panel so the scene remains primary");
}
if (!previewPage.includes("setRightPanelCollapsed(shouldDefaultCollapseInspector())")) {
  failures.push("src/pages/Preview/index.tsx: file changes should re-apply the responsive inspector default");
}
if (!previewPage.includes("setLeftPanelCollapsed(shouldDefaultCollapseLayerPanel())")) {
  failures.push("src/pages/Preview/index.tsx: file changes should re-apply the responsive layer-panel default");
}
if (!previewPage.includes("rightPanelTouchedRef") || !previewPage.includes("leftPanelTouchedRef") || !previewPage.includes('window.addEventListener("resize"')) {
  failures.push("src/pages/Preview/index.tsx: inspector collapse should follow viewport defaults until the user manually toggles it");
}
if (!previewPage.includes("const showSceneShortcutTools = canEditScene && (rightPanelCollapsed || stageFullscreen)") || !previewPage.includes("{showSceneShortcutTools ? (")) {
  failures.push("src/pages/Preview/index.tsx: scene shortcut tools should appear when the inspector is collapsed or the stage is fullscreen");
}
if (!previewPage.includes("CanvasPointerIntent") || !previewPage.includes("handlePointerUp") || !previewPage.includes("hasPointerMoved(canvasPointerIntent, event)") || !previewPage.includes("event.button !== 0")) {
  failures.push("src/pages/Preview/index.tsx: canvas selection and surface placement should trigger only on primary-button taps, not on camera drags or secondary clicks");
}
if (!previewPage.includes("onPlacementCancel") || !previewPage.includes('aria-label="\u5730\u8868\u843d\u4f4d\u6a21\u5f0f\uff1a\u5355\u51fb\u5730\u7403\u8868\u9762\u5b8c\u6210\u843d\u4f4d\uff0cEsc \u9000\u51fa"') || !previewPage.includes("\u9000\u51fa\u5730\u8868\u843d\u4f4d")) {
  failures.push("src/pages/Preview/index.tsx: placement mode should keep a concise visible status, accessible instructions, and an in-scene exit");
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
if (!previewPage.includes("TRANSFORM_MODE_OPTIONS") || !sceneToolsBranch.includes("preview-scene-mode-switch") || !sceneToolsBranch.includes("setTransformMode(mode.value)") || !sceneToolsBranch.includes("transformMode === mode.value")) {
  failures.push("src/pages/Preview/index.tsx: scene shortcut tools should expose transform mode switching when the inspector is collapsed or fullscreen");
}
if (!previewPage.includes("options={TRANSFORM_MODE_OPTIONS.map(({ label, value }) => ({ label, value }))}")) {
  failures.push("src/pages/Preview/index.tsx: inspector and scene transform mode controls should share one option source");
}
if (!previewPage.includes("runtimeStatus.fps && runtimeStatus.fps > 0") || !previewPage.includes("const fpsLabel = fpsValue ? String(fpsValue) : null")) {
  failures.push("src/pages/Preview/index.tsx: FPS overlay should appear only after a real positive sample exists");
}
const rendererSelectorSource = fs.readFileSync(path.join(projectRoot, "src/components/preview/RendererSelector.tsx"), "utf8");
if (!rendererSelectorSource.includes('aria-label="渲染器"')) {
  failures.push("src/components/preview/RendererSelector.tsx: renderer selector aria label should stay concise");
}
if (previewPage.includes("statusLabel(runtimeStatus.status)")) {
  failures.push("src/pages/Preview/index.tsx: toolbar should not duplicate scene loading/error status that is already shown in-canvas");
}
if (!previewPage.includes('type PreviewSaveState = "idle" | "saving" | "saved" | "error"') || !previewPage.includes('setSaveState("saved")') || !previewPage.includes('window.setTimeout(() => setSaveState("idle"), 1600)') || !previewPage.includes('saved: "已保存"')) {
  failures.push("src/pages/Preview/index.tsx: preview edits should show a brief saved confirmation and then clear the toolbar status");
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
if (!previewPage.includes("setSelectedLayerKey((current) => (current && keys.includes(current) ? null : current))") || !previewPage.includes("if (selected?.visible)")) {
  failures.push("src/pages/Preview/index.tsx: hidden layers should not remain selected or keep rendering selection boxes");
}
if (!previewPage.includes("isObjectVisibleInHierarchy") || !previewPage.includes("isPickableObject(item.object)") || !previewPage.includes("isObjectVisibleInHierarchy(object) && !isHelperObject(object)")) {
  failures.push("src/pages/Preview/index.tsx: canvas ray picking should ignore hidden layers and transform/helper objects");
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

const previewStyles = fs.readFileSync(path.join(projectRoot, "src/styles.css"), "utf8");
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
