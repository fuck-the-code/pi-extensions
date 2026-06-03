import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";

interface WorkflowNodeLayout {
	x?: number;
	y?: number;
	width?: number;
}

interface WorkflowNode {
	id: string;
	title?: string;
	type?: string;
	goal?: string;
	prompt?: string;
	references?: string[];
	// Deprecated/compat: older workflow files may still use skill/description.
	skill?: string;
	description?: string;
	requiresApproval?: boolean;
	inputs?: string[];
	outputs?: string[];
	additionalPrompt?: string;
	layout?: WorkflowNodeLayout;
	status?: string;
}

interface WorkflowInputValidation {
	requiredSections?: string[];
	forbiddenPlaceholders?: string[];
}

interface WorkflowInputDefinition {
	type: "file";
	required?: boolean;
	template?: string;
	validation?: WorkflowInputValidation;
}

type WorkflowInputs = Record<string, WorkflowInputDefinition>;

interface WorkflowEdge {
	from: string;
	to: string;
}

interface WorkflowDefinition {
	version: number;
	name: string;
	description?: string;
	inputs?: WorkflowInputs;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
}

type DesignerResult =
	| { action: "close" }
	| { action: "edit"; nodeId: string }
	| { action: "reload"; selectedId?: string };

type EditResult = { action: "save"; node: WorkflowNode } | { action: "cancel" };

const DEFAULT_WORKFLOW_NAME = "demo";

type RunNodeStatus = "blocked" | "ready" | "running" | "waiting-approval" | "completed" | "failed" | "needs-revision" | "skipped";

interface WorkflowRunNodeState {
	status: RunNodeStatus;
	blockedBy?: string[];
	startedAt?: string | null;
	completedAt?: string | null;
	result?: string | null;
	outputs?: string[];
	summary?: string;
}

interface WorkflowRun {
	runId: string;
	workflow: string;
	workflowFile: string;
	status: "created" | "running" | "paused" | "completed" | "failed" | "aborted";
	createdAt: string;
	inputs: Record<string, string>;
	originalInputs: Record<string, string>;
	nodes: Record<string, WorkflowRunNodeState>;
}

export default function workflowDesignerExtension(pi: ExtensionAPI) {
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

		const workflowPath = getWorkflowPath(ctx.cwd, workflowName);
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
				overlayOptions: {
					anchor: "center",
					width: "96%",
					maxHeight: "92%",
					margin: 1,
				},
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
				overlayOptions: {
					anchor: "center",
					width: "76%",
					maxHeight: "88%",
					margin: 2,
				},
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

	pi.registerCommand("workflow:designer", {
		description: "Open visual workflow designer",
		handler: openDesigner,
	});


	pi.registerCommand("workflow:list", {
		description: "Pick a workflow and open designer",
		handler: async (_args, ctx) => {
			await openDesigner(undefined, ctx);
		},
	});

	pi.registerCommand("workflow:run", {
		description: "Create a workflow run from a workflow template and spec",
		handler: async (args, ctx) => {
			await createRun(args, ctx);
		},
	});

	pi.registerCommand("workflow:step", {
		description: "Execute ready workflow node(s). Use --parallel to run all ready nodes concurrently",
		handler: async (args, ctx) => {
			await executeWorkflowStep(args, ctx);
		},
	});

	pi.registerCommand("workflow:approve", {
		description: "Approve a waiting workflow node and unblock downstream nodes",
		handler: async (args, ctx) => {
			await approveWorkflowNode(args, ctx);
		},
	});

	pi.registerCommand("workflow:reject", {
		description: "Reject a waiting workflow node and mark it needs-revision",
		handler: async (args, ctx) => {
			await rejectWorkflowNode(args, ctx);
		},
	});

	pi.registerCommand("workflow:status", {
		description: "Show latest workflow run status",
		handler: async (args, ctx) => {
			await showWorkflowStatus(args, ctx);
		},
	});

	pi.registerCommand("workflow:create", {
		description: "Pick a workflow and copy its required spec template into the editor",
		handler: async (args, ctx) => {
			await createSpecFromWorkflow(args, ctx);
		},
	});

	pi.registerCommand("workflow:abort", {
		description: "Open a run list and abort the selected workflow run",
		handler: async (args, ctx) => {
			await abortWorkflowRun(args, ctx);
		},
	});

	pi.registerCommand("workflow:inspect", {
		description: "Open a run list and inspect workflow run details",
		handler: async (args, ctx) => {
			await inspectWorkflowRun(args, ctx);
		},
	});
}

async function inspectWorkflowRun(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("workflow:inspect requires interactive mode", "error");
		return;
	}

	let runPath: string | null = null;
	const explicit = args?.trim();
	if (explicit) {
		runPath = resolveRunPath(ctx.cwd, explicit);
		if (!existsSync(runPath)) {
			ctx.ui.notify(`Run not found: ${explicit}`, "error");
			return;
		}
	} else {
		const runs = listRuns(ctx.cwd);
		if (runs.length === 0) {
			ctx.ui.notify("No workflow runs found", "info");
			return;
		}
		runPath = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			return new RunListComponent(
				tui,
				theme,
				"Inspect Workflow Run",
				runs,
				done,
				"Select a run to inspect.",
				"up/down select   |   Enter inspect selected run   |   Esc cancel",
			);
		}, {
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: 104,
				maxHeight: "82%",
				margin: 2,
			},
		});
		if (!runPath) return;
	}

	const run = loadRun(runPath);
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		return new RunDetailComponent(tui, theme, ctx.cwd, runPath!, run, done);
	}, {
		overlay: true,
		overlayOptions: {
			anchor: "center",
			width: "88%",
			maxHeight: "88%",
			margin: 2,
		},
	});
}

async function abortWorkflowRun(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("workflow:abort requires interactive mode", "error");
		return;
	}

	let runPath: string | null = null;
	const explicit = args?.trim();
	if (explicit) {
		runPath = resolveRunPath(ctx.cwd, explicit);
		if (!existsSync(runPath)) {
			ctx.ui.notify(`Run not found: ${explicit}`, "error");
			return;
		}
	} else {
		const runs = listRuns(ctx.cwd).filter((item) => !["completed", "failed", "aborted"].includes(item.run.status));
		if (runs.length === 0) {
			ctx.ui.notify("No active workflow runs to abort", "info");
			return;
		}
		runPath = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			return new RunListComponent(
				tui,
				theme,
				"Abort Workflow Run",
				runs,
				done,
				"Select a run to abort. Completed/failed/aborted runs are hidden.",
				"up/down select   |   Enter abort selected run   |   Esc cancel",
			);
		}, {
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: 96,
				maxHeight: "82%",
				margin: 2,
			},
		});
		if (!runPath) return;
	}

	const run = loadRun(runPath);
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
	saveRun(runPath, run);
	ctx.ui.notify(`Aborted workflow run: ${run.runId}`, "info");
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

	const workflowPath = getWorkflowPath(ctx.cwd, workflowName);
	ensureSampleWorkflow(workflowPath, workflowName);
	const workflow = loadWorkflow(workflowPath);
	const markdown = buildSpecTemplateMarkdown(workflow);

	const confirmed = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
		return new SpecTemplatePreviewComponent(tui, theme, workflow, markdown, done);
	}, {
		overlay: true,
		overlayOptions: {
			anchor: "center",
			width: "82%",
			maxHeight: "88%",
			margin: 2,
		},
	});

	if (!confirmed) return;
	ctx.ui.setEditorText(markdown);
	ctx.ui.notify("Spec template copied into editor. Edit it, then save it as a spec file.", "info");
}

async function approveWorkflowNode(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	const { runPath, nodeId } = resolveRunAndNodeArgs(ctx.cwd, args);
	if (!runPath) {
		ctx.ui.notify("No workflow run found.", "error");
		return;
	}

	const run = loadRun(runPath);
	const workflow = loadWorkflow(join(ctx.cwd, run.workflowFile));
	const targetNodeId = nodeId ?? findFirstNodeByStatus(run, "waiting-approval");
	if (!targetNodeId) {
		ctx.ui.notify("No node waiting for approval.", "info");
		return;
	}

	const state = run.nodes[targetNodeId];
	if (!state) {
		ctx.ui.notify(`Unknown run node: ${targetNodeId}`, "error");
		return;
	}
	if (state.status !== "waiting-approval") {
		ctx.ui.notify(`Node ${targetNodeId} is ${state.status}, not waiting-approval.`, "warning");
		return;
	}

	run.nodes[targetNodeId] = {
		...state,
		status: "completed",
		completedAt: state.completedAt ?? new Date().toISOString(),
	};
	refreshReadyStates(run, workflow);
	updateRunAggregateStatus(run);
	saveRun(runPath, run);
	ctx.ui.notify(`Approved node: ${targetNodeId}`, "info");
}

