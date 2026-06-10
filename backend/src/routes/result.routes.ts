import fs from "node:fs";
import { Router } from "express";
import {
  deleteResults,
  getResultFile,
  getResultFiles,
  getTask
} from "../services/task.service";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/httpError";

const router = Router();

router.get(
  "/:taskId/files",
  asyncHandler(async (req, res) => {
    res.json({ data: getResultFiles(req.params.taskId) });
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

router.delete(
  "/:taskId",
  asyncHandler(async (req, res) => {
    deleteResults(req.params.taskId);
    res.status(204).send();
  })
);

export default router;

