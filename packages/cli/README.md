# untangle-api

`untangle-api` is the public CLI package for Untangle API, an OpenAI-compatible multi-provider API gateway with routing, control-plane features, observability, and a bundled admin UI.

This package is prepared for npm publication from the Untangle API monorepo.

Core commands:

```bash
untangle-api init
untangle-api start --host 127.0.0.1 --port 4010
untangle-api keys add openai
```

`untangle-api init` creates `./untangle-api.yaml` with localhost-friendly defaults. Before exposing the gateway outside localhost, enable admin auth, data-plane auth, and metrics protection in the config.

Source repository and full documentation:

- https://github.com/saichaithanya0705/untangle-api
