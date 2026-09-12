/**
 * Face Event Classifier & Single Emotion Stabilizer Module
 * Multi-emotion recognition: happy, sad, disgust, disbelief/surprise, anger, eyebrow raise, smirk, squint, yawn.
 */

// ==========================================
// 1. CONFIGURATION OBJECT
// ==========================================
export const CONFIG = {
  thresholds: {
    // Core Emotions (normalized sensitivity for face-api scores)
    happyScore: 0.38,
    sadScore: 0.26,           // Sadness scores in face-api are typically lower
    disgustScore: 0.28,       // Disgust is subtle
    angryScore: 0.26,         // Anger score or brow furrow
    surprisedScore: 0.32,     // Disbelief / surprise
    fearfulScore: 0.28,

    // Micro-gestures
    eyebrowRaiseRatio: 0.295, // Elevated eyebrow-to-eye ratio (prevents resting brow false positives)
    browFurrowRatio: 0.28,    // Narrowing gap between inner eyebrows (frown / scowl)
    smirkAsymmetry: 0.09,     // Lopsided mouth curl
    squintEAR: 0.22,          // Narrowed eyes
    yawnMAR: 0.58,            // Wide open mouth

    // Neutral streak duration
    neutralScore: 0.65,
    neutralDurationMs: 4500,
  },

  cooldowns: {
    // Global gap between ANY event: 700ms (fast transitions between different emotions)
    globalCooldownMs: 700,

    // Gap before the SAME event can repeat: 3800ms (strictly prevents fixating on one gesture)
    sameEventCooldownMs: 3800,

    // Neutral long cooldown
    neutralLongCooldownMs: 8000,
  },

  stabilizer: {
    minHoldDurationMs: 2500,  // Holds emotion for ~2.5s before smooth transition
    smoothingAlpha: 0.30,     // Quick response to new emotional expressions
    overtakeMargin: 0.10,     // Easily lets new emotions take the lead
  }
};

// ==========================================
// 2. GEOMETRIC HELPER FUNCTIONS
// ==========================================

export function euclideanDistance(p1, p2) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.hypot(dx, dy);
}

export function computeCenter(points) {
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < points.length; i++) {
    sumX += points[i].x;
    sumY += points[i].y;
  }
  return { x: sumX / points.length, y: sumY / points.length };
}

export function computeEyeEAR(eyePoints) {
  if (!eyePoints || eyePoints.length < 6) return 0;
  const vertical1 = euclideanDistance(eyePoints[1], eyePoints[5]);
  const vertical2 = euclideanDistance(eyePoints[2], eyePoints[4]);
  const horizontal = euclideanDistance(eyePoints[0], eyePoints[3]);
  if (horizontal === 0) return 0;
  return (vertical1 + vertical2) / (2.0 * horizontal);
}

export function computeAverageEAR(landmarks) {
  const pts = getNormalizedLandmarks(landmarks);
  if (pts.length < 68) return 0;
  const earRight = computeEyeEAR(pts.slice(36, 42));
  const earLeft = computeEyeEAR(pts.slice(42, 48));
  return (earRight + earLeft) / 2.0;
}

export function computeMAR(landmarks) {
  const pts = getNormalizedLandmarks(landmarks);
  if (pts.length < 68) return 0;
  const height = euclideanDistance(pts[51], pts[57]);
  const width = euclideanDistance(pts[48], pts[54]);
  return width === 0 ? 0 : height / width;
}

export function computeEyebrowRaiseRatio(landmarks) {
  const pts = getNormalizedLandmarks(landmarks);
  if (pts.length < 68) return 0;

  const rightEyeCenter = computeCenter(pts.slice(36, 42));
  const leftEyeCenter = computeCenter(pts.slice(42, 48));
  const interocularDist = euclideanDistance(rightEyeCenter, leftEyeCenter);
  if (interocularDist === 0) return 0;

  // Middle of eyebrow arch: pts 19 (right) & 24 (left)
  const distRight = euclideanDistance(pts[19], rightEyeCenter);
  const distLeft = euclideanDistance(pts[24], leftEyeCenter);
  const avgDist = (distRight + distLeft) / 2.0;

  return avgDist / interocularDist;
}

