import type { SelectionAnchor } from "../interact-types";
const xml = (v: string) => v.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export function buildAnchorPrompt(prompt: string, anchor?: SelectionAnchor | null, page?: { documentId: string; version?: number }): string {
  const attrs = [page ? `document="${xml(page.documentId)}" version="${page.version || "latest"}"` : "",
    anchor ? `entry="${xml(anchor.entryPath)}" selector="${xml(anchor.elementSelector || "")}"` : ""].filter(Boolean).join(" ");
  return `<html-preview-anchor ${attrs}>\n${xml(anchor?.exact || "")}\n${anchor?.prefix ? `prefix: ${xml(anchor.prefix)}\n` : ""}${anchor?.suffix ? `suffix: ${xml(anchor.suffix)}\n` : ""}</html-preview-anchor>\n\n${prompt}`;
}
