import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb, nowIso, runTransaction } from "../db/database";
import type { ConversionTask, ResultFile, TaskStatus, TemplateParameter } from "../types";
import { assertPathInside, directorySize, removeIfExists, resultOutputPath } from "./file.service";
import {
  cancelWorkspace,
  defaultLogPath,
  getWorkspaceOutputParameterNames,
  isOutputDirectoryParameter,
  runWorkspace,
  scanOutputFiles
} from "./fme.service";
import { getTemplate } from "./template.service";
import { assertFound, HttpError } from "../utils/httpError";
import { logStorageDir, outputStorageDir } from "../config/paths";

type TaskRow = Omit<ConversionTask, "parameters"> & { parameters: string };
type ResultFileRow = Omit<ResultFile, "downloadable" | "previewable"> & {
  downloadable: number;
  previewable: number;
};

export interface CreateTaskInput {
  templateId: string;
  taskName?: string;
  parameters?: Record<string, unknown>;
  outputFormat?: string | null;
  inputDataName?: string | null;
  inputDataPath?: string | null;
}

export function listTasks(options: { status?: TaskStatus; search?: string } = {}): ConversionTask[] {
  const db = getDb();
  const where: string[] = [];
  const params: Record<string, string> = {};

  if (options.status) {
    where.push("status = @status");
    params.status = options.status;
  }
  if (options.search) {
    where.push("(taskName LIKE @search OR templateName LIKE @search OR inputDataName LIKE @search)");
    params.search = `%${options.search}%`;
  }

  const sql = `
    SELECT * FROM conversion_tasks
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY createdAt DESC
  `;
  return (db.prepare(sql).all(params) as unknown as TaskRow[]).map(mapTaskRow);
}

export function getTask(id: string): ConversionTask {
  return mapTaskRow(assertFound(
    getDb().prepare("SELECT * FROM conversion_tasks WHERE id = ?").get(id) as TaskRow | undefined,
    "转换任务不存在"
  ));
}

export function getTaskLogs(id: string): string {
  getTask(id);
  const logPath = assertPathInside(logStorageDir, path.join(logStorageDir, `${id}.log`));
  if (!fs.existsSync(logPath)) {
    return "";
  }
  return fs.readFileSync(logPath, "utf8");
}

export function getResultFiles(taskId: string): ResultFile[] {
  getTask(taskId);
  return (
    getDb()
      .prepare("SELECT * FROM result_files WHERE taskId = ? ORDER BY createdAt ASC")
      .all(taskId) as unknown as ResultFileRow[]
  ).map(mapResultFileRow);
}

export function getResultFile(taskId: string, fileId: string): ResultFile {
  const file = assertFound(
    getDb().prepare("SELECT * FROM result_files WHERE taskId = ? AND id = ?").get(taskId, fileId) as
      | ResultFileRow
      | undefined,
    "成果文件不存在"
  );
  const mapped = mapResultFileRow(file);
  assertPathInside(path.join(outputStorageDir, taskId), mapped.filePath);
  return mapped;
}

export function createAndRunTask(input: CreateTaskInput): ConversionTask {
  const template = getTemplate(input.templateId);
  const id = randomUUID();
  const createdAt = nowIso();
  const outputPath = resultOutputPath(id);
  const logPath = defaultLogPath(id);
  const taskName = input.taskName?.trim() || `${template.name} 转换任务`;
  const parameters = buildRuntimeParameters(
    input.parameters || {},
    input.inputDataPath || null,
    input.outputFormat || null,
    template.parameters,
    outputPath,
    template.filePath
  );

  fs.mkdirSync(outputPath, { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });

  getDb()
    .prepare(
      `INSERT INTO conversion_tasks (
        id, taskName, templateId, templateName, inputDataName, inputDataPath, status, progress,
        parameters, outputFormat, outputPath, resultSize, previewUrl, downloadUrl, logPath,
        exitCode, errorMessage, createdAt, startedAt, finishedAt, duration
      ) VALUES (
        @id, @taskName, @templateId, @templateName, @inputDataName, @inputDataPath, @status, @progress,
        @parameters, @outputFormat, @outputPath, @resultSize, @previewUrl, @downloadUrl, @logPath,
        @exitCode, @errorMessage, @createdAt, @startedAt, @finishedAt, @duration
      )`
    )
    .run({
      id,
      taskName,
      templateId: template.id,
      templateName: template.name,
      inputDataName: input.inputDataName || null,
      inputDataPath: input.inputDataPath || null,
      status: "pending",
      progress: 0,
      parameters: JSON.stringify(parameters),
      outputFormat: input.outputFormat || null,
      outputPath,
      resultSize: 0,
      previewUrl: null,
      downloadUrl: null,
      logPath,
      exitCode: null,
      errorMessage: null,
      createdAt,
      startedAt: null,
      finishedAt: null,
      duration: null
    });

  void executeTask(id, template.filePath, parameters);

  return getTask(id);
}

