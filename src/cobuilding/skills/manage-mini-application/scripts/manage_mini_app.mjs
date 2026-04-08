#!/usr/bin/env node

import { parseArgs } from "util";
import { join } from "path";
import { mkdirSync, writeFileSync, existsSync, cpSync, readdirSync, statSync } from "fs";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    template: { type: "string" },
  },
});

const workspaceDir = process.env.MINI_APP_WORKSPACE_DIR;

if (!workspaceDir) {
  console.error("MINI_APP_WORKSPACE_DIR environment variable is not set");
  process.exit(1);
}
if (!values.name) {
  console.error("--name is required");
  process.exit(1);
}

function toLowerCamelCase(name) {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9\s_-]/g, "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word, i) =>
      i === 0
        ? word.toLowerCase()
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join("");
}

const dirName = toLowerCamelCase(values.name);
if (!dirName) {
  console.error("--name must contain at least one alphanumeric character");
  process.exit(1);
}
const miniAppDir = join(workspaceDir, ".applications", dirName);

mkdirSync(join(miniAppDir, "src"), { recursive: true });
mkdirSync(join(miniAppDir, "dist"), { recursive: true });
mkdirSync(join(miniAppDir, "output"), { recursive: true });

// Scaffold index.html
const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <script src="../../_vendor/tailwind.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="../dist/bundle.js"></script>
</body>
</html>
`;

writeFileSync(join(miniAppDir, "src", "index.html"), indexHtml);

// Scaffold index.tsx
const indexTsx = `import "../../_bridge/bridge";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(<App />);
`;

writeFileSync(join(miniAppDir, "src", "index.tsx"), indexTsx);

// Copy template files if --template is specified
if (values.template) {
  const templatesDir = join(workspaceDir, ".applications", "_templates", values.template);
  if (existsSync(templatesDir)) {
    // Copy .ipynb files to app root, everything else to src/
    for (const entry of readdirSync(templatesDir)) {
      const srcPath = join(templatesDir, entry);
      if (entry.endsWith(".ipynb")) {
        cpSync(srcPath, join(miniAppDir, entry));
      } else if (statSync(srcPath).isDirectory()) {
        cpSync(srcPath, join(miniAppDir, "src", entry), { recursive: true });
      } else {
        cpSync(srcPath, join(miniAppDir, "src", entry));
      }
    }
  } else {
    console.error(`Template directory not found: ${templatesDir}`);
    process.exit(1);
  }
}

console.log(JSON.stringify({ name: values.name, dir_name: dirName, dir: miniAppDir }));
