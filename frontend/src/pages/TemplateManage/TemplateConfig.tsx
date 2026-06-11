import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  App,
  Alert,
  Button,
  Card,
  Checkbox,
  ColorPicker,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  TimePicker,
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  FileSearchOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  PlayCircleOutlined,
  SaveOutlined,
  SyncOutlined
} from "@ant-design/icons";
import dayjs from "dayjs";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../services/api";
import type { TemplateDetail, TemplateParameter } from "../../types";

const outputFormatOptions = [
  { value: "glb", label: "GLB" },
  { value: "gltf", label: "glTF" },
  { value: "3dtiles", label: "3D Tiles" },
  { value: "json", label: "JSON" },
  { value: "fbx", label: "FBX" },
  { value: "obj", label: "OBJ" }
];

const encodingOptions = [
  "UTF-8",
  "GBK",
  "GB18030",
  "ISO-8859-1",
  "Windows-1252",
  "Big5",
  "Shift_JIS"
].map((value) => ({ value, label: value }));

const { TextArea, Password } = Input;

export default function TemplateConfig() {
  const { id } = useParams<{ id: string }>();
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [description, setDescription] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [enabled, setEnabled] = useState(false);
  const [parameterLabels, setParameterLabels] = useState<Record<string, string>>({});
  const [savingConfiguration, setSavingConfiguration] = useState(false);
  const [parsing, setParsing] = useState(false);

  const applyTemplateDetail = (detail: TemplateDetail) => {
    setTemplate(detail);
    setDescription(detail.description || "");
    setVersion(detail.version || "1.0.0");
    setEnabled(detail.enabled);
    setParameterLabels(Object.fromEntries(
      detail.parameters.map((parameter) => [parameter.id, parameter.label])
    ));
    form.resetFields();
    form.setFieldsValue({
      parameters: Object.fromEntries(
        detail.parameters.map((parameter) => [
          parameter.name,
          coerceDefaultValue(parameter)
        ])
      )
    });
  };

  useEffect(() => {
    if (!id) {
      return;
    }
    const load = async () => {
      setLoading(true);
      try {
        const detail = await api.getTemplate(id);
        applyTemplateDetail(detail);
      } catch (error) {
        message.error(error instanceof Error ? error.message : "模板加载失败");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [id, form, message]);

  const requiredCount = useMemo(() => template?.parameters.filter((item) => item.required).length || 0, [template]);
  const configurationChanged = useMemo(() => {
    if (!template) {
      return false;
    }
    return (
      description.trim() !== (template.description || "") ||
      version.trim() !== (template.version || "1.0.0") ||
      enabled !== template.enabled ||
      template.parameters.some((parameter) => (
        (parameterLabels[parameter.id] || "").trim() !== parameter.label
      ))
    );
  }, [description, enabled, parameterLabels, template, version]);

  const saveConfiguration = async () => {
    if (!template) {
      return;
    }
    if (!version.trim()) {
      message.warning("模板版本号不能为空");
      return;
    }
    const emptyParameter = template.parameters.find((parameter) => (
      !(parameterLabels[parameter.id] || "").trim()
    ));
    if (emptyParameter) {
      message.warning(`参数“${emptyParameter.name}”的名称不能为空`);
      return;
    }

    setSavingConfiguration(true);
    try {
      const updated = await api.updateTemplateConfiguration(template.id, {
        description,
        version,
        enabled,
        parameterLabels: template.parameters.map((parameter) => ({
          id: parameter.id,
          label: (parameterLabels[parameter.id] || parameter.label).trim()
        }))
      });
      setTemplate(updated);
      setDescription(updated.description || "");
      setVersion(updated.version || "1.0.0");
      setEnabled(updated.enabled);
      setParameterLabels(Object.fromEntries(
        updated.parameters.map((parameter) => [parameter.id, parameter.label])
      ));
      message.success("模板配置已保存");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "模板配置保存失败");
    } finally {
      setSavingConfiguration(false);
    }
  };

  const reparseTemplate = async () => {
    if (!template) {
      return;
    }
    setParsing(true);
    try {
      const parsed = await api.parseTemplate(template.id);
      applyTemplateDetail(parsed);
      if (parsed.parseStatus === "failed") {
        message.error(parsed.parseMessage || "模板重新解析失败");
      } else {
        message.success(parsed.parseMessage || `已识别 ${parsed.parameterCount} 个参数`);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "模板重新解析失败");
    } finally {
      setParsing(false);
    }
  };

  const confirmReparse = () => {
    if (!configurationChanged) {
      void reparseTemplate();
      return;
    }
    modal.confirm({
      title: "重新解析模板参数",
      content: "当前存在未保存的模板配置。重新解析会覆盖参数列表和未保存的参数别名。",
      okText: "继续解析",
      cancelText: "取消",
      centered: true,
      onOk: reparseTemplate
    });
  };

  const submit = async (values: {
    parameters?: Record<string, unknown>;
  }) => {
    if (!template) {
      return;
    }
    setRunning(true);

    const taskPromise = api.runTask({
      templateId: template.id,
      taskName: `${template.name} 转换任务`,
      parameters: normalizeParameters(values.parameters || {})
    });

    navigate("/results", {
      state: {
        pendingTaskSubmittedAt: Date.now()
      }
    });

    taskPromise
      .then(() => {
        message.success("转换任务已创建");
      })
      .catch((error) => {
        message.error(error instanceof Error ? error.message : "任务创建失败");
      })
      .finally(() => {
        setRunning(false);
      });
  };

  if (loading) {
    return (
      <div className="center-state">
        <Spin />
      </div>
    );
  }

  if (!template) {
    return <Empty description="模板不存在" />;
  }

  return (
    <div className="page-stack">
      <div className="toolbar">
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate("/templates")}>
            返回
          </Button>
          <Space direction="vertical" size={0}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              模板配置
            </Typography.Title>
            <Typography.Text type="secondary">{template.name}</Typography.Text>
          </Space>
        </Space>
        <Space>
          <Button
            icon={<SyncOutlined />}
            loading={parsing}
            disabled={savingConfiguration}
            onClick={confirmReparse}
          >
            重新解析
          </Button>
          <Button
            type="primary"
            icon={<SaveOutlined />}
            loading={savingConfiguration}
            disabled={!configurationChanged || parsing}
            onClick={saveConfiguration}
          >
            保存配置
          </Button>
        </Space>
      </div>

      <div className="config-grid">
        <Card className="form-card" title="运行参数">
          <Form form={form} layout="vertical" onFinish={submit}>
            {template.parameters.length ? (
              template.parameters.map((parameter) => renderParameterItem(
                parameter,
                parameterLabels[parameter.id] || parameter.label || parameter.name,
                (label) => setParameterLabels((current) => ({
                  ...current,
                  [parameter.id]: label
                }))
              ))
            ) : (
              <Empty description="暂无可配置参数" />
            )}

            <Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                icon={<PlayCircleOutlined />}
                loading={running}
                disabled={!template.enabled}
              >
                发起转换
              </Button>
            </Form.Item>
          </Form>
        </Card>

        <Space direction="vertical" size={16} className="full-height">
          <Card className="detail-card" title="模板设置">
            <Space direction="vertical" size={16} style={{ width: "100%" }}>
              <div>
                <Typography.Text type="secondary">模板版本</Typography.Text>
                <Input
                  value={version}
                  maxLength={30}
                  placeholder="例如 1.0.0"
                  onChange={(event) => setVersion(event.target.value)}
                  style={{ marginTop: 6 }}
                />
              </div>
              <div className="template-enabled-setting">
                <div>
                  <Typography.Text strong>启用模板</Typography.Text>
                  <div className="parameter-help">
                    {enabled ? "启用中" : "待启用"}
                  </div>
                </div>
                <Switch checked={enabled} onChange={setEnabled} />
              </div>
              <div>
                <Typography.Text type="secondary">模板说明</Typography.Text>
                <TextArea
                  value={description}
                  rows={4}
                  maxLength={500}
                  showCount
                  placeholder="请输入模板用途、适用数据和输出成果"
                  onChange={(event) => setDescription(event.target.value)}
                  style={{ marginTop: 6 }}
                />
              </div>
            </Space>
          </Card>

          <Card className="detail-card" title="模板基础信息">
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="模板名称">{template.name}</Descriptions.Item>
              <Descriptions.Item label="文件类型">{template.fileType}</Descriptions.Item>
              <Descriptions.Item label="参数数量">{template.parameterCount}</Descriptions.Item>
              <Descriptions.Item label="必填参数">{requiredCount}</Descriptions.Item>
            </Descriptions>
          </Card>
        </Space>
      </div>
    </div>
  );
}

function renderParameterItem(
  parameter: TemplateParameter,
  parameterLabel: string,
  onParameterLabelChange: (label: string) => void
) {
  const commonProps = {
    name: ["parameters", parameter.name],
    label: (
      <EditableParameterLabel
        value={parameterLabel}
        fallback={parameter.label || parameter.name}
        onChange={onParameterLabelChange}
      />
    ),
    rules: parameter.required ? [{ required: true, message: `请填写 ${parameterLabel}` }] : undefined,
    tooltip: parameter.description || parameter.name
  };

  if (parameter.type === "message") {
    return (
      <Form.Item key={parameter.id} label={commonProps.label} tooltip={parameter.description || parameter.name}>
        <Alert
          type="info"
          showIcon
          message={parameterLabel}
          description={parameter.defaultValue || parameter.description || "运行时提示信息"}
        />
      </Form.Item>
    );
  }

  if (isPathParameter(parameter)) {
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        <PathParameterInput parameter={parameter} />
      </Form.Item>
    );
  }

  if (parameter.type === "boolean") {
    return (
      <Form.Item key={parameter.id} {...commonProps} valuePropName="checked">
        <Switch checkedChildren="是" unCheckedChildren="否" />
      </Form.Item>
    );
  }

  if (parameter.type === "number") {
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        <InputNumber style={{ width: "100%" }} />
      </Form.Item>
    );
  }

  if (parameter.type === "datetime") {
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        <DatePicker showTime style={{ width: "100%" }} />
      </Form.Item>
    );
  }

  if (parameter.type === "date") {
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        <DatePicker style={{ width: "100%" }} />
      </Form.Item>
    );
  }

  if (parameter.type === "time") {
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        <TimePicker style={{ width: "100%" }} />
      </Form.Item>
    );
  }

  if (parameter.type === "password") {
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        <Password placeholder="请输入密码或密钥" />
      </Form.Item>
    );
  }

  if (parameter.type === "color") {
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        <ColorPicker showText />
      </Form.Item>
    );
  }

  if (parameter.type === "table") {
    return renderTableParameter(parameter, commonProps);
  }

  if (parameter.type === "enum" || parameter.type === "choice_alias" || parameter.type === "output_format") {
    const options = parameter.options.length
      ? parameter.options
      : parameter.type === "output_format"
        ? outputFormatOptions
        : [];
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        {options.length ? (
          <Select allowClear options={options} />
        ) : (
          <Input placeholder={placeholderFor(parameter)} />
        )}
      </Form.Item>
    );
  }

  if (
    parameter.type === "multi_choice" ||
    parameter.type === "attribute_name" ||
    parameter.type === "attribute_select" ||
    parameter.type === "attribute_expose"
  ) {
    const options = parameter.options;
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        {parameter.type === "attribute_expose" && options.length > 0 ? (
          <Checkbox.Group options={options} />
        ) : (
          <Select mode="tags" allowClear options={options} placeholder={placeholderFor(parameter)} />
        )}
      </Form.Item>
    );
  }

  if (parameter.type === "feature_type" || parameter.type === "coordinate_system") {
    const options = parameter.options;
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        {options.length ? (
          <Select showSearch allowClear options={options} placeholder={placeholderFor(parameter)} />
        ) : (
          <Input placeholder={placeholderFor(parameter)} />
        )}
      </Form.Item>
    );
  }

  if (parameter.type === "checkbox_group") {
    const options = parameter.options;
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        <Checkbox.Group options={options} />
      </Form.Item>
    );
  }

  if (parameter.type === "encoding") {
    const options = parameter.options.length
      ? parameter.options
      : encodingOptions;
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        <Select showSearch allowClear options={options} />
      </Form.Item>
    );
  }

  if (parameter.type === "database_connection" || parameter.type === "web_connection" || parameter.type === "scripted_selection") {
    const options = parameter.options;
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        {options.length ? (
          <Select showSearch allowClear options={options} placeholder={placeholderFor(parameter)} />
        ) : (
          <Input placeholder={placeholderFor(parameter)} />
        )}
      </Form.Item>
    );
  }

  if (parameter.type === "scripted_value") {
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        <Input disabled placeholder="由 FME/Python 脚本在运行时计算" />
      </Form.Item>
    );
  }

  if (parameter.type === "textarea" || parameter.type === "geometry") {
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        <TextArea rows={parameter.type === "geometry" ? 6 : 4} placeholder={placeholderFor(parameter)} />
      </Form.Item>
    );
  }

  if (parameter.type === "url") {
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        <Input type="url" placeholder="https://example.com" />
      </Form.Item>
    );
  }

  return (
    <Form.Item key={parameter.id} {...commonProps}>
      <Input placeholder={placeholderFor(parameter)} />
    </Form.Item>
  );
}

