# untangle-ai

Unified AI API Gateway - proxy requests to multiple AI providers through OpenAI-compatible endpoints.

## Features

- **Multiple Providers**: OpenAI, Anthropic, Google AI, Groq (and custom providers)
- **OpenAI-Compatible API**: Drop-in replacement for OpenAI SDK
- **Web Dashboard**: Visual management UI for providers, models, and API keys
- **CLI Tools**: Full command-line interface for all operations
- **Streaming Support**: Real-time streaming responses from all providers
- **Custom Endpoints**: Define your own providers with request/response templates

## Quick Start

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Initialize configuration
npx untangle-ai init

# Add your API keys
npx untangle-ai keys add openai
npx untangle-ai keys add anthropic

# Start the server
npx untangle-ai start

# Or start with web dashboard
npx untangle-ai start --ui
```

## Usage

### API Endpoints

Once running, use OpenAI-compatible endpoints:

```bash
# List available models
curl http://localhost:3000/v1/models

# Chat completion
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Use Claude
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-3.5-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Use Gemini
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-1.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### CLI Commands

```bash
# Initialize config file
untangle-ai init

# Start server
untangle-ai start [--port 3000] [--host localhost] [--config path/to/config.yaml] [--ui]

# Manage API keys
untangle-ai keys add <provider>    # Add API key (interactive)
untangle-ai keys list              # List configured keys
untangle-ai keys remove <provider> # Remove API key
untangle-ai keys test <provider>   # Test API key
```

### Web Dashboard

Start with `--ui` flag to enable the web dashboard:

```bash
untangle-ai start --ui
```

Then open http://localhost:3000 in your browser.

## Configuration

Create `untangle.yaml` in your project root:

```yaml
server:
  port: 3000
  host: localhost

providers:
  openai:
    enabled: true
    # API keys can be set here, via CLI, or environment variables
    # apiKey: sk-...

  anthropic:
    enabled: true

  google:
    enabled: true

  groq:
    enabled: true

# Custom providers (optional)
customProviders:
  my-llm:
    enabled: true
    baseUrl: https://my-llm.example.com/api
    auth:
      type: header
      header: X-API-Key
    models:
      - id: my-model
        contextWindow: 8192
        maxOutputTokens: 4096
        enabled: true
    endpoints:
      chat:
        path: /generate
        method: POST
        requestTemplate: |
          {
            "prompt": "{{#each messages}}{{role}}: {{content}}\n{{/each}}",
            "max_tokens": {{max_tokens}}
          }
        responseTemplate: |
          {
            "choices": [{"message": {"role": "assistant", "content": "{{output.text}}"}}]
          }
```

### API Key Configuration

API keys can be set in three ways (in priority order):

1. **Config file**: Add `apiKey: sk-...` under provider config
2. **CLI**: Use `untangle-ai keys add <provider>` to store encrypted keys
3. **Environment variables**: Set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.

## Supported Providers

| Provider | Models | Status |
|----------|--------|--------|
| OpenAI | gpt-4o, gpt-4o-mini, gpt-4-turbo, gpt-4, gpt-3.5-turbo, o1, o1-mini | Supported |
| Anthropic | claude-sonnet-4, claude-3.5-sonnet, claude-3.5-haiku, claude-3-opus | Supported |
| Google AI | gemini-2.0-flash, gemini-1.5-pro, gemini-1.5-flash | Supported |
| Groq | llama-3.3-70b, llama-3.1-8b, mixtral-8x7b, gemma2-9b | Supported |

## Project Structure

```
packages/
  core/     - Types, provider adapters, config, encryption, templates
  server/   - Hono HTTP server with OpenAI-compatible routes
  cli/      - Command-line interface
  ui/       - React dashboard (Vite + Tailwind + shadcn/ui)
```

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run in development mode
pnpm dev

# Run tests
pnpm test
```

## License

MIT
