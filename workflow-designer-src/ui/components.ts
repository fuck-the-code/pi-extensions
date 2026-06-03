import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { DesignerResult, EditResult, WorkflowDefinition, WorkflowNode, WorkflowNodeLayout, WorkflowRun, WorkflowRunNodeState } from "../types";
import { bottomBorder, clamp, isEnter, matchesKey, pad, padAnsi, padRight, sideLine, topBorder, truncateToWidth } from "./common";
import { centerLayout, computeLayout, computeRanks, createCanvas, drawEdges, drawNode } from "./graph";

export class RunListComponent {
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

export class RunDetailComponent {
	private selected = 0;
	private scroll = 0;
	private view: "details" | "conversation" = "details";
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	private message = "";

	constructor(
		private tui: TUI,
		private theme: Theme,
		private cwd: string,
		private runPath: string,
		private run: WorkflowRun,
		private done: () => void,
	) {
		this.refreshTimer = setInterval(() => this.tui.requestRender(), 1000);
	}

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
		else if (matchesKey(data, "v")) {
			this.view = this.view === "details" ? "conversation" : "details";
			this.scroll = 0;
		} else if (data === "Q" || data === "q") {
			this.openSelectedConversationFile();
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		try {
			this.run = JSON.parse(readFileSync(this.runPath, "utf-8")) as WorkflowRun;
		} catch {}
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

		const detailLines = selectedNodeId && selectedState ? this.nodeViewLines(selectedNodeId, selectedState, rightW) : ["No node selected"];
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
		const msg = this.message ? ` | ${this.message}` : "";
		lines.push(sideLine(pad(` up/down select node   |   left/right scroll   |   v view:${this.view}   |   Q open in VSCode   |   Esc close${msg}`, innerW), th));
		lines.push(bottomBorder(innerW, th));
		return lines.map((line) => truncateToWidth(line, outerW, "", true));
	}

