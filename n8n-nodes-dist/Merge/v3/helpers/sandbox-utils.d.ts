import type { IDataObject } from 'n8n-workflow';
import type IsolatedVM from 'isolated-vm';
/** Disposes the cached isolate. Exposed for tests only. */
export declare function resetSandboxCache(): void;
/** Returns a cached isolated-vm context with alasql pre-loaded. Creates it on first call. */
export declare function loadAlaSqlSandbox(): Promise<IsolatedVM.Context>;
/**
 * Runs a SQL query against plain-object table data inside the isolated-vm sandbox.
 * Only JSON-serialisable values cross the isolate boundary.
 */
export declare function runAlaSqlInSandbox(context: IsolatedVM.Context, tableData: unknown[][], query: string): Promise<IDataObject[]>;
//# sourceMappingURL=sandbox-utils.d.ts.map