import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, join, relative } from "node:path";
import type { RunNodeStatus, WorkflowDefinition, WorkflowNode, WorkflowRun } from "./types";

export function buildNodePrompt(workflow: WorkflowDefinition, run: WorkflowRun, node: WorkflowNode, runDir: string, nodeDir: string): string {
	const resolvedInputs = resolveNodeInputs(node, run, runDir);
	return `# Workflow Node Execution\n\nYou are executing one node in a goal-driven workflow.\n\n## Workflow\n\nName: ${workflow.name}\nRun ID: ${run.runId}\n\n## Initial Spec\n\nPath: ${run.inputs.spec}\n\nThe initial spec is the source of truth for this workflow run.\n\n## Current Node\n\nID: ${node.id}\nTitle: ${node.title ?? node.id}\nType: ${node.type ?? "node"}\n\n## Node Goal\n\n${node.goal ?? node.description ?? "Complete this node."}\n\n## Node Prompt\n\n${node.prompt ?? node.additionalPrompt ?? node.description ?? node.goal ?? "Complete this node."}\n\n## References\n\n${(node.references ?? []).map((ref) => `- ${ref}`).join("\n") || "- (none)"}\n\n## Inputs\n\n${resolvedInputs.map((input) => `- ${input}`).join("\n") || "- (none)"}\n\n## Required Output Directory\n\nWrite all node outputs under:\n\n${relative(process.cwd(), nodeDir)}\n\n## Required Outputs\n\n${(node.outputs ?? ["result.json", "report.md"]).map((output) => `- ${relative(process.cwd(), join(nodeDir, output))}`).join("\n")}\n\n## Result Contract\n\nYou must write result.json exactly in this shape:\n\n\`\`\`json\n{\n  "status": "passed | completed | failed | needs-revision",\n  "summary": "short summary",\n  "issues": [\n    { "severity": "critical | major | minor", "message": "issue description" }\n  ],\n  "outputs": ["report.md"]\n}\n\`\`\`\n\n## Completion Rules\n\nThe node is not complete until:\n\n1. result.json exists in the node output directory.\n2. result.json.status is one of passed, completed, failed, needs-revision.\n3. All required outputs exist and are non-empty.\n4. The node goal has been addressed.\n\n## Important Rules\n\n- Do not modify workflow topology or run.json.\n- Prefer writing only inside this node output directory unless implementation work explicitly requires code changes.\n- Upstream outputs are available through the input paths listed above.\n`;
}

export function resolveNodeInputs(node: WorkflowNode, run: WorkflowRun, runDir: string): string[] {
	return (node.inputs ?? []).map((input) => {
		let value = input;
		value = value.replace(/\{\{inputs\.spec\}\}/g, run.inputs.spec);
		value = value.replace(/\{\{nodes\.([^.}]+)\.outputs\.report\}\}/g, (_match, nodeId: string) => {
			return relative(process.cwd(), join(runDir, "nodes", nodeId, "report.md"));
		});
		return value;
	});
}

export async function runPiPrint(cwd: string, prompt: string): Promise<{ exitCode: number; output: string }> {
	return await new Promise((resolve) => {
		const child = spawn("pi", ["-p", prompt], { cwd, env: process.env });
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk.toString(); });
		child.stderr.on("data", (chunk) => { output += chunk.toString(); });
		child.on("close", (code) => resolve({ exitCode: code ?? 1, output }));
		child.on("error", (err) => resolve({ exitCode: 1, output: String(err) }));
	});
}

export function checkNodeCompletion(node: WorkflowNode, nodeDir: string): { status: RunNodeStatus; outputs: string[]; summary: string } {
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

export function loadRun(path: string): WorkflowRun {
	return JSON.parse(readFileSync(path, "utf-8")) as WorkflowRun;
}

export function saveRun(path: string, run: WorkflowRun): void {
	writeFileSync(path, `${JSON.stringify(run, null, "\t")}\n`, "utf-8");
}

export function resolveRunPath(cwd: string, value: string): string {
	if (isAbsolute(value)) return value;
	if (value.endsWith("run.json")) return join(cwd, value);
	return join(cwd, ".workflow", "runs", value, "run.json");
}

export function pickLatestRunPath(cwd: string): string | null {
	const runs = listRuns(cwd);
	return runs[0]?.path ?? null;
}

export function listRuns(cwd: string): Array<{ path: string; run: WorkflowRun; mtimeMs: number }> {
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

export function refreshReadyStates(run: WorkflowRun, workflow: WorkflowDefinition): void {
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

export function updateRunAggregateStatus(run: WorkflowRun): void {
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

export function findFirstNodeByStatus(run: WorkflowRun, status: RunNodeStatus): string | undefined {
	return Object.entries(run.nodes).find(([, state]) => state.status === status)?.[0];
}

export function resolveRunAndNodeArgs(cwd: string, args: string | undefined): { runPath: string | null; nodeId?: string } {
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

