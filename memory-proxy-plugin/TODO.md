# Memory Proxy TODO

## Optimization Backlog

- [x] Layer keyword retrieval so high-signal entities are always kept, while low-signal long-tail terms are capped or sampled.
  - Implemented in `memory-proxy/src/retrieval/keyword-extractor.ts` with protected entity/keyword terms and capped additional search-term tail.
- [ ] Add memory injection observability, such as a debug `last-injection.json`, to inspect which memories were injected and why.
- [ ] Optimize extraction prompts to reduce empty or low-value extraction calls without missing meaningful user facts or events.
