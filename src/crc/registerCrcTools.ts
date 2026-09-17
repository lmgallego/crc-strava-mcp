import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
    getPerformanceProfileTool,
    setPerformanceProfileTool,
} from "./tools/performanceProfileTools.js";

/**
 * Único punto de registro de las herramientas CRC.
 * Se llama al final de `server.ts`, después de las herramientas originales.
 *
 * Las tools CRC nunca son importadas por el código original: la dependencia es
 * unidireccional.
 */
export function registerCrcTools(server: McpServer): void {
    for (const tool of [getPerformanceProfileTool, setPerformanceProfileTool]) {
        server.tool(tool.name, tool.description, tool.inputSchema.shape, tool.execute as never);
    }
}
