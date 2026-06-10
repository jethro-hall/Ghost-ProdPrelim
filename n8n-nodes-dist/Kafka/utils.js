"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createConfig = createConfig;
exports.createConsumerConfig = createConsumerConfig;
exports.configureMessageParser = configureMessageParser;
exports.connectEventListeners = connectEventListeners;
exports.disconnectEventListeners = disconnectEventListeners;
exports.setSchemaRegistry = setSchemaRegistry;
exports.configureDataEmitter = configureDataEmitter;
exports.getAutoCommitSettings = getAutoCommitSettings;
exports.runWithHeartbeat = runWithHeartbeat;
const kafkajs_1 = require("kafkajs");
const confluent_schema_registry_1 = require("@kafkajs/confluent-schema-registry");
const n8n_workflow_1 = require("n8n-workflow");
// Default delay in milliseconds before retrying after a failed offset resolution.
// This prevents rapid retry loops that could overwhelm the Kafka broker
const DEFAULT_ERROR_RETRY_DELAY_MS = 5000;
/**
 * Creates Kafka client configuration from n8n credentials
 * @param ctx - The trigger function context
 * @returns Kafka configuration object with authentication settings
 */
async function createConfig(ctx) {
    const credentials = (await ctx.getCredentials('kafka'));
    const clientId = credentials.clientId;
    const brokers = (credentials.brokers ?? '').split(',').map((item) => item.trim());
    const ssl = credentials.ssl;
    const config = {
        clientId,
        brokers,
        ssl,
        logLevel: kafkajs_1.logLevel.ERROR,
    };
    if (credentials.authentication) {
        if (!(credentials.username && credentials.password)) {
            throw new n8n_workflow_1.NodeOperationError(ctx.getNode(), 'Username and password are required for authentication');
        }
        config.sasl = {
            username: credentials.username,
            password: credentials.password,
            mechanism: credentials.saslMechanism,
        };
    }
    return config;
}
/**
 * Creates Kafka consumer configuration with session timeout and heartbeat settings
 * @param ctx - The trigger function context
 * @param options - Kafka trigger options from node parameters
 * @param nodeVersion - The version of the Kafka trigger node
 * @returns Consumer configuration object
 */
function createConsumerConfig(ctx, options, nodeVersion) {
    const groupId = ctx.getNodeParameter('groupId');
    const maxInFlightRequests = (ctx.getNodeParameter('options.maxInFlightRequests', null) === 0
        ? null
        : ctx.getNodeParameter('options.maxInFlightRequests', null));
    const sessionTimeout = options.sessionTimeout ?? 30000;
    let heartbeatInterval;
    if (nodeVersion < 1.3) {
        heartbeatInterval = options.heartbeatInterval ?? 3000;
    }
    else {
        heartbeatInterval = options.heartbeatInterval ?? 10000;
    }
    const rebalanceTimeout = options.rebalanceTimeout ?? 600000;
    const maxBytesPerPartition = options.fetchMaxBytes;
    const minBytes = options.fetchMinBytes;
    const consumerConfig = {
        groupId,
        maxInFlightRequests,
        sessionTimeout,
        heartbeatInterval,
        rebalanceTimeout,
    };
    if (maxBytesPerPartition !== undefined) {
        consumerConfig.maxBytesPerPartition = maxBytesPerPartition;
    }
    if (minBytes !== undefined) {
        consumerConfig.minBytes = minBytes;
    }
    return consumerConfig;
}
/**
 * Configures a message parser function that processes Kafka messages based on node options
 * @param options - Kafka trigger options for parsing behavior
 * @param logger - Logger instance for warnings
 * @param registry - Optional schema registry for message decoding
 * @param prepareBinaryData - Helper function to prepare binary data
 * @returns Async function that parses Kafka messages into n8n execution data
 */
