#!/usr/bin/env python3
"""Produce final summary report from flow cytometry analysis results."""

import argparse
import csv
import glob
import json
import math
import os
import sys
from collections import defaultdict

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.image as mpimg


def load_json(path):
    """Load a JSON file, exit on error."""
    if not os.path.exists(path):
        print(f"ERROR: File not found: {path}", file=sys.stderr)
        sys.exit(1)
    with open(path) as f:
        return json.load(f)


def load_gate_statistics(outdir):
    """Load gate_statistics.csv into a structured dict."""
    csv_path = os.path.join(outdir, "gate_statistics.csv")
    if not os.path.exists(csv_path):
        print(f"ERROR: gate_statistics.csv not found in {outdir}", file=sys.stderr)
        sys.exit(1)

    stats = defaultdict(dict)  # stats[gate_name][sample_name] = row
    sample_names = []

    with open(csv_path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            sample = row["sample"]
            gate = row["gate"]
            if sample not in sample_names:
                sample_names.append(sample)
            stats[gate][sample] = {
                "label": row["label"],
                "parent": row["parent"],
                "event_count": int(row["event_count"]),
                "percent_of_parent": float(row["percent_of_parent"]),
                "percent_of_total": float(row["percent_of_total"]),
            }

    return stats, sample_names


def write_summary_markdown(stats, sample_names, gate_defs, inspect_data, panel, outdir):
    """Write summary_for_llm.md."""
    lines = ["# Flow Cytometry Analysis Summary\n"]

    # Panel
    if panel:
        lines.append("## Panel\n")
        lines.append("| Channel | Marker |")
        lines.append("|---------|--------|")
        for ch, marker in panel.items():
            if marker:
                lines.append(f"| {ch} | {marker} |")
        lines.append("")

    # Sample info
    if inspect_data:
        lines.append("## Samples\n")
        lines.append("| Sample | Events |")
        lines.append("|--------|--------|")
        for s in inspect_data.get("samples", []):
            lines.append(f"| {s['file']} | {s['event_count']:,} |")
        lines.append("")

    # Gate hierarchy
    if gate_defs:
        lines.append("## Gating Hierarchy\n")
        for g in gate_defs:
            parent = g.get("parent", "root")
            indent = "  " if parent != "root" else ""
            label = g.get("label", g["name"])
            lines.append(f"{indent}- **{label}** ({g['name']}): "
                         f"{g['x_channel']} vs {g['y_channel']}, parent={parent}")
        lines.append("")

    # Population statistics table
    if stats and sample_names:
        lines.append("## Population Statistics\n")

        # Header
        header = "| Population |"
        separator = "|------------|"
        for name in sample_names:
            header += f" {name} |"
            separator += "------|"
        if len(sample_names) > 1:
            header += " Mean |"
            separator += "------|"
        lines.append(header)
        lines.append(separator)

        # Rows — one per gate, in definition order
        for gate_def in gate_defs:
            gate_name = gate_def["name"]
            label = gate_def.get("label", gate_name)
            row = f"| {label} |"

            counts = []
            for sample_name in sample_names:
                if gate_name in stats and sample_name in stats[gate_name]:
                    s = stats[gate_name][sample_name]
                    row += f" {s['event_count']:,} ({s['percent_of_total']:.1f}%) |"
                    counts.append(s["percent_of_total"])
                else:
                    row += " — |"

            if len(sample_names) > 1 and counts:
                mean_pct = sum(counts) / len(counts)
                row += f" {mean_pct:.1f}% |"

            lines.append(row)

        lines.append("")

    path = os.path.join(outdir, "summary_for_llm.md")
    with open(path, "w") as f:
        f.write("\n".join(lines))
    return path


def write_summary_json(stats, sample_names, gate_defs, inspect_data, panel, outdir):
    """Write structured summary.json."""
    populations = []
    for gate_def in gate_defs:
        gate_name = gate_def["name"]
        label = gate_def.get("label", gate_name)
        per_sample = {}
        for sample_name in sample_names:
            if gate_name in stats and sample_name in stats[gate_name]:
                per_sample[sample_name] = stats[gate_name][sample_name]
        populations.append({
            "gate": gate_name,
            "label": label,
            "parent": gate_def.get("parent", "root"),
            "samples": per_sample,
        })

    summary = {
        "n_samples": len(sample_names),
        "sample_names": sample_names,
        "n_gates": len(gate_defs),
        "panel": panel,
        "populations": populations,
    }

    run_data_dir = os.path.join(outdir, "run_data")
    os.makedirs(run_data_dir, exist_ok=True)
    path = os.path.join(run_data_dir, "summary.json")
    with open(path, "w") as f:
        json.dump(summary, f, indent=2)
    return path


def write_run_metadata(outdir, gate_defs, inspect_data):
    """Write run_metadata.json with file registries."""
    # Collect all output files
    data_files = []
    visualizations = []

    for root, dirs, files in os.walk(outdir):
        for fname in files:
            fpath = os.path.join(root, fname)
            rel = os.path.relpath(fpath, outdir)
            if fname.endswith(".csv"):
                data_files.append({"name": fname, "path": fpath, "type": "data"})
            elif fname.endswith(".json") and fname != "run_metadata.json":
                data_files.append({"name": fname, "path": fpath, "type": "metadata"})
            elif fname.endswith(".png"):
                visualizations.append({"name": fname, "path": fpath, "type": "plot"})
            elif fname.endswith(".md"):
                data_files.append({"name": fname, "path": fpath, "type": "summary"})

    metadata = {
        "analysis_type": "flow_cytometry",
        "n_gates": len(gate_defs),
        "gate_names": [g["name"] for g in gate_defs],
        "data_files": data_files,
        "visualizations": visualizations,
    }

    run_data_dir = os.path.join(outdir, "run_data")
    os.makedirs(run_data_dir, exist_ok=True)
    path = os.path.join(run_data_dir, "run_metadata.json")
    with open(path, "w") as f:
        json.dump(metadata, f, indent=2)
    return path


def topological_sort_gates(gate_defs):
    """Sort gate definitions so parents come before children. Returns ordered list of gate names."""
    by_name = {g["name"]: g for g in gate_defs}
    ordered = []
    visited = set()

    def visit(name):
        if name in visited or name not in by_name:
            return
        parent = by_name[name].get("parent", "root")
        if parent != "root":
            visit(parent)
        visited.add(name)
        ordered.append(name)

    for g in gate_defs:
        visit(g["name"])
    return ordered


def classify_png(fpath, outdir):
    """Classify a PNG into a stage: 'scatter', 'gated', or 'other'."""
    fname = os.path.basename(fpath)
    rel_dir = os.path.relpath(os.path.dirname(fpath), outdir)

    if "gated_plots" in rel_dir or fname.startswith("gated_"):
        return "gated"
    elif "plots" in rel_dir or rel_dir == ".":
        # Scatter plots may be in a plots/ subdirectory or directly in outdir
        return "scatter"
    else:
        return "other"


def _sanitize_for_filename(s):
    """Apply the same sanitization that plot scripts use on filenames."""
    return s.replace("/", "_").replace(" ", "_")


def extract_sample_name(fpath, sample_names):
    """Extract the sample name from a PNG filename by matching known sample names.

    Filenames follow these patterns:
      - {x}_{y}_{sample}.png  or  {x}_{y}_{gate}_{sample}.png
      - gated_{gate}_{sample}.png

    Plot scripts sanitize filenames by replacing spaces with underscores,
    so we compare against the sanitized version of each sample name.
    """
    fname = os.path.splitext(os.path.basename(fpath))[0]  # strip .png
    # Try longest sample names first to avoid partial matches
    for name in sorted(sample_names, key=len, reverse=True):
        sanitized = _sanitize_for_filename(name)
        if fname.endswith(f"_{sanitized}"):
            return name
        if f"_{sanitized}_" in fname:
            return name
        if fname.startswith(f"{sanitized}_"):
            return name
    return None


def collect_pngs_by_sample(outdir, sample_names, gate_defs=None):
    """Collect PNGs grouped by sample, each in logical analysis order.

    Returns: list of (sample_name, [png_paths]) tuples, plus a list of
    unmatched PNGs that couldn't be assigned to a sample.
    """
    gate_order = topological_sort_gates(gate_defs) if gate_defs else []
    gate_rank = {name: i for i, name in enumerate(gate_order)}

    # Stage ordering: scatter=0, gated=1+gate_rank, other=999
    def sort_key(fpath):
        stage = classify_png(fpath, outdir)
        fname = os.path.basename(fpath)
        if stage == "scatter":
            return (0, fname)
        elif stage == "gated":
            # Sort by gate hierarchy order
            for gate_name in gate_order:
                if f"gated_{gate_name}_" in fname:
                    return (1 + gate_rank[gate_name], fname)
            return (1 + len(gate_order), fname)
        else:
            return (999, fname)

    # Collect all PNGs
    all_pngs = []
    for root, dirs, files in os.walk(outdir):
        parts = os.path.relpath(root, outdir).split(os.sep)
        if "work" in parts or "run_data" in parts or "input" in parts:
            continue
        for fname in files:
            if fname.endswith(".png") and fname not in (
                "output_summary.png", "summary.png", "summary_by_samples.png",
            ):
                all_pngs.append(os.path.join(root, fname))

    # Group by sample
    by_sample = {name: [] for name in sample_names}
    unmatched = []

    for fpath in all_pngs:
        sample = extract_sample_name(fpath, sample_names)
        if sample:
            by_sample[sample].append(fpath)
        else:
            print(f"  WARNING: Could not match PNG to a sample: {os.path.basename(fpath)}")
            print(f"    Known samples: {sample_names}")
            unmatched.append(fpath)

    # Sort each sample's plots in logical order
    result = []
    for name in sample_names:
        plots = sorted(by_sample[name], key=sort_key)
        if plots:
            result.append((name, plots))

    return result, sorted(unmatched, key=sort_key)


# Target row height in inches — every table row should be this tall
# regardless of how many rows or how large the axes is.
ROW_HEIGHT_INCHES = 0.22

# Single blue color constant for all table headers
HEADER_BLUE = "#4472C4"


def _style_table(ax, title, col_labels, cell_text, col_widths=None,
                  left_align_cols=None, bold_last_row=False, mono_cols=None):
    """Shared table styling: blue header, alternating rows, fixed row height.

    Row height is ROW_HEIGHT_INCHES converted to axes fraction based on
    the actual axes size in inches, so all tables have physically identical
    rows regardless of axes dimensions.
    """
    ax.axis("off")

    if not cell_text:
        ax.text(0.02, 0.95, title, fontsize=9, fontweight="bold",
                transform=ax.transAxes, verticalalignment="top")
        ax.text(0.05, 0.5, "(no data)", fontsize=9, transform=ax.transAxes)
        return None

    n_cols = len(col_labels)
    n_data_rows = len(cell_text)
    n_total_rows = n_data_rows + 1  # +1 for header

    # Convert fixed inch height to axes fraction
    fig = ax.get_figure()
    fig.canvas.draw()  # ensure layout is resolved
    ax_bbox = ax.get_position()
    ax_height_inches = ax_bbox.height * fig.get_figheight()
    row_h_frac = ROW_HEIGHT_INCHES / ax_height_inches if ax_height_inches > 0 else 0.05

    # Title gap in axes fraction (same physical size as ~0.15 inches)
    title_gap_frac = 0.15 / ax_height_inches if ax_height_inches > 0 else 0.06

    # Table height = rows * row_height, capped to available space
    table_h_frac = min(row_h_frac * n_total_rows, 1.0 - title_gap_frac)
    table_top = 1.0 - title_gap_frac
    bbox = [0.02, table_top - table_h_frac, 0.96, table_h_frac]

    # Place title just above the table
    ax.text(0.02, 1.0, title, fontsize=9, fontweight="bold",
            transform=ax.transAxes, verticalalignment="top")

    table = ax.table(
        cellText=cell_text,
        colLabels=col_labels,
        cellLoc="center",
        colLoc="center",
        loc="upper left",
        bbox=bbox,
    )
    table.auto_set_font_size(False)
    table.set_fontsize(7.5)

    # Set each row to the same physical height (in axes fraction)
    row_h = table_h_frac / n_total_rows

    # Style header
    for j in range(n_cols):
        cell = table[0, j]
        cell.set_facecolor(HEADER_BLUE)
        cell.set_text_props(color="white", fontweight="bold", fontsize=8)
        cell.set_edgecolor("white")
        cell.set_linewidth(1.5)
        cell.set_height(row_h)

    # Style data rows
    for i in range(n_data_rows):
        is_last = bold_last_row and (i == n_data_rows - 1)
        for j in range(n_cols):
            cell = table[i + 1, j]
            cell.set_edgecolor("#D9E2F3")
            cell.set_linewidth(0.8)
            cell.set_height(row_h)
            if is_last:
                cell.set_facecolor("#D9E2F3")
                cell.set_text_props(fontweight="bold")
            elif i % 2 == 0:
                cell.set_facecolor("#F2F2F2")
            else:
                cell.set_facecolor("white")
            if left_align_cols and j in left_align_cols:
                cell.set_text_props(ha="left")
                cell.PAD = 0.05
            if mono_cols and j in mono_cols:
                cell.set_text_props(fontfamily="monospace", fontsize=7.5)

    # Column widths
    if col_widths:
        for j, w in enumerate(col_widths):
            for i in range(n_data_rows + 1):
                table[i, j].set_width(w)

    return table


def render_sample_table(ax, inspect_data, stats, sample_names, gate_defs):
    """Render a styled matplotlib table of sample × gate statistics."""
    gate_order = topological_sort_gates(gate_defs) if gate_defs else []
    by_name = {g["name"]: g for g in gate_defs}
    gate_labels = [by_name[n].get("label", n) for n in gate_order]

    event_counts = {}
    if inspect_data:
        for s in inspect_data.get("samples", []):
            event_counts[s["file"]] = s["event_count"]
            pickle_name = os.path.splitext(s["file"])[0]
            event_counts[pickle_name] = s["event_count"]

    col_labels = ["Sample", "Events"] + gate_labels
    cell_text = []
    for sample_name in sample_names:
        events = event_counts.get(sample_name, "")
        events_str = f"{events:,}" if isinstance(events, int) else str(events)
        row = [sample_name, events_str]
        for gate_name in gate_order:
            if gate_name in stats and sample_name in stats[gate_name]:
                pct = stats[gate_name][sample_name]["percent_of_total"]
                row.append(f"{pct:.1f}%")
            else:
                row.append("--")
        cell_text.append(row)

    has_mean = len(sample_names) > 1
    if has_mean:
        mean_row = ["Mean", ""]
        for gate_name in gate_order:
            pcts = [stats[gate_name][sn]["percent_of_total"]
                    for sn in sample_names
                    if gate_name in stats and sn in stats[gate_name]]
            mean_row.append(f"{sum(pcts)/len(pcts):.1f}%" if pcts else "--")
        cell_text.append(mean_row)

    n_cols = len(col_labels)
    col_widths = [0.35] + [0.65 / max(n_cols - 1, 1)] * (n_cols - 1)

    _style_table(ax, "SAMPLE STATISTICS", col_labels, cell_text,
                 col_widths=col_widths, left_align_cols={0},
                 bold_last_row=has_mean)


def _gate_depth(name, by_name):
    """Compute nesting depth of a gate (root children = 0)."""
    depth = 0
    p = by_name[name].get("parent", "root")
    while p != "root" and p in by_name:
        depth += 1
        p = by_name[p].get("parent", "root")
    return depth


def _is_last_sibling(name, gate_order, by_name):
    """Check if this gate is the last child of its parent in the ordered list."""
    parent = by_name[name].get("parent", "root")
    siblings = [n for n in gate_order if by_name[n].get("parent", "root") == parent]
    return siblings[-1] == name


def _tree_prefix(name, gate_order, by_name):
    """Build a file-browser-style tree prefix like '├── ' or '└── '."""
    depth = _gate_depth(name, by_name)
    if depth == 0:
        return ""

    # Connector for this node
    is_last = _is_last_sibling(name, gate_order, by_name)
    connector = "└── " if is_last else "├── "

    # Build prefix for ancestor levels
    prefix = ""
    current = name
    for _ in range(depth - 1):
        parent = by_name[current].get("parent", "root")
        parent_is_last = _is_last_sibling(parent, gate_order, by_name)
        prefix = ("    " if parent_is_last else "│   ") + prefix
        current = parent

    return prefix + connector


def render_hierarchy_table(ax, gate_defs):
    """Render a styled gating hierarchy table with tree connectors."""
    if not gate_defs:
        ax.axis("off")
        ax.text(0.05, 0.5, "(no gates defined)", fontsize=9, transform=ax.transAxes)
        return

    gate_order = topological_sort_gates(gate_defs)
    by_name = {g["name"]: g for g in gate_defs}

    col_labels = ["Gate", "Channels"]
    cell_text = []
    for name in gate_order:
        g = by_name[name]
        label = g.get("label", name)
        prefix = _tree_prefix(name, gate_order, by_name)
        cell_text.append([
            f"{prefix}{label}",
            f"{g['x_channel']} vs {g['y_channel']}",
        ])

    _style_table(ax, "GATING HIERARCHY", col_labels, cell_text,
                 col_widths=[0.6, 0.4], left_align_cols={0}, mono_cols={0})


def render_markers_table(ax, panel):
    """Render a styled markers/panel table."""
    marker_entries = [(ch, m) for ch, m in (panel or {}).items() if m]
    if not marker_entries:
        ax.axis("off")
        ax.text(0.05, 0.5, "(none)", fontsize=9, transform=ax.transAxes)
        return

    col_labels = ["Channel", "Marker"]
    cell_text = [[ch, m] for ch, m in marker_entries]

    _style_table(ax, "MARKERS", col_labels, cell_text,
                 col_widths=[0.55, 0.45], left_align_cols={0, 1})


def render_stats_row(fig, gs, inspect_data, panel, gate_defs, stats, sample_names, row=0):
    """Render the statistics section into the given gridspec row.

    Layout: columns 0-1 span sample stats table,
    column 2 is split into hierarchy (top) and markers (bottom) via sub-gridspec.
    """
    # Left: sample table spanning columns 0-1
    ax_table = fig.add_subplot(gs[row, :2])
    render_sample_table(ax_table, inspect_data, stats, sample_names, gate_defs)

    # Right column: use sub-gridspec to split into two non-overlapping rows.
    # Weight = data rows + 1 header + 0.5 for title, so physical row height
    # matches the sample table on the left.
    n_gates = len(gate_defs) if gate_defs else 1
    n_markers = len([(ch, m) for ch, m in (panel or {}).items() if m]) or 1
    hier_weight = n_gates + 1.5
    marker_weight = n_markers + 1.5

    inner_gs = gs[row, 2].subgridspec(
        2, 1,
        height_ratios=[hier_weight, marker_weight],
        hspace=0.08,
    )

    ax_hier = fig.add_subplot(inner_gs[0])
    render_hierarchy_table(ax_hier, gate_defs)

    ax_markers = fig.add_subplot(inner_gs[1])
    render_markers_table(ax_markers, panel)


def extract_gate_name(fpath, gate_order):
    """Extract gate name from a gated plot filename like gated_{gate}_{sample}.png."""
    fname = os.path.basename(fpath)
    for gate_name in sorted(gate_order, key=len, reverse=True):
        if f"gated_{gate_name}_" in fname:
            return gate_name
    return None


def collect_pngs_by_gate(outdir, sample_names, gate_defs):
    """Collect gated PNGs grouped by gate (hierarchy order), each containing all samples.

    Returns: list of (gate_name, gate_label, [png_paths sorted by sample]) tuples,
    plus scatter_plots list and unmatched list.
    """
    gate_order = topological_sort_gates(gate_defs) if gate_defs else []
    by_name = {g["name"]: g for g in gate_defs}

    all_pngs = []
    for root, dirs, files in os.walk(outdir):
        parts = os.path.relpath(root, outdir).split(os.sep)
        if "work" in parts or "run_data" in parts or "input" in parts:
            continue
        for fname in files:
            if fname.endswith(".png") and fname not in (
                "output_summary.png", "summary.png", "summary_by_samples.png",
            ):
                all_pngs.append(os.path.join(root, fname))

    scatter_plots = []
    gated_by_gate = {name: [] for name in gate_order}
    unmatched = []

    for fpath in all_pngs:
        stage = classify_png(fpath, outdir)
        if stage == "scatter":
            scatter_plots.append(fpath)
        elif stage == "gated":
            gate = extract_gate_name(fpath, gate_order)
            if gate:
                gated_by_gate[gate].append(fpath)
            else:
                unmatched.append(fpath)
        else:
            unmatched.append(fpath)

    # Sort scatter plots and each gate group by sample order
    sample_rank = {name: i for i, name in enumerate(sample_names)}

    def by_sample(fpath):
        for name in sorted(sample_names, key=len, reverse=True):
            if name in os.path.basename(fpath):
                return sample_rank.get(name, 999)
        return 999

    scatter_plots.sort(key=by_sample)
    gate_groups = []
    for gate_name in gate_order:
        label = by_name[gate_name].get("label", gate_name)
        plots = sorted(gated_by_gate[gate_name], key=by_sample)
        if plots:
            gate_groups.append((gate_name, label, plots))

    return scatter_plots, gate_groups, unmatched


# --- Layout helpers ---

IMG_COLS = 3
CELL_W, CELL_H = 5, 4.5
LABEL_H = 0.5


def _compute_stats_height(inspect_data, panel, gate_defs, stats, sample_names):
    # Table rows: header + samples + optional mean row
    n_table_rows = len(sample_names) + 1  # +1 for header
    if len(sample_names) > 1:
        n_table_rows += 1  # mean row
    table_lines = n_table_rows + 2  # title + padding

    # Right column: hierarchy rows + markers rows + titles + spacing
    n_gates = len(gate_defs) if gate_defs else 1
    n_markers = len([(ch, m) for ch, m in (panel or {}).items() if m]) or 1
    right_lines = n_gates + n_markers + 6  # headers, titles, spacing

    max_lines = max(table_lines, right_lines)
    return max(2.5, max_lines * 0.25 + 0.6)


def _add_label_row(fig, gs, row, text):
    """Add a section label spanning all columns at the given grid row."""
    ax = fig.add_subplot(gs[row, :])
    ax.axis("off")
    ax.text(0.01, 0.35, f"  {text}", fontsize=12, fontweight="bold",
            verticalalignment="center", transform=ax.transAxes)
    ax.plot([0.01, 0.99], [0.05, 0.05], color="gray", linewidth=0.8,
            transform=ax.transAxes)


def _add_image_rows(fig, gs, start_row, png_paths, outdir):
    """Render images into grid cells starting at start_row. Returns rows consumed."""
    n = len(png_paths)
    if n == 0:
        return 0
    n_rows = math.ceil(n / IMG_COLS)
    for i, png_path in enumerate(png_paths):
        col = i % IMG_COLS
        row_offset = i // IMG_COLS
        ax = fig.add_subplot(gs[start_row + row_offset, col])
        try:
            img = mpimg.imread(png_path)
            ax.imshow(img)
        except Exception as e:
            ax.text(0.5, 0.5, f"Error: {e}", ha="center", va="center",
                    transform=ax.transAxes, fontsize=8)
        ax.axis("off")
    # Fill empty cells
    for i in range(n, n_rows * IMG_COLS):
        col = i % IMG_COLS
        row_offset = i // IMG_COLS
        ax = fig.add_subplot(gs[start_row + row_offset, col])
        ax.axis("off")
    return n_rows


def _plan_section(plots):
    """Return list of grid row heights for a label + image rows for a set of plots."""
    rows = [LABEL_H]
    n_img_rows = math.ceil(len(plots) / IMG_COLS) if plots else 0
    rows.extend([CELL_H] * n_img_rows)
    return rows


# --- summary.png: Gate Strategy view ---

def create_summary_png(outdir, stats, sample_names, gate_defs, inspect_data, panel,
                       png_sample_names=None):
    """Create summary.png organized by gate strategy.

    Layout:
    1. "Gate Strategy" — first sample's plots in gate order (scatter + gated)
    2. Statistics (table + hierarchy/markers)
    3. One section per gate step — all samples' gated plots for that gate
    """
    match_names = png_sample_names or sample_names
    samples_grouped, unmatched_by_sample = collect_pngs_by_sample(outdir, match_names, gate_defs=gate_defs)
    scatter_plots, gate_groups, unmatched_by_gate = collect_pngs_by_gate(outdir, match_names, gate_defs)

    print(f"  summary.png: {len(samples_grouped)} sample groups, match_names={match_names}")
    for name, plots in samples_grouped:
        print(f"    {name}: {len(plots)} plots")
    if unmatched_by_sample:
        for u in unmatched_by_sample:
            print(f"    unmatched (by sample): {os.path.basename(u)}")

    # Gate Strategy: first sample's plots in order
    first_sample_plots = []
    if samples_grouped:
        first_sample_plots = samples_grouped[0][1]

    stats_h = _compute_stats_height(inspect_data, panel, gate_defs, stats, sample_names)

    # Plan grid rows
    grid_rows = []

    # Section 1: Gate Strategy (first sample)
    strategy_rows = _plan_section(first_sample_plots)
    grid_rows.extend(strategy_rows)

    # Section 2: Statistics
    grid_rows.append(LABEL_H)  # "Statistics" label
    grid_rows.append(stats_h)  # stats content

    # Section 3: one section per gate
    for gate_name, label, plots in gate_groups:
        grid_rows.extend(_plan_section(plots))

    if not grid_rows:
        return None

    fig_w = CELL_W * IMG_COLS
    fig_h = sum(grid_rows)

    fig = plt.figure(figsize=(fig_w, fig_h))
    gs = fig.add_gridspec(
        nrows=len(grid_rows), ncols=IMG_COLS,
        height_ratios=grid_rows,
        hspace=0.15, wspace=0.15,
        left=0.03, right=0.97, top=0.99, bottom=0.01,
    )

    current_row = 0

    # Section 1: Gate Strategy
    first_name = samples_grouped[0][0] if samples_grouped else "Sample"
    _add_label_row(fig, gs, current_row, f"Gate Strategy ({first_name})")
    current_row += 1
    current_row += _add_image_rows(fig, gs, current_row, first_sample_plots, outdir)

    # Section 2: Statistics
    _add_label_row(fig, gs, current_row, "Statistics")
    current_row += 1
    render_stats_row(fig, gs, inspect_data, panel, gate_defs, stats, sample_names,
                     row=current_row)
    current_row += 1

    # Section 3: per-gate sections
    for gate_name, label, plots in gate_groups:
        _add_label_row(fig, gs, current_row, label)
        current_row += 1
        current_row += _add_image_rows(fig, gs, current_row, plots, outdir)

    output_path = os.path.join(outdir, "summary.png")
    plt.savefig(output_path, dpi=150, facecolor="white")
    plt.close()
    return output_path


# --- summary_by_samples.png: Sample-grouped view ---

def create_summary_by_samples_png(outdir, stats, sample_names, gate_defs, inspect_data, panel,
                                   png_sample_names=None):
    """Create summary_by_samples.png organized by sample.

    Layout:
    1. Statistics (table + hierarchy/markers)
    2. One section per sample — all plots in gate order
    """
    match_names = png_sample_names or sample_names
    samples_grouped, unmatched = collect_pngs_by_sample(
        outdir, match_names, gate_defs=gate_defs,
    )

    print(f"  summary_by_samples: {len(samples_grouped)} sample groups, {len(unmatched)} unmatched")
    for name, plots in samples_grouped:
        print(f"    {name}: {len(plots)} plots")
    if unmatched:
        for u in unmatched:
            print(f"    unmatched: {os.path.basename(u)}")

    stats_h = _compute_stats_height(inspect_data, panel, gate_defs, stats, sample_names)

    # Plan grid rows
    grid_rows = []

    # Section 1: Statistics
    grid_rows.append(LABEL_H)
    grid_rows.append(stats_h)

    # Section 2+: per sample
    for sample_name, plots in samples_grouped:
        grid_rows.extend(_plan_section(plots))

    if not grid_rows:
        return None

    fig_w = CELL_W * IMG_COLS
    fig_h = sum(grid_rows)

    fig = plt.figure(figsize=(fig_w, fig_h))
    gs = fig.add_gridspec(
        nrows=len(grid_rows), ncols=IMG_COLS,
        height_ratios=grid_rows,
        hspace=0.15, wspace=0.15,
        left=0.03, right=0.97, top=0.99, bottom=0.01,
    )

    current_row = 0

    # Section 1: Statistics
    _add_label_row(fig, gs, current_row, "Statistics")
    current_row += 1
    render_stats_row(fig, gs, inspect_data, panel, gate_defs, stats, sample_names,
                     row=current_row)
    current_row += 1

    # Section 2+: per sample
    for sample_name, plots in samples_grouped:
        _add_label_row(fig, gs, current_row, sample_name)
        current_row += 1
        current_row += _add_image_rows(fig, gs, current_row, plots, outdir)

    output_path = os.path.join(outdir, "summary_by_samples.png")
    plt.savefig(output_path, dpi=150, facecolor="white")
    plt.close()
    return output_path


def main():
    parser = argparse.ArgumentParser(description="Summarize flow cytometry results")
    parser.add_argument("--outdir", required=True, help="Output directory with results")
    parser.add_argument("--gates_file", required=True, help="Gates JSON file")
    parser.add_argument("--inspect_file", required=True, help="inspect_results.json")
    parser.add_argument("--panel_file", default=None, help="panel.json")
    args = parser.parse_args()

    gate_defs = load_json(args.gates_file)
    inspect_data = load_json(args.inspect_file)

    panel = {}
    if args.panel_file and os.path.exists(args.panel_file):
        panel = load_json(args.panel_file)

    stats, sample_names = load_gate_statistics(args.outdir)

    # Build an extended list for PNG matching that includes both pickle-style
    # names (without .fcs) and raw filenames. But keep sample_names as the
    # canonical list (from gate_statistics.csv) for display in tables.
    png_sample_names = list(sample_names)
    if inspect_data:
        for s in inspect_data.get("samples", []):
            pickle_name = os.path.splitext(s["file"])[0]
            if pickle_name not in png_sample_names:
                png_sample_names.append(pickle_name)
            if s["file"] not in png_sample_names:
                png_sample_names.append(s["file"])

    # Write summaries
    md_path = write_summary_markdown(stats, sample_names, gate_defs, inspect_data, panel, args.outdir)
    print(f"Wrote {md_path}")

    json_path = write_summary_json(stats, sample_names, gate_defs, inspect_data, panel, args.outdir)
    print(f"Wrote {json_path}")

    meta_path = write_run_metadata(args.outdir, gate_defs, inspect_data)
    print(f"Wrote {meta_path}")

    # Create summary images — use png_sample_names for PNG file matching,
    # sample_names for display in tables
    path = create_summary_png(
        args.outdir, stats, sample_names, gate_defs, inspect_data, panel,
        png_sample_names=png_sample_names,
    )
    if path:
        print(f"Wrote {path}")

    path = create_summary_by_samples_png(
        args.outdir, stats, sample_names, gate_defs, inspect_data, panel,
        png_sample_names=png_sample_names,
    )
    if path:
        print(f"Wrote {path}")


if __name__ == "__main__":
    main()
