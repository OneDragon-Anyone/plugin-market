"""静态扫描：Python 源码的 AST 规则。

只看代码结构，不执行也不导入：动态执行、命令执行、反序列化、凭据访问、混淆特征。
依赖相关的规则在 dependency_scan.py，恶意特征在 malware_scan.py。
"""

from __future__ import annotations

import ast
import re
from typing import Any

from common import (
    BLOCK,
    REVIEW,
    STATIC,
    dotted,
    finding,
    import_aliases,
)

# 静态扫描的规则数据，跟模块一起增删
CREDENTIAL_MARKERS = [
    "login data", "local state", ".ssh/id_rsa", "id_rsa",
    ".aws/credentials", "win32cred", "keyring.get_password",
    "credential manager", "cookies.sqlite", "key4.db",
]

DECODE_CALLS = {
    "base64.b64decode", "base64.decodebytes", "codecs.decode",
}
EXEC_CALLS = {"eval", "exec", "compile", "__import__"}
REVIEW_CALLS: dict[str, tuple[str, str]] = {
    "eval": ("DYNAMIC_EVAL", "eval() 动态执行代码，改成直接调用；确需动态执行请在提交说明里写清用途"),
    "exec": ("DYNAMIC_EXEC", "exec() 动态执行代码，改成直接调用；确需动态执行请在提交说明里写清用途"),
    "compile": ("DYNAMIC_COMPILE", "compile() 动态编译代码，改成直接调用；确需动态执行请在提交说明里写清用途"),
    "__import__": ("DYNAMIC_IMPORT", "__import__() 动态导入，改成普通 import；确需按名加载请说明来源"),
    "os.system": ("SHELL_EXEC", "os.system() 执行系统命令，说明调的是什么；用户机器上不一定有"),
    "os.popen": ("SHELL_EXEC", "os.popen() 执行系统命令，说明调的是什么；用户机器上不一定有"),
    "pty.spawn": ("SHELL_EXEC", "pty.spawn() 启动交互式 shell，插件用不到，移除"),
    "subprocess.run": ("SHELL_EXEC", "subprocess 启动子进程，说明调用什么程序；用户机器上不一定有"),
    "subprocess.Popen": ("SHELL_EXEC", "subprocess 启动子进程，说明调用什么程序；用户机器上不一定有"),
    "subprocess.call": ("SHELL_EXEC", "subprocess 启动子进程，说明调用什么程序；用户机器上不一定有"),
    "subprocess.check_output": ("SHELL_EXEC", "subprocess 启动子进程，说明调用什么程序；用户机器上不一定有"),
    "pickle.loads": ("UNSAFE_DESERIALIZE", "pickle.loads() 反序列化，只读自家生成的数据，或改用 json"),
    "marshal.loads": ("UNSAFE_DESERIALIZE", "marshal.loads() 反序列化代码对象，插件用不到，移除"),
    "os.dup2": ("FD_REDIRECT", "重定向文件描述符，插件用不到，移除"),
    "shutil.rmtree": ("RECURSIVE_DELETE", "递归删除目录，确认路径限定在插件自己的数据目录内"),
}


def scan_python_calls(file: str, source: str, tree: ast.AST) -> list[dict[str, Any]]:
    """可疑调用、凭据访问与混淆特征。source 用于按行判断，tree 由调用方解析后共用。"""
    out: list[dict[str, Any]] = []

    aliases = import_aliases(tree)
    calls: list[tuple[str, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = dotted(node.func)
            calls.append((aliases.get(name, name), node.lineno))

    seen_review: set[str] = set()
    for name, line in calls:
        if name in REVIEW_CALLS:
            code, detail = REVIEW_CALLS[name]
            if code not in seen_review:
                out.append(finding(code, REVIEW, STATIC, file, line, detail))
                seen_review.add(code)

    call_names = {name for name, _ in calls}
    if call_names & EXEC_CALLS and call_names & DECODE_CALLS:
        out.append(
            finding(
                "DECODE_AND_EXEC",
                BLOCK,
                STATIC,
                file,
                0,
                "同一文件既解码数据又动态执行，移除动态执行部分；这是加载加密 payload 的典型写法",
            )
        )
    if "pty.spawn" in call_names or ("os.dup2" in call_names and "socket.socket" in call_names):
        out.append(finding("REVERSE_SHELL", BLOCK, STATIC, file, 0, "检出反弹 shell 特征，不可收录"))

    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            value = node.value.lower()
            for marker in CREDENTIAL_MARKERS:
                if marker in value:
                    out.append(
                        finding(
                            "CREDENTIAL_ACCESS",
                            BLOCK,
                            STATIC,
                            file,
                            node.lineno,
                            f"读取浏览器或系统凭据（{marker}），插件不允许访问这些位置",
                        )
                    )
                    break

    for line_no, line in enumerate(source.splitlines(), 1):
        if len(line) > 800:
            out.append(finding("OBFUSCATED_LINE", REVIEW, STATIC, file, line_no, "单行超过 800 字符，格式化代码；长数据放到独立文件"))
            break
        if len(re.findall(r"\\x[0-9a-fA-F]{2}", line)) > 20:
            out.append(finding("ESCAPE_HEAVY", REVIEW, STATIC, file, line_no, "大量十六进制转义，改成明文或放到数据文件"))
            break

    return out
