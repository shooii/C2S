import { useEffect, useRef, useState } from "react";
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
  Tooltip,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  ArrowLeftOutlined,
  CopyOutlined,
  DownloadOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined,
  StopOutlined
} from "@ant-design/icons";
import dayjs from "dayjs";
import { useNavigate, useParams } from "react-router-dom";
import { RerunTaskModal } from "../../components/RerunTaskModal";
import { TaskStatusTag } from "../../components/StatusTag";
import { api } from "../../services/api";
import type { ConversionTask, ResultFile } from "../../types";

export default function ResultDetail() {
  const { id } = useParams<{ id: string }>();
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const [task, setTask] = useState<ConversionTask | null>(null);
  const [files, setFiles] = useState<ResultFile[]>([]);
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [rerunOpen, setRerunOpen] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);

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
    if (!task || cancelling) return;
    setCancelling(true);
    try {
      const nextTask = await api.cancelTask(task.id);
      setTask(nextTask);
      message.success("任务已取消");
      try {
        const [nextFiles, nextLogs] = await Promise.all([
          api.getResultFiles(task.id),
          api.getTaskLogs(task.id)
        ]);
        setFiles(nextFiles);
        setLogs(nextLogs);
      } catch {
        message.warning("任务已取消，但详情数据刷新失败");
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "任务取消失败");
    } finally {
      setCancelling(false);
    }
  };

  const confirmCancel = () => {
    if (!task) return;
    modal.confirm({
      title: "取消任务",
      content: `确定取消“${task.taskName}”吗？任务运行将停止，已经生成的日志会保留。`,
      okText: "确认取消",
      cancelText: "返回",
      okButtonProps: { danger: true },
      centered: true,
      onOk: cancel
    });
  };

  const copyLogs = async () => {
    if (!logs) return;
    try {
      await navigator.clipboard.writeText(logs);
      message.success("日志已复制");
    } catch {
      message.error("日志复制失败");
    }
  };

  const downloadLogs = () => {
    if (!task || !logs) return;
    const blob = new Blob([logs], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `task-${task.id}-log.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const scrollLogTo = (position: "top" | "bottom") => {
    const node = logRef.current;
    if (!node) return;
    node.scrollTo({
      top: position === "top" ? 0 : node.scrollHeight,
      behavior: "smooth"
    });
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
  const hasPreviewableFiles = files.some((file) => file.previewable);
  const canDownloadArchive = hasDownloadableFiles || Boolean(task.downloadUrl) || task.resultSize > 0;

  const columns: ColumnsType<ResultFile> = [
    {
      title: "文件名",
      dataIndex: "fileName",
      width: 150,
      ellipsis: true,
      render: (value) => <Tooltip title={value}><span>{value}</span></Tooltip>
    },
    { title: "类型", dataIndex: "fileType", width: 70, ellipsis: true },
    { title: "大小", dataIndex: "fileSize", width: 72, render: formatSize },
    {
      title: "创建时间",
      dataIndex: "createdAt",
      width: 140,
      render: (value) => (
        <Tooltip title={dayjs(value).format("YYYY-MM-DD HH:mm:ss")}>
          <span>{dayjs(value).format("MM-DD HH:mm:ss")}</span>
        </Tooltip>
      )
    },
    {
      title: "操作",
      width: 76,
      render: (_, record) => (
        <Space size={4}>
          <Tooltip title={record.previewable ? "在线预览" : "该文件类型暂不支持在线预览"}>
            <Button
              aria-label={`预览 ${record.fileName}`}
              size="small"
              icon={<PlayCircleOutlined />}
              disabled={!record.previewable}
              onClick={() => navigate(`/preview/${task.id}?fileId=${record.id}`)}
            />
          </Tooltip>
          <Tooltip title={record.downloadable ? "下载文件" : "该文件不可下载"}>
            <Button
              aria-label={`下载 ${record.fileName}`}
              size="small"
              icon={<DownloadOutlined />}
              disabled={!record.downloadable}
              onClick={() => window.open(api.downloadUrl(task.id, record.id), "_blank")}
            />
          </Tooltip>
        </Space>
      )
    }
  ];

  return (
    <div className="page-stack result-detail-page">
      <div className="toolbar">
        <div className="result-detail-heading">
          <Tooltip title="返回任务列表">
            <Button
              aria-label="返回任务列表"
              className="result-detail-back"
              icon={<ArrowLeftOutlined />}
              shape="circle"
              type="text"
              onClick={() => navigate("/results")}
            />
          </Tooltip>
          <Space direction="vertical" size={0}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              任务详情
            </Typography.Title>
            <Typography.Text type="secondary">{task.taskName}</Typography.Text>
          </Space>
        </div>
        <Space>
          <Tooltip title={["pending", "running"].includes(task.status) ? "取消任务" : "仅排队中或运行中的任务可取消"}>
            <Button
              icon={<StopOutlined />}
              loading={cancelling}
              disabled={!["pending", "running"].includes(task.status)}
              onClick={confirmCancel}
            >
              取消
            </Button>
          </Tooltip>
          <Tooltip title={task.rerunnable ? "基于原配置重新运行" : "关联模板不可用或原始输入文件已丢失"}>
            <Button
              icon={<ReloadOutlined />}
              disabled={!task.rerunnable}
              onClick={() => setRerunOpen(true)}
            >
              重新运行
            </Button>
          </Tooltip>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            disabled={!hasPreviewableFiles}
            onClick={() => navigate(`/preview/${task.id}`)}
          >
            在线预览
          </Button>
        </Space>
      </div>

      <div className="result-detail-grid">
        <div className="result-detail-column result-detail-left">
          <Card className="detail-card result-detail-basic-card" title="任务基础信息">
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="任务名称">{task.taskName}</Descriptions.Item>
              <Descriptions.Item label="运行状态"><TaskStatusTag status={task.status} /></Descriptions.Item>
              <Descriptions.Item label="任务ID" span={2}>{task.id}</Descriptions.Item>
              <Descriptions.Item label="来源模板">{task.templateName}</Descriptions.Item>
              <Descriptions.Item label="成果大小">{formatSize(task.resultSize)}</Descriptions.Item>
              <Descriptions.Item label="开始时间">{task.startedAt ? dayjs(task.startedAt).format("YYYY-MM-DD HH:mm:ss") : "-"}</Descriptions.Item>
              <Descriptions.Item label="结束时间">{task.finishedAt ? dayjs(task.finishedAt).format("YYYY-MM-DD HH:mm:ss") : "-"}</Descriptions.Item>
              <Descriptions.Item label="退出码">{task.exitCode ?? "-"}</Descriptions.Item>
              <Descriptions.Item label={task.status === "cancelled" ? "取消原因" : "错误信息"}>
                {task.errorMessage || "-"}
              </Descriptions.Item>
              <Descriptions.Item label="输出目录" span={2}>{task.outputPath}</Descriptions.Item>
            </Descriptions>
          </Card>

          <Card
            className="detail-card result-files-card"
            title="成果文件"
            extra={(
              <Button
                icon={<DownloadOutlined />}
                disabled={!canDownloadArchive}
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

          <Card
            className="detail-card result-log-card"
            title="运行日志"
            extra={(
              <Space size={8}>
                <Tooltip title="复制日志">
                  <Button icon={<CopyOutlined />} disabled={!logs} onClick={copyLogs} />
                </Tooltip>
                <Tooltip title="下载日志">
                  <Button icon={<DownloadOutlined />} disabled={!logs} onClick={downloadLogs} />
                </Tooltip>
                <Tooltip title="回到顶部">
                  <Button icon={<VerticalAlignTopOutlined />} disabled={!logs} onClick={() => scrollLogTo("top")} />
                </Tooltip>
                <Tooltip title="跳到底部">
                  <Button icon={<VerticalAlignBottomOutlined />} disabled={!logs} onClick={() => scrollLogTo("bottom")} />
                </Tooltip>
              </Space>
            )}
          >
            {logs ? <pre ref={logRef} className="log-view detail-log-view">{logs}</pre> : <Empty description="暂无日志" />}
          </Card>
        </div>

        <div className="result-detail-column result-detail-right">
          <Card className="detail-card result-progress-card" title="运行进度">
            <Progress
              type="dashboard"
              percent={task.progress}
              status={progressStatus(task.status)}
              strokeColor={task.status === "cancelled" ? "#8c8c8c" : undefined}
            />
          </Card>
          <Card className="detail-card result-parameters-card" title="本次运行参数">
            <pre className="log-view parameter-log-view">{JSON.stringify(task.parameters, null, 2)}</pre>
          </Card>
        </div>
      </div>

      <RerunTaskModal
        open={rerunOpen}
        task={task}
        onClose={() => setRerunOpen(false)}
        onCreated={(nextTask) => {
          setRerunOpen(false);
          navigate(`/results/${nextTask.id}`);
        }}
      />
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

function progressStatus(
  status: ConversionTask["status"]
): "normal" | "active" | "success" | "exception" {
  if (status === "running") return "active";
  if (status === "success") return "success";
  if (status === "failed") return "exception";
  return "normal";
}