export function cancelTask(id: string): ConversionTask {
  const task = getTask(id);
  if (!["pending", "running"].includes(task.status)) {
    throw new HttpError(400, "只有排队中或运行中的任务可以取消");
  }

  cancelWorkspace(id);
  updateTask(id, {
    status: "cancelled",
    progress: task.progress,
    finishedAt: nowIso(),
    errorMessage: "用户取消任务"
  });

  return getTask(id);
}

export function rerunTask(id: string): ConversionTask {
  const task = getTask(id);
  if (task.inputDataPath && !fs.existsSync(task.inputDataPath)) {
    throw new HttpError(400, "原始输入数据文件不存在，无法重新运行");
  }

  return createAndRunTask({
    templateId: task.templateId,
    taskName: `${task.taskName} - 重新运行`,
    parameters: task.parameters,
    outputFormat: task.outputFormat,
    inputDataName: task.inputDataName,
    inputDataPath: task.inputDataPath
  });
}

export function deleteResults(taskId: string): void {
  getTask(taskId);
  const outputPath = path.join(outputStorageDir, taskId);
  assertPathInside(outputStorageDir, outputPath);
  removeIfExists(outputPath);
  const db = getDb();
  db.prepare("DELETE FROM result_files WHERE taskId = ?").run(taskId);
  db.prepare("UPDATE conversion_tasks SET resultSize = 0, previewUrl = NULL, downloadUrl = NULL WHERE id = ?").run(taskId);
}

export function deleteTask(taskId: string): void {
  const task = getTask(taskId);
  
  // 如果任务正在运行，先取消它
  if (["pending", "running"].includes(task.status)) {
    cancelWorkspace(taskId);
  }

  // 删除成果文件目录
  const outputPath = path.join(outputStorageDir, taskId);
  assertPathInside(outputStorageDir, outputPath);
  removeIfExists(outputPath);

  // 删除日志文件
  const logPath = assertPathInside(logStorageDir, path.join(logStorageDir, `${taskId}.log`));
  removeIfExists(logPath);

  const db = getDb();
  // 删除结果文件记录
  db.prepare("DELETE FROM result_files WHERE taskId = ?").run(taskId);
  // 删除任务记录
  db.prepare("DELETE FROM conversion_tasks WHERE id = ?").run(taskId);
}

async function executeTask(
  taskId: string,
  workspacePath: string,
  fmeParameters: Record<string, unknown>
): Promise<void> {
  const task = getTask(taskId);
  updateTask(taskId, {
    status: "running",
    progress: 5,
    startedAt: nowIso(),
    errorMessage: null
  });

  try {
    const result = await runWorkspace({
      taskId,
      workspacePath,
      parameters: fmeParameters,
      outputPath: task.outputPath,
      logPath: task.logPath,
      onProgress: (progress) => updateProgressIfRunning(taskId, progress)
    });

    const current = getTask(taskId);
    if (current.status === "cancelled") {
      return;
    }

    const files = scanOutputFiles(taskId);
    replaceResultFiles(taskId, files);
    const persistedFiles = getResultFiles(taskId);
    const firstDownloadable = persistedFiles.find((file) => file.downloadable);
    const firstPreviewable = persistedFiles.find((file) => file.previewable);
    const success = result.exitCode === 0;

    updateTask(taskId, {
      status: success ? "success" : "failed",
      progress: success ? 100 : Math.max(current.progress, 5),
      resultSize: directorySize(task.outputPath),
      previewUrl: firstPreviewable ? `/api/results/${taskId}/preview` : null,
      downloadUrl: firstDownloadable ? `/api/results/${taskId}/download/${firstDownloadable.id}` : null,
      exitCode: result.exitCode,
      errorMessage: success ? null : `FME 进程退出码：${result.exitCode ?? "null"}`,
      finishedAt: nowIso(),
      duration: result.duration
    });
  } catch (error) {
    const current = getTask(taskId);
    if (current.status === "cancelled") {
      return;
    }
    updateTask(taskId, {
      status: "failed",
      progress: Math.max(current.progress, 5),
      errorMessage: error instanceof Error ? error.message : "FME 执行失败",
      finishedAt: nowIso(),
      duration: current.startedAt ? Date.now() - new Date(current.startedAt).getTime() : null
    });
  }
}

