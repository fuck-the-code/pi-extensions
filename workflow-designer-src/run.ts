import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { RunNodeStatus, WorkflowDefinition, WorkflowNode, WorkflowRun } from "./types";

const MAX_EVENT_LOG_BYTES = 2_000_000;
const MAX_TRANSCRIPT_BLOCK_CHARS = 12_000;

export function buildNodePrompt(cwd: string, workflow: WorkflowDefinition, run: WorkflowRun, node: WorkflowNode, runDir: string, nodeDir: string): string {
	const resolvedInputs = resolveNodeInputs(cwd, node, run, runDir);
	const requiredOutputs = validateDeclaredArtifactPaths(nodeDir, "node output", node.outputs ?? ["result.json", "report.md"]);
	const policy = node.completionPolicy ?? {};
	const criteria = node.verification?.criteria ?? [];
	return `# Workflow Node Execution\n\nYou are executing one node in a goal-driven workflow.\n\n## Workflow\n\nName: ${workflow.name}\nRun ID: ${run.runId}\n\n## Initial Spec\n\nPath: ${run.inputs.spec}\n\nThe initial spec is the source of truth for this workflow run.\n\n## Current Node\n\nID: ${node.id}\nTitle: ${node.title ?? node.id}\nType: ${node.type ?? "node"}\nExecutor: ${node.executor?.kind ?? "agent"}\n\n## Node Goal\n\n${node.goal ?? node.description ?? "Complete this node."}\n\n## Node Prompt\n\n${node.executor?.prompt ?? node.prompt ?? node.additionalPrompt ?? node.description ?? node.goal ?? "Complete this node."}\n\n## Completion Policy\n\n- artifactCheck: ${policy.artifactCheck ?? true}\n- semanticVerification: ${policy.semanticVerification ?? false}\n- needsRevisionBlocks: ${policy.needsRevisionBlocks ?? true}\n- findingsAreSuccess: ${policy.findingsAreSuccess ?? false}\n- failedBlocks: ${policy.failedBlocks ?? true}\n\n## Verification Criteria\n\n${criteria.map((criterion) => `- ${criterion}`).join("\n") || "- (none)"}\n\n## References\n\n${(node.references ?? []).map((ref) => `- ${ref}`).join("\n") || "- (none)"}\n\n## Inputs\n\n${resolvedInputs.map((input) => `- ${input}`).join("\n") || "- (none)"}\n\n## Required Output Directory\n\nWrite all node outputs under:\n\n${relative(cwd, nodeDir)}\n\n## Required Outputs\n\n${requiredOutputs.map((output) => `- ${relative(cwd, output.absolutePath)}`).join("\n")}\n\n## Result Contract\n\nYou must write result.json exactly in this shape:\n\n\`\`\`json\n{\n  "status": "passed | completed | failed | needs-revision",\n  "summary": "short summary",\n  "issues": [\n    { "severity": "critical | major | minor", "message": "issue description" }\n  ],\n  "outputs": ["report.md"]\n}\n\`\`\`\n\n## Completion Rules\n\nThe node is not complete until:\n\n1. result.json exists in the node output directory.\n2. result.json.status is one of passed, completed, failed, needs-revision.\n3. All required outputs exist and are non-empty.\n4. The node goal has been addressed.\n\n## Important Rules\n\n- Do not modify workflow topology or run.json.\n- Prefer writing only inside this node output directory unless implementation work explicitly requires code changes.\n- Upstream outputs are available through the input paths listed above.\n- For review/audit/analysis/synthesis nodes where findingsAreSuccess is true, discovered issues are successful findings. Use completed unless the node itself could not perform its review.\n`;
}

export function resolveNodeInputs(cwd: string, node: WorkflowNode, run: WorkflowRun, runDir: string): string[] {
	return (node.inputs ?? []).map((input) => {
		let value = input;
		value = value.replace(/\{\{inputs\.spec\}\}/g, run.inputs.spec);
		value = value.replace(/\{\{nodes\.([^.}]+)\.outputs\.report\}\}/g, (_match, nodeId: string) => {
			return relative(cwd, join(runDir, "nodes", nodeId, "report.md"));
		});
		return value;
	});
}

