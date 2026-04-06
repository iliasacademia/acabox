#!/usr/bin/env Rscript

suppressPackageStartupMessages(library(argparse))

source("/skills/differential-expression/scripts/differential_expression.R")

create_parser <- function() {
  p <- ArgumentParser(description="High-level modular DESeq2 pipeline with formula support (fast, parallel, offline gene annotation)")
  p$add_argument("--counts_file", required=TRUE, help="Count matrix CSV (col1: Ensembl IDs with version; others: sample IDs)")
  p$add_argument("--coldata_file", required=TRUE, help="CSV with 'sample_id' and variables")

  # Design specification: either simple variable or full formula
  p$add_argument("--design_variable", default=NULL,
                 help="Factor column in coldata (e.g., 'group'). Use this for simple single-factor designs. Mutually exclusive with --design_formula.")
  p$add_argument("--design_formula", default=NULL,
                 help="R-style design formula (e.g., '~ condition + batch' or '~ condition'). Use this for complex multi-factor designs. Mutually exclusive with --design_variable.")

  # Contrast specification
  p$add_argument("--denominator_level", default=NULL, help="Reference (denominator) level for contrast. Used with --design_variable or simple --design_formula.")
  p$add_argument("--numerator_level", default=NULL, help="Numerator level for contrast. Used with --design_variable or simple --design_formula.")
  p$add_argument("--contrast_factor", default=NULL,
                 help="Factor name for contrast when using complex --design_formula (e.g., 'condition' in '~ condition + batch'). If not specified, uses last term in formula.")

  # Filtering and thresholds
  p$add_argument("--min_count", type="integer", default=10, help="Prefilter: min count to consider expressed")
  p$add_argument("--min_samples", type="integer", default=3, help="Prefilter: min #samples meeting --min_count")
  p$add_argument("--alpha", type="double", default=0.05, help="Adjusted p-value cutoff")
  p$add_argument("--lfc_threshold", type="double", default=1.0, help="Abs log2FC threshold for significance")

  # Visualization parameters
  p$add_argument("--n_sig_genes", type="integer", default=50, help="Top significant genes for heatmap")
  p$add_argument("--pca_ntop", type="integer", default=500, help="Top variable genes for PCA")
  p$add_argument("--pca_intgroup", default=NULL,
                 help="Factor for PCA grouping/coloring. If not specified, uses design_variable or first term from design_formula.")

  # Shrinkage
  p$add_argument("--shrink", action="store_true", help="Apply log2FC shrinkage (off by default)")
  p$add_argument("--shrink_method", default="apeglm",
                 choices=c("apeglm","ashr","normal"),
                 help="Shrinkage method (default: apeglm)")

  # Annotation
  p$add_argument("--orgdb", default="org.Hs.eg.db", help="OrgDb for offline annotation (e.g., org.Hs.eg.db)")
  p$add_argument("--keytype", default="ENSEMBL", help="Keytype for OrgDb mapping (e.g., ENSEMBL)")

  # Performance
  p$add_argument("--n_cores", type="integer", default=1, help="Number of CPU cores/threads to use (default 1)")

  # Output
  p$add_argument("--outdir", required=TRUE, help="Output directory")
  p
}

validate_design_args <- function(args) {
  has_variable <- !is.null(args$design_variable)
  has_formula <- !is.null(args$design_formula)

  if (!has_variable && !has_formula) {
    stop("Must provide either --design_variable or --design_formula")
  }

  if (has_variable && has_formula) {
    stop("Cannot specify both --design_variable and --design_formula. Use one or the other.")
  }

  if (has_formula) {
    formula_str <- args$design_formula
    if (!grepl("^\\s*~", formula_str)) {
      stop("--design_formula must start with '~' (e.g., '~ condition' or '~ condition + batch')")
    }

    tryCatch(
      as.formula(formula_str),
      error = function(e) {
        stop("Invalid R formula syntax in --design_formula: ", formula_str, "\nError: ", conditionMessage(e))
      }
    )

    formula_obj <- as.formula(formula_str)
    formula_terms <- attr(terms(formula_obj), "term.labels")

    if (length(formula_terms) == 0) {
      stop("--design_formula must contain at least one term (e.g., '~ condition')")
    }

    args$formula_terms <- formula_terms
    args$is_simple_formula <- length(formula_terms) == 1
  } else {
    args$is_simple_formula <- TRUE
  }

  args
}

parse_args_or_die <- function() {
  args <- create_parser()$parse_args()
  if (!file.exists(args$counts_file)) stop("Counts file not found: ", args$counts_file)
  if (!file.exists(args$coldata_file)) stop("Coldata file not found: ", args$coldata_file)
  safe_dir_create(args$outdir)
  args <- validate_design_args(args)
  args
}

main <- function() {
  args <- parse_args_or_die()
  run_differential_expression(
    counts_file = args$counts_file,
    coldata_file = args$coldata_file,
    outdir = args$outdir,
    design_variable = args$design_variable,
    design_formula = args$design_formula,
    denominator_level = args$denominator_level,
    numerator_level = args$numerator_level,
    contrast_factor = args$contrast_factor,
    min_count = args$min_count,
    min_samples = args$min_samples,
    alpha = args$alpha,
    lfc_threshold = args$lfc_threshold,
    n_sig_genes = args$n_sig_genes,
    pca_ntop = args$pca_ntop,
    pca_intgroup = args$pca_intgroup,
    shrink = args$shrink,
    shrink_method = args$shrink_method,
    orgdb = args$orgdb,
    keytype = args$keytype,
    n_cores = args$n_cores
  )
}

main()
