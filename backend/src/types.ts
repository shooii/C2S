export type ParseStatus = "pending" | "parsing" | "success" | "failed";
export type TaskStatus = "pending" | "running" | "success" | "failed" | "cancelled";

export type ParameterType =
  | "string"
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "enum"
  | "choice_alias"
  | "multi_choice"
  | "checkbox_group"
  | "date"
  | "time"
  | "datetime"
  | "file"
  | "folder"
  | "path"
  | "url"
  | "password"
  | "message"
  | "color"
  | "table"
  | "encoding"
  | "source_dataset"
  | "destination_dataset"
  | "attribute_name"
  | "feature_type"
  | "attribute_select"
  | "attribute_expose"
  | "coordinate_system"
  | "geometry"
  | "reprojection_file"
  | "database_connection"
  | "web_connection"
  | "scripted_selection"
  | "scripted_value"
  | "output_format";

export type ParameterDirection = "input" | "output" | "none";
export type ParameterPathKind = "file" | "folder" | null;

export interface ParameterOption {
  label: string;
  value: string;
}

export type ParameterVisibilityRule = Record<string, unknown>;

export interface TemplateRecord {
  id: string;
  groupId: string;
  name: string;
  fileName: string;
  fileType: ".fmw" | ".fmwt";
  filePath: string;
  description: string | null;
  inputDataType: string | null;
  outputDataType: string | null;
  parameterCount: number;
  enabled: boolean;
  parseStatus: ParseStatus;
  parseMessage: string | null;
  version: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TemplateGroup {
  id: string;
  name: string;
  description: string | null;
  builtIn: boolean;
  templateCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateParameter {
  id: string;
  templateId: string;
  name: string;
  label: string;
  type: ParameterType;
  defaultValue: string | null;
  required: boolean;
  options: ParameterOption[];
  direction: ParameterDirection;
  pathKind: ParameterPathKind;
  multiple: boolean;
  visibility: ParameterVisibilityRule | null;
  description: string | null;
  sortOrder: number;
}

export interface TemplateDetail extends TemplateRecord {
  parameters: TemplateParameter[];
}

export interface ConversionTask {
  id: string;
  taskName: string;
  templateId: string;
  templateName: string;
  rerunnable: boolean;
  inputDataName: string | null;
  inputDataPath: string | null;
  status: TaskStatus;
  progress: number;
  parameters: Record<string, unknown>;
  outputFormat: string | null;
  outputPath: string;
  resultSize: number;
  previewUrl: string | null;
  downloadUrl: string | null;
  logPath: string;
  exitCode: number | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  duration: number | null;
}

export interface ResultFile {
  id: string;
  taskId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  filePath: string;
  downloadable: boolean;
  previewable: boolean;
  createdAt: string;
}

export interface ApiResponse<T> {
  data: T;
  message?: string;
}
