import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DesignerResult, EditResult, WorkflowDefinition, WorkflowNode, WorkflowNodeExecutorPhase, WorkflowRun } from "./types";
import {
	buildNodePrompt,
	checkNodeCompletion,
	listRuns,
	loadRun,
	refreshReadyStates,
	requireNonEmptyDeclaredArtifact,
	resolveNodeInputs,
	resolveRunPath,
	runPiPrint,
	saveRun,
	updateRunAggregateStatus,
	validateDeclaredArtifactPath,
	validateDeclaredArtifactPaths,
	verifyNodeGoal,
} from "./run";
import {
	buildSpecTemplateMarkdown,
	createInitialNodeStates,
	listSpecFiles,
	makeRunId,
	readWorkflowNameFromSpec,
	validateSpec,
} from "./spec";
import {
	ensureSampleWorkflow,
	getWorkflowPath,
	listWorkflowNames,
	loadWorkflow,
	resolveWorkflowFilePath,
	saveWorkflow,
} from "./workflow";
import {
	NodeEditorComponent,
	RunDetailComponent,
	RunListComponent,
	WorkflowHelpComponent,
	SpecListComponent,
	SpecTemplatePreviewComponent,
	WorkflowDesignerComponent,
	WorkflowListComponent,
} from "./ui/components";

type ActiveWorkflowExecution = {
	controller: AbortController;
	promise: Promise<void>;
	runPath: string;
	nodeIds: string[];
	startedAt: number;
};

const activeWorkflowExecutions = new Map<string, ActiveWorkflowExecution>();
const runUpdateQueues = new Map<string, Promise<void>>();

export function registerWorkflowCommands(pi: ExtensionAPI): void {
	pi.registerCommand("workflow:help", {
		description: "Show workflow extension usage, paths, examples, and shortcuts",
		handler: showWorkflowHelp,
	});

	pi.registerCommand("workflow:compose", {
		description: "Compose a task-specific workflow and runnable spec from a requirement",
		handler: composeWorkflowFromRequirement,
	});

	pi.registerCommand("workflow:create", {
		description: "Create a spec from a workflow template",
		handler: createSpecFromWorkflow,
	});

	pi.registerCommand("workflow:run", {
		description: "Create a workflow run and start auto-run in the background",
		handler: createRun,
	});

	pi.registerCommand("workflow:inspect", {
		description: "Inspect workflow run details and node conversation logs",
		handler: inspectWorkflowRun,
	});

	pi.registerCommand("workflow:abort", {
		description: "Open a run list and abort the selected workflow run",
		handler: abortWorkflowRun,
	});

	pi.registerCommand("workflow:designer", {
		description: "Open visual workflow designer",
		handler: openDesigner,
	});

	pi.on("session_shutdown", async () => {
		for (const active of activeWorkflowExecutions.values()) active.controller.abort();
		await Promise.allSettled(Array.from(activeWorkflowExecutions.values()).map((active) => active.promise));
	});
}

async function showWorkflowHelp(_args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	const helpPath = join(ctx.cwd, ".pi", "agent", "extensions", "docs", "workflow.md");
	const content = existsSync(helpPath) ? readFileSync(helpPath, "utf-8") : fallbackWorkflowHelp();
	if (!ctx.hasUI) {
		ctx.ui.notify(`Workflow help: ${helpPath}`, "info");
		return;
	}
	await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		return new WorkflowHelpComponent(tui, theme, content, done);
	}, {
		overlay: true,
		overlayOptions: { anchor: "center", width: "86%", maxHeight: "90%", margin: 2 },
	});
}

function fallbackWorkflowHelp(): string {
	return `# Workflow Help

Docs file not found. Expected: /Users/kl/.pi/agent/extensions/docs/workflow.md

Commands:

- /workflow:help
- /workflow:compose
- /workflow:create
- /workflow:run
- /workflow:inspect
- /workflow:abort
- /workflow:designer
`;
}

async function composeWorkflowFromRequirement(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("workflow:compose requires interactive mode", "error");
		return;
	}

	const input = args?.trim() ?? "";
	let sourceLabel = input ? "inline requirement" : "blank requirement";
	let requirement = input;
	if (input) {
		const maybePath = isAbsolute(input) ? input : join(ctx.cwd, input);
		if (existsSync(maybePath) && statSync(maybePath).isFile()) {
			sourceLabel = relative(ctx.cwd, maybePath);
			requirement = readFileSync(maybePath, "utf-8");
		}
	}

	const prompt = buildWorkflowComposePrompt(ctx.cwd, sourceLabel, requirement);
	ctx.ui.setEditorText(prompt);
	ctx.ui.notify("Workflow compose prompt copied into editor. Send it as-is; the assistant will ask for the requirement and clarifying details in chat.", "info");
}

