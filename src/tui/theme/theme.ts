import { darkColors, type ColorPalette } from "./colors.ts";

/**
 * 主题单例：组件经 currentTheme.color(token) 取色。
 * 玩具版只有暗色 palette；#23 会加亮色 palette 与启动时终端背景检测，
 * 届时这里换成可切换的 holder（组件仍只认 currentTheme，不换引用）。
 */
export interface Theme {
  color(token: keyof ColorPalette): string;
}

function createTheme(palette: ColorPalette): Theme {
  return {
    color: (token) => palette[token],
  };
}

export const currentTheme: Theme = createTheme(darkColors);
