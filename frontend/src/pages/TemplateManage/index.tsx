import { useEffect, useMemo, useState } from "react";
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
  Select,
  Space,
  Statistic,
  Table,
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
import { ParseStatusTag } from "../../components/StatusTag";
import { api } from "../../services/api";
import type { ParseStatus, TemplateDetail, TemplateRecord } from "../../types";

type GroupKey = string;
type SortKey = "updated-desc" | "updated-asc" | "name-asc" | "params-desc";
type GroupOverrides = Record<GroupKey, { label?: string; deleted?: boolean; custom?: boolean }>;
type GroupAssignments = Record<string, GroupKey>;

const groupMeta: Record<GroupKey, { label: string; description: string }> = {
  default: { label: "默认分组", description: "未分类模板" },
  conversion: { label: "数据转换", description: "格式转换、数据入库和批处理" },
  spatial: { label: "空间处理", description: "坐标、几何和空间数据处理" },
  quality: { label: "质检检查", description: "数据质量检查和治理" },
  publish: { label: "发布服务", description: "成果发布、服务生成和接口模板" }
};

const builtInGroupKeys = Object.keys(groupMeta);
const groupOverrideStorageKey = "c2s-template-group-overrides";
const groupAssignmentStorageKey = "c2s-template-group-assignments";
const groupPageSize = 8;

