---
name: gnomad-database
description: >
  Query gnomAD v4 population variant frequencies via GraphQL API. Retrieve allele
  counts and frequencies stratified by ancestry group (AFR, AMR, EAS, NFE, SAS, FIN,
  ASJ, MID), gene-level constraint metrics (pLI, LOEUF, missense z-score), and read
  depth coverage. Use for rare variant frequency lookups, variant pathogenicity support,
  and gene constraint analysis.
license: ODbL-1.0
source: jaechang-hits/SciAgent-Skills
---

# gnomAD Database

## Running in the container

gnomAD uses GraphQL (POST-only). Use `podman exec` with curl or Python:

```bash
# curl approach
podman exec cobuilding-container curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"query": "{ gene(gene_symbol: \"BRCA1\", reference_genome: GRCh38) { gnomad_constraint { pLI } } }"}' \
  https://gnomad.broadinstitute.org/api

# Python approach — write script to workspace then run
podman exec cobuilding-container python3 ./gnomad_query.py
```

`requests` and `pandas` are pre-installed in the container.

## Prerequisites

- `requests`, `pandas` — pre-installed in container
- No API key required
- No strict rate limit; add `time.sleep(1)` between queries as courtesy

## Core Client

```python
import requests

GNOMAD_API = "https://gnomad.broadinstitute.org/api"

def gnomad_query(query: str, variables: dict = None) -> dict:
    payload = {"query": query, "variables": variables or {}}
    r = requests.post(GNOMAD_API, json=payload, timeout=30)
    r.raise_for_status()
    return r.json()["data"]
```

## Core Queries

### Variant frequency lookup
```python
query = """
query VariantFreq($variantId: String!) {
  variant(variantId: $variantId, dataset: gnomad_r4) {
    variantId
    chrom pos ref alt
    exome { ac an af }
    genome { ac an af }
    populations {
      id ac an af
    }
  }
}
"""
result = gnomad_query(query, {"variantId": "1-55516888-G-GA"})
```

### Population frequencies
```python
query = """
query PopFreq($variantId: String!) {
  variant(variantId: $variantId, dataset: gnomad_r4) {
    genome {
      populations { id ac an af homozygote_count }
    }
  }
}
"""
```

### Gene constraint
```python
query = """
query Constraint($geneSymbol: String!) {
  gene(gene_symbol: $geneSymbol, reference_genome: GRCh38) {
    gnomad_constraint {
      pLI
      oe_lof oe_lof_lower oe_lof_upper
      lof_z mis_z
      syn_z
    }
  }
}
"""
result = gnomad_query(query, {"geneSymbol": "BRCA1"})
```

### Coverage
```python
query = """
query Coverage($geneId: String!) {
  gene(gene_id: $geneId, reference_genome: GRCh38) {
    coverage(dataset: gnomad_r4) {
      genome { pos mean median over_10 over_20 over_30 }
    }
  }
}
"""
```

### Region variants
```python
query = """
query RegionVars($chrom: String!, $start: Int!, $stop: Int!) {
  region(chrom: $chrom, start: $start, stop: $stop, reference_genome: GRCh38) {
    variants(dataset: gnomad_r4) {
      variantId consequence af { genome }
    }
  }
}
"""
result = gnomad_query(query, {"chrom": "17", "start": 43044295, "stop": 43125483})
```

## Ancestry Groups

| ID | Population |
|----|-----------|
| afr | African/African American |
| amr | Latino/Admixed American |
| eas | East Asian |
| nfe | Non-Finnish European |
| sas | South Asian |
| fin | Finnish |
| asj | Ashkenazi Jewish |
| mid | Middle Eastern |

## Constraint Score Interpretation

| Metric | Description | High = constrained if |
|--------|-------------|----------------------|
| pLI | Prob. of LoF intolerance | > 0.9 |
| LOEUF | LoF observed/expected upper CI | < 0.35 |
| mis_z | Missense z-score | > 3.09 |

## Related Skills

- `ensembl-database` — gene/transcript annotations
- `clinvar-database` — clinical variant classification
- `cbioportal-database` — somatic variant frequencies
