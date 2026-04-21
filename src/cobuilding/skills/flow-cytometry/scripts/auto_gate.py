#!/usr/bin/env python3
"""Auto-gate stub: proposes a rectangle gate centered in the data range.

This is a placeholder. The future version will use a Claude agent to view
the scatter plot image and propose gate coordinates.
"""

import argparse
import glob
import json
import os
import pickle
import sys

import numpy as np


def load_first_sample(workdir):
    """Load the first preprocessed sample from the workdir."""
    pickles = sorted(glob.glob(os.path.join(workdir, "*_preprocessed.pickle")))
    if not pickles:
        print(f"ERROR: No preprocessed pickles found in {workdir}", file=sys.stderr)
        sys.exit(1)
    with open(pickles[0], "rb") as f:
        return pickle.load(f), os.path.basename(pickles[0]).replace("_preprocessed.pickle", "")


def get_channel_data(sample, channel):
    """Get event data for a channel."""
    try:
        events = sample.get_events(source="xform")
    except Exception:
        events = sample.get_events(source="raw")
    ch_idx = list(sample.pnn_labels).index(channel)
    return events[:, ch_idx]


def propose_gate(sample, x_channel, y_channel, gate_name, label, parent_gate):
    """Propose a rectangle gate centered in the data range.

    Stub: returns a rectangle covering the middle 50% of the data range
    in each dimension, which should be visible on any scatter plot.
    """
    x = get_channel_data(sample, x_channel)
    y = get_channel_data(sample, y_channel)

    # Filter out non-finite values
    valid = np.isfinite(x) & np.isfinite(y)
    x, y = x[valid], y[valid]

    # Use percentiles to get a robust data range (avoid outliers)
    x_p5, x_p95 = np.percentile(x, [5, 95])
    y_p5, y_p95 = np.percentile(y, [5, 95])

    x_range = x_p95 - x_p5
    y_range = y_p95 - y_p5

    # Place rectangle in the center 50% of the range
    x_center = (x_p5 + x_p95) / 2
    y_center = (y_p5 + y_p95) / 2

    gate = {
        "name": gate_name,
        "type": "rectangle",
        "x_channel": x_channel,
        "y_channel": y_channel,
        "parent": parent_gate,
        "label": label,
        "bounds": {
            "x_min": float(x_center - x_range * 0.25),
            "x_max": float(x_center + x_range * 0.25),
            "y_min": float(y_center - y_range * 0.25),
            "y_max": float(y_center + y_range * 0.25),
        },
    }
    return gate


def main():
    parser = argparse.ArgumentParser(description="Auto-gate stub")
    parser.add_argument("--workdir", required=True, help="Where preprocessed pickles live")
    parser.add_argument("--x_channel", required=True, help="X-axis channel")
    parser.add_argument("--y_channel", required=True, help="Y-axis channel")
    parser.add_argument("--gate_name", required=True, help="Name for the gate")
    parser.add_argument("--label", default=None, help="Biological label (default: gate_name)")
    parser.add_argument("--parent_gate", default="root", help="Parent gate name")
    parser.add_argument("--outdir", default=None, help="Output dir (default: workdir)")
    args = parser.parse_args()

    label = args.label or args.gate_name
    outdir = args.outdir or args.workdir

    sample, sample_name = load_first_sample(args.workdir)
    print(f"Using sample '{sample_name}' to determine data range")

    # Validate channels
    for ch in [args.x_channel, args.y_channel]:
        if ch not in sample.pnn_labels:
            print(f"ERROR: Channel '{ch}' not found. Available: {list(sample.pnn_labels)}",
                  file=sys.stderr)
            sys.exit(1)

    gate = propose_gate(sample, args.x_channel, args.y_channel,
                        args.gate_name, label, args.parent_gate)

    # Write proposal
    os.makedirs(outdir, exist_ok=True)
    proposal_path = os.path.join(outdir, "gate_proposal.json")
    with open(proposal_path, "w") as f:
        json.dump(gate, f, indent=2)

    bounds = gate["bounds"]
    print(f"Proposed gate '{args.gate_name}' ({label}):")
    print(f"  {args.x_channel}: [{bounds['x_min']:.2f}, {bounds['x_max']:.2f}]")
    print(f"  {args.y_channel}: [{bounds['y_min']:.2f}, {bounds['y_max']:.2f}]")
    print(f"Wrote {proposal_path}")


if __name__ == "__main__":
    main()
