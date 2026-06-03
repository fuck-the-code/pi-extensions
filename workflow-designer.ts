import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkflowCommands } from "./workflow-designer-src/commands";

export default function workflowDesignerExtension(pi: ExtensionAPI) {
	registerWorkflowCommands(pi);
}
