"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.execute = execute;
const helpers_1 = require("../helpers");
async function execute(i) {
    const credentialType = (0, helpers_1.getActiveCredentialType)(this, i);
    const host = await (0, helpers_1.getHost)(this, credentialType);
    const spaceId = this.getNodeParameter('spaceId', i);
    const conversationId = this.getNodeParameter('conversationId', i);
    const response = await this.helpers.httpRequestWithAuthentication.call(this, credentialType, {
        method: 'POST',
        url: `${host}/api/2.0/genie/spaces/${spaceId}/conversations/${conversationId}/messages`,
        body: { content: this.getNodeParameter('message', i) },
        headers: { 'Content-Type': 'application/json' },
        json: true,
    });
    return [{ json: response, pairedItem: { item: i } }];
}
//# sourceMappingURL=createMessage.operation.js.map