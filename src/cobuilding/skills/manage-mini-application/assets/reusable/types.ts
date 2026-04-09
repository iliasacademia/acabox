export interface VolcanoGene {
  ensembl_id: string;
  symbol: string;
  geneName: string;
  log2FoldChange: number;
  padj: number;
  neglog10p: number;
  baseMean: number;
}

export const COLORS = { up: "#dc4a4a", down: "#4a90d9", ns: "#c4c4c4" } as const;
export const LABELS = {
  up: "Upregulated",
  down: "Downregulated",
  ns: "Not significant",
} as const;

export type Regulation = keyof typeof COLORS;

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
