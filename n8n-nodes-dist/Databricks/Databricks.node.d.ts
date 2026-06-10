import { type IExecuteFunctions, type INodeExecutionData, type INodeType, type INodeTypeDescription } from 'n8n-workflow';
import * as listSearch from './methods/listSearch';
export declare class Databricks implements INodeType {
    description: INodeTypeDescription;
    methods: {
        listSearch: typeof listSearch;
    };
    execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]>;
}
//# sourceMappingURL=Databricks.node.d.ts.map