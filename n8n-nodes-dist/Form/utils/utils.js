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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isFormConnected = exports.validateResponseModeConfiguration = exports.prepareFormFields = exports.handleNewlines = void 0;
exports.sanitizeHtml = sanitizeHtml;
exports.sanitizeCustomCss = sanitizeCustomCss;
exports.validateSafeRedirectUrl = validateSafeRedirectUrl;
exports.createDescriptionMetadata = createDescriptionMetadata;
exports.prepareFormData = prepareFormData;
exports.addFormResponseDataToReturnItem = addFormResponseDataToReturnItem;
exports.prepareFormReturnItem = prepareFormReturnItem;
exports.renderForm = renderForm;
exports.formWebhook = formWebhook;
exports.resolveRawData = resolveRawData;
exports.parseFormFields = parseFormFields;
const promises_1 = require("fs/promises");
const isbot_1 = __importDefault(require("isbot"));
const luxon_1 = require("luxon");
const n8n_core_1 = require("n8n-core");
const n8n_workflow_1 = require("n8n-workflow");
const a = __importStar(require("node:assert"));
const sanitize_html_1 = __importDefault(require("sanitize-html"));
const utilities_1 = require("../../../utils/utilities");
const error_1 = require("../../Webhook/error");
const utils_1 = require("../../Webhook/utils");
const interfaces_1 = require("../interfaces");
function sanitizeHtml(text) {
    return (0, sanitize_html_1.default)(text, {
        allowedTags: [
            'b',
            'div',
            'i',
            'iframe',
            'img',
            'video',
            'source',
            'em',
            'strong',
            'a',
            'h1',
            'h2',
            'h3',
            'h4',
            'h5',
            'h6',
            'u',
            'sub',
            'sup',
            'code',
            'pre',
            'span',
            'br',
            'ul',
            'ol',
            'li',
            'p',
            'table',
            'thead',
            'tbody',
            'tfoot',
            'td',
            'tr',
            'th',
            'br',
        ],
        allowedAttributes: {
            a: ['href', 'target', 'rel'],
            img: ['src', 'alt', 'width', 'height'],
            video: ['controls', 'autoplay', 'loop', 'muted', 'poster', 'width', 'height'],
            iframe: [
                'src',
                'width',
                'height',
                'frameborder',
                'allow',
                'allowfullscreen',
                'referrerpolicy',
            ],
            source: ['src', 'type'],
            td: ['colspan', 'rowspan', 'scope', 'headers'],
            th: ['colspan', 'rowspan', 'scope', 'headers'],
        },
        allowedSchemes: ['https', 'http'],
        allowedSchemesByTag: {
            source: ['https', 'http'],
            iframe: ['https', 'http'],
        },
        allowProtocolRelative: false,
        transformTags: {
            iframe: sanitize_html_1.default.simpleTransform('iframe', {
                sandbox: '',
                referrerpolicy: 'strict-origin-when-cross-origin',
                allow: 'fullscreen; autoplay; encrypted-media',
            }),
        },
    });
}
/**
 *  Replaces `\n` strings with actual newline characters.
 *  Also replaces `\\n` strings with `\n` string
 * @param text - The text to replace newlines in
 * @returns Updated text
 */
const handleNewlines = (text) => {
    return text.replace(/\\n|\\\\n/g, (match) => (match === '\\\\n' ? '\\n' : '\n'));
};
exports.handleNewlines = handleNewlines;
const prepareFormFields = (fields) => {
    return fields.map((field) => {
        if (field.fieldType === 'html' && field.html) {
            field.html = sanitizeHtml(field.html);
        }
        if (field.fieldType === 'hiddenField') {
            field.fieldLabel = field.fieldName;
        }
        return field;
    });
};
exports.prepareFormFields = prepareFormFields;
function sanitizeCustomCss(css) {
    if (!css)
        return undefined;
    const sanitized = (0, sanitize_html_1.default)(css, {
        allowedTags: [],
        allowedAttributes: {},
    });
    // Restore only the entities needed for valid CSS after tag stripping.
    // &gt; → > is needed for CSS child combinator selectors (div > p).
    // &amp; → & is needed for CSS values, but NOT when followed by lt;/gt;/amp;
    // to prevent cascading decode of double-encoded entities.
    // &lt; is never decoded — < is not valid in CSS and would enable tag injection.
    return sanitized.replace(/&gt;/g, '>').replace(/&amp;(?!(?:lt|gt|amp);)/g, '&');
}
/**
 * Validates that a URL uses a safe scheme.
 * Returns the normalized URL if valid, or null if invalid.
 */
