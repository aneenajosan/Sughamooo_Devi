# Sughamo Devi - Emotion Commentary App

This is a web application that performs real-time face emotion detection locally using `face-api.js` and generates live "sports-style" commentary on the user's emotional changes using Groq's LLM APIs.

## Deployment

This app is ready to be deployed to any platform that supports Docker or basic Python environments (e.g., Render, Railway, Heroku, AWS).

### Environment Variables
You must set the following environment variable on your deployment platform:
- `GROQ_API_KEY`: Your API key from Groq.

### Docker Deployment
1. Build the image:
   ```bash
   docker build -t sughamo-devi .
   ```
2. Run the container:
   ```bash
   docker run -p 8080:8080 -e GROQ_API_KEY=your_key_here sughamo-devi
   ```

### Standard Deployment (Render/Railway/etc.)
- **Build Command**: (Leave empty, or `pip install -r requirements.txt`)
- **Start Command**: `python server.py`
- **Port**: 8080

## Local Development
1. Clone the repository.
2. Create a `.env` file in the root directory and add `GROQ_API_KEY=your_key_here`.
3. Run the server: `python server.py`.
4. Open `http://localhost:8080` in your browser.
