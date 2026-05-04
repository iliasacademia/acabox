---
name: geo-database
description: >
  Query NCBI Gene Expression Omnibus (GEO) for gene expression datasets and sample
  metadata. Search for studies by gene, condition, tissue, or platform. Download and
  parse GSE series files (microarray, RNA-seq, ChIP-seq, proteomics). Use to find
  expression datasets for a gene of interest or to retrieve raw data for downstream
  analysis with the differential-expression skill.
license: MIT
source: jaechang-hits/SciAgent-Skills
---

# GEO Gene Expression Omnibus

## Running in the container

`GEOparse`, `requests`, and `pandas` are pre-installed in the container. Write scripts to the workspace and execute via:

```bash
python3 ./geo_query.py
```

All output files should be written to relative paths within the workspace (e.g. `./geo_output/`).

## Prerequisites

- `GEOparse`, `requests`, `pandas` — pre-installed in container
- No API key required (10 req/sec with free NCBI key via `NCBI_API_KEY` env var)

## Core API

### Search GEO via E-utilities
```python
import requests

def search_geo(query: str, retmax: int = 20) -> list:
    """Search GEO datasets by keyword."""
    url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi"
    params = {
        "db": "gds",
        "term": query,
        "retmax": retmax,
        "retmode": "json",
    }
    r = requests.get(url, params=params)
    ids = r.json()["esearchresult"]["idlist"]
    return ids

ids = search_geo("BRCA1 breast cancer RNA-seq")
```

### Fetch dataset summary
```python
def fetch_geo_summary(ids: list) -> dict:
    url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi"
    params = {"db": "gds", "id": ",".join(ids), "retmode": "json"}
    r = requests.get(url, params=params)
    return r.json()["result"]

summary = fetch_geo_summary(ids[:5])
for uid, record in summary.items():
    if uid == "uids":
        continue
    print(record.get("accession"), record.get("title"))
```

### Download and parse GEO series with GEOparse
```python
import GEOparse

# Downloads to current working directory (use relative path within workspace)
gse = GEOparse.get_GEO(geo="GSE85217", destdir="./geo_data/")

# Access expression matrix
print(gse.gsms)          # dict of GSM sample objects
print(gse.gpls)          # dict of GPL platform objects

# Get expression data for one sample
sample = list(gse.gsms.values())[0]
print(sample.table.head())   # expression values
print(sample.metadata)        # sample metadata
```

### Extract expression matrix across all samples
```python
import pandas as pd

def get_expression_matrix(gse) -> pd.DataFrame:
    """Pivot all GSM tables into genes x samples matrix."""
    frames = {}
    for gsm_name, gsm in gse.gsms.items():
        frames[gsm_name] = gsm.table.set_index("ID_REF")["VALUE"]
    return pd.DataFrame(frames)

matrix = get_expression_matrix(gse)
matrix.to_csv("./geo_output/expression_matrix.csv")
```

### Direct FTP download for large datasets
```python
import urllib.request

accession = "GSE85217"
url = f"https://ftp.ncbi.nlm.nih.gov/geo/series/GSE85nnn/{accession}/matrix/{accession}_series_matrix.txt.gz"
urllib.request.urlretrieve(url, f"./geo_data/{accession}_matrix.txt.gz")
```

## GEO Record Types

| Type | Prefix | Description |
|------|--------|-------------|
| Series | GSE | Complete experiment with all samples |
| Sample | GSM | Individual sample measurement |
| Platform | GPL | Array/sequencing platform definition |
| Dataset | GDS | Curated, re-annotated version of a GSE |

## Common Workflow: Prepare data for DE analysis

```python
import GEOparse, pandas as pd

# 1. Download series
gse = GEOparse.get_GEO("GSE85217", destdir="./geo_data/")

# 2. Build expression matrix
matrix = get_expression_matrix(gse)

# 3. Extract sample metadata (condition labels)
metadata = pd.DataFrame({
    gsm_name: gsm.metadata
    for gsm_name, gsm in gse.gsms.items()
}).T

# 4. Save for differential-expression skill
matrix.to_csv("./raw_counts.csv")
metadata[["sample_id", "condition"]].to_csv("./sample_annotations.csv", index=False)
# → Then run the differential-expression skill on these outputs
```

## Best Practices

- Use `destdir` with a relative workspace path to keep downloads within the workspace
- GEOparse caches downloads — re-running on the same GSE is fast
- For RNA-seq GSEs, confirm raw vs. normalized counts in the series metadata before using for DESeq2
- Large series (>100 samples) are faster via FTP direct download

## Related Skills

- `differential-expression` — run DESeq2 on counts downloaded from GEO
- `ensembl-database` — annotate genes from Ensembl IDs found in GEO platforms
- `pubmed-database` — find the paper associated with a GSE accession