function buildWorkflowComposePrompt(cwd: string, sourceLabel: string, requirement: string): string {
	const workflows = listWorkflowNames(cwd);
	return `# Compose a Task-Specific Pi Workflow

You are helping me create a task-specific workflow for the Pi workflow extension.

The goal is not to force my task into an existing workflow. The correct process is:

1. Understand the requirement/spec draft.
2. Ask clarifying questions until the task is specific enough to run.
3. Design a task-specific workflow DAG and node contract.
4. Convert the clarified requirement into a runnable spec for that workflow.
5. Preview the workflow and spec for confirmation.
6. After confirmation, write both files and validate them.
7. Ask whether to run it; if confirmed, run with /workflow:run <spec>.

## Source Requirement

Source: ${sourceLabel}

\`\`\`md
${requirement || "No requirement provided yet. Ask me to describe the task, then continue with clarifying questions before generating workflow JSON."}
\`\`\`

## Existing Workflow Extension Context

Docs:

- ${cwd}/.pi/agent/extensions/docs/workflow.md

Workflow template directory:

- ${cwd}/.pi/workflows

Repo workflow copies:

- ${cwd}/.pi/agent/extensions/workflows

Existing workflows:

${workflows.map((name) => `- ${name}`).join("\n") || "- (none found)"}

Useful source files:

- ${cwd}/.pi/agent/extensions/workflow-designer-src/types.ts
- ${cwd}/.pi/agent/extensions/workflow-designer-src/workflow.ts
- ${cwd}/.pi/agent/extensions/workflow-designer-src/run.ts
- ${cwd}/.pi/agent/extensions/workflow-designer-src/commands.ts

## Conversation Rules

- Start by summarizing what you understand.
- Ask 2-4 concrete clarifying questions at a time.
- Do not generate final workflow JSON until required decisions are clear.
- Prefer workflow topology from task semantics, not from existing templates.
- Use existing templates only as examples.
- Nodes should be goal/prompt-driven.
- Use multi-agent nodes only when one outer DAG node benefits from internal specialist phases.
- For implementation/remediation tasks, prefer a multi-agent internal feedback loop when verification should guide fixes: manager-plan -> developer-implement -> verifier-review -> developer-fix -> verifier-recheck -> manager-finalize.
- Avoid broadcast/group-chat multi-agent design; use manager/router + shared artifacts + directed messages.
- Treat review findings as successful outputs for review nodes; do not mark a review node failed just because it found issues.
- Treat verification as an agent definition: top-level \`verification.agent\` may define the final gate verifier role/responsibilities, while multi-agent implementation nodes should define verifier/tester as normal internal \`executor.agents\` and \`phases\`.
- Treat engine-level node verification as a final quality gate, not as the primary developer feedback loop. If a multi-agent node already has verifier/recheck phases, keep outer verification lightweight and focused on whether the final node report/result addressed the internal verifier findings.

## Required Output Files After Confirmation

Choose a safe workflow name, then write:

1. Workflow template:

   \`\`\`text
   ${cwd}/.pi/workflows/<workflow-name>.workflow.json
   ${cwd}/.pi/agent/extensions/workflows/<workflow-name>.workflow.json
   \`\`\`

2. Runnable spec:

   \`\`\`text
   ${cwd}/specs/<workflow-name>-<short-task>.md
   \`\`\`

The spec must declare the workflow:

\`\`\`yaml
---
template: <template-name>
workflow: <workflow-name>
title: <title>
---
\`\`\`

## Workflow JSON Requirements

The workflow must include:

- \`version\`
- \`name\`
- \`description\`
- \`inputs.spec.template\`
- \`inputs.spec.validation.requiredSections\`
- \`inputs.spec.validation.forbiddenPlaceholders\`
- \`nodes\`
- \`edges\`

Each node should include:

- \`id\`
- \`title\`
- \`type\`
- \`goal\`
- \`inputs\`
- \`outputs\`
- \`executor\`
- \`completionPolicy\`
- \`verification\`
- optional \`layout\`

Verification guidance:

- Single-agent work nodes usually benefit from \`semanticVerification: true\` because there is no internal reviewer.
- Multi-agent implementation/remediation nodes should put feedback inside phases using a verifier/tester agent, then use engine-level verification only as a final gate.
- When engine-level verification is enabled, define \`verification.agent\` with an id, role, and responsibilities so the verifier is explicit like other agents.
- Simple deterministic or mechanical nodes may set \`semanticVerification: false\` to avoid unnecessary verifier cost.

For multi-agent nodes, use:

- \`executor.kind = "multi-agent"\`
- \`coordinator\`
- \`agents\`
- \`protocol\`
- \`phases\`
- declared phase \`outputs\` that are safe relative paths under the node directory

## Preview Before Writing

Before writing files, show me:

1. Workflow name and purpose.
2. DAG as text.
3. Node list with executor kind and verification behavior.
4. Multi-agent clusters and phases, if any.
5. Spec required sections.
6. Files that will be written.
7. Any open risks or assumptions.

Ask for explicit confirmation before writing.

## Validation After Writing

After writing files, run:

\`\`\`bash
cd ${cwd}/.pi/agent/extensions
PI_OFFLINE=1 pi --no-extensions -e ${cwd}/.pi/agent/extensions/workflow-designer.ts --list-models
./scripts/workflow-smoke-test.sh
python3 -m json.tool ${cwd}/.pi/workflows/<workflow-name>.workflow.json
\`\`\`

Then ask whether to run:

\`\`\`text
/workflow:run specs/<workflow-name>-<short-task>.md
\`\`\`
`;
}

