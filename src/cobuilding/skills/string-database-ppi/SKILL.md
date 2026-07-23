---
name: string-database-ppi
description: >
  Query STRING database for protein-protein interaction (PPI) networks. Retrieve interaction
  partners with confidence scores (combined, experimental, co-expression, database, textmining),
  functional enrichment analysis (GO, KEGG, Reactome), and network data for visualization.
  Use for identifying protein interaction partners, pathway context, and network analysis.
license: CC-BY-4.0
source: jaechang-hits/SciAgent-Skills
---

# STRING Protein Interaction Database

## Running in the container

`requests` and `pandas` are pre-installed in the container. Write scripts to the workspace and execute via:

```bash
python3 ./string_query.py
```

All output files should be written to relative paths within the workspace (e.g. `./string_output/`).

## Prerequisites

- `requests`, `pandas` — pre-installed in container
- No API key required
- Rate limit: ~1 req/sec recommended for bulk queries
- Base URL: `https://string-db.org/api`

## Core Client

```python
import requests

STRING_API = "https://string-db.org/api"

def string_get(endpoint: str, params: dict) -> list:
    """GET request to STRING API. Returns parsed JSON."""
    params.setdefault("format", "json")
    params.setdefault("caller_identity", "acabox")
    r = requests.get(f"{STRING_API}/{endpoint}", params=params, timeout=30)
    r.raise_for_status()
    return r.json()
```

## Core Queries

### Resolve protein identifier to STRING ID
```python
def resolve_protein(name: str, species: int = 9606) -> list:
    """Map gene symbol / protein name to STRING identifiers. species=9606 for human."""
    return string_get("json/get_string_ids", {
        "identifiers": name,
        "species": species,
        "limit": 5,
    })

hits = resolve_protein("TP53")
string_id = hits[0]["stringId"]  # e.g. "9606.ENSP00000269305"
print(string_id, hits[0]["preferredName"])
```

### Get interaction partners
```python
def get_interactions(string_id: str, min_score: int = 400, limit: int = 20) -> list:
    """
    Returns interaction partners sorted by combined score.
    min_score: 0–1000 (400=medium, 700=high, 900=highest)
    """
    return string_get("json/interaction_partners", {
        "identifiers": string_id,
        "species": 9606,
        "required_score": min_score,
        "limit": limit,
    })

interactions = get_interactions("9606.ENSP00000269305", min_score=700)
for i in interactions:
    print(f"{i['preferredName_B']}: combined={i['score']:.3f} "
          f"exp={i['escore']:.3f} db={i['dscore']:.3f}")
```

### Get interaction network for a gene list
```python
def get_network(gene_list: list, species: int = 9606, min_score: int = 400) -> list:
    """Get all interactions within a set of proteins."""
    return string_get("json/network", {
        "identifiers": "%0d".join(gene_list),
        "species": species,
        "required_score": min_score,
    })

genes = ["TP53", "MDM2", "CDK2", "CCND1", "RB1"]
network = get_network(genes)
print(f"Found {len(network)} interactions")
```

### Functional enrichment analysis
```python
def get_enrichment(gene_list: list, species: int = 9606) -> list:
    """
    Returns GO, KEGG, Reactome enrichment for a gene set.
    Each entry: category, term, description, number_of_genes, p_value, fdr
    """
    return string_get("json/enrichment", {
        "identifiers": "%0d".join(gene_list),
        "species": species,
    })

enrichment = get_enrichment(["TP53", "MDM2", "CDK2", "CCND1", "RB1"])
import pandas as pd
df = pd.DataFrame(enrichment)
# Filter GO Biological Process
bp = df[df["category"] == "Process"].sort_values("fdr")
print(bp[["description", "number_of_genes", "fdr"]].head(10))
bp.to_csv("./string_output/enrichment_results.csv", index=False)
```

### Export network as TSV for visualization
```python
def export_network_tsv(gene_list: list, outpath: str = "./string_output/network.tsv") -> str:
    """Download TSV interaction table for import into Cytoscape or NetworkX."""
    import os
    os.makedirs(os.path.dirname(outpath), exist_ok=True)
    params = {
        "identifiers": "%0d".join(gene_list),
        "species": 9606,
        "caller_identity": "acabox",
    }
    r = requests.get(f"{STRING_API}/tsv/network", params=params, timeout=30)
    r.raise_for_status()
    with open(outpath, "w") as f:
        f.write(r.text)
    return outpath

path = export_network_tsv(["BRCA1", "BRCA2", "RAD51", "PALB2", "ATM"])
```

## Interaction Score Channels

| Channel | Field | Description |
|---------|-------|-------------|
| Combined | `score` | Integrated score across all channels |
| Experimental | `escore` | Co-IP, Y2H, pull-down assays |
| Database | `dscore` | Curated pathway databases |
| Co-expression | `ascore` | Correlated mRNA expression |
| Textmining | `tscore` | Literature co-mention |
| Neighborhood | `nscore` | Genomic co-localization |

## Species Codes (common)

| Code | Species |
|------|---------|
| 9606 | Homo sapiens |
| 10090 | Mus musculus |
| 10116 | Rattus norvegicus |
| 7227 | Drosophila melanogaster |
| 6239 | C. elegans |

## Related Skills

- `reactome-database` — pathway context for interaction partners
- `ensembl-database` — gene annotations and IDs
- `opentargets-database` — target-disease associations for interaction partners
- `geo-database` — expression data to support co-expression links
