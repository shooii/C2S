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

public static class C2SPathPicker
{
    private const uint FOS_PICKFOLDERS = 0x00000020;
    private const uint FOS_FORCEFILESYSTEM = 0x00000040;
    private const uint FOS_ALLOWMULTISELECT = 0x00000200;
    private const uint FOS_PATHMUSTEXIST = 0x00000800;
    private const uint FOS_FILEMUSTEXIST = 0x00001000;
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private static readonly int HRESULT_CANCELLED = unchecked((int)0x800704C7);

    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog {}

    [ComImport]
    [Guid("d57c7288-d4ad-4768-be02-9d969532d960")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        [PreserveSig] int SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        [PreserveSig] int SetFileTypeIndex(uint iFileType);
        [PreserveSig] int GetFileTypeIndex(out uint piFileType);
        [PreserveSig] int Advise(IntPtr pfde, out uint pdwCookie);
        [PreserveSig] int Unadvise(uint dwCookie);
        [PreserveSig] int SetOptions(uint fos);
        [PreserveSig] int GetOptions(out uint pfos);
        [PreserveSig] int SetDefaultFolder(IShellItem psi);
        [PreserveSig] int SetFolder(IShellItem psi);
        [PreserveSig] int GetFolder(out IShellItem ppsi);
        [PreserveSig] int GetCurrentSelection(out IShellItem ppsi);
        [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        [PreserveSig] int GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        [PreserveSig] int GetResult(out IShellItem ppsi);
        [PreserveSig] int AddPlace(IShellItem psi, uint fdap);
        [PreserveSig] int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        [PreserveSig] int Close(int hr);
        [PreserveSig] int SetClientGuid(ref Guid guid);
        [PreserveSig] int ClearClientData();
        [PreserveSig] int SetFilter(IntPtr pFilter);
        [PreserveSig] int GetResults(out IShellItemArray ppenum);
        [PreserveSig] int GetSelectedItems(out IShellItemArray ppsai);
    }

    [ComImport]
    [Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetParent(out IShellItem ppsi);
        [PreserveSig] int GetDisplayName(uint sigdnName, out IntPtr ppszName);
        [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        [PreserveSig] int Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct PROPERTYKEY
    {
        public Guid fmtid;
        public uint pid;
    }

    [ComImport]
    [Guid("b63ea76d-1f85-456f-a19c-48159efa858b")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItemArray
    {
        [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppvOut);
        [PreserveSig] int GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetPropertyDescriptionList(ref PROPERTYKEY keyType, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetAttributes(int attribFlags, uint sfgaoMask, out uint psfgaoAttribs);
        [PreserveSig] int GetCount(out uint pdwNumItems);
        [PreserveSig] int GetItemAt(uint dwIndex, out IShellItem ppsi);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(
        string pszPath,
        IntPtr pbc,
        ref Guid riid,
        out IShellItem ppv
    );

    public static string[] SelectPaths(string kind, string title, string initialPath, bool multiple)
    {
        bool pickFolder = String.Equals(kind, "folder", StringComparison.OrdinalIgnoreCase);
        IFileOpenDialog dialog = null;

        try
        {
            dialog = (IFileOpenDialog)new FileOpenDialog();
            uint options;
            ThrowIfFailed(dialog.GetOptions(out options));

            uint nextOptions = options | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST;
            nextOptions |= pickFolder ? FOS_PICKFOLDERS : FOS_FILEMUSTEXIST;
            if (!pickFolder && multiple)
            {
                nextOptions |= FOS_ALLOWMULTISELECT;
            }

            ThrowIfFailed(dialog.SetOptions(nextOptions));
            ThrowIfFailed(dialog.SetTitle(title));
            ThrowIfFailed(dialog.SetOkButtonLabel(pickFolder ? "选择文件夹" : "选择文件"));
            ThrowIfFailed(dialog.SetFileNameLabel(pickFolder ? "文件夹:" : "文件:"));
            ApplyInitialPath(dialog, initialPath, pickFolder);

            int showResult = dialog.Show(IntPtr.Zero);
            if (showResult == HRESULT_CANCELLED)
            {
                return new string[0];
            }
            ThrowIfFailed(showResult);

            if (!pickFolder && multiple)
            {
                return GetMultipleResultPaths(dialog);
            }

            return GetSingleResultPath(dialog);
        }
        finally
        {
            if (dialog != null)
            {
                Marshal.ReleaseComObject(dialog);
            }
        }
    }

    private static void ApplyInitialPath(IFileOpenDialog dialog, string initialPath, bool pickFolder)
    {
        if (String.IsNullOrWhiteSpace(initialPath) || initialPath.Contains("*"))
        {
            return;
        }

        string text = initialPath.Trim().Trim(new char[] { '"', (char)39 });
        string initialDirectory = null;
        string initialFileName = null;

        try
        {
            if (System.IO.Directory.Exists(text))
            {
                initialDirectory = text;
            }
            else if (System.IO.File.Exists(text))
            {
                initialDirectory = System.IO.Path.GetDirectoryName(text);
                initialFileName = System.IO.Path.GetFileName(text);
            }
            else
            {
                string parent = System.IO.Path.GetDirectoryName(text);
                if (!String.IsNullOrWhiteSpace(parent) && System.IO.Directory.Exists(parent))
                {
                    initialDirectory = parent;
                    initialFileName = System.IO.Path.GetFileName(text);
                }
            }
        }
        catch
        {
            return;
        }

        if (!String.IsNullOrWhiteSpace(initialDirectory))
        {
            IShellItem initialItem = null;
            try
            {
                Guid shellItemGuid = typeof(IShellItem).GUID;
                int initialResult = SHCreateItemFromParsingName(initialDirectory, IntPtr.Zero, ref shellItemGuid, out initialItem);
                if (initialResult == 0 && initialItem != null)
                {
                    dialog.SetFolder(initialItem);
                }
            }
            finally
            {
                if (initialItem != null)
                {
                    Marshal.ReleaseComObject(initialItem);
                }
            }
        }

        if (!pickFolder && !String.IsNullOrWhiteSpace(initialFileName))
        {
            dialog.SetFileName(initialFileName);
        }
    }

    private static string[] GetSingleResultPath(IFileOpenDialog dialog)
    {
        IShellItem item = null;
        try
        {
            ThrowIfFailed(dialog.GetResult(out item));
            string path = GetShellItemPath(item);
            return String.IsNullOrWhiteSpace(path) ? new string[0] : new string[] { path };
        }
        finally
        {
            if (item != null)
            {
                Marshal.ReleaseComObject(item);
            }
        }
    }

    private static string[] GetMultipleResultPaths(IFileOpenDialog dialog)
    {
        IShellItemArray items = null;
        try
        {
            int resultsStatus = dialog.GetResults(out items);
            if (resultsStatus != 0 || items == null)
            {
                return GetSingleResultPath(dialog);
            }

            uint count;
            ThrowIfFailed(items.GetCount(out count));
            System.Collections.Generic.List<string> paths = new System.Collections.Generic.List<string>();

            for (uint index = 0; index < count; index++)
            {
                IShellItem item = null;
                try
                {
                    ThrowIfFailed(items.GetItemAt(index, out item));
                    string path = GetShellItemPath(item);
                    if (!String.IsNullOrWhiteSpace(path))
                    {
                        paths.Add(path);
                    }
                }
                finally
                {
                    if (item != null)
                    {
                        Marshal.ReleaseComObject(item);
                    }
                }
            }

            return paths.ToArray();
        }
        finally
        {
            if (items != null)
            {
                Marshal.ReleaseComObject(items);
            }
        }
    }

    private static string GetShellItemPath(IShellItem item)
    {
        IntPtr pathPointer = IntPtr.Zero;
        try
        {
            ThrowIfFailed(item.GetDisplayName(SIGDN_FILESYSPATH, out pathPointer));
            return Marshal.PtrToStringUni(pathPointer);
        }
        finally
        {
            if (pathPointer != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(pathPointer);
            }
        }
    }

    private static void ThrowIfFailed(int hresult)
    {
        if (hresult != 0)
        {
            Marshal.ThrowExceptionForHR(hresult);
        }
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

    $title = if ($request.kind -eq "folder") { "选择目录路径" } else { "选择文件路径" }
    [C2SDialogFocus]::Start()
    $selectedPaths = [C2SPathPicker]::SelectPaths(
      [string]$request.kind,
      $title,
      [string]$request.initialPath,
      [bool]$request.multiple
    )
    if ($selectedPaths -and $selectedPaths.Length -gt 0) {
      $paths = @($selectedPaths)
    } else {
      $cancelled = $true
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
