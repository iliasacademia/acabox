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

Each analysis run should use a unique output directory. Before starting, find the next available numbered directory by running:

```bash
ls -d flow_results*/ 2>/dev/null
```

**Important:** Do NOT use Glob to find directories — it only matches files. Use `ls -d` via Bash instead.

Pick the next number based on what exists:

```
flow_results1/   ← if this exists, use flow_results2/
flow_results2/   ← if this exists, use flow_results3/
flow_results3/   ← next run
```

Use `flow_results1/` for the first run. Never reuse an existing output directory. Pass this as `--outdir` to all scripts, and use `{outdir}/work` as `--workdir`. All JSON metadata files go in `{outdir}/run_data/`.

## Workflow

```
1. INSPECT      inspect_fcs.py      → learn channels, events, panel
2. PANEL MAP    (agent writes panel.json after confirming with user)
3. PREPROCESS   preprocess.py       → compensate + transform, save pickles
4. PLOT         plot_scatter.py     → scatter plots for chosen channel pairs
5a. AUTO-GATE   auto_gate.py        → propose parent gate (FSC-A / SSC-A)
5b. AUTO-GATE   auto_gate.py        → propose child gate (fluorescence channels, parent = gate from 5a)
6. APPLY GATES  apply_gates.py      → apply both gates, compute stats, gated plots
7. SUMMARIZE    summarize.py        → final population table and report
```

Every run must produce exactly **two gates**: a parent scatter gate and a child fluorescence gate. See Step 5 for details.

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
- `{outdir}/run_data/inspect_results.json` — channels, event counts, panel mapping, spillover info per sample. File paths point to the copies in `input/`.
- `{outdir}/summary_for_llm.md` — human-readable summary

After inspecting, read `run_data/inspect_results.json` to learn what channels exist and what marker labels the FCS file provides. If any fluorescence channels are missing marker labels, ask the user what antibody is in that channel. Then write a `panel.json` file mapping channel names to marker names.

## Step 2: Panel mapping (no script)

The agent reads `run_data/inspect_results.json`, identifies gaps in the channel-to-marker mapping, asks the user to fill them, and writes `panel.json` to `{outdir}/run_data/`:

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
  --inspect_file ./$OUTDIR/run_data/inspect_results.json \
  --workdir ./$OUTDIR/work \
  --outdir ./$OUTDIR \
  --compensation auto
```

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--inspect_file` | One of | — | Path to inspect_results.json (reads FCS paths from it — preferred) |
| `--fcs_files` | these | — | One or more .fcs file paths (fallback) |
| `--workdir` | Yes | — | Working directory for intermediate pickle files |
| `--outdir` | Yes | — | Output directory |
| `--compensation` | No | `auto` | `"auto"` to use embedded spillover matrix, or path to CSV |
| `--transform` | No | `logicle` | Transform type |

**Outputs:**
- `{workdir}/{sample}_preprocessed.pickle` — serialized FlowKit Sample objects
- `{outdir}/run_data/preprocess_summary.json` — transform parameters, per-sample status

## Step 4: Scatter plot

```bash
podman exec cobuilding-container python \
  .claude/skills/flow-cytometry/scripts/plot_scatter.py \
  --workdir ./$OUTDIR/work \
  --outdir ./$OUTDIR/plots \
  --x_channel FSC-A --y_channel SSC-A \
  --panel_file ./$OUTDIR/run_data/panel.json
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

## Step 5: Auto-gate (two gates per run)

`auto_gate.py` is currently a stub — it always places a rectangle in the center of the data range. **Do not attempt to improve the quality of the gate; accept the rectangles as-is.** The stub will be replaced by a smarter algorithm in the future.

The agent must run `auto_gate.py` **twice** to produce two gates:

### 5a. Parent gate (scatter channels)

Gate on FSC-A / SSC-A to define the main cell population.

```bash
podman exec cobuilding-container python \
  .claude/skills/flow-cytometry/scripts/auto_gate.py \
  --workdir ./$OUTDIR/work \
  --outdir ./$OUTDIR/run_data \
  --x_channel FSC-A --y_channel SSC-A \
  --gate_name Cells --label "Cells"
