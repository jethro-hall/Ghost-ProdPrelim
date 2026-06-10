import type { INodeType, INodeTypeDescription } from 'n8n-workflow';
import { getAgentModels } from './GenericFunctions';
export declare class Perplexity implements INodeType {
    description: INodeTypeDescription;
    methods: {
        listSearch: {
            getAgentModels: typeof getAgentModels;
        };
    };
}
//# sourceMappingURL=Perplexity.node.d.ts.map