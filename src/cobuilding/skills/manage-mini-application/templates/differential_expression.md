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

- `run_metadata.json` — summary stats, visualization entries, data file entries
- `volcano_plot.csv` / `MA_plot.csv` — gene-level data read by the interactive Plotly charts
- `volcano_plot.png` / `MA_plot.png` — static plot images
- `pca_plot.png`, `sample_distance_heatmap.png`, `dispersion_plot.png` — other visualizations
- `DE_results.csv`, `normalized_counts_annotated.csv`, `size_factors.csv` — data files

## Template App.tsx patterns

The template `App.tsx` (copied from `.applications/_templates/differentialExpression/App.tsx`) uses:

- **Reusable components**: Imports `VolcanoPlot`, `MAPlot`, `parseCsvLine` from `@reusable`
- **Interactive charts**: After run, reads `volcano_plot.csv` and `MA_plot.csv`, parses into `VolcanoGene[]` arrays, renders interactive Plotly scatter plots with hover tooltips and gene labels
- **Post-run threshold controls**: Adjustable log2FC and alpha sliders re-color plot points and update summary badges (upregulated/downregulated/not significant counts) without re-running the analysis
- **Static visualizations**: PCA, heatmaps, and other plots displayed as images from `run_metadata.json`
- **File pickers**: `window.filesAPI.selectFile()` with paths converted to relative via `toRelativePath()`
- **Kernel execution**: Parameters serialized to JSON, injected into notebook parameter cell, action cell read by ID and executed

## Setup steps

1. Run the manage script with the template:
```bash
podman exec cobuilding-container node \
  .claude/skills/manage-mini-application/scripts/manage_mini_app.mjs \
  --name "DE: Treatment vs Control" \
  --template "differentialExpression"
```

2. The template `App.tsx` and `notebook.ipynb` are copied automatically. Adapt as needed.

3. Build the bundle:
```bash
podman exec cobuilding-container esbuild \
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
