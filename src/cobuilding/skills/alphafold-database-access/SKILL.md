---
name: alphafold-database-access
description: >
  Retrieve predicted protein structures from AlphaFold DB (EMBL-EBI) by UniProt accession.
  Download structure files (PDB, mmCIF, PAE JSON), retrieve per-residue confidence (pLDDT)
  scores, and access predicted aligned error matrices for multi-domain analysis. Use for
  structural biology, binding site prediction, and cross-species structure comparison.
license: CC-BY-4.0
source: jaechang-hits/SciAgent-Skills
---

# AlphaFold Database Access

## Running in the container

`requests` and `pandas` are pre-installed in the container. Write scripts to the workspace and execute via:

```bash
python3 ./alphafold_query.py
```

All output files should be written to relative paths within the workspace (e.g. `./alphafold_output/`).

## Prerequisites

- `requests`, `pandas` — pre-installed in container
- No API key required
- Rate limit: be courteous; add `time.sleep(0.5)` between bulk requests

## Core Client

```python
import requests

ALPHAFOLD_API = "https://alphafold.ebi.ac.uk/api"

def get_alphafold_entry(uniprot_id: str) -> dict:
    """Fetch AlphaFold entry metadata for a UniProt accession."""
    r = requests.get(f"{ALPHAFOLD_API}/prediction/{uniprot_id}", timeout=30)
    r.raise_for_status()
    return r.json()[0]  # returns list; first entry is latest model
```

## Core Queries

### Fetch entry metadata
```python
entry = get_alphafold_entry("P04637")  # TP53
print(entry["uniprotId"])
print(entry["modelCreatedDate"])
print(entry["latestVersion"])
print(entry["pdbUrl"])       # PDB download URL
print(entry["cifUrl"])       # mmCIF download URL
print(entry["paeDocUrl"])    # PAE JSON URL
```

### Download PDB structure
```python
import os

def download_structure(uniprot_id: str, fmt: str = "pdb", outdir: str = "./alphafold_structures/") -> str:
    """Download AlphaFold structure file. fmt: 'pdb' or 'cif'."""
    os.makedirs(outdir, exist_ok=True)
    entry = get_alphafold_entry(uniprot_id)
    url = entry["pdbUrl"] if fmt == "pdb" else entry["cifUrl"]
    outpath = os.path.join(outdir, f"AF-{uniprot_id}-F1-model_v4.{fmt}")
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    with open(outpath, "wb") as f:
        f.write(r.content)
    return outpath

pdb_path = download_structure("P04637")
print(f"Saved to {pdb_path}")
```

### Download PAE (Predicted Aligned Error) matrix
```python
import json

def download_pae(uniprot_id: str, outdir: str = "./alphafold_structures/") -> dict:
    """Download PAE JSON for inter-domain confidence analysis."""
    os.makedirs(outdir, exist_ok=True)
    entry = get_alphafold_entry(uniprot_id)
    r = requests.get(entry["paeDocUrl"], timeout=60)
    r.raise_for_status()
    data = r.json()[0]
    outpath = os.path.join(outdir, f"AF-{uniprot_id}-PAE.json")
    with open(outpath, "w") as f:
        json.dump(data, f)
    return data

pae = download_pae("P04637")
print(f"PAE matrix shape: {len(pae['predicted_aligned_error'])} x {len(pae['predicted_aligned_error'][0])}")
```

### Extract pLDDT confidence scores from PDB
```python
def extract_plddt(pdb_path: str) -> list:
    """Extract per-residue pLDDT from ATOM records (stored in B-factor column)."""
    plddt = []
    seen = set()
    with open(pdb_path) as f:
        for line in f:
            if line.startswith("ATOM"):
                resnum = int(line[22:26].strip())
                if resnum not in seen:
                    seen.add(resnum)
                    plddt.append(float(line[60:66].strip()))
    return plddt

scores = extract_plddt(pdb_path)
import pandas as pd
df = pd.DataFrame({"residue": range(1, len(scores)+1), "pLDDT": scores})
df.to_csv("./alphafold_structures/plddt_scores.csv", index=False)
print(df.describe())
```

### Batch retrieval for multiple proteins
```python
import time

def batch_download(uniprot_ids: list, outdir: str = "./alphafold_structures/") -> dict:
    results = {}
    for uid in uniprot_ids:
        try:
            path = download_structure(uid, outdir=outdir)
            results[uid] = {"status": "ok", "path": path}
        except Exception as e:
            results[uid] = {"status": "error", "error": str(e)}
        time.sleep(0.5)
    return results

results = batch_download(["P04637", "P38398", "O15350"])  # TP53, BRCA1, TP63
```

## pLDDT Confidence Scale

| pLDDT | Confidence |
|-------|------------|
| > 90 | Very high — backbone reliable |
| 70–90 | Confident |
| 50–70 | Low — treat with caution |
| < 50 | Very low — disordered/unreliable |

## Related Skills

- `pdb-database` — experimental PDB structures for comparison
- `ensembl-database` — gene/protein ID mapping (UniProt ↔ Ensembl)
- `gnomad-database` — map variants onto predicted structure positions
