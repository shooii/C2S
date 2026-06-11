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

CREATE INDEX IF NOT EXISTS idx_templates_group_id
  ON templates(groupId);

CREATE TABLE IF NOT EXISTS template_parameters (
  id TEXT PRIMARY KEY,
  templateId TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL,
  defaultValue TEXT,
  required INTEGER NOT NULL DEFAULT 0,
  options TEXT NOT NULL DEFAULT '[]',
  direction TEXT NOT NULL DEFAULT 'none',
  pathKind TEXT,
  multiple INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  sortOrder INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (templateId) REFERENCES templates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_template_parameters_template_id
  ON template_parameters(templateId);

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

CREATE INDEX IF NOT EXISTS idx_conversion_tasks_template_id
  ON conversion_tasks(templateId);

CREATE INDEX IF NOT EXISTS idx_conversion_tasks_status
  ON conversion_tasks(status);

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

CREATE INDEX IF NOT EXISTS idx_result_files_task_id
  ON result_files(taskId);
