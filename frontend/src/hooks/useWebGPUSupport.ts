import { useEffect, useState } from "react";
import { detectWebGPUAdapterSupport } from "../utils/webgpuSupport";

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
      try {
        const support = await detectWebGPUAdapterSupport();
        if (!disposed) {
          setState({
            supported: support.supported,
            checking: false,
            reason: support.reason
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
