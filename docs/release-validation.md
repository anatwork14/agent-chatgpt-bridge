# Release Validation Scenarios

To validate Phase 10 (Live ChatGPT integration), the following manual tests must be performed using an isolated DEV launcher. 

## Scenario 1: New session
- Command: `agent-chatgpt ask --session "release-test-1" "Hello, this is a test."`
- Expected: Starts a fresh ChatGPT conversation in the browser.

## Scenario 2: Two-turn continuation
- Command: `agent-chatgpt ask --session "release-test-1" "What did I just say?"`
- Expected: Navigates to or uses the existing ChatGPT conversation and assistant correctly recalls the previous turn.

## Scenario 3: Two concurrent sessions
- Command: Run `agent-chatgpt ask --session "concurrent-A" "I am A"` and `agent-chatgpt ask --session "concurrent-B" "I am B"` concurrently.
- Expected: Two separate ChatGPT threads are utilized, requests do not bleed into each other, and turn synchronization is strictly serialized if directed to the same session.

## Scenario 4: Cancel
- Command: Start a long query `agent-chatgpt ask --session "cancel-test" "Write a very long essay..."`, then send `agent-chatgpt session cancel "cancel-test" "latest"`.
- Expected: The browser generation is aborted (Stop generating clicked).

## Scenario 5: Restart reconstruction
- Command: Stop the background `serve` or tunnel, restart it, and issue an `ask` to a previous session.
- Expected: The system fetches the URL from the persistence layer or reconstructs the session and resumes without failure.

## Scenario 6: Image attachment
- Command: `agent-chatgpt ask --session "image-test" "Describe this image" --image "./test.png"` (mocking image attachment through REST payload).
- Expected: The image is successfully uploaded and context is interpreted by the model.

## Scenario 7: UI drift simulated failure
- Command: Inject a DOM manipulation in the browser manually to break selectors.
- Expected: Fails closed. The bridge MUST NOT return success, but return a clear DOM drift error (e.g., missing completion evidence).

## Scenario 8: Autonomous two-round relay
- Command: `agent-chatgpt run --session "auto-relay-test" --agent-command "node my-agent.js" --objective "Say hello, wait for reply, then say goodbye."`
- Expected: Controller executes at least two rounds automatically, relaying JSONL payloads via `stdin`/`stdout`.
