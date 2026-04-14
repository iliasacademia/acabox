import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CheckCircleIcon,
  LoaderIcon,
} from "lucide-react";
import { VolcanoPlot, type VolcanoGene } from "@reusable/VolcanoPlot";
import { MAPlot } from "@reusable/MAPlot";
import { parseCsvLine } from "@reusable/csv-utils";
import { OutputFileList, type OutputFile } from "@reusable/OutputFileList";
import { useAppState } from "@reusable/useAppState";
import { useKernelAction } from "@reusable/useKernelAction";
import { readJsonOutput } from "@reusable/readJsonOutput";
import { FileSlotPicker } from "@reusable/FileSlotPicker";
import { RunButton } from "@reusable/RunButton";
import { RunStateBadge } from "@reusable/RunStateBadge";

declare const window: Window & {
  filesAPI: {
    readFile(path: string): Promise<{ type: string; content: string } | { error: string }>;
  };
  getWorkspacePath(): string;
};

const DIR_NAME = "differentialExpression";
const OUTPUT_DIR = `.applications/${DIR_NAME}/output`;
const CSV_FILTER = [{ name: "CSV", extensions: ["csv"] }];

interface DEParams {
  counts_file: string;
  coldata_file: string;
  design_mode: "variable" | "formula";
  design_variable: string;
  design_formula: string;
  denominator_level: string;
  numerator_level: string;
  min_count: number;
  min_samples: number;
  alpha: number;
  lfc_threshold: number;
  shrink: boolean;
  orgdb: string;
}

const DEFAULTS: DEParams = {
  counts_file: "",
  coldata_file: "",
  design_mode: "variable",
  design_variable: "",
  design_formula: "",
  denominator_level: "",
  numerator_level: "",
  min_count: 10,
  min_samples: 3,
  alpha: 0.05,
  lfc_threshold: 1.0,
  shrink: false,
  orgdb: "org.Hs.eg.db",
};

interface SummaryStats {
  n_genes_prefilter: number;
  n_genes_postfilter: number;
  n_samples: number;
  n_samples_numerator: number;
  n_samples_denominator: number;
  n_significant_genes: number;
  n_up_regulated_genes: number;
  n_down_regulated_genes: number;
  contrasts: string[];
  lfc_threshold: number;
  significance_threshold: number;
  date: string;
}

interface Visualization {
  name: string;
  description: string;
  visualization_type: string;
  image_file_path: string;
  data_file_path: string;
}

interface DataFile {
  name: string;
  description: string;
  file_path: string;
  artifact_type: string;
}

// Shape of the file the R script writes to output/run_metadata.json — only
// describes the on-disk handoff. After a run we read this once, split into
// the hook's `outputs` and `runResult`, and never read it again.
interface RunMetadataFile {
  summary_stats: SummaryStats;
  data_files: DataFile[];
  visualizations: Visualization[];
}

// What we persist via the hook's `runResult` slot. Excludes `data_files`
// because those are persisted separately as `outputs`.
interface DERunResult {
  summary_stats: SummaryStats;
  visualizations: Visualization[];
}

function parseVolcanoCsv(csvText: string): VolcanoGene[] {
  const lines = csvText.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  const idx = (name: string) => headers.indexOf(name);
  const iSymbol = idx("SYMBOL"), iGeneName = idx("GENENAME");
  const iLog2FC = idx("log2FoldChange"), iPadj = idx("padj");
  const iNeglog10p = idx("neglog10p"), iBaseMean = idx("baseMean");
  const iEnsemblId = idx("ensembl_id");

  const genes: VolcanoGene[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const padj = parseFloat(cols[iPadj]);
    if (Number.isNaN(padj)) continue;
    const rawNeglog10p = iNeglog10p >= 0 ? parseFloat(cols[iNeglog10p]) : NaN;
    const neglog10p = Number.isFinite(rawNeglog10p) ? rawNeglog10p : (padj > 0 ? -Math.log10(padj) : 300);
    genes.push({
      ensembl_id: cols[iEnsemblId] ?? "",
      symbol: cols[iSymbol] === "NA" ? "" : (cols[iSymbol] ?? ""),
      geneName: cols[iGeneName] === "NA" ? "" : (cols[iGeneName] ?? ""),
      log2FoldChange: parseFloat(cols[iLog2FC]),
      padj,
      neglog10p,
      baseMean: parseFloat(cols[iBaseMean]),
    });
  }
  return genes;
}

