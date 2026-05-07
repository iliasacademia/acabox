#!/usr/bin/env node

import { parseArgs } from "util";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, readdirSync } from "fs";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    template: { type: "string" },
    kernel: { type: "string" },
    description: { type: "string" },
    icon: { type: "string" },
  },
});

const workspaceDir = process.env.MINI_APP_WORKSPACE_DIR || process.cwd();
if (!values.name) {
  console.error("--name is required");
  process.exit(1);
}
if (!values.description) {
  console.error("--description is required");
  process.exit(1);
}
if (!values.icon) {
  console.error("--icon is required");
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

const baseDirName = toLowerCamelCase(values.name);
if (!baseDirName) {
  console.error("--name must contain at least one alphanumeric character");
  process.exit(1);
}

// Ensure the dirName is unique within `.applications/`. If the caller picks a
// name that already maps to an existing app dir, append a numeric suffix
// (`foo`, `foo2`, `foo3`, …) until we find a free slot. Without this, the
// scaffold would silently clobber the existing app — `mkdirSync` is a no-op on
// an existing dir and the subsequent `writeFileSync` / `cpSync` overwrite
// files in place. Uniqueness is enforced here so callers (agents, the user)
// don't have to predict collisions themselves.
let dirName = baseDirName;
let collisionSuffix = 2;
while (existsSync(join(workspaceDir, ".applications", dirName))) {
  dirName = `${baseDirName}${collisionSuffix}`;
  collisionSuffix++;
}
const miniAppDir = join(workspaceDir, ".applications", dirName);

mkdirSync(join(miniAppDir, "src"), { recursive: true });
mkdirSync(join(miniAppDir, "dist"), { recursive: true });
mkdirSync(join(miniAppDir, "output"), { recursive: true });
mkdirSync(join(miniAppDir, "input"), { recursive: true });

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

// Scaffold a canonical notebook.ipynb. Every app gets one, even non-kernel
// apps — the parameters cell is the durable, inspectable record of what the
// user configured. Templates may overwrite this with their own notebook.
const kernel = values.kernel || "python3";
const isR = kernel === "ir";
const assignmentOp = isR ? "<-" : "=";
const kernelDisplayName = isR ? "R" : "Python 3";
const kernelLanguage = isR ? "R" : "python";
const docMarkdown = [
  `# ${values.name}\n`,
  "\n",
  `This notebook backs the mini-app \`${dirName}\`.\n`,
  "\n",
  "Edit params via the app UI, or directly in the parameters cell below.\n",
  `Input files live under \`./input/<slot>/\` (i.e. inside this directory).\n`,
  "Paths in `params_json` are workspace-relative (`.applications/<dir>/...`),\n",
  "which is what the cobuild kernel and React app expect.\n",
];
const paramsSource = `params_json ${assignmentOp} '{}'`;
const notebook = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { name: kernel, display_name: kernelDisplayName, language: kernelLanguage },
    language_info: { name: kernelLanguage },
    cobuild: { version: 1, lastRun: null },
  },
  cells: [
    {
      id: "cobuild-doc",
      cell_type: "markdown",
      metadata: {},
      source: docMarkdown,
    },
    {
      id: "parameters",
      cell_type: "code",
      metadata: { tags: ["parameters"] },
      source: [paramsSource],
      execution_count: null,
      outputs: [],
    },
  ],
};
writeFileSync(
  join(miniAppDir, "notebook.ipynb"),
  JSON.stringify(notebook, null, 1) + "\n",
);

// Scaffold manifest.json. The Tools page reads this to render each app's title,
// icon, and description, and orders apps by lastOpened (most recent first).
const manifest = {
  name: values.name,
  description: values.description,
  icon: values.icon,
  lastOpened: null,
};
writeFileSync(
  join(miniAppDir, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);

// Copy template files if --template is specified.
//
// Templates mirror the deployed app's directory layout: anything inside
// `<template>/src/` lands in the new app's `src/`, anything else lands at the
// app root. So a template can ship `src/App.tsx`, `notebook.ipynb`,
// `scripts/foo.py`, `models/foo.pt`, `requirements.txt`, etc., and each file
// goes where it belongs without per-file special cases.
//
// `template.md` is documentation for the agent — it travels with the template
// source so it can be edited alongside the code, but it's intentionally
// excluded from the per-app copy.
if (values.template) {
  const templatesDir = join(workspaceDir, ".applications", "_templates", values.template);
  if (!existsSync(templatesDir)) {
    console.error(`Template directory not found: ${templatesDir}`);
    process.exit(1);
  }
  for (const entry of readdirSync(templatesDir)) {
    if (entry === "template.md") continue;
    const srcPath = join(templatesDir, entry);
    cpSync(srcPath, join(miniAppDir, entry), { recursive: true });
  }

  // Templates hardcode `const DIR_NAME = "<templateName>"` at the top of
  // src/App.tsx, and the rest of the file derives every input/output/notebook
  // path from that constant. If the new app's dirName differs (e.g. user picked
  // a different `--name`), the React side ends up reading and writing the wrong
  // directory — and the most common symptom is "run_metadata.json missing
  // after kernel run", because the kernel writes to `<dirName>/output/` but
  // App.tsx looks under the template's name. Rewrite the constant here so the
  // scaffolded app is correct without manual follow-up.
  const appTsxPath = join(miniAppDir, "src", "App.tsx");
  if (existsSync(appTsxPath)) {
    const original = readFileSync(appTsxPath, "utf8");
    const dirNameRe = /const\s+DIR_NAME\s*=\s*["'][^"']*["']/;
    if (dirNameRe.test(original)) {
      const updated = original.replace(dirNameRe, `const DIR_NAME = "${dirName}"`);
      if (updated !== original) writeFileSync(appTsxPath, updated);
    }
  }

  // NOTE: the script intentionally does NOT install template dependencies.
  // The host's BackgroundBuilder watches `.applications/<app>/requirements.txt`,
  // `package.json`, `r-packages.txt`, `apt-packages.txt`, and `setup/*.sh` and
  // runs the appropriate live install + container image rebuild as soon as those
  // files appear. Doing pip / setup runs here would race with that pipeline AND
  // block the agent's tool call for several minutes on cold containers. The
  // mini-app's own "Installing software…" UI surfaces install progress to the
  // user while the agent moves on to building the bundle and opening the app.
}

console.log(JSON.stringify({ name: values.name, dir_name: dirName, dir: miniAppDir }));