function EditableParameterLabel({
  value,
  fallback,
  onChange
}: {
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}) {
  return (
    <Typography.Text
      className="editable-parameter-label"
      editable={{
        tooltip: "修改参数别名",
        triggerType: ["text", "icon"],
        onChange: (nextValue) => onChange(nextValue.trim() || fallback)
      }}
    >
      {value || fallback}
    </Typography.Text>
  );
}

function PathParameterInput({
  parameter,
  value,
  onChange
}: {
  parameter: TemplateParameter;
  value?: string;
  onChange?: (value: string) => void;
}) {
  const { message } = App.useApp();
  const [selecting, setSelecting] = useState(false);
  const kind = getPathKind(parameter);

  const selectPath = async () => {
    setSelecting(true);
    try {
      const result = await api.selectLocalPath({
        kind,
        initialPath: value,
        multiple: kind === "file" && parameter.multiple
      });
      if (!result.cancelled && result.paths.length) {
        onChange?.(result.paths.join(","));
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "本地路径选择失败");
    } finally {
      setSelecting(false);
    }
  };

  return (
    <div className="path-parameter-control">
      <Space.Compact style={{ width: "100%" }}>
        <Input
          value={value}
          placeholder={placeholderFor(parameter)}
          onChange={(event) => onChange?.(event.target.value)}
        />
        <Button
          icon={kind === "folder" ? <FolderOpenOutlined /> : <FileSearchOutlined />}
          loading={selecting}
          onClick={selectPath}
        >
          {kind === "folder" ? "选择目录" : "选择文件"}
        </Button>
      </Space.Compact>
    </div>
  );
}

