import { paletteFor, type ColorPalette, type ResolvedTheme } from "./colors.ts";

/**
 * 主题单例：组件经 currentTheme.color(token) 取色。
 * #23 起为可切换 holder——启动时终端背景检测后 setTheme()，
 * 组件渲染时才读色，切换即时生效（同 kimi-code currentTheme 模式）。
 */
export interface Theme {
  color(token: keyof ColorPalette): string;
  setTheme(theme: ResolvedTheme): void;
  readonly current: ResolvedTheme;
}

function createTheme(initial: ResolvedTheme): Theme {
  let palette: ColorPalette = paletteFor(initial);
  let current: ResolvedTheme = initial;
  return {
    color: (token) => palette[token],
    setTheme: (theme) => {
      current = theme;
      palette = paletteFor(theme);
    },
    get current() {
      return current;
    },
  };
}

export const currentTheme: Theme = createTheme("dark");
