#!/usr/bin/env node

import { parseArgs } from "util";
import { join } from "path";
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, readdirSync, symlinkSync } from "fs";
import { randomUUID } from "crypto";

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

// Working files (inputs/outputs) live OUTSIDE the code dir, under
// `tool-data/<dirName>/`, so deleting the tool (removing this app dir) never
// destroys the user's data. The code dir reaches them through relative symlinks
// (`input` -> ../../tool-data/<dirName>/input, likewise `output`), which keeps
// every existing path convention (`.applications/<dirName>/output/...`) working
// transparently. `mkdirSync` is a no-op if the data dir already exists, so a
// tool recreated with a prior name re-adopts its earlier data.
for (const sub of ["input", "output"]) {
  mkdirSync(join(workspaceDir, "tool-data", dirName, sub), { recursive: true });
  try {
    symlinkSync(join("..", "..", "tool-data", dirName, sub), join(miniAppDir, sub), "dir");
  } catch (err) {
    // If a stale entry exists, fall back to a plain dir so writes still work.
    if (err && err.code !== "EEXIST") {
      mkdirSync(join(miniAppDir, sub), { recursive: true });
    }
  }
}

// Scaffold index.html
//
// Three things make an app look like Acabox rather than like generic Tailwind,
// and all three live here:
//
//   1. `acabox.css` — DM Sans + IBM Plex Mono, the design tokens as CSS custom
//      properties, and the `ab-*` component classes. Shared out of `_vendor/`,
//      which the host force-refreshes on every boot.
//   2. The Tailwind theme extension below, which gives the tokens ergonomic
//      class names (`text-ink`, `bg-pale`, `border-line`).
//   3. The palette REMAP, which is the part that actually holds the line. An
//      agent writing React reaches for `text-gray-500` and `bg-blue-600` by
//      reflex; no amount of prose reliably suppresses that. Pointing those
//      exact class names at the Acabox ramp redirects the reflex instead of
//      fighting it, so even code written without reading the style guide comes
//      out on-palette.
const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <link rel="stylesheet" href="../../_vendor/acabox.css" />
  <script src="../../_vendor/tailwind.js"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            // Named tokens — prefer these in new code.
            ink: "#141413",
            text2: "#535366",
            text3: "#91919e",
            line: { DEFAULT: "#dddde2", soft: "#ebebee" },
            muted: "#c7c7cf",
            pale: "#f4f7fc",
            accent: { DEFAULT: "#0645b1", hover: "#0c3b8d", pressed: "#082f75" },
            success: "#05b01c",
            busy: "#fecf4c",

            // Reflex remap. Tailwind's own scales, re-pointed at the Acabox
            // ramp so the habitual class name lands on the right colour.
            gray: {
              50: "#f4f7fc", 100: "#f4f7fc", 200: "#ebebee", 300: "#dddde2",
              400: "#91919e", 500: "#91919e", 600: "#535366", 700: "#535366",
              800: "#141413", 900: "#141413", 950: "#141413",
            },
            slate: {
              50: "#f4f7fc", 100: "#f4f7fc", 200: "#ebebee", 300: "#dddde2",
              400: "#91919e", 500: "#91919e", 600: "#535366", 700: "#535366",
              800: "#141413", 900: "#141413", 950: "#141413",
            },
            blue: {
              50: "#f4f7fc", 100: "#f4f7fc", 200: "#dbe4f3", 300: "#b3c6e4",
              400: "#4c7bc9", 500: "#0645b1", 600: "#0645b1", 700: "#0c3b8d",
              800: "#082f75", 900: "#082f75", 950: "#082f75",
            },
            red: {
              50: "#fff2f2", 100: "#fff2f2", 200: "#f7d4d4", 300: "#e9a3a3",
              400: "#d15c5c", 500: "#b60000", 600: "#b60000", 700: "#8f0000",
              800: "#8f0000", 900: "#6b0000", 950: "#6b0000",
            },
            amber: {
              50: "#fffaeb", 100: "#fff3cc", 200: "#fee9a3", 300: "#fedf7a",
              400: "#fecf4c", 500: "#fecf4c", 600: "#c99b00", 700: "#8a6a00",
              800: "#6b5200", 900: "#4d3b00", 950: "#4d3b00",
            },
            green: {
              50: "#eefaf0", 100: "#d6f4dc", 200: "#a8e8b5", 300: "#6bd583",
              400: "#2ac04c", 500: "#05b01c", 600: "#05b01c", 700: "#048516",
              800: "#036611", 900: "#02470c", 950: "#02470c",
            },
          },
          fontFamily: {
            sans: ["DM Sans", "sans-serif"],
            mono: ["IBM Plex Mono", "monospace"],
          },
        },
      },
    };
  </script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
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
  "Input files live under `./input/<slot>/` and outputs under `./output/`.\n",
  "Those are symlinks into `tool-data/<dir>/`, so they survive if the tool is\n",
  "deleted. Paths in `params_json` are workspace-relative\n",
  "(`.applications/<dir>/...`), which is what the cobuild kernel and app expect.\n",
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
// creation_pending=true is the signal the main process's tool:opened handler
// uses to fire tool.created exactly once per genuinely new tool.
const manifest = {
  tool_id: randomUUID(),
  creation_pending: true,
  name: values.name,
  description: values.description,
  icon: values.icon,
  lastOpened: new Date().toISOString(),
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

  // The notebook's parameters cell may contain hardcoded paths referencing
  // the template's directory name (e.g. script_path, outdir). Rewrite those
  // so the notebook is correct out of the box — the host (useKernelAction)
  // overrides params_json at runtime, but the parameters cell is the fallback
  // when the notebook is run manually or when the agent's App.tsx omits keys.
  const notebookPath = join(miniAppDir, "notebook.ipynb");
  if (existsSync(notebookPath)) {
    const nbRaw = readFileSync(notebookPath, "utf8");
    const templateName = values.template;
    if (dirName !== templateName && nbRaw.includes(templateName)) {
      const updated = nbRaw.replaceAll(`.applications/${templateName}/`, `.applications/${dirName}/`);
      if (updated !== nbRaw) writeFileSync(notebookPath, updated);
    }
  }

  // NOTE: the script intentionally does NOT install template dependencies.
  // The host's BackgroundBuilder watches `.applications/<app>/requirements.txt`,
  // `package.json`, and `setup/*.sh` and runs the install into Acabox's Python
  // venv / npm prefix as soon as those files appear. Doing pip / setup runs here
  // would race with that pipeline AND block the agent's tool call for several
  // minutes on a first-time install. The
  // mini-app's own "Installing software…" UI surfaces install progress to the
  // user while the agent moves on to building the bundle and opening the app.
}

console.log(JSON.stringify({ name: values.name, dir_name: dirName, dir: miniAppDir }));
