#!/usr/bin/env Rscript

suppressPackageStartupMessages({
  library(data.table)
  library(dplyr)
  library(tibble)
  library(stringr)
  library(ggplot2)
  library(DESeq2)
  library(SummarizedExperiment)
  library(jsonlite)
  library(tidyr)
  library(AnnotationDbi)
  library(BiocParallel)
  library(patchwork)
})

# =========================
# Utilities
# =========================

strip_ensembl_version <- function(x) sub("\\.\\d+$","", x)
safe_dir_create <- function(d) if (!dir.exists(d)) dir.create(d, recursive=TRUE, showWarnings=FALSE)
`%||%` <- function(a,b) if(!is.null(a)) a else b
.row_vars <- function(mat) {
  if (is.null(dim(mat)) || nrow(mat) == 0L) return(numeric(0))
  apply(mat, 1, function(v) stats::var(as.numeric(v), na.rm = TRUE))
}

classify_sig <- function(df, alpha, lfc_thr) {
  df %>%
    mutate(
      status = case_when(
        !is.na(padj) & padj <= alpha & log2FoldChange >=  lfc_thr ~ "up",
        !is.na(padj) & padj <= alpha & log2FoldChange <= -lfc_thr ~ "down",
        TRUE ~ "ns"
      ),
      status = factor(status, levels = c("down","ns","up"))
    )
}

gene_colors <- c(down = "blue", ns = "grey70", up = "red")

# ---------- threading / parallel ----------
configure_threads <- function(n_cores) {
  n_cores <- max(1L, as.integer(n_cores))
  # data.table threads
  data.table::setDTthreads(n_cores)
  # BLAS / OpenMP if available (optional)
  if (requireNamespace("RhpcBLASctl", quietly = TRUE)) {
    RhpcBLASctl::blas_set_num_threads(n_cores)
    RhpcBLASctl::omp_set_num_threads(n_cores)
  }
  # BiocParallel backend
  bp <- if (n_cores > 1L) {
    if (.Platform$OS.type == "windows") {
      SnowParam(workers = n_cores, type = "SOCK", progressbar = FALSE)
    } else {
      MulticoreParam(workers = n_cores, progressbar = FALSE)
    }
  } else {
    SerialParam()
  }
  BiocParallel::register(bp, default = TRUE)
  bp
}

# =========================
# I/O + prep
# =========================

load_and_validate_inputs <- function(counts_file, coldata_file) {
  message("Reading inputs (CSV via fread)...")
  counts_df <- data.table::fread(counts_file, sep = ",", data.table = FALSE,
                                 na.strings = c("", "NA"), check.names = FALSE)
  coldata   <- data.table::fread(coldata_file, sep = ",", data.table = FALSE,
                                 na.strings = c("", "NA"), check.names = FALSE)

  if (ncol(counts_df) < 2) stop("Counts file must have gene_id column + >=1 sample columns.")
  if (!"sample_id" %in% names(coldata)) stop("coldata must contain 'sample_id'.")

  gene_col <- names(counts_df)[1]
  rownames(counts_df) <- counts_df[[gene_col]]
  counts_df[[gene_col]] <- NULL

  non_num <- !vapply(counts_df, is.numeric, logical(1))
  if (any(non_num)) {
    suppressWarnings({
      counts_df[non_num] <- lapply(counts_df[non_num], function(x) as.numeric(as.character(x)))
    })
  }

  counts_mat <- as.matrix(counts_df)

  if (anyNA(counts_mat)) {
    idx <- which(is.na(counts_mat), arr.ind = TRUE)
    stop(sprintf("NA/Non-numeric entries in count matrix (first few row,col): %s ...",
                 paste(utils::head(apply(idx, 1, paste, collapse=","), 5), collapse="; ")))
  }
  if (any(counts_mat < 0)) stop("Negative counts found; invalid for DESeq2.")

  if (max(abs(counts_mat - round(counts_mat))) > 1e-8) {
    warning("Counts not strictly integer-valued; rounding to nearest integer.")
    counts_mat <- round(counts_mat)
  }

  list(counts_mat = counts_mat, coldata = coldata)
}

align_samples_or_die <- function(counts_mat, coldata) {
  common <- intersect(colnames(counts_mat), coldata$sample_id)
  if (length(common) == 0) stop("No overlapping samples between counts and coldata$sample_id.")

  if (length(common) < ncol(counts_mat)) {
    drop_c <- setdiff(colnames(counts_mat), coldata$sample_id)
    warning(sprintf("Dropping %d count columns not present in coldata: %s",
                    length(drop_c), paste(drop_c, collapse=", ")))
  }
  if (length(common) < nrow(coldata)) {
    drop_r <- setdiff(coldata$sample_id, colnames(counts_mat))
    warning(sprintf("Dropping %d coldata rows without counts: %s",
                    length(drop_r), paste(drop_r, collapse=", ")))
  }

  coldata2 <- coldata %>% filter(sample_id %in% common) %>% distinct(sample_id, .keep_all=TRUE)
  counts2  <- counts_mat[, coldata2$sample_id, drop=FALSE]
  stopifnot(identical(colnames(counts2), coldata2$sample_id))
  list(counts_mat=counts2, coldata=coldata2)
}

process_genes <- function(counts_mat, min_count=10, min_samples=3) {
  base_ids <- strip_ensembl_version(rownames(counts_mat))
  if (any(duplicated(base_ids))) {
    message("Aggregating duplicate Ensembl IDs (after stripping version) by sum...")
    df <- as.data.frame(counts_mat) %>% mutate(.gene = base_ids)
    agg <- df %>% group_by(.gene) %>%
      summarise(across(everything(), ~ sum(.x, na.rm=TRUE)), .groups="drop") %>% as.data.frame()
    rownames(agg) <- agg$.gene; agg$.gene <- NULL
    counts_mat <- as.matrix(agg)
  } else {
    rownames(counts_mat) <- base_ids
  }

  keep <- rowSums(counts_mat >= min_count) >= min_samples
  if (!any(keep)) stop("Filtering removed all genes; lower --min_count / --min_samples.")
  if (sum(!keep) > 0) message(sprintf("Filtered %d low-information genes; %d remain.",
                                      sum(!keep), sum(keep)))
  counts_mat[keep, , drop=FALSE]
}

# =========================
# Offline annotation (OrgDb)
# =========================

load_orgdb_or_die <- function(orgdb_pkg) {
  if (!requireNamespace(orgdb_pkg, quietly = TRUE)) {
    stop("OrgDb package '", orgdb_pkg, "' is not installed. Install it with: BiocManager::install('", orgdb_pkg, "')")
  }
  suppressPackageStartupMessages(require(orgdb_pkg, character.only = TRUE))
  obj <- get(orgdb_pkg, envir = as.environment(paste0("package:", orgdb_pkg)))
  if (!inherits(obj, "OrgDb")) stop("Loaded object from ", orgdb_pkg, " is not an OrgDb.")
  obj
}

