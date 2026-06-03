export interface WorkflowNodeLayout {
	x?: number;
	y?: number;
	width?: number;
}

export interface WorkflowNodeExecutorAgent {
	id: string;
	role?: string;
	responsibilities?: string[];
	canDecideCompletion?: boolean;
}

export interface WorkflowNodeExecutorProtocol {
	mode?: "managed-routing" | string;
	broadcast?: boolean;
	sharedArtifactsDir?: string;
	rule?: string;
}

export interface WorkflowNodeExecutorPhase {
	id: string;
	agent: string;
	goal?: string;
	prompt?: string;
	triggeredBy?: string;
	inputs?: string[];
	outputs?: string[];
}

export interface WorkflowNodeExecutor {
	kind?: "agent" | "multi-agent" | "command" | "manual" | string;
	prompt?: string;
	command?: string;
	model?: string;
	timeoutSec?: number;
	tools?: string[];
	coordinator?: string;
	agents?: WorkflowNodeExecutorAgent[];
	protocol?: WorkflowNodeExecutorProtocol;
	phases?: WorkflowNodeExecutorPhase[];
}

export interface WorkflowNodeCompletionPolicy {
	artifactCheck?: boolean;
	semanticVerification?: boolean;
	needsRevisionBlocks?: boolean;
	findingsAreSuccess?: boolean;
	failedBlocks?: boolean;
}

export interface WorkflowNodeVerification {
	enabled?: boolean;
	mode?: "semantic" | string;
	criteria?: string[];
	goal?: string;
	output?: { path?: string };
}

export interface WorkflowNode {
	id: string;
	title?: string;
	type?: string;
	goal?: string;
	prompt?: string;
	executor?: WorkflowNodeExecutor;
	completionPolicy?: WorkflowNodeCompletionPolicy;
	verification?: WorkflowNodeVerification;
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
