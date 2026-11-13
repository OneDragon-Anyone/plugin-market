"""扫描器共用：规则版本、严重级别、类别名、命中项结构与通用工具。

一类扫描一个模块：static_scan / dependency_scan / malware_scan，各自的规则数据放在
自己的模块里。新增一类时建一个模块，在 scan_plugin.py 的聚合流程里加一行调用；
只有报告里的类别名需要在这里登记，TS 侧按字符串读取，不必同步改类型。
"""

from __future__ import annotations

import ast
import math
from collections import Counter
from pathlib import PurePosixPath
from typing import Any

# 规则变更后删掉 .lock/scan-results.json 就能整体重扫；不想清文件时把版本加一也行
SCAN_RULE_VERSION = 1
MAX_SCAN_BYTES = 8 * 1024 * 1024
MAX_FINDINGS = 60

BLOCK = "block"
REVIEW = "review"

# 报告里的 category 取值；TS 侧按字符串读取，新增类别不必同步改类型
STATIC = "static"
DEPENDENCY = "dependency"
# 恶意特征扫描的类别沿用此名；已缓存报告里的 category 也是这个值，改名会让旧结果对不上
VIRUS = "virus"
# 扫描器自身的问题（读不到条目、命中过多被截断）不算任何一类规则命中
SCANNER = "scanner"

# 哪些扩展名按文本内容处理；入口按它决定要不要算熵
TEXT_SUFFIXES = {
    ".py", ".json", ".txt", ".md", ".cfg", ".ini", ".toml", ".yaml", ".yml",
    ".xml", ".html", ".htm", ".css", ".js", ".ts", ".env", ".properties",
}


def finding(
    code: str, severity: str, category: str, file: str, line: int, detail: str
) -> dict[str, Any]:
    """一条命中项。所有扫描模块都通过它产出，字段结构保持一致。"""
    return {
        "code": code,
        "severity": severity,
        "category": category,
        "file": file,
        "line": line,
        "detail": detail,
    }


def dotted(node: ast.AST) -> str:
    """把 a.b.c 形式的调用目标还原成点号路径。"""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    return ""


def import_aliases(tree: ast.AST) -> dict[str, str]:
    """把 from subprocess import run 的 run 还原成 subprocess.run。"""
    aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            for alias in node.names:
                local = alias.asname or alias.name
                aliases[local] = f"{node.module}.{alias.name}"
    return aliases


def entropy(data: bytes) -> float:
    if not data:
        return 0.0
    counts = Counter(data)
    total = len(data)
    return -sum((n / total) * math.log2(n / total) for n in counts.values())


def safe_name(name: str) -> bool:
    """压缩包内的路径是否安全：不带绝对路径、反斜杠和上跳。"""
    parts = PurePosixPath(name).parts
    return bool(name) and not name.startswith("/") and "\\" not in name and ".." not in parts


def parse_python(file: str, data: bytes) -> tuple[ast.AST | None, dict[str, Any] | None]:
    """解析一次，静态与依赖两条规则共用同一棵树；语法错误只报一次。"""
    source = data.decode("utf-8", "replace")
    try:
        return ast.parse(source, filename=file), None
    except SyntaxError as exc:
        return None, finding("PY_SYNTAX_ERROR", REVIEW, STATIC, file, exc.lineno or 0, exc.msg)
