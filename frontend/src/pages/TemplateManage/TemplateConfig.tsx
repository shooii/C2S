import { useEffect, useMemo, useState } from "react";
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
  Typography
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  PlusOutlined,
  PlayCircleOutlined
} from "@ant-design/icons";
import dayjs from "dayjs";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../services/api";
import type { TemplateDetail, TemplateParameter } from "../../types";
import { ParseStatusTag } from "../../components/StatusTag";

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

function isAutoOutputDirectoryParameter(parameter: TemplateParameter): boolean {
  const name = parameter.name.trim().replace(/^-+/, "");
  if (/^(OUTPUT_DIR|OUTPUT_DIRECTORY|OUTPUT_PATH|DESTINATION_DATASET|DESTINATIONDATASET)$/i.test(name)) {
    return true;
  }
  if (/^(DESTDATASET_|FEATUREWRITERDATASET_)/i.test(name)) {
    return true;
  }
  if (/^(SOURCEDATASET_|SOURCE_DATASET|INPUT_DATA|INPUT_PATH|INPUT_FILE)$/i.test(name)) {
    return false;
  }

  const text = [
    parameter.name,
    parameter.label,
    parameter.type,
    parameter.defaultValue || "",
    parameter.description || ""
  ].join(" ").toLowerCase();
  const hasOutputMeaning = /(^|[\s_.-])(output|out|dest|destination|writer|result|target|export|sink)([\s_.-]|$)/i.test(text)
    || /输出|成果|结果|目标|写入|导出/.test(text);
  const hasPathMeaning = /path|dir|directory|folder|dataset|location|root|workspace|目录|路径|文件夹|数据集|位置/.test(text);
  const hasInputMeaning = /(^|[\s_.-])(input|source|reader|src)([\s_.-]|$)|输入|源数据|来源|读取/.test(text);
  const hasNameOrFormatMeaning = /filename|file_name|feature type|extension|format|name|名称|文件名|扩展|格式|类型/.test(text);

  if (hasInputMeaning) {
    return false;
  }
  if (hasOutputMeaning && hasPathMeaning && !hasNameOrFormatMeaning) {
    return true;
  }
  return (parameter.type === "folder" || parameter.type === "path") && hasOutputMeaning && !hasNameOrFormatMeaning;
}

