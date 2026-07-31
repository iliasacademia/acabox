export interface VolcanoGene {
  ensembl_id: string;
  symbol: string;
  geneName: string;
  log2FoldChange: number;
  padj: number;
  neglog10p: number;
  baseMean: number;
}

// Re-exported from the chart theme so there is exactly one definition of the
// up/down/ns polarity colours. Kept under this name because existing apps
// import `COLORS` from `@reusable/types`.
export { REGULATION_COLORS as COLORS } from "./plotTheme";
import { REGULATION_COLORS } from "./plotTheme";
export const LABELS = {
  up: "Upregulated",
  down: "Downregulated",
  ns: "Not significant",
} as const;

export type Regulation = keyof typeof REGULATION_COLORS;

export const classifyGene = (
  gene: VolcanoGene,
  lfcThreshold: number,
  alpha: number,
): Regulation => {
  if (gene.padj >= alpha || Number.isNaN(gene.padj)) return "ns";
  if (gene.log2FoldChange >= lfcThreshold) return "up";
  if (gene.log2FoldChange <= -lfcThreshold) return "down";
  return "ns";
};
