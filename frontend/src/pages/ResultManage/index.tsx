import { useEffect, useMemo, useState } from "react";
import {
  App,
  Button,
  Card,
  Empty,
  Input,
  Popconfirm,
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
  SearchOutlined,
  SyncOutlined
} from "@ant-design/icons";
import dayjs from "dayjs";
import { useNavigate } from "react-router-dom";
import { LogDrawer } from "../../components/LogDrawer";
import { TaskStatusTag } from "../../components/StatusTag";
import { api } from "../../services/api";
import type { ConversionTask, TaskStatus } from "../../types";

export default function ResultManage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [allTasks, setAllTasks] = useState<ConversionTask[]>([]);
  const [tasks, setTasks] = useState<ConversionTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<TaskStatus | undefined>();
  const [logTask, setLogTask] = useState<ConversionTask | null>(null);

  const loadAllTasks = async () => {
    try {
      const result = await api.listTasks({});
      setAllTasks(result);
      return result;
    } catch {
      return [];
    }
  };

  const loadTasks = async (filters?: { search?: string; status?: TaskStatus }) => {
    setLoading(true);
    try {
      const s = filters?.search ?? search;
      const st = filters?.status ?? status;
      setTasks(await api.listTasks({ search: s || undefined, status: st || undefined }));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "成果列表加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAllTasks();
    void loadTasks();
  }, []);

  useEffect(() => {
    const hasRunning = allTasks.some((task) => task.status === "running" || task.status === "pending");
    if (!hasRunning) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadAllTasks();
      void loadTasks();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [allTasks]);

  const stats = useMemo(() => ({
    total: allTasks.length,
    running: allTasks.filter((task) => task.status === "running" || task.status === "pending").length,
    success: allTasks.filter((task) => task.status === "success").length,
    failed: allTasks.filter((task) => task.status === "failed").length
  }), [allTasks]);

  const downloadFirst = async (task: ConversionTask) => {
    try {
      const files = await api.getResultFiles(task.id);
      const first = files.find((file) => file.downloadable);
      if (!first) {
        message.warning("暂无可下载成果文件");
        return;
      }
      window.open(api.downloadUrl(task.id, first.id), "_blank");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "成果下载失败");
    }
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

  const reparseTemplate = async (task: ConversionTask) => {
    try {
      await api.parseTemplate(task.templateId);
      message.success("关联模板重新解析完成");
      await loadAllTasks();
      await loadTasks();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "关联模板解析失败");
    }
  };

  const deleteTask = async (task: ConversionTask) => {
    try {
      await api.deleteTask(task.id);
      message.success("任务已删除");
      await loadAllTasks();
      await loadTasks();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "删除任务失败");
    }
  };

  const columns: ColumnsType<ConversionTask> = [
    {
      title: "任务名称",
      dataIndex: "taskName",
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
      width: 170
    },
    {
      title: "输入数据",
      dataIndex: "inputDataName",
      width: 170,
      ellipsis: true,
      render: (value) => value || "-"
    },
    {
      title: "输出格式",
      dataIndex: "outputFormat",
      width: 100,
      render: (value) => value || "-"
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
      width: 150,
      render: (value, record) => (
        <Progress percent={value} size="small" status={record.status === "failed" ? "exception" : undefined} />
      )
    },
    {
      title: "开始时间",
      dataIndex: "startedAt",
      width: 170,
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
      width: 300,
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
            <Button icon={<DownloadOutlined />} disabled={record.status !== "success"} onClick={() => downloadFirst(record)} />
          </Tooltip>
          <Tooltip title="日志">
            <Button icon={<FileTextOutlined />} onClick={() => setLogTask(record)} />
          </Tooltip>
          <Tooltip title="重新运行">
            <Button icon={<ReloadOutlined />} onClick={() => rerun(record)} />
          </Tooltip>
          <Tooltip title="重新解析模板">
            <Button icon={<SyncOutlined />} onClick={() => reparseTemplate(record)} />
          </Tooltip>
          <Popconfirm title="删除任务" description="删除整个任务，包括任务记录、成果文件和日志。" onConfirm={() => deleteTask(record)}>
            <Button danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <div className="page-stack">
      <div className="toolbar">
        <Space direction="vertical" size={0}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            成果管理
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

      <Card className="table-card result-table-card">
        <div className="filter-row" style={{ marginBottom: 16 }}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索任务、模板或输入数据"
            value={search}
            onChange={(event) => {
              const value = event.target.value;
              setSearch(value);
              void loadTasks({ search: value });
            }}
          />
          <Select
            allowClear
            placeholder="运行状态"
            value={status}
            onChange={(value) => {
              setStatus(value);
              void loadTasks({ status: value });
            }}
            onClear={() => {
              setStatus(undefined);
              void loadTasks({ status: undefined });
            }}
            options={[
              { value: "pending", label: "排队中" },
              { value: "running", label: "运行中" },
              { value: "success", label: "成功" },
              { value: "failed", label: "失败" },
              { value: "cancelled", label: "已取消" }
            ]}
          />
        </div>
        <Table
          rowKey="id"
          size="middle"
          loading={loading}
          columns={columns}
          dataSource={tasks}
          pagination={{
            pageSize: 6,
            showSizeChanger: false,
            showTotal: (total) => `共 ${total} 条成果`
          }}
          scroll={{ x: 1500 }}
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
