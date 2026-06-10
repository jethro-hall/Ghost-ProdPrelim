"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWarehouses = getWarehouses;
exports.getEndpoints = getEndpoints;
exports.getCatalogs = getCatalogs;
exports.getSchemas = getSchemas;
exports.getVolumes = getVolumes;
exports.getTables = getTables;
exports.getFunctions = getFunctions;
const helpers_1 = require("../actions/helpers");
async function getWarehouses(filter) {
    const credentialType = (0, helpers_1.getActiveCredentialType)(this);
    const host = await (0, helpers_1.getHost)(this, credentialType);
    const response = (await this.helpers.httpRequestWithAuthentication.call(this, credentialType, {
        method: 'GET',
        url: `${host}/api/2.0/sql/warehouses`,
        headers: { Accept: 'application/json' },
        json: true,
    }));
    const warehouses = response.warehouses ?? [];
    const allResults = warehouses.map((warehouse) => ({
        name: warehouse.name,
        value: warehouse.id,
        url: `${host}/sql/warehouses/${warehouse.id}`,
    }));
    if (filter) {
        const filterLower = filter.toLowerCase();
        return { results: allResults.filter((r) => r.name.toLowerCase().includes(filterLower)) };
    }
    return { results: allResults };
}
async function getEndpoints(filter) {
    const credentialType = (0, helpers_1.getActiveCredentialType)(this);
    const host = await (0, helpers_1.getHost)(this, credentialType);
    const response = (await this.helpers.httpRequestWithAuthentication.call(this, credentialType, {
        method: 'GET',
        url: `${host}/api/2.0/serving-endpoints`,
        headers: { Accept: 'application/json' },
        json: true,
    }));
    const endpoints = response.endpoints ?? [];
    const allResults = endpoints.map((endpoint) => {
        const modelNames = (endpoint.config?.served_entities || [])
            .map((entity) => entity.external_model?.name || entity.foundation_model?.name)
            .filter(Boolean)
            .join(', ');
        return {
            name: endpoint.name,
            value: endpoint.name,
            url: `${host}/ml/endpoints/${endpoint.name}`,
            description: modelNames || 'Model serving endpoint',
        };
    });
    if (filter) {
        const filterLower = filter.toLowerCase();
        return {
            results: allResults.filter((r) => r.name.toLowerCase().includes(filterLower) ||
                r.description?.toLowerCase().includes(filterLower)),
        };
    }
    return { results: allResults };
}
async function getCatalogs(filter) {
    const credentialType = (0, helpers_1.getActiveCredentialType)(this);
    const host = await (0, helpers_1.getHost)(this, credentialType);
    const response = (await this.helpers.httpRequestWithAuthentication.call(this, credentialType, {
        method: 'GET',
        url: `${host}/api/2.1/unity-catalog/catalogs`,
        headers: { Accept: 'application/json' },
        json: true,
    }));
    const catalogs = response.catalogs ?? [];
    const allResults = catalogs.map((catalog) => ({
        name: catalog.name,
        value: catalog.name,
        url: `${host}/explore/data/${catalog.name}`,
    }));
    if (filter) {
        const filterLower = filter.toLowerCase();
        return { results: allResults.filter((r) => r.name.toLowerCase().includes(filterLower)) };
    }
    return { results: allResults };
}
async function getSchemas(filter) {
    const credentialType = (0, helpers_1.getActiveCredentialType)(this);
    const host = await (0, helpers_1.getHost)(this, credentialType);
    let selectedCatalog;
    try {
        selectedCatalog =
            (0, helpers_1.extractResourceLocatorValue)(this.getCurrentNodeParameter('catalogName')) ||
                undefined;
    }
    catch (e) {
        selectedCatalog = undefined;
    }
    if (!selectedCatalog) {
        return { results: [{ name: 'Please Select a Catalog First', value: '' }] };
    }
    try {
        const schemasResponse = (await this.helpers.httpRequestWithAuthentication.call(this, credentialType, {
            method: 'GET',
            url: `${host}/api/2.1/unity-catalog/schemas?catalog_name=${selectedCatalog}`,
            headers: { Accept: 'application/json' },
            json: true,
        }));
        const schemas = schemasResponse.schemas ?? [];
        const allSchemas = schemas.map((schema) => ({
            name: schema.name,
            value: schema.name,
            url: `${host}/explore/data/${selectedCatalog}/${schema.name}`,
        }));
        if (filter) {
            const filterLower = filter.toLowerCase();
            return { results: allSchemas.filter((r) => r.name.toLowerCase().includes(filterLower)) };
        }
        return { results: allSchemas };
    }
    catch (e) {
        return {
            results: [{ name: `Error loading schemas for catalog: ${selectedCatalog}`, value: '' }],
        };
    }
}
async function fetchResourcesInSchema(context, credentialType, host, apiPath, catalogName, schemaName, responseKey) {
    const response = (await context.helpers.httpRequestWithAuthentication.call(context, credentialType, {
        method: 'GET',
        url: `${host}${apiPath}?catalog_name=${catalogName}&schema_name=${schemaName}`,
        headers: { Accept: 'application/json' },
        json: true,
    }));
    return response[responseKey] ?? [];
}
function getSelectedCatalogAndSchema(context) {
    let selectedCatalog;
    let selectedSchema;
    try {
        selectedCatalog =
            (0, helpers_1.extractResourceLocatorValue)(context.getCurrentNodeParameter('catalogName')) ||
                undefined;
        selectedSchema =
            (0, helpers_1.extractResourceLocatorValue)(context.getCurrentNodeParameter('schemaName')) ||
                undefined;
    }
    catch (e) {
        // Parameters may not be available in all contexts
    }
    return { selectedCatalog, selectedSchema };
}
async function getVolumes(filter) {
    const credentialType = (0, helpers_1.getActiveCredentialType)(this);
    const host = await (0, helpers_1.getHost)(this, credentialType);
    const { selectedCatalog, selectedSchema } = getSelectedCatalogAndSchema(this);
    if (!selectedCatalog) {
        return { results: [{ name: 'Please Select a Catalog First', value: '' }] };
    }
    if (!selectedSchema) {
        return { results: [{ name: 'Please Select a Schema First', value: '' }] };
    }
    try {
        const volumes = await fetchResourcesInSchema(this, credentialType, host, '/api/2.1/unity-catalog/volumes', selectedCatalog, selectedSchema, 'volumes');
        const allResults = volumes.map((volume) => {
            const fullPath = `${selectedCatalog}.${selectedSchema}.${volume.name}`;
            return {
                name: fullPath,
                value: fullPath,
                description: `${selectedCatalog} / ${selectedSchema}${volume.volume_type ? ` (${volume.volume_type})` : ''}`,
                url: `${host}/explore/data/${selectedCatalog}/${selectedSchema}/${volume.name}`,
            };
        });
        if (filter) {
            const filterLower = filter.toLowerCase();
            return {
                results: allResults.filter((r) => r.name.toLowerCase().includes(filterLower) ||
                    r.description.toLowerCase().includes(filterLower)),
            };
        }
        return { results: allResults };
    }
    catch (e) {
        return {
            results: [
                { name: `Error loading volumes for ${selectedCatalog}.${selectedSchema}`, value: '' },
            ],
        };
    }
}
async function getTables(filter) {
    const credentialType = (0, helpers_1.getActiveCredentialType)(this);
    const host = await (0, helpers_1.getHost)(this, credentialType);
    const { selectedCatalog, selectedSchema } = getSelectedCatalogAndSchema(this);
    if (!selectedCatalog) {
        return { results: [{ name: 'Please Select a Catalog First', value: '' }] };
    }
    if (!selectedSchema) {
        return { results: [{ name: 'Please Select a Schema First', value: '' }] };
    }
    try {
        const tables = await fetchResourcesInSchema(this, credentialType, host, '/api/2.1/unity-catalog/tables', selectedCatalog, selectedSchema, 'tables');
        const allResults = tables.map((table) => {
            const fullPath = `${selectedCatalog}.${selectedSchema}.${table.name}`;
            return {
                name: fullPath,
                value: fullPath,
                description: `${selectedCatalog} / ${selectedSchema}${table.table_type ? ` (${table.table_type})` : ''}`,
                url: `${host}/explore/data/${selectedCatalog}/${selectedSchema}/${table.name}`,
            };
        });
        if (filter) {
            const filterLower = filter.toLowerCase();
            return {
                results: allResults.filter((r) => r.name.toLowerCase().includes(filterLower) ||
                    r.description.toLowerCase().includes(filterLower)),
            };
        }
        return { results: allResults };
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return {
            results: [
                {
                    name: `Error loading tables for ${selectedCatalog}.${selectedSchema}: ${message}`,
                    value: '',
                },
            ],
        };
    }
}
async function getFunctions(filter) {
    const credentialType = (0, helpers_1.getActiveCredentialType)(this);
    const host = await (0, helpers_1.getHost)(this, credentialType);
    const { selectedCatalog, selectedSchema } = getSelectedCatalogAndSchema(this);
    if (!selectedCatalog) {
        return { results: [{ name: 'Please Select a Catalog First', value: '' }] };
    }
    if (!selectedSchema) {
        return { results: [{ name: 'Please Select a Schema First', value: '' }] };
    }
    try {
        const functions = await fetchResourcesInSchema(this, credentialType, host, '/api/2.1/unity-catalog/functions', selectedCatalog, selectedSchema, 'functions');
        const allResults = functions.map((func) => {
            const fullPath = `${selectedCatalog}.${selectedSchema}.${func.name}`;
            return {
                name: fullPath,
                value: fullPath,
                description: `${selectedCatalog} / ${selectedSchema}${func.data_type ? ` → ${func.data_type}` : ''}`,
                url: `${host}/explore/data/${selectedCatalog}/${selectedSchema}/${func.name}`,
            };
        });
        if (filter) {
            const filterLower = filter.toLowerCase();
            return {
                results: allResults.filter((r) => r.name.toLowerCase().includes(filterLower) ||
                    r.description.toLowerCase().includes(filterLower)),
            };
        }
        return { results: allResults };
    }
    catch (e) {
        return {
            results: [
                { name: `Error loading functions for ${selectedCatalog}.${selectedSchema}`, value: '' },
            ],
        };
    }
}
//# sourceMappingURL=listSearch.js.map