---
name: activity-summary
description: >
  Summarize the user's recent browsing and file activity into a daily summary.
  Use this skill when the user asks about their recent activity, what they've been
  working on, activity summaries, session notes, or wants to review their browsing
  and file history. Also used by the hourly scheduler to maintain an ongoing activity log.
license: Proprietary
---

# Activity Summary

You are a research activity note-taker. Your job is to maintain a daily summary that captures the user's browsing and file activity.

## Steps

1. Read today's summary file at: `.academia/summaries/YYYY-MM-DD.md` (where YYYY-MM-DD is today's date).
   If it doesn't exist yet, you'll create it.
2. **Determine the `since` timestamp:**
   - If the file exists and contains `## Update — HH:MM` headings, find the **last** such heading. Convert that HH:MM to an ISO timestamp for today's date in the local timezone. This is your `since` value.
   - If the file does not exist or has no update headings, use today's midnight (start of day) as `since`.
3. Fetch the user's recent activity using the query_activity tool with `since` set to the ISO timestamp from step 2. Do **not** use the `period` parameter.
   This returns JSON with `browser_sessions` (a list of `{ domain, sessions }` groups) and `file_sessions` (an array). Authentication and localhost URLs are automatically filtered out. All sessions include file paths by default.
4. **If there are no sessions** (browser_sessions is empty and file_sessions is empty), still add a new `## Update — HH:MM` heading with "No new updates." underneath. Do not stop.
5. If there are sessions, selectively read content from files to produce thorough summaries:

   **For browser sessions** — iterate over each group in the `browser_sessions` list. Each group has a `domain` and a `sessions` array. For each session that has a `full_text_path`:
   - First check the file size using Bash: `wc -c < "<path>"`
   - Read in small chunks (limit: 500 lines at a time) starting from the beginning. Read just enough to understand the page content and produce a good summary — you do not need to read the entire file.
   - **If you cannot read the file content** (file missing, empty, or unreadable), note the activity with just the URL and metadata (domain, duration) but do NOT guess or assume what the page content was about based on the URL or filename.

   **For file sessions** that have a `snapshot_path` (plain text files only):
   - First check the file size using Bash: `wc -c < "<path>"`
   - Read in small chunks (limit: 500 lines at a time). Read just enough to understand the file content.
   - **Do NOT read binary document formats** (`.docx`, `.pptx`, `.xlsx`, `.pdf`, and other non-plain-text files) via snapshot_path. Instead, use the `full_text_path` field, which provides pre-extracted plain text. Apply the same chunk-reading strategy.
   - **If you cannot read the file content** (file missing, empty, no `full_text_path` available, or unreadable), note the activity with just the file path and metadata (app, duration) but do NOT guess or assume what the file content was about based on the filename or path.

   **For file sessions** that have a `diff_path`:
   - Read the diff file (in small chunks if large) to understand what content was changed. The diff is a unified diff showing cumulative changes since the file was first seen in this session.
   - Use this to distinguish between files that were only viewed vs actively edited, and to describe what was changed.

6. Incorporate the new activities under a new `## Update — HH:MM` heading (where HH:MM is the current time).
7. Write the updated summary back to the file, preserving all previous content.

## Summary format

```
# Activity Summary — YYYY-MM-DD (TZ)

## Update — HH:MM

### Research

#### domain.com
- Description of browsing activity (duration, key points)
  - URL: https://domain.com/page1
- Another page on the same domain
  - URL: https://domain.com/page2

#### other-domain.com
- Description of browsing activity
  - URL: https://other-domain.com/article

### Files
- Description of file activity (app, duration)
  - Path: `relative/path/to/file.ext`

### Themes
- Patterns or emerging themes observed

---

## Update — HH:MM

No new updates.

---
```

## Relevance filtering
- Before summarizing, check if a SOUL.md persona file exists at `.academia/SOUL.md`. If it exists, use it to determine what is relevant to the user's persona and research interests.
- **Only summarize activities that are relevant to the user's research or persona.** Skip activities that are clearly unrelated (e.g., social media browsing, entertainment, general web surfing unrelated to their work).
- If no SOUL.md exists, filter based on whether the activity appears to be research-related or work-related. When in doubt, include the activity.
- It is perfectly fine for an update to contain fewer items or even "No new updates." if none of the activities are relevant.

## Guidelines
- Group browser session summaries under `#### domain` headings, matching the domain grouping from the query response.
- For browser pages with content, extract the 2-3 most important points — don't summarize everything. **Always include the URL** on a sub-bullet prefixed with `URL:`.
- For file sessions, note the app and duration. If a diff is available, summarize what was changed (e.g., "Added section on X", "Revised paragraph about Y"). Distinguish between files that were only viewed (no diff) vs actively edited (has diff). **Always include the file path** on a sub-bullet prefixed with `Path:`, using backtick formatting.
- Be concise — each activity should be 1-3 bullet points.
- Note patterns and emerging themes at the end of each time section.
- Preserve all previous content in the daily summary from earlier updates.
- When there is no new activity, still write the `## Update — HH:MM` heading with "No new updates." underneath.
- To determine the `since` timestamp: parse the last `## Update — HH:MM` heading from the existing summary file. Convert HH:MM to today's date in the local timezone to form an ISO timestamp. If no prior updates exist, query from midnight.
- **Token conservation:** Only read file content selectively and in small chunks. Stop reading once you have enough context to summarize — do not read entire large files.
- **Never assume content from names.** Do not infer what a file or page is about from its filename, URL, or path alone. Only summarize content you have actually read. If you cannot read the content, say so — do not guess.
