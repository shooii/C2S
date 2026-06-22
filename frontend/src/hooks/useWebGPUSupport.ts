import { useEffect, useState } from "react";

interface WebGPUSupportState {
  supported: boolean;
  checking: boolean;
  reason?: string;
}

export function useWebGPUSupport(): WebGPUSupportState {
  const [state, setState] = useState<WebGPUSupportState>({
    supported: false,
    checking: true
  });

  useEffect(() => {
    let disposed = false;

    const check = async () => {
      const gpu = (navigator as Navigator & {
        gpu?: {
          requestAdapter?: () => Promise<unknown>;
        };
      }).gpu;

      if (!gpu?.requestAdapter) {
        if (!disposed) {
          setState({
            supported: false,
            checking: false,
            reason: "当前浏览器未提供 WebGPU API。"
          });
        }
        return;
      }

      try {
        const adapter = await gpu.requestAdapter();
        if (!disposed) {
          setState({
            supported: Boolean(adapter),
            checking: false,
            reason: adapter ? undefined : "当前设备未提供可用的 WebGPU 适配器。"
          });
        }
      } catch (error) {
        if (!disposed) {
          setState({
            supported: false,
            checking: false,
            reason: error instanceof Error ? error.message : "WebGPU 检测失败。"
          });
        }
      }
    };

    void check();

    return () => {
      disposed = true;
    };
  }, []);

  return state;
}
