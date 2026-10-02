/** Replace bigints with decimal strings so a view can be serialized or printed. */
export function toJson(value) {
    return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
}
export function jsonReplacer(_key, value) {
    return typeof value === 'bigint' ? value.toString() : value;
}
//# sourceMappingURL=json.js.map