# Map IDs once, reuse everywhere
map_ids_offline <- function(ids, orgdb_pkg = "org.Hs.eg.db", keytype = "ENSEMBL") {
  orgdb <- load_orgdb_or_die(orgdb_pkg)
  keys <- unique(ids)
  raw <- AnnotationDbi::select(orgdb,
                               keys = keys,
                               keytype = keytype,
                               columns = c("SYMBOL","GENENAME","ENTREZID"))
  colnames(raw)[colnames(raw) == keytype] <- "row_id"
  map <- raw %>%
    mutate(
      SYMBOL   = ifelse(!is.na(SYMBOL) & SYMBOL != "", SYMBOL, NA_character_),
      GENENAME = ifelse(!is.na(GENENAME) & GENENAME != "", GENENAME, NA_character_),
      ENTREZID = ifelse(!is.na(ENTREZID) & ENTREZID != "", ENTREZID, NA_character_)
    ) %>%
    arrange(row_id, is.na(ENTREZID), is.na(SYMBOL), is.na(GENENAME)) %>%
    distinct(row_id, .keep_all = TRUE) %>%
    dplyr::select(row_id, ENTREZID, SYMBOL, GENENAME)
  tibble(row_id = keys) %>% left_join(map, by = "row_id")
}


annotate_results_list_with_map <- function(res_list, mapping) {
  lapply(res_list, function(df) {
    df %>%
      left_join(mapping, by = "row_id") %>%
      relocate(row_id, ENTREZID, SYMBOL, GENENAME, .before = 1)
  })
}


annotate_counts_matrix_with_map <- function(norm_counts, mapping) {
  as.data.frame(norm_counts) %>%
    rownames_to_column("row_id") %>%
    left_join(mapping, by = "row_id") %>%
    relocate(row_id, ENTREZID, SYMBOL, GENENAME)
}

# =========================
# DESeq2 (parallel aware, with formula support)
# =========================

run_deseq <- function(counts_mat, coldata,
                      design_variable = NULL, design_formula = NULL,
                      denominator_level = NULL, numerator_level = NULL,
                      contrast_factor = NULL,
                      alpha = 0.05, shrink = FALSE, shrink_method = "apeglm",
                      bpparam = SerialParam()) {

  # Determine design approach
  use_formula <- !is.null(design_formula)

  if (use_formula) {
    message("Using design formula: ", design_formula)
    design <- as.formula(design_formula)

    # Extract terms from formula
    formula_terms <- attr(terms(design), "term.labels")
    is_simple <- length(formula_terms) == 1

    # Determine the contrast factor
    if (is.null(contrast_factor)) {
      # Use the last term in the formula as the contrast factor
      contrast_factor <- formula_terms[length(formula_terms)]
      message("No --contrast_factor specified; using last formula term: '", contrast_factor, "'")
    } else {
      # Validate that contrast_factor is in the formula
      if (!contrast_factor %in% formula_terms) {
        stop("--contrast_factor '", contrast_factor, "' not found in design formula terms: ",
             paste(formula_terms, collapse=", "))
      }
    }

    # Validate that contrast_factor exists in coldata
    if (!contrast_factor %in% names(coldata)) {
      stop("Contrast factor '", contrast_factor, "' not found in coldata columns.")
    }

    # Ensure all formula terms exist in coldata and are factors
    for (term in formula_terms) {
      if (!term %in% names(coldata)) {
        stop("Formula term '", term, "' not found in coldata columns.")
      }
      if (!is.factor(coldata[[term]])) {
        coldata[[term]] <- as.factor(coldata[[term]])
        message("Converted '", term, "' to factor.")
      }
    }

    main_factor <- contrast_factor

  } else {
    # Traditional design_variable approach
    message("Using design variable: ", design_variable)
    if (!design_variable %in% names(coldata)) {
      stop("design_variable '", design_variable, "' not found in coldata.")
    }
    coldata[[design_variable]] <- as.factor(coldata[[design_variable]])
    design <- as.formula(paste("~", design_variable))
    main_factor <- design_variable
    is_simple <- TRUE
  }

  # Validate main factor has at least 2 levels
  lvls <- levels(coldata[[main_factor]])
  if (length(lvls) < 2) {
    stop("Contrast factor '", main_factor, "' must have >=2 levels.")
  }

  # Handle denominator and numerator levels
  denom <- denominator_level
  numer <- numerator_level

  if (is.null(denom) && length(lvls) == 2) {
    denom <- lvls[1]
    message("No denominator_level provided; using '", denom, "' as reference.")
  }
  if (is.null(numer) && length(lvls) == 2) {
    numer <- setdiff(lvls, denom)[1]
    message("No numerator_level provided; using '", numer, "' as numerator.")
  }
  if (!is.null(denom) && !(denom %in% lvls)) {
    stop("denominator_level '", denom, "' not in factor levels: ", paste(lvls, collapse=", "))
  }
  if (!is.null(numer) && !(numer %in% lvls)) {
    stop("numerator_level '", numer, "' not in factor levels: ", paste(lvls, collapse=", "))
  }

  # Set reference level for main factor
  if (!is.null(denom)) {
    coldata[[main_factor]] <- stats::relevel(coldata[[main_factor]], ref=denom)
  }

  use_parallel <- BiocParallel::bpnworkers(bpparam) > 1L

  # Create DESeq2 dataset with the design
  dds <- DESeqDataSetFromMatrix(countData=counts_mat, colData=coldata, design=design)
  dds <- DESeq(dds, parallel = use_parallel, BPPARAM = bpparam)
  vsd <- vst(dds)  # blind=TRUE by default
  norm_counts <- counts(dds, normalized=TRUE)

  # Extract results
  res_list <- list()

  if (!is.null(denom) && !is.null(numer)) {
    # Specific contrast requested
    res_list[[paste0(numer,"_vs_",denom)]] <-
      get_results(dds, main_factor, numer, denom, alpha, shrink, shrink_method,
                  use_parallel, bpparam, use_formula = use_formula)
  } else {
    # All pairwise comparisons vs reference
    ref <- levels(coldata[[main_factor]])[1]
    for (lvl in setdiff(levels(coldata[[main_factor]]), ref)) {
      res_list[[paste0(lvl,"_vs_",ref)]] <-
        get_results(dds, main_factor, lvl, ref, alpha, shrink, shrink_method,
                    use_parallel, bpparam, use_formula = use_formula)
    }
  }

  list(dds=dds, vsd=vsd, norm_counts=norm_counts, results=res_list, coldata=coldata,
       main_factor=main_factor, design_formula=design, is_formula_based=use_formula,
       numerator_level=numer, denominator_level=denom)
}

