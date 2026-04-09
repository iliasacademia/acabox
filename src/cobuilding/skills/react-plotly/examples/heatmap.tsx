import React, { useMemo, useRef, useEffect, useState } from "react";
import Plot from "react-plotly.js";

interface HeatmapProps {
  z: number[][];
  xLabels: string[];
  yLabels: string[];
  colorscaleLabel?: string;
  diverging?: boolean;
}

const HeatmapComponent = ({
  z,
  xLabels,
  yLabels,
  colorscaleLabel,
  diverging,
}: HeatmapProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => setRevision((prev) => prev + 1));
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const plotData = useMemo(
    () => [
      {
        type: "heatmap" as const,
        z,
        x: xLabels,
        y: yLabels,
        colorscale: diverging
          ? ([[0, "#3b82f6"], [0.5, "#ffffff"], [1, "#ef4444"]] as [number, string][])
          : ("Viridis" as const),
        zmid: diverging ? 0 : undefined,
        xgap: 1,
        ygap: 1,
        showscale: true,
        colorbar: {
          title: {
            text: colorscaleLabel ?? "Value",
            side: "right" as const,
            font: { size: 11, color: "#555" },
          },
          tickfont: { size: 10, color: "#777" },
          len: 0.8,
          thickness: 12,
          outlinewidth: 0,
        },
        hovertemplate:
          "<b>%{y}</b> x <b>%{x}</b><br>Value: %{z:.3f}<extra></extra>",
        hoverlabel: {
          bgcolor: "white",
          font: {
            family: "system-ui, -apple-system, sans-serif",
            size: 12,
            color: "#1a1a1a",
          },
        },
      },
    ],
    [z, xLabels, yLabels, colorscaleLabel, diverging],
  );

  const layout = useMemo(
    () => ({
      font: { family: "system-ui, -apple-system, sans-serif" },
      xaxis: {
        tickfont: { size: 10, color: "#555" },
        tickangle: -45,
        side: "bottom" as const,
        automargin: true,
      },
      yaxis: {
        tickfont: { size: 10, color: "#555" },
        autorange: "reversed" as const,
        automargin: true,
      },
      autosize: true,
      margin: { l: 10, r: 10, t: 10, b: 10 },
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      datarevision: revision,
    }),
    [revision],
  );

  const config = useMemo(
    () => ({
      displayModeBar: false,
      displaylogo: false,
    }),
    [],
  );

  return (
    <div ref={containerRef} style={{ width: "100%", aspectRatio: "1 / 1" }}>
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

export const Heatmap = React.memo(HeatmapComponent);
