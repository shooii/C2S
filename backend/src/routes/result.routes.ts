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
import { assertPathInside, listFilesRecursive, resultOutputPath } from "../services/file.service";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/httpError";

const router = Router();

interface ArchiveFile {
  fileName: string;
  filePath: string;
}

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
    if (!fs.existsSync(file.filePath)) {
      throw new HttpError(404, "成果文件不存在或已被删除");
    }
    res.download(file.filePath, file.fileName);
  })
);

router.get(
  "/:taskId/preview",
  asyncHandler(async (req, res) => {
    const task = getTask(req.params.taskId);
    const files = getResultFiles(req.params.taskId);
    const previewFile = files.find((file) => file.previewable);

    if (!previewFile) {
      res.json({
        data: {
          task,
          type: "unsupported",
          message: "该成果类型暂不支持在线预览，可下载后查看",
          files
        }
      });
      return;
    }

    const downloadUrl = `/api/results/${req.params.taskId}/download/${previewFile.id}`;
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
          url: downloadUrl,
          json,
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
        url: downloadUrl,
        files
      }
    });
  })
);

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

  listFilesRecursive(managedRoot).forEach((file) => {
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
    // Ignore stale or invalid result-file records; actual managed outputs are scanned separately.
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
