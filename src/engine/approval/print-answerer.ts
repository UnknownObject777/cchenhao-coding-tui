/**
 * print 模式应答源（#27）：无人可问——confirm 级别在 --yes 下放行，否则拒绝。
 * 危险 pattern（deny 级）在规则引擎里就被短路，到不了这里，--yes 也救不了。
 */
import type { ApprovalAnswerer } from "./composed-gate.ts";
import type { ApprovalCall } from "./gate.ts";

export function createPrintAnswerer(yes: boolean, onDeny?: (message: string) => void): ApprovalAnswerer {
  const report = onDeny ?? ((message: string) => process.stderr.write(`${message}\n`));
  return {
    ask(call: ApprovalCall) {
      if (yes) return Promise.resolve("allow");
      report(`[approval] ${call.name} 需要确认；print 模式无人可问，已拒绝（加 --yes 放行写/执行类调用）`);
      return Promise.resolve("deny");
    },
  };
}
