from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import re
import sys
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


SUPPORTED = {".docx", ".xlsx", ".pptx", ".txt", ".md", ".csv", ".json", ".pdf", ".doc"}
CLASSIFICATIONS = {"PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"}
SAFENET_MARKERS = (b"E-SafeNet", b"\x00LOCK\x00")
PRIVATE_KEY_MARKERS = (
    b"-----BEGIN PRIVATE KEY-----",
    b"-----BEGIN RSA PRIVATE KEY-----",
    b"-----BEGIN OPENSSH PRIVATE KEY-----",
)
LIKELY_SECRET = re.compile(
    r"(?i)\b(password|passwd|secret|token|api[_-]?key|client[_-]?secret|密码|密钥|令牌)\b"
    r"(\s*[:=：]\s*)([^\s,，;；]{8,})"
)
REFERENCE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{5,127}$")


class DraftError(ValueError):
    pass


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest().upper()


def required_text(value: object, name: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
        raise DraftError(f"{name}必须是1至{maximum}个字符的文本")
    return value.strip()


def safe_https_url(value: str) -> str:
    normalized = required_text(value, "source-url", 1000)
    parsed = urlsplit(normalized)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise DraftError("source-url必须使用HTTPS且不得内嵌凭据")
    sensitive_query = re.compile(r"(?i)(?:token|secret|password|signature|api[_-]?key|access[_-]?key)")
    if any(sensitive_query.search(key) for key, _ in parse_qsl(parsed.query, keep_blank_values=True)):
        raise DraftError("source-url查询参数包含疑似凭据字段")
    return normalized


def read_source(path: Path, maximum_bytes: int) -> bytes:
    if not path.is_file():
        raise DraftError("来源文件不存在或不是普通文件")
    size = path.stat().st_size
    if size < 1 or size > maximum_bytes:
        raise DraftError(f"来源文件大小必须为1至{maximum_bytes} bytes")
    data = path.read_bytes()
    if any(marker in data[:4096] for marker in SAFENET_MARKERS):
        raise DraftError("Python读取后仍检测到SafeNet锁定字节，未取得逻辑明文")
    if any(marker in data for marker in PRIVATE_KEY_MARKERS):
        raise DraftError("来源包含私钥标记，拒绝生成知识草稿")
    return data


def office_archive(data: bytes, maximum_bytes: int) -> zipfile.ZipFile:
    source = io.BytesIO(data)
    if not zipfile.is_zipfile(source):
        raise DraftError("Office文件无法作为ZIP读取，可能未被透明解密或文件损坏")
    source.seek(0)
    archive = zipfile.ZipFile(source)
    entries = archive.infolist()
    if len(entries) > 5000:
        archive.close()
        raise DraftError("Office文件条目超过5000")
    total = sum(item.file_size for item in entries)
    if total > maximum_bytes * 10 or any(item.file_size > maximum_bytes for item in entries):
        archive.close()
        raise DraftError("Office文件解压体积超过安全上限")
    return archive


def xml_root(archive: zipfile.ZipFile, name: str) -> ET.Element:
    try:
        with archive.open(name) as source:
            return ET.parse(source).getroot()
    except KeyError as error:
        raise DraftError(f"Office文件缺少必要条目{name}") from error
    except ET.ParseError as error:
        raise DraftError(f"Office XML损坏：{name}") from error


def extract_docx(data: bytes, maximum_bytes: int) -> list[tuple[str, str]]:
    with office_archive(data, maximum_bytes) as archive:
        root = xml_root(archive, "word/document.xml")
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    result = []
    for index, paragraph in enumerate(root.iter(f"{namespace}p"), 1):
        text = "".join(node.text or "" for node in paragraph.iter(f"{namespace}t")).strip()
        if text:
            result.append((f"word/document.xml#paragraph-{index}", text))
    return result


def extract_xlsx(data: bytes, maximum_bytes: int) -> list[tuple[str, str]]:
    namespace = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    with office_archive(data, maximum_bytes) as archive:
        names = set(archive.namelist())
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            root = xml_root(archive, "xl/sharedStrings.xml")
            for item in root.iter(f"{namespace}si"):
                shared.append("".join(node.text or "" for node in item.iter(f"{namespace}t")))
        sheets = sorted(
            (name for name in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)),
            key=lambda value: int(re.search(r"(\d+)", Path(value).stem).group(1)),
        )
        result = []
        for sheet in sheets:
            root = xml_root(archive, sheet)
            for cell in root.iter(f"{namespace}c"):
                reference = cell.attrib.get("r", "UNKNOWN")
                cell_type = cell.attrib.get("t")
                value_node = cell.find(f"{namespace}v")
                if cell_type == "inlineStr":
                    text = "".join(node.text or "" for node in cell.iter(f"{namespace}t"))
                elif value_node is None or value_node.text is None:
                    continue
                elif cell_type == "s":
                    try:
                        text = shared[int(value_node.text)]
                    except (ValueError, IndexError):
                        text = value_node.text
                else:
                    text = value_node.text
                if str(text).strip():
                    result.append((f"{sheet}!{reference}", str(text).strip()))
    return result