async function openDesigner(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("workflow designer requires interactive mode", "error");
		return;
	}

	let workflowName = args?.trim();
	if (!workflowName) {
		workflowName = await pickWorkflow(ctx);
		if (!workflowName) return;
	}

	let workflowPath: string;
	try {
		workflowPath = getWorkflowPath(ctx.cwd, workflowName);
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		return;
	}
	ensureSampleWorkflow(workflowPath, workflowName);

	let selectedId: string | undefined;
	while (true) {
		let workflow: WorkflowDefinition;
		try {
			workflow = loadWorkflow(workflowPath);
		} catch (err) {
			ctx.ui.notify(`Failed to load workflow: ${err instanceof Error ? err.message : String(err)}`, "error");
			return;
		}

		if (!selectedId || !workflow.nodes.some((n) => n.id === selectedId)) {
			selectedId = workflow.nodes[0]?.id;
		}

		const result = await ctx.ui.custom<DesignerResult>((tui, theme, _kb, done) => {
			return new WorkflowDesignerComponent(tui, theme, workflow, selectedId, done);
		}, {
			overlay: true,
			overlayOptions: { anchor: "center", width: "96%", maxHeight: "92%", margin: 1 },
		});

		if (result.action === "close") return;
		if (result.action === "reload") {
			selectedId = result.selectedId;
			continue;
		}

		const node = workflow.nodes.find((n) => n.id === result.nodeId);
		if (!node) {
			selectedId = undefined;
			continue;
		}

		const editResult = await ctx.ui.custom<EditResult>((tui, theme, _kb, done) => {
			return new NodeEditorComponent(tui, theme, node, done);
		}, {
			overlay: true,
			overlayOptions: { anchor: "center", width: "76%", maxHeight: "88%", margin: 2 },
		});

		selectedId = node.id;
		if (editResult.action === "save") {
			const latest = loadWorkflow(workflowPath);
			const index = latest.nodes.findIndex((n) => n.id === editResult.node.id);
			if (index >= 0) {
				latest.nodes[index] = { ...latest.nodes[index], ...editResult.node, id: latest.nodes[index]!.id };
				saveWorkflow(workflowPath, latest);
				ctx.ui.notify(`Saved node: ${editResult.node.id}`, "info");
			} else {
				ctx.ui.notify(`Node disappeared: ${editResult.node.id}`, "warning");
			}
		}
	}
}

async function createSpecFromWorkflow(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("workflow:create requires interactive mode", "error");
		return;
	}

	let workflowName = args?.trim();
	if (!workflowName) {
		workflowName = await pickWorkflow(ctx);
		if (!workflowName) return;
	}

	let workflowPath: string;
	try {
		workflowPath = getWorkflowPath(ctx.cwd, workflowName);
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		return;
	}
	ensureSampleWorkflow(workflowPath, workflowName);
	const workflow = loadWorkflow(workflowPath);
	const markdown = buildSpecTemplateMarkdown(workflow);

	const confirmed = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		return new SpecTemplatePreviewComponent(tui, theme, workflow, markdown, done);
	}, {
		overlay: true,
		overlayOptions: { anchor: "center", width: "82%", maxHeight: "88%", margin: 2 },
	});

	if (!confirmed) return;
	ctx.ui.setEditorText(markdown);
	ctx.ui.notify("Spec template copied into editor. Edit it, then save it as a spec file.", "info");
}

async function createRun(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("workflow:run requires interactive mode", "error");
		return;
	}

	const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
	let workflowName = parts[0];
	let specPath = parts[1];

	if (workflowName) {
		try {
			const maybeRunPath = resolveRunPath(ctx.cwd, workflowName);
			if (existsSync(maybeRunPath)) {
				await startWorkflowRun(maybeRunPath, ctx);
				return;
			}
		} catch {
			// Not a run id/path; treat it as a workflow name or spec path below.
		}
	}

	if (workflowName && !specPath && looksLikeExistingSpecPath(ctx.cwd, workflowName)) {
		specPath = workflowName;
		workflowName = await inferWorkflowForSpec(ctx, specPath);
		if (!workflowName) return;
	}

	if (!workflowName) {
		workflowName = await pickWorkflow(ctx);
		if (!workflowName) return;
	}

	let workflowPath: string;
	try {
		workflowPath = getWorkflowPath(ctx.cwd, workflowName);
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		return;
	}
	ensureSampleWorkflow(workflowPath, workflowName);
	const workflow = loadWorkflow(workflowPath);

	if (!specPath) {
		specPath = await pickSpec(ctx, workflow);
		if (!specPath) return;
	}

	const absSpecPath = isAbsolute(specPath) ? specPath : join(ctx.cwd, specPath);
	if (!existsSync(absSpecPath) || !statSync(absSpecPath).isFile()) {
		ctx.ui.notify(`Spec file not found: ${specPath}`, "error");
		return;
	}
	const declaredWorkflow = readWorkflowNameFromSpec(absSpecPath);
	if (declaredWorkflow && declaredWorkflow !== workflow.name) {
		ctx.ui.notify(`Spec declares workflow ${declaredWorkflow}, but selected workflow is ${workflow.name}.`, "error");
		return;
	}
	if (!declaredWorkflow) {
		ctx.ui.notify(`Spec must declare its workflow. Add frontmatter: workflow: ${workflow.name}`, "error");
		return;
	}

	const validation = validateSpec(absSpecPath, workflow.inputs?.spec?.validation);
	if (validation.errors.length > 0) {
		ctx.ui.notify(`Spec validation failed: ${validation.errors.join("; ")}`, "error");
		return;
	}

	ensureWorkflowGitignore(ctx.cwd);
	const { runId, runDir } = createUniqueRunDirectory(ctx.cwd, workflow.name, absSpecPath);
	const inputsDir = join(runDir, "inputs");
	mkdirSync(inputsDir);
	mkdirSync(join(runDir, "nodes"));

	const copiedSpec = join(inputsDir, "spec.md");
	copyFileSync(absSpecPath, copiedSpec);

	const run: WorkflowRun = {
		runId,
		workflow: workflow.name,
		workflowFile: relative(ctx.cwd, workflowPath),
		status: "created",
		createdAt: new Date().toISOString(),
		inputs: { spec: relative(ctx.cwd, copiedSpec) },
		originalInputs: { spec: relative(ctx.cwd, absSpecPath) },
		nodes: createInitialNodeStates(workflow),
	};

	const runPath = join(runDir, "run.json");
	writeFileSync(runPath, `${JSON.stringify(run, null, "\t")}\n`, "utf-8");
	ctx.ui.notify(`Created workflow run: ${relative(ctx.cwd, runPath)}. Starting auto-run...`, "info");
	await startWorkflowRun(runPath, ctx);
}

