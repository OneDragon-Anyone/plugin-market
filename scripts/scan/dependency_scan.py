"""依赖扫描：插件包有没有绕开主程序自带的依赖体系。

检查包内是否夹带依赖清单、捆绑依赖目录、可执行脚本，以及 Python 源码是否引用了
标准库和主程序之外的第三方包。静态代码规则在 static_scan.py。
"""

from __future__ import annotations

import ast
import sys
from pathlib import PurePosixPath
from typing import Any

from common import (
    BLOCK,
    DEPENDENCY,
    REVIEW,
    STATIC,
    finding,
)

# 依赖扫描的规则数据，跟模块一起增删
# 主程序自带的包不算第三方依赖
HOST_ROOTS = {"one_dragon", "one_dragon_qt", "zzz_od"}
STDLIB_ROOTS = set(sys.stdlib_module_names)
NETWORK_ROOTS = {
    "socket", "urllib", "requests", "httpx", "aiohttp", "ftplib",
    "smtplib", "telnetlib", "webbrowser", "urllib3", "websocket",
    "http", "paramiko", "ssl",
}
SCRIPT_SUFFIXES = {".bat", ".cmd", ".ps1", ".vbs", ".vbe", ".jse", ".hta", ".wsf", ".sh"}
DEPENDENCY_FILES = {
    "requirements.txt", "pyproject.toml", "setup.py", "setup.cfg",
    "pipfile", "pipfile.lock", "poetry.lock", "uv.lock", "pdm.lock",
    "environment.yml", "environment.yaml",
}


def scan_python_imports(file: str, tree: ast.AST, package_roots: set[str]) -> list[dict[str, Any]]:
    """源码里的 import：网络模块提示确认，标准库与主程序之外的包提示第三方。"""
    out: list[dict[str, Any]] = []
    for node in ast.walk(tree):
        modules: list[tuple[str, int]] = []
        if isinstance(node, ast.Import):
            modules = [(alias.name, node.lineno) for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            modules = [(node.module, node.lineno)]
        for module, line in modules:
            root = module.split(".")[0]
            # 网络模块多半是标准库，要先判断，不能被白名单先放过去
            if root in NETWORK_ROOTS:
                out.append(finding("NETWORK_MODULE", REVIEW, STATIC, file, line, f"使用网络模块 {root}，需确认与申报的风险标签一致"))
                continue
            if root in STDLIB_ROOTS or root in HOST_ROOTS or root == "__future__" or root in package_roots:
                continue
            out.append(finding("THIRD_PARTY_IMPORT", REVIEW, DEPENDENCY, file, line, f"引用第三方包 {root}，需确认主程序已内置"))
    return out


def scan_package_files(file: str) -> list[dict[str, Any]]:
    """按文件名判断：依赖清单、捆绑的依赖目录、随包携带的脚本。"""
    out: list[dict[str, Any]] = []
    path = PurePosixPath(file)
    name = path.name.lower()
    suffix = path.suffix.lower()

    if suffix in SCRIPT_SUFFIXES:
        out.append(finding("SCRIPT_IN_PACKAGE", REVIEW, DEPENDENCY, file, 0, f"包内脚本 {suffix} 需人工确认用途"))
    if name in DEPENDENCY_FILES or (name.startswith("requirements") and name.endswith(".txt")):
        out.append(finding("DEPENDENCY_FILE", BLOCK, DEPENDENCY, file, 0, "包内不允许携带依赖清单"))
    if any(part.lower() in {"site-packages", "node_modules", "vendor", "__pycache__"} for part in path.parts[1:]):
        out.append(finding("BUNDLED_DEPENDENCY_DIR", BLOCK, DEPENDENCY, file, 0, "包内不允许捆绑依赖目录"))
    return out
