"""Create and verify a source release ZIP through the company-approved Python path."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import zipfile


EXCLUDED_DIRECTORIES = {".git", "data", "work", "Microsoft", "node_modules", "__pycache__"}
EXCLUDED_NAMES = {".env", "connectors.production.json", ".env.production"}
EXCLUDED_SUFFIXES = {".db", ".log", ".pyc"}
SAFENET_MARKER = b"E-SafeNet"


def should_include(relative: Path) -> bool:
    if any(part in EXCLUDED_DIRECTORIES for part in relative.parts):
        return False
    if relative.name in EXCLUDED_NAMES:
        return False
    if relative.suffix.lower() in EXCLUDED_SUFFIXES:
        return False
    if relative.name.endswith(("-wal", "-shm")):
        return False
    return True


def package(project: Path, output: Path) -> dict:
    if output.exists():
        raise FileExistsError("输出ZIP已存在，拒绝覆盖")
    files = sorted(
        item for item in project.rglob("*")
        if item.is_file() and should_include(item.relative_to(project))
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file in files:
            content = file.read_bytes()
            if SAFENET_MARKER in content[:128]:
                raise ValueError(f"拒绝打包SafeNet密文：{file.relative_to(project).as_posix()}")
            info = zipfile.ZipInfo(
                f"{project.name}/{file.relative_to(project).as_posix()}",
                date_time=(2026, 8, 13, 0, 0, 0),
            )
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    return verify(output)


def verify(output: Path) -> dict:
    digest = hashlib.sha256(output.read_bytes()).hexdigest().upper()
    prohibited = []
    safenet_entries = []
    with zipfile.ZipFile(output) as archive:
        bad_member = archive.testzip()
        if bad_member:
            raise ValueError(f"ZIP CRC校验失败：{bad_member}")
        members = archive.namelist()
        for name in members:
            relative = Path(name).relative_to(Path(name).parts[0])
            if not should_include(relative):
                prohibited.append(name)
            with archive.open(name) as stream:
                if SAFENET_MARKER in stream.read(128):
                    safenet_entries.append(name)
    if prohibited or safenet_entries:
        raise ValueError(f"ZIP内容不合规：prohibited={prohibited}, safenet={safenet_entries}")
    return {
        "valid": True,
        "file": output.name,
        "bytes": output.stat().st_size,
        "entries": len(members),
        "sha256": digest,
        "prohibitedEntries": prohibited,
        "safeNetCipherEntries": safenet_entries,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    result = verify(args.output.resolve()) if args.verify_only else package(args.project.resolve(), args.output.resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
