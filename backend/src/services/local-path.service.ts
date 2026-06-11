import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { HttpError } from "../utils/httpError";

export interface LocalPathSelection {
  cancelled: boolean;
  paths: string[];
}

interface SelectionRequest {
  kind: "file" | "folder";
  initialPath: string;
  multiple: boolean;
}

interface PendingSelection {
  resolve: (result: LocalPathSelection) => void;
  reject: (error: Error) => void;
}

class WindowsPathSelector {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private pending = new Map<string, PendingSelection>();

  warmUp(): void {
    if (process.platform === "win32") {
      void this.ensureReady()
        .then(() => console.log("[C2S] Local path selector ready"))
        .catch((error) => {
          console.error(`[C2S] Local path selector warm-up failed: ${error.message}`);
        });
    }
  }

  async select(request: SelectionRequest): Promise<LocalPathSelection> {
    await this.ensureReady();
    const child = this.child;
    if (!child) {
      throw new Error("本地路径选择器未启动");
    }

    const id = randomUUID();
    const payload = encodeBase64(JSON.stringify(request));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${id}|${payload}\n`, "utf8", (error) => {
        if (!error) {
          return;
        }
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private ensureReady(): Promise<void> {
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.start();
    return this.readyPromise;
  }

  private start(): void {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-NonInteractive", "-Command", selectorHostScript],
      { windowsHide: true }
    );
    this.child = child;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    child.stdout.on("data", (buffer: Buffer) => {
      this.stdoutBuffer += buffer.toString("utf8");
      this.consumeStdout();
    });
    child.stderr.on("data", (buffer: Buffer) => {
      this.stderrBuffer += buffer.toString("utf8");
    });
    child.on("error", (error) => this.handleExit(error));
    child.on("close", (code) => {
      this.handleExit(new Error(
        this.stderrBuffer.trim() || `本地路径选择器已退出（${code ?? "unknown"}）`
      ));
    });
  }

  private consumeStdout(): void {
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        this.handleLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    if (line === "READY") {
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }

    const [id, status, encodedPayload] = line.split("|", 3);
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);

    try {
      if (status === "ERROR") {
        pending.reject(new Error(decodeBase64(encodedPayload) || "本地路径选择失败"));
        return;
      }
      const paths = JSON.parse(decodeBase64(encodedPayload));
      if (!Array.isArray(paths) || paths.some((value) => typeof value !== "string")) {
        throw new Error("本地路径选择结果无效");
      }
      pending.resolve({
        cancelled: status === "CANCELLED",
        paths
      });
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error("本地路径选择结果解析失败"));
    }
  }

  private handleExit(error: Error): void {
    if (!this.child && !this.readyPromise) {
      return;
    }
    this.child = null;
    this.readyReject?.(error);
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
    this.stderrBuffer = "";
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

const windowsPathSelector = new WindowsPathSelector();

export function warmLocalPathSelector(): void {
  windowsPathSelector.warmUp();
}

export function selectLocalPath(options: {
  kind: "file" | "folder";
  initialPath?: string | null;
  multiple?: boolean;
}): Promise<LocalPathSelection> {
  if (process.platform !== "win32") {
    throw new HttpError(501, "本地路径选择器目前仅支持 Windows");
  }
  return windowsPathSelector.select({
    kind: options.kind,
    initialPath: options.initialPath || "",
    multiple: Boolean(options.multiple)
  });
}

function encodeBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function decodeBase64(value: string): string {
  return Buffer.from(value || "", "base64").toString("utf8");
}

const selectorHostScript = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public static class C2SDialogFocus
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int x,
        int y,
        int width,
        int height,
        uint flags
    );

    public static void Start()
    {
        uint currentProcessId = (uint)Process.GetCurrentProcess().Id;
        Thread thread = new Thread(delegate()
        {
            for (int attempt = 0; attempt < 50; attempt++)
            {
                Thread.Sleep(100);
                bool found = false;
                EnumWindows(delegate(IntPtr hWnd, IntPtr extraData)
                {
                    uint processId;
                    GetWindowThreadProcessId(hWnd, out processId);
                    if (processId != currentProcessId || !IsWindowVisible(hWnd))
                    {
                        return true;
                    }

                    SetWindowPos(
                        hWnd,
                        new IntPtr(-1),
                        0,
                        0,
                        0,
                        0,
                        0x0001 | 0x0002 | 0x0040
                    );
                    SetForegroundWindow(hWnd);
                    found = true;
                    return false;
                }, IntPtr.Zero);

                if (found)
                {
                    return;
                }
            }
        });
        thread.IsBackground = true;
        thread.Start();
    }
}
"@

[Console]::Out.WriteLine("READY")
[Console]::Out.Flush()

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if (-not $line) { continue }
  $separator = $line.IndexOf("|")
  if ($separator -lt 1) { continue }
  $id = $line.Substring(0, $separator)
  try {
    $payload = $line.Substring($separator + 1)
    $json = [System.Text.Encoding]::UTF8.GetString(
      [System.Convert]::FromBase64String($payload)
    )
    $request = ConvertFrom-Json $json
    $paths = @()
    $cancelled = $false

    if ($request.kind -eq "folder") {
      $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
      $dialog.Description = "选择目录路径"
      $dialog.ShowNewFolderButton = $true
      if ($request.initialPath -and -not $request.initialPath.Contains("*")) {
        $dialog.SelectedPath = $request.initialPath
      }
      [C2SDialogFocus]::Start()
      if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $paths = @($dialog.SelectedPath)
      } else {
        $cancelled = $true
      }
      $dialog.Dispose()
    } else {
      $dialog = New-Object System.Windows.Forms.OpenFileDialog
      $dialog.Title = "选择文件路径"
      $dialog.CheckFileExists = $true
      $dialog.Multiselect = [bool]$request.multiple
      if ($request.initialPath) {
        if ([System.IO.Path]::HasExtension($request.initialPath)) {
          $dialog.InitialDirectory = [System.IO.Path]::GetDirectoryName($request.initialPath)
          $dialog.FileName = [System.IO.Path]::GetFileName($request.initialPath)
        } else {
          $dialog.InitialDirectory = $request.initialPath
        }
      }
      [C2SDialogFocus]::Start()
      if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $paths = @($dialog.FileNames)
      } else {
        $cancelled = $true
      }
      $dialog.Dispose()
    }

    $resultJson = ConvertTo-Json -Compress -InputObject @($paths)
    $result = [System.Convert]::ToBase64String(
      [System.Text.Encoding]::UTF8.GetBytes($resultJson)
    )
    $status = if ($cancelled) { "CANCELLED" } else { "OK" }
    [Console]::Out.WriteLine("$id|$status|$result")
  } catch {
    $errorPayload = [System.Convert]::ToBase64String(
      [System.Text.Encoding]::UTF8.GetBytes($_.Exception.Message)
    )
    [Console]::Out.WriteLine("$id|ERROR|$errorPayload")
  }
  [Console]::Out.Flush()
}
`;
