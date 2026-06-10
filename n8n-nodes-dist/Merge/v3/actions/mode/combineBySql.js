"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.description = exports.properties = void 0;
exports.execute = execute;
const di_1 = require("@n8n/di");
const n8n_core_1 = require("n8n-core");
const n8n_workflow_1 = require("n8n-workflow");
const utilities_1 = require("../../../../../utils/utilities");
const descriptions_1 = require("../../helpers/descriptions");
const utils_1 = require("../../helpers/utils");
const sandbox_utils_1 = require("../../helpers/sandbox-utils");
exports.properties = [
    descriptions_1.numberInputsProperty,
    {
        displayName: 'Query',
        name: 'query',
        type: 'string',
        default: 'SELECT * FROM input1 LEFT JOIN input2 ON input1.name = input2.id',
        noDataExpression: true,
        description: 'Input data available as tables with corresponding number, e.g. input1, input2',
        hint: 'Supports <a href="https://github.com/alasql/alasql/wiki/Supported-SQL-statements" target="_blank">most</a> of the SQL-99 language',
        required: true,
        typeOptions: {
            rows: 5,
            editor: 'sqlEditor',
        },
    },
    {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add option',
        default: {},
        options: [
            {
                displayName: 'Empty Query Result',
                name: 'emptyQueryResult',
                type: 'options',
                description: 'What to return if the query executed successfully but returned no results',
                options: [
                    {
                        name: 'Success',
                        value: 'success',
                    },
                    {
                        name: 'Empty Result',
                        value: 'empty',
                    },
                ],
                default: 'empty',
            },
        ],
        displayOptions: {
            show: {
                '@version': [3.2],
            },
        },
    },
];
const displayOptions = {
    show: {
        mode: ['combineBySql'],
    },
};
exports.description = (0, utilities_1.updateDisplayOptions)(displayOptions, exports.properties);
const prepareError = (node, error) => {
    let message = '';
    if (typeof error === 'string') {
        message = error;
    }
    else {
        message = error.message;
    }
    throw new n8n_workflow_1.NodeOperationError(node, error, {
        message: 'Issue while executing query',
        description: message,
        itemIndex: 0,
    });
};
async function executeSelectWithMappedPairedItems(node, inputsData, query, returnSuccessItemIfEmpty, context) {
    const returnData = [];
    const tableData = inputsData.map((inputData) => inputData.map((entry) => ({ ...entry.json, pairedItem: entry.pairedItem })));
    try {
        const result = await (0, sandbox_utils_1.runAlaSqlInSandbox)(context, tableData, (0, utils_1.modifySelectQuery)(query, inputsData.length));
        for (const item of result) {
            if (Array.isArray(item)) {
                returnData.push.apply(returnData, item.map(utils_1.rowToExecutionData));
            }
            else if (typeof item === 'object') {
                returnData.push((0, utils_1.rowToExecutionData)(item));
            }
        }
        if (!returnData.length && returnSuccessItemIfEmpty) {
            returnData.push({ json: { success: true } });
        }
    }
    catch (error) {
        prepareError(node, error);
    }
    return [returnData];
}
async function execute(inputsData) {
    const node = this.getNode();
    const returnData = [];
    const pairedItem = [];
    const options = this.getNodeParameter('options', 0, {});
    const workflowId = this.getWorkflow().id;
    let query = this.getNodeParameter('query', 0);
    for (const resolvable of (0, utilities_1.getResolvables)(query)) {
        query = query.replace(resolvable, this.evaluateExpression(resolvable, 0));
    }
    const context = await (0, sandbox_utils_1.loadAlaSqlSandbox)();
    const isSelectQuery = node.typeVersion >= 3.1 ? query.toLowerCase().startsWith('select') : false;
    const returnSuccessItemIfEmpty = node.typeVersion <= 3.1 ? true : options.emptyQueryResult === 'success';
    if (isSelectQuery) {
        try {
            return await executeSelectWithMappedPairedItems(node, inputsData, query, returnSuccessItemIfEmpty, context);
        }
        catch (error) {
            di_1.Container.get(n8n_core_1.ErrorReporter).error(error, {
                extra: {
                    nodeName: node.name,
                    nodeType: node.type,
                    nodeVersion: node.typeVersion,
                    workflowId,
                },
            });
        }
    }
    for (let i = 0; i < inputsData.length; i++) {
        const inputData = inputsData[i];
        inputData.forEach((item, index) => {
            if (item.pairedItem === undefined) {
                item.pairedItem = index;
            }
            if (typeof item.pairedItem === 'number') {
                pairedItem.push({
                    item: item.pairedItem,
                    input: i,
                });
                return;
            }
            if (Array.isArray(item.pairedItem)) {
                const pairedItems = item.pairedItem
                    .filter((p) => p !== undefined)
                    .map((p) => (typeof p === 'number' ? { item: p } : p))
                    .map((p) => {
                    return {
                        item: p.item,
                        input: i,
                    };
                });
                pairedItem.push.apply(pairedItem, pairedItems);
                return;
            }
            pairedItem.push({
                item: item.pairedItem.item,
                input: i,
            });
        });
    }
    const tableData = inputsData.map((inputData) => inputData.map((entry) => entry.json));
    try {
        const result = await (0, sandbox_utils_1.runAlaSqlInSandbox)(context, tableData, query);
        for (const item of result) {
            if (Array.isArray(item)) {
                returnData.push.apply(returnData, item.map((json) => ({ json, pairedItem })));
            }
            else if (typeof item === 'object') {
                returnData.push({ json: item, pairedItem });
            }
        }
        if (!returnData.length && returnSuccessItemIfEmpty) {
            returnData.push({ json: { success: true }, pairedItem });
        }
    }
    catch (error) {
        prepareError(node, error);
    }
    return [returnData];
}
//# sourceMappingURL=combineBySql.js.map