import { readFileSync } from "node:fs"
import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

// Единственный источник отображаемой версии продукта (§10): package.json.
// GUI получает её подстановкой сборки, дубль литерала в src запрещён гейтом.
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string }

export default defineConfig({
  plugins: [gui()],
  define: { __PLUGIN_VERSION__: JSON.stringify(pkg.version) },
})
