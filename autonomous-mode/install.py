"""Minimal, reversible ASAR adapter for the reviewed OpenCode Desktop build."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import sys
import tempfile

MARKER = b"/* open_code_plugins:autonomous-mode */"
SUPPORTED_VERSION = "2.1.4"
ORIGINALS = (
    "out/main/index.js",
    "out/preload/index.cjs",
)
PRELOAD_ANCHOR = b"webPreferences:{preload:ie.join(n,`../preload/index.cjs`)"
BUNDLE_MODULES = (
    ("core", "core.cjs"),
    ("controller", "controller.cjs"),
    ("ui", "ui.cjs"),
    ("model-menu", "model-menu.cjs"),
    ("preload", "preload.cjs"),
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class Asar:
    def __init__(self, path: Path):
        self.path = path
        self.raw = path.read_bytes()
        if len(self.raw) < 24:
            raise ValueError("Not an ASAR archive")
        header_size = struct.unpack_from("<I", self.raw, 4)[0]
        if header_size < 2 or header_size > 16 * 1024 * 1024:
            raise ValueError("Unsupported ASAR header")
        json_size = struct.unpack_from("<I", self.raw, 12)[0]
        if json_size < 2 or json_size > header_size:
            raise ValueError("Unsupported ASAR header")
        header_bytes = self.raw[16 : 16 + json_size]
        self.header = json.loads(header_bytes)
        self.header_size = header_size
        self.base = 8 + header_size

    def info(self, name: str) -> dict:
        node = self.header
        for part in name.split("/"):
            node = node["files"][part]
        return node

    def read(self, name: str) -> bytes:
        info = self.info(name)
        if "offset" not in info:
            raise ValueError(f"Unpacked ASAR member is unsupported: {name}")
        start = self.base + int(info["offset"])
        size = int(info.get("size", 0))
        if start < 0 or size < 0 or start + size > len(self.raw):
            raise ValueError(f"Invalid ASAR member bounds: {name}")
        return self.raw[start : start + size]

    def write(self, replacements: dict[str, bytes], destination: Path) -> None:
        header = json.loads(json.dumps(self.header))
        old: dict[str, tuple[int, int]] = {}

        def collect(node: dict, prefix: str = "") -> None:
            for name, info in node.get("files", {}).items():
                path = f"{prefix}{name}"
                if "files" in info:
                    collect(info, path + "/")
                elif "offset" in info:
                    start = self.base + int(info["offset"])
                    size = int(info.get("size", 0))
                    if start < 0 or size < 0 or start + size > len(self.raw):
                        raise ValueError(f"Invalid ASAR member bounds: {path}")
                    old[path] = (start, size)

        collect(self.header)
        order: list[tuple[str, bytes | None, int, int]] = []
        offset = 0

        def visit(node: dict, prefix: str = "") -> None:
            nonlocal offset
            for name, info in node.get("files", {}).items():
                path = f"{prefix}{name}"
                if "files" in info:
                    visit(info, path + "/")
                    continue
                replacement = replacements.get(path)
                if replacement is not None:
                    data = replacement
                    size = len(data)
                    info.pop("integrity", None)
                elif "offset" in info:
                    if path not in old:
                        raise ValueError(f"Missing ASAR member: {path}")
                    data = None
                    size = old[path][1]
                else:
                    continue
                info["offset"] = str(offset)
                info["size"] = size
                order.append((path, data, old[path][0] if data is None else 0, size))
                offset += size

        visit(header)
        encoded = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        json_size = len(encoded)
        encoded += b" " * ((-len(encoded)) % 4)
        header_size = len(encoded) + 8
        prefix = bytearray(16)
        struct.pack_into("<I", prefix, 0, 4)
        struct.pack_into("<I", prefix, 4, header_size)
        struct.pack_into("<I", prefix, 8, header_size - 4)
        struct.pack_into("<I", prefix, 12, json_size)
        total = len(prefix) + len(encoded) + sum(item[3] for item in order)
        with destination.open("wb") as stream:
            stream.write(prefix)
            stream.write(encoded)
            for path, data, start, size in order:
                if data is None:
                    stream.write(self.raw[start : start + size])
                else:
                    stream.write(data)
        if destination.stat().st_size != total:
            raise OSError("Short ASAR write")


def build_preload_bundle(adapter: Path) -> bytes:
    modules = []
    for name, filename in BUNDLE_MODULES:
        source = (adapter / filename).read_text(encoding="utf-8")
        if MARKER.decode("utf-8") in source:
            raise ValueError("Runtime source contains the installer marker")
        modules.append(f'"{name}": function(module, exports, require) {{\n{source}\n}},\n')
    bundle = (
        MARKER
        + b"\n;(function(){\n"
        + b'"use strict";\nvar __modules = {\n'
        + "".join(modules).encode("utf-8")
        + b"};\n"
        + b"var __cache = Object.create(null);\n"
        + b"function __load(id) {\n"
        + b'  if (id === "electron") return require("electron");\n'
        + b'  var key = id.replace(/^\\.\\//, "").replace(/\\.cjs$/, "");\n'
        + b"  if (__cache[key]) return __cache[key].exports;\n"
        + b"  var module = { exports: {} };\n"
        + b"  __cache[key] = module;\n"
        + b"  __modules[key](module, module.exports, __load);\n"
        + b"  return module.exports;\n"
        + b"}\n"
        + b'try { __load("./preload.cjs"); } catch {}\n'
        + b"})();\n"
    )
    return bundle


def build_main_snippet(adapter: Path) -> bytes:
    source = (adapter / "main.cjs").read_text(encoding="utf-8")
    if MARKER.decode("utf-8") in source:
        raise ValueError("Runtime source contains the installer marker")
    return (
        MARKER
        + b"\n;(function(){\n"
        + b"  try {\n"
        + b'    const __require = process.getBuiltinModule("node:module").createRequire(import.meta.url);\n'
        + b"    const __module = { exports: {} };\n"
        + b"    (function(module, exports, require) {\n"
        + source.encode("utf-8")
        + b"\n    })(__module, __module.exports, __require);\n"
        + b"    const __electron = __require(\"electron\");\n"
        + b"    __module.exports.registerAutonomyIPC({ ipcMain: __electron.ipcMain, app: __electron.app });\n"
        + b"  } catch {}\n"
        + b"})();\n"
    )


def patch_sources(archive: Asar, adapter: Path) -> dict[str, bytes]:
    package_bytes = archive.read("package.json")
    try:
        package = json.loads(package_bytes)
    except Exception as error:
        raise ValueError("Unsupported Desktop package") from error
    if package.get("version") != SUPPORTED_VERSION:
        raise ValueError("Unsupported Desktop version")
    main = archive.read("out/main/index.js")
    preload = archive.read("out/preload/index.cjs")
    if MARKER in main or MARKER in preload:
        raise ValueError("Adapter is already installed; restore before reinstalling")
    if main.count(PRELOAD_ANCHOR) != 1:
        raise ValueError("Unsupported Desktop preload layout; nothing changed")
    if not preload.startswith(b"let e=require(\"electron\")"):
        raise ValueError("Unsupported Desktop preload bundle; nothing changed")
    patched_main = main + b"\n" + build_main_snippet(adapter)
    patched_preload = preload + b"\n" + build_preload_bundle(adapter)
    return {
        "out/main/index.js": patched_main,
        "out/preload/index.cjs": patched_preload,
    }


def verify_archive(archive: Asar, original_main: bytes | None = None, original_preload: bytes | None = None) -> None:
    package = json.loads(archive.read("package.json"))
    if package.get("version") != SUPPORTED_VERSION:
        raise ValueError("Unsupported Desktop version")
    main = archive.read("out/main/index.js")
    preload = archive.read("out/preload/index.cjs")
    if main.count(MARKER) != 1 or preload.count(MARKER) != 1:
        raise ValueError("Adapter marker verification failed")
    if b"registerAutonomyIPC" not in main:
        raise ValueError("Main bridge verification failed")
    if b"autonomous-mode:enable" not in main or b"autonomous-mode:enable" not in preload:
        raise ValueError("Autonomy channels verification failed")
    snippet = main[main.rfind(MARKER) :]
    if b'"PATCH"' in snippet or b'decision: "always"' not in snippet or b'decision: "once"' in snippet:
        raise ValueError("Main bridge safety verification failed")
    if (
        b"mountAutonomyUI" not in preload
        or b"mountModelMenuUI" not in preload
        or b"model-selector-scroll" not in preload
        or b"manage-models-scroll" not in preload
        or b"__load" not in preload
    ):
        raise ValueError("Preload bundle verification failed")
    if original_main is not None and not main.startswith(original_main):
        raise ValueError("Main bundle was not preserved")
    if original_preload is not None and not preload.startswith(original_preload):
        raise ValueError("Preload bundle was not preserved")


def install(resources: Path, adapter: Path, backup: Path) -> None:
    archive_path = resources / "app.asar"
    if not archive_path.is_file():
        raise ValueError("app.asar not found")
    archive = Asar(archive_path)
    sources = patch_sources(archive, adapter)
    if backup.exists():
        raise ValueError("Backup already exists; restore it before installing again")
    backup.parent.mkdir(parents=True, exist_ok=True)
    backup.mkdir()
    try:
        original = backup / "app.asar.original"
        shutil.copy2(archive_path, original)
        if sha256(original) != sha256_bytes(archive.raw):
            raise ValueError("Archive changed during installation")
        manifest = {
            "version": 1,
            "adapter": "autonomous-mode",
            "desktopVersion": SUPPORTED_VERSION,
            "archiveSha256": sha256(original),
            "installedSha256": None,
        }
        manifest_path = backup / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        fd, temp_name = tempfile.mkstemp(prefix="autonomous-mode-", suffix=".asar", dir=resources)
        os.close(fd)
        temp = Path(temp_name)
        try:
            archive.write(sources, temp)
            patched = Asar(temp)
            verify_archive(
                patched,
                original_main=archive.read("out/main/index.js"),
                original_preload=archive.read("out/preload/index.cjs"),
            )
            manifest["installedSha256"] = sha256(temp)
            manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            os.replace(temp, archive_path)
        finally:
            temp.unlink(missing_ok=True)
    except Exception:
        shutil.rmtree(backup, ignore_errors=True)
        raise
    print(json.dumps({"installed": True, "version": SUPPORTED_VERSION, "archiveSha256": sha256(archive_path)}))


def restore(resources: Path, backup: Path, force: bool = False) -> None:
    manifest_path = backup / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as error:
        raise ValueError("Backup manifest is unavailable") from error
    if manifest.get("adapter") != "autonomous-mode" or manifest.get("version") != 1:
        raise ValueError("Unknown backup")
    original = backup / "app.asar.original"
    if not original.is_file() or sha256(original) != manifest.get("archiveSha256"):
        raise ValueError("Backup hash mismatch; refusing to restore")
    archive_path = resources / "app.asar"
    if not archive_path.is_file():
        raise ValueError("app.asar not found")
    expected = manifest.get("installedSha256")
    if not force and expected is not None and sha256(archive_path) != expected:
        raise ValueError("Archive changed since installation; refusing to restore without --force")
    fd, temp_name = tempfile.mkstemp(prefix="autonomous-mode-restore-", suffix=".asar", dir=resources)
    os.close(fd)
    temp = Path(temp_name)
    try:
        shutil.copy2(original, temp)
        if sha256(temp) != manifest.get("archiveSha256"):
            raise ValueError("Restore copy verification failed")
        os.replace(temp, archive_path)
    finally:
        temp.unlink(missing_ok=True)
    print(json.dumps({"restored": True, "archiveSha256": sha256(archive_path)}))


def verify(resources: Path) -> None:
    archive_path = resources / "app.asar"
    if not archive_path.is_file():
        raise ValueError("app.asar not found")
    archive = Asar(archive_path)
    verify_archive(archive)
    print(json.dumps({"installed": True, "version": SUPPORTED_VERSION, "archiveSha256": sha256(archive_path)}))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("install", "restore", "verify"))
    parser.add_argument("--resources", type=Path, required=True)
    parser.add_argument("--backup", type=Path)
    parser.add_argument("--adapter", type=Path, default=Path(__file__).parent)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if args.action in ("install", "restore") and args.backup is None:
        parser.error("--backup is required for install and restore")
    if args.action == "install":
        install(args.resources.resolve(), args.adapter.resolve(), args.backup.resolve())
    elif args.action == "restore":
        restore(args.resources.resolve(), args.backup.resolve(), args.force)
    else:
        verify(args.resources.resolve())


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(f"autonomous-mode: {message}", file=sys.stderr)
        raise SystemExit(1)
