# OpenAI and Google consumer surfaces — what they do for non-technical users, and what Acabox could take

Research group: **OpenAI (ChatGPT, Codex) and Google (Gemini app, Opal, NotebookLM/Gemini Notebook, AI Studio Build, Colab Data Science Agent, Jules, Gemini CLI, Gemini in Sheets/Docs, Workspace Studio)**.
As of: **2026-09-30** (OpenAI DevDay was 2026-09-29; Google shipped Gemini "skills" on 2026-09-30, so this is a snapshot taken on a very busy week).
Audience for the judgement calls: non-technical scientists who can only "vibecode" — no terminal, no code reading, no build debugging.

## 0. Method and verification key

- First pass: ~45 web searches (standard + extended) across both ecosystems; second pass: ~55 fetches of official changelogs, help pages and detailed third-party write-ups. The session's search budget ran out after the second wave, so the last gaps were closed with fetches of URLs already surfaced.
- `help.openai.com` and `openai.com` return **HTTP 403** to the fetcher, so every ChatGPT help-center claim below comes either from the official **learn.chatgpt.com** docs (which did fetch), from a dated third-party article that quotes the help center, or from a search-result summary of the official page. Google's `gemini.google/release-notes`, `support.google.com/gemini`, `blog.google`, `jules.google` and `workspaceupdates.googleblog.com` all fetched directly.
- Tags used throughout:
  - **[verified]** — read in a fetched source (official where possible).
  - **[reported]** — appears only in a search-result summary or a single third-party article; plausible, not independently confirmed.
  - **[unverified]** — could not be confirmed; treat as a lead.
- Acabox status judgements use only the repo's `CLAUDE.md` (the other reviewers audit the code). "unknown" where `CLAUDE.md` is silent.
- Model-calls-per-use is stated for every idea in §12, per the owner's cost-vs-UX rule.

---

## 1. OpenAI — ChatGPT

### 1.1 The September 2026 landscape (plans, models, the DevDay reshuffle)

**Plans and prices** [verified — theaicareerlab.com plan guide, Sept 2026; learn.chatgpt.com/docs/pricing]:
Free $0 · Go $8 · Plus $20 · Pro $100 (5× Plus) · Pro $200 (20× Plus) **paused to new sign-ups since 2026-09-10** · **Pro 500 ($500/mo)** launched 2026-09-29 with "Astra Ultrafast" · Business $25/user · Enterprise. Default models by plan (Sept 2026): Free/Go **GPT-5.6 Luna**; Plus **GPT-5.6 Sol** with a "thinking slider"; Pro adds **Sol Pro** and **GPT-6 Astra** (~50 messages/week in regular chat). Free and Go: no Sites, no custom GPTs; Codex/Work limited to **GPT-5.6 Terra** on desktop. Plus: "full Codex and Work agent", Sites, custom GPTs, no ads.
Model line in the official Codex changelog [verified — learn.chatgpt.com/docs/changelog]: **GPT-6 Sol / GPT-6 Luna** (2026-09-22/25), **GPT-6.1 Sol** (2026-09-29, "near-Astra performance … at a lower cost", now the default in Codex CLI). **GPT-6 Astra** introduced 2026-09-03 [reported — releasebot aggregation of the official release notes].
**Usage transparency pattern** [verified — theaicareerlab]: limits are "shown in-product rather than on the pricing page"; the guide notes image caps are "observed numbers, not published caps". I.e. OpenAI tells you your allowance *inside* the product, at the moment it matters, not in a table.

**DevDay 2026-09-29** turned ChatGPT into something closer to an office suite [verified — the-decoder, TechCrunch, 9to5Mac, runtimewire; Axios 403]:
- **ChatGPT Space** — a shared team workspace (Pro, Business, Enterprise; desktop + web) holding **Pages**, files, chats, tasks and "dots". Pages are "a new type of document, built for human and agent collaboration" where you "write, research, generate charts, create images, or visualize information"; pages can carry "charts, images, checklists and dashboards" and ChatGPT "can build pages around the work a user needs to complete". **Slides** (collaborative decks, PPTX/Google Slides export) announced, "rolling out in coming weeks".
- **dots** — "always-on" agents that "work 24/7 for you, learn from your feedback, have their own computer, browser and can be connected to over 4k apps"; powered by Astra; included in Pro and **do not consume standard usage allowances** [verified — 9to5Mac]. How a user creates one and how approvals work was **not** in any fetched coverage [unverified].
- **Team Tasks** (Business/Enterprise) — delegate recurring responsibilities (weekly updates) to ChatGPT; an **MCP Events specification** lets automations fire "from connected-app events" (e.g. a new card on a project board drafts a plan) [verified — the-decoder].
- **Meetings plugin** — records on macOS, writes notes + next steps into Space; sharing controls "not spelled out" [verified — runtimewire].
- **Plugin extensions** — interactive panels inside ChatGPT; **shareable profiles** showcasing a user's Sites and plugins; **Sign in with ChatGPT** lets Plus/Pro users spend their ChatGPT allowance inside 16 partner apps [verified — the-decoder].
- Codex: **Codex Cloud** reusable environments, code review in the desktop app, voice steering, `/agents` view, Security Cloud — see §2.

What matters for Acabox: the product that started as a chatbot now ships *persistent artefacts* (pages, sites, slides) with agents attached, and bills "always-on" work outside the normal allowance. The direction of travel is "chat is where you *start* work; the output lives somewhere durable and shareable".

### 1.2 Canvas → writing blocks and code blocks (removed 2026-05-28)

- **Removal** [verified — felloai.com; theaicareerlab.com June 24 2026]: "canvas will no longer be available in GPT-5.5 Instant or GPT-5.5 Thinking" from **2026-05-28**; paid users keep classic Canvas "for a limited time through legacy models until those models are sunset".
- **What replaced it**: **writing blocks** (enhanced 2026-06-08) — editable text areas *inside the reply*; you type directly into the block or ask ChatGPT to revise; longer pieces "open in full-screen editors with table of contents and Library saving". **Code blocks** (upgraded 2026-02-19) — "more interactive", with inline editing, "diagram/mini-app previews" and a split-screen review view. Previews cover HTML, React, SVG, Mermaid and Vega/Vega-Lite; supported Python runs with console output [reported — ai-toolbox.co summary; consistent with felloai].
- **What was lost** [verified — felloai]: Canvas's **version history/back button** became ordinary undo/redo — "not a like-for-like replacement"; the **shortcut menus** (suggest edits, adjust length, reading level, add emoji / code review, port to language, fix bugs, add logs) have "no documented replacements, requiring users to describe changes verbally".
- **Interaction lesson**: OpenAI judged a second side-panel surface too heavy and moved the editable artefact *into the message stream*; the trade was losing explicit version history and one-click edit affordances, which users noticed.

### 1.3 Projects

[verified — memorylake.ai, 2026-09-17; reported limits from gizmotimes/memx summaries of the help page]
- A project = files + custom instructions + chats as an isolated workspace. **Project instructions override global custom instructions** inside it. Project files are reused as context across the project's chats. File limits mid-2026: **Free 5, Plus 25, Pro/Business/Enterprise 40 per project** [reported].
- **Default vs project-only memory**: project-only means "your previously saved memories are not referenced in project chats" and nothing leaks out; **ChatGPT Work is unavailable** in project-only projects. Since **2026-08-14** an unshared project can be switched between the two modes [reported]; switching to project-only "removes information from that project from memory used outside the project"; changes "take several hours to take effect".
- **Shared projects force project-only memory and lock it permanently**.
- Gap users flag: project-only memory has **no browsable memory list** to inspect or edit [reported — memorylake].
- Scheduled tasks created inside a project **cannot access that project's files** [verified — ai-toolbox tasks guide].

### 1.4 Memory

