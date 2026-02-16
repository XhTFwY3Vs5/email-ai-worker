# Email AI Worker

A unified Cloudflare Workers email processing solution that handles email summarization and notifications through multiple modes.

## Features

- **AI-Powered Summarization**: Uses Cloudflare AI to summarize email content
- **Multiple Modes**: Automatic mode detection based on email address
- **Flexible Notifications**: Support for ntfy.sh, Telegram, Pushover, and email forwarding
- **Spam Filtering**: Built-in spam detection with customizable threshold
- **Sender Filtering**: Whitelist and blacklist support
- **Rate Limiting**: Prevent spam with configurable rate limits (requires KV)
- **Threading**: Proper email threading with References/In-Reply-To headers
- **Multiple AI Models**: Different models per mode for cost/quality optimization
- **Web Dashboard**: Stats endpoint for monitoring

## Modes

The worker automatically detects which mode to use based on the recipient email address:

| Address | Mode | Behavior |
|---------|------|----------|
| `me@domain.com` | **header** (default) | Adds X-Email-Summary header, forwards to MAIN_EMAIL_ADDRESS |
| `me+reply@domain.com` | **reply** | Sends summary back to sender |
| `me+summary@domain.com` | **reply** | Sends summary back to sender |
| `me+anything@domain.com` | **notify** | Sends to ntfy topic or Telegram, forwards to MAIN_EMAIL_ADDRESS |

### Header Mode (Default)
Adds AI summary as `X-Email-Summary` header and forwards the email.

**Environment Variables:**
- `MODE=header` (default)
- `MAIN_EMAIL_ADDRESS` - where to forward emails (required)
- `PUSHOVER_ENABLED=true` - enable Pushover notifications
- `PUSHOVER_USER_KEY` - your Pushover user key
- `PUSHOVER_APP_TOKEN` - your Pushover app token
- `PUSHOVER_PRIORITY` - optional
- `PUSHOVER_SOUND` - optional
- `FORWARD_ORIGINAL=true` - forward full email instead of summary

### Reply Mode
Summarizes incoming emails and sends the summary back to the sender. Does not forward.

**Trigger:** `user+reply@domain.com` or `user+summary@domain.com`

### Notify Mode
Sends email summaries to ntfy.sh or Telegram, and forwards original email to MAIN_EMAIL_ADDRESS.

**Trigger:** `user+topic@domain.com` sends to ntfy.sh topic "topic"
**Trigger:** `user+123456789@domain.com` sends to Telegram chat ID 123456789

**Environment Variables:**
- `DEFAULT_TOPIC` - default ntfy topic when no suffix
- `NTFY_URL` - ntfy server URL (default: https://ntfy.sh)
- `TELEGRAM_BOT_TOKEN` - for Telegram notifications

## AI Configuration

Customize AI behavior with these variables:

- `AI_MODEL` - Default AI model (default: `@cf/ibm-granite/granite-4.0-h-micro`)
- `AI_MODEL_REPLY` - Model for reply mode
- `AI_MODEL_HEADER` - Model for header mode
- `AI_MODEL_NOTIFY` - Model for notify mode
- `AI_SYSTEM_PROMPT` - system prompt for the AI
- `AI_USER_PROMPT` - user prompt template

## Filtering & Security

### Sender Whitelist/Blacklist
Only process emails from whitelisted senders or block specific senders:

```
SENDER_WHITELIST=gmail.com,proton.me
SENDER_BLACKLIST=spam@example.com,ads@company.com
```

### Spam Detection
Built-in spam filtering with keyword detection:

```
SPAM_THRESHOLD=3    # Sensitivity 1-10, default: 3
SPAM_FORWARD_EMAIL=spam@yourdomain.com  # Forward flagged spam here
```

### Rate Limiting
Prevent abuse with rate limiting (requires KV namespace):

```
RATE_LIMIT=20           # Max emails per sender
RATE_LIMIT_WINDOW=3600  # Window in seconds (default: 1 hour)
```

To enable rate limiting, add a KV namespace in wrangler.toml:

```toml
[[kv_namespaces]]
binding = "EMAIL_KV"
id = "your-kv-namespace-id"
```

## Alias Mapping

Override forward address based on the recipient email address. Takes priority over domain-based overrides:

```
ALIAS_MAPPING=john@domain.com:john@gmail.com,jane@domain.com:jane@gmail.com
```

**Priority order:**
1. Alias mapping (recipient address match)
2. Domain-based override (recipient domain for forwarding, sender domain for topic/pushover)
3. Default MAIN_EMAIL_ADDRESS

## Domain-Based Overrides

Override settings based on domain:

- **Forward address** (`MAIN_EMAIL_ADDRESS_BY_DOMAIN`): based on **recipient** domain
- **Topic** (`DEFAULT_TOPIC_BY_DOMAIN`): based on **sender** domain
- **Pushover** (`PUSHOVER_ENABLED_BY_DOMAIN`): based on **sender** domain

```
MAIN_EMAIL_ADDRESS_BY_DOMAIN=@yourdomain.com:backup@email.com,@work.com:work@company.com
DEFAULT_TOPIC_BY_DOMAIN=@gmail.com:personal,@work.com:work
PUSHOVER_ENABLED_BY_DOMAIN=@gmail.com:true
```

Format: `@domain.com:value` - emails matching that domain will use the specified value.

## Email Threading

The worker properly handles email threading by setting `In-Reply-To` and `References` headers based on the original email's `Message-ID` and `References` headers.

## Web Dashboard

Access these endpoints:

- `/stats` - View processing statistics
- `/health` - Health check endpoint
- `/test` - Test endpoint showing configuration

## Setup

### 1. Create the Worker

```bash
# Clone or download this project
cd email-ai-worker

# Install dependencies
npm install

# Login to Cloudflare
npx wrangler login

# Create the worker
npx wrangler deploy --name your-worker-name

# Optional: Create KV namespace for rate limiting
npx wrangler kv:namespace create EMAIL_KV
```

### 2. Configure Email Routing

1. Go to **Cloudflare Dashboard** → **Email** → **Email Routing**
2. Create a **Catch-all** rule pointing to your worker
3. Create specific rules for `+reply` and `+summary` addresses if desired

### 3. Set Environment Variables

```bash
# Deploy secrets from .dev.vars
npm run deploy:secrets
```

Or set them manually:
```bash
npx wrangler secret put MAIN_EMAIL_ADDRESS
npx wrangler secret put DEFAULT_TOPIC
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

## Configuration File

Copy `.dev.vars.example` to `.dev.vars` and fill in your values:

```bash
cp .dev.vars.example .dev.vars
```

Then run `npm run deploy:secrets` to push them to Cloudflare.

## Running All Modes

Set up routing rules in Cloudflare:

- `me@yourdomain.com` → Worker (header mode - default)
- `me+reply@yourdomain.com` → Worker (reply mode)
- `me+summary@yourdomain.com` → Worker (reply mode)  
- `me+ntfyTopic@yourdomain.com` → Worker (notify mode → ntfy.sh)
- `me+123456789@yourdomain.com` → Worker (notify mode → Telegram)

## Deployment

```bash
# Deploy worker
npm run deploy

# Deploy secrets
npm run deploy:secrets

# Test locally
npm run dev
```
