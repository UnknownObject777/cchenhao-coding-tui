import chalk from "chalk";
import { describe, expect, it } from "vitest";

import { darkColors, type ColorPalette } from "../src/tui/theme/colors.ts";
import { createEditorTheme, createMarkdownTheme } from "../src/tui/theme/pi-tui-theme.ts";
import { currentTheme } from "../src/tui/theme/theme.ts";

// vitest 环境非 TTY，chalk 默认 level 0 不着色；强制 truecolor 让样式断言确定。
chalk.level = 3;

const ESC = "\u{1B}";

const EXPECTED_TOKENS: (keyof ColorPalette)[] = [
  "primary",
  "accent",
  "text",
  "textStrong",
  "textDim",
  "textMuted",
  "border",
  "borderFocus",
  "success",
  "warning",
  "error",
  "roleUser",
];

const MARKDOWN_THEME_METHODS = [
  "heading",
  "link",
  "linkUrl",
  "code",
  "codeBlock",
  "codeBlockBorder",
  "quote",
  "quoteBorder",
  "hr",
  "listBullet",
  "bold",
  "italic",
  "strikethrough",
  "underline",
] as const;

const ANSI = /\u{1B}\[[0-9;]*m/u;

describe("theme colors", () => {
  it("dark palette covers every token with a hex value", () => {
    expect(Object.keys(darkColors).sort()).toEqual([...EXPECTED_TOKENS].sort());
    for (const token of EXPECTED_TOKENS) {
      expect(darkColors[token], token).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("currentTheme resolves tokens from the active palette", () => {
    expect(currentTheme.color("text")).toBe(darkColors.text);
    expect(currentTheme.color("primary")).toBe(darkColors.primary);
  });
});

describe("createMarkdownTheme", () => {
  it("implements every required MarkdownTheme method", () => {
    const theme = createMarkdownTheme();
    for (const method of MARKDOWN_THEME_METHODS) {
      expect(typeof theme[method], method).toBe("function");
    }
  });

  it("styles come from palette tokens, not chalk named colors", () => {
    const theme = createMarkdownTheme();
    expect(theme.heading("Title")).toMatch(ANSI);
    expect(theme.link("x")).toMatch(ANSI);
    expect(theme.quote("q")).toMatch(ANSI);
  });

  it("normalizes leading-dash list bullets like kimi-code", () => {
    const theme = createMarkdownTheme();
    expect(theme.listBullet("-")).toContain("•");
  });

  it("strips literal ### prefix from h3+ headings (pi-tui emits it for h3-h6)", () => {
    const theme = createMarkdownTheme();
    // 前缀到达时已包 bold SGR，剥离须跳过前导 ANSI 序列
    const rendered = theme.heading(`${ESC}[1m### 深标题${ESC}[22m`);
    expect(rendered).toContain("深标题");
    expect(rendered).not.toContain("###");
    expect(theme.heading("###  plain")).not.toContain("###");
  });

  it("highlights code plainly (no syntax highlighter in the toy)", () => {
    const theme = createMarkdownTheme();
    expect(theme.highlightCode?.("const a = 1;\nconst b = 2;", "ts")).toEqual([
      "const a = 1;",
      "const b = 2;",
    ]);
  });
});

describe("createEditorTheme", () => {
  it("has borderColor and a full SelectListTheme", () => {
    const theme = createEditorTheme();
    expect(typeof theme.borderColor).toBe("function");
    for (const method of ["selectedPrefix", "selectedText", "description", "scrollInfo", "noMatch"] as const) {
      expect(typeof theme.selectList[method], method).toBe("function");
    }
    expect(theme.borderColor("─")).toMatch(ANSI);
  });
});
