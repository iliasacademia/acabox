---
name: database-lookup
description: >
  Unified gateway to 78 public scientific and economic databases via REST APIs.
  Use when the user asks about genes, proteins, compounds, variants, pathways,
  clinical trials, cancer data, economic indicators, patents, or any public
  scientific dataset. Covers physics, astronomy, chemistry, biology, genomics,
  disease, clinical, regulatory, and economics domains.
license: See source repo K-Dense-AI/scientific-agent-skills
---

# Database Lookup — 78 Public Scientific Databases

## Running in the container

All script execution must go through the Podman container. For curl-based API calls:

```bash
podman exec cobuilding-container curl -s "https://api.example.org/..." | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin), indent=2))"
```

For Python scripts, write the script to the workspace (relative path) then execute:

```bash
podman exec cobuilding-container python3 ./script.py
```

`requests` and `pandas` are pre-installed in the container — no pip install needed.

## Core Workflow

1. **Understand the query** — determine what data is needed (compound, gene, pathway, variant, economic indicator, etc.)
2. **Select database(s)** — use the selection guide below; multiple databases often give better coverage
3. **Make API calls** — use WebFetch (Claude Code native) for GET endpoints; use `podman exec cobuilding-container curl` for POST-only APIs (Open Targets, gnomAD, GDC/TCGA, RummaGEO)
4. **Return results** — provide parsed output and document which databases were queried

## POST-only APIs (must use curl via podman exec)

```bash
# Open Targets GraphQL
podman exec cobuilding-container curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"query": "{ target(ensemblId: \"ENSG00000141736\") { approvedName } }"}' \
  https://api.platform.opentargets.org/api/v4/graphql

# gnomAD GraphQL
podman exec cobuilding-container curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"query": "{ gene(gene_symbol: \"BRCA1\", reference_genome: GRCh38) { gene_id } }"}' \
  https://gnomad.broadinstitute.org/api
```

## Database Selection Guide

| Domain | Databases |
|--------|-----------|
| Chemistry & Drugs | PubChem, ChEMBL, DrugBank, FDA/OpenFDA, DailyMed, KEGG, ChEBI, ZINC, BindingDB |
| Biology & Genomics | UniProt, STRING, Ensembl, NCBI Gene/Protein/Taxonomy, GEO, GTEx, PDB, AlphaFold, InterPro, BioGRID |
| Cancer & Disease | COSMIC, GDC/TCGA, cBioPortal, ClinVar, OMIM, Open Targets, DisGeNET, GWAS Catalog |
| Clinical | ClinicalTrials.gov, ClinPGx, HPO, Monarch |
| Structural Biology | PDB, AlphaFold, EMDB |
| Pathways | KEGG, Reactome, Gene Ontology |
| Variants | gnomAD, dbSNP, ClinVar, ENCODE, JASPAR |
| Economics | FRED, World Bank, BLS, BEA, ECB, US Treasury |
| Earth & Environment | USGS, NOAA, EPA, OpenWeatherMap |
| Patents & Regulatory | USPTO, SEC EDGAR |

## API Keys (optional — improve rate limits)

Check environment or `.env` for: `NCBI_API_KEY`, `FRED_API_KEY`, `NASA_API_KEY`.
Most databases work without keys at lower rate limits.
