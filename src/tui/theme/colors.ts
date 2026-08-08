/**
 * 颜色 token 唯一来源。组件只允许从这里（经 currentTheme）取色，
 * 不允许直接用 chalk 命名色。对齐 kimi-code src/tui/theme/colors.ts 的迷你版。
 *
 * 当前只有暗色一套；亮色 token 与终端背景检测属于 #23。
 */
export interface ColorPalette {
  // ── Brand ──
  /** 主交互色：链接、行内 code、聚焦边框、loader。 */
  primary: string;
  /** 次要高亮色。 */
  accent: string;

  // ── Text ──
  /** 正文。 */
  text: string;
  /** 强调/粗体文本。 */
  textStrong: string;
  /** 次级、淡化文本：提示语、footer。 */
  textDim: string;
  /** 最弱文本：链接 URL、计数。 */
  textMuted: string;

  // ── Surface ──
  /** 边框：editor 边框、markdown 分隔线。 */
  border: string;
  /** 聚焦/注意边框。 */
  borderFocus: string;

  // ── State ──
  success: string;
  warning: string;
  error: string;

  // ── Roles ──
  /** 用户消息角色色。 */
  roleUser: string;
}

export const darkColors: ColorPalette = {
  primary: "#4FA8FF",
  accent: "#5BC0BE",

  text: "#E0E0E0",
  textStrong: "#F5F5F5",
  textDim: "#888888",
  textMuted: "#6B6B6B",

  border: "#5A5A5A",
  borderFocus: "#E8A838",

  success: "#4EC87E",
  warning: "#E8A838",
  error: "#E85454",

  roleUser: "#FFCB6B",
};

/** 亮色调色板（#23）：文本 token 对 #FFFFFF 对比度 ≥ 4.5:1（沿 kimi-code 的 WCAG AA 取值）。 */
export const lightColors: ColorPalette = {
  primary: "#1565C0",
  accent: "#00838F",

  text: "#1A1A1A",
  textStrong: "#1A1A1A",
  textDim: "#454545",
  textMuted: "#5F5F5F",

  border: "#737373",
  borderFocus: "#92660A",

  success: "#0E7A38",
  warning: "#92660A",
  error: "#B91C1C",

  roleUser: "#9A4A00",
};

export type ResolvedTheme = "dark" | "light";

export function paletteFor(theme: ResolvedTheme): ColorPalette {
  return theme === "dark" ? darkColors : lightColors;
}
