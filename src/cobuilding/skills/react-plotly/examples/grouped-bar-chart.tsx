import React, { useMemo, useRef, useEffect, useState } from "react";
import Plot from "react-plotly.js";

interface BarChartProps {
  categories: string[];
  groups: { name: string; values: number[]; color: string }[];
  yAxisLabel: string;
}

const BarChartComponent = ({ categories, groups, yAxisLabel }: BarChartProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => setRevision((prev) => prev + 1));
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const plotData = useMemo(
    () =>
      groups.map((group) => ({
        type: "bar" as const,
        x: categories,
        y: group.values,
        name: group.name,
        marker: {
          color: group.color,
          line: { color: "rgba(0,0,0,0.1)", width: 1 },
          cornerradius: 3,
        },
        text: group.values.map((v) => v.toFixed(1)),
        textposition: "outside" as const,
        textfont: { size: 9, color: "#777" },
        hovertemplate: `<b>${group.name}</b><br>%{x}: %{y:.2f}<extra></extra>`,
      })),
    [categories, groups],
  );

  const layout = useMemo(
    () => ({
      font: { family: "system-ui, -apple-system, sans-serif" },
      barmode: "group" as const,
      bargap: 0.2,
      bargroupgap: 0.05,
      xaxis: {
        tickfont: { size: 11, color: "#555" },
        linecolor: "#ddd",
        showline: true,
        gridcolor: "#f0f0f0",
      },
      yaxis: {
        title: { text: yAxisLabel, font: { size: 13, color: "#555" }, standoff: 8 },
        tickfont: { size: 11, color: "#777" },
        gridcolor: "#f0f0f0",
        linecolor: "#ddd",
        showline: true,
        zeroline: false,
        rangemode: "tozero" as const,
      },
      autosize: true,
      margin: { l: 56, r: 20, t: 16, b: 52 },
      paper_bgcolor: "transparent",
      plot_bgcolor: "#fafafa",
      legend: {
        orientation: "h" as const,
        x: 0.5,
        xanchor: "center" as const,
        y: -0.2,
        yanchor: "top" as const,
        font: { size: 11, color: "#555" },
      },
      hovermode: "closest" as const,
      datarevision: revision,
    }),
    [revision, yAxisLabel],
  );

  const config = useMemo(
    () => ({
      displayModeBar: false,
      displaylogo: false,
    }),
    [],
  );

  return (
    <div ref={containerRef} style={{ width: "100%", aspectRatio: "16 / 9" }}>
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

export const BarChart = React.memo(BarChartComponent);
