export type ParseStatus = "pending" | "parsing" | "success" | "failed";
export type TaskStatus = "pending" | "running" | "success" | "failed" | "cancelled";

export type ParameterType =
  | "string"
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "enum"
  | "multi_choice"
  | "checkbox_group"
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

export interface TemplateRecord {
  id: string;
  name: string;
  fileName: string;
  fileType: ".fmw" | ".fmwt";
  filePath: string;
  description: string | null;
  inputDataType: string | null;
  outputDataType: string | null;
  parameterCount: number;
  parseStatus: ParseStatus;
  parseMessage: string | null;
  version: string | null;
  tags: string[];
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
  options: string[];
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
