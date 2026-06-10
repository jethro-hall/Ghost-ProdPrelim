import type { Consumer, RemoveInstrumentationEventListener, KafkaMessage, KafkaConfig, ConsumerConfig } from 'kafkajs';
import { SchemaRegistry } from '@kafkajs/confluent-schema-registry';
import type { Logger, ITriggerFunctions, INodeExecutionData } from 'n8n-workflow';
export interface KafkaTriggerOptions {
    allowAutoTopicCreation?: boolean;
    autoCommitThreshold?: number;
    autoCommitInterval?: number;
    batchSize?: number;
    eachBatchAutoResolve?: boolean;
    errorRetryDelay?: number;
    fetchMaxBytes?: number;
    fetchMinBytes?: number;
    heartbeatInterval?: number;
    maxInFlightRequests?: number;
    fromBeginning?: boolean;
    jsonParseMessage?: boolean;
    keepBinaryData?: boolean;
    parallelProcessing?: boolean;
    partitionsConsumedConcurrently?: number;
    onlyMessage?: boolean;
    returnHeaders?: boolean;
    rebalanceTimeout?: number;
    sessionTimeout?: number;
}
/**
 * Creates Kafka client configuration from n8n credentials
 * @param ctx - The trigger function context
 * @returns Kafka configuration object with authentication settings
 */
export declare function createConfig(ctx: ITriggerFunctions): Promise<KafkaConfig>;
/**
 * Creates Kafka consumer configuration with session timeout and heartbeat settings
 * @param ctx - The trigger function context
 * @param options - Kafka trigger options from node parameters
 * @param nodeVersion - The version of the Kafka trigger node
 * @returns Consumer configuration object
 */
export declare function createConsumerConfig(ctx: ITriggerFunctions, options: KafkaTriggerOptions, nodeVersion: number): ConsumerConfig;
/**
 * Configures a message parser function that processes Kafka messages based on node options
 * @param options - Kafka trigger options for parsing behavior
 * @param logger - Logger instance for warnings
 * @param registry - Optional schema registry for message decoding
 * @param prepareBinaryData - Helper function to prepare binary data
 * @returns Async function that parses Kafka messages into n8n execution data
 */
export declare function configureMessageParser(options: KafkaTriggerOptions, logger: Logger, registry: SchemaRegistry | undefined, prepareBinaryData: ITriggerFunctions['helpers']['prepareBinaryData']): (message: KafkaMessage, messageTopic: string) => Promise<INodeExecutionData>;
/**
 * Attaches event listeners to the Kafka consumer for monitoring and logging
 * @param consumer - The Kafka consumer instance
 * @param logger - Logger instance for event logging
 * @returns Array of listener removal functions
 */
export declare function connectEventListeners(consumer: Consumer, logger: Logger): RemoveInstrumentationEventListener<"consumer.connect">[];
/**
 * Removes all event listeners from the Kafka consumer
 * @param listeners - Array of listener removal functions
 */
export declare function disconnectEventListeners(listeners: Array<RemoveInstrumentationEventListener<'consumer.connect'>>): void;
/**
 * Initializes Confluent Schema Registry if enabled in node parameters
 * @param ctx - The trigger function context
 * @returns Schema registry instance or undefined if not configured
 */
export declare function setSchemaRegistry(ctx: ITriggerFunctions): SchemaRegistry | undefined;
/**
 * Configures a data emitter function that handles workflow execution and offset resolution
 * @param ctx - The trigger function context
 * @param options - Kafka trigger options
 * @param nodeVersion - The version of the Kafka trigger node
 * @returns Async function that emits data and waits for execution completion based on resolve mode
 */
export declare function configureDataEmitter(ctx: ITriggerFunctions, options: KafkaTriggerOptions, nodeVersion: number): (dataArray: INodeExecutionData[]) => Promise<{
    success: boolean;
}>;
/**
 * Determines auto-commit settings based on node's optons
 * @param options - Kafka trigger options
 * @returns Object with auto-commit configuration
 */
export declare function getAutoCommitSettings(options: KafkaTriggerOptions): {
    autoCommit: boolean;
    eachBatchAutoResolve: boolean;
    autoCommitInterval: number | undefined;
    autoCommitThreshold: number | undefined;
};
/**
 * Runs a task while periodically invoking a heartbeat function
 * at specified intervals to prevent session timeout
 * @param task - The promise to execute
 * @param heartbeat - The heartbeat function to call periodically
 * @param intervalMs - The interval in milliseconds between heartbeat calls (default: 3000)
 * @returns The result of the task promise
 */
export declare function runWithHeartbeat<T>(task: Promise<T>, heartbeat: () => Promise<void>, intervalMs?: number): Promise<T>;
//# sourceMappingURL=utils.d.ts.map