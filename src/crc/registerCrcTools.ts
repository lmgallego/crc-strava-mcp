import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
    getPerformanceProfileTool,
    setPerformanceProfileTool,
} from "./tools/performanceProfileTools.js";
import { detectClimbsTool } from "./tools/climbTools.js";
import { estimateFtpTool, estimateVo2maxTool } from "./tools/estimateTools.js";
import {
    analyzeCyclingActivityTool,
    compareActivitiesTool,
} from "./tools/orchestrationTools.js";
import {
    decouplingTool,
    timeInZonesTool,
    torqueCadenceTool,
    workAboveFtpTool,
} from "./tools/physiologyTools.js";
import { powerCurveTool, powerMetricsTool } from "./tools/powerTools.js";

/**
 * Único punto de registro de las herramientas CRC.
 * Se llama al final de `server.ts`, después de las herramientas originales.
 *
 * Las tools CRC nunca son importadas por el código original: la dependencia es
 * unidireccional.
 */
export function registerCrcTools(server: McpServer): void {
    const tools = [
        getPerformanceProfileTool,
        setPerformanceProfileTool,
        powerMetricsTool,
        powerCurveTool,
        decouplingTool,
        timeInZonesTool,
        torqueCadenceTool,
        workAboveFtpTool,
        estimateVo2maxTool,
        estimateFtpTool,
        analyzeCyclingActivityTool,
        compareActivitiesTool,
        detectClimbsTool,
    ];
    for (const tool of tools) {
        server.tool(tool.name, tool.description, tool.inputSchema.shape, tool.execute as never);
    }
}
