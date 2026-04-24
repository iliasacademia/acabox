import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { shell, app } from 'electron';
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

export interface GoogleCalendarEvent {
  id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  status: string;
  colorId?: string;
  htmlLink?: string;
  recurrence?: string[];
  recurringEventId?: string;
  organizer?: { email: string; displayName?: string };
}

function getTokensPath(): string {
  return path.join(app.getPath('userData'), 'google-calendar-tokens.json');
}

function readTokens(): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(getTokensPath(), 'utf-8'));
  } catch {
    return null;
  }
}

function writeTokens(tokens: Record<string, unknown>): void {
  fs.writeFileSync(getTokensPath(), JSON.stringify(tokens), 'utf-8');
}

function deleteTokens(): void {
  try { fs.unlinkSync(getTokensPath()); } catch { }
}

function getSettingsPath(): string {
  return path.join(app.getPath('userData'), 'cobuilding-settings.json');
}

function readSettings(): Record<string, unknown> {
  try { return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf-8')); } catch { return {}; }
}

function writeSettings(data: Record<string, unknown>): void {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(data, null, 2), 'utf-8');
}

export function getStoredCredentials(): { clientId: string | null; clientSecret: string | null } {
  const data = readSettings();
  return {
    clientId: (data.googleClientId as string | null) ?? null,
    clientSecret: (data.googleClientSecret as string | null) ?? null,
  };
}

export function setStoredCredentials(clientId: string, clientSecret: string): void {
  const data = readSettings();
  data.googleClientId = clientId;
  data.googleClientSecret = clientSecret;
  writeSettings(data);
}

export function hasCredentials(): boolean {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? getStoredCredentials().clientId;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? getStoredCredentials().clientSecret;
  return !!(clientId && clientSecret);
}

function makeOAuth2Client(redirectUri: string) {
  const { clientId: storedId, clientSecret: storedSecret } = getStoredCredentials();
  const clientId = process.env.GOOGLE_CLIENT_ID ?? storedId;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? storedSecret;
  if (!clientId || !clientSecret) {
    throw new Error('Google Calendar credentials not configured');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function isConnected(): boolean {
  return readTokens() !== null;
}

export function disconnect(): void {
  deleteTokens();
}

export async function startOAuthFlow(): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const redirectUri = `http://127.0.0.1:${addr.port}`;
      let oauth2Client: ReturnType<typeof makeOAuth2Client>;

      try {
        oauth2Client = makeOAuth2Client(redirectUri);
      } catch (err) {
        server.close();
        reject(err);
        return;
      }

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
      });

      shell.openExternal(authUrl);

      const timeout = setTimeout(() => {
        server.close();
        reject(new Error('Google Calendar auth timed out after 5 minutes'));
      }, 5 * 60 * 1000);

      server.on('request', async (req, res) => {
        const url = new URL(req.url!, redirectUri);
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        const html = (msg: string) =>
          `<html><body style="font-family:sans-serif;padding:40px"><h2>${msg}</h2><p>You can close this tab.</p></body></html>`;

        res.writeHead(200, { 'Content-Type': 'text/html' });

        if (error) {
          res.end(html('Authorization cancelled.'));
          clearTimeout(timeout);
          server.close();
          reject(new Error(`Google OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.end(html('No authorization code received.'));
          clearTimeout(timeout);
          server.close();
          reject(new Error('No authorization code received'));
          return;
        }

        try {
          const { tokens } = await oauth2Client.getToken(code);
          writeTokens(tokens as Record<string, unknown>);
          res.end(html('Connected to Google Calendar! You can return to Academia.'));
          clearTimeout(timeout);
          server.close();
          resolve();
        } catch (err) {
          res.end(html('Error connecting to Google Calendar.'));
          clearTimeout(timeout);
          server.close();
          reject(err);
        }
      });
    });

    server.on('error', (err) => reject(err));
  });
}

export async function fetchEvents(opts: { from: string; to: string }): Promise<GoogleCalendarEvent[]> {
  const tokens = readTokens();
  if (!tokens) throw new Error('Not connected to Google Calendar');

  // Use a throwaway redirect URI — only needed to construct the client, not for refresh
  const oauth2Client = makeOAuth2Client('http://127.0.0.1');
  oauth2Client.setCredentials(tokens);

  oauth2Client.on('tokens', (newTokens) => {
    const current = readTokens() ?? {};
    writeTokens({ ...current, ...newTokens });
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin: opts.from,
    timeMax: opts.to,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 2500,
  });

  return (response.data.items ?? []) as GoogleCalendarEvent[];
}
