#!/usr/bin/env node
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRunId } from '../workflow-designer-src/spec.ts';
import { buildNodePrompt, requireNonEmptyDeclaredArtifact, validateDeclaredArtifactPath } from '../workflow-designer-src/run.ts';

const temp = mkdtempSync(join(tmpdir(), 'workflow-correctness-'));
try {
  const ids = new Set(Array.from({ length: 200 }, () => makeRunId('review-remediation', '/tmp/spec.md')));
  if (ids.size !== 200) throw new Error(`run id collision: ${200 - ids.size}`);

  const nodeDir = join(temp, 'node');
  mkdirSync(nodeDir);
  assertThrows(() => validateDeclaredArtifactPath(nodeDir, 'node output', '../escape.md'), 'unsafe path accepted');

  const workflow = { version: 1, name: 'wf', nodes: [], edges: [] };
  const run = { runId: 'run', workflow: 'wf', workflowFile: '.pi/workflows/wf.workflow.json', status: 'created', createdAt: new Date().toISOString(), inputs: { spec: 'spec.md' }, originalInputs: { spec: 'spec.md' }, nodes: {} };
  const unsafeNode = { id: 'n', outputs: ['../escape.md'], executor: {}, completionPolicy: {}, verification: { enabled: false } };
  assertThrows(() => buildNodePrompt(temp, workflow, run, unsafeNode, temp, nodeDir), 'unsafe output reached prompt construction');

  const empty = join(nodeDir, 'empty.md');
  writeFileSync(empty, '');
  assertThrows(() => requireNonEmptyDeclaredArtifact(nodeDir, 'phase p output', 'missing.md'), 'missing phase output accepted');
  assertThrows(() => requireNonEmptyDeclaredArtifact(nodeDir, 'phase p output', 'empty.md'), 'empty phase output accepted');

  console.log('workflow correctness checks passed');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

function assertThrows(fn, message) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(message);
}
