import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { WorkflowDefinition, WorkflowNodeCompletionPolicy } from "./types";

export function listWorkflowNames(cwd: string): string[] {
	const dir = join(cwd, ".pi", "workflows");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".workflow.json"))
		.map((file) => file.slice(0, -".workflow.json".length))
		.sort();
}

export function getWorkflowPath(cwd: string, name: string): string {
	const base = name.endsWith(".workflow.json") ? name.slice(0, -".workflow.json".length) : name;
	if (!isSafeIdentifier(base)) throw new Error(`Invalid workflow name: ${name}`);
	return join(resolve(cwd, ".pi", "workflows"), `${base}.workflow.json`);
}

export function resolveWorkflowFilePath(cwd: string, file: string): string {
	const root = resolve(cwd, ".pi", "workflows");
	const candidate = resolve(cwd, file);
	if (!isInside(root, candidate)) throw new Error(`Workflow file escapes .pi/workflows: ${file}`);
	return candidate;
}

export function isSafeIdentifier(value: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(value);
}

export function validateArtifactPaths(label: string, values: string[]): void {
	for (const value of values) {
		if (value.length === 0 || isAbsolute(value) || value.split(/[\\/]+/).includes("..")) {
			throw new Error(`Unsafe ${label} path: ${value || "(empty)"}`);
		}
	}
}

export function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function loadWorkflow(path: string): WorkflowDefinition {
	const raw = readFileSync(path, "utf-8");
	const parsed = JSON.parse(raw) as WorkflowDefinition;
	if (!Array.isArray(parsed.nodes)) throw new Error("workflow.nodes must be an array");
	if (!Array.isArray(parsed.edges)) throw new Error("workflow.edges must be an array");
	validateWorkflowShape(parsed);
	return normalizeWorkflow(parsed);
}

export function validateWorkflowShape(workflow: WorkflowDefinition): void {
	const ids = new Set<string>();
	for (const node of workflow.nodes) {
		if (!isSafeIdentifier(node.id)) throw new Error(`Invalid node id: ${node.id}`);
		if (ids.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
		ids.add(node.id);
		validateArtifactPaths(`node ${node.id} output`, node.outputs ?? []);
		if (node.verification?.output?.path) validateArtifactPaths(`node ${node.id} verification output`, [node.verification.output.path]);
		const protocol = node.executor?.protocol;
		if (protocol?.sharedArtifactsDir) validateArtifactPaths(`node ${node.id} shared artifacts directory`, [protocol.sharedArtifactsDir]);
		const dynamic = node.executor?.dynamic;
		const dynamicEnabled = dynamic?.enabled === true || protocol?.mode === "dynamic-managed-routing";
		if (dynamicEnabled) {
			const agents = node.executor?.agents ?? [];
			const manager = dynamic?.manager ?? node.executor?.coordinator;
			if (!manager) throw new Error(`node ${node.id} dynamic executor requires a manager or coordinator`);
			if (!agents.some((agent) => agent.id === manager)) throw new Error(`node ${node.id} dynamic manager is not declared in agents: ${manager}`);
			if (dynamic?.decisionOutput) validateArtifactPaths(`node ${node.id} dynamic decision output`, [dynamic.decisionOutput]);
			if (dynamic?.finalOutputs) validateArtifactPaths(`node ${node.id} dynamic final output`, dynamic.finalOutputs);
			if (dynamic?.maxTurns !== undefined && (!Number.isFinite(dynamic.maxTurns) || dynamic.maxTurns < 1 || dynamic.maxTurns > 50)) {
				throw new Error(`node ${node.id} dynamic maxTurns must be between 1 and 50`);
			}
		}
		for (const phase of node.executor?.phases ?? []) validateArtifactPaths(`node ${node.id} phase ${phase.id} output`, phase.outputs ?? []);
	}
	for (const edge of workflow.edges) {
		if (!ids.has(edge.from)) throw new Error(`Unknown edge source: ${edge.from}`);
		if (!ids.has(edge.to)) throw new Error(`Unknown edge target: ${edge.to}`);
	}
}

export function normalizeWorkflow(workflow: WorkflowDefinition): WorkflowDefinition {
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
		node.executor ??= { kind: "agent", prompt: node.prompt ?? node.additionalPrompt ?? node.description ?? node.goal };
		node.executor.kind ??= "agent";
		node.prompt ??= node.executor.prompt ?? node.additionalPrompt ?? node.description ?? node.goal;
		node.executor.prompt ??= node.prompt;
		node.references ??= [];
		node.outputs ??= ["result.json", "report.md"];
		node.completionPolicy ??= defaultCompletionPolicy(node.type);
		node.verification ??= { enabled: node.completionPolicy.semanticVerification ?? false, mode: "semantic", criteria: [] };
	}
	return workflow;
}

export function defaultCompletionPolicy(type: string | undefined): WorkflowNodeCompletionPolicy {
	if (["review", "analysis", "synthesis"].includes(type ?? "")) {
		return {
			artifactCheck: true,
			semanticVerification: true,
			needsRevisionBlocks: false,
			findingsAreSuccess: true,
			failedBlocks: true,
		};
	}
	return {
		artifactCheck: true,
		semanticVerification: true,
		needsRevisionBlocks: true,
		findingsAreSuccess: false,
		failedBlocks: true,
	};
}

export function saveWorkflow(path: string, workflow: WorkflowDefinition): void {
	writeFileSync(path, `${JSON.stringify(workflow, null, "\t")}\n`, "utf-8");
}

export function ensureSampleWorkflow(path: string, name: string): void {
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
