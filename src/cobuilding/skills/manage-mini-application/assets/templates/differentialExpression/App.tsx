import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  PlayIcon,
  UploadIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  AlertCircleIcon,
  CheckCircleIcon,
  LoaderIcon,
  XIcon,
} from "lucide-react";

declare const window: Window & {
  filesAPI: {
    selectFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
    readFile(path: string): Promise<{ type: string; content: string }>;
  };
  kernel: {
    connect(kernelName: string): Promise<unknown>;
    executeCode(code: string): Promise<{ output_type: string; ename?: string; evalue?: string; traceback?: string[] }[]>;
  };
  getWorkspacePath(): string;
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

interface RunMetadata {
  summary_stats: SummaryStats;
  data_files: DataFile[];
  visualizations: Visualization[];
}

type RunState = "idle" | "running" | "complete" | "error";
type DesignMode = "variable" | "formula";

export default function App() {
  // Input files
  const [countsFile, setCountsFile] = useState<string | null>(null);
  const [coldataFile, setColdataFile] = useState<string | null>(null);

  // Design
  const [designMode, setDesignMode] = useState<DesignMode>("variable");
  const [designVariable, setDesignVariable] = useState("");
  const [designFormula, setDesignFormula] = useState("");
  const [denominatorLevel, setDenominatorLevel] = useState("");
  const [numeratorLevel, setNumeratorLevel] = useState("");

  // Advanced params
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [minCount, setMinCount] = useState(10);
  const [minSamples, setMinSamples] = useState(3);
  const [alpha, setAlpha] = useState(0.05);
  const [lfcThreshold, setLfcThreshold] = useState(1.0);
  const [shrink, setShrink] = useState(false);
  const [orgdb, setOrgdb] = useState("org.Hs.eg.db");

  // Run state
  const [runState, setRunState] = useState<RunState>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [errorDetails, setErrorDetails] = useState("");
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const [metadata, setMetadata] = useState<RunMetadata | null>(null);
  const [runTimestamp, setRunTimestamp] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Visualization
  const [selectedVizIndex, setSelectedVizIndex] = useState(0);

  // Timer for elapsed time during run
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (runState === "running") {
      setElapsedSeconds(0);
      timerRef.current = setInterval(() => {
        setElapsedSeconds((s) => s + 1);
      }, 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [runState]);

  const workspacePath = window.getWorkspacePath();

  const toRelativePath = useCallback(
    (hostPath: string) => "./" + hostPath.slice(workspacePath.length + 1),
    [workspacePath]
  );

  const selectCountsFile = async () => {
    const path = await window.filesAPI.selectFile([{ name: "CSV", extensions: ["csv"] }]);
    if (path) setCountsFile(path);
  };

  const selectColdataFile = async () => {
    const path = await window.filesAPI.selectFile([{ name: "CSV", extensions: ["csv"] }]);
    if (path) setColdataFile(path);
  };

  const canRun =
    countsFile &&
    coldataFile &&
    (designMode === "variable" ? designVariable.trim() : designFormula.trim()) &&
    runState !== "running";

  const runAnalysis = async () => {
    if (!canRun || !countsFile || !coldataFile) return;

    setRunState("running");
    setErrorMessage("");
    setErrorDetails("");
    setMetadata(null);

    let wp = workspacePath;
    if (!wp) {
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 100));
        wp = window.getWorkspacePath();
        if (wp) break;
      }
    }
    if (!wp) {
      setRunState("error");
      setErrorMessage("Could not determine workspace path. Please try again.");
      return;
    }

    const appDir = `${wp}/.applications/differentialExpression`;

    try {
      // Connect to the R kernel
      await window.kernel.connect("ir");

      // Build params and inject into the kernel
      const params: Record<string, unknown> = {
        counts_file: toRelativePath(countsFile),
        coldata_file: toRelativePath(coldataFile),
        outdir: ".applications/differentialExpression/output",
        min_count: minCount,
        min_samples: minSamples,
        alpha: alpha,
        lfc_threshold: lfcThreshold,
        orgdb: orgdb,
        shrink: shrink,
      };

      if (designMode === "variable") {
        params.design_variable = designVariable.trim();
      } else {
        params.design_formula = designFormula.trim();
      }
      if (denominatorLevel.trim()) {
        params.denominator_level = denominatorLevel.trim();
      }
      if (numeratorLevel.trim()) {
        params.numerator_level = numeratorLevel.trim();
      }

      const paramsCode = `params_json <- '${JSON.stringify(params)}'`;
      let outputs = await window.kernel.executeCode(paramsCode);

      for (const o of outputs) {
        if (o.output_type === "error") {
          setRunState("error");
          setErrorMessage(`${o.ename}: ${o.evalue}`);
          setErrorDetails(o.traceback?.join("\n") || "");
          return;
        }
      }

      // Read the notebook and find the action cell
      const nbResult = await window.filesAPI.readFile(`${appDir}/notebook.ipynb`);
      if (nbResult.type !== "text") {
        setRunState("error");
        setErrorMessage("Failed to read notebook file.");
        return;
      }

      const notebook = JSON.parse(nbResult.content);
      const actionCell = notebook.cells.find((c: any) => c.id === "de-run");
      if (!actionCell) {
        setRunState("error");
        setErrorMessage("Action cell 'de-run' not found in notebook.");
        return;
      }

      const actionCode = Array.isArray(actionCell.source)
        ? actionCell.source.join("")
        : actionCell.source;

      // Execute the action cell
      outputs = await window.kernel.executeCode(actionCode);

      for (const o of outputs) {
        if (o.output_type === "error") {
          setRunState("error");
          setErrorMessage(`${o.ename}: ${o.evalue}`);
          setErrorDetails(o.traceback?.join("\n") || "");
          return;
        }
      }

      // Read results metadata
      const metadataPath = `${appDir}/output/run_metadata.json`;
      const fileContent = await window.filesAPI.readFile(metadataPath);
      if (fileContent.type === "text") {
        const meta: RunMetadata = JSON.parse(fileContent.content);
        // R's jsonlite unboxes single-element arrays to scalars
        if (!Array.isArray(meta.summary_stats.contrasts)) {
          meta.summary_stats.contrasts = [meta.summary_stats.contrasts as unknown as string];
        }
        setMetadata(meta);
        setRunTimestamp(Date.now());
        setSelectedVizIndex(0);
        setRunState("complete");
      } else {
        setRunState("error");
        setErrorMessage("Could not read results metadata file.");
      }
    } catch (err: any) {
      setRunState("error");
      setErrorMessage(err.message || "An unexpected error occurred.");
    }
  };

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
            <FilePickerRow
              label="Raw Counts CSV"
              value={countsFile}
              onPick={selectCountsFile}
              onClear={() => setCountsFile(null)}
            />
            <FilePickerRow
              label="Sample Annotation CSV"
              value={coldataFile}
              onPick={selectColdataFile}
              onClear={() => setColdataFile(null)}
            />
          </div>
        </div>

        {/* Design Configuration */}
        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
          <h2 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Design</h2>

          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={designMode === "variable"}
                onChange={() => setDesignMode("variable")}
                className="accent-blue-600"
              />
              <span className="text-sm text-gray-700">Single variable</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={designMode === "formula"}
                onChange={() => setDesignMode("formula")}
                className="accent-blue-600"
              />
              <span className="text-sm text-gray-700">Formula</span>
            </label>
          </div>

          {designMode === "variable" ? (
            <div>
              <label className="block text-sm text-gray-600 mb-1">Design variable (column in sample annotation)</label>
              <input
                type="text"
                value={designVariable}
                onChange={(e) => setDesignVariable(e.target.value)}
                placeholder="e.g. condition, group, treatment"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          ) : (
            <div>
              <label className="block text-sm text-gray-600 mb-1">Design formula</label>
              <input
                type="text"
                value={designFormula}
                onChange={(e) => setDesignFormula(e.target.value)}
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
                value={denominatorLevel}
                onChange={(e) => setDenominatorLevel(e.target.value)}
                placeholder="e.g. control"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Numerator level (optional)</label>
              <input
                type="text"
                value={numeratorLevel}
                onChange={(e) => setNumeratorLevel(e.target.value)}
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
              <NumberInput label="Min count" value={minCount} onChange={setMinCount} />
              <NumberInput label="Min samples" value={minSamples} onChange={setMinSamples} />
              <NumberInput label="Significance (alpha)" value={alpha} onChange={setAlpha} step={0.01} />
              <NumberInput label="LFC threshold" value={lfcThreshold} onChange={setLfcThreshold} step={0.1} />
              <div>
                <label className="block text-sm text-gray-600 mb-1">Organism</label>
                <select
                  value={orgdb}
                  onChange={(e) => setOrgdb(e.target.value)}
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
                    checked={shrink}
                    onChange={(e) => setShrink(e.target.checked)}
                    className="accent-blue-600"
                  />
                  <span className="text-sm text-gray-700">LFC shrinkage (apeglm)</span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Run Button */}
        <div className="flex items-center gap-4">
          <button
            onClick={runAnalysis}
            disabled={!canRun}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              canRun
                ? "bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800"
                : "bg-gray-200 text-gray-400 cursor-not-allowed"
            }`}
          >
            {runState === "running" ? (
              <>
                <LoaderIcon className="w-4 h-4 animate-spin" />
                Running... ({elapsedSeconds}s)
              </>
            ) : (
              <>
                <PlayIcon className="w-4 h-4" />
                Run Analysis
              </>
            )}
          </button>
          {runState === "running" && (
            <span className="text-sm text-gray-500">This may take a few minutes for large datasets</span>
          )}
        </div>

        {/* Error Display */}
        {runState === "error" && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <AlertCircleIcon className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-red-800">Analysis failed</p>
                <pre className="text-sm text-red-700 mt-1 whitespace-pre-wrap break-words">{errorMessage}</pre>
                {errorDetails && (
                  <>
                    <button
                      onClick={() => setShowErrorDetails(!showErrorDetails)}
                      className="text-sm text-red-600 underline mt-2"
                    >
                      {showErrorDetails ? "Hide details" : "Show full output"}
                    </button>
                    {showErrorDetails && (
                      <pre className="mt-2 text-xs text-red-600 bg-red-100 p-3 rounded overflow-auto max-h-64 whitespace-pre-wrap break-words">
                        {errorDetails}
                      </pre>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Results */}
        {runState === "complete" && metadata && (
          <div className="space-y-6">
            {/* Summary Stats */}
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <div className="flex items-center gap-2 mb-4">
                <CheckCircleIcon className="w-5 h-5 text-green-500" />
                <h2 className="text-sm font-medium text-gray-700 uppercase tracking-wide">Summary</h2>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard label="Genes (pre-filter)" value={metadata.summary_stats.n_genes_prefilter.toLocaleString()} />
                <StatCard label="Genes (post-filter)" value={metadata.summary_stats.n_genes_postfilter.toLocaleString()} />
                <StatCard label="Samples" value={metadata.summary_stats.n_samples.toLocaleString()} />
                <StatCard
                  label="Significant genes"
                  value={metadata.summary_stats.n_significant_genes.toLocaleString()}
                  highlight
                />
                <StatCard
                  label="Up-regulated"
                  value={metadata.summary_stats.n_up_regulated_genes.toLocaleString()}
                  color="text-red-600"
                />
                <StatCard
                  label="Down-regulated"
                  value={metadata.summary_stats.n_down_regulated_genes.toLocaleString()}
                  color="text-blue-600"
                />
                <StatCard label="LFC threshold" value={`|log2FC| > ${metadata.summary_stats.lfc_threshold}`} />
                <StatCard label="Significance" value={`padj < ${metadata.summary_stats.significance_threshold}`} />
              </div>
              {metadata.summary_stats.contrasts.length > 0 && (
                <div className="mt-3 text-sm text-gray-500">
                  Contrasts: {metadata.summary_stats.contrasts.join(", ")}
                </div>
              )}
            </div>

            {/* Visualizations */}
            {metadata.visualizations.length > 0 && (
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <h2 className="text-sm font-medium text-gray-700 uppercase tracking-wide mb-4">Visualizations</h2>
                <div className="flex gap-2 flex-wrap mb-4">
                  {metadata.visualizations.map((viz, i) => (
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
                    viz={metadata.visualizations[selectedVizIndex]}
                    workspacePath={workspacePath}
                    timestamp={runTimestamp}
                  />
                </div>
                <p className="text-sm text-gray-500 mt-2">
                  {metadata.visualizations[selectedVizIndex]?.description}
                </p>
              </div>
            )}

            {/* Data Files */}
            {metadata.data_files.length > 0 && (
              <div className="bg-white rounded-lg border border-gray-200 p-5">
                <h2 className="text-sm font-medium text-gray-700 uppercase tracking-wide mb-4">Output Files</h2>
                <div className="divide-y divide-gray-100">
                  {metadata.data_files.map((df, i) => (
                    <div key={i} className="py-2 flex items-baseline gap-3">
                      <span className="text-sm font-mono text-gray-800">{df.name}</span>
                      <span className="text-sm text-gray-500">{df.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FilePickerRow({
  label,
  value,
  onPick,
  onClear,
}: {
  label: string;
  value: string | null;
  onPick: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-gray-600 w-44 flex-shrink-0">{label}</span>
      {value ? (
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span className="text-sm text-gray-800 truncate" title={value}>
            {value.split("/").pop()}
          </span>
          <button onClick={onClear} className="text-gray-400 hover:text-gray-600">
            <XIcon className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <button
          onClick={onPick}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-blue-600 border border-blue-300 rounded-md hover:bg-blue-50 transition-colors"
        >
          <UploadIcon className="w-4 h-4" />
          Choose file
        </button>
      )}
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
  timestamp,
}: {
  viz: Visualization;
  workspacePath: string;
  timestamp: number;
}) {
  const imagePath = viz.image_file_path;
  // Resolve workspace-relative paths against the workspace root
  const hostImagePath = `${workspacePath}/${imagePath.replace(/^\.\//, "")}`;
  const src = `local-file://${hostImagePath}?t=${timestamp}`;

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
