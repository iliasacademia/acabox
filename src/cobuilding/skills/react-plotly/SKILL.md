---
name: react-plotly
description: >
  Build interactive data visualizations using react-plotly.js in
  mini-applications. Use when creating charts, plots, graphs, heatmaps, or any
  data visualization inside a mini-app. Covers project-specific design system,
  responsive container patterns, performance optimization, and all major chart
  types.
---

# React-Plotly Visualization Guide

Import `Plot` from `"react-plotly.js"` (pre-installed in the Docker container along with `plotly.js`).

```tsx
import Plot from "react-plotly.js";
```

**Detailed references:**
- **Trace types** (scatter, bar, heatmap, histogram, box, violin, pie, bubble): See [reference/trace-types.md](reference/trace-types.md)
- **Layout, axes, shapes, annotations, hover templates**: See [reference/layout-and-axes.md](reference/layout-and-axes.md)
- **Complete examples**: See [examples/grouped-bar-chart.tsx](examples/grouped-bar-chart.tsx) and [examples/heatmap.tsx](examples/heatmap.tsx)

## Project Standard Config

Always hide the Plotly modebar and logo:

```tsx
const config = useMemo(() => ({
  displayModeBar: false,
  displaylogo: false,
}), []);
```

## Responsive Container Pattern

Every chart component must follow this pattern:

```tsx
import React, { useRef, useEffect, useState, useMemo } from "react";
import Plot from "react-plotly.js";

const MyChartComponent = ({ data }: Props) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => setRevision(prev => prev + 1));
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const plotData = useMemo(() => [/* traces */], [data]);

  const layout = useMemo(() => ({
    autosize: true,
    margin: { l: 56, r: 40, t: 16, b: 52 },
    paper_bgcolor: "transparent",
    plot_bgcolor: "#fafafa",
    font: { family: "system-ui, -apple-system, sans-serif" },
    datarevision: revision,
  }), [revision]);

  const config = useMemo(() => ({
    displayModeBar: false,
    displaylogo: false,
  }), []);

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

export const MyChart = React.memo(MyChartComponent);
```

Key requirements:
- `aspectRatio` on the container: `"4 / 3"` (default), `"16 / 9"` (wide), `"1 / 1"` (square)
- `ResizeObserver` + `revision` state forces re-render on container resize
- `datarevision` in layout must include any reactive values that should trigger a re-render
- Wrap all `data`, `layout`, `config` in `useMemo`
- Wrap exported component in `React.memo`

## Visual Design System

### Fonts
```tsx
font: { family: "system-ui, -apple-system, sans-serif" }
```

### Axis Styling
```tsx
xaxis: {
  title: { text: "X Label", font: { size: 13, color: "#555" }, standoff: 12 },
  gridcolor: "#f0f0f0",
  gridwidth: 1,
  linecolor: "#ddd",
  linewidth: 1,
  showline: true,
  zeroline: false,
  tickfont: { size: 11, color: "#777" },
  automargin: true,
}
```

### Backgrounds
```tsx
paper_bgcolor: "transparent",  // inherit card background
plot_bgcolor: "#fafafa",       // light gray plot area
```

### Legend
```tsx
legend: {
  orientation: "h" as const,
  x: 0.5, xanchor: "center" as const,
  y: -0.15, yanchor: "top" as const,
  font: { size: 11, color: "#555" },
  tracegroupgap: 16,
}
```

### Margins
```tsx
margin: { l: 56, r: 40, t: 16, b: 52 }
```

Small top margin — use an HTML heading above the chart instead of Plotly titles. Increase `b` if the legend is below.

### Hover Labels
```tsx
hoverlabel: {
  bgcolor: "white",
  bordercolor: "#666",
  font: { family: "system-ui, -apple-system, sans-serif", size: 12, color: "#1a1a1a" },
}
```

### Drag Mode

`dragmode: false` for non-exploratory charts. Keep default for interactive exploration.

## Color Palettes

### Categorical
```tsx
const PLOTLY_COLORS = [
  "#636efa", "#EF553B", "#00cc96", "#ab63fa", "#FFA15A",
  "#19d3f3", "#FF6692", "#B6E880", "#FF97FF", "#FECB52",
];
```

### Regulation (bioinformatics)
```tsx
const REGULATION_COLORS = { up: "#ef4444", down: "#3b82f6", ns: "#d4d4d4" };
```

### Colorblind-safe
```tsx
const COLORBLIND_SAFE = [
  "#0072B2", "#E69F00", "#009E73", "#CC79A7",
  "#56B4E9", "#D55E00", "#F0E442", "#000000",
];
```

### Diverging Colorscale (blue-white-red)
```tsx
colorscale: [[0, "#3b82f6"], [0.5, "#ffffff"], [1, "#ef4444"]]
```

## Performance

- Use `"scattergl"` instead of `"scatter"` for >1,000 points
- Wrap `data`, `layout`, `config` in `useMemo` with correct dependency arrays
- Wrap exported component in `React.memo`
- For >100k points, consider `marker: { maxdisplayed: 10000 }`
- `scattergl` does not support all `scatter` features (e.g. `fill` is limited) — fall back when needed

## Common Pitfalls

### Mutating data won't trigger re-render

`react-plotly.js` uses shallow `===` checks. Always create new references:

```tsx
// WRONG: mutate in place
data[0].y.push(newValue);

// CORRECT: new reference
setData(prev => prev.map((trace, i) =>
  i === 0 ? { ...trace, y: [...trace.y, newValue] } : trace
));
```

Or increment a `revision` prop on `<Plot>`.

### TypeScript `as const`

Plotly uses string literal unions. TypeScript widens strings unless you add `as const`:

```tsx
orientation: "h" as const,
type: "scatter" as const,
mode: "lines+markers" as const,
```

### Margin clipping

If labels are cut off, set `automargin: true` on the affected axis.

### Log axes and zero

Log axes cannot display zero or negative values. Filter them out or use epsilon.

### Large shapes/annotations arrays

Each item adds overhead to every render cycle. Keep these arrays short.
