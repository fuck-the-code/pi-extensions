# Pi Workflow Extension Help

This extension adds spec-first workflow execution to Pi. A workflow is a JSON template containing a DAG of goal-driven nodes. A run copies a spec into `.workflow/runs/<runId>/`, starts ready nodes in background Pi sub-agents, and stores all node artifacts for inspection and retry.

Design notes:

```text
docs/spec-to-design-workflow.md
```


## Quick Start

1. For a new task, compose a task-specific workflow/spec from the requirement:

   ```text
   /workflow:compose specs/draft-requirement.md
   ```

   This copies a fixed compose prompt into the editor. Send it as-is; the assistant will ask for the requirement and clarifying questions in chat, then preview the generated workflow/spec before writing files.

2. For a known template, create a spec from a workflow template:

   ```text
   /workflow:create
   ```

   Pick a workflow, then save the generated markdown into `specs/<name>.md`.

3. Run from a spec with an explicit alias:

   ```text
   /workflow:run specs/<name>.md --alias <short-run-name>
   ```

   Specs declare their workflow in frontmatter, for example:

   ```yaml
   ---
   template: code-review-spec-v1
   workflow: code-review
   title: My Review
   ---
   ```

4. Inspect progress:

   ```text
   /workflow:inspect
   ```

5. Open the final report from inspect:

   ```text
   F
   ```

## Commands

Public command set:

```text
/workflow:help      Show this help overlay
/workflow:compose   Compose a task-specific workflow/spec from a requirement
/workflow:create    Generate a required spec template for an existing workflow
/workflow:run       Create/resume a run and auto-start ready nodes
/workflow:inspect   Inspect run status, node artifacts, and conversations
/workflow:abort     Abort an active run
/workflow:designer  Open visual workflow DAG designer
```

### `/workflow:compose [requirement-or-path]`

Starts the dynamic workflow design flow.

Use it when the task should get its own workflow instead of being forced into an existing template:

```text
/workflow:compose
/workflow:compose specs/draft-requirement.md
/workflow:compose "Build a workflow for safely hardening process spawning"
```

The command copies a structured compose prompt into the editor. Send the prompt as-is; do not edit it manually unless you want to. The main conversation should then:

1. Summarize the requirement.
2. Ask clarifying questions.
3. Design a task-specific DAG.
4. Generate a workflow JSON template and runnable spec.
5. Preview both for confirmation.
6. Write files only after confirmation.
7. Validate and ask whether to run.

This is the preferred flow for new non-routine tasks.

### `/workflow:create [workflow]`

Creates a markdown spec template from an existing `.pi/workflows/<workflow>.workflow.json`.

Generated specs include:

```yaml
workflow: <workflow-name>
template: <template-name>
```

The workflow declaration is required. `/workflow:run <spec>` reads it directly instead of guessing.

### `/workflow:run`

Interactive mode:

```text
/workflow:run
```

Select workflow, then select a spec whose declared `workflow:` matches.

Explicit workflow and spec requires an alias:

```text
/workflow:run code-review specs/workflow-extension-code-review.md --alias review-hardening
```

Spec-only mode requires an explicit run alias:

```text
/workflow:run specs/workflow-extension-code-review.md --alias review-hardening
```

Explicit workflow and spec also require an alias:

```text
/workflow:run code-review specs/workflow-extension-code-review.md --alias review-hardening
```

Run aliases are shown in inspect/history. Creating a new run without `--alias` / `-a` is rejected so run names stay intentional and searchable.

The spec must declare:

```yaml
workflow: code-review
```

Resume an existing run:

```text
/workflow:run <runId>
/workflow:run .workflow/runs/<runId>/run.json
```

### `/workflow:inspect`

Shows run status, node status, artifacts, verification info, and conversations.

Run history is sorted by `createdAt` descending. Updating, retrying, or reconciling an older run does not move it to the top. Run aliases, when present, are shown next to the run ID.

Shortcuts:

```text
up/down       Select node
left/right    Scroll details/conversation
v             Toggle details/conversation view
Q             Open selected node log/conversation in VSCode
F             Open final DAG node report.md in VSCode
R             Resume/retry interrupted nodes in the whole run
Esc           Close
```

For multi-agent nodes, conversation view groups transcripts by agent with agent names as headings.

### `/workflow:abort`

Aborts an active workflow run and marks active/unstarted nodes failed. Aborted runs are terminal.

### `/workflow:designer [workflow]`

Visual DAG template viewer/editor.

Shortcuts:

```text
arrows        Select node and auto-pan
w/a/s/d       Manual pan
Enter         Edit selected node JSON
r             Reload workflow file
Esc           Close
```

Designer displays multi-agent nodes as clusters and lists each agent inside the node box.

## Important Paths

### Workflow templates

User/global workflow templates:

```text
/Users/kl/.pi/workflows/*.workflow.json
```

Repo copies shipped with the extension:

```text
/Users/kl/.pi/agent/extensions/workflows/*.workflow.json
```

Current examples:

