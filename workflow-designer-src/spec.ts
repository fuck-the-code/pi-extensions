import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { WorkflowDefinition, WorkflowInputValidation, WorkflowRunNodeState } from "./types";

export function listSpecFiles(cwd: string): string[] {
	const roots = ["specs", ".workflow/specs", ".pi/specs", "docs", "requirements"];
	const results: string[] = [];
	for (const root of roots) {
		const abs = join(cwd, root);
		if (existsSync(abs)) collectSpecFiles(cwd, abs, results, 0);
	}
	return Array.from(new Set(results)).sort();
}

export function collectSpecFiles(cwd: string, dir: string, results: string[], depth: number): void {
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

export function createInitialNodeStates(workflow: WorkflowDefinition): Record<string, WorkflowRunNodeState> {
	const states: Record<string, WorkflowRunNodeState> = {};
	for (const node of workflow.nodes) {
		const blockers = workflow.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from);
		states[node.id] = blockers.length > 0 ? { status: "blocked", blockedBy: blockers } : { status: "ready", blockedBy: [] };
	}
	return states;
}

export function readWorkflowNameFromSpec(path: string): string | null {
	const content = readFileSync(path, "utf-8");
	return content.match(/^workflow:\s*([A-Za-z0-9_-]+)\s*$/m)?.[1]
		?? content.match(/^>\s*Workflow:\s*([A-Za-z0-9_-]+)\s*$/m)?.[1]
		?? null;
}

export function validateSpec(path: string, validation: WorkflowInputValidation | undefined): { errors: string[] } {
	const errors: string[] = [];
	const content = readFileSync(path, "utf-8");
	for (const section of validation?.requiredSections ?? []) {
		const pattern = new RegExp(`(^|\\n)#{1,6}\\s+${escapeRegExp(section)}\\b`, "i");
		if (!pattern.test(content)) errors.push(`missing section: ${section}`);
	}
	const contentForForbiddenCheck = content
		.split("\n")
		.filter((line) => !/^\s*>\s*Do not leave placeholders:/i.test(line))
		.join("\n");
	for (const placeholder of validation?.forbiddenPlaceholders ?? []) {
		if (contentForForbiddenCheck.includes(placeholder)) errors.push(`contains placeholder: ${placeholder}`);
	}
	return { errors };
}

export function makeRunId(workflowName: string, specPath: string): string {
	const now = new Date();
	const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${String(now.getMilliseconds()).padStart(3, "0")}`;
	const specName = basename(specPath).replace(/\.[^.]+$/, "");
	const entropy = randomBytes(4).toString("hex");
	return `${slug(workflowName)}-${slug(specName)}-${stamp}-${entropy}`;
}

export function slug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "run";
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildSpecTemplateMarkdown(workflow: WorkflowDefinition): string {
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
		lines.push("> Fill every generated placeholder before running this workflow.");
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

export function sectionHint(section: string): string {
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

