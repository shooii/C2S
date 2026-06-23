import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Input,
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
  FolderOutlined,
  FullscreenExitOutlined,
  FullscreenOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined,
  StopOutlined
} from "@ant-design/icons";
import dayjs from "dayjs";
import { useNavigate, useParams } from "react-router-dom";
import { RerunTaskModal } from "../../components/RerunTaskModal";
import { TaskStatusTag } from "../../components/StatusTag";
import { api } from "../../services/api";
import { startDownload } from "../../services/download";
import type { ConversionTask, ResultFileBrowserItem, ResultFileBrowserPage } from "../../types";

const DETAIL_LOG_TAIL_BYTES = 256 * 1024;
const LOG_REFRESH_INTERVAL_MS = 2500;
const RESULT_FILE_PAGE_SIZE = 20;
const FILE_SEARCH_DEBOUNCE_MS = 250;

export default function ResultDetail() {
  const { id } = useParams<{ id: string }>();
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const [task, setTask] = useState<ConversionTask | null>(null);
  const [filePage, setFilePage] = useState<ResultFileBrowserPage>(() => createEmptyFilePage());
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(true);
  const [filesLoading, setFilesLoading] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [rerunOpen, setRerunOpen] = useState(false);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [currentResultFolder, setCurrentResultFolder] = useState("");
  const [fileSearch, setFileSearch] = useState("");
  const [debouncedFileSearch, setDebouncedFileSearch] = useState("");
  const [filePageNumber, setFilePageNumber] = useState(1);
  const logRef = useRef<HTMLDivElement | null>(null);
  const logRequestBusyRef = useRef(false);
  const logsLoadedRef = useRef(false);
  const followLatestLogRef = useRef(true);
  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const foregroundLoadSeqRef = useRef(0);
  const fileRequestSeqRef = useRef(0);
  const loadFilesRef = useRef<() => Promise<void>>(async () => undefined);
  const actionBusyRef = useRef(false);
  const mountedRef = useRef(true);
  const normalizedFileSearch = debouncedFileSearch.trim();

  const load = useCallback(async (background = false) => {
    if (!id) {
      return;
    }
    const seq = ++requestSeqRef.current;
    const foregroundSeq = background ? null : ++foregroundLoadSeqRef.current;
    if (!background) {
      setLoading(true);
    }
    try {
      const nextTask = await api.getTask(id);
      if (!mountedRef.current || seq < appliedSeqRef.current) {
        return;
      }
      appliedSeqRef.current = seq;
      setTask(nextTask);
      if (foregroundSeq !== null && foregroundSeq === foregroundLoadSeqRef.current) {
        setLoading(false);
      }
    } catch (error) {
      if (mountedRef.current && seq >= appliedSeqRef.current && !background) {
        appliedSeqRef.current = seq;
        setTask(null);
        setFilePage(createEmptyFilePage());
        setLogs("");
        message.error(error instanceof Error ? error.message : "任务详情加载失败");
      }
    } finally {
      if (mountedRef.current && foregroundSeq !== null && foregroundSeq === foregroundLoadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [id, message]);

  const loadFiles = useCallback(async () => {
    if (!id) {
      return;
    }
    const seq = ++fileRequestSeqRef.current;
    setFilesLoading(true);
    try {
      const nextFilePage = await api.browseResultFiles(id, {
        folder: currentResultFolder || undefined,
        search: normalizedFileSearch || undefined,
        page: filePageNumber,
        pageSize: RESULT_FILE_PAGE_SIZE
      });
      if (!mountedRef.current || seq !== fileRequestSeqRef.current) {
        return;
      }
      setFilePage(nextFilePage);
      if (nextFilePage.page !== filePageNumber) {
        setFilePageNumber(nextFilePage.page);
      }
    } catch (error) {
      if (mountedRef.current && seq === fileRequestSeqRef.current) {
        setFilePage(createEmptyFilePage({
          folder: currentResultFolder,
          search: normalizedFileSearch,
          page: filePageNumber
        }));
        message.warning(error instanceof Error ? error.message : "成果文件暂时不可用");
      }
    } finally {
      if (mountedRef.current && seq === fileRequestSeqRef.current) {
        setFilesLoading(false);
      }
    }
  }, [currentResultFolder, filePageNumber, id, message, normalizedFileSearch]);

  useEffect(() => {
    loadFilesRef.current = loadFiles;
  }, [loadFiles]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedFileSearch(fileSearch);
    }, FILE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [fileSearch]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const cancelledSeq = ++requestSeqRef.current;
      appliedSeqRef.current = Math.max(appliedSeqRef.current, cancelledSeq);
      foregroundLoadSeqRef.current += 1;
      fileRequestSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!task || !["pending", "running"].includes(task.status)) {
      return;
    }
    const timer = window.setInterval(() => {
      void load(true);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [load, task?.status]);

  useEffect(() => {
    if (!task || ["pending", "running"].includes(task.status)) {
      return;
    }
    void loadFilesRef.current();
  }, [task?.id, task?.status]);

  const refreshLogs = useCallback(async (showLoading = false) => {
    if (!id || logRequestBusyRef.current) {
      return;
    }
    logRequestBusyRef.current = true;
    if (showLoading) {
      setLogsLoading(true);
    }
    try {
      const nextLogs = await api.getTaskLogs(id, { tailBytes: DETAIL_LOG_TAIL_BYTES });
      if (!mountedRef.current) {
        return;
      }
      logsLoadedRef.current = true;
      setLogs((currentLogs) => currentLogs === nextLogs ? currentLogs : nextLogs);
    } catch {
      // Keep the latest visible log and retry on the next polling cycle.
    } finally {
      logRequestBusyRef.current = false;
      if (showLoading && mountedRef.current) {
        setLogsLoading(false);
      }
    }
  }, [id]);

  useEffect(() => {
    if (!task) {
      return;
    }
    void refreshLogs(!logsLoadedRef.current);
    if (!["pending", "running"].includes(task.status)) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshLogs();
    }, LOG_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refreshLogs, task?.id, task?.status]);

  useLayoutEffect(() => {
    if (!["pending", "running"].includes(task?.status || "") || !followLatestLogRef.current) {
      return;
    }
    const node = logRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [logs, task?.status]);

  const displayedFileNodes = filePage.items;
  const currentFolderSegments = currentResultFolder
    ? currentResultFolder.split("/").filter(Boolean)
    : [];

  useEffect(() => {
    setCurrentResultFolder("");
    setFileSearch("");
    setDebouncedFileSearch("");
    setFilePageNumber(1);
    setFilePage(createEmptyFilePage());
    setFilesExpanded(false);
    setLogs("");
    setLogsLoading(false);
    logsLoadedRef.current = false;
    followLatestLogRef.current = true;
  }, [id]);

  useEffect(() => {
    if (!filesExpanded) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFilesExpanded(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filesExpanded]);

  const cancel = async () => {
    if (!task || actionBusyRef.current) return;
    actionBusyRef.current = true;
    setCancelling(true);
    try {
      const nextTask = await api.cancelTask(task.id);
      setTask(nextTask);
      message.success("任务已取消");
      void load(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "任务取消失败");
    } finally {
      actionBusyRef.current = false;
      setCancelling(false);
    }
  };

  const confirmCancel = () => {
    if (!task || actionBusyRef.current) return;
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

  const copyParameters = async () => {
    if (!task) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(task.parameters, null, 2));
      message.success("运行参数已复制");
    } catch {
      message.error("运行参数复制失败");
    }
  };

  const scrollLogTo = (position: "top" | "bottom") => {
    const node = logRef.current;
    if (!node) return;
    followLatestLogRef.current = position === "bottom";
    node.scrollTo({
      top: position === "top" ? 0 : node.scrollHeight,
      behavior: "smooth"
    });
  };

  const handleLogScroll = () => {
    const node = logRef.current;
    if (!node) return;
    followLatestLogRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 32;
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

  const hasPreviewableFiles = filePage.hasPreviewableFiles || Boolean(task.previewUrl);
  const hasDownloadableFiles = filePage.hasDownloadableFiles || Boolean(task.downloadUrl);
  const canDownloadArchive = Boolean(task.downloadUrl) && hasDownloadableFiles;
  const actionBusy = cancelling;
  const isActiveTask = ["pending", "running"].includes(task.status);
  const parameterEntries = Object.entries(task.parameters || {});
  const taskDuration = getTaskDuration(task);

  const openResultFolder = (path: string) => {
    setFileSearch("");
    setFilePageNumber(1);
    setCurrentResultFolder(path);
  };

  const goToParentFolder = () => {
    setFileSearch("");
    setFilePageNumber(1);
    setCurrentResultFolder(parentResultPath(currentResultFolder));
  };

  const columns: ColumnsType<ResultFileBrowserItem> = [
    {
      title: "文件名",
      dataIndex: "name",
      ellipsis: true,
      render: (_, record) => (
        <Tooltip title={record.path}>
          <Space className="result-file-name-cell" size={8}>
            {record.type === "folder" ? <FolderOutlined className="result-file-folder-icon" /> : null}
            <span className="result-file-name-content">
              {record.type === "folder" ? (
                <Button
                  className="result-file-name-button"
                  type="link"
                  size="small"
                  onClick={(event) => {
                    event.stopPropagation();
                    openResultFolder(record.path);
                  }}
                >
                  {record.name}
                </Button>
              ) : (
                <Typography.Text className="result-file-name-text">{record.name}</Typography.Text>
              )}
              {record.type === "folder" ? (
                <Typography.Text type="secondary" className="result-file-meta">
                  {record.fileCount} 个文件
                </Typography.Text>
              ) : null}
            </span>
          </Space>
        </Tooltip>
      )
    },
    { title: "大小", dataIndex: "fileSize", width: 78, render: formatSize },
    {
      title: "时间",
      dataIndex: "latestCreatedAt",
      width: 104,
      render: (value) => value ? (
          <Tooltip title={dayjs(value).format("YYYY-MM-DD HH:mm:ss")}>
            <span>{dayjs(value).format("MM-DD HH:mm")}</span>
          </Tooltip>
        ) : "-"
    },
    {
      title: "操作",
      width: 92,
      render: (_, record) => {
        if (record.type === "folder") {
          return (
            <Button
              type="link"
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                openResultFolder(record.path);
              }}
            >
              进入
            </Button>
          );
        }
        return (
          <Space size={4}>
            <Tooltip title={record.file?.previewable ? "在线预览" : "该文件类型暂不支持在线预览"}>
              <Button
                aria-label={`预览 ${record.path}`}
                size="small"
                icon={<PlayCircleOutlined />}
                disabled={!record.file?.previewable || actionBusy}
                onClick={() => record.file && navigate(`/preview/${task.id}?fileId=${record.file.id}`)}
              />
            </Tooltip>
            <Tooltip title={record.file?.downloadable ? "下载文件" : "该文件不可下载"}>
              <Button
                aria-label={`下载 ${record.path}`}
                size="small"
                icon={<DownloadOutlined />}
                disabled={!record.file?.downloadable || actionBusy}
                onClick={() => record.file && startDownload(api.downloadUrl(task.id, record.file.id))}
              />
            </Tooltip>
          </Space>
        );
      }
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
          <div className="result-detail-title-block">
            <Space size={8}>
              <Typography.Title level={4} style={{ margin: 0 }}>
                {task.taskName}
              </Typography.Title>
              <TaskStatusTag status={task.status} />
            </Space>
            <Typography.Text type="secondary">
              任务详情 · 来源模板：{task.templateName}
            </Typography.Text>
          </div>
        </div>
        <Space>
          {isActiveTask ? (
            <Tooltip title="取消任务">
              <Button
                icon={<StopOutlined />}
                loading={cancelling}
                disabled={actionBusy}
                onClick={confirmCancel}
              >
                取消
              </Button>
            </Tooltip>
          ) : null}
          <Tooltip title={task.rerunnable ? "基于原配置重新运行" : "关联模板不可用或原始输入文件已丢失"}>
            <Button
              icon={<ReloadOutlined />}
              disabled={!task.rerunnable || actionBusy}
              onClick={() => setRerunOpen(true)}
            >
              重新运行
            </Button>
          </Tooltip>
          {hasPreviewableFiles ? (
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              disabled={actionBusy}
              onClick={() => navigate(`/preview/${task.id}`)}
            >
              在线预览
            </Button>
          ) : null}
        </Space>
      </div>

      <div className="result-detail-grid">
        <div className="result-detail-column result-detail-left">
          <Card className="detail-card result-detail-basic-card" title="任务基础信息">
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="任务ID" span={2}>
                <Typography.Text
                  className="result-detail-copyable"
                  copyable={{ text: task.id, tooltips: ["复制任务 ID", "已复制"] }}
                >
                  {task.id}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="来源模板">{task.templateName}</Descriptions.Item>
              <Descriptions.Item label="成果大小">{formatSize(task.resultSize)}</Descriptions.Item>
              <Descriptions.Item label="开始时间">{task.startedAt ? dayjs(task.startedAt).format("YYYY-MM-DD HH:mm:ss") : "-"}</Descriptions.Item>
              <Descriptions.Item label="结束时间">{task.finishedAt ? dayjs(task.finishedAt).format("YYYY-MM-DD HH:mm:ss") : "-"}</Descriptions.Item>
              <Descriptions.Item label="运行耗时">{formatDuration(taskDuration)}</Descriptions.Item>
              <Descriptions.Item label="退出码">{task.exitCode ?? "-"}</Descriptions.Item>
              {task.errorMessage ? (
                <Descriptions.Item label={task.status === "cancelled" ? "取消原因" : "错误信息"} span={2}>
                  <Typography.Text type={task.status === "failed" ? "danger" : undefined}>
                    {task.errorMessage}
                  </Typography.Text>
                </Descriptions.Item>
              ) : null}
              <Descriptions.Item label="输出目录" span={2}>
                <Typography.Text
                  className="result-detail-copyable"
                  copyable={{ text: task.outputPath, tooltips: ["复制输出目录", "已复制"] }}
                >
                  {task.outputPath}
                </Typography.Text>
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Card
            className={`detail-card result-files-card${filesExpanded ? " is-expanded" : ""}`}
            title={(
              <Space size={8}>
                <span>成果文件</span>
                <Typography.Text type="secondary">共 {filePage.totalFiles} 个文件</Typography.Text>
              </Space>
            )}
            extra={(
              <Space size={8}>
                <Tooltip title={filesExpanded ? "退出放大（Esc）" : "放大成果窗口"}>
                  <Button
                    aria-label={filesExpanded ? "退出放大成果窗口" : "放大成果窗口"}
                    icon={filesExpanded ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
                    onClick={() => setFilesExpanded((current) => !current)}
                  />
                </Tooltip>
                <Tooltip title={canDownloadArchive ? "下载全部可下载成果" : "暂无可下载成果文件"}>
                  <Button
                    icon={<DownloadOutlined />}
                    disabled={!canDownloadArchive || actionBusy}
                    onClick={() => startDownload(api.downloadArchiveUrl(task.id))}
                  >
                    下载压缩包
                  </Button>
                </Tooltip>
              </Space>
            )}
          >
            <div className="result-file-browser">
              <div className="result-file-browser-bar">
                <Space size={8} wrap>
                  <Button
                    size="small"
                    icon={<ArrowLeftOutlined />}
                    disabled={!currentResultFolder || Boolean(normalizedFileSearch)}
                    onClick={goToParentFolder}
                  >
                    上一级
                  </Button>
                  <div className="result-file-breadcrumb">
                    <Button
                      type="link"
                      size="small"
                      onClick={() => {
                        setFileSearch("");
                        setFilePageNumber(1);
                        setCurrentResultFolder("");
                      }}
                    >
                      成果根目录
                    </Button>
                    {currentFolderSegments.map((segment, index) => {
                      const segmentPath = currentFolderSegments.slice(0, index + 1).join("/");
                      return (
                        <span className="result-file-breadcrumb-segment" key={segmentPath}>
                          <span className="result-file-breadcrumb-separator">/</span>
                          <Button
                            type="link"
                            size="small"
                            onClick={() => {
                              setFileSearch("");
                              setFilePageNumber(1);
                              setCurrentResultFolder(segmentPath);
                            }}
                          >
                            {segment}
                          </Button>
                        </span>
                      );
                    })}
                  </div>
                </Space>
                <Input
                  allowClear
                  size="small"
                  prefix={<SearchOutlined />}
                  placeholder="搜索全部成果文件"
                  value={fileSearch}
                  onChange={(event) => {
                    setFileSearch(event.target.value);
                    setFilePageNumber(1);
                  }}
                />
              </div>
              <Typography.Text type="secondary" className="result-file-browser-summary">
                {normalizedFileSearch
                  ? `搜索到 ${filePage.total} 项，全部成果 ${filePage.totalFiles} 个文件`
                  : `当前层级 ${filePage.total} 项，全部成果 ${filePage.totalFiles} 个文件`}
              </Typography.Text>
              <Table
                size="small"
                rowKey="id"
                loading={filesLoading}
                columns={columns}
                dataSource={displayedFileNodes}
                scroll={filesExpanded ? { y: "calc(100vh - 300px)" } : undefined}
                onRow={(record) => ({
                  className: record.type === "folder" ? "result-file-folder-row" : undefined,
                  onClick: record.type === "folder" ? () => openResultFolder(record.path) : undefined
                })}
                pagination={{
                  current: filePageNumber,
                  pageSize: RESULT_FILE_PAGE_SIZE,
                  total: filePage.total,
                  showSizeChanger: false,
                  hideOnSinglePage: filePage.total <= RESULT_FILE_PAGE_SIZE,
                  onChange: (page) => setFilePageNumber(page),
                  showTotal: (total) => normalizedFileSearch
                    ? `匹配 ${total} 项 / 共 ${filePage.totalFiles} 个文件`
                    : `当前层级 ${total} 项 / 共 ${filePage.totalFiles} 个文件`
                }}
                locale={{
                  emptyText: (
                    <Empty
                      description={normalizedFileSearch
                        ? "没有匹配的成果文件"
                        : currentResultFolder
                          ? "当前目录暂无成果文件"
                          : "暂无成果文件"}
                    />
                  )
                }}
              />
            </div>
          </Card>

          <Card
            className="detail-card result-log-card"
            title={(
              <Space size={8}>
                <span>运行日志</span>
                {isActiveTask ? (
                  <span className="result-log-live">
                    <span className="result-log-live-dot" />
                    实时更新
                  </span>
                ) : null}
              </Space>
            )}
            extra={(
              <Space size={8}>
                <Tooltip title="复制日志">
                  <Button icon={<CopyOutlined />} disabled={!logs || actionBusy} onClick={copyLogs} />
                </Tooltip>
                <Tooltip title="下载日志">
                  <Button icon={<DownloadOutlined />} disabled={!logs || actionBusy} onClick={downloadLogs} />
                </Tooltip>
                <Tooltip title="回到顶部">
                  <Button icon={<VerticalAlignTopOutlined />} disabled={!logs || actionBusy} onClick={() => scrollLogTo("top")} />
                </Tooltip>
                <Tooltip title="跳到底部">
                  <Button icon={<VerticalAlignBottomOutlined />} disabled={!logs || actionBusy} onClick={() => scrollLogTo("bottom")} />
                </Tooltip>
              </Space>
            )}
          >
            <Spin spinning={logsLoading} wrapperClassName="result-log-spin">
              <div ref={logRef} className="result-log-scroll" onScroll={handleLogScroll}>
                {logs ? <pre className="log-view detail-log-view">{logs}</pre> : <Empty description="暂无日志" />}
              </div>
            </Spin>
          </Card>
        </div>

        <div className="result-detail-column result-detail-right">
          <Card className="detail-card result-progress-card" title="运行概况">
            <div className="result-progress-heading">
              <Space size={8}>
                <TaskStatusTag status={task.status} />
                <Typography.Text strong>{progressDescription(task)}</Typography.Text>
              </Space>
              <Typography.Text type="secondary">
                {normalizeProgressPercent(task.progress)}%
              </Typography.Text>
            </div>
            <Progress
              percent={normalizeProgressPercent(task.progress)}
              status={progressStatus(task.status)}
              strokeColor={task.status === "cancelled" ? "#8c8c8c" : undefined}
              showInfo={false}
            />
            <div className="result-progress-stats">
              <div>
                <Typography.Text type="secondary">运行耗时</Typography.Text>
                <strong>{formatDuration(taskDuration)}</strong>
              </div>
              <div>
                <Typography.Text type="secondary">成果文件</Typography.Text>
                <strong>{filePage.totalFiles}</strong>
              </div>
              <div>
                <Typography.Text type="secondary">成果大小</Typography.Text>
                <strong>{formatSize(task.resultSize)}</strong>
              </div>
            </div>
          </Card>
          <Card
            className="detail-card result-parameters-card"
            title={(
              <Space size={8}>
                <span>本次运行参数</span>
                <Typography.Text type="secondary">{parameterEntries.length} 项</Typography.Text>
              </Space>
            )}
            extra={(
              <Tooltip title="复制全部参数">
                <Button
                  icon={<CopyOutlined />}
                  disabled={!parameterEntries.length}
                  onClick={copyParameters}
                />
              </Tooltip>
            )}
          >
            {parameterEntries.length ? (
              <div className="result-parameter-list">
                {parameterEntries.map(([name, value]) => (
                  <div className="result-parameter-item" key={name}>
                    <Typography.Text type="secondary">{name}</Typography.Text>
                    <Typography.Text className="result-parameter-value">
                      {formatParameterValue(value)}
                    </Typography.Text>
                  </div>
                ))}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本次运行没有参数" />
            )}
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

function getTaskDuration(task: ConversionTask): number | null {
  if (task.duration !== null) {
    return task.duration;
  }
  if (!task.startedAt) {
    return null;
  }
  const endTime = task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now();
  return Math.max(0, endTime - new Date(task.startedAt).getTime());
}

function formatDuration(value: number | null): string {
  if (value === null) return "-";
  const seconds = Math.max(0, Math.round(value / 1000));
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatParameterValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string" || typeof value === "number") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createEmptyFilePage(
  patch: Partial<Pick<ResultFileBrowserPage, "folder" | "search" | "page">> = {}
): ResultFileBrowserPage {
  return {
    items: [],
    total: 0,
    totalFiles: 0,
    page: patch.page ?? 1,
    pageSize: RESULT_FILE_PAGE_SIZE,
    folder: patch.folder ?? "",
    search: patch.search ?? "",
    hasPreviewableFiles: false,
    hasDownloadableFiles: false
  };
}

function parentResultPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.join("/");
}

function progressStatus(
  status: ConversionTask["status"]
): "normal" | "active" | "success" | "exception" {
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
