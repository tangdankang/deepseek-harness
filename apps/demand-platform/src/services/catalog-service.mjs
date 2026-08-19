import crypto from "node:crypto";
import { AppError } from "../domain/errors.mjs";
import { validateServiceDefinition, stableJson } from "../domain/service-definition.mjs";
import { withTransaction } from "../db.mjs";
import { OrganizationDirectoryService } from "./organization-directory-service.mjs";

function mapService(row) {
  return {
    serviceCode: row.service_code,
    serviceName: row.service_name,
    domainCode: row.domain_code,
    ownerTeam: row.owner_team,
    description: row.description,
    targetSystem: row.target_system,
    targetTicketType: row.target_ticket_type,
    riskLevel: row.risk_level,
    aiPolicy: JSON.parse(row.ai_policy_json),
    keywords: JSON.parse(row.keywords_json),
    enabled: Boolean(row.enabled),
  };
}

function audiencePolicy(row) {
  try { return JSON.parse(row.audience_policy_json); }
  catch { return { visibility: "DENY", departmentIds: [] }; }
}

function canAccess(row, employee, organizationDirectory) {
  if (!employee) return true;
  const policy = audiencePolicy(row);
  const excluded = Array.isArray(policy.excludeEmployeeIds) ? policy.excludeEmployeeIds : [];
  if (excluded.includes(employee.employeeId)) return false;
  if (policy.visibility === "ALL_EMPLOYEES") return true;
  if (policy.visibility !== "DEPARTMENTS") return false;
  const included = Array.isArray(policy.includeEmployeeIds) ? policy.includeEmployeeIds : [];
  if (included.includes(employee.employeeId)) return true;
  const departments = Array.isArray(policy.departmentIds) ? policy.departmentIds : [];
  const memberships = Array.isArray(employee.departmentIds) && employee.departmentIds.length ? employee.departmentIds : [employee.departmentId];
  if (memberships.some((departmentId) => departments.includes(departmentId))) return true;
  return policy.includeDescendants === true && memberships.some((departmentId) => organizationDirectory.isDepartmentWithin(departmentId, departments));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function governedText(value, code, message, pattern = null) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < 2 || normalized.length > 128 || pattern && !pattern.test(normalized)) throw new AppError(code, message, 422);
  return normalized;
}

function existingDefinition(row, schema) {
  return {
    serviceCode: row.service_code,
    serviceName: row.service_name,
    domainCode: row.domain_code,
    ownerTeam: row.owner_team,
    description: row.description,
    targetSystem: row.target_system,
    targetTicketType: row.target_ticket_type,
    riskLevel: row.risk_level,
    aiPolicy: JSON.parse(row.ai_policy_json),
    audiencePolicy: audiencePolicy(row),
    keywords: JSON.parse(row.keywords_json),
    enabled: Boolean(row.enabled),
    schema,
  };
}

export class CatalogService {
  constructor(db, { organizationDirectory = new OrganizationDirectoryService(db) } = {}) {
    this.db = db;
    this.organizationDirectory = organizationDirectory;
  }

