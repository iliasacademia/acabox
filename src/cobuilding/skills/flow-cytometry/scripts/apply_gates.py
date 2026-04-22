#!/usr/bin/env python3
"""Apply gating strategy to preprocessed FCS data. Compute statistics and generate gated plots."""

import argparse
import csv
import glob
import json
import os
import pickle
import sys

import flowkit as fk
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def load_preprocessed(workdir, sample_names=None):
    """Load preprocessed Sample(s) from pickle files."""
    if sample_names:
        samples = {}
        for name in sample_names:
            path = os.path.join(workdir, f"{name}_preprocessed.pickle")
            if not os.path.exists(path):
                print(f"ERROR: Pickle not found: {path}", file=sys.stderr)
                sys.exit(1)
            with open(path, "rb") as f:
                samples[name] = pickle.load(f)
        return samples

    samples = {}
    for path in sorted(glob.glob(os.path.join(workdir, "*_preprocessed.pickle"))):
        name = os.path.basename(path).replace("_preprocessed.pickle", "")
        with open(path, "rb") as f:
            samples[name] = pickle.load(f)
    if not samples:
        print(f"ERROR: No preprocessed pickles found in {workdir}", file=sys.stderr)
        sys.exit(1)
    return samples


def load_panel(panel_file):
    """Load panel mapping from JSON."""
    if not panel_file or not os.path.exists(panel_file):
        return {}
    with open(panel_file) as f:
        return json.load(f)


def channel_label(channel, panel):
    """Format axis label with marker name if available."""
    marker = panel.get(channel)
    if marker:
        return f"{marker} ({channel})"
    return channel


def resolve_gate_path(gate_name, gate_defs_by_name):
    """Walk the parent chain to build the full gate path for FlowKit.
    E.g., if CD4+ parent is CD3+ and CD3+ parent is Lymphocytes and
    Lymphocytes parent is root, returns ("root", "Lymphocytes", "CD3+")."""
    path = ["root"]
    current = gate_defs_by_name.get(gate_name, {}).get("parent", "root")
    ancestors = []
    visited = set()
    while current != "root":
        if current in visited:
            print(f"WARNING: Circular parent chain for gate '{gate_name}'")
            break
        visited.add(current)
        ancestors.append(current)
        current = gate_defs_by_name.get(current, {}).get("parent", "root")
    # Ancestors are in child→grandparent order, reverse to get root→parent
    path.extend(reversed(ancestors))
    return tuple(path)


def build_gating_strategy(gate_defs):
    """Build a FlowKit GatingStrategy from gate definitions.
    Handles arbitrarily nested gate hierarchies."""
    strategy = fk.GatingStrategy()

    # Index by name for parent lookups
    gate_defs_by_name = {g["name"]: g for g in gate_defs}

    # Sort gates so parents are added before children
    added = set()
    ordered = []

    def add_with_deps(gdef):
        name = gdef["name"]
        if name in added:
            return
        parent = gdef.get("parent", "root")
        if parent != "root" and parent not in added:
            if parent in gate_defs_by_name:
                add_with_deps(gate_defs_by_name[parent])
            else:
                print(f"WARNING: Parent gate '{parent}' for '{name}' not found in definitions")
        ordered.append(gdef)
        added.add(name)

    for gdef in gate_defs:
        add_with_deps(gdef)

    for gate_def in ordered:
        name = gate_def["name"]
        gate_type = gate_def["type"]
        x_ch = gate_def["x_channel"]
        y_ch = gate_def["y_channel"]

        if gate_type == "rectangle":
            bounds = gate_def["bounds"]
            dim_x = fk.Dimension(x_ch, range_min=bounds["x_min"], range_max=bounds["x_max"])
            dim_y = fk.Dimension(y_ch, range_min=bounds["y_min"], range_max=bounds["y_max"])
            gate = fk.gates.RectangleGate(name, dimensions=[dim_x, dim_y])

        elif gate_type == "polygon":
            vertices = gate_def["vertices"]
            dim_x = fk.Dimension(x_ch)
            dim_y = fk.Dimension(y_ch)
            gate = fk.gates.PolygonGate(name, dimensions=[dim_x, dim_y], vertices=vertices)
        else:
            print(f"WARNING: Unknown gate type '{gate_type}' for gate '{name}', skipping")
            continue

        gate_path = resolve_gate_path(name, gate_defs_by_name)
        strategy.add_gate(gate, gate_path=gate_path)

    return strategy


