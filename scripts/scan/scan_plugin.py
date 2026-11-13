"""扫描入口：解开 ZIP，按类别调用各扫描模块，汇总成一份 JSON 报告。

由 scan/client.ts 以子进程调用，stdout 最后一行是报告 JSON。
结果按包的 sha256 缓存，同一个包只扫一次；规则改了删掉 .lock/scan-results.json 即可整体重扫。

各类别分文件维护，规则数据也放在各自的模块里：
- static_scan.py      Python 源码 AST：动态执行、命令执行、凭据访问、混淆
- dependency_scan.py  依赖：依赖清单、捆绑目录、未申报的第三方 import
- malware_scan.py     恶意特征：可执行体、二进制头、命令特征串、高熵内容
新增一类时按同样形式加一个模块，在下面的 scan_zip 里加一行调用；删掉一类反过来即可。
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

import dependency_scan
import malware_scan
import static_scan
from common import (
    BLOCK,
    MAX_FINDINGS,
    MAX_SCAN_BYTES,
    REVIEW,
    SCANNER,
    TEXT_SUFFIXES,
    finding,
    parse_python,
    safe_name,
)


def scan_zip(
    zip_path: str,
    plugin_roots: set[str] | None = None,
    host_roots: set[str] | None = None,
) -> dict[str, Any]:
    plugin_roots = plugin_roots or set()
    host_roots = host_roots or set()
    findings: list[dict[str, Any]] = []
    scanned = 0
    python_files = 0
    truncated = False

    with zipfile.ZipFile(zip_path) as archive:
        # 所有顶层目录都是包自身的模块根，全部收集下去排除。早先只从 set 里取一个，
        # 顺序随进程哈希种子变：多顶层目录的包会把自己的 import 误判成第三方，
        # 结论还会按 sha256 缓存下来，首次在哪个进程扫就固定成哪个结论。
        package_roots: set[str] = set()
        for info in archive.infolist():
            if not safe_name(info.filename):
                continue
            parts = PurePosixPath(info.filename).parts
            if len(parts) > 1:
                package_roots.add(parts[0])
            elif parts[0].endswith(".py"):
                package_roots.add(PurePosixPath(parts[0]).stem)
        for info in archive.infolist():
            name = info.filename
            if info.is_dir() or not safe_name(name):
                continue
            scanned += 1
            try:
                with archive.open(info) as stream:
                    data = stream.read(MAX_SCAN_BYTES)
            except (RuntimeError, zipfile.BadZipFile, OSError) as exc:
                findings.append(finding("UNREADABLE_ENTRY", BLOCK, SCANNER, name, 0, f"无法读取：{exc}"))
                continue

            findings.extend(malware_scan.scan_executable(name, data))
            findings.extend(dependency_scan.scan_package_files(name))
            findings.extend(malware_scan.scan_signatures(name, data))
            suffix = PurePosixPath(name).suffix.lower()
            if suffix == ".py":
                python_files += 1
                tree, syntax_error = parse_python(name, data)
                if syntax_error:
                    findings.append(syntax_error)
                else:
                    findings.extend(static_scan.scan_python_calls(name, data.decode("utf-8", "replace"), tree))
                    findings.extend(
                        dependency_scan.scan_python_imports(name, tree, package_roots, host_roots, plugin_roots)
                    )
                findings.extend(malware_scan.scan_text(name, data))
            elif suffix in TEXT_SUFFIXES:
                findings.extend(malware_scan.scan_text(name, data))

            if len(findings) >= MAX_FINDINGS:
                truncated = True
                break

    unique: dict[tuple[str, str, int], dict[str, Any]] = {}
    for item in findings:
        unique.setdefault((item["code"], item["file"], item["line"]), item)
    findings = list(unique.values())[:MAX_FINDINGS]
    if truncated:
        findings.append(finding("SCAN_TRUNCATED", REVIEW, SCANNER, "", 0, f"命中项超过 {MAX_FINDINGS} 条，已截断"))

    return {
        "scannedFiles": scanned,
        "pythonFiles": python_files,
        "findings": findings,
        "summary": {
            "block": sum(1 for item in findings if item["severity"] == BLOCK),
            "review": sum(1 for item in findings if item["severity"] == REVIEW),
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Scan a plugin release ZIP without executing its code.")
    parser.add_argument("--zip", required=True, help="Path to the release <id>.zip")
    parser.add_argument(
        "--host-packages",
        default="",
        help="Comma separated import names already installed by the host program; not third-party dependencies",
    )
    parser.add_argument(
        "--known-plugins",
        default="",
        help="Comma separated ids of plugins already in the market; importing them is not a third-party dependency",
    )
    args = parser.parse_args()

    path = Path(args.zip)
    if not path.is_file():
        print(json.dumps({"error": f"file not found: {path}"}))
        return 2
    plugin_roots = {item.strip() for item in args.known_plugins.split(",") if item.strip()}
    host_roots = {item.strip() for item in args.host_packages.split(",") if item.strip()}
    try:
        report = scan_zip(str(path), plugin_roots, host_roots)
    except (zipfile.BadZipFile, OSError) as exc:
        print(json.dumps({"error": str(exc)}))
        return 2
    print(json.dumps(report, ensure_ascii=False))
    return 1 if report["summary"]["block"] > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
