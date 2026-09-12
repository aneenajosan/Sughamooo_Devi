import json
import os
import urllib.request
import urllib.error

from flask import Flask, request, jsonify

app = Flask(__name__)


def get_groq_api_key():
    return os.environ.get("GROQ_API_KEY", "")


@app.route("/api/status", methods=["GET"])
def status():
    api_key = get_groq_api_key()
    has_key = bool(api_key and api_key.startswith("gsk_"))

    return jsonify({
        "hasKey": has_key,
        "status": "Ready" if has_key else "Missing API Key"
    })


@app.route("/api/commentary", methods=["POST"])
def commentary():

    payload = request.get_json(silent=True)

    if not payload:
        return jsonify({
            "error": "Invalid JSON body"
        }), 400

    api_key = get_groq_api_key()

    if not api_key:
        return jsonify({
            "error": "GROQ_API_KEY is not configured"
        }), 401

    trigger = payload.get("trigger", "")
    emotion = payload.get("emotion", "neutral")
    event_type = payload.get("eventType", "")
    time_withheld = payload.get("timeWithheldSec", "0")
    prev_emotion = payload.get("prevEmotion", "neutral")
    prev_time_withheld = payload.get("prevTimeWithheldSec", "0")
    score = payload.get("score", 1.0)

    if trigger == "discrete_event":

        descriptions = {
            "happy": "The user is genuinely smiling with pure joy and happiness on their face!",
            "sad": "The user looks visibly sad, crestfallen, or sorrowful — almost in tears!",
            "disgust": "The user has a strong expression of disgust, distaste, or revulsion on their face!",
            "disbelief": "The user looks completely stunned, wide-eyed in total shock and disbelief!",
            "anger": "The user is glaring with intense anger, furrowed brows, and fierce irritation!",
            "smirk": "The user is flashing a sly, mischievous, one-sided smirk!",
            "squint": "The user is squinting their eyes suspiciously with sharp skepticism!",
            "yawn": "The user let out a wide, tired yawn — totally bored or sleepy!"
        }

        prompt_context = descriptions.get(
            event_type,
            f"The user just made a notable facial expression: {event_type}!"
        )

    elif trigger in ("neutral_persisted_5s", "neutral_prolonged"):

        prompt_context = (
            f"The user has been showing a completely blank, expressionless "
            f"poker face for {time_withheld} seconds without any reaction at all."
        )

    else:

        prompt_context = (
            f"The user suddenly switched to a '{emotion}' expression "
            f"(confidence: {int(score * 100)}%), coming right after "
            f"holding '{prev_emotion}' for {prev_time_withheld} seconds."
        )

    models_to_try = [
        "qwen/qwen3.8-27b",
        "groq/compound-mini"
    ]

    last_error = None

    for model_name in models_to_try:

        groq_payload = {
            "model": model_name,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are an electrifying live sports commentator "
                        "narrating a person's real-time facial expressions "
                        "as if it's a high-stakes sporting event. "
                        "Bring the energy, drama, and excitement of a live broadcast.\n"
                        "Rules:\n"
                        "1. Reply ONLY in English.\n"
                        "2. Exactly 1 or 2 sentences, max 25 words. "
                        "Short, punchy, high-energy.\n"
                        "3. Use sports commentary language.\n"
                        "4. React specifically to the emotion — don't be generic.\n"
                        "5. NO hashtags, NO markdown, NO quotation marks."
                    )
                },
                {
                    "role": "user",
                    "content": prompt_context
                }
            ],
            "temperature": 0.85,
            "max_tokens": 80
        }

        try:

            req = urllib.request.Request(
                "https://api.groq.com/openai/v1/chat/completions",
                data=json.dumps(groq_payload).encode("utf-8"),
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                    "User-Agent": "Mozilla/5.0"
                }
            )

            with urllib.request.urlopen(req, timeout=10) as resp:

                resp_data = json.loads(
                    resp.read().decode("utf-8")
                )

                comment = (
                    resp_data
                    .get("choices", [{}])[0]
                    .get("message", {})
                    .get("content", "")
                    .strip()
                )

                if comment:
                    return jsonify({
                        "comment": comment
                    })

        except urllib.error.HTTPError as e:

            err_body = e.read().decode(
                "utf-8",
                errors="ignore"
            )

            last_error = f"Groq HTTP {e.code}: {err_body}"

        except Exception as e:

            last_error = str(e)

    return jsonify({
        "error": last_error or "Failed to generate commentary"
    }), 500
