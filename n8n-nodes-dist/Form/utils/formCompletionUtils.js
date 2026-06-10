"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.renderFormCompletion = exports.binaryResponse = void 0;
const n8n_core_1 = require("n8n-core");
const n8n_workflow_1 = require("n8n-workflow");
const utils_1 = require("./utils");
const getBinaryDataFromNode = (context, nodeName) => {
    return context.evaluateExpression(`{{ $('${nodeName}').first().binary }}`);
};
const binaryResponse = async (context) => {
    const inputDataFieldName = context.getNodeParameter('inputDataFieldName', '');
    const parentNodes = context.getParentNodes(context.getNode().name);
    const binaryNode = parentNodes
        .reverse()
        .find((node) => getBinaryDataFromNode(context, node?.name)?.hasOwnProperty(inputDataFieldName));
    if (!binaryNode) {
        throw new n8n_workflow_1.OperationalError(`No binary data with field ${inputDataFieldName} found.`);
    }
    const binaryData = getBinaryDataFromNode(context, binaryNode?.name)[inputDataFieldName];
    return {
        // If a binaryData has an id, the following field is set:
        // N8N_DEFAULT_BINARY_DATA_MODE=filesystem
        data: binaryData.id
            ? await context.helpers.binaryToBuffer(await context.helpers.getBinaryStream(binaryData.id))
            : atob(binaryData.data),
        fileName: binaryData.fileName ?? 'file',
        type: binaryData.mimeType,
    };
};
exports.binaryResponse = binaryResponse;
const renderFormCompletion = async (context, res, trigger) => {
    const completionTitle = context.getNodeParameter('completionTitle', '');
    const completionMessage = (0, utils_1.handleNewlines)((0, utils_1.sanitizeHtml)(context.getNodeParameter('completionMessage', '')));
    const redirectUrl = context.getNodeParameter('redirectUrl', '');
    const options = context.getNodeParameter('options', {});
    const responseText = context.getNodeParameter('responseText', '') ?? '';
    const respondWith = context.getNodeParameter('respondWith', '');
    const binary = respondWith === 'returnBinary' ? await (0, exports.binaryResponse)(context) : '';
    let title = options.formTitle;
    if (!title) {
        title = context.evaluateExpression(`{{ $('${trigger?.name}').params.formTitle }}`);
    }
    const appendAttribution = context.evaluateExpression(`{{ $('${trigger?.name}').params.options?.appendAttribution === false ? false : true }}`);
    if (respondWith !== 'redirect' && !(0, n8n_core_1.isFormHtmlSandboxingDisabled)()) {
        res.setHeader('Content-Security-Policy', (0, n8n_core_1.getHtmlSandboxCSP)());
    }
    res.render('form-trigger-completion', {
        title: completionTitle,
        message: completionMessage,
        formTitle: title,
        appendAttribution,
        responseText,
        responseBinary: encodeURIComponent(JSON.stringify(binary)),
        dangerousCustomCss: (0, utils_1.sanitizeCustomCss)(options.customCss),
        redirectUrl: (0, utils_1.validateSafeRedirectUrl)(redirectUrl) ?? undefined,
    });
    return { noWebhookResponse: true };
};
exports.renderFormCompletion = renderFormCompletion;
//# sourceMappingURL=formCompletionUtils.js.map