// Storage/effect ports for the GitHub App-uninstall webhook handler.
//
// The handler is pure (signature verify + dispatch). All side effects —
// deleting tokens, marking users revoked, cancelling pipeline runs, recording
// what we've already processed — go through these interfaces, so the same
// code runs against the real DB in prod and against in-memory fakes in tests.

export interface TokenStore {
  // Hard-delete every token tied to this installation. Must be idempotent
  // (calling twice is a no-op). Returns the count of tokens actually removed
  // on this call so the caller can record the SLA-relevant deletion event.
  deleteByInstallationId(installationId: number): Promise<number>;

  // Mark the owning user record as revoked. Idempotent.
  markUserRevokedByInstallationId(installationId: number): Promise<void>;

  // Test/audit: returns the wall-clock time of the most recent delete call
  // for this installation, or null if never deleted.
  lastDeletedAt?(installationId: number): Date | null;
}

export interface RunCanceller {
  // Cancel queued runs and hard-stop running runs for this installation.
  // Idempotent: re-calling on an already-cancelled installation is a no-op.
  // Returns the count of runs whose state actually changed on this call.
  cancelAllForInstallation(installationId: number): Promise<number>;
}

export interface DeliveryDeduper {
  // Returns true if `deliveryId` has been seen before. If false, atomically
  // records it as seen so concurrent retries collapse to one execution.
  hasSeenAndRecord(deliveryId: string): Promise<boolean>;
}

export interface WebhookLogger {
  // Whitelisted fields only. Implementations MUST NOT serialize the raw body
  // or any payload field beyond installation ID — see issue MAL-46 / threat
  // T10 (sensitive-data-in-logs).
  log(entry: WebhookLogEntry): void;
}

export interface WebhookLogEntry {
  event: string;
  action?: string;
  installationId?: number;
  deliveryId?: string;
  signed: boolean;
  outcome:
    | 'rejected-unsigned'
    | 'rejected-malformed'
    | 'rejected-missing-header'
    | 'rejected-no-secret'
    | 'replay-ignored'
    | 'no-op'
    | 'tokens-purged';
  tokensDeleted?: number;
  runsCancelled?: number;
  reason?: string;
}

export interface Clock {
  now(): Date;
}
