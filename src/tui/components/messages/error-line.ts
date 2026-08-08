/** 错误行组件：streaming-ui 与 coordinator 共用，保证 ✗ 前缀与 error 色单源。 */
import { Text } from "../../../../vendor/pi-tui/src/index.ts";
import { FAILURE_MARK } from "../../constant/symbols.ts";
import { hex } from "../../theme/pi-tui-theme.ts";

export function errorLine(text: string): Text {
  return new Text(hex("error")(FAILURE_MARK + text), 0, 0);
}
