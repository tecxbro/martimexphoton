import { createHmac } from "node:crypto";
import { type AddressInfo } from "node:net";

import { Spectrum } from "spectrum-ts";
import { afterEach, describe, expect, it } from "vitest";

import { ReadinessRegistry } from "../../../src/http/readiness.js";
import {
  SPECTRUM_WEBHOOK_PATH,
  startHealthServer,
  type HealthServer,
} from "../../../src/http/server.js";
import {
  SpectrumWebhookIntake,
  type SpectrumWebhookRawRequest,
  type SpectrumWebhookRawResult,
  type SpectrumWebhookVerifier,
} from "../../../src/transport/webhook-intake.js";

const SECRET = "a3f8e29b0c1d4e5f8a7b6c5d4e3f2a1b";
const OK: SpectrumWebhookRawResult = {
  status: 200,
  headers: {},
  body: new Uint8Array(),
};

/** Accepts every delivery and reports the JSON body as one message. */
const acceptingVerifier: SpectrumWebhookVerifier<string, string> = {
  async webhook(request, handler) {
    const parsed = JSON.parse(Buffer.from(request.body).toString()) as {
      space: string;
      message: string;
    };
    await handler(parsed.space, parsed.message);
    return OK;
  },
};

function delivery(space: string, message: string): SpectrumWebhookRawRequest {
  return {
    body: Buffer.from(JSON.stringify({ space, message })),
    headers: {},
  };
}

function signedHeaders(body: Buffer, secret: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`v0:${timestamp}:`), body]))
    .digest("hex");
  return {
    "x-spectrum-timestamp": timestamp,
    "x-spectrum-signature": `v0=${digest}`,
  };
}

describe("Spectrum webhook intake", () => {
  it("answers 503 until a Spectrum run is attached, so Spectrum sends the delivery again", async () => {
    const intake = new SpectrumWebhookIntake<string, string>();

    const result = await intake.handle(delivery("s", "m"));

    expect(result.status).toBe(503);
  });

  it("feeds accepted deliveries to the receive loop in arrival order", async () => {
    const intake = new SpectrumWebhookIntake<string, string>();
    intake.attach(acceptingVerifier);
    const controller = new AbortController();
    const received: [string, string][] = [];
    const consumer = (async () => {
      for await (const tuple of intake.messages(controller.signal)) {
        received.push(tuple);
        if (received.length === 3) controller.abort();
      }
    })();

    await intake.handle(delivery("space-1", "first"));
    await intake.handle(delivery("space-1", "second"));
    await intake.handle(delivery("space-2", "third"));
    await consumer;

    expect(received).toEqual([
      ["space-1", "first"],
      ["space-1", "second"],
      ["space-2", "third"],
    ]);
  });

  it("stops the receive loop when the run aborts while it waits", async () => {
    const intake = new SpectrumWebhookIntake<string, string>();
    const controller = new AbortController();
    const consumer = (async () => {
      for await (const tuple of intake.messages(controller.signal)) {
        throw new Error(`unexpected message ${String(tuple)}`);
      }
    })();

    controller.abort();

    await expect(consumer).resolves.toBeUndefined();
  });

  it("stops accepting deliveries after the run detaches", async () => {
    const intake = new SpectrumWebhookIntake<string, string>();
    intake.attach(acceptingVerifier);
    intake.detach(acceptingVerifier);

    expect((await intake.handle(delivery("s", "m"))).status).toBe(503);
  });
});

describe("Spectrum webhook route with the real Spectrum verifier", () => {
  let health: HealthServer | undefined;

  afterEach(async () => {
    await health?.close();
    health = undefined;
  });

  async function startWithRealVerifier(): Promise<string> {
    const app = await Spectrum({
      providers: [],
      webhookSecret: SECRET,
    } as never);
    const intake = new SpectrumWebhookIntake<unknown, unknown>();
    intake.attach(app as unknown as SpectrumWebhookVerifier<unknown, unknown>);
    health = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      readiness: new ReadinessRegistry(),
      spectrumWebhook: intake,
    });
    const address = health.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}${SPECTRUM_WEBHOOK_PATH}`;
  }

  // Key order and spacing are deliberate: a route that parsed and re-encoded
  // the body would change these bytes and break the signature.
  const body = Buffer.from(
    '{"event":"messages",  "space":{"platform":"imessage","id":"s-1"},"message":{"id":"m-1","space":{"id":"s-1"},"content":{"type":"text","text":"hi"}}}',
  );

  it("accepts a delivery signed over the exact body bytes", async () => {
    const url = await startWithRealVerifier();

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...signedHeaders(body, SECRET) },
      body,
    });

    expect(response.status).toBe(200);
  });

  it("refuses a wrong signature and an unsigned delivery", async () => {
    const url = await startWithRealVerifier();

    const wrong = await fetch(url, {
      method: "POST",
      headers: signedHeaders(body, "0".repeat(32)),
      body,
    });
    const unsigned = await fetch(url, { method: "POST", body });

    expect(wrong.status).toBe(401);
    expect(unsigned.status).toBe(400);
  });

  it("does not serve the route in the default stream mode", async () => {
    health = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      readiness: new ReadinessRegistry(),
    });
    const address = health.server.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${address.port}${SPECTRUM_WEBHOOK_PATH}`,
      { method: "POST", headers: signedHeaders(body, SECRET), body },
    );

    expect(response.status).toBe(404);
  });
});
