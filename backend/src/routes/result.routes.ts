import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import AdmZip from "adm-zip";
import {
  deleteResults,
  getResultFile,
  getResultFileBrowserPage,
  getResultFiles,
  getTask,
  updateResultFilePreviewState
} from "../services/task.service";
import { assertPathInside, resultOutputPath } from "../services/file.service";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/httpError";

const router = Router();

type ResultFilePayload = ReturnType<typeof getResultFiles>[number];
type TilesetResourceCache = Map<string, Set<string>>;

interface ArchiveFile {
  fileName: string;
  filePath: string;
}

const previewDependencyExtensions = new Set([
  ".avif",
  ".bin",
  ".b3dm",
  ".basis",
  ".bmp",
  ".cmpt",
  ".dds",
  ".dae",
  ".exr",
  ".fbx",
  ".gif",
  ".glb",
  ".gltf",
  ".hdr",
  ".i3dm",
  ".json",
  ".jpeg",
  ".jpg",
  ".ktx2",
  ".mtl",
  ".obj",
  ".ply",
  ".png",
  ".pnts",
  ".stl",
  ".subtree",
  ".tga",
  ".tif",
  ".tiff",
  ".usd",
  ".usda",
  ".usdc",
  ".usdz",
  ".webp"
]);

const previewModelTypes = new Set(["fbx", "gltf", "obj", "dae", "stl", "ply", "usd", "3dtiles"]);

router.get(
  "/:taskId/files",
  asyncHandler(async (req, res) => {
    if (hasBrowserPageQuery(req.query)) {
      res.json({
        data: getResultFileBrowserPage(req.params.taskId, {
          folder: stringQuery(req.query.folder),
          search: stringQuery(req.query.search),
          page: positiveIntegerQuery(req.query.page),
          pageSize: positiveIntegerQuery(req.query.pageSize)
        })
      });
      return;
    }

    res.json({ data: getResultFiles(req.params.taskId) });
  })
);

