import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import iconv from "iconv-lite";
import {
  inputStorageDir,
  outputStorageDir,
  templateStorageDir
} from "../config/paths";
import { HttpError } from "../utils/httpError";

const templateExtensions = new Set([".fmw", ".fmwt"]);
const previewExtensions = new Set([".glb", ".gltf", ".json", ".b3dm", ".i3dm", ".pnts", ".cmpt", ".tileset"]);

/**
 * 解码文件名，处理可能的中文编码问题
 * 尝试多种编码方式，确保中文文件名正确显示
 */
export function decodeFileName(fileName: string): string {
  try {
    // 如果文件名已经是正确的 UTF-8，直接返回
    if (!containsNonUtf8Bytes(fileName)) {
      return fileName;
    }
  } catch {
    // 继续尝试其他编码
  }

  // 尝试从 Buffer 重新解码
  try {
    const buffer = Buffer.from(fileName, "binary");
    
    // 尝试 UTF-8
    const utf8Text = buffer.toString("utf8");
    if (!isGarbledText(utf8Text)) {
      return utf8Text;
    }

    // 尝试 GBK
    const gbkText = iconv.decode(buffer, "gbk");
    if (!isGarbledText(gbkText)) {
      return gbkText;
    }

    // 尝试 GB18030
    const gb18030Text = iconv.decode(buffer, "gb18030");
    if (!isGarbledText(gb18030Text)) {
      return gb18030Text;
    }
  } catch {
    // 解码失败，返回原始文件名
  }

  return fileName;
}

/**
 * 检查字符串是否包含非 UTF-8 编码的字节
 */
function containsNonUtf8Bytes(text: string): boolean {
  // 检查是否有替换字符
  if (text.includes("\uFFFD")) {
    return true;
  }

  // 检查是否有异常的字节序列
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // C1 控制字符范围 (0x80-0x9F) 在正常 UTF-8 文本中不应该出现
    if (code >= 0x80 && code <= 0x9F) {
      return true;
    }
  }

  return false;
}

/**
 * 检查文本是否为乱码
 */
function isGarbledText(text: string): boolean {
  // 检查是否有替换字符
  if (text.includes("\uFFFD")) {
    return true;
  }

  let chineseCount = 0;
  let suspiciousChars = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    
    // 中文字符范围
    if ((code >= 0x4E00 && code <= 0x9FFF) || 
        (code >= 0x3400 && code <= 0x4DBF)) {
      chineseCount++;
    }
    
    // 控制字符（除了常见的换行、制表符）
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      suspiciousChars++;
    }
  }

  // 如果有足够的中文字符，说明编码可能是正确的
  if (chineseCount > 3) {
    return false;
  }

  // 如果有大量控制字符，可能是乱码
  if (suspiciousChars > text.length * 0.05) {
    return true;
  }

  return false;
}

export function safeFileName(fileName: string): string {
  // 先尝试解码文件名
  const decodedName = decodeFileName(fileName);
  
  const parsed = path.parse(path.basename(decodedName));
  const safeBase = parsed.name
    .normalize("NFKD")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/\.+/g, ".")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "file";
  const safeExt = parsed.ext.toLowerCase().replace(/[^.\w]/g, "");
  return `${safeBase}${safeExt}`;
}

export function assertTemplateFile(fileName: string): void {
  const ext = path.extname(fileName).toLowerCase();
  if (!templateExtensions.has(ext)) {
    throw new HttpError(400, "仅支持上传 .fmw / .fmwt 模板文件");
  }
}

export function createDiskStorage(destination: string): multer.StorageEngine {
  fs.mkdirSync(destination, { recursive: true });
  return multer.diskStorage({
    destination,
    filename: (req, file, cb) => {
      // 解码原始文件名，处理可能的中文编码问题
      const decodedName = decodeFileName(file.originalname);
      const unique = `${Date.now()}-${cryptoRandom()}-${safeFileName(decodedName)}`;
      cb(null, unique);
    }
  });
}

export function createTemplateUpload() {
  return multer({
    storage: createDiskStorage(templateStorageDir),
    limits: {
      fileSize: 500 * 1024 * 1024
    },
    fileFilter: (_req, file, cb) => {
      try {
        assertTemplateFile(file.originalname);
        cb(null, true);
      } catch (error) {
        cb(error as Error);
      }
    }
  });
}

export function createInputUpload() {
  return multer({
    storage: createDiskStorage(inputStorageDir),
    limits: {
      fileSize: 2 * 1024 * 1024 * 1024
    }
  });
}

export function assertPathInside(root: string, targetPath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new HttpError(400, "非法文件路径");
  }
  return resolvedTarget;
}

export function getResultFileType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".glb" || ext === ".gltf") return "gltf";
  if (ext === ".json") return "json";
  if ([".b3dm", ".i3dm", ".pnts", ".cmpt"].includes(ext) || fileName.toLowerCase().endsWith("tileset.json")) {
    return "3dtiles";
  }
  return ext.replace(".", "") || "file";
}

export function isPreviewable(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return previewExtensions.has(path.extname(lower)) || lower.endsWith("tileset.json");
}

export function listFilesRecursive(dir: string): Array<{ filePath: string; fileName: string; fileSize: number }> {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files: Array<{ filePath: string; fileName: string; fileSize: number }> = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      const stat = fs.statSync(entryPath);
      files.push({
        filePath: entryPath,
        fileName: decodeFileName(path.relative(dir, entryPath).replace(/\\/g, "/")),
        fileSize: stat.size
      });
    }
  };
  walk(dir);
  return files;
}

export function directorySize(dir: string): number {
  return listFilesRecursive(dir).reduce((total, file) => total + file.fileSize, 0);
}

export function removeIfExists(targetPath: string): void {
  if (!fs.existsSync(targetPath)) {
    return;
  }
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(targetPath);
  }
}

export function resultOutputPath(taskId: string): string {
  return path.join(outputStorageDir, taskId);
}

function cryptoRandom(): string {
  return Math.random().toString(36).slice(2, 10);
}

