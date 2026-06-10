import { Router } from "express";
import {
  createTemplateGroup,
  deleteTemplateGroup,
  listTemplateGroups,
  updateTemplateGroup
} from "../services/template-group.service";
import { asyncHandler } from "../utils/asyncHandler";

const router = Router();

router.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ data: listTemplateGroups() });
  })
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const group = createTemplateGroup(String(req.body?.name || ""), req.body?.description);
    res.status(201).json({ data: group });
  })
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const group = updateTemplateGroup(req.params.id, String(req.body?.name || ""), req.body?.description);
    res.json({ data: group });
  })
);

router.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    deleteTemplateGroup(req.params.id);
    res.status(204).send();
  })
);

export default router;
