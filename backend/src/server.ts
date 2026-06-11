import express from "express";
import cors from "cors";
import multer from "multer";
import templateRoutes from "./routes/template.routes";
import templateGroupRoutes from "./routes/template-group.routes";
import taskRoutes from "./routes/task.routes";
import resultRoutes from "./routes/result.routes";
import localPathRoutes from "./routes/local-path.routes";
import { ensureStorageDirs } from "./config/paths";
import { getDb } from "./db/database";
import { checkFmeAvailable } from "./services/fme.service";
import { HttpError } from "./utils/httpError";
import { warmLocalPathSelector } from "./services/local-path.service";

const app = express();
const port = Number(process.env.PORT || 4000);

ensureStorageDirs();
getDb();
warmLocalPathSelector();

// 配置 CORS，确保支持 UTF-8
app.use(cors({
  origin: true,
  credentials: true
}));

// 确保所有响应都使用 UTF-8 编码
app.use((_req, res, next) => {
  res.set("Content-Type", "application/json; charset=utf-8");
  next();
});

app.use(express.json({ 
  limit: "20mb",
  type: "application/json"
}));
app.use(express.urlencoded({ 
  extended: true, 
  limit: "20mb",
  type: "application/x-www-form-urlencoded"
}));

app.get("/api/health", (_req, res) => {
  res.set("Content-Type", "application/json; charset=utf-8");
  res.json({
    data: {
      service: "C2S backend",
      status: "ok",
      time: new Date().toISOString()
    }
  });
});

app.get("/api/fme/status", async (_req, res, next) => {
  try {
    res.json({ data: await checkFmeAvailable() });
  } catch (error) {
    next(error);
  }
});

app.use("/api/templates", templateRoutes);
app.use("/api/template-groups", templateGroupRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/results", resultRoutes);
app.use("/api/local-paths", localPathRoutes);

app.use((req, _res, next) => {
  next(new HttpError(404, `接口不存在：${req.method} ${req.path}`));
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof multer.MulterError) {
    res.status(400).json({
      message: error.message
    });
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.status).json({
      message: error.message
    });
    return;
  }

  const message = error instanceof Error ? error.message : "服务器内部错误";
  res.status(500).json({
    message
  });
});

app.listen(port, () => {
  console.log(`C2S backend listening on http://localhost:${port}`);
});
