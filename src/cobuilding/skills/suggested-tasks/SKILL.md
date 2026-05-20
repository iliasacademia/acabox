---
name: suggested-tasks
description: Manage the collection of suggested tasks and mini-apps shown to the user on their Home tab. Use this skill whenever you want to add, update, reorder, or remove suggestions — or when thinking about what compelling capabilities you could showcase to the researcher.
license: Proprietary
---

# Suggested Tasks

The suggested-tasks collection is how you show researchers what an AI agent can actually do for them. Most of your users are academic researchers whose AI experience is limited to chatbots like free ChatGPT. They don't know that an AI can build them custom interactive software, perform deep multi-document analysis, or create tailored research tools — all based on their specific files and data. Your suggestions should make them think: **"I didn't know I could ask for that!"**

This is a living, curated list — not a one-time dump. As you learn more about the researcher through conversations, file reads, and activity, you should revisit and refine your suggestions to keep them fresh, specific, and compelling.

Every suggestion you surface should pass this test: **would a researcher who has only used ChatGPT be impressed by what you're offering?** Sometimes the concept itself is surprising (building them custom software). Other times the concept is familiar but the depth is what impresses — like reviewing a grant proposal not just for grammar, but by cross-referencing every claim against the cited papers and checking alignment with the funder's stated priorities. Either way, avoid shallow suggestions that feel like basic chatbot work (summarize this text, fix my grammar, answer a question about this paper).

## Suggestion types

There are two types of suggestions:

### One-time tasks (`one_time_task`)

Work that would take the researcher hours or days but you can do thoroughly and quickly. The best one-time tasks go far beyond simple summarization — think structured cross-document analysis, systematic extraction, and synthesis that produces genuinely new insight.

Examples:
- Synthesizing a collection of papers into a structured literature review with themes, methodology comparisons, and gap analysis
- Performing a systematic comparison across datasets or experimental results, identifying patterns the researcher may not have noticed
- Extracting and cross-referencing methods, statistical approaches, and key findings across dozens of papers
- Analyzing a draft manuscript against the cited literature to identify unsupported claims or missing citations
- Reviewing a grant proposal for logical flow, significance framing, and alignment with funder priorities
- Reformatting and deduplicating a large reference collection into a consistent citation style

### Mini-apps (`mini_app`)

Custom interactive software built specifically for the researcher's data and workflow. This is your most powerful suggestion type — most researchers have never had anyone build them a tailored tool before.

Mini-apps are React apps with these capabilities:

- **Interactive visualizations** with Plotly (charts, plots, heatmaps, 3D surfaces, etc.)
- **File input** — users can select files from their workspace via file pickers (CSVs, text files, data files)
- **File output** — apps can write results to an output directory and offer downloads
- **R and Python computation** — apps can have a backing Jupyter notebook that runs R or Python code (statistical analysis, data processing, bioinformatics pipelines, machine learning) with results displayed in the interactive UI
- **AI-powered features** — apps can call Claude to analyze text, classify data, extract information, or provide interactive AI assistance within the tool
- **Persistent state** — user settings and selected files are preserved across sessions

This means you can suggest mini-apps that do real computation — run statistical tests in R, process data with pandas, fit models with scikit-learn — and present the results in an interactive UI. The researcher doesn't need to know how to code; they just use the tool.

Do NOT suggest mini-apps that require real-time monitors or image editing.

## Only suggest what you can actually deliver

Before suggesting something, think through whether you can actually build or do it. A suggestion that excites the user but can't be delivered is worse than no suggestion at all.

**Mini-app feasibility checklist:**
- Can the data be read as text (CSV, TSV, JSON, XML, plain text)? If it requires parsing binary formats (HDF5, proprietary instrument formats, .mat files), you probably can't build it unless there's a Python/R library that handles the format.
- Does the analysis require specialized packages? You can install Python (pip) and R packages, so most statistical and data science libraries are available (pandas, scikit-learn, BiocManager packages, ggplot2, etc.). But very large or complex toolchains (deep learning with GPU, genome aligners, molecular dynamics) may not be practical.
- Does it need real-time data, external API access, or hardware integration? If yes, don't suggest it — mini-apps run in a sandboxed environment.
- Can the visualization be done with Plotly? Plotly covers charts, scatter plots, heatmaps, 3D surfaces, statistical plots, and more. If the visualization requires custom WebGL, complex animations, or specialized rendering, it may not be feasible.

**One-time task feasibility checklist:**
- Can you read and understand the files? You can read text files, PDFs, CSVs, and code. You cannot read binary data files, images, or proprietary formats.
- Is the task within your analytical capabilities? You're good at synthesis, comparison, extraction, and structured analysis across documents. You're not a substitute for running actual experiments or computations on raw data — that's what mini-apps are for.
- Can you produce a useful output in a single pass? One-time tasks should produce a complete, actionable deliverable — not a partial analysis that requires back-and-forth.

## What makes a good suggestion

**Lead with what's surprising.** The best suggestions showcase capabilities the researcher didn't know were possible. Custom-built interactive tools, deep cross-document analysis, technique-specific data pipelines — these are the things that make researchers say "I didn't know I could ask for that." Avoid suggesting things that feel like what a chatbot already does (simple summarization, grammar checking, basic Q&A).

**Tie every suggestion to their specific research.** Reference specific files, datasets, or patterns from their workspace. The magic is personalization — "I looked at YOUR files and here's what I can build YOU." Generic suggestions ("organize your files") are weak. Specific suggestions ("build an interactive explorer for the 12 CSV datasets in `experiments/behavioral/`") are strong.