get_results <- function(dds, var, numer, denom, alpha, shrink, shrink_method,
                        use_parallel, bpparam, use_formula = FALSE) {
  # Always compute the standard results first (has 'stat' for Wald test)
  res0 <- results(dds, contrast = c(var, numer, denom), alpha = alpha,
                  parallel = use_parallel, BPPARAM = bpparam)

  res <- res0
  if (isTRUE(shrink)) {
    method <- shrink_method
    if (method %in% c("apeglm","ashr")) {
      if (!requireNamespace(method, quietly = TRUE)) {
        warning(sprintf("Requested shrink_method='%s' not installed; falling back to 'normal'.", method))
        method <- "normal"
      }
    }
    coef_name <- paste0(var, "_", numer, "_vs_", denom)
    res <- tryCatch(
      lfcShrink(dds, coef = coef_name, type = method),
      error = function(e) { warning("lfcShrink failed: ", conditionMessage(e)); res0 }
    )
  }

  # Build DF first (no arrange yet)
  df <- as.data.frame(res) %>%
    rownames_to_column("row_id") %>%
    mutate(
      ensembl_id          = row_id,
      ensembl_id_stripped = strip_ensembl_version(row_id)
    )

  # Ensure 'stat' column always present; if missing, borrow from res0
  if (!"stat" %in% names(df)) {
    stat0 <- as.data.frame(res0)$stat
    names(stat0) <- rownames(res0)
    df$stat <- unname(stat0[df$row_id])
  }

  df %>% arrange(padj)
}


# =========================
# Plots
# =========================

# Dispersion plot
run_dispersion <- function(dds, outdir, register_visualization) {
  mcols_df <- as.data.frame(mcols(dds, use.names = TRUE))
  if (!all(c("baseMean","dispersion") %in% names(mcols_df))) {
    warning("Dispersion metadata not available; skipping dispersion plot.")
    return(invisible(NULL))
  }
  df <- tibble(
    gene_id    = rownames(mcols_df),
    baseMean   = mcols_df$baseMean,
    dispFit    = mcols_df$dispFit %||% NA_real_,
    dispFinal  = mcols_df$dispersion
  ) %>% mutate(log10mean = log10(baseMean + 1))

  gg <- ggplot(df, aes(x = log10mean, y = dispFinal)) +
    geom_point(alpha = 0.35, size = 0.6, color = "grey40", na.rm = TRUE) +
    theme_bw() +
    xlab("log10(baseMean + 1)") +
    ylab("Dispersion") +
    ggtitle("Mean–Dispersion Relationship")
  fit_df <- df %>% filter(is.finite(dispFit)) %>% arrange(log10mean)
  if (nrow(fit_df) > 0) gg <- gg + geom_line(data = fit_df, aes(y = dispFit), linewidth = 0.8, color = "black")

  ggsave(file.path(outdir, "dispersion_plot.png"), plot = gg, width = 7, height = 5, dpi = 300)
  write.csv(df, file.path(outdir, "dispersion_plot.csv"), row.names = FALSE)
  register_visualization("dispersion_plot",
                        "Mean-dispersion relationship showing gene-wise dispersion estimates and fitted trend",
                        "differential_expression_dispersion_plot",
                        NULL,
                        "dispersion_plot.png", "dispersion_plot.csv")
}

run_pca <- function(vsd, intgroup, outdir, ntop = 500, register_visualization) {
  mat <- assay(vsd)
  has_group <- intgroup %in% colnames(colData(vsd))
  if (!has_group) warning("'", intgroup, "' not found in colData; PCA will omit group aesthetics.")

  rv <- .row_vars(mat)
  if (length(rv) < 2) { warning("Not enough rows for PCA."); return(invisible(NULL)) }
  ntop <- max(2, min(ntop, length(rv)))
  sel <- order(rv, decreasing = TRUE)[seq_len(ntop)]
  sel <- sel[is.finite(rv[sel]) & rv[sel] > 0]
  if (length(sel) < 2) { warning("No variable rows for PCA after filtering."); return(invisible(NULL)) }

  pca <- stats::prcomp(t(mat[sel, , drop = FALSE]), center = TRUE, scale. = FALSE)
  percentVar <- (pca$sdev^2) / sum(pca$sdev^2)

  df <- data.frame(
    sample = colnames(mat),
    PC1 = pca$x[, 1],
    PC2 = pca$x[, 2],
    group = if (has_group) as.factor(colData(vsd)[[intgroup]]) else factor("group"),
    PC1_variance = percentVar[1],
    PC2_variance = percentVar[2]
  )

  g <- if (has_group) {
    ggplot(df, aes(PC1, PC2, color = group, shape = group)) +
      geom_point(size = 2, alpha = 0.9) +
      labs(color = intgroup, shape = intgroup)
  } else {
    ggplot(df, aes(PC1, PC2)) +
      geom_point(size = 2, alpha = 0.9, color = "grey40")
  }

  g <- g +
    theme_bw() +
    xlab(paste0("PC1: ", round(percentVar[1] * 100), "%")) +
    ylab(paste0("PC2: ", round(percentVar[2] * 100), "%")) +
    ggtitle("PCA (VST)")

  ggsave(file.path(outdir, "pca_plot.png"), plot = g, width = 7, height = 5, dpi = 300)
  write.csv(df, file.path(outdir, "pca_plot.csv"), row.names = FALSE)
  register_visualization("pca_plot",
                        "Principal component analysis of variance-stabilized transformed data",
                        "differential_expression_pca_plot",
                        NULL,
                        "pca_plot.png", "pca_plot.csv")
}

