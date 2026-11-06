# Proposed sports contract v0.1

These Draft 2020-12 schemas are design artifacts, not deployed contracts. Every example is a fixture and must be excluded from live evaluation. The first version covers points and categorical predictions, their outcome revisions, and single-game combined quotes. Multi-game parlay settlement and portfolio sizing require separately versioned domain contracts; do not coerce unsupported shapes into these examples.

`forecast.schema.json`, `quote.schema.json` and `outcome.schema.json` define structural validation. `examples/` contains illustrative records. `validate_examples.py` runs schema validation plus selected temporal, probability, identity and revision invariants. It is a design QA harness, not a complete ingestion or authorization layer.

Run with a separate development Python environment containing `jsonschema==4.26.0`:

```sh
python validate_examples.py
```

Production must additionally verify evidence against retained source artifacts, enforce identity/project permissions and immutable writes in transactions, validate each task's exhaustive class vocabulary, check exact sportsbook line/settlement semantics and record the full schema/importer version. Timestamp ordering and a hash-shaped string alone do not prove pre-event evidence.

All future schema changes require compatibility fixtures. Never infer that a syntactically valid or non-fixture row is eligible for learning, EV or promotion.