function createUniqueRunDirectory(cwd: string, workflowName: string, specPath: string): { runId: string; runDir: string } {
	const runsRoot = join(cwd, ".workflow", "runs");
	mkdirSync(runsRoot, { recursive: true });
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const runId = makeRunId(workflowName, specPath);
		const runDir = join(runsRoot, runId);
		try {
			mkdirSync(runDir);
			return { runId, runDir };
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw err;
		}
	}
	throw new Error("Unable to allocate a unique workflow run directory");
}

function looksLikeExistingSpecPath(cwd: string, value: string): boolean {
	if (!/\.(md|markdown)$/i.test(value) && !value.includes("/")) return false;
	const abs = isAbsolute(value) ? value : join(cwd, value);
	return existsSync(abs) && statSync(abs).isFile();
}

async function inferWorkflowForSpec(ctx: ExtensionCommandContext, specPath: string): Promise<string | null> {
	const absSpecPath = isAbsolute(specPath) ? specPath : join(ctx.cwd, specPath);
	const declared = readWorkflowNameFromSpec(absSpecPath);
	if (!declared) {
		ctx.ui.notify(`Spec must declare its workflow. Add frontmatter like: workflow: code-review`, "error");
		return null;
	}
	if (!listWorkflowNames(ctx.cwd).includes(declared)) {
		ctx.ui.notify(`Spec declares unknown workflow: ${declared}`, "error");
		return null;
	}
	return declared;
}

