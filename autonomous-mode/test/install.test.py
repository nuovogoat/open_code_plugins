import contextlib
import hashlib
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import install as adapter_install  # noqa: E402

ADAPTER = Path(__file__).resolve().parents[1]
ANCHOR = b"webPreferences:{preload:ie.join(n,`../preload/index.cjs`)"


def make_asar(path: Path, files: dict[str, bytes]) -> None:
    header = {"files": {}}
    for name in files:
        node = header
        parts = name.split("/")
        for part in parts[:-1]:
            node = node["files"].setdefault(part, {"files": {}})
        node["files"][parts[-1]] = {"size": len(files[name]), "offset": "0"}
    offset = 0
    for name, data in files.items():
        node = header
        parts = name.split("/")
        for part in parts[:-1]:
            node = node["files"][part]
        node["files"][parts[-1]]["offset"] = str(offset)
        offset += len(data)
    encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
    json_size = len(encoded)
    encoded += b" " * ((-len(encoded)) % 4)
    header_size = len(encoded) + 8
    prefix = struct.pack("<IIII", 4, header_size, header_size - 4, json_size)
    with path.open("wb") as stream:
        stream.write(prefix)
        stream.write(encoded)
        for data in files.values():
            stream.write(data)


def fixture(version: str = "2.1.4", main: bytes | None = None) -> dict[str, bytes]:
    return {
        "package.json": json.dumps(
            {"name": "@opencode/desktop", "version": version, "type": "module", "main": "./out/main/index.js"}
        ).encode(),
        "out/main/index.js": main
        if main is not None
        else b'var ce={entry:Date.now()};' + ANCHOR + b';console.log("app")',
        "out/preload/index.cjs": b'let e=require("electron");console.log("preload")',
        "out/renderer/index.html": b"<html>fixture</html>",
    }


class InstallerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.resources = self.root / "resources"
        self.resources.mkdir()
        self.backup = self.root / "backup"
        self.archive = self.resources / "app.asar"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def install_output(self) -> dict:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            adapter_install.install(self.resources, ADAPTER, self.backup)
        return json.loads(output.getvalue())

    def test_install_and_restore_round_trip(self) -> None:
        original = fixture()
        make_asar(self.archive, original)
        original_bytes = self.archive.read_bytes()
        original_hash = hashlib.sha256(original_bytes).hexdigest()
        result = self.install_output()
        self.assertTrue(result["installed"])
        self.assertNotIn(str(self.resources), json.dumps(result))
        installed = adapter_install.Asar(self.archive)
        main = installed.read("out/main/index.js")
        preload = installed.read("out/preload/index.cjs")
        self.assertEqual(main.count(adapter_install.MARKER), 1)
        self.assertEqual(preload.count(adapter_install.MARKER), 1)
        self.assertTrue(main.startswith(original["out/main/index.js"]))
        self.assertTrue(preload.startswith(original["out/preload/index.cjs"]))
        self.assertIn(b"registerAutonomyIPC", main)
        self.assertIn(b"mountAutonomyUI", preload)
        self.assertIn(b"mountModelMenuUI", preload)
        self.assertIn(b'decision: "always"', main)
        self.assertNotIn(b'decision: "once"', main)
        self.assertIn(b"__modules", preload)
        self.assertEqual(installed.read("out/renderer/index.html"), original["out/renderer/index.html"])
        manifest = json.loads((self.backup / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["desktopVersion"], "2.1.4")
        self.assertEqual(manifest["archiveSha256"], original_hash)
        self.assertEqual(manifest["installedSha256"], hashlib.sha256(self.archive.read_bytes()).hexdigest())
        adapter_install.verify(self.resources)
        with contextlib.redirect_stdout(io.StringIO()):
            adapter_install.restore(self.resources, self.backup)
        self.assertEqual(self.archive.read_bytes(), original_bytes)

    def test_unsupported_version_and_layout_change_nothing(self) -> None:
        make_asar(self.archive, fixture(version="2.1.5"))
        before = self.archive.read_bytes()
        with self.assertRaises(ValueError):
            adapter_install.install(self.resources, ADAPTER, self.backup)
        self.assertEqual(self.archive.read_bytes(), before)
        self.assertFalse(self.backup.exists())

        make_asar(self.archive, fixture(main=b'console.log("no anchor")'))
        before = self.archive.read_bytes()
        with self.assertRaises(ValueError):
            adapter_install.install(self.resources, ADAPTER, self.backup)
        self.assertEqual(self.archive.read_bytes(), before)
        self.assertFalse(self.backup.exists())

    def test_already_installed_is_refused_without_backup(self) -> None:
        make_asar(self.archive, fixture())
        self.install_output()
        installed = self.archive.read_bytes()
        for path in self.backup.iterdir():
            path.unlink()
        self.backup.rmdir()
        with self.assertRaises(ValueError):
            adapter_install.install(self.resources, ADAPTER, self.backup)
        self.assertEqual(self.archive.read_bytes(), installed)

    def test_restore_refuses_a_changed_archive_without_force(self) -> None:
        make_asar(self.archive, fixture())
        original_bytes = self.archive.read_bytes()
        self.install_output()
        raw = self.archive.read_bytes()
        self.archive.write_bytes(raw[:-1] + bytes([raw[-1] ^ 0xFF]))
        with self.assertRaises(ValueError):
            adapter_install.restore(self.resources, self.backup)
        with contextlib.redirect_stdout(io.StringIO()):
            adapter_install.restore(self.resources, self.backup, force=True)
        self.assertEqual(self.archive.read_bytes(), original_bytes)

    def test_restore_refuses_a_tampered_backup(self) -> None:
        make_asar(self.archive, fixture())
        self.install_output()
        original = self.backup / "app.asar.original"
        original.write_bytes(original.read_bytes()[:-1] + b"x")
        with self.assertRaises(ValueError):
            adapter_install.restore(self.resources, self.backup)

    def test_bundle_has_no_local_require_dependency(self) -> None:
        make_asar(self.archive, fixture())
        self.install_output()
        preload = adapter_install.Asar(self.archive).read("out/preload/index.cjs").decode("utf-8")
        self.assertIn('"core": function(module, exports, require)', preload)
        self.assertIn('"controller": function(module, exports, require)', preload)
        self.assertIn('"ui": function(module, exports, require)', preload)
        self.assertIn('"model-menu": function(module, exports, require)', preload)
        self.assertIn('"preload": function(module, exports, require)', preload)
        self.assertNotIn('require("./ui.cjs")', preload.split(";(function(){")[0])
        self.assertIn('if (id === "electron") return require("electron")', preload)


if __name__ == "__main__":
    unittest.main(verbosity=2)