async function rejectWorkflowNode(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	const { runPath, nodeId } = resolveRunAndNodeArgs(ctx.cwd, args);
	if (!runPath) {
		ctx.ui.notify("No workflow run found.", "error");
		return;
	}

	const run = loadRun(runPath);
	const targetNodeId = nodeId ?? findFirstNodeByStatus(run, "waiting-approval");
	if (!targetNodeId) {
		ctx.ui.notify("No node waiting for approval.", "info");
		return;
	}

	const state = run.nodes[targetNodeId];
	if (!state) {
		ctx.ui.notify(`Unknown run node: ${targetNodeId}`, "error");
		return;
	}
	if (state.status !== "waiting-approval") {
		ctx.ui.notify(`Node ${targetNodeId} is ${state.status}, not waiting-approval.`, "warning");
		return;
	}

	run.nodes[targetNodeId] = {
		...state,
		status: "needs-revision",
		completedAt: new Date().toISOString(),
	};
	run.status = "paused";
	saveRun(runPath, run);
	ctx.ui.notify(`Rejected node: ${targetNodeId}`, "info");
}

async function showWorkflowStatus(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	const { runPath } = resolveRunAndNodeArgs(ctx.cwd, args);
	if (!runPath) {
		ctx.ui.notify("No workflow run found.", "error");
		return;
	}
	const run = loadRun(runPath);
	const workflow = loadWorkflow(join(ctx.cwd, run.workflowFile));
	refreshReadyStates(run, workflow);
	updateRunAggregateStatus(run);
	saveRun(runPath, run);

	const counts = Object.values(run.nodes).reduce<Record<string, number>>((acc, state) => {
		acc[state.status] = (acc[state.status] ?? 0) + 1;
		return acc;
	}, {});
	const summary = Object.entries(counts).map(([status, count]) => `${status}:${count}`).join(" ");
	ctx.ui.notify(`Run ${run.runId} [${run.status}] ${summary}`, "info");
}

async function createRun(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("workflow:run requires interactive mode", "error");
		return;
	}

	const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
	let workflowName = parts[0];
	let specPath = parts[1];

	if (!workflowName) {
		workflowName = await pickWorkflow(ctx);
		if (!workflowName) return;
	}

	const workflowPath = getWorkflowPath(ctx.cwd, workflowName);
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

	const validation = validateSpec(absSpecPath, workflow.inputs?.spec?.validation);
	if (validation.errors.length > 0) {
		ctx.ui.notify(`Spec validation warnings: ${validation.errors.join("; ")}`, "warning");
	}

	const runId = makeRunId(workflow.name, absSpecPath);
	const runDir = join(ctx.cwd, ".workflow", "runs", runId);
	const inputsDir = join(runDir, "inputs");
	mkdirSync(inputsDir, { recursive: true });
	mkdirSync(join(runDir, "nodes"), { recursive: true });

	const copiedSpec = join(inputsDir, "spec.md");
	copyFileSync(absSpecPath, copiedSpec);

	const run: WorkflowRun = {
		runId,
		workflow: workflow.name,
		workflowFile: relative(ctx.cwd, workflowPath),
		status: "created",
		createdAt: new Date().toISOString(),
		inputs: {
			spec: relative(ctx.cwd, copiedSpec),
		},
		originalInputs: {
			spec: relative(ctx.cwd, absSpecPath),
		},
		nodes: createInitialNodeStates(workflow),
	};

	writeFileSync(join(runDir, "run.json"), `${JSON.stringify(run, null, "\t")}\n`, "utf-8");
	ctx.ui.notify(`Created workflow run: ${relative(ctx.cwd, join(runDir, "run.json"))}`, "info");
}

async function executeWorkflowStep(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
	const parallel = parts.includes("--parallel") || parts.includes("-p");
	const explicitRun = parts.find((part) => !part.startsWith("-"));
	const runPath = explicitRun ? resolveRunPath(ctx.cwd, explicitRun) : pickLatestRunPath(ctx.cwd);
	if (!runPath) {
		ctx.ui.notify("No workflow run found. Create one with /workflow:run first.", "error");
		return;
	}

	let run = loadRun(runPath);
	const workflow = loadWorkflow(join(ctx.cwd, run.workflowFile));
	refreshReadyStates(run, workflow);
	saveRun(runPath, run);

	const readyNodeIds = Object.entries(run.nodes).filter(([, state]) => state.status === "ready").map(([id]) => id);
	if (readyNodeIds.length === 0) {
		ctx.ui.notify("No ready workflow nodes.", "info");
		return;
	}

	const selectedIds = parallel ? readyNodeIds : [readyNodeIds[0]!];
	ctx.ui.notify(`Executing ${selectedIds.length} node(s): ${selectedIds.join(", ")}`, "info");

	if (parallel) {
		await Promise.all(selectedIds.map((nodeId) => executeOneNode(ctx, runPath, workflow, nodeId)));
	} else {
		await executeOneNode(ctx, runPath, workflow, selectedIds[0]!);
	}

	run = loadRun(runPath);
	refreshReadyStates(run, workflow);
	saveRun(runPath, run);
	ctx.ui.notify(`Workflow step complete: ${relative(ctx.cwd, runPath)}`, "info");
}

async function executeOneNode(ctx: ExtensionCommandContext, runPath: string, workflow: WorkflowDefinition, nodeId: string): Promise<void> {
	let run = loadRun(runPath);
	const node = workflow.nodes.find((n) => n.id === nodeId);
	if (!node) {
		ctx.ui.notify(`Unknown node: ${nodeId}`, "error");
		return;
	}

	const runDir = dirname(runPath);
	const nodeDir = join(runDir, "nodes", node.id);
	mkdirSync(nodeDir, { recursive: true });
	const prompt = buildNodePrompt(workflow, run, node, runDir, nodeDir);
	writeFileSync(join(nodeDir, "prompt.md"), prompt, "utf-8");

	run.nodes[node.id] = {
		...run.nodes[node.id],
		status: "running",
		startedAt: new Date().toISOString(),
	};
	run.status = "running";
	saveRun(runPath, run);

	const result = await runPiPrint(ctx.cwd, prompt);
	writeFileSync(join(nodeDir, "agent-output.md"), result.output, "utf-8");

	run = loadRun(runPath);
	if (result.exitCode !== 0) {
		run.nodes[node.id] = {
			...run.nodes[node.id],
			status: "failed",
			completedAt: new Date().toISOString(),
			summary: `Agent process failed with exit code ${result.exitCode}`,
		};
		run.status = "paused";
		saveRun(runPath, run);
		return;
	}

	const completion = checkNodeCompletion(node, nodeDir);
	run.nodes[node.id] = {
		...run.nodes[node.id],
		status: completion.status,
		completedAt: new Date().toISOString(),
		result: relative(runDir, join(nodeDir, "result.json")),
		outputs: completion.outputs.map((output) => relative(runDir, join(nodeDir, output))),
		summary: completion.summary,
	};
	if (completion.status === "failed" || completion.status === "needs-revision") run.status = "paused";
	saveRun(runPath, run);
}

