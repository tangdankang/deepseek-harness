import crypto from "node:crypto";
import { AppError } from "../domain/errors.mjs";
import { stableKnowledgeJson, validateKnowledgeDefinition } from "../domain/knowledge-definition.mjs";
import { withTransaction } from "../db.mjs";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function actor(value) {
  if (typeof value !== "string" || value.trim().length < 2 || value.trim().length > 120) {
    throw new AppError("INVALID_KNOWLEDGE_IMPORT_ACTOR", "正式知识导入必须提供2至120字符的操作人标识", 422);
  }
  return value.trim();
}

export class KnowledgeService {
  constructor(db, { now = () => new Date() } = {}) {
    this.db = db;
    this.now = now;
  }

  search(message, employee) {
    const normalized = String(message).trim().toLowerCase();
    if (!normalized) return null;
    const now = this.now().toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM knowledge_items
      WHERE enabled = 1 AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY knowledge_id
    `).all(now);
    let best = null;
    for (const row of rows) {
      const allowed = JSON.parse(row.allowed_departments_json);
      const departmentIds = (Array.isArray(employee.departmentIds) && employee.departmentIds.length ? employee.departmentIds : [employee.departmentId]).map((item) => String(item ?? "").toUpperCase());
      if (!allowed.includes("*") && !allowed.map((item) => String(item).toUpperCase()).some((departmentId) => departmentIds.includes(departmentId))) continue;
      const patterns = JSON.parse(row.patterns_json);
      const score = patterns.reduce((total, pattern) => total + (normalized.includes(pattern.toLowerCase()) ? pattern.length : 0), 0);
      if (score > 0 && (!best || score > best.score || score === best.score && row.knowledge_id < best.row.knowledge_id)) best = { row, score };
    }
    if (!best) return null;
    return {
      knowledgeId: best.row.knowledge_id,
      version: Number(best.row.current_version ?? 1),
      answer: best.row.answer,
      citations: [{
        title: best.row.source_title,
        url: best.row.source_url,
        reviewedAt: best.row.reviewed_at ?? best.row.updated_at,
        expiresAt: best.row.expires_at ?? null,
        contentSha256: best.row.source_content_sha256 ?? null,
      }],
    };
  }

  importDefinitions(definitions, { dryRun = false, importedBy = undefined } = {}) {
    if (!Array.isArray(definitions) || definitions.length === 0) {
      throw new AppError("INVALID_KNOWLEDGE_CATALOG", "知识目录必须是非空数组", 422);
    }
    const normalized = definitions.map(validateKnowledgeDefinition);
    const importTime = this.now();
    const maximumReviewTime = importTime.getTime() + 5 * 60 * 1000;
    for (const definition of normalized) {
      if (Date.parse(definition.source.reviewedAt) > maximumReviewTime) {
        throw new AppError("KNOWLEDGE_REVIEW_TIME_IN_FUTURE", "知识来源审阅时间不能晚于当前时间", 422, { knowledgeId: definition.knowledgeId });
      }
    }
    const ids = normalized.map((item) => item.knowledgeId);
    if (new Set(ids).size !== ids.length) throw new AppError("DUPLICATE_KNOWLEDGE_ID", "同一导入批次不能包含重复知识编码", 422);
    const operations = normalized.map((definition) => this.planImport(definition));
    if (dryRun) return { dryRun: true, operations: operations.map(({ definition, ...item }) => ({ ...item, knowledgeId: definition.knowledgeId })) };

    const importActor = actor(importedBy);
    const timestamp = importTime.toISOString();
    withTransaction(this.db, () => {
      for (const operation of operations) {
        if (operation.action === "REPLAY") continue;
        const { definition } = operation;
        if (operation.action === "CREATE") {
          this.db.prepare(`
            INSERT INTO knowledge_items
            (knowledge_id, title, patterns_json, answer, source_title, source_url, allowed_departments_json,
             enabled, updated_at, current_version, owner_team, source_content_sha256, reviewed_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            definition.knowledgeId, definition.title, JSON.stringify(definition.patterns), definition.answer,
            definition.source.title, definition.source.url, JSON.stringify(definition.allowedDepartments),
            definition.enabled ? 1 : 0, timestamp, definition.version, definition.ownerTeam,
            definition.source.contentSha256, definition.source.reviewedAt, definition.expiresAt,
          );
        } else {
          this.db.prepare(`
            UPDATE knowledge_items SET
              title = ?, patterns_json = ?, answer = ?, source_title = ?, source_url = ?,
              allowed_departments_json = ?, enabled = ?, updated_at = ?, current_version = ?, owner_team = ?,
              source_content_sha256 = ?, reviewed_at = ?, expires_at = ?
            WHERE knowledge_id = ?
          `).run(
            definition.title, JSON.stringify(definition.patterns), definition.answer,
            definition.source.title, definition.source.url, JSON.stringify(definition.allowedDepartments),
            definition.enabled ? 1 : 0, timestamp, definition.version, definition.ownerTeam,
            definition.source.contentSha256, definition.source.reviewedAt, definition.expiresAt, definition.knowledgeId,
          );
        }
        const canonical = stableKnowledgeJson(definition);
        this.db.prepare(`
          INSERT INTO knowledge_revisions
          (knowledge_id, version, definition_json, definition_sha256, source_content_sha256, change_ref, imported_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          definition.knowledgeId, definition.version, canonical, sha256(canonical),
          definition.source.contentSha256, definition.changeRef, importActor, timestamp,
        );
      }
    });
    return {
      dryRun: false,
      operations: operations.map(({ definition, ...item }) => ({ ...item, knowledgeId: definition.knowledgeId })),
    };
  }

  planImport(definition) {
    const existing = this.db.prepare("SELECT knowledge_id, current_version FROM knowledge_items WHERE knowledge_id = ?").get(definition.knowledgeId);
    if (!existing) {
      if (definition.version !== 1) {
        throw new AppError("INITIAL_KNOWLEDGE_VERSION_INVALID", "新知识的首个版本必须为1", 409, { knowledgeId: definition.knowledgeId, version: definition.version });
      }
      return { action: "CREATE", version: definition.version, definition };
    }
    const currentVersion = Number(existing.current_version ?? 1);
    const revision = this.db.prepare("SELECT definition_json FROM knowledge_revisions WHERE knowledge_id = ? AND version = ?")
      .get(definition.knowledgeId, currentVersion);
    if (!revision) {
      if (definition.version <= currentVersion) {
        throw new AppError("LEGACY_KNOWLEDGE_REQUIRES_VERSION_BUMP", "旧知识首次纳入治理时必须递增版本，不能覆盖未留存的历史内容", 409, {
          knowledgeId: definition.knowledgeId, currentVersion, requestedVersion: definition.version,
        });
      }
    }
    if (definition.version < currentVersion || definition.version > currentVersion + 1) {
      throw new AppError("KNOWLEDGE_VERSION_SEQUENCE_INVALID", "知识版本必须等于当前版本或只递增1", 409, {
        knowledgeId: definition.knowledgeId, currentVersion, requestedVersion: definition.version,
      });
    }
    if (definition.version === currentVersion) {
      if (revision.definition_json !== stableKnowledgeJson(definition)) {
        throw new AppError("KNOWLEDGE_VERSION_CONFLICT", "同一知识版本不可被静默覆盖，请递增版本", 409, {
          knowledgeId: definition.knowledgeId, version: currentVersion,
        });
      }
      return { action: "REPLAY", version: definition.version, definition };
    }
    return { action: "UPDATE", version: definition.version, definition };
  }
}
