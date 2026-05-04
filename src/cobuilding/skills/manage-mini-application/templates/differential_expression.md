# Differential Expression Mini-Application

## Overview

Interactive DESeq2 analysis UI with file pickers, design configuration, parameter tuning, interactive Plotly volcano/MA plots with adjustable thresholds, and static visualizations (PCA, heatmaps). Results are backed by a Jupyter notebook running R.

## Directory structure

```
<dir_name>/
  src/
    index.html        # Scaffolded by manage script
    index.tsx         # Scaffolded by manage script (includes error boundary)
    App.tsx           # Copied from template
  dist/
    bundle.js         # Compiled by esbuild
  output/             # Results written here by the R script
  notebook.ipynb      # Backing R notebook
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `counts_file` | string | `""` | Count matrix CSV (Ensembl IDs in first column). Must be in workspace. |
| `coldata_file` | string | `""` | Sample metadata CSV with `sample_id` column. Must be in workspace. |
| `outdir` | string | auto | Always `.applications/<dir_name>/output` |
| `design_variable` | string | `""` | Factor column in coldata (single-variable mode) |
| `design_formula` | string | `""` | Full design formula, e.g. `~ condition + batch` (formula mode) |
| `denominator_level` | string | `""` | Reference level for contrast (optional) |
| `numerator_level` | string | `""` | Treatment level for contrast (optional) |
| `min_count` | integer | `10` | Minimum count to consider a gene expressed |
| `min_samples` | integer | `3` | Minimum samples meeting min_count |
| `alpha` | number | `0.05` | Adjusted p-value significance cutoff |
| `lfc_threshold` | number | `1.0` | Absolute log2 fold-change cutoff |
| `shrink` | boolean | `false` | Apply LFC shrinkage (apeglm) |
| `orgdb` | string | `"org.Hs.eg.db"` | Organism annotation database (Human or Mouse) |

All file paths passed to the notebook must be **relative** to the workspace.

## Notebook structure

Create at `<dir>/notebook.ipynb` using `NotebookEdit` with the `ir` kernel. Two cells:

1. **Parameters cell** (id: `de-params`, tag: `parameters`):

```r
params_json <- '{"counts_file":"./data/counts.csv","coldata_file":"./data/coldata.csv", ...}'
```

2. **Action cell** (id: `de-run`, tag: `action`):

```r
source(".claude/skills/differential-expression/scripts/differential_expression.R")

params <- jsonlite::fromJSON(params_json)

results <- run_differential_expression(
  counts_file = params$counts_file,
  coldata_file = params$coldata_file,
  outdir = params$outdir,
  design_variable = params$design_variable,
  design_formula = params$design_formula,
  denominator_level = params$denominator_level,
  numerator_level = params$numerator_level,
  min_count = params$min_count,
  min_samples = params$min_samples,
  alpha = params$alpha,
  lfc_threshold = params$lfc_threshold,
  shrink = params$shrink,
  orgdb = params$orgdb
)

result_info <- list(
  status = "success",
  files = list(
    volcano_plot = file.path(params$outdir, "volcano_plot.csv"),
    ma_plot = file.path(params$outdir, "MA_plot.csv")
  )
)
jsonlite::write_json(result_info, file.path(params$outdir, "results.json"), auto_unbox = TRUE)
```

## R script outputs

The `run_differential_expression()` function writes to the output directory:

- `run_metadata.json` — summary stats, visualization entries, data file entries. Used by the React template as a one-shot data handoff after the kernel run; its contents are then split into the hook's `setOutputs` / `setRunResult` and never read from disk again.
- `volcano_plot.csv` / `MA_plot.csv` — gene-level data read by the interactive Plotly charts
- `volcano_plot.png` / `MA_plot.png` — static plot images
- `pca_plot.png`, `sample_distance_heatmap.png`, `dispersion_plot.png` — other visualizations
- `DE_results.csv`, `normalized_counts_annotated.csv`, `size_factors.csv` — data files

## Template App.tsx patterns

The template `App.tsx` (copied from `.applications/_templates/differentialExpression/App.tsx`) uses:

- **Persistent state**: `useAppState<DEParams, OutputFile, DERunResult>` — all form params, file paths, output list, and the structured run summary live in `notebook.ipynb`. **This is the same pattern every mini-app uses; DE is not a special case.**
- **File pickers**: `<FileSlotPicker state={state} slot="counts_file" label="..." filters={CSV_FILTER} />` for both CSV inputs. No hand-rolled picker UI.
- **Kernel execution**: `useKernelAction({ dirName, kernel: "ir", buildKernelParams: () => ({...}) })` handles connect / inject / execute / error dispatch. `runAnalysis` is a short post-run handler that reads `run_metadata.json` and feeds the hook.
- **Run button**: `<RunButton action={action} onRun={handleRun} disabled={!canRun}>Run Analysis</RunButton>` — gets spinner, elapsed timer, and disabled state from the action object. No custom button JSX.
- **Errors**: Kernel errors flow through the global `<ErrorDisplay>` panel auto-mounted by `index.tsx` (with a "Fix" button that drops the error into the chat). The template has no app-local error display.
- **Staleness**: `<RunStateBadge freshness={freshness} />` shows the amber "out of date" pill when params change after a run.
- **Output files**: `<OutputFileList files={outputs} outputDir={OUTPUT_DIR} />` reads directly from the hook's persisted `outputs`.
- **Structured run result**: `runResult` (hydrated by the hook) holds summary stats + visualization descriptors. Used to render the summary cards, the static-viz carousel, and the contrasts list.
- **Interactive charts**: Per-row CSV data (`volcano_plot.csv` / `MA_plot.csv`) is too large for notebook metadata, so it's re-read from `output/` on mount + after each run via `readPlotCsv` (a small in-template helper around `readFile`).
- **Post-run threshold controls**: log2FC and alpha sliders re-color plot points and update upregulated/downregulated/not-significant badges without re-running the analysis. Session-local — not persisted.
- **`run_metadata.json`**: One of the R script's standard output files. The template uses `readJsonOutput<RunMetadataFile>(...)` to read it **once** right after the kernel run, then translates it into the standard hook slots: `data_files` → `setOutputs(...)`, `summary_stats` + `visualizations` → `setRunResult(...)`. **Never read again** — persisted hook state restores the UI on remount.

## Setup steps

1. Run the manage script with the template:
```bash
node \
  .claude/skills/manage-mini-application/scripts/manage_mini_app.mjs \
  --name "DE: Treatment vs Control" \
  --template "differentialExpression"
```

2. The template `App.tsx` and `notebook.ipynb` are copied automatically. Adapt as needed.

3. Build the bundle:
```bash
esbuild \
  .applications/<dir_name>/src/index.tsx \
  --bundle \
  --outfile=.applications/<dir_name>/dist/bundle.js \
  --jsx=automatic \
  --loader:.tsx=tsx \
  --loader:.ts=ts \
  --format=iife \
  --alias:@reusable=/data/.applications/_reusable
```

4. Call `open_mini_application` with the returned `dir_name`.
