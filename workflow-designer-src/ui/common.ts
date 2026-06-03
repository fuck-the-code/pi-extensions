import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function topBorder(width: number, title: string, theme: Theme): string {
	const safeTitle = truncateToWidth(title, Math.max(0, width - 2), "");
	const titleW = visibleWidth(safeTitle);
	const left = Math.floor(Math.max(0, width - titleW) / 2);
	const right = Math.max(0, width - titleW - left);
	return theme.fg("border", `+${"-".repeat(left)}`) + theme.fg("accent", safeTitle) + theme.fg("border", `${"-".repeat(right)}+`);
}

export function bottomBorder(width: number, theme: Theme): string {
	return theme.fg("border", `+${"-".repeat(width)}+`);
}

export function sideLine(content: string, theme: Theme, left = "|", right = "|"): string {
	return theme.fg("border", left) + content + theme.fg("border", right);
}

export function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export function padAnsi(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export function padRight(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function isEnter(data: string): boolean {
	return matchesKey(data, "enter") || matchesKey(data, "return");
}

export { matchesKey, truncateToWidth, visibleWidth };
