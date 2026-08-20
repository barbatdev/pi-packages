import { isToolCallEventType, type ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { runProbePlan } from "./probe-runner.ts";
import { createRuntimeHandler } from "./runtime.ts";

const handle = createRuntimeHandler({ runProbePlan });

const extension: ExtensionFactory = (pi) => {
  pi.on("tool_call", (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    return handle(event, { cwd: ctx.cwd, hasUI: ctx.hasUI, signal: ctx.signal ?? new AbortController().signal });
  });
};

export default extension;
