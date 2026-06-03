import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowDefinition } from "./types";

export function listWorkflowNames(cwd: string): string[] {
	const dir = join(cwd, ".pi", "workflows");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".workflow.json"))
		.map((file) => file.slice(0, -".workflow.json".length))
		.sort();
}

export function getWorkflowPath(cwd: string, name: string): string {
	const file = name.endsWith(".workflow.json") ? name : `${name}.workflow.json`;
	return join(cwd, ".pi", "workflows", file);
}

export function loadWorkflow(path: string): WorkflowDefinition {
	const raw = readFileSync(path, "utf-8");
	const parsed = JSON.parse(raw) as WorkflowDefinition;
	if (!Array.isArray(parsed.nodes)) throw new Error("workflow.nodes must be an array");
	if (!Array.isArray(parsed.edges)) throw new Error("workflow.edges must be an array");
	return normalizeWorkflow(parsed);
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
		node.prompt ??= node.additionalPrompt ?? node.description ?? node.goal;
		node.references ??= [];
		node.outputs ??= ["result.json", "report.md"];
	}
	return workflow;
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