function replaceResultFiles(taskId: string, files: Array<Omit<ResultFile, "id" | "createdAt">>): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO result_files (
      id, taskId, fileName, fileType, fileSize, filePath, downloadable, previewable, createdAt
    ) VALUES (
      @id, @taskId, @fileName, @fileType, @fileSize, @filePath, @downloadable, @previewable, @createdAt
    )`
  );

  runTransaction(() => {
    db.prepare("DELETE FROM result_files WHERE taskId = ?").run(taskId);
    files.forEach((file) => {
      insert.run({
        ...file,
        id: randomUUID(),
        downloadable: file.downloadable ? 1 : 0,
        previewable: file.previewable ? 1 : 0,
        createdAt: nowIso()
      });
    });
  });
}

function updateProgressIfRunning(taskId: string, progress: number): void {
  const task = getTask(taskId);
  if (task.status !== "running") {
    return;
  }
  const next = Math.max(task.progress, Math.min(progress, 99));
  getDb().prepare("UPDATE conversion_tasks SET progress = ? WHERE id = ?").run(next, taskId);
}

function updateTask(id: string, patch: Partial<ConversionTask>): void {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (!entries.length) {
    return;
  }

  const fields = entries.map(([key]) => `${key} = @${key}`).join(", ");
  const values = Object.fromEntries(entries);
  getDb().prepare(`UPDATE conversion_tasks SET ${fields} WHERE id = @id`).run({
    ...values,
    id
  });
}

function buildRuntimeParameters(
  parameters: Record<string, unknown>,
  inputDataPath: string | null,
  outputFormat: string | null,
  templateParameters: Array<Pick<TemplateParameter, "name" | "label" | "type" | "defaultValue" | "description">>,
  outputPath: string,
  workspacePath: string
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...parameters };

  const outputParameterNames = new Set<string>();
  for (const parameter of templateParameters) {
    if (isOutputDirectoryParameter(parameter)) {
      outputParameterNames.add(parameter.name);
    }
  }
  for (const parameterName of getWorkspaceOutputParameterNames(workspacePath)) {
    outputParameterNames.add(parameterName);
  }
  for (const parameterName of outputParameterNames) {
    setCaseInsensitiveValue(merged, parameterName, outputPath);
  }

  if (inputDataPath && !hasCaseInsensitiveKey(merged, "INPUT_DATA")) {
    merged.INPUT_DATA = inputDataPath;
  }
  if (outputFormat && !hasCaseInsensitiveKey(merged, "OUTPUT_FORMAT")) {
    merged.OUTPUT_FORMAT = outputFormat;
  }
  if (!hasCaseInsensitiveKey(merged, "OUTPUT_DIR") && !hasCaseInsensitiveKey(merged, "OUTPUT_DIRECTORY")) {
    merged.OUTPUT_DIR = outputPath;
  }
  return merged;
}

function hasCaseInsensitiveKey(target: Record<string, unknown>, key: string): boolean {
  return Object.keys(target).some((candidate) => candidate.toUpperCase() === key.toUpperCase());
}

function setCaseInsensitiveValue(target: Record<string, unknown>, key: string, value: unknown): void {
  const existingKey = Object.keys(target).find((candidate) => candidate.toUpperCase() === key.toUpperCase());
  target[existingKey || key] = value;
}

function mapTaskRow(row: TaskRow): ConversionTask {
  return {
    ...row,
    parameters: safeJsonObject(row.parameters)
  };
}

function mapResultFileRow(row: ResultFileRow): ResultFile {
  return {
    ...row,
    downloadable: Boolean(row.downloadable),
    previewable: Boolean(row.previewable)
  };
}

function safeJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
