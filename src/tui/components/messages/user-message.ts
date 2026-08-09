/**
 * 用户消息块：bullet + roleUser 色正文。
 * 对齐 kimi-code components/messages/user-message.ts 的迷你版（无图片、无渲染缓存）。
 */
import chalk from "chalk";

import { Text, type Component } from "../../../../vendor/pi-tui/src/index.ts";
import { USER_MESSAGE_BULLET } from "../../constant/symbols.ts";
import { hex } from "../../theme/pi-tui-theme.ts";
import { bulletWidth, layOutBlock } from "./block-layout.ts";

export class UserMessageComponent implements Component {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const bullet = chalk.bold(hex("roleUser")(USER_MESSAGE_BULLET));
    const contentWidth = Math.max(1, safeWidth - bulletWidth(USER_MESSAGE_BULLET));
    const bodyLines = new Text(hex("roleUser")(this.text), 0, 0).render(contentWidth);
    return layOutBlock(safeWidth, bullet, bodyLines);
  }
}
