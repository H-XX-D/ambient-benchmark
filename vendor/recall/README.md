# vendor/recall

A pinned build of [Recall](https://github.com/H-XX-D/recall-memory-substrate)
(recall-memory-substrate), the first memory system AMBIENT tests. Vendored rather
than depended on because Recall's published npm files list omits the probes this
suite needs; see `VERSION` for the pinned commit and `../../ROADMAP.md` for the
dependency strategy.

Recall is licensed Apache-2.0 (`LICENSE`, copied from the upstream repo). This
directory holds only Recall's compiled `dist/`, not its source; the source and full
history live upstream.
