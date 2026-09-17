# Chat references — pointing one conversation at another

| | |
|---|---|
| **Status** | Built, verified live. One link unverifiable headlessly — see the end. |
| **Asked for as** | "Devin lets me link a chat thread so a different agent can read it for context. How can we do that in Acabox, given a desktop app has no URLs?" |
| **Shipped in** | `shared/chatRefs.ts`, `main/chatTranscript.ts`, the `chats` MCP relay, `renderer/components/command-desk/{ChatReferences.tsx,chatIndex.ts}` |

## What it does

A chat is referenced by a short token — `[[chat:177d891b]]` — that can be
picked from a composer menu, typed after `@`, or pasted from the chat header's
**Copy reference** button. The token is ordinary text in the message, so it is
stored, re-rendered and editable like any other text, and it renders as a
clickable chip that opens the referenced chat.

The agent reads the referenced conversation **on demand**, through
`mcp__chats__read_chat`, and can find one the user only described, through
`mcp__chats__search_chats`.

## The measurement that determined the design

Taken against the real production database, 13 chats, 2026-09-17:

| | |
|---|---|
| whole record | 12 MB |
| — `tool_result` rows | 7.7 MB (64%) |
| — `assistant` rows | 4.3 MB |
| — `user` rows | 53 KB |
| largest single chat | 7.4 MB over 1,211 rows |
| — its actual conversation | **54 KB** (2.6 KB typed, 52 KB replies) |
| largest conversation of any chat | ~67 KB ≈ 17k tokens |

**The conversation is under 1% of what is stored.** Strip the tool plumbing —
the file contents that were read, the grep output, the command transcripts —
and every chat this user has ever had fits in a context window whole.

That is why there is no summarisation pipeline, no embedding index and no
chunking strategy. At these sizes none of them buys anything. Tool *calls* are
kept as one line each (`[Read: /path/x.md]`), because knowing the other thread
grepped for a string is most of the value and costs ~60 characters; tool
*output* is dropped unless asked for, because it is the 7.7 MB and is usually
reproducible by running the thing again.

## Decisions

**On demand, not injected.** The user's call. A reference announces that a
thread exists and nothing else; the agent reads it if the message turns out to
need it. The alternative — splicing the other thread in at send time — is
deterministic but costs the whole thread on *every* turn, because each turn
resumes the same transcript. That is exactly how one inlined 39,335-row CSV
produced a 5.5 MB transcript and left a chat permanently answering "Prompt is
too long" to a bare "Hi" (CLAUDE.md, 2026-07-28). An id costs ~40 characters
per turn forever.

The announcement's wording is load-bearing and is pinned by tests. It names
the tool (a model that knows a thread exists but not how to open it will guess
at a tool name or answer from the title), says "if it bears on this message"
(a reference is "this might be relevant", not "read this first" — a follow-up
of "thanks" must not trigger a 15,000-token retrieval), and states that the
content is **not** included (otherwise the likely failure is confabulation
from the title).

**The reference lives in the message text, not in a parallel field.** This is
what keeps the renderer small. Picking from the menu, pasting a copied token,
and the agent writing one itself in a reply are then the same thing, handled
once. The stored row carries the reference for free, so a reloaded bubble
still shows what was pointed at — with no new column, no IPC change and no
history-converter change. And the user can edit or delete it like any other
text, which a chip in a separate field always has to reinvent. The chips above
the composer are a *view* of the text, derived on every render.

**Eight-character ids.** A full `randomUUID()` makes the token 45 characters,
unusable in a composer someone is typing a sentence into. Eight hex characters
is 4.3 billion values against a chat count in the tens. Resolution is a prefix
match, and an ambiguous prefix is **reported with its candidates**, never
resolved to the first hit — which is what makes the short form safe.

