# Differential Expression Mini-Application

## Overview

The differential expression mini-app provides an interactive UI for running DESeq2 analysis. The user fills in parameters and clicks "Run" to execute the analysis via a backing Jupyter notebook (R kernel). Results are displayed as summary stats, visualization images, and downloadable data files.

## Directory structure

```
<dir_name>/
  src/
    index.html        # Scaffolded by manage script
    index.tsx         # Scaffolded by manage script
    App.tsx           # Agent-written React component (copied from template)
  dist/
    bundle.js         # Compiled by esbuild
  output/             # Output directory for results
  notebook.ipynb      # Backing R notebook (created by agent via NotebookEdit)
```

## Parameter descriptions

| Parameter | Type | Default | UI Input | Description |
|-----------|------|---------|----------|-------------|
| `counts_file` | string | `""` | File picker | Count matrix CSV (Ensembl IDs in first column). Must be in workspace. |
| `coldata_file` | string | `""` | File picker | Sample metadata CSV with `sample_id` column. Must be in workspace. |
| `outdir` | string | auto | hidden | Output directory (always `.applications/<dir_name>/output`) |
| `design_variable` | string | `""` | text | Factor column in coldata (e.g., `"group"`). Used in single-variable mode. |
| `design_formula` | string | `""` | text | Full design formula (e.g., `"~ condition + batch"`). Used in formula mode. |
| `denominator_level` | string | `""` | text | Reference level for contrast (optional) |
| `numerator_level` | string | `""` | text | Treatment level for contrast (optional) |
| `min_count` | integer | `10` | number | Minimum count to consider a gene expressed |
| `min_samples` | integer | `3` | number | Minimum samples meeting min_count |
| `alpha` | number | `0.05` | number | Adjusted p-value significance cutoff |
| `lfc_threshold` | number | `1.0` | number | Absolute log2 fold-change cutoff |
| `shrink` | boolean | `false` | checkbox | Whether to apply LFC shrinkage (apeglm) |
| `orgdb` | string | `"org.Hs.eg.db"` | select | Organism annotation database |

All file paths passed to the notebook must be **relative** to the workspace (e.g., `./data/counts.csv`). The React app converts absolute host paths from file pickers to relative paths before injecting them into the notebook parameters.

## Notebook structure

Create the notebook at `<dir>/notebook.ipynb` using the `NotebookEdit` tool with the `ir` kernel. Two cells:

1. **Parameters cell** (cell id: `de-params`, tag: `parameters`):

```r
params_json <- '{"counts_file":"./data/counts.csv","coldata_file":"./data/coldata.csv", ...}'
```

2. **Action cell** (cell id: `de-run`, tag: `action`):

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
```

The `run_differential_expression()` function writes `run_metadata.json` to the output directory, along with visualization images and data CSVs.

## Run metadata format

The R script writes `run_metadata.json` to the output directory with this structure:

```json
{
  "summary_stats": {
    "n_genes_prefilter": 20000,
    "n_genes_postfilter": 15000,
    "n_samples": 6,
    "n_samples_numerator": 3,
    "n_samples_denominator": 3,
    "n_significant_genes": 500,
    "n_up_regulated_genes": 250,
    "n_down_regulated_genes": 250,
    "contrasts": ["treatment_vs_control"],
    "lfc_threshold": 1.0,
    "significance_threshold": 0.05,
    "date": "2026-04-08"
  },
  "visualizations": [
    {
      "name": "Volcano Plot",
      "description": "...",
      "visualization_type": "volcano",
      "image_file_path": ".applications/differentialExpression/output/volcano_plot.png",
      "data_file_path": ".applications/differentialExpression/output/volcano_plot.csv"
    }
  ],
  "data_files": [
    {
      "name": "DE Results",
      "description": "...",
      "file_path": ".applications/differentialExpression/output/de_results.csv",
      "artifact_type": "csv"
    }
  ]
}
```

File paths in `run_metadata.json` are relative to the workspace.

## Example App.tsx

The template `App.tsx` is automatically copied from `.applications/_templates/differentialExpression/App.tsx` when using `--template differentialExpression`. The key patterns:

- All parameter state lives in React `useState` with sensible defaults
- File pickers use `window.filesAPI.selectFile()` and paths are converted to relative paths via `toRelativePath()`
- On "Run", parameters are serialized to JSON and injected into the notebook's parameter cell via `window.kernel.executeCode()`
- The notebook's action cell is read from `notebook.ipynb` by cell ID and executed via `window.kernel.executeCode()`
- Results are read from `run_metadata.json` in the output directory
- Visualizations are displayed as images using `local-file://` protocol

## Setup steps

1. Run the manage script with the template:
```bash
node .claude/skills/manage-mini-application/scripts/manage_mini_app.mjs \
  --name "DE: Treatment vs Control" \
  --template "differentialExpression"
```

2. The template `App.tsx` and `notebook.ipynb` are copied automatically. Adapt as needed for the specific analysis.

3. Build the bundle:
```bash
podman exec cobuilding-container esbuild \
  .applications/<dir_name>/src/index.tsx \
  --bundle \
  --outfile=.applications/<dir_name>/dist/bundle.js \
  --jsx=automatic \
  --loader:.tsx=tsx \
  --loader:.ts=ts \
  --format=iife
```

4. Call `open_mini_application` with the returned `dir_name`.
