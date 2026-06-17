import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import AdmZip from "adm-zip";
import iconv from "iconv-lite";
import { fmeCandidates, logStorageDir, templatePackageStorageDir } from "../config/paths";
import type {
  ParameterDirection,
  ParameterOption,
  ParameterPathKind,
  ParameterVisibilityRule,
  ParameterType,
  ResultFile
} from "../types";
import { assertPathInside, getResultFileType, isPreviewable, listFilesRecursive, removeIfExists } from "./file.service";

export interface ParsedWorkspaceParameter {
  name: string;
  label: string;
  type: ParameterType;
  defaultValue: string | null;
  required: boolean;
  options: ParameterOption[];
  direction: ParameterDirection;
  pathKind: ParameterPathKind;
  multiple: boolean;
  visibility: ParameterVisibilityRule | null;
  description: string | null;
  sortOrder: number;
}

export interface FmeStatus {
  available: boolean;
  command?: string;
  version?: string;
  errors: string[];
}

export interface RunWorkspaceInput {
  taskId: string;
  workspacePath: string;
  parameters: Record<string, unknown>;
  outputPath: string;
  logPath: string;
  onLog?: (chunk: string) => void;
  onProgress?: (progress: number) => void;
}

export interface RunWorkspaceResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  duration: number;
}

interface WorkspaceParseContext {
  packageRoot: string | null;
}

interface ProgressStream {
  key: string;
  current: number;
  total: number;
  samples: number;
  percent: number;
}

interface PercentProgressState {
  phaseIndex: number;
  lastPercent: number | null;
}

const runningProcesses = new Map<string, ChildProcessWithoutNullStreams>();
let cachedFmeCommand: string | null = null;

export async function checkFmeAvailable(): Promise<FmeStatus> {
  const errors: string[] = [];

  for (const candidate of fmeCandidates) {
    const result = await spawnCapture(candidate, ["--version"], 10_000);
    if (result.ok) {
      cachedFmeCommand = candidate;
      return {
        available: true,
        command: candidate,
        version: firstNonEmptyLine(`${result.stdout}\n${result.stderr}`),
        errors
      };
    }
    errors.push(`${candidate}: ${result.error || result.stderr || `exit code ${result.code}`}`);
  }

  return {
    available: false,
    errors
  };
}

export async function parseWorkspaceParameters(workspacePath: string): Promise<ParsedWorkspaceParameter[]> {
  const context = prepareWorkspaceParseContext(workspacePath);
  const text = readWorkspaceText(workspacePath);
  return parseWorkspaceParameterText(text, context);
}

export function getWorkspaceOutputParameterNames(workspacePath: string): string[] {
  const text = readWorkspaceText(workspacePath);
  const names = [
    ...parseWriterDatasetOutputParameterNames(text),
    ...parseWorkspaceParameterText(text)
      .filter(isOutputDirectoryParameter)
      .map((parameter) => parameter.name)
  ];

  return [...new Map(names.map((name) => {
    const normalized = normalizeFmeParameterName(name);
    return [normalized.toUpperCase(), normalized];
  })).values()];
}

export function isOutputDirectoryParameter(
  parameter: Pick<
    ParsedWorkspaceParameter,
    "name" | "label" | "type" | "defaultValue" | "description" | "direction" | "pathKind"
  >
): boolean {
  if (parameter.direction === "output" && isPathParameter(parameter.type, parameter.pathKind)) {
    return true;
  }

  const name = normalizeFmeParameterName(parameter.name);
  const upperName = name.toUpperCase();

  if (/^(OUTPUT_DIR|OUTPUT_DIRECTORY|OUTPUT_PATH|DESTINATION_DATASET|DESTINATIONDATASET)$/i.test(upperName)) {
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

function parseWorkspaceParameterText(
  text: string,
  context: WorkspaceParseContext = { packageRoot: null }
): ParsedWorkspaceParameter[] {
  const parameters = normalizeParameters([
    ...parseUserParameterForms(text),
    ...parseXmlGuiLineParameters(text),
    ...parseJsonLikeParameters(text),
    ...parseTextBlocks(text),
    ...parseCommandLineParameters(text),
    ...parsePackagedPathParameters(text)
  ]);

  return parameters.map((parameter, index) => ({
    ...parameter,
    defaultValue: parameter.direction === "output"
      ? parameter.defaultValue
      : resolveWorkspacePackagePath(parameter.defaultValue, context),
    sortOrder: index
  }));
}

export function buildFmeArgs(
  workspacePath: string,
  parameters: Record<string, unknown>,
  outputPath: string
): string[] {
  const args = [workspacePath];
  const seen = new Set<string>();

  for (const [rawName, rawValue] of Object.entries(parameters || {})) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }

    const name = normalizeFmeParameterName(rawName);
    if (!name) {
      continue;
    }

    seen.add(name.toUpperCase());
    args.push(`--${name}`, stringifyFmeValue(rawValue));
  }

  if (!seen.has("OUTPUT_DIR") && !seen.has("OUTPUT_DIRECTORY")) {
    args.push("--OUTPUT_DIR", outputPath);
  }

  return args;
}

