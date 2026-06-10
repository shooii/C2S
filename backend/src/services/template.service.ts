import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDb, nowIso, runTransaction } from "../db/database";
import type { ParseStatus, TemplateDetail, TemplateParameter, TemplateRecord } from "../types";
import { assertTemplateFile, decodeFileName, removeIfExists, safeFileName } from "./file.service";
import { parseWorkspaceParameters } from "./fme.service";
import { assertFound, HttpError } from "../utils/httpError";
import { getTemplateGroup } from "./template-group.service";

type TemplateRow = Omit<TemplateRecord, "tags" | "enabled"> & {
  tags: string;
  enabled: number;
};
type ParameterRow = Omit<TemplateParameter, "required" | "options"> & {
  required: number;
  options: string;
};

export interface UpdateTemplateConfigurationInput {
  description?: string | null;
  version?: string | null;
  enabled?: boolean;
  parameterLabels?: Array<{ id: string; label: string }>;
}

export function listTemplates(options: { search?: string; enabled?: boolean } = {}): TemplateRecord[] {
  const db = getDb();
  const where: string[] = [];
  const params: Record<string, string | number> = {};

  if (options.search) {
    where.push("(name LIKE @search OR fileName LIKE @search OR description LIKE @search OR tags LIKE @search)");
    params.search = `%${options.search}%`;
  }
  if (options.enabled !== undefined) {
    where.push("enabled = @enabled");
    params.enabled = options.enabled ? 1 : 0;
  }

  const sql = `
    SELECT * FROM templates
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY updatedAt DESC
  `;
  return (db.prepare(sql).all(params) as unknown as TemplateRow[]).map(mapTemplateRow);
}

export function getTemplate(id: string): TemplateDetail {
  const db = getDb();
  const template = assertFound(
    db.prepare("SELECT * FROM templates WHERE id = ?").get(id) as TemplateRow | undefined,
    "模板不存在"
  );
  const parameters = (
    db.prepare("SELECT * FROM template_parameters WHERE templateId = ? ORDER BY sortOrder ASC")
      .all(id) as unknown as ParameterRow[]
  ).map(mapParameterRow);

  return {
    ...mapTemplateRow(template),
    parameters
  };
}

export async function createTemplateFromUpload(
  file: Express.Multer.File,
  groupId = "default"
): Promise<TemplateDetail> {
  if (!file) {
    throw new HttpError(400, "请上传模板文件");
  }

  assertTemplateFile(file.originalname);
  getTemplateGroup(groupId);

  // 解码原始文件名，处理可能的中文编码问题
  const decodedOriginalName = decodeFileName(file.originalname);
  
  const id = randomUUID();
  const createdAt = nowIso();
  const fileType = path.extname(decodedOriginalName).toLowerCase() as ".fmw" | ".fmwt";
  const displayFileName = safeFileName(decodedOriginalName);
  const name = path.parse(displayFileName).name;
  assertTemplateNameAvailable(groupId, name);

  getDb()
    .prepare(
      `INSERT INTO templates (
        id, groupId, name, fileName, fileType, filePath, description, inputDataType, outputDataType,
        parameterCount, enabled, parseStatus, parseMessage, version, tags, createdAt, updatedAt
      ) VALUES (
        @id, @groupId, @name, @fileName, @fileType, @filePath, @description, @inputDataType, @outputDataType,
        @parameterCount, @enabled, @parseStatus, @parseMessage, @version, @tags, @createdAt, @updatedAt
      )`
    )
    .run({
      id,
      groupId,
      name,
      fileName: displayFileName,
      fileType,
      filePath: file.path,
      description: null,
      inputDataType: "CIM",
      outputDataType: null,
      parameterCount: 0,
      enabled: 0,
      parseStatus: "pending",
      parseMessage: "已上传，等待解析",
      version: "1.0.0",
      tags: JSON.stringify([]),
      createdAt,
      updatedAt: createdAt
    });

  return parseTemplate(id);
}

