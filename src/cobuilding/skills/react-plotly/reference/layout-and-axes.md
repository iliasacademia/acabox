# Layout, Axes, and Interactivity Reference

## Contents
- Axis Configuration
- Tick Formatting
- Date and Log Axes
- Category Ordering
- Dual Y-Axes
- Subplots
- Shapes (Reference Lines, Regions)
- Annotations
- Hover Templates
- Selection and Events

## Axis Configuration

```tsx
xaxis: {
  type: "linear",        // "log", "date", "category", "multicategory"
  range: [0, 100],
  autorange: true,        // true, false, "reversed"
  rangemode: "tozero",    // "normal", "tozero", "nonnegative"
  fixedrange: true,       // disable zoom on this axis
  automargin: true,       // auto-expand margin to prevent label clipping
}
```

## Tick Formatting

```tsx
xaxis: {
  tickmode: "auto",       // "linear", "array"
  nticks: 10,             // max ticks in auto mode
  tick0: 0, dtick: 5,     // first tick + interval (linear mode)
  tickvals: [1, 5, 10],   // explicit positions (array mode)
  ticktext: ["Low", "Mid", "High"],  // custom labels (array mode)
  tickformat: ".1f",      // d3 format string
  tickprefix: "$",
  ticksuffix: "%",
  tickangle: -45,
  separatethousands: true,
  exponentformat: "SI",   // "none", "e", "E", "power", "SI"
}
```

**Common format strings:**

| Data type | Format | Example |
|-----------|--------|---------|
| Integer | `"d"` | 42 |
| 2 decimals | `".2f"` | 3.14 |
| Percentage | `".1%"` | 85.0% |
| Scientific | `".2e"` | 1.23e+4 |
| SI prefix | `".2s"` | 12.3k |
| Currency | `"$,.0f"` | $1,234 |
| Date year | `"%Y"` | 2024 |
| Date month | `"%b %Y"` | Jan 2024 |
| Date full | `"%b %d, %Y"` | Jan 15, 2024 |

## Date Axes

```tsx
xaxis: {
  type: "date",
  tickformat: "%b %Y",
  rangebreaks: [{ pattern: "day of week", bounds: [6, 1] }],  // skip weekends
  rangeselector: {
    buttons: [
      { count: 1, step: "month", stepmode: "backward", label: "1m" },
      { count: 6, step: "month", stepmode: "backward", label: "6m" },
      { step: "all" },
    ],
  },
}
```

## Log Axes

```tsx
yaxis: {
  type: "log",
  dtick: 1,  // one tick per decade
  range: [Math.log10(0.001), Math.log10(100)],  // range values are log10
}
```

Log axes cannot display zero or negative values. Filter these out or use a small epsilon.

## Category Ordering

```tsx
xaxis: {
  categoryorder: "total descending",  // sort by total y values
  // Or explicit:
  categoryorder: "array",
  categoryarray: ["A", "B", "C"],
}
```

Options: `"trace"`, `"category ascending"`, `"category descending"`, `"array"`, `"total ascending"`, `"total descending"`, `"mean ascending"`, `"mean descending"`.

## Dual Y-Axes

```tsx
// Trace 1: yaxis: "y" (default)
// Trace 2: yaxis: "y2"

layout: {
  yaxis: { title: { text: "Left axis" } },
  yaxis2: {
    title: { text: "Right axis" },
    overlaying: "y",
    side: "right",
    showgrid: false,
  },
}
```

## Subplots

**Grid approach:**
```tsx
layout: {
  grid: { rows: 2, columns: 2, pattern: "independent", xgap: 0.1, ygap: 0.1 },
}
// trace1: xaxis: "x", yaxis: "y"    (top-left)
// trace2: xaxis: "x2", yaxis: "y2"  (top-right)
// trace3: xaxis: "x3", yaxis: "y3"  (bottom-left)
// trace4: xaxis: "x4", yaxis: "y4"  (bottom-right)
```

**Manual domain approach:**
```tsx
layout: {
  xaxis: { domain: [0, 0.45] },
  xaxis2: { domain: [0.55, 1], anchor: "y2" },
  yaxis: { domain: [0, 0.45] },
  yaxis2: { domain: [0.55, 1], anchor: "x2" },
}
```