export function computeBrowFurrowRatio(landmarks) {
  const pts = getNormalizedLandmarks(landmarks);
  if (pts.length < 68) return 1.0;

  const dist = euclideanDistance(pts[21], pts[22]);
  const rightEyeCenter = computeCenter(pts.slice(36, 42));
  const leftEyeCenter = computeCenter(pts.slice(42, 48));
  const interocularDist = euclideanDistance(rightEyeCenter, leftEyeCenter);
  if (interocularDist === 0) return 1.0;

  return dist / interocularDist;
}

export function computeSmirkAsymmetry(landmarks) {
  const pts = getNormalizedLandmarks(landmarks);
  if (pts.length < 68) return 0;

  const rightEyeCenter = computeCenter(pts.slice(36, 42));
  const leftEyeCenter = computeCenter(pts.slice(42, 48));
  const eyeDx = leftEyeCenter.x - rightEyeCenter.x;
  const eyeDy = leftEyeCenter.y - rightEyeCenter.y;
  const eyeDist = Math.hypot(eyeDx, eyeDy);
  if (eyeDist === 0) return 0;

  const ux = eyeDx / eyeDist;
  const uy = eyeDy / eyeDist;
  const vx = -uy;
  const vy = ux;

  const leftCorner = pts[48];
  const rightCorner = pts[54];
  const mouthDx = rightCorner.x - leftCorner.x;
  const mouthDy = rightCorner.y - leftCorner.y;
  const mouthWidth = Math.hypot(mouthDx, mouthDy);
  if (mouthWidth === 0) return 0;

  const perpOffset = (mouthDx * vx + mouthDy * vy);
  return Math.abs(perpOffset / mouthWidth);
}

export function getNormalizedLandmarks(landmarks) {
  if (!landmarks) return [];
  if (Array.isArray(landmarks)) return landmarks;
  if (landmarks.positions && Array.isArray(landmarks.positions)) return landmarks.positions;
  if (typeof landmarks.getPositions === 'function') return landmarks.getPositions();
  return [];
}

// ==========================================
// 3. MULTI-EMOTION EVENT CLASSIFIER CLASS
// ==========================================

export class FaceEventClassifier {
  constructor(customConfig = {}) {
    this.config = {
      thresholds: { ...CONFIG.thresholds, ...(customConfig.thresholds || {}) },
      cooldowns: { ...CONFIG.cooldowns, ...(customConfig.cooldowns || {}) },
      stabilizer: { ...CONFIG.stabilizer, ...(customConfig.stabilizer || {}) },
    };

    this.lastGlobalEventTime = -Infinity;
    this.lastEventTimeByType = {};

    this.neutralStartTime = null;
    this.hasFiredNeutralLongInStreak = false;
  }

