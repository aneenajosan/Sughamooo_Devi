/**
 * Groq AI Running Commentary & Emotion Queue System
 * Tracks emotion durations ("time withheld") and handles discrete expressive events (eyebrow raises, anger, smirks, etc.).
 */

export class GroqCommentarySystem {
  constructor(options = {}) {
    this.endpoint = options.endpoint || '/api/commentary';
    this.statusEndpoint = options.statusEndpoint || '/api/status';
    this.onCommentary = options.onCommentary || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onSpeechStart = options.onSpeechStart || (() => {});
    this.onSpeechEnd = options.onSpeechEnd || (() => {});
    this.onCommentaryQueued = options.onCommentaryQueued || (() => {});

    // State tracking
    this.currentSegment = null;
    this.emotionHistory = [];
    this.hasCommentedOnCurrentNeutral = false;
    this.lastNeutralCommentTime = 0;

    // Queue & request concurrency
    this.requestQueue = [];
    this.isRequestInFlight = false;
    this.enableVoice = options.enableVoice ?? false;

    // Speech synthesis state machine
    this.isSpeaking = false;
    this.pendingCommentary = null;
    this.currentEmotionForTTS = 'Neutral';
    this.activeUtterance = null;
    this.speechSafetyTimer = null;

    // Minimum interval between commentary calls
    this.minCallIntervalMs = options.minCallIntervalMs ?? 1400;
    this.lastApiCallTime = -Infinity;

    // Check backend status and poll
    this.checkBackendStatus();
    this.statusPollInterval = setInterval(() => this.checkBackendStatus(), 3000);
  }

  // -------------------------------------------------------------------
  // Speech synthesis system
  // -------------------------------------------------------------------
  speakCommentary(comment, event = {}) {
    if (!this.enableVoice || typeof window === 'undefined' || !window.speechSynthesis) {
      this.onSpeechEnd?.(event);
      return;
    }

    if (this.isSpeaking) {
      // Store ONLY the latest incoming commentary, skipping intermediate ones
      this.pendingCommentary = { comment, event };
      return;
    }

    this._speakCommentaryItem(comment, event);
  }

  _speakCommentaryItem(comment, event = {}) {
    if (!this.enableVoice || typeof window === 'undefined' || !window.speechSynthesis) {
      this.isSpeaking = false;
      this.onSpeechEnd?.(event);
      return;
    }

    this.isSpeaking = true;
    this.onSpeechStart?.(event, comment);

    const utter = new SpeechSynthesisUtterance(comment);
    utter.rate = 1.05;
    utter.pitch = 1.0;
    this.activeUtterance = utter;

    let ended = false;
    if (this.speechSafetyTimer) {
      clearTimeout(this.speechSafetyTimer);
      this.speechSafetyTimer = null;
    }

    const onCommentaryFinished = () => {
      if (ended) return;
      ended = true;
      if (this.speechSafetyTimer) {
        clearTimeout(this.speechSafetyTimer);
        this.speechSafetyTimer = null;
      }
      this.activeUtterance = null;

      // Check if another commentary arrived while reading
      if (this.pendingCommentary && this.enableVoice) {
        const next = this.pendingCommentary;
        this.pendingCommentary = null;
        setTimeout(() => {
          if (this.enableVoice) {
            this._speakCommentaryItem(next.comment, next.event);
          } else {
            this.isSpeaking = false;
            this.onSpeechEnd?.(event);
          }
        }, 400);
      } else {
        this.isSpeaking = false;
        this.onSpeechEnd?.(event);
      }
    };

    utter.onend = onCommentaryFinished;
    utter.onerror = (err) => {
      console.warn('[TTS] Commentary utterance error:', err);
      onCommentaryFinished();
    };

    // Safety timeout in case browser TTS hangs without firing onend
    const safeDurationMs = Math.max(5000, Math.min(22000, (comment.length / 8) * 1000 + 4000));
    this.speechSafetyTimer = setTimeout(() => {
      if (!ended) {
        console.warn('[TTS] Speech safety timeout reached');
        onCommentaryFinished();
      }
    }, safeDurationMs);

    window.speechSynthesis.speak(utter);
  }

