/**
 * Mock for serialize-error ESM module
 * The real package is ESM-only and can't be used directly in Jest with CommonJS
 */

export function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const serialized: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    // Copy any additional enumerable properties
    for (const key of Object.keys(error)) {
      serialized[key] = (error as unknown as Record<string, unknown>)[key];
    }
    return serialized;
  }

  if (typeof error === 'object' && error !== null) {
    return { ...error as Record<string, unknown> };
  }

  return { value: error };
}

export function deserializeError(errorObject: Record<string, unknown>): Error {
  const error = new Error(errorObject.message as string);
  error.name = (errorObject.name as string) || 'Error';
  error.stack = errorObject.stack as string;
  return error;
}
