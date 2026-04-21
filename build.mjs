import { build } from "esbuild";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const distDir = path.join(root, "dist");
const logoName = "logo.png";

const manifest = {
  manifest_version: 3,
  name: "Copy Frame",
  description: "Point. Copy. For AI.",
  version: "0.1.0",
  permissions: ["activeTab", "storage", "webNavigation"],
  host_permissions: ["<all_urls>"],
  web_accessible_resources: [
    {
      resources: [logoName],
      matches: ["<all_urls>"]
    }
  ],
  icons: {
    16: logoName,
    32: logoName,
    48: logoName,
    128: logoName
  },
  action: {
    default_title: "Copy Frame",
    default_icon: {
      16: logoName,
      32: logoName,
      48: logoName,
      128: logoName
    }
  },
  background: {
    service_worker: "background.js"
  },
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["content.js"],
      run_at: "document_idle",
      all_frames: true
    }
  ]
};

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await build({
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts"
  },
  bundle: true,
  format: "iife",
  target: "chrome114",
  outdir: distDir,
  platform: "browser",
  sourcemap: false,
  logLevel: "info"
});

await copyFile(path.join(root, logoName), path.join(distDir, logoName));

await writeFile(
  path.join(distDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);
