---
name: pdb-database
description: >
  Query the RCSB Protein Data Bank for experimental 3D protein/nucleic acid structures.
  Search by gene, organism, resolution, or method (X-ray, cryo-EM, NMR). Download PDB/mmCIF
  structure files, retrieve ligand binding sites, assembly info, and sequence annotations.
  Use for structural biology, drug binding analysis, and comparison with AlphaFold predictions.
license: CC0
source: jaechang-hits/SciAgent-Skills
---

# RCSB Protein Data Bank (PDB)

## Running in the container

`requests`, `pandas`, and `rcsb-api` are pre-installed in the container. Write scripts to the workspace and execute via:

```bash
podman exec cobuilding-container python3 ./pdb_query.py
```

All output files should be written to relative paths within the workspace (e.g. `./pdb_output/`).

## Prerequisites

- `requests`, `pandas`, `rcsb-api` — pre-installed in container
- No API key required
- REST API: `https://data.rcsb.org/rest/v1/`
- Search API: `https://search.rcsb.org/rcsbsearch/v2/query`

## Core Client

```python
import requests

RCSB_DATA = "https://data.rcsb.org/rest/v1/core"
RCSB_SEARCH = "https://search.rcsb.org/rcsbsearch/v2/query"

def rcsb_search(query_dict: dict) -> list:
    """Submit a JSON search query; returns list of PDB IDs."""
    r = requests.post(RCSB_SEARCH, json=query_dict, timeout=30)
    r.raise_for_status()
    return [hit["identifier"] for hit in r.json().get("result_set", [])]
```

## Core Queries

### Search by gene name
```python
query = {
    "query": {
        "type": "terminal",
        "service": "text",
        "parameters": {
            "attribute": "rcsb_entity_source_organism.rcsb_gene_name.value",
            "operator": "exact_match",
            "value": "BRCA1"
        }
    },
    "return_type": "entry",
    "request_options": {"results_verbosity": "compact", "paginate": {"start": 0, "rows": 10}}
}
ids = rcsb_search(query)
print(ids)  # e.g. ['1JNX', '1T29', ...]
```

### Search by UniProt ID
```python
query = {
    "query": {
        "type": "terminal",
        "service": "text",
        "parameters": {
            "attribute": "rcsb_polymer_entity_container_identifiers.reference_sequence_identifiers.database_accession",
            "operator": "exact_match",
            "value": "P38398"  # BRCA1 UniProt
        }
    },
    "return_type": "entry",
    "request_options": {"results_verbosity": "compact"}
}
ids = rcsb_search(query)
```

### Fetch entry metadata
```python
def get_entry(pdb_id: str) -> dict:
    r = requests.get(f"{RCSB_DATA}/entry/{pdb_id}", timeout=15)
    r.raise_for_status()
    return r.json()

entry = get_entry("7NHP")
print(entry["rcsb_entry_info"]["resolution_combined"])
print(entry["rcsb_entry_info"]["experimental_method"])
print(entry["struct"]["title"])
```

### Fetch polymer entity (chain) info
```python
def get_entity(pdb_id: str, entity_id: str = "1") -> dict:
    r = requests.get(f"{RCSB_DATA}/polymer_entity/{pdb_id}/{entity_id}", timeout=15)
    r.raise_for_status()
    return r.json()

entity = get_entity("7NHP")
print(entity["rcsb_entity_source_organism"])
```

### Download structure file
```python
import os

def download_structure(pdb_id: str, fmt: str = "pdb", outdir: str = "./pdb_structures/") -> str:
    """Download structure. fmt: 'pdb' or 'cif'."""
    os.makedirs(outdir, exist_ok=True)
    pdb_id = pdb_id.upper()
    if fmt == "pdb":
        url = f"https://files.rcsb.org/download/{pdb_id}.pdb"
    else:
        url = f"https://files.rcsb.org/download/{pdb_id}.cif"
    outpath = os.path.join(outdir, f"{pdb_id}.{fmt}")
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    with open(outpath, "wb") as f:
        f.write(r.content)
    return outpath

path = download_structure("7NHP")
```

### List ligands in a structure
```python
def get_ligands(pdb_id: str) -> list:
    r = requests.get(f"{RCSB_DATA}/entry/{pdb_id}", timeout=15)
    data = r.json()
    nonpoly = data.get("rcsb_entry_container_identifiers", {}).get("non_polymer_entity_ids", [])
    ligands = []
    for eid in nonpoly:
        e = requests.get(f"{RCSB_DATA}/nonpolymer_entity/{pdb_id}/{eid}", timeout=15).json()
        ligands.append({
            "id": eid,
            "name": e.get("pdbx_entity_nonpoly", {}).get("name"),
            "comp_id": e.get("pdbx_entity_nonpoly", {}).get("comp_id"),
        })
    return ligands

print(get_ligands("7NHP"))
```

## Search by Method and Resolution

```python
# Find high-resolution cryo-EM structures of a protein
query = {
    "query": {
        "type": "group",
        "logical_operator": "and",
        "nodes": [
            {
                "type": "terminal",
                "service": "text",
                "parameters": {
                    "attribute": "rcsb_entry_info.experimental_method",
                    "operator": "exact_match",
                    "value": "EM"
                }
            },
            {
                "type": "terminal",
                "service": "text",
                "parameters": {
                    "attribute": "rcsb_entry_info.resolution_combined",
                    "operator": "less_or_equal",
                    "value": 3.0
                }
            }
        ]
    },
    "return_type": "entry"
}
```

## Related Skills

- `alphafold-database-access` — predicted structures for comparison
- `ensembl-database` — gene/protein annotations
- `gnomad-database` — map population variants onto structure
