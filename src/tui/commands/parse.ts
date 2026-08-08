/** slash 命令解析："/clear arg1 arg2" → { name: "clear", args: "arg1 arg2" }。 */
export interface ParsedSlashCommand {
  name: string;
  args: string;
}

export function parseSlashCommand(text: string): ParsedSlashCommand | undefined {
  if (!text.startsWith("/")) return undefined;
  const body = text.slice(1).trim();
  if (body === "") return undefined;
  const spaceIndex = body.search(/\s/);
  if (spaceIndex === -1) return { name: body, args: "" };
  return { name: body.slice(0, spaceIndex), args: body.slice(spaceIndex).trim() };
}