export default function TemplateManage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeGroup, setActiveGroup] = useState<GroupKey>("default");
  const [keyword, setKeyword] = useState("");
  const [status, setStatus] = useState<ParseStatus | "all">("all");
  const [sort, setSort] = useState<SortKey>("updated-desc");
  const [selected, setSelected] = useState<TemplateDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [groupInitialized, setGroupInitialized] = useState(false);
  const [groupOverrides, setGroupOverrides] = useState<GroupOverrides>(() => loadGroupOverrides());
  const [groupAssignments, setGroupAssignments] = useState<GroupAssignments>(() => loadGroupAssignments());
  const [editingGroup, setEditingGroup] = useState<GroupKey | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [groupModalMode, setGroupModalMode] = useState<"create" | "edit">("edit");
  const [pendingUploadTemplate, setPendingUploadTemplate] = useState<TemplateDetail | null>(null);
  const [pendingUploadGroup, setPendingUploadGroup] = useState<GroupKey>("default");
  const [groupPage, setGroupPage] = useState(1);

  const loadTemplates = async () => {
    setLoading(true);
    try {
      setTemplates(await api.listTemplates({}));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "模板加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadTemplates();
  }, []);

  useEffect(() => {
    localStorage.setItem(groupOverrideStorageKey, JSON.stringify(groupOverrides));
  }, [groupOverrides]);

  useEffect(() => {
    localStorage.setItem(groupAssignmentStorageKey, JSON.stringify(groupAssignments));
  }, [groupAssignments]);

  const visibleGroupKeys = useMemo(() => {
    const allKeys = Array.from(new Set([...builtInGroupKeys, ...Object.keys(groupOverrides)]));
    return allKeys.filter((key) => !groupOverrides[key]?.deleted);
  }, [groupOverrides]);

  const groupOptions = useMemo(
    () => visibleGroupKeys.map((key) => ({ value: key, label: getGroupLabel(key, groupOverrides) })),
    [groupOverrides, visibleGroupKeys]
  );

  const groupedTemplates = useMemo(() => {
    const result: Record<GroupKey, TemplateRecord[]> = {};
    visibleGroupKeys.forEach((key) => {
      result[key] = [];
    });
    result.default = result.default || [];

    templates.forEach((template) => {
      const assignedGroup = groupAssignments[template.id];
      const inferredGroup = assignedGroup || inferGroup(template);
      const group = groupOverrides[inferredGroup]?.deleted ? "default" : inferredGroup;
      result[group] = result[group] || [];
      result[group].push(template);
    });

    return result;
  }, [groupAssignments, groupOverrides, templates, visibleGroupKeys]);

  const currentGroupTemplates = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    const filtered = (groupedTemplates[activeGroup] || []).filter((template) => {
      if (status !== "all" && template.parseStatus !== status) {
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

    return filtered.sort((a, b) => {
      if (sort === "updated-asc") return dayjs(a.updatedAt).valueOf() - dayjs(b.updatedAt).valueOf();
      if (sort === "name-asc") return a.name.localeCompare(b.name, "zh-Hans-CN");
      if (sort === "params-desc") return b.parameterCount - a.parameterCount;
      return dayjs(b.updatedAt).valueOf() - dayjs(a.updatedAt).valueOf();
    });
  }, [activeGroup, groupedTemplates, keyword, sort, status]);

  const pagedGroupKeys = useMemo(
    () => visibleGroupKeys.slice((groupPage - 1) * groupPageSize, groupPage * groupPageSize),
    [groupPage, visibleGroupKeys]
  );

  const stats = useMemo(() => ({
    total: templates.length,
    groups: visibleGroupKeys.length,
    enabled: templates.filter((template) => template.parseStatus === "success").length,
    failed: templates.filter((template) => template.parseStatus === "failed").length
  }), [templates, visibleGroupKeys]);

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
  }, [groupPage, visibleGroupKeys]);

  const uploadProps: UploadProps = {
    accept: ".fmw,.fmwt",
    maxCount: 1,
    showUploadList: false,
    customRequest: async ({ file, onSuccess, onError, onProgress }) => {
      try {
        const uploaded = await api.uploadTemplate(file as File, (percent) => onProgress?.({ percent }));
        setPendingUploadTemplate(uploaded);
        setPendingUploadGroup(visibleGroupKeys.includes(activeGroup) ? activeGroup : "default");
        message.success("模板已上传，请选择所属分组");
        onSuccess?.("ok");
      } catch (error) {
        const err = error instanceof Error ? error : new Error("模板上传失败");
        message.error(err.message);
        onError?.(err);
      }
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
      setGroupAssignments((current) => {
        const next = { ...current };
        delete next[record.id];
        return next;
      });
      message.success("模板已删除");
      await loadTemplates();
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
    setEditingGroupName(getGroupLabel(key, groupOverrides));
  };

  const saveGroupName = () => {
    const nextName = editingGroupName.trim();
    if (!nextName) {
      message.warning("分组名称不能为空");
      return;
    }
    if (visibleGroupKeys.some((key) => key !== editingGroup && getGroupLabel(key, groupOverrides) === nextName)) {
      message.warning("分组名称已存在");
      return;
    }
    if (groupModalMode === "create") {
      const key = `custom-${Date.now()}`;
      setGroupOverrides((current) => ({ ...current, [key]: { label: nextName, custom: true } }));
      setActiveGroup(key);
      setGroupPage(Math.ceil((visibleGroupKeys.length + 1) / groupPageSize));
      setEditingGroupName("");
      setGroupModalMode("edit");
      message.success("分组已创建");
      return;
    }
    if (!editingGroup) {
      return;
    }
    setGroupOverrides((current) => ({
      ...current,
      [editingGroup]: { ...current[editingGroup], label: nextName }
    }));
    setEditingGroup(null);
    setEditingGroupName("");
    message.success("分组已更新");
  };

  const deleteGroups = (keys: GroupKey[]) => {
    const deletableKeys = keys.filter((key) => key !== "default");
    if (!deletableKeys.length) {
      message.warning("默认分组不能删除");
      return;
    }
    setGroupOverrides((current) => {
      const next = { ...current };
      deletableKeys.forEach((key) => {
        next[key] = { ...next[key], deleted: true };
      });
      return next;
    });
    setGroupAssignments((current) => {
      const next = { ...current };
      Object.entries(next).forEach(([templateId, group]) => {
        if (deletableKeys.includes(group)) {
          next[templateId] = "default";
        }
      });
      return next;
    });
    if (deletableKeys.includes(activeGroup)) {
      setActiveGroup("default");
    }
    message.success(`已删除 ${deletableKeys.length} 个分组，模板已归入默认分组`);
  };

  const confirmUploadedTemplateGroup = async () => {
    if (!pendingUploadTemplate) {
      return;
    }
    setGroupAssignments((current) => ({
      ...current,
      [pendingUploadTemplate.id]: pendingUploadGroup
    }));
    setActiveGroup(pendingUploadGroup);
    const groupName = getGroupLabel(pendingUploadGroup, groupOverrides);
    setPendingUploadTemplate(null);
    message.success(`模板已归类到「${groupName}」`);
    await loadTemplates();
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
            <span className="muted-path">{record.description || getTemplateDescription(record)}</span>
          </Space>
        </Space>
      )
    },
    {
      title: "参数",
      dataIndex: "parameterCount",
      width: 50,
      render: (value) => `${value || 0} 个`
    },
    {
      title: "解析状态",
      dataIndex: "parseStatus",
      width: 90,
      render: (value) => <ParseStatusTag status={value} />
    },
    {
      title: "更新时间",
      dataIndex: "updatedAt",
      width: 100,
      render: (value) => dayjs(value).format("YYYY-MM-DD HH:mm")
    },
    {
      title: "操作",
      width: 112,
      render: (_, record) => (
        <Space size={4}>
          <Tooltip title="详情">
            <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(record)} />
          </Tooltip>
          <Tooltip title="编辑">
            <Button size="small" icon={<EditOutlined />} onClick={() => navigate(`/templates/${record.id}/config`)} />
          </Tooltip>
          <Popconfirm title="删除模板" description="模板文件和参数记录会被删除。" onConfirm={() => remove(record)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      )
    }
  ];

  return (
    <div className="page-stack template-page">
      <div className="toolbar">
        <Space direction="vertical" size={0}>
          <Typography.Title level={4} style={{ margin: 0 }}>模板管理</Typography.Title>
          <Typography.Text type="secondary">FME Workspace 模板、分组和参数解析</Typography.Text>
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
        <Card className="stat-card"><Statistic title="分组数量" value={stats.groups} valueStyle={{ color: "#1765d8" }} /></Card>
        <Card className="stat-card"><Statistic title="已解析" value={stats.enabled} valueStyle={{ color: "#167d4c" }} /></Card>
        <Card className="stat-card"><Statistic title="解析失败" value={stats.failed} valueStyle={{ color: "#c73333" }} /></Card>
      </div>

      <div className="template-management-grid">
        <Card className="table-card template-group-card">
          <div className="template-group-title">
            <Typography.Title level={4} style={{ margin: 0 }}>模板分组</Typography.Title>
            <Button icon={<PlusOutlined />} onClick={createGroup}>新建分组</Button>
          </div>

          <div className="template-group-list">
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
                    <strong>{getGroupLabel(key, groupOverrides)}</strong>
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
                          deleteGroups([key]);
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

          {visibleGroupKeys.length > groupPageSize && (
            <Pagination
              className="template-pagination"
              current={groupPage}
              pageSize={groupPageSize}
              total={visibleGroupKeys.length}
              size="small"
              showSizeChanger={false}
              onChange={setGroupPage}
            />
          )}
        </Card>

        <Card className="table-card template-table-card">
          <div className="template-table-heading">
            <Space size={10}>
              <Typography.Text type="secondary">模板管理</Typography.Text>
              <Typography.Text type="secondary">/</Typography.Text>
              <Typography.Text className="template-active-group">{getGroupLabel(activeGroup, groupOverrides)}</Typography.Text>
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
                { value: "success", label: "解析成功" },
                { value: "pending", label: "待解析" },
                { value: "parsing", label: "解析中" },
                { value: "failed", label: "解析失败" }
              ]}
            />
            <Select
              value={sort}
              onChange={setSort}
              options={[
                { value: "updated-desc", label: "排序：更新时间（最新）" },
                { value: "updated-asc", label: "排序：更新时间（最早）" },
                { value: "name-asc", label: "排序：名称" },
                { value: "params-desc", label: "排序：参数数量" }
              ]}
            />
          </div>

          <Table
            rowKey="id"
            loading={loading || detailLoading}
            columns={columns}
            dataSource={currentGroupTemplates}
            pagination={{
              pageSize: 8,
              showSizeChanger: false,
              position: ["bottomCenter"],
              showTotal: (total) => `共 ${total} 个模板`
            }}
            locale={{ emptyText: <Empty description="当前分组暂无模板" /> }}
          />
        </Card>
      </div>

      <Modal
        title="选择模板分组"
        open={Boolean(pendingUploadTemplate)}
        onOk={confirmUploadedTemplateGroup}
        okText="确认归类"
        cancelButtonProps={{ style: { display: "none" } }}
        closable={false}
        maskClosable={false}
      >
        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <Typography.Text>
            模板「{pendingUploadTemplate?.name}」已上传完成，请选择要归类到的分组。
          </Typography.Text>
          <Select
            value={pendingUploadGroup}
            options={groupOptions}
            onChange={setPendingUploadGroup}
            style={{ width: "100%" }}
          />
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
            <Descriptions.Item label="模板名称">{selected.name}</Descriptions.Item>
            <Descriptions.Item label="文件类型">{selected.fileType}</Descriptions.Item>
            <Descriptions.Item label="参数数量">{selected.parameterCount}</Descriptions.Item>
            <Descriptions.Item label="解析状态"><ParseStatusTag status={selected.parseStatus} /></Descriptions.Item>
            <Descriptions.Item label="解析信息" span={2}>{selected.parseMessage || "-"}</Descriptions.Item>
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