  processFrame(expressions, landmarks, timestamp = performance.now()) {
    if (!expressions) return null;

    const t = this.config.thresholds;
    const cd = this.config.cooldowns;

    // 1. Calculate geometric ratios
    const mar = computeMAR(landmarks);
    const ear = computeAverageEAR(landmarks);
    const eyebrowRatio = computeEyebrowRaiseRatio(landmarks);
    const browFurrowRatio = computeBrowFurrowRatio(landmarks);
    const smirkIndex = computeSmirkAsymmetry(landmarks);

    // 2. Track neutral streak
    const neutralScore = expressions.neutral || 0;
    if (neutralScore >= t.neutralScore) {
      if (this.neutralStartTime === null) {
        this.neutralStartTime = timestamp;
        this.hasFiredNeutralLongInStreak = false;
      }
    } else {
      this.neutralStartTime = null;
      this.hasFiredNeutralLongInStreak = false;
    }

    // 3. Collect ALL eligible candidates with a normalized salience score
    const candidates = [];

    // HAPPY / SMILE
    const happy = expressions.happy || 0;
    if (happy >= t.happyScore) {
      candidates.push({ type: 'happy', score: happy, details: { score: Number(happy.toFixed(2)) } });
    }

    // SAD / POUT / SORROW (multiplied slightly to match perceived expressiveness)
    const sad = (expressions.sad || 0) * 1.35;
    if (sad >= t.sadScore) {
      candidates.push({ type: 'sad', score: sad, details: { score: Number(sad.toFixed(2)) } });
    }

    // DISGUST / REPUGNANCE
    const disgust = (expressions.disgusted || 0) * 1.35;
    if (disgust >= t.disgustScore) {
      candidates.push({ type: 'disgust', score: disgust, details: { score: Number(disgust.toFixed(2)) } });
    }

    // ANGER / SCOWL (combines anger score & brow furrow)
    const angryRaw = (expressions.angry || 0) * 1.35;
    const isFurrowed = browFurrowRatio <= t.browFurrowRatio && neutralScore < 0.75;
    if (angryRaw >= t.angryScore || isFurrowed) {
      const angerScore = Math.max(angryRaw, isFurrowed ? 0.60 : 0);
      candidates.push({
        type: 'anger',
        score: angerScore,
        details: { angryScore: Number(angryRaw.toFixed(2)), browFurrowRatio: Number(browFurrowRatio.toFixed(2)) }
      });
    }

    // SURPRISE / DISBELIEF / SHOCK
    const surprised = Math.max((expressions.surprised || 0), (expressions.fearful || 0) * 1.2);
    if (surprised >= t.surprisedScore) {
      candidates.push({ type: 'disbelief', score: surprised, details: { surprisedScore: Number(surprised.toFixed(2)) } });
    }

    // SMIRK
    if (smirkIndex >= t.smirkAsymmetry && happy < 0.60) {
      candidates.push({
        type: 'smirk',
        score: Math.min(1.0, smirkIndex * 6),
        details: { smirkAsymmetry: Number(smirkIndex.toFixed(3)) }
      });
    }

    // SQUINT
    if (ear > 0.04 && ear <= t.squintEAR) {
      candidates.push({ type: 'squint', score: 0.55, details: { ear: Number(ear.toFixed(3)) } });
    }

    // YAWN
    if (mar >= t.yawnMAR) {
      candidates.push({ type: 'yawn', score: mar, details: { mar: Number(mar.toFixed(3)) } });
    }

    // NEUTRAL LONG
    if (
      this.neutralStartTime !== null &&
      !this.hasFiredNeutralLongInStreak &&
      (timestamp - this.neutralStartTime) >= t.neutralDurationMs
    ) {
      candidates.push({
        type: 'neutral_long',
        score: neutralScore,
        details: { durationMs: Math.round(timestamp - this.neutralStartTime) }
      });
    }

    if (candidates.length === 0) return null;

    // 4. Filter candidates by SAME-EVENT COOLDOWN (prevents fixating on any one gesture/emotion)
    const validCandidates = candidates.filter(cand => {
      const lastSame = this.lastEventTimeByType[cand.type] ?? -Infinity;
      const cooldown = cand.type === 'neutral_long'
        ? cd.neutralLongCooldownMs
        : cd.sameEventCooldownMs;
      return (timestamp - lastSame) >= cooldown;
    });

    if (validCandidates.length === 0) return null;

    // 5. Global rate limit check
    if ((timestamp - this.lastGlobalEventTime) < cd.globalCooldownMs) {
      return null;
    }

    // 6. Pick the candidate with the HIGHEST salience score
    validCandidates.sort((a, b) => b.score - a.score);
    const chosen = validCandidates[0];

    // 7. Update state & emit
    this.lastGlobalEventTime = timestamp;
    this.lastEventTimeByType[chosen.type] = timestamp;

    if (chosen.type === 'neutral_long') {
      this.hasFiredNeutralLongInStreak = true;
    }

    return {
      type: chosen.type,
      timestamp: Math.round(timestamp),
      score: Number(chosen.score.toFixed(2)),
      details: chosen.details,
    };
  }

  getRatios(landmarks) {
    return {
      mar: Number(computeMAR(landmarks).toFixed(3)),
      ear: Number(computeAverageEAR(landmarks).toFixed(3)),
      eyebrowRatio: Number(computeEyebrowRaiseRatio(landmarks).toFixed(3)),
      browFurrowRatio: Number(computeBrowFurrowRatio(landmarks).toFixed(3)),
      smirkAsymmetry: Number(computeSmirkAsymmetry(landmarks).toFixed(3)),
    };
  }