export async function runWorkspace(input: RunWorkspaceInput): Promise<RunWorkspaceResult> {
  const command = await resolveFmeCommand();
  const args = buildFmeArgs(input.workspacePath, input.parameters, input.outputPath);
  const startedAt = Date.now();

  fs.mkdirSync(input.outputPath, { recursive: true });
  fs.mkdirSync(path.dirname(input.logPath), { recursive: true });

  const logStream = fs.createWriteStream(input.logPath, { flags: "a" });
  const progressTracker = createProgressTracker();
  const writeLog = (chunk: string) => {
    logStream.write(chunk);
    input.onLog?.(chunk);
    const progress = progressTracker(chunk);
    if (progress !== null) {
      input.onProgress?.(progress);
    }
  };

  writeLog(`\n[C2S] Task ${input.taskId} started at ${new Date().toISOString()}\n`);
  writeLog(`[C2S] FME command: ${formatCommandForLog(command, args)}\n`);
  writeLog(`[C2S] Output directory: ${input.outputPath}\n\n`);

  const child = spawn(command, args, {
    cwd: input.outputPath,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf8" }
  });
  runningProcesses.set(input.taskId, child);
  input.onProgress?.(8);

  return new Promise((resolve, reject) => {
    let settled = false;

    const finalize = (result: RunWorkspaceResult) => {
      if (settled) {
        return;
      }
      settled = true;
      runningProcesses.delete(input.taskId);
      writeLog(`\n[C2S] Task ${input.taskId} finished at ${new Date().toISOString()}\n`);
      writeLog(`[C2S] Exit code: ${result.exitCode ?? "null"}; signal: ${result.signal ?? "none"}\n`);
      logStream.end();
      resolve(result);
    };

    child.stdout.on("data", (buffer: Buffer) => {
      writeLog(buffer.toString("utf8"));
    });

    child.stderr.on("data", (buffer: Buffer) => {
      writeLog(buffer.toString("utf8"));
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      runningProcesses.delete(input.taskId);
      writeLog(`\n[C2S] Failed to start FME: ${error.message}\n`);
      logStream.end();
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      finalize({
        exitCode,
        signal,
        duration: Date.now() - startedAt
      });
    });
  });
}

export function cancelWorkspace(taskId: string): boolean {
  const child = runningProcesses.get(taskId);
  if (!child) {
    return false;
  }
  child.kill("SIGTERM");
  return true;
}

export type OutputFileSnapshot = Map<string, string>;

export function snapshotOutputFiles(outputDir: string): OutputFileSnapshot {
  return new Map(
    listFilesRecursive(outputDir).map((file) => [
      path.resolve(file.filePath),
      `${file.fileSize}:${file.modifiedAt}`
    ])
  );
}

export function scanOutputFiles(
  taskId: string,
  outputDir: string,
  baseline: OutputFileSnapshot = new Map()
): Array<Omit<ResultFile, "id" | "createdAt">> {
  return listFilesRecursive(outputDir)
    .filter((file) => baseline.get(path.resolve(file.filePath)) !== `${file.fileSize}:${file.modifiedAt}`)
    .map((file) => ({
      taskId,
      fileName: file.fileName,
      fileType: getResultFileType(file.fileName),
      fileSize: file.fileSize,
      filePath: file.filePath,
      downloadable: true,
      previewable: isPreviewable(file.fileName)
    }));
}

async function resolveFmeCommand(): Promise<string> {
  if (cachedFmeCommand) {
    return cachedFmeCommand;
  }

  const status = await checkFmeAvailable();
  if (!status.available || !status.command) {
    throw new Error(`FME 不可用：${status.errors.join("; ")}`);
  }
  return status.command;
}

function spawnCapture(command: string, args: string[], timeoutMs: number) {
  return new Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null; error?: string }>((resolve) => {
    let stdout = "";
    let stderr = "";
    let completed = false;

    const child = spawn(command, args, { windowsHide: true });
    const timer = setTimeout(() => {
      if (!completed) {
        child.kill("SIGTERM");
        completed = true;
        resolve({
          ok: false,
          stdout,
          stderr,
          code: null,
          error: "命令执行超时"
        });
      }
    }, timeoutMs);

    child.stdout.on("data", (buffer: Buffer) => {
      stdout += buffer.toString("utf8");
    });
    child.stderr.on("data", (buffer: Buffer) => {
      stderr += buffer.toString("utf8");
    });
    child.on("error", (error) => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout,
        stderr,
        code: null,
        error: error.message
      });
    });
    child.on("close", (code) => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        code
      });
    });
  });
}

export function getWorkspacePackageResourceDir(workspacePath: string): string {
  return path.join(templatePackageStorageDir, path.parse(workspacePath).name);
}

export function removeWorkspacePackageResources(workspacePath: string): void {
  removeIfExists(getWorkspacePackageResourceDir(workspacePath));
}

function prepareWorkspaceParseContext(workspacePath: string): WorkspaceParseContext {
  if (path.extname(workspacePath).toLowerCase() !== ".fmwt") {
    return { packageRoot: null };
  }

  return {
    packageRoot: extractWorkspacePackageResources(workspacePath)
  };
}

function extractWorkspacePackageResources(workspacePath: string): string {
  const packageRoot = getWorkspacePackageResourceDir(workspacePath);
  fs.mkdirSync(packageRoot, { recursive: true });

  const zip = new AdmZip(workspacePath);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) {
      continue;
    }

    const relativePath = normalizeZipEntryPath(entry.entryName);
    if (!relativePath) {
      continue;
    }

    const targetPath = assertPathInside(packageRoot, path.join(packageRoot, relativePath));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size === entry.header.size) {
      continue;
    }
    fs.writeFileSync(targetPath, entry.getData());
  }

  return packageRoot;
}

function normalizeZipEntryPath(entryName: string): string | null {
  const normalized = entryName
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment && segment !== ".")
    .join(path.sep);

  if (!normalized || path.isAbsolute(normalized) || normalized.split(path.sep).some((segment) => segment === "..")) {
    return null;
  }

  return normalized;
}

function readWorkspaceText(workspacePath: string): string {
  const ext = path.extname(workspacePath).toLowerCase();
  if (ext === ".fmwt") {
    try {
      const zip = new AdmZip(workspacePath);
      const fmwEntry = zip.getEntries().find((entry) => entry.entryName.toLowerCase().endsWith(".fmw"));
      if (fmwEntry) {
        return decodeBuffer(fmwEntry.getData());
      }
    } catch {
      return decodeBuffer(fs.readFileSync(workspacePath));
    }
  }
  return decodeBuffer(fs.readFileSync(workspacePath));
}

