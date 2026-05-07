# Western Blot Annotator Template

Tool for annotating lanes and antibodies on Western blot images. The user
uploads a TIFF/PNG/JPG blot, the template auto-detects membranes, lanes, and
band rows using a TorchScript GelGenie segmentation model, and exposes an
interactive editor for labeling antibodies and lanes, toggling rows on/off,
nudging band positions, and exporting a publication-ready PNG figure.

This file documents what's not visible by reading the template source. For
the actual code, see `src/App.tsx`, `notebook.ipynb`, `scripts/analyze.py`,
`requirements.txt`, and `setup/download_model.sh` next to this file.

## What ships with the template

The mirrored template tree is copied into the new app at scaffold time. The
host's BackgroundBuilder picks up the dep files asynchronously and installs
them in the live container while rebuilding the image — the agent should
not run installs itself.

| Path                               | Why it ships                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/App.tsx`                      | The interactive UI.                                                                                         |
| `notebook.ipynb`                   | Persistent state holder (params + outputs) **and** the `action`-tagged cell that runs `analyze.py` via the kernel.   |
| `scripts/analyze.py`               | GelGenie pipeline (segmentation → connected components → membrane / lane / band detection). Importable module; called from the action cell. |
| `requirements.txt`                 | Python deps for `analyze.py`: `torch`, `numpy`, `scipy`, `Pillow`. Installed by BackgroundBuilder when this file appears. |
| `setup/download_model.sh`          | Idempotent download of the GelGenie TorchScript checkpoint (~57MB) from HuggingFace into `models/`. Run by BackgroundBuilder via the `manual` install path. The model is intentionally **not** bundled in the repo — keep it that way to avoid bloating workspace setup. |

## What each parameter controls

Defaults and types live in `src/App.tsx` (`DEFAULTS` const, `Params`
interface). Semantic meaning:

| Parameter      | Meaning                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `input_image`  | Workspace-relative path to the blot image. TIFF / PNG / JPG accepted (Pillow handles all three).   |
| `font_size`    | Point size used for lane labels and antibody labels in the exported figure (8–28).                 |

## Compute architecture

The template follows the standard mini-app pattern: heavy compute lives in
the kernel-backed action cell, the UI uses `useKernelAction` to drive it,
and `output/run_metadata.json` is the one-shot handoff back to the
frontend. One deliberate exception:

- **LLM band/lane filtering stays on the frontend.** After the kernel run
  produces segmentation output, the React side calls
  `window.anthropicAPI.complete` with the visualization PNG and asks the
  LLM to filter low-quality band rows and identify ladder lanes
  (`filterBandsLLM` in `src/App.tsx`). This is treated as a UI helper,
  not core compute — it runs once per analysis, has no conversational
  context, and falls back gracefully (keep all bands, no ladders) if the
  call fails. **Don't try to fold this into the action cell unless you
  also wire Anthropic credentials into the kernel container.**

## Pipeline contract

The action cell in `notebook.ipynb` reads `params_json` (injected by
`useKernelAction.run()`), imports `scripts/analyze.py` as a module, and
calls `analyze.run(image_path, output_dir)`. The function:

1. Loads the image with Pillow (TIFF/PNG/JPG all supported).
2. Runs UNet segmentation with the TorchScript GelGenie checkpoint.
3. Extracts connected components → membranes → bands → lanes.
4. Renders a debug visualization with detection overlays.
5. Writes `output/run_metadata.json` with this shape:

```ts
{
  imageWidth: number,
  imageHeight: number,
  inverted: boolean,           // true if the input was light-on-dark and got inverted
  mask_path: string,           // relative path to gelgenie_mask.png
  visualization_path: string,  // relative path to gelgenie_visualization.png
  membranes: Array<{
    yStart: number, yEnd: number,
    contentXMin: number, contentXMax: number,
    laneXPositions: number[],  // px x-centers, in image coordinates
    laneCount: number,
    bands: Array<{ yCenter: number, yMin: number, yMax: number, componentCount: number }>,
  }>,
}
```

The frontend reads `run_metadata.json` via `readJsonOutput<AnalysisResult>`
exactly once after the kernel run completes.

Files written to `output/`:

- `run_metadata.json` — the standard handoff (above). Read once after the
  kernel run, never re-read during the session.
- `gelgenie_mask.png` — raw segmentation mask (debugging).
- `gelgenie_visualization.png` — input image with detection overlays
  (red boxes = components, yellow lines = band centers, cyan lines = lane
  positions). Sent to the LLM for filtering and shown in the editor.
- `western_blot_figure.png` — final assembled figure (only after the user
  hits Export).

## Why the App.tsx is shaped the way it is

Patterns to keep when editing:

- **Persistent state via `useAppState<Params, OutputFile>`** with
  `inputSlots: ["input_image"]`. The file picker, the `font_size` slider,
  and the output list rehydrate on remount. Per-membrane editor state
  (`configs`, `panelOrder`, `stripPlans`, `previewUrl`) is intentionally
  **session-local** — the segmentation re-runs cheaply and the LLM filter
  reseeds the labels from scratch each time, so persisting the editor
  state would just create staleness.
- **Kernel runs via `useKernelAction`.** The action cell is invoked
  through the standard hook; `buildKernelParams` passes `input_image`,
  `outdir`, and the `script_path` to the analyze module. Errors flow
  through the global `<ErrorDisplay>` panel — don't add a second error UI.
- **Three-step UI: `upload → processing → review`.** Driven by `setStep`.
  A picked file auto-fires `handleRun` for first-runs; the explicit
  `<RunButton>` in the upload step covers the retry case after errors.
  After a successful kernel run, the frontend loads the source image into
  a canvas, calls the LLM band filter, builds default configs, and
  transitions to "review".
- **Standard primitives only.** `<FileSlotPicker>` for upload,
  `<RunButton>` for the run trigger, `<OutputFileList>` for exports. No
  hand-rolled equivalents. `markRunComplete()` is called once after the
  kernel run succeeds — Export does not call it again.
- **Membrane-relative coordinates everywhere.** `analyze.py` reports
  positions in image coordinates; the React editor uses image-coordinate
  scaling so display width can change freely. `bandNudges` and
  `laneNudges` are stored in image px and applied at render time.
- **LLM prompt is in the App.** `filterBandsLLM` builds a structured
  prompt listing every detected component / lane and asks for boolean
  filters back. It's intentionally **schema-locked** to keep responses
  parseable; if you change the prompt, keep the response shape stable or
  update `LLMFilterResult` together.

## Setup steps for using this template

```bash
node \
  .claude/skills/manage-mini-application/scripts/manage_mini_app.mjs \
  --name "Western Blot Annotator" \
  --description "tool for annotating lanes and antibodies on Western blot images" \
  --icon "Microscope" \
  --template "westernBlotAnnotator"
```

The manage script just mirrors the template tree into
`.applications/<dirName>/` and exits. The host's BackgroundBuilder takes
over from there: it sees `requirements.txt` and runs
`pip install torch numpy scipy Pillow` in the live container, and it sees
`setup/download_model.sh` and runs it as a manual install (downloading the
GelGenie model into `models/unet_dec_21_finetune_epoch_590.pt`). Both
happen in parallel with the agent's next steps and can take 5–15 minutes
on a cold container.

**Do not block on the install.** Build the esbuild bundle (it only needs
Node packages, not Python) and call `open_mini_application` immediately.
The mini-app's "Installing software…" view will show install progress to
the user while they wait. The user may see kernel errors if they hit Run
before deps are ready — they should retry once the install indicator
clears.

If the new app's `dirName` is not `westernBlotAnnotator`, update
`DIR_NAME` in `src/App.tsx` to match — that constant is used to construct
input/output paths and to wire both `useAppState` and `useKernelAction`
to the right notebook.

Build with `esbuild` per the standard mini-app instructions in `SKILL.md`.
