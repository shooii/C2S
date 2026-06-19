import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  App,
  Button,
  Card,
  Empty,
  Input,
  Progress,
  Select,
  Space,
  Statistic,
  Table,
  Tooltip,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  DeleteOutlined,
  DownloadOutlined,
  EyeOutlined,
  ReloadOutlined,
  SearchOutlined,
  StopOutlined
} from "@ant-design/icons";
import dayjs from "dayjs";
import { useLocation, useNavigate } from "react-router-dom";
import { RerunTaskModal } from "../../components/RerunTaskModal";
import { TaskStatusTag } from "../../components/StatusTag";
import { api } from "../../services/api";
import { startDownload } from "../../services/download";
import {
  consumeCreatedTasks,
  TASK_SUBMISSION_SETTLED_EVENT
} from "../../services/taskSubmission";
import type { ConversionTask, TaskStatus } from "../../types";

const MANAGEMENT_PAGE_SIZE = 10;
type StateUpdater<T> = T | ((current: T) => T);

let resultManageTaskCache: ConversionTask[] | null = null;

export default function ResultManage() {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [allTasks, setAllTasks] = useState<ConversionTask[]>(() => resultManageTaskCache ?? []);
  const [loading, setLoading] = useState(() => resultManageTaskCache === null);
  const [deleting, setDeleting] = useState(false);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [cancellingTaskId, setCancellingTaskId] = useState<string | null>(null);
  const [rerunTask, setRerunTask] = useState<ConversionTask | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<TaskStatus | undefined>();
  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const foregroundLoadSeqRef = useRef(0);
  const actionBusyRef = useRef(false);
  const mountedRef = useRef(true);

  const setAllTasksCached = useCallback((updater: StateUpdater<ConversionTask[]>) => {
    setAllTasks((current) => {
      const next = typeof updater === "function" ? updater(current) : updater;
      resultManageTaskCache = next;
      return next;
    });
  }, []);

  const filteredTasks = useMemo(() => {
    let list = allTasks;
    if (status) {
      list = list.filter((t) => t.status === status);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (t) =>
          t.taskName.toLowerCase().includes(q) ||
          t.id.toLowerCase().includes(q) ||
          (t.templateName && t.templateName.toLowerCase().includes(q)) ||
          (t.inputDataName && t.inputDataName.toLowerCase().includes(q))
      );
    }
    return list;
  }, [allTasks, search, status]);

  const loadTasks = useCallback(async (background = false) => {
    const seq = ++requestSeqRef.current;
    const foregroundSeq = background ? null : ++foregroundLoadSeqRef.current;
    const hasCache = resultManageTaskCache !== null;
    if (!background && !hasCache) {
      setLoading(true);
    }
    try {
      const result = await api.listTasks({});
      if (!mountedRef.current || seq < appliedSeqRef.current) {
        return result;
      }
      appliedSeqRef.current = seq;
      setAllTasksCached(result);
      setSelectedTaskIds((current) => {
        const availableIds = new Set(result.map((task) => task.id));
        return current.filter((id) => availableIds.has(id));
      });
      return result;
    } catch (error) {
      if (mountedRef.current && seq >= appliedSeqRef.current && (!background || !hasCache)) {
        message.error(error instanceof Error ? error.message : "任务列表加载失败");
      }
      return [];
    } finally {
      if (mountedRef.current && foregroundSeq !== null && foregroundSeq === foregroundLoadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [message, setAllTasksCached]);

  useEffect(() => {
    void loadTasks(resultManageTaskCache !== null);
  }, [loadTasks]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const cancelledSeq = ++requestSeqRef.current;
      appliedSeqRef.current = Math.max(appliedSeqRef.current, cancelledSeq);
      foregroundLoadSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const applyCreatedTasks = () => {
      const createdTasks = consumeCreatedTasks();
      if (!createdTasks.length) {
        return false;
      }
      const invalidatedSeq = ++requestSeqRef.current;
      appliedSeqRef.current = Math.max(appliedSeqRef.current, invalidatedSeq);
      const createdTaskIds = new Set(createdTasks.map((task) => task.id));
      setAllTasksCached((current) => [
        ...createdTasks,
        ...current.filter((task) => !createdTaskIds.has(task.id))
      ]);
      return true;
    };
    const handleTaskSubmissionSettled = () => {
      applyCreatedTasks();
      void loadTasks(true);
    };
    if (applyCreatedTasks()) {
      void loadTasks(true);
    }
    window.addEventListener(TASK_SUBMISSION_SETTLED_EVENT, handleTaskSubmissionSettled);
    return () => {
      window.removeEventListener(TASK_SUBMISSION_SETTLED_EVENT, handleTaskSubmissionSettled);
    };
  }, [loadTasks, setAllTasksCached]);

  const pendingTaskSubmittedAt = (
    location.state as { pendingTaskSubmittedAt?: number } | null
  )?.pendingTaskSubmittedAt;

  useEffect(() => {
    if (!pendingTaskSubmittedAt) {
      return;
    }

    let disposed = false;
    let timer: number | undefined;
    const pollForCreatedTask = async () => {
      const tasks = await loadTasks(true);
      if (disposed) {
        return;
      }
      const taskAppeared = tasks.some(
        (task) => new Date(task.createdAt).getTime() >= pendingTaskSubmittedAt - 1000
      );
      if (taskAppeared || Date.now() - pendingTaskSubmittedAt >= 15_000) {
        navigate("/results", { replace: true });
        return;
      }
      timer = window.setTimeout(pollForCreatedTask, 750);
    };

    timer = window.setTimeout(pollForCreatedTask, 250);
    return () => {
      disposed = true;
      if (timer) {
        window.clearTimeout(timer);
      }
    };
  }, [loadTasks, navigate, pendingTaskSubmittedAt]);

  useEffect(() => {
    const hasRunning = allTasks.some((task) => task.status === "running" || task.status === "pending");
    if (!hasRunning) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadTasks(true);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [allTasks, loadTasks]);

  const stats = useMemo(() => ({
    total: allTasks.length,
    running: allTasks.filter((task) => task.status === "running" || task.status === "pending").length,
    success: allTasks.filter((task) => task.status === "success").length,
    failed: allTasks.filter((task) => task.status === "failed").length,
    cancelled: allTasks.filter((task) => task.status === "cancelled").length
  }), [allTasks]);
  const actionBusy = deleting || Boolean(deletingTaskId) || Boolean(cancellingTaskId);

  const downloadArchive = (task: ConversionTask) => {
    if (!task.downloadUrl) {
      return;
    }
    startDownload(api.downloadArchiveUrl(task.id));
  };

  const cancelTask = async (task: ConversionTask) => {
    if (actionBusy || actionBusyRef.current) {
      return;
    }
    actionBusyRef.current = true;
    setCancellingTaskId(task.id);
    try {
      const nextTask = await api.cancelTask(task.id);
      setAllTasksCached((current) => current.map((item) => (
        item.id === nextTask.id ? nextTask : item
      )));
      message.success("任务已取消");
      await loadTasks(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "任务取消失败");
    } finally {
      actionBusyRef.current = false;
      setCancellingTaskId(null);
    }
  };

  const confirmCancelTask = (task: ConversionTask) => {
    modal.confirm({
      title: "取消任务",
      content: `确定取消“${task.taskName}”吗？任务运行将停止，已经生成的日志会保留。`,
      okText: "确认取消",
      cancelText: "返回",
      okButtonProps: { danger: true },
      centered: true,
      onOk: () => cancelTask(task)
    });
  };

  const deleteTask = async (task: ConversionTask) => {
    if (actionBusy || actionBusyRef.current) {
      return;
    }
    actionBusyRef.current = true;
    setDeletingTaskId(task.id);
    try {
      await api.deleteTask(task.id);
      setAllTasksCached((current) => current.filter((item) => item.id !== task.id));
      setSelectedTaskIds((current) => current.filter((id) => id !== task.id));
      message.success("任务已删除");
      await loadTasks(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "删除任务失败");
    } finally {
      actionBusyRef.current = false;
      setDeletingTaskId(null);
    }
  };

  const deleteSelectedTasks = async () => {
    if (!selectedTaskIds.length || actionBusy || actionBusyRef.current) {
      return;
    }
    const idsToDelete = selectedTaskIds;
    actionBusyRef.current = true;
    setDeleting(true);
    try {
      const result = await api.deleteTasks(idsToDelete);
      setSelectedTaskIds([]);
      setAllTasksCached((current) => current.filter((task) => !idsToDelete.includes(task.id)));
      message.success(`已删除 ${result.deletedCount} 个任务`);
      await loadTasks(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "批量删除任务失败");
    } finally {
      actionBusyRef.current = false;
      setDeleting(false);
    }
  };

  const clearAllTasks = async () => {
    if (actionBusy || actionBusyRef.current) {
      return;
    }
    actionBusyRef.current = true;
    setDeleting(true);
    try {
      const result = await api.clearTasks();
      setSelectedTaskIds([]);
      setAllTasksCached([]);
      message.success(`已清空 ${result.deletedCount} 个任务`);
      await loadTasks(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "清空任务失败");
    } finally {
      actionBusyRef.current = false;
      setDeleting(false);
    }
  };

  const confirmDeleteSelectedTasks = () => {
    modal.confirm({
      title: "批量删除任务",
      content: `确定删除已选择的 ${selectedTaskIds.length} 个任务吗？任务记录、成果文件和日志都会被永久删除。`,
      okText: "批量删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      centered: true,
      onOk: deleteSelectedTasks
    });
  };

  const confirmClearAllTasks = () => {
    modal.confirm({
      title: "一键清空任务",
      content: `确定清空全部 ${allTasks.length} 个任务吗？该操作不可恢复。`,
      okText: "全部清空",
      cancelText: "取消",
      okButtonProps: { danger: true },
      centered: true,
      onOk: clearAllTasks
    });
  };

  const confirmDeleteTask = (task: ConversionTask) => {
    modal.confirm({
      title: "删除成果任务",
      content: `确定删除“${task.taskName}”吗？任务记录、成果文件和日志都会被永久删除。`,
      okText: "删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      centered: true,
      onOk: () => deleteTask(task)
    });
  };

  const columns: ColumnsType<ConversionTask> = [
    {
      title: "任务名称",
      dataIndex: "taskName",
      width: 230,
      render: (value, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{value}</Typography.Text>
          <span className="muted-path">{record.id}</span>
        </Space>
      )
    },
    {
      title: "来源模板",
      dataIndex: "templateName",
      width: 140,
      ellipsis: true
    },
    {
      title: "运行状态",
      dataIndex: "status",
      width: 110,
      render: (value) => <TaskStatusTag status={value} />
    },
    {
      title: "进度",
      dataIndex: "progress",
      width: 120,
      render: (value, record) => (
        <Tooltip title={progressDescription(record)}>
          <Progress
            percent={normalizeProgressPercent(value)}
            size="small"
            status={progressStatus(record.status)}
            strokeColor={record.status === "cancelled" ? "#8c8c8c" : undefined}
            format={(percent) => `${Math.round(percent || 0)}%`}
          />
        </Tooltip>
      )
    },
    {
      title: "开始时间",
      dataIndex: "startedAt",
      width: 140,
      render: (value) => value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-"
    },
    {
      title: "耗时",
      dataIndex: "duration",
      width: 90,
      render: (value) => formatDuration(value)
    },
    {
      title: "成果大小",
      dataIndex: "resultSize",
      width: 90,
      render: formatSize
    },
    {
      title: "操作",
      width: 180,
      fixed: "right",
      render: (_, record) => (
        <Space size={4}>
          <Tooltip title="详情">
            <Button
              aria-label="查看详情"
              size="small"
              icon={<EyeOutlined />}
              onClick={() => navigate(`/results/${record.id}`)}
            />
          </Tooltip>
          <Tooltip title={record.downloadUrl ? "下载" : "暂无可下载成果"}>
            <Button
              aria-label="下载成果"
              size="small"
              icon={<DownloadOutlined />}
              disabled={!record.downloadUrl || actionBusy}
              onClick={() => downloadArchive(record)}
            />
          </Tooltip>
          <Tooltip title={["pending", "running"].includes(record.status) ? "取消任务" : "仅排队中或运行中的任务可取消"}>
            <Button
              aria-label="取消任务"
              size="small"
              icon={<StopOutlined />}
              loading={cancellingTaskId === record.id}
              disabled={!["pending", "running"].includes(record.status) || actionBusy}
              onClick={() => confirmCancelTask(record)}
            />
          </Tooltip>
          <Tooltip title={record.rerunnable ? "基于原配置重新运行" : "关联模板不可用或原始输入文件已丢失"}>
            <Button
              aria-label="基于原配置重新运行"
              size="small"
              icon={<ReloadOutlined />}
              disabled={!record.rerunnable || actionBusy}
              onClick={() => setRerunTask(record)}
            />
          </Tooltip>
          <Tooltip title="删除">
            <Button
              danger
              aria-label="删除任务"
              size="small"
              icon={<DeleteOutlined />}
              loading={deletingTaskId === record.id}
              disabled={actionBusy}
              onClick={() => confirmDeleteTask(record)}
            />
          </Tooltip>
        </Space>
      )
    }
  ];

  return (
    <div className="page-stack management-page result-page">
      <div className="toolbar">
        <Space direction="vertical" size={0}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            任务管理
          </Typography.Title>
          <Typography.Text type="secondary">FME 转换任务与输出成果</Typography.Text>
        </Space>
      </div>

      <div className="stat-grid">
        <Card className="stat-card"><Statistic title="任务总数" value={stats.total} /></Card>
        <Card className="stat-card"><Statistic title="进行中" value={stats.running} valueStyle={{ color: "#1765d8" }} /></Card>
        <Card className="stat-card"><Statistic title="成功" value={stats.success} valueStyle={{ color: "#167d4c" }} /></Card>
        <Card className="stat-card"><Statistic title="失败" value={stats.failed} valueStyle={{ color: "#c73333" }} /></Card>
        <Card className="stat-card"><Statistic title="已取消" value={stats.cancelled} valueStyle={{ color: "#687385" }} /></Card>
      </div>

      <Card className="table-card management-table-card result-table-card">
        <div className="filter-row result-filter-row" style={{ marginBottom: 16 }}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索任务名称、ID、模板或输入文件"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
          <Select
            allowClear
            placeholder="运行状态"
            value={status}
            onChange={(value) => {
              setStatus(value);
            }}
            onClear={() => {
              setStatus(undefined);
            }}
            options={[
              { value: "pending", label: "排队中" },
              { value: "running", label: "运行中" },
              { value: "success", label: "成功" },
              { value: "failed", label: "失败" },
              { value: "cancelled", label: "已取消" }
            ]}
          />
          <Space className="task-bulk-actions">
            <Button
              danger
              icon={<DeleteOutlined />}
              disabled={!selectedTaskIds.length || actionBusy}
              loading={deleting && Boolean(selectedTaskIds.length)}
              onClick={confirmDeleteSelectedTasks}
            >
              批量删除{selectedTaskIds.length ? ` (${selectedTaskIds.length})` : ""}
            </Button>
            <Button
              danger
              disabled={!allTasks.length || actionBusy}
              loading={deleting && !selectedTaskIds.length}
              onClick={confirmClearAllTasks}
            >
              一键清空
            </Button>
          </Space>
        </div>
        <Table
          rowKey="id"
          loading={loading}
          columns={columns}
          dataSource={filteredTasks}
          rowSelection={{
            selectedRowKeys: selectedTaskIds,
            onChange: (keys) => setSelectedTaskIds(keys.map(String)),
            getCheckboxProps: () => ({ disabled: actionBusy })
          }}
          pagination={{
            pageSize: MANAGEMENT_PAGE_SIZE,
            showSizeChanger: false,
            position: ["bottomCenter"],
            hideOnSinglePage: false,
            showTotal: (total) => `共 ${total} 条任务`
          }}
          scroll={{ x: 1100 }}
          locale={{ emptyText: <Empty description="暂无转换任务" /> }}
        />
      </Card>

      <RerunTaskModal
        open={Boolean(rerunTask)}
        task={rerunTask}
        onClose={() => setRerunTask(null)}
        onCreated={(nextTask) => {
          setAllTasksCached((current) => [nextTask, ...current.filter((task) => task.id !== nextTask.id)]);
          setRerunTask(null);
          navigate(`/results/${nextTask.id}`);
        }}
      />
    </div>
  );
}

function formatDuration(value: number | null): string {
  if (!value) return "-";
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatSize(value: number): string {
  if (!value) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function progressStatus(status: TaskStatus): "normal" | "active" | "success" | "exception" {
  if (status === "running") return "active";
  if (status === "success") return "success";
  if (status === "failed") return "exception";
  return "normal";
}

function progressDescription(task: ConversionTask): string {
  const progress = normalizeProgressPercent(task.progress);
  if (task.status === "pending") return "等待调度";
  if (task.status === "success") return "已完成";
  if (task.status === "failed") return `执行失败，进度停留在 ${progress}%`;
  if (task.status === "cancelled") return `已取消，取消时进度 ${progress}%`;
  if (progress < 10) return "正在启动 FME";
  if (progress < 15) return "FME 初始化中";
  if (progress < 30) return "正在读取输入数据";
  if (progress < 95) return "FME 转换执行中";
  if (progress < 99) return "正在整理成果文件";
  return "即将完成";
}

function normalizeProgressPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value || 0)));
}
