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

1. Fetch the user's recent activity using the query_activity tool with period "last_2h" and include_content set to true.
   This returns JSON with browser_sessions (with full_text, full_text_path) and file_sessions (with snapshot_path, full_text_path, diff_path) arrays.
2. If there are no sessions (both arrays empty), stop — there is nothing to summarize.
3. For file sessions that have a `snapshot_path`, **read the file** using the Read tool to produce a thorough summary. However, **do NOT use Read on binary document formats** (`.docx`, `.pptx`, `.xlsx`, `.pdf`, and other non-plain-text files) — the Read tool cannot handle them. Instead, use the `full_text_path` field, which provides pre-extracted plain text for these files. Skip very large files.
4. For file sessions that have a `diff_path`, **read the diff file** to understand what content was changed. The diff is a unified diff showing cumulative changes since the file was first seen in this session. Use this to distinguish between files that were only viewed vs actively edited, and to describe what was changed.

**Reading files:** When using the Read tool, **always provide both `limit` (max 10000) and `offset` parameters**. Start with `offset: 0, limit: 10000`. If the file has more content beyond what was returned, continue reading with incremented offsets (e.g., `offset: 10000, limit: 10000`) until you have read the full file. This ensures you capture all content for a thorough summary.
5. Read today's summary file at: `.academia/summaries/YYYY-MM-DD.md` (where YYYY-MM-DD is today's date)
   If it doesn't exist yet, you'll create it.
6. Incorporate the new activities into the daily summary.
7. Write the updated summary back to the file.

## Summary format

```
# Activity Summary — YYYY-MM-DD (TZ)

## HH:MM–HH:MM

### Research
- Description of browsing activity (duration, key points)

### Files
- Description of file activity (app, duration)

### Themes
- Patterns or emerging themes observed

---
```

## Guidelines
- Group related activities (e.g., multiple pages about the same topic).
- For browser pages with content, extract the 2-3 most important points — don't summarize everything.
- For file sessions, note the file path, app, and duration. If a diff is available, summarize what was changed (e.g., "Added section on X", "Revised paragraph about Y"). Distinguish between files that were only viewed (no diff) vs actively edited (has diff).
- Be concise — each activity should be 1-3 bullet points.
- Note patterns and emerging themes at the end of each time section.
- Preserve all previous content in the daily summary from earlier time windows.
