/**
 * pi-tui 主题适配：MarkdownTheme / EditorTheme，颜色全部经 currentTheme 取。
 * 对齐 kimi-code src/tui/theme/pi-tui-theme.ts 的迷你版；
 * 玩具不接 cli-highlight，highlightCode 原样分行返回。
 */
import chalk from "chalk";

import type { EditorTheme, MarkdownTheme } from "../../../vendor/pi-tui/src/index.ts";
import type { ColorPalette } from "./colors.ts";
import { currentTheme } from "./theme.ts";

// pi-tui 对 h3-h6 会输出字面 "### " 前缀（h1/h2 不带）；前缀到达时已包 bold
// SGR，剥离时跳过前导 ANSI 序列，否则 h3+ 渲染成未解析的原始 markdown。
// 对齐 kimi-code pi-tui-theme.ts 的 HEADING_HASH_PREFIX。
// eslint-disable-next-line no-control-regex -- 有意匹配 ANSI SGR 的 ESC 字节
const HEADING_HASH_PREFIX = /^((?:\u001B\[[0-9;]*m)*)#{1,6}[ \t]+/;

function hex(token: keyof ColorPalette): (text: string) => string {
  return (text) => chalk.hex(currentTheme.color(token))(text);
}

export function createMarkdownTheme(): MarkdownTheme {
  return {
    heading: (text) => chalk.bold(hex("text")(text.replace(HEADING_HASH_PREFIX, "$1"))),
    link: hex("primary"),
    linkUrl: hex("textMuted"),
    code: hex("primary"),
    codeBlock: (text) => text,
    codeBlockBorder: hex("textMuted"),
    quote: hex("textDim"),
    quoteBorder: hex("textDim"),
    hr: hex("border"),
    // 与 assistant 消息前缀一致：行首 "-" 换成 "•"，有序列表不动。
    listBullet: (text) => hex("text")(text.replace(/^-/, "•")),
    bold: (text) => chalk.bold(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
    highlightCode: (code) => code.split("\n"),
  };
}

export function createEditorTheme(): EditorTheme {
  return {
    borderColor: hex("border"),
    selectList: {
      selectedPrefix: hex("primary"),
      selectedText: hex("primary"),
      description: hex("textMuted"),
      scrollInfo: hex("textMuted"),
      noMatch: hex("textMuted"),
    },
  };
}
