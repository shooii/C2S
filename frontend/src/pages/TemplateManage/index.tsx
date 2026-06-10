import { useEffect, useMemo, useRef, useState } from "react";
import {
  App,
  Button,
  Card,
  Descriptions,
  Dropdown,
  Empty,
  Input,
  Modal,
  Pagination,
  Popconfirm,
  Progress,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload
} from "antd";
import type { UploadProps } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  ApiOutlined,
  CloudUploadOutlined,
  CodeOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FileExcelOutlined,
  FileTextOutlined,
  FolderOutlined,
  MoreOutlined,
  PlusOutlined,
  SearchOutlined
} from "@ant-design/icons";
import dayjs from "dayjs";
import { useNavigate } from "react-router-dom";
import { useManagementPageSize } from "../../hooks/useManagementPageSize";
import { api } from "../../services/api";
import type { TemplateDetail, TemplateGroup, TemplateRecord } from "../../types";

type GroupKey = string;
type EnabledFilter = "all" | "enabled" | "disabled";

export default function TemplateManage() {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [groups, setGroups] = useState<TemplateGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeGroup, setActiveGroup] = useState<GroupKey>("default");
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<EnabledFilter>("all");
  const [selected, setSelected] = useState<TemplateDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [groupInitialized, setGroupInitialized] = useState(false);
  const [editingGroup, setEditingGroup] = useState<GroupKey | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [groupModalMode, setGroupModalMode] = useState<"create" | "edit">("edit");
  const [pendingUploadFile, setPendingUploadFile] = useState<File | null>(null);
  const [pendingUploadGroup, setPendingUploadGroup] = useState<GroupKey>("default");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [groupPage, setGroupPage] = useState(1);
  const [groupPageSize, setGroupPageSize] = useState(8);
  const groupListRef = useRef<HTMLDivElement>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const uploadTokenRef = useRef<string | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const [templateRecords, templateGroups] = await Promise.all([
        api.listTemplates({}),
        api.listTemplateGroups()
      ]);
      setTemplates(templateRecords);
      setGroups(templateGroups);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "模板管理数据加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const visibleGroupKeys = useMemo(() => groups.map((group) => group.id), [groups]);

  const groupOptions = useMemo(
    () => groups.map((group) => ({ value: group.id, label: group.name })),
    [groups]
  );

  const groupedTemplates = useMemo(() => {
    const result: Record<GroupKey, TemplateRecord[]> = {};
    visibleGroupKeys.forEach((key) => {
      result[key] = [];
    });
    result.default = result.default || [];

    templates.forEach((template) => {
      const group = visibleGroupKeys.includes(template.groupId) ? template.groupId : "default";
      result[group] = result[group] || [];
      result[group].push(template);
    });

    return result;
  }, [templates, visibleGroupKeys]);

  const currentGroupTemplates = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    const filtered = (groupedTemplates[activeGroup] || []).filter((template) => {
      if (
        (status === "enabled" && !template.enabled) ||
        (status === "disabled" && template.enabled)
      ) {
        return false;
      }
      if (!normalizedKeyword) {
        return true;
      }
      return [
        template.name,
        template.fileName,
        template.description || "",
        template.inputDataType || "",
        template.outputDataType || ""
      ].some((value) => value.toLowerCase().includes(normalizedKeyword));
    });

    return filtered;
  }, [activeGroup, groupedTemplates, keyword, status]);

  const tablePageSize = useManagementPageSize({
    cardSelector: ".template-table-card",
    fallbackRowHeight: 52,
    totalItems: currentGroupTemplates.length
  });

  const pagedGroupKeys = useMemo(
    () => visibleGroupKeys.slice((groupPage - 1) * groupPageSize, groupPage * groupPageSize),
    [groupPage, groupPageSize, visibleGroupKeys]
  );

  const stats = useMemo(() => ({
    total: templates.length,
    enabled: templates.filter((template) => template.enabled).length,
    disabled: templates.filter((template) => !template.enabled).length,
    monthAdded: templates.filter((template) => dayjs(template.createdAt).isSame(dayjs(), "month")).length
  }), [templates]);

  useEffect(() => {
    if (groupInitialized || !templates.length) {
      return;
    }
    const firstNonEmptyGroup = visibleGroupKeys.find((key) => groupedTemplates[key]?.length > 0);
    if (firstNonEmptyGroup) {
      setActiveGroup(firstNonEmptyGroup);
      setGroupInitialized(true);
    }
  }, [groupInitialized, groupedTemplates, templates.length, visibleGroupKeys]);

  useEffect(() => {
    if (!visibleGroupKeys.includes(activeGroup)) {
      setActiveGroup("default");
    }
    if (!visibleGroupKeys.includes(pendingUploadGroup)) {
      setPendingUploadGroup("default");
    }
  }, [activeGroup, pendingUploadGroup, visibleGroupKeys]);

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(visibleGroupKeys.length / groupPageSize));
    if (groupPage > maxPage) {
      setGroupPage(maxPage);
    }
  }, [groupPage, groupPageSize, visibleGroupKeys]);

  useEffect(() => {
    const groupList = groupListRef.current;
    if (!groupList) {
      return;
    }

    const updatePageSize = () => {
      const styles = window.getComputedStyle(groupList);
      const gap = Number.parseFloat(styles.rowGap) || 0;
      const firstItem = groupList.querySelector<HTMLElement>(".template-group-item");
      const itemHeight = firstItem?.getBoundingClientRect().height || 48;
      const pagination = groupList.parentElement?.querySelector<HTMLElement>(".template-pagination");
      const paginationHeight = pagination?.getBoundingClientRect().height || 38;
      const totalAvailableHeight = groupList.clientHeight + (pagination ? paginationHeight : 0);
      const maxWithoutPagination = Math.max(
        1,
        Math.floor((totalAvailableHeight + gap) / (itemHeight + gap))
      );
      const listHeight = visibleGroupKeys.length > maxWithoutPagination
        ? totalAvailableHeight - paginationHeight
        : totalAvailableHeight;
      const nextPageSize = Math.max(1, Math.floor((listHeight + gap) / (itemHeight + gap)));
      setGroupPageSize((current) => current === nextPageSize ? current : nextPageSize);
    };

    const observer = new ResizeObserver(updatePageSize);
    observer.observe(groupList);
    const frame = window.requestAnimationFrame(updatePageSize);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [groupPageSize, visibleGroupKeys.length]);

  const uploadProps: UploadProps = {
    accept: ".fmw,.fmwt",
    maxCount: 1,
    showUploadList: false,
    beforeUpload: (file) => {
      setPendingUploadFile(file as File);
      setPendingUploadGroup(visibleGroupKeys.includes(activeGroup) ? activeGroup : "default");
      setUploadProgress(0);
      return Upload.LIST_IGNORE;
    }
  };

  const openDetail = async (record: TemplateRecord) => {
    setDetailLoading(true);
    try {
      setSelected(await api.getTemplate(record.id));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "模板详情加载失败");
    } finally {
      setDetailLoading(false);
    }
  };

  const remove = async (record: TemplateRecord) => {
    try {
      await api.deleteTemplate(record.id);
      message.success("模板已删除");
      await loadData();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "模板删除失败");
    }
  };

  const createGroup = () => {
    setGroupModalMode("create");
    setEditingGroup(null);
    setEditingGroupName("");
  };

  const startEditGroup = (key: GroupKey) => {
    setGroupModalMode("edit");
    setEditingGroup(key);
    setEditingGroupName(getGroupLabel(key, groups));
  };

  const saveGroupName = async () => {
    const nextName = editingGroupName.trim();
    if (!nextName) {
      message.warning("分组名称不能为空");
      return;
    }
    if (groups.some((group) => group.id !== editingGroup && group.name === nextName)) {
      message.warning("分组名称已存在");
      return;
    }
    try {
      if (groupModalMode === "create") {
        const created = await api.createTemplateGroup(nextName);
        setActiveGroup(created.id);
        setGroupPage(Math.ceil((visibleGroupKeys.length + 1) / groupPageSize));
        message.success("分组已创建");
      } else if (editingGroup) {
        await api.updateTemplateGroup(editingGroup, nextName);
        message.success("分组已更新");
      }
      setEditingGroup(null);
      setEditingGroupName("");
      setGroupModalMode("edit");
      await loadData();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "分组保存失败");
    }
  };

  const deleteGroup = async (key: GroupKey) => {
    if (key === "default") {
      message.warning("默认分组不能删除");
      return;
    }
    try {
      await api.deleteTemplateGroup(key);
      if (activeGroup === key) {
        setActiveGroup("default");
      }
      message.success("分组及其模板已删除");
      await loadData();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "分组删除失败");
    }
  };

  const confirmDeleteGroup = (key: GroupKey) => {
    const groupName = getGroupLabel(key, groups);
    const templateCount = groupedTemplates[key]?.length || 0;
    modal.confirm({
      title: "删除模板分组",
      content: templateCount
        ? `确定删除“${groupName}”吗？该分组下的 ${templateCount} 个模板及模板文件会被永久删除。`
        : `确定删除空分组“${groupName}”吗？`,
      okText: "删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      centered: true,
      onOk: () => deleteGroup(key)
    });
  };

  const closeUploadDialog = (cancelActiveUpload = true) => {
    const uploadToken = uploadTokenRef.current;
    if (cancelActiveUpload) {
      if (uploadToken) {
        void api.cancelTemplateUpload(uploadToken).catch(() => undefined);
      }
      uploadAbortRef.current?.abort();
    }
    uploadAbortRef.current = null;
    uploadTokenRef.current = null;
    setPendingUploadFile(null);
    setPendingUploadGroup("default");
    setUploadProgress(0);
    setUploading(false);
  };

  const confirmTemplateUpload = async () => {
    if (!pendingUploadFile || uploading) {
      return;
    }

    const controller = new AbortController();
    const uploadToken = crypto.randomUUID();
    uploadAbortRef.current = controller;
    uploadTokenRef.current = uploadToken;
    setUploading(true);
    setUploadProgress(0);

    try {
      await api.uploadTemplate(
        pendingUploadFile,
        pendingUploadGroup,
        uploadToken,
        setUploadProgress,
        controller.signal
      );
      setActiveGroup(pendingUploadGroup);
      const groupName = getGroupLabel(pendingUploadGroup, groups);
      message.success(`模板已上传到「${groupName}」`);
      closeUploadDialog(false);
      await loadData();
    } catch (error) {
      if (controller.signal.aborted) {
        message.info("已取消模板上传");
      } else {
        message.error(error instanceof Error ? error.message : "模板上传失败");
      }
    } finally {
      if (uploadAbortRef.current === controller) {
        uploadAbortRef.current = null;
        uploadTokenRef.current = null;
        setUploading(false);
      }
    }
  };

  const columns: ColumnsType<TemplateRecord> = [
    {
      title: "模板名称",
      dataIndex: "name",
      width: 180,
      render: (value, record) => (
        <Space size={12}>
          <span className={`template-table-icon ${getIconClass(record)}`}>{getTemplateIcon(record)}</span>
          <Space direction="vertical" size={0}>
            <Typography.Text strong>{value}</Typography.Text>
            <span className={`muted-path${record.description ? "" : " is-empty"}`}>
              {record.description || "暂无模板说明"}
            </span>
          </Space>
        </Space>
      )
    },
    {
      title: "版本",
      dataIndex: "version",
      width: 84,
      render: (value) => value || "1.0.0"
    },
    {
      title: "参数",
      dataIndex: "parameterCount",
      width: 60,
      render: (value) => `${value || 0} 个`
    },
    {
      title: "启用状态",
      dataIndex: "enabled",
      width: 90,
      render: (value) => value
        ? <Tag color="success">启用中</Tag>
        : <Tag>待启用</Tag>
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      width: 120,
      render: (value) => dayjs(value).format("YYYY-MM-DD HH:mm")
    },
    {
      title: "操作",
      width: 150,
      render: (_, record) => (
        <Space>
          <Tooltip title="详情">
            <Button icon={<EyeOutlined />} onClick={() => openDetail(record)} />
          </Tooltip>
          <Tooltip title="配置">
            <Button icon={<EditOutlined />} onClick={() => navigate(`/templates/${record.id}/config`)} />
          </Tooltip>
          <Popconfirm title="删除模板" description="模板文件和参数记录会被删除。" onConfirm={() => remove(record)}>
            <Button danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <div className="page-stack management-page template-page">
      <div className="toolbar">
        <Space direction="vertical" size={0}>
          <Typography.Title level={4} style={{ margin: 0 }}>模板管理</Typography.Title>
          <Typography.Text type="secondary">FME Workspace 模板、分组和运行配置</Typography.Text>
        </Space>
        <div className="template-upload-actions">
          <Upload {...uploadProps}>
            <Button className="template-upload-button" type="primary" icon={<CloudUploadOutlined />}>上传模板</Button>
          </Upload>
          <span className="template-upload-hint">支持 .fmw / .fmwt</span>
        </div>
      </div>

      <div className="stat-grid">
        <Card className="stat-card"><Statistic title="模板总数" value={stats.total} /></Card>
        <Card className="stat-card"><Statistic title="启用中" value={stats.enabled} valueStyle={{ color: "#167d4c" }} /></Card>
        <Card className="stat-card"><Statistic title="待启用" value={stats.disabled} valueStyle={{ color: "#1765d8" }} /></Card>
        <Card className="stat-card"><Statistic title="本月新增" value={stats.monthAdded} /></Card>
      </div>

      <div className="template-management-grid">
        <Card className="table-card template-group-card">
          <div className="template-group-title">
            <Typography.Title level={4} style={{ margin: 0 }}>模板分组</Typography.Title>
            <Button icon={<PlusOutlined />} onClick={createGroup}>新建分组</Button>
          </div>

          <div ref={groupListRef} className="template-group-list">
            {pagedGroupKeys.map((key) => {
              const active = activeGroup === key;
              return (
                <div
                  key={key}
                  role="button"
                  tabIndex={0}
                  className={`template-group-item${active ? " is-active" : ""}`}
                  onClick={() => setActiveGroup(key)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      setActiveGroup(key);
                    }
                  }}
                >
                  <span className="template-group-left">
                    <FolderOutlined />
                    <strong>{getGroupLabel(key, groups)}</strong>
                  </span>
                  <span className="template-group-count">{groupedTemplates[key]?.length || 0}</span>
                  <Dropdown
                    trigger={["click"]}
                    menu={{
                      items: [
                        { key: "edit", label: "编辑分组", icon: <EditOutlined /> },
                        { key: "delete", label: "删除分组", icon: <DeleteOutlined />, danger: true, disabled: key === "default" }
                      ],
                      onClick: ({ key: actionKey, domEvent }) => {
                        domEvent.stopPropagation();
                        if (actionKey === "edit") {
                          startEditGroup(key);
                        }
                        if (actionKey === "delete") {
                          confirmDeleteGroup(key);
                        }
                      }
                    }}
                  >
                    <MoreOutlined className="template-group-more" onClick={(event) => event.stopPropagation()} />
                  </Dropdown>
                </div>
              );
            })}
          </div>

          <Pagination
            className="template-pagination"
            current={groupPage}
            pageSize={groupPageSize}
            total={visibleGroupKeys.length}
            size="small"
            showSizeChanger={false}
            hideOnSinglePage={false}
            onChange={setGroupPage}
          />
        </Card>

        <Card className="table-card management-table-card template-table-card">
          <div className="template-table-heading">
            <Space size={10}>
              <Typography.Text type="secondary">模板管理</Typography.Text>
              <Typography.Text type="secondary">/</Typography.Text>
              <Typography.Text className="template-active-group">{getGroupLabel(activeGroup, groups)}</Typography.Text>
            </Space>
          </div>

          <div className="filter-row template-filter-row">
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索模板名称或说明"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <Select
              value={status}
              onChange={setStatus}
              options={[
                { value: "all", label: "状态：全部" },
                { value: "enabled", label: "启用中" },
                { value: "disabled", label: "待启用" }
              ]}
            />
          </div>

          <Table
            rowKey="id"
            loading={loading || detailLoading}
            columns={columns}
            dataSource={currentGroupTemplates}
            pagination={{
              pageSize: tablePageSize,
              showSizeChanger: false,
              position: ["bottomCenter"],
              hideOnSinglePage: false,
              showTotal: (total) => `共 ${total} 个模板`
            }}
            locale={{ emptyText: <Empty description="当前分组暂无模板" /> }}
          />
        </Card>
      </div>

      <Modal
        title="上传模板"
        open={Boolean(pendingUploadFile)}
        onCancel={() => closeUploadDialog()}
        footer={[
          <Button key="cancel" onClick={() => closeUploadDialog()}>
            {uploading ? "中止上传" : "取消"}
          </Button>,
          <Button
            key="upload"
            type="primary"
            loading={uploading}
            disabled={!pendingUploadFile || !pendingUploadGroup}
            onClick={confirmTemplateUpload}
          >
            确认上传
          </Button>
        ]}
        closable
        maskClosable
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <div className="template-upload-step">
            <Typography.Text type="secondary">1. 已选择模板</Typography.Text>
            <div className="template-upload-file">
              <FileTextOutlined />
              <div>
                <Typography.Text strong>{pendingUploadFile?.name}</Typography.Text>
                <Typography.Text type="secondary">
                  {pendingUploadFile ? formatFileSize(pendingUploadFile.size) : ""}
                </Typography.Text>
              </div>
              <Upload {...uploadProps} disabled={uploading}>
                <Button size="small" disabled={uploading}>重新选择</Button>
              </Upload>
            </div>
          </div>

          <div className="template-upload-step">
            <Typography.Text type="secondary">2. 选择归类分组</Typography.Text>
          <Select
            value={pendingUploadGroup}
            options={groupOptions}
            onChange={setPendingUploadGroup}
            disabled={uploading}
            style={{ width: "100%" }}
          />
          </div>

          <div className="template-upload-step">
            <Typography.Text type="secondary">3. 确认后开始上传模板</Typography.Text>
            {uploading && <Progress percent={uploadProgress} size="small" />}
          </div>
        </Space>
      </Modal>

      <Modal
        width={900}
        title="模板详情"
        open={Boolean(selected)}
        onCancel={() => setSelected(null)}
        footer={selected ? (
          <Space>
            <Button onClick={() => setSelected(null)}>关闭</Button>
          </Space>
        ) : null}
      >
        {selected && (
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="模板说明" span={2}>
              {selected.description || "暂无模板说明"}
            </Descriptions.Item>
            <Descriptions.Item label="模板名称">{selected.name}</Descriptions.Item>
            <Descriptions.Item label="文件类型">{selected.fileType}</Descriptions.Item>
            <Descriptions.Item label="参数数量">{selected.parameterCount}</Descriptions.Item>
            <Descriptions.Item label="模板版本">{selected.version || "1.0.0"}</Descriptions.Item>
            <Descriptions.Item label="启用状态">
              {selected.enabled ? <Tag color="success">启用中</Tag> : <Tag>待启用</Tag>}
            </Descriptions.Item>
            <Descriptions.Item label="模板路径" span={2}>{selected.filePath}</Descriptions.Item>
          </Descriptions>
        )}
      </Modal>

      <Modal
        title={groupModalMode === "create" ? "新建分组" : "编辑分组"}
        open={groupModalMode === "create" || Boolean(editingGroup)}
        onOk={saveGroupName}
        onCancel={() => {
          setEditingGroup(null);
          setEditingGroupName("");
          setGroupModalMode("edit");
        }}
        okText={groupModalMode === "create" ? "创建" : "保存"}
        cancelText="取消"
      >
        <Input
          autoFocus
          placeholder="请输入分组名称"
          value={editingGroupName}
          onChange={(event) => setEditingGroupName(event.target.value)}
          onPressEnter={saveGroupName}
        />
      </Modal>
    </div>
  );
}

function getGroupLabel(key: GroupKey, groups: TemplateGroup[]): string {
  return groups.find((group) => group.id === key)?.name || "默认分组";
}

function getTemplateIcon(template: TemplateRecord) {
  const text = `${template.name} ${template.fileName}`.toLowerCase();
  if (/json|code|api|接口/.test(text)) return <CodeOutlined />;
  if (/excel|xls|csv/.test(text)) return <FileExcelOutlined />;
  if (/database|db|数据库|表/.test(text)) return <DatabaseOutlined />;
  if (/api|服务/.test(text)) return <ApiOutlined />;
  return <FileTextOutlined />;
}

function getIconClass(template: TemplateRecord): string {
  const text = `${template.name} ${template.fileName}`.toLowerCase();
  if (/json|code|api|接口/.test(text)) return "is-blue";
  if (/excel|xls|csv/.test(text)) return "is-teal";
  if (/database|db|数据库|表/.test(text)) return "is-purple";
  if (/xml/.test(text)) return "is-orange";
  return "is-green";
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