- Two layers: **saved memories** (explicit, editable list) and **reference chat history** (implicit recall), both under Settings → Personalization → Memory [reported].
- **Memory summary page** (controls added **2026-06-12**) [verified — reconn-ai]: a page showing the memories ChatGPT synthesised from your chats; you can "highlight any text in the memory summary to make a specific correction" or type a change, delete individual items, or "delete and turn off memory" without deleting past chats. "Still rolling out across plans and countries".
- **Memory Sources** [verified — beginnersinai]: responses can show "what context was used to personalize" them, with controls.
- **"Dreaming V3"** (2026-06-04, Plus/Pro US) [reported — tech-insider]: a post-conversation synthesis step decides what to carry forward instead of a flat fact list.
- **Per-chat memory toggle + save-to-history option** (Android beta, 2026-08-20) [reported — cryptonomist].
- Trust pattern worth copying: memory is *inspectable and correctable at the sentence level*, and the model can say which memory shaped an answer.

### 1.5 Scheduled tasks (and event-triggered tasks)

[verified — ai-toolbox.co 2026 guide quoting the help page; limits also in usecarly/growthacademy summaries]
- Create by asking in chat ("summarize news tomorrow morning") or from the **Scheduled page in the sidebar**; ChatGPT confirms the schedule; results arrive as **push and/or email** (Settings → Notifications). One-time or recurring; Free/Go get flexible windows (morning/afternoon/night) and **once a day**; paid plans get exact times and **up to hourly**.
- Active-task caps: **Free/Go 3, Plus 5, Business/Edu 10, Pro/Enterprise 15**; you must pause/delete to add more. Tasks **auto-pause** when inactive, awaiting approval, or when the originating chat is deleted. Not supported: voice, GPTs; tasks are **excluded from data exports**; project tasks can't read project files.
- **Event-triggered tasks (via ChatGPT Work, Plus and above)**: respond to **Gmail, Slack or GitHub** activity, capped at **30 runs/hour and 720/day** across all event tasks.
- **Task sharing**: copy a task link so someone else can schedule their own copy (without your chats/files/connected data).
- Finding tasks: sidebar "Scheduled", Settings → Notifications → Manage tasks, or the chat's "…" menu.

### 1.6 Agent mode / Operator / Atlas → Work and Codex

- **Operator** (Jan 2025, Pro) → **ChatGPT agent** (July 2025) merged Operator + deep research into one mode: virtual computer, narrated step view, "watch it work" desktop view vs activity view, **takeover mode** for logins/payments, **confirmation before consequential actions**; ~40 agent messages/month on Plus, ~400 on Pro [verified — agensi.io, techtarget (July 2025)].
- **ChatGPT Atlas** (macOS browser, launched 2025-10-21) was **discontinued 2026-08-09**; in **March 2026** OpenAI announced folding Atlas, the ChatGPT desktop app and Codex into **one desktop application** [verified — Wikipedia]. Criticism: "Tainted Memories" CSRF into memory, prompt-injection surface, Anil Dash's "anti-web browser".
- **Agent mode retirement**: a search-result summary says the help center now reads "ChatGPT agent is no longer available" and points to **ChatGPT Work** for multi-step tasks and a **cloud browser in ChatGPT** for browser workflows (early Aug 2026, no deprecation notice) [**unverified** — the help page is 403 to the fetcher and the only fetched article on agent mode predates it]. The July 2026 desktop merge (§2.1) is consistent with this.

### 1.7 ChatGPT Work

[reported — zentor.ai (single detailed source); corroborated indirectly by the official Sites and pricing docs, which treat "Work" as a plan feature]
- Introduced in the **July 6–10, 2026** update as the agent for "everyday professional tasks rather than coding": "create the report", "compare options", "prepare the deck". Produces "reviewable documents, spreadsheets, presentations, **Sites**, and other finished work"; reads files and **plugins** (`@` to invoke one); uses connected apps (Gmail, Drive, Slack) when authorised; hosts the **event-triggered tasks** above. Sept 2026: a **Data plugin** for Work and Codex to "analyze connected business data, build dashboards, and refine answers" (2026-09-10) [reported — releasebot]; Voice in Work on web/iOS/Android (2026-09-23) [reported — releasebot].
- Positioning rule from the same source: Work "pulls tasks toward documents, research, files, apps, and recurring operations. Codex pulls tasks toward repositories, environments, tests, diffs, and merge reviews."

### 1.8 Deep research

[verified — Wikipedia (ChatGPT Deep Research); reported — coursera, prismer, kime summaries]
- Launched Feb 2025 on o3; **GPT-5.2-based since Feb 2026**. Browses 5–30 minutes, returns a cited report; takes text, images and PDFs as inputs. Limits (Jan 2026): **Free 5/month, Plus/Team ~25, Pro ~250**; a "lightweight" tier kicks in when the full allowance is spent.
- Trust issues the research community documents: "occasionally makes factual hallucinations … or incorrect inferences", may "reference rumors without clearly conveying uncertainty"; it searches the **open web, not PubMed/JSTOR/Semantic Scholar**, paywalled papers excluded; **cites ~15% of pages retrieved** [reported — kime.ai]. Verdict quoted: "for academic research requiring peer-reviewed sources, it's unreliable".

### 1.9 Advanced data analysis (file uploads, charts)

[verified — datastudios.org architecture article (May 2025, updated Sept)]
- Flow: upload (CSV/XLSX/JSON/PDF tables, or link **Google Drive / OneDrive**), ask in plain language, ChatGPT writes and runs **Python in a sandbox**, returns **interactive tables and charts** (hover values, swap axes, export **SVG/PNG**, data **CSV/XLSX**), full-screen table view.
- **Provenance affordance**: the code is behind a collapsible **"View analysis"** disclosure — "you can inspect or rerun the precise" code that produced an output.
- **Error handling is silent**: "the model reads the traceback as text and patches its own code. You rarely see this dance."
- Hard limits: ~**2 minutes** of sustained compute; RAM for "a few million spreadsheet rows"; **no GPU, no pip install, zero internet**; the container **expires after ~1 hour idle**.
- Non-technical complaints [reported — qwe.edu.pl, fileuploadgpt, OpenAI community]: the sandbox **resets mid-analysis** and files vanish while the model keeps referencing `df` ("NameError: name 'df' is not defined"); XLSX files rejected for hidden weight (styles, cached pivots); PDF tables flattened so "the model is guessing which number belongs to which row"; **uploaded files later unretrievable** — "entire creative ecosystems … lost overnight"; no full-history export. These are exactly the failure modes a *local, persistent* tool avoids by construction, and worth saying so in Acabox's own positioning.

### 1.10 Apps SDK → connectors → plugins; custom GPTs retire 2026-12-11

- **Apps SDK** (announced 2025-10-06; MCP-based; launch partners Booking.com, Canva, Coursera, Figma, Expedia, Spotify, Zillow) let third-party apps render interactive UI inside a chat; connectors "became apps that can add interactive UI, search, deep research, sync, and write actions" [reported — intuitionlabs/usecarly summaries]. Custom MCP connectors via developer mode are beta on Plus/Pro/Business/Enterprise/Edu but **write-capable custom connectors are restricted to Business/Enterprise/Edu**; Plus/Pro individuals get read/fetch-only [reported — usecarly].
- **Plugins** (official docs, fetched via the apps-sdk redirect) [verified — learn.chatgpt.com]: a plugin = **skills** (repeatable workflows) + **MCP servers** ("live data and controlled tools") + optional **UI resources/components**; there is a submission/review process for remote MCP servers.
- **Custom GPTs retire** [verified — virtualizationreview 2026-09-28]: announced **2026-09-11**; Enterprise stops new GPT creation **2026-10-26**; general retirement **2026-12-11**; approved Enterprise deferrals to **2027-02-11**. Migration from "My GPTs" converts instructions → a plugin skill and knowledge files → reference files (reported to take about a minute); **does not transfer** existing conversations, chosen model, **custom actions** (must be rebuilt) or sharing settings; OpenAI warns "a migrated plugin may respond differently". Plugins "work across ChatGPT and Codex through a universal directory".
- Pattern: both vendors (see Gemini skills, §3.2) have converged on **"a named, reusable instruction package with reference files and optional tools"** as the unit of customisation, replacing bespoke bots.

### 1.11 Record mode → Meetings plugin

