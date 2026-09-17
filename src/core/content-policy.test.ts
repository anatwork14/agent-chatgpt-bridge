import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateBridgeContentPart } from "./content-policy";
import { BridgeError } from "./errors";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-chatgpt-content-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("local file attachment is canonicalized inside an explicit workspace root", () => {
  const root = tempRoot();
  const nested = join(root, "images");
  mkdirSync(nested);
  const file = join(nested, "sample.png");
  writeFileSync(file, "fake-image");

  const result = validateBridgeContentPart(
    { type: "image", source: { type: "local_file", path: "images/sample.png" } },
    { cwd: root, workspaceRoots: [root] },
  );

  expect(result.type).toBe("image");
  if (result.type === "image" && result.source.type === "local_file") {
    expect(result.source.path).toBe(realpathSync(file));
  }
});

test("local file attachment requires an explicit workspace allowlist", () => {
  const root = tempRoot();
  const file = join(root, "sample.png");
  writeFileSync(file, "fake-image");

  let error: unknown;
  try {
    validateBridgeContentPart(
      { type: "image", source: { type: "local_file", path: file } },
    );
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(BridgeError);
  expect((error as BridgeError).code).toBe("attachment_invalid");
});

test("local file attachment cannot escape workspace roots", () => {
  const root = tempRoot();
  const outside = tempRoot();
  const file = join(outside, "secret.png");
  writeFileSync(file, "secret");

  let error: unknown;
  try {
    validateBridgeContentPart(
      { type: "image", source: { type: "local_file", path: file } },
      { cwd: root, workspaceRoots: [root] },
    );
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(BridgeError);
  expect((error as BridgeError).code).toBe("attachment_invalid");
});

test("resource attachments reject local file schemes", () => {
  expect(() => validateBridgeContentPart({ type: "resource", uri: "file:///etc/passwd" }))
    .toThrow();
});

test("image data URLs require a base64 image MIME type", () => {
  const valid = validateBridgeContentPart({
    type: "image",
    source: { type: "data_url", dataUrl: "data:image/png;base64,aGVsbG8=" },
  });
  expect(valid.type).toBe("image");

  expect(() => validateBridgeContentPart({
    type: "image",
    source: { type: "data_url", dataUrl: "data:text/plain;base64,aGVsbG8=" },
  })).toThrow();
});
