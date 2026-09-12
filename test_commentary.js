import { GroqCommentarySystem } from './groqCommentary.js';
import assert from 'assert';

console.log('Testing GroqCommentarySystem queue logic...');

let capturedRequests = [];
const system = new GroqCommentarySystem({
  apiKey: 'test_key',
  minCallIntervalMs: 100 // low interval for testing
});

// Mock generateGroqCommentary to test queue mechanics
system.generateGroqCommentary = async (event) => {
  capturedRequests.push(event);
  return `Commentary for ${event.emotion}`;
};

// 1. Initial tick at t=0s with neutral
system.tick('neutral', 0);
assert.strictEqual(capturedRequests.length, 0, 'No event immediately on starting neutral');

// 2. Tick neutral at t=3000ms (3s elapsed) -> should not trigger yet
system.tick('neutral', 3000);
assert.strictEqual(capturedRequests.length, 0, 'No event yet when neutral < 5s');

// 3. Tick neutral at t=5200ms (5.2s elapsed) -> MUST trigger neutral > 5s
system.tick('neutral', 5200);
assert(system.requestQueue.length > 0 || capturedRequests.length > 0, 'Should queue neutral >5s event');
console.log('Neutral >5s triggered successfully!');

// Wait 150ms for mock worker to process
setTimeout(() => {
  assert(capturedRequests.length >= 1, 'Worker should process neutral >5s');
  assert.strictEqual(capturedRequests[0].trigger, 'neutral_persisted_5s');
  assert.strictEqual(capturedRequests[0].timeWithheldSec, '5.2');
  console.log('Processed event 1:', capturedRequests[0]);

  // 4. Switch immediately to happy at t=6000ms
  system.tick('happy', 6000, 0.92);

  setTimeout(() => {
    assert(capturedRequests.length >= 2, 'Worker should immediately process non-neutral emotion switch');
    const happyEvent = capturedRequests[1];
    assert.strictEqual(happyEvent.trigger, 'immediate_emotion');
    assert.strictEqual(happyEvent.emotion, 'happy');
    assert.strictEqual(happyEvent.prevEmotion, 'neutral');
    assert.strictEqual(happyEvent.prevTimeWithheldSec, '6.0');
    console.log('Processed event 2 (immediate emotion):', happyEvent);

    console.log('\nALL GROQ COMMENTARY QUEUE TESTS PASSED! ✅');
  }, 200);
}, 200);
