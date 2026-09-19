"""Check Python dependency direction without importing application code."""

from __future__ import annotations

import ast
from pathlib import Path

PACKAGE = "quantpilot_market_data"
ROOT = Path(__file__).resolve().parents[2] / "services/market-data/src" / PACKAGE
FORBIDDEN = {
    "contracts": {"providers", "repositories", "services", "routers", "api"},
    "providers": {"repositories", "services", "routers", "api"},
    "repositories": {"providers", "services", "routers", "api"},
    "services": {"routers", "api", "security"},
    "routers": {"repositories", "api"},
    "api": {"repositories"},
}
HTTP_METHODS = {"get", "post", "put", "patch", "delete", "head", "options", "api_route"}


def imported_modules(tree: ast.AST, relative_path: str) -> list[str]:
    package = [PACKAGE, *Path(relative_path).parts[:-1]]
    imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            prefix = package[: len(package) - node.level + 1] if node.level else []
            base = ".".join([*prefix, *filter(None, (node.module or "").split("."))])
            imports.append(base)
            imports.extend(f"{base}.{alias.name}" for alias in node.names)
        elif isinstance(node, ast.Call) and node.args:
            function = node.func
            if (
                (
                    isinstance(function, ast.Name)
                    and function.id in {"__import__", "import_module"}
                    or isinstance(function, ast.Attribute)
                    and function.attr == "import_module"
                )
                and isinstance(node.args[0], ast.Constant)
                and isinstance(node.args[0].value, str)
            ):
                imports.append(node.args[0].value)
    return imports


def check_source(relative_path: str, source: str) -> list[str]:
    tree = ast.parse(source, filename=relative_path)
    layer = Path(relative_path).parts[0].removesuffix(".py")
    errors = []
    for name in imported_modules(tree, relative_path):
        parts = name.split(".")
        target = parts[1] if len(parts) > 1 and parts[0] == PACKAGE else None
        if target in FORBIDDEN.get(layer, set()):
            errors.append(f"{relative_path}: {layer} must not import {name}")
        if layer in {"contracts", "providers", "repositories", "services"} and parts[0] in {
            "fastapi",
            "starlette",
        }:
            errors.append(f"{relative_path}: HTTP dependencies belong in routers: {name}")
    if relative_path == "api.py":
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for decorator in node.decorator_list:
                    fn = decorator.func if isinstance(decorator, ast.Call) else decorator
                    if isinstance(fn, ast.Attribute) and fn.attr in HTTP_METHODS:
                        errors.append(f"api.py:{node.lineno}: register HTTP endpoints in routers")
    return sorted(set(errors))


def main() -> int:
    errors = []
    files = sorted(ROOT.rglob("*.py"))
    for file in files:
        errors.extend(check_source(file.relative_to(ROOT).as_posix(), file.read_text()))
    if errors:
        print("\n".join(errors))
        return 1
    print(f"[backend-layers] ok: {len(files)} Python modules; layers and HTTP boundaries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