  updateConfig(newConfig) {
    if (newConfig.thresholds) Object.assign(this.config.thresholds, newConfig.thresholds);
    if (newConfig.cooldowns) Object.assign(this.config.cooldowns, newConfig.cooldowns);
    if (newConfig.stabilizer) Object.assign(this.config.stabilizer, newConfig.stabilizer);
  }
}

// ==========================================
// 4. BALANCED EMOTION STABILIZER
// ==========================================

export class SingleEmotionStabilizer {
  constructor(customConfig = {}) {
    this.minHoldDurationMs = customConfig.minHoldDurationMs ?? CONFIG.stabilizer.minHoldDurationMs;
    this.smoothingAlpha = customConfig.smoothingAlpha ?? CONFIG.stabilizer.smoothingAlpha;
    this.overtakeMargin = customConfig.overtakeMargin ?? CONFIG.stabilizer.overtakeMargin;

    this.smoothedScores = {};
    this.currentEmotion = 'neutral';
    this.currentEmotionScore = 1.0;
    this.currentEmotionStartTime = null;
    this.lastUpdateTime = null;

    this.emojis = {
      neutral: '😐',
      happy: '😊',
      sad: '😢',
      angry: '😠',
      fearful: '😨',
      disgusted: '🤢',
      surprised: '😲'
    };
  }

  update(rawExpressions, timestamp = performance.now()) {
    if (this.currentEmotionStartTime === null) {
      this.currentEmotionStartTime = timestamp;
      this.lastUpdateTime = timestamp;
    }

    if (!rawExpressions) {
      return this.getState(timestamp);
    }

    // Weight raw expressions to balance naturally quiet emotions (sad, disgust, anger) against happy/neutral
    const weights = {
      happy: 1.0,
      sad: 1.45,
      disgusted: 1.40,
      angry: 1.40,
      surprised: 1.15,
      fearful: 1.30,
      neutral: 0.80 // slightly reduce neutral dominance
    };

    // EMA smoothing
    for (const [emotion, rawScore] of Object.entries(rawExpressions)) {
      const weighted = rawScore * (weights[emotion] || 1.0);
      const prev = this.smoothedScores[emotion] ?? weighted;
      this.smoothedScores[emotion] = (this.smoothingAlpha * weighted) + ((1 - this.smoothingAlpha) * prev);
    }

    // Best candidate
    let bestEmotion = 'neutral';
    let maxSmoothedScore = -1;
    for (const [emotion, score] of Object.entries(this.smoothedScores)) {
      if (score > maxSmoothedScore) {
        maxSmoothedScore = score;
        bestEmotion = emotion;
      }
    }

    const holdElapsed = timestamp - this.currentEmotionStartTime;
    const isHoldExpired = holdElapsed >= this.minHoldDurationMs;
    const currentScore = this.smoothedScores[this.currentEmotion] || 0;
    const canOvertakeEarly = (maxSmoothedScore - currentScore) > this.overtakeMargin && maxSmoothedScore > 0.30;

    if (bestEmotion !== this.currentEmotion && (isHoldExpired || canOvertakeEarly)) {
      this.currentEmotion = bestEmotion;
      this.currentEmotionStartTime = timestamp;
    }

    this.currentEmotionScore = this.smoothedScores[this.currentEmotion] || maxSmoothedScore;
    this.lastUpdateTime = timestamp;

    return this.getState(timestamp);
  }

  getState(timestamp = performance.now()) {
    const elapsed = Math.max(0, timestamp - this.currentEmotionStartTime);
    return {
      emotion: this.currentEmotion,
      emoji: this.emojis[this.currentEmotion] || '😐',
      score: Number((this.currentEmotionScore || 0).toFixed(2)),
      durationMs: Math.round(elapsed),
      heldSeconds: (elapsed / 1000).toFixed(1),
    };
  }
}

if (typeof window !== 'undefined') {
  window.FaceEventClassifier = FaceEventClassifier;
  window.SingleEmotionStabilizer = SingleEmotionStabilizer;
  window.FaceEventConfig = CONFIG;
  window.computeMAR = computeMAR;
  window.computeAverageEAR = computeAverageEAR;
  window.computeEyebrowRaiseRatio = computeEyebrowRaiseRatio;
  window.computeBrowFurrowRatio = computeBrowFurrowRatio;
  window.computeSmirkAsymmetry = computeSmirkAsymmetry;
}
