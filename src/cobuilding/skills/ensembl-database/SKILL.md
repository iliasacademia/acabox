---
name: ensembl-database
description: >
  Query Ensembl REST API for gene/transcript/variant annotations across 300+ species.
  Retrieve gene info by symbol/ID, sequences, cross-references (HGNC, RefSeq, UniProt),
  variant consequence predictions (VEP), regulatory features, and comparative genomics.
  For bulk local access use pyensembl; for pathway lookups use kegg-database.
license: Apache-2.0
source: jaechang-hits/SciAgent-Skills
---

# Ensembl Genome Database

## Running in the container

`requests` is pre-installed in the container. Write Python scripts to the workspace and run via:

```bash
podman exec cobuilding-container python3 ./ensembl_query.py
```

Or inline for simple queries:

```bash
podman exec cobuilding-container python3 -c "
import requests
BASE = 'https://rest.ensembl.org'
r = requests.get(f'{BASE}/lookup/symbol/homo_sapiens/BRCA1',
    headers={'Content-Type': 'application/json'})
print(r.json())
"
```

## Prerequisites

- `requests` — pre-installed in container
- No API key required
- Rate limit: ~15 req/sec; respect with `time.sleep(0.1)` in loops

## Core API

### Gene lookup by symbol
```python
import requests, json
BASE = "https://rest.ensembl.org"

def get_gene(symbol, species="homo_sapiens"):
    r = requests.get(f"{BASE}/lookup/symbol/{species}/{symbol}",
        headers={"Content-Type": "application/json"})
    return r.json()

gene = get_gene("BRCA1")
print(gene["id"], gene["description"])
```

### Batch lookup
```python
r = requests.post(f"{BASE}/lookup/symbol/homo_sapiens",
    headers={"Content-Type": "application/json"},
    data=json.dumps({"symbols": ["BRCA1", "TP53", "EGFR"]}))
genes = r.json()
```

### Sequence retrieval
```python
r = requests.get(f"{BASE}/sequence/id/ENSG00000012048",
    headers={"Content-Type": "application/json"})
seq = r.json()["seq"]
```

### Cross-references (HGNC, RefSeq, UniProt)
```python
r = requests.get(f"{BASE}/xrefs/id/ENSG00000012048",
    headers={"Content-Type": "application/json"})
xrefs = r.json()
```

### Variant consequence prediction (VEP)
```python
variants = [{"hgvs_notation": "9:g.22125504G>C"}]
r = requests.post(f"{BASE}/vep/homo_sapiens/hgvs",
    headers={"Content-Type": "application/json"},
    data=json.dumps({"hgvs_notations": ["9:g.22125504G>C"]}))
```

### Regulatory features
```python
r = requests.get(f"{BASE}/regulatory/species/homo_sapiens/id/ENSR00000082023",
    headers={"Content-Type": "application/json"})
```

### Comparative genomics (homologs)
```python
r = requests.get(f"{BASE}/homology/symbol/homo_sapiens/BRCA1",
    headers={"Content-Type": "application/json"},
    params={"target_species": "mus_musculus"})
```

## Common Workflows

**Gene-to-protein pipeline:**
```python
# 1. Get Ensembl ID from symbol
gene = get_gene("TP53")
ensembl_id = gene["id"]

# 2. Get transcripts
r = requests.get(f"{BASE}/lookup/id/{ensembl_id}?expand=1",
    headers={"Content-Type": "application/json"})
transcripts = r.json()["Transcript"]

# 3. Get UniProt xrefs
r = requests.get(f"{BASE}/xrefs/id/{ensembl_id}?external_db=UniProt%25",
    headers={"Content-Type": "application/json"})
```

## Key Parameters

| Parameter | Values | Notes |
|-----------|--------|-------|
| species | homo_sapiens, mus_musculus, ... | 300+ species supported |
| expand | 0/1 | Include child objects (transcripts, exons) |
| content-type | application/json | Always set this header |
| format | full/condensed | Response verbosity |

## Stable IDs

- Genes: `ENSG00000...`
- Transcripts: `ENST00000...`
- Proteins: `ENSP00000...`
- Assembly: GRCh38 is default; add `?content-type=application/json&assembly_name=GRCh37` for older

## Related Skills

- `gnomad-database` — population variant frequencies
- `clinvar-database` — clinical variant significance
- `kegg-database` — pathway annotation
- `geo-database` — expression datasets
