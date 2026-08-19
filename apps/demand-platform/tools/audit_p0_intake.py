from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


REQUIRED = {
    "BUSINESS_SYSTEM": {
        "evidence": {
            "AUTH_SPEC",
            "CREATE_API",
            "ERROR_CODES",
            "FIELD_MAPPING",
            "IDEMPOTENCY",
            "QUERY_OR_WEBHOOK",
            "SECURITY_CLASSIFICATION",
            "STATUS_MAPPING",
            "TEST_DATA",
        },
        "contacts": {"businessOwner", "technicalOwner", "securityOwner", "operationsOwner"},
        "network": {"testBaseUrlOrAlias", "accessMethod", "allowlistOwner"},
    },
    "DEAP_TENANT": {
        "evidence": {
            "AGENT_CONFIGURATION",
            "CURRENT_TENANT_DOCS",
            "IDENTITY_CONTEXT",
            "SECURITY_SCOPE",
            "TEST_ACCOUNT_PLAN",
            "TOOL_PROTOCOL",
        },
        "contacts": {"businessOwner", "technicalOwner", "securityOwner", "tenantAdmin"},
        "network": set(),
    },
    "ORGANIZATION_DIRECTORY": {
        "evidence": {
            "HIERARCHY_RULES",
            "IDENTITY_CONTEXT",
            "MATRIX_MEMBERSHIP",
            "ORGANIZATION_TREE",
            "SECURITY_CLASSIFICATION",
            "SERVICE_AUDIENCE",
            "SYNC_SLA",
        },
        "contacts": {"businessOwner", "technicalOwner", "securityOwner", "identityOwner", "dataOwner", "operationsOwner"},
        "network": {"testSourceAlias", "accessMethod", "allowlistOwner"},
    },
    "INFRASTRUCTURE": {
        "evidence": {
            "CACHE_SPEC",
            "CAPACITY_SLO",
            "DATABASE_SPEC",
            "DEPLOYMENT_TOPOLOGY",
            "DR_REQUIREMENTS",
            "KMS_SPEC",
            "NETWORK_GATEWAY",
            "OBSERVABILITY_SPEC",
            "PLATFORM_STANDARD",
            "TASK_PLATFORM_SPEC",
        },
        "contacts": {"architectureOwner", "databaseOwner", "platformOwner", "securityOwner", "operationsOwner"},
        "network": {"testEnvironmentAlias", "accessMethod", "allowlistOwner"},
    },
}

ALLOWED_CLASSIFICATIONS = {"PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"}
SUPPORTED_EXTENSIONS = {
    ".csv", ".doc", ".docx", ".har", ".html", ".jpeg", ".jpg", ".json", ".md",
    ".pdf", ".png", ".pptx", ".txt", ".xlsx", ".yaml", ".yml", ".zip",
}
PLACEHOLDER = re.compile(r"^(?:待提供|待确认|unknown|tbd|todo|n/?a|-)?$", re.IGNORECASE)
CREDENTIAL_NAME = re.compile(r"(?:password|passwd|secret|credential|private.?key|api.?key|token|密码|密钥|凭据)", re.IGNORECASE)
PRIVATE_KEY_MARKERS = (b"-----BEGIN PRIVATE KEY-----", b"-----BEGIN RSA PRIVATE KEY-----", b"-----BEGIN OPENSSH PRIVATE KEY-----")


def finding(severity: str, code: str, message: str, path: str | None = None) -> dict:
    item = {"severity": severity, "code": code, "message": message}
    if path:
        item["path"] = path
    return item


def useful(value: object) -> bool:
    return isinstance(value, str) and not PLACEHOLDER.match(value.strip())


