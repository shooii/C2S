import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb, nowIso, runTransaction } from "../db/database";
import type { ConversionTask, ResultFile, TaskStatus, TemplateParameter } from "../types";
import {
  assertPathInside,
  getResultFileType,
  isPreviewable,
  removeIfExists,
  resultOutputPath
} from "./file.service";
import {
  cancelWorkspace,
  defaultLogPath,
  getWorkspaceOutputParameterNames,
  isOutputDirectoryParameter,
  type OutputFileSnapshot,
  runWorkspace,
  scanOutputFiles,
  snapshotOutputFiles
} from "./fme.service";
import { getTemplate } from "./template.service";
import { assertFound, HttpError } from "../utils/httpError";
import { logStorageDir, outputStorageDir } from "../config/paths";

type TaskRow = Omit<ConversionTask, "parameters" | "rerunnable"> & {
  parameters: string;
  rerunnable: number;
};
type ResultFileRow = Omit<ResultFile, "downloadable" | "previewable"> & {
  downloadable: number;
  previewable: number;
};
type GeneratedResultFile = Omit<ResultFile, "id" | "createdAt">;
interface GeneratedResultSummary {
  files: GeneratedResultFile[];
  resultSize: number;
  hasPreviewableFiles: boolean;
  hasDownloadableFiles: boolean;
}
class TaskFinalizeStateError extends Error {}

const TASK_EXECUTION_START_DELAY_MS = 200;

export interface CreateTaskInput {
  templateId: string;
  taskName?: string;
  parameters?: Record<string, unknown>;
  outputFormat?: string | null;
  inputDataName?: string | null;
  inputDataPath?: string | null;
}

export interface RerunTaskInput {
  taskName?: string;
  parameters?: Record<string, unknown>;
  outputFormat?: string | null;
}

export function listTasks(options: { status?: TaskStatus; search?: string } = {}): ConversionTask[] {
  const db = getDb();
  const where: string[] = [];
  const params: Record<string, string> = {};
  const search = options.search?.trim();

  if (options.status) {
    where.push("tasks.status = @status");
    params.status = options.status;
  }
  if (search) {
    where.push("(tasks.id LIKE @search OR tasks.taskName LIKE @search OR tasks.templateName LIKE @search OR tasks.inputDataName LIKE @search)");
    params.search = `%${search}%`;
  }

  const sql = `
    SELECT tasks.*,
           CASE WHEN templates.id IS NOT NULL AND templates.enabled = 1 THEN 1 ELSE 0 END AS rerunnable
    FROM conversion_tasks tasks
    LEFT JOIN templates ON templates.id = tasks.templateId
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY tasks.createdAt DESC
  `;
  return (db.prepare(sql).all(params) as unknown as TaskRow[]).map(mapTaskRow);
}