function loadGroupOverrides(): GroupOverrides {
  try {
    const raw = localStorage.getItem(groupOverrideStorageKey);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as GroupOverrides;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function loadGroupAssignments(): GroupAssignments {
  try {
    const raw = localStorage.getItem(groupAssignmentStorageKey);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as GroupAssignments;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getGroupLabel(key: GroupKey, overrides: GroupOverrides): string {
  return overrides[key]?.label || groupMeta[key]?.label || "默认分组";
}

function inferGroup(template: TemplateRecord): GroupKey {
  const text = `${template.name} ${template.fileName} ${template.outputDataType || ""}`.toLowerCase();
  if (/质检|检查|治理|quality|check|validate/.test(text)) return "quality";
  if (/发布|服务|api|接口|publish|service/.test(text)) return "publish";
  if (/空间|坐标|gis|shp|dwg|3dtiles|cesium|revit|rvt|fbx|udatasmith/.test(text)) return "spatial";
  if (/csv|json|excel|xml|转换|convert|translator|database|db|数据库/.test(text)) return "conversion";
  return "default";
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

function getTemplateDescription(template: TemplateRecord): string {
  if (template.parameterCount) {
    return `已识别 ${template.parameterCount} 个 FME 参数，可配置后运行转换。`;
  }
  return "FME Workspace 模板，支持上传、查看、编辑和运行。";
}
