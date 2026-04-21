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

    path = os.path.join(outdir, "summary.json")
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

    path = os.path.join(outdir, "run_metadata.json")
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


def collect_pngs(outdir, gate_defs=None):
    """Collect all PNG files in the output directory, ordered by analysis stage.

    Order: compensation QC -> ungated scatter plots -> gated plots (hierarchy order).
    This mirrors the analytical workflow from beginning to end.
    """
    compensation_qc = []
    scatter_plots = []
    gated_plots = []  # will be sorted by hierarchy
    other = []

    for root, dirs, files in os.walk(outdir):
        parts = os.path.relpath(root, outdir).split(os.sep)
        if "work" in parts:
            continue
        for fname in sorted(files):
            if not fname.endswith(".png") or fname == "output_summary.png":
                continue
            fpath = os.path.join(root, fname)
            rel_dir = os.path.relpath(root, outdir)

            if "compensation_qc" in rel_dir:
                compensation_qc.append(fpath)
            elif "gated_plots" in rel_dir or fname.startswith("gated_"):
                gated_plots.append(fpath)
            elif "plots" in rel_dir or rel_dir == ".":
                scatter_plots.append(fpath)
            else:
                other.append(fpath)

    # Sort gated plots by gate hierarchy order (parents first),
    # then by sample name within each gate
    if gate_defs and gated_plots:
        gate_order = topological_sort_gates(gate_defs)
        gate_rank = {name: i for i, name in enumerate(gate_order)}

        def gated_sort_key(path):
            fname = os.path.basename(path)
            # Filename pattern: gated_{gate_name}_{sample_name}.png
            for gate_name in gate_order:
                if f"gated_{gate_name}_" in fname:
                    return (gate_rank[gate_name], fname)
            return (len(gate_order), fname)  # unknown gates go last

        gated_plots.sort(key=gated_sort_key)

    return compensation_qc + scatter_plots + gated_plots + other


def build_panel_text(inspect_data, panel):
    """Build the Panel column text."""
    lines = ["PANEL"]
    lines.append("")
    if inspect_data:
        lines.append("Samples:")
        for s in inspect_data.get("samples", []):
            lines.append(f"  {s['file']}")
            lines.append(f"    {s['event_count']:,} events")
        lines.append("")
    if panel:
        marker_entries = [(ch, m) for ch, m in panel.items() if m]
        if marker_entries:
            lines.append("Markers:")
            for ch, m in marker_entries:
                lines.append(f"  {ch} -> {m}")
    return "\n".join(lines)


def build_hierarchy_text(gate_defs):
    """Build the Gating Hierarchy column text."""
    lines = ["GATING HIERARCHY"]
    lines.append("")
    if not gate_defs:
        lines.append("(no gates defined)")
        return "\n".join(lines)
    gate_order = topological_sort_gates(gate_defs)
    by_name = {g["name"]: g for g in gate_defs}
    for name in gate_order:
        g = by_name[name]
        label = g.get("label", name)
        depth = 0
        p = g.get("parent", "root")
        while p != "root" and p in by_name:
            depth += 1
            p = by_name[p].get("parent", "root")
        indent = "  " * depth
        lines.append(f"{indent}{label}")
        lines.append(f"{indent}  {g['x_channel']} vs {g['y_channel']}")
    return "\n".join(lines)


def build_population_text(stats, sample_names, gate_defs):
    """Build the Population Statistics column text."""
    lines = ["POPULATION STATISTICS"]
    lines.append("")
    if not (stats and sample_names and gate_defs):
        lines.append("(no statistics)")
        return "\n".join(lines)

    for gate_def in gate_defs:
        gate_name = gate_def["name"]
        label = gate_def.get("label", gate_name)
        lines.append(f"{label}:")
        for sample_name in sample_names:
            if gate_name in stats and sample_name in stats[gate_name]:
                s = stats[gate_name][sample_name]
                lines.append(f"  {sample_name}: {s['event_count']:,} "
                             f"({s['percent_of_total']:.1f}%)")
            else:
                lines.append(f"  {sample_name}: --")
        # Mean across samples
        pcts = []
        for sample_name in sample_names:
            if gate_name in stats and sample_name in stats[gate_name]:
                pcts.append(stats[gate_name][sample_name]["percent_of_total"])
        if len(pcts) > 1:
            lines.append(f"  Mean: {sum(pcts)/len(pcts):.1f}%")
        lines.append("")

    return "\n".join(lines)


