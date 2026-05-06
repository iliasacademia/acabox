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
  replaceAll: boolean;
  matchCase: boolean;
  sanitizeChangedSearch: boolean;
  isLongSearch: boolean;
}

export function buildFindReplaceScript(opts: BuildScriptOpts): string {
  const { searchPath, replacePath, originalSearchPath, replaceAll, matchCase, sanitizeChangedSearch, isLongSearch } = opts;
  return `
set searchPath to POSIX file "${searchPath}"
set replacePath to POSIX file "${replacePath}"
set originalSearchPath to POSIX file "${originalSearchPath}"
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
    set track revisions of doc to true
    set restoreNeeded to true

    try
      -- Pass 1: sanitized search string (ligatures expanded, smart
      -- quotes/dashes normalized to ASCII).
      set docRange to create range doc start 0 end (end of content of text object of doc)
      set findObj to find object of docRange
      clear formatting findObj
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
      else if ${sanitizeChangedSearch ? 'true' : 'false'} then
        -- Pass 2: un-sanitized original. Catches the inverse case where
        -- both doc and search contain matching fancy chars.
        set docRange to create range doc start 0 end (end of content of text object of doc)
        set findObj to find object of docRange
        clear formatting findObj
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
        end if
      end if
    on error tier1Err
      -- Word's find rejected the inputs. Pass 3 below handles the long-
      -- search case with verify-before-write semantics; everything else
      -- falls through to a clean failure.
      log "[wordActions] Word find errored, falling through to Pass 3 if applicable: " & tier1Err
    end try

    -- Capture the doc text for Pass 3 BEFORE we exit the tell. Pass 3's
    -- offset/count operations happen outside any application tell to
    -- escape Word's dictionary; once we're outside we can't ask Word
    -- anything more without a re-tell.
    if replacementsCount is 0 and ${isLongSearch ? 'true' : 'false'} then
      set docText to content of text object of doc
      set needPass3 to true
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

-- Phase D: restore Word state.
if restoreNeeded then
  try
    tell application "Microsoft Word"
      set user name to origName
      set user initials to origInitials
      try
        set track revisions of active document to origTrack
      end try
    end tell
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