async function startWorkflowRun(runPath: string, ctx: ExtensionCommandContext): Promise<void> {
	let run = reconcileRunFromArtifacts(runPath, ctx.cwd);
	const workflow = loadWorkflow(resolveWorkflowFilePath(ctx.cwd, run.workflowFile));
	const initialReadyNodeIds = readyNodeIds(run);
	if (initialReadyNodeIds.length === 0) {
		ctx.ui.notify("No ready workflow nodes.", "info");
		return;
	}
	if (activeWorkflowExecutions.has(runPath)) {
		ctx.ui.notify(`Workflow run already executing: ${relative(ctx.cwd, runPath)}`, "warning");
		return;
	}

	const controller = new AbortController();
	const promise = (async () => {
		const executed: string[] = [];
		try {
			while (!controller.signal.aborted) {
				const latest = reconcileRunFromArtifacts(runPath, ctx.cwd);
				if (["aborted", "failed"].includes(latest.status)) break;
				const batch = readyNodeIds(latest);
				if (batch.length === 0) {
					updateRunAggregateStatus(latest);
					saveRun(runPath, latest);
					break;
				}

				ctx.ui.setStatus(`workflow:${run.runId}`, `workflow ${run.runId}: ${batch.join(",")} running`);
				await Promise.all(batch.map((nodeId) => executeOneNode(ctx, runPath, workflow, nodeId, controller.signal)));
				executed.push(...batch);
			}

			const finalRun = reconcileRunFromArtifacts(runPath, ctx.cwd);
			ctx.ui.notify(`Workflow auto-run stopped: ${finalRun.runId} [${finalRun.status}], executed: ${executed.join(", ") || "none"}`, "info");
		} catch (err) {
			ctx.ui.notify(`Workflow auto-run failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		} finally {
			activeWorkflowExecutions.delete(runPath);
			ctx.ui.setStatus(`workflow:${run.runId}`, undefined);
		}
	})();

	activeWorkflowExecutions.set(runPath, {
		controller,
		promise,
		runPath,
		nodeIds: initialReadyNodeIds,
		startedAt: Date.now(),
	});
	ctx.ui.setStatus(`workflow:${run.runId}`, `workflow ${run.runId}: ${initialReadyNodeIds.join(",")} running`);
	ctx.ui.notify(`Started workflow auto-run in background from: ${initialReadyNodeIds.join(", ")}. Use /workflow:inspect to monitor.`, "info");
}

async function executeOneNode(ctx: ExtensionCommandContext, runPath: string, workflow: WorkflowDefinition, nodeId: string, signal?: AbortSignal): Promise<void> {
	let run = loadRun(runPath);
	const node = workflow.nodes.find((n) => n.id === nodeId);
	if (!node) {
		ctx.ui.notify(`Unknown node: ${nodeId}`, "error");
		return;
	}

	const runDir = dirname(runPath);
	const nodeDir = join(runDir, "nodes", node.id);
	mkdirSync(nodeDir, { recursive: true });

	await updateRunSerialized(runPath, (latest) => {
		latest.nodes[node.id] = { ...latest.nodes[node.id], status: "running", startedAt: new Date().toISOString() };
		latest.status = "running";
	});

	let result: { exitCode: number; output: string };
	try {
		result = node.executor?.kind === "multi-agent"
			? await executeMultiAgentNode(ctx, workflow, run, node, runDir, nodeDir, signal)
			: await executeSingleAgentNode(ctx, workflow, run, node, runDir, nodeDir, signal);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		writeFileSync(join(nodeDir, "agent-output.md"), `Workflow node failed before agent execution: ${message}\n`, "utf-8");
		result = { exitCode: 1, output: message };
	}

	run = loadRun(runPath);
	const wasAborted = signal?.aborted || run.status === "aborted";
	if (result.exitCode !== 0 || wasAborted) {
		await updateRunSerialized(runPath, (latest) => {
			latest.nodes[node.id] = {
				...latest.nodes[node.id],
				status: "failed",
				completedAt: new Date().toISOString(),
				summary: signal?.aborted ? "aborted manually" : summarizeExecutionFailure(result),
			};
			latest.status = wasAborted ? "aborted" : "paused";
		});
		return;
	}

	const completion = checkNodeCompletion(node, nodeDir, { treatNeedsRevisionAsCompleted: node.completionPolicy?.needsRevisionBlocks === false || node.completionPolicy?.findingsAreSuccess === true });
	let finalStatus = completion.status;
	let finalSummary = completion.summary;
	let verificationState: WorkflowRun["nodes"][string]["verification"] | undefined;
	if (completion.status === "completed" && node.completionPolicy?.semanticVerification !== false && node.verification?.enabled !== false) {
		const verification = await verifyNodeGoal(ctx.cwd, workflow, run, node, runDir, nodeDir, signal);
		verificationState = { status: verification.passed ? "passed" : "failed", reason: verification.reason, checkedAt: new Date().toISOString() };
		if (!verification.passed) {
			finalStatus = "needs-revision";
			finalSummary = `Goal verification failed: ${verification.reason}`;
		} else if (verification.reason) {
			finalSummary = finalSummary ? `${finalSummary}; verified: ${verification.reason}` : `verified: ${verification.reason}`;
		}
	}
	await updateRunSerialized(runPath, (latest) => {
		if (latest.status === "aborted") return;
		latest.nodes[node.id] = {
			...latest.nodes[node.id],
			status: finalStatus,
			completedAt: new Date().toISOString(),
			result: relative(runDir, join(nodeDir, "result.json")),
			outputs: completion.outputs.map((output) => relative(runDir, join(nodeDir, output))),
			summary: finalSummary,
			verification: verificationState,
		};
		if (finalStatus === "failed" || finalStatus === "needs-revision") latest.status = "paused";
	});
}

async function executeSingleAgentNode(
	ctx: ExtensionCommandContext,
	workflow: WorkflowDefinition,
	run: WorkflowRun,
	node: WorkflowNode,
	runDir: string,
	nodeDir: string,
	signal?: AbortSignal,
): Promise<{ exitCode: number; output: string }> {
	const prompt = buildNodePrompt(ctx.cwd, workflow, run, node, runDir, nodeDir);
	writeFileSync(join(nodeDir, "prompt.md"), prompt, "utf-8");
	const result = await runPiPrint(ctx.cwd, prompt, signal, {
		eventLogPath: join(nodeDir, "events.jsonl"),
		transcriptPath: join(nodeDir, "agent-output.md"),
	});
	writeFileSync(join(nodeDir, "agent-output.md"), result.output, "utf-8");
	return result;
}

async function executeMultiAgentNode(
	ctx: ExtensionCommandContext,
	workflow: WorkflowDefinition,
	run: WorkflowRun,
	node: WorkflowNode,
	runDir: string,
	nodeDir: string,
	signal?: AbortSignal,
): Promise<{ exitCode: number; output: string }> {
	const executor = node.executor;
	const phases = executor?.phases ?? [];
	if (phases.length === 0) return { exitCode: 1, output: "multi-agent executor requires phases" };

	const sharedDir = validateDeclaredArtifactPath(nodeDir, "shared artifacts directory", executor?.protocol?.sharedArtifactsDir ?? "shared");
	const messagesDir = validateDeclaredArtifactPath(nodeDir, "messages directory", "messages");
	const agentsDir = validateDeclaredArtifactPath(nodeDir, "agents directory", "agents");
	mkdirSync(sharedDir.absolutePath, { recursive: true });
	mkdirSync(agentsDir.absolutePath, { recursive: true });
	mkdirSync(messagesDir.absolutePath, { recursive: true });
	writeFileSync(join(nodeDir, "prompt.md"), buildNodePrompt(ctx.cwd, workflow, run, node, runDir, nodeDir), "utf-8");

	const phaseSummaries: string[] = [];
	for (const phase of phases) {
		if (signal?.aborted) return { exitCode: 130, output: phaseSummaries.join("\n\n") };
		const phaseOutputs = validateDeclaredArtifactPaths(nodeDir, `phase ${phase.id} output`, phase.outputs ?? []);
		const phaseDir = join(agentsDir.absolutePath, phase.id);
		mkdirSync(phaseDir, { recursive: true });
		const prompt = buildMultiAgentPhasePrompt(ctx.cwd, workflow, run, node, phase, runDir, nodeDir);
		writeFileSync(join(phaseDir, "prompt.md"), prompt, "utf-8");
		const result = await runPiPrint(ctx.cwd, prompt, signal, {
			eventLogPath: join(phaseDir, "events.jsonl"),
			transcriptPath: join(phaseDir, "agent-output.md"),
		});
		writeFileSync(join(phaseDir, "agent-output.md"), result.output, "utf-8");
		phaseSummaries.push(`## Phase: ${phase.id}\n\nAgent: ${phase.agent}\nExit: ${result.exitCode}\n\nTranscript: ${relative(ctx.cwd, join(phaseDir, "agent-output.md"))}`);
		// Keep the parent multi-agent node transcript useful while the node is still
		// running, so inspect/Q can open a live phase summary instead of showing no file.
		writeFileSync(join(nodeDir, "agent-output.md"), phaseSummaries.join("\n\n"), "utf-8");
		if (result.exitCode !== 0) {
			const output = phaseSummaries.join("\n\n");
			writeFileSync(join(nodeDir, "agent-output.md"), output, "utf-8");
			return { exitCode: result.exitCode, output };
		}
		for (const artifact of phaseOutputs) {
			try {
				requireNonEmptyDeclaredArtifact(nodeDir, `phase ${phase.id} output`, artifact.relativePath);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				phaseSummaries.push(`## Phase failure\n\nPhase: ${phase.id}\nArtifact: ${artifact.relativePath}\nReason: ${message}`);
				const output = phaseSummaries.join("\n\n");
				writeFileSync(join(nodeDir, "agent-output.md"), output, "utf-8");
				return { exitCode: 1, output };
			}
		}
	}

	const output = phaseSummaries.join("\n\n");
	writeFileSync(join(nodeDir, "agent-output.md"), output, "utf-8");
	return { exitCode: 0, output };
}

function summarizeExecutionFailure(result: { exitCode: number; output: string }): string {
	const reason = result.output.match(/^Reason:\s*(.+)$/m)?.[1]
		?? result.output.match(/^Artifact:\s*(.+)$/m)?.[1]
		?? result.output.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
	return reason ? `Agent process failed with exit code ${result.exitCode}: ${reason.slice(0, 300)}` : `Agent process failed with exit code ${result.exitCode}`;
}

function buildMultiAgentPhasePrompt(
	cwd: string,
	workflow: WorkflowDefinition,
	run: WorkflowRun,
	node: WorkflowNode,
	phase: WorkflowNodeExecutorPhase,
	runDir: string,
	nodeDir: string,
): string {
	const executor = node.executor;
	const agents = executor?.agents ?? [];
	const agent = agents.find((item) => item.id === phase.agent);
	const sharedDir = validateDeclaredArtifactPath(nodeDir, "shared artifacts directory", executor?.protocol?.sharedArtifactsDir ?? "shared");
	const messagesDir = validateDeclaredArtifactPath(nodeDir, "messages directory", "messages");
	const phaseOutputs = validateDeclaredArtifactPaths(nodeDir, `phase ${phase.id} output`, phase.outputs ?? []);
	const parentOutputs = validateDeclaredArtifactPaths(nodeDir, "parent node output", node.outputs ?? ["result.json", "report.md"]);
	const nodeInputs = resolveNodeInputs(cwd, node, run, runDir);
	const phaseInputs = (phase.inputs ?? []).map((input) => resolveMultiAgentPhasePath(cwd, run, nodeDir, input));
	return `# Multi-Agent Workflow Node Phase\n\nYou are executing one real Pi sub-agent phase inside a multi-agent workflow node.\n\nThis is not a broadcast chat. Only do the work assigned to your phase. Communicate by writing explicit artifacts/messages.\n\n## Workflow\n\nName: ${workflow.name}\nRun ID: ${run.runId}\n\n## Parent Node\n\nID: ${node.id}\nTitle: ${node.title ?? node.id}\nGoal: ${node.goal ?? node.description ?? "Complete this node."}\nOutput directory: ${relative(cwd, nodeDir)}\n\n## Phase\n\nID: ${phase.id}\nAgent: ${phase.agent}\nRole: ${agent?.role ?? phase.agent}\nGoal: ${phase.goal ?? phase.prompt ?? "Complete this phase."}\nPrompt: ${phase.prompt ?? phase.goal ?? "Complete this phase."}\nTriggered by: ${phase.triggeredBy ?? "workflow engine"}\n\n## Agent Responsibilities\n\n${(agent?.responsibilities ?? []).map((item) => `- ${item}`).join("\n") || "- Follow the phase prompt."}\n\n## Protocol\n\n- Coordinator: ${executor?.coordinator ?? "manager"}\n- Mode: ${executor?.protocol?.mode ?? "managed-routing"}\n- Broadcast: ${executor?.protocol?.broadcast === true ? "true" : "false"}\n- Rule: ${executor?.protocol?.rule ?? "Agents do not respond unless explicitly assigned a task by the coordinator."}\n- Shared artifacts directory: ${relative(cwd, sharedDir.absolutePath)}\n- Messages directory: ${relative(cwd, messagesDir.absolutePath)}\n\n## Available Inputs\n\n${[...nodeInputs, ...phaseInputs].map((input) => `- ${input}`).join("\n") || "- (none)"}\n\n## Required Phase Outputs\n\n${phaseOutputs.map((output) => `- ${relative(cwd, output.absolutePath)}`).join("\n") || "- Write useful phase artifacts under shared/ or messages/."}\n\n## Finalization Rule\n\nOnly the coordinator/finalize phase should write the parent node's result.json and report.md. If this phase is not finalization, do not mark the parent node complete.\n\nParent node final required outputs:\n${parentOutputs.map((output) => `- ${relative(cwd, output.absolutePath)}`).join("\n")}\n\n## Important\n\n- Do not modify workflow topology or run.json.\n- Do not broadcast requests to all agents. Address messages to a specific next agent/coordinator.\n- If you need to pass work to another agent, write a JSONL message in messages/ with from/to/type/artifact/summary.\n- Keep artifacts concise and actionable.\n`;
}

function resolveMultiAgentPhasePath(cwd: string, run: WorkflowRun, nodeDir: string, value: string): string {
	let resolved = value.replace(/\{\{inputs\.spec\}\}/g, run.inputs.spec);
	if (resolved.includes("{{")) return resolved;
	if (isAbsolute(resolved)) return resolved;
	if (resolved.startsWith(".workflow/") || resolved.startsWith("specs/") || resolved.startsWith("docs/") || resolved.startsWith("requirements/")) return resolved;
	return relative(cwd, join(nodeDir, resolved));
}

async function abortWorkflowRun(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return ctx.ui.notify("workflow:abort requires interactive mode", "error");

	let runPath: string | null = null;
	const explicit = args?.trim();
	if (explicit) {
		try {
			runPath = resolveRunPath(ctx.cwd, explicit);
		} catch (err) {
			return ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		}
		if (!existsSync(runPath)) return ctx.ui.notify(`Run not found: ${explicit}`, "error");
	} else {
		const runs = listRuns(ctx.cwd).filter((item) => !["completed", "failed", "aborted"].includes(item.run.status));
		if (runs.length === 0) return ctx.ui.notify("No active workflow runs to abort", "info");
		runPath = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			return new RunListComponent(tui, theme, "Abort Workflow Run", runs, done, "Select a run to abort. Completed/failed/aborted runs are hidden.", "up/down select   |   Enter abort selected run   |   Esc cancel");
		}, {
			overlay: true,
			overlayOptions: { anchor: "center", width: 96, maxHeight: "82%", margin: 2 },
		});
		if (!runPath) return;
	}

	activeWorkflowExecutions.get(runPath)?.controller.abort();

	let abortedRunId = "";
	await updateRunSerialized(runPath, (run) => {
		abortedRunId = run.runId;
		const now = new Date().toISOString();
		run.status = "aborted";
		(run as WorkflowRun & { abortedAt?: string; abortReason?: string }).abortedAt = now;
		(run as WorkflowRun & { abortedAt?: string; abortReason?: string }).abortReason = "aborted manually";
		for (const state of Object.values(run.nodes)) {
			if (["running", "ready", "blocked", "waiting-approval"].includes(state.status)) {
				state.status = "failed";
				state.completedAt = now;
				state.summary = state.summary ? `${state.summary}; aborted manually` : "aborted manually";
			}
		}
	});
	ctx.ui.notify(`Aborted workflow run: ${abortedRunId}`, "info");
}


async function inspectWorkflowRun(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return ctx.ui.notify("workflow:inspect requires interactive mode", "error");

	let runPath: string | null = null;
	const explicit = args?.trim();
	if (explicit) {
		try {
			runPath = resolveRunPath(ctx.cwd, explicit);
		} catch (err) {
			return ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		}
		if (!existsSync(runPath)) return ctx.ui.notify(`Run not found: ${explicit}`, "error");
	} else {
		const runs = listRuns(ctx.cwd);
		if (runs.length === 0) return ctx.ui.notify("No workflow runs found", "info");
		runPath = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			return new RunListComponent(tui, theme, "Inspect Workflow Run", runs, done, "Select a run to inspect.", "up/down select   |   Enter inspect selected run   |   Esc cancel");
		}, {
			overlay: true,
			overlayOptions: { anchor: "center", width: 104, maxHeight: "82%", margin: 2 },
		});
		if (!runPath) return;
	}

	let run = reconcileRunFromArtifacts(runPath, ctx.cwd);
	if (!activeWorkflowExecutions.has(runPath) && Object.values(run.nodes).some((state) => state.status === "running")) {
		run = markStaleRunningNodesInterrupted(runPath, ctx.cwd);
	}
	const result = await ctx.ui.custom<{ action: "close" | "retry"; nodeId?: string } | undefined>((tui, theme, _kb, done) => {
		return new RunDetailComponent(tui, theme, ctx.cwd, runPath!, run, done);
	}, {
		overlay: true,
		overlayOptions: { anchor: "center", width: "88%", maxHeight: "88%", margin: 2 },
	});
	if (result?.action === "retry") {
		await retryOrResumeWorkflowRun(runPath, ctx.cwd);
		ctx.ui.notify(`Retry/resume scheduled for ${relative(ctx.cwd, runPath)}.`, "info");
		await startWorkflowRun(runPath, ctx);
	}
}