router.get(
  "/:taskId/download",
  asyncHandler(async (req, res, next) => {
    const task = getTask(req.params.taskId);
    if (!task.downloadUrl && task.resultSize <= 0) {
      throw new HttpError(404, "暂无可下载成果文件");
    }

    const files = getArchiveFiles(req.params.taskId);
    if (!files.length) {
      throw new HttpError(404, "暂无可下载成果文件");
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2s-results-"));
    const archiveName = `${safeDownloadName(task.taskName || task.id)}-成果.zip`;
    const archivePath = path.join(tempDir, archiveName);
    const archive = new AdmZip();
    const usedNames = new Set<string>();

    files.forEach((file) => {
      const entryName = uniqueArchiveEntryName(normalizeArchiveEntryName(file.fileName), usedNames);
      archive.addLocalFile(
        file.filePath,
        path.posix.dirname(entryName) === "." ? "" : path.posix.dirname(entryName),
        path.posix.basename(entryName)
      );
    });
    archive.writeZip(archivePath);

    res.type("application/zip");
    res.download(archivePath, archiveName, (error) => {
      fs.rm(tempDir, { recursive: true, force: true }, () => undefined);
      if (error && !res.headersSent) {
        next(error);
      }
    });
  })
);

router.get(
  "/:taskId/download/:fileId",
  asyncHandler(async (req, res) => {
    const file = getResultFile(req.params.taskId, req.params.fileId);
    if (!file.downloadable) {
      throw new HttpError(404, "该成果文件不可下载");
    }
    if (!fs.existsSync(file.filePath)) {
      throw new HttpError(404, "成果文件不存在或已被删除");
    }
    res.download(file.filePath, file.fileName);
  })
);

router.get(
  "/:taskId/content/*",
  asyncHandler(async (req, res) => {
    const requestedName = normalizeContentFileName(req.params[0] || "");
    const files = getResultFiles(req.params.taskId);
    const file = files.find(
      (item) => normalizeContentFileName(item.fileName) === requestedName
    );
    if (!file || !isPreviewContentResource(file, files) || !fs.existsSync(file.filePath)) {
      throw new HttpError(404, "预览资源不存在或已被删除");
    }

    assertPathInside(resultOutputPath(req.params.taskId), file.filePath);
    res.type(file.fileName);
    res.sendFile(file.filePath);
  })
);

router.patch(
  "/:taskId/files/:fileId/preview-state",
  asyncHandler(async (req, res) => {
    const state = normalizePreviewState(req.body?.previewState ?? null);
    const file = updateResultFilePreviewState(req.params.taskId, req.params.fileId, state);
    res.json({ data: file });
  })
);

router.get(
  "/:taskId/preview",
  asyncHandler(async (req, res) => {
    const task = getTask(req.params.taskId);
    const files = getResultFiles(req.params.taskId);
    const requestedFileId = typeof req.query.fileId === "string" ? req.query.fileId : null;
    const requestedFile = requestedFileId
      ? files.find((file) => file.id === requestedFileId)
      : undefined;

    if (requestedFileId && !requestedFile) {
      throw new HttpError(404, "成果文件不存在");
    }

    const tilesetResourceCache: TilesetResourceCache = new Map();
    const previewFile = resolvePreviewEntryFile(requestedFile, files, tilesetResourceCache);
    const responseFiles = previewVisibleFiles(previewFile, files, tilesetResourceCache);

    if (!previewFile || !previewFile.previewable) {
      res.json({
        data: {
          task,
          type: "unsupported",
          file: previewFile,
          message: unsupportedPreviewMessage(previewFile),
          files: responseFiles
        }
      });
      return;
    }

    const contentUrl = previewContentUrl(req.params.taskId, previewFile.fileName);
    if (previewFile.fileType === "json" && previewFile.fileSize <= 5 * 1024 * 1024) {
      const raw = fs.readFileSync(previewFile.filePath, "utf8");
      let json: unknown = raw;
      try {
        json = JSON.parse(raw);
      } catch {
        json = raw;
      }
      res.json({
        data: {
          task,
          type: "json",
          file: previewFile,
          url: contentUrl,
          json,
          files: responseFiles
        }
      });
      return;
    }

    if (previewFile.fileType === "json") {
      res.json({
        data: {
          task,
          type: "unsupported",
          file: previewFile,
          message: unsupportedPreviewMessage(previewFile, "JSON 文件超过 5 MB，暂不支持在线预览"),
          files: responseFiles
        }
      });
      return;
    }

    res.json({
      data: {
        task,
        type: previewFile.fileType,
        file: previewFile,
        url: contentUrl,
        files: responseFiles
      }
    });
  })
);

function normalizeContentFileName(fileName: string): string {
  const segments = fileName
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) {
    throw new HttpError(400, "非法预览资源路径");
  }
  return segments.join("/");
}

function previewContentUrl(taskId: string, fileName: string): string {
  const encodedName = normalizeContentFileName(fileName)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `/api/results/${encodeURIComponent(taskId)}/content/${encodedName}`;
}

function unsupportedPreviewMessage(
  file?: ReturnType<typeof getResultFiles>[number],
  reason = "该文件类型暂不支持在线预览"
): string {
  if (!file) {
    return "暂无可预览成果文件";
  }
  if (file.downloadable) {
    return `${reason}，可下载后查看`;
  }
  return `${reason}，且当前文件不可下载`;
}

function isPreviewContentResource(
  file: ResultFilePayload,
  files: ResultFilePayload[]
): boolean {
  if (file.previewable) {
    return true;
  }

  const normalizedName = normalizeContentFileName(file.fileName);
  const extension = path.posix.extname(normalizedName).toLowerCase();
  if (!previewDependencyExtensions.has(extension)) {
    return false;
  }

  return files.some((candidate) => {
    if (!candidate.previewable || !previewModelTypes.has(candidate.fileType)) {
      return false;
    }
    const previewRoot = path.posix.dirname(normalizeContentFileName(candidate.fileName));
    return previewRoot === "." || normalizedName.startsWith(`${previewRoot}/`);
  });
}

function selectDefaultPreviewFile(
  files: ResultFilePayload[]
): ResultFilePayload | undefined {
  const priority: Record<string, number> = {
    "3dtiles": 0,
    gltf: 1,
    fbx: 2,
    obj: 3,
    dae: 4,
    stl: 5,
    ply: 6,
    usd: 7,
    json: 8
  };

  return files
    .filter((file) => file.previewable)
    .sort((a, b) => (
      (priority[a.fileType] ?? 99) - (priority[b.fileType] ?? 99) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.fileName.localeCompare(b.fileName)
    ))[0];
}

