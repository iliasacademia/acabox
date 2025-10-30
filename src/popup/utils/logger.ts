/**
 * Logs an object with formatted JSON output.
 * @param label - The label to display before the JSON output
 * @param obj - The object to serialize and log
 */
export function logJSON(label: string, obj: any): void {
  console.log(label, JSON.stringify(obj, null, 2));
}