async function retryOrResumeWorkflowRun(runPath: string, cwd: string): Promise<void> {
	await updateRunSerialized(runPath, (run) => {
		const workflow = loadWorkflow(resolveWorkflowFilePath(cwd, run.workflowFile));
		const runDir = dirname(runPath);
		const retryable = new Set(["failed", "needs-revision", "running"]);
		const seeds = Object.entries(run.nodes).filter(([, state]) => retryable.has(state.status)).map(([id]) => id);
		const affected = collectDescendants(workflow, seeds);
		for (const nodeId of affected) {
			const state = run.nodes[nodeId];
			if (!state || state.status === "completed" || state.status === "skipped") continue;
			const blockers = workflow.edges.filter((edge) => edge.to === nodeId).map((edge) => edge.from).filter((from) => run.nodes[from]?.status !== "completed");
			run.nodes[nodeId] = blockers.length > 0 ? { status: "blocked", blockedBy: blockers, verification: undefined } : { status: "ready", blockedBy: [], verification: undefined };
			const nodeDir = join(runDir, "nodes", nodeId);
			for (const file of ["result.json", "verification.json"]) {
				try { rmSync(join(nodeDir, file), { force: true }); } catch {}
			}
		}
		run.status = "created";
		delete (run as WorkflowRun & { abortedAt?: string; abortReason?: string }).abortedAt;
		delete (run as WorkflowRun & { abortedAt?: string; abortReason?: string }).abortReason;
		refreshReadyStates(run, workflow);
		updateRunAggregateStatus(run);
	});
}