function renderTableParameter(
  parameter: TemplateParameter,
  commonProps: {
    label: ReactNode;
    rules?: Array<{ required: boolean; message: string }>;
    tooltip?: string;
  }
) {
  return (
    <Form.Item
      key={parameter.id}
      label={commonProps.label}
      tooltip={commonProps.tooltip}
      required={Boolean(commonProps.rules?.length)}
    >
      <Form.List name={["parameters", parameter.name]}>
        {(fields, { add, remove }) => {
          const columns: ColumnsType<{ key: number; name: number }> = [
            {
              title: "字段",
              render: (_, field) => (
                <Form.Item name={[field.name, "key"]} style={{ margin: 0 }}>
                  <Input placeholder="字段名" />
                </Form.Item>
              )
            },
            {
              title: "值",
              render: (_, field) => (
                <Form.Item name={[field.name, "value"]} style={{ margin: 0 }}>
                  <Input placeholder="字段值" />
                </Form.Item>
              )
            },
            {
              title: "",
              width: 56,
              render: (_, field) => (
                <Button danger icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
              )
            }
          ];

          return (
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              <Table
                size="small"
                rowKey="key"
                columns={columns}
                dataSource={fields}
                pagination={false}
                locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无表格行" /> }}
              />
              <Button icon={<PlusOutlined />} onClick={() => add({ key: "", value: "" })}>
                添加行
              </Button>
            </Space>
          );
        }}
      </Form.List>
    </Form.Item>
  );
}

