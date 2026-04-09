import React, { useMemo, useRef, useEffect, useState } from "react";
import Plot from "react-plotly.js";
import { type VolcanoGene, COLORS, LABELS, type Regulation, classifyGene } from "./types";

interface VolcanoPlotProps {
  data: VolcanoGene[];
  lfcThreshold: number;
  alpha: number;
}

const xAxisTitle = "log\u2082(Fold Change)";
const yAxisTitle = "\u2212log\u2081\u2080(p-adj)";

const VolcanoPlotComponent = ({
  data,
  lfcThreshold,
  alpha,
}: VolcanoPlotProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0);

  const { plotData, geneLabels } = useMemo(() => {
    const groups: Record<Regulation, VolcanoGene[]> = {
      up: [],
      down: [],
      ns: [],
    };

    for (const gene of data) {
      groups[classifyGene(gene, lfcThreshold, alpha)].push(gene);
    }

    const topBySignificance = (genes: VolcanoGene[], n: number) => {
      const withSymbol = genes.filter((g) => g.symbol);
      withSymbol.sort((a, b) => b.neglog10p - a.neglog10p);
      return withSymbol.slice(0, n);
    };

    return {
      plotData: (["ns", "down", "up"] as Regulation[]).map((reg) => {
        const points = groups[reg];
        return {
          x: points.map((g) => g.log2FoldChange),
          y: points.map((g) => g.neglog10p),
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
              `<b>${g.symbol || g.ensembl_id}</b><br>log\u2082FC: ${g.log2FoldChange.toFixed(3)}<br>p-adj: ${g.padj.toExponential(2)}<br>baseMean: ${g.baseMean.toFixed(1)}`,
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
      }),
      geneLabels: {
        up: topBySignificance(groups.up, 5),
        down: topBySignificance(groups.down, 5),
      },
    };
  }, [data, lfcThreshold, alpha]);

  const axisLimits = useMemo(() => {
    if (data.length === 0) return { xMax: 10, yMax: 10 };

    let xMax = 0;
    const yValues: number[] = [];
    for (const g of data) {
      const absLfc = Math.abs(g.log2FoldChange);
      if (absLfc > xMax && Number.isFinite(absLfc)) xMax = absLfc;
      if (Number.isFinite(g.neglog10p)) yValues.push(g.neglog10p);
    }

    yValues.sort((a, b) => a - b);
    const p99Index = Math.floor(yValues.length * 0.99);
    const p99 = yValues[p99Index] ?? 10;
    const yMax = Math.max(p99 * 1.1, -Math.log10(0.05) + 1);

    const xPad = Math.max(xMax * 0.05, 0.5);
    return { xMax: xMax + xPad, yMax };
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
        zeroline: true,
        zerolinecolor: "#ddd",
        zerolinewidth: 1,
        linecolor: "#ddd",
        linewidth: 1,
        showline: true,
        tickfont: { size: 11, color: "#777" },
        range: [-axisLimits.xMax, axisLimits.xMax],
      },
      yaxis: {
        title: {
          text: yAxisTitle,
          font: { size: 13, color: "#555" },
          standoff: 8,
        },
        gridcolor: "#f0f0f0",
        gridwidth: 1,
        zeroline: false,
        linecolor: "#ddd",
        linewidth: 1,
        showline: true,
        tickfont: { size: 11, color: "#777" },
        range: [0, axisLimits.yMax],
      },
      shapes: [
        {
          type: "line" as const,
          x0: -lfcThreshold,
          x1: -lfcThreshold,
          y0: 0,
          y1: 1,
          yref: "paper" as const,
          line: { color: "#aaa", width: 1, dash: "dot" as const },
        },
        {
          type: "line" as const,
          x0: lfcThreshold,
          x1: lfcThreshold,
          y0: 0,
          y1: 1,
          yref: "paper" as const,
          line: { color: "#aaa", width: 1, dash: "dot" as const },
        },
        {
          type: "line" as const,
          x0: 0,
          x1: 1,
          xref: "paper" as const,
          y0: -Math.log10(alpha),
          y1: -Math.log10(alpha),
          line: { color: "#aaa", width: 1, dash: "dot" as const },
        },
      ],
      annotations: [
        {
          x: -lfcThreshold,
          y: 1.02,
          yref: "paper" as const,
          text: `${(-lfcThreshold).toFixed(1)}`,
          showarrow: false,
          font: { size: 9, color: "#999" },
          xanchor: "center" as const,
          yanchor: "bottom" as const,
        },
        {
          x: lfcThreshold,
          y: 1.02,
          yref: "paper" as const,
          text: `${lfcThreshold.toFixed(1)}`,
          showarrow: false,
          font: { size: 9, color: "#999" },
          xanchor: "center" as const,
          yanchor: "bottom" as const,
        },
        {
          x: 1.01,
          xref: "paper" as const,
          y: -Math.log10(alpha),
          text: `\u03b1=${alpha}`,
          showarrow: false,
          font: { size: 9, color: "#999" },
          xanchor: "left" as const,
          yanchor: "middle" as const,
        },
        ...geneLabels.up.map((gene, i) => ({
          x: gene.log2FoldChange,
          y: gene.neglog10p,
          text: gene.symbol,
          showarrow: true,
          arrowhead: 0,
          arrowwidth: 0.8,
          arrowcolor: "#aaa",
          standoff: 4,
          ax: 30,
          ay: -(12 + i * 15),
          font: {
            size: 9,
            color: "#333",
            family: "system-ui, -apple-system, sans-serif",
          },
          bgcolor: "rgba(255,255,255,0.85)",
          borderpad: 1,
        })),
        ...geneLabels.down.map((gene, i) => ({
          x: gene.log2FoldChange,
          y: gene.neglog10p,
          text: gene.symbol,
          showarrow: true,
          arrowhead: 0,
          arrowwidth: 0.8,
          arrowcolor: "#aaa",
          standoff: 4,
          ax: -30,
          ay: -(12 + i * 15),
          font: {
            size: 9,
            color: "#333",
            family: "system-ui, -apple-system, sans-serif",
          },
          bgcolor: "rgba(255,255,255,0.85)",
          borderpad: 1,
        })),
      ],
      autosize: true,
      margin: { l: 56, r: 40, t: 16, b: 52 },
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
    [lfcThreshold, alpha, revision, axisLimits, geneLabels],
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

export const VolcanoPlot = React.memo(VolcanoPlotComponent);
