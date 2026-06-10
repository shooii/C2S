import { Router } from "express";
import { createTemplateUpload } from "../services/file.service";
import {
  createTemplateFromUpload,
  deleteTemplate,
  getTemplate,
  listTemplates,
  parseTemplate
} from "../services/template.service";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/httpError";
import type { ParseStatus } from "../types";
import { assignTemplateGroup } from "../services/template-group.service";

const router = Router();
const upload = createTemplateUpload();

router.post(
  "/upload",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new HttpError(400, "请上传 .fmw / .fmwt 模板文件");
    }
    const template = await createTemplateFromUpload(req.file);
    res.status(201).json({ data: template });
  })
);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const parseStatus = typeof req.query.parseStatus === "string" ? req.query.parseStatus as ParseStatus : undefined;
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    res.json({ data: listTemplates({ search, parseStatus }) });
  })
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json({ data: getTemplate(req.params.id) });
  })
);

router.post(
  "/:id/parse",
  asyncHandler(async (req, res) => {
    const template = await parseTemplate(req.params.id);
    res.json({ data: template });
  })
);

router.patch(
  "/:id/group",
  asyncHandler(async (req, res) => {
    assignTemplateGroup(req.params.id, String(req.body?.groupId || ""));
    res.json({ data: getTemplate(req.params.id) });
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