**Search matches `user` and `assistant` rows only.** Not an optimisation. Tool
results hold the contents of every file the agent ever read, so matching them
makes a search for any common word hit nearly every chat and the result set
stops discriminating. Tool *inputs* live in assistant rows, so searching for a
command or query string still works.

**The calling chat is excluded from its own search results**, which is why
`McpRelayContext` exists: the relay protocol carries a server name, a tool
name and arguments, and nothing about who is asking. Without it a thread finds
itself in its own results and is invited to "go read" a transcript it is
already inside.

**Unresolvable references are announced, not dropped.** A reference to a
deleted chat that is silently omitted leaves the model reading a message that
gestures at context it never received — and answering from the surrounding
sentence, confidently. One line forecloses it.

## Budget policy, and the version of it that was wrong

Over budget, the renderer **trims long turns rather than dropping turns**, with
a single water-filled per-turn cap: raise one ceiling until the total fits, so
short turns are untouched and only genuinely long ones pay.

The first implementation dropped whole turns from the middle. Measured against
the real "Hex HTTP 403" chat it discarded **26 of 50 exchanges to save 7 KB**,
because turn sizes are wildly uneven — one reply carrying forty tool-call lines
can consume the entire head budget alone. A reader handed half a conversation
cannot tell the other half existed. After the fix both real chats render with
**zero turns dropped** (58 KB / 50 turns and 60 KB / 30 turns, 17 and 5 long
replies trimmed).

Dropping turns survives only as the fallback for a chat so long that even a
400-character share does not go round, and then the count is reported inline.

## Verification

- `npx tsc --noEmit` clean; **1678/1678 across 112 suites** (+51);
  `npm start -- -- --smoke-test` exits 0 with
  `[APP] will-quit: exiting via the shutdown path`.
- The transcript renderer driven against the **real production rows** of the
  two largest chats: 1.3 MB → 58 KB over 50 turns, and 7.4 MB → 60 KB over 30
  turns, **0 turns dropped** in both, 17 and 5 long replies trimmed.

Then driven live over CDP against a real `npm start`:

- `[MCP] Registered host MCP handlers: … workspace, chats, apis`.
- The `@` trigger's three rules, each confirmed on the real composer: `@`
  alone lists 8 chats; `@dna` narrows to exactly the two DNA chats;
  `meet @ 5pm` and `email ilias@academia` both leave it closed.
- Picking replaced `@dna sequence` in place, leaving
  `what did we conclude in [[chat:c976318c]] ` with a chip reading
  "DNA Sequence Analysis Assistant".
- A real turn: the stored row holds the typed text verbatim, and the SDK
  transcript holds exactly
  `[Referenced chat: "DNA Sequence Analysis Assistant" (id: c976318c-3d8b-4405-8439-a2581477b51f). Its contents are NOT included here — call the read_chat tool with that id if it bears on this message.]`
  — the short id resolved to the full one, the title read live. The agent
  called `read_chat` (`5120 chars, 6 turns, 0 elided` from a 63-row chat) and
  answered correctly: "DNA Toolkit … reverse complement …, GC content …, and
  protein translation …".
- **Discovery with no id at all**: asked to find the conversation itself, the
  agent called `search_chats` twice, then `read_chat` to confirm, and returned
  both the tool name and the full chat id.
- The sent message renders the chip rather than the token (`[[chat:` appears
  nowhere on the page), and clicking it navigated to the referenced chat.

**One link unverified, and it cannot be verified headlessly.**
`navigator.clipboard.writeText` throws `Document is not focused` for *any*
caller in an automated window — confirmed by a control probe calling it
directly, so it is the environment, not this button, and the same is true of
the six copy buttons this app already ships. What was proven is that the
button is wired, that the string it writes is `formatChatRef(remoteId)` (unit
tested), and that it now reports failure honestly: it rendered
"Could not reach the clipboard" rather than claiming success. **Acceptance
test: click the link icon in a chat header with the window focused, and paste
`[[chat:<8 chars>]]` into another composer.**