export async function runPiPrint(
	cwd: string,
	prompt: string,
	signal?: AbortSignal,
	artifacts?: { eventLogPath?: string; transcriptPath?: string },
): Promise<{ exitCode: number; output: string }> {
	return await new Promise((resolve) => {
		const child = spawn("pi", ["--mode", "json", "-p", prompt], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let stderr = "";
		let buffer = "";
		let settled = false;
		const transcript: string[] = [];

		if (artifacts?.eventLogPath) writeFileSync(artifacts.eventLogPath, "", "utf-8");
		if (artifacts?.transcriptPath) writeFileSync(artifacts.transcriptPath, "", "utf-8");

		const addTranscript = (title: string, text: string) => {
			if (!text.trim()) return;
			const safeText = redactSensitiveText(text).slice(0, MAX_TRANSCRIPT_BLOCK_CHARS);
			const suffix = text.length > MAX_TRANSCRIPT_BLOCK_CHARS ? "\n\n...[truncated]" : "";
			const block = `## ${title}\n\n${safeText}${suffix}\n\n`;
			transcript.push(block);
			// Stream transcript blocks as they are observed so /workflow:inspect can
			// show progress while the sub-agent is still running.
			if (artifacts?.transcriptPath) appendFileSync(artifacts.transcriptPath, block, "utf-8");
		};

		const textFromContent = (content: unknown): string => {
			if (!Array.isArray(content)) return "";
			return content
				.map((part: any) => {
					if (part?.type === "text" && typeof part.text === "string") return part.text;
					if (typeof part?.text === "string") return part.text;
					return "";
				})
				.filter(Boolean)
				.join("\n");
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			if (artifacts?.eventLogPath && shouldAppendEventLog(artifacts.eventLogPath)) appendFileSync(artifacts.eventLogPath, `${redactSensitiveText(line)}\n`, "utf-8");
			let event: any;
			try { event = JSON.parse(line); } catch { return; }

			if (event.type === "message_end" && event.message) {
				const msg = event.message;
				if (msg.role === "user") addTranscript("user", textFromContent(msg.content));
				else if (msg.role === "assistant") addTranscript("assistant", textFromContent(msg.content));
				else if (msg.role === "toolResult") addTranscript("tool result", textFromContent(msg.content));
			}
			if (event.type === "tool_execution_start") {
				addTranscript(`tool: ${event.toolName ?? "unknown"}`, `args:\n\`\`\`json\n${JSON.stringify(event.args ?? {}, null, 2)}\n\`\`\``);
			}
			if (event.type === "tool_execution_end") {
				const text = typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? {}, null, 2);
				addTranscript(`tool done: ${event.toolName ?? "unknown"}`, text.slice(0, 4000));
			}
		};

		const finish = (exitCode: number, extra = "") => {
			if (settled) return;
			settled = true;
			if (buffer.trim()) processLine(buffer);
			if (extra) stderr += extra;
			output = transcript.join("\n") || stderr;
			if (stderr.trim()) output += `\n\n## stderr\n\n${redactSensitiveText(stderr.trim())}\n`;
			// If no transcript blocks were streamed, still write stderr/fallback output.
			if (artifacts?.transcriptPath && transcript.length === 0) writeFileSync(artifacts.transcriptPath, output, "utf-8");
			if (signal) signal.removeEventListener("abort", abort);
			resolve({ exitCode, output });
		};
		const abort = () => {
			try { child.kill("SIGTERM"); } catch {}
		};
		if (signal?.aborted) abort();
		signal?.addEventListener("abort", abort, { once: true });
		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});
		child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
		child.on("close", (code) => finish(signal?.aborted ? 130 : (code ?? 1)));
		child.on("error", (err) => finish(1, String(err)));
	});
}

export function shouldAppendEventLog(path: string): boolean {
	try {
		return !existsSync(path) || statSync(path).size < MAX_EVENT_LOG_BYTES;
	} catch {
		return true;
	}
}

