from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="用Python白名单读取受SafeNet保护的知识目录，并通过内存管道交给Node导入")
    parser.add_argument("--file", type=Path)
    parser.add_argument("--database")
    parser.add_argument("--imported-by")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--with-demo-seed", action="store_true")
    parser.add_argument("--max-file-mb", type=int, default=20)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if not 1 <= args.max_file_mb <= 100:
        raise ValueError("max-file-mb必须为1至100")
    temporary = None
    if args.self_test:
        temporary = tempfile.TemporaryDirectory()
        args.file = Path(temporary.name) / "catalog.json"
        reviewed = datetime.now(timezone.utc)
        fixture = {"version": 1, "knowledge": [{
            "knowledgeId": "KB-PYTHON-BRIDGE-001", "version": 1, "title": "Python桥接自检",
            "patterns": ["Python桥接"], "answer": "仅用于验证内存管道。", "ownerTeam": "平台组",
            "changeRef": "KB-BRIDGE-SELF-TEST", "source": {"title": "自检来源", "url": "https://intranet.example.invalid/bridge",
            "contentSha256": "A" * 64, "reviewedAt": reviewed.isoformat().replace("+00:00", "Z")},
            "allowedDepartments": ["*"], "enabled": False,
            "expiresAt": (reviewed + timedelta(days=365)).isoformat().replace("+00:00", "Z"),
        }]}
        args.file.write_text(json.dumps(fixture, ensure_ascii=False), encoding="utf-8")
        args.dry_run = True
    if args.file is None:
        parser.error("必须提供--file或--self-test")
    if not args.file.is_file() or args.file.stat().st_size > args.max_file_mb * 1024 * 1024:
        raise ValueError("知识目录不存在或超过大小上限")
    raw = args.file.read_bytes()
    if len(raw) > args.max_file_mb * 1024 * 1024:
        raise ValueError("Python逻辑读取后的知识目录超过大小上限")
    if b"E-SafeNet" in raw[:4096] or b"\x00LOCK\x00" in raw[:4096]:
        raise ValueError("Python读取后仍检测到SafeNet锁定字节")
    if b"-----BEGIN PRIVATE KEY-----" in raw or b"-----BEGIN RSA PRIVATE KEY-----" in raw or b"-----BEGIN OPENSSH PRIVATE KEY-----" in raw:
        raise ValueError("知识目录包含私钥标记")
    text = raw.decode("utf-8-sig")
    parsed = json.loads(text)
    payload = json.dumps(parsed, ensure_ascii=False, separators=(",", ":"))
    project = Path(__file__).resolve().parent.parent
    node = os.environ.get("NODE_BINARY", "node")
    command = [node, str(project / "scripts" / "import-knowledge-catalog.mjs"), "--stdin", "--source-name", args.file.name]
    if args.database:
        command.extend(["--database", args.database])
    if args.imported_by:
        command.extend(["--imported-by", args.imported_by])
    if args.dry_run:
        command.append("--dry-run")
    if args.with_demo_seed:
        command.append("--with-demo-seed")
    completed = subprocess.run(command, input=payload, text=True, encoding="utf-8", capture_output=True, env=os.environ.copy(), shell=False)
    if args.self_test:
        try:
            result = json.loads(completed.stdout)
            passed = completed.returncode == 0 and result.get("dryRun") is True and result.get("operations", [{}])[0].get("action") == "CREATE"
        except (json.JSONDecodeError, IndexError):
            passed = False
        print(json.dumps({"selfTest": "PASS" if passed else "FAIL", "pythonLogicalRead": True, "nodeStdinBridge": completed.returncode == 0, "plaintextCopyPersisted": False}, ensure_ascii=False, indent=2))
        temporary.cleanup()
        return 0 if passed else 1
    if completed.stdout:
        sys.stdout.write(completed.stdout)
    if completed.stderr:
        sys.stderr.write(completed.stderr)
    return completed.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"error": {"code": "PYTHON_KNOWLEDGE_IMPORT_FAILED", "message": str(error)}}, ensure_ascii=False, indent=2), file=sys.stderr)
        raise SystemExit(1)
