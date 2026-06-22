const baseUrl = process.env.C2S_API_BASE_URL || "http://localhost:4000";
const tilesTaskId = process.env.C2S_PREVIEW_3DTILES_TASK_ID || "preview-test-3dtiles";
const tilesResourceFileId = process.env.C2S_PREVIEW_3DTILES_RESOURCE_FILE_ID || "preview-test-3dtiles-model-glb";
const fbxTaskId = process.env.C2S_PREVIEW_FBX_TASK_ID || "preview-test-fbx";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  assert(response.ok, `${path} returned HTTP ${response.status}`);
  return response.json();
}

async function patchJson(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function assertPreviewTransform(file, label) {
  const state = file?.previewState;
  assert(!state || typeof state === "object", `${label} previewState should be an object or null`);
  if (!state) return;
  assert(state.sceneMode === "sphere", `${label} previewState should persist sphere scene mode`);
  assert(Array.isArray(state.hiddenLayerKeys), `${label} hiddenLayerKeys should be an array`);
  assert(typeof state.selectedLayerKey === "string" || state.selectedLayerKey === null || state.selectedLayerKey === undefined, `${label} selectedLayerKey should be string/null/undefined`);
  const transform = state.transform;
  assert(transform && typeof transform === "object", `${label} transform should be present`);
  for (const key of ["position", "rotation", "scale"]) {
    assert(Array.isArray(transform[key]) && transform[key].length === 3, `${label} transform.${key} should be a 3-number tuple`);
    assert(transform[key].every(Number.isFinite), `${label} transform.${key} should contain finite numbers`);
  }
  assert(transform.geo && typeof transform.geo === "object", `${label} transform.geo should be present`);
  assert(Number.isFinite(transform.geo.longitude), `${label} geo.longitude should be finite`);
  assert(Number.isFinite(transform.geo.latitude), `${label} geo.latitude should be finite`);
  assert(Number.isFinite(transform.geo.height), `${label} geo.height should be finite`);
}

function assertTilesetPreview(data, label) {
  assert(data, `${label} response is missing data`);
  assert(data.type === "3dtiles", `${label}: expected 3dtiles preview, received ${data.type}`);
  assert(data.file?.id !== tilesResourceFileId, `${label}: dependency resource id should not remain the active preview file`);
  assert(data.file?.fileName === "tileset.json", `${label}: expected tileset.json as active preview file, received ${data.file?.fileName || "none"}`);
  assert(data.url?.endsWith("/content/tileset.json"), `${label}: expected content URL to point at tileset.json, received ${data.url || "none"}`);
  const fileNames = Array.isArray(data.files) ? data.files.map((file) => file.fileName) : [];
  assert(fileNames.length === 1 && fileNames[0] === "tileset.json", `${label}: expected visible preview files to be only tileset.json, received ${fileNames.join(", ") || "none"}`);
  assertPreviewTransform(data.file, label);
}

const tilesByResourcePayload = await getJson(`/api/results/${encodeURIComponent(tilesTaskId)}/preview?fileId=${encodeURIComponent(tilesResourceFileId)}`);
assertTilesetPreview(tilesByResourcePayload.data, "3D Tiles resource-file lookup");

const tilesDefaultPayload = await getJson(`/api/results/${encodeURIComponent(tilesTaskId)}/preview`);
assertTilesetPreview(tilesDefaultPayload.data, "3D Tiles default lookup");

const fbxPayload = await getJson(`/api/results/${encodeURIComponent(fbxTaskId)}/preview`);
const fbxData = fbxPayload.data;
assert(fbxData, "FBX response is missing data");
assert(fbxData.type === "fbx", `Expected fbx preview, received ${fbxData.type}`);
assert(fbxData.file?.fileName?.toLowerCase().endsWith(".fbx"), `Expected active FBX file, received ${fbxData.file?.fileName || "none"}`);
assert(Array.isArray(fbxData.files) && fbxData.files.length === 1, "Expected FBX preview to expose one result file");
assert(fbxData.files[0].fileName === fbxData.file.fileName, "Expected FBX visible file to match active file");
assertPreviewTransform(fbxData.file, "FBX lookup");

const invalidFlatResponse = await patchJson(
  `/api/results/${encodeURIComponent(fbxTaskId)}/files/${encodeURIComponent(fbxData.file.id)}/preview-state`,
  { previewState: { sceneMode: "flat" } }
);
assert(invalidFlatResponse.status === 400, `Expected flat scene mode previewState to be rejected with 400, received ${invalidFlatResponse.status}`);

console.log("Preview API check passed: 3D Tiles resources resolve through tileset.json and model preview states are valid.");
