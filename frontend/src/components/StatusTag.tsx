import { Tag } from "antd";
import type { ParseStatus, TaskStatus } from "../types";

const parseStatusMap: Record<ParseStatus, { color: string; text: string }> = {
  pending: { color: "default", text: "待解析" },
  parsing: { color: "processing", text: "解析中" },
  success: { color: "success", text: "解析成功" },
  failed: { color: "error", text: "解析失败" }
};

const taskStatusMap: Record<TaskStatus, { color: string; text: string }> = {
  pending: { color: "default", text: "排队中" },
  running: { color: "processing", text: "运行中" },
  success: { color: "success", text: "成功" },
  failed: { color: "error", text: "失败" },
  cancelled: { color: "default", text: "已取消" }
};

export function ParseStatusTag({ status }: { status: ParseStatus }) {
  const meta = parseStatusMap[status] || parseStatusMap.pending;
  return <Tag color={meta.color}>{meta.text}</Tag>;
}

export function TaskStatusTag({ status }: { status: TaskStatus }) {
  const meta = taskStatusMap[status] || taskStatusMap.pending;
  return <Tag color={meta.color}>{meta.text}</Tag>;
}

