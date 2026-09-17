#!/usr/bin/env node
/**
 * Vuelca el contrato publicado por el servidor (tools/list) a JSON.
 *
 *   node scripts/snapshot-tools.mjs > antes.json
 *   node scripts/snapshot-tools.mjs > despues.json
 *   node scripts/snapshot-tools.mjs --diff antes.json despues.json
 *
 * Requiere `npm run build` previo: arranca dist/server.js por stdio.
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [, , flag, beforePath, afterPath] = process.argv;

if (flag === "--diff") {
    const a = JSON.parse(readFileSync(beforePath, "utf8"));
    const b = JSON.parse(readFileSync(afterPath, "utf8"));
    const byName = (s) => new Map(s.tools.map((t) => [t.name, t]));
    const A = byName(a);
    const B = byName(b);

    const removed = [...A.keys()].filter((n) => !B.has(n));
    const added = [...B.keys()].filter((n) => !A.has(n));
    const changed = [...A.keys()].filter(
        (n) => B.has(n) && JSON.stringify(A.get(n)) !== JSON.stringify(B.get(n)),
    );

    console.log(`tools: ${a.count} -> ${b.count}`);
    if (removed.length) console.log("ELIMINADAS:", removed.join(", "));
    if (added.length) console.log("AÑADIDAS:", added.join(", "));
    if (!changed.length) console.log("Sin cambios en las tools comunes.");
    for (const n of changed) {
        const x = A.get(n);
        const y = B.get(n);
        console.log(`\n--- ${n} ---`);
        if (x.description !== y.description) console.log("  descripción CAMBIADA");
        console.log("  antes  :", JSON.stringify(x.inputSchema));
        console.log("  después:", JSON.stringify(y.inputSchema));
    }
    process.exit(removed.length ? 1 : 0);
}

const transport = new StdioClientTransport({ command: "node", args: ["dist/server.js"] });
const client = new Client({ name: "snapshot", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);
const { tools } = await client.listTools();
const snap = tools
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
    .sort((x, y) => x.name.localeCompare(y.name));
console.log(JSON.stringify({ count: snap.length, tools: snap }, null, 2));
await client.close();
process.exit(0);
