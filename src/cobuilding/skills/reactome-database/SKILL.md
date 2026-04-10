---
name: reactome-database
description: >
  Query Reactome pathway database via REST API. Retrieve pathway annotations for genes/proteins,
  look up pathway hierarchies, get reaction participants, and perform pathway enrichment analysis.
  Use for mechanistic understanding of gene function, network context, and biological pathway
  analysis downstream of differential expression or variant studies.
license: CC-BY-4.0
source: jaechang-hits/SciAgent-Skills
---

# Reactome Pathway Database

## Running in the container

`requests` and `pandas` are pre-installed in the container. Write scripts to the workspace and execute via:

```bash
podman exec cobuilding-container python3 ./reactome_query.py
```

All output files should be written to relative paths within the workspace (e.g. `./reactome_output/`).

## Prerequisites

- `requests`, `pandas` — pre-installed in container
- No API key required
- Rate limit: ~5 req/sec recommended
- Base URL: `https://reactome.org/ContentService`

## Core Client

```python
import requests

REACTOME_API = "https://reactome.org/ContentService"

def reactome_get(endpoint: str, params: dict = None) -> dict:
    r = requests.get(f"{REACTOME_API}{endpoint}",
                     params=params,
                     headers={"Accept": "application/json"},
                     timeout=30)
    r.raise_for_status()
    return r.json()
```

## Core Queries

### Query pathways for a gene
```python
def get_pathways_for_gene(gene_symbol: str, species: str = "9606") -> list:
    """Return top-level pathways associated with a gene symbol."""
    # First map gene to Reactome ID
    results = reactome_get(f"/search/query", {"query": gene_symbol, "types": "Protein", "cluster": True})
    entries = results.get("results", [])
    if not entries:
        return []
    # Get stable ID of first protein match
    protein_id = entries[0]["entries"][0]["stId"]
    # Retrieve pathways
    pathways = reactome_get(f"/data/pathways/low/entity/{protein_id}/allForms",
                            {"species": species})
    return pathways

pathways = get_pathways_for_gene("TP53")
for p in pathways[:10]:
    print(p["stId"], p["displayName"])
```

### Look up a pathway by stable ID
```python
def get_pathway(pathway_id: str) -> dict:
    """Fetch pathway details by Reactome stable ID (e.g. 'R-HSA-5633007')."""
    return reactome_get(f"/data/query/{pathway_id}")

pathway = get_pathway("R-HSA-5633007")  # Regulation of TP53 Degradation
print(pathway["displayName"])
print(pathway["summation"][0]["text"][:500])
```

### Get pathway participants (proteins/genes in a pathway)
```python
def get_pathway_participants(pathway_id: str) -> list:
    """Return all physical entities (proteins, complexes) in a pathway."""
    return reactome_get(f"/data/participants/{pathway_id}")

participants = get_pathway_participants("R-HSA-5633007")
genes = [p["displayName"] for p in participants if p.get("className") == "Protein"]
print(f"Proteins in pathway: {genes[:20]}")
```

### Get sub-pathways (hierarchy)
```python
def get_pathway_hierarchy(pathway_id: str) -> list:
    """Return child pathways of a parent pathway."""
    data = reactome_get(f"/data/query/{pathway_id}/children")
    return data

children = get_pathway_hierarchy("R-HSA-5663202")  # TP53 regulation
for child in children:
    print(child["stId"], child["displayName"])
```

### Pathway enrichment analysis for a gene list
```python
import json

def pathway_enrichment(gene_list: list, species: int = 9606) -> list:
    """
    Submit gene list for over-representation analysis against Reactome pathways.
    Returns enriched pathways with p-values and FDR.
    """
    r = requests.post(
        "https://reactome.org/AnalysisService/identifiers/projection",
        params={"species": species, "pageSize": 20, "page": 1},
        headers={"Content-Type": "text/plain", "Accept": "application/json"},
        data="\n".join(gene_list),
        timeout=60
    )
    r.raise_for_status()
    result = r.json()
    token = result["summary"]["token"]
    return result["pathways"]

import pandas as pd

gene_list = ["TP53", "MDM2", "CDK2", "CCND1", "RB1", "E2F1", "CDKN1A", "BAX"]
pathways = pathway_enrichment(gene_list)
df = pd.DataFrame(pathways)[["name", "entities", "reactions"]]
df["p_value"] = [p["entities"]["pValue"] for p in pathways]
df["fdr"] = [p["entities"]["fdr"] for p in pathways]
df_sorted = df.sort_values("fdr")
df_sorted.to_csv("./reactome_output/enrichment.csv", index=False)
print(df_sorted[["name", "p_value", "fdr"]].head(10).to_string())
```

### Get reactions in a pathway
```python
def get_reactions(pathway_id: str) -> list:
    return reactome_get(f"/data/pathway/{pathway_id}/containedEvents")

reactions = get_reactions("R-HSA-5633007")
for rxn in reactions[:5]:
    print(rxn["stId"], rxn["displayName"])
```

## Common Reactome Pathway IDs (Human)

| Pathway | ID |
|---------|-----|
| Cell Cycle | R-HSA-1640170 |
| DNA Repair | R-HSA-73894 |
| Apoptosis | R-HSA-109581 |
| TP53 Regulation | R-HSA-5633007 |
| MAPK signaling | R-HSA-5683057 |
| PI3K/AKT signaling | R-HSA-1257604 |
| Immune system | R-HSA-168256 |
| Metabolism | R-HSA-1430728 |

## Related Skills

- `string-database-ppi` — protein interaction partners for pathway context
- `opentargets-database` — target-disease evidence from pathway genes
- `ensembl-database` — gene annotations
- `differential-expression` — identify gene sets for pathway enrichment
