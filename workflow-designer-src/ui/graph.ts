import type { WorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowNodeLayout } from "../types";
import { clamp, pad, truncateToWidth } from "./common";

export function computeLayout(workflow: WorkflowDefinition, width: number, height: number): Map<string, Required<WorkflowNodeLayout>> {
	// Dagre-style layered layout, left-to-right:
	// 1. assign each node to a rank by longest path from sources
	// 2. order nodes within each rank by barycenter of connected neighbours
	// 3. center every rank vertically and the whole graph horizontally
	// 4. route edges later as orthogonal segments between ranks
	const result = new Map<string, Required<WorkflowNodeLayout>>();
	if (workflow.nodes.length === 0) return result;

	const nodeById = new Map(workflow.nodes.map((node) => [node.id, node]));
	const ranks = computeRanks(workflow);
	const maxRank = Math.max(0, ...Array.from(ranks.values()));
	const layers: WorkflowNode[][] = Array.from({ length: maxRank + 1 }, () => []);
	for (const node of workflow.nodes) {
		layers[ranks.get(node.id) ?? 0]!.push(node);
	}

	orderLayersByBarycenter(layers, workflow.edges);

	const nodeWidths = new Map<string, number>();
	for (const node of workflow.nodes) {
		const preferred = node.layout?.width;
		nodeWidths.set(node.id, clamp(preferred ?? measureNodeWidth(node), 20, 38));
	}

	const layerWidths = layers.map((layer) => Math.max(0, ...layer.map((node) => nodeWidths.get(node.id) ?? 24)));
	const rankCount = layers.length;
	const minGapX = 6;
	const preferredGapX = 12;
	const totalNodeW = layerWidths.reduce((sum, w) => sum + w, 0);
	const availableGap = Math.max(0, width - totalNodeW - 2);
	const gapX = rankCount <= 1 ? 0 : clamp(Math.floor(availableGap / (rankCount - 1)), minGapX, preferredGapX);
	const graphW = totalNodeW + gapX * Math.max(0, rankCount - 1);
	let x = Math.max(0, Math.floor((width - graphW) / 2));

	for (let rank = 0; rank < layers.length; rank++) {
		const layer = layers[rank]!;
		const layerW = layerWidths[rank] ?? 24;
		const nodeH = 5;
		const maxGapY = 4;
		const minGapY = 1;
		const availableYGap = layer.length <= 1 ? 0 : Math.floor((height - layer.length * nodeH) / (layer.length - 1));
		const gapY = layer.length <= 1 ? 0 : clamp(availableYGap, minGapY, maxGapY);
		const layerH = layer.length * nodeH + Math.max(0, layer.length - 1) * gapY;
		let y = Math.max(0, Math.floor((height - layerH) / 2));

		for (const node of layer) {
			const nodeW = nodeWidths.get(node.id) ?? 24;
			const nodeX = x + Math.floor((layerW - nodeW) / 2);
			result.set(node.id, {
				x: clamp(nodeX, 0, Math.max(0, width - nodeW - 1)),
				y: clamp(y, 0, Math.max(0, height - nodeH)),
				width: nodeW,
			});
			y += nodeH + gapY;
		}

		x += layerW + gapX;
	}

	// Keep dangling/invalid edge endpoints from influencing nothing; unknown nodes are ignored.
	for (const edge of workflow.edges) {
		if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
	}
	return result;
}

export function measureNodeWidth(node: WorkflowNode): number {
	const title = node.title ?? node.id;
	const type = `type: ${node.type ?? "node"}`;
	const verify = `verify: ${node.verification?.enabled === false || node.completionPolicy?.semanticVerification === false ? "off" : "on"}`;
	return Math.max(20, Math.min(38, Math.max(title.length, type.length, verify.length) + 4));
}

export function orderLayersByBarycenter(layers: WorkflowNode[][], edges: WorkflowEdge[]): void {
	const incoming = new Map<string, string[]>();
	const outgoing = new Map<string, string[]>();
	for (const edge of edges) {
		const ins = incoming.get(edge.to) ?? [];
		ins.push(edge.from);
		incoming.set(edge.to, ins);
		const outs = outgoing.get(edge.from) ?? [];
		outs.push(edge.to);
		outgoing.set(edge.from, outs);
	}

	for (let pass = 0; pass < 4; pass++) {
		for (let rank = 1; rank < layers.length; rank++) {
			const prevIndex = indexLayer(layers[rank - 1]!);
			layers[rank]!.sort((a, b) => barycenter(a.id, incoming, prevIndex) - barycenter(b.id, incoming, prevIndex));
		}
		for (let rank = layers.length - 2; rank >= 0; rank--) {
			const nextIndex = indexLayer(layers[rank + 1]!);
			layers[rank]!.sort((a, b) => barycenter(a.id, outgoing, nextIndex) - barycenter(b.id, outgoing, nextIndex));
		}
	}
}

export function indexLayer(layer: WorkflowNode[]): Map<string, number> {
	return new Map(layer.map((node, index) => [node.id, index]));
}

export function barycenter(id: string, neighbours: Map<string, string[]>, neighbourIndex: Map<string, number>): number {
	const ids = neighbours.get(id) ?? [];
	const positions = ids.map((n) => neighbourIndex.get(n)).filter((v): v is number => typeof v === "number");
	if (positions.length === 0) return Number.POSITIVE_INFINITY;
	return positions.reduce((sum, value) => sum + value, 0) / positions.length;
}

