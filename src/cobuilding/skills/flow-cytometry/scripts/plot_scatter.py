#!/usr/bin/env python3
"""Generate matplotlib scatter plots from preprocessed FCS data."""

import argparse
import glob
import json
import os
import pickle
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def load_preprocessed(workdir, sample_name=None):
    """Load preprocessed Sample(s) from pickle files.
    If sample_name is None, load all pickles in workdir."""
    if sample_name:
        path = os.path.join(workdir, f"{sample_name}_preprocessed.pickle")
        if not os.path.exists(path):
            print(f"ERROR: Pickle not found: {path}", file=sys.stderr)
            sys.exit(1)
        with open(path, "rb") as f:
            return {sample_name: pickle.load(f)}

    # Load all
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
    """Load panel mapping from JSON file."""
    if not panel_file or not os.path.exists(panel_file):
        return {}
    with open(panel_file) as f:
        return json.load(f)


def load_gates(gates_file):
    """Load gate definitions from JSON file."""
    if not gates_file or not os.path.exists(gates_file):
        return []
    with open(gates_file) as f:
        return json.load(f)


def channel_label(channel, panel):
    """Format axis label: 'CD4 (FITC-A)' if panel has marker, else 'FITC-A'."""
    marker = panel.get(channel)
    if marker:
        return f"{marker} ({channel})"
    return channel


def get_events_for_channel(sample, channel):
    """Get event data for a channel, trying xform first then raw."""
    try:
        events = sample.get_events(source="xform")
    except Exception:
        events = sample.get_events(source="raw")
    ch_idx = list(sample.pnn_labels).index(channel)
    return events[:, ch_idx]


def density_colors(x, y, bins=80):
    """Compute density-based colors for scatter points."""
    # 2D histogram for density estimation
    valid = np.isfinite(x) & np.isfinite(y)
    x_valid, y_valid = x[valid], y[valid]
    if len(x_valid) < 10:
        return np.ones(len(x)), valid

    hist, xedges, yedges = np.histogram2d(x_valid, y_valid, bins=bins)

    # Map each point to its density bin
    x_bin = np.clip(np.digitize(x_valid, xedges) - 1, 0, bins - 1)
    y_bin = np.clip(np.digitize(y_valid, yedges) - 1, 0, bins - 1)
    density = hist[x_bin, y_bin]

    # Normalize to [0, 1]
    if density.max() > 0:
        density = density / density.max()

    colors = np.zeros(len(x))
    colors[valid] = density
    return colors, valid


