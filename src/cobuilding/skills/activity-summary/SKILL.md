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
3. For file sessions that have a `snapshot_path`, **always read the file** using the Read tool. The full file content is important for producing a thorough summary. The `full_text_path` provides pre-extracted plain text as supplementary context for downstream use. Skip binary files or very large files.
4. For file sessions that have a `diff_path`, **read the diff file** to understand what content was changed. The diff is a unified diff showing cumulative changes since the file was first seen in this session. Use this to distinguish between files that were only viewed vs actively edited, and to describe what was changed.
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
