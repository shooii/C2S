import { useCallback, useEffect, useMemo, useState } from "react";
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
  FileTextOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined
} from "@ant-design/icons";
import dayjs from "dayjs";
import { useLocation, useNavigate } from "react-router-dom";
import { LogDrawer } from "../../components/LogDrawer";
import { TaskStatusTag } from "../../components/StatusTag";
import { api } from "../../services/api";
import type { ConversionTask, TaskStatus } from "../../types";

const MANAGEMENT_PAGE_SIZE = 10;

export default function ResultManage() {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [allTasks, setAllTasks] = useState<ConversionTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<TaskStatus | undefined>();
  const [logTask, setLogTask] = useState<ConversionTask | null>(null);

  const filteredTasks = useMemo(() => {
    let list = allTasks;
    if (status) {
      list = list.filter((t) => t.status === status);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (t) =>
          t.taskName.toLowerCase().includes(q) ||
          (t.templateName && t.templateName.toLowerCase().includes(q))
      );
    }
    return list;
  }, [allTasks, search, status]);

  const loadTasks = useCallback(async (background = false) => {
    if (!background) {
      setLoading(true);
    }
    try {
      const result = await api.listTasks({});
      setAllTasks(result);
      setSelectedTaskIds((current) => {
        const availableIds = new Set(result.map((task) => task.id));
        return current.filter((id) => availableIds.has(id));
      });
      return result;
    } catch (error) {
      message.error(error instanceof Error ? error.message : "成果列表加载失败");
      return [];
    } finally {
      if (!background) {
        setLoading(false);
      }
    }
  }, [message]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    const handleTaskSubmissionSettled = () => {
      void loadTasks(true);
    };
    window.addEventListener("c2s:task-submission-settled", handleTaskSubmissionSettled);
    return () => {
      window.removeEventListener("c2s:task-submission-settled", handleTaskSubmissionSettled);
    };
  }, [loadTasks]);

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
    failed: allTasks.filter((task) => task.status === "failed").length
  }), [allTasks]);

  const downloadArchive = (task: ConversionTask) => {
    if (!task.downloadUrl && !task.resultSize) {
      return;
    }
    window.open(api.downloadArchiveUrl(task.id), "_blank");
  };

  const rerun = async (task: ConversionTask) => {
    try {
      const nextTask = await api.rerunTask(task.id);
      message.success("已创建重新运行任务");
      navigate(`/results/${nextTask.id}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "重新运行失败");
    }
  };

  const deleteTask = async (task: ConversionTask) => {
    try {
      await api.deleteTask(task.id);
      message.success("任务已删除");
      await loadTasks();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "删除任务失败");
    }
  };

  const deleteSelectedTasks = async () => {
    if (!selectedTaskIds.length) {
      return;
    }
    setDeleting(true);
    try {
      const result = await api.deleteTasks(selectedTaskIds);
      setSelectedTaskIds([]);
      message.success(`已删除 ${result.deletedCount} 个任务`);
      await loadTasks(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "批量删除任务失败");
    } finally {
      setDeleting(false);
    }
  };

  const clearAllTasks = async () => {
    setDeleting(true);
    try {
      const result = await api.clearTasks();
      setSelectedTaskIds([]);
      message.success(`已清空 ${result.deletedCount} 个任务`);
      await loadTasks(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "清空任务失败");
    } finally {
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
      width: 260,
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
      width: 150,
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
      width: 130,
      render: (value, record) => (
        <Progress percent={value} size="small" status={record.status === "failed" ? "exception" : undefined} />
      )
    },
    {
      title: "开始时间",
      dataIndex: "startedAt",
      width: 150,
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
      width: 100,
      render: formatSize
    },
    {
      title: "操作",
      width: 220,
      fixed: "right",
      render: (_, record) => (
        <Space>
          <Tooltip title="详情">
            <Button icon={<EyeOutlined />} onClick={() => navigate(`/results/${record.id}`)} />
          </Tooltip>
          <Tooltip title="预览">
            <Button icon={<PlayCircleOutlined />} disabled={!record.previewUrl} onClick={() => navigate(`/preview/${record.id}`)} />
          </Tooltip>
          <Tooltip title="下载">
            <Button icon={<DownloadOutlined />} disabled={!record.downloadUrl && !record.resultSize} onClick={() => downloadArchive(record)} />
          </Tooltip>
          <Tooltip title="日志">
            <Button icon={<FileTextOutlined />} onClick={() => setLogTask(record)} />
          </Tooltip>
          <Tooltip title={record.rerunnable ? "重新运行" : "关联模板不可用或原始输入文件已丢失"}>
            <Button
              icon={<ReloadOutlined />}
              disabled={!record.rerunnable}
              onClick={() => rerun(record)}
            />
          </Tooltip>
          <Tooltip title="删除">
            <Button danger icon={<DeleteOutlined />} onClick={() => confirmDeleteTask(record)} />
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
        <Card className="stat-card"><Statistic title="运行中" value={stats.running} valueStyle={{ color: "#1765d8" }} /></Card>
        <Card className="stat-card"><Statistic title="成功" value={stats.success} valueStyle={{ color: "#167d4c" }} /></Card>
        <Card className="stat-card"><Statistic title="失败" value={stats.failed} valueStyle={{ color: "#c73333" }} /></Card>
      </div>

      <Card className="table-card management-table-card result-table-card">
        <div className="filter-row result-filter-row" style={{ marginBottom: 16 }}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索任务或模板"
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
              disabled={!selectedTaskIds.length}
              loading={deleting && Boolean(selectedTaskIds.length)}
              onClick={confirmDeleteSelectedTasks}
            >
              批量删除{selectedTaskIds.length ? ` (${selectedTaskIds.length})` : ""}
            </Button>
            <Button
              danger
              disabled={!allTasks.length}
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
            onChange: (keys) => setSelectedTaskIds(keys.map(String))
          }}
          pagination={{
            pageSize: MANAGEMENT_PAGE_SIZE,
            showSizeChanger: false,
            position: ["bottomCenter"],
            hideOnSinglePage: false,
            showTotal: (total) => `共 ${total} 条成果`
          }}
          scroll={{ x: 1180 }}
          locale={{ emptyText: <Empty description="暂无转换任务" /> }}
        />
      </Card>

      <LogDrawer task={logTask} open={Boolean(logTask)} onClose={() => setLogTask(null)} />
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
