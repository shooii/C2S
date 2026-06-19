import { Router } from "express";
import {
  createInputUpload,
  materializeParameterUploads,
  removeIfExists,
  type ParameterUploadManifestEntry
} from "../services/file.service";
import {
  cancelTask,
  clearTasks,
  createAndRunTask,
  deleteTask,
  deleteTasks,
  getTask,
  getTaskLogs,
  listTasks,
  rerunTask
} from "../services/task.service";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/httpError";
import type { TaskStatus } from "../types";

const router = Router();
const upload = createInputUpload();
const TASK_STATUSES = new Set<TaskStatus>(["pending", "running", "success", "failed", "cancelled"]);

router.post(
  "/run",
  upload.fields([
    { name: "inputData", maxCount: 1 },
    { name: "parameterFiles", maxCount: 10_000 }
  ]),
  asyncHandler(async (req, res) => {
    const uploadedFiles = (req.files || {}) as Record<string, Express.Multer.File[]>;
    const inputFile = uploadedFiles.inputData?.[0];
    const parameterFiles = uploadedFiles.parameterFiles || [];
    let cleanupPaths: string[] = [];

    try {
      const templateId = stringField(req.body.templateId);
      if (!templateId) {
        throw new HttpError(400, "templateId 为必填项");
      }

      const parameters = parseParameters(req.body.parameters);
      const manifest = parseParameterUploadManifest(req.body.parameterUploadManifest);
      const materialized = materializeParameterUploads(parameterFiles, manifest);
      cleanupPaths = materialized.cleanupPaths;
      Object.assign(parameters, materialized.values);

      const task = createAndRunTask({
        templateId,
        taskName: stringField(req.body.taskName) ?? undefined,
        parameters,
        outputFormat: stringField(req.body.outputFormat),
        inputDataName:
          inputFile?.originalname ||
          materialized.primaryName ||
          stringField(req.body.inputDataName),
        inputDataPath:
          inputFile?.path ||
          materialized.primaryPath ||
          stringField(req.body.inputDataPath)
      });

      res.status(201).json({ data: task });
    } catch (error) {
      cleanupPaths.forEach(removeIfExists);
      if (!cleanupPaths.length) {
        parameterFiles.forEach((file) => removeIfExists(file.path));
      }
      if (inputFile) {
        removeIfExists(inputFile.path);
      }
      throw error;
    }
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = taskStatusField(req.query.status);
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    res.json({ data: listTasks({ status, search }) });
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json({ data: getTask(req.params.id) });
  })
);

router.get(
  "/:id/logs",
  asyncHandler(async (req, res) => {
    res.type("text/plain").send(getTaskLogs(req.params.id, {
      tailBytes: positiveIntegerQuery(req.query.tailBytes)
    }));
  })
);

router.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    res.json({ data: cancelTask(req.params.id) });
  })
);

router.post(
  "/:id/rerun",
  asyncHandler(async (req, res) => {
    const hasParameters = Object.prototype.hasOwnProperty.call(req.body || {}, "parameters");
    const hasOutputFormat = Object.prototype.hasOwnProperty.call(req.body || {}, "outputFormat");
    res.status(201).json({
      data: rerunTask(req.params.id, {
        taskName: stringField(req.body?.taskName) ?? undefined,
        parameters: hasParameters ? parseParameters(req.body.parameters) : undefined,
        outputFormat: hasOutputFormat ? stringField(req.body.outputFormat) : undefined
      })
    });
  })
);

router.post(
  "/batch-delete",
  asyncHandler(async (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new HttpError(400, "ids 必须是字符串数组");
    }
    res.json({
      data: {
        deletedCount: deleteTasks(ids)
      }
    });
  })
);

router.delete(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({
      data: {
        deletedCount: clearTasks()
      }
    });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    deleteTask(req.params.id);
    res.json({ message: "任务已删除" });
  })
);

function parseParameters(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }
  if (typeof value === "object") {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    throw new HttpError(400, "parameters 必须是合法 JSON 对象");
  }
}

function taskStatusField(value: unknown): TaskStatus | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "status 必须是字符串");
  }
  const status = value.trim() as TaskStatus;
  if (!status) {
    return undefined;
  }
  if (!TASK_STATUSES.has(status)) {
    throw new HttpError(400, "不支持的任务状态");
  }
  return status;
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

function parseParameterUploadManifest(value: unknown): ParameterUploadManifestEntry[] {
  if (!value) {
    return [];
  }
  if (typeof value !== "string") {
    throw new HttpError(400, "parameterUploadManifest 必须是 JSON 数组");
  }
  try {
    const parsed = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => (
        !item ||
        typeof item.parameterName !== "string" ||
        !["file", "folder"].includes(item.kind) ||
        typeof item.relativePath !== "string"
      ))
    ) {
      throw new Error("invalid manifest");
    }
    return parsed as ParameterUploadManifestEntry[];
  } catch {
    throw new HttpError(400, "parameterUploadManifest 格式不正确");
  }
}

function stringField(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

export default router;
