import type { ConversionTask } from "../types";

export const TASK_SUBMISSION_SETTLED_EVENT = "c2s:task-submission-settled";

const createdTasks = new Map<string, ConversionTask>();

export function publishCreatedTask(task: ConversionTask): void {
  createdTasks.set(task.id, task);
  window.dispatchEvent(new Event(TASK_SUBMISSION_SETTLED_EVENT));
}

export function notifyTaskSubmissionSettled(): void {
  window.dispatchEvent(new Event(TASK_SUBMISSION_SETTLED_EVENT));
}

export function consumeCreatedTasks(): ConversionTask[] {
  const tasks = [...createdTasks.values()].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  createdTasks.clear();
  return tasks;
}