def subsample_density_aware(x, y, n, grid_size=20):
    """Density-aware subsampling that preserves rare populations."""
    if len(x) <= n:
        return np.arange(len(x))

    valid = np.isfinite(x) & np.isfinite(y)
    valid_idx = np.where(valid)[0]
    x_v, y_v = x[valid_idx], y[valid_idx]

    if len(valid_idx) <= n:
        return valid_idx

    # Divide into grid cells, sample proportionally per cell
    x_bins = np.linspace(x_v.min(), x_v.max() + 1e-10, grid_size + 1)
    y_bins = np.linspace(y_v.min(), y_v.max() + 1e-10, grid_size + 1)

    x_cell = np.clip(np.digitize(x_v, x_bins) - 1, 0, grid_size - 1)
    y_cell = np.clip(np.digitize(y_v, y_bins) - 1, 0, grid_size - 1)
    cell_id = x_cell * grid_size + y_cell

    unique_cells, cell_counts = np.unique(cell_id, return_counts=True)
    n_cells = len(unique_cells)

    # Allocate: minimum 1 per occupied cell, rest proportional
    base_per_cell = max(1, n // (n_cells * 2))
    remaining = n - base_per_cell * n_cells
    proportional = (cell_counts / cell_counts.sum() * max(0, remaining)).astype(int)
    samples_per_cell = base_per_cell + proportional

    selected = []
    for cell, count in zip(unique_cells, samples_per_cell):
        cell_mask = cell_id == cell
        cell_indices = valid_idx[cell_mask]
        k = min(count, len(cell_indices))
        if k > 0:
            chosen = np.random.choice(cell_indices, k, replace=False)
            selected.extend(chosen)

    return np.array(selected[:n])


def draw_gate_overlay(ax, gate, x_channel, y_channel):
    """Draw a gate outline on a scatter plot axis."""
    if gate["x_channel"] != x_channel or gate["y_channel"] != y_channel:
        return

    if gate["type"] == "rectangle":
        bounds = gate["bounds"]
        rect = plt.Rectangle(
            (bounds["x_min"], bounds["y_min"]),
            bounds["x_max"] - bounds["x_min"],
            bounds["y_max"] - bounds["y_min"],
            linewidth=2, edgecolor="red", facecolor="none", linestyle="--",
        )
        ax.add_patch(rect)
        ax.text(bounds["x_min"], bounds["y_max"],
                f" {gate.get('label', gate['name'])}",
                color="red", fontsize=9, fontweight="bold",
                verticalalignment="bottom")

    elif gate["type"] == "polygon":
        verts = gate["vertices"]
        from matplotlib.patches import Polygon
        poly = Polygon(verts, closed=True, linewidth=2,
                       edgecolor="red", facecolor="none", linestyle="--")
        ax.add_patch(poly)
        # Label at centroid
        cx = np.mean([v[0] for v in verts])
        cy = np.mean([v[1] for v in verts])
        ax.text(cx, cy, gate.get("label", gate["name"]),
                color="red", fontsize=9, fontweight="bold",
                ha="center", va="center")


def plot_single_sample(sample, sample_name, x_channel, y_channel, panel,
                       gates, parent_gate, subsample_n, outdir):
    """Generate a scatter plot for one sample. Returns output path."""
    x = get_events_for_channel(sample, x_channel)
    y = get_events_for_channel(sample, y_channel)

    # Apply parent gate mask if specified
    # (parent gating is handled by apply_gates.py; here we just plot all events
    #  unless a simple root/all filter is intended)

    # Subsample
    idx = subsample_density_aware(x, y, subsample_n)
    x_sub = x[idx]
    y_sub = y[idx]

    # Compute density colors
    colors, valid = density_colors(x_sub, y_sub)

    fig, ax = plt.subplots(figsize=(7, 6))
    scatter = ax.scatter(x_sub[valid], y_sub[valid], c=colors[valid],
                         cmap="viridis", s=2, alpha=0.6, rasterized=True)

    ax.set_xlabel(channel_label(x_channel, panel), fontsize=13)
    ax.set_ylabel(channel_label(y_channel, panel), fontsize=13)
    ax.set_title(f"{sample_name}\n{channel_label(x_channel, panel)} vs {channel_label(y_channel, panel)}\n"
                 f"({len(x_sub):,} of {len(x):,} events)", fontsize=13)

    # Overlay gates
    for gate in gates:
        if gate.get("parent", "root") == parent_gate or parent_gate == "root":
            draw_gate_overlay(ax, gate, x_channel, y_channel)

    plt.tight_layout()
    gate_suffix = f"_{parent_gate}" if parent_gate != "root" else ""
    filename = f"{x_channel}_{y_channel}{gate_suffix}_{sample_name}.png"
    # Sanitize filename
    filename = filename.replace("/", "_").replace(" ", "_")
    path = os.path.join(outdir, filename)
    plt.savefig(path, dpi=150, bbox_inches="tight")
    plt.close()
    return path, {"x_min": float(np.nanmin(x)), "x_max": float(np.nanmax(x)),
                  "y_min": float(np.nanmin(y)), "y_max": float(np.nanmax(y)),
                  "total_events": len(x), "plotted_events": len(x_sub)}


def main():
    parser = argparse.ArgumentParser(description="Generate scatter plots")
    parser.add_argument("--workdir", required=True, help="Where preprocessed pickles live")
    parser.add_argument("--outdir", required=True, help="Output directory for plots")
    parser.add_argument("--x_channel", required=True, help="X-axis channel")
    parser.add_argument("--y_channel", required=True, help="Y-axis channel")
    parser.add_argument("--panel_file", default=None, help="Path to panel.json")
    parser.add_argument("--samples", nargs="*", default=None, help="Sample names (default: all)")
    parser.add_argument("--parent_gate", default="root", help="Parent gate name")
    parser.add_argument("--gates_file", default=None, help="Path to gates JSON for overlays")
    parser.add_argument("--subsample", type=int, default=15000, help="Max events to plot")
    args = parser.parse_args()

    os.makedirs(args.outdir, exist_ok=True)

    panel = load_panel(args.panel_file)
    gates = load_gates(args.gates_file)

    # Load samples
    if args.samples:
        samples = {}
        for name in args.samples:
            samples.update(load_preprocessed(args.workdir, name))
    else:
        samples = load_preprocessed(args.workdir)

    # Validate channels exist
    first_sample = next(iter(samples.values()))
    for ch in [args.x_channel, args.y_channel]:
        if ch not in first_sample.pnn_labels:
            print(f"ERROR: Channel '{ch}' not found. Available: {list(first_sample.pnn_labels)}",
                  file=sys.stderr)
            sys.exit(1)

    metadata = {"plots": [], "x_channel": args.x_channel, "y_channel": args.y_channel,
                "parent_gate": args.parent_gate}

    for name, sample in samples.items():
        print(f"Plotting {name}: {args.x_channel} vs {args.y_channel}...")
        path, stats = plot_single_sample(
            sample, name, args.x_channel, args.y_channel, panel,
            gates, args.parent_gate, args.subsample, args.outdir,
        )
        print(f"  Saved: {path}")
        metadata["plots"].append({"sample": name, "path": path, **stats})

    # Write metadata to run_data/ (one level up from plots/ subdir if applicable)
    # Determine the main outdir: if --outdir is .../plots, put run_data at parent
    main_outdir = args.outdir
    if os.path.basename(main_outdir) == "plots":
        main_outdir = os.path.dirname(main_outdir)
    run_data_dir = os.path.join(main_outdir, "run_data")
    os.makedirs(run_data_dir, exist_ok=True)
    meta_path = os.path.join(run_data_dir, "plot_metadata.json")
    with open(meta_path, "w") as f:
        json.dump(metadata, f, indent=2)
    print(f"Wrote {meta_path}")


if __name__ == "__main__":
    main()
