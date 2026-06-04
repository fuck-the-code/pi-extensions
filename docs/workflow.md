# Pi Workflow Extension Help

This extension adds spec-first workflow execution to Pi. A workflow is a JSON template containing a DAG of goal-driven nodes. A run copies a spec into `.workflow/runs/<runId>/`, starts ready nodes in background Pi sub-agents, and stores all node artifacts for inspection and retry.

## Quick Start

1. Create a spec from a workflow template:

   ```text
   /workflow:create
   ```

   Pick a workflow, then save the generated markdown into `specs/<name>.md`.

2. Run from a spec:

   ```text
   /workflow:run specs/<name>.md
   ```

   Specs declare their workflow in frontmatter, for example:

   ```yaml
   ---
   template: code-review-spec-v1
   workflow: code-review
   title: My Review
   ---
   ```

3. Inspect progress:

   ```text
   /workflow:inspect
   ```

4. Open the final report from inspect:

   ```text
   F
   ```

## Commands

Public command set:

```text
/workflow:help      Show this help overlay
/workflow:create    Generate a required spec template for a workflow
/workflow:run       Create/resume a run and auto-start ready nodes
/workflow:inspect   Inspect run status, node artifacts, and conversations
/workflow:abort     Abort an active run
/workflow:designer  Open visual workflow DAG designer
```

### `/workflow:create [workflow]`

Creates a markdown spec template from `.pi/workflows/<workflow>.workflow.json`.

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

Explicit workflow and spec:

```text
/workflow:run code-review specs/workflow-extension-code-review.md
```

Spec-only mode:

```text
/workflow:run specs/workflow-extension-code-review.md
```

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
nodes/<nodeId>/agents/<phaseId>/prompt.md
nodes/<nodeId>/agents/<phaseId>/agent-output.md
nodes/<nodeId>/agents/<phaseId>/events.jsonl
nodes/<nodeId>/multi-agent-output.md
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

## Multi-Agent Nodes

A multi-agent node is one outer DAG node that internally runs multiple real Pi child agents/phases.

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

Rules:

- This is not broadcast/group chat.
- Each phase launches a real `pi --mode json -p` child process.
- Agents communicate through `shared/` artifacts and directed `messages/*.jsonl`.
- Declared phase outputs must exist, be regular files, and be non-empty before later phases continue.
- Final/coordinator phase writes parent node `result.json` and `report.md`.

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
