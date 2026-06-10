"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resetSandboxCache = resetSandboxCache;
exports.loadAlaSqlSandbox = loadAlaSqlSandbox;
exports.runAlaSqlInSandbox = runAlaSqlInSandbox;
const promises_1 = require("node:fs/promises");
const node_crypto_1 = require("node:crypto");
let _ivm = null;
async function getIvm() {
    if (!_ivm) {
        const mod = await Promise.resolve().then(() => __importStar(require('isolated-vm')));
        _ivm = mod.default;
    }
    return _ivm;
}
// Singleton – recreated only after resetSandboxCache() (tests) or isolate disposal.
let sandboxIsolate = null;
let sandboxContext = null;
/** Disposes the cached isolate. Exposed for tests only. */
function resetSandboxCache() {
    sandboxContext = null;
    if (sandboxIsolate && !sandboxIsolate.isDisposed) {
        sandboxIsolate.dispose();
    }
    sandboxIsolate = null;
}
/** Returns a cached isolated-vm context with alasql pre-loaded. Creates it on first call. */
async function loadAlaSqlSandbox() {
    if (sandboxContext && sandboxIsolate && !sandboxIsolate.isDisposed) {
        return sandboxContext;
    }
    const ivm = await getIvm();
    sandboxIsolate = new ivm.Isolate({ memoryLimit: 64 }); // 64 MB hard limit
    sandboxContext = await sandboxIsolate.createContext();
    // Block network/file APIs before loading alasql to prevent
    // file access via SQL statements (e.g. SOURCE, REQUIRE).
    // Must be non-writable/non-configurable so the alasql bundle cannot overwrite them.
    await sandboxContext.eval(`
		function blockedNetworkOrFileApi() { throw new Error('Network and file system access is disabled in the SQL sandbox'); }
		Object.defineProperty(globalThis, 'fetch', { value: blockedNetworkOrFileApi, writable: false, configurable: false });
		Object.defineProperty(globalThis, 'XMLHttpRequest', { value: blockedNetworkOrFileApi, writable: false, configurable: false });
	`);
    // Browser bundle only – no Node.js fs/require handlers inside the isolate.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const alasqlBundlePath = require.resolve('alasql/dist/alasql.min.js');
    await sandboxContext.eval(await (0, promises_1.readFile)(alasqlBundlePath, 'utf-8'));
    await sandboxContext.eval('Object.freeze(alasql.fn)');
    return sandboxContext;
}
/**
 * Runs a SQL query against plain-object table data inside the isolated-vm sandbox.
 * Only JSON-serialisable values cross the isolate boundary.
 */
async function runAlaSqlInSandbox(context, tableData, query) {
    // UUID per invocation so concurrent calls sharing the singleton context
    // don't collide on alasql.databases.
    const dbId = (0, node_crypto_1.randomUUID)();
    // Double-serialization: outer JSON.stringify produces a JSON string, inner produces a JSON literal
    // embedded in the script source. Inside the isolate, JSON.parse reconstructs the plain array.
    // This ensures data enters the isolate as a parsed JSON literal, never as live objects.
    const script = `(function() {
		const __rows = JSON.parse(${JSON.stringify(JSON.stringify(tableData))});
		const __db = new alasql.Database(${JSON.stringify(dbId)});
		try {
			for (let i = 0; i < __rows.length; i++) {
				__db.exec('CREATE TABLE input' + (i + 1));
				__db.tables['input' + (i + 1)].data = __rows[i];
			}
			return JSON.stringify(__db.exec(${JSON.stringify(query)}));
		} finally {
			delete alasql.databases[${JSON.stringify(dbId)}];
		}
	})()`;
    const resultJson = (await context.eval(script, { timeout: 5000, copy: true }));
    try {
        return JSON.parse(resultJson);
    }
    catch (e) {
        throw new Error(`Failed to parse SQL result: ${e.message}`);
    }
}
//# sourceMappingURL=sandbox-utils.js.map