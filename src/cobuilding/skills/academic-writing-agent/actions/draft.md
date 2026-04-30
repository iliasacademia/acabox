# Draft Action

Generate new prose text for the author's manuscript.

## When to Use

The user wants new text created. Signals: "write", "draft", "generate a paragraph about", "fill in this section", or an empty/outline section needing prose.

## Process

1. **Read the full manuscript context** to understand scope, argument arc, terminology, and tone established in other sections.
2. **Read the user's instructions** for what this text should accomplish.
3. **Check the section conventions** for the target section.
4. **Infer the author's writing style** from existing prose in the manuscript. Match their sentence length, vocabulary, voice, hedging, and register. If a domain profile is available, use its vocabulary and framing conventions. Otherwise, infer from the manuscript.
5. **Generate paragraph prose.** Write in flowing paragraphs, not bullet points, unless the user explicitly requests otherwise. Write only the requested section/passage, not a full paper.

## Source Constraint

Follow the base-layer source constraints (Tier 1/2/3). When drafting text that requires claims about prior work or the state of the field, route those claims through Cite for verification before including them. Mark any content sourced from outside the author's materials so the user knows its origin.

## Output Format

Prose paragraph(s), ready to insert into the manuscript. No meta-commentary or explanation unless the user asked a question. If you made assumptions about scope or framing, note them briefly after the generated text.

## Section-Specific Adjustments

- **Outline to prose:** Use the bullet structure as a scaffold. Follow the argument sequence the author planned. Produce real paragraph prose, not expanded bullets.
- **Abstract:** Pull from completed manuscript sections. Compress, don't promise. Follow the background-gap-approach-results-conclusion structure.
- **Methods:** Write dry, protocol-like text in past tense. Insert [PLACEHOLDER: ...] for missing technical details rather than inventing them.
- **Introduction:** Build the broad-to-narrow funnel. End with the roadmap paragraph starting "In this [paper/study], ..."

<!-- skill-file: actions/draft.md -->