```text
/Users/kl/.pi/workflows/demo.workflow.json
/Users/kl/.pi/workflows/code-review.workflow.json
/Users/kl/.pi/workflows/multi-agent-module.workflow.json
/Users/kl/.pi/workflows/review-remediation.workflow.json
```

### Specs

Recommended spec directory:

```text
/Users/kl/specs/
```

Current useful specs/reports:

```text
/Users/kl/specs/workflow-extension-code-review.md
/Users/kl/specs/multi-agent-module-code-review.md
/Users/kl/specs/workflow-extension-review-remediation.md
/Users/kl/specs/workflow-extension-remediation-final-audit.md
```

### Runs and artifacts

Runs are stored under the current workspace:

```text
.workflow/runs/<runId>/run.json
.workflow/runs/<runId>/inputs/spec.md
.workflow/runs/<runId>/nodes/<nodeId>/
```

Typical node artifacts:

```text
prompt.md
agent-output.md
events.jsonl
result.json
report.md
verification.json
verifier-output.md
verifier-events.jsonl
```

Multi-agent node artifacts:

```text
nodes/<nodeId>/shared/
nodes/<nodeId>/messages/
nodes/<nodeId>/agents/<phaseId-or-turnId>/prompt.md
nodes/<nodeId>/agents/<phaseId-or-turnId>/agent-output.md
nodes/<nodeId>/agents/<phaseId-or-turnId>/events.jsonl
```

Dynamic multi-agent nodes also write:

```text
nodes/<nodeId>/control/next-action.json
nodes/<nodeId>/control/decisions.jsonl
nodes/<nodeId>/agents/turn-001-manager/
nodes/<nodeId>/agents/turn-001-<agent>-<taskId>/
```

## Source Code Locations

Extension entry:

```text
/Users/kl/.pi/agent/extensions/workflow-designer.ts
```

Main source modules:

```text
/Users/kl/.pi/agent/extensions/workflow-designer-src/commands.ts
/Users/kl/.pi/agent/extensions/workflow-designer-src/run.ts
/Users/kl/.pi/agent/extensions/workflow-designer-src/spec.ts
/Users/kl/.pi/agent/extensions/workflow-designer-src/types.ts
/Users/kl/.pi/agent/extensions/workflow-designer-src/workflow.ts
/Users/kl/.pi/agent/extensions/workflow-designer-src/ui/components.ts
/Users/kl/.pi/agent/extensions/workflow-designer-src/ui/graph.ts
/Users/kl/.pi/agent/extensions/workflow-designer-src/ui/common.ts
```

Tests/check scripts:

```text
/Users/kl/.pi/agent/extensions/scripts/workflow-smoke-test.sh
/Users/kl/.pi/agent/extensions/scripts/workflow-correctness-checks.mjs
/Users/kl/.pi/agent/extensions/scripts/workflow-lifecycle-checks.mjs
```

Documentation:

```text
/Users/kl/.pi/agent/extensions/docs/workflow.md
/Users/kl/.pi/agent/extensions/reports/workflow-extension-remediation-final-audit.md
```

Git repo:

```text
/Users/kl/.pi/agent/extensions
https://github.com/fuck-the-code/pi-extensions.git
```

## Workflow Template Concepts

A workflow file contains:

```json
{
  "name": "code-review",
  "inputs": {
    "spec": {
      "template": "code-review-spec-v1",
      "validation": {
        "requiredSections": ["Review Target", "Scope"],
        "forbiddenPlaceholders": ["TODO", "TBD", "<fill me>"]
      }
    }
  },
  "nodes": [],
  "edges": []
}
```

Nodes are goal/prompt-driven. Important node fields:

```json
{
  "id": "review-panel",
  "title": "Managed Review Panel",
  "type": "review",
  "goal": "Coordinate specialized review agents.",
  "inputs": ["{{inputs.spec}}"],
  "outputs": ["result.json", "report.md"],
  "executor": { "kind": "agent" },
  "completionPolicy": { "semanticVerification": true },
  "verification": { "enabled": true, "criteria": [] }
}
```

## Verification Model

Engine-level verification is a final quality gate, not an interactive feedback loop.

Conceptually, verification is also an agent. You can define its role/responsibilities on the node:

```json
"verification": {
  "enabled": true,
  "mode": "semantic",
  "agent": {
    "id": "acceptance-verifier",
    "role": "Acceptance criteria verifier",
    "responsibilities": [
      "Check whether the node output satisfies the node goal",
      "Check acceptance criteria and required evidence",
      "Report missing coverage and risks"
    ]
  },
  "criteria": ["Final report addresses verifier findings"]
}
```

For multi-agent implementation/remediation nodes, prefer defining verifier/tester as a normal internal agent and phase. Use the top-level `verification.agent` only as the final external gate.

Current flow:

```text
work node agent
  -> artifact check
  -> verifier agent, if enabled
  -> completed or needs-revision
```

The verifier runs after the node's main agent exits. It writes:

