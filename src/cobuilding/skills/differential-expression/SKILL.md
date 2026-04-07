---
name: differential-expression
description: >
  Run differential expression analysis using DESeq2 on RNA-seq count data.
  Use when the user asks about differential expression, DESeq2, RNA-seq
  analysis, gene expression comparisons, or comparing conditions/treatments
  in transcriptomic data. Can be invoked as a standalone CLI script or
  imported into an R notebook via source() to call run_differential_expression()
  programmatically. Performs filtering, normalization, model fitting,
  and generates publication-quality QC plots, differential expression
  visualizations, and result tables suitable for downstream pathway and
  enrichment analysis.
---

# Differential Expression Analysis (DESeq2)

This skill runs a pre-built R script that performs differential expression analysis using DESeq2.

## How to run

```bash
podman exec cobuilding-container Rscript .claude/skills/differential-expression/scripts/differential_expression_cli.R <args>
```

For example, if the user's counts file is at `./raw_counts.csv` and coldata is at `./sample_annotations.csv`:

```bash
podman exec cobuilding-container Rscript .claude/skills/differential-expression/scripts/differential_expression_cli.R \
  --counts_file ./raw_counts.csv \
  --coldata_file ./sample_annotations.csv \
  --design_variable group \
  --outdir ./de_results
```

## Using in an R notebook

The library script can be sourced into an R notebook running inside the container. It defines functions without any side effects, so only the `run_differential_expression()` function is loaded.

```r
source(".claude/skills/differential-expression/scripts/differential_expression.R")

results <- run_differential_expression(
  counts_file = "./raw_counts.csv",
  coldata_file = "./sample_annotations.csv",
  design_variable = "group",
  outdir = "./de_results"
)
```

The function accepts the same arguments as the CLI (see argument reference below) and returns an invisible list with:

- `dds` — DESeq2Dataset object
- `vsd` — Variance-stabilized data
- `results` — List of results dataframes (one per contrast)
- `norm_counts` — Annotated normalized counts matrix
- `mapping` — Gene symbol mapping
- `design_info` — Design information
- `data_files` — Registry of output data file paths
- `visualizations` — Registry of output visualization file paths
- `outdir` — Output directory path

## Required inputs

The user must provide two CSV files:

- **counts_file**: Count matrix CSV where the first column contains gene IDs (Ensembl IDs with version) and remaining columns are sample IDs. The counts must be un-normalized raw counts.
- **coldata_file**: Sample metadata CSV that must contain a `sample_id` column plus one or more factor columns describing experimental conditions.

## Design specification

The user must specify one of these (they are mutually exclusive):

- `--design_variable`: A single factor column name from coldata for simple single-factor designs (e.g. `group`, `condition`)
- `--design_formula`: An R-style formula for complex multi-factor designs (e.g. `~ condition + batch`)

## Full argument reference

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--counts_file` | Yes | — | Count matrix CSV |
| `--coldata_file` | Yes | — | Sample metadata CSV with `sample_id` column |
| `--outdir` | Yes | — | Output directory for all results |
| `--design_variable` | One of these | — | Factor column for simple designs |
| `--design_formula` | required | — | R-style formula for complex designs |
| `--contrast_factor` | No | last term in formula | Factor name for contrast when using design_formula |
| `--pca_intgroup` | No | design_variable or first formula term | Factor for PCA grouping/coloring |
| `--denominator_level` | No | auto-detected | Reference (denominator) level for contrast |
| `--numerator_level` | No | auto-detected | Numerator level for contrast |
| `--min_count` | No | 10 | Minimum count to consider a gene expressed |
| `--min_samples` | No | 3 | Minimum samples meeting min_count threshold |
| `--alpha` | No | 0.05 | Adjusted p-value cutoff for significance |
| `--lfc_threshold` | No | 1.0 | Absolute log2 fold change threshold |
| `--n_sig_genes` | No | 50 | Top significant genes for heatmap |
| `--pca_ntop` | No | 500 | Top variable genes for PCA |
| `--shrink` | No | false | Flag to enable log2FC shrinkage (pass flag with no value) |
| `--shrink_method` | No | apeglm | Shrinkage method: apeglm, ashr, or normal |
| `--orgdb` | No | org.Hs.eg.db | OrgDb package for gene annotation |
| `--keytype` | No | ENSEMBL | Keytype for OrgDb mapping |
| `--n_cores` | No | 1 | CPU cores for parallel processing |

## Performance

Leave `--n_cores` at the default of 1 unless the dataset is large (more than 20 samples and more than 30,000 genes). For small datasets, parallelism adds overhead that makes the script slower, not faster.

## Outputs

The script writes all outputs to the `--outdir` directory:

**Result tables:**
- `results_*.csv` — DE results for each contrast (baseMean, log2FoldChange, pvalue, padj, stat)
- `normalized_counts_annotated.csv` — Normalized counts with gene annotations
- `size_factors.csv` — DESeq2 size factors

**Visualizations (PNG + CSV):**

Every PNG plot also has a corresponding CSV file containing the data used to generate it:

- `dispersion_plot.png` / `dispersion_plot.csv` — Mean-dispersion relationship
- `pca_plot.png` / `pca_plot.csv` — PCA of variance-stabilized data
- `sample_distance_heatmap.png` / `sample_distance_heatmap.csv` — Sample distance heatmap
- `MA_plot.png` / `MA_plot.csv` — MA plot per contrast
- `volcano_plot.png` / `volcano_plot.csv` — Volcano plot per contrast
- Heatmap of top significant genes (if applicable), with corresponding CSV

**Summary:**
- `summary_text_for_llm.md` — Markdown summary with statistics and top gene tables
- `run_metadata.json` — Structured metadata