export function centerLayout(
	layout: Map<string, Required<WorkflowNodeLayout>>,
	width: number,
	height: number,
): Map<string, Required<WorkflowNodeLayout>> {
	if (layout.size === 0) return layout;

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const box of layout.values()) {
		minX = Math.min(minX, box.x);
		minY = Math.min(minY, box.y);
		maxX = Math.max(maxX, box.x + box.width);
		maxY = Math.max(maxY, box.y + 5);
	}

	const contentW = maxX - minX;
	const contentH = maxY - minY;
	const dx = Math.max(0, Math.floor((width - contentW) / 2)) - minX;
	const dy = Math.max(0, Math.floor((height - contentH) / 2)) - minY;

	const centered = new Map<string, Required<WorkflowNodeLayout>>();
	for (const [id, box] of layout) {
		centered.set(id, {
			...box,
			x: clamp(box.x + dx, 0, Math.max(0, width - box.width - 1)),
			y: clamp(box.y + dy, 0, Math.max(0, height - 5)),
		});
	}
	return centered;
}

export function computeRanks(workflow: WorkflowDefinition): Map<string, number> {
	const ranks = new Map<string, number>();
	for (const node of workflow.nodes) ranks.set(node.id, 0);
	for (let i = 0; i < workflow.nodes.length; i++) {
		let changed = false;
		for (const edge of workflow.edges) {
			const from = ranks.get(edge.from) ?? 0;
			const to = ranks.get(edge.to) ?? 0;
			if (to <= from) {
				ranks.set(edge.to, from + 1);
				changed = true;
			}
		}
		if (!changed) break;
	}
	return ranks;
}

export function createCanvas(width: number, height: number): string[][] {
	return Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
}

export function drawEdges(canvas: string[][], workflow: WorkflowDefinition, layout: Map<string, Required<WorkflowNodeLayout>>): void {
	for (const edge of workflow.edges) {
		const from = layout.get(edge.from);
		const to = layout.get(edge.to);
		if (!from || !to) continue;
		// Keep edges outside node boxes. The arrow stops immediately before the
		// target border, preserving the rectangle and avoiding apparent text shifts.
		const sx = from.x + from.width;
		const sy = from.y + 2;
		const tx = to.x - 1;
		const ty = to.y + 2;
		if (sx > tx) continue;
		const mid = Math.floor((sx + tx) / 2);
		drawH(canvas, sx, mid, sy);
		drawV(canvas, mid, sy, ty);
		drawH(canvas, mid, tx, ty);
		setCell(canvas, tx, ty, ">");
		if (sy !== ty) {
			setCell(canvas, mid, sy, "+");
			setCell(canvas, mid, ty, "+");
		}
	}
}

export function drawNode(canvas: string[][], node: WorkflowNode, box: Required<WorkflowNodeLayout>, selected: boolean): void {
	const x = box.x;
	const y = box.y;
	const w = Math.max(10, box.width);
	const inner = w - 2;
	const top = selected ? `*${"=".repeat(inner)}*` : `+${"-".repeat(inner)}+`;
	const midL = selected ? "|" : "|";
	const midR = selected ? "|" : "|";
	const bottom = selected ? `*${"=".repeat(inner)}*` : `+${"-".repeat(inner)}+`;
	const selectedMark = selected ? "> " : "";
	putText(canvas, x, y, top);
	putText(canvas, x, y + 1, `${midL}${pad(truncateToWidth(`${selectedMark}${node.title ?? node.id}`, inner, "..."), inner)}${midR}`);
	putText(canvas, x, y + 2, `${midL}${pad(truncateToWidth(`type: ${node.type ?? "node"}`, inner, "..."), inner)}${midR}`);
	putText(canvas, x, y + 3, `${midL}${pad(truncateToWidth(`verify: ${node.verification?.enabled === false || node.completionPolicy?.semanticVerification === false ? "off" : "on"}`, inner, "..."), inner)}${midR}`);
	putText(canvas, x, y + 4, bottom);
}

export function drawH(canvas: string[][], x1: number, x2: number, y: number): void {
	for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) mergeCell(canvas, x, y, "-");
}

export function drawV(canvas: string[][], x: number, y1: number, y2: number): void {
	for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) mergeCell(canvas, x, y, "|");
}

export function mergeCell(canvas: string[][], x: number, y: number, ch: string): void {
	const old = getCell(canvas, x, y);
	if (old === undefined) return;
	if (old === " " || old === ch) setCell(canvas, x, y, ch);
	else if ((old === "-" && ch === "|") || (old === "|" && ch === "-")) setCell(canvas, x, y, "+");
}

export function putText(canvas: string[][], x: number, y: number, text: string): void {
	for (let i = 0; i < text.length; i++) setCell(canvas, x + i, y, text[i]!);
}

export function getCell(canvas: string[][], x: number, y: number): string | undefined {
	if (y < 0 || y >= canvas.length) return undefined;
	const row = canvas[y];
	if (!row || x < 0 || x >= row.length) return undefined;
	return row[x];
}

export function setCell(canvas: string[][], x: number, y: number, ch: string): void {
	if (y < 0 || y >= canvas.length) return;
	const row = canvas[y];
	if (!row || x < 0 || x >= row.length) return;
	row[x] = ch;
}