function buildNodePrompt(workflow: WorkflowDefinition, run: WorkflowRun, node: WorkflowNode, runDir: string, nodeDir: string): string {
	const resolvedInputs = resolveNodeInputs(node, run, runDir);
	return `# Workflow Node Execution\n\nYou are executing one node in a goal-driven workflow.\n\n## Workflow\n\nName: ${workflow.name}\nRun ID: ${run.runId}\n\n## Initial Spec\n\nPath: ${run.inputs.spec}\n\nThe initial spec is the source of truth for this workflow run.\n\n## Current Node\n\nID: ${node.id}\nTitle: ${node.title ?? node.id}\nType: ${node.type ?? "node"}\n\n## Node Goal\n\n${node.goal ?? node.description ?? "Complete this node."}\n\n## Node Prompt\n\n${node.prompt ?? node.additionalPrompt ?? node.description ?? node.goal ?? "Complete this node."}\n\n## References\n\n${(node.references ?? []).map((ref) => `- ${ref}`).join("\n") || "- (none)"}\n\n## Inputs\n\n${resolvedInputs.map((input) => `- ${input}`).join("\n") || "- (none)"}\n\n## Required Output Directory\n\nWrite all node outputs under:\n\n${relative(process.cwd(), nodeDir)}\n\n## Required Outputs\n\n${(node.outputs ?? ["result.json", "report.md"]).map((output) => `- ${relative(process.cwd(), join(nodeDir, output))}`).join("\n")}\n\n## Result Contract\n\nYou must write result.json exactly in this shape:\n\n\`\`\`json\n{\n  "status": "passed | completed | failed | needs-revision",\n  "summary": "short summary",\n  "issues": [\n    { "severity": "critical | major | minor", "message": "issue description" }\n  ],\n  "outputs": ["report.md"]\n}\n\`\`\`\n\n## Completion Rules\n\nThe node is not complete until:\n\n1. result.json exists in the node output directory.\n2. result.json.status is one of passed, completed, failed, needs-revision.\n3. All required outputs exist and are non-empty.\n4. The node goal has been addressed.\n\n## Important Rules\n\n- Do not modify workflow topology or run.json.\n- Prefer writing only inside this node output directory unless implementation work explicitly requires code changes.\n- Upstream outputs are available through the input paths listed above.\n`;
}

function resolveNodeInputs(node: WorkflowNode, run: WorkflowRun, runDir: string): string[] {
	return (node.inputs ?? []).map((input) => {
		let value = input;
		value = value.replace(/\{\{inputs\.spec\}\}/g, run.inputs.spec);
		value = value.replace(/\{\{nodes\.([^.}]+)\.outputs\.report\}\}/g, (_match, nodeId: string) => {
			return relative(process.cwd(), join(runDir, "nodes", nodeId, "report.md"));
		});
		return value;
	});
}

async function runPiPrint(cwd: string, prompt: string): Promise<{ exitCode: number; output: string }> {
	return await new Promise((resolve) => {
		const child = spawn("pi", ["-p", prompt], { cwd, env: process.env });
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk.toString(); });
		child.stderr.on("data", (chunk) => { output += chunk.toString(); });
		child.on("close", (code) => resolve({ exitCode: code ?? 1, output }));
		child.on("error", (err) => resolve({ exitCode: 1, output: String(err) }));
	});
}

function checkNodeCompletion(node: WorkflowNode, nodeDir: string): { status: RunNodeStatus; outputs: string[]; summary: string } {
	const requiredOutputs = node.outputs ?? ["result.json", "report.md"];
	const resultPath = join(nodeDir, "result.json");
	if (!existsSync(resultPath)) return { status: "failed", outputs: [], summary: "Missing result.json" };

	let parsed: { status?: string; summary?: string; outputs?: string[] };
	try {
		parsed = JSON.parse(readFileSync(resultPath, "utf-8"));
	} catch (err) {
		return { status: "failed", outputs: [], summary: `Invalid result.json: ${err instanceof Error ? err.message : String(err)}` };
	}

	const declaredOutputs = Array.from(new Set([...(parsed.outputs ?? []), ...requiredOutputs]));
	for (const output of declaredOutputs) {
		const outputPath = join(nodeDir, output);
		if (!existsSync(outputPath) || !statSync(outputPath).isFile() || statSync(outputPath).size === 0) {
			return { status: "failed", outputs: declaredOutputs, summary: `Missing or empty output: ${output}` };
		}
	}

	const status = parsed.status === "failed" || parsed.status === "needs-revision" ? parsed.status : (node.requiresApproval ? "waiting-approval" : "completed");
	return { status, outputs: declaredOutputs, summary: parsed.summary ?? "" };
}

function loadRun(path: string): WorkflowRun {
	return JSON.parse(readFileSync(path, "utf-8")) as WorkflowRun;
}

function saveRun(path: string, run: WorkflowRun): void {
	writeFileSync(path, `${JSON.stringify(run, null, "\t")}\n`, "utf-8");
}

function resolveRunPath(cwd: string, value: string): string {
	if (isAbsolute(value)) return value;
	if (value.endsWith("run.json")) return join(cwd, value);
	return join(cwd, ".workflow", "runs", value, "run.json");
}

function pickLatestRunPath(cwd: string): string | null {
	const runs = listRuns(cwd);
	return runs[0]?.path ?? null;
}

function listRuns(cwd: string): Array<{ path: string; run: WorkflowRun; mtimeMs: number }> {
	const runsDir = join(cwd, ".workflow", "runs");
	if (!existsSync(runsDir)) return [];
	return readdirSync(runsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(runsDir, entry.name, "run.json"))
		.filter((path) => existsSync(path))
		.map((path) => {
			try {
				return { path, run: loadRun(path), mtimeMs: statSync(path).mtimeMs };
			} catch {
				return null;
			}
		})
		.filter((item): item is { path: string; run: WorkflowRun; mtimeMs: number } => item !== null)
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function refreshReadyStates(run: WorkflowRun, workflow: WorkflowDefinition): void {
	for (const node of workflow.nodes) {
		const state = run.nodes[node.id];
		if (!state || !["blocked", "ready"].includes(state.status)) continue;
		const blockers = workflow.edges
			.filter((edge) => edge.to === node.id)
			.map((edge) => edge.from)
			.filter((from) => run.nodes[from]?.status !== "completed");
		run.nodes[node.id] = blockers.length > 0 ? { ...state, status: "blocked", blockedBy: blockers } : { ...state, status: "ready", blockedBy: [] };
	}
}

function updateRunAggregateStatus(run: WorkflowRun): void {
	const states = Object.values(run.nodes).map((state) => state.status);
	if (states.some((status) => status === "failed" || status === "needs-revision")) {
		run.status = "paused";
		return;
	}
	if (states.some((status) => status === "waiting-approval")) {
		run.status = "paused";
		return;
	}
	if (states.every((status) => status === "completed" || status === "skipped")) {
		run.status = "completed";
		return;
	}
	if (states.some((status) => status === "running")) {
		run.status = "running";
		return;
	}
	run.status = "created";
}

function findFirstNodeByStatus(run: WorkflowRun, status: RunNodeStatus): string | undefined {
	return Object.entries(run.nodes).find(([, state]) => state.status === status)?.[0];
}

function resolveRunAndNodeArgs(cwd: string, args: string | undefined): { runPath: string | null; nodeId?: string } {
	const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
	let runPath: string | null = null;
	let nodeId: string | undefined;

	for (const part of parts) {
		const maybeRunPath = resolveRunPath(cwd, part);
		if (existsSync(maybeRunPath)) {
			runPath = maybeRunPath;
		} else {
			nodeId = part;
		}
	}

	return { runPath: runPath ?? pickLatestRunPath(cwd), nodeId };
}

async function pickWorkflow(ctx: ExtensionCommandContext): Promise<string | null> {
	let workflows = listWorkflowNames(ctx.cwd);
	if (workflows.length === 0) {
		ensureSampleWorkflow(getWorkflowPath(ctx.cwd, DEFAULT_WORKFLOW_NAME), DEFAULT_WORKFLOW_NAME);
		workflows = listWorkflowNames(ctx.cwd);
	}

	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		return new WorkflowListComponent(tui, theme, workflows, done);
	}, {
		overlay: true,
		overlayOptions: {
			anchor: "center",
			width: 72,
			maxHeight: "80%",
			margin: 2,
		},
	});
}

async function pickSpec(ctx: ExtensionCommandContext, workflow: WorkflowDefinition): Promise<string | null> {
	const specs = listSpecFiles(ctx.cwd);
	if (specs.length === 0) {
		ctx.ui.notify("No spec files found. Pass a spec path explicitly: /workflow:run <workflow> <spec>", "warning");
		return null;
	}

	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		return new SpecListComponent(tui, theme, workflow, specs, done);
	}, {
		overlay: true,
		overlayOptions: {
			anchor: "center",
			width: 88,
			maxHeight: "82%",
			margin: 2,
		},
	});
}