# Sample distance heatmap
run_sample_distance_heatmap <- function(vsd, coldata, intgroup, outdir, register_visualization) {
  # --- distance matrix ---
  d <- dist(t(assay(vsd)))
  m <- as.matrix(d)
  if (nrow(m) == 0) { warning("No samples for distance heatmap."); return(invisible(NULL)) }

  # --- harmonized ordering: by group, then sample_id (matches run_heatmap) ---
  has_group <- intgroup %in% names(coldata)
  if (has_group) {
    coldata_ord <- coldata %>%
      mutate(.grp = as.factor(.data[[intgroup]])) %>%
      arrange(.grp, sample_id)
    sample_order <- coldata_ord$sample_id
    ann_df <- coldata_ord %>% dplyr::select(sample = sample_id, group = .grp)
  } else {
    warning("'", intgroup, "' not found in coldata; ordering by sample_id only and omitting group bar.")
    sample_order <- sort(coldata$sample_id)
    ann_df <- NULL
  }

  # keep intersection and reorder rows/cols of distance matrix
  sample_order <- sample_order[sample_order %in% colnames(m)]
  if (length(sample_order) < 2) { warning("Fewer than 2 samples after ordering; skipping."); return(invisible(NULL)) }
  m <- m[sample_order, sample_order, drop = FALSE]

  # --- long form for tiles ---
  df <- as.data.frame(m) %>%
    tibble::rownames_to_column("sample_i") %>%
    tidyr::pivot_longer(-sample_i, names_to = "sample_j", values_to = "distance")
  df$sample_i <- factor(df$sample_i, levels = sample_order)
  df$sample_j <- factor(df$sample_j, levels = sample_order)

  # --- build optional top group bar (+ spacer) ---
  if (has_group) {
    group_row_label  <- sprintf("[group: %s]", intgroup)
    spacer_row_label <- "[spacer]"
    y_limits <- c(sample_order, spacer_row_label, group_row_label)

    group_df <- ann_df %>%
      mutate(sample   = factor(sample, levels = sample_order),
             sample_i = factor(group_row_label, levels = y_limits))

    spacer_df <- data.frame(
      sample_j = factor(sample_order, levels = sample_order),
      sample_i = factor(spacer_row_label, levels = y_limits),
      distance = NA_real_
    )
  } else {
    y_limits <- sample_order
    group_df <- NULL
    spacer_df <- NULL
  }

  # --- conditional labeling for large heatmaps ---
  show_axis_labels <- length(sample_order) <= 30

  # --- plot ---
  g <- ggplot() +
    { if (has_group)
      geom_tile(data = spacer_df,
                aes(x = sample_j, y = sample_i, fill = distance), na.rm = TRUE) } +
    geom_tile(data = df, aes(x = sample_j, y = sample_i, fill = distance)) +
    scale_fill_gradient(low = "white", high = "blue", name = "Distance") +
    scale_y_discrete(
      limits = y_limits,
      labels = function(l) ifelse(l %in% c("[spacer]", sprintf("[group: %s]", intgroup)), "", l)
    ) +
    theme_bw() +
    theme(
      axis.text.x = if (show_axis_labels) element_text(angle = 90, vjust = 0.5, hjust = 1) else element_blank(),
      axis.text.y = if (show_axis_labels) element_text(size = 6) else element_blank(),
      axis.ticks.x = if (show_axis_labels) element_line() else element_blank(),
      axis.ticks.y = if (show_axis_labels) element_line() else element_blank()
    ) +
    xlab(NULL) + ylab(NULL) +
    ggtitle("Sample Distance Heatmap")

  if (has_group) {
    g <- g +
      geom_point(data = group_df, aes(x = sample, y = sample_i, colour = group),
                 shape = 15, size = 6, stroke = 0, inherit.aes = FALSE) +
      labs(colour = intgroup) +
      theme(legend.position = "top")
  }

  # --- save ---
  ggsave(file.path(outdir, "sample_distance_heatmap.png"),
         plot = g, width = 7.5, height = 6.5, dpi = 300)
  write.csv(df, file.path(outdir, "sample_distance_heatmap.csv"), row.names = FALSE)
  register_visualization("sample_distance_heatmap",
                        "Heatmap showing Euclidean distances between samples",
                        "differential_expression_sample_distance_heatmap",
                        NULL,
                        "sample_distance_heatmap.png", "sample_distance_heatmap.csv")
}


# MA Plot
run_ma <- function(res_df, tag, outdir, alpha=0.05, lfc_threshold=1.0, register_visualization) {
  if (!all(c("baseMean","log2FoldChange","padj") %in% names(res_df))) {
    warning("Results missing required columns; skipping MA: ", tag); return(invisible(NULL))
  }
  df <- res_df %>%
    mutate(baseMean_log10 = log10(baseMean + 1)) %>%
    classify_sig(alpha = alpha, lfc_thr = lfc_threshold)

  g <- ggplot(df, aes(x = baseMean_log10, y = log2FoldChange, color = status)) +
    geom_hline(yintercept = c(-lfc_threshold, lfc_threshold), linetype = "dashed") +
    geom_point(alpha = 0.6, size = 0.7, na.rm = TRUE) +
    scale_color_manual(values = gene_colors, name = "Status") +
    theme_bw() +
    xlab("log10(baseMean + 1)") +
    ylab("log2 Fold Change") +
    ggtitle(paste0("MA Plot: ", tag))
  ggsave(file.path(outdir, "MA_plot.png"), plot = g, width = 7, height = 5, dpi = 300)
  write.csv(df, file.path(outdir, "MA_plot.csv"), row.names = FALSE)
  register_visualization("MA_plot",
                        "MA plot showing log2 fold changes vs mean expression levels",
                        "differential_expression_ma_plot",
                        NULL,
                        "MA_plot.png", "MA_plot.csv")
}

# Volcano Plot
run_volcano <- function(res_df, tag, outdir, alpha=0.05, lfc_threshold=1.0, register_visualization) {
  if (!all(c("log2FoldChange","pvalue","padj") %in% names(res_df))) {
    warning("Results missing required columns; skipping Volcano: ", tag); return(invisible(NULL))
  }
  df <- res_df %>%
    mutate(neglog10p = -log10(padj)) %>%
    mutate(neglog10p = ifelse(is.finite(neglog10p), neglog10p, NA_real_)) %>%
    classify_sig(alpha = alpha, lfc_thr = lfc_threshold)

  g <- ggplot(df, aes(x = log2FoldChange, y = neglog10p, color = status)) +
    geom_vline(xintercept = c(-lfc_threshold, lfc_threshold), linetype = "dashed") +
    geom_hline(yintercept = -log10(alpha), linetype = "dashed") +
    geom_point(alpha = 0.6, size = 0.7, na.rm = TRUE) +
    scale_color_manual(values = gene_colors, name = "Status") +
    theme_bw() +
    xlab("log2 Fold Change") +
    ylab("-log10(adjusted p-value)") +
    ggtitle(paste0("Volcano: ", tag))
  ggsave(file.path(outdir, "volcano_plot.png"), plot = g, width = 7, height = 5, dpi = 300)
  write.csv(df, file.path(outdir, "volcano_plot.csv"), row.names = FALSE)
  register_visualization("volcano_plot",
                        "Volcano plot showing log2 fold changes vs -log10(adjusted p-value)",
                        "differential_expression_volcano_plot",
                        NULL,
                        "volcano_plot.png", "volcano_plot.csv")
}