def render_stats_row(fig, gs, inspect_data, panel, gate_defs, stats, sample_names):
    """Render the three-column stats section into row 0 of the gridspec."""
    col_texts = [
        build_panel_text(inspect_data, panel),
        build_hierarchy_text(gate_defs),
        build_population_text(stats, sample_names, gate_defs),
    ]
    for i, text in enumerate(col_texts):
        ax = fig.add_subplot(gs[0, i])
        ax.axis("off")
        ax.text(0.05, 0.95, text, fontsize=8, fontfamily="monospace",
                verticalalignment="top", transform=ax.transAxes, linespacing=1.3)


def create_output_summary_png(outdir, stats, sample_names, gate_defs, inspect_data, panel):
    """Create a single large PNG containing all plot images and key statistics."""
    pngs = collect_pngs(outdir, gate_defs=gate_defs)
    if not pngs:
        print("No PNG files found to include in output_summary.png")
        return None

    # Compute stats panel height from the tallest column
    col_texts = [
        build_panel_text(inspect_data, panel),
        build_hierarchy_text(gate_defs),
        build_population_text(stats, sample_names, gate_defs),
    ]
    max_lines = max(t.count("\n") + 1 for t in col_texts)
    line_height_inches = 0.18
    stats_h = max(1.5, max_lines * line_height_inches + 0.5)

    # Image grid layout: 3 columns, matching the stats columns
    n_images = len(pngs)
    img_cols = 3
    img_rows = math.ceil(n_images / img_cols)

    cell_w, cell_h = 5, 4.5
    fig_w = cell_w * img_cols
    fig_h = stats_h + cell_h * img_rows

    fig = plt.figure(figsize=(fig_w, fig_h))
    gs = fig.add_gridspec(
        nrows=1 + img_rows, ncols=img_cols,
        height_ratios=[stats_h] + [cell_h] * img_rows,
        hspace=0.3, wspace=0.15,
        left=0.03, right=0.97, top=0.97, bottom=0.02,
    )

    # Stats: three columns in the first row
    render_stats_row(fig, gs, inspect_data, panel, gate_defs, stats, sample_names)

    # Image grid
    for i, png_path in enumerate(pngs):
        row = i // img_cols
        col = i % img_cols

        ax = fig.add_subplot(gs[1 + row, col])
        try:
            img = mpimg.imread(png_path)
            ax.imshow(img)
        except Exception as e:
            ax.text(0.5, 0.5, f"Error loading\n{e}", ha="center", va="center",
                    transform=ax.transAxes, fontsize=8)
        ax.axis("off")

        rel_path = os.path.relpath(png_path, outdir)
        ax.set_title(rel_path, fontsize=7, pad=4)

    # Hide empty grid cells
    for i in range(n_images, img_rows * img_cols):
        row = i // img_cols
        col = i % img_cols
        ax = fig.add_subplot(gs[1 + row, col])
        ax.axis("off")

    output_path = os.path.join(outdir, "output_summary.png")
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

    # Write summaries
    md_path = write_summary_markdown(stats, sample_names, gate_defs, inspect_data, panel, args.outdir)
    print(f"Wrote {md_path}")

    json_path = write_summary_json(stats, sample_names, gate_defs, inspect_data, panel, args.outdir)
    print(f"Wrote {json_path}")

    meta_path = write_run_metadata(args.outdir, gate_defs, inspect_data)
    print(f"Wrote {meta_path}")

    # Create combined output summary image
    summary_png = create_output_summary_png(
        args.outdir, stats, sample_names, gate_defs, inspect_data, panel,
    )
    if summary_png:
        print(f"Wrote {summary_png}")


if __name__ == "__main__":
    main()
