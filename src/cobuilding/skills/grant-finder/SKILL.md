---
name: grant-finder
description: >
  Find grant funding opportunities matched to the user's research. Use when the
  user asks about grants, funding, research funding, grant applications, or wants
  to find grants relevant to their work. Triggers include: "find grants", "funding
  opportunities", "grant search", "research funding", "apply for grants", or any
  request to discover or manage grant opportunities.
license: Proprietary
---

# Grants Finder

Find and manage grant funding opportunities matched to a researcher's profile and interests.

## Available Tools

| Tool | Purpose |
|------|---------|
| `save_user_context` | Save user profile data to improve matching quality |
| `create_project` | Create a project and trigger grant matching |
| `get_project` | Poll for matched opportunities |
| `list_projects` | List all grant projects |
| `favorite_opportunity` | Save an opportunity for later |
| `hide_opportunity` | Dismiss an irrelevant opportunity |
| `set_hidden_reason` | Record why an opportunity was dismissed |
| `visit_opportunity` | Mark an opportunity as seen |
| `update_project` | Update project name or summary |

## Workflow

### Step 1: Gather user context

Before searching for grants, ask the user about their background if not already known:
- Organization type (University, Research Institute, etc.)
- Institution location
- Field of research
- Title/career stage
- Recent grant application history
- Years of professional experience

Call `save_user_context` with whatever information is available. This improves match quality but is optional — you can skip straight to creating a project if the user wants speed.

### Step 2: Create a grant project

Ask the user to describe their research or use context from the conversation. Write a detailed `research_summary` — more detail produces better matches. Include:
- Research focus and specific aims
- Methodology and approach
- Expected outcomes and impact
- Target population or application area

Call `create_project` with the summary. Save the returned `project.id`.

### Step 3: Poll for results

The matching pipeline runs asynchronously. Call `get_project` to check for results:
- First poll after ~30 seconds
- Subsequent polls every 15-20 seconds
- Vector search results appear in 1-2 minutes
- Web search results may take 3-5 minutes
- Stop when `grant_opportunities` stabilizes between polls

While waiting, let the user know results are being processed.

### Step 4: Present results

When opportunities appear, present them clearly:
- Sort by `score` (highest first)
- Highlight key fields: name, funding organization, award amount, deadline, score
- Include the `rationale` explaining why each grant matches
- Mention `how_to_improve` if available
- Note upcoming deadlines

### Step 5: User interactions

Based on user feedback:
- **"Save this one"** → call `favorite_opportunity` with `favorite: true`
- **"Not relevant"** → call `hide_opportunity` with `hidden: true`, then optionally `set_hidden_reason` with the user's reason
- **"Tell me more"** → call `visit_opportunity` to mark as seen, then provide the full description and source URL

## Direct API Access (mini-apps)

Mini-apps can call the grants API directly via `window.academiaAPI.fetch(method, endpoint, data)`. Authentication is handled automatically.

| Action | Method | Endpoint | Data |
|--------|--------|----------|------|
| Save user context | `POST` | `v0/grants_ai/create_grant_onboarding_responses` | `{ data: [{ question, response }] }` |
| Create project | `POST` | `v0/grants_ai/create_project` | `{ research_summary, name? }` |
| Get project | `GET` | `v0/grants_ai/get_project?id={project_id}` | — |
| List projects | `GET` | `v0/grants_ai/get_projects` | — |
| Favorite opportunity | `PATCH` | `v0/grants_ai/set_favorite_grant_opportunity` | `{ project_id, grant_opportunity_id, favorite }` |
| Hide opportunity | `PATCH` | `v0/grants_ai/set_hidden_grant_opportunity` | `{ project_id, grant_opportunity_id, hidden }` |
| Set hidden reason | `PATCH` | `v0/grants_ai/set_grant_opportunity_hidden_reason` | `{ project_id, grant_opportunity_id, hidden_reason }` |
| Visit opportunity | `PATCH` | `v0/grants_ai/visit_grant_opportunity` | `{ project_id, grant_opportunity_id }` |
| Update project | `PATCH` | `v0/grants_ai/update_project` | `{ id, name?, research_summary? }` |

The `question` field in `save_user_context` must be one of:
- `"What type of organization are you affiliated with?"`
- `"Where is your research institution located?"`
- `"What best describes your field of research?"`
- `"What title best describes you?"`
- `"How many grants did you apply for in the last 12 months?"`
- `"How many years of professional experience do you have?"`

Example:
```js
const { project } = await academiaAPI.fetch('POST', 'v0/grants_ai/create_project', {
  research_summary: 'Investigating CRISPR-Cas9 gene editing efficiency in...',
  name: 'CRISPR Optimization Study',
});
const detail = await academiaAPI.fetch('GET', `v0/grants_ai/get_project?id=${project.id}`);
```

## Guidelines

- Always write detailed research summaries. A one-sentence summary produces poor matches.
- Do not poll more frequently than every 10 seconds — the pipeline needs time to score results.
- Present the source_url so users can visit the original grant listing.
- If the user wants to search for a different research area, create a new project rather than updating the existing one (updating the summary does not re-trigger matching).
- If the API returns a 403 error, the user may not have grants access enabled — let them know.
- Group results by funder_type or experience_level if the user has many matches.