function resolvePreviewEntryFile(
  requestedFile: ResultFilePayload | undefined,
  files: ResultFilePayload[],
  cache: TilesetResourceCache
): ResultFilePayload | undefined {
  if (!requestedFile) {
    return selectDefaultPreviewFile(files);
  }
  return findTilesetEntryForResource(requestedFile, files, cache) || requestedFile;
}

function findTilesetEntryForResource(
  file: ResultFilePayload,
  files: ResultFilePayload[],
  cache: TilesetResourceCache
): ResultFilePayload | undefined {
  if (file.fileType === "3dtiles") {
    return file;
  }

  const normalizedName = normalizeContentFileName(file.fileName);
  const extension = path.posix.extname(normalizedName).toLowerCase();
  if (!file.previewable && !previewDependencyExtensions.has(extension)) {
    return undefined;
  }

  return files.find((candidate) => tilesetReferencesResource(candidate, normalizedName, cache));
}

function previewVisibleFiles(
  previewFile: ResultFilePayload | undefined,
  files: ResultFilePayload[],
  cache: TilesetResourceCache
): ResultFilePayload[] {
  if (!previewFile || previewFile.fileType !== "3dtiles") {
    return files;
  }

  return files.filter((file) => (
    file.id === previewFile.id ||
    !tilesetReferencesResource(previewFile, normalizeContentFileName(file.fileName), cache)
  ));
}

function tilesetReferencesResource(
  tilesetFile: ResultFilePayload,
  normalizedResourceName: string,
  cache: TilesetResourceCache
): boolean {
  if (!tilesetFile.previewable || tilesetFile.fileType !== "3dtiles") {
    return false;
  }

  const tilesetName = normalizeContentFileName(tilesetFile.fileName);
  if (tilesetName === normalizedResourceName || !fs.existsSync(tilesetFile.filePath)) {
    return false;
  }

  const referencedResources = collectTilesetResourceNames(tilesetFile, cache);
  return referencedResources.has(normalizedResourceName);
}

