import http.server
import socketserver
import json
import urllib.request
import urllib.error
import os

PORT = 8080

def get_groq_api_key():
    """Read GROQ_API_KEY from .env file dynamically."""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if os.path.exists(env_path):
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line.startswith('GROQ_API_KEY='):
                    key = line.split('=', 1)[1].strip().strip('"').strip("'")
                    if key and key != 'your_groq_api_key_here':
                        return key
    return os.environ.get('GROQ_API_KEY', '')

class AppHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        clean_path = self.path.split('?')[0].rstrip('/')
        if clean_path == '/api/status':
            api_key = get_groq_api_key()
            has_key = bool(api_key and api_key.startswith('gsk_'))
            data = {
                'hasKey': has_key,
                'status': 'Ready' if has_key else 'Missing API Key in .env'
            }
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode('utf-8'))
            return
        
        # Static file serving
        return super().do_GET()

    def do_POST(self):
        clean_path = self.path.split('?')[0].rstrip('/')
        if clean_path == '/api/commentary':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            
            try:
                payload = json.loads(body.decode('utf-8'))
            except Exception:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': 'Invalid JSON body'}).encode('utf-8'))
                return

            api_key = get_groq_api_key()
            if not api_key or api_key == 'your_groq_api_key_here':
                self.send_response(401)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({
                    'error': 'GROQ_API_KEY is not configured in .env file.'
                }).encode('utf-8'))
                return

            # Build commentary prompt context
            trigger = payload.get('trigger', '')
            emotion = payload.get('emotion', 'neutral')
            event_type = payload.get('eventType', '')
            time_withheld = payload.get('timeWithheldSec', '0')
            prev_emotion = payload.get('prevEmotion', 'neutral')
            prev_time_withheld = payload.get('prevTimeWithheldSec', '0')
            score = payload.get('score', 1.0)

            if trigger == 'discrete_event':
                descriptions = {
                    'happy': 'The user is genuinely smiling with pure joy and happiness on their face!',
                    'sad': 'The user looks visibly sad, crestfallen, or sorrowful — almost in tears!',
                    'disgust': 'The user has a strong expression of disgust, distaste, or revulsion on their face!',
                    'disbelief': 'The user looks completely stunned, wide-eyed in total shock and disbelief!',
                    'anger': 'The user is glaring with intense anger, furrowed brows, and fierce irritation!',
                    'smirk': 'The user is flashing a sly, mischievous, one-sided smirk!',
                    'squint': 'The user is squinting their eyes suspiciously with sharp skepticism!',
                    'yawn': 'The user let out a wide, tired yawn — totally bored or sleepy!'
                }
                prompt_context = descriptions.get(event_type, f"The user just made a notable facial expression: {event_type}!")
            elif trigger in ('neutral_persisted_5s', 'neutral_prolonged'):
                prompt_context = f"The user has been showing a completely blank, expressionless poker face for {time_withheld} seconds without any reaction at all."
            else:
                prompt_context = f"The user suddenly switched to a '{emotion}' expression (confidence: {int(score * 100)}%), coming right after holding '{prev_emotion}' for {prev_time_withheld} seconds."

            # Models confirmed working on this Groq account
            models_to_try = ['qwen/qwen3.8-27b', 'groq/compound-mini']
            comment = None
            last_err = None

            for model_name in models_to_try:
                groq_payload = {
                    "model": model_name,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You are an electrifying live sports commentator narrating a person's real-time facial expressions "
                                "as if it's a high-stakes sporting event. Bring the energy, drama, and excitement of a live broadcast.\n"
                                "Rules:\n"
                                "1. Reply ONLY in English.\n"
                                "2. Exactly 1 or 2 sentences, max 25 words. Short, punchy, high-energy.\n"
                                "3. Use sports commentary language — 'And there it is!', 'OH! What a moment!', "
                                "'The crowd goes wild!', 'Unbelievable scenes!', 'He's feeling it now!'\n"
                                "4. React specifically to the emotion — don't be generic. Be vivid and dramatic.\n"
                                "5. NO hashtags, NO markdown, NO quotation marks in your reply."
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
                        'https://api.groq.com/openai/v1/chat/completions',
                        data=json.dumps(groq_payload).encode('utf-8'),
                        headers={
                            'Authorization': f'Bearer {api_key}',
                            'Content-Type': 'application/json',
                            'User-Agent': 'Mozilla/5.0'
                        }
                    )
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        resp_data = json.loads(resp.read().decode('utf-8'))
                        comment = resp_data.get('choices', [{}])[0].get('message', {}).get('content', '').strip()
                        if comment:
                            break
                except urllib.error.HTTPError as e:
                    err_body = e.read().decode('utf-8', errors='ignore')
                    last_err = f"Groq HTTP {e.code}: {err_body}"
                    print(f"[Groq ERR] {model_name}: HTTP {e.code} => {err_body[:200]}")
                except Exception as e:
                    last_err = str(e)
                    print(f"[Groq ERR] {model_name}: {e}")

            if comment:
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(json.dumps({'comment': comment}, ensure_ascii=False).encode('utf-8'))
            else:
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': last_err or 'Failed to generate commentary'}).encode('utf-8'))
            return

        self.send_response(404)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'error': f'Route not found: {self.path}'}).encode('utf-8'))

if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), AppHandler) as httpd:
        print(f"Server started at http://localhost:{PORT}")
        print("Reading GROQ_API_KEY from .env")
        httpd.serve_forever()
