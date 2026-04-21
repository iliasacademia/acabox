---
name: flow-cytometry
description: >
  Run flow cytometry analysis using FlowKit on FCS files. Use when the user
  asks about flow cytometry, FACS analysis, cell gating, FCS files, or
  population analysis. Provides scripts for inspecting FCS files, preprocessing
  (compensation + transformation), generating scatter plots, proposing gates,
  applying gating strategies, and producing population statistics. The agent
  calls scripts in sequence, reading outputs between steps to guide the
  analysis iteratively.
---

# Flow Cytometry Analysis (FlowKit)

This skill provides Python scripts for flow cytometry analysis using FlowKit. The agent calls scripts in sequence, reading outputs between steps to decide the next action.

## Output directory

Each analysis run should use a unique output directory. Before starting, find the next available numbered directory:

```
flow_results/    ← if this exists, use flow_results2/
flow_results2/   ← if this exists, use flow_results3/
flow_results3/   ← next run
```

Check which `flow_results*` directories already exist and pick the next number. Use `flow_results/` (no number) for the first run. Pass this as `--outdir` to all scripts, and use `{outdir}/work` as `--workdir`.

## Workflow

```
1. INSPECT      inspect_fcs.py      → learn channels, events, panel
2. PANEL MAP    (agent writes panel.json after confirming with user)
3. PREPROCESS   preprocess.py       → compensate + transform, save pickles
4. PLOT         plot_scatter.py     → scatter plots for chosen channel pairs
5. AUTO-GATE    auto_gate.py        → propose a gate (stub: rectangle in data range)
6. APPLY GATES  apply_gates.py      → apply gates, compute stats, gated plots
7. (repeat 4-6 for deeper gating)
8. SUMMARIZE    summarize.py        → final population table and report
```

## Step 1: Inspect FCS files

```bash
podman exec cobuilding-container python \
  .claude/skills/flow-cytometry/scripts/inspect_fcs.py \
  --fcs_files ./data/sample1.fcs ./data/sample2.fcs \
  --outdir ./$OUTDIR
```

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--fcs_files` | Yes | — | One or more paths to .fcs files |
| `--outdir` | Yes | — | Output directory |

**Outputs:**
- `{outdir}/input/` — copies of all input FCS files (makes the output directory self-contained)
- `inspect_results.json` — channels, event counts, panel mapping, spillover info per sample. File paths point to the copies in `input/`.
- `summary_for_llm.md` — human-readable summary

After inspecting, read `inspect_results.json` to learn what channels exist and what marker labels the FCS file provides. If any fluorescence channels are missing marker labels, ask the user what antibody is in that channel. Then write a `panel.json` file mapping channel names to marker names.

## Step 2: Panel mapping (no script)

The agent reads `inspect_results.json`, identifies gaps in the channel-to-marker mapping, asks the user to fill them, and writes `panel.json` to the working directory:

```json
{
  "FSC-A": null,
  "SSC-A": null,
  "FITC-A": "CD4",
  "PE-A": "CD8",
  "APC-A": "CD3"
}
```

Scatter/forward scatter channels (FSC-*, SSC-*) should be `null`. All subsequent scripts accept `--panel_file` and use marker names for axis labels when provided.

## Step 3: Preprocess

```bash
podman exec cobuilding-container python \
  .claude/skills/flow-cytometry/scripts/preprocess.py \
  --inspect_file ./$OUTDIR/inspect_results.json \
  --workdir ./$OUTDIR/work \
  --outdir ./$OUTDIR \
  --compensation auto
```

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--inspect_file` | One of | — | Path to inspect_results.json (reads FCS paths from it — preferred) |
| `--fcs_files` | these | — | One or more .fcs file paths (fallback) |
| `--workdir` | Yes | — | Working directory for intermediate pickle files |
| `--outdir` | Yes | — | Output directory for QC plots |
| `--compensation` | No | `auto` | `"auto"` to use embedded spillover matrix, or path to CSV |
| `--transform` | No | `logicle` | Transform type |

**Outputs:**
- `{workdir}/{sample}_preprocessed.pickle` — serialized FlowKit Sample objects
- `{outdir}/compensation_qc/` — before/after scatter plots (PNG)
- `{outdir}/preprocess_summary.json` — transform parameters, per-sample status

