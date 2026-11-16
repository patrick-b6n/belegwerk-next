/**
 * Port for the Stripe API (#29, docs/architecture.md, "Stripe client (#29)"):
 * Business stays free of Tauri and HTTP; `src/app` implements it with
 * `tauri-plugin-http` and validates every response into these domain types.
 *
 * Results instead of exceptions: every expected failure (invalid key,
 * missing permission, rate limit, network, unexpected response) is a
 * {@link StripeClientError} code the UI translates (docs/i18n.md). Neither
 * results nor errors ever contain the API key.
 */

/** A refund of an application fee (Stripe object `fee_refund`). */
export interface StripeFeeRefund {
  /** `fr_…` – the external ID of the refund booking (#30). */
  readonly id: string;
  /** Refunded amount in the smallest currency unit (cents for EUR), ≥ 0 (the import skips 0). */
  readonly amount: number;
  /** Three-letter ISO currency code, lowercase as Stripe sends it (`"eur"`). */
  readonly currency: string;
  /** Unix epoch seconds (UTC); see `stripeCreatedToBookingDate`. */
  readonly created: number;
}

/** An application fee of the Connect platform (Stripe object `application_fee`). */
export interface StripeApplicationFee {
  /** `fee_…` – the external ID of the fee booking (#30). */
  readonly id: string;
  /** Fee amount in the smallest currency unit (cents for EUR), ≥ 0. */
  readonly amount: number;
  /** Three-letter ISO currency code, lowercase as Stripe sends it (`"eur"`). */
  readonly currency: string;
  /** Unix epoch seconds (UTC); see `stripeCreatedToBookingDate`. */
  readonly created: number;
  /** The connected account the fee was taken from (`acct_…`) – the counterparty. */
  readonly account: string;
  /** `false` for objects of a test-mode key. */
  readonly livemode: boolean;
  /**
   * **All** refunds of the fee, whatever their own `created` – not only those
   * in the requested range. Newest first, as Stripe lists them.
   */
  readonly refunds: readonly StripeFeeRefund[];
}

export interface ListApplicationFeesRequest {
  /** The restricted key – sent as `Authorization` header only, never in the URL. */
  readonly apiKey: string;
  /** Inclusive lower bound of the fee's `created`, Unix epoch seconds (`created[gte]`). */
  readonly createdFrom: number;
  /** Inclusive upper bound of the fee's `created`, Unix epoch seconds (`created[lte]`). */
  readonly createdTo: number;
}

export type StripeClientError =
  /** 401: key unknown, revoked or expired. */
  | { readonly code: "invalidApiKey" }
  /** 403: the restricted key lacks "Application fees: Read". */
  | { readonly code: "permissionDenied" }
  /** 429 after the client's own retries; `retryAfterSeconds` from `Retry-After`, if sent. */
  | { readonly code: "rateLimited"; readonly retryAfterSeconds: number | null }
  /** Stripe not reachable (offline, DNS, TLS, proxy) or refused by the HTTP scope – after retries. */
  | { readonly code: "network" }
  /** No response within the client's timeout. */
  | { readonly code: "timeout" }
  /**
   * Any other 4xx/5xx (500/502/503/504 after the client's retries);
   * Stripe's `error.code`/`error.message` if the body had them.
   */
  | {
      readonly code: "stripeError";
      readonly status: number;
      readonly stripeCode: string | null;
      readonly message: string | null;
    }
  /** A 2xx response that is no valid JSON or does not have the expected shape. */
  | { readonly code: "invalidResponse" };

export type StripeClientErrorCode = StripeClientError["code"];

export type ListApplicationFeesResult =
  | { readonly ok: true; readonly fees: readonly StripeApplicationFee[] }
  | { readonly ok: false; readonly error: StripeClientError };

export type GetAccountNameResult =
  /** `name` is `null` if the account has no name the platform can see. */
  | { readonly ok: true; readonly name: string | null }
  | { readonly ok: false; readonly error: StripeClientError };

export type VerifyStripeAccessResult =
  | { readonly ok: true; readonly livemode: boolean | null }
  | { readonly ok: false; readonly error: StripeClientError };

export interface StripeClient {
  /**
   * All application fees with `createdFrom ≤ created ≤ createdTo` (cursor
   * pagination, newest first), each with **all** its refunds.
   *
   * Stripe has no list of fee refunds by date: a refund in the range whose
   * fee was created before `createdFrom` is only found if the caller widens
   * `createdFrom` (see {@link STRIPE_FEE_REFUND_LOOKBACK_DAYS}).
   *
   * All or nothing: on the first error the fees fetched so far are dropped.
   */
  listApplicationFees(request: ListApplicationFeesRequest): Promise<ListApplicationFeesResult>;

  /**
   * The display name of a connected account (`GET /v1/accounts/{id}`), the
   * counterparty of its fees: the public business name, else the dashboard
   * display name, the company name or the individual's name. Needs the
   * optional permission "Accounts: Read" – without it the result is
   * `permissionDenied` and the import keeps the `acct_…` ID.
   */
  getAccountName(request: {
    readonly apiKey: string;
    readonly accountId: string;
  }): Promise<GetAccountNameResult>;

  /**
   * Checks key and permission with the smallest possible request (one fee).
   * `livemode` of that fee, `null` if the account has no fees yet.
   */
  verifyAccess(request: { readonly apiKey: string }): Promise<VerifyStripeAccessResult>;
}

/**
 * How far before the import range the import (#30) fetches fees to find
 * refunds inside the range on older fees (see
 * {@link StripeClient.listApplicationFees}). Refunds of fees older than this
 * are missed – documented limitation (docs/architecture.md, "Stripe client (#29)").
 */
export const STRIPE_FEE_REFUND_LOOKBACK_DAYS = 180;
