import { randomUUID } from "node:crypto";
import { getDb, nowIso, runTransaction } from "../db/database";
import type { TemplateGroup } from "../types";
import { assertFound, HttpError } from "../utils/httpError";
import { removeIfExists } from "./file.service";

type GroupRow = Omit<TemplateGroup, "builtIn" | "templateCount"> & {
  builtIn: number;
  templateCount?: number;
};

export function listTemplateGroups(): TemplateGroup[] {
  const rows = getDb().prepare(
    `SELECT groups.*, COUNT(templates.id) AS templateCount
     FROM template_groups groups
     LEFT JOIN templates ON templates.groupId = groups.id
     GROUP BY groups.id
     ORDER BY CASE groups.id
       WHEN 'default' THEN 1
       WHEN 'conversion' THEN 2
       WHEN 'spatial' THEN 3
       WHEN 'quality' THEN 4
       WHEN 'publish' THEN 5
       ELSE 100
     END, groups.createdAt ASC`
  ).all() as unknown as GroupRow[];

  return rows.map(mapGroupRow);
}

export function createTemplateGroup(name: string, description?: string | null): TemplateGroup {
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new HttpError(400, "分组名称不能为空");
  }

  const db = getDb();
  const duplicate = db.prepare("SELECT id FROM template_groups WHERE name = ?").get(normalizedName);
  if (duplicate) {
    throw new HttpError(409, "分组名称已存在");
  }

  const id = randomUUID();
  const timestamp = nowIso();
  db.prepare(
    `INSERT INTO template_groups (id, name, description, builtIn, createdAt, updatedAt)
     VALUES (?, ?, ?, 0, ?, ?)`
  ).run(id, normalizedName, description?.trim() || null, timestamp, timestamp);

  return getTemplateGroup(id);
}

export function updateTemplateGroup(id: string, name: string, description?: string | null): TemplateGroup {
  getTemplateGroup(id);
  const normalizedName = name.trim();
  if (!normalizedName) {
    throw new HttpError(400, "分组名称不能为空");
  }

  const db = getDb();
  const duplicate = db.prepare("SELECT id FROM template_groups WHERE name = ? AND id <> ?")
    .get(normalizedName, id);
  if (duplicate) {
    throw new HttpError(409, "分组名称已存在");
  }

  db.prepare("UPDATE template_groups SET name = ?, description = ?, updatedAt = ? WHERE id = ?")
    .run(normalizedName, description?.trim() || null, nowIso(), id);
  return getTemplateGroup(id);
}

export function deleteTemplateGroup(id: string): void {
  if (id === "default") {
    throw new HttpError(400, "默认分组不能删除");
  }
  getTemplateGroup(id);

  const db = getDb();
  const templates = db.prepare(
    "SELECT id, filePath FROM templates WHERE groupId = ?"
  ).all(id) as unknown as Array<{ id: string; filePath: string }>;

  runTransaction(() => {
    db.prepare("DELETE FROM templates WHERE groupId = ?").run(id);
    db.prepare("DELETE FROM template_groups WHERE id = ?").run(id);
  });
  templates.forEach((template) => removeIfExists(template.filePath));
}

export function assignTemplateGroup(templateId: string, groupId: string): void {
  const db = getDb();
  const template = assertFound(
    db.prepare("SELECT id, name FROM templates WHERE id = ?").get(templateId) as
      | { id: string; name: string }
      | undefined,
    "模板不存在"
  );
  getTemplateGroup(groupId);
  const duplicate = db.prepare(
    `SELECT id FROM templates
     WHERE groupId = ? AND lower(name) = lower(?) AND id <> ?
     LIMIT 1`
  ).get(groupId, template.name, templateId);
  if (duplicate) {
    throw new HttpError(409, "目标分组已存在同名模板");
  }
  db.prepare("UPDATE templates SET groupId = ?, updatedAt = ? WHERE id = ?")
    .run(groupId, nowIso(), templateId);
}

export function getTemplateGroup(id: string): TemplateGroup {
  const row = assertFound(
    getDb().prepare(
      `SELECT groups.*, COUNT(templates.id) AS templateCount
       FROM template_groups groups
       LEFT JOIN templates ON templates.groupId = groups.id
       WHERE groups.id = ?
       GROUP BY groups.id`
    ).get(id) as GroupRow | undefined,
    "分组不存在"
  );
  return mapGroupRow(row);
}

function mapGroupRow(row: GroupRow): TemplateGroup {
  return {
    ...row,
    builtIn: Boolean(row.builtIn),
    templateCount: Number(row.templateCount || 0)
  };
}