function collectDescendants(workflow: WorkflowDefinition, seeds: string[]): Set<string> {
	const result = new Set<string>(seeds);
	const queue = [...seeds];
	while (queue.length > 0) {
		const id = queue.shift()!;
		for (const edge of workflow.edges.filter((edge) => edge.from === id)) {
			if (result.has(edge.to)) continue;
			result.add(edge.to);
			queue.push(edge.to);
		}
	}
	return result;
}

function ensureWorkflowGitignore(cwd: string): void {
	const path = join(cwd, ".gitignore");
	const entry = ".workflow/";
	try {
		const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
		if (existing.split(/\r?\n/).some((line) => line.trim() === entry)) return;
		appendFileSync(path, `${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${entry}\n`, "utf-8");
	} catch {
		// Best-effort only; workflow execution should not fail because .gitignore could not be updated.
	}
}

async function updateRunSerialized(runPath: string, updater: (run: WorkflowRun) => void | Promise<void>): Promise<void> {
	const previous = runUpdateQueues.get(runPath) ?? Promise.resolve();
	let next: Promise<void>;
	next = previous.then(async () => {
		const run = loadRun(runPath);
		await updater(run);
		saveRun(runPath, run);
	});
	runUpdateQueues.set(runPath, next.catch(() => {}));
	await next;
}