function configureMessageParser(options, logger, registry, prepareBinaryData) {
    return async (message, messageTopic) => {
        let data = {};
        let value = message.value?.toString();
        const binary = {};
        if (options.jsonParseMessage) {
            try {
                value = (0, n8n_workflow_1.jsonParse)(value);
            }
            catch (error) {
                logger.warn('Could not parse message to JSON, returning as string', { error });
            }
        }
        if (registry) {
            try {
                value = await registry.decode(message.value);
            }
            catch (error) {
                logger.warn('Could not decode message with Schema Registry, returning original message', {
                    error,
                });
            }
        }
        // Preserve raw binary data for downstream processing (only in v1.2+)
        if (options.keepBinaryData && message.value) {
            const binaryData = await prepareBinaryData(message.value, 'message', 'application/octet-stream');
            binary.data = binaryData;
        }
        if (options.returnHeaders && message.headers) {
            data.headers = Object.fromEntries(Object.entries(message.headers).map(([headerKey, headerValue]) => [
                headerKey,
                headerValue?.toString('utf8') ?? '',
            ]));
        }
        data.message = value;
        data.topic = messageTopic;
        if (options.onlyMessage) {
            data = value;
        }
        if (options.keepBinaryData && Object.keys(binary).length) {
            return { json: data, binary };
        }
        return { json: data };
    };
}
/**
 * Attaches event listeners to the Kafka consumer for monitoring and logging
 * @param consumer - The Kafka consumer instance
 * @param logger - Logger instance for event logging
 * @returns Array of listener removal functions
 */
function connectEventListeners(consumer, logger) {
    const onConnected = consumer.on(consumer.events.CONNECT, () => {
        logger.debug('Kafka consumer connected');
    });
    const onGroupJoin = consumer.on(consumer.events.GROUP_JOIN, () => {
        logger.debug('Consumer has joined the group');
    });
    const onRequestTimeout = consumer.on(consumer.events.REQUEST_TIMEOUT, () => {
        logger.error('Consumer request timed out');
    });
    const onUnsubscribedtopicsReceived = consumer.on(consumer.events.RECEIVED_UNSUBSCRIBED_TOPICS, () => {
        logger.warn('Consumer received messages for unsubscribed topics');
    });
    const onStop = consumer.on(consumer.events.STOP, async (error) => {
        logger.error('Consumer has stopped', { error });
    });
    const onDisconnect = consumer.on(consumer.events.DISCONNECT, async (error) => {
        logger.error('Consumer has disconnected', { error });
    });
    const onCommitOffsets = consumer.on(consumer.events.COMMIT_OFFSETS, () => {
        logger.debug('Consumer offsets committed!');
    });
    const onRebalancing = consumer.on(consumer.events.REBALANCING, (payload) => {
        logger.debug('Consumer is rebalancing', { payload });
    });
    const onCrash = consumer.on(consumer.events.CRASH, async (error) => {
        logger.error('Consumer has crashed', { error });
    });
    return [
        onConnected,
        onGroupJoin,
        onRequestTimeout,
        onUnsubscribedtopicsReceived,
        onStop,
        onDisconnect,
        onCommitOffsets,
        onRebalancing,
        onCrash,
    ];
}
/**
 * Removes all event listeners from the Kafka consumer
 * @param listeners - Array of listener removal functions
 */
function disconnectEventListeners(listeners) {
    listeners.forEach((listener) => listener());
}
/**
 * Initializes Confluent Schema Registry if enabled in node parameters
 * @param ctx - The trigger function context
 * @returns Schema registry instance or undefined if not configured
 */
function setSchemaRegistry(ctx) {
    const useSchemaRegistry = ctx.getNodeParameter('useSchemaRegistry', 0);
    if (useSchemaRegistry) {
        try {
            const schemaRegistryUrl = ctx.getNodeParameter('schemaRegistryUrl', 0);
            return new confluent_schema_registry_1.SchemaRegistry({ host: schemaRegistryUrl });
        }
        catch (error) {
            ctx.logger.warn('Could not connect to Schema Registry', { error });
        }
    }
    return undefined;
}
/**
 * Determines the offset resolution mode based on node version and configuration
 * @param ctx - The trigger function context
 * @param options - Kafka trigger options
 * @param nodeVersion - The version of the Kafka trigger node
 * @returns The offset resolution mode
 */
