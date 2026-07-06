# corpora/

The information a system ingests to build its store, plus the questions that probe
it. Three sizes, chosen at run time:

| size   | intent           | scale (target)   |
|--------|------------------|------------------|
| small  | fast smoke       | tens of segments |
| medium | default run      | hundreds         |
| large  | stress / scaling | thousands        |

Same task shapes at every size, so a small run and a large run are comparable and a
system's scaling behavior is visible. Each size is a directory with the ingest corpus
and a questions file. A manifest records the segment count, the known-or-novel tag per
question (Rule 5), and the gold answer plus the store item that supports it, so
"served from outside the model" is checkable (Rule 1 and docs/ATTRIBUTION.md).

Seed: recall-self-run/ingest holds a first corpus (wiki, arxiv, pdfs, csv) that can
back one size. To build: split and scale into small, medium, and large with matched
question sets.

Manifest shape per size (to build):

```
{
  "size": "medium",
  "segments": 300,
  "corpus": ["..."],
  "questions": [
    { "id": "...", "q": "...", "gold": "...", "supportId": "...", "tag": "known|novel" }
  ]
}
```
