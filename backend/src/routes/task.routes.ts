import { Router } from "express";
import { createInputUpload } from "../services/file.service";
import {
  cancelTask,
  createAndRunTask,
  deleteTask,
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

router.post(
  "/run",
  upload.single("inputData"),
  asyncHandler(async (req, res) => {
    const templateId = stringField(req.body.templateId);
    if (!templateId) {
      throw new HttpError(400, "templateId 为必填项");
    }

    const task = createAndRunTask({
      templateId,
      taskName: stringField(req.body.taskName) ?? undefined,
      parameters: parseParameters(req.body.parameters),
      outputFormat: stringField(req.body.outputFormat),
      inputDataName: req.file?.originalname || stringField(req.body.inputDataName),
      inputDataPath: req.file?.path || stringField(req.body.inputDataPath)
    });

    res.status(201).json({ data: task });
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status as TaskStatus : undefined;
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
    res.type("text/plain").send(getTaskLogs(req.params.id));
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
    res.status(201).json({ data: rerunTask(req.params.id) });
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

function stringField(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed || null;
}

export default router;
