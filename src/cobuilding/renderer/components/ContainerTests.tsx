import React, { useState } from 'react';
import './ContainerTests.css';

type TestStatus = 'idle' | 'running' | 'pass' | 'fail';

interface TestDefinition {
  id: string;
  name: string;
  description: string;
  run: () => Promise<{ pass: boolean; detail: string }>;
}

interface TestResult {
  status: TestStatus;
  detail: string | null;
  durationMs: number | null;
}

const TESTS: TestDefinition[] = [
  {
    id: 'workspace-mount',
    name: 'Workspace mount (/data)',
    description: 'Verify the workspace is mounted at /data',
    run: async () => {
      const { stdout } = await window.containerAPI.exec(['ls', '/data']);
      return { pass: true, detail: `Contents: ${stdout.trim().split('\n').slice(0, 5).join(', ')}${stdout.trim().split('\n').length > 5 ? '...' : ''}` };
    },
  },
  {
    id: 'skill-scripts',
    name: 'Skill scripts present',
    description: 'Check that DE analysis scripts are installed',
    run: async () => {
      const { stdout } = await window.containerAPI.exec(['ls', '.claude/skills/differential-expression/scripts/']);
      const files = stdout.trim().split('\n').filter(Boolean);
      if (files.length === 0) return { pass: false, detail: 'No scripts found in .claude/skills/differential-expression/scripts/' };
      return { pass: true, detail: `Found: ${files.join(', ')}` };
    },
  },
  {
    id: 'r-available',
    name: 'R runtime',
    description: 'Verify R is installed and can execute',
    run: async () => {
      const { stdout } = await window.containerAPI.exec(['R', '--version']);
      const firstLine = stdout.split('\n')[0] || '';
      return { pass: firstLine.includes('R version'), detail: firstLine };
    },
  },
  {
    id: 'r-deseq2',
    name: 'R: DESeq2 package',
    description: 'Verify DESeq2 can be loaded',
    run: async () => {
      const { stdout, stderr } = await window.containerAPI.exec([
        'R', '--no-save', '-e', 'library(DESeq2); cat(paste0("DESeq2 ", packageVersion("DESeq2"), "\\n"))',
      ]);
      const match = stdout.match(/DESeq2 [\d.]+/);
      return { pass: !!match, detail: match ? match[0] : `Failed to load DESeq2\n${stderr || stdout}`.trim() };
    },
  },
  {
    id: 'r-packages',
    name: 'R: CRAN packages',
    description: 'Verify key CRAN packages load (ggplot2, dplyr, jsonlite)',
    run: async () => {
      const { stdout, stderr } = await window.containerAPI.exec([
        'R', '--no-save', '-e',
        'for(p in c("ggplot2","dplyr","jsonlite")){library(p,character.only=TRUE);cat(paste0(p," ",packageVersion(p),"\\n"))}',
      ]);
      const lines = stdout.trim().split('\n').filter(l => /^\w+ [\d.]+$/.test(l));
      return { pass: lines.length === 3, detail: lines.join(', ') || `Some packages failed to load\n${stderr || stdout}`.trim() };
    },
  },
  {
    id: 'python-available',
    name: 'Python runtime',
    description: 'Verify Python 3 is installed',
    run: async () => {
      const { stdout } = await window.containerAPI.exec(['python3', '--version']);
      return { pass: stdout.includes('Python 3'), detail: stdout.trim() };
    },
  },
  {
    id: 'python-packages',
    name: 'Python packages',
    description: 'Verify key Python packages (pypdf, openpyxl, pdfplumber, Pillow)',
    run: async () => {
      const { stdout } = await window.containerAPI.exec([
        'python3', '-c',
        'import pypdf; import openpyxl; import pdfplumber; import PIL; print("pypdf ok"); print("openpyxl ok"); print("pdfplumber ok"); print("pillow ok")',
      ]);
      const ok = stdout.includes('pypdf ok') && stdout.includes('openpyxl ok') && stdout.includes('pdfplumber ok') && stdout.includes('pillow ok');
      return { pass: ok, detail: ok ? 'All packages imported' : stdout.trim() };
    },
  },
  {
    id: 'node-available',
    name: 'Node.js runtime',
    description: 'Verify Node.js is installed',
    run: async () => {
      const { stdout } = await window.containerAPI.exec(['node', '--version']);
      return { pass: stdout.startsWith('v'), detail: `Node ${stdout.trim()}` };
    },
  },
  {
    id: 'r-exec-roundtrip',
    name: 'R exec roundtrip',
    description: 'Execute R code and retrieve JSON output',
    run: async () => {
      const { stdout } = await window.containerAPI.exec([
        'Rscript', '-e',
        'library(jsonlite); cat(toJSON(list(answer=42, items=c("a","b","c"))))',
      ]);
      try {
        const parsed = JSON.parse(stdout.match(/\{.*\}|\[.*\]/s)?.[0] || '');
        return { pass: parsed.answer?.[0] === 42, detail: `Got JSON: ${JSON.stringify(parsed)}` };
      } catch {
        return { pass: false, detail: `Could not parse JSON from output: ${stdout.substring(0, 200)}` };
      }
    },
  },
  {
    id: 'python-exec-roundtrip',
    name: 'Python exec roundtrip',
    description: 'Execute Python code and retrieve JSON output',
    run: async () => {
      const { stdout } = await window.containerAPI.exec([
        'python3', '-c',
        'import json; print(json.dumps({"answer": 42, "items": ["a", "b", "c"]}))',
      ]);
      try {
        const parsed = JSON.parse(stdout.trim());
        return { pass: parsed.answer === 42, detail: `Got JSON: ${JSON.stringify(parsed)}` };
      } catch {
        return { pass: false, detail: `Could not parse JSON from output: ${stdout.substring(0, 200)}` };
      }
    },
  },
  {
    id: 'data-write-read',
    name: 'Write/read file in /data',
    description: 'Write a file inside the container and read it back',
    run: async () => {
      const marker = `test-${Date.now()}`;
      await window.containerAPI.exec(['sh', '-c', `echo '${marker}' > /data/.cobuild_test_tmp`]);
      const { stdout } = await window.containerAPI.exec(['cat', '/data/.cobuild_test_tmp']);
      await window.containerAPI.exec(['rm', '-f', '/data/.cobuild_test_tmp']);
      const ok = stdout.trim() === marker;
      return { pass: ok, detail: ok ? 'Write → read → cleanup succeeded' : `Expected "${marker}", got "${stdout.trim()}"` };
    },
  },
  {
    id: 'pandoc-available',
    name: 'Pandoc',
    description: 'Verify Pandoc is installed',
    run: async () => {
      const { stdout } = await window.containerAPI.exec(['pandoc', '--version']);
      const firstLine = stdout.split('\n')[0] || '';
      return { pass: firstLine.includes('pandoc'), detail: firstLine };
    },
  },
];

