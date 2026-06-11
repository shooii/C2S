import { useEffect, useState } from "react";
import {
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Progress,
  Space,
  Spin,
  Table,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  ArrowLeftOutlined,
  DownloadOutlined,
  FileTextOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined
} from "@ant-design/icons";
import dayjs from "dayjs";
import { useNavigate, useParams } from "react-router-dom";
import { TaskStatusTag } from "../../components/StatusTag";
import { api } from "../../services/api";
import type { ConversionTask, ResultFile } from "../../types";

export default function ResultDetail() {
  const { id } = useParams<{ id: string }>();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [task, setTask] = useState<ConversionTask | null>(null);
  const [files, setFiles] = useState<ResultFile[]>([]);
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!id) {
      return;
    }
    try {
      const [nextTask, nextFiles, nextLogs] = await Promise.all([
        api.getTask(id),
        api.getResultFiles(id),
        api.getTaskLogs(id)
      ]);
      setTask(nextTask);
      setFiles(nextFiles);
      setLogs(nextLogs);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "任务详情加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [id]);

  useEffect(() => {
    if (!task || !["pending", "running"].includes(task.status)) {
      return;
    }
    const timer = window.setInterval(load, 3000);
    return () => window.clearInterval(timer);
  }, [task?.status, id]);

  const cancel = async () => {
    if (!task) return;
    try {
      const nextTask = await api.cancelTask(task.id);
      setTask(nextTask);
      message.success("任务已取消");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "任务取消失败");
    }
  };

  const rerun = async () => {
    if (!task) return;
    try {
      const nextTask = await api.rerunTask(task.id);
      message.success("已创建重新运行任务");
      navigate(`/results/${nextTask.id}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "重新运行失败");
    }
  };

  if (loading) {
    return (
      <div className="center-state">
        <Spin />
      </div>
    );
  }

  if (!task) {
    return <Empty description="任务不存在" />;
  }

  const hasDownloadableFiles = files.some((file) => file.downloadable);

  const columns: ColumnsType<ResultFile> = [
    { title: "文件名", dataIndex: "fileName", ellipsis: true },
    { title: "类型", dataIndex: "fileType", width: 120 },
    { title: "大小", dataIndex: "fileSize", width: 120, render: formatSize },
    { title: "创建时间", dataIndex: "createdAt", width: 170, render: (value) => dayjs(value).format("YYYY-MM-DD HH:mm") },
    {
      title: "操作",
      width: 100,
      render: (_, record) => (
        <Button icon={<PlayCircleOutlined />} disabled={!record.previewable} onClick={() => navigate(`/preview/${task.id}`)}>
          预览
        </Button>
      )
    }
  ];

  return (
    <div className="page-stack">
      <div className="toolbar">
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate("/results")}>返回</Button>
          <Space direction="vertical" size={0}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              成果详情
            </Typography.Title>
            <Typography.Text type="secondary">{task.taskName}</Typography.Text>
          </Space>
        </Space>
        <Space>
          <Button icon={<FileTextOutlined />} onClick={() => void load()}>刷新</Button>
          <Button icon={<StopOutlined />} disabled={!["pending", "running"].includes(task.status)} onClick={cancel}>取消</Button>
          <Button icon={<ReloadOutlined />} onClick={rerun}>重新运行</Button>
          <Button type="primary" icon={<PlayCircleOutlined />} disabled={!task.previewUrl} onClick={() => navigate(`/preview/${task.id}`)}>
            在线预览
          </Button>
        </Space>
      </div>

      <div className="result-detail-grid">
        <Space direction="vertical" size={16}>
          <Card className="detail-card" title="任务基础信息">
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="任务名称">{task.taskName}</Descriptions.Item>
              <Descriptions.Item label="运行状态"><TaskStatusTag status={task.status} /></Descriptions.Item>
              <Descriptions.Item label="来源模板">{task.templateName}</Descriptions.Item>
              <Descriptions.Item label="输出格式">{task.outputFormat || "-"}</Descriptions.Item>
              <Descriptions.Item label="输入数据">{task.inputDataName || "-"}</Descriptions.Item>
              <Descriptions.Item label="成果大小">{formatSize(task.resultSize)}</Descriptions.Item>
              <Descriptions.Item label="开始时间">{task.startedAt ? dayjs(task.startedAt).format("YYYY-MM-DD HH:mm:ss") : "-"}</Descriptions.Item>
              <Descriptions.Item label="结束时间">{task.finishedAt ? dayjs(task.finishedAt).format("YYYY-MM-DD HH:mm:ss") : "-"}</Descriptions.Item>
              <Descriptions.Item label="退出码">{task.exitCode ?? "-"}</Descriptions.Item>
              <Descriptions.Item label="错误信息">{task.errorMessage || "-"}</Descriptions.Item>
              <Descriptions.Item label="输出目录" span={2}>{task.outputPath}</Descriptions.Item>
            </Descriptions>
          </Card>

          <Card
            className="detail-card"
            title="成果文件"
            extra={(
              <Button
                icon={<DownloadOutlined />}
                disabled={task.status !== "success" || !hasDownloadableFiles}
                onClick={() => window.open(api.downloadArchiveUrl(task.id), "_blank")}
              >
                下载压缩包
              </Button>
            )}
          >
            <Table
              size="small"
              rowKey="id"
              columns={columns}
              dataSource={files}
              pagination={false}
              locale={{ emptyText: <Empty description="暂无成果文件" /> }}
            />
          </Card>

          <Card className="detail-card" title="FME 运行日志">
            {logs ? <pre className="log-view">{logs}</pre> : <Empty description="暂无日志" />}
          </Card>
        </Space>

        <Space direction="vertical" size={16}>
          <Card className="detail-card" title="运行进度">
            <Progress
              type="dashboard"
              percent={task.progress}
              status={task.status === "failed" ? "exception" : task.status === "success" ? "success" : "active"}
            />
          </Card>
          <Card className="detail-card" title="本次运行参数">
            <pre className="log-view">{JSON.stringify(task.parameters, null, 2)}</pre>
          </Card>
        </Space>
      </div>
    </div>
  );
}

function formatSize(value: number): string {
  if (!value) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
