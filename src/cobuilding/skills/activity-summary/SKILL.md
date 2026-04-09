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
3. Fetch the user's recent activity using the query_activity tool with `since` set to the ISO timestamp from step 2. Set `include_content` to **false** (or omit it). Do **not** use the `period` parameter.
   This returns JSON with browser_sessions and file_sessions arrays containing metadata only.
4. **If there are no sessions** (both arrays empty), still add a new `## Update — HH:MM` heading with "No new updates." underneath. Do not stop.
5. If there are sessions, selectively read content from files to produce thorough summaries:

   **For browser sessions** that have a `full_text_path`:
   - First check the file size using Bash: `wc -c < "<path>"`
   - Read in small chunks (limit: 500 lines at a time) starting from the beginning. Read just enough to understand the page content and produce a good summary — you do not need to read the entire file.

   **For file sessions** that have a `snapshot_path` (plain text files only):
   - First check the file size using Bash: `wc -c < "<path>"`
   - Read in small chunks (limit: 500 lines at a time). Read just enough to understand the file content.
   - **Do NOT read binary document formats** (`.docx`, `.pptx`, `.xlsx`, `.pdf`, and other non-plain-text files) via snapshot_path. Instead, use the `full_text_path` field, which provides pre-extracted plain text. Apply the same chunk-reading strategy.

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
- Description of browsing activity (duration, key points)
  - URL: https://example.com/page

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

## Guidelines
- Group related activities (e.g., multiple pages about the same topic).
- For browser pages with content, extract the 2-3 most important points — don't summarize everything. **Always include the URL** on a sub-bullet prefixed with `URL:`.
- For file sessions, note the app and duration. If a diff is available, summarize what was changed (e.g., "Added section on X", "Revised paragraph about Y"). Distinguish between files that were only viewed (no diff) vs actively edited (has diff). **Always include the file path** on a sub-bullet prefixed with `Path:`, using backtick formatting.
- Be concise — each activity should be 1-3 bullet points.
- Note patterns and emerging themes at the end of each time section.
- Preserve all previous content in the daily summary from earlier updates.
- When there is no new activity, still write the `## Update — HH:MM` heading with "No new updates." underneath.
- To determine the `since` timestamp: parse the last `## Update — HH:MM` heading from the existing summary file. Convert HH:MM to today's date in the local timezone to form an ISO timestamp. If no prior updates exist, query from midnight.
- **Token conservation:** Always query activity without `include_content`. Only read file content selectively and in small chunks. Stop reading once you have enough context to summarize — do not read entire large files.
