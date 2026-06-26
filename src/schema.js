const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'items',
  'maxItems',
  'minItems',
  'properties',
  'propertyOrdering',
  'required',
  'anyOf',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'default',
  'example'
]);

export function sanitizeGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {} };
  }

  return sanitizeSchemaNode(schema);
}

function sanitizeSchemaNode(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaNode);

  const cleaned = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) continue;

    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      cleaned.properties = Object.fromEntries(
        Object.entries(value).map(([propertyName, propertySchema]) => [propertyName, sanitizeSchemaNode(propertySchema)])
      );
      continue;
    }

    if (key === 'items') {
      cleaned.items = sanitizeSchemaNode(value);
      continue;
    }

    if (key === 'anyOf') {
      cleaned.anyOf = Array.isArray(value) ? value.map(sanitizeSchemaNode) : undefined;
      continue;
    }

    cleaned[key] = value;
  }

  if (!cleaned.type && cleaned.properties) {
    cleaned.type = 'object';
  }

  return stripUndefined(cleaned);
}

function stripUndefined(value) {
  if (!value || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    } else {
      stripUndefined(value[key]);
    }
  }
  return value;
}