## Step 4: Scatter plot

```bash
podman exec cobuilding-container python \
  .claude/skills/flow-cytometry/scripts/plot_scatter.py \
  --workdir ./$OUTDIR/work \
  --outdir ./$OUTDIR/plots \
  --x_channel FSC-A --y_channel SSC-A \
  --panel_file ./$OUTDIR/work/panel.json
```

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--workdir` | Yes | — | Where preprocessed pickles live |
| `--outdir` | Yes | — | Output directory for plot PNGs |
| `--x_channel` | Yes | — | X-axis channel name |
| `--y_channel` | Yes | — | Y-axis channel name |
| `--panel_file` | No | — | Path to panel.json for marker-labeled axes |
| `--samples` | No | all | Which samples to plot |
| `--parent_gate` | No | `root` | Gate name to subset events |
| `--gates_file` | No | — | Path to gates JSON to overlay outlines |
| `--subsample` | No | 15000 | Max events to plot per sample |

**Outputs:**
- `{outdir}/{x}_{y}_{gate}_{sample}.png` — one scatter plot per sample
- `{outdir}/plot_metadata.json` — axis ranges, event counts, file paths

## Step 5: Auto-gate (stub)

```bash
podman exec cobuilding-container python \
  .claude/skills/flow-cytometry/scripts/auto_gate.py \
  --workdir ./$OUTDIR/work \
  --x_channel FSC-A --y_channel SSC-A \
  --gate_name StubGate --label "Stub Gate"
```

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--workdir` | Yes | — | Where preprocessed pickles live |
| `--x_channel` | Yes | — | X-axis channel |
| `--y_channel` | Yes | — | Y-axis channel |
| `--gate_name` | Yes | — | Name for the gate |
| `--label` | No | same as gate_name | Biological label |
| `--parent_gate` | No | `root` | Parent gate name |
| `--outdir` | No | `{workdir}` | Where to write gate_proposal.json |

**Outputs:**
- `gate_proposal.json` — gate definition with bounds in data coordinates

This is a stub that returns a rectangle centered in the data range. The agent should read the proposal and append it to `gates.json`.

## Step 6: Apply gates

```bash
podman exec cobuilding-container python \
  .claude/skills/flow-cytometry/scripts/apply_gates.py \
  --workdir ./$OUTDIR/work \
  --outdir ./$OUTDIR \
  --gates_file ./$OUTDIR/work/gates.json \
  --panel_file ./$OUTDIR/work/panel.json
```

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--workdir` | Yes | — | Where preprocessed pickles live |
| `--outdir` | Yes | — | Output directory |
| `--gates_file` | Yes | — | JSON file with array of gate definitions |
| `--panel_file` | No | — | Path to panel.json for marker labels |
| `--samples` | No | all | Which samples |

**Gates file format:**
```json
[
  {
    "name": "StubGate", "type": "rectangle",
    "x_channel": "FSC-A", "y_channel": "SSC-A",
    "parent": "root", "label": "Stub Gate",
    "bounds": {"x_min": 50000, "x_max": 180000, "y_min": 20000, "y_max": 140000}
  }
]
```

**Outputs:**
- `gate_statistics.csv` — event counts and percentages per sample per gate
- `{outdir}/gated_plots/` — scatter plots with gate outlines (PNG)
- `gate_results.json` — structured results

## Step 7: Summarize

```bash
podman exec cobuilding-container python \
  .claude/skills/flow-cytometry/scripts/summarize.py \
  --outdir ./$OUTDIR \
  --gates_file ./$OUTDIR/work/gates.json \
  --inspect_file ./$OUTDIR/inspect_results.json \
  --panel_file ./$OUTDIR/work/panel.json
```

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--outdir` | Yes | — | Where outputs live |
| `--gates_file` | Yes | — | Gates JSON |
| `--inspect_file` | Yes | — | inspect_results.json from step 1 |
| `--panel_file` | No | — | panel.json for marker names |

**Outputs:**
- `summary_for_llm.md` — markdown summary with population statistics table
- `summary.json` — structured summary
- `run_metadata.json` — full metadata with file registries
- `output_summary.png` — single canvas image containing all plots from the analysis with labels, plus key statistics at the top