function listSpecFiles(cwd: string): string[] {
	const roots = ["specs", ".workflow/specs", ".pi/specs", "docs", "requirements"];
	const results: string[] = [];
	for (const root of roots) {
		const abs = join(cwd, root);
		if (existsSync(abs)) collectSpecFiles(cwd, abs, results, 0);
	}
	return Array.from(new Set(results)).sort();
}

function collectSpecFiles(cwd: string, dir: string, results: string[], depth: number): void {
	if (depth > 4) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (["node_modules", "dist", "build", "coverage", ".git"].includes(entry.name)) continue;
			collectSpecFiles(cwd, abs, results, depth + 1);
		} else if (/\.(md|txt|json|ya?ml)$/i.test(entry.name)) {
			results.push(relative(cwd, abs));
		}
	}
}

function createInitialNodeStates(workflow: WorkflowDefinition): Record<string, WorkflowRunNodeState> {
	const states: Record<string, WorkflowRunNodeState> = {};
	for (const node of workflow.nodes) {
		const blockers = workflow.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from);
		states[node.id] = blockers.length > 0 ? { status: "blocked", blockedBy: blockers } : { status: "ready", blockedBy: [] };
	}
	return states;
}

function validateSpec(path: string, validation: WorkflowInputValidation | undefined): { errors: string[] } {
	const errors: string[] = [];
	const content = readFileSync(path, "utf-8");
	for (const section of validation?.requiredSections ?? []) {
		const pattern = new RegExp(`(^|\\n)#{1,6}\\s+${escapeRegExp(section)}\\b`, "i");
		if (!pattern.test(content)) errors.push(`missing section: ${section}`);
	}
	for (const placeholder of validation?.forbiddenPlaceholders ?? []) {
		if (content.includes(placeholder)) errors.push(`contains placeholder: ${placeholder}`);
	}
	return { errors };
}

function makeRunId(workflowName: string, specPath: string): string {
	const now = new Date();
	const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
	const specName = basename(specPath).replace(/\.[^.]+$/, "");
	return `${slug(workflowName)}-${slug(specName)}-${stamp}`;
}

function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "run";
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSpecTemplateMarkdown(workflow: WorkflowDefinition): string {
	const spec = workflow.inputs?.spec;
	const template = spec?.template ?? "spec-v1";
	const requiredSections = spec?.validation?.requiredSections ?? ["Goal", "Requirements", "Acceptance Criteria"];
	const forbidden = spec?.validation?.forbiddenPlaceholders ?? [];

	const lines: string[] = [];
	lines.push("---");
	lines.push(`template: ${template}`);
	lines.push(`workflow: ${workflow.name}`);
	lines.push("title: ");
	lines.push("---");
	lines.push("");
	lines.push(`# Spec: <title>`);
	lines.push("");
	lines.push(`> Workflow: ${workflow.name}`);
	lines.push(`> Template: ${template}`);
	if (forbidden.length > 0) {
		lines.push(`> Do not leave placeholders: ${forbidden.join(", ")}`);
	}
	lines.push("");

	for (const section of requiredSections) {
		lines.push(`## ${section}`);
		lines.push("");
		lines.push(sectionHint(section));
		lines.push("");
	}

	return lines.join("\n");
}

function sectionHint(section: string): string {
	const key = section.toLowerCase();
	if (key.includes("goal")) return "Describe the outcome this work must achieve.";
	if (key.includes("background") || key.includes("context")) return "Explain why this work is needed and any relevant context.";
	if (key.includes("requirement")) return "- List concrete functional requirements here.";
	if (key.includes("non-goal")) return "- List what is explicitly out of scope.";
	if (key.includes("acceptance")) return "- List observable criteria that prove the work is complete.";
	if (key.includes("constraint")) return "- List technical, product, security, compatibility, or timeline constraints.";
	if (key.includes("open")) return "- List unresolved questions, or write `None` if there are no open questions.";
	return "Fill in this section.";
}

function listWorkflowNames(cwd: string): string[] {
	const dir = join(cwd, ".pi", "workflows");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".workflow.json"))
		.map((file) => file.slice(0, -".workflow.json".length))
		.sort();
}

function getWorkflowPath(cwd: string, name: string): string {
	const file = name.endsWith(".workflow.json") ? name : `${name}.workflow.json`;
	return join(cwd, ".pi", "workflows", file);
}

function loadWorkflow(path: string): WorkflowDefinition {
	const raw = readFileSync(path, "utf-8");
	const parsed = JSON.parse(raw) as WorkflowDefinition;
	if (!Array.isArray(parsed.nodes)) throw new Error("workflow.nodes must be an array");
	if (!Array.isArray(parsed.edges)) throw new Error("workflow.edges must be an array");
	return normalizeWorkflow(parsed);
}

function normalizeWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
	workflow.inputs ??= {
		spec: {
			type: "file",
			required: true,
			template: "feature-spec-v1",
			validation: {
				requiredSections: ["Goal", "Requirements", "Acceptance Criteria"],
				forbiddenPlaceholders: ["TODO", "TBD", "<fill me>"],
			},
		},
	};
	for (const node of workflow.nodes) {
		node.goal ??= node.description ?? (node.skill ? `Complete the ${node.skill} workflow node.` : `Complete node ${node.id}.`);
		node.prompt ??= node.additionalPrompt ?? node.description ?? node.goal;
		node.references ??= [];
		node.outputs ??= ["result.json", "report.md"];
	}
	return workflow;
}

function saveWorkflow(path: string, workflow: WorkflowDefinition): void {
	writeFileSync(path, `${JSON.stringify(workflow, null, "\t")}\n`, "utf-8");
}

function ensureSampleWorkflow(path: string, name: string): void {
	if (existsSync(path)) return;
	mkdirSync(join(path, ".."), { recursive: true });
	const sample: WorkflowDefinition = {
		version: 1,
		name,
		description: "Demo goal-driven spec-first workflow. Edges are read-only; nodes are goal/prompt driven.",
		inputs: {
			spec: {
				type: "file",
				required: true,
				template: "feature-spec-v1",
				validation: {
					requiredSections: ["Goal", "Background", "Requirements", "Non-goals", "Acceptance Criteria", "Constraints", "Open Questions"],
					forbiddenPlaceholders: ["TODO", "TBD", "<fill me>"],
				},
			},
		},
		nodes: [
			{
				id: "spec-check",
				title: "Spec Check",
				type: "review",
				goal: "Validate that the selected spec is complete and actionable enough to start development.",
				prompt: "Check the selected spec against the required template. Identify missing sections, ambiguity, risks, and decide whether development may proceed.",
				references: [],
				requiresApproval: true,
				inputs: ["{{inputs.spec}}"],
				outputs: ["result.json", "report.md"],
				status: "ready",
			},
			{
				id: "frontend",
				title: "Frontend Implementation",
				type: "implementation",
				goal: "Implement the frontend portion of the approved spec with focused, reviewable changes.",
				prompt: "Read the initial spec and upstream node outputs. Implement only frontend-scoped changes and write a concise implementation report.",
				references: [],
				requiresApproval: false,
				inputs: ["{{inputs.spec}}", "{{nodes.spec-check.outputs.report}}"],
				outputs: ["result.json", "report.md"],
				status: "blocked",
			},
			{
				id: "backend",
				title: "Backend Implementation",
				type: "implementation",
				goal: "Implement the backend portion of the approved spec with focused, reviewable changes.",
				prompt: "Read the initial spec and upstream node outputs. Implement only backend-scoped changes and write a concise implementation report.",
				references: [],
				requiresApproval: false,
				inputs: ["{{inputs.spec}}", "{{nodes.spec-check.outputs.report}}"],
				outputs: ["result.json", "report.md"],
				status: "blocked",
			},
			{
				id: "integration",
				title: "Integration Review",
				type: "integration",
				goal: "Integrate and verify the frontend and backend results against the original spec.",
				prompt: "Review upstream implementation outputs, resolve integration concerns, and produce a final integration report.",
				references: [],
				requiresApproval: true,
				inputs: ["{{inputs.spec}}", "{{nodes.frontend.outputs.report}}", "{{nodes.backend.outputs.report}}"],
				outputs: ["result.json", "report.md"],
				status: "blocked",
			},
		],
		edges: [
			{ from: "spec-check", to: "frontend" },
			{ from: "spec-check", to: "backend" },
			{ from: "frontend", to: "integration" },
			{ from: "backend", to: "integration" },
		],
	};
	saveWorkflow(path, sample);
}

