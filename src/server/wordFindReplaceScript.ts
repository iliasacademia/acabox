/**
 * Pure builder for the AppleScript that drives Word's find/replace.
 *
 * Lives in its own module so a unit test can osacompile the rendered output
 * without spinning up the rest of wordActions.ts. Catching compile errors
 * (dictionary collisions, syntax mistakes) at test time avoids the
 * restart-Electron/restart-Word cycle that any AppleScript bug otherwise
 * imposes.
 *
 * The osascript / osacompile compiler imports application dictionaries
 * GLOBALLY for any tell-application referenced in the script. That means
 * AppleScript identifiers like `offset of`, `length of`, `case`, etc. get
 * looked up against the application's dictionary EVERYWHERE in the script,
 * including inside `tell me` blocks that run nested within the application
 * tell. Word in particular exports `case`, `length`, and `offset` as
 * properties — every one of these has bitten us with cryptic -2741 / -1723
 * errors. The only reliable workaround is to keep AppleScript-native
 * string operations OUTSIDE the application tell block entirely. Variables
 * set inside `tell application "Microsoft Word"` remain in script-level
 * scope, so we can read what Word gives us, exit the tell, do the string
 * work in clean AppleScript, and re-enter the tell only for the final
 * replace.
 */

export interface BuildScriptOpts {
  searchPath: string;
  replacePath: string;
  originalSearchPath: string;
  /**
   * Path the script writes the captured doc text to when no pass replaced.
   * Lets the JS layer run a normalized indexOf as Pass 5 — necessary when
   * the doc contains invisible content (comment refs, PUA glyphs, soft
   * hyphens) that AppleScript's literal-byte find can't reconcile with
   * the agent's search text in either sanitized or un-sanitized form.
   */
  docTextPath: string;
  replaceAll: boolean;
  matchCase: boolean;
  sanitizeChangedSearch: boolean;
  isLongSearch: boolean;
}

