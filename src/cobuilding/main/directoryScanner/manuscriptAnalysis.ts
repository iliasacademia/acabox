import Anthropic from '@anthropic-ai/sdk';
import log from 'electron-log';
import { extractText } from '../fileMonitor/textExtractor';

const ANALYZER_MODEL = 'claude-haiku-4-5-20251001';
// Cap text we send to keep latency / cost bounded; manuscripts can be huge.
const MAX_CHARS = 60_000;

const ANALYZER_SYSTEM_PROMPT = `You are a writing-agent kickoff assistant.

Given the raw text of a researcher's manuscript draft, you produce ONE short
user message (first-person, addressed to a writing agent) that names 3-5
specific, concrete things in this manuscript that could be improved or worked
on next, and asks the agent to start on the most impactful one.

Constraints on the message you produce:
- Speak as the researcher would ("I want to…", "Help me…").
- Reference specifics from the manuscript (a section name, a claim, a figure
  reference, a paragraph topic) so the agent can act immediately.
- Keep it tight: 4-7 sentences total, including the bulleted list of issues.
- End by asking the agent to start with the highest-leverage item.
- Do NOT preface with "Here is a message…" or any meta. Output only the
  message itself, plain text, no markdown headers.`;

const FALLBACK_PROMPT = `My manuscript is open in Word. Please read it with the ms-word tools, identify 3-5 specific things I could improve (clarity, structure, argument, evidence, citations), and start on the highest-leverage one.`;

export async function analyzeManuscriptForImprovements(
  filePath: string,
  apiKey: string,
  baseURL: string | undefined,
): Promise<string> {
  let text: string | null = null;
  try {
    text = await extractText(filePath);
  } catch (err) {
    log.warn('[ManuscriptAnalysis] extractText failed:', err);
  }
  if (!text || text.trim().length < 200) {
    log.info(
      `[ManuscriptAnalysis] Skipping analysis (text length=${text?.length ?? 0}); using fallback prompt`,
    );
    return FALLBACK_PROMPT;
  }

  const truncated =
    text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + '\n\n[…truncated…]' : text;

  try {
    const client = new Anthropic({ apiKey, baseURL });
    const response = await client.messages.create({
      model: ANALYZER_MODEL,
      max_tokens: 600,
      system: ANALYZER_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Manuscript text follows. Produce the kickoff user message per the system prompt.\n\n---\n${truncated}`,
        },
      ],
    });
    const block = response.content[0];
    const out = block && block.type === 'text' ? block.text.trim() : '';
    if (!out) {
      log.warn('[ManuscriptAnalysis] Empty model output; using fallback');
      return FALLBACK_PROMPT;
    }
    return out;
  } catch (err) {
    log.warn('[ManuscriptAnalysis] Claude call failed:', err);
    return FALLBACK_PROMPT;
  }
}
