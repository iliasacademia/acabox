# AI assistants for scientists and data analysis — competitive inventory for Acabox

Researcher group: "AI assistants for scientists and data analysis". Research date: 2026-09-30.
Scope rule followed: web research only; Acabox's own state is judged from the repo's CLAUDE.md, not from reading code. Where CLAUDE.md does not say, the status is "unknown".

## How to read this

- Every feature claim carries a source URL and an as-of date (the page's own date where it has one, otherwise the date fetched, 2026-09-30).
- "Unverified" means I could not reach a primary page; the claim rests on a secondary review/aggregator and should not be acted on without a second look.
- "Model calls per use" is stated for every Acabox idea in the closing section. The default target is zero: host-side computation, UI over data the SDK already emits, or deterministic re-runs.
- Research budget note: the session's web-search allowance was exhausted after the second round, so the third and fourth rounds were direct fetches only. Several vendor pages (observablehq.com, julius.ai docs, elicit.com individual posts, help.openai.com) block or rate-limit fetches; a read-through proxy was used for some, and the rest are flagged.

## Platforms covered (15) and skipped

Covered, in order of relevance to a local, Claude-driven tool builder for non-technical scientists:

1. Julius AI — the closest analogue (chat → code → charts for non-coders)
2. Hex — Threads, Notebook Agent, Endorsed Mode, Context Studio; the best worked-out trust model
3. Deepnote — Agent with plan/diff/reject, run snapshots, AI cost dashboard
4. Google Colab Data Science Agent — plan-first notebook generation
5. ChatGPT data analysis (+ 2026 Work/Pages/Data plugin)
6. Elicit — supporting-quote verification, Research Agent, Routines
7. Literature-grounding cluster: Consensus, Scite, SciSpace, Undermind
8. FutureHouse / Edison Scientific (Kosmos, Crow/Falcon/Owl/Phoenix, Analysis)
9. Biomni (Stanford)
10. Latch Bio (Latch Plots / Latch Agent)
11. GraphPad Prism (the non-AI gold standard for what bench scientists trust)
12. Tableau Pulse / Tableau Agent
13. Power BI Copilot
14. Observable Notebooks 2.0 / Notebook Kit
15. Notebook assistants: Jupyter AI 3.x and Positron / Posit Assistant
    Plus two short entries: Benchling AI, Potato AI.

Skipped and why: Paperpal (writing assistant, not data work); Lila Sciences (autonomous-lab company with no user-facing analysis product to inventory); Rowan (computational chemistry niche); Watershed Bio (no primary material reachable within budget); Microsoft Discovery (enterprise R&D platform, no self-serve surface); Sakana "AI Scientist" (a research system, not a product with UX to borrow).

---

## 1. Julius AI

**What it is.** A chat-first data analyst for non-coders: upload a file or connect a database, ask in plain English, Julius writes and runs Python/R/SQL and returns tables, charts and prose. Positioned by reviewers as the leading tool for non-technical business users in 2026 (secondary: https://guptadeepak.com/tools/top-5-ai-data-analysis-tools-2026/, 2026).

**Feature inventory (interaction described).**

- **Upload → preview → suggested questions.** Paperclip upload of Excel/CSV/PDF/Google Sheets/text/images; after upload Julius "displays a data preview and generates suggested questions based on your dataset structure". (https://www.datacamp.com/tutorial/julius-ai-guide, 2025-06-12)
- **Code is visible but not editable in place.** "You can see the generated code", but modifying it requires leaving the Julius interface. 40+ chart types with interactive formatting; native iOS/Android apps. (https://mcpanalytics.ai/articles/julius-ai-review, 2026-03-28)
- **Notebooks with four cell types** (prompt, code, file, user-input), a template library (sales, finance, HR, academic), and a "Models Lab" to try the latest models. (DataCamp, 2025-06-12)
- **Reproducibility by pinning.** After a prompt cell runs, a "stamp" icon converts the prompt into standalone code cells so "Cells execute the same code every time instead of asking Julius to re-generate it"; works for Python, R and SQL. (https://julius.ai/docs/notebooks/reproducibility-in-notebooks, fetched 2026-09-30 via proxy; undated)
- **Notebooks are being sunset (2026-08-19).** Julius now says models "have become dramatically better at long-horizon tasks", that power users replaced notebooks with "a single detailed prompt" and used fewer credits, and that existing notebooks must be exported by emailing team@julius.ai. (https://julius.ai/articles/notebooks-are-no-longer-necessary, 2026-08-19, fetched via proxy). For a science audience this removes the one deterministic re-run gesture the product had.
- **Scheduled report runs and Custom Agents** are Business-plan line items ("Unlimited scheduled report runs", "Unlimited Custom Agents"); data connectors for Postgres/BigQuery/Snowflake; Slack agent; team workspaces. (https://julius.ai/pricing, fetched 2026-09-30 via proxy)
- **Learning Sub Agent** that learns database structure, table relationships and column meanings over use — unverified (only in aggregator copy: https://dupple.com/reviews/julius-ai, 2026).

**Pricing and metering (two snapshots, showing a shift from messages to credits).**

- April 2026: Free 15 messages/mo; Plus $35 (250 msgs; 16 GB RAM; 7-day file storage); Pro $45 (unlimited; connectors; Notebooks; 32 GB); Max $200; Business $375 (team, Slack agent, API). "A message is consumed every time you send a prompt to Julius, including follow-up questions, visualization refinements and data requests." Free messages do not roll over. (https://coefficient.io/julius-ai-pricing, 2026-04-20)
- September 2026 (live pricing page): credits with "daily refresh" — Plus $20 (2,000 credits/mo; GPT-5.6, Claude Sonnet 5), Pro $45 (5,000; Claude Fable 5, expanded context), Max $200 (25,000; permanent storage; early access), Business $450 (60,000; up to 50 members; connectors; scheduled runs; custom agents); Enterprise custom. Docs carry a "Credits" section: "Understand how credits work and how to monitor your usage." (https://julius.ai/pricing and https://julius.ai/docs, fetched 2026-09-30 via proxy)

**What non-technical users praise / complain about.**

- Praise: fast; "Upload a file, ask a question, get a chart. There is no setup wizard"; good-looking charts; mobile; handles PDFs and academic documents. (mcpanalytics 2026-03-28; https://upsolve.ai/blog/julius-ai-review 2025-10-13)
- Complaints that matter for science: **non-reproducible** — "results can differ when you ask the same question twice" because it "generates fresh code for each query"; **fabricated statistics** on sparse data (under ~50 rows or high missingness); **incorrect p-values** and "parametric tests on non-normal data without checking"; users cannot "specify which statistical test to run" or "control how missing data is handled". (mcpanalytics 2026-03-28). No semantic layer: "revenue" may be computed differently tomorrow, and intermediate databases can yield contradictory follow-ups (secondary: https://similarlabs.com/blog/julius-ai-review, 2026). Message caps frustrate frequent users; occasional slowness and attachment failures; "steeper learning curve for non-technical users" (upsolve 2025-10-13).

**Read-across to Acabox.** Julius proves the wedge (plain-English → chart) and also proves the failure modes a science tool must design against: fresh code per question, untested assumptions, and metered follow-ups that make users ration verification. Acabox's "tool" model (code persisted as an app, re-run deterministically) is the structural answer; what it lacks is the Julius-style on-upload preview/suggestions and a cost meter.

---

## 2. Hex

**What it is.** A data workspace (notebooks → apps) that in late 2025 added **Threads**, a conversational layer for non-technical "Explorers", built on the same agent framework as its Notebook Agent, with a governance layer (endorsed tables, semantic models, workspace rules) that bounds what the agent may use.

**Feature inventory.**

- **Threads — ask, watch it reason, verify.** A prompt bar on the home page; the agent "plans, uses tools, and iterates through results"; the user can watch the reasoning step by step and the agent may propose several approaches and ask for direction. Answers arrive as interactive Explore cells. Verification: inspect the SQL, click into cells, or convert the thread into a notebook for the data team; tag data-team members inside a thread; good outputs become published apps that inform future answers. Launched as public beta on Team and Enterprise with Sonnet 4.5. (https://hex.tech/blog/introducing-threads/ and https://hex.tech/blog/fall-2025-launch/, both 2025-10-01). Marketing page: "Every Thread is backed by a Hex project that the data team can open as a Notebook"; share "every step of the reasoning"; Slack via @Hex; MCP server. (https://hex.tech/product/threads/, fetched 2026-09-30)
- **Endorsed Mode (2026-01-21).** When on, the agent only references "project, table or semantic model context that's endorsed, i.e. explicitly reviewed and approved by data teams"; default on for Explorers, optional for Editors; endorsement can be bulk-set via API. Same entry: **chat with published apps** (summarise, locate cells, adjust filters, explain logic) and the Notebook Agent can edit cells in published apps. (https://learn.hex.tech/changelog/2026-01-21)
- **Projects as context, Python in Threads, Focused Cell Viewer (2026-03-24).** @mention projects or paste links to reuse work; Threads can now write Python (forecasting etc.) and reference Python cells from other projects; a Focused Cell Viewer lets the user click into generated cells and browse them sequentially, with per-cell links and a browsable summary of all agent steps at completion; the agent picks its own data connection (admins can restrict in Slack); two subagents — Data Discovery and Data Visualization ("handles your charts end-to-end", selecting chart type and applying visual best practices); **queue prompts while the agent is working**; chart attachments in scheduled notifications; Hex CLI open beta. (https://learn.hex.tech/changelog/2026-03-24)
- **Notebook Agent — pending-changes review.** Invoked from the project header; uses parallel subagents; "All agent modifications require explicit user approval" via a **Pending changes modal** that "sequentially guide[s] you through the changes that the agent has made, and allow[s] you to handle each one separately" — **Confirm** or **Undo** per cell, jump to the affected cell. @mentions focus the agent on cells/tables. Model defaults to Auto with per-thread selection; "Effort is only shown when you've selected a specific model"; credits vary with model and effort. From an error state: **"Fix with agent"** (multi-step) or **"Quick fix"** (syntax). (https://learn.hex.tech/docs/explore-data/notebook-view/notebook-agent, fetched 2026-09-30 via proxy). The AI overview describes the Notebook Agent as "Designed for technical users who can audit suggested code" and Threads as the surface for non-technical users; also Generative Apps (beta) from a natural-language description, and Enterprise BYOK with zero data retention. (https://learn.hex.tech/docs/getting-started/ai-overview, fetched 2026-09-30)
- **Modeling Agent** shows a diff view for review/approval of semantic-model changes (fall-2025 launch, 2025-10-01).
- **Context Studio.** Admins see agent adoption across Hex, Slack, MCP and CLI; review individual conversations including "the agent's reasoning and the context it used"; a **Review Agent** surfaces warnings of "agent confusion, missing context, or user doubt" and rolls repeats into suggestions; context is layered (table metadata, endorsed tables, git repos, markdown guides, semantic models from dbt/Cube/Snowflake, MCP apps, published apps) and tested with **evals** — "ship what passes and catch what breaks". (https://hex.tech/product/context-studio/, fetched 2026-09-30; launched 2026-01-28 per search summary, unverified date)
- **2026-09-29: usage classification and cheaper small edits.** Context Studio categorises agent activity as Analysis / App building / Modeling (also `hex thread list --classification`); and **"minor chart modifications now route to a lighter model instead of the full Hex Agent"** (legend position, tooltips), cutting latency and token use, with automatic escalation for complex requests. (https://learn.hex.tech/changelog/2026-09-29)

**Pricing / metering.** Community free; Professional $36/Editor/mo; Team $75/Editor/mo; Enterprise custom; Explorer seats are an Enterprise add-on. "AI features in Hex consume credits based on the effort required to complete the task"; monthly per-seat grants that "refresh monthly and don't roll over". (https://hex.tech/pricing/, fetched 2026-09-30). At Threads launch "Extended AI usage limits are included for free during the early access period" (2025-10-01).

**User sentiment.** Not independently gathered (G2 not reachable without search budget). Hex's own trust framing — "the underlying SQL, transformations, and data lineage remain one click away for anyone who wants to verify the work" (https://hex.tech/blog/ai-analytics-trust/, 2026) — is the clearest statement of the pattern.

**Read-across to Acabox.** Three things are directly portable without a model call: (1) a pending-changes review with per-item confirm/undo after an agent edits a tool; (2) an "endorsed" notion for local data — a user-confirmed data dictionary the agent must use; (3) routing trivial edits to a cheaper model. The Threads → "open as notebook for the expert" escalation is the right shape for a scientist who has a bioinformatician down the hall.

---

## 3. Deepnote

**What it is.** A collaborative notebook that is now "a drop-in replacement for Jupyter with an AI-first design" (open-source core, https://github.com/deepnote/deepnote) with an Agent that edits notebooks, plus Skills/Agents/Apps for delivering results to people who never open a notebook.

**Feature inventory.**

- **Agent modes.** Edit mode (default) can "create, edit, and remove SQL, Python, or text blocks — anywhere in your notebook"; Ask mode answers without changing anything. The agent "Interprets your request. Creates a transparent, step-by-step plan. Executes each step systematically." Changes stream in real time with clickable action items linking to blocks; at the end a "summary of changes" with a **before-and-after diff view for code edits**; a bin icon **rejects all modifications from a single run**; follow-ups continue from the updated notebook. Uses connected databases via Deepnote MCP integrations and Deepnote's own docs; model: pick a provider/model or "Automatic". Available on Pro/Team/Enterprise. (https://deepnote.com/docs/deepnote-agent, fetched 2026-09-30)
- **One-click debugging** ("pinpoints the issue and provides an immediate fix with just a simple click") and the trust claim "Our notebook structure ensures that every AI suggestion is turned into transparent and reproducible results". (https://deepnote.com/ai, fetched 2026-09-30)
- **2026 changelog** (https://deepnote.com/changelog, fetched 2026-09-30):
  - 2026-04-01 — Settings → AI shows feature usage, **model calls, costs in USD**, and energy (playfully, in "KitKat bars").
  - 2026-04-27 — **Every run saves an immutable snapshot** — "a frozen record of all blocks, outputs, and execution metadata"; admins see every AI action (who, which notebook, **token usage per request**).
  - 2026-06-04 — Codex connects via MCP; explorations become published apps.
  - 2026-07-02 — visibility and revocation of every MCP OAuth grant; agents can "create an integration and wire it into a project without a human step".
  - 2026-07-16 — project settings panel with **Triggers**; **scheduled notebooks "pause themselves after a configurable number of consecutive failures"**.
  - 2026-08-03 — Agent workspace: **Skills** (knowledge + procedures with sources and permissions), **Agents** (notebooks with a runtime and instructions; interactive, scheduled, or API-triggered), **Apps** (results for people who do not open notebooks); reachable from Deepnote, IDEs via MCP, Slack, terminal or headless API.
  - 2026-08-21 — Agent release; 90% off AI usage to Sept 8; `@deepnote/local-runner` turns notebooks into input→run→inspect apps; ZIP import with undo snapshots.

**Pricing / metering.** Free: 3 editors, 10 AI completions/mo and 5 calls/mo each for Agent, code generation, editing and explanation; Team $39/editor/mo (yearly) with "$39 worth of AI credits every month", GPT-5.6 Sol and Sonnet 4.6, scheduled notebooks; Enterprise "Unlimited AI" and "Bring your own LLM". (https://deepnote.com/pricing, fetched 2026-09-30)

**User sentiment.** Not gathered (budget).

**Read-across to Acabox.** Immutable run snapshots, the AI-cost dashboard, pause-after-N-failures for schedules, and the plan → live progress → diff → reject-all loop are all host-side features with zero marginal model calls. Ask vs Edit is a one-toggle safety net for a non-coder who only wants to understand a tool, not change it.

---

## 4. Google Colab Data Science Agent

**Feature inventory.**

- **Prompt → plan → full notebook.** Open a blank notebook, upload data, describe the goal in the Gemini side panel ("Visualize trends", "Build and optimize prediction model"); the agent generates "complete, executable notebooks" with imports, code and analysis. Free for users 18+ in select countries; ranked 4th on DABStep. (https://developers.googleblog.com/en/data-science-agent-in-colab-with-gemini/, 2025-03-03)
- **Hands-on (Towards Data Science, 2025-03-21).** The agent produced a 10-task plan (loading → exploration → cleaning → wrangling → feature engineering → split → train → optimise → evaluate → visualise); the author **edited the plan to focus on EDA first**; during training it **self-corrected three sequential errors** (dtype promotion, NaNs) by dropping columns and adding imputation; it wrote step-by-step summaries. Failures: it **did not modify the notebook on follow-up requests** (revised code only in chat) and made questionable methodological choices (mean imputation for skewed data). (https://towardsdatascience.com/googles-data-science-agent-can-it-really-do-your-job/)
- **2026.** Colab Enterprise: Jan 2026 support for BigFrames/BigQuery ML/Spark; **2026-05-26 Data Science Agent generally available** in Colab Enterprise (https://docs.cloud.google.com/colab/docs/release-notes). **2026-04-08:** **Custom Instructions stored at the notebook level and carried with shared notebooks**, and **Learn Mode**, which gives "step-by-step guidance" instead of full solutions, toggled from the Gemini chat window. (https://blog.google/innovation-and-ai/technology/developers-tools/colab-updates/)

**Read-across.** The editable plan before execution and the per-notebook instructions that travel with the artefact are both cheap to port. The follow-up failure (code in chat, not applied) is the exact trap Acabox's tool model avoids — worth stating in the UI ("changes are applied to the tool, not pasted").

---

## 5. ChatGPT data analysis (and the 2026 Work / Pages / Data plugin layer)

**Feature inventory.**

- **Core loop.** Upload .xls/.xlsx/.csv, PDFs and .json/.xml/.yaml/.txt/.md; ChatGPT runs Python in a sandbox (no outbound internet), shows pandas DataFrames as interactive tables and offers "Switch to interactive chart" (bar/line/pie/scatter); users can review the generated code and ask for a different method, chart type or grouping; Drive/OneDrive/SharePoint connectors; large files may need splitting; limits vary by plan. (https://help.openai.com/en/articles/8437071-data-analysis-with-chatgpt, "updated 2 months ago" as of 2026-09-30, fetched via proxy). Interactive charts with custom colours and PNG/SVG download date from the 2024 revamp (https://openai.com/index/improvements-to-data-analysis-in-chatgpt/; export-format detail is secondary).
- **2026 release notes relevant to data work** (https://help.openai.com/en/articles/6825453-chatgpt-release-notes, fetched 2026-09-30 via proxy):
  - 2026-04-28 — model and **thinking-effort selection in the composer**.
  - 2026-05-05 — **Memory "Sources" icon** under a reply shows which memories, past chats, files and emails shaped it; **ChatGPT for Excel and Google Sheets** sidebar (formulas, multi-tab files, cleanup, scenarios).
  - 2026-05-14 — file Library for Free/Go (500 MB–100 GB by plan).
  - 2026-06-08 and 2026-08-08 — **interactive bar/line/pie/scatter charts rendered inside answers**.
  - 2026-06-17 — Scheduled page listing active tasks and next runs; windows like "morning".
  - 2026-07-09 — **ChatGPT Work**: long tasks across connected apps and files, producing documents/spreadsheets/reports/Sites, with "user approval of important actions"; **Scheduled tasks** that monitor and notify.
  - 2026-07-29 — **ChatGPT for Academic Researchers**: 12 months complimentary workspace for verified faculty/postdocs, up to five collaborators.
  - 2026-08-04 — pastes over 10,000 characters become attachments.
  - 2026-09-10 / 09-29 — **Data plugin** for Work and Codex: ask business questions, build interactive dashboards, refine with follow-ups; **Pages** (turn a conversation into an editable page with charts; collaborators comment); **Spaces**; Box/Dropbox/SharePoint in Library; Library sharing with Viewer/Editor roles (2026-09-09).
  - GPT-6 Astra (2026-09-03) "can create documents, spreadsheets, and presentations" — secondary (https://releasebot.io/updates/openai/chatgpt).

**User sentiment.** Not independently gathered this pass; the Julius reviews above describe the same architectural weaknesses (fresh code per question, no assumption checks) for all chat-with-data tools.

**Read-across.** Inline interactive charts in replies, the "Sources" affordance (which files/memories shaped the answer), per-task scheduled page, and Pages-with-comments as the share artefact. The thinking-effort slider in the composer matches Acabox's existing effort pin.

---

## 6. Elicit

**Feature inventory.**

- **Systematic Review workflow (2025-02-20).** Five stages: define the question (Elicit suggests clarifications); gather papers (upload PDFs, pick from Library, import keyword-search results, supplement with up to 500 from semantic search); screening (AI-drafted criteria; papers "sorted by their likelihood of meeting all of your screening criteria"; override any decision); extraction (AI-suggested fields; "Elicit always provides supporting quotes from the paper and an explanation so that you can easily check the AI-generated answers for accuracy"); export CSV at any stage; revise any step for "living reviews"; view-only share links; Team/Enterprise collaboration. (https://elicit.com/blog/systematic-review/)
- **Vendor accuracy claims** — screens in 94% of papers; extraction 94–99%; up to 80% time saving (search summary citing https://elicit.com/blog/how-we-evaluated-elicit-systematic-review; not fetched, treat as vendor claim). An independent comparison of Elicit extraction vs human reviewers in RCTs exists (https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12462964/, 2025).
- **2026 timeline** (blog index and homepage, fetched 2026-09-30 via proxy; individual posts 404 via proxy):
  - 2026-06-30 — more powerful Research Agent; **pricing moved from workflow-based limits to a monthly usage pool**.
  - 2026-07-15 — **Elicit API and MCP server** for external agents.
  - 2026-08-04 — **Research Agent** "built for high-stakes decisions"; produces "fully cited artifacts like reports, tables, figures, bioinformatics analyses, calculations, and slides" with "sentence-level citations"; BioDecisionBench.
  - 2026-08-14 — 60.3% recall@50 on BioASQ vs 40.3% for a web-search API.
  - 2026-08-31 — multiplayer: Skills, Collaborative Sessions, Artifact Editing, Shared Projects.
  - 2026-09-17 — Library as "a shared research hub where researchers and AI agents can work from the same evidence".
  - 2026-09-30 — **Routines**: "Tell the Elicit Research Agent what to keep current. Routines find new evidence, update your work, and report back."
- **Pricing.** Basic free (unlimited search over 138M papers; limited reports); Pro $49/mo ($588/yr): systematic reviews screening up to 5,000 papers, 20 extraction columns, API; Scale $169/mo: 5x usage, 30 columns, live collaboration, figure extraction, admin usage tracking; Enterprise: 40,000-paper screening, 40 columns, "PRISMA-grade". (https://elicit.com/pricing, fetched 2026-09-30)

**Read-across.** "Supporting quote + explanation on every extracted value, override anywhere" is the single best trust pattern in this group and transfers from papers to numbers: every value a tool shows should link to the code and the input rows that produced it. Routines is the model for scheduled work that reports back only what changed.

---

## 7. Literature-grounding cluster: Consensus, Scite, SciSpace, Undermind

These four are not analysis tools, but they define how a non-technical scientist expects *claims* to be shown and checked, and three of them now ship MCP servers that a Claude-based tool can call directly.

### Consensus

- **Consensus Meter**: for a yes/no question, a visual read of what proportion of top papers say yes / no / possibly (secondary: https://www.buildfastwithai.com/ai-tools/consensus, 2026).
- **2026 changelog** (https://help.consensus.app/en/articles/11954907-consensus-product-changelog, fetched 2026-09-30 via proxy): 03-24 **Consensus MCP and Claude connector** (220M+ papers; literature reviews, reading lists, grant discovery inside Claude); 05-06 updated ChatGPT app; 05-12 **Research Agent** (multi-step planning, tool chaining, citation-backed); 05-13 availability in ChatGPT, Codex, Claude, Claude Code and the API; 05-15 full text from Wiley, AAAS, T&F, Sage, ACS, APA; 06-18 **Deep Search in Library with flexible outputs** (PICO/SPIDER reviews, reading lists, scoping maps, custom reports over up to ~50 papers — output list from search summary); 06-22 uploads private by default, share by collection; 08-18 **citation grounding: hover an inline citation to see the exact supporting quotation**; 08-26 self-serve API; 09-15 Microsoft 365 Copilot app; 09-18 full-text passages in the API; 09-22 interactive **Research Gaps Matrix** (click a cell → papers, evidence, gaps); 09-24 **figures, charts and tables from open-access papers shown inside AI responses**; 09-28 suggested papers from your library.
- **Pricing** (https://consensus.app/pricing/, fetched 2026-09-30 via proxy): Free — basic search, 10 Pro messages/mo, 3 Deep reviews/mo; Pro $12/mo — unlimited Pro messages, 15 Deep reviews, 500 API/MCP uses ($0.05 each beyond); Deep $45/mo — 200 Deep reviews, 2,000 API/MCP uses; up to 40% off for students, faculty and US healthcare professionals.

### Scite

- **Smart Citations** classify 1.6B+ citation statements as supporting / contrasting / mentioning, with section location; the Assistant answers with inline citations and filters by date, type and classification (secondary: https://www.buildfastwithai.com/ai-tools/scite, 2026).
- **Pricing** (https://scite.ai/pricing, fetched 2026-09-30): Connect free — MCP access in ChatGPT/Claude with trial or paid plan, no Assistant; Basic $20/mo — Assistant and Search, 250 MCP credits/mo, citation alerts; Pro $50/mo — 2,500 MCP credits, API with $60 credit, patents/trials/grants datasets.

### SciSpace

- **2,601+ "agents"** in categories Extract + Analyse, Literature Review, Create + Write, Deep Search and domain packs; inputs are PDFs/CSV/XLSX or search parameters; outputs export as CSV/XLSX/DOCX/PDF/RIS/BibTeX/JSON; examples: PRISMA flow diagram, extract limitations from a paper, design a Scopus Boolean search, patent download tools. (https://scispace.com/agents, fetched 2026-09-30 via proxy). Deep Review iterates, adding papers as context across passes (secondary: https://effortlessacademic.com/scispace-deep-review-ai-for-literature-reviews/). An SLR data-extraction agent follows PRISMA/PRISMA-S with search logs, blinded dual screening, risk-of-bias and reproducible reporting (search summary; agent page not fetched).

### Undermind

- **Flow**: Describe (the system asks clarifying questions) → Explore ("reads and evaluates hundreds of papers, follows citation trails") → Build (iterate the report, custom tables, full texts) → Keep up (alerts for new papers). Average production search ~2.9 minutes; reports carry citation networks and inline citations. **Pricing**: Free with rate limits; Pro $16/mo annual with "10x higher usage limits" and full-text analysis; Team $15/person. (https://www.undermind.ai/, fetched 2026-09-30). Older aggregator figures (3 free deep searches/mo; $20 for 30) are superseded.

**Read-across.** Hover-to-quote citations, support/contrast colouring, clarifying questions before a long job, and alerts on new evidence. Acabox already renders DOIs (`AnchorWithDoi`) and has a connector catalog; adding Consensus/Scite/Elicit MCP entries is a one-line-per-service change per CLAUDE.md.

---

## 8. FutureHouse / Edison Scientific

### FutureHouse platform (non-profit; agents remain free)

- **Crow** (concise scholarly answers), **Falcon** (deep literature synthesis incl. specialised DBs such as OpenTargets), **Owl** ("Has anyone done X before?"), **Phoenix** (chemistry experiment planning; experimental). Web UI at platform.futurehouse.org and API; "transparent reasoning" — users "can see this process in order to tell exactly how the agents arrived at a given conclusion"; Crow/Falcon/Owl benchmarked above frontier search models and with "better precision than PhD-level researchers" on literature tasks. (https://www.futurehouse.org/research-announcements/launching-futurehouse-platform-ai-agents, 2025-05-01). **Robin**, the multi-agent discovery system (ripasudil for dry AMD), was published in Nature in May 2026 (search summary; https://www.futurehouse.org/research/demonstrating-end-to-end-scientific-discovery-with-robin-a-multi-agent-system).

### Edison Scientific (commercial spin-out)

- **Kosmos** (announced 2025-11-05): user supplies a research objective and datasets; a run reads ~1,500 papers and writes ~42,000 lines of analysis code, using a "structured world model" to stay coherent across tens of millions of tokens; "Every conclusion is traceable to specific lines of code or the specific passages in the scientific literature that inspired it, ensuring that Kosmos' reports are fully auditable at all times"; 79.4% statement accuracy; three reproductions of unpublished findings and four novel contributions; admitted failure modes — it "often goes down rabbit holes or chases statistically significant yet scientifically irrelevant findings", worse on longer runs. **Pricing at launch**: $200 per run (200 credits at $1), a free tier for academics, founding subscribers lock $1/credit. (https://edisonscientific.com/news/announcing-kosmos)
- **Independent coverage (Alzforum, 2025-11-21)**: a typical 20-cycle run takes ~12 hours and up to 200 tasks; 102 statements across three reports were graded — **80% overall, 85.5% for data-analysis statements, 82% for literature statements, 58% for synthesised conclusions**; first six runs free for academics. Scientists: one runs most datasets through it for validation and praises it at "identifying meaningful signals in the profusion of complex omics data"; another: "one in five conclusions is still wrong" — treat it "more like getting an opinion from a well-read colleague"; concern about high-volume, low-quality output. (https://www.alzforum.org/news/research-news/introducing-kosmos-ai-scientist-makes-discoveries-overnight)
- **Platform products (docs, fetched 2026-09-30)**: Kosmos; **Literature** (175M+ papers, trials, patents); **Analysis** — "Processes experimental data including flow cytometry and RNA-seq, delivering statistical results and publication-ready figures"; **Precedent** (novelty); **Molecules**. "Every conclusion is fully auditable. You can trace any finding back to the specific code or literature passage that produced it." "A generous free tier for academics." (https://docs.edisonscientific.com/)
- **Kosmos best practices**: one well-defined objective whose answer "should not be obvious after reading a few papers or conducting a single data analysis"; datasets under 5 GB uncompressed, hundreds of files OK; best on processed, high-dimensional data (scRNA-seq, proteomics), not raw FASTQ or imaging. (https://docs.edisonscientific.com/guides/best-practices-for-optimizing-kosmos-workflows.md)
- **Analysis API**: task = research query + language (Python or R) + optional system prompt; tools include Ensembl queries and web search; returns a notebook with the code, figures, a final answer and other files; "Jobs take on average 3-10 minutes to complete"; each task has a trajectory id with a live progress page. (https://docs.edisonscientific.com/edison-client/docs/edison_analysis_tutorial.md)
- **2026 status**: homepage says Kosmos "Collaborates through Slack, Teams, and email while Kosmos advances investigations and surfaces findings"; Springer Nature partnership 2026-09-24; $70M raise. The pricing page now 404s; reports that the founding offer was retired and academics get 650 credits/month are **unverified** (https://binaryverseai.com/ai-scientist-kosmos-edison-pricing-discoveries/). (https://edisonscientific.com/, fetched 2026-09-30)

**Read-across.** Two patterns worth copying as UI, not as autonomy: per-claim traceability to code/literature, and a report that separates computed facts from synthesised interpretation (the accuracy gap between 85% and 58% is the argument). Mid-run updates in chat channels and "ask for a progress artifact" are the long-run equivalents of Acabox's fold line.

---

## 9. Biomni (Stanford)

- **What it is.** A general-purpose biomedical agent (open source) and a free no-code web platform at biomni.stanford.edu. **Biomni-E1** environment: 150 specialised tools, 59 databases, 105 software packages, derived by an LLM "action discovery" pass over 2,500 publications; **Biomni-A1** architecture: retrieve relevant tools/DBs for the query, then produce "a detailed, step-by-step plan", then code execution with self-critique. Paper published in Science 2026-07-09 (bioRxiv May 2025). (https://biomni.stanford.edu/, https://www.biorxiv.org/content/10.1101/2025.05.30.656746v1.full, https://hai.stanford.edu/news/stanford-scientists-build-an-ai-lab-partner)
- **Interaction.** Chat interface with open-ended requests ("Analyze the attached Perturb-seq data and generate a meaningful hypothesis"); the agent "formulates a plan for scientist review"; the researcher can "review the plan and monitor Biomni's activity each step of the way... intervening at any time to course-correct"; the work is "a digital conversation that's fully documented and auditable". Example task: 458 Excel files of glucose-monitor data for 30 participants → structured report with individual and population trends. Authors' limits: "still struggles in areas that require nuanced clinical judgment, novel experimental reasoning, or deep biological thinking and synthesis". (HAI news, 2026-07-09)
- **Engineering facts (README, fetched 2026-09-30).** Supports Claude (Sonnet 4), OpenAI, Azure, Gemini, Groq, Bedrock, local models via SGLang and its own Biomni-R0; MCP server support with examples; conda `setup.sh` installs R packages and CLI tools (PLINK, samtools, MACS2 …); Biomni-Eval1 has 433 instances over 10 task types; **safety warning: "Currently, Biomni executes LLM-generated code with full system privileges"** — recommends isolation. (https://github.com/snap-stanford/biomni, https://github.com/snap-stanford/Biomni/blob/main/DETAILS.md)

**Read-across.** Plan-for-review then step-by-step monitoring with intervention is what a non-technical scientist needs from a long analysis. The curated tool/database set is the "domain pack" idea; Acabox's ten database skills are the seed of it. The full-privilege warning is Acabox's own hazard (unrestricted Bash; read-only dirs advisory).

---

## 10. Latch Bio (Latch Plots / Latch Agent)

- **Latch Plots (2024-11-13).** "A reactive, Python-based plotting framework with a library of graphical widgets and an LLM integration" meant to replace GraphPad and Excel for biologists; prompt → plots and interactive widgets; no-code chart cells (e.g., UMAP coloured by a categorical); outputs "customizable and traceable to source data"; "transparent access to underlying statistical code"; live co-editing; GPU pods turn 30-minute single-cell steps into under a minute. (https://blog.latch.bio/p/product-digest-latch-plots-protein)
- **Agents for spatial biology (2025-10-28).** "Process my Vizgen data" → the agent builds graphical notebooks with markdown and widgets; automates QC and artefact detection, GPU segmentation (CellPose, Baysor), cell typing against reference DBs, differential expression accounting for spatial autocorrelation, BANKSY domains, image registration; verification through the H5 viewer, visible code snippets, spatial QC plots, and standard outputs (AnnData, PMTiles, DuckDB); "Powered by Anthropic". (https://blog.latch.bio/p/agents-for-spatial-biology)
- **Agent docs (fetched 2026-09-30).** Claude Opus; "Describe your analysis goals in plain English—no coding required"; "View all code, plots, and methods for every analysis step"; **skills "loaded on demand for each data type"** that encode "technology-specific analysis best practices" developed with kit, assay and instrument manufacturers; demo at agent.bio (the demo page currently shows a benchmark post, not the product). Context: conversation, notebook contents, analysis plans, platform docs for Xenium/Vizgen/Takara/Visium/AtlasXOmics, attached files; **"Each notebook session is isolated—the agent starts fresh each time"**, so users write summary files to carry work across sessions. (https://wiki.latch.bio/agent, https://wiki.latch.bio/agent/context)
- **Independent test (ML@B, 2026-04-15).** Scientists "review and approve outputs at each stage before advancing"; the agent "correctly flagged" absent canonical markers rather than hallucinating; failure modes: housekeeping genes dominating marker lists, diluted subset markers, stromal contamination of epithelial predictions, sensitivity to prompt framing; verification is by intermediate QC/clustering/marker plots compared with literature. (https://mlberkeley.substack.com/p/benchmarking-biologys-ai-agent-mlbs)
- **2026 direction.** The blog is now dominated by agent benchmarks (MetagenomicsBench 09-29; TxBench oligo 09-09; antibody discovery 09-02; "When It Answers, Fable 5.1 is Strong at Biology Reasoning" 09-01; Grok 4.6 08-13/09-01). A "Latch MCP" for Claude Code/Codex (June 2026) appears in search summaries but the post was not reached — unverified. (https://blog.latch.bio/archive)

**Read-across.** The closest technical cousin to an Acabox tool (reactive Python plots + widgets + Claude). Portable: per-data-type skills that put the standard QC figures first, "view the code behind every step", and the ML@B verification habit (intermediate plots as the trust surface). Avoid the Latch anti-pattern of session amnesia — Acabox's memory and chat links already do.

---

## 11. GraphPad Prism (the non-AI benchmark)

- **No AI feature exists.** GraphPad's updates page lists every release from 10.0.3 (2023) to 11.1.0 (2026-08-19) and none mentions an assistant; the features page is likewise AI-free. (https://www.graphpad.com/updates and https://www.graphpad.com/features, fetched 2026-09-30). A GitHub page claiming a "dual-AI assistant (GPT-4 Turbo + Claude)" in Prism 10.3.3 is a third-party "full setup" distribution, not GraphPad — **treat as false**.
- **What bench scientists actually trust.** "Each analysis includes a checklist to help you understand the required statistical assumptions and confirm you've selected an appropriate test"; "Graphs and results are automatically updated in real time. Any changes to the data and analyses... are reflected in results, graphs, and layouts instantaneously"; export "customize your exports (file type, resolution, transparency, dimensions, color space RGB/CMYK)"; Prism Cloud sharing with roles. (features page, fetched 2026-09-30)
- **Prism 11.0.0 (2026-02-17).** Formulas in Columns (type "=" in an empty variable; results update when source data changes); Multifactor ANOVA by drag-and-drop variable assignment; t tests / nonlinear regression / Kaplan–Meier directly from Multiple Variables tables; **effect sizes with confidence intervals reported by default**; browser upload to Prism Cloud; Content Manager role. (https://www.graphpad.com/updates/prism-11-0-0-release-notes)
- **Prism 11.1.0 (2026-08-19).** Violin/box/column-scatter from MV tables; categorical level ordering; variable-type filtering in analysis dialogs ("reduce selection errors"); dashed error bars; 60+ fixes. 10.6.0 (2025-08-20) added SVG export. (https://www.graphpad.com/updates/prism-11-1-0-release-notes, https://www.graphpad.com/updates)

**Read-across.** Prism is the bar Acabox tools must clear to be used in a paper: an assumptions checklist attached to every inferential result, effect sizes with CIs by default, linked data→result→figure updates, and an export dialog with DPI, dimensions and colour space. All of it is deterministic.

---

## 12. Tableau Pulse / Tableau Agent

- **Pulse model.** Metric definitions (source, measure + aggregation, time dimension, comparisons, filters, goals, thresholds) → users follow metrics → an insights platform detects drivers, trends, contributors and outliers **by statistical analysis**, and the LLM only writes the natural-language summary: insights are "pre-calculated insights that are rooted in statistical analysis", not the model analysing data. Digests by email, Slack (with sparklines) and Teams, weekly or monthly; each insight is a plain-language explanation plus a visual with goal/threshold/forecast context; "Ask" follow-ups; Tableau Agent in Pulse (GPT-5.2, Tableau+) suggests questions and answers over rolling windows; trust cues: Certified badges and "Last Modified By"; Einstein Trust Layer. **2026**: 07-02 dark mode, GPT-5.2, Last Modified By; 08-26 Teams digests/alerts, metric tags, Agent answers about top/bottom members, email digests link into Agent. (https://help.tableau.com/current/online/en-us/pulse_intro.htm, fetched 2026-09-30)
- **2026.2.** **Tableau Agent in Dashboards** (beta late July 2026) — ask a dashboard questions in plain language; **Tableau Next auto semantic-model creation** (beta); **Q&A Calibration** (beta) — "Empower Data SMEs to systematically validate and optimize AI-generated answers" via batch regression testing; composable data sources; semantic models as code from VS Code/Cursor; hosted Tableau MCP (GA); semantic search (pilot). (https://www.tableau.com/2026-2-features, fetched 2026-09-30 via proxy)

**Read-across.** The division of labour — deterministic statistics compute the insight, the model only narrates — is the cost-and-trust pattern for Acabox scheduled tasks. Certified/last-modified cues are zero-cost trust UI.

---

## 13. Power BI Copilot

- **Standalone Copilot (preview; doc dated 2026-07-06, updated 2026-08-27).** Full-screen chat that finds the right report or semantic model for a question, asks clarifying questions when needed, or lets the user attach a specific item with "+"; summarises reports, answers from visuals, falls back to measures/fields or new DAX; mobile preview. **Friction treatment**: models not marked "Approved for Copilot" show a warning that "the answer quality could be low" with a "View answer" override; admins can show approved items only. (https://learn.microsoft.com/en-us/power-bi/explore-reports/copilot-chat-with-data-standalone)
- **Prep data for AI (doc 2026-05-26, updated 2026-09-16).** Three authoring features saved on the semantic model: **AI data schema**, **verified answers** (select a visual → "Set verified answer" → trigger phrases that return that visual), and **AI instructions**; a skill picker to test what end users will see; **"How Copilot arrived at this" (HCAAT)** shows what Copilot used; explicit caveat: "AI behavior is nondeterministic. Copilot doesn't always produce the exact same response, even with the same input." (https://learn.microsoft.com/en-us/power-bi/create-reports/copilot-prepare-data-ai). Verified answers keep definitions like "active customer" from drifting (secondary: https://powerbi.ai/blog/01-power-bi-copilot-guide.html, 2026). Input limit raised from 500 to 10,000 characters (secondary: https://www.hubsite365.com/..., 2026).

**Read-across.** "Approved" data with a visible warning otherwise, pinned verified answers, and a per-answer "how it arrived at this" — all are UI over existing state.

---

## 14. Observable Notebooks 2.0 / Notebook Kit

- **Preview (2025-07-29).** An open notebook file format (an HTML dialect), **Notebook Kit** — an open-source CLI that builds static sites from notebooks (plus a Vite plugin), and **Observable Desktop**, a macOS app editing notebooks as local files "with a radical new approach to AI"; vanilla JavaScript instead of Observable's dialect. (https://observablehq.com/blog/previewing-notebooks-2, fetched 2026-09-30 via proxy; https://github.com/observablehq/notebook-kit; https://simonwillison.net/2025/Aug/6/observable-notebooks-20/ 2025-08-06; https://macwright.com/2025/07/31/observable-notebooks-2 2025-07-31)
- **2026-09-02.** Observable shipped the full rewrite, framing AI as "encouraging human understanding, collaboration, and creativity" rather than generating for the user. (https://flowingdata.com/2026/09/02/observable-notebooks-get-a-rewrite/). The product pages were rate-limited; **how the AI edits a notebook and what the user sees is unverified**.

**Read-across.** File-over-app plus static publishing is the sharing shape Acabox already has with Cloudflare Workers; the "AI that teaches rather than replaces" framing matches Colab's Learn Mode and is a cheap toggle.

---

## 15. Notebook assistants: Jupyter AI 3.x and Positron / Posit Assistant

### Jupyter AI

- **3.0.0 released 2026-04-01; 3.2.0 on 2026-09-03.** (https://pypi.org/project/jupyter-ai/#history). The project stopped building its own agent ("building a production-grade coding agent requires massive investment") and became a host for **ACP** agents — Claude, Codex, GitHub Copilot, Goose, Kilo, Kiro, Mistral Vibe, OpenCode — plus MCP. (https://github.com/jupyterlab/jupyter-ai/issues/1531, 2026-02-24; https://jupyter-ai.readthedocs.io/, fetched 2026-09-30)
- **Interaction.** "Watch agents edit files, run notebooks, and fix cell errors in real-time"; **"Guardrails By Default: Agents request permission before writing files, running commands, or using MCP tools"**; collaborative chats where humans and AI personas are @-mentioned, with drag-and-drop attachments; 3.1.0 (2026-07-23) put model and permission-mode controls in the input toolbar. (readthedocs; https://github.com/jupyterlab/jupyter-ai/releases)

### Positron / Posit Assistant

- **Timeline.** Preview in RStudio and Positron with Workbench 2026.04.0 (2026-04-23); unified Posit Assistant and a $20/mo Posit AI subscription (2026-05-11); default AI experience since Positron 2026.07; Jupyter notebook editor GA 2026-07-29. (https://posit.co/blog/workbench-release-2026-04, https://opensource.posit.co/blog/2026-05-11_positron-2026-05-release/, https://opensource.posit.co/blog/2026-07-29_positron-jupyter-notebook-editor-ga/, https://positron.posit.co/assistant.html)
- **What it sees.** Live R/Python session — variables, data frames, console history — **and the rendered plots**; the pitch (2026-07-01) is three layers (data, code, output) so it can notice "when visualizations change in ways that are or are not explained by upstream data or code modifications" and frame trust as "an ongoing practice rather than a one-time check". (https://posit.co/blog/posit-assistant-ai-sees-your-data-code-and-visualizations-reproducible-analysis)
- **Controls.** Plan Mode ("explores the codebase, asks questions, and writes a plan file"); slash commands; **three approval modes (Normal, YOLO, Restricted) and per-tool permissions**; BYOK for Anthropic, Bedrock, GitHub Copilot, OpenAI, or Posit AI Pass. (assistant.html, fetched 2026-09-30)
- **Notebook editor GA.** Environment discovery and switching; Variables pane and Data Explorer; a **Visualize wizard with "copy-code" that turns point-and-click into notebook code**; settings to strip outputs for clean git diffs. (2026-07-29 post)

**Read-across.** Feed the rendered chart (Acabox already has screenshot capture) into the fix turn; expose "copy the code behind this chart"; offer a restricted approval mode for people who want the agent to ask before writing outside a tool's folder.

---

## Short entries

### Benchling AI (GA 2026-02-10)

Deep Research Agent (pulls experiment IDs, procedures, reagents across the tenant "with full citations from source data"), Compose Agent (unstructured CRO/assay PDFs and spreadsheets → schema-mapped entries; a customer quote puts a task at "approximately 10 minutes"), Data Entry Agent, Ask Mode, **Notebook Check** (deterministic rules flagging "missing decimals, duplicate values, copy-paste mistakes, and missing samples", customisable), SQL Writer, AlphaFold 2/Chai-1/Boltz-2 runs in-platform with audit trails; AI Connectors; 500+ companies. Pricing undisclosed. (https://www.benchling.com/blog/benchling-ai-now-generally-available, https://www.benchling.com/ai/capabilities, fetched 2026-09-30; Notebook Check detail from search summary of the same blog)

### Potato AI (Optimizer early access, 2026-08)

Not a chatbot: a structured request (assay spec sheet + desired change + lab constraints) yields multivariable designs, written protocols, plate maps and instrument worklists (Opentrons first); literature is pulled into the design; **"deterministic calculations over AI guessing" for volumes, concentrations and dilution series**. (https://www.synbiobeta.com/read/potato-just-launched-the-tool-it-wishes-it-had-as-a-lab-scientist; funding: https://www.geekwire.com/2025/startup-aiming-to-revolutionize-research-with-fully-automated-science-experimentation-lands-4-5m/)

---

## Cross-cutting patterns (what the field converged on in 2026)

1. **Plan first, then execute, with the plan editable.** Colab's 10-task plan, Deepnote's "transparent, step-by-step plan", Biomni's "plan for scientist review", Positron's plan file, Hex's visible reasoning. Non-technical users accept autonomy when they can redirect before the work starts.
2. **Review changes, not code.** Hex's per-cell Confirm/Undo modal, Deepnote's before/after diff with "reject all", Positron's approval modes, Jupyter AI's permission-before-write. Every notebook-editing agent shipped an approval surface in 2026; Acabox is the outlier (auto-approve, no diff).
3. **Deterministic numbers, narrated by the model.** Tableau Pulse computes insights statistically and lets the LLM only write the sentence; Potato calculates volumes rather than generating them; Julius's pinned cells and the reviews of its unpinned chat show why. Reproducibility is a property of *where the number is made*.
4. **Provenance per claim.** Kosmos links every conclusion to code lines or passages; Elicit attaches a supporting quote and explanation to every extracted value; Consensus shows the quote on hover; Power BI shows "How Copilot arrived at this"; Latch shows the code behind every step.
5. **Label computed facts vs interpretation.** Kosmos's graded accuracy (85% data statements, 58% synthesised conclusions) is the quantitative case; Hex's "answers grounded in endorsed data" and Power BI's "approved" warning are the UI case.
6. **Immutable run records.** Deepnote snapshots every run (blocks, outputs, metadata); Benchling audits model runs; Edison gives every job a trajectory page.
7. **Cost made visible, and routed.** Deepnote shows model calls and USD per workspace and tokens per action; Julius and Hex meter by credits and surface usage docs; Hex routes small chart edits to a lighter model. Metered follow-ups (Julius) make users ration verification — a product owner with the user's own key can turn that into a selling point by showing the real cost per turn.
8. **Scheduled work that reports back only when something changed, and stops when broken.** Elicit Routines, Pulse digests, Julius scheduled reports, Deepnote's pause-after-N-failures.
9. **Domain packs as skills loaded per data type.** Latch (built with assay vendors), Biomni-E1 (150 tools/59 DBs), Edison Analysis (flow cytometry, RNA-seq), SciSpace's 2,600 agents. The one-click workflow is a skill plus a QC-first template, not a model.
10. **Context that travels with the artefact.** Colab's notebook-level Custom Instructions and Learn Mode; Deepnote Skills with sources and permissions; Hex workspace rules and endorsed tables.
11. **Literature grounding through MCP.** Consensus, Scite and Elicit all ship MCP servers for Claude; the integration cost for a Claude-based host is a catalog entry.
12. **Session amnesia is the anti-pattern.** Latch's isolated sessions force users to write summary files; ChatGPT's "Sources" and Acabox's chat links/memory are the counter-pattern.
13. **The non-AI bar is Prism.** Assumptions checklists, effect sizes with CIs by default, linked data→figure updates, and a real export dialog. No AI tool in this group matches it yet.

---

## What Acabox could take from each (with model calls per use)

Status per CLAUDE.md: present / partial / absent / unknown. "0" means no model call beyond the turn the user already pays for.

### From Julius

- **On-drop data preview + three starter questions** (status: partial — spreadsheet viewer exists, no profile/suggestions). Host computes rows, columns, dtypes, NA% and min/max with pandas/duckdb when a CSV/XLSX is attached or opened, and offers templated questions by column type ("plot X over time", "compare Y across groups"). **0 model calls** (templated); an optional model-written set of suggestions would be 1 small Haiku call per new file hash — not recommended.
- **"Freeze this analysis" (the stamp icon)** (partial — tools are code, but there is no gesture to pin an ad-hoc analysis the agent ran in chat). A button on a successful analysis turn that writes the exact Python executed into the tool's notebook step so re-runs are byte-identical. **0 calls** at re-run; creation uses the turn already paid for.
- **Cost meter** (absent). The SDK's `result` message carries usage/cost per turn; show "$0.42 · 26 steps" on the fold line, per-chat totals in the header, and a monthly total in Settings. **0 calls.** This is the one place a bring-your-own-key product beats every metered competitor.
- **Warning from Julius's notebook sunset.** Do not let "the model is good at long tasks now" erode the tool-as-artefact model; the artefact is what makes a result re-runnable. **0 calls.**

### From Hex

- **Pending-changes review after a tool-editing turn** (absent). The agent's Write/Edit events already name every file; show a "What changed" card (files, line counts, rendered preview link) with per-file **Revert** from a pre-turn snapshot of `.applications/<dir>`. **0 calls.** For non-coders, the diff is secondary — the rendered before/after of the tool is the review surface.
- **"Endorsed" context for local data** (absent). A per-shared-folder `DATA.md` (column meanings, units, exclusions) the agent drafts once and the user confirms; injected through `workspaceDirectoriesGuidance`. **1 call per dataset at creation, 0 thereafter.** Fixes the Julius "revenue computed differently tomorrow" failure for local files.
- **Route small chart edits to a cheaper model** (absent). In a tool's side panel, requests matching "legend / colour / axis / title / tooltip" default to Haiku; escalate on failure. **Still 1 call, at a fraction of the cost.**
- **Queue a correction while the agent works** (unknown — `sendMessage` into a live session exists; composer UX not described). Accept a follow-up mid-turn and append it to the running turn. **0 extra calls.**
- **Hand this to an expert** (absent). Export a tool's notebook step + inputs as a `.ipynb`/script bundle for a bioinformatician to audit. **0 calls.**
- **Fix with agent / Quick fix from error states** (present for build failures via "Ask Claude to fix it"). Extend to runtime errors inside a running tool: the bridge catches an exception and offers a one-click fix turn with the stack trace and the rendered chart attached. **1 call per fix.**

### From Deepnote

- **Ask vs Edit toggle in the tool side panel** (absent). "Ask about this tool" runs with Write/Edit/Bash-write disabled so a curious non-coder cannot accidentally rewrite a working tool. **0 extra calls; saves calls.**
- **Immutable run snapshots** (partial — job registry, `run_metadata.json`). Each tool run writes `tool-data/<dir>/runs/<stamp>/` with input hashes, the executed code, outputs and environment versions; "Compare with previous run" in the viewer. **0 calls.**
- **Reject all changes from this turn** (absent). One button restoring the pre-turn snapshot (pairs with the pending-changes card). **0 calls.**
- **Scheduler pauses after N consecutive failures and files a "Needs attention" item** (absent). **0 calls, and it stops burning model calls on a broken task.**
- **AI usage dashboard** (absent). Settings → Usage: calls, tokens and USD per chat and per tool, from SDK results. **0 calls.**

### From Colab

- **Editable plan before a tool build** (partial — plan prompts exist). For "build me a tool" requests, show the plan as an editable checklist and start writing only on approval. **~1 extra call** (the plan step), paid back by fewer rebuilds.
- **Per-tool instructions that travel with the tool** (partial — global custom instructions exist). `INSTRUCTIONS.md` in the tool directory, injected into that tool's chats and included in export. **0 calls.**
- **Learn Mode** (absent). A side-panel toggle that asks the agent to explain each step instead of doing it. **0 extra calls** (same turn, different prompt).

### From ChatGPT

- **Inline interactive charts in chat replies** (partial — charts live in tools). Let the agent emit a small Plotly JSON block that the thread renders with the existing `plotTheme`, with PNG/SVG download. **0 extra calls.**
- **"Sources" footer on a reply** (absent). List the skills, memory files, referenced chats and data files the turn read (from Read/tool events). **0 calls.**
- **Report Pages** (partial — tools can be published). "Export report" renders a static HTML page (text + figures + method) through the existing Cloudflare Worker, with comments as a Worker feature. **0 calls** for the page; the write-up itself is the turn already paid.

### From Elicit

- **Every number links to how it was made** (absent). In the bridge, stamp each `executeCode` result with its cell id and input file hash; a hover/click in the tool shows the code and input rows. **0 calls** (UI); an on-demand plain-language explanation would be 1 call.
- **Routines: report only what changed** (partial — scheduled tasks exist). A scheduled task runs the deterministic step first and compares the output hash with the last run; the model is invoked to summarise only on change. **0 calls when nothing changed; 1 when it did.**
- **Monthly usage pool rather than per-workflow caps** is moot for own-key users; what transfers is **showing the pool**: a "this month" cost line. **0 calls.**

### From Consensus / Scite / Undermind

- **Catalog entries for Consensus, Scite and Elicit MCP** (partial — custom connectors are possible today). One entry each in `CONNECTOR_CATALOG`. **0 host calls**; the agent's tool calls happen inside turns the user already runs.
- **Quote-on-hover citation chips** (partial — `AnchorWithDoi` exists). When a connector returns a quote with a DOI, render the chip with the quote in a tooltip. **0 calls.**
- **Clarifying questions before a long job** (partial). A skill rule: for analyses expected to exceed a few minutes, ask up to three clarifying questions first. **0 extra calls** (same turn).
- **Alerts on new evidence** map onto Routines above.

### From FutureHouse / Edison

- **"Computed from your data" vs "Interpretation" sections** in every tool report and every analysis reply (absent). A skill instruction; the UI styles the two blocks differently. **0 calls.** The 85%-vs-58% accuracy gap is the one-line justification to show users.
- **Progress artefacts for long runs** (partial — fold line and Activity exist). Add "Show me what you have so far" during a long turn, and an OS notification plus Activity digest at completion (notifications are an explicitly deferred Acabox item). **1 call for the interim artefact; 0 for the notification.**
- **Trajectory page per job** (present in spirit — jobs and Activity). Link each Activity row to the fold of the chat turn that produced it. **0 calls.**

### From Biomni

- **Plan for review + intervene at any step** (partial). Same plan card as above, plus a visible "Stop and redirect" during execution (Stop exists; redirect = queue a correction). **0 extra calls.**
- **Curated science skill pack** (partial — ten database skills; the differential-expression skill is documented as unrunnable). Fix or retire the broken skill first (pydeseq2), then add scRNA-seq QC, flow cytometry gating summary, qPCR ΔΔCt and dose-response skills, each scaffolding a tool whose first screen is the standard QC figures. **0 marginal calls at runtime.**
- **State the privilege model plainly.** Biomni warns in its README; Acabox's agent has unrestricted Bash and advisory read-only dirs. A Settings line that says so is honest and free. **0 calls.** A real read-only hook (PreToolUse) is 0 calls too and is already listed as a known hazard.

### From Latch

- **Skills loaded per data type with QC first** (partial). Detect the data type from the file (FCS, h5ad, counts matrix, plate reader CSV) host-side and load the matching skill into the turn. **0 calls** for detection; the analysis turn is the one the user already runs.
- **"View the code behind this chart"** in the mini-app chrome (unknown — tool cards show code in chat, not in the tool). Bridge exposes the notebook cell for the current figure. **0 calls.**
- **Verification by intermediate plots** — make the QC plots the default first tab of a scaffolded analysis tool, so the user's trust surface is a picture, not a p-value. **0 calls.**
- Already right: Acabox's memory and chat links avoid Latch's session amnesia.

### From GraphPad Prism

- **Assumptions checklist on every inferential result** (absent). A shared `@reusable/statsChecks.py` (normality, variance homogeneity, n per group, paired/unpaired) whose output the tool renders as a checklist beside the test; skills instruct the agent to call it. **0 calls** (deterministic).
- **Effect sizes with CIs by default** (unknown). Same helper; **0 calls.**
- **Export dialog**: PNG at 300/600 dpi, SVG, PDF, width presets for single/double-column figures, transparent background (unknown — Plotly supports it; whether tools expose it is not stated). A standard export control in `plotTheme`/the bridge. **0 calls.**
- **Linked updates**: tools already recompute from data; surface "data changed since this figure was made" by comparing input hashes. **0 calls.**

### From Tableau

- **Deterministic metrics, narrated on change** (partial). For scheduled tasks: compute the metric in the tool's notebook, compare with thresholds host-side, and call the model only to write the sentence when a threshold trips. **0 calls on quiet days; 1 on alert days.**
- **Certified / last-modified cues** on tools and data folders (absent). Show who/when last changed a tool and whether its data dictionary is confirmed. **0 calls.**
- **Digest delivery** (absent — notifications deferred). OS notification and an Activity digest; Slack/Teams via existing connectors if configured. **0 calls.**

### From Power BI

- **"Approved data" friction treatment** (absent). If a folder has no confirmed `DATA.md`, analyses over it carry a muted "unconfirmed data dictionary" note; confirming removes it. **0 calls.**
- **Verified answers = pinned analyses** (absent). A user can pin a tool's result as the canonical answer to a phrasing ("What is the mean titre by group?"); the agent is told to reuse the pinned tool instead of recomputing. **0 calls, and it avoids calls.**
- **"How Claude arrived at this"** maps onto the provenance view above. **0 calls.**

### From Observable

- **Static report publishing** already exists via Cloudflare; the "AI that teaches" framing maps onto Learn Mode. **0 calls.**

### From Jupyter AI / Positron

- **Restricted approval mode** (absent by design — auto-approve). An optional "Careful" mode using the SDK's `canUseTool` to ask before writes outside `.applications/<dir>` and `tool-data/<dir>`. **0 calls.** Default stays as is.
- **Attach the rendered chart to a fix turn** (partial — screenshot capture exists). When a user says "this chart looks wrong", auto-attach a capture of the tool's figure and the cell code. **1 call** (the fix), with better odds of success.
- **Copy the code behind a point-and-click action** — same as "view the code behind this chart". **0 calls.**

### From Benchling / Potato

- **Data-quality check on open** (absent). Deterministic report when a CSV/XLSX is opened or attached: duplicate rows, NA%, mixed-type columns, suspicious outliers, inconsistent decimals. **0 calls.**
- **Numbers come from code, not prose** (partial — implied by the tool model). A skill rule plus an optional host lint that flags numerals in an assistant reply that do not appear in any tool output of the turn. **0 calls.**

### Priority view (zero-call items first)

1. Cost meter per turn and per month (0) — unique advantage, trivially available from SDK results.
2. Pending-changes card + per-turn snapshot + Reject all / Revert (0) — the approval surface every peer shipped.
3. Provenance per number + "view the code behind this chart" (0).
4. Assumptions checklist + effect sizes helper + export dialog (0) — the Prism bar.
5. On-drop profile, data-quality check, starter questions (0).
6. Immutable run snapshots + "data changed since this figure" (0).
7. Scheduler: pause-after-N-failures; summarise only on change (0 on quiet days).
8. Confirmed data dictionary per folder (1 call once per dataset) + "approved data" cue.
9. Haiku routing for small chart edits (cheaper 1).
10. Editable plan before builds (~1 extra call) and Ask/Edit, Learn Mode toggles (0).
11. Connector catalog entries for Consensus/Scite/Elicit (0 host calls).
12. Domain skill pack with QC-first scaffolds; fix the broken differential-expression skill (0 marginal).

---

## Caveats — what could not be verified

- **Web-search budget ran out** after round two (session cap), so rounds three and four were direct fetches; some pricing/feature snapshots are from aggregators and are labelled "secondary".
- **Julius**: the "Learning Sub Agent" and scheduled-report delivery to Slack/email rest on aggregator copy; the Credits doc page 404'd. The pricing shift from messages (Apr 2026) to credits (live page Sept 2026) is observed from two snapshots, not from a vendor announcement.
- **Hex**: user sentiment (G2) not reachable; Context Studio launch date (2026-01-28) from a search summary only.
- **Deepnote**: no user reviews gathered; pricing and docs are vendor pages.
- **ChatGPT**: release notes were read through a proxy copy of help.openai.com; PNG/SVG export detail is from 2024-era coverage and secondary 2026 blogs.
- **Elicit**: the 94%/94–99% accuracy figures are vendor claims from a post not fetched; the individual Research Agent and Routines posts 404'd via proxy, so their details come from the blog index and homepage copy.
- **Consensus**: "up to 50 papers" and the custom-output list for Deep Search come from a search summary of the changelog, not the fetched text.
- **Edison**: current pricing unverified (page 404); "650 credits/month for academics" and "founding offer retired" are from a secondary blog.
- **Latch**: "Latch MCP (June 2026)" not reached; agent.bio demo page showed a benchmark post, not the product.
- **GraphPad**: the absence of AI is confirmed on GraphPad's own pages as of 2026-09-30; the "dual-AI assistant" claim is from a third-party distribution page and should be treated as false.
- **Observable**: product pages were rate-limited; the AI interaction model in Observable Desktop is unverified.
- **Biomni**: the biomni.stanford.edu page rendered only headline copy; free access is from the May 2025 launch tweet and README, not a pricing page.
- **Acabox status** is judged from CLAUDE.md only: items like figure export controls, effect-size reporting, "view code behind a chart" and mid-turn queued prompts are marked unknown rather than absent.