function decodeBuffer(buffer: Buffer): string {
  // 首先尝试 UTF-8 解码
  try {
    const utf8Text = buffer.toString("utf8");
    if (!isGarbledText(utf8Text)) {
      return utf8Text;
    }
  } catch {
    // UTF-8 解码失败，继续尝试其他编码
  }

  // 尝试 GBK/GB2312 解码（常见的中文编码）
  try {
    const gbkText = iconv.decode(buffer, "gbk");
    if (!isGarbledText(gbkText)) {
      return gbkText;
    }
  } catch {
    // GBK 解码失败，继续尝试其他编码
  }

  // 尝试 GB18030 解码（更全面的中文编码）
  try {
    const gb18030Text = iconv.decode(buffer, "gb18030");
    if (!isGarbledText(gb18030Text)) {
      return gb18030Text;
    }
  } catch {
    // GB18030 解码失败，继续尝试其他编码
  }

  // 尝试 Big5 解码（繁体中文编码）
  try {
    const big5Text = iconv.decode(buffer, "big5");
    if (!isGarbledText(big5Text)) {
      return big5Text;
    }
  } catch {
    // Big5 解码失败
  }

  // 如果所有编码都无法正确解码，返回 UTF-8 作为后备方案
  return buffer.toString("utf8");
}

function isGarbledText(text: string): boolean {
  // 检查是否有替换字符（常见的乱码标记）
  const replacementChar = "\uFFFD";
  if (text.includes(replacementChar)) {
    return true;
  }

  // 统计非 ASCII 字符的比例
  let nonAsciiCount = 0;
  let suspiciousControlChars = 0;
  let chineseCount = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    
    // 控制字符（除了常见的换行、制表符）
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      suspiciousControlChars++;
    }
    
    // 中文字符范围
    if ((code >= 0x4E00 && code <= 0x9FFF) || 
        (code >= 0x3400 && code <= 0x4DBF) || 
        (code >= 0x20000 && code <= 0x2A6DF)) {
      chineseCount++;
    }
    
    if (code >= 128) {
      nonAsciiCount++;
    }
  }

  // 如果有大量中文字符，说明编码可能是正确的
  if (chineseCount > 5) {
    return false;
  }

  // 如果有很多控制字符且中文字符很少，可能是乱码
  const totalChars = text.length;
  const controlRatio = totalChars > 0 ? suspiciousControlChars / totalChars : 0;
  
  if (controlRatio > 0.1 && chineseCount === 0) {
    return true;
  }

  // 检查是否有连续的 C1 控制字符（0x80-0x9F）
  let consecutiveC1 = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x80 && code <= 0x9F) {
      consecutiveC1++;
      if (consecutiveC1 >= 3) {
        return true;
      }
    } else {
      consecutiveC1 = 0;
    }
  }

  return false;
}

function parseUserParameterForms(text: string): ParsedWorkspaceParameter[] {
  const parameters: ParsedWorkspaceParameter[] = [];
  const regex = /<USER_PARAMETERS\b[\s\S]*?\bFORM="([^"]+)"/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    try {
      const decoded = Buffer.from(decodeXmlEntities(match[1]), "base64").toString("utf8");
      const parsed = JSON.parse(decoded) as { parameters?: unknown };
      if (!Array.isArray(parsed.parameters)) {
        continue;
      }

      parsed.parameters.forEach((raw) => {
        if (!raw || typeof raw !== "object") {
          return;
        }
        const parameter = normalizeRawParameter(raw as Record<string, unknown>);
        if (parameter) {
          parameters.push(parameter);
        }
      });
    } catch {
      // Some workspaces omit the encoded Workbench form or use an older format.
    }
  }

  return parameters;
}

function parseWriterDatasetOutputParameterNames(text: string): string[] {
  const names: string[] = [];
  const writerBlocks = text.match(/<WRITER_DATASETS\b[\s\S]*?<\/WRITER_DATASETS>/gi) || [];

  for (const block of writerBlocks) {
    const regex = /<DATASET\b[\s\S]*?\/>/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(block)) !== null) {
      const attrs = parseXmlAttributes(match[0]);
      const override = attrs.OVERRIDE || attrs.override;
      const name = override ? normalizeFmeParameterName(override) : undefined;
      if (name) {
        names.push(name);
      }
    }
  }

  return names;
}

function parseXmlGuiLineParameters(text: string): ParsedWorkspaceParameter[] {
  const parameters: ParsedWorkspaceParameter[] = [];
  const blockRegex = /<(?:GLOBAL_PARAMETER|INFO)\b[\s\S]*?\/>/gi;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(text)) !== null) {
    const attrs = parseXmlAttributes(match[0]);
    const guiLine = attrs.GUI_LINE || attrs.GENERATED_GUI_LINE || "";
    const parsedGui = parseGuiLine(guiLine);
    const name = attrs.NAME || parsedGui?.name;
    if (!name || shouldSkipParameterName(name)) {
      continue;
    }

    const label = parsedGui?.label || attrs.PROMPT || attrs.LABEL || prettifyName(name);
    const defaultValue = attrs.DEFAULT_VALUE || attrs.VALUE
      ? decodeFmeTokens(attrs.DEFAULT_VALUE || attrs.VALUE)
      : null;
    const declaredType = [parsedGui?.type, attrs.TYPE, attrs.PARAMETER_TYPE].filter(Boolean).join(" ");

    parameters.push({
      name,
      label,
      ...inferParameterMetadata({
        name,
        label,
        declaredType,
        defaultValue,
        options: parseOptions(parsedGui?.choices || null)
      }),
      defaultValue,
      required: inferGuiLineRequired(guiLine),
      options: parseOptions(parsedGui?.choices || null),
      visibility: null,
      description: attrs.DESCRIPTION || attrs.HELP || null,
      sortOrder: parameters.length
    });
  }

  return parameters;
}

