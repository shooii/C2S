import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  databasePath,
  ensureStorageDirs,
  inputStorageDir,
  logStorageDir,
  outputStorageDir,
  templateStorageDir
} from "../config/paths";

const schemaSql = `
CREATE TABLE IF NOT EXISTS template_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  builtIn INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  groupId TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  fileName TEXT NOT NULL,
  fileType TEXT NOT NULL,
  filePath TEXT NOT NULL,
  description TEXT,
  inputDataType TEXT,
  outputDataType TEXT,
  parameterCount INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0,
  parseStatus TEXT NOT NULL DEFAULT 'pending',
  parseMessage TEXT,
  version TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS template_parameters (
  id TEXT PRIMARY KEY,
  templateId TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  defaultValue TEXT,
  required INTEGER NOT NULL DEFAULT 0,
  options TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (templateId) REFERENCES templates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_template_parameters_template_id ON template_parameters(templateId);

CREATE TABLE IF NOT EXISTS conversion_tasks (
  id TEXT PRIMARY KEY,
  taskName TEXT NOT NULL,
  templateId TEXT NOT NULL,
  templateName TEXT NOT NULL,
  inputDataName TEXT,
  inputDataPath TEXT,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  parameters TEXT NOT NULL DEFAULT '{}',
  outputFormat TEXT,
  outputPath TEXT NOT NULL,
  resultSize INTEGER NOT NULL DEFAULT 0,
  previewUrl TEXT,
  downloadUrl TEXT,
  logPath TEXT NOT NULL,
  exitCode INTEGER,
  errorMessage TEXT,
  createdAt TEXT NOT NULL,
  startedAt TEXT,
  finishedAt TEXT,
  duration INTEGER
);

CREATE INDEX IF NOT EXISTS idx_conversion_tasks_template_id ON conversion_tasks(templateId);
CREATE INDEX IF NOT EXISTS idx_conversion_tasks_status ON conversion_tasks(status);

CREATE TABLE IF NOT EXISTS result_files (
  id TEXT PRIMARY KEY,
  taskId TEXT NOT NULL,
  fileName TEXT NOT NULL,
  fileType TEXT NOT NULL,
  fileSize INTEGER NOT NULL DEFAULT 0,
  filePath TEXT NOT NULL,
  downloadable INTEGER NOT NULL DEFAULT 1,
  previewable INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (taskId) REFERENCES conversion_tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_result_files_task_id ON result_files(taskId);
`;

type SqliteDatabase = InstanceType<typeof DatabaseSync>;

let db: SqliteDatabase | null = null;

export function getDb(): SqliteDatabase {
  if (db) {
    return db;
  }

  ensureStorageDirs();
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  db = new DatabaseSync(databasePath);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(schemaSql);
  migrateDatabase(db);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function runTransaction<T>(handler: () => T): T {
  const database = getDb();
  database.exec("BEGIN");
  try {
    const result = handler();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function migrateDatabase(database: SqliteDatabase): void {
  const templateColumns = database.prepare("PRAGMA table_info(templates)").all() as unknown as Array<{ name: string }>;
  if (!templateColumns.some((column) => column.name === "groupId")) {
    database.exec("ALTER TABLE templates ADD COLUMN groupId TEXT NOT NULL DEFAULT 'default'");
  }
  if (!templateColumns.some((column) => column.name === "enabled")) {
    database.exec("ALTER TABLE templates ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
  }
  database.exec("CREATE INDEX IF NOT EXISTS idx_templates_group_id ON templates(groupId)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_templates_enabled ON templates(enabled)");
  const duplicateTemplateName = database.prepare(
    `SELECT 1
     FROM templates
     GROUP BY groupId, lower(name)
     HAVING COUNT(*) > 1
     LIMIT 1`
  ).get();
  if (!duplicateTemplateName) {
    database.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_group_name_unique ON templates(groupId, name COLLATE NOCASE)"
    );
  }

  const groupCount = database.prepare("SELECT COUNT(*) AS count FROM template_groups").get() as { count: number };
  if (groupCount.count > 0) {
    migrateStoragePaths(database);
    return;
  }

  const timestamp = nowIso();
  const insert = database.prepare(
    `INSERT INTO template_groups (id, name, description, builtIn, createdAt, updatedAt)
     VALUES (@id, @name, @description, 1, @createdAt, @updatedAt)`
  );
  [
    ["default", "默认分组", "未分类模板"],
    ["conversion", "数据转换", "格式转换、数据入库和批处理"],
    ["spatial", "空间处理", "坐标、几何和空间数据处理"],
    ["quality", "质检检查", "数据质量检查和治理"],
    ["publish", "发布服务", "成果发布、服务生成和接口模板"]
  ].forEach(([id, name, description]) => {
    insert.run({ id, name, description, createdAt: timestamp, updatedAt: timestamp });
  });
  migrateStoragePaths(database);
}

function migrateStoragePaths(database: SqliteDatabase): void {
  const templates = database.prepare("SELECT id, filePath FROM templates").all() as unknown as Array<{
    id: string;
    filePath: string;
  }>;
  const updateTemplate = database.prepare("UPDATE templates SET filePath = ? WHERE id = ?");
  templates.forEach((template) => {
    const targetPath = path.join(templateStorageDir, path.basename(template.filePath));
    if (path.resolve(template.filePath) !== path.resolve(targetPath)) {
      updateTemplate.run(targetPath, template.id);
    }
  });

  const tasks = database.prepare(
    "SELECT id, inputDataPath, outputPath, logPath FROM conversion_tasks"
  ).all() as unknown as Array<{
    id: string;
    inputDataPath: string | null;
    outputPath: string;
    logPath: string;
  }>;
  const updateTask = database.prepare(
    "UPDATE conversion_tasks SET inputDataPath = ?, outputPath = ?, logPath = ? WHERE id = ?"
  );
  tasks.forEach((task) => {
    const inputDataPath = task.inputDataPath
      ? path.join(inputStorageDir, path.basename(task.inputDataPath))
      : null;
    const outputPath = path.join(outputStorageDir, task.id);
    const logPath = path.join(logStorageDir, `${task.id}.log`);
    const inputChanged = inputDataPath
      ? path.resolve(task.inputDataPath!) !== path.resolve(inputDataPath)
      : task.inputDataPath !== null;

    if (
      inputChanged ||
      path.resolve(task.outputPath) !== path.resolve(outputPath) ||
      path.resolve(task.logPath) !== path.resolve(logPath)
    ) {
      updateTask.run(inputDataPath, outputPath, logPath, task.id);
    }
  });

  const resultFiles = database.prepare(
    "SELECT id, taskId, fileName, filePath FROM result_files"
  ).all() as unknown as Array<{ id: string; taskId: string; fileName: string; filePath: string }>;
  const updateResultFile = database.prepare("UPDATE result_files SET filePath = ? WHERE id = ?");
  resultFiles.forEach((file) => {
    const taskRoot = path.join(outputStorageDir, file.taskId);
    const relativeName = file.fileName.replace(/[\\/]+/g, path.sep);
    const target = path.resolve(taskRoot, relativeName);
    const relative = path.relative(taskRoot, target);
    if (
      !relative.startsWith("..") &&
      !path.isAbsolute(relative) &&
      path.resolve(file.filePath) !== target
    ) {
      updateResultFile.run(target, file.id);
    }
  });
}
