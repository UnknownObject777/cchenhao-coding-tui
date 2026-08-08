/**
 * 用户消息块：bullet + roleUser 色正文。
 * 对齐 kimi-code components/messages/user-message.ts 的迷你版（无图片、无渲染缓存）。
 */
import chalk from "chalk";

import { Text, truncateToWidth, visibleWidth, type Component } from "../../../../vendor/pi-tui/src/index.ts";
import { USER_MESSAGE_BULLET } from "../../constant/symbols.ts";
import { currentTheme } from "../../theme/theme.ts";

export class UserMessageComponent implements Component {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const roleColor = chalk.hex(currentTheme.color("roleUser"));
    const bullet = roleColor.bold(USER_MESSAGE_BULLET);
    const indent = " ".repeat(visibleWidth(USER_MESSAGE_BULLET));
    const contentWidth = Math.max(1, safeWidth - visibleWidth(USER_MESSAGE_BULLET));

    const bodyLines = new Text(roleColor(this.text), 0, 0).render(contentWidth);
    const lines = ["", ...bodyLines.map((line, i) => (i === 0 ? bullet : indent) + line)];
    return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
  }
}
