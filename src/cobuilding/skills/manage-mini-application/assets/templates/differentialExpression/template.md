# Differential Expression Mini-Application Template

Interactive DESeq2 analysis UI: file pickers, design configuration, parameter
tuning, interactive Plotly volcano/MA plots with adjustable thresholds, and
static visualizations (PCA, heatmaps). Backed by a Jupyter notebook running R.

This file documents what's not visible by reading the template source. For
the actual code, see `src/App.tsx` and `notebook.ipynb` next to this file.

## What each parameter controls

The defaults and types live in `src/App.tsx` (`DEFAULTS` const, `DEParams`
interface). The semantic meaning — which is what you actually need to know
when wiring up the UI or explaining a control to the user — is below.

| Parameter            | Meaning                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `counts_file`        | Count matrix CSV. First column is gene IDs (Ensembl). Workspace-relative path.                       |
| `coldata_file`       | Sample metadata CSV. Must contain a `sample_id` column. Workspace-relative path.                     |
| `outdir`             | Always `.applications/<dir_name>/output`; don't expose this control to the user.                     |
| `design_variable`    | Single-factor design: name of the column in `coldata_file` to test against.                          |
| `design_formula`     | Full formula mode: e.g. `~ condition + batch`. Mutually exclusive with `design_variable`.            |
| `denominator_level`  | Reference level for the contrast. Optional — leave empty to let DESeq2 pick alphabetically.          |
| `numerator_level`    | Treatment level for the contrast. Optional.                                                          |
| `min_count`          | Pre-filter: minimum count for a gene to be considered expressed.                                     |
| `min_samples`        | Pre-filter: minimum samples meeting `min_count`.                                                     |
| `alpha`              | Adjusted p-value cutoff for "significant".                                                           |
| `lfc_threshold`      | Absolute log2 fold-change cutoff. Used both by DESeq2 and by the post-run sliders.                   |
| `shrink`             | Apply `apeglm` LFC shrinkage. Slower, but better-behaved estimates for low-count genes.              |
| `orgdb`              | Organism annotation DB. `org.Hs.eg.db` (human) or `org.Mm.eg.db` (mouse).                            |

All file path params must be **workspace-relative**.

## R script output contract

The `run_differential_expression()` function lives in the
`differential-expression` skill (separate skill). It writes the following
into `outdir`:

- `run_metadata.json` — summary stats, visualization descriptors, data file
  entries. **Read once** by the template right after the kernel run, then
  split into `setOutputs(...)` / `setRunResult(...)` and never read again.
- `volcano_plot.csv`, `MA_plot.csv` — gene-level data for the interactive
  Plotly charts. Re-read on mount and after each run via `readPlotCsv`
  (small in-template helper) because they're too large to round-trip
  through notebook metadata.
- `volcano_plot.png`, `MA_plot.png`, `pca_plot.png`,
  `sample_distance_heatmap.png`, `dispersion_plot.png` — static images
  rendered in the visualization carousel.
- `DE_results.csv`, `normalized_counts_annotated.csv`, `size_factors.csv` —
  data files surfaced in `<OutputFileList>`.

If you need to change what gets written, edit the R script in the
`differential-expression` skill — not here.

## Why the App.tsx is shaped the way it is

Most of the patterns in `App.tsx` are **not** DE-specific — they're how
every mini-app is supposed to be built. Things to know before editing:

- **Persistent state via `useAppState<DEParams, OutputFile, DERunResult>`.**
  Every form param, file slot, output entry, and the structured run summary
  live in `notebook.ipynb` so the UI rehydrates on remount and on Electron
  restart. Do not introduce parallel `useState` for any of these.
- **Kernel runs via `useKernelAction`.** Connect / inject params / execute
  the action cell / dispatch errors all happen there. The local `runAnalysis`
  is just the post-run handler that reads `run_metadata.json` and forwards
  it into the hook.
- **Errors surface globally.** Kernel errors flow through the
  `<ErrorDisplay>` panel that `index.tsx` mounts automatically. Don't add a
  second app-local error display.
- **Standard UI primitives.** `<FileSlotPicker>`, `<RunButton>`,
  `<RunStateBadge>`, `<OutputFileList>`. No hand-rolled equivalents.
- **Threshold sliders are session-local.** The post-run `alpha` /
  `lfc_threshold` controls re-color points and update the
  upregulated/downregulated/n.s. badges without re-running. They are
  intentionally **not** persisted — they're a viewing tool, not a parameter.
- **`run_metadata.json` is a one-shot handoff.** Read once, fan out into
  `setOutputs` (data files) and `setRunResult` (summary stats +
  visualization descriptors), then never touched again. The hook's
  persisted state is what restores the UI later.

## Using this template

```bash
node \
  .claude/skills/manage-mini-application/scripts/manage_mini_app.mjs \
  --name "DE: Treatment vs Control" \
  --description "DESeq2 analysis with interactive volcano/MA plots" \
  --icon "Dna" \
  --template "differentialExpression"
```

`App.tsx` and `notebook.ipynb` are copied into the new app. Build with
`esbuild` per the standard mini-app instructions in `SKILL.md`.
