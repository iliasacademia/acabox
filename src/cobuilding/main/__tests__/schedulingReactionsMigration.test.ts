/**
 * The Reactions feature is deleted, but an install that ever enabled it still
 * carries its `reactions-system` row in scheduling.db — and the scheduler arms
 * every enabled row at boot, so without a migration the deleted feature's
 * 15-minute prompt would keep running full model turns against skills that no
 * longer ship. Real repository, real `scheduling.db` in a temp dir.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initSchedulingDatabase, closeSchedulingDatabase, getSchedulingDatabase } from '../db/schedulingDatabase';
import { createTask, listTasks } from '../db/scheduledTaskRepository';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acabox-schedreactions-'));
const WS = 'ws-1';

afterAll(() => {
  closeSchedulingDatabase();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('scheduling.db migration 8', () => {
  it('drops the Reactions system task and keeps every other task', () => {
    initSchedulingDatabase(tmpDir);
    createTask(WS, 'Reactions', 'old', 'old prompt', '*/15 * * * *', 'reactions-system');
    createTask(WS, 'Mine', 'keep', 'keep prompt', '0 9 * * *');
    // Rewind to the schema an older install had, as if it had never seen migration 8.
    getSchedulingDatabase().pragma('user_version = 7');
    closeSchedulingDatabase();

    initSchedulingDatabase(tmpDir);
    const names = listTasks(WS).map((t) => t.name);
    expect(names).toEqual(['Mine']);
  });
});
