# OSCC Mock Service

A lightweight Node.js (Express) mock service mimicking the Mitel OpenScape Contact Center V12 Web Interaction REST API for local testing.

---

## Features

- **OAuth2 Token Auth:** Basic authentication endpoint (`/webinteractionsdk/oauth2/token` and `/oauth/token`).
- **Bearer Token Protected API:** Endpoints under `/v1/*` and `/webinteractionsdk/v1/*`.
- **Session API:** Session creation, content polling with indexKey, customer messaging, typing indication, and session disconnect.
- **Agent Console UI:** Single-page agent interface served at `/agent.html` with real-time polling, message history, typing indicators, and disconnect.
- **In-Memory Storage:** No external database required. Disconnected sessions remain queryable for 5 minutes.
- **Request Logging:** Logs every incoming request `(method, path, status)` to the console.

---

## How to Run

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Server
- **Standard start:**
  ```bash
  npm start
  ```
- **Development with auto-reload:**
  ```bash
  npm run dev
  ```

### 3. Change Port (Default: 3000)
- **PowerShell:**
  ```powershell
  $env:PORT=4000; npm start
  ```
- **Command Prompt (cmd):**
  ```cmd
  set PORT=4000 && npm start
  ```
- **Bash / Linux / macOS:**
  ```bash
  PORT=4000 npm start
  ```

### 4. Open Mock Agent Console
Open your browser and visit:
```
http://localhost:3000/agent.html
```

---

## API Testing Flow with `curl`

Default credentials:
- **Client ID:** `mockclient`
- **Client Secret:** `mocksecret`
- Basic Auth header: `Basic bW9ja2NsaWVudDptb2Nrc2VjcmV0`

### 1. Get Access Token
```bash
curl -X POST http://localhost:3000/webinteractionsdk/oauth2/token \
  -H "Authorization: Basic bW9ja2NsaWVudDptb2Nrc2VjcmV0" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials"
```
**Response:**
```json
{
  "access_token": "<token-uuid>",
  "token_type": "bearer",
  "scope": "all"
}
```

---

### 2. Create a Session
Replace `<TOKEN>` with the token received:
```bash
curl -X POST http://localhost:3000/v1/sessions \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "businessUnitName": "Support",
    "caption": "Need help with billing inquiry",
    "customerName": "John Doe",
    "language": "en",
    "priority": 10,
    "source": "WebChat"
  }'
```
**Response:**
```json
{
  "sessionId": "W1234567890abcdef..."
}
```

---

### 3. Poll Session Contents (All or by `indexKey`)
- **Get all contents (or indexKey 0):**
  ```bash
  curl -X GET http://localhost:3000/v1/sessions/<SESSION_ID>/contents \
    -H "Authorization: Bearer <TOKEN>"
  ```
- **Get contents starting from indexKey (e.g. 1-based, inclusive):**
  ```bash
  curl -X GET http://localhost:3000/v1/sessions/<SESSION_ID>/contents/3 \
    -H "Authorization: Bearer <TOKEN>"
  ```

---

### 4. Customer Sends a Message
```bash
curl -X POST http://localhost:3000/v1/sessions/<SESSION_ID>/contents \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello, can someone check my recent payment?"}'
```

---

### 5. Customer Sends Typing Indicator
```bash
curl -X POST http://localhost:3000/v1/sessions/<SESSION_ID>/typing \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"isTyping": true}'
```

---

### 6. Agent Sends a Message (Mock Agent API)
*(Or reply directly using the browser UI at `/agent.html`)*
```bash
curl -X POST http://localhost:3000/mock/sessions/<SESSION_ID>/agent-message \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello John, I am looking into your account now.",
    "agentKey": "14",
    "firstName": "Sarah",
    "lastName": "Connor"
  }'
```

---

### 7. Poll Again (Verify Agent Message Received)
```bash
curl -X GET http://localhost:3000/v1/sessions/<SESSION_ID>/contents/3 \
  -H "Authorization: Bearer <TOKEN>"
```

---

### 8. Disconnect Session
- **Using Session ID URL parameter:**
  ```bash
  curl -X DELETE http://localhost:3000/v1/sessions/<SESSION_ID> \
    -H "Authorization: Bearer <TOKEN>"
  ```
- **Or using request body:**
  ```bash
  curl -X DELETE http://localhost:3000/v1/sessions \
    -H "Authorization: Bearer <TOKEN>" \
    -H "Content-Type: application/json" \
    -d '{"sessionId": "<SESSION_ID>"}'
  ```

*Note: The session will stay queryable for 5 minutes after disconnect before being automatically purged (returning 404).*
