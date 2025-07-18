export interface SchemaField {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'date' | 'any';
    required?: boolean;
    min?: number; // For numbers and strings (length)
    max?: number; // For numbers and strings (length)
    format?: 'email' | 'url' | 'uuid' | 'date' | 'time' | 'datetime' | 'phone' | 'ip';
    pattern?: string; // Regex pattern
    enum?: any[]; // Allowed values
    default?: any; // Default value if not provided
    properties?: { [key: string]: SchemaField }; // For nested objects
    items?: SchemaField; // For arrays
    custom?: (value: any) => boolean | string; // Custom validation function
}

export interface DocumentSchema {
    [fieldName: string]: SchemaField;
}

export interface ValidationError {
    field: string;
    message: string;
    value?: any;
    expected?: string;
}

export interface ValidationResult {
    valid: boolean;
    errors: ValidationError[];
    data?: any; // Sanitized/transformed data
}

export class SchemaValidator {
    private schemas: Map<string, DocumentSchema> = new Map();

    setSchema(collectionName: string, schema: DocumentSchema): void {
        try {
            // Validate the schema itself
            this.validateSchemaDefinition(schema);
            this.schemas.set(collectionName, schema);
        } catch (error) {
            throw new Error(`Invalid schema definition: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    getSchema(collectionName: string): DocumentSchema | undefined {
        return this.schemas.get(collectionName);
    }

    removeSchema(collectionName: string): boolean {
        return this.schemas.delete(collectionName);
    }

    hasSchema(collectionName: string): boolean {
        return this.schemas.has(collectionName);
    }

    listSchemas(): string[] {
        return Array.from(this.schemas.keys());
    }

    private validateSchemaDefinition(schema: DocumentSchema): void {
        for (const [fieldName, fieldSchema] of Object.entries(schema)) {
            if (!fieldName || typeof fieldName !== 'string') {
                throw new Error('Field names must be non-empty strings');
            }

            if (!fieldSchema || typeof fieldSchema !== 'object') {
                throw new Error(`Field '${fieldName}' must have a schema definition`);
            }

            if (!fieldSchema.type) {
                throw new Error(`Field '${fieldName}' must have a type`);
            }

            const validTypes = ['string', 'number', 'boolean', 'object', 'array', 'date', 'any'];
            if (!validTypes.includes(fieldSchema.type)) {
                throw new Error(`Field '${fieldName}' has invalid type '${fieldSchema.type}'`);
            }

            // Validate format if specified
            if (fieldSchema.format) {
                const validFormats = ['email', 'url', 'uuid', 'date', 'time', 'datetime', 'phone', 'ip'];
                if (!validFormats.includes(fieldSchema.format)) {
                    throw new Error(`Field '${fieldName}' has invalid format '${fieldSchema.format}'`);
                }
            }

            // Validate min/max for numbers
            if (fieldSchema.type === 'number' && fieldSchema.min !== undefined && fieldSchema.max !== undefined) {
                if (fieldSchema.min > fieldSchema.max) {
                    throw new Error(`Field '${fieldName}' min value cannot be greater than max value`);
                }
            }

            // Validate nested object schema
            if (fieldSchema.type === 'object' && fieldSchema.properties) {
                this.validateSchemaDefinition(fieldSchema.properties);
            }

            // Validate array items schema
            if (fieldSchema.type === 'array' && fieldSchema.items) {
                this.validateSchemaDefinition({ items: fieldSchema.items });
            }
        }
    }

    validate(collectionName: string, data: any): ValidationResult {
        const schema = this.schemas.get(collectionName);

        // If no schema is defined, validation passes
        if (!schema) {
            return { valid: true, errors: [], data };
        }

        try {
            const errors: ValidationError[] = [];
            const sanitizedData = this.validateAndSanitizeData(data, schema, '', errors);

            return {
                valid: errors.length === 0,
                errors,
                data: errors.length === 0 ? sanitizedData : data
            };
        } catch (error) {
            return {
                valid: false,
                errors: [{
                    field: 'root',
                    message: error instanceof Error ? error.message : 'Validation failed',
                    value: data
                }],
                data
            };
        }
    }

    private validateAndSanitizeData(
        data: any,
        schema: DocumentSchema,
        path: string,
        errors: ValidationError[]
    ): any {
        if (data === null || data === undefined) {
            data = {};
        }

        if (typeof data !== 'object' || Array.isArray(data)) {
            errors.push({
                field: path || 'root',
                message: 'Data must be an object',
                value: data,
                expected: 'object'
            });
            return data;
        }

        const result: any = {};

        // Validate each field in the schema
        for (const [fieldName, fieldSchema] of Object.entries(schema)) {
            const fieldPath = path ? `${path}.${fieldName}` : fieldName;
            const fieldValue = data[fieldName];

            // Check if required field is missing
            if (fieldSchema.required && (fieldValue === undefined || fieldValue === null)) {
                // Use default value if available
                if (fieldSchema.default !== undefined) {
                    result[fieldName] = fieldSchema.default;
                    continue;
                }

                errors.push({
                    field: fieldPath,
                    message: `Required field '${fieldName}' is missing`,
                    expected: fieldSchema.type
                });
                continue;
            }

            // Skip validation if field is not provided and not required
            if (fieldValue === undefined || fieldValue === null) {
                if (fieldSchema.default !== undefined) {
                    result[fieldName] = fieldSchema.default;
                }
                continue;
            }

            // Validate the field
            const validatedValue = this.validateField(fieldValue, fieldSchema, fieldPath, errors);
            if (validatedValue !== undefined) {
                result[fieldName] = validatedValue;
            }
        }

        // Copy over any additional fields not in schema (flexible schema)
        for (const [key, value] of Object.entries(data)) {
            if (!(key in schema)) {
                result[key] = value;
            }
        }

        return result;
    }

    private validateField(
        value: any,
        fieldSchema: SchemaField,
        path: string,
        errors: ValidationError[]
    ): any {
        // Type validation
        if (!this.validateType(value, fieldSchema.type)) {
            errors.push({
                field: path,
                message: `Expected ${fieldSchema.type} but got ${typeof value}`,
                value,
                expected: fieldSchema.type
            });
            return value;
        }

        // Convert and validate based on type
        let processedValue = value;

        switch (fieldSchema.type) {
            case 'string':
                processedValue = this.validateString(value, fieldSchema, path, errors);
                break;
            case 'number':
                processedValue = this.validateNumber(value, fieldSchema, path, errors);
                break;
            case 'boolean':
                processedValue = this.validateBoolean(value, fieldSchema, path, errors);
                break;
            case 'date':
                processedValue = this.validateDate(value, fieldSchema, path, errors);
                break;
            case 'array':
                processedValue = this.validateArray(value, fieldSchema, path, errors);
                break;
            case 'object':
                processedValue = this.validateObject(value, fieldSchema, path, errors);
                break;
            case 'any':
                // No specific validation for 'any' type
                break;
        }

        // Enum validation
        if (fieldSchema.enum && !fieldSchema.enum.includes(processedValue)) {
            errors.push({
                field: path,
                message: `Value must be one of: ${fieldSchema.enum.join(', ')}`,
                value: processedValue,
                expected: `enum: [${fieldSchema.enum.join(', ')}]`
            });
        }

        // Custom validation
        if (fieldSchema.custom) {
            const customResult = fieldSchema.custom(processedValue);
            if (customResult !== true) {
                errors.push({
                    field: path,
                    message: typeof customResult === 'string' ? customResult : 'Custom validation failed',
                    value: processedValue
                });
            }
        }

        return processedValue;
    }

    private validateType(value: any, expectedType: string): boolean {
        switch (expectedType) {
            case 'string':
                return typeof value === 'string';
            case 'number':
                return typeof value === 'number' && !isNaN(value);
            case 'boolean':
                return typeof value === 'boolean';
            case 'object':
                return typeof value === 'object' && value !== null && !Array.isArray(value);
            case 'array':
                return Array.isArray(value);
            case 'date':
                return value instanceof Date || typeof value === 'string' || typeof value === 'number';
            case 'any':
                return true;
            default:
                return false;
        }
    }

    private validateString(value: string, schema: SchemaField, path: string, errors: ValidationError[]): string {
        // Length validation
        if (schema.min !== undefined && value.length < schema.min) {
            errors.push({
                field: path,
                message: `String must be at least ${schema.min} characters long`,
                value,
                expected: `min length: ${schema.min}`
            });
        }

        if (schema.max !== undefined && value.length > schema.max) {
            errors.push({
                field: path,
                message: `String must be at most ${schema.max} characters long`,
                value,
                expected: `max length: ${schema.max}`
            });
        }

        // Format validation
        if (schema.format) {
            if (!this.validateFormat(value, schema.format)) {
                errors.push({
                    field: path,
                    message: `Invalid ${schema.format} format`,
                    value,
                    expected: `valid ${schema.format}`
                });
            }
        }

        // Pattern validation
        if (schema.pattern) {
            const regex = new RegExp(schema.pattern);
            if (!regex.test(value)) {
                errors.push({
                    field: path,
                    message: `String does not match required pattern: ${schema.pattern}`,
                    value,
                    expected: `pattern: ${schema.pattern}`
                });
            }
        }

        return value;
    }

    private validateNumber(value: number, schema: SchemaField, path: string, errors: ValidationError[]): number {
        // Range validation
        if (schema.min !== undefined && value < schema.min) {
            errors.push({
                field: path,
                message: `Number must be at least ${schema.min}`,
                value,
                expected: `min: ${schema.min}`
            });
        }

        if (schema.max !== undefined && value > schema.max) {
            errors.push({
                field: path,
                message: `Number must be at most ${schema.max}`,
                value,
                expected: `max: ${schema.max}`
            });
        }

        return value;
    }

    private validateBoolean(value: boolean, schema: SchemaField, path: string, errors: ValidationError[]): boolean {
        return value;
    }

    private validateDate(value: any, schema: SchemaField, path: string, errors: ValidationError[]): any {
        let date: Date;

        if (value instanceof Date) {
            date = value;
        } else if (typeof value === 'string' || typeof value === 'number') {
            date = new Date(value);
        } else {
            errors.push({
                field: path,
                message: 'Invalid date value',
                value,
                expected: 'Date, string, or number'
            });
            return value;
        }

        if (isNaN(date.getTime())) {
            errors.push({
                field: path,
                message: 'Invalid date value',
                value,
                expected: 'valid date'
            });
            return value;
        }

        return date;
    }

    private validateArray(value: any[], schema: SchemaField, path: string, errors: ValidationError[]): any[] {
        if (!Array.isArray(value)) {
            errors.push({
                field: path,
                message: 'Expected array',
                value,
                expected: 'array'
            });
            return value;
        }

        // Length validation
        if (schema.min !== undefined && value.length < schema.min) {
            errors.push({
                field: path,
                message: `Array must have at least ${schema.min} items`,
                value,
                expected: `min length: ${schema.min}`
            });
        }

        if (schema.max !== undefined && value.length > schema.max) {
            errors.push({
                field: path,
                message: `Array must have at most ${schema.max} items`,
                value,
                expected: `max length: ${schema.max}`
            });
        }

        // Validate array items
        if (schema.items) {
            const validatedArray = value.map((item, index) => {
                const itemPath = `${path}[${index}]`;
                return this.validateField(item, schema.items!, itemPath, errors);
            });
            return validatedArray;
        }

        return value;
    }

    private validateObject(value: any, schema: SchemaField, path: string, errors: ValidationError[]): any {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            errors.push({
                field: path,
                message: 'Expected object',
                value,
                expected: 'object'
            });
            return value;
        }

        // Validate nested object properties
        if (schema.properties) {
            return this.validateAndSanitizeData(value, schema.properties, path, errors);
        }

        return value;
    }

    private validateFormat(value: string, format: string): boolean {
        switch (format) {
            case 'email':
                return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
            case 'url':
                try {
                    new URL(value);
                    return true;
                } catch {
                    return false;
                }
            case 'uuid':
                return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
            case 'date':
                return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value));
            case 'time':
                return /^([01]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/.test(value);
            case 'datetime':
                return !isNaN(Date.parse(value));
            case 'phone':
                return /^[\+]?[1-9][\d]{0,15}$/.test(value.replace(/[\s\-\(\)]/g, ''));
            case 'ip':
                return /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(value) ||
                    /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/.test(value);
            default:
                return true;
        }
    }

    // Utility methods
    getSchemaStats(): {
        totalSchemas: number;
        schemaNames: string[];
        totalFields: number;
    } {
        const schemaNames = Array.from(this.schemas.keys());
        let totalFields = 0;

        for (const schema of this.schemas.values()) {
            totalFields += Object.keys(schema).length;
        }

        return {
            totalSchemas: this.schemas.size,
            schemaNames,
            totalFields
        };
    }

    exportSchemas(): { [collectionName: string]: DocumentSchema } {
        const exported: { [collectionName: string]: DocumentSchema } = {};
        for (const [name, schema] of this.schemas.entries()) {
            exported[name] = { ...schema };
        }
        return exported;
    }

    importSchemas(schemas: { [collectionName: string]: DocumentSchema }): void {
        for (const [name, schema] of Object.entries(schemas)) {
            this.setSchema(name, schema);
        }
    }

    clearAllSchemas(): void {
        this.schemas.clear();
    }
}