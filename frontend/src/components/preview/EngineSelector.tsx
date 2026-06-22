import { Radio } from "antd";
import type { PreviewEngine } from "../../types/preview";

export function EngineSelector({
  value,
  disabled,
  onChange
}: {
  value: PreviewEngine;
  disabled?: boolean;
  onChange: (value: PreviewEngine) => void;
}) {
  return (
    <Radio.Group
      aria-label="预览引擎"
      optionType="button"
      buttonStyle="solid"
      disabled={disabled}
      value={value}
      options={[
        { label: "Three.js", value: "three" },
        { label: "UE5", value: "unreal" }
      ]}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
