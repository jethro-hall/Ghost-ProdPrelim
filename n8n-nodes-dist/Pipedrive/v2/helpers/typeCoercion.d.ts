/**
 * Converts various boolean-like values (0/1, '0'/'1', true/false) to strict boolean.
 */
export declare function coerceToBoolean(value: unknown): boolean;
/**
 * Coerces string numbers to actual numbers for v2 API.
 */
export declare function coerceToNumber(value: unknown): number;
/**
 * Converts a date/datetime string to RFC 3339 format for v2 API.
 * v1 uses 'YYYY-MM-DD HH:mm:ss', v2 requires '2024-01-01T00:00:00Z'.
 * Date-only strings (YYYY-MM-DD) are passed through unchanged.
 */
export declare function toRfc3339(value: string): string;
//# sourceMappingURL=typeCoercion.d.ts.map