class RunListComponent {
	private selected = 0;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private title: string,
		private runs: Array<{ path: string; run: WorkflowRun; mtimeMs: number }>,
		private done: (result: string | null) => void,
		private description = "Select a run.",
		private hint = "up/down select   |   Enter select   |   Esc cancel",
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down")) this.selected = Math.min(this.runs.length - 1, this.selected + 1);
		else if (isEnter(data)) this.done(this.runs[this.selected]?.path ?? null);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const outerW = Math.max(70, width);
		const innerW = Math.max(1, outerW - 2);
		const th = this.theme;
		const lines: string[] = [];
		lines.push(topBorder(innerW, ` ${this.title} `, th));
		lines.push(sideLine(pad(` ${this.description}`, innerW), th));
		lines.push(sideLine("-".repeat(innerW), th, "+", "+"));

		const visible = Math.max(1, Math.min(this.runs.length, 14));
		const start = Math.max(0, Math.min(this.selected - Math.floor(visible / 2), Math.max(0, this.runs.length - visible)));
		for (let i = 0; i < visible; i++) {
			const index = start + i;
			const item = this.runs[index];
			if (!item) continue;
			const selected = index === this.selected;
			const counts = Object.values(item.run.nodes).reduce<Record<string, number>>((acc, state) => {
				acc[state.status] = (acc[state.status] ?? 0) + 1;
				return acc;
			}, {});
			const statusSummary = Object.entries(counts).map(([status, count]) => `${status}:${count}`).join(" ");
			const raw = ` ${selected ? ">" : " "} ${item.run.runId} [${item.run.status}] ${statusSummary}`;
			lines.push(sideLine(padAnsi(selected ? th.fg("accent", raw) : raw, innerW), th));
		}
		if (this.runs.length === 0) lines.push(sideLine(pad(" No runs.", innerW), th));

		lines.push(sideLine("-".repeat(innerW), th, "+", "+"));
		lines.push(sideLine(pad(` ${this.hint}`, innerW), th));
		lines.push(bottomBorder(innerW, th));
		return lines.map((line) => truncateToWidth(line, outerW, "", true));
	}

	invalidate(): void {}
}

class RunDetailComponent {
	private selected = 0;
	private scroll = 0;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private cwd: string,
		private runPath: string,
		private run: WorkflowRun,
		private done: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}
		const nodeIds = Object.keys(this.run.nodes);
		if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down")) this.selected = Math.min(nodeIds.length - 1, this.selected + 1);
		else if (matchesKey(data, "left")) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, "right")) this.scroll++;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const outerW = Math.max(90, width);
		const innerW = Math.max(1, outerW - 2);
		const th = this.theme;
		const lines: string[] = [];
		const nodeIds = Object.keys(this.run.nodes);
		const selectedNodeId = nodeIds[this.selected];
		const selectedState = selectedNodeId ? this.run.nodes[selectedNodeId] : undefined;
		const leftW = Math.min(54, Math.max(36, Math.floor(innerW * 0.44)));
		const rightW = innerW - leftW - 1;
		const bodyH = 22;

		lines.push(topBorder(innerW, ` Workflow Run: ${this.run.runId} `, th));
		lines.push(sideLine(pad(` Status: ${this.run.status} | Workflow: ${this.run.workflow} | File: ${relative(this.cwd, this.runPath)}`, innerW), th));
		lines.push(sideLine(pad(` Spec: ${this.run.inputs.spec} | Original: ${this.run.originalInputs.spec ?? ""}`, innerW), th));
		lines.push(sideLine("-".repeat(innerW), th, "+", "+"));

		const detailLines = selectedNodeId && selectedState ? this.nodeDetailLines(selectedNodeId, selectedState, rightW) : ["No node selected"];
		this.scroll = clamp(this.scroll, 0, Math.max(0, detailLines.length - bodyH));
		for (let i = 0; i < bodyH; i++) {
			const nodeIndex = i;
			let left = "";
			if (nodeIndex < nodeIds.length) {
				const id = nodeIds[nodeIndex]!;
				const state = this.run.nodes[id]!;
				left = ` ${nodeIndex === this.selected ? ">" : " "} ${id} [${state.status}]`;
			}
			const right = detailLines[this.scroll + i] ?? "";
			lines.push(sideLine(padAnsi(truncateToWidth(left, leftW, "..."), leftW) + "|" + padAnsi(truncateToWidth(` ${right}`, rightW, "..."), rightW), th));
		}

		lines.push(sideLine("-".repeat(innerW), th, "+", "+"));
		lines.push(sideLine(pad(" up/down select node   |   left/right scroll details   |   Esc close", innerW), th));
		lines.push(bottomBorder(innerW, th));
		return lines.map((line) => truncateToWidth(line, outerW, "", true));
	}

	private nodeDetailLines(nodeId: string, state: WorkflowRunNodeState, width: number): string[] {
		const runDir = dirname(this.runPath);
		const nodeDir = join(runDir, "nodes", nodeId);
		const resultPath = join(nodeDir, "result.json");
		const reportPath = join(nodeDir, "report.md");
		const promptPath = join(nodeDir, "prompt.md");
		const agentOutputPath = join(nodeDir, "agent-output.md");
		const lines = [
			`Node: ${nodeId}`,
			`Status: ${state.status}`,
			`Started: ${state.startedAt ?? "-"}`,
			`Completed: ${state.completedAt ?? "-"}`,
			`Blocked by: ${(state.blockedBy ?? []).join(", ") || "-"}`,
			`Summary: ${state.summary ?? "-"}`,
			"",
			"Files:",
			`- ${relative(this.cwd, promptPath)} ${existsSync(promptPath) ? "(exists)" : ""}`,
			`- ${relative(this.cwd, agentOutputPath)} ${existsSync(agentOutputPath) ? "(exists)" : ""}`,
			`- ${relative(this.cwd, resultPath)} ${existsSync(resultPath) ? "(exists)" : ""}`,
			`- ${relative(this.cwd, reportPath)} ${existsSync(reportPath) ? "(exists)" : ""}`,
			"",
			"Declared outputs:",
			...(state.outputs ?? []).map((output) => `- ${output}`),
		];
		if (existsSync(resultPath)) {
			lines.push("", "result.json:");
			try {
				const parsed = JSON.parse(readFileSync(resultPath, "utf-8"));
				lines.push(...JSON.stringify(parsed, null, 2).split("\n"));
			} catch {
				lines.push(...readFileSync(resultPath, "utf-8").split("\n"));
			}
		}
		return lines.map((line) => truncateToWidth(line, width - 1, "..."));
	}

	invalidate(): void {}
}

class SpecTemplatePreviewComponent {
	private scroll = 0;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private workflow: WorkflowDefinition,
		private markdown: string,
		private done: (result: boolean) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(false);
			return;
		}
		if (isEnter(data)) {
			this.done(true);
			return;
		}
		if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, "down")) this.scroll++;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const outerW = Math.max(70, width);
		const innerW = Math.max(1, outerW - 2);
		const th = this.theme;
		const lines: string[] = [];
		const contentLines = this.markdown.split("\n");
		const visibleH = 22;
		this.scroll = clamp(this.scroll, 0, Math.max(0, contentLines.length - visibleH));

		lines.push(topBorder(innerW, ` Spec Template: ${this.workflow.name} `, th));
		lines.push(sideLine(pad(" This is the required starting spec format. Press Enter to copy it into the editor.", innerW), th));
		lines.push(sideLine("-".repeat(innerW), th, "+", "+"));
		for (const line of contentLines.slice(this.scroll, this.scroll + visibleH)) {
			lines.push(sideLine(pad(truncateToWidth(` ${line}`, innerW, "..."), innerW), th));
		}
		for (let i = Math.min(visibleH, contentLines.length - this.scroll); i < visibleH; i++) {
			lines.push(sideLine(pad("", innerW), th));
		}
		lines.push(sideLine("-".repeat(innerW), th, "+", "+"));
		lines.push(sideLine(pad(" up/down scroll   |   Enter copy to editor   |   Esc cancel", innerW), th));
		lines.push(bottomBorder(innerW, th));
		return lines.map((line) => truncateToWidth(line, outerW, "", true));
	}

	invalidate(): void {}
}

