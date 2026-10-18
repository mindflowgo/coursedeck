/**
 * Typed domain errors for CourseDeck services.
 * Mapped to appropriate HTTP status codes and MCP error envelopes.
 */

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, identifier: string) {
    super(`${resource} '${identifier}' not found`, 'NOT_FOUND', 404);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, public readonly details?: unknown) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message: string) {
    super(message, 'FORBIDDEN', 403);
  }
}