  speakText(text) {
    this.speakCommentary(text, {});
  }

  async checkBackendStatus() {
    try {
      const res = await fetch(this.statusEndpoint);
      if (res.ok) {
        const data = await res.json();
        if (data.hasKey) {
          this.onStatusChange('Ready (.env configured)');
          if (this.statusPollInterval) {
            clearInterval(this.statusPollInterval);
            this.statusPollInterval = setInterval(() => this.checkBackendStatus(), 10000);
          }
        } else {
          this.onStatusChange('Missing Key in .env');
        }
      }
    } catch (e) {
      this.onStatusChange('Server offline');
    }
  }

  setVoice(enabled) {
    this.enableVoice = Boolean(enabled);
    if (!this.enableVoice) {
      if (this.speechSafetyTimer) {
        clearTimeout(this.speechSafetyTimer);
        this.speechSafetyTimer = null;
      }
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        window.speechSynthesis.cancel();
      }
      this.isSpeaking = false;
      this.pendingCommentary = null;
      this.activeUtterance = null;
      this.onSpeechEnd?.(null);
    }
  }

  /**
   * Called when a discrete gesture/event occurs (eyebrow_raise, anger, smirk, squint, yawn, big_smile)
   */
  enqueueDiscreteEvent(event, timestamp = performance.now()) {
    if (!event) return;
    this.currentEmotionForTTS = event.eventType || event.type || 'Neutral';

    this.enqueueCommentaryRequest({
      trigger: 'discrete_event',
      eventType: event.type,
      emotion: event.type,
      score: event.score,
      details: event.details,
      timestamp
    });
  }

  /**
   * Called on every frame or detection tick
   * @param {string} emotion - The active emotion ('neutral', 'happy', 'surprised', 'angry', etc.)
   * @param {number} timestamp - Current timestamp in ms
   * @param {number} score - Confidence score (0.0 - 1.0)
   */
  tick(emotion, timestamp = performance.now(), score = 1.0) {
    if (!emotion) return;
    this.currentEmotionForTTS = emotion;

    if (!this.currentSegment) {
      this.currentSegment = {
        emotion,
        startTime: timestamp,
        lastUpdateTime: timestamp,
        score,
        withheldMs: 0
      };
      this.hasCommentedOnCurrentNeutral = false;
      return;
    }

    // Check if emotion has changed
    if (this.currentSegment.emotion !== emotion) {
      const prevSegment = {
        ...this.currentSegment,
        endTime: timestamp,
        withheldMs: timestamp - this.currentSegment.startTime
      };
      this.emotionHistory.push(prevSegment);
      if (this.emotionHistory.length > 20) this.emotionHistory.shift();

      this.currentSegment = {
        emotion,
        startTime: timestamp,
        lastUpdateTime: timestamp,
        score,
        withheldMs: 0
      };
      this.hasCommentedOnCurrentNeutral = false;

      // When switching to any non-neutral emotion, comment immediately!
      if (emotion !== 'neutral') {
        this.enqueueCommentaryRequest({
          trigger: 'immediate_emotion',
          emotion: emotion,
          score: score,
          timeWithheldSec: 0,
          prevEmotion: prevSegment.emotion,
          prevTimeWithheldSec: (prevSegment.withheldMs / 1000).toFixed(1),
          timestamp
        });
      }
    } else {
      this.currentSegment.lastUpdateTime = timestamp;
      this.currentSegment.score = score;
      const currentWithheldMs = timestamp - this.currentSegment.startTime;
      this.currentSegment.withheldMs = currentWithheldMs;

      // If neutral persists for > 5 seconds, talk about it
      if (emotion === 'neutral') {
        const neutralSeconds = currentWithheldMs / 1000;
        if (currentWithheldMs >= 5000 && !this.hasCommentedOnCurrentNeutral) {
          this.hasCommentedOnCurrentNeutral = true;
          this.lastNeutralCommentTime = timestamp;
          this.enqueueCommentaryRequest({
            trigger: 'neutral_persisted_5s',
            emotion: 'neutral',
            score: score,
            timeWithheldSec: neutralSeconds.toFixed(1),
            prevEmotion: this.emotionHistory.length > 0 ? this.emotionHistory[this.emotionHistory.length - 1].emotion : 'start',
            prevTimeWithheldSec: this.emotionHistory.length > 0 ? (this.emotionHistory[this.emotionHistory.length - 1].withheldMs / 1000).toFixed(1) : '0',
            timestamp
          });
        }
        // Recurring commentary every 8s of sustained neutral
        else if (currentWithheldMs >= 13000 && (timestamp - this.lastNeutralCommentTime) >= 8000) {
          this.lastNeutralCommentTime = timestamp;
          this.enqueueCommentaryRequest({
            trigger: 'neutral_prolonged',
            emotion: 'neutral',
            score: score,
            timeWithheldSec: neutralSeconds.toFixed(1),
            prevEmotion: 'neutral',
            prevTimeWithheldSec: neutralSeconds.toFixed(1),
            timestamp
          });
        }
      }
    }
  }

  enqueueCommentaryRequest(eventData) {
    // Notify listener that a commentary event was enqueued
    this.onCommentaryQueued?.(eventData);

    // If a discrete event or non-neutral emotion arrives, place it at front of queue
    if (eventData.trigger === 'discrete_event' || eventData.trigger === 'immediate_emotion') {
      this.requestQueue.unshift(eventData);
    } else {
      this.requestQueue.push(eventData);
    }
    // Cap queue length to avoid stale backlog
    if (this.requestQueue.length > 3) {
      this.requestQueue = this.requestQueue.slice(0, 3);
    }
    this.processQueue();
  }

  async processQueue() {
    if (this.isRequestInFlight) return;
    if (this.requestQueue.length === 0) return;

    // If TTS is currently reading out a commentary, wait for it to finish
    // Prune the queue to keep only the newest event so intermediate ones are skipped
    if (this.enableVoice && this.isSpeaking) {
      if (this.requestQueue.length > 1) {
        this.requestQueue = [this.requestQueue[this.requestQueue.length - 1]];
      }
      setTimeout(() => this.processQueue(), 600);
      return;
    }

    const now = performance.now();
    const timeSinceLastCall = now - this.lastApiCallTime;
    if (timeSinceLastCall < this.minCallIntervalMs) {
      setTimeout(() => this.processQueue(), this.minCallIntervalMs - timeSinceLastCall);
      return;
    }

    const event = this.requestQueue.shift();
    this.isRequestInFlight = true;
    this.lastApiCallTime = performance.now();

    try {
      this.onStatusChange('Generating commentary...');
      const comment = await this.callBackendCommentary(event);
      this.onCommentary(comment, event);
      this.onStatusChange('Ready (.env configured)');

      if (this.enableVoice) {
        this.speakCommentary(comment, event);
      } else {
        this.onSpeechEnd?.(event);
      }
    } catch (err) {
      console.error('Commentary Error:', err);
      this.onError(err.message || 'Error generating commentary');
      this.onStatusChange(err.message.includes('.env') ? 'Missing Key in .env' : 'Error');
      this.onSpeechEnd?.(event);
    } finally {
      this.isRequestInFlight = false;
      if (this.requestQueue.length > 0) {
        setTimeout(() => this.processQueue(), 400);
      }
    }
  }

  async callBackendCommentary(event) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(event)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}: ${response.statusText}`);
    }

    return data.comment || `User showing ${event.eventType || event.emotion}.`;
  }
}

if (typeof window !== 'undefined') {
  window.GroqCommentarySystem = GroqCommentarySystem;
}
