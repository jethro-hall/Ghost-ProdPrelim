import type { IDataObject, IExecuteFunctions, ILoadOptionsFunctions, IHttpRequestMethods, IRequestOptions, IWebhookFunctions } from 'n8n-workflow';
import type { SendAndWaitMessageBody } from './MessageInterface';
interface RateLimitOptions {
    /**
     * The maximum number of times to retry the request if a rate limit error occurs.
     */
    maxRetries?: number;
    /**
     * The delay in milliseconds to wait before retrying the request if 'retry-after' header is not present.
     */
    fallbackDelay?: number;
    /**
     * What to do when a rate limit error occurs and maxRetries is exceeded.
     * - 'throw' will throw an error
     * - 'stop' will return the data collected so far with cursor/page info
     */
    onFail?: 'throw' | 'stop';
}
export declare function slackApiRequest(this: IExecuteFunctions | ILoadOptionsFunctions | IWebhookFunctions, method: IHttpRequestMethods, resource: string, body?: object, query?: IDataObject, headers?: {} | undefined, option?: Partial<IRequestOptions>): Promise<any>;
export declare function slackApiRequestAllItemsWithRateLimit<TResponseData>(context: IExecuteFunctions | ILoadOptionsFunctions, propertyName: string, method: IHttpRequestMethods, endpoint: string, body?: any, query?: IDataObject, options?: RateLimitOptions): Promise<{
    data: TResponseData[];
    cursor?: string;
    page?: string;
}>;
export declare function slackApiRequestAllItems(this: IExecuteFunctions | ILoadOptionsFunctions, propertyName: string, method: IHttpRequestMethods, endpoint: string, body?: any, query?: IDataObject): Promise<any>;
export declare function getMessageContent(this: IExecuteFunctions | ILoadOptionsFunctions, i: number, nodeVersion: number, instanceId?: string): IDataObject;
export declare function validateJSON(json: string | undefined): any;
export declare function getTarget(context: IExecuteFunctions, itemIndex: number, idType: 'user' | 'channel'): string;
export declare function processThreadOptions(threadOptions: IDataObject | undefined): IDataObject;
export declare function createSendAndWaitMessageBody(context: IExecuteFunctions): SendAndWaitMessageBody;
export {};
//# sourceMappingURL=GenericFunctions.d.ts.map