function collectTilesetResourceNames(
  tilesetFile: ResultFilePayload,
  cache: TilesetResourceCache
): Set<string> {
  const cacheKey = `${tilesetFile.id}:${tilesetFile.filePath}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const resources = new Set<string>();
  const tilesetRoot = path.posix.dirname(normalizeContentFileName(tilesetFile.fileName));

  try {
    const tileset = JSON.parse(fs.readFileSync(tilesetFile.filePath, "utf8")) as unknown;
    const visit = (value: unknown, key = "") => {
      if (typeof value === "string") {
        if (key === "uri" || key === "url") {
          const resourceName = normalizeTilesetResourceName(value, tilesetRoot);
          if (resourceName) {
            resources.add(resourceName);
          }
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item));
        return;
      }
      if (value && typeof value === "object") {
        Object.entries(value as Record<string, unknown>).forEach(([entryKey, entryValue]) => {
          visit(entryValue, entryKey);
        });
      }
    };
    visit(tileset);
  } catch {
    cache.set(cacheKey, resources);
    return resources;
  }

  cache.set(cacheKey, resources);
  return resources;
}

function normalizeTilesetResourceName(uri: string, tilesetRoot: string): string | null {
  const resourcePath = uri.split(/[?#]/, 1)[0].trim().replace(/\\/g, "/");
  if (
    !resourcePath ||
    resourcePath.startsWith("/") ||
    resourcePath.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(resourcePath)
  ) {
    return null;
  }

  const normalized = path.posix.normalize(
    tilesetRoot === "." ? resourcePath : path.posix.join(tilesetRoot, resourcePath)
  );
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "..")) {
    return null;
  }
  return segments.join("/");
}

function normalizePreviewState(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "预览状态无效");
  }

  const input = value as Record<string, unknown>;
  const state: Record<string, unknown> = {};

  if (input.sceneMode !== undefined) {
    if (input.sceneMode !== "sphere") {
      throw new HttpError(400, "预览场景模式无效");
    }
    state.sceneMode = input.sceneMode;
  }

  if (input.transform !== undefined) {
    state.transform = normalizeTransform(input.transform);
  }

  if (typeof input.selectedLayerKey === "string" || input.selectedLayerKey === null) {
    state.selectedLayerKey = input.selectedLayerKey;
  }

  if (Array.isArray(input.hiddenLayerKeys)) {
    state.hiddenLayerKeys = input.hiddenLayerKeys
      .filter((key): key is string => typeof key === "string")
      .slice(0, 500);
  }

  return state;
}

function normalizeTransform(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "模型变换状态无效");
  }
  const input = value as Record<string, unknown>;
  const transform: Record<string, unknown> = {};

  if (input.position !== undefined) {
    transform.position = normalizeNumberTuple(input.position, "position");
  }
  if (input.rotation !== undefined) {
    transform.rotation = normalizeNumberTuple(input.rotation, "rotation");
  }
  if (input.scale !== undefined) {
    const scale = normalizeNumberTuple(input.scale, "scale");
    if (scale.some((value) => value <= 0)) {
      throw new HttpError(400, "缩放值必须大于 0");
    }
    transform.scale = scale;
  }
  if (input.geo !== undefined) {
    transform.geo = normalizeGeo(input.geo);
  }
  if (typeof input.updatedAt === "string") {
    transform.updatedAt = input.updatedAt;
  }

  return transform;
}

function normalizeNumberTuple(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new HttpError(400, `${label} 必须包含 3 个数字`);
  }
  const tuple = value.map(Number);
  if (!tuple.every(Number.isFinite)) {
    throw new HttpError(400, `${label} 包含无效数字`);
  }
  return tuple;
}

function normalizeGeo(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "经纬度位置无效");
  }
  const input = value as Record<string, unknown>;
  const longitude = Number(input.longitude);
  const latitude = Number(input.latitude);
  const height = Number(input.height ?? 0);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new HttpError(400, "经度必须在 -180 到 180 之间");
  }
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new HttpError(400, "纬度必须在 -90 到 90 之间");
  }
  if (!Number.isFinite(height)) {
    throw new HttpError(400, "高程必须是有效数字");
  }
  return { longitude, latitude, height };
}

function normalizeArchiveEntryName(fileName: string): string {
  const normalized = fileName
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .map((segment) => segment.replace(/[\x00-\x1f<>:"|?*]+/g, "_"))
    .join("/");

  return normalized || "result-file";
}

function uniqueArchiveEntryName(entryName: string, usedNames: Set<string>): string {
  if (!usedNames.has(entryName)) {
    usedNames.add(entryName);
    return entryName;
  }

  const extension = path.posix.extname(entryName);
  const baseName = entryName.slice(0, entryName.length - extension.length);
  let index = 2;
  let candidate = `${baseName}-${index}${extension}`;
  while (usedNames.has(candidate)) {
    index += 1;
    candidate = `${baseName}-${index}${extension}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function hasBrowserPageQuery(query: Record<string, unknown>): boolean {
  return ["folder", "search", "page", "pageSize"].some((key) => query[key] !== undefined);
}

function stringQuery(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function positiveIntegerQuery(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "query value must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new HttpError(400, "query value must be a positive integer");
  }
  return parsed;
}

function getArchiveFiles(taskId: string): ArchiveFile[] {
  const managedRoot = resultOutputPath(taskId);
  const filesByPath = new Map<string, ArchiveFile>();

  getResultFiles(taskId)
    .filter((file) => file.downloadable)
    .forEach((file) => {
      addArchiveFile(filesByPath, managedRoot, file.filePath, file.fileName);
    });

  return [...filesByPath.values()];
}

function addArchiveFile(
  filesByPath: Map<string, ArchiveFile>,
  managedRoot: string,
  filePath: string,
  fileName: string
): void {
  try {
    const safePath = assertPathInside(managedRoot, filePath);
    if (!fs.existsSync(safePath) || !fs.statSync(safePath).isFile()) {
      return;
    }
    const key = path.resolve(safePath).toLowerCase();
    if (!filesByPath.has(key)) {
      filesByPath.set(key, { fileName, filePath: safePath });
    }
  } catch {
    // Ignore stale or invalid result-file records.
  }
}

function safeDownloadName(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "results";
}

router.delete(
  "/:taskId",
  asyncHandler(async (req, res) => {
    deleteResults(req.params.taskId);
    res.status(204).send();
  })
);

export default router;
