import { type IDataObject, type NodeApiError } from 'n8n-workflow';
import type { UpdateRecord } from './interfaces';
export declare function removeIgnored(data: IDataObject, ignore: string | string[]): IDataObject;
export declare function findMatches(data: UpdateRecord[], keys: string[], fields: IDataObject, updateAll?: boolean): UpdateRecord[];
export declare function processAirtableError(error: NodeApiError, id?: string, itemIndex?: number): NodeApiError;
export declare function legacyFlattenOutput(record: IDataObject, nodeVersion: number): IDataObject;
//# sourceMappingURL=utils.d.ts.map