class SpecListComponent {
	private selected = 0;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private workflow: WorkflowDefinition,
		private specs: string[],
		private done: (result: string | null) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down")) this.selected = Math.min(this.specs.length - 1, this.selected + 1);
		else if (isEnter(data)) this.done(this.specs[this.selected] ?? null);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const outerW = Math.max(60, width);
		const innerW = Math.max(1, outerW - 2);
		const th = this.theme;
		const template = this.workflow.inputs?.spec?.template ?? "(none)";
		const lines: string[] = [];
		lines.push(topBorder(innerW, " Select Spec ", th));
		lines.push(sideLine(pad(` Workflow: ${this.workflow.name} | spec template: ${template}`, innerW), th));
		lines.push(sideLine("-".repeat(innerW), th, "+", "+"));

		const visible = Math.max(1, Math.min(this.specs.length, 14));
		const start = Math.max(0, Math.min(this.selected - Math.floor(visible / 2), Math.max(0, this.specs.length - visible)));
		for (let i = 0; i < visible; i++) {
			const index = start + i;
			const spec = this.specs[index] ?? "";
			const selected = index === this.selected;
			const raw = ` ${selected ? ">" : " "} ${spec}`;
			lines.push(sideLine(padAnsi(selected ? th.fg("accent", raw) : raw, innerW), th));
		}
		if (this.specs.length === 0) lines.push(sideLine(pad(" No specs found.", innerW), th));

		lines.push(sideLine("-".repeat(innerW), th, "+", "+"));
		lines.push(sideLine(pad(" up/down select   |   Enter use spec   |   Esc cancel", innerW), th));
		lines.push(bottomBorder(innerW, th));
		return lines.map((line) => truncateToWidth(line, outerW, "", true));
	}

	invalidate(): void {}
}

class WorkflowListComponent {
	private selected = 0;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private workflows: string[],
		private done: (result: string | null) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down")) this.selected = Math.min(this.workflows.length - 1, this.selected + 1);
		else if (isEnter(data)) this.done(this.workflows[this.selected] ?? null);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const outerW = Math.max(50, width);
		const innerW = Math.max(1, outerW - 2);
		const th = this.theme;
		const lines: string[] = [];
		lines.push(topBorder(innerW, " Select Workflow ", th));
		lines.push(sideLine(pad(" Choose a workflow to open its DAG designer.", innerW), th));
		lines.push(sideLine("-".repeat(innerW), th, "+", "+"));

		const visible = Math.max(1, Math.min(this.workflows.length, 12));
		const start = Math.max(0, Math.min(this.selected - Math.floor(visible / 2), Math.max(0, this.workflows.length - visible)));
		for (let i = 0; i < visible; i++) {
			const index = start + i;
			const name = this.workflows[index] ?? "";
			const selected = index === this.selected;
			const raw = ` ${selected ? ">" : " "} ${name}.workflow.json`;
			lines.push(sideLine(padAnsi(selected ? th.fg("accent", raw) : raw, innerW), th));
		}
		if (this.workflows.length === 0) {
			lines.push(sideLine(pad(" No workflows found.", innerW), th));
		}

		lines.push(sideLine("-".repeat(innerW), th, "+", "+"));
		lines.push(sideLine(pad(" updown select   |   Enter open   |   Esc close", innerW), th));
		lines.push(bottomBorder(innerW, th));
		return lines.map((line) => truncateToWidth(line, outerW, "", true));
	}

	invalidate(): void {}
}

class WorkflowDesignerComponent {
	private selectedId: string | undefined;
	private layout: Map<string, Required<WorkflowNodeLayout>> = new Map();

	constructor(
		private tui: TUI,
		private theme: Theme,
		private workflow: WorkflowDefinition,
		selectedId: string | undefined,
		private done: (result: DesignerResult) => void,
	) {
		this.selectedId = selectedId ?? workflow.nodes[0]?.id;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ action: "close" });
			return;
		}
		if (isEnter(data)) {
			if (this.selectedId) this.done({ action: "edit", nodeId: this.selectedId });
			return;
		}
		if (matchesKey(data, "r")) {
			this.done({ action: "reload", selectedId: this.selectedId });
			return;
		}
		if (matchesKey(data, "left")) this.selectByDirection("left");
		else if (matchesKey(data, "right")) this.selectByDirection("right");
		else if (matchesKey(data, "up")) this.selectByDirection("up");
		else if (matchesKey(data, "down")) this.selectByDirection("down");
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const outerW = Math.max(60, width);
		const innerW = Math.max(1, outerW - 2);
		const graphW = innerW;
		const graphH = 27;
		this.layout = centerLayout(computeLayout(this.workflow, graphW, graphH), graphW, graphH);

		const canvas = createCanvas(graphW, graphH);
		// Draw edges first, then nodes. Nodes must stay rectangular; edges should never
		// overwrite node borders or text because that makes the graph look misaligned.
		drawEdges(canvas, this.workflow, this.layout);
		for (const node of this.workflow.nodes) {
			const box = this.layout.get(node.id);
			if (!box) continue;
			drawNode(canvas, node, box, node.id === this.selectedId);
		}

		const th = this.theme;
		const lines: string[] = [];
		const title = ` Workflow Designer: ${this.workflow.name} `;
		lines.push(topBorder(innerW, title, th));
		lines.push(sideLine(pad(` ${this.workflow.description ?? "Edges are read-only. Press Enter on a node to edit properties."}`, innerW), th));
		lines.push(sideLine("-".repeat(innerW), th, "+", "+"));

		for (const row of canvas) {
			lines.push(sideLine(row.join(""), th));
		}

		lines.push(sideLine("-".repeat(innerW), th, "+", "+"));
		const selected = this.workflow.nodes.find((n) => n.id === this.selectedId);
		const summary = selected
			? ` Selected: ${selected.id} | title: ${selected.title ?? ""} | goal: ${truncateToWidth(selected.goal ?? selected.description ?? "", 60, "...")}`
			: " No node selected";
		lines.push(sideLine(pad(summary, innerW), th));
		lines.push(sideLine(pad(" leftupdownright select node   |   Enter edit node   |   r reload   |   Esc close", innerW), th));
		lines.push(bottomBorder(innerW, th));
		return lines.map((line) => truncateToWidth(line, outerW, "", true));
	}

	invalidate(): void {}

	private selectByDirection(direction: "left" | "right" | "up" | "down"): void {
		if (!this.selectedId && this.workflow.nodes[0]) {
			this.selectedId = this.workflow.nodes[0].id;
			return;
		}
		const current = this.workflow.nodes.find((n) => n.id === this.selectedId);
		const currentBox = current ? this.layout.get(current.id) : undefined;
		if (!current || !currentBox) return;

		let candidates: WorkflowNode[] = [];
		if (direction === "right") {
			const downstream = this.workflow.edges.filter((e) => e.from === current.id).map((e) => e.to);
			candidates = this.workflow.nodes.filter((n) => downstream.includes(n.id));
		} else if (direction === "left") {
			const upstream = this.workflow.edges.filter((e) => e.to === current.id).map((e) => e.from);
			candidates = this.workflow.nodes.filter((n) => upstream.includes(n.id));
		}

		if (candidates.length === 0) {
			candidates = this.workflow.nodes.filter((n) => {
				const b = this.layout.get(n.id);
				if (!b || n.id === current.id) return false;
				if (direction === "left") return b.x < currentBox.x;
				if (direction === "right") return b.x > currentBox.x;
				if (direction === "up") return b.y < currentBox.y;
				return b.y > currentBox.y;
			});
		}

		let best: WorkflowNode | undefined;
		let bestScore = Number.POSITIVE_INFINITY;
		for (const candidate of candidates) {
			const b = this.layout.get(candidate.id);
			if (!b) continue;
			const dx = b.x - currentBox.x;
			const dy = b.y - currentBox.y;
			const score = direction === "left" || direction === "right" ? Math.abs(dx) * 2 + Math.abs(dy) : Math.abs(dy) * 2 + Math.abs(dx);
			if (score < bestScore) {
				best = candidate;
				bestScore = score;
			}
		}
		if (best) this.selectedId = best.id;
	}
}