export function redactSensitiveText(value: string): string {
	return value
		.replace(/([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|KEY|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*)[^\s"'`,}]+/gi, "$1[REDACTED]")
		.replace(/(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
		.replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, "$1[REDACTED]")
		.replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)["']?\s*[:=]\s*["'])[^"']+(["'])/gi, "$1[REDACTED]$2");
}

export function checkNodeCompletion(
	node: WorkflowNode,
	nodeDir: string,
	options: { treatNeedsRevisionAsCompleted?: boolean } = {},
): { status: RunNodeStatus; outputs: string[]; summary: string } {
	const requiredOutputs = node.outputs ?? ["result.json", "report.md"];
	const resultPath = join(nodeDir, "result.json");
	if (!existsSync(resultPath)) return { status: "failed", outputs: [], summary: "Missing result.json" };

	let parsed: { status?: string; summary?: string; outputs?: string[] };
	try {
		parsed = JSON.parse(readFileSync(resultPath, "utf-8"));
	} catch (err) {
		return { status: "failed", outputs: [], summary: `Invalid result.json: ${err instanceof Error ? err.message : String(err)}` };
	}

	const allowedStatuses = new Set(["passed", "completed", "failed", "needs-revision"]);
	if (!allowedStatuses.has(parsed.status ?? "")) {
		return { status: "failed", outputs: [], summary: `Invalid result status: ${parsed.status ?? "(missing)"}` };
	}
	if (parsed.outputs !== undefined && (!Array.isArray(parsed.outputs) || parsed.outputs.some((output) => typeof output !== "string"))) {
		return { status: "failed", outputs: [], summary: "result.json outputs must be an array of strings" };
	}

	const declaredOutputs = Array.from(new Set([...(parsed.outputs ?? []), ...requiredOutputs]));
	for (const output of declaredOutputs) {
		try {
			requireNonEmptyDeclaredArtifact(nodeDir, "output", output);
		} catch (err) {
			return { status: "failed", outputs: declaredOutputs, summary: err instanceof Error ? err.message : String(err) };
		}
	}

	// Default workflow mode is auto-advance: successful nodes complete immediately.
	// Approval gates can be reintroduced later as an explicit opt-in mode, but they
	// should not block the normal workflow execution path.
	let status: RunNodeStatus;
	if (parsed.status === "failed") status = "failed";
	else if (parsed.status === "needs-revision" && !options.treatNeedsRevisionAsCompleted) status = "needs-revision";
	else status = "completed";

	let summary = parsed.summary ?? "";
	if (parsed.status === "needs-revision" && options.treatNeedsRevisionAsCompleted) {
		summary = summary ? `Reported needs-revision; treated as completed for review aggregation. ${summary}` : "Reported needs-revision; treated as completed for review aggregation.";
	}
	return { status, outputs: declaredOutputs, summary };
}

export function isSafeRelativePath(value: string): boolean {
	return value.length > 0 && !isAbsolute(value) && !value.split(/[\\/]+/).includes("..");
}

export type DeclaredArtifactPath = { relativePath: string; absolutePath: string };

export function validateDeclaredArtifactPath(baseDir: string, label: string, value: string): DeclaredArtifactPath {
	if (!isSafeRelativePath(value)) throw new Error(`Unsafe ${label} path: ${value || "(empty)"}`);
	const root = resolve(baseDir);
	const absolutePath = resolve(root, value);
	if (!isInside(root, absolutePath)) throw new Error(`${label} path escapes node directory: ${value}`);
	return { relativePath: value, absolutePath };
}

export function validateDeclaredArtifactPaths(baseDir: string, label: string, values: string[]): DeclaredArtifactPath[] {
	return values.map((value) => validateDeclaredArtifactPath(baseDir, label, value));
}

export function requireNonEmptyDeclaredArtifact(baseDir: string, label: string, value: string): DeclaredArtifactPath {
	const artifact = validateDeclaredArtifactPath(baseDir, label, value);
	if (!existsSync(artifact.absolutePath)) throw new Error(`Missing ${label}: ${value}`);
	const stat = statSync(artifact.absolutePath);
	if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${value}`);
	if (stat.size === 0) throw new Error(`Empty ${label}: ${value}`);
	return artifact;
}

export type NodeVerificationResult = {
	passed: boolean;
	confidence: "low" | "medium" | "high" | string;
	reason: string;
	missing: string[];
	risks: string[];
};

export async function verifyNodeGoal(
	cwd: string,
	workflow: WorkflowDefinition,
	run: WorkflowRun,
	node: WorkflowNode,
	runDir: string,
	nodeDir: string,
	signal?: AbortSignal,
): Promise<NodeVerificationResult> {
	const verificationArtifact = validateDeclaredArtifactPath(nodeDir, "verification output", node.verification?.output?.path ?? "verification.json");
	const verificationPath = verificationArtifact.absolutePath;
	const promptPath = join(nodeDir, "verifier-prompt.md");
	const outputPath = join(nodeDir, "verifier-output.md");
	const eventsPath = join(nodeDir, "verifier-events.jsonl");
	const resultPath = join(nodeDir, "result.json");
	const reportPath = join(nodeDir, "report.md");
	const resolvedInputs = resolveNodeInputs(cwd, node, run, runDir);
	const readShort = (path: string, max = 12000) => {
		try {
			const abs = isAbsolute(path) ? path : join(cwd, path);
			if (!existsSync(abs) || !statSync(abs).isFile()) return `(missing: ${path})`;
			const content = readFileSync(abs, "utf-8");
			return content.length > max ? `${content.slice(0, max)}\n\n...[truncated]` : content;
		} catch (err) {
			return `(unreadable: ${path}: ${err instanceof Error ? err.message : String(err)})`;
		}
	};
	const prompt = `# Workflow Node Goal Verification\n\nYou are verifying whether a workflow node completed its assigned goal.\n\nDo not judge whether reviewed code is defect-free. Judge whether this node's output satisfies this node's goal and verification criteria.\n\n## Workflow\n\nName: ${workflow.name}\nRun ID: ${run.runId}\n\n## Node\n\nID: ${node.id}\nTitle: ${node.title ?? node.id}\nType: ${node.type ?? "node"}\n\n## Node Goal\n\n${node.goal ?? node.description ?? "Complete this node."}\n\n## Node Prompt\n\n${node.executor?.prompt ?? node.prompt ?? node.additionalPrompt ?? node.description ?? node.goal ?? "Complete this node."}\n\n## Completion Policy\n\n- findingsAreSuccess: ${node.completionPolicy?.findingsAreSuccess ?? false}\n- needsRevisionBlocks: ${node.completionPolicy?.needsRevisionBlocks ?? true}\n\n## Verification Rules\n\n- Verify whether the node performed the requested work.\n- For review/audit nodes with findingsAreSuccess=true, finding blockers or defects is success if the findings are concrete and actionable.\n- Fail verification only if the node output does not adequately address the node goal/criteria, lacks evidence, omits required dimensions, or is too generic.\n\n## Verification Criteria\n\n${(node.verification?.criteria ?? []).map((criterion) => `- ${criterion}`).join("\n") || "- The report addresses the node goal with concrete evidence or explicitly states no findings."}\n\n## Initial Spec\n\nPath: ${run.inputs.spec}\n\n\`\`\`md\n${readShort(run.inputs.spec)}\n\`\`\`\n\n## Inputs\n\n${resolvedInputs.map((input) => `### ${input}\n\n\`\`\`\n${readShort(input, 8000)}\n\`\`\``).join("\n\n") || "- (none)"}\n\n## Node result.json\n\n\`\`\`json\n${readShort(resultPath, 6000)}\n\`\`\`\n\n## Node report.md\n\n\`\`\`md\n${readShort(reportPath, 16000)}\n\`\`\`\n\n## Required Output\n\nWrite ${relative(cwd, verificationPath)} exactly as JSON:\n\n\`\`\`json\n{\n  "passed": true,\n  "confidence": "low | medium | high",\n  "reason": "short reason",\n  "missing": ["missing coverage or evidence"],\n  "risks": ["remaining risk"]\n}\n\`\`\`\n`;
	writeFileSync(promptPath, prompt, "utf-8");
	const result = await runPiPrint(cwd, prompt, signal, { eventLogPath: eventsPath, transcriptPath: outputPath });
	if (result.exitCode !== 0 || signal?.aborted) {
		return { passed: false, confidence: "low", reason: signal?.aborted ? "Verification aborted" : `Verifier failed with exit code ${result.exitCode}`, missing: [], risks: [] };
	}
	try {
		const parsed = JSON.parse(readFileSync(verificationPath, "utf-8"));
		return {
			passed: Boolean(parsed.passed),
			confidence: typeof parsed.confidence === "string" ? parsed.confidence : "medium",
			reason: typeof parsed.reason === "string" ? parsed.reason : "",
			missing: Array.isArray(parsed.missing) ? parsed.missing.map(String) : [],
			risks: Array.isArray(parsed.risks) ? parsed.risks.map(String) : [],
		};
	} catch (err) {
		return { passed: false, confidence: "low", reason: `Missing or invalid verification.json: ${err instanceof Error ? err.message : String(err)}`, missing: ["verification.json"], risks: [] };
	}
}

export function loadRun(path: string): WorkflowRun {
	return JSON.parse(readFileSync(path, "utf-8")) as WorkflowRun;
}

export function saveRun(path: string, run: WorkflowRun): void {
	writeFileSync(path, `${JSON.stringify(run, null, "\t")}\n`, "utf-8");
}

export function resolveRunPath(cwd: string, value: string): string {
	const root = resolve(cwd, ".workflow", "runs");
	let candidate: string;
	if (isAbsolute(value)) candidate = resolve(value);
	else if (value.endsWith("run.json")) candidate = resolve(cwd, value);
	else {
		if (!isSafeRunId(value)) throw new Error(`Invalid run id: ${value}`);
		candidate = resolve(root, value, "run.json");
	}
	if (!isInside(root, candidate)) throw new Error(`Run path escapes .workflow/runs: ${value}`);
	return candidate;
}

export function isSafeRunId(value: string): boolean {
	return /^[A-Za-z0-9_.-]+$/.test(value) && !value.includes("..");
}

export function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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
	if (run.status === "aborted") return;
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