export async function parseTemplate(id: string): Promise<TemplateDetail> {
  const template = getTemplate(id);
  const db = getDb();
  const parsingAt = nowIso();

  db.prepare("UPDATE templates SET parseStatus = ?, parseMessage = ?, updatedAt = ? WHERE id = ?")
    .run("parsing", "正在解析 FME Published Parameters / User Parameters", parsingAt, id);

  try {
    const parameters = await parseWorkspaceParameters(template.filePath);
    const insertParameter = db.prepare(
      `INSERT INTO template_parameters (
        id, templateId, name, label, type, defaultValue, required, options, description, sortOrder
      ) VALUES (
        @id, @templateId, @name, @label, @type, @defaultValue, @required, @options, @description, @sortOrder
      )`
    );

    const updateTemplate = db.prepare(
      `UPDATE templates
       SET parameterCount = @parameterCount,
           parseStatus = @parseStatus,
           parseMessage = @parseMessage,
           outputDataType = COALESCE(@outputDataType, outputDataType),
           updatedAt = @updatedAt
       WHERE id = @id`
    );

    runTransaction(() => {
      db.prepare("DELETE FROM template_parameters WHERE templateId = ?").run(id);
      parameters.forEach((parameter, index) => {
        insertParameter.run({
          id: randomUUID(),
          templateId: id,
          name: parameter.name,
          label: parameter.label,
          type: parameter.type,
          defaultValue: parameter.defaultValue,
          required: parameter.required ? 1 : 0,
          options: JSON.stringify(parameter.options),
          description: parameter.description,
          sortOrder: index
        });
      });
      updateTemplate.run({
        id,
        parameterCount: parameters.length,
        parseStatus: "success",
        parseMessage: parameters.length ? `解析成功，共 ${parameters.length} 个参数` : "解析成功，未识别到公开参数",
        outputDataType: inferOutputDataType(parameters.map((parameter) => parameter.defaultValue || parameter.name)),
          updatedAt: nowIso()
        });
    });
  } catch (error) {
    db.prepare("UPDATE templates SET parseStatus = ?, parseMessage = ?, updatedAt = ? WHERE id = ?").run(
      "failed",
      error instanceof Error ? error.message : "模板解析失败",
      nowIso(),
      id
    );
  }

  return getTemplate(id);
}

export function deleteTemplate(id: string): void {
  const template = getTemplate(id);
  const db = getDb();
  db.prepare("DELETE FROM templates WHERE id = ?").run(id);
  removeIfExists(template.filePath);
}

export function updateTemplateDescription(id: string, description: string | null): TemplateDetail {
  return updateTemplateConfiguration(id, { description });
}

export function updateTemplateConfiguration(
  id: string,
  input: UpdateTemplateConfigurationInput
): TemplateDetail {
  const template = getTemplate(id);
  const normalizedDescription = input.description === undefined
    ? template.description
    : input.description?.trim() || null;
  const normalizedVersion = input.version === undefined
    ? template.version
    : input.version?.trim() || "1.0.0";

  if (normalizedDescription && normalizedDescription.length > 500) {
    throw new HttpError(400, "模板说明不能超过 500 个字符");
  }
  if (normalizedVersion && normalizedVersion.length > 30) {
    throw new HttpError(400, "模板版本号不能超过 30 个字符");
  }

  const parameterLabels = input.parameterLabels || [];
  const templateParameterIds = new Set(template.parameters.map((parameter) => parameter.id));
  parameterLabels.forEach((parameter) => {
    const label = parameter.label.trim();
    if (!templateParameterIds.has(parameter.id)) {
      throw new HttpError(400, "参数不属于当前模板");
    }
    if (!label) {
      throw new HttpError(400, "参数名称不能为空");
    }
    if (label.length > 100) {
      throw new HttpError(400, "参数名称不能超过 100 个字符");
    }
  });

  const db = getDb();
  const updateParameter = db.prepare(
    "UPDATE template_parameters SET label = ? WHERE id = ? AND templateId = ?"
  );
  runTransaction(() => {
    db.prepare(
      `UPDATE templates
       SET description = ?, version = ?, enabled = ?, updatedAt = ?
       WHERE id = ?`
    ).run(
      normalizedDescription,
      normalizedVersion,
      input.enabled === undefined ? (template.enabled ? 1 : 0) : (input.enabled ? 1 : 0),
      nowIso(),
      id
    );
    parameterLabels.forEach((parameter) => {
      updateParameter.run(parameter.label.trim(), parameter.id, id);
    });
  });

  return getTemplate(id);
}

export function updateTemplateParseStatus(id: string, status: ParseStatus, message: string): void {
  getDb().prepare("UPDATE templates SET parseStatus = ?, parseMessage = ?, updatedAt = ? WHERE id = ?")
    .run(status, message, nowIso(), id);
}

function mapTemplateRow(row: TemplateRow): TemplateRecord {
  return {
    ...row,
    enabled: Boolean(row.enabled),
    tags: safeJsonArray(row.tags)
  };
}

function assertTemplateNameAvailable(groupId: string, name: string, excludeId?: string): void {
  const sql = `
    SELECT id FROM templates
    WHERE groupId = ? AND lower(name) = lower(?)
    ${excludeId ? "AND id <> ?" : ""}
    LIMIT 1
  `;
  const duplicate = excludeId
    ? getDb().prepare(sql).get(groupId, name, excludeId)
    : getDb().prepare(sql).get(groupId, name);
  if (duplicate) {
    throw new HttpError(409, "同一分组内不允许存在同名模板");
  }
}

function mapParameterRow(row: ParameterRow): TemplateParameter {
  return {
    ...row,
    required: Boolean(row.required),
    options: safeJsonArray(row.options)
  };
}

function safeJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function inferOutputDataType(values: Array<string | null>): string | null {
  const joined = values.filter(Boolean).join(" ").toLowerCase();
  if (joined.includes("glb") || joined.includes("gltf")) return "glTF / GLB";
  if (joined.includes("3dtiles") || joined.includes("tileset")) return "3D Tiles";
  if (joined.includes("json")) return "JSON";
  return null;
}