async function readPlotCsv(name: string): Promise<VolcanoGene[] | null> {
  const result = await window.filesAPI.readFile(`${OUTPUT_DIR}/${name}`);
  if (!("type" in result) || result.type !== "text") return null;
  return parseVolcanoCsv(result.content);
}

export default function App() {
  // Persistent state — survives remounts via the notebook.
  const state = useAppState<DEParams, OutputFile, DERunResult>({
    dirName: DIR_NAME,
    defaults: DEFAULTS,
    inputSlots: ["counts_file", "coldata_file"],
  });
  const {
    loading,
    params,
    setParams,
    outputs,
    setOutputs,
    runResult,
    setRunResult,
    freshness,
    markRunComplete,
  } = state;

  // Kernel runner — handles connect, params injection, action-cell lookup,
  // execution, error dispatch (errors land in the global ErrorDisplay).
  const action = useKernelAction({
    dirName: DIR_NAME,
    kernel: "ir",
    buildKernelParams: () => {
      const kp: Record<string, unknown> = {
        counts_file: params.counts_file,
        coldata_file: params.coldata_file,
        outdir: OUTPUT_DIR,
        min_count: params.min_count,
        min_samples: params.min_samples,
        alpha: params.alpha,
        lfc_threshold: params.lfc_threshold,
        orgdb: params.orgdb,
        shrink: params.shrink,
      };
      if (params.design_mode === "variable") {
        kp.design_variable = params.design_variable.trim();
      } else {
        kp.design_formula = params.design_formula.trim();
      }
      if (params.denominator_level.trim()) kp.denominator_level = params.denominator_level.trim();
      if (params.numerator_level.trim()) kp.numerator_level = params.numerator_level.trim();
      return kp;
    },
  });

  // Transient UI state (not persisted — these don't need to survive remounts).
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Per-row plot data — too large for notebook metadata. Re-read from
  // output/*.csv on mount when a previous run exists.
  const [volcanoData, setVolcanoData] = useState<VolcanoGene[] | null>(null);
  const [maData, setMaData] = useState<VolcanoGene[] | null>(null);
  const [vizLfc, setVizLfc] = useState(DEFAULTS.lfc_threshold);
  const [vizAlpha, setVizAlpha] = useState(DEFAULTS.alpha);
  const [selectedVizIndex, setSelectedVizIndex] = useState(0);

  const initialPlotLoadAttempted = useRef(false);

  // On mount, if a previous run exists, re-load the per-row plot data so
  // the interactive plots render. Summary stats / viz / file list are
  // already hydrated by `useAppState` from notebook metadata.
  useEffect(() => {
    if (loading) return;
    if (initialPlotLoadAttempted.current) return;
    initialPlotLoadAttempted.current = true;
    if (freshness === "never" || !runResult) return;

    setVizLfc(params.lfc_threshold);
    setVizAlpha(params.alpha);

    (async () => {
      const [v, m] = await Promise.all([
        readPlotCsv("volcano_plot.csv"),
        readPlotCsv("MA_plot.csv"),
      ]);
      if (v) setVolcanoData(v);
      if (m) setMaData(m);
    })();
  }, [loading, freshness, runResult, params.alpha, params.lfc_threshold]);

  const canRun =
    !loading &&
    !!params.counts_file &&
    !!params.coldata_file &&
    !!(params.design_mode === "variable" ? params.design_variable.trim() : params.design_formula.trim());

  const interactiveSummary = useMemo(() => {
    if (!volcanoData) return null;
    let up = 0, down = 0, ns = 0;
    for (const g of volcanoData) {
      if (g.padj >= vizAlpha || Number.isNaN(g.padj)) ns++;
      else if (g.log2FoldChange >= vizLfc) up++;
      else if (g.log2FoldChange <= -vizLfc) down++;
      else ns++;
    }
    return { up, down, ns };
  }, [volcanoData, vizLfc, vizAlpha]);

  const staticVisualizations = useMemo(() => {
    if (!runResult) return [];
    return runResult.visualizations.filter(
      (v) => v.name !== "volcano_plot" && v.name !== "MA_plot"
    );
  }, [runResult]);

  const handleRun = async () => {
    if (!canRun) return;
    setRunResult(null);
    setOutputs([]);
    setVolcanoData(null);
    setMaData(null);

    const result = await action.run();
    if (!result.ok) return; // error already surfaced via ErrorDisplay

    // Read run_metadata.json ONCE as the data handoff from R, then split
    // its contents into the hook's standard slots. The persisted hook
    // state is the source of truth from this point on.
    const meta = await readJsonOutput<RunMetadataFile>(`${OUTPUT_DIR}/run_metadata.json`);
    if (meta) {
      if (!Array.isArray(meta.summary_stats.contrasts)) {
        meta.summary_stats.contrasts = [meta.summary_stats.contrasts as unknown as string];
      }
      setRunResult({
        summary_stats: meta.summary_stats,
        visualizations: meta.visualizations,
      });
      setOutputs(
        meta.data_files.map((df): OutputFile => ({
          name: df.name,
          description: df.description,
          path: df.file_path,
        })),
      );
      setSelectedVizIndex(0);
    }

    const [v, m] = await Promise.all([
      readPlotCsv("volcano_plot.csv"),
      readPlotCsv("MA_plot.csv"),
    ]);
    if (v) setVolcanoData(v);
    if (m) setMaData(m);

    setVizLfc(params.lfc_threshold);
    setVizAlpha(params.alpha);

    await markRunComplete();
  };

  const hasInteractivePlots = volcanoData !== null || maData !== null;
  const workspacePath = window.getWorkspacePath();

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <LoaderIcon className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Differential Expression Analysis</h1>
          <p className="text-sm text-gray-500 mt-1">DESeq2-based analysis of RNA-seq count data</p>
        </div>

        {/* Input Files */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
          <h2 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Input Files</h2>
          <div className="grid grid-cols-1 gap-3">
            <FileSlotPicker state={state} slot="counts_file" label="Raw Counts CSV" filters={CSV_FILTER} />
            <FileSlotPicker state={state} slot="coldata_file" label="Sample Annotation CSV" filters={CSV_FILTER} />
          </div>
        </div>

        {/* Design Configuration */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
          <h2 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Design</h2>

          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={params.design_mode === "variable"}
                onChange={() => setParams({ design_mode: "variable" })}
                className="accent-blue-600"
              />
              <span className="text-sm text-gray-700">Single variable</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={params.design_mode === "formula"}
                onChange={() => setParams({ design_mode: "formula" })}
                className="accent-blue-600"
              />
              <span className="text-sm text-gray-700">Formula</span>
            </label>
          </div>

          {params.design_mode === "variable" ? (
            <div>
              <label className="block text-sm text-gray-600 mb-1">Design variable (column in sample annotation)</label>
              <input
                type="text"
                value={params.design_variable}
                onChange={(e) => setParams({ design_variable: e.target.value })}
                placeholder="e.g. condition, group, treatment"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          ) : (
            <div>
              <label className="block text-sm text-gray-600 mb-1">Design formula</label>
              <input
                type="text"
                value={params.design_formula}
                onChange={(e) => setParams({ design_formula: e.target.value })}
                placeholder="e.g. ~ condition + batch"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Reference level (optional)</label>
              <input
                type="text"
                value={params.denominator_level}
                onChange={(e) => setParams({ denominator_level: e.target.value })}
                placeholder="e.g. control"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Numerator level (optional)</label>
              <input
                type="text"
                value={params.numerator_level}
                onChange={(e) => setParams({ numerator_level: e.target.value })}
                placeholder="e.g. treated"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>
        </div>

        {/* Advanced Parameters */}
        <div className="bg-white rounded-lg border border-gray-200">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="w-full flex items-center gap-2 p-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            {showAdvanced ? (
              <ChevronDownIcon className="w-4 h-4" />
            ) : (
              <ChevronRightIcon className="w-4 h-4" />
            )}
            Advanced Parameters
          </button>
          {showAdvanced && (
            <div className="px-5 pb-5 pt-0 grid grid-cols-2 md:grid-cols-3 gap-4">
              <NumberInput label="Min count" value={params.min_count} onChange={(v) => setParams({ min_count: v })} />
              <NumberInput label="Min samples" value={params.min_samples} onChange={(v) => setParams({ min_samples: v })} />
              <NumberInput label="Significance (alpha)" value={params.alpha} onChange={(v) => setParams({ alpha: v })} step={0.01} />
              <NumberInput label="LFC threshold" value={params.lfc_threshold} onChange={(v) => setParams({ lfc_threshold: v })} step={0.1} />
              <div>
                <label className="block text-sm text-gray-600 mb-1">Organism</label>
                <select
                  value={params.orgdb}
                  onChange={(e) => setParams({ orgdb: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="org.Hs.eg.db">Human (org.Hs.eg.db)</option>
                  <option value="org.Mm.eg.db">Mouse (org.Mm.eg.db)</option>
                </select>
              </div>
              <div className="flex items-end pb-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={params.shrink}
                    onChange={(e) => setParams({ shrink: e.target.checked })}
                    className="accent-blue-600"
                  />
                  <span className="text-sm text-gray-700">LFC shrinkage (apeglm)</span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Run Button + freshness badge */}
        <div className="flex items-center gap-4 flex-wrap">
          <RunButton action={action} onRun={handleRun} disabled={!canRun}>
            Run Analysis
          </RunButton>
          {action.phase === "running" && (
            <span className="text-sm text-gray-500">This may take a few minutes for large datasets</span>
          )}
          {runResult && <RunStateBadge freshness={freshness} />}
        </div>

        {/* Results — show whenever a run has been completed (live this
            session OR hydrated from a previous session via the hook). */}
        {runResult && (
          <div className="space-y-6">
            {/* Summary Stats */}
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <div className="flex items-center gap-2 mb-4">
                <CheckCircleIcon className="w-5 h-5 text-green-500" />
                <h2 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Summary</h2>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="Genes (pre-filter)" value={runResult.summary_stats.n_genes_prefilter.toLocaleString()} />
                <StatCard label="Genes (post-filter)" value={runResult.summary_stats.n_genes_postfilter.toLocaleString()} />
                <StatCard label="Samples" value={runResult.summary_stats.n_samples.toLocaleString()} />
                <StatCard
                  label="Significant genes"
                  value={runResult.summary_stats.n_significant_genes.toLocaleString()}
                  highlight
                />
                <StatCard
                  label="Up-regulated"
                  value={runResult.summary_stats.n_up_regulated_genes.toLocaleString()}
                  color="text-red-600"
                />
                <StatCard
                  label="Down-regulated"
                  value={runResult.summary_stats.n_down_regulated_genes.toLocaleString()}
                  color="text-blue-600"
                />
                <StatCard label="LFC threshold" value={`|log2FC| > ${runResult.summary_stats.lfc_threshold}`} />
                <StatCard label="Significance" value={`padj < ${runResult.summary_stats.significance_threshold}`} />
              </div>
              {runResult.summary_stats.contrasts.length > 0 && (
                <div className="mt-3 text-sm text-gray-500">
                  Contrasts: {runResult.summary_stats.contrasts.join(", ")}
                </div>
              )}
            </div>

            {/* Interactive Plots */}
            {hasInteractivePlots && (
              <div className="space-y-4">
                {/* Threshold Controls */}
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="flex flex-wrap items-end gap-6">
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">log2FC threshold</label>
                      <input
                        type="number"
                        min={0}
                        step={0.1}
                        className="w-24 px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        value={vizLfc}
                        onChange={(e) => setVizLfc(parseFloat(e.target.value))}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-500 mb-1">Significance (alpha)</label>
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.01}
                        className="w-24 px-3 py-1.5 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        value={vizAlpha}
                        onChange={(e) => setVizAlpha(parseFloat(e.target.value))}
                      />
                    </div>
                    {interactiveSummary && (
                      <div className="flex flex-wrap gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-md bg-red-100 px-2.5 py-1 text-xs font-medium text-red-700">
                          {interactiveSummary.up.toLocaleString()} upregulated
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-md bg-blue-100 px-2.5 py-1 text-xs font-medium text-blue-700">
                          {interactiveSummary.down.toLocaleString()} downregulated
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-md bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-500">
                          {interactiveSummary.ns.toLocaleString()} not significant
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Plot Grid */}
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {volcanoData && (
                    <div className="bg-white rounded-lg border border-gray-200 p-4">
                      <h3 className="text-sm font-semibold text-gray-700 mb-2">Volcano Plot</h3>
                      <VolcanoPlot data={volcanoData} lfcThreshold={vizLfc} alpha={vizAlpha} />
                    </div>
                  )}
                  {maData && (
                    <div className="bg-white rounded-lg border border-gray-200 p-4">
                      <h3 className="text-sm font-semibold text-gray-700 mb-2">MA Plot</h3>
                      <MAPlot data={maData} lfcThreshold={vizLfc} alpha={vizAlpha} />
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Other Visualizations (static images) */}
            {staticVisualizations.length > 0 && (
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <h2 className="text-sm font-medium text-gray-700 uppercase tracking-wide mb-4">Other Visualizations</h2>
                <div className="flex gap-2 flex-wrap mb-4">
                  {staticVisualizations.map((viz, i) => (
                    <button
                      key={i}
                      onClick={() => setSelectedVizIndex(i)}
                      className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                        selectedVizIndex === i
                          ? "bg-blue-600 text-white"
                          : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                      }`}
                    >
                      {viz.name}
                    </button>
                  ))}
                </div>
                <div className="border border-gray-100 rounded-lg overflow-hidden bg-white">
                  <VizImage
                    viz={staticVisualizations[selectedVizIndex]}
                    workspacePath={workspacePath}
                  />
                </div>
                <p className="text-sm text-gray-500 mt-2">
                  {staticVisualizations[selectedVizIndex]?.description}
                </p>
              </div>
            )}

            {/* Output Files — driven by the hook's persisted `outputs`. */}
            {outputs.length > 0 && (
              <OutputFileList outputDir={OUTPUT_DIR} files={outputs} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <div>
      <label className="block text-sm text-gray-600 mb-1">{label}</label>
      <input
        type="number"
        value={value}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  highlight,
  color,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  color?: string;
}) {
  return (
    <div className={`p-3 rounded-lg ${highlight ? "bg-blue-50" : "bg-gray-50"}`}>
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-lg font-semibold ${color || (highlight ? "text-blue-700" : "text-gray-900")}`}>
        {value}
      </div>
    </div>
  );
}

function VizImage({
  viz,
  workspacePath,
}: {
  viz: Visualization;
  workspacePath: string;
}) {
  const imageFileName = viz.image_file_path.split("/").pop() || viz.image_file_path;
  const src = `local-file://${workspacePath}/${OUTPUT_DIR}/${imageFileName}`;

  return (
    <img
      src={src}
      alt={viz.name}
      className="w-full h-auto"
      onError={(e) => {
        (e.target as HTMLImageElement).alt = `Failed to load: ${viz.name}`;
      }}
    />
  );
}