# Top Differential Gene Heatmap
run_heatmap <- function(vsd, res_df, coldata, intgroup, tag, outdir,
                        n_sig_genes = 50, alpha = 0.05, lfc_threshold = 1.0,
                        symbol_map = NULL, group_bar_size = 12, register_visualization) {
  if (!"row_id" %in% names(res_df)) {
    warning("Results missing 'row_id'; skipping heatmap: ", tag); return(invisible(NULL))
  }

  # --- significant set ---
  sig_df <- res_df %>%
    mutate(status = dplyr::case_when(
      !is.na(padj) & padj <= alpha & log2FoldChange >=  lfc_threshold ~ "up",
      !is.na(padj) & padj <= alpha & log2FoldChange <= -lfc_threshold ~ "down",
      TRUE ~ "ns"
    )) %>%
    filter(status != "ns") %>%
    arrange(padj)
  if (nrow(sig_df) == 0) { warning("Not enough significant genes for heatmap: ", tag); return(invisible(NULL)) }

  # top N by padj, keep IDs as in vsd
  top_ids  <- utils::head(unique(sig_df$row_id), n_sig_genes)
  vsd_ids  <- rownames(vsd)
  genes_ids <- top_ids[top_ids %in% vsd_ids]
  if (length(genes_ids) < 2) { warning("Not enough significant genes matched in VSD: ", tag); return(invisible(NULL)) }

  # --- matrix & row z-scores ---
  mat <- SummarizedExperiment::assay(vsd)[genes_ids, , drop = FALSE]
  row_means <- rowMeans(mat, na.rm = TRUE)
  row_sds   <- apply(mat, 1, stats::sd, na.rm = TRUE)
  keep_rows <- is.finite(row_sds) & (row_sds > 0)
  if (sum(keep_rows) < 2) { warning("Heatmap rows < 2 after removing constant rows; skipping: ", tag); return(invisible(NULL)) }
  mat   <- mat[keep_rows, , drop = FALSE]
  genes_ids <- genes_ids[keep_rows]
  mat_z <- sweep(mat, 1, row_means[keep_rows], FUN = "-")
  mat_z <- sweep(mat_z, 1, row_sds[keep_rows],   FUN = "/")

  # --- order rows by log2FC (desc) ---
  lfc_map  <- setNames(res_df$log2FoldChange, res_df$row_id)
  ord_rows <- order(lfc_map[genes_ids], decreasing = TRUE, na.last = TRUE)
  mat_z    <- mat_z[ord_rows, , drop = FALSE]
  genes_ids <- genes_ids[ord_rows]

  # --- column order: by group then sample_id ---
  has_group <- intgroup %in% names(coldata)
  if (has_group) {
    coldata_ord <- coldata %>%
      mutate(.grp = as.factor(.data[[intgroup]])) %>%
      arrange(.grp, sample_id)
    sample_order <- coldata_ord$sample_id
    ann_df <- coldata_ord %>% dplyr::select(sample = sample_id, group = .grp)
  } else {
    warning("'", intgroup, "' not found in coldata; ordering columns by sample_id only and omitting group bar.")
    sample_order <- sort(coldata$sample_id)
    ann_df <- NULL
  }
  sample_order <- sample_order[sample_order %in% colnames(mat_z)]
  mat_z <- mat_z[, sample_order, drop = FALSE]

  # --- display labels: SYMBOL when available ---
  if (!is.null(symbol_map) && all(c("row_id","SYMBOL") %in% names(symbol_map))) {
    sym_lookup <- setNames(symbol_map$SYMBOL, symbol_map$row_id)
    display_y  <- ifelse(!is.na(sym_lookup[genes_ids]) & nzchar(sym_lookup[genes_ids]),
                         sym_lookup[genes_ids], genes_ids)
  } else {
    display_y <- genes_ids
  }
  rownames(mat_z) <- display_y

  # --- long df (genes only) ---
  df_long <- as.data.frame(mat_z) %>%
    tibble::rownames_to_column("gene_symbol") %>%
    tidyr::pivot_longer(-gene_symbol, names_to = "sample", values_to = "zscore")
  df_long$sample <- factor(df_long$sample, levels = sample_order)

  # lock row order (top LFC within the gene block)
  row_order <- rownames(mat_z)  # genes in LFC-desc order (top gene first)

  # --- build group bar row (+ spacer) data ---
  if (has_group) {
    group_row_label  <- sprintf("[group: %s]", intgroup)
    spacer_row_label <- "[spacer]"

    # Manually place the group bar at the top:
    y_limits <- c(rev(row_order), spacer_row_label, group_row_label)

    group_df <- ann_df %>%
      mutate(gene_symbol = factor(group_row_label, levels = y_limits),
             sample      = factor(sample, levels = sample_order))

    spacer_df <- data.frame(
      gene_symbol = factor(spacer_row_label, levels = y_limits),
      sample      = factor(sample_order, levels = sample_order),
      zscore      = NA_real_
    )
  } else {
    # no group bar: just genes; put highest LFC at the TOP
    y_limits <- rev(row_order)
    group_df <- NULL
    spacer_df <- NULL
  }

  # long df (genes only), make gene factor align with limits
  df_long <- as.data.frame(mat_z) %>%
    tibble::rownames_to_column("gene_symbol") %>%
    tidyr::pivot_longer(-gene_symbol, names_to = "sample", values_to = "zscore")
  df_long$sample      <- factor(df_long$sample, levels = sample_order)
  df_long$gene_symbol <- factor(df_long$gene_symbol, levels = y_limits)

  # --- draw (group bar is at the TOP thanks to y_limits order) ---
  g <- ggplot() +
    { if (has_group) geom_tile(data = spacer_df,
                               aes(x = sample, y = gene_symbol, fill = zscore),
                               na.rm = TRUE) } +
    geom_tile(data = df_long,
              aes(x = sample, y = gene_symbol, fill = zscore)) +
    scale_fill_gradient2(low = "blue", mid = "white", high = "red", midpoint = 0,
                         name = "Row z-score") +
    scale_y_discrete(limits = y_limits,
                     labels = function(l) ifelse(l %in% c("[spacer]", sprintf("[group: %s]", intgroup)), "", l)) +
    theme_bw() +
    theme(
      axis.text.x = element_text(angle = 90, vjust = 0.5, hjust = 1),
      axis.text.y = element_text(size = 6)
    ) +
    xlab(NULL) + ylab(NULL) +
    ggtitle(paste0("Heatmap: ", tag, " (", nrow(mat_z), " genes)"))

  if (has_group) {
    g <- g +
      geom_point(data = group_df,
                 aes(x = sample, y = gene_symbol, colour = group),
                 shape = 15, size = 6, stroke = 0, inherit.aes = FALSE) +
      labs(colour = intgroup) +
      theme(legend.position = "top")
  }

  # save
  ggsave(file.path(outdir, paste0("heatmap_top", nrow(mat_z), ".png")),
         plot = g, width = 8, height = 10, dpi = 300)

  # save z-score matrix (genes only) with ID/SYMBOL/GENENAME
  mat_write <- mat_z[, sample_order, drop = FALSE]
  rownames(mat_write) <- genes_ids
  out_mat <- as.data.frame(mat_write) %>%
    tibble::rownames_to_column("row_id")
  if (!is.null(symbol_map) && all(c("row_id","SYMBOL","GENENAME") %in% names(symbol_map))) {
    out_mat <- out_mat %>%
      dplyr::left_join(symbol_map, by = "row_id") %>%
      dplyr::relocate(row_id, SYMBOL, GENENAME)
  } else {
    out_mat <- out_mat %>%
      dplyr::mutate(SYMBOL = NA_character_, GENENAME = NA_character_) %>%
      dplyr::relocate(row_id, SYMBOL, GENENAME)
  }
  write.csv(out_mat,
            file.path(outdir, paste0("heatmap_top", nrow(mat_z), "_zscore.csv")),
            row.names = FALSE)
  register_visualization("heatmap",
                        "Heatmap of top differentially expressed genes with row z-scores",
                        "differential_expression_heatmap",
                        NULL,
                        paste0("heatmap_top", nrow(mat_z), ".png"),
                        paste0("heatmap_top", nrow(mat_z), "_zscore.csv"))
}


# =========================
# IO helpers
# =========================

