import React, { useState, useEffect, useCallback } from "react";
import { useAppState } from "@reusable/useAppState";
import { useKernelAction } from "@reusable/useKernelAction";
import { FileSlotPicker } from "@reusable/FileSlotPicker";
import { OutputFileList, type OutputFile } from "@reusable/OutputFileList";
import { RunButton } from "@reusable/RunButton";
import { readJsonOutput } from "@reusable/readJsonOutput";
import {
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Image as ImageIcon,
  ArrowRight,
  ArrowLeft,
  Loader2,
  RotateCcw,
  X,
  Eye,
  EyeOff,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Params {
  input_image: string;
  font_size: number;
}

interface Band {
  yCenter: number;
  yMin: number;
  yMax: number;
  componentCount: number;
}

interface AnalyzedMembrane {
  yStart: number;
  yEnd: number;
  contentXMin: number;
  contentXMax: number;
  laneXPositions: number[];
  laneCount: number;
  bands: Band[];
}

interface AnalysisResult {
  imageWidth: number;
  imageHeight: number;
  inverted: boolean;
  mask_path: string;
  visualization_path: string;
  membranes: AnalyzedMembrane[];
}

// User-editable config per membrane
interface MembraneConfig {
  antibodyLabels: string[];      // one per band row (only for enabled bands)
  laneLabels: string[];          // one per lane
  enabledBands: boolean[];       // toggle bands on/off
  enabledLanes: boolean[];       // toggle lanes on/off
  laneNudges: number[];          // px offset per lane
  bandNudges: number[];          // px offset per band (vertical)
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DIR_NAME = "westernBlotAnnotator";
const DEFAULTS: Params = { input_image: "", font_size: 14 };

// ─── Image helpers ───────────────────────────────────────────────────────────

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load: ${src}`));
    img.src = src;
  });
}

// ─── LLM helper ──────────────────────────────────────────────────────────────

async function llmWithImage(canvas: HTMLCanvasElement, prompt: string): Promise<string> {
  const dataUrl = canvas.toDataURL("image/png");
  const base64 = dataUrl.split(",")[1];
  const response = await window.anthropicAPI.complete({
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } },
        { type: "text", text: prompt },
      ],
    }],
    system: "You are an expert western blot analyst. Respond with ONLY valid JSON, no markdown fences, no explanation.",
    model: "claude-opus-4-20250514",
    max_tokens: 1024,
  });
  return response.content[0].text.trim();
}

function parseJSON(text: string): any {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error("No JSON found in: " + text);
}

interface LLMFilterResult {
  bandFilters: boolean[][];
  ladderLaneIndices: number[][]; // per membrane, which lane indices are ladder
}

/** Ask LLM to filter GelGenie band rows and identify ladder lanes */
async function filterBandsLLM(
  visCanvas: HTMLCanvasElement,
  membranes: AnalyzedMembrane[],
): Promise<LLMFilterResult> {
  const memInfo = membranes.map((m, mi) => {
    const bandList = m.bands
      .map((b, bi) => `Band ${bi + 1}: yCenter=${b.yCenter}, yMin=${b.yMin}, yMax=${b.yMax}, components=${b.componentCount}`)
      .join("\n    ");
    const laneList = m.laneXPositions
      .map((x, li) => `Lane ${li + 1}: x=${x}`)
      .join(", ");
    return `Membrane ${mi + 1} (y: ${m.yStart}-${m.yEnd}): ${m.bands.length} band rows, ${m.laneCount} lanes\n    Bands: ${bandList}\n    Lanes: ${laneList}`;
  }).join("\n  ");

  const text = await llmWithImage(
    visCanvas,
    `This is a western blot image with GelGenie detection overlays:
- Red boxes: detected band components
- Yellow horizontal lines: band row centers
- Cyan vertical lines: lane positions

The detection found:
  ${memInfo}

For a publication-ready western blot figure:
1. BAND ROWS: We typically want 1-3 distinct antibody bands per membrane. Exclude:
   - Protein ladder bands (leftmost column with many evenly-spaced bands)
   - Noise or artifacts
   Keep only real antibody signal bands visible across sample lanes.

2. LADDER LANES: Identify which lane(s) contain the protein ladder/marker. These are typically the leftmost or rightmost lane with many evenly-spaced bands. Always exclude ladder lanes from the figure.

Respond with JSON:
{"membranes": [{"keepBands": [true, false, ...], "ladderLanes": [0]}, ...]}
- keepBands: same order as band rows listed above (true=keep, false=exclude)
- ladderLanes: array of 0-based lane indices that are ladder/marker lanes (can be empty if no ladder detected)`,
  );
  const parsed = parseJSON(text);
  const mems = parsed.membranes || [];
  return {
    bandFilters: mems.map((m: any) => m.keepBands || []),
    ladderLaneIndices: mems.map((m: any) => m.ladderLanes || []),
  };
}

// ─── Pixel helpers ───────────────────────────────────────────────────────────

/** Compute strip crop regions from GelGenie band boundaries with padding.
 *  All strips are made equal height for visual consistency. */
function computeStripCrops(
  memHeight: number,
  memYStart: number,
  bands: Band[],
  enabledBands: boolean[],
  bandNudges: number[],
): { yStart: number; yEnd: number }[] {
  const active: { band: Band; nudge: number }[] = [];
  bands.forEach((b, i) => { if (enabledBands[i]) active.push({ band: b, nudge: bandNudges[i] || 0 }); });
  if (active.length === 0) return [];

  // Find the tallest band, add padding, use as uniform strip height
  const PADDING = 15;
  const maxBandH = Math.max(...active.map(({ band }) => band.yMax - band.yMin));
  const stripH = maxBandH + PADDING * 2;

  return active.map(({ band, nudge }) => {
    // Center the strip on the band's yCenter + nudge (in membrane-local coords)
    const localCenter = band.yCenter + nudge - memYStart;
    let yStart = Math.round(localCenter - stripH / 2);
    let yEnd = yStart + stripH;
    // Clamp
    if (yStart < 0) { yEnd -= yStart; yStart = 0; }
    if (yEnd > memHeight) { yStart -= yEnd - memHeight; yEnd = memHeight; }
    yStart = Math.max(0, yStart);
    return { yStart, yEnd };
  });
}

// ─── Steps ───────────────────────────────────────────────────────────────────

type Step = "upload" | "processing" | "review";

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const appState = useAppState<Params, OutputFile>({
    dirName: DIR_NAME,
    defaults: DEFAULTS,
    inputSlots: ["input_image"],
  });
  const { loading, params, setParams, outputs, setOutputs, markRunComplete } = appState;

  const action = useKernelAction({
    dirName: DIR_NAME,
    kernel: "python3",
    buildKernelParams: () => ({
      input_image: params.input_image,
      outdir: `.applications/${DIR_NAME}/output`,
      script_path: `.applications/${DIR_NAME}/scripts/analyze.py`,
    }),
  });
  const { run: runKernel, phase: kernelPhase } = action;

  const [step, setStep] = useState<Step>("upload");
  const [status, setStatus] = useState("");
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [fullCanvas, setFullCanvas] = useState<HTMLCanvasElement | null>(null);
  const [memCanvases, setMemCanvases] = useState<HTMLCanvasElement[]>([]);
  const [configs, setConfigs] = useState<MembraneConfig[]>([]);
  const [panelOrder, setPanelOrder] = useState<number[]>([]);
  const [stripPlans, setStripPlans] = useState<{ yStart: number; yEnd: number }[][]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // ─── Run pipeline ─────────────────────────────────────────────────────────
  //
  // Segmentation runs through the kernel via the action cell in notebook.ipynb,
  // which invokes scripts/analyze.py and writes output/run_metadata.json. After
  // the kernel run we load the source image into a canvas, ask the LLM to filter
  // detected bands and identify ladder lanes (UI helper — not core compute), and
  // hand off to the review step.

  const handleRun = useCallback(async () => {
    if (!params.input_image) return;
    setStep("processing");
    setStatus("Running GelGenie band segmentation...");

    const result = await runKernel();
    if (!result.ok) {
      // Kernel error already surfaced in the global ErrorDisplay panel.
      setStep("upload");
      setStatus("");
      return;
    }

    const analysisData = await readJsonOutput<AnalysisResult>(
      `.applications/${DIR_NAME}/output/run_metadata.json`,
    );
    if (!analysisData) {
      setStatus("Error: run_metadata.json missing after kernel run.");
      setStep("upload");
      return;
    }
    if (analysisData.membranes.length === 0) {
      setStatus("No membranes detected.");
      setStep("upload");
      return;
    }

    setAnalysis(analysisData);
    await markRunComplete();

    // Load the source image into a canvas for cropping in the editor / export.
    const ws = window.getWorkspacePath();
    setStatus("Loading image...");
    const img = await loadImg(`local-file://${ws}/${params.input_image.startsWith(".")
      ? params.input_image
      : params.input_image.slice(ws.length + 1)}`);
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d")!.drawImage(img, 0, 0);
    setFullCanvas(c);

    const mCanvases = analysisData.membranes.map((m) => {
      const mh = m.yEnd - m.yStart;
      const mc = document.createElement("canvas");
      mc.width = c.width;
      mc.height = mh;
      mc.getContext("2d")!.drawImage(c, 0, m.yStart, c.width, mh, 0, 0, c.width, mh);
      return mc;
    });
    setMemCanvases(mCanvases);

    // LLM band/lane filter (UI helper — falls back to "keep everything" on failure).
    setStatus("AI: Filtering band rows...");
    const visUrl = `local-file://${ws}/${analysisData.visualization_path}`;
    const visImg = await loadImg(visUrl);
    const visCanvas = document.createElement("canvas");
    visCanvas.width = visImg.naturalWidth;
    visCanvas.height = visImg.naturalHeight;
    visCanvas.getContext("2d")!.drawImage(visImg, 0, 0);

    let llmResult: LLMFilterResult;
    try {
      llmResult = await filterBandsLLM(visCanvas, analysisData.membranes);
    } catch (err) {
      console.warn("LLM filtering failed, keeping all bands/lanes:", err);
      llmResult = {
        bandFilters: analysisData.membranes.map((m) => m.bands.map(() => true)),
        ladderLaneIndices: analysisData.membranes.map(() => []),
      };
    }

    const cfgs: MembraneConfig[] = analysisData.membranes.map((m, mi) => {
      const ladderSet = new Set(llmResult.ladderLaneIndices[mi] || []);
      return {
        antibodyLabels: m.bands.map((_, bi) => `Antibody ${bi + 1}`),
        laneLabels: m.laneXPositions.map((_, li) =>
          ladderSet.has(li) ? "Ladder" : `Lane ${li + 1}`),
        enabledBands: llmResult.bandFilters[mi] || m.bands.map(() => true),
        enabledLanes: m.laneXPositions.map((_, li) => !ladderSet.has(li)),
        laneNudges: m.laneXPositions.map(() => 0),
        bandNudges: m.bands.map(() => 0),
      };
    });
    setConfigs(cfgs);
    setPanelOrder(analysisData.membranes.map((_, i) => i));

    setStatus("");
    setStep("review");
  }, [params.input_image, runKernel, markRunComplete]);

  // Auto-advance from upload → processing once a file is picked, matching the
  // app's "drop a blot, see the editor" feel. Re-runs are still possible from
  // the explicit Run button in the upload step.
  useEffect(() => {
    if (loading) return;
    if (!params.input_image) return;
    if (analysis) return;
    if (kernelPhase !== "idle") return;
    handleRun();
  }, [loading, params.input_image, analysis, kernelPhase, handleRun]);

  // ─── Config helpers ────────────────────────────────────────────────────────

  const updateConfig = (idx: number, patch: Partial<MembraneConfig>) =>
    setConfigs((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));

  const toggleBand = (memIdx: number, bandIdx: number) => {
    const cfg = configs[memIdx];
    const enabled = [...cfg.enabledBands];
    enabled[bandIdx] = !enabled[bandIdx];
    updateConfig(memIdx, { enabledBands: enabled });
  };

  const toggleLane = (memIdx: number, laneIdx: number) => {
    const cfg = configs[memIdx];
    const enabled = [...cfg.enabledLanes];
    enabled[laneIdx] = !enabled[laneIdx];
    updateConfig(memIdx, { enabledLanes: enabled });
  };

  const setAntibodyLabel = (memIdx: number, bandIdx: number, label: string) => {
    const labels = [...configs[memIdx].antibodyLabels];
    labels[bandIdx] = label;
    updateConfig(memIdx, { antibodyLabels: labels });
  };

  const setLaneLabel = (memIdx: number, laneIdx: number, label: string) => {
    const labels = [...configs[memIdx].laneLabels];
    labels[laneIdx] = label;
    updateConfig(memIdx, { laneLabels: labels });
  };

  const nudgeLane = (memIdx: number, laneIdx: number, delta: number) => {
    const nudges = [...configs[memIdx].laneNudges];
    nudges[laneIdx] += delta;
    updateConfig(memIdx, { laneNudges: nudges });
  };

  const nudgeBand = (memIdx: number, bandIdx: number, delta: number) => {
    const nudges = [...configs[memIdx].bandNudges];
    nudges[bandIdx] += delta;
    updateConfig(memIdx, { bandNudges: nudges });
  };

  const movePanelOrder = (idx: number, dir: -1 | 1) =>
    setPanelOrder((prev) => {
      const n = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= n.length) return prev;
      [n[idx], n[j]] = [n[j], n[idx]];
      return n;
    });

  // ─── Generate figure ───────────────────────────────────────────────────────

  const renderFigure = useCallback(
    (plans: { yStart: number; yEnd: number }[][]) => {
      if (!fullCanvas || !analysis) return null;
      const fs = params.font_size;
      const pad = 24;
      const rightMargin = 240;
      const panelGap = 44;
      const stripGap = 6;

      const orderedPanels = panelOrder.map((i) => ({
        cfg: configs[i],
        mem: analysis.membranes[i],
        memCanvas: memCanvases[i],
        strips: plans[i] || [],
      }));

      // Only include panels with at least one enabled+labeled band
      const activePanels = orderedPanels.filter(({ cfg }) =>
        cfg.enabledBands.some((e, i) => e && cfg.antibodyLabels[i]?.trim()),
      );
      if (activePanels.length === 0) return null;

      const maxW = Math.max(...activePanels.map(({ mem }) => mem.contentXMax - mem.contentXMin));

      // Measure max lane label text width
      const measureCtx = document.createElement("canvas").getContext("2d")!;
      measureCtx.font = `${fs}px Arial, sans-serif`;
      let maxLabelTextW = 0;
      for (const { cfg } of activePanels) {
        for (let i = 0; i < cfg.laneLabels.length; i++) {
          if (cfg.enabledLanes[i] && cfg.laneLabels[i]?.trim()) {
            maxLabelTextW = Math.max(maxLabelTextW, measureCtx.measureText(cfg.laneLabels[i]).width);
          }
        }
      }
      const laneLabelH = maxLabelTextW > 0 ? maxLabelTextW + 20 : 0;

      const figW = pad + maxW + rightMargin + pad;
      let figH = pad;
      for (const { cfg, strips } of activePanels) {
        const hasLabels = cfg.laneLabels.some((l, i) => cfg.enabledLanes[i] && l?.trim());
        if (hasLabels) figH += laneLabelH;
        cfg.enabledBands.forEach((en, bi) => {
          if (en && cfg.antibodyLabels[bi]?.trim()) {
            const s = strips[bi];
            figH += s ? s.yEnd - s.yStart : 80;
            figH += stripGap;
          }
        });
        figH += panelGap;
      }

      const fc = document.createElement("canvas");
      fc.width = figW;
      fc.height = figH;
      const ctx = fc.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, figW, figH);

      let cy = pad;

      for (const { cfg, mem, memCanvas, strips } of activePanels) {
        const cropX = mem.contentXMin;
        const cropW = mem.contentXMax - mem.contentXMin;
        const hasLabels = cfg.laneLabels.some((l, i) => cfg.enabledLanes[i] && l?.trim());

        // Lane labels (vertical, 90°)
        if (hasLabels) {
          ctx.save();
          ctx.font = `${fs}px Arial, sans-serif`;
          ctx.fillStyle = "#000";

          for (let i = 0; i < cfg.laneLabels.length; i++) {
            if (!cfg.enabledLanes[i] || !cfg.laneLabels[i]?.trim()) continue;
            // Offset lane position by crop origin
            const laneX = mem.laneXPositions[i] + cfg.laneNudges[i] - cropX;

            ctx.save();
            ctx.translate(pad + laneX, cy + laneLabelH - 6);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(cfg.laneLabels[i], 0, 0);
            ctx.restore();
          }
          ctx.restore();
          cy += laneLabelH;
        }

        // Strips — one per enabled band
        let stripIdx = 0;
        for (let bi = 0; bi < cfg.enabledBands.length; bi++) {
          if (!cfg.enabledBands[bi] || !cfg.antibodyLabels[bi]?.trim()) continue;
          const strip = strips[stripIdx];
          stripIdx++;
          if (!strip) continue;

          const srcY = strip.yStart;
          const srcH = strip.yEnd - strip.yStart;

          // Draw only the cropped content region
          ctx.drawImage(memCanvas, cropX, srcY, cropW, srcH, pad, cy, cropW, srcH);

          ctx.font = `${fs}px Arial, sans-serif`;
          ctx.fillStyle = "#000";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(cfg.antibodyLabels[bi], pad + cropW + 14, cy + srcH / 2);

          cy += srcH + stripGap;
        }
        cy += panelGap - stripGap;
      }

      const out = document.createElement("canvas");
      out.width = fc.width;
      out.height = cy;
      out.getContext("2d")!.drawImage(fc, 0, 0);
      const url = out.toDataURL("image/png");
      setPreviewUrl(url);
      return url;
    },
    [fullCanvas, analysis, memCanvases, configs, panelOrder, params.font_size],
  );

  /** Compute strip crops from GelGenie data and render */
  const generateFigure = useCallback(() => {
    if (!analysis || memCanvases.length === 0) return;

    const plans: { yStart: number; yEnd: number }[][] = [];
    for (let idx = 0; idx < analysis.membranes.length; idx++) {
      const mem = analysis.membranes[idx];
      const cfg = configs[idx];
      const mc = memCanvases[idx];
      const strips = computeStripCrops(mc.height, mem.yStart, mem.bands, cfg.enabledBands, cfg.bandNudges);
      plans.push(strips);
    }

    setStripPlans(plans);
    renderFigure(plans);
  }, [analysis, memCanvases, configs, renderFigure]);

  // Auto-generate figure on first entering review step
  const [autoRendered, setAutoRendered] = useState(false);
  useEffect(() => {
    if (step === "review" && !autoRendered && analysis && memCanvases.length > 0 && configs.length > 0) {
      setAutoRendered(true);
      generateFigure();
    }
  }, [step, autoRendered, analysis, memCanvases, configs, generateFigure]);

  // ─── Export ────────────────────────────────────────────────────────────────

  const handleExport = async () => {
    const url = renderFigure(stripPlans);
    if (!url) return;
    const outPath = `.applications/${DIR_NAME}/output/western_blot_figure.png`;
    try { await window.filesAPI.writeFile(outPath, url); } catch (err) { console.error(err); }
    setOutputs([{ name: "western_blot_figure.png", description: "Assembled western blot figure", path: outPath }]);
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  if (loading) return <Loading text="Loading..." />;

  return (
    <div className="min-h-screen bg-[#faf8f5]">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <ImageIcon className="w-5 h-5 text-blue-600" /> Western Blot Annotator
        </h1>
        <p className="text-xs text-gray-500 mt-0.5">Annotate lanes and antibodies on Western blot images</p>
        <div className="flex items-center gap-1 mt-3">
          {([["upload", "1. Upload"], ["processing", "2. Processing"], ["review", "3. Label & Export"]] as [Step, string][]).map(([key, label], i) => (
            <React.Fragment key={key}>
              {i > 0 && <div className="w-6 h-px bg-gray-300" />}
              <div className={`px-3 py-1.5 rounded-full text-xs font-medium ${
                step === key ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-500"
              }`}>{label}</div>
            </React.Fragment>
          ))}
        </div>
      </div>

      <div className="max-w-5xl mx-auto p-6 space-y-5">
        {/* Step 1: Upload */}
        {step === "upload" && (
          <Card title="Upload Western Blot Image">
            <FileSlotPicker state={appState} slot="input_image" label="Blot image (TIFF, PNG, JPG)"
              filters={[{ name: "Images", extensions: ["tiff", "tif", "png", "jpg", "jpeg"] }]} />
            {params.input_image && (
              <div className="mt-4">
                <RunButton action={action} onRun={handleRun} disabled={!params.input_image}>
                  Run Analysis
                </RunButton>
                {status && <p className="text-xs text-red-600 mt-2">{status}</p>}
              </div>
            )}
          </Card>
        )}

        {/* Step 2: Processing (automated) */}
        {step === "processing" && (
          <Card title="Analyzing Image">
            <Loading text={status || "Processing..."} />
            <p className="text-xs text-gray-400 mt-2">GelGenie is segmenting bands, detecting membranes, lanes, and band positions...</p>
          </Card>
        )}

        {/* Step 3: Label, Review & Export (merged) */}
        {step === "review" && analysis && (
          <Card title="Label & Export" subtitle="Edit labels, toggle bands/lanes, then hit Refresh to update the preview.">
            {/* Interactive detection editor */}
            {fullCanvas && (
              <InteractiveDetectionEditor
                imageSrc={fullCanvas.toDataURL()}
                imageWidth={analysis.imageWidth}
                imageHeight={analysis.imageHeight}
                membranes={analysis.membranes}
                configs={configs}
                onToggleBand={toggleBand}
                onToggleLane={toggleLane}
                onNudgeBand={nudgeBand}
                onSetBandLabel={setAntibodyLabel}
                onSetLaneLabel={setLaneLabel}
              />
            )}

            {/* Panel order */}
            <div className="mb-4">
              <label className="text-sm font-medium text-gray-700 block mb-2">Panel Order:</label>
              <div className="space-y-1">
                {panelOrder.map((cfgIdx, orderIdx) => (
                  <div key={cfgIdx} className="flex items-center gap-2 bg-gray-50 rounded px-3 py-1.5">
                    <span className="text-sm text-gray-700 flex-1">
                      Membrane {cfgIdx + 1}: {configs[cfgIdx]?.antibodyLabels.filter((l, i) => configs[cfgIdx].enabledBands[i] && l.trim()).join(", ")}
                    </span>
                    <button onClick={() => movePanelOrder(orderIdx, -1)} disabled={orderIdx === 0}
                      className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-25"><ChevronUp className="w-4 h-4" /></button>
                    <button onClick={() => movePanelOrder(orderIdx, 1)} disabled={orderIdx === panelOrder.length - 1}
                      className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-25"><ChevronDown className="w-4 h-4" /></button>
                  </div>
                ))}
              </div>
            </div>

            {/* Controls */}
            <div className="flex items-center gap-6 mb-4 flex-wrap">
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-600">Font:</label>
                <input type="range" min={8} max={28} value={params.font_size}
                  onChange={(e) => setParams({ font_size: +e.target.value })} className="w-28" />
                <span className="text-sm font-mono text-gray-700 w-10">{params.font_size}px</span>
              </div>
              <button onClick={() => generateFigure()}
                disabled={!configs.some((c) => c.enabledBands.some((e, i) => e && c.antibodyLabels[i]?.trim()))}
                className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm flex items-center gap-1 disabled:bg-gray-300 disabled:cursor-not-allowed">
                <RotateCcw className="w-3.5 h-3.5" /> Refresh Preview
              </button>
            </div>

            {/* Preview */}
            {previewUrl ? (
              <div className="border border-gray-200 rounded-lg p-6 bg-white flex justify-center mb-4">
                <img src={previewUrl} alt="Preview" className="max-w-full" />
              </div>
            ) : (
              <div className="text-center text-gray-400 py-12 mb-4">Generating preview...</div>
            )}

            {/* Navigation */}
            <div className="flex justify-between">
              <button onClick={() => { setAnalysis(null); setPreviewUrl(null); setAutoRendered(false); setStep("upload"); }}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm font-medium flex items-center gap-1">
                <ArrowLeft className="w-4 h-4" /> Re-upload
              </button>
              <button onClick={handleExport}
                disabled={!previewUrl}
                className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium flex items-center gap-1 disabled:bg-gray-300 disabled:cursor-not-allowed">
                <Download className="w-4 h-4" /> Export PNG
              </button>
            </div>
          </Card>
        )}

        <OutputFileList files={outputs} outputDir={`.applications/${DIR_NAME}/output`} />
      </div>
    </div>
  );
}