export default function TemplateConfig() {
  const { id } = useParams<{ id: string }>();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [form] = Form.useForm();
  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!id) {
      return;
    }
    const load = async () => {
      setLoading(true);
      try {
        const detail = await api.getTemplate(id);
        setTemplate(detail);
        form.setFieldsValue({
          parameters: Object.fromEntries(
            detail.parameters.map((parameter) => [
              parameter.name,
              coerceDefaultValue(parameter)
            ])
          )
        });
      } catch (error) {
        message.error(error instanceof Error ? error.message : "模板加载失败");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [id, form, message]);

  const requiredCount = useMemo(() => template?.parameters.filter((item) => item.required).length || 0, [template]);

  const submit = async (values: {
    parameters?: Record<string, unknown>;
  }) => {
    if (!template) {
      return;
    }
    setRunning(true);
    try {
      const task = await api.runTask({
        templateId: template.id,
        taskName: `${template.name} 转换任务`,
        parameters: normalizeParameters(values.parameters || {})
      });
      message.success("转换任务已创建");
      navigate(`/results/${task.id}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "任务创建失败");
    } finally {
      setRunning(false);
    }
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
      </div>

      <div className="config-grid">
        <Card className="form-card" title="模板解析参数">
          <Form form={form} layout="vertical" onFinish={submit}>
            {template.parameters.length ? (
              template.parameters.map((parameter) => renderParameterItem(parameter))
            ) : (
              <Empty description="模板未识别到公开参数" />
            )}

            <Form.Item>
              <Button type="primary" htmlType="submit" icon={<PlayCircleOutlined />} loading={running}>
                发起转换
              </Button>
            </Form.Item>
          </Form>
        </Card>

        <Space direction="vertical" size={16} className="full-height">
          <Card className="detail-card" title="模板基础信息">
            <Descriptions size="small" column={1}>
              <Descriptions.Item label="模板名称">{template.name}</Descriptions.Item>
              <Descriptions.Item label="文件类型">{template.fileType}</Descriptions.Item>
              <Descriptions.Item label="参数数量">{template.parameterCount}</Descriptions.Item>
              <Descriptions.Item label="必填参数">{requiredCount}</Descriptions.Item>
              <Descriptions.Item label="解析状态">
                <ParseStatusTag status={template.parseStatus} />
              </Descriptions.Item>
              <Descriptions.Item label="解析信息">{template.parseMessage || "-"}</Descriptions.Item>
            </Descriptions>
          </Card>

          <Card className="detail-card" title="参数概览">
            {template.parameters.length ? (
              <Space direction="vertical" size={8} style={{ width: "100%" }}>
                {template.parameters.map((parameter) => (
                  <div key={parameter.id}>
                    <Typography.Text strong>{parameter.label}</Typography.Text>
                    <div className="parameter-help">
                      {parameter.name} · {parameter.type}{parameter.required ? " · 必填" : ""}
                    </div>
                  </div>
                ))}
              </Space>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无参数" />
            )}
          </Card>
        </Space>
      </div>
    </div>
  );
}

function renderParameterItem(parameter: TemplateParameter) {
  const autoOutputDirectory = isAutoOutputDirectoryParameter(parameter);
  const commonProps = {
    name: ["parameters", parameter.name],
    label: parameter.label || parameter.name,
    rules: parameter.required && !autoOutputDirectory ? [{ required: true, message: `请填写 ${parameter.label || parameter.name}` }] : undefined,
    tooltip: autoOutputDirectory ? "运行时自动写入成果详情的输出目录" : parameter.description || parameter.name
  };

  if (autoOutputDirectory) {
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        <Input disabled placeholder="自动使用成果详情输出目录" />
      </Form.Item>
    );
  }

  if (parameter.type === "message") {
    return (
      <Form.Item key={parameter.id} label={parameter.label || parameter.name} tooltip={parameter.description || parameter.name}>
        <Alert
          type="info"
          showIcon
          message={parameter.label || parameter.name}
          description={parameter.defaultValue || parameter.description || "运行时提示信息"}
        />
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

  if (parameter.type === "enum" || parameter.type === "output_format") {
    const options = parameter.options.length
      ? parameter.options.map((option) => ({ value: option, label: option }))
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

  if (parameter.type === "multi_choice" || parameter.type === "attribute_select" || parameter.type === "attribute_expose") {
    const options = parameter.options.map((option) => ({ value: option, label: option }));
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

  if (parameter.type === "checkbox_group") {
    const options = parameter.options.map((option) => ({ value: option, label: option }));
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        <Checkbox.Group options={options} />
      </Form.Item>
    );
  }

  if (parameter.type === "encoding") {
    const options = parameter.options.length
      ? parameter.options.map((option) => ({ value: option, label: option }))
      : encodingOptions;
    return (
      <Form.Item key={parameter.id} {...commonProps}>
        <Select showSearch allowClear options={options} />
      </Form.Item>
    );
  }

  if (parameter.type === "database_connection" || parameter.type === "web_connection" || parameter.type === "scripted_selection") {
    const options = parameter.options.map((option) => ({ value: option, label: option }));
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

function renderTableParameter(
  parameter: TemplateParameter,
  commonProps: {
    label: string;
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
  if (parameter.type === "file") return "请输入或粘贴文件路径";
  if (parameter.type === "folder") return "请输入或粘贴目录路径";
  if (parameter.type === "reprojection_file") return "请选择或粘贴坐标转换网格文件路径";
  if (parameter.type === "path") return "请输入路径";
  if (parameter.type === "url") return "请输入 URL";
  if (parameter.type === "coordinate_system") return "例如 EPSG:4547";
  if (parameter.type === "geometry") return "请输入 GeoJSON 几何或范围";
  if (parameter.type === "database_connection") return "请选择数据库连接";
  if (parameter.type === "web_connection") return "请选择 Web/API 连接";
  if (parameter.type === "scripted_selection") return "请选择脚本生成的选项";
  if (parameter.type === "attribute_select" || parameter.type === "attribute_expose") return "输入或选择属性字段";
  return "请输入参数值";
}

function coerceDefaultValue(parameter: TemplateParameter): unknown {
  if (isAutoOutputDirectoryParameter(parameter)) {
    return undefined;
  }
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
  if (parameter.type === "datetime") {
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