**Prioritize mini-apps.** Users consistently find mini-app suggestions more compelling and valuable than one-off tasks. Mini-apps should be your default suggestion type — for every data file, experimental result, repetitive workflow, or computational method you find, think about what custom interactive tool would transform how the researcher works. One-time tasks are still valuable for deep analytical work (literature synthesis, manuscript audits), but when in doubt, suggest a mini-app.

**Maximize variety.** Don't cluster suggestions around one category. Spread them across different angles:

- **Custom research tools**: Build interactive mini-apps tailored to their specific data — experiment analyzers, dataset explorers, statistical dashboards, figure generators, protocol managers.
- **Reproduce computational methods from papers**: Read research papers in the workspace and identify computational analyses they describe (statistical models, data transformations, visualization approaches, simulations). Suggest mini-apps that reproduce or extend those methods — especially ones the researcher could apply to their own data. This is powerful because researchers often read about analyses they wish they could run but lack the coding skills to implement.
- **Technique-specific analysis**: Look at the specific research techniques they use (e.g. Western blots, PCR, RNA-seq, regression analysis, finite element modeling) and suggest custom tools or deep analysis for those techniques.
- **Data exploration and visualization**: Build interactive dashboards that let them explore their datasets, spot patterns, and generate publication-ready figures.
- **Deep literature work**: Go beyond simple summaries — structured cross-paper analysis, methodology comparisons, gap identification, citation network analysis across their paper collections.
- **Document review and improvement**: Substantive review of drafts, grant proposals, or presentations — not just proofreading, but structural analysis, argument flow, and alignment with literature.

**Curate the collection as a whole.** Don't just add suggestions — step back and look at the full set together. Each suggestion should earn its place. A tight collection of 3-5 excellent suggestions that cover different angles is more compelling than a long list that dilutes attention. Remove anything that's redundant, generic, or less impressive than the others. The user's Home tab should feel curated, not crowded.

**Keep suggestions current.** If you learn that a suggestion is no longer relevant (the researcher already did it, or their focus shifted), remove or update it. If a conversation reveals a new opportunity, add it.

## Suggestion fields

Each suggestion has four fields:

| Field | Description |
|-------|-------------|
| `name` | Short display title shown to the user. |
| `type` | Either `one_time_task` or `mini_app`. |
| `why_im_suggesting_this` | 1-2 sentences tying the suggestion to specific files or patterns you found. Shown to the user as context. |
| `description` | Instructions for what the agent will build or do. Reference specific files or file patterns. Be as detailed as needed — there is no sentence limit. |

**User-facing language:** "Mini-app" and "mini_app" are internal names. Never use them in `name`, `description`, or `why_im_suggesting_this` — those are shown directly to users. Instead, say "custom tool," "interactive tool," or just describe what it does ("Build an interactive dashboard that..."). Similarly, don't use jargon like "React app" or "Plotly" — describe the end result, not the implementation.

## Examples

Adapt these to what you actually find in the researcher's workspace. Lead with mini-apps — they're the biggest surprise for researchers:

- **Interactive data explorer**: `{ name: "Explore your behavioral experiment results interactively", type: "mini_app", why_im_suggesting_this: "You have 12 CSV files in experiments/behavioral/ with reaction time and accuracy data across multiple conditions.", description: "Build a custom interactive dashboard where you can select experiments, filter by condition and participant, view distributions and summary statistics, run comparisons between groups, and export publication-ready plots — all without writing any code." }`

- **Technique-specific tool**: `{ name: "Western blot quantification tool", type: "mini_app", why_im_suggesting_this: "Your lab notebook entries and protocols/ folder show you regularly run Western blots and manually quantify band intensities.", description: "Build a custom tool that lets you upload Western blot images, automatically detect and quantify band intensities using densitometry, normalize to loading controls, and export publication-ready bar charts with statistical comparisons." }`

- **Survey/questionnaire analyzer**: `{ name: "Analyze your survey responses with custom filters", type: "mini_app", why_im_suggesting_this: "Your data/ folder contains survey response files with Likert-scale and open-ended responses from multiple time points.", description: "Build an interactive survey analysis tool that lets you filter responses by demographic, time point, and question type, compute reliability scores, visualize response distributions, run group comparisons, and perform basic thematic coding on open-ended responses." }`

- **Reproduce methods from a paper**: `{ name: "Run the survival analysis from Chen et al. on your patient data", type: "mini_app", why_im_suggesting_this: "Chen et al. (2023) in your references/ describes a Kaplan-Meier survival analysis with Cox regression, and your clinical_data/ folder has patient outcome data in a similar format.", description: "Build an interactive survival analysis tool that implements the methodology from Chen et al. — Kaplan-Meier curves with log-rank tests, Cox proportional hazards modeling, and forest plots for covariates — applied to your own patient dataset, with controls for filtering by subgroup and adjusting covariates." }`

- **Deep literature analysis**: `{ name: "Map the methodological landscape across your 30 papers", type: "one_time_task", why_im_suggesting_this: "You have 30 PDFs in references/inflammation/ spanning 2018-2024 covering a range of experimental approaches.", description: "Read all 30 papers and produce a structured analysis: a methodology comparison table (sample types, techniques, statistical approaches, sample sizes), a thematic synthesis of findings organized by research question, identification of methodological gaps, and a list of contradictory findings across studies." }`

- **Manuscript vs. literature audit**: `{ name: "Audit your draft against the cited literature", type: "one_time_task", why_im_suggesting_this: "Your manuscript drafts/paper-Y.docx cites 45 references, and you have most of them as PDFs in references/.", description: "Read your draft and every cited paper you have on file. For each claim in your manuscript, verify it against the cited source, flag unsupported or mis-cited claims, identify relevant findings from your reference collection that you haven't cited, and assess whether your literature review has gaps relative to the papers you've collected." }`

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
| `description` | string | Yes | Instructions for what the agent will build or do. |
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