[verified — sally.io review, April 2026; runtimewire, Sept 2026]
- **Record** (macOS desktop app only): press Record, system + mic audio captured locally, auto-stops at **120 min** (240 on some plans); ~60 s later a canvas with key takeaways, action items and a **searchable transcript with clickable timestamps**; raw audio deleted, canvas kept in chat history. No speaker labels, no calendar auto-join, audio only. Plan availability disagrees between sources (sally.io: Pro/Team/Business/Enterprise/Edu; other guides include Plus) [discrepancy].
- **Meetings plugin** (DevDay) saves notes and next steps into **Space**; sharing semantics unpublished.
- "Dictation that becomes a structured artefact" is the reusable idea; speaker-labelled meeting notes are not.

### 1.12 Desktop: Work with Apps; the merged desktop app

- **Work with Apps (macOS)** [reported — help-page title in search results; feature well established since late 2024]: Option+Space opens the Chat Bar; "Work With Apps" picks a compatible app (Apple Notes, Notion, TextEdit, Xcode, VS Code family incl. Cursor/Windsurf, JetBrains IDEs, Terminal/iTerm/Warp); content read via the **macOS Accessibility API**; terminals contribute the **last 200 lines** of open panes. Needs app version ≥ 1.2025.057.
- **One desktop app** (from **2026-07-09**) with a top-left picker between **Chat, Work and Codex**, each with its own history [verified — buildtolaunch]. See §2.

### 1.13 Pulse (proactive morning cards)

[unverified for 2026 — openai.com blocked; described from its Sept 2025 launch] Pulse researched overnight using chat history, memory and connected Gmail/Calendar and delivered a small set of morning "cards" (Pro, mobile first); users curated by requesting topics and thumbs-up/down; cards expired unless saved. Its 2026 form appears to be subsumed by Space/dots and Gemini's **Daily Brief** (§3.6) — the pattern ("while you were away, here is what matters, each card with a source") is what to note.

### 1.14 Library (files without re-uploading)

[reported — search summary of the official release notes] Box, Dropbox and SharePoint joined Google Drive in **ChatGPT Library**: browse/search files and add them to conversations "without uploading them again"; multiple Gmail/Calendar/Contacts accounts in one conversation. Acabox deliberately dropped cloud drives; the relevant bit is "files are a first-class, browsable, re-attachable library", which Acabox's workspace already is.

### 1.15 Sites (publish from a chat, with audiences)

[verified — learn.chatgpt.com/docs/sites; launch 2026-06-02 per buildtolaunch; "publish dashboards, games, internal tools … with shareable links" per howdoiuseai 2026-08-16]
- Public beta on **Plus, Pro, Business, Enterprise, Edu**. Trigger by saying "website" or `@Sites`. Hosts "websites, web apps, and games" including apps with **persistent data (D1 relational DB, 10 GB)**, file storage (R2) and authentication.
- **Two-stage publishing**: *save a version* (a reviewable candidate) then *deploy* (live). "Every Sites deployment URL is a production deployment", e.g. `goblin-tales.openai.chatgpt.site`; custom domains via DNS where available.
- **Audience controls**: owner/admins only · selected users/groups · external invitations (rolling out) · workspace-wide · **public** (disabled by default in Enterprise); public sites can offer optional **Sign in with ChatGPT**. Editors can be invited; analytics on non-Enterprise sites.
- This is the closest analogue to Acabox's Cloudflare-Workers sharing, and its two things worth copying are the *version-then-deploy* step and the *audience picker*.

### 1.16 What non-technical ChatGPT users praise and complain about (2026)

Praise: in-place editable blocks; charts you can hover; tasks that "just run" with a push notification; memory you can read and correct; Record producing something structured without a separate tool.
Complaints: Canvas removal lost **version history and one-click edit menus**; data-analysis **sandbox resets and lost files**; wrong numbers from flattened PDFs; deep research cites a small fraction of what it read and misses paywalled literature; agent mode and Atlas **vanished without notice** (a churn of surfaces — Canvas, Operator, agent, Atlas, custom GPTs — all retired within ~15 months); plan limits "shown in-product" means you discover the ceiling by hitting it.

---

## 2. OpenAI — Codex (and how non-developers are onboarded)

### 2.1 Surfaces and the merge