**Shared axes:** Use `matches: "x"` on secondary axes to lock their range.

## Shapes (Reference Lines, Regions)

```tsx
shapes: [
  // Vertical reference line
  {
    type: "line" as const,
    x0: threshold, x1: threshold,
    y0: 0, y1: 1, yref: "paper" as const,
    line: { color: "#aaa", width: 1, dash: "dot" as const },
  },
  // Horizontal reference line
  {
    type: "line" as const,
    x0: 0, x1: 1, xref: "paper" as const,
    y0: cutoff, y1: cutoff,
    line: { color: "#ef4444", width: 1.5, dash: "dash" as const },
  },
  // Shaded region
  {
    type: "rect" as const,
    x0: start, x1: end,
    y0: 0, y1: 1, yref: "paper" as const,
    fillcolor: "rgba(99, 110, 250, 0.1)",
    line: { width: 0 },
    layer: "below" as const,
  },
]
```

**Coordinate references:**
- Omitted or axis ID (`"x"`, `"y2"`) — data coordinates
- `"paper"` — 0-1 normalized across the plot area

## Annotations

```tsx
annotations: [
  // Floating label (no arrow)
  {
    x: 1.01, xref: "paper" as const,
    y: thresholdValue,
    text: `Threshold = ${thresholdValue}`,
    showarrow: false,
    font: { size: 9, color: "#999" },
    xanchor: "left" as const, yanchor: "middle" as const,
  },
  // Point callout (with arrow)
  {
    x: pointX, y: pointY,
    text: "Label",
    showarrow: true,
    arrowhead: 0, arrowwidth: 0.8, arrowcolor: "#aaa",
    standoff: 4,
    ax: 30, ay: -25,  // arrow tail offset (pixels)
    font: { size: 9, color: "#333", family: "system-ui, -apple-system, sans-serif" },
    bgcolor: "rgba(255,255,255,0.85)",
    borderpad: 1,
  },
]
```

**Stagger multiple annotations:** Offset `ay` by increments (e.g., `-(12 + i * 15)`) to prevent overlap.

## Hover Templates

**Syntax:**
```
%{variable}           — insert value
%{variable:.2f}       — d3 number format
%{variable|%B %d, %Y} — d3 date format
<extra>...</extra>    — secondary box (empty string to suppress)
```

**Available variables:** `%{x}`, `%{y}`, `%{z}`, `%{text}`, `%{marker.size}`, `%{marker.color}`, `%{customdata[i]}`, `%{fullData.name}`, `%{percent}`, `%{label}`, `%{value}`.

**Number formats:** `.2f` (3.14), `.0f` (4), `.2%` (85.60%), `.2s` (12k), `$,.2f` ($1,234.50), `.2e` (4.50e-4), `,` (1,234,567).

**Custom data for rich hover:**
```tsx
{
  x: xValues, y: yValues,
  customdata: data.map(d => [d.name, d.category, d.pvalue]),
  hovertemplate:
    "<b>%{customdata[0]}</b><br>" +
    "Category: %{customdata[1]}<br>" +
    "p-value: %{customdata[2]:.2e}<extra></extra>",
}
```

**Supported HTML:** `<b>`, `<i>`, `<br>`, `<sub>`, `<sup>`.

## Selection and Events

**Selection styling:**
```tsx
{
  selected: { marker: { color: "red", opacity: 1, size: 10 } },
  unselected: { marker: { opacity: 0.2 } },
}
// Enable in layout: dragmode: "lasso" or "select"
```

**Event handler props:**
```tsx
<Plot
  onClick={(e) => {
    // e.points[i].curveNumber, .pointNumber, .x, .y, .customdata
  }}
  onHover={(e) => { /* same structure */ }}
  onSelected={(e) => {
    // e.points — selected points; e.range — { x: [min,max], y: [min,max] }
  }}
  onRelayout={(e) => {
    // e["xaxis.range[0]"], e["xaxis.range[1]"] — new zoom range
  }}
/>
```

Return `false` from `onLegendClick` or `onLegendDoubleClick` to prevent default toggle.
