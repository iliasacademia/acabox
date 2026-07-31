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

Import `Plot` from `"react-plotly.js"` (already installed in Acabox's shared npm prefix along with `plotly.js` — no install wrapper call needed).

```tsx
import Plot from "react-plotly.js";
```

**Detailed references:**
- **Trace types** (scatter, bar, heatmap, histogram, box, violin, pie, bubble): See [reference/trace-types.md](reference/trace-types.md)
- **Layout, axes, shapes, annotations, hover templates**: See [reference/layout-and-axes.md](reference/layout-and-axes.md)
- **Complete examples**: See [examples/grouped-bar-chart.tsx](examples/grouped-bar-chart.tsx) and [examples/heatmap.tsx](examples/heatmap.tsx)

## Project Standard Config

Import it — do not retype it:

```tsx
import { ACABOX_CONFIG } from "@reusable/plotTheme";
```

`ACABOX_CONFIG` hides the modebar and the Plotly logo, and turns on `responsive`
and `scrollZoom`. It is a stable module-level reference, so it needs no
`useMemo`.

## Responsive Container Pattern

Every chart component must follow this pattern:

```tsx
import React, { useRef, useEffect, useState, useMemo } from "react";
import Plot from "react-plotly.js";
import { ACABOX_LAYOUT, ACABOX_AXIS, ACABOX_CONFIG } from "@reusable/plotTheme";

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
    ...ACABOX_LAYOUT,
    autosize: true,
    xaxis: { ...ACABOX_AXIS, title: { text: "X label" } },
    yaxis: { ...ACABOX_AXIS, title: { text: "Y label" } },
    datarevision: revision,
  }), [revision]);

  return (
    <div ref={containerRef} style={{ width: "100%", aspectRatio: "4 / 3" }}>
      <Plot
        data={plotData}
        layout={layout}
        config={ACABOX_CONFIG}
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
- Wrap `data` and `layout` in `useMemo` (`ACABOX_CONFIG` is already a stable reference)
- Wrap exported component in `React.memo`

## Visual Design System

**Do not hand-write chart chrome, and do not choose chart colours.** Everything
below is exported from `@reusable/plotTheme`; importing it is both less code and
the only way a chart stays in step with the app when the palette moves.

```tsx
import {
  ACABOX_LAYOUT, ACABOX_AXIS, ACABOX_CONFIG,
  ACABOX_CATEGORICAL, ACABOX_SEQUENTIAL_SCALE, ACABOX_DIVERGING_SCALE,
  REGULATION_COLORS, ACABOX_TEXT3,
} from "@reusable/plotTheme";

const layout = useMemo(() => ({
  ...ACABOX_LAYOUT,
  xaxis: { ...ACABOX_AXIS, title: { text: "Base mean (log10)" } },
  yaxis: { ...ACABOX_AXIS, title: { text: "log2 fold change" } },
  datarevision: revision,
}), [revision]);
```

`ACABOX_LAYOUT` sets the font (DM Sans), a transparent paper background, a
**white** plot area, the categorical `colorway`, hover labels, legend and title
styling. `ACABOX_AXIS` sets grid, zero-line, axis-line and tick colours from the
tokens. `ACABOX_CONFIG` hides the modebar and enables responsive + scroll-zoom.

Override per chart only what the chart actually needs — a range, a title, a
legend position. Do not re-specify colours you have just imported.

### What the theme sets, and why

| | Value | Why |
|---|---|---|
| Font | DM Sans 12 | The app's own typeface. `system-ui` is the loudest "this isn't Acabox" tell there is. |
| `paper_bgcolor` | `transparent` | Inherits the card it sits in. |
| `plot_bgcolor` | `#ffffff` | Acabox surfaces are white. A gray plot wash is the classic generic-dashboard look. |
| Grid | `#ebebee` | Recessive. The data is the ink; the frame is not. |
| Axis line / zero line | `#dddde2` | Same hairline as every border in the app. |
| Tick labels | `#91919e` 11px | The meta step of the ink ramp. |
| Axis titles | `#535366` 12px | The secondary step. |
| Margins | `l 60 r 20 t 28 b 52` | Small top margin — put the chart's heading in HTML above it (`ab-label`), not in Plotly. Raise `b` when the legend sits below. |

Use `ACABOX_MONO_TICKFONT` for tick labels that are accessions, ids or codes
rather than numbers.

## Color Palettes

All four palettes come from `@reusable/plotTheme`. **Pick by the job the colour
is doing**, which is the only decision left to make:

| Job | Use | Note |
|---|---|---|
| Identity (series, groups) | `ACABOX_CATEGORICAL` — already the `colorway` | Assign in fixed order, never cycle |
| Magnitude (heatmap, density) | `ACABOX_SEQUENTIAL_SCALE` | One hue, light → dark |
| Polarity (signed change) | `ACABOX_DIVERGING_SCALE` | Two hues, **neutral gray** midpoint |
| Up/down/ns (bioinformatics) | `REGULATION_COLORS` | Reuses the diverging poles |

```tsx
// magnitude
<Plot data={[{ type: "heatmap", z, colorscale: ACABOX_SEQUENTIAL_SCALE }]} />

// polarity — zmid pins the neutral to zero, or the ramp lies about the sign
<Plot data={[{ type: "heatmap", z, colorscale: ACABOX_DIVERGING_SCALE, zmid: 0 }]} />
```

### Six hues is a hard ceiling

`ACABOX_CATEGORICAL` has six entries and that is not an oversight. The palette
was validated pairwise — every pair, not just neighbours — for colourblind
separation, normal-vision separation, chroma, lightness and contrast against a
white surface. It passes all six checks (worst all-pairs CVD ΔE 8.4, protan).

A seventh hue was tried and cut: an olive step collided with the orange
(ΔE 5.2 protan) and with the green (12.2 normal vision — below the floor where
a full-colour reader can tell them apart).

**So a 7th series is never a new colour.** Fold the tail into "Other", switch to
small multiples, or add a second encoding (dash pattern, marker shape). If you
genuinely need to extend the ramp, re-run the validator in the `dataviz` skill
rather than picking something that looks different.

### Rules that hold regardless of palette

- **Never a dual-axis chart.** Two measures of different scale → two charts,
  small multiples, or index both to a common base.
- **Colour follows the entity, never its rank.** A filter that removes a series
  must not repaint the survivors — key the colour off a stable id, not the
  array index of the filtered set.
- **Never a rainbow scale**, and never a hue at a diverging midpoint.
- **Text wears text tokens, not the series colour.** Values and labels stay in
  the ink ramp; the coloured mark beside them carries the identity.
- **Two or more series always get a legend**, so identity is never colour-alone.
  A single series needs none — the heading names it.

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
