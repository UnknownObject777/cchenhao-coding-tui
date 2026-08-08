/**
 * 会话选择器（#47）：启动时列出工作区历史会话，数字键选择、
 * Enter 继续最近、n 新建。最小版，类比 kimi-code session-picker。
 */
import { truncateToWidth, type Component, type TUI } from "../../vendor/pi-tui/src/index.ts";
import type { SessionInfo } from "../engine/session.ts";
import { hex } from "./theme/pi-tui-theme.ts";

export type SessionChoice = { kind: "resume"; path: string } | { kind: "new" };

class SessionPickerComponent implements Component {
  private readonly sessions: SessionInfo[];

  constructor(sessions: SessionInfo[]) {
    this.sessions = sessions;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines = ["", hex("textStrong")(" 选择会话：")];
    this.sessions.forEach((session, i) => {
      const time = new Date(session.mtimeMs).toLocaleString();
      const summary = session.summary === "" ? "(无记录)" : session.summary;
      lines.push(hex("text")(`  [${i + 1}] `) + hex("textDim")(`${time} · `) + hex("text")(summary));
    });
    lines.push(hex("textMuted")("  [Enter] 继续最近  [n] 新会话  [esc] 继续最近"));
    return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
  }
}

/**
 * 弹出选择器并等待选择。返回用户选择；调用方负责后续装配。
 */
export function pickSession(tui: TUI, sessions: SessionInfo[]): Promise<SessionChoice> {
  const component = new SessionPickerComponent(sessions);
  tui.addChild(component);
  tui.requestRender(true);

  return new Promise<SessionChoice>((resolve) => {
    const detach = tui.addInputListener((data: string): { consume: true } | undefined => {
      const done = (choice: SessionChoice): { consume: true } => {
        detach();
        tui.removeChild(component);
        tui.requestRender(true);
        resolve(choice);
        return { consume: true };
      };
      if (data === "\r" || data === "\u{1B}") {
        const latest = sessions[0];
        return done(latest !== undefined ? { kind: "resume", path: latest.path } : { kind: "new" });
      }
      if (data === "n" || data === "N") return done({ kind: "new" });
      const digit = Number(data);
      if (Number.isInteger(digit) && digit >= 1 && digit <= sessions.length) {
        return done({ kind: "resume", path: sessions[digit - 1]!.path });
      }
      return { consume: true }; // 选择器激活期间吞掉其它键
    });
  });
}