// ─── Small components ────────────────────────────────────────────────────────

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      {subtitle && <p className="text-sm text-gray-500 mt-0.5 mb-4">{subtitle}</p>}
      {!subtitle && <div className="mb-4" />}
      {children}
    </div>
  );
}

function Loading({ text = "Loading...", className = "" }: { text?: string; className?: string }) {
  return (
    <div className={`flex items-center gap-2 text-blue-600 text-sm ${className}`}>
      <Loader2 className="w-4 h-4 animate-spin" /> {text}
    </div>
  );
}

// ─── Interactive Detection Editor ───────────────────────────────────────────

function InteractiveDetectionEditor({
  imageSrc,
  imageWidth,
  imageHeight,
  membranes,
  configs,
  onToggleBand,
  onToggleLane,
  onNudgeBand,
  onSetBandLabel,
  onSetLaneLabel,
}: {
  imageSrc: string;
  imageWidth: number;
  imageHeight: number;
  membranes: AnalyzedMembrane[];
  configs: MembraneConfig[];
  onToggleBand: (mi: number, bi: number) => void;
  onToggleLane: (mi: number, li: number) => void;
  onNudgeBand: (mi: number, bi: number, delta: number) => void;
  onSetBandLabel: (mi: number, bi: number, label: string) => void;
  onSetLaneLabel: (mi: number, li: number, label: string) => void;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [displayW, setDisplayW] = useState(0);
  const [dragState, setDragState] = useState<{
    memIdx: number;
    bandIdx: number;
    startY: number;
    startNudge: number;
    didDrag: boolean;
  } | null>(null);
  const [editing, setEditing] = useState<{
    type: "band" | "lane";
    memIdx: number;
    idx: number;
  } | null>(null);

  // Track container width for scaling
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      for (const e of entries) setDisplayW(e.contentRect.width);
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  const scale = displayW > 0 ? displayW / imageWidth : 1;
  const displayH = imageHeight * scale;

  const DRAG_THRESHOLD = 3;

  const handlePointerDown = (e: React.PointerEvent, memIdx: number, bandIdx: number) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragState({
      memIdx,
      bandIdx,
      startY: e.clientY,
      startNudge: configs[memIdx]?.bandNudges[bandIdx] ?? 0,
      didDrag: false,
    });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragState) return;
    const deltaDisplay = e.clientY - dragState.startY;
    const deltaReal = Math.round(deltaDisplay / scale);
    const newNudge = dragState.startNudge + deltaReal;
    const currentNudge = configs[dragState.memIdx]?.bandNudges[dragState.bandIdx] ?? 0;
    if (!dragState.didDrag && Math.abs(deltaDisplay) > DRAG_THRESHOLD) {
      setDragState((prev) => prev ? { ...prev, didDrag: true } : null);
    }
    if (newNudge !== currentNudge) {
      onNudgeBand(dragState.memIdx, dragState.bandIdx, newNudge - currentNudge);
    }
  };

  const handlePointerUp = () => {
    setDragState(null);
  };

  const commitEdit = (value: string) => {
    if (!editing) return;
    if (editing.type === "band") onSetBandLabel(editing.memIdx, editing.idx, value);
    else onSetLaneLabel(editing.memIdx, editing.idx, value);
    setEditing(null);
  };

  // Right margin for labels
  const LABEL_MARGIN = 130;

  return (
    <div className="mb-6 border border-gray-200 rounded-lg p-4 bg-gray-50">
      <p className="text-sm font-medium text-gray-700 mb-2">Detection Editor</p>
      <p className="text-xs text-gray-400 mb-3">
        <span className="inline-block w-3 h-1 rounded-sm mr-1" style={{ backgroundColor: "rgba(220,160,0,1)" }} /> Band lines (drag ↕) · click label to edit · click
        <span className="inline-block w-2 h-2 rounded-full mx-1 border" style={{ borderColor: "rgba(220,160,0,1)" }} />
        to toggle
        <span className="inline-block w-1 h-3 rounded-sm ml-3 mr-1" style={{ backgroundColor: "rgba(0,140,200,1)" }} /> Lane labels · click to edit · click
        <span className="inline-block w-2 h-2 rounded-full mx-1 border" style={{ borderColor: "rgba(0,140,200,1)" }} />
        to toggle
      </p>
      <div
        ref={containerRef}
        className="relative select-none rounded border border-gray-200 overflow-hidden"
        style={{ width: "100%", height: displayH || "auto" }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onClick={() => { if (editing) setEditing(null); }}
      >
        {/* Blot image */}
        <img
          src={imageSrc}
          alt="Western blot"
          className="block"
          style={{ width: `calc(100% - ${LABEL_MARGIN}px)`, height: displayH || "auto" }}
          draggable={false}
        />

        {/* SVG overlay */}
        {displayW > 0 && (
          <svg
            className="absolute inset-0"
            width={displayW}
            height={displayH}
            style={{ pointerEvents: "none", overflow: "visible" }}
          >
            {membranes.map((mem, mi) => {
              const cfg = configs[mi];
              if (!cfg) return null;
              const y1 = mem.yStart * scale;
              const y2 = mem.yEnd * scale;
              const imgScale = (displayW - LABEL_MARGIN) / imageWidth;
              const labelX = (displayW - LABEL_MARGIN) + 8;

              return (
                <g key={mi}>
                  {/* Membrane bounding box */}
                  <rect
                    x={mem.contentXMin * imgScale}
                    y={mem.yStart * imgScale}
                    width={(mem.contentXMax - mem.contentXMin) * imgScale}
                    height={(mem.yEnd - mem.yStart) * imgScale}
                    fill="none"
                    stroke="rgba(200,40,40,0.8)"
                    strokeWidth={1.5}
                    strokeDasharray="6 3"
                  />

                  {/* Band lines + labels */}
                  {mem.bands.map((band, bi) => {
                    const enabled = cfg.enabledBands[bi];
                    const nudge = cfg.bandNudges[bi] || 0;
                    const lineY = (band.yCenter + nudge) * imgScale;
                    const isDragging = dragState?.memIdx === mi && dragState?.bandIdx === bi;
                    const bx1 = mem.contentXMin * imgScale;
                    const bx2 = mem.contentXMax * imgScale;
                    const isEditing = editing?.type === "band" && editing.memIdx === mi && editing.idx === bi;
                    const color = enabled ? "rgba(220,160,0,1)" : "rgba(150,150,150,0.4)";

                    return (
                      <g key={`band-${bi}`}>
                        {/* Wide invisible hit area for drag */}
                        <line
                          x1={bx1} y1={lineY} x2={bx2} y2={lineY}
                          stroke="transparent" strokeWidth={16}
                          style={{ pointerEvents: "stroke", cursor: "ns-resize" }}
                          onPointerDown={(e) => handlePointerDown(e, mi, bi)}
                        />
                        {/* Visible line */}
                        <line
                          x1={bx1} y1={lineY} x2={bx2} y2={lineY}
                          stroke={color}
                          strokeWidth={isDragging ? 3 : enabled ? 2 : 1}
                          strokeDasharray={enabled ? "none" : "4 3"}
                          style={{
                            pointerEvents: "none",
                            filter: isDragging ? "drop-shadow(0 0 3px rgba(220,160,0,0.9))" : "none",
                          }}
                        />
                        {/* Toggle circle */}
                        <circle
                          cx={labelX - 2}
                          cy={lineY}
                          r={5}
                          fill={enabled ? "rgba(220,160,0,1)" : "transparent"}
                          stroke={enabled ? "rgba(220,160,0,1)" : "rgba(150,150,150,0.5)"}
                          strokeWidth={1.5}
                          style={{ pointerEvents: "auto", cursor: "pointer" }}
                          onClick={(e) => { e.stopPropagation(); onToggleBand(mi, bi); }}
                        />
                        {/* Label: text or inline input */}
                        {isEditing ? (
                          <foreignObject x={labelX + 6} y={lineY - 10} width={LABEL_MARGIN - 20} height={20}>
                            <input
                              autoFocus
                              type="text"
                              defaultValue={cfg.antibodyLabels[bi] || ""}
                              onBlur={(e) => commitEdit(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") commitEdit((e.target as HTMLInputElement).value); if (e.key === "Escape") setEditing(null); }}
                              onClick={(e) => e.stopPropagation()}
                              style={{
                                width: "100%", height: "100%",
                                fontSize: 11, padding: "0 4px",
                                border: "1px solid rgba(220,160,0,0.6)",
                                borderRadius: 3, outline: "none",
                                background: "rgba(255,255,255,0.95)",
                                color: "#333",
                              }}
                            />
                          </foreignObject>
                        ) : (
                          <text
                            x={labelX + 8}
                            y={lineY + 4}
                            fontSize={11}
                            fill={enabled ? "rgba(220,160,0,1)" : "rgba(150,150,150,0.5)"}
                            style={{ pointerEvents: "auto", cursor: "text" }}
                            onClick={(e) => { e.stopPropagation(); setEditing({ type: "band", memIdx: mi, idx: bi }); }}
                          >
                            {cfg.antibodyLabels[bi] || `Band ${bi + 1}`}
                          </text>
                        )}
                      </g>
                    );
                  })}

                  {/* Lane lines + labels */}
                  {mem.laneXPositions.map((x, li) => {
                    const enabled = cfg.enabledLanes[li];
                    const nudge = cfg.laneNudges[li] || 0;
                    const lineX = (x + nudge) * imgScale;
                    const laneY1 = mem.yStart * imgScale;
                    const laneY2 = mem.yEnd * imgScale;
                    const isEditing = editing?.type === "lane" && editing.memIdx === mi && editing.idx === li;
                    const color = enabled ? "rgba(0,140,200,1)" : "rgba(150,150,150,0.3)";

                    return (
                      <g key={`lane-${li}`}>
                        <line
                          x1={lineX} y1={laneY1} x2={lineX} y2={laneY2}
                          stroke={color}
                          strokeWidth={enabled ? 1.5 : 1}
                          strokeDasharray={enabled ? "none" : "4 3"}
                          style={{ pointerEvents: "none" }}
                        />
                        {/* Toggle circle at top */}
                        <circle
                          cx={lineX}
                          cy={laneY1 - 10}
                          r={4}
                          fill={enabled ? "rgba(0,140,200,1)" : "transparent"}
                          stroke={enabled ? "rgba(0,140,200,1)" : "rgba(150,150,150,0.5)"}
                          strokeWidth={1.5}
                          style={{ pointerEvents: "auto", cursor: "pointer" }}
                          onClick={(e) => { e.stopPropagation(); onToggleLane(mi, li); }}
                        />
                        {/* Label: rotated text or inline input */}
                        {isEditing ? (
                          <foreignObject x={lineX - 45} y={laneY1 - 30} width={90} height={18}>
                            <input
                              autoFocus
                              type="text"
                              defaultValue={cfg.laneLabels[li] || ""}
                              onBlur={(e) => commitEdit(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") commitEdit((e.target as HTMLInputElement).value); if (e.key === "Escape") setEditing(null); }}
                              onClick={(e) => e.stopPropagation()}
                              style={{
                                width: "100%", height: "100%",
                                fontSize: 10, padding: "0 3px",
                                border: "1px solid rgba(0,140,200,0.6)",
                                borderRadius: 3, outline: "none",
                                background: "rgba(255,255,255,0.95)",
                                color: "#333", textAlign: "center",
                              }}
                            />
                          </foreignObject>
                        ) : (
                          <text
                            x={lineX}
                            y={laneY1 - 16}
                            fontSize={9}
                            fill={enabled ? "rgba(0,140,200,1)" : "rgba(150,150,150,0.4)"}
                            textAnchor="middle"
                            style={{ pointerEvents: "auto", cursor: "text" }}
                            onClick={(e) => { e.stopPropagation(); setEditing({ type: "lane", memIdx: mi, idx: li }); }}
                          >
                            {cfg.laneLabels[li] || `L${li + 1}`}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </svg>
        )}
      </div>
    </div>
  );
}
