import fs from "node:fs";
import path from "node:path";

// Copies non-TS build assets into dist so the runtime can load them.
// This is required for Docker/Render builds where only `dist/` exists at runtime.

const projectRoot = path.resolve(process.cwd());

const assets = [
  {
    from: path.join(projectRoot, "src", "db", "init.sql"),
    to: path.join(projectRoot, "dist", "db", "init.sql"),
  },
];

for (const a of assets) {
  if (!fs.existsSync(a.from)) {
    // eslint-disable-next-line no-console
    console.warn(`[copyAssets] Missing source asset: ${a.from}`);
    continue;
  }
  fs.mkdirSync(path.dirname(a.to), { recursive: true });
  fs.copyFileSync(a.from, a.to);
  // eslint-disable-next-line no-console
  console.log(`[copyAssets] Copied ${a.from} -> ${a.to}`);
}
