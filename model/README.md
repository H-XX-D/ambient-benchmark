# model/

The fixed reader model. It reads whatever a system serves and answers; it is held
constant across every system and tier so score differences come from the memory, not
the model (docs/ATTRIBUTION.md).

Two backends, one chosen per run:

- local: a llama-server (llama.cpp) on an OpenAI-compatible endpoint, for example
  Llama-3.2-1B at http://localhost:8089/v1. No key.
- online: any OpenAI-compatible API, selected by key, for a hosted fixed model.

Configured by environment, and no key is ever committed:

- `AMBIENT_MODEL_BACKEND` = local | online
- `AMBIENT_MODEL` = model id (for example Llama-3.2-1B, or a hosted model id)
- `AMBIENT_MODEL_ENDPOINT` = base URL (default http://localhost:8089/v1 for local)
- `AMBIENT_API_KEY` = key for online; read from the environment or a local key file
  kept outside the repo (see .gitignore)

Whichever backend runs, record the exact model, quant, endpoint, and (for local) the
llama build in results, or runs are not comparable (see ROADMAP risks).
