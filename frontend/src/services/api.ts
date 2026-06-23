import axios from "axios";
import type {
  ConversionTask,
  FmeStatus,
  PreviewPayload,
  PreviewState,
  ResultFile,
  ResultFileBrowserPage,
  TaskStatus,
  TemplateDetail,
  TemplateGroup,
  TemplateRecord
} from "../types";

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "http://localhost:4000").replace(/\/$/, "");

interface ApiEnvelope<T> {
  data: T;
  message?: string;
}

const http = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30_000
});

const LOCAL_PATH_SELECTION_TIMEOUT_MS = 60_000;

http.interceptors.response.use(
  (response) => response,
  (error) => {
    const message = error.response?.data?.message || error.message || "请求失败";
    return Promise.reject(new Error(message));
  }
);

async function unwrap<T>(request: Promise<{ data: ApiEnvelope<T> }>): Promise<T> {
  const response = await request;
  return response.data.data;
}

export const api = {
  getFmeStatus: () => unwrap<FmeStatus>(http.get("/api/fme/status")),

  selectLocalPath: (payload: {
    kind: "file" | "folder";
    initialPath?: string;
    multiple?: boolean;
    title?: string;
  }, options?: { signal?: AbortSignal }) =>
    unwrap<{ cancelled: boolean; paths: string[] }>(
      http.post("/api/local-paths/select", payload, {
        signal: options?.signal,
        timeout: LOCAL_PATH_SELECTION_TIMEOUT_MS
      })
    ).catch((error) => {
      if (error instanceof Error && /timeout|aborted|canceled/i.test(error.message)) {
        throw new Error("本地路径选择窗口未响应，请重试");
      }
      throw error;
    }),

  listTemplates: (params?: { search?: string; enabled?: boolean }) =>
    unwrap<TemplateRecord[]>(http.get("/api/templates", { params })),

  getTemplate: (id: string) => unwrap<TemplateDetail>(http.get(`/api/templates/${id}`)),

  parseTemplate: (
    id: string,
    payload?: { parameterLabels?: Array<{ id: string; name: string; label: string }> }
  ) => unwrap<TemplateDetail>(http.post(`/api/templates/${id}/parse`, payload || {})),

  updateTemplateConfiguration: (
    id: string,
    payload: {
      description?: string | null;
      version?: string | null;
      enabled?: boolean;
      parameterLabels?: Array<{ id: string; label: string }>;
    }
  ) => unwrap<TemplateDetail>(http.patch(`/api/templates/${id}`, payload)),

  listTemplateGroups: () => unwrap<TemplateGroup[]>(http.get("/api/template-groups")),

  createTemplateGroup: (name: string) =>
    unwrap<TemplateGroup>(http.post("/api/template-groups", { name })),

  updateTemplateGroup: (id: string, name: string) =>
    unwrap<TemplateGroup>(http.patch(`/api/template-groups/${id}`, { name })),

  deleteTemplateGroup: (id: string) => http.delete(`/api/template-groups/${id}`),

  assignTemplateGroup: (templateId: string, groupId: string) =>
    unwrap<TemplateDetail>(http.patch(`/api/templates/${templateId}/group`, { groupId })),

  uploadTemplate: (
    file: File,
    groupId: string,
    uploadToken: string,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal
  ) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("groupId", groupId);
    formData.append("uploadToken", uploadToken);
    return unwrap<TemplateDetail>(
      http.post("/api/templates/upload", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        signal,
        onUploadProgress: (event) => {
          if (event.total && onProgress) {
            onProgress(Math.round((event.loaded / event.total) * 100));
          }
        }
      })
    );
  },

  replaceTemplate: (
    id: string,
    file: File,
    uploadToken: string,
    onProgress?: (percent: number) => void,
    signal?: AbortSignal
  ) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("uploadToken", uploadToken);
    return unwrap<TemplateDetail>(
      http.post(`/api/templates/${id}/replace`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
        signal,
        onUploadProgress: (event) => {
          if (event.total && onProgress) {
            onProgress(Math.round((event.loaded / event.total) * 100));
          }
        }
      })
    );
  },

  cancelTemplateUpload: (uploadToken: string) =>
    http.post(`/api/templates/upload-cancellations/${encodeURIComponent(uploadToken)}`),

  deleteTemplate: (id: string) => http.delete(`/api/templates/${id}`),

  runTask: (payload: {
    templateId: string;
    taskName?: string;
    parameters: Record<string, unknown>;
    outputFormat?: string;
    inputFile?: File | null;
    parameterUploads?: Array<{
      parameterName: string;
      kind: "file" | "folder";
      files: File[];
    }>;
  }) => {
    const formData = new FormData();
    const uploadManifest: Array<{
      parameterName: string;
      kind: "file" | "folder";
      relativePath: string;
    }> = [];
    formData.append("templateId", payload.templateId);
    if (payload.taskName) formData.append("taskName", payload.taskName);
    if (payload.outputFormat) formData.append("outputFormat", payload.outputFormat);
    formData.append("parameters", JSON.stringify(payload.parameters || {}));
    if (payload.inputFile) formData.append("inputData", payload.inputFile);
    payload.parameterUploads?.forEach((upload) => {
      upload.files.forEach((file) => {
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        formData.append("parameterFiles", file, file.name);
        uploadManifest.push({
          parameterName: upload.parameterName,
          kind: upload.kind,
          relativePath
        });
      });
    });
    if (uploadManifest.length) {
      formData.append("parameterUploadManifest", JSON.stringify(uploadManifest));
    }
    return unwrap<ConversionTask>(
      http.post("/api/tasks/run", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 0
      })
    );
  },

  listTasks: (params?: { search?: string; status?: TaskStatus }) =>
    unwrap<ConversionTask[]>(http.get("/api/tasks", { params })),

  getTask: (id: string) => unwrap<ConversionTask>(http.get(`/api/tasks/${id}`)),

  getTaskLogs: async (id: string, options?: { tailBytes?: number }) => {
    const response = await http.get<string>(`/api/tasks/${id}/logs`, {
      params: options?.tailBytes ? { tailBytes: options.tailBytes } : undefined,
      responseType: "text"
    });
    return response.data;
  },

  cancelTask: (id: string) => unwrap<ConversionTask>(http.post(`/api/tasks/${id}/cancel`)),

  rerunTask: (
    id: string,
    payload?: {
      taskName?: string;
      parameters?: Record<string, unknown>;
      outputFormat?: string | null;
    }
  ) => unwrap<ConversionTask>(http.post(`/api/tasks/${id}/rerun`, payload || {})),

  getResultFiles: (taskId: string) => unwrap<ResultFile[]>(http.get(`/api/results/${taskId}/files`)),

  browseResultFiles: (
    taskId: string,
    params?: { folder?: string; search?: string; page?: number; pageSize?: number }
  ) => unwrap<ResultFileBrowserPage>(http.get(`/api/results/${taskId}/files`, { params })),

  getPreview: (taskId: string, fileId?: string) =>
    unwrap<PreviewPayload>(http.get(`/api/results/${taskId}/preview`, {
      params: fileId ? { fileId } : undefined
    })),

  updatePreviewState: (taskId: string, fileId: string, previewState: PreviewState | null) =>
    unwrap<ResultFile>(http.patch(`/api/results/${taskId}/files/${fileId}/preview-state`, {
      previewState
    })),

  deleteResults: (taskId: string) => http.delete(`/api/results/${taskId}`),

  deleteTask: (taskId: string) => http.delete(`/api/tasks/${taskId}`),

  deleteTasks: (taskIds: string[]) =>
    unwrap<{ deletedCount: number }>(http.post("/api/tasks/batch-delete", { ids: taskIds })),

  clearTasks: () =>
    unwrap<{ deletedCount: number }>(http.delete("/api/tasks")),

  downloadArchiveUrl: (taskId: string) => `${API_BASE_URL}/api/results/${taskId}/download`,

  downloadUrl: (taskId: string, fileId: string) => `${API_BASE_URL}/api/results/${taskId}/download/${fileId}`,

  previewContentUrl: (taskId: string, fileName: string) => {
    const encodedName = fileName
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
    return `/api/results/${encodeURIComponent(taskId)}/content/${encodedName}`;
  },

  absoluteUrl: (url?: string) => {
    if (!url) return "";
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(url)) return url;
    return `${API_BASE_URL}${url.startsWith("/") ? "" : "/"}${url}`;
  }
};