function validateSafeRedirectUrl(url) {
    if (!url)
        return null;
    const trimmed = url.trim();
    if (!trimmed)
        return null;
    try {
        return (0, n8n_workflow_1.tryToParseUrl)(trimmed);
    }
    catch {
        return null;
    }
}
function createDescriptionMetadata(description) {
    return description === ''
        ? 'n8n form'
        : description.replace(/^\s*\n+|<\/?[^>]+(>|$)/g, '').slice(0, 150);
}
/**
 * Gets the field identifier to use based on node version.
 * For v2.4+, uses fieldName as the primary identifier.
 * For earlier versions, falls back to fieldLabel.
 */
function getFieldIdentifier(field, nodeVersion) {
    if (nodeVersion && nodeVersion >= 2.4 && field.fieldName) {
        return field.fieldName;
    }
    return field.fieldLabel ?? field.fieldName ?? '';
}
function prepareFormData({ formTitle, formDescription, formSubmittedHeader, formSubmittedText, redirectUrl, formFields, testRun, query, instanceId, useResponseData, appendAttribution = true, buttonLabel, customCss, nodeVersion, authToken, }) {
    const utm_campaign = instanceId ? `&utm_campaign=${instanceId}` : '';
    const n8nWebsiteLink = `https://n8n.io/?utm_source=n8n-internal&utm_medium=form-trigger${utm_campaign}`;
    if (formSubmittedText === undefined) {
        formSubmittedText = 'Your response has been recorded';
    }
    const formData = {
        testRun,
        formTitle,
        formDescription,
        formDescriptionMetadata: createDescriptionMetadata(formDescription),
        formSubmittedHeader,
        formSubmittedText,
        n8nWebsiteLink,
        formFields: [],
        useResponseData,
        appendAttribution,
        buttonLabel,
        dangerousCustomCss: sanitizeCustomCss(customCss),
        authToken,
    };
    if (redirectUrl) {
        const safeUrl = validateSafeRedirectUrl(redirectUrl);
        if (safeUrl) {
            formData.redirectUrl = safeUrl;
        }
    }
    for (const [index, field] of formFields.entries()) {
        const { fieldType, requiredField, multiselect, placeholder, defaultValue } = field;
        const queryParam = getFieldIdentifier(field, nodeVersion);
        const input = {
            id: `field-${index}`,
            errorId: `error-field-${index}`,
            label: field.fieldLabel,
            inputRequired: requiredField ? 'form-required' : '',
            defaultValue: query[queryParam] ?? defaultValue ?? '',
            placeholder,
        };
        if (multiselect || (fieldType && ['radio', 'checkbox'].includes(fieldType))) {
            input.isMultiSelect = true;
            input.multiSelectOptions =
                field.fieldOptions?.values.map((e, i) => ({
                    id: `option${i}_${input.id}`,
                    label: e.option,
                })) ?? [];
            if (fieldType === 'radio') {
                input.radioSelect = 'radio';
            }
            else if (field.limitSelection === 'exact') {
                input.exactSelectedOptions = field.numberOfSelections;
            }
            else if (field.limitSelection === 'range') {
                input.minSelectedOptions = field.minSelections;
                input.maxSelectedOptions = field.maxSelections;
            }
        }
        else if (fieldType === 'file') {
            input.isFileInput = true;
            input.acceptFileTypes = field.acceptFileTypes;
            input.multipleFiles = field.multipleFiles ? 'multiple' : '';
        }
        else if (fieldType === 'dropdown') {
            input.isSelect = true;
            const fieldOptions = field.fieldOptions?.values ?? [];
            input.selectOptions = fieldOptions.map((e) => e.option);
        }
        else if (fieldType === 'textarea') {
            input.isTextarea = true;
        }
        else if (fieldType === 'html') {
            input.isHtml = true;
            input.html = field.html;
        }
        else if (fieldType === 'hiddenField') {
            input.isHidden = true;
            input.hiddenName = field.fieldName;
            input.hiddenValue =
                input.defaultValue === '' ? field.fieldValue : input.defaultValue;
        }
        else {
            input.isInput = true;
            input.type = fieldType;
        }
        formData.formFields.push(input);
    }
    return formData;
}
const validateResponseModeConfiguration = (context) => {
    const responseMode = context.getNodeParameter('responseMode', 'onReceived');
    const connectedNodes = context.getChildNodes(context.getNode().name);
    const nodeVersion = context.getNode().typeVersion;
    const isRespondToWebhookConnected = connectedNodes.some((node) => node.type === 'n8n-nodes-base.respondToWebhook');
    if (!isRespondToWebhookConnected && responseMode === 'responseNode') {
        throw new n8n_workflow_1.NodeOperationError(context.getNode(), new Error('No Respond to Webhook node found in the workflow'), {
            description: 'Insert a Respond to Webhook node to your workflow to respond to the form submission or choose another option for the “Respond When” parameter',
        });
    }
    if (isRespondToWebhookConnected && responseMode !== 'responseNode' && nodeVersion <= 2.1) {
        throw new n8n_workflow_1.WorkflowConfigurationError(context.getNode(), new Error('Unused Respond to Webhook node found in the workflow'), {
            description: 'Set the “Respond When” parameter to “Using Respond to Webhook Node” or remove the Respond to Webhook node',
        });
    }
    if (isRespondToWebhookConnected && nodeVersion > 2.1) {
        throw new n8n_workflow_1.NodeOperationError(context.getNode(), new Error('The "Respond to Webhook" node is not supported in workflows initiated by the "n8n Form Trigger"'), {
            description: 'To configure your response, add an "n8n Form" node and set the "Page Type" to "Form Ending"',
        });
    }
};
exports.validateResponseModeConfiguration = validateResponseModeConfiguration;
function addFormResponseDataToReturnItem(returnItem, formFields, bodyData, nodeVersion) {
    for (const [index, field] of formFields.entries()) {
        const key = `field-${index}`;
        const name = getFieldIdentifier(field, nodeVersion);
        let value = bodyData[key] ?? null;
        if (value === null) {
            returnItem.json[name] = null;
            continue;
        }
        if (field.fieldType === 'html') {
            if (field.elementName) {
                returnItem.json[field.elementName] = value;
            }
            continue;
        }
        if (field.fieldType === 'number') {
            value = Number(value);
        }
        if (field.fieldType === 'text') {
            value = String(value).trim();
        }
        if ((field.multiselect || field.fieldType === 'checkbox' || field.fieldType === 'radio') &&
            typeof value === 'string') {
            value = (0, n8n_workflow_1.jsonParse)(value);
            if (field.fieldType === 'radio' && Array.isArray(value)) {
                value = value[0];
            }
        }
        if (field.fieldType === 'date' && value && field.formatDate) {
            const datetime = luxon_1.DateTime.fromFormat(String(value), 'yyyy-mm-dd');
            value = datetime.toFormat(field.formatDate);
        }
        if (field.fieldType === 'file' && field.multipleFiles && !Array.isArray(value)) {
            value = [value];
        }
        returnItem.json[name] = value;
    }
}
async function prepareFormReturnItem(context, formFields, mode, useWorkflowTimezone = false) {
    const req = context.getRequestObject();
    a.ok(req.contentType === 'multipart/form-data', 'Expected multipart/form-data');
    const bodyData = context.getBodyData().data ?? {};
    const files = context.getBodyData().files ?? {};
    const { binaryMode } = context.getWorkflowSettings();
    const returnItem = {
        json: {},
    };
    if (files && Object.keys(files).length) {
        returnItem.binary = {};
    }
    for (const key of Object.keys(files)) {
        const processFiles = [];
        let multiFile = false;
        const filesInput = files[key];
        if (Array.isArray(filesInput)) {
            bodyData[key] =
                binaryMode === n8n_workflow_1.BINARY_MODE_COMBINED
                    ? []
                    : filesInput.map((file) => ({
                        filename: file.originalFilename,
                        mimetype: file.mimetype,
                        size: file.size,
                    }));
            processFiles.push(...filesInput);
            multiFile = true;
        }
        else {
            bodyData[key] =
                binaryMode === n8n_workflow_1.BINARY_MODE_COMBINED
                    ? {}
                    : {
                        filename: filesInput.originalFilename,
                        mimetype: filesInput.mimetype,
                        size: filesInput.size,
                    };
            processFiles.push(filesInput);
        }
        const entryIndex = Number(key.replace(/field-/g, ''));
        const field = isNaN(entryIndex) ? null : formFields[entryIndex];
        const fieldLabel = field ? getFieldIdentifier(field, context.getNode().typeVersion) : key;
        let fileCount = 0;
        for (const file of processFiles) {
            const binaryData = await context.nodeHelpers.copyBinaryFile(file.filepath, file.originalFilename ?? file.newFilename, file.mimetype);
            if (binaryMode === n8n_workflow_1.BINARY_MODE_COMBINED) {
                if (Array.isArray(bodyData[key])) {
                    bodyData[key].push(binaryData);
                }
                else {
                    bodyData[key] = binaryData;
                }
            }
            else {
                let binaryPropertyName = fieldLabel.replace(/\W/g, '_');
                if (multiFile) {
                    binaryPropertyName += `_${fileCount++}`;
                }
                returnItem.binary[binaryPropertyName] = binaryData;
            }
            // Delete original file to prevent tmp directory from growing too large
            await (0, promises_1.rm)(file.filepath, { force: true });
        }
    }
    addFormResponseDataToReturnItem(returnItem, formFields, bodyData, context.getNode().typeVersion);
    const timezone = useWorkflowTimezone ? context.getTimezone() : 'UTC';
    returnItem.json.submittedAt = luxon_1.DateTime.now().setZone(timezone).toISO();
    returnItem.json.formMode = mode;
    if (context.getNode().type === n8n_workflow_1.FORM_TRIGGER_NODE_TYPE &&
        Object.keys(context.getRequestObject().query || {}).length) {
        returnItem.json.formQueryParameters = context.getRequestObject().query;
    }
    return returnItem;
}
function renderForm({ context, res, formTitle, formDescription, formFields, responseMode, mode, formSubmittedText, redirectUrl, appendAttribution, buttonLabel, customCss, authToken, }) {
    const instanceId = context.getInstanceId();
    const useResponseData = responseMode === 'responseNode';
    let query = {};
    if (context.getNode().type === n8n_workflow_1.FORM_TRIGGER_NODE_TYPE) {
        query = context.getRequestObject().query;
    }
    else if (context.getNode().type === n8n_workflow_1.FORM_NODE_TYPE) {
        const parentNodes = context.getParentNodes(context.getNode().name);
        const trigger = parentNodes.find((node) => node.type === n8n_workflow_1.FORM_TRIGGER_NODE_TYPE);
        try {
            const triggerQueryParameters = context.evaluateExpression(`{{ $('${trigger?.name}').first().json.formQueryParameters }}`);
            if (triggerQueryParameters) {
                query = triggerQueryParameters;
            }
        }
        catch (error) { }
    }
    formFields = (0, exports.prepareFormFields)(formFields);
    const data = prepareFormData({
        formTitle,
        formDescription,
        formSubmittedText,
        redirectUrl,
        formFields,
        testRun: mode === 'test',
        query,
        instanceId,
        useResponseData,
        appendAttribution,
        buttonLabel,
        customCss,
        nodeVersion: context.getNode().typeVersion,
        authToken,
    });
    if (!(0, n8n_core_1.isFormHtmlSandboxingDisabled)()) {
        res.setHeader('Content-Security-Policy', (0, n8n_core_1.getHtmlSandboxCSP)());
    }
    res.render('form-trigger', data);
}
const isFormConnected = (nodes) => {
    return nodes.some((n) => n.type === n8n_workflow_1.FORM_NODE_TYPE || (n.type === n8n_workflow_1.WAIT_NODE_TYPE && n.parameters?.resume === 'form'));
};
exports.isFormConnected = isFormConnected;
async function formWebhook(context, authProperty = interfaces_1.FORM_TRIGGER_AUTHENTICATION_PROPERTY) {
    const node = context.getNode();
    const options = context.getNodeParameter('options', {});
    const res = context.getResponseObject();
    const req = context.getRequestObject();
    // Check IP allowlist first (before bot detection and authentication)
    if (!(0, utils_1.isIpAllowed)(options.ipWhitelist, req.ips, req.ip)) {
        res.writeHead(403);
        res.end('IP is not allowed to access this form!');
        return { noWebhookResponse: true };
    }
    try {
        if (options.ignoreBots && (0, isbot_1.default)(req.headers['user-agent'])) {
            throw new error_1.WebhookAuthorizationError(403);
        }
        if (node.typeVersion > 1) {
            await (0, utils_1.validateWebhookAuthentication)(context, authProperty);
        }
    }
    catch (error) {
        if (error instanceof error_1.WebhookAuthorizationError) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Enter credentials"');
            res.status(401).send();
            return { noWebhookResponse: true };
        }
        throw error;
    }
    const mode = context.getMode() === 'manual' ? 'test' : 'production';
    const formFields = context.getNodeParameter('formFields.values', []);
    const method = context.getRequestObject().method;
    (0, exports.validateResponseModeConfiguration)(context);
    //Show the form on GET request
    if (method === 'GET') {
        const formTitle = context.getNodeParameter('formTitle', '');
        const formDescription = (0, exports.handleNewlines)(sanitizeHtml(context.getNodeParameter('formDescription', '')));
        let responseMode = context.getNodeParameter('responseMode', '');
        let formSubmittedText;
        let redirectUrl;
        let appendAttribution = true;
        if (options.respondWithOptions) {
            const values = options.respondWithOptions.values;
            if (values.respondWith === 'text') {
                formSubmittedText = values.formSubmittedText;
            }
            if (values.respondWith === 'redirect') {
                redirectUrl = values.redirectUrl;
            }
        }
        else {
            formSubmittedText = options.formSubmittedText;
        }
        if (options.appendAttribution === false) {
            appendAttribution = false;
        }
        let buttonLabel = 'Submit';
        if (options.buttonLabel) {
            buttonLabel = options.buttonLabel;
        }
        const connectedNodes = context.getChildNodes(context.getNode().name, {
            includeNodeParameters: true,
        });
        const hasNextPage = (0, exports.isFormConnected)(connectedNodes);
        if (hasNextPage) {
            redirectUrl = undefined;
            responseMode = 'responseNode';
        }
        let authToken;
        if (node.typeVersion > 1) {
            authToken = await (0, utils_1.generateFormPostBasicAuthToken)(context, authProperty);
        }
        renderForm({
            context,
            res,
            formTitle,
            formDescription,
            formFields,
            responseMode,
            mode,
            formSubmittedText,
            redirectUrl,
            appendAttribution,
            buttonLabel,
            customCss: options.customCss,
            authToken,
        });
        return {
            noWebhookResponse: true,
        };
    }
    let { useWorkflowTimezone } = options;
    if (useWorkflowTimezone === undefined && node.typeVersion > 2) {
        useWorkflowTimezone = true;
    }
    const returnItem = await prepareFormReturnItem(context, formFields, mode, useWorkflowTimezone);
    return {
        webhookResponse: { status: 200 },
        workflowData: [[returnItem]],
    };
}
function resolveRawData(context, rawData) {
    const resolvables = (0, utilities_1.getResolvables)(rawData);
    let returnData = rawData;
    if (returnData.startsWith('=')) {
        returnData = returnData.replace(/^=+/, '');
    }
    else {
        return returnData;
    }
    if (resolvables.length) {
        for (const resolvable of resolvables) {
            const resolvedValue = context.evaluateExpression(`${resolvable}`);
            if (typeof resolvedValue === 'object' && resolvedValue !== null) {
                returnData = returnData.replace(resolvable, JSON.stringify(resolvedValue));
            }
            else {
                returnData = returnData.replace(resolvable, resolvedValue);
            }
        }
    }
    return returnData;
}
function parseFormFields(context, options) {
    let fields = [];
    if (options.defineForm === 'json') {
        try {
            const jsonOutput = context.getNodeParameter(options.fieldsParameterName, '', {
                rawExpressions: true,
            });
            fields = (0, n8n_workflow_1.tryToParseJsonToFormFields)(resolveRawData(context, jsonOutput));
        }
        catch (error) {
            throw new n8n_workflow_1.NodeOperationError(context.getNode(), error.message, {
                description: error.message,
                type: options.mode === 'test' ? 'manual-form-test' : undefined,
            });
        }
    }
    else {
        fields = context.getNodeParameter(options.fieldsParameterName, []);
        for (const field of fields) {
            if (field.fieldType === 'html') {
                let html = field.html ?? '';
                for (const resolvable of (0, utilities_1.getResolvables)(html)) {
                    html = html.replace(resolvable, context.evaluateExpression(resolvable));
                }
                field.html = html;
            }
        }
    }
    return fields;
}
//# sourceMappingURL=utils.js.map