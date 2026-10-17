/** Safe quota rejection shared by provider adapters and the pipeline. */
export class ProviderCallLimitError extends Error {
  readonly status = 429;

  constructor(message: string) {
    super(message);
    this.name = 'ProviderCallLimitError';
  }
}

/** Called immediately before one actual provider request, including retries. */
export type ProviderAttemptHook = () => void;
