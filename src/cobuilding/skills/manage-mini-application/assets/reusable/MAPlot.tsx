import React, { useMemo, useRef, useEffect, useState } from "react";
import Plot from "react-plotly.js";
import { type VolcanoGene, COLORS, LABELS, type Regulation, classifyGene } from "./types";

interface MAPlotProps {
  data: VolcanoGene[];
  lfcThreshold: number;
  alpha: number;
}

const xAxisTitle = "log\u2081\u2080(baseMean + 1)";
const yAxisTitle = "log\u2082(Fold Change)";

const MAPlotComponent = ({ data, lfcThreshold, alpha }: MAPlotProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0);

  const plotData = useMemo(() => {
    const groups: Record<Regulation, VolcanoGene[]> = {
      up: [],
      down: [],
      ns: [],
    };

    for (const gene of data) {
      groups[classifyGene(gene, lfcThreshold, alpha)].push(gene);
    }

    return (["ns", "down", "up"] as Regulation[]).map((reg) => {
      const points = groups[reg];
      return {
        x: points.map((g) => Math.log10(g.baseMean + 1)),
        y: points.map((g) => g.log2FoldChange),
        type: "scattergl" as const,
        mode: "markers" as const,
        name: `${LABELS[reg]} (${points.length.toLocaleString()})`,
        marker: {
          color: COLORS[reg],
          size: reg === "ns" ? 2 : 5,
          opacity: reg === "ns" ? 0.15 : 0.7,
        },
        text: points.map(
          (g) =>
            `<b>${g.symbol || g.ensembl_id}</b><br>log\u2081\u2080(baseMean+1): ${Math.log10(g.baseMean + 1).toFixed(3)}<br>log\u2082FC: ${g.log2FoldChange.toFixed(3)}<br>p-adj: ${g.padj.toExponential(2)}`,
        ),
        hoverinfo: "text" as const,
        hoverlabel: {
          bgcolor: "white",
          bordercolor: COLORS[reg],
          font: {
            family: "system-ui, -apple-system, sans-serif",
            size: 12,
            color: "#1a1a1a",
          },
        },
      };
    });
  }, [data, lfcThreshold, alpha]);

  const axisLimits = useMemo(() => {
    if (data.length === 0) return { xMax: 5, yMax: 5 };

    let xMax = 0;
    let yMax = 0;
    for (const g of data) {
      const xVal = Math.log10(g.baseMean + 1);
      if (xVal > xMax && Number.isFinite(xVal)) xMax = xVal;
      const absLfc = Math.abs(g.log2FoldChange);
      if (absLfc > yMax && Number.isFinite(absLfc)) yMax = absLfc;
    }

    const xPad = Math.max(xMax * 0.05, 0.2);
    const yPad = Math.max(yMax * 0.05, 0.5);
    return { xMax: xMax + xPad, yMax: yMax + yPad };
  }, [data]);

  const layout = useMemo(
    () => ({
      font: { family: "system-ui, -apple-system, sans-serif" },
      xaxis: {
        title: {
          text: xAxisTitle,
          font: { size: 13, color: "#555" },
          standoff: 12,
        },
        gridcolor: "#f0f0f0",
        gridwidth: 1,
        zeroline: false,
        linecolor: "#ddd",
        linewidth: 1,
        showline: true,
        tickfont: { size: 11, color: "#777" },
        range: [0, axisLimits.xMax],
      },
      yaxis: {
        title: {
          text: yAxisTitle,
          font: { size: 13, color: "#555" },
          standoff: 8,
        },
        gridcolor: "#f0f0f0",
        gridwidth: 1,
        zeroline: true,
        zerolinecolor: "#ddd",
        zerolinewidth: 1,
        linecolor: "#ddd",
        linewidth: 1,
        showline: true,
        tickfont: { size: 11, color: "#777" },
        range: [-axisLimits.yMax, axisLimits.yMax],
      },
      shapes: [
        {
          type: "line" as const,
          x0: 0,
          x1: 1,
          xref: "paper" as const,
          y0: lfcThreshold,
          y1: lfcThreshold,
          line: { color: "#aaa", width: 1, dash: "dot" as const },
        },
        {
          type: "line" as const,
          x0: 0,
          x1: 1,
          xref: "paper" as const,
          y0: -lfcThreshold,
          y1: -lfcThreshold,
          line: { color: "#aaa", width: 1, dash: "dot" as const },
        },
      ],
      annotations: [
        {
          x: 1.01,
          xref: "paper" as const,
          y: lfcThreshold,
          text: `LFC=${lfcThreshold.toFixed(1)}`,
          showarrow: false,
          font: { size: 9, color: "#999" },
          xanchor: "left" as const,
          yanchor: "middle" as const,
        },
        {
          x: 1.01,
          xref: "paper" as const,
          y: -lfcThreshold,
          text: `LFC=${(-lfcThreshold).toFixed(1)}`,
          showarrow: false,
          font: { size: 9, color: "#999" },
          xanchor: "left" as const,
          yanchor: "middle" as const,
        },
      ],
      autosize: true,
      margin: { l: 56, r: 56, t: 16, b: 52 },
      paper_bgcolor: "transparent",
      plot_bgcolor: "#fafafa",
      legend: {
        orientation: "h" as const,
        x: 0.5,
        xanchor: "center" as const,
        y: -0.15,
        yanchor: "top" as const,
        font: { size: 11, color: "#555" },
        tracegroupgap: 16,
      },
      hovermode: "closest" as const,
      dragmode: false as const,
      datarevision: `${revision}-${lfcThreshold}-${alpha}`,
    }),
    [lfcThreshold, alpha, revision, axisLimits],
  );

  const config = useMemo(
    () => ({
      displayModeBar: false,
      displaylogo: false,
    }),
    [],
  );

  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      setRevision((prev) => prev + 1);
    });

    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  return (
    <div ref={containerRef} style={{ width: "100%", aspectRatio: "4 / 3" }}>
      <Plot
        data={plotData}
        layout={layout}
        config={config}
        style={{ width: "100%", height: "100%" }}
        useResizeHandler={true}
      />
    </div>
  );
};

export const MAPlot = React.memo(MAPlotComponent);
