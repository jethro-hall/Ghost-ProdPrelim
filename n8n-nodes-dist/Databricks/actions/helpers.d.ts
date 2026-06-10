import type { IExecuteFunctions, ILoadOptionsFunctions } from 'n8n-workflow';
import type { OpenAPISchema } from './interfaces';
export declare function getActiveCredentialType(context: IExecuteFunctions | ILoadOptionsFunctions, itemIndex?: number): 'databricksApi' | 'databricksOAuth2Api';
export declare function getHost(context: IExecuteFunctions | ILoadOptionsFunctions, credentialType: 'databricksApi' | 'databricksOAuth2Api'): Promise<string>;
export declare function extractResourceLocatorValue(param: unknown): string;
type DetectFormatResult = {
    format: string;
    schema: unknown;
    requiredFields: string[];
    invocationUrl: string;
};
export declare function detectInputFormat(openApiSchema: OpenAPISchema): DetectFormatResult;
export declare function generateExampleFromSchema(schema: unknown, format: string): string;
export declare function validateRequestBody(requestBody: Record<string, unknown>, detectedFormat: string): void;
export {};
//# sourceMappingURL=helpers.d.ts.map