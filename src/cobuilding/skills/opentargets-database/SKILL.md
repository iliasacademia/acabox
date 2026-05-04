---
name: opentargets-database
description: >
  Query Open Targets Platform GraphQL API for target-disease associations, drug-target evidence,
  genetic associations (GWAS/COLOC), expression data, and safety liabilities. Use for drug
  target validation, disease mechanism research, and connecting genomic variants to disease.
  Covers targets, diseases, drugs, and evidence from genetics, genomics, and literature.
license: Apache-2.0
source: jaechang-hits/SciAgent-Skills
---

# Open Targets Platform

## Running in the container

Open Targets uses GraphQL (POST-only). Write scripts to the workspace and execute via:

```bash
python3 ./opentargets_query.py
```

Or for quick one-off queries:

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"query": "{ target(ensemblId: \"ENSG00000141736\") { approvedName } }"}' \
  https://api.platform.opentargets.org/api/v4/graphql
```

`requests` and `pandas` are pre-installed in the container.

## Prerequisites

- `requests`, `pandas` — pre-installed in container
- No API key required
- Rate limit: generous; no explicit limit for reasonable usage

## Core Client

```python
import requests

OT_API = "https://api.platform.opentargets.org/api/v4/graphql"

def ot_query(query: str, variables: dict = None) -> dict:
    payload = {"query": query, "variables": variables or {}}
    r = requests.post(OT_API, json=payload, timeout=30)
    r.raise_for_status()
    return r.json()["data"]
```

## Core Queries

### Target info by Ensembl ID
```python
query = """
query Target($ensemblId: String!) {
  target(ensemblId: $ensemblId) {
    id
    approvedSymbol
    approvedName
    biotype
    functionDescriptions
    tractability {
      label
      modality
      value
    }
  }
}
"""
result = ot_query(query, {"ensemblId": "ENSG00000141736"})  # ERBB2/HER2
print(result["target"]["approvedName"])
```

### Target-disease associations (top diseases for a target)
```python
query = """
query TargetDiseases($ensemblId: String!, $size: Int!) {
  target(ensemblId: $ensemblId) {
    approvedSymbol
    associatedDiseases(orderByScore: "score", page: {index: 0, size: $size}) {
      count
      rows {
        disease { id name }
        score
        datatypeScores { componentId score }
      }
    }
  }
}
"""
result = ot_query(query, {"ensemblId": "ENSG00000141736", "size": 10})
for row in result["target"]["associatedDiseases"]["rows"]:
    print(f"{row['disease']['name']}: {row['score']:.3f}")
```

### Disease-target associations (top targets for a disease)
```python
query = """
query DiseaseTargets($efoId: String!, $size: Int!) {
  disease(efoId: $efoId) {
    id
    name
    associatedTargets(page: {index: 0, size: $size}) {
      count
      rows {
        target { id approvedSymbol approvedName }
        score
      }
    }
  }
}
"""
# EFO_0000305 = breast carcinoma
result = ot_query(query, {"efoId": "EFO_0000305", "size": 10})
for row in result["disease"]["associatedTargets"]["rows"]:
    print(f"{row['target']['approvedSymbol']}: {row['score']:.3f}")
```

### Known drugs for a target
```python
query = """
query KnownDrugs($ensemblId: String!) {
  target(ensemblId: $ensemblId) {
    approvedSymbol
    knownDrugs(size: 20) {
      count
      rows {
        drug { id name maximumClinicalTrialPhase }
        diseaseFromSource { name }
        mechanismOfAction
        phase
        status
      }
    }
  }
}
"""
result = ot_query(query, {"ensemblId": "ENSG00000141736"})
for row in result["target"]["knownDrugs"]["rows"]:
    print(f"{row['drug']['name']} — Phase {row['phase']} — {row['mechanismOfAction']}")
```

### Genetic evidence (GWAS / colocalisation)
```python
query = """
query GeneticEvidence($ensemblId: String!, $efoId: String!) {
  disease(efoId: $efoId) {
    evidences(
      ensemblIds: [$ensemblId]
      enableIndirect: true
      datasourceIds: ["gwas_credible_sets", "gene_burden"]
      size: 10
    ) {
      rows {
        score
        studyId
        variantId
        pValueMantissa
        pValueExponent
        beta
      }
    }
  }
}
"""
result = ot_query(query, {
    "ensemblId": "ENSG00000141736",
    "efoId": "EFO_0000305"
})
```

### Target safety liabilities
```python
query = """
query Safety($ensemblId: String!) {
  target(ensemblId: $ensemblId) {
    approvedSymbol
    safetyLiabilities {
      event
      eventId
      effects { direction dosing }
      datasources { name }
    }
  }
}
"""
result = ot_query(query, {"ensemblId": "ENSG00000141736"})
```

## Disease ID Format

Open Targets uses EFO (Experimental Factor Ontology) IDs:
- `EFO_0000305` — breast carcinoma
- `EFO_0001187` — colorectal cancer
- `EFO_0000400` — diabetes mellitus
- `MONDO_0007254` — breast cancer (MONDO)
- Search diseases: use the `search` query or browse `platform.opentargets.org`

## Related Skills

- `ensembl-database` — gene/Ensembl ID lookup
- `gnomad-database` — variant population frequencies
- `clinvar-database` — clinical variant significance (if available)
- `reactome-database` — pathway context for targets
