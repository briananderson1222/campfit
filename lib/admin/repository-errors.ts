export class RepositoryConnectionError extends Error {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'RepositoryConnectionError';
  }
}
