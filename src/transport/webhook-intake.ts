/**
 * Webhook intake for hosts that put the agent to sleep.
 *
 * The default intake is the persistent `app.messages` stream. A host that
 * snapshots and stops an idle agent cannot hold that stream, and nothing wakes
 * the agent when a message arrives. In webhook mode Spectrum Cloud sends one
 * signed HTTP request for each inbound message. The host wakes the agent and
 * forwards the request here.
 *
 * This module only moves verified `[space, message]` tuples from the HTTP
 * route into the same receive loop that the stream feeds. Authorization,
 * deduplication, and persistence stay in that loop.
 */

export interface SpectrumWebhookRawRequest {
  /** The exact bytes of the request body. Never a re-encoded body. */
  body: Uint8Array;
  headers: Record<string, string>;
}

export interface SpectrumWebhookRawResult {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** The part of the Spectrum application that verifies and decodes a delivery. */
export interface SpectrumWebhookVerifier<Space, Message> {
  webhook(
    request: SpectrumWebhookRawRequest,
    handler: (space: Space, message: Message) => void | Promise<void>,
  ): Promise<SpectrumWebhookRawResult>;
}

/** HTTP-facing port. The route needs nothing else from this module. */
export interface SpectrumWebhookController {
  handle(request: SpectrumWebhookRawRequest): Promise<SpectrumWebhookRawResult>;
}

const NOT_READY_STATUS = 503;
const NOT_READY_BODY = new TextEncoder().encode("spectrum intake not ready");

export class SpectrumWebhookIntake<Space, Message>
  implements SpectrumWebhookController
{
  #verifier: SpectrumWebhookVerifier<Space, Message> | undefined;
  readonly #pending: [Space, Message][] = [];
  #notify: (() => void) | undefined;

  /** Connects the Spectrum application of the current run. */
  public attach(verifier: SpectrumWebhookVerifier<Space, Message>): void {
    this.#verifier = verifier;
  }

  /** Disconnects it. Deliveries then get 503, and Spectrum sends them again. */
  public detach(verifier: SpectrumWebhookVerifier<Space, Message>): void {
    if (this.#verifier === verifier) {
      this.#verifier = undefined;
    }
  }

  /**
   * Verifies one delivery and queues its message for the receive loop.
   *
   * Returns the verifier's response: 200 for a valid delivery, 400 or 401 for
   * a missing or wrong signature. Returns 503 while no Spectrum run is active.
   */
  public async handle(
    request: SpectrumWebhookRawRequest,
  ): Promise<SpectrumWebhookRawResult> {
    const verifier = this.#verifier;
    if (verifier === undefined) {
      return { status: NOT_READY_STATUS, headers: {}, body: NOT_READY_BODY };
    }
    return await verifier.webhook(request, (space, message) => {
      this.#pending.push([space, message]);
      this.#notify?.();
    });
  }

  /**
   * Yields each queued message in arrival order until `signal` aborts.
   * Only one consumer may iterate at a time.
   */
  public async *messages(
    signal: AbortSignal,
  ): AsyncGenerator<[Space, Message], void, void> {
    while (!signal.aborted) {
      const next = this.#pending.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal.removeEventListener("abort", wake);
          this.#notify = undefined;
          resolve();
        };
        this.#notify = wake;
        signal.addEventListener("abort", wake, { once: true });
      });
    }
  }
}
