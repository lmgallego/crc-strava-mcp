import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Único punto de registro de las herramientas CRC.
 * Se llama al final de `server.ts`, después de las herramientas originales.
 *
 * Sprint 1: los helpers de contrato ya existen
 * (`schemas/mcpSchemas.ts` y `schemas/crcToolResponse.ts`), pero todavía no se
 * registra ninguna herramienta. Al añadir la primera, renombrar `_server` a
 * `server` (el guion bajo solo está para satisfacer `noUnusedParameters`).
 */
export function registerCrcTools(_server: McpServer): void {
    // Sprint 1: sin herramientas CRC todavía. La analítica llega en Sprint 2+.
}