class NodeEditorComponent {
	private draft: WorkflowNode;
	private selected = 0;
	private editing = false;
	private editBuffer = "";
	private fields: FieldDef[];

	constructor(
		private tui: TUI,
		private theme: Theme,
		node: WorkflowNode,
		private done: (result: EditResult) => void,
	) {
		this.draft = JSON.parse(JSON.stringify(node)) as WorkflowNode;
		this.fields = [
			{ key: "id", label: "id", type: "readonly", section: "Basic" },
			{ key: "title", label: "title", type: "string", section: "Basic" },
			{ key: "type", label: "type", type: "string", section: "Basic" },
			{ key: "goal", label: "goal", type: "string", section: "Goal-driven Execution" },
			{ key: "prompt", label: "prompt", type: "string", section: "Goal-driven Execution" },
			{ key: "references", label: "references", type: "list", section: "Goal-driven Execution" },
			{ key: "requiresApproval", label: "requiresApproval", type: "boolean", section: "Gate" },
			{ key: "status", label: "status", type: "string", section: "Runtime Preview" },
			{ key: "inputs", label: "inputs", type: "list", section: "Inputs / Outputs" },
			{ key: "outputs", label: "outputs", type: "list", section: "Inputs / Outputs" },
			{ key: "skill", label: "skill (compat)", type: "string", section: "Compatibility" },
			{ key: "description", label: "description (compat)", type: "string", section: "Compatibility" },
		];
	}

	handleInput(data: string): void {
		if (this.editing) {
			this.handleEditInput(data);
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done({ action: "cancel" });
			return;
		}
		if (matchesKey(data, "ctrl+s")) {
			this.done({ action: "save", node: this.draft });
			return;
		}
		if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down")) this.selected = Math.min(this.fields.length - 1, this.selected + 1);
		else if (matchesKey(data, "tab")) this.selected = (this.selected + 1) % this.fields.length;
		else if (isEnter(data) || matchesKey(data, "space")) this.startEditingOrToggle();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const outerW = Math.max(70, width);
		const innerW = Math.max(1, outerW - 2);
		const th = this.theme;
		const lines: string[] = [];
		lines.push(topBorder(innerW, ` Edit Node: ${this.draft.id} `, th));

		let lastSection = "";
		for (let i = 0; i < this.fields.length; i++) {
			const field = this.fields[i]!;
			if (field.section !== lastSection) {
				if (lastSection) lines.push(sideLine(pad("", innerW), th));
				lines.push(sideLine(pad(` ${field.section}`, innerW), th));
				lines.push(sideLine(pad(` ${"-".repeat(Math.min(42, innerW - 2))}`, innerW), th));
				lastSection = field.section;
			}

			const selected = i === this.selected;
			const cursor = selected ? th.fg("accent", ">") : " ";
			const label = padRight(field.label, 20);
			let value = formatFieldValue(this.draft, field);
			if (selected && this.editing) value = `${this.editBuffer}|`;
			const ro = field.type === "readonly" ? th.fg("dim", " readonly") : "";
			const raw = ` ${cursor} ${label} ${value}${ro}`;
			const line = selected ? th.fg("accent", raw) : raw;
			lines.push(sideLine(padAnsi(line, innerW), th));
		}

		lines.push(sideLine(pad("", innerW), th));
		lines.push(sideLine("-".repeat(innerW), th, "+", "+"));
		const hint = this.editing
			? " editing: type value   |   Enter commit   |   Esc discard field edit"
			: " updown select field   |   Enter edit/toggle   |   Ctrl+S save   |   Esc cancel";
		lines.push(sideLine(pad(hint, innerW), th));
		lines.push(bottomBorder(innerW, th));
		return lines.map((line) => truncateToWidth(line, outerW, "", true));
	}

	invalidate(): void {}

	private startEditingOrToggle(): void {
		const field = this.fields[this.selected];
		if (!field || field.type === "readonly") return;
		if (field.type === "boolean") {
			(this.draft as Record<string, unknown>)[field.key] = !(this.draft as Record<string, unknown>)[field.key];
			return;
		}
		this.editing = true;
		this.editBuffer = rawFieldValue(this.draft, field);
	}

	private handleEditInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.editing = false;
			this.editBuffer = "";
			this.tui.requestRender();
			return;
		}
		if (isEnter(data)) {
			const field = this.fields[this.selected];
			if (field) commitFieldValue(this.draft, field, this.editBuffer);
			this.editing = false;
			this.editBuffer = "";
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.editBuffer = this.editBuffer.slice(0, -1);
		} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.editBuffer += data;
		}
		this.tui.requestRender();
	}
}

interface FieldDef {
	key: keyof WorkflowNode;
	label: string;
	type: "readonly" | "string" | "boolean" | "list";
	section: string;
}

function rawFieldValue(node: WorkflowNode, field: FieldDef): string {
	const value = node[field.key];
	if (Array.isArray(value)) return value.join(", ");
	if (typeof value === "boolean") return String(value);
	if (typeof value === "string") return value;
	return "";
}

function formatFieldValue(node: WorkflowNode, field: FieldDef): string {
	const raw = rawFieldValue(node, field);
	return raw.length > 0 ? raw : "(empty)";
}

function commitFieldValue(node: WorkflowNode, field: FieldDef, value: string): void {
	const target = node as Record<string, unknown>;
	if (field.type === "list") {
		target[field.key] = value
			.split(",")
			.map((v) => v.trim())
			.filter(Boolean);
	} else if (field.type === "string") {
		target[field.key] = value;
	}
}

function computeLayout(workflow: WorkflowDefinition, width: number, height: number): Map<string, Required<WorkflowNodeLayout>> {
	// Dagre-style layered layout, left-to-right:
	// 1. assign each node to a rank by longest path from sources
	// 2. order nodes within each rank by barycenter of connected neighbours
	// 3. center every rank vertically and the whole graph horizontally
	// 4. route edges later as orthogonal segments between ranks
	const result = new Map<string, Required<WorkflowNodeLayout>>();
	if (workflow.nodes.length === 0) return result;

	const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
	const ranks = computeRanks(workflow);
	const maxRank = Math.max(0, ...Array.from(ranks.values()));
	const layers: WorkflowNode[][] = Array.from({ length: maxRank + 1 }, () => []);
	for (const node of workflow.nodes) {
		layers[ranks.get(node.id) ?? 0]!.push(node);
	}

	orderLayersByBarycenter(layers, workflow.edges);

	const nodeWidths = new Map<string, number>();
	for (const node of workflow.nodes) {
		const preferred = node.layout?.width;
		nodeWidths.set(node.id, clamp(preferred ?? measureNodeWidth(node), 20, 38));
	}

	const layerWidths = layers.map((layer) => Math.max(0, ...layer.map((node) => nodeWidths.get(node.id) ?? 24)));
	const rankCount = layers.length;
	const minGapX = 6;
	const preferredGapX = 12;
	const totalNodeW = layerWidths.reduce((sum, w) => sum + w, 0);
	const availableGap = Math.max(0, width - totalNodeW - 2);
	const gapX = rankCount <= 1 ? 0 : clamp(Math.floor(availableGap / (rankCount - 1)), minGapX, preferredGapX);
	const graphW = totalNodeW + gapX * Math.max(0, rankCount - 1);
	let x = Math.max(0, Math.floor((width - graphW) / 2));

	for (let rank = 0; rank < layers.length; rank++) {
		const layer = layers[rank]!;
		const layerW = layerWidths[rank] ?? 24;
		const nodeH = 5;
		const maxGapY = 4;
		const minGapY = 1;
		const availableYGap = layer.length <= 1 ? 0 : Math.floor((height - layer.length * nodeH) / (layer.length - 1));
		const gapY = layer.length <= 1 ? 0 : clamp(availableYGap, minGapY, maxGapY);
		const layerH = layer.length * nodeH + Math.max(0, layer.length - 1) * gapY;
		let y = Math.max(0, Math.floor((height - layerH) / 2));

		for (const node of layer) {
			const nodeW = nodeWidths.get(node.id) ?? 24;
			const nodeX = x + Math.floor((layerW - nodeW) / 2);
			result.set(node.id, {
				x: clamp(nodeX, 0, Math.max(0, width - nodeW - 1)),
				y: clamp(y, 0, Math.max(0, height - nodeH)),
				width: nodeW,
			});
			y += nodeH + gapY;
		}

		x += layerW + gapX;
	}

	// Keep dangling/invalid edge endpoints from influencing nothing; unknown nodes are ignored.
	for (const edge of workflow.edges) {
		if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
	}
	return result;
}