def apply_gates_to_sample(sample, strategy, gate_defs):
    """Apply gating strategy to a sample and return statistics."""
    result = strategy.gate_sample(sample)
    total_events = sample.event_count

    stats = []
    for gate_def in gate_defs:
        name = gate_def["name"]
        label = gate_def.get("label", name)
        parent = gate_def.get("parent", "root")

        try:
            membership = result.get_gate_membership(name)
            event_count = int(membership.sum())

            # Percent of parent
            if parent == "root":
                parent_count = total_events
            else:
                parent_membership = result.get_gate_membership(parent)
                parent_count = int(parent_membership.sum())

            pct_parent = (event_count / parent_count * 100) if parent_count > 0 else 0.0
            pct_total = (event_count / total_events * 100) if total_events > 0 else 0.0

            stats.append({
                "gate": name,
                "label": label,
                "parent": parent,
                "event_count": event_count,
                "percent_of_parent": round(pct_parent, 2),
                "percent_of_total": round(pct_total, 2),
            })
        except Exception as e:
            print(f"  WARNING: Could not get results for gate '{name}': {e}")
            stats.append({
                "gate": name,
                "label": label,
                "parent": parent,
                "event_count": 0,
                "percent_of_parent": 0.0,
                "percent_of_total": 0.0,
                "error": str(e),
            })

    return stats, result


def plot_gated_scatter(sample, gating_result, gate_def, panel, outdir, sample_name, subsample=15000):
    """Generate a scatter plot showing a gate and its population."""
    x_ch = gate_def["x_channel"]
    y_ch = gate_def["y_channel"]
    name = gate_def["name"]
    label = gate_def.get("label", name)

    try:
        events_xform = sample.get_events(source="xform")
    except Exception:
        events_xform = sample.get_events(source="raw")

    x_idx = list(sample.pnn_labels).index(x_ch)
    y_idx = list(sample.pnn_labels).index(y_ch)
    x = events_xform[:, x_idx]
    y = events_xform[:, y_idx]

    # Get gate membership
    try:
        membership = gating_result.get_gate_membership(name)
    except Exception:
        membership = np.zeros(len(x), dtype=bool)

    # Subsample
    n = min(subsample, len(x))
    idx = np.random.choice(len(x), n, replace=False)

    fig, ax = plt.subplots(figsize=(7, 6))

    # Plot non-gated events in gray
    outside = idx[~membership[idx]]
    inside = idx[membership[idx]]

    ax.scatter(x[outside], y[outside], s=1, alpha=0.2, c="lightgray", rasterized=True)
    ax.scatter(x[inside], y[inside], s=2, alpha=0.5, c="steelblue", rasterized=True)

    # Draw gate outline
    if gate_def["type"] == "rectangle":
        bounds = gate_def["bounds"]
        rect = plt.Rectangle(
            (bounds["x_min"], bounds["y_min"]),
            bounds["x_max"] - bounds["x_min"],
            bounds["y_max"] - bounds["y_min"],
            linewidth=2, edgecolor="red", facecolor="none", linestyle="--",
        )
        ax.add_patch(rect)
    elif gate_def["type"] == "polygon":
        from matplotlib.patches import Polygon
        poly = Polygon(gate_def["vertices"], closed=True, linewidth=2,
                       edgecolor="red", facecolor="none", linestyle="--")
        ax.add_patch(poly)

    event_count = int(membership.sum())
    pct = event_count / len(x) * 100 if len(x) > 0 else 0

    ax.set_xlabel(channel_label(x_ch, panel), fontsize=13)
    ax.set_ylabel(channel_label(y_ch, panel), fontsize=13)
    ax.set_title(f"{sample_name} — {label}\n{event_count:,} events ({pct:.1f}%)", fontsize=13)

    plt.tight_layout()
    filename = f"gated_{name}_{sample_name}.png".replace("/", "_").replace(" ", "_")
    path = os.path.join(outdir, filename)
    plt.savefig(path, dpi=150, bbox_inches="tight")
    plt.close()
    return path


def write_statistics_csv(all_stats, outdir):
    """Write gate_statistics.csv."""
    path = os.path.join(outdir, "gate_statistics.csv")
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=[
            "sample", "gate", "label", "parent",
            "event_count", "percent_of_parent", "percent_of_total",
        ])
        writer.writeheader()
        for sample_name, stats in all_stats.items():
            for s in stats:
                writer.writerow({
                    "sample": sample_name,
                    "gate": s["gate"],
                    "label": s["label"],
                    "parent": s["parent"],
                    "event_count": s["event_count"],
                    "percent_of_parent": s["percent_of_parent"],
                    "percent_of_total": s["percent_of_total"],
                })
    return path


