import { Router } from "express";
import { selectLocalPath } from "../services/local-path.service";
import { asyncHandler } from "../utils/asyncHandler";
import { HttpError } from "../utils/httpError";

const router = Router();

router.post(
  "/select",
  asyncHandler(async (req, res) => {
    assertLocalRequest(req.socket.remoteAddress);
    const controller = new AbortController();
    const abortSelection = () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    };
    req.once("aborted", abortSelection);
    res.once("close", abortSelection);
    const kind = req.body?.kind;
    if (kind !== "file" && kind !== "folder") {
      throw new HttpError(400, "kind 必须是 file 或 folder");
    }
    const initialPath = typeof req.body?.initialPath === "string"
      ? req.body.initialPath.trim()
      : null;
    const multiple = kind === "file" && req.body?.multiple === true;
    const title = typeof req.body?.title === "string"
      ? req.body.title.trim().slice(0, 120)
      : null;
    try {
      res.json({
        data: await selectLocalPath({
          kind,
          initialPath,
          multiple,
          title,
          signal: controller.signal
        })
      });
    } finally {
      req.off("aborted", abortSelection);
      res.off("close", abortSelection);
    }
  })
);

function assertLocalRequest(remoteAddress: string | undefined): void {
  const normalized = (remoteAddress || "").replace(/^::ffff:/, "");
  if (!["::1", "127.0.0.1"].includes(normalized)) {
    throw new HttpError(403, "本地路径选择器只能从当前计算机访问");
  }
}

export default router;
