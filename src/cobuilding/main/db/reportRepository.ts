import { getDatabase } from './database';

export interface WorkspaceReport {
  id: string;
  workspace_id: string;
  report_type: string;
  report_data: string;
  in_depth_report: string | null;
  about_you_summary: string | null;
  what_youre_working_on_summary: string | null;
  what_youre_working_on: string | null;
  suggested_mini_apps: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export function createReport(id: string, workspaceId: string, reportType: string): void {
  const db = getDatabase();
  db.prepare(
    'INSERT INTO workspace_reports (id, workspace_id, report_type) VALUES (?, ?, ?)',
  ).run(id, workspaceId, reportType);
}

export function updateReportStatus(
  id: string,
  status: 'running' | 'completed' | 'failed',
  data?: string,
  error?: string,
): void {
  const db = getDatabase();
  const completedAt = status === 'completed' || status === 'failed'
    ? new Date().toISOString()
    : null;

  // Parse the JSON data to extract individual columns
  let inDepthReport: string | null = null;
  let aboutYouSummary: string | null = null;
  let workingOnSummary: string | null = null;
  let workingOn: string | null = null;
  let suggestedMiniApps: string | null = null;

  if (data) {
    try {
      const parsed = JSON.parse(data);
      inDepthReport = parsed.in_depth_report ?? null;
      aboutYouSummary = parsed.about_you_summary ?? null;
      workingOnSummary = parsed.what_youre_working_on_summary ?? null;
      workingOn = Array.isArray(parsed.what_youre_working_on)
        ? JSON.stringify(parsed.what_youre_working_on)
        : null;
      suggestedMiniApps = Array.isArray(parsed.suggestions)
        ? JSON.stringify(parsed.suggestions)
        : Array.isArray(parsed.suggested_mini_apps)
          ? JSON.stringify(parsed.suggested_mini_apps)
          : null;
    } catch {
      // If JSON parsing fails, leave columns null — raw data is still saved in report_data
    }
  }

  db.prepare(
    `UPDATE workspace_reports
     SET status = ?,
         report_data = COALESCE(?, report_data),
         in_depth_report = COALESCE(?, in_depth_report),
         about_you_summary = COALESCE(?, about_you_summary),
         what_youre_working_on_summary = COALESCE(?, what_youre_working_on_summary),
         what_youre_working_on = COALESCE(?, what_youre_working_on),
         suggested_mini_apps = COALESCE(?, suggested_mini_apps),
         error = ?,
         completed_at = ?
     WHERE id = ?`,
  ).run(
    status,
    data ?? null,
    inDepthReport,
    aboutYouSummary,
    workingOnSummary,
    workingOn,
    suggestedMiniApps,
    error ?? null,
    completedAt,
    id,
  );
}

export function getReport(id: string): WorkspaceReport | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM workspace_reports WHERE id = ?').get(id) as
    | WorkspaceReport
    | undefined;
}

export function updateReportData(id: string, data: string): void {
  const db = getDatabase();

  let inDepthReport: string | null = null;
  let aboutYouSummary: string | null = null;
  let workingOnSummary: string | null = null;
  let workingOn: string | null = null;
  let suggestedMiniApps: string | null = null;

  try {
    const parsed = JSON.parse(data);
    inDepthReport = parsed.in_depth_report ?? null;
    aboutYouSummary = parsed.about_you_summary ?? null;
    workingOnSummary = parsed.what_youre_working_on_summary ?? null;
    workingOn = Array.isArray(parsed.what_youre_working_on)
      ? JSON.stringify(parsed.what_youre_working_on)
      : null;
    suggestedMiniApps = Array.isArray(parsed.suggested_mini_apps)
      ? JSON.stringify(parsed.suggested_mini_apps)
      : null;
  } catch {
    // leave columns null
  }

  db.prepare(
    `UPDATE workspace_reports
     SET report_data = ?,
         in_depth_report = ?,
         about_you_summary = ?,
         what_youre_working_on_summary = ?,
         what_youre_working_on = ?,
         suggested_mini_apps = ?
     WHERE id = ?`,
  ).run(data, inDepthReport, aboutYouSummary, workingOnSummary, workingOn, suggestedMiniApps, id);
}

export function getLatestReport(
  workspaceId: string,
  reportType: string,
): WorkspaceReport | undefined {
  const db = getDatabase();
  return db
    .prepare(
      'SELECT * FROM workspace_reports WHERE workspace_id = ? AND report_type = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(workspaceId, reportType) as WorkspaceReport | undefined;
}
