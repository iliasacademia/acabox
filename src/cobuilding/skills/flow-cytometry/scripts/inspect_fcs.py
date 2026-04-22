#!/usr/bin/env python3
"""Inspect FCS files: channels, event counts, panel mapping, spillover detection."""

import argparse
import json
import os
import shutil
import sys

import flowkit as fk


def inspect_sample(fcs_path):
    """Inspect a single FCS file and return metadata dict."""
    sample = fk.Sample(fcs_path)
    basename = os.path.basename(fcs_path)

    # Channel info: PnN (short name) and PnS (stain/marker)
    channels = []
    pnn_labels = sample.pnn_labels  # channel names like FSC-A, FITC-A
    pns_labels = sample.pns_labels  # marker names like CD4, CD8 (may be empty)

    for i, pnn in enumerate(pnn_labels):
        marker = pns_labels[i] if i < len(pns_labels) else None
        if marker is not None and marker.strip() == "":
            marker = None
        channels.append({
            "channel": pnn,
            "marker": marker,
        })

    # Detect spillover matrix
    has_spillover = False
    try:
        spill = sample.get_metadata().get("spill", None)
        if spill is not None:
            has_spillover = True
    except Exception:
        pass
    # Also check common metadata keys
    if not has_spillover:
        for key in ["$SPILLOVER", "$COMP", "SPILL"]:
            try:
                val = sample.get_metadata().get(key, None)
                if val is not None:
                    has_spillover = True
                    break
            except Exception:
                pass

    # Basic metadata
    metadata = {}
    try:
        meta = sample.get_metadata()
        for key in ["$CYT", "$DATE", "$BTIM", "$ETIM", "$SRC", "$SYS"]:
            val = meta.get(key)
            if val is not None:
                metadata[key.lstrip("$").lower()] = str(val)
    except Exception:
        pass

    return {
        "file": basename,
        "path": fcs_path,
        "event_count": sample.event_count,
        "channels": channels,
        "has_spillover": has_spillover,
        "metadata": metadata,
    }


def build_panel(samples_info):
    """Build a panel mapping from channel names to markers across all samples.
    Uses the first non-null marker found for each channel."""
    panel = {}
    for sample in samples_info:
        for ch in sample["channels"]:
            name = ch["channel"]
            marker = ch["marker"]
            if name not in panel:
                panel[name] = marker
            elif panel[name] is None and marker is not None:
                panel[name] = marker
    return panel


def find_common_channels(samples_info):
    """Find channels present in all samples."""
    if not samples_info:
        return []
    channel_sets = []
    for s in samples_info:
        channel_sets.append(set(ch["channel"] for ch in s["channels"]))
    common = channel_sets[0]
    for cs in channel_sets[1:]:
        common = common & cs
    # Preserve order from first sample
    first_channels = [ch["channel"] for ch in samples_info[0]["channels"]]
    return [c for c in first_channels if c in common]


def write_summary_for_llm(results, outdir):
    """Write a human-readable markdown summary."""
    lines = ["# FCS File Inspection Summary\n"]

    lines.append(f"**Samples:** {len(results['samples'])}\n")

    for s in results["samples"]:
        lines.append(f"## {s['file']}")
        lines.append(f"- **Events:** {s['event_count']:,}")
        lines.append(f"- **Channels:** {len(s['channels'])}")
        lines.append(f"- **Spillover matrix embedded:** {'Yes' if s['has_spillover'] else 'No'}")
        if s["metadata"]:
            meta_str = ", ".join(f"{k}={v}" for k, v in s["metadata"].items())
            lines.append(f"- **Metadata:** {meta_str}")
        lines.append("")

    lines.append("## Channel / Marker Panel\n")
    lines.append("| Channel | Marker |")
    lines.append("|---------|--------|")
    for ch_name, marker in results["panel"].items():
        marker_str = marker if marker else "—"
        lines.append(f"| {ch_name} | {marker_str} |")
    lines.append("")

    # Flag channels missing markers
    missing = [ch for ch, m in results["panel"].items()
               if m is None and not ch.startswith("FSC") and not ch.startswith("SSC")
               and ch.lower() != "time"]
    if missing:
        lines.append("### Missing marker labels")
        lines.append("The following fluorescence channels have no marker annotation in the FCS file. "
                      "Ask the user what antibody/marker is in each:\n")
        for ch in missing:
            lines.append(f"- **{ch}**: ?")
        lines.append("")

    path = os.path.join(outdir, "summary_for_llm.md")
    with open(path, "w") as f:
        f.write("\n".join(lines))
    return path


def main():
    parser = argparse.ArgumentParser(description="Inspect FCS files")
    parser.add_argument("--fcs_files", nargs="+", required=True, help="Paths to .fcs files")
    parser.add_argument("--outdir", required=True, help="Output directory")
    args = parser.parse_args()

    os.makedirs(args.outdir, exist_ok=True)

    # Copy input FCS files into {outdir}/input/ so the output directory is self-contained
    input_dir = os.path.join(args.outdir, "input")
    os.makedirs(input_dir, exist_ok=True)

    samples_info = []
    for fcs_path in args.fcs_files:
        if not os.path.exists(fcs_path):
            print(f"ERROR: File not found: {fcs_path}", file=sys.stderr)
            sys.exit(1)
        dest = os.path.join(input_dir, os.path.basename(fcs_path))
        shutil.copy2(fcs_path, dest)
        print(f"Copied {fcs_path} → {dest}")
        # Inspect using the copied file so paths in output JSON point to the copy
        info = inspect_sample(dest)
        samples_info.append(info)

    panel = build_panel(samples_info)
    common_channels = find_common_channels(samples_info)

    results = {
        "samples": samples_info,
        "common_channels": common_channels,
        "panel": panel,
    }

    # Write JSON to run_data/
    run_data_dir = os.path.join(args.outdir, "run_data")
    os.makedirs(run_data_dir, exist_ok=True)
    json_path = os.path.join(run_data_dir, "inspect_results.json")
    with open(json_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"Wrote {json_path}")

    # Write LLM summary
    summary_path = write_summary_for_llm(results, args.outdir)
    print(f"Wrote {summary_path}")


if __name__ == "__main__":
    main()