write_all_results <- function(res_list, outdir, register_data_file) {
  for (nm in names(res_list)) {
    df_out <- res_list[[nm]]
    # drop internal helper columns from the output
    drop_cols <- intersect(c("ensembl_id", "ensembl_id_stripped"), names(df_out))
    if (length(drop_cols)) {
      df_out <- df_out[ , setdiff(names(df_out), drop_cols), drop = FALSE]
    }
    # rename row_id to Ensembl for the saved CSV only
    if ("row_id" %in% names(df_out)) {
      names(df_out)[names(df_out) == "row_id"] <- "Ensembl"
    }
    write.csv(df_out, register_data_file("DE_results.csv",
                                          paste0("Differential expression results for contrast: ", nm),
                                          "differential_expression_results"),
              row.names = FALSE)
  }
}



write_norm_counts <- function(norm_counts_annot, outdir, register_data_file) {
  write.csv(norm_counts_annot,
            register_data_file("normalized_counts_annotated.csv",
                              "Normalized gene expression counts with gene annotations (SYMBOL and GENENAME)",
                              "differential_expression_normalized_counts"),
            row.names=FALSE)
}

write_size_factors <- function(dds, outdir, register_data_file) {
  sf <- sizeFactors(dds)
  write.csv(data.frame(sample_id=names(sf), sizeFactor=as.numeric(sf)),
            register_data_file("size_factors.csv",
                              "DESeq2 size factors used for normalization of each sample",
                              "differential_expression_size_factors"),
            row.names=FALSE)
}

write_summary_for_llm <- function(args, counts_after_filter, contrasts, outdir,
                                   results_list = NULL, data_files_registry,
                                   visualizations_registry, design_info = NULL) {
  alpha <- args$alpha
  lfc_threshold <- args$lfc_threshold

  # Start building markdown content
  lines <- c(
    "# Differential Expression Analysis Summary",
    "",
    "## Analysis Overview",
    "",
    paste0("This analysis performed differential gene expression analysis using DESeq2 on RNA-seq count data."),
    "",
    "### Input Parameters"
  )

  # Add design information
  if (!is.null(design_info)) {
    if (design_info$is_formula_based) {
      lines <- c(lines,
        paste0("- **Design Formula**: ", deparse(design_info$design_formula)),
        paste0("- **Contrast Factor**: ", design_info$main_factor)
      )
    } else {
      lines <- c(lines,
        paste0("- **Design Variable**: ", design_info$main_factor)
      )
    }
  } else if (!is.null(args$design_variable)) {
    lines <- c(lines, paste0("- **Design Variable**: ", args$design_variable))
  } else if (!is.null(args$design_formula)) {
    lines <- c(lines, paste0("- **Design Formula**: ", args$design_formula))
  }

  lines <- c(lines,
    paste0("- **Comparison**: ", paste(contrasts, collapse=", ")),
    paste0("- **Significance Threshold (padj)**: ", alpha),
    paste0("- **Log2 Fold Change Threshold**: ", lfc_threshold),
    paste0("- **Minimum Count Filter**: ", args$min_count),
    paste0("- **Minimum Samples**: ", args$min_samples),
    "",
    "### Dataset Information",
    paste0("- **Number of genes after filtering**: ", format(nrow(counts_after_filter), big.mark=",")),
    paste0("- **Number of samples**: ", ncol(counts_after_filter)),
    ""
  )

  # Process results for each contrast
  if (!is.null(results_list) && length(results_list) > 0) {
    for (contrast_name in names(results_list)) {
      res_df <- results_list[[contrast_name]]

      # Calculate statistics
      sig_genes <- res_df %>%
        filter(!is.na(padj) & padj <= alpha & abs(log2FoldChange) >= lfc_threshold)

      up_genes <- sig_genes %>%
        filter(log2FoldChange >= lfc_threshold) %>%
        arrange(padj, desc(log2FoldChange))

      down_genes <- sig_genes %>%
        filter(log2FoldChange <= -lfc_threshold) %>%
        arrange(padj, log2FoldChange)

      # Add contrast section
      lines <- c(lines,
        paste0("## Results for Contrast: ", contrast_name),
        "",
        "### Summary Statistics",
        paste0("- **Total significant genes**: ", nrow(sig_genes)),
        paste0("- **Upregulated genes**: ", nrow(up_genes)),
        paste0("- **Downregulated genes**: ", nrow(down_genes)),
        ""
      )

      # Top 50 upregulated genes
      if (nrow(up_genes) > 0) {
        top_up <- head(up_genes, 50)
        lines <- c(lines,
          "### Top 50 Upregulated Genes",
          "",
          "```csv",
          "Rank,Symbol,LFC,Padj"
        )

        for (i in seq_len(nrow(top_up))) {
          gene <- top_up[i, ]
          symbol <- if (!is.na(gene$SYMBOL) && nzchar(gene$SYMBOL)) gene$SYMBOL else gene$row_id
          lines <- c(lines,
            sprintf('%d,%s,%.2f,%.2e', i, symbol, gene$log2FoldChange, gene$padj)
          )
        }

        lines <- c(lines, "```", "")
      } else {
        lines <- c(lines, "### Top Upregulated Genes", "", "None found.", "")
      }

      # Top 50 downregulated genes
      if (nrow(down_genes) > 0) {
        top_down <- head(down_genes, 50)
        lines <- c(lines,
          "### Top 50 Downregulated Genes",
          "",
          "```csv",
          "Rank,Symbol,LFC,Padj"
        )

        for (i in seq_len(nrow(top_down))) {
          gene <- top_down[i, ]
          symbol <- if (!is.na(gene$SYMBOL) && nzchar(gene$SYMBOL)) gene$SYMBOL else gene$row_id
          lines <- c(lines,
            sprintf('%d,%s,%.2f,%.2e', i, symbol, gene$log2FoldChange, gene$padj)
          )
        }

        lines <- c(lines, "```", "")
      } else {
        lines <- c(lines, "### Top Downregulated Genes", "", "None found.", "")
      }
    }
  }

  # List visualizations generated
  if (length(visualizations_registry) > 0) {
    lines <- c(lines, "## Visualizations Generated", "")
    for (i in seq_along(visualizations_registry)) {
      viz <- visualizations_registry[[i]]
      lines <- c(lines, sprintf("%d. **%s**: %s", i, viz$name, viz$description))
      lines <- c(lines, sprintf("   - Image: `%s`", viz$image_file_path))
      lines <- c(lines, sprintf("   - Data: `%s`", viz$data_file_path))
    }
    lines <- c(lines, "")
  }

  # Add data files section
  if (length(data_files_registry) > 0) {
    lines <- c(lines, "## Data Files Generated", "")
    for (i in seq_along(data_files_registry)) {
      df <- data_files_registry[[i]]
      lines <- c(lines, sprintf("%d. **%s**: %s", i, df$name, df$description))
      lines <- c(lines, sprintf("   - Path: `%s`", df$file_path))
    }
    lines <- c(lines, "")
  }

  # Add UI visibility note
  lines <- c(lines,
    "## Note",
    "",
    "All visualizations, data files, and summary statistics are visible in the UI for interactive exploration.",
    ""
  )

  # Add interpretation guidance
  lines <- c(lines,
    "## Interpretation",
    "",
    paste0("- **LFC**: log2 fold change; +ve = upregulated, -ve = downregulated"),
    paste0("- **Padj**: Benjamini-Hochberg corrected p-value"),
    paste0("- **Significance**: padj ≤ ", alpha, " and |LFC| ≥ ", lfc_threshold),
    ""
  )

  # Write to file
  writeLines(lines, file.path(outdir, "summary_text_for_llm.md"))
}

