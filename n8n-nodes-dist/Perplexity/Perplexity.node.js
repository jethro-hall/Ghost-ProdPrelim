"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Perplexity = void 0;
const n8n_workflow_1 = require("n8n-workflow");
const descriptions_1 = require("./descriptions");
const GenericFunctions_1 = require("./GenericFunctions");
class Perplexity {
    description = {
        displayName: 'Perplexity',
        name: 'perplexity',
        icon: {
            light: 'file:perplexity.svg',
            dark: 'file:perplexity.dark.svg',
        },
        group: ['transform'],
        version: [1, 2],
        defaultVersion: 2,
        subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
        description: 'AI-powered answer engine that provides accurate, trusted, and real-time answers to any question. Supports chat completions, agent responses, web search, and embeddings.',
        defaults: {
            name: 'Perplexity',
        },
        inputs: [n8n_workflow_1.NodeConnectionTypes.Main],
        outputs: [n8n_workflow_1.NodeConnectionTypes.Main],
        usableAsTool: true,
        credentials: [
            {
                name: 'perplexityApi',
                required: true,
            },
        ],
        requestDefaults: {
            baseURL: 'https://api.perplexity.ai',
            ignoreHttpStatusErrors: true,
        },
        properties: [
            // V1: hidden resource selector (only chat)
            {
                displayName: 'Resource',
                name: 'resource',
                type: 'hidden',
                noDataExpression: true,
                options: [
                    {
                        name: 'Chat',
                        value: 'chat',
                    },
                ],
                default: 'chat',
                displayOptions: {
                    show: {
                        '@version': [1],
                    },
                },
            },
            // V2: visible resource selector (all resources)
            {
                displayName: 'Resource',
                name: 'resource',
                type: 'options',
                noDataExpression: true,
                options: [
                    {
                        name: 'Agent',
                        value: 'agent',
                        description: 'Create responses using the Agent API with third-party models, presets, tools, and structured outputs',
                    },
                    {
                        name: 'Chat',
                        value: 'chat',
                        description: 'Send messages using Sonar models with built-in web search',
                    },
                    {
                        name: 'Embedding',
                        value: 'embedding',
                        description: 'Generate vector embeddings for text',
                    },
                    {
                        name: 'Search',
                        value: 'search',
                        description: 'Get raw, ranked web search results',
                    },
                ],
                default: 'chat',
                displayOptions: {
                    show: {
                        '@version': [2],
                    },
                },
            },
            ...descriptions_1.agent.description,
            ...descriptions_1.chat.description,
            ...descriptions_1.embeddings.description,
            ...descriptions_1.search.description,
        ],
    };
    methods = {
        listSearch: {
            getAgentModels: GenericFunctions_1.getAgentModels,
        },
    };
}
exports.Perplexity = Perplexity;
//# sourceMappingURL=Perplexity.node.js.map