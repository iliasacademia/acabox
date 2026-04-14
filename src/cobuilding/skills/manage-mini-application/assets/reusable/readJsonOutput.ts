// Read a JSON file from the workspace and return its parsed contents.
//
// `window.filesAPI.readFile` returns a discriminated union (text / image /
// error). Forgetting to extract `.content` is a recurring footgun for
// LLM-built apps — every kernel-backed app needs to read JSON output files
// after a run, and "I read the JSON" should be a one-liner, not a 6-line
// shape-check followed by a try/catch.
//
// Returns `null` if the file is missing, too large, non-text, or invalid
// JSON. Errors are logged for debugging but do not throw.

declare const window: Window & {
  filesAPI: {
    readFile(
      path: string,
    ): Promise<
      | { type: "text"; content: string }
      | { type: "image"; fileUrl: string }
      | { error: string; size?: number }
    >;
  };
};

export async function readJsonOutput<T = unknown>(
  path: string,
): Promise<T | null> {
  try {
    const result = await window.filesAPI.readFile(path);
    if (!("type" in result) || result.type !== "text") return null;
    return JSON.parse(result.content) as T;
  } catch (err) {
    console.warn(`readJsonOutput(${path}) failed:`, err);
    return null;
  }
}
