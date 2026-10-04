/** The built-in tools that need nothing else: the time. */

import { ToolRegistry } from "@vunemi/agent-core";

export function createDemoTools(): ToolRegistry {
  return new ToolRegistry()
    .register({
      name: "get_current_time",
      description: "Returns the current local date and time on the user's computer.",
      parameters: { type: "object", properties: {} },
      actionClass: "read",
      run: async () => {
        const now = new Date();
        return `${now.toString()} (ISO ${now.toISOString()})`;
      },
    });
}