export const ContainerTests: React.FC = () => {
  const [results, setResults] = useState<Record<string, TestResult>>({});
  const [runningAll, setRunningAll] = useState(false);

  const runTest = async (test: TestDefinition) => {
    setResults((prev) => ({ ...prev, [test.id]: { status: 'running', detail: null, durationMs: null } }));
    const start = performance.now();
    try {
      const { pass, detail } = await test.run();
      const durationMs = Math.round(performance.now() - start);
      setResults((prev) => ({ ...prev, [test.id]: { status: pass ? 'pass' : 'fail', detail, durationMs } }));
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      const detail = err instanceof Error ? err.message : String(err);
      setResults((prev) => ({ ...prev, [test.id]: { status: 'fail', detail, durationMs } }));
    }
  };

  const runAll = async () => {
    setRunningAll(true);
    for (const test of TESTS) {
      await runTest(test);
    }
    setRunningAll(false);
  };

  const counts = {
    pass: Object.values(results).filter((r) => r.status === 'pass').length,
    fail: Object.values(results).filter((r) => r.status === 'fail').length,
    total: TESTS.length,
  };

  return (
    <div className="containerTests">
      <div className="containerTests__header">
        <h4 className="containerTests__title">Container Tests</h4>
        <button className="containerTests__runAll" onClick={runAll} disabled={runningAll}>
          {runningAll ? 'Running...' : 'Run All'}
        </button>
      </div>

      {counts.pass + counts.fail > 0 && (
        <div className="containerTests__summary">
          <span className="containerTests__summaryPass">{counts.pass} passed</span>
          {counts.fail > 0 && <span className="containerTests__summaryFail">{counts.fail} failed</span>}
          <span className="containerTests__summaryTotal">/ {counts.total} total</span>
        </div>
      )}

      <div className="containerTests__list">
        {TESTS.map((test) => {
          const result = results[test.id];
          const status = result?.status ?? 'idle';
          return (
            <div key={test.id} className={`containerTests__item containerTests__item--${status}`}>
              <div className="containerTests__itemHeader">
                <span className={`containerTests__dot containerTests__dot--${status}`} />
                <span className="containerTests__itemName">{test.name}</span>
                {result?.durationMs != null && (
                  <span className="containerTests__duration">{result.durationMs}ms</span>
                )}
                <button
                  className="containerTests__itemRun"
                  onClick={() => runTest(test)}
                  disabled={status === 'running' || runningAll}
                  title="Run this test"
                >
                  ▶
                </button>
              </div>
              <div className="containerTests__itemDesc">{test.description}</div>
              {result?.detail && (
                <div className={`containerTests__detail containerTests__detail--${status}`}>
                  {result.detail}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
