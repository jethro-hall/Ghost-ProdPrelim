import { type ITriggerFunctions } from 'n8n-workflow';
import type { EventContext } from 'rhea';
type MessageId = string | number | Buffer | undefined;
interface HandleMessageOptions {
    lastMessageId: MessageId;
    pullMessagesNumber: number;
    jsonConvertByteArrayToString?: boolean;
    jsonParseBody?: boolean;
    onlyBody?: boolean;
    parallelProcessing?: boolean;
    sleepTime?: number;
}
export declare function handleMessage(this: ITriggerFunctions, context: EventContext, options: HandleMessageOptions): Promise<{
    messageId: MessageId;
} | null>;
export {};
//# sourceMappingURL=handleMessage.d.ts.map