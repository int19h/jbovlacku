import assert from "node:assert/strict";

/** Include the response body on failure and leave the original body readable. */
export async function assertResponseStatus(
  response: Response,
  expected: number,
): Promise<void> {
  if (response.status === expected) return;
  let body: string;
  try {
    body = (await response.clone().text()) || "(empty)";
  } catch (error) {
    body = `Cannot read the response body: ${error instanceof Error ? error.message : String(error)}`;
  }
  assert.equal(
    response.status,
    expected,
    `${response.url || "Adapter response"}\nResponse body: ${body}`,
  );
}
