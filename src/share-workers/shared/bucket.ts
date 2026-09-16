/**
 * Local stand-in for the pieces of the Cloudflare Workers R2/Assets API this
 * project uses, per `docs/design/sharing-tickets.md` contract C7.
 *
 * Deliberately hand-rolled instead of depending on `@cloudflare/workers-types`
 * (see the "No new root dependencies" rule and the contract header): these
 * interfaces are a small, exact subset of what the real R2 binding and Assets
 * binding expose, which is also what lets `memoryBucket.ts` implement
 * `BucketLike` faithfully enough to stand in for R2 under Jest.
 *
 * Kept verbatim to C7 — do not add members here without updating the ticket.
 */

export interface BucketObject {
  key: string;
  size: number;
  httpMetadata?: { contentType?: string };
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface BucketLike {
  get(key: string): Promise<BucketObject | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer | Uint8Array | string,
    opts?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
  list(opts: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string; size: number }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface AssetsLike {
  fetch(request: Request): Promise<Response>;
}

/** Bindings for `acabox-share-api` (bearer-token authenticated, not behind Access). */
export interface ApiEnv {
  BUCKET: BucketLike;
  PUBLISH_TOKEN: string;
}

/** Bindings for `acabox-share` (public site, gated by Cloudflare Access — see W3/W4). */
export interface WebEnv {
  BUCKET: BucketLike;
  ASSETS: AssetsLike;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ACCESS_DISABLED?: string;
}
