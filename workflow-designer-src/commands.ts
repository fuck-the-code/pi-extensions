import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DesignerResult, EditResult, WorkflowDefinition, WorkflowRun } from "./types";
import {
	buildNodePrompt,
	checkNodeCompletion,
	findFirstNodeByStatus,
	listRuns,
	loadRun,
	pickLatestRunPath,
	refreshReadyStates,
	resolveRunAndNodeArgs,
	resolveRunPath,
	runPiPrint,
	saveRun,
	updateRunAggregateStatus,
} from "./run";
import {
	buildSpecTemplateMarkdown,
	createInitialNodeStates,
	listSpecFiles,
	makeRunId,
	validateSpec,
} from "./spec";
import {
	ensureSampleWorkflow,
	getWorkflowPath,
	listWorkflowNames,
	loadWorkflow,
	saveWorkflow,
} from "./workflow";
import {
	NodeEditorComponent,
	RunDetailComponent,
	RunListComponent,
	SpecListComponent,
	SpecTemplatePreviewComponent,
	WorkflowDesignerComponent,
	WorkflowListComponent,
} from "./ui/components";

export function registerWorkflowCommands(pi: ExtensionAPI): void {
	pi.registerCommand("workflow:designer", {
		description: "Open visual workflow designer",
		handler: openDesigner,
	});

	pi.registerCommand("workflow:list", {
		description: "Pick a workflow and open designer",
		handler: async (_args, ctx) => openDesigner(undefined, ctx),
	});

	pi.registerCommand("workflow:run", {
		description: "Create a workflow run from a workflow template and spec",
		handler: createRun,
	});

	pi.registerCommand("workflow:step", {
		description: "Execute ready workflow node(s). Use --parallel to run all ready nodes concurrently",
		handler: executeWorkflowStep,
	});

	pi.registerCommand("workflow:approve", {
		description: "Approve a waiting workflow node and unblock downstream nodes",
		handler: approveWorkflowNode,
	});

	pi.registerCommand("workflow:reject", {
		description: "Reject a waiting workflow node and mark it needs-revision",
		handler: rejectWorkflowNode,
	});

	pi.registerCommand("workflow:status", {
		description: "Show latest workflow run status",
		handler: showWorkflowStatus,
	});

	pi.registerCommand("workflow:create", {
		description: "Pick a workflow and copy its required spec template into the editor",
		handler: createSpecFromWorkflow,
	});

	pi.registerCommand("workflow:abort", {
		description: "Open a run list and abort the selected workflow run",
		handler: abortWorkflowRun,
	});

	pi.registerCommand("workflow:inspect", {
		description: "Open a run list and inspect workflow run details",
		handler: inspectWorkflowRun,
	});
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

	const workflowPath = getWorkflowPath(ctx.cwd, workflowName);
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
		inputs: { spec: relative(ctx.cwd, copiedSpec) },
		originalInputs: { spec: relative(ctx.cwd, absSpecPath) },
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

	run.nodes[node.id] = { ...run.nodes[node.id], status: "running", startedAt: new Date().toISOString() };
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

async function approveWorkflowNode(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	const { runPath, nodeId } = resolveRunAndNodeArgs(ctx.cwd, args);
	if (!runPath) return ctx.ui.notify("No workflow run found.", "error");

	const run = loadRun(runPath);
	const workflow = loadWorkflow(join(ctx.cwd, run.workflowFile));
	const targetNodeId = nodeId ?? findFirstNodeByStatus(run, "waiting-approval");
	if (!targetNodeId) return ctx.ui.notify("No node waiting for approval.", "info");

	const state = run.nodes[targetNodeId];
	if (!state) return ctx.ui.notify(`Unknown run node: ${targetNodeId}`, "error");
	if (state.status !== "waiting-approval") return ctx.ui.notify(`Node ${targetNodeId} is ${state.status}, not waiting-approval.`, "warning");

	run.nodes[targetNodeId] = { ...state, status: "completed", completedAt: state.completedAt ?? new Date().toISOString() };
	refreshReadyStates(run, workflow);
	updateRunAggregateStatus(run);
	saveRun(runPath, run);
	ctx.ui.notify(`Approved node: ${targetNodeId}`, "info");
}

async function rejectWorkflowNode(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	const { runPath, nodeId } = resolveRunAndNodeArgs(ctx.cwd, args);
	if (!runPath) return ctx.ui.notify("No workflow run found.", "error");

	const run = loadRun(runPath);
	const targetNodeId = nodeId ?? findFirstNodeByStatus(run, "waiting-approval");
	if (!targetNodeId) return ctx.ui.notify("No node waiting for approval.", "info");

	const state = run.nodes[targetNodeId];
	if (!state) return ctx.ui.notify(`Unknown run node: ${targetNodeId}`, "error");
	if (state.status !== "waiting-approval") return ctx.ui.notify(`Node ${targetNodeId} is ${state.status}, not waiting-approval.`, "warning");

	run.nodes[targetNodeId] = { ...state, status: "needs-revision", completedAt: new Date().toISOString() };
	run.status = "paused";
	saveRun(runPath, run);
	ctx.ui.notify(`Rejected node: ${targetNodeId}`, "info");
}

async function showWorkflowStatus(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	const { runPath } = resolveRunAndNodeArgs(ctx.cwd, args);
	if (!runPath) return ctx.ui.notify("No workflow run found.", "error");

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

async function abortWorkflowRun(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return ctx.ui.notify("workflow:abort requires interactive mode", "error");

	let runPath: string | null = null;
	const explicit = args?.trim();
	if (explicit) {
		runPath = resolveRunPath(ctx.cwd, explicit);
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

async function inspectWorkflowRun(args: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) return ctx.ui.notify("workflow:inspect requires interactive mode", "error");

	let runPath: string | null = null;
	const explicit = args?.trim();
	if (explicit) {
		runPath = resolveRunPath(ctx.cwd, explicit);
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

	const run = loadRun(runPath);
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		return new RunDetailComponent(tui, theme, ctx.cwd, runPath!, run, done);
	}, {
		overlay: true,
		overlayOptions: { anchor: "center", width: "88%", maxHeight: "88%", margin: 2 },
	});
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
	const specs = listSpecFiles(ctx.cwd);
	if (specs.length === 0) {
		ctx.ui.notify("No spec files found. Pass a spec path explicitly: /workflow:run <workflow> <spec>", "warning");
		return null;
	}

	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		return new SpecListComponent(tui, theme, workflow, specs, done);
	}, {
		overlay: true,
		overlayOptions: { anchor: "center", width: 88, maxHeight: "82%", margin: 2 },
	});
}
