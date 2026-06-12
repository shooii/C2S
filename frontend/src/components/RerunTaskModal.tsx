import { useEffect, useState } from "react";
import {
  Alert,
  App,
  Empty,
  Form,
  Input,
  Modal,
  Spin,
  Typography
} from "antd";
import {
  coerceDefaultValue,
  coerceParameterValue,
  normalizeParameters,
  renderParameterItem
} from "../pages/TemplateManage/TemplateConfig";
import { api } from "../services/api";
import type { ConversionTask, TemplateDetail } from "../types";

interface RerunTaskModalProps {
  open: boolean;
  task: ConversionTask | null;
  onClose: () => void;
  onCreated: (task: ConversionTask) => void;
}

export function RerunTaskModal({
  open,
  task,
  onClose,
  onCreated
}: RerunTaskModalProps) {
  const { message } = App.useApp();
  const [form] = Form.useForm();
  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    if (!open || !task) {
      return;
    }

    let disposed = false;
    setLoading(true);
    setTemplate(null);
    setLoadError("");
    form.resetFields();
    form.setFieldsValue({
      taskName: suggestedRerunName(task.taskName)
    });

    api.getTemplate(task.templateId)
      .then((detail) => {
        if (disposed) {
          return;
        }
        setTemplate(detail);
        form.setFieldsValue({
          taskName: suggestedRerunName(task.taskName),
          parameters: Object.fromEntries(
            detail.parameters.map((parameter) => {
              const previousValue = getCaseInsensitiveValue(task.parameters, parameter.name);
              return [
                parameter.name,
                previousValue === undefined
                  ? coerceDefaultValue(parameter)
                  : coerceParameterValue(parameter, previousValue)
              ];
            })
          )
        });
      })
      .catch((error) => {
        if (!disposed) {
          setLoadError(error instanceof Error ? error.message : "模板参数加载失败");
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [form, open, task?.id, task?.templateId]);

  const submit = async (values: {
    taskName: string;
    parameters?: Record<string, unknown>;
  }) => {
    if (!task || !template || submitting) {
      return;
    }

    setSubmitting(true);
    try {
      const nextTask = await api.rerunTask(task.id, {
        taskName: values.taskName.trim(),
        parameters: normalizeParameters(values.parameters || {}),
        outputFormat: task.outputFormat
      });
      message.success("已创建重新运行任务");
      onCreated(nextTask);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "重新运行失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="重新运行任务"
      open={open}
      width={760}
      okText="创建并运行"
      cancelText="取消"
      confirmLoading={submitting}
      okButtonProps={{ disabled: loading || Boolean(loadError) || !template }}
      cancelButtonProps={{ disabled: submitting }}
      onOk={() => form.submit()}
      onCancel={() => {
        if (!submitting) {
          onClose();
        }
      }}
      forceRender
      afterClose={() => {
        form.resetFields();
        setTemplate(null);
        setLoadError("");
      }}
      styles={{ body: { maxHeight: "65vh", overflowY: "auto", paddingTop: 8 } }}
    >
      <Alert
        type="info"
        showIcon
        message="基于原任务配置创建新任务"
        description="可以在运行前调整名称和参数，原任务及其成果不会改变。"
        style={{ marginBottom: 18 }}
      />

      {loading ? (
        <div className="rerun-modal-loading">
          <Spin />
        </div>
      ) : loadError ? (
        <Alert type="error" showIcon message="参数加载失败" description={loadError} />
      ) : null}

      <Form
        form={form}
        layout="vertical"
        onFinish={submit}
        style={{ display: !loading && !loadError && template ? undefined : "none" }}
      >
        {template && (
          <>
          <Form.Item
            name="taskName"
            label="任务名称"
            rules={[
              { required: true, whitespace: true, message: "请输入任务名称" },
              { max: 200, message: "任务名称不能超过 200 个字符" }
            ]}
          >
            <Input placeholder="请输入任务名称" />
          </Form.Item>

          <Typography.Title level={5}>运行参数</Typography.Title>
          {template.parameters.length ? (
            template.parameters.map((parameter) => renderParameterItem(
              parameter,
              parameter.label || parameter.name
            ))
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="该模板没有可配置参数" />
          )}
          </>
        )}
      </Form>
    </Modal>
  );
}

function suggestedRerunName(taskName: string): string {
  const baseTaskName = taskName.replace(/(?:\s*-\s*重新运行)+$/, "").trim();
  return `${baseTaskName} - 重新运行`;
}

function getCaseInsensitiveValue(
  parameters: Record<string, unknown>,
  parameterName: string
): unknown {
  const key = Object.keys(parameters).find(
    (candidate) => candidate.toUpperCase() === parameterName.toUpperCase()
  );
  return key ? parameters[key] : undefined;
}
