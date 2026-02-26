#!/usr/bin/env node

/**
 * Dev script to manually clean up old sessions from the local SQLite database.
 *
 * Usage:
 *   npm run cleanup:sessions                        # deletes sessions older than 14 days
 *   npm run cleanup:sessions -- --before 2025-01-15 # deletes sessions with end_time before given date
 */

const path = require('path');
const os = require('os');

let Database;
try {
  Database = require('better-sqlite3');
} catch {
  console.error('better-sqlite3 is not installed. Run `npm install` first.');
  process.exit(1);
}

const DEFAULT_RETENTION_DAYS = 14;
const DB_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'academia-electron',
  'sessions-dev.db'
);

function parseArgs(argv) {
  const args = argv.slice(2);
  const idx = args.indexOf('--before');
  if (idx !== -1 && args[idx + 1]) {
    const dateStr = args[idx + 1];
    const parsed = new Date(dateStr);
    if (isNaN(parsed.getTime())) {
      console.error(`Invalid date: "${dateStr}". Use YYYY-MM-DD format.`);
      process.exit(1);
    }
    return parsed.toISOString();
  }
  return new Date(Date.now() - DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function main() {
  const cutoff = parseArgs(process.argv);

  console.log(`Database: ${DB_PATH}`);
  console.log(`Deleting sessions with end_time before: ${cutoff}`);

  let db;
  try {
    db = new Database(DB_PATH);
  } catch (err) {
    console.error(`Failed to open database: ${err.message}`);
    process.exit(1);
  }

  try {
    const countRow = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE end_time < ?').get(cutoff);
    console.log(`Found ${countRow.count} session(s) to delete.`);

    if (countRow.count === 0) {
      console.log('Nothing to delete.');
      return;
    }

    const result = db.prepare('DELETE FROM sessions WHERE end_time < ?').run(cutoff);
    console.log(`Deleted ${result.changes} session(s).`);
  } finally {
    db.close();
  }
}

main();