function placeholderFor(parameter: TemplateParameter): string {
  if (parameter.type === "file" || parameter.pathKind === "file") return "请输入或粘贴文件路径";
  if (parameter.type === "folder" || parameter.pathKind === "folder") return "请输入或粘贴目录路径";
  if (parameter.type === "reprojection_file") return "请选择或粘贴坐标转换网格文件路径";
  if (parameter.type === "source_dataset") return "请选择或粘贴源数据集路径";
  if (parameter.type === "path") return "请输入路径";
  if (parameter.type === "url") return "请输入 URL";
  if (parameter.type === "coordinate_system") return "例如 EPSG:4547";
  if (parameter.type === "geometry") return "请输入 GeoJSON 几何或范围";
  if (parameter.type === "database_connection") return "请选择数据库连接";
  if (parameter.type === "web_connection") return "请选择 Web/API 连接";
  if (parameter.type === "scripted_selection") return "请选择脚本生成的选项";
  if (parameter.type === "attribute_name" || parameter.type === "attribute_select" || parameter.type === "attribute_expose") return "输入或选择属性字段";
  if (parameter.type === "feature_type") return "输入或选择图层 / 表";
  return "请输入参数值";
}

function coerceDefaultValue(parameter: TemplateParameter): unknown {
  if (parameter.type === "message") {
    return undefined;
  }
  if (parameter.defaultValue === null || parameter.defaultValue === undefined) {
    return parameter.type === "boolean" ? false : undefined;
  }
  if (parameter.type === "boolean") {
    return /^(true|yes|1)$/i.test(parameter.defaultValue);
  }
  if (parameter.type === "number") {
    const value = Number(parameter.defaultValue);
    return Number.isNaN(value) ? undefined : value;
  }
  if (parameter.type === "date" || parameter.type === "time" || parameter.type === "datetime") {
    const value = dayjs(parameter.defaultValue);
    return value.isValid() ? value : undefined;
  }
  if (parameter.type === "multi_choice" || parameter.type === "checkbox_group" || parameter.type === "attribute_select" || parameter.type === "attribute_expose") {
    return splitDefaultList(parameter.defaultValue);
  }
  if (parameter.type === "table") {
    return parseTableDefault(parameter.defaultValue);
  }
  return parameter.defaultValue;
}

