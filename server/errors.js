export class AppError extends Error {
  constructor(message, status = 400, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function errorBody(error) {
  return {
    error: error.message || "Unexpected error",
    ...(error.details ? { details: error.details } : {}),
  };
}
