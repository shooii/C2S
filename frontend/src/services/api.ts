import axios from "axios";
import type {
  ConversionTask,
  FmeStatus,
  PreviewPayload,
  ResultFile,
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

  listTemplates: (params?: { search?: string; parseStatus?: string }) =>
    unwrap<TemplateRecord[]>(http.get("/api/templates", { params })),

  getTemplate: (id: string) => unwrap<TemplateDetail>(http.get(`/api/templates/${id}`)),

  listTemplateGroups: () => unwrap<TemplateGroup[]>(http.get("/api/template-groups")),

  createTemplateGroup: (name: string) =>
    unwrap<TemplateGroup>(http.post("/api/template-groups", { name })),

  updateTemplateGroup: (id: string, name: string) =>
    unwrap<TemplateGroup>(http.patch(`/api/template-groups/${id}`, { name })),

  deleteTemplateGroup: (id: string) => http.delete(`/api/template-groups/${id}`),

  assignTemplateGroup: (templateId: string, groupId: string) =>
    unwrap<TemplateDetail>(http.patch(`/api/templates/${templateId}/group`, { groupId })),

  uploadTemplate: (file: File, onProgress?: (percent: number) => void) => {
    const formData = new FormData();
    formData.append("file", file);
    return unwrap<TemplateDetail>(
      http.post("/api/templates/upload", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: (event) => {
          if (event.total && onProgress) {
            onProgress(Math.round((event.loaded / event.total) * 100));
          }
        }
      })
    );
  },

  parseTemplate: (id: string) => unwrap<TemplateDetail>(http.post(`/api/templates/${id}/parse`)),

  deleteTemplate: (id: string) => http.delete(`/api/templates/${id}`),

  runTask: (payload: {
    templateId: string;
    taskName?: string;
    parameters: Record<string, unknown>;
    outputFormat?: string;
    inputFile?: File | null;
  }) => {
    const formData = new FormData();
    formData.append("templateId", payload.templateId);
    if (payload.taskName) formData.append("taskName", payload.taskName);
    if (payload.outputFormat) formData.append("outputFormat", payload.outputFormat);
    formData.append("parameters", JSON.stringify(payload.parameters || {}));
    if (payload.inputFile) formData.append("inputData", payload.inputFile);
    return unwrap<ConversionTask>(
      http.post("/api/tasks/run", formData, {
        headers: { "Content-Type": "multipart/form-data" }
      })
    );
  },

  listTasks: (params?: { search?: string; status?: TaskStatus }) =>
    unwrap<ConversionTask[]>(http.get("/api/tasks", { params })),

  getTask: (id: string) => unwrap<ConversionTask>(http.get(`/api/tasks/${id}`)),

  getTaskLogs: async (id: string) => {
    const response = await http.get<string>(`/api/tasks/${id}/logs`, { responseType: "text" });
    return response.data;
  },

  cancelTask: (id: string) => unwrap<ConversionTask>(http.post(`/api/tasks/${id}/cancel`)),

  rerunTask: (id: string) => unwrap<ConversionTask>(http.post(`/api/tasks/${id}/rerun`)),

  getResultFiles: (taskId: string) => unwrap<ResultFile[]>(http.get(`/api/results/${taskId}/files`)),

  getPreview: (taskId: string) => unwrap<PreviewPayload>(http.get(`/api/results/${taskId}/preview`)),

  deleteResults: (taskId: string) => http.delete(`/api/results/${taskId}`),

  deleteTask: (taskId: string) => http.delete(`/api/tasks/${taskId}`),

  downloadUrl: (taskId: string, fileId: string) => `${API_BASE_URL}/api/results/${taskId}/download/${fileId}`,

  absoluteUrl: (url?: string) => {
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    return `${API_BASE_URL}${url.startsWith("/") ? "" : "/"}${url}`;
  }
};
