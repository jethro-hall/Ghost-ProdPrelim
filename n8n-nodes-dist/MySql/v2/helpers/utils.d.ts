import type { IDataObject, IExecuteFunctions, INode, INodeExecutionData, IPairedItemData, NodeExecutionWithMetadata } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { Mysql2Pool, QueryValues, QueryWithValues, SortRule, WhereClause } from './interfaces';
export declare function escapeSqlIdentifier(identifier: string): string;
export declare const prepareQueryAndReplacements: (rawQuery: string, nodeVersion: number, replacements?: QueryValues) => QueryWithValues;
export declare const prepareQueryLegacy: (rawQuery: string, replacements: QueryValues) => QueryWithValues;
export declare function prepareErrorItem(item: IDataObject, error: IDataObject | NodeOperationError | Error, index: number): INodeExecutionData;
export declare function parseMySqlError(this: IExecuteFunctions, error: any, itemIndex?: number, queries?: string[]): NodeOperationError;
export declare function wrapData(data: IDataObject | IDataObject[]): INodeExecutionData[];
export declare function prepareOutput(response: IDataObject[], options: IDataObject, statements: string[], constructExecutionHelper: (inputData: INodeExecutionData[], options: {
    itemData: IPairedItemData | IPairedItemData[];
}) => NodeExecutionWithMetadata[], itemData: IPairedItemData | IPairedItemData[]): INodeExecutionData[];
export declare const splitQueryToStatements: (query: string, filterOutEmpty?: boolean) => string[];
export declare function configureQueryRunner(this: IExecuteFunctions, options: IDataObject, pool: Mysql2Pool): (queries: QueryWithValues[]) => Promise<INodeExecutionData[] | {
    json: {
        message: string;
        error: {
            type: string | undefined;
            node: INode;
            messages: string[];
            description: string | null | undefined;
            cause?: Error;
            errorResponse?: import("n8n-workflow").JsonObject;
            timestamp: number;
            context: IDataObject;
            lineNumber: number | undefined;
            functionality: import("n8n-workflow").Functionality;
            level: import("@n8n/errors").ErrorLevel;
            tags: NonNullable<import("@sentry/core").Event["tags"]>;
            extra?: import("@sentry/core").Event["extra"];
            packageName?: string;
            name: string;
            message: string;
            stack?: string;
        };
    };
}[]>;
export declare function addWhereClauses(node: INode, itemIndex: number, query: string, clauses: WhereClause[], replacements: QueryValues, combineConditions?: string): [string, QueryValues];
export declare function addSortRules(query: string, rules: SortRule[], replacements: QueryValues): [string, QueryValues];
export declare function replaceEmptyStringsByNulls(items: INodeExecutionData[], replace?: boolean): INodeExecutionData[];
export declare const isWhereClause: (clause: unknown) => clause is WhereClause;
export declare const getWhereClauses: (ctx: IExecuteFunctions, itemIndex: number) => WhereClause[];
//# sourceMappingURL=utils.d.ts.map