	private openSelectedConversationFile(): void {
		const nodeId = Object.keys(this.run.nodes)[this.selected];
		if (!nodeId) return;
		const runDir = dirname(this.runPath);
		const transcriptPath = join(runDir, "nodes", nodeId, "agent-output.md");
		const eventsPath = join(runDir, "nodes", nodeId, "events.jsonl");
		const target = existsSync(transcriptPath) ? transcriptPath : existsSync(eventsPath) ? eventsPath : undefined;
		if (!target) {
			this.message = `no conversation file for ${nodeId}`;
			return;
		}
		try {
			const child = spawn("code", [target], { detached: true, stdio: "ignore" });
			child.unref();
			this.message = `opened ${relative(this.cwd, target)}`;
		} catch (err) {
			this.message = `failed to open code: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	private nodeViewLines(nodeId: string, state: WorkflowRunNodeState, width: number): string[] {
		if (this.view === "conversation") return this.nodeConversationLines(nodeId, width);
		return this.nodeDetailLines(nodeId, state, width);
	}

	private nodeConversationLines(nodeId: string, width: number): string[] {
		const runDir = dirname(this.runPath);
		const transcriptPath = join(runDir, "nodes", nodeId, "agent-output.md");
		const eventsPath = join(runDir, "nodes", nodeId, "events.jsonl");
		if (!existsSync(transcriptPath)) {
			return [
				`Conversation view for ${nodeId}`,
				"",
				"No transcript yet.",
				`Expected: ${relative(this.cwd, transcriptPath)}`,
				`Raw events: ${relative(this.cwd, eventsPath)}`,
			];
		}
		const content = readFileSync(transcriptPath, "utf-8");
		return [`Conversation view for ${nodeId}`, `Transcript: ${relative(this.cwd, transcriptPath)}`, "", ...content.split("\n")]
			.map((line) => truncateToWidth(line, width - 1, "..."));
	}

	private nodeDetailLines(nodeId: string, state: WorkflowRunNodeState, width: number): string[] {
		const runDir = dirname(this.runPath);
		const nodeDir = join(runDir, "nodes", nodeId);
		const resultPath = join(nodeDir, "result.json");
		const reportPath = join(nodeDir, "report.md");
		const promptPath = join(nodeDir, "prompt.md");
		const agentOutputPath = join(nodeDir, "agent-output.md");
		const verificationPath = join(nodeDir, "verification.json");
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
			`- ${relative(this.cwd, verificationPath)} ${existsSync(verificationPath) ? "(exists)" : ""}`,
			`- ${relative(this.cwd, resultPath)} ${existsSync(resultPath) ? "(exists)" : ""}`,
			`- ${relative(this.cwd, reportPath)} ${existsSync(reportPath) ? "(exists)" : ""}`,
			"",
			"Declared outputs:",
			...(state.outputs ?? []).map((output) => `- ${output}`),
		];
		if (existsSync(verificationPath)) {
			lines.push("", "verification.json:");
			try {
				const parsed = JSON.parse(readFileSync(verificationPath, "utf-8"));
				lines.push(...JSON.stringify(parsed, null, 2).split("\n"));
			} catch {
				lines.push(...readFileSync(verificationPath, "utf-8").split("\n"));
			}
		}
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

	dispose(): void {
		if (this.refreshTimer) clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
	}
}

export class SpecTemplatePreviewComponent {
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

export class SpecListComponent {
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

export class WorkflowListComponent {
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

export class WorkflowDesignerComponent {
	private selectedId: string | undefined;
	private layout: Map<string, Required<WorkflowNodeLayout>> = new Map();
	private panX = 0;
	private panY = 0;
	private lastViewW = 80;
	private lastViewH = 27;
	private lastCanvasW = 80;
	private lastCanvasH = 27;
	private shouldEnsureSelectedVisible = true;

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
		else if (data === "a") this.panBy(-12, 0);
		else if (data === "d") this.panBy(12, 0);
		else if (data === "w") this.panBy(0, -5);
		else if (data === "s") this.panBy(0, 5);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const outerW = Math.max(60, width);
		const innerW = Math.max(1, outerW - 2);
		const graphW = innerW;
		const graphH = 27;
		const { width: canvasW, height: canvasH } = this.virtualCanvasSize(graphW, graphH);
		this.lastViewW = graphW;
		this.lastViewH = graphH;
		this.lastCanvasW = canvasW;
		this.lastCanvasH = canvasH;
		this.layout = centerLayout(computeLayout(this.workflow, canvasW, canvasH), canvasW, canvasH);
		if (this.shouldEnsureSelectedVisible) {
			this.ensureSelectedVisible();
			this.shouldEnsureSelectedVisible = false;
		}
		this.clampViewport();

		const canvas = createCanvas(canvasW, canvasH);
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

		for (let y = 0; y < graphH; y++) {
			const row = canvas[this.panY + y] ?? [];
			const visible = row.slice(this.panX, this.panX + graphW).join("");
			lines.push(sideLine(pad(visible, graphW), th));
		}

		lines.push(sideLine("-".repeat(innerW), th, "+", "+"));
		const selected = this.workflow.nodes.find((n) => n.id === this.selectedId);
		const summary = selected
			? ` Selected: ${selected.id} | type: ${selected.type ?? "node"} | executor: ${selected.executor?.kind ?? "agent"} | verify: ${selected.verification?.enabled === false || selected.completionPolicy?.semanticVerification === false ? "off" : "on"}`
			: " No node selected";
		lines.push(sideLine(pad(summary, innerW), th));
		lines.push(sideLine(pad(` arrows select/auto-pan   |   wasd pan   |   Enter edit   |   r reload   |   Esc close   |   view ${this.panX},${this.panY}`, innerW), th));
		lines.push(bottomBorder(innerW, th));
		return lines.map((line) => truncateToWidth(line, outerW, "", true));
	}

	invalidate(): void {}

	private virtualCanvasSize(viewW: number, viewH: number): { width: number; height: number } {
		const ranks = computeRanks(this.workflow);
		const rankCount = Math.max(1, Math.max(0, ...Array.from(ranks.values())) + 1);
		const nodesPerRank = new Map<number, number>();
		for (const node of this.workflow.nodes) {
			const rank = ranks.get(node.id) ?? 0;
			nodesPerRank.set(rank, (nodesPerRank.get(rank) ?? 0) + 1);
		}
		const maxLayerNodes = Math.max(1, ...Array.from(nodesPerRank.values()));
		return {
			width: Math.max(viewW, rankCount * 48 + 8),
			height: Math.max(viewH, maxLayerNodes * 8 + 4),
		};
	}

	private panBy(dx: number, dy: number): void {
		this.shouldEnsureSelectedVisible = false;
		this.panX += dx;
		this.panY += dy;
		this.clampViewport();
	}

	private clampViewport(): void {
		this.panX = clamp(this.panX, 0, Math.max(0, this.lastCanvasW - this.lastViewW));
		this.panY = clamp(this.panY, 0, Math.max(0, this.lastCanvasH - this.lastViewH));
	}

	private ensureSelectedVisible(): void {
		const box = this.selectedId ? this.layout.get(this.selectedId) : undefined;
		if (!box) return;
		const marginX = 4;
		const marginY = 2;
		if (box.x < this.panX + marginX) this.panX = Math.max(0, box.x - marginX);
		else if (box.x + box.width > this.panX + this.lastViewW - marginX) this.panX = box.x + box.width - this.lastViewW + marginX;
		if (box.y < this.panY + marginY) this.panY = Math.max(0, box.y - marginY);
		else if (box.y + 5 > this.panY + this.lastViewH - marginY) this.panY = box.y + 5 - this.lastViewH + marginY;
	}

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
		if (best) {
			this.selectedId = best.id;
			this.shouldEnsureSelectedVisible = true;
			this.ensureSelectedVisible();
			this.clampViewport();
		}
	}
}

export class NodeEditorComponent {
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

export function rawFieldValue(node: WorkflowNode, field: FieldDef): string {
	const value = node[field.key];
	if (Array.isArray(value)) return value.join(", ");
	if (typeof value === "boolean") return String(value);
	if (typeof value === "string") return value;
	return "";
}

export function formatFieldValue(node: WorkflowNode, field: FieldDef): string {
	const raw = rawFieldValue(node, field);
	return raw.length > 0 ? raw : "(empty)";
}

export function commitFieldValue(node: WorkflowNode, field: FieldDef, value: string): void {
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

