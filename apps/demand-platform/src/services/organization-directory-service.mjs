import crypto from "node:crypto";
import { AppError } from "../domain/errors.mjs";
import { stableJson, validateOrganizationSnapshot } from "../domain/organization-definition.mjs";
import { withTransaction } from "../db.mjs";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function governedText(value, code, message, pattern = null) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length < 2 || normalized.length > 128 || pattern && !pattern.test(normalized)) throw new AppError(code, message, 422);
  return normalized;
}

export class OrganizationDirectoryService {
  constructor(db, { now = () => Date.now() } = {}) {
    this.db = db;
    this.now = now;
    this.cachedVersion = null;
    this.cached = null;
  }

  latest({ requireFresh = false } = {}) {
    const row = this.db.prepare("SELECT * FROM organization_snapshots ORDER BY version DESC LIMIT 1").get();
    if (!row) {
      if (requireFresh) throw new AppError("ORGANIZATION_DIRECTORY_UNAVAILABLE", "尚未发布组织目录，不能启用部门子树授权", 409);
      return null;
    }
    let snapshot;
    if (this.cachedVersion === Number(row.version)) snapshot = this.cached;
    else {
      const canonical = String(row.definition_json);
      if (sha256(canonical) !== row.definition_sha256) throw new AppError("ORGANIZATION_SNAPSHOT_TAMPERED", "组织目录快照哈希不一致", 500, { version: Number(row.version) });
      snapshot = JSON.parse(canonical);
      this.cachedVersion = Number(row.version);
      this.cached = snapshot;
    }
    const fresh = Date.parse(snapshot.expiresAt) > this.now();
    if (requireFresh && !fresh) throw new AppError("ORGANIZATION_DIRECTORY_STALE", "组织目录已过期，部门子树授权默认拒绝", 409, { version: snapshot.version, expiresAt: snapshot.expiresAt });
    return { snapshot, fresh };
  }

  assertDepartmentsKnown(departmentIds) {
    if (!Array.isArray(departmentIds) || departmentIds.length === 0) return;
    const { snapshot } = this.latest({ requireFresh: true });
    const known = new Set(snapshot.departments.map((item) => item.departmentId));
    const unknown = departmentIds.filter((departmentId) => !known.has(departmentId));
    if (unknown.length) throw new AppError("UNKNOWN_AUDIENCE_DEPARTMENT", "服务受众引用了组织目录中不存在的部门", 409, { departmentIds: unknown, organizationVersion: snapshot.version });
  }

  isDepartmentWithin(employeeDepartmentId, rootDepartmentIds) {
    if (rootDepartmentIds.includes(employeeDepartmentId)) return true;
    let current;
    try { current = this.latest({ requireFresh: true }); }
    catch (error) {
      if (["ORGANIZATION_DIRECTORY_UNAVAILABLE", "ORGANIZATION_DIRECTORY_STALE"].includes(error.code)) return false;
      throw error;
    }
    const byId = new Map(current.snapshot.departments.map((item) => [item.departmentId, item.parentDepartmentId]));
    if (!byId.has(employeeDepartmentId)) return false;
    const roots = new Set(rootDepartmentIds);
    let parent = byId.get(employeeDepartmentId);
    const visited = new Set([employeeDepartmentId]);
    while (parent) {
      if (roots.has(parent)) return true;
      if (visited.has(parent)) return false;
      visited.add(parent);
      parent = byId.get(parent);
    }
    return false;
  }

  status() {
    const requiredByServices = this.db.prepare("SELECT audience_policy_json FROM service_items WHERE enabled = 1").all()
      .reduce((count, row) => {
        try { return count + (JSON.parse(row.audience_policy_json)?.includeDescendants === true ? 1 : 0); }
        catch { return count; }
      }, 0);
    let current;
    try { current = this.latest(); }
    catch (error) {
      return { readiness: requiredByServices > 0 ? "not_ready" : "not_required", requiredByServices, state: "TAMPERED", errorCode: error.code ?? "ORGANIZATION_DIRECTORY_ERROR" };
    }
    if (!current) return { readiness: requiredByServices > 0 ? "not_ready" : "not_required", requiredByServices, state: "UNAVAILABLE", version: null, expiresAt: null };
    return {
      readiness: requiredByServices > 0 && !current.fresh ? "not_ready" : requiredByServices > 0 ? "ready" : "not_required",
      requiredByServices,
      state: current.fresh ? "FRESH" : "STALE",
      version: current.snapshot.version,
      sourceSystem: current.snapshot.sourceSystem,
      departmentCount: current.snapshot.departments.length,
      generatedAt: current.snapshot.generatedAt,
      expiresAt: current.snapshot.expiresAt,
    };
  }

  importSnapshot(input, { dryRun = false, importedBy, changeRef } = {}) {
    const snapshot = validateOrganizationSnapshot(input);
    const canonical = stableJson(snapshot);
    const digest = sha256(canonical);
    const current = this.db.prepare("SELECT * FROM organization_snapshots ORDER BY version DESC LIMIT 1").get();
    let action = "CREATE";
    if (current) {
      const currentVersion = Number(current.version);
      if (snapshot.version === currentVersion && current.definition_sha256 === digest && current.definition_json === canonical) action = "REPLAY";
      else if (snapshot.version === currentVersion) throw new AppError("ORGANIZATION_VERSION_CONFLICT", "同一组织目录版本内容不可覆盖", 409, { version: snapshot.version });
      else if (snapshot.version !== currentVersion + 1) throw new AppError("ORGANIZATION_VERSION_SEQUENCE_INVALID", "组织目录版本必须只递增1", 409, { currentVersion, requestedVersion: snapshot.version });
      else action = "UPDATE";
    } else if (snapshot.version !== 1) throw new AppError("INITIAL_ORGANIZATION_VERSION_INVALID", "首个组织目录版本必须为1", 409);
    if (dryRun) return { dryRun: true, action, version: snapshot.version, departmentCount: snapshot.departments.length, definitionSha256: digest };
    if (Date.parse(snapshot.generatedAt) > this.now() + 5 * 60_000) throw new AppError("ORGANIZATION_GENERATED_AT_INVALID", "组织目录生成时间不能位于未来", 422);
    if (Date.parse(snapshot.expiresAt) <= this.now()) throw new AppError("ORGANIZATION_SNAPSHOT_STALE", "不能发布已过期的组织目录", 422);
    const actor = governedText(importedBy, "INVALID_ORGANIZATION_IMPORT_ACTOR", "正式组织目录导入必须提供操作人标识");
    const approvedChangeRef = governedText(changeRef, "INVALID_ORGANIZATION_CHANGE_REF", "正式组织目录导入必须提供有效变更单号", /^[A-Za-z0-9][A-Za-z0-9._:/-]{5,127}$/);
    if (action !== "REPLAY") withTransaction(this.db, () => {
      this.db.prepare(`
        INSERT INTO organization_snapshots
        (version, source_system, generated_at, expires_at, department_count, definition_json, definition_sha256, change_ref, imported_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(snapshot.version, snapshot.sourceSystem, snapshot.generatedAt, snapshot.expiresAt, snapshot.departments.length, canonical, digest, approvedChangeRef, actor, new Date(this.now()).toISOString());
    });
    this.cachedVersion = null;
    this.cached = null;
    return { dryRun: false, action, version: snapshot.version, departmentCount: snapshot.departments.length, definitionSha256: digest };
  }
}
