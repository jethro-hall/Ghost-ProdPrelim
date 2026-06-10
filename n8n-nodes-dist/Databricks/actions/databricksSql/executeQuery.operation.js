"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.execute = execute;
const n8n_workflow_1 = require("n8n-workflow");
const helpers_1 = require("../helpers");
async function execute(i) {
    const credentialType = (0, helpers_1.getActiveCredentialType)(this, i);
    const host = await (0, helpers_1.getHost)(this, credentialType);
    const warehouseId = (0, helpers_1.extractResourceLocatorValue)(this.getNodeParameter('warehouseId', i));
    const query = this.getNodeParameter('query', i);
    const rawParams = this.getNodeParameter('queryParameters.parameters', i, []);
    const parameters = rawParams.map(({ name, value, type }) => type ? { name, value, type } : { name, value });
    // Step 1: Execute the query.
    // wait_timeout is set to the API maximum (50s) so that short queries return
    // results synchronously in this single request — no polling required.
    // For queries that exceed 50s, on_wait_timeout=CONTINUE puts the statement
    // in async mode and Step 2 polls until it finishes.
    // See: https://docs.databricks.com/api/workspace/statementexecution/executestatement#wait_timeout
    const executeResponse = (await this.helpers.httpRequestWithAuthentication.call(this, credentialType, {
        method: 'POST',
        url: `${host}/api/2.0/sql/statements`,
        body: {
            warehouse_id: warehouseId,
            statement: query,
            wait_timeout: '50s',
            on_wait_timeout: 'CONTINUE',
            ...(parameters.length > 0 && { parameters }),
        },
        headers: { 'Content-Type': 'application/json' },
        json: true,
    }));
    const statementId = executeResponse.statement_id;
    // Step 2: Poll for completion (if in async mode)
    let status = executeResponse.status.state;
    let queryResult = executeResponse;
    const maxRetries = 60; // Max 5 minutes (60 * 5 seconds)
    let retries = 0;
    while (status !== 'SUCCEEDED' &&
        status !== 'FAILED' &&
        status !== 'CANCELED' &&
        retries < maxRetries) {
        await (0, n8n_workflow_1.sleep)(5000);
        queryResult = (await this.helpers.httpRequestWithAuthentication.call(this, credentialType, {
            method: 'GET',
            url: `${host}/api/2.0/sql/statements/${statementId}`,
            headers: { Accept: 'application/json' },
            json: true,
        }));
        status = queryResult.status.state;
        retries++;
    }
    if (status === 'FAILED' || status === 'CANCELED') {
        throw new n8n_workflow_1.NodeOperationError(this.getNode(), `Query ${status.toLowerCase()}: ${JSON.stringify(queryResult.status)}`, { itemIndex: i });
    }
    if (retries >= maxRetries) {
        throw new n8n_workflow_1.NodeOperationError(this.getNode(), 'Query execution timeout - exceeded maximum wait time', { itemIndex: i });
    }
    // Step 3: Collect all chunks
    const allRows = [];
    let chunkIndex = 0;
    const totalChunks = queryResult.manifest?.total_chunk_count || 0;
    if (queryResult.result?.data_array) {
        for (const row of queryResult.result.data_array) {
            allRows.push(row);
        }
        chunkIndex = 1;
    }
    while (chunkIndex < totalChunks) {
        const chunkResponse = (await this.helpers.httpRequestWithAuthentication.call(this, credentialType, {
            method: 'GET',
            url: `${host}/api/2.0/sql/statements/${statementId}/result/chunks/${chunkIndex}`,
            headers: { Accept: 'application/json' },
            json: true,
        }));
        if (chunkResponse.data_array) {
            for (const row of chunkResponse.data_array) {
                allRows.push(row);
            }
        }
        chunkIndex++;
    }
    // Step 4: Transform rows into objects using column names
    const columns = queryResult.manifest?.schema?.columns || [];
    const returnData = allRows.map((row) => {
        const obj = {};
        columns.forEach((col, idx) => {
            obj[col.name] = row[idx];
        });
        return { json: obj, pairedItem: { item: i } };
    });
    return returnData;
}
//# sourceMappingURL=executeQuery.operation.js.map