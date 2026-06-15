import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Router } from "express";
import AdmZip from "adm-zip";
import {
  deleteResults,
  getResultFile,
  getResultFiles,
  getTask
} from "../services/task.service";
import { assertPathInside, resultOutputPath } from "../services/file.service";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/httpError";

const router = Router();

interface ArchiveFile {
  fileName: string;
  filePath: string;
}

const previewDependencyExtensions = new Set([
  ".bin",
  ".b3dm",
  ".cmpt",
  ".i3dm",
  ".json",
  ".jpeg",
  ".jpg",
  ".ktx2",
  ".png",
  ".pnts",
  ".subtree",
  ".webp"
]);

router.get(
  "/:taskId/files",
  asyncHandler(async (req, res) => {
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

    const previewFile = requestedFile || files.find((file) => file.previewable);

    if (!previewFile || !previewFile.previewable) {
      res.json({
        data: {
          task,
          type: "unsupported",
          file: previewFile,
          message: unsupportedPreviewMessage(previewFile),
          files
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
          files
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
          files
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
        files
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
  file: ReturnType<typeof getResultFiles>[number],
  files: ReturnType<typeof getResultFiles>
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
    if (!candidate.previewable || !["gltf", "3dtiles"].includes(candidate.fileType)) {
      return false;
    }
    const previewRoot = path.posix.dirname(normalizeContentFileName(candidate.fileName));
    return previewRoot === "." || normalizedName.startsWith(`${previewRoot}/`);
  });
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