write_run_metadata <- function(args, dds, counts_after_filter, contrasts, outdir,
                                n_genes_prefilter = NULL, results_list = NULL,
                                data_files_registry, visualizations_registry,
                                design_info = NULL, numerator_level = NULL, denominator_level = NULL) {

  # Determine main factor for sample counting
  main_factor <- if (!is.null(design_info)) {
    design_info$main_factor
  } else if (!is.null(args$design_variable)) {
    args$design_variable
  } else {
    NULL
  }

  # Calculate sample counts for numerator and denominator
  # Use the numerator_level and denominator_level returned from run_deseq
  # instead of the numerator_level and denominator_level
  # passed as args so the metadata aligns correctly with the
  # true deseq2 run
  n_samples_numerator <- 0
  n_samples_denominator <- 0

  if (!is.null(numerator_level) && !is.null(denominator_level) &&
      !is.null(main_factor) && main_factor %in% names(colData(dds))) {
    col_data <- as.data.frame(colData(dds))
    design_col <- col_data[[main_factor]]
    n_samples_numerator <- sum(design_col == numerator_level, na.rm = TRUE)
    n_samples_denominator <- sum(design_col == denominator_level, na.rm = TRUE)
  }

  # Calculate significance statistics from results
  n_significant_genes <- 0
  n_up_regulated_genes <- 0
  n_down_regulated_genes <- 0

  if (!is.null(results_list) && length(results_list) > 0) {
    alpha <- args$alpha
    lfc_threshold <- args$lfc_threshold

    # Aggregate stats across all contrasts (using unique genes)
    all_sig_genes <- character(0)
    all_up_genes <- character(0)
    all_down_genes <- character(0)

    for (res_df in results_list) {
      if ("row_id" %in% names(res_df) && "padj" %in% names(res_df) && "log2FoldChange" %in% names(res_df)) {
        sig_genes <- res_df %>%
          filter(!is.na(padj) & padj <= alpha & abs(log2FoldChange) >= lfc_threshold) %>%
          pull(row_id)

        up_genes <- res_df %>%
          filter(!is.na(padj) & padj <= alpha & log2FoldChange >= lfc_threshold) %>%
          pull(row_id)

        down_genes <- res_df %>%
          filter(!is.na(padj) & padj <= alpha & log2FoldChange <= -lfc_threshold) %>%
          pull(row_id)

        all_sig_genes <- unique(c(all_sig_genes, sig_genes))
        all_up_genes <- unique(c(all_up_genes, up_genes))
        all_down_genes <- unique(c(all_down_genes, down_genes))
      }
    }

    n_significant_genes <- length(all_sig_genes)
    n_up_regulated_genes <- length(all_up_genes)
    n_down_regulated_genes <- length(all_down_genes)
  }

  # Build design specification for metadata
  design_spec <- if (!is.null(design_info)) {
    if (design_info$is_formula_based) {
      list(
        type = "formula",
        formula = deparse(design_info$design_formula),
        contrast_factor = design_info$main_factor
      )
    } else {
      list(
        type = "variable",
        variable = design_info$main_factor
      )
    }
  } else if (!is.null(args$design_formula)) {
    list(type = "formula", formula = args$design_formula)
  } else if (!is.null(args$design_variable)) {
    list(type = "variable", variable = args$design_variable)
  } else {
    list(type = "unknown")
  }

  meta <- list(
    summary_stats = list(
      n_genes_prefilter = n_genes_prefilter,
      n_genes_postfilter = nrow(counts_after_filter),
      n_samples = ncol(counts_after_filter),
      n_samples_numerator = n_samples_numerator,
      n_samples_denominator = n_samples_denominator,
      n_significant_genes = n_significant_genes,
      n_up_regulated_genes = n_up_regulated_genes,
      n_down_regulated_genes = n_down_regulated_genes,
      contrasts = contrasts,
      lfc_threshold = args$lfc_threshold,
      significance_threshold = args$alpha,
      date = as.character(Sys.time())
    ),
    design_specification = design_spec,
    data_files = data_files_registry,
    visualizations = visualizations_registry
  )
  write(jsonlite::toJSON(meta, pretty=TRUE, auto_unbox=TRUE),
        file.path(outdir, "run_metadata.json"))
}

# =========================
# Orchestration
# =========================