function parseJsonLikeParameters(text: string): ParsedWorkspaceParameter[] {
  const matches = text.match(/\{[^{}]{0,4000}\}/g) || [];
  const parameters: ParsedWorkspaceParameter[] = [];

  for (const match of matches) {
    if (!/(parameter|published|userparameter|macro)/i.test(match)) {
      continue;
    }

    try {
      const json = JSON.parse(match.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]")) as Record<string, unknown>;
      const parameter = normalizeRawParameter(json);
      if (parameter) {
        parameters.push(parameter);
      }
    } catch {
      // FMW files often contain object-like snippets that are not strict JSON.
    }
  }

  return parameters;
}

function parseTextBlocks(text: string): ParsedWorkspaceParameter[] {
  const parameters: ParsedWorkspaceParameter[] = [];
  const blockRegex = /(PUBLISHED_PARAMETER|USER_PARAMETER|PARAMETER_DEF|PARAMETER_NAME|GUI_PARAMETER)[\s\S]{0,1600}?(?=\r?\n\s*(?:PUBLISHED_PARAMETER|USER_PARAMETER|PARAMETER_DEF|PARAMETER_NAME|GUI_PARAMETER)\b|$)/gi;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRegex.exec(text)) !== null) {
    const block = blockMatch[0];
    const name =
      capture(block, /(?:name|parameter_name|parameterName|identifier|macro)\s*[:=]\s*["']?([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff.-]*)/i) ||
      capture(block, /(?:PUBLISHED_PARAMETER|USER_PARAMETER|PARAMETER_DEF|PARAMETER_NAME|GUI_PARAMETER)\s+["']?([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff.-]*)/i);

    if (!name || shouldSkipParameterName(name)) {
      continue;
    }

    const label =
      capture(block, /(?:label|prompt|display_name|displayName)\s*[:=]\s*["']?([^"'\r\n]+)/i) ||
      prettifyName(name);
    const declaredType = capture(block, /(?:type|parameter_type|parameterType|guiType)\s*[:=]\s*["']?([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff.-]*)/i);
    const defaultValue = capture(block, /(?:default|defaultValue|default_value|value)\s*[:=]\s*["']?([^"'\r\n]*)/i);
    const required = /(?:required|mandatory)\s*[:=]\s*(true|yes|1)/i.test(block);
    const description =
      capture(block, /(?:description|help|tooltip)\s*[:=]\s*["']?([^"'\r\n]+)/i) || null;
    const options = parseOptions(
      capture(block, /(?:options|choices|choiceList|items)\s*[:=]\s*["']?([^"'\r\n]+)/i)
    );

    parameters.push({
      name,
      label,
      ...inferParameterMetadata({
        name,
        label,
        declaredType,
        defaultValue: defaultValue || null,
        options
      }),
      defaultValue: defaultValue || null,
      required,
      options,
      visibility: null,
      description,
      sortOrder: parameters.length
    });
  }

  return parameters;
}

function parseCommandLineParameters(text: string): ParsedWorkspaceParameter[] {
  const firstLines = text.split(/\r?\n/).slice(0, 150).join("\n");
  const regex = /--([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff.-]*)\s+(?:"([^"]*)"|'([^']*)'|([^\s\r\n]+))/g;
  const parameters: ParsedWorkspaceParameter[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(firstLines)) !== null) {
    const name = match[1];
    if (shouldSkipParameterName(name)) {
      continue;
    }
    const defaultValue = match[2] ?? match[3] ?? match[4] ?? null;
    const label = prettifyName(name);
    parameters.push({
      name,
      label,
      ...inferParameterMetadata({
        name,
        label,
        declaredType: null,
        defaultValue,
        options: []
      }),
      defaultValue,
      required: false,
      options: [],
      visibility: null,
      description: null,
      sortOrder: parameters.length
    });
  }

  return parameters;
}

function parsePackagedPathParameters(text: string): ParsedWorkspaceParameter[] {
  const parameters: ParsedWorkspaceParameter[] = [];
  const regex = /(?:^|[{\s])DEFAULT_MACRO\s+([A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff.-]*)\s+([^\r\n}]*)/gmi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const name = normalizeFmeParameterName(match[1]);
    if (!name || shouldSkipParameterName(name)) {
      continue;
    }

    const defaultValue = extractPackagedPathValue(match[2]);
    if (!defaultValue) {
      continue;
    }

    const label = prettifyName(name);
    parameters.push({
      name,
      label,
      ...inferParameterMetadata({
        name,
        label,
        declaredType: "file",
        defaultValue,
        options: []
      }),
      defaultValue,
      required: false,
      options: [],
      visibility: null,
      description: "FMWT 模板包内置数据路径",
      sortOrder: parameters.length
    });
  }

  return parameters;
}

function extractPackagedPathValue(rawValue: string): string | null {
  const decoded = decodeFmeTokens(decodeXmlEntities(rawValue.trim()).replace(/^["']|["']$/g, ""));
  const macroMatch = decoded.match(/\$\(FME_MF_DIR(?:_USERTYPED|_ENCODED)?\)/i);
  if (!macroMatch || macroMatch.index === undefined) {
    return null;
  }

  let value = decoded.slice(macroMatch.index).trim();
  const expressionSeparator = value.search(/,\s*[^\\/)]/);
  if (expressionSeparator > 0) {
    value = value.slice(0, expressionSeparator);
  }
  return value.replace(/[)}\s]+$/g, "").replace(/^["'{]+|["'}]+$/g, "") || null;
}

function normalizeRawParameter(raw: Record<string, unknown>): ParsedWorkspaceParameter | null {
  const name = stringValue(raw.name ?? raw.parameterName ?? raw.identifier ?? raw.macroName ?? raw.id);
  if (!name || shouldSkipParameterName(name)) {
    return null;
  }

  const label = stringValue(raw.label ?? raw.displayName ?? raw.prompt ?? raw.title) || prettifyName(name);
  const rawOptions = extractOptions(raw);
  const rawDefaultValue = stringValue(raw.defaultValue ?? raw.default ?? raw.value);
  const defaultValue = rawDefaultValue ? decodeFmeTokens(rawDefaultValue) : null;
  const declaredType = [
    stringValue(raw.type ?? raw.parameterType ?? raw.valueType),
    stringValue(raw.valueType),
    stringValue(raw.accessMode),
    stringValue(raw.itemsToSelect),
    stringValue(raw.guiType ?? raw.editor ?? raw.category),
    Boolean(raw.selectMultiple) ? "multiple" : null
  ].filter((value): value is string => Boolean(value)).join(" ");
  const metadata = inferParameterMetadata({
    name,
    label,
    declaredType,
    defaultValue,
    options: rawOptions,
    accessMode: stringValue(raw.accessMode),
    itemsToSelect: stringValue(raw.itemsToSelect),
    selectMultiple: Boolean(raw.selectMultiple)
  });

  return {
    name,
    label,
    ...metadata,
    defaultValue,
    required: inferRawParameterRequired(raw),
    options: rawOptions,
    visibility: normalizeVisibilityRule(raw.visibility),
    description: stringValue(raw.description ?? raw.help ?? raw.tooltip),
    sortOrder: 0
  };
}

function normalizeVisibilityRule(value: unknown): ParameterVisibilityRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as ParameterVisibilityRule;
}

function inferRawParameterRequired(raw: Record<string, unknown>): boolean {
  const required = raw.required ?? raw.mandatory;
  if (typeof required === "boolean") {
    return required;
  }
  if (required !== undefined && required !== null) {
    return /^(true|yes|1|required|mandatory)$/i.test(String(required).trim());
  }
  return true;
}

function inferGuiLineRequired(guiLine: string): boolean {
  if (/\bOPTIONAL\b/i.test(guiLine)) {
    return false;
  }
  if (/\b(required|mandatory)\b/i.test(guiLine)) {
    return true;
  }
  return true;
}

function normalizeParameters(parameters: ParsedWorkspaceParameter[]): ParsedWorkspaceParameter[] {
  const byName = new Map<string, ParsedWorkspaceParameter>();
  for (const parameter of parameters) {
    const key = parameter.name.toUpperCase();
    if (!byName.has(key)) {
      byName.set(key, {
        ...parameter,
        label: parameter.label || prettifyName(parameter.name),
        options: parameter.options || []
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.sortOrder - b.sortOrder);
}

function extractOptions(raw: Record<string, unknown>): ParameterOption[] {
  const choiceSettings = raw.choiceSettings;
  const choiceSettingsRecord = choiceSettings && typeof choiceSettings === "object"
    ? choiceSettings as Record<string, unknown>
    : null;
  const source =
    choiceSettingsRecord?.choices ??
    raw.options ??
    raw.choices ??
    raw.choiceList ??
    raw.items ??
    raw.values;
  if (Array.isArray(source)) {
    return source
      .map((option) => {
        if (option && typeof option === "object") {
          const optionRecord = option as Record<string, unknown>;
          const value = stringValue(
            optionRecord.value ??
            optionRecord.name ??
            optionRecord.id ??
            optionRecord.label ??
            optionRecord.display ??
            optionRecord.displayName
          );
          const label = stringValue(
            optionRecord.display ??
            optionRecord.displayName ??
            optionRecord.label ??
            optionRecord.name ??
            value
          );
          return value ? { label: decodeFmeTokens(label || value), value: decodeFmeTokens(value) } : null;
        }
        const value = stringValue(option);
        return value ? { label: decodeFmeTokens(value), value: decodeFmeTokens(value) } : null;
      })
      .filter((option): option is ParameterOption => Boolean(option));
  }
  return parseOptions(stringValue(source));
}

interface ParameterMetadataInput {
  name: string;
  label: string;
  declaredType: string | null | undefined;
  defaultValue: string | null;
  options: ParameterOption[];
  accessMode?: string | null;
  itemsToSelect?: string | null;
  selectMultiple?: boolean;
}

function inferParameterMetadata(input: ParameterMetadataInput): {
  type: ParameterType;
  direction: ParameterDirection;
  pathKind: ParameterPathKind;
  multiple: boolean;
} {
  const direction = inferDirection(input);
  const fileGeodatabase = isFileGeodatabaseParameter(input);
  const pathKind = fileGeodatabase ? "folder" : inferPathKind(input);
  const multiple = fileGeodatabase
    ? false
    : Boolean(input.selectMultiple) || /\b(multi|multiple)\b|多选|复选/i.test(input.declaredType || "");
  return {
    type: inferType(input, direction, pathKind, multiple),
    direction,
    pathKind,
    multiple
  };
}

function inferType(
  input: ParameterMetadataInput,
  direction: ParameterDirection,
  pathKind: ParameterPathKind,
  multiple: boolean
): ParameterType {
  const { name, label, declaredType, defaultValue, options } = input;
  const text = `${declaredType || ""} ${name} ${label}`.toLowerCase();
  const declared = (declaredType || "").toLowerCase();
  const hasAliases = options.some((option) => option.label !== option.value);

  if (isSourceDatasetText(text)) return "source_dataset";
  if (isDestinationDatasetText(text)) return "destination_dataset";
  if (/message|notice|info|提示|说明|消息/.test(text)) return "message";
  if (/password|secret|credential|密码|密钥/.test(text)) return "password";
  if (/datetime|date_time|timestamp|日期时间/.test(text)) return "datetime";
  if (/(^|[\s_.-])date([\s_.-]|$)|日期/.test(text) && !/update|metadata/.test(text)) return "date";
  if (/(^|[\s_.-])time([\s_.-]|$)|时间/.test(text)) return "time";
  if (/color|colour|颜色|色值/.test(text)) return "color";
  if (/encoding|charset|codepage|字符编码|编码/.test(text)) return "encoding";
  if (/table|matrix|grid|表格|二维表/.test(text)) return "table";
  if (/database connection|db_connection|database_connection|数据库连接/.test(text)) return "database_connection";
  if (/web connection|web_connection|http connection|api connection|web连接|api连接/.test(text)) return "web_connection";
  if (/scripted selection|scripted_selection|python.*selection|动态选项|脚本选项/.test(text)) return "scripted_selection";
  if (/scripted value|scripted_value|python.*value|脚本值|后台计算/.test(text)) return "scripted_value";
  if (/expose attributes|expose_attribute|暴露属性|暴露字段/.test(text)) return "attribute_expose";
  if (/attribute name|attribute_name|attr(?:ibute)?(?:name)?|属性名|字段名|选择属性|选择字段|字段选择/.test(text)) return "attribute_name";
  if (/feature type|feature_type|featuretype|要素类型|图层|表名/.test(text)) return "feature_type";
  if (
    /geometry|geojson|bounding|bbox|extent|polygon|几何|空间范围|地理范围|边界范围|包围盒/.test(text) ||
    looksLikeGeometryValue(defaultValue)
  ) return "geometry";
  if (/reprojection file|grid file|datum.*grid|坐标转换网格|重投影文件/.test(text)) return "reprojection_file";
  if (/coord|coordinate system|coordsys|epsg|projection|坐标系/.test(text)) return "coordinate_system";
  if (/url|uri|endpoint|网址|链接/.test(text)) return "url";
  if (/output_format|(^|[\s_.-])(output|dest|writer)[\s_.-]*format|输出格式|输出文件格式/.test(text)) return "output_format";
  if (/checkbox_group|checklist|check boxes|复选|勾选/.test(text) && options.length > 0) return "checkbox_group";
  if (multiple && options.length > 0) return "multi_choice";
  if (/multi|multiple|checklist|checkbox_group|多选|复选|勾选/.test(text) && options.length > 0) return "multi_choice";
  if (/choice|enum|select|lookup|radio|dropdown|选项|选择|单选/.test(text) || options.length > 0) {
    return hasAliases ? "choice_alias" : "enum";
  }
  if (/yes\/no|yesno|bool|boolean|checkbox|switch|toggle|是\/否|是否|布尔/.test(text)) return "boolean";
  if (/number|integer|float|double|numeric|decimal|slider|数字|数值|数量|整数|浮点/.test(text)) return "number";
  if (/textarea|multiline|multi-line|long text|text_edit|多行|长文本/.test(text)) return "textarea";
  if (/(^|[\s_.-])text([\s_.-]|$)|plaintext|文本/.test(text)) return "text";
  if (/(^|[\s_.-])(filename|file_name)([\s_.-]|$)|feature type name|文件名称|文件名|名称/.test(text)
    && !/path|dir|directory|folder|dataset|目录|路径|文件夹|数据集/.test(text)) {
    return "string";
  }
  if (pathKind === "folder") return "folder";
  if (pathKind === "file") return "file";
  if (defaultValue && /\.[A-Za-z0-9]{2,8}($|[?#])/.test(defaultValue) && !/folder|directory|dir|目录|文件夹/.test(text)) return "file";
  if (/folder|folders|directory|dirname|dir|目录|文件夹/.test(text)) return "folder";
  if (/path|路径/.test(text)) return "path";
  if (/file|filename|dataset|source|input|reader|文件|数据集/.test(text)) return "file";
  if (defaultValue && /^(true|false|yes|no|0|1)$/i.test(defaultValue)) return "boolean";
  if (defaultValue && /^-?\d+(\.\d+)?$/.test(defaultValue)) return "number";
  if (direction !== "none" && /dataset/.test(declared)) {
    return direction === "output" ? "destination_dataset" : "source_dataset";
  }
  return "string";
}

function looksLikeGeometryValue(value: string | null): boolean {
  if (!value) {
    return false;
  }
  const text = value.trim();
  return (
    /^[{[]/.test(text) ||
    /^(?:POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\s*\(/i.test(text)
  );
}

function isFileGeodatabaseParameter(input: ParameterMetadataInput): boolean {
  const text = `${input.declaredType || ""} ${input.name} ${input.label} ${input.defaultValue || ""}`;
  return /file\s*geodatabase|filegdb|\.gdb(?:[\\/]|$)/i.test(text);
}

function stringifyFmeValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(stringifyFmeValue).join(",");
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return String(value);
}

function inferDirection(input: ParameterMetadataInput): ParameterDirection {
  const accessMode = (input.accessMode || "").toLowerCase();
  if (/write|output|destination/.test(accessMode)) {
    return "output";
  }
  if (/read|input|source/.test(accessMode)) {
    return "input";
  }

  const text = `${input.declaredType || ""} ${input.name} ${input.label}`.toLowerCase();
  if (isDestinationDatasetText(text)) {
    return "output";
  }
  if (isSourceDatasetText(text)) {
    return "input";
  }
  if (/(^|[\s_.-])(output|out|dest|destination|writer|result|target|export|sink)([\s_.-]|$)|输出|成果|结果|目标|写入|导出/.test(text)) {
    return "output";
  }
  if (/(^|[\s_.-])(input|source|reader|src)([\s_.-]|$)|输入|源数据|来源|读取/.test(text)) {
    return "input";
  }
  return "none";
}

function inferPathKind(input: ParameterMetadataInput): ParameterPathKind {
  const itemsToSelect = (input.itemsToSelect || "").toLowerCase();
  if (/folder|directory/.test(itemsToSelect)) {
    return "folder";
  }
  if (/file/.test(itemsToSelect)) {
    return "file";
  }

  const text = `${input.declaredType || ""} ${input.name} ${input.label}`.toLowerCase();
  if (/folder|folders|directory|dirname|multidirectory|目录|文件夹/.test(text)) {
    return "folder";
  }
  if (/file_or_url|multifile|(^|[\s_.-])file([\s_.-]|$)|文件路径/.test(text)) {
    return "file";
  }
  if (
    input.defaultValue &&
    /[\\/]/.test(input.defaultValue) &&
    /\.[A-Za-z][A-Za-z0-9]{1,7}($|[?#])/.test(input.defaultValue)
  ) {
    return "file";
  }
  if (/dataset|path|路径|数据集/.test(text)) {
    return /dest|destination|writer|output|输出/.test(text) ? "folder" : null;
  }
  return null;
}

function isSourceDatasetText(text: string): boolean {
  return /source[\s_.-]*dataset|sourcedataset_|reader[\s_.-]*dataset|源数据集|输入数据集/.test(text);
}

function isDestinationDatasetText(text: string): boolean {
  return /destination[\s_.-]*dataset|destdataset_|featurewriterdataset_|writer[\s_.-]*dataset|目标数据集|输出数据集/.test(text);
}

function isPathParameter(type: ParameterType, pathKind: ParameterPathKind): boolean {
  return Boolean(pathKind) || [
    "file",
    "folder",
    "path",
    "reprojection_file",
    "source_dataset",
    "destination_dataset"
  ].includes(type);
}

function parseOptions(raw: string | null): ParameterOption[] {
  if (!raw) {
    return [];
  }
  const normalized = raw.replace(/%space%/gi, " ");
  const rawOptions = normalized.includes("%")
    ? normalized.split("%")
    : normalized.includes("|")
      ? normalized.split("|")
      : normalized.includes(";")
        ? normalized.split(";")
        : normalized.split(",");

  return rawOptions
    .map((rawOption): ParameterOption | null => {
      const option = rawOption.trim().replace(/^["']|["']$/g, "");
      if (!option) {
        return null;
      }
      const aliasSeparator = findAliasSeparator(option);
      if (aliasSeparator < 0) {
        const value = decodeFmeTokens(option);
        return { label: value, value };
      }
      const label = decodeFmeTokens(option.slice(0, aliasSeparator).trim());
      const value = decodeFmeTokens(option.slice(aliasSeparator + 1).trim());
      return value ? { label: label || value, value } : null;
    })
    .filter((option): option is ParameterOption => Boolean(option));
}

function findAliasSeparator(value: string): number {
  let angleDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "<") {
      angleDepth += 1;
    } else if (character === ">" && angleDepth > 0) {
      angleDepth -= 1;
    } else if (character === "," && angleDepth === 0) {
      return index;
    }
  }
  return -1;
}

function resolveWorkspacePackagePath(value: string | null, context: WorkspaceParseContext): string | null {
  if (!value || !context.packageRoot) {
    return value;
  }

  const decoded = decodeFmeTokens(value);
  if (!/\$\(FME_MF_DIR(?:_USERTYPED|_ENCODED)?\)/i.test(decoded)) {
    return value;
  }

  const packageRoot = context.packageRoot.replace(/[\\/]+$/g, "");
  return decoded.replace(
    /\$\(FME_MF_DIR(?:_USERTYPED|_ENCODED)?\)([^"'\r\n]*)/gi,
    (_match, relativePath: string) => {
      const expressionSeparator = relativePath.search(/,\s*[^\\/)]/);
      const pathText = expressionSeparator > 0
        ? relativePath.slice(0, expressionSeparator)
        : relativePath;
      const cleanRelativePath = pathText
        .replace(/[)}\s]+$/g, "")
        .replace(/^[\\/]+/, "");

      return path.normalize(path.join(packageRoot, cleanRelativePath));
    }
  );
}

function decodeFmeTokens(value: string): string {
  const namedTokens: Record<string, string> = {
    space: " ",
    solidus: "/",
    backslash: "\\",
    comma: ",",
    colon: ":",
    semicolon: ";",
    percent: "%",
    lt: "<",
    gt: ">",
    amp: "&",
    quote: "\"",
    apos: "'",
    openparen: "(",
    closeparen: ")",
    openbracket: "[",
    closebracket: "]",
    opencurly: "{",
    closecurly: "}"
  };
  return value
    .replace(/<u([0-9a-f]{4,6})>/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/<([a-z]+)>/gi, (match, token: string) => namedTokens[token.toLowerCase()] ?? match)
    .trim();
}

function capture(text: string, regex: RegExp): string | null {
  const match = text.match(regex);
  return match?.[1]?.trim().replace(/^["']|["']$/g, "") || null;
}

function parseXmlAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([A-Za-z_][\w.-]*)="([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    attrs[match[1]] = decodeXmlEntities(match[2]);
  }

  return attrs;
}

function parseGuiLine(guiLine: string): { type: string; name: string; label: string; choices: string | null } | null {
  if (!guiLine) {
    return null;
  }
  const tokens = [...guiLine.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]);
  const guiIndex = tokens.findIndex((token) => token.toUpperCase() === "GUI");
  let start = guiIndex >= 0 ? guiIndex + 1 : 0;
  while (["OPTIONAL", "WHOLE_LINE"].includes((tokens[start] || "").toUpperCase())) {
    start += 1;
  }
  const type = tokens[start];
  const name = tokens[start + 1];
  if (!type || !name) {
    return null;
  }
  const labelTokens = tokens.slice(start + 2);
  const choiceToken = labelTokens.find((token) => /[%|;]/.test(token));
  return {
    type,
    name,
    label: decodeFmeTokens(labelTokens.filter((token) => token !== choiceToken).join(" ")) || prettifyName(name),
    choices: choiceToken || null
  };
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stringValue(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim() || null;
  }
  return String(value);
}

function normalizeFmeParameterName(name: string): string {
  return name.trim().replace(/^-+/, "");
}

function shouldSkipParameterName(name: string): boolean {
  return /^(FME_|_FME|_|LOG_|COMMANDLINE|WORKSPACE|OUTPUT_DIR$)/i.test(normalizeFmeParameterName(name));
}

function prettifyName(name: string): string {
  // 如果参数名包含中文，直接返回原始名称
  if (/[\u4e00-\u9fff]/.test(name)) {
    return name;
  }
  
  return name
    .replace(/^-+/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function createProgressTracker(): (chunk: string) => number | null {
  const streams = new Map<string, ProgressStream>();
  const percentProgressState: PercentProgressState = {
    phaseIndex: 0,
    lastPercent: null
  };
  let pendingLine = "";
  let activeKey: string | null = null;

  return (chunk: string) => {
    const text = pendingLine + chunk;
    const lines = splitProgressLines(text);
    pendingLine = text.endsWith("\n") || text.endsWith("\r") ? "" : lines.pop() ?? "";

    let latestProgress: number | null = null;
    for (const line of lines) {
      const phaseProgress = extractPhaseProgress(line);
      if (phaseProgress !== null) {
        latestProgress = Math.max(latestProgress ?? 0, phaseProgress);
      }

      const explicitPercent = extractPercentProgress(line);
      if (explicitPercent !== null) {
        latestProgress = Math.max(
          latestProgress ?? 0,
          scalePercentProgress(explicitPercent, percentProgressState)
        );
        continue;
      }

      const measured = extractMeasuredProgress(line);
      if (!measured) {
        continue;
      }

      const previous = streams.get(measured.key);
      const stream: ProgressStream = {
        ...measured,
        samples: (previous?.samples ?? 0) + 1
      };
      streams.set(stream.key, stream);

      const active = activeKey ? streams.get(activeKey) ?? null : null;
      if (shouldUseProgressStream(stream, active)) {
        activeKey = stream.key;
        latestProgress = Math.max(
          latestProgress ?? 0,
          scaleMeasuredProgress(stream.percent)
        );
      }
    }

    return latestProgress;
  };
}

function splitProgressLines(text: string): string[] {
  return text.split(/\r\n|\n|\r/);
}

function extractPercentProgress(line: string): number | null {
  const match = line.match(/(\d{1,3})\s*%/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (Number.isNaN(value)) {
    return null;
  }
  return normalizePercentValue(value);
}

function extractMeasuredProgress(line: string): Omit<ProgressStream, "samples"> | null {
  const match = findMeasuredProgressMatch(line);
  if (!match?.groups) {
    return null;
  }

  const current = parseProgressNumber(match.groups.current);
  const total = parseProgressNumber(match.groups.total);
  if (!current || !total || current > total) {
    return null;
  }

  const percent = normalizePercentValue((current / total) * 100);
  return {
    key: [
      (match.groups.source || "").trim().toLowerCase(),
      (match.groups.label || "").trim().toLowerCase(),
      (match.groups.unit || "").trim().toLowerCase(),
      total
    ].join("|"),
    current,
    total,
    percent
  };
}

function findMeasuredProgressMatch(line: string): RegExpMatchArray | null {
  const strictMatch = line.match(
    /^(?<source>[^:\r\n]+):\s*Processed(?:\s+'(?<label>[^']+)')?\s+(?<current>[\d,]+)\s*(?:\/|of)\s*(?<total>[\d,]+)(?:\s+(?<unit>[A-Za-z]+))?/i
  );
  if (strictMatch?.groups) {
    return strictMatch;
  }

  if (!/(processed|reading|read|writing|wrote|converted|loaded|features?|records?|rows?|objects?)/i.test(line)) {
    return null;
  }
  return line.match(
    /^(?<source>[^:\r\n]{0,100})[:\s-]*(?:Processed|Reading|Read|Writing|Wrote|Converted|Loaded|Completed)?[^\r\n]*?(?<current>[\d,]+)\s*(?:\/|of)\s*(?<total>[\d,]+)(?:\s+(?<unit>[A-Za-z]+))?/i
  );
}

function extractPhaseProgress(line: string): number | null {
  if (/^\s*FME\s+\d/i.test(line) || /Safe Software/i.test(line)) {
    return 10;
  }
  if (/Reading\.\.\.|Start(?:ed|ing)? translation|Begin(?:ning)? translation/i.test(line)) {
    return 12;
  }
  if (/Emptying factory pipeline|factory pipeline/i.test(line)) {
    return 14;
  }
  if (/Writing\.\.\./i.test(line)) {
    return 72;
  }
  if (/Translation was SUCCESSFUL|Translation finished|Translation complete/i.test(line)) {
    return 94;
  }
  return null;
}

function shouldUseProgressStream(stream: ProgressStream, active: ProgressStream | null): boolean {
  if (stream.samples < 2) {
    return false;
  }
  if (!active) {
    return true;
  }
  if (stream.key === active.key) {
    return true;
  }
  return stream.samples > active.samples && stream.total >= active.total;
}

function parseProgressNumber(value: string): number {
  return Number(value.replace(/,/g, ""));
}

function normalizePercentValue(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

function scalePercentProgress(value: number, state: PercentProgressState): number {
  const percent = normalizePercentValue(value);
  if (state.lastPercent !== null && percent + 8 < state.lastPercent) {
    state.phaseIndex += 1;
  }
  state.lastPercent = percent;

  const phase = progressPhaseRange(state.phaseIndex);
  return Math.round(phase.start + (phase.end - phase.start) * (percent / 100));
}

function scaleMeasuredProgress(value: number): number {
  const percent = normalizePercentValue(value);
  return Math.round(18 + percent * 0.62);
}

function progressPhaseRange(phaseIndex: number): { start: number; end: number } {
  const cappedIndex = Math.max(0, phaseIndex);
  const start = 18 + 52 * (1 - Math.exp(-cappedIndex / 3));
  const width = Math.max(4, 14 * Math.exp(-cappedIndex / 4));
  return {
    start,
    end: Math.min(88, start + width)
  };
}

function firstNonEmptyLine(text: string): string | undefined {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
}

function formatCommandForLog(command: string, args: string[]): string {
  return [command, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
}

export function defaultLogPath(taskId: string): string {
  return path.join(logStorageDir, `${taskId}.log`);
}
