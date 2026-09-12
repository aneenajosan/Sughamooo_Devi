import { FaceEventClassifier, SingleEmotionStabilizer, CONFIG, computeEyeEAR } from './eventClassifier.js';
import assert from 'assert';

console.log('Running tests for FaceEventClassifier and SingleEmotionStabilizer...');

// 1. Test geometric helper (EAR)
const dummyEyeNormal = [
  { x: 10, y: 20 }, // p0 (outer)
  { x: 15, y: 15 }, // p1 (top left)
  { x: 25, y: 15 }, // p2 (top right)
  { x: 30, y: 20 }, // p3 (inner)
  { x: 25, y: 25 }, // p4 (bottom right)
  { x: 15, y: 25 }, // p5 (bottom left)
];
const earNormal = computeEyeEAR(dummyEyeNormal);
console.log('Normal EAR:', earNormal.toFixed(3));
assert(earNormal > 0.25, 'Normal eye should have EAR > 0.25');

const dummyEyeSquint = [
  { x: 10, y: 20 },
  { x: 15, y: 19 },
  { x: 25, y: 19 },
  { x: 30, y: 20 },
  { x: 25, y: 21 },
  { x: 15, y: 21 },
];
const earSquint = computeEyeEAR(dummyEyeSquint);
console.log('Squint EAR:', earSquint.toFixed(3));
assert(earSquint < 0.15, 'Squinting eye should have EAR < 0.15');

// 2. Test FaceEventClassifier basic event trigger
const classifier = new FaceEventClassifier();

// Test Big Smile event
const smileEvent = classifier.processFrame(
  { happy: 0.95, neutral: 0.05, sad: 0 },
  [], // landmarks
  1000
);
console.log('Big smile test result:', smileEvent);
assert(smileEvent !== null, 'Big smile should trigger an event');
assert.strictEqual(smileEvent.type, 'happy');

// Test global cooldown (should return null if called 500ms later)
const immediateNext = classifier.processFrame(
  { happy: 0.95, neutral: 0.05, sad: 0 },
  [],
  1500
);
assert.strictEqual(immediateNext, null, 'Global cooldown (1500ms) should suppress immediate next event');

// Test same event cooldown after 2000ms (global cooldown passed, but sameEventCooldown not passed)
const sameEventBlocked = classifier.processFrame(
  { happy: 0.95, neutral: 0.05, sad: 0 },
  [],
  2700
);
assert.strictEqual(sameEventBlocked, null, 'Same event cooldown (3500ms) should suppress repeated big_smile');

// Test different event allowed after global cooldown (e.g. surprised after 1700ms)
const differentEvent = classifier.processFrame(
  { surprised: 0.92, happy: 0.0, neutral: 0.08 },
  [],
  2750
);
console.log('Different event test result:', differentEvent);
assert(differentEvent !== null, 'Different event should trigger after global cooldown');
assert.strictEqual(differentEvent.type, 'disbelief');

// 3. Test Neutral Long duration
let time = 5000;
let neutralEvent = null;
// Simulate 5 seconds of sustained neutral
for (let i = 0; i < 55; i++) {
  time += 100;
  const evt = classifier.processFrame({ neutral: 0.90 }, [], time);
  if (evt) {
    neutralEvent = evt;
    break;
  }
}
console.log('Neutral long event result:', neutralEvent);
assert(neutralEvent !== null, 'Neutral long should fire after 3 seconds of sustained neutral');
assert.strictEqual(neutralEvent.type, 'neutral_long');

// 4. Test SingleEmotionStabilizer (Holds emotion for ~7 seconds)
console.log('\nTesting SingleEmotionStabilizer 7-second hold...');
const stabilizer = new SingleEmotionStabilizer({ minHoldDurationMs: 7000, smoothingAlpha: 0.5, overtakeMargin: 0.4 });
let initial = stabilizer.update({ happy: 0.90, neutral: 0.10 }, 0);
console.log('Time 0s emotion:', initial.emotion);
assert.strictEqual(initial.emotion, 'happy');

// Try to jitter into sad for a brief spike
for (let t = 500; t <= 1500; t += 500) {
  const res = stabilizer.update({ sad: 0.60, happy: 0.40 }, t);
  assert.strictEqual(res.emotion, 'happy', `At t=${t}ms, emotion should remain locked to happy`);
}
console.log('Emotion held steady through jitter for 3 seconds: PASSED');

// After 7.5 seconds, if sad is sustained, it transitions smoothly
const postHold = stabilizer.update({ sad: 0.85, happy: 0.15 }, 7500);
console.log('At t=7.5s with sustained shift:', postHold.emotion);
assert.strictEqual(postHold.emotion, 'sad', 'Emotion should transition after the 7-second hold window has expired');

console.log('\nALL UNIT TESTS PASSED SUCCESSFULLY! ✅');