#' Run differential expression analysis
#'
#' Top-level function that runs the full DESeq2 pipeline: load data, filter,
#' run DESeq2, annotate, generate plots, and write all outputs.
#'
#' @param counts_file Path to count matrix CSV (col1: Ensembl IDs; others: sample IDs)
#' @param coldata_file Path to CSV with 'sample_id' and design variables
#' @param outdir Output directory (created if it doesn't exist)
#' @param design_variable Factor column in coldata for simple designs. Mutually exclusive with design_formula.
#' @param design_formula R-style design formula (e.g., "~ condition + batch"). Mutually exclusive with design_variable.
#' @param denominator_level Reference (denominator) level for contrast
#' @param numerator_level Numerator level for contrast
#' @param contrast_factor Factor name for contrast when using complex design_formula
#' @param min_count Prefilter: minimum count to consider expressed (default 10)
#' @param min_samples Prefilter: minimum samples meeting min_count (default 3)
#' @param alpha Adjusted p-value cutoff (default 0.05)
#' @param lfc_threshold Absolute log2FC threshold for significance (default 1.0)
#' @param n_sig_genes Top significant genes for heatmap (default 50)
#' @param pca_ntop Top variable genes for PCA (default 500)
#' @param pca_intgroup Factor for PCA grouping/coloring (default: inferred from design)
#' @param shrink Apply log2FC shrinkage (default FALSE)
#' @param shrink_method Shrinkage method: "apeglm", "ashr", or "normal" (default "apeglm")
#' @param orgdb OrgDb package for annotation (default "org.Hs.eg.db")
#' @param keytype Keytype for OrgDb mapping (default "ENSEMBL")
#' @param n_cores Number of CPU cores/threads (default 1)
#' @return A list with: dds, vsd, results, norm_counts, mapping, data_files, visualizations, outdir
run_differential_expression <- function(
  counts_file,
  coldata_file,
  outdir,
  design_variable = NULL,
  design_formula = NULL,
  denominator_level = NULL,
  numerator_level = NULL,
  contrast_factor = NULL,
  min_count = 10L,
  min_samples = 3L,
  alpha = 0.05,
  lfc_threshold = 1.0,
  n_sig_genes = 50L,
  pca_ntop = 500L,
  pca_intgroup = NULL,
  shrink = FALSE,
  shrink_method = "apeglm",
  orgdb = "org.Hs.eg.db",
  keytype = "ENSEMBL",
  n_cores = 1L
) {
  # Validate inputs
  if (!file.exists(counts_file)) stop("Counts file not found: ", counts_file)
  if (!file.exists(coldata_file)) stop("Coldata file not found: ", coldata_file)
  safe_dir_create(outdir)

  has_variable <- !is.null(design_variable)
  has_formula <- !is.null(design_formula)
  if (!has_variable && !has_formula) stop("Must provide either design_variable or design_formula")
  if (has_variable && has_formula) stop("Cannot specify both design_variable and design_formula")

  if (has_formula) {
    if (!grepl("^\\s*~", design_formula)) {
      stop("design_formula must start with '~' (e.g., '~ condition' or '~ condition + batch')")
    }
    tryCatch(as.formula(design_formula),
             error = function(e) stop("Invalid R formula syntax: ", design_formula, "\nError: ", conditionMessage(e)))
    formula_terms <- attr(terms(as.formula(design_formula)), "term.labels")
    if (length(formula_terms) == 0) stop("design_formula must contain at least one term")
  }

  # Build an args-like list for functions that expect it
  args <- list(
    counts_file = counts_file, coldata_file = coldata_file, outdir = outdir,
    design_variable = design_variable, design_formula = design_formula,
    denominator_level = denominator_level, numerator_level = numerator_level,
    contrast_factor = contrast_factor, min_count = min_count, min_samples = min_samples,
    alpha = alpha, lfc_threshold = lfc_threshold, n_sig_genes = n_sig_genes,
    pca_ntop = pca_ntop, pca_intgroup = pca_intgroup, shrink = shrink,
    shrink_method = shrink_method, orgdb = orgdb, keytype = keytype, n_cores = n_cores
  )

  # Initialize registries using a local environment (no global assignment)
  reg <- new.env(parent = emptyenv())
  reg$data_files <- list()
  reg$visualizations <- list()

  register_data_file <- function(filename, description, artifact_type) {
    file_path <- file.path(outdir, filename)
    reg$data_files[[length(reg$data_files) + 1]] <- list(
      name = basename(filename),
      description = description,
      file_path = normalizePath(file_path, mustWork = FALSE),
      artifact_type = artifact_type
    )
    file_path
  }

  register_visualization <- function(name, description, visualization_type, visualization_metadata, image_filename, data_filename) {
    reg$visualizations[[length(reg$visualizations) + 1]] <- list(
      name = name,
      description = description,
      visualization_type = visualization_type,
      visualization_metadata = visualization_metadata,
      image_file_path = normalizePath(file.path(outdir, image_filename), mustWork = FALSE),
      data_file_path = normalizePath(file.path(outdir, data_filename), mustWork = FALSE)
    )
  }

  # Configure threads / parallel
  bp <- configure_threads(n_cores)

  # I/O + prep
  io <- load_and_validate_inputs(counts_file, coldata_file)
  aligned <- align_samples_or_die(io$counts_mat, io$coldata)
  counts_proc <- process_genes(aligned$counts_mat, min_count, min_samples)

  # Determine PCA intgroup (for visualization)
  if (is.null(pca_intgroup)) {
    if (!is.null(design_variable)) {
      pca_intgroup <- design_variable
    } else if (!is.null(design_formula)) {
      formula_obj <- as.formula(design_formula)
      formula_terms <- attr(terms(formula_obj), "term.labels")
      pca_intgroup <- formula_terms[1]
    }
  }

  # DE (parallel-aware, with formula support)
  de <- run_deseq(counts_proc, aligned$coldata,
                  design_variable = design_variable,
                  design_formula = design_formula,
                  denominator_level = denominator_level,
                  numerator_level = numerator_level,
                  contrast_factor = contrast_factor,
                  alpha = alpha, shrink = shrink, shrink_method = shrink_method,
                  bpparam = bp)

  # Build mapping ONCE using the post-filter universe (rownames of vsd)
  message("Annotating (offline) using ", orgdb, " (", keytype, ") ...")
  mapping <- map_ids_offline(rownames(de$vsd), orgdb, keytype)

  # Annotate results and counts using the same mapping
  de$results <- annotate_results_list_with_map(de$results, mapping)
  norm_counts_annot <- annotate_counts_matrix_with_map(de$norm_counts, mapping)

  # Write outputs
  write_all_results(de$results, outdir, register_data_file = register_data_file)
  write_norm_counts(norm_counts_annot, outdir, register_data_file = register_data_file)
  write_size_factors(de$dds, outdir, register_data_file = register_data_file)

  # Plots (use the determined intgroup)
  run_dispersion(de$dds, outdir, register_visualization = register_visualization)
  if (!is.null(pca_intgroup)) {
    run_pca(de$vsd, pca_intgroup, outdir, ntop = pca_ntop, register_visualization = register_visualization)
    run_sample_distance_heatmap(de$vsd, de$coldata, pca_intgroup, outdir, register_visualization = register_visualization)
  }

  for (nm in names(de$results)) {
    res_df <- de$results[[nm]]
    run_ma(res_df, nm, outdir, alpha = alpha, lfc_threshold = lfc_threshold, register_visualization = register_visualization)
    run_volcano(res_df, nm, outdir, alpha = alpha, lfc_threshold = lfc_threshold, register_visualization = register_visualization)
    if (!is.null(pca_intgroup)) {
      run_heatmap(de$vsd, res_df, de$coldata, pca_intgroup, nm, outdir,
                  n_sig_genes = n_sig_genes, alpha = alpha, lfc_threshold = lfc_threshold,
                  symbol_map = mapping, register_visualization = register_visualization)
    }
  }

  # Capture design information for metadata
  design_info <- list(
    is_formula_based = de$is_formula_based,
    main_factor = de$main_factor,
    design_formula = de$design_formula
  )

  write_run_metadata(args, de$dds, counts_proc, names(de$results), outdir,
                     n_genes_prefilter = nrow(aligned$counts_mat),
                     results_list = de$results,
                     data_files_registry = reg$data_files,
                     visualizations_registry = reg$visualizations,
                     design_info = design_info,
                     numerator_level = de$numerator_level,
                     denominator_level = de$denominator_level)
  write_summary_for_llm(args, counts_proc, names(de$results), outdir,
                        results_list = de$results,
                        data_files_registry = reg$data_files,
                        visualizations_registry = reg$visualizations,
                        design_info = design_info)
  message("Done. Outputs written to: ", normalizePath(outdir))

  # Return results for programmatic use (e.g., from a notebook)
  invisible(list(
    dds = de$dds,
    vsd = de$vsd,
    results = de$results,
    norm_counts = norm_counts_annot,
    mapping = mapping,
    design_info = design_info,
    data_files = reg$data_files,
    visualizations = reg$visualizations,
    outdir = normalizePath(outdir)
  ))
}


