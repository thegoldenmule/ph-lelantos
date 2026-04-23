export type ResolveErrorCode =
  | 'local-path-missing'
  | 'git-clone-failed'
  | 'no-document-models'
  | 'project-root-not-found';

export class ResolveError extends Error {
  readonly code: ResolveErrorCode;
  override readonly cause?: unknown;

  constructor(code: ResolveErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'ResolveError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}