```

Read `run_data/gate_proposal.json`, then create `run_data/gates.json` containing this gate as the first entry.

### 5b. Child gate (fluorescence channels)

Gate on a fluorescence channel pair within the parent gate from 5a. Choose the two most relevant fluorescence channels from the panel (e.g., the first two markers).

```bash
podman exec cobuilding-container python \
  .claude/skills/flow-cytometry/scripts/auto_gate.py \
  --workdir ./$OUTDIR/work \
  --outdir ./$OUTDIR/run_data \
  --x_channel FITC-A --y_channel PE-A \
  --gate_name SubPop --label "Sub-population" \
  --parent_gate Cells
```

Read `run_data/gate_proposal.json` and **append** this gate to the existing `run_data/gates.json` so the file contains both gates.

### Arguments

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--workdir` | Yes | — | Where preprocessed pickles live |
| `--x_channel` | Yes | — | X-axis channel |
| `--y_channel` | Yes | — | Y-axis channel |
| `--gate_name` | Yes | — | Name for the gate |
| `--label` | No | same as gate_name | Biological label |
| `--parent_gate` | No | `root` | Parent gate name |
| `--outdir` | No | `{workdir}` | Where to write gate_proposal.json (use `{outdir}/run_data`) |

### Outputs

- `gate_proposal.json` — single gate definition (overwritten on each invocation)

After both invocations, `run_data/gates.json` should contain an array of two gates:

```json
[
  { "name": "Cells", "parent": "root", ... },
  { "name": "SubPop", "parent": "Cells", ... }
]
```

## Step 6: Apply gates

```bash
podman exec cobuilding-container python \
  .claude/skills/flow-cytometry/scripts/apply_gates.py \
  --workdir ./$OUTDIR/work \
  --outdir ./$OUTDIR \
  --gates_file ./$OUTDIR/run_data/gates.json \
  --panel_file ./$OUTDIR/run_data/panel.json \
  --inspect_file ./$OUTDIR/run_data/inspect_results.json
```

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--workdir` | Yes | — | Where preprocessed pickles live |
| `--outdir` | Yes | — | Output directory |
| `--gates_file` | Yes | — | JSON file with array of gate definitions |
| `--panel_file` | No | — | Path to panel.json for marker labels |
| `--inspect_file` | No | — | Path to inspect_results.json (needed for WSP export) |
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
- `{outdir}/run_data/gate_results.json` — structured results
- `analysis.wsp` — FlowJo-compatible workspace file (if `--inspect_file` provided)

## Step 7: Summarize

```bash
podman exec cobuilding-container python \
  .claude/skills/flow-cytometry/scripts/summarize.py \
  --outdir ./$OUTDIR \
  --gates_file ./$OUTDIR/run_data/gates.json \
  --inspect_file ./$OUTDIR/run_data/inspect_results.json \
  --panel_file ./$OUTDIR/run_data/panel.json
```

| Argument | Required | Default | Description |
|----------|----------|---------|-------------|
| `--outdir` | Yes | — | Where outputs live |
| `--gates_file` | Yes | — | Gates JSON |
| `--inspect_file` | Yes | — | inspect_results.json from step 1 |
| `--panel_file` | No | — | panel.json for marker names |

**Outputs:**
- `summary_for_llm.md` — markdown summary with population statistics table
- `{outdir}/run_data/summary.json` — structured summary
- `{outdir}/run_data/run_metadata.json` — full metadata with file registries
- `summary.png` — gate strategy view: first sample's full gate flow, then statistics, then per-gate sections showing all samples
- `summary_by_samples.png` — sample view: statistics first, then per-sample sections with all plots in gate order
