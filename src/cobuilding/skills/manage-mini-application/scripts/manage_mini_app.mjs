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

const workspaceDir = process.env.MINI_APP_WORKSPACE_DIR || process.cwd();
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
//
// Runtime errors (sync exceptions, unhandled rejections, console.error, failed
// fetches, resource load failures) are captured globally by _bridge/bridge.ts
// and displayed in a floating red overlay by <ErrorDisplay /> from @reusable.
// The slim ErrorBoundary below catches React render errors and forwards them
// into the same display so all errors flow through one UI.
const indexTsx = `import "../../_bridge/bridge";
import React from "react";
import { createRoot } from "react-dom/client";
import { ErrorDisplay } from "@reusable/ErrorDisplay";
import App from "./App";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state: { hasError: boolean } = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const stack =
      (error.stack ?? "") +
      (info.componentStack ? "\\n\\nComponent stack:" + info.componentStack : "");
    window.dispatchEvent(
      new CustomEvent("cobuild-error", {
        detail: {
          kind: "exception",
          message: error.message,
          stack,
          timestamp: Date.now(),
        },
      })
    );
  }

  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    <ErrorDisplay />
  </>
);
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
