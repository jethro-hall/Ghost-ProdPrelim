import type { INode } from 'n8n-workflow';
import type { ConfigListSummary } from 'simple-git';
/**
 * Validates a git reference to prevent command injection attacks
 * @param reference - The git reference to validate (e.g., branch name, HEAD, refs/heads/main)
 * @param node - The node instance for error throwing
 * @throws {NodeOperationError} If the reference contains unsafe characters or patterns
 */
export declare function validateGitReference(reference: string, node: INode): void;
export declare function mapGitConfigList(config: ConfigListSummary): {
    "remote.origin.url": string | string[];
    "remote.origin.pushurl": string | string[];
    _file: string;
}[];
//# sourceMappingURL=GenericFunctions.d.ts.map