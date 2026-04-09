# Trace Types Reference

## Contents
- Scatter / Line
- Bar
- Heatmap
- Histogram
- Box Plot
- Violin
- Pie / Donut
- Bubble
- Fill / Area
- Error Bars

## Scatter / Line

```tsx
{
  type: "scatter",       // "scattergl" for >1k points
  x: xValues, y: yValues,
  mode: "lines+markers", // "lines", "markers", "text", or "+" combinations
  name: "Series A",
  marker: {
    color: "#636efa",
    size: 6,             // or array for variable sizing
    opacity: 0.7,
    symbol: "circle",    // "square", "diamond", "cross", "x", "triangle-up", "star"
    line: { color: "#fff", width: 1 },
  },
  line: {
    color: "#636efa",
    width: 2,
    dash: "solid",       // "dot", "dash", "longdash", "dashdot"
    shape: "linear",     // "spline", "hv", "vh", "hvh", "vhv"
  },
  text: labels,
  hovertemplate: "<b>%{text}</b><br>x: %{x:.2f}<br>y: %{y:.2f}<extra></extra>",
}
```

Always set `mode` explicitly. Plotly defaults change based on point count.

## Bar

```tsx
{
  type: "bar",
  x: categories, y: values,
  orientation: "v",      // "h" for horizontal
  marker: {
    color: "#636efa",
    line: { color: "rgba(0,0,0,0.1)", width: 1 },
    cornerradius: 4,
  },
  text: values.map(v => v.toFixed(1)),
  textposition: "outside",  // "inside", "auto", "none"
  textfont: { size: 9, color: "#777" },
  width: 0.7,
  hovertemplate: "%{x}: %{y:.1f}<extra></extra>",
}
```

**Layout barmode** (set on layout, not trace):
- `"group"` — side by side
- `"stack"` — stacked
- `"relative"` — stacked, negatives below
- `"overlay"` — overlapping (use with opacity)

```tsx
layout: { barmode: "group", bargap: 0.15, bargroupgap: 0.1 }
```

**Bar patterns** (for accessibility or visual distinction):
```tsx
marker: { pattern: { shape: "/", solidity: 0.3, size: 8 } }
// shapes: "/", "\\", "x", "-", "|", "+", "."
```

## Heatmap

```tsx
{
  type: "heatmap",
  z: [[1, 2, 3], [4, 5, 6]],
  x: colLabels, y: rowLabels,
  colorscale: "Viridis",
  zmin: 0, zmax: 10,
  zmid: 5,              // center of diverging colorscale
  showscale: true,
  xgap: 1, ygap: 1,     // pixel gap between cells
  hovertemplate: "Row: %{y}<br>Col: %{x}<br>Value: %{z:.2f}<extra></extra>",
  colorbar: {
    title: { text: "Value", side: "right" as const },
    tickfont: { size: 10 },
    len: 0.8, thickness: 12, outlinewidth: 0,
  },
}
```

**Built-in colorscales:** `"Viridis"`, `"Blues"`, `"Reds"`, `"RdBu"`, `"YlOrRd"`, `"YlGnBu"`, `"Greys"`, `"Hot"`, `"Portland"`

**Custom diverging:**
```tsx
colorscale: [[0, "#3b82f6"], [0.5, "#ffffff"], [1, "#ef4444"]]
```

Use `reversescale: true` to flip any colorscale.

## Histogram

```tsx
{
  type: "histogram",
  x: sampleData,
  nbinsx: 30,
  histnorm: "",          // "percent", "probability", "density", "probability density"
  marker: {
    color: "rgba(99, 110, 250, 0.7)",
    line: { color: "#4338ca", width: 1 },
  },
  hovertemplate: "Range: %{x}<br>Count: %{y}<extra></extra>",
}
```

**Overlaid histograms:** Set `layout.barmode: "overlay"` and `marker.opacity: 0.6` on each trace.

**Cumulative:** Add `cumulative: { enabled: true, direction: "increasing" }`.

**Custom bins:** `xbins: { start: 0, end: 100, size: 10 }`.

## Box Plot

```tsx
{
  type: "box",
  y: sampleData,
  name: "Group A",
  boxpoints: "outliers",     // "all", "suspectedoutliers", false
  jitter: 0.3,
  pointpos: 0,
  boxmean: "sd",             // true for mean line, "sd" for mean + SD
  marker: { color: "#636efa", outliercolor: "#ef4444", size: 3 },
  line: { color: "#636efa" },
  fillcolor: "rgba(99, 110, 250, 0.3)",
  whiskerwidth: 0.5,
}
```

**Pre-computed statistics** (skip raw data):
```tsx
{ type: "box", q1: [...], median: [...], q3: [...], lowerfence: [...], upperfence: [...] }
```

## Violin

```tsx
{
  type: "violin",
  y: sampleData,
  name: "Group A",
  points: "outliers",
  jitter: 0.3,
  box: { visible: true, fillcolor: "#fff", width: 0.25 },
  meanline: { visible: true, color: "#000", width: 1 },
  side: "both",              // "positive"/"negative" for split violins
  marker: { color: "#636efa", size: 3 },
  line: { color: "#636efa" },
  fillcolor: "rgba(99, 110, 250, 0.3)",
}
```

**Split violin:** Use `side: "positive"` on trace 1 and `side: "negative"` on trace 2, with same x values.

## Pie / Donut

```tsx
{
  type: "pie",
  labels: categories,
  values: counts,
  hole: 0.4,              // 0 = pie, 0.3-0.5 = donut
  textinfo: "percent+label",
  textposition: "auto",
  marker: {
    colors: PLOTLY_COLORS,
    line: { color: "#fff", width: 2 },
  },
  hovertemplate: "%{label}<br>Count: %{value}<br>%{percent}<extra></extra>",
  sort: false,            // preserve input order
}
```

## Bubble

A scatter with variable `marker.size`:

```tsx
{
  type: "scatter",
  x: xValues, y: yValues,
  mode: "markers" as const,
  marker: {
    size: sizeValues,
    sizemode: "area",
    sizeref: 2 * Math.max(...sizeValues) / (40 ** 2),  // max bubble = 40px
    sizemin: 4,
    color: colorValues,
    colorscale: "Viridis",
    showscale: true,
    line: { color: "#fff", width: 1 },
  },
  text: labels,
  hovertemplate: "<b>%{text}</b><br>X: %{x:.2f}<br>Y: %{y:.2f}<br>Size: %{marker.size:.1f}<extra></extra>",
}
```

## Fill / Area

```tsx
{
  type: "scatter",
  x: xValues, y: yValues,
  fill: "tozeroy",           // "tozerox", "tonexty", "tonextx", "toself"
  fillcolor: "rgba(99, 110, 250, 0.2)",
  line: { color: "#636efa", width: 2 },
  mode: "lines" as const,
}
```

**Stacked area:** Set `fill: "tonexty"` on traces after the first, and `stackgroup: "one"` on all traces.

## Error Bars

```tsx
error_y: {
  type: "data",              // "constant", "percent", "sqrt"
  array: upperErrors,
  arrayminus: lowerErrors,   // omit for symmetric
  visible: true,
  color: "#636efa",
  thickness: 1.5,
  width: 4,
}
```
