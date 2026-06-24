export type PreviewWebGPUPowerPreference = "high-performance" | "low-power";

interface PreviewGPURequestAdapterOptions {
  powerPreference?: PreviewWebGPUPowerPreference;
  forceFallbackAdapter?: boolean;
  featureLevel?: "compatibility";
}

interface PreviewGPU {
  requestAdapter?: (options?: PreviewGPURequestAdapterOptions) => Promise<unknown>;
}

interface PreviewNavigatorWithGPU extends Navigator {
  gpu?: PreviewGPU;
}

interface PreviewWebGPUAdapterCheck {
  label: string;
  options?: PreviewGPURequestAdapterOptions;
}

export interface PreviewWebGPUAdapterAttempt {
  label: string;
  powerPreference?: PreviewWebGPUPowerPreference;
  supported: boolean;
  error?: string;
}

export interface PreviewWebGPUAdapterSupport {
  supported: boolean;
  reason?: string;
  powerPreference?: PreviewWebGPUPowerPreference;
  adapterLabel?: string;
  attempts: PreviewWebGPUAdapterAttempt[];
}

const WEBGPU_ADAPTER_CHECKS: PreviewWebGPUAdapterCheck[] = [
  {
    label: "高性能 WebGPU 适配器",
    options: {
      powerPreference: "high-performance",
      featureLevel: "compatibility"
    }
  },
  {
    label: "默认 WebGPU 适配器",
    options: {
      featureLevel: "compatibility"
    }
  },
  {
    label: "低功耗 WebGPU 适配器",
    options: {
      powerPreference: "low-power",
      featureLevel: "compatibility"
    }
  }
];

export async function detectWebGPUAdapterSupport(): Promise<PreviewWebGPUAdapterSupport> {
  const gpu = (navigator as PreviewNavigatorWithGPU).gpu;

  if (!gpu?.requestAdapter) {
    return {
      supported: false,
      reason: "当前浏览器未提供 WebGPU API。",
      attempts: []
    };
  }

  const attempts: PreviewWebGPUAdapterAttempt[] = [];
  for (const check of WEBGPU_ADAPTER_CHECKS) {
    try {
      const adapter = await gpu.requestAdapter(check.options);
      const supported = Boolean(adapter);
      const attempt = {
        label: check.label,
        powerPreference: check.options?.powerPreference,
        supported
      };
      attempts.push(attempt);
      if (supported) {
        return {
          supported: true,
          adapterLabel: check.label,
          powerPreference: check.options?.powerPreference,
          attempts
        };
      }
    } catch (error) {
      attempts.push({
        label: check.label,
        powerPreference: check.options?.powerPreference,
        supported: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return {
    supported: false,
    reason: describeWebGPUAdapterFailure(attempts),
    attempts
  };
}

export function describeWebGPUAdapterFailure(attempts: PreviewWebGPUAdapterAttempt[]): string {
  const errors = attempts
    .filter((attempt) => attempt.error)
    .map((attempt) => `${attempt.label}: ${attempt.error}`);

  if (errors.length) {
    return `当前环境没有返回可用的 WebGPU 适配器。（${errors.join("；")}）`;
  }

  return "当前环境没有返回可用的 WebGPU 适配器。";
}