def safe_file(root: Path, relative_value: object) -> tuple[Path | None, str | None]:
    if not isinstance(relative_value, str) or not relative_value.strip():
        return None, "证据文件路径为空"
    normalized = relative_value.replace("\\", "/")
    relative = PurePosixPath(normalized)
    if relative.is_absolute() or ".." in relative.parts:
        return None, "证据文件路径必须是资料包内的安全相对路径"
    root_resolved = root.resolve()
    candidate = (root_resolved / Path(*relative.parts)).resolve()
    try:
        candidate.relative_to(root_resolved)
    except ValueError:
        return None, "证据文件路径越出资料包目录"
    if not candidate.is_file():
        return None, "证据文件不存在"
    return candidate, None


def stream_hash(path: Path, maximum_bytes: int) -> tuple[str, int, bytes]:
    digest = hashlib.sha256()
    total = 0
    prefix = bytearray()
    with path.open("rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > maximum_bytes:
                raise ValueError(f"文件超过允许上限 {maximum_bytes} bytes")
            digest.update(chunk)
            if len(prefix) < 1024 * 1024:
                prefix.extend(chunk[: 1024 * 1024 - len(prefix)])
    return digest.hexdigest().upper(), total, bytes(prefix)


def probe_file(path: Path, maximum_bytes: int) -> dict:
    sha256, size, prefix = stream_hash(path, maximum_bytes)
    extension = path.suffix.lower()
    result = {"readable": True, "size": size, "contentSha256": sha256, "extension": extension}
    if b"E-SafeNet" in prefix[:256] or b"LOCK" in prefix[:64] and b"E-SafeNet" in prefix:
        raise ValueError("Python读取后仍检测到SafeNet锁定字节")
    if any(marker in prefix for marker in PRIVATE_KEY_MARKERS):
        raise ValueError("文件包含私钥标记，凭据不得进入资料包")
    if extension not in SUPPORTED_EXTENSIONS:
        raise ValueError(f"不支持的文件类型 {extension or '[none]'}")

    if extension in {".docx", ".xlsx", ".pptx"}:
        expected = {".docx": "word/document.xml", ".xlsx": "xl/workbook.xml", ".pptx": "ppt/presentation.xml"}[extension]
        if not zipfile.is_zipfile(path):
            raise ValueError("Office文件无法通过Python作为ZIP读取，可能未被透明解密或文件损坏")
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            if expected not in names:
                raise ValueError(f"Office文件缺少必要条目 {expected}")
            if any(item.file_size > maximum_bytes for item in archive.infolist()):
                raise ValueError("Office文件包含超限的解压条目")
        result["officeContainer"] = "valid"
    elif extension == ".pdf" and not prefix.startswith(b"%PDF-"):
        raise ValueError("PDF文件头无效或未被透明解密")
    elif extension in {".txt", ".md", ".csv", ".yaml", ".yml", ".html", ".json", ".har"}:
        decoded = None
        for encoding in ("utf-8-sig", "gb18030", "utf-16"):
            try:
                decoded = prefix.decode(encoding)
                result["encoding"] = encoding
                break
            except UnicodeDecodeError:
                continue
        if decoded is None:
            raise ValueError("文本编码无法识别")
        if extension in {".json", ".har"} and size <= len(prefix):
            json.loads(decoded)
    elif extension == ".zip":
        if not zipfile.is_zipfile(path):
            raise ValueError("ZIP文件结构无效")
        with zipfile.ZipFile(path) as archive:
            if len(archive.infolist()) > 5000:
                raise ValueError("ZIP条目超过5000，需拆分后提供")
            if sum(item.file_size for item in archive.infolist()) > maximum_bytes * 5:
                raise ValueError("ZIP解压后总体积异常")
        result["archive"] = "valid"
    return result


def audit(folder: Path, manifest_path: Path, maximum_bytes: int = 100 * 1024 * 1024) -> dict:
    findings: list[dict] = []
    probes: list[dict] = []
    root = folder.resolve()
    if not root.is_dir():
        return {"status": "REJECTED", "findings": [finding("CRITICAL", "FOLDER_NOT_FOUND", "资料包目录不存在", str(folder))], "files": []}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except Exception as error:
        return {"status": "REJECTED", "findings": [finding("CRITICAL", "MANIFEST_INVALID", f"清单无法读取：{error}", str(manifest_path))], "files": []}

    if manifest.get("version") != 1:
        findings.append(finding("ERROR", "VERSION_UNSUPPORTED", "manifest.version必须为1"))
    package_type = str(manifest.get("packageType", ""))
    requirements = REQUIRED.get(package_type)
    if not requirements:
        findings.append(finding("ERROR", "PACKAGE_TYPE_INVALID", "packageType必须为BUSINESS_SYSTEM、DEAP_TENANT、ORGANIZATION_DIRECTORY或INFRASTRUCTURE"))
        requirements = {"evidence": set(), "contacts": set(), "network": set()}
    if not useful(manifest.get("packageId")):
        findings.append(finding("ERROR", "PACKAGE_ID_MISSING", "packageId缺失或仍为占位值"))
    if not useful(manifest.get("systemCode")):
        findings.append(finding("ERROR", "SYSTEM_CODE_MISSING", "systemCode缺失或仍为占位值"))

    contacts = manifest.get("contacts") if isinstance(manifest.get("contacts"), dict) else {}
    missing_contacts = sorted(name for name in requirements["contacts"] if not useful(contacts.get(name)))
    for name in missing_contacts:
        findings.append(finding("ERROR", "CONTACT_MISSING", f"缺少有效联系人：{name}"))
    network = manifest.get("network") if isinstance(manifest.get("network"), dict) else {}
    missing_network = sorted(name for name in requirements["network"] if not useful(network.get(name)))
    for name in missing_network:
        findings.append(finding("ERROR", "NETWORK_INFO_MISSING", f"缺少测试网络信息：{name}"))

    evidence = manifest.get("evidence")
    if not isinstance(evidence, list):
        findings.append(finding("ERROR", "EVIDENCE_INVALID", "evidence必须为数组"))
        evidence = []
    categories = set()
    seen_paths = set()
    for index, entry in enumerate(evidence):
        label = f"evidence[{index}]"
        if not isinstance(entry, dict):
            findings.append(finding("ERROR", "EVIDENCE_ENTRY_INVALID", f"{label}必须为对象"))
            continue
        category = str(entry.get("category", "")).upper()
        if category:
            categories.add(category)
        else:
            findings.append(finding("ERROR", "EVIDENCE_CATEGORY_MISSING", f"{label}缺少category"))
        classification = str(entry.get("classification", "")).upper()
        if classification not in ALLOWED_CLASSIFICATIONS:
            findings.append(finding("ERROR", "CLASSIFICATION_INVALID", f"{label}.classification无效"))
        if entry.get("containsCredential") is not False:
            findings.append(finding("CRITICAL", "CREDENTIAL_ATTESTATION_FAILED", f"{label}必须明确containsCredential=false；凭据不得进入资料包"))
        relative_path = entry.get("path")
        candidate, path_error = safe_file(root, relative_path)
        if path_error:
            findings.append(finding("ERROR", "EVIDENCE_FILE_INVALID", path_error, str(relative_path or label)))
            continue
        normalized_path = candidate.relative_to(root).as_posix()
        if normalized_path in seen_paths:
            findings.append(finding("WARNING", "EVIDENCE_FILE_REUSED", "同一文件被多个证据类别引用", normalized_path))
        seen_paths.add(normalized_path)
        if CREDENTIAL_NAME.search(candidate.name):
            findings.append(finding("WARNING", "POTENTIAL_CREDENTIAL_FILENAME", "文件名含凭据相关词，请再次确认内容已脱敏", normalized_path))
        try:
            probe = probe_file(candidate, maximum_bytes)
            probe.update({"path": normalized_path, "category": category, "classification": classification})
            expected_hash = str(entry.get("sha256", "")).strip().upper()
            if expected_hash:
                if not re.fullmatch(r"[A-F0-9]{64}", expected_hash):
                    findings.append(finding("ERROR", "SHA256_FORMAT_INVALID", "sha256格式无效", normalized_path))
                elif expected_hash != probe["contentSha256"]:
                    findings.append(finding("CRITICAL", "SHA256_MISMATCH", "文件内容哈希与清单不一致", normalized_path))
            probes.append(probe)
        except Exception as error:
            findings.append(finding("CRITICAL", "FILE_UNREADABLE", str(error), normalized_path))

    missing_categories = sorted(requirements["evidence"] - categories)
    for category in missing_categories:
        findings.append(finding("ERROR", "EVIDENCE_MISSING", f"缺少必需证据类别：{category}"))
    severities = {item["severity"] for item in findings}
    status = "REJECTED" if "CRITICAL" in severities else "NOT_READY" if "ERROR" in severities else "READY"
    return {
        "status": status,
        "packageId": manifest.get("packageId"),
        "packageType": package_type,
        "systemCode": manifest.get("systemCode"),
        "summary": {
            "requiredEvidence": len(requirements["evidence"]),
            "providedCategories": len(categories & requirements["evidence"]),
            "readableFiles": len(probes),
            "findings": len(findings),
        },
        "missingEvidence": missing_categories,
        "missingContacts": missing_contacts,
        "missingNetwork": missing_network,
        "findings": findings,
        "files": probes,
        "hashScope": "Python白名单读取到的逻辑文件内容；不会持久化完整明文副本",
    }


def markdown(report: dict) -> str:
    lines = [
        "# P0 真实接入资料包检查报告",
        "",
        f"- 状态：`{report.get('status', 'REJECTED')}`",
        f"- 资料包：`{report.get('packageId') or '-'}`",
        f"- 类型：`{report.get('packageType') or '-'}`",
        f"- 系统：`{report.get('systemCode') or '-'}`",
        f"- 可读文件：{report.get('summary', {}).get('readableFiles', 0)}",
        "",
        "## 缺口",
        "",
    ]
    missing = report.get("missingEvidence", []) + report.get("missingContacts", []) + report.get("missingNetwork", [])
    lines.extend([f"- {item}" for item in missing] or ["- 无结构化缺口"])
    lines.extend(["", "## 发现", ""])
    for item in report.get("findings", []):
        suffix = f"（{item['path']}）" if item.get("path") else ""
        lines.append(f"- [{item['severity']}] `{item['code']}`：{item['message']}{suffix}")
    if not report.get("findings"):
        lines.append("- 无")
    lines.extend(["", "## 文件指纹", ""])
    for item in report.get("files", []):
        lines.append(f"- `{item['path']}`：{item['size']} bytes，SHA-256 `{item['contentSha256']}`")
    if not report.get("files"):
        lines.append("- 无")
    lines.extend(["", f"> 哈希口径：{report.get('hashScope', '-')}", ""])
    return "\n".join(lines)


def self_test() -> dict:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        evidence_file = root / "脱敏接口说明.txt"
        evidence_file.write_text("仅用于自检，不含凭据。", encoding="utf-8")
        evidence = [
            {"category": category, "path": evidence_file.name, "classification": "INTERNAL", "containsCredential": False}
            for category in sorted(REQUIRED["BUSINESS_SYSTEM"]["evidence"])
        ]
        manifest = {
            "version": 1,
            "packageId": "P0-SELF-TEST",
            "packageType": "BUSINESS_SYSTEM",
            "systemCode": "TEST",
            "contacts": {name: f"owner-{name}" for name in REQUIRED["BUSINESS_SYSTEM"]["contacts"]},
            "network": {name: f"value-{name}" for name in REQUIRED["BUSINESS_SYSTEM"]["network"]},
            "evidence": evidence,
        }
        manifest_path = root / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        ready = audit(root, manifest_path)
        manifest["evidence"][0]["containsCredential"] = True
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        rejected = audit(root, manifest_path)
        manifest["evidence"] = manifest["evidence"][:-1]
        manifest["evidence"][0]["containsCredential"] = False
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        not_ready = audit(root, manifest_path)

        deap_manifest = {
            "version": 1,
            "packageId": "P0-DEAP-SELF-TEST",
            "packageType": "DEAP_TENANT",
            "systemCode": "DEAP",
            "contacts": {name: f"owner-{name}" for name in REQUIRED["DEAP_TENANT"]["contacts"]},
            "evidence": [
                {"category": category, "path": evidence_file.name, "classification": "INTERNAL", "containsCredential": False}
                for category in sorted(REQUIRED["DEAP_TENANT"]["evidence"])
            ],
        }
        manifest_path.write_text(json.dumps(deap_manifest, ensure_ascii=False), encoding="utf-8")
        deap_ready = audit(root, manifest_path)

        additional_ready = {}
        for package_type, system_code in (("ORGANIZATION_DIRECTORY", "ORG"), ("INFRASTRUCTURE", "PLATFORM")):
            definition = REQUIRED[package_type]
            extra_manifest = {
                "version": 1,
                "packageId": f"P0-{package_type}-SELF-TEST",
                "packageType": package_type,
                "systemCode": system_code,
                "contacts": {name: f"owner-{name}" for name in definition["contacts"]},
                "network": {name: f"value-{name}" for name in definition["network"]},
                "evidence": [
                    {"category": category, "path": evidence_file.name, "classification": "INTERNAL", "containsCredential": False}
                    for category in sorted(definition["evidence"])
                ],
            }
            manifest_path.write_text(json.dumps(extra_manifest, ensure_ascii=False), encoding="utf-8")
            additional_ready[package_type] = audit(root, manifest_path)

        office_expected = {
            "sample.docx": "word/document.xml",
            "sample.xlsx": "xl/workbook.xml",
            "sample.pptx": "ppt/presentation.xml",
        }
        office_valid = True
        for filename, member in office_expected.items():
            office_path = root / filename
            with zipfile.ZipFile(office_path, "w") as archive:
                archive.writestr(member, "<root/>")
            try:
                office_valid = office_valid and probe_file(office_path, 1024 * 1024).get("officeContainer") == "valid"
            except Exception:
                office_valid = False

        locked_path = root / "locked.txt"
        locked_path.write_bytes(b"\x00E-SafeNet\x00LOCK\x00encrypted-payload")
        locked_rejected = False
        try:
            probe_file(locked_path, 1024 * 1024)
        except ValueError:
            locked_rejected = True

        passed = (
            ready["status"] == "READY"
            and deap_ready["status"] == "READY"
            and all(item["status"] == "READY" for item in additional_ready.values())
            and rejected["status"] == "REJECTED"
            and not_ready["status"] == "NOT_READY"
            and office_valid
            and locked_rejected
        )
        return {
            "selfTest": "PASS" if passed else "FAIL",
            "businessReady": ready["status"],
            "deapReady": deap_ready["status"],
            "organizationReady": additional_ready["ORGANIZATION_DIRECTORY"]["status"],
            "infrastructureReady": additional_ready["INFRASTRUCTURE"]["status"],
            "rejected": rejected["status"],
            "notReady": not_ready["status"],
            "officeContainers": "PASS" if office_valid else "FAIL",
            "lockedRejected": locked_rejected,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="检查钉钉/DEAP、组织目录、基础设施或业务系统P0真实接入资料包")
    parser.add_argument("--folder", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--format", choices=("json", "markdown"), default="markdown")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--max-file-mb", type=int, default=100)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        result = self_test()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["selfTest"] == "PASS" else 1
    if not args.folder or not args.manifest:
        parser.error("--folder和--manifest为必填参数")
    report = audit(args.folder, args.manifest, max(1, args.max_file_mb) * 1024 * 1024)
    content = json.dumps(report, ensure_ascii=False, indent=2) if args.format == "json" else markdown(report)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content, encoding="utf-8")
    else:
        print(content)
    return {"READY": 0, "NOT_READY": 2, "REJECTED": 3}.get(report["status"], 3)


if __name__ == "__main__":
    raise SystemExit(main())