  search(query = "", employee = null) {
    const normalizedQuery = String(query).trim().toLowerCase();
    const words = normalizedQuery.split(/\s+/).filter(Boolean);
    const rows = this.db.prepare("SELECT * FROM service_items WHERE enabled = 1 ORDER BY service_name").all();
    const services = rows.filter((row) => canAccess(row, employee, this.organizationDirectory)).map(mapService);
    if (words.length === 0) return services;
    return services
      .map((service) => {
        const haystack = [service.serviceCode, service.serviceName, service.description, ...service.keywords].join(" ").toLowerCase();
        const tokenScore = words.reduce((score, word) => score + (haystack.includes(word) ? 1 : 0), 0);
        const keywordScore = service.keywords.reduce((score, keyword) => score + (normalizedQuery.includes(String(keyword).toLowerCase()) ? 2 : 0), 0);
        return { service, score: tokenScore + keywordScore };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.service.serviceName.localeCompare(b.service.serviceName, "zh-CN"))
      .map((entry) => entry.service);
  }

  get(serviceCode, employee = null) {
    const row = this.db.prepare("SELECT * FROM service_items WHERE service_code = ? AND enabled = 1").get(serviceCode);
    if (!row || !canAccess(row, employee, this.organizationDirectory)) throw new AppError("SERVICE_NOT_FOUND", "服务项不存在、未启用或当前员工不可访问", 404, { serviceCode });
    return mapService(row);
  }

  getSchema(serviceCode, version = undefined, employee = null) {
    this.get(serviceCode, employee);
    const row = version === undefined
      ? this.db.prepare("SELECT * FROM service_schemas WHERE service_code = ? ORDER BY version DESC LIMIT 1").get(serviceCode)
      : this.db.prepare("SELECT * FROM service_schemas WHERE service_code = ? AND version = ?").get(serviceCode, version);
    if (!row) throw new AppError("SCHEMA_NOT_FOUND", "服务表单Schema不存在", 404, { serviceCode, version });
    return { serviceCode, version: Number(row.version), ...JSON.parse(row.schema_json) };
  }

  importDefinitions(definitions, { dryRun = false, importedBy = undefined, changeRef = undefined } = {}) {
    if (!Array.isArray(definitions) || definitions.length === 0) {
      throw new AppError("INVALID_SERVICE_CATALOG", "服务目录必须是非空数组", 422);
    }
    const normalized = definitions.map(validateServiceDefinition);
    for (const definition of normalized) {
      if (definition.audiencePolicy.includeDescendants) this.organizationDirectory.assertDepartmentsKnown(definition.audiencePolicy.departmentIds);
    }
    const serviceCodes = normalized.map((definition) => definition.serviceCode);
    if (new Set(serviceCodes).size !== serviceCodes.length) {
      throw new AppError("DUPLICATE_SERVICE_CODE", "同一导入批次不能包含重复服务编码", 422);
    }

    const operations = normalized.map((definition) => this.planImport(definition));
    if (dryRun) return { dryRun: true, operations: operations.map(({ definition, ...item }) => ({ ...item, serviceCode: definition.serviceCode })) };

    const importActor = governedText(importedBy, "INVALID_SERVICE_IMPORT_ACTOR", "正式服务目录导入必须提供2至128字符的操作人标识");
    const approvedChangeRef = governedText(changeRef, "INVALID_SERVICE_CHANGE_REF", "正式服务目录导入必须提供有效变更单号", /^[A-Za-z0-9][A-Za-z0-9._:/-]{5,127}$/);
    const timestamp = new Date().toISOString();
    withTransaction(this.db, () => {
      for (const { action, schemaAction, revision, definition } of operations) {
        if (action === "REPLAY") continue;
        this.db.prepare(`
          INSERT INTO service_items
          (service_code, service_name, domain_code, owner_team, description, target_system, target_ticket_type,
           risk_level, ai_policy_json, audience_policy_json, keywords_json, enabled, created_at, updated_at, current_revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(service_code) DO UPDATE SET
            service_name = excluded.service_name,
            domain_code = excluded.domain_code,
            owner_team = excluded.owner_team,
            description = excluded.description,
            target_system = excluded.target_system,
            target_ticket_type = excluded.target_ticket_type,
            risk_level = excluded.risk_level,
            ai_policy_json = excluded.ai_policy_json,
            audience_policy_json = excluded.audience_policy_json,
            keywords_json = excluded.keywords_json,
            enabled = excluded.enabled,
            updated_at = excluded.updated_at,
            current_revision = excluded.current_revision
        `).run(
          definition.serviceCode, definition.serviceName, definition.domainCode, definition.ownerTeam,
          definition.description, definition.targetSystem, definition.targetTicketType, definition.riskLevel,
          JSON.stringify(definition.aiPolicy), JSON.stringify(definition.audiencePolicy), JSON.stringify(definition.keywords), definition.enabled ? 1 : 0,
          timestamp, timestamp, revision,
        );
        if (schemaAction === "INSERT") {
          this.db.prepare("INSERT INTO service_schemas (service_code, version, schema_json, created_at) VALUES (?, ?, ?, ?)")
            .run(definition.serviceCode, definition.schema.version, JSON.stringify(definition.schema), timestamp);
        }
        const canonical = stableJson(definition);
        this.db.prepare(`
          INSERT INTO service_revisions
          (service_code, revision, schema_version, definition_json, definition_sha256, change_ref, imported_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(definition.serviceCode, revision, definition.schema.version, canonical, sha256(canonical), approvedChangeRef, importActor, timestamp);
      }
    });
    return {
      dryRun: false,
      operations: operations.map(({ action, schemaAction, revision, definition }) => ({
        serviceCode: definition.serviceCode,
        action,
        schemaAction,
        schemaVersion: definition.schema.version,
        revision,
      })),
    };
  }

  planImport(definition) {
    const existing = this.db.prepare("SELECT * FROM service_items WHERE service_code = ?").get(definition.serviceCode);
    const latestSchema = existing
      ? this.db.prepare("SELECT * FROM service_schemas WHERE service_code = ? ORDER BY version DESC LIMIT 1").get(definition.serviceCode)
      : null;
    if (!existing) {
      if (definition.schema.version !== 1) {
        throw new AppError("INITIAL_SCHEMA_VERSION_INVALID", "新服务的首个Schema版本必须为1", 409, { serviceCode: definition.serviceCode, version: definition.schema.version });
      }
      return { action: "CREATE", schemaAction: "INSERT", revision: 1, definition };
    }
    if (existing.target_system !== definition.targetSystem || existing.target_ticket_type !== definition.targetTicketType) {
      throw new AppError("IMMUTABLE_SERVICE_ROUTING", "已发布服务不可修改目标系统或工单类型，请创建新服务编码并迁移", 409, {
        serviceCode: definition.serviceCode,
        existing: { targetSystem: existing.target_system, targetTicketType: existing.target_ticket_type },
        requested: { targetSystem: definition.targetSystem, targetTicketType: definition.targetTicketType },
      });
    }
    const latestVersion = Number(latestSchema.version);
    if (definition.schema.version < latestVersion || definition.schema.version > latestVersion + 1) {
      throw new AppError("SCHEMA_VERSION_SEQUENCE_INVALID", "Schema版本必须等于当前版本或只递增1", 409, {
        serviceCode: definition.serviceCode,
        latestVersion,
        requestedVersion: definition.schema.version,
      });
    }
    const existingSchema = JSON.parse(latestSchema.schema_json);
    if (Number(existing.current_revision ?? 0) === 0) {
      if (definition.schema.version !== latestVersion || stableJson(existingSchema) !== stableJson(definition.schema)) {
        throw new AppError("LEGACY_SERVICE_REQUIRES_BASELINE", "旧服务首次纳入治理必须先以当前Schema建立基线，之后才能升级", 409, { serviceCode: definition.serviceCode, latestVersion, requestedVersion: definition.schema.version });
      }
      return { action: "ADOPT_LEGACY", schemaAction: "UNCHANGED", revision: 1, definition };
    }
    const currentRevision = Number(existing.current_revision);
    const persisted = this.db.prepare("SELECT definition_json FROM service_revisions WHERE service_code = ? AND revision = ?").get(definition.serviceCode, currentRevision);
    if (!persisted) throw new AppError("SERVICE_REVISION_MISSING", "服务当前修订缺少不可变历史记录，拒绝继续发布", 500, { serviceCode: definition.serviceCode, currentRevision });
    const currentCanonical = stableJson(existingDefinition(existing, existingSchema));
    if (persisted.definition_json !== currentCanonical) throw new AppError("SERVICE_CURRENT_STATE_TAMPERED", "服务当前状态与不可变修订不一致，拒绝继续发布", 500, { serviceCode: definition.serviceCode, currentRevision });
    const canonical = stableJson(definition);
    if (definition.schema.version === latestVersion) {
      if (stableJson(existingSchema) !== stableJson(definition.schema)) {
        throw new AppError("SCHEMA_VERSION_CONFLICT", "同一Schema版本的内容不可被静默覆盖，请递增版本", 409, {
          serviceCode: definition.serviceCode,
          version: latestVersion,
        });
      }
      if (persisted.definition_json === canonical) return { action: "REPLAY", schemaAction: "UNCHANGED", revision: currentRevision, definition };
      return { action: "UPDATE_METADATA", schemaAction: "UNCHANGED", revision: currentRevision + 1, definition };
    }
    return { action: "UPDATE_SCHEMA", schemaAction: "INSERT", revision: currentRevision + 1, definition };
  }
}