def extract_pptx(data: bytes, maximum_bytes: int) -> list[tuple[str, str]]:
    namespace = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
    with office_archive(data, maximum_bytes) as archive:
        slides = sorted(
            (name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
            key=lambda value: int(re.search(r"(\d+)", Path(value).stem).group(1)),
        )
        result = []
        for slide in slides:
            root = xml_root(archive, slide)
            for index, node in enumerate(root.iter(f"{namespace}t"), 1):
                if node.text and node.text.strip():
                    result.append((f"{slide}#text-{index}", node.text.strip()))
    return result


def decode_text(data: bytes) -> tuple[str, str]:
    for encoding in ("utf-8-sig", "gb18030", "utf-16"):
        try:
            return data.decode(encoding), encoding
        except UnicodeDecodeError:
            continue
    raise DraftError("文本文件编码无法识别")


def extract_text(data: bytes) -> tuple[list[tuple[str, str]], str]:
    text, encoding = decode_text(data)
    return [(f"line-{index}", line.strip()) for index, line in enumerate(text.splitlines(), 1) if line.strip()], encoding


def pdf_literals(data: bytes) -> list[tuple[str, str]]:
    if not data.startswith(b"%PDF-"):
        raise DraftError("PDF文件头无效或未被透明解密")
    text = data.decode("latin-1", errors="ignore")
    result = []
    for index, match in enumerate(re.finditer(r"\((?:\\.|[^\\()])*\)", text), 1):
        value = match.group(0)[1:-1]
        value = re.sub(r"\\([()\\])", r"\1", value)
        value = re.sub(r"\\([0-7]{1,3})", lambda item: chr(int(item.group(1), 8)), value)
        if len(value.strip()) >= 2 and any(character.isalnum() for character in value):
            result.append((f"pdf-literal-{index}", value.strip()))
    return result


def extract_doc(data: bytes) -> list[tuple[str, str]]:
    candidates = []
    for encoding in ("utf-16-le", "gb18030", "utf-8"):
        text = data.decode(encoding, errors="ignore")
        lines = [line.strip("\x00 \t\r") for line in re.split(r"[\n\x00]{1,}", text) if len(line.strip("\x00 \t\r")) >= 4]
        score = sum(character.isalnum() or "\u4e00" <= character <= "\u9fff" for character in "".join(lines))
        candidates.append((score, lines))
    lines = max(candidates, key=lambda item: item[0])[1]
    return [(f"binary-fragment-{index}", line) for index, line in enumerate(lines, 1)]


def normalize_fragment(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def redact_likely_secrets(fragments: list[tuple[str, str]]) -> tuple[list[tuple[str, str]], int]:
    redacted = []
    count = 0
    for location, text in fragments:
        def replace(match: re.Match[str]) -> str:
            nonlocal count
            count += 1
            return f"{match.group(1)}{match.group(2)}[REDACTED]"
        redacted.append((location, LIKELY_SECRET.sub(replace, normalize_fragment(text))))
    return [(location, text) for location, text in redacted if text], count


def chunk_fragments(fragments: list[tuple[str, str]], source_hash: str, maximum_chars: int, chunk_chars: int) -> list[dict]:
    total = sum(len(text) for _, text in fragments)
    if total > maximum_chars:
        raise DraftError(f"提取文本超过允许上限{maximum_chars}字符，请拆分来源文件")
    expanded: list[tuple[str, str]] = []
    for location, text in fragments:
        for offset in range(0, len(text), chunk_chars):
            part = text[offset:offset + chunk_chars]
            suffix = "" if offset == 0 and len(text) <= chunk_chars else f"@{offset}"
            expanded.append((f"{location}{suffix}", part))
    chunks = []
    locations: list[str] = []
    texts: list[str] = []
    size = 0
    for location, text in expanded:
        separator = 1 if texts else 0
        if texts and size + separator + len(text) > chunk_chars:
            chunks.append((locations, "\n".join(texts)))
            locations, texts, size = [], [], 0
        locations.append(location)
        texts.append(text)
        size += (1 if size else 0) + len(text)
    if texts:
        chunks.append((locations, "\n".join(texts)))
    result = []
    for index, (chunk_locations, text) in enumerate(chunks, 1):
        digest = sha256_bytes(text.encode("utf-8"))
        chunk_id = hashlib.sha256(f"{source_hash}:{index}:{digest}".encode("utf-8")).hexdigest()[:24].upper()
        result.append({"chunkId": chunk_id, "sequence": index, "locations": chunk_locations, "text": text, "charCount": len(text), "textSha256": digest})
    return result


def build_draft(
    source: Path,
    *,
    source_url: str,
    owner_team: str,
    allowed_departments: list[str],
    classification: str,
    prepared_by: str,
    intake_ref: str,
    maximum_bytes: int = 100 * 1024 * 1024,
    maximum_chars: int = 2_000_000,
    chunk_chars: int = 1600,
) -> dict:
    extension = source.suffix.lower()
    if extension not in SUPPORTED:
        raise DraftError(f"不支持的文件类型{extension or '[none]'}")
    source_data = read_source(source, maximum_bytes)
    source_hash = sha256_bytes(source_data)
    encoding = None
    extraction_quality = "STANDARD"
    if extension == ".docx":
        fragments = extract_docx(source_data, maximum_bytes)
        method = "PYTHON_ZIPFILE_DOCX_XML"
    elif extension == ".xlsx":
        fragments = extract_xlsx(source_data, maximum_bytes)
        method = "PYTHON_ZIPFILE_XLSX_XML"
    elif extension == ".pptx":
        fragments = extract_pptx(source_data, maximum_bytes)
        method = "PYTHON_ZIPFILE_PPTX_XML"
    elif extension in {".txt", ".md", ".csv", ".json"}:
        fragments, encoding = extract_text(source_data)
        method = "PYTHON_TEXT_DECODE"
    elif extension == ".pdf":
        fragments = pdf_literals(source_data)
        method = "PYTHON_PDF_LITERAL_SCAN"
        extraction_quality = "LIMITED_MANUAL_COMPARISON_REQUIRED"
    else:
        fragments = extract_doc(source_data)
        method = "PYTHON_BINARY_TEXT_HEURISTIC"
        extraction_quality = "LIMITED_MANUAL_COMPARISON_REQUIRED"
    fragments, redaction_count = redact_likely_secrets(fragments)
    if not fragments:
        raise DraftError("未提取到可供审阅的文本")
    chunks = chunk_fragments(fragments, source_hash, maximum_chars, chunk_chars)
    departments = [required_text(item, "allowed-department", 100).upper() if item != "*" else "*" for item in allowed_departments]
    if not departments or len(set(departments)) != len(departments) or "*" in departments and len(departments) > 1:
        raise DraftError("allowed-department必须唯一；使用*时不能同时指定其他部门")
    normalized_classification = classification.upper()
    if normalized_classification not in CLASSIFICATIONS:
        raise DraftError("classification无效")
    if not REFERENCE.fullmatch(intake_ref):
        raise DraftError("intake-ref格式无效")
    warnings = []
    if redaction_count:
        warnings.append({"code": "LIKELY_SECRET_REDACTED", "count": redaction_count})
    if extraction_quality != "STANDARD":
        warnings.append({"code": "LIMITED_EXTRACTION_REQUIRES_SOURCE_COMPARISON", "count": 1})
    return {
        "schemaVersion": 1,
        "status": "REVIEW_REQUIRED",
        "publishable": False,
        "source": {
            "fileName": source.name,
            "extension": extension,
            "bytes": len(source_data),
            "contentSha256": source_hash,
            "url": safe_https_url(source_url),
            "extractionMethod": method,
            "extractionQuality": extraction_quality,
            "encoding": encoding,
        },
        "governance": {
            "ownerTeam": required_text(owner_team, "owner-team", 120),
            "allowedDepartments": departments,
            "classification": normalized_classification,
            "preparedBy": required_text(prepared_by, "prepared-by", 120),
            "intakeRef": intake_ref,
        },
        "summary": {
            "fragments": len(fragments),
            "chunks": len(chunks),
            "characters": sum(item["charCount"] for item in chunks),
            "likelySecretsRedacted": redaction_count,
        },
        "warnings": warnings,
        "chunks": chunks,
        "publicationTemplate": {
            "knowledgeId": None,
            "version": 1,
            "title": None,
            "patterns": [],
            "answer": None,
            "ownerTeam": required_text(owner_team, "owner-team", 120),
            "changeRef": None,
            "source": {
                "title": None,
                "url": safe_https_url(source_url),
                "contentSha256": source_hash,
                "reviewedAt": None,
            },
            "allowedDepartments": departments,
            "enabled": False,
            "expiresAt": None,
        },
        "reviewChecklist": [
            "逐段对照原文件，特别是PDF和DOC",
            "确认答案未包含个人信息、凭据或越权内容",
            "填写知识编码、标题、触发语、答案、变更单、审阅时间和失效时间",
            "由知识Owner批准后再使用知识目录导入命令发布",
        ],
    }


def write_new(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise DraftError("输出文件已存在，拒绝覆盖")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as target:
            json.dump(payload, target, ensure_ascii=False, indent=2)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def verify_draft(path: Path, maximum_bytes: int = 100 * 1024 * 1024) -> dict:
    data = read_source(path, maximum_bytes)
    try:
        report = json.loads(data.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DraftError("知识草稿不是有效UTF-8 JSON") from error
    if not isinstance(report, dict) or report.get("schemaVersion") != 1:
        raise DraftError("知识草稿Schema版本无效")
    if report.get("status") != "REVIEW_REQUIRED" or report.get("publishable") is not False:
        raise DraftError("知识草稿错误地声明为可发布")
    source = report.get("source") if isinstance(report.get("source"), dict) else {}
    source_hash = str(source.get("contentSha256", ""))
    if not re.fullmatch(r"[A-F0-9]{64}", source_hash):
        raise DraftError("知识草稿来源指纹无效")
    file_name = str(source.get("fileName", ""))
    if not file_name or Path(file_name).name != file_name or "/" in file_name or "\\" in file_name:
        raise DraftError("知识草稿来源文件名不安全")
    chunks = report.get("chunks")
    if not isinstance(chunks, list) or not chunks:
        raise DraftError("知识草稿缺少提取片段")
    unredacted_findings = 0
    for index, chunk in enumerate(chunks, 1):
        if not isinstance(chunk, dict) or chunk.get("sequence") != index or not isinstance(chunk.get("text"), str):
            raise DraftError("知识草稿片段结构无效")
        digest = sha256_bytes(chunk["text"].encode("utf-8"))
        expected_id = hashlib.sha256(f"{source_hash}:{index}:{digest}".encode("utf-8")).hexdigest()[:24].upper()
        if chunk.get("textSha256") != digest or chunk.get("chunkId") != expected_id:
            raise DraftError("知识草稿片段指纹不一致")
        for match in LIKELY_SECRET.finditer(chunk["text"]):
            if match.group(3) != "[REDACTED]":
                unredacted_findings += 1
        if any(marker.decode("ascii", errors="ignore") in chunk["text"] for marker in PRIVATE_KEY_MARKERS):
            raise DraftError("知识草稿包含私钥标记")
    template = report.get("publicationTemplate") if isinstance(report.get("publicationTemplate"), dict) else {}
    if template.get("enabled") is not False or template.get("answer") is not None:
        raise DraftError("知识草稿模板必须保持停用且答案为空")
    if unredacted_findings:
        raise DraftError("知识草稿仍含疑似未脱敏凭据")
    return {
        "valid": True,
        "status": "REVIEW_REQUIRED",
        "publishable": False,
        "sourceFile": file_name,
        "sourceSha256": source_hash,
        "chunks": len(chunks),
        "unredactedSecretFindings": 0,
    }


def self_test() -> dict:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        text_file = root / "guide.txt"
        text_file.write_text("系统登录说明\napi_key: ABCDEFGHIJKLMNOP\n申请权限仍需审批", encoding="utf-8")
        docx = root / "guide.docx"
        with zipfile.ZipFile(docx, "w") as archive:
            archive.writestr("word/document.xml", """<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>Word办理说明</w:t></w:r></w:p></w:body></w:document>""")
        xlsx = root / "guide.xlsx"
        with zipfile.ZipFile(xlsx, "w") as archive:
            archive.writestr("xl/sharedStrings.xml", """<sst xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><si><t>Excel规则</t></si></sst>""")
            archive.writestr("xl/worksheets/sheet1.xml", """<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData><row><c r=\"A1\" t=\"s\"><v>0</v></c></row></sheetData></worksheet>""")
        pptx = root / "guide.pptx"
        with zipfile.ZipFile(pptx, "w") as archive:
            archive.writestr("ppt/slides/slide1.xml", """<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><a:t>幻灯片规则</a:t></p:sld>""")
        common = dict(source_url="https://intranet.example.invalid/guide", owner_team="知识组", allowed_departments=["D-ORG"], classification="INTERNAL", prepared_by="E-KB", intake_ref="KB-INTAKE-001")
        drafts = [build_draft(path, **common) for path in (text_file, docx, xlsx, pptx)]
        locked = root / "locked.txt"
        locked.write_bytes(b"\x00E-SafeNet\x00LOCK\x00payload")
        locked_rejected = False
        try:
            build_draft(locked, **common)
        except DraftError:
            locked_rejected = True
        private = root / "private.txt"
        private.write_bytes(b"-----BEGIN PRIVATE KEY-----\nsecret\n")
        private_rejected = False
        try:
            build_draft(private, **common)
        except DraftError:
            private_rejected = True
        sensitive_query_rejected = False
        try:
            build_draft(text_file, **{**common, "source_url": "https://intranet.example.invalid/guide?%74oken=secret"})
        except DraftError:
            sensitive_query_rejected = True
        draft_path = root / "draft.json"
        draft_path.write_text(json.dumps(drafts[0], ensure_ascii=False), encoding="utf-8")
        valid_draft = verify_draft(draft_path)["valid"]
        tampered = json.loads(draft_path.read_text(encoding="utf-8"))
        tampered["chunks"][0]["text"] += "篡改"
        tampered_path = root / "tampered.json"
        tampered_path.write_text(json.dumps(tampered, ensure_ascii=False), encoding="utf-8")
        tamper_rejected = False
        try:
            verify_draft(tampered_path)
        except DraftError:
            tamper_rejected = True
        passed = (
            all(item["status"] == "REVIEW_REQUIRED" and not item["publishable"] and item["chunks"] for item in drafts)
            and drafts[0]["summary"]["likelySecretsRedacted"] == 1
            and "ABCDEFGHIJKLMNOP" not in json.dumps(drafts[0], ensure_ascii=False)
            and locked_rejected
            and private_rejected
            and sensitive_query_rejected
            and valid_draft
            and tamper_rejected
        )
        return {
            "selfTest": "PASS" if passed else "FAIL",
            "formats": [item["source"]["extension"] for item in drafts],
            "reviewRequired": all(not item["publishable"] for item in drafts),
            "secretRedaction": drafts[0]["summary"]["likelySecretsRedacted"],
            "lockedRejected": locked_rejected,
            "privateKeyRejected": private_rejected,
            "sensitiveUrlRejected": sensitive_query_rejected,
            "tamperRejected": tamper_rejected,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="用Python白名单读取Office来源并生成不可直接发布的知识审阅草稿")
    parser.add_argument("--source", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--source-url")
    parser.add_argument("--owner-team")
    parser.add_argument("--allowed-department", action="append", dest="departments")
    parser.add_argument("--classification", default="INTERNAL")
    parser.add_argument("--prepared-by")
    parser.add_argument("--intake-ref")
    parser.add_argument("--max-file-mb", type=int, default=100)
    parser.add_argument("--max-extracted-chars", type=int, default=2_000_000)
    parser.add_argument("--chunk-chars", type=int, default=1600)
    parser.add_argument("--allow-write-extracted-content", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--verify-draft", type=Path)
    args = parser.parse_args()
    if args.self_test:
        result = self_test()
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["selfTest"] == "PASS" else 1
    if args.verify_draft:
        result = verify_draft(args.verify_draft, max(1, args.max_file_mb) * 1024 * 1024)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    required = [args.source, args.output, args.source_url, args.owner_team, args.departments, args.prepared_by, args.intake_ref]
    if any(value is None for value in required):
        parser.error("除self-test外，source、output、source-url、owner-team、allowed-department、prepared-by和intake-ref均为必填")
    if not args.allow_write_extracted_content:
        raise DraftError("必须显式提供--allow-write-extracted-content，确认输出目录受公司加密与访问控制保护")
    if not 1 <= args.max_file_mb <= 500:
        raise DraftError("max-file-mb必须为1至500")
    if not 1000 <= args.max_extracted_chars <= 10_000_000:
        raise DraftError("max-extracted-chars必须为1000至10000000")
    if not 200 <= args.chunk_chars <= 5000:
        raise DraftError("chunk-chars必须为200至5000")
    report = build_draft(
        args.source,
        source_url=args.source_url,
        owner_team=args.owner_team,
        allowed_departments=args.departments,
        classification=args.classification,
        prepared_by=args.prepared_by,
        intake_ref=args.intake_ref,
        maximum_bytes=args.max_file_mb * 1024 * 1024,
        maximum_chars=args.max_extracted_chars,
        chunk_chars=args.chunk_chars,
    )
    write_new(args.output, report)
    print(json.dumps({"status": report["status"], "publishable": False, "sourceFile": report["source"]["fileName"], "sourceSha256": report["source"]["contentSha256"], "chunks": report["summary"]["chunks"], "output": args.output.name}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except DraftError as error:
        print(json.dumps({"error": {"code": "KNOWLEDGE_DRAFT_FAILED", "message": str(error)}}, ensure_ascii=False, indent=2), file=sys.stderr)
        raise SystemExit(1)
