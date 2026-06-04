#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { checkNodeCompletion, requireNonEmptyDeclaredArtifact, validateDeclaredArtifactPath, verifyNodeGoal } from '../workflow-designer-src/run.ts';
import { makeRunId } from '../workflow-designer-src/spec.ts';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), 'workflow-lifecycle-'));
const originalPath = process.env.PATH ?? '';

try {
  const workspace = join(temp, 'workspace');
  const binDir = join(temp, 'bin');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  installStubPi(binDir);
  process.env.PATH = `${binDir}:${originalPath}`;

  testRunIdEntropy();
  await testStubVerifierFailureHarness(workspace);
  testMissingPhaseArtifactContract(workspace);
  testLifecycleSourceInvariants();

  console.log('workflow lifecycle checks passed');
} finally {
  process.env.PATH = originalPath;
  rmSync(temp, { recursive: true, force: true });
}

function installStubPi(binDir) {
  const stub = `#!/usr/bin/env node
const { mkdirSync, writeFileSync, appendFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || args[args.indexOf('--print') + 1] || '';
appendFileSync(resolve(process.cwd(), 'stub-pi-calls.jsonl'), JSON.stringify({ args, promptLength: prompt.length }) + '\\n');
const match = prompt.match(/Write\\s+([^\\n]+?)\\s+exactly as JSON:/);
if (match) {
  const out = resolve(process.cwd(), match[1].trim());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ passed: false, confidence: 'high', reason: 'stub verifier failure', missing: ['stub-missing'], risks: [] }, null, 2) + '\\n');
}
process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'stub pi completed' }] } }) + '\\n');
`;
  const path = join(binDir, 'pi');
  writeFileSync(path, stub, { mode: 0o755 });
}

function testRunIdEntropy() {
  const ids = new Set(Array.from({ length: 500 }, () => makeRunId('review-remediation', '/tmp/spec.md')));
  assert(ids.size === 500, `run id collision detected: ${500 - ids.size}`);
}

async function testStubVerifierFailureHarness(workspace) {
  const runDir = join(workspace, '.workflow', 'runs', 'run-1');
  const nodeDir = join(runDir, 'nodes', 'verify-node');
  mkdirSync(nodeDir, { recursive: true });
  mkdirSync(join(runDir, 'inputs'), { recursive: true });
  writeFileSync(join(runDir, 'inputs', 'spec.md'), '# Spec\n\nworkflow: lifecycle-test\n', 'utf-8');
  writeFileSync(join(nodeDir, 'result.json'), JSON.stringify({ status: 'completed', summary: 'artifact-complete', issues: [], outputs: ['report.md'] }, null, 2), 'utf-8');
  writeFileSync(join(nodeDir, 'report.md'), 'non-empty report\n', 'utf-8');

  const workflow = { version: 1, name: 'lifecycle-test', nodes: [], edges: [] };
  const run = {
    runId: 'run-1',
    workflow: 'lifecycle-test',
    workflowFile: '.pi/workflows/lifecycle-test.workflow.json',
    status: 'running',
    createdAt: new Date(0).toISOString(),
    inputs: { spec: '.workflow/runs/run-1/inputs/spec.md' },
    originalInputs: { spec: 'spec.md' },
    nodes: {},
  };
  const node = {
    id: 'verify-node',
    title: 'Verifier Preservation Probe',
    type: 'testing',
    goal: 'Exercise semantic verifier failure handling.',
    prompt: 'Write normal artifacts; verifier should fail deterministically via stub.',
    executor: { kind: 'agent', prompt: 'Complete probe.' },
    outputs: ['result.json', 'report.md'],
    completionPolicy: { artifactCheck: true, semanticVerification: true, needsRevisionBlocks: true, findingsAreSuccess: false, failedBlocks: true },
    verification: { enabled: true, mode: 'semantic', criteria: ['stub must report failed'], output: { path: 'verification.json' } },
    references: [],
    inputs: ['{{inputs.spec}}'],
  };

  const completion = checkNodeCompletion(node, nodeDir);
  assert(completion.status === 'completed', `expected artifacts alone to complete, got ${completion.status}`);

  const verification = await verifyNodeGoal(workspace, workflow, run, node, runDir, nodeDir);
  assert(verification.passed === false, 'stub verifier should force failed semantic verification');
  assert(verification.reason === 'stub verifier failure', `unexpected verifier reason: ${verification.reason}`);
  assert(existsSync(join(nodeDir, 'verification.json')), 'stub verifier did not write verification.json');
}

function testMissingPhaseArtifactContract(workspace) {
  const nodeDir = join(workspace, '.workflow', 'runs', 'run-1', 'nodes', 'multi-agent-node');
  mkdirSync(nodeDir, { recursive: true });

  assertThrows(() => validateDeclaredArtifactPath(nodeDir, 'phase phase-1 output', '../escape.md'), 'unsafe phase output path accepted');
  assertThrows(() => requireNonEmptyDeclaredArtifact(nodeDir, 'phase phase-1 output', 'shared/missing.md'), 'missing phase output accepted');

  const empty = join(nodeDir, 'shared', 'empty.md');
  mkdirSync(dirname(empty), { recursive: true });
  writeFileSync(empty, '', 'utf-8');
  assertThrows(() => requireNonEmptyDeclaredArtifact(nodeDir, 'phase phase-1 output', 'shared/empty.md'), 'empty phase output accepted');
}

function testLifecycleSourceInvariants() {
  const commands = readFileSync(join(repoRoot, 'workflow-designer-src', 'commands.ts'), 'utf-8');
  const reconcileStart = commands.indexOf('function reconcileRunFromArtifacts');
  assert(reconcileStart >= 0, 'reconcileRunFromArtifacts function not found');
  const reconcile = commands.slice(reconcileStart);

  assertOrdered(commands,
    'if (activeWorkflowExecutions.has(runPath))',
    'const controller = new AbortController()',
    'duplicate-start guard must run before creating a new controller');

  assertOrdered(reconcile,
    'if (state.verification?.status === "failed")',
    'const completion = checkNodeCompletion(node, nodeDir',
    'failed semantic verification guard must precede artifact reconciliation');

  assert(reconcile.includes('status: "needs-revision"') && reconcile.includes('Goal verification failed'),
    'reconciliation must preserve failed verifier state as needs-revision with a reason');

  assert(commands.includes('requireNonEmptyDeclaredArtifact(nodeDir, `phase ${phase.id} output`, artifact.relativePath)')
    && commands.includes('## Phase failure')
    && commands.includes('return { exitCode: 1, output };'),
    'multi-agent phase output enforcement/failure stop invariant missing');

  assert(reconcile.includes('if (run.status === "aborted") return run;'),
    'aborted runs must be final during artifact reconciliation');

  assert(commands.includes('verification: undefined') && commands.includes('"verification.json"'),
    'retry/resume should clear persisted verifier failure markers before re-execution');
}

function assertOrdered(haystack, first, second, message) {
  const a = haystack.indexOf(first);
  const b = haystack.indexOf(second);
  assert(a >= 0, `${message}: missing ${first}`);
  assert(b >= 0, `${message}: missing ${second}`);
  assert(a < b, message);
}

function assertThrows(fn, message) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert(threw, message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
