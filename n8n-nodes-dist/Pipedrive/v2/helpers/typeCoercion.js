"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.coerceToBoolean = coerceToBoolean;
exports.coerceToNumber = coerceToNumber;
exports.toRfc3339 = toRfc3339;
/**
 * Converts various boolean-like values (0/1, '0'/'1', true/false) to strict boolean.
 */
function coerceToBoolean(value) {
    if (typeof value === 'boolean')
        return value;
    if (value === 1 || value === '1')
        return true;
    if (value === 0 || value === '0')
        return false;
    if (typeof value === 'string') {
        if (value.toLowerCase() === 'true')
            return true;
        if (value.toLowerCase() === 'false')
            return false;
    }
    return Boolean(value);
}
/**
 * Coerces string numbers to actual numbers for v2 API.
 */
function coerceToNumber(value) {
    if (typeof value === 'number')
        return value;
    const num = Number(value);
    if (Number.isNaN(num)) {
        throw new Error(`Cannot convert "${value}" to a number`);
    }
    return num;
}
/**
 * Converts a date/datetime string to RFC 3339 format for v2 API.
 * v1 uses 'YYYY-MM-DD HH:mm:ss', v2 requires '2024-01-01T00:00:00Z'.
 * Date-only strings (YYYY-MM-DD) are passed through unchanged.
 */
function toRfc3339(value) {
    if (!value || value.includes('T'))
        return value;
    // Date-only (YYYY-MM-DD) — pass through, Pipedrive accepts this
    if (/^\d{4}-\d{2}-\d{2}$/.test(value))
        return value;
    // Datetime without T — convert
    const date = new Date(value.replace(' ', 'T') + 'Z');
    if (Number.isNaN(date.getTime()))
        return value;
    return date.toISOString();
}
//# sourceMappingURL=typeCoercion.js.map