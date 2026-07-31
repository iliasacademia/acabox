// Acabox chart theme for Plotly.
//
// Charts are the most visually dominant thing in a scientific mini-app, so a
// chart on the stock Plotly palette makes the whole app look foreign no matter
// how carefully the surrounding chrome is styled. This module is the one place
// chart chrome and colour are decided; `ACABOX_LAYOUT` spread into a plot's
// layout replaces about twenty lines of axis/font/background boilerplate.
//
// Plotly takes literal colours, not CSS, so these are hexes rather than
// `var(--cd-*)`. They are the same values as the tokens in
// `_vendor/acabox.css` — keep the two in step.
//
// HOW THE PALETTE WAS CHOSEN. Not by eye. `ACABOX_CATEGORICAL` was run through
// the dataviz validator at `--pairs all` (every pair, not just neighbours) and
// passes all six checks against a light surface:
//
//   lightness band PASS · chroma floor PASS · CVD separation PASS
//   (worst all-pairs #00734E↔#C96A00 ΔE 8.4, protan) · normal-vision floor
//   PASS (worst 15.8) · contrast vs surface PASS (all ≥ 3:1)
//
// A seventh hue was tried and cut: an olive step collided with both the orange
// (ΔE 5.2 protan) and the green (12.2 normal-vision). Six is the honest
// ceiling for this ramp — a 7th series folds into "Other", small multiples, or
// a second encoding. Do not extend the array by picking something that looks
// different; re-run the validator.

/** Fixed hue order. Assign by index, never cycle, never reorder per chart —
 *  colour follows the entity, so a filter that drops a series must not
 *  repaint the survivors. */
export const ACABOX_CATEGORICAL = [
  "#0645b1", // Acabox blue
  "#C96A00", // orange
  "#00734E", // green
  "#4694CB", // sky
  "#B5478F", // magenta
  "#7B4FD8", // violet
] as const;

/** Magnitude. One hue, light → dark, lightness strictly monotonic (checked). */
export const ACABOX_SEQUENTIAL = [
  "#eaf1fb", "#c8daf1", "#9dbbe3", "#6d97cf", "#3a6cba", "#0645b1", "#082f75",
] as const;

/** Plotly colorscale form of the sequential ramp. */
export const ACABOX_SEQUENTIAL_SCALE = ACABOX_SEQUENTIAL.map(
  (c, i) => [i / (ACABOX_SEQUENTIAL.length - 1), c] as [number, string],
);

/** Polarity: two hues either side of a NEUTRAL GRAY midpoint — never a hue at
 *  the middle. The arms are lightness-symmetric to within 0.010 OKLab L, so
 *  neither pole visually outweighs the other. */
export const ACABOX_DIVERGING = [
  "#0645b1", "#4d7fc4", "#a3bde0", "#ebebee", "#e3abab", "#c85555", "#990000",
] as const;

export const ACABOX_DIVERGING_SCALE = ACABOX_DIVERGING.map(
  (c, i) => [i / (ACABOX_DIVERGING.length - 1), c] as [number, string],
);

/**
 * Up / down / not-significant, for volcano, MA and fold-change plots.
 *
 * This is a polarity encoding, so it reuses the diverging poles rather than
 * two categorical hues. The pair separates enormously under simulated CVD
 * (ΔE 25.8 protan, 34.8 normal vision). `ns` is deliberately a desaturated
 * gray and is *out of scope* for the categorical checks — it is a recessive
 * background mark, not a series, and it is meant to fall behind the other two.
 */
export const REGULATION_COLORS = {
  up: "#990000",
  down: "#0645b1",
  ns: "#c7c7cf",
} as const;

/** Token literals, for the places a chart needs one directly (a threshold
 *  line, an annotation) rather than through `ACABOX_LAYOUT`. */
export const ACABOX_INK = "#141413";
export const ACABOX_TEXT2 = "#535366";
export const ACABOX_TEXT3 = "#91919e";
export const ACABOX_BORDER = "#dddde2";
export const ACABOX_BORDER_SOFT = "#ebebee";
export const ACABOX_SURFACE = "#ffffff";

export const ACABOX_SANS = "DM Sans, sans-serif";
export const ACABOX_MONO = "IBM Plex Mono, monospace";

const INK = ACABOX_INK;
const TEXT2 = ACABOX_TEXT2;
const TEXT3 = ACABOX_TEXT3;
const BORDER = ACABOX_BORDER;
const BORDER_SOFT = ACABOX_BORDER_SOFT;

const SANS = ACABOX_SANS;
const MONO = ACABOX_MONO;

/** Axis chrome. Recessive by design: the data is the ink, the frame is not. */
export const ACABOX_AXIS = {
  gridcolor: BORDER_SOFT,
  zerolinecolor: BORDER,
  linecolor: BORDER,
  tickfont: { size: 11, color: TEXT3, family: SANS },
  title: { font: { size: 12, color: TEXT2, family: SANS }, standoff: 12 },
  automargin: true,
} as const;

/**
 * Spread into a plot's `layout`. Per-plot titles and axis ranges go after it:
 *
 *   layout={{ ...ACABOX_LAYOUT,
 *             xaxis: { ...ACABOX_AXIS, title: { text: "log2 FC" } } }}
 *
 * `paper_bgcolor` is transparent so a plot inherits its card; `plot_bgcolor` is
 * white rather than a gray wash — the host's surfaces are white, and a gray
 * plot area is the single most recognisable "generic dashboard" tell.
 */
export const ACABOX_LAYOUT = {
  font: { family: SANS, size: 12, color: INK },
  paper_bgcolor: "transparent",
  plot_bgcolor: "#ffffff",
  colorway: [...ACABOX_CATEGORICAL],
  margin: { l: 60, r: 20, t: 28, b: 52 },
  hoverlabel: {
    bgcolor: "#ffffff",
    bordercolor: BORDER,
    font: { family: SANS, size: 12, color: INK },
  },
  legend: {
    font: { size: 11, color: TEXT2, family: SANS },
    bgcolor: "transparent",
    borderwidth: 0,
  },
  title: { font: { family: SANS, size: 14, color: INK } },
  dragmode: "pan",
} as const;

/** Mono, for tick labels that are ids, accessions or codes rather than numbers. */
export const ACABOX_MONO_TICKFONT = { size: 10, color: TEXT3, family: MONO } as const;

/** Sensible default toolbar. Plotly's full modebar is noise in a small card. */
export const ACABOX_CONFIG = {
  displayModeBar: false,
  displaylogo: false,
  responsive: true,
  scrollZoom: true,
} as const;
