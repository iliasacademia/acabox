#!/usr/bin/env python3
"""Preprocess FCS files: compensation + logicle transformation. Saves pickled Samples."""

import argparse
import json
import os
import pickle
import sys

import flowkit as fk
import numpy as np


def sample_name_from_path(fcs_path):
    """Derive a clean sample name from an FCS file path."""
    return os.path.splitext(os.path.basename(fcs_path))[0]


def compensate_sample(sample, compensation):
    """Apply compensation to a sample. Returns True if compensation was applied."""
    if compensation == "none":
        return False

    if compensation == "auto":
        # Try to use embedded spillover matrix
        try:
            sample.apply_compensation(sample.metadata["spill"])
            return True
        except (KeyError, TypeError, Exception) as e:
            print(f"  Warning: No embedded spillover matrix found ({e}). Skipping compensation.")
            return False
    else:
        # Load compensation matrix from CSV
        if not os.path.exists(compensation):
            print(f"ERROR: Compensation file not found: {compensation}", file=sys.stderr)
            sys.exit(1)
        # Read CSV as a numpy matrix
        import csv
        with open(compensation) as f:
            reader = csv.reader(f)
            header = next(reader)
            matrix = np.array([[float(x) for x in row] for row in reader])
        sample.apply_compensation(matrix)
        return True


def transform_sample(sample):
    """Apply logicle transform to fluorescence channels."""
    # Get fluorescence channel indices (skip scatter and time channels)
    fluoro_indices = []
    for i, label in enumerate(sample.pnn_labels):
        label_upper = label.upper()
        if (label_upper.startswith("FSC") or label_upper.startswith("SSC")
                or label_upper.lower() == "time"):
            continue
        fluoro_indices.append(i)

    if not fluoro_indices:
        print("  Warning: No fluorescence channels found to transform.")
        return {}

    # Apply logicle transform to fluorescence channels
    xform = fk.transforms.LogicleTransform(param_t=262144, param_w=0.5,
                                            param_m=4.5, param_a=0)
    fluoro_labels = [sample.pnn_labels[i] for i in fluoro_indices]
    xform_dict = {label: xform for label in fluoro_labels}
    sample.apply_transform(xform_dict)

    return {
        "type": "logicle",
        "channels": fluoro_labels,
        "params": {"T": 262144, "W": 0.5, "M": 4.5, "A": 0},
    }


def main():
    parser = argparse.ArgumentParser(description="Preprocess FCS files")
    parser.add_argument("--fcs_files", nargs="*", default=None, help="Paths to .fcs files")
    parser.add_argument("--inspect_file", default=None,
                        help="Path to inspect_results.json (reads FCS paths from it)")
    parser.add_argument("--workdir", required=True, help="Working directory for pickle files")
    parser.add_argument("--outdir", required=True, help="Output directory for QC plots")
    parser.add_argument("--compensation", default="auto",
                        help='"auto" to use embedded matrix, "none" to skip, or path to CSV')
    parser.add_argument("--transform", default="logicle", help="Transform type (default: logicle)")
    args = parser.parse_args()

    # Resolve FCS file paths: from --inspect_file or --fcs_files
    if args.inspect_file:
        with open(args.inspect_file) as f:
            inspect_data = json.load(f)
        args.fcs_files = [s["path"] for s in inspect_data["samples"]]
        print(f"Read {len(args.fcs_files)} file path(s) from {args.inspect_file}")
    if not args.fcs_files:
        parser.error("Either --fcs_files or --inspect_file is required")

    os.makedirs(args.workdir, exist_ok=True)
    os.makedirs(args.outdir, exist_ok=True)

    summary = {"samples": [], "transform": None}

    for fcs_path in args.fcs_files:
        if not os.path.exists(fcs_path):
            print(f"ERROR: File not found: {fcs_path}", file=sys.stderr)
            sys.exit(1)

        name = sample_name_from_path(fcs_path)
        print(f"Processing {name}...")

        # Load sample for processing
        sample = fk.Sample(fcs_path)

        # Compensate
        compensated = compensate_sample(sample, args.compensation)
        print(f"  Compensation: {'applied' if compensated else 'skipped'}")

        # Transform
        xform_info = transform_sample(sample)
        if xform_info:
            print(f"  Transform: {xform_info['type']} on {len(xform_info['channels'])} channels")
            if summary["transform"] is None:
                summary["transform"] = xform_info

        # Save preprocessed sample
        pickle_path = os.path.join(args.workdir, f"{name}_preprocessed.pickle")
        with open(pickle_path, "wb") as f:
            pickle.dump(sample, f)
        print(f"  Saved: {pickle_path}")

        summary["samples"].append({
            "name": name,
            "file": os.path.basename(fcs_path),
            "pickle": pickle_path,
            "compensated": compensated,
            "transformed": bool(xform_info),
        })

    # Write summary to run_data/
    run_data_dir = os.path.join(args.outdir, "run_data")
    os.makedirs(run_data_dir, exist_ok=True)
    summary_path = os.path.join(run_data_dir, "preprocess_summary.json")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)
    print(f"\nWrote {summary_path}")


if __name__ == "__main__":
    main()
