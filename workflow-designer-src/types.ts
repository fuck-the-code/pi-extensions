export interface WorkflowNodeLayout {
	x?: number;
	y?: number;
	width?: number;
}

export interface WorkflowNode {
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

export interface WorkflowInputValidation {
	requiredSections?: string[];
	forbiddenPlaceholders?: string[];
}

export interface WorkflowInputDefinition {
	type: "file";
	required?: boolean;
	template?: string;
	validation?: WorkflowInputValidation;
}

export type WorkflowInputs = Record<string, WorkflowInputDefinition>;

export interface WorkflowEdge {
	from: string;
	to: string;
}

export interface WorkflowDefinition {
	version: number;
	name: string;
	description?: string;
	inputs?: WorkflowInputs;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
}

export type DesignerResult =
	| { action: "close" }
	| { action: "edit"; nodeId: string }
	| { action: "reload"; selectedId?: string };

export type EditResult = { action: "save"; node: WorkflowNode } | { action: "cancel" };

export const DEFAULT_WORKFLOW_NAME = "demo";

export type RunNodeStatus = "blocked" | "ready" | "running" | "waiting-approval" | "completed" | "failed" | "needs-revision" | "skipped";

export interface WorkflowRunNodeState {
	status: RunNodeStatus;
	blockedBy?: string[];
	startedAt?: string | null;
	completedAt?: string | null;
	result?: string | null;
	outputs?: string[];
	summary?: string;
}

export interface WorkflowRun {
	runId: string;
	workflow: string;
	workflowFile: string;
	status: "created" | "running" | "paused" | "completed" | "failed" | "aborted";
	createdAt: string;
	inputs: Record<string, string>;
	originalInputs: Record<string, string>;
	nodes: Record<string, WorkflowRunNodeState>;
}
