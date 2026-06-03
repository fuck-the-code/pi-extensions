import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DesignerResult, EditResult, WorkflowDefinition, WorkflowRun } from "./types";
import {
	buildNodePrompt,
	checkNodeCompletion,
	listRuns,
	loadRun,
	refreshReadyStates,
	resolveRunPath,
	runPiPrint,
	saveRun,
	updateRunAggregateStatus,
	verifyNodeGoal,
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
	resolveWorkflowFilePath,
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
			// Not a run id/path; treat it as a workflow name below.
		}
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

	const validation = validateSpec(absSpecPath, workflow.inputs?.spec?.validation);
	if (validation.errors.length > 0) {
		ctx.ui.notify(`Spec validation failed: ${validation.errors.join("; ")}`, "error");
		return;
	}

	ensureWorkflowGitignore(ctx.cwd);
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

	const runPath = join(runDir, "run.json");
	writeFileSync(runPath, `${JSON.stringify(run, null, "\t")}\n`, "utf-8");
	ctx.ui.notify(`Created workflow run: ${relative(ctx.cwd, runPath)}. Starting auto-run...`, "info");
	await startWorkflowRun(runPath, ctx);
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
	const prompt = buildNodePrompt(ctx.cwd, workflow, run, node, runDir, nodeDir);
	writeFileSync(join(nodeDir, "prompt.md"), prompt, "utf-8");

	await updateRunSerialized(runPath, (latest) => {
		latest.nodes[node.id] = { ...latest.nodes[node.id], status: "running", startedAt: new Date().toISOString() };
		latest.status = "running";
	});

	const result = await runPiPrint(ctx.cwd, prompt, signal, {
		eventLogPath: join(nodeDir, "events.jsonl"),
		transcriptPath: join(nodeDir, "agent-output.md"),
	});
	writeFileSync(join(nodeDir, "agent-output.md"), result.output, "utf-8");

	run = loadRun(runPath);
	const wasAborted = signal?.aborted || run.status === "aborted";
	if (result.exitCode !== 0 || wasAborted) {
		await updateRunSerialized(runPath, (latest) => {
			latest.nodes[node.id] = {
				...latest.nodes[node.id],
				status: "failed",
				completedAt: new Date().toISOString(),
				summary: signal?.aborted ? "aborted manually" : `Agent process failed with exit code ${result.exitCode}`,
			};
			latest.status = wasAborted ? "aborted" : "paused";
		});
		return;
	}

	const completion = checkNodeCompletion(node, nodeDir, { treatNeedsRevisionAsCompleted: node.completionPolicy?.needsRevisionBlocks === false || node.completionPolicy?.findingsAreSuccess === true });
	let finalStatus = completion.status;
	let finalSummary = completion.summary;
	if (completion.status === "completed" && node.completionPolicy?.semanticVerification !== false && node.verification?.enabled !== false) {
		const verification = await verifyNodeGoal(ctx.cwd, workflow, run, node, runDir, nodeDir, signal);
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
		};
		if (finalStatus === "failed" || finalStatus === "needs-revision") latest.status = "paused";
	});
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

	const run = reconcileRunFromArtifacts(runPath, ctx.cwd);
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
			run.nodes[nodeId] = blockers.length > 0 ? { status: "blocked", blockedBy: blockers } : { status: "ready", blockedBy: [] };
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

function reconcileRunFromArtifacts(runPath: string, cwd: string, onlyNodeId?: string): WorkflowRun {
	const run = loadRun(runPath);
	if (run.status === "aborted") return run;
	const workflow = loadWorkflow(resolveWorkflowFilePath(cwd, run.workflowFile));
	const runDir = dirname(runPath);
	const nodes = onlyNodeId ? workflow.nodes.filter((node) => node.id === onlyNodeId) : workflow.nodes;

	for (const node of nodes) {
		const nodeDir = join(runDir, "nodes", node.id);
		if (!existsSync(join(nodeDir, "result.json"))) continue;
		const state = run.nodes[node.id];
		if (!state) continue;
		const canRepairNeedsRevision = workflow.name === "code-review" && state.status === "needs-revision";
		if (["completed", "failed", "skipped"].includes(state.status) || (state.status === "needs-revision" && !canRepairNeedsRevision)) continue;
		const completion = checkNodeCompletion(node, nodeDir, { treatNeedsRevisionAsCompleted: node.completionPolicy?.needsRevisionBlocks === false || node.completionPolicy?.findingsAreSuccess === true });
		run.nodes[node.id] = {
			...state,
			status: completion.status,
			completedAt: new Date().toISOString(),
			result: relative(runDir, join(nodeDir, "result.json")),
			outputs: completion.outputs.map((output) => relative(runDir, join(nodeDir, output))),
			summary: completion.summary,
		};
	}

	refreshReadyStates(run, workflow);
	updateRunAggregateStatus(run);
	saveRun(runPath, run);
	return run;
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