```text
verification.json
verifier-output.md
verifier-events.jsonl
```

If verification fails, the node becomes `needs-revision` and downstream nodes stay blocked until retry/resume.

For implementation/remediation work where verifier feedback should guide fixes, prefer a multi-agent node with internal feedback phases:

```text
manager-plan
  -> developer-implement
  -> verifier-review
  -> developer-fix
  -> verifier-recheck
  -> manager-finalize
```

Use engine-level verification after that as a final gate checking whether the whole node addressed the verifier findings. For simple deterministic/mechanical nodes, set `semanticVerification: false` to avoid unnecessary verifier cost.

## Multi-Agent Nodes

A multi-agent node is one outer DAG node that internally runs multiple real Pi child agents. Two execution modes are supported.

### Static phase mode

Static mode is a deterministic pipeline. The workflow author predeclares every phase and the engine runs them in order.

Executor shape:

```json
{
  "kind": "multi-agent",
  "coordinator": "review-manager",
  "protocol": {
    "mode": "managed-routing",
    "broadcast": false,
    "sharedArtifactsDir": "shared"
  },
  "agents": [
    { "id": "review-manager", "role": "Coordinator" },
    { "id": "security-reviewer", "role": "Security reviewer" }
  ],
  "phases": [
    {
      "id": "manager-route",
      "agent": "review-manager",
      "outputs": ["shared/review-routing-plan.md"]
    }
  ]
}
```

Static rules:

- This is not broadcast/group chat.
- Each phase launches a real `pi --mode json -p` child process.
- Agents communicate through `shared/` artifacts and directed `messages/*.jsonl`.
- Declared phase outputs must exist, be regular files, and be non-empty before later phases continue.
- Final/coordinator phase writes parent node `result.json` and `report.md`.
- The engine appends phase completion notices to `messages/system-to-manager.jsonl`.

### Dynamic managed-routing mode

Dynamic mode treats `agents` as a resource pool and lets the manager choose who acts next at runtime. The workflow author declares the available agents, manager, limits, and final outputs; the manager writes one action per turn to `control/next-action.json`.

Executor shape:

```json
{
  "kind": "multi-agent",
  "coordinator": "manager",
  "protocol": {
    "mode": "dynamic-managed-routing",
    "broadcast": false,
    "sharedArtifactsDir": "shared",
    "rule": "Manager dispatches declared agents dynamically."
  },
  "dynamic": {
    "enabled": true,
    "manager": "manager",
    "maxTurns": 12,
    "decisionOutput": "control/next-action.json",
    "finalOutputs": ["result.json", "report.md"]
  },
  "agents": [
    { "id": "manager", "role": "Dynamic task manager" },
    { "id": "writer", "role": "Writer" },
    { "id": "reviewer", "role": "Reviewer" }
  ]
}
```

Manager actions:

```json
{
  "action": "dispatch",
  "agent": "writer",
  "taskId": "write-draft",
  "goal": "Write the draft artifact",
  "prompt": "Write shared/draft.md from the spec.",
  "inputs": ["{{inputs.spec}}"],
  "expectedOutputs": ["shared/draft.md"],
  "reason": "A draft is needed before review."
}
```

```json
{
  "action": "finalize",
  "status": "completed",
  "summary": "All required artifacts are complete.",
  "reportPath": "report.md",
  "resultPath": "result.json"
}
```

```json
{
  "action": "abort",
  "status": "needs-revision",
  "reason": "Reviewer still reports high blockers after the allowed repair turns."
}
```

Dynamic rules:

- Manager can dispatch only agents declared in `executor.agents`.
- Dispatch `expectedOutputs` must be safe relative paths under the node directory and are checked for non-empty files.
- Manager must finalize only after writing non-empty `report.md` and `result.json` or explicitly abort/needs-revision.
- `maxTurns` prevents infinite repair loops. If exceeded, the engine writes a `needs-revision` result.
- Static `phases` are ignored when dynamic mode is enabled.

## Validation Commands

From the extension repo:

```bash
cd /Users/kl/.pi/agent/extensions
PI_OFFLINE=1 pi --no-extensions -e /Users/kl/.pi/agent/extensions/workflow-designer.ts --list-models
node --experimental-strip-types scripts/workflow-correctness-checks.mjs
node --experimental-strip-types scripts/workflow-lifecycle-checks.mjs
./scripts/workflow-smoke-test.sh
python3 -m json.tool /Users/kl/.pi/workflows/code-review.workflow.json
python3 -m json.tool /Users/kl/.pi/workflows/multi-agent-module.workflow.json
python3 -m json.tool /Users/kl/.pi/workflows/review-remediation.workflow.json
```

## Recommended New-Conversation Prompt

If starting a fresh conversation, paste:

```text
Please read /Users/kl/.pi/agent/extensions/docs/workflow.md and help me work on the Pi workflow extension. Current repo is /Users/kl/.pi/agent/extensions. Use /workflow:inspect runs and workflow templates under /Users/kl/.pi/workflows as context.
```
