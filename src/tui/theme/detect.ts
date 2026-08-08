/**
 * 终端背景检测（#23），对齐 kimi-code theme/detect.ts 的迷你版：
 * 1. OSC 11（经 pi-tui 的 queryTerminalBackgroundColor，必须在 raw mode 后有 TUI 实例时查）；
 * 2. COLORFGBG 环境变量兜底；
 * 3. 任何失败都安全降级 dark。
 */
import type { TUI } from "../../../vendor/pi-tui/src/index.ts";
import type { ResolvedTheme } from "./colors.ts";

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 相对亮度估计（0-1），> 0.5 视为亮背景。权重取 sRGB 感知系数（同 kimi-code）。 */
export function themeFromBackground(rgb: Rgb): ResolvedTheme {
  const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  return luminance > 0.5 ? "light" : "dark";
}

/** COLORFGBG="fg;bg"（或 "fg;bg;extra"）：bg 0-6 与 8（亮黑≈中灰）算暗，7/9-15 算亮（同 kimi-code detect）。 */
export function parseColorFgBg(value: string | undefined): ResolvedTheme | undefined {
  if (value === undefined) return undefined;
  const parts = value.split(";");
  const bg = Number(parts[parts.length - 1]);
  if (!Number.isInteger(bg) || bg < 0 || bg > 15) return undefined;
  return bg >= 0 && bg <= 6 || bg === 8 ? "dark" : "light";
}

const OSC11_TIMEOUT_MS = 300;

export async function detectTerminalTheme(tui: TUI): Promise<ResolvedTheme> {
  // 非交互 / CI 环境直接降级 dark，不发 OSC 查询
  if (!(process.stdout.isTTY ?? false)) return "dark";
  const ci = process.env["CI"];
  if (ci !== undefined && ci !== "" && ci !== "0") return "dark";

  try {
    const rgb = await tui.queryTerminalBackgroundColor({ timeoutMs: OSC11_TIMEOUT_MS });
    if (rgb !== undefined) return themeFromBackground(rgb);
  } catch {
    // 查询失败安全降级
  }
  return parseColorFgBg(process.env["COLORFGBG"]) ?? "dark";
}
