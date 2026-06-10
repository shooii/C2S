import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import AdmZip from "adm-zip";
import iconv from "iconv-lite";
import { fmeCandidates, logStorageDir, outputStorageDir } from "../config/paths";
import type { ParameterType, ResultFile } from "../types";
import { getResultFileType, isPreviewable, listFilesRecursive } from "./file.service";

export interface ParsedWorkspaceParameter {
  name: string;
  label: string;
  type: ParameterType;
  defaultValue: string | null;
  required: boolean;
  options: string[];
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
  const text = readWorkspaceText(workspacePath);
  return parseWorkspaceParameterText(text);
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
  parameter: Pick<ParsedWorkspaceParameter, "name" | "label" | "type" | "defaultValue" | "description">
): boolean {
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

function parseWorkspaceParameterText(text: string): ParsedWorkspaceParameter[] {
  const parameters = normalizeParameters([
    ...parseUserParameterForms(text),
    ...parseXmlGuiLineParameters(text),
    ...parseJsonLikeParameters(text),
    ...parseTextBlocks(text),
    ...parseCommandLineParameters(text)
  ]);

  return parameters.map((parameter, index) => ({
    ...parameter,
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
  const writeLog = (chunk: string) => {
    logStream.write(chunk);
    input.onLog?.(chunk);
    const progress = extractProgress(chunk);
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

export function scanOutputFiles(taskId: string): Array<Omit<ResultFile, "id" | "createdAt">> {
  const outputDir = path.join(outputStorageDir, taskId);
  return listFilesRecursive(outputDir).map((file) => ({
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
    const defaultValue = attrs.DEFAULT_VALUE || attrs.VALUE || null;
    const declaredType = [parsedGui?.type, attrs.TYPE, attrs.PARAMETER_TYPE].filter(Boolean).join(" ");

    parameters.push({
      name,
      label,
      type: inferType(name, label, declaredType, defaultValue, splitOptions(parsedGui?.choices || null)),
      defaultValue,
      required: /required|mandatory/i.test(guiLine),
      options: splitOptions(parsedGui?.choices || null),
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
    const options = splitOptions(
      capture(block, /(?:options|choices|choiceList|items)\s*[:=]\s*["']?([^"'\r\n]+)/i)
    );

    parameters.push({
      name,
      label,
      type: inferType(name, label, declaredType, defaultValue || null, options),
      defaultValue: defaultValue || null,
      required,
      options,
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
      type: inferType(name, label, null, defaultValue, []),
      defaultValue,
      required: false,
      options: [],
      description: null,
      sortOrder: parameters.length
    });
  }

  return parameters;
}

function normalizeRawParameter(raw: Record<string, unknown>): ParsedWorkspaceParameter | null {
  const name = stringValue(raw.name ?? raw.parameterName ?? raw.identifier ?? raw.macroName ?? raw.id);
  if (!name || shouldSkipParameterName(name)) {
    return null;
  }

  const label = stringValue(raw.label ?? raw.displayName ?? raw.prompt ?? raw.title) || prettifyName(name);
  const rawOptions = extractOptions(raw);
  const defaultValue = stringValue(raw.defaultValue ?? raw.default ?? raw.value);
  const declaredType = [
    stringValue(raw.type ?? raw.parameterType ?? raw.valueType),
    stringValue(raw.valueType),
    stringValue(raw.accessMode),
    stringValue(raw.itemsToSelect),
    stringValue(raw.guiType ?? raw.editor ?? raw.category),
    Boolean(raw.selectMultiple) ? "multiple" : null
  ].filter((value): value is string => Boolean(value)).join(" ");

  return {
    name,
    label,
    type: inferType(name, label, declaredType, defaultValue, rawOptions),
    defaultValue,
    required: Boolean(raw.required ?? raw.mandatory ?? false),
    options: rawOptions,
    description: stringValue(raw.description ?? raw.help ?? raw.tooltip),
    sortOrder: 0
  };
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

function extractOptions(raw: Record<string, unknown>): string[] {
  const source = raw.options ?? raw.choices ?? raw.choiceList ?? raw.items ?? raw.values;
  if (Array.isArray(source)) {
    return source
      .map((option) => {
        if (option && typeof option === "object") {
          const optionRecord = option as Record<string, unknown>;
          return stringValue(optionRecord.value ?? optionRecord.name ?? optionRecord.label ?? optionRecord.displayName);
        }
        return stringValue(option);
      })
      .filter((option): option is string => Boolean(option));
  }
  return splitOptions(stringValue(source));
}

function inferType(
  name: string,
  label: string,
  declaredType: string | null | undefined,
  defaultValue: string | null,
  options: string[]
): ParameterType {
  const text = `${declaredType || ""} ${name} ${label}`.toLowerCase();
  if (/message|notice|info|提示|说明|消息/.test(text)) return "message";
  if (/password|secret|credential|密码|密钥/.test(text)) return "password";
  if (/datetime|date_time|timestamp|日期|时间/.test(text)) return "datetime";
  if (/color|colour|颜色|色值/.test(text)) return "color";
  if (/encoding|charset|codepage|字符编码|编码/.test(text)) return "encoding";
  if (/table|matrix|grid|表格|二维表/.test(text)) return "table";
  if (/database connection|db_connection|database_connection|数据库连接/.test(text)) return "database_connection";
  if (/web connection|web_connection|http connection|api connection|web连接|api连接/.test(text)) return "web_connection";
  if (/scripted selection|scripted_selection|python.*selection|动态选项|脚本选项/.test(text)) return "scripted_selection";
  if (/scripted value|scripted_value|python.*value|脚本值|后台计算/.test(text)) return "scripted_value";
  if (/expose attributes|expose_attribute|暴露属性|暴露字段/.test(text)) return "attribute_expose";
  if (/select attributes|select_attribute|attribute.*select|选择属性|选择字段|字段选择/.test(text)) return "attribute_select";
  if (/geometry|geojson|bounding|extent|polygon|几何|范围/.test(text)) return "geometry";
  if (/reprojection file|grid file|datum.*grid|坐标转换网格|重投影文件/.test(text)) return "reprojection_file";
  if (/coord|coordinate system|coordsys|epsg|projection|坐标系/.test(text)) return "coordinate_system";
  if (/url|uri|endpoint|网址|链接/.test(text)) return "url";
  if (/format|格式|output_format/.test(text)) return "output_format";
  if (/checkbox_group|checklist|check boxes|复选|勾选/.test(text) && options.length > 0) return "checkbox_group";
  if (/multi|multiple|checklist|checkbox_group|多选|复选|勾选/.test(text) && options.length > 0) return "multi_choice";
  if (/choice|enum|select|lookup|radio|选项|选择|单选/.test(text) || options.length > 0) return "enum";
  if (/yes\/no|yesno|bool|boolean|checkbox|switch|toggle|是\/否|是否|布尔/.test(text)) return "boolean";
  if (/number|integer|float|double|numeric|decimal|slider|数字|数值|数量|整数|浮点/.test(text)) return "number";
  if (/textarea|multiline|multi-line|long text|多行|长文本/.test(text)) return "textarea";
  if (/(^|[\s_.-])text([\s_.-]|$)|文本/.test(text)) return "text";
  if (/(^|[\s_.-])(filename|file_name)([\s_.-]|$)|feature type name|文件名称|文件名|名称/.test(text)
    && !/path|dir|directory|folder|dataset|目录|路径|文件夹|数据集/.test(text)) {
    return "string";
  }
  if (defaultValue && /\.[A-Za-z0-9]{2,8}($|[?#])/.test(defaultValue) && !/folder|directory|dir|目录|文件夹/.test(text)) return "file";
  if (/folder|folders|directory|dirname|dir|目录|文件夹/.test(text)) return "folder";
  if (/path|路径/.test(text)) return "path";
  if (/file|filename|dataset|source|input|reader|文件|数据集/.test(text)) return "file";
  if (defaultValue && /^(true|false|yes|no|0|1)$/i.test(defaultValue)) return "boolean";
  if (defaultValue && /^-?\d+(\.\d+)?$/.test(defaultValue)) return "number";
  return "string";
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

function splitOptions(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .replace(/%space%/gi, " ")
    .replace(/<space>/gi, " ")
    .split(/[|;,%]/)
    .map((value) => value.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
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
  const start = guiIndex >= 0 ? guiIndex + 1 : 0;
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
    label: labelTokens.filter((token) => token !== choiceToken).join(" ") || prettifyName(name),
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

function extractProgress(chunk: string): number | null {
  const match = chunk.match(/(\d{1,3})\s*%/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (Number.isNaN(value)) {
    return null;
  }
  return Math.max(5, Math.min(99, value));
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
