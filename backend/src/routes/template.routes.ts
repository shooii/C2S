import { Router } from "express";
import { createTemplateUpload, removeIfExists } from "../services/file.service";
import {
  createTemplateFromUpload,
  deleteTemplate,
  getTemplate,
  listTemplates,
  updateTemplateConfiguration
} from "../services/template.service";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/httpError";
import { assignTemplateGroup } from "../services/template-group.service";

const router = Router();
const upload = createTemplateUpload();
const cancelledUploads = new Set<string>();

router.post(
  "/upload-cancellations/:token",
  asyncHandler(async (req, res) => {
    const token = req.params.token.trim();
    if (!token) {
      throw new HttpError(400, "缺少上传事务标识");
    }
    cancelledUploads.add(token);
    setTimeout(() => cancelledUploads.delete(token), 10 * 60 * 1000).unref();
    res.status(204).send();
  })
);

router.post(
  "/upload",
  (req, res, next) => {
    res.locals.uploadAborted = false;
    req.once("aborted", () => {
      res.locals.uploadAborted = true;
      if (req.file?.path) {
        removeIfExists(req.file.path);
      }
    });
    next();
  },
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new HttpError(400, "请上传 .fmw / .fmwt 模板文件");
    }
    const uploadToken = typeof req.body?.uploadToken === "string" ? req.body.uploadToken : "";
    if (uploadToken && cancelledUploads.has(uploadToken)) {
      removeIfExists(req.file.path);
      cancelledUploads.delete(uploadToken);
      res.status(204).send();
      return;
    }
    const groupId = typeof req.body?.groupId === "string" ? req.body.groupId : "default";
    try {
      const template = await createTemplateFromUpload(req.file, groupId);
      if (
        req.aborted ||
        res.locals.uploadAborted ||
        (uploadToken && cancelledUploads.has(uploadToken))
      ) {
        deleteTemplate(template.id);
        cancelledUploads.delete(uploadToken);
        return;
      }
      cancelledUploads.delete(uploadToken);
      res.status(201).json({ data: template });
    } catch (error) {
      removeIfExists(req.file.path);
      cancelledUploads.delete(uploadToken);
      throw error;
    }
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const enabled = req.query.enabled === "true"
      ? true
      : req.query.enabled === "false"
        ? false
        : undefined;
    res.json({ data: listTemplates({ search, enabled }) });
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json({ data: getTemplate(req.params.id) });
  })
);

router.patch(
  "/:id/group",
  asyncHandler(async (req, res) => {
    assignTemplateGroup(req.params.id, String(req.body?.groupId || ""));
    res.json({ data: getTemplate(req.params.id) });
  })
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const { description, version, enabled, parameterLabels } = req.body || {};
    if (description !== null && description !== undefined && typeof description !== "string") {
      throw new HttpError(400, "模板说明必须是字符串");
    }
    if (version !== null && version !== undefined && typeof version !== "string") {
      throw new HttpError(400, "模板版本号必须是字符串");
    }
    if (enabled !== undefined && typeof enabled !== "boolean") {
      throw new HttpError(400, "模板启用状态必须是布尔值");
    }
    if (
      parameterLabels !== undefined &&
      (
        !Array.isArray(parameterLabels) ||
        parameterLabels.some((item) => (
          !item ||
          typeof item.id !== "string" ||
          typeof item.label !== "string"
        ))
      )
    ) {
      throw new HttpError(400, "参数名称配置格式不正确");
    }
    res.json({
      data: updateTemplateConfiguration(req.params.id, {
        description,
        version,
        enabled,
        parameterLabels
      })
    });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    deleteTemplate(req.params.id);
    res.status(204).send();
  })
);

export default router;
