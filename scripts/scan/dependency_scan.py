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
# 主程序自己的模块
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


def scan_python_imports(
    file: str,
    tree: ast.AST,
    package_roots: set[str],
    host_roots: set[str],
    plugin_roots: set[str],
) -> list[dict[str, Any]]:
    """源码里的 import：网络模块提示确认，标准库、主程序与已上架插件之外的包提示第三方。

    host_roots 是主程序环境里已经装好的 import 名，由调用方从主程序的 uv.lock 换算后传进来，
    不在这里手抄。plugin_roots 是市场上其它已收录插件的 id：插件之间互相 import 属正常依赖，
    不是绕开主程序依赖体系，按第三方包报会误导维护者。
    """
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
                out.append(
                    finding(
                        "NETWORK_MODULE",
                        REVIEW,
                        STATIC,
                        file,
                        line,
                        f"使用网络模块 {root}，会联网就在 manifest 里申报 network，不联网去掉这处调用",
                    )
                )
                continue
            if (
                root in STDLIB_ROOTS
                or root in HOST_ROOTS
                or root in host_roots
                or root == "__future__"
                or root in package_roots
                or root in plugin_roots
            ):
                continue
            out.append(
                finding(
                    "THIRD_PARTY_IMPORT",
                    REVIEW,
                    DEPENDENCY,
                    file,
                    line,
                    f"主程序未内置 {root}，插件需随包提供或改为可选导入，否则用户机器上这处 import 会失败",
                )
            )
    return out


def scan_package_files(file: str) -> list[dict[str, Any]]:
    """按文件名判断：依赖清单、捆绑的依赖目录、随包携带的脚本。"""
    out: list[dict[str, Any]] = []
    path = PurePosixPath(file)
    name = path.name.lower()
    suffix = path.suffix.lower()

    if suffix in SCRIPT_SUFFIXES:
        out.append(
            finding("SCRIPT_IN_PACKAGE", REVIEW, DEPENDENCY, file, 0, f"包内带 {suffix} 脚本，说明用途或移出安装包；主程序不需要外部脚本")
        )
    if name in DEPENDENCY_FILES or (name.startswith("requirements") and name.endswith(".txt")):
        out.append(finding("DEPENDENCY_FILE", BLOCK, DEPENDENCY, file, 0, f"包内带依赖清单 {name}，移除；依赖由主程序统一提供"))
    # 目录名逐段比，从包根开始算：插件包的 plugin.json 就在根上，没有外层包装目录，
    # 只从第二段看会漏掉 vendor/、site-packages/ 这种直接放在根上的情况
    if any(part.lower() in {"site-packages", "node_modules", "vendor", "__pycache__"} for part in path.parts[:-1]):
        out.append(finding("BUNDLED_DEPENDENCY_DIR", BLOCK, DEPENDENCY, file, 0, "包内捆绑了依赖目录，移除；依赖由主程序统一提供"))
    return out