function getResolveOffsetMode(ctx, options, nodeVersion) {
    if (nodeVersion === 1)
        return 'immediately';
    if (nodeVersion === 1.1) {
        if (options.parallelProcessing)
            return 'immediately';
        return 'onCompletion';
    }
    return ctx.getNodeParameter('resolveOffset', 'immediately');
}
/**
 * Configures a data emitter function that handles workflow execution and offset resolution
 * @param ctx - The trigger function context
 * @param options - Kafka trigger options
 * @param nodeVersion - The version of the Kafka trigger node
 * @returns Async function that emits data and waits for execution completion based on resolve mode
 */
function configureDataEmitter(ctx, options, nodeVersion) {
    const resolveOffsetMode = getResolveOffsetMode(ctx, options, nodeVersion);
    // For manual mode, always use immediate emit (no donePromise)
    if (ctx.getMode() === 'manual' || resolveOffsetMode === 'immediately') {
        return async (dataArray) => {
            ctx.emit([dataArray]);
            return { success: true };
        };
    }
    const executionTimeoutInSeconds = ctx.getWorkflowSettings().executionTimeout ?? 3600;
    const errorRetryDelay = options.errorRetryDelay ?? DEFAULT_ERROR_RETRY_DELAY_MS;
    const allowedStatuses = [];
    if (resolveOffsetMode === 'onSuccess') {
        allowedStatuses.push('success');
    }
    else if (resolveOffsetMode === 'onStatus') {
        const selectedStatuses = ctx.getNodeParameter('allowedStatuses', []);
        if (Array.isArray(selectedStatuses) && selectedStatuses.length) {
            allowedStatuses.push(...selectedStatuses);
        }
        else {
            throw new n8n_workflow_1.NodeOperationError(ctx.getNode(), 'At least one execution status must be selected to resolve offsets on selected statuses.');
        }
    }
    return async (dataArray) => {
        let timeoutId;
        try {
            const responsePromise = ctx.helpers.createDeferredPromise();
            ctx.emit([dataArray], undefined, responsePromise);
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new n8n_workflow_1.NodeOperationError(ctx.getNode(), `Execution took longer than the configured workflow timeout of ${executionTimeoutInSeconds} seconds to complete, offsets not resolved.`));
                }, executionTimeoutInSeconds * 1000);
            });
            const run = await Promise.race([responsePromise.promise, timeoutPromise]);
            if (resolveOffsetMode !== 'onCompletion' && !allowedStatuses.includes(run.status)) {
                throw new n8n_workflow_1.NodeOperationError(ctx.getNode(), 'Execution status is not allowed for resolving offsets, current status: ' + run.status);
            }
            return { success: true };
        }
        catch (e) {
            await (0, n8n_workflow_1.sleep)(errorRetryDelay);
            const error = (0, n8n_workflow_1.ensureError)(e);
            ctx.logger.error(error.message, { error });
            return { success: false };
        }
        finally {
            if (timeoutId)
                clearTimeout(timeoutId);
        }
    };
}
/**
 * Determines auto-commit settings based on node's optons
 * @param options - Kafka trigger options
 * @returns Object with auto-commit configuration
 */
function getAutoCommitSettings(options) {
    const eachBatchAutoResolve = options.eachBatchAutoResolve ?? false;
    const autoCommitInterval = options.autoCommitInterval ?? undefined;
    const autoCommitThreshold = options.autoCommitThreshold ?? undefined;
    return {
        autoCommit: true,
        eachBatchAutoResolve,
        autoCommitInterval,
        autoCommitThreshold,
    };
}
/**
 * Runs a task while periodically invoking a heartbeat function
 * at specified intervals to prevent session timeout
 * @param task - The promise to execute
 * @param heartbeat - The heartbeat function to call periodically
 * @param intervalMs - The interval in milliseconds between heartbeat calls (default: 3000)
 * @returns The result of the task promise
 */
async function runWithHeartbeat(task, heartbeat, intervalMs = 3000) {
    let timer;
    try {
        timer = setInterval(async () => {
            try {
                await heartbeat();
            }
            catch (error) { }
        }, intervalMs);
        return await task;
    }
    finally {
        clearInterval(timer);
    }
}
//# sourceMappingURL=utils.js.map