function isPathParameter(parameter: TemplateParameter): boolean {
  return Boolean(parameter.pathKind) || [
    "file",
    "folder",
    "path",
    "reprojection_file",
    "source_dataset",
    "destination_dataset"
  ].includes(parameter.type);
}

function getPathKind(parameter: TemplateParameter): "file" | "folder" {
  if (parameter.pathKind) {
    return parameter.pathKind;
  }
  return parameter.type === "folder" ? "folder" : "file";
}

function normalizeParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(parameters)
      .map(([key, value]) => [key, normalizeParameterValue(value)] as const)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function normalizeParameterValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(normalizeParameterValue)
      .filter((item) => item !== undefined && item !== null && item !== "");
  }
  if (value && typeof value === "object") {
    const maybeDate = value as { toISOString?: () => string; toHexString?: () => string };
    if (typeof maybeDate.toHexString === "function") {
      return maybeDate.toHexString();
    }
    if (typeof maybeDate.toISOString === "function") {
      return maybeDate.toISOString();
    }
  }
  return value;
}

function splitDefaultList(value: string | null): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const values = value
    .split(/[|;,%]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}

function parseTableDefault(value: string | null): Array<{ key: string; value: string }> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item, index) => ({
        key: String((item && typeof item === "object" ? (item as Record<string, unknown>).key : index) ?? index),
        value: String(item && typeof item === "object" ? (item as Record<string, unknown>).value ?? "" : item)
      }));
    }
    if (parsed && typeof parsed === "object") {
      return Object.entries(parsed as Record<string, unknown>).map(([key, itemValue]) => ({
        key,
        value: String(itemValue ?? "")
      }));
    }
  } catch {
    // Non-JSON table defaults are kept as a single editable value row.
  }
  return [{ key: "value", value }];
}
