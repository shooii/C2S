import { useEffect, useState } from "react";
import { Drawer, Empty, Spin } from "antd";
import { api } from "../services/api";
import type { ConversionTask } from "../types";

interface LogDrawerProps {
  task: ConversionTask | null;
  open: boolean;
  onClose: () => void;
}

export function LogDrawer({ task, open, onClose }: LogDrawerProps) {
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState("");

  useEffect(() => {
    if (!open || !task) {
      return;
    }

    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const nextLog = await api.getTaskLogs(task.id);
        if (!cancelled) setLog(nextLog);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    const timer = task.status === "running" ? window.setInterval(load, 3000) : undefined;
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [open, task]);

  return (
    <Drawer
      width="min(760px, calc(100vw - 24px))"
      title={task ? `${task.taskName} 运行日志` : "运行日志"}
      open={open}
      onClose={onClose}
    >
      {loading && !log ? (
        <div className="center-state">
          <Spin />
        </div>
      ) : log ? (
        <pre className="log-view">{log}</pre>
      ) : (
        <Empty description="暂无日志" />
      )}
    </Drawer>
  );
}
