"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TableFieldMapper = exports.toOptions = void 0;
exports.baserowApiRequest = baserowApiRequest;
exports.baserowApiRequestAllItems = baserowApiRequestAllItems;
exports.getFieldNamesAndIds = getFieldNamesAndIds;
const n8n_workflow_1 = require("n8n-workflow");
/**
 * Make a request to Baserow API.
 */
async function baserowApiRequest(method, endpoint, credentialType, body = {}, qs = {}) {
    const credentials = await this.getCredentials(credentialType);
    const host = credentials.host.replace(/\/$/, '');
    const options = {
        method,
        body,
        qs,
        uri: `${host}${endpoint}`,
        json: true,
    };
    if (Object.keys(qs).length === 0) {
        delete options.qs;
    }
    if (Object.keys(body).length === 0) {
        delete options.body;
    }
    try {
        return await this.helpers.requestWithAuthentication.call(this, credentialType, options);
    }
    catch (error) {
        throw new n8n_workflow_1.NodeApiError(this.getNode(), error);
    }
}
/**
 * Get all results from a paginated query to Baserow API.
 */
async function baserowApiRequestAllItems(method, endpoint, credentialType, body, qs = {}) {
    const returnData = [];
    let responseData;
    qs.page = 1;
    qs.size = 100;
    const returnAll = this.getNodeParameter('returnAll', 0, false);
    const limit = this.getNodeParameter('limit', 0, 0);
    do {
        responseData = await baserowApiRequest.call(this, method, endpoint, credentialType, body, qs);
        returnData.push.apply(returnData, responseData.results);
        if (!returnAll && returnData.length > limit) {
            return returnData.slice(0, limit);
        }
        qs.page += 1;
    } while (responseData.next !== null);
    return returnData;
}
async function getFieldNamesAndIds(tableId, credentialType) {
    const endpoint = `/api/database/fields/table/${tableId}/`;
    const response = (await baserowApiRequest.call(this, 'GET', endpoint, credentialType));
    return {
        names: response.map((field) => field.name),
        ids: response.map((field) => `field_${field.id}`),
    };
}
const toOptions = (items) => items.map(({ name, id }) => ({ name, value: id }));
exports.toOptions = toOptions;
/**
 * Responsible for mapping field IDs `field_n` to names and vice versa.
 */
class TableFieldMapper {
    nameToIdMapping = {};
    idToNameMapping = {};
    mapIds = true;
    async getTableFields(table, credentialType) {
        const endpoint = `/api/database/fields/table/${table}/`;
        return await baserowApiRequest.call(this, 'GET', endpoint, credentialType);
    }
    createMappings(tableFields) {
        this.nameToIdMapping = this.createNameToIdMapping(tableFields);
        this.idToNameMapping = this.createIdToNameMapping(tableFields);
    }
    createIdToNameMapping(responseData) {
        return responseData.reduce((acc, cur) => {
            acc[`field_${cur.id}`] = cur.name;
            return acc;
        }, {});
    }
    createNameToIdMapping(responseData) {
        return responseData.reduce((acc, cur) => {
            acc[cur.name] = `field_${cur.id}`;
            return acc;
        }, {});
    }
    setField(field) {
        return this.mapIds ? field : (this.nameToIdMapping[field] ?? field);
    }
    idsToNames(obj) {
        Object.entries(obj).forEach(([key, value]) => {
            if (this.idToNameMapping[key] !== undefined) {
                delete obj[key];
                obj[this.idToNameMapping[key]] = value;
            }
        });
    }
    namesToIds(obj) {
        Object.entries(obj).forEach(([key, value]) => {
            if (this.nameToIdMapping[key] !== undefined) {
                delete obj[key];
                obj[this.nameToIdMapping[key]] = value;
            }
        });
    }
}
exports.TableFieldMapper = TableFieldMapper;
//# sourceMappingURL=GenericFunctions.js.map