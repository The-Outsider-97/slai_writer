export function objectKind(type, isShape, withTable = true) {
    if (isShape)
        return "figure";
    if (type === "figure" || type === "equation" || type === "embed")
        return type;
    if (type === "table" && withTable)
        return "table";
    return null;
}
