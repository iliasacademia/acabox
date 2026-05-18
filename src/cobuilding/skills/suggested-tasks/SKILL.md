---
name: suggested-tasks
description: Manage the collection of suggested tasks and mini-apps shown to the user on their Home tab. Use this skill whenever you want to add, update, reorder, or remove suggestions — or when thinking about what high-impact work you could surface to the researcher.
license: Proprietary
---

# Suggested Tasks

The suggested-tasks collection is your workspace for bringing forward to the user the most important and relevant work you can do to speed up their research. It is a living, curated list — not a one-time dump. As you learn more about the researcher through conversations, file reads, and activity, you should revisit and refine your suggestions to keep them fresh, specific, and high-impact.

Every suggestion you surface should pass a simple test: **would this save the researcher meaningful time, or unlock an insight they couldn't easily get on their own?**

## Suggestion types

There are two types of suggestions:

### One-time tasks (`one_time_task`)

Things the researcher would benefit from but might not think to ask for, or tasks that would take them hours but you can do quickly.

Examples:
- Summarizing or synthesizing a body of literature they have collected
- Creating a structured comparison table across multiple papers or datasets
- Extracting and organizing key findings, methods, or statistics from their documents
- Converting or reformatting files (e.g. reformatting references, converting between data formats)
- Drafting sections of documents based on existing notes or data
- Analyzing patterns across their datasets or experimental results
- Reviewing drafts, grant proposals, or presentations

### Mini-apps (`mini_app`)

Interactive tools built as sandboxed React apps with Plotly charts and file I/O through a bridge API. Good for data explorers, chart generators, statistical dashboards, AI-powered text analyzers, and data transformers.

Do NOT suggest mini-apps that require direct filesystem writes, real-time monitors, or image editing.

## What makes a good suggestion

**Prioritize high-impact.** Think about what would save the researcher the most time or unlock insights they couldn't easily get on their own.

**Tie every suggestion to specifics.** Reference specific files, patterns, or observations from their workspace. Generic suggestions ("organize your files") are weak. Specific suggestions ("synthesize the 23 papers in `papers/topic-X/` into a structured literature review") are strong.

**Maximize variety.** Don't cluster suggestions around one category. Spread them across different angles:

- **Research technique analysis**: Look at the specific techniques and methods the researcher uses (e.g. Western blots, PCR, RNA-seq, regression analysis, finite element modeling) and suggest technique-specific analysis help you could provide.
- **Repetitive workflow automation**: Identify repetitive work patterns in the researcher's files — data formatting, figure generation, protocol documentation, reference management — and suggest mini-apps that could streamline those workflows.
- **Document review and improvement**: Review drafts, grant proposals, or presentations.
- **Literature synthesis**: Summarize or compare bodies of literature they've collected.
- **Data exploration and visualization**: Build interactive dashboards or analysis tools for their datasets.

**Keep suggestions current.** If you learn that a suggestion is no longer relevant (the researcher already did it, or their focus shifted), remove or update it. If a conversation reveals a new opportunity, add it.

## Suggestion fields

Each suggestion has four fields:

| Field | Description |
|-------|-------------|
| `name` | Short display title shown to the user. |
| `type` | Either `one_time_task` or `mini_app`. |
| `why_im_suggesting_this` | 1-2 sentences tying the suggestion to specific files or patterns you found. Shown to the user as context. |
| `description` | A clear, actionable description of what you would do. Reference specific files or file patterns. 2-4 sentences — enough to act on without ambiguity. |

## Examples

Adapt these to what you actually find in the researcher's workspace:

- **Literature synthesis**: `{ name: "Synthesize literature on X", type: "one_time_task", why_im_suggesting_this: "You have 23 PDFs in papers/topic-X/ spanning 2019-2024.", description: "Read all 23 papers in papers/topic-X/, extract key findings and methodologies, and produce a structured literature review organized by theme with a summary table of methods, sample sizes, and main results." }`

- **Technique-specific tool**: `{ name: "Western blot quantification tool", type: "mini_app", why_im_suggesting_this: "Your lab notebook entries and protocols/ folder show you regularly run Western blots and manually quantify band intensities.", description: "Build a mini-app that lets you upload Western blot images, automatically detect and quantify band intensities using densitometry, normalize to loading controls, and export publication-ready bar charts with statistical comparisons." }`

- **Batch processing**: `{ name: "Batch figure formatter", type: "mini_app", why_im_suggesting_this: "You have 40+ figures across 5 manuscript directories, each with inconsistent axis labels, fonts, and color schemes.", description: "Build a mini-app that loads your Plotly/matplotlib figures, lets you set a unified style template (font, colors, axis formatting), previews changes across all figures, and exports publication-ready versions in bulk." }`

- **Research technique analysis**: `{ name: "Analysis help for your research techniques", type: "one_time_task", why_im_suggesting_this: "Your code and data files show you use several research techniques including RNA-seq, qPCR, and cell viability assays.", description: "For each research technique identified in your workflow, provide a detailed breakdown of the analysis steps I can help with — from raw data processing to statistical testing to figure generation — with specific recommendations tied to your existing scripts and datasets." }`

- **Document review**: `{ name: "Review my draft on Y", type: "one_time_task", why_im_suggesting_this: "Your manuscript drafts/paper-Y.docx was recently modified and appears to be a near-complete draft.", description: "Read drafts/paper-Y.docx end-to-end and provide a structured review: assess the argument flow, flag gaps in the literature review, check whether the methods section is reproducible, and suggest specific improvements for clarity and concision." }`

## MCP tools

Use these tools to manage the suggestion collection. All mutations automatically notify the UI so the user sees changes on their Home tab.

### `mcp__suggested-tasks__list_suggestions`

List current suggestions. Returns all suggestions for the workspace ordered by display priority.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | string[] | No | Filter by status: `new`, `opened`, `dismissed`. Omit for all. |

### `mcp__suggested-tasks__create_suggestion`

Create a new suggestion.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Short display title. |
| `type` | string | Yes | `one_time_task` or `mini_app`. |
| `description` | string | Yes | Actionable description (2-4 sentences). |
| `why_im_suggesting_this` | string | No | 1-2 sentences tying to specific files/patterns. |

### `mcp__suggested-tasks__update_suggestion`

Update an existing suggestion's content.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | The suggestion ID to update. |
| `name` | string | No | New display title. |
| `type` | string | No | New type: `one_time_task` or `mini_app`. |
| `description` | string | No | New description. |
| `why_im_suggesting_this` | string | No | New rationale. |

### `mcp__suggested-tasks__reorder_suggestions`

Set the display order of suggestions. Pass all suggestion IDs in the desired order. Suggestions not included keep their current position but sort after the explicitly ordered ones.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `ordered_ids` | string[] | Yes | Suggestion IDs in desired display order. |

### `mcp__suggested-tasks__delete_suggestion`

Remove a suggestion.

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | The suggestion ID to delete. |
