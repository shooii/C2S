import { Radio, Tooltip } from "antd";
import type { ThreeRendererPreference } from "../../types/preview";

export function RendererSelector({
  value,
  webgpuSupported,
  webgpuChecking,
  webgpuReason,
  onChange
}: {
  value: ThreeRendererPreference;
  webgpuSupported: boolean;
  webgpuChecking: boolean;
  webgpuReason?: string;
  onChange: (value: ThreeRendererPreference) => void;
}) {
  const webgpuDisabled = webgpuChecking || !webgpuSupported;
  const disabledReason = webgpuChecking ? "正在检测 WebGPU 支持" : webgpuReason || "当前环境不支持 WebGPU";
  const control = (
    <Radio.Group
      aria-label="渲染器"
      aria-describedby={webgpuDisabled ? "three-renderer-webgpu-note" : undefined}
      optionType="button"
      buttonStyle="solid"
      value={value}
      options={[
        { label: "WebGPU", value: "webgpu", disabled: webgpuDisabled },
        { label: "WebGL", value: "webgl" }
      ]}
      onChange={(event) => onChange(event.target.value)}
    />
  );

  if (!webgpuDisabled) {
    return control;
  }

  return (
    <Tooltip title={disabledReason}>
      <span className="preview-renderer-selector">
        {control}
        <span id="three-renderer-webgpu-note" className="sr-only">{disabledReason}</span>
      </span>
    </Tooltip>
  );
}