function readyNodeIds(run: WorkflowRun): string[] {
	return Object.entries(run.nodes).filter(([, state]) => state.status === "ready").map(([id]) => id);
}

function markStaleRunningNodesInterrupted(runPath: string, cwd: string): WorkflowRun {
	const run = loadRun(runPath);
	if (run.status === "aborted") return run;
	const now = new Date().toISOString();
	let changed = false;
	for (const state of Object.values(run.nodes)) {
		if (state.status !== "running") continue;
		state.status = "failed";
		state.completedAt = now;
		state.summary = state.summary ? `${state.summary}; interrupted with no active executor` : "interrupted with no active executor";
		changed = true;
	}
	if (changed) {
		updateRunAggregateStatus(run);
		saveRun(runPath, run);
	}
	return run;
}

function reconcileRunFromArtifacts(runPath: string, cwd: string, onlyNodeId?: string): WorkflowRun {
	const run = loadRun(runPath);
	if (run.status === "aborted") return run;
	const workflow = loadWorkflow(resolveWorkflowFilePath(cwd, run.workflowFile));
	const runDir = dirname(runPath);
	const nodes = onlyNodeId ? workflow.nodes.filter((node) => node.id === onlyNodeId) : workflow.nodes;

	for (const node of nodes) {
		const nodeDir = join(runDir, "nodes", node.id);
		const state = run.nodes[node.id];
		if (!state) continue;
		if (state.verification?.status === "failed") {
			run.nodes[node.id] = {
				...state,
				status: "needs-revision",
				summary: state.summary ?? `Goal verification failed: ${state.verification.reason ?? "semantic verification failed"}`,
			};
			continue;
		}
		const canRepairNeedsRevision = workflow.name === "code-review" && state.status === "needs-revision";
		if (["completed", "failed", "skipped"].includes(state.status) || (state.status === "needs-revision" && !canRepairNeedsRevision)) continue;
		const phaseFailure = node.executor?.kind === "multi-agent" && !existsSync(join(nodeDir, "result.json")) ? detectMultiAgentPhaseFailure(nodeDir) : null;
		if (phaseFailure) {
			run.nodes[node.id] = {
				...state,
				status: "failed",
				completedAt: new Date().toISOString(),
				summary: `Multi-agent phase ${phaseFailure.phaseId} failed with exit code ${phaseFailure.exitCode}`,
			};
			continue;
		}
		if (!existsSync(join(nodeDir, "result.json"))) continue;
		const completion = checkNodeCompletion(node, nodeDir, { treatNeedsRevisionAsCompleted: node.completionPolicy?.needsRevisionBlocks === false || node.completionPolicy?.findingsAreSuccess === true });
		run.nodes[node.id] = {
			...state,
			status: completion.status,
			completedAt: new Date().toISOString(),
			result: relative(runDir, join(nodeDir, "result.json")),
			outputs: completion.outputs.map((output) => relative(runDir, join(nodeDir, output))),
			summary: completion.summary,
			verification: completion.status === "completed" ? state.verification : undefined,
		};
	}

	refreshReadyStates(run, workflow);
	updateRunAggregateStatus(run);
	saveRun(runPath, run);
	return run;
}

function detectMultiAgentPhaseFailure(nodeDir: string): { phaseId: string; exitCode: number } | null {
	const summaryPath = join(nodeDir, "agent-output.md");
	if (!existsSync(summaryPath)) return null;
	const summary = readFileSync(summaryPath, "utf-8");
	const pattern = /## Phase:\s*([^\n]+)[\s\S]*?Exit:\s*(\d+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(summary)) !== null) {
		const exitCode = Number(match[2]);
		if (Number.isFinite(exitCode) && exitCode !== 0) return { phaseId: match[1]!.trim(), exitCode };
	}
	return null;
}

async function pickWorkflow(ctx: ExtensionCommandContext): Promise<string | null> {
	let workflows = listWorkflowNames(ctx.cwd);
	if (workflows.length === 0) {
		ensureSampleWorkflow(getWorkflowPath(ctx.cwd, "demo"), "demo");
		workflows = listWorkflowNames(ctx.cwd);
	}

	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		return new WorkflowListComponent(tui, theme, workflows, done);
	}, {
		overlay: true,
		overlayOptions: { anchor: "center", width: 72, maxHeight: "80%", margin: 2 },
	});
}

async function pickSpec(ctx: ExtensionCommandContext, workflow: WorkflowDefinition): Promise<string | null> {
	const allSpecs = listSpecFiles(ctx.cwd);
	const specs = allSpecs.filter((spec) => {
		try {
			return readWorkflowNameFromSpec(isAbsolute(spec) ? spec : join(ctx.cwd, spec)) === workflow.name;
		} catch {
			return false;
		}
	});
	if (specs.length === 0) {
		ctx.ui.notify(`No spec files found for workflow ${workflow.name}. Use /workflow:create to generate one, or pass a matching spec explicitly.`, "warning");
		return null;
	}

	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		return new SpecListComponent(tui, theme, workflow, specs, done);
	}, {
		overlay: true,
		overlayOptions: { anchor: "center", width: 88, maxHeight: "82%", margin: 2 },
	});
}