export function buildFindReplaceScript(opts: BuildScriptOpts): string {
  const { searchPath, replacePath, originalSearchPath, docTextPath, replaceAll, matchCase, sanitizeChangedSearch, isLongSearch } = opts;
  return `
set searchPath to POSIX file "${searchPath}"
set replacePath to POSIX file "${replacePath}"
set originalSearchPath to POSIX file "${originalSearchPath}"
set docTextPath to "${docTextPath}"
set searchText to (read searchPath as «class utf8»)
set replaceText to (read replacePath as «class utf8»)
set originalSearchText to (read originalSearchPath as «class utf8»)

set replacementsCount to 0
set usedOriginal to false
set usedAnchor to false
set docText to ""
set needPass3 to false
set revCount to 0
set origName to ""
set origInitials to ""
set origTrack to false
set origShowRevisions to false
set restoreNeeded to false
set tellErrMsg to ""

-- Phase A: open doc, run Word's native find (Pass 1 + Pass 2).
-- If both miss and isLongSearch, capture the doc's text for Pass 3.
tell application "Microsoft Word"
  if (count of documents) is 0 then
    return "error||No document open"
  end if
  try
    -- Temporarily set author name so tracked changes show "Academia Coscientist"
    set origName to user name
    set origInitials to user initials
    set user name to "Academia Coscientist"
    set user initials to "AC"
    set doc to active document
    set origTrack to track revisions of doc
    set origShowRevisions to show revisions of doc
    set track revisions of doc to true
    -- Hide revision marks so Word's find object searches the final
    -- (post-revision) text — matching what get_text returns. This is
    -- purely a view change; tracked changes remain intact.
    set show revisions of doc to false
    set restoreNeeded to true

    try
      -- Pass 1: sanitized search string (ligatures expanded, smart
      -- quotes/dashes normalized to ASCII).
      set docRange to create range doc start 0 end (end of content of text object of doc)
      set findObj to find object of docRange
      clear formatting findObj
      -- Reset all find options to prevent stale state from prior
      -- searches (e.g. match wildcards left on by Cmd+H).
      set match wildcards of findObj to false
      set match whole word of findObj to false
      set match sounds like of findObj to false
      set match all word forms of findObj to false
      set content of findObj to searchText
      set forward of findObj to true
      set wrap of findObj to find stop
      set match case of findObj to ${matchCase}
      set replObj to replacement of findObj
      clear formatting replObj
      set content of replObj to replaceText
      set wasFound to execute find findObj replace ${replaceAll ? 'replace all' : 'replace one'}
      if wasFound then
        set replacementsCount to 1
        -- Switch to review mode so user sees the tracked change
        set show revisions of doc to true
      else if ${sanitizeChangedSearch ? 'true' : 'false'} then
        -- Pass 2: un-sanitized original. Catches the inverse case where
        -- both doc and search contain matching fancy chars.
        set docRange to create range doc start 0 end (end of content of text object of doc)
        set findObj to find object of docRange
        clear formatting findObj
        set match wildcards of findObj to false
        set match whole word of findObj to false
        set match sounds like of findObj to false
        set match all word forms of findObj to false
        set content of findObj to originalSearchText
        set forward of findObj to true
        set wrap of findObj to find stop
        set match case of findObj to ${matchCase}
        set replObj to replacement of findObj
        clear formatting replObj
        set content of replObj to replaceText
        set wasFound to execute find findObj replace ${replaceAll ? 'replace all' : 'replace one'}
        if wasFound then
          set replacementsCount to 1
          set usedOriginal to true
          set show revisions of doc to true
        end if
      end if
    on error tier1Err
      -- Word's find rejected the inputs. Pass 3 below handles this
      -- with verify-before-write semantics.
      log "[wordActions] Word find errored, falling through to Pass 3: " & tier1Err
    end try

    -- Capture the doc text BEFORE we exit the tell. Pass 3's offset/count
    -- operations happen outside any application tell to escape Word's
    -- dictionary; once we're outside we can't ask Word anything more
    -- without a re-tell. We also keep this around for the JS-side Pass 5
    -- (normalized indexOf): always capture on miss, not just when
    -- isLongSearch, since invisible content (comment refs, PUA glyphs)
    -- can defeat literal find at any length.
    if replacementsCount is 0 then
      set docText to content of text object of doc
      ${isLongSearch ? 'set needPass3 to true' : ''}
    end if
    -- Always capture revision count when find missed. content of text
    -- object of doc returns the FINAL text (post-revision) — so if a prior
    -- tracked change deleted the agent's search text, neither find nor
    -- offset can locate it. Surfacing revCount lets the TS layer give the
    -- user an actionable error ("accept prior track changes first") rather
    -- than the generic "couldn't find passage" message.
    if replacementsCount is 0 then
      try
        set revCount to count of (revisions of doc)
      on error
        set revCount to 0
      end try
    end if
  on error errMsg number errNum
    set tellErrMsg to errMsg
  end try
end tell

-- Phase A error short-circuit
if tellErrMsg is not "" then
  -- Best-effort cleanup; ignore failures since we may not have a doc.
  try
    tell application "Microsoft Word"
      if restoreNeeded then
        set user name to origName
        set user initials to origInitials
        try
          set show revisions of active document to origShowRevisions
        end try
        try
          set track revisions of active document to origTrack
        end try
      end if
    end tell
  end try
  return "error||" & tellErrMsg
end if

-- Phase B (outside any tell): Pass 3 string locate via AppleScript's
-- native offset operator. Compiler resolves these against AppleScript
-- Standard Additions, NOT Word's dictionary.
set txtIndex to 0
set candidateText to ""
set candidateLen to 0
set didUseOriginal to false
if needPass3 then
  try
    set txtIndex to offset of searchText in docText
  on error
    set txtIndex to 0
  end try
  if txtIndex > 0 then
    set candidateText to searchText
    set candidateLen to count of candidateText
  else if ${sanitizeChangedSearch ? 'true' : 'false'} then
    try
      set txtIndex to offset of originalSearchText in docText
    on error
      set txtIndex to 0
    end try
    if txtIndex > 0 then
      set candidateText to originalSearchText
      set candidateLen to count of candidateText
      set didUseOriginal to true
    end if
  end if
end if

-- Phase C: if Pass 3 located a candidate position, re-enter Word to
-- verify the range's content matches and (only then) replace.
if needPass3 and txtIndex > 0 and candidateLen > 0 then
  set rangeStart to txtIndex - 1
  set rangeEnd to rangeStart + candidateLen
  tell application "Microsoft Word"
    try
      set doc to active document
      set fullRange to create range doc start rangeStart end rangeEnd
      set actualText to content of fullRange
      if actualText is equal to candidateText then
        set show revisions of doc to true
        set content of fullRange to replaceText
        set replacementsCount to 1
        set usedAnchor to true
        if didUseOriginal then set usedOriginal to true
      end if
    on error pass3Err
      log "[wordActions] Pass 3 verify/replace errored: " & pass3Err
    end try
  end tell
end if

${isLongSearch ? `-- Phase D: Pass 4 progressive anchor + extend. Word's find object caps at
-- ~255 chars (silent miss past that on Word-for-Mac). For long searches
-- where Pass 1-3 all missed, take a shrinking prefix of the search text
-- as the anchor, find every occurrence, extend the matched range to the
-- full search length, and verify. Anchor sizes: 200, 120, 60. The
-- anchor-text slicing happens here at script level (outside any
-- application tell) so AppleScript Standard Additions handles it
-- without colliding with Word's dictionary.
if replacementsCount is 0 then
  set anchorSizesList to {200, 120, 60}
  set fullLen to count of searchText
  set origLen to count of originalSearchText
  repeat with anchorSizeRef in anchorSizesList
    if replacementsCount > 0 then exit repeat
    set thisAnchorSize to anchorSizeRef as integer
    if thisAnchorSize < fullLen then
      set anchorText to text 1 thru thisAnchorSize of searchText
      set anchorOriginal to ""
      if ${sanitizeChangedSearch ? 'true' : 'false'} and thisAnchorSize ≤ origLen then
        set anchorOriginal to text 1 thru thisAnchorSize of originalSearchText
      end if
      set extendBy to fullLen - thisAnchorSize
      set extendByOriginal to origLen - thisAnchorSize
      tell application "Microsoft Word"
        try
          set doc to active document
          -- Pass 4a: search with the SANITIZED anchor (smart quotes
          -- straightened, dashes ASCII-folded, etc). Catches the common
          -- "search-has-fancy, doc-has-plain" direction.
          set scanRange to create range doc start 0 end (end of content of text object of doc)
          set anchorFind to find object of scanRange
          clear formatting anchorFind
          set content of anchorFind to anchorText
          set forward of anchorFind to true
          set wrap of anchorFind to find stop
          set match case of anchorFind to ${matchCase}
          set safetyCounter to 0
          repeat
            if safetyCounter > 50 then exit repeat
            set safetyCounter to safetyCounter + 1
            set wasFound to execute find anchorFind
            if not wasFound then exit repeat
            set hitStart to start of scanRange
            set hitEnd to end of scanRange
            try
              set extendedRange to create range doc start hitStart end (hitEnd + extendBy)
              set extendedText to content of extendedRange
              if extendedText is equal to searchText then
                set show revisions of doc to true
                set content of extendedRange to replaceText
                set replacementsCount to 1
                set usedAnchor to true
                exit repeat
              end if
            end try
            -- Belt-and-suspenders: also try matching the extended range
            -- against the un-sanitized original at the SAME hit. Cheap
            -- second comparison, catches the case where the doc happens
            -- to keep its fancy chars and the original variant matches.
            if anchorOriginal is not "" then
              try
                set extendedRangeOrig to create range doc start hitStart end (hitEnd + extendByOriginal)
                set extendedTextOrig to content of extendedRangeOrig
                if extendedTextOrig is equal to originalSearchText then
                  set show revisions of doc to true
                  set content of extendedRangeOrig to replaceText
                  set replacementsCount to 1
                  set usedAnchor to true
                  set usedOriginal to true
                  exit repeat
                end if
              end try
            end if
            -- This anchor hit didn't verify; advance past it and keep
            -- searching. Re-build the find object so its range is reset
            -- to "after the failed hit" rather than dynamically running
            -- away (the .Find runaway-range gotcha).
            try
              set scanRange to create range doc start hitEnd end (end of content of text object of doc)
              set anchorFind to find object of scanRange
              clear formatting anchorFind
              set content of anchorFind to anchorText
              set forward of anchorFind to true
              set wrap of anchorFind to find stop
              set match case of anchorFind to ${matchCase}
            on error
              exit repeat
            end try
          end repeat
          -- Pass 4b: if the sanitized anchor found nothing at all, the
          -- doc likely keeps its smart quotes / en-dashes / NBSPs and
          -- Word's literal-byte find rejected our ASCII-folded anchor.
          -- Retry the whole find loop with the un-sanitized original
          -- anchor so we can match the doc's fancy chars directly.
          if replacementsCount is 0 and anchorOriginal is not "" then
            set scanRange to create range doc start 0 end (end of content of text object of doc)
            set anchorFind to find object of scanRange
            clear formatting anchorFind
            set content of anchorFind to anchorOriginal
            set forward of anchorFind to true
            set wrap of anchorFind to find stop
            set match case of anchorFind to ${matchCase}
            set safetyCounter to 0
            repeat
              if safetyCounter > 50 then exit repeat
              set safetyCounter to safetyCounter + 1
              set wasFound to execute find anchorFind
              if not wasFound then exit repeat
              set hitStart to start of scanRange
              set hitEnd to end of scanRange
              try
                set extendedRangeOrig to create range doc start hitStart end (hitEnd + extendByOriginal)
                set extendedTextOrig to content of extendedRangeOrig
                if extendedTextOrig is equal to originalSearchText then
                  set show revisions of doc to true
                  set content of extendedRangeOrig to replaceText
                  set replacementsCount to 1
                  set usedAnchor to true
                  set usedOriginal to true
                  exit repeat
                end if
              end try
              -- Also try the sanitized full text against this original
              -- anchor's extended range (covers a partial-overlap case
              -- where the anchor matched the original-fancy form but the
              -- tail had been edited toward the sanitized form).
              try
                set extendedRange to create range doc start hitStart end (hitEnd + extendBy)
                set extendedText to content of extendedRange
                if extendedText is equal to searchText then
                  set show revisions of doc to true
                  set content of extendedRange to replaceText
                  set replacementsCount to 1
                  set usedAnchor to true
                  exit repeat
                end if
              end try
              try
                set scanRange to create range doc start hitEnd end (end of content of text object of doc)
                set anchorFind to find object of scanRange
                clear formatting anchorFind
                set content of anchorFind to anchorOriginal
                set forward of anchorFind to true
                set wrap of anchorFind to find stop
                set match case of anchorFind to ${matchCase}
              on error
                exit repeat
              end try
            end repeat
          end if
        on error pass4Err
          log "[wordActions] Pass 4 anchor+extend errored: " & pass4Err
        end try
      end tell
    end if
  end repeat
end if

` : ''}if restoreNeeded then
  try
    tell application "Microsoft Word"
      set user name to origName
      set user initials to origInitials
      try
        set show revisions of active document to origShowRevisions
      end try
      try
        set track revisions of active document to origTrack
      end try
    end tell
  end try
end if

-- Persist the captured doc text so the JS layer can run a normalized
-- indexOf (Pass 5) when AppleScript's literal find missed in every form.
-- Best-effort: a write failure here only loses the Pass 5 fallback, not
-- the primary outcome.
if replacementsCount is 0 and docText is not "" then
  try
    set fh to open for access (POSIX file docTextPath) with write permission
    set eof of fh to 0
    write docText to fh as «class utf8»
    close access fh
  on error
    try
      close access (POSIX file docTextPath)
    end try
  end try
end if

set modeLabel to "find"
if usedAnchor and usedOriginal then
  set modeLabel to "anchor-original"
else if usedAnchor then
  set modeLabel to "anchor"
else if usedOriginal then
  set modeLabel to "original"
end if
return "ok||" & replacementsCount & "||" & modeLabel & "||" & revCount
`;
}