export function getTask(id: string): ConversionTask {
  return mapTaskRow(assertFound(
    getDb().prepare(
      `SELECT tasks.*,
              CASE WHEN templates.id IS NOT NULL AND templates.enabled = 1 THEN 1 ELSE 0 END AS rerunnable
       FROM conversion_tasks tasks
       LEFT JOIN templates ON templates.id = tasks.templateId
       WHERE tasks.id = ?`
    ).get(id) as TaskRow | undefined,
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
  getTask(taskId);
  const file = assertFound(
    getDb().prepare("SELECT * FROM result_files WHERE taskId = ? AND id = ?").get(taskId, fileId) as
      | ResultFileRow
      | undefined,
    "成果文件不存在"
  );
  const mapped = mapResultFileRow(file);
  assertPathInside(resultOutputPath(taskId), mapped.filePath);
  return mapped;
}

export function createAndRunTask(input: CreateTaskInput): ConversionTask {
  const template = getTemplate(input.templateId);
  if (!template.enabled) {
    throw new HttpError(400, "模板尚未启用，请先在模板配置中启用");
  }
  const id = randomUUID();
  const createdAt = nowIso();
  const outputPath = resolveTaskOutputPath(
    input.parameters || {},
    template.parameters,
    resultOutputPath(id)
  );
  const logPath = defaultLogPath(id);
  const taskName = input.taskName?.trim() || `${template.name} 转换任务`;
  const parameters = buildRuntimeParameters(
    input.parameters || {},
    input.inputDataPath || null,
    input.outputFormat || null,
    template.parameters,
    outputPath
  );

  fs.mkdirSync(outputPath, { recursive: true });
  fs.mkdirSync(resultOutputPath(id), { recursive: true });
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

  scheduleTaskExecution(id, template.filePath, parameters);

  return getTask(id);
}

export function cancelTask(id: string): ConversionTask {
  const task = getTask(id);
  if (!["pending", "running"].includes(task.status)) {
    throw new HttpError(400, "只有排队中或运行中的任务可以取消");
  }

  const finishedAt = nowIso();
  const duration = task.startedAt
    ? new Date(finishedAt).getTime() - new Date(task.startedAt).getTime()
    : null;
  const result = getDb().prepare(
    `UPDATE conversion_tasks
     SET status = 'cancelled',
         progress = ?,
         finishedAt = ?,
         duration = ?,
         errorMessage = ?
     WHERE id = ? AND status IN ('pending', 'running')`
  ).run(
    task.progress,
    finishedAt,
    duration,
    "用户取消任务",
    id
  );

  if (Number(result.changes) === 0) {
    throw new HttpError(400, "任务已结束，无法取消");
  }

  cancelWorkspace(id);

  return getTask(id);
}

export function rerunTask(id: string, input: RerunTaskInput = {}): ConversionTask {
  const task = getTask(id);
  if (task.inputDataPath && !fs.existsSync(task.inputDataPath)) {
    throw new HttpError(400, "原始输入数据文件不存在，无法重新运行");
  }
  const template = getTemplate(task.templateId);
  const baseTaskName = task.taskName.replace(/(?:\s*-\s*重新运行)+$/, "").trim();
  const parameters = resetRerunOutputParameters(
    input.parameters ?? task.parameters,
    task,
    template.parameters,
    input.parameters !== undefined
  );

  return createAndRunTask({
    templateId: template.id,
    taskName: input.taskName?.trim() || `${baseTaskName} - 重新运行`,
    parameters,
    outputFormat: input.outputFormat === undefined ? task.outputFormat : input.outputFormat,
    inputDataName: task.inputDataName,
    inputDataPath: task.inputDataPath
  });
}

export function deleteResults(taskId: string): void {
  const task = getTask(taskId);
  if (["pending", "running"].includes(task.status)) {
    throw new HttpError(400, "任务仍在运行，无法删除成果文件");
  }
  const outputPath = path.join(outputStorageDir, taskId);
  assertPathInside(outputStorageDir, outputPath);
  const db = getDb();
  runTransaction(() => {
    db.prepare("DELETE FROM result_files WHERE taskId = ?").run(taskId);
    db.prepare("UPDATE conversion_tasks SET resultSize = 0, previewUrl = NULL, downloadUrl = NULL WHERE id = ?").run(taskId);
  });
  removeTaskArtifact(outputPath);
}

export function deleteTask(taskId: string): void {
  const task = getTask(taskId);

  deleteTaskRecord(task);
}

export function deleteTasks(taskIds: string[]): number {
  const uniqueIds = [...new Set(taskIds.map((id) => id.trim()).filter(Boolean))];
  if (!uniqueIds.length) {
    return 0;
  }

  const tasksById = new Map(listTasks().map((task) => [task.id, task]));
  const tasks = uniqueIds
    .map((id) => tasksById.get(id))
    .filter((task): task is ConversionTask => Boolean(task));

  tasks.forEach(deleteTaskRecord);
  return tasks.length;
}

export function clearTasks(): number {
  const tasks = listTasks();
  tasks.forEach(deleteTaskRecord);
  return tasks.length;
}

function deleteTaskRecord(task: ConversionTask): void {
  const taskId = task.id;

  if (["pending", "running"].includes(task.status)) {
    cancelWorkspace(taskId);
  }

  const outputPath = path.join(outputStorageDir, taskId);
  assertPathInside(outputStorageDir, outputPath);
  removeTaskArtifact(outputPath);

  const logPath = assertPathInside(logStorageDir, path.join(logStorageDir, `${taskId}.log`));
  removeTaskArtifact(logPath);

  const db = getDb();
  runTransaction(() => {
    db.prepare("DELETE FROM result_files WHERE taskId = ?").run(taskId);
    db.prepare("DELETE FROM conversion_tasks WHERE id = ?").run(taskId);
  });
}

async function executeTask(
  taskId: string,
  workspacePath: string,
  fmeParameters: Record<string, unknown>
): Promise<void> {
  const task = getTask(taskId);
  const startedAt = nowIso();
  const transition = getDb().prepare(
    `UPDATE conversion_tasks
     SET status = 'running',
         progress = 5,
         startedAt = ?,
         errorMessage = NULL
     WHERE id = ? AND status = 'pending'`
  ).run(startedAt, taskId);
  if (Number(transition.changes) === 0) {
    return;
  }

  const outputSnapshot = snapshotOutputFiles(task.outputPath);

  try {
    const runtimeParameters = enrichWorkspaceOutputParameters(
      fmeParameters,
      workspacePath,
      task.outputPath
    );
    const result = await runWorkspace({
      taskId,
      workspacePath,
      parameters: runtimeParameters,
      outputPath: task.outputPath,
      logPath: task.logPath,
      onProgress: (progress) => updateProgressIfRunning(taskId, progress)
    });

    const current = findTask(taskId);
    if (!current || current.status === "cancelled") {
      return;
    }

    updateProgressIfRunning(taskId, 95);
    const resultFiles = collectGeneratedFiles(taskId, task.outputPath, outputSnapshot);
    updateProgressIfRunning(taskId, 98);
    const success = result.exitCode === 0;
    const latestTask = findTask(taskId) ?? current;

    const finalized = finalizeTaskWithResultFiles(taskId, resultFiles.files, {
      status: success ? "success" : "failed",
      progress: success ? 100 : Math.max(latestTask.progress, 5),
      resultSize: resultFiles.resultSize,
      previewUrl: resultFiles.hasPreviewableFiles ? `/api/results/${taskId}/preview` : null,
      downloadUrl: resultFiles.hasDownloadableFiles ? `/api/results/${taskId}/download` : null,
      exitCode: result.exitCode,
      errorMessage: success ? null : `FME 进程退出码：${result.exitCode ?? "null"}`,
      finishedAt: nowIso(),
      duration: result.duration
    }, ["running"]);
    if (!finalized) {
      cleanupManagedResultCopies(taskId);
    }
  } catch (error) {
    const current = findTask(taskId);
    if (!current || current.status === "cancelled") {
      return;
    }
    const resultFiles = tryCollectGeneratedFiles(taskId, task.outputPath, outputSnapshot);
    const failurePatch: Partial<ConversionTask> = {
      status: "failed",
      progress: Math.max(current.progress, 5),
      resultSize: resultFiles?.resultSize ?? current.resultSize,
      previewUrl: resultFiles?.hasPreviewableFiles ? `/api/results/${taskId}/preview` : current.previewUrl,
      downloadUrl: resultFiles?.hasDownloadableFiles ? `/api/results/${taskId}/download` : current.downloadUrl,
      errorMessage: error instanceof Error ? error.message : "FME 执行失败",
      finishedAt: nowIso(),
      duration: current.startedAt ? Date.now() - new Date(current.startedAt).getTime() : null
    };
    if (resultFiles) {
      const finalized = finalizeTaskWithResultFiles(taskId, resultFiles.files, failurePatch, ["running"]);
      if (!finalized) {
        cleanupManagedResultCopies(taskId);
      }
    } else {
      updateTaskIfStatus(taskId, failurePatch, ["running"]);
    }
  }
}

function scheduleTaskExecution(
  taskId: string,
  workspacePath: string,
  fmeParameters: Record<string, unknown>
): void {
  setTimeout(() => {
    void executeTask(taskId, workspacePath, fmeParameters).catch((error) => {
      const current = findTask(taskId);
      if (!current || current.status === "cancelled") {
        return;
      }
      updateTaskIfStatus(taskId, {
        status: "failed",
        progress: 0,
        errorMessage: error instanceof Error ? error.message : "FME 执行调度失败",
        finishedAt: nowIso()
      }, ["pending", "running"]);
    });
  }, TASK_EXECUTION_START_DELAY_MS);
}

function collectGeneratedFiles(
  taskId: string,
  outputPath: string,
  outputSnapshot: OutputFileSnapshot
): GeneratedResultSummary {
  const generatedFiles = scanOutputFiles(taskId, outputPath, outputSnapshot);
  const files = syncResultFilesToManagedStorage(taskId, generatedFiles);
  return {
    files,
    resultSize: files.reduce((total, file) => total + file.fileSize, 0),
    hasPreviewableFiles: files.some((file) => isResultFilePreviewable(file)),
    hasDownloadableFiles: files.some((file) => file.downloadable)
  };
}

function tryCollectGeneratedFiles(
  taskId: string,
  outputPath: string,
  outputSnapshot: OutputFileSnapshot
): GeneratedResultSummary | null {
  try {
    return collectGeneratedFiles(taskId, outputPath, outputSnapshot);
  } catch {
    return null;
  }
}

function syncResultFilesToManagedStorage(taskId: string, files: GeneratedResultFile[]): GeneratedResultFile[] {
  const managedRoot = resultOutputPath(taskId);
  fs.mkdirSync(managedRoot, { recursive: true });

  return files.map((file) => {
    const relativeName = file.fileName.replace(/[\\/]+/g, path.sep);
    const managedPath = assertPathInside(managedRoot, path.join(managedRoot, relativeName));
    fs.mkdirSync(path.dirname(managedPath), { recursive: true });

    if (path.resolve(file.filePath) !== path.resolve(managedPath)) {
      fs.copyFileSync(file.filePath, managedPath);
    }

    const stat = fs.statSync(managedPath);
    return {
      ...file,
      fileSize: stat.size,
      filePath: managedPath
    };
  });
}

function finalizeTaskWithResultFiles(
  taskId: string,
  files: GeneratedResultFile[],
  patch: Partial<ConversionTask>,
  statuses: TaskStatus[]
): boolean {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO result_files (
      id, taskId, fileName, fileType, fileSize, filePath, downloadable, previewable, createdAt
    ) VALUES (
      @id, @taskId, @fileName, @fileType, @fileSize, @filePath, @downloadable, @previewable, @createdAt
    )`
  );

  try {
    return runTransaction(() => {
      if (!isTaskInStatus(taskId, statuses)) {
        return false;
      }
      db.prepare("DELETE FROM result_files WHERE taskId = ?").run(taskId);
      files.forEach((file) => {
        insert.run({
          ...file,
          id: randomUUID(),
          downloadable: file.downloadable ? 1 : 0,
          previewable: isResultFilePreviewable(file) ? 1 : 0,
          createdAt: nowIso()
        });
      });
      if (!updateTaskIfStatus(taskId, patch, statuses)) {
        throw new TaskFinalizeStateError();
      }
      return true;
    });
  } catch (error) {
    if (error instanceof TaskFinalizeStateError) {
      return false;
    }
    throw error;
  }
}

function cleanupManagedResultCopies(taskId: string): void {
  removeTaskArtifact(resultOutputPath(taskId));
}

function removeTaskArtifact(targetPath: string, retries = 8): void {
  try {
    removeIfExists(targetPath);
  } catch {
    if (retries <= 0) {
      return;
    }
    const timer = setTimeout(() => removeTaskArtifact(targetPath, retries - 1), 1000);
    timer.unref?.();
  }
}

function updateProgressIfRunning(taskId: string, progress: number): void {
  const task = findTask(taskId);
  if (!task || task.status !== "running") {
    return;
  }
  const next = Math.max(task.progress, Math.min(progress, 99));
  updateTaskIfStatus(taskId, { progress: next }, ["running"]);
}

function findTask(id: string): ConversionTask | null {
  try {
    return getTask(id);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function isTaskInStatus(id: string, statuses: TaskStatus[]): boolean {
  const row = getDb().prepare("SELECT status FROM conversion_tasks WHERE id = ?").get(id) as
    | { status: TaskStatus }
    | undefined;
  return Boolean(row && statuses.includes(row.status));
}

function updateTask(id: string, patch: Partial<ConversionTask>): void {
  updateTaskWhere(id, patch);
}

function updateTaskIfStatus(
  id: string,
  patch: Partial<ConversionTask>,
  statuses: TaskStatus[]
): boolean {
  return updateTaskWhere(id, patch, statuses);
}

function updateTaskWhere(
  id: string,
  patch: Partial<ConversionTask>,
  statuses?: TaskStatus[]
): boolean {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (!entries.length) {
    return false;
  }

  const fields = entries.map(([key]) => `${key} = @${key}`).join(", ");
  const values = Object.fromEntries(entries);
  const statusClause = statuses?.length
    ? ` AND status IN (${statuses.map((_, index) => `@status${index}`).join(", ")})`
    : "";
  const statusParams = Object.fromEntries(
    (statuses || []).map((status, index) => [`status${index}`, status])
  );
  const result = getDb().prepare(`UPDATE conversion_tasks SET ${fields} WHERE id = @id${statusClause}`).run({
    ...values,
    id,
    ...statusParams
  });
  return Number(result.changes) > 0;
}

function buildRuntimeParameters(
  parameters: Record<string, unknown>,
  inputDataPath: string | null,
  outputFormat: string | null,
  templateParameters: Array<Pick<
    TemplateParameter,
    "name" | "label" | "type" | "defaultValue" | "description" | "direction" | "pathKind"
  >>,
  outputPath: string
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...parameters };

  const outputParameterNames = new Set<string>();
  for (const parameter of templateParameters) {
    if (isOutputDirectoryParameter(parameter)) {
      outputParameterNames.add(parameter.name);
    }
  }
  for (const parameterName of outputParameterNames) {
    const currentValue = getCaseInsensitiveValue(merged, parameterName);
    if (!isAbsolutePathValue(currentValue)) {
      setCaseInsensitiveValue(merged, parameterName, outputPath);
    }
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

function enrichWorkspaceOutputParameters(
  parameters: Record<string, unknown>,
  workspacePath: string,
  outputPath: string
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...parameters };
  for (const parameterName of getWorkspaceOutputParameterNames(workspacePath)) {
    const currentValue = getCaseInsensitiveValue(merged, parameterName);
    if (!isAbsolutePathValue(currentValue)) {
      setCaseInsensitiveValue(merged, parameterName, outputPath);
    }
  }
  return merged;
}

function hasCaseInsensitiveKey(target: Record<string, unknown>, key: string): boolean {
  return Object.keys(target).some((candidate) => candidate.toUpperCase() === key.toUpperCase());
}

function getCaseInsensitiveValue(target: Record<string, unknown>, key: string): unknown {
  const existingKey = Object.keys(target).find((candidate) => candidate.toUpperCase() === key.toUpperCase());
  return existingKey ? target[existingKey] : undefined;
}

function setCaseInsensitiveValue(target: Record<string, unknown>, key: string, value: unknown): void {
  const existingKey = Object.keys(target).find((candidate) => candidate.toUpperCase() === key.toUpperCase());
  target[existingKey || key] = value;
}

function deleteCaseInsensitiveValue(target: Record<string, unknown>, key: string): void {
  const existingKey = Object.keys(target).find((candidate) => candidate.toUpperCase() === key.toUpperCase());
  if (existingKey) {
    delete target[existingKey];
  }
}

function resetRerunOutputParameters(
  parameters: Record<string, unknown>,
  task: ConversionTask,
  templateParameters: Array<Pick<
    TemplateParameter,
    "name" | "label" | "type" | "defaultValue" | "description" | "direction" | "pathKind"
  >>,
  preserveExplicitCustomPaths: boolean
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...parameters };
  const outputParameterNames = new Set(["OUTPUT_DIR", "OUTPUT_DIRECTORY", "OUTPUT_PATH"]);
  for (const parameter of templateParameters) {
    if (isOutputDirectoryParameter(parameter)) {
      outputParameterNames.add(parameter.name);
    }
  }

  for (const parameterName of outputParameterNames) {
    const currentValue = getCaseInsensitiveValue(merged, parameterName);
    if (currentValue === undefined) {
      continue;
    }
    if (!preserveExplicitCustomPaths || pathValueInsideTaskOutput(currentValue, task.outputPath)) {
      deleteCaseInsensitiveValue(merged, parameterName);
    }
  }
  return merged;
}

function pathValueInsideTaskOutput(value: unknown, outputPath: string): boolean {
  const selectedPath = firstAbsolutePath(value);
  if (!selectedPath) {
    return false;
  }
  const normalizedOutputPath = path.resolve(outputPath).toLowerCase();
  const normalizedSelectedPath = path.resolve(selectedPath).toLowerCase();
  return (
    normalizedSelectedPath === normalizedOutputPath ||
    normalizedSelectedPath.startsWith(`${normalizedOutputPath}${path.sep}`)
  );
}

function resolveTaskOutputPath(
  parameters: Record<string, unknown>,
  templateParameters: Array<Pick<
    TemplateParameter,
    "name" | "label" | "type" | "defaultValue" | "description" | "direction" | "pathKind"
  >>,
  fallbackPath: string
): string {
  for (const parameter of templateParameters) {
    if (!isOutputDirectoryParameter(parameter)) {
      continue;
    }
    const selectedPath = firstAbsolutePath(getCaseInsensitiveValue(parameters, parameter.name));
    if (!selectedPath) {
      continue;
    }
    return parameter.pathKind === "file" ? path.dirname(selectedPath) : selectedPath;
  }
  return fallbackPath;
}

function isAbsolutePathValue(value: unknown): boolean {
  return Boolean(firstAbsolutePath(value));
}

function firstAbsolutePath(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== "string") {
    return null;
  }
  const normalized = candidate.trim().replace(/^["']|["']$/g, "");
  return normalized && path.isAbsolute(normalized) ? path.resolve(normalized) : null;
}

function isResultFilePreviewable(
  file: Pick<ResultFile, "fileName" | "fileSize" | "previewable">
): boolean {
  const fileType = getResultFileType(file.fileName);
  const exceedsJsonPreviewLimit =
    fileType === "json" &&
    file.fileSize > 5 * 1024 * 1024;
  return Boolean(file.previewable) && isPreviewable(file.fileName) && !exceedsJsonPreviewLimit;
}

function mapTaskRow(row: TaskRow): ConversionTask {
  const derivedDuration = row.startedAt && row.finishedAt
    ? Math.max(0, new Date(row.finishedAt).getTime() - new Date(row.startedAt).getTime())
    : null;
  return {
    ...row,
    rerunnable: Boolean(row.rerunnable) && (!row.inputDataPath || fs.existsSync(row.inputDataPath)),
    duration: row.duration ?? derivedDuration,
    parameters: safeJsonObject(row.parameters)
  };
}

function mapResultFileRow(row: ResultFileRow): ResultFile {
  const fileType = getResultFileType(row.fileName);
  return {
    ...row,
    fileType,
    downloadable: Boolean(row.downloadable),
    previewable: isResultFilePreviewable({
      fileName: row.fileName,
      fileSize: row.fileSize,
      previewable: Boolean(row.previewable)
    })
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
