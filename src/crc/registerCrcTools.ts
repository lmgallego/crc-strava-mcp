import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Único punto de registro de las herramientas CRC.
 * Se llama al final de `server.ts`, después de las herramientas originales.
 *
 * Vacío en Sprint 0: el esqueleto existe para que las tools CRC se enganchen
 * aquí sin tocar el registro original.
 */
// El parámetro lleva `_` porque aún no se usa (noUnusedParameters).
export function registerCrcTools(_server: McpServer): void {
    // Sprint 0: sin herramientas CRC todavía.
}