function measureNodeWidth(node: WorkflowNode): number {
	const title = node.title ?? node.id;
	const skill = `skill: ${node.skill ?? "-"}`;
	const status = `status: ${node.status ?? "pending"}`;
	return Math.max(20, Math.min(38, Math.max(title.length, skill.length, status.length) + 4));
}

function orderLayersByBarycenter(layers: WorkflowNode[][], edges: WorkflowEdge[]): void {
	const incoming = new Map<string, string[]>();
	const outgoing = new Map<string, string[]>();
	for (const edge of edges) {
		const ins = incoming.get(edge.to) ?? [];
		ins.push(edge.from);
		incoming.set(edge.to, ins);
		const outs = outgoing.get(edge.from) ?? [];
		outs.push(edge.to);
		outgoing.set(edge.from, outs);
	}

	for (let pass = 0; pass < 4; pass++) {
		for (let rank = 1; rank < layers.length; rank++) {
			const prevIndex = indexLayer(layers[rank - 1]!);
			layers[rank]!.sort((a, b) => barycenter(a.id, incoming, prevIndex) - barycenter(b.id, incoming, prevIndex));
		}
		for (let rank = layers.length - 2; rank >= 0; rank--) {
			const nextIndex = indexLayer(layers[rank + 1]!);
			layers[rank]!.sort((a, b) => barycenter(a.id, outgoing, nextIndex) - barycenter(b.id, outgoing, nextIndex));
		}
	}
}

function indexLayer(layer: WorkflowNode[]): Map<string, number> {
	return new Map(layer.map((node, index) => [node.id, index]));
}

function barycenter(id: string, neighbours: Map<string, string[]>, neighbourIndex: Map<string, number>): number {
	const ids = neighbours.get(id) ?? [];
	const positions = ids.map((n) => neighbourIndex.get(n)).filter((v): v is number => typeof v === "number");
	if (positions.length === 0) return Number.POSITIVE_INFINITY;
	return positions.reduce((sum, value) => sum + value, 0) / positions.length;
}

function centerLayout(
	layout: Map<string, Required<WorkflowNodeLayout>>,
	width: number,
	height: number,
): Map<string, Required<WorkflowNodeLayout>> {
	if (layout.size === 0) return layout;

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const box of layout.values()) {
		minX = Math.min(minX, box.x);
		minY = Math.min(minY, box.y);
		maxX = Math.max(maxX, box.x + box.width);
		maxY = Math.max(maxY, box.y + 5);
	}

	const contentW = maxX - minX;
	const contentH = maxY - minY;
	const dx = Math.max(0, Math.floor((width - contentW) / 2)) - minX;
	const dy = Math.max(0, Math.floor((height - contentH) / 2)) - minY;

	const centered = new Map<string, Required<WorkflowNodeLayout>>();
	for (const [id, box] of layout) {
		centered.set(id, {
			...box,
			x: clamp(box.x + dx, 0, Math.max(0, width - box.width - 1)),
			y: clamp(box.y + dy, 0, Math.max(0, height - 5)),
		});
	}
	return centered;
}

function computeRanks(workflow: WorkflowDefinition): Map<string, number> {
	const ranks = new Map<string, number>();
	for (const node of workflow.nodes) ranks.set(node.id, 0);
	for (let i = 0; i < workflow.nodes.length; i++) {
		let changed = false;
		for (const edge of workflow.edges) {
			const from = ranks.get(edge.from) ?? 0;
			const to = ranks.get(edge.to) ?? 0;
			if (to <= from) {
				ranks.set(edge.to, from + 1);
				changed = true;
			}
		}
		if (!changed) break;
	}
	return ranks;
}

function createCanvas(width: number, height: number): string[][] {
	return Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
}

function drawEdges(canvas: string[][], workflow: WorkflowDefinition, layout: Map<string, Required<WorkflowNodeLayout>>): void {
	for (const edge of workflow.edges) {
		const from = layout.get(edge.from);
		const to = layout.get(edge.to);
		if (!from || !to) continue;
		// Keep edges outside node boxes. The arrow stops immediately before the
		// target border, preserving the rectangle and avoiding apparent text shifts.
		const sx = from.x + from.width;
		const sy = from.y + 2;
		const tx = to.x - 1;
		const ty = to.y + 2;
		if (sx > tx) continue;
		const mid = Math.floor((sx + tx) / 2);
		drawH(canvas, sx, mid, sy);
		drawV(canvas, mid, sy, ty);
		drawH(canvas, mid, tx, ty);
		setCell(canvas, tx, ty, ">");
		if (sy !== ty) {
			setCell(canvas, mid, sy, "+");
			setCell(canvas, mid, ty, "+");
		}
	}
}

function drawNode(canvas: string[][], node: WorkflowNode, box: Required<WorkflowNodeLayout>, selected: boolean): void {
	const x = box.x;
	const y = box.y;
	const w = Math.max(10, box.width);
	const inner = w - 2;
	const top = selected ? `*${"=".repeat(inner)}*` : `+${"-".repeat(inner)}+`;
	const midL = selected ? "|" : "|";
	const midR = selected ? "|" : "|";
	const bottom = selected ? `*${"=".repeat(inner)}*` : `+${"-".repeat(inner)}+`;
	const selectedMark = selected ? "> " : "";
	putText(canvas, x, y, top);
	putText(canvas, x, y + 1, `${midL}${pad(truncateToWidth(`${selectedMark}${node.title ?? node.id}`, inner, "..."), inner)}${midR}`);
	putText(canvas, x, y + 2, `${midL}${pad(truncateToWidth(`skill: ${node.skill ?? "-"}`, inner, "..."), inner)}${midR}`);
	putText(canvas, x, y + 3, `${midL}${pad(truncateToWidth(`status: ${node.status ?? "pending"}`, inner, "..."), inner)}${midR}`);
	putText(canvas, x, y + 4, bottom);
}

function drawH(canvas: string[][], x1: number, x2: number, y: number): void {
	for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) mergeCell(canvas, x, y, "-");
}

function drawV(canvas: string[][], x: number, y1: number, y2: number): void {
	for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) mergeCell(canvas, x, y, "|");
}

function mergeCell(canvas: string[][], x: number, y: number, ch: string): void {
	const old = getCell(canvas, x, y);
	if (old === undefined) return;
	if (old === " " || old === ch) setCell(canvas, x, y, ch);
	else if ((old === "-" && ch === "|") || (old === "|" && ch === "-")) setCell(canvas, x, y, "+");
}

function putText(canvas: string[][], x: number, y: number, text: string): void {
	for (let i = 0; i < text.length; i++) setCell(canvas, x + i, y, text[i]!);
}

function getCell(canvas: string[][], x: number, y: number): string | undefined {
	if (y < 0 || y >= canvas.length) return undefined;
	const row = canvas[y];
	if (!row || x < 0 || x >= row.length) return undefined;
	return row[x];
}

function setCell(canvas: string[][], x: number, y: number, ch: string): void {
	if (y < 0 || y >= canvas.length) return;
	const row = canvas[y];
	if (!row || x < 0 || x >= row.length) return;
	row[x] = ch;
}

function topBorder(width: number, title: string, theme: Theme): string {
	const safeTitle = truncateToWidth(title, Math.max(0, width - 2), "");
	const titleW = visibleWidth(safeTitle);
	const left = Math.floor(Math.max(0, width - titleW) / 2);
	const right = Math.max(0, width - titleW - left);
	return theme.fg("border", `+${"-".repeat(left)}`) + theme.fg("accent", safeTitle) + theme.fg("border", `${"-".repeat(right)}+`);
}

function bottomBorder(width: number, theme: Theme): string {
	return theme.fg("border", `+${"-".repeat(width)}+`);
}

function sideLine(content: string, theme: Theme, left = "|", right = "|"): string {
	return theme.fg("border", left) + content + theme.fg("border", right);
}

function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function padAnsi(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function padRight(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function isEnter(data: string): boolean {
	return matchesKey(data, "enter") || matchesKey(data, "return");
}