[verified — learn.chatgpt.com/docs/app, docs/pricing, docs/changelog; buildtolaunch; blakecrosley guide]
- Five surfaces: CLI, desktop app (**macOS, Windows, Linux**), IDE extensions (VS Code/JetBrains), **Codex Cloud** tasks, browser extension. Since **2026-07-09** Codex is a mode of the ChatGPT desktop app. Included on **every** plan (Free→Enterprise).
- Key dates (2026) [verified — buildtolaunch's dated list; learn.chatgpt.com]: Sites 06-02 · Import from Claude Code/Cowork 06-09 · **Record and Replay** 06-18 · **Codex Remote** GA 06-25 (drive desktop tasks from the phone via QR pairing) · merge into ChatGPT desktop 07-09 · improved dangerous-command detection in CLI 07-16 · Sept: GPT-6 Sol/Luna, **conversation forking ("f")**, **instant interrupt** to steer mid-response, terminal-input approval on by default, OAuth for MCP servers, Mermaid rendering, `/import` in remote sessions.
- Usage claim [verified as quoted — buildtolaunch quoting OpenAI]: "More than 5 million people use it every week, and over a million of them for work that is not coding at all."

### 2.2 How a non-developer is onboarded

[verified — mindstudio.ai setup guide, 2026-05-01; buildtolaunch]
- Settings → turn **"coding mode" off** and **"everyday work" mode on** — "shifts Codex's response style from technical output aimed at engineers to plain-language output aimed at people who need things done".
- Create a dedicated local folder (e.g. `codex-work`), point Codex at it via Projects, choose a **permission level**: default (approve each action), **auto-review**, or full access; optionally connect the Gmail plugin. Standard file formats (.txt/.docx/.xlsx/.pptx); "no coding knowledge or API keys needed". Examples: an Excel revenue model in 3 m 46 s; four Instagram carousel images from existing documents; Gmail triage; a weekly summary via automation.
- Cost guidance in the same guide: "monitor token usage in Settings … high reasoning consumes more credits than medium".

### 2.3 What the user sees while it works

[verified — buildtolaunch "4 real builds"; learn.chatgpt.com/docs/app]
- "Every file it touches" is listed; **parallel agents each get their own panel**; a **"pet" status indicator** shows live task progress; after completion a **diff review** lists touched files with +/− lines; **file annotations** — highlight text in a file and "Add to chat" drops the selection into the conversation (the same gesture as Acabox's quote-to-composer); "Create and inspect real outputs" (documents, spreadsheets, images) in the same workspace.
- **Record and Replay** (06-18) and **task memory** let a user iterate on a failed step rather than restart.
- Failures the author hit: rendering bugs produced invalid video files; it "nearly treated incomplete files as finished products"; and three long-running tasks "used most of my weekly allowance in a single day" on the $20 plan.

### 2.4 Approvals, sandbox, plan mode, steering

[verified — blakecrosley guide (Sept 2026); learn.chatgpt.com/docs/app]
- OS-level sandbox (Seatbelt on macOS, Landlock+seccomp on Linux); `approval_policy` **on-request** (ask before risky operations) vs never; sandbox `read-only` / `workspace-write`; network configurable; elevated terminal input requires fresh approval since 0.158.0. **Auto-review** in the app.
- `/plan` produces a reviewable outline before any execution; `/diff` shows working-tree changes; sessions resume and **fork**; instant interrupt (0.159.0) lets you redirect mid-response.
- AGENTS.md "is cross-tool" (Codex, Cursor, Copilot); `/init` scaffolds one.

### 2.5 Cloud tasks, reusable environments, automations

[verified — the-decoder DevDay Codex article; TechCrunch 2026-09-29; learn.chatgpt.com/docs/app]
- **Codex Cloud** reusable environments replace per-task sandboxes: a team shares a configuration "with approved settings and permissions"; a user resumes "from any device" (Plus, Pro, Business, Enterprise, Edu, Healthcare). Cloud tasks "may consume more allowance than local messages".
- **Automations**: "Create a standalone scheduled task or schedule a task inside an existing chat" — scheduling lives *in the agent app*, not a separate scheduler.

### 2.6 Cost model and visibility

[verified — learn.chatgpt.com/docs/pricing; blakecrosley]
- Allowances are **5-hour windows** plus weekly caps: Plus **5–45 local messages with GPT-6 Astra** or **350–3,000 with GPT-6 Luna** per 5 h; Pro "no fixed five-hour limit". The page is explicit that a message's cost varies with task size: "small scripts … may consume only a fraction of your allowance, while larger projects, long-running tasks, or extended sessions … will use significantly more per message."
- **Credits** extend usage; "a typical GPT-5.6 Sol task uses 5–30 credits"; credits per million tokens by model (GPT-6.1 Sol 50/2.5/250 input/cached/output; GPT-6 Astra 250/25/1,250). **Ultrafast** burns included allowance at **8×** and purchased credits at **6×** (Pro 500, Enterprise/Edu).
- **Where you see it**: dashboard at `chatgpt.com/codex/settings/usage`; in the CLI `/status` (session config, tokens, "estimated credits/cost") and `/usage` (daily/weekly/cumulative, earned reset credits, plugin/skill analytics); `/fast status|off` toggles the 2.5× fast tier. Jules does the same with a disabled button + tooltip (§8).
- Lesson: per-session **and** per-period cost is a first-class, always-available readout, and the tiering is explained in plain words ("a message is not a message").

### 2.7 Skills & plugins, MCP, Chrome extension

[verified — learn.chatgpt.com/docs/app; howdoiuseai 2026-08-16]
- "Skills & Plugins" and MCP are menu items in the app; plugins are shared with ChatGPT through one directory (§1.10).
- **Chrome extension** installed from the Codex Plugins menu lets Codex browse with the user's logged-in state (LinkedIn/X without APIs); it "requires extensive browser permissions — including access to your history, bookmarks, and page data", mitigated by **per-site confirmation**; not available in EU/UK.

### 2.8 Complaints

Allowance consumed by long tasks without warning; near-misses on "declared done but file invalid"; EU/UK gaps; the general "which of the three modes am I in" confusion a three-way picker invites; and (shared with ChatGPT) product churn.

---

## 3. Google — Gemini app

### 3.1 Landscape and the 2026 release-note timeline

**Plans** [verified — 9to5google 2026-05-25; Gemini release notes]: **AI Plus $7.99** (2× limits, 128k context) · **AI Pro $19.99** (4× limits, 1M context, 5 TB, YouTube Premium Lite) · **AI Ultra 5× $99.99** (Deep Think, 20 TB) · **AI Ultra 20× $199.99** (Project Genie, 30 TB). Deep Research: Pro 20/day (search), Ultra 75/day and 200/day; NotebookLM notebooks Plus 200 / Pro+ 500; Audio Overviews/day Plus 6 / Pro 20 / Ultra 100 / 200.

**Official release notes, 2026** [verified — gemini.google/release-notes]:
01-20 Personal Intelligence beta (Gmail, Photos, YouTube, Search; Pro/Ultra US) · 01-28 Gemini in Chrome side panel + **auto-browse preview** · 02-12 Gemini 3 Deep Think (Ultra) · 02-19 **Gemini 3.1 Pro** · 03-26 **import from other AI platforms** (preferences + full chat history via suggested prompts or a ZIP); "past chats" renamed **"memories"** · 04-15 **native Mac app** (Option+Space; "share your window, allowing Gemini to understand your context") · 05-19 I/O: **Spark** beta (Ultra, US, 18+), **Omni** video with avatars, **Daily Brief**, **Gemini 3.5 Flash**, Live inside chat, **multi-layer images + Video Overviews** as response formats, Ultra at $100, connected apps **OpenTable/Canva/Instacart** · 06-30 **Spark on macOS** (Ultra): "operates autonomously and under your direction", organises folders, builds documents, Workspace workflows · 07-21 **Gemini 3.6 Flash** ("multi-step projects through Canvas") · 07-29 **Fn-key dictation on macOS** into the active window · 08-19 student hub, study notebooks on mobile · 09-10 **Windows app** (Alt+Space; Gmail/Drive, Nano Banana, Deep Research) · 09-30 **skills replace Gems**.

### 3.2 Gems → skills (2026-09-30)

[verified — support.google.com/gemini/answer/18560919; blog.google "automate tasks with skills"; alphasignal for the Agent-Skills-spec claim]
- A skill = "reusable custom instructions" with a name, description, instructions and **reference files (text, PDFs, images)**; **100 active** at a time (unlimited created). Invoke with `/skill-name` (moving to `@`), **or let Gemini auto-apply**: "Gemini automatically recognizes when a skill is relevant to your current prompt and applies it for you". Skills **stack** (writing-style + brand-guidelines in one chat).
- Three ways to make one: **ask Gemini to build it from a chat** (blog: "build custom skills from your chats and automatically run them whenever you enter a matching prompt"), create manually in Settings → Skills, or **upload a folder containing `SKILL.md`** plus knowledge files (folder name lowercase-hyphenated, "Replace skill"). alphasignal reports the format is Anthropic's open **Agent Skills** spec [reported; Google's own pages don't say so]. GitHub files not supported. **Sharing** "in the coming weeks".
- Migration: Gems auto-convert — **personal accounts Nov 2026 (17th per alphasignal), Workspace Mar 2027, Education Jun 2027**; no new Gems after 2026-10-13 [reported]. **Opal shuts down on the same schedule** (blog) — see §4.
- For scientists: a skill with a PDF protocol attached that auto-fires when you ask a matching question is exactly the "knowledge loop" Acabox built; the difference is Gemini's **create-from-this-chat** gesture and auto-trigger being surfaced to the user.

### 3.3 Canvas (docs, apps, preview, console, versions, sharing)

[verified — support.google.com/gemini/answer/16047321; complaints from Gemini community threads and the AI Developers forum]
- Open via **Add Files → Canvas**, then prompt. Two kinds: **documents** (edit text directly, auto-saved; "Suggest edits"; quick buttons **Change length / Change tone**) and **code/apps** (web apps, games, Python; "edit the code directly in the Code view"; **"Select & ask"** to highlight a region and request a change). Formats: "Create a slide presentation about…", "Create a quiz to test me on…", web pages, custom visuals.
- **Live preview** and a **"Show console"** button for "errors and logs from the preview".
- **Version history**: "Click Previous Version or Next Version" to step through saved iterations.
- **Sharing**: Share & export → Share → `g.co/gemini/share` link; "anyone with this link can view and edit data associated with the app" (shared apps **run**, and their data is editable by viewers); shared links "only open in gemini.google.com". Export to Docs/Slides; Python to **Colab**. Third parties describe exporting a single self-contained HTML file to host elsewhere.
- Complaints [reported]: "Canvas tool is not showing previews" (Preview button never appears); apps "created before January 15, 2026 and working perfectly suddenly started failing … with API key/Gemini usage errors"; multi-user is "a tease" — "everyone gets their own version"; one user: "a nice concept … but completely useless". Praise: "amazing for the intended non-technical audience".

### 3.4 Deep Research

[verified — support.google.com/gemini/answer/15719111]
- Click Deep Research, optionally add files, **choose sources** (Google Search by default; **Gmail, Drive, uploaded files, NotebookLM notebooks**), prompt. Gemini shows a **research plan you can edit and must approve**, then takes **5–10 minutes**; the report carries citations; Ultra reports can include **charts, diagrams, schematics and interactive simulators** (not when Workspace sources are included). Export: Canvas link, Google Docs, **Audio Overview**, copy. Past reports require Keep Activity on. Limits: free 5/month on Flash [reported]; Pro 20/day; Ultra 75 or 200/day.
- The approve-the-plan step and the explicit source picker are the trust cues here.

### 3.5 Scheduled actions

[verified — blog.google 2025-06-06; limits reported by techwiser/datastudios]
- Say what and when in plain language, or **turn an existing chat into a scheduled action**; Gemini confirms; results arrive as **push notifications on mobile / in the web UI**; manage in a settings page; **10 active**; Pro/Ultra and eligible Workspace accounts. Examples: calendar + unread-mail summary at wake-up; "five ideas for your blog every Monday".

### 3.6 Spark (24/7 agent), Daily Brief, Personal Intelligence

[verified — blog.google "next evolution"; release notes 06-30]
- **Spark** "transforms Gemini from an assistant that can answer your questions into an active partner that does real work on your behalf": set recurring tasks or **triggers** (e.g. parse a card statement when it arrives), **teach it new skills**, build multi-step workflows across apps; cloud-based so it "keeps working in the background even when you close your laptop". **"Designed to ask you first before performing high-stakes actions like spending money or sending emails"**; "you choose whether to turn it on and what apps it connects to". On macOS (Ultra, from 06-30) it handles **local files and folders** and "automate[s] workflows across your desktop".
- **Daily Brief**: a morning digest from Gmail/Calendar/chats with suggested next steps. **Personal Intelligence**: opt-in grounding in your Google apps.

### 3.7 Desktop apps

Mac (04-15): Option+Space; **share your window** so Gemini sees your context; Fn-key **dictation into any app** (07-29). Windows (09-10): Alt+Space. [verified — release notes]

### 3.8 Connected apps, import, memories

Connected apps OpenTable/Canva/Instacart (05-19); **import** chats/preferences from other AIs by ZIP (03-26); "memories" page. [verified — release notes]

### 3.9 Complaints (non-technical)

Canvas preview/share flakiness and silently broken apps (§3.3); limits per tier are many and confusing (a whole cottage industry of "exact usage limits" posts exists); the Gems→skills switch required re-learning and Opal users lose their apps (§4); Spark is Ultra-only ($100–200/month).

---

## 4. Google — Opal (no-code mini-app builder; shutting down 2026-11-17)

[verified — bitdoze guide; fahimai review 2026-02-20; alphasignal; blog.google skills post]
- Launched July 2025 (US beta), later 160+ countries and embedded in the Gemini web app's Gems manager. You **describe an app**; Opal "automatically creates illustrated workflows showing each step, editable by anyone regardless of technical background" — a **node graph** of **User Input → Generate → Output** steps (plus an **Agent step** from 2026-02-24 that "plans an approach, picks tools and models itself"), with `@stepName.output` references between steps, **conversational or visual editing**, a **debug panel to step through the workflow**, a **template gallery** and a **remix** culture as the main onboarding. Publish = a Google-hosted URL usable by anyone with a Google account. Free; "no code export, no self-hosting, no external DB (Sheets only), no custom domain, no SLA".
- Reliability: the February review found **three of nine test apps still worked long-term**; "experimental and unstable"; "lacks governance, version control, and audit logs".
- **Shutdown 2026-11-17** with **no migration path**; Google says Opal influenced "the broader idea of packaging repeatable AI workflows" now carried by skills. Lesson: a Labs-grade hosted mini-app platform that ends abruptly is the cautionary tale for anyone whose tools live only in someone else's cloud — a *local* tool-builder's strongest argument.

## 5. Google — NotebookLM / Gemini Notebook

[verified — notebooklm-guide.com tracker (to 2026-08-25); glasp.co guide (Sept 2026); felloai; workspaceupdates 2026-09-25]
- **Renamed Gemini Notebook on 2026-07-16** (hostname → notebook.google.com with redirects). Runs on Gemini 3.5 models (June 2026).
- **Source-grounded chat with clickable numbered citations** that jump to the exact passage; answers only from the notebook's sources (the reason scientists trust it). **1M-token chat context, saved chat history, custom chat goals/personas** (Oct 2025).
- **Studio outputs** (one click each): Audio Overview, Video Overview (narrated slides; **six Nano Banana styles**; Brief format; **Cinematic** since 2026-03-04, Ultra), Mind Map, Report, Interactive Learning Overview, Flashcards, Quiz, Infographic, Slide Deck (editable by prompt, **PPTX export** — but slides are "image layers", a complaint), **Data Table** (qualitative text → structured comparison table, **exports to Google Sheets**, Dec 2025).
- **Agentic research (2026-06-08)**: "source-grounded code execution" on a **"secure cloud computer"** — run statistical tests, chart trends from data tables, clean messy CSVs, produce **spreadsheets, slide decks and downloadable outputs**; Ultra and some Workspace tiers first, Pro web weeks later. glasp.co dates the cloud computer to the July rename [discrepancy between sources on the exact date].
- **Deep Research inside a notebook** (Nov 2025) browses the web and offers sources to import; **Drive auto-sync** of Docs/Sheets/Slides sources (2026-05-26) so notebooks track living documents; notebooks usable as **sources in the Gemini app** (01-27) and as **grounding for Docs drafts** (2026-09-25); **Workspace Studio** can "Ask NotebookLM" in an automation (05-12) and auto-add sources (08-07); notebooks in **Search AI Mode** (08-19); **full notebook copying** (08-17); mobile **voice conversation + audio recorder** for lectures (2026-09-15).
- Limits [verified — glasp/felloai]: sources per notebook **Free 50 · Plus 100 · Pro 300 · Ultra 500–600**; notebooks Free 100 · Plus 200 · Pro/Ultra 500; Audio Overviews/day 6/20/100/200.
- Complaints: notebooks are **silos** (no cross-notebook search or knowledge graph); **compute budget opacity** — "Google has never published what one unit of compute buys"; long sources truncated in audio ("hallucinated summaries" of the back half); premium features land on expensive tiers first.
- Scientist takeaway: source grounding + per-claim citation + one-click artefacts is the trust model researchers like; the June 2026 code execution closes the "but can it compute" gap — in Google's cloud, with your PDFs and CSVs uploaded.

## 6. Google — AI Studio Build mode (+ Antigravity)

[verified — blog.google I/O 2026-05-19; codelab; buildfastwithai guide; medium deep-dive (403 on fetch, used via search summary)]
- At aistudio.google.com → **Build**. Entry points: a prompt ("be specific about features, not categories"), **AI chips** that add integrations (image generation, Maps, Gemini content), or **"I'm Feeling Lucky"** for an idea. The **Antigravity agent** (originally a standalone VS Code-based IDE, Nov 2025; folded into Build in March 2026) writes a **project plan across files**; the user's **first checkpoint is to review the plan and approve or modify before it writes code**; it then "runs tests in a built-in browser, catches errors, and fixes them autonomously"; Firebase provisioning for auth/DB is **approved separately**.
- **Annotation Mode**: "draw on your app preview to communicate your vision instantly" — mark a UI element and leave a comment like "make this font larger, digital, and glitchy" [verified — codelab]; **voice input**; persistent **System Instructions**; "Rebuild the application UI".
- Export/deploy: **GitHub** repo creation; **Deploy to Cloud Run** (billing-verified project; **first two apps free, no credit card** per I/O post); **Workspace access** to "build dashboards on top of your Sheets data"; export to **Antigravity** with history, files and secrets; **mobile AI Studio app** (pre-registration) to iterate and preview "from your pocket"; **native Android** (Kotlin/Compose, in-browser emulator, Play publishing).
- Cost: Build mode and the agent are free to use for prototyping; deployed apps pay standard Gemini API token costs; **who holds the key for a deployed app's calls is not spelled out in any fetched source** [unverified]. Limitation noted: "large refactors spanning many interconnected components can introduce unintended side effects".
- Non-technical user complaints [reported — Jan 2026 breakage threads overlap with Canvas]: apps breaking on key/quota changes; no clear production cost estimate.

## 7. Google — Colab Data Science Agent

[verified — towardsdatascience review (Mar 2025, consumer Colab); docs.cloud.google.com Colab Enterprise page updated 2026-09-24]
- Consumer Colab: **"Analyze files with Gemini"** → upload → describe the goal → the agent proposes a **numbered plan (e.g. 10 tasks: load, explore, clean, wrangle, features, models…) and waits for confirmation**; the plan can be re-prioritised in chat; it then **fills the notebook cell by cell in real time** so "users could observe code execution, errors, and warnings as they occurred"; on `DTypePromotionError` it diagnosed and dropped the column; on `ValueError` it added an imputer — **auto-fix in the open**. Weaknesses: mean imputation on skewed data; **follow-up requests stayed in chat and were not written back into the notebook**. Verdict: good for "researchers with clearly defined questions but limited coding skills"; experts still needed to validate methods.
- Colab Enterprise (2026 docs): Gemini toggle; CSV or BigQuery (`@mention`); each suggestion offers **Accept / Accept and run / Cancel**; generates Python/SQL/BigQuery ML/PySpark; pricing by data processed.
- The "plan → confirm → visible cell-by-cell execution with visible errors → auto-fix" loop is the most transferable pattern for a notebook-backed tool builder.

## 8. Google — Jules (async coding agent)

[verified — jules.google changelog; jules.google usage-limits]
- GA at I/O 2026 [reported]. Flow: pick a repo (or a **repoless** ephemeral environment), describe the task, Jules proposes a **plan** (interactive, asks clarifying questions); a **Planning Critic** (2026-01-26) reviews **auto-approved** plans before execution ("9.5% reduction in task failure rates"); it works in a VM, shows an **activity log**, produces a diff/PR; **CI Fixer** (2026-02-19) auto-detects failing GitHub Actions and re-pushes a fix; **commit authoring** choice (Jules-only / co-authored / you); **scheduled tasks** editable/pausable (01-26); **MCP** with vetted servers (02-02); memory of per-repo preferences; image upload for visual context; **Suggested Tasks** surface TODOs and performance bottlenecks.
- Limits shown in-product: **Free 15 tasks/day, 3 concurrent (Gemini 2.5 Pro) · AI Pro 100/day, 15 concurrent · AI Ultra 300/day, 60 concurrent**; at the cap "the new task button will be disabled" with a tooltip explaining why.
- For non-developers Jules is mostly irrelevant *as a product*, but the **critic-reviews-auto-approved-plans** and **disable-with-reason** patterns are reusable.

## 9. Google — Gemini CLI

[verified — geminicli.com latest (v0.61.0, 2026-09-23); reported — changelog summary]
- 2026: event-driven tool scheduler (02-03), **Plan Mode** `/plan` (02-17), `/prompt-suggest`, experimental **browser agent** (02-27), **real-time voice mode** (05-05), **export/import sessions to files** (05-22), unified Auto mode (05-27), tool-registry discovery (07-08), **prompt-injection defence and sandbox hardening** (09-23), Gemini 3.8 Flash support (09-30). Terminal-only; not a non-technical surface. Noted for parity with Codex: plan mode, voice, session export.

## 10. Google — Gemini in Sheets/Docs; Workspace Studio

[verified — workspaceupdates 2025-10-20 (Sheets multi-table), 2026-09-25/30 entries; reported — Sheets AI function availability]
- **Sheets**: side-panel prompts return **formulas** (e.g. XLOOKUP across tables), **charts inserted as editable chart objects that update with the data** (since 2025-06-09), **pivot tables**, conditional formatting; **multi-table analysis** (2025-10-20) with the user selecting/deselecting tables to focus attention; an `AI()` function, enhanced Smart Fill and data analysis listed for **personal AI Pro/Ultra** (Aug 2026). The update page does not say how a user verifies a result (no "show me the source cells") [gap].
- **Docs**: drafts can be **grounded on a Gemini Notebook** (2026-09-25) — "drafts grounded in a curated knowledge base".
- **Workspace Studio**: a no-code automation builder whose steps include **"Ask NotebookLM"** (2026-05-12) and that can **auto-add sources to notebooks** (08-07); the product page 404'd for the fetcher, so interaction details are [unverified].

---

## 11. Cross-cutting patterns (what both ecosystems converged on by Sept 2026)

1. **Chat is the entry point; the output is a durable, shareable artefact with an agent attached.** ChatGPT Pages/Sites/Space, Gemini Canvas apps, Gemini Notebook, AI Studio deploys. Acabox's mini-apps are already this; what the others add is explicit *versions*, *audiences* and *provenance* on the artefact.
2. **The unit of customisation is a named instruction package with reference files and optional tools, auto-triggered by the request.** OpenAI plugins (skills + MCP + UI) replace custom GPTs on 2026-12-11; Gemini skills (`SKILL.md` folders, auto-apply, stackable) replace Gems from Nov 2026; Opal dies the same month. Acabox's user-owned skills are on the winning side of this; the missing gestures are *create-from-this-chat* and showing the user *which skill fired*.
3. **Plan → approve → execute → visible self-repair.** AI Studio Build's first checkpoint, Gemini Deep Research's editable plan, Colab's numbered plan with confirmation, Codex `/plan`, Gemini CLI plan mode, Jules plans with a **critic for auto-approved plans**. Errors are either fixed *in the open* (Colab, Jules CI fixer) or *silently* (ChatGPT data analysis) — and users prefer seeing it.
4. **Version history is table stakes, and losing it is noticed.** The #1 complaint about Canvas's removal; Gemini Canvas keeps Previous/Next Version; Sites separates "save a version" from "deploy"; Codex has Record & Replay and forking; vibe-coding guides talk about "recovery points".
5. **Cost is shown at the moment of use, in plain words.** Codex `/status` and `/usage`, a usage dashboard, "a small script may consume a fraction … a long session much more"; Jules disables the button and says why; ChatGPT shows limits in-product. The one product that hides it (NotebookLM compute) gets called out for it.
6. **Background agents are a separate, metered thing with an approval rule.** dots "do not consume standard usage"; Spark "asks you first before high-stakes actions"; event-triggered tasks have hard caps (30/hr, 720/day). Nobody runs unattended model turns inside the normal allowance.
7. **Memory is inspectable and correctable, and scoped.** Memory summary page you can edit sentence-by-sentence; project-only memory walls; Gemini "memories" and import.
8. **Point at the thing.** Annotation Mode (draw on the preview), Gemini "Select & ask", Codex "Add to chat" from a file selection, ChatGPT in-place editable blocks, Gemini "share your window". Acabox already has select-to-quote and screenshots; element-level pointing in a mini-app is the next step.
9. **Provenance cues researchers actually trust**: numbered citations that open the passage (Gemini Notebook), the "View analysis" code disclosure (ChatGPT), explicit source pickers (Gemini Deep Research), plan-first. Scientists distrust open-web deep research (15% citation rate, no PubMed, hallucinated references).
10. **Hosted surfaces churn.** Within ~15 months: Canvas, Operator, ChatGPT agent, Atlas, custom GPTs, Gems, Opal all retired or scheduled to; ChatGPT data-analysis sandboxes reset and files vanish; Canvas apps broke on a key change. A local tool whose artefacts are plain files on the user's disk should say so out loud.
11. **Desktop context capture is now standard**: share window / Work-with-apps / Fn dictation / screenshot. Acabox is at parity here.
12. **Scheduled and event-triggered work delivers as a notification + card, is capped, and can be created from an existing chat.** Acabox has the first half.

---

## 12. What Acabox could take from this — with model calls per use

Status column reads from `CLAUDE.md` only. "0" means zero *additional* model calls beyond the turn the user was already sending.

| # | Idea (analogue) | Acabox today | Model calls / use | Notes |
|---|---|---|---|---|
| 1 | **Cost readout**: "This turn $0.14 · 26 steps · 4m 12s", a today/month running total in the status bar, and "cost to build so far" on each tool card (Codex `/status`+dashboard; Jules; ChatGPT in-product limits) | **absent** — only dev-facing "zero model calls" notes; users pay per token with no readout | **0** — the SDK `result` carries usage/cost and Acabox already stores result rows | Highest-leverage trust fix for an API-key product; also an optional monthly soft budget warning (0). |
| 2 | **Tool version history + Restore** ("Previous/Next version" in the tool header; Sites' save-a-version; Codex Record & Replay) | **absent** user-facing (only `workspace-file-backups/` for hook/settings restores) | **0** — snapshot `src/` on each successful build (hook already broadcasts `miniApps:built`); restore = copy + esbuild | Directly answers the top Canvas-removal complaint and "my tool used to work". Pair with a per-turn "what changed" diff (0). |
| 3 | **Point-and-describe in a mini-app** (AI Studio Annotation Mode; Gemini Select & ask; Codex Add-to-chat) | **partial** — select-to-quote shim works inside iframes; screenshot button | **0** — the change request is the turn anyway; chip carries element text + role + crop | Reuses `miniAppSelectionShim` + screenshot crop; aims the agent so fewer retries. |
| 4 | **"Show console" badge on a running tool + "Ask Claude to fix"** (Gemini Canvas Show console; Activity's existing fix button) | **partial** — build failures surfaced (BUILD FAILED / BEING WRITTEN); runtime console errors not surfaced to the user | **0** until clicked, then **1** | Same pattern as Activity's "Ask Claude to fix it", extended to runtime errors. |
| 5 | **One bounded auto-retry on build failure, opt-in per tool** (AI Studio autonomous test-and-fix; Jules CI fixer; Colab auto-fix) | **partial** — manual fix button | **+1 per failure**, exactly once, then stop and show | Off by default per cost rule; visible in the step fold. Never unbounded. |
| 6 | **Plan card before a new tool is scaffolded** (AI Studio first checkpoint; Deep Research plan; Colab numbered plan) | **partial** — plan prompts and task checklists already render and stay in view | **0** if the skill asks the agent to post a 5-line plan and proceed; **+1** if the user turns on "pause for my OK" | Make "pause for approval" a per-user toggle, default off (cost). |
| 7 | **Provenance chevron on results: "How was this computed"** (ChatGPT View analysis; Gemini Notebook citations → passage) | **partial** — steps fold shows calls; results not linked to the step that produced them | **0** — link each number/chart/file in a reply to its recorded tool call / notebook cell | For mini-apps, `output/run_metadata.json` already exists; show it in the tool header. |
| 8 | **Inline interactive tables and charts in chat replies** (ChatGPT ADA hover/swap/export; Sheets editable charts) | **partial** — mini-apps are the chart surface; replies are markdown | **0** — render CSV/Plotly-JSON/PNG the agent wrote and named, with CSV/XLSX/SVG export | Acabox already has Plotly and an XLSX viewer; this is a renderer, not a model feature. |
| 9 | **Starter gallery + "Duplicate / Start from this tool"** (Opal templates & remix; AI Studio gallery; Canvas suggestions) | **partial** — profile-seeded chips; export/import zips; one broken R template | **0** for shipped templates and duplication; skip "I'm feeling lucky" (1 call) | 6–8 scientist starters built once by the maintainers: CSV explorer, plate-reader QC, qPCR ΔΔCt, image-stack viewer, spreadsheet merger. |
| 10 | **Publish = save a version, then deploy, with an audience picker and a "published differs from local" indicator** (ChatGPT Sites; Gemini Canvas share) | **present/partial** — Cloudflare Workers + Access, read-only snapshots, manual setup | **0** | Also show "data stays local; the shared copy is a snapshot" at publish time. |
| 11 | **Memory page**: render the agent's `MEMORY.md` + topic files with inline edit/delete (ChatGPT memory summary; Gemini memories) | **partial** — memory exists, no UI | **0** | Keep "which memory shaped this answer" out — not measurable here (recall isn't firing; CLAUDE.md). |
| 12 | **"Save this chat as a skill"** + show which skill fired on a turn (Gemini skills from chat; OpenAI plugins) | **present** (skills, import, knowledge loop) / **absent** (create-from-chat) | **1** per save (draft SKILL.md + description) | Auto-trigger already comes from the SDK's skill listing; surfacing it is 0. |
| 13 | **Per-tool instructions file auto-loaded for that tool's chats** (ChatGPT project instructions override global) | **partial** — chats are linked to tools; instructions are global | **0** | `.applications/<dir>/INSTRUCTIONS.md`; travels with export. |
| 14 | **Approval card for high-stakes actions** (Spark "asks you first"; Codex approvals; agent-mode confirmations) | **absent** — no `canUseTool` handler; read-only dirs advisory only | **0** | `rm` outside tool dirs, writes into read-only shares, connector/API writes. Makes "read-only" real. |
| 15 | **"Turn this chat into a scheduled task"** gesture (Gemini scheduled actions; Codex schedule-inside-chat) | **present** scheduler; gesture **unknown** | **0** to create; the schedule's own runs are the cost the user chose | Show "runs N×/day ≈ $X/month" on the editor (0), like Codex explains allowance. |
| 16 | **File-change triggers for tasks, capped** (ChatGPT event tasks 30/hr, 720/day; Spark triggers; MCP events) | **partial** — Rust file monitor + scheduler exist | **1 per trigger** — opt-in, hard daily cap, cost shown before saving | Defer unless asked; the cost rule argues against defaults here. |
| 17 | **Voice note → transcript file in the shared folder** (NotebookLM audio recorder; ChatGPT Record) | **partial** — on-device dictation, composer-only | **0** (on-device Speech); **+1** if the user asks for a summary | Reuses the Swift helper; lab-meeting notes become searchable files. |
| 18 | **Fork a chat from here** (Codex "f"; try two analyses from one context) | **absent** | **0** until the next turn | Check the Agent SDK's fork/resume support before promising it. |
| 19 | **Unread/working/"while you were away" on Home** (Daily Brief, Pulse, Space) | **present** — unread dots, Activity "Needs attention / Recently finished", "Jump back in" | **0** | Parity already; no model-call digest needed. |
| 20 | **Trust statement in-product**: "Your files stay on this Mac; only what Claude reads goes to Anthropic; nothing is uploaded to Acabox" (counter to ChatGPT lost-files, Opal shutdown, Canvas breakage) | **unknown** | **0** | Copy, not code; the research says it is a differentiator. |

Not recommended now: mobile remote control of desktop tasks (Codex Remote), team Spaces/collaboration (single-user by design), deep-research mode (open-web literature is where scientists distrust these tools most), always-on agents (unbounded cost).

---

## 13. Caveats — what I could not verify

- **OpenAI help center and openai.com blocked the fetcher (HTTP 403)**, so Canvas/writing-block, Projects, scheduled-task, Record and Pulse details come from dated third-party write-ups or search summaries of the official pages. Where two independent write-ups agreed I treated the fact as solid; limits (Projects file counts, task caps) are [reported].
- **ChatGPT agent-mode retirement (early Aug 2026) and the "cloud browser in ChatGPT" replacement** come only from a search summary quoting the help center; the only fetched agent-mode article predates it. Atlas's 2026-08-09 discontinuation and the March 2026 "one desktop app" plan are verified (Wikipedia).
- **ChatGPT Work's launch window (2026-07-06..10)** rests on one third-party source (zentor.ai); its existence is corroborated by the official Sites and pricing docs.
- **Pulse's 2026 state** is unknown; described from its Sept 2025 launch.
- **Model names on the ChatGPT side** (GPT-6 Astra 09-03, GPT-5.6 Sol/Luna/Terra) come from an aggregator (releasebot) and a plan guide; **GPT-6 Sol/Luna and GPT-6.1 Sol** are verified in the official Codex changelog.
- **dots**: creation flow, approvals and reporting not described in any fetched coverage.
- **Record** plan availability conflicts between sources (Plus included or not).
- **Dreaming V3 (06-04) and the per-chat memory toggle (08-20)** are search-summary only.
- **Gemini Notebook's cloud-computer/code-execution date**: 2026-06-08 (tracker) vs the 07-16 rename (glasp.co).
- **Opal's exact shutdown date (2026-11-17)** is from alphasignal; Google's own post says "the same schedule" as Gems (Nov 2026 for personal accounts).
- **Gemini skills "based on Anthropic's Agent Skills spec"** is a third-party claim; Google's pages only mention `SKILL.md` folders.
- **Who pays for Gemini calls inside a deployed AI Studio Build app** is not stated in any fetched source.
- **Workspace Studio** product page 404'd; only the NotebookLM-tracker mentions of its steps are used.
- **Reviews from non-technical users** are thin for AI Studio Build, Opal after February 2026 and Codex everyday-work mode: the session's web-search budget ran out before those searches; the complaints quoted are from community threads and reviews surfaced earlier.
- Several per-plan numbers (Deep Research, Audio Overviews, Codex message windows) change monthly; the figures here are the latest found, with their dates.

---

## 14. Sources (fetched unless marked "search summary")

OpenAI — ChatGPT
- Release notes aggregation, Sept 2026: https://releasebot.io/updates/openai/chatgpt
- Official release notes (403 to fetcher; search summary): https://help.openai.com/en/articles/6825453-chatgpt-release-notes
- Canvas removal, writing/code blocks: https://felloai.com/chatgpt-canvas/ · https://theaicareerlab.com/blog/chatgpt-what-changed-june-2026 · (search) https://www.ai-toolbox.co/chatgpt-management-and-productivity/how-to-use-chatgpt-canvas-guide-2026
- Projects: https://www.memorylake.ai/en/blogs/chatgpt-project-memory-modes · (search) https://help.openai.com/en/articles/10169521-projects-in-chatgpt · https://www.gizmotimes.com/ai/chatgpt-projects-guide-chats-files-instructions-memory/51425
- Memory: https://reconn-ai.com/chatgpt-june-12-2026-additional-controls-for-memory-summary · https://beginnersinai.org/whats-new-chatgpt-2026/ · (search) https://tech-insider.org/chatgpt-dreaming-v3-memory-update-2026/ · https://en.cryptonomist.ch/2026/08/20/chatgpt-personalization-update-memory/ · https://help.openai.com/en/articles/8590148-memory-faq
- Scheduled tasks: https://www.ai-toolbox.co/chatgpt-management-and-productivity/how-to-use-chatgpt-tasks-schedule-2026 · (search) https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt · https://www.usecarly.com/blog/chatgpt-scheduled-tasks/
- Agent mode / Operator / Atlas: https://www.agensi.io/learn/chatgpt-agent-mode · https://www.techtarget.com/whatis/feature/ChatGPT-agents-explained · https://en.wikipedia.org/wiki/ChatGPT_Atlas · https://efficient.app/apps/atlas (search) · https://openai.com/index/introducing-chatgpt-agent/ (search)
- ChatGPT Work: https://zentor.ai/blog/chatgpt-work-vs-codex
- Deep research: https://en.wikipedia.org/wiki/ChatGPT_Deep_Research · (search) https://kime.ai/blog/chatgpt-citation-sources-decoded · https://prismer.ai/blog/ai-paradox-chatgpt-deep-research-limitations
- Data analysis: https://www.datastudios.org/post/how-chatgpt-s-advanced-data-analysis-works-architecture-features-limits-and-what-s-next · (search) https://www.fileuploadgpt.com/blog/chatgpt-csv-excel-file-limits · https://community.openai.com/t/catastrophic-failures-of-chatgpt-thats-creating-major-problems-for-users/1156230 · https://openai.com/index/improvements-to-data-analysis-in-chatgpt/
- Apps SDK / plugins / custom GPTs: https://learn.chatgpt.com (redirect from https://developers.openai.com/apps-sdk) · https://virtualizationreview.com/articles/2026/09/28/openai-to-retire-custom-gpts-replace-them-with-plugins.aspx · (search) https://www.usecarly.com/blog/chatgpt-connectors/ · https://visualstudiomagazine.com/articles/2026/09/28/openai-replacing-custom-gpts-with-plugins-including-for-codex-in-vs-code.aspx
- Record / Meetings: https://www.sally.io/blog/chatgpt-record-mode-review · https://runtimewire.com/article/openai-chatgpt-space-meetings-devday-2026 · (search) https://help.openai.com/en/articles/11487532-chatgpt-record
- Work with Apps: (search) https://help.openai.com/en/articles/10119604-work-with-apps-on-macos
- DevDay 2026: https://the-decoder.com/openais-reveals-a-new-chatgpt-that-looks-less-like-a-chatbot-and-more-like-an-operating-system/ · https://techcrunch.com/2026/09/29/openai-takes-on-microsoft-with-the-launch-of-what-feels-a-whole-lot-like-chatgpts-own-office-suite/ · https://9to5mac.com/2026/09/29/openai-teases-20-announcements-at-devday-watch-live/ · (403) https://www.axios.com/2026/09/29/openai-dev-day-2026-dots-space-sol
- Sites: https://learn.chatgpt.com/docs/sites · https://www.howdoiuseai.com/blog/2026-08-16-3-ways-to-use-chatgpt-codex-that-have-nothing-to-d
- Pricing: https://theaicareerlab.com/blog/chatgpt-pricing-plans-explained · https://learn.chatgpt.com/docs/pricing
- Pulse (403; launch knowledge only): https://openai.com/index/introducing-chatgpt-pulse/

OpenAI — Codex
- Docs: https://learn.chatgpt.com/docs/app · https://learn.chatgpt.com/docs/pricing · https://learn.chatgpt.com/docs/changelog (redirect from https://developers.openai.com/codex/changelog)
- Guides: https://blakecrosley.com/guides/codex · https://www.mindstudio.ai/blog/chatgpt-codex-non-coding-work-setup-guide · https://buildtolaunch.substack.com/p/chatgpt-codex-guide-4-use-cases
- DevDay Codex: https://the-decoder.com/openai-expands-codex-and-its-api-at-devday-with-security-scans-a-decisions-api-and-ultrafast/ · https://techcrunch.com/2026/09/29/openai-gives-codex-reusable-cloud-environments-that-work-across-devices/

Google — Gemini app
- Release notes: https://gemini.google/release-notes/
- Skills: https://support.google.com/gemini/answer/18560919?hl=en · https://blog.google/products-and-platforms/products/gemini/automate-tasks-with-skills/ · https://alphasignal.ai/news/google-kills-opal-and-turns-gems-into-gemini-skills-for-free-users · (search) https://9to5google.com/2026/09/27/gemini-gems-skills/ · https://the-decoder.com/google-drops-gems-for-skills-joining-openai-and-anthropic-in-the-shift-to-agent-ready-prompt-formats/
- Canvas: https://support.google.com/gemini/answer/16047321?hl=en&co=GENIE.Platform%3DDesktop · (search) https://support.google.com/gemini/thread/414029775?hl=en · https://discuss.ai.google.dev/t/app-made-inside-gemini-canvas-now-show-error-eg-image-generation-app/115999
- Deep Research: https://support.google.com/gemini/answer/15719111?hl=en · (search) https://justinmckelvey.com/blog/gemini-usage-limits
- Scheduled actions: https://blog.google/products-and-platforms/products/gemini/scheduled-actions-gemini-app/ · (search) https://techwiser.com/gemini-gets-new-scheduled-actions-feature-heres-how-to-use-it/
- Spark / agentic app: https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/
- Plans: https://9to5google.com/2026/05/25/google-ai-plus-pro-ultra-gemini-features/

Google — Opal, NotebookLM, AI Studio, Colab, Jules, CLI, Workspace
- Opal: https://www.bitdoze.com/google-opal-ai-app-builder/ · https://www.fahimai.com/google-opal
- NotebookLM / Gemini Notebook: https://notebooklm-guide.com/notebooklm-updates/ · https://glasp.co/articles/notebooklm-2026 · https://felloai.com/notebooklm-update-1m-token-chat-goals-saved-history/ · (search) https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-video-overviews-studio-upgrades/
- AI Studio Build: https://blog.google/innovation-and-ai/technology/developers-tools/google-ai-studio-io-2026/ · https://codelabs.developers.google.com/vibe-code-with-gemini-in-aistudio · https://blog.buildfastwithai.com/google-ai-studio-vibe-coding-guide · (403) https://medium.com/@kojo_shaddy/the-architecture-of-vibe-coding-a-deep-dive-into-google-ai-studio-build-mode-d1896274f82a
- Colab DSA: https://towardsdatascience.com/googles-data-science-agent-can-it-really-do-your-job/ · https://docs.cloud.google.com/colab/docs/use-data-science-agent
- Jules: https://jules.google/docs/changelog · https://jules.google/docs/usage-limits/
- Gemini CLI: https://geminicli.com/docs/changelogs/latest/ · (search) https://github.com/google-gemini/gemini-cli/blob/HEAD/docs/changelogs/index.md
- Workspace: https://workspaceupdates.googleblog.com/ · https://workspaceupdates.googleblog.com/2025/10/gemini-in-google-sheets-analyze-data.html · (404) https://workspace.google.com/products/studio/
