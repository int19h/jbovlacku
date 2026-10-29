import assert from "node:assert/strict";
import { test } from "node:test";
import { assertResponseStatus } from "./adapter-status.ts";

test("matching adapter statuses do not clone or consume the response", async () => {
  const response = new Response('{"admission":"accepted"}', { status: 201 });
  response.clone = () => {
    throw new Error("A matching status must not read the body.");
  };
  await assertResponseStatus(response, 201);
  assert.equal(response.bodyUsed, false);
  assert.deepEqual(await response.json(), { admission: "accepted" });
});

for (const expected of [201, 404])
  test(`an unexpected adapter HTTP 500 includes its body when HTTP ${expected} is expected`, async () => {
    const body =
      '{"code":"internal_error","message":"Synthetic admission failure."}';
    const response = new Response(body, { status: 500 });
    await assert.rejects(
      assertResponseStatus(response, expected),
      (error: unknown) => {
        assert.ok(error instanceof assert.AssertionError);
        assert.equal(error.actual, 500);
        assert.equal(error.expected, expected);
        assert.ok(error.message.includes(body));
        return true;
      },
    );
    assert.equal(response.bodyUsed, false);
    assert.equal(await response.text(), body);
  });

test("an empty adapter error body keeps the status mismatch", async () => {
  const response = new Response(null, { status: 503 });
  await assert.rejects(
    assertResponseStatus(response, 200),
    (error: unknown) => {
      assert.ok(error instanceof assert.AssertionError);
      assert.equal(error.actual, 503);
      assert.equal(error.expected, 200);
      assert.match(error.message, /Response body: \(empty\)/);
      return true;
    },
  );
});

test("an unreadable adapter error body keeps the status mismatch and read error", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("Synthetic body read failure."));
      },
    }),
    { status: 500 },
  );
  await assert.rejects(
    assertResponseStatus(response, 201),
    (error: unknown) => {
      assert.ok(error instanceof assert.AssertionError);
      assert.equal(error.actual, 500);
      assert.equal(error.expected, 201);
      assert.match(
        error.message,
        /Cannot read the response body: Synthetic body read failure\./,
      );
      return true;
    },
  );
  assert.equal(response.bodyUsed, false);
});

test("a response that cannot be cloned keeps the adapter status mismatch", async () => {
  const response = new Response("Synthetic body.", { status: 500 });
  response.clone = () => {
    throw new Error("Synthetic clone failure.");
  };
  await assert.rejects(
    assertResponseStatus(response, 201),
    (error: unknown) => {
      assert.ok(error instanceof assert.AssertionError);
      assert.equal(error.actual, 500);
      assert.equal(error.expected, 201);
      assert.match(
        error.message,
        /Cannot read the response body: Synthetic clone failure\./,
      );
      return true;
    },
  );
  assert.equal(await response.text(), "Synthetic body.");
});