def main():
    parser = argparse.ArgumentParser(description="Apply gates to FCS data")
    parser.add_argument("--workdir", required=True, help="Where preprocessed pickles live")
    parser.add_argument("--outdir", required=True, help="Output directory")
    parser.add_argument("--gates_file", required=True, help="JSON file with gate definitions")
    parser.add_argument("--panel_file", default=None, help="Path to panel.json")
    parser.add_argument("--inspect_file", default=None,
                        help="Path to inspect_results.json (needed for WSP export)")
    parser.add_argument("--samples", nargs="*", default=None, help="Sample names (default: all)")
    args = parser.parse_args()

    os.makedirs(args.outdir, exist_ok=True)

    # Load gates
    if not os.path.exists(args.gates_file):
        print(f"ERROR: Gates file not found: {args.gates_file}", file=sys.stderr)
        sys.exit(1)
    with open(args.gates_file) as f:
        gate_defs = json.load(f)

    if not gate_defs:
        print("ERROR: No gates defined in gates file", file=sys.stderr)
        sys.exit(1)

    panel = load_panel(args.panel_file)
    samples = load_preprocessed(args.workdir, args.samples)

    # Build gating strategy
    strategy = build_gating_strategy(gate_defs)
    print(f"Built gating strategy with {len(gate_defs)} gate(s)")

    # Apply to each sample
    all_stats = {}
    gated_plot_dir = os.path.join(args.outdir, "gated_plots")
    os.makedirs(gated_plot_dir, exist_ok=True)

    for sample_name, sample in samples.items():
        print(f"\nProcessing {sample_name}...")
        stats, gating_result = apply_gates_to_sample(sample, strategy, gate_defs)
        all_stats[sample_name] = stats

        for s in stats:
            print(f"  {s['label']}: {s['event_count']:,} events "
                  f"({s['percent_of_parent']:.1f}% of parent, "
                  f"{s['percent_of_total']:.1f}% of total)")

        # Generate gated plots
        for gate_def in gate_defs:
            plot_path = plot_gated_scatter(
                sample, gating_result, gate_def, panel,
                gated_plot_dir, sample_name,
            )
            print(f"  Plot: {plot_path}")

    # Write statistics CSV
    csv_path = write_statistics_csv(all_stats, args.outdir)
    print(f"\nWrote {csv_path}")

    # Write structured results JSON
    results = {
        "gates": [{"name": g["name"], "label": g.get("label", g["name"]),
                    "parent": g.get("parent", "root")} for g in gate_defs],
        "samples": {},
    }
    for sample_name, stats in all_stats.items():
        results["samples"][sample_name] = stats

    run_data_dir = os.path.join(args.outdir, "run_data")
    os.makedirs(run_data_dir, exist_ok=True)
    results_path = os.path.join(run_data_dir, "gate_results.json")
    with open(results_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"Wrote {results_path}")

    # Export FlowJo workspace (.wsp)
    fcs_paths = None
    if args.inspect_file and os.path.exists(args.inspect_file):
        with open(args.inspect_file) as f:
            inspect_data = json.load(f)
        fcs_paths = [s["path"] for s in inspect_data["samples"]]

    if fcs_paths:
        wsp_path = export_wsp(fcs_paths, gate_defs, args.outdir)
        if wsp_path:
            print(f"Wrote {wsp_path}")
    else:
        print("Skipping WSP export (no --inspect_file provided)")


def export_wsp(fcs_paths, gate_defs, outdir):
    """Export a FlowJo-compatible .wsp workspace file."""
    try:
        session = fk.Session(fcs_path_list=fcs_paths)

        # Build and add gating strategy
        strategy = build_gating_strategy(gate_defs)
        group_name = "All Samples"
        sample_ids = session.get_sample_ids()

        session.add_sample_group(group_name, sample_ids=sample_ids, gating_strategy=strategy)

        wsp_path = os.path.join(outdir, "analysis.wsp")
        session.export_wsp(wsp_path, group_name)
        return wsp_path
    except Exception as e:
        print(f"WARNING: WSP export failed: {e}")
        return None


if __name__ == "__main__":
    main()
