import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "../utils/httpError";

export interface LocalPathSelection {
  cancelled: boolean;
  paths: string[];
}

interface SelectionRequest {
  kind: "file" | "folder";
  initialPath: string;
  multiple: boolean;
  title: string;
}

interface OneShotSelectorResult {
  cancelled?: unknown;
  paths?: unknown;
  error?: unknown;
}

const LOCAL_PATH_SELECTION_TIMEOUT_MS = 120_000;

class WindowsPathSelector {
  warmUp(): void {
    return;
  }

  async select(request: SelectionRequest, signal?: AbortSignal): Promise<LocalPathSelection> {
    const id = randomUUID();
    const resultPath = join(tmpdir(), `c2s-local-path-selection-${id}.json`);
    const scriptPath = join(tmpdir(), `c2s-local-path-selector-${id}.ps1`);

    await writeFile(scriptPath, buildOneShotSelectorScript(request, resultPath), "utf8");

    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      scriptPath
    ], {
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();

    return waitForOneShotSelection(child, resultPath, scriptPath, signal);
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
  title?: string | null;
  signal?: AbortSignal;
}): Promise<LocalPathSelection> {
  if (process.platform !== "win32") {
    throw new HttpError(501, "本地路径选择器目前仅支持 Windows");
  }

  return windowsPathSelector.select(
    {
      kind: options.kind,
      initialPath: options.initialPath || "",
      multiple: Boolean(options.multiple),
      title: normalizeDialogTitle(options.title)
    },
    options.signal
  );
}

function normalizeDialogTitle(value: string | null | undefined): string {
  return (value || "").trim().slice(0, 120);
}

function waitForOneShotSelection(
  child: ChildProcess,
  resultPath: string,
  scriptPath: string,
  signal?: AbortSignal
): Promise<LocalPathSelection> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let polling = false;

    const cleanup = () => {
      void rm(resultPath, { force: true });
      void rm(scriptPath, { force: true });
    };

    const finish = (error: Error | null, result?: LocalPathSelection) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      child.removeAllListeners();
      signal?.removeEventListener("abort", abortSelection);
      if (!child.killed) {
        child.kill();
      }
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      resolve(result || { cancelled: true, paths: [] });
    };

    const abortSelection = () => {
      finish(new Error("本地路径选择已取消"));
    };

    if (signal?.aborted) {
      abortSelection();
      return;
    }
    signal?.addEventListener("abort", abortSelection, { once: true });

    const readResult = async (finalAttempt = false) => {
      if (settled || polling) {
        return;
      }
      polling = true;
      try {
        const text = await readFile(resultPath, "utf8");
        finish(null, parseOneShotSelectionResult(text));
      } catch (error) {
        if (isFileNotFound(error)) {
          if (finalAttempt) {
            finish(new Error("本地路径选择器未返回结果"));
          }
          return;
        }
        finish(error instanceof Error ? error : new Error("本地路径选择结果读取失败"));
      } finally {
        polling = false;
      }
    };

    const interval = setInterval(() => {
      void readResult();
    }, 200);
    interval.unref?.();

    const timeout = setTimeout(() => {
      finish(new Error("本地路径选择窗口未响应，请重试"));
    }, LOCAL_PATH_SELECTION_TIMEOUT_MS);
    timeout.unref?.();

    child.once("error", (error) => finish(error));
    child.once("exit", () => {
      setTimeout(() => {
        void readResult(true);
      }, 300).unref?.();
    });
  });
}

function parseOneShotSelectionResult(text: string): LocalPathSelection {
  const parsed = JSON.parse(text) as OneShotSelectorResult;
  if (typeof parsed.error === "string" && parsed.error.trim()) {
    throw new Error(parsed.error);
  }
  const paths = Array.isArray(parsed.paths)
    ? parsed.paths.filter((value): value is string => typeof value === "string")
    : [];
  return {
    cancelled: parsed.cancelled === true || paths.length === 0,
    paths
  };
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function buildOneShotSelectorScript(request: SelectionRequest, resultPath: string): string {
  const requestPayload = encodeBase64(JSON.stringify(request));
  const resultPathPayload = encodeBase64(resultPath);
  return `
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public static class C2SNativeFilePicker
{
    private const uint FOS_PICKFOLDERS = 0x00000020;
    private const uint FOS_FORCEFILESYSTEM = 0x00000040;
    private const uint FOS_ALLOWMULTISELECT = 0x00000200;
    private const uint FOS_PATHMUSTEXIST = 0x00000800;
    private const uint FOS_FILEMUSTEXIST = 0x00001000;
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private const int HRESULT_CANCELLED = unchecked((int)0x800704C7);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

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
            if (!String.IsNullOrWhiteSpace(title))
            {
                ThrowIfFailed(dialog.SetTitle(title));
            }
            ApplyInitialPath(dialog, initialPath, pickFolder);

            int showResult = dialog.Show(GetForegroundWindow());
            if (showResult == HRESULT_CANCELLED)
            {
                return new string[0];
            }
            ThrowIfFailed(showResult);

            return (!pickFolder && multiple)
                ? GetMultipleResultPaths(dialog)
                : GetSingleResultPath(dialog);
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
            if (Directory.Exists(text))
            {
                initialDirectory = text;
            }
            else if (File.Exists(text))
            {
                initialDirectory = Path.GetDirectoryName(text);
                initialFileName = Path.GetFileName(text);
            }
            else
            {
                string parent = Path.GetDirectoryName(text);
                if (!String.IsNullOrWhiteSpace(parent) && Directory.Exists(parent))
                {
                    initialDirectory = parent;
                    initialFileName = Path.GetFileName(text);
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
            List<string> paths = new List<string>();

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

$requestJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${requestPayload}"))
$resultPath = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${resultPathPayload}"))

function Write-C2SSelectionResult {
  param([hashtable]$Value)
  $json = $Value | ConvertTo-Json -Compress -Depth 5
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($resultPath, $json, $utf8)
}

try {
  $request = ConvertFrom-Json $requestJson
  $kind = [string]$request.kind
  $multiple = [bool]$request.multiple
  $title = [string]$request.title
  if ([System.String]::IsNullOrWhiteSpace($title)) {
    $title = if ($kind -eq "folder") { "选择目录路径" } else { "选择文件路径" }
  }

  $paths = @([C2SNativeFilePicker]::SelectPaths(
    $kind,
    $title,
    [string]$request.initialPath,
    $multiple
  ))
  if (-not $paths) {
    $paths = @()
  }

  Write-C2SSelectionResult @{ cancelled = (@($paths).Count -eq 0); paths = @($paths) }
} catch {
  Write-C2SSelectionResult @{ cancelled = $true; paths = @(); error = $_.Exception.Message }
}
`;
}

function encodeBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}
